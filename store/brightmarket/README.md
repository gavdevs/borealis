# BrightMarket release kit

Release target: **Borealis v0.1.7**, Android version code **12**, package
**com.loosewire.borealis**. This adopts the same namespace as Lightious and Kelp.
The renamed candidate still needs build, APK, phone, and publication checks before
submission. BrightMarket has not received or accepted a listing through this work.

## Listing

- [Catalog YAML](com.loosewire.borealis.yml): ready for `apps/com.loosewire.borealis.yml` in
  the BrightMarket index; do not replace the whole catalog.
- [Listing description](listing.md): public-facing copy and setup instructions.
- [512px listing icon](../../docs/icon.png): use `docs/icon.png` in the Icon field.
- [Icon sources and exports](../../branding/README.md): approved North mark,
  Android adaptive icon, and 192/512/1024px PNGs.
- Repository: `https://github.com/gavdevs/borealis`.
- Category: `utilities`.
- Companion: `https://borealis.loosewire.dev`.
- Application ID and signing identity must remain unchanged for future updates.

The previous public v0.1.6 uses `com.gav.borealis`. Version 0.1.7 is a separate
Android installation, not an in-place update from that package. Keep the old app
and data intact while pairing and signing into the new app. The website account,
library, and installed third-party apps remain; their next updates may require
Android confirmation because the new package is not their original installer.

The short summary is within the submission portal's 140-character limit:

> Choose essential apps on the web, then install and keep them up to date on your Light Phone III. Google sign-in required.

## Screenshots

BrightMarket discovers images directly under `docs/screenshots/` on the public
default branch and uses filename order. No additional screenshots YAML field is
needed. Numbering deliberately shows phone behavior before the website.

| File | Contents | Capture source |
| --- | --- | --- |
| [01-phone-library.png](../../docs/screenshots/01-phone-library.png) | Installed apps, available updates, Signed in | Physical LP3, v0.1.6, 2026-09-27 |
| [02-phone-download.png](../../docs/screenshots/02-phone-download.png) | Real download percentage, bytes, split-file count | Physical LP3, alpha.4, 2026-09-27 |
| [03-phone-google-connected.png](../../docs/screenshots/03-phone-google-connected.png) | Saved Google connection, without account identifiers | Physical LP3, v0.1.6, 2026-09-27 |
| [04-web-library.png](../../docs/screenshots/04-web-library.png) | Personal library on desktop | Actual web UI with fictional demo data |
| [05-web-search.png](../../docs/screenshots/05-web-search.png) | Search and selection before adding | Actual web UI with fictional demo data |
| [06-web-library-mobile.png](../../docs/screenshots/06-web-library-mobile.png) | Mobile-browser dark theme | Actual web UI with fictional demo data |
| [07-web-signup.png](../../docs/screenshots/07-web-signup.png) | Username/password account creation | Actual web UI, empty fields |

Phone captures are unedited 1080×1240 screen images, not a rendered mock phone.
The download capture comes from the real successful MIKU installation on alpha.4;
that progress UI is unchanged in v0.1.6 and the v0.1.7 namespace change. The library
and connection captures remain from v0.1.6; they are not evidence of v0.1.7 testing.
Existing captures are reused to avoid uninstalling a real
app or downloading another app solely to stage a photograph. No pairing codes,
Google identifiers, passwords, or tokens appear in these images.

[Web capture provenance and reproduction](screenshots/web/README.md) describes
the Playwright script, demo fixtures, dimensions, and hashes. Fictional app names
are not representations of Play availability or app compatibility.

## Publish and submit

1. Verify CI, the signed stable APK, the original signing certificate, and a
   separate LP3 installation of `com.loosewire.borealis`, preserving the old app.
   Check the packaged launcher icon, fresh onboarding, and connection state.
2. Make the repository public only after the tracked-source/history publication
   preflight. Keep runtime secrets and release signing keys in their existing
   encrypted stores; never upload local `.env`, database, or keystore files.
3. Publish the verified **v0.1.7** stable release from its draft. Keep the one
   release APK and all source/license/provenance assets together. Do not publish
   old stable drafts or relabel an alpha build as a stable release.
4. Open the [BrightMarket submission portal](https://brightmarket.gzl.dev/submit.html),
   sign in with GitHub, select `gavdevs/borealis`, and use the fields in the YAML
   and the description above. The portal verifies ownership; nothing here submits
   a request or promises acceptance.
5. After listing, check that the expected stable version, original certificate,
   icon, phone screenshots, and web screenshots appear in the catalog.

The index needs a public, unarchived repository and a published stable release.
Drafts and prereleases cannot serve as the initial default release. An existing
stable entry can additionally offer a preview release. Keep one unambiguous
installable APK asset per release to avoid artifact-selection ambiguity.

Sources checked 2026-09-27: [submission validator](https://github.com/gi-os/brightmarket-index/blob/main/scripts/validate_submission.py),
[release and screenshot discovery](https://github.com/gi-os/brightmarket-index/blob/main/scripts/build_index.py),
[portal field limits](https://github.com/gi-os/brightmarket-index/blob/main/worker/worker.js),
and [icon discovery](https://github.com/gi-os/brightmarket-index/blob/main/scripts/extract_icons.py).

## Verification boundary

The following is historical evidence for the old package, not a claim that the
renamed v0.1.7 candidate has been built or tested yet.

The v0.1.6 release at `63288da08863a70ee5001fb7ab0033c674599166` passed
[CI](https://github.com/gavdevs/borealis/actions/runs/36357724823) and the
[signed release workflow](https://github.com/gavdevs/borealis/actions/runs/36357726943).
Checks included 80 app tests, 15 SDK authentication tests, release-policy checks,
and the companion tests/build. All 15 artifact checksums, corresponding-source
archives, SDK overlay, non-debuggable optimized build flags, original signing
certificate, and packaged launcher icon verified. The in-place LP3 installation
retained the app UID and first-install timestamp. Cold launch, saved Google
connection, Signed in action, installed status, and available-update rows passed.

APK SHA-256: `f48a8d9ce305a10b1977bc11149b9167907b1e470a8502d1ccd3e29ff8bb9c87`.

Alpha.4 passed 140 companion and 76 Android app tests, completed a real MIKU
installation through Borealis on an LP3, and showed Up to date afterward. Existing
library apps also showed Update available. Executing an update of an existing
third-party app and recovery if Android fails to open confirmation remain separate
checks. See [release instructions](../../docs/releases.md) for the signed build
and source-verification process. Store listing is not an official Light approval.
