#!/bin/sh

# Xcode Cloud pre-build script: stamp each build with a unique, incrementing
# build number (Xcode Cloud's CI_BUILD_NUMBER) so every auto-build triggered by
# a push to main uploads to TestFlight/App Store Connect without a collision.

set -e

if [ -n "$CI_BUILD_NUMBER" ]; then
  cd "$CI_PRIMARY_REPOSITORY_PATH/frontend/ios/App"
  echo "Setting build number to CI_BUILD_NUMBER=$CI_BUILD_NUMBER"
  xcrun agvtool new-version -all "$CI_BUILD_NUMBER"
fi
