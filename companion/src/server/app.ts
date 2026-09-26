import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import { z, ZodError } from 'zod'
import type {
  AllowlistItem,
  InstallJobPayload,
  JobSummary,
  PairingSummary,
  PlaySearchResult,
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

const API = '/api/borealis/v1'
const DEVICE_BEARER_PATTERN = /^brl_device_[A-Za-z0-9_-]{43}$/
const POLL_SECRET_PATTERN = /^brl_poll_[A-Za-z0-9_-]{43}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/

const pairingBodySchema = z.object({
  deviceLabel: z.string().trim().min(1).max(64),
  deviceBearerDigest: z.string().regex(SHA256_PATTERN),
}).strict()

const allowlistBodySchema = z.object({
  packageName: z.string().trim().regex(PACKAGE_PATTERN),
  displayName: z.string().trim().min(1).max(100),
  publisher: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(4).max(500),
  signerSha256: z.string().trim().max(128).nullable().optional(),
}).strict()

const allowlistUpdateBodySchema = allowlistBodySchema.omit({ packageName: true })
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
    curatorAuth,
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
  app.use(`${API}/admin/*`, browserMutationGuard)
  app.use(`${API}/admin/*`, accountAuth)
  app.use(`${API}/admin/*`, curatorAuth)
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
      const account = c.get('account')
      const results = account.role === 'curator'
        ? await playSearch.search(parsed.data.q, parsed.data.limit)
        : (await database.listAllowlist())
          .filter((item) => allowlistMatches(item, parsed.data.q))
          .slice(0, parsed.data.limit)
          .map(mapPlaySearchResult)
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

  app.get(`${API}/admin/allowlist`, async (c) => c.json({ items: await database.listAllowlist() }))

  app.post(`${API}/admin/allowlist`, async (c) => {
    const parsed = await parseJson(c, allowlistBodySchema)
    if (!parsed.ok) return parsed.response
    const signerSha256 = normalizeSigner(parsed.data.signerSha256)
    if (signerSha256 === undefined) return c.json({ error: 'Signer SHA-256 must contain exactly 64 hexadecimal characters.' }, 400)

    const item = await database.createAllowlist({
      packageName: parsed.data.packageName,
      displayName: parsed.data.displayName,
      publisher: parsed.data.publisher,
      reason: parsed.data.reason,
      signerSha256,
    }, clock().toISOString())
    if (!item) return c.json({ error: 'That package is already on the allowlist.' }, 409)
    return c.json({ item }, 201)
  })

  app.get(`${API}/admin/allowlist/:packageName`, async (c) => {
    const item = await database.getAllowlist(c.req.param('packageName'))
    return item ? c.json({ item }) : c.json({ error: 'Allowlisted package not found.' }, 404)
  })

  app.put(`${API}/admin/allowlist/:packageName`, async (c) => {
    const packageName = c.req.param('packageName')
    if (!PACKAGE_PATTERN.test(packageName)) return c.json({ error: 'Invalid package name.' }, 400)
    const parsed = await parseJson(c, allowlistUpdateBodySchema)
    if (!parsed.ok) return parsed.response
    const signerSha256 = normalizeSigner(parsed.data.signerSha256)
    if (signerSha256 === undefined) return c.json({ error: 'Signer SHA-256 must contain exactly 64 hexadecimal characters.' }, 400)

    const item = await database.updateAllowlist(packageName, {
      displayName: parsed.data.displayName,
      publisher: parsed.data.publisher,
      reason: parsed.data.reason,
      signerSha256,
    }, clock().toISOString())
    return item ? c.json({ item }) : c.json({ error: 'Allowlisted package not found.' }, 404)
  })

  app.delete(`${API}/admin/allowlist/:packageName`, async (c) => {
    const deleted = await database.deleteAllowlist(c.req.param('packageName'), clock().toISOString())
    return deleted ? c.json({ ok: true }) : c.json({ error: 'Allowlisted package not found.' }, 404)
  })

  app.get(`${API}/me/apps`, async (c) => {
    return c.json({ items: await database.listAccountApps(c.get('account').id) })
  })

  app.post(`${API}/me/apps`, async (c) => {
    const parsed = await parseJson(c, assignmentBodySchema)
    if (!parsed.ok) return parsed.response
    const item = await database.addAccountApp(c.get('account').id, parsed.data.packageName, clock().toISOString())
    return item ? c.json({ item }, 201) : c.json({ error: 'Allowlisted package not found.' }, 404)
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

  app.get(`${API}/me/devices/:deviceId/assignments`, async (c) => {
    const device = await database.getDevice(c.req.param('deviceId'), c.get('account').id)
    if (!device) return c.json({ error: 'Device not found.' }, 404)
    const allowed = new Map((await database.listAllowlist()).map((item) => [item.packageName, item]))
    return c.json({
      assignments: device.assignments.flatMap((packageName) => {
        const item = allowed.get(packageName)
        return item ? [item] : []
      }),
    })
  })

  app.post(`${API}/me/devices/:deviceId/assignments`, async (c) => {
    const parsed = await parseJson(c, assignmentBodySchema)
    if (!parsed.ok) return parsed.response
    const result = await database.assignPackage(
      c.req.param('deviceId'),
      parsed.data.packageName,
      clock().toISOString(),
      c.get('account').id,
    )
    if (!result) return c.json({ error: 'Device or allowlisted package not found.' }, 404)
    return c.json(result, result.created ? 201 : 200)
  })

  app.delete(`${API}/me/devices/:deviceId/assignments/:packageName`, async (c) => {
    const removed = await database.removeAssignment(
      c.req.param('deviceId'),
      c.req.param('packageName'),
      clock().toISOString(),
      c.get('account').id,
    )
    return removed ? c.json({ ok: true }) : c.json({ error: 'Assignment not found.' }, 404)
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
    const job = await database.queueJob(
      device.id,
      parsed.data.packageName,
      randomUUID(),
      clock().toISOString(),
      owner,
    )
    return job ? c.json({ job }, 201) : c.json({ error: 'Assign this allowlisted package to the device before queuing it.' }, 409)
  })

  app.get(`${API}/device/sync`, async (c) => {
    const device = c.get('device')
    const now = clock()
    const jobs = (await database.listSyncJobs(device.id, now.toISOString())).map((job): SignedJobEnvelope => {
      const issuedAt = now.toISOString()
      const expiresAt = new Date(now.getTime() + config.jobTtlSeconds * 1_000).toISOString()
      const payload: InstallJobPayload = {
        schemaVersion: 1,
        jobId: job.id,
        deviceId: device.id,
        action: 'install_or_update',
        packageName: job.packageName,
        displayName: job.displayName,
        acceptedSignerSha256: job.acceptedSignerSha256,
        issuedAt,
        expiresAt,
        nonce: randomNonce(),
      }
      const exactPayload = JSON.stringify(payload)
      return {
        keyId: signingKey.keyId,
        payload: exactPayload,
        signature: signPayload(exactPayload, privateSigningKey),
      }
    })
    const refreshed = (await database.getDevice(device.id)) ?? device
    return c.json({
      deviceId: refreshed.id,
      deviceLabel: refreshed.label,
      revision: refreshed.revision,
      serverTime: now.toISOString(),
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
    const acceptedSigners = await database.getJobAcceptedSigners(job.id)
    if (parsed.data.status === 'review_required' && observedSignerSha256.length === 0) {
      return c.json({ error: 'Signer review requires at least one observed signer.' }, 400)
    }
    if (parsed.data.status === 'review_required' && acceptedSigners.length > 0) {
      return c.json({ error: 'This job already has an approved signer pin; report a verification failure instead.' }, 409)
    }
    if (['awaiting_user_action', 'succeeded'].includes(parsed.data.status) && acceptedSigners.length === 0) {
      return c.json({ error: 'A signer must be reviewed and pinned before installation.' }, 409)
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

function allowlistMatches(item: AllowlistItem, query: string): boolean {
  const needle = query.toLocaleLowerCase()
  return [item.packageName, item.displayName, item.publisher]
    .some((value) => value.toLocaleLowerCase().includes(needle))
}

function mapPlaySearchResult(item: AllowlistItem): PlaySearchResult {
  return {
    packageName: item.packageName,
    displayName: item.displayName,
    publisher: item.publisher,
    detailUrl: `https://play.google.com/store/apps/details?id=${encodeURIComponent(item.packageName)}`,
  }
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
