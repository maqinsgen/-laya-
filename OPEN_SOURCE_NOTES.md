# 知灯 Notewake：命名与公开发布说明

**让重要消息被看见。** 知灯 Notewake 是基于 CipherTalk 改进的个人信息助手：结合用户填写的关注方向和明确反馈，整理消息的重要性、行动事项与有用信息，并通过手机伴侣查看和反馈。它是独立派生项目，不代表微信、腾讯或原作者的官方产品，也不表示获得其背书。

截至 2026-09-22 的初步检索，npm 官方注册表未返回 `notewake` 包；GitHub 仓库名称检索未发现完全同名项目，但存在 [NoteWakeup](https://github.com/meshramaravind/NoteWakeup) 等近似名称。中文“知灯”的普通软件检索也未找到明显同类产品。这些结果只用于选择工作名称，不能证明名称、域名或商标可用；公开发布前仍需按实际发布地区和渠道核查。

本项目保留上游 **CipherTalk** 及作者 **ILoveBingLu** 的署名、版权和许可说明。根目录 [LICENSE](LICENSE) 与插件 SDK 使用 **CC BY-NC-SA 4.0**；[CipherTalk-CLI/LICENSE](CipherTalk-CLI/LICENSE) 单独采用 MIT，不能将 CLI 的许可外推到整个桌面项目。公开派生版本时应保留原有声明、标明修改并遵守适用的非商业和相同方式共享条款，参见 [Creative Commons 官方许可说明](https://creativecommons.org/licenses/by-nc-sa/4.0/)及其链接的完整法律文本。

当前整体更适合描述为“公开源码的非商业派生版”。[OSI 的开源定义](https://opensource.org/osd)要求不限制商业等使用领域；[OSI 说明](https://opensource.org/licenses/common-reasons-for-rejection-of-licenses)也明确指出非商业条款不符合其定义。若后续目标是采用 MIT、Apache-2.0 等许可，或开展商业使用，需要先确认相关权利并取得适用的额外授权，或独立重新实现受限制的代码及替换相应素材。仅更换名称或 LICENSE 文件不会改变既有授权条件；具体授权范围仍以权利人与适用许可为准。

本轮改名采用新的界面显示名称与 Logo，品牌配置集中在 [src/shared/brand.ts](src/shared/brand.ts)。为继续读取已有配置与同步数据，暂时保留原有 npm 包名、桌面与手机包标识、用户数据目录、CLI/MCP 命令、手机安全存储键以及同步格式。因此安装包、部分系统名称或磁盘路径仍可能显示 CipherTalk；这属于当前的兼容安排。

Logo 使用“消息气泡中的灯火与星光”，源文件为 [public/notewake-mark.svg](public/notewake-mark.svg)。修改 SVG 后运行 `npm run icons` 可同步生成桌面、浏览器和手机图标；`npm run icon:mac` 仅生成桌面资源。macOS 托盘使用不含色块背景的单色透明模板。系统 Dock、托盘需要重新启动应用才能更新，已安装的旧版本需要重新打包安装。

上游自动更新已在更新服务和下载入口停用，避免派生版被上游安装包覆盖。当前通过维护者提供的版本手动更新。原有发布配置、脚本及部分上游更新地址仍保留在源码中，**不能仅将 `upstreamUpdatesEnabled` 改为 `true` 后就发布**。正式建立独立发行渠道时，维护者需要：

- 配置自己的仓库、发布工作流和更新源，核对更新元数据与下载目标。
- 配置适用平台的签名和发行凭据；macOS 临时签名不能等同于正式签名及公证。
- 在更改 `productName`、`appId`、手机 bundle/application ID 或数据目录前，设计并验证旧数据、凭据与同步配置的迁移及回退方案。

这些是独立发行渠道的准备事项，不影响当前从源码启动和既有个人使用流程。源码发布目标为 [maqinsgen/-laya-](https://github.com/maqinsgen/-laya-)；源码推送不等于发布安装包、配置更新服务或申请名称权利。发布流程见 [PUBLISHING.md](docs/PUBLISHING.md)。

Jev 接入参考 [Jev Chat Assistant](https://github.com/jev-chat/jev-chat-jarvis) 的判断 API 调用结构，其 MIT 许可与 NOTICE 保留于 [THIRD_PARTY_NOTICES/Jev](THIRD_PARTY_NOTICES/Jev/README.md)。本项目的消息题库、日期校验和反馈策略为本轮实现；该第三方许可不改变桌面项目上游许可，也不代表获得 Jev 的背书。
