# macOS Native Resources

这个目录是 CipherTalk 的 macOS 原生产物落点。

`libdobby.macos15.dylib` 是发布包使用的 Dobby 通用构建，固定源码提交
`5dfc8546954ce3b3198132ab13fddb89ee92cdd7`，arm64/x86_64 的 deployment
target 均为 macOS 15.0。运行 `bash scripts/build-macos-dobby.sh` 可重新生成；
`afterPack` 会把它安装为包内的 `libdobby.dylib`，不会覆盖工作区里可能由
本地密钥提取开发流程生成的同名文件。

`image_scan_helper.macos15` 是可审计薄包装器：它从同目录加载
`libwx_key.dylib` 并调用 `ScanMemoryForImageKey`。源文件位于
`native-dlls/macos/image_scan_helper.c`，运行
`bash scripts/build-macos-image-scan-helper.sh` 可重建 macOS 15 通用版本；
`afterPack` 同样只替换发布包内副本。

没有配置 Apple 证书时，`npm run build:mac` 会对整个 `.app` 做临时签名，保证
本地构建的嵌套 framework、dylib 与辅助进程签名链一致；
`image_scan_helper` 会继续使用专用权限文件。设置 `CSC_LINK`、`CSC_NAME`，或
显式启用 `CSC_IDENTITY_AUTO_DISCOVERY=true` 后，构建会自动切回
electron-builder 的 Developer ID 正式签名流程。临时签名不等于公证，不能替代
面向用户发布所需的 Developer ID 与 Apple notarization。
位于 `Contents/MacOS` 的 MCP launcher 与 bootstrap 会作为显式附加程序签名，
避免普通脚本破坏应用外层的签名封口。

当前仓库会长期保留的静态文件：

- `entitlements.mac.plist`
- `image_scan_entitlements.plist`
- `login-capture/supervisor.py`、`wechat_lldb_capture.py`、`wechat_key_verify.py`：受监督的登录期捕获与验证源码。

需要在 mac 机器上通过 `native-dlls/build-macos.sh` 生成的文件：

- `libwx_key.dylib`
- `xkey_helper`
- `image_scan_helper`
- `libWCDB.dylib`
- `libwcdb_api.dylib`
- `libwcdb_decrypt.dylib`

检查是否齐全：

```bash
npm run native:macos:check
```

只构建 mac 原生产物，不构建 Electron 应用：

```bash
npm run native:macos
```

## 数据库密钥获取：平台差异与超时排查

