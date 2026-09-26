import { describe, expect, it } from 'vitest'
import { DUMMY_PASSWORD_HASH, hashPassword, PasswordBusyError, verifyPassword } from './passwords.js'

describe('password hashing', () => {
  it('uses a random salt and verifies without trimming or truncating the password', async () => {
    const password = '  long passphrase with spaces 🌲  '
    const first = await hashPassword(password)
    const second = await hashPassword(password)
    expect(first).toMatch(/^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}$/)
    expect(first).not.toBe(second)
    expect(first).not.toContain(password)
    expect(await verifyPassword(password, first)).toBe(true)
    expect(await verifyPassword(password.trim(), first)).toBe(false)
    expect(await verifyPassword(`${password}x`, first)).toBe(false)
  })

  it('rejects invalid encodings and dummy unknown-user hashes', async () => {
    expect(await verifyPassword('any password value', 'malformed')).toBe(false)
    expect(await verifyPassword('any password value', DUMMY_PASSWORD_HASH)).toBe(false)
  })

  it('preserves identical hash strength and encoding across Node and Worker paths', async () => {
    const password = 'An unchanged long passphrase 🌲'
    const nodeHash = await hashPassword(password)
    expect(await verifyPassword(password, nodeHash, 'worker')).toBe(true)
    const workerHash = await hashPassword(password, 'worker')
    expect(workerHash).toMatch(/^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}$/)
    expect(await verifyPassword(password, workerHash)).toBe(true)
    expect(await verifyPassword('wrong password', workerHash, 'worker')).toBe(false)
  })

  it('bounds Node work to one active derivation plus four waiting jobs and recovers after overload', async () => {
    const attempts = Array.from({ length: 6 }, () => hashPassword('A queued long passphrase'))
    const results = await Promise.allSettled(attempts)
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5)
    const failures = results.filter((result) => result.status === 'rejected')
    expect(failures).toHaveLength(1)
    expect(failures[0]!.reason).toBeInstanceOf(PasswordBusyError)
    await expect(hashPassword('A later long passphrase')).resolves.toMatch(/^scrypt\$32768\$8\$3\$/)
  })
})
