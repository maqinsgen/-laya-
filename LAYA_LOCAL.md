# Laya 本机部署与验证

知灯可以把消息分析交给本机 Laya。中文必须使用 `multilingual`；模型名 `laya` 在官方路由中指向英语模型。当前应用对本机分类结果保留原文并要求人工确认，不据此自动丢弃消息或设置日期提醒。

## 当前实际验证状态

已在本机 Apple M1 / 16 GB、macOS 15.6 上完成隔离安装与 CPU、MPS 真实模型测试。系统 `python3` 是 3.9.6，部署使用 `.cache/laya/venv` 内的 Python 3.12.14，依赖为 Laya 0.3.9、PyTorch 2.14.0、Transformers 4.57.6；没有全局安装。此前网络授权和下载失败已解决：37 个依赖 wheel 均与官方 PyPI SHA-256 核对后安装，固定 HF revision 的 5 个文件也全部按官方 SHA-256 或 Git blob 摘要核验后才加载。安装版本、来源核验与模型核验记录位于 `.cache/laya`。

每个设备在独立进程使用 4 个 CPU 线程、单条请求、同一组 **12 条独立合成中文消息**，共 3 轮。第 2、3 轮合计 24 次请求计作 warm；重复运行不增加独立样本数。原始报告为 `.cache/laya/benchmark-cpu.json` 与 `.cache/laya/benchmark-mps.json`。

| 指标 | CPU | MPS |
| --- | ---: | ---: |
| 新进程加载 | 5.79 秒 | 6.81 秒 |
| 首次请求 | 175.7 毫秒 | 2421.3 毫秒 |
| Warm p50 / p95 | 92.7 / 131.9 毫秒 | 47.8 / 56.2 毫秒 |
| Warm 吞吐量 | 9.74 条/秒 | 20.61 条/秒 |
| 进程峰值 RSS | 2.17 GiB | 1.60 GiB |
| MPS 分配 / driver 分配快照 | 不适用 | 1.21 / 1.25 GiB |
| 首轮预设标签匹配 | 6/12 | 6/12 |

本机 MPS 热运行吞吐量约为 CPU 的 2.11 倍，但首次请求更慢；服务持续驻留后才适用 warm 指标。MPS 分配快照与进程 RSS 口径不同，不能简单相加当作统一内存总量，也未测持续峰值、功耗或后台长期运行。

两个设备三轮分类及返回的四位小数置信度一致，首轮均只有 **6/12** 符合预先设定的人工标签。模型把普通促销判为重要信息（confidence 0.0544），把执行人未定的请求判为行动（0.4155），并将部分变更、取消、他人承诺与日期信息判为待确认；六个错判中没有 confidence ≥ 0.8 的项。这是小型合成诊断，不能作为真实消息准确率或置信度校准，也不能据此设定可靠的自动筛除阈值。界面已标为实验，保留默认禁用及人工确认；启用后仍保留原文，不自动删除或依据分类创建提醒。

随后使用真实 TypeScript 的 `buildLayaDecisionRequest`、`requestTodoJev` 与 `interpretLayaDecisions`，通过 MPS 回环 HTTP 服务验证应用调用链。蓝色连接题通过；12 条合成消息重复 3 轮，加连接题共 37 次 HTTP 请求。分类请求 p50 / p95 为 54.23 / 67.76 毫秒，含请求构造与结果解释的串行吞吐量为 17.18 条/秒。全部卡片保留原文证据、要求人工核对、不自动设置提醒；超长消息保留本地的检查也通过。原始报告为 `.cache/laya/app-benchmark.json`。

应用链路的预设标签匹配为 **5/12（41.7%）**，不能混用上述 6/12：SDK 基准的个人说明是“项目交付与研究”，应用基准是“我关注项目交付与研究”。相同消息在这个上下文差异下出现不同判断，“相关信息”由 important 变为 uncertain，“他人承诺”也由 uncertain 变为 action。应用测试中七个错判没有 confidence ≥ 0.8 的项，仍不足以支持自动筛除。HTTP 的分位数对全部 36 次分类请求使用 nearest-rank；上表对后两轮使用线性插值，统计口径也不同。这些测试没有读取真实微信、邮箱、用户画像或密钥，没有调用云端模型。

此外，已通过 CUA 在原生 Electron 界面实际点击“用虚构样本测试”，界面显示“固定虚构样本测试通过”，启用复选框仍为未选中（0）。这是一次 renderer → IPC → 本地 HTTP 的真实连通验证，没有保存设置或读取用户消息，也不证明分类准确率。上述 36 次分类基准仍只是 TypeScript 应用调用链测量，不代表整个微信扫描流程的性能。

