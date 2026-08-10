#!/usr/bin/env bash
#
# Publish web/ to GitHub Pages at https://eagerkoder.github.io/mini/
#
#   ./web/deploy.sh          # or: make deploy-web
#
# A fresh clone every run, deliberately. There is no cached checkout to go stale, drift, or need
# reconciling after the other side is force-pushed — the target is three files, so the clone costs
# about a second and buys the property that a deploy can never be wrong because of local state.
#
# Neither `git subtree push` nor a worktree fits: subtree lands the prefix at the target's *root*,
# not under mini/, and cannot add .nojekyll or keep the repo owner's README; a worktree only spans
# checkouts of one repo, so using it here would mean carrying an unrelated site's history in this
# repo's object store.
#
# The deploy owns mini/ and nothing else. --delete is scoped to that directory, so the repo root
# and anything the owner puts beside us survives every run.
set -euo pipefail

REPO="${HERDR_PAGES_REPO:-https://github.com/eagerkoder/eagerkoder.github.io.git}"
BRANCH="${HERDR_PAGES_BRANCH:-main}"
SUBDIR="${HERDR_PAGES_SUBDIR:-mini}"

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$src/.." && pwd)"

command -v rsync >/dev/null || { echo "deploy: rsync not found" >&2; exit 1; }

sha="$(git -C "$root" rev-parse --short HEAD)"
# A dirty tree still deploys — that is often the point of a preview push — but the commit message
# must not claim the pushed bytes are what that SHA contains.
dirty=""
git -C "$root" diff --quiet HEAD -- "$src" || dirty=" + uncommitted changes"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "deploy: cloning $REPO ($BRANCH)"
git clone --quiet --branch "$BRANCH" "$REPO" "$work/site"

dest="$work/site/$SUBDIR"
mkdir -p "$dest"
rsync -a --delete \
  --exclude 'deploy.sh' \
  --exclude '.wrangler' \
  --exclude '.DS_Store' \
  "$src/" "$dest/"

# Pages runs the site through Jekyll unless told otherwise, which skips any file beginning with an
# underscore and adds a build step this app has no use for. Site-wide, so it lives at the root.
touch "$work/site/.nojekyll"

cd "$work/site"
git add -A
if git diff --cached --quiet; then
  echo "deploy: $SUBDIR/ already matches $sha — nothing to push"
  exit 0
fi

git commit --quiet -m "Deploy herdr-remote web app ($sha$dirty)"
git push --quiet origin "$BRANCH"
echo "deploy: pushed $sha$dirty -> https://eagerkoder.github.io/$SUBDIR/"
