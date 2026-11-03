// The macOS app icon (src-tauri/icons/icon.icns) from the full-bleed artwork, drawn on Apple's icon grid: the
// tile is 824 of 1024 pixels with rounded corners and a soft shadow, the way every other app in the Dock is.
// The full-bleed picture alone looks a size too big there. Windows and Linux keep the full-bleed icons.
// macOS only (Core Graphics and iconutil):
//   swift scripts/mac-icon.swift src-tauri/icons/artwork-1024.png src-tauri/icons/icon.icns
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let source = NSImage(contentsOfFile: args[1]),
      let art = source.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("usage: swift scripts/mac-icon.swift <artwork-1024.png> <icon.icns>\n".data(using: .utf8)!)
  exit(1)
}

func draw(_ size: Int) -> Data {
  let k = CGFloat(size) / 1024
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.interpolationQuality = .high
  // Apple's grid: a 824 tile with 100 around it, corners about 22% of the tile (y counts up from the bottom here)
  let tile = CGRect(x: 100 * k, y: 100 * k, width: 824 * k, height: 824 * k)
  let shape = CGPath(roundedRect: tile, cornerWidth: 185 * k, cornerHeight: 185 * k, transform: nil)
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -10 * k), blur: 20 * k, color: NSColor.black.withAlphaComponent(0.3).cgColor)
  ctx.addPath(shape)
  ctx.setFillColor(NSColor.black.cgColor)
  ctx.fillPath()
  ctx.restoreGState()
  ctx.addPath(shape)
  ctx.clip()
  ctx.draw(art, in: tile)
  return NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!
}

let set = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("athena-\(getpid()).iconset")
try? FileManager.default.removeItem(at: set)
try! FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
  try! draw(base).write(to: set.appendingPathComponent("icon_\(base)x\(base).png"))
  try! draw(base * 2).write(to: set.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", set.path, "-o", args[2]]
try! iconutil.run()
iconutil.waitUntilExit()
try? FileManager.default.removeItem(at: set)
exit(iconutil.terminationStatus)
