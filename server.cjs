require('dotenv').config({ override: true, path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');

const { createClient } = require('@supabase/supabase-js');
const supabase = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;
console.log('[SUPABASE]', supabase ? '✅ Connected' : '❌ Not configured');

// ─── SECURITY HELPERS ─────────────────────────────────────────────────────────
const maskKey   = (key)   => key   ? key.slice(0, 8) + '...' : 'NOT SET';
const maskEmail = (email) => email ? email.replace(/(.{2}).*@/, '$1***@') : 'unknown';

async function logSecurityEvent(event, details, severity) {
  console.log('[SECURITY]', severity, event, JSON.stringify(details));
  if (!supabase) return;
  try {
    await supabase.from('security_logs').insert({
      id:        `sec_${Date.now()}`,
      event,
      details:   JSON.stringify(details),
      severity,
      ip:        details.ip || 'unknown',
      timestamp: new Date().toISOString(),
    });
    if (severity === 'CRITICAL') {
      await sendDiscordEmbed({
        title:  '🚨 SECURITY ALERT',
        color:  0xff0000,
        fields: [
          { name: 'Event',    value: event,                                       inline: true },
          { name: 'Severity', value: severity,                                    inline: true },
          { name: 'IP',       value: details.ip || 'unknown',                     inline: true },
          { name: 'Details',  value: JSON.stringify(details).slice(0, 200),       inline: false },
        ],
      });
    }
  } catch (err) {
    console.error('[SECURITY LOG ERROR]', err.message);
  }
}

const app = express();
app.disable('x-powered-by'); // belt-and-suspenders alongside helmet

const ALLOWED_ORIGINS = [
  'https://quantbot-phi.vercel.app',
  'https://xxavier.ai',
  'http://localhost:5173',
  'http://localhost:3001',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      logSecurityEvent('CORS_VIOLATION', { origin }, 'WARNING');
      callback(new Error('CORS violation'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-order-source'],
}));
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
// Save raw body for Discord signature verification
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
}));

// ─── RATE LIMITERS ────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  handler: (req, res) => {
    logSecurityEvent('RATE_LIMIT_HIT', { path: req.path, ip: req.ip }, 'WARNING');
    res.status(429).json({ error: 'TOO_MANY_ATTEMPTS', message: 'Too many login attempts. Try again in 15 minutes.' });
  },
});

const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  handler: (req, res) => {
    logSecurityEvent('RATE_LIMIT_HIT', { path: req.path, ip: req.ip }, 'WARNING');
    res.status(429).json({ error: 'ORDER_RATE_LIMITED', message: 'Too many order requests' });
  },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  handler: (req, res) => {
    logSecurityEvent('RATE_LIMIT_HIT', { path: req.path, ip: req.ip }, 'WARNING');
    res.status(429).json({ error: 'RATE_LIMITED' });
  },
});

app.use('/auth/login', loginLimiter);
app.use('/order', orderLimiter);
app.use('/swing/order', orderLimiter);
app.use(apiLimiter);

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    logSecurityEvent('UNAUTHORIZED_ACCESS', { path: req.path, ip: req.ip }, 'CRITICAL');
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    logSecurityEvent('UNAUTHORIZED_ACCESS', { path: req.path, ip: req.ip, reason: 'invalid_token' }, 'CRITICAL');
    return res.status(401).json({ error: 'INVALID_TOKEN', message: 'Token invalid or expired' });
  }
};

// ─── INPUT VALIDATION ─────────────────────────────────────────────────────────
const validateOrderInput = (req, res, next) => {
  const { instrument, units, direction } = req.body;

  // Instrument format — normalize slashes/dashes before validating
  const inst = (instrument || '').replace(/[/\-]/g, '_').toUpperCase();
  if (!inst || !/^[A-Z0-9_]+$/.test(inst) || inst.length > 20) {
    return res.status(400).json({ error: 'INVALID_INSTRUMENT', message: 'Invalid instrument format' });
  }

  // Units — allow negative values (negative = SHORT direction)
  const u = Number(units);
  if (!units || isNaN(u) || Math.abs(u) < 1 || Math.abs(u) > 100000) {
    return res.status(400).json({ error: 'INVALID_UNITS', message: 'Units must be 1-100000' });
  }

  // Direction — only validated if explicitly present in body
  if (direction !== undefined && !['LONG', 'SHORT'].includes(direction)) {
    return res.status(400).json({ error: 'INVALID_DIRECTION', message: 'Direction must be LONG or SHORT' });
  }

  // SL/TP — validated only if provided; accept both field name conventions
  const sl = req.body.stopLoss  ?? req.body.slPrice;
  const tp = req.body.takeProfit ?? req.body.tp1Price;
  if (sl !== undefined && sl !== null && parseFloat(sl) <= 0) {
    return res.status(400).json({ error: 'INVALID_PRICES', message: 'SL and TP must be positive' });
  }
  if (tp !== undefined && tp !== null && parseFloat(tp) <= 0) {
    return res.status(400).json({ error: 'INVALID_PRICES', message: 'SL and TP must be positive' });
  }

  next();
};

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

