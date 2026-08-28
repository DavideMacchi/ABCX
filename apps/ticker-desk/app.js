// Ticker//Desk — client-side stock quote terminal built on the Finnhub free API.
// Everything (API key, watchlists, alerts, portfolio, theme) is stored in
// localStorage on this device only; nothing is sent anywhere except Finnhub.

const STORAGE = {
  apiKey: 'td_finnhub_api_key',
  watchlists: 'td_watchlists',
  activeWatchlist: 'td_active_watchlist',
  alerts: 'td_alerts',
  portfolio: 'td_portfolio',
  portfolioMode: 'td_portfolio_mode',
  theme: 'td_theme',
};

const DEFAULT_TICKERS = {
  NVDA: { name: 'NVIDIA Corporation', exch: 'NASDAQ', custom: false },
  KULR: { name: 'KULR Technology Group', exch: 'NYSE AM', custom: false },
  SPCX: { name: 'Space Exploration Technologies Corp.', exch: 'NASDAQ', custom: false },
  NHIC: { name: 'NewHold Investment Corp III', exch: 'NASDAQ', custom: false },
};

const SPARKLINE_POINTS = 60;

let apiKey = null;
let watchlists = {};       // { name: { TICKER: {name, exch, custom} } }
let activeWatchlist = 'Default';
let alerts = {};           // { TICKER: { above: number|null, below: number|null } }
let alertFired = {};       // { TICKER: 'above'|'below'|null } — in-memory, prevents repeat firing
let portfolio = {};        // { TICKER: { qty: number, cost: number } }
let portfolioMode = false;
let sortMode = 'default';
let filterText = '';
let usdEurRate = null;     // EUR per 1 USD, refreshed live while portfolio mode is on
let rateUpdatedAt = null;
let rateTimer = null;

const prevPrices = {};
const lastQuoteMeta = {};  // { TICKER: { open, high, low, prevClose } }
const sparklineData = {};  // { TICKER: [price, price, ...] }

let refreshTimer = null;
let ws = null;
let wsReconnectTimer = null;
let REFRESH_MS = 15000;
let audioCtx = null;

// ---------- storage helpers ----------

function loadJSON(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch(e){ return fallback; }
}
function saveJSON(key, value){
  try{ localStorage.setItem(key, JSON.stringify(value)); } catch(e){}
}

// ---------- formatting ----------

function fmtNum(n, decimals=2){
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString('it-IT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtTime(){
  return new Date().toLocaleTimeString('it-IT');
}
function fmtEur(n){
  if (n === null || n === undefined || isNaN(n) || usdEurRate === null) return '';
  return ' (€' + fmtNum(n * usdEurRate) + ')';
}

// ---------- watchlists ----------

function currentTickers(){
  return watchlists[activeWatchlist] || {};
}

function ensureDefaultWatchlist(){
  if (Object.keys(watchlists).length === 0){
    watchlists['Default'] = { ...DEFAULT_TICKERS };
  }
  if (!watchlists[activeWatchlist]) activeWatchlist = Object.keys(watchlists)[0];
}

function persistWatchlists(){ saveJSON(STORAGE.watchlists, watchlists); saveJSON(STORAGE.activeWatchlist, activeWatchlist); }

function renderWatchlistTabs(){
  const el = document.getElementById('watchlistTabs');
  el.innerHTML = '';
  const names = Object.keys(watchlists);
  for (const name of names){
    const tab = document.createElement('button');
    tab.className = 'wl-tab' + (name === activeWatchlist ? ' active' : '');
    tab.innerHTML = `<span>${name}</span>`;
    tab.addEventListener('click', () => switchWatchlist(name));
    if (names.length > 1){
      const rm = document.createElement('span');
      rm.className = 'wl-remove';
      rm.textContent = '×';
      rm.title = 'Elimina watchlist ' + name;
      rm.addEventListener('click', (e) => { e.stopPropagation(); removeWatchlist(name); });
      tab.appendChild(rm);
    }
    el.appendChild(tab);
  }

  const select = document.getElementById('addWatchlistSelect');
  select.innerHTML = '';
  for (const name of names){
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    if (name === activeWatchlist) opt.selected = true;
    select.appendChild(opt);
  }
}

function switchWatchlist(name){
  if (!watchlists[name] || name === activeWatchlist) return;
  unsubscribeAll();
  activeWatchlist = name;
  persistWatchlists();
  renderWatchlistTabs();
  renderGrid();
  recalcInterval();
  if (apiKey){ refreshAll(); subscribeActiveWatchlist(); }
}

function createWatchlist(){
  const name = prompt('Nome della nuova watchlist:');
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed || watchlists[trimmed]) return;
  watchlists[trimmed] = {};
  persistWatchlists();
  switchWatchlist(trimmed);
}

