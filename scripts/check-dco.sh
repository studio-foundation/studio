#!/usr/bin/env bash
# Fails when a commit in <base>..<head> carries no Signed-off-by trailer matching its author.
set -euo pipefail

base="${1:?usage: check-dco.sh <base> <head>}"
head="${2:?usage: check-dco.sh <base> <head>}"

failed=0
for sha in $(git rev-list --no-merges "$base..$head"); do
  author="$(git show -s --format='%an <%ae>' "$sha")"
  if git show -s --format='%B' "$sha" | grep -qiF "Signed-off-by: $author"; then
    continue
  fi
  echo "missing 'Signed-off-by: $author' — $(git show -s --format='%h %s' "$sha")"
  failed=1
done

if [ "$failed" -ne 0 ]; then
  echo
  echo "Sign off with 'git commit -s', or fix existing commits with:"
  echo "  git rebase --signoff $base"
fi

exit "$failed"