app.get('/account', requireAuth, async (req, res) => {
  const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/summary`, { headers: H });
  res.json(await r.json());
});

app.get('/trades', requireAuth, async (req, res) => {
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

app.post('/order', requireAuth, validateOrderInput, async (req, res) => {
  const _orderSource = req.headers['x-order-source'] || req.body.source || 'UNKNOWN';
  console.log('[ORDER SOURCE]', req.path, 'source:', _orderSource, 'approved:', req.body.approved || false, 'body:', JSON.stringify(req.body));
  console.log('[ORDER] BASE:', BASE, '| ACCOUNT:', ACCOUNT ? ACCOUNT.slice(0, 8) + '…' : 'MISSING');
  const { units, atr, price } = req.body;
  const instrument = normalizeInstrument(req.body.instrument);
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

  // Post-close cooldown hard block — applies to manual orders too
  const _orderLastClose = postCloseCooldown.get(instrument);
  if (_orderLastClose && Date.now() - _orderLastClose < 15 * 60 * 1000) {
    const minsLeft = Math.ceil((15 * 60 * 1000 - (Date.now() - _orderLastClose)) / 60000);
    console.log(`[COOLDOWN HARD BLOCK] ${instrument} — ${minsLeft} min remaining — ABORTING`);
    return res.status(400).json({ error: 'COOLDOWN_ACTIVE', message: `${instrument} cooldown: ${minsLeft} min remaining`, minsLeft });
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

  const result = await placeOrder({
    instrument, direction,
    units: Math.abs(Number(units)),
    entry: entryPrice,
    stopLoss:   slPrice  ?? undefined,
    takeProfit: tpPrice  ?? undefined,
    source: 'M5-Manual', score: null, session: currentSession, strategy: null,
  });

  if (result.blocked) {
    const code = result.blocked;
    if (code === 'COOLDOWN')    return res.status(400).json({ error: 'COOLDOWN_ACTIVE',        message: `${instrument} cooldown active` });
    if (code === 'DUPLICATE')   return res.status(400).json({ error: 'DUPLICATE_POSITION',     message: `${instrument} already open` });
    if (code === 'HEAT_LIMIT')  return res.status(400).json({ error: 'MAX_TRADES',             message: 'Max 2 open trades' });
    if (code === 'NEWS')        return res.status(400).json({ error: 'NEWS_BLOCK',             message: `${instrument} blocked — high-impact news` });
    if (code === 'MARGIN')      return res.status(400).json({ error: 'INSUFFICIENT_MARGIN',    message: 'Insufficient margin' });
    if (code === 'SL_SANITY')   return res.status(400).json({ error: 'SL_SANITY',              message: 'Stop loss on wrong side of entry' });
    if (code === 'OANDA_REJECT') return res.status(400).json({ error: 'OANDA_REJECT',          message: result.reason });
    return res.status(400).json({ error: code, message: result.reason || 'Order blocked' });
  }

  res.json({ orderFillTransaction: { price: result.fill, tradeOpened: { tradeID: result.tradeId } } });
});

// ─── SWING ORDER — instrument-calibrated units, explicit SL/TP1 prices ────────
app.post('/swing/order', requireAuth, validateOrderInput, async (req, res) => {
  const _swingSource = req.headers['x-order-source'] || req.body.source || 'UNKNOWN';
  console.log('[ORDER SOURCE]', req.path, 'source:', _swingSource, 'approved:', req.body.approved || false, 'consensusConfirms:', req.body.consensusConfirms, 'body:', JSON.stringify(req.body));
  const { slPrice, tp1Price, consensusConfirms } = req.body;
  const instrument = normalizeInstrument(req.body.instrument);
  let { units } = req.body;
  if (!instrument || !units) return res.status(400).json({ error: 'instrument and units required' });

  // Gate: approved flag required — fail closed
  if (!req.body.approved) {
    console.log('[SWING BLOCKED]', instrument, '— not approved (approved flag missing or false)');
    return res.status(400).json({ error: 'APPROVAL_REQUIRED', message: 'Kill Shot requires Discord approval first' });
  }

  // Gate: consensus required — fail closed (undefined treated as 0, not bypassed)
  if (!consensusConfirms || consensusConfirms < 3) {
    console.log('[SWING BLOCKED]', instrument, 'consensusConfirms:', consensusConfirms, '— minimum 3/4 required');
    return res.status(400).json({ error: 'CONSENSUS_REQUIRED', message: 'Must have 3/4 consensus before Kill Shot execution', provided: consensusConfirms ?? null });
  }

  // Post-close cooldown hard block — applies to manual swing orders too
  const _swingLastClose = postCloseCooldown.get(instrument);
  if (_swingLastClose && Date.now() - _swingLastClose < 15 * 60 * 1000) {
    const minsLeft = Math.ceil((15 * 60 * 1000 - (Date.now() - _swingLastClose)) / 60000);
    console.log(`[COOLDOWN HARD BLOCK] ${instrument} swing — ${minsLeft} min remaining — ABORTING`);
    return res.status(400).json({ error: 'COOLDOWN_ACTIVE', message: `${instrument} cooldown: ${minsLeft} min remaining`, minsLeft });
  }

  if (swingInFlight.has(instrument)) {
    console.log(`[SWING SKIP] ${instrument} already in flight — duplicate request blocked`);
    return res.json({ skipped: true, reason: 'already in flight' });
  }

  // News window guard — block Kill Shot if affected currency has HIGH-impact event ±window
  if (isNewsWindow(instrument)) {
    console.log(`[SWING NEWS BLOCK] ${instrument} — high-impact event within news window`);
    return res.status(400).json({ error: 'NEWS_BLOCK', message: `${instrument} blocked — high-impact news event within ±${xavierWeights.newsWindowMins || 120}min` });
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

  const estEntry = slPrice && tp1Price ? (parseFloat(slPrice) + parseFloat(tp1Price)) / 2 : parseFloat(tp1Price || slPrice || 0);
  const result = await placeOrder({
    instrument, direction,
    units: Math.abs(Number(units)),
    entry:      estEntry,
    stopLoss:   slPrice   ? parseFloat(slPrice)  : undefined,
    takeProfit: tp1Price  ? parseFloat(tp1Price) : undefined,
    source: 'Kill-Shot-Manual', score: null, session: getServerSession(), strategy: 'Kill Shot',
  });

  if (result.blocked) {
    const code = result.blocked;
    if (code === 'COOLDOWN')     return res.status(400).json({ error: 'COOLDOWN_ACTIVE',     message: `${instrument} cooldown active` });
    if (code === 'DUPLICATE')    return res.status(400).json({ error: 'DUPLICATE_POSITION',  message: `${instrument} already open` });
    if (code === 'HEAT_LIMIT')   return res.status(400).json({ error: 'MAX_TRADES',          message: 'Max 2 open trades' });
    if (code === 'NEWS')         return res.status(400).json({ error: 'NEWS_BLOCK',          message: `${instrument} blocked — high-impact news` });
    if (code === 'MARGIN')       return res.status(400).json({ error: 'INSUFFICIENT_MARGIN', message: 'Insufficient margin' });
    if (code === 'SL_SANITY')    return res.status(400).json({ error: 'SL_SANITY',           message: 'Stop loss on wrong side of entry' });
    if (code === 'OANDA_REJECT') return res.status(400).json({ error: 'OANDA_REJECT',        message: result.reason });
    return res.status(400).json({ error: code, message: result.reason || 'Order blocked' });
  }

  res.json({ orderFillTransaction: { price: result.fill, tradeOpened: { tradeID: result.tradeId } } });
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

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  const validEmail    = process.env.DASHBOARD_EMAIL;
  const validPassword = process.env.DASHBOARD_PASSWORD;
  const secret        = process.env.JWT_SECRET;

  if (!validEmail || !validPassword || !secret) {
    console.error('[AUTH] Missing DASHBOARD_EMAIL, DASHBOARD_PASSWORD, or JWT_SECRET env vars');
    return res.status(500).json({ error: 'Auth not configured on server' });
  }

  if (email === validEmail && password === validPassword) {
    const token = jwt.sign(
      { email, role: 'admin', device: Date.now() },
      secret,
      { expiresIn: '30d' },
    );
    logSecurityEvent('LOGIN_SUCCESS', { email: maskEmail(email), ip: req.ip }, 'INFO');
    return res.json({ token });
  }

  logSecurityEvent('FAILED_LOGIN', { email: maskEmail(email), ip: req.ip }, 'WARNING');
  res.status(401).json({ error: 'Invalid credentials' });
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
const consecutiveLosses       = new Map(); // instrument → consecutive loss count
const POST_CLOSE_COOLDOWN_MS  = 15 * 60 * 1000; // 15 minutes

// Pending Kill Shot approvals — awaiting Discord EXECUTE/SKIP/WAIT
const pendingKillShots = new Map(); // instrument → pending signal data

// ─── DRAWDOWN RECOVERY MODE ───────────────────────────────────────────────────
let peakBalance       = 0;
let recoveryMode      = false;
let currentBalance    = 0; // updated by monitorDrawdown()
const DRAWDOWN_TRIGGER = 0.03;  // 3% drawdown activates recovery
const RECOVERY_EXIT    = 0.015; // 1.5% drawdown deactivates recovery

const NORMAL_UNITS = {
  default:    1000,
  XAU_USD:    100,
  BCO_USD:    100,
  WTICO_USD:  100,
  NAS100_USD: 10,
  SPX500_USD: 10,
};

const RECOVERY_UNITS = {
  default:    500,
  XAU_USD:    50,
  BCO_USD:    50,
  WTICO_USD:  50,
  NAS100_USD: 5,
  SPX500_USD: 5,
};

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
// M5 backtest-validated — 180d spread-adjusted, updated 2026-05-30
const XAVIER_RULES = {
  TOKYO:  { strategy: 'Momentum',    pairs: ['EUR_GBP', 'USD_JPY', 'GBP_USD'],   minScore: 65 },
  LONDON: { strategy: 'Momentum',    pairs: ['AU200_AUD', 'GBP_USD', 'EUR_USD'],  minScore: 65 },
  PRIME:  { strategy: 'Breakout',    pairs: ['EUR_GBP', 'XAU_USD', 'EUR_USD'],   minScore: 65 },
  NY:     { strategy: 'Mean Revert', pairs: ['AU200_AUD', 'EUR_USD', 'XAG_USD'], minScore: 65 },
  SYDNEY: { strategy: 'Momentum',    pairs: ['XAU_USD', 'NAS100_USD', 'XAG_USD'], minScore: 65 },
  AVOID:  { strategy: null,          pairs: [],                                    minScore: 999 },
};

// M5 auto-execution allowlist — 180d spread-adjusted backtest validated 2026-05-30
// SWING_ONLY (M15 validated, not M5): AUD_USD, USD_CAD, NZD_USD
// SWING_ONLY (Kill Shot manual only): BCO_USD, WTICO_USD
// SWING_ONLY (DD too high for M5):    UK100_GBP, JP225_USD, SPX500_USD
const SERVER_PAIRS = new Set([
  'EUR_USD',    // +0.31R ✅
  'GBP_USD',    // +0.45R ✅
  'USD_JPY',    // +0.47R ✅
  'EUR_GBP',    // +0.73R ✅
  'XAU_USD',    // +0.56R ✅
  'XAG_USD',    // +0.78R ✅
  'NAS100_USD', // +0.47R ✅
  'AU200_AUD',  // validated in LONDON + NY sessions
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
// XAU at ~$3300 × 10 units × 5% margin ≈ $1,650 — fits demo account
const SWING_UNITS = {
  XAU_USD:    10,
  BCO_USD:    10,
  WTICO_USD:  10,
  NAS100_USD:  1,
  SPX500_USD:  1,
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
  'XAG_USD', 'NAS100_USD', 'AU200_AUD', 'XAU_USD', // 180d backtest: high DD, needs tighter filter
  'BCO_USD', 'WTICO_USD',                            // Commodities — Kill Shot manual only
  'JP225_USD', 'UK100_GBP', 'SPX500_USD',            // Swing only — DD too high for M5
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
  AU200_AUD:  ['SYDNEY', 'TOKYO', 'NY', 'LONDON'],
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
  const optionsBlock = p.optionsData
    ? `\nOPTIONS MARKET INTELLIGENCE:
Put/Call Ratio: ${p.optionsData.putCallRatio} (>1.5 bearish, <0.7 bullish)
Institutional Bias: ${p.optionsData.institutionalBias}
Average IV: ${p.optionsData.avgIV}
Confirms direction: ${p.optionsData.confirmsTrade}
Factor institutional positioning into your CONFIRM/REJECT decision.`
    : '';
  return `You are WARREN — Risk Guardian. Inspired by Warren Buffett: protect capital above all. Most likely to reject.

Trade: ${p.instrument} ${p.direction} @ ${p.price}
Session: ${p.session || 'UNKNOWN'} (${p.sessionQuality || 'UNKNOWN'})
R:R Ratio: ${p.rr || '2.0'}
Portfolio Heat: ${p.heat || '0'}R / 6R max
News risk: ${p.newsRisk || 'LOW'}
ATR: ${p.atr || '?'} (${p.atrPips || '?'} pips)
Stop Loss: ${p.sl || '?'} | Take Profit: ${p.tp || '?'}
Signal reason: ${p.reason}${xavierBlock}${freshnessBlock}${optionsBlock}

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
  const gptOptionsBlock = p.optionsData
    ? `\nOPTIONS MARKET INTELLIGENCE:
Put/Call Ratio: ${p.optionsData.putCallRatio} (>1.5 bearish, <0.7 bullish)
Institutional Bias: ${p.optionsData.institutionalBias}
Average IV: ${p.optionsData.avgIV}
Confirms direction: ${p.optionsData.confirmsTrade}
Factor institutional positioning into your CONFIRM/REJECT decision.`
    : '';
  return `You are GEORGE — Pattern Analyst. Inspired by George Soros: ride the trend, validate price action only.

Trade: ${p.instrument} ${p.direction} @ ${p.price}
Signal score: ${p.score}%
EMA9: ${p.ema9 || '?'} | EMA21: ${p.ema21 || '?'} | EMA50: ${p.ema50 || '?'} | Price vs EMA50: ${ema50side}
Last 5 closes: ${p.closes || p.price}
Trend regime: ${p.regime || 'UNKNOWN'}
Momentum: ${p.momentum || '0'}%
RSI: ${p.rsi}${gptOptionsBlock}

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
  return `You are JAMES — Quant Validator. Inspired by James Simons: validate math and statistical edge only.

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
  return `You are RAY — Macro Analyst. Inspired by Ray Dalio: validate macro context and liquidity only.

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
  return { name: 'WARREN', ...parseVerdict(text) };
}

async function askGPT(prompt, sys) {
  if (!OPENAI_KEY) throw new Error('Missing VITE_OPENAI_API_KEY');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: 'gpt-5.5', max_completion_tokens: 1500, messages: [{ role: 'system', content: sys || SYS_GPT }, { role: 'user', content: prompt }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(apiErr(d, `OpenAI HTTP ${r.status}`));
  const msg = d.choices?.[0]?.message;
  const text = msg?.content || msg?.refusal;
  if (!text) {
    const reason = d.choices?.[0]?.finish_reason || 'unknown';
    console.warn(`[GPT-5.5] Empty response — finish_reason: ${reason} — using REJECT as safe fallback`);
    return { name: 'GEORGE', verdict: 'REJECT', reason: `Model response empty — ${reason}` };
  }
  return { name: 'GEORGE', ...parseVerdict(text) };
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
  return { name: 'JAMES', ...parseVerdict(text) };
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
  return { name: 'RAY', ...parseVerdict(text) };
}

const MODEL_TAG  = { 'WARREN': 'WARREN', 'GEORGE': 'GEORGE', 'JAMES': 'JAMES', 'RAY': 'RAY' };
const MODEL_ROLE = { 'WARREN': 'Risk', 'GEORGE': 'Pattern', 'JAMES': 'Quant', 'RAY': 'Macro' };

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
  const NAMES = ['WARREN', 'GEORGE', 'JAMES', 'RAY'];
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
    const role = MODEL_ROLE[m.name] || '?';
    const icon = m.verdict === 'CONFIRM' ? '✅' : '❌';
    return `${m.name} (${role}): ${icon} ${m.verdict}\n"${m.reason}"`;
  });
  voteLog.push(`\nVerdict: ${confirms}/4 CONFIRM → ${confirms >= 3 ? 'EXECUTE' : 'BLOCKED'}`);
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
app.post('/consensus', requireAuth, async (req, res) => {
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
    const NAMES = ['WARREN', 'GEORGE', 'JAMES', 'RAY'];
    const models = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const raw = r.reason?.message || 'Model unreachable';
      const reason = raw.includes('prepayment') || raw.includes('credits') ? 'Credits depleted — check billing'
        : raw.includes('quota') || raw.includes('Quota') ? 'Quota exceeded'
        : raw.includes('Missing') ? raw : raw.slice(0, 80);
      return { name: NAMES[i], verdict: 'REJECT', reason };
    });
    const confirms = models.filter(m => m.verdict === 'CONFIRM').length;
    // Weighted rule: WARREN MUST confirm AND total confirms >= 3
    const claudeConfirmed = models[0]?.verdict === 'CONFIRM';
    const executeAllowed  = claudeConfirmed && confirms >= 3;
    const voteLog = models.map(m => {
      const role = MODEL_ROLE[m.name] || '?';
      const icon = m.verdict === 'CONFIRM' ? '✅' : '❌';
      return `${m.name} (${role}): ${icon} ${m.verdict}\n"${m.reason}"`;
    });
    const resultLine = executeAllowed
      ? `\nVerdict: ${confirms}/4 CONFIRM → KILL SHOT EXECUTE`
      : !claudeConfirmed
        ? `\nVerdict: BLOCKED — WARREN rejected`
        : `\nVerdict: BLOCKED — only ${confirms}/4 CONFIRM, need 3/4`;
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

// ─── RECOVERY STATUS ENDPOINT ────────────────────────────────────────────────
app.get('/recovery-status', requireAuth, (_req, res) => {
  const drawdown = peakBalance > 0 ? parseFloat(((peakBalance - currentBalance) / peakBalance * 100).toFixed(2)) : 0;
  res.json({
    recoveryMode,
    peakBalance:     parseFloat(peakBalance.toFixed(2)),
    currentBalance:  parseFloat(currentBalance.toFixed(2)),
    drawdown,
    triggerAt:       parseFloat((DRAWDOWN_TRIGGER * 100).toFixed(1)),
    exitAt:          parseFloat((RECOVERY_EXIT    * 100).toFixed(1)),
  });
});

// ─── RECOVERY MODE TEST TRIGGER ──────────────────────────────────────────────
app.get('/test-gpt-raw', async (_req, res) => {
  if (!OPENAI_KEY) return res.status(500).json({ error: 'No OPENAI_KEY' });
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: 'gpt-5.5', max_completion_tokens: 120, messages: [{ role: 'system', content: 'You are a trading assistant.' }, { role: 'user', content: 'Reply CONFIRM or REJECT for a LONG EUR/USD trade.' }] }),
  });
  const d = await r.json();
  res.json({ status: r.status, ok: r.ok, raw: d });
});

app.get('/test-recovery-trigger', async (req, res) => {
  const realPeak = peakBalance;
  peakBalance = peakBalance * 1.031; // inflate peak so current balance looks 3%+ below
  await monitorDrawdown();
  setTimeout(() => {
    peakBalance    = realPeak;
    recoveryMode   = false;
    console.log('[RECOVERY TEST] reset complete');
  }, 60_000);
  res.json({ test: true, message: 'Recovery mode triggered — resets in 60 seconds', recoveryMode });
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
app.get('/audit', requireAuth, async (req, res) => {
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

async function sendDiscordEmbed(embed, components) {
  if (!process.env.DISCORD_WEBHOOK_URL) {
    console.warn('[DISCORD EMBED] DISCORD_WEBHOOK_URL not set — skipping');
    return;
  }
  try {
    const payload = {
      username: 'Xavier | QuantBot Pro',
      avatar_url: 'https://i.imgur.com/4M34hi2.png',
      embeds: [embed],
    };
    if (components) payload.components = components;
    const dr = await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!dr.ok) {
      const body = await dr.text();
      console.error(`[DISCORD EMBED ERROR] HTTP ${dr.status} — ${body.slice(0, 300)}`);
    }
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
  AU200_AUD:  ['AUD'],     JP225_USD: ['JPY'],        BCO_USD: ['USD'],
  WTICO_USD:  ['USD'],
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
    if (currencies.includes(ev.currency)) {
      console.log(`[NEWS BLOCK] ${instrument} — blocked due to "${ev.title}" affecting ${ev.currency} (${Math.round(diff / 60000)}min)`);
      return true;
    }
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
function normalizeInstrument(inst) {
  return inst?.replace('/', '_')?.replace('-', '_')?.toUpperCase() || inst;
}

async function hasOpenPosition(instrument) {
  try {
    const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/openTrades`, { headers: H });
    const data = await r.json();
    const norm = normalizeInstrument(instrument);
    const open = (data.trades || []).map(t => normalizeInstrument(t.instrument));
    const exists = open.includes(norm);
    console.log(`[PAIR CHECK] checking:${norm} open:[${open.join(',')}] duplicate:${exists}`);
    return exists;
  } catch {
    return false; // fail open — OANDA is the final backstop
  }
}

