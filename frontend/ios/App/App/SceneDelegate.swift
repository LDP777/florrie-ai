import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let appWindow = UIWindow(windowScene: windowScene)
        window = appWindow
        // Plugins that still consult UIApplicationDelegate.window must see the
        // same scene-owned window, rather than creating a second window.
        (UIApplication.shared.delegate as? AppDelegate)?.window = appWindow
        appWindow.rootViewController = CAPBridgeViewController()

        // Register cold-start link delivery before the bridge first appears.
        // Capacitor waits for its plugins to load before forwarding those links.
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        appWindow.makeKeyAndVisible()
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        if let appDelegate = UIApplication.shared.delegate as? AppDelegate,
           appDelegate.window === window {
            appDelegate.window = nil
        }
        window = nil
    }
}
