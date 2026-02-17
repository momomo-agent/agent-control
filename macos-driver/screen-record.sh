#!/bin/bash
# screen-record.sh — ScreenCaptureKit recorder via swift inline
# Usage: screen-record.sh start <output.mp4>  |  screen-record.sh stop
ACTION="$1"
PIDFILE="/tmp/agent-control-screenrecord.pid"

if [ "$ACTION" = "stop" ]; then
  PID=$(cat "$PIDFILE" 2>/dev/null)
  [ -z "$PID" ] && echo '{"ok":false,"error":"no recording"}' && exit 1
  kill -INT "$PID" 2>/dev/null
  sleep 2
  rm -f "$PIDFILE"
  echo '{"ok":true,"action":"stop"}'
  exit 0
fi

[ "$ACTION" != "start" ] || [ -z "$2" ] && echo '{"ok":false,"error":"usage: screen-record.sh start <file>"}' && exit 1
OUTPUT="$2"

exec swift - "$OUTPUT" "$PIDFILE" <<'SWIFT'
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import Foundation

let outputPath = CommandLine.arguments[1]
let pidFile = CommandLine.arguments[2]
try! "\(ProcessInfo.processInfo.processIdentifier)".write(toFile: pidFile, atomically: true, encoding: .utf8)

class Rec: NSObject, SCStreamOutput {
    let url: URL
    var writer: AVAssetWriter!
    var input: AVAssetWriterInput!
    var stream: SCStream?
    var active = false
    var t0: CMTime?

    init(_ p: String) { url = URL(fileURLWithPath: p); super.init() }

    func go() async throws {
        let c = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let d = c.displays.first!
        let cfg = SCStreamConfiguration()
        cfg.width = Int(d.width); cfg.height = Int(d.height)
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 15)
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.showsCursor = true
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let vs: [String:Any] = [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: cfg.width, AVVideoHeightKey: cfg.height]
        input = AVAssetWriterInput(mediaType: .video, outputSettings: vs)
        input.expectsMediaDataInRealTime = true
        writer.add(input); writer.startWriting(); writer.startSession(atSourceTime: .zero)
        let f = SCContentFilter(display: d, excludingWindows: [])
        stream = SCStream(filter: f, configuration: cfg, delegate: nil)
        try stream!.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "r"))
        try await stream!.startCapture()
        active = true
        print("{\"ok\":true,\"action\":\"start\",\"pid\":\(ProcessInfo.processInfo.processIdentifier)}")
        fflush(stdout)
    }

    func end() async {
        active = false
        try? await stream?.stopCapture()
        input?.markAsFinished()
        await writer?.finishWriting()
        let sz = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        try? FileManager.default.removeItem(atPath: pidFile)
        print("{\"ok\":true,\"action\":\"stopped\",\"size\":\(sz)}")
    }

    func stream(_ s: SCStream, didOutputSampleBuffer buf: CMSampleBuffer, of type: SCStreamOutputType) {
        guard active, type == .screen, buf.isValid, input.isReadyForMoreMediaData else { return }
        let ts = CMSampleBufferGetPresentationTimeStamp(buf)
        if t0 == nil { t0 = ts }
        var ti = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMTimeSubtract(ts, t0!), decodeTimeStamp: .invalid)
        var nb: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: buf, sampleTimingEntryCount: 1, sampleTimingArray: &ti, sampleBufferOut: &nb)
        if let b = nb { input.append(b) }
    }
}

let rec = Rec(outputPath)
let sem = DispatchSemaphore(value: 0)
signal(SIGINT) { _ in sem.signal() }
signal(SIGTERM) { _ in sem.signal() }
Task { try await rec.go() }
DispatchQueue.global().async { sem.wait(); Task { await rec.end(); exit(0) } }
RunLoop.main.run()
SWIFT
