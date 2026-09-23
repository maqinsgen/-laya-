const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');

// Upstream CipherTalk commit 12a699974d492dce4c968c924a03763ed20193a9.
// Pinning prevents an expired or locally substituted WCDB bridge from entering a release.
const EXPECTED_WCDB_API_SHA256 = '4d174824ccc8afa9b0aa82c8edf8b7570c1d43f09ac5da97c561fad1f547e509';
const EXPECTED_DOBBY_SHA256 = '92091420d4552cf382c058c16f898af35d539f859b719657fb128e05db1873e0';
const EXPECTED_IMAGE_SCAN_HELPER_SHA256 = '33e7b6e306e1dcabaece677d3f6ee32519f57132567a4559d366fe6b8f34a8a1';

function fail(message, detail = '') {
    console.error(`[macos-package-check] ${message}${detail ? `\n${detail}` : ''}`);
    process.exit(1);
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.status !== 0) {
        fail(`${command} ${args.join(' ')} 失败`, `${result.stdout || ''}${result.stderr || ''}`.trim());
    }
    return `${result.stdout || ''}${result.stderr || ''}`;
}

function requireSymlink(linkPath, expectedTarget) {
    let actualTarget;
    try {
        actualTarget = fs.readlinkSync(linkPath);
    } catch (error) {
        fail(`缺少软链接: ${linkPath}`, String(error));
    }
    if (actualTarget !== expectedTarget) {
        fail(`软链接目标错误: ${linkPath}`, `expected=${expectedTarget}\nactual=${actualTarget}`);
    }
}

function compareVersions(left, right) {
    const a = String(left).split('.').map(Number);
    const b = String(right).split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const delta = (a[i] || 0) - (b[i] || 0);
        if (delta !== 0) return delta;
    }
    return 0;
}

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizeThinMachO(buffer, sliceOffset = 0) {
    if (buffer.length < sliceOffset + 32 || buffer.readUInt32LE(sliceOffset) !== 0xfeedfacf) return;

    const commandCount = buffer.readUInt32LE(sliceOffset + 16);
    let commandOffset = sliceOffset + 32;
    for (let index = 0; index < commandCount; index += 1) {
        if (commandOffset + 8 > buffer.length) return;
        const command = buffer.readUInt32LE(commandOffset);
        const commandSize = buffer.readUInt32LE(commandOffset + 4);
        if (commandSize < 8 || commandOffset + commandSize > buffer.length) return;

        if (command === 0x19) { // LC_SEGMENT_64
            const segmentName = buffer
                .subarray(commandOffset + 8, commandOffset + 24)
                .toString('ascii')
                .replace(/\0.*$/, '');
            if (segmentName === '__LINKEDIT') {
                // Re-signing can resize only the signature area at the end of
                // __LINKEDIT. Ignore those bookkeeping fields, not executable code.
                buffer.fill(0, commandOffset + 32, commandOffset + 40);
                buffer.fill(0, commandOffset + 48, commandOffset + 56);
            }
        }
        commandOffset += commandSize;
    }
}

function normalizeMachO(buffer) {
    const fatMagic = buffer.length >= 8 ? buffer.readUInt32BE(0) : 0;
    if (fatMagic === 0xcafebabe) {
        const architectureCount = buffer.readUInt32BE(4);
        for (let index = 0; index < architectureCount; index += 1) {
            const entryOffset = 8 + index * 20;
            if (entryOffset + 20 > buffer.length) break;
            normalizeThinMachO(buffer, buffer.readUInt32BE(entryOffset + 8));
        }
        return;
    }
    normalizeThinMachO(buffer);
}

