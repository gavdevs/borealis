import { randomUUID } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { BorealisConfig } from './config.js'
import type { BorealisVariables } from './context.js'
import type { BorealisDatabase } from './db.js'
import { randomBearer, secureStringEqual, sha256Hex } from './crypto.js'
import { DUMMY_PASSWORD_HASH, hashPassword, PasswordBusyError, verifyPassword, type PasswordRuntime } from './passwords.js'

const API = '/api/borealis/v1'
const SESSION_SECONDS = 30 * 24 * 60 * 60
const SESSION_PATTERN = /^brl_session_[A-Za-z0-9_-]{43}$/
const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/, 'Use 3–32 letters, numbers, or underscores for your username.')
const passwordSchema = z.string().max(256).refine((value) => {
  const length = Array.from(value).length
  return length >= 15 && length <= 128
}, 'Use a password or passphrase with 15–128 characters.')
const credentialsSchema = z.object({ username: usernameSchema, password: passwordSchema }).strict()
const signinSchema = z.object({ username: usernameSchema, password: z.string().min(1).max(256) }).strict()
const bootstrapSchema = credentialsSchema.extend({ adminToken: z.string().min(1).max(512) })
const changeSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema }).strict()

type AuthContext = Context<{ Variables: BorealisVariables }>
type Options = {
  config: BorealisConfig
  database: BorealisDatabase
  clock?: () => Date
  clientAddress?: (context: Context) => string
  passwordRuntime?: PasswordRuntime
}

