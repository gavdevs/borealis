# Experimental Light SDK patch

Borealis currently needs `light-sdk-borealis.patch`; the unmodified SDK cannot
build its package-installer integration. Apply it only to a dedicated SDK
checkout pinned to `52fbc5a8aedbd3c4c88037580709e53540086229` from
[gavdevs/light-sdk](https://github.com/gavdevs/light-sdk).
That fork is public and the exact commit was verified available on GitHub when
this snapshot was prepared.

This is an unsupported, sideload-only extension, not an approved Light Phone
capability or an upstream contribution. It adds the `package-install-request`
capability, installer facade/receiver, and exact GPlayAPI/protobuf dependency
allowlist entries. Android still controls install permission and user
confirmation; requesting unattended updates does not guarantee them. No LightOS
server/protocol changes are included. Physical Light Phone behavior and official
builder compatibility are not established by this patch.

## Apply to a fresh checkout

Run from the directory containing the Borealis checkout. Do not apply over an
existing modified SDK checkout.

```sh
git clone https://github.com/gavdevs/light-sdk.git light-sdk-borealis
git -C light-sdk-borealis checkout --detach 52fbc5a8aedbd3c4c88037580709e53540086229
git -C light-sdk-borealis apply --check ../borealis/patches/light-sdk-borealis.patch
git -C light-sdk-borealis apply ../borealis/patches/light-sdk-borealis.patch
```

Build Borealis with `-Pborealis.sdkPath=../light-sdk-borealis`; its default SDK
path is `../light-sdk`. Follow the root README for Android SDK/JDK setup.

## Validation

The snapshot was checked with `git apply --cached --check --whitespace=error-all`
against an isolated temporary index loaded from the pinned base. This verifies
patch applicability without altering the working SDK checkout. The patch is an
exact snapshot of 11 installer-related files: three plugin sources, three plugin
tests, the `LightActivity` accessor, three client installer sources, and one
client test. All unrelated `tool/` changes are excluded.

No Gradle builds or tests were run while packaging this snapshot. When validating
a fresh checkout, use JDK 17 and an Android SDK, run one build at a time, and keep
the resource limits below. From `light-sdk-borealis`:

```sh
./gradlew :plugin:test :sdk:client:testDebugUnitTest \
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