## 1. 安装隔离环境

建议 Python 3.12，使用官方 PyPI wheel。依赖、公开权重与评测报告均放在项目 `.cache/laya`，不会全局安装 Python 包。首次安装需要联网及数 GB 可用空间；运行时内存与延迟取决于设备，不能把官方 T4 GPU 基准当作 Mac 实测。

macOS/Linux 已安装 Python 3.12 时，在项目根目录运行：

```sh
python3.12 scripts/setup-laya-local.py
```

本次已创建的隔离环境包含 Python 3.12，可在这台机器直接继续安装：

```sh
.cache/laya/venv/bin/python scripts/setup-laya-local.py
```

其他机器仍需先安装 Python 3.12。Windows 安装后使用：

```powershell
py -3.12 scripts/setup-laya-local.py
```

脚本固定安装 `laya[serve]==0.3.9`，限制 Transformers 为 `>=4.48,<5`，其余依赖由 PyPI 解析，并把实际版本记录到 `.cache/laya/requirements.installed.txt`。此次原固定版本 0.3.7 已无法从实时官方 PyPI 版本接口获取（HTTP 404），因此只读审计 0.3.9 的加载、choice 编码与 HTTP 接口后更新；不能仅凭 404 推断下架原因。0.3.9 官方 wheel 的 SHA-256 为 `8080d99792867096c970b1b24464e888f3c37d902f2c947be1f8baa3677c9717`。PyTorch 的可用 wheel 受操作系统、CPU 架构与 Python 版本约束；不承诺所有组合均支持。只安装依赖可加 `--skip-download`，以后再执行下述下载命令。

权重固定到 revision `5e7b2b1b8ca2ecdd3f2322d94069c9b6ce7e844b` 的 `multilingual` 子目录，仅允许下载 safetensors、配置和 tokenizer JSON。下载不使用个人 HF token，不读取消息，不启用 `trust_remote_code`，不加载远程 Python 或 pickle 权重。

```sh
.cache/laya/venv/bin/python scripts/serve-laya-local.py --download-only
```

Windows 将上述 Python 路径换成 `.cache\laya\venv\Scripts\python.exe`。

## 2. 启动与连接

```sh
.cache/laya/venv/bin/python scripts/serve-laya-local.py
```

Windows：

```powershell
.cache\laya\venv\Scripts\python.exe scripts/serve-laya-local.py
```

本项目启动器固定绑定 `127.0.0.1:8000`，仅加载本地缓存的多语言模型，启动与推理设置为离线。默认 CPU、最多 4 个推理线程，避免占满电脑。需要时可用 `--threads 2`、`--port 8001`。上述 M1 实测 MPS 有热运行加速，可在这台机器使用：

```sh
.cache/laya/venv/bin/python scripts/serve-laya-local.py --device mps
```

其他系统仍需单独验证；MPS 不可用时明确改用 `--device cpu`。启动器检查实际设备，若 SDK 在推理期间因内存等原因改用 CPU，会报错停止返回该次结果，避免把 CPU 当作 MPS。受限执行环境可能无法识别 GPU，本机 MPS 实测是在正常系统权限下运行。

在知灯的本机分析配置中填写：

- 接口：`http://127.0.0.1:8000/v1/systemone`
- 模型：`multilingual`
- API Key：回环服务默认留空

保持终端运行，先点连接测试。测试只发送“这张卡片是蓝色的。”这一专用合成样本。连接通过只证明服务与简单题目可用，不证明其个人消息分类准确。使用 `Ctrl+C` 停止服务。

不要直接使用默认的 `laya-serve` 命令：上游默认监听 `0.0.0.0`，会向其他设备暴露无认证接口。本项目不开放 `--host` 参数、不做公网隧道。上游支持环境变量 `LAYA_API_KEY`，如自行设置服务鉴权，需在应用填写同一密钥；本机服务仍应限制在回环地址。端口占用时更换端口并同步修改应用。

## 3. 运行中文合成评测

无需模型、无需依赖的脚本自检：

```sh
python3 scripts/smoke-laya-local.py --self-test
```

依赖和权重就绪后，停止 HTTP 服务以避免重复加载，再运行离线真实推理：

```sh
.cache/laya/venv/bin/python scripts/smoke-laya-local.py
```

