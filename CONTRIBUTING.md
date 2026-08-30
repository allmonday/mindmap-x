# 贡献指南

感谢参与 MindMap X！提 PR 前请了解两件事。

## 贡献者许可（简式 CLA）

提交 PR 即表示你同意：

1. 你的贡献以 [BUSL-1.1](LICENSE) 及其 Change License（Apache-2.0）授权给本仓库；
2. 同时授予版权持有人 tangkikodo 以任何其他许可（含商业许可）使用、再许可、再分发你的贡献的权利；
3. 你保留对自己贡献的一切权利，并保证你有权作出上述授权。

这是单人项目保持双授权（开源 + 商业）可行性的必要条件，详见 [LICENSE](LICENSE)。

## 开发

```bash
uv run --all-extras pytest tests/ -q   # 后端测试
cd fe && npm run lint                  # 前端 oxlint
```

macOS ARM 注意：跑后端测试前需 `uv pip install greenlet`（SQLAlchemy 的平台标记不含
`arm64`，uv 不会自动装；Linux / Docker 无此问题）。

各模块设计记录见 `specs/`（001 总体架构、002 节点双 ID、003 聊天面板、004 内嵌 strands Agent）。