export function registerAccountAuth(app: Hono<{ Variables: BorealisVariables }>, options: Options) {
  const { database, config } = options
  const clock = options.clock ?? (() => new Date())
  const publicUrl = new URL(config.publicBaseUrl)
  const secure = publicUrl.protocol === 'https:'
  const cookieName = secure ? '__Host-borealis_session' : 'borealis_session'
  const cookieOptions = { httpOnly: true, secure, sameSite: 'Strict' as const, path: '/' }
  const allowedOrigins = new Set([publicUrl.origin])
  if (!secure && ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)) {
    for (const host of ['localhost', '127.0.0.1']) {
      for (const port of [config.port, 5173]) allowedOrigins.add(`http://${host}:${port}`)
    }
  }
  function readSession(c: AuthContext): string | null {
    const raw = getCookie(c, cookieName)
    return raw && SESSION_PATTERN.test(raw) ? sha256Hex(raw) : null
  }
  function clearSession(c: AuthContext) { deleteCookie(c, cookieName, cookieOptions) }
  function issueSession(c: AuthContext, raw: string) {
    setCookie(c, cookieName, raw, { ...cookieOptions, maxAge: SESSION_SECONDS })
  }
  function newSession() {
    const raw = randomBearer('brl_session_')
    const now = clock()
    return { raw, digest: sha256Hex(raw), now: now.toISOString(), expiresAt: new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString() }
  }

  async function limit(c: AuthContext, bucket: string, max: number, seconds: number): Promise<boolean> {
    // The runtime supplies the socket peer or Cloudflare-verified client IP.
    // Never consume arbitrary forwarding headers in the shared application.
    const peer = options.clientAddress?.(c) ?? 'unavailable'
    const key = sha256Hex(`${config.adminToken}\0${bucket}\0${peer}`)
    const allowed = await database.consumeRateLimit(key, max, seconds, clock().toISOString())
    if (!allowed) c.header('Retry-After', String(seconds))
    return allowed
  }
  const browserMutationGuard = createMiddleware<{ Variables: BorealisVariables }>(async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next()
    const origin = c.req.header('Origin')
    if (c.req.header('X-Borealis-Request') !== '1'
      || c.req.header('Sec-Fetch-Site') === 'cross-site'
      || (origin !== undefined && !allowedOrigins.has(origin))) {
      return c.json({ error: 'This request must come from your Borealis companion.' }, 403)
    }
    if (['POST', 'PUT', 'PATCH'].includes(c.req.method)
      && c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return c.json({ error: 'A JSON request body is required.' }, 415)
    }
    await next()
  })
  const accountAuth = createMiddleware<{ Variables: BorealisVariables }>(async (c, next) => {
    const digest = readSession(c)
    const session = digest ? await database.getSession(digest, clock().toISOString()) : null
    if (!session || !digest) {
      clearSession(c)
      return c.json({ error: 'Sign in to your Borealis account.' }, 401)
    }
    c.set('account', session.account)
    c.set('sessionDigest', digest)
    await next()
  })
  const curatorAuth = createMiddleware<{ Variables: BorealisVariables }>(async (c, next) => {
    if (c.get('account').role !== 'curator') return c.json({ error: 'Only a catalog curator can approve or change apps.' }, 403)
    await next()
  })

  app.use(`${API}/auth/*`, browserMutationGuard)
  app.use(`${API}/auth/*`, async (c, next) => {
    try { await next() } catch (error) {
      if (!(error instanceof PasswordBusyError)) throw error
      c.header('Retry-After', '3')
      return c.json({ error: 'Sign-in is busy. Try again in a few seconds.' }, 503)
    }
  })
  app.get(`${API}/auth/session`, async (c) => {
    const digest = readSession(c)
    const session = digest ? await database.getSession(digest, clock().toISOString()) : null
    if (digest && !session) clearSession(c)
    return c.json({ account: session?.account ?? null, bootstrapAvailable: await database.isBootstrapAvailable() })
  })

  for (const bootstrap of [false, true]) {
    app.post(`${API}/auth/${bootstrap ? 'bootstrap' : 'signup'}`, async (c) => {
      if (!await limit(c, bootstrap ? 'bootstrap' : 'signup', 5, bootstrap ? 900 : 3600)) {
        return c.json({ error: 'Too many attempts. Try again later.' }, 429)
      }
      const parsed = (bootstrap ? bootstrapSchema : credentialsSchema).safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Check your username and password.' }, 400)
      if (bootstrap) {
        if (!('adminToken' in parsed.data) || !secureStringEqual(parsed.data.adminToken as string, config.adminToken)) {
          return c.json({ error: 'The server setup token is not valid.' }, 401)
        }
        if (!await database.isBootstrapAvailable()) return c.json({ error: 'Server owner setup is already complete.' }, 409)
      }
      const passwordHash = await hashPassword(parsed.data.password, options.passwordRuntime)
      const session = newSession()
      const account = await database.createAccount({
        id: randomUUID(), username: parsed.data.username, passwordHash,
        createdAt: session.now, sessionDigest: session.digest, sessionExpiresAt: session.expiresAt, bootstrap,
      })
      if (!account) return c.json({ error: 'That username is unavailable, or server setup is already complete.' }, 409)
      const previous = readSession(c)
      if (previous) await database.deleteSession(previous)
      issueSession(c, session.raw)
      return c.json({ account }, 201)
    })
  }

  app.post(`${API}/auth/signin`, async (c) => {
    if (!await limit(c, 'signin', 30, 900)) return c.json({ error: 'Too many sign-in attempts. Try again later.' }, 429)
    const parsed = signinSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Check your username and password.' }, 400)
    const usernameKey = sha256Hex(`${config.adminToken}\0username\0${parsed.data.username}`)
    if (!await database.consumeRateLimit(usernameKey, 10, 900, clock().toISOString())) {
      c.header('Retry-After', '900')
      return c.json({ error: 'Too many sign-in attempts. Try again later.' }, 429)
    }
    const credentials = await database.findAccountCredentials(parsed.data.username)
    const valid = await verifyPassword(parsed.data.password, credentials?.passwordHash ?? DUMMY_PASSWORD_HASH, options.passwordRuntime)
    if (!valid || !credentials) return c.json({ error: 'Username or password is incorrect.' }, 401)
    const session = newSession()
    const account = await database.createAccountSession(credentials.account.id, credentials.passwordHash, session.digest, session.expiresAt, session.now)
    if (!account) return c.json({ error: 'Username or password is incorrect.' }, 401)
    const previous = readSession(c)
    if (previous) await database.deleteSession(previous)
    issueSession(c, session.raw)
    return c.json({ account })
  })

  app.post(`${API}/auth/signout`, async (c) => {
    const digest = readSession(c)
    if (digest) await database.deleteSession(digest)
    clearSession(c)
    return c.json({ ok: true })
  })

  app.post(`${API}/auth/change-password`, accountAuth, async (c) => {
    if (!await limit(c, 'change-password', 10, 900)) return c.json({ error: 'Too many attempts. Try again later.' }, 429)
    const parsed = changeSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Check your password.' }, 400)
    const credentials = await database.getAccountCredentials(c.get('account').id)
    if (!credentials || !await verifyPassword(parsed.data.currentPassword, credentials.passwordHash, options.passwordRuntime)) {
      return c.json({ error: 'Current password is incorrect.' }, 400)
    }
    const passwordHash = await hashPassword(parsed.data.newPassword, options.passwordRuntime)
    const session = newSession()
    const account = await database.changeAccountPassword(credentials.account.id, credentials.passwordHash, passwordHash, session.digest, session.expiresAt, session.now)
    if (!account) return c.json({ error: 'Your password changed. Sign in again.' }, 401)
    issueSession(c, session.raw)
    return c.json({ account })
  })
  return { accountAuth, curatorAuth, browserMutationGuard, limit }
}
