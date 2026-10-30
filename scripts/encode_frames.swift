import Foundation
import AVFoundation
import CoreGraphics
import ImageIO
import CoreVideo

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 4 else {
    fail("usage: encode_frames <frames-dir> <output.mp4> <fps>")
}
let inputDir = args[1]
let outputPath = args[2]
guard let fps = Int32(args[3]), fps > 0 else { fail("invalid fps") }

let fm = FileManager.default
let files = try fm.contentsOfDirectory(atPath: inputDir)
    .filter { $0.lowercased().hasSuffix(".png") }
    .sorted()
guard let firstFile = files.first else { fail("no PNG frames in \(inputDir)") }

func loadImage(_ path: String) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

guard let first = loadImage("\(inputDir)/\(firstFile)") else { fail("cannot read first frame") }
let width = first.width
let height = first.height
guard width > 0, height > 0, width % 2 == 0, height % 2 == 0 else {
    fail("frame dimensions must be even (got \(width)x\(height))")
}

try? fm.removeItem(atPath: outputPath)
let writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: outputPath), fileType: .mp4)
let compression: [String: Any] = [
    AVVideoAverageBitRateKey: 5_000_000,
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    AVVideoMaxKeyFrameIntervalKey: 60,
    AVVideoAllowFrameReorderingKey: false
]
let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: compression
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: input,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32ARGB),
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferCGImageCompatibilityKey as String: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
    ]
)
guard writer.canAdd(input) else { fail("cannot add video input") }
writer.add(input)
guard writer.startWriting() else { fail("startWriting failed: \(writer.error?.localizedDescription ?? "unknown")") }
writer.startSession(atSourceTime: .zero)

let colorSpace = CGColorSpaceCreateDeviceRGB()
for (index, file) in files.enumerated() {
    while !input.isReadyForMoreMediaData {
        usleep(2_000)
    }
    guard let image = loadImage("\(inputDir)/\(file)") else { fail("cannot read \(file)") }
    var pixelBuffer: CVPixelBuffer?
    guard let pool = adaptor.pixelBufferPool else { fail("no pixel buffer pool") }
    CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pixelBuffer)
    guard let buffer = pixelBuffer else { fail("cannot allocate pixel buffer") }

    CVPixelBufferLockBaseAddress(buffer, [])
    guard let context = CGContext(
        data: CVPixelBufferGetBaseAddress(buffer),
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
    ) else { fail("cannot create CGContext") }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    CVPixelBufferUnlockBaseAddress(buffer, [])

    let time = CMTime(value: CMTimeValue(index), timescale: fps)
    if !adaptor.append(buffer, withPresentationTime: time) {
        fail("append failed at frame \(index): \(writer.error?.localizedDescription ?? "unknown")")
    }
}

input.markAsFinished()
let semaphore = DispatchSemaphore(value: 0)
writer.finishWriting { semaphore.signal() }
semaphore.wait()
guard writer.status == .completed else {
    fail("finishWriting failed: \(writer.error?.localizedDescription ?? "unknown")")
}
let size = (try? fm.attributesOfItem(atPath: outputPath)[.size] as? NSNumber)?.intValue ?? 0
print("wrote \(outputPath) — \(files.count) frames, \(width)x\(height) @ \(fps)fps, \(size) bytes")
