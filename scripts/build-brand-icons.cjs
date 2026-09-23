#!/usr/bin/env node
// The editable SVG is the source of truth for the desktop identity.
const fs = require('node:fs/promises')
const path = require('node:path')
const sharp = require('sharp')

const root = path.resolve(__dirname, '..')
const publicDir = path.join(root, 'public')

async function main() {
  const svg = await fs.readFile(path.join(publicDir, 'notewake-mark.svg'), 'utf8')
  const source = Buffer.from(svg)
  const png = (size) => sharp(source).resize(size, size).png().toBuffer()
  await fs.writeFile(path.join(publicDir, 'logo.png'), await png(1024))

  // Keep the visual footprint consistent with macOS Dock icons.
  const dock = await sharp(await png(824))
    .extend({ top: 100, bottom: 100, left: 100, right: 100, background: '#00000000' })
    .png().toBuffer()
  await fs.writeFile(path.join(publicDir, 'icon-dock.png'), dock)

  // macOS uses alpha as a template mask: omit the colored tile entirely.
  const symbol = svg.match(/<g id="notewake-symbol">([\s\S]*?)<\/g>/)?.[1]
  if (!symbol) throw new Error('Missing notewake-symbol in the source SVG')
  const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">${symbol.replace(/#(?:F4F5E9|E3BC73)/g, '#000000')}</svg>`
  await sharp(Buffer.from(traySvg)).resize(64, 64).png().toFile(path.join(publicDir, 'tray-mac.png'))

  // PNG-compressed ICO entries are supported by modern Windows/Electron.
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const frames = await Promise.all(sizes.map(png))
  const header = Buffer.alloc(6 + sizes.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16
    header[entry] = size === 256 ? 0 : size
    header[entry + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(frames[index].length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += frames[index].length
  })
  const ico = Buffer.concat([header, ...frames])
  await fs.writeFile(path.join(publicDir, 'icon.ico'), ico)
  await fs.writeFile(path.join(publicDir, 'logo.ico'), ico)

  // Preserve the PNG-based ICNS layout used by the existing application icon.
  // Encoding the container here also supports regenerating assets off macOS.
  const icnsEntries = [
    ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128],
    ['ic08', 256], ['ic09', 512], ['ic10', 1024],
    ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
  ]
  const chunks = []
  for (const [type, size] of icnsEntries) {
    const frame = await sharp(dock).resize(size, size).png().toBuffer()
    const entry = Buffer.alloc(8)
    entry.write(type, 0, 'ascii')
    entry.writeUInt32BE(frame.length + 8, 4)
    chunks.push(entry, frame)
  }
  const icnsHeader = Buffer.alloc(8)
  icnsHeader.write('icns', 0, 'ascii')
  icnsHeader.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4)
  await fs.writeFile(path.join(publicDir, 'icon.icns'), Buffer.concat([icnsHeader, ...chunks]))
  console.info('Updated Notewake desktop PNG, ICO, ICNS, Dock and template tray icons.')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
