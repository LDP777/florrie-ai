#!/bin/sh

# Xcode Cloud post-clone script for the Florrie Capacitor app.
# The bundled web assets (ios/App/App/public) and the CocoaPods workspace pieces
# are gitignored, so Xcode Cloud must build the Vite web app, copy it into the
# iOS project, and run pod install before the native build. Runs after clone,
# before dependency resolution.

set -e

echo "=== ci_post_clone: building Florrie web bundle + pods for the iOS app ==="

# Node is not preinstalled on Xcode Cloud images — install via Homebrew.
brew install node

# Build the frontend and copy the web assets into ios/App/App/public.
cd "$CI_PRIMARY_REPOSITORY_PATH/frontend"
echo "Node: $(node -v)  npm: $(npm -v)"
npm install
npm run build
npx cap copy ios

# Ensure CocoaPods is available, then install so Pods/Pods.xcodeproj and the
# workspace are fully resolved before xcodebuild runs.
cd "$CI_PRIMARY_REPOSITORY_PATH/frontend/ios/App"
if ! command -v pod >/dev/null 2>&1; then
  echo "CocoaPods not found, installing via Homebrew..."
  brew install cocoapods
fi
pod install

echo "=== ci_post_clone: web assets + pods ready ==="
