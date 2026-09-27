#!/usr/bin/env bash
# Render only the approved vector artwork; no AI or raster touch-up is involved.
set -euo pipefail

branding_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$branding_dir/.." && pwd)"
command -v magick >/dev/null || { echo 'ImageMagick 7 with the librsvg delegate is required.' >&2; exit 1; }

for size in 192 512 1024; do
    # Render from vector at 1024px, then downsample; fixed RGB output omits metadata.
    magick -limit thread 1 -background black -density 192 \
        "rsvg:$branding_dir/borealis-icon.svg" -resize "${size}x${size}" \
        -alpha off -strip -define png:exclude-chunks=date,time \
        "PNG24:$branding_dir/borealis-icon-${size}.png"
done

# BrightMarket accepts a repository-relative PNG and normalizes it to 192px.
# Keep the 512px source at its conventional discoverable path.
cp -- "$branding_dir/borealis-icon-512.png" "$repo_dir/docs/icon.png"
