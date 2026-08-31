# Phase 4: OpenAPI TypeScript SDK

## 需求说明

前端 REST 调用改用 FastAPI OpenAPI 生成的 TypeScript SDK，避免手写路径、请求体
和响应类型漂移。

## 验收标准

| # | 验收项 | 验证方式 |
|---|--------|----------|
| 1 | UseCase DTO 和请求体生成 TS 类型 | 检查 `fe/src/sdk/types.gen.ts` |
| 2 | snake_case 字段名原样保留 | 检查折叠请求类型 |
| 3 | SDK 包含三条 204 折叠调用 | 检查 `fe/src/sdk/sdk.gen.ts` |
| 4 | 业务代码不再手写 MindmapService fetch | 检查 `fe/src/api.ts` |
| 5 | SDK 可重复生成且前端类型通过 | 运行 generate-client 和 build |

## 实现描述

- 固定 `@hey-api/openapi-ts@0.99.0` 并更新 npm lockfile。
- 增加 `fe/openapi-ts.config.ts` 和 `npm run generate-client`。
- 生成产物提交到 `fe/src/sdk`。
- 前端通过 SDK 薄适配层统一传入 `body`，保留现有业务方法命名。
- UI 的 Map/Node/Revision 类型从生成 DTO 派生，仅收紧运行时必填字段。

验收结果：

- [x] `types.gen.ts` 包含全部 UseCase DTO 和请求类型。
- [x] `map_id`、`node_id`、`client_request_id` 等 snake_case 字段原样保留。
- [x] 三条折叠响应均生成成 `204: void`。
- [x] `api.ts` 不再手写 MindmapService URL 或 fetch。
- [x] 二次生成文件哈希一致，`npm run build` 通过。
