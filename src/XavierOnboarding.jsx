import { useState, useEffect, useRef, useCallback } from "react";

// ── Static particle positions (deterministic — no Math.random on render)
const PARTICLES = [
  { x: 8,  y: 15, s: 1.5, d: 14, delay: 0   },
  { x: 23, y: 42, s: 1.0, d: 19, delay: 2.1 },
  { x: 67, y: 8,  s: 2.0, d: 11, delay: 4.3 },
  { x: 89, y: 31, s: 1.0, d: 15, delay: 1.0 },
  { x: 45, y: 72, s: 1.5, d: 17, delay: 3.2 },
  { x: 12, y: 88, s: 1.0, d: 21, delay: 5.5 },
  { x: 78, y: 65, s: 2.0, d: 12, delay: 7.0 },
  { x: 34, y: 25, s: 1.0, d: 16, delay: 2.4 },
  { x: 56, y: 91, s: 1.5, d: 13, delay: 6.1 },
  { x: 91, y: 78, s: 1.0, d: 18, delay: 0.5 },
  { x: 3,  y: 55, s: 2.0, d: 10, delay: 8.2 },
  { x: 72, y: 48, s: 1.0, d: 22, delay: 3.7 },
  { x: 19, y: 63, s: 1.5, d: 13, delay: 1.3 },
  { x: 84, y: 12, s: 1.0, d: 17, delay: 4.8 },
  { x: 48, y: 38, s: 2.0, d: 14, delay: 7.5 },
  { x: 62, y: 81, s: 1.0, d: 11, delay: 2.0 },
  { x: 37, y: 5,  s: 1.5, d: 20, delay: 5.0 },
  { x: 94, y: 52, s: 1.0, d: 14, delay: 9.1 },
  { x: 28, y: 96, s: 2.0, d: 12, delay: 3.3 },
  { x: 71, y: 28, s: 1.0, d: 16, delay: 6.4 },
];

const CSS = `
  @keyframes xav-float {
    0%,100% { transform: translateY(0); }
    50%      { transform: translateY(-10px); }
  }
  @keyframes xav-enter {
    from { transform: translateX(-140px); opacity: 0; }
    to   { transform: translateX(0);      opacity: 1; }
  }
  @keyframes xav-eye-glow {
    0%,100% { filter: drop-shadow(0 0 3px #00FFFF88); }
    50%     { filter: drop-shadow(0 0 10px #00FFFF) drop-shadow(0 0 20px #00FFFF44); }
  }
  @keyframes xav-eye-speak {
    0%,100% { filter: drop-shadow(0 0 6px #00FFFF); }
    40%     { filter: drop-shadow(0 0 14px #00FFFF) drop-shadow(0 0 28px #00FFFF66); }
  }
  @keyframes xav-circuit {
    0%   { opacity: 0.2; stroke-dashoffset: 60; }
    50%  { opacity: 0.9; }
    100% { opacity: 0.2; stroke-dashoffset: 0; }
  }
  @keyframes xav-jaw {
    0%,100% { transform: scaleY(1);   }
    30%     { transform: scaleY(0.35); }
    70%     { transform: scaleY(0.7);  }
  }
  @keyframes xav-particle {
    0%   { transform: translate(0,0);         opacity: 0.12; }
    25%  { transform: translate(14px,-24px);   opacity: 0.55; }
    55%  { transform: translate(-9px,-8px);    opacity: 0.28; }
    80%  { transform: translate(18px,14px);    opacity: 0.48; }
    100% { transform: translate(0,0);         opacity: 0.12; }
  }
  @keyframes xav-fade-up {
    from { opacity: 0; transform: translateY(10px); }
    to   { opacity: 1; transform: translateY(0);    }
  }
  @keyframes xav-blink {
    0%,100% { opacity: 1;   }
    50%     { opacity: 0.1; }
  }
  @keyframes xav-pulse {
    0%,100% { opacity: 1;   }
    50%     { opacity: 0.5; }
  }
  @keyframes xav-model-pop {
    from { opacity: 0; transform: scale(0.6); }
    to   { opacity: 1; transform: scale(1);   }
  }
  @keyframes xav-slide-in {
    from { opacity: 0; transform: translateX(-14px); }
    to   { opacity: 1; transform: translateX(0);     }
  }
  @keyframes xav-heat {
    0%   { width: 0%;    }
    60%  { width: 100%;  }
    75%  { width: 100%;  }
    88%  { width: 0%;    }
    100% { width: 0%;    }
  }
  @keyframes xav-cb-flash {
    0%,100%  { opacity: 0; }
    65%,90%  { opacity: 1; }
  }
  @keyframes xav-session-grow {
    from { transform: scaleX(0); opacity: 0; }
    to   { transform: scaleX(1); opacity: 1; }
  }
  @keyframes xav-countdown {
    0%,100% { opacity: 1;   }
    50%     { opacity: 0.55; }
  }
`;

