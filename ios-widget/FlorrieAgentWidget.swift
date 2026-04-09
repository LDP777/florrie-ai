/**
 * FlorrieAgentWidget — iOS 17+ WidgetKit extension.
 *
 * Shows 6 little agent avatars with live status on the home screen.
 * Fetches from GET /api/agents/widget every 15 minutes.
 *
 * Supports:
 *   - systemSmall: 2×3 avatar grid with headline
 *   - systemMedium: 3×2 grid with names + micro status
 *   - accessoryRectangular (Lock Screen): headline + active count
 *
 * Requires:
 *   - WidgetKit target added in Xcode
 *   - Shared Keychain group for auth token (from Capacitor app)
 *   - App Group for shared UserDefaults (widget ↔ app)
 */

import WidgetKit
import SwiftUI

// MARK: — Data Models

struct AgentData: Codable, Identifiable {
    let id: String
    let name: String
    let avatar: String
    let colour: String
    let isActive: Bool
    let count: Int
    let micro: String // "2h", "15m", "—"
}

struct WidgetPayload: Codable {
    let agents: [AgentData]
    let headline: String
    let updatedAt: String
}

// MARK: — Timeline Provider

struct AgentTimelineProvider: TimelineProvider {

    // Placeholder for widget gallery
    func placeholder(in context: Context) -> AgentEntry {
        AgentEntry(
            date: Date(),
            agents: Self.placeholderAgents,
            headline: "Your AI team is working"
        )
    }

    // Snapshot for widget gallery preview
    func getSnapshot(in context: Context, completion: @escaping (AgentEntry) -> Void) {
        completion(placeholder(in: context))
    }

    // Real data fetch
    func getTimeline(in context: Context, completion: @escaping (Timeline<AgentEntry>) -> Void) {
        Task {
            do {
                let payload = try await fetchWidgetData()
                let entry = AgentEntry(
                    date: Date(),
                    agents: payload.agents,
                    headline: payload.headline
                )
                // Refresh every 15 minutes
                let nextUpdate = Calendar.current.date(byAdding: .minute, value: 15, to: Date())!
                let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
                completion(timeline)
            } catch {
                // On error, show stale data and retry in 5 minutes
                let entry = AgentEntry(
                    date: Date(),
                    agents: Self.placeholderAgents,
                    headline: "Couldn't reach your team"
                )
                let retry = Calendar.current.date(byAdding: .minute, value: 5, to: Date())!
                let timeline = Timeline(entries: [entry], policy: .after(retry))
                completion(timeline)
            }
        }
    }

    // MARK: — Network

    private func fetchWidgetData() async throws -> WidgetPayload {
        // Read auth token from shared App Group UserDefaults
        // (Capacitor app writes token here on login)
        let defaults = UserDefaults(suiteName: "group.ai.florrie.app")
        let token = defaults?.string(forKey: "authToken") ?? ""

        guard let url = URL(string: "https://api.florrie.ai/api/agents/widget") else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }

        let decoder = JSONDecoder()
        return try decoder.decode(WidgetPayload.self, from: data)
    }

    // MARK: — Placeholder Data

    static let placeholderAgents: [AgentData] = [
        AgentData(id: "front_desk", name: "Front Desk", avatar: "💬", colour: "#C76B8A", isActive: true, count: 3, micro: "2m"),
        AgentData(id: "content_creator", name: "Content", avatar: "🎨", colour: "#D4943A", isActive: true, count: 1, micro: "1h"),
        AgentData(id: "client_intel", name: "Intel", avatar: "🔮", colour: "#7B6BA8", isActive: false, count: 0, micro: "—"),
        AgentData(id: "business_coach", name: "Coach", avatar: "📊", colour: "#5BA97B", isActive: true, count: 1, micro: "3h"),
        AgentData(id: "scheduler", name: "Scheduler", avatar: "📅", colour: "#4A90D9", isActive: false, count: 0, micro: "—"),
        AgentData(id: "guardian", name: "Guardian", avatar: "🛡️", colour: "#C9A96E", isActive: true, count: 2, micro: "45m"),
    ]
}

// MARK: — Timeline Entry

struct AgentEntry: TimelineEntry {
    let date: Date
    let agents: [AgentData]
    let headline: String
}

// MARK: — Widget Views

struct AgentAvatarView: View {
    let agent: AgentData
    let compact: Bool

