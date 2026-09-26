# Third-party notices

## Aurora OSS GPlayAPI

Borealis uses `com.auroraoss:gplayapi:3.6.4` and a device-properties profile derived from the same upstream project.

- Project: https://gitlab.com/AuroraOSS/gplayapi
- Version reviewed for this build: `3.6.4`
- Source revision reviewed for this build: `18ec2bd74995d30e500b756359a4de3e37976f03`
- License: GNU General Public License v3.0 or later

The full GPL version 3 license text is included in `LICENSE`. When distributing a Borealis binary, distribute the corresponding Borealis source and the exact GPlayAPI source used to build it, including build instructions and these notices.

## Light SDK

Borealis is built against a modified checkout of the Light SDK.

- Project: https://github.com/thelightphone/light-sdk
- License: MIT
- Copyright: 2026 The Light Phone

The Light SDK MIT notice is preserved in `patches/LICENSE.light-sdk` and in the SDK checkout's `LICENSE`. The pinned base and Borealis modifications are documented in `patches/README.md`. Distributions that include modified SDK source must retain that notice.

## Tink Java

Borealis uses `com.google.crypto.tink:tink:1.20.0` for Ed25519 job-signature
verification without requiring an Android platform Ed25519 provider.

- Project and version: https://github.com/tink-crypto/tink-java/tree/v1.20.0
- License: Apache License, Version 2.0
- Ed25519 verifier copyright: 2017 Google Inc.

The full Apache 2.0 license is included in `licenses/LICENSE.tink` and copied to
release assets as `LICENSE.tink`. Keep it and these notices with redistributed
binaries. The exact resolved Tink JAR and its SHA-256 are recorded in
`runtime-dependencies.tsv`.

## Names and services

Borealis is an independent, unsupported project. It is not affiliated with or endorsed by Light, Aurora OSS, or Google. Google Play and Android are trademarks of their respective owners.
