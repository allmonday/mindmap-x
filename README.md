# MindMap X

[English](README.en.md) | 简体中文

> **任何 Agent 都能操作的思维导图** —— 人和 AI 共编同一棵树。

人在浏览器里编辑脑图，Agent（页内对话、Claude Code、Cursor、CLI 脚本…）通过同一套 API 读写**服务端权威的树**，双方改动经 WebSocket 实时互见；Agent 改动的节点带高亮标记，人手改的部分也会在下一轮注入 Agent 的上下文。

<img width="1596" height="1024" alt="image" src="https://github.com/user-attachments/assets/b5f91c02-f49a-4825-86f1-8f0744a6833e" />

----

聚焦下钻（面包屑切换）

<img width="1158" height="724" alt="image" src="https://github.com/user-attachments/assets/35ad01a0-b429-4ead-9f44-82601a47ae45" />

----
页内 Agent 对话

<img width="1595" height="810" alt="image" src="https://github.com/user-attachments/assets/73511cfb-2526-4665-b393-66433b6b60c3" />

## 为什么

"AI 一键生成思维导图"的工具已经很多，但生成之后 AI 就退场了。这个项目回答另一个问题：**如果思维导图是人和 Agent 的共享工作区呢？**

- **双向协同**：人改画布 → 改动摘要缓冲 → 下一轮以 `<external_changes>` 注入 Agent 上下文，Agent 的认知和画布不会漂移
- **MCP-native**：脑图服务本身就是一个 MCP server，外部 Claude Code / Cursor 一条命令接入，和页内 Agent 共用完全相同的接口——bring your own agent
- **服务端权威树**：所有改动走 `version +1 → WS 广播 → 客户端重拉` 的单一数据流，无操作不空转（no-op 不递增 version），折叠等视图态不污染内容修改标记

## 功能全景

### 画布（给人用的）

- XMind 风格布局：根居中、子树左右镜像对称，可一键切换为"一律靠右"单向逻辑图
- 节点操作：双击 / F2 改名，Tab 加子级，Enter 加兄弟，Delete 删除子树
- 收放：单节点折叠按钮 + 工具栏「折叠至第 N 层」批量收放（服务端语义，`set_fold_level`）
- **聚焦下钻**：选中任意子节点点聚焦，它临时成为画布根只显示其子树；面包屑显示祖先路径，点击切换，Esc 退出
- 长文本自动换行（最多 4 行，超出省略 + hover 显示全文）
- WebSocket 实时同步，断线指数退避自动重连

### API（给 Agent 用的）

| 方法 | 说明 |
| --- | --- |
| `list_maps` / `get_map` / `get_tree` | 查询：图列表 / 结构化全量 / outline 文本 |
| `create_map` / `add_node` / `update_node` / `move_node` / `delete_node` | 单点增删改移（含环检测） |
| `delete_map` | 删除整张图（含全部节点；广播 `map_deleted`，打开中的客户端自动退回列表） |
| `expand_all` / `set_fold_level` | 批量视图态：全展开 / 按层级收放 |
| `list_revisions` / `get_revision` / `restore_revision` | 版本管理：每次内容修改落整树快照（收放等视图态不落），时间线查看、版本间 diff、一键回滚（回滚本身是新版本，历史不丢） |
| `apply_outline` | 整树批量写入（outline 协议，见下） |

交互式文档：`/docs`（REST OpenAPI）、`/voyager`（GraphQL）。

#### outline 协议

树的一等公民文本协议，`get_tree` 的输出即 `apply_outline` 的输入：

```text
- [id:1] 根
  - [id:2] 已有子节点（id 锚定，更新内容与结构）
    - 孙节点（4 空格缩进 = 第二层）
  - 全新子节点（无 id 前缀 = 新建）
```

- 每行以 `- ` 开头，`[id:N]` 中的 N 是节点编号（display_id，每图从 1 起）
- 缩进每 2 个空格深一级，不能跳级；首行必须是无缩进的根
- `merge` 模式：锚定更新 + 新建 + **未提及的节点保留不动**（不误删）
- `replace` 模式：保留根，其余全删重建

