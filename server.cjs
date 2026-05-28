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

  const entryPrice = parseFloat(price) || 0;
  const atrVal     = parseFloat(atr)   || 0;
  const slPrice    = atrVal > 0 && entryPrice > 0
    ? (direction === 'LONG' ? entryPrice - atrVal * 1.5 : entryPrice + atrVal * 1.5)
    : null;

  const order = {
    type: 'MARKET', instrument, units: String(units),
    timeInForce: 'FOK', positionFill: 'DEFAULT',
  };
  console.log(`[ORDER] SL decision — atrVal=${atrVal} | entryPrice=${entryPrice} | slPrice=${slPrice}`);
  if (slPrice) {
    order.stopLossOnFill = { price: formatPrice(slPrice, instrument), timeInForce: 'GTC' };
    console.log('[ORDER] stopLossOnFill:', JSON.stringify(order.stopLossOnFill));
  } else {
    console.log('[ORDER] stopLossOnFill SKIPPED — atr=' + atrVal + ' or price=' + entryPrice + ' is zero/missing');
  }

  // Level 1 TP: 2R target (ATR × 1.5 stop × 2 = ATR × 3 reward)
  const tpPrice = atrVal > 0 && entryPrice > 0
    ? (direction === 'LONG' ? entryPrice + atrVal * 3 : entryPrice - atrVal * 3)
    : null;
  if (tpPrice) {
    order.takeProfitOnFill = { price: formatPrice(tpPrice, instrument), timeInForce: 'GTC' };
    console.log('[ORDER] takeProfitOnFill (2R):', JSON.stringify(order.takeProfitOnFill));
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

// ─── SWING ORDER — 500 units, explicit SL/TP1 prices ─────────────────────────
app.post('/swing/order', async (req, res) => {
  const { instrument, units, slPrice, tp1Price } = req.body;
  if (!instrument || !units) return res.status(400).json({ error: 'instrument and units required' });
  const direction = Number(units) >= 0 ? 'LONG' : 'SHORT';
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
    if (!r.ok) console.error('[SWING ORDER] OANDA error:', r.status, JSON.stringify(data).slice(0, 200));
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

// Upgrade state — trade management, calendar, daily stats
const tradeManagementState = new Map(); // tradeId → { movedToBreakeven, partialClosed, peakR }
const lastKnownTradeIds    = new Set(); // for closed trade detection
let   economicEvents       = [];        // high-impact events this week
let   dailyStats           = { date: '', trades: 0, winners: 0, losers: 0, totalPnl: 0, bestTrade: '', _bestPnl: -Infinity };
let   lastDailySummaryDate = '';


// ─── XAVIER RULES ────────────────────────────────────────────────────────────
// USER EXPLICIT OVERRIDE — backtest-validated combinations (2026-05-27)
const XAVIER_RULES = {
  TOKYO:  { strategy: 'Trend Follow', pairs: ['NZD_USD', 'UK100_GBP', 'EUR_USD'],          minScore: 65 },
  LONDON: { strategy: 'Momentum',     pairs: ['XAG_USD', 'UK100_GBP', 'GBP_USD'],          minScore: 65 },
  PRIME:  { strategy: 'Mean Revert',  pairs: ['NZD_USD', 'AU200_AUD', 'GBP_USD'],          minScore: 65 },
  NY:     { strategy: 'Mean Revert',  pairs: ['AU200_AUD', 'XAU_USD', 'SPX500_USD'],       minScore: 65 },
  SYDNEY: { strategy: 'Trend Follow', pairs: ['NAS100_USD', 'XAG_USD', 'NZD_USD'],         minScore: 65 },
  AVOID:  { strategy: null,           pairs: [],                                           minScore: 999 },
};

// Validated pairs for auto-execution — backtest-verified 2026-05-27
const SERVER_PAIRS = new Set([
  'NZD_USD', 'UK100_GBP', 'XAG_USD',
  'AU200_AUD', 'NAS100_USD', 'SPX500_USD',
  'XAU_USD', 'GBP_USD', 'EUR_USD',
  'USD_JPY', 'AUD_USD', 'USD_CAD',
]);

// Index pairs — home session only, 75%+ score required (tighter spreads, higher conviction)
const INDEX_PAIRS = new Set([
  'SPX500_USD', 'NAS100_USD',  // NY only
  'JP225_USD',                  // Tokyo only
  'UK100_GBP',                  // London only
  'AU200_AUD',                  // Sydney only
]);

const INDEX_HOME_SESSION = {
  SPX500_USD: 'NY',     NAS100_USD: 'NY',
  JP225_USD:  'TOKYO',
  UK100_GBP:  'LONDON',
  AU200_AUD:  'SYDNEY',
};

function isHomeSession(pair, session) {
  return INDEX_HOME_SESSION[pair] === session;
}

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

Respond in this EXACT format:
VERDICT: CONFIRM or REJECT
REASON: (one sentence, max 15 words, use specific numbers, trader language — no corporate phrases)`;
}

function buildGPTPrompt(p) {
  return `You are the Pattern Analyst. Validate price action and trend structure only.

Trade: ${p.instrument} ${p.direction} @ ${p.price}
Signal score: ${p.score}%
EMA9: ${p.ema9 || '?'} | EMA21: ${p.ema21 || '?'} | EMA50 side: ${p.ema50side || '?'}
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

async function runConsensus(params) {
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

// ─── CONSENSUS ENDPOINT ───────────────────────────────────────────────────────
app.post('/consensus', async (req, res) => {
  try {
    res.json(await runConsensus(req.body));
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
    const count = Math.min(parseInt(req.query.count || '200', 10), 500);
    const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/transactions?count=${count}`, { headers: H });
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
  for (const ev of economicEvents) {
    const diff = ev.time - now;          // ms until event (negative = past)
    if (diff > 120 * 60_000) continue;   // event is > 2h away — not yet a risk
    if (diff < -60 * 60_000) continue;   // event was > 1h ago — dust settled
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

// ─── OPEN TRADE MANAGER (runs every 30s) ─────────────────────────────────────
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

  // ── Detect closed trades ────────────────────────────────────────────────────
  const currentIds = new Set(openTrades.map(t => t.id));
  for (const id of lastKnownTradeIds) {
    if (!currentIds.has(id)) {
      const state = tradeManagementState.get(id);
      if (state) {
        try {
          const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/trades/${id}`, { headers: H });
          const data = await r.json();
          const trade = data.trade;
          if (trade) {
            const pnl   = parseFloat(trade.realizedPL || 0);
            const instr = trade.instrument;
            const dir   = parseFloat(trade.initialUnits || 1) >= 0 ? 'LONG' : 'SHORT';
            const won   = pnl > 0;
            // Update daily stats
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
            const emoji = won ? '✅' : '❌';
            await sendTelegram(
              `${emoji} <b>TRADE CLOSED</b>\n` +
              `Pair: ${instr.replace('_', '/')} ${dir}\n` +
              `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n` +
              `Today: ${dailyStats.winners}W/${dailyStats.losers}L · Net $${dailyStats.totalPnl.toFixed(2)}`
            );
          }
        } catch (e) {
          console.error('[mgmt] Closed trade fetch failed:', e.message);
        }
        tradeManagementState.delete(id);
      }
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

    // ── 1R reached: breakeven + partial close 50% ────────────────────────────
    if (currentR >= 1.0 && !state.movedToBreakeven) {
      const pip     = SERVER_PIP_SIZE[instrument] || 0.0001;
      const bePrice = dir === 'LONG' ? entry + pip : entry - pip;
      const moved   = await updateTradeSL(tradeId, bePrice, instrument);
      if (moved) {
        state.movedToBreakeven = true;
        await sendTelegram(
          `🛡 <b>BREAKEVEN</b>\n` +
          `${instrument.replace('_', '/')} ${dir}\n` +
          `SL → ${formatPrice(bePrice, instrument)} (entry +1pip)\n` +
          `Current: +${currentR.toFixed(2)}R`
        );
      }
    }

    if (currentR >= 1.0 && !state.partialClosed) {
      const halfUnits = Math.round(Math.abs(units) * 0.5);
      if (halfUnits > 0) {
        const result = await partialCloseTrade(tradeId, halfUnits);
        if (result) {
          state.partialClosed = true;
          await sendTelegram(
            `💰 <b>PARTIAL CLOSE</b>\n` +
            `${instrument.replace('_', '/')} ${dir}\n` +
            `Closed ${halfUnits} units @ ${formatPrice(result.fill, instrument)}\n` +
            `Locked: ${result.pnl >= 0 ? '+' : ''}$${result.pnl.toFixed(2)}`
          );
        }
      }
    }

    // ── 2R+ reached: trail stop to (currentR - 0.5R), only if improving ──────
    if (currentR >= 2.0) {
      const trailPrice = dir === 'LONG'
        ? entry + risk * (currentR - 0.5)
        : entry - risk * (currentR - 0.5);
      const currentSL = parseFloat(trade.stopLossOrder?.price || sl);
      const improving  = dir === 'LONG' ? trailPrice > currentSL + risk * 0.1
                                        : trailPrice < currentSL - risk * 0.1;
      if (improving) {
        await updateTradeSL(tradeId, trailPrice, instrument);
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
    await sendTelegram(`📊 <b>DAILY SUMMARY</b>\nNo trades executed yesterday.`);
    return;
  }
  const winRate = ((dailyStats.winners / dailyStats.trades) * 100).toFixed(0);
  await sendTelegram(
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
    const mean   = recent.reduce((a, b) => a + b, 0) / recent.length;
    const dev    = Math.abs(last - mean) / mean;
    const isGold = instrument.includes('XAU');
    const isJpy  = instrument.includes('JPY');
    const t1 = isGold ? 0.0008 : isJpy ? 0.0015 : 0.001;
    const t2 = isGold ? 0.0015 : isJpy ? 0.003  : 0.002;
    const t3 = isGold ? 0.003  : isJpy ? 0.005  : 0.004;
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
  return { direction, score, reason, rsi: parseFloat(rsi.toFixed(1)) };
}

// ─── TREND CONFIRMATION (USER EXPLICIT OVERRIDE) ─────────────────────────────
// Runs before consensus. Requires 2/3 checks to pass:
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

function confirmTrend(candles, direction) {
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

  const confirmCount = [last3Confirm, isMoving, emaSeparating].filter(Boolean).length;
  const passed       = confirmCount >= 2;
  console.log(`[TREND] ${direction} | last3:${last3Confirm} moving:${isMoving}(${(priceChange * 100).toFixed(3)}%) emaSep:${emaSeparating} → ${passed ? 'CONFIRMED ✓' : 'WAIT'} (${confirmCount}/3)`);
  return passed;
}

function serverRunGatekeepers(history, signal, openTrades, _instrument, strategy) {
  const rejections = [];
  const session    = getServerSession();

  if (session === 'AVOID') {
    rejections.push({ condition: 'Dead zone block', reason: 'AVOID session — no trades' });
    return { passed: false, rejections };
  }
  if (signal.score < 65) {
    rejections.push({ condition: 'Score threshold', actual: `${signal.score}%`, threshold: '65%' });
  }
  if (openTrades.length >= 2) {
    rejections.push({ condition: 'Position limit', actual: `${openTrades.length} open`, threshold: 'Max 2' });
  }
  const heat = openTrades.length * 1.5;
  if (heat >= 4) {
    rejections.push({ condition: 'Heat limit', actual: `${heat.toFixed(1)}R`, threshold: '4R max' });
  }
  if (history.length >= 21) {
    const bars  = history.slice(-21);
    const tr    = bars.slice(1).map((p, i) => Math.abs(p - bars[i]));
    const atr5  = tr.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const atr20 = tr.reduce((a, b) => a + b, 0) / tr.length || atr5;
    if (atr20 > 0 && atr5 > atr20 * 2.5) {
      rejections.push({ condition: 'Volatility spike', actual: `${(atr5 / atr20).toFixed(1)}×`, threshold: '< 2.5×' });
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

  for (const instrument of pairs) {
    if (Date.now() - (lastConsensus.get(instrument) || 0) < 5 * 60_000) continue;

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
      serverRejections.unshift({ ts, instrument, direction: '?', score: 0, session, strategy, rejections: [{ condition: 'News Block', actual: 'High-impact event ±2h', threshold: 'No trading' }] });
      if (serverRejections.length > 50) serverRejections.pop();
      await sendTelegram(`📰 <b>NEWS BLOCK</b>\n${instrument.replace('_', '/')} — high-impact event within ±2h\nSession: ${session}`);
      continue;
    }

    const history = await getM5History(instrument);
    if (history.length < 20) {
      console.log(`[auto] ${instrument} — insufficient M5 history (${history.length} bars)`);
      continue;
    }

    let price = 0;
    try {
      const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/pricing?instruments=${instrument}`, { headers: H });
      const data = await r.json();
      const px   = data.prices?.[0];
      if (!px) continue;
      price = (parseFloat(px.bids[0].price) + parseFloat(px.asks[0].price)) / 2;
    } catch { continue; }

    const liveHistory = [...history, price];
    const signal = serverGenerateSignal(liveHistory, strategy, instrument);

    if (!signal) {
      console.log(`[auto] ${instrument} — no ${strategy} signal`);
      continue;
    }

    // Indices: enforce 75% score threshold (higher conviction required)
    if (INDEX_PAIRS.has(instrument) && signal.score < 75) continue;

    console.log(`[auto] ${instrument} ${signal.direction} ${signal.score}% — ${strategy} — gatekeeping`);

    const gate = serverRunGatekeepers(liveHistory, signal, openTrades, instrument, strategy);
    if (!gate.passed) {
      const reasons = gate.rejections.map(r => r.condition).join(', ');
      console.log(`[auto] ${instrument} — BLOCKED: ${reasons}`);
      serverRejections.unshift({ ts, instrument, direction: signal.direction, score: signal.score, session, strategy, rejections: gate.rejections });
      if (serverRejections.length > 50) serverRejections.pop();
      continue;
    }

    // Trend confirmation — 2/3 checks required before consensus
    const m5Candles = await getM5Candles(instrument);
    const trendOk   = confirmTrend(
      [...m5Candles, { open: price, close: price }],
      signal.direction,
    );
    if (!trendOk) {
      console.log(`[TREND WAIT] ${instrument} — signal ${signal.score}% detected but trend not confirmed yet. Waiting for momentum to develop.`);
      serverRejections.unshift({ ts, instrument, direction: signal.direction, score: signal.score, session, strategy, rejections: [{ condition: 'Trend Not Confirmed', actual: '< 2/3 checks (last3 candles, price moving, EMA separating)', threshold: '2/3 required' }] });
      if (serverRejections.length > 50) serverRejections.pop();
      continue;
    }
    console.log(`[TREND CONFIRMED] ${instrument} ${signal.direction} — trend active, proceeding to consensus`);

    lastConsensus.set(instrument, Date.now());

    const bars      = liveHistory.slice(-21);
    const tr        = bars.slice(1).map((v, i) => Math.abs(v - bars[i]));
    const atr       = tr.reduce((a, b) => a + b, 0) / tr.length || 0.00001;
    const pip       = SERVER_PIP_SIZE[instrument] || 0.0001;
    const atrPips   = (atr / pip).toFixed(1);
    const sl        = signal.direction === 'LONG' ? price - atr * 1.5 : price + atr * 1.5;
    const tp        = signal.direction === 'LONG' ? price + atr * 3.0 : price - atr * 3.0;
    const ema9v     = liveHistory.slice(-9).reduce((a, b) => a + b, 0) / 9;
    const ema21v    = liveHistory.slice(-21).reduce((a, b) => a + b, 0) / 21;
    const ema50v    = liveHistory.length >= 50 ? liveHistory.slice(-50).reduce((a, b) => a + b, 0) / 50 : ema21v;
    const ema50side = signal.direction === 'LONG' ? (price > ema50v ? 'ABOVE' : 'BELOW') : (price < ema50v ? 'BELOW' : 'ABOVE');
    const heat      = (openTrades.length * 1.5).toFixed(1);

    console.log(`[auto] ${instrument} — calling consensus`);
    let consensus;
    try {
      consensus = await runConsensus({
        instrument, direction: signal.direction, score: signal.score,
        price:         formatPrice(price, instrument),
        change:        '0',
        session,       strategy,
        atr:           atr.toFixed(5),
        atrPips,
        sl:            formatPrice(sl, instrument),
        tp:            formatPrice(tp, instrument),
        ema9:          ema9v.toFixed(5),
        ema21:         ema21v.toFixed(5),
        ema50side,
        regime:        'RANGING',
        heat,
        rr:            '2.0',
        rsi:           signal.rsi?.toFixed(1) || '50',
        reason:        signal.reason.join(', '),
        headline:      `Auto ${session} scan`,
        newsRisk:      'LOW',
        sessionQuality: (session === 'PRIME' || session === 'LONDON') ? 'PRIME' : 'GOOD',
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
    try {
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
        const fill = result?.orderFillTransaction?.price ?? price.toFixed(5);
        autoTrades.unshift({ id: Date.now(), timestamp: ts, instrument, direction: signal.direction, units, price: fill, session, strategy, score: signal.score, consensus: consensus.votes, models: consensus.models, oandaOrderId: result.orderFillTransaction?.id || null });
        if (autoTrades.length > 100) autoTrades.pop();
        console.log(`[auto] ✓ EXECUTED ${instrument} ${signal.direction} @ ${fill} — ${consensus.votes.confirm}/4 — ${strategy} — ${session}`);
        // Upgrade 3 — Telegram notification
        await sendTelegram(
          `⚡ <b>TRADE OPENED</b>\n` +
          `${instrument.replace('_', '/')} ${signal.direction}\n` +
          `Entry: ${formatPrice(parseFloat(fill), instrument)}\n` +
          `SL: ${formatPrice(sl, instrument)} · TP: ${formatPrice(tp, instrument)}\n` +
          `Score: ${signal.score}% · Models: ${consensus.votes.confirm}/4\n` +
          `Strategy: ${strategy} · Session: ${session}`
        );
      }
    } catch (e) {
      console.error(`[auto] Order error ${instrument}: ${e.message}`);
    }
  }
}

// ─── KILL SHOT PAIRS ─────────────────────────────────────────────────────────
const KILL_SHOT_PAIRS = ['XAU_USD', 'GBP_USD', 'EUR_USD', 'USD_JPY', 'NAS100_USD', 'BCO_USD'];

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

  // Hard cap: max 4 open trades (M5 + swing combined)
  if (openTrades.length >= 4) return;

  const session = getServerSession();

  for (const instrument of KILL_SHOT_PAIRS) {
    // 4-hour cooldown per pair (stamp before consensus to prevent parallel double-fire)
    if (Date.now() - (lastSwingConsensus.get(instrument) || 0) < 4 * 60 * 60_000) continue;

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
      };

      const consensus = await runSwingConsensus(consensusParams);
      if (!consensus.passes) continue;

      // ── Place swing order (500 units, SL + TP1 from live price) ─────────────
      const units = sig.direction === 'LONG' ? 500 : -500;
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

    } catch (err) {
      console.error(`[swing-auto] ${instrument} — error: ${err.message}`);
    }
  }
}

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`OANDA bridge live on port ${PORT}`);
  console.log(`  AI: Claude ${ANTHROPIC_KEY ? '✓' : '✗'} | OpenAI ${OPENAI_KEY ? '✓' : '✗'} | DeepSeek ${DEEPSEEK_KEY ? '✓' : '✗'} | Gemini ${GEMINI_KEY ? '✓' : '✗'}`);
  console.log(`  Auto mode: ${process.env.AUTO_MODE_ENABLED === 'true' ? 'ENABLED ⚡' : 'disabled (set AUTO_MODE_ENABLED=true to activate)'}`);
});

setTimeout(() => serverAutoTrade().catch(e => console.error('[auto] Startup:', e.message)), 10_000);
setInterval(() => serverAutoTrade().catch(e => console.error('[auto] Loop:', e.message)), 60_000);

// Kill Shot swing scan — every 4 hours + 15s startup delay
setTimeout(() => serverSwingAutoTrade().catch(e => console.error('[swing-auto] Startup:', e.message)), 15_000);
setInterval(() => serverSwingAutoTrade().catch(e => console.error('[swing-auto] Loop:', e.message)), 4 * 60 * 60 * 1000);

// Upgrade 1 — Trade management (breakeven, partial close, trail) every 30s
setTimeout(() => manageOpenTrades().catch(e => console.error('[mgmt] Startup:', e.message)), 20_000);
setInterval(() => manageOpenTrades().catch(e => console.error('[mgmt] Loop:', e.message)), 30_000);

// Daily summary check every 60s (fires Telegram at 00:00–00:01 UTC)
setInterval(() => maybeSendDailySummary().catch(e => console.error('[mgmt] Summary:', e.message)), 60_000);

// Upgrade 2 — Economic calendar refresh every hour
refreshEconomicCalendar().catch(e => console.error('[calendar] Startup:', e.message));
setInterval(() => refreshEconomicCalendar().catch(e => console.error('[calendar] Refresh:', e.message)), 60 * 60_000);
