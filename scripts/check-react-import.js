import { readFileSync } from 'fs'

const content = readFileSync('src/trading_robot.jsx', 'utf8')
const firstLine = content.split('\n')[0]

if (!firstLine.includes('import React')) {
  console.error('❌ CRITICAL: React default import missing from trading_robot.jsx')
  console.error('   Fix: import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from "react"')
  process.exit(1)
}

console.log('✅ React import check passed')
