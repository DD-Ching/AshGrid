#!/usr/bin/env bash
# Package AshGrid into ashgrid.zip ready for CrazyGames upload (or any
# generic 'drag-and-drop a zip' host like Itch.io / GameDistribution).
#
# Usage:
#   ./scripts/build-zip.sh           # → ashgrid.zip in repo root
#   ./scripts/build-zip.sh path.zip  # → custom output path
#
# Includes only the runtime assets the game needs in production. Excludes
# the .git history, the .claude harness state, scripts/, dev-only docs,
# and tests / fixtures.

set -euo pipefail

cd "$(dirname "$0")/.."
OUT="${1:-ashgrid.zip}"
OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

# Copy the production assets into a clean staging dir. The keep-list is
# explicit so adding a stray .DS_Store or debug.log at the repo root won't
# bloat every CrazyGames upload.
KEEP=(
  index.html
  sw.js
  manifest.webmanifest
  serve.py            # bundled for self-host friendliness; CrazyGames ignores
  icons
  js
  ai_arena
  3d
  DEPLOY.md
)
for item in "${KEEP[@]}"; do
  if [ -e "$item" ]; then
    cp -R "$item" "$TMP/"
  fi
done

# Drop any nested .DS_Store / __MACOSX / .git that snuck in
find "$TMP" -name '.DS_Store' -delete 2>/dev/null || true
find "$TMP" -name '__MACOSX'  -prune -exec rm -rf {} + 2>/dev/null || true
find "$TMP" -name '.git'      -prune -exec rm -rf {} + 2>/dev/null || true

# Build the zip — `-r` recurses, `-X` strips macOS extended attrs that
# inflate the archive and aren't part of any web spec.
rm -f "$OUT_ABS"
(cd "$TMP" && zip -rX "$OUT_ABS" .) >/dev/null

SIZE=$(du -h "$OUT_ABS" | cut -f1)
echo "✓ $OUT_ABS ($SIZE)"
echo ""
echo "Next:"
echo "  • Upload to https://developer.crazygames.com (Game type: HTML5, Entry: index.html)"
echo "  • Recommended URL params: ?nn=1&mp=1"
echo "  • Categories: Action / Multiplayer / .IO / Shooter"