function removeWatchlist(name){
  if (Object.keys(watchlists).length <= 1) return;
  if (!confirm(`Eliminare la watchlist "${name}" e i suoi titoli?`)) return;
  const wasActive = name === activeWatchlist;
  delete watchlists[name];
  if (wasActive) activeWatchlist = Object.keys(watchlists)[0];
  persistWatchlists();
  renderWatchlistTabs();
  if (wasActive){
    unsubscribeAll();
    renderGrid();
    recalcInterval();
    if (apiKey){ refreshAll(); subscribeActiveWatchlist(); }
  }
}

// ---------- WebSocket (live trades) ----------

function connectWebSocket(){
  if (!apiKey) return;
  if (ws){ try{ ws.close(); }catch(e){} }
  ws = new WebSocket(`wss://ws.finnhub.io?token=${apiKey}`);

  ws.addEventListener('open', () => {
    setWsStatus(true);
    subscribeActiveWatchlist();
  });

  ws.addEventListener('message', (event) => {
    try{
      const msg = JSON.parse(event.data);
      if (msg.type === 'trade' && Array.isArray(msg.data)){
        for (const tick of msg.data) handleLiveTrade(tick.s, tick.p);
      }
    } catch(e){}
  });

  ws.addEventListener('close', () => {
    setWsStatus(false);
    if (apiKey){
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(connectWebSocket, 3000);
    }
  });

  ws.addEventListener('error', () => setWsStatus(false));
}

function subscribeActiveWatchlist(){
  for (const ticker of Object.keys(currentTickers())) subscribeSymbol(ticker);
}
function subscribeSymbol(ticker){
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribe', symbol: ticker }));
}
function unsubscribeSymbol(ticker){
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'unsubscribe', symbol: ticker }));
}
function unsubscribeAll(){
  for (const ticker of Object.keys(currentTickers())) unsubscribeSymbol(ticker);
}

function handleLiveTrade(ticker, price){
  if (!currentTickers()[ticker]) return;
  const meta = lastQuoteMeta[ticker] || {};
  const prevClose = meta.prevClose;
  const change = prevClose ? price - prevClose : 0;
  const pct = prevClose ? (change / prevClose) * 100 : 0;
  meta.high = Math.max(meta.high ?? price, price);
  meta.low = Math.min(meta.low ?? price, price);
  renderQuote(ticker, { close: price, open: meta.open, high: meta.high, low: meta.low, prevClose, change, pct });
}

function setWsStatus(connected){
  const el = document.getElementById('statusLine');
  if (connected){
    el.classList.remove('offline');
    el.innerHTML = '<span class="dot"></span>Live · WebSocket in tempo reale';
  } else {
    el.classList.add('offline');
    el.innerHTML = '<span class="dot"></span>WebSocket disconnesso, riconnessione…';
  }
}
function setStatus(online, message){
  const el = document.getElementById('statusLine');
  if (online){
    el.classList.remove('offline');
    el.innerHTML = '<span class="dot"></span>Live';
  } else {
    el.classList.add('offline');
    el.innerHTML = '<span class="dot"></span>' + (message || 'Connessione non riuscita');
  }
}

// ---------- REST quotes ----------

async function fetchQuote(ticker){
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${apiKey}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('network ' + res.status);
  const j = await res.json();
  if (j.c === undefined || j.c === 0) throw new Error('no quote');
  return { close: j.c, open: j.o, high: j.h, low: j.l, prevClose: j.pc, change: j.d, pct: j.dp };
}

