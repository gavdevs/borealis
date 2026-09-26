export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 128
export const PASSWORD_MAX_CODE_UNITS = PASSWORD_MAX_LENGTH * 2

export function passwordLength(value: string): number {
  return Array.from(value).length
}

export function passwordValidationError(value: string): string | null {
  const length = passwordLength(value)
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH
    ? null
    : `Use a password or passphrase with ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters (received ${length}).`
}
