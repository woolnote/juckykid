/* =========================================================
   Crypto Signal Dashboard (B Mode)
   - NORMAL: high win-rate / frequent small wins
   - EVENT: auto-switch on big volatility (WebSocket proxy)
   - Decision is triggered on event arrival (seconds), not candle close.

   Notes (hard truths):
   - No key needed: uses Binance public WebSocket + REST klines.
   - This is "decision engine", not auto-trading execution.
   ========================================================= */

const BINANCE_URL = "https://api.binance.com/api/v3/klines";
const BINANCE_WS_BASE = "wss://stream.binance.com:9443/ws";

/* =========================
   Assets
   ========================= */
const CRYPTO_ASSETS = [
  { id:"BTCUSDT", name:"BTC / USDT" },
  { id:"ETHUSDT", name:"ETH / USDT" },
  { id:"XRPUSDT", name:"XRP / USDT" },
  { id:"BCHUSDT", name:"BCH / USDT" },
  { id:"BNBUSDT", name:"BNB / USDT" },
  { id:"SOLUSDT", name:"SOL / USDT" },
  { id:"ADAUSDT", name:"ADA / USDT" },
  { id:"AVAXUSDT", name:"AVAX / USDT" },
  { id:"DOTUSDT", name:"DOT / USDT" },
  { id:"LINKUSDT", name:"LINK / USDT" },
  { id:"DOGEUSDT", name:"DOGE / USDT" },
  { id:"MATICUSDT", name:"MATIC / USDT" },
  { id:"LTCUSDT", name:"LTC / USDT" },
  { id:"TRXUSDT", name:"TRX / USDT" },
  { id:"ATOMUSDT", name:"ATOM / USDT" },
  { id:"NEARUSDT", name:"NEAR / USDT" },
  { id:"OPUSDT", name:"OP / USDT" },
  { id:"ARBUSDT", name:"ARB / USDT" },
  { id:"APTUSDT", name:"APT / USDT" },
  { id:"SUIUSDT", name:"SUI / USDT" },
  { id:"INJUSDT", name:"INJ / USDT" },
  { id:"FILUSDT", name:"FIL / USDT" },
  { id:"ETCUSDT", name:"ETC / USDT" },
];

/* =========================
   Favorites storage
   ========================= */
const LS_KEYS = {
  cryptoFav: "dash_fav_crypto_bmode_v1",
  lastCrypto: "dash_last_crypto_bmode_v1",
};