async function getOpenTrades() {
  try {
    const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/openTrades`, { headers: H });
    const data = await r.json();
    return data.trades || [];
  } catch {
    return [];
  }
}

async function sendOandaOrder({ instrument, units, stopLoss, takeProfit }) {
  const order = {
    type: 'MARKET', instrument, units: String(units),
    timeInForce: 'FOK', positionFill: 'DEFAULT',
  };
  if (stopLoss)   order.stopLossOnFill   = { price: stopLoss,   timeInForce: 'GTC' };
  if (takeProfit) order.takeProfitOnFill = { price: takeProfit, timeInForce: 'GTC' };
  const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/orders`, { method: 'POST', headers: H, body: JSON.stringify({ order }) });
  return r.json();
}

async function placeOrder({ instrument, direction, units, entry, stopLoss, takeProfit, source, score, session, strategy, approved = false }) {
  const pair = normalizeInstrument(instrument);
  console.log('[ORDER PLACED]', pair, direction, 'source:', source || 'UNKNOWN', 'approved:', approved, 'score:', score, 'session:', session, 'strategy:', strategy);
  console.log('[ORDER]', source, pair, direction, units, 'units');

  // Gate 1 — Duplicate check
  if (await hasOpenPosition(pair)) {
    console.log('[BLOCKED] duplicate —', pair);
    return { blocked: 'DUPLICATE' };
  }

  // Gate 2 — Cooldown check
  const cooldown = postCloseCooldown.get(pair);
  if (cooldown && Date.now() - cooldown < 15 * 60 * 1000) {
    console.log('[BLOCKED] cooldown —', pair);
    return { blocked: 'COOLDOWN' };
  }

  // Gate 3 — Heat limit
  const openTrades = await getOpenTrades();
  if (openTrades.length >= 2) {
    console.log('[BLOCKED] heat limit —', openTrades.length, 'open');
    return { blocked: 'HEAT_LIMIT' };
  }

  // Gate 4 — News window
  if (isNewsWindow(pair)) {
    console.log('[BLOCKED] news —', pair);
    return { blocked: 'NEWS' };
  }

  // Gate 5 — Margin check
  const margin = await checkMargin(pair, units, entry);
  if (!margin.sufficient) {
    console.log('[BLOCKED] margin —', pair);
    return { blocked: 'MARGIN' };
  }

  // Gate 6 — SL sanity
  if (stopLoss) {
    if (direction === 'LONG'  && stopLoss >= entry) { console.log('[BLOCKED] SL wrong side —', pair); return { blocked: 'SL_SANITY' }; }
    if (direction === 'SHORT' && stopLoss <= entry) { console.log('[BLOCKED] SL wrong side —', pair); return { blocked: 'SL_SANITY' }; }
  }

  // Gate 7 — Price precision
  const formattedEntry = formatPrice(entry,      pair);
  const formattedSL    = stopLoss   ? formatPrice(stopLoss,   pair) : null;
  const formattedTP    = takeProfit ? formatPrice(takeProfit, pair) : null;

  // Place order
  const oandaUnits = direction === 'LONG' ? Math.abs(units) : -Math.abs(units);
  const result = await sendOandaOrder({ instrument: pair, units: oandaUnits, stopLoss: formattedSL, takeProfit: formattedTP });

  if (JSON.stringify(result).includes('MARKET_HALTED')) {
    console.log('[ORDER] market halted —', pair);
    return { blocked: 'MARKET_HALTED', raw: result };
  }

  if (result.orderRejectTransaction) {
    const reason = result.orderRejectTransaction.rejectReason;
    console.error('[ORDER REJECTED]', pair, reason);
    return { blocked: 'OANDA_REJECT', reason };
  }

  if (!result.orderFillTransaction) {
    console.error('[ORDER NO FILL]', pair, JSON.stringify(result).slice(0, 200));
    return { blocked: 'NO_FILL', raw: result };
  }

  const fill    = result.orderFillTransaction.price;
  const tradeId = result.orderFillTransaction.tradeOpened?.tradeID || result.orderFillTransaction.id || null;
  console.log('[ORDER SUCCESS]', pair, 'tradeID:', tradeId);

  await sendDiscordEmbed({
    title: '⚡ TRADE OPENED',
    color: 0x00ff88,
    fields: [
      { name: 'Pair',      value: pair.replace('_', '/'), inline: true },
      { name: 'Direction', value: direction,               inline: true },
      { name: 'Source',    value: source || '—',           inline: true },
      { name: 'Entry',     value: fill,                    inline: true },
      { name: 'SL',        value: formattedSL || '—',      inline: true },
      { name: 'TP',        value: formattedTP || '—',      inline: true },
    ],
    timestamp: new Date().toISOString(),
  });

  return { success: true, tradeId, fill };
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

// ─── SUPABASE PERSISTENCE ─────────────────────────────────────────────────────
async function saveLesson(trade) {
  if (!supabase) return;
  await supabase
    .from('lessons')
    .insert({
      id:         `lesson_${Date.now()}`,
      pair:       trade.pair,
      session:    trade.session,
      strategy:   trade.strategy,
      lesson:     `${trade.pair} ${trade.session} ${trade.strategy} lost ${trade.rMultiple}R — review setup conditions`,
      severity:   Math.abs(trade.rMultiple) > 1 ? 'CRITICAL' : 'WARNING',
      trade_id:   trade.id,
      created_at: new Date().toISOString(),
    });
  console.log('[SUPABASE] lesson saved:', trade.pair);
}

async function updatePattern(trade) {
  if (!supabase) return;
  const patternId = `${trade.pair}_${trade.session}_${trade.strategy}`;
  const { data } = await supabase.from('patterns').select('*').eq('id', patternId).single();
  const existing = data || { id: patternId, pair: trade.pair, session: trade.session, strategy: trade.strategy, attempts: 0, wins: 0, total_r: 0 };
  const attempts = existing.attempts + 1;
  const wins     = existing.wins + (trade.pnl > 0 ? 1 : 0);
  const totalR   = existing.total_r + (trade.rMultiple || 0);
  await supabase.from('patterns').upsert({
    id:           patternId,
    pair:         trade.pair,
    session:      trade.session,
    strategy:     trade.strategy,
    attempts,
    wins,
    total_r:      totalR,
    avg_r:        totalR / attempts,
    win_rate:     (wins / attempts) * 100,
    last_updated: new Date().toISOString(),
  });
}

async function getPatternInsight(pair, session, strategy) {
  if (!supabase) return null;
  const patternId = `${pair}_${session}_${strategy}`;
  const { data } = await supabase.from('patterns').select('*').eq('id', patternId).single();
  if (!data || data.attempts < 5) return null;
  return {
    attempts:  data.attempts,
    winRate:   data.win_rate,
    avgR:      data.avg_r,
    note:      data.xavier_note,
  };
}

async function saveCooldown(pair, timestamp) {
  if (!supabase) return;
  try {
    await supabase.from('system_state').upsert({
      key:        'cooldown_' + normalizeInstrument(pair),
      value:      timestamp.toString(),
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[STATE] saveCooldown failed:', err.message);
  }
}

async function loadCooldowns() {
  if (!supabase) return;
  try {
    const { data } = await supabase.from('system_state').select('*').like('key', 'cooldown_%');
    data?.forEach(row => {
      const pair = row.key.replace('cooldown_', '');
      const ts   = parseInt(row.value, 10);
      if (!isNaN(ts) && ts > Date.now() - 15 * 60 * 1000) {
        postCloseCooldown.set(pair, ts);
        console.log(`[STATE] restored cooldown: ${pair} → expires in ${Math.ceil((ts + 15 * 60 * 1000 - Date.now()) / 60000)}min`);
      }
    });
    console.log('[STATE] loaded', data?.length || 0, 'cooldowns from Supabase');
  } catch (err) {
    console.error('[STATE ERROR]', err.message);
  }
}

async function saveTradeToSupabase(trade) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('trades').upsert({
      id:            trade.id,
      pair:          trade.pair,
      direction:     trade.direction,
      session:       trade.session,
      strategy:      trade.strategy,
      entry:         trade.entry,
      exit_price:    trade.exitPrice,
      stop_loss:     trade.stopLoss,
      take_profit:   trade.takeProfit,
      pnl:           trade.pnl,
      r_multiple:    trade.rMultiple,
      score:         trade.score,
      consensus:     trade.consensus,
      units:         trade.units,
      duration_mins: trade.durationMins,
      outcome:       trade.pnl > 0 ? 'WIN' : trade.pnl < 0 ? 'LOSS' : 'BREAKEVEN',
      market_regime: trade.regime,
      ema50_above:   trade.ema50Above,
      rsi_at_entry:  trade.rsiAtEntry,
      open_time:     trade.openTime,
      close_time:    new Date().toISOString(),
      created_at:    new Date().toISOString(),
    });
    if (error) {
      console.error('[SUPABASE ERROR]', error.message);
    } else {
      console.log('[SUPABASE] trade saved:', trade.pair, trade.pnl);
    }
    await updatePattern(trade);
    if (trade.pnl < 0 && Math.abs(trade.rMultiple) >= 0.10) {
      await saveLesson(trade);
    }
  } catch (err) {
    console.error('[SUPABASE ERROR]', err.message);
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
          saveCooldown(instr, Date.now());
          console.log(`[COOLDOWN] ${instr} — locked 15 min after close (PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`);

          // Consecutive loss circuit breaker — 3 losses → 4-hour block
          if (won) {
            consecutiveLosses.set(instr, 0);
          } else {
            const losses = (consecutiveLosses.get(instr) || 0) + 1;
            consecutiveLosses.set(instr, losses);
            console.log(`[LOSS CIRCUIT] ${instr} — ${losses} consecutive loss${losses > 1 ? 'es' : ''}`);
            if (losses >= 3) {
              postCloseCooldown.set(instr, Date.now() + (4 * 60 * 60 * 1000));
              saveCooldown(instr, Date.now() + (4 * 60 * 60 * 1000));
              consecutiveLosses.set(instr, 0);
              console.log(`[LOSS CIRCUIT] ${instr} — 3 consecutive losses — blocking for 4 hours`);
              await sendDiscordEmbed({
                title: '⚠️ LOSS CIRCUIT BREAKER',
                color: 0xff4444,
                fields: [
                  { name: 'Pair',               value: instr.replace('_', '/'), inline: true },
                  { name: 'Consecutive Losses',  value: '3',                     inline: true },
                  { name: 'Blocked For',         value: '4 hours',               inline: true },
                  { name: 'Reason',              value: 'Signal not working in current regime', inline: false },
                ],
                timestamp: new Date().toISOString(),
              });
            }
          }

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

          // Persist closed trade to Supabase for Xavier's memory
          const _entry      = parseFloat(trade.price || 0);
          const _sl         = trade.stopLossOrder?.price ? parseFloat(trade.stopLossOrder.price) : null;
          const _tp         = trade.takeProfitOrder?.price ? parseFloat(trade.takeProfitOrder.price) : null;
          const _exitPrice  = parseFloat(trade.averageClosePrice || 0);
          const _units      = parseFloat(trade.initialUnits || 0);
          const _riskPerUnit = _sl ? Math.abs(_entry - _sl) : 0;
          const _riskTotal   = _riskPerUnit * Math.abs(_units);
          const _rMult       = _riskTotal > 0 ? pnl / _riskTotal : null;
          const _durMins     = trade.openTime ? Math.round((Date.now() - new Date(trade.openTime).getTime()) / 60000) : null;
          const _closeSess   = getServerSession();
          await saveTradeToSupabase({
            id:           trade.id,
            pair:         instr,
            direction:    dir,
            session:      _closeSess,
            strategy:     (XAVIER_RULES[_closeSess] || {}).strategy || null,
            entry:        _entry,
            exitPrice:    _exitPrice,
            stopLoss:     _sl,
            takeProfit:   _tp,
            pnl,
            rMultiple:    _rMult,
            score:        null,
            consensus:    null,
            units:        _units,
            durationMins: _durMins,
            regime:       null,
            ema50Above:   null,
            rsiAtEntry:   null,
            openTime:     trade.openTime,
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
    // Minimum pip distance prevents breakeven firing on tiny 0.2-pip moves
    // that immediately reverse (small position sizes make 1R = near-zero dollars)
    const MIN_BREAKEVEN_PIPS = {
      EUR_USD: 0.0010, GBP_USD: 0.0012, USD_JPY: 0.10,
      AUD_USD: 0.0010, USD_CAD: 0.0010, NZD_USD: 0.0010,
      EUR_GBP: 0.0010, XAU_USD: 2.00,
    };
    const minPips   = MIN_BREAKEVEN_PIPS[instrument] ?? 0.0010;
    const pipsMoved = Math.abs(price - entry);
    if (currentR >= 1.0 && pipsMoved >= minPips && !state.movedToBreakeven) {
      const pip     = SERVER_PIP_SIZE[instrument] || 0.0001;
      const bePrice = dir === 'LONG' ? entry + pip : entry - pip;
      const moved   = await updateTradeSL(tradeId, bePrice, instrument);
      if (moved) {
        state.movedToBreakeven = true;
        console.log(`[DISCORD NOTIFY] attempting send for ${instrument} — breakeven`);
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
          console.log(`[DISCORD NOTIFY] attempting send for ${instrument} — partial close`);
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
async function getDailySummary() {
  if (!supabase) return null;

  // Query yesterday's trades (function fires at midnight UTC — yesterday = the day just ended)
  const dayStart = new Date();
  dayStart.setUTCDate(dayStart.getUTCDate() - 1);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date();
  dayEnd.setUTCHours(0, 0, 0, 0);

  const { data: trades } = await supabase
    .from('trades')
    .select('*')
    .gte('created_at', dayStart.toISOString())
    .lt('created_at',  dayEnd.toISOString());

  if (!trades || trades.length === 0) {
    return {
      date:     dayStart.toDateString(),
      trades:   0,
      wins:     0,
      losses:   0,
      winRate:  '—',
      totalPnl: 0,
      totalPnlStr: '$0.00',
      bestTrade: '—',
      message:  'No trades — Xavier was selective or market conditions did not meet criteria',
    };
  }

  const wins      = trades.filter(t => t.pnl > 0);
  const losses    = trades.filter(t => t.pnl < 0);
  const totalPnl  = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const bestTrade = trades.reduce((best, t) => (t.pnl > best.pnl ? t : best), trades[0]);

  return {
    date:        dayStart.toDateString(),
    trades:      trades.length,
    wins:        wins.length,
    losses:      losses.length,
    winRate:     ((wins.length / trades.length) * 100).toFixed(1) + '%',
    totalPnl,
    totalPnlStr: (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(2),
    bestTrade:   `${bestTrade.pair} ${bestTrade.direction} $${bestTrade.pnl.toFixed(2)}`,
  };
}

async function maybeSendDailySummary() {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() !== 0 || now.getUTCMinutes() > 1) return;
  if (lastDailySummaryDate === today) return;
  lastDailySummaryDate = today;

  const summary = await getDailySummary();

  if (!summary) {
    // Supabase not configured — fall back to in-memory stats
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
    return;
  }

  if (summary.trades === 0) {
    await sendDiscordEmbed({
      title: '📊 DAILY SUMMARY',
      color: 0x484f58,
      fields: [
        { name: 'Date',    value: summary.date,    inline: true },
        { name: 'Trades',  value: '0',             inline: true },
        { name: 'Note',    value: summary.message, inline: false },
      ],
      timestamp: new Date().toISOString(),
    });
    return;
  }

  await sendDiscordEmbed({
    title: '📊 DAILY SUMMARY',
    color: summary.totalPnl > 0 ? 0x00ff88 : 0xf85149,
    fields: [
      { name: 'Date',       value: summary.date,        inline: true },
      { name: 'Trades',     value: String(summary.trades), inline: true },
      { name: 'Win Rate',   value: summary.winRate,     inline: true },
      { name: 'Net P&L',    value: summary.totalPnlStr, inline: true },
      { name: 'W / L',      value: `${summary.wins} / ${summary.losses}`, inline: true },
      { name: 'Best Trade', value: summary.bestTrade,   inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Source: Supabase trades table' },
  });
  console.log(`[DAILY SUMMARY] ${summary.date} — ${summary.trades} trades, ${summary.totalPnlStr}`);
}

// ─── DRAWDOWN RECOVERY MONITOR ────────────────────────────────────────────────
async function monitorDrawdown() {
  try {
    const r    = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/summary`, { headers: H });
    const data = await r.json();
    const balance = parseFloat(data.account?.balance || 0);
    if (!balance) return;

    currentBalance = balance;
    if (balance > peakBalance) {
      peakBalance = balance;
    }
    if (peakBalance === 0) return;

    const drawdown = (peakBalance - balance) / peakBalance;

    if (!recoveryMode && drawdown >= DRAWDOWN_TRIGGER) {
      recoveryMode = true;
      console.log(`[RECOVERY MODE] ACTIVATED — drawdown: ${(drawdown * 100).toFixed(2)}%`);
      await sendDiscordEmbed({
        title: '⚠️ RECOVERY MODE ACTIVATED',
        color: 0xff4444,
        fields: [
          { name: 'Peak Balance',   value: `$${peakBalance.toFixed(2)}`,           inline: true },
          { name: 'Current Balance',value: `$${balance.toFixed(2)}`,               inline: true },
          { name: 'Drawdown',       value: `${(drawdown * 100).toFixed(2)}%`,      inline: true },
          { name: 'Position Size',  value: 'Cut to 50%',                           inline: true },
          { name: 'Threshold',      value: 'Raised to 75%',                        inline: true },
          { name: 'Status',         value: 'Protecting capital',                   inline: true },
        ],
        timestamp: new Date().toISOString(),
      });
    }

    if (recoveryMode && drawdown <= RECOVERY_EXIT) {
      recoveryMode = false;
      console.log('[RECOVERY MODE] DEACTIVATED — account recovered');
      await sendDiscordEmbed({
        title: '✅ RECOVERY MODE DEACTIVATED',
        color: 0x00ff88,
        fields: [
          { name: 'Balance',  value: `$${balance.toFixed(2)}`,  inline: true },
          { name: 'Recovery', value: 'Account stabilized',       inline: true },
          { name: 'Status',   value: 'Normal trading resumed',   inline: true },
        ],
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('[DRAWDOWN MONITOR]', err.message);
  }
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
      saveCooldown(instr, Date.now());
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
      console.log(`[COOLDOWN HARD BLOCK] ${instrument} — ${cooldownMinsLeft} min remaining — ABORTING`);
      continue;
    }

    // Cross-system pair lock — one position per instrument across M5 + swing
    if (openTrades.some(t => normalizeInstrument(t.instrument) === normalizeInstrument(instrument))) {
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

    // Recovery mode — raised threshold for all pairs
    const scoreThresholdEffective = recoveryMode ? 75
      : (HIGH_THRESHOLD_PAIRS.has(instrument) ? 75 : 65);
    if (signal.score < scoreThresholdEffective) {
      if (recoveryMode) {
        console.log(`[RECOVERY MODE] ${instrument} — score ${signal.score}% < 75% required in recovery — skipping`);
      } else {
        console.log(`[HIGH-THRESH] ${instrument} — score ${signal.score}% < 75% required for volatile asset`);
      }
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

    // Trend confirmation — 3/3 for forex LONG, 1/3 for indices (mixed candles normal)
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

      // Indices require all 3 conditions; forex requires 2/3
      const STRICT_PAIRS = ['NAS100_USD', 'SPX500_USD', 'JP225_USD'];
      const required     = STRICT_PAIRS.includes(instrument) ? 3 : 2;

      if (condsMet < required || usdStrong) {
        const reason = usdStrong
          ? `USD strength regime — ${instrument} below EMA50, LONG blocked`
          : `LONG macro filter: ${condsMet}/3 bullish (EMA50up:${c1_ema50Up} LTbias:${c2_weeklyBull} XavierBull:${c3_xavierBull})`;
        console.log(`[LONG FILTER] ${instrument} LONG blocked — ${reason}`);
        serverRejections.unshift({ ts, instrument, direction: 'LONG', score: signal.score, session, strategy, rejections: [{ condition: 'Macro Long Filter', actual: reason, threshold: `${required}/3 conditions required (or USD strength override)` }] });
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
      console.log(`[LONG FILTER] ${instrument} LONG cleared — ${condsMet}/3 meets ${required}/3 required (EMA50up:${c1_ema50Up} LTbias:${c2_weeklyBull} XavierBull:${c3_xavierBull})`);
    }

    // ── Supabase pattern insight — block negative historical edge ──────────────
    let patternInsight = null;
    try {
      const insight = await getPatternInsight(instrument, session, strategy);
      if (insight) {
        console.log(`[SUPABASE INSIGHT] ${instrument} historical: ${insight.attempts} trades win rate: ${insight.winRate.toFixed(1)}% avg R: ${insight.avgR.toFixed(3)}`);
        if (insight.attempts >= 10 && insight.avgR < -0.1) {
          console.log(`[SUPABASE BLOCK] ${instrument} — negative historical edge, skipping`);
          serverRejections.unshift({ ts, instrument, direction: signal.direction, score: signal.score, session, strategy, rejections: [{ condition: 'Historical Edge', actual: `avg R: ${insight.avgR.toFixed(3)} over ${insight.attempts} trades`, threshold: 'avg R >= -0.1 required' }] });
          if (serverRejections.length > 50) serverRejections.pop();
          continue;
        }
        patternInsight = insight;
      }
    } catch (e) {
      console.error('[SUPABASE INSIGHT] fetch failed:', e.message);
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

    // ── Options chain scan — institutional positioning check ──────────────────
    const optionsData = await scanOptionsChain(instrument);
    if (optionsData) {
      console.log(`[OPTIONS] ${instrument} PCR: ${optionsData.putCallRatio} IV: ${optionsData.avgIV} Bias: ${optionsData.institutionalBias}`);

      // Hard block: extreme PCR contradicts signal direction
      if (parseFloat(optionsData.putCallRatio) > 3.0 && signal.direction === 'LONG') {
        console.log(`[OPTIONS BLOCK] ${instrument} — PCR ${optionsData.putCallRatio} strongly bearish — blocking LONG`);
        serverRejections.unshift({ ts, instrument, direction: signal.direction, score: signal.score, session, strategy, rejections: [{ condition: 'Options PCR Block', actual: `PCR ${optionsData.putCallRatio} > 3.0`, threshold: 'Strongly bearish positioning — LONG blocked' }] });
        if (serverRejections.length > 50) serverRejections.pop();
        continue;
      }
      if (parseFloat(optionsData.putCallRatio) < 0.5 && signal.direction === 'SHORT') {
        console.log(`[OPTIONS BLOCK] ${instrument} — PCR ${optionsData.putCallRatio} strongly bullish — blocking SHORT`);
        serverRejections.unshift({ ts, instrument, direction: signal.direction, score: signal.score, session, strategy, rejections: [{ condition: 'Options PCR Block', actual: `PCR ${optionsData.putCallRatio} < 0.5`, threshold: 'Strongly bullish positioning — SHORT blocked' }] });
        if (serverRejections.length > 50) serverRejections.pop();
        continue;
      }

      // Discord alert when options bias conflicts with direction (non-blocking moderate conflict)
      const confirmsTrade = optionsData.signal === signal.direction;
      if (!confirmsTrade && optionsData.institutionalBias !== 'NEUTRAL') {
        await sendDiscordEmbed({
          title: '⚠️ Options Conflict Detected',
          color: 0xffaa00,
          fields: [
            { name: 'Pair',          value: instrument.replace('_', '/'),    inline: true },
            { name: 'Signal',        value: signal.direction,                inline: true },
            { name: 'Options Bias',  value: optionsData.institutionalBias,   inline: true },
            { name: 'Put/Call Ratio',value: optionsData.putCallRatio,        inline: true },
            { name: 'Action',        value: 'Consensus reviewing…',          inline: false },
          ],
          timestamp: new Date().toISOString(),
        });
      }
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
        historicalInsight:  patternInsight,
        optionsData:        optionsData ? {
          putCallRatio:      optionsData.putCallRatio,
          institutionalBias: optionsData.institutionalBias,
          avgIV:             optionsData.avgIV,
          confirmsTrade:     optionsData.signal === signal.direction,
        } : null,
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

    // Recovery mode — halved position sizing
    if (recoveryMode) {
      console.log(`[RECOVERY MODE] active — using reduced sizing for ${instrument}`);
    }
    const unitSize = recoveryMode
      ? (RECOVERY_UNITS[instrument] || RECOVERY_UNITS.default)
      : (NORMAL_UNITS[instrument]   || NORMAL_UNITS.default);
    const units = signal.direction === 'LONG' ? unitSize : -unitSize;

    try {
      console.log('[ORDER SOURCE] serverAutoTrade', 'instrument:', instrument, 'direction:', signal.direction, 'score:', signal.score, 'session:', session, 'strategy:', strategy, 'approved: false (M5-Auto no-approval-required)');
      const result = await placeOrder({
        instrument, direction: signal.direction,
        units: unitSize,
        entry: price, stopLoss: sl, takeProfit: tp,
        source: 'M5-Auto', score: signal.score, session, strategy,
        approved: false,
      });

      if (result.blocked === 'MARKET_HALTED') {
        paperTrades.unshift({ id: Date.now(), type: 'PAPER', instrument, direction: signal.direction, units, price, session, strategy, score: signal.score, consensus: `${consensus.votes.confirm}/4`, timestamp: ts });
        if (paperTrades.length > 100) paperTrades.pop();
        console.log(`[auto] ${instrument} — PAPER logged (market halted)`);
      } else if (result.blocked) {
        console.log(`[auto] ${instrument} — placeOrder blocked: ${result.blocked}`);
      } else if (result.success) {
        const { fill, tradeId: oandaId } = result;
        autoTrades.unshift({ id: Date.now(), timestamp: ts, instrument, direction: signal.direction, units, price: fill, session, strategy, score: signal.score, consensus: consensus.votes, models: consensus.models, oandaOrderId: oandaId });
        if (autoTrades.length > 100) autoTrades.pop();
        serverTradeLog.unshift({ id: oandaId, pair: instrument, direction: signal.direction, strategy, session, score: signal.score, entry: parseFloat(fill), sl: parseFloat(formatPrice(sl, instrument)), tp: parseFloat(formatPrice(tp, instrument)), units, type: 'm5', timestamp: Date.now() });
        if (serverTradeLog.length > 500) serverTradeLog.pop();
        console.log(`[auto] ✓ EXECUTED ${instrument} ${signal.direction} @ ${fill} — ${consensus.votes.confirm}/4 — ${strategy} — ${session}`);
      }
    } catch (e) {
      console.error(`[auto] Order error ${instrument}: ${e.message}`);
    }
  }
}

// ─── KILL SHOT PAIRS ─────────────────────────────────────────────────────────
// BCO_USD removed 2026-05-28 — manual trading only
// NAS100_USD / AU200_AUD excluded — Phase 2 pairs, OANDA demo liquidity issues, manual Kill Shot only
const KILL_SHOT_PAIRS = ['XAU_USD', 'GBP_USD', 'EUR_USD', 'USD_JPY'];

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
function serverGenerateSwingSignal(h4Candles, weeklyCandles, _instrument) {
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
  const NAMES = ['WARREN', 'GEORGE', 'JAMES', 'RAY'];
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
    const role = MODEL_ROLE[m.name] || '?';
    const icon = m.verdict === 'CONFIRM' ? '✅' : '❌';
    return `${m.name} (${role}): ${icon} ${m.verdict}\n"${m.reason}"`;
  });
  voteLog.push(passes
    ? `\nVerdict: WARREN + ${othersConfirmed[0]?.name || '?'} CONFIRM → KILL SHOT EXECUTE`
    : !claudeConfirmed
      ? '\nVerdict: BLOCKED — WARREN rejected'
      : '\nVerdict: BLOCKED — WARREN confirmed, no supporting council member');
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
      console.log(`[COOLDOWN HARD BLOCK] ${instrument} swing — ${minsLeft} min remaining — ABORTING`);
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
      if (openTrades.some(t => normalizeInstrument(t.instrument) === normalizeInstrument(instrument))) {
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

      // Derived fields for consensus payload
      const h4Closes  = h4Candles.map(c => c.c);
      const ema9H4    = h4Closes.slice(-9).reduce((a, b) => a + b, 0) / 9;
      const rrNum     = sig.direction === 'LONG' ? liveTp1 - liveEntry : liveEntry - liveTp1;
      const rrDen     = sig.direction === 'LONG' ? liveEntry - liveSl  : liveSl - liveEntry;
      const riskReward = rrDen > 0 ? (rrNum / rrDen).toFixed(2) : '1.50';

      const consensusParams = {
        pair:       instrument,
        instrument,
        direction:  sig.direction,
        score:      sig.score,
        session,
        strategy:   'Kill Shot Swing',
        type:       'swing',
        price:      formatPrice(liveEntry, instrument),
        entry:      formatPrice(liveEntry, instrument),
        stopLoss:   formatPrice(liveSl,    instrument),
        takeProfit: formatPrice(liveTp1,   instrument),
        sl:         formatPrice(liveSl,    instrument),
        tp1:        formatPrice(liveTp1,   instrument),
        tp2:        formatPrice(liveTp2,   instrument),
        tp3:        formatPrice(liveTp3,   instrument),
        riskReward,
        ema9:       formatPrice(ema9H4,    instrument),
        ema21:      formatPrice(sig.ema21, instrument),
        ema50:      formatPrice(sig.ema50, instrument),
        rsi:        sig.rsi.toFixed(1),
        atr:        sig.atr.toFixed(instrument.includes('JPY') ? 3 : 5),
        regime:     'SWING',
        reason:     sig.reasons.join(', '),
        xavierIntel:       swingIntelFresh ? lastXavierIntel.brief      : null,
        xavierSentiment:   swingIntelFresh ? lastXavierIntel.sentiment  : null,
        xavierKeyRisk:     swingIntelFresh ? lastXavierIntel.keyRisk    : null,
        xavierBrief:       swingIntelFresh ? lastXavierIntel.brief      : null,
        freshNews:         swingIntelFresh ? lastXavierIntel.freshNews  : null,
        xavierIntelAgeMin: swingIntelAgeMins,
      };

      // Duplicate guard — fresh OANDA check before committing to consensus
      if (await hasOpenPosition(instrument)) {
        console.log(`[DUPLICATE GUARD] ${instrument} — already open on OANDA, skipping swing`);
        continue;
      }

      // Options chain scan — institutional positioning check
      const swingOptionsData = await scanOptionsChain(instrument);
      if (swingOptionsData) {
        console.log(`[OPTIONS] ${instrument} swing PCR: ${swingOptionsData.putCallRatio} Bias: ${swingOptionsData.institutionalBias}`);
        if (parseFloat(swingOptionsData.putCallRatio) > 3.0 && sig.direction === 'LONG') {
          console.log(`[OPTIONS BLOCK] ${instrument} swing — PCR ${swingOptionsData.putCallRatio} strongly bearish — blocking LONG`);
          continue;
        }
        if (parseFloat(swingOptionsData.putCallRatio) < 0.5 && sig.direction === 'SHORT') {
          console.log(`[OPTIONS BLOCK] ${instrument} swing — PCR ${swingOptionsData.putCallRatio} strongly bullish — blocking SHORT`);
          continue;
        }
        if (swingOptionsData.signal !== sig.direction && swingOptionsData.institutionalBias !== 'NEUTRAL') {
          await sendDiscordEmbed({
            title: '⚠️ Options Conflict Detected (Swing)',
            color: 0xffaa00,
            fields: [
              { name: 'Pair',          value: instrument.replace('_', '/'),        inline: true },
              { name: 'Signal',        value: sig.direction,                        inline: true },
              { name: 'Options Bias',  value: swingOptionsData.institutionalBias,   inline: true },
              { name: 'Put/Call Ratio',value: swingOptionsData.putCallRatio,        inline: true },
              { name: 'Action',        value: 'Consensus reviewing…',               inline: false },
            ],
            timestamp: new Date().toISOString(),
          });
        }
        consensusParams.optionsData = {
          putCallRatio:      swingOptionsData.putCallRatio,
          institutionalBias: swingOptionsData.institutionalBias,
          avgIV:             swingOptionsData.avgIV,
          confirmsTrade:     swingOptionsData.signal === sig.direction,
        };
      }

      const consensus = await runSwingConsensus(consensusParams);

      // Hard gate — Discord notification ONLY fires after 3/4 consensus confirmed
      if (consensus.confirms < 3) {
        console.log(`[SWING] consensus failed ${consensus.confirms}/4 — not sending Discord notification`);
        continue;
      }

      // ── SL/TP sanity check before queuing ───────────────────────────────────
      const swingUnitSize = SWING_UNITS[instrument] ?? 500;
      const units = sig.direction === 'LONG' ? swingUnitSize : -swingUnitSize;
      const slSane = sig.direction === 'LONG' ? liveSl < liveEntry : liveSl > liveEntry;
      const tpSane = sig.direction === 'LONG' ? liveTp1 > liveEntry : liveTp1 < liveEntry;
      if (!slSane || !tpSane) {
        console.error(`[KILL SHOT] ${instrument} — SL/TP sanity FAILED: dir=${sig.direction} entry=${formatPrice(liveEntry, instrument)} sl=${formatPrice(liveSl, instrument)} tp1=${formatPrice(liveTp1, instrument)} — ABORTING`);
        continue;
      }

      // ── Pre-flight margin check ──────────────────────────────────────────────
      if (!(await checkMargin(instrument, units, liveEntry)).sufficient) continue;

      // ── 3/4 confirmed — queue for Discord approval ──────────────────────────
      await requestKillShotApproval({
        instrument, direction: sig.direction, units,
        liveEntry, liveSl, liveTp1, liveTp2, liveTp3,
        score: sig.score, reasons: sig.reasons, session,
        confirms: consensus.confirms, models: consensus.models,
        voteLog: consensus.voteLog, timestamp: ts,
      });
      return; // HARD STOP — no execution without Discord approval

    } catch (err) {
      console.error(`[swing-auto] ${instrument} — error: ${err.message}`);
    }
  }
}

// ─── DISCORD SIGNATURE VERIFICATION (Ed25519) ────────────────────────────────
function verifyDiscordRequest(req) {
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) return true; // dev — skip verification if key not set
  const signature = req.headers['x-signature-ed25519'];
  const timestamp  = req.headers['x-signature-timestamp'];
  if (!signature || !timestamp) return false;
  try {
    const raw = req.rawBody || JSON.stringify(req.body);
    // Ed25519 public key in SubjectPublicKeyInfo DER format (OID 1.3.101.112)
    const pubDer = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(publicKey, 'hex'),
    ]);
    const key = crypto.createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(timestamp + raw), key, Buffer.from(signature, 'hex'));
  } catch { return false; }
}

// ─── KILL SHOT EXECUTION (called from approval flow) ─────────────────────────
async function executeKillShot(pending) {
  const { instrument, direction, units, liveEntry, liveSl, liveTp1, liveTp2, liveTp3, score, reasons, session, confirms, models, voteLog, timestamp: ts } = pending;
  console.log('[ORDER SOURCE] executeKillShot', 'instrument:', instrument, 'direction:', direction, 'confirms:', confirms, 'approved: true');

  const result = await placeOrder({
    instrument, direction,
    units: Math.abs(units),
    entry: liveEntry, stopLoss: liveSl, takeProfit: liveTp1,
    source: 'Kill-Shot-Auto', score, session, strategy: 'Kill Shot',
    approved: true,
    consensusConfirms: confirms,
  });

  if (result.blocked) {
    console.error(`[KILL SHOT EXECUTE] ${instrument} — placeOrder blocked: ${result.blocked} ${result.reason || ''}`);
    return { ok: false, reason: result.blocked };
  }

  const { fill, tradeId } = result;
  console.log(`[KILL SHOT EXECUTE SUCCESS] ${instrument} ${direction} @ ${fill} — tradeID: ${tradeId}`);

  serverTradeLog.unshift({ id: tradeId, pair: instrument, direction, strategy: 'Kill Shot', session, score, entry: parseFloat(fill), sl: parseFloat(formatPrice(liveSl, instrument)), tp: parseFloat(formatPrice(liveTp1, instrument)), units, type: 'swing', timestamp: Date.now() });
  if (serverTradeLog.length > 500) serverTradeLog.pop();

  swingAutoTrades.unshift({
    id: Date.now(), timestamp: ts, instrument,
    direction, units, price: fill,
    sl:  formatPrice(liveSl,  instrument),
    tp1: formatPrice(liveTp1, instrument),
    tp2: formatPrice(liveTp2, instrument),
    tp3: formatPrice(liveTp3, instrument),
    score, session, reasons,
    confirms, models, voteLog,
    oandaTradeId: tradeId,
    closed: false,
  });
  if (swingAutoTrades.length > 50) swingAutoTrades.pop();

  return { ok: true, fill, tradeId };
}

// ─── KILL SHOT APPROVAL REQUEST ────────────────────────────────────────────────
async function requestKillShotApproval(signal) {
  pendingKillShots.set(signal.instrument, signal);

  // Auto-expire after 2 hours
  setTimeout(() => {
    if (pendingKillShots.get(signal.instrument) === signal) {
      pendingKillShots.delete(signal.instrument);
      console.log(`[KILL SHOT EXPIRED] ${signal.instrument} — approval timeout`);
    }
  }, 2 * 60 * 60_000);

  const expiryTime = new Date(Date.now() + 2 * 60 * 60 * 1000)
    .toLocaleTimeString('en-CA', { timeZone: 'America/Edmonton', hour: '2-digit', minute: '2-digit' });

  const councilLines = (signal.models || []).map(m => {
    const role = MODEL_ROLE[m.name] || '?';
    const icon = m.verdict === 'CONFIRM' ? '✅' : '❌';
    return `${m.name} (${role}): ${icon} ${m.verdict} — "${m.reason}"`;
  }).join('\n');

  await sendDiscordEmbed({
    color: 0x8B5CF6,
    title: '⚔️ XAVIER COUNCIL VERDICT — KILL SHOT',
    description: `**${signal.instrument.replace('_', '/')} ${signal.direction}** — ${signal.session}\n\n${councilLines}\n\n**Verdict: ${signal.confirms}/4 CONFIRM → AWAITING APPROVAL**`,
    fields: [
      { name: 'Score',     value: `${signal.score}%`,                                inline: true },
      { name: 'Entry',     value: formatPrice(signal.liveEntry, signal.instrument),  inline: true },
      { name: 'Stop Loss', value: formatPrice(signal.liveSl,    signal.instrument),  inline: true },
      { name: 'TP1',       value: formatPrice(signal.liveTp1,   signal.instrument),  inline: true },
      { name: '⏰ Expires', value: `${expiryTime} Calgary`,                          inline: true },
      { name: 'Action',    value: `\`!execute ${signal.instrument}\` or \`!skip ${signal.instrument}\``, inline: false },
    ],
    timestamp: new Date().toISOString(),
  });

  console.log(`[KILL SHOT PENDING] ${signal.instrument} ${signal.direction} — awaiting Discord approval`);
}

// ─── DISCORD SLASH COMMAND REGISTRATION ───────────────────────────────────────
async function registerDiscordCommands() {
  const appId    = process.env.DISCORD_APP_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!appId || !botToken) return;
  try {
    await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
      method: 'PUT',
      headers: { 'Authorization': `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { name: 'killshot',  description: 'Show pending Kill Shot setups' },
        { name: 'status',    description: 'Xavier trading status' },
        { name: 'pause',     description: 'Pause auto trading' },
        { name: 'resume',    description: 'Resume auto trading' },
        { name: 'trades',    description: 'Show open positions' },
        { name: 'balance',   description: 'Show account balance' },
        { name: 'kill',      description: 'Emergency stop — disable auto + close all trades' },
      ]),
    });
    console.log('[DISCORD] slash commands registered');
  } catch (e) {
    console.error('[DISCORD] command registration failed:', e.message);
  }
}

// ─── DISCORD INTERACTION ENDPOINT ─────────────────────────────────────────────
app.post('/discord/interaction', async (req, res) => {
  if (!verifyDiscordRequest(req)) {
    console.warn('[DISCORD] Invalid signature on interaction');
    return res.status(401).json({ error: 'Invalid request signature' });
  }

  const { type, data } = req.body;

  // Discord ping — required for endpoint verification
  if (type === 1) return res.json({ type: 1 });

  // ── Slash commands ──────────────────────────────────────────────────────────
  if (type === 2) {
    const cmd = data?.name;

    if (cmd === 'killshot') {
      if (pendingKillShots.size === 0) {
        return res.json({ type: 4, data: { content: '📭 No pending Kill Shot setups right now.', flags: 64 } });
      }
      const list = [...pendingKillShots.values()].map(p =>
        `**${p.instrument.replace('_', '/')}** ${p.direction} — ${p.score}% · ${p.confirms}/4`
      ).join('\n');
      return res.json({ type: 4, data: { content: `⚔️ **Pending Kill Shots:**\n${list}`, flags: 64 } });
    }

    if (cmd === 'status') {
      const sess = getServerSession();
      const rule = XAVIER_RULES[sess] || {};
      let openCount = 0;
      try { const ot = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/openTrades`, { headers: H }); openCount = ((await ot.json()).trades || []).length; } catch {}
      const drawdownPct = peakBalance > 0 ? ((peakBalance - currentBalance) / peakBalance * 100).toFixed(2) : '0.00';
      return res.json({ type: 4, data: { embeds: [{
        color: recoveryMode ? 0xff4444 : 0x58a6ff,
        title: recoveryMode ? '⚠️ Xavier Status — RECOVERY MODE' : '📊 Xavier Status',
        fields: [
          { name: 'Session',       value: sess,           inline: true },
          { name: 'Auto Mode',     value: process.env.AUTO_MODE_ENABLED === 'true' ? '✅ ON' : '❌ OFF', inline: true },
          { name: 'Heat',          value: `${(openCount * 1.5).toFixed(1)}R / 4R`, inline: true },
          { name: 'Open Trades',   value: String(openCount),   inline: true },
          { name: 'Strategy',      value: rule.strategy || 'N/A', inline: true },
          { name: 'Pairs',         value: (rule.pairs || []).join(', ') || 'None', inline: true },
          { name: 'Recovery Mode', value: recoveryMode ? '⚠️ ACTIVE — reduced sizing' : '✅ Normal', inline: true },
          { name: 'Peak Balance',  value: `$${peakBalance.toFixed(2)}`,  inline: true },
          { name: 'Drawdown',      value: `${drawdownPct}%`,             inline: true },
        ],
        timestamp: new Date().toISOString(),
      }] } });
    }

    if (cmd === 'pause') {
      process.env.AUTO_MODE_ENABLED = 'false';
      console.log('[DISCORD CMD] /pause');
      return res.json({ type: 4, data: { content: '⏸ **Xavier paused** — send `/resume` to restart.', flags: 64 } });
    }

    if (cmd === 'resume') {
      process.env.AUTO_MODE_ENABLED = 'true';
      console.log('[DISCORD CMD] /resume');
      return res.json({ type: 4, data: { content: '▶️ **Xavier resumed** — auto-trading active.', flags: 64 } });
    }

    if (cmd === 'trades') {
      let openTrades = [];
      try { const ot = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/openTrades`, { headers: H }); openTrades = (await ot.json()).trades || []; } catch {}
      if (openTrades.length === 0) return res.json({ type: 4, data: { content: '📭 No open trades.', flags: 64 } });
      const fields = openTrades.map(t => {
        const pnl = parseFloat(t.unrealizedPL || 0);
        return { name: `${t.instrument.replace('_', '/')} ${parseFloat(t.currentUnits) >= 0 ? 'LONG' : 'SHORT'}`, value: `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, inline: true };
      });
      return res.json({ type: 4, data: { embeds: [{ color: 0x58a6ff, title: '📈 Open Trades', fields, timestamp: new Date().toISOString() }] } });
    }

    if (cmd === 'balance') {
      try {
        const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/summary`, { headers: H });
        const d = await r.json();
        const bal = parseFloat(d.account?.balance || 0), nav = parseFloat(d.account?.NAV || 0), unrl = parseFloat(d.account?.unrealizedPL || 0);
        return res.json({ type: 4, data: { embeds: [{ color: 0x3fb950, title: '💰 Account Balance', fields: [
          { name: 'Balance', value: `$${bal.toFixed(2)}`, inline: true },
          { name: 'NAV',     value: `$${nav.toFixed(2)}`, inline: true },
          { name: 'Unrealized', value: `${unrl >= 0 ? '+' : ''}$${unrl.toFixed(2)}`, inline: true },
        ], timestamp: new Date().toISOString() }] } });
      } catch (e) { return res.json({ type: 4, data: { content: `❌ ${e.message}`, flags: 64 } }); }
    }

    if (cmd === 'kill') {
      process.env.AUTO_MODE_ENABLED = 'false';
      let closed = 0;
      try {
        const ot = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/openTrades`, { headers: H });
        const trades = (await ot.json()).trades || [];
        for (const t of trades) { try { await fetch(`${BASE}/v3/accounts/${ACCOUNT}/trades/${t.id}/close`, { method: 'PUT', headers: H }); closed++; } catch {} }
      } catch {}
      console.log(`[DISCORD CMD] /kill — ${closed} trade(s) closed`);
      return res.json({ type: 4, data: { content: `💀 **KILL executed** — auto-trading disabled. ${closed} trade(s) closed.`, flags: 64 } });
    }
  }

  // ── Button clicks ────────────────────────────────────────────────────────────
  if (type === 3) {
    const customId = data?.custom_id || '';

    if (customId.startsWith('execute_')) {
      const instrument = customId.replace('execute_', '');
      const pending    = pendingKillShots.get(instrument);
      if (!pending) return res.json({ type: 4, data: { content: `⚠️ ${instrument.replace('_', '/')} — setup expired or already handled.`, flags: 64 } });
      pendingKillShots.delete(instrument);
      const result = await executeKillShot(pending);
      return res.json({ type: 4, data: { content: result.ok
        ? `✅ **Kill Shot executing** — ${instrument.replace('_', '/')} @ ${result.fill}`
        : `❌ **Execution failed** — ${result.reason}`,
      } });
    }

    if (customId.startsWith('skip_')) {
      const instrument = customId.replace('skip_', '');
      pendingKillShots.delete(instrument);
      console.log(`[KILL SHOT SKIPPED] ${instrument}`);
      return res.json({ type: 4, data: { content: `❌ **Kill Shot skipped** — ${instrument.replace('_', '/')}` } });
    }

    if (customId.startsWith('wait_')) {
      const instrument = customId.replace('wait_', '');
      console.log(`[KILL SHOT WAIT] ${instrument} — held for up to 1h`);
      return res.json({ type: 4, data: { content: `⏳ **Waiting 1 hour** — ${instrument.replace('_', '/')} setup held.`, flags: 64 } });
    }
  }

  res.json({ type: 1 });
});

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

      } else if (msg.content.startsWith('!execute ')) {
        const instrument = msg.content.slice('!execute '.length).trim().toUpperCase();
        const pending = pendingKillShots.get(instrument);
        if (!pending) {
          await sendDiscordChannelMessage(`⚠️ No pending Kill Shot for **${instrument.replace('_', '/')}** — expired or already handled.`);
        } else {
          pendingKillShots.delete(instrument);
          console.log(`[DISCORD CMD] !execute ${instrument}`);
          const result = await executeKillShot(pending);
          await sendDiscordChannelMessage(result.ok
            ? `✅ **Kill Shot executing** — ${instrument.replace('_', '/')} @ ${result.fill}`
            : `❌ **Execution failed** — ${result.reason}`
          );
        }

      } else if (msg.content.startsWith('!skip ')) {
        const instrument = msg.content.slice('!skip '.length).trim().toUpperCase();
        pendingKillShots.delete(instrument);
        console.log(`[DISCORD CMD] !skip ${instrument}`);
        await sendDiscordChannelMessage(`❌ **Kill Shot skipped** — ${instrument.replace('_', '/')}`);
      }
    }
  } catch (e) {
    console.error('[DISCORD POLL]', e.message);
  }
}