function recalcInterval(){
  const n = Math.max(1, Object.keys(currentTickers()).length);
  REFRESH_MS = Math.max(15000, Math.ceil(60000 / 60 * n));
  if (refreshTimer){ clearInterval(refreshTimer); refreshTimer = setInterval(refreshAll, REFRESH_MS); }
}

async function refreshOne(ticker, btn){
  if (!apiKey) return;
  if (btn) btn.classList.add('spinning');
  try{
    const data = await fetchQuote(ticker);
    lastQuoteMeta[ticker] = { open: data.open, high: data.high, low: data.low, prevClose: data.prevClose };
    renderQuote(ticker, data);
  } catch(err){
    const timeEl = cardEl(ticker)?.querySelector('.updated');
    if (timeEl) timeEl.textContent = 'Impossibile aggiornare questo titolo';
  } finally {
    if (btn) setTimeout(() => btn.classList.remove('spinning'), 400);
  }
}

async function refreshAll(){
  if (!apiKey) return;
  let anySuccess = false;
  let authError = false;
  for (const ticker of Object.keys(currentTickers())){
    try{
      const data = await fetchQuote(ticker);
      lastQuoteMeta[ticker] = { open: data.open, high: data.high, low: data.low, prevClose: data.prevClose };
      renderQuote(ticker, data);
      anySuccess = true;
    } catch(err){
      const timeEl = cardEl(ticker)?.querySelector('.updated');
      if (String(err.message).includes('401') || String(err.message).includes('403')){
        authError = true;
        if (timeEl) timeEl.textContent = 'API key non valida';
      } else if (timeEl){
        timeEl.textContent = 'Impossibile aggiornare — riprovo al prossimo ciclo';
      }
    }
  }
  if (authError) setStatus(false, 'API key non valida — controllala');
  else if (!ws || ws.readyState !== WebSocket.OPEN) setStatus(anySuccess);
}

function startPolling(){
  refreshAll();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, REFRESH_MS);
  connectWebSocket();
}

// ---------- rendering ----------

function cardEl(ticker){ return document.getElementById(`card-${cssEscape(ticker)}`); }
function cssEscape(s){ return s.replace(/[^a-zA-Z0-9_-]/g, '_'); }

function sortedVisibleTickers(){
  let entries = Object.entries(currentTickers());
  if (filterText){
    const f = filterText.toLowerCase();
    entries = entries.filter(([t, m]) => t.toLowerCase().includes(f) || (m.name || '').toLowerCase().includes(f));
  }
  const pctOf = (t) => {
    const meta = lastQuoteMeta[t];
    const price = prevPrices[t];
    if (!meta || price === undefined || !meta.prevClose) return 0;
    return ((price - meta.prevClose) / meta.prevClose) * 100;
  };
  if (sortMode === 'name') entries.sort((a, b) => a[0].localeCompare(b[0]));
  else if (sortMode === 'price') entries.sort((a, b) => (prevPrices[b[0]] ?? 0) - (prevPrices[a[0]] ?? 0));
  else if (sortMode === 'pct-desc') entries.sort((a, b) => pctOf(b[0]) - pctOf(a[0]));
  else if (sortMode === 'pct-asc') entries.sort((a, b) => pctOf(a[0]) - pctOf(b[0]));
  return entries;
}

function renderGrid(){
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  for (const [ticker, meta] of sortedVisibleTickers()) addCardToGrid(ticker, meta);
  renderPortfolioSummary();
}

