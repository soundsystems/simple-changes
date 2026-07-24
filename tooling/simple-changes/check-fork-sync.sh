#!/bin/sh
# Compare a downstream Simple Changes fork pin with an authoritative upstream ref.

set -eu

usage() {
  echo "usage: check-fork-sync.sh <fork-SKILL.md> [upstream-repo] [upstream-ref]" >&2
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

[ "$#" -ge 1 ] && [ "$#" -le 3 ] || usage

FORK_SKILL=$1
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
UPSTREAM_DIR=${2:-$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)}
UPSTREAM_SKILL_PATH=skills/simple-changes

[ -f "$FORK_SKILL" ] || fail "no such file: $FORK_SKILL"
git -C "$UPSTREAM_DIR" rev-parse --git-dir >/dev/null 2>&1 ||
  fail "not a Git repository: $UPSTREAM_DIR"

PIN=$(sed -n 's/.*Forked from `simple-changes` @ `\([0-9a-f][0-9a-f]*\)`.*/\1/p' "$FORK_SKILL" | sed -n '1p')
[ -n "$PIN" ] || {
  echo "error: no provenance pin found in $FORK_SKILL" >&2
  echo "expected: Forked from \`simple-changes\` @ \`<sha>\`" >&2
  exit 2
}

PIN_SHA=$(git -C "$UPSTREAM_DIR" rev-parse --verify --end-of-options "$PIN^{commit}" 2>/dev/null) ||
  fail "pinned commit $PIN was not found"
TARGET_REF=${3:-$(default_ref)}
TARGET_SHA=$(git -C "$UPSTREAM_DIR" rev-parse --verify --end-of-options "$TARGET_REF^{commit}" 2>/dev/null) ||
  fail "upstream ref was not found: $TARGET_REF"

if git -C "$UPSTREAM_DIR" merge-base --is-ancestor "$PIN_SHA" "$TARGET_SHA"; then
  :
else
  STATUS=$?
  [ "$STATUS" -eq 1 ] || fail "git merge-base failed while comparing $PIN with $TARGET_REF"
  echo "error: fork pin $PIN diverges from upstream $TARGET_REF" >&2
  echo "review both histories before changing the provenance pin" >&2
  exit 3
fi

BEHIND=$(git -C "$UPSTREAM_DIR" rev-list --count "$PIN_SHA..$TARGET_SHA" -- "$UPSTREAM_SKILL_PATH")
if [ "$BEHIND" -eq 0 ]; then
  echo "fork is current with upstream $TARGET_REF ($UPSTREAM_SKILL_PATH @ $PIN)"
  exit 0
fi

echo "fork pin: $PIN - upstream $TARGET_REF has $BEHIND newer commit(s) touching $UPSTREAM_SKILL_PATH:"
echo
git -C "$UPSTREAM_DIR" log --oneline "$PIN_SHA..$TARGET_SHA" -- "$UPSTREAM_SKILL_PATH"
echo
echo "changed files:"
git -C "$UPSTREAM_DIR" diff --stat "$PIN_SHA..$TARGET_SHA" -- "$UPSTREAM_SKILL_PATH"
echo
echo "next steps: review the diff, preserve fork-specific deltas, port applicable changes,"
echo "then update the fork pin to:"
git -C "$UPSTREAM_DIR" rev-parse --short "$TARGET_SHA"
exit 1