评测直接调用与服务相同的本地模型和预算检查，不连接外部 API，不读取微信、邮箱、用户画像或数据库。它包含蓝色连接样本及 12 条人工中文样本，覆盖请求、相关信息、广告、指代、否定、他人承诺、文本中的指令和非任务日期。分类题与应用采用相同的四选项短中文格式。

结果写入 `.cache/laya/synthetic-smoke.json`，记录固定模型版本、实际设备、逐题答案、分布、置信度、输入 token、延迟，以及错判中高置信度的数量。这里的准确率仅是小型合成冒烟检查，不能证明真实消息质量或校准效果；出现高置信错判时尤其不能降低人工确认要求。

CPU/MPS 性能对照每次使用独立进程，先停止服务，再顺序运行，避免同时驻留多份模型：

```sh
.cache/laya/venv/bin/python scripts/benchmark-laya-local.py --device cpu --rounds 3 --output .cache/laya/benchmark-cpu.json
.cache/laya/venv/bin/python scripts/benchmark-laya-local.py --device mps --rounds 3 --output .cache/laya/benchmark-mps.json
```

脚本每轮使用同一组 12 条合成中文消息，在运行前核对应用当前问题、四个选项及输入预算，并包含空的“偏好”行。记录新进程加载时间、首次请求、首轮和后续轮的 p50/p95、每秒处理条数、进程峰值 RSS 及 MPS 分配内存快照。第 2、3 轮计作 warm；MPS 每次测量前后同步。加载时间不清空操作系统文件缓存，RSS 包含整个 Python 进程，MPS 快照不代表显存峰值；这些结果也不包含 Electron、HTTP 和微信读取开销。Windows 不提供标准库 `resource` 时，RSS 字段留空。

无依赖检查统计逻辑可运行 `python3 scripts/benchmark-laya-local.py --self-test`。真实结果保留全部逐题答案，不调整预设标签迁就模型；生产准确率仍需用户授权的独立样本评测。

服务已启动时，可复现真实应用模块到回环服务的合成测试；不应同时再运行上述离线基准，以免加载两份模型：

```sh
node scripts/benchmark-laya-app.cjs
```

自定义服务端口时在命令末追加端口，如 `node scripts/benchmark-laya-app.cjs 8001`。此脚本只允许请求指定的 `127.0.0.1` 地址。HTTP 延迟包含请求、响应及协议验证，不包括请求构造和结果解释；吞吐量包含这两项。它验证实际应用调用模块，但不代替完整界面、真实消息采集或长期运行验证。

## 协议、预算与效果边界

上游 `POST /v1/systemone` 接受 `{model, state, questions}`，choice 返回 `{type, choice, probabilities, confidence}`；响应还有 `model: "laya-rl-agent"` 与 `usage`。本机模式选择 `multilingual`，不会回退加载英语模型。输出为有限选项，不生成自由文本，但仍可能误判。

该模型默认每题 1,024 tokens，其中题目及选项预算 256；每个选项描述最多保留 48 tokens。官方 SDK 会静默截断过长题目、选项和消息。本项目启动器在真实 tokenizer 上检查预算，过长时直接返回错误。应用也限制单条消息与提示长度；不要把原来的长 Jev 批处理提示直接搬来。

Laya 的 `input_tokens` 是各题完整编码序列 token 的总和，同一 state 在多题中重复编码，不能按 Jev 的共享 state 计费方式解释。`output_tokens` 为 0 表示没有自回归生成；本机仍消耗内存、计算时间和电量。

官方模型卡承认基础模型在新 typed-decisions 工作流上的零样本效果弱于多数类基准，原始概率也可能过度自信。choice 的 confidence 基于分布熵，不等于经本项目验证的正确率；`action.act_probability` 官方称目前没有可靠决策信号。日期仍应由原文候选与本地校验约束，不能凭分类分数自动创造提醒。

第三方代码及公开权重的 Apache-2.0 声明见 [Laya 许可说明](THIRD_PARTY_NOTICES/Laya/README.md)，它不改变本项目原有许可。

官方依据：[模型卡](https://huggingface.co/convaiinnovations/laya)、[Python 包 0.3.9](https://pypi.org/project/laya/0.3.9/)、[0.3.9 官方文件摘要与元数据](https://pypi.org/pypi/laya/0.3.9/json)。初次协议审计的 [服务源码](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/serve.py) 与 [编码预算、置信度实现](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/common.py) 属于旧版参考；本轮另对上述摘要固定的 0.3.9 wheel 源码进行了接口兼容性对照。
