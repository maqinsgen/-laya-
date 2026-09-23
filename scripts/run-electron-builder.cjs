const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const pkg = require('../package.json')

const target = process.argv[2]

if (!target || !['win', 'mac'].includes(target)) {
  console.error('Usage: node scripts/run-electron-builder.cjs <win|mac>')
  process.exit(1)
}

const cliPath = require.resolve('electron-builder/cli.js')
const configPath = path.join(__dirname, 'electron-builder.config.cjs')
const env = {
  ...process.env,
  CIPHERTALK_BUILD_TARGET: target
}

if (target === 'mac') {
  const explicitSigningRequested = Boolean(
    env.CSC_LINK ||
    env.CSC_NAME ||
    env.CSC_IDENTITY_AUTO_DISCOVERY === 'true'
  )

  if (!explicitSigningRequested) {
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  }
}

if (env.GITHUB_ACTIONS) {
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase()
    if (
      normalized === 'electron_mirror' ||
      normalized === 'electron_builder_binaries_mirror' ||
      normalized === 'npm_config_electron_mirror' ||
      normalized === 'npm_config_electron_builder_binaries_mirror'
    ) {
      delete env[key]
    }
  }
}

const buildStartedAt = Date.now()
const result = spawnSync(
  process.execPath,
  [cliPath, `--${target}`, '--publish', 'never', '--config', configPath],
  {
    stdio: 'inherit',
    env
  }
)

if (result.error) {
  console.error(`[electron-builder] failed to start: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

// 构建阶段只要求安装包产物存在，自动更新元数据交给后续发布阶段校验。
const artifactName = target === 'mac'
  ? `release/CipherTalk-${pkg.version}-Setup.dmg`
  : `release/CipherTalk-${pkg.version}-Setup.exe`
const artifactPath = path.join(__dirname, '..', artifactName)
if (!fs.existsSync(artifactPath)) {
  console.error(`[electron-builder] expected artifact missing: ${artifactPath}`)
  process.exit(1)
}
const artifactStat = fs.statSync(artifactPath)
if (artifactStat.mtimeMs < buildStartedAt - 1000) {
  console.error(`[electron-builder] artifact was not refreshed by this build: ${artifactPath}`)
  process.exit(1)
}