function addCardToGrid(ticker, meta){
  const grid = document.getElementById('grid');
  const tpl = document.getElementById('cardTemplate');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.id = `card-${cssEscape(ticker)}`;
  node.dataset.ticker = ticker;

  node.querySelector('.ticker').textContent = ticker;
  node.querySelector('.company').textContent = meta.name;
  node.querySelector('.exch').textContent = meta.exch;

  node.querySelector('.remove-one').addEventListener('click', () => removeTicker(ticker));

  node.querySelector('.refresh-one').addEventListener('click', (e) => refreshOne(ticker, e.currentTarget));

  const alertBtn = node.querySelector('.alert-toggle');
  alertBtn.addEventListener('click', () => node.querySelector('.alert-box').classList.toggle('show'));
  if (alerts[ticker] && (alerts[ticker].above != null || alerts[ticker].below != null)) alertBtn.classList.add('has-alert');

  const aboveInput = node.querySelector('.alert-above');
  const belowInput = node.querySelector('.alert-below');
  if (alerts[ticker]){
    if (alerts[ticker].above != null) aboveInput.value = alerts[ticker].above;
    if (alerts[ticker].below != null) belowInput.value = alerts[ticker].below;
  }
  node.querySelector('.alert-save').addEventListener('click', () => saveAlert(ticker, aboveInput.value, belowInput.value, node));

  const qtyInput = node.querySelector('.pf-qty');
  const costInput = node.querySelector('.pf-cost');
  if (portfolio[ticker]){
    if (portfolio[ticker].qty != null) qtyInput.value = portfolio[ticker].qty;
    if (portfolio[ticker].cost != null) costInput.value = portfolio[ticker].cost;
  }
  const savePf = () => savePortfolioEntry(ticker, qtyInput.value, costInput.value);
  qtyInput.addEventListener('change', savePf);
  costInput.addEventListener('change', savePf);
  if (portfolioMode) node.querySelector('.portfolio-box').classList.add('show');

  grid.appendChild(node);

  if (sparklineData[ticker] && sparklineData[ticker].length > 1) drawSparkline(ticker);
  if (prevPrices[ticker] !== undefined && lastQuoteMeta[ticker]){
    const meta2 = lastQuoteMeta[ticker];
    const price = prevPrices[ticker];
    const change = meta2.prevClose ? price - meta2.prevClose : 0;
    const pct = meta2.prevClose ? (change / meta2.prevClose) * 100 : 0;
    renderQuote(ticker, { close: price, open: meta2.open, high: meta2.high, low: meta2.low, prevClose: meta2.prevClose, change, pct }, true);
  }
}

function renderQuote(ticker, data, skipFlash){
  const card = cardEl(ticker);
  if (!card) { pushSparkline(ticker, data.close); return; }

  const priceEl = card.querySelector('.price');
  const deltaEl = card.querySelector('.delta');
  const openEl = card.querySelector('.m-open');
  const highEl = card.querySelector('.m-high');
  const lowEl = card.querySelector('.m-low');
  const timeEl = card.querySelector('.updated');

  const prev = prevPrices[ticker];
  const change = data.change ?? (data.close - data.prevClose);
  const pct = data.pct ?? (data.prevClose ? (change / data.prevClose) * 100 : 0);
  const isUp = change >= 0;

  priceEl.textContent = '$' + fmtNum(data.close);
  priceEl.classList.remove('up','down');
  priceEl.classList.add(isUp ? 'up' : 'down');

  deltaEl.textContent = (isUp ? '▲ ' : '▼ ') + fmtNum(Math.abs(change)) + ' (' + fmtNum(Math.abs(pct)) + '%)';
  deltaEl.classList.remove('up','down');
  deltaEl.classList.add(isUp ? 'up' : 'down');

  openEl.textContent = '$' + fmtNum(data.open);
  highEl.textContent = '$' + fmtNum(data.high);
  lowEl.textContent = '$' + fmtNum(data.low);
  timeEl.textContent = `Ultimo aggiornamento: ${fmtTime()}`;

  if (!skipFlash && prev !== undefined && prev !== data.close){
    card.classList.remove('flash-up','flash-down');
    void card.offsetWidth;
    card.classList.add(data.close > prev ? 'flash-up' : 'flash-down');
  }
  prevPrices[ticker] = data.close;

  pushSparkline(ticker, data.close);
  drawSparkline(ticker);
  checkAlerts(ticker, data.close);
  if (portfolioMode) renderPortfolioForCard(ticker, card);
  renderPortfolioSummary();
}

// ---------- sparkline ----------

