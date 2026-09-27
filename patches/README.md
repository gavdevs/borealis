# Experimental Light SDK patch and extension

Borealis needs `light-sdk-borealis.patch` and the checked-in `sdk-extension/`
Kotlin sources; the unmodified SDK cannot build its package-installer and
personal Google Play sign-in integrations. Apply them only to a dedicated SDK
checkout pinned to `52fbc5a8aedbd3c4c88037580709e53540086229` from
[gavdevs/light-sdk](https://github.com/gavdevs/light-sdk).
That fork is public and the exact commit was verified available on GitHub when
this snapshot was prepared.

This is an unsupported, sideload-only extension, not an approved Light Phone
capability or an upstream contribution. It adds the `package-install-request`
capability, installer facade/receiver, and exact GPlayAPI/protobuf/Tink dependency
allowlist entries. Android still controls install permission and user
confirmation; requesting unattended updates does not guarantee them. No LightOS
server/protocol changes are included. Physical Light Phone behavior and official
builder compatibility are not established by this patch.

The additive `sdk-extension/client/` sources supply the experimental native
Google Play sign-in and credential-storage facade, plus its unit tests. They
are copied into `sdk/client/` after applying the original installer patch.
The copy script rejects symlinks, unsupported paths, oversized inputs, and any
existing destination file rather than overwriting SDK sources. It does not
modify the adjacent development SDK or change the official SDK policy.

## Apply to a fresh checkout

Run from the directory containing the Borealis checkout. Do not apply over an
existing modified SDK checkout.

```sh
git clone https://github.com/gavdevs/light-sdk.git light-sdk-borealis
git -C light-sdk-borealis checkout --detach 52fbc5a8aedbd3c4c88037580709e53540086229
git -C light-sdk-borealis apply --check ../borealis/patches/light-sdk-borealis.patch
git -C light-sdk-borealis apply ../borealis/patches/light-sdk-borealis.patch
python3 borealis/scripts/apply-sdk-extension.py light-sdk-borealis
```

Build Borealis with `-Pborealis.sdkPath=../light-sdk-borealis`; its default SDK
path is `../light-sdk`. Follow the root README for Android SDK/JDK setup.

## Validation

The lightweight extension-copy tests run in CI before copying the sources:

```sh
python3 -B -m unittest discover -s scripts -p test_apply_sdk_extension.py
```

Run this command from `borealis`. It exercises approved main/test source paths,
no-overwrite behavior, symlink rejection, and file/count/total-size limits.
Android builds remain on GitHub; do not start a local build just to apply or
validate the source overlay.

The snapshot was checked with `git apply --cached --check --whitespace=error-all`
against an isolated temporary index loaded from the pinned base. This verifies
patch applicability without altering the working SDK checkout. The patch is an
exact snapshot of 11 installer-related files: three plugin sources, three plugin
tests, the `LightActivity` accessor, three client installer sources, and one
client test. All unrelated `tool/` changes are excluded.

The commands below are for a suitably provisioned build runner. Use JDK 17 and
an Android SDK, run one build at a time, and keep the resource limits below.
From `light-sdk-borealis`, the plugin is a separate included build:

```sh
./gradlew -p plugin test \
  --no-daemon --max-workers=1 --no-parallel \
  -Dorg.gradle.jvmargs='-Xmx1536m -XX:MaxMetaspaceSize=512m -XX:ActiveProcessorCount=2' \
  -Pkotlin.compiler.execution.strategy=in-process
./gradlew :sdk:client:testDebugUnitTest \
  --no-daemon --max-workers=1 --no-parallel \
  -Dorg.gradle.jvmargs='-Xmx1536m -XX:MaxMetaspaceSize=512m -XX:ActiveProcessorCount=2' \
  -Pkotlin.compiler.execution.strategy=in-process
```

Then, from `borealis`, run the consumer checks separately:

```sh
./gradlew :app:testDebugUnitTest :app:assembleDebug \
  -Pborealis.sdkPath=../light-sdk-borealis --console=plain
```

These targeted checks are not the full SDK `./gradlew check` required for an
upstream contribution, nor a physical-device installation test. This snapshot
does not claim upstream readiness. Preserve the SDK's MIT notice in
[`LICENSE.light-sdk`](LICENSE.light-sdk) when redistributing this patch.

Reproducing a release requires its committed Borealis source archive (including
`sdk-extension/` and the copy script), the pinned SDK base archive, and the
original SDK patch. The base archive and patch alone do not contain the additive
sign-in sources. See the release build instructions and provenance alongside
the APK.
