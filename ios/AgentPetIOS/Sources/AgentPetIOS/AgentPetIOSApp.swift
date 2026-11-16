import SwiftUI

@main
struct AgentPetIOSApp: App {
    @StateObject private var store = AgentPetStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
        }
    }
}
