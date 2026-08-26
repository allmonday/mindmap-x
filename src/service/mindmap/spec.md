# MindmapService 服务说明

## 目的

人 + AI Agent 协同脑图的唯一业务服务：同一棵 Map 树，Human 经浏览器前端编辑，Agent 经 CLI / MCP / REST 读写，双端修改实时互见（WebSocket 广播见 events.py）。

## 用途与消费方

| 消费方 | 入口 | 说明 |
|--------|------|------|
| 浏览器前端（SVG 编辑器） | REST | `get_map` 拉整树渲染；mutation 后靠 WebSocket 事件重拉 |
| Claude Code / Codex（CLI） | `python -m src.cli` | Agent 在 bash 里直接调用，`actor` 默认 agent |
| MCP client | `/mcp`（streamable-http） | 4 层渐进披露，`compose_query` 执行 GraphQL |
| 开发调试 | GraphiQL `/graphql` | entity-first 辅助接口（Phase 2） |

## 方法需求

| 方法 | kind | 返回 | 说明 |
|------|------|------|------|
| list_maps | query | list[MapSummary] | 图列表（轻量，无关联展开） |
| get_map | query | MapDetail | 整树结构化 JSON（前端渲染用） |
| get_tree | query | str | 缩进 outline 文本，带 [id:N] 锚点（Agent 读法） |
| create_map | mutation | MapDetail | 建图含根节点 |
| add_node | mutation | NodeDTO | actor 标记修改来源 |
| update_node | mutation | NodeDTO | 部分更新（content / collapsed） |
| move_node | mutation | NodeDTO | 换父/重排，防环校验 |
| delete_node | mutation | bool | 级联删子树，根不可删 |
| apply_outline | mutation | MapDetail | outline 整树写入：merge（不误删）/ replace |

## DTO 说明

- `MapSummary`：列表页轻量字段
- `MapDetail`：MapSummary + `nodes: list[NodeDTO]`（Resolver auto-load Map.nodes 关系）
- `NodeDTO`：**保留 parent_id / map_id** —— 树结构里父子引用是领域概念而非待隐藏的内部 FK；前端组装树、Agent 锚定节点都依赖它

## 变更记录

- 2026-08-26 初版（Phase 3）
