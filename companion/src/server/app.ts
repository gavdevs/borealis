import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import { z, ZodError } from 'zod'
import type {
  InstallJobPayload,
  JobSummary,
  PairingSummary,
  SignedJobEnvelope,
} from '../shared/api.js'
import { registerAccountAuth } from './account-auth.js'
import type { BorealisConfig } from './config.js'
import type { BorealisVariables } from './context.js'
import {
  generateUserCode,
  normalizeUserCode,
  privateKeyFromPkcs8,
  randomBearer,
  randomNonce,
  sha256Hex,
  signPayload,
  type PersistedSigningKey,
} from './crypto.js'
import { BorealisDatabase } from './db.js'
import { PasswordBusyError, type PasswordRuntime } from './passwords.js'
import type { PlaySearchProvider } from './play-search.js'
import { appIdentityPolicyReason, appPolicyReason } from './app-policy.js'

const API = '/api/borealis/v1'
const DEVICE_BEARER_PATTERN = /^brl_device_[A-Za-z0-9_-]{43}$/
const POLL_SECRET_PATTERN = /^brl_poll_[A-Za-z0-9_-]{43}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/
const MAX_SEARCH_DETAIL_REQUESTS = 8

const pairingBodySchema = z.object({
  deviceLabel: z.string().trim().min(1).max(64),
  deviceBearerDigest: z.string().regex(SHA256_PATTERN),
}).strict()

const assignmentBodySchema = z.object({ packageName: z.string().regex(PACKAGE_PATTERN) }).strict()
const approvalBodySchema = z.object({ userCode: z.string().min(8).max(20) }).strict()
const reportBodySchema = z.object({
  status: z.enum(['installing', 'awaiting_user_action', 'review_required', 'succeeded', 'failed', 'cancelled']),
  installedVersionCode: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  observedSignerSha256: z.array(z.string().max(128)).max(8).optional(),
  message: z.string().trim().max(1_000).nullable().optional(),
}).strict()

export type AppOptions = {
  config: BorealisConfig
  database: BorealisDatabase
  playSearch: PlaySearchProvider
  clock?: () => Date
  clientAddress?: (c: Context) => string
  passwordRuntime?: PasswordRuntime
  signingKey?: PersistedSigningKey
}

