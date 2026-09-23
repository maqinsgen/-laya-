const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Arch } = require('electron-builder');
const { setupMacosWcdbFramework } = require('./setup-macos-wcdb-framework');

const IMAGE_NATIVE_PREFIX = 'ciphertalk-image-native-';
const IMAGE_NATIVE_SUFFIX = '.node';

function resolveNativePlatform(electronPlatformName) {
    if (electronPlatformName === 'darwin') return 'macos';
    if (electronPlatformName === 'win32') return 'win32';
    if (electronPlatformName === 'linux') return 'linux';
    return electronPlatformName;
}

function resolveNativeArch(arch) {
    if (typeof arch === 'string') return arch;
    if (typeof arch === 'number' && Arch[arch]) return Arch[arch];
    return process.arch;
}

function uniqueExistingDirs(candidates) {
    return Array.from(new Set(candidates)).filter((targetPath) => fs.existsSync(targetPath));
}

function installCompatibleMacosDobby(context) {
    if (context.electronPlatformName !== 'darwin') return;

    const productName = context.packager?.appInfo?.productFilename || 'CipherTalk';
    const nativeDir = path.join(
        context.appOutDir,
        `${productName}.app`,
        'Contents',
        'Resources',
        'resources',
        'macos'
    );
    const compatibilitySource = path.join(nativeDir, 'libdobby.macos15.dylib');
    const runtimeTarget = path.join(nativeDir, 'libdobby.dylib');

    if (!fs.existsSync(compatibilitySource)) {
        throw new Error(`[afterPack] 缺少 macOS 15 兼容 Dobby: ${compatibilitySource}`);
    }

    fs.copyFileSync(compatibilitySource, runtimeTarget);
    fs.chmodSync(runtimeTarget, 0o755);
    fs.rmSync(compatibilitySource, { force: true });
    execFileSync('codesign', ['--verify', '--strict', '--verbose=2', runtimeTarget], { stdio: 'inherit' });
    console.log(`[afterPack] 已安装 macOS 15 兼容 Dobby: ${runtimeTarget}`);
}

function installCompatibleMacosImageScanHelper(context) {
    if (context.electronPlatformName !== 'darwin') return;

    const productName = context.packager?.appInfo?.productFilename || 'CipherTalk';
    const nativeDir = path.join(
        context.appOutDir,
        `${productName}.app`,
        'Contents',
        'Resources',
        'resources',
        'macos'
    );
    const compatibilitySource = path.join(nativeDir, 'image_scan_helper.macos15');
    const runtimeTarget = path.join(nativeDir, 'image_scan_helper');

    if (!fs.existsSync(compatibilitySource)) {
        throw new Error(`[afterPack] 缺少 macOS 15 兼容 image_scan_helper: ${compatibilitySource}`);
    }

    fs.copyFileSync(compatibilitySource, runtimeTarget);
    fs.chmodSync(runtimeTarget, 0o755);
    fs.rmSync(compatibilitySource, { force: true });
    execFileSync('codesign', ['--verify', '--strict', '--verbose=2', runtimeTarget], { stdio: 'inherit' });
    console.log(`[afterPack] 已安装 macOS 15 兼容 image_scan_helper: ${runtimeTarget}`);
}

function rewriteNativeManifest(manifestPath, targetKey) {
    if (!fs.existsSync(manifestPath)) return;

    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const nextActiveBinaries = {};
        if (manifest.activeBinaries && manifest.activeBinaries[targetKey]) {
            nextActiveBinaries[targetKey] = manifest.activeBinaries[targetKey];
        }
        manifest.activeBinaries = nextActiveBinaries;
        manifest.platforms = Object.keys(nextActiveBinaries);
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        console.log(`已收敛 image native manifest 到当前平台: ${targetKey}`);
    } catch (error) {
        console.warn(`收敛 image native manifest 失败: ${manifestPath}`, error);
    }
}

function pruneImageNativeAddons(context) {
    const platformDir = resolveNativePlatform(context.electronPlatformName);
    const archDir = resolveNativeArch(context.arch);
    const targetFileName = `${IMAGE_NATIVE_PREFIX}${platformDir}-${archDir}${IMAGE_NATIVE_SUFFIX}`;
    const targetKey = `${platformDir}-${archDir}`;
    const productName = context.packager?.appInfo?.productFilename || 'CipherTalk';
    const resourceRoots = uniqueExistingDirs([
        path.join(context.appOutDir, 'resources'),
        path.join(context.appOutDir, 'Contents', 'Resources'),
        path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources')
    ]);

    for (const resourceRoot of resourceRoots) {
        for (const nativeDir of [
            path.join(resourceRoot, 'resources', 'wedecrypt'),
            path.join(resourceRoot, 'wedecrypt')
        ]) {
            if (!fs.existsSync(nativeDir)) continue;

            const nativeFiles = fs.readdirSync(nativeDir)
                .filter((file) => file.startsWith(IMAGE_NATIVE_PREFIX) && file.endsWith(IMAGE_NATIVE_SUFFIX));
            if (nativeFiles.length === 0) continue;

            if (!nativeFiles.includes(targetFileName)) {
                console.warn(`未找到当前平台 image native addon，跳过裁剪: ${targetFileName}`);
                continue;
            }

            let deletedCount = 0;
            for (const file of nativeFiles) {
                if (file === targetFileName) continue;
                fs.rmSync(path.join(nativeDir, file), { force: true });
                deletedCount++;
            }

            rewriteNativeManifest(path.join(nativeDir, 'manifest.json'), targetKey);
            console.log(`已裁剪 image native addon，仅保留 ${targetFileName}，删除 ${deletedCount} 个无关文件。`);
        }
    }
}

