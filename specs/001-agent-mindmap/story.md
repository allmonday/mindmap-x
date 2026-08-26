# Story: 人 + AI Agent 协同脑图工具

## 用户原始需求

> 想找一个新时代的 人 + AI Agent 协同脑图工具。
>
> 核心需求：
> - 脑图 / 树状结构编辑器
> - Human 可以直接在图形界面里编辑
> - Agent 可以读取、修改同一棵树
> - Human 和 Agent 的修改可以互相立刻看到
> - 支持 self-hosted
> - 能直接从 Claude Code、Codex 这类 Agent 环境里启动或唤起使用
>
> 理想状态是：在 Agent 里一句命令启动，然后边推理、边修改脑图，Human 同时可以在浏览器里继续编辑

## 需求解读

结论：不是找现成工具，而是用 nexusx 4phase 从零构建一个 self-hosted 的协同脑图服务。

核心场景拆解：

1. **Agent 启动**：Agent（Claude Code / Codex）在会话中执行一条 bash 命令拉起服务（uvicorn 单进程），浏览器即可访问
2. **Agent 读写树**：Agent 通过 CLI / MCP / REST 接口读取和修改脑图
3. **Human 图形界面编辑**：浏览器里的脑图编辑器（挂载在 FastAPI static 上，self-hosted 单服务）
4. **双向实时同步**：任一方修改 → 另一方立刻看到（WebSocket 推送）
5. **数据持久**：self-hosted 工具，重启不丢数据

## Overview Design

（Phase 0 确认后补充；前端方案于 Phase 3 末修订为 React + Vite）

### 业务流程

```
Agent 侧                                    Human 侧
────────                                    ────────
bash: uv run uvicorn src.main:app           浏览器打开 http://<host>:8740/
  │                                           │
  ├─ CLI: python -m src.cli …                ├─ SVG 脑图编辑（双击/Tab/Enter/Del）
  ├─ MCP: claude mcp add …/mcp               ├─ outline 文本批量编辑（同 Agent 协议）
  └─ REST: /api/mindmap_service/*            └─ REST（actor=human）
  │                                           │
  └──────────► SQLite（version 递增）◄────────┘
                     │
        FastAPI /ws/{map_id} 双通道变更检测
        ├─ 快速路径：服务进程内 mutation → events hub 即时推送
        └─ 兜底轮询：外部进程（CLI）直连 DB → 0.4s 对比 version
                     │
        Human / Agent 双端实时重拉 → 修改互见
        （节点 updated_by = human/agent → 前端橙色高亮 Agent 改动）
```

### 实体关系

```
Map ──1:N──→ Node          （一棵脑图包含多个节点）
Node ──1:N──→ Node         （自引用，parent_id 形成树；删父级联删子树）
```

### 聚合根

`Map`（唯一，SQLModel 实体落表）；全部 @query/@mutation 挂 Map。

### 关键设计决策

| 决策 | 结论 |
|------|------|
| 前端 | React + Vite + TS（fe/），SVG 树自研渲染；build 产物挂 FastAPI static，运行时零 CDN |
| 实时同步 | WebSocket + 进程内广播（快速）+ version 轮询兜底（外部进程 CLI 直连 DB 场景，0.4s） |
| Agent 接口 | CLI + MCP + REST 三套（nexusx 同一 UseCaseService 生成） |
| API 粒度 | 细粒度方法 + apply_outline 整树写入（merge 不误删 / replace 重建） |
| 协议锚点 | outline 文本带 `[id:N]` 前缀：Agent 读一次即获得全部写锚点 |
| DB | file sqlite（./var/mindmap.db）+ alembic（render_as_batch） |
| 业务错误 | methods 抛 ValueError → REST 全局 handler 转 400（CLI/MCP 协议中立） |

### 四个实施阶段产出

| Phase | 产出 | 状态 |
|-------|------|------|
| 1 | Schema（Map/Node）+ alembic baseline + seed + Voyager | ✅ |
| 2 | 8 业务方法 + events hub + GraphQL 辅助接口（18 测试） | ✅ |
| 3 | DTO + MindmapService → REST/CLI/MCP 三套接口 | ✅ |
| + | WebSocket 实时广播 + React 前端编辑器（双通道验收） | ✅ |
| 4 | OpenAPI → TS SDK | 未启用（前端手写 types.ts 已对齐后端；需要时随时可生成） |