function pushSparkline(ticker, price){
  if (isNaN(price)) return;
  if (!sparklineData[ticker]) sparklineData[ticker] = [];
  const arr = sparklineData[ticker];
  arr.push(price);
  if (arr.length > SPARKLINE_POINTS) arr.shift();
}

function drawSparkline(ticker){
  const card = cardEl(ticker);
  if (!card) return;
  const arr = sparklineData[ticker];
  const svg = card.querySelector('.sparkline');
  const poly = svg.querySelector('polyline');
  if (!arr || arr.length < 2){ poly.setAttribute('points', ''); return; }

  const w = 260, h = 40, pad = 3;
  const min = Math.min(...arr), max = Math.max(...arr);
  const range = (max - min) || 1;
  const step = (w - pad * 2) / (arr.length - 1);

  const points = arr.map((p, i) => {
    const x = pad + i * step;
    const y = h - pad - ((p - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  poly.setAttribute('points', points);
  svg.classList.remove('up','down');
  svg.classList.add(arr[arr.length - 1] >= arr[0] ? 'up' : 'down');
}

// ---------- alerts ----------

function saveAlert(ticker, aboveStr, belowStr, node){
  const above = aboveStr !== '' ? parseFloat(aboveStr) : null;
  const below = belowStr !== '' ? parseFloat(belowStr) : null;
  if (above == null && below == null){
    delete alerts[ticker];
  } else {
    alerts[ticker] = { above, below };
  }
  delete alertFired[ticker];
  saveJSON(STORAGE.alerts, alerts);

  const btn = node.querySelector('.alert-toggle');
  btn.classList.toggle('has-alert', !!alerts[ticker]);
  const status = node.querySelector('.alert-status');
  status.textContent = alerts[ticker] ? 'Avviso salvato.' : 'Avviso rimosso.';

  if ((above != null || below != null) && 'Notification' in window && Notification.permission === 'default'){
    Notification.requestPermission();
  }
}

function checkAlerts(ticker, price){
  const a = alerts[ticker];
  if (!a) return;
  if (a.above != null && price >= a.above && alertFired[ticker] !== 'above'){
    fireAlert(ticker, 'above', price, a.above);
    alertFired[ticker] = 'above';
  } else if (a.below != null && price <= a.below && alertFired[ticker] !== 'below'){
    fireAlert(ticker, 'below', price, a.below);
    alertFired[ticker] = 'below';
  } else if ((a.above == null || price < a.above) && (a.below == null || price > a.below)){
    alertFired[ticker] = null;
  }
}

function fireAlert(ticker, side, price, threshold){
  const card = cardEl(ticker);
  if (card){
    card.classList.remove('alert-fired');
    void card.offsetWidth;
    card.classList.add('alert-fired');
  }
  const label = side === 'above' ? `sopra $${fmtNum(threshold)}` : `sotto $${fmtNum(threshold)}`;
  const msg = `${ticker} ha superato la soglia: ${label} (ora $${fmtNum(price)})`;

  if ('Notification' in window && Notification.permission === 'granted'){
    try{ new Notification('Avviso prezzo — ' + ticker, { body: msg }); } catch(e){}
  }
  playBeep();

  const status = card?.querySelector('.alert-status');
  if (status) status.textContent = msg;
}

function playBeep(){
  try{
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.3);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.3);
  } catch(e){}
}

// ---------- portfolio ----------

function savePortfolioEntry(ticker, qtyStr, costStr){
  const qty = qtyStr !== '' ? parseFloat(qtyStr) : null;
  const cost = costStr !== '' ? parseFloat(costStr) : null;
  if (qty == null && cost == null) delete portfolio[ticker];
  else portfolio[ticker] = { qty: qty ?? 0, cost: cost ?? 0 };
  saveJSON(STORAGE.portfolio, portfolio);
  const card = cardEl(ticker);
  if (card) renderPortfolioForCard(ticker, card);
  renderPortfolioSummary();
}

function renderPortfolioForCard(ticker, card){
  const entry = portfolio[ticker];
  const resultEl = card.querySelector('.pf-result');
  const price = prevPrices[ticker];
  if (!entry || !entry.qty || price === undefined){
    resultEl.textContent = '—';
    resultEl.classList.remove('up','down');
    return;
  }
  const value = entry.qty * price;
  const costBasis = entry.qty * entry.cost;
  const pl = value - costBasis;
  const plPct = costBasis ? (pl / costBasis) * 100 : 0;
  resultEl.textContent = `Valore $${fmtNum(value)}${fmtEur(value)} · P/L ${pl >= 0 ? '▲' : '▼'} $${fmtNum(Math.abs(pl))}${fmtEur(Math.abs(pl))} (${fmtNum(Math.abs(plPct))}%)`;
  resultEl.classList.remove('up','down');
  resultEl.classList.add(pl >= 0 ? 'up' : 'down');
}

function rateSummaryLine(){
  if (usdEurRate !== null){
    return `<div><div class="label">Cambio USD/EUR</div><b>${fmtNum(usdEurRate, 4)} <span style="font-weight:400;color:var(--text-dim);font-size:10px;">agg. ${rateUpdatedAt.toLocaleTimeString('it-IT')}</span></b></div>`;
  }
  return `<div><div class="label">Cambio USD/EUR</div><b style="color:var(--text-dim);font-size:12.5px;" title="Nessuna chiave richiesta: se resta così probabilmente qualcosa (estensione/firewall) blocca le API di cambio.">${rateFetchFailed ? 'non disponibile — riprovo tra poco' : 'caricamento…'}</b></div>`;
}

function renderPortfolioSummary(){
  const el = document.getElementById('portfolioSummary');
  if (!portfolioMode){ el.hidden = true; return; }
  let totalValue = 0, totalCost = 0, count = 0;
  for (const [ticker, entry] of Object.entries(portfolio)){
    if (!currentTickers()[ticker] || !entry.qty) continue;
    const price = prevPrices[ticker];
    if (price === undefined) continue;
    totalValue += entry.qty * price;
    totalCost += entry.qty * entry.cost;
    count++;
  }
  el.hidden = false;
  if (count === 0){
    el.innerHTML = `<div><div class="label">Portfolio</div><b>Nessuna posizione in questa watchlist</b></div>${rateSummaryLine()}`;
    return;
  }
  const pl = totalValue - totalCost;
  const plPct = totalCost ? (pl / totalCost) * 100 : 0;
  el.innerHTML = `
    <div><div class="label">Valore totale</div><b>$${fmtNum(totalValue)}${fmtEur(totalValue)}</b></div>
    <div><div class="label">Costo totale</div><b>$${fmtNum(totalCost)}${fmtEur(totalCost)}</b></div>
    <div><div class="label">P/L</div><b style="color:${pl >= 0 ? 'var(--up)' : 'var(--down)'}">${pl >= 0 ? '▲' : '▼'} $${fmtNum(Math.abs(pl))}${fmtEur(Math.abs(pl))} (${fmtNum(Math.abs(plPct))}%)</b></div>
    ${rateSummaryLine()}
  `;
}

function togglePortfolioMode(){
  portfolioMode = !portfolioMode;
  saveJSON(STORAGE.portfolioMode, portfolioMode);
  document.getElementById('portfolioBtn').classList.toggle('active', portfolioMode);
  document.querySelectorAll('.portfolio-box').forEach(b => b.classList.toggle('show', portfolioMode));
  if (portfolioMode) startRatePolling();
  else stopRatePolling();
  renderPortfolioSummary();
}

// ---------- USD → EUR live conversion ----------
// No API key needed for any of these — all are free, keyless, CORS-open FX
// sources. Several are listed so that if one is blocked (a browser
// extension, ad-blocker, or network filter blocking an unfamiliar domain)
// or temporarily down, the next one is tried automatically.

const FX_PROVIDERS = [
  {
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    parse: (j) => j?.usd?.eur,
  },
  {
    url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
    parse: (j) => j?.usd?.eur,
  },
  {
    url: 'https://api.frankfurter.app/latest?from=USD&to=EUR',
    parse: (j) => j?.rates?.EUR,
  },
  {
    url: 'https://open.er-api.com/v6/latest/USD',
    parse: (j) => j?.rates?.EUR,
  },
];

const RATE_REFRESH_MS = 5 * 60 * 1000; // FX moves slowly; no value in polling faster than this
let rateFetchFailed = false;

async function fetchExchangeRate(){
  for (const provider of FX_PROVIDERS){
    try{
      const res = await fetch(provider.url, { cache: 'no-store' });
      if (!res.ok) continue;
      const j = await res.json();
      const rate = provider.parse(j);
      if (typeof rate === 'number' && rate > 0){
        usdEurRate = rate;
        rateUpdatedAt = new Date();
        rateFetchFailed = false;
        renderPortfolioSummary();
        document.querySelectorAll('.card').forEach(card => {
          const ticker = card.dataset.ticker;
          if (ticker) renderPortfolioForCard(ticker, card);
        });
        return;
      }
    } catch(e){ /* try the next provider */ }
  }
  if (usdEurRate === null) rateFetchFailed = true;
  renderPortfolioSummary();
}

function startRatePolling(){
  fetchExchangeRate();
  if (rateTimer) clearInterval(rateTimer);
  rateTimer = setInterval(fetchExchangeRate, RATE_REFRESH_MS);
}
function stopRatePolling(){
  if (rateTimer) clearInterval(rateTimer);
  rateTimer = null;
}

// ---------- CSV export ----------

function exportCsv(){
  const rows = [['Ticker','Nome','Borsa','Prezzo','Variazione','Variazione %','Apertura','Massimo','Minimo','Quantita','PrezzoMedio','P/L','P/L %']];
  for (const [ticker, meta] of sortedVisibleTickers()){
    const price = prevPrices[ticker];
    const qmeta = lastQuoteMeta[ticker] || {};
    const change = (price !== undefined && qmeta.prevClose) ? price - qmeta.prevClose : '';
    const pct = (price !== undefined && qmeta.prevClose) ? ((price - qmeta.prevClose) / qmeta.prevClose) * 100 : '';
    const entry = portfolio[ticker];
    const value = entry && price !== undefined ? entry.qty * price : '';
    const costBasis = entry ? entry.qty * entry.cost : '';
    const pl = (value !== '' && costBasis !== '') ? value - costBasis : '';
    const plPct = (pl !== '' && costBasis) ? (pl / costBasis) * 100 : '';
    rows.push([
      ticker, meta.name, meta.exch,
      price ?? '', change, pct,
      qmeta.open ?? '', qmeta.high ?? '', qmeta.low ?? '',
      entry?.qty ?? '', entry?.cost ?? '', pl, plPct,
    ]);
  }
  const csv = rows.map(r => r.map(v => {
    const s = String(v ?? '');
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';')).join('\n');

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ticker-desk_${activeWatchlist}_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- add / remove tickers ----------

async function searchAndAdd(query){
  const statusEl = document.getElementById('addStatus');
  statusEl.className = 'add-status';
  statusEl.textContent = 'Ricerca in corso…';
  if (!apiKey){ statusEl.textContent = 'Imposta prima la API key.'; statusEl.classList.add('err'); return; }
  const q = query.trim();
  if (!q) return;

  const targetWatchlist = document.getElementById('addWatchlistSelect').value || activeWatchlist;

  try{
    const res = await fetch(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${apiKey}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Ricerca non riuscita (' + res.status + ')');
    const j = await res.json();
    if (!j.result || j.result.length === 0) throw new Error('Nessun titolo trovato per "' + q + '"');

    const upper = q.toUpperCase();
    const match = j.result.find(r => (r.symbol || '').toUpperCase() === upper) || j.result[0];
    const symbol = match.symbol;

    if (watchlists[targetWatchlist][symbol]){
      statusEl.textContent = symbol + ' è già presente in questa watchlist.';
      statusEl.classList.add('err');
      return;
    }

    const data = await fetchQuote(symbol);

    watchlists[targetWatchlist][symbol] = {
      name: match.description || symbol,
      exch: (match.type || '—').toUpperCase(),
      custom: true,
    };
    lastQuoteMeta[symbol] = { open: data.open, high: data.high, low: data.low, prevClose: data.prevClose };
    persistWatchlists();

    if (targetWatchlist === activeWatchlist){
      addCardToGrid(symbol, watchlists[targetWatchlist][symbol]);
      renderQuote(symbol, data);
      recalcInterval();
      subscribeSymbol(symbol);
    }

    statusEl.textContent = 'Aggiunto ' + symbol + ' — ' + watchlists[targetWatchlist][symbol].name + ' (' + targetWatchlist + ')';
    statusEl.classList.add('ok');
    document.getElementById('addInput').value = '';
  } catch(err){
    let msg = err.message || 'Errore sconosciuto';
    if (msg === 'no quote'){
      msg = 'Nessuna quotazione disponibile per questo titolo — probabile limite del piano gratuito Finnhub (es. mercati non USA, come Borsa Italiana).';
    }
    statusEl.textContent = 'Errore: ' + msg;
    statusEl.classList.add('err');
  }
}

function removeTicker(ticker){
  unsubscribeSymbol(ticker);
  delete currentTickers()[ticker];
  delete prevPrices[ticker];
  delete lastQuoteMeta[ticker];
  delete sparklineData[ticker];
  cardEl(ticker)?.remove();
  persistWatchlists();
  recalcInterval();
  renderPortfolioSummary();
}

// ---------- theme ----------

function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeBtn').textContent = theme === 'light' ? '☀' : '🌙';
}
function toggleTheme(){
  const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  applyTheme(theme);
  saveJSON(STORAGE.theme, theme);
}

// ---------- api key box ----------

function showApiKeyBox(prefill){
  document.getElementById('apikeyBox').classList.add('show');
  if (prefill) document.getElementById('apikeyInput').value = prefill;
}
function hideApiKeyBox(){
  document.getElementById('apikeyBox').classList.remove('show');
}

// ---------- init ----------

function init(){
  apiKey = loadJSON(STORAGE.apiKey, null);
  watchlists = loadJSON(STORAGE.watchlists, {});
  activeWatchlist = loadJSON(STORAGE.activeWatchlist, 'Default');
  alerts = loadJSON(STORAGE.alerts, {});
  portfolio = loadJSON(STORAGE.portfolio, {});
  portfolioMode = loadJSON(STORAGE.portfolioMode, false);
  const theme = loadJSON(STORAGE.theme, 'dark');

  ensureDefaultWatchlist();
  applyTheme(theme);

  renderWatchlistTabs();
  renderGrid();
  recalcInterval();
  document.getElementById('portfolioBtn').classList.toggle('active', portfolioMode);
  if (portfolioMode) startRatePolling();

  if (apiKey){
    hideApiKeyBox();
    startPolling();
  } else {
    showApiKeyBox();
    setStatus(false, 'In attesa della API key');
  }
}

document.getElementById('apikeySave').addEventListener('click', () => {
  const val = document.getElementById('apikeyInput').value.trim();
  if (!val) return;
  apiKey = val;
  saveJSON(STORAGE.apiKey, val);
  hideApiKeyBox();
  startPolling();
});

document.getElementById('changeKeyBtn').addEventListener('click', () => showApiKeyBox(apiKey || ''));
document.getElementById('refreshBtn').addEventListener('click', refreshAll);
document.getElementById('toggleAddBtn').addEventListener('click', () => document.getElementById('addBox').classList.toggle('show'));
document.getElementById('addBtn').addEventListener('click', () => searchAndAdd(document.getElementById('addInput').value));
document.getElementById('addInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchAndAdd(document.getElementById('addInput').value); });
document.getElementById('newWatchlistBtn').addEventListener('click', createWatchlist);
document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);
document.getElementById('portfolioBtn').addEventListener('click', togglePortfolioMode);
document.getElementById('themeBtn').addEventListener('click', toggleTheme);
document.getElementById('filterInput').addEventListener('input', (e) => { filterText = e.target.value; renderGrid(); });
document.getElementById('sortSelect').addEventListener('change', (e) => { sortMode = e.target.value; renderGrid(); });

init();
