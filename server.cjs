require('dotenv').config({ override: true, path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:5174',
    /\.railway\.app$/,
    /\.up\.railway\.app$/,
  ],
  credentials: true,
}));
app.use(express.json());

const BASE    = 'https://api-fxpractice.oanda.com';
const TOKEN   = process.env.OANDA_TOKEN;
const ACCOUNT = process.env.OANDA_ACCOUNT_ID;
const H       = { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

// Accept both Railway-style (no prefix) and local dev VITE_ prefix
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY  || process.env.VITE_ANTHROPIC_KEY;
const OPENAI_KEY    = process.env.OPENAI_API_KEY     || process.env.VITE_OPENAI_API_KEY;
const DEEPSEEK_KEY  = process.env.DEEPSEEK_API_KEY   || process.env.VITE_DEEPSEEK_API_KEY;
const GEMINI_KEY    = process.env.GEMINI_API_KEY     || process.env.VITE_GEMINI_API_KEY;
// Normalise auto-mode so the runtime toggle (which writes AUTO_MODE_ENABLED) always wins
if (!process.env.AUTO_MODE_ENABLED && process.env.VITE_AUTO_MODE) {
  process.env.AUTO_MODE_ENABLED = process.env.VITE_AUTO_MODE;
}

// ─── OANDA PROXY ENDPOINTS ────────────────────────────────────────────────────
const VALID_INSTRUMENTS = new Set([
  'EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD',
  'USD_CAD', 'EUR_GBP', 'NZD_USD', 'XAU_USD',
  'SPX500_USD', 'XAG_USD', 'BCO_USD', 'WTICO_USD',
  'NAS100_USD', 'JP225_USD', 'UK100_GBP', 'AU200_AUD',
]);

// Format price with correct decimal precision per instrument type
// JPY forex: 3dp | Metals (XAU/XAG): 2dp | Indices: 1dp | Energy (BCO/WTICO): 2dp | Default: 5dp
const formatPrice = (price, instrument = '') => {
  const p = parseFloat(price);
  if (isNaN(p)) return String(price);
  // JPY forex pairs only (not JP225 index)
  if (instrument.includes('JPY')) return p.toFixed(3);
  // Metals
  if (instrument.includes('XAU') || instrument.includes('XAG')) return p.toFixed(2);
  // Indices — 1 decimal place
  if (instrument.includes('NAS')  || instrument.includes('SPX') ||
      instrument.includes('JP2')  || instrument.includes('UK1') ||
      instrument.includes('AU2')  || instrument.includes('US30') ||
      instrument.includes('DE3')) return p.toFixed(1);
  // Energy
  if (instrument.includes('BCO') || instrument.includes('WTICO')) return p.toFixed(2);
  // Default forex
  return p.toFixed(5);
};

app.get('/prices', async (req, res) => {
  const instruments = req.query.instruments || 'EUR_USD,GBP_USD,USD_JPY';
  const requested = instruments.split(',').map(s => s.trim());
  const invalid = requested.filter(i => !VALID_INSTRUMENTS.has(i));
  if (invalid.length) {
    return res.status(400).json({ error: `Invalid instrument(s): ${invalid.join(', ')}. Valid: ${[...VALID_INSTRUMENTS].join(', ')}` });
  }
  try {
    const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/pricing?instruments=${instruments}`, { headers: H });
    const data = await r.json();
    if (!r.ok) {
      console.error('[/prices] OANDA error:', JSON.stringify(data));
      return res.status(r.status).json(data);
    }
    res.json(data);
  } catch (err) {
    console.error('[/prices] fetch threw:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/account', async (req, res) => {
  const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/summary`, { headers: H });
  res.json(await r.json());
});

app.get('/trades', async (req, res) => {
  const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/openTrades`, { headers: H });
  res.json(await r.json());
});

app.get('/positions', async (req, res) => {
  const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/openTrades`, { headers: H });
  res.json(await r.json());
});

app.get('/closed-trades', async (req, res) => {
  const count = Math.min(parseInt(req.query.count) || 50, 500);
  const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/trades?state=CLOSED&count=${count}`, { headers: H });
  res.json(await r.json());
});

app.post('/order', async (req, res) => {
  console.log('[ORDER] body:', JSON.stringify(req.body));
  console.log('[ORDER] BASE:', BASE, '| ACCOUNT:', ACCOUNT ? ACCOUNT.slice(0, 8) + '…' : 'MISSING');
  const { instrument, units, atr, price } = req.body;
  const direction = Number(units) >= 0 ? 'LONG' : 'SHORT';
  console.log(`POST /order — ${instrument} ${direction} ${Math.abs(Number(units))} units`);

  // Session gate — XAG/oil only trade in their liquidity windows
  const currentSession = getServerSession();
  console.log(`[XAG SESSION] ${currentSession} allowed:${[...XAG_ALLOWED_SESSIONS].join(',')}`);
  if (instrument === 'XAG_USD' && !XAG_ALLOWED_SESSIONS.has(currentSession)) {
    console.log(`[XAG SESSION] BLOCKED — ${currentSession} is outside London/Prime/NY`);
    return res.status(400).json({ error: `XAG_USD not allowed in ${currentSession} — only London/Prime/NY` });
  }
  if ((instrument === 'BCO_USD' || instrument === 'WTICO_USD') && !OIL_ALLOWED_SESSIONS.has(currentSession)) {
    console.log(`[OIL SESSION] BLOCKED — ${instrument} in ${currentSession} outside London/Prime/NY`);
    return res.status(400).json({ error: `${instrument} not allowed in ${currentSession} — only London/Prime/NY` });
  }

  const entryPrice = parseFloat(price) || 0;
  const atrVal     = parseFloat(atr)   || 0;
  const slMult     = ATR_SL_MULTIPLIER[instrument] ?? 1.5;
  const tpMult     = ATR_TP_MULTIPLIER[instrument] ?? 3.0;
  const minStop    = ({ EUR_USD: 0.0010, GBP_USD: 0.0012, USD_JPY: 0.10, AUD_USD: 0.0010, NZD_USD: 0.0010, USD_CAD: 0.0010, EUR_GBP: 0.0008, XAU_USD: 1.50, XAG_USD: 0.10 })[instrument] ?? 0.0010;
  const rawSlDist  = atrVal * slMult;
  const slDist     = Math.max(rawSlDist, minStop);
  console.log(`[XAG CALIBRATION] atrMult:${slMult} minStop:${minStop} rawDist:${rawSlDist.toFixed(5)} actualDist:${slDist.toFixed(5)}`);

  const slPrice    = atrVal > 0 && entryPrice > 0
    ? (direction === 'LONG' ? entryPrice - slDist : entryPrice + slDist)
    : null;

  const order = {
    type: 'MARKET', instrument, units: String(units),
    timeInForce: 'FOK', positionFill: 'DEFAULT',
  };
  console.log(`[ORDER] SL decision — atrVal=${atrVal} | slMult=${slMult} | entryPrice=${entryPrice} | slPrice=${slPrice}`);
  if (slPrice) {
    order.stopLossOnFill = { price: formatPrice(slPrice, instrument), timeInForce: 'GTC' };
    console.log('[ORDER] stopLossOnFill:', JSON.stringify(order.stopLossOnFill));
  } else {
    console.log('[ORDER] stopLossOnFill SKIPPED — atr=' + atrVal + ' or price=' + entryPrice + ' is zero/missing');
  }

  const tpPrice = atrVal > 0 && entryPrice > 0
    ? (direction === 'LONG' ? entryPrice + atrVal * tpMult : entryPrice - atrVal * tpMult)
    : null;
  if (tpPrice) {
    order.takeProfitOnFill = { price: formatPrice(tpPrice, instrument), timeInForce: 'GTC' };
    console.log(`[ORDER] takeProfitOnFill (${tpMult}R):`, JSON.stringify(order.takeProfitOnFill));
  }

  const body = JSON.stringify({ order });
  console.log('[ORDER] OANDA payload:', body);
  const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/orders`, { method: 'POST', headers: H, body });
  const data = await r.json();
  console.log('[OANDA RESPONSE]', r.status, JSON.stringify(data));
  const fillPrice = data?.orderFillTransaction?.price ?? null;
  if (fillPrice) console.log(`  ✓ filled @ ${fillPrice}`);
  else if (!r.ok) console.log(`  ✗ rejected — ${JSON.stringify(data?.errorMessage ?? data).slice(0, 200)}`);
  res.json(data);
});

