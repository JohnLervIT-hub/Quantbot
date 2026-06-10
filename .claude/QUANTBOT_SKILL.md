# QuantBot Pro — Implementation Skill

## ALWAYS READ THIS BEFORE ANY CODE CHANGE

### Project Identity
- Autonomous AI trading robot
- React frontend + Node.js OANDA bridge
- Demo account only (api-fxpractice.oanda.com)
- File: src/trading_robot.jsx (~6000 lines)
- Bridge: server.cjs

### PROTECTED CODE — NEVER TOUCH
These functions/sections are battle-tested and must never be modified:
- `generateSignal()` — signal scoring engine
- `runGatekeepers()` — trade gate logic (rulebook thresholds may be updated per user explicit override only)
- `handleAnalyze()` — signal → execution flow
- `useStableSignal()` — signal stability hook
- `isOptimalTradingWindow()` — session logic
- `getCurrentSession()` — session detector
- `usePriceSimulator()` — price engine
- Strategy useState: `localStorage.getItem("active_strategy") || "Mean Revert"`
- Mean Revert scoring block (dev thresholds: 0.001, 0.002, 0.004)
- All useEffect blocks containing trade execution or OANDA API calls

## XAVIER'S STRICT RULEBOOK (active — do not soften or override)

### Rule 1 — Session/Strategy Map
Single source of truth: XAVIER_SESSION_RULES in server.cjs (updated 2026-06-09).
Replaces: XAVIER_RULES, INSTRUMENT_HOME_SESSIONS, KILL_SHOT_SESSION_RULES, INDEX_HOME_SESSION.
```
// M5 pairs (filtered by SERVER_PAIRS) + swing killShot pairs per session
XAVIER_SESSION_RULES = {
  SYDNEY: { strategy: "Momentum",    pairs: ["XAU_USD","AU200_AUD"],                          killShot: []                                },
  TOKYO:  { strategy: "Momentum",    pairs: ["EUR_GBP","USD_JPY","GBP_USD"],                  killShot: ["USD_JPY","GBP_USD"]             },
  LONDON: { strategy: "Momentum",    pairs: ["EUR_GBP","GBP_USD","EUR_USD","AU200_AUD"],       killShot: ["GBP_USD","EUR_USD"]             },
  PRIME:  { strategy: "Breakout",    pairs: ["EUR_GBP","XAU_USD","EUR_USD","NAS100_USD"],      killShot: ["XAU_USD","EUR_USD","EUR_GBP"]   },
  NY:     { strategy: "Mean Revert", pairs: ["AU200_AUD","EUR_USD","XAG_USD","NAS100_USD"],    killShot: ["EUR_USD","XAG_USD"]             },
  AVOID:  { strategy: null,          pairs: [],                                                 killShot: []                                },
}
```

SERVER_PAIRS — M5 auto-execution (180d validated 2026-05-30):
EUR_USD (+0.31R), GBP_USD (+0.45R), USD_JPY (+0.47R), EUR_GBP (+0.73R),
XAU_USD (+0.56R), XAG_USD (+0.78R), NAS100_USD (+0.47R), AU200_AUD

SWING_ONLY pairs (not in SERVER_PAIRS — M15 validated only):
AUD_USD, USD_CAD, NZD_USD — M15 swing/Kill Shot only
BCO_USD, WTICO_USD — Kill Shot manual only
UK100_GBP, JP225_USD — swing only (DD too high for M5)
SPX500_USD — removed (no live edge data)

HIGH_THRESHOLD_PAIRS (75% signal score required):
XAG_USD, NAS100_USD, AU200_AUD, XAU_USD

### Rule 2 — Signal Threshold: 65%
- runGatekeepers() blocks any signal with score < 65

### Rule 3 — Max 2 Open Trades
- runGatekeepers() rejects if openTrades.length >= 2

### Rule 4 — Heat Limit: 4R
- runGatekeepers() rejects if heat (openTrades.length × 1.5) >= 4R

### Rule 6 — No Dead Zone Trading
- AVOID session = hard block at top of runGatekeepers(). No exceptions, no fallback.

## RISK CONSTANTS
- 1.5% risk per trade
- Units: 1000 LONG, -1000 SHORT
- Circuit breaker at 4R heat (was 6R)
- Signal threshold: 65%
- Consensus: 3/4 models required

### SAFE TO MODIFY
- UI layout and styling
- Dashboard header and metrics bar
- Chart panel visual overlays
- Execution panel display (not logic)
- Animation and transitions
- Color themes and typography
- News ticker and session banners
- Rejection log display

### DESIGN SYSTEM
Background:    #0d1117
Surface:       #161b22
Border:        #21262d
Text primary:  #e6edf3
Text secondary:#8b949e
Text muted:    #484f58
Green:         #3fb950
Red:           #f85149
Blue:          #58a6ff
Yellow:        #d29922
Orange:        #F97316
Purple:        #8B5CF6
Teal:          #1D9E75
Font mono:     'JetBrains Mono', monospace
Font ui:       'Inter', sans-serif

### DESIGN PHILOSOPHY
- Bloomberg Terminal aesthetic
- Institutional execution software feel
- Dark premium theme
- Calm spacing, compact data density
- NO flashy crypto casino UI
- NO excessive glow effects
- NO bouncing animations
- Framer Motion: subtle, premium, institutional only

### BEFORE ANY CHANGE
1. Read CLAUDE.md
2. Read this file
3. Identify which section you're modifying
4. Confirm it's in the SAFE TO MODIFY list
5. Make the change
6. Verify no errors in Problems panel
7. Confirm trading logic is untouched

### AFTER ANY CHANGE
- Run: npm run build
- Confirm: 0 errors
- Commit: git add -A && git commit -m "description"

### SESSION PAIRS BY WINDOW
- TOKYO (4-8 UTC): USD/JPY, AUD/USD
- LONDON (8-13 UTC): EUR/USD, GBP/USD, XAU/USD
- PRIME (13-17 UTC): All pairs
- NY (17-20 UTC): EUR/USD, USD/CAD, USD/JPY
- SYDNEY (22-4 UTC): AUD/USD, NZD/USD

### OANDA CONFIG
- Demo URL: https://api-fxpractice.oanda.com
- Pair format: EUR_USD (underscores, not slashes)
- Bridge: http://localhost:3001
- Frontend: http://localhost:5173
