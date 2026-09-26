# Borealis architecture

## Product boundary

Borealis is a curated remote installer/updater. The browser owns discovery and policy; the phone owns Play authentication, device-specific delivery, verification, and installation. There is deliberately no search box, arbitrary package field, repository URL, or policy override on the phone.

```text
Companion search -> positive approval -> device assignment
                                      -> signed short-lived job
Phone verifies job -> direct Play download -> base + splits verification
                                           -> atomic PackageInstaller session
                                           -> result report
```

The companion never receives Google credentials and never proxies or stores APK bytes.

## Shared accounts

People sign up and sign in using a username and password, without supplying an
email. Better Auth 1.7.6 owns password hashing/verification and browser sessions;
Borealis retains its account-scoped authorization, curated catalog, and durable
request limits. The library's required email-shaped identifier is the internal,
non-deliverable alias `username@users.borealis.invalid`. No email is sent, and
email-based login, recovery, and account linking are not exposed.

New passwords use Better Auth's maintained scrypt implementation. The additive
migration copies existing verifiers unchanged into `ba_account`; a compatibility
callback verifies their original parameters and password encoding. Better Auth
user IDs match existing Borealis account IDs, preserving roles, phone/app ownership,
and the persisted signing key. New domain account rows hold `better-auth-managed`
instead of a password hash; their credentials belong to Better Auth.

Opaque browser session tokens are stored in `ba_session`, not as digests, and
are carried in signed HttpOnly/SameSite=Strict cookies (Secure on HTTPS). Sessions
expire after 30 days. Legacy session digests are not migrated, so existing browsers
must sign in again. Profile password changes require the current password and
invalidate old browser sessions. No forgotten-password recovery flow is implemented.

Better Auth's signing secret is a domain-separated HMAC derived from the stable
`BOREALIS_ADMIN_TOKEN`; no new environment secret is required. Rotating that token
invalidates browser cookies but leaves password hashes, phone credentials, and
the job-signing identity intact. Back up the database and private configuration.

The production migration was applied on 2026-09-26 after a private backup;
domain records and signing-key bytes were verified unchanged. Wrangler deployment
to Workers Free and the hosted HTTPS account/pairing/signed-job checks passed,
without a CPU override or billing change. Legacy-password signin is locally tested
but not production-verified; physical phone installation remains unverified.
See the [deployment runbook](deployment.md) for the remaining checks.

The shared catalog is curator-managed. Each member's chosen apps, phones,
assignments, and job history are scoped to that account. Phone pairing is
claimed atomically by entering the exact short-lived code, never by listing
other people's pending requests. The phone continues using its independent
device credential, not the browser username or password.

One-time, setup-token-protected curator creation claims pre-account data;
public signup can never claim it or grant curator privileges. Ownership and
bootstrap metadata are part of the database backup, alongside the signing key.

## Trust model

- A package must appear in the companion's positive allowlist before it can be assigned.
- Pairing creates a high-entropy device bearer; the server stores only its SHA-256 digest.
- The companion signs the exact job payload with a persisted Ed25519 key.
- The phone stores the paired signing public key and verifies the raw payload bytes before decoding or acting on a job.
- Jobs are bound to one device, expire quickly, carry a nonce, and name exactly one package.
- The phone validates the downloaded base package, version, complete split set, per-file size and SHA-256, and accepted publisher signer before committing one atomic install session.
- A missing signer pin is a review state, not an automatic approval.

This model protects Borealis's own path. It does not prevent installation through ADB, another installer, a modified build, or LightOS developer settings.

## Update behavior

The phone schedules periodic sync as a fallback and can later use Light push as a wake hint. Android's confirmation UI is always supported. Borealis may request unattended updates only when Android allows the existing installer of record to do so; a required confirmation is not treated as a failure.

## Unsupported SDK lane

The adjacent Light SDK fork contributes a `package-install-request` capability, generated manifest permissions and result receiver, and an SDK-owned `LightPackageInstaller` facade. Consumer code remains within the Light SDK surface. This repository intentionally does not target the official hosted builder or Tool Library.
