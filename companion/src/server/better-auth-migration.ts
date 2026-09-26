import type { Transaction } from '@libsql/client'

// Better Auth 1.7.6's core schema plus the username plugin. Kysely's SQLite
// adapter writes ISO-8601 strings into DATE columns and integers for booleans.
// Keep these tables separate from Borealis's account/device ownership schema.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ba_user (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    emailVerified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    createdAt DATE NOT NULL,
    updatedAt DATE NOT NULL,
    username TEXT UNIQUE,
    displayUsername TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ba_session (
    id TEXT PRIMARY KEY NOT NULL,
    expiresAt DATE NOT NULL,
    token TEXT NOT NULL UNIQUE,
    createdAt DATE NOT NULL,
    updatedAt DATE NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    userId TEXT NOT NULL REFERENCES ba_user(id) ON DELETE CASCADE
  )`,
  'CREATE INDEX IF NOT EXISTS ba_session_userId_idx ON ba_session(userId)',
  'CREATE INDEX IF NOT EXISTS ba_session_expiresAt_idx ON ba_session(expiresAt)',
  `CREATE TABLE IF NOT EXISTS ba_account (
    id TEXT PRIMARY KEY NOT NULL,
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    userId TEXT NOT NULL REFERENCES ba_user(id) ON DELETE CASCADE,
    accessToken TEXT,
    refreshToken TEXT,
    idToken TEXT,
    accessTokenExpiresAt DATE,
    refreshTokenExpiresAt DATE,
    scope TEXT,
    password TEXT,
    createdAt DATE NOT NULL,
    updatedAt DATE NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS ba_account_userId_idx ON ba_account(userId)',
  `CREATE TABLE IF NOT EXISTS ba_verification (
    id TEXT PRIMARY KEY NOT NULL,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt DATE NOT NULL,
    createdAt DATE NOT NULL,
    updatedAt DATE NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS ba_verification_identifier_idx ON ba_verification(identifier)',
]

// A per-account marker prevents subsequent schema migrations from restoring an
// old password or a deleted Better Auth user from the retained legacy tables.
const UNMIGRATED = `a.password_hash != 'better-auth-managed' AND NOT EXISTS (
  SELECT 1 FROM service_metadata
  WHERE key = 'better_auth_legacy_account:' || a.id
)`

/** Called inside BorealisDatabase's serialized write transaction. */
export async function migrateBetterAuth(tx: Pick<Transaction, 'execute'>): Promise<void> {
  for (const sql of SCHEMA) await tx.execute(sql)

  const conflicts = await tx.execute(`SELECT a.id FROM accounts a
    JOIN ba_user u ON u.id = a.id
    WHERE ${UNMIGRATED} AND (u.username IS NULL OR u.username != lower(a.username))
    LIMIT 1`)
  if (conflicts.rows.length) throw new Error('Better Auth migration found a conflicting account identity.')

  await tx.execute(`INSERT INTO ba_user
    (id, name, email, emailVerified, createdAt, updatedAt, username, displayUsername)
    SELECT a.id, a.username, lower(a.username) || '@users.borealis.invalid', 0,
      a.created_at, a.created_at, lower(a.username), a.username
    FROM accounts a WHERE ${UNMIGRATED}
      AND NOT EXISTS (SELECT 1 FROM ba_user u WHERE u.id = a.id)`)

  // Do not decode, normalize, rehash, or replace the old verifier. The configured
  // legacy verifier callback reads this exact format until a password is changed.
  await tx.execute(`INSERT INTO ba_account
    (id, accountId, providerId, userId, password, createdAt, updatedAt)
    SELECT 'borealis-legacy:' || a.id, a.id, 'credential', a.id,
      a.password_hash, a.created_at, a.created_at
    FROM accounts a WHERE ${UNMIGRATED}
      AND NOT EXISTS (
        SELECT 1 FROM ba_account c WHERE c.userId = a.id AND c.providerId = 'credential'
      )`)

  await tx.execute(`INSERT INTO service_metadata (key, value)
    SELECT 'better_auth_legacy_account:' || a.id, '1'
    FROM accounts a WHERE ${UNMIGRATED}`)

  // Existing account_sessions contain digests, not Better Auth session tokens.
  // Leave them intact for rollback; the new auth handlers do not accept them.
}