function loadSet(key) {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function saveSet(key, set) {
  localStorage.setItem(key, JSON.stringify(Array.from(set)));
}
function setLast(key, value) { localStorage.setItem(key, value); }
function getLast(key, fallback) { return localStorage.getItem(key) || fallback; }

/* =========================
   (Optional) Event DB placeholder
   ========================= */
const EVENT_DB = {
  global: { crypto: [] },
  crypto: {}
};

/* =========================
   Helpers
   ========================= */
function esc(s){
  return String(s||"")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
function formatPrice(v) {
  if (!isFinite(v)) return "—";
  if (v >= 1000) return v.toFixed(2);
  if (v >= 1) return v.toFixed(4);
  return v.toFixed(6);
}
function pad2(n){ return String(n).padStart(2,"0"); }
function fmtDateTime(tsSec){
  const d = new Date(tsSec * 1000);
  const M = pad2(d.getMonth()+1);
  const D = pad2(d.getDate());
  const h = pad2(d.getHours());
  const m = pad2(d.getMinutes());
  return `${M}/${D} ${h}:${m}`;
}
function fmtDate(tsSec){
  const d = new Date(tsSec * 1000);
  const Y = d.getFullYear();
  const M = pad2(d.getMonth()+1);
  const D = pad2(d.getDate());
  return `${Y}/${M}/${D}`;
}
function nowMs(){ return Date.now(); }

/* =========================
   MODE (B mode)
   ========================= */
const MODE = {
  current: "NORMAL", // NORMAL | EVENT
  eventUntilMs: 0,
  lastEventReason: "—",
  lastDecision: "—",
};

function setMode(next, reason = "—", holdMin = 10) {
  const banner = document.getElementById("mode-banner");
  const title = document.getElementById("mode-banner-title");
  const meta = document.getElementById("mode-banner-meta");
  const pill = document.getElementById("mode-pill");

  MODE.current = next;
  MODE.lastEventReason = reason;

  if (next === "EVENT") {
    MODE.eventUntilMs = nowMs() + holdMin * 60 * 1000;
    banner?.classList.remove("normal");
    banner?.classList.add("event");
    pill?.classList.remove("normal");
    pill?.classList.add("event");
    pill.textContent = "EVENT";
    title.textContent = "EVENT 模式啟動（吃大波動）";
    meta.textContent = `原因：${reason}｜自動維持 ${holdMin} 分鐘，之後回到 NORMAL。`;
  } else {
    MODE.eventUntilMs = 0;
    banner?.classList.remove("event");
    banner?.classList.add("normal");
    pill?.classList.remove("event");
    pill?.classList.add("normal");
    pill.textContent = "NORMAL";
    title.textContent = "NORMAL 模式運行中（紅單節奏）";
    meta.textContent = `等待事件觸發…（WebSocket 即時）｜上次事件：${reason}`;
  }

  document.getElementById("kpi-mode").textContent = next;
}

function tickModeAutoRevert() {
  if (MODE.current === "EVENT" && MODE.eventUntilMs > 0 && nowMs() >= MODE.eventUntilMs) {
    setMode("NORMAL", MODE.lastEventReason);
    // 回到 NORMAL 後，立刻刷新一次，避免卡住
    loadAndRenderCrypto();
  }
}

/* =========================
   Strategy profiles
   ========================= */
function readProfileFromUI() {
  // Normal
  const slN = clampNumber(document.getElementById("sl-normal")?.value, 0.1, 30, 0.9) / 100;
  const tpN = clampNumber(document.getElementById("tp-normal")?.value, 0.1, 50, 1.6) / 100;

  // Event
  const slE = clampNumber(document.getElementById("sl-event")?.value, 0.2, 50, 2.8) / 100;
  const tpE = clampNumber(document.getElementById("tp-event")?.value, 0.2, 80, 6.5) / 100;

  // Profiles: "what changes when event hits"
  return {
    NORMAL: {
      name: "NORMAL",
      stopLossPct: slN,
      trailDrawdownPct: tpN,
      // NORMAL: keep entries strict to keep win-rate high
      enableMTF: true,
      enableVOL: true,
      breakoutEntry: false,
      maShort: 5,
      maLong: 20,
      emaTrendPeriod: 150,
      volPeriod: 20,
    },
    EVENT: {
      name: "EVENT",
      stopLossPct: slE,
      trailDrawdownPct: tpE,
      // EVENT: remove friction to react fast
      enableMTF: false,
      enableVOL: false,
      breakoutEntry: true,
      maShort: 5,
      maLong: 20,
      emaTrendPeriod: 150,
      volPeriod: 20,
      breakoutLookback: 30, // last N candles high/low
    }
  };
}

/* =========================
   Indicators
   ========================= */
function calcMA(data, period) {
  const out = new Array(data.length).fill(null);
  let sum = 0;
  for (let i=0;i<data.length;i++){
    sum += data[i].close;
    if (i >= period) sum -= data[i-period].close;
    if (i >= period-1) out[i] = sum/period;
  }
  return out;
}
function calcEMA(data, period) {
  const out = new Array(data.length).fill(null);
  const k = 2/(period+1);
  let ema = null;
  for (let i=0;i<data.length;i++){
    const p = data[i].close;
    if (ema === null) ema = p;
    else ema = p*k + ema*(1-k);
    if (i >= period-1) out[i] = ema;
  }
  return out;
}
function calcVolMA(data, period){
  const out = new Array(data.length).fill(null);
  let sum = 0;
  for (let i=0;i<data.length;i++){
    const v = Number(data[i].volume) || 0;
    sum += v;
    if (i >= period) sum -= (Number(data[i-period].volume) || 0);
    if (i >= period-1) out[i] = sum/period;
  }
  return out;
}

/* =========================
   Signals engine (deterministic)
   ========================= */
function highestHigh(data, endIdx, lookback) {
  const start = Math.max(0, endIdx - lookback);
  let hh = -Infinity;
  for (let i=start;i<=endIdx;i++){
    hh = Math.max(hh, data[i].high);
  }
  return hh;
}
function lowestLow(data, endIdx, lookback) {
  const start = Math.max(0, endIdx - lookback);
  let ll = Infinity;
  for (let i=start;i<=endIdx;i++){
    ll = Math.min(ll, data[i].low);
  }
  return ll;
}

function generateSignals(data, profile, opts = {}) {
  const maS = calcMA(data, profile.maShort);
  const maL = calcMA(data, profile.maLong);
  const emaT = calcEMA(data, profile.emaTrendPeriod);
  const volMA = calcVolMA(data, profile.volPeriod);

  const higherTrendOk = opts.higherTrendOk ?? null;

  const events = [];
  let inPosition = false;
  let entryPrice = 0;
  let peakPrice = 0;

  for (let i=1;i<data.length;i++){
    const prevS = maS[i-1], prevL = maL[i-1];
    const currS = maS[i],   currL = maL[i];
    const ema = emaT[i];
    if (prevS==null || prevL==null || currS==null || currL==null || ema==null) continue;

    const bar = data[i];
    const price = bar.close;
    const trendOk = price > ema;

    // Optional MTF
    const mtfOk = (profile.enableMTF)
      ? ((higherTrendOk === null) ? true : !!higherTrendOk)
      : true;

    // Optional VOL confirm
    const v = Number(bar.volume) || 0;
    const vma = volMA[i];
    const volOk = (profile.enableVOL)
      ? ((vma == null) ? true : (v >= vma))
      : true;

    const bullCross = (prevS <= prevL && currS > currL);
    const bearCross = (prevS >= prevL && currS < currL);
    const green = bar.close > bar.open;
    const red = bar.close < bar.open;

    // EVENT breakout entry: take first impulse
    let breakoutUp = false;
    let breakoutDn = false;
    if (profile.breakoutEntry) {
      const N = profile.breakoutLookback || 30;
      const hh = highestHigh(data, i-1, N);
      const ll = lowestLow(data, i-1, N);
      breakoutUp = (bar.high > hh) && green;
      breakoutDn = (bar.low < ll) && red;
    }

    if (!inPosition) {
      // Entry logic:
      // - NORMAL: trendOk + bullCross + green + filters
      // - EVENT: (trendOk + bullCross) OR breakoutUp, filters loosened
      const entry =
        (trendOk && bullCross && green && mtfOk && volOk) ||
        (profile.breakoutEntry && trendOk && breakoutUp); // breakout uses trend as minimal sanity

      if (entry) {
        inPosition = true;
        entryPrice = price;
        peakPrice = price;

        const reason = profile.breakoutEntry && breakoutUp ? "BREAKOUT-UP" : "MA-CROSS";
        events.push({ type:"BUY", time: bar.time, price, meta:{ profile: profile.name, reason } });
      }
      continue;
    }

    if (price > peakPrice) peakPrice = price;

    const stopLossPrice = entryPrice * (1 - profile.stopLossPct);
    const trailStopPrice = peakPrice * (1 - profile.trailDrawdownPct);

    if (price <= stopLossPrice) {
      events.push({ type:"STOP LOSS", time: bar.time, price, meta:{ profile: profile.name } });
      inPosition = false; entryPrice=0; peakPrice=0;
      continue;
    }
    if (peakPrice > entryPrice && price <= trailStopPrice) {
      events.push({ type:"TAKE PROFIT", time: bar.time, price, meta:{ profile: profile.name } });
      inPosition = false; entryPrice=0; peakPrice=0;
      continue;
    }

    // Exit if trend fails hard (below MA long) OR bearCross in NORMAL
    if (price < currL || (profile.name === "NORMAL" && bearCross)) {
      events.push({ type:"TREND FAIL", time: bar.time, price, meta:{ profile: profile.name } });
      inPosition = false; entryPrice=0; peakPrice=0;
      continue;
    }

    // EVENT: if breakout down while in position -> exit fast (protect against reversal)
    if (profile.name === "EVENT" && profile.breakoutEntry) {
      if (breakoutDn) {
        events.push({ type:"REVERSAL EXIT", time: bar.time, price, meta:{ profile: profile.name } });
        inPosition = false; entryPrice=0; peakPrice=0;
        continue;
      }
    }
  }

  return { events, maS, maL, emaT, volMA };
}

function buildMarkers(events) {
  return events.map(e => {
    const isBuy = e.type === "BUY";
    return {
      time: e.time,
      position: isBuy ? "belowBar" : "aboveBar",
      color: isBuy ? "#22c55e" : "#ef4444",
      shape: isBuy ? "arrowUp" : "arrowDown",
      text: isBuy ? `BUY(${e.meta?.profile||""})` : "SELL",
    };
  });
}

/* =========================
   Time Axis Formatter
   ========================= */
function applyTimeAxisFormatter(chart, interval) {
  if (!chart) return;
  const isIntraday = interval.includes("h") || interval === "1h" || interval === "4h";
  chart.applyOptions({
    timeScale: {
      timeVisible: isIntraday,
      secondsVisible: false,
      tickMarkFormatter: (time) => {
        const ts = typeof time === "number" ? time : (time?.timestamp ?? null);
        if (!ts) return "";
        return isIntraday ? fmtDateTime(ts) : fmtDate(ts);
      }
    }
  });
}

/* =========================
   Binance data
   ========================= */
async function fetchKlines(symbol, interval, limit = 900) {
  const url = `${BINANCE_URL}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Binance API error");
  const raw = await res.json();
  return raw.map(item => ({
    time: item[0] / 1000,
    open: parseFloat(item[1]),
    high: parseFloat(item[2]),
    low: parseFloat(item[3]),
    close: parseFloat(item[4]),
    volume: parseFloat(item[5]),
  }));
}

function higherIntervalOf(interval){
  if (interval === "1h") return "4h";
  if (interval === "4h") return "1d";
  return null;
}
async function computeHigherTrendOk(symbol, interval, profile){
  if (!profile.enableMTF) return null;
  const hi = higherIntervalOf(interval);
  if (!hi) return null;
  const data = await fetchKlines(symbol, hi, 600);
  const ema = calcEMA(data, profile.emaTrendPeriod);
  const last = data[data.length-1];
  const lastEma = ema[ema.length-1];
  if (!last || lastEma == null) return null;
  return last.close > lastEma;
}

/* =========================
   Chart
   ========================= */
let cryptoChart, candleSeries, ma5Series, ma20Series, ema150Series;
let currentCryptoInterval = "1h";

/* =========================
   KPI + Log
   ========================= */
function setCryptoKpis({ mode, lastPrice, trendOk, lastDecision, detail }) {
  document.getElementById("kpi-status").textContent = "LIVE";
  document.getElementById("kpi-mode").textContent = mode;
  document.getElementById("kpi-signal").textContent = lastDecision || "—";
  document.getElementById("kpi-trend").textContent = detail || (trendOk ? "TREND OK" : "TREND OFF");
  document.getElementById("kpi-price").textContent = formatPrice(lastPrice);
}

function renderLog(events, symbol, interval, profile) {
  const body = document.getElementById("trade-log-body");
  const meta = document.getElementById("log-meta");
  meta.textContent = `${symbol}｜${interval}｜Profile ${profile.name}｜SL ${(profile.stopLossPct*100).toFixed(1)}%｜Trail ${(profile.trailDrawdownPct*100).toFixed(1)}%`;

  if (!events.length) { body.textContent = "此資料段沒有產生訊號。"; return; }

  body.innerHTML = `<ul>${
    events.map(e => {
      const ts = new Date(e.time * 1000).toLocaleString();
      if (e.type === "BUY") {
        const rs = e.meta?.reason ? ` (${esc(e.meta.reason)})` : "";
        return `<li>${ts} ｜ <b style="color:#22c55e;">BUY</b> <span style="color:#9ca3af;">[${esc(e.meta?.profile||"")}]</span>${rs}</li>`;
      }
      return `<li>${ts} ｜ <b style="color:#ef4444;">SELL</b> (${esc(e.type)}) <span style="color:#9ca3af;">[${esc(e.meta?.profile||"")}]</span></li>`;
    }).join("")
  }</ul>`;
}

/* =========================
   Events render (optional)
   ========================= */
function parseTs(ts) {
  const d = new Date(ts);
  const t = d.getTime();
  return Number.isFinite(t) ? t : 0;
}
function humanAgo(ms){
  if (!ms) return "—";
  const diff = Math.max(0, nowMs() - ms);
  const min = Math.floor(diff/60000);
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min/60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.floor(hr/24);
  if (day < 14) return `${day} 天前`;
  const wk = Math.floor(day/7);
  if (wk < 12) return `${wk} 週前`;
  const mo = Math.floor(day/30);
  return `${mo} 個月前`;
}
function windowToMs(w){
  if (w==="7d") return 7*24*3600*1000;
  if (w==="30d") return 30*24*3600*1000;
  return 90*24*3600*1000;
}
function impactTag(impact){
  if (impact==="bull") return { cls:"good", text:"偏多" };
  if (impact==="bear") return { cls:"bad", text:"偏空" };
  return { cls:"neu", text:"中性" };
}
function renderEvents({ bodyId, titleId, mode, symbol, windowStr, favSet }) {
  const body = document.getElementById(bodyId);
  const title = document.getElementById(titleId);
  if (!body) return;

  const cutoff = nowMs() - windowToMs(windowStr);
  const globalList = (EVENT_DB.global?.[mode] || []).map(e => ({...e, _scope:"Market"}));
  const assetList = (EVENT_DB[mode]?.[symbol] || []).map(e => ({...e, _scope:"Asset"}));

  const merged = [...assetList, ...globalList]
    .map(e => ({...e, _ms: parseTs(e.ts)}))
    .filter(e => e._ms >= cutoff)
    .sort((a,b) => b._ms - a._ms)
    .slice(0, 5);

  const isFav = favSet?.has(symbol);
  if (title) title.textContent = `近期事件（Crypto）｜${symbol}${isFav ? " ★" : ""}`;

  if (!merged.length) {
    body.innerHTML = "目前沒有事件摘要（你可以之後再擴充來源）。";
    return;
  }

  body.innerHTML = merged.map((e) => {
    const it = impactTag(e.impact);
    const favTag = isFav ? `<span class="tag fav">★ Favorite</span>` : "";
    return `
      <div class="eventItem">
        <div class="eventTopRow">
          <div class="eventTitle">${esc(e.title)}</div>
          <div class="eventMeta">${humanAgo(e._ms)}</div>
        </div>
        ${e.note ? `<div style="color:#9ca3af; font-size:11px;">${esc(e.note)}</div>` : ""}
        <div class="eventTags">
          <span class="tag type">${esc(e.type || "Event")}</span>
          <span class="tag ${it.cls}">${it.text}</span>
          <span class="tag">${esc(e._scope === "Asset" ? "資產事件" : "市場事件")}</span>
          ${favTag}
        </div>
      </div>
    `;
  }).join("");
}

/* =========================
   Favorites + Picker
   ========================= */
let cryptoFav = loadSet(LS_KEYS.cryptoFav);
let currentCrypto = getLast(LS_KEYS.lastCrypto, "BTCUSDT");

function findAsset(list, id){
  return list.find(x => x.id === id) || null;
}
function updateFavButton(){
  const btn = document.getElementById("crypto-fav-toggle");
  const star = document.getElementById("crypto-fav-star");
  const isFav = cryptoFav.has(currentCrypto);
  star.textContent = isFav ? "★" : "☆";
  btn?.classList.toggle("fav", isFav);
}
function setCurrentDisplay(){
  const a = findAsset(CRYPTO_ASSETS, currentCrypto);
  document.getElementById("crypto-current").textContent = a ? a.name : currentCrypto;
  document.getElementById("crypto-current-sub").textContent = a ? a.id : "—";
  updateFavButton();
}

function toggleFavorite(){
  if (cryptoFav.has(currentCrypto)) cryptoFav.delete(currentCrypto);
  else cryptoFav.add(currentCrypto);
  saveSet(LS_KEYS.cryptoFav, cryptoFav);
  updateFavButton();
  renderPickerList();
  refreshCryptoEvents();
}

function matchesSearch(asset, q){
  if (!q) return true;
  const s = q.toLowerCase().trim();
  return asset.id.toLowerCase().includes(s) || asset.name.toLowerCase().includes(s);
}
function renderGroup({ title, items, activeId, favSet, searchQ }) {
  if (!items.length) return "";
  const groupTitle = `<div class="groupTitle">${title}</div>`;
  const rows = items
    .filter(a => matchesSearch(a, searchQ))
    .map(a => {
      const isActive = a.id === activeId;
      const isFav = favSet.has(a.id);
      return `
        <div class="itemBtn ${isActive ? "active" : ""}" data-id="${a.id}">
          <div class="itemLeft">
            <div class="itemName">${esc(a.name)}</div>
            <div class="itemCode">${esc(a.id)}</div>
          </div>
          <button class="starBtn ${isFav ? "fav" : ""}" data-star="${a.id}" type="button" title="收藏/取消收藏">
            ${isFav ? "★" : "☆"}
          </button>
        </div>
      `;
    }).join("");

  return groupTitle + rows;
}

function renderPickerList(){
  const searchQ = (document.getElementById("crypto-search")?.value || "");
  const listEl = document.getElementById("crypto-list");
  if (!listEl) return;

  const fav = CRYPTO_ASSETS.filter(a => cryptoFav.has(a.id));
  const all = CRYPTO_ASSETS.filter(a => !cryptoFav.has(a.id));
  listEl.innerHTML =
    renderGroup({ title:"★ Favorites", items:fav, activeId:currentCrypto, favSet:cryptoFav, searchQ }) +
    renderGroup({ title:"All", items:all, activeId:currentCrypto, favSet:cryptoFav, searchQ });
}

function bindPickerClicks(){
  const listEl = document.getElementById("crypto-list");
  if (!listEl) return;

  listEl.onclick = (ev) => {
    const starId = ev.target?.dataset?.star;
    if (starId) {
      ev.preventDefault();
      ev.stopPropagation();
      if (cryptoFav.has(starId)) cryptoFav.delete(starId); else cryptoFav.add(starId);
      saveSet(LS_KEYS.cryptoFav, cryptoFav);
      renderPickerList(); updateFavButton(); refreshCryptoEvents();
      return;
    }

    const item = ev.target.closest(".itemBtn");
    const id = item?.dataset?.id;
    if (!id) return;

    currentCrypto = id;
    setLast(LS_KEYS.lastCrypto, id);
    setCurrentDisplay();
    renderPickerList();

    // switch WS stream to new symbol
    startEventWatcher();

    loadAndRenderCrypto();
    refreshCryptoEvents();
  };
}

/* =========================
   Event windows (optional)
   ========================= */
let cryptoEventWindow = "7d";

function setWindowChipsActive(mode, windowStr) {
  const chips = Array.from(document.querySelectorAll(`.chip[data-ev-mode="${mode}"]`));
  chips.forEach(c => c.classList.toggle("active", c.dataset.evWindow === windowStr));
}
function refreshCryptoEvents(){
  setWindowChipsActive("crypto", cryptoEventWindow);
  renderEvents({
    bodyId:"events-body-crypto",
    titleId:"events-title-crypto",
    mode:"crypto",
    symbol: currentCrypto,
    windowStr: cryptoEventWindow,
    favSet: cryptoFav
  });
}

/* =========================
   WebSocket Event Watcher (core of B mode)
   - Detect impulse in seconds (not candle)
   - Switch to EVENT mode, then call "instant decision"
   ========================= */
let ws = null;

// ring buffer for last N seconds
const RT = {
  prices: [],     // {t, p}
  volumes: [],    // {t, q}
  baselineVol: 0, // EMA-like baseline
  lastDecisionTs: 0,
  cooldownMs: 12_000, // avoid spamming decisions
};

function beep() {
  const enabled = !!document.getElementById("event-sound")?.checked;
  if (!enabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = 0.03;
    o.connect(g); g.connect(ctx.destination);
    o.start();
    setTimeout(() => { o.stop(); ctx.close(); }, 150);
  } catch {}
}

function resetRealtimeBuffers() {
  RT.prices = [];
  RT.volumes = [];
  RT.baselineVol = 0;
  RT.lastDecisionTs = 0;
}

function shouldTriggerEvent() {
  const enabled = !!document.getElementById("bmode-enabled")?.checked;
  if (!enabled) return null;

  const thrPct = clampNumber(document.getElementById("event-thr-pct")?.value, 0.2, 20, 0.9);
  const volMult = clampNumber(document.getElementById("event-vol-mult")?.value, 1.0, 20, 2.2);

  // Need enough data ~ 20s
  const now = nowMs();
  const windowMs = 20_000;

  const recent = RT.prices.filter(x => now - x.t <= windowMs);
  if (recent.length < 8) return null;

  const p0 = recent[0].p;
  const p1 = recent[recent.length - 1].p;
  if (!isFinite(p0) || !isFinite(p1) || p0 <= 0) return null;

  const pct = ((p1 - p0) / p0) * 100;

  const vRecent = RT.volumes.filter(x => now - x.t <= windowMs);
  const volSum = vRecent.reduce((a,b)=> a + b.q, 0);
  const base = RT.baselineVol || 1e-9;
  const volRatio = volSum / base;

  if (Math.abs(pct) >= thrPct && volRatio >= volMult) {
    return { pct, volRatio };
  }
  return null;
}

function startEventWatcher() {
  // close old ws
  if (ws) { try { ws.close(); } catch {} ws = null; }
  resetRealtimeBuffers();

  const stream = `${currentCrypto.toLowerCase()}@trade`;
  const url = `${BINANCE_WS_BASE}/${stream}`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    // show status in banner meta
    const meta = document.getElementById("mode-banner-meta");
    if (MODE.current === "NORMAL") {
      meta.textContent = `WebSocket 連線成功｜等待事件觸發…（${currentCrypto}）`;
    }
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      // trade msg: p price, q qty, T trade time(ms)
      const p = Number(msg.p);
      const q = Number(msg.q);
      const t = Number(msg.T);

      if (!isFinite(p) || !isFinite(q) || !isFinite(t)) return;

      // store price
      RT.prices.push({ t, p });
      RT.volumes.push({ t, q });

      // keep last 60s
      const cutoff = t - 60_000;
      RT.prices = RT.prices.filter(x => x.t >= cutoff);
      RT.volumes = RT.volumes.filter(x => x.t >= cutoff);

      // update baseline volume (EMA-like)
      // baseline = slowly moving sum over 20s, smoothed
      const now = t;
      const v20 = RT.volumes.filter(x => now - x.t <= 20_000).reduce((a,b)=>a+b.q,0);
      RT.baselineVol = RT.baselineVol === 0 ? v20 : (RT.baselineVol*0.92 + v20*0.08);

      // auto revert if needed
      tickModeAutoRevert();

      // event trigger check
      const trig = shouldTriggerEvent();
      if (!trig) return;

      // cooldown
      if (nowMs() - RT.lastDecisionTs < RT.cooldownMs) return;
      RT.lastDecisionTs = nowMs();

      const holdMin = clampNumber(document.getElementById("event-hold-min")?.value, 1, 120, 12);
      const dir = trig.pct >= 0 ? "UP" : "DOWN";
      const reason = `Impulse ${dir}｜20s ${trig.pct.toFixed(2)}%｜Vol x${trig.volRatio.toFixed(2)}`;

      // switch to EVENT
      setMode("EVENT", reason, holdMin);
      beep();

      // instant decision: compute and show now (not waiting)
      instantDecisionOnEvent(dir, p, reason);

    } catch {}
  };

  ws.onerror = () => {
    const meta = document.getElementById("mode-banner-meta");
    meta.textContent = "WebSocket 連線失敗｜可能被網路或防火牆阻擋。";
  };

  ws.onclose = () => {
    // attempt reconnect after short delay (if still on same symbol)
    setTimeout(() => {
      // avoid reconnect storm if page unload
      if (document.visibilityState === "hidden") return;
      startEventWatcher();
    }, 1500);
  };
}

/* =========================
   Instant decision (EVENT arrival)
   - This is your "訊息出來後馬上決策"
   - It makes a deterministic recommendation based on:
     1) direction of impulse
     2) current trend sanity (EMA)
     3) breakout / reversal guard
   ========================= */
let lastKlineCache = null; // {symbol, interval, data, ts}

async function getFreshKlines(symbol, interval) {
  const ttlMs = 12_000;
  const now = nowMs();
  if (lastKlineCache && lastKlineCache.symbol === symbol && lastKlineCache.interval === interval && (now - lastKlineCache.ts) < ttlMs) {
    return lastKlineCache.data;
  }
  const data = await fetchKlines(symbol, interval, 260);
  lastKlineCache = { symbol, interval, data, ts: now };
  return data;
}

async function instantDecisionOnEvent(direction, livePrice, reason) {
  // Make a fast decision without overfitting:
  // - If impulse UP and trend sanity passes -> "CHASE-LONG" (actionable)
  // - If impulse DOWN and trend breaks -> "AVOID / WAIT"
  // - If mismatch (UP but below EMA) -> "WAIT CONFIRM"
  try {
    const profiles = readProfileFromUI();
    const profile = profiles.EVENT;

    const interval = document.getElementById("interval-select")?.value || "1h";
    const data = await getFreshKlines(currentCrypto, interval);

    const ema = calcEMA(data, profile.emaTrendPeriod);
    const lastEma = ema[ema.length - 1];
    const trendOk = (lastEma != null) ? (livePrice > lastEma) : true;

    // basic decision logic
    let decision = "WAIT";
    let detail = "";

    if (direction === "UP") {
      if (trendOk) {
        decision = "EVENT BUY (Impulse-Up)";
        detail = `EVENT 決策：順勢吃波動｜${reason}`;
      } else {
        decision = "WAIT (Impulse-Up but below EMA)";
        detail = `EVENT 防呆：上衝但仍在 EMA 下方，避免追到假突破｜${reason}`;
      }
    } else {
      // DOWN impulse
      if (!trendOk) {
        decision = "AVOID / RISK-OFF (Impulse-Down)";
        detail = `EVENT 決策：下砸且趨勢失真，先不接刀｜${reason}`;
      } else {
        decision = "WAIT (Impulse-Down but still above EMA)";
        detail = `EVENT 防呆：下砸但仍在 EMA 上方，等待下一步確認｜${reason}`;
      }
    }

    MODE.lastDecision = decision;
    document.getElementById("kpi-signal").textContent = decision;

    // Also refresh chart signals under EVENT profile to match state
    await loadAndRenderCrypto(true);

    // update banner meta with decision
    const meta = document.getElementById("mode-banner-meta");
    meta.textContent = `原因：${reason}｜即時決策：${decision}｜EVENT 到期：${new Date(MODE.eventUntilMs).toLocaleTimeString()}`;
  } catch (e) {
    console.error(e);
  }
}

/* =========================
   Main render (chart + deterministic signals)
   ========================= */
function chooseProfile() {
  const profiles = readProfileFromUI();
  return (MODE.current === "EVENT") ? profiles.EVENT : profiles.NORMAL;
}

function applyTimeAxis(chart, interval) {
  applyTimeAxisFormatter(chart, interval);
}

async function loadAndRenderCrypto(fromEvent = false) {
  if (!cryptoChart || !candleSeries) return;

  try {
    tickModeAutoRevert();

    const profiles = readProfileFromUI();
    const profile = chooseProfile();

    const interval = document.getElementById("interval-select").value;
    currentCryptoInterval = interval;
    applyTimeAxis(cryptoChart, interval);

    // compute higher TF trend only if needed
    const higherOk = await computeHigherTrendOk(currentCrypto, interval, profile);

    const data = await fetchKlines(currentCrypto, interval, 900);
    candleSeries.setData(data);

    const { events, maS, maL, emaT, volMA } = generateSignals(data, profile, { higherTrendOk: higherOk });

    // plot lines
    const ma5Line = [], ma20Line = [], ema150Line = [];
    for (let i=0;i<data.length;i++){
      if (maS[i] != null) ma5Line.push({ time: data[i].time, value: maS[i] });
      if (maL[i] != null) ma20Line.push({ time: data[i].time, value: maL[i] });
      if (emaT[i] != null) ema150Line.push({ time: data[i].time, value: emaT[i] });
    }
    ma5Series.setData(ma5Line);
    ma20Series.setData(ma20Line);
    ema150Series.setData(ema150Line);

    candleSeries.setMarkers(buildMarkers(events));

    const last = data[data.length-1];
    const lastEma = emaT[emaT.length-1];
    const trendOk = (lastEma != null) ? (last.close > lastEma) : false;

    // produce "latest deterministic decision"
    const lastEvent = events.length ? events[events.length-1] : null;
    const lastDecision =
      (MODE.current === "EVENT" && fromEvent && MODE.lastDecision !== "—")
        ? MODE.lastDecision
        : (lastEvent ? `${lastEvent.type} [${lastEvent.meta?.profile||profile.name}]` : "—");

    const detailParts = [];
    detailParts.push(trendOk ? "TREND OK" : "TREND OFF");
    if (profile.enableMTF) detailParts.push(higherOk === null ? "MTF ?" : (higherOk ? "MTF OK" : "MTF OFF"));
    if (profile.enableVOL) {
      const vma = volMA[volMA.length-1];
      const volOk = (vma == null) ? true : (Number(last.volume)||0) >= vma;
      detailParts.push(volOk ? "VOL OK" : "VOL OFF");
    }
    if (profile.breakoutEntry) detailParts.push("BREAKOUT ON");

    setCryptoKpis({
      mode: MODE.current,
      lastPrice: last.close,
      trendOk,
      lastDecision,
      detail: detailParts.join(" | ")
    });

    renderLog(events, currentCrypto, interval, profile);

    // Fit if not coming from event (avoid jumpy screen)
    if (!fromEvent) cryptoChart.timeScale().fitContent();

    refreshCryptoEvents();
  } catch (e) {
    console.error(e);
    document.getElementById("trade-log-body").textContent = "資料抓取失敗：請確認網路或 Binance API 狀態。";
  }
}

function clearCryptoMarkers() {
  candleSeries?.setMarkers?.([]);
  document.getElementById("trade-log-body").textContent = "已清除圖上標記。";
  document.getElementById("kpi-signal").textContent = "—";
  MODE.lastDecision = "—";
}

/* =========================
   Chart boot
   ========================= */
function initCryptoChart() {
  const el = document.getElementById("chart");
  if (!el) return;

  cryptoChart = LightweightCharts.createChart(el, {
    layout: { background: { color: "#020617" }, textColor: "#e5e7eb" },
    grid: { vertLines: { color: "#111827" }, horzLines: { color: "#111827" } },
    timeScale: { borderColor: "#1f2937" },
    rightPriceScale: { borderColor: "#1f2937" },
    crosshair: {
      vertLine: { color: "#6b7280", width: 1, style: 0 },
      horzLine: { color: "#6b7280", width: 1, style: 0 },
    },
  });

  candleSeries = cryptoChart.addCandlestickSeries({
    upColor: "#22c55e",
    downColor: "#ef4444",
    borderVisible: false,
    wickUpColor: "#22c55e",
    wickDownColor: "#ef4444",
  });

  ma5Series = cryptoChart.addLineSeries({ color: "#38bdf8", lineWidth: 1.6 });
  ma20Series = cryptoChart.addLineSeries({ color: "#f59e0b", lineWidth: 1.6 });
  ema150Series = cryptoChart.addLineSeries({ color: "#a78bfa", lineWidth: 1.6 });

  applyTimeAxisFormatter(cryptoChart, currentCryptoInterval);
}
function resizeCryptoChart() {
  const el = document.getElementById("chart");
  if (!el || !cryptoChart) return;
  const r = el.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) cryptoChart.resize(Math.floor(r.width), Math.floor(r.height));
}

/* =========================
   Manual force EVENT
   ========================= */
function manualTriggerEvent() {
  const holdMin = clampNumber(document.getElementById("event-hold-min")?.value, 1, 120, 12);
  const reason = "Manual Trigger";
  setMode("EVENT", reason, holdMin);
  beep();
  // Make a quick decision using latest live price from RT if exists
  const last = RT.prices.length ? RT.prices[RT.prices.length-1].p : NaN;
  const dir = "UP";
  instantDecisionOnEvent(dir, isFinite(last) ? last : 0, reason);
}

/* =========================
   Boot
   ========================= */
let cryptoAutoTimer = null;

document.addEventListener("DOMContentLoaded", () => {
  initCryptoChart();
  window.addEventListener("resize", resizeCryptoChart);

  setCurrentDisplay();
  renderPickerList();
  bindPickerClicks();

  document.getElementById("crypto-search")?.addEventListener("input", renderPickerList);
  document.getElementById("crypto-fav-toggle")?.addEventListener("click", toggleFavorite);

  document.getElementById("refresh-btn")?.addEventListener("click", () => loadAndRenderCrypto());
  document.getElementById("force-clear-btn")?.addEventListener("click", clearCryptoMarkers);
  document.getElementById("interval-select")?.addEventListener("change", () => loadAndRenderCrypto());

  document.getElementById("bmode-enabled")?.addEventListener("change", () => {
    const enabled = !!document.getElementById("bmode-enabled")?.checked;
    const meta = document.getElementById("mode-banner-meta");
    meta.textContent = enabled ? "EVENT 自動切換已啟用｜WebSocket 即時監控中…" : "EVENT 自動切換已關閉（只跑 NORMAL）。";
  });

  document.getElementById("force-event-btn")?.addEventListener("click", manualTriggerEvent);

  // Chips
  Array.from(document.querySelectorAll(`.chip[data-ev-mode="crypto"]`)).forEach(chip => {
    chip.addEventListener("click", () => {
      cryptoEventWindow = chip.dataset.evWindow || "7d";
      refreshCryptoEvents();
    });
  });
  document.getElementById("events-refresh-crypto")?.addEventListener("click", refreshCryptoEvents);

  // Default mode
  setMode("NORMAL", "—");

  // Start WebSocket watcher
  startEventWatcher();

  // First render
  loadAndRenderCrypto();
  refreshCryptoEvents();

  // Periodic refresh for chart (not for event decision)
  if (cryptoAutoTimer) clearInterval(cryptoAutoTimer);
  cryptoAutoTimer = setInterval(() => {
    tickModeAutoRevert();
    loadAndRenderCrypto(); // chart refresh
  }, 60_000);

  // fast ticker for auto-revert banner countdown feel
  setInterval(tickModeAutoRevert, 1000);
});
