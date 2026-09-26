import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'

// OWASP's 32 MiB scrypt configuration. Keep one KDF active at a time on the
// low-memory Node host, with a bounded queue instead of unbounded allocation.
const PARAMETERS = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }
const PREFIX = 'scrypt$32768$8$3'
export const DUMMY_PASSWORD_HASH = `${PREFIX}$${'0'.repeat(32)}$${'0'.repeat(128)}`
export type PasswordRuntime = 'node' | 'worker'
let active = false
const waiting: Array<() => void> = []

export class PasswordBusyError extends Error {}

async function derive(password: string, salt: Buffer, runtime: PasswordRuntime): Promise<Buffer> {
  // Workerd's callback scrypt also performs its CPU work synchronously. Use the
  // explicit sync API there, retaining the exact hash parameters without a
  // shared queue of promises tied to other requests' lifetimes. This requires a
  // Workers Paid CPU budget; the Free plan's 10 ms is not suitable for this KDF.
  // https://github.com/cloudflare/workerd/blob/main/src/node/internal/crypto_scrypt.ts
  if (runtime === 'worker') return scryptSync(password, salt, 64, PARAMETERS)

  if (active) {
    if (waiting.length >= 4) throw new PasswordBusyError('Password verification is busy. Try again shortly.')
    await new Promise<void>((resolve) => waiting.push(resolve))
  } else active = true
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, PARAMETERS, (error, key) => error ? reject(error) : resolve(key))
    })
  } finally {
    const next = waiting.shift()
    if (next) next()
    else active = false
  }
}

export async function hashPassword(password: string, runtime: PasswordRuntime = 'node'): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, runtime)
  return `${PREFIX}$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyPassword(password: string, encoded: string, runtime: PasswordRuntime = 'node'): Promise<boolean> {
  const valid = /^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(encoded)
  const parts = (valid ? encoded : DUMMY_PASSWORD_HASH).split('$')
  const candidate = await derive(password, Buffer.from(parts[4]!, 'hex'), runtime)
  return timingSafeEqual(candidate, Buffer.from(parts[5]!, 'hex')) && valid
}
