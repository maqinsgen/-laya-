# 知灯 Notewake：消息很多，重要的事别沉底

![知灯 Notewake 产品示意](https://raw.githubusercontent.com/maqinsgen/-laya-/main/docs/assets/notewake-cover.svg)

一封活动通知、一条需要回复的请求、一段值得留意的资料——看过之后，它们很容易被新的消息推走。

**知灯 Notewake** 想把这些内容放回你的注意力里。它是一个以桌面为主的个人信息助手：从微信和邮件等来源整理重要信息与行动事项，结合你填写的关注方向，说明为什么值得看，并允许你随时纠正判断。

项目源码：[github.com/maqinsgen/-laya-](https://github.com/maqinsgen/-laya-)

## 从“看到消息”到“处理事情”

**有依据地选出来。** 卡片展示重要度、理由和来源证据，你可以回到原文核对。模型给出的置信度不会被包装成实测准确率。

**让反馈有用。** 点“有用”或“没用”，下一批消息分析会参考你的主题偏好。反馈可以撤销，学习可以关闭；这是可检查的内容偏好，不是人格判断，也不会在线训练模型权重。

**把时间接上。** 时间需要经过来源证据校验，模糊日期留给你确认。以虚构的读书交流会为例，明确的 9:00–10:30 能按 90 分钟加入日历，并带入设置的提前提醒；单条导入会打开系统确认窗口，也支持批量 `.ics` 导出。

**把事项带到手机。** 桌面负责采集分析，Android / iPhone 伴侣通过加密 WebDAV 同步事项与反馈，离线可查看缓存。手机端已有源码，需要自行构建、签名和验证；它不直接读取手机微信数据库。

## 可以本地运行，也把限制放在明处

知灯接入了本机 **Laya multilingual**，回环服务无需 API Key；也保留独立配置的 Jev 和云端生成模型。选择云端服务时，必要的候选消息与个人关注信息会发送给所填服务，本地分析与云端分析的隐私边界不同。

Laya 目前是**默认关闭的实验功能**。明确启用后逐条判断，所有分类结果保留待确认，不依据分类自动创建日期提醒，也不会在失败时自动切换到云端。超出模型输入预算的消息会保留为本机待核对卡。小型合成测试已有公开记录，但不能代表真实消息准确率，也不支持“零幻觉”或可靠自动筛除的承诺。

完整部署与测试口径见 [Laya 本地说明](https://github.com/maqinsgen/-laya-/blob/main/LAYA_LOCAL.md)。

## 从源码开始

```bash
git clone https://github.com/maqinsgen/-laya-.git notewake
cd notewake
npm ci --legacy-peer-deps
npm run dev
```

需要 Node.js 22.12+、对应平台环境及配套预编译原生组件；仓库不包含 WCDB 等组件的完整私有源码，不能从本仓库重建全部原生依赖。先手动补记几件事、选择消息来源和分析方式，再用明确反馈逐步调整。微信连接提供环境预检和向导；系统权限不满足时会说明阻断原因，不会自动修改 SIP 或微信签名。

[阅读使用指南](https://github.com/maqinsgen/-laya-/blob/main/使用指南-信息助手.md) · [了解架构](https://github.com/maqinsgen/-laya-/blob/main/TODO_ASSISTANT_ARCHITECTURE.md) · [参与改进](https://github.com/maqinsgen/-laya-/issues)

欢迎用虚构或脱敏样例提交反馈，帮助改进中文判断、日期歧义、反馈解释与手机体验。请不要上传聊天数据库、邮件内容、微信密钥或 API Key。

## 感谢与许可

知灯基于 **[CipherTalk](https://github.com/ILoveBingLu/CipherTalk)** 改进，保留原作者 **ILoveBingLu** 的署名与版权。本分支调整了信息助手流程、品牌、个人反馈、日期证据和手机伴侣体验；封面是虚构内容示意，不含真实用户消息。

项目采用 **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**，完整条款见[仓库 LICENSE](https://github.com/maqinsgen/-laya-/blob/main/LICENSE)。这是公开源码的**非商业派生版**，不是 MIT 或任意商用授权，改作分发须保留适当署名与许可。本项目不代表上游作者、微信或腾讯的官方产品或背书。

**让重要消息被看见，也让每一次判断都有机会被你纠正。**
