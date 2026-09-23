const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const FRAMEWORK_NAME = 'WCDB';
const SOURCE_DYLIB_NAME = 'libWCDB.dylib';
const FALLBACK_VERSION = 'A';

function xmlEscape(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function createFrameworkInfoPlist(version) {
    const bundleVersion = /^\d+(?:\.\d+){0,2}$/.test(version) ? version : '1.0.0';
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>${FRAMEWORK_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>com.ciphertalk.wcdb</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>${FRAMEWORK_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>FMWK</string>
    <key>CFBundleShortVersionString</key>
    <string>${xmlEscape(bundleVersion)}</string>
    <key>CFBundleSupportedPlatforms</key>
    <array>
        <string>MacOSX</string>
    </array>
    <key>CFBundleVersion</key>
    <string>${xmlEscape(bundleVersion)}</string>
</dict>
</plist>
`;
}

/**
 * 从 dylib 的 install_name 解析期望的 framework 版本号。
 *
 * libWCDB.dylib 的 install_name 形如：
 *   @rpath/WCDB.framework/Versions/2.1.15/WCDB
 *
 * 解析失败时回退到 macOS framework 默认版本 "A"。
 */
function detectFrameworkVersion(dylibPath) {
    try {
        const result = spawnSync('otool', ['-D', dylibPath], { encoding: 'utf8' });
        if (result.status !== 0) return FALLBACK_VERSION;
        const match = result.stdout.match(/WCDB\.framework\/Versions\/([^/]+)\/WCDB/);
        if (match && match[1]) return match[1];
    } catch (error) {
        // ignore，回退默认值
    }
    return FALLBACK_VERSION;
}

function safeUnlink(targetPath) {
    try {
        fs.unlinkSync(targetPath);
    } catch (error) {
        if (error && error.code !== 'ENOENT') throw error;
    }
}

/**
 * 在 mac App 包内构造 WCDB.framework 目录结构。
 *
 * 这个修复存在的原因：
 *
 *   WCDB 主二进制的 install_name 是
 *   @rpath/WCDB.framework/Versions/<ver>/WCDB，但 native 构建产物同时以
 *   libWCDB.dylib 的扁平文件形式放在 resources/macos/。新版桥接库会从
 *   @loader_path/libWCDB.dylib 显式加载它；这里仍提供标准 framework 别名，
 *   兼容旧桥接库和按 LC_ID_DYLIB 解析依赖的系统工具/后续签名流程。
 *
 *   dyld 在运行时按 framework 路径找不到主二进制，会抛出：
 *     Library not loaded: @rpath/WCDB.framework/Versions/<ver>/WCDB
 *     Reason: tried: '<App>/Contents/Frameworks/WCDB.framework/Versions/<ver>/WCDB' (no such file)
 *
 *   缺少这个别名时，旧桥接库会导致 GUI 解密入口报
 *   "WCDB 初始化异常: Failed to load shared library"。
 *
 * 修复办法：
 *
 *   把 Contents/Resources/resources/macos/libWCDB.dylib 按标准 framework 结构
 *   布到 Contents/Frameworks/WCDB.framework/，并 ad-hoc 重签名。
 *
 *   不删除原 libWCDB.dylib（保留作为后向兼容来源 / 后备）。
 */
function setupMacosWcdbFramework(context) {
    if (context.electronPlatformName !== 'darwin') return;

    const productName = context.packager?.appInfo?.productFilename || 'CipherTalk';
    const appBundle = path.join(context.appOutDir, `${productName}.app`);
    if (!fs.existsSync(appBundle)) {
        console.warn(`[macos-wcdb-framework] App bundle 不存在，跳过: ${appBundle}`);
        return;
    }

    const sourceDylib = path.join(
        appBundle, 'Contents', 'Resources', 'resources', 'macos', SOURCE_DYLIB_NAME
    );
    if (!fs.existsSync(sourceDylib)) {
        console.warn(`[macos-wcdb-framework] 源 dylib 不存在，跳过: ${sourceDylib}`);
        return;
    }

    const version = detectFrameworkVersion(sourceDylib);
    const frameworkDir = path.join(
        appBundle, 'Contents', 'Frameworks', `${FRAMEWORK_NAME}.framework`
    );
    const versionedDir = path.join(frameworkDir, 'Versions', version);
    const versionedBinary = path.join(versionedDir, FRAMEWORK_NAME);
    const versionedResources = path.join(versionedDir, 'Resources');
    const infoPlist = path.join(versionedResources, 'Info.plist');
    const currentSymlink = path.join(frameworkDir, 'Versions', 'Current');
    const topSymlink = path.join(frameworkDir, FRAMEWORK_NAME);
    const resourcesSymlink = path.join(frameworkDir, 'Resources');

    console.log(`[macos-wcdb-framework] 构建 ${FRAMEWORK_NAME}.framework (version=${version})`);

    // 1. 从干净目录构造标准的版本化 framework bundle。
    //    缺少 Resources/Info.plist 时 codesign 会把目录判定为非法 bundle。
    fs.rmSync(frameworkDir, { recursive: true, force: true });
    fs.mkdirSync(versionedResources, { recursive: true });

    // 2. 复制主二进制
    fs.copyFileSync(sourceDylib, versionedBinary);
    fs.chmodSync(versionedBinary, 0o755);

    // 3. 写入 framework bundle 元数据
    fs.writeFileSync(infoPlist, createFrameworkInfoPlist(version), 'utf8');

    // 4. Versions/Current → <version>
    safeUnlink(currentSymlink);
    fs.symlinkSync(version, currentSymlink);

    // 5. WCDB → Versions/Current/WCDB
    safeUnlink(topSymlink);
    fs.symlinkSync(path.join('Versions', 'Current', FRAMEWORK_NAME), topSymlink);

    // 6. Resources → Versions/Current/Resources
    safeUnlink(resourcesSymlink);
    fs.symlinkSync(path.join('Versions', 'Current', 'Resources'), resourcesSymlink);

    // 7. ad-hoc 重签名并严格验证。这里失败必须中止打包，否则会生成
    //    镜像结构正常、但 Gatekeeper/正式签名阶段必然失败的产物。
    execFileSync('codesign', ['--force', '--sign', '-', versionedBinary], { stdio: 'inherit' });
    execFileSync('codesign', ['--force', '--sign', '-', frameworkDir], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--strict', '--verbose=2', frameworkDir], { stdio: 'inherit' });
    console.log(`[macos-wcdb-framework] 已 ad-hoc 签名并通过严格验证`);

    console.log(`[macos-wcdb-framework] 完成: ${frameworkDir}`);
}

if (require.main === module) {
    const appOutDir = process.argv[2] || path.join(process.cwd(), 'release', 'mac-arm64');
    setupMacosWcdbFramework({ electronPlatformName: 'darwin', appOutDir });
}

module.exports = { createFrameworkInfoPlist, setupMacosWcdbFramework };
