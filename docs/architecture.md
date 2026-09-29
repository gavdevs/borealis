# Borealis architecture

## Product boundary

Borealis is a personal-library installer/updater. The browser owns discovery and automatic app policy; the phone owns Play authentication, device-specific delivery, verification, and installation. There is deliberately no search box, arbitrary package field, repository URL, or policy override on the phone. There is no curator or shared publisher-approval workflow.

```text
Companion search -> add to personal library -> sync to paired phones
Phone Install/Update -> authorized signed short-lived job
Phone verifies job -> direct Play download -> base + splits verification
                                           -> atomic PackageInstaller session
                                           -> result report
```

The companion backend never receives readable Google credentials and never proxies or stores APK bytes.

## Phone-local Google sign-in

The phone now uses personal Play authentication instead of Aurora's shared anonymous
dispenser. A dedicated, fixed-origin Google account WebView supplies the account-setup
credential to GPlayAPI; the resulting reusable credential is stored only in an
Android Keystore-encrypted file excluded from backups. No Google password is stored.
The embedded WebView disables debugging, suppresses console logs, clears cookies/storage on
exit, and cannot become an arbitrary browser. Leaving the app cancels sign-in.

The SDK facade is an explicit `sdk-extension/client` overlay compiled into the
pinned, patched SDK client. It does not change official tool-policy restrictions,
LightOS, or the existing signed-job/pairing trust boundary. This is not supported
Google OAuth or an approved Light capability. Google may reject the embedded browser.

Personal Play requests use a nonlogging, HTTPS-only HTTP transport. In particular,
authentication form fields stay out of request URLs. Disconnect removes protected
credentials and invalidates Borealis's in-memory Play authentication; it is not a
Google-side token revocation.

Phone diagnostics use the `BorealisGoogle` log tag with fixed stage/outcome labels
and bounded numeric error/status codes. They distinguish screen lifecycle, WebView
page loading, account exchange, device check-in/configuration, Play authorization,
session validation, and protected storage. They never log account identifiers,
passwords, tokens, URLs, request/response bodies, or exception text. A successful
WebView page event means only that a page loaded, not that Play sign-in succeeded.

After pairing, users open `SIGN IN` and enter their Google credentials directly
on Google's page in Borealis so it can download and update library apps from
Google Play. No separately installed browser is required. Google account challenges
are handled on the phone; support for every challenge type is not established.
The companion's separate Borealis username/password login provides account access,
phone pairing, personal app selection, and install jobs.

The alpha.3 build completed authentication, secure storage, and credential reuse
on the physical LP3. MIKU downloaded and reached the former publisher-review gate.
Completed third-party installation/update remains unverified.

## Shared accounts

People sign up and sign in using a username and password, without supplying an
email. Better Auth 1.7.6 owns password hashing/verification and browser sessions;
Borealis retains its account-scoped authorization, personal libraries, and durable
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
but not production-verified; physical approved-app installation remains unverified.
See the [deployment runbook](deployment.md) for the remaining checks.

Each person's library, phones, and job history are scoped to that account.
Search and new additions resolve canonical Play metadata; there is no category
policy or exclusion list, and client-supplied categories cannot authorize an
app. Catalog search reads public Play web metadata over a Workers-compatible `fetch`.
It uses `redirect: 'manual'` with an explicit redirect rejection, because the
Workers runtime does not implement `redirect: 'error'`.
Phone pairing is
claimed atomically by entering the exact short-lived code, never by listing
other people's pending requests. The phone continues using its independent
device credential, not the browser username or password.

Public signup creates an ordinary account. Legacy role, allowlist, assignment,
and bootstrap storage can remain for non-destructive compatibility; they do not
grant a shared approval workflow. Existing ownership and signing keys are preserved.

The only usage signal is the running count of accounts ever created, served to
the operator role and hidden from members. No events, analytics, or per-person
data exist anywhere in the app.

## Trust model

- A package must belong to the paired account's personal library before the service issues its install job.
- Pairing creates a high-entropy device bearer; the server stores only its SHA-256 digest.
- The companion signs the exact job payload with a persisted Ed25519 key.
- The phone stores the paired signing public key and verifies the raw payload bytes before decoding or acting on a job.
- Jobs are bound to one device, expire quickly, carry a nonce, and name exactly one package.
- The phone validates package/version identity, the complete split set, and Play-provided file sizes/checksums before committing one atomic install session.
- First installation trusts authenticated Google Play delivery and Android's APK signature validation, without an operator certificate pin. Updates additionally compare the installed and downloaded signing histories; Android remains the final signature/rotation authority.
- The optional signer field remains readable for protocol compatibility; personal-library jobs do not require a global publisher pin. This deliberately removes independent pre-install publisher approval, not package-integrity verification.

This model protects Borealis's own path. It does not prevent installation through ADB, another installer, a modified build, or LightOS developer settings.

## Update behavior

The phone retains library rows after an install finishes and looks up installed versions through the SDK. Update checks request Play metadata, not APK downloads. A failed version lookup is shown as unavailable rather than up to date. Periodic sync checks installed library apps for updates; initial installs remain a phone action. Android's confirmation UI is always supported. Borealis may request unattended updates only when Android allows the existing installer of record to do so; a required confirmation is not treated as a failure.

Download progress aggregates real bytes across the base APK and every split, with bounded UI refresh frequency. Resolving, verifying, handing to Android, and waiting for user confirmation are distinct stages. These stages do not invent percentages when the installer provides none.

## Unsupported SDK lane

The adjacent Light SDK fork contributes a `package-install-request` capability, generated manifest permissions and result receiver, and an SDK-owned `LightPackageInstaller` facade. Consumer code remains within the Light SDK surface. This repository intentionally does not target the official hosted builder or Tool Library.
