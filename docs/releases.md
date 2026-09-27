# Borealis releases

Borealis is an experimental, independently signed, sideload-only Light Phone III
app. These workflows do not use Light's signing service or imply Tool Library
approval. The workflow supports private testing and reviewed public releases.
Repository visibility and release publication are separate from building: stable
releases and all public-repository prereleases are created as drafts first.

## Pipelines

- `CI`: pull requests, `main` pushes, and manual runs. Runs companion tests,
  typechecks, builds, and a Worker dry-run, then Android unit tests, a debug
  build, and dependency-provenance generation using the same artifact selection
  as releases. The two jobs are sequential. Gradle uses one worker and the repository's
  memory caps; no emulator or Android build runs on the development machine.
- `Cloudflare Workers Builds`: the companion's native GitHub connection, not a
  GitHub Actions deployment. Once connected, `main` pushes run companion tests,
  build, Worker checks, and deployment on Cloudflare. Preview builds are disabled;
  Turso migrations remain deliberate/manual. The Worker is live on Workers Free
  and passed hosted HTTPS checks on 2026-09-26 following a Wrangler deployment.
  The native GitHub connection remains unverified. See [deployment.md](deployment.md).
- `Android release`: a version tag push, or a manual run naming an existing tag.
  The tag must exactly match `app/lighttool.toml` and refer to a commit on `main`.
  Stable `vX.Y.Z` tags produce a minified **draft** for review. Numbered
  `vX.Y.Z-alpha.N`, `-beta.N`, and `-rc.N` tags produce a non-minified,
  non-debuggable APK. They automatically publish a **prerelease only while the
  repository is private**, never marking it latest. If the repository later becomes
  public, prereleases also remain **drafts**, preserving their prerelease flag;
  no tag automatically publishes a public release. The tested
  `publication_flags` helper reads the current repository identity and visibility
  at release creation. Only `gavdevs/borealis` can run this release workflow.
  Both lanes use the same dedicated
  signing identity, production companion URL, SDK/app tests, source/license
  bundles, and dependency provenance. Repository signing secrets are used; no
  GitHub environment or paid deployment-protection feature is required.

External GitHub actions are pinned to full commit SHAs verified against upstream release
tags. Checkout does not persist repository credentials. Pull requests never receive
production or signing secrets. GitHub-hosted runners handle CI and Android release
builds; Cloudflare handles companion deployment builds.

## Signing identity

The workflow uses these five repository-level GitHub Actions secrets:

| Secret | Value |
| --- | --- |
| `BOREALIS_RELEASE_KEYSTORE_BASE64` | Base64-encoded dedicated PKCS#12/JKS keystore |
| `BOREALIS_RELEASE_STORE_PASSWORD` | Keystore password |
| `BOREALIS_RELEASE_KEY_PASSWORD` | Private-key password |
| `BOREALIS_RELEASE_KEY_ALIAS` | Dedicated Borealis key alias |
| `BOREALIS_RELEASE_CERT_SHA256` | SHA-256 fingerprint of that key's public certificate |

`BOREALIS_RELEASE_KEYSTORE` is a runner-local path, not a GitHub secret. The workflow
decodes the keystore to a mode-0600 file under the runner's temporary directory,
then deletes that exact copy even if the build fails. No signing material enters
release archives or build artifacts.

Keep an independent encrypted backup of the keystore, alias, passwords, and public
certificate fingerprint. GitHub secrets are not a downloadable backup. Keep the
same signing identity for every update and increment `versionCode` for each release.
Never regenerate the key merely to repair a failed pipeline.

