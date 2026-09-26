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

People sign up and sign in using a username and password, without email.
Passwords are salted scrypt hashes; opaque browser sessions are stored as
digests and expire after 30 days. Profile password changes require the current
password and invalidate old browser sessions. No forgotten-password recovery
flow is implemented.

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
