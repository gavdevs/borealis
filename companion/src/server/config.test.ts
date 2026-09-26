import { describe, expect, it } from 'vitest'
import { loadConfig, loadTursoConfig, loadWorkerConfig } from './config.js'

const base = { BOREALIS_ADMIN_TOKEN: 'test-admin-token-that-is-long-enough' }
const remote = {
  TURSO_DATABASE_URL: 'libsql://borealis.example.turso.io',
  TURSO_AUTH_TOKEN: 'fixture-token',
}

describe('database configuration', () => {
  it('retains local SQLite when Turso is not configured', () => {
    expect(loadConfig(base)).toMatchObject({ databasePath: './data/borealis.sqlite', host: '127.0.0.1' })
    expect(loadConfig(base).tursoDatabaseUrl).toBeUndefined()
  })

  it('accepts a complete remote configuration', () => {
    expect(loadConfig({ ...base, ...remote }))
      .toMatchObject({ tursoDatabaseUrl: 'libsql://borealis.example.turso.io', tursoAuthToken: 'fixture-token' })
  })

  it('requires complete remote settings and HTTPS in the Worker runtime', () => {
    expect(loadWorkerConfig({
      ...base,
      ...remote,
      BOREALIS_PUBLIC_BASE_URL: 'https://borealis.loosewire.dev',
    })).toMatchObject({
      publicBaseUrl: 'https://borealis.loosewire.dev',
      tursoDatabaseUrl: remote.TURSO_DATABASE_URL,
      tursoAuthToken: remote.TURSO_AUTH_TOKEN,
    })
    expect(() => loadWorkerConfig({ ...base, BOREALIS_PUBLIC_BASE_URL: 'https://borealis.loosewire.dev' })).toThrow()
    expect(() => loadWorkerConfig({ ...base, ...remote, BOREALIS_PUBLIC_BASE_URL: 'http://127.0.0.1:8787' })).toThrow()
  })

  it('loads only the two remote settings needed by the deliberate migration command', () => {
    expect(loadTursoConfig(remote)).toEqual({
      tursoDatabaseUrl: remote.TURSO_DATABASE_URL,
      tursoAuthToken: remote.TURSO_AUTH_TOKEN,
    })
    expect(() => loadTursoConfig({ TURSO_DATABASE_URL: remote.TURSO_DATABASE_URL })).toThrow()
  })

  it('requires HTTPS outside loopback for account cookies', () => {
    expect(() => loadConfig({ ...base, BOREALIS_PUBLIC_BASE_URL: 'http://borealis.example' })).toThrow()
    expect(loadConfig({ ...base, BOREALIS_PUBLIC_BASE_URL: 'https://borealis.example' }).publicBaseUrl).toBe('https://borealis.example')
    expect(loadConfig({ ...base, BOREALIS_PUBLIC_BASE_URL: 'http://127.0.0.1:8787' }).publicBaseUrl).toBe('http://127.0.0.1:8787')
  })

  it.each([
    { TURSO_DATABASE_URL: 'libsql://borealis.example.turso.io' },
    { TURSO_AUTH_TOKEN: 'fixture-token' },
    { TURSO_DATABASE_URL: 'libsql://borealis.example.turso.io', TURSO_AUTH_TOKEN: '' },
    { TURSO_DATABASE_URL: 'http://borealis.example.turso.io', TURSO_AUTH_TOKEN: 'fixture-token' },
    { TURSO_DATABASE_URL: 'file:./local.sqlite', TURSO_AUTH_TOKEN: 'fixture-token' },
    { TURSO_DATABASE_URL: 'https://user:password@example.test', TURSO_AUTH_TOKEN: 'fixture-token' },
    { TURSO_DATABASE_URL: 'libsql://example.test:8080?tls=0', TURSO_AUTH_TOKEN: 'fixture-token' },
    { TURSO_DATABASE_URL: 'https://example.test?authToken=embedded-token', TURSO_AUTH_TOKEN: 'fixture-token' },
    { TURSO_DATABASE_URL: 'https://example.test#fragment', TURSO_AUTH_TOKEN: 'fixture-token' },
    { TURSO_DATABASE_URL: 'libsql:/missing-host', TURSO_AUTH_TOKEN: 'fixture-token' },
  ])('rejects incomplete or insecure remote settings instead of falling back', (settings) => {
    expect(() => loadConfig({ ...base, ...settings })).toThrow()
  })
})
