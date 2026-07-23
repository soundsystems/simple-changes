#!/bin/sh
# Compare the bundled release-note guidance pin with simple-changelogs.

set -eu

usage() {
  echo "usage: check-release-notes-fork-sync.sh <upstream-repo> [upstream-ref]" >&2
  exit 2
}

fail() {
  echo "error: $1" >&2
  exit 2
}

has_ref() {
  git -C "$UPSTREAM_DIR" show-ref --verify --quiet "$1"
}

default_ref() {
  REMOTE=""
  if git -C "$UPSTREAM_DIR" remote | grep -Fx origin >/dev/null 2>&1; then
    REMOTE="origin"
  else
    REMOTE=$(git -C "$UPSTREAM_DIR" remote | sed -n '1p')
  fi

  if [ -n "$REMOTE" ]; then
    SYMBOLIC=$(git -C "$UPSTREAM_DIR" symbolic-ref -q "refs/remotes/$REMOTE/HEAD" 2>/dev/null || true)
    if [ -n "$SYMBOLIC" ] && has_ref "$SYMBOLIC"; then
      echo "${SYMBOLIC#refs/remotes/}"
      return
    fi
    for BRANCH in main master; do
      CANDIDATE="refs/remotes/$REMOTE/$BRANCH"
      if has_ref "$CANDIDATE"; then
        echo "$REMOTE/$BRANCH"
        return
      fi
    done
  fi

  for CANDIDATE in refs/heads/main refs/heads/master; do
    if has_ref "$CANDIDATE"; then
      echo "${CANDIDATE#refs/heads/}"
      return
    fi
  done
  fail "cannot resolve an upstream default ref; pass one explicitly"
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage

UPSTREAM_DIR=$1
TARGET_REF=${2:-}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FORK_SKILL=$SCRIPT_DIR/release-notes/release-notes.md
UPSTREAM_SKILL_PATH=skills/simple-changelogs

[ -f "$FORK_SKILL" ] || fail "maintainer release-note module was not found"
git -C "$UPSTREAM_DIR" rev-parse --git-dir >/dev/null 2>&1 ||
  fail "not a Git repository: $UPSTREAM_DIR"

PIN=$(sed -n 's/.*[Ff]orked from `simple-changelogs` @ `\([0-9a-f][0-9a-f]*\)`.*/\1/p' "$FORK_SKILL" | sed -n '1p')
[ -n "$PIN" ] || fail "no simple-changelogs provenance pin found in $FORK_SKILL"

PIN_SHA=$(git -C "$UPSTREAM_DIR" rev-parse --verify --end-of-options "$PIN^{commit}" 2>/dev/null) ||
  fail "pinned commit $PIN was not found"
[ -n "$TARGET_REF" ] || TARGET_REF=$(default_ref)
TARGET_SHA=$(git -C "$UPSTREAM_DIR" rev-parse --verify --end-of-options "$TARGET_REF^{commit}" 2>/dev/null) ||
  fail "upstream ref was not found: $TARGET_REF"

if git -C "$UPSTREAM_DIR" merge-base --is-ancestor "$PIN_SHA" "$TARGET_SHA"; then
  :
else
  STATUS=$?
  [ "$STATUS" -eq 1 ] || fail "git merge-base failed"
  echo "error: fork pin $PIN diverges from upstream $TARGET_REF" >&2
  echo "review both histories before changing the provenance pin" >&2
  exit 3
fi

BEHIND=$(git -C "$UPSTREAM_DIR" rev-list --count "$PIN_SHA..$TARGET_SHA" -- "$UPSTREAM_SKILL_PATH")
if [ "$BEHIND" -eq 0 ]; then
  echo "release-note fork is current with $TARGET_REF @ $PIN"
  exit 0
fi

echo "release-note fork pin: $PIN"
echo "upstream $TARGET_REF has $BEHIND newer commit(s):"
git -C "$UPSTREAM_DIR" log --oneline "$PIN_SHA..$TARGET_SHA" -- "$UPSTREAM_SKILL_PATH"
echo "changed files:"
git -C "$UPSTREAM_DIR" diff --stat "$PIN_SHA..$TARGET_SHA" -- "$UPSTREAM_SKILL_PATH"
echo "review the diff, preserve local deltas, then update the pin to:"
git -C "$UPSTREAM_DIR" rev-parse --short "$TARGET_SHA"
exit 1
