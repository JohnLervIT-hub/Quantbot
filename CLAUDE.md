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

## CRITICAL FRONTEND RULES

### React Import — NEVER REMOVE
trading_robot.jsx MUST always have React as default import on line 1:

```js
import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
```

REASON: TabErrorBoundary extends React.Component — needs React in scope.
Removing default import = blank screen on ALL devices.
This caused 2+ hours of downtime on 2026-06-01.

### Before Any Frontend Push
1. Check line 1 of trading_robot.jsx has `React` as default import
2. Run `npm run build` locally — must show 0 errors
3. Test in browser before pushing
4. Never push multiple unrelated changes in one commit

### Staging Workflow (develop → main)
All changes go to develop branch first:
```
git checkout develop
# make changes, npm run build, test locally
git add <files> && git commit -m "description"
git push origin develop          # triggers Vercel preview URL
```
Test on the Vercel preview URL. Only merge to main when confirmed working:
```
git checkout main
git merge develop
git push origin main             # triggers Vercel production deploy
```

### Vercel Deploy Rules
- Never redeploy old builds
- develop branch → Vercel preview (configure in Vercel → Settings → Git → Preview Branches)
- main branch → Vercel production
- One logical change per commit
- Test locally first: `npm run build`
- Test on preview URL before merging to main

### Pre-push Build Guard
`npm run prepush` runs `npm run build` before every `git push` (enforced via `.git/hooks/pre-push`).
Fails loudly if the build is broken — prevents broken code reaching Vercel.