本次参考了 [kqint/CipherTalk 的固定提交 `8167c4b5dbc7e6fbfadb6598790a6725a53a5007`](https://github.com/kqint/CipherTalk/tree/8167c4b5dbc7e6fbfadb6598790a6725a53a5007)（2026-03-03）。该版本的 [wxKeyService](https://github.com/kqint/CipherTalk/blob/8167c4b5dbc7e6fbfadb6598790a6725a53a5007/electron/services/wxKeyService.ts) 使用 Windows `wx_key.dll`，对 `Weixin.exe` 调用 `InitializeHook` 并轮询密钥；[调用流程](https://github.com/kqint/CipherTalk/blob/8167c4b5dbc7e6fbfadb6598790a6725a53a5007/electron/main.ts#L1427) 先强制结束微信再启动。它没有公开 macOS 取钥实现，不能把该 DLL 或强杀、重启、注入流程直接移植到 Mac，也不是扫码获取聊天数据库的接口。

本轮已将 **登录期捕获** 接入 Apple Silicon Mac 的“自动获取并验证”，不再把已登录进程的文本内存扫描作为默认取钥步骤。它需要 arm64 微信进程、可用的 LLDB 与 Python 3.9+，先通过系统与运行时预检；SIP 或系统权限阻止附加时停止获取，不修改系统保护或微信签名。

用户顺序为：**先退出微信账号并停留登录页 → 在程序开始获取 → 完成管理员授权 → 等“监听已就绪” → 微信登录并在手机确认 → 安全移除监听、逐库验证后保存**。不要先附加已登录进程再退出账号，退出账号可能更换主进程。管理员授权与就绪后的登录等待分别计时；授权最多 90 秒，就绪后的监听最多 5 分钟，结束时还需等待清理。

`login-capture/supervisor.py` 监督自己的 LLDB 子进程组；`wechat_lldb_capture.py` 只使用硬件断点捕获符合目标数据库 salt 与 KDF 参数的 32 字节 passphrase。捕获后先确认分离，再验证所选账号各库第一页 HMAC。单库派生 raw key 不能代替账号口令，匹配到候选或只打开 `session.db` 不足以保存账号配置。取消会使本次请求标记失效并等待清理；迟到候选、未确认分离、校验失败或临时文件清理失败均不接受新密钥，保留原有连接配置。无法确认安全结束时须按页面提示手动退出并重新打开微信。

以下内存扫描性能、换行传输和 80 个候选的记录属于早期路线：批量匹配、4 MiB 分块、大区域及跨块处理、独立授权/扫描预算的代码与回归仍保留，不应当作当前登录捕获的用户操作步骤。

本轮另确认了管理员脚本的换行传输问题：AppleScript `do shell script` 默认把输出的 LF 改成裸 CR，并去掉一个结尾换行；此前按 LF 分行的解析器因此可能漏掉已经扫描出来的候选。现已在调用中使用 `without altering line endings`，并让解析器同时兼容 CR、LF、CRLF。该行为有 [Apple TN2065](https://developer.apple.com/library/archive/technotes/tn2065/_index.html) 的明确说明，且已用本机真实 AppleScript 调用和合成 `printf` 输出复现问题、验证修复；这项验证不涉及真实密钥。

开发回归命令：

```bash
node scripts/test-wechat-memory-scan.cjs
node scripts/test-wechat-key-flow.cjs
python3 -B scripts/test-wechat-login-helper.py
node scripts/test-wcdb-key-materials.cjs
```

上述回归使用合成内存、临时合成数据库和模拟进程/授权状态，不读取真实微信进程。登录 helper/supervisor 的隔离回归覆盖正常捕获、取消、错误 PID、迟到授权/候选、分离失败及自有子进程超时清理。早先本机内存扫描产生的 80 个候选全部未通过验证；后续独立硬件断点脚本已在本机重新捕获并验证成功，详情如下。**本轮按钮已集成，完整界面重新捕获尚待用户在登录页配合**，当前没有监听任务运行；脚本成绩不能视为本轮 UI 已通过，也不代表所有微信版本均受支持。

本轮还用既有保存密钥只读检查了新接入的 TypeScript 首页校验器：20/20 个数据库、其中核心库 5/5 通过。这验证的是应用内校验算法，不是新一轮捕获。桌面界面的登录引导与运行环境预检已检查通过；TS 捕获服务 15 组合约、Python helper 9 项与验证器 15 项合成回归通过，Vite 构建通过。安装包尚未重新生成。

### 来源与此前脚本实验：捕获派生输入并逐库验证

另参考 [TANGandXUE/wcdb-key-tool 固定提交 `79f1b5b92e12c66aa281b4a60a3c478b5f547dfa`](https://github.com/TANGandXUE/wcdb-key-tool/tree/79f1b5b92e12c66aa281b4a60a3c478b5f547dfa) 研究 macOS 路线：在 `CCKeyDerivationPBKDF` 调用处捕获 32 字节 passphrase，按每个数据库各自的 salt 派生密钥，并验证第一页 HMAC。此 passphrase 与某一个数据库派生出的 raw key 是不同层次的输入，不能混用。

本地只读校验脚本 `scripts/wechat_key_verify.py` 已通过 15/15 合成测试。最初用既有保存密钥进行第一页 HMAC 检查时，20/20 个数据库、其中核心库 5/5 通过；这一步仅验证算法与旧密钥匹配。下面另列新捕获结果的独立验证，不能将两者混为同一项证据。第三方许可见 `THIRD_PARTY_NOTICES/WcdbKeyTool/`。

隔离硬件断点脚本先在本机真实微信上捕获成功，本轮再以受监督的服务接入“自动获取并验证”按钮。以下保留的是此前脚本实验的证据，集成 UI 的独立实测尚未完成。应用不会自动重签名微信、关闭 SIP、强制重启微信或执行全局 `pkill`；不能把本机脚本成功推广为所有环境可用。

`scripts/test-wechat-lldb-capture.py` 只附加本次生成的临时程序。CommonCrypto SHA-512 常量已修正为 `5`，并增加异步事件处理、退出清理和目标继续运行的心跳检查。修正后以 `sudo` 运行的真实 LLDB 合成测试 3/3 通过，覆盖 capture、timeout、cancel 三种路径，并检查硬件断点、detach 及目标进程恢复运行的 heartbeat。这证明临时程序上的捕获与清理流程可用，不代表已获取真实微信密钥。LLDB 原生附加、分离调用本身仍可能阻塞；当前集成有监督和清理时限，但不能保证原生调用总能按严格时限安全退出。无法确认分离时会明确失败，不把强制结束 debugger 视为捕获成功。

真实微信首轮已经成功附加并安装硬件断点，无需改变微信签名。但用户退出账号、重新登录期间，微信主进程从 PID `20829` 更换为 `29167`，已附加的旧进程退出。该轮结果为 `stage=target_exited`、`hits=0`、`captured=false`、`detached=true`，没有获得新密钥。

真实第二轮按调整后的顺序成功：用户先退出账号并停留登录界面，脚本附加新 PID `29338`，确认硬件断点 ready 后，用户点击登录并在手机确认。18.482 秒后返回 `hits=1`、`captured=true`、`detached=true`。

本次新捕获候选另外完成了两层验证：

- 逐库第一页 HMAC：20/20 个数据库、其中核心库 5/5 全部通过。
- 新建独立 `WcdbCore` 实例进行 SQLCipher 只读探测：`session.db` 成功，5/5 个核心库均实际读取 schema 成功。此次没有借用活动旧连接的成功状态，也没有留存数据库 handle。

新捕获值与原 `decryptKey` 在内存中比较相同，因此保留既有配置，无需重新填写。本轮私密临时目录已删除（包括候选密钥及调试日志），仅保留不含密钥的验证统计；微信仍正常运行。这里确认的是本机重新捕获和实际数据库验证成功，不是全量消息导出或所有版本兼容性证明。此次无需改变微信签名、关闭 SIP 或重启应用；**本机 SIP 原先已处于 disabled 状态，不能据此宣称 SIP 开启时也能使用该方案**。

以后需要重新捕获时，可使用程序内的自动获取入口，仍须先停留登录界面，完成授权并确认监听就绪后才点击微信登录。不要在已经附加到已登录进程之后才退出账号，否则主进程更换会使该次监听失效。日常使用可直接沿用已验证连接，无需重复取钥。
