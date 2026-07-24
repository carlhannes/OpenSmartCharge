type SseListener = (data: unknown) => void
const listeners = new Map<string, Set<SseListener>>()
let es: EventSource | null = null

function dispatch(type: string, rawData: string) {
  try {
    const data = JSON.parse(rawData) as unknown
    for (const cb of listeners.get(type) ?? []) cb(data)
  } catch {
    /* ignore malformed payloads */
  }
}

function wireType(source: EventSource, type: string) {
  source.addEventListener(type, (ev) => dispatch(type, (ev as MessageEvent).data))
}

function connect(backoffMs = 1000) {
  const source = new EventSource('/events')
  es = source
  // Wire all currently subscribed event types onto the new connection
  for (const type of listeners.keys()) wireType(source, type)

  source.onerror = () => {
    source.close()
    // Exponential backoff capped at 30 s
    setTimeout(() => connect(Math.min(backoffMs * 2, 30_000)), backoffMs)
  }
}

connect()

// HMR cleanup: close the connection so Vite hot-reload doesn't leak EventSource handles
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    es?.close()
    es = null
    listeners.clear()
  })
}

export function subscribe(type: string, cb: SseListener): () => void {
  const isNew = !listeners.has(type)
  if (isNew) {
    listeners.set(type, new Set())
    if (es) wireType(es, type)
  }
  listeners.get(type)!.add(cb)
  return () => listeners.get(type)?.delete(cb)
}
