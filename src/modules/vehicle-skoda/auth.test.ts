import { test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import type { DatabaseSync } from 'node:sqlite'
import { extractCsrf, createAuthClient } from './auth.js'
import { openDb } from '../../core/db.js'

const log = pino({ level: 'silent' })

// ── extractCsrf: the one fragile part of the login flow (VW drifts this HTML). The fixture below
// is the real window._IDK block captured from identity.vwgroup.io — a faithful regression guard.

const REAL_LOGIN_PAGE = `
<!DOCTYPE html><html><head>
<script src="https://identity-cdn.vwgroup.io/assets/x/javascripts/base/jquery.min.js"></script>
<script>
    window._IDK = {
        templateModel: {"clientLegalEntityModel":{"clientId":"7f045eee-7003-4379-9968-9355ed2adb06@apps_vw-dilab_com","legalEntityInfo":{"name":"Škoda","legalProperties":{"revokeDataContact":"infoline@skoda-auto.cz","countryOfJurisdiction":"CZ"}}},"template":"loginIdentifier","hmac":"0d67ad6ae795235980c1ef52a37f6837b2d4bcef18d5c11ec38b99a8158c4899","relayState":"aff30a607023048cc089d151d54de276735a21e8","error":null},
        disabledFeatures: {
            isRTLEnabled: false,
        },
        currentLocale: 'en',
        csrf_parameterName: '_csrf',
        csrf_token: 'qv-k2uYJFn90bwf509MaqZWX8oQhE9eQS17ED7OHRqouYFutmMmS7NQ9IBpZXj_Ltv4unfav3-URde-9e2nyPYLhJ8saUm6V',
        baseUrl: 'https://identity.vwgroup.io',
        footerDocuments: []
    }
</script></head><body></body></html>`

test('extractCsrf parses csrf/hmac/relayState from the real VW login page', () => {
  const { csrf, hmac, relayState } = extractCsrf(REAL_LOGIN_PAGE, 'email page')
  expect(csrf).toBe(
    'qv-k2uYJFn90bwf509MaqZWX8oQhE9eQS17ED7OHRqouYFutmMmS7NQ9IBpZXj_Ltv4unfav3-URde-9e2nyPYLhJ8saUm6V',
  )
  expect(hmac).toBe('0d67ad6ae795235980c1ef52a37f6837b2d4bcef18d5c11ec38b99a8158c4899')
  expect(relayState).toBe('aff30a607023048cc089d151d54de276735a21e8')
})

test('extractCsrf is string-aware: a brace inside a value does not terminate the object', () => {
  const html = `<script>window._IDK = {
    csrf_token: 'tok}with}braces',
    templateModel: { hmac: 'h1', relayState: 'r1' }
  }</script>`
  const { csrf, hmac, relayState } = extractCsrf(html, 'test')
  expect(csrf).toBe('tok}with}braces')
  expect(hmac).toBe('h1')
  expect(relayState).toBe('r1')
})

test('extractCsrf throws a legible error when window._IDK is absent (VW changed the page)', () => {
  expect(() => extractCsrf('<html>no idk here</html>', 'email page')).toThrow(
    /window\._IDK not found/,
  )
})

test('extractCsrf throws when the _IDK object is never terminated', () => {
  expect(() => extractCsrf(`<script>window._IDK = { csrf_token: 'x'`, 'test')).toThrow(
    /not terminated/,
  )
})

test('extractCsrf throws when csrf/hmac/relayState are missing', () => {
  expect(() => extractCsrf(`<script>window._IDK = { csrf_token: 'x' }</script>`, 'test')).toThrow(
    /missing csrf\/hmac\/relayState/,
  )
})

// ── Lockout: after 3 consecutive login failures within an hour, auth refuses to try again (so a
// bad password / drifted HTML can never hammer the account into a server-side lockout).

const origFetch = globalThis.fetch
const tmpDirs: string[] = []
afterEach(() => {
  globalThis.fetch = origFetch
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'osc-auth-test-'))
  tmpDirs.push(dir)
  return openDb(dir)
}

test('locks out after 3 consecutive failures and refuses further attempts', async () => {
  // Every login navigation returns an empty body → extractCsrf fails → login fails. No refresh
  // token is stored, so token() goes straight to the login flow each time.
  globalThis.fetch = (async () =>
    new Response('', { status: 200 })) as unknown as typeof globalThis.fetch
  const db = freshDb()
  const auth = createAuthClient(
    { name: 'enyaq', username: 'u', password: 'p', vin: 'X'.repeat(17) },
    { db, log },
  )

  for (let i = 0; i < 3; i++) {
    await expect(auth.token()).rejects.toThrow(/window\._IDK not found/)
  }
  expect(auth.deadAuth()).toBe(true)
  // The 4th call short-circuits with the lockout error — it does NOT attempt another login.
  await expect(auth.token()).rejects.toThrow(/locked out/)
})

test('healthy auth (before any failure) is not dead', () => {
  const db = freshDb()
  const auth = createAuthClient(
    { name: 'enyaq', username: 'u', password: 'p', vin: 'X'.repeat(17) },
    { db, log },
  )
  expect(auth.deadAuth()).toBe(false)
})
