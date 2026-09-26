import type { AccountSummary, DeviceSummary } from '../shared/api.js'

export type BorealisVariables = {
  account: AccountSummary
  sessionDigest: string
  device: DeviceSummary
}
