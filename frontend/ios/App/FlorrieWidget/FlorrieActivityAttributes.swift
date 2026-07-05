import ActivityKit
import Foundation

// Shared between the app (starts/updates the activity) and the widget
// extension (renders it). This file must belong to BOTH targets in Xcode.
struct FlorrieActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var handled: Int        // things Florrie has handled today
        var nextClient: String  // e.g. "Kayleigh"
        var nextTime: String    // e.g. "2pm"
        var status: String      // e.g. "Next: Kayleigh 2pm"
    }

    var salonName: String       // static for the life of the activity
}
