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
- `runGatekeepers()` — trade gate logic
- `handleAnalyze()` — signal → execution flow
- `useStableSignal()` — signal stability hook
- `isOptimalTradingWindow()` — session logic
- `getCurrentSession()` — session detector
- `usePriceSimulator()` — price engine
- Strategy useState: `localStorage.getItem("active_strategy") || "Mean Revert"`
- Mean Revert scoring block (dev thresholds: 0.001, 0.002, 0.004)
- All useEffect blocks containing trade execution or OANDA API calls

## CHANGE
- 1.5% risk per trade
- Units: 1000 LONG, -1000 SHORT
- Circuit breaker at 6R heat
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
