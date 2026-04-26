// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "agent-control-macos",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "agent-control",
            path: "Sources",
            swiftSettings: [.unsafeFlags(["-parse-as-library"])],
            linkerSettings: [
                .unsafeFlags(["-F", "/System/Library/PrivateFrameworks", "-framework", "SkyLight"])
            ]
        )
    ]
)
