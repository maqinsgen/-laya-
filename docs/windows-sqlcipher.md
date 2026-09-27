# Windows 独立 SQLCipher 读取

Windows 的数据库读取组件是固定版本 `better-sqlite3-multiple-ciphers@13.0.3`。它复用现有 SQL 查询入口，以只读方式打开微信原始数据库和已提交的 WAL，不创建明文数据库、不重新加密、不迁移数据，也不调用 `wcdb_api.dll` 或原版授权服务。

## Windows 自动获取的操作流程

当前自动获取面向 **Windows x64 + 微信 4.x（Weixin.exe）**，按下面的顺序操作：

1. 打开电脑版微信并登录，先打开近期使用的聊天，让相关数据库密钥进入进程内存。
2. 在知灯微信连接向导中选择微信数据目录，并确认所选账号与当前登录账号一致；有多个账号时不要只凭目录最近修改时间判断。
3. 点击“获取密钥”，等待只读扫描及验证进度。扫描只读取微信进程，不会终止或自动重启微信。
4. 所选账号的核心数据库必须全部通过逐库 HMAC 校验；扫描结束还会重新读取数据库头，并由独立 SQLCipher 组件执行真实数据库读取测试。这两项验证均成功后，才保存本次逐库密钥并返回已验证账号，继续完成连接。
5. 若提示缺少数据库密钥，打开近期聊天后重试；仍未成功时，可自行退出微信账号、重新登录再获取。若系统拒绝读取进程，按界面提示检查本应用与微信的运行权限。

取消、超时或验证失败时，本次候选密钥不保存，原有连接配置保留。扫描进程结束后才能重新开始；不要把“找到候选”或“单个数据库通过”当作连接成功。

已验证的“数据库盐 → 原始密钥”映射使用 Electron `safeStorage`，由当前系统用户的安全存储加密后写入应用数据目录的 `wechat-database-keyrings.v1.json`。系统安全存储不可用时不会保存；换电脑或换 Windows 用户后应重新获取。这个新增 keyring 与为兼容旧流程而保留的单密钥配置字段不同，本次变更没有把所有配置中的密钥统一迁移为系统加密存储。

取钥设计参考了 [ou-o/wechat-extract](https://github.com/ou-o/wechat-extract) 的思路；本实现没有引入该仓库的代码，也不要求用户安装它。

## 安装与打包

正常执行 `npm ci --legacy-peer-deps` 即可安装。这个依赖使用 Node-API，npm 包内包含 `prebuilds/win32-x64.node`；[上游 13.0.3 发布说明](https://github.com/m4heshd/better-sqlite3-multiple-ciphers/releases/tag/v13.0.3)列明支持 Windows x64、Node.js 22+ 和 Electron 35+，包含本项目 Electron 39。无需自行寻找或构建 SQLCipher DLL。

已经安装的旧 Windows 应用不会因修改源码或更新工作目录而获得这条读取路径。开发者需要安装本次依赖后重新执行 `npm run build:win`，用户需要安装由这版源码构建的新完整安装包。

`package.json` 与 `scripts/electron-builder.config.cjs` 保留当前平台的预编译文件；整个组件通过 `asarUnpack` 解包。不要删除模块的 `lib`、`package.json`、`LICENSE` 和匹配平台的 `.node` 文件。`WindowsSqlcipherReader.checkRuntime()` 会真正加载原生绑定，但不打开数据库。

## 密钥与数据库行为

`electron/services/windowsSqlcipher.ts` 提供同步 `open(filePath, material)`、`query(handle, sql, params?)`、`close(handle)`。密钥类型明确区分：

- `raw` 包含 32 字节密钥的 64 位十六进制和 16 字节盐的 32 位十六进制。打开前核对文件头盐，再使用 `raw:keyHexsaltHex` 交给加密引擎，跳过口令派生。
- `passphrase` 接受 `Buffer` 或字符串，用于历史配置的兼容；32 字节二进制口令、64 位 ASCII 口令与原始密钥是不同材料，调用方决定尝试顺序。

引擎按 SQLCipher 4 配置，使用 4096 字节页、HMAC 检查；真实读取 `sqlite_master` 成功后才返回已验证句柄。空文件、明文 SQLite 文件、错误盐和错误密钥均失败，错误信息不包含密钥、SQL 或原数据库路径。原始密钥格式来自[上游配置文档](https://utelle.github.io/SQLite3MultipleCiphers/docs/configuration/config_sql_pragmas/)，格式参数来自[SQLCipher 兼容说明](https://utelle.github.io/SQLite3MultipleCiphers/docs/ciphers/cipher_sqlcipher/)。

打开只使用 `readonly: true`，不尝试读写模式，也不设置 `immutable=1`，因此同一读连接可看到后续已提交的 WAL。SQLite 仍使用正常的 WAL/SHM 锁与共享内存规则，文件系统必须允许读取相关文件；组件不会通过切换成可写数据库来绕过访问失败。查询支持读取语句、参数绑定及必要的表结构 PRAGMA，拒绝写入、附加数据库和修改加密参数。BLOB 转为十六进制，保持现有 WCDB 查询返回格式。

## 验证

```bash
npm run test:windows-sqlcipher
```

测试只在新临时目录生成合成数据，覆盖真正加密的数据库、错误密钥和盐、二进制/ASCII 口令、只读限制、BLOB、SQL 参数、已提交 WAL 及同一读连接看到新增提交；对比读取前后源 DB/WAL 的哈希。macOS 还通过另一套 `libWCDB.dylib` 的 SQLCipher C API 创建合成 DB/WAL，再由独立组件读取，验证跨实现兼容。该步骤不加载 `libwcdb_api.dylib`。

可以把测试依赖隔离安装在临时目录，以避免改动共享 `node_modules`：

```bash
npm install --prefix /tmp/notewake-sqlcipher-runtime --save-exact --ignore-scripts better-sqlite3-multiple-ciphers@13.0.3
NOTEWAKE_SQLCIPHER_TEST_ROOT=/tmp/notewake-sqlcipher-runtime node scripts/test-windows-sqlcipher.cjs
```

开发时已在 macOS arm64 / Node.js 22 实际通过原生合成与跨实现检查。Windows x64 二进制的存在和上游支持范围已确认；这些 macOS 测试不等同于 Windows 实机取钥成功；Windows 上的应用打包、安装和真实微信连接仍须在 Windows 环境验收。许可与依赖署名见 [第三方说明](../THIRD_PARTY_NOTICES/WindowsSqlcipher/README.md)。
