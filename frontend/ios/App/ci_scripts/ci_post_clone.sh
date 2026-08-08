#!/bin/sh

# Xcode Cloud post-clone script for the Florrie Capacitor app.
# The bundled web assets (ios/App/App/public) and the CocoaPods workspace pieces
# are gitignored, so Xcode Cloud must build the Vite web app, copy it into the
# iOS project, and run pod install before the native build. Runs after clone,
# before dependency resolution.

set -e

echo "=== ci_post_clone: building Florrie web bundle + pods for the iOS app ==="

# Homebrew auto-updates on first use, which cost ~20s of every build and once
# left a stashed working tree behind. We do not need a newer Homebrew to install
# node.
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_ENV_HINTS=1
# CocoaPods phones home with build stats on every install. One less network
# call that can hang.
export COCOAPODS_DISABLE_STATS=1

# Node is not preinstalled on Xcode Cloud images — install via Homebrew.
brew install node

# Build the frontend and copy the web assets into ios/App/App/public.
cd "$CI_PRIMARY_REPOSITORY_PATH/frontend"
echo "Node: $(node -v)  npm: $(npm -v)"
npm install
npm run build
npx cap copy ios

# Ensure CocoaPods is available.
cd "$CI_PRIMARY_REPOSITORY_PATH/frontend/ios/App"
if ! command -v pod >/dev/null 2>&1; then
  echo "CocoaPods not found, installing via Homebrew..."
  brew install cocoapods
fi

# `pod install` resolves the podspecs over https://cdn.cocoapods.org, and that
# CDN drops connections. Build 670 died on exactly this and never reached
# TestFlight, while the identical commit built fine minutes earlier:
#
#   [!] Couldn't determine repo type for URL: `https://cdn.cocoapods.org/`:
#       Connection reset by peer - SSL_connect
#
# It is transient, so retry rather than fail the build. Five attempts with a
# widening gap covers a CDN blip without hanging a build for long; if the CDN is
# genuinely down, failing after ~2 minutes is the correct outcome.
install_pods() {
  attempt=1
  max=5
  while [ "$attempt" -le "$max" ]; do
    if pod install; then
      echo "pod install succeeded on attempt $attempt"
      return 0
    fi
    if [ "$attempt" -eq "$max" ]; then
      break
    fi
    wait=$((attempt * 12))
    echo "pod install failed (attempt $attempt of $max). CocoaPods CDN is flaky; retrying in ${wait}s..."
    sleep "$wait"
    # A stale or half-written spec cache makes the next attempt fail the same
    # way, so clear it before trying again.
    rm -rf "$HOME/Library/Caches/CocoaPods/CDN" 2>/dev/null || true
    attempt=$((attempt + 1))
  done

  # Last resort: the CDN is the flaky part, not CocoaPods. --repo-update forces
  # a full spec refresh over a different code path.
  echo "Falling back to pod install --repo-update"
  pod install --repo-update
}

install_pods

echo "=== ci_post_clone: web assets + pods ready ==="
