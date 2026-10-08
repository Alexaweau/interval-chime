#!/usr/bin/env bash
# One-time publish to GitHub Pages. Prereq: `gh auth login` (GitHub CLI) completed.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${1:-interval-chime}"
gh auth status >/dev/null
OWNER="$(gh api user -q .login)"
if ! gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  gh repo create "$REPO" --public --description "Interval Chime: workout interval chime timer PWA" --source . --remote origin --push
else
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$OWNER/$REPO.git"
  git push -u origin main
fi
gh api -X POST "repos/$OWNER/$REPO/pages" -f 'source[branch]=main' -f 'source[path]=/' >/dev/null 2>&1 \
  || gh api -X PUT "repos/$OWNER/$REPO/pages" -f 'source[branch]=main' -f 'source[path]=/' >/dev/null
echo "Pages URL: https://$OWNER.github.io/$REPO/  (first build takes ~1 min)"
