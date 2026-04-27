// AgentCursorView.swift
// \u7528 CAShapeLayer \u753b\u7b80\u6d01\u7684 lavender \u7bad\u5934 + bloom\u3002\u4e0d\u7528 SwiftUI\uff0c\u517c\u5bb9\u8001\u4e00\u70b9\u3002
//
// \u4e0e Cua \u76f8\u6bd4\u7684\u7b80\u5316\uff1a
// - \u5355\u8272\u586b\u5145\uff08lavender\uff09\u4ee3\u66ff\u4e24\u8272\u6e10\u53d8
// - \u7c89\u8272\u8f6f\u5149\u8ba9\u5149\u6807\u7adf\u7136\u4e26\u4f54\u800c\u4e0d\u523a\u773c
// - \u7bad\u5934\u5c3a\u5bf8 20pt\uff08\u6bd4\u7cfb\u7edf\u5149\u6807\u7565\u5927\uff0c\u533a\u5206 agent \u884c\u4e3a\uff09

import AppKit
import QuartzCore

public final class AgentCursorView: NSView {
    private let bloom = CALayer()
    private let arrow = CAShapeLayer()

    public static let containerSize: CGFloat = 48
    public static let arrowSize: CGFloat = 20

    public override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer = CALayer()
        buildLayers()
    }

    public required init?(coder: NSCoder) { fatalError() }

    private func buildLayers() {
        let size = AgentCursorView.containerSize

        // \u7c89\u8272\u8f6f\u5149\uff08\u8f6f\u5149\u7528\u53cc\u5c42 shadow \u6a21\u62df radial gradient\uff09
        bloom.frame = CGRect(x: 0, y: 0, width: size, height: size)
        bloom.backgroundColor = NSColor(calibratedRed: 0.72, green: 0.60, blue: 0.96, alpha: 0.35).cgColor
        bloom.cornerRadius = size / 2
        bloom.shadowColor = NSColor(calibratedRed: 0.55, green: 0.40, blue: 0.95, alpha: 0.85).cgColor
        bloom.shadowOpacity = 1.0
        bloom.shadowRadius = 14
        bloom.shadowOffset = .zero
        bloom.opacity = 0.9
        layer?.addSublayer(bloom)

        // \u7bad\u5934\u5f62\u72b6 (tip \u5728\u5de6\u4e0a\uff0c\u548c macOS \u9ed8\u8ba4\u5149\u6807\u4e00\u81f4)
        let path = CGMutablePath()
        let s = AgentCursorView.arrowSize
        let inset = (size - s) / 2
        path.move(to: CGPoint(x: inset, y: inset + s))                    // tip (\u5de6\u4e0a)
        path.addLine(to: CGPoint(x: inset + s * 0.65, y: inset + s * 0.35))  // \u53f3\u4e0b\u5185\u6298
        path.addLine(to: CGPoint(x: inset + s * 0.45, y: inset + s * 0.30))
        path.addLine(to: CGPoint(x: inset + s * 0.25, y: inset))          // \u5c3e (\u6b63\u4e0b\u65b9)
        path.closeSubpath()

        arrow.path = path
        arrow.fillColor = NSColor(calibratedRed: 0.55, green: 0.40, blue: 0.95, alpha: 1.0).cgColor
        arrow.strokeColor = NSColor.white.withAlphaComponent(0.8).cgColor
        arrow.lineWidth = 1.2
        arrow.lineJoin = .round
        arrow.shadowColor = NSColor.black.cgColor
        arrow.shadowOpacity = 0.35
        arrow.shadowRadius = 3
        arrow.shadowOffset = CGSize(width: 0, height: -1)
        layer?.addSublayer(arrow)
    }
}
