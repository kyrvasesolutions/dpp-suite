const KEY = "dpp-trace.anthropic-key";

/** The user's own Anthropic key: remembered in localStorage, or only for this tab in sessionStorage. */
export function loadApiKey(): { key: string; remember: boolean } {
  try {
    const remembered = localStorage.getItem(KEY);
    if (remembered) return { key: remembered, remember: true };
    return { key: sessionStorage.getItem(KEY) ?? "", remember: false };
  } catch {
    return { key: "", remember: false };
  }
}

export function saveApiKey(key: string, remember: boolean) {
  try {
    localStorage.removeItem(KEY);
    sessionStorage.removeItem(KEY);
    if (key) (remember ? localStorage : sessionStorage).setItem(KEY, key);
  } catch {
    // Storage blocked: the key lives in memory until the page closes.
  }
}
