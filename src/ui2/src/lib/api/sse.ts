// SSE client — one shared EventSource('/events') fanned out to many subscribers.
// Ported from src/ui/client/sse.ts, with one difference: the connection is opened
// lazily via ensureConnected() (called only in live mode) so demo/offline mode
// doesn't spam reconnect attempts against an absent backend.

type SseListener = (data: unknown) => void;
const listeners = new Map<string, Set<SseListener>>();
let es: EventSource | null = null;
let started = false;

function dispatch(type: string, rawData: string) {
  try {
    const data = JSON.parse(rawData) as unknown;
    for (const cb of listeners.get(type) ?? []) cb(data);
  } catch {
    /* ignore malformed payloads */
  }
}

function wireType(source: EventSource, type: string) {
  source.addEventListener(type, (ev) => dispatch(type, (ev as MessageEvent).data));
}

function connect(backoffMs = 1000) {
  const source = new EventSource("/events");
  es = source;
  // Re-wire all currently subscribed event types onto the new connection.
  for (const type of listeners.keys()) wireType(source, type);
  source.onerror = () => {
    source.close();
    setTimeout(() => connect(Math.min(backoffMs * 2, 30_000)), backoffMs);
  };
}

/** Open the shared SSE connection (idempotent, client-only). Call once in live mode. */
export function ensureConnected() {
  if (started || typeof window === "undefined") return;
  started = true;
  connect();
}

// HMR cleanup: close the connection so Vite hot-reload doesn't leak EventSource handles.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    es?.close();
    es = null;
    listeners.clear();
    started = false;
  });
}

export function subscribe(type: string, cb: SseListener): () => void {
  const isNew = !listeners.has(type);
  if (isNew) {
    listeners.set(type, new Set());
    if (es) wireType(es, type);
  }
  listeners.get(type)!.add(cb);
  return () => listeners.get(type)?.delete(cb);
}