function unsignedCodeHash(filePath, temporaryRoot) {
    const copyPath = path.join(temporaryRoot, `${crypto.randomUUID()}-${path.basename(filePath)}`);
    fs.copyFileSync(filePath, copyPath);
    run('codesign', ['--remove-signature', copyPath]);
    const buffer = fs.readFileSync(copyPath);
    normalizeMachO(buffer);
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function requireSameUnsignedCode(sourcePath, packagedPath, temporaryRoot) {
    const sourceHash = unsignedCodeHash(sourcePath, temporaryRoot);
    const packagedHash = unsignedCodeHash(packagedPath, temporaryRoot);
    if (sourceHash !== packagedHash) {
        fail(
            `重新签名前后原生代码不一致: ${path.basename(packagedPath)}`,
            `source=${sourceHash}\npackaged=${packagedHash}`
        );
    }
}

const appPath = path.resolve(process.argv[2] || path.join('release', 'mac-arm64', 'CipherTalk.app'));
const frameworkPath = path.join(appPath, 'Contents', 'Frameworks', 'WCDB.framework');
const sourceDylib = path.join(appPath, 'Contents', 'Resources', 'resources', 'macos', 'libWCDB.dylib');
const apiDylib = path.join(appPath, 'Contents', 'Resources', 'resources', 'macos', 'libwcdb_api.dylib');
const nativeRoot = path.dirname(apiDylib);
const appInfoPlist = path.join(appPath, 'Contents', 'Info.plist');
const mcpLauncherPath = path.join(appPath, 'Contents', 'MacOS', 'ciphertalk-mcp');
const mcpBootstrapPath = path.join(appPath, 'Contents', 'MacOS', 'ciphertalk-mcp-bootstrap.cjs');
const sourceApiDylib = path.resolve('resources', 'macos', 'libwcdb_api.dylib');
const sourceDobbyPath = path.resolve('resources', 'macos', 'libdobby.macos15.dylib');
const sourceImageScanHelperPath = path.resolve('resources', 'macos', 'image_scan_helper.macos15');

for (const requiredPath of [
    appPath,
    frameworkPath,
    sourceDylib,
    apiDylib,
    mcpLauncherPath,
    mcpBootstrapPath,
    sourceApiDylib,
    sourceDobbyPath,
    sourceImageScanHelperPath,
]) {
    if (!fs.existsSync(requiredPath)) fail(`缺少打包文件: ${requiredPath}`);
}

const installNameOutput = run('otool', ['-D', sourceDylib]);
const versionMatch = installNameOutput.match(/WCDB\.framework\/Versions\/([^/]+)\/WCDB/);
if (!versionMatch) fail('无法从 libWCDB.dylib install_name 解析 framework 版本', installNameOutput);

const version = versionMatch[1];
const versionedRoot = path.join(frameworkPath, 'Versions', version);
const versionedBinary = path.join(versionedRoot, 'WCDB');
const infoPlist = path.join(versionedRoot, 'Resources', 'Info.plist');

for (const requiredPath of [versionedBinary, infoPlist]) {
    if (!fs.existsSync(requiredPath)) fail(`缺少 framework 文件: ${requiredPath}`);
}

requireSymlink(path.join(frameworkPath, 'Versions', 'Current'), version);
requireSymlink(path.join(frameworkPath, 'WCDB'), path.join('Versions', 'Current', 'WCDB'));
requireSymlink(path.join(frameworkPath, 'Resources'), path.join('Versions', 'Current', 'Resources'));

run('plutil', ['-lint', infoPlist]);
const plist = run('plutil', ['-p', infoPlist]);
for (const marker of ['"CFBundleExecutable" => "WCDB"', '"CFBundlePackageType" => "FMWK"']) {
    if (!plist.includes(marker)) fail(`Info.plist 缺少 ${marker}`, plist);
}

const apiHash = sha256(sourceApiDylib);
if (apiHash !== EXPECTED_WCDB_API_SHA256) {
    fail('libwcdb_api.dylib 不匹配已审计的上游版本', `expected=${EXPECTED_WCDB_API_SHA256}\nactual=${apiHash}`);
}

const dobbyPath = path.join(nativeRoot, 'libdobby.dylib');
const dobbyHash = sha256(sourceDobbyPath);
if (dobbyHash !== EXPECTED_DOBBY_SHA256) {
    fail('libdobby.dylib 不匹配已审计的 macOS 15 构建', `expected=${EXPECTED_DOBBY_SHA256}\nactual=${dobbyHash}`);
}

const imageScanHelperPath = path.join(nativeRoot, 'image_scan_helper');
const imageScanHelperHash = sha256(sourceImageScanHelperPath);
if (imageScanHelperHash !== EXPECTED_IMAGE_SCAN_HELPER_SHA256) {
    fail(
        'image_scan_helper 不匹配已审计的 macOS 15 构建',
        `expected=${EXPECTED_IMAGE_SCAN_HELPER_SHA256}\nactual=${imageScanHelperHash}`
    );
}

// These Python helpers must ship outside app.asar for xcrun/LLDB to load them.
for (const name of ['supervisor.py', 'wechat_lldb_capture.py', 'wechat_key_verify.py']) {
    const source = path.resolve(__dirname, '..', 'resources', 'macos', 'login-capture', name);
    const packaged = path.join(nativeRoot, 'login-capture', name);
    if (!fs.existsSync(packaged) || sha256(source) !== sha256(packaged)) {
        fail(`登录捕获组件缺失或内容不匹配: ${name}`);
    }
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ciphertalk-native-check-'));
try {
    requireSameUnsignedCode(sourceApiDylib, apiDylib, temporaryRoot);
    requireSameUnsignedCode(sourceDobbyPath, dobbyPath, temporaryRoot);
    requireSameUnsignedCode(sourceImageScanHelperPath, imageScanHelperPath, temporaryRoot);
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

const apiStrings = run('strings', [apiDylib]);
if (!apiStrings.includes('@loader_path/libWCDB.dylib')) {
    fail('libwcdb_api.dylib 未声明同目录 WCDB 运行时加载目标');
}
if (/license expired:\s*20\d{2}-\d{2}-\d{2}/i.test(apiStrings)) {
    fail('libwcdb_api.dylib 仍包含固定日期到期逻辑');
}

const apiSymbols = run('nm', ['-gU', apiDylib]);
for (const symbol of ['_wcdb_set_client_info', '_wcdb_check_license', '_wcdb_init', '_wcdb_open_account']) {
    if (!apiSymbols.includes(symbol)) fail(`libwcdb_api.dylib 缺少导出符号 ${symbol}`);
}

const minimumSystemVersion = run('plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', appInfoPlist]).trim();
const nativeFiles = [
    apiDylib,
    sourceDylib,
    path.join(nativeRoot, 'libwx_key.dylib'),
    path.join(nativeRoot, 'libdobby.dylib'),
    path.join(nativeRoot, 'xkey_helper'),
    path.join(nativeRoot, 'image_scan_helper'),
];
for (const nativeFile of nativeFiles) {
    if (!fs.existsSync(nativeFile)) fail(`缺少 macOS 原生文件: ${nativeFile}`);
    const buildInfo = run('vtool', ['-show-build', nativeFile]);
    const minVersions = [...buildInfo.matchAll(/\bminos\s+([0-9.]+)/g)].map((match) => match[1]);
    if (minVersions.length === 0) fail(`无法读取最低系统版本: ${nativeFile}`, buildInfo);
    for (const nativeMinimum of minVersions) {
        if (compareVersions(nativeMinimum, minimumSystemVersion) > 0) {
            fail(
                `原生组件最低系统版本高于应用声明: ${path.basename(nativeFile)}`,
                `component=${nativeMinimum}\napp=${minimumSystemVersion}`
            );
        }
    }
}

run('codesign', ['--verify', '--strict', '--verbose=2', apiDylib]);
run('codesign', ['--verify', '--strict', '--verbose=2', dobbyPath]);
run('codesign', ['--verify', '--strict', '--verbose=2', imageScanHelperPath]);
run('codesign', ['--verify', '--strict', '--verbose=2', versionedBinary]);
run('codesign', ['--verify', '--strict', '--verbose=2', frameworkPath]);
run('codesign', ['--verify', '--strict', '--verbose=2', mcpLauncherPath]);
run('codesign', ['--verify', '--strict', '--verbose=2', mcpBootstrapPath]);
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);

const helperEntitlements = run('codesign', ['--display', '--entitlements', '-', imageScanHelperPath]);
for (const entitlement of [
    'com.apple.security.cs.debugger',
    'com.apple.security.cs.allow-unsigned-executable-memory',
]) {
    if (!helperEntitlements.includes(entitlement)) {
        fail(`image_scan_helper 缺少进程扫描权限 ${entitlement}`, helperEntitlements);
    }
}

const appEntitlements = run('codesign', ['--display', '--entitlements', '-', appPath]);
if (!appEntitlements.includes('com.apple.security.cs.allow-jit')) {
    fail('CipherTalk.app 缺少 Electron/V8 所需权限 com.apple.security.cs.allow-jit', appEntitlements);
}

console.log(`[macos-package-check] 通过: ${frameworkPath}`);
console.log(`[macos-package-check] WCDB version=${version}, app minimum macOS=${minimumSystemVersion}`);
console.log(`[macos-package-check] libwcdb_api SHA-256=${apiHash}`);
console.log(`[macos-package-check] libdobby SHA-256=${dobbyHash}`);
console.log(`[macos-package-check] image_scan_helper SHA-256=${imageScanHelperHash}`);
