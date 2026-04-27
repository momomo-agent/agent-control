// AgentCursor.swift
// \u865a\u62df\u5149\u6807 manager\uff08\u8fdb\u7a0b\u5185\uff09\u3002\u8d1f\u8d23\uff1a
// - \u7ef4\u62a4 overlay window + cursor view \u7684\u751f\u547d\u5468\u671f
// - move(to:) \u5373\u65f6\u79fb\u52a8\uff0canimate(to:duration:) \u5e73\u6ed1\u8fc7\u6e21
//
// \u5fc5\u987b\u5728\u4e3b\u7ebf\u7a0b\u8c03\u7528\u3002

import AppKit
import QuartzCore

public final class AgentCursor {
    public static let shared = AgentCursor()

    private var window: AgentCursorOverlayWindow?
    private var view: AgentCursorView?
    private var currentPoint: CGPoint?

    private init() {}

    public var isVisible: Bool {
        return window?.isVisible == true
    }

    /// \u5c55\u793a\u5149\u6807\u3002\u8fd4\u56de\u65e9\u2014\u2014idempotent\u3002
    /// \u521d\u59cb\u4f4d\u7f6e\u9ed8\u8ba4\u5728\u5c4f\u5e55\u4e2d\u5fc3\uff0c\u6216 setPoint(\u2026) \u7ed9\u8fc7\u7684\u4f4d\u7f6e\u3002
    public func show(at initial: CGPoint? = nil) {
        assert(Thread.isMainThread)

        if window == nil {
            let w = AgentCursorOverlayWindow()
            let content = NSView(frame: w.contentView?.bounds ?? .zero)
            content.wantsLayer = true
            w.contentView = content

            let cursor = AgentCursorView(frame: NSRect(
                x: 0, y: 0,
                width: AgentCursorView.containerSize,
                height: AgentCursorView.containerSize
            ))
            content.addSubview(cursor)
            self.view = cursor
            self.window = w
        }

        let point = initial ?? currentPoint ?? screenCenter()
        setPoint(point, animated: false)
        window?.orderFrontRegardless()
    }

    /// \u7acb\u5373\u79fb\u52a8\uff08\u65e0\u52a8\u753b\uff09
    public func move(to point: CGPoint) {
        assert(Thread.isMainThread)
        setPoint(point, animated: false)
    }

    /// \u5e73\u6ed1\u52a8\u753b\u5230\u76ee\u6807\u70b9\u3002duration \u9ed8\u8ba4 0.35s\u3002
    public func animate(to point: CGPoint, duration: CFTimeInterval = 0.35) {
        assert(Thread.isMainThread)
        setPoint(point, animated: true, duration: duration)
    }

    /// \u9690\u85cf\u5149\u6807\u4f46\u4fdd\u7559 window\uff0c\u4e0b\u6b21 show() \u66f4\u5feb\u3002
    public func hide() {
        assert(Thread.isMainThread)
        window?.orderOut(nil)
    }

    /// \u9500\u6bc1 window\uff0c\u5f7b\u5e95\u6e05\u7406\u3002
    public func destroy() {
        assert(Thread.isMainThread)
        window?.orderOut(nil)
        window?.close()
        window = nil
        view = nil
    }

    // MARK: - Private

    private func setPoint(_ point: CGPoint, animated: Bool, duration: CFTimeInterval = 0.35) {
        guard let view = view, let window = window else { return }
        currentPoint = point

        // \u5c4f\u5e55\u5750\u6807 (top-left origin, \u8ddf AX \u4e00\u81f4) \u2192 AppKit \u5750\u6807 (bottom-left origin)
        // NSWindow.frame \u662f AppKit \u5168\u5c40\u5750\u6807
        let windowFrame = window.frame
        // point \u662f\u4ee5\u5c4f\u5e55 top-left \u4e3a\u539f\u70b9\u7684 AX/Cocoa-global top-left \u5750\u6807
        // \u4f46 NSWindow \u7528\u7684\u662f bottom-left origin\u3002\u8f6c\u6362\uff1a
        let screenH = NSScreen.main?.frame.height ?? windowFrame.height
        let appkitY = screenH - point.y - AgentCursorView.containerSize / 2
        let appkitX = point.x - AgentCursorView.containerSize / 2

        let targetOrigin = CGPoint(x: appkitX, y: appkitY)

        if animated {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = duration
                ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                ctx.allowsImplicitAnimation = true
                view.animator().setFrameOrigin(targetOrigin)
            }
        } else {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            view.setFrameOrigin(targetOrigin)
            CATransaction.commit()
        }
    }

    private func screenCenter() -> CGPoint {
        let s = NSScreen.main?.frame ?? .zero
        return CGPoint(x: s.midX, y: s.midY)
    }
}
