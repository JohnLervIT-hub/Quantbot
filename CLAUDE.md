# QuantBot Pro

## What this project is
Autonomous trading robot. React frontend + Node.js OANDA bridge.
Demo account only. Never use live OANDA URL.

## Files
- src/trading_robot.jsx — main React UI
- server.cjs — Express bridge to OANDA REST v20 (CommonJS; package.json is ESM)
- .env — credentials (never commit)

## OANDA demo URL
https://api-fxpractice.oanda.com

## Pair name format
Always use underscores: EUR_USD not EUR/USD

## Risk rules
- 1.5% risk per trade
- Units: 1000 LONG, -1000 SHORT
- Circuit breaker at 4R heat

## How to run
Terminal 1: npm run server
Terminal 2: npm run dev
Frontend: http://localhost:5173
Bridge: http://localhost:3001 (dev uses Vite proxy `/bridge` automatically)

## AI models (multi-model consensus)
Requires in `.env`: `VITE_ANTHROPIC_KEY`, `VITE_OPENAI_API_KEY`, `VITE_DEEPSEEK_API_KEY`
Check: `curl http://localhost:3001/health`

For **phone testing**, set `VITE_OANDA_BRIDGE=http://YOUR_LAN_IP:3001` and restart `npm run dev`.
For **desktop dev**, leave `VITE_OANDA_BRIDGE` unset so the app uses the `/bridge` proxy.
## Implementation Skill
Before any code change, read .claude/QUANTBOT_SKILL.md — it contains protected code rules, design system, and safe modification zones.
