// Copy text to the clipboard, with a fallback for NON-secure contexts. `navigator.clipboard` only
// exists in a secure context (HTTPS or localhost) — so on a plain-HTTP LAN address like
// http://192.168.3.14:8080 it's undefined and the modern API silently fails. Fall back to the legacy
// execCommand path there. Returns whether the copy succeeded.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // secure API present but blocked (permissions) → try the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
