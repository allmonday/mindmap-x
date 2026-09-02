# MindmapService 服务说明

## 目的

人 + AI Agent 协同脑图的唯一业务服务：同一棵 Map 树，Human 经浏览器前端编辑，Agent 经 CLI / MCP / REST 读写，双端修改实时互见（WebSocket 广播见 events.py）。

## 用途与消费方

| 消费方 | 入口 | 说明 |
|--------|------|------|
| 浏览器前端（SVG 编辑器） | REST | `get_map` 拉整树渲染；收放乐观更新并通过 WS 增量同步，其他 mutation 后靠 WebSocket 事件重拉 |
| Claude Code / Codex（CLI） | `python -m src.cli` | Agent 在 bash 里直接调用，`actor` 默认 agent |
| MCP client | `/mcp`（streamable-http） | 4 层渐进披露，`compose_query` 执行 GraphQL |
| 开发调试 | GraphiQL `/graphql` | entity-first 辅助接口（Phase 2） |

## 方法需求

| 方法 | kind | 返回 | 说明 |
|------|------|------|------|
| list_maps | query | list[MapSummary] | 图列表（轻量，无关联展开） |
| get_map | query | MapDetail | 整树结构化 JSON（前端渲染用） |
| get_tree | query | str | 缩进 outline 文本，带 [id:N] 锚点（Agent 读法） |
| get_node | query | NodeDTO | 单节点全文（含 note）——outline 不含 note 的读回入口 |
| create_map | mutation | MapDetail | 建图含根节点 |
| add_node | mutation | NodeDTO | actor 标记修改来源；可带初始 note |
| update_node | mutation | NodeDTO | 部分更新（content / collapsed / note；note="" 清空存 null） |
| set_node_collapsed | mutation | bool / REST 204 | 单节点高频收放；WS 回传 client_request_id 与状态增量 |
| move_node | mutation | NodeDTO | 换父/重排，防环校验 |
| delete_node | mutation | bool | 级联删子树，根不可删 |
| expand_all | mutation | bool / REST 204 | 批量展开，不返回整树 |
| set_fold_level | mutation | bool / REST 204 | 按层折叠，不返回整树 |
| apply_outline | mutation | MapDetail | outline 整树写入：merge（不误删）/ replace |
| list_revisions | query | list[RevisionSummary] | 版本时间线（轻量，不含树内容） |
| get_revision | query | RevisionDetail | 某版本整树（MVCC 物化，原快照 JSON 形状） |
| get_revision_changes | query | RevisionChangesDTO | 版本间变更集（该版本 vs 上一版本，节点行 diff） |

## DTO 说明

- `MapSummary`：列表页轻量字段
- `MapDetail`：MapSummary + `nodes: list[NodeDTO]`（Resolver auto-load Map.nodes 关系）
- `NodeDTO`：**保留 parent_id / map_id** —— 树结构里父子引用是领域概念而非待隐藏的内部 FK；前端组装树、Agent 锚定节点都依赖它

## 变更记录

- 2026-08-26 初版（Phase 3）
- 2026-08-31 收放操作改为前端乐观更新；REST 折叠接口返回 204
- 2026-09-01 Node 加 note（markdown 备注）：update/add/get_node 支持；快照与 restore 带全 note；
  apply_outline replace 锚定保留 note；NodeRef omit note（防 parent 引用膨胀）
