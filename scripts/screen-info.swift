import AppKit
let rows: [[String: Any]] = NSScreen.screens.map { screen in
    let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber ?? 0
    var width: CGFloat = 0
    var height: CGFloat = 0
    if #available(macOS 12.0, *) {
        height = screen.safeAreaInsets.top
        if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            width = right.minX - left.maxX
        }
    }
    return ["id": id, "width": width, "height": height]
}
let data = try JSONSerialization.data(withJSONObject: rows)
print(String(data: data, encoding: .utf8)!)
