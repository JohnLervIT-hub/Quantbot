import { useState, useEffect, useRef, useCallback, memo } from "react";
import { motion, AnimatePresence, animate } from "framer-motion";
import {
  Chart,
  LineElement,
  PointElement,
  LineController,
  CategoryScale,
  LinearScale,
  Filler,
} from "chart.js";

Chart.register(LineElement, PointElement, LineController, CategoryScale, LinearScale, Filler);

const FONT_MONO = "'JetBrains Mono', monospace";
// Dev: Vite proxies /bridge → localhost:3001. Set VITE_OANDA_BRIDGE only for phone/LAN testing.
const BRIDGE = import.meta.env.VITE_OANDA_BRIDGE || (import.meta.env.DEV ? "/bridge" : "http://localhost:3001");

function priceDecimals(pair) {
  return pair.includes("BTC") ? 2 : pair.includes("JPY") ? 3 : 5;
}

function oandaToSlash(instrument) {
  return instrument.replace("_", "/");
}

function tradeDuration(openTime) {
  const ms = Date.now() - new Date(openTime).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Keeps signal visible briefly when engine flickers off — stops card height jumping. */
function useStableSignal(signal) {
  const [display, setDisplay] = useState(signal);
  useEffect(() => {
    if (signal) {
      setDisplay(signal);
      return undefined;
    }
    const t = setTimeout(() => setDisplay(null), 2500);
    return () => clearTimeout(t);
  }, [signal]);
  return display;
}

function AnimatedNumber({ value, decimals = 5, style }) {
  const [display, setDisplay] = useState(() => value.toFixed(decimals));
  const prev = useRef(value);

  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    const ctrl = animate(from, value, {
      duration: 0.4,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setDisplay(v.toFixed(decimals)),
    });
    return () => ctrl.stop();
  }, [value, decimals]);

  return <span style={style}>{display}</span>;
}

// ─── KNOWLEDGE REPOSITORY ────────────────────────────────────────────────────
const KNOWLEDGE_BASE = {
  marketWizards: [
    "Cut losses short, let winners run",
    "Never risk more than 1-2% of capital on a single trade",
    "Trade with the trend on your primary timeframe",
    "Always know your exit before your entry",
    "Discipline and consistency beat intelligence",
    "Master your emotions — fear and greed destroy accounts",
    "Size positions based on volatility, not conviction",
    "The best traders are right 40-50% of the time but manage risk brilliantly",
  ],
  vanTharpRules: [
    "R-multiple system: define your 1R risk before entry",
    "Position size = (Account risk %) / (Trade risk in price)",
    "Target 3R+ reward-to-risk minimum",
    "Expectancy = (Win% × Avg Win) − (Loss% × Avg Loss)",
    "Never add to losing positions",
    "Maximum portfolio heat: 6R across all open trades",
    "Use ATR for stop placement, not round numbers",
  ],
  mt5Patterns: [
    "EMA 9/21 crossover for trend confirmation",
    "RSI divergence for reversal signals",
    "MACD histogram for momentum shifts",
    "Bollinger Bands squeeze for breakout setups",
    "Volume-weighted entries for institutional alignment",
    "Multi-timeframe confluence: H4 trend + H1 entry",
  ],
  quantConnectEdge: [
    "Mean reversion on intraday deviations >2σ",
    "Momentum factor on 12-1 month returns",
    "Pairs trading on correlated assets with z-score >2",
    "Volatility regime switching (high vol → defensive)",
    "Machine learning signal weighting via gradient boosting",
  ],
};

const NEWS_SOURCES = ["Bloomberg", "DailyFX", "Benzinga Pro", "Reuters", "CNBC", "MarketBeat"];
const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "XAU/USD", "BTC/USD", "SPX500"];
const STRATEGIES = ["Trend Follow", "Mean Revert", "Breakout", "Momentum", "Range Scalp"];

const TABLE_COLS = "110px 110px 180px 100px 110px 100px";
const TABLE_GAP  = 0;
const TABLE_PAD  = "10px 16px";

const LIVE_HEADLINES = [
  "Fed signals potential rate pause amid cooling inflation data",
  "EUR/USD breaks key resistance at 1.0890 on ECB hawkish tone",
  "Gold surges on geopolitical risk premium — safe haven demand rises",
  "NFP report beats expectations: +285K jobs added in April",
  "BTC consolidates above $68K support zone ahead of halving",
  "USD weakness continues as DXY tests 102.30 — dollar bears in control",
  "BOJ intervenes as USD/JPY tests 158.00 — yen defense operation",
  "Oil holds gains amid OPEC+ supply cut extension announcement",
  "GBP/USD rallies on strong UK retail sales data beat",
  "AUD/USD supported by RBA hawkish minutes — rate cut delayed",
];

// ─── MARKET SESSIONS ──────────────────────────────────────────────────────────
const SESSIONS = [
  { name: "Sydney",   start: 22, end: 7,  color: "#0EA5E9", bg: "rgba(14,165,233,0.13)"  },
  { name: "Tokyo",    start: 0,  end: 9,  color: "#F97316", bg: "rgba(249,115,22,0.13)"  },
  { name: "London",   start: 7,  end: 16, color: "#8B5CF6", bg: "rgba(139,92,246,0.13)"  },
  { name: "New York", start: 13, end: 22, color: "#1D9E75", bg: "rgba(29,158,117,0.13)"  },
];

function isSessionActive({ start, end }) {
  const h = new Date().getUTCHours();
  return start > end ? h >= start || h < end : h >= start && h < end;
}

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  const h = now.getUTCHours();
  if (day === 6) return false;
  if (day === 0 && h < 22) return false;
  return true;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return isMobile;
}

