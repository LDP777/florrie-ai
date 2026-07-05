import Foundation
import Capacitor
import ActivityKit

// Capacitor bridge for the "Florrie on the desk" Live Activity. The web app
// calls start() in the morning; iOS hands back an APNs push token (via the
// "token" event) which the app registers with the backend so Florrie can push
// live updates to the strip all day.
@objc(FlorrieLiveActivity)
public class FlorrieLiveActivity: CAPPlugin {

    @objc func start(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else { call.reject("Live Activities need iOS 16.1 or later"); return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            call.reject("Live Activities are turned off in Settings"); return
        }
        let salon = call.getString("salonName") ?? "Florrie"
        let s = call.getObject("state") ?? [:]
        let content = FlorrieActivityAttributes.ContentState(
            handled: s["handled"] as? Int ?? 0,
            nextClient: s["nextClient"] as? String ?? "",
            nextTime: s["nextTime"] as? String ?? "",
            status: s["status"] as? String ?? "On the desk"
        )
        let attributes = FlorrieActivityAttributes(salonName: salon)
        do {
            let activity: Activity<FlorrieActivityAttributes>
            if #available(iOS 16.2, *) {
                activity = try Activity.request(
                    attributes: attributes,
                    content: .init(state: content, staleDate: Date().addingTimeInterval(2 * 60 * 60)),
                    pushType: .token
                )
            } else {
                activity = try Activity.request(attributes: attributes, contentState: content, pushType: .token)
            }
            // Push token can arrive slightly after start and can rotate, so emit
            // it as an event the JS layer listens for.
            Task {
                for await tokenData in activity.pushTokenUpdates {
                    let token = tokenData.map { String(format: "%02x", $0) }.joined()
                    self.notifyListeners("token", data: ["activityId": activity.id, "pushToken": token])
                }
            }
            call.resolve(["activityId": activity.id])
        } catch {
            call.reject("Could not start Live Activity: \(error.localizedDescription)")
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else { call.resolve(); return }
        Task {
            for activity in Activity<FlorrieActivityAttributes>.activities {
                if #available(iOS 16.2, *) {
                    await activity.end(nil, dismissalPolicy: .after(Date().addingTimeInterval(5 * 60)))
                } else {
                    await activity.end(dismissalPolicy: .after(Date().addingTimeInterval(5 * 60)))
                }
            }
            call.resolve()
        }
    }

    @objc func isRunning(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else { call.resolve(["running": false]); return }
        let running = !Activity<FlorrieActivityAttributes>.activities.isEmpty
        call.resolve(["running": running])
    }
}
