# 发布与公开源码边界

当前发布目标为 [maqinsgen/-laya-](https://github.com/maqinsgen/-laya-)。`package.json` 的 GitHub 发布元数据已指向该仓库；`build`、`build:ci` 和 Windows/macOS 打包包装器均显式使用 `--publish never`。本地构建只生成文件，不上传安装包。应用 ID、版本和安装包文件名仍沿用现有值；这些发布元数据不等于已实现新的更新服务。

## GitHub Actions

`.github/workflows/core-tests.yml` 只安装依赖、检查 renderer TypeScript 并运行合成待办测试。权限仅为 `contents: read`，checkout 不保留凭据，不需要仓库 secrets，不运行 Electron、不读取微信数据、不调用模型或发布服务。依赖安装需要访问 npm 注册表；CI 使用 `npm ci --legacy-peer-deps --ignore-scripts`，跳过 Electron 下载和原生模块重编译。现有锁文件需要 `--legacy-peer-deps`：普通 `npm ci` 会要求锁中缺失的 peer 依赖。该参数沿用现有依赖树，不重写依赖或锁文件。**这种安装适合纯测试，不是可直接运行桌面程序的完整安装。**

继承自 [CipherTalk](https://github.com/ILoveBingLu/CipherTalk) 的三个 workflow 原样归档至 `docs/upstream-workflows/*.yml.disabled`，不再由 Actions 执行：

- `release.yml`：原来在 `v*` tag 推送后构建、发布 GitHub Release、镜像到 R2，并发送 Telegram 成功/失败通知。
- `ciphertalk-cli.yml`：原来可手动发布 `ciphertalk-cli` 到 npm，并提交版本及 tag。
- `oosmetrics.yml`：原来定期调用第三方 action，关闭/创建健康报告 issue。

这些归档仅用于保留来源与参考。不要改回活动 workflow，或配置上游发布 secrets。新的安装包上传、签名及公证流程需要另行配置；源码推送不触发安装包发布。

## 运行资源与可复现限制

正常开发安装使用 `npm ci --legacy-peer-deps`，需要网络以及当前平台支持的 Electron、better-sqlite3、sharp、koffi 等依赖；安装钩子会运行 `electron-rebuild`。不要使用 sudo 修改项目或 npm 缓存权限。仅完成纯测试不能证明桌面包可运行。本轮在隔离临时目录验证了上述锁文件的安装计划（`--dry-run --ignore-scripts`），未声称在所有平台重新安装或运行桌面包均已通过。

公开快照应保留 `resources/` 中已有的数据库/图片原生运行库、macOS helper、entitlements、`login-capture/` Python 源码及其许可文件。CLI 如保留，也必须保留 `CipherTalk-CLI/native/` 对应平台二进制。现有 tracked 单文件最大约 9.22 MiB，无需为单文件体积限制删除这些运行依赖。

`wcdb_api/` 是上游私有源码，不在公开仓库；当前 checkout 也没有 `native/image-decrypt/` 与 `native-dlls/build-macos.sh`。因此 `npm run native:macos` 和 `npm run native:image:build` **不能仅凭本公开源码从零重编译全部原生组件**。公开版本依赖随附预编译运行库，不应宣称完全可复现的原生构建。`native-dlls/macos/image_scan_helper.c` 是本分支提供的薄包装源码，导出快照时需单独保留；其构建脚本为 `scripts/build-macos-image-scan-helper.sh`。

macOS 打包还使用 `resources/macos/libdobby.macos15.dylib` 与 `image_scan_helper.macos15`。当前目标为 macOS 15；登录期自动取钥只支持 Apple Silicon/arm64，要求 LLDB、Python 3.9+ 和系统允许附加。应用不会修改 SIP 或微信签名；单台机器成功不代表默认系统环境均可用。临时签名不是 Apple 公证。Android/iPhone 是伴侣端，不能宣称手机原生提取微信数据库密钥。

## 分发清单

保留根 `LICENSE` 中的 CipherTalk 原作者署名与 CC BY-NC-SA 4.0 条款、CLI 自身的 MIT LICENSE，以及 `THIRD_PARTY_NOTICES/`（Jev、Laya、WcdbKeyTool）和登录捕获资源的 LICENSE/NOTICE。更名不改变原有许可。第三方模型权重不包含在源码中。

不要提交 `.git` 旧历史、用户数据库及配置、密钥/候选文件、`.env`、`.tmp`、`.cache`、模型权重、虚拟环境、`node_modules`、构建产物、日志和本机验证截图。模型按文档另行下载，安装包通过独立的发布流程分发；公开前按实际导出文件重新检查大小和敏感信息，不能只依靠 `.gitignore`。
