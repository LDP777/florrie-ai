import ActivityKit
import WidgetKit
import SwiftUI

// The "Florrie on the desk" Live Activity: an ambient strip on the lock screen
// and in the Dynamic Island while the working day is on.
struct FlorrieWidgetLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: FlorrieActivityAttributes.self) { context in
            // Lock screen / banner
            LockScreenView(state: context.state)
                .activityBackgroundTint(FlorrieBrand.cream)
                .activitySystemActionForegroundColor(FlorrieBrand.maroon)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 8) {
                        FlorrieMark(size: 26)
                        Text("On the desk")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(FlorrieBrand.ink)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    HandledPill(count: context.state.handled)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.state.status)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(FlorrieBrand.maroon)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                FlorrieMark(size: 18)
            } compactTrailing: {
                Text("\(context.state.handled)")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(FlorrieBrand.maroon)
            } minimal: {
                FlorrieMark(size: 16)
            }
            .keylineTint(FlorrieBrand.maroon)
        }
    }
}

private struct HandledPill: View {
    var count: Int
    var body: some View {
        Text("\(count) handled")
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(FlorrieBrand.maroon)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(Capsule().fill(FlorrieBrand.maroon.opacity(0.10)))
    }
}

private struct LockScreenView: View {
    let state: FlorrieActivityAttributes.ContentState
    var body: some View {
        HStack(spacing: 14) {
            FlorrieMark(size: 34)
            VStack(alignment: .leading, spacing: 3) {
                Text("Florrie on the desk")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(FlorrieBrand.ink)
                Text(state.status)
                    .font(.system(size: 14, weight: .regular))
                    .foregroundColor(FlorrieBrand.maroon)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(spacing: 1) {
                Text("\(state.handled)")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundColor(FlorrieBrand.maroon)
                Text("handled")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(FlorrieBrand.ink.opacity(0.55))
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 14)
    }
}
