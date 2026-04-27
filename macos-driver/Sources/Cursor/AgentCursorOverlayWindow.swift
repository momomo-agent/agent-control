// AgentCursorOverlayWindow.swift
// \u900f\u660e\u3001\u7a7f\u900f\u70b9\u51fb\u3001\u4e0d\u62a2 key \u7684 borderless NSWindow\uff0c\u7528\u4f5c\u865a\u62df\u5149\u6807\u5bbf\u4e3b\u3002
//
// - canBecomeKey/Main \u8fd4\u56de false \u2192 \u6c38\u4e0d\u62a2 focus
// - .normal level + .canJoinAllSpaces \u2192 \u8ddf\u968f\u7528\u6237\u5f53\u524d Space
// - ignoresMouseEvents = true \u2192 \u7528\u6237\u70b9\u51fb\u7a7f\u900f\u80cc\u540e\u7a97\u53e3
// - hidesOnDeactivate = false \u2192 agent-control \u4e0d\u662f\u524d\u53f0\u65f6\u4e0d\u9690\u85cf
//
// Reference: Cua AgentCursorOverlayWindow

import AppKit

public final class AgentCursorOverlayWindow: NSWindow {
    public override var canBecomeKey: Bool { false }
    public override var canBecomeMain: Bool { false }

    public convenience init() {
        let frame = NSScreen.main?.frame ?? NSScreen.screens.first?.frame ?? .zero
        self.init(
            contentRect: frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        level = .floating  // \u9ad8\u4e8e\u666e\u901a\u7a97\u53e3\uff0c\u4f4e\u4e8e system menu
        collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .stationary,
        ]
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
    }
}
