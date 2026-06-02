#!/bin/sh

# Xcode Cloud post-clone script for the Florrie Capacitor app.
# The bundled web assets (ios/App/App/public) are gitignored, so Xcode Cloud
# must build the Vite web app and copy it into the iOS project before the
# native build. Runs after the repo is cloned, before dependency resolution.

set -e

echo "=== ci_post_clone: building Florrie web bundle for the iOS app ==="

# Node is not preinstalled on Xcode Cloud images — install via Homebrew.
brew install node

# Build the frontend and copy the web assets into ios/App/App/public.
cd "$CI_PRIMARY_REPOSITORY_PATH/frontend"
echo "Node: $(node -v)  npm: $(npm -v)"
npm install
npm run build
npx cap copy ios

echo "=== ci_post_clone: web assets synced into ios/App/App/public ==="
