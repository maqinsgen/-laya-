const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')
const { signAsync } = require('@electron/osx-sign')

const execFileAsync = promisify(execFile)

const IMAGE_SCAN_ENTITLEMENTS = path.join(
  __dirname,
  '..',
  'resources',
  'macos',
  'image_scan_entitlements.plist'
)

/**
 * Sign the text launchers before the Electron binary, preserve the image scan
 * entitlement, and produce a structurally valid app. With no configured Apple
 * identity it uses ad-hoc signing; otherwise it keeps electron-builder's chosen
 * Developer ID identity.
 */
async function sign(options) {
  const originalOptionsForFile = options.optionsForFile
  const identity = options.identity || '-'
  const macosDir = path.join(options.app, 'Contents', 'MacOS')

  // @electron/osx-sign only discovers binary-looking files. These two text
  // launchers live in Contents/MacOS, so macOS still treats them as nested code
  // and requires them to be signed before the main Electron executable.
  for (const fileName of ['ciphertalk-mcp', 'ciphertalk-mcp-bootstrap.cjs']) {
    const args = ['--sign', identity, '--force', '--timestamp', '--options', 'runtime']
    if (options.keychain) args.push('--keychain', options.keychain)
    args.push(path.join(macosDir, fileName))
    await execFileAsync('codesign', args)
  }

  await signAsync({
    ...options,
    identity,
    identityValidation: false,
    preAutoEntitlements: false,
    optionsForFile: (filePath) => {
      const inherited = originalOptionsForFile
        ? originalOptionsForFile(filePath)
        : {}

      if (path.basename(filePath) === 'image_scan_helper') {
        return {
          ...inherited,
          entitlements: IMAGE_SCAN_ENTITLEMENTS
        }
      }

      return inherited
    }
  })
}

module.exports = sign
module.exports.sign = sign
