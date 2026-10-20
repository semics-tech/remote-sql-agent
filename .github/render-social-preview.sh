#!/bin/sh
# Regenerates .github/social-preview.png (1280x640) from social-preview.svg.
# Needs ImageMagick (`convert`) and the DejaVu Sans font, e.g. the node:22 image:
#   docker run --rm -v "$PWD":/work node:22 sh /work/.github/render-social-preview.sh
set -e
cd "$(dirname "$0")"
convert social-preview.svg PNG24:social-preview.png
identify social-preview.png
