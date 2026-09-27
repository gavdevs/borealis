# BrightMarket release kit

Release target: **Borealis v0.1.6**, Android version code **11**,
package **com.gav.borealis**. The user authorized public GitHub publication on
2026-09-27. Publication and physical verification status are recorded below once
the release finishes; this folder alone does not mean BrightMarket has listed it.

## Listing

- [Catalog YAML](com.gav.borealis.yml): ready for `apps/com.gav.borealis.yml` in
  the BrightMarket index; do not replace the whole catalog.
- [Listing description](listing.md): public-facing copy and setup instructions.
- [512px listing icon](../../docs/icon.png): use `docs/icon.png` in the Icon field.
- [Icon sources and exports](../../branding/README.md): approved North mark,
  Android adaptive icon, and 192/512/1024px PNGs.
- Repository: `https://github.com/gavdevs/borealis`.
- Category: `utilities`.
- Companion: `https://borealis.loosewire.dev`.
- Application ID and signing identity must remain unchanged for future updates.

The short summary is within the submission portal's 140-character limit:

> Choose essential apps on the web, then install and keep them up to date on your Light Phone III. Google sign-in required.

## Screenshots

BrightMarket discovers images directly under `docs/screenshots/` on the public
default branch and uses filename order. No additional screenshots YAML field is
needed. Numbering deliberately shows phone behavior before the website.

| File | Contents | Capture source |
| --- | --- | --- |
| `01-phone-library.png` | Installed apps, available updates, Signed in | Physical LP3, release verification |
| [02-phone-download.png](../../docs/screenshots/02-phone-download.png) | Real download percentage, bytes, split-file count | Physical LP3, alpha.4, 2026-09-27 |
| `03-phone-google-connected.png` | Saved Google connection, without account identifiers | Physical LP3, release verification |
| [04-web-library.png](../../docs/screenshots/04-web-library.png) | Personal library on desktop | Actual web UI with fictional demo data |
| [05-web-search.png](../../docs/screenshots/05-web-search.png) | Search and selection before adding | Actual web UI with fictional demo data |
| [06-web-library-mobile.png](../../docs/screenshots/06-web-library-mobile.png) | Mobile-browser dark theme | Actual web UI with fictional demo data |
| [07-web-signup.png](../../docs/screenshots/07-web-signup.png) | Username/password account creation | Actual web UI, empty fields |

Phone captures are unedited 1080×1240 screen images, not a rendered mock phone.
The download capture comes from the real successful MIKU installation on alpha.4;
that progress UI is unchanged in v0.1.6. It is reused to avoid uninstalling a real
app or downloading another app solely to stage a photograph. No pairing codes,
Google identifiers, passwords, or tokens appear in these images.

[Web capture provenance and reproduction](screenshots/web/README.md) describes
the Playwright script, demo fixtures, dimensions, and hashes. Fictional app names
are not representations of Play availability or app compatibility.

## Publish and submit

1. Verify CI, the signed stable APK, the original signing certificate, and an
   in-place LP3 update. Check the packaged launcher icon and Signed in state.
2. Make the repository public only after the tracked-source/history publication
   preflight. Keep runtime secrets and release signing keys in their existing
   encrypted stores; never upload local `.env`, database, or keystore files.
3. Publish the verified **v0.1.6** stable release from its draft. Keep the one
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

Alpha.4 passed 140 companion and 76 Android app tests, completed a real MIKU
installation through Borealis on an LP3, and showed Up to date afterward. Existing
library apps also showed Update available. Executing an update of an existing
third-party app and recovery if Android fails to open confirmation remain separate
checks. See [release instructions](../../docs/releases.md) for the signed build
and source-verification process. Store listing is not an official Light approval.
