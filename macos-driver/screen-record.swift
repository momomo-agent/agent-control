#!/usr/bin/env swift
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

let outPath = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "/tmp/sck-test.mp4"
let pidFile = "/tmp/agent-control-screenrecord.pid"

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
        let c = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let d = c.displays.first!
        let cfg = SCStreamConfiguration()
        cfg.width = Int(d.width) / 2  // half res for speed
        cfg.height = Int(d.height) / 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 10)
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.showsCursor = true

        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let vs: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: cfg.width,
            AVVideoHeightKey: cfg.height
        ]
        input = AVAssetWriterInput(mediaType: .video, outputSettings: vs)
        input.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: cfg.width,
                kCVPixelBufferHeightKey as String: cfg.height
            ]
        )
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)

        let f = SCContentFilter(display: d, excludingWindows: [])
        stream = SCStream(filter: f, configuration: cfg, delegate: nil)
        try stream!.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "r"))
        try await stream!.startCapture()
        active = true
        try! "\(ProcessInfo.processInfo.processIdentifier)".write(toFile: pidFile, atomically: true, encoding: .utf8)
        print("{\"ok\":true,\"pid\":\(ProcessInfo.processInfo.processIdentifier)}")
        fflush(stdout)
    }

    func end() async {
        active = false
        try? await stream?.stopCapture()
        input?.markAsFinished()
        await writer?.finishWriting()
        if let e = writer?.error { FileHandle.standardError.write(Data("writer error: \(e)\n".utf8)) }
        let sz = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        try? FileManager.default.removeItem(atPath: pidFile)
        print("{\"ok\":true,\"stopped\":true,\"frames\":\(frameCount),\"size\":\(sz)}")
    }

    func stream(_ s: SCStream, didOutputSampleBuffer buf: CMSampleBuffer, of type: SCStreamOutputType) {
        guard active, type == .screen, buf.isValid else { return }
        guard input.isReadyForMoreMediaData else { return }
        guard let pb = buf.imageBuffer else { return }
        let ts = CMSampleBufferGetPresentationTimeStamp(buf)
        if t0 == nil { t0 = ts }
        let pt = CMTimeSubtract(ts, t0!)
        adaptor.append(pb, withPresentationTime: pt)
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
