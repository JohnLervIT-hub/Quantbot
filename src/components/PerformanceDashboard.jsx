import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { FONT_MONO } from '../lib/config';

export default function PerformanceDashboard({ trades, closedTrades = [], balance, isMobile }) {
  const hasClosed = closedTrades.length > 0;
  const CLEAN_CUTOFF = new Date('2026-06-01T00:00:00Z');
  const cleanTrades = hasClosed
    ? closedTrades.filter(t => {
        const closeTime = t.closeTime || t.close_time;
        const rMultiple = t.rMultiple ?? t.r_multiple;
        return closeTime &&
          new Date(closeTime) >= CLEAN_CUTOFF &&
          rMultiple !== null &&
          rMultiple !== undefined;
      })
    : [];
  const analyticsData = hasClosed ? cleanTrades : trades;
  const [curveFilter, setCurveFilter] = useState("ALL");
  const [xavierNote, setXavierNote] = useState("");
  const [xavierLoading, setXavierLoading] = useState(false);

  if (analyticsData.length === 0) {
    return (
      <div style={{ padding: "60px 16px", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>📊</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "#e6edf3", marginBottom: 6 }}>
          {hasClosed ? "No clean trades yet" : "No trades yet"}
        </div>
        <div style={{ fontSize: 12, color: "#8b949e" }}>
          {hasClosed
            ? `${closedTrades.length} historical trade${closedTrades.length !== 1 ? "s" : ""} exist but are excluded (pre-June 1 calibration data). New trades will appear here.`
            : "Execute trades in the Markets tab to see analytics here."
          }
        </div>
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
    ? cleanTrades.slice().reverse().reduce((acc, t) => {
        acc.push(acc[acc.length - 1] + getPL(t));
        return acc;
      }, [0])
    : trades.reduce((acc, t) => { acc.push(acc[acc.length - 1] + (t.pnl || 0)); return acc; }, [0]);

  const filterMs = { ALL: Infinity, TODAY: 86400000, WEEK: 604800000, MONTH: 2592000000 };
  const nowMs = Date.now();
  const filteredBase = hasClosed
    ? cleanTrades.slice().reverse().filter(t => {
        if (curveFilter === "ALL") return true;
        const ts = t.closeTime ? new Date(t.closeTime).getTime() : 0;
        return nowMs - ts <= filterMs[curveFilter];
      })
    : trades;
  const filteredCurve = filteredBase.reduce((acc, t) => {
    acc.push(acc[acc.length - 1] + (hasClosed ? getPL(t) : (t.pnl || 0)));
    return acc;
  }, [0]);

  const peakVal = Math.max(...filteredCurve);
  const currentVal = filteredCurve[filteredCurve.length - 1];
  const peakIdx = filteredCurve.indexOf(peakVal);
  const afterPeak = filteredCurve.slice(peakIdx);
  const maxDrawdown = filteredCurve.length >= 2 && balance > 0 ? Math.min(100, Math.max(0, (peakVal - Math.min(...afterPeak)) / balance * 100)) : 0;

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
  analyticsData.forEach(t => {
    const key = (t.strategy && t.strategy !== 'Unknown' && t.strategy !== 'UNKNOWN' && t.strategy !== '—')
      ? t.strategy
      : deriveStrategyFromSession(t.session) || 'Mean Revert';
    if (!stratStats[key]) stratStats[key] = { wins: 0, total: 0, pnl: 0 };
    stratStats[key].total++;
    stratStats[key].pnl += getPL(t);
    if (getPL(t) > 0) stratStats[key].wins++;
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
    { label: "Clean Trades",   value: cleanTrades.length,         color: "#e6edf3" },
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
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginBottom: 16 }}>
        {hasClosed ? (
          <>
            <div style={{ fontSize: 10, color: "#8b949e", padding: "6px 12px", background: "#16171d", border: "1px solid #2e303a", borderRadius: 6, marginBottom: 8, textAlign: "center", fontStyle: "italic" }}>
              Pre-June 1 trades excluded from performance metrics — contained system calibration data
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div style={{ padding: "10px 14px", borderRadius: 10, background: "#0f2217", border: "1px solid #238636" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#3fb950" }}>Clean trades (post-fix)</div>
                <div style={{ fontSize: 10, color: "#8b949e", marginTop: 2 }}>{cleanTrades.length} trade{cleanTrades.length !== 1 ? "s" : ""} · accurate performance data</div>
                {cleanTrades.length < 30 && cleanTrades.length > 0 && (
                  <div style={{ fontSize: 10, color: "#d29922", marginTop: 4 }}>{30 - cleanTrades.length} more for stable stats</div>
                )}
              </div>
              <div style={{ padding: "10px 14px", borderRadius: 10, background: "#161b22", border: "1px solid #21262d" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#8b949e" }}>All time (50 trades)</div>
                <div style={{ fontSize: 10, color: "#484f58", marginTop: 2 }}>{closedTrades.length} trade{closedTrades.length !== 1 ? "s" : ""} · historical reference only</div>
              </div>
            </div>
          </>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderRadius: 10, background: analyticsData.length < 30 ? "#2d2a1a" : "#161b22", border: `1px solid ${analyticsData.length < 30 ? "#d29922" : "#21262d"}` }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#e6edf3" }}>Signal Analytics</div>
              <div style={{ fontSize: 10, color: "#8b949e", marginTop: 2 }}>{trades.length} signal records · simulated P&L</div>
            </div>
            {analyticsData.length < 30 && (
              <div style={{ fontSize: 10, color: "#d29922", textAlign: "right" }}>{30 - analyticsData.length} more trades for stable stats</div>
            )}
          </div>
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
          {hasClosed ? `Clean Trade Log (${cleanTrades.length} post-Jun 1)` : "Trade Log"}
        </div>
        {hasClosed ? (
          <div style={{ overflowX: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: "70px 55px 52px 65px 50px 44px 44px", gap: "0 8px", fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.05em", paddingBottom: 6, borderBottom: "0.5px solid #21262d", minWidth: 380 }}>
              {["Pair", "Dir", "Time", "P&L ($)", "Pips", "R", "Dur"].map(h => <div key={h}>{h}</div>)}
            </div>
            <div style={{ maxHeight: 280, overflowY: "auto" }}>
              {cleanTrades.map((t, i) => {
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