// ─── SWING ORDER — instrument-calibrated units, explicit SL/TP1 prices ────────
app.post('/swing/order', async (req, res) => {
  const { instrument, slPrice, tp1Price } = req.body;
  let { units } = req.body;
  if (!instrument || !units) return res.status(400).json({ error: 'instrument and units required' });

  if (swingInFlight.has(instrument)) {
    console.log(`[SWING SKIP] ${instrument} already in flight — duplicate request blocked`);
    return res.json({ skipped: true, reason: 'already in flight' });
  }

  // Max 2 open trades (Rule 3) — check before placing
  try {
    const ot = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/openTrades`, { headers: H });
    const otData = await ot.json();
    const currentOpen = (otData.trades || []).length;
    if (currentOpen >= 2) {
      console.log(`[SWING BLOCK] ${instrument} — ${currentOpen} trades open, circuit breaker at 2`);
      return res.status(400).json({ error: 'MAX_TRADES', message: `${currentOpen} trades already open — max 2 allowed` });
    }
  } catch (e) {
    console.error('[SWING BLOCK] open trades check failed:', e.message);
    // fail open — let OANDA be the final backstop
  }

  swingInFlight.add(instrument);
  setTimeout(() => swingInFlight.delete(instrument), 30000);

  // Apply instrument-calibrated sizing (overrides frontend default of 500)
  const direction = Number(units) >= 0 ? 'LONG' : 'SHORT';
  const calibratedSize = SWING_UNITS[instrument] ?? 500;
  units = direction === 'LONG' ? calibratedSize : -calibratedSize;

  // Margin pre-flight — estimate entry from midpoint of SL and TP
  if (slPrice && tp1Price) {
    const estPrice = (parseFloat(slPrice) + parseFloat(tp1Price)) / 2;
    const marginCheck = await checkMargin(instrument, units, estPrice);
    if (!marginCheck.sufficient) {
      console.log(`[MARGIN BLOCK SWING] ${instrument} — required: $${marginCheck.required}, available: $${marginCheck.available}`);
      return res.status(400).json({
        error: 'INSUFFICIENT_MARGIN',
        required: marginCheck.required,
        available: marginCheck.available,
      });
    }
  }

  console.log(`POST /swing/order — ${instrument} ${direction} ${Math.abs(Number(units))} units`);
  const order = {
    type: 'MARKET', instrument, units: String(units),
    timeInForce: 'FOK', positionFill: 'DEFAULT',
  };
  if (slPrice)  order.stopLossOnFill   = { price: formatPrice(slPrice,  instrument), timeInForce: 'GTC' };
  if (tp1Price) order.takeProfitOnFill = { price: formatPrice(tp1Price, instrument), timeInForce: 'GTC' };
  try {
    const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/orders`, { method: 'POST', headers: H, body: JSON.stringify({ order }) });
    const data = await r.json();
    console.log('[SWING ORDER RESULT]', JSON.stringify(data).slice(0, 500));
    if (data.orderFillTransaction) {
      const tradeId = data.orderFillTransaction.tradeOpened?.tradeID ?? data.orderFillTransaction.id;
      console.log(`[SWING SUCCESS] ${instrument} ${direction} — tradeID: ${tradeId}, fill: ${data.orderFillTransaction.price}`);
    } else if (data.orderRejectTransaction) {
      console.error(`[SWING REJECTED] ${instrument} — ${data.orderRejectTransaction.rejectReason}`);
    } else {
      console.error(`[SWING UNKNOWN] ${instrument} —`, JSON.stringify(data).slice(0, 200));
    }
    res.json(data);
  } catch (e) {
    console.error('[SWING ORDER] fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/close/:tradeId', async (req, res) => {
  const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/trades/${req.params.tradeId}/close`, { method: 'PUT', headers: H });
  res.json(await r.json());
});

// Partial close — body: { units: "500" }
app.post('/close/:tradeId/partial', async (req, res) => {
  const { tradeId } = req.params;
  const { units } = req.body;
  if (!units) return res.status(400).json({ error: 'units required' });
  try {
    const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/trades/${tradeId}/close`, {
      method: 'PUT', headers: H,
      body: JSON.stringify({ units: String(units) }),
    });
    const data = await r.json();
    console.log(`[PARTIAL] ${tradeId} — ${units} units — ${r.status}`);
    res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Modify stop loss — body: { price: "1.23456" }
app.patch('/order/:tradeId/sl', async (req, res) => {
  const { tradeId } = req.params;
  const { price } = req.body;
  if (!price) return res.status(400).json({ error: 'price required' });
  try {
    const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/trades/${tradeId}/orders`, {
      method: 'PUT', headers: H,
      body: JSON.stringify({ stopLoss: { price: String(price), timeInForce: 'GTC' } }),
    });
    const data = await r.json();
    console.log(`[SL] ${tradeId} → ${price} — ${r.status}`);
    res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/candles/weekly', async (req, res) => {
  const { instrument, count = 10 } = req.query;
  if (!instrument) return res.status(400).json({ error: 'instrument required' });
  if (!VALID_INSTRUMENTS.has(instrument)) return res.status(400).json({ error: `Invalid instrument: ${instrument}` });
  const n = Math.min(parseInt(count) || 10, 52);
  try {
    const r = await fetch(`${BASE}/v3/instruments/${instrument}/candles?count=${n}&granularity=W&price=M`, { headers: H });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/candles/:instrument', async (req, res) => {
  const { instrument } = req.params;
  const count = Math.min(parseInt(req.query.count) || 60, 500);
  const granularity = req.query.granularity || 'M5';
  try {
    const r = await fetch(`${BASE}/v3/instruments/${instrument}/candles?count=${count}&granularity=${granularity}&price=M`, { headers: H });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── BACKTEST CANDLES — fetches up to 365 days via sequential 5000-candle requests ─
app.get('/backtest/candles', async (req, res) => {
  const { instrument, granularity = 'M5' } = req.query;
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  if (!instrument) return res.status(400).json({ error: 'instrument required' });

  const VALID = new Set([
    'EUR_USD','GBP_USD','USD_JPY','AUD_USD','USD_CAD','EUR_GBP','NZD_USD',
    'XAU_USD','SPX500_USD','BCO_USD','XAG_USD','WTICO_USD',
    'NAS100_USD','JP225_USD','UK100_GBP','AU200_AUD',
  ]);
  if (!VALID.has(instrument)) return res.status(400).json({ error: `Invalid instrument: ${instrument}` });

  const now = Date.now();
  const fromMs = now - days * 24 * 3600 * 1000;
  const allCandles = [];
  let currentFrom = fromMs;
  const MAX_REQUESTS = 25;

  try {
    for (let i = 0; i < MAX_REQUESTS; i++) {
      if (currentFrom >= now - 60_000) break;
      const fromISO = new Date(currentFrom).toISOString();
      const url = `${BASE}/v3/instruments/${instrument}/candles?granularity=${granularity}&from=${encodeURIComponent(fromISO)}&count=5000&price=M`;
      const r = await fetch(url, { headers: H });
      if (!r.ok) { const d = await r.json(); return res.status(r.status).json(d); }
      const data = await r.json();
      if (!Array.isArray(data.candles) || data.candles.length === 0) break;
      allCandles.push(...data.candles.filter(c => new Date(c.time).getTime() <= now));
      const lastTime = new Date(data.candles[data.candles.length - 1].time).getTime();
      if (lastTime >= now || data.candles.length < 500) break;
      currentFrom = lastTime + 1;
    }
    // Deduplicate by timestamp
    const seen = new Set();
    const candles = allCandles.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
    res.json({ candles, count: candles.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/test-notify', async (_req, res) => {
  await sendNotification(
    '🎯 QuantBot Pro — Discord Connected! Xavier is live and watching the markets.',
    {
      color: 0x00ff88,
      title: '🎯 QuantBot Pro — Online',
      description: 'Xavier is live and watching the markets. Rich embeds active.',
      fields: [
        { name: 'Status', value: '✅ Connected', inline: true },
        { name: 'Commands', value: '`/status` `/pause` `/resume` `/trades` `/balance` `/kill`', inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Xavier | QuantBot Pro' },
    }
  );
  res.json({ sent: true });
});

app.get('/discord-debug', async (_req, res) => {
  const botToken  = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!botToken || !channelId) return res.json({ error: 'DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID missing' });
  try {
    const [msgR, guildsR] = await Promise.all([
      fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=3`, { headers: { 'Authorization': `Bot ${botToken}` } }),
      fetch(`https://discord.com/api/v10/users/@me/guilds`, { headers: { 'Authorization': `Bot ${botToken}` } }),
    ]);
    const messages = await msgR.json();
    const guilds   = await guildsR.json();
    res.json({
      channelStatus: msgR.status,
      channelId,
      lastMessageId: lastDiscordMessageId,
      messages,
      guilds: Array.isArray(guilds) ? guilds.map(g => ({ id: g.id, name: g.name })) : guilds,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    autoMode: process.env.AUTO_MODE_ENABLED === 'true',
    models: {
      claude:   Boolean(ANTHROPIC_KEY),
      openai:   Boolean(OPENAI_KEY),
      deepseek: Boolean(DEEPSEEK_KEY),
      gemini:   Boolean(GEMINI_KEY),
    },
  });
});

app.post('/ai', async (req, res) => {
  const { prompt, systemPrompt, maxTokens } = req.body;
  if (!ANTHROPIC_KEY)
    return res.status(503).json({ error: { message: 'Missing VITE_ANTHROPIC_KEY in .env' } });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens || 400,
        system: systemPrompt || 'You are an expert trading assistant.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: { message: data?.error?.message || `Claude API HTTP ${r.status}` } });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// ─── IN-MEMORY STATE ─────────────────────────────────────────────────────────
const lastConsensus    = new Map(); // instrument → ms timestamp (5-min cooldown)
const autoTrades       = [];        // newest-first, capped at 100
const paperTrades      = [];        // newest-first, capped at 100
const m5History        = new Map(); // instrument → number[] (60 M5 closes)
const lastM5Fetch      = new Map(); // instrument → ms timestamp
const serverRejections   = [];        // newest-first, capped at 50
let   lastScanAt         = null;
const swingAutoTrades    = [];        // newest-first, capped at 50
const lastSwingConsensus = new Map(); // instrument → ms (4-hour cooldown per pair)

// Server-side trade log — persists across frontend sessions within a Railway deploy
// Frontend fetches on mount and merges with localStorage to show complete history
const serverTradeLog = [];          // newest-first, capped at 500

// Upgrade state — trade management, calendar, daily stats
const tradeManagementState = new Map(); // tradeId → { movedToBreakeven, partialClosed, peakR }
const lastKnownTradeIds        = new Set(); // for closed trade detection (management loop)
const serverAutoTradeOpenInstr = new Set(); // last-seen open instruments (auto-trade loop, for race-free cooldown detection)
let   economicEvents       = [];        // high-impact events this week
let   dailyStats           = { date: '', trades: 0, winners: 0, losers: 0, totalPnl: 0, bestTrade: '', _bestPnl: -Infinity };
let   lastDailySummaryDate = '';

// Post-close cooldown — blocks re-entry for 15 min after any close on same instrument
const postCloseCooldown       = new Map(); // instrument → ms timestamp of last close
const POST_CLOSE_COOLDOWN_MS  = 15 * 60 * 1000; // 15 minutes

// Adaptive principle weights — updated by frontend when consecutive streak events fire
let xavierWeights = { scoreThreshold: 65, newsWindowMins: 120, capitalPreservation: 1.0, informationFiltering: 1.0, patience: 1.0 };

// Xavier intel cache — populated when frontend calls /consensus with xavier data; used by server-side auto-trade
let lastXavierIntel = { sentiment: null, keyRisk: null, brief: null, bestPair: null, freshNews: null, ts: 0 };

// Pair-specific trail settings — commodities trail tighter/earlier than forex
const TRAIL_SETTINGS = {
  XAG_USD:   { startR: 1.5, trailR: 0.3 },
  BCO_USD:   { startR: 1.5, trailR: 0.3 },
  WTICO_USD: { startR: 1.5, trailR: 0.3 },
  XAU_USD:   { startR: 1.5, trailR: 0.3 },
  default:   { startR: 2.0, trailR: 0.5 },
};


// ─── XAVIER RULES ────────────────────────────────────────────────────────────
// USER EXPLICIT OVERRIDE — backtest-validated combinations (2026-05-27)
// USER EXPLICIT OVERRIDE 2026-05-28 — XAG_USD removed (capital protection, multiple losses)
// XAG_USD / BCO_USD / WTICO_USD = manual trading only, never auto
// M5 backtest-validated combinations — updated 2026-05-27
const XAVIER_RULES = {
  TOKYO:  { strategy: 'Mean Revert', pairs: ['EUR_GBP', 'EUR_USD', 'AUD_USD'],    minScore: 65 },
  LONDON: { strategy: 'Momentum',    pairs: ['GBP_USD', 'EUR_USD'],              minScore: 65 },
  PRIME:  { strategy: 'Breakout',    pairs: ['EUR_GBP', 'USD_CAD', 'XAU_USD'],    minScore: 65 },
  NY:     { strategy: 'Mean Revert', pairs: ['USD_CAD', 'AU200_AUD', 'NZD_USD'],  minScore: 65 },
  SYDNEY: { strategy: 'Mean Revert', pairs: ['GBP_USD', 'NZD_USD', 'AUD_USD'],   minScore: 65 },
  AVOID:  { strategy: null,          pairs: [],                                    minScore: 999 },
};

// Phase 1 — Core forex only (M5 backtest validated 2026-05-27)
// Phase 2 (add after 1 week clean execution): XAG_USD, NAS100_USD, UK100_GBP, AU200_AUD, SPX500_USD, JP225_USD
// Phase 3 (add after Phase 2 validates):      BCO_USD, WTICO_USD
const SERVER_PAIRS = new Set([
  'EUR_USD', 'GBP_USD', 'USD_JPY',
  'AUD_USD', 'USD_CAD', 'XAU_USD',
  'NZD_USD', 'EUR_GBP',
]);

// Index pairs — home session only, 75%+ score required (tighter spreads, higher conviction)
const INDEX_PAIRS = new Set([
  'SPX500_USD', 'NAS100_USD',  // NY only
  'JP225_USD',                  // Tokyo only
  'UK100_GBP',                  // London only
  'AU200_AUD',                  // Sydney only
]);

// Margin rates by asset class — used for pre-order margin check
const MARGIN_RATE = {
  EUR_USD: 0.02, GBP_USD: 0.02, USD_JPY: 0.02, AUD_USD: 0.02,
  USD_CAD: 0.02, NZD_USD: 0.02, EUR_GBP: 0.02,
  XAU_USD: 0.05, XAG_USD: 0.05, BCO_USD: 0.05, WTICO_USD: 0.05,
  NAS100_USD: 0.05, JP225_USD: 0.05, SPX500_USD: 0.05, UK100_GBP: 0.05, AU200_AUD: 0.05,
};

// Swing position sizing — high-priced instruments need fewer units to keep margin manageable
const SWING_UNITS = {
  XAU_USD:    100,
  BCO_USD:    100,
  WTICO_USD:  100,
  NAS100_USD:  10,
  SPX500_USD:  10,
}; // default: 500 for all forex pairs

async function getMarginAvailable() {
  try {
    const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/summary`, { headers: H });
    const data = await r.json();
    return parseFloat(data.account?.marginAvailable ?? 0);
  } catch {
    return Infinity; // can't fetch — don't block the trade
  }
}

async function checkMargin(instrument, units, price) {
  const rate      = MARGIN_RATE[instrument] ?? 0.05;
  const required  = Math.abs(units) * price * rate;
  const available = await getMarginAvailable();
  const sufficient = required <= available * 0.80; // keep 20% buffer
  if (!sufficient) {
    console.log(`[MARGIN BLOCK] ${instrument} — need $${required.toFixed(2)}, have $${(available * 0.80).toFixed(2)} (80% of $${available.toFixed(2)} available)`);
  }
  return { sufficient, required: parseFloat(required.toFixed(2)), available: parseFloat(available.toFixed(2)) };
}

// High-threshold pairs — 75% signal score required (volatile, wider spreads, needs higher conviction)
const HIGH_THRESHOLD_PAIRS = new Set([
  'XAG_USD', 'BCO_USD', 'WTICO_USD',           // Commodities — volatile
  'NAS100_USD', 'JP225_USD', 'UK100_GBP', 'AU200_AUD', 'SPX500_USD', // Indices
]);

// USD-sensitive pairs — price below EMA50 signals USD strength → LONGs blocked
// Update this set if the USD macro regime shifts (currently: strong USD)
const USD_SENSITIVE_PAIRS = new Set(['EUR_USD', 'GBP_USD', 'AUD_USD', 'NZD_USD', 'EUR_GBP']);

// Silver/oil session gates — thin Asian liquidity makes spreads unworkable
const XAG_ALLOWED_SESSIONS  = new Set(['LONDON', 'PRIME', 'NY']);
const OIL_ALLOWED_SESSIONS  = new Set(['LONDON', 'PRIME', 'NY']);
const XAG_MAX_SPREAD        = 0.05;  // 5 cents — wider = skip
const swingInFlight         = new Set(); // dedup guard — cleared after 30s per instrument
const OIL_MAX_SPREAD        = 0.08;  // 8 cents

// ATR stop multipliers by asset class
const ATR_SL_MULTIPLIER = { XAG_USD: 3.0, BCO_USD: 2.5, WTICO_USD: 2.5 };
const ATR_TP_MULTIPLIER = { XAG_USD: 6.0, BCO_USD: 5.0, WTICO_USD: 5.0 };

const INDEX_HOME_SESSION = {
  SPX500_USD: 'NY',     NAS100_USD: 'NY',
  JP225_USD:  'TOKYO',
  UK100_GBP:  'LONDON',
  AU200_AUD:  'SYDNEY',
};

function isHomeSession(pair, session) {
  return INDEX_HOME_SESSION[pair] === session;
}

// Allowed sessions per instrument — prevents cross-session misfires (e.g. NAS100 in London)
const INSTRUMENT_HOME_SESSIONS = {
  NAS100_USD: ['NY', 'SYDNEY'],
  JP225_USD:  ['TOKYO'],
  UK100_GBP:  ['LONDON', 'PRIME'],
  AU200_AUD:  ['SYDNEY', 'TOKYO'],
  SPX500_USD: ['NY'],
  XAG_USD:    ['LONDON', 'PRIME', 'NY'],
  BCO_USD:    ['LONDON', 'PRIME', 'NY'],
  WTICO_USD:  ['NY', 'PRIME'],
  XAU_USD:    ['LONDON', 'PRIME', 'NY', 'SYDNEY'],
};

const SERVER_PIP_SIZE = {
  EUR_USD: 0.0001, GBP_USD: 0.0001, USD_JPY:    0.01,
  AUD_USD: 0.0001, USD_CAD: 0.0001, NZD_USD:  0.0001,
  EUR_GBP: 0.0001, XAU_USD: 0.01,   XAG_USD:   0.01,
  SPX500_USD: 1.0, NAS100_USD: 1.0, JP225_USD:   1.0,
  UK100_GBP:  1.0, AU200_AUD:  1.0,
};

// ─── SHARED LLM HELPERS ──────────────────────────────────────────────────────
const SYS_CLAUDE = 'You are an elite forex risk guardian. Protect capital above all else. Be decisive. Respond ONLY in the format shown.';
const SYS_GPT    = 'You are an expert technical pattern analyst for forex. Validate price action only. Be decisive. Respond ONLY in the format shown.';
const SYS_DEEP   = 'You are a quantitative trading validator. Validate math and statistical edge only. Be decisive. Respond ONLY in the format shown.';
const SYS_GEM    = 'You are a macro and liquidity forex analyst. Validate market context only. Be decisive. Respond ONLY in the format shown.';

function buildClaudePrompt(p) {
  const xavierBlock = (p.xavierKeyRisk || p.xavierSentiment)
    ? `\nXavier Market Intelligence:
- Market sentiment: ${p.xavierSentiment || 'UNKNOWN'}
- Key risk flagged: ${p.xavierKeyRisk || 'none'}${p.xavierBrief ? `\n- Context: ${p.xavierBrief}` : ''}`
    : '';
  const freshnessBlock = (p.newsAgeMin !== undefined || p.xavierIntelAgeMin !== undefined)
    ? `\nData freshness: News ${p.newsAgeMin ?? '?'} min old | Xavier intel ${p.xavierIntelAgeMin ?? '?'} min old`
    : '';
  return `You are the Risk Guardian. Protect capital. Most likely to reject.

Trade: ${p.instrument} ${p.direction} @ ${p.price}
Session: ${p.session || 'UNKNOWN'} (${p.sessionQuality || 'UNKNOWN'})
R:R Ratio: ${p.rr || '2.0'}
Portfolio Heat: ${p.heat || '0'}R / 6R max
News risk: ${p.newsRisk || 'LOW'}
ATR: ${p.atr || '?'} (${p.atrPips || '?'} pips)
Stop Loss: ${p.sl || '?'} | Take Profit: ${p.tp || '?'}
Signal reason: ${p.reason}${xavierBlock}${freshnessBlock}

WEIGHTING RULE — M5 TRADES (apply this before any other check):
Trend alignment carries 70% of your decision weight.
- CONFIRM if price is above EMA50 for LONG, or below EMA50 for SHORT, and EMA9/EMA21 confirm direction.
- Only REJECT on trend grounds if price is clearly on the WRONG side of EMA50.
- Remaining 30%: spread (10%) + session timing (10%) + news risk (10%).
- A clean trend alignment with score >= 65% should be CONFIRM unless a MAJOR risk factor exists.
- Do NOT reject on minor concerns when the trend is clearly confirmed.

Van Tharp Rules:
- R:R must be >= 2.0
- No trading during HIGH impact news
- Circuit breaker at 6R heat
- Session must be GOOD or PRIME for this pair

If Xavier's key risk directly references this instrument, treat it as an elevated risk factor.
CONFIRM if trend alignment is clear (70% weight). REJECT only if a major risk condition is violated.

PRINCIPLE CHECKLIST — evaluate each before voting:
✓ R:R >= 1.5? (Asymmetric Payoff — Principle 3)
✓ Strategy matches current regime? (Regime Awareness — Principle 5)
✓ Spread within acceptable limits? (Liquidity Awareness)
✓ Higher timeframe supports direction? (MTF Context — Principle 7)
✓ ATR within 2.5× normal? (Volatility Adaptation — Principle 16)
✓ No HIGH-impact news within 2 hours? (Information Filtering — Principle 33)

4+ violated → REJECT regardless of trend alignment. 2 or fewer violated → lean CONFIRM.

Respond in this EXACT format:
VERDICT: CONFIRM or REJECT
REASON: (one sentence, max 15 words, use specific numbers, trader language — no corporate phrases)`;
}

function buildGPTPrompt(p) {
  const ema50side = p.ema50side || (p.ema50 && p.price
    ? (p.direction === 'LONG' ? (parseFloat(p.price) > parseFloat(p.ema50) ? 'ABOVE' : 'BELOW') : (parseFloat(p.price) < parseFloat(p.ema50) ? 'BELOW' : 'ABOVE'))
    : '?');
  return `You are the Pattern Analyst. Validate price action and trend structure only.

Trade: ${p.instrument} ${p.direction} @ ${p.price}
Signal score: ${p.score}%
EMA9: ${p.ema9 || '?'} | EMA21: ${p.ema21 || '?'} | EMA50: ${p.ema50 || '?'} | Price vs EMA50: ${ema50side}
Last 5 closes: ${p.closes || p.price}
Trend regime: ${p.regime || 'UNKNOWN'}
Momentum: ${p.momentum || '0'}%
RSI: ${p.rsi}

WEIGHTING RULE — M5 TRADES:
Trend alignment carries 70% of your decision weight.
- If price is above EMA50 for LONG (or below for SHORT) AND EMA9/EMA21 confirm direction → CONFIRM.
- Only REJECT on trend grounds if price is clearly on the wrong side of EMA50.
- A score >= 65% with clean trend alignment = CONFIRM unless regime is VOLATILE.
- Do NOT reject on minor momentum concerns if EMA structure is clearly aligned.

CONFIRM if EMA50 side and EMA9/EMA21 stack support the direction. REJECT only if price is against the trend or regime is VOLATILE.

Respond in this EXACT format:
VERDICT: CONFIRM or REJECT
REASON: (one sentence, max 15 words, use specific numbers, trader language — no corporate phrases)`;
}

function buildDeepSeekPrompt(p) {
  return `You are the Quantitative Validator. Validate math and statistical edge only.

Trade: ${p.instrument} ${p.direction} @ ${p.price}
Strategy: ${p.strategy || 'Mean Revert'}
Signal score: ${p.score}% (threshold: 65%)
Deviation from mean: ${p.deviation || '0'}%
ATR: ${p.atr || '?'} (${p.atrPips || '?'} pips)
Stop loss distance: ${p.slDistance || '?'} pips
Take profit distance: ${p.tpDistance || '?'} pips
R:R ratio: ${p.rr || '2.0'}
Position size: 1000 units
Risk amount: $${p.riskAmount || '1.50'} (1.5% of $${p.balance || '100'})
Target expectancy: +0.583R per trade

Validations:
- Score >= 65: ${p.scoreValid || (p.score >= 65 ? 'YES' : 'NO')}
- R:R >= 2.0: ${p.rrValid || 'YES'}
- ATR stop properly sized: ${p.atrValid || 'YES'}
- Position size correct: ${p.sizeValid || 'YES'}

WEIGHTING RULE — M5 TRADES:
Trend alignment carries 70% of your decision weight. The math check is 30%.
- If score >= 65% and R:R >= 2.0 → CONFIRM. These are the primary quantitative gates.
- Do NOT reject when score and R:R are valid just because deviation or ATR fields show defaults.
- Only REJECT if score < 65% OR R:R < 1.5 (hard math failure).

CONFIRM if score >= 65% and R:R >= 2.0. REJECT only on hard math failure.

Respond in this EXACT format:
VERDICT: CONFIRM or REJECT
REASON: (one sentence, max 15 words, cite the key number, trader language — no corporate phrases)`;
}

function buildGeminiPrompt(p) {
  const xavierBlock = (p.xavierKeyRisk || p.xavierSentiment)
    ? `\nXavier AI market read (proprietary — treat as additional signal context):
- Overall sentiment: ${p.xavierSentiment || 'UNKNOWN'}
- Best opportunity: ${p.xavierBestPair || 'none'}
- Key risk: ${p.xavierKeyRisk || 'none'}${p.xavierBrief ? `\n- Analysis: ${p.xavierBrief}` : ''}`
    : '';
  const freshnessBlock = (p.newsAgeMin !== undefined || p.xavierIntelAgeMin !== undefined)
    ? `\nData freshness: News ${p.newsAgeMin ?? '?'} min old | Xavier intel ${p.xavierIntelAgeMin ?? '?'} min old — factor staleness into your analysis`
    : '';
  const retailBlock = p.retailSentiment
    ? `\nRetail positioning (OANDA position book — contrarian indicator):
- ${p.retailSentiment.longPct}% retail LONG, ${p.retailSentiment.shortPct}% retail SHORT
- Contrarian read: ${p.retailSentiment.contrarian} (institutions fade crowded retail positions)`
    : '';
  return `You are the Macro & Liquidity Analyst. Validate market context and liquidity only.

Trade: ${p.instrument} ${p.direction} @ ${p.price}
Session: ${p.session || 'UNKNOWN'}
Current headline: "${p.headline}"
Spread: ${p.spread || '?'} pips (limit: ${p.spreadLimit || '?'} pips)
Correlated pairs: ${p.correlatedPairs || 'N/A'}
Market sentiment: ${p.sentiment || 'NEUTRAL'}
Volatility state: ${p.regime || 'RANGING'}
Change: ${p.change}%${xavierBlock}${retailBlock}${freshnessBlock}

WEIGHTING RULE — M5 TRADES:
Trend alignment carries 70% of your decision weight. Macro context is 30%.
- If session is active (not AVOID) and news risk is LOW or NEUTRAL → CONFIRM on macro grounds.
- Only REJECT on macro grounds if there is a HIGH-impact news event, extreme retail crowding, or a direct Xavier risk warning for this instrument.
- Do NOT reject on minor sentiment concerns if session and spread conditions are acceptable.
- A score >= 65% in an active session with no major news risk = CONFIRM from macro perspective.

CONFIRM if session is active and no major macro risk exists. REJECT only on HIGH-impact news or severe crowding.

Respond in this EXACT format:
VERDICT: CONFIRM or REJECT
REASON: (one sentence, max 15 words, trader language — name the specific macro factor, no corporate phrases)`;
}

// ─── KILL SHOT SWING CONSENSUS — MODEL ROLES ─────────────────────────────────
const SYS_CLAUDE_SWING = 'You are an elite swing trade risk guardian evaluating multi-day positions. Protect capital. Be decisive. Respond ONLY in the format shown.';
const SYS_GPT_SWING    = 'You are an H4 swing trade technical analyst. Validate H4 trend structure and EMA alignment for multi-day holds. Be decisive. Respond ONLY in the format shown.';
const SYS_DEEP_SWING   = 'You are a quantitative swing trade validator. Validate R:R math and expectancy for multi-day positions only. Be decisive. Respond ONLY in the format shown.';
const SYS_GEM_SWING    = 'You are a macro analyst evaluating conditions for a 2–5 day swing trade. Use Google Search to check news if needed. Be decisive. Respond ONLY in the format shown.';

function buildClaudeSwingPrompt(p) {
  const riskDist = Math.abs(parseFloat(p.entry) - parseFloat(p.sl));
  const tp1R = riskDist > 0 ? (Math.abs(parseFloat(p.tp1) - parseFloat(p.entry)) / riskDist).toFixed(2) : '?';
  const tp2R = riskDist > 0 ? (Math.abs(parseFloat(p.tp2) - parseFloat(p.entry)) / riskDist).toFixed(2) : '?';
  const tp3R = riskDist > 0 ? (Math.abs(parseFloat(p.tp3) - parseFloat(p.entry)) / riskDist).toFixed(2) : '?';
  return `You are evaluating a SWING TRADE setup targeting 3–5R over 2–5 days.

Kill Shot Setup:
- Pair: ${p.instrument} | Direction: ${p.direction}
- H4 Score: ${p.score}%
- Entry: ${p.entry} | Stop Loss: ${p.sl}
- TP1: ${p.tp1} (${tp1R}R) | TP2: ${p.tp2} (${tp2R}R) | TP3: ${p.tp3} (${tp3R}R)

Key questions:
1. Is H4 trend structure valid for a ${p.direction} swing over 5 days?
2. Is the stop loss placement logical relative to entry?
3. Does the R:R justify multi-day risk?
4. Any obvious macro risks for ${p.instrument} over next 5 days?

CONFIRM if structure is valid and R:R >= 1.5 at TP1. REJECT if any condition fails.

Respond in this EXACT format:
VERDICT: CONFIRM or REJECT
REASON: (one sentence, max 15 words, trader language)`;
}

function buildGPTSwingPrompt(p) {
  return `You are a technical analyst evaluating an H4 swing trade setup.

Setup: ${p.instrument} ${p.direction}
EMA21: ${p.ema21 || '?'} | EMA50: ${p.ema50 || '?'} | Current price: ${p.price}
RSI(14): ${p.rsi || '?'} | ATR(H4): ${p.atr || '?'}
Score: ${p.score}%

Key questions:
1. Is the EMA stack properly aligned for ${p.direction}?
2. Is price at a valid EMA21 pullback level?
3. Does the structure support a multi-day hold?
4. Is ATR sufficient for a 5-day position?

CONFIRM only if EMA alignment, pullback, and trend structure all support this direction.

Respond in this EXACT format:
VERDICT: CONFIRM or REJECT
REASON: (one sentence, max 15 words, trader language)`;
}

function buildDeepSeekSwingPrompt(p) {
  const SWING_PIP = { EUR_USD: 0.0001, GBP_USD: 0.0001, USD_JPY: 0.01, XAU_USD: 0.1, NAS100_USD: 1.0, BCO_USD: 0.01 };
  const pip = SWING_PIP[p.instrument] || 0.0001;
  const entry = parseFloat(p.entry), sl = parseFloat(p.sl);
  const tp1 = parseFloat(p.tp1), tp2 = parseFloat(p.tp2), tp3 = parseFloat(p.tp3);
  const riskDist = Math.abs(entry - sl);
  const riskPips  = (riskDist / pip).toFixed(1);
  const tp1R = riskDist > 0 ? (Math.abs(tp1 - entry) / riskDist).toFixed(2) : '?';
  const tp2R = riskDist > 0 ? (Math.abs(tp2 - entry) / riskDist).toFixed(2) : '?';
  const tp3R = riskDist > 0 ? (Math.abs(tp3 - entry) / riskDist).toFixed(2) : '?';
  const tp1Pips = (Math.abs(tp1 - entry) / pip).toFixed(1);
  const tp2Pips = (Math.abs(tp2 - entry) / pip).toFixed(1);
  const tp3Pips = (Math.abs(tp3 - entry) / pip).toFixed(1);
  const tp1RNum = parseFloat(tp1R);
  const breakEven = tp1RNum > 0 ? (1 / (1 + tp1RNum) * 100).toFixed(1) : '?';
  const ev40 = tp1RNum > 0 ? ((0.4 * tp1RNum - 0.6) * 100).toFixed(1) : '?';
  return `Validate this swing trade mathematically.

Entry: ${p.entry} | Stop: ${p.sl}
Risk: ${riskPips} pips | Position: 500 units
TP1: ${p.tp1} (${tp1Pips} pips, ${tp1R}R)
TP2: ${p.tp2} (${tp2Pips} pips, ${tp2R}R)
TP3: ${p.tp3} (${tp3Pips} pips, ${tp3R}R)

Calculated:
- Break-even win rate at TP1: ${breakEven}%
- Expected value at 40% win rate: ${ev40}% of risk

CONFIRM if R:R >= 1.5 at TP1. REJECT if R:R < 1.5.

Respond in this EXACT format:
VERDICT: CONFIRM or REJECT
REASON: (one sentence, max 15 words, cite the R:R number)`;
}

function buildGeminiSwingPrompt(p) {
  const xavierBlock = (p.xavierKeyRisk || p.xavierSentiment)
    ? `\nXavier AI read:\n- Sentiment: ${p.xavierSentiment || 'UNKNOWN'}\n- Key risk: ${p.xavierKeyRisk || 'none'}\n- Best pair: ${p.xavierBestPair || 'none'}`
    : '';
  const newsBlock = p.freshNews ? `\nLive news context:\n${p.freshNews}` : '';
  const retailBlock = p.retailSentiment
    ? `\nRetail positioning (OANDA — contrarian): ${p.retailSentiment.longPct}% LONG / ${p.retailSentiment.shortPct}% SHORT — institutional read: ${p.retailSentiment.contrarian}`
    : '';
  const freshnessBlock = (p.newsAgeMin !== undefined || p.xavierIntelAgeMin !== undefined)
    ? `\nData freshness: News ${p.newsAgeMin ?? '?'} min old | Xavier intel ${p.xavierIntelAgeMin ?? '?'} min old — factor staleness into your analysis`
    : '';
  return `You are evaluating macro conditions for a multi-day swing trade.

Trade: ${p.instrument} ${p.direction}
Hold period: up to 5 days | Session: ${p.session || 'UNKNOWN'}
H4 Score: ${p.score}%${xavierBlock}${newsBlock}${retailBlock}${freshnessBlock}

Evaluate:
1. Are macro conditions favorable for ${p.direction} on ${p.instrument} over 5 days?
2. Any scheduled HIGH-impact events in next 5 days that could invalidate this trade?
3. Does institutional positioning support ${p.direction}?
4. Is the multi-day trend intact?

CONFIRM if macro environment supports this swing. REJECT if significant headwinds exist.

Respond in this EXACT format:
VERDICT: CONFIRM or REJECT
REASON: (one sentence, max 15 words, name the specific macro factor)`;
}

function parseVerdict(text) {
  const lines = (text || '').split('\n').reduce((a, l) => {
    const i = l.indexOf(':'); if (i > 0) a[l.slice(0, i).trim()] = l.slice(i + 1).trim(); return a;
  }, {});
  return { verdict: (lines.VERDICT || '').includes('CONFIRM') ? 'CONFIRM' : 'REJECT', reason: lines.REASON || '—' };
}

function apiErr(d, fallback) { return d?.error?.message || d?.error?.type || fallback; }

async function askClaude(prompt, sys) {
  if (!ANTHROPIC_KEY) throw new Error('Missing VITE_ANTHROPIC_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 120, system: sys || SYS_CLAUDE, messages: [{ role: 'user', content: prompt }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(apiErr(d, `Claude HTTP ${r.status}`));
  const text = d.content?.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('Claude empty response');
  return { name: 'Claude Sonnet', ...parseVerdict(text) };
}

async function askGPT(prompt, sys) {
  if (!OPENAI_KEY) throw new Error('Missing VITE_OPENAI_API_KEY');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o', max_tokens: 120, messages: [{ role: 'system', content: sys || SYS_GPT }, { role: 'user', content: prompt }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(apiErr(d, `OpenAI HTTP ${r.status}`));
  const text = d.choices?.[0]?.message?.content;
  if (!text) throw new Error('GPT empty response');
  return { name: 'GPT-4o', ...parseVerdict(text) };
}

async function askDeepSeek(prompt, sys) {
  if (!DEEPSEEK_KEY) throw new Error('Missing VITE_DEEPSEEK_API_KEY');
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 120, messages: [{ role: 'system', content: sys || SYS_DEEP }, { role: 'user', content: prompt }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(apiErr(d, `DeepSeek HTTP ${r.status}`));
  const text = d.choices?.[0]?.message?.content;
  if (!text) throw new Error('DeepSeek empty response');
  return { name: 'DeepSeek', ...parseVerdict(text) };
}

async function askGemini(prompt, sys) {
  if (!GEMINI_KEY) throw new Error('Missing VITE_GEMINI_API_KEY');
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys || SYS_GEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      }),
    }
  );
  const d = await r.json();
  if (!r.ok) throw new Error(apiErr(d, `Gemini HTTP ${r.status}`));
  const text = d.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
  if (!text) throw new Error('Gemini empty response');
  return { name: 'Gemini 2.5 Flash', ...parseVerdict(text) };
}

const MODEL_TAG = { 'Claude Sonnet': 'CLAUDE', 'GPT-4o': 'GPT4', 'DeepSeek': 'DEEPSEEK', 'Gemini 2.5 Flash': 'GEMINI' };

async function runConsensus(rawParams) {
  // Normalize field names — accept both server-style (sl/tp/rr/instrument) and
  // friendly-style (stopLoss/takeProfit/riskReward/pair) so tests and frontend calls both work
  const params = {
    ...rawParams,
    instrument: rawParams.instrument || rawParams.pair,
    sl:         rawParams.sl         || rawParams.stopLoss,
    tp:         rawParams.tp         || rawParams.takeProfit,
    rr:         rawParams.rr         || rawParams.riskReward,
  };
  const settled = await Promise.allSettled([
    askClaude(buildClaudePrompt(params),    SYS_CLAUDE),
    askGPT(buildGPTPrompt(params),          SYS_GPT),
    askDeepSeek(buildDeepSeekPrompt(params),SYS_DEEP),
    askGemini(buildGeminiPrompt(params),    SYS_GEM),
  ]);
  const NAMES = ['Claude Sonnet', 'GPT-4o', 'DeepSeek', 'Gemini 2.5 Flash'];
  const models = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const raw = r.reason?.message || 'Model unreachable';
    const reason = raw.includes('prepayment') || raw.includes('credits') ? 'Credits depleted — check billing'
      : raw.includes('quota') || raw.includes('Quota') ? 'Quota exceeded — rate limit'
      : raw.includes('Missing') ? raw
      : raw.slice(0, 80);
    return { name: NAMES[i], verdict: 'REJECT', reason };
  });
  const confirms = models.filter(m => m.verdict === 'CONFIRM').length;
  const voteLog = models.map(m => {
    const tag  = MODEL_TAG[m.name] || m.name.toUpperCase();
    const icon = m.verdict === 'CONFIRM' ? '✓' : '✗';
    return `[${tag}] ${m.verdict} — ${m.reason} ${icon}`;
  });
  voteLog.push(`Result: ${confirms}/4 CONFIRM → ${confirms >= 3 ? 'EXECUTE' : 'BLOCKED'}`);
  return {
    votes: { confirm: confirms, reject: models.length - confirms },
    consensus: confirms >= 3 ? 'CONFIRM' : 'REJECT',
    confidence: `${Math.round((confirms / models.length) * 100)}%`,
    models,
    voteLog,
    executeAllowed: confirms >= 3,
  };
}

// ─── NEWS ENDPOINT ───────────────────────────────────────────────────────────
const NEWS_QUERIES = {
  all:         'forex+stock+market+trading+finance',
  forex:       'forex+EUR+USD+GBP+JPY+currency+trading',
  indices:     'S%26P500+nasdaq+dow+jones+stock+market+indices',
  commodities: 'gold+oil+commodities+crude+XAU',
  crypto:      'bitcoin+ethereum+cryptocurrency+BTC+crypto',
  macro:       'federal+reserve+interest+rates+inflation+central+bank+GDP',
};

const BULLISH_WORDS = /\b(rises?|gains?|rallies|rally|surges?|jumps?|bullish|strong|highs?|above|record|beats?|climbs?|soars?|advances?|rebounds?|recovers?)\b/i;
const BEARISH_WORDS = /\b(falls?|drops?|declines?|slides?|tumbles?|bearish|weak|below|concerns?|warning|crash|plunges?|slips?|retreats?|selloff|sell-off|losses?|dips?)\b/i;

function parseSentiment(title) {
  if (BULLISH_WORDS.test(title)) return 'bullish';
  if (BEARISH_WORDS.test(title)) return 'bearish';
  return 'neutral';
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function parseRSS(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title  = decodeEntities((b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/s)?.[1] || b.match(/<title>(.*?)<\/title>/s)?.[1] || '').trim());
    const link   = (b.match(/<link>(.*?)<\/link>/s)?.[1] || '').trim();
    const pubDate= (b.match(/<pubDate>(.*?)<\/pubDate>/s)?.[1] || '').trim();
    const source = decodeEntities((b.match(/<source[^>]*>(.*?)<\/source>/s)?.[1] || '').trim());
    if (title) items.push({ title, link, pubDate, source, sentiment: parseSentiment(title) });
    if (items.length >= 30) break;
  }
  return items;
}

const newsCache = new Map(); // category → { items, commentary, fetchedAt }

const CAT_NAMES = {
  forex: 'Forex / Currency Markets',
  indices: 'Equity Indices',
  commodities: 'Commodities',
  crypto: 'Crypto Markets',
  macro: 'Macro / Central Banks',
};

async function getGeminiCommentary(category, headlines) {
  if (!GEMINI_KEY) return null;
  const list = headlines.slice(0, 10).map(h => `- ${h.title}`).join('\n');
  const catName = CAT_NAMES[category] || category;
  const prompt = `You are a concise forex market analyst. Based on these recent ${catName} headlines, write exactly 2 sentences: (1) the dominant market theme right now, (2) the key directional bias traders should watch. Max 50 words total. Be specific — name pairs, assets, or data.\n\nHeadlines:\n${list}`;
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'You are a decisive, concise forex market analyst.' }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        }),
      }
    );
    const d = await r.json();
    if (!r.ok) return null;
    return d.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.trim() || null;
  } catch {
    return null;
  }
}

app.get('/news', async (req, res) => {
  const category = (req.query.category || 'forex').toLowerCase();
  const query = NEWS_QUERIES[category] || NEWS_QUERIES.forex;
  const cached = newsCache.get(category);
  if (cached && Date.now() - cached.fetchedAt < 5 * 60_000) {
    return res.json({ category, items: cached.items, commentary: cached.commentary, fetchedAt: new Date(cached.fetchedAt).toISOString(), cached: true });
  }
  try {
    const r = await fetch(`https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuantBot/1.0)' },
    });
    if (!r.ok) throw new Error(`RSS HTTP ${r.status}`);
    const xml = await r.text();
    const items = parseRSS(xml);
    const commentary = await getGeminiCommentary(category, items);
    newsCache.set(category, { items, commentary, fetchedAt: Date.now() });
    res.json({ category, items, commentary, fetchedAt: new Date().toISOString(), cached: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SENTIMENT ENDPOINT (OANDA position book — retail positioning) ────────────
const sentimentCache = new Map(); // instrument → { data, fetchedAt }

app.get('/sentiment', async (req, res) => {
  const instruments = (req.query.instruments || 'EUR_USD,GBP_USD,USD_JPY,AUD_USD,USD_CAD,XAU_USD').split(',');
  const results = {};

  await Promise.all(instruments.map(async (instrument) => {
    const cached = sentimentCache.get(instrument);
    if (cached && Date.now() - cached.fetchedAt < 30 * 60_000) {
      results[instrument] = cached.data;
      return;
    }
    try {
      const r = await fetch(
        `${BASE}/v3/instruments/${instrument}/positionBook`,
        { headers: H }
      );
      const d = await r.json();
      if (!r.ok || !d.positionBook?.buckets) { results[instrument] = null; return; }

      const buckets = d.positionBook.buckets;
      let longUnits = 0, shortUnits = 0;
      buckets.forEach(b => {
        longUnits  += parseFloat(b.longCountPercent  || 0);
        shortUnits += parseFloat(b.shortCountPercent || 0);
      });
      const total = longUnits + shortUnits;
      const longPct  = total > 0 ? Math.round((longUnits  / total) * 100) : 50;
      const shortPct = 100 - longPct;
      // Contrarian read: >65% retail long → institutions likely short
      const contrarian = longPct >= 65 ? "BEARISH" : shortPct >= 65 ? "BULLISH" : "NEUTRAL";
      const data = { longPct, shortPct, contrarian, price: d.positionBook.price, time: d.positionBook.time };
      sentimentCache.set(instrument, { data, fetchedAt: Date.now() });
      results[instrument] = data;
    } catch {
      results[instrument] = null;
    }
  }));

  res.json({ sentiment: results, fetchedAt: new Date().toISOString() });
});

// ─── ECONOMIC CALENDAR ENDPOINT (ForexFactory RSS) ────────────────────────────
let calendarCache = null;
let calendarFetchedAt = 0;

function parseCalendarRSS(xml) {
  const events = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title    = (b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/s)?.[1] || b.match(/<title>(.*?)<\/title>/s)?.[1] || '').trim();
    const date     = (b.match(/<title>[\s\S]*?<\/title>[\s\S]*?<description><!\[CDATA\[(.*?)\]\]><\/description>/s)?.[1] || '').trim();
    const link     = (b.match(/<link>(.*?)<\/link>/s)?.[1] || '').trim();
    const impact   = /high/i.test(b) ? 'HIGH' : /medium/i.test(b) ? 'MEDIUM' : 'LOW';
    if (title) events.push({ title, date, link, impact });
    if (events.length >= 20) break;
  }
  return events;
}

app.get('/economic-calendar', async (_req, res) => {
  if (calendarCache && Date.now() - calendarFetchedAt < 60 * 60_000) {
    return res.json({ events: calendarCache, fetchedAt: new Date(calendarFetchedAt).toISOString(), cached: true });
  }
  try {
    const r = await fetch('https://www.forexfactory.com/ff_calendar_thisweek.xml', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuantBot/1.0; +https://quantbot.app)' },
    });
    if (!r.ok) throw new Error(`ForexFactory HTTP ${r.status}`);
    const xml = await r.text();
    const events = parseCalendarRSS(xml);
    calendarCache = events;
    calendarFetchedAt = Date.now();
    res.json({ events, fetchedAt: new Date().toISOString(), cached: false });
  } catch (e) {
    // Return cached data if available, even if stale
    if (calendarCache) return res.json({ events: calendarCache, fetchedAt: new Date(calendarFetchedAt).toISOString(), cached: true, stale: true });
    res.status(500).json({ error: e.message, events: [] });
  }
});

// ─── XAVIER PRINCIPLE WEIGHTS ─────────────────────────────────────────────────
app.get('/xavier-weights', (_req, res) => res.json(xavierWeights));
app.post('/xavier-weights', (req, res) => {
  const { scoreThreshold, newsWindowMins, capitalPreservation, informationFiltering, patience } = req.body;
  if (typeof scoreThreshold       === 'number') xavierWeights.scoreThreshold       = Math.max(50, Math.min(95, scoreThreshold));
  if (typeof newsWindowMins       === 'number') xavierWeights.newsWindowMins       = Math.max(60, Math.min(240, newsWindowMins));
  if (typeof capitalPreservation  === 'number') xavierWeights.capitalPreservation  = capitalPreservation;
  if (typeof informationFiltering === 'number') xavierWeights.informationFiltering  = informationFiltering;
  if (typeof patience             === 'number') xavierWeights.patience             = patience;
  console.log('[xavier-weights] Updated:', xavierWeights);
  res.json({ ok: true, weights: xavierWeights });
});

// ─── CONSENSUS ENDPOINT ───────────────────────────────────────────────────────
app.post('/consensus', async (req, res) => {
  try {
    const p = req.body;
    // Cache any xavier intel the frontend sends — server auto-trade uses this
    if (p.xavierSentiment || p.xavierKeyRisk || p.xavierBrief) {
      lastXavierIntel = {
        sentiment: p.xavierSentiment || null,
        keyRisk:   p.xavierKeyRisk   || null,
        brief:     p.xavierBrief     || null,
        bestPair:  p.xavierBestPair  || null,
        freshNews: p.freshNews        || null,
        ts:        Date.now(),
      };
    }
    res.json(await runConsensus(p));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── KILL SHOT SWING CONSENSUS ENDPOINT ─────────────────────────────────────
app.post('/swing-consensus', async (req, res) => {
  try {
    const p = { ...req.body };
    // Fetch retail sentiment inline if not provided
    if (!p.retailSentiment && p.instrument) {
      try {
        const r = await fetch(`${BASE}/v3/instruments/${p.instrument}/positionBook`, { headers: H });
        const d = await r.json();
        if (r.ok && d.positionBook?.buckets) {
          let longU = 0, shortU = 0;
          d.positionBook.buckets.forEach(b => { longU += parseFloat(b.longCountPercent || 0); shortU += parseFloat(b.shortCountPercent || 0); });
          const tot = longU + shortU;
          const longPct = tot > 0 ? Math.round((longU / tot) * 100) : 50;
          p.retailSentiment = { longPct, shortPct: 100 - longPct, contrarian: longPct >= 65 ? 'BEARISH' : (100 - longPct) >= 65 ? 'BULLISH' : 'NEUTRAL' };
        }
      } catch { /* skip — non-fatal */ }
    }
    const settled = await Promise.allSettled([
      askClaude(buildClaudeSwingPrompt(p),    SYS_CLAUDE_SWING),
      askGPT(buildGPTSwingPrompt(p),          SYS_GPT_SWING),
      askDeepSeek(buildDeepSeekSwingPrompt(p),SYS_DEEP_SWING),
      askGemini(buildGeminiSwingPrompt(p),    SYS_GEM_SWING),
    ]);
    const NAMES = ['Claude Sonnet', 'GPT-4o', 'DeepSeek', 'Gemini 2.5 Flash'];
    const models = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const raw = r.reason?.message || 'Model unreachable';
      const reason = raw.includes('prepayment') || raw.includes('credits') ? 'Credits depleted — check billing'
        : raw.includes('quota') || raw.includes('Quota') ? 'Quota exceeded'
        : raw.includes('Missing') ? raw : raw.slice(0, 80);
      return { name: NAMES[i], verdict: 'REJECT', reason };
    });
    const confirms = models.filter(m => m.verdict === 'CONFIRM').length;
    // Weighted rule: Claude MUST confirm AND at least 1 other model confirms
    const claudeConfirmed = models[0]?.verdict === 'CONFIRM';
    const otherConfirmed  = models.slice(1).filter(m => m.verdict === 'CONFIRM');
    const executeAllowed  = claudeConfirmed && otherConfirmed.length >= 1;
    const voteLog = models.map(m => {
      const tag  = MODEL_TAG[m.name] || m.name.toUpperCase();
      const icon = m.verdict === 'CONFIRM' ? '✓' : '✗';
      return `[${tag}] ${m.verdict} — ${m.reason} ${icon}`;
    });
    const resultLine = executeAllowed
      ? `Result: Claude + ${otherConfirmed[0].name.split(' ')[0]} confirmed → KILL SHOT EXECUTE`
      : !claudeConfirmed
        ? `Result: BLOCKED — Claude rejected`
        : `Result: BLOCKED — Claude confirmed but no supporting model`;
    voteLog.push(resultLine);
    res.json({
      votes: { confirm: confirms, reject: models.length - confirms },
      consensus: executeAllowed ? 'CONFIRM' : 'REJECT',
      confidence: `${Math.round((confirms / models.length) * 100)}%`,
      models, voteLog,
      executeAllowed,
      claudeConfirmed,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AUTO MODE TOGGLE ────────────────────────────────────────────────────────
app.post('/auto-mode', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
  process.env.AUTO_MODE_ENABLED = enabled ? 'true' : 'false';
  console.log(`AUTO MODE: ${enabled ? 'ENABLED ⚡' : 'disabled'}`);
  res.json({ autoMode: enabled });
});

// ─── AUTO TRADES ENDPOINT ─────────────────────────────────────────────────────
app.get('/auto-trades', (_req, res) => {
  res.json({ autoMode: process.env.AUTO_MODE_ENABLED === 'true', count: autoTrades.length, trades: autoTrades });
});

// ─── SWING AUTO TRADES ENDPOINT ──────────────────────────────────────────────
app.get('/swing-auto-trades', (_req, res) => {
  res.json({ count: swingAutoTrades.length, trades: swingAutoTrades });
});

// ─── PAPER TRADES ENDPOINT ────────────────────────────────────────────────────
app.get('/paper-trades', (_req, res) => {
  res.json({ count: paperTrades.length, trades: paperTrades });
});

app.get('/trade-log', (_req, res) => {
  res.json({ count: serverTradeLog.length, trades: serverTradeLog });
});

// ─── AUTO STATUS ENDPOINT ─────────────────────────────────────────────────────
app.get('/auto-status', (_req, res) => {
  const session = getServerSession();
  const rule    = XAVIER_RULES[session] || {};
  res.json({
    autoMode:         process.env.AUTO_MODE_ENABLED === 'true',
    session,
    strategy:         rule.strategy  || null,
    activePairs:      rule.pairs     || [],
    lastScanAt:       lastScanAt ? new Date(lastScanAt).toISOString() : null,
    autoTrades:       autoTrades.slice(0, 10),
    recentRejections: serverRejections.slice(0, 10),
  });
});

// ─── TRANSACTION AUDIT ────────────────────────────────────────────────────────
app.get('/audit', async (req, res) => {
  try {
    // Step 1: get lastTransactionID from account
    const acctR  = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/summary`, { headers: H });
    const acctD  = await acctR.json();
    const lastId = parseInt(acctD.account?.lastTransactionID || acctD.lastTransactionID || '0', 10);

    const count   = Math.min(parseInt(req.query.count || '200', 10), 900);
    const fromId  = Math.max(1, lastId - count + 1);

    // Step 2: fetch by ID range (OANDA v20 idrange endpoint)
    const r    = await fetch(
      `${BASE}/v3/accounts/${ACCOUNT}/transactions/idrange?from=${fromId}&to=${lastId}`,
      { headers: H }
    );
    const data = await r.json();
    const txns = data.transactions || [];

    let tradesOpened = 0, tradesClosed = 0, slMods = 0, tpHits = 0, rejections = 0;
    let netPnl = 0;
    let biggestWin  = { pair: null, amount: 0 };
    let biggestLoss = { pair: null, amount: 0 };

    // type frequency map for full visibility
    const typeCounts = {};

    for (const t of txns) {
      typeCounts[t.type] = (typeCounts[t.type] || 0) + 1;

      if (t.type === 'ORDER_FILL')           tradesOpened++;
      if (t.type === 'TRADE_CLOSE')          tradesClosed++;
      if (t.type === 'STOP_LOSS_ORDER')      slMods++;
      if (t.type === 'TAKE_PROFIT_ORDER')    tpHits++;
      if (t.type === 'MARKET_ORDER_REJECT' ||
          t.type === 'ORDER_CANCEL')         rejections++;

      if (t.pl) {
        const pl = parseFloat(t.pl);
        if (!isNaN(pl)) {
          netPnl += pl;
          if (pl > biggestWin.amount)  biggestWin  = { pair: t.instrument || null, amount: pl };
          if (pl < biggestLoss.amount) biggestLoss = { pair: t.instrument || null, amount: pl };
        }
      }
    }

    // recent 50 transactions for inspection (newest first)
    const recent = txns.slice().reverse().slice(0, 50).map(t => ({
      id:         t.id,
      type:       t.type,
      time:       t.time,
      instrument: t.instrument || null,
      units:      t.units      || null,
      price:      t.price      || null,
      pl:         t.pl         || null,
      reason:     t.reason     || t.rejectReason || null,
    }));

    res.json({
      totalTransactions: txns.length,
      tradesOpened,
      tradesClosed,
      slModifications: slMods,
      tpHits,
      rejections,
      netPnl:     parseFloat(netPnl.toFixed(2)),
      biggestWin,
      biggestLoss,
      typeCounts,
      recent,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── TELEGRAM NOTIFICATIONS ───────────────────────────────────────────────────
// Setup: Add these two env vars to Railway (Settings → Variables):
//   TELEGRAM_BOT_TOKEN   — get from @BotFather: /newbot → copy token
//   TELEGRAM_CHAT_ID     — start your bot, then visit:
//                          https://api.telegram.org/bot<TOKEN>/getUpdates
//                          and copy "chat":{"id":...}
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID   || '';

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('[telegram] Send failed:', e.message);
  }
}

async function sendDiscordEmbed(embed) {
  if (!process.env.DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Xavier | QuantBot Pro',
        avatar_url: 'https://i.imgur.com/4M34hi2.png',
        embeds: [embed],
      }),
    });
  } catch (err) { console.error('[DISCORD EMBED ERROR]', err.message); }
}

// embed param is optional — Telegram gets plain text, Discord gets rich embed when provided
async function sendNotification(message, embed) {
  if (process.env.TELEGRAM_BOT_TOKEN || (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID)) {
    await sendTelegram(message);
  }
  if (process.env.DISCORD_WEBHOOK_URL) {
    if (embed) {
      await sendDiscordEmbed(embed);
    } else {
      try {
        const plain = message.replace(/<[^>]+>/g, '');
        await fetch(process.env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: plain }),
        });
      } catch (e) { console.error('[discord] Send failed:', e.message); }
    }
  }
}

// ─── ECONOMIC CALENDAR ────────────────────────────────────────────────────────
const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

const PAIR_CURRENCIES = {
  EUR_USD: ['EUR', 'USD'], GBP_USD: ['GBP', 'USD'], USD_JPY: ['USD', 'JPY'],
  AUD_USD: ['AUD', 'USD'], NZD_USD: ['NZD', 'USD'], USD_CAD: ['USD', 'CAD'],
  XAU_USD: ['USD'],        XAG_USD: ['USD'],         EUR_GBP: ['EUR', 'GBP'],
  SPX500_USD: ['USD'],     NAS100_USD: ['USD'],       UK100_GBP: ['GBP'],
  AU200_AUD:  ['AUD'],
};

async function refreshEconomicCalendar() {
  try {
    const r    = await fetch(CALENDAR_URL, { headers: { 'User-Agent': 'QuantBot/1.0' } });
    const data = await r.json();
    if (!Array.isArray(data)) return;
    economicEvents = data
      .filter(e => e.impact === 'High')
      .map(e => ({
        time:     new Date(e.date).getTime(),
        currency: e.currency,
        title:    e.title || e.event || '',
      }))
      .filter(e => !isNaN(e.time));
    console.log(`[calendar] Loaded ${economicEvents.length} high-impact events`);
  } catch (e) {
    console.error('[calendar] Fetch failed:', e.message);
  }
}

function isNewsWindow(instrument) {
  if (economicEvents.length === 0) return false;
  const now        = Date.now();
  const currencies = PAIR_CURRENCIES[instrument] || [];
  const windowMs   = (xavierWeights.newsWindowMins || 120) * 60_000;
  for (const ev of economicEvents) {
    const diff = ev.time - now;
    if (diff > windowMs) continue;        // event is beyond current news window
    if (diff < -60 * 60_000) continue;    // event was > 1h ago — dust settled
    if (currencies.includes(ev.currency)) return true;
  }
  return false;
}

// ─── OANDA TRADE MANAGEMENT HELPERS ──────────────────────────────────────────
async function updateTradeSL(tradeId, newSLPrice, instrument) {
  const price = formatPrice(newSLPrice, instrument);
  try {
    const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/trades/${tradeId}/orders`, {
      method: 'PUT', headers: H,
      body: JSON.stringify({ stopLoss: { price, timeInForce: 'GTC' } }),
    });
    const data = await r.json();
    if (data.stopLossOrderTransaction || data.relatedTransactionIDs) {
      console.log(`[mgmt] Trade ${tradeId} SL → ${price}`);
      return true;
    }
    console.error('[mgmt] SL update unexpected response:', JSON.stringify(data).slice(0, 200));
    return false;
  } catch (e) {
    console.error('[mgmt] updateTradeSL error:', e.message);
    return false;
  }
}

// Fresh OANDA check — used as a final duplicate guard before any order is placed
async function hasOpenPosition(instrument) {
  try {
    const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/openTrades`, { headers: H });
    const data = await r.json();
    return (data.trades || []).some(t => t.instrument === instrument);
  } catch {
    return false; // fail open — OANDA is the final backstop
  }
}

async function partialCloseTrade(tradeId, units) {
  try {
    const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/trades/${tradeId}/close`, {
      method: 'PUT', headers: H,
      body: JSON.stringify({ units: String(Math.abs(units)) }),
    });
    const data = await r.json();
    if (data.orderFillTransaction) {
      const fill = parseFloat(data.orderFillTransaction.price || 0);
      const pnl  = parseFloat(data.orderFillTransaction.pl   || 0);
      console.log(`[mgmt] Trade ${tradeId} partial ${units} units @ ${fill} P&L: ${pnl}`);
      return { fill, pnl };
    }
    console.error('[mgmt] Partial close failed:', JSON.stringify(data).slice(0, 200));
    return null;
  } catch (e) {
    console.error('[mgmt] partialCloseTrade error:', e.message);
    return null;
  }
}

// ─── OPEN TRADE MANAGER (runs every 10s) ─────────────────────────────────────
async function manageOpenTrades() {
  if (process.env.AUTO_MODE_ENABLED !== 'true') return;

  let openTrades = [];
  try {
    const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/openTrades`, { headers: H });
    const data = await r.json();
    openTrades = data.trades || [];
  } catch (e) {
    console.error('[mgmt] Open trades fetch failed:', e.message);
    return;
  }

  // ── Detect closed trades (auto + manual) ────────────────────────────────────
  const currentIds = new Set(openTrades.map(t => t.id));
  for (const id of lastKnownTradeIds) {
    if (!currentIds.has(id)) {
      // Always fetch the closed trade to get instrument — handles manual closes too
      try {
        const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/trades/${id}`, { headers: H });
        const data = await r.json();
        const trade = data.trade;
        if (trade) {
          const pnl   = parseFloat(trade.realizedPL || 0);
          const instr = trade.instrument;
          const dir   = parseFloat(trade.initialUnits || 1) >= 0 ? 'LONG' : 'SHORT';
          const won   = pnl > 0;

          // Post-close cooldown — always set on any close, including manual
          postCloseCooldown.set(instr, Date.now());
          console.log(`[COOLDOWN] ${instr} — locked 15 min after close (PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`);

          // Update daily stats (only for Xavier-managed closes)
          if (tradeManagementState.has(id)) {
            const today = new Date().toISOString().slice(0, 10);
            if (dailyStats.date !== today) {
              dailyStats = { date: today, trades: 0, winners: 0, losers: 0, totalPnl: 0, bestTrade: '', _bestPnl: -Infinity };
            }
            dailyStats.trades++;
            if (won) dailyStats.winners++; else dailyStats.losers++;
            dailyStats.totalPnl += pnl;
            if (pnl > dailyStats._bestPnl) {
              dailyStats._bestPnl   = pnl;
              dailyStats.bestTrade  = `${instr.replace('_', '/')} ${dir} +$${pnl.toFixed(2)}`;
            }
          }

          const isManual = !tradeManagementState.has(id);
          const emoji = won ? '✅' : '❌';
          const closeMsg =
            `${emoji} <b>TRADE CLOSED${isManual ? ' (manual)' : ''}</b>\n` +
            `Pair: ${instr.replace('_', '/')} ${dir}\n` +
            `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n` +
            (isManual ? `⚠️ Manual close — cooldown set` : `Today: ${dailyStats.winners}W/${dailyStats.losers}L · Net $${dailyStats.totalPnl.toFixed(2)}`);
          await sendNotification(closeMsg, {
            color: won ? 0x3fb950 : 0xf85149,
            title: `${emoji} Trade Closed${isManual ? ' (Manual)' : ''}`,
            fields: [
              { name: 'Pair',      value: instr.replace('_', '/'), inline: true },
              { name: 'Direction', value: dir,                      inline: true },
              { name: 'P&L',       value: `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, inline: true },
              ...(isManual
                ? [{ name: 'Note', value: '⚠️ Manual close — cooldown set', inline: false }]
                : [{ name: 'Today', value: `${dailyStats.winners}W / ${dailyStats.losers}L · Net $${dailyStats.totalPnl.toFixed(2)}`, inline: false }]
              ),
            ],
            timestamp: new Date().toISOString(),
          });
        }
      } catch (e) {
        console.error('[mgmt] Closed trade fetch failed:', e.message);
      }
      tradeManagementState.delete(id);
      lastKnownTradeIds.delete(id);
    }
  }
  // Update known IDs with current open trades
  for (const t of openTrades) lastKnownTradeIds.add(t.id);

  // ── Manage each open trade ──────────────────────────────────────────────────
  for (const trade of openTrades) {
    const tradeId    = trade.id;
    const instrument = trade.instrument;
    const units      = parseFloat(trade.currentUnits);
    const dir        = units > 0 ? 'LONG' : 'SHORT';
    const entry      = parseFloat(trade.price);
    const sl         = trade.stopLossOrder?.price ? parseFloat(trade.stopLossOrder.price) : null;

    if (!sl) continue;
    const risk = Math.abs(entry - sl);
    if (risk <= 0) continue;

    // Fetch live mid price
    let price = 0;
    try {
      const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/pricing?instruments=${instrument}`, { headers: H });
      const data = await r.json();
      const px   = data.prices?.[0];
      if (!px) continue;
      price = (parseFloat(px.bids[0].price) + parseFloat(px.asks[0].price)) / 2;
    } catch { continue; }

    const priceDelta = dir === 'LONG' ? price - entry : entry - price;
    const currentR   = priceDelta / risk;

    if (!tradeManagementState.has(tradeId)) {
      tradeManagementState.set(tradeId, { movedToBreakeven: false, partialClosed: false, peakR: 0 });
    }
    const state   = tradeManagementState.get(tradeId);
    state.peakR   = Math.max(state.peakR, currentR);

    // Pair-specific trail settings
    const trail = TRAIL_SETTINGS[instrument] || TRAIL_SETTINGS.default;

    // ── 1R reached: move to breakeven ────────────────────────────────────────
    if (currentR >= 1.0 && !state.movedToBreakeven) {
      const pip     = SERVER_PIP_SIZE[instrument] || 0.0001;
      const bePrice = dir === 'LONG' ? entry + pip : entry - pip;
      const moved   = await updateTradeSL(tradeId, bePrice, instrument);
      if (moved) {
        state.movedToBreakeven = true;
        await sendNotification(
          `🛡 <b>BREAKEVEN</b>\n` +
          `${instrument.replace('_', '/')} ${dir}\n` +
          `SL → ${formatPrice(bePrice, instrument)} (entry +1pip)\n` +
          `Current: +${currentR.toFixed(2)}R`,
          {
            color: 0x0088ff,
            title: '🛡 Breakeven Locked',
            fields: [
              { name: 'Pair',          value: instrument.replace('_', '/'), inline: true },
              { name: 'Direction',     value: dir,                          inline: true },
              { name: 'Reached',       value: `+${currentR.toFixed(2)}R`,  inline: true },
              { name: 'Stop Moved To', value: `${formatPrice(bePrice, instrument)} (entry +1pip)`, inline: false },
            ],
            timestamp: new Date().toISOString(),
          }
        );
      }
    }

    // ── 1R reached: partial close 33% (keep 67% running toward 2R/3R) ────────
    if (currentR >= 1.0 && !state.partialClosed) {
      const thirdUnits = Math.round(Math.abs(units) * 0.33);
      if (thirdUnits > 0) {
        const result = await partialCloseTrade(tradeId, thirdUnits);
        if (result) {
          state.partialClosed = true;
          await sendNotification(
            `💰 <b>PARTIAL CLOSE 33%</b>\n` +
            `${instrument.replace('_', '/')} ${dir}\n` +
            `Closed ${thirdUnits} units @ ${formatPrice(result.fill, instrument)}\n` +
            `Locked: ${result.pnl >= 0 ? '+' : ''}$${result.pnl.toFixed(2)}\n` +
            `67% still running`
          );
        }
      }
    }

    // ── Trail stop: pair-specific startR and trailR ───────────────────────────
    // Commodities (XAG, BCO, WTICO, XAU): start at 1.5R, trail 0.3R behind
    // Forex/indices: start at 2.0R, trail 0.5R behind
    if (currentR >= trail.startR) {
      const trailPrice = dir === 'LONG'
        ? entry + risk * (currentR - trail.trailR)
        : entry - risk * (currentR - trail.trailR);
      const currentSL  = parseFloat(trade.stopLossOrder?.price || sl);
      const improving   = dir === 'LONG'
        ? trailPrice > currentSL + risk * 0.05
        : trailPrice < currentSL - risk * 0.05;
      if (improving) {
        await updateTradeSL(tradeId, trailPrice, instrument);
        console.log(`[TRAIL] ${instrument} ${dir} — SL → ${formatPrice(trailPrice, instrument)} (+${currentR.toFixed(2)}R)`);
      }
    }
  }
}

// ─── DAILY SUMMARY ────────────────────────────────────────────────────────────
async function maybeSendDailySummary() {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() !== 0 || now.getUTCMinutes() > 1) return;
  if (lastDailySummaryDate === today) return;
  lastDailySummaryDate = today;

  const yesterday = dailyStats.date;
  if (!yesterday || dailyStats.trades === 0) {
    await sendNotification(`📊 <b>DAILY SUMMARY</b>\nNo trades executed yesterday.`);
    return;
  }
  const winRate = ((dailyStats.winners / dailyStats.trades) * 100).toFixed(0);
  await sendNotification(
    `📊 <b>DAILY SUMMARY — ${yesterday}</b>\n` +
    `Trades: ${dailyStats.trades} (${dailyStats.winners}W/${dailyStats.losers}L · ${winRate}%)\n` +
    `Net P&L: ${dailyStats.totalPnl >= 0 ? '+' : ''}$${dailyStats.totalPnl.toFixed(2)}\n` +
    `Best: ${dailyStats.bestTrade || '—'}`
  );
}

// ─── SERVER-SIDE AUTO TRADE ENGINE ────────────────────────────────────────────
function getServerSession() {
  const now = new Date();
  const h   = now.getUTCHours();
  const d   = now.getUTCDay();
  if (d === 6 || (d === 0 && h < 22)) return 'AVOID';
  if (h >= 22 || h < 4)  return 'SYDNEY';
  if (h >= 4  && h < 8)  return 'TOKYO';
  if (h >= 8  && h < 13) return 'LONDON';
  if (h >= 13 && h < 17) return 'PRIME';
  if (h >= 17 && h < 20) return 'NY';
  return 'AVOID';
}

async function getM5History(instrument) {
  const cached = m5History.get(instrument);
  const age    = Date.now() - (lastM5Fetch.get(instrument) || 0);
  if (cached && cached.length >= 20 && age < 4 * 60_000) return cached;
  try {
    const r    = await fetch(`${BASE}/v3/instruments/${instrument}/candles?count=60&granularity=M5&price=M`, { headers: H });
    const data = await r.json();
    if (!Array.isArray(data.candles)) return cached || [];
    const closes = data.candles.filter(c => c.mid?.c).map(c => parseFloat(c.mid.c)).filter(v => v > 0 && !isNaN(v));
    if (closes.length >= 5) {
      m5History.set(instrument, closes);
      lastM5Fetch.set(instrument, Date.now());
      return closes;
    }
    return cached || [];
  } catch {
    return cached || [];
  }
}

// OHLC candle cache for trend confirmation (open + close per bar)
const m5OhlcCache    = new Map(); // instrument → [{open, close}]
const lastM5OhlcFetch = new Map(); // instrument → ms timestamp

async function getM5Candles(instrument) {
  const cached = m5OhlcCache.get(instrument);
  const age    = Date.now() - (lastM5OhlcFetch.get(instrument) || 0);
  if (cached && cached.length >= 20 && age < 4 * 60_000) return cached;
  try {
    const r    = await fetch(`${BASE}/v3/instruments/${instrument}/candles?count=60&granularity=M5&price=M`, { headers: H });
    const data = await r.json();
    if (!Array.isArray(data.candles)) return cached || [];
    const candles = data.candles
      .filter(c => c.mid?.o && c.mid?.c)
      .map(c => ({ open: parseFloat(c.mid.o), close: parseFloat(c.mid.c) }))
      .filter(c => c.open > 0 && c.close > 0);
    if (candles.length >= 5) {
      m5OhlcCache.set(instrument, candles);
      lastM5OhlcFetch.set(instrument, Date.now());
      return candles;
    }
    return cached || [];
  } catch {
    return cached || [];
  }
}

function serverGenerateSignal(history, strategy, instrument) {
  if (history.length < 20) return null;
  const recent = history.slice(-20);
  const ema9   = recent.slice(-9).reduce((a, b) => a + b, 0) / 9;
  const ema21  = recent.reduce((a, b) => a + b, 0) / 20;
  const last   = recent[recent.length - 1];
  const prev   = recent[recent.length - 2];
  const change = (last - recent[0]) / recent[0];
  let score = 0, direction = null, reason = [];

  if (strategy === 'Trend Follow') {
    if      (ema9 > ema21 && last > ema9) { score += 40; direction = 'LONG';  reason.push('EMA bullish cross'); }
    else if (ema9 < ema21 && last < ema9) { score += 40; direction = 'SHORT'; reason.push('EMA bearish cross'); }
    if      (change >  0.003)             { score += 25; direction = direction || 'LONG';  reason.push('Strong uptrend');   }
    else if (change < -0.003)             { score += 25; direction = direction || 'SHORT'; reason.push('Strong downtrend'); }
  } else if (strategy === 'Mean Revert') {
    const mean     = recent.reduce((a, b) => a + b, 0) / recent.length;
    const dev      = Math.abs(last - mean) / mean;
    const isSilver = instrument.includes('XAG');
    const isGold   = instrument.includes('XAU');
    const isOil    = instrument.includes('BCO') || instrument.includes('WTICO');
    const isJpy    = instrument.includes('JPY');
    // Silver moves 10× faster — needs proportionally wider deviation thresholds
    const t1 = isSilver ? 0.004 : isOil ? 0.003 : isGold ? 0.0008 : isJpy ? 0.0015 : 0.001;
    const t2 = isSilver ? 0.008 : isOil ? 0.006 : isGold ? 0.0015 : isJpy ? 0.003  : 0.002;
    const t3 = isSilver ? 0.015 : isOil ? 0.012 : isGold ? 0.003  : isJpy ? 0.005  : 0.004;
    if (dev > t1) {
      const dir = last > mean ? 'SHORT' : 'LONG';
      score += 50;
      if (dev > t2) score += 10;
      if (dev > t3) score += 10;
      if ((dir === 'LONG' && last > prev) || (dir === 'SHORT' && last < prev)) score += 10;
      direction = dir;
      reason.push(`${(dev * 100).toFixed(2)}% deviation`);
    }
    if (direction) {
      const tr20  = recent.slice(1).map((p, i) => Math.abs(p - recent[i]));
      const atr20 = tr20.reduce((a, b) => a + b, 0) / tr20.length || 0.00001;
      const atr5n = tr20.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const atr5p = tr20.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
      const mean2 = recent.reduce((a, b) => a + b, 0) / recent.length;
      const dev2  = Math.abs(last - mean2) / mean2;
      if (atr5p > atr20 * 2.0 && atr5n < atr5p * 0.85 && dev2 > 0.0015) {
        score += 10; reason.push('Post-spike reversion');
      }
    }
  } else if (strategy === 'Breakout') {
    const high = Math.max(...recent), low = Math.min(...recent), range = high - low;
    if      (last > high - range * 0.05) { score += 45; direction = 'LONG';  reason.push('Near range high'); }
    else if (last < low  + range * 0.05) { score += 45; direction = 'SHORT'; reason.push('Near range low');  }
    if (direction) {
      const tr      = recent.slice(1).map((p, i) => Math.abs(p - recent[i]));
      const atr5    = tr.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const atrFull = tr.reduce((a, b) => a + b, 0) / tr.length;
      if (atr5 > atrFull * 1.1)                  { score += 10; reason.push('ATR expanding'); }
      if (Math.abs(last - prev) > atrFull * 1.5) { score += 10; reason.push('Strong thrust'); }
      const sess = getServerSession();
      if (sess === 'PRIME' || sess === 'LONDON')  { score += 5;  reason.push(`${sess} session`); }
    }
  } else if (strategy === 'Momentum') {
    const momentum = (last - recent[recent.length - 10]) / recent[recent.length - 10];
    if (Math.abs(momentum) >= 0.004) {
      direction = momentum > 0 ? 'LONG' : 'SHORT';
      score += 55;
      reason.push(`${(momentum * 100).toFixed(2)}% momentum`);
      if (Math.abs(momentum) > 0.006)                                                        { score += 10; reason.push('Strong momentum'); }
      if ((direction === 'LONG' && ema9 > ema21) || (direction === 'SHORT' && ema9 < ema21)) { score += 5;  reason.push('EMA confirms'); }
      const sess = getServerSession();
      if (sess === 'NY' || sess === 'PRIME')                                                  { score += 5;  reason.push(`${sess} session`); }
    }
  }

  if (!direction) return null;

  const rsi = 50 + (change / 0.01) * 20;
  if (strategy === 'Momentum') {
    if (direction === 'LONG'  && rsi > 55) { score += 15; reason.push('RSI momentum confirm'); }
    if (direction === 'SHORT' && rsi < 45) { score += 15; reason.push('RSI momentum confirm'); }
  } else {
    if (direction === 'LONG'  && rsi < 45) { score += 15; reason.push('RSI oversold'); }
    if (direction === 'SHORT' && rsi > 55) { score += 15; reason.push('RSI overbought'); }
  }

  score = Math.min(score, 100);
  if (score < 65) return null;
  const isSilverInst = instrument.includes('XAG');
  const isOilInst    = instrument.includes('BCO') || instrument.includes('WTICO');
  const minHold      = isSilverInst ? 30 : isOilInst ? 20 : 5;
  return { direction, score, reason, rsi: parseFloat(rsi.toFixed(1)), minHold };
}

// ─── TREND CONFIRMATION (USER EXPLICIT OVERRIDE) ─────────────────────────────
// Runs before consensus. Forex requires 2/3 checks. Indices require 1/3 (mixed candles normal).
//   1. Last 3 M5 candles close in signal direction (bullish/bearish bodies)
//   2. Price moved > 0.1% over last 10 bars (not flat)
//   3. EMA9 pulling away from EMA21 by > 0.02%
function calcEMAFromArr(arr, period) {
  if (arr.length < period) return arr.reduce((a, b) => a + b, 0) / arr.length;
  const k   = 2 / (period + 1);
  let   ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) ema = arr[i] * k + ema * (1 - k);
  return ema;
}

const INDEX_INSTRUMENTS = new Set(['JP225_USD', 'NAS100_USD', 'SPX500_USD', 'UK100_GBP', 'AU200_AUD']);

function confirmTrend(candles, direction, instrument = '') {
  if (candles.length < 10) return false;
  const len    = candles.length;
  const last3  = candles.slice(len - 3, len);
  const last10 = candles.slice(len - 10, len);

  // Check 1 — last 3 candles have bodies in signal direction
  const last3Confirm = direction === 'LONG'
    ? last3.every(c => c.close > c.open)
    : last3.every(c => c.close < c.open);

  // Check 2 — price is moving (not flat) over last 10 bars
  const priceChange = Math.abs(last10[last10.length - 1].close - last10[0].close) / last10[0].close;
  const isMoving    = priceChange > 0.001;

  // Check 3 — true EMA9 separating from EMA21
  const closes        = candles.map(c => c.close);
  const ema9          = calcEMAFromArr(closes, 9);
  const ema21         = calcEMAFromArr(closes, 21);
  const emaSeparating = direction === 'LONG'
    ? ema9 > ema21 * 1.0002
    : ema9 < ema21 * 0.9998;

  const confirmCount   = [last3Confirm, isMoving, emaSeparating].filter(Boolean).length;
  // Indices move in waves — mixed candles normal. Price movement alone sufficient.
  const trendThreshold = INDEX_INSTRUMENTS.has(instrument) ? 1 : 2;
  const passed         = confirmCount >= trendThreshold;
  console.log(`[TREND] ${instrument} ${direction} | last3:${last3Confirm} moving:${isMoving}(${(priceChange * 100).toFixed(3)}%) emaSep:${emaSeparating} → ${passed ? 'CONFIRMED ✓' : 'WAIT'} (${confirmCount}/3 threshold:${trendThreshold})`);
  return passed;
}

function serverRunGatekeepers(history, signal, openTrades, _instrument, strategy) {
  const rejections     = [];
  const session        = getServerSession();
  const scoreThreshold = xavierWeights.scoreThreshold || 65;

  if (session === 'AVOID') {
    rejections.push({ condition: 'Patience (Principle 9)', reason: 'Dead zone — elite traders know when NOT to trade.' });
    return { passed: false, rejections };
  }
  if (signal.score < scoreThreshold) {
    rejections.push({ condition: 'Opportunity Selection (Principle 38)', actual: `${signal.score}%`, threshold: `${scoreThreshold}%`, reason: 'Below confidence threshold — waiting for next setup.' });
  }
  if (openTrades.length >= 2) {
    rejections.push({ condition: 'Position limit', actual: `${openTrades.length} open`, threshold: 'Max 2' });
  }
  const heat = openTrades.length * 1.5;
  if (heat >= 4) {
    rejections.push({ condition: 'Drawdown Control (Principle 8)', actual: `${heat.toFixed(1)}R`, threshold: '4R max', reason: 'Capital Preservation first.' });
  }
  if (history.length >= 21) {
    const bars  = history.slice(-21);
    const tr    = bars.slice(1).map((p, i) => Math.abs(p - bars[i]));
    const atr5  = tr.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const atr20 = tr.reduce((a, b) => a + b, 0) / tr.length || atr5;
    if (atr20 > 0 && atr5 > atr20 * 2.5) {
      rejections.push({ condition: 'Volatility Adaptation (Principle 16)', actual: `${(atr5 / atr20).toFixed(1)}×`, threshold: '< 2.5×', reason: 'ATR spiking — not entering noise.' });
    }
  }
  if (strategy === 'Trend Follow' && history.length >= 50) {
    const ema50  = history.slice(-50).reduce((a, b) => a + b, 0) / 50;
    const last   = history[history.length - 1];
    const biasOk = signal.direction === 'LONG' ? last > ema50 : last < ema50;
    if (!biasOk) {
      rejections.push({ condition: 'EMA50 bias', actual: `Price ${signal.direction === 'LONG' ? 'below' : 'above'} EMA50`, threshold: 'Wrong side' });
    }
  }
  return { passed: rejections.length === 0, rejections };
}

async function serverAutoTrade() {
  lastScanAt = Date.now();
  if (process.env.AUTO_MODE_ENABLED !== 'true') return;

  const session = getServerSession();
  const rule    = XAVIER_RULES[session];
  if (!rule?.strategy || rule.pairs.length === 0) {
    console.log(`[auto] ${session} — AVOID, no trades`);
    return;
  }

  const { strategy } = rule;
  const forexPairs = rule.pairs.filter(p => SERVER_PAIRS.has(p));
  const indexPairs = [...INDEX_PAIRS].filter(p => isHomeSession(p, session));
  const pairs      = [...forexPairs, ...indexPairs];
  if (pairs.length === 0) return;
  const ts = new Date().toISOString();

  let openTrades = [];
  try {
    const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/openTrades`, { headers: H });
    const data = await r.json();
    openTrades = data.trades || [];
  } catch (e) {
    console.error(`[auto] Open trades fetch failed: ${e.message}`);
    return;
  }

  if (openTrades.length >= 2) {
    console.log(`[auto] ${session} — ${openTrades.length} open trades, skipping scan`);
    return;
  }

  // ── Race-free cooldown detection ─────────────────────────────────────────────
  // manageOpenTrades() sets postCloseCooldown but runs on its own 10s interval.
  // If serverAutoTrade fires in the gap between a close and management detecting it,
  // the cooldown won't be set yet. Self-detect by comparing to last-seen open instruments.
  const currentOpenInstruments = new Set(openTrades.map(t => t.instrument));
  for (const instr of serverAutoTradeOpenInstr) {
    if (!currentOpenInstruments.has(instr)) {
      postCloseCooldown.set(instr, Date.now());
      console.log(`[COOLDOWN SET] ${instr} — detected close in auto-trade loop, cooldown locked (race-free)`);
    }
  }
  serverAutoTradeOpenInstr.clear();
  for (const instr of currentOpenInstruments) serverAutoTradeOpenInstr.add(instr);

  for (const instrument of pairs) {
    // Consensus cooldown — 15 minutes between signal attempts per pair
    if (Date.now() - (lastConsensus.get(instrument) || 0) < 15 * 60_000) continue;

    // Post-close cooldown — 15 minutes after any close on this instrument
    const lastClose = postCloseCooldown.get(instrument);
    const cooldownMinsLeft = lastClose ? Math.ceil((POST_CLOSE_COOLDOWN_MS - (Date.now() - lastClose)) / 60000) : 0;
    console.log(`[COOLDOWN CHECK] ${instrument} — ${lastClose ? `last close ${Math.round((Date.now() - lastClose) / 60000)} min ago, ${cooldownMinsLeft > 0 ? cooldownMinsLeft + ' min remaining' : 'CLEAR'}` : 'no recent close'}`);
    if (lastClose && Date.now() - lastClose < POST_CLOSE_COOLDOWN_MS) {
      console.log(`[COOLDOWN] ${instrument} — ${cooldownMinsLeft} min remaining before re-entry allowed`);
      continue;
    }

    // Cross-system pair lock — one position per instrument across M5 + swing
    if (openTrades.some(t => t.instrument === instrument)) {
      console.log(`[PAIR LOCK] ${instrument} already open in another timeframe — skipping M5`);
      serverRejections.unshift({ ts, instrument, direction: '?', score: 0, session, strategy, rejections: [{ condition: 'Pair Lock', actual: `${instrument} already open`, threshold: 'One position per pair across all systems' }] });
      if (serverRejections.length > 50) serverRejections.pop();
      continue;
    }

    // Upgrade 2 — news guard
    if (isNewsWindow(instrument)) {
      console.log(`[auto] ${instrument} — NEWS BLOCK (high-impact event ±2h)`);
      serverRejections.unshift({ ts, instrument, direction: '?', score: 0, session, strategy, rejections: [{ condition: 'Information Filtering (Principle 33)', actual: `High-impact event ±${xavierWeights.newsWindowMins || 120}min`, threshold: 'No trading', reason: 'Standing down.' }] });
      if (serverRejections.length > 50) serverRejections.pop();
      await sendNotification(
        `📰 <b>NEWS BLOCK</b>\n${instrument.replace('_', '/')} — high-impact event within ±${xavierWeights.newsWindowMins || 120}min\nSession: ${session}`,
        {
          color: 0xffaa00,
          title: '📰 News Block — Standing Down',
          fields: [
            { name: 'Pair',     value: instrument.replace('_', '/'), inline: true },
            { name: 'Window',   value: `±${xavierWeights.newsWindowMins || 120} min`, inline: true },
            { name: 'Session',  value: session, inline: true },
            { name: 'Resumes',  value: 'After news window clears', inline: false },
          ],
          timestamp: new Date().toISOString(),
          footer: { text: 'Information Filtering — Principle 33' },
        }
      );
      continue;
    }

    const history = await getM5History(instrument);
    if (history.length < 20) {
      console.log(`[auto] ${instrument} — insufficient M5 history (${history.length} bars)`);
      continue;
    }

    let price = 0, spread = 0;
    try {
      const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/pricing?instruments=${instrument}`, { headers: H });
      const data = await r.json();
      const px   = data.prices?.[0];
      if (!px) continue;
      const bid = parseFloat(px.bids[0].price);
      const ask = parseFloat(px.asks[0].price);
      price  = (bid + ask) / 2;
      spread = ask - bid;
    } catch { continue; }

    // Silver session gate — London/Prime/NY only (thin Asian liquidity widens spreads)
    if (instrument === 'XAG_USD' && !XAG_ALLOWED_SESSIONS.has(session)) {
      console.log(`[XAG BLOCK] Silver only trades London/Prime/NY — ${session} skipped`);
      continue;
    }
    // Oil session gate
    if ((instrument === 'BCO_USD' || instrument === 'WTICO_USD') && !OIL_ALLOWED_SESSIONS.has(session)) {
      console.log(`[OIL BLOCK] Oil only trades London/Prime/NY — ${session} skipped`);
      continue;
    }
    // Silver spread gate (5 cents max)
    if (instrument === 'XAG_USD' && spread > XAG_MAX_SPREAD) {
      console.log(`[XAG BLOCK] Spread too wide: ${spread.toFixed(4)} > ${XAG_MAX_SPREAD} — skipping`);
      continue;
    }
    // Oil spread gate (8 cents max)
    if ((instrument === 'BCO_USD' || instrument === 'WTICO_USD') && spread > OIL_MAX_SPREAD) {
      console.log(`[OIL BLOCK] Spread too wide: ${spread.toFixed(4)} — skipping`);
      continue;
    }

    const liveHistory = [...history, price];
    const signal = serverGenerateSignal(liveHistory, strategy, instrument);

    if (!signal) {
      console.log(`[auto] ${instrument} — no ${strategy} signal`);
      continue;
    }

    // High-threshold pairs (commodities + indices) require 75% conviction
    if (HIGH_THRESHOLD_PAIRS.has(instrument) && signal.score < 75) {
      console.log(`[HIGH-THRESH] ${instrument} — score ${signal.score}% < 75% required for volatile asset`);
      continue;
    }

    console.log(`[auto] ${instrument} ${signal.direction} ${signal.score}% — ${strategy} — gatekeeping`);

    // Signal detected alert — fires for all signals >= 60% before any gate
    if (signal.score >= 60) {
      await sendDiscordEmbed({
        title: '👁 Signal Detected',
        color: 0x8B5CF6,
        fields: [
          { name: 'Pair',      value: instrument.replace('_', '/'), inline: true },
          { name: 'Direction', value: signal.direction,             inline: true },
          { name: 'Score',     value: `${signal.score}%`,          inline: true },
          { name: 'Strategy',  value: strategy,                     inline: true },
          { name: 'Session',   value: session,                      inline: true },
          { name: 'Status',    value: 'Evaluating gates…',          inline: true },
        ],
        timestamp: new Date().toISOString(),
      });
    }

    const gate = serverRunGatekeepers(liveHistory, signal, openTrades, instrument, strategy);
    if (!gate.passed) {
      const reasons = gate.rejections.map(r => r.condition).join(', ');
      console.log(`[auto] ${instrument} — BLOCKED: ${reasons}`);
      serverRejections.unshift({ ts, instrument, direction: signal.direction, score: signal.score, session, strategy, rejections: gate.rejections });
      if (serverRejections.length > 50) serverRejections.pop();
      if (signal.score >= 60) {
        const hasScoreBlock = gate.rejections.some(r => r.condition.includes('Opportunity Selection'));
        const hasHeatBlock  = gate.rejections.some(r => r.condition.includes('Position limit') || r.condition.includes('Drawdown Control'));
        if (hasScoreBlock) {
          const threshold = xavierWeights.scoreThreshold || 65;
          await sendDiscordEmbed({
            title: '⚠️ Signal Blocked — Low Score',
            color: 0xffaa00,
            fields: [
              { name: 'Pair',     value: instrument.replace('_', '/'), inline: true },
              { name: 'Score',    value: `${signal.score}%`,           inline: true },
              { name: 'Required', value: `${threshold}%`,              inline: true },
            ],
            timestamp: new Date().toISOString(),
          });
        } else if (hasHeatBlock) {
          await sendDiscordEmbed({
            title: '🔒 Signal Locked — Heat Limit',
            color: 0xffaa00,
            fields: [
              { name: 'Pair',        value: instrument.replace('_', '/'),   inline: true },
              { name: 'Open Trades', value: `${openTrades.length}/2`,       inline: true },
              { name: 'Reason',      value: 'Max trades reached',           inline: true },
            ],
            timestamp: new Date().toISOString(),
          });
        }
      }
      continue;
    }

    // Trend confirmation — 2/3 for forex, 1/3 for indices (mixed candles normal)
    const m5Candles = await getM5Candles(instrument);
    const trendOk   = confirmTrend(
      [...m5Candles, { open: price, close: price }],
      signal.direction,
      instrument,
    );
    if (!trendOk) {
      const threshold = INDEX_INSTRUMENTS.has(instrument) ? '1/3' : '2/3';
      console.log(`[TREND WAIT] ${instrument} — signal ${signal.score}% detected but trend not confirmed yet. Waiting for momentum to develop.`);
      serverRejections.unshift({ ts, instrument, direction: signal.direction, score: signal.score, session, strategy, rejections: [{ condition: 'Trend Not Confirmed', actual: `< ${threshold} checks (last3 candles, price moving, EMA separating)`, threshold: `${threshold} required` }] });
      if (serverRejections.length > 50) serverRejections.pop();
      await sendDiscordEmbed({
        title: '⏳ Signal Waiting — Trend',
        color: 0x0088ff,
        fields: [
          { name: 'Pair',      value: instrument.replace('_', '/'),   inline: true },
          { name: 'Score',     value: `${signal.score}%`,             inline: true },
          { name: 'Reason',    value: 'Trend not confirmed yet',      inline: true },
        ],
        timestamp: new Date().toISOString(),
      });
      continue;
    }
    console.log(`[TREND CONFIRMED] ${instrument} ${signal.direction} — trend active, proceeding to consensus`);

    // ── Macro trend filter — LONG trades only ──────────────────────────────────
    // SHORT logic is working well — untouched.
    if (signal.direction === 'LONG') {
      const ema50check = liveHistory.length >= 50
        ? liveHistory.slice(-50).reduce((a, b) => a + b, 0) / 50
        : liveHistory.slice(-21).reduce((a, b) => a + b, 0) / 21;

      // Condition 1: price is above EMA50 (pair in uptrend on M5)
      const c1_ema50Up = price > ema50check;

      // Condition 2: weekly bias — EMA50 of last 50 bars is rising vs earlier 50 bars
      // Proxy computed from 60-bar history: new avg [10:60] > old avg [0:50]
      const c2_weeklyBull = liveHistory.length >= 60
        ? (liveHistory.slice(10).reduce((a, b) => a + b, 0) / 50) >
          (liveHistory.slice(0, 50).reduce((a, b) => a + b, 0) / 50)
        : c1_ema50Up; // fallback if history is short

      // Condition 3: Xavier intel is fresh (<60 min) and bullish
      const intelFreshForLong = lastXavierIntel.ts && (Date.now() - lastXavierIntel.ts) < 60 * 60_000;
      const c3_xavierBull     = intelFreshForLong &&
        (lastXavierIntel.sentiment || '').toUpperCase().includes('BULL');

      const condsMet = [c1_ema50Up, c2_weeklyBull, c3_xavierBull].filter(Boolean).length;

      // Currency strength hard filter — USD-sensitive pairs blocked for LONG when USD is strong
      // USD strong = price below EMA50 on EUR/GBP/AUD/NZD vs USD
      const usdStrong = USD_SENSITIVE_PAIRS.has(instrument) && !c1_ema50Up;

      if (condsMet < 2 || usdStrong) {
        const reason = usdStrong
          ? `USD strength regime — ${instrument} below EMA50, LONG blocked`
          : `LONG macro filter: ${condsMet}/3 bullish (EMA50up:${c1_ema50Up} LTbias:${c2_weeklyBull} XavierBull:${c3_xavierBull})`;
        console.log(`[LONG FILTER] ${instrument} LONG blocked — ${reason}`);
        serverRejections.unshift({ ts, instrument, direction: 'LONG', score: signal.score, session, strategy, rejections: [{ condition: 'Macro Long Filter', actual: reason, threshold: '2/3 conditions required (or USD strength override)' }] });
        if (serverRejections.length > 50) serverRejections.pop();
        await sendDiscordEmbed({
          title: '🚫 Signal Blocked — USD Strength',
          color: 0xff4444,
          fields: [
            { name: 'Pair',      value: instrument.replace('_', '/'),                              inline: true },
            { name: 'Direction', value: 'LONG blocked',                                            inline: true },
            { name: 'Reason',    value: usdStrong ? 'USD strength regime' : `${condsMet}/3 macro conditions`, inline: true },
          ],
          timestamp: new Date().toISOString(),
        });
        continue;
      }
      console.log(`[LONG FILTER] ${instrument} LONG cleared — ${condsMet}/3 (EMA50up:${c1_ema50Up} LTbias:${c2_weeklyBull} XavierBull:${c3_xavierBull})`);
    }

    lastConsensus.set(instrument, Date.now());

    const bars      = liveHistory.slice(-21);
    const tr        = bars.slice(1).map((v, i) => Math.abs(v - bars[i]));
    const atr       = tr.reduce((a, b) => a + b, 0) / tr.length || 0.00001;
    const pip       = SERVER_PIP_SIZE[instrument] || 0.0001;
    const slMult    = ATR_SL_MULTIPLIER[instrument] ?? 1.5;
    const tpMult    = ATR_TP_MULTIPLIER[instrument] ?? 3.0;

    // Minimum stop distance — prevents hair-trigger SL on low-ATR candles
    const MIN_STOP_PIPS = {
      EUR_USD: 0.0010, GBP_USD: 0.0012, USD_JPY: 0.10,
      AUD_USD: 0.0010, NZD_USD: 0.0010, USD_CAD: 0.0010,
      EUR_GBP: 0.0008, XAU_USD: 1.50,
    };
    const minStop      = MIN_STOP_PIPS[instrument] ?? 0.0010;
    const rawSlDist    = atr * slMult;
    const actualSlDist = Math.max(rawSlDist, minStop);
    const atrPips      = (actualSlDist / pip).toFixed(1);
    const spreadBuffer = spread * 1.5; // push SL away from market to avoid STOP_LOSS_ON_FILL_LOSS

    const sl = signal.direction === 'LONG'
      ? price - actualSlDist - spreadBuffer
      : price + actualSlDist + spreadBuffer;
    const tp = signal.direction === 'LONG' ? price + atr * tpMult : price - atr * tpMult;

    console.log(`[SL CHECK] ${instrument} dir:${signal.direction} entry:${formatPrice(price, instrument)} sl:${formatPrice(sl, instrument)} dist:${actualSlDist.toFixed(5)} spread:${spread.toFixed(5)} buf:${spreadBuffer.toFixed(5)} atr:${atr.toFixed(5)} mult:${slMult} minStop:${minStop} ${rawSlDist < minStop ? '⚠ MIN ENFORCED' : '✓ ATR'}`);

    // Hard side check before anything else — wrong-side SL caught early
    if (signal.direction === 'LONG' && sl >= price) {
      console.error(`[SL ERROR] ${instrument} LONG stop ${formatPrice(sl, instrument)} is AT or ABOVE entry ${formatPrice(price, instrument)} — aborting`);
      serverRejections.unshift({ ts, instrument, direction: signal.direction, score: signal.score, session, strategy, rejections: [{ condition: 'SL Side Error', actual: `LONG sl=${formatPrice(sl, instrument)} >= entry`, threshold: 'sl must be below entry' }] });
      if (serverRejections.length > 50) serverRejections.pop();
      continue;
    }
    if (signal.direction === 'SHORT' && sl <= price) {
      console.error(`[SL ERROR] ${instrument} SHORT stop ${formatPrice(sl, instrument)} is AT or BELOW entry ${formatPrice(price, instrument)} — aborting`);
      serverRejections.unshift({ ts, instrument, direction: signal.direction, score: signal.score, session, strategy, rejections: [{ condition: 'SL Side Error', actual: `SHORT sl=${formatPrice(sl, instrument)} <= entry`, threshold: 'sl must be above entry' }] });
      if (serverRejections.length > 50) serverRejections.pop();
      continue;
    }
    const ema9v     = liveHistory.slice(-9).reduce((a, b) => a + b, 0) / 9;
    const ema21v    = liveHistory.slice(-21).reduce((a, b) => a + b, 0) / 21;
    const ema50v    = liveHistory.length >= 50 ? liveHistory.slice(-50).reduce((a, b) => a + b, 0) / 50 : ema21v;
    const ema50side = signal.direction === 'LONG' ? (price > ema50v ? 'ABOVE' : 'BELOW') : (price < ema50v ? 'BELOW' : 'ABOVE');
    const heat      = (openTrades.length * 1.5).toFixed(1);

    const intelAgeMins = lastXavierIntel.ts ? Math.round((Date.now() - lastXavierIntel.ts) / 60_000) : null;
    const intelFresh   = intelAgeMins !== null && intelAgeMins < 30;

    // Duplicate guard — fresh OANDA check in case another loop opened this pair since scan started
    if (await hasOpenPosition(instrument)) {
      console.log(`[DUPLICATE GUARD] ${instrument} — already open on OANDA, skipping`);
      continue;
    }

    console.log(`[auto] ${instrument} — calling consensus`);
    let consensus;
    try {
      consensus = await runConsensus({
        instrument, direction: signal.direction, score: signal.score,
        price:          formatPrice(price, instrument),
        change:         signal.priceChange?.toFixed(4) || '0',
        session,        strategy,
        atr:            atr.toFixed(5),
        atrPips,
        sl:             formatPrice(sl, instrument),
        tp:             formatPrice(tp, instrument),
        ema9:           ema9v.toFixed(5),
        ema21:          ema21v.toFixed(5),
        ema50:          ema50v.toFixed(5),
        ema50side,
        regime:         signal.regime || 'RANGING',
        momentum:       signal.momentum?.toFixed(4) || '0',
        heat,
        rr:             (tpMult / slMult).toFixed(1),
        slDistance:     (atr * slMult / pip).toFixed(1),
        tpDistance:     (atr * tpMult / pip).toFixed(1),
        rsi:            signal.rsi?.toFixed(1) || '50',
        closes:         liveHistory.slice(-5).map(v => v.toFixed(5)).join(', '),
        reason:         signal.reason.join(', '),
        headline:       `Auto ${session} scan`,
        newsRisk:       'LOW',
        sessionQuality: (session === 'PRIME' || session === 'LONDON') ? 'PRIME' : 'GOOD',
        xavierSentiment:    intelFresh ? lastXavierIntel.sentiment : null,
        xavierKeyRisk:      intelFresh ? lastXavierIntel.keyRisk   : null,
        xavierBrief:        intelFresh ? lastXavierIntel.brief      : null,
        xavierBestPair:     intelFresh ? lastXavierIntel.bestPair   : null,
        freshNews:          intelFresh ? lastXavierIntel.freshNews  : null,
        xavierIntelAgeMin:  intelAgeMins,
      });
    } catch (e) {
      console.error(`[auto] Consensus error ${instrument}: ${e.message}`);
      continue;
    }

    console.log(`[auto] ${instrument} — consensus ${consensus.votes.confirm}/4 — ${consensus.executeAllowed ? 'EXECUTE' : 'BLOCKED'}`);

    if (!consensus.executeAllowed) {
      serverRejections.unshift({ ts, instrument, direction: signal.direction, score: signal.score, session, strategy, rejections: [{ condition: 'Consensus', actual: `${consensus.votes.confirm}/4`, threshold: '3/4 required' }], models: consensus.models });
      if (serverRejections.length > 50) serverRejections.pop();
      continue;
    }

    const units = signal.direction === 'LONG' ? 1000 : -1000;

    // Pre-flight margin check — prevents INSUFFICIENT_MARGIN rejections
    if (!(await checkMargin(instrument, units, price)).sufficient) continue;

    try {
      // SL sanity check — wrong-side SL causes STOP_LOSS_ON_FILL_LOSS rejection
      const orderPayload = {
        order: {
          type: 'MARKET', instrument, units: String(units),
          timeInForce: 'FOK', positionFill: 'DEFAULT',
          stopLossOnFill:   { price: formatPrice(sl, instrument), timeInForce: 'GTC' },
          takeProfitOnFill: { price: formatPrice(tp, instrument), timeInForce: 'GTC' },
        },
      };
      const r      = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/orders`, { method: 'POST', headers: H, body: JSON.stringify(orderPayload) });
      const result = await r.json();
      const isHalted = JSON.stringify(result).includes('MARKET_HALTED');

      if (isHalted) {
        paperTrades.unshift({ id: Date.now(), type: 'PAPER', instrument, direction: signal.direction, units, price, session, strategy, score: signal.score, consensus: `${consensus.votes.confirm}/4`, timestamp: ts });
        if (paperTrades.length > 100) paperTrades.pop();
        console.log(`[auto] ${instrument} — PAPER logged (market halted)`);
      } else {
        const fill    = result?.orderFillTransaction?.price ?? price.toFixed(5);
        const oandaId = result.orderFillTransaction?.tradeOpened?.tradeID || result.orderFillTransaction?.id || null;
        autoTrades.unshift({ id: Date.now(), timestamp: ts, instrument, direction: signal.direction, units, price: fill, session, strategy, score: signal.score, consensus: consensus.votes, models: consensus.models, oandaOrderId: oandaId });
        if (autoTrades.length > 100) autoTrades.pop();
        serverTradeLog.unshift({ id: oandaId, pair: instrument, direction: signal.direction, strategy, session, score: signal.score, entry: parseFloat(fill), sl: parseFloat(formatPrice(sl, instrument)), tp: parseFloat(formatPrice(tp, instrument)), units, type: 'm5', timestamp: Date.now() });
        if (serverTradeLog.length > 500) serverTradeLog.pop();
        console.log(`[auto] ✓ EXECUTED ${instrument} ${signal.direction} @ ${fill} — ${consensus.votes.confirm}/4 — ${strategy} — ${session}`);
        await sendNotification(
          `⚡ <b>TRADE OPENED</b>\n` +
          `${instrument.replace('_', '/')} ${signal.direction}\n` +
          `Entry: ${formatPrice(parseFloat(fill), instrument)}\n` +
          `SL: ${formatPrice(sl, instrument)} · TP: ${formatPrice(tp, instrument)}\n` +
          `Score: ${signal.score}% · Models: ${consensus.votes.confirm}/4\n` +
          `Strategy: ${strategy} · Session: ${session}`,
          {
            color: 0x00ff88,
            title: '⚡ Trade Opened',
            fields: [
              { name: 'Pair',      value: instrument.replace('_', '/'), inline: true },
              { name: 'Direction', value: signal.direction,             inline: true },
              { name: 'Score',     value: `${signal.score}%`,          inline: true },
              { name: 'Entry',     value: formatPrice(parseFloat(fill), instrument), inline: true },
              { name: 'SL',        value: formatPrice(sl, instrument),  inline: true },
              { name: 'TP',        value: formatPrice(tp, instrument),  inline: true },
              { name: 'Consensus', value: `${consensus.votes.confirm}/4`, inline: true },
              { name: 'Session',   value: session,   inline: true },
              { name: 'Strategy',  value: strategy,  inline: true },
            ],
            timestamp: new Date().toISOString(),
          }
        );
      }
    } catch (e) {
      console.error(`[auto] Order error ${instrument}: ${e.message}`);
    }
  }
}

// ─── KILL SHOT PAIRS ─────────────────────────────────────────────────────────
// BCO_USD removed 2026-05-28 — manual trading only
const KILL_SHOT_PAIRS = ['XAU_USD', 'GBP_USD', 'EUR_USD', 'USD_JPY', 'NAS100_USD'];

// ─── OANDA CANDLE FETCHER (any granularity) ───────────────────────────────────
async function fetchOandaCandles(instrument, granularity, count) {
  const r = await fetch(
    `${BASE}/v3/instruments/${instrument}/candles?count=${count}&granularity=${granularity}&price=M`,
    { headers: H }
  );
  const data = await r.json();
  if (!Array.isArray(data.candles)) return [];
  return data.candles
    .filter(c => c.mid?.c && !c.incomplete)
    .map(c => ({
      o: parseFloat(c.mid.o),
      h: parseFloat(c.mid.h),
      l: parseFloat(c.mid.l),
      c: parseFloat(c.mid.c),
      time: c.time,
    }))
    .filter(c => c.c > 0);
}

// Fetch live mid price from OANDA pricing endpoint
async function fetchLivePrice(instrument) {
  try {
    const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/pricing?instruments=${instrument}`, { headers: H });
    const data = await r.json();
    const px   = data.prices?.[0];
    if (!px) return null;
    return (parseFloat(px.bids[0].price) + parseFloat(px.asks[0].price)) / 2;
  } catch (e) {
    console.error(`[fetchLivePrice] ${instrument} failed: ${e.message}`);
    return null;
  }
}

// ─── H4 SWING SIGNAL GENERATOR ───────────────────────────────────────────────
// Produces a Kill Shot setup if EMA50 bias + EMA21 pullback + RSI zone align.
// Score must reach 75 to qualify. Weekly candles provide optional bonus (+10).
function serverGenerateSwingSignal(h4Candles, weeklyCandles, instrument) {
  if (h4Candles.length < 50) return null;

  const closes = h4Candles.map(c => c.c);
  const last   = closes[closes.length - 1];

  // Simple EMA (window average — consistent with serverGenerateSignal approach)
  const ema21 = closes.slice(-21).reduce((a, b) => a + b, 0) / 21;
  const ema50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;

  // ATR(14) using true range over last 20 bars
  const trArr = [];
  for (let i = Math.max(1, h4Candles.length - 20); i < h4Candles.length; i++) {
    trArr.push(Math.max(
      h4Candles[i].h - h4Candles[i].l,
      Math.abs(h4Candles[i].h - h4Candles[i - 1].c),
      Math.abs(h4Candles[i].l - h4Candles[i - 1].c),
    ));
  }
  const atr = trArr.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trArr.length) || 0.0001;

  // RSI(14)
  const rsiCloses = closes.slice(-15);
  let gains = 0, losses = 0;
  for (let i = 1; i < rsiCloses.length; i++) {
    const diff = rsiCloses[i] - rsiCloses[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / 14, avgLoss = losses / 14;
  const rsi = avgLoss > 0 ? 100 - 100 / (1 + avgGain / avgLoss) : 100;

  // ── Direction: EMA50 macro bias ───────────────────────────────────────────
  let direction, score = 0;
  const reasons = [];

  if      (last > ema50) { direction = 'LONG';  score += 30; reasons.push('Above H4 EMA50'); }
  else if (last < ema50) { direction = 'SHORT'; score += 30; reasons.push('Below H4 EMA50'); }
  else return null;

  // ── EMA21 pullback quality ───────────────────────────────────────────────
  const distToEma21 = Math.abs(last - ema21);
  if      (distToEma21 < atr * 1.0) { score += 30; reasons.push('At EMA21 value zone'); }
  else if (distToEma21 < atr * 2.0) { score += 15; reasons.push('Near EMA21'); }

  // ── EMA21 slope (trend continuation) ────────────────────────────────────
  if (closes.length >= 26) {
    const ema21Prev = closes.slice(-26, -5).reduce((a, b) => a + b, 0) / 21;
    if (direction === 'LONG'  && ema21 > ema21Prev) { score += 10; reasons.push('EMA21 rising'); }
    if (direction === 'SHORT' && ema21 < ema21Prev) { score += 10; reasons.push('EMA21 falling'); }
  }

  // ── RSI zone filter ──────────────────────────────────────────────────────
  if (direction === 'LONG') {
    if      (rsi >= 40 && rsi <= 60) { score += 20; reasons.push(`RSI ${rsi.toFixed(0)} pullback zone`); }
    else if (rsi < 40)               { score += 10; reasons.push(`RSI ${rsi.toFixed(0)} oversold`); }
  } else {
    if      (rsi >= 40 && rsi <= 60) { score += 20; reasons.push(`RSI ${rsi.toFixed(0)} pullback zone`); }
    else if (rsi > 60)               { score += 10; reasons.push(`RSI ${rsi.toFixed(0)} overbought`); }
  }

  // ── Weekly trend alignment (bonus, non-blocking) ─────────────────────────
  if (weeklyCandles && weeklyCandles.length >= 5) {
    const wCloses = weeklyCandles.map(c => c.c);
    const wEma5   = wCloses.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const wLast   = wCloses[wCloses.length - 1];
    if (direction === 'LONG'  && wLast > wEma5) { score += 10; reasons.push('Weekly trend aligned'); }
    if (direction === 'SHORT' && wLast < wEma5) { score += 10; reasons.push('Weekly trend aligned'); }
  }

  score = Math.min(score, 100);
  if (score < 75) return null;

  // ── SL / TP levels (2 ATR risk, 1.5R / 2.5R / 4R targets) ───────────────
  const riskDist = atr * 2.0;
  const sl  = direction === 'LONG' ? last - riskDist : last + riskDist;
  const tp1 = direction === 'LONG' ? last + riskDist * 1.5 : last - riskDist * 1.5;
  const tp2 = direction === 'LONG' ? last + riskDist * 2.5 : last - riskDist * 2.5;
  const tp3 = direction === 'LONG' ? last + riskDist * 4.0 : last - riskDist * 4.0;

  return { direction, score, entry: last, sl, tp1, tp2, tp3, ema21, ema50, rsi, atr, reasons };
}

// ─── SERVER-SIDE SWING CONSENSUS (weighted: Claude MUST confirm + 1 other) ───
async function runSwingConsensus(p) {
  const settled = await Promise.allSettled([
    askClaude(buildClaudeSwingPrompt(p),     SYS_CLAUDE_SWING),
    askGPT(buildGPTSwingPrompt(p),           SYS_GPT_SWING),
    askDeepSeek(buildDeepSeekSwingPrompt(p), SYS_DEEP_SWING),
    askGemini(buildGeminiSwingPrompt(p),     SYS_GEM_SWING),
  ]);
  const NAMES = ['Claude Sonnet', 'GPT-4o', 'DeepSeek', 'Gemini 2.5 Flash'];
  const models = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const raw = r.reason?.message || 'Model unreachable';
    return { name: NAMES[i], verdict: 'REJECT', reason: raw.slice(0, 80) };
  });
  const claudeConfirmed = models[0]?.verdict === 'CONFIRM';
  const othersConfirmed = models.slice(1).filter(m => m.verdict === 'CONFIRM');
  const passes          = claudeConfirmed && othersConfirmed.length >= 1;
  const confirms        = models.filter(m => m.verdict === 'CONFIRM').length;
  const voteLog = models.map(m => {
    const tag  = MODEL_TAG[m.name] || m.name.toUpperCase();
    const icon = m.verdict === 'CONFIRM' ? '✓' : '✗';
    return `[${tag}] ${m.verdict} — ${m.reason} ${icon}`;
  });
  voteLog.push(passes
    ? `Result: Claude + ${othersConfirmed[0]?.name?.split(' ')[0] || '?'} confirmed → KILL SHOT EXECUTE`
    : !claudeConfirmed
      ? 'Result: BLOCKED — Claude rejected'
      : 'Result: BLOCKED — Claude confirmed, no supporting model');
  return { passes, confirms, claudeConfirmed, models, voteLog };
}

// ─── SERVER-SIDE SWING AUTO TRADE ENGINE (Kill Shot — H4, 4-hour scan) ───────
async function serverSwingAutoTrade() {
  if (process.env.AUTO_MODE_ENABLED !== 'true') return;

  const now = new Date();
  const h   = now.getUTCHours();
  const d   = now.getUTCDay();

  // Weekend block (Saturday all day; Sunday before 22 UTC)
  if (d === 6 || (d === 0 && h < 22)) return;

  // Only scan London open → NY close: 8–20 UTC
  if (h < 8 || h >= 20) return;

  // Friday PM block: no new swings after 18 UTC Friday
  if (d === 5 && h >= 18) return;

  // Fetch current OANDA open trades
  let openTrades = [];
  try {
    const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/openTrades`, { headers: H });
    const data = await r.json();
    openTrades = data.trades || [];
  } catch (e) {
    console.error('[swing-auto] open trades fetch failed:', e.message);
    return;
  }

  // Hard cap: max 2 open trades (M5 + swing combined) — matches Rule 3
  if (openTrades.length >= 2) {
    console.log(`[swing-auto] ${openTrades.length} open trades — circuit breaker, skipping swing scan`);
    return;
  }

  const session = getServerSession();

  for (const instrument of KILL_SHOT_PAIRS) {
    // Session gate — block instruments that don't belong in this session
    const allowedSessions = INSTRUMENT_HOME_SESSIONS[instrument];
    if (allowedSessions && !allowedSessions.includes(session)) {
      console.log(`[SESSION BLOCK] ${instrument} — not active in ${session}`);
      continue;
    }

    // 4-hour cooldown per pair (stamp before consensus to prevent parallel double-fire)
    if (Date.now() - (lastSwingConsensus.get(instrument) || 0) < 4 * 60 * 60_000) continue;

    // Post-close cooldown — skip if instrument closed within last 15 minutes
    const lastClose = postCloseCooldown.get(instrument);
    if (lastClose && Date.now() - lastClose < POST_CLOSE_COOLDOWN_MS) {
      const minsLeft = Math.ceil((POST_CLOSE_COOLDOWN_MS - (Date.now() - lastClose)) / 60000);
      console.log(`[COOLDOWN] ${instrument} swing — ${minsLeft} min remaining before re-entry allowed`);
      continue;
    }

    try {
      // Fetch H4 (100 bars) + weekly (10 bars) in parallel
      const [h4Candles, weeklyCandles] = await Promise.all([
        fetchOandaCandles(instrument, 'H4', 100),
        fetchOandaCandles(instrument, 'W',   10),
      ]);

      if (h4Candles.length < 50) continue;

      const sig = serverGenerateSwingSignal(h4Candles, weeklyCandles, instrument);
      if (!sig) continue;

      // Cross-system pair lock — block if OANDA already has ANY open trade on this instrument
      if (openTrades.some(t => t.instrument === instrument)) {
        console.log(`[SWING PAIR LOCK] ${instrument} already open in another timeframe — skipping swing`);
        serverRejections.unshift({ ts: now.toISOString(), instrument, direction: '?', score: 0, session, strategy: 'Kill Shot', rejections: [{ condition: 'Pair Lock', actual: `${instrument} already open`, threshold: 'One position per pair across all systems' }] });
        if (serverRejections.length > 50) serverRejections.pop();
        continue;
      }
      // Block if swing auto already tracking an open trade for this pair
      if (swingAutoTrades.some(t => t.instrument === instrument && !t.closed)) continue;

      // Stamp cooldown now (before async consensus)
      lastSwingConsensus.set(instrument, Date.now());

      // Fix 1: Fetch live price — H4 last close can be hours stale
      const livePrice = await fetchLivePrice(instrument);
      if (!livePrice) {
        console.error(`[swing-auto] ${instrument} — live price fetch failed, skipping`);
        continue;
      }
      console.log(`[swing-auto] ${instrument} — H4 last: ${sig.entry} | live mid: ${livePrice}`);

      // Rebuild SL/TP from live entry + H4 ATR (same risk distance)
      const riskDist = sig.atr * 2.0;
      const liveEntry = livePrice;
      const liveSl    = sig.direction === 'LONG' ? liveEntry - riskDist : liveEntry + riskDist;
      const liveTp1   = sig.direction === 'LONG' ? liveEntry + riskDist * 1.5 : liveEntry - riskDist * 1.5;
      const liveTp2   = sig.direction === 'LONG' ? liveEntry + riskDist * 2.5 : liveEntry - riskDist * 2.5;
      const liveTp3   = sig.direction === 'LONG' ? liveEntry + riskDist * 4.0 : liveEntry - riskDist * 4.0;

      const ts    = now.toISOString();
      const swingIntelAgeMins = lastXavierIntel.ts ? Math.round((Date.now() - lastXavierIntel.ts) / 60_000) : null;
      const swingIntelFresh   = swingIntelAgeMins !== null && swingIntelAgeMins < 30;
      const consensusParams = {
        instrument,
        direction: sig.direction,
        score:     sig.score,
        entry:     formatPrice(liveEntry, instrument),
        price:     formatPrice(liveEntry, instrument),
        sl:        formatPrice(liveSl,    instrument),
        tp1:       formatPrice(liveTp1,   instrument),
        tp2:       formatPrice(liveTp2,   instrument),
        tp3:       formatPrice(liveTp3,   instrument),
        ema21:     formatPrice(sig.ema21, instrument),
        ema50:     formatPrice(sig.ema50, instrument),
        rsi:       sig.rsi.toFixed(1),
        atr:       sig.atr.toFixed(instrument.includes('JPY') ? 3 : 5),
        session,
        strategy:  'Kill Shot',
        regime:    'SWING',
        xavierSentiment:   swingIntelFresh ? lastXavierIntel.sentiment : null,
        xavierKeyRisk:     swingIntelFresh ? lastXavierIntel.keyRisk   : null,
        xavierBrief:       swingIntelFresh ? lastXavierIntel.brief      : null,
        freshNews:         swingIntelFresh ? lastXavierIntel.freshNews  : null,
        xavierIntelAgeMin: swingIntelAgeMins,
      };

      // Duplicate guard — fresh OANDA check before committing to consensus
      if (await hasOpenPosition(instrument)) {
        console.log(`[DUPLICATE GUARD] ${instrument} — already open on OANDA, skipping swing`);
        continue;
      }

      const consensus = await runSwingConsensus(consensusParams);
      if (!consensus.passes) continue;

      // ── SL sanity check before swing order ──────────────────────────────────
      const slSane = sig.direction === 'LONG' ? liveSl < liveEntry : liveSl > liveEntry;
      const tpSane = sig.direction === 'LONG' ? liveTp1 > liveEntry : liveTp1 < liveEntry;
      if (!slSane || !tpSane) {
        console.error(`[KILL SHOT] ${instrument} — SL/TP sanity FAILED: dir=${sig.direction} entry=${formatPrice(liveEntry, instrument)} sl=${formatPrice(liveSl, instrument)} tp1=${formatPrice(liveTp1, instrument)} — ABORTING`);
        continue;
      }

      // ── Pre-flight margin check ──────────────────────────────────────────────
      const swingUnitSize = SWING_UNITS[instrument] ?? 500;
      const units = sig.direction === 'LONG' ? swingUnitSize : -swingUnitSize;
      if (!(await checkMargin(instrument, units, liveEntry)).sufficient) continue;

      // ── Place swing order (500 units, SL + TP1 from live price) ─────────────
      const order = {
        type: 'MARKET', instrument, units: String(units),
        timeInForce: 'FOK', positionFill: 'DEFAULT',
        stopLossOnFill:   { price: formatPrice(liveSl,   instrument), timeInForce: 'GTC' },
        takeProfitOnFill: { price: formatPrice(liveTp1,  instrument), timeInForce: 'GTC' },
      };
      console.log(`[KILL SHOT] ${instrument} order payload: entry~${formatPrice(liveEntry, instrument)} SL:${formatPrice(liveSl, instrument)} TP1:${formatPrice(liveTp1, instrument)}`);

      let result;
      try {
        const or = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/orders`, { method: 'POST', headers: H, body: JSON.stringify({ order }) });
        result   = await or.json();
      } catch (fetchErr) {
        console.error(`[KILL SHOT ERROR] ${instrument} — fetch failed: ${fetchErr.message}`);
        continue;
      }

      if (JSON.stringify(result).includes('MARKET_HALTED')) {
        console.log(`[KILL SHOT] ${instrument} — market halted, skipping`);
        continue;
      }

      // Fix 2: Proper OANDA rejection logging
      if (result.orderRejectTransaction) {
        console.error(`[KILL SHOT REJECTED] ${instrument} — ${result.orderRejectTransaction.rejectReason}`);
        continue;
      }
      if (result.errorCode) {
        console.error(`[KILL SHOT ERROR] ${instrument} — ${result.errorCode}: ${result.errorMessage || ''}`);
        continue;
      }
      if (!result.orderFillTransaction) {
        console.error(`[KILL SHOT ERROR] ${instrument} — unexpected response: ${JSON.stringify(result).slice(0, 300)}`);
        continue;
      }

      const fill    = result.orderFillTransaction.price;
      const tradeId = result.orderFillTransaction.tradeOpened?.tradeID || null;
      console.log(`[KILL SHOT SUCCESS] ${instrument} — tradeID: ${tradeId} @ ${fill}`);

      serverTradeLog.unshift({ id: tradeId, pair: instrument, direction: sig.direction, strategy: 'Kill Shot', session, score: sig.score, entry: parseFloat(fill), sl: parseFloat(formatPrice(liveSl, instrument)), tp: parseFloat(formatPrice(liveTp1, instrument)), units, type: 'swing', timestamp: Date.now() });
      if (serverTradeLog.length > 500) serverTradeLog.pop();

      swingAutoTrades.unshift({
        id: Date.now(), timestamp: ts, instrument,
        direction: sig.direction, units, price: fill,
        sl:  formatPrice(liveSl,  instrument),
        tp1: formatPrice(liveTp1, instrument),
        tp2: formatPrice(liveTp2, instrument),
        tp3: formatPrice(liveTp3, instrument),
        score: sig.score, session, reasons: sig.reasons,
        confirms: consensus.confirms,
        models:   consensus.models,
        voteLog:  consensus.voteLog,
        oandaTradeId: tradeId,
        closed: false,
      });
      if (swingAutoTrades.length > 50) swingAutoTrades.pop();

      console.log(`[KILL SHOT FIRED] ${instrument} ${sig.direction} @ ${fill} — score:${sig.score}% — ${consensus.confirms}/4 — ${session}`);
      await sendNotification(
        `🎯 <b>KILL SHOT FIRED</b>\n${instrument.replace('_', '/')} ${sig.direction}\nEntry: ${fill} · SL: ${formatPrice(liveSl, instrument)} · TP1: ${formatPrice(liveTp1, instrument)}\nScore: ${sig.score}% · ${consensus.confirms}/4 · ${session}`,
        {
          color: 0x8B5CF6,
          title: '🎯 Kill Shot Fired',
          fields: [
            { name: 'Pair',      value: instrument.replace('_', '/'), inline: true },
            { name: 'Direction', value: sig.direction,                inline: true },
            { name: 'Score',     value: `${sig.score}%`,             inline: true },
            { name: 'Entry',     value: fill,                         inline: true },
            { name: 'SL',        value: formatPrice(liveSl,  instrument), inline: true },
            { name: 'TP1',       value: formatPrice(liveTp1, instrument), inline: true },
            { name: 'Consensus', value: `${consensus.confirms}/4`, inline: true },
            { name: 'Session',   value: session,                 inline: true },
            { name: 'Strategy',  value: 'Kill Shot (H4)',        inline: true },
          ],
          timestamp: new Date().toISOString(),
          footer: { text: sig.reasons.slice(0, 3).join(' · ') },
        }
      );

    } catch (err) {
      console.error(`[swing-auto] ${instrument} — error: ${err.message}`);
    }
  }
}

