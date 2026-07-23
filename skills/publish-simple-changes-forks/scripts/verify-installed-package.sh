#!/bin/sh

set -eu

usage() {
  echo "usage: $0 <canonical-skill-directory> <installed-skill-directory>" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage

source_dir=${1%/}
installed_dir=${2%/}

[ -d "$source_dir" ] || {
  echo "canonical skill directory not found: $source_dir" >&2
  exit 2
}

[ -d "$installed_dir" ] || {
  echo "installed skill directory not found: $installed_dir" >&2
  exit 2
}

[ -f "$source_dir/SKILL.md" ] || {
  echo "canonical package is missing root SKILL.md" >&2
  exit 1
}

[ -f "$installed_dir/SKILL.md" ] || {
  echo "installed package is missing root SKILL.md" >&2
  exit 1
}

if find "$source_dir" "$installed_dir" -type l -print | grep -q .; then
  echo "skill packages must not contain symlinks" >&2
  exit 1
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/verify-installed-skill.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

(
  cd "$source_dir"
  find . -type f -print | LC_ALL=C sort
) >"$tmp_dir/source-files"

(
  cd "$installed_dir"
  find . -type f -print | LC_ALL=C sort
) >"$tmp_dir/installed-files"

if ! cmp -s "$tmp_dir/source-files" "$tmp_dir/installed-files"; then
  echo "installed package file tree differs from canonical package" >&2
  diff -u "$tmp_dir/source-files" "$tmp_dir/installed-files" >&2 || true
  exit 1
fi

skill_count=$(
  find "$installed_dir" -type f -name SKILL.md -print | wc -l | tr -d '[:space:]'
)

[ "$skill_count" = "1" ] || {
  echo "installed package must contain exactly one discoverable SKILL.md; found $skill_count" >&2
  exit 1
}

while IFS= read -r relative_path; do
  relative_path=${relative_path#./}
  if ! cmp -s "$source_dir/$relative_path" "$installed_dir/$relative_path"; then
    echo "installed file differs from canonical package: $relative_path" >&2
    exit 1
  fi
done <"$tmp_dir/source-files"

file_count=$(wc -l <"$tmp_dir/source-files" | tr -d '[:space:]')
echo "installed package matches canonical package: $file_count files, 1 discoverable SKILL.md"
