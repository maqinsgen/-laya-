#!/usr/bin/env node
// Regenerate mobile assets from the same editable SVG as the desktop app.
// This writes image resources only; it does not build or sign native apps.
const fs = require('node:fs/promises')
const path = require('node:path')
const sharp = require('sharp')

const root = path.resolve(__dirname, '..')
const mobile = path.join(root, 'mobile')
const green = '#173E35'
const paper = '#F5F6F0'
let count = 0

async function write(relativePath, contents) {
  const file = path.join(mobile, relativePath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, contents)
  count += 1
}

function vectorPaths(symbol, monochrome = false) {
  // The source intentionally contains only SVG paths in the symbol group.
  return [...symbol.matchAll(/<path\s+([^>]+)\/?\s*>/g)].map((match) => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((item) => [item[1], item[2]]))
    if (!attrs.d) throw new Error('A logo path is missing SVG path data')
    const values = [`android:pathData="${attrs.d}"`, `android:fillColor="${attrs.fill ? (monochrome ? '#FFFFFF' : attrs.fill) : '#00000000'}"`]
    if (attrs.stroke) values.push(`android:strokeColor="${monochrome ? '#FFFFFF' : attrs.stroke}"`)
    if (attrs['stroke-width']) values.push(`android:strokeWidth="${attrs['stroke-width']}"`)
    if (attrs['stroke-linecap']) values.push(`android:strokeLineCap="${attrs['stroke-linecap']}"`)
    if (attrs['stroke-linejoin']) values.push(`android:strokeLineJoin="${attrs['stroke-linejoin']}"`)
    return `    <path ${values.join(' ')}/>`
  }).join('\n')
}

function vector(paths, adaptive) {
  const viewport = adaptive ? 108 : 64
  const size = adaptive ? 108 : 24
  const group = adaptive ? `    <group android:translateX="15.6" android:translateY="15.6" android:scaleX="1.2" android:scaleY="1.2">\n${paths}\n    </group>` : paths
  return `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="${size}dp" android:height="${size}dp" android:viewportWidth="${viewport}" android:viewportHeight="${viewport}">\n${group}\n</vector>\n`
}

async function main() {
  const svg = await fs.readFile(path.join(root, 'public/notewake-mark.svg'), 'utf8')
  const symbol = svg.match(/<g id="notewake-symbol">([\s\S]*?)<\/g>/)?.[1]
  if (!symbol || !svg.includes('viewBox="0 0 64 64"')) throw new Error('Expected the 64 × 64 Notewake SVG and notewake-symbol group')
  const source = Buffer.from(svg)
  const png = (size, opaque = false) => {
    let image = sharp(source).resize(size, size)
    if (opaque) image = image.flatten({ background: green }).removeAlpha()
    return image.png().toBuffer()
  }

  await write('public/notewake-mark.svg', svg)
  for (const size of [192, 512]) await write(`public/icon-${size}.png`, await png(size, true))
  await write('public/favicon-32.png', await png(32))
  await write('public/apple-touch-icon.png', await png(180, true))
  // Maskable icons have an opaque full-bleed background and a central safe area.
  const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" fill="${green}"/><g transform="translate(32 32) scale(.9) translate(-32 -32)">${symbol}</g></svg>`
  await write('public/icon-maskable-512.png', await sharp(Buffer.from(maskableSvg)).resize(512, 512).removeAlpha().png().toBuffer())
  await write('public/manifest.webmanifest', JSON.stringify({
    name: '知灯 Notewake', short_name: '知灯', lang: 'zh-CN', start_url: './', scope: './',
    display: 'standalone', background_color: paper, theme_color: green,
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2) + '\n')

  // iOS applies its own corner mask; the exported icon is square and opaque.
  await write('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', await png(1024, true))

  const res = 'android/app/src/main/res'
  const adaptiveSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" fill="none"><g transform="translate(15.6 15.6) scale(1.2)">${symbol}</g></svg>`
  const adaptiveSource = Buffer.from(adaptiveSvg)
  // Android's foreground is 108 dp, with meaningful art inside the central 66 dp circle.
  const { data, info } = await sharp(adaptiveSource).resize(432, 432).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * info.channels + 3] > 8 && Math.hypot(x + .5 - 216, y + .5 - 216) > 132) {
        throw new Error('Logo exceeds the Android adaptive icon safe area')
      }
    }
  }
  for (const [density, size, foreground] of [['mdpi', 48, 108], ['hdpi', 72, 162], ['xhdpi', 96, 216], ['xxhdpi', 144, 324], ['xxxhdpi', 192, 432]]) {
    await write(`${res}/mipmap-${density}/ic_launcher.png`, await png(size))
    const circle = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`)
    const round = await sharp(await png(size, true)).ensureAlpha().composite([{ input: circle, blend: 'dest-in' }]).png().toBuffer()
    await write(`${res}/mipmap-${density}/ic_launcher_round.png`, round)
    await write(`${res}/mipmap-${density}/ic_launcher_foreground.png`, await sharp(adaptiveSource).resize(foreground, foreground).png().toBuffer())
  }
  await write(`${res}/values/ic_launcher_background.xml`, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${green}</color>\n</resources>\n`)
  await write(`${res}/drawable/ic_launcher_background.xml`, `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108"><path android:fillColor="${green}" android:pathData="M0,0h108v108h-108z"/></vector>\n`)
  await write(`${res}/drawable-v24/ic_launcher_foreground.xml`, vector(vectorPaths(symbol), true))
  await write(`${res}/drawable/ic_launcher_monochrome.xml`, vector(vectorPaths(symbol, true), true))
  await write(`${res}/drawable/ic_stat_notewake.xml`, vector(vectorPaths(symbol, true), false))
  for (const name of ['ic_launcher', 'ic_launcher_round']) {
    await write(`${res}/mipmap-anydpi-v33/${name}.xml`, `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>\n</adaptive-icon>\n`)
  }

  async function splash(relativePath, width, height, iconSize) {
    const mark = await png(iconSize)
    const image = await sharp({ create: { width, height, channels: 3, background: paper } }).composite([{ input: mark, gravity: 'centre' }]).removeAlpha().png().toBuffer()
    await write(relativePath, image)
  }
  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    await splash(`ios/App/App/Assets.xcassets/Splash.imageset/${name}`, 2732, 2732, 448)
  }
  const splashSizes = [
    ['drawable', 480, 320], ['drawable-land-mdpi', 480, 320], ['drawable-land-hdpi', 800, 480],
    ['drawable-land-xhdpi', 1280, 720], ['drawable-land-xxhdpi', 1600, 960], ['drawable-land-xxxhdpi', 1920, 1280],
    ['drawable-port-mdpi', 320, 480], ['drawable-port-hdpi', 480, 800], ['drawable-port-xhdpi', 720, 1280],
    ['drawable-port-xxhdpi', 960, 1600], ['drawable-port-xxxhdpi', 1280, 1920],
  ]
  for (const [dir, width, height] of splashSizes) await splash(`${res}/${dir}/splash.png`, width, height, Math.round(Math.min(width, height) * .26))
  console.info(`Updated ${count} mobile Notewake assets: web, iOS, Android launcher, notifications and splash screens.`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
