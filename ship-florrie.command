#!/bin/bash
#
#  Ship Florrie
#  ------------
#  Double-click this in Finder. It applies whatever I last left in
#  ~/ai-company and pushes it, which is what makes the web deploy and the
#  TestFlight build.
#
#  It exists because every ship so far has cost Levi six commands in a
#  terminal, and every one of them failed at least once on the same three
#  things: a stale lock file, an untracked file in the way, and a push with no
#  credential helper. All three are handled below.
#
#  Safe to run twice. If there is nothing new it says so and stops.
#

set -uo pipefail

REPO="$HOME/ai-company/projects/florrie-ai"
BUNDLES="$HOME/ai-company"
KEY="$HOME/ai-company/push-key.txt"
REMOTE="https://github.com/LDP777/florrie-ai.git"

cd "$REPO" 2>/dev/null || { echo "Can't find $REPO"; read -r -p "Press return to close."; exit 1; }

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n  \033[31m✗ %s\033[0m\n\n' "$1"; read -r -p "Press return to close."; exit 1; }

say "Florrie — applying the latest changes and shipping them"

# 1. Stale locks. Two zero-byte files from an editor that died six days ago have
#    blocked every merge since. Only clear one nothing is actually holding.
if pgrep -q -f "git (commit|rebase|merge)" 2>/dev/null; then
  die "A git process is genuinely running. Close it and try again."
fi
for lock in index.lock ORIG_HEAD.lock HEAD.lock; do
  if [ -f ".git/$lock" ]; then rm -f ".git/$lock" && warn "cleared a stale .git/$lock"; fi
done

# 2. The newest bundle, wherever it landed. Downloads first, since that is where
#    Safari and the Claude app put it.
BUNDLE=$(ls -t "$HOME/Downloads"/florrie-*.bundle "$BUNDLES"/florrie-*.bundle 2>/dev/null | head -1)
[ -n "${BUNDLE:-}" ] || die "No florrie-*.bundle found in ~/Downloads or ~/ai-company."
ok "using $(basename "$BUNDLE")"

# 3. A thin bundle needs its base commit, so fetch origin before reading it.
git fetch --quiet origin || die "Could not reach GitHub. Check your connection."
ok "fetched origin"

BRANCH="ship-$(date +%Y%m%d-%H%M%S)"
git fetch --quiet "$BUNDLE" main:"$BRANCH" || die "That bundle does not apply. Ask me for a fresh one."

if git merge-base --is-ancestor "$BRANCH" HEAD 2>/dev/null; then
  ok "already up to date — nothing to ship"
  git branch -D "$BRANCH" >/dev/null 2>&1
  read -r -p "Press return to close."; exit 0
fi

# 4. Untracked files that the incoming commits also contain. Git refuses to
#    clobber them, and it stops at the FIRST one, so move them all aside at once
#    rather than discovering them one merge at a time. Nothing is deleted.
PARK="$HOME/ai-company/_parked/$(date +%Y%m%d-%H%M%S)"
MOVED=0
while IFS= read -r f; do
  if git cat-file -e "$BRANCH:$f" 2>/dev/null; then
    mkdir -p "$PARK/$(dirname "$f")"
    mv "$f" "$PARK/$f" && MOVED=$((MOVED+1))
  fi
done < <(git ls-files --others --exclude-standard)
[ "$MOVED" -gt 0 ] && warn "moved $MOVED untracked file(s) aside into $PARK (nothing deleted)"

say "Merging"
git merge --no-edit "$BRANCH" || die "The merge hit a conflict. Send me the output above."
git branch -d "$BRANCH" >/dev/null 2>&1
ok "merged"

# 5. Push. The remote URL is deliberately clean — the old embedded token leaked
#    once — so the credential comes from the key file at push time.
[ -f "$KEY" ] || die "Missing $KEY. That is the GitHub token; ask me to help you recreate it."
say "Pushing"
if git -c credential.helper="store --file=$KEY" push "$REMOTE" main 2>&1 | sed -E 's#https://[^@ ]*@#https://#g'; then
  ok "pushed"
else
  die "Push failed. If it says the token expired, the key needs renewing (it lapses ~1 Nov 2026)."
fi

say "Done"
cat <<'EOT'
  Vercel is deploying the web app now — about 90 seconds.
  Xcode Cloud has started a build; TestFlight in roughly an hour.

  Watch the build:  https://appstoreconnect.apple.com  ->  Florrie  ->  Xcode Cloud
  Only "Untitled Workflow" delivers to TestFlight. A red mark on "Default"
  means nothing.
EOT
echo
read -r -p "Press return to close."
