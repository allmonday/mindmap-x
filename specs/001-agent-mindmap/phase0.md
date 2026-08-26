# Phase 0: 需求确认

## 需求说明

构建一个 self-hosted 的人 + AI Agent 协同脑图工具（原始表述见 story.md）。核心诉求：脑图树编辑器、Human 图形界面编辑、Agent 经 CLI/MCP/REST 读写同一棵树、双方修改实时互见、Agent 环境一句命令启动。

## 实现描述（确认结论）

### Step 0-1: 实体定义

| 实体 | 含义 | 核心字段 | 约束 |
|------|------|---------|------|
| Map | 一棵脑图 | id, title, version, created_at | title 非空；version 每次 mutation +1（断线重连全量重拉依据） |
| Node | 树节点 | id, map_id, parent_id(自引用), content, position(同级排序), collapsed, updated_by, updated_at | 根节点 parent_id=None；updated_by ∈ {human, agent}，前端据此高亮 Agent 修改 |

不建 Event 表：实时同步用进程内广播（asyncio.Queue）+ WebSocket；客户端断线后按 version 全量重拉。

### Step 0-2: 实体关系

```
Map ──1:N──→ Node
Node ──1:N──→ Node   （自引用；删父级联删子树）
```

### Step 0-3: 聚合根

Map（SQLModel 实体，落表）为唯一聚合根，全部 @query/@mutation 挂 Map。

### Step 0-4: 业务域 + 用例方法

**Service 切分：方案 A 单一域 `mindmap`**（用户对推荐方案无异议）。理由：单用户 self-hosted 工具，方法 ~9 个域内聚；按实体拆会让 move/delete 跨域。

| 方法名 | 业务意图 | 挂载实体 | 关键参数 |
|--------|---------|----------|----------|
| create_map | 建新图（含根节点） | Map | title |
| list_maps | 列出所有图 | Map | — |
| get_tree | 整树读取，返回缩进 outline 文本（Agent 读法） | Map | map_id |
| add_node | 加子节点 | Map | map_id, parent_id, content, position |
| update_node | 改内容/折叠 | Map | node_id, content, collapsed |
| move_node | 换父/同级重排 | Map | node_id, new_parent_id, position |
| delete_node | 删节点及子树 | Map | node_id |
| apply_outline | 整段缩进文本 merge/replace 整树（Agent 批量写法） | Map | map_id, outline, mode |
| watch | WebSocket 订阅变更 | — | map_id |

API 粒度：**细粒度 + apply_outline 双模式**（用户确认）。

### Step 0-5: GraphQL 定位

GraphQL 仅作 Phase 2 辅助测试（GraphiQL），正式接口为 REST + CLI + MCP（用户确认全开）。

### Step 0-6: 第三方库

| 领域 | 方案 | 理由 |
|------|------|------|
| 实时推送 | FastAPI 原生 WebSocket + asyncio.Queue 进程内广播 | 单进程 self-hosted，无需 Redis，零新增依赖 |
| 前端 | ~~单 HTML 自研~~ → **React + Vite + TS**（Phase 3 末用户修订），SVG 树渲染自研，build 产物挂 FastAPI static | 用户建议工程化；运行时零 CDN 依赖保持（Vite 产物为本地静态文件）；React 管理编辑器交互复杂度更可持续 |
| ASGI | uvicorn | nexusx 标配 |
| 脑图库调研 | jsmind / markmap 均活跃（备选，未采用） | markmap 偏可视化编辑弱；jsmind 可编辑但同步层仍需自写 |

> **前端方案变更**（2026-08-26，Phase 3 完成后）：由「单 HTML 自研」改为 React + Vite + TS。动机：编辑器交互复杂度（节点编辑/拖拽/实时同步状态）值得组件化工程；运行时离线性不变。同时启用原可选的 Phase 4（TS SDK）支撑前端类型安全调用。

### Step 0-7: 数据持久化与迁移（用户确认）

```
DB 选型：file-backed sqlite
async DATABASE_URL：sqlite+aiosqlite:///./var/mindmap.db
sync DATABASE_URL_SYNC（alembic + load_seed 用）：sqlite:///./var/mindmap.db
是否引入 alembic：是（sqlite 需 render_as_batch=True）
是否需要 docker-compose：否
init_db() 策略：no-op（schema 由 alembic 管）+ scripts/load_seed.py 一次性灌 seed（保留 ID）
```

### 检查清单

- [x] 实体/字段/约束完整
- [x] 关系方向与基数正确（无 M:N）
- [x] 聚合根明确：Map（SQLModel 实体）
- [x] Service 切分：方案 A 单域 mindmap，用户未表异议视为确认
- [x] 用例覆盖建图/读树/增删改移/批量 outline/订阅，逻辑自洽
- [x] 第三方库选型确认（WebSocket 原生、前端自研、脑图库已调查）
- [x] DB 选型 + alembic 策略用户确认
