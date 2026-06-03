import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { BRIDGE, FONT_MONO } from '../lib/config';

// ─── BACKTEST CONSTANTS ───────────────────────────────────────────────────────
const BACKTEST_SPREAD_COSTS = {
  EUR_USD: 0.0002, GBP_USD: 0.0003, USD_JPY: 0.02,  USD_CAD: 0.0003,
  NZD_USD: 0.0003, AUD_USD: 0.0003, EUR_GBP: 0.0002, XAU_USD: 0.35,
  NAS100_USD: 1.5, AU200_AUD: 1.0, UK100_GBP: 1.0, SPX500_USD: 0.5,
  BCO_USD: 0.05,  WTICO_USD: 0.05,
};
const MIN_BT_TRADES = 50;
const TRAINING_DAYS_MS = 120 * 86400000;

// ─── BACKTEST TAB ─────────────────────────────────────────────────────────────
export default function BacktestTab({ trades = [], loading = false, lastUpdated = null, isMobile, generateSignal }) {
  const [xavierInsight, setXavierInsight] = useState(null);
  const [loadingInsight, setLoadingInsight] = useState(false);

  const CLEAN_CUTOFF = new Date('2026-06-01T00:00:00Z');
  const data = trades.filter(t => {
    const closeTime = t.close_time || t.closeTime;
    return closeTime && new Date(closeTime) >= CLEAN_CUTOFF;
  });
  const allTrades  = trades;
  const cleanCount = data.length;
  const totalCount = allTrades.length;

  if (totalCount === 0) {
    return (
      <div style={{ padding: "60px 16px", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🧪</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "#e6edf3", marginBottom: 6 }}>No closed trades</div>
        <div style={{ fontSize: 12, color: "#8b949e" }}>Execute and close trades to see performance analytics here.</div>
      </div>
    );
  }
  if (cleanCount === 0) {
    return (
      <div style={{ padding: "60px 16px", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🧪</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "#e6edf3", marginBottom: 6 }}>No clean trades yet</div>
        <div style={{ fontSize: 12, color: "#8b949e" }}>{totalCount} historical trade{totalCount !== 1 ? "s" : ""} exist but are excluded (pre-June 1 calibration data). New trades will appear here.</div>
      </div>
    );
  }

  const getPL = (t) => parseFloat(t.pnl ?? t.realizedPL ?? 0);
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

  const rTrades = data.filter(t => (t.r_multiple ?? t.rMultiple) != null);
  const avgR = rTrades.length > 0 ? rTrades.reduce((s, t) => s + (t.r_multiple ?? t.rMultiple), 0) / rTrades.length : null;
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

  // Strategy stats from closed trades
  const stratStats = {};
  data.forEach(t => {
    const key = (t.strategy && t.strategy !== 'Unknown' && t.strategy !== 'UNKNOWN' && t.strategy !== '—')
      ? t.strategy
      : deriveStrategyFromSession(t.session) || 'Mean Revert';
    if (!stratStats[key]) stratStats[key] = { wins: 0, total: 0, pnl: 0 };
    stratStats[key].total++;
    stratStats[key].pnl += getPL(t);
    if (getPL(t) > 0) stratStats[key].wins++;
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#e6edf3" }}>Backtest Analytics</div>
          <div style={{ fontSize: 11, color: "#484f58", marginTop: 2 }}>Based on {cleanCount} clean trades (filtered from {totalCount} total)</div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: "#8b949e", padding: "4px 0", marginBottom: 8 }}>
        ⓘ Showing post-June 1 trades only. Pre-fix calibration trades excluded.
        {' · '}
        <span style={{ color: loading ? "#484f58" : "#3fb950" }}>
          {loading ? "Loading…" : `Supabase ✅${lastUpdated ? ` · ${Math.round((Date.now() - lastUpdated.getTime()) / 1000)}s ago` : ''}`}
        </span>
      </div>

      {/* Sample size warning */}
      {data.length < MIN_BT_TRADES && (
        <div style={{ background: "rgba(210,153,34,0.07)", border: "1px solid rgba(210,153,34,0.28)", borderRadius: 8, padding: "10px 14px", marginBottom: 16, display: "flex", gap: 8, alignItems: "flex-start" }}>
          <span style={{ color: "#d29922", fontSize: 14, flexShrink: 0 }}>⚠</span>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#d29922" }}>LOW SAMPLE (n={data.length}) — minimum {MIN_BT_TRADES} trades required</div>
            <div style={{ fontSize: 11, color: "#8b949e", marginTop: 2 }}>Statistics require ≥{MIN_BT_TRADES} trades to be statistically reliable. Results may not reflect true system edge.</div>
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

      <HistoricalBacktest isMobile={isMobile} generateSignal={generateSignal} />
    </div>
  );
}

// ─── HISTORICAL BACKTEST ENGINE ───────────────────────────────────────────────
function HistoricalBacktest({ isMobile, generateSignal }) {
  const BT_STRATEGIES = ["Mean Revert", "Trend Follow", "Breakout", "Momentum", "Range Scalp"];
  const STRAT_COLOR   = { "Mean Revert": "#1D9E75", "Trend Follow": "#58a6ff", "Breakout": "#F97316", "Momentum": "#8B5CF6", "Range Scalp": "#d29922" };
  const BT_PAIRS      = [
    "EUR_USD", "GBP_USD", "USD_JPY", "EUR_GBP",
    "AUD_USD", "USD_CAD", "NZD_USD",
    "XAU_USD", "XAG_USD",
    "NAS100_USD", "AU200_AUD", "UK100_GBP", "JP225_USD", "SPX500_USD",
  ];
  const BT_TIMEFRAMES = ["M5", "M15", "H1"];
  const BT_DURATIONS  = ["7 days", "30 days", "90 days", "180 days", "365 days"];
  const BT_SESSIONS   = ["All", "Tokyo", "London", "Prime", "NY", "Sydney"];
  const SESSION_UTC   = { All: null, Tokyo: { start: 0, end: 9 }, London: { start: 7, end: 16 }, Prime: { start: 13, end: 17 }, NY: { start: 17, end: 20 }, Sydney: { start: 22, end: 4 } };

  const [btStrategy,   setBtStrategy]   = useState("All");
  const [btPair,       setBtPair]       = useState("EUR_USD");
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
                const spreadCost = BACKTEST_SPREAD_COSTS[pair.replace(/[/-]/g, "_").toUpperCase()] ?? 0.0003;
                const spreadR    = atr > 0 ? spreadCost / (atr * 1.5) : 0;
                trades.push({ dir: sig.direction, score: sig.score, win: hit === "win", entry: parseFloat(entry.toFixed(dec)), exit: parseFloat((hit === "win" ? tp : sl).toFixed(dec)), rMultiple: (hit === "win" ? 3.0 : -1.0) - spreadR, timestamp: candles[i]?.time ?? "" });
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

    const validityScore = trades.length >= 100 ? "High" : trades.length >= MIN_BT_TRADES ? "Moderate" : "Low";

    // Walk-forward validation — training: first 60d, validation: last 30d
    const firstTs = candles[20]?.time ? new Date(candles[20].time).getTime() : 0;
    const trainingTrades   = trades.filter(t => t.timestamp && (new Date(t.timestamp).getTime() - firstTs) < TRAINING_DAYS_MS);
    const validationTrades = trades.filter(t => !t.timestamp || (new Date(t.timestamp).getTime() - firstTs) >= TRAINING_DAYS_MS);
    const calcExp = (arr) => arr.length > 0 ? arr.reduce((s, t) => s + t.rMultiple, 0) / arr.length : null;
    const trainingExpectancy   = calcExp(trainingTrades);
    const validationExpectancy = calcExp(validationTrades);
    const isRobust = trainingExpectancy !== null && validationExpectancy !== null && trainingExpectancy > 0.20 && validationExpectancy > 0.20;

    // Confidence score
    const confidence = Math.min(100, Math.round((trades.length / MIN_BT_TRADES) * 50 + (winRate > 40 ? 25 : 0) + (maxDD < 8 ? 25 : 0)));

    return { trades, winRate, expectancyR, profitFactor, equityCurve, maxDD, totalR: equityCurve[equityCurve.length - 1], sharpe, maxConsecLosses, validityScore, trainingExpectancy, validationExpectancy, isRobust, confidence };
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
                      {r && r.trades.length < MIN_BT_TRADES && <span style={{ fontSize: 8, background: "rgba(248,81,73,0.1)", color: "#f85149", border: "1px solid rgba(248,81,73,0.3)", borderRadius: 3, padding: "1px 4px" }}>⚠ LOW (n={r.trades.length})</span>}
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
                {detail.trades.length < MIN_BT_TRADES && (
                  <div style={{ padding: "8px 12px", background: "rgba(248,81,73,0.06)", border: "1px solid rgba(248,81,73,0.2)", borderRadius: 6, fontSize: 10, color: "#f85149" }}>
                    ⚠ LOW SAMPLE (n={detail.trades.length}) — minimum {MIN_BT_TRADES} trades required for statistical confidence. Treat results with caution.
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
                {(() => {
                  const confScore = detail.confidence ?? 0;
                  const confLabel = confScore >= 80 ? '🟢 HIGH' : confScore >= 50 ? '🟡 MED' : '🔴 LOW';
                  return (
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 8 }}>
                      {[
                        { label: "Sharpe Ratio",       value: detail.sharpe.toFixed(2),           color: detail.sharpe >= 1 ? "#3fb950" : detail.sharpe >= 0 ? "#d29922" : "#f85149",
                          tip: "Mean R ÷ Std R — measures return per unit of risk" },
                        { label: "Max Consec. Losses", value: `${detail.maxConsecLosses}`,        color: detail.maxConsecLosses <= 3 ? "#3fb950" : detail.maxConsecLosses <= 6 ? "#d29922" : "#f85149",
                          tip: "Longest losing streak in the backtest period" },
                        { label: "Confidence",         value: confLabel,                           color: confScore >= 80 ? "#3fb950" : confScore >= 50 ? "#d29922" : "#f85149",
                          tip: `Score: ${confScore} — 🟢 HIGH(80+) trade full size · 🟡 MED(50-79) half size · 🔴 LOW(<50) do not trade` },
                        { label: "Total R",            value: `${detail.totalR >= 0 ? "+" : ""}${detail.totalR.toFixed(1)}R`, color: pc(detail.totalR),
                          tip: "Cumulative R-multiple over the backtest period" },
                      ].map((c, i) => (
                        <div key={i} style={{ ...CARD, position: "relative" }} title={c.tip}>
                          <div style={{ fontSize: 9, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>{c.label}</div>
                          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: FONT_MONO, color: c.color }}>{c.value}</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* Walk-forward validation */}
                {detail.trainingExpectancy !== null && detail.validationExpectancy !== null && (
                  <div style={CARD}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: "#e6edf3" }}>Walk-Forward Validation</span>
                      <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, fontWeight: 700, background: detail.isRobust ? "rgba(63,185,80,0.1)" : "rgba(248,81,73,0.1)", color: detail.isRobust ? "#3fb950" : "#f85149", border: `1px solid ${detail.isRobust ? "rgba(63,185,80,0.3)" : "rgba(248,81,73,0.3)"}` }}>
                        {detail.isRobust ? "✅ ROBUST — validated on unseen data" : "⚠ OVERFIT — only works on training data"}
                      </span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      {[{ label: "Training (first 60d)", val: detail.trainingExpectancy }, { label: "Validation (last 30d)", val: detail.validationExpectancy }].map(({ label, val }, i) => (
                        <div key={i} style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 6, padding: "10px 12px" }}>
                          <div style={{ fontSize: 9, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>{label}</div>
                          <div style={{ fontSize: 16, fontWeight: 700, fontFamily: FONT_MONO, color: val > 0.20 ? "#3fb950" : val >= 0 ? "#d29922" : "#f85149" }}>{val >= 0 ? "+" : ""}{val.toFixed(2)}R</div>
                          <div style={{ fontSize: 9, color: "#484f58", marginTop: 2 }}>{val > 0.20 ? "✓ meets 0.20R threshold" : "✗ below 0.20R"}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

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
                          <span style={{ fontFamily: FONT_MONO, color: t.rMultiple >= 0 ? "#3fb950" : "#f85149", fontWeight: 700 }}>{t.rMultiple >= 0 ? "+" : ""}{t.rMultiple.toFixed(2)}R</span>
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

