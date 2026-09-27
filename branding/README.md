# Borealis icon

The approved North mark is the existing open circular stroke and northeast arrow
from `design/icon-studies/north.svg` and `companion/public/assets/borealis.svg`.
These exports do not redesign that mark.

- `borealis-mark.svg`: canonical 24-unit two-path geometry; inherits text color.
- `borealis-icon.svg`: white mark on an opaque black 32-unit square, with padding.
- `borealis-icon-192.png`, `borealis-icon-512.png`, `borealis-icon-1024.png`: opaque
  RGB exports for listings and reuse.
- `../docs/icon.png`: identical to the 512px export; BrightMarket listing path.

`app/lighttool.toml` declares `@mipmap/ic_borealis_launcher`, which the Light SDK
places in its generated application manifest. Do not add a manual manifest.
The adaptive icon uses a black background and the same white foreground for
normal and monochrome layers. Its 108-unit canvas places the artwork inside the
central safe area; the central 72-unit crop has the same framing as the square
listing icon. A flat vector fallback is included for icon consumers that do not
use adaptive layers. The mark paths, stroke width, round caps, and default miter
joins are unchanged from the approved companion artwork.

Regenerate local exports with the already installed ImageMagick 7/librsvg renderer:

```sh
bash branding/export-icons.sh
```

The script runs single-threaded and writes only the named PNG exports and
`docs/icon.png`. It strips variable metadata; repeated runs with the same renderer
produce identical files. Android resources remain vector XML and are not generated
from PNG. Keep their two path strings aligned with `borealis-mark.svg` when changing
the canonical artwork.

BrightMarket's [icon extraction script](https://github.com/gi-os/brightmarket-index/blob/main/scripts/extract_icons.py)
accepts a repository-relative PNG/WebP/JPEG path and normalizes listing icons to
192×192. `docs/icon.png` is also one of its conventional automatic discovery paths.
This asset preparation is not publication or approval by Light.