    var body: some View {
        VStack(spacing: compact ? 2 : 4) {
            ZStack {
                // Pulse ring for active agents
                if agent.isActive {
                    Circle()
                        .stroke(Color(hex: agent.colour).opacity(0.3), lineWidth: 2)
                        .frame(width: compact ? 30 : 38, height: compact ? 30 : 38)
                }

                // Avatar circle
                Circle()
                    .fill(agent.isActive
                          ? Color(hex: agent.colour).opacity(0.1)
                          : Color.gray.opacity(0.1))
                    .frame(width: compact ? 26 : 34, height: compact ? 26 : 34)
                    .overlay(
                        Text(agent.avatar)
                            .font(.system(size: compact ? 12 : 16))
                    )

                // Count badge
                if agent.count > 0 {
                    Text("\(agent.count)")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 3)
                        .background(Color(hex: agent.colour))
                        .clipShape(Capsule())
                        .offset(x: compact ? 10 : 14, y: compact ? -10 : -14)
                }
            }

            if !compact {
                Text(agent.name)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundColor(agent.isActive ? .primary : .secondary)
                    .lineLimit(1)
            }
        }
    }
}

// Small widget: 2×3 grid
struct SmallWidgetView: View {
    let entry: AgentEntry

    var body: some View {
        VStack(spacing: 8) {
            // Headline
            HStack {
                Text("✦")
                    .font(.system(size: 10))
                    .foregroundColor(Color(hex: "#C76B8A"))
                Text("Your AI Team")
                    .font(.system(size: 11, weight: .semibold))
                Spacer()
            }

            // 2×3 grid
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
                GridItem(.flexible())
            ], spacing: 6) {
                ForEach(entry.agents) { agent in
                    AgentAvatarView(agent: agent, compact: true)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(12)
    }
}

// Medium widget: 3×2 with names + status
struct MediumWidgetView: View {
    let entry: AgentEntry

    var body: some View {
        VStack(spacing: 6) {
            // Header
            HStack {
                Text("✦")
                    .font(.system(size: 11))
                    .foregroundColor(Color(hex: "#C76B8A"))
                Text("Your AI Team")
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                Text(entry.headline)
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
            }

            // 3×2 grid
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
                GridItem(.flexible())
            ], spacing: 8) {
                ForEach(entry.agents) { agent in
                    HStack(spacing: 6) {
                        AgentAvatarView(agent: agent, compact: true)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(agent.name)
                                .font(.system(size: 10, weight: .medium))
                                .lineLimit(1)
                            Text(agent.micro)
                                .font(.system(size: 9))
                                .foregroundColor(.secondary)
                        }
                    }
                }
            }
        }
        .padding(14)
    }
}

// Lock Screen rectangular widget
struct LockScreenWidgetView: View {
    let entry: AgentEntry

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("florrie.ai")
                    .font(.system(size: 11, weight: .bold))
                Text(entry.headline)
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
            }
            Spacer()
            // Mini avatars in a row
            HStack(spacing: -4) {
                ForEach(entry.agents.filter { $0.isActive }.prefix(4)) { agent in
                    Text(agent.avatar)
                        .font(.system(size: 12))
                        .padding(3)
                        .background(Circle().fill(Color.gray.opacity(0.2)))
                }
            }
        }
    }
}

// MARK: — Widget Definition

@main
struct FlorrieAgentWidget: Widget {
    let kind = "FlorrieAgentWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: AgentTimelineProvider()) { entry in
            if #available(iOS 17.0, *) {
                SmallWidgetView(entry: entry)
                    .containerBackground(.fill.tertiary, for: .widget)
            } else {
                SmallWidgetView(entry: entry)
                    .padding()
                    .background(Color(UIColor.systemBackground))
            }
        }
        .configurationDisplayName("AI Team Status")
        .description("See what your Florrie agents are up to right now.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

// MARK: — Color Extension

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 6:
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8:
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (255, 0, 0, 0)
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: Double(a) / 255
        )
    }
}

// MARK: — Preview

#Preview("Small", as: .systemSmall) {
    FlorrieAgentWidget()
} timeline: {
    AgentEntry(
        date: Date(),
        agents: AgentTimelineProvider.placeholderAgents,
        headline: "4/6 active · 7 actions"
    )
}

#Preview("Medium", as: .systemMedium) {
    FlorrieAgentWidget()
} timeline: {
    AgentEntry(
        date: Date(),
        agents: AgentTimelineProvider.placeholderAgents,
        headline: "4/6 active · 7 actions"
    )
}
