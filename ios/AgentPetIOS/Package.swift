// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AgentPetIOS",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .executable(
            name: "AgentPetIOS",
            targets: ["AgentPetIOS"]
        ),
    ],
    targets: [
        .executableTarget(
            name: "AgentPetIOS",
            path: "Sources/AgentPetIOS"
        ),
    ]
)
