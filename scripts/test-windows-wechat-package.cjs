'use strict'

// Configuration contract only: no package build, native module load, or process
// inspection. Paths below are representative archive/resource entries, not
// claims that a Windows installer has been produced or executed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Minimatch } = require('minimatch')
const pkg = require('../package.json')
const root = path.resolve(__dirname, '..')
const configPath = require.resolve('./electron-builder.config.cjs')

function loadWindowsConfig() {
  const previousTarget = process.env.CIPHERTALK_BUILD_TARGET
  const previousModule = require.cache[configPath]
  try {
    process.env.CIPHERTALK_BUILD_TARGET = 'win'
    delete require.cache[configPath]
    return require(configPath)
  } finally {
    if (previousTarget === undefined) delete process.env.CIPHERTALK_BUILD_TARGET
    else process.env.CIPHERTALK_BUILD_TARGET = previousTarget
    delete require.cache[configPath]
    if (previousModule) require.cache[configPath] = previousModule
  }
}

// electron-builder applies filters in order: a later positive pattern may
// re-include an earlier exclusion (notably Koffi's build/ native binary).
function matches(file, patterns, initiallyIncluded = false, isDirectory = false) {
  let included = initiallyIncluded
  for (const pattern of patterns) {
    const matcher = new Minimatch(pattern, { dot: true })
    if (included === matcher.negate) included = matcher.match(file, isDirectory && !matcher.negate)
  }
  return included
}

function filePatterns(config) {
  const result = []
  for (const value of [...(config.files || []), ...(config.win?.files || [])]) {
    if (typeof value === 'string') result.push(value)
    else {
      assert.ok(!value.from || value.from === '.', 'Update this test to resolve any non-root app file set')
      result.push(...(value.filter || ['**/*']))
    }
  }
  return result
}

function externalDestinations(config, source) {
  const destinations = []
  for (const rule of config.extraResources || []) {
    assert.equal(typeof rule, 'object', 'Update this test if extraResources uses a string rule')
    const from = rule.from.replace(/\\/g, '/').replace(/\/+$/, '')
    const relative = path.posix.relative(from, source)
    if (!relative || relative.startsWith('../') || path.posix.isAbsolute(relative)) continue
    const patterns = rule.filter || ['**/*']
    const onlyExclusions = patterns.every(pattern => pattern.startsWith('!'))
    if (matches(relative, patterns, onlyExclusions)) destinations.push(path.posix.join(rule.to || rule.from, relative))
  }
  return destinations
}

const windows = loadWindowsConfig()
const worker = 'resources/windows/wechat-key-scan.cjs'
const readerRoot = 'node_modules/better-sqlite3-multiple-ciphers'
const readerBinary = `${readerRoot}/prebuilds/win32-x64.node`
const koffiBinary = 'node_modules/koffi/build/koffi/win32_x64/koffi.node'
const otherReaderTargets = [
  'win32-arm64', 'win32-ia32', 'darwin-x64', 'darwin-arm64',
  'linux-x64', 'linux-arm64', 'linuxmusl-x64', 'linuxmusl-arm64', 'android-arm64',
]

assert.ok(fs.statSync(path.join(root, worker)).isFile(), 'The worker source must exist before packaging')
assert.ok(pkg.dependencies['better-sqlite3-multiple-ciphers'], 'The reader must be a production dependency')
assert.ok(pkg.dependencies.koffi, 'Koffi must be a production dependency')
assert.match(pkg.scripts['build:win'], /run-electron-builder\.cjs win/, 'Windows build must use the checked config')
const runner = fs.readFileSync(path.join(root, 'scripts/run-electron-builder.cjs'), 'utf8')
assert.match(runner, /CIPHERTALK_BUILD_TARGET:\s*target/, 'The build runner must select the Windows config')
assert.match(runner, /electron-builder\.config\.cjs/, 'The runner must reference this config')
assert.match(runner, /['"]--config['"]/, 'The runner must pass its config to electron-builder')

for (const [name, config] of [['Windows build config', windows], ['package.json default build', pkg.build]]) {
  const patterns = filePatterns(config)
  assert.ok(externalDestinations(config, worker).includes(worker), `${name}: helper must be copied outside ASAR to resources/windows`)
  // Production dependencies enter electron-builder's dependency copy pass by
  // default. These assertions exercise the effective ordered app/platform
  // filters and fail if a new exclusion strips the reader or its JS loader.
  for (const file of [readerBinary, `${readerRoot}/package.json`, `${readerRoot}/lib/index.js`, 'node_modules/koffi/package.json', 'node_modules/koffi/index.js']) {
    assert.ok(matches(file, patterns, true), `${name}: required runtime file was excluded: ${file}`)
  }
  assert.ok(matches(readerBinary, config.asarUnpack || []), `${name}: the reader native binary must be unpacked`)
  assert.ok(matches(`${readerRoot}/lib/index.js`, config.asarUnpack || []), `${name}: the reader's JS loader must be unpacked with its package`)
  assert.ok(matches(koffiBinary, config.asarUnpack || []), `${name}: the Windows Koffi native binary must be unpacked`)
  for (const target of otherReaderTargets) {
    assert.equal(matches(`${readerRoot}/prebuilds/${target}.node`, patterns, true), false,
      `${name}: a foreign reader prebuild would enter the Windows x64 package: ${target}`)
  }
  console.log(`ok - ${name}: helper, reader runtime, native unpacking, and platform exclusions`)
}

const windowsPatterns = filePatterns(windows)
assert.ok(matches(koffiBinary, windowsPatterns, true), 'Windows config must re-include the Koffi x64 native binary after build/ exclusions')
for (const file of [koffiBinary, readerBinary]) {
  let directory = path.posix.dirname(file)
  while (directory !== '.') {
    assert.ok(matches(directory, windowsPatterns, true, true), `Windows config must traverse runtime parent directory: ${directory}`)
    directory = path.posix.dirname(directory)
  }
}

for (const target of ['win32_arm64', 'win32_ia32', 'darwin_x64', 'darwin_arm64', 'linux_x64', 'linux_arm64', 'freebsd_x64']) {
  const binary = `node_modules/koffi/build/koffi/${target}/koffi.node`
  assert.equal(matches(binary, windowsPatterns, true), false, `Windows config must exclude foreign Koffi binary ${target}`)
  assert.equal(matches(binary, windows.asarUnpack || []), false, `Windows config must not unpack foreign Koffi binary ${target}`)
}
// A file filter must not accidentally undo the helper's external destination by
// relying on a source-only path in app.asar; getWorkerPath uses resourcesPath.
assert.equal(matches(worker, windowsPatterns), false, 'Windows helper should be supplied through extraResources')
console.log('ok - Windows x64 Koffi is retained and foreign native binaries are excluded')
console.log('Windows WeChat package filter contracts passed; no installer was built or run.')