// ── Steps definition
const STEPS = [
  {
    idx:   0,
    label: "Welcome",
    pose:  "welcome",
    text:  "Hey — good to have you here. I'm Xavier.\n\nI watch the markets so you don't have to. I find the setups, run them through my analysis, and execute when everything lines up.\n\nLet me walk you through how this works.",
    cta:   "Let's go →",
  },
  {
    idx:   1,
    label: "The Brain",
    pose:  "explain",
    text:  "Here's how I make decisions.\n\nEvery signal gets reviewed by four AI models — Claude, GPT-4o, DeepSeek, and Gemini. Three of them need to agree before I do anything. One outlier gets ignored.\n\nIt's a sanity check built into every trade.",
    cta:   "Makes sense →",
  },
  {
    idx:   2,
    label: "Risk First",
    pose:  "stop",
    text:  "Before we talk about profits, let's talk about risk.\n\nI keep every trade at 1.5% of your account. That's it — no exceptions. And if total heat across open trades hits 6R, I stop trading entirely until things settle.\n\nProtecting the account comes first. Always.",
    cta:   "Got it →",
  },
  {
    idx:   3,
    label: "Sessions",
    pose:  "gesture",
    text:  "I don't trade around the clock — I trade when conditions are right.\n\nTokyo and London have their own rhythms. The Prime window — when London and New York overlap — is where I get my best results. Outside of that, I stay patient.\n\nGood timing is half the edge.",
    cta:   "Got it →",
  },
  {
    idx:   4,
    label: "Auto Mode",
    pose:  "tap",
    text:  "When you switch Auto on, I take it from there.\n\nI spot the signal, run it through the gatekeepers, get the AI vote, and execute if it passes. Stop loss goes in immediately. I manage the trade from open to close.\n\nYou just need to keep the app running.",
    cta:   "Turn it on →",
  },
  {
    idx:   5,
    label: "Dashboard",
    pose:  "aside",
    text:  "Here's what you've got.\n\nMarkets shows you live signals as they form. Risk keeps you on top of your exposure. Analytics is your full performance record. And if you want to talk through anything, Ask Xavier is always there.\n\nOne thing — leave the circuit breaker alone.",
    cta:   "Got it →",
  },
  {
    idx:   6,
    label: "Ready",
    pose:  "ready",
    text:  null, // injected dynamically with countdown
    cta:   "Let's trade →",
  },
];

