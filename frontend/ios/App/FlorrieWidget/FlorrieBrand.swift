import SwiftUI

// Florrie brand tokens + the five-petal bloom, drawn in SwiftUI so the widget
// carries no image assets.
enum FlorrieBrand {
    static let maroon = Color(red: 0.573, green: 0.251, blue: 0.369) // #92405E
    static let rose   = Color(red: 0.780, green: 0.420, blue: 0.541) // #C76B8A
    static let gold   = Color(red: 0.788, green: 0.663, blue: 0.431) // #C9A96E
    static let cream  = Color(red: 0.984, green: 0.965, blue: 0.945) // #FBF6F1
    static let ink    = Color(red: 0.165, green: 0.106, blue: 0.122) // #2A171F
}

struct FlorrieMark: View {
    var size: CGFloat = 22
    private let opacities: [Double] = [0.9, 0.72, 0.6, 0.6, 0.72]
    var body: some View {
        ZStack {
            ForEach(0..<5, id: \.self) { i in
                Ellipse()
                    .fill(FlorrieBrand.rose.opacity(opacities[i]))
                    .frame(width: size * 0.30, height: size * 0.46)
                    .offset(y: -size * 0.23)
                    .rotationEffect(.degrees(Double(i) * 72))
            }
            Circle()
                .fill(FlorrieBrand.gold)
                .frame(width: size * 0.17, height: size * 0.17)
        }
        .frame(width: size, height: size)
    }
}
