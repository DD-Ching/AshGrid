#!/bin/bash
# ============================================================
# Phase 1 — Sim parity check.
# ============================================================
#
# js/sim/*.js (client classic-script) and server/party/sim/*.js (server
# ESM) MUST contain identical logic. Run this script in pre-commit /
# CI to catch drift. It strips the export boilerplate from each side
# and diffs the rest.
#
# Exit 0 on parity OK, 1 on drift.

set -e
cd "$(dirname "$0")/../.."

ROOT="$(pwd)"
CLIENT_DIR="$ROOT/js/sim"
SERVER_DIR="$ROOT/server/party/sim"

if [ ! -d "$CLIENT_DIR" ] || [ ! -d "$SERVER_DIR" ]; then
  echo "missing sim dir(s)"
  exit 1
fi

OVERALL=0

for client_file in "$CLIENT_DIR"/*.js; do
  name="$(basename "$client_file")"
  server_file="$SERVER_DIR/$name"
  if [ ! -f "$server_file" ]; then
    echo "  ✗ $name: server-side missing"
    OVERALL=1
    continue
  fi

  # Strip client-side IIFE wrapper + window.SIM attach block.
  # Strip server-side ESM export block.
  # Both sides have the same constants + functions; what's left should diff cleanly.
  client_stripped=$(mktemp)
  server_stripped=$(mktemp)

  # Client: remove the IIFE opening, the window.SIM bottom block, and the IIFE closing.
  # Keep only the function definitions + constants.
  awk '
    /^\(function\(\) \{/  { in_iife = 1; next }
    /^  if \(typeof window/ { skip_window = 1 }
    /^  \}$/ && skip_window { skip_window = 0; next }
    skip_window { next }
    /^  const API = \{/ { in_api = 1 }
    in_api && /^  \};/ { in_api = 0; next }
    in_api { next }
    /^\}\)\(\);/ { next }
    in_iife { sub(/^  /, ""); print }
  ' "$client_file" > "$client_stripped"

  # Server: remove the `export { ... }` block at bottom.
  awk '
    /^export \{/ { in_export = 1 }
    /^\};/ && in_export { in_export = 0; next }
    in_export { next }
    { print }
  ' "$server_file" > "$server_stripped"

  # Drop the file header comment block (different between sides — explains
  # client-vs-server boilerplate). Keep only from the first `const ` onwards.
  client_logic=$(mktemp)
  server_logic=$(mktemp)
  awk '/^const /{found=1} found' "$client_stripped" > "$client_logic"
  awk '/^const /{found=1} found' "$server_stripped" > "$server_logic"

  # Ignore whitespace + blank lines — boilerplate stripping can leave
  # subtle differences (trailing newline, indent prefix) that don't
  # affect logic.
  if diff -bBq "$client_logic" "$server_logic" > /dev/null; then
    echo "  ✓ $name: parity OK"
  else
    echo "  ✗ $name: DRIFT (client vs server differ):"
    diff -bB "$client_logic" "$server_logic" | head -20 | sed 's/^/      /'
    OVERALL=1
  fi

  rm -f "$client_stripped" "$server_stripped" "$client_logic" "$server_logic"
done

if [ $OVERALL -ne 0 ]; then
  echo
  echo "✗ Sim parity check FAILED. Sync the two copies before committing."
  exit 1
fi

echo
echo "✓ All sim modules in parity (client ↔ server)."
