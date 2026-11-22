#!/usr/bin/env bash
# Installation rehearsal (criterion C5-02): takes a clean clone of a ref and runs what an operator runs on a new machine.
#
#   scripts/rehearse-install.sh [ref] [--clean] [--repo <path-or-url>]
#
# ref    branch, tag or commit to clone (default: main)
# --clean  delete the clone afterwards (otherwise it is kept and its path printed)
# --repo   repository to clone (default: this one)
#
# Steps: npm ci, typecheck, check-contracts --require-frozen --require-signed, build, check-bundle, then serve the build
# and fetch the index page. Prints a dated summary with the time of each step; exits 1 if any step failed.
set -u -o pipefail

REF="main"
CLEAN=0
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
while [ $# -gt 0 ]; do
  case "$1" in
    --clean) CLEAN=1 ;;
    --repo) shift; REPO="$1" ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) REF="$1" ;;
  esac
  shift
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dpp-rehearsal.XXXXXX")"
CLONE="$WORK/clone"
LOG="$WORK/log"
PORT=4173
SERVER_PID=""
RESULTS=()
FAILED=0

cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
}
trap cleanup EXIT

step() { # name, command...
  local name="$1"; shift
  local start end
  start=$(date +%s)
  if "$@" >>"$LOG" 2>&1; then status=PASS; else status=FAIL; FAILED=1; fi
  end=$(date +%s)
  RESULTS+=("$(printf '%-34s %-5s %4ss' "$name" "$status" "$((end - start))")")
  [ "$status" = FAIL ] && { echo "--- $name failed; last lines of the log ($LOG):" >&2; tail -n 15 "$LOG" >&2; }
  return $FAILED
}

echo "Installation rehearsal, $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "Repository: $REPO  ref: $REF"
echo "Node $(node -v), npm $(npm -v), $(uname -sm)"

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is in use; stop what listens there first." >&2
  exit 2
fi

step "git clone ($REF)" git clone --quiet "$REPO" "$CLONE" && step "git checkout $REF" git -C "$CLONE" checkout --quiet "$REF"
COMMIT="$(git -C "$CLONE" rev-parse --short HEAD 2>/dev/null || echo unknown)"
cd "$CLONE" 2>/dev/null || { echo "clone failed; see $LOG" >&2; exit 1; }

serve_and_fetch() {
  ./node_modules/.bin/vite preview --port "$PORT" --strictPort >"$WORK/serve.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 40); do
    if curl -fs "http://localhost:$PORT/" -o "$WORK/index.html" 2>/dev/null; then
      grep -q '<div id="root"' "$WORK/index.html" && return 0
      return 1
    fi
    sleep 0.5
  done
  return 1
}

[ $FAILED -eq 0 ] && step "npm ci" npm ci
[ $FAILED -eq 0 ] && step "typecheck" npm run typecheck
[ $FAILED -eq 0 ] && step "check-contracts (frozen, signed)" npm run check-contracts -- --require-frozen --require-signed
[ $FAILED -eq 0 ] && step "build" npm run build
[ $FAILED -eq 0 ] && step "check-bundle" npm run check-bundle
[ $FAILED -eq 0 ] && step "serve and fetch the index page" serve_and_fetch
cleanup
SERVER_PID=""

echo
echo "Summary for $REF at $COMMIT, $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
printf '%s\n' "${RESULTS[@]}"
if [ $FAILED -eq 0 ]; then echo "Result: PASS"; else echo "Result: FAIL (log: $LOG)"; fi

cd "$REPO" || true
if [ $CLEAN -eq 1 ]; then
  rm -rf "$WORK"
  echo "Clone deleted."
else
  echo "Clone kept at $CLONE (delete it with: rm -rf $WORK)"
fi
exit $FAILED