// ── Xavier SVG character
function XavierCharacter({ pose, isSpeaking }) {
  // shoulder pivot points: left (24, 90), right (96, 90)
  const arms = {
    welcome: { L: "rotate(-5,24,90)",  R: "rotate(5,96,90)"   },
    explain: { L: "rotate(-5,24,90)",  R: "rotate(-55,96,90)" },
    stop:    { L: "rotate(-5,24,90)",  R: "rotate(-85,96,90)" },
    gesture: { L: "rotate(-5,24,90)",  R: "rotate(35,96,90)"  },
    tap:     { L: "rotate(-5,24,90)",  R: "rotate(25,96,90)"  },
    aside:   { L: "rotate(30,24,90)",  R: "rotate(-40,96,90)" },
    ready:   { L: "rotate(-20,24,90)", R: "rotate(20,96,90)"  },
  };
  const { L, R } = arms[pose] || arms.welcome;
  const eyeAnim = isSpeaking
    ? "xav-eye-speak 0.45s ease-in-out infinite"
    : "xav-eye-glow 2.5s ease-in-out infinite";

  return (
    <svg viewBox="0 0 120 215" style={{ width: "100%", height: "100%", overflow: "visible" }}>
      <defs>
        <radialGradient id="xavEye" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="#00FFFF" stopOpacity="1" />
          <stop offset="100%" stopColor="#00FFFF" stopOpacity="0.2" />
        </radialGradient>
        <linearGradient id="xavBody" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#1a1a2e" />
          <stop offset="100%" stopColor="#0c0c1c" />
        </linearGradient>
      </defs>

      {/* ── Legs */}
      <rect x="38" y="156" width="16" height="50" rx="6" fill="url(#xavBody)" stroke="#00FFFF" strokeWidth="0.3" strokeOpacity="0.2" />
      <rect x="66" y="156" width="16" height="50" rx="6" fill="url(#xavBody)" stroke="#00FFFF" strokeWidth="0.3" strokeOpacity="0.2" />
      <circle cx="46" cy="176" r="5" fill="#0e0e20" stroke="#00FFFF" strokeWidth="0.5" strokeOpacity="0.3" />
      <circle cx="74" cy="176" r="5" fill="#0e0e20" stroke="#00FFFF" strokeWidth="0.5" strokeOpacity="0.3" />

      {/* ── Left arm */}
      <g transform={L} style={{ transition: "transform 0.6s cubic-bezier(0.22,1,0.36,1)" }}>
        <rect x="16" y="90" width="16" height="54" rx="7" fill="url(#xavBody)" stroke="#00FFFF" strokeWidth="0.3" strokeOpacity="0.25" />
        <circle cx="24" cy="144" r="6" fill="#0e0e20" stroke="#00FFFF" strokeWidth="0.5" strokeOpacity="0.4" />
      </g>

      {/* ── Right arm */}
      <g transform={R} style={{ transition: "transform 0.6s cubic-bezier(0.22,1,0.36,1)" }}>
        <rect x="88" y="90" width="16" height="54" rx="7" fill="url(#xavBody)" stroke="#00FFFF" strokeWidth="0.3" strokeOpacity="0.25" />
        <circle cx="96" cy="144" r="6" fill="#0e0e20" stroke="#00FFFF" strokeWidth="0.5" strokeOpacity="0.4" />
      </g>

      {/* ── Torso */}
      <rect x="30" y="82" width="60" height="75" rx="11" fill="url(#xavBody)" stroke="#00FFFF" strokeWidth="0.5" strokeOpacity="0.25" />

      {/* Circuit patterns */}
      <g style={{ animation: "xav-circuit 3.5s ease-in-out infinite", strokeDasharray: "4 2" }}>
        <line x1="42" y1="102" x2="58" y2="102" stroke="#00FFFF" strokeWidth="0.8" />
        <line x1="58" y1="102" x2="58" y2="114" stroke="#00FFFF" strokeWidth="0.8" />
        <line x1="58" y1="114" x2="78" y2="114" stroke="#00FFFF" strokeWidth="0.8" />
        <line x1="44" y1="132" x2="76" y2="132" stroke="#00FFFF" strokeWidth="0.8" />
        <line x1="66" y1="120" x2="66" y2="132" stroke="#00FFFF" strokeWidth="0.8" />
        <circle cx="42" cy="102" r="2" fill="#00FFFF" />
        <circle cx="78" cy="114" r="2" fill="#00FFFF" />
        <circle cx="66" cy="132" r="2" fill="#00FFFF" />
      </g>

      {/* Chest panel */}
      <rect x="47" y="90" width="26" height="22" rx="4" fill="#080818" stroke="#00FFFF" strokeWidth="0.4" strokeOpacity="0.35" />
      <rect x="51" y="94" width="18" height="3"  rx="1.5" fill="#00FFFF" opacity="0.55" />
      <rect x="53" y="99" width="14" height="2"  rx="1"   fill="#00FFFF" opacity="0.3"  />
      <rect x="55" y="104" width="10" height="2" rx="1"   fill="#00FFFF" opacity={isSpeaking ? 0.7 : 0.15} style={{ transition: "opacity 0.2s" }} />

      {/* Shoulder joints */}
      <circle cx="32" cy="90" r="6" fill="#0e0e20" stroke="#00FFFF" strokeWidth="0.6" strokeOpacity="0.35" />
      <circle cx="88" cy="90" r="6" fill="#0e0e20" stroke="#00FFFF" strokeWidth="0.6" strokeOpacity="0.35" />

      {/* ── Neck */}
      <rect x="52" y="72" width="16" height="12" rx="4" fill="url(#xavBody)" />

      {/* ── Head */}
      <rect x="28" y="26" width="64" height="50" rx="14" fill="url(#xavBody)" stroke="#00FFFF" strokeWidth="0.5" strokeOpacity="0.25" />

      {/* Head circuit accents */}
      <line x1="33" y1="40" x2="42" y2="40" stroke="#00FFFF" strokeWidth="0.5" strokeOpacity="0.3" />
      <line x1="78" y1="40" x2="87" y2="40" stroke="#00FFFF" strokeWidth="0.5" strokeOpacity="0.3" />
      <line x1="33" y1="60" x2="39" y2="60" stroke="#00FFFF" strokeWidth="0.5" strokeOpacity="0.3" />
      <line x1="81" y1="60" x2="87" y2="60" stroke="#00FFFF" strokeWidth="0.5" strokeOpacity="0.3" />

      {/* Forehead indicator */}
      <rect x="50" y="29" width="20" height="4" rx="2" fill="#00FFFF" opacity="0.1" />
      <rect x="53" y="30" width="14" height="2" rx="1" fill="#00FFFF" opacity={isSpeaking ? 0.85 : 0.35} style={{ transition: "opacity 0.25s" }} />

      {/* ── Eyes */}
      <ellipse cx="48" cy="50" rx="7.5" ry="7.5" fill="url(#xavEye)" style={{ animation: eyeAnim }} />
      <ellipse cx="72" cy="50" rx="7.5" ry="7.5" fill="url(#xavEye)" style={{ animation: eyeAnim }} />
      {/* Pupil / highlight */}
      <circle cx="50" cy="48" r="2.5" fill="white" opacity="0.35" />
      <circle cx="74" cy="48" r="2.5" fill="white" opacity="0.35" />

      {/* ── Mouth / jaw */}
      <g style={{ transformOrigin: "60px 68px", animation: isSpeaking ? "xav-jaw 0.42s ease-in-out infinite" : "none" }}>
        <rect x="48" y="64" width="24" height="8" rx="3.5" fill="#080818" stroke="#00FFFF" strokeWidth="0.4" strokeOpacity="0.35" />
        {isSpeaking && (
          <>
            <rect x="51" y="66" width="5" height="4" rx="1" fill="#00FFFF" opacity="0.25" />
            <rect x="58" y="66" width="4" height="4" rx="1" fill="#00FFFF" opacity="0.25" />
            <rect x="64" y="66" width="5" height="4" rx="1" fill="#00FFFF" opacity="0.25" />
          </>
        )}
      </g>
    </svg>
  );
}