// ─── DISCORD TWO-WAY COMMANDS ─────────────────────────────────────────────────
let lastDiscordMessageId = '0';

async function sendDiscordChannelMessage(content, embed) {
  const botToken  = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!botToken || !channelId) return;
  try {
    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(embed ? { embeds: [embed] } : { content }),
    });
  } catch (e) { console.error('[DISCORD CHANNEL]', e.message); }
}

async function pollDiscordCommands() {
  const botToken  = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!botToken || !channelId) return;
  try {
    const r = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages?after=${lastDiscordMessageId}&limit=10`,
      { headers: { 'Authorization': `Bot ${botToken}` } }
    );
    if (!r.ok) return;
    const messages = await r.json();
    if (!Array.isArray(messages) || messages.length === 0) return;

    // Process oldest first
    const sorted = messages.sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1));
    for (const msg of sorted) {
      if (BigInt(msg.id) > BigInt(lastDiscordMessageId)) lastDiscordMessageId = msg.id;
    }

    for (const msg of sorted) {
      if (msg.author?.bot) continue;
      const cmd = (msg.content || '').trim().toLowerCase();

      if (cmd === '/status') {
        const sess = getServerSession();
        const rule = XAVIER_RULES[sess] || {};
        let openTrades = [];
        try { const ot = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/openTrades`, { headers: H }); openTrades = (await ot.json()).trades || []; } catch {}
        await sendDiscordChannelMessage(null, {
          color: 0x58a6ff, title: '📊 Xavier Status',
          fields: [
            { name: 'Session',     value: sess,                                                    inline: true },
            { name: 'Auto Mode',   value: process.env.AUTO_MODE_ENABLED === 'true' ? '✅ ON' : '❌ OFF', inline: true },
            { name: 'Heat',        value: `${(openTrades.length * 1.5).toFixed(1)}R / 4R max`,    inline: true },
            { name: 'Open Trades', value: String(openTrades.length),                               inline: true },
            { name: 'Strategy',    value: rule.strategy || 'N/A',                                  inline: true },
            { name: 'Pairs',       value: (rule.pairs || []).join(', ') || 'None',                 inline: true },
          ],
          timestamp: new Date().toISOString(),
        });

      } else if (cmd === '/pause') {
        process.env.AUTO_MODE_ENABLED = 'false';
        console.log('[DISCORD CMD] /pause — auto-trading disabled');
        await sendDiscordChannelMessage('⏸ **Xavier paused** — auto-trading disabled. Send `/resume` to restart.');

      } else if (cmd === '/resume') {
        process.env.AUTO_MODE_ENABLED = 'true';
        console.log('[DISCORD CMD] /resume — auto-trading enabled');
        await sendDiscordChannelMessage('▶️ **Xavier resumed** — auto-trading active.');

      } else if (cmd === '/trades') {
        let openTrades = [];
        try { const ot = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/openTrades`, { headers: H }); openTrades = (await ot.json()).trades || []; } catch {}
        if (openTrades.length === 0) {
          await sendDiscordChannelMessage('📭 No open trades right now.');
        } else {
          const fields = openTrades.map(t => {
            const pnl = parseFloat(t.unrealizedPL || 0);
            const dir = parseFloat(t.currentUnits) >= 0 ? 'LONG' : 'SHORT';
            return { name: `${t.instrument.replace('_', '/')} ${dir}`, value: `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, inline: true };
          });
          await sendDiscordChannelMessage(null, { color: 0x58a6ff, title: '📈 Open Trades', fields, timestamp: new Date().toISOString() });
        }

      } else if (cmd === '/balance') {
        try {
          const acct = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/summary`, { headers: H });
          const d    = await acct.json();
          const balance    = parseFloat(d.account?.balance      || 0);
          const nav        = parseFloat(d.account?.NAV          || 0);
          const unrealized = parseFloat(d.account?.unrealizedPL || 0);
          await sendDiscordChannelMessage(null, {
            color: 0x3fb950, title: '💰 Account Balance',
            fields: [
              { name: 'Balance',    value: `$${balance.toFixed(2)}`,                                   inline: true },
              { name: 'NAV',        value: `$${nav.toFixed(2)}`,                                        inline: true },
              { name: 'Unrealized', value: `${unrealized >= 0 ? '+' : ''}$${unrealized.toFixed(2)}`,   inline: true },
            ],
            timestamp: new Date().toISOString(),
          });
        } catch (e) { await sendDiscordChannelMessage(`❌ Balance fetch failed: ${e.message}`); }

      } else if (cmd === '/kill') {
        process.env.AUTO_MODE_ENABLED = 'false';
        let closedCount = 0;
        try {
          const ot = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/openTrades`, { headers: H });
          const trades = (await ot.json()).trades || [];
          for (const t of trades) {
            try { await fetch(`${BASE}/v3/accounts/${ACCOUNT}/trades/${t.id}/close`, { method: 'PUT', headers: H }); closedCount++; } catch {}
          }
        } catch {}
        console.log(`[DISCORD CMD] /kill — auto-trading disabled, ${closedCount} trade(s) closed`);
        await sendDiscordChannelMessage(`💀 **KILL executed** — auto-trading disabled. ${closedCount} trade(s) closed.`);
      }
    }
  } catch (e) {
    console.error('[DISCORD POLL]', e.message);
  }
}

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`OANDA bridge live on port ${PORT}`);
  console.log(`  AI: Claude ${ANTHROPIC_KEY ? '✓' : '✗'} | OpenAI ${OPENAI_KEY ? '✓' : '✗'} | DeepSeek ${DEEPSEEK_KEY ? '✓' : '✗'} | Gemini ${GEMINI_KEY ? '✓' : '✗'}`);
  console.log(`  Auto mode: ${process.env.AUTO_MODE_ENABLED === 'true' ? 'ENABLED ⚡' : 'disabled (set AUTO_MODE_ENABLED=true to activate)'}`);

  // ── Environment audit — shows exactly which variables are present ──────────
  const REQUIRED_VARS = [
    'OANDA_TOKEN',
    'OANDA_ACCOUNT_ID',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'GEMINI_API_KEY',
    'AUTO_MODE_ENABLED',
    'DISCORD_WEBHOOK_URL',
    'DISCORD_BOT_TOKEN',
    'DISCORD_CHANNEL_ID',
  ];
  const OPTIONAL_VARS = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'VITE_ANTHROPIC_KEY',    // local dev fallback
    'VITE_OPENAI_API_KEY',   // local dev fallback
    'VITE_DEEPSEEK_API_KEY', // local dev fallback
    'VITE_GEMINI_API_KEY',   // local dev fallback
    'VITE_AUTO_MODE',        // local dev fallback
  ];
  console.log('── ENV AUDIT ─────────────────────────────');
  REQUIRED_VARS.forEach(v => console.log(`  [ENV] ${v}: ${process.env[v] ? '✅ SET' : '❌ MISSING'}`));
  console.log('  Optional:');
  OPTIONAL_VARS.forEach(v => { if (process.env[v]) console.log(`  [ENV] ${v}: ✅ SET`); });
  console.log('──────────────────────────────────────────');
});

