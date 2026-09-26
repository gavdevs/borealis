import { createHmac } from 'node:crypto'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { betterAuth } from 'better-auth'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { username } from 'better-auth/plugins/username'
import type { BorealisConfig } from './config.js'
import type { BorealisDatabase } from './db.js'
import { verifyPassword as verifyLegacyPassword, type PasswordRuntime } from './passwords.js'

export const AUTH_BASE_PATH = '/api/borealis/v1/auth'

// Better Auth requires an email-shaped unique identifier. These reserved,
// non-deliverable aliases are internal only: Borealis never requests an email,
// sends mail, or exposes email-based sign-in, recovery, or account linking.
export function internalAuthEmail(username: string): string {
  return `${username}@users.borealis.invalid`
}

export function createAccountAuth(config: BorealisConfig, database: BorealisDatabase, runtime: PasswordRuntime = 'node') {
  const publicUrl = new URL(config.publicBaseUrl)
  const secure = publicUrl.protocol === 'https:'
  const trustedOrigins = [publicUrl.origin]
  if (!secure && ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)) {
    for (const host of ['localhost', '127.0.0.1']) {
      for (const port of [config.port, 5173]) trustedOrigins.push(`http://${host}:${port}`)
    }
  }
  return betterAuth({
    appName: 'Borealis',
    baseURL: config.publicBaseUrl,
    basePath: AUTH_BASE_PATH,
    // Domain-separated from the existing private bootstrap token. Rotating that
    // token also invalidates browser cookies; password hashes/phone keys survive.
    secret: createHmac('sha256', config.adminToken).update('borealis:better-auth:session:v1').digest('base64url'),
    database: { dialect: new LibsqlDialect({ client: database.client }), type: 'sqlite', transaction: true },
    trustedOrigins,
    user: { modelName: 'ba_user', changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    account: { modelName: 'ba_account', accountLinking: { enabled: false } },
    verification: { modelName: 'ba_verification' },
    session: {
      modelName: 'ba_session',
      expiresIn: 30 * 24 * 60 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 15,
      maxPasswordLength: 256,
      password: {
        hash: hashPassword,
        // Existing accounts keep their original salted hashes. New passwords
        // use Better Auth's maintained implementation and encoding.
        verify: ({ hash, password }) => hash.startsWith('scrypt$')
          ? verifyLegacyPassword(password, hash, runtime)
          : verifyPassword({ hash, password }),
      },
    },
    plugins: [username({
      minUsernameLength: 3,
      maxUsernameLength: 32,
      usernameValidator: (value) => /^[a-z0-9_]{3,32}$/.test(value),
      usernameNormalization: (value) => value.trim().toLowerCase(),
      immutableUsername: true,
    })],
    // Public routes below retain durable per-IP/per-username Turso limits and
    // the Worker additionally applies its edge rate-limit binding.
    rateLimit: { enabled: false },
    advanced: {
      // Supply the __Host- prefix ourselves, without a second __Secure- prefix.
      useSecureCookies: false,
      cookiePrefix: 'borealis',
      cookies: { session_token: { name: secure ? '__Host-borealis_session' : 'borealis_session' } },
      defaultCookieAttributes: { secure, httpOnly: true, sameSite: 'strict', path: '/' },
      database: { generateId: 'uuid' },
    },
    logger: { disabled: true },
  })
}