// 构建期硬闸：若源码里有当前平台的图片解密原生插件，则产物里必须也有，否则让构建失败。
// 背景：build.extraResources 的 filter 曾被改成 *.dll，漏打 wedecrypt/*.node，导致发布版图片解密全失败且静默回退（多个版本无人察觉）。
function verifyImageNativePacked(context) {
    const platformDir = resolveNativePlatform(context.electronPlatformName);
    const archDir = resolveNativeArch(context.arch);
    const targetFileName = `${IMAGE_NATIVE_PREFIX}${platformDir}-${archDir}${IMAGE_NATIVE_SUFFIX}`;

    // 源码无此平台/架构插件（如 mac x64 / linux）→ 无可打包内容，跳过
    const sourcePath = path.join(__dirname, '..', 'resources', 'wedecrypt', targetFileName);
    if (!fs.existsSync(sourcePath)) {
        console.log(`[afterPack] 源码无 ${targetFileName}，跳过原生插件打包校验`);
        return;
    }

    const productName = context.packager?.appInfo?.productFilename || 'CipherTalk';
    const resourceRoots = uniqueExistingDirs([
        path.join(context.appOutDir, 'resources'),
        path.join(context.appOutDir, 'Contents', 'Resources'),
        path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources')
    ]);

    for (const resourceRoot of resourceRoots) {
        for (const nativeDir of [
            path.join(resourceRoot, 'resources', 'wedecrypt'),
            path.join(resourceRoot, 'wedecrypt')
        ]) {
            const packed = path.join(nativeDir, targetFileName);
            if (fs.existsSync(packed) && fs.statSync(packed).size > 0) {
                console.log(`[afterPack] 图片解密原生插件已打包: ${packed}`);
                return;
            }
        }
    }

    throw new Error(
        `[afterPack] 图片解密原生插件未打进发布包：期望产物里有 resources/wedecrypt/${targetFileName}，但找不到。` +
        `源码存在该文件，几乎可以确定是 build.extraResources 的 filter 漏掉了 wedecrypt/*.node（历史上被改成过 *.dll）。` +
        `修正 filter 后重新打包。`
    );
}

// 构建期硬闸：sharp 的 libvips 动态库必须打进包，否则让构建失败。
// 背景：build.files 里全局的 !**/*.dylib 曾把 @img/sharp-libvips-darwin-arm64 的 dylib 剥掉，
// mac 发布版启动即主进程崩溃（sharp ERR_DLOPEN_FAILED）。平台瘦身规则只能放 win/mac 各自的 files 下。
function verifySharpVipsPacked(context) {
    const platform = context.electronPlatformName;
    const arch = resolveNativeArch(context.arch);
    // mac 的 libvips 在独立的 sharp-libvips 包；win 的 libvips dll 与 .node 同包
    const pkg = platform === 'darwin' ? `sharp-libvips-darwin-${arch}`
        : platform === 'win32' ? `sharp-win32-${arch}` : null;
    if (!pkg) return;

    const sourceLib = path.join(__dirname, '..', 'node_modules', '@img', pkg, 'lib');
    if (!fs.existsSync(sourceLib)) {
        console.log(`[afterPack] 源码无 @img/${pkg}，跳过 sharp libvips 打包校验`);
        return;
    }

    const productName = context.packager?.appInfo?.productFilename || 'CipherTalk';
    const resourceRoots = uniqueExistingDirs([
        path.join(context.appOutDir, 'resources'),
        path.join(context.appOutDir, 'Contents', 'Resources'),
        path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources')
    ]);

    for (const resourceRoot of resourceRoots) {
        const libDir = path.join(resourceRoot, 'app.asar.unpacked', 'node_modules', '@img', pkg, 'lib');
        if (fs.existsSync(libDir) && fs.readdirSync(libDir).some((f) => f.startsWith('libvips'))) {
            console.log(`[afterPack] sharp libvips 已打包: ${libDir}`);
            return;
        }
    }

    throw new Error(
        `[afterPack] sharp 的 libvips 库未打进发布包：期望 app.asar.unpacked/node_modules/@img/${pkg}/lib/ 下有 libvips*。` +
        `多半是 build.files 的平台排除规则误伤（历史上全局 !**/*.dylib 剥掉过 mac 的 dylib）。` +
        `平台专用排除必须放在 win.files / mac.files 下，修正后重新打包。`
    );
}

