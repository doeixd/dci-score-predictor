#!/usr/bin/env bash
# Consumer-fidelity smoke test (PLAN §4.5): pack the tarball, install it into a
# CLEAN throwaway project (no repo access, no node_modules reuse), and exercise
# ONLY the public API via consumer.mjs. This is the release gate that proves the
# installed-package layout resolves its shipped assets. Disk is tight — the temp
# dir is always cleaned up.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SMOKE_DIR="$REPO_ROOT/test/smoke"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; [ -n "${TARBALL:-}" ] && rm -f "$REPO_ROOT/$TARBALL" 2>/dev/null || true; }
trap cleanup EXIT

echo "== 1. Build =="
( cd "$REPO_ROOT" && npm run build >/dev/null 2>&1 )

echo "== 2. npm pack =="
TARBALL="$(cd "$REPO_ROOT" && npm pack --silent)"
echo "   packed: $TARBALL"

echo "== 3. Throwaway consumer project at $TMP =="
( cd "$TMP" && npm init -y >/dev/null 2>&1 )
# Copy the packed tarball + the fixture + the consumer next to each other.
cp "$REPO_ROOT/$TARBALL" "$TMP/pkg.tgz"
cp "$SMOKE_DIR/consumer.mjs" "$TMP/consumer.mjs"
cp "$REPO_ROOT/test/fixtures/season-2026-2026-dci-kentucky.json" "$TMP/season-2026-2026-dci-kentucky.json"

echo "== 4. Install packed tarball + deps (prefer offline cache) =="
( cd "$TMP" && npm install --prefer-offline --no-audit --no-fund ./pkg.tgz >/dev/null 2>&1 )

echo "== 5. Run consumer (public API only) =="
( cd "$TMP" && node consumer.mjs )
STATUS=$?

echo "== 5b. CLI: npx dci-predict (installed bin, --json) =="
# --json path exercises the installed bin end-to-end; grep-free JSON check via node.
( cd "$TMP" && npx --no-install dci-predict season-2026-2026-dci-kentucky.json --members 1 --json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(!Array.isArray(r.predictions)||!r.predictions.length){console.error("CLI FAIL: no predictions");process.exit(1)}console.log("  ok  - dci-predict --json emitted "+r.predictions.length+" predictions")})' )
CLI_STATUS=$?
[ "$STATUS" -eq 0 ] && STATUS=$CLI_STATUS

echo "== 6. Cleanup =="
exit $STATUS
