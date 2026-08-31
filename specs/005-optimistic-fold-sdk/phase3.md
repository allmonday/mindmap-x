# Phase 3: 轻量折叠接口

## 需求说明

将单节点和批量收放调整为高频视图态接口，不返回节点或整树 DTO；保留多端实时
同步，并让发起页面能够识别自己的 WS 事件，其他页面直接应用折叠增量。

## 验收标准

| # | 验收项 | 验证方式 |
|---|--------|----------|
| 1 | 单节点折叠使用独立 mutation | 检查 `set_node_collapsed` |
| 2 | 三条折叠 REST 接口均无响应体 | API 测试断言 HTTP 204 和空 body |
| 3 | WS 事件可关联发起请求 | 测试断言 `client_request_id` |
| 4 | 折叠仍正确持久化且不写版本快照 | methods/revisions 测试 |
| 5 | 其他页签无需回读整树 | WS 事件断言折叠 `payload` |

## 实现描述

- 新增 `set_node_collapsed`，避免通用 `update_node` 的 NodeDTO 解析。
- `set_node_collapsed`、`expand_all`、`set_fold_level` REST 路由返回 204。
- 视图态提交把可选 `client_request_id` 透传到 WS 事件。
- 收放事件携带最小 `payload`，其他页签直接 patch，不调用 `get_map`。
- 前端本地计算单节点、全部展开和按层折叠目标态，持久化请求按点击顺序串行。
- 发起页面消费匹配的 WS 事件而不重复执行 `get_map`；失败时回源校准。

验收结果：后端全量 59 项测试通过，三条 REST 接口均已验证为空响应。
