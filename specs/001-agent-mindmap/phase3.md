# Phase 3: UseCase 响应组装 + 服务接口

## 需求说明

按 Phase 0 确认（CLI + MCP + REST 全开）与 Phase 3 Step 1 用户确认的 DTO 返回树，组装 UseCase 响应并生成三套正式接口。

## 实现描述

### Step 1: DTO 返回结构（用户已确认）

9 个方法 → 3 个 DTO（树见对话记录，要点）：

- `MapSummary`：id, title, version, created_at（列表轻量）
- `MapDetail`：MapSummary + `nodes: list[NodeDTO]`（auto-load Map.nodes）
- `NodeDTO`：全字段，**保留 parent_id / map_id**（树结构中父子引用是领域概念，非待隐藏 FK）
- `get_map`（JSON 树，前端）与 `get_tree`（outline 文本，Agent）并存——协同工具的双读法

### 产出文件

| 文件 | 内容 |
|------|------|
| `service/mindmap/spec.md` | 服务目的 / 消费方 / 方法需求 / DTO 说明 |
| `service/mindmap/dtos.py` | MapSummary / NodeDTO / MapDetail（无 `from __future__ import annotations`） |
| `service/mindmap/service.py` | MindmapService：9 方法（@query/@mutation async classmethod），复用 methods.py，DTO 转换 + `Resolver().resolve()` |
| `src/cli.py` | `create_use_case_cli(use_case_config)` → `uv run python -m src.cli mindmap-service <method>` |
| `src/main.py` | + `create_use_case_router`（REST）、`create_use_case_graphql_mcp_server` + http_app（`/mcp`，streamable-http + stateless）、Voyager services 视图、`ValueError → 400` 全局 handler |
| methods.py | + `get_map(map_id) -> Map`（供 service 单条转 DTO） |

### 发现与修复

1. `Resolver` 非 nexusx 顶层导出——从 `src.models`（`er.create_resolver()` 产物）导入
2. CLI 子命令为**下划线**风格（`list_maps` 非 `list-maps`），Typer 不做连字符归一
3. REST 路由为 `/api/mindmap_service/<method>`（service 类名 snake_case）
4. 业务校验异常（ValueError）默认 → HTTP 500：加 FastAPI 全局 `exception_handler(ValueError)` → **400 + 中文消息**；该转换只在 REST 出口生效，CLI/MCP 协议中立
5. `pkill -f "src.main:app"` 会匹配到执行它的 shell 自身命令行导致自杀 → 用 `[s]rc.main` 字符类技巧

### 验证结果

- `pytest tests/`：18 passed（无回归）
- **REST**：`list_maps` → 2 图 ✅；`get_map(1)` → **10 节点全部 auto-load**，字段完整 ✅；`add_node`（actor=human）→ NodeDTO 返回 position=2 ✅；缺 content → **422** ✅；move_node 成环 → **400 + "不能把节点移动到自己或它的子树下（会成环）"** ✅
- **CLI**：`mindmap-service list_maps` → JSON 列表 ✅；`get_tree --map-id 2` → outline 文本 ✅
- **MCP**：initialize 握手（serverInfo: Agent MindMap MCP）✅；tools/list → 4 层工具（list_apps / describe_compose_schema / describe_compose_method / compose_query）✅；`compose_query("{ MindmapService { get_tree(map_id: 2) } }")` → 正确 outline 数据 ✅
- Voyager services 视图挂 `/voyager`（浏览器 CDN 受限时不可用，已知网络环境问题）

### Agent 接入方式（交付摘要）

| 方式 | 命令 |
|------|------|
| CLI | `uv run python -m src.cli mindmap-service get_tree --map-id 1` |
| MCP | `claude mcp add mindmap -- uv run python -m src.main`（streamable-http `http://<host>:8740/mcp`） |
| REST | `POST /api/mindmap_service/<method>`（OpenAPI 文档 `/docs`） |

## 实现描述（追加）：WebSocket 实时广播 + React 前端编辑器

Phase 3 交付后按用户指示扩展（前端方案修订为 React + Vite，见 phase0.md 变更记录）。

### 产出

| 文件 | 内容 |
|------|------|
| `src/main.py` +`/ws/{map_id}` | WebSocket 订阅端点，**双通道变更检测**（见下） |
| `fe/` | Vite + React + TS 前端：SVG 脑图（根居中、子树左右分组）、双击编辑、Tab/Enter/Del 快捷键、折叠、pan/zoom、Agent 修改橙色高亮、outline 弹层编辑（同 Agent 协议）、WS 实时重拉 |
| `fe/vite.config.ts` | dev proxy：`/api` `/mcp` `/voyager` `/ws` → 8740；build → `src/static` |
| `fe/src/layout.ts` | 紧凑树布局 + 贝塞尔连线（锚点方向由 child.side 决定） |
| `fe/src/api.ts` / `types.ts` | REST 封装（浏览器端 actor=human）与类型（Phase 4 SDK 可替代） |

### 关键设计：WS 双通道变更检测

- **快速路径**：服务进程内 mutation（REST/MCP/前端）→ events hub `publish_change` → 即时推送
- **兜底轮询**：外部进程直连 DB 的修改（**CLI 是独立进程**，其 publish 发生在自己内存里，服务进程收不到——验收时实测暴露）→ WS 端点每 0.4s 查询 `Map.version`，发现增长即推 `action=external` 事件
- 事件语义是「版本变了，请重拉」，不做细粒度 patch；节点上的 `updated_by` 保证 Agent 高亮在任何写入路径下都正确

### 验证结果

- 端到端：WS 客户端挂监听 + CLI `add_node`（外部进程）→ 收到 `changed(v18, external)` ✅
- 端到端：WS 客户端挂监听 + REST `add_node`（actor=human）→ 即时收到 `changed(v19, node_added, human)` ✅
- 前端 `tsc -b` 零错误，`npm run build` 产物 200KB（gzip 64KB），FastAPI `/` 托管 HTTP 200 ✅
- `pytest tests/` 18 passed（无回归）✅
