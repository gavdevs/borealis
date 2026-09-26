# Borealis

Borealis is an intentionally unsupported, sideload-only installer and updater for Light Phone III. Discovery, review, and device assignments live in a web companion. The phone app has no catalog: it pairs, receives signed jobs for positively approved packages, downloads the correct Play delivery artifacts directly on the phone, verifies them, and hands the complete base-and-split set to Android's package installer.

This is not a Light Tool Library project and is not affiliated with Light, Aurora OSS, or Google. It constrains only the Borealis installation path; it is not a phone-wide application blocker.

## Repository layout

- `app/` — the Light SDK phone agent (`com.gav.borealis`)
- `companion/` — the local-first search, allowlist, pairing, and job service
- `docs/` — trust model, protocol, and local-development notes
- `patches/` — pinned Light SDK installer changes and SDK license notice

The app consumes a custom SDK fork (by default `../light-sdk`). That fork adds the narrow `package-install-request` capability required for Android `PackageInstaller` sessions. Follow [the pinned SDK setup](patches/README.md) for a fresh checkout; an unmodified upstream SDK is not sufficient.

## Running the prototype

- **Web companion:** see [companion/README.md](companion/README.md) for Node.js,
  pnpm, configuration, and local startup. Copy the example environment file and
  supply your own admin token. Keep the database and signing material private.
- **Phone app:** requires JDK 17, Android SDK 36, and the pinned, patched Light SDK.
  Configure your Android SDK path locally, then use the included Gradle wrapper.
  The companion URL defaults to the emulator address `http://10.0.2.2:8787`;
  use `-Pborealis.companionUrl=https://your-companion.example` for a hosted instance.
- **Distribution:** this initial source snapshot is not a published APK release
  or a Cloudflare deployment. Release automation and production hosting remain
  to be configured. Do not use the SDK's shared development signing key for a
  production release.

## Development status

The first vertical slice is under active construction:

1. Pair a phone with the companion.
2. Search for a package and positively approve it in the companion.
3. Assign it to the paired device.
4. Verify the signed, device-bound job on the phone.
5. Fetch the current device-specific base and splits directly from Google Play.
6. Verify package identity, signer, size, and hashes, then request installation.
7. Report the final result to the companion and periodically check for updates.

The prototype has passed initial phone unit tests and compilation, companion
unit tests and typechecks, and fixture-based browser flows. Physical LP3
end-to-end installation/update remains unverified. Recurring generation of
update jobs and the intended category-admission policy are not complete; the
current allowlist is manually curated. The companion is single-owner, with an
admin token and one shared collection of apps/devices, not a multi-user service.

## Low-resource development

This development machine is resource constrained. Run only one build or test
command at a time, including builds in adjacent projects. Prefer targeted,
incremental checks; avoid `clean`, full SDK test suites, emulators, and overlapping
watch servers unless the task actually needs them.

The phone build defaults to one Gradle worker, no parallel tasks, a 1536 MiB JVM
heap, and in-process Kotlin compilation. Gradle's JVM sees at most two processors
to limit internal compiler/GC concurrency. Persistent Gradle daemons are disabled
(Gradle can still use a short-lived single-use daemon for a build). These are
per-process limits, not a hard total-memory cap for all Android build tools.

Companion tests also use one worker with parallel files disabled. Avoid running
them alongside the Android build. Stop task-owned development servers when done.
Run expensive checks at lower scheduling priority where practical, for example
`nice -n 10 ./gradlew :app:testDebugUnitTest --console=plain`.

## Licensing

Borealis is intended to be distributed under GPL-3.0-or-later because the phone client uses Aurora OSS `gplayapi`, which is GPL-family software. Preserve upstream notices and provide corresponding source whenever distributing binaries.
