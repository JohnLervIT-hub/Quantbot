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
    order.stopLossOnFill = { price: slPrice.toFixed(5), timeInForce: 'GTC' };
    console.log('[ORDER] stopLossOnFill:', JSON.stringify(order.stopLossOnFill));
  } else {
    console.log('[ORDER] stopLossOnFill SKIPPED — atr=' + atrVal + ' or price=' + entryPrice + ' is zero/missing');
  }

  // Level 1 TP: 2R target (ATR × 1.5 stop × 2 = ATR × 3 reward)
  const tpPrice = atrVal > 0 && entryPrice > 0
    ? (direction === 'LONG' ? entryPrice + atrVal * 3 : entryPrice - atrVal * 3)
    : null;
  if (tpPrice) {
    order.takeProfitOnFill = { price: tpPrice.toFixed(5), timeInForce: 'GTC' };
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
  console.log(`POST /swing/order — ${instrument} ${direction} ${Math.abs(Number(units))} units (SWING)`);
  const order = {
    type: 'MARKET', instrument, units: String(units),
    timeInForce: 'FOK', positionFill: 'DEFAULT',
  };
  if (slPrice) {
    order.stopLossOnFill = { price: parseFloat(slPrice).toFixed(5), timeInForce: 'GTC' };
    console.log('[SWING] SL:', order.stopLossOnFill.price);
  }
  if (tp1Price) {
    order.takeProfitOnFill = { price: parseFloat(tp1Price).toFixed(5), timeInForce: 'GTC' };
    console.log('[SWING] TP1:', order.takeProfitOnFill.price);
  }
  try {
    const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/orders`, { method: 'POST', headers: H, body: JSON.stringify({ order }) });
    const data = await r.json();
    console.log('[SWING OANDA]', r.status, JSON.stringify(data).slice(0, 200));
    res.json(data);
  } catch (e) {
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
const priceHistory  = new Map(); // instrument → number[] (capped at 60)
const lastConsensus = new Map(); // instrument → ms timestamp (5-min cooldown)
const autoTrades    = [];        // newest-first, capped at 100
const paperTrades   = [];        // newest-first, capped at 100

const AUTO_PAIRS = 'EUR_USD,GBP_USD,USD_JPY,AUD_USD,USD_CAD,XAU_USD,SPX500_USD';

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
    const voteLog = models.map(m => {
      const tag  = MODEL_TAG[m.name] || m.name.toUpperCase();
      const icon = m.verdict === 'CONFIRM' ? '✓' : '✗';
      return `[${tag}] ${m.verdict} — ${m.reason} ${icon}`;
    });
    voteLog.push(`Result: ${confirms}/4 CONFIRM → ${confirms >= 3 ? 'KILL SHOT EXECUTE' : 'BLOCKED'}`);
    res.json({
      votes: { confirm: confirms, reject: models.length - confirms },
      consensus: confirms >= 3 ? 'CONFIRM' : 'REJECT',
      confidence: `${Math.round((confirms / models.length) * 100)}%`,
      models, voteLog,
      executeAllowed: confirms >= 3,
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

// ─── PAPER TRADES ENDPOINT ────────────────────────────────────────────────────
app.get('/paper-trades', (_req, res) => {
  res.json({ count: paperTrades.length, trades: paperTrades });
});

// ─── AUTONOMOUS CHECK ─────────────────────────────────────────────────────────
async function runAutonomousCheck() {
  const ts = new Date().toISOString();

  let prices;
  try {
    const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/pricing?instruments=${AUTO_PAIRS}`, { headers: H });
    const data = await r.json();
    prices = data.prices;
    if (!prices?.length) return;
  } catch (e) {
    console.error(`[auto] Price fetch failed: ${e.message}`);
    return;
  }

  for (const px of prices) {
    const { instrument } = px;
    const mid = (parseFloat(px.asks[0].price) + parseFloat(px.bids[0].price)) / 2;

    const hist = priceHistory.get(instrument) || [];
    hist.push(mid);
    if (hist.length > 60) hist.shift();
    priceHistory.set(instrument, hist);

    if (hist.length < 6) continue;

    const avg5      = hist.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
    const changePct = (mid - avg5) / avg5 * 100;

    // v3.0: raise signal threshold from 0.3% to 0.45%
    if (Math.abs(changePct) < 0.45) {
      console.log(`AUTO SKIP: ${instrument} | change ${changePct.toFixed(3)}% < 0.45% threshold`);
      continue;
    }
    if (Date.now() - (lastConsensus.get(instrument) || 0) < 5 * 60_000) continue;

    // v3.0 gatekeeper — EMA50 higher-timeframe bias
    if (hist.length >= 50) {
      const ema50 = hist.slice(-50).reduce((a, b) => a + b, 0) / 50;
      const direction_test = changePct > 0 ? 'LONG' : 'SHORT';
      const biasOk = direction_test === 'LONG' ? mid > ema50 : mid < ema50;
      if (!biasOk) {
        console.log(`AUTO SKIP: ${instrument} | EMA50 bias opposes ${direction_test} (price ${mid.toFixed(5)} vs EMA50 ${ema50.toFixed(5)})`);
        continue;
      }
    }

    // v3.0 gatekeeper — ATR volatility spike check
    if (hist.length >= 21) {
      const bars  = hist.slice(-21);
      const tr    = bars.slice(1).map((p, i) => Math.abs(p - bars[i]));
      const atr5  = tr.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const atr20 = tr.reduce((a, b) => a + b, 0) / tr.length;
      if (atr20 > 0 && atr5 > atr20 * 2) {
        console.log(`AUTO SKIP: ${instrument} | volatility spike ATR5/ATR20=${(atr5/atr20).toFixed(2)}`);
        continue;
      }
    }

    lastConsensus.set(instrument, Date.now());

    const direction = changePct > 0 ? 'LONG' : 'SHORT';
    const score     = Math.min(Math.round(Math.abs(changePct) * 33), 100);

    let result;
    try {
      result = await runConsensus({
        instrument, direction, score,
        price:    mid.toFixed(5),
        change:   changePct.toFixed(3),
        rsi:      50,
        reason:   `Price ${direction === 'LONG' ? 'above' : 'below'} 5-bar avg by ${Math.abs(changePct).toFixed(3)}%`,
        headline: 'Autonomous scan',
      });
    } catch (e) {
      console.error(`[auto] Consensus error ${instrument}: ${e.message}`);
      continue;
    }

    const confirmLabel = `${result.votes.confirm}/3 confirm`;

    if (result.executeAllowed && process.env.AUTO_MODE_ENABLED === 'true') {
      const units = direction === 'LONG' ? 1000 : -1000;
      try {
        const orderBody = JSON.stringify({
          order: { type: 'MARKET', instrument, units: String(units), timeInForce: 'FOK', positionFill: 'DEFAULT' },
        });
        const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/orders`, { method: 'POST', headers: H, body: orderBody });
        const oandaResult = await r.json();

        const isHalted = oandaResult.orderRejectTransaction?.rejectReason === 'MARKET_HALTED'
          || JSON.stringify(oandaResult).includes('MARKET_HALTED');

        if (isHalted) {
          const paper = {
            id:        Date.now(),
            type:      'PAPER',
            instrument,
            direction,
            units,
            price:     mid,
            consensus: `${result.votes.confirm}/3 CONFIRM`,
            reason:    'Market closed — paper trade logged',
            timestamp: ts,
          };
          paperTrades.unshift(paper);
          if (paperTrades.length > 100) paperTrades.pop();
          console.log(`AUTO CHECK: ${instrument} ${direction} ${score}% — ${confirmLabel} — PAPER logged (market closed)`);
        } else {
          const trade = {
            id:           Date.now(),
            timestamp:    ts,
            instrument,
            direction,
            units,
            price:        mid,
            changePct:    `${changePct.toFixed(3)}%`,
            consensus:    result.votes,
            models:       result.models,
            oandaOrderId: oandaResult.orderFillTransaction?.id || oandaResult.orderCreateTransaction?.id || null,
          };
          autoTrades.unshift(trade);
          if (autoTrades.length > 100) autoTrades.pop();
          console.log(`Xavier executed ${instrument} ${direction} automatically — ${confirmLabel} @ ${mid.toFixed(5)}`);
        }
      } catch (e) {
        console.error(`AUTO CHECK: ${instrument} ${direction} ${score}% — ${confirmLabel} — order error: ${e.message}`);
      }
    } else {
      console.log(`AUTO CHECK: ${instrument} ${direction} ${score}% — ${confirmLabel} — ${result.executeAllowed ? 'auto mode off' : 'REJECTED'}`);
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

setTimeout(() => runAutonomousCheck().catch(e => console.error('[auto] Startup:', e.message)), 10_000);
setInterval(() => runAutonomousCheck().catch(e => console.error('[auto] Loop:', e.message)), 60_000);
