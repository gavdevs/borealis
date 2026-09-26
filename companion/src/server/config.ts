import { z } from 'zod'

const tursoUrlSchema = z.url().refine((value) => {
  const url = new URL(value)
  return ['libsql:', 'https:'].includes(url.protocol) && Boolean(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash
}, 'TURSO_DATABASE_URL must use libsql:// or https:// with a host and no credentials, query, or fragment')

const environmentSchema = z.object({
  BOREALIS_ADMIN_TOKEN: z.string().min(24),
  BOREALIS_DATABASE_PATH: z.string().min(1).default('./data/borealis.sqlite'),
  TURSO_DATABASE_URL: tursoUrlSchema.optional(),
  TURSO_AUTH_TOKEN: z.string().trim().min(1).optional(),
  BOREALIS_PUBLIC_BASE_URL: z.url().refine((value) => {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  }, 'Use HTTPS for the companion, or HTTP on loopback for local development.').default('http://localhost:8787'),
  BOREALIS_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  BOREALIS_HOST: z.string().trim().min(1).default('127.0.0.1'),
  BOREALIS_PAIRING_TTL_MINUTES: z.coerce.number().int().min(2).max(60).default(10),
  BOREALIS_JOB_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  BOREALIS_PLAY_LANGUAGE: z.string().regex(/^[a-z]{2}$/).default('en'),
  BOREALIS_PLAY_COUNTRY: z.string().regex(/^[a-z]{2}$/).default('us'),
}).superRefine((environment, context) => {
  if (Boolean(environment.TURSO_DATABASE_URL) !== Boolean(environment.TURSO_AUTH_TOKEN)) {
    context.addIssue({ code: 'custom', message: 'Set both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, or neither for local SQLite.' })
  }
})

const migrationEnvironmentSchema = z.object({
  TURSO_DATABASE_URL: tursoUrlSchema,
  TURSO_AUTH_TOKEN: z.string().trim().min(1),
})

export type BorealisConfig = {
  adminToken: string
  databasePath: string
  tursoDatabaseUrl?: string
  tursoAuthToken?: string
  publicBaseUrl: string
  port: number
  host?: string
  pairingTtlMinutes: number
  jobTtlSeconds: number
  playLanguage: string
  playCountry: string
}

export type TursoConfig = {
  tursoDatabaseUrl: string
  tursoAuthToken: string
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BorealisConfig {
  return parseConfig(environment)
}

export function loadWorkerConfig(environment: unknown): BorealisConfig & TursoConfig {
  const config = parseConfig(environment)
  if (!config.tursoDatabaseUrl || !config.tursoAuthToken) {
    throw new Error('The Worker requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.')
  }
  if (new URL(config.publicBaseUrl).protocol !== 'https:') {
    throw new Error('The Worker requires an HTTPS BOREALIS_PUBLIC_BASE_URL.')
  }
  return { ...config, tursoDatabaseUrl: config.tursoDatabaseUrl, tursoAuthToken: config.tursoAuthToken }
}

export function loadTursoConfig(environment: unknown): TursoConfig {
  const parsed = migrationEnvironmentSchema.parse(environment)
  return {
    tursoDatabaseUrl: parsed.TURSO_DATABASE_URL,
    tursoAuthToken: parsed.TURSO_AUTH_TOKEN,
  }
}

function parseConfig(environment: unknown): BorealisConfig {
  const parsed = environmentSchema.parse(environment)
  return {
    adminToken: parsed.BOREALIS_ADMIN_TOKEN,
    databasePath: parsed.BOREALIS_DATABASE_PATH,
    ...(parsed.TURSO_DATABASE_URL ? { tursoDatabaseUrl: parsed.TURSO_DATABASE_URL } : {}),
    ...(parsed.TURSO_AUTH_TOKEN ? { tursoAuthToken: parsed.TURSO_AUTH_TOKEN } : {}),
    publicBaseUrl: parsed.BOREALIS_PUBLIC_BASE_URL.replace(/\/$/, ''),
    port: parsed.BOREALIS_PORT,
    host: parsed.BOREALIS_HOST,
    pairingTtlMinutes: parsed.BOREALIS_PAIRING_TTL_MINUTES,
    jobTtlSeconds: parsed.BOREALIS_JOB_TTL_SECONDS,
    playLanguage: parsed.BOREALIS_PLAY_LANGUAGE,
    playCountry: parsed.BOREALIS_PLAY_COUNTRY,
  }
}