function MarketSession({ isMobile }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{ display: "flex", gap: isMobile ? 6 : 8, alignItems: "center", flexWrap: "nowrap", overflowX: "auto" }}>
      {SESSIONS.map((s) => {
        const active = isSessionActive(s);
        return (
          <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 4, padding: isMobile ? "3px 10px" : "2px 8px", borderRadius: isMobile ? 12 : 4, background: isMobile ? (active ? "#132f4c" : "transparent") : (active ? s.bg : "transparent"), border: isMobile ? `1px solid ${active ? "#388bfd" : "#21262d"}` : "none", opacity: active ? 1 : isMobile ? 1 : 0.35, transition: "all 0.4s", whiteSpace: "nowrap", flexShrink: 0 }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: isMobile ? (active ? "#58a6ff" : "#8b949e") : s.color, display: "inline-block" }} />
            <span style={{ fontSize: 10, fontWeight: 500, color: isMobile ? (active ? "#58a6ff" : "#8b949e") : s.color }}>{s.name}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── ANTHROPIC API CALL ──────────────────────────────────────────────────────
async function callClaude(prompt, systemPrompt, maxTokens = 400) {
  const resp = await fetch(`${BRIDGE}/ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, systemPrompt, maxTokens }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || `API error ${resp.status}`);
  const text = data.content?.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Empty response from Claude");
  return text;
}

// ─── PRICE SIMULATOR ─────────────────────────────────────────────────────────
function usePriceSimulator(basePrice) {
  const [price, setPrice] = useState(basePrice);
  const [history, setHistory] = useState(() => {
    const h = [];
    let p = basePrice;
    for (let i = 0; i < 60; i++) {
      p += (Math.random() - 0.5) * basePrice * 0.002;
      h.push(parseFloat(p.toFixed(5)));
    }
    return h;
  });
  const drift = useRef((Math.random() - 0.5) * 0.0003);

  useEffect(() => {
    const id = setInterval(() => {
      setPrice((prev) => {
        drift.current += (Math.random() - 0.5) * 0.00005;
        drift.current = Math.max(-0.001, Math.min(0.001, drift.current));
        const next = parseFloat(
          (prev + drift.current + (Math.random() - 0.5) * prev * 0.001).toFixed(5)
        );
        setHistory((h) => [...h.slice(-59), next]);
        return next;
      });
    }, 800);
    return () => clearInterval(id);
  }, []);

  return { price, history };
}

// ─── SIGNAL ENGINE ────────────────────────────────────────────────────────────
function generateSignal(history, strategy, pair) {
  if (history.length < 20) return null;
  const recent = history.slice(-20);
  const ema9 = recent.slice(-9).reduce((a, b) => a + b, 0) / 9;
  const ema21 = recent.reduce((a, b) => a + b, 0) / 20;
  const last = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const change = (last - recent[0]) / recent[0];
  let score = 0, direction = null, reason = [];

  if (strategy === "Trend Follow") {
    if (ema9 > ema21 && last > ema9) { score += 40; direction = "LONG"; reason.push("EMA bullish cross"); }
    else if (ema9 < ema21 && last < ema9) { score += 40; direction = "SHORT"; reason.push("EMA bearish cross"); }
    if (change > 0.003) { score += 25; direction = direction || "LONG"; reason.push("Strong uptrend"); }
    else if (change < -0.003) { score += 25; direction = direction || "SHORT"; reason.push("Strong downtrend"); }
    if (direction) console.log(`[Signal] ${pair} | ${strategy} | ${direction} | score ${score}`);
  } else if (strategy === "Mean Revert") {
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const dev = Math.abs(last - mean) / mean;
    if (dev > 0.001) {
      const dir = last > mean ? "SHORT" : "LONG";
      score += 50;
      if (dev > 0.002) score += 10;
      if (dev > 0.004) score += 10;
      const returning = (dir === "LONG" && last > prev) || (dir === "SHORT" && last < prev);
      if (returning) score += 10;
      direction = dir;
      reason.push(`${(dev * 100).toFixed(2)}% deviation`);
      console.log(`[Signal] ${pair} | ${strategy} | ${direction} | score ${score} | dev ${(dev * 100).toFixed(3)}%`);
    }
  
  } else if (strategy === "Breakout") {
    const high = Math.max(...recent), low = Math.min(...recent), range = high - low;
    if (last > high - range * 0.05) { score += 45; direction = "LONG"; reason.push("Near range high breakout"); }
    else if (last < low + range * 0.05) { score += 45; direction = "SHORT"; reason.push("Near range low breakdown"); }
    if (direction) console.log(`[Signal] ${pair} | ${strategy} | ${direction} | score ${score}`);
  } else if (strategy === "Momentum") {
    const momentum = (last - recent[recent.length - 10]) / recent[recent.length - 10];
    if (momentum > 0.004) {
      score += 55;
      direction = "LONG";
      reason.push(`+${(momentum * 100).toFixed(2)}% momentum`);
      console.log(`[Signal] ${pair} | ${strategy} | ${direction} | score ${score} | mom ${(momentum * 100).toFixed(3)}%`);
    } else if (momentum < -0.004) {
      score += 55;
      direction = "SHORT";
      reason.push(`${(momentum * 100).toFixed(2)}% momentum`);
      console.log(`[Signal] ${pair} | ${strategy} | ${direction} | score ${score} | mom ${(momentum * 100).toFixed(3)}%`);
    }
  } else {
    if (Math.abs(change) < 0.001) { score += 40; direction = last > prev ? "SHORT" : "LONG"; reason.push("Range-bound"); }
    if (direction) console.log(`[Signal] ${pair} | ${strategy} | ${direction} | score ${score}`);
  }

  const rsi = 50 + (change / 0.01) * 20;
  // Mean Revert / Trend Follow / Breakout / Range Scalp: fade extremes (oversold LONG, overbought SHORT)
  // Momentum: confirm trend direction (high RSI confirms LONG momentum, low RSI confirms SHORT momentum)
  if (strategy === "Momentum") {
    if (direction === "LONG"  && rsi > 55) { score += 15; reason.push("RSI momentum confirm"); }
    if (direction === "SHORT" && rsi < 45) { score += 15; reason.push("RSI momentum confirm"); }
  } else {
    if (direction === "LONG"  && rsi < 45) { score += 15; reason.push("RSI oversold"); }
    if (direction === "SHORT" && rsi > 55) { score += 15; reason.push("RSI overbought"); }
  }

  // Display threshold raised to 50 (v3.0). Execution gated separately at 75 via runGatekeepers.
  if (!direction || score < 50) return null;
  return { direction, score: Math.min(score, 100), reason, rsi: parseFloat(rsi.toFixed(1)) };
}

// ─── REGIME / GATEKEEPER ENGINE ──────────────────────────────────────────────
const PIP_SIZE = {
  "EUR/USD": 0.0001, "GBP/USD": 0.0001, "USD/JPY": 0.01,
  "AUD/USD": 0.0001, "USD/CAD": 0.0001,
  "XAU/USD": 0.01, "BTC/USD": 1, "SPX500": 0.1,
};
const NORMAL_SPREAD_PIPS = {
  "EUR/USD": 0.5, "GBP/USD": 0.8, "USD/JPY": 0.8,
  "AUD/USD": 0.6, "USD/CAD": 0.7,
  "XAU/USD": 20, "BTC/USD": 50, "SPX500": 0.5,
};
const USD_PAIRS_SET = new Set(["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD"]);

function calcRegime(history) {
  if (history.length < 50) return { regime: "RANGING", ema9: 0, ema21: 0, ema50: 0, atr5: 0, atr20: 0 };
  const ema9  = history.slice(-9).reduce((a, b) => a + b, 0) / 9;
  const ema21 = history.slice(-21).reduce((a, b) => a + b, 0) / 21;
  const ema50 = history.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const bars  = history.slice(-21);
  const tr    = bars.slice(1).map((p, i) => Math.abs(p - bars[i]));
  const atr5  = tr.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const atr20 = tr.reduce((a, b) => a + b, 0) / tr.length || atr5;
  const bullTrend = ema9 > ema21 && ema21 > ema50;
  const bearTrend = ema9 < ema21 && ema21 < ema50;
  const isTrending = (bullTrend || bearTrend) && Math.abs(ema9 - ema50) / ema50 > 0.001;
  const isVolatile = atr20 > 0 && atr5 > atr20 * 2;
  const regime = isVolatile ? "VOLATILE" : isTrending ? "TRENDING" : "RANGING";
  return { regime, ema9, ema21, ema50, atr5, atr20, bullTrend };
}

function runGatekeepers(history, signal, openTrades, pair) {
  const rejections = [];
  const pip             = PIP_SIZE[pair] || 0.0001;
  const normalSpreadPips = NORMAL_SPREAD_PIPS[pair] || 1;
  const bars  = history.slice(-21);
  const tr    = bars.slice(1).map((p, i) => Math.abs(p - bars[i]));
  const atr5  = tr.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const atr20 = tr.reduce((a, b) => a + b, 0) / tr.length || atr5;
  const atr5Pips = atr5 / pip;

  // 1. Score ≥ 75 (raised from 65)
  if (signal.score < 75) {
    rejections.push({
      condition: "Score threshold",
      actual: `${signal.score}%`,
      threshold: "75%",
      reason: `Signal confidence ${signal.score}% is below the 75% minimum`,
    });
  }

  // 2. Spread check — abort if spread > 2× normal
  const spreadPips = atr5Pips * 0.15;
  const spreadLimit = normalSpreadPips * 2;
  if (spreadPips > spreadLimit) {
    rejections.push({
      condition: "Spread check",
      actual: `${spreadPips.toFixed(1)}p`,
      threshold: `${spreadLimit.toFixed(1)}p`,
      reason: `Spread ~${spreadPips.toFixed(1)} pips exceeds 2× normal (${normalSpreadPips}p)`,
    });
  }

  // 3. Slippage estimate — block if > 0.5 pip
  const slippagePips = atr5Pips * 0.1;
  if (slippagePips > 0.5) {
    rejections.push({
      condition: "Slippage estimate",
      actual: `${slippagePips.toFixed(2)}p`,
      threshold: "0.50p",
      reason: `Estimated slippage ${slippagePips.toFixed(2)} pips exceeds 0.5 pip limit`,
    });
  }

  // 4. Correlated USD pairs — block if 2+ same-direction USD pairs open
  if (USD_PAIRS_SET.has(pair)) {
    const pairLeadsUSD = pair.startsWith("USD");
    const thisLongUSD  = pairLeadsUSD ? signal.direction === "LONG" : signal.direction === "SHORT";
    const sameCount = (openTrades || []).filter(t => {
      const tp = t.instrument?.replace("_", "/");
      if (!USD_PAIRS_SET.has(tp) || tp === pair) return false;
      const units     = parseInt(t.currentUnits || 0);
      const tLongUSD  = tp.startsWith("USD") ? units > 0 : units < 0;
      return tLongUSD === thisLongUSD;
    }).length;
    if (sameCount >= 2) {
      rejections.push({
        condition: "Correlated pairs",
        actual: `${sameCount} USD pairs`,
        threshold: "< 2",
        reason: `${sameCount} same-direction USD pairs open — concentration risk too high`,
      });
    }
  }

  // 5. Higher timeframe bias — price must be above EMA50 for LONG, below for SHORT
  if (history.length >= 50) {
    const ema50 = history.slice(-50).reduce((a, b) => a + b, 0) / 50;
    const last  = history[history.length - 1];
    const biasOk = signal.direction === "LONG" ? last > ema50 : last < ema50;
    if (!biasOk) {
      rejections.push({
        condition: "EMA50 bias",
        actual: signal.direction === "LONG" ? "Price below EMA50" : "Price above EMA50",
        threshold: `Price ${signal.direction === "LONG" ? "above" : "below"} EMA50`,
        reason: `Higher timeframe trend opposes ${signal.direction} — wrong side of EMA50`,
      });
    }
  }

  // 6. Volatility check — block if ATR5 > 2× ATR20
  if (atr20 > 0 && atr5 > atr20 * 2) {
    rejections.push({
      condition: "Volatility check",
      actual: `${(atr5 / atr20).toFixed(1)}× avg ATR`,
      threshold: "< 2.0×",
      reason: `Volatility spike — 5-bar ATR is ${(atr5 / atr20).toFixed(1)}× the 20-bar average`,
    });
  }

  return { passed: rejections.length === 0, rejections };
}

// ─── BEZIER SPARKLINE ────────────────────────────────────────────────────────
function BezierSpark({ history, height = 40, fullWidth = false }) {
  if (!history || history.length < 2) return null;
  const min = Math.min(...history), max = Math.max(...history), range = max - min || 1;
  const w = 120, h = height;
  const coords = history.map((v, i) => ({
    x: (i / (history.length - 1)) * w,
    y: h - ((v - min) / range) * h,
  }));
  const t = 0.3;
  let d = `M${coords[0].x.toFixed(2)},${coords[0].y.toFixed(2)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[Math.max(0, i - 1)];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[Math.min(coords.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) * t;
    const cp1y = p1.y + (p2.y - p0.y) * t;
    const cp2x = p2.x - (p3.x - p1.x) * t;
    const cp2y = p2.y - (p3.y - p1.y) * t;
    d += ` C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  const isUp = history[history.length - 1] >= history[0];
  const color = isUp ? "#1D9E75" : "#E24B4A";
  const fillD = fullWidth
    ? `M${coords[0].x.toFixed(2)},${h} L${d.substring(1)} L${coords[coords.length - 1].x.toFixed(2)},${h} Z`
    : null;
  const gid = isUp ? "qb-su" : "qb-sd";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block", width: fullWidth ? "100%" : w, height: h }}>
      {fullWidth && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={isUp ? "rgba(29,158,117,0.3)" : "rgba(226,75,74,0.3)"} />
              <stop offset="100%" stopColor={isUp ? "rgba(29,158,117,0)" : "rgba(226,75,74,0)"} />
            </linearGradient>
          </defs>
          <path d={fillD} fill={`url(#${gid})`} />
        </>
      )}
      <path d={d} fill="none" stroke={color} strokeWidth={fullWidth ? "1.8" : "1.5"} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── OANDA CANDLE CHART (Chart.js area with gradient fill) ───────────────────
function toOandaSymbol(pair) {
  if (pair === "SPX500") return "SPX500_USD";
  return pair.replace("/", "_");
}

function buildGradient(ctx, chartArea, isUp) {
  const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  if (isUp) {
    g.addColorStop(0, "rgba(29,158,117,0.32)");
    g.addColorStop(1, "rgba(29,158,117,0)");
  } else {
    g.addColorStop(0, "rgba(226,75,74,0.32)");
    g.addColorStop(1, "rgba(226,75,74,0)");
  }
  return g;
}

function OandaChart({ pair, history: simHistory, height = 40 }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const isUpRef = useRef(true);
  const [live, setLive] = useState(false);

  const applyData = useCallback((closes) => {
    if (!canvasRef.current) return;
    isUpRef.current = closes[closes.length - 1] >= closes[0];
    const color = isUpRef.current ? "#1D9E75" : "#E24B4A";

    if (chartRef.current) {
      chartRef.current.data.labels = closes.map((_, i) => i);
      chartRef.current.data.datasets[0].data = closes;
      chartRef.current.data.datasets[0].borderColor = color;
      chartRef.current.update("none");
    } else {
      const ctx = canvasRef.current.getContext("2d");
      chartRef.current = new Chart(ctx, {
        type: "line",
        data: {
          labels: closes.map((_, i) => i),
          datasets: [{
            data: closes,
            borderColor: color,
            backgroundColor: (context) => {
              const { ctx: c, chartArea } = context.chart;
              if (!chartArea) return "transparent";
              return buildGradient(c, chartArea, isUpRef.current);
            },
            borderWidth: 1.5,
            fill: true,
            tension: 0.4,
            pointRadius: 0,
            pointHoverRadius: 0,
          }],
        },
        options: {
          responsive: false,
          animation: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: {
            x: { display: false },
            y: { display: false, grace: "8%" },
          },
        },
      });
      setLive(true);
    }
  }, []);

  const fetchCandles = useCallback(async () => {
    try {
      const sym = toOandaSymbol(pair);
      const res = await fetch(`${BRIDGE}/candles/${sym}?count=60&granularity=M5`);
      if (!res.ok) throw new Error("non-ok");
      const data = await res.json();
      if (!data.candles?.length) throw new Error("empty");
      applyData(data.candles.map((c) => parseFloat(c.mid.c)));
    } catch {
      // server offline — stay on bezier fallback
    }
  }, [pair, applyData]);

  useEffect(() => {
    fetchCandles();
    const id = setInterval(fetchCandles, 30000);
    return () => {
      clearInterval(id);
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [fetchCandles]);

  return (
    <div style={{ position: "relative", width: 120, height }}>
      {!live && (
        <div style={{ position: "absolute", inset: 0 }}>
          <BezierSpark history={simHistory} height={height} />
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={120}
        height={height}
        style={{ display: "block", opacity: live ? 1 : 0, transition: "opacity 0.4s" }}
      />
    </div>
  );
}

// ─── MULTI-MODEL CONSENSUS ────────────────────────────────────────────────────
function AISignalConfirm({ pair, signal, price, history, currentHeadline, onConfirmed, onRejected, marketOpen }) {
  const [loading, setLoading] = useState(false);
  const [consensus, setConsensus] = useState(null);

  const analyze = async () => {
    setLoading(true);
    const change = ((history[history.length - 1] - history[0]) / history[0] * 100).toFixed(3);
    try {
      const r = await fetch(`${BRIDGE}/consensus`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument: pair.replace("/", "_"),
          direction: signal.direction,
          score: signal.score,
          price,
          change,
          rsi: signal.rsi,
          reason: signal.reason.join(", "),
          headline: currentHeadline,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `Bridge error ${r.status}`);
      if (data.error) throw new Error(data.error);
      setConsensus(data);
    } catch (err) {
      const msg = err?.message?.includes("404") || err?.message?.includes("Cannot POST")
        ? "Restart bridge: npm run server"
        : err?.message?.includes("Failed to fetch") || err?.name === "TypeError"
          ? `Bridge offline — run: npm run server`
          : err?.message || "Connection failed";
      setConsensus({
        votes: { confirm: 0, reject: 4 },
        consensus: "REJECT",
        confidence: "0%",
        models: [
          { name: "Claude Sonnet",    verdict: "REJECT", reason: msg },
          { name: "GPT-4o mini",      verdict: "REJECT", reason: msg },
          { name: "DeepSeek",         verdict: "REJECT", reason: msg },
          { name: "Gemini 2.0 Flash", verdict: "REJECT", reason: msg },
        ],
        executeAllowed: false,
        bridgeError: true,
      });
    }
    setLoading(false);
  };

  useEffect(() => { analyze(); }, []);

  const confirms = consensus?.votes?.confirm ?? 0;
  const total = consensus?.models?.length ?? 4;
  const accentColor = confirms >= 3 ? "#3fb950" : confirms === 2 ? "#d29922" : "#f85149";

  const MODEL_PLACEHOLDERS = ["Claude Sonnet", "GPT-4o mini", "DeepSeek", "Gemini 2.0 Flash"];

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      style={{ background: "#0d1117", border: "1px solid #21262d", borderLeft: `4px solid ${accentColor}`, borderRadius: 10, padding: "14px", marginTop: 8 }}
    >
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: accentColor }}>
          {loading ? "Consulting Xavier's committee…" : `${confirms}/${total} analysts agree`}
        </div>
        {!loading && consensus && (
          <span style={{ fontSize: 11, fontWeight: 500, color: accentColor }}>{consensus.confidence} confidence</span>
        )}
      </div>

      {/* Model rows — skeleton while loading */}
      <div style={{ display: "flex", flexDirection: "column", marginBottom: 10, border: "1px solid #21262d", borderRadius: 7, overflow: "hidden" }}>
        {(loading ? MODEL_PLACEHOLDERS.map(name => ({ name, verdict: null, reason: null })) : consensus?.models ?? []).map((model, i, arr) => {
          const isConfirm = model.verdict === "CONFIRM";
          const isReject  = model.verdict === "REJECT";
          const mc = isConfirm ? "#3fb950" : isReject ? "#f85149" : "#484f58";
          const leftAccent = loading ? "#30363d" : isConfirm ? "#238636" : "#f85149";
          return (
            <div key={i} style={{ padding: "9px 12px", borderLeft: `2px solid ${leftAccent}`, borderBottom: i < arr.length - 1 ? "1px solid #21262d" : "none", transition: "all 0.3s" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: loading ? "#484f58" : "#e6edf3" }}>{model.name}</span>
                {!loading && (
                  <span style={{ fontSize: 12, fontWeight: 800, color: mc, letterSpacing: "0.04em" }}>{model.verdict}</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: loading ? "#30363d" : "#8b949e", lineHeight: 1.4, paddingLeft: 20 }}>
                {loading ? "analyzing…" : model.reason}
              </div>
            </div>
          );
        })}
      </div>

      <AnimatePresence>
        {consensus && !loading && (
          <motion.div
            key="actions"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ display: "flex", gap: 8 }}
          >
            {consensus.executeAllowed && (
              <button
                onClick={() => {
                  if (!marketOpen) return;
                  const topReason = consensus.models.find(m => m.verdict === "CONFIRM")?.reason ?? "Multi-model consensus";
                  onConfirmed({ ...consensus, REASON: topReason });
                }}
                disabled={!marketOpen}
                style={{ flex: 1, padding: "9px 0", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: marketOpen ? "pointer" : "default", background: marketOpen ? accentColor : "#21262d", color: marketOpen ? "#fff" : "#8b949e", border: "none" }}
              >
                {marketOpen ? `Execute ${signal.direction}` : "Market closed"}
              </button>
            )}
            {consensus.bridgeError && (
              <button
                onClick={analyze}
                style={{ flex: 1, padding: "9px 0", borderRadius: 7, fontSize: 11, cursor: "pointer", background: "#132f4c", color: "#58a6ff", border: "1px solid #30363d", fontFamily: "inherit", fontWeight: 600 }}
              >
                Retry models
              </button>
            )}
            <button
              onClick={onRejected}
              style={{ flex: 1, padding: "9px 0", borderRadius: 7, fontSize: 11, cursor: "pointer", background: "#161b22", color: "#8b949e", border: "0.5px solid #30363d", fontFamily: "inherit" }}
            >
              Skip
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── TYPING INDICATOR ────────────────────────────────────────────────────────
function TypingIndicator() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 12px", background: "#161b22", border: "1px solid #21262d", borderRadius: 12, borderBottomLeftRadius: 4, width: "fit-content" }}>
      {[0, 1, 2].map(i => (
        <motion.span
          key={i}
          animate={{ y: [0, -4, 0] }}
          transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
          style={{ width: 5, height: 5, borderRadius: "50%", background: "#58a6ff", display: "block" }}
        />
      ))}
    </div>
  );
}

// ─── AI ANALYST TAB ───────────────────────────────────────────────────────────
const CHAT_CHIPS = [
  "Should I trade now?",
  "Best pair today?",
  "USD strong or weak?",
  "Gold outlook?",
  "Market risk today?",
  "EUR/USD next move?",
];

function AIAnalystTab({ headlines, prices, trades, balance, currentHeadline, isMobile }) {
  const [briefLoading, setBriefLoading] = useState(false);
  const [metrics, setMetrics] = useState(null);
  const [question, setQuestion] = useState("");
  const [chatHistory, setChatHistory] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [riskAdvice, setRiskAdvice] = useState(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const [queryCount, setQueryCount] = useState(0);
  const [analysisCount, setAnalysisCount] = useState(0);
  const chatEndRef = useRef(null);

  const estimatedCredits = (queryCount * 0.005 + analysisCount * 0.008).toFixed(3);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, chatLoading]);

  const runAnalysis = async () => {
    setBriefLoading(true);
    const snap = Object.entries(prices).map(([p, v]) => `${p}: ${v}`).join(", ");
    try {
      const result = await callClaude(
        `Prices: ${snap}\nHeadlines: ${headlines.join(" | ")}\n\nRespond in EXACTLY this format, no extra text:\nSENTIMENT: BULLISH or BEARISH or NEUTRAL\nBEST_PAIR: [pair] — [reason, max 12 words]\nKEY_RISK: [risk, max 12 words]\nBRIEF: [2-3 sentence analysis, max 80 words]`,
        "You are a senior market analyst. Follow the output format exactly. No preamble.",
        600
      );
      const parsed = {};
      result.split("\n").forEach(line => {
        const idx = line.indexOf(":");
        if (idx > 0) { parsed[line.slice(0, idx).trim()] = line.slice(idx + 1).trim(); }
      });
      setMetrics({
        sentiment: parsed.SENTIMENT?.toUpperCase() || "NEUTRAL",
        bestPair: parsed.BEST_PAIR || "—",
        keyRisk: parsed.KEY_RISK || "—",
        brief: parsed.BRIEF || result,
      });
      setAnalysisCount(c => c + 1);
    } catch {
      setMetrics({ sentiment: "NEUTRAL", bestPair: "—", keyRisk: "Check connection", brief: "Market analysis unavailable." });
    }
    setBriefLoading(false);
  };

  const askQuestion = async (override) => {
    const text = (override ?? question).trim();
    if (!text || chatLoading) return;
    setQuestion("");
    const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setChatHistory(h => [...h, { role: "user", text, ts }]);
    setChatLoading(true);
    const snap = Object.entries(prices).map(([p, v]) => `${p}: ${v}`).join(", ");
    try {
      const result = await callClaude(
        `Market context: ${snap}\nHeadlines: ${headlines.slice(0, 3).join(" | ")}\n\nTrader question: ${text}`,
        "You are an expert trading assistant. Answer concisely. Max 80 words. Be specific.",
        400
      );
      setChatHistory(h => [...h, { role: "ai", text: result, ts: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
      setQueryCount(c => c + 1);
    } catch {
      setChatHistory(h => [...h, { role: "ai", text: "Unable to connect. Check API key.", ts: "" }]);
    }
    setChatLoading(false);
  };

  const getRiskAdvice = async () => {
    setRiskLoading(true);
    const heat = Math.min(trades.length * 1.2, 8);
    try {
      const result = await callClaude(
        `Portfolio: $${balance.toFixed(2)} | Trades: ${trades.length} | Heat: ${heat.toFixed(1)}R | News: "${currentHeadline}"\n\nOne risk management action right now. Max 25 words. Start with an action verb.`,
        "You are a risk manager at a prop trading firm. Be direct.",
        150
      );
      setRiskAdvice(result);
      setQueryCount(c => c + 1);
    } catch {
      setRiskAdvice("Maintain 1.5% risk per trade. Never exceed 6R total heat.");
    }
    setRiskLoading(false);
  };

  const sentimentColor = metrics?.sentiment === "BULLISH" ? "#3fb950" : metrics?.sentiment === "BEARISH" ? "#f85149" : "#d29922";

  return (
    <div style={{ padding: "0 16px", display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Two-column main ── */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16, alignItems: "start" }}>

        {/* LEFT: Market Brief */}
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>What's the market doing?</div>
            </div>
            <button
              onClick={runAnalysis}
              disabled={briefLoading}
              style={{ fontSize: 11, padding: "6px 14px", borderRadius: 6, cursor: briefLoading ? "default" : "pointer", border: "1px solid #30363d", background: briefLoading ? "#161b22" : "#132f4c", color: briefLoading ? "#8b949e" : "#58a6ff", fontWeight: 500, fontFamily: "inherit", transition: "all 0.15s" }}
            >
              {briefLoading ? "Analyzing..." : "Xavier, analyze now ↗"}
            </button>
          </div>

          <div style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: "12px", fontSize: 12, lineHeight: 1.7, minHeight: 88 }}>
            {briefLoading
              ? <span style={{ color: "#58a6ff" }}>Scanning markets…</span>
              : metrics?.brief
                ? <span style={{ color: "#c9d1d9" }}>{metrics.brief}</span>
                : <span style={{ color: "#8b949e" }}>Xavier is ready. Hit the button and I'll give you a sharp read on all 8 pairs right now.</span>
            }
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 4, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em" }}>Sentiment</div>
              {metrics?.sentiment
                ? <div style={{ fontSize: 16, fontWeight: 600, color: sentimentColor, fontFamily: FONT_MONO }}>{metrics.sentiment}</div>
                : <div style={{ fontSize: 11, color: "#8b949e", fontStyle: "italic" }}>Click analyze ↑</div>}
            </div>
            <div style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 4, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em" }}>Best Opportunity</div>
              {metrics?.bestPair
                ? <div style={{ fontSize: 12, color: "#e6edf3", lineHeight: 1.5 }}>{metrics.bestPair}</div>
                : <div style={{ fontSize: 11, color: "#8b949e", fontStyle: "italic" }}>Click analyze ↑</div>}
            </div>
            <div style={{ background: "#161b22", border: "1px solid rgba(248,81,73,0.25)", borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: "#f85149", marginBottom: 4, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em" }}>Key Risk</div>
              {metrics?.keyRisk
                ? <div style={{ fontSize: 12, color: "#e6edf3", lineHeight: 1.5 }}>{metrics.keyRisk}</div>
                : <div style={{ fontSize: 11, color: "#8b949e", fontStyle: "italic" }}>Click analyze ↑</div>}
            </div>
          </div>
        </div>

        {/* RIGHT: Chat */}
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>Ask Xavier</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, height: 280, overflowY: "auto", paddingRight: 2 }}>
            {chatHistory.length === 0 && !chatLoading && (
              <div style={{ color: "#8b949e", fontSize: 11, textAlign: "center", marginTop: 40 }}>Ask anything about market conditions, pairs, or strategy.</div>
            )}
            {chatHistory.map((m, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 3, paddingLeft: m.role === "user" ? 0 : 2, paddingRight: m.role === "user" ? 2 : 0 }}>
                  {m.role === "user" ? "You" : "Xavier"}{m.ts ? ` · ${m.ts}` : ""}
                </div>
                {m.role === "user" ? (
                  <div style={{ padding: "8px 12px", borderRadius: 12, borderBottomRightRadius: 4, fontSize: 12, lineHeight: 1.6, maxWidth: "88%", background: "#132f4c", border: "1px solid #1f4e8c", color: "#a5d6ff" }}>
                    {m.text}
                  </div>
                ) : (
                  <div style={{ padding: "8px 12px", borderRadius: 12, borderBottomLeftRadius: 4, fontSize: 12, lineHeight: 1.6, maxWidth: "88%", background: "#161b22", border: "1px solid #21262d", color: "#c9d1d9" }}
                    dangerouslySetInnerHTML={{ __html: m.text.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>") }}
                  />
                )}
              </div>
            ))}
            {chatLoading && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 3 }}>Xavier</div>
                <TypingIndicator />
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {CHAT_CHIPS.map(chip => (
              <button key={chip} onClick={() => askQuestion(chip)} disabled={chatLoading} style={{ fontSize: 10, padding: "3px 10px", borderRadius: 12, cursor: chatLoading ? "default" : "pointer", border: "1px solid #30363d", background: "transparent", color: "#8b949e", fontFamily: "inherit", transition: "all 0.15s", opacity: chatLoading ? 0.4 : 1 }}>
                {chip}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => e.key === "Enter" && askQuestion()}
              placeholder="Ask Xavier anything — pairs, strategy, risk..."
              style={{ flex: 1, fontSize: 11, padding: "8px 12px", borderRadius: 8, border: "1px solid #30363d", background: "#161b22", color: "#e6edf3", outline: "none", fontFamily: "inherit" }}
            />
            <button
              onClick={() => askQuestion()}
              disabled={chatLoading || !question.trim()}
              style={{ padding: "8px 16px", borderRadius: 8, fontSize: 11, cursor: chatLoading || !question.trim() ? "default" : "pointer", background: chatLoading || !question.trim() ? "#161b22" : "#132f4c", color: chatLoading || !question.trim() ? "#8b949e" : "#58a6ff", border: "1px solid #30363d", fontWeight: 500, fontFamily: "inherit", transition: "all 0.15s" }}
            >
              Send ↗
            </button>
          </div>
        </div>
      </div>

      {/* ── Bottom bar: Risk Advisor + Session Stats ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 200px", gap: 16 }}>
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: riskAdvice ? 10 : 0 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>Xavier's risk read</div>
              <div style={{ fontSize: 11, color: "#8b949e", marginTop: 2 }}>Portfolio heat · position sizing</div>
            </div>
            <button onClick={getRiskAdvice} disabled={riskLoading} style={{ fontSize: 11, padding: "6px 14px", borderRadius: 6, cursor: "pointer", border: "1px solid rgba(248,81,73,0.4)", background: "rgba(248,81,73,0.08)", color: "#f85149", fontWeight: 500, fontFamily: "inherit", transition: "all 0.15s" }}>
              {riskLoading ? "Checking…" : "Xavier, check my risk ↗"}
            </button>
          </div>
          {riskAdvice && (
            <div style={{ background: "rgba(248,81,73,0.06)", border: "1px solid rgba(248,81,73,0.2)", borderRadius: 8, padding: "10px 12px", fontSize: 12, color: "#c9d1d9", lineHeight: 1.6 }}>
              {riskAdvice}
            </div>
          )}
        </div>

        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3", marginBottom: 12 }}>Session</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { label: "Queries", value: String(queryCount) },
              { label: "Analyses", value: String(analysisCount) },
              { label: "Est. cost", value: `~$${estimatedCredits}` },
            ].map(({ label, value }) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "#8b949e" }}>{label}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3", fontFamily: FONT_MONO }}>{value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── REGIME BADGE ─────────────────────────────────────────────────────────────
function RegimeBadge({ regime }) {
  if (!regime) return null;
  const map = {
    TRENDING:  { color: "#388bfd", bg: "rgba(56,139,253,0.1)",  border: "#1f4b8e"  },
    RANGING:   { color: "#d29922", bg: "rgba(210,153,34,0.1)",  border: "#7a5200"  },
    VOLATILE:  { color: "#f85149", bg: "rgba(248,81,73,0.1)",   border: "#8e1a17"  },
  };
  const s = map[regime] || map.RANGING;
  return (
    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.4px", padding: "1px 5px", borderRadius: 3, background: s.bg, color: s.color, border: `1px solid ${s.border}`, marginTop: 2 }}>
      {regime}
    </span>
  );
}

// ─── PAIR ROW WITH AI CONFIRM ─────────────────────────────────────────────────
const MOBILE_ACTION_ROW_H = 62;

function PairRow({ pair, basePrice, strategy, onTrade, currentHeadline, onSignalUpdate, onRegimeUpdate, onRejection, openTrades, marketOpen, isMobile }) {
  const { price, history } = usePriceSimulator(basePrice);
  const rawSignal = generateSignal(history, strategy, pair);
  const signal = isMobile ? useStableSignal(rawSignal) : rawSignal;
  const prev = history[history.length - 2] ?? price;
  const [showAI, setShowAI] = useState(false);
  const [gkReject, setGkReject] = useState(null);
  const decimals = priceDecimals(pair);
  const signalKey = signal ? `${signal.direction}-${signal.score}` : null;

  const regimeData = calcRegime(history);
  const prevRegime = useRef(null);
  useEffect(() => {
    if (regimeData.regime !== prevRegime.current) {
      prevRegime.current = regimeData.regime;
      onRegimeUpdate?.(pair, regimeData.regime);
    }
  }, [regimeData.regime, pair, onRegimeUpdate]);

  const hasSignal = !!signal;
  const prevHasSignal = useRef(null);
  useEffect(() => {
    if (hasSignal !== prevHasSignal.current) {
      prevHasSignal.current = hasSignal;
      onSignalUpdate?.(pair, hasSignal);
    }
  }, [hasSignal, pair, onSignalUpdate]);

  const handleAICheck = () => {
    if (!signal) return;
    const gk = runGatekeepers(history, signal, openTrades, pair);
    if (!gk.passed) {
      const first = gk.rejections[0];
      setGkReject(first);
      onRejection?.({ pair, direction: signal.direction, score: signal.score, ...first, timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) });
      setTimeout(() => setGkReject(null), 5000);
      return;
    }
    setShowAI(s => !s);
  };

  const priceColorRef = useRef("#8b949e");
  if (price > prev) priceColorRef.current = "#3fb950";
  else if (price < prev) priceColorRef.current = "#f85149";
  const priceStyle = { fontFamily: FONT_MONO, color: priceColorRef.current, fontWeight: 600 };

  const changeNum = history.length > 0 ? (price - history[0]) / history[0] * 100 : 0;
  const changeColor = changeNum > 0 ? "#3fb950" : changeNum < 0 ? "#f85149" : "#8b949e";
  const changeArrow = changeNum > 0 ? "▲" : changeNum < 0 ? "▼" : "—";
  const changeDisplay = changeNum === 0 ? "—" : `${changeArrow} ${Math.abs(changeNum).toFixed(3)}%`;

  const rejectPanel = (
    <AnimatePresence>
      {gkReject && (
        <motion.div key="gk-panel" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
          style={isMobile ? { margin: "0 12px 6px", overflow: "hidden" } : { padding: "0 16px 12px", overflow: "hidden" }}>
          <div style={{ background: "rgba(248,81,73,0.07)", border: "1px solid rgba(248,81,73,0.3)", borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#f85149", marginBottom: 4 }}>⛔ Blocked — {gkReject.condition}</div>
            <div style={{ fontSize: 11, color: "#c9d1d9", lineHeight: 1.5 }}>{gkReject.reason}</div>
            <div style={{ fontSize: 10, color: "#484f58", marginTop: 4, fontFamily: FONT_MONO }}>
              Actual: {gkReject.actual} · Limit: {gkReject.threshold}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  const aiPanel = (
    <AnimatePresence>
      {showAI && signal && (
        <motion.div
          key="ai-panel"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.25 }}
          style={isMobile ? { margin: "0 12px 6px", overflow: "hidden" } : { padding: "0 16px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)", overflow: "hidden" }}
        >
          <AISignalConfirm
            pair={pair} signal={signal} price={price} history={history}
            currentHeadline={currentHeadline} marketOpen={marketOpen}
            onConfirmed={(verdict) => { onTrade(pair, signal, price, verdict); setShowAI(false); }}
            onRejected={() => setShowAI(false)}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );

  if (isMobile) {
    const sigColor = signal?.direction === "LONG" ? "#238636" : "#c0392b";
    return (
      <>
        <div style={{ margin: "6px 12px", borderRadius: 12, background: "#161b22", border: "1px solid #21262d", overflow: "hidden" }}>
          {/* Row 1: pair + regime + price */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "12px 14px 4px" }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontWeight: 700, color: "#e6edf3", fontSize: 16 }}>{pair}</span>
              <RegimeBadge regime={regimeData.regime} />
            </div>
            <AnimatedNumber value={price} decimals={decimals} style={{ ...priceStyle, fontSize: 18, fontFamily: FONT_MONO }} />
          </div>
          {/* Row 2: change + signal badge */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 14px 10px" }}>
            <span style={{ fontFamily: FONT_MONO, color: changeColor, fontSize: 11 }}>{changeDisplay}</span>
            {signal ? (
              <motion.span key={signalKey} initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: signal.direction === "LONG" ? "rgba(35,134,54,0.2)" : "rgba(192,57,43,0.2)", color: signal.direction === "LONG" ? "#3fb950" : "#f85149", border: `0.5px solid ${sigColor}` }}>
                {signal.direction} {signal.score}%
              </motion.span>
            ) : (
              <span style={{ fontSize: 10, color: "#484f58" }}>No signal</span>
            )}
          </div>
          {/* Row 3: sparkline full width */}
          <div style={{ lineHeight: 0 }}>
            <BezierSpark history={history} height={56} fullWidth />
          </div>
          {/* Row 4: AI Check button – only when signal */}
          {signal && (
            <div style={{ padding: "10px 14px 12px" }}>
              <button
                onClick={handleAICheck}
                style={{ width: "100%", height: 40, borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", background: signal.direction === "LONG" ? "#238636" : "#c0392b", color: "#fff", border: "none" }}
              >
                {showAI ? "Hide AI" : "AI Check ↗"}
              </button>
            </div>
          )}
        </div>
        {rejectPanel}
        {aiPanel}
      </>
    );
  }

  return (
    <>
      <div
        style={{ display: "grid", gridTemplateColumns: TABLE_COLS, gap: TABLE_GAP, alignItems: "center", padding: TABLE_PAD, borderBottom: (showAI || gkReject) ? "none" : "1px solid #21262d", minHeight: 52, fontSize: 12, transition: "background 0.15s", width: "100%", boxSizing: "border-box" }}
        onMouseEnter={e => e.currentTarget.style.background = "#1c2333"}
        onMouseLeave={e => e.currentTarget.style.background = ""}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontWeight: 700, color: "#e6edf3", fontSize: 14, letterSpacing: "0.3px" }}>{pair}</span>
          <RegimeBadge regime={regimeData.regime} />
        </div>
        <AnimatedNumber value={price} decimals={decimals} style={{ ...priceStyle, fontSize: 15, textAlign: "left" }} />
        <div style={{ textAlign: "left" }}>
          <OandaChart pair={pair} history={history} height={40} />
        </div>
        <span style={{ fontFamily: FONT_MONO, color: changeColor, fontSize: 12, fontWeight: 500, display: "flex", alignItems: "center", gap: 4, textAlign: "left" }}>
          <span style={{ fontSize: 10 }}>{changeArrow !== "—" ? changeArrow : ""}</span>
          {changeNum === 0 ? "—" : `${Math.abs(changeNum).toFixed(3)}%`}
        </span>
        <div style={{ textAlign: "center" }}>
          {signal ? (
            <motion.div
              key={signalKey}
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{
                scale: 1,
                opacity: 1,
                boxShadow: [
                  "0 0 0 rgba(29,158,117,0)",
                  signal.direction === "LONG" ? "0 0 10px rgba(29,158,117,0.35)" : "0 0 10px rgba(226,75,74,0.35)",
                  "0 0 0 rgba(29,158,117,0)",
                ],
              }}
              transition={{
                scale: { type: "spring", stiffness: 420, damping: 18 },
                opacity: { duration: 0.2 },
                boxShadow: { duration: 0.65, times: [0, 0.45, 1] },
              }}
              style={{ display: "inline-block", padding: "5px 12px", borderRadius: 5, fontSize: 11, fontWeight: 700, textAlign: "center", letterSpacing: "0.3px", background: signal.direction === "LONG" ? "#0f2d1a" : "#2d0f0f", color: signal.direction === "LONG" ? "#3fb950" : "#f85149", border: `1px solid ${signal.direction === "LONG" ? "#238636" : "#f85149"}` }}
            >
              {signal.direction} {signal.score}%
            </motion.div>
          ) : (
            <div style={{ display: "inline-block", padding: "5px 12px", borderRadius: 5, fontSize: 11, fontWeight: 400, textAlign: "center", background: "#21262d", color: "#8b949e" }}>No signal</div>
          )}
        </div>
        <div style={{ textAlign: "right" }}>
          {signal ? (
            <button onClick={handleAICheck} style={{ padding: "5px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer", fontWeight: 600, background: "#132f4c", color: "#58a6ff", border: "1px solid #388bfd", whiteSpace: "nowrap", fontFamily: "inherit", transition: "background 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.background = "#1c4070"}
              onMouseLeave={e => e.currentTarget.style.background = "#132f4c"}
            >
              {showAI ? "Hide AI" : "AI Check ↗"}
            </button>
          ) : (
            <button disabled style={{ padding: "5px 12px", borderRadius: 6, fontSize: 11, opacity: 0.3, background: "#21262d", border: "1px solid #30363d", color: "#8b949e", fontFamily: "inherit" }}>—</button>
          )}
        </div>
      </div>
      {rejectPanel}
      {aiPanel}
    </>
  );
}

// ─── TRADE LOG ────────────────────────────────────────────────────────────────
function TradeLog({ trades, isMobile }) {
  return (
    <div style={isMobile ? { background: "#0d1117", padding: 12, marginTop: 4 } : { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "16px" }}>
      <div style={isMobile ? { fontSize: 12, fontWeight: 600, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 } : { fontSize: 13, fontWeight: 500, marginBottom: 8, color: "var(--color-text-primary)" }}>
        {isMobile ? "Trade Journal" : <>Trade journal <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", fontWeight: 400 }}>({trades.length} entries)</span></>}
      </div>
      {trades.length === 0 && (
        <div style={isMobile ? { background: "#161b22", border: "1px solid #21262d", borderRadius: 10, padding: 16, textAlign: "center", fontSize: 12, color: "#8b949e" } : { fontSize: 12, color: "var(--color-text-tertiary)", padding: "8px 0" }}>
          {isMobile ? "No trades yet · AI Check signals to execute" : "No trades yet. Click \"AI Check\" on any signal to execute with AI confirmation."}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 6 : 8, maxHeight: isMobile ? "none" : 200, overflowY: isMobile ? "visible" : "auto" }}>
        {isMobile ? (
          trades.slice().reverse().map((t) => (
            <div
              key={t.id}
              style={{ padding: "10px 12px", borderRadius: 10, fontSize: 12, background: "#161b22", border: "1px solid #21262d", borderLeft: `3px solid ${t.dir === "LONG" ? "#3fb950" : "#f85149"}` }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 700, color: "#e6edf3" }}>{t.pair}</span>
                <span style={{ color: t.dir === "LONG" ? "#3fb950" : "#f85149", fontWeight: 600, fontSize: 11 }}>{t.dir}</span>
                <span style={{ fontFamily: FONT_MONO, color: "#8b949e", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{t.price}</span>
                <span style={{ color: "#484f58", fontSize: 10, flexShrink: 0 }}>{t.time}</span>
              </div>
              {t.aiReason && (
                <div style={{ fontSize: 10, color: "#8b949e", marginTop: 4, fontStyle: "italic" }}>{t.aiReason}</div>
              )}
            </div>
          ))
        ) : (
          <AnimatePresence initial={false}>
            {trades.slice().reverse().map((t) => (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 16 }}
                transition={{ type: "spring", stiffness: 300, damping: 28 }}
                style={{ padding: "8px", borderRadius: 6, fontSize: 11, background: t.dir === "LONG" ? "rgba(29,158,117,0.07)" : "rgba(226,75,74,0.07)", border: `0.5px solid ${t.dir === "LONG" ? "rgba(29,158,117,0.25)" : "rgba(226,75,74,0.25)"}` }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>{t.pair}</span>
                  <span style={{ color: t.dir === "LONG" ? "#0F6E56" : "#A32D2D", fontWeight: 600 }}>{t.dir}</span>
                  <span style={{ fontFamily: FONT_MONO, color: "var(--color-text-secondary)" }}>{t.price}</span>
                  <span style={{ color: "var(--color-text-tertiary)" }}>{t.time}</span>
                </div>
                {t.aiReason && (
                  <div style={{ fontSize: 10, color: "#8b949e", marginTop: 4, fontStyle: "italic" }}>{t.aiReason}</div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

// ─── REJECTION LOG PANEL ─────────────────────────────────────────────────────
function RejectionLogPanel({ log, isMobile }) {
  if (log.length === 0) return null;
  return (
    <div style={isMobile
      ? { background: "#0d1117", padding: "12px", marginTop: 4 }
      : { background: "#161b22", border: "1px solid #21262d", borderRadius: 10, padding: "12px 14px", margin: "12px 16px 0" }
    }>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.5px" }}>
          Rejection Log
        </span>
        <span style={{ fontSize: 11, background: "rgba(248,81,73,0.1)", color: "#f85149", border: "1px solid rgba(248,81,73,0.3)", padding: "1px 8px", borderRadius: 10 }}>
          {log.length} blocked
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {log.slice(0, 10).map((entry, i) => (
          <div key={i} style={{ padding: "8px 10px", borderRadius: 7, background: "#0d1117", border: "1px solid #21262d", borderLeft: "3px solid rgba(248,81,73,0.5)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3" }}>
                {entry.pair} <span style={{ color: entry.direction === "LONG" ? "#3fb950" : "#f85149" }}>{entry.direction}</span>
                <span style={{ color: "#484f58", fontWeight: 400 }}> {entry.score}%</span>
              </span>
              <span style={{ fontSize: 10, color: "#484f58", fontFamily: FONT_MONO }}>{entry.timestamp}</span>
            </div>
            <div style={{ fontSize: 11, color: "#f85149", fontWeight: 600, marginBottom: 2 }}>⛔ {entry.condition}</div>
            <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.4 }}>{entry.reason}</div>
            <div style={{ fontSize: 10, color: "#484f58", marginTop: 3, fontFamily: FONT_MONO }}>
              {entry.actual} vs limit {entry.threshold}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── NEWS TICKER ──────────────────────────────────────────────────────────────
const TICKER_ITEMS = [
  { source: "Bloomberg", headline: "BOJ intervenes as USD/JPY tests 158.00" },
  { source: "DailyFX", headline: "EUR/USD breaks key resistance at 1.0890" },
  { source: "Reuters", headline: "Gold surges on geopolitical risk premium" },
  { source: "CNBC", headline: "NFP beats expectations +285K jobs" },
  { source: "Benzinga Pro", headline: "BTC consolidates above $68K support" },
  { source: "MarketBeat", headline: "USD weakness continues as DXY tests 102.30" },
];

const NEWS_SOURCE_STYLES = {
  Bloomberg:    { color: "#ff8c00", bg: "rgba(255,140,0,0.12)",  border: "rgba(255,140,0,0.35)" },
  DailyFX:      { color: "#58a6ff", bg: "rgba(88,166,255,0.12)", border: "rgba(88,166,255,0.35)" },
  Reuters:      { color: "#ff6b35", bg: "rgba(255,107,53,0.12)", border: "rgba(255,107,53,0.35)" },
  CNBC:         { color: "#60a5fa", bg: "rgba(96,165,250,0.12)", border: "rgba(96,165,250,0.35)" },
  "Benzinga Pro": { color: "#34d399", bg: "rgba(52,211,153,0.12)", border: "rgba(52,211,153,0.35)" },
  MarketBeat:   { color: "#a78bfa", bg: "rgba(167,139,250,0.12)", border: "rgba(167,139,250,0.35)" },
};

function TickerSourceBadge({ source }) {
  const s = NEWS_SOURCE_STYLES[source] || { color: "#8b949e", bg: "rgba(139,148,158,0.1)", border: "rgba(139,148,158,0.25)" };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        marginRight: 8,
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.03em",
        color: s.color,
        background: s.bg,
        border: `1px solid ${s.border}`,
        flexShrink: 0,
      }}
    >
      {source}
    </span>
  );
}

function TickerTrack({ items }) {
  return (
    <>
      {items.map((item, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", marginRight: 28 }}>
          <TickerSourceBadge source={item.source} />
          <span style={{ color: "#c9d1d9", fontWeight: 400 }}>{item.headline}</span>
          <span style={{ color: "#30363d", marginLeft: 28, userSelect: "none" }}>◆</span>
        </span>
      ))}
    </>
  );
}

function NewsTicker({ onHeadlineChange }) {
  const [, setIdx] = useState(0);
  useEffect(() => {
    onHeadlineChange(LIVE_HEADLINES[0]);
    const id = setInterval(() => {
      setIdx(i => {
        const next = (i + 1) % LIVE_HEADLINES.length;
        onHeadlineChange(LIVE_HEADLINES[next]);
        return next;
      });
    }, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ display: "flex", alignItems: "center", overflow: "hidden", height: 36, background: "#0d1117", borderBottom: "1px solid #21262d" }}>
      <div style={{ background: "linear-gradient(135deg, #da3633 0%, #b62324 100%)", color: "#fff", fontSize: 10, fontWeight: 800, padding: "0 12px", height: "100%", display: "flex", alignItems: "center", letterSpacing: "1.5px", flexShrink: 0, boxShadow: "2px 0 12px rgba(218,54,51,0.25)" }}>
        LIVE
      </div>
      <div style={{ overflow: "hidden", flex: 1, height: "100%", display: "flex", alignItems: "center", maskImage: "linear-gradient(90deg, transparent 0%, #000 2%, #000 98%, transparent 100%)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", whiteSpace: "nowrap", animation: "marquee 40s linear infinite", paddingLeft: "100%", fontSize: 12 }}>
          <TickerTrack items={TICKER_ITEMS} />
          <TickerTrack items={TICKER_ITEMS} />
        </span>
      </div>
    </div>
  );
}

// ─── KNOWLEDGE PANEL ──────────────────────────────────────────────────────────
const KNOWLEDGE_TRENDING = [
  "EMA crossover signals trending 23% above baseline this week",
  "Van Tharp 3R+ setups showing 68% win rate — momentum confirmed",
  "Momentum patterns active on USD pairs during NY session overlap",
];

const KNOWLEDGE_CATS = [
  { key: "marketWizards",   label: "Market Wizards",  icon: "📚", color: "#58a6ff" },
  { key: "vanTharpRules",   label: "Van Tharp",       icon: "📊", color: "#1D9E75" },
  { key: "mt5Patterns",     label: "MT5 Patterns",    icon: "📈", color: "#F97316" },
  { key: "quantConnectEdge",label: "QuantConnect",    icon: "⚡", color: "#8B5CF6" },
];

const OPT_SCHEDULE = [
  { freq: "Weekly",  task: "Knowledge repo sync" },
  { freq: "Monthly", task: "Pattern performance review" },
];

function KnowledgePanel({ activeRule }) {
  const [category, setCategory] = useState("marketWizards");
  const [search, setSearch] = useState("");
  const [activeRules, setActiveRules] = useState(new Set());

  const cat = KNOWLEDGE_CATS.find(c => c.key === category);
  const rules = KNOWLEDGE_BASE[category];
  const filtered = search ? rules.filter(r => r.toLowerCase().includes(search.toLowerCase())) : rules;

  const toggleRule = (rule) => setActiveRules(prev => {
    const next = new Set(prev);
    if (next.has(rule)) next.delete(rule); else next.add(rule);
    return next;
  });

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
      {/* Left sidebar */}
      <div style={{ width: 200, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "12px", display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 10, color: "#8b949e", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Categories</div>
          {KNOWLEDGE_CATS.map(c => (
            <button key={c.key} onClick={() => { setCategory(c.key); setSearch(""); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", borderRadius: 8, cursor: "pointer", border: `1px solid ${category === c.key ? c.color : "#21262d"}`, background: category === c.key ? `${c.color}18` : "#161b22", width: "100%", textAlign: "left", pointerEvents: "all" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 14 }}>{c.icon}</span>
                <span style={{ fontSize: 11, fontWeight: 500, color: category === c.key ? c.color : "#8b949e" }}>{c.label}</span>
              </div>
              <span style={{ fontSize: 10, color: category === c.key ? c.color : "#484f58", background: category === c.key ? `${c.color}20` : "#21262d", padding: "1px 5px", borderRadius: 3 }}>{KNOWLEDGE_BASE[c.key].length}</span>
            </button>
          ))}
        </div>

        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "12px" }}>
          <div style={{ fontSize: 10, color: "#8b949e", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Opt Schedule</div>
          {OPT_SCHEDULE.map((item, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 0", borderBottom: i < OPT_SCHEDULE.length - 1 ? "0.5px solid #21262d" : "none" }}>
              <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "#21262d", color: "#8b949e", fontWeight: 500 }}>{item.freq}</span>
              <span style={{ fontSize: 10, color: "#6e7681", flex: 1 }}>{item.task}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Right main area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "12px" }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={`Search ${cat?.label} rules…`} style={{ width: "100%", fontSize: 12, padding: "8px 12px", borderRadius: 8, border: "1px solid #30363d", background: "#161b22", color: "#e6edf3", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
        </div>

        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3", marginBottom: 4 }}>
            {cat?.label} <span style={{ fontSize: 11, color: "#8b949e", fontWeight: 400 }}>· {filtered.length} rules</span>
          </div>
          {filtered.map((rule, i) => {
            const isActive = activeRules.has(rule) || activeRule === rule;
            return (
              <div key={i} onClick={() => toggleRule(rule)} style={{ fontSize: 12, color: isActive ? "#e6edf3" : "#8b949e", padding: "10px 12px", background: isActive ? `${cat?.color}18` : "#161b22", borderRadius: 8, borderLeft: `2px solid ${isActive ? cat?.color : "#21262d"}`, cursor: "pointer", transition: "all 0.2s", lineHeight: 1.5 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>{rule}</span>
                  {isActive && <span style={{ fontSize: 10, color: cat?.color, marginLeft: 8, flexShrink: 0 }}>✓ Active</span>}
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && <div style={{ fontSize: 12, color: "#8b949e", textAlign: "center", padding: "16px 0" }}>No rules match your search.</div>}
        </div>

        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3", marginBottom: 8 }}>Trending Updates</div>
          {KNOWLEDGE_TRENDING.map((update, i) => (
            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 0", borderBottom: i < KNOWLEDGE_TRENDING.length - 1 ? "0.5px solid #21262d" : "none" }}>
              <span style={{ fontSize: 10, color: "#3fb950", marginTop: 2, flexShrink: 0 }}>↑</span>
              <span style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.4 }}>{update}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── RISK TAB ────────────────────────────────────────────────────────────────
function statusBadge(status) {
  const map = {
    Safe:    { bg: "rgba(29,158,117,0.12)",  color: "#1D9E75", border: "rgba(29,158,117,0.3)"  },
    Monitor: { bg: "rgba(186,117,23,0.12)",  color: "#BA7517", border: "rgba(186,117,23,0.3)"  },
    Standby: { bg: "rgba(226,75,74,0.12)",   color: "#E24B4A", border: "rgba(226,75,74,0.3)"  },
  };
  const s = map[status] || map.Safe;
  return <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: s.bg, color: s.color, border: `0.5px solid ${s.border}`, fontWeight: 500 }}>{status}</span>;
}

function RiskTab({ trades, balance }) {
  const openTrades = trades.length;
  const riskPct = Math.min(openTrades * 1.2, 8);
  const drawdown = ((100 - balance) / 100 * 100).toFixed(2);
  const heatColor = riskPct > 6 ? "#E24B4A" : riskPct > 4 ? "#BA7517" : "#1D9E75";

  const metrics = [
    { label: "Portfolio Heat",  value: `${riskPct.toFixed(1)}R`, color: heatColor },
    { label: "Max Drawdown",    value: `${drawdown}%`,           color: parseFloat(drawdown) > 5 ? "#E24B4A" : "#1D9E75" },
    { label: "Open Positions",  value: openTrades,               color: "#e6edf3" },
    { label: "Circuit Breaker", value: riskPct > 6 ? "ACTIVE" : "Standby", color: riskPct > 6 ? "#E24B4A" : "#1D9E75" },
  ];

  const sessionSummary = [
    { label: "Session P&L",  value: `${(balance - 100).toFixed(2)}%`, status: balance >= 100 ? "Safe" : "Monitor" },
    { label: "Trades taken", value: openTrades,                        status: openTrades < 3 ? "Safe" : openTrades < 5 ? "Monitor" : "Standby" },
    { label: "Risk used",    value: `${riskPct.toFixed(1)}R`,          status: riskPct < 4 ? "Safe" : riskPct < 6 ? "Monitor" : "Standby" },
    { label: "Daily heat",   value: `${Math.min(riskPct * 1.5, 10).toFixed(1)}R`, status: riskPct < 3 ? "Safe" : riskPct < 5 ? "Monitor" : "Standby" },
  ];

  const vanTharpRows = [
    { rule: "1R risk per trade",  value: "1.5%",          status: "Safe" },
    { rule: "ATR stop placement", value: "1.5× ATR(14)",  status: "Safe" },
    { rule: "Min reward target",  value: "3R minimum",    status: "Safe" },
    { rule: "Max open heat",      value: `${riskPct.toFixed(1)}R / 6R`, status: riskPct < 4 ? "Safe" : riskPct < 6 ? "Monitor" : "Standby" },
    { rule: "Circuit breaker",    value: "3% daily DD",   status: parseFloat(drawdown) < 1.5 ? "Safe" : parseFloat(drawdown) < 3 ? "Monitor" : "Standby" },
  ];

  const sessionRisk = [
    { session: "Sydney",   time: "22:00–07:00 UTC", volatility: "Low",     status: "Safe"    },
    { session: "Tokyo",    time: "00:00–09:00 UTC", volatility: "Medium",  status: "Monitor" },
    { session: "London",   time: "07:00–16:00 UTC", volatility: "High",    status: isSessionActive(SESSIONS[2]) ? "Monitor" : "Safe" },
    { session: "New York", time: "13:00–22:00 UTC", volatility: "High",    status: isSessionActive(SESSIONS[3]) ? "Monitor" : "Safe" },
    { session: "Overlap",  time: "13:00–16:00 UTC", volatility: "Extreme", status: "Standby" },
  ];

  return (
    <div style={{ padding: "0 16px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
      {/* Left */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 12 }}>Portfolio Heat Gauge</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div style={{ flex: 1, height: 12, background: "#161b22", borderRadius: 6, overflow: "hidden" }}>
              <motion.div animate={{ width: `${(riskPct / 8) * 100}%`, backgroundColor: heatColor }} transition={{ type: "spring", stiffness: 280, damping: 26 }} style={{ height: "100%", borderRadius: 6 }} />
            </div>
            <span style={{ fontSize: 18, fontWeight: 700, color: heatColor, fontFamily: FONT_MONO, minWidth: 44 }}>{riskPct.toFixed(1)}R</span>
          </div>
          <input type="range" min="0" max="8" step="0.1" value={riskPct} readOnly style={{ width: "100%", accentColor: heatColor, cursor: "default" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#8b949e", marginTop: 4 }}>
            <span>0R Safe</span><span>4R Caution</span><span>6R Max</span><span>8R Halt</span>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {metrics.map((m, i) => (
            <div key={i} style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 10, padding: "12px" }}>
              <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{m.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: m.color, fontFamily: FONT_MONO }}>{m.value}</div>
            </div>
          ))}
        </div>

        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 10 }}>Session Summary</div>
          {sessionSummary.map((row, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < sessionSummary.length - 1 ? "0.5px solid #21262d" : "none" }}>
              <span style={{ fontSize: 12, color: "#8b949e" }}>{row.label}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, fontFamily: FONT_MONO, color: "#e6edf3" }}>{row.value}</span>
                {statusBadge(row.status)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 10 }}>Van Tharp Rules</div>
          {vanTharpRows.map((row, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < vanTharpRows.length - 1 ? "0.5px solid #21262d" : "none" }}>
              <div>
                <div style={{ fontSize: 12, color: "#c9d1d9" }}>{row.rule}</div>
                <div style={{ fontSize: 10, color: "#8b949e", fontFamily: FONT_MONO, marginTop: 1 }}>{row.value}</div>
              </div>
              {statusBadge(row.status)}
            </div>
          ))}
        </div>

        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 10 }}>Market Session Risk</div>
          {sessionRisk.map((row, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < sessionRisk.length - 1 ? "0.5px solid #21262d" : "none" }}>
              <div>
                <div style={{ fontSize: 12, color: "#c9d1d9" }}>{row.session}</div>
                <div style={{ fontSize: 10, color: "#8b949e", marginTop: 1 }}>{row.time}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 10, color: "#8b949e" }}>{row.volatility}</span>
                {statusBadge(row.status)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── AI COACH TAB ─────────────────────────────────────────────────────────────
const COACH_SCHEDULE = [
  { freq: "Real-time", task: "AI signal confirmation before every trade",    active: true  },
  { freq: "On demand", task: "Market analysis and opportunity scanning",      active: true  },
  { freq: "Per trade", task: "Journal entry with AI behavioral tag",          active: true  },
  { freq: "Weekly",    task: "Knowledge repo sync with trending data",        active: false },
  { freq: "Monthly",   task: "Full performance coaching report",              active: false },
];

function behavioralTags(trade) {
  const tags = [];
  if (trade.score >= 70) tags.push({ label: "High Conf",   color: "#1D9E75" });
  if (trade.score < 50)  tags.push({ label: "Low Conf",    color: "#E24B4A" });
  if (trade.strategy === "Trend Follow") tags.push({ label: "Trend",    color: "#58a6ff" });
  if (trade.strategy === "Mean Revert")  tags.push({ label: "Reversal", color: "#F97316" });
  if (trade.strategy === "Momentum")     tags.push({ label: "Momentum", color: "#8B5CF6" });
  if (trade.strategy === "Breakout")     tags.push({ label: "Breakout", color: "#d29922" });
  if (trade.aiReason) tags.push({ label: "AI Verified", color: "#d29922" });
  return tags;
}

function AICoachTab({ trades, isMobile }) {
  const [loading, setLoading] = useState(false);
  const [coachOutput, setCoachOutput] = useState(null);

  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? Math.round(trades.filter(t => t.score >= 60).length / totalTrades * 100) : 0;
  const avgR = totalTrades > 0 ? (trades.reduce((sum, t) => sum + t.score / 100 * 2, 0) / totalTrades).toFixed(2) : "0.00";

  const analyze = async () => {
    if (trades.length === 0) return;
    setLoading(true);
    const summary = trades.map(t => `${t.pair} ${t.dir} @ ${t.price} via ${t.strategy} (signal: ${t.score}%)`).join("\n");
    try {
      const result = await callClaude(
        `My recent trades:\n${summary}\n\nRespond in EXACTLY this format:\nSTRENGTH: [one strength, max 20 words]\nWEAKNESS: [one weakness, max 20 words]\nACTION: [one specific action to take, max 20 words]`,
        "You are a professional trading coach who has trained hedge fund managers. Be direct, honest, and specific. Use Van Tharp R-multiple principles.",
        300
      );
      const lines = {};
      result.split("\n").forEach(line => {
        const idx = line.indexOf(":");
        if (idx > 0) lines[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      });
      setCoachOutput(lines);
    } catch {
      setCoachOutput({ STRENGTH: "AI offline", WEAKNESS: "Check connection", ACTION: "Verify API key" });
    }
    setLoading(false);
  };

  return (
    <div style={{ padding: "0 16px", display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16, alignItems: "start" }}>
      {/* Left: Trade journal */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "12px 16px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {[{ label: "Trades", value: totalTrades }, { label: "Win Rate", value: `${winRate}%` }, { label: "Avg R", value: `${avgR}R` }].map((stat, i) => (
            <div key={i} style={{ textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#e6edf3", fontFamily: FONT_MONO }}>{stat.value}</div>
              <div style={{ fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.05em" }}>{stat.label}</div>
            </div>
          ))}
        </div>

        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 10 }}>Trade Journal</div>
          {trades.length === 0 && <div style={{ fontSize: 12, color: "#8b949e", padding: "16px 0", textAlign: "center" }}>No trades yet. Execute trades to build your journal.</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 340, overflowY: "auto" }}>
            <AnimatePresence initial={false}>
              {trades.slice().reverse().map((t) => {
                const tags = behavioralTags(t);
                return (
                  <motion.div key={t.id} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ type: "spring", stiffness: 300, damping: 28 }} style={{ padding: "10px 12px", borderRadius: 8, background: "#161b22", border: `0.5px solid ${t.dir === "LONG" ? "rgba(29,158,117,0.3)" : "rgba(226,75,74,0.3)"}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3" }}>{t.pair}</span>
                      <span style={{ fontSize: 11, color: t.dir === "LONG" ? "#1D9E75" : "#E24B4A", fontWeight: 500 }}>{t.dir}</span>
                      <span style={{ fontSize: 11, fontFamily: FONT_MONO, color: "#8b949e" }}>{t.price}</span>
                      <span style={{ fontSize: 10, color: "#484f58" }}>{t.time}</span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {tags.map((tag, j) => (
                        <span key={j} style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: `${tag.color}18`, color: tag.color, border: `0.5px solid ${tag.color}40`, fontWeight: 500 }}>{tag.label}</span>
                      ))}
                    </div>
                    {t.aiReason && <div style={{ fontSize: 10, color: "#8b949e", marginTop: 4, fontStyle: "italic" }}>"{t.aiReason}"</div>}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Right: Coach output */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>Xavier's coaching</div>
              <div style={{ fontSize: 11, color: "#8b949e", marginTop: 2 }}>Xavier reviews your trades and tells you the truth</div>
            </div>
            <button onClick={analyze} disabled={loading || trades.length === 0} style={{ fontSize: 11, padding: "6px 14px", borderRadius: 6, cursor: trades.length === 0 ? "default" : "pointer", border: "1px solid rgba(186,117,23,0.4)", background: "rgba(186,117,23,0.08)", color: "#d29922", fontWeight: 500, fontFamily: "inherit", opacity: trades.length === 0 ? 0.5 : 1, pointerEvents: "all" }}>
              {loading ? "Coaching…" : "Xavier, coach me ↗"}
            </button>
          </div>

          {!coachOutput && !loading && (
            <div style={{ fontSize: 12, color: "#8b949e", textAlign: "center", padding: "24px 0" }}>Xavier will tell you exactly what you're doing right and what's costing you money.</div>
          )}
          {loading && <div style={{ fontSize: 12, color: "#58a6ff", textAlign: "center", padding: "24px 0" }}>Coach is analyzing your trades…</div>}

          {coachOutput && !loading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                { key: "STRENGTH", label: "Strength", color: "#1D9E75", bg: "rgba(29,158,117,0.08)",  border: "rgba(29,158,117,0.25)",  icon: "↑" },
                { key: "WEAKNESS", label: "Weakness", color: "#E24B4A", bg: "rgba(226,75,74,0.08)",   border: "rgba(226,75,74,0.25)",   icon: "↓" },
                { key: "ACTION",   label: "Action",   color: "#d29922", bg: "rgba(186,117,23,0.08)",  border: "rgba(186,117,23,0.25)",  icon: "→" },
              ].map(card => (
                <div key={card.key} style={{ padding: "12px", borderRadius: 8, background: card.bg, border: `1px solid ${card.border}` }}>
                  <div style={{ fontSize: 10, color: card.color, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{card.icon} {card.label}</div>
                  <div style={{ fontSize: 12, color: "#c9d1d9", lineHeight: 1.5 }}>{coachOutput[card.key] || "—"}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 10 }}>Optimization Schedule</div>
          {COACH_SCHEDULE.map((item, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: i < COACH_SCHEDULE.length - 1 ? "0.5px solid #21262d" : "none" }}>
              <motion.span animate={{ opacity: item.active ? [1, 0.3, 1] : 1 }} transition={{ duration: 1.5, repeat: item.active ? Infinity : 0, ease: "easeInOut" }} style={{ width: 6, height: 6, borderRadius: "50%", background: item.active ? "#1D9E75" : "#484f58", display: "inline-block", flexShrink: 0 }} />
              <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: item.active ? "rgba(29,158,117,0.12)" : "#21262d", color: item.active ? "#1D9E75" : "#8b949e", fontWeight: 500, minWidth: 62, textAlign: "center" }}>{item.freq}</span>
              <span style={{ fontSize: 11, color: "#8b949e", flex: 1 }}>{item.task}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function openTradesFingerprint(trades) {
  return trades.map(t => `${t.id}:${t.unrealizedPL}:${t.currentUnits}`).join("|");
}

// ─── NEWS TAB ─────────────────────────────────────────────────────────────────
const NEWS_CATS = [
  { key: "forex",       label: "Forex",       color: "#388bfd" },
  { key: "indices",     label: "Indices",     color: "#a371f7" },
  { key: "commodities", label: "Commodities", color: "#d29922" },
  { key: "crypto",      label: "Crypto",      color: "#f0883e" },
  { key: "macro",       label: "Macro",       color: "#3fb950" },
];

function timeAgo(pubDate) {
  if (!pubDate) return "";
  const ms = Date.now() - new Date(pubDate).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function sentimentStyle(s) {
  if (s === "bullish") return { color: "#3fb950", bg: "rgba(63,185,80,0.1)", border: "#238636" };
  if (s === "bearish") return { color: "#f85149", bg: "rgba(248,81,73,0.1)",  border: "#da3633" };
  return { color: "#8b949e", bg: "rgba(139,148,158,0.08)", border: "#30363d" };
}

function NewsCard({ item, isMobile }) {
  const ss = sentimentStyle(item.sentiment);
  const sentLabel = item.sentiment === "bullish" ? "▲" : item.sentiment === "bearish" ? "▼" : "—";
  return (
    <a href={item.link} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", display: "block" }}>
      <div style={{
        background: "#161b22", border: `1px solid #21262d`, borderLeft: `3px solid ${ss.border}`,
        borderRadius: 8, padding: isMobile ? "10px 12px" : "12px 16px",
        transition: "background 0.15s", cursor: "pointer",
      }}
        onMouseEnter={e => e.currentTarget.style.background = "#1c2333"}
        onMouseLeave={e => e.currentTarget.style.background = "#161b22"}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: isMobile ? 13 : 14, fontWeight: 600, color: "#e6edf3", lineHeight: 1.45, marginBottom: 6 }}>
              {item.title}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {item.source && (
                <span style={{ fontSize: 11, color: "#8b949e", background: "#21262d", padding: "1px 7px", borderRadius: 10 }}>
                  {item.source}
                </span>
              )}
              <span style={{ fontSize: 11, color: "#484f58" }}>{timeAgo(item.pubDate)}</span>
            </div>
          </div>
          <div style={{
            flexShrink: 0, width: 28, height: 28, borderRadius: 6,
            background: ss.bg, border: `1px solid ${ss.border}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 13, fontWeight: 800, color: ss.color,
          }}>
            {sentLabel}
          </div>
        </div>
      </div>
    </a>
  );
}

function NewsTab({ isMobile }) {
  const [cat, setCat] = useState("forex");
  const [news, setNews] = useState([]);
  const [commentary, setCommentary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async (category) => {
    setLoading(true);
    setError(null);
    setCommentary(null);
    try {
      const r = await fetch(`${BRIDGE}/news?category=${category}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setNews(d.items || []);
      setCommentary(d.commentary || null);
      setFetchedAt(d.fetchedAt);
    } catch (e) {
      setError(e.message);
      setNews([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(cat); }, [cat, load]);
  useEffect(() => {
    const id = setInterval(() => load(cat), 5 * 60_000);
    return () => clearInterval(id);
  }, [cat, load]);

  const bullish = news.filter(n => n.sentiment === "bullish").length;
  const bearish = news.filter(n => n.sentiment === "bearish").length;

  return (
    <div style={{ padding: isMobile ? "12px" : "0 16px 16px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, paddingTop: isMobile ? 0 : 4 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#e6edf3" }}>Live Market News</div>
          {fetchedAt && !loading && (
            <div style={{ fontSize: 11, color: "#484f58", marginTop: 2 }}>
              Updated {timeAgo(fetchedAt)} · {bullish} bullish · {bearish} bearish
            </div>
          )}
        </div>
        <button onClick={() => load(cat)} disabled={loading}
          style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: 6, padding: "5px 12px", fontSize: 11, color: "#8b949e", cursor: loading ? "default" : "pointer", fontFamily: "inherit", opacity: loading ? 0.5 : 1 }}>
          {loading ? "Loading…" : "↻ Refresh"}
        </button>
      </div>

      {/* Category pills */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {NEWS_CATS.map(c => (
          <button key={c.key} onClick={() => setCat(c.key)}
            style={{
              padding: "5px 14px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
              background: cat === c.key ? `${c.color}1a` : "#161b22",
              color: cat === c.key ? c.color : "#8b949e",
              border: `1px solid ${cat === c.key ? c.color : "#21262d"}`,
              transition: "all 0.15s",
            }}>
            {c.label}
          </button>
        ))}
      </div>

      {/* Sentiment bar */}
      {!loading && news.length > 0 && (
        <div style={{ marginBottom: 14, background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 6 }}>Sentiment · {news.length} headlines</div>
          <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", gap: 2 }}>
            <div style={{ flex: bullish, background: "#238636", borderRadius: 3 }} />
            <div style={{ flex: news.length - bullish - bearish, background: "#30363d", borderRadius: 3 }} />
            <div style={{ flex: bearish, background: "#da3633", borderRadius: 3 }} />
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 6, fontSize: 11 }}>
            <span style={{ color: "#3fb950" }}>▲ {bullish} bullish</span>
            <span style={{ color: "#8b949e" }}>— {news.length - bullish - bearish} neutral</span>
            <span style={{ color: "#f85149" }}>▼ {bearish} bearish</span>
          </div>
        </div>
      )}

      {/* Gemini AI Brief */}
      {!loading && (commentary || loading) && (
        <div style={{
          marginBottom: 14, borderRadius: 10, overflow: "hidden",
          border: "1px solid #1a3a5c", background: "linear-gradient(135deg, #0d1f35 0%, #0d1117 100%)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid #1a3a5c", background: "rgba(56,139,253,0.06)" }}>
            <span style={{ fontSize: 14 }}>✦</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#58a6ff", letterSpacing: "0.5px", textTransform: "uppercase" }}>Gemini AI Brief</span>
            <span style={{ marginLeft: "auto", fontSize: 10, color: "#484f58" }}>{NEWS_CATS.find(c => c.key === cat)?.label}</span>
          </div>
          <div style={{ padding: "12px 14px" }}>
            {commentary ? (
              <p style={{ margin: 0, fontSize: isMobile ? 13 : 14, color: "#c9d1d9", lineHeight: 1.6 }}>{commentary}</p>
            ) : (
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "#484f58" }}>Gemini is analyzing headlines…</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Cards */}
      {error ? (
        <div style={{ padding: "20px 0", textAlign: "center", color: "#f85149", fontSize: 13 }}>
          {error.includes("Failed to fetch") ? "Bridge offline — run: npm run server" : error}
        </div>
      ) : loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[...Array(8)].map((_, i) => (
            <div key={i} style={{ background: "#161b22", border: "1px solid #21262d", borderLeft: "3px solid #21262d", borderRadius: 8, padding: "14px 16px", height: 72 }}>
              <div style={{ height: 14, background: "#21262d", borderRadius: 4, marginBottom: 10, width: `${70 + (i % 3) * 10}%` }} />
              <div style={{ height: 10, background: "#161b22", border: "1px solid #21262d", borderRadius: 10, width: 80 }} />
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {news.map((item, i) => <NewsCard key={i} item={item} isMobile={isMobile} />)}
          {news.length === 0 && (
            <div style={{ padding: "32px 0", textAlign: "center", color: "#484f58", fontSize: 13 }}>No headlines found</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── OPEN POSITIONS PANEL ─────────────────────────────────────────────────────
function AutoModeSettingsModal({ settings, onSave, onCancel }) {
  const [s, setS] = useState(settings);
  const set = (k, v) => setS(prev => ({ ...prev, [k]: v }));

  const consensusLabels = ["1/4", "2/4", "3/4", "4/4"];
  const heatOptions = [2, 3, 4, 6];

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      {/* Backdrop */}
      <div onClick={onCancel} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }} />

      {/* Panel */}
      <div style={{ position: "relative", background: "#161b22", border: "1px solid #21262d", borderRadius: 12, padding: 24, width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 20 }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#e6edf3" }}>Auto Trading Settings</div>
            <div style={{ fontSize: 12, color: "#8b949e", marginTop: 4 }}>Configure limits before enabling autonomous trading</div>
          </div>
          <button onClick={onCancel} style={{ background: "none", border: "none", color: "#8b949e", fontSize: 18, cursor: "pointer", padding: "0 4px", lineHeight: 1 }}>✕</button>
        </div>

        {/* Signal confidence */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>Minimum signal confidence</span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 14, fontWeight: 700, color: "#388bfd" }}>{s.minConfidence}%</span>
          </div>
          <input type="range" min={50} max={90} step={5} value={s.minConfidence} onChange={e => set("minConfidence", Number(e.target.value))}
            style={{ width: "100%", accentColor: "#388bfd", cursor: "pointer" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#484f58" }}>
            <span>50% — more trades</span><span>90% — fewer, safer</span>
          </div>
          <div style={{ fontSize: 11, color: "#8b949e" }}>Only trade signals above this score</div>
        </div>

        {/* Max trades per hour */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>Max trades per hour</span>
          <div style={{ display: "flex", gap: 8 }}>
            {[1, 2, 3].map(v => (
              <button key={v} onClick={() => set("maxTradesPerHour", v)}
                style={{ flex: 1, padding: "8px 0", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                  background: s.maxTradesPerHour === v ? "rgba(56,139,253,0.15)" : "#0d1117",
                  color: s.maxTradesPerHour === v ? "#58a6ff" : "#8b949e",
                  border: `1px solid ${s.maxTradesPerHour === v ? "#388bfd" : "#30363d"}` }}>
                {v}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#8b949e" }}>Circuit breaker — halts after limit</div>
        </div>

        {/* Max heat */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>Max portfolio heat</span>
          <div style={{ display: "flex", gap: 8 }}>
            {heatOptions.map(v => (
              <button key={v} onClick={() => set("maxHeat", v)}
                style={{ flex: 1, padding: "8px 0", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                  background: s.maxHeat === v ? "rgba(186,117,23,0.15)" : "#0d1117",
                  color: s.maxHeat === v ? "#d29922" : "#8b949e",
                  border: `1px solid ${s.maxHeat === v ? "#d29922" : "#30363d"}` }}>
                {v}R
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#8b949e" }}>Stop trading above this heat level</div>
        </div>

        {/* Consensus required */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>Models required to confirm</span>
          <div style={{ display: "flex", gap: 8 }}>
            {[1, 2, 3, 4].map((v, i) => (
              <button key={v} onClick={() => set("consensusRequired", v)}
                style={{ flex: 1, padding: "8px 0", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                  background: s.consensusRequired === v ? "rgba(63,185,80,0.12)" : "#0d1117",
                  color: s.consensusRequired === v ? "#3fb950" : "#8b949e",
                  border: `1px solid ${s.consensusRequired === v ? "#238636" : "#30363d"}` }}>
                {consensusLabels[i]}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#8b949e" }}>Higher = safer, fewer trades</div>
        </div>

        {/* Auto close */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>Auto close at</span>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>Profit target</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#0d1117", border: "1px solid #30363d", borderRadius: 7, padding: "8px 12px" }}>
                <span style={{ color: "#3fb950", fontWeight: 700, fontSize: 13 }}>+</span>
                <input type="number" min={1} max={20} step={0.5} value={s.profitTarget}
                  onChange={e => set("profitTarget", Number(e.target.value))}
                  style={{ flex: 1, background: "none", border: "none", outline: "none", color: "#3fb950", fontFamily: FONT_MONO, fontSize: 14, fontWeight: 600, width: "100%" }} />
                <span style={{ color: "#8b949e", fontSize: 12 }}>R</span>
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>Stop loss</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#0d1117", border: "1px solid #30363d", borderRadius: 7, padding: "8px 12px" }}>
                <span style={{ color: "#f85149", fontWeight: 700, fontSize: 13 }}>−</span>
                <input type="number" min={0.5} max={5} step={0.5} value={s.stopLoss}
                  onChange={e => set("stopLoss", Number(e.target.value))}
                  style={{ flex: 1, background: "none", border: "none", outline: "none", color: "#f85149", fontFamily: FONT_MONO, fontSize: 14, fontWeight: 600, width: "100%" }} />
                <span style={{ color: "#8b949e", fontSize: 12 }}>R</span>
              </div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "#8b949e" }}>Automatically close at these levels</div>
        </div>

        {/* Risk summary */}
        <div style={{ background: "#2d2000", border: "1px solid #d29922", borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ fontSize: 11, color: "#d29922", lineHeight: 1.6 }}>
            With these settings the bot will trade maximum <strong>{s.maxTradesPerHour}</strong> time{s.maxTradesPerHour !== 1 ? "s" : ""} per hour at <strong>{s.minConfidence}%</strong> confidence, requiring <strong>{s.consensusRequired}/4</strong> AI models to agree. Gemini uses live Google news. Auto-halts if heat exceeds <strong>{s.maxHeat}R</strong>.
          </div>
        </div>

        {/* Buttons */}
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel}
            style={{ flex: 1, padding: "10px 0", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: "#0d1117", color: "#8b949e", border: "1px solid #30363d" }}>
            Cancel
          </button>
          <button onClick={() => onSave(s)}
            style={{ flex: 2, padding: "10px 0", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", background: "rgba(35,134,54,0.2)", color: "#3fb950", border: "1px solid #238636" }}>
            ⚡ Enable Auto Trading
          </button>
        </div>
      </div>
    </div>
  );
}

function PaperTradesPanel({ trades, isMobile }) {
  const today = new Date().toDateString();
  const todayTrades = trades.filter(t => new Date(t.timestamp).toDateString() === today);
  if (trades.length === 0) return null;
  return (
    <div style={isMobile
      ? { background: "#0d1117", padding: "12px", marginTop: 4 }
      : { background: "#161b22", border: "1px solid #21262d", borderRadius: 10, padding: "12px 14px", margin: "12px 16px 0" }
    }>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.5px" }}>Paper trades</span>
        <span style={{ fontSize: 11, background: "#21262d", color: "#8b949e", padding: "2px 8px", borderRadius: 10 }}>{todayTrades.length} today</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {trades.slice(0, 20).map(t => (
          <div key={t.id} style={{ padding: "9px 12px", borderRadius: 8, background: "#0d1117", border: "1px solid #21262d", borderLeft: "3px solid #484f58" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 700, background: "#21262d", color: "#8b949e", padding: "1px 6px", borderRadius: 3, letterSpacing: "0.5px" }}>PAPER</span>
              <span style={{ fontWeight: 700, fontSize: 13, color: "#e6edf3" }}>{t.instrument.replace("_", "/")}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: t.direction === "LONG" ? "#3fb950" : "#f85149" }}>{t.direction}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: "#8b949e" }}>@ {typeof t.price === "number" ? t.price.toFixed(5) : t.price}</span>
              <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, color: "#8b949e" }}>{t.consensus}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10, color: "#484f58", fontStyle: "italic" }}>Would have executed — market closed</span>
              <span style={{ fontSize: 10, color: "#484f58" }}>{new Date(t.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OpenPositionsPanel({ openTrades, livePrices, onClose, isMobile }) {
  return (
    <div style={isMobile ? { background: "#0d1117", borderRadius: 0, padding: "12px", margin: "0" } : { background: "#161b22", border: "1px solid #21262d", borderRadius: 10, padding: "12px 14px", margin: "0 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: openTrades.length > 0 ? 8 : 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.5px" }}>Open positions</span>
        <span style={{ fontSize: 11, background: "#21262d", color: "#8b949e", padding: "2px 8px", borderRadius: 10 }}>
          {openTrades.length}
        </span>
      </div>

      {openTrades.length === 0 ? (
        <div style={isMobile ? { background: "#161b22", border: "1px solid #21262d", borderRadius: 10, padding: 16, textAlign: "center", fontSize: 12, color: "#8b949e", marginTop: 8 } : { fontSize: 12, color: "var(--color-text-tertiary)", padding: "4px 0" }}>
          No open positions · signals are being monitored
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {openTrades.map(trade => {
            const pair = oandaToSlash(trade.instrument);
            const units = parseFloat(trade.currentUnits);
            const isLong = units > 0;
            const pnl = parseFloat(trade.unrealizedPL);
            const entry = parseFloat(trade.averageOpenPrice);
            const dec = priceDecimals(pair);
            const current = livePrices[pair];
            const dur = tradeDuration(trade.openTime);
            const pnlStr = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;

            if (isMobile) {
              return (
                <div
                  key={trade.id}
                  style={{ padding: "12px", borderRadius: 10, background: "#161b22", border: "1px solid #21262d", borderLeft: `3px solid ${isLong ? "#3fb950" : "#f85149"}` }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontWeight: 700, color: "#e6edf3", fontSize: 14 }}>{pair}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: isLong ? "#3fb950" : "#f85149" }}>{isLong ? "LONG" : "SHORT"}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, fontFamily: FONT_MONO, fontSize: 11 }}>
                    <span style={{ color: "#8b949e" }}>@ {entry.toFixed(dec)}</span>
                    <span style={{ color: "#c9d1d9" }}>{current ? current.toFixed(dec) : "—"}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: 14, fontVariantNumeric: "tabular-nums", minWidth: 88, color: pnl >= 0 ? "#3fb950" : "#f85149" }}>{pnlStr}</span>
                    <span style={{ fontSize: 10, color: "#484f58" }}>{dur}</span>
                    <button
                      onClick={() => onClose(trade.id, pair)}
                      style={{ fontSize: 10, padding: "5px 10px", borderRadius: 6, cursor: "pointer", border: "1px solid rgba(248,81,73,0.4)", background: "rgba(248,81,73,0.08)", color: "#f85149", fontFamily: "inherit" }}
                    >
                      Close ×
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={trade.id}
                style={{ display: "grid", gridTemplateColumns: "80px 58px 110px 110px 90px 70px auto", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 8, background: isLong ? "rgba(29,158,117,0.05)" : "rgba(226,75,74,0.05)", border: `0.5px solid ${isLong ? "rgba(29,158,117,0.2)" : "rgba(226,75,74,0.2)"}`, fontSize: 12 }}
              >
                <span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>{pair}</span>
                <span style={{ color: isLong ? "#1D9E75" : "#E24B4A", fontWeight: 600, fontSize: 11 }}>{isLong ? "LONG" : "SHORT"}</span>
                <span style={{ fontFamily: FONT_MONO, color: "var(--color-text-tertiary)", fontSize: 11 }}>@ {entry.toFixed(dec)}</span>
                <span style={{ fontFamily: FONT_MONO, color: "var(--color-text-primary)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{current ? current.toFixed(dec) : "—"}</span>
                <span style={{ fontFamily: FONT_MONO, fontWeight: 600, color: pnl >= 0 ? "#1D9E75" : "#E24B4A", fontSize: 12, fontVariantNumeric: "tabular-nums", minWidth: 72 }}>
                  {pnlStr}
                </span>
                <span style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>{dur}</span>
                <button
                  onClick={() => onClose(trade.id, pair)}
                  style={{ fontSize: 10, padding: "4px 9px", borderRadius: 5, cursor: "pointer", border: "0.5px solid rgba(226,75,74,0.45)", background: "rgba(226,75,74,0.08)", color: "#E24B4A", fontFamily: "inherit", whiteSpace: "nowrap" }}
                >
                  Close ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── PERFORMANCE DASHBOARD ───────────────────────────────────────────────────
function PerformanceDashboard({ trades, balance, isMobile }) {
  if (trades.length === 0) {
    return (
      <div style={{ padding: "60px 16px", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>📊</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "#e6edf3", marginBottom: 6 }}>No trades yet</div>
        <div style={{ fontSize: 12, color: "#8b949e" }}>Execute trades in the Markets tab to see analytics here.</div>
      </div>
    );
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = wins.length / trades.length * 100;
  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const expectancy = avgWin * (winRate / 100) - avgLoss * (1 - winRate / 100);
  const maxWin = wins.length > 0 ? Math.max(...wins.map(t => t.pnl)) : 0;
  const maxLoss = losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0;
  const avgScore = trades.reduce((s, t) => s + (t.score || 0), 0) / trades.length;

  const equityCurve = trades.reduce((acc, t) => {
    acc.push(acc[acc.length - 1] + (t.pnl || 0));
    return acc;
  }, [100]);

  const pairStats = {};
  trades.forEach(t => {
    if (!pairStats[t.pair]) pairStats[t.pair] = { wins: 0, total: 0, pnl: 0 };
    pairStats[t.pair].total++;
    pairStats[t.pair].pnl += t.pnl || 0;
    if (t.pnl > 0) pairStats[t.pair].wins++;
  });
  const pairRows = Object.entries(pairStats).sort((a, b) => b[1].pnl - a[1].pnl);
  const bestPair = pairRows.length > 0 ? pairRows[0][0] : "—";
  const maxAbsPnl = Math.max(...pairRows.map(([, s]) => Math.abs(s.pnl)), 0.001);

  const stratStats = {};
  trades.forEach(t => {
    const key = t.strategy || "Unknown";
    if (!stratStats[key]) stratStats[key] = { wins: 0, total: 0, pnl: 0 };
    stratStats[key].total++;
    stratStats[key].pnl += t.pnl || 0;
    if (t.pnl > 0) stratStats[key].wins++;
  });

  const longs = trades.filter(t => t.dir === "LONG");
  const shorts = trades.filter(t => t.dir === "SHORT");
  const longWr = longs.length > 0 ? longs.filter(t => t.pnl > 0).length / longs.length * 100 : 0;
  const shortWr = shorts.length > 0 ? shorts.filter(t => t.pnl > 0).length / shorts.length * 100 : 0;

  const pc = (v) => v > 0 ? "#3fb950" : v < 0 ? "#f85149" : "#8b949e";
  const fmt = (v, d = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;

  const CARD = { background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "14px 16px" };
  const LBL = { fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 };
  const BIG = { fontSize: 20, fontWeight: 700, fontFamily: FONT_MONO };

  const summaryCards = [
    { label: "Total Trades",  value: trades.length,               color: "#e6edf3" },
    { label: "Win Rate",      value: `${winRate.toFixed(1)}%`,    color: winRate >= 50 ? "#3fb950" : "#f85149" },
    { label: "Total P&L",    value: fmt(totalPnl),                color: pc(totalPnl) },
    { label: "Expectancy",   value: fmt(expectancy, 3),           color: pc(expectancy) },
    { label: "Best Pair",    value: bestPair,                      color: "#a5d6ff" },
    { label: "Max Win",      value: `+${maxWin.toFixed(2)}%`,    color: "#3fb950" },
    { label: "Max Loss",     value: `${maxLoss.toFixed(2)}%`,    color: "#f85149" },
    { label: "Avg Score",    value: avgScore.toFixed(0),          color: avgScore >= 75 ? "#3fb950" : avgScore >= 50 ? "#d29922" : "#f85149" },
  ];

  return (
    <div style={{ padding: "0 16px 24px" }}>
      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
        {summaryCards.map((c, i) => (
          <div key={i} style={CARD}>
            <div style={LBL}>{c.label}</div>
            <div style={{ ...BIG, color: c.color }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Equity curve */}
      <div style={{ ...CARD, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 10 }}>Equity Curve</div>
        <BezierSpark history={equityCurve} height={80} fullWidth />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 10, color: "#8b949e" }}>
          <span>$100.00 start</span>
          <span style={{ color: pc(balance - 100) }}>${balance.toFixed(4)} now</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16, marginBottom: 16 }}>
        {/* Pair performance */}
        <div style={CARD}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 12 }}>Pair Performance</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {pairRows.map(([pair, s]) => {
              const barW = Math.abs(s.pnl) / maxAbsPnl * 100;
              const wr = (s.wins / s.total * 100).toFixed(0);
              const isPos = s.pnl >= 0;
              return (
                <div key={pair}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                    <span style={{ color: "#e6edf3", fontFamily: FONT_MONO }}>{pair}</span>
                    <div style={{ display: "flex", gap: 12 }}>
                      <span style={{ color: "#8b949e" }}>{wr}% WR · {s.total}T</span>
                      <span style={{ color: pc(s.pnl), fontFamily: FONT_MONO }}>{fmt(s.pnl)}</span>
                    </div>
                  </div>
                  <div style={{ height: 6, background: "#161b22", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${barW}%`, height: "100%", background: isPos ? "#238636" : "#8e1a17", borderRadius: 3 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Direction + Strategy */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={CARD}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 12 }}>Direction Split</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {[
                { label: "LONG",  count: longs.length,  wr: longWr,  color: "#3fb950" },
                { label: "SHORT", count: shorts.length, wr: shortWr, color: "#f85149" },
              ].map(d => (
                <div key={d.label} style={{ background: "#161b22", borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ fontSize: 10, color: d.color, fontWeight: 700, marginBottom: 4 }}>{d.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#e6edf3", fontFamily: FONT_MONO }}>{d.count}</div>
                  <div style={{ fontSize: 10, color: "#8b949e" }}>{d.wr.toFixed(0)}% WR</div>
                </div>
              ))}
            </div>
          </div>
          <div style={CARD}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 10 }}>By Strategy</div>
            {Object.entries(stratStats).length === 0
              ? <div style={{ fontSize: 12, color: "#8b949e" }}>No data</div>
              : Object.entries(stratStats).map(([name, s]) => (
                <div key={name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "0.5px solid #21262d" }}>
                  <span style={{ fontSize: 12, color: "#8b949e" }}>{name}</span>
                  <div style={{ display: "flex", gap: 10, fontSize: 11, fontFamily: FONT_MONO }}>
                    <span style={{ color: "#e6edf3" }}>{s.total}T</span>
                    <span style={{ color: "#a5d6ff" }}>{(s.wins / s.total * 100).toFixed(0)}%</span>
                    <span style={{ color: pc(s.pnl) }}>{fmt(s.pnl)}</span>
                  </div>
                </div>
              ))
            }
          </div>
        </div>
      </div>

      {/* Trade log */}
      <div style={CARD}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 10 }}>Trade Log</div>
        <div style={{ overflowX: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "80px 80px 55px 55px 65px 1fr", gap: "0 8px", fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.05em", paddingBottom: 6, borderBottom: "0.5px solid #21262d", minWidth: 400 }}>
            {["Pair", "Time", "Dir", "Score", "P&L", "AI Reason"].map(h => <div key={h}>{h}</div>)}
          </div>
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {[...trades].reverse().map((t, i) => (
              <div key={t.id || i} style={{ display: "grid", gridTemplateColumns: "80px 80px 55px 55px 65px 1fr", gap: "0 8px", padding: "7px 0", borderBottom: "0.5px solid #161b22", alignItems: "center", fontSize: 11, minWidth: 400 }}>
                <span style={{ fontFamily: FONT_MONO, color: "#a5d6ff" }}>{t.pair}</span>
                <span style={{ color: "#8b949e" }}>{t.time}</span>
                <span style={{ color: t.dir === "LONG" ? "#3fb950" : "#f85149", fontWeight: 600 }}>{t.dir}</span>
                <span style={{ fontFamily: FONT_MONO, color: t.score >= 75 ? "#3fb950" : "#d29922" }}>{t.score}</span>
                <span style={{ fontFamily: FONT_MONO, color: pc(t.pnl ?? 0) }}>{t.pnl !== undefined ? fmt(t.pnl) : "—"}</span>
                <span style={{ color: "#8b949e", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.aiReason || "—"}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
const MOBILE_TABS = [
  { key: "markets",   label: "Markets",   Icon: ({ color }) => <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg> },
  { key: "news",      label: "News",      Icon: ({ color }) => <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/></svg> },
  { key: "ai",        label: "AI",        Icon: ({ color }) => <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/><path d="M19 3v4"/><path d="M21 5h-4"/></svg> },
  { key: "risk",      label: "Risk",      Icon: ({ color }) => <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> },
  { key: "coach",     label: "Coach",     Icon: ({ color }) => <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg> },
  { key: "analytics", label: "Stats",    Icon: ({ color }) => <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><rect x="2" y="12" width="4" height="10" rx="1"/><rect x="9" y="7" width="4" height="15" rx="1"/><rect x="16" y="3" width="4" height="19" rx="1"/></svg> },
];

const BASE_PRICES = {
  "EUR/USD": 1.08420, "GBP/USD": 1.26710, "USD/JPY": 149.850, "AUD/USD": 0.65230,
  "USD/CAD": 1.36540, "XAU/USD": 2312.40, "BTC/USD": 68240.0, "SPX500": 5248.30,
};

export default function TradingRobot() {
  const [strategy, setStrategy] = useState(() => localStorage.getItem("active_strategy") || "Mean Revert");
  const [trades, setTrades] = useState([]);
  const [balance, setBalance] = useState(100.0);
  const [activeRule, setActiveRule] = useState(null);
  const [autoMode, setAutoMode] = useState(false);
  const [autoModeLoading, setAutoModeLoading] = useState(false);
  const [showAutoSettings, setShowAutoSettings] = useState(false);
  const [autoSettings, setAutoSettings] = useState({
    minConfidence: 75,
    maxTradesPerHour: 2,
    maxHeat: 3,
    consensusRequired: 3,
    profitTarget: 3,
    stopLoss: 1,
  });
  const [tab, setTab] = useState("markets");
  const [currentHeadline, setCurrentHeadline] = useState(LIVE_HEADLINES[0]);
  const [livePrices, setLivePrices] = useState(BASE_PRICES);
  const [signalHeaderFlash, setSignalHeaderFlash] = useState(false);
  const [signalMap, setSignalMap] = useState({});
  const [marketOpen, setMarketOpen] = useState(() => isMarketOpen());
  const isMobile = useIsMobile();

  useEffect(() => {
    const id = setInterval(() => setMarketOpen(isMarketOpen()), 60000);
    return () => clearInterval(id);
  }, []);
  const [openTrades, setOpenTrades] = useState([]);
  const [oandaNav, setOandaNav] = useState(null);
  const [oandaUnrealizedPL, setOandaUnrealizedPL] = useState(null);
  const [paperTrades, setPaperTrades] = useState([]);

  const signalCount = Object.values(signalMap).filter(Boolean).length;

  useEffect(() => {
    const fetchOpenTrades = async () => {
      try {
        const r = await fetch(`${BRIDGE}/trades`);
        const data = await r.json();
        if (Array.isArray(data.trades)) {
          setOpenTrades(prev =>
            openTradesFingerprint(prev) === openTradesFingerprint(data.trades) ? prev : data.trades
          );
        }
      } catch {}
    };
    fetchOpenTrades();
    const id = setInterval(fetchOpenTrades, 3000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const fetchPaperTrades = async () => {
      try {
        const r = await fetch(`${BRIDGE}/paper-trades`);
        const data = await r.json();
        if (Array.isArray(data.trades)) setPaperTrades(data.trades);
      } catch {}
    };
    fetchPaperTrades();
    const id = setInterval(fetchPaperTrades, 10000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    fetch(`${BRIDGE}/health`).then(r => r.json()).then(d => setAutoMode(d.autoMode === true)).catch(() => {});
  }, []);

  const toggleAutoMode = () => {
    if (!autoMode) { setShowAutoSettings(true); return; }
    enableAutoMode(false);
  };

  const enableAutoMode = async (enabled) => {
    setAutoModeLoading(true);
    try {
      const r = await fetch(`${BRIDGE}/auto-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await r.json();
      if (typeof data.autoMode === "boolean") setAutoMode(data.autoMode);
    } catch {}
    setAutoModeLoading(false);
  };

  useEffect(() => {
    const fetchAccount = async () => {
      try {
        const r = await fetch(`${BRIDGE}/account`);
        const data = await r.json();
        if (data.account) {
          setOandaNav(parseFloat(data.account.NAV));
          setOandaUnrealizedPL(parseFloat(data.account.unrealizedPL));
        }
      } catch {}
    };
    fetchAccount();
    const id = setInterval(fetchAccount, 5000);
    return () => clearInterval(id);
  }, []);

  const closeTrade = useCallback(async (tradeId, pair) => {
    if (!window.confirm(`Close ${pair} position?`)) return;
    try {
      await fetch(`${BRIDGE}/close/${tradeId}`, { method: "POST" });
      setOpenTrades(prev => prev.filter(t => t.id !== tradeId));
    } catch {}
  }, []);

  const handleStrategyChange = useCallback((s) => {
    setStrategy(s);
    setSignalHeaderFlash(true);
    setTimeout(() => setSignalHeaderFlash(false), 1000);
  }, []);

  const [rejectionLog, setRejectionLog] = useState([]);
  const [regimeMap, setRegimeMap] = useState({});

  const onRejection = useCallback((entry) => {
    setRejectionLog(prev => [entry, ...prev].slice(0, 10));
  }, []);

  const onRegimeUpdate = useCallback((pair, regime) => {
    setRegimeMap(prev => prev[pair] === regime ? prev : { ...prev, [pair]: regime });
  }, []);

  const regimeValues = Object.values(regimeMap);
  const globalRegime = regimeValues.length === 0 ? null
    : regimeValues.filter(r => r === "VOLATILE").length > 0 ? "VOLATILE"
    : regimeValues.filter(r => r === "TRENDING").length > regimeValues.length / 2 ? "TRENDING"
    : "RANGING";

  const STRATEGY_DISABLED = {
    "Mean Revert":  globalRegime === "TRENDING"  ? "Trending market — mean reversion signals unreliable" : null,
    "Trend Follow": globalRegime === "RANGING"   ? "Ranging market — no clear trend to follow" : null,
  };

  const onSignalUpdate = useCallback((pair, hasSignal) => {
    setSignalMap(prev => prev[pair] === hasSignal ? prev : { ...prev, [pair]: hasSignal });
  }, []);

  const onTrade = useCallback((pair, signal, price, aiVerdict) => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const rule = KNOWLEDGE_BASE.vanTharpRules[Math.floor(Math.random() * KNOWLEDGE_BASE.vanTharpRules.length)];
    setActiveRule(rule);
    setTimeout(() => setActiveRule(null), 4000);
    const balanceChange = (Math.random() > 0.45 ? 1 : -1) * (1.5 * (0.5 + Math.random() * 2.5)) / 100;
    setBalance(prev => parseFloat((prev + balanceChange).toFixed(4)));
    setLivePrices(prev => ({ ...prev, [pair]: price }));
    setTrades(prev => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      pair, dir: signal.direction,
      price: price.toFixed(pair.includes("BTC") ? 2 : pair.includes("JPY") ? 3 : 5),
      strategy, time: timeStr, score: signal.score,
      aiReason: aiVerdict?.REASON || null,
      pnl: parseFloat((balanceChange * 100).toFixed(4)),
    }]);
  }, [strategy]);

  const pnl = (balance - 100).toFixed(4);
  const displayNav = oandaNav != null ? oandaNav : (100 + parseFloat(pnl));
  const displayUPL = oandaUnrealizedPL != null ? oandaUnrealizedPL : parseFloat(pnl);
  const today = new Date().toDateString();
  const paperTodayCount = paperTrades.filter(t => new Date(t.timestamp).toDateString() === today).length;
  const tabs = [["markets", "Markets"], ["news", "News"], ["ai", "Ask Xavier"], ["knowledge", "Knowledge"], ["risk", "Risk"], ["coach", "Coach"], ["analytics", "Analytics"]];

  return (
    <div style={{ fontFamily: "'Inter', sans-serif", padding: `0 0 ${isMobile ? "90px" : "16px"}`, minHeight: "100vh", background: "#0d1117", position: "relative" }}>
      <style>{`.qb-hscroll::-webkit-scrollbar{display:none}.qb-hscroll{-ms-overflow-style:none;scrollbar-width:none}@keyframes marquee{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}`}</style>
      {/* ── Header ── */}
      {isMobile ? (
        <div style={{ padding: "10px 12px 8px", borderBottom: "0.5px solid #21262d", marginBottom: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <span style={{ fontSize: 18, fontWeight: 800, color: "#388bfd", letterSpacing: "-0.3px" }}>QuantBot Pro</span>
              <span style={{ fontSize: 9, background: "#0f2d1a", color: "#3fb950", border: "1px solid #238636", padding: "1px 5px", borderRadius: 4, marginLeft: 6, fontWeight: 500 }}>Gen AI</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 18, fontWeight: 600, color: displayUPL >= 0 ? "#1D9E75" : "#E24B4A" }}>
                ${displayNav.toFixed(2)}
              </span>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                <button
                  onClick={toggleAutoMode}
                  disabled={autoModeLoading}
                  style={{ padding: "4px 10px", borderRadius: 6, cursor: autoModeLoading ? "default" : "pointer", fontSize: 11, fontWeight: 600, border: `1px solid ${autoMode ? "#238636" : "#30363d"}`, background: autoMode ? "rgba(35,134,54,0.15)" : "#161b22", color: autoMode ? "#3fb950" : "#8b949e", opacity: autoModeLoading ? 0.6 : 1 }}
                >
                  {autoModeLoading ? "…" : autoMode ? "⚡ Auto" : "Auto"}
                </button>
                {autoMode && (
                  <span style={{ fontSize: 9, color: "#3fb950", fontFamily: FONT_MONO }}>
                    {autoSettings.minConfidence}% · {autoSettings.maxTradesPerHour}/hr · {autoSettings.maxHeat}R
                  </span>
                )}
              </div>
            </div>
          </div>
          {paperTodayCount > 0 && (
            <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 6, paddingLeft: 2 }}>
              Auto: {paperTodayCount} paper trade{paperTodayCount !== 1 ? "s" : ""} today
            </div>
          )}
          <div className="qb-hscroll" style={{ overflowX: "auto" }}>
            <MarketSession isMobile />
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px", borderBottom: "0.5px solid var(--color-border-tertiary)", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#388bfd", marginBottom: 8 }}>
              QuantBot Pro <span style={{ fontSize: 9, background: "#0f2d1a", color: "#3fb950", border: "1px solid #238636", padding: "1px 5px", borderRadius: 4, marginLeft: 6, fontWeight: 500 }}>Gen AI</span>
            </div>
            <MarketSession isMobile={false} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>NAV · Unrealized P&L</div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 18, fontWeight: 600, color: displayUPL >= 0 ? "#1D9E75" : "#E24B4A" }}>
                ${displayNav.toFixed(2)} <span style={{ fontSize: 12, fontWeight: 400 }}>{displayUPL >= 0 ? "+" : ""}${displayUPL.toFixed(2)}</span>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {paperTodayCount > 0 && (
                <span style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, background: "#161b22", color: "#8b949e", border: "1px solid #21262d", fontWeight: 500 }}>
                  Auto: {paperTodayCount} paper{paperTodayCount !== 1 ? "s" : ""} today
                </span>
              )}
              {openTrades.length > 0 && (
                <span style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, background: "rgba(56,139,253,0.1)", color: "#58a6ff", border: "1px solid rgba(56,139,253,0.3)", fontWeight: 500 }}>
                  Open: {openTrades.length}
                </span>
              )}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                <button
                  onClick={toggleAutoMode}
                  disabled={autoModeLoading}
                  style={{ padding: "8px 16px", borderRadius: 8, cursor: autoModeLoading ? "default" : "pointer", fontSize: 12, fontWeight: 600, transition: "all 0.2s",
                    background: autoMode ? "rgba(35,134,54,0.15)" : "#161b22",
                    color: autoMode ? "#3fb950" : "#8b949e",
                    border: `1px solid ${autoMode ? "#238636" : "#30363d"}`,
                    opacity: autoModeLoading ? 0.6 : 1 }}
                >
                  {autoModeLoading ? "…" : autoMode ? "⚡ Auto ON" : "Auto OFF"}
                </button>
                {autoMode && (
                  <span style={{ fontSize: 10, color: "#3fb950", fontFamily: FONT_MONO, letterSpacing: "0.2px" }}>
                    {autoSettings.minConfidence}% · {autoSettings.maxTradesPerHour}/hr · {autoSettings.maxHeat}R
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <NewsTicker onHeadlineChange={setCurrentHeadline} />

      {!marketOpen && (
        <div style={{ background: "#2d2000", color: "#d29922", borderBottom: "1px solid #9e6a03", padding: "6px 16px", fontSize: 11, textAlign: "center", whiteSpace: isMobile ? "nowrap" : "normal", overflow: isMobile ? "hidden" : "visible", textOverflow: isMobile ? "ellipsis" : "clip" }}>
          {isMobile ? "⚠️ Markets closed · back Sun 4pm Calgary" : "Markets are closed · Back Sunday 4pm Calgary · Xavier is still here if you have questions"}
        </div>
      )}

      <div className="qb-hscroll" style={{
        padding: "8px 16px",
        display: "flex",
        gap: isMobile ? "6px" : "8px",
        alignItems: "center",
        borderBottom: "1px solid #21262d",
        background: "#0d1117",
        flexWrap: isMobile ? "nowrap" : "wrap",
        overflowX: isMobile ? "auto" : "visible",
        position: "relative",
        zIndex: 20,
      }}>
        {!isMobile && <span style={{ fontSize: 11, color: "#8b949e", marginRight: 4 }}>Strategy</span>}
        {STRATEGIES.map(s => {
          const disabledReason = STRATEGY_DISABLED[s];
          const isDisabled = !!disabledReason;
          return (
            <div key={s} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
              <button
                onClick={() => !isDisabled && handleStrategyChange(s)}
                title={disabledReason || ""}
                style={{
                  fontSize: isMobile ? 11 : 12,
                  padding: isMobile ? "5px 14px" : "6px 14px",
                  borderRadius: isMobile ? "20px" : "6px",
                  cursor: isDisabled ? "not-allowed" : "pointer",
                  border: isDisabled ? "1px solid #21262d" : strategy === s ? "1px solid #58a6ff" : "1px solid #30363d",
                  background: isDisabled ? "#0d1117" : strategy === s ? "#132f4c" : "#161b22",
                  color: isDisabled ? "#484f58" : strategy === s ? "#58a6ff" : "#8b949e",
                  fontWeight: strategy === s ? 600 : 400,
                  fontFamily: "inherit",
                  transition: "all 0.15s",
                  zIndex: 20,
                  position: "relative",
                  pointerEvents: "all",
                  whiteSpace: "nowrap",
                  opacity: isDisabled ? 0.45 : 1,
                  textDecoration: isDisabled ? "line-through" : "none",
                }}
              >
                {s}
              </button>
              {isDisabled ? (
                <span style={{ fontSize: 9, color: "#484f58", fontFamily: FONT_MONO, lineHeight: 1, maxWidth: 80, textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {globalRegime}
                </span>
              ) : strategy === s && (
                <span style={{ fontSize: 9, color: signalCount > 0 ? "#3fb950" : "#484f58", fontFamily: FONT_MONO, lineHeight: 1 }}>
                  {signalCount} signal{signalCount !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {!isMobile ? (
        <div style={{ padding: "0 16px 8px", display: "flex", gap: 0, borderBottom: "0.5px solid var(--color-border-tertiary)", marginBottom: 16 }}>
          {tabs.map(([k, v]) => (
            <button key={k} onClick={() => setTab(k)} style={{ fontSize: 12, padding: "8px 16px", borderRadius: 6, cursor: "pointer", background: "transparent", border: "none", color: tab === k ? "#e6edf3" : "#8b949e", fontWeight: tab === k ? 600 : 400, borderBottom: tab === k ? "2px solid #388bfd" : "2px solid transparent" }}>{v}</button>
          ))}
        </div>
      ) : (
        <div className="qb-hscroll" style={{ display: "flex", gap: 0, overflowX: "auto", flexWrap: "nowrap", borderBottom: "1px solid #21262d", marginBottom: 8, background: "#0d1117" }}>
          {MOBILE_TABS.map(({ key, label }) => (
            <button key={key} onClick={() => setTab(key)} style={{ fontSize: 11, padding: "8px 14px", cursor: "pointer", background: "transparent", border: "none", color: tab === key ? "#e6edf3" : "#8b949e", fontWeight: tab === key ? 600 : 400, borderBottom: tab === key ? "2px solid #388bfd" : "2px solid transparent", whiteSpace: "nowrap", fontFamily: "inherit", flexShrink: 0 }}>{label}</button>
          ))}
        </div>
      )}

      <AnimatePresence mode="wait">
        {tab === "markets" && (
          <motion.div
            key="markets"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={isMobile ? {} : { padding: "0 16px" }}
          >
            {isMobile ? (
              <div style={{ marginBottom: 12 }}>
                {PAIRS.map(pair => (
                  <PairRow key={pair} pair={pair} basePrice={BASE_PRICES[pair]} strategy={strategy} onTrade={onTrade} currentHeadline={currentHeadline} onSignalUpdate={onSignalUpdate} onRegimeUpdate={onRegimeUpdate} onRejection={onRejection} openTrades={openTrades} marketOpen={marketOpen} isMobile />
                ))}
              </div>
            ) : (
              <div style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: 12, overflow: "hidden", margin: "0 16px 16px" }}>
                <div style={{ display: "grid", gridTemplateColumns: TABLE_COLS, gap: TABLE_GAP, padding: TABLE_PAD, background: "#0d1117", borderBottom: "1px solid #21262d", width: "100%", boxSizing: "border-box" }}>
                  <span style={{ fontSize: 11, color: "#8b949e", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.5px" }}>Pair</span>
                  <span style={{ fontSize: 11, color: "#8b949e", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.5px" }}>Price</span>
                  <span style={{ fontSize: 11, color: "#8b949e", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.5px" }}>Chart</span>
                  <span style={{ fontSize: 11, color: "#8b949e", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.5px" }}>Change</span>
                  <motion.span
                    animate={{ color: signalHeaderFlash ? "#58a6ff" : "#8b949e" }}
                    transition={{ duration: 0.2 }}
                    style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.5px", textAlign: "center" }}
                  >
                    Signal
                  </motion.span>
                  <span style={{ fontSize: 11, color: "#8b949e", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.5px", textAlign: "right" }}>Action</span>
                </div>
                {PAIRS.map(pair => (
                  <PairRow key={pair} pair={pair} basePrice={BASE_PRICES[pair]} strategy={strategy} onTrade={onTrade} currentHeadline={currentHeadline} onSignalUpdate={onSignalUpdate} onRegimeUpdate={onRegimeUpdate} onRejection={onRejection} openTrades={openTrades} marketOpen={marketOpen} isMobile={false} />
                ))}
              </div>
            )}
            <div>
              <OpenPositionsPanel openTrades={openTrades} livePrices={livePrices} onClose={closeTrade} isMobile={isMobile} />
              <PaperTradesPanel trades={paperTrades} isMobile={isMobile} />
              <TradeLog trades={trades} isMobile={isMobile} />
              <RejectionLogPanel log={rejectionLog} isMobile={isMobile} />
            </div>
          </motion.div>
        )}

        {tab === "news" && (
          <motion.div
            key="news"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <NewsTab isMobile={isMobile} />
          </motion.div>
        )}

        {tab === "ai" && (
          <motion.div
            key="ai"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <AIAnalystTab headlines={LIVE_HEADLINES} prices={livePrices} trades={trades} balance={balance} currentHeadline={currentHeadline} isMobile={isMobile} />
          </motion.div>
        )}

        {tab === "knowledge" && (
          <motion.div
            key="knowledge"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ padding: "0 16px", paddingBottom: 16 }}
          >
            <KnowledgePanel activeRule={activeRule} />
          </motion.div>
        )}

        {tab === "risk" && (
          <motion.div
            key="risk"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <RiskTab trades={trades} balance={balance} />
          </motion.div>
        )}

        {tab === "coach" && (
          <motion.div
            key="coach"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <AICoachTab trades={trades} isMobile={isMobile} />
          </motion.div>
        )}

        {tab === "analytics" && (
          <motion.div
            key="analytics"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <PerformanceDashboard trades={trades} balance={balance} isMobile={isMobile} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Auto Mode Settings Modal ── */}
      {showAutoSettings && (
        <AutoModeSettingsModal
          settings={autoSettings}
          onSave={(s) => { setAutoSettings(s); setShowAutoSettings(false); enableAutoMode(true); }}
          onCancel={() => setShowAutoSettings(false)}
        />
      )}

      {/* ── Mobile bottom nav ── */}
      {isMobile && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 100, background: "#161b22", borderTop: "1px solid #21262d", display: "grid", gridTemplateColumns: "repeat(6, 1fr)", padding: "10px 0 env(safe-area-inset-bottom, 16px)" }}>
          {MOBILE_TABS.map(({ key, label, Icon }) => {
            const active = tab === key;
            const color = active ? "#388bfd" : "#8b949e";
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: active ? "8px 0 4px" : "4px 0", background: "transparent", border: "none", borderTop: active ? "2px solid #388bfd" : "2px solid transparent", marginTop: active ? -10 : 0, cursor: "pointer", color, transition: "color 0.15s", fontFamily: "inherit" }}
              >
                <Icon color={color} />
                <span style={{ fontSize: 10, fontWeight: 500 }}>{label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
