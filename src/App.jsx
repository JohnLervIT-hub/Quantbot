import React from 'react'
import TradingRobot from './trading_robot.jsx'

class AppErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) return (
      <div style={{ padding: 24, background: '#0d1117', minHeight: '100vh', fontFamily: "'JetBrains Mono', monospace" }}>
        <div style={{ color: '#f85149', fontSize: 14, fontWeight: 700, marginBottom: 12 }}>
          App crashed — {this.state.error.message}
        </div>
        <pre style={{ color: '#8b949e', fontSize: 10, whiteSpace: 'pre-wrap', background: '#161b22', padding: 16, borderRadius: 8, border: '1px solid #21262d' }}>
          {this.state.error.stack}
        </pre>
        <button
          onClick={() => this.setState({ error: null })}
          style={{ marginTop: 16, background: '#161b22', border: '1px solid #21262d', borderRadius: 6, color: '#8b949e', fontSize: 11, padding: '6px 14px', cursor: 'pointer' }}>
          Retry
        </button>
      </div>
    );
    return this.props.children;
  }
}

export default function App() {
  return (
    <AppErrorBoundary>
      <TradingRobot />
    </AppErrorBoundary>
  );
}
