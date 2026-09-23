const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const rootDir = path.resolve(__dirname, '..')
const macosDir = path.join(rootDir, 'resources', 'macos')
const imageNativeBaseDir = path.join(rootDir, 'resources', 'wedecrypt')

const requiredArtifacts = [
  { name: 'libwx_key.dylib', type: 'file', generated: true },
  { name: 'xkey_helper', type: 'file', generated: true },
  { name: 'image_scan_helper', type: 'file', generated: true },
  { name: 'libWCDB.dylib', type: 'file', generated: true },
  { name: 'libwcdb_api.dylib', type: 'file', generated: true },
  { name: 'entitlements.mac.plist', type: 'file', generated: false },
  { name: 'image_scan_entitlements.plist', type: 'file', generated: false },
  ...['supervisor.py', 'wechat_lldb_capture.py', 'wechat_key_verify.py'].map(name => ({
    name: `login-capture/${name}`, type: 'file', generated: false
  }))
]

function statSafe(targetPath) {
  try {
    return fs.statSync(targetPath)
  } catch {
    return null
  }
}

function verifyCodeSignature(targetPath) {
  const result = spawnSync('/usr/bin/codesign', [
    '--verify',
    '--strict',
    '--all-architectures',
    '--verbose=2',
    targetPath
  ], { encoding: 'utf8' })

  return {
    valid: result.status === 0,
    detail: String(result.stderr || result.stdout || '').trim()
  }
}

function main() {
  console.log(`[macos-native-check] target dir: ${macosDir}`)

  if (!fs.existsSync(macosDir)) {
    console.error('[macos-native-check] resources/macos does not exist')
    process.exit(1)
  }

  const missing = []
  const present = []

  for (const artifact of requiredArtifacts) {
    const targetPath = path.join(macosDir, artifact.name)
    const stat = statSafe(targetPath)

    if (!stat || (artifact.type === 'file' && !stat.isFile())) {
      missing.push(artifact)
      continue
    }

    present.push({
      name: artifact.name,
      size: stat.size,
      generated: artifact.generated
    })
  }

  if (present.length > 0) {
    console.log('[macos-native-check] present:')
    for (const item of present) {
      console.log(`  - ${item.name} (${item.size} bytes)${item.generated ? ' [generated]' : ' [static]'}`)
    }
  }

  if (missing.length > 0) {
    console.error('[macos-native-check] missing:')
    for (const item of missing) {
      console.error(`  - ${item.name}${item.generated ? ' [build required]' : ''}`)
    }
    process.exit(2)
  }

  if (process.platform === 'darwin') {
    const invalidSignatures = []
    for (const item of present) {
      if (!item.generated) continue
      const targetPath = path.join(macosDir, item.name)
      const signature = verifyCodeSignature(targetPath)
      if (!signature.valid) {
        invalidSignatures.push({ name: item.name, detail: signature.detail })
      }
    }

    if (invalidSignatures.length > 0) {
      console.error('[macos-native-check] invalid code signatures:')
      for (const item of invalidSignatures) {
        console.error(`  - ${item.name}: ${item.detail || 'codesign verification failed'}`)
      }
      process.exit(4)
    }

    console.log('[macos-native-check] code signatures are valid')
  }

  const imageNativeArch = process.env.CIPHERTALK_IMAGE_NATIVE_ARCH || process.arch
  const imageNativeAddon = path.join(
    imageNativeBaseDir,
    `ciphertalk-image-native-macos-${imageNativeArch}.node`
  )

  const imageNativeStat = statSafe(imageNativeAddon)
  if (!imageNativeStat || !imageNativeStat.isFile()) {
    console.error(`[macos-native-check] missing image native addon: ${imageNativeAddon}`)
    process.exit(3)
  }

  if (process.platform === 'darwin') {
    const signature = verifyCodeSignature(imageNativeAddon)
    if (!signature.valid) {
      console.error(`[macos-native-check] invalid image native addon signature: ${signature.detail || imageNativeAddon}`)
      process.exit(5)
    }
  }

  console.log(`[macos-native-check] image native addon ok: ${imageNativeAddon} (${imageNativeStat.size} bytes)`)

  console.log('[macos-native-check] all required macOS native artifacts are present')
}

main()
