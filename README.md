# MindMap X

[English](README.en.md) | 简体中文

> 你掌舵，它观星——你们看的是同一张海图。

这是 **MindMap X**：自托管的思维导图——你在浏览器里编辑，Agent 通过同一套接口编辑同一张图，双方改动实时互见。

Powered by [NexusX](https://github.com/KLR-Pattern/nexusx)

<img width="1579" height="969" alt="image" src="https://github.com/user-attachments/assets/80cfba49-2fe6-4401-b113-c929bd94e5d8" />

----

聚焦下钻（面包屑切换）

<img width="1029" height="437" alt="image" src="https://github.com/user-attachments/assets/9aef41fe-4883-4e0b-963d-16a5f0a8720d" />


## 为什么

"AI 一键生成思维导图"的工具已经很多，但生成之后 AI 就退场了。这个项目回答另一个问题：**如果思维导图是人和 Agent 的共享工作区呢？**

- **双向同步**：你改的内容，Agent 下一轮就看得见；Agent 改的内容，画布上实时高亮——两边看的始终是同一张图，不会越用越不一致
- **不绑定某个 Agent**：这个服务本身就是一个 MCP server，Claude Code、Cursor 一条命令就能接入，页内聊天用的也是同一套接口

## 快速开始

### Docker（推荐）

```bash
cp .env.example .env   # 可选：配置页内 Agent 的模型；不配则画布功能完整
docker compose up -d   # → http://localhost:8740
```

- 数据（SQLite / 聊天归档 / Agent 会话）都在 named volume `mindmap-var`：`down` 不丢，`down -v` 才清空；
- 镜像内置前端构建与数据库迁移：升级镜像后重启即自动演进 schema；
- 国内网络拉取基础镜像超时的话，经镜像站构建：

```bash
NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine \
BASE_IMAGE=ghcr.m.daocloud.io/astral-sh/uv:python3.12-bookworm-slim \
docker compose build
```

### 从源码运行

环境要求：Python ≥ 3.12，Node ^20.19 || ≥22.12（构建前端）。

```bash
./scripts/start.sh          # 依赖 → 数据库迁移 → 前端构建（缺产物时）→ 启动
./scripts/start.sh --seed   # 首次可选：灌入示例脑图
```

`PORT=9000 ./scripts/start.sh` 换端口；Ctrl+C 停止时自动清理端口。前端开发模式（热更新）：

```bash
cd fe && npm run dev   # 5173 端口，代理 /api /ws /mcp /voyager 到 8740
```

## Agent 接入

```bash
# MCP（Claude Code；Cursor 等 MCP 客户端同理）
claude mcp add --transport http mindmap http://localhost:8740/mcp

# CLI
uv run python -m src.cli mindmap-service get_tree --map-id 1
uv run python -m src.cli mindmap-service apply_outline --map-id 1 \
  --outline "- [id:1] 根
    - [id:2] 分支
      - 新节点" --mode merge

# REST
curl -X POST localhost:8740/api/mindmap_service/get_tree \
  -H 'Content-Type: application/json' -d '{"map_id": 1}'
```

### 变更感知：内部与外部的差异

**页内 Agent 享有自动变更感知**：其他所有写入方（你在画布上的手动修改、外部 Agent 经 MCP/CLI/REST 的写入）的变更都会在它下一轮回复前以 `<external_changes>` 自动注入其上下文，并按来源分组措辞（"用户在画布上手动修改了" / "外部 Agent 修改了"），多方认知不漂移。

页内 Agent 自己的写入不会进入注入清单（toolResult 已自知，注入回去只是回声噪音）。识别机制：它自调 MCP 时携带 `X-Mindmap-Source: page-agent` 请求头，服务端 `context_extractor` 提取后经 nexusx `FromContext` 注入，映射为专属 `actor='page_agent'`，事件层据此豁免。

外部 Agent（MCP / CLI / REST）没有注入通道——MCP 是应答式协议，服务端无法主动把变更推入模型的上下文。因此**人机并行编辑时，外部 Agent 需要在每次写入前主动调用 `get_tree` 重新拉取全量树**，确认结构未变再操作，避免基于过期认知覆盖你的修改。

### 页内 Agent（内嵌 strands agents）

浏览器聊天面板的后端是应用内嵌的 [strands agents](https://strandsagents.com/) Agent：它经**本应用自己的 MCP**（loopback streamable-http，与外部 Claude Code 共用同一接口）操作脑图，模型走任意 OpenAI 兼容网关，换 Provider 只改 `.env` 三行（已被 gitignore 保护，启动自动加载，不覆盖已有环境变量）：

```bash
# .env 示例（DeepSeek / 通义 / Kimi / OpenAI 均同构）
OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
OPENAI_API_KEY=<智谱 API Key>
AGENT_MODEL=glm-5.3-flash
```

未配置模型网关时，Agent 对话按钮置灰保留：点击会弹窗说明需要配置的环境变量（`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `AGENT_MODEL`，见 `.env.example`），面板不会打开；会话中网关异常则面板内显示明确的错误横幅。

## 已知限制

- 单用户设计，无多人实时协同
- SQLite 单进程存储（`var/mindmap.db`）
- 无 XMind / OPML 导入导出——outline 文本协议是当前唯一的交换格式

## Roadmap

- [ ] 导入导出：XMind / OPML / FreeMind
- [x] Docker 一键部署（`docker compose up -d`）
- [ ] 多人协同（树级 OT / CRDT）

## License

[Business Source License 1.1](LICENSE)（BUSL-1.1）：源码可见——学习、修改、公司内部使用免费；将本产品作为产品或服务提供给第三方（托管、转售、集成进商业产品）需商业授权，联系 allmonday@126.com。每个版本发布满 4 年后自动转为 Apache-2.0。

> 2026-08-30 之前的版本以 MIT 发布，那些版本仍按 MIT 授权。