export async function createBorealisApp(options: AppOptions): Promise<Hono<{ Variables: BorealisVariables }>> {
  const { config, database, playSearch } = options
  const clock = options.clock ?? (() => new Date())
  const signingKey = options.signingKey ?? await database.getOrCreateSigningKey(clock().toISOString())
  const privateSigningKey = privateKeyFromPkcs8(signingKey.privateKeyPkcs8)
  const app = new Hono<{ Variables: BorealisVariables }>()

  app.use('*', secureHeaders())
  app.use(`${API}/*`, bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'Request body is too large.' }, 413) }))
  app.use(`${API}/*`, async (c, next) => {
    c.header('Cache-Control', 'no-store')
    await next()
  })

  const {
    accountAuth,
    browserMutationGuard,
    limit,
  } = registerAccountAuth(app, options)

  const deviceAuth = createMiddleware<{ Variables: BorealisVariables }>(async (c, next) => {
    const bearer = bearerToken(c.req.header('Authorization'))
    if (!bearer || !DEVICE_BEARER_PATTERN.test(bearer)) {
      return c.json({ error: 'A valid device credential is required.' }, 401)
    }
    const device = await database.authenticateDevice(sha256Hex(bearer))
    if (!device) return c.json({ error: 'This device is not active.' }, 401)
    c.set('device', device)
    await next()
  })

  app.use(`${API}/catalog/search`, accountAuth)
  app.use(`${API}/me/*`, browserMutationGuard)
  app.use(`${API}/me/*`, accountAuth)
  app.use(`${API}/device/*`, deviceAuth)

  app.get(`${API}/health`, (c) => c.json({
    status: 'ok',
    service: 'borealis',
    version: '0.1.0',
    now: clock().toISOString(),
  }))

  app.get(`${API}/catalog/search`, async (c) => {
    const parsed = z.object({
      q: z.string().trim().min(2).max(100),
      limit: z.coerce.number().int().min(1).max(20).default(12),
    }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error)

    try {
      if (!await limit(c, 'catalog-search', 30, 60)) return rateLimited(c, 60)
      // The requested limit is an upper bound. Keep each query's detail lookup
      // batch small enough for the Free Worker; titles only pre-filter obvious
      // exclusions and never authorize an app without canonical metadata.
      const candidates = (await playSearch.search(parsed.data.q, parsed.data.limit))
        .filter((item) => appIdentityPolicyReason(item) === null)
        .slice(0, Math.min(parsed.data.limit, MAX_SEARCH_DETAIL_REQUESTS))
      const results = []
      let failedDetails = 0
      // Bound concurrent HTML buffers/subrequests on Workers Free. Only canonical
      // detail metadata can satisfy policy; search snippets are not permission.
      for (let offset = 0; offset < candidates.length; offset += 3) {
        const details = await Promise.all(candidates.slice(offset, offset + 3)
          .map((candidate) => playSearch.details(candidate.packageName).catch(() => {
            failedDetails++
            return null
          })))
        for (const item of details) {
          if (item && appPolicyReason(item) === null) {
            const { category: _category, description: _description, ...result } = item
            results.push(result)
          }
        }
      }
      if (candidates.length > 0 && failedDetails === candidates.length) {
        return c.json({ error: 'Google Play app details could not be reached. Please try again.' }, 502)
      }
      return c.json({ query: parsed.data.q, results })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Google Play search failed.'
      return c.json({ error: message }, 502)
    }
  })

  app.post(`${API}/pairings`, async (c) => {
    if (!await limit(c, 'pairing-create', 30, 600)) return rateLimited(c, 600)
    const parsed = await parseJson(c, pairingBodySchema)
    if (!parsed.ok) return parsed.response

    const now = clock()
    const pollSecret = randomBearer('brl_poll_')
    const userCode = generateUserCode()
    const pairingId = randomUUID()
    const expiresAt = new Date(now.getTime() + config.pairingTtlMinutes * 60_000).toISOString()
    await database.createPairing({
      id: pairingId,
      userCode,
      userCodeDigest: sha256Hex(normalizeUserCode(userCode)),
      pollSecretDigest: sha256Hex(pollSecret),
      deviceBearerDigest: parsed.data.deviceBearerDigest,
      deviceLabel: parsed.data.deviceLabel,
      createdAt: now.toISOString(),
      expiresAt,
    })

    return c.json({
      pairingId,
      userCode,
      pollSecret,
      verificationUrl: `${config.publicBaseUrl}/pair`,
      expiresAt,
    }, 201)
  })

  app.get(`${API}/pairings/:id`, async (c) => {
    const pollSecret = bearerToken(c.req.header('Authorization'))
    if (!pollSecret || !POLL_SECRET_PATTERN.test(pollSecret)) {
      return c.json({ error: 'A valid pairing credential is required.' }, 401)
    }
    const pairing = await database.getPairing(c.req.param('id'), sha256Hex(pollSecret), clock().toISOString())
    if (!pairing) return c.json({ error: 'Pairing not found.' }, 404)
    return c.json({
      state: pairing.state,
      deviceLabel: pairing.deviceLabel,
      expiresAt: pairing.expiresAt,
    })
  })

  app.post(`${API}/pairings/:id/activate`, async (c) => {
    const pollSecret = bearerToken(c.req.header('Authorization'))
    if (!pollSecret || !POLL_SECRET_PATTERN.test(pollSecret)) {
      return c.json({ error: 'A valid pairing credential is required.' }, 401)
    }
    const device = await database.activatePairing(c.req.param('id'), sha256Hex(pollSecret), clock().toISOString())
    if (!device) return c.json({ error: 'Pairing is not approved or has expired.' }, 409)
    return c.json({
      deviceId: device.id,
      keyId: signingKey.keyId,
      signingPublicKey: signingKey.publicKeySpki.toString('base64url'),
      signingPublicKeyFormat: 'spki-der-base64url',
    })
  })

  app.get(`${API}/me/stats`, async (c) => {
    // Owner-only usage summary. Members get the same 404 as an unknown route
    // so the counter's existence is never exposed.
    if (c.get('account').role !== 'curator') return c.json({ error: 'Not found.' }, 404)
    return c.json({ stats: await database.usageStats() })
  })

  app.get(`${API}/me/apps`, async (c) => {
    return c.json({ items: await database.listAccountApps(c.get('account').id) })
  })

  app.post(`${API}/me/apps`, async (c) => {
    const parsed = await parseJson(c, assignmentBodySchema)
    if (!parsed.ok) return parsed.response
    if (!await limit(c, 'library-add', 60, 600)) return rateLimited(c, 600)
    try {
      const details = await playSearch.details(parsed.data.packageName)
      if (!details) return c.json({ error: 'This app could not be found on Google Play.' }, 404)
      const policyReason = appPolicyReason(details)
      if (policyReason) return c.json({ error: policyReason }, 403)
      const item = await database.addResolvedAccountApp(c.get('account').id, details, clock().toISOString())
      return item ? c.json({ item }, 201) : c.json({ error: 'Account not found.' }, 404)
    } catch {
      return c.json({ error: 'Google Play app details could not be verified. Please try again.' }, 502)
    }
  })

  app.delete(`${API}/me/apps/:packageName`, async (c) => {
    const removed = await database.removeAccountApp(
      c.get('account').id,
      c.req.param('packageName'),
      clock().toISOString(),
    )
    return removed ? c.json({ ok: true }) : c.json({ error: 'Saved app not found.' }, 404)
  })

  app.get(`${API}/me/pairings`, async (c) => c.json({
    pairings: await database.listPairings(clock().toISOString(), c.get('account').id),
  }))

  app.post(`${API}/me/pairings/preview`, async (c) => {
    if (!await limit(c, 'pairing-preview', 30, 600)) return rateLimited(c, 600)
    const parsed = await parseJson(c, approvalBodySchema)
    if (!parsed.ok) return parsed.response
    const normalized = normalizeUserCode(parsed.data.userCode)
    if (normalized.length !== 12) return c.json({ error: 'Enter the 12-character code shown on the phone.' }, 400)
    const pairing = await database.previewPairing(sha256Hex(normalized), clock().toISOString())
    return pairing
      ? c.json({ pairing: pairingSummary(pairing) })
      : c.json({ error: 'Pairing code is invalid, used, or expired.' }, 404)
  })

  app.post(`${API}/me/pairings/approve`, async (c) => {
    if (!await limit(c, 'pairing-approve', 30, 600)) return rateLimited(c, 600)
    const parsed = await parseJson(c, approvalBodySchema)
    if (!parsed.ok) return parsed.response
    const normalized = normalizeUserCode(parsed.data.userCode)
    if (normalized.length !== 12) return c.json({ error: 'Enter the 12-character code shown on the phone.' }, 400)
    const owner = c.get('account').id
    const pairing = await database.approvePairing(
      sha256Hex(normalized),
      randomUUID(),
      clock().toISOString(),
      owner,
    )
    if (!pairing || !pairing.deviceId) return c.json({ error: 'Pairing code is invalid, used, or expired.' }, 404)
    return c.json({
      pairing: {
        id: pairing.id,
        deviceLabel: pairing.deviceLabel,
        state: pairing.state,
        expiresAt: pairing.expiresAt,
      },
      device: await database.getDevice(pairing.deviceId, owner),
    })
  })

  app.get(`${API}/me/devices`, async (c) => c.json({ devices: await database.listDevices(c.get('account').id) }))

  app.delete(`${API}/me/devices/:deviceId`, async (c) => {
    const revoked = await database.revokeDevice(
      c.req.param('deviceId'),
      clock().toISOString(),
      c.get('account').id,
    )
    return revoked ? c.json({ ok: true }) : c.json({ error: 'Active device not found.' }, 404)
  })

  app.get(`${API}/me/devices/:deviceId/jobs`, async (c) => {
    const owner = c.get('account').id
    const device = await database.getDevice(c.req.param('deviceId'), owner)
    return device
      ? c.json({ jobs: await database.listJobs(device.id, owner) })
      : c.json({ error: 'Device not found.' }, 404)
  })

  app.post(`${API}/me/devices/:deviceId/jobs`, async (c) => {
    const parsed = await parseJson(c, assignmentBodySchema)
    if (!parsed.ok) return parsed.response
    const owner = c.get('account').id
    const device = await database.getDevice(c.req.param('deviceId'), owner)
    if (!device) return c.json({ error: 'Device not found.' }, 404)
    const job = await database.queueLibraryJob(
      device.id,
      parsed.data.packageName,
      clock().toISOString(),
      owner,
    )
    return job ? c.json({ job }, 201) : c.json({ error: 'Add this app to your library before installing it.' }, 409)
  })

  function signedJob(job: JobSummary, now: Date): SignedJobEnvelope {
    const payload: InstallJobPayload = {
      schemaVersion: 1,
      jobId: job.id,
      deviceId: job.deviceId,
      action: 'install_or_update',
      packageName: job.packageName,
      displayName: job.displayName,
      // Publisher trust is enforced on the phone by APK signature continuity,
      // not by a shared human-approved catalog pin.
      acceptedSignerSha256: [],
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + config.jobTtlSeconds * 1_000).toISOString(),
      nonce: randomNonce(),
    }
    const exactPayload = JSON.stringify(payload)
    return { keyId: signingKey.keyId, payload: exactPayload, signature: signPayload(exactPayload, privateSigningKey) }
  }

  app.post(`${API}/device/library/:packageName/job`, async (c) => {
    const packageName = c.req.param('packageName')
    if (!PACKAGE_PATTERN.test(packageName)) return c.json({ error: 'Invalid package name.' }, 400)
    const now = clock()
    const job = await database.queueLibraryJob(c.get('device').id, packageName, now.toISOString())
    return job ? c.json({ job: signedJob(job, now) }) : c.json({ error: 'This app is not in your library.' }, 404)
  })

  app.get(`${API}/device/sync`, async (c) => {
    const device = c.get('device')
    const now = clock()
    const jobs = (await database.listSyncJobs(device.id, now.toISOString())).map((job) => signedJob(job, now))
    const library = await database.listDeviceLibrary(device.id)
    const refreshed = (await database.getDevice(device.id)) ?? device
    return c.json({
      deviceId: refreshed.id,
      deviceLabel: refreshed.label,
      revision: refreshed.revision,
      serverTime: now.toISOString(),
      library,
      jobs,
    })
  })

  app.post(`${API}/device/jobs/:jobId/report`, async (c) => {
    const parsed = await parseJson(c, reportBodySchema)
    if (!parsed.ok) return parsed.response
    const device = c.get('device')
    const job = await database.getJob(c.req.param('jobId'))
    if (!job || job.deviceId !== device.id) return c.json({ error: 'Job not found for this device.' }, 404)

    const observedSignerSha256 = normalizeSignerList(parsed.data.observedSignerSha256 ?? [])
    if (!observedSignerSha256) return c.json({ error: 'Observed signer values must be SHA-256 hex digests.' }, 400)
    if (parsed.data.status === 'review_required' && observedSignerSha256.length === 0) {
      return c.json({ error: 'Signer review requires at least one observed signer.' }, 400)
    }

    const revision = await database.reportJob({
      jobId: job.id,
      deviceId: device.id,
      status: parsed.data.status as JobSummary['status'],
      installedVersionCode: parsed.data.installedVersionCode ?? null,
      observedSignerSha256,
      message: parsed.data.message ?? null,
      now: clock().toISOString(),
    })
    return revision === null ? c.json({ error: 'Job report was not accepted.' }, 409) : c.json({ ok: true, revision })
  })

  app.notFound((c) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return c.json({ error: 'Not found.' }, 404)
    return c.notFound()
  })

  app.onError((error, c) => {
    if (error instanceof PasswordBusyError) {
      c.header('Retry-After', '3')
      return c.json({ error: 'Sign-in is busy. Try again in a few seconds.' }, 503)
    }
    console.error('Borealis request failed.', error instanceof Error ? error.name : 'UnknownError')
    return c.json({ error: 'Borealis could not complete that request.' }, 500)
  })

  return app
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]?.trim() ?? null
}

