require('dotenv').config({ override: true });
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const BASE    = 'https://api-fxpractice.oanda.com';
const TOKEN   = process.env.OANDA_TOKEN;
const ACCOUNT = process.env.OANDA_ACCOUNT_ID;
const H       = { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

// ─── OANDA PROXY ENDPOINTS ────────────────────────────────────────────────────
app.get('/prices', async (req, res) => {
  const instruments = req.query.instruments || 'EUR_USD,GBP_USD,USD_JPY';
  const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/pricing?instruments=${instruments}`, { headers: H });
  res.json(await r.json());
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

app.post('/close/:tradeId', async (req, res) => {
  const r = await fetch(`${BASE}/v3/accounts/${ACCOUNT}/trades/${req.params.tradeId}/close`, { method: 'PUT', headers: H });
  res.json(await r.json());
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

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    autoMode: process.env.AUTO_MODE_ENABLED === 'true',
    models: {
      claude:   Boolean(process.env.VITE_ANTHROPIC_KEY),
      openai:   Boolean(process.env.VITE_OPENAI_API_KEY),
      deepseek: Boolean(process.env.VITE_DEEPSEEK_API_KEY),
      gemini:   Boolean(process.env.VITE_GEMINI_API_KEY),
    },
  });
});

app.post('/ai', async (req, res) => {
  const { prompt, systemPrompt, maxTokens } = req.body;
  if (!process.env.VITE_ANTHROPIC_KEY)
    return res.status(503).json({ error: { message: 'Missing VITE_ANTHROPIC_KEY in .env' } });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.VITE_ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
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

const AUTO_PAIRS = 'EUR_USD,GBP_USD,USD_JPY,AUD_USD,USD_CAD,XAU_USD,BTC_USD,SPX500_USD';

// ─── SHARED LLM HELPERS ──────────────────────────────────────────────────────
const SYS = 'You are an elite forex risk analyst. Be decisive. Never hedge. Respond ONLY in the format shown.';

function buildSignalPrompt(p) {
  return `Pair: ${p.instrument} | Direction: ${p.direction} | Confidence: ${p.score}% | Price: ${p.price} | Change: ${p.change}% | Reason: ${p.reason} | RSI: ${p.rsi} | News: "${p.headline}"\n\nRespond in this EXACT format:\nVERDICT: CONFIRM or REJECT\nREASON: (one sentence, max 15 words)`;
}

function parseVerdict(text) {
  const lines = (text || '').split('\n').reduce((a, l) => {
    const i = l.indexOf(':'); if (i > 0) a[l.slice(0, i).trim()] = l.slice(i + 1).trim(); return a;
  }, {});
  return { verdict: (lines.VERDICT || '').includes('CONFIRM') ? 'CONFIRM' : 'REJECT', reason: lines.REASON || '—' };
}

function apiErr(d, fallback) { return d?.error?.message || d?.error?.type || fallback; }

async function askClaude(prompt) {
  if (!process.env.VITE_ANTHROPIC_KEY) throw new Error('Missing VITE_ANTHROPIC_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.VITE_ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 120, system: SYS, messages: [{ role: 'user', content: prompt }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(apiErr(d, `Claude HTTP ${r.status}`));
  const text = d.content?.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('Claude empty response');
  return { name: 'Claude Sonnet', ...parseVerdict(text) };
}

async function askGPT(prompt) {
  if (!process.env.VITE_OPENAI_API_KEY) throw new Error('Missing VITE_OPENAI_API_KEY');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.VITE_OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 120, messages: [{ role: 'system', content: SYS }, { role: 'user', content: prompt }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(apiErr(d, `OpenAI HTTP ${r.status}`));
  const text = d.choices?.[0]?.message?.content;
  if (!text) throw new Error('GPT empty response');
  return { name: 'GPT-4o mini', ...parseVerdict(text) };
}

async function askDeepSeek(prompt) {
  if (!process.env.VITE_DEEPSEEK_API_KEY) throw new Error('Missing VITE_DEEPSEEK_API_KEY');
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.VITE_DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 120, messages: [{ role: 'system', content: SYS }, { role: 'user', content: prompt }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(apiErr(d, `DeepSeek HTTP ${r.status}`));
  const text = d.choices?.[0]?.message?.content;
  if (!text) throw new Error('DeepSeek empty response');
  return { name: 'DeepSeek', ...parseVerdict(text) };
}

async function askGemini(prompt) {
  if (!process.env.VITE_GEMINI_API_KEY) throw new Error('Missing VITE_GEMINI_API_KEY');
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.VITE_GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYS }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
      }),
    }
  );
  const d = await r.json();
  if (!r.ok) throw new Error(apiErr(d, `Gemini HTTP ${r.status}`));
  const text = d.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
  if (!text) throw new Error('Gemini empty response');
  return { name: 'Gemini 2.0 Flash', ...parseVerdict(text) };
}

async function runConsensus(params) {
  const prompt = buildSignalPrompt(params);
  const settled = await Promise.allSettled([askClaude(prompt), askGPT(prompt), askDeepSeek(prompt), askGemini(prompt)]);
  const NAMES = ['Claude Sonnet', 'GPT-4o mini', 'DeepSeek', 'Gemini 2.0 Flash'];
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
  return {
    votes: { confirm: confirms, reject: models.length - confirms },
    consensus: confirms >= 3 ? 'CONFIRM' : 'REJECT',
    confidence: `${Math.round((confirms / models.length) * 100)}%`,
    models,
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
  if (!process.env.VITE_GEMINI_API_KEY) return null;
  const list = headlines.slice(0, 10).map(h => `- ${h.title}`).join('\n');
  const catName = CAT_NAMES[category] || category;
  const prompt = `You are a concise forex market analyst. Based on these recent ${catName} headlines, write exactly 2 sentences: (1) the dominant market theme right now, (2) the key directional bias traders should watch. Max 50 words total. Be specific — name pairs, assets, or data.\n\nHeadlines:\n${list}`;
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.VITE_GEMINI_API_KEY}`,
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

// ─── CONSENSUS ENDPOINT ───────────────────────────────────────────────────────
app.post('/consensus', async (req, res) => {
  try {
    res.json(await runConsensus(req.body));
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
const PORT = 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`OANDA bridge live at http://localhost:${PORT}`);
  console.log(`  AI: Claude ${process.env.VITE_ANTHROPIC_KEY ? '✓' : '✗'} | OpenAI ${process.env.VITE_OPENAI_API_KEY ? '✓' : '✗'} | DeepSeek ${process.env.VITE_DEEPSEEK_API_KEY ? '✓' : '✗'} | Gemini ${process.env.VITE_GEMINI_API_KEY ? '✓' : '✗'}`);
  console.log(`  Auto mode: ${process.env.AUTO_MODE_ENABLED === 'true' ? 'ENABLED ⚡' : 'disabled (set AUTO_MODE_ENABLED=true to activate)'}`);
});

setTimeout(() => runAutonomousCheck().catch(e => console.error('[auto] Startup:', e.message)), 10_000);
setInterval(() => runAutonomousCheck().catch(e => console.error('[auto] Loop:', e.message)), 60_000);
