import XCTest
import UIKit
import WebKit
import Capacitor
@testable import App

@MainActor
final class FlorrieStartupTests: XCTestCase {
    private func appScene() throws -> UIWindowScene {
        try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first {
            $0.session.role == .windowApplication && $0.delegate is SceneDelegate
        })
    }

    private func bridgeController() throws -> CAPBridgeViewController {
        let delegate = try XCTUnwrap(try appScene().delegate as? SceneDelegate)
        return try XCTUnwrap(delegate.window?.rootViewController as? CAPBridgeViewController)
    }

    private func waitForJS(_ condition: String, in webView: WKWebView) async throws {
        for _ in 0..<100 {
            if (try? await webView.evaluateJavaScript(condition)) as? Bool == true { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("Native web view did not satisfy: \(condition)")
    }

    func testLaunchCreatesOneSceneAndRendersBundledApp() async throws {
        let scene = try appScene()
        let delegate = try XCTUnwrap(scene.delegate as? SceneDelegate)
        let controller = try bridgeController()
        let webView = try XCTUnwrap(controller.webView)
        XCTAssertTrue(delegate.window?.windowScene === scene)
        XCTAssertTrue(UIApplication.shared.delegate?.window.flatMap { $0 } === delegate.window)
        XCTAssertEqual(scene.windows.filter { $0.rootViewController is CAPBridgeViewController }.count, 1)
        XCTAssertEqual(controller.bridge?.config.serverURL.scheme, "capacitor")
        try await waitForJS("document.readyState === 'complete' && document.getElementById('root')?.children.length > 0", in: webView)
        for plugin in ["App", "Browser", "SignInWithApple", "PushNotifications", "SplashScreen", "StatusBar", "Haptics"] {
            let available = try await webView.evaluateJavaScript("window.Capacitor.isPluginAvailable('\(plugin)')")
            XCTAssertTrue(available as? Bool == true, plugin)
        }
        // CSS owns the safe area; a second native top inset would shift every page.
        XCTAssertEqual(webView.scrollView.contentInsetAdjustmentBehavior, .never)
        XCTAssertEqual(webView.frame.minY, 0, accuracy: 1)
    }

    func testUniversalLinkReachesJavascriptAndLaunchURL() async throws {
        let scene = try appScene()
        let delegate = try XCTUnwrap(scene.delegate as? SceneDelegate)
        let webView = try XCTUnwrap(try bridgeController().webView)
        try await waitForJS("!!window.Capacitor?.Plugins.App", in: webView)
        _ = try await webView.evaluateJavaScript("window.__startupLink = ''; window.Capacitor.Plugins.App.addListener('appUrlOpen', event => { window.__startupLink = event.url; }); true")
        let url = try XCTUnwrap(URL(string: "https://florrie.ai/updates?startup-test=1"))
        let activity = NSUserActivity(activityType: NSUserActivityTypeBrowsingWeb)
        activity.webpageURL = url
        delegate.scene(scene, continue: activity)
        try await waitForJS("window.__startupLink === '\(url.absoluteString)'", in: webView)
        XCTAssertEqual(ApplicationDelegateProxy.shared.lastURL, url)
        _ = try await webView.evaluateJavaScript("window.Capacitor.Plugins.App.getLaunchUrl().then(result => { window.__startupLaunchURL = result.url; }); true")
        try await waitForJS("window.__startupLaunchURL === '\(url.absoluteString)'", in: webView)
    }

    func testCustomURLReturnsThroughTheSystemSceneRouter() async throws {
        let webView = try XCTUnwrap(try bridgeController().webView)
        try await waitForJS("!!window.Capacitor?.Plugins.App", in: webView)
        _ = try await webView.evaluateJavaScript("window.__startupCustomURL = ''; window.Capacitor.Plugins.App.addListener('appUrlOpen', event => { window.__startupCustomURL = event.url; }); true")
        let url = try XCTUnwrap(URL(string: "ai.florrie.app://startup-check"))
        let opened = await UIApplication.shared.open(url)
        XCTAssertTrue(opened)
        try await waitForJS("window.__startupCustomURL === '\(url.absoluteString)'", in: webView)
        XCTAssertEqual(ApplicationDelegateProxy.shared.lastURL, url)
    }

    func testSceneBackgroundAndForegroundReachJavascript() async throws {
        let scene = try appScene()
        let webView = try XCTUnwrap(try bridgeController().webView)
        try await waitForJS("!!window.Capacitor", in: webView)
        _ = try await webView.evaluateJavaScript("window.__startupEvents = []; document.addEventListener('pause', () => window.__startupEvents.push('pause')); document.addEventListener('resume', () => window.__startupEvents.push('resume')); true")
        NotificationCenter.default.post(name: UIScene.didEnterBackgroundNotification, object: scene)
        try await waitForJS("window.__startupEvents.includes('pause')", in: webView)
        NotificationCenter.default.post(name: UIScene.willEnterForegroundNotification, object: scene)
        try await waitForJS("window.__startupEvents.includes('resume')", in: webView)
    }

    func testBrowserPresentsInsideTheAppScene() async throws {
        let controller = try bridgeController()
        let webView = try XCTUnwrap(controller.webView)
        try await waitForJS("!!window.Capacitor?.Plugins.Browser", in: webView)
        _ = try await webView.evaluateJavaScript("window.Capacitor.Plugins.Browser.open({url: 'https://florrie.ai/privacy'}); true")
        for _ in 0..<100 {
            if controller.presentedViewController != nil { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let browser = try XCTUnwrap(controller.presentedViewController)
        XCTAssertTrue(browser.view.window?.windowScene === controller.view.window?.windowScene)
        _ = try await webView.evaluateJavaScript("window.Capacitor.Plugins.Browser.close(); true")
    }
}