setTimeout(() => serverAutoTrade().catch(e => console.error('[auto] Startup:', e.message)), 10_000);
setInterval(() => serverAutoTrade().catch(e => console.error('[auto] Loop:', e.message)), 60_000);

// Kill Shot swing scan — every 4 hours + 15s startup delay
setTimeout(() => serverSwingAutoTrade().catch(e => console.error('[swing-auto] Startup:', e.message)), 15_000);
setInterval(() => serverSwingAutoTrade().catch(e => console.error('[swing-auto] Loop:', e.message)), 4 * 60 * 60 * 1000);

// Upgrade 1 — Trade management (breakeven, partial close, trail) every 30s
setTimeout(() => manageOpenTrades().catch(e => console.error('[mgmt] Startup:', e.message)), 20_000);
setInterval(() => manageOpenTrades().catch(e => console.error('[mgmt] Loop:', e.message)), 10_000);

// Daily summary check every 60s (fires Telegram at 00:00–00:01 UTC)
setInterval(() => maybeSendDailySummary().catch(e => console.error('[mgmt] Summary:', e.message)), 60_000);

// Upgrade 2 — Economic calendar refresh every hour
refreshEconomicCalendar().catch(e => console.error('[calendar] Startup:', e.message));
setInterval(() => refreshEconomicCalendar().catch(e => console.error('[calendar] Refresh:', e.message)), 60 * 60_000);

// Discord two-way command polling — every 30s (requires DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID)
setTimeout(() => pollDiscordCommands().catch(e => console.error('[discord-poll] Startup:', e.message)), 8_000);
setInterval(() => pollDiscordCommands().catch(e => console.error('[discord-poll] Loop:', e.message)), 30_000);
