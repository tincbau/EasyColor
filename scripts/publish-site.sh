#!/usr/bin/env bash
set -uo pipefail
cd /home/user/EasyColor

EASYCOLOR_BASE=/EasyColor/ npm run build:web >/dev/null 2>&1 || { echo "build failed"; exit 1; }

SITE=$(mktemp -d)
cp -r packages/web/dist/* "$SITE"/
touch "$SITE"/.nojekyll
cp "$SITE"/index.html "$SITE"/404.html

WT=$(mktemp -d)
# A unique branch name each time: `--orphan gh-pages` fails outright once a
# local gh-pages exists, and the failure is easy to miss because the push
# afterwards reports "Everything up-to-date" on the stale ref.
TMPBRANCH="site-$(date +%s)"

git worktree add --detach "$WT" >/dev/null 2>&1
cd "$WT"
git checkout --orphan "$TMPBRANCH" >/dev/null 2>&1 || { echo "orphan checkout failed"; exit 1; }
git rm -rf . >/dev/null 2>&1
cp -r "$SITE"/. .
git add -A
git commit -q -F - <<'MSG'
Publish the EasyColor web app

Built from main with the /EasyColor/ base path GitHub Pages serves a
project site from. Includes .nojekyll, because Pages runs Jekyll by
default and it mangles asset directories, and a 404.html copy of
index.html so deep links resolve in a single-page app.

Regenerate with:  EASYCOLOR_BASE=/EasyColor/ npm run build:web

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015cHByk8aXKHHpwwpFLEbWp
MSG
echo "site commit: $(git rev-parse --short HEAD)  files: $(git ls-files | wc -l)"
git push -f origin "HEAD:gh-pages" 2>&1 | tail -2

cd /home/user/EasyColor
git worktree remove --force "$WT"
git branch -D "$TMPBRANCH" >/dev/null 2>&1
