import { closeSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Versioned Worker secret upload. This file never enters the workspace/artifacts.
for (const name of ['RUNNER_TEMP', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'BOREALIS_ADMIN_TOKEN', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']) {
  if (!process.env[name]?.trim()) throw new Error(`${name} must be configured before production deployment`)
}
const values = Object.fromEntries(['BOREALIS_ADMIN_TOKEN', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'].map((name) => [name, process.env[name]]))
const descriptor = openSync(join(process.env.RUNNER_TEMP, 'borealis-worker-secrets.json'), 'wx', 0o600)
try { writeFileSync(descriptor, JSON.stringify(values)) } finally { closeSync(descriptor) }
console.log('Production settings validated; private Worker secrets file prepared.')