function pairingSummary(pairing: PairingSummary): PairingSummary {
  return {
    id: pairing.id,
    userCode: pairing.userCode,
    deviceLabel: pairing.deviceLabel,
    state: pairing.state,
    expiresAt: pairing.expiresAt,
    createdAt: pairing.createdAt,
  }
}

function rateLimited(c: Context, retryAfterSeconds: number): Response {
  c.header('Retry-After', String(retryAfterSeconds))
  return c.json({ error: 'Too many attempts. Try again later.' }, 429)
}

function normalizeSigner(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined || value.trim() === '') return null
  const normalized = value.replace(/:/g, '').trim().toLowerCase()
  return SHA256_PATTERN.test(normalized) ? normalized : undefined
}

function normalizeSignerList(values: string[]): string[] | null {
  const normalized: string[] = []
  for (const value of values) {
    const signer = normalizeSigner(value)
    if (!signer) return null
    if (!normalized.includes(signer)) normalized.push(signer)
  }
  return normalized
}

async function parseJson<T extends z.ZodType>(
  c: Context,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: Response }> {
  try {
    const body: unknown = await c.req.json()
    const parsed = schema.safeParse(body)
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, response: c.json({ error: firstZodMessage(parsed.error) }, 400) }
  } catch {
    return { ok: false, response: c.json({ error: 'A valid JSON request body is required.' }, 400) }
  }
}

function validationError(c: Context, error: ZodError): Response {
  return c.json({ error: firstZodMessage(error) }, 400)
}

function firstZodMessage(error: ZodError): string {
  return error.issues[0]?.message ?? 'Request validation failed.'
}