// ── Per-step visuals
function WelcomeVisual() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <div style={{ position: "relative", width: 90, height: 90 }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "1px solid rgba(0,255,255,0.2)", animation: "xav-pulse 3s ease-in-out infinite" }} />
        <div style={{ position: "absolute", inset: 12, borderRadius: "50%", border: "1px solid rgba(0,255,255,0.4)", animation: "xav-pulse 3s ease-in-out infinite 1s" }} />
        <div style={{ position: "absolute", inset: 26, borderRadius: "50%", background: "rgba(0,255,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 16, height: 16, borderRadius: "50%", background: "#00FFFF", filter: "blur(4px)", opacity: 0.7 }} />
        </div>
      </div>
      <div style={{ fontSize: 10, color: "#00FFFF", fontFamily: "'JetBrains Mono', monospace", opacity: 0.6, letterSpacing: "2px" }}>
        XAVIER · ONLINE · v2.0
      </div>
    </div>
  );
}

function ConsensusVisual() {
  const models = [
    { name: "Claude",   color: "#8B5CF6", vote: true,  delay: "0.2s" },
    { name: "GPT-4o",  color: "#3fb950", vote: true,  delay: "0.6s" },
    { name: "DeepSeek",color: "#58a6ff", vote: true,  delay: "1.0s" },
    { name: "Gemini",  color: "#d29922", vote: false, delay: "1.4s" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 10, color: "#8b949e", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>4-MODEL CONSENSUS VOTE</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
        {models.map(m => (
          <div key={m.name} style={{
            background: "rgba(0,0,0,0.3)",
            border: `1px solid ${m.vote ? m.color + "44" : "#21262d"}`,
            borderRadius: 8,
            padding: "9px 12px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            animation: `xav-model-pop 0.35s ease-out ${m.delay} both`,
          }}>
            <span style={{ fontSize: 11, color: m.vote ? m.color : "#484f58", fontWeight: 600 }}>{m.name}</span>
            <span style={{ fontSize: 15, color: m.vote ? m.color : "#f85149" }}>{m.vote ? "✓" : "✗"}</span>
          </div>
        ))}
      </div>
      <div style={{ textAlign: "center", padding: "8px 12px", background: "rgba(63,185,80,0.08)", border: "1px solid rgba(63,185,80,0.25)", borderRadius: 7 }}>
        <span style={{ fontSize: 12, color: "#3fb950", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>3/4 CONSENSUS → EXECUTE</span>
      </div>
    </div>
  );
}

function RiskVisual() {
  const segs = [
    { label: "1R", color: "#3fb950" },
    { label: "2R", color: "#3fb950" },
    { label: "3R", color: "#d29922" },
    { label: "4R", color: "#d29922" },
    { label: "5R", color: "#f85149" },
    { label: "6R", color: "#f85149" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 10, color: "#8b949e", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>PORTFOLIO HEAT GAUGE</div>
      <div style={{ display: "flex", gap: 5 }}>
        {segs.map((s, i) => (
          <div key={s.label} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
            <div style={{
              height: 30,
              width: "100%",
              background: s.color,
              borderRadius: 3,
              boxShadow: `0 0 6px ${s.color}55`,
              opacity: 0,
              animation: `xav-model-pop 0.3s ease-out ${i * 0.28}s both`,
            }} />
            <span style={{ fontSize: 9, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.label}</span>
          </div>
        ))}
      </div>
      <div style={{
        textAlign: "center",
        padding: "10px",
        background: "rgba(248,81,73,0.12)",
        border: "1px solid rgba(248,81,73,0.4)",
        borderRadius: 7,
        animation: "xav-cb-flash 4s ease-in-out infinite",
      }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#f85149", fontFamily: "'JetBrains Mono', monospace" }}>⚡ CIRCUIT BREAKER TRIGGERED</span>
        <div style={{ fontSize: 10, color: "#8b949e", marginTop: 3 }}>All trading suspended at 6R heat</div>
      </div>
    </div>
  );
}

function SessionsVisual() {
  const sessions = [
    { name: "SYDNEY", color: "#1D9E75", flex: 2 },
    { name: "TOKYO",  color: "#8B5CF6", flex: 2 },
    { name: "LONDON", color: "#58a6ff", flex: 2.5 },
    { name: "PRIME",  color: "#3fb950", flex: 2 },
    { name: "NY",     color: "#d29922", flex: 2.5 },
    { name: "DEAD",   color: "#484f58", flex: 1 },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 10, color: "#8b949e", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>24-HOUR SESSIONS (CALGARY TIME)</div>
      <div style={{ display: "flex", height: 30, borderRadius: 7, overflow: "hidden", border: "1px solid #21262d" }}>
        {sessions.map((s, i) => (
          <div key={s.name} style={{
            flex: s.flex,
            background: s.name === "DEAD" ? "#21262d33" : s.color + "22",
            borderRight: i < sessions.length - 1 ? "1px solid #21262d" : "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            animation: `xav-session-grow 0.4s ease-out ${i * 0.12}s both`,
            transformOrigin: "left",
          }}>
            {s.name !== "DEAD" && (
              <span style={{ fontSize: 8, color: s.color, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap" }}>{s.name}</span>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {sessions.filter(s => s.name !== "DEAD").map(s => (
          <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: s.color, flexShrink: 0 }} />
            <span style={{ fontSize: 10, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AutoModeVisual() {
  const pipeline = ["Signal", "Gate", "4 AI", "Execute", "Manage"];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 10, color: "#8b949e", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>AUTONOMOUS PIPELINE</div>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 5 }}>
        {pipeline.map((s, i) => (
          <div key={s} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{
              padding: "6px 10px",
              background: "rgba(0,255,255,0.07)",
              border: "1px solid rgba(0,255,255,0.22)",
              borderRadius: 6,
              animation: `xav-slide-in 0.4s ease-out ${i * 0.22}s both`,
            }}>
              <span style={{ fontSize: 11, color: "#00FFFF", fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>{s}</span>
            </div>
            {i < pipeline.length - 1 && (
              <span style={{ color: "#00FFFF", opacity: 0.4, fontSize: 13, animation: `xav-slide-in 0.4s ease-out ${i * 0.22 + 0.18}s both` }}>→</span>
            )}
          </div>
        ))}
      </div>
      <div style={{ padding: "8px 12px", background: "rgba(63,185,80,0.07)", border: "1px solid rgba(63,185,80,0.18)", borderRadius: 6 }}>
        <span style={{ fontSize: 11, color: "#3fb950", fontFamily: "'JetBrains Mono', monospace" }}>⚡ Fully autonomous — no input needed</span>
      </div>
    </div>
  );
}

function TabsVisual() {
  const tabs = ["Markets", "Risk", "Analytics", "Ask Xavier"];
  const descs = ["Where signals appear", "Your protection dashboard", "Your performance record", "Talk to me anytime"];
  const [active, setActive] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setActive(a => (a + 1) % tabs.length), 1600);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <div style={{ fontSize: 10, color: "#8b949e", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>YOUR COMMAND CENTER</div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {tabs.map((t, i) => (
          <div key={t} style={{
            padding: "5px 10px",
            borderRadius: 6,
            border: `1px solid ${i === active ? "rgba(0,255,255,0.35)" : "#21262d"}`,
            background: i === active ? "rgba(0,255,255,0.09)" : "transparent",
            transition: "all 0.3s",
            cursor: "default",
          }}>
            <span style={{ fontSize: 11, color: i === active ? "#00FFFF" : "#484f58", fontWeight: i === active ? 600 : 400, transition: "color 0.3s" }}>{t}</span>
          </div>
        ))}
      </div>
      <div style={{ padding: "9px 12px", background: "rgba(0,0,0,0.25)", border: "1px solid #21262d", borderRadius: 7, minHeight: 34, display: "flex", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "#e6edf3", transition: "opacity 0.3s" }}>{descs[active]}</span>
      </div>
    </div>
  );
}

function ReadyVisual({ countdown }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
      <div style={{ fontSize: 10, color: "#8b949e", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>LONDON OPEN COUNTDOWN</div>
      <div style={{
        padding: "16px 32px",
        background: "rgba(88,166,255,0.07)",
        border: "1px solid rgba(88,166,255,0.28)",
        borderRadius: 10,
        textAlign: "center",
        animation: "xav-countdown 2s ease-in-out infinite",
      }}>
        <div style={{ fontSize: 10, color: "#58a6ff", marginBottom: 5, fontFamily: "'JetBrains Mono', monospace" }}>LONDON OPENS IN</div>
        <div style={{ fontSize: 30, fontWeight: 700, color: "#58a6ff", fontFamily: "'JetBrains Mono', monospace", letterSpacing: 2 }}>{countdown || "—"}</div>
        <div style={{ fontSize: 10, color: "#484f58", marginTop: 5 }}>08:00 UTC · EUR/USD · GBP/USD · XAU/USD</div>
      </div>
      <div style={{ display: "flex", gap: 7 }}>
        {["EUR/USD", "GBP/USD", "XAU/USD"].map(p => (
          <div key={p} style={{ padding: "4px 8px", background: "rgba(88,166,255,0.05)", border: "1px solid rgba(88,166,255,0.15)", borderRadius: 4 }}>
            <span style={{ fontSize: 10, color: "#58a6ff", fontFamily: "'JetBrains Mono', monospace" }}>{p}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StepVisual({ idx, countdown }) {
  switch (idx) {
    case 0: return <WelcomeVisual />;
    case 1: return <ConsensusVisual />;
    case 2: return <RiskVisual />;
    case 3: return <SessionsVisual />;
    case 4: return <AutoModeVisual />;
    case 5: return <TabsVisual />;
    case 6: return <ReadyVisual countdown={countdown} />;
    default: return null;
  }
}

// ── Compute ms until next London open (08:00 UTC)
function msUntilLondon() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(8, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

function formatCountdown(ms) {
  if (ms < 60000) return "NOW";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── Main component
export default function XavierOnboarding({ onComplete, enableAutoMode }) {
  const [step, setStep] = useState(0);
  const [text, setText] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [countdown, setCountdown] = useState(() => formatCountdown(msUntilLondon()));
  const [entered, setEntered] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const typerRef = useRef(null);
  const touchX = useRef(null);

  // Mobile breakpoint
  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);

  // Entrance delay
  useEffect(() => {
    const t = setTimeout(() => setEntered(true), 60);
    return () => clearTimeout(t);
  }, []);

  // London countdown — always live
  useEffect(() => {
    const tick = () => setCountdown(formatCountdown(msUntilLondon()));
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, []);

  // Full text for step (step 6 embeds countdown)
  const stepText = useCallback((idx, cd) => {
    if (idx === 6) {
      return `You're set up.\n\nLondon opens in ${cd} — that's our first real window. I'll be watching from the start.\n\nI won't get every trade right. No system does. But I stay disciplined, I protect the downside, and I get better over time.\n\nLet's get to work.`;
    }
    return STEPS[idx].text;
  }, []);

  // Typewriter effect
  useEffect(() => {
    clearInterval(typerRef.current);
    const full = stepText(step, countdown);
    setText("");
    setIsTyping(true);
    let i = 0;
    typerRef.current = setInterval(() => {
      i++;
      if (i <= full.length) {
        setText(full.slice(0, i));
      } else {
        setIsTyping(false);
        clearInterval(typerRef.current);
      }
    }, 15);
    return () => clearInterval(typerRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const advance = useCallback(() => {
    if (step === 4) enableAutoMode?.(true);
    if (step >= STEPS.length - 1) { onComplete(); return; }
    setStep(s => s + 1);
  }, [step, enableAutoMode, onComplete]);

  const skip = useCallback(() => onComplete(), [onComplete]);

  // Touch swipe
  const onTouchStart = (e) => { touchX.current = e.touches[0].clientX; };
  const onTouchEnd = (e) => {
    if (touchX.current === null) return;
    if (e.changedTouches[0].clientX - touchX.current < -50) advance();
    touchX.current = null;
  };

  const cur = STEPS[step];

  const speechBubble = (
    <div style={{
      background: "rgba(0,255,255,0.03)",
      border: "1px solid rgba(0,255,255,0.1)",
      borderRadius: 12,
      padding: isMobile ? "14px 16px" : "22px 26px",
      whiteSpace: "pre-wrap",
      fontSize: isMobile ? 14 : 15,
      lineHeight: 1.7,
      color: "#e6edf3",
      minHeight: isMobile ? 80 : 110,
      position: "relative",
    }}>
      {!isMobile && (
        <div style={{
          position: "absolute", left: -11, top: 28,
          width: 0, height: 0,
          borderTop: "9px solid transparent",
          borderBottom: "9px solid transparent",
          borderRight: "11px solid rgba(0,255,255,0.1)",
        }} />
      )}
      {text}
      {isTyping && (
        <span style={{ animation: "xav-blink 0.5s ease-in-out infinite", color: "#00FFFF" }}>▊</span>
      )}
    </div>
  );

  const ctaButton = (
    <button onClick={advance} style={{
      padding: isMobile ? "14px" : "11px 28px",
      borderRadius: 9,
      background: "rgba(0,255,255,0.09)",
      border: "1px solid rgba(0,255,255,0.28)",
      color: "#00FFFF",
      fontSize: 14,
      fontWeight: 600,
      cursor: "pointer",
      fontFamily: "inherit",
      letterSpacing: "0.4px",
      width: isMobile ? "100%" : undefined,
      alignSelf: isMobile ? undefined : "flex-start",
      transition: "background 0.2s, border-color 0.2s",
    }}>
      {cur.cta}
    </button>
  );

  const stepLabel = (
    <div style={{ fontSize: 10, color: "#00FFFF", fontFamily: "'JetBrains Mono', monospace", opacity: 0.55, letterSpacing: "1.2px" }}>
      {String(step + 1).padStart(2, "0")} / {STEPS.length} — {cur.label.toUpperCase()}
    </div>
  );

  return (
    <div
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "#050810",
        overflow: "hidden",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <style>{CSS}</style>

      {/* ── Particles */}
      {PARTICLES.map((p, i) => (
        <div key={i} style={{
          position: "absolute",
          left: `${p.x}%`,
          top: `${p.y}%`,
          width: p.s,
          height: p.s,
          borderRadius: "50%",
          background: "#00FFFF",
          pointerEvents: "none",
          animation: `xav-particle ${p.d}s ease-in-out infinite ${p.delay}s`,
        }} />
      ))}

      {/* ── Skip */}
      <button onClick={skip} style={{
        position: "absolute",
        top: 14,
        right: 14,
        background: "none",
        border: "1px solid #21262d",
        borderRadius: 6,
        color: "#484f58",
        fontSize: 12,
        cursor: "pointer",
        padding: "5px 12px",
        zIndex: 20,
        fontFamily: "inherit",
      }}>
        Skip intro →
      </button>

      {/* ── Progress dots */}
      <div style={{
        position: "absolute",
        top: 18,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        gap: 7,
        zIndex: 20,
      }}>
        {STEPS.map((_, i) => (
          <div
            key={i}
            onClick={() => i < step && setStep(i)}
            style={{
              width: i === step ? 22 : 7,
              height: 7,
              borderRadius: 4,
              background: i === step ? "#00FFFF" : i < step ? "rgba(0,255,255,0.35)" : "#21262d",
              transition: "all 0.35s ease",
              cursor: i < step ? "pointer" : "default",
            }}
          />
        ))}
      </div>

      {/* ── Layout */}
      {isMobile ? (
        /* MOBILE — Xavier top, content below */
        <div style={{ display: "flex", flexDirection: "column", height: "100%", paddingTop: 52 }}>
          {/* Xavier */}
          <div style={{
            height: "26vh",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            flexShrink: 0,
            paddingBottom: 8,
            animation: entered ? "xav-enter 0.65s cubic-bezier(0.22,1,0.36,1) both" : "none",
          }}>
            <div style={{ height: "100%", aspectRatio: "120/215", animation: "xav-float 3.2s ease-in-out infinite" }}>
              <XavierCharacter pose={cur.pose} isSpeaking={isTyping} />
            </div>
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 18px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
            {stepLabel}
            {speechBubble}
            <div style={{ animation: "xav-fade-up 0.45s ease-out 0.25s both" }}>
              <StepVisual idx={step} countdown={countdown} />
            </div>
            {ctaButton}
          </div>
        </div>
      ) : (
        /* DESKTOP — Xavier left 40%, content right 60% */
        <div style={{ display: "flex", height: "100%", animation: "xav-fade-up 0.4s ease-out" }}>
          {/* Left panel */}
          <div style={{
            width: "40%",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            padding: "40px 16px 56px",
            position: "relative",
            flexShrink: 0,
          }}>
            {/* Floor glow */}
            <div style={{
              position: "absolute",
              bottom: 36,
              left: "50%",
              transform: "translateX(-50%)",
              width: 220,
              height: 50,
              background: "radial-gradient(ellipse, rgba(0,255,255,0.07) 0%, transparent 70%)",
              pointerEvents: "none",
            }} />
            <div style={{
              width: 220,
              height: 380,
              animation: [
                entered ? "xav-enter 0.7s cubic-bezier(0.22,1,0.36,1) both" : "",
                "xav-float 3.2s ease-in-out infinite",
              ].filter(Boolean).join(", "),
            }}>
              <XavierCharacter pose={cur.pose} isSpeaking={isTyping} />
            </div>
          </div>

          {/* Right panel */}
          <div style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "60px 52px 60px 20px",
            gap: 22,
            maxWidth: 580,
          }}>
            {stepLabel}
            {speechBubble}
            <div style={{ animation: `xav-fade-up 0.45s ease-out ${step === 0 ? "0.8s" : "0.3s"} both` }}>
              <StepVisual idx={step} countdown={countdown} />
            </div>
            {ctaButton}
          </div>
        </div>
      )}
    </div>
  );
}
