import XCTest

/// Minimal XCUITest runner for agent-control
/// Reads commands from /tmp/agent-control-cmd.json, executes, writes result to /tmp/agent-control-result.json
final class SimDriverUITests: XCTestCase {
    
    override func setUp() {
        continueAfterFailure = true
    }
    
    func testRunCommand() throws {
        let cmdPath = "/tmp/agent-control-cmd.json"
        let resultPath = "/tmp/agent-control-result.json"
        
        guard FileManager.default.fileExists(atPath: cmdPath),
              let data = FileManager.default.contents(atPath: cmdPath),
              let cmd = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let action = cmd["action"] as? String else {
            writeResult(["ok": false, "error": "no command file or invalid format"])
            return
        }
        
        // Target app - if bundleId specified, use it; otherwise use springboard
        let bundleId = cmd["bundleId"] as? String ?? "com.apple.springboard"
        let app: XCUIApplication
        if bundleId == "com.apple.springboard" {
            app = XCUIApplication(bundleIdentifier: bundleId)
        } else {
            app = XCUIApplication(bundleIdentifier: bundleId)
            // Don't launch/activate — just attach to running app
        }
        
        switch action {
        case "tap":
            if let ref = cmd["ref"] as? String {
                // Find element by accessibility identifier or label
                let element = findElement(in: app, ref: ref)
                if let el = element, el.exists {
                    el.tap()
                    writeResult(["ok": true, "action": "tap", "ref": ref])
                } else {
                    // Try coordinate tap
                    if let x = cmd["x"] as? Double, let y = cmd["y"] as? Double {
                        let coord = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
                        coord.tap()
                        writeResult(["ok": true, "action": "tap", "x": x, "y": y])
                    } else {
                        writeResult(["ok": false, "error": "element not found: \(ref)"])
                    }
                }
            } else if let x = cmd["x"] as? Double, let y = cmd["y"] as? Double {
                let coord = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
                coord.tap()
                writeResult(["ok": true, "action": "tap", "x": x, "y": y])
            } else {
                writeResult(["ok": false, "error": "tap requires ref or x,y"])
            }
            
        case "type", "text":
            let text = cmd["text"] as? String ?? ""
            // If ref specified, tap it first to focus
            if let ref = cmd["ref"] as? String {
                let element = findElement(in: app, ref: ref)
                if let el = element, el.exists {
                    el.tap()
                    Thread.sleep(forTimeInterval: 0.5)
                    el.typeText(text)
                    writeResult(["ok": true, "action": "type", "ref": ref, "text": text])
                } else {
                    writeResult(["ok": false, "error": "element not found: \(ref)"])
                }
            } else if let x = cmd["x"] as? Double, let y = cmd["y"] as? Double {
                // Tap coordinate first to focus
                let coord = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
                coord.tap()
                Thread.sleep(forTimeInterval: 0.5)
                // Find the text field and use it directly
                let textField = app.textFields.firstMatch
                if textField.exists {
                    textField.tap()
                    Thread.sleep(forTimeInterval: 0.5)
                    textField.typeText(text)
                } else {
                    app.typeText(text)
                }
                writeResult(["ok": true, "action": "type", "x": x, "y": y, "text": text])
            } else {
                // Just type into current first responder
                let textField = app.textFields.firstMatch
                if textField.exists && textField.isHittable {
                    textField.tap()
                    Thread.sleep(forTimeInterval: 0.3)
                    textField.typeText(text)
                } else {
                    app.typeText(text)
                }
                writeResult(["ok": true, "action": "type", "text": text])
            }
            
        case "fill":
            // Clear field then type
            let text = cmd["text"] as? String ?? ""
            if let ref = cmd["ref"] as? String {
                let element = findElement(in: app, ref: ref)
                if let el = element, el.exists {
                    el.tap()
                    Thread.sleep(forTimeInterval: 0.2)
                    // Select all and delete
                    el.press(forDuration: 1.0)
                    Thread.sleep(forTimeInterval: 0.3)
                    let selectAll = app.menuItems["Select All"]
                    if selectAll.exists { selectAll.tap() }
                    Thread.sleep(forTimeInterval: 0.1)
                    el.typeText(text)
                    writeResult(["ok": true, "action": "fill", "ref": ref, "text": text])
                } else {
                    writeResult(["ok": false, "error": "element not found: \(ref)"])
                }
            } else {
                writeResult(["ok": false, "error": "fill requires ref"])
            }
            
        case "snapshot":
            let interactiveOnly = cmd["interactive"] as? Bool ?? false
            let elements = snapshotElements(app: app, interactiveOnly: interactiveOnly)
            writeResult(["ok": true, "action": "snapshot", "elements": elements])
            
        case "swipe":
            let direction = cmd["direction"] as? String ?? "up"
            switch direction {
            case "up": app.swipeUp()
            case "down": app.swipeDown()
            case "left": app.swipeLeft()
            case "right": app.swipeRight()
            default: break
            }
            writeResult(["ok": true, "action": "swipe", "direction": direction])
            
        case "press":
            let button = cmd["button"] as? String ?? "home"
            switch button {
            case "home": XCUIDevice.shared.press(.home)
            default: break
            }
            writeResult(["ok": true, "action": "press", "button": button])
            
        default:
            writeResult(["ok": false, "error": "unknown action: \(action)"])
        }
    }
    
