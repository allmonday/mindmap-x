# Optimistic Fold SDK

## 原始需求

2026-08-31：

- 前端单节点折叠和批量折叠存在频繁 API 请求与 IO 往返，应改为乐观更新。
- 后端折叠接口不需要返回实体数据，避免浪费网络。
- 前端应使用 OpenAPI 生成的 TypeScript SDK，而不是继续手写 REST 请求。

## Overview Design

浏览器先在本地更新 `collapsed` 状态，再按用户点击顺序调用折叠 mutation。
后端持久化后返回 `204 No Content`，并在 WebSocket 事件中携带
`client_request_id` 和最小折叠增量。发起页面识别自己的事件后不再重复读取
整棵树，其他页面直接应用增量同步，也不触发 `get_map`。

REST 请求和响应类型由 FastAPI OpenAPI 生成到 `fe/src/sdk`。业务代码通过
`fe/src/api.ts` 的薄适配层调用 SDK，不再维护路径、请求体结构或响应解析。

关键决策：

| 项目 | 决策 |
|------|------|
| 单节点折叠 | 专用 `set_node_collapsed` mutation |
| REST 响应 | 折叠相关接口统一 `204` |
| 多端同步 | WS 广播保留，当前请求去重，其他页签直接应用增量 |
| 连续操作 | 前端乐观更新，后端请求串行执行 |
| SDK | `@hey-api/openapi-ts@0.99.0`，提交生成产物与 lockfile |