### 双向协同机制

```
人改画布 ──REST──▶ 服务端（version+1，记录 detail）
                    │
                    ├─WS 广播──▶ 所有客户端全量重拉（单一数据流）
                    └─缓冲──────▶ 下一轮用户消息尾部注入
                                   <external_changes> 给 Agent
Agent 改树 ──MCP/GraphQL──▶ 同一条服务端链路，节点带 actor 标记
```

折叠是**服务端持久化的视图状态**：不刷新节点的修改人与时间戳（Agent 修改高亮不误亮），也**不进版本历史**（不递增 version、不落快照——实测约 3/4 的快照体积曾来自收放操作），仅 WS 广播供多端同步视图；无实际变化时不广播。聚焦下钻则是纯前端会话态，不动服务端数据。

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
# 依赖 + 数据库 + 种子数据（首次）
uv sync --all-extras
uv run alembic upgrade head
uv run python scripts/load_seed.py --force   # 可选：灌入示例脑图

# 启动（浏览器打开 http://localhost:8740）
uv run uvicorn src.main:app --host 0.0.0.0 --port 8740
```

前端为 Vite 构建产物，由 FastAPI 托管（`src/static`）。改前端源码后：

```bash
cd fe && npm install && npm run build   # 重新构建到 src/static
# 或开发模式（热更新，5173 端口，代理 /api /ws /mcp /voyager 到 8740）
cd fe && npm run dev
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

三种通道背后是同一个 UseCaseService（[nexusx](https://pypi.org/project/nexusx/) 6.x：SQLModel + FastAPI，REST/CLI/MCP/GraphQL 一套签名四处生成）。

### 页内 Agent（内嵌 strands agents）

浏览器聊天面板的后端是应用内嵌的 [strands agents](https://strandsagents.com/) Agent：它经**本应用自己的 MCP**（loopback streamable-http，与外部 Claude Code 共用同一接口）操作脑图，模型走任意 OpenAI 兼容网关，换 Provider 只改 `.env` 三行（已被 gitignore 保护，启动自动加载，不覆盖已有环境变量）：

```bash
# .env 示例（DeepSeek / 通义 / Kimi / OpenAI 均同构）
OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
OPENAI_API_KEY=<智谱 API Key>
AGENT_MODEL=glm-5.3-flash
```

未配置模型网关时，Agent 对话入口（按钮与面板）整体不渲染，相关错误无从触发；入口可见性由健康检查接口决定（env 完整性 → 网关探活 → MCP 握手），会话中网关异常则面板内显示明确的错误横幅。

## 项目结构

```
src/
  main.py                 # FastAPI 入口：REST + WS + MCP + 静态托管
  chat.py                 # 页内 Agent（strands）+ 聊天归档
  cli.py                  # UseCase CLI 通道
  models.py               # Map/Node 实体（display_id 对外、全局 id 内部）
  service/mindmap/        # 领域方法 + events hub（WS 广播/改动缓冲）
fe/src/                   # React Flow 前端（编辑器/聊天面板/布局算法）
specs/001..004/           # 设计文档（phase0-3 + story）
tests/                    # pytest（in-memory SQLite，每测独立库）
```

## 已知限制

- 单用户设计，无多人实时协同
- SQLite 单进程存储（`var/mindmap.db`）
- 无 XMind / OPML 导入导出——outline 文本协议是当前唯一的交换格式

## Roadmap

- [ ] 导入导出：XMind / OPML / FreeMind
- [x] Docker 一键部署（`docker compose up -d`）
- [ ] 多人协同（树级 OT / CRDT）
- [ ] Agent 感知用户视图态（如当前聚焦的子树），协同粒度从"树"细化到"注意力"

## 开发

```bash
uv run pytest tests/ -q          # 后端测试
cd fe && npm run lint            # 前端 oxlint
```

各模块设计记录见 `specs/`（001 总体架构、002 节点双 ID、003 聊天面板、004 内嵌 strands Agent）。

## License

[MIT](LICENSE)
