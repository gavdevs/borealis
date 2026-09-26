# Borealis releases

Borealis is an experimental, independently signed, sideload-only Light Phone III
app. These workflows do not use Light's signing service or imply Tool Library
approval. The repository and its GitHub releases remain private.

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
- `Draft Android release`: a `vX.Y.Z` tag push, or a manual run naming an existing
  tag. The tag must match `app/lighttool.toml` and refer to a commit on `main`.
  Produces a **draft**, never an automatically published release. Uses repository
  signing secrets; no GitHub environment or paid deployment-protection feature
  is required. Review the draft before publishing it.

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
and nonproduction URLs. Debug builds still use the SDK development key. The first
dedicated-key APK cannot update an existing development-key installation in place;
plan the transition before uninstalling anything, because uninstalling loses local
app state. See [Android's signing guidance](https://developer.android.com/studio/publish/app-signing).

## Create a draft

1. Review and commit the intended release changes on `main`. Set the semantic
   `versionName` and a strictly increasing `versionCode` in `app/lighttool.toml`
   before each new release tag. The current candidate is `0.1.1`, version code
   `2`: the immutable `v0.1.0` tag exposed a dependency-provenance pipeline bug
   and did not produce a draft APK. Never move a failed tag onto fixed source.
2. Push `main` and wait for CI to pass on that exact commit. The release workflow
   checks main-branch ancestry but does not itself require a successful CI run.
3. Create and push an immutable tag matching `v<versionName>` at the checked
   commit. For the current candidate, after confirming `HEAD` is that commit:

   ```sh
   git tag -a v0.1.1 -m "Borealis v0.1.1"
   git push origin refs/tags/v0.1.1
   ```

   The tag push starts `Draft Android release` on GitHub-hosted runners. A manual
   run can retry the same existing tag if no release for it exists:

   ```sh
   gh workflow run release.yml --ref main -f tag=v0.1.1
   ```

4. Review the resulting private draft and verify the APK on a physical Light Phone.
   Build/test success alone does not establish package installation or banking-app
   compatibility on the phone.
5. Publish the draft only after reviewing the artifact, source bundle, and notices.
   Publishing a release in this repository does **not** make the private repo public.

The workflow intentionally fails if a release for the tag already exists. For an
interrupted draft creation, inspect that draft and the run artifacts before deciding
whether to finish uploading or remove the incomplete draft and rerun. Do not
overwrite a published release or move an existing release tag.

## Artifacts and source

Every successful draft contains:

- `borealis-vX.Y.Z-vcN.apk`, verified with Android `apksigner` against the pinned
  certificate, plus `apk-signature.txt`.
- `SHA256SUMS`, `provenance.json`, and resolved Android dependency coordinates,
  artifact names, and SHA-256 digests in `runtime-dependencies.tsv`.
- Committed Borealis source, exact Light SDK base source, the Borealis SDK patch,
  and exact GPlayAPI 3.6.4 source including upstream build files and licenses.
- Build instructions and third-party notices. No `.env`, database, local edits,
  keystores, Gradle caches, or generated binaries are included in source archives.

Pinned inputs:

- Light SDK: `gavdevs/light-sdk`, commit
  `52fbc5a8aedbd3c4c88037580709e53540086229`, plus
  `patches/light-sdk-borealis.patch`.
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
./gradlew --no-daemon --max-workers=1 -Pborealis.sdkPath=../light-sdk :app:testDebugUnitTest :app:assembleDebug
```

For a signed release, securely provide your own release keystore path/passwords/
alias/fingerprint in the environment variables above, then run:

```sh
./gradlew --no-daemon --max-workers=1 \
  -Pborealis.sdkPath=../light-sdk \
  -Pborealis.companionUrl=https://borealis.loosewire.dev \
  :app:assembleRelease
```

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