Release Gradle tasks reject missing credentials, the public SDK development key,
Android debug certificates, an unexpected signing fingerprint, unsigned SDK mode,
nonproduction URLs, debuggable APKs, and mismatched stable/prerelease build flags.
Only numbered prerelease versions permit `-Pborealis.fastPrerelease=true`; that
property disables code/resource shrinking on the existing release variant and
does not enable Android or WebView debugging. Stable releases require shrinking.
Debug builds still use the SDK development key. The first
dedicated-key APK cannot update an existing development-key installation in place;
plan the transition before uninstalling anything, because uninstalling loses local
app state. See [Android's signing guidance](https://developer.android.com/studio/publish/app-signing).

## Package migration in v0.1.7

Version 0.1.7/code 12 changes the Android application ID to
`com.loosewire.borealis`, matching the Lightious/Kelp namespace. Older releases
use `com.gav.borealis`. The same dedicated signing key is retained, but Android
still treats the new ID as a separate app. Do not change or remove published tags
or APKs to disguise the transition.

Install the new app without removing the old one, then pair it, sign in with
Google, and grant installation access. App-local pairing data and package-bound
Google credentials are not copied. The website account/library and installed
third-party apps are unchanged; updates may need Android confirmation because
the new package is not their original installer. Future releases retain the new
ID and signing key for normal in-place updates.

## Create a stable draft or testing prerelease

1. Review and commit the intended release changes on `main`. Set the semantic
   `versionName` and a strictly increasing `versionCode` in `app/lighttool.toml`
   before each new release tag, including prereleases. The latest testing build
   is `0.1.6-alpha.4`, version code `10`. It replaces the curator gate with
   personal-library Install/Update actions, persistent installed/update status,
   and real download progress plus explicit installation stages. Alpha.3 already
   passed phone-local Google sign-in and saved-session reuse on the LP3; that
   authentication transport and profile are unchanged. Alpha.4 has installed MIKU
   on the physical LP3. The renamed store candidate is `0.1.7`, version code `12`:
   a minified, normally signed build, initially created as a **draft** for review.
   A successful unoptimized alpha does not establish that the minified candidate
   works. Never move a failed tag onto fixed source.
2. Push the reviewed commit to `main`. For stable release candidates, wait for
   full CI to pass on that exact commit. A testing prerelease can start as soon
   as the commit is on `main`: its release workflow independently runs the
   release-policy tests, SDK authentication/metadata tests, and app unit tests,
   without waiting for the separate companion CI job. It does not bypass those
   Android checks or require a local Android build.
3. Create and push an immutable tag matching `v<versionName>` at the checked
   commit. For the current candidate, after confirming `HEAD` is that commit:

   ```sh
   git tag -a v0.1.7 -m "Borealis v0.1.7"
   git push origin refs/tags/v0.1.7
   ```

   The tag push starts `Android release` on GitHub-hosted runners. A manual
   run can retry the same existing tag if no release for it exists:

   ```sh
   gh workflow run release.yml --ref main -f tag=v0.1.7
   ```

4. Download the resulting prerelease or draft and verify the APK
   on a physical Light Phone. Matching package/signing identities support an
   in-place update without clearing pairing or account data. The v0.1.7 package
   migration instead requires the separate installation described above.
   Build/test success alone does not establish package installation or banking-app
   compatibility on the phone.
5. Stable drafts always require review before publication. Private prereleases
   publish automatically for testing with `--prerelease --latest=false`. Public
   prereleases use `--draft --prerelease --latest=false` instead. The workflow
   rejects unknown visibility/channel values and any other repository identity.
   Creating or publishing a release does **not** change repository visibility.

## BrightMarket publication handoff

Preparing store assets and a signed draft does not publish the app or submit a
listing. BrightMarket's current validator requires
a public, unarchived repository and a published, non-draft, non-prerelease release
containing one unambiguous installable APK. It does not admit a prerelease-only
app as a first listing. Once a stable default exists, newer prereleases may appear
as an opt-in preview channel. These are [current validator rules](https://github.com/gi-os/brightmarket-index/blob/main/scripts/validate_submission.py#L308-L335),
not a reason to relabel alpha.4 as stable without checking the candidate.

For the public launch:

1. Review the repository and history for material that must remain private,
   license/source completeness, support information, and account/privacy disclosures.
   Keep signing keys and runtime credentials private; never place them in release assets.
2. Verify the normally minified candidate on the LP3, including Google sign-in,
   saved-session reuse, library sync, app installation, and installed/update states.
   Preserve `com.loosewire.borealis`, the dedicated signing certificate, and increasing codes.
3. After the checks pass, make the repository public and manually publish the reviewed
   stable draft. Stable and public-prerelease workflows remain draft-only afterward; future
   public releases also need a deliberate publication decision.
4. Confirm anonymous readers can access the published APK, its complete corresponding
   source assets, `docs/icon.png`, and numbered files in `docs/screenshots` on the
   default branch. Do not publish the old `v0.1.1`–`v0.1.5` drafts as a shortcut.
5. Submit through the [BrightMarket portal](https://brightmarket.gzl.dev/submit.html)
   as a separate listing action. The portal verifies repo ownership, files the
   submission, and the store's workflow opens a listing PR. Borealis does not submit
   itself or claim official Light Tool Library approval.

The full listing package and assets are maintained separately from this build guide.
No public repository transition, release publication, or store submission is part
of merely preparing the candidate.

The fast lane skips release optimization and the wait for companion CI, not
Kotlin compilation, signing, or source packaging. It still builds on GitHub and
installs an APK; it is not hot reload and does not promise an instant build.

The first alpha tag remains immutable: its build exhausted the 512 MiB Gradle
metaspace cap before packaging, so no alpha.1 APK was published. Release jobs now
allow 1024 MiB of metaspace on GitHub only, retaining the 1536 MiB heap and one
worker. Local `gradle.properties` limits are unchanged. Release jobs restore the
shared CI cache read-only; regular trusted CI remains responsible for warming it.

The workflow intentionally fails if a release for the tag already exists. For an
interrupted draft creation, inspect that draft and the run artifacts before deciding
whether to finish uploading or remove the incomplete draft and rerun. Do not
overwrite a published release or move an existing release tag.

## Artifacts and source

Every successful draft or prerelease contains:

- `borealis-vX.Y.Z-vcN.apk`, verified with Android `apksigner` against the pinned
  certificate, plus `apk-signature.txt`.
- `SHA256SUMS`, `provenance.json`, the verified build flags in `release-build.json`,
  and resolved Android dependency coordinates,
  artifact names, and SHA-256 digests in `runtime-dependencies.tsv`.
- Committed Borealis source, exact Light SDK base source, the Borealis SDK patch,
  and exact GPlayAPI 3.6.4 source including upstream build files and licenses.
- Build instructions and third-party notices. No `.env`, database, local edits,
  keystores, Gradle caches, or generated binaries are included in source archives.

Pinned inputs:

- Light SDK: `gavdevs/light-sdk`, commit
  `52fbc5a8aedbd3c4c88037580709e53540086229`, plus
  `patches/light-sdk-borealis.patch` and the committed `sdk-extension/client`
  source overlay. The overlay is in `borealis-source.tar.gz`; apply it after the
  installer patch with `scripts/apply-sdk-extension.py`.
- GPlayAPI: `com.auroraoss:gplayapi:3.6.4`; upstream source commit
  `18ec2bd74995d30e500b756359a4de3e37976f03` from AuroraOSS's GitLab repository.
- JDK 17, repository Gradle 9.0.0 wrapper, Android platform 36, and build-tools
  36.0.0 for APK verification (AGP selects its compilation tools).
  Rebuilding GPlayAPI itself additionally requires the JDK 21 toolchain declared
  in its own build files. Borealis consumes its published AAR.
- Node 22.22.2 and pnpm 11.10.0, with frozen `companion/pnpm-lock.yaml`.

The archive pins and resolved artifact hashes document inputs; they are not a claim
of byte-for-byte reproducibility or a substitute for reviewing redistribution
requirements. If an APK is distributed outside the private repository, provide its
corresponding source, build instructions, patch, and notices to those recipients
alongside it. A private GitHub source link alone is not sufficient for recipients
who cannot access it. See `THIRD_PARTY_NOTICES.md` and the included GPL license.

## Rebuild from the attached source

Extract `borealis-source.tar.gz` and `light-sdk-base-source.tar.gz` into sibling
directories. Apply the supplied patch to the SDK base, from the Borealis directory:

```sh
git -C ../light-sdk apply --check ../borealis/patches/light-sdk-borealis.patch
git -C ../light-sdk apply ../borealis/patches/light-sdk-borealis.patch
python3 scripts/apply-sdk-extension.py ../light-sdk
./gradlew --no-daemon --max-workers=1 -Pborealis.sdkPath=../light-sdk :app:testDebugUnitTest :app:assembleDebug
```

For a signed release, securely provide your own release keystore path/passwords/
alias/fingerprint in the environment variables above. For the fast prerelease
source, run:

```sh
./gradlew --no-daemon --max-workers=1 \
  -Pborealis.sdkPath=../light-sdk \
  -Pborealis.companionUrl=https://borealis.loosewire.dev \
  -Pborealis.fastPrerelease=true \
  :app:assembleRelease :app:writeReleaseBuildMetadata
```

For a stable version, omit `-Pborealis.fastPrerelease=true` (or set it to `false`).
Prerelease versions require `true` for release packaging; stable versions forbid
it. The signed APK remains a release variant and is never debuggable. The recorded
build metadata is checked against the tag, and `aapt2` independently checks the
packaged APK's identity and debug flag before publication.

Using your own signing key produces your own build, not an update signed with the
maintainer's identity. A fork using another companion domain must explicitly change
the release URL guard; do not disable all release validation to change one endpoint.

## Companion hosting is separate

Use Cloudflare's dashboard to authorize its GitHub app for the private
`gavdevs/borealis` repository and connect `borealis-companion`. Its production
branch is `main`, root directory is `companion`, build command is
`pnpm test && pnpm build && pnpm worker:check`, and deploy command is
`pnpm exec wrangler deploy`. Set build variables `NODE_VERSION=22.22.2` and
`PNPM_VERSION=11.10.0`; disable preview builds. Cloudflare supports these
[version overrides](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/).

Cloudflare automatically manages the native build token; no separately created
Cloudflare API token or GitHub deployment secrets are needed. Configure
`BOREALIS_ADMIN_TOKEN`, `TURSO_DATABASE_URL`, and `TURSO_AUTH_TOKEN` only as Worker
runtime secrets in **Settings → Variables & Secrets**, not build variables.
See [Cloudflare's native configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

The current Turso schema is migrated. Future migrations must be reviewed and run
manually before deploying code that needs them, preserving the existing signing
identity. Read-only and explicit-write production smoke commands remain available
in [deployment.md](deployment.md); they are not automatically run by the native
build command. A failed smoke check does not automatically roll back the Worker
or database. Keep Android signing secrets in GitHub for the Android workflow only.
