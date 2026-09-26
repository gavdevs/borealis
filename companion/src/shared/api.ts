export type AllowlistItem = {
  packageName: string
  displayName: string
  publisher: string
  reason: string
  signerSha256: string | null
  createdAt: string
  updatedAt: string
}

export type DeviceSummary = {
  id: string
  label: string
  revision: number
  createdAt: string
  activatedAt: string | null
  lastSeenAt: string | null
  revokedAt: string | null
  assignments: string[]
}

export type PairingSummary = {
  id: string
  userCode: string
  deviceLabel: string
  state: 'pending' | 'approved' | 'activated' | 'expired'
  expiresAt: string
  createdAt: string
}

export type JobSummary = {
  id: string
  deviceId: string
  packageName: string
  displayName: string
  action: 'install_or_update'
  status: 'queued' | 'delivered' | 'installing' | 'awaiting_user_action' | 'review_required' | 'succeeded' | 'failed' | 'cancelled'
  createdAt: string
  deliveredAt: string | null
  completedAt: string | null
  installedVersionCode: number | null
  observedSignerSha256: string[]
  message: string | null
}

export type PlaySearchResult = {
  packageName: string
  displayName: string
  publisher: string
  iconUrl?: string
  detailUrl: string
}

export type SignedJobEnvelope = {
  keyId: string
  payload: string
  signature: string
}

export type InstallJobPayload = {
  schemaVersion: 1
  jobId: string
  deviceId: string
  action: 'install_or_update'
  packageName: string
  displayName: string
  acceptedSignerSha256: string[]
  issuedAt: string
  expiresAt: string
  nonce: string
}
