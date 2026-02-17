#!/usr/bin/env swift
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

let pidFile = "/tmp/agent-control-screenrecord.pid"

// Parse args: start <output.mp4> [--window <name>] [--pid <pid>]
var outPath = "/tmp/sck-test.mp4"
var windowMatch: String? = nil
var pidMatch: pid_t? = nil

var i = 1
while i < CommandLine.arguments.count {
    let a = CommandLine.arguments[i]
    if a == "start" { /* skip */ }
    else if a == "--window" { i += 1; windowMatch = CommandLine.arguments[i] }
    else if a == "--pid" { i += 1; pidMatch = pid_t(CommandLine.arguments[i]) }
    else if !a.hasPrefix("-") { outPath = a }
    i += 1
}

class Rec: NSObject, SCStreamOutput {
    let url: URL
    var writer: AVAssetWriter!
    var adaptor: AVAssetWriterInputPixelBufferAdaptor!
    var input: AVAssetWriterInput!
    var stream: SCStream?
    var active = false
    var t0: CMTime?
    var frameCount = 0

    init(_ p: String) { url = URL(fileURLWithPath: p); super.init() }

    func go() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)

        var filter: SCContentFilter
        var w: Int, h: Int

        // Try to find matching window
        if let match = windowMatch ?? (pidMatch != nil ? "" : nil) {
            let win = content.windows.first { win in
                if let pid = pidMatch, win.owningApplication?.processID == pid { return true }
                if !match.isEmpty {
                    let title = win.title ?? ""
                    let app = win.owningApplication?.applicationName ?? ""
                    return title.localizedCaseInsensitiveContains(match) || app.localizedCaseInsensitiveContains(match)
                }
                return false
            }
            if let win = win {
                let d = content.displays.first!
                filter = SCContentFilter(display: d, including: [win])
                w = Int(win.frame.width); h = Int(win.frame.height)
                FileHandle.standardError.write(Data("Recording window: \(win.owningApplication?.applicationName ?? "?") - \(win.title ?? "?") [\(w)x\(h)]\n".utf8))
            } else {
                // Fallback to full screen
                let d = content.displays.first!
                filter = SCContentFilter(display: d, excludingWindows: [])
                w = Int(d.width) / 2; h = Int(d.height) / 2
                FileHandle.standardError.write(Data("Window not found, recording full screen\n".utf8))
            }
        } else {
            let d = content.displays.first!
            filter = SCContentFilter(display: d, excludingWindows: [])
            w = Int(d.width) / 2; h = Int(d.height) / 2
        }

        let cfg = SCStreamConfiguration()
        cfg.width = w; cfg.height = h
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 10)
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.showsCursor = true

        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let vs: [String: Any] = [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h]
        input = AVAssetWriterInput(mediaType: .video, outputSettings: vs)
        input.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h
        ])
        writer.add(input); writer.startWriting(); writer.startSession(atSourceTime: .zero)

        stream = SCStream(filter: filter, configuration: cfg, delegate: nil)
        try stream!.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "r"))
        try await stream!.startCapture()
        active = true
        try! "\(ProcessInfo.processInfo.processIdentifier)".write(toFile: pidFile, atomically: true, encoding: .utf8)
        print("{\"ok\":true,\"pid\":\(ProcessInfo.processInfo.processIdentifier),\"width\":\(w),\"height\":\(h)}")
        fflush(stdout)
    }

    func end() async {
        active = false
        try? await stream?.stopCapture()
        input?.markAsFinished()
        await writer?.finishWriting()
        let sz = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        try? FileManager.default.removeItem(atPath: pidFile)
        print("{\"ok\":true,\"stopped\":true,\"frames\":\(frameCount),\"size\":\(sz)}")
    }

    func stream(_ s: SCStream, didOutputSampleBuffer buf: CMSampleBuffer, of type: SCStreamOutputType) {
        guard active, type == .screen, buf.isValid, input.isReadyForMoreMediaData else { return }
        guard let pb = buf.imageBuffer else { return }
        let ts = CMSampleBufferGetPresentationTimeStamp(buf)
        if t0 == nil { t0 = ts }
        adaptor.append(pb, withPresentationTime: CMTimeSubtract(ts, t0!))
        frameCount += 1
    }
}

let rec = Rec(outPath)
let sem = DispatchSemaphore(value: 0)
signal(SIGINT) { _ in sem.signal() }
signal(SIGTERM) { _ in sem.signal() }
Task { try await rec.go() }
DispatchQueue.global().async { sem.wait(); Task { await rec.end(); exit(0) } }
RunLoop.main.run()