// 构建期硬闸：release workflow 使用 npm ci --ignore-scripts，必须显式补齐 ffmpeg-static 的平台二进制。
// 否则包里只有 ffmpeg-static 的 JS 包装文件，导出/语音/转码会在用户机器上退到系统 PATH。
function verifyFfmpegStaticPacked(context) {
    const platform = context.electronPlatformName;
    if (platform !== 'win32' && platform !== 'darwin') return;

    const binaryName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const sourceBinary = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', binaryName);
    if (!fs.existsSync(sourceBinary) || fs.statSync(sourceBinary).size === 0) {
        throw new Error(
            `[afterPack] ffmpeg-static 缺少 ${binaryName}：源码 node_modules/ffmpeg-static 下没有平台二进制。` +
            `release workflow 使用 npm ci --ignore-scripts，需在构建前运行 node node_modules/ffmpeg-static/install.js。`
        );
    }

    const productName = context.packager?.appInfo?.productFilename || 'CipherTalk';
    const resourceRoots = uniqueExistingDirs([
        path.join(context.appOutDir, 'resources'),
        path.join(context.appOutDir, 'Contents', 'Resources'),
        path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources')
    ]);

    for (const resourceRoot of resourceRoots) {
        const packed = path.join(resourceRoot, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', binaryName);
        if (fs.existsSync(packed) && fs.statSync(packed).size > 0) {
            console.log(`[afterPack] ffmpeg-static 已打包: ${packed}`);
            return;
        }
    }

    throw new Error(
        `[afterPack] ffmpeg-static 未打进发布包：期望 app.asar.unpacked/node_modules/ffmpeg-static/${binaryName}。` +
        `请检查 build.files / asarUnpack 是否误裁剪 ffmpeg-static。`
    );
}

function pruneWhisperResources(context) {
    if (context.electronPlatformName !== 'win32') return;

    const productName = context.packager?.appInfo?.productFilename || 'CipherTalk';
    const resourceRoots = uniqueExistingDirs([
        path.join(context.appOutDir, 'resources'),
        path.join(context.appOutDir, 'Contents', 'Resources'),
        path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources')
    ]);

    let deletedCount = 0;
    for (const resourceRoot of resourceRoots) {
        const candidates = [
            path.join(resourceRoot, 'app.asar.unpacked', 'resources', 'whisper'),
            path.join(resourceRoot, 'resources', 'whisper')
        ];
        for (const targetPath of candidates) {
            if (!fs.existsSync(targetPath)) continue;
            fs.rmSync(targetPath, { recursive: true, force: true });
            deletedCount += 1;
            console.log(`[afterPack] 已移除 Windows 包内 whisper 运行库: ${targetPath}`);
        }
    }

    if (deletedCount === 0) {
        console.log('[afterPack] Windows 包内未发现 whisper 运行库。');
    }
}

exports.default = async function (context) {
    // context.appOutDir 是打包后的临时解压目录
    const localesDir = path.join(context.appOutDir, 'locales');

    if (fs.existsSync(localesDir)) {
        console.log('正在清理多余的 Chromium 语言包...');
        const files = fs.readdirSync(localesDir);

        // 只保留中文(简体/繁体)和英文
        const whitelist = [
            'zh-CN.pak',
            'en-US.pak'
        ];

        let deletedCount = 0;
        for (const file of files) {
            if (file.endsWith('.pak') && !whitelist.includes(file)) {
                fs.unlinkSync(path.join(localesDir, file));
                deletedCount++;
            }
        }
        console.log(`已删除 ${deletedCount} 个无关语言包，仅保留中英文。`);
    }

    pruneImageNativeAddons(context);

    pruneWhisperResources(context);

    verifyImageNativePacked(context);

    verifySharpVipsPacked(context);

    verifyFfmpegStaticPacked(context);

    if (context.electronPlatformName === 'darwin') {
        installCompatibleMacosDobby(context);
        installCompatibleMacosImageScanHelper(context);

        const productName = context.packager?.appInfo?.productFilename || 'CipherTalk';
        const launcherCandidates = [
            path.join(context.appOutDir, 'ciphertalk-mcp'),
            path.join(context.appOutDir, `${productName}.app`, 'Contents', 'MacOS', 'ciphertalk-mcp')
        ];

        for (const launcherPath of launcherCandidates) {
            if (!fs.existsSync(launcherPath)) continue;
            fs.chmodSync(launcherPath, 0o755);
            console.log(`已确保 macOS MCP 启动器可执行: ${launcherPath}`);
            break;
        }

        setupMacosWcdbFramework(context);
    }
};
