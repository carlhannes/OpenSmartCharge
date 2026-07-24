import { createHash, randomBytes } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import type { DatabaseSync } from 'node:sqlite'
import type { Logger } from 'pino'
import { saveRefreshToken, loadRefreshToken } from './persistence.js'
import type { SkodaCfg } from './types.js'

// VW Group Identity constants (from evcc params.go and vwidentity/endpoint.go)
const IDENTITY_BASE = 'https://identity.vwgroup.io'
const CODE_EXCHANGE_URL =
  'https://mysmob.api.connect.skoda-auto.cz/api/v1/authentication/exchange-authorization-code?tokenType=CONNECT'
const REFRESH_TOKEN_URL =
  'https://mysmob.api.connect.skoda-auto.cz/api/v1/authentication/refresh-token?tokenType=CONNECT'
const CLIENT_ID = '7f045eee-7003-4379-9968-9355ed2adb06@apps_vw-dilab_com'
const REDIRECT_URI = 'myskoda://redirect/login/'
const SCOPE =
  'address badge birthdate cars driversLicense dealers email mileage mbb nationalIdentifier openid phone profession profile vin'

// VW Group's token exchange response does NOT include an expires_in field;
// the real lifetime is 60 minutes. We use 55 to give us a 5-minute refresh
// buffer for clock skew and slow network paths.
const ACCESS_TOKEN_TTL_MS = 55 * 60_000

interface TokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number // Date.now() + ms
}

export interface AuthClient {
  token(): Promise<string>
  deadAuth(): boolean
  dispose(): Promise<void>
}

// Minimal per-domain cookie jar (sufficient for the sequential VW Identity flow)
class CookieJar {
  private cookies = new Map<string, Map<string, string>>()

  collect(url: string, headers: Headers): void {
    const domain = new URL(url).hostname
    if (!this.cookies.has(domain)) this.cookies.set(domain, new Map())
    const jar = this.cookies.get(domain)!
    // getSetCookie() returns each Set-Cookie header separately (Node 20+)
    const setCookies =
      (headers as Headers & { getSetCookie?(): string[] }).getSetCookie?.() ??
      [headers.get('set-cookie') ?? ''].filter(Boolean)
    for (const raw of setCookies) {
      const [nameValue] = raw.split(';')
      const eqIdx = nameValue.indexOf('=')
      if (eqIdx < 0) continue
      jar.set(nameValue.slice(0, eqIdx).trim(), nameValue.slice(eqIdx + 1).trim())
    }
  }

  header(url: string): string | undefined {
    const domain = new URL(url).hostname
    const jar = this.cookies.get(domain)
    if (!jar?.size) return undefined
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

// Navigate a URL, following HTTPS redirects but stopping at non-HTTP schemes.
// On non-HTTP redirect (e.g. myskoda://) returns { body: '', finalUrl: location }.
// After a redirect, subsequent hops use GET (standard 302 behaviour).
async function navigate(
  initialUrl: string,
  options: { method?: string; body?: string; contentType?: string; jar?: CookieJar } = {},
): Promise<{ body: string; finalUrl: string }> {
  const { jar } = options
  let currentUrl = initialUrl
  let method = options.method ?? 'GET'
  let body: string | undefined = options.body
  let contentType: string | undefined = options.contentType

  for (let hop = 0; hop < 15; hop++) {
    const headers: Record<string, string> = {
      // A browser-like UA — VW Group Identity's WAF serves empty/blocked responses to unknown
      // agents on the signin-service POST endpoints.
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    }
    const cookie = jar?.header(currentUrl)
    if (cookie) headers['Cookie'] = cookie
    if (contentType) headers['Content-Type'] = contentType

    const resp = await fetch(currentUrl, { method, headers, body, redirect: 'manual' })
    jar?.collect(currentUrl, resp.headers)

    const location = resp.headers.get('location')
    if (resp.status >= 300 && resp.status < 400 && location) {
      // Resolve against the current URL so RELATIVE redirects (e.g.
      // "/signin-service/.../login/authenticate") are followed rather than mistaken for a
      // scheme change. Only a genuinely non-HTTP scheme — the myskoda:// deep link carrying the
      // auth code — stops the walk. (The old `!/^https?:/` test wrongly bailed on relative paths,
      // returning an empty body and breaking the login.)
      const resolved = new URL(location, currentUrl)
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
        return { body: '', finalUrl: resolved.toString() }
      }
      currentUrl = resolved.toString()
      // POST→GET on redirect (standard browser behaviour)
      method = 'GET'
      body = undefined
      contentType = undefined
      continue
    }

    return { body: await resp.text(), finalUrl: currentUrl }
  }
  throw new Error('Skoda auth: too many redirects')
}

// Generate PKCE code_verifier and code_challenge (S256, as used by VW Group Identity)
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// Extract the CSRF state (csrf token + hmac + relayState) from a VW Identity login page.
// The values live in a `window._IDK = { … }` assignment inside a <script> tag. The object uses
// JS-literal syntax (unquoted top-level keys, nested JSON), so we isolate the balanced { … }
// (string-aware so braces inside values don't fool us) and parse it as YAML — a superset that
// tolerates unquoted keys. This mirrors the reference skodaconnect/myskoda CSRFParser. Exported
// for unit testing against captured HTML.
export function extractCsrf(
  html: string,
  step: string,
): { csrf: string; hmac: string; relayState: string } {
  const marker = html.indexOf('window._IDK')
  if (marker < 0) throw new Error(`Skoda login (${step}): window._IDK not found in page`)
  const braceStart = html.indexOf('{', marker)
  if (braceStart < 0) throw new Error(`Skoda login (${step}): window._IDK object not found`)

  let depth = 0
  let inStr = false
  let quote = ''
  let end = -1
  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i]
    if (inStr) {
      if (ch === '\\')
        i++ // skip the escaped character
      else if (ch === quote) inStr = false
      continue
    }
    if (ch === '"' || ch === "'") {
      inStr = true
      quote = ch
    } else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) throw new Error(`Skoda login (${step}): window._IDK object not terminated`)

  let idk: { csrf_token?: string; templateModel?: { hmac?: string; relayState?: string } }
  try {
    idk = parseYaml(html.slice(braceStart, end)) as typeof idk
  } catch {
    throw new Error(`Skoda login (${step}): failed to parse window._IDK`)
  }
  const csrf = idk.csrf_token
  const hmac = idk.templateModel?.hmac
  const relayState = idk.templateModel?.relayState
  if (!csrf || !hmac || !relayState)
    throw new Error(`Skoda login (${step}): window._IDK missing csrf/hmac/relayState`)
  return { csrf, hmac, relayState }
}

