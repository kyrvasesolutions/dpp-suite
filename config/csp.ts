import allow from "./egress-allowlist.json" with { type: "json" };

/**
 * Content security policy of the built app (criterion C0-07). `connect-src` is the app's own origin plus
 * the egress allow-list, so the browser itself refuses any other request. sql.js compiles WebAssembly,
 * which needs 'wasm-unsafe-eval'. React and React Aria set inline style attributes, hence
 * 'unsafe-inline' for styles only; scripts stay 'self'. Navigation to legal sources is not restricted.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `connect-src ${["'self'", ...allow.connect].join(" ")}`,
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");