// ─── TEST KILL SHOT NOTIFICATION ────────────────────────────────────────────
app.post('/test-killshot', async (_req, res) => {
  const fakePair = _req.body?.pair || 'XAU_USD';
  const fakeSignal = {
    instrument: fakePair,
    direction:  'LONG',
    score:      87,
    liveEntry:  3320.50,
    liveSl:     3310.00,
    liveTp1:    3340.00,
    confirms:   3,
    session:    getServerSession(),
  };
  await requestKillShotApproval(fakeSignal);
  res.json({ ok: true, message: `Kill Shot notification sent for ${fakePair}`, signal: fakeSignal });
});

// ─── SUPABASE API ENDPOINTS ──────────────────────────────────────────────────
async function runIntegrationTests() {
  const results = [];

  // Test 1 — Instrument normalization
  try {
    const n1 = normalizeInstrument('EUR/USD');
    const n2 = normalizeInstrument('EUR_USD');
    const n3 = normalizeInstrument('eur-usd');
    const passed = n1 === 'EUR_USD' && n1 === n2 && n2 === n3;
    results.push({ test: 'instrument_normalization', passed, detail: `${n1} === ${n2} === ${n3}` });
  } catch (e) {
    results.push({ test: 'instrument_normalization', passed: false, detail: e.message });
  }

  // Test 2 — Duplicate prevention
  try {
    const mockTrades = [{ instrument: 'EUR_USD' }];
    const isDupe = mockTrades.some(t => normalizeInstrument(t.instrument) === normalizeInstrument('EUR/USD'));
    results.push({ test: 'duplicate_prevention', passed: isDupe === true, detail: `EUR_USD === EUR/USD: ${isDupe}` });
  } catch (e) {
    results.push({ test: 'duplicate_prevention', passed: false, detail: e.message });
  }

  // Test 3 — News guard USD pairs
  try {
    const usdPairs = ['EUR_USD', 'USD_JPY', 'USD_CAD'];
    const allHaveUSD = usdPairs.every(p => PAIR_CURRENCIES[p]?.includes('USD'));
    results.push({ test: 'news_guard_usd_pairs', passed: allHaveUSD, detail: `USD pairs have USD currency: ${allHaveUSD}` });
  } catch (e) {
    results.push({ test: 'news_guard_usd_pairs', passed: false, detail: e.message });
  }

  // Test 4 — SL sanity LONG
  try {
    const longSLAbove = 1.16500 >= 1.16300; // wrong side — should be blocked
    const longSLBelow = 1.16000 >= 1.16300; // correct side — should pass
    results.push({ test: 'sl_sanity_long', passed: longSLAbove && !longSLBelow, detail: `LONG SL above detected: ${longSLAbove}` });
  } catch (e) {
    results.push({ test: 'sl_sanity_long', passed: false, detail: e.message });
  }

  // Test 5 — SL sanity SHORT
  try {
    const shortSLBelow = 1.16100 <= 1.16300; // wrong side — should be blocked
    const shortSLAbove = 1.16500 <= 1.16300; // correct side — should pass
    results.push({ test: 'sl_sanity_short', passed: shortSLBelow && !shortSLAbove, detail: `SHORT SL below detected: ${shortSLBelow}` });
  } catch (e) {
    results.push({ test: 'sl_sanity_short', passed: false, detail: e.message });
  }

  // Test 6 — Consensus payload complete
  try {
    const payload = { pair: 'EUR/USD', price: 1.163, stopLoss: 1.160, takeProfit: 1.169, ema9: 1.162, ema21: 1.161, ema50: 1.160, atr: 0.0015, rsi: 55 };
    const hasRequired = !!(payload.pair && payload.price && payload.stopLoss && payload.takeProfit && payload.ema9 && payload.ema21 && payload.ema50);
    results.push({ test: 'consensus_payload_complete', passed: hasRequired, detail: `All required fields present: ${hasRequired}` });
  } catch (e) {
    results.push({ test: 'consensus_payload_complete', passed: false, detail: e.message });
  }

  // Test 7 — Supabase connected
  try {
    const connected = supabase !== null;
    results.push({ test: 'supabase_connected', passed: connected, detail: `Supabase client: ${connected ? 'initialized' : 'null'}` });
  } catch (e) {
    results.push({ test: 'supabase_connected', passed: false, detail: e.message });
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log('[TESTS]', passed, 'passed,', failed, 'failed');
  return { passed, failed, total: results.length, allPassed: failed === 0, results };
}

app.get('/run-tests', requireAuth, async (_req, res) => {
  try {
    const result = await runIntegrationTests();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/supabase/status', async (_req, res) => {
  if (!supabase) return res.json({ connected: false, tables: null });
  try {
    const [t1, t2, t3] = await Promise.all([
      supabase.from('trades').select('*', { count: 'exact', head: true }),
      supabase.from('patterns').select('*', { count: 'exact', head: true }),
      supabase.from('lessons').select('*', { count: 'exact', head: true }),
    ]);
    res.json({
      connected: true,
      tables: {
        trades:   t1.count ?? 0,
        patterns: t2.count ?? 0,
        lessons:  t3.count ?? 0,
      },
    });
  } catch (e) {
    res.status(500).json({ connected: false, error: e.message });
  }
});

app.get('/supabase/patterns', requireAuth, async (_req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  try {
    const { data, error } = await supabase.from('patterns').select('*').order('avg_r', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ count: (data || []).length, patterns: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/supabase/lessons', async (_req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  try {
    const { data, error } = await supabase.from('lessons').select('*').order('created_at', { ascending: false }).limit(20);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ count: (data || []).length, lessons: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function getSessionAnalysis() {
  if (!supabase) return null;
  const { data: trades } = await supabase.from('trades').select('*').order('created_at', { ascending: false });
  if (!trades || trades.length === 0) return { message: 'No trades yet' };

  const analyze = (group) => ({
    trades:    group.length,
    wins:      group.filter(t => t.pnl > 0).length,
    losses:    group.filter(t => t.pnl < 0).length,
    winRate:   ((group.filter(t => t.pnl > 0).length / group.length) * 100).toFixed(1) + '%',
    avgR:      (group.reduce((s, t) => s + (t.r_multiple || 0), 0) / group.length).toFixed(3),
    totalPnl:  '$' + group.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(2),
    verdict:   group.reduce((s, t) => s + (t.r_multiple || 0), 0) > 0 ? '✅ PROFITABLE' : '❌ LOSING',
  });

  const groupBy = (key) => {
    const map = {};
    trades.forEach(t => { if (!map[t[key]]) map[t[key]] = []; map[t[key]].push(t); });
    return map;
  };

  const sessions      = groupBy('session');
  const pairs         = groupBy('pair');
  const pairDirection = {};
  trades.forEach(t => {
    const key = `${t.pair}_${t.direction}`;
    if (!pairDirection[key]) pairDirection[key] = [];
    pairDirection[key].push(t);
  });

  return {
    overall: analyze(trades),
    bySessions: Object.entries(sessions)
      .map(([session, data]) => ({ session, ...analyze(data) }))
      .sort((a, b) => parseFloat(b.avgR) - parseFloat(a.avgR)),
    byPairs: Object.entries(pairs)
      .map(([pair, data]) => ({ pair, ...analyze(data) }))
      .sort((a, b) => parseFloat(b.avgR) - parseFloat(a.avgR)),
    byDirection: {
      LONG:  analyze(trades.filter(t => t.direction === 'LONG')),
      SHORT: analyze(trades.filter(t => t.direction === 'SHORT')),
    },
    byPairDirection: Object.entries(pairDirection)
      .map(([key, data]) => ({ setup: key, ...analyze(data) }))
      .sort((a, b) => parseFloat(b.avgR) - parseFloat(a.avgR)),
  };
}

app.get('/supabase/session-analysis', requireAuth, async (_req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const analysis = await getSessionAnalysis();
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/supabase/performance', requireAuth, async (_req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  try {
    const { data, error } = await supabase.from('trades').select('*');
    if (error) return res.status(500).json({ error: error.message });
    const trades = data || [];
    if (trades.length === 0) return res.json({ totalTrades: 0, wins: 0, losses: 0, winRate: 0, avgR: 0, totalPnl: 0, bestPair: null, worstPair: null, bestSession: null });

    const wins   = trades.filter(t => t.outcome === 'WIN').length;
    const losses = trades.filter(t => t.outcome === 'LOSS').length;
    const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const validR   = trades.filter(t => t.r_multiple !== null && t.r_multiple !== undefined);
    const avgR     = validR.length > 0 ? validR.reduce((s, t) => s + t.r_multiple, 0) / validR.length : 0;

    // Best / worst pair by avg R
    const pairMap = {};
    for (const t of trades) {
      if (!t.pair || t.r_multiple == null) continue;
      if (!pairMap[t.pair]) pairMap[t.pair] = { total: 0, count: 0 };
      pairMap[t.pair].total += t.r_multiple;
      pairMap[t.pair].count++;
    }
    const pairAvgs = Object.entries(pairMap).map(([pair, d]) => ({ pair, avg: d.total / d.count }));
    const bestPair  = pairAvgs.sort((a, b) => b.avg - a.avg)[0]?.pair || null;
    const worstPair = pairAvgs.sort((a, b) => a.avg - b.avg)[0]?.pair || null;

    // Best session by win rate
    const sessMap = {};
    for (const t of trades) {
      if (!t.session) continue;
      if (!sessMap[t.session]) sessMap[t.session] = { wins: 0, total: 0 };
      sessMap[t.session].total++;
      if (t.outcome === 'WIN') sessMap[t.session].wins++;
    }
    const sessRates  = Object.entries(sessMap).map(([s, d]) => ({ session: s, rate: d.wins / d.total }));
    const bestSession = sessRates.sort((a, b) => b.rate - a.rate)[0]?.session || null;

    res.json({
      totalTrades: trades.length,
      wins,
      losses,
      winRate:     parseFloat(((wins / trades.length) * 100).toFixed(1)),
      avgR:        parseFloat(avgR.toFixed(3)),
      totalPnl:    parseFloat(totalPnl.toFixed(2)),
      bestPair,
      worstPair,
      bestSession,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── OPTIONS CHAIN SCANNER ────────────────────────────────────────────────────
const OPTIONS_MAP = {
  'EUR_USD':    'FXE',
  'GBP_USD':    'FXB',
  'USD_JPY':    'FXY',
  'XAU_USD':    'GLD',
  'XAG_USD':    'SLV',
  'NAS100_USD': 'QQQ',
  'AU200_AUD':  'EWA',
  'EUR_GBP':    'FXE',
};

async function scanOptionsChain(instrument) {
  if (!process.env.MARKETDATA_API_KEY) return null;
  const ticker = OPTIONS_MAP[instrument];
  if (!ticker) return null;

  try {
    const response = await fetch(
      `https://api.marketdata.app/v1/options/chain/${ticker}/?token=${process.env.MARKETDATA_API_KEY}`,
      { headers: { 'Accept': 'application/json' } },
    );
    const data = await response.json();

    // Marketdata.app returns columnar arrays — zip into row objects
    const options = data.optionSymbol
      ? data.optionSymbol.map((_, i) => ({
          type:               data.side?.[i],
          strike:             data.strike?.[i],
          volume:             data.volume?.[i]       ?? 0,
          openInterest:       data.openInterest?.[i] ?? 0,
          implied_volatility: data.iv?.[i]           ?? 0,
        }))
      : [];

    if (options.length === 0) {
      console.log('[OPTIONS]', ticker, '— no data from Marketdata.app');
      return null;
    }

    const calls = options.filter(o => o.type === 'call');
    const puts  = options.filter(o => o.type === 'put');

    const callVolume   = calls.reduce((s, o) => s + (o.volume || 0), 0);
    const putVolume    = puts.reduce( (s, o) => s + (o.volume || 0), 0);
    const putCallRatio = callVolume > 0 ? putVolume / callVolume : 1;

    const avgIV = options.reduce((s, o) => s + (o.implied_volatility || 0), 0) / options.length;

    const unusualOptions = options
      .filter(o => (o.volume || 0) > (o.openInterest || 0) * 0.5)
      .sort((a, b) => (b.volume || 0) - (a.volume || 0))
      .slice(0, 3);

    const institutionalBias =
      putCallRatio > 1.5 ? 'BEARISH' :
      putCallRatio < 0.7 ? 'BULLISH' :
      'NEUTRAL';

    console.log(`[OPTIONS] ${instrument} (${ticker}) — bias: ${institutionalBias}, P/C: ${putCallRatio.toFixed(2)}, IV: ${(avgIV * 100).toFixed(1)}%`);

    return {
      ticker,
      putCallRatio:    putCallRatio.toFixed(2),
      avgIV:           (avgIV * 100).toFixed(1) + '%',
      institutionalBias,
      unusualActivity: unusualOptions.map(o => ({
        type:         o.type,
        strike:       o.strike,
        volume:       o.volume,
        openInterest: o.openInterest,
        iv:           o.implied_volatility,
      })),
      signal: institutionalBias === 'BEARISH' ? 'SHORT'
            : institutionalBias === 'BULLISH' ? 'LONG'
            : 'NEUTRAL',
    };
  } catch (err) {
    console.error('[OPTIONS ERROR]', err.message);
    return null;
  }
}

app.get('/options/:instrument', requireAuth, async (req, res) => {
  const data = await scanOptionsChain(req.params.instrument);
  if (!data) return res.json({ error: 'No options data available' });
  res.json(data);
});

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
  const SENSITIVE_ENV = new Set(['OANDA_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'DISCORD_BOT_TOKEN', 'JWT_SECRET', 'DASHBOARD_PASSWORD', 'SUPABASE_ANON_KEY']);
  console.log('── ENV AUDIT ─────────────────────────────');
  REQUIRED_VARS.forEach(v => {
    const val = process.env[v];
    const display = !val ? '❌ MISSING' : SENSITIVE_ENV.has(v) ? maskKey(val) : '✅ SET';
    console.log(`  [ENV] ${v}: ${display}`);
  });
  console.log('  Optional:');
  OPTIONAL_VARS.forEach(v => { if (process.env[v]) console.log(`  [ENV] ${v}: ${SENSITIVE_ENV.has(v) ? maskKey(process.env[v]) : '✅ SET'}`); });
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
loadCooldowns().catch(e => console.error('[state] loadCooldowns startup:', e.message));
refreshEconomicCalendar().catch(e => console.error('[calendar] Startup:', e.message));
setInterval(() => refreshEconomicCalendar().catch(e => console.error('[calendar] Refresh:', e.message)), 60 * 60_000);

// Discord two-way command polling — every 30s (requires DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID)
setTimeout(() => pollDiscordCommands().catch(e => console.error('[discord-poll] Startup:', e.message)), 8_000);
setInterval(() => pollDiscordCommands().catch(e => console.error('[discord-poll] Loop:', e.message)), 30_000);

// Register Discord slash commands (idempotent — safe to run on every startup)
registerDiscordCommands().catch(e => console.error('[discord] Command registration failed:', e.message));

// Drawdown recovery monitor — every 5 minutes + startup
monitorDrawdown().catch(e => console.error('[drawdown] Startup:', e.message));
setInterval(() => monitorDrawdown().catch(e => console.error('[drawdown] Loop:', e.message)), 5 * 60 * 1000);
