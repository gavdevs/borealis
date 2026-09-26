import { z } from 'zod'

const environmentSchema = z.object({
  BOREALIS_ADMIN_TOKEN: z.string().min(24),
  BOREALIS_DATABASE_PATH: z.string().min(1).default('./data/borealis.sqlite'),
  BOREALIS_PUBLIC_BASE_URL: z.url().default('http://localhost:8787'),
  BOREALIS_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  BOREALIS_PAIRING_TTL_MINUTES: z.coerce.number().int().min(2).max(60).default(10),
  BOREALIS_JOB_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  BOREALIS_PLAY_LANGUAGE: z.string().regex(/^[a-z]{2}$/).default('en'),
  BOREALIS_PLAY_COUNTRY: z.string().regex(/^[a-z]{2}$/).default('us'),
})

export type BorealisConfig = {
  adminToken: string
  databasePath: string
  publicBaseUrl: string
  port: number
  pairingTtlMinutes: number
  jobTtlSeconds: number
  playLanguage: string
  playCountry: string
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BorealisConfig {
  const parsed = environmentSchema.parse(environment)
  return {
    adminToken: parsed.BOREALIS_ADMIN_TOKEN,
    databasePath: parsed.BOREALIS_DATABASE_PATH,
    publicBaseUrl: parsed.BOREALIS_PUBLIC_BASE_URL.replace(/\/$/, ''),
    port: parsed.BOREALIS_PORT,
    pairingTtlMinutes: parsed.BOREALIS_PAIRING_TTL_MINUTES,
    jobTtlSeconds: parsed.BOREALIS_JOB_TTL_SECONDS,
    playLanguage: parsed.BOREALIS_PLAY_LANGUAGE,
    playCountry: parsed.BOREALIS_PLAY_COUNTRY,
  }
}
