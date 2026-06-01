export const FONT_MONO = "'JetBrains Mono', monospace";
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";
export const BRIDGE = import.meta.env.VITE_OANDA_BRIDGE || (import.meta.env.DEV ? "/bridge" : API_BASE);