export function createAuthClient(
  cfg: SkodaCfg,
  ctx: { db: DatabaseSync; log: Logger },
): AuthClient {
  let tokens: TokenSet | null = null
  let authFailures = 0
  let firstFailureAt = 0

  function mask(s: string): string {
    return s.length > 8 ? `${s.slice(0, 6)}…` : '***'
  }

  // --- Auth flow helpers as closures so they can use ctx.log for debug-level URL logging ---

  // Parse the OAuth authorization code from the final redirect URL.
  // Handles both fragment (#code=...) and query (?code=...) forms.
  // Throws on error responses and terms-of-service consent redirects.
  // URLs are logged at debug level only (not included in the thrown message).
  function parseCode(finalUrl: string): string {
    let u: URL
    try {
      u = new URL(finalUrl)
    } catch {
      ctx.log.debug({ finalUrl }, 'skoda auth: could not parse redirect URL')
      throw new Error(
        'Skoda auth: unexpected redirect URL (URL omitted from log; run with LOG_LEVEL=debug)',
      )
    }
    // evcc: "if u.Fragment != '' { u.RawQuery = u.Fragment }"
    const searchStr = u.hash ? u.hash.slice(1) : u.search.slice(1)
    const params = new URLSearchParams(searchStr)

    const errStr = params.get('error')
    if (errStr) throw new Error(`Skoda auth error: ${errStr}`)

    // Terms-of-service update (not marketing consent — this requires user action)
    if (params.get('updated') || u.pathname.includes('/consent/')) {
      throw new Error(
        'Skoda: terms of service need confirmation — please open the MySkoda app and accept, then restart OSC',
      )
    }

    const code = params.get('code')
    if (!code) {
      ctx.log.debug({ finalUrl }, 'skoda auth: redirect URL missing code parameter')
      throw new Error('Skoda auth: redirect URL missing code parameter')
    }
    return code
  }

  // Skip the optional VW marketing consent page by fetching the embedded callback URL.
  // VW periodically interjects this after a successful login (#29760 in evcc).
  async function skipMarketingConsent(consentUrl: string, jar: CookieJar): Promise<string> {
    const u = new URL(consentUrl)
    const callback = u.searchParams.get('callback')
    if (!callback) throw new Error('Skoda auth: marketing consent page missing callback parameter')
    // Normalise query (spaces in scopes etc.)
    const cbUrl = new URL(callback)
    cbUrl.search = new URLSearchParams(cbUrl.searchParams).toString()
    const { finalUrl } = await navigate(cbUrl.toString(), { jar })
    return parseCode(finalUrl)
  }

  // Full OAuth2 + PKCE login against VW Group Identity → returns the authorization code.
  // Mirrors the current skodaconnect/myskoda flow: authorize → read CSRF from window._IDK →
  // POST the email to /login/identifier → read CSRF again → POST the password to
  // /login/authenticate → follow redirects to the myskoda:// deep link carrying the code.
  // (The old flow omitted prompt=login and added a state param, which made VW take a
  // session-reuse path that 303'd the email step to an empty /authenticate page.)
  async function loginFlow(username: string, password: string, challenge: string): Promise<string> {
    const jar = new CookieJar()
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      nonce: randomBytes(16).toString('base64url'),
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 's256',
      prompt: 'login',
    })

    // 1. Authorize → the email login page.
    const { body: loginHtml, finalUrl: authUrl } = await navigate(
      `${IDENTITY_BASE}/oidc/v1/authorize?${params.toString()}`,
      { jar },
    )
    if (authUrl.includes('/consent/marketing/')) return skipMarketingConsent(authUrl, jar)
    const emailCsrf = extractCsrf(loginHtml, 'email page')

    // 2. POST the email → the password page (carries a fresh CSRF state).
    const idBody = new URLSearchParams({
      relayState: emailCsrf.relayState,
      email: username,
      hmac: emailCsrf.hmac,
      _csrf: emailCsrf.csrf,
    }).toString()
    const { body: pwHtml } = await navigate(
      `${IDENTITY_BASE}/signin-service/v1/${CLIENT_ID}/login/identifier`,
      { method: 'POST', body: idBody, contentType: 'application/x-www-form-urlencoded', jar },
    )
    const pwCsrf = extractCsrf(pwHtml, 'password page')

    // 3. POST the password → redirect chain → myskoda://…?code=…
    const authBody = new URLSearchParams({
      relayState: pwCsrf.relayState,
      email: username,
      password,
      hmac: pwCsrf.hmac,
      _csrf: pwCsrf.csrf,
    }).toString()
    const { finalUrl } = await navigate(
      `${IDENTITY_BASE}/signin-service/v1/${CLIENT_ID}/login/authenticate`,
      { method: 'POST', body: authBody, contentType: 'application/x-www-form-urlencoded', jar },
    )

    if (finalUrl.includes('/consent/marketing/')) return skipMarketingConsent(finalUrl, jar)
    return parseCode(finalUrl)
  }

  // --- Token management ---

  async function doRefresh(refreshToken: string): Promise<TokenSet> {
    const resp = await fetch(REFRESH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: refreshToken }),
    })
    if (!resp.ok) throw new Error(`Skoda token refresh: HTTP ${resp.status}`)
    const tok = (await resp.json()) as { accessToken?: string; refreshToken?: string }
    if (!tok.accessToken || !tok.refreshToken)
      throw new Error('Skoda token refresh: missing fields in response')
    saveRefreshToken(ctx.db, cfg.name, tok.refreshToken)
    ctx.log.debug({ at: mask(tok.accessToken) }, 'skoda token refreshed')
    return {
      accessToken: tok.accessToken,
      refreshToken: tok.refreshToken,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    }
  }

  async function doLogin(): Promise<TokenSet> {
    const { verifier, challenge } = pkce()
    ctx.log.debug('skoda: starting OAuth login flow')
    const code = await loginFlow(cfg.username, cfg.password, challenge)
    const resp = await fetch(CODE_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // evcc field name is "verifier", not "code_verifier"
      body: JSON.stringify({ code, redirectUri: REDIRECT_URI, verifier }),
    })
    if (!resp.ok) throw new Error(`Skoda code exchange: HTTP ${resp.status}`)
    const tok = (await resp.json()) as { accessToken?: string; refreshToken?: string }
    if (!tok.accessToken || !tok.refreshToken)
      throw new Error('Skoda code exchange: missing fields in response')
    saveRefreshToken(ctx.db, cfg.name, tok.refreshToken)
    ctx.log.info({ at: mask(tok.accessToken) }, 'skoda login successful')
    return {
      accessToken: tok.accessToken,
      refreshToken: tok.refreshToken,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    }
  }

  return {
    async token(): Promise<string> {
      // Valid access token cached
      if (tokens && tokens.expiresAt > Date.now()) return tokens.accessToken

      // Locked out after 3 consecutive failures within an hour
      if (authFailures >= 3 && Date.now() - firstFailureAt < 3_600_000) {
        throw new Error('Skoda auth locked out after 3 consecutive failures within 1 h')
      }

      // Try refresh first (from in-memory or SQLite)
      const savedRefresh = tokens?.refreshToken ?? loadRefreshToken(ctx.db, cfg.name)
      if (savedRefresh) {
        try {
          tokens = await doRefresh(savedRefresh)
          authFailures = 0
          return tokens.accessToken
        } catch {
          ctx.log.debug('skoda refresh failed, falling back to full login')
          tokens = null
        }
      }

      // Full login flow
      try {
        tokens = await doLogin()
        authFailures = 0
        return tokens.accessToken
      } catch (err) {
        // Start a fresh failure window if this is the first failure ever, or if the
        // previous window has expired (otherwise authFailures grows without bound and
        // the lockout check never re-arms after the first window expires).
        if (authFailures === 0 || Date.now() - firstFailureAt >= 3_600_000) {
          firstFailureAt = Date.now()
          authFailures = 0
        }
        authFailures++
        ctx.log.warn({ failures: authFailures }, 'skoda login failed')
        throw err
      }
    },

    deadAuth(): boolean {
      return authFailures >= 3 && Date.now() - firstFailureAt < 3_600_000
    },

    async dispose(): Promise<void> {
      tokens = null
    },
  }
}