    // MARK: - Helpers
    
    private func findElement(in app: XCUIApplication, ref: String) -> XCUIElement? {
        // Try multiple strategies
        // 1. Accessibility identifier
        let byId = app.descendants(matching: .any).matching(identifier: ref).firstMatch
        if byId.exists { return byId }
        
        // 2. Label text (partial match)
        let predicate = NSPredicate(format: "label CONTAINS[c] %@", ref)
        let byLabel = app.descendants(matching: .any).matching(predicate).firstMatch
        if byLabel.exists { return byLabel }
        
        // 3. TextField/TextView by placeholder
        let textFields = app.textFields.matching(predicate).firstMatch
        if textFields.exists { return textFields }
        
        let textViews = app.textViews.matching(predicate).firstMatch
        if textViews.exists { return textViews }
        
        return nil
    }
    
    private func snapshotElements(app: XCUIApplication, interactiveOnly: Bool) -> [[String: Any]] {
        var results: [[String: Any]] = []
        var counter = 0
        
        let types: [XCUIElement.ElementType] = interactiveOnly
            ? [.button, .textField, .textView, .switch, .slider, .link, .segmentedControl, .searchField, .popUpButton, .comboBox, .checkBox]
            : [.button, .textField, .textView, .switch, .slider, .link, .segmentedControl, .searchField, .popUpButton, .comboBox, .checkBox, .staticText, .image, .cell, .other]
        
        for type in types {
            let elements = app.descendants(matching: type)
            for i in 0..<min(elements.count, 100) {
                let el = elements.element(boundBy: i)
                guard el.exists else { continue }
                let frame = el.frame
                guard frame.width >= 3, frame.height >= 3 else { continue }
                
                counter += 1
                var entry: [String: Any] = [
                    "ref": "@e\(counter)",
                    "role": String(describing: type),
                    "label": el.label,
                    "frame": [
                        "x": Int(frame.origin.x),
                        "y": Int(frame.origin.y),
                        "w": Int(frame.width),
                        "h": Int(frame.height)
                    ],
                    "interactive": interactiveOnly || [.button, .textField, .textView, .switch, .slider, .link, .searchField].contains(type)
                ]
                if !el.value.debugDescription.isEmpty, let v = el.value as? String {
                    entry["value"] = v
                }
                if !el.identifier.isEmpty {
                    entry["identifier"] = el.identifier
                }
                results.append(entry)
            }
        }
        
        return results
    }
    
    private func writeResult(_ dict: [String: Any]) {
        let resultPath = "/tmp/agent-control-result.json"
        if let data = try? JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted]) {
            try? data.write(to: URL(fileURLWithPath: resultPath))
        }
    }
}
