import { useState, useEffect } from 'react';
import { BRIDGE } from '../lib/config';

export default function DiagnosticsTab({ isVisible }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!isVisible) return

    const fetchDiagnostics = async () => {
      try {
        const token = localStorage.getItem('auth_token')
        const res = await fetch(`${BRIDGE}/diagnostics`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const json = await res.json()
        setData(json)
        setError(null)
      } catch(err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    fetchDiagnostics()
    const interval = setInterval(fetchDiagnostics, 30000)
    return () => clearInterval(interval)
  }, [isVisible])

  if (loading) return (
    <div style={{padding:24, color:'#8b949e', textAlign:'center'}}>
      Loading diagnostics...
    </div>
  )

  if (error) return (
    <div style={{padding:24, color:'#f85149', textAlign:'center', fontSize:12}}>
      Error: {error}
    </div>
  )

  if (!data) return (
    <div style={{padding:24, color:'#8b949e', textAlign:'center'}}>
      No data available
    </div>
  )

  const m5 = data?.m5 || data?.last24h || {}
  const swing = data?.swing || {}
  const thresholds = data?.thresholds || {}
  const blocked = m5?.blocked || {}
  const conservatism = data?.conservatismScore || 'UNKNOWN'
  const recommendation = data?.recommendation || ''
  const periodHours = data?.periodHours || 0

  return (
    <div style={{padding:16, fontFamily:"'JetBrains Mono',monospace", fontSize:11}}>

      <div style={{marginBottom:16, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
        <div style={{color:'#8b949e'}}>
          {periodHours.toFixed(1)}h window
        </div>
        <div style={{
          color: conservatism === 'TOO_CONSERVATIVE' ? '#f85149'
            : conservatism === 'BALANCED' ? '#3fb950'
            : '#d29922',
          fontWeight:600}}>
          {conservatism}
        </div>
      </div>

      {recommendation && (
        <div style={{
          padding:'8px 12px',
          background:'#161b22',
          border:'1px solid #30363d',
          borderRadius:6,
          marginBottom:16,
          color:'#8b949e',
          fontSize:10}}>
          {recommendation}
        </div>
      )}

      <div style={{marginBottom:16}}>
        <div style={{
          color:'#8b949e',
          marginBottom:8,
          fontSize:10,
          textTransform:'uppercase',
          letterSpacing:'0.1em'}}>
          M5 Signal Funnel
        </div>
        {[
          ['Signals Scanned',    m5?.signalsScanned    ?? 0],
          ['Passed News Guard',  m5?.passedNewsGuard   ?? 0],
          ['Passed Gatekeeper',  m5?.passedGatekeeper  ?? 0],
          ['Passed Macro Filter',m5?.passedMacroFilter ?? 0],
          ['Reached Consensus',  m5?.reachedConsensus  ?? 0],
          ['A+ Trades',          m5?.aplus             ?? 0],
          ['Standard Trades',    m5?.standard          ?? 0],
          ['Executed',           m5?.executed          ?? 0],
        ].map(([label, value]) => (
          <div key={label} style={{
            display:'flex',
            justifyContent:'space-between',
            padding:'4px 0',
            borderBottom:'0.5px solid #161b22'}}>
            <div style={{color:'#8b949e'}}>{label}</div>
            <div style={{
              color: label === 'Executed' && value > 0 ? '#3fb950' : '#e6edf3',
              fontWeight:600}}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* Blocked Signals */}
      <div style={{marginBottom:16}}>
        <div style={{
          color:'#8b949e',
          marginBottom:8,
          fontSize:10,
          textTransform:'uppercase',
          letterSpacing:'0.1em'}}>
          Blocked Signals
        </div>
        {[
          ['Score Threshold', blocked?.scoreThreshold ?? 0],
          ['News Guard',      blocked?.newsGuard      ?? 0],
          ['Macro Filter',    blocked?.macroFilter    ?? 0],
          ['Options PCR',     blocked?.options        ?? 0],
          ['Historical Edge', blocked?.historical     ?? 0],
          ['Consensus',       blocked?.consensus      ?? 0],
          ['Cooldown',        blocked?.cooldown       ?? 0],
          ['Heat Limit',      blocked?.heatLimit      ?? 0],
        ].map(([label, value]) => (
          <div key={label} style={{
            display:'flex',
            justifyContent:'space-between',
            padding:'4px 0',
            borderBottom:'0.5px solid #161b22'}}>
            <div style={{color:'#8b949e'}}>{label}</div>
            <div style={{
              color: value > 0 ? '#f85149' : '#484f58',
              fontWeight:600}}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* Swing / Kill Shot */}
      <div style={{marginBottom:16}}>
        <div style={{
          color:'#8b949e',
          marginBottom:8,
          fontSize:10,
          textTransform:'uppercase',
          letterSpacing:'0.1em'}}>
          Swing / Kill Shot
        </div>
        {[
          ['Scanned',          swing?.scanned          ?? 0],
          ['Passed Consensus', swing?.passedConsensus  ?? 0],
          ['Queued',           swing?.queued           ?? 0],
          ['Executed',         swing?.executed         ?? 0],
        ].map(([label, value]) => (
          <div key={label} style={{
            display:'flex',
            justifyContent:'space-between',
            padding:'4px 0',
            borderBottom:'0.5px solid #161b22'}}>
            <div style={{color:'#8b949e'}}>{label}</div>
            <div style={{
              color: label === 'Executed' && value > 0 ? '#3fb950' : '#e6edf3',
              fontWeight:600}}>
              {value}
            </div>
          </div>
        ))}

        {swing?.pending?.length > 0 && (
          <div style={{
            marginTop:8,
            padding:8,
            background:'#161b22',
            borderRadius:6}}>
            <div style={{color:'#d29922', fontSize:10, marginBottom:6}}>
              Pending Kill Shots
            </div>
            {swing.pending.map(p => (
              <div key={p.pair} style={{
                display:'flex',
                justifyContent:'space-between',
                padding:'3px 0',
                color:'#8b949e',
                fontSize:10}}>
                <span>{p.pair}</span>
                <span>{p.score}% · {p.consensus}/4</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Active Thresholds */}
      <div style={{marginBottom:16}}>
        <div style={{
          color:'#8b949e',
          marginBottom:8,
          fontSize:10,
          textTransform:'uppercase',
          letterSpacing:'0.1em'}}>
          Active Thresholds
        </div>
        {[
          ['Standard Score',    (thresholds?.standardScore    ?? 65) + '%'],
          ['A+ Score',          (thresholds?.aplusScore       ?? 72) + '%'],
          ['Consensus Standard',(thresholds?.consensusStandard ?? 3) + '/4'],
          ['Consensus A+',      (thresholds?.consensusAplus   ?? 4) + '/4'],
          ['History Min Trades', thresholds?.historyMinTrades ?? 10],
          ['History Win Rate',  (thresholds?.historyWinRate   ?? 55) + '%'],
          ['Signal Age Min',    (thresholds?.signalAgeMin     ?? 5) + ' min'],
        ].map(([label, value]) => (
          <div key={label} style={{
            display:'flex',
            justifyContent:'space-between',
            padding:'4px 0',
            borderBottom:'0.5px solid #161b22'}}>
            <div style={{color:'#8b949e'}}>{label}</div>
            <div style={{color:'#e6edf3', fontWeight:600}}>{value}</div>
          </div>
        ))}
      </div>

    </div>
  )
}
