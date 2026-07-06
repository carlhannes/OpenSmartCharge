# ui2 → backend handoff: Logs viewer API

**For the agent working on the backend.** ui2 now ships a **Logs viewer** (Settings → Logs) built against
the contract below. It's live in the mock (`scripts/mock-backend.mjs` `GET /api/logs`), so ui2 works in
demo/dev today; against the real backend it shows a graceful "Logs unavailable" until this ships. No ui2
changes needed once you implement it — it flips to real automatically (same as the config/label handoffs).

Today the backend logs via **pino to stdout only** — no persistence, no `logs` table, no `/api/logs`
(`src/core/logger.ts` is a bare pino instance; `src/server/api.ts` has no logs route). This asks for a
small **capture → queryable store → GET** slice, mirroring the existing **transactions** pattern
(`src/core/db.ts` transactions table + `src/server/api.ts` `GET /api/transactions`).

---

## 1. `logs` ring-buffer table (auto-rotated)

```sql
CREATE TABLE IF NOT EXISTS logs (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  time   TEXT NOT NULL,          -- ISO 8601
  level  TEXT NOT NULL,          -- 'debug' | 'info' | 'warn' | 'error'
  module TEXT,                   -- best-effort component name (nullable)
  msg    TEXT NOT NULL,
  fields TEXT,                   -- JSON of remaining structured context (nullable)
  err    TEXT                    -- stack / error string when present (nullable)
);
```

**Auto-rotate** ("auto rotate on the backend"): prune by **age** (e.g. keep 7 days) **and** a hard **row
cap** (e.g. 20 000), whichever hits first — on an interval or every N inserts. (Mirror `pruneHouseholdLoad`
in `src/core/smart-charging/rollup.ts` for the pruning idiom.)

## 2. Capture

Add a pino destination/hook (a `pino.multistream` leg, or a custom write stream passed to `pino(...)` in
`src/core/logger.ts`) that inserts each record:
- **level:** map pino numeric → bucket: `trace|debug → debug`, `info → info`, `warn → warn`,
  `error|fatal → error`.
- **msg:** pino `msg`. **err:** pino's std `err` serializer (stack) → the `err` column.
- **module:** best-effort — pino has no consistent component field today (it's conveyed ad-hoc as
  `charger`/`vehicle`/`loadpoint`/`tariff`/`balancer` keys). Pull one of those if present, else leave null.
  A `log.child({ module })` convention later would make this first-class (nice-to-have, not required).
- **fields:** the remaining structured keys as JSON.

Keep it cheap + non-blocking (the DB is `node:sqlite` synchronous — a prepared insert per record is fine,
like `insertMeterValues`). Don't let logging failures crash the app.

## 3. `GET /api/logs`

Newest-first, mirrors `GET /api/transactions`:

| Query | Meaning | Default |
|---|---|---|
| `level` | **minimum** severity (`debug`\|`info`\|`warn`\|`error`) | all |
| `since` | ISO — only entries at/after | — |
| `until` | ISO — only entries at/before | — |
| `q` | case-insensitive substring on `msg` (+ `module`) | — |
| `limit` | max rows | 200, **cap 500** |

Returns `LogEntry[]` (newest-first):

```ts
interface LogEntry {
  id: number;
  time: string;   // ISO
  level: "debug" | "info" | "warn" | "error";
  module?: string;
  msg: string;
  fields?: Record<string, unknown>;
  err?: string;   // stack when present
}
```
`fields`/`err` should be omitted (or null) when empty. `level` filters as **>= min** (rank
debug<info<warn<error). ui2 sends `level=warn` by default.

## 4. (Fast-follow, not required for v1) live tail

A `log` SSE event on the existing bus (`src/core/events.ts` wildcard → `/events`) — e.g.
`events.emit('log', entry)` — would let ui2 add `subscribe("log", …)` for a live-tail toggle. Not needed
for v1 (ui2 auto-refreshes via REST); noted so it's cheap to add later without ui2 rework.

## 5. Notes
- Persist like transactions (survives restart). No config involvement — logs are pure runtime.
- The mock's shapes (`scripts/mock-backend.mjs`) are the reference implementation to match.
