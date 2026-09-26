import { describe, expect, it } from 'vitest'
import {
  PASSWORD_MAX_CODE_UNITS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordLength,
  passwordValidationError,
} from './password-policy.js'

describe('shared password policy', () => {
  it('declares a 12–128 code-point range with enough code units for astral characters', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12)
    expect(PASSWORD_MAX_LENGTH).toBe(128)
    expect(PASSWORD_MAX_CODE_UNITS).toBe(256)
  })

  it.each([
    { length: 11, valid: false },
    { length: 12, valid: true },
    { length: 16, valid: true },
    { length: 128, valid: true },
    { length: 129, valid: false },
  ])('validates an ASCII password of $length characters', ({ length, valid }) => {
    const password = 'a'.repeat(length)
    expect(passwordLength(password)).toBe(length)
    expect(passwordValidationError(password)).toBe(valid
      ? null
      : `Use a password or passphrase with 12–128 characters (received ${length}).`)
  })

  it('accepts 12 astral characters and counts each as one character', () => {
    const password = '🌲'.repeat(12)
    expect(password.length).toBe(24)
    expect(passwordLength(password)).toBe(12)
    expect(passwordValidationError(password)).toBeNull()
  })

  it('reports eight astral characters as eight rather than sixteen code units', () => {
    const password = '🌲'.repeat(8)
    expect(password.length).toBe(16)
    expect(passwordLength(password)).toBe(8)
    expect(passwordValidationError(password)).toBe('Use a password or passphrase with 12–128 characters (received 8).')
  })

  it('counts leading and trailing whitespace without trimming the password', () => {
    const password = ' 1234567890 '
    expect(passwordLength(password)).toBe(12)
    expect(passwordValidationError(password)).toBeNull()
    expect(passwordLength(password.trim())).toBe(10)
    expect(passwordValidationError(password.trim())).toBe('Use a password or passphrase with 12–128 characters (received 10).')
  })
})
