import { createHash, randomBytes } from 'node:crypto'
import { load } from 'cheerio'
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
    const headers: Record<string, string> = { 'User-Agent': 'OpenSmartCharge/1.0' }
    const cookie = jar?.header(currentUrl)
    if (cookie) headers['Cookie'] = cookie
    if (contentType) headers['Content-Type'] = contentType

    const resp = await fetch(currentUrl, { method, headers, body, redirect: 'manual' })
    jar?.collect(currentUrl, resp.headers)

    const location = resp.headers.get('location')
    if (resp.status >= 300 && resp.status < 400 && location) {
      // Non-HTTP redirect (e.g. myskoda://): stop and surface the location
      if (!/^https?:\/\//i.test(location)) {
        return { body: '', finalUrl: new URL(location, currentUrl).toString() }
      }
      currentUrl = new URL(location, currentUrl).toString()
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

// Parse the OAuth authorization code from the final redirect URL.
// Handles both fragment (#code=...) and query (?code=...) forms.
// Throws on error responses and terms-of-service consent redirects.
function parseCode(finalUrl: string): string {
  let u: URL
  try {
    u = new URL(finalUrl)
  } catch {
    throw new Error(`Skoda auth: unexpected redirect URL: ${finalUrl}`)
  }
  // evcc: "if u.Fragment != '' { u.RawQuery = u.Fragment }"
  const searchStr = u.hash ? u.hash.slice(1) : u.search.slice(1)
  const params = new URLSearchParams(searchStr)

  const errStr = params.get('error')
  if (errStr) throw new Error(`Skoda auth error: ${errStr}`)

  // Terms-of-service update (not marketing consent — this requires user action)
  if (params.get('updated') || u.pathname.includes('/consent/')) {
    throw new Error(
      `Skoda: terms of service need confirmation — please open the MySkoda app and accept, then restart OSC`,
    )
  }

  const code = params.get('code')
  if (!code) throw new Error(`Skoda auth: no code in redirect URL: ${finalUrl}`)
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

// New login flow (VW Group Identity 2023+): single POST with username+password+state.
// Ported from evcc vwidentity/endpoint.go loginNew().
async function loginNew(html: string, username: string, password: string, jar: CookieJar): Promise<string> {
  const $ = load(html)
  const stateVal = $('input[name="state"]').first().attr('value')
  if (!stateVal) throw new Error('Skoda login (new flow): no state input found in page')

  const formBody = new URLSearchParams({ username, password, state: stateVal }).toString()
  const { finalUrl } = await navigate(`${IDENTITY_BASE}/u/login?state=${encodeURIComponent(stateVal)}`, {
    method: 'POST',
    body: formBody,
    contentType: 'application/x-www-form-urlencoded',
    jar,
  })

  if (finalUrl.includes('/consent/marketing/')) return skipMarketingConsent(finalUrl, jar)
  return parseCode(finalUrl)
}

// Legacy login flow (older VW Group Identity): separate identifier + authenticate steps.
// Parses the window._IDK JavaScript variable to extract CSRF token and form action.
// Ported from evcc vwidentity/endpoint.go loginLegacy() + forms.go parseCredentials().
async function loginLegacy(html: string, username: string, password: string, jar: CookieJar): Promise<string> {
  const $ = load(html)
  const form = $('form#emailPasswordForm').first()
  const action = form.attr('action') ?? ''
  const inputs: Record<string, string> = {}
  form.find('input').each((_, el) => {
    const name = $(el).attr('name')
    if (name) inputs[name] = $(el).attr('value') ?? ''
  })

  // Step 1: POST email to identifier endpoint
  const idUrl = /^https?:\/\//i.test(action) ? action : `${IDENTITY_BASE}${action}`
  const idBody = new URLSearchParams({ ...inputs, email: username }).toString()
  const { body: credHtml } = await navigate(idUrl, {
    method: 'POST',
    body: idBody,
    contentType: 'application/x-www-form-urlencoded',
    jar,
  })

  // Step 2: Extract window._IDK JSON for CSRF token and form action
  const idkMatch = /window\._IDK\s*=\s*(.*?)[;<]/s.exec(credHtml)
  if (!idkMatch) throw new Error('Skoda login (legacy): window._IDK not found in credentials page')

  let idkJson = idkMatch[1].replace(/'/g, '"')
  idkJson = idkJson.replace(/\s(\w+)\s*:/g, ' "$1":')
  idkJson = idkJson.replace(/,\s+}/g, '}')

  let idk: { templateModel?: { hmac?: string; relayState?: string; postAction?: string; error?: string }; csrf_token?: string }
  try {
    idk = JSON.parse(idkJson) as typeof idk
  } catch {
    throw new Error('Skoda login (legacy): failed to parse window._IDK')
  }

  if (idk.templateModel?.error) throw new Error(`Skoda login: ${idk.templateModel.error}`)

  const pwdInputs: Record<string, string> = {
    _csrf: idk.csrf_token ?? '',
    relayState: idk.templateModel?.relayState ?? '',
    hmac: idk.templateModel?.hmac ?? '',
    email: username,
    password,
  }

  // Step 3: POST password to authenticate endpoint
  const postAction = idk.templateModel?.postAction ?? ''
  const authUrl = /^https?:\/\//i.test(postAction) ? postAction : `${IDENTITY_BASE}${postAction}`
  const { finalUrl } = await navigate(authUrl, {
    method: 'POST',
    body: new URLSearchParams(pwdInputs).toString(),
    contentType: 'application/x-www-form-urlencoded',
    jar,
  })

  if (finalUrl.includes('/consent/marketing/')) return skipMarketingConsent(finalUrl, jar)
  return parseCode(finalUrl)
}

// Full OAuth2+PKCE login → returns authorization code.
async function loginFlow(username: string, password: string, challenge: string): Promise<string> {
  const jar = new CookieJar()
  const nonce = randomBytes(22).toString('base64url')
  const state = randomBytes(8).toString('hex')

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    nonce,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  const { body: html, finalUrl } = await navigate(`${IDENTITY_BASE}/oidc/v1/authorize?${params.toString()}`, { jar })

  // Marketing consent can interject immediately on the authorize URL
  if (finalUrl.includes('/consent/marketing/')) return skipMarketingConsent(finalUrl, jar)

  const $ = load(html)

  // New flow: single-step login (current VW Group Identity servers, 2023+)
  if ($('input[name="state"]').length > 0) return loginNew(html, username, password, jar)

  // Legacy flow: two-step login (older servers)
  if ($('form#emailPasswordForm').length > 0) return loginLegacy(html, username, password, jar)

  throw new Error(
    'Skoda: login page format not recognised — the VW Group Identity flow may have changed. ' +
      'Please open a GitHub issue with the following URL (redact credentials): ' +
      finalUrl,
  )
}

export function createAuthClient(cfg: SkodaCfg, ctx: { db: DatabaseSync; log: Logger }): AuthClient {
  let tokens: TokenSet | null = null
  let authFailures = 0
  let firstFailureAt = 0

  function mask(s: string): string {
    return s.length > 8 ? `${s.slice(0, 6)}…` : '***'
  }

  async function doRefresh(refreshToken: string): Promise<TokenSet> {
    const resp = await fetch(REFRESH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: refreshToken }),
    })
    if (!resp.ok) throw new Error(`Skoda token refresh: HTTP ${resp.status}`)
    const tok = (await resp.json()) as { accessToken?: string; refreshToken?: string }
    if (!tok.accessToken || !tok.refreshToken) throw new Error('Skoda token refresh: missing fields in response')
    saveRefreshToken(ctx.db, cfg.name, tok.refreshToken)
    ctx.log.debug({ at: mask(tok.accessToken) }, 'skoda token refreshed')
    return { accessToken: tok.accessToken, refreshToken: tok.refreshToken, expiresAt: Date.now() + 55 * 60_000 }
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
    if (!tok.accessToken || !tok.refreshToken) throw new Error('Skoda code exchange: missing fields in response')
    saveRefreshToken(ctx.db, cfg.name, tok.refreshToken)
    ctx.log.info({ at: mask(tok.accessToken) }, 'skoda login successful')
    return { accessToken: tok.accessToken, refreshToken: tok.refreshToken, expiresAt: Date.now() + 55 * 60_000 }
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
        if (authFailures === 0) firstFailureAt = Date.now()
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
