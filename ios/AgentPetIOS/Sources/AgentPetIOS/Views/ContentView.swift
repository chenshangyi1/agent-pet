import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: AgentPetStore

    var body: some View {
        ZStack(alignment: .top) {
            TabView(selection: $store.selectedTab) {
                PetDashboardView()
                    .tabItem {
                        Label("小鑫动态", systemImage: "sparkles")
                    }
                    .tag(AppTab.dashboard)

                DirectChatView()
                    .tabItem {
                        Label("对话派活", systemImage: "bubble.left.and.bubble.right.fill")
                    }
                    .tag(AppTab.chat)

                AgentsGridView()
                    .tabItem {
                        Label("AI Agents", systemImage: "cpu.fill")
                    }
                    .tag(AppTab.agents)

                ConnectionSettingsView()
                    .tabItem {
                        Label("连接设置", systemImage: "gearshape.fill")
                    }
                    .tag(AppTab.settings)
            }

            if let banner = store.statusBanner, !banner.isEmpty {
                ToastBannerView(message: banner)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .zIndex(10)
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.85), value: store.statusBanner)
        .task {
            store.startIfNeeded()
        }
    }
}
