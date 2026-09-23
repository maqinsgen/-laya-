# Laya 第三方说明

本项目的可选本机分析服务使用 Convai Innovations 的 [Laya](https://github.com/NandhaKishorM/laya)。应用通过其 Jev 兼容协议调用服务；本项目不包含模型权重。

- Python 包固定为 [laya 0.3.9](https://pypi.org/project/laya/0.3.9/)，官方 wheel SHA-256：`8080d99792867096c970b1b24464e888f3c37d902f2c947be1f8baa3677c9717`。
- 初次源码审计参考提交：`010bacef009c855ccba814b51f7c8e1d38ab5e3f`；当前 0.3.9 的加载、choice 编码及 HTTP 接口按官方 wheel 重新核对。
- 公开权重：[convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya/tree/5e7b2b1b8ca2ecdd3f2322d94069c9b6ce7e844b/multilingual)，固定 revision `5e7b2b1b8ca2ecdd3f2322d94069c9b6ce7e844b`，仅下载 `multilingual` 子目录。
- 随附 [LICENSE](./LICENSE) 原样取自该官方 wheel。代码包与官方模型卡声明 Apache-2.0；已核对的包及仓库未提供单独的 NOTICE 文件，因此没有编造上游 NOTICE。

若再分发 Laya 代码或模型，应保留相应版权、许可、适用的 NOTICE，并标明所作修改；还应保留 PyTorch、Transformers、分词器及其他实际打包依赖各自要求的声明。这里的 Apache-2.0 仅适用于相应第三方内容，不改变 CipherTalk 上游代码及本项目的现有许可，也不表示原作者为本项目背书。
