import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { motion, AnimatePresence, animate } from "framer-motion";
import XavierOnboarding from "./XavierOnboarding";
import { createChart, CandlestickSeries, LineSeries } from "lightweight-charts";
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
  return pair.includes("JPY") ? 3 : pair.includes("XAU") || pair.includes("SPX") ? 2 : 5;
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
const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "XAU/USD", "SPX500_USD", "XAG/USD", "BCO/USD", "WTICO/USD", "NAS100_USD", "JP225_USD", "UK100_GBP", "AU200_AUD"];
const PAIR_DISPLAY_NAMES = {
  "SPX500_USD": "SPX500", "XAG/USD": "Silver",  "BCO/USD": "Brent",  "WTICO/USD": "WTI",
  "NAS100_USD": "NAS100", "JP225_USD": "JP225",  "UK100_GBP": "UK100", "AU200_AUD": "AU200",
};
const STRATEGIES = ["Trend Follow", "Mean Revert", "Breakout", "Momentum", "Range Scalp"];

const STRATEGY_SESSION_MATRIX = {
  SYDNEY: { primary: "Mean Revert",  fallback: "Trend Follow"  },
  TOKYO:  { primary: "Mean Revert",  fallback: "Range Scalp"  },
  LONDON: { primary: "Trend Follow", fallback: "Breakout"     },
  PRIME:  { primary: "Trend Follow", fallback: "Breakout"    },
  NY:     { primary: "Momentum",     fallback: "Trend Follow" },
  AVOID:  { primary: null,           fallback: null           },
};

const TABLE_COLS = "110px 110px 180px 100px 110px 100px";
const TABLE_GAP  = 0;
const TABLE_PAD  = "10px 16px";

const LIVE_HEADLINES = []; // populated by live news fetch in TradingRobot

// ─── WEEKLY EVENTS ────────────────────────────────────────────────────────────
const WEEKLY_EVENTS = [
  { day: "Mon", time: "8:30 AM",  event: "CAD CPI m/m",                 pair: "USD/CAD",  impact: "HIGH" },
  { day: "Tue", time: "10:00 AM", event: "US CB Consumer Confidence",    pair: "EUR/USD",  impact: "MED"  },
  { day: "Wed", time: "8:30 AM",  event: "US GDP q/q (2nd Est.)",        pair: "USD/JPY",  impact: "HIGH" },
  { day: "Wed", time: "2:00 PM",  event: "FOMC Minutes Release",         pair: "ALL",      impact: "HIGH" },
  { day: "Thu", time: "8:30 AM",  event: "US Initial Jobless Claims",    pair: "USD/CAD",  impact: "MED"  },
  { day: "Thu", time: "10:00 AM", event: "US Core PCE Price Index",      pair: "EUR/USD",  impact: "HIGH" },
  { day: "Fri", time: "8:30 AM",  event: "CAD GDP m/m",                 pair: "USD/CAD",  impact: "HIGH" },
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

function getCurrentSession() {
  const h = new Date().getUTCHours();
  const d = new Date().getUTCDay();
  if (d === 6 || (d === 0 && h < 22)) return "AVOID";
  if (h >= 22 || h < 4)  return "SYDNEY";  // crosses midnight UTC
  if (h >= 4  && h < 8)  return "TOKYO";
  if (h >= 8  && h < 13) return "LONDON";
  if (h >= 13 && h < 17) return "PRIME";
  if (h >= 17 && h < 20) return "NY";
  return "AVOID";  // 20-22 UTC
}

function getNextSessionInfo() {
  // UTC open hours for each tradeable session (AVOID has no strategy — skip it)
  // SYDNEY 22-04, TOKYO 04-08, LONDON 08-13, PRIME 13-17, NY 17-20, AVOID 20-22
  const BOUNDARIES = [
    { h: 4,  session: "TOKYO",  strategy: "Mean Revert"  },
    { h: 8,  session: "LONDON", strategy: "Trend Follow" },
    { h: 13, session: "PRIME",  strategy: "Trend Follow" },
    { h: 17, session: "NY",     strategy: "Momentum"     },
    { h: 22, session: "SYDNEY", strategy: "Breakout"     },
  ];
  const now = new Date();
  const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  let minD = Infinity, nxt = null;
  for (const b of BOUNDARIES) {
    let d = b.h * 60 - nowMins;
    if (d <= 0) d += 1440;
    if (d < minD) { minD = d; nxt = b; }
  }
  if (!nxt) return null;
  const h = Math.floor(minD / 60), m = String(minD % 60).padStart(2, "0");
  const calgaryHour = ((nxt.h - 6) + 24) % 24;
  return { session: nxt.session, strategy: nxt.strategy, countdown: `${h}h ${m}m`, calgaryTime: `${String(calgaryHour).padStart(2, "0")}:00` };
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

// ─── REAL OANDA PRICE HOOK ────────────────────────────────────────────────────
// Fetches M5 candle history on mount, then polls live mid-price every 5s.
// Returns { price, history, isReal } — isReal becomes true once ≥20 real candles loaded.
// usePriceSimulator() remains the fallback when OANDA is unreachable.
function useOandaPrice(pair) {
  const instrument = pair.replace("/", "_");
  const [oandaHistory, setOandaHistory] = useState([]);
  const [oandaPrice, setOandaPrice]     = useState(null);
  const [isReal, setIsReal]             = useState(false);
  const isRealRef                       = useRef(false);

  // Seed history from M5 candles on mount
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r    = await fetch(`${BRIDGE}/candles/${instrument}?count=60&granularity=M5`);
        const data = await r.json();
        if (!active || !Array.isArray(data.candles)) return;
        const closes = data.candles
          .filter(c => c.mid?.c)
          .map(c => parseFloat(c.mid.c))
          .filter(v => v > 0 && !isNaN(v));
        if (closes.length < 5) return;
        setOandaHistory(closes);
        setOandaPrice(closes[closes.length - 1]);
        if (closes.length >= 20) {
          isRealRef.current = true;
          setIsReal(true);
        }
      } catch {}
    })();
    return () => { active = false; };
  }, [instrument]);

  // Append live mid-price every 5 seconds
  useEffect(() => {
    const tick = async () => {
      try {
        const r    = await fetch(`${BRIDGE}/prices?instruments=${instrument}`);
        const data = await r.json();
        const px   = data.prices?.[0];
        if (!px) return;
        const bid  = parseFloat(px.bids?.[0]?.price ?? 0);
        const ask  = parseFloat(px.asks?.[0]?.price ?? 0);
        const mid  = (bid + ask) / 2;
        if (!mid || isNaN(mid) || mid <= 0) return;
        setOandaPrice(mid);
        setOandaHistory(prev => {
          const next = [...prev.slice(-59), mid];
          if (!isRealRef.current && next.length >= 20) {
            isRealRef.current = true;
            setIsReal(true);
          }
          return next;
        });
      } catch {}
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [instrument]);

  return { price: oandaPrice, history: oandaHistory, isReal };
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
  } else if (strategy === "Mean Revert") {
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const dev = Math.abs(last - mean) / mean;
    const pairKey  = pair.replace("/", "_");
    const isSilver = pairKey.includes("XAG");
    const isGold   = pairKey.includes("XAU");
    const isOil    = pairKey.includes("BCO") || pairKey.includes("WTICO");
    const isJpy    = pairKey.includes("JPY");
    // Silver moves 10× faster — wider deviation thresholds (USER EXPLICIT OVERRIDE 2026-05-27)
    const t1 = isSilver ? 0.004 : isOil ? 0.003 : isGold ? 0.0008 : isJpy ? 0.0015 : 0.001;
    const t2 = isSilver ? 0.008 : isOil ? 0.006 : isGold ? 0.0015 : isJpy ? 0.003  : 0.002;
    const t3 = isSilver ? 0.015 : isOil ? 0.012 : isGold ? 0.003  : isJpy ? 0.005  : 0.004;
    if (dev > t1) {
      const dir = last > mean ? "SHORT" : "LONG";
      score += 50;
      if (dev > t2) score += 10;
      if (dev > t3) score += 10;
      const returning = (dir === "LONG" && last > prev) || (dir === "SHORT" && last < prev);
      if (returning) score += 10;
      direction = dir;
      reason.push(`${(dev * 100).toFixed(2)}% deviation`);
    }
    // Spike recovery bonus — post-spike reversion is the cleanest Mean Revert setup.
    // Price overshoots during spike, ATR expanding. When ATR starts normalizing,
    // the snapback is sharper and more predictable.
    if (direction) {
      const tr20sr   = recent.slice(1).map((p, i) => Math.abs(p - recent[i]));
      const atr20sr  = tr20sr.reduce((a, b) => a + b, 0) / tr20sr.length || 0.00001;
      const atr5now  = tr20sr.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const atr5prev = tr20sr.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
      if (atr5prev > atr20sr * 2.0 && atr5now < atr5prev * 0.85 && dev > 0.0015) {
        score += 10;
        reason.push("Post-spike reversion");
      }
    }
  } else if (strategy === "Breakout") {
    // Base 45: price at range boundary
    const high = Math.max(...recent), low = Math.min(...recent), range = high - low;
    if      (last > high - range * 0.05) { score += 45; direction = "LONG";  reason.push("Near range high"); }
    else if (last < low  + range * 0.05) { score += 45; direction = "SHORT"; reason.push("Near range low");  }
    if (direction) {
      const tr      = recent.slice(1).map((p, i) => Math.abs(p - recent[i]));
      const atr5    = tr.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const atrFull = tr.reduce((a, b) => a + b, 0) / tr.length;
      // +10 ATR expanding: recent bars more volatile than average = momentum behind move
      if (atr5 > atrFull * 1.1)               { score += 10; reason.push("ATR expanding"); }
      // +10 volume proxy: last bar move > 1.5× avg bar size = strong thrust
      if (Math.abs(last - prev) > atrFull * 1.5) { score += 10; reason.push("Strong thrust"); }
      // +5 PRIME or LONDON: best liquidity for clean breakouts
      const sess = getCurrentSession();
      if (sess === "PRIME" || sess === "LONDON") { score += 5; reason.push(`${sess} session`); }
    }
  } else if (strategy === "Momentum") {
    const momentum = (last - recent[recent.length - 10]) / recent[recent.length - 10];
    if (Math.abs(momentum) >= 0.004) {
      // Base 55: momentum threshold met
      direction = momentum > 0 ? "LONG" : "SHORT";
      score += 55;
      reason.push(`${(momentum * 100).toFixed(2)}% momentum`);
      // +10 strong momentum (> 0.6%)
      if (Math.abs(momentum) > 0.006)                                           { score += 10; reason.push("Strong momentum"); }
      // +5 EMA9 confirms direction
      if ((direction === "LONG" && ema9 > ema21) || (direction === "SHORT" && ema9 < ema21)) { score += 5;  reason.push("EMA confirms"); }
      // +5 NY or PRIME: momentum sustains in high-volume sessions
      const sess = getCurrentSession();
      if (sess === "NY" || sess === "PRIME")                                     { score += 5;  reason.push(`${sess} session`); }
    }
  } else {
    // Range Scalp: score when market is in a tight range (high-low < 0.3%) and price at boundary
    const high20 = Math.max(...recent), low20 = Math.min(...recent);
    const rangeSize = high20 - low20;
    const rangePct  = low20 > 0 ? rangeSize / low20 : 1;
    if (rangePct < 0.003) {
      // Base 50: price near range boundary (within 20% of edge)
      if      (last < low20  + rangeSize * 0.2) { score += 50; direction = "LONG";  reason.push("Range low boundary"); }
      else if (last > high20 - rangeSize * 0.2) { score += 50; direction = "SHORT"; reason.push("Range high boundary"); }
      if (direction) {
        // +10 oscillator confirms oversold/overbought
        const rsiProxy = 50 + (change / 0.01) * 20;
        if ((direction === "LONG" && rsiProxy < 45) || (direction === "SHORT" && rsiProxy > 55)) { score += 10; reason.push("Oscillator confirm"); }
        // +10 SYDNEY or TOKYO: low-volatility range sessions
        const sess = getCurrentSession();
        if (sess === "SYDNEY" || sess === "TOKYO") { score += 10; reason.push(`${sess} range session`); }
      }
    }
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

  // Display threshold — dynamic per pair via reinforcement learning (default 65)
  let threshold = 65;
  try {
    const rt = JSON.parse(localStorage.getItem("reinforcement_thresholds") || "{}");
    const pairKey = pair.replace("/", "_");
    const pairBase = rt.pairThresholds?.[pairKey] ?? 65;
    const stratPenalty = rt.strategyPenalties?.[strategy] ?? 0;
    const sesBonus = rt.sessionBonuses?.[getCurrentSession()] ?? 0;
    threshold = Math.max(55, Math.min(65, pairBase + stratPenalty + sesBonus));
  } catch {}
  if (!direction || score < threshold) return null;
  const _pairKey2  = pair.replace("/", "_");
  const _isSilver2 = _pairKey2.includes("XAG");
  const _isOil2    = _pairKey2.includes("BCO") || _pairKey2.includes("WTICO");
  const minHold    = _isSilver2 ? 30 : _isOil2 ? 20 : 5;
  return { direction, score: Math.min(score, 100), reason, rsi: parseFloat(rsi.toFixed(1)), threshold, minHold };
}

// ─── REGIME / GATEKEEPER ENGINE ──────────────────────────────────────────────
const PIP_SIZE = {
  "EUR/USD": 0.0001, "GBP/USD": 0.0001, "USD/JPY": 0.01,
  "AUD/USD": 0.0001, "USD/CAD": 0.0001,
  "XAU/USD": 0.01, "SPX500_USD": 0.1,
};
const TYPICAL_SPREAD_PIPS = {
  EUR_USD: 1.2, GBP_USD: 1.8, USD_JPY: 1.2, AUD_USD: 1.5,
  USD_CAD: 1.8, EUR_GBP: 1.5, NZD_USD: 2.0, XAU_USD: 35.0,
  SPX500_USD: 0.4, XAG_USD: 3.0, BCO_USD: 4.0, WTICO_USD: 4.0,
  NAS100_USD: 1.5, JP225_USD: 4.0, UK100_GBP: 2.0, AU200_AUD: 3.0,
};
const TYPICAL_SLIPPAGE_PIPS = {
  EUR_USD: 0.3, GBP_USD: 0.4, USD_JPY: 0.3, AUD_USD: 0.4,
  USD_CAD: 0.4, EUR_GBP: 0.4, NZD_USD: 0.5, XAU_USD: 8.0,
  SPX500_USD: 0.2, XAG_USD: 1.5, BCO_USD: 2.0, WTICO_USD: 2.0,
  NAS100_USD: 1.0, JP225_USD: 2.0, UK100_GBP: 1.5, AU200_AUD: 1.5,
};
const PAIR_SPREAD_LIMITS = {
  EUR_USD:    { PRIME: 1.5,  LONDON: 2.0,  NY: 2.5,  TOKYO: 3.5, SYDNEY: 3.5, AVOID: 4.0  },
  GBP_USD:    { PRIME: 2.0,  LONDON: 2.5,  NY: 3.0,  TOKYO: 5.0, SYDNEY: 5.0, AVOID: 6.0  },
  USD_JPY:    { PRIME: 1.5,  LONDON: 2.0,  NY: 2.0,  TOKYO: 2.0, SYDNEY: 2.5, AVOID: 3.5  },
  AUD_USD:    { PRIME: 1.8,  LONDON: 2.2,  NY: 2.5,  TOKYO: 2.5, SYDNEY: 2.0, AVOID: 4.5  },
  USD_CAD:    { PRIME: 2.0,  LONDON: 2.5,  NY: 2.5,  TOKYO: 4.0, SYDNEY: 4.5, AVOID: 5.0  },
  EUR_GBP:    { PRIME: 1.8,  LONDON: 2.0,  NY: 2.5,  TOKYO: 4.0, SYDNEY: 4.0, AVOID: 5.0  },
  NZD_USD:    { PRIME: 2.5,  LONDON: 3.0,  NY: 3.5,  TOKYO: 3.0, SYDNEY: 2.5, AVOID: 5.0  },
  XAU_USD:    { PRIME: 40.0, LONDON: 45.0, NY: 45.0, TOKYO: 60.0, SYDNEY: 65.0, AVOID: 80.0 },
  SPX500_USD: { PRIME: 0.5,  LONDON: 0.6,  NY: 0.5,  TOKYO: 1.0, SYDNEY: 1.2, AVOID: 1.5  },
  XAG_USD:    { PRIME: 3.0,  LONDON: 3.5,  NY: 4.0,  TOKYO: 6.0, SYDNEY: 5.0, AVOID: 8.0  },
  BCO_USD:    { PRIME: 4.0,  LONDON: 4.5,  NY: 5.0,  TOKYO: 8.0, SYDNEY: 7.0, AVOID: 10.0 },
  WTICO_USD:  { PRIME: 4.0,  LONDON: 5.0,  NY: 4.5,  TOKYO: 8.0, SYDNEY: 7.0, AVOID: 10.0 },
  NAS100_USD: { PRIME: 2.0,  LONDON: 3.0,  NY: 1.5,  TOKYO: 5.0, SYDNEY: 4.0, AVOID: 8.0  },
  JP225_USD:  { PRIME: 8.0,  LONDON: 10.0, NY: 8.0,  TOKYO: 4.0, SYDNEY: 6.0, AVOID: 12.0 },
  UK100_GBP:  { PRIME: 3.0,  LONDON: 2.0,  NY: 4.0,  TOKYO: 8.0, SYDNEY: 7.0, AVOID: 10.0 },
  AU200_AUD:  { PRIME: 5.0,  LONDON: 7.0,  NY: 6.0,  TOKYO: 4.0, SYDNEY: 3.0, AVOID: 10.0 },
};
const USD_PAIRS_SET = new Set(["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD"]);

const CORRELATION_MATRIX = {
  EUR_USD: { positive: ["GBP_USD", "AUD_USD", "NZD_USD"], negative: ["USD_JPY", "USD_CAD"] },
  GBP_USD: { positive: ["EUR_USD", "AUD_USD", "NZD_USD"], negative: ["USD_JPY", "USD_CAD"] },
  USD_JPY: { positive: ["USD_CAD"],                        negative: ["EUR_USD", "GBP_USD", "AUD_USD", "NZD_USD"] },
  AUD_USD: { positive: ["NZD_USD", "EUR_USD"],             negative: ["USD_JPY", "USD_CAD"] },
  USD_CAD: { positive: ["USD_JPY"],                        negative: ["AUD_USD", "EUR_USD", "NZD_USD"] },
  XAU_USD: { positive: [],                                 negative: ["USD_JPY"] },
  NZD_USD: { positive: ["AUD_USD", "EUR_USD"],             negative: ["USD_CAD", "USD_JPY"] },
  EUR_GBP: { positive: ["EUR_USD"],                        negative: [] },
};

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
  const isVolatile = atr20 > 0 && atr5 > atr20 * 2.5;
  const regime = isVolatile ? "VOLATILE" : isTrending ? "TRENDING" : "RANGING";
  return { regime, ema9, ema21, ema50, atr5, atr20, bullTrend };
}

const SESSION_TRADE_LIMITS = { PRIME: 4, LONDON: 4, NY: 4, TOKYO: 2, SYDNEY: 3, AVOID: 0 };

function runGatekeepers(history, signal, openTrades, pair, strategy = "") {
  const rejections = [];
  const pairKey = pair.replace("/", "_");
  const pip     = PIP_SIZE[pair] || 0.0001;
  const bars    = history.slice(-21);
  const tr    = bars.slice(1).map((p, i) => Math.abs(p - bars[i]));
  const atr5  = tr.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const atr20 = tr.reduce((a, b) => a + b, 0) / tr.length || atr5;
  const atr5Pips = atr5 / pip;

  // 0. AVOID session — hard block, no exceptions
  const sessionNow = getCurrentSession();
  if (sessionNow === "AVOID") {
    rejections.push({
      condition: "Dead zone block",
      actual: "AVOID session",
      threshold: "Active session required",
      reason: "Markets are in the dead zone. No trades — period. Wait for Tokyo open.",
    });
    return { passed: false, rejections };
  }

  // 1. Score ≥ 65
  if (signal.score < 65) {
    rejections.push({
      condition: "Score threshold",
      actual: `${signal.score}%`,
      threshold: "65%",
      reason: `Only ${signal.score}% confidence — I need 65%`,
    });
  }

  // 2a. Position limit — max 2 open trades
  if ((openTrades || []).length >= 2) {
    rejections.push({
      condition: "Position limit",
      actual: `${openTrades.length} open`,
      threshold: "Max 2 trades",
      reason: "Already have 2 open positions — waiting for one to close.",
    });
  }

  // 2b. Heat limit — max 4R portfolio heat
  const currentHeat = (openTrades || []).length * 1.5;
  if (currentHeat >= 4) {
    rejections.push({
      condition: "Heat limit",
      actual: `${currentHeat.toFixed(1)}R`,
      threshold: "4R max",
      reason: `Portfolio heat at ${currentHeat.toFixed(1)}R — I don't add exposure above 4R.`,
    });
  }

  // 2. Spread check — compare typical spread vs per-session limit
  const spreadPips  = TYPICAL_SPREAD_PIPS[pairKey] ?? (atr5Pips * 0.12);
  const spreadLimit = PAIR_SPREAD_LIMITS[pairKey]?.[sessionNow] ?? (spreadPips * 2);
  if (spreadPips > spreadLimit) {
    rejections.push({
      condition: "Spread check",
      actual: `${spreadPips.toFixed(1)}p`,
      threshold: `${spreadLimit.toFixed(1)}p`,
      reason: `Spread's at ${spreadPips.toFixed(1)}p in ${sessionNow} — limit is ${spreadLimit.toFixed(1)}p. I won't trade into that friction.`,
    });
  }

  // 3. Slippage estimate — block if > 2× typical for this pair
  const typicalSlippage = TYPICAL_SLIPPAGE_PIPS[pairKey] ?? 1.0;
  const slippageLimit   = typicalSlippage * 2;
  const slippagePips    = TYPICAL_SLIPPAGE_PIPS[pairKey] ?? (atr5Pips * 0.1);
  if (slippagePips > slippageLimit) {
    rejections.push({
      condition: "Slippage estimate",
      actual: `${slippagePips.toFixed(2)}p`,
      threshold: `${slippageLimit.toFixed(2)}p`,
      reason: `Slippage estimate is ${slippagePips.toFixed(2)}p on ${pair} — more than twice normal. Not worth the fill risk.`,
    });
  }

  // 4. Correlated USD pairs — max 1 same-direction USD position
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
    if (sameCount >= 1) {
      rejections.push({
        condition: "Correlated pairs",
        actual: `${sameCount} USD pair${sameCount > 1 ? "s" : ""}`,
        threshold: "0",
        reason: `Already running ${sameCount} USD pair the same direction. I'm not doubling up on the dollar.`,
      });
    }
  }

  // 5. Higher timeframe bias — Trend Follow only: price must be on correct side of EMA50
  if (strategy === "Trend Follow" && history.length >= 50) {
    const ema50 = history.slice(-50).reduce((a, b) => a + b, 0) / 50;
    const last  = history[history.length - 1];
    const biasOk = signal.direction === "LONG" ? last > ema50 : last < ema50;
    if (!biasOk) {
      rejections.push({
        condition: "EMA50 bias",
        actual: signal.direction === "LONG" ? "Price below EMA50" : "Price above EMA50",
        threshold: `Price ${signal.direction === "LONG" ? "above" : "below"} EMA50`,
        reason: `Price is on the wrong side of EMA50 for a ${signal.direction}. I'll pass and wait for a cleaner setup.`,
      });
    }
  }

  // 6. Volatility check — block if ATR5 > 2.5× ATR20
  if (atr20 > 0 && atr5 > atr20 * 2.5) {
    rejections.push({
      condition: "Volatility check",
      actual: `${(atr5 / atr20).toFixed(1)}× avg ATR`,
      threshold: "< 2.5×",
      reason: `Market spiking — 5-bar ATR is ${(atr5 / atr20).toFixed(1)}× the 20-bar average. I don't trade into noise like this.`,
    });
  }

  // 7. Duplicate trade prevention — block same pair within 60 seconds
  const recentDupe = (openTrades || []).some(t => {
    if ((t.instrument ?? "") !== pairKey) return false;
    const age = Date.now() - new Date(t.openTime).getTime();
    return age < 60_000;
  });
  if (recentDupe) {
    rejections.push({
      condition: "Duplicate prevention",
      actual: "Trade < 60s ago",
      threshold: "60s cooldown",
      reason: `${pair} was just opened — I'm not stacking the same position back-to-back.`,
    });
  }

  // 8. Session trade cap
  const sessionLimit = SESSION_TRADE_LIMITS[sessionNow] ?? 4;
  const sessionTrades = (openTrades || []).filter(t => {
    const openTime = new Date(t.openTime).getTime();
    const nowUtc   = Date.now();
    const SESSION_WINDOWS = {
      PRIME:  [13, 17], LONDON: [8, 13], NY: [17, 20],
      TOKYO:  [4, 8],   SYDNEY: [22, 28], AVOID: [20, 22],
    };
    const [start, end] = SESSION_WINDOWS[sessionNow] || [0, 24];
    const tradeHour = new Date(openTime).getUTCHours();
    const tradeHourAdj = tradeHour < (start > 20 ? 4 : 0) ? tradeHour + 24 : tradeHour;
    return tradeHourAdj >= start && tradeHourAdj < end;
  }).length;
  if (sessionTrades >= sessionLimit) {
    rejections.push({
      condition: "Session cap",
      actual: `${sessionTrades} trades`,
      threshold: `${sessionLimit} max`,
      reason: `${sessionLimit} trades in ${sessionNow} is my limit. Done trading this session.`,
    });
  }

  // 9. Correlation matrix enforcement
  const corrMatrix = CORRELATION_MATRIX[pairKey];
  if (corrMatrix) {
    const proposedIsLong = signal.direction === "LONG";
    let positiveCount = 0;
    let corrBlockReason = null;

    for (const openTrade of (openTrades || [])) {
      const openInstr = openTrade.instrument; // already underscore format e.g. EUR_USD
      const openUnits = parseInt(openTrade.currentUnits || 0);
      if (openUnits === 0) continue;
      const openIsLong = openUnits > 0;

      if (corrMatrix.positive.includes(openInstr)) {
        if (openIsLong === proposedIsLong) positiveCount++;
      } else if (corrMatrix.negative.includes(openInstr)) {
        // Negative correlation: if directions are opposite (price-wise), it doubles the same underlying bet
        if (openIsLong !== proposedIsLong) {
          const dir = openIsLong ? "long" : "short";
          const fmt = openInstr.replace("_", "/");
          corrBlockReason = `Correlated exposure — already ${dir} ${fmt} creates same risk as ${signal.direction.toLowerCase()} ${pair}. Doubling the bet.`;
          break;
        }
      }
    }

    if (corrBlockReason) {
      rejections.push({ condition: "Correlation matrix", actual: "Doubled exposure", threshold: "No overlap", reason: corrBlockReason });
    } else if (positiveCount >= 2) {
      rejections.push({
        condition: "Correlation matrix",
        actual: `${positiveCount} correlated positions`,
        threshold: "Max 2",
        reason: `Already ${positiveCount} correlated positions open the same direction — won't add a third.`,
      });
    }
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
      <path d={d} fill="none" stroke={color} strokeWidth={fullWidth ? "1.1" : "0.9"} strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

// ─── OANDA CANDLE CHART (Chart.js area with gradient fill) ───────────────────
function toOandaSymbol(pair) {
  return pair.replace("/", "_");
}

function buildGradient(ctx, chartArea, isUp) {
  const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  if (isUp) {
    g.addColorStop(0, "rgba(29,158,117,0.14)");
    g.addColorStop(1, "rgba(29,158,117,0)");
  } else {
    g.addColorStop(0, "rgba(226,75,74,0.14)");
    g.addColorStop(1, "rgba(226,75,74,0)");
  }
  return g;
}

// ─── CHART HELPERS ───────────────────────────────────────────────────────────
function buildEMA(candles, period) {
  const k = 2 / (period + 1);
  const out = [];
  let ema = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) continue;
    if (i === period - 1) {
      ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
    } else {
      ema = candles[i].close * k + ema * (1 - k);
    }
    out.push({ time: candles[i].time, value: parseFloat(ema.toFixed(6)) });
  }
  return out;
}

function buildATR(candles, period = 14) {
  if (candles.length < 2) return 0.0005;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length);
}

// ─── CANDLESTICK CHART (Lightweight Charts v5) ───────────────────────────────
function CandleChart({ pair, history, signal }) {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);
  const seriesRef    = useRef({ candle: null, ema9: null, ema21: null });
  const [loaded, setLoaded] = useState(false);

  // 30-second refresh — updates candle data in-place without rebuilding the chart
  useEffect(() => {
    const refresh = async () => {
      const { candle, ema9, ema21 } = seriesRef.current;
      if (!candle || !ema9 || !ema21) return;
      try {
        const r = await fetch(`${BRIDGE}/candles/${pair.replace("/", "_")}?count=100&granularity=M15`);
        const data = await r.json();
        if (!Array.isArray(data.candles)) return;
        const candles = data.candles
          .filter(c => c.mid)
          .map(c => ({
            time:  Math.floor(new Date(c.time).getTime() / 1000),
            open:  parseFloat(c.mid.o),
            high:  parseFloat(c.mid.h),
            low:   parseFloat(c.mid.l),
            close: parseFloat(c.mid.c),
          }))
          .filter((c, i, arr) => i === 0 || c.time > arr[i - 1].time);
        if (candles.length < 5) return;
        candle.setData(candles);
        ema9.setData(buildEMA(candles, 9));
        ema21.setData(buildEMA(candles, 21));
      } catch {}
    };
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [pair]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let active = true;

    const chart = createChart(el, {
      autoSize: true,
      height:   260,
      layout: {
        background:      { type: "solid", color: "#0d1117" },
        textColor:       "#8b949e",
        fontSize:        11,
        fontFamily:      "'JetBrains Mono', monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "#161b22" },
        horzLines: { color: "#161b22" },
      },
      rightPriceScale: {
        borderColor:  "transparent",
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor:    "transparent",
        timeVisible:    true,
        secondsVisible: false,
        tickMarkFormatter: (t) => {
          const d = new Date(t * 1000);
          return `${d.getUTCHours().toString().padStart(2, "0")}:${d.getUTCMinutes().toString().padStart(2, "0")}`;
        },
      },
      crosshair: {
        vertLine: { color: "#30363d", width: 1, style: 3, labelBackgroundColor: "#161b22" },
        horzLine: { color: "#30363d", width: 1, style: 3, labelBackgroundColor: "#161b22" },
      },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor:        "#238636",
      downColor:      "#c0392b",
      borderUpColor:  "#3fb950",
      borderDownColor:"#f85149",
      wickUpColor:    "#3fb950",
      wickDownColor:  "#f85149",
    });

    const ema9Series = chart.addSeries(LineSeries, {
      color:               "#58a6ff",
      lineWidth:           1,
      priceLineVisible:    false,
      lastValueVisible:    false,
      crosshairMarkerVisible: false,
    });

    const ema21Series = chart.addSeries(LineSeries, {
      color:               "#d29922",
      lineWidth:           1,
      priceLineVisible:    false,
      lastValueVisible:    false,
      crosshairMarkerVisible: false,
    });

    seriesRef.current = { candle: candleSeries, ema9: ema9Series, ema21: ema21Series };

    const instrument = pair.replace("/", "_");
    fetch(`${BRIDGE}/candles/${instrument}?count=100&granularity=M15`)
      .then(r => r.json())
      .then(data => {
        if (!active || !Array.isArray(data.candles)) throw new Error("no candles");
        const candles = data.candles
          .filter(c => c.mid)
          .map(c => ({
            time:  Math.floor(new Date(c.time).getTime() / 1000),
            open:  parseFloat(c.mid.o),
            high:  parseFloat(c.mid.h),
            low:   parseFloat(c.mid.l),
            close: parseFloat(c.mid.c),
          }))
          .filter((c, i, arr) => i === 0 || c.time > arr[i - 1].time);

        if (candles.length < 5) throw new Error("too few");
        candleSeries.setData(candles);
        ema9Series.setData(buildEMA(candles, 9));
        ema21Series.setData(buildEMA(candles, 21));

        if (signal) {
          const atr   = buildATR(candles);
          const entry = candles[candles.length - 1].close;
          const slDist = atr * 1.5;
          const tpDist = atr * 3.0;
          const sl = signal.direction === "LONG" ? entry - slDist : entry + slDist;
          const tp = signal.direction === "LONG" ? entry + tpDist : entry - tpDist;
          const entryColor = signal.direction === "LONG" ? "#58a6ff" : "#8b5cf6";
          candleSeries.createPriceLine({ price: entry, color: entryColor, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Entry" });
          candleSeries.createPriceLine({ price: sl,    color: "#f85149",  lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "SL" });
          candleSeries.createPriceLine({ price: tp,    color: "#3fb950",  lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "TP" });
        }

        chart.timeScale().fitContent();
        setLoaded(true);
      })
      .catch(() => {
        if (!active) return;
        if (history.length >= 5) {
          const now = Math.floor(Date.now() / 1000);
          const fb = history.slice(-80).map((close, i) => ({
            time:  now - (80 - i) * 900,
            open:  close * 0.9998,
            high:  close * 1.0004,
            low:   close * 0.9996,
            close,
          })).filter((c, i, arr) => i === 0 || c.time > arr[i - 1].time);
          candleSeries.setData(fb);
          chart.timeScale().fitContent();
        }
        setLoaded(true);
      });

    return () => {
      active = false;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = { candle: null, ema9: null, ema21: null };
    };
  }, [pair]);

  return (
    <div style={{ position: "relative" }}>
      <div ref={containerRef} style={{ width: "100%", height: 260, borderRadius: "0 0 4px 4px", overflow: "hidden" }} />
      {!loaded && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#0d1117", borderRadius: 4 }}>
          <span style={{ fontSize: 11, color: "#484f58", fontFamily: FONT_MONO }}>Loading chart…</span>
        </div>
      )}
    </div>
  );
}

// ─── TRADE STRUCTURE PANEL ────────────────────────────────────────────────────
function TradeStructurePanel({ signal, history, pair }) {
  if (!signal) return null;
  const pip     = PIP_SIZE[pair] || 0.0001;
  const bars    = history.slice(-21);
  const tr      = bars.slice(1).map((p, i) => Math.abs(p - bars[i]));
  const atr5    = tr.slice(-5).reduce((a, b) => a + b, 0) / 5 || 0.0001;
  const atr5Pip = atr5 / pip;
  const last    = history[history.length - 1] ?? 0;
  const slDist  = atr5 * 1.5;
  const tpDist  = atr5 * 3.0;
  const sl      = signal.direction === "LONG" ? last - slDist : last + slDist;
  const tp      = signal.direction === "LONG" ? last + tpDist : last - tpDist;
  const decimals = priceDecimals(pair);
  const rr      = (tpDist / slDist).toFixed(1);
  const session = getCurrentSession();
  const sessionColors = { PRIME: "#3fb950", LONDON: "#58a6ff", NY: "#d29922", TOKYO: "#8b5cf6", SYDNEY: "#1D9E75", AVOID: "#484f58" };
  const sessionCol = sessionColors[session] || "#8b949e";

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 1, borderTop: "1px solid #21262d", background: "#161b22" }}>
      {[
        { label: "ENTRY",    value: last.toFixed(decimals),   color: signal.direction === "LONG" ? "#58a6ff" : "#8b5cf6" },
        { label: "SL",       value: sl.toFixed(decimals),     color: "#f85149" },
        { label: "TP",       value: tp.toFixed(decimals),     color: "#3fb950" },
        { label: "R:R",      value: `1:${rr}`,                color: parseFloat(rr) >= 2 ? "#3fb950" : "#d29922" },
        { label: "ATR",      value: `${atr5Pip.toFixed(1)}p`, color: "#8b949e" },
        { label: session,    value: signal.score + "%",       color: sessionCol },
      ].map(({ label, value, color }) => (
        <div key={label} style={{ padding: "7px 10px", background: "#0d1117", textAlign: "center" }}>
          <div style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 3 }}>{label}</div>
          <div style={{ fontSize: 12, fontWeight: 600, color, fontFamily: FONT_MONO }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

// ─── INSTITUTIONAL METRICS STRIP ─────────────────────────────────────────────
function MetricsStrip({ openTrades, signalCount, globalRegime, reinforcement }) {
  const heat    = openTrades.length * 1.5;
  const maxHeat = 6;
  const heatPct = Math.min(heat / maxHeat * 100, 100);
  const heatColor = heat >= maxHeat ? "#f85149" : heat >= 4 ? "#f0883e" : heat >= 2 ? "#d29922" : "#3fb950";
  const session = getCurrentSession();
  const sessionColors = { PRIME: "#3fb950", LONDON: "#58a6ff", NY: "#d29922", TOKYO: "#8b5cf6", SYDNEY: "#1D9E75", AVOID: "#f85149" };
  const sessionCol = sessionColors[session] || "#8b949e";
  const regimeColor = globalRegime === "TRENDING" ? "#3fb950" : globalRegime === "VOLATILE" ? "#f85149" : "#d29922";

  return (
    <div style={{ display: "flex", gap: 1, padding: "0 16px 12px", alignItems: "stretch" }}>
      {/* Portfolio Heat */}
      <div style={{ flex: 1, background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: "8px 12px" }}>
        <div style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>Portfolio Heat</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, height: 3, background: "#21262d", borderRadius: 2, overflow: "hidden" }}>
            <motion.div animate={{ width: `${heatPct}%` }} transition={{ duration: 0.5 }} style={{ height: "100%", background: heatColor, borderRadius: 2 }} />
          </div>
          <span style={{ fontSize: 11, fontWeight: 600, color: heatColor, fontFamily: FONT_MONO, minWidth: 28 }}>{heat.toFixed(1)}R</span>
        </div>
      </div>
      {/* Open Positions */}
      <div style={{ flex: "0 0 auto", background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: "8px 14px", minWidth: 80, textAlign: "center" }}>
        <div style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>Open</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: openTrades.length > 0 ? "#58a6ff" : "#484f58", fontFamily: FONT_MONO }}>{openTrades.length}</div>
      </div>
      {/* AI Signals */}
      <div style={{ flex: "0 0 auto", background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: "8px 14px", minWidth: 80, textAlign: "center" }}>
        <div style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>Signals</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: signalCount > 0 ? "#3fb950" : "#484f58", fontFamily: FONT_MONO }}>{signalCount}</div>
      </div>
      {/* Session */}
      <div style={{ flex: "0 0 auto", background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: "8px 14px", minWidth: 90, textAlign: "center" }}>
        <div style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>Session</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: sessionCol, letterSpacing: "0.5px" }}>{session}</div>
      </div>
      {/* Regime */}
      <div style={{ flex: "0 0 auto", background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: "8px 14px", minWidth: 90, textAlign: "center" }}>
        <div style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>Regime</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: globalRegime ? regimeColor : "#484f58" }}>{globalRegime || "—"}</div>
      </div>
      {/* Learning indicator — only shown when reinforcement has adapted thresholds */}
      {reinforcement?.pairThresholds && Object.keys(reinforcement.pairThresholds).length > 0 && (() => {
        const adapted = Object.entries(reinforcement.pairThresholds).find(([, v]) => v !== 65);
        if (!adapted) return null;
        const penalty = Object.values(reinforcement.strategyPenalties || {}).find(v => v > 0);
        const label = penalty
          ? `VOLATILE · ${adapted[0].replace("_", "/")} ${adapted[1]}% threshold`
          : `VOLATILE · ${adapted[0].replace("_", "/")} ${adapted[1]}%`;
        return (
          <div style={{ flex: "0 0 auto", background: "rgba(139,92,246,0.06)", border: "1px solid rgba(139,92,246,0.25)", borderRadius: 8, padding: "8px 12px", textAlign: "center" }}>
            <div style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>Volatile</div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#8b5cf6", letterSpacing: "0.03em", whiteSpace: "nowrap" }}>{label}</div>
          </div>
        );
      })()}
    </div>
  );
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
            borderWidth: 0.9,
            fill: true,
            tension: 0.15,
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
function AISignalConfirm({ pair, signal, price, history, currentHeadline, onConfirmed, onRejected, marketOpen, regimeData, session, openTrades, balance, xavierIntel, newsLastFetchedAt = 0 }) {
  const [loading, setLoading]   = useState(false);
  const [consensus, setConsensus] = useState(null);
  const [showLog, setShowLog]   = useState(false);

  const analyze = async () => {
    setLoading(true);
    const change = ((history[history.length - 1] - history[0]) / history[0] * 100).toFixed(3);

    // Fetch fresh OANDA price for this pair
    let freshEntry = price;
    try {
      const pResp = await fetch(`${BRIDGE}/prices?instruments=${pair.replace("/", "_")}`).then(r => r.json());
      if (pResp.prices?.[0]) {
        const px = pResp.prices[0];
        freshEntry = (parseFloat(px.bids[0].price) + parseFloat(px.asks[0].price)) / 2;
      }
    } catch { /* fall back to prop price */ }

    // Xavier intel staleness check
    const xavierAge = xavierIntel?.timestamp ? Date.now() - xavierIntel.timestamp : Infinity;
    const xavierAgeMin = xavierAge === Infinity ? 999 : Math.round(xavierAge / 60000);
    const xavierBriefFinal = xavierAge > 15 * 60 * 1000
      ? "Xavier intelligence unavailable — refreshing now. Base analysis on price action and news only."
      : xavierIntel?.brief || null;

    // News staleness
    const newsAgeMin = newsLastFetchedAt ? Math.round((Date.now() - newsLastFetchedAt) / 60000) : 999;
    const headlineFinal = newsAgeMin > 30 ? `[stale — ${newsAgeMin}min old] ${currentHeadline}` : currentHeadline;

    // Derived values for role-specific prompts
    const pip        = PIP_SIZE[pair] || 0.0001;
    const atr        = regimeData?.atr5 || 0.001;
    const atrPips    = (atr / pip).toFixed(1);
    const sl         = signal.direction === "LONG" ? (price - atr * 1.5).toFixed(5) : (price + atr * 1.5).toFixed(5);
    const tp         = signal.direction === "LONG" ? (price + atr * 3).toFixed(5)   : (price - atr * 3).toFixed(5);
    const slDistance = (atr * 1.5 / pip).toFixed(1);
    const tpDistance = (atr * 3   / pip).toFixed(1);
    const heat       = ((openTrades?.length || 0) * 1.5).toFixed(1);
    const pairKey    = pair.replace("/", "_");
    const spread     = TYPICAL_SPREAD_PIPS[pairKey]?.toFixed(1) ?? (atr / pip * 0.12).toFixed(1);
    const spreadLimit = (PAIR_SPREAD_LIMITS[pairKey]?.[session?.toUpperCase()] ?? parseFloat(spread) * 2).toFixed(1);
    const ema9       = regimeData?.ema9?.toFixed(5)  || "?";
    const ema21      = regimeData?.ema21?.toFixed(5) || "?";
    const ema50side  = price > (regimeData?.ema50 || price) ? "ABOVE" : "BELOW";
    const closes     = history.slice(-5).map(v => v.toFixed(5)).join(", ");
    const momentum   = history.length >= 11
      ? ((history[history.length-1] - history[history.length-11]) / history[history.length-11] * 100).toFixed(3)
      : "0.000";
    const mean20     = history.length >= 20 ? history.slice(-20).reduce((a, b) => a + b, 0) / 20 : price;
    const deviation  = ((price - mean20) / mean20 * 100).toFixed(3);
    const riskAmount = ((balance || 100) * 0.015).toFixed(2);
    const sessionQuality = session === "PRIME" ? "PRIME (highest edge)" : (session === "LONDON" || session === "NY") ? "GOOD" : "REDUCED";
    const newsRisk   = ["fed","rate","cpi","nfp","gdp","fomc","inflation"].some(k => (currentHeadline || "").toLowerCase().includes(k)) ? "HIGH" : "LOW";
    const CORRELATED = {
      "EUR/USD": "GBP/USD (positive), USD/CHF (negative)",
      "GBP/USD": "EUR/USD (positive), USD/CHF (negative)",
      "USD/JPY": "USD/CAD (positive), risk-off proxy",
      "USD/CAD": "USD/JPY (positive), oil correlation",
      "AUD/USD": "NZD/USD (positive), risk-on proxy",
      "XAU/USD": "USD index (negative), safe-haven",
    };
    const correlatedPairs = CORRELATED[pair] || "N/A";
    const sentiment  = signal.direction === "LONG" ? "BULLISH" : "BEARISH";

    try {
      const r = await fetch(`${BRIDGE}/consensus`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument: pairKey,
          direction: signal.direction,
          score: signal.score,
          price: freshEntry.toFixed ? freshEntry.toFixed(5) : String(freshEntry),
          change,
          rsi: signal.rsi,
          reason: signal.reason.join(", "),
          headline: headlineFinal,
          strategy: signal.strategy || "Mean Revert",
          // Risk Guardian (Claude)
          session, sessionQuality, rr: "2.0", heat, newsRisk, atr, atrPips, sl, tp,
          // Pattern Analyst (GPT-4o)
          ema9, ema21, ema50side, closes, regime: regimeData?.regime || "RANGING", momentum,
          // Quantitative Validator (DeepSeek)
          deviation, slDistance, tpDistance, riskAmount, balance: (balance || 100).toFixed(2),
          scoreValid: signal.score >= 65 ? "YES" : "NO", rrValid: "YES", atrValid: atr > 0.0001 ? "YES" : "NO", sizeValid: "YES",
          // Macro Analyst (Gemini)
          spread, spreadLimit, correlatedPairs, sentiment,
          // Xavier market intelligence (staleness-aware)
          xavierKeyRisk: xavierAge > 15 * 60 * 1000 ? null : xavierIntel?.keyRisk || null,
          xavierBestPair: xavierAge > 15 * 60 * 1000 ? null : xavierIntel?.bestPair || null,
          xavierSentiment: xavierAge > 15 * 60 * 1000 ? null : xavierIntel?.sentiment || null,
          xavierBrief: xavierBriefFinal,
          // Data freshness metadata
          newsAgeMin, xavierIntelAgeMin: xavierAgeMin,
          // Retail sentiment (contrarian indicator, server-cached 30 min)
          retailSentiment: await fetch(`${BRIDGE}/sentiment?instruments=${pairKey}`).then(r => r.ok ? r.json().then(d => d.sentiment?.[pairKey] || null) : null).catch(() => null),
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
          { name: "GPT-4o",           verdict: "REJECT", reason: msg },
          { name: "DeepSeek",         verdict: "REJECT", reason: msg },
          { name: "Gemini 2.5 Flash", verdict: "REJECT", reason: msg },
        ],
        voteLog: [`[CLAUDE] REJECT — ${msg} ✗`, `[GPT4] REJECT — ${msg} ✗`, `[DEEPSEEK] REJECT — ${msg} ✗`, `[GEMINI] REJECT — ${msg} ✗`, "Result: 0/4 CONFIRM → BLOCKED"],
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

  const MODEL_PLACEHOLDERS = ["Claude Sonnet", "GPT-4o", "DeepSeek", "Gemini 2.5 Flash"];

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      style={{ background: "#0d1117", borderTop: "1px solid #21262d", borderRight: "1px solid #21262d", borderBottom: "1px solid #21262d", borderLeft: `4px solid ${accentColor}`, borderRadius: 10, padding: "14px", marginTop: 8 }}
    >
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: accentColor }}>
          {loading ? "Consulting Xavier's committee…" : confirms >= 3 ? `${confirms}/${total} CONFIRM — executing` : `${confirms}/${total} REJECT — blocked`}
        </div>
        {!loading && consensus && (
          <span style={{ fontSize: 11, fontWeight: 500, color: accentColor }}>{consensus.confidence} confidence</span>
        )}
      </div>

      {/* Model grid — 2×2, skeleton while loading */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, marginBottom: 10, background: "#21262d", borderRadius: 7, overflow: "hidden", border: "1px solid #21262d" }}>
        {(loading ? MODEL_PLACEHOLDERS.map(name => ({ name, verdict: null, reason: null })) : consensus?.models ?? []).map((model, i) => {
          const isConfirm = model.verdict === "CONFIRM";
          const isReject  = model.verdict === "REJECT";
          const mc        = isConfirm ? "#3fb950" : isReject ? "#f85149" : "#484f58";
          const topAccent = loading ? "#30363d" : isConfirm ? "#238636" : "#f85149";
          return (
            <div key={i} style={{ padding: "9px 12px", background: "#0d1117", borderTop: `2px solid ${topAccent}`, transition: "all 0.3s" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: loading ? "#484f58" : "#e6edf3" }}>{model.name}</span>
                {!loading && (
                  <span style={{ fontSize: 11, fontWeight: 800, color: mc, letterSpacing: "0.04em" }}>{model.verdict}</span>
                )}
              </div>
              <div style={{ fontSize: 10, color: loading ? "#30363d" : "#8b949e", lineHeight: 1.4 }}>
                {loading ? "analyzing…" : model.reason}
              </div>
            </div>
          );
        })}
      </div>

      {/* Vote log toggle */}
      {consensus && !loading && consensus.voteLog && (
        <div style={{ marginBottom: 8 }}>
          <button
            onClick={() => setShowLog(v => !v)}
            style={{ fontSize: 10, background: "none", border: "none", color: "#484f58", cursor: "pointer", padding: "0 0 4px", fontFamily: FONT_MONO, letterSpacing: "0.03em" }}
          >
            {showLog ? "▲ Hide vote log" : "▼ View vote log"}
          </button>
          {showLog && (
            <div style={{ padding: "8px 10px", background: "#0d1117", borderRadius: 6, border: "1px solid #21262d", fontFamily: FONT_MONO, fontSize: 10, lineHeight: 1.8 }}>
              {consensus.voteLog.map((line, i) => {
                const isResult = line.startsWith("Result:");
                const isConfirm = line.includes("] CONFIRM");
                const isReject  = line.includes("] REJECT");
                const color = isResult ? (line.includes("EXECUTE") ? "#3fb950" : "#f85149")
                  : isConfirm ? "#3fb950" : isReject ? "#f85149" : "#8b949e";
                return (
                  <div key={i} style={{ color, borderTop: isResult ? "1px solid #21262d" : "none", paddingTop: isResult ? 4 : 0, marginTop: isResult ? 4 : 0, fontWeight: isResult ? 700 : 400 }}>
                    {line}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

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
const SESSION_GREETINGS = {
  PRIME:  "London-New York overlap's live. Best liquidity of the day — let's find the trades worth taking.",
  LONDON: "London's open. Institutions are moving. EUR and GBP setups are the priority.",
  NY:     "New York session. Dollar pairs are the focus — watch USD strength for direction.",
  TOKYO:  "Tokyo session. JPY pairs and Asian crosses are where the action is.",
  SYDNEY: "Sydney's open. Low liquidity — be selective. AUD and NZD setups only.",
  AVOID:  "Markets are quiet. No major sessions overlapping — patience is the trade right now.",
};

// ─── XAVIER INSTITUTIONAL IDENTITY ───────────────────────────────────────────
const XAVIER_ELITE_IDENTITY = `You are Xavier — an institutional-grade AI trading intelligence built on 40 elite trader principles.

CORE PHILOSOPHY: (1) Probabilistic Thinking — think in expectancy, never certainty. (2) Risk-First — capital preservation is the #1 priority. (3) Asymmetric Payoffs — risk 1R to make 3–5R. (4) Process Over Outcome — judge execution quality, not just results. (5) Patience — A+ setups only; a trade not taken is never a loss.

DECISION FRAMEWORK — before any trade: Edge Identification · Risk-First · Asymmetric Payoff · Session/Strategy Specialization · Regime Awareness · Position Sizing · Multi-Timeframe Context · Information Filtering (news risk within 2h).

WISDOM: Never trade for excitement — trade for edge. One bad trade can erase 10 good ones. Drawdown recovery is harder than prevention.

SELF-AWARENESS: Monte Carlo stress testing: not built. Walk-forward validation: partial. Order flow data: not available. Live account validation: pending.`;

function getXavierWisdom(session, closedTrades = []) {
  const recent = [...closedTrades].reverse();
  let losses = 0, wins = 0;
  for (const t of recent) {
    const pnl = parseFloat(t.realizedPL ?? t.pnl ?? 0);
    if (pnl < 0) { if (wins   > 0) break; losses++; }
    else         { if (losses > 0) break; wins++;   }
  }
  if (losses >= 3) return `Self-Critical Analysis (Principle 30) — ${losses} consecutive losses. Not chasing. Raising my bar, reviewing what the market's telling me. No marginal setups until I see clean structure again.`;
  if (losses >= 1) return `Process Consistency (Principle 7) — that loss stings. But if I followed my process it's a cost of doing business. Same standards, same discipline.`;
  if (wins   >= 5) return `Patience (Principle 5) — ${wins} consecutive wins. Staying disciplined — same process, same standards. The edge doesn't change when you're running hot.`;
  if (wins   >= 1) return `Process Consistency (Principle 7) — ${wins} wins. Worked because I followed the process, not luck. Keeping the same bar.`;
  const WISDOM = {
    PRIME:  "Prime session live — London-New York overlap. Probabilistic Thinking (Principle 1): best liquidity of the day, A+ setups only.",
    LONDON: "London's open. Momentum Awareness (Principle 3): EUR and GBP setups, clean trend structure. Wait for the first 15 minutes to settle.",
    NY:     "New York session. Information Filtering (Principle 33): USD pairs in focus, news-aware on every signal.",
    TOKYO:  "Tokyo session. Volatility Adaptation (Principle 16): range-bound, JPY pairs, mean revert only — lower size.",
    SYDNEY: "Sydney open. Patience (Principle 5): low liquidity. AUD and NZD only, waiting for clean setups.",
    AVOID:  "Dead zone. Patience (Principle 9): elite traders know when NOT to trade. Cash is a valid position.",
  };
  return WISDOM[session] || WISDOM.AVOID;
}

const SESSION_CHIPS = {
  PRIME:  ["Best PRIME setup?", "EUR/USD or GBP/USD?", "Dollar direction?", "Risk on or off?"],
  LONDON: ["Best GBP pair?", "EUR/USD outlook?", "London bias?", "Any breakouts?"],
  NY:     ["USD strength?", "Best NY setup?", "Gold right now?", "Risk sentiment?"],
  TOKYO:  ["JPY pairs?", "AUD/JPY setup?", "Tokyo range?", "Asian session bias?"],
  SYDNEY: ["AUD/USD setup?", "Low risk pairs?", "Sydney volatility?", "Overnight levels?"],
  AVOID:  ["Should I wait?", "Next session?", "Best pair today?", "Market risk today?"],
};

function IntelCard({ label, value, sub, color = "#8b949e", bgColor, borderColor, loading, placeholder }) {
  return (
    <div style={{ background: bgColor || "#161b22", border: `1px solid ${borderColor || "#21262d"}`, borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontSize: 10, color, marginBottom: 5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</div>
      {loading ? (
        <div style={{ fontSize: 11, color: "#484f58" }}>Scanning…</div>
      ) : value ? (
        <>
          <div style={{ fontSize: 14, fontWeight: 700, color, fontFamily: FONT_MONO, lineHeight: 1.2 }}>{value}</div>
          {sub && <div style={{ fontSize: 11, color: "#8b949e", marginTop: 4, lineHeight: 1.5 }}>{sub}</div>}
        </>
      ) : (
        <div style={{ fontSize: 11, color: "#484f58", fontStyle: "italic" }}>{placeholder || "—"}</div>
      )}
    </div>
  );
}

function AIAnalystTab({ headlines, newsLastFetchedAt = 0, prices, trades, balance, currentHeadline, isMobile, session = "AVOID", strategy = "Mean Revert", openTrades = [], signalMap = {}, onIntelUpdate, swingSignals = {}, swingTrades = [], swingEnabled = false, principleWisdom = null, onPrincipleWisdomSeen }) {
  const [briefLoading, setBriefLoading] = useState(false);
  const [metrics, setMetrics] = useState(() => { try { return JSON.parse(localStorage.getItem("xavier_intel")) || null; } catch { return null; } });
  const [question, setQuestion] = useState("");
  const [chatHistory, setChatHistory] = useState(() => { try { return JSON.parse(localStorage.getItem("xavier_chat")) || []; } catch { return []; } });
  const [chatLoading, setChatLoading] = useState(false);
  const [riskAdvice, setRiskAdvice] = useState(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const [queryCount, setQueryCount] = useState(0);
  const [analysisCount, setAnalysisCount] = useState(0);
  const chatEndRef = useRef(null);
  const [retailSentiment, setRetailSentiment] = useState(null);
  const lastChatRef = useRef(null);
  const prevSessionRef = useRef(session);
  const runAnalysisRef = useRef(null);
  const briefLoadingRef = useRef(false);
  const [lastRefreshMs, setLastRefreshMs] = useState(null);
  const [refreshLabel, setRefreshLabel] = useState(null);

  const heat = (openTrades.length * 1.5).toFixed(1);
  const openCount = openTrades.length;
  const signalPairs = Object.entries(signalMap).filter(([, v]) => v).map(([k]) => k).join(", ") || "none";
  const sessionChips = SESSION_CHIPS[session] || SESSION_CHIPS.AVOID;
  const sentimentColor = metrics?.sentiment === "BULLISH" ? "#3fb950" : metrics?.sentiment === "BEARISH" ? "#f85149" : "#d29922";

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, chatLoading]);

  useEffect(() => {
    localStorage.setItem("xavier_chat", JSON.stringify(chatHistory.slice(-50)));
  }, [chatHistory]);

  useEffect(() => {
    if (metrics) localStorage.setItem("xavier_intel", JSON.stringify(metrics));
  }, [metrics]);

  // Inject principle wisdom message into chat when adaptive weights fire
  useEffect(() => {
    if (!principleWisdom) return;
    const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setChatHistory(h => [...h, { role: "ai", text: principleWisdom, ts }]);
    onPrincipleWisdomSeen?.();
  }, [principleWisdom]); // eslint-disable-line

  const buildSystemPrompt = (freshPrices) => {
    const priceSource = freshPrices || prices;
    const liveContext = `LIVE OANDA PRICES RIGHT NOW (as of ${new Date().toISOString()}):\n${Object.entries(priceSource).map(([pair, price]) => `${pair}: ${parseFloat(price).toFixed(priceDecimals(pair))}`).join("\n")}\nThese are real-time prices fetched directly from OANDA. Use these in all your analysis. Ignore any cached or training-data prices.`;

    let swingBlock = "";
    if (swingEnabled) {
      const setups = Object.entries(swingSignals)
        .filter(([, s]) => s && s.score >= 75)
        .map(([pair, s]) => `${pair}: ${s.direction} ${s.score}% — READY — Entry: ${swingFmt(pair, s.entry)} SL: ${swingFmt(pair, s.sl)} TP1: ${swingFmt(pair, s.tp1)}`);

      const activeSwings = swingTrades
        .filter(t => !t.closed)
        .map(t => {
          const daysHeld = Math.floor((Date.now() - t.openedAt) / 86400000);
          const currentPrice = parseFloat(priceSource[t.pair] || t.entry);
          const slDist = Math.abs(t.entry - t.sl);
          const pnlDist = t.direction === "LONG" ? currentPrice - t.entry : t.entry - currentPrice;
          const currentR = slDist > 0 ? (pnlDist / slDist).toFixed(1) : "0.0";
          return `${t.pair} ${t.direction} — opened ${daysHeld}d ago — current R: ${currentR}R`;
        });

      swingBlock = `\n\nKILL SHOT SWING SETUPS:\n${setups.length > 0 ? setups.join("\n") : "No qualifying setups right now."}\n\nACTIVE SWING TRADES:\n${activeSwings.length > 0 ? activeSwings.join("\n") : "No open swing trades."}\n\nYou are aware of both M5 intraday trades AND H4 Kill Shot swing trades. When discussing setups, reference Kill Shot opportunities and active swing positions. These are high-conviction multi-day trades targeting 3–5R.`;
    }

    const openTradesContext = openTrades.length > 0
      ? `\n\nCURRENTLY OPEN TRADES:\n${openTrades.map(t => {
          const tPair = oandaToSlash(t.instrument);
          const tUnits = parseFloat(t.currentUnits);
          const tDir = tUnits > 0 ? "LONG" : "SHORT";
          const tEntry = parseFloat(t.price).toFixed(priceDecimals(tPair));
          const tSL = t.stopLossOrder?.price ? parseFloat(t.stopLossOrder.price).toFixed(priceDecimals(tPair)) : "—";
          const tTP = t.takeProfitOrder?.price ? parseFloat(t.takeProfitOrder.price).toFixed(priceDecimals(tPair)) : "—";
          const tPnl = parseFloat(t.unrealizedPL || 0).toFixed(2);
          const tDur = tradeDuration(t.openTime);
          return `${tPair} ${tDir} @ ${tEntry} | SL: ${tSL} | TP: ${tTP} | P&L: ${tPnl >= 0 ? "+" : ""}$${tPnl} | Duration: ${tDur}`;
        }).join("\n")}\n\nYou are aware of these positions. When asked about open trades or portfolio status, reference these exact positions.`
      : "";

    return `${XAVIER_ELITE_IDENTITY}\n\nCURRENT STATE — Session: ${session} | Strategy: ${strategy} | Heat: ${heat}R | Open trades: ${openCount} | Active signals: ${signalPairs} | Headline: "${currentHeadline}"\n\nTalk like a human — direct, confident, occasionally dry. Contractions always. No bullet points. Max 80 words.\n\n${liveContext}${openTradesContext}${swingBlock}`;
  };

  const runAnalysis = async () => {
    briefLoadingRef.current = true;
    setBriefLoading(true);
    const snap = Object.entries(prices).map(([p, v]) => `${p}: ${v}`).join(", ");
    try {
      const result = await callClaude(
        `Session: ${session} | Strategy: ${strategy} | Heat: ${heat}R | Open positions: ${openCount}\nPrices: ${snap}\nHeadlines: ${headlines.join(" | ")}\n\nRespond in EXACTLY this format, no extra text:\nSENTIMENT: BULLISH or BEARISH or NEUTRAL\nBEST_PAIR: [pair] — [reason, max 12 words]\nKEY_RISK: [risk, max 12 words]\nBRIEF: [2-3 sentence analysis, max 80 words]`,
        `${XAVIER_ELITE_IDENTITY}\n\nCURRENT: Session: ${session} | Strategy: ${strategy}. Speak like a human — direct sentences, contractions always. Follow the output format EXACTLY — no extra text.`,
        600
      );
      const parsed = {};
      result.split("\n").forEach(line => {
        const idx = line.indexOf(":");
        if (idx > 0) { parsed[line.slice(0, idx).trim()] = line.slice(idx + 1).trim(); }
      });
      const newMetrics = {
        sentiment: parsed.SENTIMENT?.toUpperCase() || "NEUTRAL",
        bestPair: parsed.BEST_PAIR || "—",
        keyRisk: parsed.KEY_RISK || "—",
        brief: parsed.BRIEF || result,
      };
      setMetrics(newMetrics);
      onIntelUpdate?.({ ...newMetrics, timestamp: Date.now() });
      setAnalysisCount(c => c + 1);
      const nowMs = Date.now();
      setLastRefreshMs(nowMs);
      setRefreshLabel("just now");
    } catch {
      setMetrics({ sentiment: "NEUTRAL", bestPair: "—", keyRisk: "Check connection", brief: "Market analysis unavailable." });
    }
    briefLoadingRef.current = false;
    setBriefLoading(false);
  };

  const askQuestion = async (override) => {
    const text = (override ?? question).trim();
    if (!text || chatLoading) return;
    lastChatRef.current = Date.now();
    setQuestion("");
    const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setChatHistory(h => [...h, { role: "user", text, ts }]);
    setChatLoading(true);
    let freshPrices = null;
    try {
      const priceResp = await fetch(`${BRIDGE}/prices?instruments=EUR_USD,GBP_USD,USD_JPY,XAU_USD,AUD_USD,NZD_USD,USD_CAD`).then(r => r.json());
      if (priceResp.prices) {
        freshPrices = {};
        priceResp.prices.forEach(p => {
          const pair = p.instrument.replace("_", "/");
          const mid = (parseFloat(p.bids[0].price) + parseFloat(p.asks[0].price)) / 2;
          freshPrices[pair] = mid.toFixed(priceDecimals(pair));
        });
      }
    } catch { /* fall back to props prices */ }
    const snap = Object.entries(freshPrices || prices).map(([p, v]) => `${p}: ${v}`).join(", ");
    const freshNews = Date.now() - newsLastFetchedAt < 30 * 60 * 1000 ? headlines : [];
    const newsCtx = freshNews.length > 0
      ? `Headlines: ${freshNews.slice(0, 3).join(" | ")}`
      : "No recent news available — base analysis on price action only.";
    try {
      const result = await callClaude(
        `Market context: ${snap}\n${newsCtx}\n\nTrader question: ${text}`,
        buildSystemPrompt(freshPrices),
        400
      );
      setChatHistory(h => [...h, { role: "ai", text: result, ts: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
      setQueryCount(c => c + 1);
    } catch {
      setChatHistory(h => [...h, { role: "ai", text: "Can't reach the models right now. Check your API key and make sure the bridge is running.", ts: "" }]);
    }
    setChatLoading(false);
  };

  const getRiskAdvice = async () => {
    setRiskLoading(true);
    try {
      const result = await callClaude(
        `Portfolio: $${balance.toFixed(2)} | Trades: ${openCount} | Heat: ${heat}R | Session: ${session} | News: "${currentHeadline}"\n\nOne risk management action right now. Max 25 words. Start with an action verb.`,
        "You are Xavier, a prop trader serious about risk. Talk like a human — direct, occasionally blunt. Contractions always. Start with an action verb. Max 25 words.",
        150
      );
      setRiskAdvice(result);
      setQueryCount(c => c + 1);
    } catch {
      setRiskAdvice("Can't reach the models right now. Stick to 1.5% per trade and keep heat under 6R.");
    }
    setRiskLoading(false);
  };

  // Keep runAnalysisRef current so intervals always call the latest closure
  runAnalysisRef.current = runAnalysis;

  // Auto-send session greeting and trigger analysis on mount
  useEffect(() => {
    if (chatHistory.length === 0) {
      const storedClosed = (() => { try { return JSON.parse(localStorage.getItem("qb_closed_trades")) || []; } catch { return []; } })();
      const greeting = getXavierWisdom(session, storedClosed);
      const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setChatHistory([{ role: "ai", text: greeting, ts }]);
    }
    if (!metrics) runAnalysisRef.current();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh every 15 minutes — skip if user chatted < 2min ago or already loading
  useEffect(() => {
    const tryRefresh = () => {
      if (briefLoadingRef.current) return;
      if (lastChatRef.current && Date.now() - lastChatRef.current < 2 * 60_000) return;
      runAnalysisRef.current?.();
    };
    const id = setInterval(tryRefresh, 15 * 60_000);
    return () => clearInterval(id);
  }, []);

  // Trigger refresh on session change (Tokyo→London etc)
  useEffect(() => {
    if (session === prevSessionRef.current) return;
    prevSessionRef.current = session;
    if (briefLoadingRef.current) return;
    if (lastChatRef.current && Date.now() - lastChatRef.current < 2 * 60_000) return;
    runAnalysisRef.current?.();
  }, [session]);

  // Update "X min ago" label every 60 seconds
  useEffect(() => {
    if (!lastRefreshMs) return;
    const id = setInterval(() => {
      const mins = Math.floor((Date.now() - lastRefreshMs) / 60_000);
      setRefreshLabel(mins === 0 ? "just now" : `${mins} min ago`);
    }, 60_000);
    return () => clearInterval(id);
  }, [lastRefreshMs]);

  // Retail sentiment polling — every 30 minutes via OANDA position book
  useEffect(() => {
    const fetchSentiment = async () => {
      try {
        const r = await fetch(`${BRIDGE}/sentiment?instruments=EUR_USD,GBP_USD,USD_JPY,AUD_USD,USD_CAD,XAU_USD`);
        if (!r.ok) return;
        const d = await r.json();
        if (d.sentiment) setRetailSentiment(d.sentiment);
      } catch {}
    };
    fetchSentiment();
    const id = setInterval(fetchSentiment, 30 * 60_000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line

  const sessColors = SESSION_BADGE_COLORS[session] || SESSION_BADGE_COLORS.AVOID;
  const heatNum = parseFloat(heat);

  const XavierAvatar = ({ size = 28 }) => (
    <div style={{ width: size, height: size, borderRadius: "50%", background: "linear-gradient(135deg, #1f4e8c 0%, #0d1117 100%)", border: "1px solid #388bfd", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <span style={{ fontSize: size * 0.43, fontWeight: 800, color: "#58a6ff", fontFamily: FONT_MONO }}>X</span>
    </div>
  );

  return (
    <div style={{ padding: isMobile ? "0 10px" : "0 16px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "300px 1fr", gap: 12, alignItems: "start" }}>

        {/* ── LEFT: Xavier Intelligence Panel ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

          {/* Xavier identity card */}
          <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div style={{ position: "relative" }}>
                <XavierAvatar size={42} />
                <motion.div
                  animate={{ scale: [1, 1.5, 1], opacity: [1, 0.4, 1] }}
                  transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
                  style={{ position: "absolute", bottom: 1, right: 1, width: 9, height: 9, borderRadius: "50%", background: "#3fb950", border: "2px solid #0d1117" }}
                />
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#e6edf3", letterSpacing: "0.06em", fontFamily: FONT_MONO }}>XAVIER</div>
                <div style={{ fontSize: 10, color: "#8b949e", marginTop: 1 }}>AI Trading Intelligence · Live</div>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              <div style={{ fontSize: 10, padding: "2px 9px", borderRadius: 12, background: sessColors.bg, border: `1px solid ${sessColors.border}`, color: sessColors.color, fontWeight: 700, letterSpacing: "0.05em" }}>{session}</div>
              <div style={{ fontSize: 10, padding: "2px 9px", borderRadius: 12, background: "rgba(139,92,246,0.1)", border: "1px solid #4b34c4", color: "#8b5cf6", fontWeight: 600 }}>{strategy}</div>
              <div style={{ fontSize: 10, padding: "2px 9px", borderRadius: 12, background: heatNum >= 4 ? "rgba(248,81,73,0.1)" : "rgba(210,153,34,0.08)", border: `1px solid ${heatNum >= 4 ? "#8a1c1c" : "#7a5200"}`, color: heatNum >= 4 ? "#f85149" : "#d29922", fontWeight: 600 }}>{heat}R heat</div>
            </div>
          </div>

          {/* Intel cards */}
          <IntelCard label="Market Sentiment" value={metrics?.sentiment} color={sentimentColor} loading={briefLoading} placeholder="Run analysis →" />
          <IntelCard
            label="Best Opportunity"
            value={metrics?.bestPair?.includes("—") ? metrics.bestPair.split("—")[0].trim() : metrics?.bestPair}
            sub={metrics?.bestPair?.includes("—") ? metrics.bestPair.split("—")[1].trim() : undefined}
            color="#58a6ff"
            loading={briefLoading}
            placeholder="Run analysis →"
          />
          <IntelCard label="Key Risk" value={metrics?.keyRisk} color="#f85149" bgColor="rgba(248,81,73,0.04)" borderColor="rgba(248,81,73,0.18)" loading={briefLoading} placeholder="Run analysis →" />

          {/* Refresh button + timestamp */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={runAnalysis}
              disabled={briefLoading}
              style={{ flex: 1, fontSize: 11, padding: "8px 14px", borderRadius: 8, cursor: briefLoading ? "default" : "pointer", border: "1px solid #21262d", background: "transparent", color: briefLoading ? "#484f58" : "#8b949e", fontFamily: "inherit", transition: "all 0.15s", textAlign: "center" }}
              onMouseEnter={e => { if (!briefLoading) { e.currentTarget.style.borderColor = "#388bfd"; e.currentTarget.style.color = "#58a6ff"; } }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#21262d"; e.currentTarget.style.color = briefLoading ? "#484f58" : "#8b949e"; }}
            >
              {briefLoading ? "Scanning markets…" : "↻  Refresh analysis"}
            </button>
            {refreshLabel && !briefLoading && (
              <span style={{ fontSize: 10, color: "#484f58", whiteSpace: "nowrap" }}>Updated {refreshLabel}</span>
            )}
          </div>

          {/* News feed freshness indicator */}
          {newsLastFetchedAt > 0 && (() => {
            const ageMin = Math.round((Date.now() - newsLastFetchedAt) / 60000);
            const isStale = ageMin >= 30;
            return (
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: isStale ? "#d29922" : "#484f58" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: isStale ? "#d29922" : "#3fb950", flexShrink: 0, display: "inline-block" }} />
                {isStale
                  ? <span>News feed: <span style={{ color: "#d29922", fontWeight: 600 }}>⚠️ stale — {ageMin} min ago</span></span>
                  : <span>News feed: <span style={{ color: "#3fb950" }}>updated {ageMin === 0 ? "just now" : `${ageMin} min ago`}</span></span>
                }
              </div>
            );
          })()}

          {/* Xavier's read */}
          {metrics?.brief && (
            <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 10, padding: "11px 14px" }}>
              <div style={{ fontSize: 10, color: "#484f58", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>Xavier's Read</div>
              <div style={{ fontSize: 12, color: "#c9d1d9", lineHeight: 1.7 }}>{metrics.brief}</div>
            </div>
          )}

          {/* Retail sentiment — contrarian indicator */}
          {retailSentiment && (() => {
            const extremes = Object.entries(retailSentiment)
              .filter(([, v]) => v && v.contrarian !== "NEUTRAL")
              .sort(([, a], [, b]) => Math.max(b.longPct, b.shortPct) - Math.max(a.longPct, a.shortPct))
              .slice(0, 3);
            if (extremes.length === 0) return null;
            return (
              <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 10, padding: "11px 14px" }}>
                <div style={{ fontSize: 10, color: "#484f58", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>Retail Positioning · Contrarian</div>
                {extremes.map(([pair, d]) => {
                  const crowded = d.longPct > d.shortPct ? "LONG" : "SHORT";
                  const contrDir = d.contrarian === "BULLISH" ? "BUY" : "SELL";
                  const contrColor = d.contrarian === "BULLISH" ? "#3fb950" : "#f85149";
                  return (
                    <div key={pair} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: "#8b949e", fontFamily: FONT_MONO }}>{pair.replace("_", "/")}</span>
                      <span style={{ fontSize: 10, color: "#484f58" }}>{d.longPct}% retail {crowded.toLowerCase()} →</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: contrColor }}>{contrDir} signal</span>
                    </div>
                  );
                })}
                <div style={{ fontSize: 10, color: "#484f58", marginTop: 4, lineHeight: 1.5 }}>Retail crowds extremes — institutions fade them.</div>
              </div>
            );
          })()}
        </div>

        {/* ── RIGHT: Conversation Panel ── */}
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Chat header */}
          <div style={{ padding: "11px 16px 10px", borderBottom: "1px solid #21262d", display: "flex", alignItems: "center", gap: 10 }}>
            <XavierAvatar size={30} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#e6edf3" }}>Ask Xavier</div>
              <div style={{ fontSize: 10, color: "#3fb950" }}>● Online · {session} session</div>
            </div>
          </div>

          {/* Session chips */}
          <div className="qb-hscroll" style={{ display: "flex", gap: 6, padding: "8px 16px", borderBottom: "1px solid #161b22", overflowX: "auto" }}>
            {sessionChips.map(chip => (
              <button key={chip} onClick={() => askQuestion(chip)} disabled={chatLoading}
                style={{ fontSize: 10, padding: "3px 10px", borderRadius: 12, cursor: chatLoading ? "default" : "pointer", border: "1px solid #21262d", background: "transparent", color: "#8b949e", fontFamily: "inherit", transition: "all 0.15s", opacity: chatLoading ? 0.4 : 1, whiteSpace: "nowrap", flexShrink: 0 }}
                onMouseEnter={e => { if (!chatLoading) { e.currentTarget.style.borderColor = "#388bfd"; e.currentTarget.style.color = "#58a6ff"; } }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "#21262d"; e.currentTarget.style.color = "#8b949e"; }}
              >{chip}</button>
            ))}
          </div>

          {/* Messages */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12, height: isMobile ? 300 : 360, overflowY: "auto", padding: "14px 16px" }}>
            {chatHistory.map((m, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
                {m.role === "ai" && (
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 8, maxWidth: "88%" }}>
                    <XavierAvatar size={26} />
                    <div>
                      <div style={{ fontSize: 10, color: "#484f58", marginBottom: 3 }}>Xavier{m.ts ? ` · ${m.ts}` : ""}</div>
                      <div style={{ padding: "9px 13px", borderRadius: 12, borderBottomLeftRadius: 4, fontSize: 12, lineHeight: 1.65, background: "#161b22", border: "1px solid #21262d", color: "#c9d1d9" }}
                        dangerouslySetInnerHTML={{ __html: m.text.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>") }}
                      />
                    </div>
                  </div>
                )}
                {m.role === "user" && (
                  <div style={{ maxWidth: "75%" }}>
                    <div style={{ fontSize: 10, color: "#484f58", marginBottom: 3, textAlign: "right" }}>You · {m.ts}</div>
                    <div style={{ padding: "9px 13px", borderRadius: 12, borderBottomRightRadius: 4, fontSize: 12, lineHeight: 1.65, background: "#132f4c", border: "1px solid #1f4e8c", color: "#a5d6ff" }}>{m.text}</div>
                  </div>
                )}
              </div>
            ))}
            {chatLoading && (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                <XavierAvatar size={26} />
                <div>
                  <div style={{ fontSize: 10, color: "#484f58", marginBottom: 3 }}>Xavier</div>
                  <TypingIndicator />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Inline risk read */}
          {riskAdvice && (
            <div style={{ margin: "0 16px 10px", background: "rgba(248,81,73,0.05)", border: "1px solid rgba(248,81,73,0.2)", borderRadius: 8, padding: "8px 12px", fontSize: 11, color: "#c9d1d9", lineHeight: 1.65 }}>
              <span style={{ fontSize: 10, color: "#f85149", fontWeight: 700, marginRight: 7, letterSpacing: "0.05em" }}>RISK READ</span>
              {riskAdvice}
            </div>
          )}

          {/* Input row */}
          <div style={{ padding: "10px 16px 12px", borderTop: "1px solid #21262d", display: "flex", gap: 7, alignItems: "center" }}>
            <button title="Voice input (coming soon)" disabled
              style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #21262d", background: "transparent", color: "#30363d", cursor: "not-allowed", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}
            >🎤</button>
            <input
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => e.key === "Enter" && askQuestion()}
              placeholder="Ask Xavier — pairs, setups, risk, anything…"
              style={{ flex: 1, fontSize: 11, padding: "8px 12px", borderRadius: 8, border: "1px solid #21262d", background: "#161b22", color: "#e6edf3", outline: "none", fontFamily: "inherit" }}
            />
            <button onClick={getRiskAdvice} disabled={riskLoading}
              style={{ padding: "8px 10px", borderRadius: 8, fontSize: 10, cursor: riskLoading ? "default" : "pointer", background: "rgba(248,81,73,0.08)", color: riskLoading ? "#484f58" : "#f85149", border: "1px solid rgba(248,81,73,0.25)", fontFamily: "inherit", whiteSpace: "nowrap", flexShrink: 0, fontWeight: 600 }}
            >{riskLoading ? "…" : "Risk Read"}</button>
            <button onClick={() => askQuestion()} disabled={chatLoading || !question.trim()}
              style={{ padding: "8px 14px", borderRadius: 8, fontSize: 11, cursor: chatLoading || !question.trim() ? "default" : "pointer", background: chatLoading || !question.trim() ? "#161b22" : "#132f4c", color: chatLoading || !question.trim() ? "#484f58" : "#58a6ff", border: "1px solid #21262d", fontWeight: 700, fontFamily: "inherit", flexShrink: 0 }}
            >↗</button>
          </div>
        </div>
      </div>

      {/* Session stats strip */}
      <div style={{ display: "flex", gap: 16, alignItems: "center", padding: "7px 14px", background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, flexWrap: "wrap" }}>
        {[
          { label: "Queries", value: String(queryCount) },
          { label: "Analyses", value: String(analysisCount) },
          { label: "Est. cost", value: `~$${(queryCount * 0.005 + analysisCount * 0.008).toFixed(3)}` },
          { label: "Open Trades", value: String(openCount) },
          { label: "Portfolio Heat", value: `${heat}R` },
        ].map(({ label, value }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 10, color: "#484f58" }}>{label}</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: "#8b949e", fontFamily: FONT_MONO }}>{value}</span>
          </div>
        ))}
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

// ─── CHART CLOCK ─────────────────────────────────────────────────────────────
function ChartClock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setT(new Date()), 1000); return () => clearInterval(id); }, []);
  const utcH = String(t.getUTCHours()).padStart(2, "0");
  const utcM = String(t.getUTCMinutes()).padStart(2, "0");
  const mdtH = String((t.getUTCHours() - 6 + 24) % 24).padStart(2, "0");
  const mdtM = String(t.getUTCMinutes()).padStart(2, "0");
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 1 }}>UTC · Calgary</div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: "#8b949e", letterSpacing: "0.5px" }}>
        {utcH}:{utcM} · <span style={{ color: "#58a6ff" }}>{mdtH}:{mdtM}</span>
      </div>
    </div>
  );
}

const SESSION_BADGE_COLORS = {
  PRIME:  { color: "#3fb950", bg: "rgba(63,185,80,0.1)",   border: "#238636" },
  LONDON: { color: "#58a6ff", bg: "rgba(88,166,255,0.1)",  border: "#1f4b8e" },
  NY:     { color: "#d29922", bg: "rgba(210,153,34,0.1)",  border: "#7a5200" },
  TOKYO:  { color: "#8b5cf6", bg: "rgba(139,92,246,0.1)",  border: "#4b34c4" },
  SYDNEY: { color: "#0ea5e9", bg: "rgba(14,165,233,0.1)",  border: "#0a5c8e" },
  AVOID:  { color: "#484f58", bg: "rgba(72,79,88,0.1)",    border: "#30363d" },
};

// ─── PAIR ROW WITH AI CONFIRM ─────────────────────────────────────────────────
const MOBILE_ACTION_ROW_H = 62;

function PairRow({ pair, basePrice, strategy, onTrade, currentHeadline, onSignalUpdate, onRegimeUpdate, onRejection, onClose, openTrades, marketOpen, isMobile, balance, xavierIntel, newsLastFetchedAt = 0 }) {
  const { price: simPrice, history: simHistory } = usePriceSimulator(basePrice);
  const { price: oandaPrice, history: oandaHistory, isReal } = useOandaPrice(pair);

  // Real OANDA data takes priority; simulator is fallback only
  const price   = (isReal && oandaPrice != null) ? oandaPrice   : simPrice;
  const history = (isReal && oandaHistory.length >= 20) ? oandaHistory : simHistory;

  // Block signals until ≥20 real candles are loaded
  const rawSignal = isReal ? generateSignal(history, strategy, pair) : null;
  const signal = isMobile ? useStableSignal(rawSignal) : rawSignal;
  const prev = history[history.length - 2] ?? price;
  const [showAI, setShowAI] = useState(false);
  const [gkReject, setGkReject] = useState(null);
  const [chartExpanded, setChartExpanded] = useState(false);
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
  const priceRef = useRef(price);
  const historyRef = useRef(history);
  priceRef.current = price;
  historyRef.current = history;
  const prevSignalKey = useRef(null);
  useEffect(() => {
    if (signalKey === prevSignalKey.current) return;
    prevSignalKey.current = signalKey;
    onSignalUpdate?.(pair, signal
      ? { signal, price: priceRef.current, history: historyRef.current.slice(-50) }
      : null);
  }, [signalKey, pair, onSignalUpdate]);

  useEffect(() => { if (showAI) setChartExpanded(true); }, [showAI]);

  const chartPip       = PIP_SIZE[pair] || 0.0001;
  const chartAtr       = regimeData?.atr5 || 0.001;
  const chartSLVal     = signal ? (signal.direction === "LONG" ? price - chartAtr * 1.5 : price + chartAtr * 1.5) : null;
  const chartTPVal     = signal ? (signal.direction === "LONG" ? price + chartAtr * 3 : price - chartAtr * 3) : null;
  const chartSLPips    = (chartAtr * 1.5 / chartPip).toFixed(1);
  const chartTPPips    = (chartAtr * 3 / chartPip).toFixed(1);
  const chartPairKey   = pair.replace("/", "_");
  const chartSpreadPips = TYPICAL_SPREAD_PIPS[chartPairKey] || (chartAtr / chartPip * 0.12);
  const chartSession   = getCurrentSession();
  const chartSpreadLimit = PAIR_SPREAD_LIMITS[chartPairKey]?.[chartSession] ?? (chartSpreadPips * 2);
  const chartSpreadOk  = chartSpreadPips <= chartSpreadLimit;
  const chartSessionOk = ["PRIME", "LONDON", "NY"].includes(chartSession);
  const openTrade      = openTrades?.find(t => t.instrument === chartPairKey);
  const chartRiskAmt   = ((balance || 100) * 0.015).toFixed(2);
  const sessStyle      = SESSION_BADGE_COLORS[chartSession] || SESSION_BADGE_COLORS.AVOID;
  // Volatility normalizing countdown — visible when spike is settling
  const volNormMins = (() => {
    if (history.length < 21) return null;
    const bars = history.slice(-21);
    const tr   = bars.slice(1).map((v, i) => Math.abs(v - bars[i]));
    const atr20v  = tr.reduce((a, b) => a + b, 0) / tr.length || 0.00001;
    const atr5now  = tr.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const atr5prev = tr.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
    if (atr5prev <= atr20v * 2.0 || atr5now >= atr5prev * 0.85) return null;
    const hotBars = tr.slice(-5).filter(v => v > atr20v * 1.5).length;
    return hotBars * 5; // each hot bar takes ~5 min to roll out of 5-bar ATR
  })();
  const nextSession    = (() => {
    const nowM = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    const defs = [
      { name: "Tokyo",    startH: 4,  color: "#F97316" },
      { name: "London",   startH: 8,  color: "#8B5CF6" },
      { name: "Prime",    startH: 13, color: "#3fb950" },
      { name: "New York", startH: 17, color: "#1D9E75" },
      { name: "Sydney",   startH: 22, color: "#0EA5E9" },
    ];
    let best = null, minD = Infinity;
    for (const s of defs) {
      let d = s.startH * 60 - nowM;
      if (d <= 0) d += 1440;
      if (d < minD) { minD = d; best = { ...s, mins: d }; }
    }
    if (!best) return { name: "—", countdown: "--h --m", color: "#484f58" };
    return { ...best, countdown: `${Math.floor(best.mins / 60)}h ${String(best.mins % 60).padStart(2, "0")}m` };
  })();

  const handleAICheck = () => {
    if (!signal) return;
    const gk = runGatekeepers(history, signal, openTrades, pair, strategy);
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
            regimeData={regimeData} session={getCurrentSession()} openTrades={openTrades} balance={balance}
            xavierIntel={xavierIntel} newsLastFetchedAt={newsLastFetchedAt}
            onConfirmed={(verdict) => { onTrade(pair, signal, price, { ...verdict, atr: regimeData.atr5 }); setShowAI(false); }}
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
      {/* ── Compact table row ── */}
      <div
        style={{ display: "grid", gridTemplateColumns: TABLE_COLS, gap: TABLE_GAP, alignItems: "center", padding: TABLE_PAD, borderBottom: (chartExpanded || showAI || gkReject) ? "none" : "1px solid #21262d", minHeight: 52, fontSize: 12, transition: "background 0.15s", width: "100%", boxSizing: "border-box" }}
        onMouseEnter={e => e.currentTarget.style.background = "#1c2333"}
        onMouseLeave={e => e.currentTarget.style.background = ""}
      >
        {/* Pair + regime + expand toggle */}
        <div
          style={{ display: "flex", flexDirection: "column", gap: 3, cursor: "pointer", userSelect: "none" }}
          onClick={() => setChartExpanded(v => !v)}
          title={chartExpanded ? "Collapse chart" : "Expand chart"}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontWeight: 700, color: "#e6edf3", fontSize: 14, letterSpacing: "0.3px" }}>{pair}</span>
            <span style={{ fontSize: 9, color: chartExpanded ? "#58a6ff" : "#484f58", transition: "color 0.15s", transform: chartExpanded ? "rotate(180deg)" : "rotate(0deg)", display: "inline-block", transition: "transform 0.2s, color 0.15s" }}>▼</span>
          </div>
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

      {/* ── Volatility normalizing banner ── */}
      {volNormMins !== null && (
        <div style={{ padding: "3px 14px", background: "#0d1117", borderBottom: "1px solid #21262d", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#d29922", flexShrink: 0, display: "inline-block" }} />
          <span style={{ fontSize: 10, color: "#d29922", fontFamily: FONT_MONO }}>
            Volatility normalizing — est. clear in {volNormMins > 0 ? `${volNormMins}m` : "<5m"}
          </span>
        </div>
      )}

      {/* ── Expandable candlestick chart panel ── */}
      <AnimatePresence>
        {chartExpanded && (
          <motion.div
            key="candle-panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "hidden", borderBottom: gkReject ? "none" : "1px solid #21262d" }}
          >
            {/* ── Chart header ── */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px 6px", background: "#0d1117", borderBottom: "1px solid #21262d" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 700, color: "#e6edf3", fontSize: 13, fontFamily: FONT_MONO }}>{pair}</span>
                <AnimatedNumber value={price} decimals={decimals} style={{ ...priceStyle, fontSize: 13 }} />
                <span style={{ fontSize: 10, color: changeColor, fontFamily: FONT_MONO }}>{changeDisplay}</span>
              </div>
              <ChartClock />
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <RegimeBadge regime={regimeData.regime} />
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.4px", padding: "1px 5px", borderRadius: 3, background: sessStyle.bg, color: sessStyle.color, border: `1px solid ${sessStyle.border}` }}>{chartSession}</span>
                <span style={{ fontSize: 9, color: "#484f58", fontFamily: FONT_MONO, marginLeft: 4 }}>M15</span>
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}><span style={{ width: 16, height: 1.5, background: "#58a6ff", display: "inline-block" }} /><span style={{ fontSize: 9, color: "#58a6ff" }}>EMA9</span></span>
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}><span style={{ width: 16, height: 1.5, background: "#d29922", display: "inline-block" }} /><span style={{ fontSize: 9, color: "#d29922" }}>EMA21</span></span>
                {signal && <span style={{ display: "flex", alignItems: "center", gap: 3 }}><span style={{ width: 14, height: 0, borderTop: "1px dashed #58a6ff", display: "inline-block" }} /><span style={{ fontSize: 9, color: "#8b949e" }}>SL/TP</span></span>}
                <button
                  onClick={() => { setChartExpanded(false); setShowAI(false); }}
                  style={{ marginLeft: 8, width: 20, height: 20, borderRadius: 4, border: "1px solid #30363d", background: "none", color: "#484f58", cursor: "pointer", fontSize: 13, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                  onMouseEnter={e => { e.currentTarget.style.background = "#21262d"; e.currentTarget.style.color = "#e6edf3"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#484f58"; }}
                  title="Close chart"
                >×</button>
              </div>
            </div>

            {/* ── CandleChart — unchanged ── */}
            <CandleChart pair={pair} history={history} signal={signal} />

            {/* ── Chart footer ── */}
            <div style={{ display: "flex", gap: 1, background: "#21262d" }}>
              {[
                { label: "SPREAD",       value: `${chartSpreadPips.toFixed(1)}p`,                 color: chartSpreadOk ? "#3fb950" : "#f85149" },
                { label: "SESSION",      value: chartSession,                                       color: chartSessionOk ? "#3fb950" : "#d29922" },
                { label: "NEXT SESSION", value: `${nextSession.name} in ${nextSession.countdown}`, color: nextSession.color },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ flex: 1, padding: "5px 10px", background: "#0d1117", textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color, fontFamily: FONT_MONO, whiteSpace: "nowrap" }}>{value}</div>
                </div>
              ))}
            </div>

            {/* ── Execution panel — 3 columns, signal-gated ── */}
            {signal && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", borderTop: "1px solid #21262d", background: "#21262d", gap: 1 }}>
                {/* Signal Intel */}
                <div style={{ background: "#0d1117", padding: "12px 14px" }}>
                  <div style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>Signal Intel</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: signal.direction === "LONG" ? "#3fb950" : "#f85149" }}>{signal.direction}</span>
                    <span style={{ fontSize: 10, color: "#8b949e" }}>{signal.score}% confidence</span>
                  </div>
                  <div style={{ fontSize: 10, color: "#484f58", marginBottom: 5, fontFamily: FONT_MONO }}>{signal.strategy || "Mean Revert"}</div>
                  <div style={{ height: 3, background: "#21262d", borderRadius: 2, overflow: "hidden", marginBottom: 8 }}>
                    <div style={{ height: "100%", width: `${signal.score}%`, background: signal.score >= 75 ? "#3fb950" : signal.score >= 65 ? "#d29922" : "#f85149", borderRadius: 2 }} />
                  </div>
                  {signal.reason?.slice(0, 3).map((r, i) => (
                    <div key={i} style={{ fontSize: 10, color: "#8b949e", marginBottom: 2 }}>· {r}</div>
                  ))}
                </div>

                {/* Risk Details */}
                <div style={{ background: "#0d1117", padding: "12px 14px" }}>
                  <div style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>Risk Details</div>
                  {[
                    { label: "Entry", value: price.toFixed(decimals),                                  color: "#58a6ff" },
                    { label: "SL",    value: `${chartSLVal?.toFixed(decimals)} (${chartSLPips}p)`,    color: "#f85149" },
                    { label: "TP",    value: `${chartTPVal?.toFixed(decimals)} (${chartTPPips}p)`,    color: "#3fb950" },
                    { label: "R:R",   value: "1:2.0",                                                  color: "#3fb950" },
                    { label: "Risk",  value: `$${chartRiskAmt} (1.5%)`,                               color: "#8b949e" },
                    { label: "Units", value: signal.direction === "LONG" ? "1 000 L" : "1 000 S",     color: "#8b949e" },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                      <span style={{ fontSize: 10, color: "#484f58" }}>{label}</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color, fontFamily: FONT_MONO }}>{value}</span>
                    </div>
                  ))}
                </div>

                {/* Execution */}
                <div style={{ background: "#0d1117", padding: "12px 14px" }}>
                  <div style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>Execution</div>
                  {[
                    { label: "Score ≥ 65%", ok: signal.score >= 65 },
                    { label: "R:R ≥ 2.0",   ok: true },
                    { label: "Session OK",   ok: chartSessionOk },
                    { label: "Spread OK",    ok: chartSpreadOk },
                  ].map(({ label, ok }) => (
                    <div key={label} style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
                      <span style={{ fontSize: 10, color: ok ? "#3fb950" : "#f85149", fontWeight: 700 }}>{ok ? "✓" : "✗"}</span>
                      <span style={{ fontSize: 10, color: ok ? "#8b949e" : "#484f58" }}>{label}</span>
                    </div>
                  ))}
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                    <button
                      onClick={handleAICheck}
                      style={{ width: "100%", padding: "8px 0", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer", background: showAI ? "#161b22" : "#132f4c", color: showAI ? "#8b949e" : "#58a6ff", border: `1px solid ${showAI ? "#30363d" : "#388bfd"}`, fontFamily: "inherit" }}
                    >
                      {showAI ? "Hide AI Check" : "AI Check ↗"}
                    </button>
                    {openTrade && (
                      <button
                        onClick={() => onClose?.(openTrade.id, pair)}
                        style={{ width: "100%", padding: "8px 0", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer", background: "rgba(248,81,73,0.08)", color: "#f85149", border: "1px solid rgba(248,81,73,0.3)", fontFamily: "inherit" }}
                      >
                        Close Position ×
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── AI consensus panel ── */}
            {aiPanel}
          </motion.div>
        )}
      </AnimatePresence>

      {rejectPanel}
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
              style={{ padding: "10px 12px", borderRadius: 10, fontSize: 12, background: "#161b22", borderTop: "1px solid #21262d", borderRight: "1px solid #21262d", borderBottom: "1px solid #21262d", borderLeft: `3px solid ${t.dir === "LONG" ? "#3fb950" : "#f85149"}` }}
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
          <div key={i} style={{ padding: "8px 10px", borderRadius: 7, background: "#0d1117", borderTop: "1px solid #21262d", borderRight: "1px solid #21262d", borderBottom: "1px solid #21262d", borderLeft: "3px solid rgba(248,81,73,0.5)" }}>
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

// ─── TRADE MANAGEMENT LOG ─────────────────────────────────────────────────────
const TME_ACTION_STYLES = {
  BREAKEVEN: { color: "#58a6ff", border: "rgba(88,166,255,0.4)",  icon: "⟳" },
  PARTIAL:   { color: "#3fb950", border: "rgba(63,185,80,0.4)",   icon: "½" },
  TRAILING:  { color: "#1D9E75", border: "rgba(29,158,117,0.4)",  icon: "↑" },
  "TIME EXIT": { color: "#F97316", border: "rgba(249,115,22,0.4)", icon: "⏱" },
  SESSION:   { color: "#d29922", border: "rgba(210,153,34,0.4)",  icon: "⚠" },
};

function TradeManagementLog({ alerts, onDismiss, isMobile }) {
  if (alerts.length === 0) return null;
  return (
    <div style={isMobile
      ? { background: "#0d1117", padding: "12px", marginTop: 4 }
      : { background: "#161b22", border: "1px solid #21262d", borderRadius: 10, padding: "12px 14px", margin: "12px 16px 0" }
    }>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.5px" }}>Trade Management</span>
        <span style={{ fontSize: 11, background: "rgba(88,166,255,0.1)", color: "#58a6ff", border: "1px solid rgba(88,166,255,0.3)", padding: "1px 8px", borderRadius: 10 }}>{alerts.length} actions</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {alerts.slice(0, 8).map(a => {
          const s = TME_ACTION_STYLES[a.action] || { color: "#8b949e", border: "rgba(139,148,158,0.4)", icon: "·" };
          return (
            <div key={a.id} style={{ padding: "7px 10px", borderRadius: 7, background: "#0d1117", borderTop: "1px solid #21262d", borderRight: "1px solid #21262d", borderBottom: "1px solid #21262d", borderLeft: `3px solid ${s.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: s.color }}>{s.icon}</span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 11, fontWeight: 600, color: "#e6edf3", flexShrink: 0 }}>{a.pair}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: s.color, flexShrink: 0 }}>{a.action}</span>
                <span style={{ fontSize: 10, color: "#8b949e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.msg}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <span style={{ fontSize: 10, color: "#484f58", fontFamily: FONT_MONO }}>{a.timestamp}</span>
                <button onClick={() => onDismiss(a.id)} style={{ fontSize: 10, color: "#484f58", background: "none", border: "none", cursor: "pointer", padding: "0 2px", lineHeight: 1 }}>×</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── SOUND ENGINE ─────────────────────────────────────────────────────────────
let audioCtxReady = false;
document.addEventListener('click', () => { audioCtxReady = true; }, { once: true });

function playSound(type, enabled) {
  if (!enabled || !audioCtxReady) return;
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t = ctx.currentTime;
    switch (type) {
      case 'trade_open':
        osc.frequency.setValueAtTime(440, t);
        osc.frequency.setValueAtTime(880, t + 0.1);
        gain.gain.setValueAtTime(0.3, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.4);
        osc.start(t); osc.stop(t + 0.4);
        break;
      case 'take_profit':
        osc.frequency.setValueAtTime(523, t);
        osc.frequency.setValueAtTime(659, t + 0.1);
        osc.frequency.setValueAtTime(784, t + 0.2);
        gain.gain.setValueAtTime(0.3, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.5);
        osc.start(t); osc.stop(t + 0.5);
        break;
      case 'stop_loss':
        osc.frequency.setValueAtTime(440, t);
        osc.frequency.setValueAtTime(220, t + 0.2);
        gain.gain.setValueAtTime(0.3, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.5);
        osc.start(t); osc.stop(t + 0.5);
        break;
      case 'signal':
        osc.frequency.setValueAtTime(660, t);
        gain.gain.setValueAtTime(0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.2);
        osc.start(t); osc.stop(t + 0.2);
        break;
      case 'xavier':
        osc.frequency.setValueAtTime(528, t);
        gain.gain.setValueAtTime(0.1, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.3);
        osc.start(t); osc.stop(t + 0.3);
        break;
      default: break;
    }
  } catch { /* AudioContext unavailable in this context */ }
}

function buildToast(type, data) {
  const dec = (p) => p?.includes("JPY") ? 3 : (p?.includes("XAU") || p?.includes("SPX") || p?.includes("NAS") || p?.includes("JP2") || p?.includes("UK1") || p?.includes("AU2") || p?.includes("BCO") || p?.includes("WTI")) ? 2 : 5;
  switch (type) {
    case 'trade_open': {
      const fp  = parseFloat(data.fillPrice || 0);
      const atr = parseFloat(data.atr || 0);
      const d   = dec(data.pair);
      const sl  = data.direction === "LONG" ? fp - atr * 1.5 : fp + atr * 1.5;
      const tp  = data.direction === "LONG" ? fp + atr * 3   : fp - atr * 3;
      return {
        borderColor: "#3fb950",
        title: `${data.direction} ${data.pair} @ ${fp.toFixed(d)}`,
        body:  `Score: ${data.score}% · 1000 units\nSL: ${sl.toFixed(d)} · TP: ${tp.toFixed(d)}`,
      };
    }
    case 'take_profit': {
      const d = dec(data.pair);
      return {
        borderColor: "#d29922",
        title: `${data.pair} CLOSED +${data.rMultiple != null ? Math.abs(data.rMultiple).toFixed(1) : "?"}R`,
        body:  `Entry: ${parseFloat(data.entryPrice || 0).toFixed(d)} → ${parseFloat(data.closePrice || 0).toFixed(d)}\nProfit: +$${parseFloat(data.realizedPL || 0).toFixed(2)}`,
      };
    }
    case 'stop_loss': {
      const d = dec(data.pair);
      return {
        borderColor: "#f85149",
        title: `${data.pair} CLOSED ${data.rMultiple != null ? data.rMultiple.toFixed(1) : "?"}R`,
        body:  `Entry: ${parseFloat(data.entryPrice || 0).toFixed(d)} → ${parseFloat(data.closePrice || 0).toFixed(d)}\nLoss: $${parseFloat(data.realizedPL || 0).toFixed(2)}`,
      };
    }
    case 'signal':
      return {
        borderColor: "#58a6ff",
        title: `${data.pair} signal ${data.score}%`,
        body:  `${data.strategy || ""} ${data.direction || ""} · ${data.session || ""} session`,
      };
    case 'xavier':
      return { borderColor: "#8b5cf6", title: "Xavier", body: data.message || "" };
    default:
      return { borderColor: "#484f58", title: "Notification", body: "" };
  }
}

function ToastContainer({ toasts, onDismiss }) {
  return (
    <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 9999, display: "flex", flexDirection: "column-reverse", gap: 8, maxWidth: 340, pointerEvents: "none" }}>
      <AnimatePresence>
        {toasts.map(toast => (
          <motion.div key={toast.id}
            initial={{ x: 64, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 64, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            style={{ pointerEvents: "auto" }}
          >
            <div onClick={() => onDismiss(toast.id)} style={{
              background: "#161b22", borderRadius: 8, padding: "10px 14px",
              border: `1px solid ${toast.borderColor}30`, borderLeft: `3px solid ${toast.borderColor}`,
              cursor: "pointer", boxShadow: "0 6px 24px rgba(0,0,0,0.5)", userSelect: "none",
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#e6edf3", lineHeight: 1.4 }}>{toast.title}</div>
              {toast.body && (
                <div style={{ fontSize: 10, color: "#8b949e", marginTop: 4, lineHeight: 1.6, whiteSpace: "pre-line" }}>{toast.body}</div>
              )}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ─── KILL SHOT — SWING ENGINE ─────────────────────────────────────────────────
const KILL_SHOT_PAIRS = ["XAU/USD", "GBP/USD", "EUR/USD", "USD/JPY", "NAS100/USD", "BCO/USD"];
// Phase 2/3 instruments — show in panel but flag as not yet validated for auto-execution
const PHASE2_PAIRS = new Set(["NAS100/USD", "BCO/USD"]);

// Allowed sessions per instrument — forex entries omitted (always visible)
const INSTRUMENT_HOME_SESSIONS = {
  NAS100_USD: ['NY', 'SYDNEY'],
  JP225_USD:  ['TOKYO'],
  UK100_GBP:  ['LONDON', 'PRIME'],
  AU200_AUD:  ['SYDNEY', 'TOKYO'],
  SPX500_USD: ['NY'],
  XAG_USD:    ['LONDON', 'PRIME', 'NY'],
  BCO_USD:    ['LONDON', 'PRIME', 'NY'],
  WTICO_USD:  ['NY', 'PRIME'],
};

function _ema(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let e = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) e = prices[i] * k + e * (1 - k);
  return e;
}
function _rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function _atr(candles, period = 14) {
  if (candles.length < 2) return null;
  const trs = candles.slice(1).map((c, i) => {
    const h = parseFloat(c.mid?.h ?? c.h), lo = parseFloat(c.mid?.l ?? c.l), pc = parseFloat(candles[i].mid?.c ?? candles[i].c);
    return Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc));
  });
  if (trs.length < period) return trs.reduce((a, b) => a + b, 0) / trs.length;
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

const MIN_SWING_STOP = {
  EUR_USD: 0.0025, GBP_USD: 0.0025, USD_JPY: 0.25,
  AUD_USD: 0.0025, USD_CAD: 0.0025, EUR_GBP: 0.0020,
  NZD_USD: 0.0025,
  XAU_USD: 2.00,   XAG_USD: 0.15,
  BCO_USD: 0.80,   WTICO_USD: 0.80,
  NAS100_USD: 50,  JP225_USD: 150, SPX500_USD: 15,
  UK100_GBP: 20,   AU200_AUD: 20,
};

function generateSwingSignal(h4Candles, weeklyCandles, pairKey = "") {
  if (!h4Candles || h4Candles.length < 55) return null;
  const closes = h4Candles.map(c => parseFloat(c.mid?.c ?? c.c));
  const last    = closes[closes.length - 1];
  const ema21   = _ema(closes, 21);
  const ema50   = _ema(closes, 50);
  const atr     = _atr(h4Candles, 14);
  const rsi     = _rsi(closes.slice(-30), 14);
  if (!ema21 || !ema50 || !atr || last <= 0) return null;

  let score = 0;
  const bd = {};

  // 1. ATR EXPANSION (10 pts) — trade needs volatility to carry
  const atrPct = atr / last;
  const atrPts = atrPct > 0.0003 ? 10 : atrPct > 0.0001 ? 5 : 0;
  score += atrPts; bd.atr = atrPts;

  // 2. TREND STRUCTURE (30 pts)
  const isBull = ema21 > ema50;
  const last3c  = closes.slice(-3);
  let trendPts = 0, direction = null;
  if (isBull || !isBull) {
    direction = isBull ? "LONG" : "SHORT";
    trendPts += 20;
    const confirming = isBull ? last3c[2] > last3c[0] : last3c[2] < last3c[0];
    if (confirming) trendPts += 10;
  }
  score += trendPts; bd.trend = trendPts;

  // 3. EMA21 PULLBACK (25 pts)
  const pct21 = Math.abs(last - ema21) / ema21;
  const nearEMA = isBull ? last <= ema21 * 1.006 : last >= ema21 * 0.994;
  let pbPts = 0;
  if (nearEMA) { pbPts = pct21 <= 0.003 ? 25 : pct21 <= 0.005 ? 15 : 0; }
  score += pbPts; bd.pullback = pbPts;

  // 4. MOMENTUM CONFIRMATION (20 pts)
  let momPts = 0;
  if (rsi !== null && rsi >= 40 && rsi <= 60) momPts += 10;
  const momReturn = isBull ? last3c[1] > last3c[0] && last3c[2] > last3c[1] : last3c[1] < last3c[0] && last3c[2] < last3c[1];
  if (momReturn) momPts += 10;
  score += momPts; bd.momentum = momPts;

  // 5. WEEKLY BIAS (15 pts)
  let weekPts = 0;
  if (weeklyCandles?.length >= 3) {
    const wc = weeklyCandles.map(c => parseFloat(c.mid?.c ?? c.c));
    const weekBull = wc[wc.length - 1] > wc[wc.length - 3];
    if ((isBull && weekBull) || (!isBull && !weekBull)) weekPts = 15;
  }
  score += weekPts; bd.weekly = weekPts;

  // Stop: ema50 buffer + ATR cushion, enforced minimum for H4 swing
  const ema50Distance = Math.abs(last - ema50);
  const atrStop  = ema50Distance + (atr * 0.5);
  const minStop  = MIN_SWING_STOP[pairKey] || 0.0025;
  const stopDistance = Math.max(atrStop, minStop);
  const sl  = isBull ? last - stopDistance : last + stopDistance;

  // TPs always based on actual risk distance (entry → SL)
  const riskDistance = Math.abs(last - sl);
  const tp1 = isBull ? last + riskDistance * 1.5 : last - riskDistance * 1.5;
  const tp2 = isBull ? last + riskDistance * 3.0 : last - riskDistance * 3.0;
  const tp3 = isBull ? last + riskDistance * 5.0 : last - riskDistance * 5.0;

  // Position sizing: 1.5% of $100k account risk / dollar risk per unit
  const accountRisk = 100000 * 0.015;
  const rawUnits = stopDistance > 0 ? Math.floor(accountRisk / stopDistance) : 1000;
  const swingUnits = Math.min(rawUnits, 1000);

  return {
    score: Math.round(score), direction,
    entry: last, sl, tp1, tp2, tp3,
    ema21, ema50, atr, rsi,
    swingUnits,
    breakdown: bd,
    label: score >= 85 ? "PERFECT" : score >= 75 ? "SETUP" : "WATCHING",
  };
}

function swingFmt(pair, price) {
  if (pair.includes("NAS100") || pair.includes("JP225") || pair.includes("SPX") || pair.includes("UK100") || pair.includes("AU200")) return price.toFixed(1);
  if (pair.includes("JPY")) return price.toFixed(3);
  if (pair.includes("XAU") || pair.includes("BCO") || pair.includes("WTICO") || pair.includes("XAG")) return price.toFixed(2);
  return price.toFixed(5);
}

// ─── SWING PRODUCTION GUARDS ──────────────────────────────────────────────────
const SWING_COMMODITY_PAIRS = ["XAU/USD", "BCO/USD"];

// Guard 1 — Entry timing: detect 24/7, execute London(8-13 UTC)+NY(13-18 UTC)
//           Commodities can also execute during Sydney (22-04 UTC)
function canExecuteSwing(pair) {
  const h = new Date().getUTCHours();
  if (h >= 8 && h < 18) return true;
  if (SWING_COMMODITY_PAIRS.includes(pair) && (h >= 22 || h < 4)) return true;
  return false;
}

function nextSwingWindow(pair) {
  const now = new Date();
  const h = now.getUTCHours(), m = now.getUTCMinutes();
  const dec = h + m / 60;
  const wins = [{ label: "London", s: 8 }, { label: "NY", s: 13 }];
  if (SWING_COMMODITY_PAIRS.includes(pair)) wins.push({ label: "Sydney", s: 22 });
  for (const w of wins) {
    if (dec < w.s) {
      const mins = Math.round((w.s - dec) * 60);
      return `${w.label} open in ${Math.floor(mins / 60)}h ${mins % 60}m`;
    }
  }
  const mins = Math.round((24 + 8 - dec) * 60);
  return `London open in ${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// Guard 2 — Friday PM: no new swing entries after 18:00 UTC Friday (12pm Calgary)
function isFridayPMBlock() {
  const now = new Date();
  return now.getUTCDay() === 5 && now.getUTCHours() >= 18;
}

// Guard 3 — News: block execution within 30 min of HIGH-impact events (MDT times)
function isSwingNewsBlock() {
  const now = new Date();
  const dayName = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][now.getDay()];
  const mdtH    = (now.getUTCHours() - 6 + 24) % 24;
  const nowMins = mdtH * 60 + now.getUTCMinutes();
  return WEEKLY_EVENTS.some(ev => {
    if (ev.day !== dayName || ev.impact !== "HIGH") return false;
    const [tp, ap] = ev.time.split(" ");
    const [hh, mm] = tp.split(":").map(Number);
    const evM = ((ap === "PM" && hh !== 12 ? hh + 12 : ap === "AM" && hh === 12 ? 0 : hh) * 60) + mm;
    return Math.abs(nowMins - evM) <= 30;
  });
}

function XavierKillShotNote({ score, pair, direction }) {
  let note = "";
  if (score >= 85) {
    note = `Perfect Kill Shot — ${pair}. Everything aligned: weekly trend, H4 structure, EMA stack, RSI reset. This is a 5R trade if the trend continues. Full swing size. Let it run.`;
  } else if (score >= 75) {
    note = `Good Kill Shot setup — ${pair}. EMA21 pullback holding, RSI reset. ${direction === "LONG" ? "Uptrend intact." : "Downtrend intact."} This is the setup I wait for. Entering now.`;
  }
  if (!note) return null;
  return (
    <div style={{ marginTop: 8, padding: "7px 10px", background: "#F9731611", border: "1px solid #F9731633", borderRadius: 6 }}>
      <div style={{ fontSize: 9, color: "#F97316", fontWeight: 700, letterSpacing: "0.05em", marginBottom: 2 }}>XAVIER</div>
      <div style={{ fontSize: 10, color: "#8b949e", lineHeight: 1.55, fontStyle: "italic" }}>"{note}"</div>
    </div>
  );
}

// ─── KILL SHOT CONSENSUS PANEL ────────────────────────────────────────────────
function SwingConsensusPanel({ pair, sig, session, xavierIntel, freshNews, livePrices, onExecute, onCancel }) {
  const [loading, setLoading] = useState(true);
  const [consensus, setConsensus] = useState(null);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    const run = async () => {
      const instrument = pair.replace("/", "_");

      // Fetch fresh OANDA price
      let freshMid = parseFloat(livePrices?.[pair] || sig.entry);
      try {
        const pResp = await fetch(`${BRIDGE}/prices?instruments=${instrument}`).then(r => r.json());
        if (pResp.prices?.[0]) {
          const px = pResp.prices[0];
          freshMid = (parseFloat(px.bids[0].price) + parseFloat(px.asks[0].price)) / 2;
        }
      } catch { /* fall back */ }

      // Xavier staleness
      const xavierAge    = xavierIntel?.timestamp ? Date.now() - xavierIntel.timestamp : Infinity;
      const xavierAgeMin = xavierAge === Infinity ? 999 : Math.round(xavierAge / 60000);
      const xavierIsStale = xavierAge > 15 * 60 * 1000;
      const xavierBriefFinal = xavierIsStale
        ? "Xavier intelligence unavailable — refreshing now. Base analysis on price action and news only."
        : xavierIntel?.brief || null;

      const entry    = parseFloat(sig.entry || freshMid);
      const slPrice  = parseFloat(sig.sl    || entry * 0.995);
      const tp1Price = parseFloat(sig.tp1   || entry * 1.015);
      const tp2Price = parseFloat(sig.tp2   || entry * 1.030);
      const tp3Price = parseFloat(sig.tp3   || entry * 1.050);
      const atr      = parseFloat(sig.atr   || 0.001);
      const ema21v   = parseFloat(sig.ema21  || entry);
      const ema50v   = parseFloat(sig.ema50  || entry);

      try {
        const r = await fetch(`${BRIDGE}/swing-consensus`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instrument, direction: sig.direction, score: sig.score,
            price: freshMid.toFixed(5),
            entry: entry.toFixed(5),
            sl:    slPrice.toFixed(5),
            tp1:   tp1Price.toFixed(5),
            tp2:   tp2Price.toFixed(5),
            tp3:   tp3Price.toFixed(5),
            ema21: ema21v.toFixed(5),
            ema50: ema50v.toFixed(5),
            rsi:   sig.rsi?.toFixed(1) || "50",
            atr:   atr.toFixed(5),
            session,
            freshNews: freshNews?.slice(0, 5).join(" | ") || null,
            xavierSentiment: xavierIsStale ? null : xavierIntel?.sentiment || null,
            xavierKeyRisk:   xavierIsStale ? null : xavierIntel?.keyRisk   || null,
            xavierBestPair:  xavierIsStale ? null : xavierIntel?.bestPair  || null,
            xavierBrief:     xavierBriefFinal,
            newsAgeMin, xavierIntelAgeMin: xavierAgeMin,
          }),
        });
        const ct = r.headers.get("content-type");
        if (!ct?.includes("application/json")) throw new Error(`Bridge returned HTML — restart npm run server`);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `Bridge error ${r.status}`);
        setConsensus(data);
      } catch (err) {
        const msg = err?.name === "TypeError" || err?.message?.includes("Failed to fetch")
          ? "Bridge offline — run: npm run server"
          : err?.message || "Connection failed";
        setConsensus({
          votes: { confirm: 0, reject: 0 },
          consensus: "API_ERROR", confidence: "—",
          models: [],
          voteLog: [`API error: ${msg}`],
          executeAllowed: true, apiError: true, errorMsg: msg,
        });
      }
      setLoading(false);
    };
    run();
  }, []); // eslint-disable-line

  const confirms       = consensus?.votes?.confirm ?? 0;
  const total          = consensus?.models?.length ?? 4;
  const executeAllowed = consensus?.executeAllowed ?? false;
  const claudeOk       = consensus?.claudeConfirmed ?? (consensus?.models?.[0]?.verdict === "CONFIRM");
  const otherOk        = consensus?.models?.slice(1).filter(m => m.verdict === "CONFIRM") ?? [];
  const accent         = executeAllowed ? "#F97316" : claudeOk ? "#d29922" : "#f85149";
  const MODEL_PLACEHOLDERS = ["Claude Sonnet", "GPT-4o", "DeepSeek", "Gemini 2.5 Flash"];

  return (
    <div style={{ marginTop: 8, padding: 12, borderRadius: 8, background: "#0d1117", border: `1px solid ${accent}40`, borderLeft: `3px solid ${accent}` }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: accent, letterSpacing: "0.04em" }}>
          {loading
            ? "⚔️ KILL SHOT CONSENSUS — consulting models…"
            : executeAllowed
              ? `⚔️ Kill Shot cleared — Claude + ${otherOk[0]?.name?.split(" ")[0] ?? "1 model"} confirmed`
              : !claudeOk
                ? "⚔️ BLOCKED — Claude rejected"
                : "⚔️ BLOCKED — Claude confirmed, need 1 supporting model"}
        </div>
        {!loading && consensus && (
          <span style={{ fontSize: 10, fontWeight: 600, color: accent }}>{consensus.confidence}</span>
        )}
      </div>

      {/* 2×2 model grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, marginBottom: 10, background: "#21262d", borderRadius: 6, overflow: "hidden", border: "1px solid #21262d" }}>
        {(loading ? MODEL_PLACEHOLDERS.map(n => ({ name: n, verdict: null, reason: null })) : (consensus?.models ?? [])).map((model, i) => {
          const isC = model.verdict === "CONFIRM";
          const isR = model.verdict === "REJECT";
          const mc  = isC ? "#3fb950" : isR ? "#f85149" : "#484f58";
          const top = loading ? "#30363d" : isC ? "#238636" : "#da3633";
          return (
            <div key={i} style={{ padding: "8px 10px", background: "#0d1117", borderTop: `2px solid ${top}`, transition: "all 0.3s" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                <span style={{ fontSize: 10, fontWeight: 600, color: loading ? "#484f58" : "#e6edf3" }}>{model.name}</span>
                {!loading && <span style={{ fontSize: 10, fontWeight: 800, color: mc }}>{isC ? "✅" : isR ? "❌" : ""} {model.verdict}</span>}
              </div>
              <div style={{ fontSize: 10, color: loading ? "#30363d" : "#8b949e", lineHeight: 1.4 }}>
                {loading ? "evaluating…" : model.reason}
              </div>
            </div>
          );
        })}
      </div>

      {/* Vote log */}
      {consensus && !loading && consensus.voteLog && (
        <div style={{ marginBottom: 8 }}>
          <button onClick={() => setShowLog(v => !v)} style={{ fontSize: 10, background: "none", border: "none", color: "#484f58", cursor: "pointer", padding: "0 0 4px", fontFamily: FONT_MONO }}>
            {showLog ? "▲ Hide vote log" : "▼ View vote log"}
          </button>
          {showLog && (
            <div style={{ padding: "8px 10px", background: "#0d1117", borderRadius: 6, border: "1px solid #21262d", fontFamily: FONT_MONO, fontSize: 10, lineHeight: 1.8 }}>
              {consensus.voteLog.map((line, i) => {
                const isResult = line.startsWith("Result:");
                const color = isResult ? (line.includes("EXECUTE") ? "#F97316" : "#f85149")
                  : line.includes("] CONFIRM") ? "#3fb950"
                  : line.includes("] REJECT")  ? "#f85149" : "#8b949e";
                return (
                  <div key={i} style={{ color, borderTop: isResult ? "1px solid #21262d" : "none", paddingTop: isResult ? 4 : 0, marginTop: isResult ? 4 : 0, fontWeight: isResult ? 700 : 400 }}>
                    {line}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      {!loading && consensus && (
        <div style={{ display: "flex", gap: 8 }}>
          {consensus.executeAllowed ? (
            <button
              onClick={() => { onExecute(pair, sig); onCancel(); }}
              style={{ flex: 1, padding: "8px 0", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer", background: "#F9731618", color: "#F97316", border: "1px solid #F97316", letterSpacing: "0.04em", fontFamily: "inherit" }}
            >
              ⚔️ Execute Kill Shot
            </button>
          ) : (
            <div style={{ flex: 1, padding: "8px 0", borderRadius: 6, fontSize: 11, fontWeight: 600, textAlign: "center", color: "#f85149", border: "1px solid #f8514940", background: "#f8514908" }}>
              Kill Shot blocked — {confirms}/4 models
            </div>
          )}
          <button
            onClick={onCancel}
            style={{ flex: 0.4, padding: "8px 0", borderRadius: 6, fontSize: 11, cursor: "pointer", background: "#161b22", color: "#8b949e", border: "0.5px solid #30363d", fontFamily: "inherit" }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function SwingPanel({ signals, scanning, onExecute, openTrades, isMobile, isFriPM, isNewsBlock, pendingSetups, session, xavierIntel, freshNews, livePrices, newsLastFetchedAt = 0 }) {
  const [consensusMap, setConsensusMap] = useState({});
  const fetchedRef = useRef(new Set());

  const sessionPairs = KILL_SHOT_PAIRS.filter(p => {
    const allowed = INSTRUMENT_HOME_SESSIONS[p.replace("/", "_")];
    return !allowed || allowed.includes(session);
  });
  const activePairs = sessionPairs.filter(p => signals[p]?.score >= 75);
  const watchPairs  = sessionPairs.filter(p => !signals[p] || signals[p].score < 75);

  // Auto-fetch consensus for each qualifying pair as soon as it appears
  useEffect(() => {
    activePairs.forEach(async (pair) => {
      if (fetchedRef.current.has(pair)) return;
      fetchedRef.current.add(pair);
      const sig        = signals[pair];
      const instrument = pair.replace("/", "_");

      // Fetch fresh OANDA price for this pair
      let freshMid = parseFloat(livePrices?.[pair] || sig.entry);
      try {
        const pResp = await fetch(`${BRIDGE}/prices?instruments=${instrument}`).then(r => r.json());
        if (pResp.prices?.[0]) {
          const px = pResp.prices[0];
          freshMid = (parseFloat(px.bids[0].price) + parseFloat(px.asks[0].price)) / 2;
        }
      } catch { /* fall back to livePrices */ }

      // Xavier intel staleness check
      const xavierAge    = xavierIntel?.timestamp ? Date.now() - xavierIntel.timestamp : Infinity;
      const xavierAgeMin = xavierAge === Infinity ? 999 : Math.round(xavierAge / 60000);
      const xavierIsStale = xavierAge > 15 * 60 * 1000;
      const xavierBriefFinal = xavierIsStale
        ? "Xavier intelligence unavailable — refreshing now. Base analysis on price action and news only."
        : xavierIntel?.brief || null;

      // News staleness
      const newsAgeMin = newsLastFetchedAt ? Math.round((Date.now() - newsLastFetchedAt) / 60000) : 999;

      // Swing signal fields
      const entry    = parseFloat(sig.entry || freshMid);
      const slPrice  = parseFloat(sig.sl    || entry * 0.995);
      const tp1Price = parseFloat(sig.tp1   || entry * 1.015);
      const tp2Price = parseFloat(sig.tp2   || entry * 1.030);
      const tp3Price = parseFloat(sig.tp3   || entry * 1.050);
      const atr      = parseFloat(sig.atr   || 0.001);
      const ema21v   = parseFloat(sig.ema21  || entry);
      const ema50v   = parseFloat(sig.ema50  || entry);
      const freshNewsStr = newsAgeMin > 30
        ? `[stale — ${newsAgeMin}min old] ${freshNews?.slice(0, 3).join(" | ") || "No headlines"}`
        : freshNews?.slice(0, 5).join(" | ") || null;
      setConsensusMap(prev => ({ ...prev, [pair]: { loading: true, data: null } }));
      fetch(`${BRIDGE}/swing-consensus`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument, direction: sig.direction, score: sig.score,
          price: swingFmt(pair, freshMid),
          entry: swingFmt(pair, entry),
          sl:    swingFmt(pair, slPrice),
          tp1:   swingFmt(pair, tp1Price),
          tp2:   swingFmt(pair, tp2Price),
          tp3:   swingFmt(pair, tp3Price),
          ema21: swingFmt(pair, ema21v),
          ema50: swingFmt(pair, ema50v),
          rsi:   sig.rsi?.toFixed(1) || "50",
          atr:   atr.toFixed(5),
          session,
          freshNews: freshNewsStr,
          // Xavier intel (staleness-aware)
          xavierSentiment: xavierIsStale ? null : xavierIntel?.sentiment || null,
          xavierKeyRisk:   xavierIsStale ? null : xavierIntel?.keyRisk   || null,
          xavierBestPair:  xavierIsStale ? null : xavierIntel?.bestPair  || null,
          xavierBrief:     xavierBriefFinal,
          // Data freshness metadata
          newsAgeMin, xavierIntelAgeMin: xavierAgeMin,
        }),
      })
        .then(async r => {
          const ct = r.headers.get("content-type");
          if (!ct?.includes("application/json")) {
            throw new Error(`Bridge returned HTML — status: ${r.status} — restart npm run server`);
          }
          return r.json();
        })
        .then(data => setConsensusMap(prev => ({ ...prev, [pair]: { loading: false, data } })))
        .catch(err => {
          console.error("[KILL SHOT CONSENSUS]", err.message);
          fetchedRef.current.delete(pair); // allow retry on next qualify
          // API error → non-blocking: user can still execute manually
          setConsensusMap(prev => ({
            ...prev,
            [pair]: {
              loading: false,
              data: { apiError: true, executeAllowed: true, votes: { confirm: 0, reject: 0 }, models: [], errorMsg: err.message },
            },
          }));
        });
    });
  }, [activePairs.join(",")]); // eslint-disable-line

  return (
    <div style={{ margin: isMobile ? "0 0 16px" : "0 16px 16px", background: "#161b22", border: "1px solid #F9731640", borderRadius: 12, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "10px 14px", borderBottom: "1px solid #21262d", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#0d1117" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#F97316" }}>⚔️ Kill Shot — Swing Scanner</div>
          <div style={{ fontSize: 10, color: "#484f58", marginTop: 1 }}>H4 · 3–5R targets · 2-5 day holds</div>
        </div>
        <div style={{ fontSize: 10, color: "#484f58", fontFamily: FONT_MONO }}>
          {scanning ? "Scanning…" : `${sessionPairs.length} pairs`}
        </div>
      </div>

      {/* Guard 2 — Friday PM warning */}
      {isFriPM && (
        <div style={{ padding: "8px 14px", background: "#F9731610", borderBottom: "1px solid #F9731630", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: "#F97316", fontWeight: 700 }}>⚠ WEEKEND GAP RISK</span>
          <span style={{ fontSize: 10, color: "#8b949e" }}>No new swing entries after Friday 12pm Calgary — market reopens Sunday with gaps</span>
        </div>
      )}

      {/* Guard 3 — News block warning */}
      {isNewsBlock && (
        <div style={{ padding: "8px 14px", background: "#d2992210", borderBottom: "1px solid #d2992230", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: "#d29922", fontWeight: 700 }}>⚠ HIGH-IMPACT EVENT ±30m</span>
          <span style={{ fontSize: 10, color: "#8b949e" }}>Execution paused — spreads wide, slippage risk elevated</span>
        </div>
      )}

      {/* Active setups */}
      {activePairs.map(pair => {
        const sig = signals[pair];
        const isAlreadyOpen = openTrades?.some(t => t.instrument?.replace("_", "/") === pair);
        const canExec = canExecuteSwing(pair) && !isFriPM && !isNewsBlock;
        const isPending = !!pendingSetups?.[pair];
        const isPhase2 = PHASE2_PAIRS.has(pair);
        const labelColor = sig.label === "PERFECT" ? "#3fb950" : "#F97316";
        const cs = consensusMap[pair]; // { loading, data }
        const confirms = cs?.data?.votes?.confirm ?? 0;
        const executeAllowed = cs?.data?.executeAllowed ?? false;
        const csClaudeOk = cs?.data?.claudeConfirmed ?? (cs?.data?.models?.[0]?.verdict === "CONFIRM");
        const csOtherOk  = cs?.data?.models?.slice(1).filter(m => m.verdict === "CONFIRM") ?? [];
        const resultColor = executeAllowed ? "#3fb950" : csClaudeOk ? "#d29922" : "#f85149";

        return (
          <div key={pair} style={{ padding: "12px 14px", borderBottom: "1px solid #21262d" }}>
            {/* Pair header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#e6edf3", fontFamily: FONT_MONO }}>{pair}</span>
                <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: sig.direction === "LONG" ? "#3fb95022" : "#f8514922", color: sig.direction === "LONG" ? "#3fb950" : "#f85149", border: `1px solid ${sig.direction === "LONG" ? "#3fb95055" : "#f8514955"}`, fontWeight: 700 }}>{sig.direction}</span>
                <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: labelColor + "22", color: labelColor, border: `1px solid ${labelColor}44`, fontWeight: 700 }}>{sig.label}</span>
                {isPending  && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "#58a6ff22", color: "#58a6ff", border: "1px solid #58a6ff44", fontWeight: 700 }}>QUEUED</span>}
                {isPhase2  && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "#d2992222", color: "#d29922", border: "1px solid #d2992244", fontWeight: 700 }}>PHASE 2</span>}
              </div>
              <span style={{ fontSize: 13, fontWeight: 800, color: labelColor, fontFamily: FONT_MONO }}>{sig.score}%</span>
            </div>

            {/* Tech summary */}
            <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 6, lineHeight: 1.5 }}>
              EMA21 pullback · {sig.breakdown?.weekly > 0 ? "Weekly trend aligned" : "Weekly bias weak"} · RSI {sig.rsi?.toFixed(0) ?? "—"}
            </div>

            {/* Levels */}
            <div style={{ display: "flex", gap: 12, fontSize: 10, color: "#484f58", fontFamily: FONT_MONO, marginBottom: 8 }}>
              <span>Entry <span style={{ color: "#e6edf3" }}>{swingFmt(pair, sig.entry)}</span></span>
              <span>SL <span style={{ color: "#f85149" }}>{swingFmt(pair, sig.sl)}</span></span>
              <span>TP1 <span style={{ color: "#3fb950" }}>{swingFmt(pair, sig.tp1)}</span></span>
              <span>TP2 <span style={{ color: "#3fb950" }}>{swingFmt(pair, sig.tp2)}</span></span>
            </div>

            {/* Timing message */}
            {!canExec && !isAlreadyOpen && (
              <div style={{ marginBottom: 6, fontSize: 10, color: "#8b949e", fontStyle: "italic" }}>
                {isFriPM ? "⚠ Blocked — weekend gap risk" : isNewsBlock ? "⚠ Blocked — HIGH event nearby" : `DETECTED — ${nextSwingWindow(pair)}`}
              </div>
            )}

            {/* ── AI CONSENSUS — always shown inline ── */}
            <div style={{ marginTop: 8, background: "#0d1117", borderRadius: 7, border: `1px solid ${cs?.data?.apiError ? "#d2992240" : "#21262d"}`, padding: "10px 12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: cs?.loading || !cs ? 0 : 8 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "#8b949e", letterSpacing: "0.06em" }}>AI CONSENSUS</span>
                {cs?.data && !cs.loading && !cs.data.apiError && (
                  <span style={{ fontSize: 10, fontWeight: 700, color: resultColor }}>{confirms}/4 — {executeAllowed ? "EXECUTING" : "BLOCKED"}</span>
                )}
              </div>

              {cs?.loading ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 5 }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#F97316", animation: "pulse 1.2s ease-in-out infinite" }} />
                  <span style={{ fontSize: 10, color: "#484f58" }}>Consulting 4 models…</span>
                </div>
              ) : cs?.data?.apiError ? (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 6, paddingTop: 4 }}>
                  <span style={{ fontSize: 13 }}>⚠️</span>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 600, color: "#d29922" }}>Consensus API unavailable — manual review required</div>
                    <div style={{ fontSize: 10, color: "#484f58", marginTop: 2 }}>{cs.data.errorMsg}</div>
                  </div>
                </div>
              ) : cs?.data?.models?.length > 0 ? (
                <>
                  {cs.data.models.map((model, i) => {
                    const isC = model.verdict === "CONFIRM";
                    const mc = isC ? "#3fb950" : "#f85149";
                    const shortName = model.name === "Claude Sonnet" ? "Claude"
                      : model.name === "Gemini 2.5 Flash" ? "Gemini"
                      : model.name;
                    return (
                      <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: i < cs.data.models.length - 1 ? 5 : 0 }}>
                        <span style={{ width: 62, fontSize: 10, color: "#8b949e", flexShrink: 0 }}>{shortName}:</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: mc, flexShrink: 0, minWidth: 80 }}>{isC ? "✅ CONFIRM" : "❌ REJECT"}</span>
                        <span style={{ fontSize: 10, color: "#484f58", lineHeight: 1.4 }}>— {model.reason}</span>
                      </div>
                    );
                  })}
                  <div style={{ borderTop: "1px solid #21262d", marginTop: 7, paddingTop: 6, fontSize: 10, fontWeight: 700, color: resultColor, letterSpacing: "0.03em" }}>
                    {executeAllowed
                      ? `Result: ${confirms}/4 — EXECUTING (Claude + ${csOtherOk[0]?.name?.split(" ")[0] ?? "1 model"} confirmed)`
                      : !csClaudeOk
                        ? "Result: BLOCKED — Claude rejected"
                        : "Result: BLOCKED — Claude confirmed, need 1 supporting model"}
                  </div>
                </>
              ) : !cs ? (
                <div style={{ fontSize: 10, color: "#484f58", paddingTop: 5 }}>Signal qualifying — consensus pending…</div>
              ) : (
                <div style={{ fontSize: 10, color: "#f85149", paddingTop: 5 }}>{cs.data?.errorMsg || "Consensus error"}</div>
              )}
            </div>

            <XavierKillShotNote score={sig.score} pair={pair} direction={sig.direction} />

            {/* Execute button — gated by consensus */}
            <button
              onClick={() => canExec && !isAlreadyOpen && executeAllowed && !isPhase2 && onExecute(pair, sig)}
              disabled={isAlreadyOpen || !canExec || !executeAllowed || !!cs?.loading || isPhase2}
              style={{
                marginTop: 8, width: "100%", padding: "7px 0", borderRadius: 6,
                fontFamily: "inherit", letterSpacing: "0.04em", transition: "all 0.15s",
                fontSize: 11, fontWeight: 700,
                border: `1px solid ${isAlreadyOpen || !executeAllowed ? "#30363d" : canExec ? "#F97316" : "#30363d"}`,
                background: isAlreadyOpen || !executeAllowed ? "#161b22" : canExec ? "#F9731618" : "#161b22",
                color: isAlreadyOpen || !executeAllowed ? "#484f58" : canExec ? "#F97316" : "#484f58",
                cursor: (isAlreadyOpen || !canExec || !executeAllowed || cs?.loading) ? "default" : "pointer",
              }}
            >
              {isAlreadyOpen ? "Already Open"
                : cs?.loading ? "⏳ Running consensus…"
                : !cs?.data ? "⏳ Awaiting consensus…"
                : !executeAllowed ? "❌ Blocked by committee"
                : isPhase2 ? "⚠️ Phase 2 — not yet validated for auto"
                : !canExec ? (isPending ? `⏳ ${nextSwingWindow(pair).split(" in ")[0]}` : `⏳ ${nextSwingWindow(pair)}`)
                : "⚔️ Execute Kill Shot"}
            </button>
          </div>
        );
      })}

      {/* Watching pairs */}
      {watchPairs.length > 0 && (
        <div style={{ padding: "8px 14px" }}>
          {watchPairs.map((pair, i) => {
            const sig = signals[pair];
            return (
              <div key={pair} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: i < watchPairs.length - 1 ? "0.5px solid #21262d40" : "none" }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "#8b949e", fontFamily: FONT_MONO }}>{pair}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {sig ? (
                    <>
                      <span style={{ fontSize: 10, color: "#484f58" }}>
                        {sig.breakdown?.pullback === 0 ? "Needs EMA21 pullback" : sig.breakdown?.momentum < 10 ? "Needs RSI reset" : "Building setup"}
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#484f58", fontFamily: FONT_MONO }}>{sig.score}%</span>
                    </>
                  ) : (
                    <span style={{ fontSize: 10, color: "#484f58" }}>{scanning ? "Scanning…" : "No data"}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SwingJournalPanel({ swingTrades, openTrades, livePrices, displayNav, isMobile }) {
  // Reconcile against OANDA: if a trade has an oandaId and is NOT in openTrades, it's already closed
  const activeTrades = swingTrades.filter(t => {
    if (t.closed) return false;
    if (t.oandaId && openTrades?.length > 0) return openTrades.some(o => o.id === t.oandaId);
    return true;
  });
  const closedTrades = swingTrades.filter(t => t.closed);

  // Orphaned OANDA trades: open in OANDA but not in swingTrades (server-placed, e.g. M5 auto-trade)
  const trackedIds     = new Set(activeTrades.map(t => t.oandaId).filter(Boolean));
  const orphanedOanda  = (openTrades || []).filter(o => !trackedIds.has(o.id));
  const orphanedTrades = orphanedOanda.map(o => ({
    id:          `oanda_${o.id}`,
    oandaId:     o.id,
    pair:        o.instrument?.replace('_', '/'),
    direction:   parseInt(o.currentUnits) >= 0 ? 'LONG' : 'SHORT',
    entry:       parseFloat(o.price),
    sl:          parseFloat(o.stopLossOrder?.price  || 0),
    tp1:         parseFloat(o.takeProfitOrder?.price || 0),
    score:       null,
    openedAt:    new Date(o.openTime).getTime(),
    thesis:      `Server-placed — OANDA #${o.id}`,
    closed:      false,
    _orphaned:   true,
  }));

  console.log('[SWING JOURNAL] activeTrades:', JSON.stringify(activeTrades));
  console.log('[SWING JOURNAL] openTrades from OANDA:', JSON.stringify(openTrades?.map(t => t.instrument)));

  const allActive = [...activeTrades, ...orphanedTrades];
  if (allActive.length === 0 && closedTrades.length === 0) return null;

  const oneR    = (displayNav || 100) * 0.015;
  const fmtDays = (ms) => {
    const d = (Date.now() - ms) / 86400000;
    return d < 1 ? `${Math.round(d * 24)}h` : `${d.toFixed(1)}d`;
  };

  return (
    <div style={{ margin: isMobile ? "0 0 16px" : "0 16px 16px", background: "#161b22", border: "1px solid #F9731630", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid #21262d", background: "#0d1117", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#F97316" }}>⚔️ Swing Journal</div>
        <div style={{ fontSize: 10, color: "#484f58" }}>{allActive.length} open · {closedTrades.length} closed</div>
      </div>
      {allActive.map(t => {
        const liveOanda  = openTrades?.find(o => o.id === t.oandaId);
        // Always use actual OANDA order prices — never BASE_PRICES or estimates
        const displaySL  = liveOanda?.stopLossOrder?.price  || t.sl  || null;
        const displayTP  = liveOanda?.takeProfitOrder?.price || t.tp1 || null;
        const liveSL     = displaySL ? parseFloat(displaySL) : 0;
        const liveTP     = displayTP ? parseFloat(displayTP) : 0;

        // R calculation — prefer OANDA unrealizedPL (authoritative, no price estimation needed)
        let pnlR = null, priceLoading = false;
        if (liveOanda && oneR > 0) {
          const rawR = parseFloat(liveOanda.unrealizedPL || 0) / oneR;
          pnlR = (rawR < -3 || rawR > 10) ? null : rawR;
        } else {
          // Multi-format lookup: "EUR/USD", "EUR_USD"
          const currentPrice = livePrices?.[t.pair] || livePrices?.[t.pair?.replace('/', '_')] || null;
          if (currentPrice) {
            const riskDist = Math.abs(t.entry - liveSL);
            const pnlPips  = t.direction === "LONG" ? currentPrice - t.entry : t.entry - currentPrice;
            const rawR     = riskDist > 0 ? pnlPips / riskDist : null;
            pnlR = (rawR === null || rawR < -3 || rawR > 10) ? null : rawR;
          } else {
            priceLoading = true;
          }
        }

        const rColor = pnlR === null ? "#484f58" : pnlR >= 2 ? "#3fb950" : pnlR >= 1 ? "#d29922" : pnlR >= 0 ? "#8b949e" : "#f85149";
        return (
          <div key={t.id} style={{ padding: "10px 14px", borderBottom: "0.5px solid #21262d" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#e6edf3", fontFamily: FONT_MONO }}>{t.pair}</span>
                <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: t.direction === "LONG" ? "#3fb95022" : "#f8514922", color: t.direction === "LONG" ? "#3fb950" : "#f85149", fontWeight: 700 }}>{t.direction}</span>
                <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "#F9731622", color: "#F97316", fontWeight: 700 }}>{t._orphaned ? "M5" : "SWING"}</span>
              </div>
              <span style={{ fontSize: 12, fontWeight: 800, color: rColor, fontFamily: FONT_MONO }}>
                {priceLoading ? <span style={{ fontSize: 10, color: "#484f58" }}>loading…</span>
                  : pnlR === null ? "—"
                  : Math.abs(pnlR) < 0.05 ? "0.0R" : `${pnlR >= 0 ? "+" : ""}${pnlR.toFixed(1)}R`}
              </span>
            </div>
            <div style={{ fontSize: 10, color: "#484f58", fontFamily: FONT_MONO, marginBottom: 2 }}>
              {fmtDays(t.openedAt)} · {t.score != null ? `Score ${t.score}% · ` : ""}SL {displaySL ?? "—"} · TP {displayTP ?? "—"}
            </div>
            <div style={{ fontSize: 10, color: "#8b949e", fontStyle: "italic" }}>{t.thesis}</div>
          </div>
        );
      })}
      {closedTrades.slice(-5).reverse().map(t => (
        <div key={t.id} style={{ padding: "8px 14px", borderBottom: "0.5px solid #21262d40", opacity: 0.6 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 10, color: "#8b949e", fontFamily: FONT_MONO }}>{t.pair} {t.direction}</span>
            <span style={{ fontSize: 10, color: "#484f58" }}>{t.closeReason || "Closed"}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── NEWS TICKER ──────────────────────────────────────────────────────────────
const TICKER_ITEMS = [
  { source: "LIVE", headline: "Loading latest news..." },
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

function NewsTicker({ onHeadlineChange, onItemsChange }) {
  const [tickerItems, setTickerItems] = useState(TICKER_ITEMS);
  const itemsRef      = useRef(TICKER_ITEMS);
  const idxRef        = useRef(0);
  const onChangeRef   = useRef(onHeadlineChange);
  const onItemsRef    = useRef(onItemsChange);
  onChangeRef.current = onHeadlineChange;
  onItemsRef.current  = onItemsChange;

  useEffect(() => {
    // Start rotation immediately with fallback items
    onChangeRef.current(itemsRef.current[0].headline);
    const rotateId = setInterval(() => {
      idxRef.current = (idxRef.current + 1) % itemsRef.current.length;
      onChangeRef.current(itemsRef.current[idxRef.current].headline);
    }, 8000);

    // Fetch all market categories in parallel; interleave results
    const fetchNews = async () => {
      try {
        const cats = ["forex", "indices", "commodities", "macro"];
        const results = await Promise.allSettled(
          cats.map(cat => fetch(`${BRIDGE}/news?category=${cat}`).then(r => r.ok ? r.json() : null))
        );
        // Round-robin interleave: take up to 8 items per category
        const buckets = results.map((r, i) =>
          r.status === "fulfilled" && Array.isArray(r.value?.items)
            ? r.value.items.slice(0, 8).map(item => ({ source: item.source || cats[i], headline: item.title }))
            : []
        );
        const interleaved = [];
        const maxLen = Math.max(...buckets.map(b => b.length));
        for (let i = 0; i < maxLen; i++) {
          for (const bucket of buckets) { if (bucket[i]) interleaved.push(bucket[i]); }
        }
        if (interleaved.length === 0) return;
        itemsRef.current = interleaved;
        idxRef.current   = 0;
        setTickerItems(interleaved);
        onChangeRef.current(interleaved[0].headline);
        onItemsRef.current?.(interleaved.map(i => i.headline), Date.now());
      } catch { /* keep fallback items on network error */ }
    };

    fetchNews();
    const fetchId = setInterval(fetchNews, 5 * 60_000);

    return () => { clearInterval(rotateId); clearInterval(fetchId); };
  }, []); // eslint-disable-line

  return (
    <div style={{ display: "flex", alignItems: "center", overflow: "hidden", height: 36, background: "#0d1117", borderBottom: "1px solid #21262d" }}>
      <div style={{ background: "linear-gradient(135deg, #da3633 0%, #b62324 100%)", color: "#fff", fontSize: 10, fontWeight: 800, padding: "0 12px", height: "100%", display: "flex", alignItems: "center", letterSpacing: "1.5px", flexShrink: 0, boxShadow: "2px 0 12px rgba(218,54,51,0.25)" }}>
        LIVE
      </div>
      <div style={{ overflow: "hidden", flex: 1, height: "100%", display: "flex", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", whiteSpace: "nowrap", animation: "marquee 160s linear infinite", willChange: "transform", fontSize: 12 }}>
          <TickerTrack items={tickerItems} />
          <TickerTrack items={tickerItems} />
        </div>
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
  { key: "marketWizards",    label: "Market Wizards", icon: "📚", color: "#58a6ff" },
  { key: "vanTharpRules",    label: "Van Tharp",      icon: "📊", color: "#1D9E75" },
  { key: "mt5Patterns",      label: "MT5 Patterns",   icon: "📈", color: "#F97316" },
  { key: "quantConnectEdge", label: "QuantConnect",   icon: "⚡", color: "#8B5CF6" },
];

const DOCTRINE_DETAILS = {
  "Cut losses short, let winners run": { weight: "HIGH", impact: "Core survival rule — controls whether a trading system survives long-term drawdowns.", xavierNote: "The hardest rule when you're in a losing trade. Your brain screams to hold on. The discipline is knowing your exit before you enter.", bestEnv: "Universal — applies to every trade across all sessions and strategies", whenToAvoid: "Never — no exception to this rule", related: ["Never risk more than 1-2% of capital on a single trade", "R-multiple system: define your 1R risk before entry"] },
  "Never risk more than 1-2% of capital on a single trade": { weight: "HIGH", impact: "Position sizing control — prevents a single trade from critically damaging the account.", xavierNote: "This is where most retail traders blow up. They get a big signal and go heavy. We cap at 1.5% every single time. No exceptions.", bestEnv: "All conditions — especially critical during high-volatility sessions and news events", whenToAvoid: "Never — fixed rule regardless of conviction level", related: ["Maximum portfolio heat: 6R across all open trades", "Position size = (Account risk %) / (Trade risk in price)"] },
  "Trade with the trend on your primary timeframe": { weight: "HIGH", impact: "Directional bias — aligns entries with the highest probability direction on the controlling timeframe.", xavierNote: "Counter-trend trades feel smart in the moment. They're usually just noise. The trend is the market's opinion — who am I to argue?", bestEnv: "London and Prime sessions when institutional order flow drives clear directional moves", whenToAvoid: "Ranging or VOLATILE regimes — trend rules fail in chop", related: ["EMA 9/21 crossover for trend confirmation", "Multi-timeframe confluence: H4 trend + H1 entry"] },
  "Always know your exit before your entry": { weight: "HIGH", impact: "Pre-trade planning — eliminates emotional decision-making during the trade.", xavierNote: "If you don't know where you're getting out before you get in, you're not trading — you're gambling. Plan the trade, trade the plan.", bestEnv: "All sessions — especially critical during fast-moving London open and NY data events", whenToAvoid: "Never — pre-defining exit is non-negotiable", related: ["Cut losses short, let winners run", "R-multiple system: define your 1R risk before entry"] },
  "Discipline and consistency beat intelligence": { weight: "MEDIUM", impact: "Behavioral edge — systematic execution outperforms ad-hoc smart decisions over time.", xavierNote: "I've seen brilliant traders blow up and average traders build wealth. The difference is always execution discipline, not IQ.", bestEnv: "All conditions — compounding benefit shows over weeks and months of consistent execution", whenToAvoid: "N/A — applies universally", related: ["Master your emotions — fear and greed destroy accounts", "The best traders are right 40-50% of the time but manage risk brilliantly"] },
  "Master your emotions — fear and greed destroy accounts": { weight: "HIGH", impact: "Psychological edge — emotional trading leads to oversizing, revenge trades, and premature exits.", xavierNote: "After a loss, the urge to get it back is the most dangerous feeling in trading. That's when the real risk management begins.", bestEnv: "After any losing streak — applies especially after 2+ consecutive losses", whenToAvoid: "N/A — emotional control is always the priority", related: ["Discipline and consistency beat intelligence", "Cut losses short, let winners run"] },
  "Size positions based on volatility, not conviction": { weight: "MEDIUM", impact: "Adaptive sizing — prevents oversizing in low-volatility environments that suddenly spike.", xavierNote: "High conviction is the trader's ego talking. ATR doesn't care how sure you feel. Size to the volatility, always.", bestEnv: "Volatile sessions — London open, NY data releases, Tokyo JPY pairs", whenToAvoid: "Stable trending regimes where fixed sizing works fine", related: ["Use ATR for stop placement, not round numbers", "Never risk more than 1-2% of capital on a single trade"] },
  "The best traders are right 40-50% of the time but manage risk brilliantly": { weight: "MEDIUM", impact: "Expectancy mindset — shifts focus from win rate to risk-adjusted returns.", xavierNote: "Winning percentage is vanity. Expectancy is sanity. A 40% win rate with 3:1 R:R prints money. A 70% win rate with 0.5:1 loses it.", bestEnv: "All strategies — especially Mean Revert where losing streaks are expected and normal", whenToAvoid: "N/A — mindset rule that always applies", related: ["Expectancy = (Win% × Avg Win) − (Loss% × Avg Loss)", "Target 3R+ reward-to-risk minimum"] },
  "R-multiple system: define your 1R risk before entry": { weight: "HIGH", impact: "Risk normalization — makes all trades comparable regardless of pair, price, or lot size.", xavierNote: "1R is your unit of account. Every trade, every time. It's how you compare a EUR/USD trade to a XAU/USD trade on the same scale.", bestEnv: "Every trade — the R system works across all sessions, pairs, and strategies", whenToAvoid: "Never — the R framework is the foundation of everything else", related: ["Position size = (Account risk %) / (Trade risk in price)", "Target 3R+ reward-to-risk minimum"] },
  "Position size = (Account risk %) / (Trade risk in price)": { weight: "HIGH", impact: "Mechanical sizing formula — removes guesswork from position sizing entirely.", xavierNote: "This formula is the answer to 'how much should I trade.' Run it every time. 1.5% of account ÷ stop distance in price = your units.", bestEnv: "Pre-trade checklist — calculate before every single entry without exception", whenToAvoid: "Never skip this calculation — it's what keeps 1.5% risk actually at 1.5%", related: ["R-multiple system: define your 1R risk before entry", "Never risk more than 1-2% of capital on a single trade"] },
  "Target 3R+ reward-to-risk minimum": { weight: "HIGH", impact: "Expectancy filter — ensures each trade has enough profit potential to offset losses over time.", xavierNote: "If the setup doesn't give me 3:1, I skip it. Simple. A lot of mediocre setups become easy passes when you hold this standard.", bestEnv: "All sessions — the 3R filter works especially well during Prime when clean setups form", whenToAvoid: "Scalping strategies where 1.5–2R per trade is structurally appropriate", related: ["Expectancy = (Win% × Avg Win) − (Loss% × Avg Loss)", "R-multiple system: define your 1R risk before entry"] },
  "Expectancy = (Win% × Avg Win) − (Loss% × Avg Loss)": { weight: "MEDIUM", impact: "System evaluation metric — the only number that determines if a strategy has a genuine edge.", xavierNote: "Run this on your last 20 trades every week. If expectancy is negative, stop trading the system and investigate. Don't just keep firing.", bestEnv: "Weekly review — apply to full trade history for statistical validity (minimum 20 trades)", whenToAvoid: "Don't calculate on fewer than 20 trades — results are statistically unreliable", related: ["Target 3R+ reward-to-risk minimum", "The best traders are right 40-50% of the time but manage risk brilliantly"] },
  "Never add to losing positions": { weight: "HIGH", impact: "Position integrity — prevents averaging down from turning a managed loss into a catastrophic one.", xavierNote: "Averaging down feels like conviction. It's actually hope disguised as strategy. The market doesn't know your entry price.", bestEnv: "Universal — especially critical in trending markets where positions can move far against you", whenToAvoid: "Never — no valid reason to add to a losing position under any circumstances", related: ["Cut losses short, let winners run", "Maximum portfolio heat: 6R across all open trades"] },
  "Maximum portfolio heat: 6R across all open trades": { weight: "HIGH", impact: "Portfolio-level circuit breaker — prevents correlated positions from causing account-level damage.", xavierNote: "When heat hits 6R, the system stops. Not because I'm scared — because correlation risk compounds fast. Three open trades moving together is three bets on the same thing.", bestEnv: "Always active — heat monitoring is continuous regardless of session or strategy", whenToAvoid: "Never reduce the limit — 6R is the mathematical maximum for sustainable trading", related: ["Never risk more than 1-2% of capital on a single trade", "R-multiple system: define your 1R risk before entry"] },
  "Use ATR for stop placement, not round numbers": { weight: "MEDIUM", impact: "Volatility-adjusted stops — prevents stops from being placed at predictable levels that market makers target.", xavierNote: "Round numbers like 1.0900 are magnets for stop hunts. ATR-based stops hide in the volatility noise where price naturally breathes.", bestEnv: "All sessions — especially important during high-volatility London and NY events", whenToAvoid: "Very low ATR environments where ATR stops may be tighter than the spread", related: ["Size positions based on volatility, not conviction", "R-multiple system: define your 1R risk before entry"] },
  "EMA 9/21 crossover for trend confirmation": { weight: "HIGH", impact: "Trend identification signal — fast crossover system used for entry timing and directional bias.", xavierNote: "EMA 9 crossing above EMA 21 is your green light on the M15. It's not perfect — nothing is — but it's consistent enough to build a system on.", bestEnv: "London and Prime sessions on EUR/USD, GBP/USD, USD/JPY — clean trending pairs", whenToAvoid: "VOLATILE regime or Tokyo session — EMAs lag and give false signals in chop", related: ["Multi-timeframe confluence: H4 trend + H1 entry", "Trade with the trend on your primary timeframe"] },
  "RSI divergence for reversal signals": { weight: "MEDIUM", impact: "Momentum exhaustion signal — identifies when price direction and momentum are diverging.", xavierNote: "RSI divergence tells you the move is losing steam. It doesn't tell you when it ends. Combine with price action at key levels.", bestEnv: "Mean Revert strategy — best on overbought/oversold extremes at session boundaries", whenToAvoid: "Strong trending regimes — RSI stays extreme for extended periods, giving premature reversals", related: ["Bollinger Bands squeeze for breakout setups", "Mean reversion on intraday deviations >2σ"] },
  "MACD histogram for momentum shifts": { weight: "MEDIUM", impact: "Momentum confirmation — histogram crossover signals a change in directional momentum.", xavierNote: "I use MACD as a momentum filter, not a primary signal. If the histogram is diverging from price, I get cautious about entries in that direction.", bestEnv: "Trending markets during NY and Prime sessions where momentum sustains directionally", whenToAvoid: "Ranging or sideways conditions — MACD generates excessive whipsaws", related: ["EMA 9/21 crossover for trend confirmation", "Volume-weighted entries for institutional alignment"] },
  "Bollinger Bands squeeze for breakout setups": { weight: "MEDIUM", impact: "Volatility compression detection — identifies periods of low volatility that typically precede explosive moves.", xavierNote: "A BB squeeze is a coiled spring. The direction of the break matters more than the squeeze itself. Wait for the candle to close outside.", bestEnv: "Asian session into London open — classic volatility expansion setup", whenToAvoid: "Already high-volatility environments where bands are wide — squeeze signal is less meaningful", related: ["Volatility regime switching (high vol → defensive)", "Mean reversion on intraday deviations >2σ"] },
  "Volume-weighted entries for institutional alignment": { weight: "LOW", impact: "Institutional flow alignment — entering at high-volume price levels increases probability of follow-through.", xavierNote: "When I see volume spike at a level, that's institutions transacting. Aligning with that flow rather than against it makes a real difference.", bestEnv: "London and NY session opens where institutional order flow is heaviest", whenToAvoid: "Sydney and early Tokyo — volume is too low for reliable volume-weighted signals", related: ["EMA 9/21 crossover for trend confirmation", "Multi-timeframe confluence: H4 trend + H1 entry"] },
  "Multi-timeframe confluence: H4 trend + H1 entry": { weight: "HIGH", impact: "Timeframe alignment — ensures trade direction is consistent across multiple timeframes for higher probability.", xavierNote: "H4 tells me where we're going. H1 tells me when to get on. M15 tells me where to put the stop. Three-frame confluence is where the clean setups live.", bestEnv: "All sessions — especially valuable for swing entries at session opens", whenToAvoid: "Fast scalp conditions where multi-timeframe analysis introduces too much delay", related: ["Trade with the trend on your primary timeframe", "EMA 9/21 crossover for trend confirmation"] },
  "Mean reversion on intraday deviations >2σ": { weight: "HIGH", impact: "Statistical edge — exploits the tendency of prices to return to mean after significant intraday deviations.", xavierNote: "When price moves more than 2 standard deviations from the mean in a single session, the odds favor a snap-back. That's the core of our Mean Revert strategy.", bestEnv: "Tokyo and Sydney sessions on ranging pairs — AUD/USD, NZD/USD are ideal candidates", whenToAvoid: "During news events or Prime session — trend forces can override mean reversion mechanics", related: ["RSI divergence for reversal signals", "Bollinger Bands squeeze for breakout setups"] },
  "Momentum factor on 12-1 month returns": { weight: "LOW", impact: "Long-term momentum signal — uses medium-term return data to identify pairs with sustained directional momentum.", xavierNote: "This is more of a background filter. If a pair has been trending for months, the intraday Mean Revert signals on that pair get extra scrutiny.", bestEnv: "Trend Follow strategy — works best on pairs with sustained multi-month directional bias", whenToAvoid: "Mean Revert strategy — 12-month momentum conflicts with short-term reversion signals", related: ["Trade with the trend on your primary timeframe", "EMA 9/21 crossover for trend confirmation"] },
  "Pairs trading on correlated assets with z-score >2": { weight: "MEDIUM", impact: "Statistical arbitrage — exploits temporary divergence in historically correlated pairs.", xavierNote: "EUR/USD and GBP/USD move together 80% of the time. When they diverge significantly, one of them is usually wrong. That divergence is the trade.", bestEnv: "London session when both European pairs are active and correlation is strongest", whenToAvoid: "During fundamental divergence events — separate monetary policy moves break correlation", related: ["Mean reversion on intraday deviations >2σ", "RSI divergence for reversal signals"] },
  "Volatility regime switching (high vol → defensive)": { weight: "HIGH", impact: "Regime-adaptive risk management — systematically reduces exposure when volatility reaches dangerous levels.", xavierNote: "When ATR spikes 50% above its 20-day average, we go defensive. Smaller sizes, tighter stops, fewer trades. Let the volatility burn off.", bestEnv: "Post-news events and session opens — regime switching protects capital during unpredictable periods", whenToAvoid: "N/A — this is a protective rule, not a trading rule", related: ["Size positions based on volatility, not conviction", "Maximum portfolio heat: 6R across all open trades"] },
  "Machine learning signal weighting via gradient boosting": { weight: "LOW", impact: "Signal optimization — uses ensemble methods to weight multiple signals by their historical predictive value.", xavierNote: "This is more theoretical for our setup right now. The concept is sound — not all signals are equal, and weighting them by historical accuracy improves expectancy.", bestEnv: "Longer-term strategy evaluation — requires 100+ trades of historical data to be statistically valid", whenToAvoid: "Real-time intraday decisions — the latency and complexity don't suit execution timescales", related: ["Expectancy = (Win% × Avg Win) − (Loss% × Avg Loss)", "Momentum factor on 12-1 month returns"] },
};

const WEIGHT_STYLES = {
  HIGH:   { color: "#f85149", bg: "rgba(248,81,73,0.08)",  border: "#6b1a1a", leftBorder: "#f85149" },
  MEDIUM: { color: "#d29922", bg: "rgba(210,153,34,0.07)", border: "#6b4a00", leftBorder: "#d29922" },
  LOW:    { color: "#484f58", bg: "rgba(72,79,88,0.08)",   border: "#2d333b", leftBorder: "#30363d" },
};

function useTypewriter(text, speed = 13) {
  const [displayed, setDisplayed] = useState("");
  useEffect(() => {
    if (!text) { setDisplayed(""); return; }
    setDisplayed("");
    let i = 0;
    const id = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, speed);
    return () => clearInterval(id);
  }, [text]);
  return displayed;
}

function XavierCommentary({ rule, session, prices, headlines }) {
  const [loading, setLoading]     = useState(false);
  const [commentary, setCommentary] = useState("");
  const [deeper, setDeeper]       = useState(false);
  const displayed = useTypewriter(commentary);

  useEffect(() => {
    if (!rule) { setCommentary(""); return; }
    const detail = DOCTRINE_DETAILS[rule];
    setLoading(true);
    setCommentary("");
    setDeeper(false);
    const snap = Object.entries(prices || {}).slice(0, 4).map(([p, v]) => `${p}: ${v}`).join(", ");
    callClaude(
      `Trading rule: "${rule}"\nXavier's base note: "${detail?.xavierNote || ""}"\nCurrent session: ${session}\nMarket prices: ${snap}\nHeadline: "${headlines?.[0] || ""}"\n\nGive a live commentary connecting this rule to what's happening RIGHT NOW. Mention the session and what pairs or conditions make this rule relevant today. Max 55 words. First person, contractions, no bullet points.`,
      "You are Xavier, a Calgary-based forex prop trader. Direct, confident, occasionally dry. Contractions always. No corporate phrasing. Max 55 words.",
      180
    ).then(text => setCommentary(text))
     .catch(() => setCommentary(detail?.xavierNote || "Check your API connection."))
     .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rule]);

  const detail = rule ? DOCTRINE_DETAILS[rule] : null;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ padding: "12px 14px", borderBottom: "1px solid #21262d", display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ position: "relative" }}>
          <div style={{ width: 28, height: 28, borderRadius: "50%", background: "linear-gradient(135deg, #1f4e8c 0%, #0d1117 100%)", border: "1px solid #388bfd", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: "#58a6ff", fontFamily: FONT_MONO }}>X</span>
          </div>
          <motion.div animate={{ scale: [1, 1.5, 1], opacity: [1, 0.3, 1] }} transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }} style={{ position: "absolute", bottom: 1, right: 1, width: 7, height: 7, borderRadius: "50%", background: "#3fb950", border: "2px solid #0d1117" }} />
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em" }}>Xavier on this rule</div>
          <div style={{ fontSize: 9, color: "#3fb950" }}>● Live · {session}</div>
        </div>
      </div>

      {/* Commentary */}
      <div style={{ padding: "14px 14px 0" }}>
        {!rule ? (
          <div style={{ fontSize: 11, color: "#484f58", lineHeight: 1.75, fontStyle: "italic" }}>
            Click any rule to get my take on how it applies to today's market.
          </div>
        ) : loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {[1, 0.65, 0.4].map((op, i) => (
              <div key={i} style={{ height: 11, background: "#161b22", borderRadius: 4, opacity: op }} />
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: "#c9d1d9", lineHeight: 1.8, fontStyle: "italic" }}>
            "{displayed}"
          </div>
        )}
      </div>

      {/* Rule detail cards */}
      {detail && !loading && commentary && (
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: "9px 11px" }}>
            <div style={{ fontSize: 9, color: "#484f58", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>Best Environment</div>
            <div style={{ fontSize: 10, color: "#8b949e", lineHeight: 1.6 }}>{detail.bestEnv}</div>
          </div>
          <div style={{ background: "rgba(248,81,73,0.04)", border: "1px solid rgba(248,81,73,0.14)", borderRadius: 8, padding: "9px 11px" }}>
            <div style={{ fontSize: 9, color: "#f85149", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>When to Avoid</div>
            <div style={{ fontSize: 10, color: "#8b949e", lineHeight: 1.6 }}>{detail.whenToAvoid}</div>
          </div>
          {detail.related?.length > 0 && (
            <div>
              <div style={{ fontSize: 9, color: "#484f58", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>Related Rules</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {detail.related.map(r => (
                  <div key={r} style={{ fontSize: 9, padding: "2px 7px", borderRadius: 10, background: "#161b22", border: "1px solid #21262d", color: "#8b949e", lineHeight: 1.5 }}>
                    {r.length > 32 ? r.slice(0, 32) + "…" : r}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Ask Xavier button */}
      {rule && !loading && (
        <div style={{ padding: "0 14px 14px" }}>
          <button
            onClick={() => {
              const detail = DOCTRINE_DETAILS[rule];
              setCommentary("");
              setLoading(true);
              const snap = Object.entries(prices || {}).slice(0, 4).map(([p, v]) => `${p}: ${v}`).join(", ");
              callClaude(
                `Trading rule: "${rule}"\nSession: ${session}\nPrices: ${snap}\nHeadline: "${headlines?.[0] || ""}"\n\nGive a deeper, more specific take on this rule. Connect it to a concrete market scenario today. What would Van Tharp or a Market Wizard do here? Max 80 words. First person, contractions, no bullet points.`,
                "You are Xavier, a Calgary-based forex prop trader with deep knowledge of Van Tharp and Market Wizards. Direct, confident, human. Contractions always. Max 80 words.",
                250
              ).then(text => setCommentary(text))
               .catch(() => setCommentary(detail?.xavierNote || "Check your connection."))
               .finally(() => setLoading(false));
            }}
            style={{ width: "100%", fontSize: 11, padding: "8px 12px", borderRadius: 8, cursor: "pointer", border: "1px solid #21262d", background: "transparent", color: "#8b949e", fontFamily: "inherit", transition: "all 0.15s", textAlign: "center", fontWeight: 500 }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#388bfd"; e.currentTarget.style.color = "#58a6ff"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#21262d"; e.currentTarget.style.color = "#8b949e"; }}
          >Ask Xavier for more →</button>
        </div>
      )}
    </div>
  );
}

function DoctrineCard({ rule, detail, catColor, isExpanded, isSelected, onToggle, onSelect }) {
  const weight  = detail?.weight || "MEDIUM";
  const wStyle  = WEIGHT_STYLES[weight] || WEIGHT_STYLES.MEDIUM;

  return (
    <div
      onClick={() => { onToggle(); onSelect(rule); }}
      style={{ background: isSelected ? `${catColor}0c` : "#161b22", borderTop: `1px solid ${isSelected ? catColor : "#21262d"}`, borderRight: `1px solid ${isSelected ? catColor : "#21262d"}`, borderBottom: `1px solid ${isSelected ? catColor : "#21262d"}`, borderLeft: `3px solid ${wStyle.leftBorder}`, borderRadius: 8, cursor: "pointer", overflow: "hidden", transition: "border-color 0.15s, background 0.15s" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px" }}>
        <div style={{ flex: 1, fontSize: 12, color: isSelected ? "#e6edf3" : "#c9d1d9", lineHeight: 1.4, fontWeight: isSelected ? 600 : 400 }}>{rule}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <div style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: wStyle.bg, border: `1px solid ${wStyle.border}`, color: wStyle.color, fontWeight: 700, letterSpacing: "0.05em" }}>{weight}</div>
          <motion.span animate={{ rotate: isExpanded ? 180 : 0 }} transition={{ duration: 0.18 }} style={{ display: "inline-block", color: "#484f58", fontSize: 10, lineHeight: 1 }}>▾</motion.span>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isExpanded && detail && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: "easeInOut" }} style={{ overflow: "hidden" }}>
            <div style={{ padding: "0 13px 13px", borderTop: "1px solid #21262d", display: "flex", flexDirection: "column", gap: 9 }}>
              <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.65, fontStyle: "italic", paddingTop: 10 }}>{detail.impact}</div>
              <div style={{ background: "rgba(210,153,34,0.06)", border: "1px solid rgba(210,153,34,0.18)", borderRadius: 7, padding: "9px 11px" }}>
                <div style={{ fontSize: 9, color: "#d29922", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>Xavier's Note</div>
                <div style={{ fontSize: 11, color: "#c9d1d9", lineHeight: 1.65 }}>"{detail.xavierNote}"</div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function KnowledgePanel({ activeRule, session = "AVOID", openTrades = [], balance = 100, prices = {}, headlines = [], isMobile = false }) {
  const [category, setCategory]     = useState("marketWizards");
  const [search, setSearch]         = useState("");
  const [expandedRule, setExpanded] = useState(null);
  const [selectedRule, setSelected] = useState(null);

  const cat = KNOWLEDGE_CATS.find(c => c.key === category);

  // Xavier auto-pick on session / heat change
  useEffect(() => {
    const heat = openTrades.length * 1.5;
    let pick;
    if (heat >= 4.5)                                  pick = "Maximum portfolio heat: 6R across all open trades";
    else if (balance < 98)                            pick = "Cut losses short, let winners run";
    else if ((session === "TOKYO") && openTrades.length > 0) pick = "R-multiple system: define your 1R risk before entry";
    else if (session === "LONDON" || session === "PRIME") pick = "EMA 9/21 crossover for trend confirmation";
    else if (session === "NY")                        pick = "Trade with the trend on your primary timeframe";
    else                                              pick = "Discipline and consistency beat intelligence";
    setSelected(pick);
  }, [session, openTrades.length, balance]);

  useEffect(() => { if (activeRule) setSelected(activeRule); }, [activeRule]);

  // Build display items
  let displayItems;
  if (search) {
    displayItems = KNOWLEDGE_CATS.flatMap(c =>
      KNOWLEDGE_BASE[c.key]
        .filter(r => r.toLowerCase().includes(search.toLowerCase()))
        .map(r => ({ rule: r, catKey: c.key, catColor: c.color, catLabel: c.label }))
    );
  } else {
    displayItems = (KNOWLEDGE_BASE[category] || []).map(r => ({
      rule: r, catKey: category, catColor: cat?.color || "#58a6ff", catLabel: cat?.label || "",
    }));
  }

  const leftSidebar = (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Search */}
      <div style={{ position: "relative" }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search doctrine..."
          style={{ width: "100%", fontSize: 11, padding: "8px 12px 8px 30px", borderRadius: 8, border: "1px solid #21262d", background: "#161b22", color: "#e6edf3", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }}
        />
        <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "#484f58", pointerEvents: "none" }}>⌕</span>
      </div>

      {/* Category pills */}
      <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "10px", display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ fontSize: 9, color: "#484f58", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 5, paddingLeft: 2 }}>Categories</div>
        {KNOWLEDGE_CATS.map(c => {
          const isActive = category === c.key && !search;
          return (
            <button key={c.key} onClick={() => { setCategory(c.key); setSearch(""); }}
              style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 10px", borderRadius: 7, cursor: "pointer", border: `1px solid ${isActive ? c.color : "transparent"}`, background: isActive ? `${c.color}12` : "transparent", width: "100%", textAlign: "left", transition: "all 0.15s" }}
            >
              <span style={{ fontSize: 13, flexShrink: 0 }}>{c.icon}</span>
              <span style={{ fontSize: 11, fontWeight: isActive ? 600 : 400, color: isActive ? c.color : "#8b949e", flex: 1 }}>{c.label}</span>
              <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: isActive ? `${c.color}20` : "#21262d", color: isActive ? c.color : "#484f58", fontWeight: 600 }}>{KNOWLEDGE_BASE[c.key].length}</span>
            </button>
          );
        })}
      </div>

      {/* Trending */}
      <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "12px" }}>
        <div style={{ fontSize: 9, color: "#484f58", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Trending</div>
        {KNOWLEDGE_TRENDING.map((update, i) => (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "5px 0", borderBottom: i < KNOWLEDGE_TRENDING.length - 1 ? "0.5px solid #21262d" : "none" }}>
            <span style={{ fontSize: 9, color: "#3fb950", marginTop: 2, flexShrink: 0 }}>↑</span>
            <span style={{ fontSize: 10, color: "#8b949e", lineHeight: 1.5 }}>{update}</span>
          </div>
        ))}
      </div>
    </div>
  );

  const centerCards = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 0 4px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>
          {search ? `"${search}"` : cat?.label}
          <span style={{ fontSize: 11, color: "#484f58", fontWeight: 400, marginLeft: 6 }}>· {displayItems.length} rules</span>
        </div>
        {search && <button onClick={() => setSearch("")} style={{ fontSize: 10, color: "#8b949e", background: "none", border: "none", cursor: "pointer" }}>✕ clear</button>}
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={search || category} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {displayItems.length === 0 && (
            <div style={{ fontSize: 12, color: "#484f58", textAlign: "center", padding: "24px 0", background: "#161b22", borderRadius: 8 }}>No rules match your search.</div>
          )}
          {displayItems.map((item, i) => {
            const showLabel = search && (i === 0 || displayItems[i - 1].catKey !== item.catKey);
            return (
              <motion.div key={item.rule} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16, delay: i * 0.025 }}>
                {showLabel && <div style={{ fontSize: 9, color: "#484f58", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", padding: i === 0 ? "0 2px 5px" : "10px 2px 5px" }}>{item.catLabel}</div>}
                <DoctrineCard
                  rule={item.rule}
                  detail={DOCTRINE_DETAILS[item.rule]}
                  catColor={item.catColor}
                  isExpanded={expandedRule === item.rule}
                  isSelected={selectedRule === item.rule}
                  onToggle={() => setExpanded(p => p === item.rule ? null : item.rule)}
                  onSelect={r => setSelected(r)}
                />
              </motion.div>
            );
          })}
        </motion.div>
      </AnimatePresence>
    </div>
  );

  const rightSidebar = (
    <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, overflow: "hidden" }}>
      <XavierCommentary rule={selectedRule} session={session} prices={prices} headlines={headlines} />
    </div>
  );

  if (isMobile) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 6, overflowX: "auto" }} className="qb-hscroll">
          {KNOWLEDGE_CATS.map(c => {
            const isActive = category === c.key && !search;
            return (
              <button key={c.key} onClick={() => { setCategory(c.key); setSearch(""); }}
                style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 20, cursor: "pointer", border: `1px solid ${isActive ? c.color : "#21262d"}`, background: isActive ? `${c.color}14` : "transparent", whiteSpace: "nowrap", flexShrink: 0 }}
              >
                <span style={{ fontSize: 12 }}>{c.icon}</span>
                <span style={{ fontSize: 11, color: isActive ? c.color : "#8b949e", fontWeight: isActive ? 600 : 400 }}>{c.label}</span>
              </button>
            );
          })}
        </div>
        <div style={{ position: "relative" }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search doctrine..." style={{ width: "100%", fontSize: 11, padding: "8px 12px 8px 30px", borderRadius: 8, border: "1px solid #21262d", background: "#161b22", color: "#e6edf3", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "#484f58", pointerEvents: "none" }}>⌕</span>
        </div>
        {centerCards}
        {rightSidebar}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "200px 1fr 260px", gap: 12, alignItems: "start" }}>
      {leftSidebar}
      {centerCards}
      {rightSidebar}
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

// ─── RISK TAB HELPERS ─────────────────────────────────────────────────────────
function RiskGauge({ heat = 0 }) {
  const safe  = typeof heat === "number" && isFinite(heat) ? Math.max(0, Math.min(8, heat)) : 0;
  const pct   = (safe / 8) * 100;
  const color = safe >= 6 ? "#f85149" : safe >= 4 ? "#d29922" : "#3fb950";
  return (
    <div style={{ width: "100%", padding: "4px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: "#8b949e", fontFamily: FONT_MONO }}>0R</span>
        <span style={{ fontSize: 32, fontWeight: 700, color, fontFamily: FONT_MONO, lineHeight: 1 }}>
          {safe.toFixed(1)}<span style={{ fontSize: 16, marginLeft: 2 }}>R</span>
        </span>
        <span style={{ fontSize: 11, color: "#8b949e", fontFamily: FONT_MONO }}>8R</span>
      </div>
      <div style={{ height: 14, background: "#21262d", borderRadius: 7, overflow: "hidden" }}>
        <div style={{
          height: "100%", width: pct + "%", background: color, borderRadius: 7,
          transition: "width 0.5s ease, background 0.3s ease",
        }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        <span style={{ fontSize: 10, color: "#3fb950", fontFamily: FONT_MONO }}>SAFE</span>
        <span style={{ fontSize: 10, color: "#d29922", fontFamily: FONT_MONO }}>4R CAUTION</span>
        <span style={{ fontSize: 10, color: "#f85149", fontFamily: FONT_MONO }}>6R MAX</span>
      </div>
    </div>
  );
}

function RiskTip({ text, children }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      <AnimatePresence>
        {show && (
          <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.15 }}
            style={{ position: "absolute", bottom: "calc(100% + 8px)", left: "50%",
              transform: "translateX(-50%)", width: 230, padding: "10px 13px",
              background: "#1c2128", border: "1px solid #30363d", borderRadius: 8,
              fontSize: 11, color: "#c9d1d9", lineHeight: 1.65, zIndex: 200,
              boxShadow: "0 8px 28px rgba(0,0,0,0.55)", pointerEvents: "none" }}>
            {text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function RiskTab({ trades, openTrades = [], balance, session = "AVOID" }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60000);
    return () => clearInterval(id);
  }, []);

  const positionCount = openTrades.length;
  const sessionCount  = trades.length;
  const heat          = Math.min(positionCount * 1.5, 8);
  const drawdown      = parseFloat((Math.max(0, 100 - balance)).toFixed(2));
  const pnl           = parseFloat((balance - 100).toFixed(4));
  const heatColor     = heat >= 4 ? "#f85149" : heat >= 2 ? "#d29922" : "#3fb950";

  // ── Derived state ──────────────────────────────────────────────────────────
  const overallStatus  = heat >= 4 || drawdown >= 3 ? "DANGER" : heat >= 2 || drawdown >= 1.5 ? "CAUTION" : "SAFE";
  const cbTriggered    = heat >= 4 || drawdown >= 3;
  const lossStreak     = (() => { const rev = [...trades].reverse(); const idx = rev.findIndex(t => (t.pnl || 0) > 0); return idx === -1 ? rev.length : idx; })();
  const cbReason       = heat >= 4 ? `Heat reached ${heat.toFixed(1)}R` : drawdown >= 3 ? `Daily drawdown ${drawdown.toFixed(2)}% exceeded 3%` : lossStreak >= 3 ? `${lossStreak} consecutive losses` : null;
  const budgetPct      = Math.min(heat / 4 * 100, 100);
  const budgetColor    = heat >= 4 ? "#f85149" : heat >= 2 ? "#d29922" : "#3fb950";
  const pnlSign        = pnl >= 0 ? "+" : "";
  const pnlColor       = pnl >= 0 ? "#3fb950" : "#f85149";

  // ── Next session countdown ─────────────────────────────────────────────────
  const h = new Date().getUTCHours(), m = new Date().getUTCMinutes();
  const bounds = [{ at: 0, name: "Tokyo" }, { at: 4, name: "Sydney" }, { at: 8, name: "London" }, { at: 13, name: "Prime" }, { at: 17, name: "New York" }, { at: 20, name: "Tokyo" }];
  const nb = bounds.find(b => b.at > h) || bounds[0];
  const minsLeft = nb.at > h ? (nb.at - h) * 60 - m : (24 - h + nb.at) * 60 - m;
  const hTN = Math.floor(minsLeft / 60), mTN = minsLeft % 60;
  const nextStr = `${nb.name} opens in ${hTN > 0 ? `${hTN}h ` : ""}${mTN}m`;

  const SESSION_NOTES = {
    TOKYO:  `Tokyo session — quiet markets. I'm being selective. ${nextStr}.`,
    SYDNEY: `Sydney session — thin liquidity. AUD/NZD setups only. ${nextStr}.`,
    LONDON: `London's open. EUR and GBP at full signal strength. ${nextStr}.`,
    PRIME:  `London-NY overlap — peak liquidity window. All pairs eligible. ${nextStr}.`,
    NY:     `New York session. USD pairs are the primary focus. ${nextStr}.`,
    AVOID:  `Markets quiet. No active session — holding off new positions. ${nextStr}.`,
  };
  const xavierNote = SESSION_NOTES[session] || SESSION_NOTES.AVOID;

  // ── Status config ──────────────────────────────────────────────────────────
  const SC = {
    SAFE:    { color: "#3fb950", bg: "rgba(63,185,80,0.05)",  border: "#1a4020", leftBorder: "#3fb950", dot: "●", msg: "SAFE TO TRADE",   sub: "All risk metrics within limits." },
    CAUTION: { color: "#d29922", bg: "rgba(210,153,34,0.06)", border: "#4a3800", leftBorder: "#d29922", dot: "⚠", msg: "CAUTION",          sub: "Heat approaching limit — be selective with new positions." },
    DANGER:  { color: "#f85149", bg: "rgba(248,81,73,0.08)",  border: "#6b1a1a", leftBorder: "#f85149", dot: "●", msg: "TRADING HALTED",   sub: "Circuit breaker active. Close positions to resume." },
  };
  const sc = SC[overallStatus];

  // ── Van Tharp rules ────────────────────────────────────────────────────────
  const vanTharpRules = [
    { rule: "Risk per trade", current: "1.5% / trade", status: "Safe",
      tip: "Xavier never risks more than 1.5% of the account on a single trade. On a $10,000 account that's $150 max risk — so even losing 10 trades in a row only costs 15%." },
    { rule: "ATR stop loss",  current: "1.5× ATR AUTO", status: "Safe",
      tip: "Stop losses are sized automatically using ATR (Average True Range) — a measure of how much a pair normally moves. Volatile pairs get wider stops, calm pairs tighter. Your dollar risk stays constant." },
    { rule: "R:R minimum",   current: "≥ 2.0:1",       status: "Safe",
      tip: "Every trade must offer at least 2× the reward vs. the risk. If risking 1.5%, the target must be 3%. This means Xavier can lose more than half his trades and still make money long-term." },
    { rule: "Max open heat", current: `${heat.toFixed(1)}R / 4R`,
      status: heat < 2 ? "Safe" : heat < 4 ? "Monitor" : "Standby",
      tip: "Heat = combined risk of all open positions. At 1.5R per trade, max 2 open trades = 3R heat. Xavier blocks new trades at 4R — hard limit." },
    { rule: "Circuit breaker", current: `${drawdown.toFixed(2)}% / 3%`,
      status: drawdown < 1 ? "Safe" : drawdown < 2 ? "Monitor" : "Standby",
      tip: "If the account falls 3% in a single day, Xavier halts all new trades. This prevents a bad day from compounding into a catastrophic loss. Existing positions can still be managed normally." },
  ];

  // ── Market session windows ─────────────────────────────────────────────────
  const SESSION_WINDOWS = [
    { name: "Sydney",   start: 22, end: 7,  utc: "22:00–07:00 UTC", vol: "Low",     risk: "LOW",    rColor: "#3fb950", pairs: "AUD/USD, NZD/USD" },
    { name: "Tokyo",    start: 0,  end: 9,  utc: "00:00–09:00 UTC", vol: "Medium",  risk: "MEDIUM", rColor: "#d29922", pairs: "USD/JPY, AUD/USD" },
    { name: "London",   start: 8,  end: 13, utc: "08:00–13:00 UTC", vol: "High",    risk: "LOW",    rColor: "#3fb950", pairs: "EUR/USD, GBP/USD" },
    { name: "Prime",    start: 13, end: 17, utc: "13:00–17:00 UTC", vol: "Extreme", risk: "LOW",    rColor: "#3fb950", pairs: "All pairs" },
    { name: "New York", start: 17, end: 20, utc: "17:00–20:00 UTC", vol: "High",    risk: "MEDIUM", rColor: "#d29922", pairs: "USD/CAD, EUR/USD" },
    { name: "Dead",     start: 20, end: 22, utc: "20:00–22:00 UTC", vol: "Low",     risk: "HIGH",   rColor: "#f85149", pairs: "Avoid all" },
  ];

  // ── Metric cards ───────────────────────────────────────────────────────────
  const metricCards = [
    { label: "PORTFOLIO HEAT", value: `${heat.toFixed(1)}R`, color: heatColor,
      tip: "Total risk across all open positions. Each trade adds 1.5R. Max allowed is 6R." },
    { label: "MAX DRAWDOWN",   value: `${drawdown.toFixed(2)}%`, color: drawdown > 2 ? "#f85149" : drawdown > 1 ? "#d29922" : "#3fb950",
      tip: "How much the account has dropped from its starting point today. Halts at 3%." },
    { label: "OPEN POSITIONS", value: positionCount, color: positionCount > 0 ? "#58a6ff" : "#484f58",
      tip: "Number of live positions with OANDA right now. Each one carries 1.5R of heat." },
    { label: "DAILY P&L",      value: `${pnlSign}${pnl.toFixed(2)}%`, color: pnlColor,
      tip: "Total account performance today — gains minus losses across all closed trades." },
  ];

  const cardBase = { background: "#161b22", border: "1px solid #21262d", borderRadius: 10, padding: "12px 14px" };

  return (
    <div style={{ padding: "0 16px 24px", display: "flex", flexDirection: "column", gap: 14, maxWidth: 960, margin: "0 auto" }}>

      {/* ── Section 1: Risk Status Banner ─────────────────────────────────── */}
      <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
        style={{ padding: "14px 20px", borderRadius: 10, background: sc.bg,
          borderTop: `1px solid ${sc.border}`, borderRight: `1px solid ${sc.border}`, borderBottom: `1px solid ${sc.border}`, borderLeft: `3px solid ${sc.leftBorder}`,
          display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 15, color: sc.color,
            animation: overallStatus === "DANGER" ? "pulse 1.4s ease-in-out infinite" : "none" }}>
            {sc.dot}
          </span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: sc.color, letterSpacing: "0.06em" }}>{sc.msg}</div>
            <div style={{ fontSize: 11, color: "#8b949e", marginTop: 2 }}>{sc.sub}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "#484f58", letterSpacing: "0.05em", textTransform: "uppercase" }}>Heat</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: heatColor, fontFamily: FONT_MONO }}>{heat.toFixed(1)}R</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "#484f58", letterSpacing: "0.05em", textTransform: "uppercase" }}>Drawdown</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: drawdown > 1 ? "#d29922" : "#3fb950", fontFamily: FONT_MONO }}>{drawdown.toFixed(2)}%</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "#484f58", letterSpacing: "0.05em", textTransform: "uppercase" }}>Session</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>{session}</div>
          </div>
        </div>
      </motion.div>

      {/* ── Section 2: Heat Gauge (left) + Van Tharp (right) ─────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "start" }}>

        {/* Left: Gauge */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ background: "#161b22", borderRadius: 12, padding: "14px 12px 12px",
            border: `1px solid ${heat >= 6 ? "rgba(248,81,73,0.25)" : heat >= 4 ? "rgba(210,153,34,0.22)" : "#21262d"}`,
            transition: "border-color 0.5s ease" }}>
            {/* Card header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 4px", marginBottom: 2 }}>
              <span style={{ fontSize: 9.5, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.1em" }}>Portfolio Heat</span>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: heatColor, display: "inline-block",
                  boxShadow: heat >= 4 ? `0 0 7px ${heatColor}88` : "none", transition: "all 0.4s ease" }} />
                <span style={{ fontSize: 9, fontWeight: 700, color: heatColor, letterSpacing: "0.08em",
                  transition: "color 0.4s ease" }}>
                  {heat >= 4 ? "CIRCUIT BREAKER" : heat >= 2 ? "CAUTION" : "ALL CLEAR"}
                </span>
              </div>
            </div>

            {/* Gauge SVG */}
            <RiskGauge heat={heat} />

            {/* Zone legend */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 6px 0", marginTop: 2 }}>
              {[
                { color: "#3fb950", label: "0–4R  SAFE" },
                { color: "#d29922", label: "4–6R  CAUTION" },
                { color: "#f85149", label: "6R+  HALT" },
              ].map(z => (
                <div key={z.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <div style={{ width: 22, height: 3, borderRadius: 2, background: z.color, opacity: 0.55 }} />
                  <span style={{ fontSize: 8, color: "#484f58" }}>{z.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 4 metric cards 2×2 */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {metricCards.map((mc, i) => (
              <RiskTip key={i} text={mc.tip}>
                <div style={{ ...cardBase, width: "100%", cursor: "default" }}>
                  <div style={{ fontSize: 9, color: "#484f58", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 5 }}>{mc.label}</div>
                  <div style={{ fontSize: 19, fontWeight: 800, color: mc.color, fontFamily: FONT_MONO, lineHeight: 1 }}>{mc.value}</div>
                  <div style={{ fontSize: 9, color: "#484f58", marginTop: 4 }}>hover for info</div>
                </div>
              </RiskTip>
            ))}
          </div>
        </div>

        {/* Right: Van Tharp Rules */}
        <div style={{ ...cardBase }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#e6edf3", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 14 }}>Van Tharp Risk Rules</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {vanTharpRules.map((row, i) => {
              const sMap = { Safe: "#3fb950", Monitor: "#d29922", Standby: "#f85149" };
              const sColor = sMap[row.status] || "#3fb950";
              const sBg    = { Safe: "rgba(63,185,80,0.09)", Monitor: "rgba(210,153,34,0.09)", Standby: "rgba(248,81,73,0.09)" }[row.status];
              return (
                <RiskTip key={i} text={row.tip}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "11px 0", borderBottom: i < vanTharpRules.length - 1 ? "0.5px solid #21262d" : "none",
                    width: "100%", cursor: "default" }}>
                    <div>
                      <div style={{ fontSize: 12, color: "#c9d1d9", fontWeight: 500 }}>{row.rule}</div>
                      <div style={{ fontSize: 10, color: "#8b949e", fontFamily: FONT_MONO, marginTop: 2 }}>{row.current}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: sColor, display: "inline-block", flexShrink: 0 }} />
                      <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: sBg, color: sColor, fontWeight: 600 }}>{row.status}</span>
                    </div>
                  </div>
                </RiskTip>
              );
            })}
          </div>
          <div style={{ marginTop: 14, padding: "10px 12px", background: "rgba(88,166,255,0.05)", border: "1px solid rgba(88,166,255,0.12)", borderRadius: 7 }}>
            <div style={{ fontSize: 10, color: "#58a6ff", marginBottom: 3 }}>Why these rules?</div>
            <div style={{ fontSize: 10, color: "#8b949e", lineHeight: 1.6 }}>Van Tharp's position sizing framework ensures no single trade or sequence can destroy the account. Rules are non-negotiable and enforced automatically.</div>
          </div>
        </div>
      </div>

      {/* ── Section 3: Session Summary (left) + Market Sessions (right) ───── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "start" }}>

        {/* Left: Session Summary */}
        <div style={{ ...cardBase }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#e6edf3", textTransform: "uppercase", letterSpacing: "0.04em" }}>Today's Session</div>
            <div style={{ fontSize: 10, color: "#484f58", fontFamily: FONT_MONO }}>{new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            {[
              { label: "Session P&L",   value: `${pnlSign}${pnl.toFixed(2)}%`, color: pnlColor },
              { label: "Trades taken",  value: sessionCount,              color: "#e6edf3" },
              { label: "Risk used",     value: `${heat.toFixed(1)}R`,    color: heatColor },
              { label: "Daily heat",    value: `${heat.toFixed(1)}R`,    color: heatColor },
            ].map((item, i) => (
              <div key={i} style={{ background: "#0d1117", borderRadius: 8, padding: "10px 12px", border: "1px solid #21262d" }}>
                <div style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{item.label}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: item.color, fontFamily: FONT_MONO }}>{item.value}</div>
              </div>
            ))}
          </div>

          {/* Daily budget bar */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
              <span style={{ fontSize: 10, color: "#8b949e" }}>Daily risk budget</span>
              <span style={{ fontSize: 10, color: budgetColor, fontFamily: FONT_MONO }}>{heat.toFixed(1)}R used of 6.0R max</span>
            </div>
            <div style={{ height: 5, background: "#1c2128", borderRadius: 3, overflow: "hidden" }}>
              <motion.div animate={{ width: `${budgetPct}%` }} transition={{ type: "spring", stiffness: 200, damping: 25 }}
                style={{ height: "100%", borderRadius: 3, background: budgetColor }} />
            </div>
          </div>

          {/* Xavier note */}
          <div style={{ padding: "10px 12px", background: "rgba(88,166,255,0.04)", border: "1px solid rgba(88,166,255,0.1)", borderRadius: 7 }}>
            <div style={{ fontSize: 9, color: "#58a6ff", marginBottom: 4, letterSpacing: "0.04em" }}>XAVIER NOTE</div>
            <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.65 }}>{xavierNote}</div>
          </div>
        </div>

        {/* Right: Market Session Risk */}
        <div style={{ ...cardBase }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#e6edf3", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 14 }}>Market Session Risk</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {SESSION_WINDOWS.map((sw, i) => {
              const active = isSessionActive({ start: sw.start, end: sw.end });
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "10px 10px 10px 12px", borderBottom: i < SESSION_WINDOWS.length - 1 ? "0.5px solid #21262d" : "none",
                  borderLeft: active ? "2px solid #3fb950" : "2px solid transparent",
                  background: active ? "rgba(63,185,80,0.04)" : "transparent",
                  borderRadius: active ? "0 4px 4px 0" : 0,
                  marginLeft: active ? -1 : 0,
                  transition: "all 0.2s" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 12, color: active ? "#e6edf3" : "#8b949e", fontWeight: active ? 600 : 400 }}>{sw.name}</span>
                      {active && <span style={{ fontSize: 9, padding: "1px 5px", background: "rgba(63,185,80,0.12)", color: "#3fb950", borderRadius: 3, fontWeight: 600 }}>ACTIVE</span>}
                    </div>
                    <div style={{ fontSize: 9, color: "#484f58", marginTop: 2, fontFamily: FONT_MONO }}>{sw.utc}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: sw.rColor, letterSpacing: "0.04em" }}>{sw.risk}</div>
                    <div style={{ fontSize: 9, color: "#484f58", marginTop: 2 }}>{sw.pairs}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Section 4: Circuit Breaker ─────────────────────────────────────── */}
      <AnimatePresence mode="wait">
        {cbTriggered ? (
          <motion.div key="cb-on" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
            style={{ padding: "18px 20px", borderRadius: 10,
              background: "rgba(248,81,73,0.07)", border: "1px solid rgba(248,81,73,0.3)",
              animation: "pulse-border 1.8s ease-in-out infinite" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 16 }}>🔴</span>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#f85149", letterSpacing: "0.06em" }}>CIRCUIT BREAKER TRIGGERED</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", fontSize: 11, color: "#8b949e", lineHeight: 1.6 }}>
              <span style={{ color: "#f85149", fontWeight: 600 }}>Reason:</span>   <span>{cbReason || "Multiple limits exceeded"}</span>
              <span style={{ color: "#f85149", fontWeight: 600 }}>Action:</span>   <span>All new trade signals are blocked</span>
              <span style={{ color: "#f85149", fontWeight: 600 }}>Resolution:</span> <span>Close open positions to reduce heat below 6R</span>
            </div>
          </motion.div>
        ) : (
          <motion.div key="cb-off" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
            style={{ padding: "16px 20px", borderRadius: 10,
              background: "#161b22", border: "1px solid #21262d",
              display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#3fb950", display: "inline-block",
                boxShadow: "0 0 6px rgba(63,185,80,0.5)" }} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3", letterSpacing: "0.04em" }}>CIRCUIT BREAKER STANDBY</div>
                <div style={{ fontSize: 10, color: "#484f58", marginTop: 2 }}>Monitors: 6R heat limit · 3% daily drawdown · 3 consecutive losses</div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: "#3fb950", fontWeight: 500 }}>All clear — Xavier is executing normally</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── AI COACH TAB ─────────────────────────────────────────────────────────────
function behavioralTags(trade) {
  const tags = [];
  if (trade.score >= 70) tags.push({ label: "High Conf",   color: "#1D9E75" });
  if (trade.score < 50)  tags.push({ label: "Low Conf",    color: "#f85149" });
  if (trade.strategy === "Trend Follow") tags.push({ label: "Trend",    color: "#58a6ff" });
  if (trade.strategy === "Mean Revert")  tags.push({ label: "Reversal", color: "#F97316" });
  if (trade.strategy === "Momentum")     tags.push({ label: "Momentum", color: "#8B5CF6" });
  if (trade.strategy === "Breakout")     tags.push({ label: "Breakout", color: "#d29922" });
  if (trade.aiReason) tags.push({ label: "AI Verified", color: "#d29922" });
  return tags;
}

function xavierTradeNote(trade) {
  const isWin = (trade.pnl || 0) > 0;
  if (isWin && trade.score >= 70) return "Signal was clean and you executed correctly. Good discipline.";
  if (isWin && trade.score >= 60) return "Decent setup, followed through. Keep that execution standard.";
  if (isWin) return "Lower confidence signal that worked out. Take the win, note the setup for review.";
  if (!isWin && trade.aiReason) return "Stop loss hit at the right level. Setup was valid — market just didn't follow through. That's trading.";
  if (!isWin && trade.score >= 65) return "Valid setup, wrong outcome. The system worked correctly — losses within stop range are not mistakes.";
  return "This one didn't meet full signal confidence. Tighter signal filters next time.";
}

const FUNDAMENTALS = [
  { q: "WHAT IS A PIP?", plain: "The smallest price move in forex", a: "A pip is the smallest price movement in forex. EUR/USD moving from 1.1000 to 1.1001 = 1 pip. Xavier measures all stops and targets in pips to keep comparisons consistent across all 8 pairs." },
  { q: "WHAT IS ATR?",   plain: "How much a pair normally moves", a: "ATR (Average True Range) measures how much a pair typically moves in a session. Xavier uses ATR to set stop losses automatically — wider stops for volatile pairs like XAU/USD, tighter for calmer pairs like EUR/USD. This keeps your actual dollar risk consistent." },
  { q: "WHAT IS R-MULTIPLE?", plain: "Profit measured in units of your risk", a: "R is your risk amount per trade. If you risk $15 per trade: +1R = made $15, +2R = made $30, +3R = made $45. Xavier targets +0.583R average across all trades. This means you don't need to win every trade — just let winners run and cut losers short." },
  { q: "WHAT IS PORTFOLIO HEAT?", plain: "Total risk across all open trades at once", a: "Heat = combined risk of all open positions. At 1.5% risk per trade, 4 open trades = 6R heat. Xavier stops taking new trades at 6R to protect the account. If all open trades hit their stop loss at the same time, 6R is the maximum possible loss." },
  { q: "WHAT IS A MEAN REVERT SIGNAL?", plain: "Trading the snap-back after an extreme move", a: "When price moves too far from its average in a short period, it tends to snap back — like a rubber band. Xavier measures this deviation statistically and trades the return to normal. This works best in quiet sessions (Tokyo, Sydney) when markets are ranging rather than trending." },
  { q: "WHAT IS AI CONSENSUS?", plain: "Four AI models voting before every trade", a: "Before any trade, 4 AI models each cast a vote: Claude (risk guardian), GPT-4o (pattern analyst), DeepSeek (quant validator), and Gemini (macro analyst). At least 3 of 4 must vote CONFIRM before Xavier executes. This acts as four independent second opinions and filters out low-quality setups." },
];

const COACH_TIMELINE = [
  { freq: "Real-time", color: "#3fb950", active: true,  desc: "All 4 AI models vote on every signal — no trade executes without 3/4 consensus.", plain: "Every time Xavier spots a potential trade, it checks with 4 different AI systems before doing anything." },
  { freq: "Per trade", color: "#58a6ff", active: true,  desc: "Trade journal entry with behavioral tags and Xavier coaching note created automatically.", plain: "After each trade closes, Xavier writes a note explaining what happened, what went right, and what to watch for next time." },
  { freq: "Hourly",    color: "#8B5CF6", active: true,  desc: "Strategy Intelligence Engine checks live performance and switches strategy if data supports it.", plain: "Once an hour, the system checks whether the current trading strategy is still the best match for market conditions." },
  { freq: "Daily",     color: "#d29922", active: true,  desc: "Full session summary: P&L, win rate, average R-multiple, open position status.", plain: "At end of each trading day, a full summary is generated showing every trade taken and the overall result." },
  { freq: "Weekly",    color: "#F97316", active: false, desc: "Knowledge base sync with trending pattern performance data.", plain: "Once a week, the system updates its understanding of which chart patterns and strategies are performing best in live markets." },
  { freq: "Monthly",   color: "#484f58", active: false, desc: "Full coaching report with personalized improvement recommendations.", plain: "Once a month, Xavier generates a detailed report reviewing your trading history and identifying your biggest areas for improvement." },
];

const QUICK_START = [
  { step: 1, title: "Watch the Markets tab", detail: "Xavier scans 8 currency pairs automatically every few seconds. A green signal score means a potential trade has been identified. You don't need to do anything — just observe what gets flagged." },
  { step: 2, title: "Let the AI consensus run", detail: "When Xavier finds a strong signal, 4 AI models vote on whether to take it. You'll see the vote results appear in the chart panel. A trade only executes if 3 or 4 models agree." },
  { step: 3, title: "Read the Rejection Log", detail: "Every trade that gets blocked is logged with the reason. Reading rejections teaches you why Xavier passes on certain setups — usually it's risk rules, timing, or a split AI vote." },
  { step: 4, title: "Check Analytics after 30+ trades", detail: "Once you have enough trade history, the Analytics tab shows your win rate, average R-multiple, and equity curve. This is where you see if the system is performing as expected." },
  { step: 5, title: "Ask Xavier anything", detail: "Switch to the Ask Xavier tab anytime. He explains every decision in plain English — session conditions, why a signal fired, what the AI models said, and what to expect next." },
];

function CoachTooltip({ text, children }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative", display: "flex", width: "100%" }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div style={{ position: "absolute", bottom: "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)", background: "#21262d", border: "1px solid #30363d", borderRadius: 7, padding: "8px 11px", fontSize: 10, color: "#c9d1d9", lineHeight: 1.65, width: 220, zIndex: 200, pointerEvents: "none", boxShadow: "0 4px 16px rgba(0,0,0,0.5)" }}>
          {text}
        </div>
      )}
    </div>
  );
}

function AICoachTab({ trades, closedTrades = [], isMobile, session = "AVOID", strategy = "Mean Revert", openTrades = [] }) {
  const [loading, setLoading]           = useState(false);
  const [coachOutput, setCoachOutput]   = useState(null);
  const [expandedFund, setExpandedFund] = useState(null);
  const [expandedTime, setExpandedTime] = useState(null);

  const heat = (openTrades.length * 1.5).toFixed(1);

  // ── Performance metrics — real OANDA closed trades + xavier_memory ──────────
  const perfData = useMemo(() => {
    // Primary: closedTrades prop (live from OANDA polling)
    // Backup:  qb_closed_trades in localStorage (survives page refresh)
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem('qb_closed_trades') || '[]'); } catch {}
    const effective = closedTrades.length > 0 ? closedTrades : stored;

    // Xavier memory — adds trades from before this session (e.g. seeded history)
    let memTrades = [];
    try { memTrades = JSON.parse(localStorage.getItem('xavier_memory') || '{"trades":[]}').trades || []; } catch {}
    const closedIds = new Set(effective.map(t => String(t.oandaId || t.id)));
    const extra = memTrades.filter(t => !closedIds.has(String(t.id)));

    const all = [...effective, ...extra];
    if (all.length === 0) return { total: 0, wins: 0, winRate: "0.0", avgR: "0.00", bestR: null, worstR: null };

    const wins    = all.filter(t => (t.realizedPL != null ? t.realizedPL : t.outcome === 'WIN' ? 1 : -1) > 0).length;
    const rVals   = all.map(t => t.rMultiple).filter(r => r != null && !isNaN(r));
    const avgR    = rVals.length > 0 ? (rVals.reduce((s, r) => s + r, 0) / rVals.length).toFixed(2) : "0.00";
    const bestR   = rVals.length > 0 ? Math.max(...rVals).toFixed(2) : null;
    const worstR  = rVals.length > 0 ? Math.min(...rVals).toFixed(2) : null;
    return {
      total:   all.length,
      wins,
      winRate: ((wins / all.length) * 100).toFixed(1),
      avgR,
      bestR,
      worstR,
    };
  }, [closedTrades]);

  // Legacy session metrics (used for coaching context + journal only)
  const totalTrades = trades.length;
  const wins        = trades.filter(t => (t.pnl || 0) > 0).length;
  const winRate     = perfData.winRate;
  const avgR        = perfData.avgR;

  const xavierContext = (() => {
    if (totalTrades === 0) {
      const nextSess = { TOKYO: "London", LONDON: "Prime", PRIME: "New York", NY: "Sydney", SYDNEY: "Tokyo", AVOID: "London" }[session] || "the next session";
      return `The best trade is sometimes no trade. ${session === "AVOID" ? "Markets are quiet right now — I'm being selective." : `${session} session is live and I'm scanning.`} Watching all 8 pairs and waiting for clean setups. ${nextSess} opens next.`;
    }
    if (wins === totalTrades) return `You're running clean today. ${totalTrades} trade${totalTrades !== 1 ? "s" : ""}, all winners, disciplined execution. Keep doing exactly this.`;
    if (wins === 0)           return `Tough session — but the system is working correctly. Losses within stop loss range are not mistakes, they're the cost of doing business. The edge plays out over hundreds of trades, not ten.`;
    const recentLoss = trades.slice(-2).every(t => (t.pnl || 0) <= 0);
    if (recentLoss) return `Last couple of trades went against us. That happens. The discipline is not changing the system mid-drawdown. Stick to the signals.`;
    return `Mixed session. ${wins} win${wins !== 1 ? "s" : ""}, ${totalTrades - wins} loss${totalTrades - wins !== 1 ? "es" : ""}. System is generating valid signals — risk management looks correct.`;
  })();

  const analyze = async () => {
    if (trades.length === 0) return;
    setLoading(true);
    const summary = trades.map(t => `${t.pair} ${t.dir} @ ${t.price} via ${t.strategy} (signal: ${t.score}%, pnl: ${t.pnl?.toFixed ? t.pnl.toFixed(4) : "N/A"}%)`).join("\n");
    try {
      const result = await callClaude(
        `My recent trades:\n${summary}\n\nSession: ${session} | Strategy: ${strategy} | Heat: ${heat}R\n\nRespond in EXACTLY this format:\nSTRENGTH: [one strength, max 20 words]\nWEAKNESS: [one weakness, max 20 words]\nACTION: [one specific action to take, max 20 words]`,
        "You are Xavier, a trading mentor who's seen it all — the blown accounts, the discipline failures, the occasional stretches of brilliance. Talk like a human — direct, honest, occasionally uncomfortable when the trades deserve it. No bullet points. Use Van Tharp R-multiple principles.",
        300
      );
      const lines = {};
      result.split("\n").forEach(line => {
        const idx = line.indexOf(":");
        if (idx > 0) lines[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      });
      setCoachOutput(lines);
    } catch {
      setCoachOutput({ STRENGTH: "Can't reach the models", WEAKNESS: "Check your API connection", ACTION: "Verify VITE_ANTHROPIC_KEY in .env" });
    }
    setLoading(false);
  };

  const secHead = (label) => (
    <div style={{ fontSize: 10, fontWeight: 700, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.09em", marginBottom: 14, paddingBottom: 8, borderBottom: "1px solid #21262d" }}>{label}</div>
  );

  return (
    <div style={{ padding: isMobile ? "0 12px" : "0 16px", display: "flex", flexDirection: "column", gap: 18 }}>

      {/* ── SECTION 1: Performance Metrics (real closed OANDA trades) ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          {[
            { label: "Closed Trades", value: perfData.total, suffix: "", color: "#e6edf3", tip: "Total completed trades recorded from OANDA and Xavier memory. Includes all sessions, not just today." },
            { label: "Win Rate",      value: winRate,         suffix: "%", color: parseFloat(winRate) >= 50 ? "#3fb950" : parseFloat(winRate) > 0 ? "#d29922" : "#8b949e", tip: "Percentage of closed trades that made money. A 50% win rate is healthy — the edge comes from making more on winners than losers, not from winning every trade." },
            { label: "Avg R-Multiple", value: avgR,           suffix: "R", color: parseFloat(avgR) > 0 ? "#3fb950" : parseFloat(avgR) < 0 ? "#f85149" : "#8b949e", tip: "Profit measured in units of risk. +1R = made back what you risked. +2R = made double. Calculated from real OANDA realizedPL." },
          ].map(({ label, value, suffix, color, tip }) => (
            <CoachTooltip key={label} text={tip}>
              <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 10, padding: "13px 14px", width: "100%", cursor: "default" }}>
                <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: FONT_MONO, lineHeight: 1 }}>
                  {value}<span style={{ fontSize: 12, marginLeft: 2 }}>{suffix}</span>
                </div>
                <div style={{ fontSize: 11, color: "#8b949e", marginTop: 5 }}>{label}</div>
                <div style={{ fontSize: 9, color: "#484f58", marginTop: 3, lineHeight: 1.4 }}>Hover for explanation</div>
              </div>
            </CoachTooltip>
          ))}
        </div>

        {/* Best / Worst R row */}
        {(perfData.bestR !== null || perfData.worstR !== null) && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 10, padding: "10px 14px" }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#3fb950", fontFamily: FONT_MONO, lineHeight: 1 }}>
                {perfData.bestR !== null ? `+${perfData.bestR}` : "—"}<span style={{ fontSize: 11, marginLeft: 2 }}>R</span>
              </div>
              <div style={{ fontSize: 11, color: "#8b949e", marginTop: 4 }}>Best Trade</div>
            </div>
            <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 10, padding: "10px 14px" }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: parseFloat(perfData.worstR) < 0 ? "#f85149" : "#8b949e", fontFamily: FONT_MONO, lineHeight: 1 }}>
                {perfData.worstR !== null ? perfData.worstR : "—"}<span style={{ fontSize: 11, marginLeft: 2 }}>R</span>
              </div>
              <div style={{ fontSize: 11, color: "#8b949e", marginTop: 4 }}>Worst Trade</div>
            </div>
          </div>
        )}
      </div>

      {/* ── SECTION 2: Trade Review + Coaching ── */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 14, alignItems: "start" }}>

        {/* LEFT: Trade Journal */}
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px" }}>
          {secHead("Trade Journal")}
          {trades.length === 0 ? (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ fontSize: 32, marginBottom: 10 }}>📋</div>
              <div style={{ fontSize: 12, color: "#8b949e", lineHeight: 1.7 }}>No trades yet this session.</div>
              <div style={{ fontSize: 11, color: "#484f58", marginTop: 6, lineHeight: 1.65 }}>When Xavier executes a trade, it'll appear here with a coaching note explaining what happened and why the trade was taken.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 420, overflowY: "auto" }}>
              <AnimatePresence initial={false}>
                {trades.slice().reverse().map((t) => {
                  const tags = behavioralTags(t);
                  const isWin = (t.pnl || 0) > 0;
                  const rMult = t.pnl != null ? (isWin ? "+" : "") + (t.pnl / 1.5).toFixed(2) + "R" : null;
                  return (
                    <motion.div key={t.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
                      style={{ padding: "11px 13px", borderRadius: 9, background: "#161b22", borderTop: `1px solid ${isWin ? "rgba(63,185,80,0.18)" : "rgba(248,81,73,0.18)"}`, borderRight: `1px solid ${isWin ? "rgba(63,185,80,0.18)" : "rgba(248,81,73,0.18)"}`, borderBottom: `1px solid ${isWin ? "rgba(63,185,80,0.18)" : "rgba(248,81,73,0.18)"}`, borderLeft: `3px solid ${isWin ? "#3fb950" : "#f85149"}` }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "#e6edf3", fontFamily: FONT_MONO }}>{t.pair}</span>
                        <span style={{ fontSize: 10, fontWeight: 600, color: t.dir === "LONG" ? "#3fb950" : "#f85149", background: t.dir === "LONG" ? "rgba(63,185,80,0.1)" : "rgba(248,81,73,0.1)", padding: "1px 6px", borderRadius: 4 }}>{t.dir === "LONG" ? "▲ BUY" : "▼ SELL"}</span>
                        {rMult && <span style={{ fontSize: 10, fontFamily: FONT_MONO, color: isWin ? "#3fb950" : "#f85149", marginLeft: "auto" }}>{rMult}</span>}
                        <span style={{ fontSize: 9, color: "#484f58" }}>{t.time}</span>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 7 }}>
                        {tags.map((tag, j) => (
                          <span key={j} style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: `${tag.color}18`, color: tag.color, border: `0.5px solid ${tag.color}40`, fontWeight: 600 }}>{tag.label}</span>
                        ))}
                        <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: isWin ? "rgba(63,185,80,0.08)" : "rgba(248,81,73,0.08)", color: isWin ? "#3fb950" : "#f85149", border: `0.5px solid ${isWin ? "rgba(63,185,80,0.3)" : "rgba(248,81,73,0.3)"}`, fontWeight: 600 }}>{isWin ? "✓ WIN" : "✗ LOSS"}</span>
                      </div>
                      <div style={{ fontSize: 10, color: "#8b949e", lineHeight: 1.65, fontStyle: "italic", borderTop: "1px solid #21262d", paddingTop: 7 }}>
                        <span style={{ color: "#58a6ff", fontStyle: "normal", fontWeight: 600, marginRight: 5 }}>Xavier:</span>
                        {xavierTradeNote(t)}
                      </div>
                      {t.aiReason && <div style={{ fontSize: 9, color: "#484f58", marginTop: 4 }}>AI verdict: "{t.aiReason}"</div>}
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
          {trades.length > 0 && (
            <div style={{ marginTop: 10, padding: "8px 10px", background: "rgba(210,153,34,0.05)", border: "1px solid rgba(210,153,34,0.15)", borderRadius: 7, fontSize: 10, color: "#8b949e", lineHeight: 1.6 }}>
              <span style={{ color: "#d29922", fontWeight: 600 }}>Stop loss explained: </span>
              A stop loss automatically closes your trade if price moves against you by a set amount. Xavier sets it based on ATR — how much the pair normally moves — so it's not hit by random noise.
            </div>
          )}
        </div>

        {/* RIGHT: Xavier Coaching */}
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{ position: "relative" }}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", background: "linear-gradient(135deg, #1f4e8c 0%, #0d1117 100%)", border: "1px solid #388bfd", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#58a6ff", fontFamily: FONT_MONO }}>X</span>
              </div>
              <motion.div animate={{ scale: [1, 1.5, 1], opacity: [1, 0.3, 1] }} transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
                style={{ position: "absolute", bottom: 1, right: 1, width: 8, height: 8, borderRadius: "50%", background: "#3fb950", border: "2px solid #0d1117" }} />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em" }}>Xavier's Coaching</div>
              <div style={{ fontSize: 9, color: "#3fb950" }}>● Live · {session} session</div>
            </div>
            <button onClick={analyze} disabled={loading || trades.length === 0}
              style={{ marginLeft: "auto", fontSize: 10, padding: "6px 12px", borderRadius: 6, cursor: trades.length === 0 ? "not-allowed" : "pointer", border: "1px solid rgba(210,153,34,0.35)", background: "rgba(210,153,34,0.07)", color: trades.length === 0 ? "#484f58" : "#d29922", fontWeight: 600, fontFamily: "inherit", opacity: trades.length === 0 ? 0.45 : 1, whiteSpace: "nowrap" }}
            >{loading ? "Coaching…" : "Coach me ↗"}</button>
          </div>

          <div style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: 9, padding: "12px 14px" }}>
            <div style={{ fontSize: 11, color: "#c9d1d9", lineHeight: 1.8, fontStyle: "italic" }}>"{xavierContext}"</div>
          </div>

          {loading && <div style={{ fontSize: 11, color: "#58a6ff", textAlign: "center", padding: "10px 0" }}>Going through your trades — give me a second…</div>}

          {coachOutput && !loading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                { key: "STRENGTH", label: "Strength",  sub: "What you're doing right", color: "#1D9E75", bg: "rgba(29,158,117,0.06)",  border: "rgba(29,158,117,0.18)", icon: "↑" },
                { key: "WEAKNESS", label: "Weakness",  sub: "What to work on",          color: "#f85149", bg: "rgba(248,81,73,0.06)",   border: "rgba(248,81,73,0.18)", icon: "↓" },
                { key: "ACTION",   label: "Action",    sub: "Do this next",             color: "#d29922", bg: "rgba(210,153,34,0.06)",  border: "rgba(210,153,34,0.18)", icon: "→" },
              ].map(card => (
                <div key={card.key} style={{ padding: "11px 13px", borderRadius: 8, background: card.bg, border: `1px solid ${card.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: card.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{card.icon} {card.label}</span>
                    <span style={{ fontSize: 9, color: "#484f58" }}>— {card.sub}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "#c9d1d9", lineHeight: 1.65 }}>{coachOutput[card.key] || "—"}</div>
                </div>
              ))}
            </div>
          )}

          {!coachOutput && !loading && trades.length === 0 && (
            <div style={{ fontSize: 11, color: "#484f58", textAlign: "center", lineHeight: 1.7 }}>Execute your first trade to unlock personalized coaching. Xavier will analyze your decisions and give you specific things to improve.</div>
          )}
          {!coachOutput && !loading && trades.length > 0 && (
            <div style={{ fontSize: 11, color: "#484f58", textAlign: "center", lineHeight: 1.6 }}>Hit "Coach me ↗" and Xavier will review every trade and tell you exactly what's working and what's costing you.</div>
          )}
        </div>
      </div>

      {/* ── SECTION 3: Trading Fundamentals ── */}
      <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px" }}>
        {secHead("Trading Fundamentals — Plain English")}
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 6 }}>
          {FUNDAMENTALS.map((f, i) => (
            <div key={i}>
              <div onClick={() => setExpandedFund(expandedFund === i ? null : i)}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: expandedFund === i ? "8px 8px 0 0" : 8, background: "#161b22", border: "1px solid #21262d", cursor: "pointer", transition: "background 0.15s" }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: expandedFund === i ? "#e6edf3" : "#c9d1d9" }}>{f.q}</div>
                  <div style={{ fontSize: 10, color: "#484f58", marginTop: 2 }}>{f.plain}</div>
                </div>
                <motion.span animate={{ rotate: expandedFund === i ? 180 : 0 }} transition={{ duration: 0.18 }}
                  style={{ display: "inline-block", color: "#484f58", fontSize: 10, flexShrink: 0 }}>▾</motion.span>
              </div>
              <AnimatePresence initial={false}>
                {expandedFund === i && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} style={{ overflow: "hidden" }}>
                    <div style={{ padding: "11px 13px 13px", background: "#161b22", borderRadius: "0 0 8px 8px", border: "1px solid #21262d", borderTop: "1px solid #21262d" }}>
                      <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.75 }}>{f.a}</div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>

      {/* ── SECTION 4: Optimization Timeline ── */}
      <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px" }}>
        {secHead("Optimization Schedule")}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {COACH_TIMELINE.map((item, i) => (
            <div key={i}>
              <div onClick={() => setExpandedTime(expandedTime === i ? null : i)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", cursor: "pointer" }}
              >
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0, width: 16 }}>
                  <motion.div animate={item.active ? { opacity: [1, 0.35, 1] } : {}} transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
                    style={{ width: 9, height: 9, borderRadius: "50%", background: item.active ? item.color : "#21262d", border: `1.5px solid ${item.active ? item.color : "#30363d"}` }} />
                  {i < COACH_TIMELINE.length - 1 && <div style={{ width: 1, height: 16, background: "#21262d", marginTop: 3 }} />}
                </div>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: item.active ? item.color : "#484f58", marginRight: 8 }}>{item.freq}</span>
                  <span style={{ fontSize: 11, color: item.active ? "#c9d1d9" : "#8b949e" }}>{item.desc}</span>
                </div>
                <motion.span animate={{ rotate: expandedTime === i ? 180 : 0 }} transition={{ duration: 0.18 }}
                  style={{ display: "inline-block", color: "#484f58", fontSize: 10, flexShrink: 0 }}>▾</motion.span>
              </div>
              <AnimatePresence initial={false}>
                {expandedTime === i && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} style={{ overflow: "hidden" }}>
                    <div style={{ padding: "4px 28px 12px", fontSize: 11, color: "#484f58", lineHeight: 1.7 }}>
                      In plain English: {item.plain}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>

      {/* ── SECTION 5: Quick Start Guide ── */}
      <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: "16px", marginBottom: 8 }}>
        {secHead("Beginner Quick Start Guide")}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {QUICK_START.map(({ step, title, detail }) => (
            <div key={step} style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ width: 24, height: 24, borderRadius: "50%", background: "#161b22", border: "1px solid #21262d", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "#58a6ff", fontFamily: FONT_MONO }}>{step}</span>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3" }}>{title}</div>
                <div style={{ fontSize: 11, color: "#8b949e", marginTop: 3, lineHeight: 1.65 }}>{detail}</div>
              </div>
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

// ─── XAVIER MEMORY ────────────────────────────────────────────────────────────
// Derives session label from a UTC openTime ISO string
function deriveSession(openTimeStr) {
  if (!openTimeStr) return 'UNKNOWN';
  const h = new Date(openTimeStr).getUTCHours();
  if (h >= 22 || h < 4)  return 'SYDNEY';
  if (h >= 4  && h < 8)  return 'TOKYO';
  if (h >= 8  && h < 13) return 'LONDON';
  if (h >= 13 && h < 17) return 'PRIME';
  if (h >= 17 && h < 20) return 'NY';
  return 'AVOID';
}

// Persists a closed trade into xavier_memory localStorage
function updateXavierMemory(closedTrade) {
  // Skip spread-noise trades — only learn from real signal outcomes
  if (Math.abs(closedTrade.rMultiple || 0) < 0.10) return;
  try {
    const memory = JSON.parse(
      localStorage.getItem('xavier_memory') ||
      '{"trades":[],"patterns":{},"recentLessons":[]}'
    );

    // Add trade record
    memory.trades.push({
      id:        closedTrade.id,
      pair:      closedTrade.pair,
      direction: closedTrade.direction,
      session:   closedTrade.session,
      strategy:  closedTrade.strategy,
      score:     closedTrade.score,
      outcome:   closedTrade.pnl > 0 ? 'WIN' : 'LOSS',
      rMultiple: closedTrade.rMultiple,
      duration:  closedTrade.duration,
      timestamp: closedTrade.timestamp || Date.now(),
    });

    // Update pattern stats (pair_session_strategy key)
    const patternKey = `${closedTrade.pair}_${closedTrade.session}_${closedTrade.strategy}`;
    if (!memory.patterns[patternKey]) {
      memory.patterns[patternKey] = { attempts: 0, wins: 0, totalR: 0, xavierNote: null };
    }
    const pattern = memory.patterns[patternKey];
    pattern.attempts++;
    if (closedTrade.pnl > 0) pattern.wins++;
    pattern.totalR += (closedTrade.rMultiple || 0);

    // Generate lesson only on meaningful losses — skip spread noise
    if (closedTrade.pnl < 0 && Math.abs(closedTrade.rMultiple || 0) >= 0.10) {
      memory.recentLessons.unshift(
        `${closedTrade.pair} ${closedTrade.session} ${closedTrade.strategy} lost ${closedTrade.rMultiple}R — review setup conditions`
      );
      memory.recentLessons = memory.recentLessons.slice(0, 10);
    }

    // Cap at 100 trades
    memory.trades = memory.trades.slice(-100);

    localStorage.setItem('xavier_memory', JSON.stringify(memory));
    console.log('[XAVIER MEMORY] updated —', memory.trades.length, 'trades remembered');
  } catch (e) {
    console.error('[XAVIER MEMORY] update failed:', e.message);
  }
}

// ─── CLOSED TRADES PANEL ─────────────────────────────────────────────────────
function ClosedTradesPanel({ trades, isMobile }) {
  if (trades.length === 0) return null;
  const wins = trades.filter(t => t.realizedPL > 0);
  const winRate = Math.round(wins.length / trades.length * 100);
  const totalPL = trades.reduce((s, t) => s + t.realizedPL, 0);

  return (
    <div style={isMobile
      ? { background: "#0d1117", padding: "12px", marginTop: 4 }
      : { background: "#161b22", border: "1px solid #21262d", borderRadius: 10, padding: "12px 14px", margin: "8px 16px 0" }
    }>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.5px" }}>
            Closed Trades
          </span>
          <span style={{ fontSize: 10, color: "#484f58", fontFamily: FONT_MONO }}>
            {trades.length}T · {winRate}% WR
          </span>
        </div>
        <span style={{ fontSize: 11, fontWeight: 600, fontFamily: FONT_MONO, color: totalPL >= 0 ? "#3fb950" : "#f85149" }}>
          {totalPL >= 0 ? "+" : ""}${totalPL.toFixed(2)}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 280, overflowY: "auto" }}>
        {trades.slice(0, 30).map((t) => {
          const isWin = t.realizedPL > 0;
          const closeDate = t.closeTime ? new Date(t.closeTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
          const decimals = t.pair?.includes("JPY") ? 3 : t.pair?.includes("XAU") || t.pair?.includes("SPX") ? 2 : 5;
          return (
            <div
              key={t.oandaId}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "7px 10px", borderRadius: 7,
                background: "#0d1117",
                border: `1px solid ${isWin ? "rgba(63,185,80,0.15)" : "rgba(248,81,73,0.15)"}`,
                borderLeft: `2.5px solid ${isWin ? "#3fb950" : "#f85149"}`,
                fontSize: 11,
              }}
            >
              <span style={{ fontFamily: FONT_MONO, fontWeight: 600, color: "#e6edf3", minWidth: 62 }}>{t.pair}</span>
              <span style={{ fontWeight: 600, color: t.dir === "LONG" ? "#3fb950" : "#f85149", minWidth: 34 }}>{t.dir}</span>
              <span style={{ color: "#484f58", fontFamily: FONT_MONO, flex: 1, fontSize: 10 }}>
                {t.entryPrice?.toFixed(decimals)} → {t.closePrice?.toFixed(decimals)}
              </span>
              <span style={{ fontFamily: FONT_MONO, fontWeight: 600, color: isWin ? "#3fb950" : "#f85149", minWidth: 60, textAlign: "right" }}>
                {isWin ? "+" : ""}${t.realizedPL?.toFixed(2)}
              </span>
              <span style={{ color: isWin ? "#3fb950" : "#f85149", fontFamily: FONT_MONO, fontSize: 10, minWidth: 44, textAlign: "right" }}>
                {t.pips >= 0 ? "+" : ""}{t.pips}p
              </span>
              {t.rMultiple != null && (
                <span style={{ color: isWin ? "#3fb950" : "#f85149", fontFamily: FONT_MONO, fontSize: 10, minWidth: 36, textAlign: "right" }}>
                  {t.rMultiple >= 0 ? "+" : ""}{t.rMultiple}R
                </span>
              )}
              <span style={{ color: "#484f58", fontSize: 10, minWidth: 34, textAlign: "right" }}>{t.duration}</span>
              <span style={{ color: "#484f58", fontSize: 10, minWidth: 30, textAlign: "right" }}>{closeDate}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
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

const SOURCE_COLORS = { bloomberg: "#f85149", reuters: "#f0883e", dailyfx: "#58a6ff", "forex factory": "#d29922", fxstreet: "#3fb950" };
const PAIRS_LIST = ["EUR","USD","GBP","JPY","AUD","CAD","CHF","NZD","GOLD","OIL","BTC","ETH"];

function extractPairs(title) {
  const up = (title || "").toUpperCase();
  return PAIRS_LIST.filter(c => up.includes(c)).slice(0, 4);
}

function getImplication(title, sentiment) {
  const t = (title || "").toLowerCase();
  if (/nfp|cpi|fomc|gdp|rate decision|central bank|\bfed\b|\becb\b|\bboj\b|\brba\b/.test(t))
    return { label: "HIGH VOL", color: "#f0883e", bg: "rgba(240,136,62,0.1)",  border: "#f0883e44" };
  if (/wait|caution|risk off|uncertain|halt|pause|warn/.test(t))
    return { label: "WAIT",     color: "#f85149", bg: "rgba(248,81,73,0.08)",  border: "#f8514944" };
  if (sentiment === "bullish" && /break|surge|rally|soar|climb|gain|rise|bull/.test(t))
    return { label: "MOMENTUM", color: "#58a6ff", bg: "rgba(88,166,255,0.1)",  border: "#58a6ff44" };
  return   { label: "MONITOR", color: "#8b949e", bg: "rgba(139,148,158,0.06)", border: "#30363d"   };
}

const NewsCard = memo(function NewsCard({ item, isMobile }) {
  const [expanded, setExpanded] = useState(false);
  const ss       = sentimentStyle(item.sentiment);
  const sentDot  = item.sentiment === "bullish" ? "#3fb950" : item.sentiment === "bearish" ? "#f85149" : "#484f58";
  const srcColor = SOURCE_COLORS[(item.source || "").toLowerCase()] || "#8b949e";
  const pairs    = extractPairs(item.title);
  const impl     = getImplication(item.title, item.sentiment);

  return (
    <div style={{ background: "#161b22", borderTop: "1px solid #21262d", borderRight: "1px solid #21262d", borderBottom: "1px solid #21262d", borderLeft: `3px solid ${ss.border}`, borderRadius: 8, overflow: "hidden", transition: "background 0.15s" }}
      onMouseEnter={e => e.currentTarget.style.background = "#1c2333"}
      onMouseLeave={e => e.currentTarget.style.background = "#161b22"}>
      <div style={{ padding: isMobile ? "10px 12px" : "12px 16px" }}>
        {/* Source · time · sentiment dot */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }}>
          {item.source && (
            <span style={{ fontSize: 10, fontWeight: 700, color: srcColor, background: `${srcColor}18`, padding: "1px 7px", borderRadius: 4, letterSpacing: "0.04em", textTransform: "uppercase" }}>
              {item.source}
            </span>
          )}
          <span style={{ fontSize: 10, color: "#484f58", marginLeft: "auto" }}>{timeAgo(item.pubDate)}</span>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: sentDot, flexShrink: 0 }} />
        </div>
        {/* Headline */}
        <a href={item.link} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
          <div style={{ fontSize: isMobile ? 13 : 14, fontWeight: 600, color: "#e6edf3", lineHeight: 1.45, marginBottom: 9, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {item.title}
          </div>
        </a>
        {/* Pairs · implication · expand */}
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
          {pairs.map(p => (
            <span key={p} style={{ fontSize: 9, fontFamily: FONT_MONO, color: "#8b949e", background: "#21262d", padding: "1px 6px", borderRadius: 3 }}>{p}</span>
          ))}
          <span style={{ fontSize: 9, fontWeight: 700, color: impl.color, background: impl.bg, border: `1px solid ${impl.border}`, padding: "1px 7px", borderRadius: 4, letterSpacing: "0.05em" }}>
            {impl.label}
          </span>
          {item.description && (
            <button onClick={() => setExpanded(e => !e)}
              style={{ marginLeft: "auto", background: "none", border: "none", color: "#484f58", cursor: "pointer", fontSize: 11, padding: "0 2px", lineHeight: 1 }}>
              {expanded ? "▲" : "▼"}
            </button>
          )}
        </div>
        {/* Expanded summary */}
        {expanded && item.description && (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "0.5px solid #21262d", fontSize: 12, color: "#8b949e", lineHeight: 1.6 }}>
            {item.description}
          </div>
        )}
      </div>
    </div>
  );
});

function NewsTab({ isMobile }) {
  // ── Hydrate from cache on first render — no loading flash ──────────────────
  const [cat, setCat] = useState(() => {
    try { const c = JSON.parse(localStorage.getItem("cached_news")); if (c && Date.now() - c.timestamp < 300000) return c.category; } catch {}
    return "forex";
  });
  const [news, setNews] = useState(() => {
    try { const c = JSON.parse(localStorage.getItem("cached_news")); if (c && Date.now() - c.timestamp < 300000) return c.data; } catch {}
    return [];
  });
  const [commentary, setCommentary] = useState(() => {
    try { const c = JSON.parse(localStorage.getItem("cached_ai_brief")); if (c && Date.now() - c.timestamp < 300000) return c.text; } catch {}
    return null;
  });
  const [loading, setLoading]       = useState(false);
  const [fetchedAt, setFetchedAt]   = useState(null);
  const [error, setError]           = useState(null);
  const [visibleCount, setVisible]  = useState(10);
  const abortRef    = useRef(null);
  const debounceRef = useRef(null);
  const hasCached   = news.length > 0;

  const load = useCallback(async (category, silent = false) => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${BRIDGE}/news?category=${category}`, { signal: ctrl.signal });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      const items = d.items || [];
      setNews(items);
      setCommentary(d.commentary || null);
      setFetchedAt(d.fetchedAt);
      try {
        localStorage.setItem("cached_news", JSON.stringify({ data: items, timestamp: Date.now(), category }));
        if (d.commentary) localStorage.setItem("cached_ai_brief", JSON.stringify({ text: d.commentary, category, timestamp: Date.now() }));
      } catch {}
    } catch (e) {
      if (e.name === "AbortError") return;
      setError(e.message);
      if (!silent) setNews([]);
    }
    if (!silent) setLoading(false);
  }, []);

  const switchCat = useCallback((next) => {
    setCat(next);
    setVisible(10);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load(next), 300);
  }, [load]);

  // Initial fetch — silent if cache exists
  useEffect(() => { load(cat, hasCached); }, []); // eslint-disable-line
  // Background refresh every 5 min
  useEffect(() => { const id = setInterval(() => load(cat, true), 5 * 60_000); return () => clearInterval(id); }, [cat, load]);

  const bullish     = news.filter(n => n.sentiment === "bullish").length;
  const bearish     = news.filter(n => n.sentiment === "bearish").length;
  const visibleNews = news.slice(0, visibleCount);
  const activeCat   = NEWS_CATS.find(c => c.key === cat);

  return (
    <div style={{ padding: isMobile ? "12px" : "0 16px 16px" }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, paddingTop: isMobile ? 0 : 4 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#e6edf3", letterSpacing: "0.06em", textTransform: "uppercase" }}>Live Market Intelligence</div>
          <div style={{ fontSize: 10, color: "#484f58", marginTop: 2, fontFamily: FONT_MONO }}>
            {fetchedAt ? `Updated ${timeAgo(fetchedAt)}` : hasCached ? "Showing cached data" : "—"}
            {news.length > 0 && `  ·  ${bullish}↑ ${bearish}↓`}
          </div>
        </div>
        <button onClick={() => load(cat)} disabled={loading}
          style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: 6, padding: "5px 12px", fontSize: 11, color: loading ? "#484f58" : "#8b949e", cursor: loading ? "default" : "pointer", fontFamily: "inherit", opacity: loading ? 0.5 : 1 }}>
          {loading ? "Loading…" : "↻ Refresh"}
        </button>
      </div>

      {/* ── Category tabs — underline style ────────────────────────────────── */}
      <div style={{ display: "flex", borderBottom: "1px solid #21262d", marginBottom: 14 }}>
        {NEWS_CATS.map(c => (
          <button key={c.key} onClick={() => switchCat(c.key)}
            style={{ padding: "6px 14px", background: "none", border: "none", borderBottom: cat === c.key ? "2px solid #58a6ff" : "2px solid transparent", fontSize: 12, fontWeight: cat === c.key ? 700 : 500, color: cat === c.key ? "#58a6ff" : "#8b949e", cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s", marginBottom: -1 }}>
            {c.label}
          </button>
        ))}
      </div>

      {/* ── Sentiment bar ──────────────────────────────────────────────────── */}
      {news.length > 0 && (
        <div style={{ marginBottom: 14, background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 6 }}>Market Sentiment · {news.length} headlines</div>
          <div style={{ display: "flex", height: 5, borderRadius: 3, overflow: "hidden", gap: 2 }}>
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

      {/* ── Xavier's Market Read ───────────────────────────────────────────── */}
      {commentary && (
        <div style={{ marginBottom: 14, borderRadius: 10, overflow: "hidden", border: "1px solid #1a3a5c", background: "linear-gradient(135deg, #0d1f35 0%, #0d1117 100%)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid #1a3a5c", background: "rgba(56,139,253,0.06)" }}>
            <div style={{ width: 20, height: 20, borderRadius: "50%", background: "linear-gradient(135deg, #1f2d3d, #0d1117)", border: "1px solid #58a6ff44", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#58a6ff", fontWeight: 700, fontFamily: FONT_MONO, flexShrink: 0 }}>X</div>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#58a6ff", letterSpacing: "0.5px", textTransform: "uppercase" }}>Xavier's Market Read</span>
            <span style={{ marginLeft: "auto", fontSize: 10, color: "#484f58" }}>{activeCat?.label}</span>
          </div>
          <div style={{ padding: "12px 14px" }}>
            <p style={{ margin: 0, fontSize: isMobile ? 13 : 14, color: "#c9d1d9", lineHeight: 1.6 }}>{commentary}</p>
          </div>
        </div>
      )}

      {/* ── Cards ──────────────────────────────────────────────────────────── */}
      {error ? (
        <div style={{ padding: "20px 0", textAlign: "center", color: "#f85149", fontSize: 13 }}>
          {error.includes("Failed to fetch") ? "Bridge offline — run: npm run server" : error}
        </div>
      ) : loading && !hasCached ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[...Array(6)].map((_, i) => (
            <div key={i} style={{ background: "#161b22", borderTop: "1px solid #21262d", borderRight: "1px solid #21262d", borderBottom: "1px solid #21262d", borderLeft: "3px solid #21262d", borderRadius: 8, padding: "14px 16px", height: 68 }}>
              <div style={{ height: 11, background: "#21262d", borderRadius: 4, marginBottom: 10, width: `${65 + (i % 3) * 10}%` }} />
              <div style={{ height: 9, background: "#161b22", border: "1px solid #21262d", borderRadius: 10, width: 80 }} />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8 }}>
            {visibleNews.map((item, i) => <NewsCard key={`${cat}-${i}`} item={item} isMobile={isMobile} />)}
          </div>
          {news.length === 0 && !loading && (
            <div style={{ padding: "32px 0", textAlign: "center", color: "#484f58", fontSize: 13 }}>No headlines found</div>
          )}
          {news.length > visibleCount && (
            <button onClick={() => setVisible(v => v + 10)}
              style={{ width: "100%", marginTop: 12, padding: "9px 0", background: "#161b22", border: "1px solid #21262d", borderRadius: 8, color: "#8b949e", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
              Load {Math.min(10, news.length - visibleCount)} more headlines
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ─── OPEN POSITIONS PANEL ─────────────────────────────────────────────────────
function AutoModeSettingsModal({ settings, onSave, onCancel, onResetOnboarding }) {
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

        {/* Reset onboarding — hidden dev option */}
        {onResetOnboarding && (
          <div style={{ borderTop: "1px solid #21262d", paddingTop: 10, textAlign: "center" }}>
            <button onClick={onResetOnboarding} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "#484f58", fontFamily: "inherit", padding: "2px 8px" }}>
              Reset onboarding tour
            </button>
          </div>
        )}
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
          <div key={t.id} style={{ padding: "9px 12px", borderRadius: 8, background: "#0d1117", borderTop: "1px solid #21262d", borderRight: "1px solid #21262d", borderBottom: "1px solid #21262d", borderLeft: "3px solid #484f58" }}>
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

function OpenPositionsPanel({ openTrades, livePrices, onClose, isMobile, mgmtRef, nav }) {
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
            const entry = parseFloat(trade.price);
            const dec = priceDecimals(pair);
            const current = livePrices[pair];
            const dur = tradeDuration(trade.openTime);
            const pnlStr = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
            const oneR = (nav || 100) * 0.015;
            const rMultiple = oneR > 0 ? pnl / oneR : 0;
            const rStr = `${rMultiple >= 0 ? "+" : ""}${rMultiple.toFixed(1)}R`;
            const rColor = rMultiple >= 2 ? "#3fb950" : rMultiple >= 1 ? "#d29922" : rMultiple >= 0 ? "#8b949e" : "#f85149";
            const mgmt = mgmtRef?.current?.[trade.id] || {};
            const isBE    = mgmt.breakevenDone;
            const isTrail = mgmt.trailingActive;
            const sl  = trade.stopLossOrder?.price  ? parseFloat(trade.stopLossOrder.price)  : null;
            const tp  = trade.takeProfitOrder?.price ? parseFloat(trade.takeProfitOrder.price) : null;

            if (isMobile) {
              return (
                <div
                  key={trade.id}
                  style={{ padding: "12px", borderRadius: 10, background: "#161b22", borderTop: "1px solid #21262d", borderRight: "1px solid #21262d", borderBottom: "1px solid #21262d", borderLeft: `3px solid ${isLong ? "#3fb950" : "#f85149"}` }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontWeight: 700, color: "#e6edf3", fontSize: 14 }}>{pair}</span>
                      {isBE    && <span style={{ fontSize: 8, fontWeight: 700, color: "#1D9E75", background: "rgba(29,158,117,0.15)", border: "0.5px solid rgba(29,158,117,0.4)", borderRadius: 3, padding: "1px 4px" }}>BE</span>}
                      {isTrail && <span style={{ fontSize: 8, fontWeight: 700, color: "#58a6ff", background: "rgba(88,166,255,0.15)", border: "0.5px solid rgba(88,166,255,0.4)", borderRadius: 3, padding: "1px 4px" }}>TRAIL</span>}
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, color: isLong ? "#3fb950" : "#f85149" }}>{isLong ? "LONG" : "SHORT"}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, fontFamily: FONT_MONO, fontSize: 11 }}>
                    <span style={{ color: "#8b949e" }}>@ {entry.toFixed(dec)}</span>
                    <span style={{ color: "#c9d1d9" }}>{current ? current.toFixed(dec) : "—"}</span>
                  </div>
                  {(sl !== null || tp !== null) && (
                    <div style={{ display: "flex", gap: 12, marginBottom: 8, fontFamily: FONT_MONO, fontSize: 10 }}>
                      {sl !== null && <span style={{ color: "#8b949e" }}>SL <span style={{ color: "#f85149" }}>{sl.toFixed(dec)}</span></span>}
                      {tp !== null && <span style={{ color: "#8b949e" }}>TP <span style={{ color: "#3fb950" }}>{tp.toFixed(dec)}</span></span>}
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                      <span style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: 14, fontVariantNumeric: "tabular-nums", color: pnl >= 0 ? "#3fb950" : "#f85149" }}>{pnlStr}</span>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: rColor }}>{rStr}</span>
                    </div>
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
                style={{ display: "grid", gridTemplateColumns: "80px 52px 95px 95px 95px auto 60px auto", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 8, background: isLong ? "rgba(29,158,117,0.05)" : "rgba(226,75,74,0.05)", border: `0.5px solid ${isLong ? "rgba(29,158,117,0.2)" : "rgba(226,75,74,0.2)"}`, fontSize: 12 }}
              >
                <span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>{pair}</span>
                <span style={{ color: isLong ? "#1D9E75" : "#E24B4A", fontWeight: 600, fontSize: 11 }}>{isLong ? "LONG" : "SHORT"}</span>
                <span style={{ fontFamily: FONT_MONO, color: "var(--color-text-tertiary)", fontSize: 11 }}>@ {entry.toFixed(dec)}</span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                  {sl !== null ? <span style={{ color: "#f85149" }}>{sl.toFixed(dec)}</span> : <span style={{ color: "#484f58" }}>—</span>}
                </span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                  {tp !== null ? <span style={{ color: "#3fb950" }}>{tp.toFixed(dec)}</span> : <span style={{ color: "#484f58" }}>—</span>}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ fontFamily: FONT_MONO, fontWeight: 600, color: pnl >= 0 ? "#1D9E75" : "#E24B4A", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{pnlStr}</span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: rColor }}>{rStr}</span>
                  {isBE    && <span style={{ fontSize: 8, fontWeight: 700, color: "#1D9E75", background: "rgba(29,158,117,0.15)", border: "0.5px solid rgba(29,158,117,0.4)", borderRadius: 3, padding: "1px 4px", letterSpacing: "0.3px" }}>BE</span>}
                  {isTrail && <span style={{ fontSize: 8, fontWeight: 700, color: "#58a6ff", background: "rgba(88,166,255,0.15)", border: "0.5px solid rgba(88,166,255,0.4)", borderRadius: 3, padding: "1px 4px", letterSpacing: "0.3px" }}>TRAIL</span>}
                </div>
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

// ─── SCHEDULE TAB ─────────────────────────────────────────────────────────────
function ScheduleTab({ isMobile, autoMode = false, enableAutoMode, xavierOpt = {} }) {
  const [now, setNow] = useState(() => new Date());
  const [xavierNote, setXavierNote] = useState(null);
  const [loadingNote, setLoadingNote] = useState(false);
  const [optNotification, setOptNotification] = useState(null);
  const prevOptRunning = useRef(false);
  useEffect(() => {
    if (prevOptRunning.current && !xavierOpt.running && xavierOpt.result) {
      const top = xavierOpt.result.top3?.[0];
      const m5Count = xavierOpt.m5Result?.validatedPairs?.length ?? 0;
      if (top) setOptNotification(`M15+M5 optimization complete — best M15 setup: ${top.pair} ${top.strategy} in ${top.session} at +${top.expectancyR.toFixed(2)}R. ${m5Count} pairs validated for M5 auto-execution.`);
    }
    prevOptRunning.current = !!xavierOpt.running;
  }, [xavierOpt.running]); // eslint-disable-line
  const [scheduleMode, setScheduleMode] = useState(() => localStorage.getItem("scheduleMode") || "auto");
  useEffect(() => localStorage.setItem("scheduleMode", scheduleMode), [scheduleMode]);
  const [sessionPopup, setSessionPopup] = useState(null);
  const autoEnableRef = useRef(enableAutoMode);
  const prevAutoRef   = useRef(null);
  autoEnableRef.current = enableAutoMode;

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Auto-schedule: every 60s check session window + HIGH-impact proximity
  useEffect(() => {
    if (scheduleMode !== "auto" || !enableAutoMode) return;
    const check = () => {
      const mdtNow = new Date(Date.now() - 6 * 3600 * 1000);
      const h = mdtNow.getUTCHours() + mdtNow.getUTCMinutes() / 60;
      const inWindow = h >= 1 && h < 22;
      const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
      const todayName = days[new Date().getDay()];
      const nowM = mdtNow.getUTCHours() * 60 + mdtNow.getUTCMinutes();
      const highSoon = WEEKLY_EVENTS.some(ev => {
        if (ev.day !== todayName || ev.impact !== "HIGH") return false;
        const [tp, ap] = ev.time.split(" ");
        const [hh, mm] = tp.split(":").map(Number);
        const evM = ((ap === "PM" && hh !== 12 ? hh + 12 : ap === "AM" && hh === 12 ? 0 : hh) * 60) + mm;
        return Math.abs(nowM - evM) <= 30;
      });
      const shouldEnable = inWindow && !highSoon;
      if (shouldEnable !== prevAutoRef.current) {
        prevAutoRef.current = shouldEnable;
        autoEnableRef.current?.(shouldEnable);
      }
    };
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, [scheduleMode]);

  // Calgary = MDT = UTC-6
  const mdtMs = now.getTime() - 6 * 3600 * 1000;
  const mdt = new Date(mdtMs);
  const mdtH = mdt.getUTCHours();
  const mdtM = mdt.getUTCMinutes();
  const mdtS = mdt.getUTCSeconds();
  const mdtDecimal = mdtH + mdtM / 60 + mdtS / 3600;

  // Session blocks for 24-hour timeline (Calgary = UTC-6).
  // Tokyo crosses midnight so it's split into two segments for the bar.
  const MDT_SESSIONS = [
    { name: "Sydney",  color: "#0EA5E9", start: 16, end: 22 },
    { name: "Tokyo",   color: "#F97316", start: 22, end: 24 },  // 10pm–midnight
    { name: "Tokyo",   color: "#F97316", start: 0,  end: 2  },  // midnight–2am
    { name: "London",  color: "#8B5CF6", start: 2,  end: 7  },
    { name: "Prime",   color: "#3fb950", start: 7,  end: 11 },
    { name: "NY",      color: "#1D9E75", start: 11, end: 14 },
    { name: "Avoid",   color: "#484f58", start: 14, end: 16 },
  ];
  // Unique session list for legend and active-session detection (no duplicate Tokyo)
  const LEGEND_SESSIONS = [
    { name: "Sydney",  color: "#0EA5E9" },
    { name: "Tokyo",   color: "#F97316" },
    { name: "London",  color: "#8B5CF6" },
    { name: "Prime",   color: "#3fb950" },
    { name: "NY",      color: "#1D9E75" },
    { name: "Avoid",   color: "#484f58" },
  ];

  const getCurSession = (h) => {
    if (h >= 16 && h < 22) return { name: "Sydney",  color: "#0EA5E9" };
    if (h >= 22 || h < 2)  return { name: "Tokyo",   color: "#F97316" };
    if (h >= 2  && h < 7)  return { name: "London",  color: "#8B5CF6" };
    if (h >= 7  && h < 11) return { name: "Prime",   color: "#3fb950" };
    if (h >= 11 && h < 14) return { name: "NY",       color: "#1D9E75" };
    return { name: "Avoid", color: "#484f58" };  // 2pm–4pm Calgary
  };
  const curSession = getCurSession(mdtH);

  // Upcoming tradeable session opens (Avoid excluded — not a trade window)
  const SESSION_OPENS = [
    { name: "Sydney",  startH: 16, color: "#0EA5E9" },
    { name: "Tokyo",   startH: 22, color: "#F97316" },
    { name: "London",  startH: 2,  color: "#8B5CF6" },
    { name: "Prime",   startH: 7,  color: "#3fb950" },
    { name: "NY",      startH: 11, color: "#1D9E75" },
  ];

  const nextSessions = (() => {
    const result = [];
    for (let day = 0; day <= 1 && result.length < 3; day++) {
      for (const s of SESSION_OPENS) {
        const dec = s.startH + day * 24;
        if (dec > mdtDecimal + 0.016) {
          const mins = Math.round((dec - mdtDecimal) * 60);
          result.push({ ...s, remainH: Math.floor(mins / 60), remainM: mins % 60 });
        }
        if (result.length >= 3) break;
      }
    }
    return result;
  })();

  const fmtHour = (h) => {
    if (h === 0 || h === 24) return "12:00 AM";
    if (h === 12) return "12:00 PM";
    return h < 12 ? `${h}:00 AM` : `${h - 12}:00 PM`;
  };

  const XAVIER_SCHEDULE = [
    { window: "4pm – 10pm",  label: "Sydney",  color: "#0EA5E9", startH: 16, endH: 22, pairs: ["AUD/USD", "XAU/USD"],            note: "Sydney's open. Low-volatility breakout session — wait for a clean break of the Asian range. AUD/USD and gold carry the best directional edge here. No NZD/USD, no EUR/USD — spreads are ugly and volume thin on those. Strategy: Breakout. Expectancy +0.97R." },
    { window: "10pm – 2am",  label: "Tokyo",   color: "#F97316", startH: 22, endH: 2,  pairs: ["USD/JPY", "AUD/USD"],            note: "Tokyo's running. Range-bound, low volume — Mean Revert only, half size. JPY pairs have the most structure here. BOJ can surprise you without warning, so stops stay tighter than normal. AUD/USD also carries when RBA isn't in play." },
    { window: "2am – 7am",   label: "London",  color: "#8B5CF6", startH: 2,  endH: 7,  pairs: ["EUR/USD", "GBP/USD", "XAU/USD"], note: "London's just opened. Wait 15–20 minutes before touching anything — let it find direction first. Trend follow and breakout setups on EUR/USD, GBP/USD, gold. ECB or BOE headlines can spike these fast, so stops stay tight. Spreads are wide right at the open." },
    { window: "7am – 11am",  label: "Prime",   color: "#3fb950", startH: 7,  endH: 11, pairs: ["All pairs"],                     note: "This is the window I've been waiting for. London and New York overlap — volume's there, signals are clean, spreads tight. Full allocation, all models running. If I'm going to make money this week, it happens here. Don't miss this window." },
    { window: "11am – 2pm",  label: "NY",      color: "#1D9E75", startH: 11, endH: 14, pairs: ["EUR/USD", "USD/CAD", "USD/JPY"],  note: "US macro at 8:30 ET can move EUR/USD 50 pips before you blink — I'm flat 30 minutes before any data release. After the number drops, momentum continuation on EUR/USD and USD/CAD is where I focus. Ride what London started." },
    { window: "2pm – 4pm",   label: "Avoid",   color: "#484f58", startH: 14, endH: 16, pairs: [],                                note: "Dead zone — nothing worth trading. Volume dries up, spreads widen, signals are noise. I use this time to review the journal and prep for the Sydney open at 4pm." },
  ];

  const SESSION_POPUP_DATA = {
    London: { pairs: ["EUR/USD","GBP/USD","XAU/USD"], strategy: "Trend Follow", size: "Full", note: "BOE and ECB headlines drive this session hard. I wait for the first 15 minutes to play out before sizing in. Trend follow setups on a clean direction candle. Spreads widen right at the open — don't get filled wide." },
    Prime:  { pairs: ["EUR/USD","GBP/USD","USD/CAD","XAU/USD","USD/JPY"], strategy: "All Strategies", size: "Full", note: "Both London and New York running at the same time — spreads are tight, volume is there. All four models running, full allocation. This window is the reason I'm watching at all." },
    NY:     { pairs: ["EUR/USD","USD/CAD","USD/JPY"], strategy: "Momentum", size: "Full", note: "US data at 8:30 ET can move EUR/USD 40-50 pips instantly — I'm out 30 minutes before any release. After the number drops, momentum continuation setups are where I focus. I ride what London started." },
    Tokyo:  { pairs: ["USD/JPY","AUD/USD"], strategy: "Mean Revert", size: "Half", note: "Range-bound, low volume. Mean Revert only, half size. BOJ can surprise you on USD/JPY, so watch the headlines. I keep stops tighter than normal here." },
    Sydney: { pairs: ["AUD/USD","XAU/USD"], strategy: "Breakout", size: "Half", note: "Sydney's open. Low-volatility breakout session — wait for a clean break of the Asian range. AUD/USD and gold carry the best directional edge here. No NZD/USD — spreads are ugly and volume thin." },
    Avoid:  { pairs: [], strategy: "None", size: "None", note: "Dead zone — nothing worth trading. Volume dries up, spreads widen, signals are noise. Use this time to review the journal and prep for the Sydney open at 4pm." },
  };

  const PAIR_MATRIX = {
    "EUR/USD": { London: "green", Prime: "green", NY: "green", Tokyo: "amber", Sydney: "red"   },
    "GBP/USD": { London: "green", Prime: "green", NY: "amber", Tokyo: "red",   Sydney: "red"   },
    "USD/JPY": { London: "amber", Prime: "amber", NY: "green", Tokyo: "green", Sydney: "amber" },
    "USD/CAD": { London: "amber", Prime: "green", NY: "green", Tokyo: "red",   Sydney: "red"   },
    "XAU/USD": { London: "green", Prime: "green", NY: "amber", Tokyo: "red",   Sydney: "red"   },
    "AUD/USD": { London: "red",   Prime: "amber", NY: "amber", Tokyo: "green", Sydney: "green" },
  };
  const MATRIX_COLS   = ["London","Prime","NY","Tokyo","Sydney"];
  const MATRIX_COLORS = { green: "#1D9E75", amber: "#d29922", red: "#f85149" };
  const MATRIX_BG     = { green: "#1D9E7520", amber: "#d2992220", red: "#f8514920" };

  const fetchXavier = async () => {
    setLoadingNote(true);
    const note = await callClaude(
      `It's ${String(mdtH).padStart(2,"0")}:${String(mdtM).padStart(2,"0")} MDT and we're in ${curSession.name}. Tell me what you're watching right now — specific pairs, what you'd trade or avoid, and why. Two or three sentences, no preamble.`,
      "You are Xavier, a prop trader watching the forex market in real time from Calgary. You've seen everything. Talk like a human — direct, confident, occasionally dry. Contractions always. No bullet points. Reference pairs and sessions by name. Don't start with 'I' every sentence."
    );
    setXavierNote(note?.trim() || null);
    setLoadingNote(false);
  };

  const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const dayName  = dayNames[now.getDay()];
  const nowMins  = mdtH * 60 + mdtM;
  const isHighSoon = WEEKLY_EVENTS.some(ev => {
    if (ev.day !== dayName || ev.impact !== "HIGH") return false;
    const [tp, ap] = ev.time.split(" ");
    const [hh, mm] = tp.split(":").map(Number);
    const evM = ((ap === "PM" && hh !== 12 ? hh + 12 : ap === "AM" && hh === 12 ? 0 : hh) * 60) + mm;
    return Math.abs(nowMins - evM) <= 30;
  });
  const activeSessions = LEGEND_SESSIONS.filter(s => {
    if (s.name === "Tokyo") return mdtH >= 22 || mdtH < 2;
    const block = MDT_SESSIONS.find(b => b.name === s.name);
    return block ? mdtH >= block.start && mdtH < block.end : false;
  });
  const autoStatus = scheduleMode === "auto"
    ? (isHighSoon ? "PAUSED" : activeSessions.length > 0 ? "ACTIVE" : "WAITING")
    : "MANUAL";
  const autoStatusColor = { ACTIVE: "#1D9E75", PAUSED: "#d29922", WAITING: "#484f58", MANUAL: "#58a6ff" }[autoStatus];

  const CARD = { background: "#161b22", border: "1px solid #21262d", borderRadius: 12, padding: "16px" };
  const timeStr = `${String(mdtH).padStart(2,"0")}:${String(mdtM).padStart(2,"0")}:${String(mdtS).padStart(2,"0")} MDT`;

  return (
    <div style={{ padding: "0 16px 24px" }}>

      {/* Session Command Center */}
      <div style={{ ...CARD, marginBottom: 16, background: "#0d1117", border: `1px solid ${autoStatusColor}44` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>Command Center</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: autoStatusColor, boxShadow: autoStatus === "ACTIVE" ? `0 0 8px ${autoStatusColor}` : "none" }} />
              <span style={{ fontSize: 14, fontWeight: 700, color: autoStatusColor }}>{autoStatus}</span>
              {isHighSoon && <span style={{ fontSize: 9, background: "#d2992222", color: "#d29922", border: "1px solid #d2992244", borderRadius: 3, padding: "1px 5px", fontWeight: 700 }}>HIGH EVENT ±30m</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {["auto","manual"].map(mode => (
              <button
                key={mode}
                onClick={() => { setScheduleMode(mode); localStorage.setItem("qb_schedMode", mode); }}
                style={{ fontSize: 10, padding: "5px 12px", borderRadius: 5, cursor: "pointer", border: `1px solid ${scheduleMode === mode ? autoStatusColor : "#30363d"}`, background: scheduleMode === mode ? autoStatusColor + "22" : "#161b22", color: scheduleMode === mode ? autoStatusColor : "#484f58", fontFamily: "inherit", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}
              >
                {mode === "auto" ? "AUTO SCHEDULE" : "MANUAL"}
              </button>
            ))}
          </div>
        </div>
        <div style={{ fontSize: 10, color: "#484f58", lineHeight: 1.5 }}>
          {scheduleMode === "auto"
            ? autoStatus === "ACTIVE"   ? `Auto-trading active · ${activeSessions.map(s => s.name).join(", ")} session${activeSessions.length > 1 ? "s" : ""} · Xavier managing execution`
            : autoStatus === "PAUSED"   ? "HIGH-impact event within 30 minutes — auto-trading paused for safety"
            : "Outside trading hours · Xavier monitoring for next session open"
            : "Manual mode — you control when Xavier trades. AUTO SCHEDULE lets Xavier manage session windows automatically."}
        </div>
      </div>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#e6edf3" }}>Trading Schedule</div>
          <div style={{ fontSize: 11, color: "#484f58", fontFamily: FONT_MONO, marginTop: 2 }}>{timeStr}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 9, color: "#484f58", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}>Now</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: curSession.color }}>{curSession.name}</div>
        </div>
      </div>

      {/* 24-hour timeline */}
      <div style={{ ...CARD, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3", marginBottom: 12 }}>
          24-Hour Session Map <span style={{ fontSize: 10, color: "#484f58", fontWeight: 400 }}>Calgary / MDT</span>
        </div>
        <div style={{ position: "relative", height: 44, background: "#0d1117", borderRadius: 6, overflow: "hidden", marginBottom: 8 }}>
          {MDT_SESSIONS.map((s, i) => {
            const x1 = (s.start / 24) * 100;
            const x2 = (Math.min(s.end, 24) / 24) * 100;
            const w = x2 - x1;
            if (w <= 0) return null;
            const isSelected = sessionPopup === s.name;
            return (
              <div
                key={`session-${s.name}-${i}`}
                onClick={() => setSessionPopup(isSelected ? null : s.name)}
                style={{ position: "absolute", left: `${x1}%`, width: `${w}%`, top: 0, height: "100%", background: s.color + (isSelected ? "44" : "28"), borderLeft: `2px solid ${s.color}${isSelected ? "ff" : "77"}`, cursor: "pointer", transition: "background 0.15s" }}
              >
                {w > 9 && (
                  <span style={{ position: "absolute", top: "50%", left: 5, transform: "translateY(-50%)", fontSize: 9, color: s.color, fontWeight: 600, whiteSpace: "nowrap" }}>{s.name}</span>
                )}
              </div>
            );
          })}
          {/* Current time needle */}
          <div style={{ position: "absolute", left: `${(mdtDecimal / 24) * 100}%`, top: 0, height: "100%", width: 2, background: "#f85149", zIndex: 10, boxShadow: "0 0 8px #f85149" }} />
        </div>
        {/* Hour labels */}
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#484f58", fontFamily: FONT_MONO, marginBottom: 12 }}>
          {[0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => (
            <span key={h}>{h === 0 || h === 24 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h-12}p`}</span>
          ))}
        </div>
        {/* Legend */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {LEGEND_SESSIONS.map(s => (
            <div key={s.name} onClick={() => setSessionPopup(sessionPopup === s.name ? null : s.name)} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", opacity: sessionPopup && sessionPopup !== s.name ? 0.4 : 1, transition: "opacity 0.15s" }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
              <span style={{ fontSize: 10, color: "#8b949e" }}>{s.name}</span>
            </div>
          ))}
        </div>
        {/* Session detail popup */}
        {sessionPopup && SESSION_POPUP_DATA[sessionPopup] && (() => {
          const sp = SESSION_POPUP_DATA[sessionPopup];
          const sc = MDT_SESSIONS.find(s => s.name === sessionPopup)?.color || "#8b949e";
          return (
            <div style={{ marginTop: 12, padding: "12px", background: "#0d1117", borderRadius: 8, border: `1px solid ${sc}44` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: sc }}>{sessionPopup} Session</span>
                <button onClick={() => setSessionPopup(null)} style={{ fontSize: 10, background: "none", border: "none", color: "#484f58", cursor: "pointer", padding: "0 4px" }}>✕</button>
              </div>
              <div style={{ fontSize: 10, color: "#8b949e", lineHeight: 1.6, marginBottom: 8 }}>{sp.note}</div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <div><div style={{ fontSize: 9, color: "#484f58", marginBottom: 3 }}>STRATEGY</div><div style={{ fontSize: 10, color: "#e6edf3", fontWeight: 600 }}>{sp.strategy}</div></div>
                <div><div style={{ fontSize: 9, color: "#484f58", marginBottom: 3 }}>SIZE</div><div style={{ fontSize: 10, color: sp.size === "Full" ? "#1D9E75" : "#d29922", fontWeight: 600 }}>{sp.size}</div></div>
                <div>
                  <div style={{ fontSize: 9, color: "#484f58", marginBottom: 3 }}>PAIRS</div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {sp.pairs.map(p => <span key={p} style={{ fontSize: 9, background: "#21262d", color: "#8b949e", borderRadius: 3, padding: "2px 5px", fontFamily: FONT_MONO }}>{p}</span>)}
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Upcoming sessions */}
      <div style={{ ...CARD, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3", marginBottom: 12 }}>Upcoming Sessions</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {nextSessions.map((s, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", background: "#0d1117", borderRadius: 8, border: `1px solid ${s.color}33` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 3, height: 30, background: s.color, borderRadius: 2 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: s.color }}>{s.name}</div>
                  <div style={{ fontSize: 10, color: "#484f58" }}>{fmtHour(s.startH)} MDT</div>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 16, fontWeight: 700, fontFamily: FONT_MONO, color: "#e6edf3" }}>
                  {s.remainH > 0 ? `${s.remainH}h ${String(s.remainM).padStart(2,"0")}m` : `${s.remainM}m`}
                </div>
                <div style={{ fontSize: 9, color: "#484f58" }}>until open</div>
                {scheduleMode === "auto" && (
                  <div style={{ fontSize: 8, color: "#1D9E75", marginTop: 2, fontStyle: "italic" }}>Xavier auto-activates</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Xavier's session playbook */}
      <div style={{ ...CARD, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3", marginBottom: 2 }}>Xavier's Session Playbook</div>
        <div style={{ fontSize: 10, color: "#484f58", marginBottom: 14 }}>Time-blocked trade recommendations</div>
        {XAVIER_SCHEDULE.map((s, i) => {
          const isNow = s.label === "Tokyo" ? (mdtH >= 22 || mdtH < 2) : (mdtH >= s.startH && mdtH < s.endH);
          return (
            <div key={i} style={{ display: "flex", gap: 12, padding: "12px 0", borderBottom: i < XAVIER_SCHEDULE.length - 1 ? "0.5px solid #21262d" : "none" }}>
              <div style={{ width: 3, background: s.color, borderRadius: 2, flexShrink: 0, alignSelf: "stretch", opacity: isNow ? 1 : 0.4 }} />
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: isNow ? s.color : "#8b949e" }}>{s.label}</span>
                    {isNow && (
                      <span style={{ fontSize: 9, background: s.color + "22", color: s.color, border: `1px solid ${s.color}55`, borderRadius: 3, padding: "1px 5px", fontWeight: 700 }}>NOW</span>
                    )}
                  </div>
                  <span style={{ fontSize: 10, color: "#484f58", fontFamily: FONT_MONO, whiteSpace: "nowrap", flexShrink: 0 }}>{s.window}</span>
                </div>
                <div style={{ fontSize: 11, color: isNow ? "#8b949e" : "#484f58", lineHeight: 1.5, marginBottom: s.pairs.length > 0 ? 6 : 0 }}>{s.note}</div>
                {s.pairs.length > 0 && (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {s.pairs.map(p => <span key={p} style={{ fontSize: 9, background: "#21262d", color: "#8b949e", borderRadius: 3, padding: "2px 6px", fontFamily: FONT_MONO }}>{p}</span>)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Pair availability matrix */}
      <div style={{ ...CARD, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3", marginBottom: 2 }}>Pair Availability Matrix</div>
        <div style={{ fontSize: 10, color: "#484f58", marginBottom: 12 }}>Best pairs by session window</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", color: "#484f58", fontWeight: 600, padding: "4px 6px 8px 0", whiteSpace: "nowrap" }}>Pair</th>
                {MATRIX_COLS.map(col => {
                  const isActive = activeSessions.some(s => s.name === col);
                  return (
                    <th key={col} style={{ textAlign: "center", padding: "4px 4px 8px", whiteSpace: "nowrap", color: isActive ? "#e6edf3" : "#484f58", fontWeight: isActive ? 700 : 400 }}>
                      {col}
                      {isActive && <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#1D9E75", margin: "2px auto 0" }} />}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {Object.entries(PAIR_MATRIX).map(([pair, cols]) => (
                <tr key={pair} style={{ borderTop: "0.5px solid #21262d" }}>
                  <td style={{ padding: "6px 8px 6px 0", color: "#8b949e", fontFamily: FONT_MONO, whiteSpace: "nowrap" }}>{pair}</td>
                  {MATRIX_COLS.map(col => {
                    const rating = cols[col];
                    return (
                      <td key={col} style={{ textAlign: "center", padding: "4px" }}>
                        <span style={{ display: "inline-block", padding: "2px 7px", borderRadius: 4, fontSize: 9, fontWeight: 700, color: MATRIX_COLORS[rating], background: MATRIX_BG[rating] }}>
                          {rating === "green" ? "GOOD" : rating === "amber" ? "OK" : "POOR"}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
          {[["green","GOOD"],["amber","OK"],["red","POOR"]].map(([k, label]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: MATRIX_COLORS[k] }} />
              <span style={{ fontSize: 9, color: "#484f58" }}>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Xavier's live market note */}
      <div style={{ ...CARD, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: xavierNote ? 10 : 0 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3" }}>Xavier's Market Note</div>
            {!xavierNote && <div style={{ fontSize: 10, color: "#484f58", marginTop: 2 }}>Real-time session advice</div>}
          </div>
          <button
            onClick={fetchXavier}
            disabled={loadingNote}
            style={{ fontSize: 10, padding: "4px 10px", borderRadius: 5, cursor: loadingNote ? "default" : "pointer", border: "1px solid #30363d", background: "#0d1117", color: loadingNote ? "#484f58" : "#58a6ff", fontFamily: "inherit", opacity: loadingNote ? 0.6 : 1, flexShrink: 0 }}
          >
            {loadingNote ? "Thinking…" : "Ask Xavier"}
          </button>
        </div>
        {xavierNote && (
          <div style={{ borderTop: "0.5px solid #21262d", paddingTop: 10, fontSize: 12, color: "#8b949e", lineHeight: 1.65 }}>
            {xavierNote}
          </div>
        )}
      </div>

      {/* Weekly events */}
      <div style={CARD}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3", marginBottom: 2 }}>This Week's Key Events</div>
        <div style={{ fontSize: 10, color: "#484f58", marginBottom: isHighSoon ? 8 : 12 }}>All times Calgary / MDT</div>
        {isHighSoon && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#d2992218", border: "1px solid #d2992244", borderRadius: 6, marginBottom: 12 }}>
            <span style={{ fontSize: 14 }}>⚠️</span>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#d29922" }}>HIGH-Impact Event Near</div>
              <div style={{ fontSize: 9, color: "#8b949e", marginTop: 1 }}>Xavier auto-pauses trading 30 minutes before and after. Resume is automatic.</div>
            </div>
          </div>
        )}
        {WEEKLY_EVENTS.map((ev, i) => {
          const impactColor = ev.impact === "HIGH" ? "#f85149" : ev.impact === "MED" ? "#d29922" : "#484f58";
          return (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "54px 1fr 64px 38px", gap: "0 10px", padding: "9px 0", borderBottom: i < WEEKLY_EVENTS.length - 1 ? "0.5px solid #21262d" : "none", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#8b949e" }}>{ev.day}</div>
                <div style={{ fontSize: 9, color: "#484f58", fontFamily: FONT_MONO }}>{ev.time}</div>
              </div>
              <div style={{ fontSize: 11, color: "#e6edf3", lineHeight: 1.3 }}>{ev.event}</div>
              <div style={{ fontSize: 9, color: "#58a6ff", fontFamily: FONT_MONO }}>{ev.pair}</div>
              <div style={{ fontSize: 9, color: impactColor, fontWeight: 700, textAlign: "right" }}>{ev.impact}</div>
            </div>
          );
        })}
      </div>

      {/* ── Xavier's Optimization ── */}
      <div style={{ ...CARD, marginTop: 12, borderColor: xavierOpt.running ? "#1D9E7544" : "#21262d" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#e6edf3" }}>Xavier's Optimization</div>
            <div style={{ fontSize: 10, color: "#484f58", marginTop: 2 }}>
              {xavierOpt.result
                ? (() => { const ago = Math.floor((Date.now() - xavierOpt.result.lastUpdated) / 86400000); return `Last run: ${ago === 0 ? "today" : ago === 1 ? "yesterday" : `${ago} days ago`} · M15 + M5 · 800 combinations`; })()
                : "Never run · runs Sunday 11pm Calgary or on first load"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {xavierOpt.running ? (
              <button onClick={xavierOpt.cancel} style={{ fontSize: 10, padding: "5px 12px", borderRadius: 5, cursor: "pointer", border: "1px solid #8e1a17", background: "rgba(142,26,23,0.1)", color: "#f85149", fontFamily: "inherit" }}>Cancel</button>
            ) : (
              <button onClick={xavierOpt.run} style={{ fontSize: 10, padding: "5px 12px", borderRadius: 5, cursor: "pointer", border: "1px solid #238636", background: "rgba(35,134,54,0.12)", color: "#3fb950", fontFamily: "inherit", fontWeight: 600 }}>Run Now</button>
            )}
          </div>
        </div>

        {/* Progress */}
        {xavierOpt.running && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#484f58", marginBottom: 4 }}>
              <span style={{ color: "#8b949e" }}>{xavierOpt.label}</span>
              <span style={{ fontFamily: FONT_MONO, color: "#3fb950" }}>{xavierOpt.done}/{xavierOpt.total}</span>
            </div>
            <div style={{ height: 3, background: "#21262d", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${xavierOpt.progress}%`, background: xavierOpt.progress >= 50 ? "#58a6ff" : "#1D9E75", borderRadius: 2, transition: "width 0.2s" }} />
            </div>
            <div style={{ display: "flex", gap: 16, fontSize: 9, color: "#484f58", marginTop: 3 }}>
              <span style={{ color: xavierOpt.progress >= 50 ? "#484f58" : "#1D9E75" }}>M15 swing {xavierOpt.progress >= 50 ? "✓ done" : `${Math.min(Math.round(xavierOpt.progress * 2), 100)}%`}</span>
              <span style={{ color: xavierOpt.progress >= 50 ? "#58a6ff" : "#484f58" }}>M5 live {xavierOpt.progress >= 50 ? `${Math.round((xavierOpt.progress - 50) * 2)}%` : "—"}</span>
            </div>
          </div>
        )}

        {/* Completion notification */}
        {optNotification && (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", background: "rgba(29,158,117,0.08)", border: "1px solid #1D9E7544", borderRadius: 8, marginBottom: 10 }}>
            <div style={{ flex: 1, fontSize: 11, color: "#8b949e", lineHeight: 1.6 }}>{optNotification}</div>
            <button onClick={() => setOptNotification(null)} style={{ fontSize: 12, color: "#484f58", background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1, flexShrink: 0 }}>×</button>
          </div>
        )}

        {/* ── Pair Status Dashboard ── */}
        {(xavierOpt.result || xavierOpt.m5Result) && !xavierOpt.running && (() => {
          const ALL_PAIRS = [
            "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "EUR/GBP", "NZD/USD",
            "XAU/USD", "XAG/USD", "BCO/USD", "WTICO/USD",
            "NAS100_USD", "JP225_USD", "UK100_GBP", "AU200_AUD", "SPX500_USD",
          ];
          const m15Validated = new Set(xavierOpt.result?.validatedPairs ?? []);
          const m5Validated  = new Set(xavierOpt.m5Result?.validatedPairs ?? []);
          const STATUS_COLOR = { "AUTO+SWING": "#3fb950", "AUTO": "#1D9E75", "SWING": "#58a6ff", "MANUAL": "#f85149" };
          const STATUS_ICON  = { "AUTO+SWING": "✅", "AUTO": "✅", "SWING": "⚔️", "MANUAL": "❌" };
          const getStatus = (pair) => {
            const m5 = m5Validated.has(pair); const m15 = m15Validated.has(pair);
            if (m5 && m15) return "AUTO+SWING";
            if (m5)        return "AUTO";
            if (m15)       return "SWING";
            return "MANUAL";
          };
          const autoCount   = ALL_PAIRS.filter(p => m5Validated.has(p)).length;
          const swingCount  = ALL_PAIRS.filter(p => !m5Validated.has(p) && m15Validated.has(p)).length;
          const manualCount = ALL_PAIRS.filter(p => !m5Validated.has(p) && !m15Validated.has(p)).length;
          const fmtEdge = (v, thresh) => v == null
            ? <span style={{ color: "#30363d" }}>—</span>
            : <span style={{ color: v >= thresh ? "#3fb950" : v >= 0 ? "#d29922" : "#f85149", fontWeight: 700, fontFamily: FONT_MONO }}>
                {v >= 0 ? "+" : ""}{v.toFixed(2)}R {v >= thresh ? "✅" : v >= 0 ? "⚠️" : "❌"}
              </span>;
          return (
            <div style={{ marginBottom: 14, borderBottom: "0.5px solid #21262d", paddingBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 10, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.06em" }}>Pair Status Dashboard</div>
                <div style={{ display: "flex", gap: 10, fontSize: 9 }}>
                  <span style={{ color: "#3fb950" }}>✅ {autoCount} Auto</span>
                  <span style={{ color: "#58a6ff" }}>⚔️ {swingCount} Swing</span>
                  <span style={{ color: "#f85149" }}>❌ {manualCount} Manual</span>
                </div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9 }}>
                  <thead>
                    <tr style={{ borderBottom: "0.5px solid #21262d" }}>
                      <th style={{ textAlign: "left", color: "#484f58", fontWeight: 600, padding: "3px 6px 6px 0", whiteSpace: "nowrap", fontFamily: FONT_MONO }}>PAIR</th>
                      <th style={{ textAlign: "center", color: "#1D9E75", fontWeight: 600, padding: "3px 6px 6px", whiteSpace: "nowrap" }}>M5 EDGE</th>
                      <th style={{ textAlign: "center", color: "#58a6ff", fontWeight: 600, padding: "3px 6px 6px", whiteSpace: "nowrap" }}>M15 EDGE</th>
                      <th style={{ textAlign: "center", color: "#484f58", fontWeight: 600, padding: "3px 0 6px 6px", whiteSpace: "nowrap" }}>STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ALL_PAIRS.map((pair) => {
                      const status  = getStatus(pair);
                      const col     = STATUS_COLOR[status];
                      const m5Val   = xavierOpt.m5Result?.pairEdge?.[pair]?.bestExpectancy;
                      const m15Val  = xavierOpt.result?.pairEdge?.[pair]?.bestExpectancy;
                      return (
                        <tr key={pair} style={{ borderBottom: "0.5px solid #161b22" }}>
                          <td style={{ padding: "5px 6px 5px 0", color: "#8b949e", fontFamily: FONT_MONO, whiteSpace: "nowrap" }}>{pair}</td>
                          <td style={{ textAlign: "center", padding: "5px 6px" }}>{fmtEdge(m5Val, 0.30)}</td>
                          <td style={{ textAlign: "center", padding: "5px 6px" }}>{fmtEdge(m15Val, 0.30)}</td>
                          <td style={{ textAlign: "center", padding: "5px 0 5px 6px" }}>
                            <span style={{ fontSize: 8, fontWeight: 700, color: col, background: col + "18", border: `1px solid ${col}44`, borderRadius: 3, padding: "2px 5px", whiteSpace: "nowrap" }}>{STATUS_ICON[status]} {status}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {xavierOpt.m5Result?.validatedPairs?.length > 0 && (
                <div style={{ marginTop: 8, padding: "7px 10px", background: "rgba(63,185,80,0.06)", border: "1px solid #3fb95033", borderRadius: 6 }}>
                  <div style={{ fontSize: 9, color: "#3fb950", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>✅ M5 Auto-Execution Pairs</div>
                  <div style={{ fontSize: 9, color: "#8b949e", fontFamily: FONT_MONO, lineHeight: 1.7 }}>{xavierOpt.m5Result.validatedPairs.join("  ·  ")}</div>
                </div>
              )}
            </div>
          );
        })()}

        {/* ── M5 Live Execution Results ── */}
        {xavierOpt.m5Result && !xavierOpt.running && (
          <div style={{ marginBottom: 14, borderBottom: "0.5px solid #21262d", paddingBottom: 14 }}>
            <div style={{ fontSize: 10, color: "#1D9E75", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
              M5 Live Execution Results
              <span style={{ fontSize: 8, color: "#484f58", fontWeight: 400, marginLeft: 8 }}>minTrades=50 · maxDD=10R</span>
              {xavierOpt.m5Result.totalSignals > 0 && (
                <span style={{ fontSize: 8, fontFamily: FONT_MONO, color: "#1D9E75", fontWeight: 400, marginLeft: 8 }}>{xavierOpt.m5Result.totalSignals.toLocaleString()} M5 signals</span>
              )}
            </div>
            {xavierOpt.m5Result.top3?.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 9, color: "#484f58", marginBottom: 5 }}>Top setups on M5</div>
                {xavierOpt.m5Result.top3.map((c, i) => {
                  const SC = { "Mean Revert": "#1D9E75", "Trend Follow": "#58a6ff", "Breakout": "#F97316", "Momentum": "#8B5CF6", "Range Scalp": "#d29922" };
                  const col = SC[c.strategy] || "#8b949e";
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: i < xavierOpt.m5Result.top3.length - 1 ? "0.5px solid #161b22" : "none" }}>
                      <span style={{ fontSize: 9, color: "#484f58", fontFamily: FONT_MONO, minWidth: 14 }}>#{i + 1}</span>
                      <div style={{ width: 2, height: 24, borderRadius: 2, background: col, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 10, color: "#e6edf3", fontWeight: 600 }}>{c.pair} <span style={{ color: col }}>{c.strategy}</span></div>
                        <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                          <span style={{ fontSize: 8, color: "#484f58" }}>{c.session}</span>
                          <span style={{ fontSize: 8, fontFamily: FONT_MONO, color: "#1D9E75" }}>{c.trades} trades</span>
                        </div>
                      </div>
                      <div style={{ fontSize: 12, fontFamily: FONT_MONO, color: c.expectancyR >= 0 ? "#3fb950" : "#f85149", fontWeight: 700 }}>{c.expectancyR >= 0 ? "+" : ""}{c.expectancyR.toFixed(2)}R</div>
                    </div>
                  );
                })}
              </div>
            )}
            {xavierOpt.m5Result.validatedPairs?.length > 0 && (
              <div style={{ padding: "7px 10px", background: "rgba(63,185,80,0.06)", border: "1px solid #3fb95033", borderRadius: 6, marginBottom: 4 }}>
                <div style={{ fontSize: 9, color: "#3fb950", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>✓ Validated for auto-execution</div>
                <div style={{ fontSize: 9, color: "#8b949e", fontFamily: FONT_MONO, lineHeight: 1.7 }}>{xavierOpt.m5Result.validatedPairs.join("  ·  ")}</div>
              </div>
            )}
            {xavierOpt.m5Result.blockedPairs?.length > 0 && (
              <div style={{ padding: "7px 10px", background: "rgba(248,81,73,0.06)", border: "1px solid #f8514933", borderRadius: 6 }}>
                <div style={{ fontSize: 9, color: "#f85149", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>✗ Blocked — M5 edge insufficient</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {xavierOpt.m5Result.blockedPairs.map(({ pair, reason }) => (
                    <div key={pair} style={{ fontSize: 9, color: "#484f58", fontFamily: FONT_MONO }}>
                      <span style={{ color: "#8b949e" }}>{pair}</span><span style={{ color: "#30363d" }}> — </span>{reason}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── M15 Swing Trading Results ── */}
        {xavierOpt.result && !xavierOpt.running && (
          <div>
            <div style={{ fontSize: 10, color: "#58a6ff", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
              M15 Swing Trading Results
              <span style={{ fontSize: 8, color: "#484f58", fontWeight: 400, marginLeft: 8 }}>minTrades=30 · maxDD=15R</span>
            </div>
            {xavierOpt.result.top3?.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 9, color: "#484f58", marginBottom: 5 }}>Top setups on M15</div>
                {xavierOpt.result.top3.map((c, i) => {
                  const SC = { "Mean Revert": "#1D9E75", "Trend Follow": "#58a6ff", "Breakout": "#F97316", "Momentum": "#8B5CF6", "Range Scalp": "#d29922" };
                  const col = SC[c.strategy] || "#8b949e";
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: i < 2 ? "0.5px solid #21262d" : "none" }}>
                      <span style={{ fontSize: 10, color: "#484f58", fontFamily: FONT_MONO, minWidth: 14 }}>#{i + 1}</span>
                      <div style={{ width: 3, height: 28, borderRadius: 2, background: col, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, color: "#e6edf3", fontWeight: 600 }}>{c.pair} <span style={{ color: col }}>{c.strategy}</span></div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                          <span style={{ fontSize: 9, color: "#484f58" }}>{c.session}</span>
                          <span style={{ fontSize: 9, fontFamily: FONT_MONO, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "#1D9E7520", border: "1px solid #1D9E7544", color: "#1D9E75" }}>{c.trades} trades</span>
                        </div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: 13, fontFamily: FONT_MONO, color: c.expectancyR >= 0 ? "#3fb950" : "#f85149", fontWeight: 700 }}>{c.expectancyR >= 0 ? "+" : ""}{c.expectancyR.toFixed(2)}R</div>
                        <div style={{ fontSize: 9, color: "#8b949e", marginTop: 1 }}>{c.winRate.toFixed(0)}% win rate</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {xavierOpt.result.rules && (
              <div style={{ marginTop: 6, borderTop: "0.5px solid #21262d", paddingTop: 8 }}>
                <div style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>M15 Optimized Rules by Session</div>
                {Object.entries(xavierOpt.result.rules).map(([sess, rule]) => {
                  const SC = { "Mean Revert": "#1D9E75", "Trend Follow": "#58a6ff", "Breakout": "#F97316", "Momentum": "#8B5CF6", "Range Scalp": "#d29922" };
                  const col = SC[rule.strategy] || "#8b949e";
                  const pairs = rule.pairsDetail || rule.pairs?.map(p => ({ pair: p, trades: null, winRate: null, expectancyR: rule.expectancy })) || [];
                  return (
                    <div key={sess} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: "0.5px solid #161b22" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 9, color: "#484f58", fontFamily: FONT_MONO, minWidth: 56, textTransform: "uppercase", letterSpacing: "0.06em" }}>{sess}</span>
                        <span style={{ fontSize: 10, color: col, fontWeight: 700 }}>{rule.strategy}</span>
                        <span style={{ fontSize: 10, fontFamily: FONT_MONO, color: rule.expectancy >= 0 ? "#3fb950" : "#f85149", fontWeight: 600, marginLeft: "auto" }}>{rule.expectancy >= 0 ? "+" : ""}{rule.expectancy}R</span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        {pairs.map(pd => (
                          <div key={pd.pair} style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 56 }}>
                            <span style={{ fontSize: 9, color: "#8b949e", fontFamily: FONT_MONO, minWidth: 70 }}>{pd.pair}</span>
                            {pd.expectancyR !== null && <span style={{ fontSize: 9, fontFamily: FONT_MONO, fontWeight: 600, color: pd.expectancyR >= 0.30 ? "#3fb950" : pd.expectancyR >= 0 ? "#d29922" : "#f85149" }}>{pd.expectancyR >= 0 ? "+" : ""}{pd.expectancyR.toFixed(2)}R</span>}
                            {pd.trades !== null && <span style={{ fontSize: 9, color: "#484f58" }}>{pd.trades} trades</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {xavierOpt.result.validatedPairs?.length > 0 && (
              <div style={{ marginTop: 8, padding: "7px 10px", background: "rgba(88,166,255,0.06)", border: "1px solid #58a6ff33", borderRadius: 6 }}>
                <div style={{ fontSize: 9, color: "#58a6ff", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>⚔️ M15 Swing-Validated Pairs</div>
                <div style={{ fontSize: 9, color: "#8b949e", fontFamily: FONT_MONO, lineHeight: 1.7 }}>{xavierOpt.result.validatedPairs.join("  ·  ")}</div>
              </div>
            )}
          </div>
        )}

        {!xavierOpt.result && !xavierOpt.m5Result && !xavierOpt.running && (
          <div style={{ fontSize: 11, color: "#484f58", padding: "10px 0" }}>Click "Run Now" to run M15 swing + M5 live backtests — 16 pairs × 5 strategies × 5 sessions × 2 timeframes = 800 combinations. Takes ~30 minutes.</div>
        )}
      </div>
    </div>
  );
}

// ─── BACKTEST TAB ─────────────────────────────────────────────────────────────
function BacktestTab({ closedTrades = [], trades = [], isMobile }) {
  const [xavierInsight, setXavierInsight] = useState(null);
  const [loadingInsight, setLoadingInsight] = useState(false);

  const data = closedTrades;

  if (data.length === 0) {
    return (
      <div style={{ padding: "60px 16px", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🧪</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "#e6edf3", marginBottom: 6 }}>No closed trades</div>
        <div style={{ fontSize: 12, color: "#8b949e" }}>Execute and close trades to see performance analytics here.</div>
      </div>
    );
  }

  const getPL = (t) => t.realizedPL ?? 0;
  const wins   = data.filter(t => getPL(t) > 0);
  const losses = data.filter(t => getPL(t) <= 0);
  const winRate = data.length > 0 ? wins.length / data.length * 100 : 0;
  const totalPL = data.reduce((s, t) => s + getPL(t), 0);
  const avgWin  = wins.length > 0 ? wins.reduce((s, t) => s + getPL(t), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + getPL(t), 0) / losses.length) : 0.001;
  const grossWin  = wins.reduce((s, t) => s + getPL(t), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + getPL(t), 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const expectancy$ = avgWin * (winRate / 100) - avgLoss * (1 - winRate / 100);

  const rTrades = data.filter(t => t.rMultiple != null);
  const avgR = rTrades.length > 0 ? rTrades.reduce((s, t) => s + t.rMultiple, 0) / rTrades.length : null;
  const TARGET_R = 0.583;

  // Equity curve
  const equityPoints = data.slice().reverse().reduce((acc, t) => {
    acc.push(acc[acc.length - 1] + getPL(t));
    return acc;
  }, [0]);

  // Max drawdown
  let maxDD = 0, peak = equityPoints[0];
  for (const v of equityPoints) {
    if (v > peak) peak = v;
    if (peak - v > maxDD) maxDD = peak - v;
  }

  // Sharpe (simplified)
  const plArr = data.map(t => getPL(t));
  const mean = plArr.reduce((s, v) => s + v, 0) / plArr.length;
  const stddev = Math.sqrt(plArr.reduce((s, v) => s + (v - mean) ** 2, 0) / plArr.length);
  const sharpe = stddev > 0 ? (mean / stddev) * Math.sqrt(252) : 0;

  // Pair stats
  const pairStats = {};
  data.forEach(t => {
    if (!pairStats[t.pair]) pairStats[t.pair] = { wins: 0, total: 0, pnl: 0 };
    pairStats[t.pair].total++;
    pairStats[t.pair].pnl += getPL(t);
    if (getPL(t) > 0) pairStats[t.pair].wins++;
  });
  const pairRows = Object.entries(pairStats).sort((a, b) => b[1].pnl - a[1].pnl);
  const maxAbsPnl = Math.max(...pairRows.map(([, s]) => Math.abs(s.pnl)), 0.001);

  // Session stats
  const SESSION_COLOR = { PRIME: "#3fb950", LONDON: "#8B5CF6", NY: "#1D9E75", TOKYO: "#F97316", SYDNEY: "#0EA5E9" };
  const sessionStats = {};
  data.forEach(t => {
    if (!t.closeTime) return;
    const h = new Date(t.closeTime).getUTCHours();
    let sess;
    if (h >= 13 && h < 17) sess = "PRIME";
    else if (h >= 8 && h < 13) sess = "LONDON";
    else if (h >= 17 && h < 20) sess = "NY";
    else if (h >= 20 || h < 4) sess = "TOKYO";
    else sess = "SYDNEY";
    if (!sessionStats[sess]) sessionStats[sess] = { wins: 0, total: 0, pnl: 0 };
    sessionStats[sess].total++;
    sessionStats[sess].pnl += getPL(t);
    if (getPL(t) > 0) sessionStats[sess].wins++;
  });
  const maxSessTrades = Math.max(...Object.values(sessionStats).map(s => s.total), 1);

  // Strategy stats from journal
  const stratStats = {};
  trades.forEach(t => {
    const key = t.strategy || "Unknown";
    if (!stratStats[key]) stratStats[key] = { wins: 0, total: 0, pnl: 0 };
    stratStats[key].total++;
    stratStats[key].pnl += t.pnl || 0;
    if ((t.pnl || 0) > 0) stratStats[key].wins++;
  });

  // SVG equity curve
  const svgW = 600, svgH = 110;
  const minEq = Math.min(...equityPoints);
  const maxEq = Math.max(...equityPoints);
  const range = maxEq - minEq || 1;
  const toX = (i) => (i / (equityPoints.length - 1)) * svgW;
  const toY = (v) => svgH - 8 - ((v - minEq) / range) * (svgH - 16);
  const pts = equityPoints.map((v, i) => `${toX(i)},${toY(v)}`).join(" ");
  const isProfit = totalPL >= 0;

  const pc = (v) => v > 0 ? "#3fb950" : v < 0 ? "#f85149" : "#8b949e";
  const fmtD = (v, d = 2) => `${v >= 0 ? "+" : ""}$${Math.abs(v).toFixed(d)}`;

  const CARD = { background: "#161b22", border: "1px solid #21262d", borderRadius: 12, padding: "16px" };

  const summaryCards = [
    { label: "Closed Trades",   value: data.length,                      color: "#e6edf3" },
    { label: "Win Rate",        value: `${winRate.toFixed(1)}%`,          color: winRate >= 50 ? "#3fb950" : "#f85149" },
    { label: "Profit Factor",   value: profitFactor >= 999 ? "∞" : profitFactor.toFixed(2), color: profitFactor >= 1.5 ? "#3fb950" : profitFactor >= 1 ? "#d29922" : "#f85149" },
    { label: "Sharpe (ann.)",   value: sharpe.toFixed(2),                 color: sharpe >= 1.5 ? "#3fb950" : sharpe >= 0.5 ? "#d29922" : "#f85149" },
    { label: "Max Drawdown",    value: `$${maxDD.toFixed(2)}`,            color: "#f85149" },
    { label: "Expectancy",      value: fmtD(expectancy$),                 color: pc(expectancy$) },
    { label: "Avg R",           value: avgR != null ? `${avgR >= 0 ? "+" : ""}${avgR.toFixed(2)}R` : "—", color: avgR != null ? pc(avgR) : "#484f58" },
    { label: "Total P&L",       value: fmtD(totalPL),                     color: pc(totalPL) },
  ];

  const fetchInsight = async () => {
    setLoadingInsight(true);
    const topPair = pairRows[0]?.[0] ?? "—";
    const sessKeys = Object.keys(sessionStats).join(", ") || "—";
    const prompt = `Analyze my trading system: ${data.length} closed trades, ${winRate.toFixed(1)}% win rate, profit factor ${profitFactor.toFixed(2)}, avg R ${avgR != null ? avgR.toFixed(2) : "unknown"}, Sharpe ${sharpe.toFixed(2)}, max drawdown $${maxDD.toFixed(2)}, total P&L $${totalPL.toFixed(2)}, best pair ${topPair}, active sessions: ${sessKeys}. Provide 3 specific numbered improvements. State whether this system is ready to scale and why. Be quantitative and direct.`;
    const result = await callClaude(prompt, "You are Xavier, a prop trader reviewing your system's live statistics. Talk like a human — direct, data-driven, occasionally blunt when the numbers deserve it. Contractions always. No bullet points, no corporate phrasing. Max 200 words.");
    setXavierInsight(result?.trim() || null);
    setLoadingInsight(false);
  };

  return (
    <div style={{ padding: "0 16px 24px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#e6edf3" }}>Backtest Analytics</div>
          <div style={{ fontSize: 11, color: "#484f58", marginTop: 2 }}>Based on {data.length} closed OANDA trades</div>
        </div>
      </div>

      {/* Sample size warning */}
      {data.length < 30 && (
        <div style={{ background: "rgba(210,153,34,0.07)", border: "1px solid rgba(210,153,34,0.28)", borderRadius: 8, padding: "10px 14px", marginBottom: 16, display: "flex", gap: 8, alignItems: "flex-start" }}>
          <span style={{ color: "#d29922", fontSize: 14, flexShrink: 0 }}>⚠</span>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#d29922" }}>Insufficient sample — {data.length} / 30 trades</div>
            <div style={{ fontSize: 11, color: "#8b949e", marginTop: 2 }}>Statistics require ≥30 trades to be statistically reliable. Results may not reflect true system edge.</div>
          </div>
        </div>
      )}

      {/* R-multiple vs target */}
      {avgR != null && (
        <div style={{ ...CARD, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3" }}>R-Multiple Expectancy</div>
            <div style={{ fontSize: 10, color: "#484f58" }}>Target: +{TARGET_R}R/trade (Van Tharp standard)</div>
          </div>
          <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
            <div style={{ flexShrink: 0 }}>
              <div style={{ fontSize: 30, fontWeight: 800, fontFamily: FONT_MONO, color: pc(avgR), lineHeight: 1 }}>{avgR >= 0 ? "+" : ""}{avgR.toFixed(2)}R</div>
              <div style={{ fontSize: 10, color: "#484f58", marginTop: 3 }}>avg per trade ({rTrades.length}T)</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ height: 10, background: "#0d1117", borderRadius: 5, position: "relative", overflow: "visible", marginBottom: 6 }}>
                <div style={{ height: "100%", width: `${Math.min(Math.max((avgR / (TARGET_R * 2)) * 100, 0), 100)}%`, background: avgR >= TARGET_R ? "#3fb950" : avgR >= 0 ? "#d29922" : "#f85149", borderRadius: 5, transition: "width 0.6s" }} />
                <div style={{ position: "absolute", left: `${(TARGET_R / (TARGET_R * 2)) * 100}%`, top: -3, width: 2, height: 16, background: "#388bfd" }} />
              </div>
              <div style={{ fontSize: 10, color: avgR >= TARGET_R ? "#3fb950" : "#d29922" }}>
                {avgR >= TARGET_R
                  ? `+${(avgR - TARGET_R).toFixed(2)}R above target — system has positive edge`
                  : `${(TARGET_R - avgR).toFixed(2)}R below +${TARGET_R}R target — tighten entries or cut losers faster`}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
        {summaryCards.map((c, i) => (
          <div key={i} style={{ ...CARD, padding: "12px 14px" }}>
            <div style={{ fontSize: 9, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: FONT_MONO, color: c.color }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Equity curve SVG */}
      <div style={{ ...CARD, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3" }}>Equity Curve</div>
          <div style={{ fontSize: 11, fontFamily: FONT_MONO, color: pc(totalPL) }}>{fmtD(totalPL)} realized</div>
        </div>
        <svg viewBox={`0 0 ${svgW} ${svgH}`} style={{ width: "100%", height: isMobile ? 80 : 120, display: "block" }} preserveAspectRatio="none">
          <defs>
            <linearGradient id="btGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={isProfit ? "#3fb950" : "#f85149"} stopOpacity="0.3" />
              <stop offset="100%" stopColor={isProfit ? "#3fb950" : "#f85149"} stopOpacity="0.01" />
            </linearGradient>
          </defs>
          {/* Zero baseline */}
          {minEq < 0 && maxEq > 0 && (
            <line x1="0" y1={toY(0)} x2={svgW} y2={toY(0)} stroke="#30363d" strokeWidth="1" strokeDasharray="4,3" />
          )}
          {/* Fill */}
          <polyline points={`0,${svgH} ${pts} ${svgW},${svgH}`} fill="url(#btGrad)" stroke="none" />
          {/* Line */}
          <polyline points={pts} fill="none" stroke={isProfit ? "#3fb950" : "#f85149"} strokeWidth="2" strokeLinejoin="round" />
          {/* Trade dots */}
          {equityPoints.slice(1).map((v, i) => {
            const tradeIdx = data.length - 1 - i;
            const isWin = (data[tradeIdx]?.realizedPL ?? 0) > 0;
            return <circle key={i} cx={toX(i + 1)} cy={toY(v)} r="3" fill={isWin ? "#3fb950" : "#f85149"} opacity="0.8" />;
          })}
        </svg>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#484f58", fontFamily: FONT_MONO, marginTop: 4 }}>
          <span>Trade 1</span>
          <span>Trade {data.length}</span>
        </div>
      </div>

      {/* Pair + Session performance */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16, marginBottom: 16 }}>
        {/* Pair P&L */}
        <div style={CARD}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3", marginBottom: 12 }}>P&L by Pair</div>
          {pairRows.length === 0 ? (
            <div style={{ fontSize: 11, color: "#484f58" }}>No data</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {pairRows.map(([pair, s]) => (
                <div key={pair}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                    <span style={{ fontFamily: FONT_MONO, color: "#a5d6ff" }}>{pair}</span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <span style={{ color: "#484f58" }}>{(s.wins / s.total * 100).toFixed(0)}% · {s.total}T</span>
                      <span style={{ fontFamily: FONT_MONO, color: pc(s.pnl) }}>{fmtD(s.pnl)}</span>
                    </div>
                  </div>
                  <div style={{ height: 5, background: "#0d1117", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${Math.abs(s.pnl) / maxAbsPnl * 100}%`, height: "100%", background: s.pnl >= 0 ? "#238636" : "#8e1a17", borderRadius: 3 }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Session performance */}
        <div style={CARD}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3", marginBottom: 12 }}>By Session</div>
          {Object.keys(sessionStats).length === 0 ? (
            <div style={{ fontSize: 11, color: "#484f58" }}>No data</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {Object.entries(sessionStats).sort((a, b) => b[1].pnl - a[1].pnl).map(([sess, s]) => {
                const color = SESSION_COLOR[sess] || "#8b949e";
                return (
                  <div key={sess} style={{ display: "grid", gridTemplateColumns: "64px 1fr 36px 72px", gap: "0 8px", padding: "8px 0", borderBottom: "0.5px solid #21262d", alignItems: "center", fontSize: 11 }}>
                    <span style={{ color, fontWeight: 600 }}>{sess}</span>
                    <div style={{ height: 5, background: "#0d1117", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${(s.total / maxSessTrades) * 100}%`, height: "100%", background: color + "55", borderRadius: 3 }} />
                    </div>
                    <span style={{ color: "#484f58" }}>{s.total}T</span>
                    <span style={{ fontFamily: FONT_MONO, color: pc(s.pnl), textAlign: "right" }}>{fmtD(s.pnl)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Strategy comparison */}
      {Object.keys(stratStats).length > 0 && (
        <div style={{ ...CARD, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3", marginBottom: 12 }}>Strategy Comparison</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 52px 52px 80px", gap: "0 12px", fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.05em", paddingBottom: 6, borderBottom: "0.5px solid #21262d" }}>
            {["Strategy", "Trades", "Win %", "P&L"].map(h => <div key={h}>{h}</div>)}
          </div>
          {Object.entries(stratStats).sort((a, b) => b[1].pnl - a[1].pnl).map(([name, s]) => (
            <div key={name} style={{ display: "grid", gridTemplateColumns: "1fr 52px 52px 80px", gap: "0 12px", padding: "8px 0", borderBottom: "0.5px solid #161b22", fontSize: 11 }}>
              <span style={{ color: "#8b949e" }}>{name}</span>
              <span style={{ fontFamily: FONT_MONO, color: "#e6edf3" }}>{s.total}</span>
              <span style={{ fontFamily: FONT_MONO, color: s.wins / s.total >= 0.5 ? "#3fb950" : "#f85149" }}>{(s.wins / s.total * 100).toFixed(0)}%</span>
              <span style={{ fontFamily: FONT_MONO, color: pc(s.pnl) }}>{fmtD(s.pnl)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Xavier's insights */}
      <div style={CARD}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: xavierInsight ? 10 : 0 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3" }}>Xavier's Backtest Insights</div>
            <div style={{ fontSize: 10, color: "#484f58", marginTop: 2 }}>AI analysis of your trading system</div>
          </div>
          <button
            onClick={fetchInsight}
            disabled={loadingInsight}
            style={{ fontSize: 10, padding: "4px 10px", borderRadius: 5, cursor: loadingInsight ? "default" : "pointer", border: "1px solid #30363d", background: "#0d1117", color: loadingInsight ? "#484f58" : "#58a6ff", fontFamily: "inherit", opacity: loadingInsight ? 0.6 : 1, flexShrink: 0 }}
          >
            {loadingInsight ? "Analyzing…" : "Generate Insights"}
          </button>
        </div>
        {xavierInsight ? (
          <div style={{ borderTop: "0.5px solid #21262d", paddingTop: 10, fontSize: 12, color: "#8b949e", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
            {xavierInsight}
          </div>
        ) : (
          !loadingInsight && <div style={{ fontSize: 11, color: "#484f58" }}>Click to get an AI review of your system's strengths, weaknesses, and whether it's ready to scale.</div>
        )}
      </div>

      <HistoricalBacktest isMobile={isMobile} />
    </div>
  );
}

// ─── HISTORICAL BACKTEST ENGINE ───────────────────────────────────────────────
function HistoricalBacktest({ isMobile }) {
  const BT_STRATEGIES = ["Mean Revert", "Trend Follow", "Breakout", "Momentum", "Range Scalp"];
  const STRAT_COLOR   = { "Mean Revert": "#1D9E75", "Trend Follow": "#58a6ff", "Breakout": "#F97316", "Momentum": "#8B5CF6", "Range Scalp": "#d29922" };
  const BT_PAIRS      = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "XAU/USD", "NZD/USD", "SPX500_USD"];
  const BT_TIMEFRAMES = ["M5", "M15", "H1"];
  const BT_DURATIONS  = ["7 days", "30 days", "90 days", "180 days", "365 days"];
  const BT_SESSIONS   = ["All", "Tokyo", "London", "Prime", "NY", "Sydney"];
  const SESSION_UTC   = { All: null, Tokyo: { start: 0, end: 9 }, London: { start: 7, end: 16 }, Prime: { start: 13, end: 17 }, NY: { start: 17, end: 20 }, Sydney: { start: 22, end: 4 } };

  const [btStrategy,   setBtStrategy]   = useState("All");
  const [btPair,       setBtPair]       = useState("EUR/USD");
  const [btTf,         setBtTf]         = useState("M15");
  const [btDur,        setBtDur]        = useState("30 days");
  const [btSess,       setBtSess]       = useState("All");
  const [running,      setRunning]      = useState(false);
  const [progress,     setProgress]     = useState(0);
  const [runLabel,     setRunLabel]     = useState("");
  const [results,      setResults]      = useState(null);
  const [selected,     setSelected]     = useState(null);
  const [btError,      setBtError]      = useState(null);
  const [candleInfo,   setCandleInfo]   = useState(null); // { count, fromDate, toDate }
  const cancelRef = useRef(false);

  const decFor = (p) => p.includes("JPY") ? 3 : p.includes("XAU") || p.includes("SPX") ? 2 : 5;
  const isInSess = (h, s) => { const r = SESSION_UTC[s]; if (!r) return true; if (r.start > r.end) return h >= r.start || h < r.end; return h >= r.start && h < r.end; };
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const runOneStrategy = async (strat, closes, candles, pair, sess, baseProgress) => {
    const trades = [];
    let i = 20;
    const total = closes.length;
    const CHUNK = 50;
    const dec = decFor(pair);

    const processChunk = () => new Promise(resolve => {
      setTimeout(() => {
        const end = Math.min(i + CHUNK, total - 1);
        while (i <= end) {
          if (cancelRef.current) { resolve("cancel"); return; }
          const sig = generateSignal(closes.slice(i - 20, i + 1), strat, pair);
          if (sig && sig.score >= 65 && sig.direction) {
            const utcH = candles[i]?.time ? new Date(candles[i].time).getUTCHours() : 12;
            if (isInSess(utcH, sess)) {
              const atrBars = candles.slice(Math.max(i - 4, 0), i + 1);
              const atr = atrBars.reduce((s, c) => s + Math.abs(parseFloat(c.mid?.h ?? 0) - parseFloat(c.mid?.l ?? 0)), 0) / atrBars.length || closes[i] * 0.001;
              const entry = closes[i];
              const sl = sig.direction === "LONG" ? entry - atr * 1.5 : entry + atr * 1.5;
              const tp = sig.direction === "LONG" ? entry + atr * 3   : entry - atr * 3;
              let resolveIdx = -1, hit = null;
              for (let j = i + 1; j < closes.length; j++) {
                const hi = parseFloat(candles[j]?.mid?.h ?? closes[j]);
                const lo = parseFloat(candles[j]?.mid?.l ?? closes[j]);
                if (sig.direction === "LONG") {
                  if (hi >= tp) { resolveIdx = j; hit = "win"; break; }
                  if (lo <= sl) { resolveIdx = j; hit = "loss"; break; }
                } else {
                  if (lo <= tp) { resolveIdx = j; hit = "win"; break; }
                  if (hi >= sl) { resolveIdx = j; hit = "loss"; break; }
                }
              }
              if (hit !== null) {
                trades.push({ dir: sig.direction, score: sig.score, win: hit === "win", entry: parseFloat(entry.toFixed(dec)), exit: parseFloat((hit === "win" ? tp : sl).toFixed(dec)), rMultiple: hit === "win" ? 3.0 : -1.0, timestamp: candles[i]?.time ?? "" });
                i = resolveIdx + 1;
                continue;
              }
            }
          }
          i++;
        }
        setProgress(Math.round(baseProgress + (i / total) * (100 / BT_STRATEGIES.length)));
        resolve("ok");
      }, 0);
    });

    while (i < total && !cancelRef.current) {
      if (await processChunk() === "cancel") return null;
    }
    if (cancelRef.current || trades.length === 0) return null;

    const wins = trades.filter(t => t.win);
    const losses = trades.filter(t => !t.win);
    const winRate = wins.length / trades.length * 100;
    const expectancyR = trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length;
    const profitFactor = losses.length > 0 ? (wins.length * 3) / losses.length : wins.length > 0 ? 999 : 0;
    const equityCurve = trades.reduce((acc, t) => { acc.push(acc[acc.length - 1] + t.rMultiple); return acc; }, [0]);
    let maxDD = 0, peak = equityCurve[0];
    for (const v of equityCurve) { if (v > peak) peak = v; if (peak - v > maxDD) maxDD = peak - v; }

    // Sharpe ratio (per-trade, mean/std of R-multiples)
    const rArr = trades.map(t => t.rMultiple);
    const rMean = rArr.reduce((a, b) => a + b, 0) / rArr.length;
    const rStd = Math.sqrt(rArr.reduce((a, b) => a + (b - rMean) ** 2, 0) / rArr.length);
    const sharpe = rStd > 0 ? parseFloat((rMean / rStd).toFixed(2)) : 0;

    // Max consecutive losses
    let maxConsecLosses = 0, curStreak = 0;
    for (const t of trades) { if (!t.win) { curStreak++; maxConsecLosses = Math.max(maxConsecLosses, curStreak); } else curStreak = 0; }

    // Validity confidence — higher bar for longer backtests (more data = more signals expected)
    const minMod = parseInt(btDur) >= 180 ? 50 : 30;
    const minHi  = parseInt(btDur) >= 180 ? 200 : 100;
    const validityScore = trades.length >= minHi ? "High" : trades.length >= minMod ? "Moderate" : "Low";

    return { trades, winRate, expectancyR, profitFactor, equityCurve, maxDD, totalR: equityCurve[equityCurve.length - 1], sharpe, maxConsecLosses, validityScore };
  };

  const runBacktest = async () => {
    setRunning(true); setProgress(0); setResults(null); setBtError(null); setSelected(null); setCandleInfo(null);
    cancelRef.current = false;

    const instrument = btPair.replace("/", "_");
    const days = parseInt(btDur);
    let candles = [];
    let fetchTimer = null;
    try {
      // Estimate candle-fetch progress: each OANDA request returns 5000 candles
      const minsPerCandle = btTf === "H1" ? 60 : btTf === "M15" ? 15 : 5;
      const daysPerReq    = (5000 * minsPerCandle) / (60 * 24);
      let fetchedDay = 0;
      setRunLabel(`Fetching candles… day 0 of ${days}`);
      fetchTimer = setInterval(() => {
        fetchedDay = Math.min(Math.round(fetchedDay + daysPerReq), days);
        setRunLabel(`Fetching candles… day ${fetchedDay} of ${days}`);
      }, 2200);
      const r = await fetch(`${BRIDGE}/backtest/candles?instrument=${instrument}&granularity=${btTf}&days=${days}`);
      clearInterval(fetchTimer);
      const data = await r.json();
      if (!Array.isArray(data.candles) || data.candles.length < 22) {
        setBtError("Not enough candles returned. Check bridge connection.");
        setRunning(false); return;
      }
      candles = data.candles;
      setCandleInfo({
        count: candles.length,
        fromDate: candles[0]?.time ? fmtDate(candles[0].time) : "—",
        toDate:   candles[candles.length - 1]?.time ? fmtDate(candles[candles.length - 1].time) : "—",
      });
    } catch { clearInterval(fetchTimer); setBtError("Failed to fetch candles. Is the bridge running?"); setRunning(false); return; }

    setProgress(15);
    const closes = candles.map(c => parseFloat(c.mid?.c ?? 0)).filter(v => v > 0 && !isNaN(v));
    if (closes.length < 22) { setBtError("Insufficient price data in candles."); setRunning(false); return; }

    const strats = btStrategy === "All" ? BT_STRATEGIES : [btStrategy];
    const allResults = {};
    for (let si = 0; si < strats.length; si++) {
      if (cancelRef.current) break;
      const strat = strats[si];
      setRunLabel(`Testing ${strat} (${si + 1}/${strats.length})…`);
      allResults[strat] = await runOneStrategy(strat, closes, candles, btPair, btSess, 15 + (si / strats.length) * 85);
    }

    if (!cancelRef.current) {
      const hasAny = Object.values(allResults).some(Boolean);
      if (!hasAny) { setBtError(`No signals triggered on ${btPair} ${btTf}. Try a different pair or timeframe.`); }
      else {
        setResults(allResults);
        const best = Object.entries(allResults).filter(([, v]) => v).sort((a, b) => b[1].expectancyR - a[1].expectancyR)[0];
        if (best) setSelected(best[0]);
      }
      setProgress(100);
    }
    setRunLabel(""); setRunning(false);
  };

  const SEL = { fontSize: 11, padding: "6px 8px", borderRadius: 6, border: "1px solid #30363d", background: "#0d1117", color: "#e6edf3", fontFamily: "inherit", cursor: "pointer", appearance: "none", WebkitAppearance: "none" };
  const CARD = { background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: "12px 14px" };
  const pc = (v) => v > 0 ? "#3fb950" : v < 0 ? "#f85149" : "#8b949e";
  const TARGET_R = 0.583;

  const detail = results && selected ? results[selected] : null;
  const VALIDITY_COLOR = { High: "#3fb950", Moderate: "#d29922", Low: "#f85149" };

  // Mini sparkline SVG for comparison table rows
  const Spark = ({ eq, color, w = 80, h = 24 }) => {
    if (!eq || eq.length < 2) return <span style={{ color: "#484f58", fontSize: 10 }}>—</span>;
    const minV = Math.min(...eq), maxV = Math.max(...eq), range = maxV - minV || 1;
    const tx = (i) => (i / (eq.length - 1)) * w;
    const ty = (v) => h - 2 - ((v - minV) / range) * (h - 4);
    return (
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} style={{ display: "block" }}>
        {minV < 0 && maxV > 0 && <line x1="0" y1={ty(0)} x2={w} y2={ty(0)} stroke="#30363d" strokeWidth="0.5" />}
        <polyline points={eq.map((v, i) => `${tx(i)},${ty(v)}`).join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    );
  };

  return (
    <div style={{ marginTop: 24, borderTop: "1px solid #21262d", paddingTop: 24 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#e6edf3" }}>Historical Backtest Engine</div>
        <div style={{ fontSize: 10, color: "#484f58", marginTop: 2 }}>Fetches up to 365 days of real OANDA candles · tests all 5 strategies simultaneously · ranks by expectancy</div>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12, alignItems: "flex-end" }}>
        {[
          { label: "Strategy",  value: btStrategy, set: setBtStrategy, opts: ["All", ...BT_STRATEGIES] },
          { label: "Pair",      value: btPair,     set: setBtPair,     opts: BT_PAIRS      },
          { label: "Timeframe", value: btTf,       set: setBtTf,       opts: BT_TIMEFRAMES },
          { label: "Duration",  value: btDur,      set: setBtDur,      opts: BT_DURATIONS  },
          { label: "Session",   value: btSess,     set: setBtSess,     opts: BT_SESSIONS   },
        ].map(({ label, value, set, opts }) => (
          <div key={label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
            <select value={value} onChange={e => set(e.target.value)} disabled={running} style={SEL}>
              {opts.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        ))}
        {btDur === "365 days" && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", background: "rgba(210,153,34,0.08)", border: "1px solid rgba(210,153,34,0.25)", borderRadius: 6, fontSize: 10, color: "#d29922" }}>
            <span style={{ fontWeight: 700, letterSpacing: "0.05em" }}>SLOW</span>
            <span style={{ color: "#8b949e" }}>365-day backtest may take 3–5 minutes to complete (22 OANDA requests)</span>
          </div>
        )}
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          <button onClick={runBacktest} disabled={running}
            style={{ fontSize: 11, padding: "7px 16px", borderRadius: 6, cursor: running ? "not-allowed" : "pointer", border: "1px solid #238636", background: running ? "#0d1117" : "rgba(35,134,54,0.15)", color: running ? "#484f58" : "#3fb950", fontFamily: "inherit", fontWeight: 600, opacity: running ? 0.5 : 1 }}>
            Run Backtest
          </button>
          {running && (
            <button onClick={() => { cancelRef.current = true; setRunning(false); setProgress(0); setRunLabel(""); }}
              style={{ fontSize: 11, padding: "7px 12px", borderRadius: 6, cursor: "pointer", border: "1px solid #8e1a17", background: "rgba(142,26,23,0.1)", color: "#f85149", fontFamily: "inherit" }}>
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Candle info bar */}
      {candleInfo && !running && (
        <div style={{ display: "flex", gap: 16, marginBottom: 10, padding: "7px 12px", background: "#161b22", borderRadius: 6, border: "1px solid #21262d", flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: "#3fb950", fontFamily: FONT_MONO, fontWeight: 600 }}>{candleInfo.count.toLocaleString()} candles loaded</span>
          <span style={{ fontSize: 10, color: "#484f58" }}>·</span>
          <span style={{ fontSize: 10, color: "#8b949e" }}>{candleInfo.fromDate} – {candleInfo.toDate}</span>
          <span style={{ fontSize: 10, color: "#484f58" }}>·</span>
          <span style={{ fontSize: 10, color: "#484f58" }}>{btTf} · {btPair}</span>
        </div>
      )}

      {/* Progress */}
      {running && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#484f58", marginBottom: 4 }}>
            <span>{runLabel || "Scanning candles…"}</span>
            <span style={{ fontFamily: FONT_MONO }}>{progress}%</span>
          </div>
          <div style={{ height: 4, background: "#21262d", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progress}%`, background: "#3fb950", borderRadius: 2, transition: "width 0.15s" }} />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
            {(btStrategy === "All" ? BT_STRATEGIES : [btStrategy]).map((s, si) => {
              const strats = btStrategy === "All" ? BT_STRATEGIES : [btStrategy];
              const stratBase = 15 + (si / strats.length) * 85;
              const done = progress >= stratBase + (85 / strats.length);
              const active = progress >= stratBase && !done;
              return (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: done ? STRAT_COLOR[s] : active ? STRAT_COLOR[s] + "88" : "#21262d", transition: "background 0.3s" }} />
                  <span style={{ fontSize: 9, color: done ? STRAT_COLOR[s] : "#484f58" }}>{s}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Error */}
      {btError && !running && (
        <div style={{ padding: "10px 14px", background: "rgba(248,81,73,0.07)", border: "1px solid rgba(248,81,73,0.25)", borderRadius: 8, fontSize: 11, color: "#f85149", marginBottom: 12 }}>
          {btError}
        </div>
      )}

      {/* Results */}
      {results && !running && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

          {/* ── Strategy comparison table ── */}
          <div style={CARD}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3", marginBottom: 2 }}>Strategy Comparison</div>
            <div style={{ fontSize: 10, color: "#484f58", marginBottom: 10 }}>Click a row to see full detail · ranked by expectancy R</div>
            <div style={{ overflowX: "auto" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 50px 55px 68px 48px 88px", gap: "0 8px", fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.04em", paddingBottom: 6, borderBottom: "0.5px solid #21262d", minWidth: 360 }}>
                {["Strategy", "Trades", "Win %", "Exp. R", "PF", "Equity"].map(h => <div key={h}>{h}</div>)}
              </div>
              {BT_STRATEGIES.slice().sort((a, b) => {
                const ra = results[a]?.expectancyR ?? -999;
                const rb = results[b]?.expectancyR ?? -999;
                return rb - ra;
              }).map((strat, rank) => {
                const r = results[strat];
                const color = STRAT_COLOR[strat];
                const isSel = selected === strat;
                const isBest = rank === 0 && r;
                return (
                  <div key={strat} onClick={() => r && setSelected(strat)}
                    style={{ display: "grid", gridTemplateColumns: "1fr 50px 55px 68px 48px 88px", gap: "0 8px", padding: "9px 0", borderBottom: "0.5px solid #161b22", fontSize: 11, minWidth: 360, alignItems: "center", cursor: r ? "pointer" : "default", background: isSel ? color + "0d" : "transparent", borderLeft: isSel ? `2px solid ${color}` : "2px solid transparent", paddingLeft: isSel ? 8 : 0, transition: "background 0.15s" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: r ? color : "#21262d", flexShrink: 0 }} />
                      <span style={{ color: r ? "#e6edf3" : "#484f58", fontWeight: isBest ? 600 : 400 }}>{strat}</span>
                      {isBest && <span style={{ fontSize: 8, background: color + "22", color, border: `1px solid ${color}44`, borderRadius: 3, padding: "1px 4px", fontWeight: 700 }}>BEST</span>}
                      {r && r.validityScore === "Low" && <span style={{ fontSize: 8, background: "rgba(248,81,73,0.1)", color: "#f85149", border: "1px solid rgba(248,81,73,0.3)", borderRadius: 3, padding: "1px 4px" }}>{"<30 trades"}</span>}
                    </div>
                    <span style={{ fontFamily: FONT_MONO, color: r ? "#8b949e" : "#484f58" }}>{r ? r.trades.length : "—"}</span>
                    <span style={{ fontFamily: FONT_MONO, color: r ? (r.winRate >= 50 ? "#3fb950" : "#f85149") : "#484f58" }}>{r ? `${r.winRate.toFixed(0)}%` : "—"}</span>
                    <span style={{ fontFamily: FONT_MONO, color: r ? pc(r.expectancyR) : "#484f58", fontWeight: r ? 600 : 400 }}>{r ? `${r.expectancyR >= 0 ? "+" : ""}${r.expectancyR.toFixed(2)}R` : "—"}</span>
                    <span style={{ fontFamily: FONT_MONO, color: r ? (r.profitFactor >= 1.5 ? "#3fb950" : r.profitFactor >= 1 ? "#d29922" : "#f85149") : "#484f58" }}>{r ? (r.profitFactor >= 999 ? "∞" : r.profitFactor.toFixed(1)) : "—"}</span>
                    <Spark eq={r?.equityCurve} color={color} />
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Detail view for selected strategy ── */}
          {detail && selected && (() => {
            const color = STRAT_COLOR[selected];
            const svgW = 600, svgH = 90;
            const eq = detail.equityCurve;
            const minV = Math.min(...eq), maxV = Math.max(...eq), range = maxV - minV || 1;
            const toX = (i) => (i / (eq.length - 1)) * svgW;
            const toY = (v) => svgH - 6 - ((v - minV) / range) * (svgH - 12);
            const pts = eq.map((v, i) => `${toX(i)},${toY(v)}`).join(" ");
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {/* Header */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 3, background: color }} />
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#e6edf3" }}>{selected}</span>
                    <span style={{ fontSize: 10, color: "#484f58" }}>— detail view</span>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {BT_STRATEGIES.filter(s => results[s]).map(s => (
                      <button key={s} onClick={() => setSelected(s)} style={{ fontSize: 9, padding: "3px 7px", borderRadius: 4, cursor: "pointer", border: `1px solid ${selected === s ? STRAT_COLOR[s] : "#21262d"}`, background: selected === s ? STRAT_COLOR[s] + "22" : "transparent", color: selected === s ? STRAT_COLOR[s] : "#484f58", fontFamily: "inherit" }}>{s.split(" ")[0]}</button>
                    ))}
                  </div>
                </div>

                {/* Low sample warning */}
                {detail.validityScore === "Low" && (
                  <div style={{ padding: "8px 12px", background: "rgba(248,81,73,0.06)", border: "1px solid rgba(248,81,73,0.2)", borderRadius: 6, fontSize: 10, color: "#f85149" }}>
                    Only {detail.trades.length} signals — minimum 30 required for statistical confidence. Results are directional only, not reliable for live trading decisions.
                  </div>
                )}

                {/* Stats row 1 — core metrics */}
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(5, 1fr)", gap: 8 }}>
                  {[
                    { label: "Trades",        value: detail.trades.length,                                                                    color: "#e6edf3" },
                    { label: "Win Rate",       value: `${detail.winRate.toFixed(1)}%`,                                                         color: detail.winRate >= 50 ? "#3fb950" : "#f85149" },
                    { label: "Expectancy",     value: `${detail.expectancyR >= 0 ? "+" : ""}${detail.expectancyR.toFixed(2)}R`,                color: pc(detail.expectancyR) },
                    { label: "Profit Factor",  value: detail.profitFactor >= 999 ? "∞" : detail.profitFactor.toFixed(2),                       color: detail.profitFactor >= 1.5 ? "#3fb950" : detail.profitFactor >= 1 ? "#d29922" : "#f85149" },
                    { label: "Max Drawdown",   value: `${detail.maxDD.toFixed(1)}R`,                                                           color: "#f85149" },
                  ].map((c, i) => (
                    <div key={i} style={CARD}>
                      <div style={{ fontSize: 9, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>{c.label}</div>
                      <div style={{ fontSize: 16, fontWeight: 700, fontFamily: FONT_MONO, color: c.color }}>{c.value}</div>
                    </div>
                  ))}
                </div>

                {/* Stats row 2 — advanced metrics */}
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 8 }}>
                  {[
                    { label: "Sharpe Ratio",      value: detail.sharpe.toFixed(2),          color: detail.sharpe >= 1 ? "#3fb950" : detail.sharpe >= 0 ? "#d29922" : "#f85149",
                      tip: "Mean R ÷ Std R — measures return per unit of risk" },
                    { label: "Max Consec. Losses", value: `${detail.maxConsecLosses}`,       color: detail.maxConsecLosses <= 3 ? "#3fb950" : detail.maxConsecLosses <= 6 ? "#d29922" : "#f85149",
                      tip: "Longest losing streak in the backtest period" },
                    { label: "Confidence",         value: detail.validityScore,              color: VALIDITY_COLOR[detail.validityScore],
                      tip: "Low <30 trades · Moderate 30–99 · High 100+" },
                    { label: "Total R",            value: `${detail.totalR >= 0 ? "+" : ""}${detail.totalR.toFixed(1)}R`, color: pc(detail.totalR),
                      tip: "Cumulative R-multiple over the backtest period" },
                  ].map((c, i) => (
                    <div key={i} style={{ ...CARD, position: "relative" }} title={c.tip}>
                      <div style={{ fontSize: 9, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>{c.label}</div>
                      <div style={{ fontSize: 16, fontWeight: 700, fontFamily: FONT_MONO, color: c.color }}>{c.value}</div>
                    </div>
                  ))}
                </div>

                {/* Expectancy bar */}
                <div style={CARD}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 8 }}>
                    <span style={{ color: "#8b949e", fontWeight: 600 }}>R-Multiple Expectancy</span>
                    <span style={{ color: "#484f58", fontSize: 10 }}>+{TARGET_R}R target (Van Tharp)</span>
                  </div>
                  <div style={{ height: 8, background: "#161b22", borderRadius: 4, position: "relative", overflow: "visible", marginBottom: 6 }}>
                    <div style={{ height: "100%", width: `${Math.min(Math.max((detail.expectancyR / (TARGET_R * 2)) * 100, 0), 100)}%`, background: detail.expectancyR >= TARGET_R ? "#3fb950" : detail.expectancyR >= 0 ? "#d29922" : "#f85149", borderRadius: 4, transition: "width 0.5s" }} />
                    <div style={{ position: "absolute", left: "50%", top: -3, width: 2, height: 14, background: "#388bfd" }} />
                  </div>
                  <div style={{ fontSize: 10, color: detail.expectancyR >= TARGET_R ? "#3fb950" : detail.expectancyR >= 0 ? "#d29922" : "#f85149" }}>
                    {detail.expectancyR >= TARGET_R ? `+${(detail.expectancyR - TARGET_R).toFixed(2)}R above benchmark — positive edge confirmed` : detail.expectancyR >= 0 ? `${(TARGET_R - detail.expectancyR).toFixed(2)}R below benchmark — marginal, needs improvement` : `Negative expectancy — do not trade this configuration live`}
                  </div>
                </div>

                {/* Equity curve */}
                {eq.length > 1 && (
                  <div style={CARD}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 8 }}>
                      <span style={{ color: "#8b949e", fontWeight: 600 }}>Equity Curve (R)</span>
                      <span style={{ fontFamily: FONT_MONO, color: pc(detail.totalR) }}>{detail.totalR >= 0 ? "+" : ""}{detail.totalR.toFixed(1)}R total</span>
                    </div>
                    <svg viewBox={`0 0 ${svgW} ${svgH}`} style={{ width: "100%", height: isMobile ? 70 : 90, display: "block" }} preserveAspectRatio="none">
                      <defs>
                        <linearGradient id="hbGrad2" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
                          <stop offset="100%" stopColor={color} stopOpacity="0.01" />
                        </linearGradient>
                      </defs>
                      {minV < 0 && maxV > 0 && <line x1="0" y1={toY(0)} x2={svgW} y2={toY(0)} stroke="#30363d" strokeWidth="1" strokeDasharray="4,3" />}
                      <polyline points={`0,${svgH} ${pts} ${svgW},${svgH}`} fill="url(#hbGrad2)" stroke="none" />
                      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
                      {eq.slice(1).map((v, i) => <circle key={i} cx={toX(i + 1)} cy={toY(v)} r="2.5" fill={detail.trades[i]?.win ? "#3fb950" : "#f85149"} opacity="0.75" />)}
                    </svg>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#484f58", fontFamily: FONT_MONO, marginTop: 4 }}>
                      <span>Trade 1</span><span>Trade {detail.trades.length}</span>
                    </div>
                  </div>
                )}

                {/* Trade log */}
                <div style={CARD}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#e6edf3", marginBottom: 8 }}>
                    Trade Log <span style={{ fontWeight: 400, color: "#484f58", fontSize: 10 }}>({detail.trades.length} trades · first 50)</span>
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "52px 44px 92px 92px 40px 44px", gap: "0 8px", fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.04em", paddingBottom: 5, borderBottom: "0.5px solid #21262d", minWidth: 340 }}>
                      {["Dir", "Score", "Entry", "Exit", "R", "Result"].map(h => <div key={h}>{h}</div>)}
                    </div>
                    <div style={{ maxHeight: 200, overflowY: "auto" }}>
                      {detail.trades.slice(0, 50).map((t, i) => (
                        <div key={i} style={{ display: "grid", gridTemplateColumns: "52px 44px 92px 92px 40px 44px", gap: "0 8px", padding: "5px 0", borderBottom: "0.5px solid #0d1117", fontSize: 11, minWidth: 340, alignItems: "center" }}>
                          <span style={{ color: t.dir === "LONG" ? "#3fb950" : "#f85149", fontWeight: 600, fontSize: 10 }}>{t.dir}</span>
                          <span style={{ fontFamily: FONT_MONO, color: t.score >= 75 ? "#3fb950" : "#d29922" }}>{t.score}</span>
                          <span style={{ fontFamily: FONT_MONO, color: "#8b949e", fontSize: 10 }}>{t.entry}</span>
                          <span style={{ fontFamily: FONT_MONO, color: "#8b949e", fontSize: 10 }}>{t.exit}</span>
                          <span style={{ fontFamily: FONT_MONO, color: t.win ? "#3fb950" : "#f85149", fontWeight: 700 }}>{t.win ? "+3R" : "-1R"}</span>
                          <span style={{ fontSize: 9, padding: "2px 5px", borderRadius: 3, background: t.win ? "rgba(63,185,80,0.12)" : "rgba(248,81,73,0.12)", color: t.win ? "#3fb950" : "#f85149", fontWeight: 600, textAlign: "center" }}>{t.win ? "WIN" : "LOSS"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Recommendation */}
                <div style={{ background: "rgba(56,139,253,0.06)", border: "1px solid rgba(56,139,253,0.22)", borderRadius: 8, padding: "12px 14px" }}>
                  <div style={{ fontSize: 9, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5 }}>Recommendation</div>
                  <div style={{ fontSize: 12, color: "#8b949e", lineHeight: 1.6 }}>
                    Best strategy: <span style={{ color, fontWeight: 600 }}>{selected}</span> · <span style={{ color: "#e6edf3" }}>{btPair}</span> · <span style={{ color: "#484f58" }}>{btTf} · {btDur} · {btSess} session</span>
                    {" — "}
                    <span style={{ color: pc(detail.expectancyR), fontWeight: 600 }}>Expectancy: {detail.expectancyR >= 0 ? "+" : ""}{detail.expectancyR.toFixed(2)}R</span>
                    {detail.expectancyR >= TARGET_R ? " — Positive edge confirmed. Consider paper trading first." : detail.expectancyR >= 0 ? " — Marginal edge. Improve signal filtering before going live." : " — Negative expectancy. Do not trade this live."}
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ─── PERFORMANCE DASHBOARD ───────────────────────────────────────────────────
function PerformanceDashboard({ trades, closedTrades = [], balance, isMobile }) {
  const hasClosed = closedTrades.length > 0;
  const analyticsData = hasClosed ? closedTrades : trades;
  const [curveFilter, setCurveFilter] = useState("ALL");
  const [xavierNote, setXavierNote] = useState("");
  const [xavierLoading, setXavierLoading] = useState(false);

  if (analyticsData.length === 0) {
    return (
      <div style={{ padding: "60px 16px", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>📊</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "#e6edf3", marginBottom: 6 }}>No trades yet</div>
        <div style={{ fontSize: 12, color: "#8b949e" }}>Execute trades in the Markets tab to see analytics here.</div>
      </div>
    );
  }

  const getPL = (t) => t.realizedPL ?? t.pnl ?? 0;
  const wins = analyticsData.filter(t => getPL(t) > 0);
  const losses = analyticsData.filter(t => getPL(t) <= 0);
  const winRate = analyticsData.length > 0 ? wins.length / analyticsData.length * 100 : 0;
  const totalPnl = analyticsData.reduce((s, t) => s + getPL(t), 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + getPL(t), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + getPL(t), 0) / losses.length) : 0;
  const expectancy = avgWin * (winRate / 100) - avgLoss * (1 - winRate / 100);
  const maxWin = wins.length > 0 ? Math.max(...wins.map(t => getPL(t))) : 0;
  const maxLoss = losses.length > 0 ? Math.min(...losses.map(t => getPL(t))) : 0;
  const profitFactor = avgLoss > 0 && losses.length > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : 0;

  const equityCurve = hasClosed
    ? closedTrades.slice().reverse().reduce((acc, t) => {
        acc.push(acc[acc.length - 1] + (t.realizedPL || 0));
        return acc;
      }, [0])
    : trades.reduce((acc, t) => { acc.push(acc[acc.length - 1] + (t.pnl || 0)); return acc; }, [0]);

  const filterMs = { ALL: Infinity, TODAY: 86400000, WEEK: 604800000, MONTH: 2592000000 };
  const nowMs = Date.now();
  const filteredBase = hasClosed
    ? closedTrades.slice().reverse().filter(t => {
        if (curveFilter === "ALL") return true;
        const ts = t.closeTime ? new Date(t.closeTime).getTime() : 0;
        return nowMs - ts <= filterMs[curveFilter];
      })
    : trades;
  const filteredCurve = filteredBase.reduce((acc, t) => {
    acc.push(acc[acc.length - 1] + (hasClosed ? (t.realizedPL || 0) : (t.pnl || 0)));
    return acc;
  }, [0]);

  const peakVal = Math.max(...filteredCurve);
  const currentVal = filteredCurve[filteredCurve.length - 1];
  const peakIdx = filteredCurve.indexOf(peakVal);
  const afterPeak = filteredCurve.slice(peakIdx);
  const maxDrawdown = peakVal > 0 ? ((peakVal - Math.min(...afterPeak)) / peakVal * 100) : 0;

  const pairStats = {};
  analyticsData.forEach(t => {
    if (!pairStats[t.pair]) pairStats[t.pair] = { wins: 0, total: 0, pnl: 0 };
    pairStats[t.pair].total++;
    const p = getPL(t);
    pairStats[t.pair].pnl += p;
    if (p > 0) pairStats[t.pair].wins++;
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
    if ((t.pnl || 0) > 0) stratStats[key].wins++;
  });

  const sessionStats = {};
  analyticsData.forEach(t => {
    const sess = t.session || "Unknown";
    if (!sessionStats[sess]) sessionStats[sess] = { wins: 0, total: 0, pnl: 0 };
    sessionStats[sess].total++;
    const p = getPL(t);
    sessionStats[sess].pnl += p;
    if (p > 0) sessionStats[sess].wins++;
  });

  const longs = analyticsData.filter(t => t.dir === "LONG");
  const shorts = analyticsData.filter(t => t.dir === "SHORT");
  const longWr = longs.length > 0 ? longs.filter(t => getPL(t) > 0).length / longs.length * 100 : 0;
  const shortWr = shorts.length > 0 ? shorts.filter(t => getPL(t) > 0).length / shorts.length * 100 : 0;
  const longPnl = longs.reduce((s, t) => s + getPL(t), 0);
  const shortPnl = shorts.reduce((s, t) => s + getPL(t), 0);

  const recent5 = analyticsData.slice(-5);
  const recentWr = recent5.length > 0 ? recent5.filter(t => getPL(t) > 0).length / recent5.length * 100 : 0;
  const trend = recent5.length >= 3 ? (recentWr > winRate + 5 ? "improving" : recentWr < winRate - 5 ? "declining" : "stable") : "early";

  const pc = (v) => v > 0 ? "#3fb950" : v < 0 ? "#f85149" : "#8b949e";
  const fmtD = (v) => `${v >= 0 ? "+" : ""}$${Math.abs(v).toFixed(2)}`;
  const fmtPct = (v, d = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;

  const CARD = { background: "#161b22", border: "1px solid #21262d", borderRadius: 12, padding: "16px 18px" };
  const LBL  = { fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 };
  const BIG  = { fontSize: 22, fontWeight: 700, fontFamily: FONT_MONO };

  const SESSION_COLORS = { PRIME: "#3fb950", LONDON: "#58a6ff", NY: "#a371f7", TOKYO: "#d29922", SYDNEY: "#79c0ff" };
  const SESSION_ORDER  = ["PRIME", "LONDON", "NY", "TOKYO", "SYDNEY"];

  const handleXavierAnalyze = async () => {
    setXavierLoading(true);
    try {
      const prompt = `Analyze this trading performance in 3-4 sentences. Be direct and data-driven. One specific actionable recommendation.\n\nWin Rate: ${winRate.toFixed(1)}%, Total P&L: ${hasClosed ? fmtD(totalPnl) : fmtPct(totalPnl)}, Expectancy: ${hasClosed ? fmtD(expectancy) : fmtPct(expectancy)}, Profit Factor: ${profitFactor.toFixed(2)}, Trades: ${analyticsData.length}, Avg Win: ${hasClosed ? fmtD(avgWin) : fmtPct(avgWin)}, Avg Loss: ${hasClosed ? fmtD(avgLoss) : fmtPct(avgLoss)}, Best Pair: ${bestPair}, Max Drawdown: ${maxDrawdown.toFixed(1)}%, Recent 5-trade WR: ${recentWr.toFixed(0)}% vs ${winRate.toFixed(0)}% overall (${trend}).`;
      const result = await callClaude(prompt, "You are Xavier, an AI trading coach. Talk like a prop desk veteran — direct, occasionally blunt, data-driven. Contractions always. No bullet points. Max 150 words.");
      setXavierNote(result);
    } catch {
      setXavierNote("Unable to generate analysis. Check API connection.");
    }
    setXavierLoading(false);
  };

  const renderBadge = (s) => {
    const wr = s.total > 0 ? s.wins / s.total * 100 : 0;
    if (s.total < 5) return <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: "#21262d", color: "#8b949e", fontFamily: FONT_MONO }}>NEED DATA</span>;
    if (wr >= 55)    return <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: "#1a3a1f", color: "#3fb950", fontFamily: FONT_MONO }}>PERFORMING</span>;
    if (wr < 40)     return <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: "#3a1a1a", color: "#f85149", fontFamily: FONT_MONO }}>WEAK</span>;
    return                  <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: "#2d2a1a", color: "#d29922", fontFamily: FONT_MONO }}>NEUTRAL</span>;
  };

  const metrics = hasClosed ? [
    { label: "Closed Trades",  value: closedTrades.length,       color: "#e6edf3" },
    { label: "Win Rate",       value: `${winRate.toFixed(1)}%`,  color: winRate >= 50 ? "#3fb950" : "#f85149" },
    { label: "Total P&L",     value: fmtD(totalPnl),             color: pc(totalPnl) },
    { label: "Expectancy",    value: fmtD(expectancy),           color: pc(expectancy) },
    { label: "Profit Factor", value: profitFactor.toFixed(2),    color: profitFactor >= 1.5 ? "#3fb950" : profitFactor >= 1 ? "#d29922" : "#f85149" },
    { label: "Max Win",       value: fmtD(maxWin),               color: "#3fb950" },
    { label: "Max Loss",      value: fmtD(maxLoss),              color: "#f85149" },
    { label: "Best Pair",     value: bestPair,                    color: "#a5d6ff" },
  ] : [
    { label: "Pending Fills", value: trades.length,              color: "#e6edf3" },
    { label: "Win Rate",      value: `${winRate.toFixed(1)}%`,   color: "#484f58" },
    { label: "Total P&L",    value: fmtPct(totalPnl),            color: pc(totalPnl) },
    { label: "Expectancy",   value: fmtPct(expectancy, 3),       color: pc(expectancy) },
    { label: "Profit Factor",value: profitFactor.toFixed(2),     color: "#8b949e" },
    { label: "Max Win",      value: fmtPct(maxWin),              color: "#3fb950" },
    { label: "Max Loss",     value: fmtPct(maxLoss),             color: "#f85149" },
    { label: "Best Pair",    value: bestPair,                     color: "#a5d6ff" },
  ];

  return (
    <div style={{ padding: "0 16px 32px" }}>

      {/* ── Banner ─────────────────────────────────────────────────────────── */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderRadius: 10, background: analyticsData.length < 30 ? "#2d2a1a" : "#161b22", border: `1px solid ${analyticsData.length < 30 ? "#d29922" : "#21262d"}`, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#e6edf3" }}>{hasClosed ? "OANDA Trade Analytics" : "Signal Analytics"}</div>
          <div style={{ fontSize: 10, color: "#8b949e", marginTop: 2 }}>{hasClosed ? `${closedTrades.length} closed trades · live OANDA data` : `${trades.length} signal records · simulated P&L`}</div>
        </div>
        {analyticsData.length < 30 && (
          <div style={{ fontSize: 10, color: "#d29922", textAlign: "right" }}>{30 - analyticsData.length} more trades for stable stats</div>
        )}
      </motion.div>

      {/* ── Section 1: 8 metric cards ──────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
        {metrics.map((m, i) => (
          <motion.div key={m.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }} style={CARD}>
            <div style={LBL}>{m.label}</div>
            <div style={{ ...BIG, color: m.color }}>{m.value}</div>
          </motion.div>
        ))}
      </div>

      {/* ── Section 2: Equity curve ─────────────────────────────────────────── */}
      {filteredCurve.length > 1 && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} style={{ ...CARD, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>Equity Curve</div>
            {hasClosed && (
              <div style={{ display: "flex", gap: 4 }}>
                {["ALL", "MONTH", "WEEK", "TODAY"].map(f => (
                  <button key={f} onClick={() => setCurveFilter(f)}
                    style={{ fontSize: 9, padding: "3px 8px", borderRadius: 4, border: curveFilter === f ? "1px solid #58a6ff" : "1px solid #30363d", background: curveFilter === f ? "#1f2d3d" : "transparent", color: curveFilter === f ? "#58a6ff" : "#8b949e", cursor: "pointer", fontFamily: FONT_MONO, letterSpacing: "0.04em" }}>
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>
          {(() => {
            const data = filteredCurve;
            if (data.length < 2) return <div style={{ height: 100, display: "flex", alignItems: "center", justifyContent: "center", color: "#484f58", fontSize: 11 }}>Not enough data for this period</div>;
            const W = 600, H = 100, PX = 8, PY = 6;
            const minV = Math.min(...data), maxV = Math.max(...data);
            const range = maxV - minV || 1;
            const toX = (i) => PX + (i / (data.length - 1)) * (W - PX * 2);
            const toY = (v) => H - PY - ((v - minV) / range) * (H - PY * 2);
            const zeroY = toY(Math.max(minV, 0));
            const pts = data.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(" ");
            const fillPts = `${toX(0).toFixed(1)},${zeroY.toFixed(1)} ${pts} ${toX(data.length - 1).toFixed(1)},${zeroY.toFixed(1)}`;
            const lc = currentVal >= 0 ? "#3fb950" : "#f85149";
            return (
              <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 100, display: "block" }} preserveAspectRatio="none">
                <defs>
                  <linearGradient id="eq-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lc} stopOpacity="0.25" />
                    <stop offset="100%" stopColor={lc} stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                <line x1={PX} y1={zeroY} x2={W - PX} y2={zeroY} stroke="#21262d" strokeWidth="1" strokeDasharray="3 3" />
                <polygon points={fillPts} fill="url(#eq-grad)" />
                <polyline points={pts} fill="none" stroke={lc} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
                {data.map((v, i) => (
                  <circle key={i} cx={toX(i)} cy={toY(v)} r={i === data.length - 1 ? 3 : 1.5} fill={lc} opacity={i === data.length - 1 ? 1 : 0.4} />
                ))}
              </svg>
            );
          })()}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 10, paddingTop: 10, borderTop: "0.5px solid #21262d" }}>
            {[
              { label: "Current",      value: hasClosed ? fmtD(currentVal) : fmtPct(currentVal), color: pc(currentVal) },
              { label: "Peak",         value: hasClosed ? fmtD(peakVal)    : fmtPct(peakVal),    color: "#3fb950" },
              { label: "Max Drawdown", value: `${maxDrawdown.toFixed(1)}%`,                       color: maxDrawdown > 15 ? "#f85149" : maxDrawdown > 8 ? "#d29922" : "#8b949e" },
            ].map(s => (
              <div key={s.label}>
                <div style={LBL}>{s.label}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: s.color, fontFamily: FONT_MONO }}>{s.value}</div>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* ── Section 3: Pair + Direction ─────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }} style={CARD}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 12 }}>Pair Performance</div>
          {pairRows.length === 0 ? (
            <div style={{ fontSize: 12, color: "#484f58" }}>No data yet</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {pairRows.map(([pair, s]) => {
                const barW = Math.abs(s.pnl) / maxAbsPnl * 100;
                const isPos = s.pnl >= 0;
                return (
                  <div key={pair}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                      <span style={{ color: "#e6edf3", fontFamily: FONT_MONO, fontWeight: 600 }}>{pair}</span>
                      <div style={{ display: "flex", gap: 12 }}>
                        <span style={{ color: "#8b949e" }}>{(s.wins / s.total * 100).toFixed(0)}% · {s.total}T</span>
                        <span style={{ color: pc(s.pnl), fontFamily: FONT_MONO }}>{hasClosed ? fmtD(s.pnl) : fmtPct(s.pnl)}</span>
                      </div>
                    </div>
                    <div style={{ height: 5, background: "#21262d", borderRadius: 3, overflow: "hidden" }}>
                      <motion.div initial={{ width: 0 }} animate={{ width: `${barW}%` }} transition={{ duration: 0.5 }}
                        style={{ height: "100%", background: isPos ? "#238636" : "#8e1a17", borderRadius: 3 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} style={CARD}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 12 }}>Direction Split</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {[
              { label: "LONG",  count: longs.length,  wr: longWr,  pnl: longPnl,  color: "#3fb950" },
              { label: "SHORT", count: shorts.length, wr: shortWr, pnl: shortPnl, color: "#f85149" },
            ].map(d => (
              <div key={d.label} style={{ background: "#0d1117", borderRadius: 8, padding: "12px 14px", border: "1px solid #21262d" }}>
                <div style={{ fontSize: 10, color: d.color, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 6 }}>{d.label}</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: "#e6edf3", fontFamily: FONT_MONO, marginBottom: 2 }}>{d.count}</div>
                <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 4 }}>{d.wr.toFixed(0)}% win rate</div>
                <div style={{ fontSize: 11, fontFamily: FONT_MONO, color: pc(d.pnl) }}>{hasClosed ? fmtD(d.pnl) : fmtPct(d.pnl)}</div>
              </div>
            ))}
          </div>
        </motion.div>
      </div>

      {/* ── Section 4: Strategy table ────────────────────────────────────────── */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }} style={{ ...CARD, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 12 }}>Strategy Performance</div>
        {Object.keys(stratStats).length === 0 ? (
          <div style={{ fontSize: 12, color: "#8b949e" }}>No data</div>
        ) : (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 52px 52px 80px 100px", gap: "0 8px", fontSize: 9, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.06em", paddingBottom: 8, borderBottom: "0.5px solid #21262d" }}>
              {["Strategy", "Trades", "Win %", "P&L", "Rating"].map(h => <div key={h}>{h}</div>)}
            </div>
            {Object.entries(stratStats).map(([name, s]) => {
              const wr = s.total > 0 ? s.wins / s.total * 100 : 0;
              return (
                <div key={name} style={{ display: "grid", gridTemplateColumns: "1fr 52px 52px 80px 100px", gap: "0 8px", padding: "9px 0", borderBottom: "0.5px solid #21262d", alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "#e6edf3" }}>{name}</span>
                  <span style={{ fontSize: 11, color: "#8b949e", fontFamily: FONT_MONO }}>{s.total}</span>
                  <span style={{ fontSize: 11, color: wr >= 50 ? "#3fb950" : "#f85149", fontFamily: FONT_MONO }}>{wr.toFixed(0)}%</span>
                  <span style={{ fontSize: 11, color: pc(s.pnl), fontFamily: FONT_MONO }}>{fmtPct(s.pnl)}</span>
                  {renderBadge(s)}
                </div>
              );
            })}
          </div>
        )}
      </motion.div>

      {/* ── Section 5: Session performance ──────────────────────────────────── */}
      {SESSION_ORDER.some(s => sessionStats[s]) && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} style={{ ...CARD, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 12 }}>Session Performance</div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(5, 1fr)", gap: 8 }}>
            {SESSION_ORDER.map(sess => {
              const s = sessionStats[sess];
              if (!s) return null;
              const wr = s.wins / s.total * 100;
              const c = SESSION_COLORS[sess] || "#8b949e";
              return (
                <div key={sess} style={{ background: "#0d1117", borderRadius: 8, padding: "10px 12px", border: "1px solid #21262d" }}>
                  <div style={{ fontSize: 9, color: c, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 6 }}>{sess}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#e6edf3", fontFamily: FONT_MONO }}>{s.total}</div>
                  <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 3 }}>{wr.toFixed(0)}% WR</div>
                  <div style={{ fontSize: 10, color: pc(s.pnl), fontFamily: FONT_MONO }}>{hasClosed ? fmtD(s.pnl) : fmtPct(s.pnl)}</div>
                </div>
              );
            })}
          </div>
        </motion.div>
      )}

      {/* ── Section 6: Xavier ───────────────────────────────────────────────── */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.45 }} style={{ ...CARD, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: "linear-gradient(135deg, #1f2d3d, #0d1117)", border: "1px solid #58a6ff44", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "#58a6ff", fontWeight: 700, fontFamily: FONT_MONO }}>X</div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3" }}>Xavier</div>
              <div style={{ fontSize: 9, color: "#8b949e" }}>Performance Coach</div>
            </div>
          </div>
          <button onClick={handleXavierAnalyze} disabled={xavierLoading}
            style={{ fontSize: 11, padding: "6px 14px", borderRadius: 6, border: "1px solid #30363d", background: xavierLoading ? "transparent" : "#1f2d3d", color: xavierLoading ? "#484f58" : "#58a6ff", cursor: xavierLoading ? "not-allowed" : "pointer", fontFamily: FONT_MONO, transition: "all 0.2s" }}>
            {xavierLoading ? "Analyzing…" : "Analyze my performance →"}
          </button>
        </div>
        {xavierNote ? (
          <div style={{ fontSize: 12, color: "#c9d1d9", lineHeight: 1.7, padding: "12px 14px", background: "#0d1117", borderRadius: 8, border: "1px solid #21262d" }}>{xavierNote}</div>
        ) : (
          <div style={{ fontSize: 11, color: "#6e7681", fontStyle: "italic", padding: "8px 0" }}>
            {trend === "improving" && `Recent form improving — last 5 trades at ${recentWr.toFixed(0)}% vs ${winRate.toFixed(0)}% overall. Ask Xavier for a deeper read.`}
            {trend === "declining" && `Recent form declining — last 5 trades at ${recentWr.toFixed(0)}% vs ${winRate.toFixed(0)}% overall. Ask Xavier what's going wrong.`}
            {trend === "stable"    && `Performance steady at ${winRate.toFixed(0)}% win rate. Ask Xavier for actionable improvements.`}
            {trend === "early"     && "Execute more trades to unlock trend analysis and Xavier coaching."}
          </div>
        )}
      </motion.div>

      {/* ── Trade log ───────────────────────────────────────────────────────── */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }} style={CARD}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 10 }}>
          {hasClosed ? "Closed Trade Log" : "Trade Log"}
        </div>
        {hasClosed ? (
          <div style={{ overflowX: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: "70px 55px 52px 65px 50px 44px 44px", gap: "0 8px", fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.05em", paddingBottom: 6, borderBottom: "0.5px solid #21262d", minWidth: 380 }}>
              {["Pair", "Dir", "Time", "P&L ($)", "Pips", "R", "Dur"].map(h => <div key={h}>{h}</div>)}
            </div>
            <div style={{ maxHeight: 280, overflowY: "auto" }}>
              {closedTrades.slice(0, 50).map((t, i) => {
                const isWin = t.realizedPL > 0;
                const closeDate = t.closeTime ? new Date(t.closeTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
                return (
                  <div key={t.oandaId || i} style={{ display: "grid", gridTemplateColumns: "70px 55px 52px 65px 50px 44px 44px", gap: "0 8px", padding: "6px 0", borderBottom: "0.5px solid #161b22", alignItems: "center", fontSize: 11, minWidth: 380 }}>
                    <span style={{ fontFamily: FONT_MONO, color: "#a5d6ff" }}>{t.pair}</span>
                    <span style={{ color: t.dir === "LONG" ? "#3fb950" : "#f85149", fontWeight: 600 }}>{t.dir}</span>
                    <span style={{ color: "#484f58" }}>{closeDate}</span>
                    <span style={{ fontFamily: FONT_MONO, color: isWin ? "#3fb950" : "#f85149", fontWeight: 600 }}>{isWin ? "+" : ""}${t.realizedPL?.toFixed(2)}</span>
                    <span style={{ fontFamily: FONT_MONO, color: isWin ? "#3fb950" : "#f85149" }}>{t.pips >= 0 ? "+" : ""}{t.pips}</span>
                    <span style={{ fontFamily: FONT_MONO, color: t.rMultiple != null ? (t.rMultiple >= 0 ? "#3fb950" : "#f85149") : "#484f58" }}>{t.rMultiple != null ? `${t.rMultiple >= 0 ? "+" : ""}${t.rMultiple}` : "—"}</span>
                    <span style={{ color: "#484f58" }}>{t.duration}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
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
                  <span style={{ fontFamily: FONT_MONO, color: pc(t.pnl ?? 0) }}>{t.pnl !== undefined ? fmtPct(t.pnl) : "—"}</span>
                  <span style={{ color: "#8b949e", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.aiReason || "—"}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </motion.div>
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
  { key: "schedule",  label: "Schedule", Icon: ({ color }) => <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> },
  { key: "backtest",  label: "Backtest", Icon: ({ color }) => <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> },
];

// ─── STRATEGY INTELLIGENCE ENGINE ────────────────────────────────────────────
// ─── M5 SIGNAL GENERATOR (backtest only — NOT protected generateSignal) ───────
function generateSignalM5(history, strategy, pair) {
  if (history.length < 20) return null;
  const recent = history.slice(-20);
  const ema9  = recent.slice(-9).reduce((a, b) => a + b, 0) / 9;
  const ema21 = recent.reduce((a, b) => a + b, 0) / 20;
  const last  = recent[recent.length - 1];
  const prev  = recent[recent.length - 2];
  const change = (last - recent[0]) / recent[0];
  let score = 0, direction = null, reason = [];

  if (strategy === "Trend Follow") {
    if (ema9 > ema21 && last > ema9) { score += 40; direction = "LONG";  reason.push("EMA bullish cross"); }
    else if (ema9 < ema21 && last < ema9) { score += 40; direction = "SHORT"; reason.push("EMA bearish cross"); }
    if (change > 0.001) { score += 25; direction = direction || "LONG";  reason.push("Uptrend M5"); }
    else if (change < -0.001) { score += 25; direction = direction || "SHORT"; reason.push("Downtrend M5"); }
  } else if (strategy === "Mean Revert") {
    const mean    = recent.reduce((a, b) => a + b, 0) / recent.length;
    const dev     = Math.abs(last - mean) / mean;
    const pairKey  = pair.replace("/", "_");
    const isSilver = pairKey.includes("XAG");
    const isGold   = pairKey.includes("XAU");
    const isOil    = pairKey.includes("BCO") || pairKey.includes("WTICO");
    const isJpy    = pairKey.includes("JPY");
    // M5 silver/oil thresholds: ~40% of live thresholds (5-min candles are much smaller)
    const t1 = isSilver ? 0.0015 : isOil ? 0.0012 : isGold ? 0.0003 : isJpy ? 0.0006 : 0.0005;
    const t2 = isSilver ? 0.0030 : isOil ? 0.0024 : isGold ? 0.0007 : isJpy ? 0.0012 : 0.001;
    const t3 = isSilver ? 0.0060 : isOil ? 0.0048 : isGold ? 0.0014 : isJpy ? 0.002  : 0.002;
    if (dev > t1) {
      const dir = last > mean ? "SHORT" : "LONG";
      score += 50;
      if (dev > t2) score += 10;
      if (dev > t3) score += 10;
      const returning = (dir === "LONG" && last > prev) || (dir === "SHORT" && last < prev);
      if (returning) score += 10;
      direction = dir;
      reason.push(`${(dev * 100).toFixed(3)}% deviation M5`);
    }
  } else if (strategy === "Breakout") {
    const high = Math.max(...recent), low = Math.min(...recent), range = high - low;
    if      (last > high - range * 0.05) { score += 45; direction = "LONG";  reason.push("Near range high"); }
    else if (last < low  + range * 0.05) { score += 45; direction = "SHORT"; reason.push("Near range low");  }
    if (direction) {
      const tr      = recent.slice(1).map((p, i) => Math.abs(p - recent[i]));
      const atr5    = tr.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const atrFull = tr.reduce((a, b) => a + b, 0) / tr.length;
      if (atr5 > atrFull * 1.1)                  { score += 10; reason.push("ATR expanding"); }
      if (Math.abs(last - prev) > atrFull * 1.5)  { score += 10; reason.push("Strong thrust"); }
    }
  } else if (strategy === "Momentum") {
    const momentum = (last - recent[recent.length - 10]) / recent[recent.length - 10];
    if (Math.abs(momentum) >= 0.002) {
      direction = momentum > 0 ? "LONG" : "SHORT";
      score += 55;
      reason.push(`${(momentum * 100).toFixed(3)}% momentum M5`);
      if (Math.abs(momentum) > 0.003) { score += 10; reason.push("Strong momentum"); }
      if ((direction === "LONG" && ema9 > ema21) || (direction === "SHORT" && ema9 < ema21)) { score += 5; reason.push("EMA confirms"); }
    }
  } else {
    const high20 = Math.max(...recent), low20 = Math.min(...recent);
    const rangeSize = high20 - low20;
    const rangePct  = low20 > 0 ? rangeSize / low20 : 1;
    if (rangePct < 0.003) {
      if      (last < low20  + rangeSize * 0.2) { score += 50; direction = "LONG";  reason.push("Range low boundary"); }
      else if (last > high20 - rangeSize * 0.2) { score += 50; direction = "SHORT"; reason.push("Range high boundary"); }
      if (direction) {
        const rsiProxy = 50 + (change / 0.005) * 20;
        if ((direction === "LONG" && rsiProxy < 45) || (direction === "SHORT" && rsiProxy > 55)) { score += 10; reason.push("Oscillator confirm"); }
      }
    }
  }

  const rsi = 50 + (change / 0.005) * 20;
  if (strategy === "Momentum") {
    if (direction === "LONG"  && rsi > 55) { score += 15; reason.push("RSI confirms"); }
    if (direction === "SHORT" && rsi < 45) { score += 15; reason.push("RSI confirms"); }
  } else {
    if (direction === "LONG"  && rsi < 45) { score += 15; reason.push("RSI oversold"); }
    if (direction === "SHORT" && rsi > 55) { score += 15; reason.push("RSI overbought"); }
  }
  if (!direction || score < 50) return null;
  return { score, direction, reason, rsi: parseFloat(rsi.toFixed(1)) };
}

// ─── AUTONOMOUS BACKTEST SIMULATION ───────────────────────────────────────────
async function runBtSimulation(closes, candles, strat, sessRange, pair, btConfig = {}) {
  const minScore  = btConfig.minScore  ?? 65;
  const signalFn  = btConfig.signalFn  ?? generateSignal;
  const isInSessLocal = (h, r) => { if (!r) return true; if (r.s > r.e) return h >= r.s || h < r.e; return h >= r.s && h < r.e; };
  const trades = [];
  const total  = closes.length;
  const CHUNK  = 300;
  // ── DEBUG counters ─────────────────────────────────────────────────────────
  let _sigsScanned = 0, _sigsPassScore = 0, _sigsPassSess = 0;
  console.log(`[BACKTEST] threshold: ${minScore} | sim start:`, pair, strat, '| candles:', total, '| session UTC:', JSON.stringify(sessRange));
  let i = 20;
  while (i < total) {
    await new Promise(resolve => setTimeout(resolve, 0));
    const end = Math.min(i + CHUNK, total - 1);
    while (i <= end) {
      const sig = signalFn(closes.slice(i - 20, i + 1), strat, pair);
      _sigsScanned++;
      if (sig && sig.score >= minScore && sig.direction) {
        _sigsPassScore++;
        const utcH = candles[i]?.time ? new Date(candles[i].time).getUTCHours() : 12;
        if (isInSessLocal(utcH, sessRange)) {
          _sigsPassSess++;
          const atrBars = candles.slice(Math.max(i - 4, 0), i + 1);
          const atr = atrBars.reduce((s, c) => s + Math.abs(parseFloat(c.mid?.h ?? 0) - parseFloat(c.mid?.l ?? 0)), 0) / atrBars.length || closes[i] * 0.001;
          const entry = closes[i];
          const sl = sig.direction === "LONG" ? entry - atr * 1.5 : entry + atr * 1.5;
          const tp = sig.direction === "LONG" ? entry + atr * 3   : entry - atr * 3;
          let resolveIdx = -1, hit = null;
          for (let j = i + 1; j < closes.length; j++) {
            const hi = parseFloat(candles[j]?.mid?.h ?? closes[j]);
            const lo = parseFloat(candles[j]?.mid?.l ?? closes[j]);
            if (sig.direction === "LONG") {
              if (hi >= tp) { resolveIdx = j; hit = "win"; break; }
              if (lo <= sl) { resolveIdx = j; hit = "loss"; break; }
            } else {
              if (lo <= tp) { resolveIdx = j; hit = "win"; break; }
              if (hi >= sl) { resolveIdx = j; hit = "loss"; break; }
            }
          }
          if (hit !== null) {
            trades.push({ win: hit === "win", rMultiple: hit === "win" ? 3.0 : -1.0 });
            i = resolveIdx + 1;
            continue;
          }
        }
      }
      i++;
    }
  }
  console.log(`[BACKTEST] ${pair} ${strat} | scanned:${_sigsScanned} score>=${minScore}:${_sigsPassScore} in-session:${_sigsPassSess} trades-resolved:${trades.length}`);
  if (trades.length < 10) return null;
  const wins     = trades.filter(t => t.win);
  const losses   = trades.filter(t => !t.win);
  const winRate  = wins.length / trades.length * 100;
  const expectancyR  = trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length;
  const profitFactor = losses.length > 0 ? (wins.length * 3) / losses.length : wins.length > 0 ? 999 : 0;
  const equityCurve  = trades.reduce((acc, t) => { acc.push(acc[acc.length - 1] + t.rMultiple); return acc; }, [0]);
  let maxDD = 0, peak = equityCurve[0];
  for (const v of equityCurve) { if (v > peak) peak = v; if (peak - v > maxDD) maxDD = peak - v; }
  const rArr  = trades.map(t => t.rMultiple);
  const rMean = rArr.reduce((a, b) => a + b, 0) / rArr.length;
  const rStd  = Math.sqrt(rArr.reduce((a, b) => a + (b - rMean) ** 2, 0) / rArr.length);
  const sharpe = rStd > 0 ? parseFloat((rMean / rStd).toFixed(2)) : 0;
  return { trades: trades.length, winRate, expectancyR, profitFactor, maxDD, sharpe, signalCount: _sigsPassSess };
}

// ─── XAVIER AUTONOMOUS OPTIMIZER HOOK ─────────────────────────────────────────
function useAutonomousBacktest() {
  const OPT_KEY    = "xavier_optimization_results";
  const M5_OPT_KEY = "xavier_optimization_m5";
  const STRATS   = ["Mean Revert", "Trend Follow", "Breakout", "Momentum", "Range Scalp"];
  const PAIRS    = [
    "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "EUR/GBP", "NZD/USD",
    "XAU/USD", "XAG/USD",
    "BCO/USD", "WTICO/USD",
    "NAS100_USD", "JP225_USD", "UK100_GBP", "AU200_AUD", "SPX500_USD",
  ];
  const SESSIONS   = ["Tokyo", "London", "Prime", "NY", "Sydney"];
  const SESS_UTC   = { Tokyo: { s: 0, e: 9 }, London: { s: 7, e: 16 }, Prime: { s: 13, e: 17 }, NY: { s: 17, e: 20 }, Sydney: { s: 22, e: 4 } };
  const TOTAL_PER  = STRATS.length * PAIRS.length * SESSIONS.length; // 400 per timeframe
  const TOTAL_ALL  = TOTAL_PER * 2; // 800 combined

  const [running,  setRunning]  = useState(false);
  const [progress, setProgress] = useState(0);
  const [label,    setLabel]    = useState("");
  const [done,     setDone]     = useState(0);
  const [result,   setResult]   = useState(() => { try { return JSON.parse(localStorage.getItem(OPT_KEY)) || null; } catch { return null; } });
  const [m5Result, setM5Result] = useState(() => { try { return JSON.parse(localStorage.getItem(M5_OPT_KEY)) || null; } catch { return null; } });
  const cancelRef  = useRef(false);
  const runningRef = useRef(false);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true; cancelRef.current = false;
    setRunning(true); setProgress(0); setDone(0);

    // ── Phase 1: M15 backtest (swing / Kill Shot) ──────────────────────────────
    setLabel("Starting M15 optimization…");
    {
      const allCombos = []; const rawResults = []; const pairStats = {}; const pairEdge = {}; const candleCounts = {}; let combosDone = 0;
      for (const pair of PAIRS) {
        if (cancelRef.current) break;
        setLabel(`[M15] Fetching ${pair} (90d)…`);
        let candles = [];
        try {
          const r = await fetch(`${BRIDGE}/backtest/candles?instrument=${pair.replace("/", "_")}&granularity=M15&days=90`);
          const data = await r.json();
          if (!Array.isArray(data.candles) || data.candles.length < 22) { combosDone += STRATS.length * SESSIONS.length; setDone(combosDone); continue; }
          candles = data.candles;
          const _fDate = candles[0]?.time ? new Date(candles[0].time).toISOString().slice(0, 10) : '?';
          const _lDate = candles[candles.length - 1]?.time ? new Date(candles[candles.length - 1].time).toISOString().slice(0, 10) : '?';
          const _calDays = candles[0]?.time && candles[candles.length - 1]?.time
            ? Math.round((new Date(candles[candles.length - 1].time) - new Date(candles[0].time)) / 86400000) : 0;
          console.log('[BACKTEST-M15] candles:', candles.length, 'for', pair, '|', _calDays, 'd |', _fDate, '→', _lDate);
          candleCounts[pair] = { count: candles.length, days: _calDays };
        } catch { combosDone += STRATS.length * SESSIONS.length; setDone(combosDone); continue; }
        const closes = candles.map(c => parseFloat(c.mid?.c ?? 0)).filter(v => v > 0 && !isNaN(v));
        if (closes.length < 22) { combosDone += STRATS.length * SESSIONS.length; setDone(combosDone); continue; }
        for (const strat of STRATS) {
          if (cancelRef.current) break;
          for (const sess of SESSIONS) {
            if (cancelRef.current) break;
            setLabel(`[M15] ${pair} · ${strat} · ${sess}`);
            const res = await runBtSimulation(closes, candles, strat, SESS_UTC[sess], pair);
            combosDone++; setDone(combosDone); setProgress(Math.round(combosDone / TOTAL_ALL * 100));
            rawResults.push({ pair, strategy: strat, session: sess, trades: res?.trades ?? 0, winRate: res?.winRate ?? null, expectancyR: res?.expectancyR ?? null, profitFactor: res?.profitFactor ?? null, maxDD: res?.maxDD ?? null, sharpe: res?.sharpe ?? null });
            if (res) {
              if (!pairStats[pair]) {
                pairStats[pair] = { bestExpectancy: res.expectancyR, bestTrades: res.trades, bestDD: res.maxDD };
              } else {
                if (res.expectancyR > pairStats[pair].bestExpectancy) pairStats[pair].bestExpectancy = res.expectancyR;
                if (res.trades     > pairStats[pair].bestTrades)     pairStats[pair].bestTrades     = res.trades;
                if (res.maxDD      < pairStats[pair].bestDD)         pairStats[pair].bestDD          = res.maxDD;
              }
              if (!pairEdge[pair] || res.expectancyR > (pairEdge[pair].bestExpectancy ?? -Infinity))
                pairEdge[pair] = { bestExpectancy: res.expectancyR, bestTrades: res.trades, bestDD: res.maxDD };
            }
            if (res && res.expectancyR >= 0 && res.trades >= 30 && res.maxDD <= 15) {
              const score = Math.max(0, res.expectancyR) * 60 + res.profitFactor * 20 + res.sharpe * 10 + (res.trades >= 30 ? 10 : 0);
              allCombos.push({ strategy: strat, pair, session: sess, score, expectancyR: res.expectancyR, winRate: res.winRate, profitFactor: res.profitFactor, sharpe: res.sharpe, trades: res.trades });
            }
          }
        }
      }
      if (!cancelRef.current) {
        const rules = {};
        for (const sess of SESSIONS) {
          const sessR = allCombos.filter(c => c.session === sess).sort((a, b) => b.score - a.score);
          if (sessR.length > 0) {
            const best = sessR[0];
            const bestPairsDetail = sessR.filter(c => c.strategy === best.strategy).slice(0, 3).map(c => ({ pair: c.pair, trades: c.trades, winRate: parseFloat(c.winRate.toFixed(1)), expectancyR: parseFloat(c.expectancyR.toFixed(2)) }));
            rules[sess.toUpperCase()] = { strategy: best.strategy, pairs: bestPairsDetail.map(p => p.pair), pairsDetail: bestPairsDetail, expectancy: parseFloat(best.expectancyR.toFixed(2)), score: Math.round(best.score) };
          }
        }
        const top3 = [...allCombos].sort((a, b) => b.score - a.score).slice(0, 3);
        const validatedPairs = []; const blockedPairs = [];
        for (const p of PAIRS) {
          const s = pairStats[p];
          if (s && s.bestExpectancy >= 0.30 && s.bestTrades >= 30 && s.bestDD <= 15) {
            validatedPairs.push(p);
          } else {
            const reason = !s ? 'no data' : s.bestExpectancy < 0.30 ? `best ${s.bestExpectancy.toFixed(2)}R < 0.30R` : s.bestTrades < 30 ? `only ${s.bestTrades} trades` : `DD ${s.bestDD.toFixed(1)}R > 15R`;
            blockedPairs.push({ pair: p, reason });
          }
        }
        const newResult = { lastUpdated: Date.now(), totalCombinationsTested: combosDone, rules, top3, validatedPairs, blockedPairs, candleCounts, pairEdge };
        localStorage.setItem(OPT_KEY, JSON.stringify(newResult));
        localStorage.setItem('xavier_backtest_raw', JSON.stringify(rawResults));
        setResult(newResult);
      }
    }

    // ── Phase 2: M5 backtest (live auto-execution) ─────────────────────────────
    if (!cancelRef.current) {
      setLabel("Starting M5 optimization…");
      const allCombos = []; const pairStats = {}; const pairEdge = {}; const candleCounts = {}; let combosDone = 0; let totalM5Signals = 0;
      for (const pair of PAIRS) {
        if (cancelRef.current) break;
        setLabel(`[M5] Fetching ${pair} (90d)…`);
        let candles = [];
        try {
          const r = await fetch(`${BRIDGE}/backtest/candles?instrument=${pair.replace("/", "_")}&granularity=M5&days=90`);
          const data = await r.json();
          if (!Array.isArray(data.candles) || data.candles.length < 22) { combosDone += STRATS.length * SESSIONS.length; setDone(TOTAL_PER + combosDone); continue; }
          candles = data.candles;
          const _fDate = candles[0]?.time ? new Date(candles[0].time).toISOString().slice(0, 10) : '?';
          const _lDate = candles[candles.length - 1]?.time ? new Date(candles[candles.length - 1].time).toISOString().slice(0, 10) : '?';
          const _calDays = candles[0]?.time && candles[candles.length - 1]?.time
            ? Math.round((new Date(candles[candles.length - 1].time) - new Date(candles[0].time)) / 86400000) : 0;
          console.log('[BACKTEST-M5] candles:', candles.length, 'for', pair, '|', _calDays, 'd |', _fDate, '→', _lDate);
          candleCounts[pair] = { count: candles.length, days: _calDays };
        } catch { combosDone += STRATS.length * SESSIONS.length; setDone(TOTAL_PER + combosDone); continue; }
        const closes = candles.map(c => parseFloat(c.mid?.c ?? 0)).filter(v => v > 0 && !isNaN(v));
        if (closes.length < 22) { combosDone += STRATS.length * SESSIONS.length; setDone(TOTAL_PER + combosDone); continue; }
        for (const strat of STRATS) {
          if (cancelRef.current) break;
          for (const sess of SESSIONS) {
            if (cancelRef.current) break;
            setLabel(`[M5] ${pair} · ${strat} · ${sess}`);
            const res = await runBtSimulation(closes, candles, strat, SESS_UTC[sess], pair, { minScore: 55, signalFn: generateSignalM5 });
            combosDone++; setDone(TOTAL_PER + combosDone); setProgress(Math.round((TOTAL_PER + combosDone) / TOTAL_ALL * 100));
            if (res) { totalM5Signals += res.signalCount || 0;
              if (!pairStats[pair]) {
                pairStats[pair] = { bestExpectancy: res.expectancyR, bestTrades: res.trades, bestDD: res.maxDD };
              } else {
                if (res.expectancyR > pairStats[pair].bestExpectancy) pairStats[pair].bestExpectancy = res.expectancyR;
                if (res.trades     > pairStats[pair].bestTrades)     pairStats[pair].bestTrades     = res.trades;
                if (res.maxDD      < pairStats[pair].bestDD)         pairStats[pair].bestDD          = res.maxDD;
              }
              if (!pairEdge[pair] || res.expectancyR > (pairEdge[pair].bestExpectancy ?? -Infinity))
                pairEdge[pair] = { bestExpectancy: res.expectancyR, bestTrades: res.trades, bestDD: res.maxDD };
            }
            if (res && res.expectancyR >= 0 && res.trades >= 50 && res.maxDD <= 10) {
              const score = Math.max(0, res.expectancyR) * 60 + res.profitFactor * 20 + res.sharpe * 10 + 10;
              allCombos.push({ strategy: strat, pair, session: sess, score, expectancyR: res.expectancyR, winRate: res.winRate, profitFactor: res.profitFactor, sharpe: res.sharpe, trades: res.trades });
            }
          }
        }
      }
      if (!cancelRef.current) {
        const rules = {};
        for (const sess of SESSIONS) {
          const sessR = allCombos.filter(c => c.session === sess).sort((a, b) => b.score - a.score);
          if (sessR.length > 0) {
            const best = sessR[0];
            const bestPairsDetail = sessR.filter(c => c.strategy === best.strategy).slice(0, 3).map(c => ({ pair: c.pair, trades: c.trades, winRate: parseFloat(c.winRate.toFixed(1)), expectancyR: parseFloat(c.expectancyR.toFixed(2)) }));
            rules[sess.toUpperCase()] = { strategy: best.strategy, pairs: bestPairsDetail.map(p => p.pair), pairsDetail: bestPairsDetail, expectancy: parseFloat(best.expectancyR.toFixed(2)), score: Math.round(best.score) };
          }
        }
        const top3 = [...allCombos].sort((a, b) => b.score - a.score).slice(0, 3);
        const validatedPairs = []; const blockedPairs = [];
        for (const p of PAIRS) {
          const s = pairStats[p];
          if (s && s.bestExpectancy >= 0.30 && s.bestTrades >= 50 && s.bestDD <= 10) {
            validatedPairs.push(p);
          } else {
            const reason = !s ? 'no data' : s.bestExpectancy < 0.30 ? `best ${s.bestExpectancy.toFixed(2)}R < 0.30R` : s.bestTrades < 50 ? `only ${s.bestTrades} trades` : `DD ${s.bestDD.toFixed(1)}R > 10R`;
            blockedPairs.push({ pair: p, reason });
          }
        }
        const newM5Result = { lastUpdated: Date.now(), totalCombinationsTested: combosDone, rules, top3, validatedPairs, blockedPairs, candleCounts, pairEdge, totalSignals: totalM5Signals };
        localStorage.setItem(M5_OPT_KEY, JSON.stringify(newM5Result));
        setM5Result(newM5Result);
      }
    }

    setLabel(""); setRunning(false); setProgress(cancelRef.current ? 0 : 100);
    runningRef.current = false;
  }, []); // eslint-disable-line

  const cancel = useCallback(() => { cancelRef.current = true; }, []);

  // Auto-run on mount if > 7 days since last run
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(OPT_KEY));
      if (!stored || Date.now() - stored.lastUpdated > 7 * 86400000) {
        const t = setTimeout(() => { if (!runningRef.current) run(); }, 8000);
        return () => clearTimeout(t);
      }
    } catch { /* fresh install */ }
  }, []); // eslint-disable-line

  // Sunday 11pm Calgary scheduler (UTC-6)
  useEffect(() => {
    const id = setInterval(() => {
      const calgary = new Date(Date.now() - 6 * 3600000);
      if (calgary.getUTCDay() === 0 && calgary.getUTCHours() === 23 && calgary.getUTCMinutes() < 5 && !runningRef.current) run();
    }, 60000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line

  return { running, progress, label, done, total: TOTAL_ALL, result, m5Result, run, cancel };
}

function useXavierStrategy(session) {
  const XAVIER_RULES = {
    TOKYO:  "Mean Revert",
    SYDNEY: "Breakout",
    LONDON: "Trend Follow",
    PRIME:  "Trend Follow",
    NY:     "Momentum",
    AVOID:  null,
  };
  return XAVIER_RULES[session] || "Mean Revert";
}


function StrategyNotification({ notification, onDismiss }) {
  useEffect(() => {
    if (!notification) return;
    const id = setTimeout(onDismiss, 9000);
    return () => clearTimeout(id);
  }, [notification?.key]); // eslint-disable-line

  return (
    <AnimatePresence>
      {notification && (
        <motion.div
          key={notification.key}
          initial={{ opacity: 0, x: 40 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 40 }}
          transition={{ duration: 0.25 }}
          style={{ position: "fixed", top: 16, right: 16, zIndex: 999, background: "#161b22", borderTop: "1px solid #21262d", borderRight: "1px solid #21262d", borderBottom: "1px solid #21262d", borderLeft: "3px solid #58a6ff", borderRadius: 10, padding: "12px 14px", maxWidth: 300, display: "flex", gap: 10, alignItems: "flex-start", boxShadow: "0 4px 24px rgba(0,0,0,0.5)" }}
        >
          <div style={{ width: 26, height: 26, borderRadius: "50%", background: "linear-gradient(135deg, #1f4e8c 0%, #0d1117 100%)", border: "1px solid #388bfd", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: "#58a6ff", fontFamily: FONT_MONO }}>X</span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, color: "#58a6ff", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Xavier · Strategy Switch</div>
            <div style={{ fontSize: 11, color: "#c9d1d9", lineHeight: 1.7 }}>{notification.text}</div>
          </div>
          <button onClick={onDismiss} style={{ background: "none", border: "none", color: "#484f58", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 2, flexShrink: 0 }}>✕</button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function StrategyIntelCard({ strategyReason, nextSwitch, isManualOverride, manualLockMins, performanceMap, strategy }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 16px", background: "#0d1117", borderBottom: "1px solid #161b22", fontSize: 10, flexWrap: "wrap", minHeight: 26 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
        {isManualOverride ? (
          <><span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "rgba(210,153,34,0.1)", border: "1px solid #7a5200", color: "#d29922", fontWeight: 700 }}>MANUAL</span>
          <span style={{ color: "#8b949e" }}>· auto in {manualLockMins}m</span></>
        ) : (
          <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "rgba(63,185,80,0.08)", border: "1px solid #238636", color: "#3fb950", fontWeight: 700 }}>AUTO</span>
        )}
      </div>
      {strategyReason && <><span style={{ color: "#21262d" }}>·</span><span style={{ color: "#8b949e" }}>{strategyReason}</span></>}
      {nextSwitch && (
        <><span style={{ color: "#21262d" }}>·</span>
        <span style={{ color: "#484f58" }}>Next: <span style={{ color: "#8b949e" }}>{nextSwitch.strategy}</span> at {nextSwitch.session} open in <span style={{ color: "#484f58" }}>{nextSwitch.countdown}</span></span></>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const BASE_PRICES = {
  "EUR/USD": 1.08420, "GBP/USD": 1.26710, "USD/JPY": 149.850, "AUD/USD": 0.65230,
  "USD/CAD": 1.36540, "XAU/USD": 2312.40, "SPX500_USD": 5248.30,
  "XAG/USD": 32.50,   "BCO/USD": 82.00,   "WTICO/USD": 78.00,
  "NAS100_USD": 19500, "JP225_USD": 38000, "UK100_GBP": 8400, "AU200_AUD": 7800,
};

// ─── XAVIER PRINCIPLE WEIGHTS HOOK ────────────────────────────────────────────
function useXavierPrincipleWeights(closedTrades = []) {
  const WEIGHTS_KEY = 'xavier_principle_weights';
  const DEFAULT_W   = { scoreThreshold: 65, newsWindowMins: 120, capitalPreservation: 1.0, informationFiltering: 1.0, patience: 1.0 };
  const [weights, setWeights] = useState(() => { try { return JSON.parse(localStorage.getItem(WEIGHTS_KEY)) || DEFAULT_W; } catch { return DEFAULT_W; } });
  const [wisdomMessage, setWisdomMessage] = useState(null);
  const prevLenRef = useRef(closedTrades.length);

  useEffect(() => {
    if (closedTrades.length === prevLenRef.current) return;
    prevLenRef.current = closedTrades.length;
    const recent = [...closedTrades].reverse();
    let losses = 0, wins = 0;
    for (const t of recent) {
      const pnl = parseFloat(t.realizedPL ?? t.pnl ?? 0);
      if (pnl < 0) { if (wins   > 0) break; losses++; }
      else         { if (losses > 0) break; wins++;   }
    }
    let newW = { ...weights }; let msg = null;
    if (losses >= 3 && newW.scoreThreshold < 75) {
      newW = { ...newW, scoreThreshold: 75, capitalPreservation: 1.5 };
      msg  = `Three losses. Invoking Capital Preservation (Principle 2) — raising bar to 75%. No marginal setups.`;
    } else if (wins >= 5 && newW.scoreThreshold > 65) {
      newW = { ...newW, scoreThreshold: 65, capitalPreservation: 1.0 };
      msg  = `Five wins. Staying disciplined (Principle 7) — same process, same standards. Threshold reset to 65%.`;
    }
    if (JSON.stringify(newW) !== JSON.stringify(weights)) {
      setWeights(newW);
      localStorage.setItem(WEIGHTS_KEY, JSON.stringify(newW));
      if (msg) setWisdomMessage(msg);
      fetch(`${BRIDGE}/xavier-weights`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newW) }).catch(() => {});
    }
  }, [closedTrades.length]); // eslint-disable-line

  return { weights, wisdomMessage, clearWisdom: () => setWisdomMessage(null) };
}

// ─── TRADE REINFORCEMENT HOOK ─────────────────────────────────────────────────
function useTradeReinforcement(closedTrades) {
  const [reinforcement, setReinforcement] = useState(() => {
    try { return JSON.parse(localStorage.getItem("reinforcement_thresholds") || "{}"); } catch { return {}; }
  });

  useEffect(() => {
    if (!closedTrades || closedTrades.length < 30) {
      localStorage.removeItem("reinforcement_thresholds");
      setReinforcement({});
      return;
    }
    // Strip spread-noise trades — only learn from trades with real signal value
    const recent = closedTrades.slice(-50).filter(t => Math.abs(parseFloat(t.rMultiple || 0)) >= 0.10);

    // Per-pair win rates over last 10 meaningful trades per pair
    const pairBuckets = {};
    recent.forEach(t => {
      const p = t.instrument || t.pair || "UNKNOWN";
      if (!pairBuckets[p]) pairBuckets[p] = [];
      pairBuckets[p].push(t);
    });

    const pairThresholds = {};
    Object.entries(pairBuckets).forEach(([pair, trades]) => {
      const last10 = trades.slice(-10);
      if (last10.length < 3) return;    // need 3+ trades to appear in stats
      if (last10.length < 10) { pairThresholds[pair] = 65; return; } // 10+ required to adjust threshold
      const wins = last10.filter(t => (parseFloat(t.pnl || t.realizedPL || 0)) > 0).length;
      const wr = wins / last10.length;
      if (wr < 0.35) pairThresholds[pair] = 75; // struggling — raise bar
      else if (wr > 0.60) pairThresholds[pair] = 60; // strong edge — trade more
      else pairThresholds[pair] = 65; // default
    });

    // Per-strategy consecutive loss penalty
    const strategyPenalties = {};
    const byStrategy = {};
    recent.forEach(t => {
      const s = t.strategy || "Unknown";
      if (!byStrategy[s]) byStrategy[s] = [];
      byStrategy[s].push(t);
    });
    Object.entries(byStrategy).forEach(([strat, trades]) => {
      const last5 = trades.slice(-5);
      let consecutive = 0;
      for (let i = last5.length - 1; i >= 0; i--) {
        if ((parseFloat(last5[i].pnl || last5[i].realizedPL || 0)) < 0) consecutive++;
        else break;
      }
      if (consecutive >= 3) strategyPenalties[strat] = 10;
      else strategyPenalties[strat] = 0;
    });

    // Per-session bonus/penalty
    const sessionBonuses = {};
    const bySession = {};
    recent.forEach(t => {
      const s = t.session || "UNKNOWN";
      if (!bySession[s]) bySession[s] = [];
      bySession[s].push(t);
    });
    Object.entries(bySession).forEach(([sess, trades]) => {
      if (trades.length < 3) return;
      const wins = trades.filter(t => (parseFloat(t.pnl || t.realizedPL || 0)) > 0).length;
      const wr = wins / trades.length;
      sessionBonuses[sess] = wr > 0.60 ? -5 : wr < 0.35 ? 5 : 0; // negative = lower threshold
    });

    const next = { pairThresholds, strategyPenalties, sessionBonuses, updatedAt: Date.now() };
    setReinforcement(next);
    localStorage.setItem("reinforcement_thresholds", JSON.stringify(next));
  }, [closedTrades.length]); // eslint-disable-line

  return reinforcement;
}

export default function TradingRobot() {
  const [strategy, setStrategy] = useState(() => localStorage.getItem("active_strategy") || "Mean Revert");
  const [trades, setTrades] = useState([]);
  const [balance, setBalance] = useState(100.0);
  const [activeRule, setActiveRule] = useState(null);
  const [autoMode, setAutoMode] = useState(() => localStorage.getItem("autoMode") === "true");
  const [autoTradeLog, setAutoTradeLog] = useState([]);
  const [autoModeLoading, setAutoModeLoading] = useState(false);
  const [showAutoSettings, setShowAutoSettings] = useState(false);
  const [autoSettings, setAutoSettings] = useState({
    minConfidence: 65,
    maxTradesPerHour: 2,
    maxHeat: 3,
    consensusRequired: 3,
    profitTarget: 3,
    stopLoss: 1,
  });
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem("xavier_onboarded"));
  const completeOnboarding = useCallback(() => {
    localStorage.setItem("xavier_onboarded", "true");
    setShowOnboarding(false);
  }, []);

  const [tab, setTab] = useState("markets");
  const [currentHeadline, setCurrentHeadline] = useState("Loading latest news...");
  const [liveHeadlines, setLiveHeadlines] = useState([]);
  const [newsLastFetchedAt, setNewsLastFetchedAt] = useState(0);
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
  const [closedTrades, setClosedTrades] = useState(() => {
    try { return JSON.parse(localStorage.getItem("qb_closed_trades") || "[]"); } catch { return []; }
  });
  const seenClosedIdsRef = useRef(new Set(
    (() => { try { return JSON.parse(localStorage.getItem("qb_closed_trades") || "[]").map(t => t.oandaId); } catch { return []; } })()
  ));

  // One-time seed: XAG/USD LONDON loss (2026-05-27) — occurred before xavier_memory existed
  useEffect(() => {
    if (localStorage.getItem('xavier_memory_seeded_v1')) return;
    updateXavierMemory({
      id:        'seed-xagusd-london-loss-20260527',
      pair:      'XAG/USD',
      direction: 'SHORT',
      session:   'LONDON',
      strategy:  'Mean Revert',
      score:     65,
      pnl:       -1,
      rMultiple: -1.0,
      duration:  '11 minutes',
      timestamp: new Date('2026-05-27T10:00:00Z').getTime(),
    });
    localStorage.setItem('xavier_memory_seeded_v1', '1');
  }, []);
  const oandaNavRef = useRef(null);
  const xavierIntelRef = useRef(null);
  const reinforcement    = useTradeReinforcement(closedTrades);
  const principleWeights = useXavierPrincipleWeights(closedTrades);

  // Reset reinforcement thresholds to defaults on mount — clears any biased data from sim runs
  useEffect(() => {
    const stored = localStorage.getItem("reinforcement_thresholds");
    if (stored) {
      try {
        const r = JSON.parse(stored);
        if (r.pairThresholds) Object.keys(r.pairThresholds).forEach(k => { r.pairThresholds[k] = 65; });
        if (r.strategyPenalties) r.strategyPenalties = {};
        if (r.sessionBonuses)    r.sessionBonuses    = {};
        localStorage.setItem("reinforcement_thresholds", JSON.stringify(r));
      } catch {}
    }
  }, []);

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
          // Reconcile: auto-add any OANDA trade not yet in swingTrades (server-fired Kill Shots)
          setSwingTrades(prev => {
            const trackedIds = new Set(prev.map(t => t.oandaId).filter(Boolean));
            const toAdd = data.trades.filter(o => !trackedIds.has(o.id));
            if (toAdd.length === 0) return prev;
            const newTrades = toAdd.map(o => ({
              id:       `swing_${o.id}`,
              oandaId:  o.id,
              pair:     o.instrument?.replace('_', '/'),
              direction: parseFloat(o.currentUnits) >= 0 ? 'LONG' : 'SHORT',
              entry:    parseFloat(o.price),
              sl:       o.stopLossOrder?.price  ? parseFloat(o.stopLossOrder.price)  : null,
              tp1:      o.takeProfitOrder?.price ? parseFloat(o.takeProfitOrder.price) : null,
              score:    null,
              thesis:   `Server Kill Shot — OANDA #${o.id}`,
              closed:   false,
              openedAt: new Date(o.openTime).getTime(),
            }));
            const next = [...prev, ...newTrades];
            localStorage.setItem('swing_trades', JSON.stringify(next));
            return next;
          });
        }
      } catch {}
    };
    fetchOpenTrades();
    const id = setInterval(fetchOpenTrades, 3000);
    return () => clearInterval(id);
  }, []);

  // Authoritative OANDA position sync — ensures Risk tab, heat, and circuit breaker
  // reflect positions opened outside this session (direct OANDA, server auto-trades, etc.)
  useEffect(() => {
    const syncPositions = async () => {
      try {
        const r = await fetch(`${BRIDGE}/positions`);
        const data = await r.json();
        if (Array.isArray(data.trades)) {
          setOpenTrades(prev =>
            openTradesFingerprint(prev) === openTradesFingerprint(data.trades) ? prev : data.trades
          );
        }
      } catch {}
    };
    syncPositions();
    const id = setInterval(syncPositions, 30_000);
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
    fetch(`${BRIDGE}/health`).then(r => r.json()).then(d => {
      const val = d.autoMode === true;
      setAutoMode(val);
      localStorage.setItem("autoMode", String(val));
    }).catch(() => {});
  }, []);

  // One-time migration: clear stale open-trade entries that were incorrectly
  // saved to qb_closed_trades at open time with 0 P&L. Start fresh so only
  // real closed trades with realized P&L are stored.
  useEffect(() => {
    if (!localStorage.getItem('qb_closed_trades_v2')) {
      localStorage.removeItem('qb_closed_trades');
      seenClosedIdsRef.current.clear();
      setClosedTrades([]);
      localStorage.setItem('qb_closed_trades_v2', '1');
    }
  }, []); // eslint-disable-line

  // Persist closed trades to localStorage on change
  useEffect(() => {
    localStorage.setItem("qb_closed_trades", JSON.stringify(closedTrades.slice(0, 200)));
  }, [closedTrades]);

  // Sync journal from OANDA open positions — adds entries for trades not placed in this session
  const journalledOandaIdsRef = useRef(new Set());
  useEffect(() => {
    openTrades.forEach(t => {
      const key = `oanda-${t.id}`;
      if (journalledOandaIdsRef.current.has(key)) return;
      journalledOandaIdsRef.current.add(key);
      const pair = (t.instrument || "").replace("_", "/");
      const units = parseInt(t.currentUnits || 0);
      const dir = units > 0 ? "LONG" : "SHORT";
      const fillPrice = parseFloat(t.price || 0);
      const dec = pair.includes("JPY") ? 3 : pair.includes("XAU") || pair.includes("SPX") ? 2 : 5;
      const timeStr = t.openTime
        ? new Date(t.openTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
        : new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      setTrades(prev => {
        if (prev.some(j => j.id === key)) return prev;
        return [...prev, {
          id: key,
          pair, dir,
          price: fillPrice > 0 ? fillPrice.toFixed(dec) : "—",
          strategy: localStorage.getItem("active_strategy") || "—",
          time: timeStr,
          score: 0,
          aiReason: "Synced from OANDA",
          pnl: 0,
        }];
      });
    });
  }, [openTrades]);

  // Close detection — polls OANDA closed trades, detects new closes, computes P&L
  useEffect(() => {
    const fetchClosed = async () => {
      try {
        const r = await fetch(`${BRIDGE}/closed-trades?count=50`);
        const data = await r.json();
        if (!Array.isArray(data.trades)) return;

        const newEntries = [];
        for (const t of data.trades) {
          if (seenClosedIdsRef.current.has(t.id)) continue;
          seenClosedIdsRef.current.add(t.id);

          const instrument = t.instrument || "";
          const pair = instrument.replace("_", "/");
          const initialUnits = parseInt(t.initialUnits || 0);
          const dir = initialUnits > 0 ? "LONG" : "SHORT";
          const entryPrice = parseFloat(t.price || 0);
          const closePrice = parseFloat(t.averageClosePrice || 0);
          const realizedPL = parseFloat(t.realizedPL || 0);
          const pipSize = PIP_SIZE[pair] || 0.0001;
          const rawPips = (closePrice - entryPrice) / pipSize;
          const pips = parseFloat((dir === "LONG" ? rawPips : -rawPips).toFixed(1));

          const openMs = new Date(t.openTime).getTime();
          const closeMs = new Date(t.closeTime || Date.now()).getTime();
          const diffMins = Math.round(Math.max((closeMs - openMs) / 60_000, 0));
          const duration = diffMins >= 60
            ? `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`
            : `${diffMins}m`;

          const stopLossPrice = parseFloat(t.stopLossOrder?.price || 0);
          const absUnits = Math.abs(initialUnits);
          // USD-base pairs (USD/JPY, USD/CAD) need price conversion to get USD P&L per unit
          const isUsdBase = pair.startsWith("USD/");
          const pipValue = isUsdBase ? 1 / entryPrice : 1;
          const oneR = stopLossPrice > 0 && entryPrice > 0
            ? Math.abs(entryPrice - stopLossPrice) * absUnits * pipValue
            : 0;
          const rawR = oneR > 0 ? realizedPL / oneR : 0;
          const rMultiple = parseFloat(Math.max(-5, Math.min(10, rawR)).toFixed(2));
          console.log("[TRADE CLOSE]", pair,
            "pnl:", realizedPL.toFixed(2),
            "entry:", entryPrice,
            "sl:", stopLossPrice || "none",
            "oneR:", oneR.toFixed(4),
            "rMultiple:", rMultiple);

          newEntries.push({
            id:         t.id,
            oandaId:    t.id,
            pair,
            dir,
            direction:  dir,
            entry:      entryPrice,
            entryPrice,
            stopLoss:   stopLossPrice || null,
            closePrice,
            pnl:        parseFloat(realizedPL.toFixed(2)),
            realizedPL: parseFloat(realizedPL.toFixed(2)),
            pips,
            rMultiple,
            duration,
            session:    deriveSession(t.openTime),
            strategy:   localStorage.getItem('active_strategy') || 'Unknown',
            openTime:   t.openTime,
            closeTime:  t.closeTime,
            timestamp:  new Date(t.closeTime || Date.now()).getTime(),
          });
        }

        if (newEntries.length > 0) {
          setClosedTrades(prev => [...newEntries, ...prev].slice(0, 200));
          for (const entry of newEntries) {
            notifyRef.current?.(entry.realizedPL > 0 ? 'take_profit' : 'stop_loss', entry);
            // Feed Xavier's memory on every trade close
            updateXavierMemory({
              id:        entry.oandaId,
              pair:      entry.pair,
              direction: entry.dir,
              session:   deriveSession(entry.openTime),
              strategy:  localStorage.getItem('active_strategy') || 'UNKNOWN',
              score:     0,
              pnl:       entry.realizedPL,
              rMultiple: entry.rMultiple || 0,
              duration:  entry.duration,
              timestamp: Date.now(),
            });
          }
        }
      } catch {}
    };
    fetchClosed();
    const id = setInterval(fetchClosed, 30_000);
    return () => clearInterval(id);
  }, []);

  // Refs so the interval never captures stale closures
  const signalDataRef = useRef({});
  const autoSettingsRef = useRef(autoSettings);
  const openTradesRef = useRef(openTrades);
  const livePricesRef = useRef(livePrices);
  const tradeMgmtRef = useRef({});
  const strategyRef = useRef(strategy);
  const onTradeRef = useRef(null);
  const onRejectionRef = useRef(null);
  autoSettingsRef.current = autoSettings;
  openTradesRef.current = openTrades;
  livePricesRef.current = livePrices;
  strategyRef.current = strategy;
  oandaNavRef.current = oandaNav;

  // ─── TRADE MANAGEMENT ENGINE — runs every 60s, manages all open positions ────
  useEffect(() => {
    const manage = async () => {
      const trades = openTradesRef.current;
      if (!trades.length) return;
      const prices  = livePricesRef.current;
      const nav     = oandaNavRef.current || 100;
      const oneR    = nav * 0.015;
      const nowMs   = Date.now();
      const nowH_UTC = new Date().getUTCHours();

      for (const trade of trades) {
        const tradeId    = trade.id;
        const instrument = trade.instrument || "";
        const pair       = instrument.replace("_", "/");
        const isLong     = parseInt(trade.currentUnits || 0) > 0;
        const entryPrice = parseFloat(trade.price || 0);
        const currentSLPrice = parseFloat(trade.stopLossOrder?.price || 0);
        const slDistance = currentSLPrice > 0 ? Math.abs(entryPrice - currentSLPrice) : null;
        const unrealizedPL = parseFloat(trade.unrealizedPL || 0);
        const currentR   = oneR > 0 ? unrealizedPL / oneR : 0;
        const currentPrice = prices[pair] || 0;
        const openMs     = trade.openTime ? new Date(trade.openTime).getTime() : nowMs;
        const hoursSinceOpen = (nowMs - openMs) / 3_600_000;
        const pip        = PIP_SIZE[pair] || 0.0001;
        const dec        = pair.includes("JPY") ? 3 : pair.includes("XAU") || pair.includes("SPX") ? 2 : 5;

        if (!tradeMgmtRef.current[tradeId]) {
          tradeMgmtRef.current[tradeId] = { breakevenDone: false, partialDone: false, sessionAlerted: false, trailingActive: false };
        }
        const mgmt = tradeMgmtRef.current[tradeId];

        // 1. BREAKEVEN — when profit >= 1R, move SL to entry + 1 pip
        if (!mgmt.breakevenDone && currentR >= 1 && entryPrice > 0) {
          const newSL = isLong ? entryPrice + pip : entryPrice - pip;
          const isImprovement = currentSLPrice === 0 || (isLong ? newSL > currentSLPrice : newSL < currentSLPrice);
          if (isImprovement) {
            try {
              await fetch(`${BRIDGE}/order/${tradeId}/sl`, {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ price: newSL.toFixed(dec) }),
              });
              mgmt.breakevenDone = true;
              const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
              setMgmtAlerts(prev => [{ id: `${tradeId}-be-${nowMs}`, timestamp: ts, pair, action: "BREAKEVEN", msg: "Moved to breakeven — protecting capital" }, ...prev].slice(0, 20));
              console.log(`[TME] ${pair} breakeven — SL → ${newSL.toFixed(dec)}`);
            } catch (e) { console.error(`[TME] Breakeven failed ${pair}:`, e.message); }
          }
        }

        // 2. PARTIAL PROFIT — when profit >= 2R, close 500 units
        if (!mgmt.partialDone && currentR >= 2 && Math.abs(parseInt(trade.currentUnits || 0)) > 500) {
          try {
            await fetch(`${BRIDGE}/close/${tradeId}/partial`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ units: "500" }),
            });
            mgmt.partialDone = true;
            const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            setMgmtAlerts(prev => [{ id: `${tradeId}-pp-${nowMs}`, timestamp: ts, pair, action: "PARTIAL", msg: "Partial profit taken at 2R" }, ...prev].slice(0, 20));
            console.log(`[TME] ${pair} partial close — 500 units at 2R`);
          } catch (e) { console.error(`[TME] Partial close failed ${pair}:`, e.message); }
        }

        // 3. TRAILING STOP — when profit >= 2R, trail at ATR × 1.0 (slDistance = ATR × 1.5, so trail = slDistance × 2/3)
        if (currentR >= 2 && slDistance != null && slDistance > 0 && currentPrice > 0) {
          const trailDist = slDistance * (2 / 3); // ATR × 1.0
          const trailSL   = isLong ? currentPrice - trailDist : currentPrice + trailDist;
          const isImprovement = currentSLPrice === 0 || (isLong ? trailSL > currentSLPrice : trailSL < currentSLPrice);
          if (isImprovement) {
            try {
              await fetch(`${BRIDGE}/order/${tradeId}/sl`, {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ price: trailSL.toFixed(dec) }),
              });
              mgmt.trailingActive = true;
              console.log(`[TME] ${pair} trail → ${trailSL.toFixed(dec)} (${currentR.toFixed(1)}R locked)`);
            } catch (e) { console.error(`[TME] Trailing stop failed ${pair}:`, e.message); }
          }
        }

        // 4. TIME EXIT — > 4 hours open with no profit
        if (hoursSinceOpen > 4 && unrealizedPL <= 0) {
          try {
            await fetch(`${BRIDGE}/close/${tradeId}`, { method: "POST" });
            setOpenTrades(prev => prev.filter(t => t.id !== tradeId));
            delete tradeMgmtRef.current[tradeId];
            const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            setMgmtAlerts(prev => [{ id: `${tradeId}-te-${nowMs}`, timestamp: ts, pair, action: "TIME EXIT", msg: "Time exit — no momentum after 4 hours" }, ...prev].slice(0, 20));
            console.log(`[TME] ${pair} time exit — ${hoursSinceOpen.toFixed(1)}h with P&L ${unrealizedPL.toFixed(2)}`);
          } catch (e) { console.error(`[TME] Time exit failed ${pair}:`, e.message); }
          continue;
        }

        // 5. SESSION EXIT ALERT — London/Prime trade when Prime window closes (17 UTC = 11am MDT)
        if (!mgmt.sessionAlerted && nowH_UTC >= 17 && trade.openTime) {
          const openH = new Date(trade.openTime).getUTCHours();
          if (openH >= 8 && openH < 17) {
            mgmt.sessionAlerted = true;
            const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            setMgmtAlerts(prev => [{ id: `${tradeId}-sa-${nowMs}`, timestamp: ts, pair, action: "SESSION", msg: "Prime window closing — consider exiting" }, ...prev].slice(0, 20));
            console.log(`[TME] ${pair} session alert — Prime window closed`);
          }
        }
      }

      // Prune mgmtRef for closed trades
      const openIds = new Set(trades.map(t => t.id));
      for (const key of Object.keys(tradeMgmtRef.current)) {
        if (!openIds.has(key)) delete tradeMgmtRef.current[key];
      }
    };

    const id = setInterval(manage, 30_000);
    return () => clearInterval(id);
  }, []);

  // Auto-execution interval — syncs server state AND triggers execution on qualifying signals
  useEffect(() => {
    if (!autoMode) {
      if (window._autoInterval) {
        clearInterval(window._autoInterval);
        window._autoInterval = undefined;
      }
      return;
    }
    const autoExecTimestamps = [];

    const poll = async () => {
      // Read ref immediately at top — before any awaits — to capture true current state
      const refSnapshot = signalDataRef.current;
      // 1. Sync server display state
      try {
        const r = await fetch(`${BRIDGE}/auto-trades`);
        const data = await r.json();
        if (Array.isArray(data.trades)) setAutoTradeLog(data.trades);
      } catch {}

      // 2. Execute qualifying signals
      const settings = autoSettingsRef.current;
      const now = Date.now();
      if (autoExecTimestamps.filter(t => now - t < 3_600_000).length >= settings.maxTradesPerHour) return;

      for (const [pair, data] of Object.entries(refSnapshot)) {
        if (!data) continue;
        const { signal, price, history } = data;
        if ((signal.score ?? 0) < settings.minConfidence) continue;
        if (autoExecTimestamps.filter(t => Date.now() - t < 3_600_000).length >= settings.maxTradesPerHour) break;

        // Gatekeepers
        const gk = runGatekeepers(history, signal, openTradesRef.current, pair, strategyRef.current);
        if (!gk.passed) {
          onRejectionRef.current?.({
            pair, direction: signal.direction, score: signal.score,
            ...gk.rejections[0],
            timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          });
          continue;
        }

        // AI consensus
        try {
          const change = history.length > 1
            ? ((history[history.length - 1] - history[0]) / history[0] * 100).toFixed(3)
            : "0.000";
          // Compute context the prompt builders need — missing fields cause models to REJECT
          const sess = getCurrentSession();
          const ctxBars = history.slice(-21);
          const ctxTr = ctxBars.slice(1).map((v, i) => Math.abs(v - ctxBars[i]));
          const atr = ctxTr.length ? ctxTr.reduce((a, b) => a + b, 0) / ctxTr.length : 0;
          const pip = PIP_SIZE[pair] || 0.0001;
          const atrPips = atr / pip;
          const sl = signal.direction === "LONG" ? price - atr * 1.5 : price + atr * 1.5;
          const tp = signal.direction === "LONG" ? price + atr * 3.0 : price - atr * 3.0;
          const ema9 = history.slice(-9).reduce((a, b) => a + b, 0) / 9;
          const ema21v = history.slice(-21).reduce((a, b) => a + b, 0) / 21;
          const ema50v = history.length >= 50 ? history.slice(-50).reduce((a, b) => a + b, 0) / 50 : ema21v;
          const heat = (openTradesRef.current.length * 1.5).toFixed(1);
          const cr = await fetch(`${BRIDGE}/consensus`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              instrument: pair.replace("/", "_"),
              direction: signal.direction,
              score: signal.score,
              price,
              change,
              rsi: signal.rsi,
              reason: signal.reason?.join(", ") ?? "",
              headline: "",
              session: sess,
              sessionQuality: (sess === "PRIME" || sess === "LONDON") ? "PRIME" : "GOOD",
              strategy: strategyRef.current,
              atr: atr.toFixed(5),
              atrPips: atrPips.toFixed(1),
              sl: sl.toFixed(5),
              tp: tp.toFixed(5),
              rr: "2.0",
              ema9: ema9.toFixed(5),
              ema21: ema21v.toFixed(5),
              ema50side: price > ema50v ? "above" : "below",
              regime: atrPips > 5 ? "VOLATILE" : atr > ema21v * 0.001 ? "TRENDING" : "RANGING",
              heat,
            }),
          });
          const verdict = await cr.json();
          if (!verdict.executeAllowed || (verdict.votes?.confirm ?? 0) < settings.consensusRequired) continue;

          autoExecTimestamps.push(Date.now());
          const topReason = verdict.models?.find(m => m.verdict === "CONFIRM")?.reason ?? "Auto consensus";
          onTradeRef.current?.(pair, signal, price, { REASON: topReason, atr });
        } catch {}
      }
    };

    poll();
    const id = setInterval(poll, 30_000);
    window._autoInterval = id;
    return () => {
      clearInterval(id);
      window._autoInterval = undefined;
    };
  }, [autoMode]);

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
      if (typeof data.autoMode === "boolean") {
        setAutoMode(data.autoMode);
        localStorage.setItem("autoMode", String(data.autoMode));
      }
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
    localStorage.setItem("active_strategy", s);
    setSignalHeaderFlash(true);
    setTimeout(() => setSignalHeaderFlash(false), 1000);
  }, []);

  const [rejectionLog, setRejectionLog] = useState(() => {
    try { return JSON.parse(localStorage.getItem("rejection_log") || "[]"); } catch { return []; }
  });
  const [mgmtAlerts, setMgmtAlerts] = useState([]);
  const [regimeMap, setRegimeMap] = useState({});
  const [toasts, setToasts] = useState([]);
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem("sound_enabled") !== "false");
  const soundEnabledRef    = useRef(soundEnabled);
  soundEnabledRef.current  = soundEnabled;
  const lastSignalSoundRef = useRef({});
  const notifyRef          = useRef(null);
  const [swingEnabled, setSwingEnabled] = useState(() => localStorage.getItem("swing_mode_enabled") === "true");
  const [swingSignals, setSwingSignals] = useState({});
  const [swingTrades,  setSwingTrades]  = useState(() => { try { return JSON.parse(localStorage.getItem("swing_trades") || "[]"); } catch { return []; } });
  const [swingScanning, setSwingScanning] = useState(false);
  const [pendingSwingSetups, setPendingSwingSetups] = useState({}); // { "XAU/USD": sig } — detected, waiting for window
  const swingEnabledRef = useRef(swingEnabled);
  swingEnabledRef.current = swingEnabled;

  const onRejection = useCallback((entry) => {
    setRejectionLog(prev => {
      const next = [entry, ...prev].slice(0, 50);
      localStorage.setItem("rejection_log", JSON.stringify(next));
      return next;
    });
  }, []);
  onRejectionRef.current = onRejection;

  const onRegimeUpdate = useCallback((pair, regime) => {
    setRegimeMap(prev => prev[pair] === regime ? prev : { ...prev, [pair]: regime });
  }, []);

  const addToast = useCallback((type, data) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const toast = { id, ...buildToast(type, data) };
    setToasts(prev => [...prev.slice(-4), toast]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  }, []);

  const notify = useCallback((type, data) => {
    playSound(type, soundEnabledRef.current);
    if (navigator.vibrate) {
      if (type === 'trade_open')  navigator.vibrate([200]);
      if (type === 'take_profit') navigator.vibrate([100, 50, 100]);
      if (type === 'stop_loss')   navigator.vibrate([500]);
    }
    addToast(type, data);
  }, [addToast]);
  notifyRef.current = notify;

  // ── Swing Mode: scan Kill Shot pairs every 4 hours ──
  useEffect(() => {
    if (!swingEnabled) { setSwingSignals({}); return; }
    async function scanSwing() {
      setSwingScanning(true);
      const results = {};
      for (const pair of KILL_SHOT_PAIRS) {
        try {
          const sym = pair.replace("/", "_");
          const [h4Res, wRes] = await Promise.all([
            fetch(`${BRIDGE}/candles/${sym}?count=100&granularity=H4`).then(r => r.ok ? r.json() : null).catch(() => null),
            fetch(`${BRIDGE}/candles/${sym}?count=10&granularity=W`).then(r => r.ok ? r.json() : null).catch(() => null),
          ]);
          const sig = generateSwingSignal(h4Res?.candles || [], wRes?.candles || [], sym);
          if (sig) {
            results[pair] = sig;
            // Guard 1: queue valid setups detected outside the execution window
            if (sig.score >= 75 && !canExecuteSwing(pair) && !isFridayPMBlock()) {
              setPendingSwingSetups(prev => ({ ...prev, [pair]: sig }));
            }
          }
        } catch {}
      }
      setSwingSignals(results);
      setSwingScanning(false);
    }
    scanSwing();
    const id = setInterval(scanSwing, 4 * 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [swingEnabled]); // eslint-disable-line

  // ── Swing Mode: auto-close after 5 days ──
  useEffect(() => {
    if (!swingEnabled) return;
    const id = setInterval(async () => {
      const MAX_MS = 5 * 24 * 60 * 60 * 1000;
      for (const st of swingTrades) {
        if (st.closed) continue;
        if (Date.now() - st.openedAt >= MAX_MS) {
          try {
            await fetch(`${BRIDGE}/close/${st.oandaId}`, { method: "POST" });
            setSwingTrades(prev => {
              const next = prev.map(t => t.id === st.id ? { ...t, closed: true, closeReason: "5-day limit auto-close" } : t);
              localStorage.setItem("swing_trades", JSON.stringify(next));
              return next;
            });
          } catch {}
        }
      }
    }, 60_000);
    return () => clearInterval(id);
  }, [swingEnabled, swingTrades]); // eslint-disable-line

  // ── Swing TP management — poll every 30s, partial-close at each TP level ──
  useEffect(() => {
    if (!swingEnabled) return;
    const manageSwingTPs = async () => {
      const activeSwing = swingTrades.filter(t => !t.closed && t.oandaId);
      if (activeSwing.length === 0) return;
      // Fetch current prices for all active swing instruments
      const syms = [...new Set(activeSwing.map(t => t.pair.replace("/", "_")))].join(",");
      let priceMap = {};
      try {
        const pr = await fetch(`${BRIDGE}/prices?instruments=${syms}`);
        const pd = pr.ok ? await pr.json() : null;
        (pd?.prices || []).forEach(p => {
          const mid = p.bids && p.asks ? ((parseFloat(p.bids[0]?.price) + parseFloat(p.asks[0]?.price)) / 2) : null;
          if (mid) priceMap[p.instrument] = mid;
        });
      } catch { return; }

      for (const t of activeSwing) {
        const sym   = t.pair.replace("/", "_");
        const price = priceMap[sym];
        if (!price) continue;
        const isLong = t.direction === "LONG";

        // TP1 — 30% partial close (150 units)
        if (!t.tp1Hit && (isLong ? price >= t.tp1 : price <= t.tp1)) {
          try {
            await fetch(`${BRIDGE}/close/${t.oandaId}/partial`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ units: "150" }),
            });
            setSwingTrades(prev => {
              const next = prev.map(x => x.id === t.id ? { ...x, tp1Hit: true, remainingUnits: (x.remainingUnits || 500) - 150 } : x);
              localStorage.setItem("swing_trades", JSON.stringify(next));
              return next;
            });
            notifyRef.current?.("take_profit", { pair: t.pair, realizedPL: 1 });
          } catch {}
        }

        // TP2 — 40% partial close (200 units)
        if (t.tp1Hit && !t.tp2Hit && (isLong ? price >= t.tp2 : price <= t.tp2)) {
          try {
            await fetch(`${BRIDGE}/close/${t.oandaId}/partial`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ units: "200" }),
            });
            setSwingTrades(prev => {
              const next = prev.map(x => x.id === t.id ? { ...x, tp2Hit: true, remainingUnits: (x.remainingUnits || 350) - 200 } : x);
              localStorage.setItem("swing_trades", JSON.stringify(next));
              return next;
            });
            notifyRef.current?.("take_profit", { pair: t.pair, realizedPL: 2 });
          } catch {}
        }

        // TP3 — trail remaining 30% (150 units) with SL at price ∓ ATR×0.5
        if (t.tp1Hit && t.tp2Hit && !t.trailActive && (isLong ? price >= t.tp3 : price <= t.tp3)) {
          const slDist = Math.abs(t.entry - t.sl);
          const trailSL = isLong ? price - slDist * 0.5 : price + slDist * 0.5;
          try {
            await fetch(`${BRIDGE}/order/${t.oandaId}/sl`, {
              method: "PATCH", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ price: trailSL.toFixed(5) }),
            });
            setSwingTrades(prev => {
              const next = prev.map(x => x.id === t.id ? { ...x, trailActive: true } : x);
              localStorage.setItem("swing_trades", JSON.stringify(next));
              return next;
            });
          } catch {}
        }
      }
    };
    manageSwingTPs();
    const id = setInterval(manageSwingTPs, 30_000);
    return () => clearInterval(id);
  }, [swingEnabled, swingTrades]); // eslint-disable-line

  // ── Guard 1: auto-execute pending setups when execution window opens ──────────
  useEffect(() => {
    if (!swingEnabled || Object.keys(pendingSwingSetups).length === 0) return;
    const check = async () => {
      if (isFridayPMBlock() || isSwingNewsBlock()) return;
      for (const [pair] of Object.entries(pendingSwingSetups)) {
        const currentSig = swingSignals[pair];
        if (!currentSig || currentSig.score < 75) { // setup no longer valid
          setPendingSwingSetups(prev => { const n = { ...prev }; delete n[pair]; return n; });
          continue;
        }
        if (!canExecuteSwing(pair)) continue; // window not open yet
        const sym   = pair.replace("/", "_");
        const units = currentSig.direction === "LONG" ? 500 : -500;
        const current = openTradesRef.current;
        const oppositeOpen = current.some(t => (t.instrument?.replace("_", "/") || "") === pair && t.direction !== currentSig.direction);
        if (oppositeOpen || current.length >= 4 || current.length * 1.5 >= 4) {
          setPendingSwingSetups(prev => { const n = { ...prev }; delete n[pair]; return n; });
          continue;
        }
        // Consensus gate — same as manual path: score >= 75 → 3/4 CONFIRM → execute
        try {
          let freshMid = parseFloat(currentSig.entry) || 0;
          try {
            const pr = await fetch(`${BRIDGE}/prices?instruments=${sym}`).then(r => r.json());
            const px = pr.prices?.[0];
            if (px) freshMid = (parseFloat(px.bids[0].price) + parseFloat(px.asks[0].price)) / 2;
          } catch {}
          const xavier = xavierIntelRef.current;
          const xavierAge = xavier?.timestamp ? Date.now() - xavier.timestamp : Infinity;
          const xavierAgeMin = xavierAge === Infinity ? 999 : Math.round(xavierAge / 60000);
          const isXavierStale = xavierAge > 15 * 60 * 1000;
          const newsAgeMin = newsLastFetchedAt ? Math.round((Date.now() - newsLastFetchedAt) / 60000) : 999;
          const freshNewsStr = newsAgeMin > 30 ? null : liveHeadlines?.slice(0, 5).join(" | ") || null;
          const toF = v => (typeof v === "number" ? v : parseFloat(v) || 0).toFixed(5);
          const cr = await fetch(`${BRIDGE}/swing-consensus`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              instrument: sym, direction: currentSig.direction, score: currentSig.score,
              price: freshMid.toFixed(5),
              entry: toF(currentSig.entry), sl: toF(currentSig.sl),
              tp1: toF(currentSig.tp1), tp2: toF(currentSig.tp2), tp3: toF(currentSig.tp3),
              ema21: toF(currentSig.ema21), ema50: toF(currentSig.ema50),
              rsi: currentSig.rsi?.toFixed?.(1) || "50", atr: toF(currentSig.atr),
              session: getCurrentSession(), freshNews: freshNewsStr,
              xavierSentiment: isXavierStale ? null : xavier?.sentiment || null,
              xavierKeyRisk:   isXavierStale ? null : xavier?.keyRisk   || null,
              xavierBestPair:  isXavierStale ? null : xavier?.bestPair  || null,
              xavierBrief:     isXavierStale ? null : xavier?.brief     || null,
              newsAgeMin, xavierIntelAgeMin: xavierAgeMin,
            }),
          });
          const cd = await cr.json();
          if (!cd.executeAllowed) continue; // retry next poll
        } catch { continue; } // consensus unreachable — don't fire
        try {
          const orderPayload = { instrument: sym, units, slPrice: currentSig.sl, tp1Price: currentSig.tp1 };
          console.log('[SWING ORDER PAYLOAD]', JSON.stringify(orderPayload, null, 2));
          const r = await fetch(`${BRIDGE}/swing/order`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(orderPayload),
          });
          const data = await r.json();
          const fp = data?.orderFillTransaction?.price;
          if (fp) {
            setSwingTrades(prev => {
              const newTrade = {
                id: `swing_${Date.now()}`, oandaId: data.orderFillTransaction.tradeOpened?.tradeID,
                pair, direction: currentSig.direction, entry: parseFloat(fp),
                sl: currentSig.sl, tp1: currentSig.tp1, tp2: currentSig.tp2, tp3: currentSig.tp3,
                score: currentSig.score, ema21: currentSig.ema21, ema50: currentSig.ema50, rsi: currentSig.rsi,
                openedAt: Date.now(),
                thesis: `Auto-executed at window open · Score ${currentSig.score}% · ${currentSig.score >= 85 ? "Perfect Kill Shot" : "Kill Shot setup"}`,
                closed: false, tp1Hit: false, tp2Hit: false, trailActive: false, remainingUnits: 500,
              };
              const next = [...prev, newTrade];
              localStorage.setItem("swing_trades", JSON.stringify(next));
              return next;
            });
            notifyRef.current?.("trade_open", { pair, direction: currentSig.direction, fillPrice: fp, score: currentSig.score, atr: currentSig.atr });
          }
        } catch {}
        setPendingSwingSetups(prev => { const n = { ...prev }; delete n[pair]; return n; });
      }
    };
    check();
    const id = setInterval(check, 2 * 60 * 1000); // poll every 2 min
    return () => clearInterval(id);
  }, [swingEnabled, pendingSwingSetups, swingSignals]); // eslint-disable-line

  const executeKillShot = useCallback(async (pair, sig) => {
    // ── Conflict prevention ──────────────────────────────────────────────────
    const current = openTradesRef.current;
    const sym = pair.replace("/", "_");
    const oppositeOpen = current.some(t => {
      const tInstr = t.instrument?.replace("_", "/") || "";
      return tInstr === pair && t.direction !== sig.direction;
    });
    if (oppositeOpen) { alert(`⚔️ Blocked: Opposing M5 trade already open on ${pair}. Close it first.`); return; }
    if (current.length >= 4) { alert(`⚔️ Blocked: Max 4 open trades reached (currently ${current.length}). Close a position first.`); return; }
    const heat = current.length * 1.5;
    if (heat >= 4) { alert(`⚔️ Blocked: Combined heat at ${heat.toFixed(1)}R — circuit breaker at 4R. Close a position first.`); return; }
    // ────────────────────────────────────────────────────────────────────────
    if (!window.confirm(`⚔️ Execute Kill Shot: ${pair} ${sig.direction} @ ${swingFmt(pair, sig.entry)}?\nScore: ${sig.score}% · SL: ${swingFmt(pair, sig.sl)} · TP1: ${swingFmt(pair, sig.tp1)}`)) return;
    const units = sig.direction === "LONG" ? 500 : -500;
    try {
      const orderPayload = { instrument: sym, units, slPrice: sig.sl, tp1Price: sig.tp1 };
      console.log('[SWING ORDER PAYLOAD]', JSON.stringify(orderPayload, null, 2));
      const r = await fetch(`${BRIDGE}/swing/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(orderPayload),
      });
      const data = await r.json();
      const fp = data?.orderFillTransaction?.price;
      if (fp) {
        const entry = parseFloat(fp);
        const newTrade = {
          id: `swing_${Date.now()}`,
          oandaId: data.orderFillTransaction.tradeOpened?.tradeID,
          pair, direction: sig.direction, entry,
          sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3,
          score: sig.score, ema21: sig.ema21, ema50: sig.ema50, rsi: sig.rsi,
          openedAt: Date.now(),
          thesis: `Score ${sig.score}% | EMA21 pullback | RSI ${sig.rsi?.toFixed(0) ?? "—"} | ${sig.score >= 85 ? "Perfect Kill Shot" : "Kill Shot setup"}`,
          closed: false, tp1Hit: false, tp2Hit: false, trailActive: false, remainingUnits: 500,
        };
        setSwingTrades(prev => {
          const next = [...prev, newTrade];
          localStorage.setItem("swing_trades", JSON.stringify(next));
          return next;
        });
        notifyRef.current?.("trade_open", { pair, direction: sig.direction, fillPrice: fp, score: sig.score, atr: sig.atr });
      } else {
        alert("Order rejected: " + (data?.errorMessage || JSON.stringify(data).slice(0, 100)));
      }
    } catch (e) { alert("Execute failed: " + e.message); }
  }, []); // eslint-disable-line

  const regimeValues = Object.values(regimeMap);
  const globalRegime = regimeValues.length === 0 ? null
    : regimeValues.filter(r => r === "VOLATILE").length > 0 ? "VOLATILE"
    : regimeValues.filter(r => r === "TRENDING").length > regimeValues.length / 2 ? "TRENDING"
    : "RANGING";


  // ── Xavier Strategy — one strategy per session, no overrides ──
  const session = getCurrentSession();
  const xavierStrategy = useXavierStrategy(session);
  const xavierOpt = useAutonomousBacktest();
  useEffect(() => {
    if (xavierStrategy && xavierStrategy !== strategy) {
      handleStrategyChange(xavierStrategy);
    }
  }, [session]); // eslint-disable-line

  const onSignalUpdate = useCallback((pair, data) => {
    if (data?.signal) {
      signalDataRef.current[pair] = { ...data, timestamp: Date.now() };
      // Sound + toast for signals ≥ 65%, throttled 5 min per pair
      if (data.signal.score >= 65) {
        const lastSnd = lastSignalSoundRef.current[pair] || 0;
        if (Date.now() - lastSnd > 300_000) {
          lastSignalSoundRef.current[pair] = Date.now();
          notifyRef.current?.('signal', { pair, score: data.signal.score, direction: data.signal.direction, strategy: strategyRef.current, session: getCurrentSession() });
        }
      }
    } else {
      const existing = signalDataRef.current[pair];
      if (existing && Date.now() - existing.timestamp > 35_000) {
        delete signalDataRef.current[pair];
      }
    }
    setSignalMap(prev => {
      const hasSig = !!data;
      return prev[pair] === hasSig ? prev : { ...prev, [pair]: hasSig };
    });
  }, []);

  const onTrade = useCallback(async (pair, signal, price, aiVerdict) => {
    const instrument = pair.replace("/", "_");
    const units = signal.direction === "LONG" ? 1000 : -1000;
    const atr = aiVerdict?.atr ?? 0;

    let fillPrice = price;
    try {
      const r = await fetch(`${BRIDGE}/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument, units, atr, price }),
      });
      const data = await r.json();
      if (!r.ok || !data?.orderFillTransaction) {
        console.error("[onTrade] OANDA rejected:", JSON.stringify(data).slice(0, 200));
        return;
      }
      const oandaFill = parseFloat(data.orderFillTransaction.price);
      if (oandaFill) fillPrice = oandaFill;
    } catch (err) {
      console.error("[onTrade] bridge unreachable:", err.message);
      return;
    }

    notifyRef.current?.('trade_open', { pair, direction: signal.direction, fillPrice, score: signal.score, atr: aiVerdict?.atr ?? 0 });

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const rule = KNOWLEDGE_BASE.vanTharpRules[Math.floor(Math.random() * KNOWLEDGE_BASE.vanTharpRules.length)];
    setActiveRule(rule);
    setTimeout(() => setActiveRule(null), 4000);
    const balanceChange = (Math.random() > 0.45 ? 1 : -1) * (1.5 * (0.5 + Math.random() * 2.5)) / 100;
    setBalance(prev => parseFloat((prev + balanceChange).toFixed(4)));
    setLivePrices(prev => ({ ...prev, [pair]: fillPrice }));
    setTrades(prev => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      pair, dir: signal.direction,
      price: fillPrice.toFixed(pair.includes("JPY") ? 3 : pair.includes("XAU") || pair.includes("SPX") ? 2 : 5),
      strategy, time: timeStr, score: signal.score,
      aiReason: aiVerdict?.REASON || null,
      pnl: parseFloat((balanceChange * 100).toFixed(4)),
    }]);
  }, [strategy]);
  onTradeRef.current = onTrade;

  const pnl = (balance - 100).toFixed(4);
  const displayNav = oandaNav != null ? oandaNav : (100 + parseFloat(pnl));
  const displayUPL = oandaUnrealizedPL != null ? oandaUnrealizedPL : parseFloat(pnl);
  const today = new Date().toDateString();
  const paperTodayCount = paperTrades.filter(t => new Date(t.timestamp).toDateString() === today).length;
  const navShort = displayNav >= 10000 ? `$${(displayNav / 1000).toFixed(1)}K` : `$${displayNav.toFixed(0)}`;
  const activeSess = SESSIONS.find(s => isSessionActive(s));
  const activeSessionName = activeSess?.name ?? "—";
  const activeSessionColor = activeSess?.color ?? "#484f58";
  const tabs = [["markets", "Markets"], ["news", "News"], ["ai", "Ask Xavier"], ["knowledge", "Knowledge"], ["risk", "Risk"], ["coach", "Coach"], ["analytics", "Analytics"], ["schedule", "Schedule"], ["backtest", "Backtest"]];

  return (
    <div style={{ fontFamily: "'Inter', sans-serif", padding: `0 0 ${isMobile ? "90px" : "16px"}`, minHeight: "100vh", background: "#0d1117", position: "relative" }}>
      <style>{`.qb-hscroll::-webkit-scrollbar{display:none}.qb-hscroll{-ms-overflow-style:none;scrollbar-width:none}@keyframes marquee{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}`}</style>
      {showOnboarding && (
        <XavierOnboarding onComplete={completeOnboarding} enableAutoMode={enableAutoMode} />
      )}
      {/* ── Header ── */}
      {isMobile ? (
        /* ── Mobile command-center header ── */
        <div style={{ background: "#0d1117", borderBottom: "1px solid #21262d" }}>

          {/* Row 1 — Wordmark · NAV · Auto toggle */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px 5px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 15, fontWeight: 800, color: "#388bfd", letterSpacing: "-0.2px", whiteSpace: "nowrap" }}>QuantBot Pro</span>
              <span style={{ fontSize: 8, background: "#0f2d1a", color: "#3fb950", border: "1px solid #238636", padding: "1px 4px", borderRadius: 3, fontWeight: 600, letterSpacing: "0.3px", flexShrink: 0 }}>GEN AI</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 9, color: "#484f58", letterSpacing: "0.4px", lineHeight: 1, marginBottom: 2 }}>NAV</div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 700, color: displayUPL >= 0 ? "#1D9E75" : "#E24B4A", lineHeight: 1 }}>{navShort}</div>
              </div>
              <button
                onClick={toggleAutoMode}
                disabled={autoModeLoading}
                style={{ padding: "5px 10px", borderRadius: 6, cursor: autoModeLoading ? "default" : "pointer", fontSize: 11, fontWeight: 700, border: `1px solid ${autoMode ? "#238636" : "#30363d"}`, background: autoMode ? "rgba(35,134,54,0.12)" : "#161b22", color: autoMode ? "#3fb950" : "#6e7681", opacity: autoModeLoading ? 0.6 : 1, whiteSpace: "nowrap", fontFamily: "inherit", transition: "all 0.2s" }}
              >
                {autoModeLoading ? "…" : autoMode ? "⚡ M5 ON" : "M5 OFF"}
              </button>
              <button
                onClick={() => { const next = !swingEnabled; setSwingEnabled(next); swingEnabledRef.current = next; localStorage.setItem("swing_mode_enabled", String(next)); }}
                style={{ padding: "5px 9px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700, border: `1px solid ${swingEnabled ? "#F97316" : "#30363d"}`, background: swingEnabled ? "rgba(249,115,22,0.12)" : "#161b22", color: swingEnabled ? "#F97316" : "#6e7681", whiteSpace: "nowrap", fontFamily: "inherit", transition: "all 0.2s" }}
              >
                {swingEnabled ? "⚔️ SWING" : "⚔️"}
              </button>
            </div>
          </div>

          {/* Row 2 — Risk params · Active session · Settings */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 14px 6px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 10, color: autoMode ? "#484f58" : "#30363d", fontFamily: FONT_MONO, whiteSpace: "nowrap" }}>
                {autoMode
                  ? `${autoSettings.minConfidence}% · ${autoSettings.maxTradesPerHour}/hr · ${autoSettings.maxHeat}R`
                  : `${(displayUPL >= 0 ? "+" : "") + displayUPL.toFixed(2)} UPL`}
              </span>
              {paperTodayCount > 0 && (
                <span style={{ fontSize: 9, color: "#30363d", fontFamily: FONT_MONO, whiteSpace: "nowrap" }}>· {paperTodayCount}p</span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
              <span style={{ fontSize: 10, color: "#8b949e", whiteSpace: "nowrap" }}>
                Active: <span style={{ color: activeSessionColor, fontWeight: 600 }}>{activeSessionName}</span>
              </span>
              <button
                onClick={() => setShowAutoSettings(true)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#484f58", padding: "2px", fontSize: 13, lineHeight: 1, display: "flex", alignItems: "center" }}
                title="Settings"
              >⚙</button>
            </div>
          </div>

          {/* Row 3 — Session indicators */}
          <div style={{ display: "flex", alignItems: "center", padding: "5px 14px 7px", borderTop: "1px solid #161b22", gap: 0 }}>
            {SESSIONS.map((s, i) => {
              const active = isSessionActive(s);
              return (
                <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
                  {i > 0 && <span style={{ color: "#21262d", fontSize: 11, padding: "0 5px" }}>·</span>}
                  <span style={{ width: 5, height: 5, borderRadius: "50%", display: "inline-block", background: active ? s.color : "#21262d", boxShadow: active ? `0 0 6px ${s.color}88` : "none", transition: "all 0.4s", flexShrink: 0 }} />
                  <span style={{ fontSize: 10, fontWeight: active ? 600 : 400, color: active ? s.color : "#484f58", transition: "color 0.4s", marginLeft: 3 }}>{s.name}</span>
                </div>
              );
            })}
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
              <button
                onClick={() => {
                  const next = !soundEnabled;
                  setSoundEnabled(next);
                  soundEnabledRef.current = next;
                  localStorage.setItem("sound_enabled", String(next));
                  if (next) playSound('xavier', true);
                }}
                title={soundEnabled ? "Sound ON — click to mute" : "Sound OFF — click to enable"}
                style={{ padding: "8px 11px", borderRadius: 8, cursor: "pointer", fontSize: 14, lineHeight: 1, transition: "all 0.2s", alignSelf: "flex-start",
                  background: soundEnabled ? "rgba(88,166,255,0.08)" : "#161b22",
                  color: soundEnabled ? "#58a6ff" : "#484f58",
                  border: `1px solid ${soundEnabled ? "rgba(88,166,255,0.3)" : "#30363d"}` }}
              >
                {soundEnabled ? "🔊" : "🔇"}
              </button>
              <button
                onClick={() => { const next = !swingEnabled; setSwingEnabled(next); swingEnabledRef.current = next; localStorage.setItem("swing_mode_enabled", String(next)); }}
                style={{ padding: "8px 14px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 600, transition: "all 0.2s", alignSelf: "flex-start",
                  background: swingEnabled ? "rgba(249,115,22,0.12)" : "#161b22",
                  color: swingEnabled ? "#F97316" : "#8b949e",
                  border: `1px solid ${swingEnabled ? "#F97316" : "#30363d"}` }}
                title="Kill Shot — Swing Trading Mode"
              >
                {swingEnabled ? "⚔️ SWING ON" : "⚔️ Swing"}
              </button>
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
                  {autoModeLoading ? "…" : autoMode ? "⚡ M5 ON" : "M5 OFF"}
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

      <NewsTicker onHeadlineChange={setCurrentHeadline} onItemsChange={(items, ts) => { setLiveHeadlines(items); setNewsLastFetchedAt(ts); }} />

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
          const isActive = strategy === s;
          const optimizedForSession = xavierOpt.result?.rules?.[session]?.strategy === s;
          const optPairs = xavierOpt.result?.rules?.[session]?.pairs;
          const optExp   = xavierOpt.result?.rules?.[session]?.expectancy;
          return (
            <div key={s} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
              <button
                onClick={() => handleStrategyChange(s)}
                title={optimizedForSession && optPairs ? `Optimized for ${session}: ${optPairs.join(", ")} · ${optExp >= 0 ? "+" : ""}${optExp}R` : undefined}
                style={{
                  fontSize: isMobile ? 11 : 12,
                  padding: isMobile ? "5px 14px" : "6px 14px",
                  borderRadius: isMobile ? "20px" : "6px",
                  cursor: "pointer",
                  border: isActive ? "1px solid #58a6ff" : optimizedForSession ? "1px solid #1D9E7544" : "1px solid #30363d",
                  background: isActive ? "#132f4c" : "#161b22",
                  color: isActive ? "#58a6ff" : "#8b949e",
                  fontWeight: isActive ? 600 : 400,
                  fontFamily: "inherit",
                  transition: "all 0.15s",
                  zIndex: 20,
                  position: "relative",
                  pointerEvents: "all",
                  whiteSpace: "nowrap",
                }}
              >
                {s}
              </button>
              {isActive && (
                <span style={{ fontSize: 9, color: signalCount > 0 ? "#3fb950" : "#484f58", fontFamily: FONT_MONO, lineHeight: 1 }}>
                  {signalCount} signal{signalCount !== 1 ? "s" : ""}
                </span>
              )}
              {!isActive && optimizedForSession && (
                <span style={{ fontSize: 8, color: "#1D9E75", lineHeight: 1, letterSpacing: "0.02em" }}>Optimized</span>
              )}
            </div>
          );
        })}
      </div>

      {/* ── AUTO strategy bar ── */}
      {(() => {
        const next = getNextSessionInfo();
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 16px", background: "#0d1117", borderBottom: "1px solid #161b22", fontSize: 10, flexWrap: "wrap", minHeight: 26 }}>
            <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "rgba(63,185,80,0.08)", border: "1px solid #238636", color: "#3fb950", fontWeight: 700, flexShrink: 0 }}>M5</span>
            <span style={{ color: "#21262d" }}>·</span>
            <span style={{ color: "#8b949e" }}>{session} session — <span style={{ color: "#e6edf3", fontWeight: 600 }}>{xavierStrategy}</span> is primary</span>
            {next && (
              <>
                <span style={{ color: "#21262d" }}>·</span>
                <span style={{ color: "#484f58" }}>Next: <span style={{ color: "#8b949e" }}>{next.strategy}</span> at {next.session} open in <span style={{ color: "#58a6ff", fontFamily: FONT_MONO }}>{next.countdown}</span></span>
              </>
            )}
          </div>
        );
      })()}

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

      <div style={{ display: tab === "markets" ? "block" : "none" }}>
        <div style={isMobile ? {} : { padding: "0 16px" }}>
          {swingEnabled && (
            <SwingPanel signals={swingSignals} scanning={swingScanning} onExecute={executeKillShot} openTrades={openTrades} isMobile={isMobile} isFriPM={isFridayPMBlock()} isNewsBlock={isSwingNewsBlock()} pendingSetups={pendingSwingSetups} session={getCurrentSession()} xavierIntel={xavierIntelRef.current} freshNews={liveHeadlines} livePrices={livePrices} newsLastFetchedAt={newsLastFetchedAt} />
          )}
          {swingEnabled && swingTrades.length > 0 && (
            <SwingJournalPanel swingTrades={swingTrades} openTrades={openTrades} livePrices={livePrices} displayNav={displayNav} isMobile={isMobile} />
          )}
          {isMobile ? (
            <div style={{ marginBottom: 12 }}>
              {PAIRS.map(pair => (
                <PairRow key={pair} pair={pair} basePrice={BASE_PRICES[pair]} strategy={strategy} onTrade={onTrade} currentHeadline={currentHeadline} onSignalUpdate={onSignalUpdate} onRegimeUpdate={onRegimeUpdate} onRejection={onRejection} onClose={closeTrade} openTrades={openTrades} marketOpen={marketOpen} balance={balance} isMobile xavierIntel={xavierIntelRef.current} newsLastFetchedAt={newsLastFetchedAt} />
              ))}
            </div>
          ) : (
            <>
            <MetricsStrip openTrades={openTrades} signalCount={signalCount} globalRegime={globalRegime} reinforcement={reinforcement} />
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
                <PairRow key={pair} pair={pair} basePrice={BASE_PRICES[pair]} strategy={strategy} onTrade={onTrade} currentHeadline={currentHeadline} onSignalUpdate={onSignalUpdate} onRegimeUpdate={onRegimeUpdate} onRejection={onRejection} onClose={closeTrade} openTrades={openTrades} marketOpen={marketOpen} balance={balance} isMobile={false} xavierIntel={xavierIntelRef.current} newsLastFetchedAt={newsLastFetchedAt} />
              ))}
            </div>
            </>
          )}
          <div>
            <OpenPositionsPanel openTrades={openTrades} livePrices={livePrices} onClose={closeTrade} isMobile={isMobile} mgmtRef={tradeMgmtRef} nav={displayNav} />
            <ClosedTradesPanel trades={closedTrades} isMobile={isMobile} />
            <PaperTradesPanel trades={paperTrades} isMobile={isMobile} />
            <TradeLog trades={trades} isMobile={isMobile} />
            <RejectionLogPanel log={rejectionLog} isMobile={isMobile} />
            <TradeManagementLog alerts={mgmtAlerts} onDismiss={id => setMgmtAlerts(prev => prev.filter(a => a.id !== id))} isMobile={isMobile} />
          </div>
        </div>
      </div>

      <div style={{ display: tab === "news" ? "block" : "none" }}>
        <NewsTab isVisible={tab === "news"} isMobile={isMobile} />
      </div>

      <div style={{ display: tab === "ai" ? "block" : "none" }}>
        <AIAnalystTab isVisible={tab === "ai"} headlines={liveHeadlines} newsLastFetchedAt={newsLastFetchedAt} prices={livePrices} trades={trades} balance={balance} currentHeadline={currentHeadline} isMobile={isMobile} session={getCurrentSession()} strategy={strategy} openTrades={openTrades} signalMap={signalMap} onIntelUpdate={(intel) => { xavierIntelRef.current = intel; }} swingSignals={swingSignals} swingTrades={swingTrades} swingEnabled={swingEnabled} principleWisdom={principleWeights.wisdomMessage} onPrincipleWisdomSeen={principleWeights.clearWisdom} />
      </div>

      <div style={{ display: tab === "knowledge" ? "block" : "none", padding: "0 16px", paddingBottom: 16 }}>
        <KnowledgePanel isVisible={tab === "knowledge"} activeRule={activeRule} session={getCurrentSession()} openTrades={openTrades} balance={balance} prices={livePrices} headlines={liveHeadlines} isMobile={isMobile} />
      </div>

      <div style={{ display: tab === "risk" ? "block" : "none" }}>
        <RiskTab isVisible={tab === "risk"} trades={trades} openTrades={openTrades} balance={balance} session={getCurrentSession()} />
      </div>

      <div style={{ display: tab === "coach" ? "block" : "none" }}>
        <AICoachTab isVisible={tab === "coach"} trades={trades} closedTrades={closedTrades} isMobile={isMobile} session={getCurrentSession()} strategy={strategy} openTrades={openTrades} />
      </div>

      <div style={{ display: tab === "analytics" ? "block" : "none" }}>
        <PerformanceDashboard isVisible={tab === "analytics"} trades={trades} closedTrades={closedTrades} balance={balance} isMobile={isMobile} />
      </div>

      <div style={{ display: tab === "schedule" ? "block" : "none" }}>
        <ScheduleTab isVisible={tab === "schedule"} isMobile={isMobile} autoMode={autoMode} enableAutoMode={enableAutoMode} xavierOpt={xavierOpt} />
      </div>

      <div style={{ display: tab === "backtest" ? "block" : "none" }}>
        <BacktestTab isVisible={tab === "backtest"} closedTrades={closedTrades} trades={trades} isMobile={isMobile} />
      </div>

      {/* ── Auto Mode Settings Modal ── */}
      {showAutoSettings && (
        <AutoModeSettingsModal
          settings={autoSettings}
          onSave={(s) => { setAutoSettings(s); setShowAutoSettings(false); enableAutoMode(true); }}
          onCancel={() => setShowAutoSettings(false)}
          onResetOnboarding={() => { localStorage.removeItem("xavier_onboarded"); setShowOnboarding(true); setShowAutoSettings(false); }}
        />
      )}

      {/* ── Toast notifications ── */}
      <ToastContainer toasts={toasts} onDismiss={id => setToasts(prev => prev.filter(t => t.id !== id))} />

      {/* ── Mobile bottom nav ── */}
      {isMobile && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 100, background: "#161b22", borderTop: "1px solid #21262d", display: "grid", gridTemplateColumns: "repeat(8, 1fr)", padding: "10px 0 env(safe-area-inset-bottom, 16px)" }}>
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
