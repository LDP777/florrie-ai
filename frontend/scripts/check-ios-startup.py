#!/usr/bin/env python3
"""Block the iOS 27 launch failure before another archive is uploaded."""
import json
import plistlib
from pathlib import Path

frontend = Path(__file__).resolve().parents[1]
app = frontend / "ios/App"
info = plistlib.loads((app / "App/Info.plist").read_bytes())
manifest = info.get("UIApplicationSceneManifest", {})
scenes = manifest.get("UISceneConfigurations", {}).get("UIWindowSceneSessionRoleApplication", [])
assert scenes, "iOS startup requires an application scene configuration"
assert manifest.get("UIApplicationSupportsMultipleScenes") is False, "Florrie uses one window"
assert len(scenes) == 1, "Expected one application scene configuration"
assert scenes[0].get("UISceneDelegateClassName") == "$(PRODUCT_MODULE_NAME).SceneDelegate"
assert scenes[0].get("UISceneConfigurationName") == "Default Configuration"
assert "UISceneStoryboardFile" not in scenes[0], "SceneDelegate creates the only bridge in code"
assert "UIMainStoryboardFile" not in info, "Do not also load a legacy storyboard window"

project = (app / "App.xcodeproj/project.pbxproj").read_text()
sources = project.split("/* Begin PBXSourcesBuildPhase section */")[1].split("/* End PBXSourcesBuildPhase section */")[0]
assert "SceneDelegate.swift in Sources" in sources, "The scene delegate must compile into the App target"
assert "configurationForConnecting" in (app / "App/AppDelegate.swift").read_text()
scene_delegate = (app / "App/SceneDelegate.swift").read_text()
for callback in ("willConnectTo:", "openURLContexts:", "continue:"):
    assert f"SceneDelegateProxy.shared.scene(scene, {callback}" in scene_delegate, f"Missing Capacitor scene callback: {callback}"

packages = json.loads((frontend / "package.json").read_text())
versions = [packages["dependencies"][name] for name in ("@capacitor/core", "@capacitor/ios")]
versions.append(packages["devDependencies"]["@capacitor/cli"])
assert len(set(versions)) == 1, "Use matching Capacitor core, iOS and CLI versions"
version = tuple(map(int, versions[0].split(".")))
assert version >= (8, 5, 0), "Scene support requires Capacitor 8.5 or newer"
print("iOS startup configuration: scene lifecycle, link forwarding and runtime versions passed")
