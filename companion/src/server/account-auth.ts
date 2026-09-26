import type { Context, Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { deleteCookie } from 'hono/cookie'
import { z } from 'zod'
import { runWithTransaction } from '@better-auth/core/context'
import type { BorealisConfig } from './config.js'
import type { BorealisVariables } from './context.js'
import type { BorealisDatabase } from './db.js'
import { secureStringEqual, sha256Hex } from './crypto.js'
import { PasswordBusyError, type PasswordRuntime } from './passwords.js'
import { AUTH_BASE_PATH, createAccountAuth, internalAuthEmail } from './better-auth.js'

const API = '/api/borealis/v1'
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
  const auth = createAccountAuth(config, database, options.passwordRuntime)
  const allowedOrigins = new Set([publicUrl.origin])
  if (!secure && ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)) {
    for (const host of ['localhost', '127.0.0.1']) {
      for (const port of [config.port, 5173]) allowedOrigins.add(`http://${host}:${port}`)
    }
  }
  function clearSession(c: AuthContext) { deleteCookie(c, cookieName, cookieOptions) }
  function authHeaders(c: AuthContext): Headers {
    const headers = new Headers(c.req.raw.headers)
    // Only the runtime-provided peer may populate Better Auth's audit metadata.
    headers.delete('forwarded')
    headers.delete('x-real-ip')
    headers.delete('cf-connecting-ip')
    headers.set('x-forwarded-for', options.clientAddress?.(c) ?? 'unavailable')
    return headers
  }
  async function callAuth(c: AuthContext, endpoint: string, body: unknown): Promise<Response> {
    try {
      return await database.runAuth(() => auth.handler(new Request(`${publicUrl.origin}${AUTH_BASE_PATH}${endpoint}`, {
        method: 'POST', headers: authHeaders(c), body: JSON.stringify(body),
      })))
    } catch {
      return new Response(null, { status: 503 })
    }
  }
  function unavailable(c: AuthContext) {
    c.header('Retry-After', '3')
    return c.json({ error: 'Account service is temporarily unavailable. Please try again.' }, 503)
  }
  async function atomicAuth(operation: () => Promise<Response>): Promise<Response> {
    return database.runAuth(async () => {
      try {
        const context = await auth.$context
        // Better Auth owns the password/session operations. Keep credential
        // verification and session writes in one transaction so password changes
        // cannot race a signin using the previous password, or partially commit.
        // Use the server API: handler() would reset the transaction context.
        return await runWithTransaction(context.adapter, async () => {
          const response = await operation()
          if (!response.ok) throw response
          return response
        })
      } catch (error) {
        return error instanceof Response ? error : new Response(null, { status: 503 })
      }
    })
  }
  function copyCookies(c: AuthContext, response: Response) {
    for (const cookie of response.headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true })
  }
  async function readSession(c: AuthContext) {
    return database.runAuth(() => auth.api.getSession({ headers: authHeaders(c) }))
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
    const session = await readSession(c)
    const account = session ? await database.getAccount(session.user.id) : null
    if (!session || !account) {
      clearSession(c)
      return c.json({ error: 'Sign in to your Borealis account.' }, 401)
    }
    c.set('account', account)
    c.set('sessionDigest', sha256Hex(session.session.token))
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
    const session = await readSession(c)
    const account = session ? await database.getAccount(session.user.id) : null
    if (!account && c.req.header('Cookie')) clearSession(c)
    return c.json({ account, bootstrapAvailable: await database.isBootstrapAvailable() })
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
      const response = await callAuth(c, '/sign-up/email', {
        email: internalAuthEmail(parsed.data.username), name: parsed.data.username,
        username: parsed.data.username, password: parsed.data.password,
      })
      if (!response.ok) {
        if (response.status >= 500) return unavailable(c)
        const error = await response.json() as { code?: string }
        if (['USER_ALREADY_EXISTS', 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', 'USERNAME_IS_ALREADY_TAKEN'].includes(error.code ?? '')) {
          return c.json({ error: 'That username is unavailable, or server setup is already complete.' }, 409)
        }
        return c.json({ error: 'Unable to create your account. Please try again.' }, 400)
      }
      const result = await response.json() as { user: { id: string } }
      let account = await database.ensureBetterAuthAccount({
        id: result.user.id, username: parsed.data.username, createdAt: clock().toISOString(),
      })
      if (account && bootstrap) account = await database.claimBetterAuthOwner(account.id, clock().toISOString())
      if (!account) return c.json({ error: 'That username is unavailable, or server setup is already complete.' }, 409)
      await database.runAuth(() => auth.api.signOut({ headers: authHeaders(c) }))
      copyCookies(c, response)
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
    // Use the internal alias with the core API: the username plugin's lookup
    // bypasses Better Auth's transaction adapter in 1.7.6. The public API still
    // accepts only a validated username, never an email or user-provided alias.
    const response = await atomicAuth(() => auth.api.signInEmail({
      headers: authHeaders(c),
      body: { email: internalAuthEmail(parsed.data.username), password: parsed.data.password },
      asResponse: true,
    }))
    if (response.status >= 500) return unavailable(c)
    if (!response.ok) return c.json({ error: 'Username or password is incorrect.' }, 401)
    const result = await response.json() as { user: { id: string } }
    const account = await database.ensureBetterAuthAccount({
      id: result.user.id, username: parsed.data.username, createdAt: clock().toISOString(),
    })
    if (!account) return c.json({ error: 'Username or password is incorrect.' }, 401)
    await database.runAuth(() => auth.api.signOut({ headers: authHeaders(c) }))
    copyCookies(c, response)
    return c.json({ account })
  })

  app.post(`${API}/auth/signout`, async (c) => {
    const response = await callAuth(c, '/sign-out', {})
    if (!response.ok) return unavailable(c)
    copyCookies(c, response)
    return c.json({ ok: true })
  })

  app.post(`${API}/auth/change-password`, accountAuth, async (c) => {
    if (!await limit(c, 'change-password', 10, 900)) return c.json({ error: 'Too many attempts. Try again later.' }, 429)
    const parsed = changeSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Check your password.' }, 400)
    const response = await atomicAuth(() => auth.api.changePassword({
      headers: authHeaders(c), body: { ...parsed.data, revokeOtherSessions: true }, asResponse: true,
    }))
    if (response.status >= 500) return unavailable(c)
    if (!response.ok) {
      return c.json({ error: 'Current password is incorrect.' }, 400)
    }
    copyCookies(c, response)
    return c.json({ account: c.get('account') })
  })
  return { accountAuth, curatorAuth, browserMutationGuard, limit }
}
