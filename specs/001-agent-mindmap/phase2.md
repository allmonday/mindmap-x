# Phase 2: 业务方法实现 + Entity 挂载

## 需求说明

按 phase0.md 确认的 8 个用例方法实现 mindmap 域业务逻辑，挂载到 Map 实体（@query/@mutation），GraphQL 辅助接口可查询验证。

## 实现描述

### 产出文件

| 文件 | 内容 |
|------|------|
| `src/service/mindmap/methods.py` | 8 个独立 async 方法 + outline 解析/渲染 helpers |
| `src/service/mindmap/events.py` | 进程内广播 hub：`subscribe`/`unsubscribe`/`publish_change`；事件 = 「map_id + version + action + actor」通知客户端全量重拉；队列满丢消息安全（version 兜底） |
| `src/models.py` | `mount_method()`（Phase 1 预留，挂载列表一致） |
| `src/main.py` | + `mount_method()`（先）→ `GraphQLHandler`（后）→ `/graphql` GET(HTML)/POST + `/schema` |
| `tests/conftest.py` | in-memory StaticPool + monkeypatch methods 模块的 `async_session` + `seeded_map` fixture |
| `tests/test_mindmap_methods.py` | 18 个用例，每方法覆盖正常 + 边界 |

### 关键接口设计

- **actor 参数**（默认 `"agent"`）：所有 mutation 带 `actor: str`，写入 `node.updated_by`。Agent 端零参数即正确标记；浏览器前端显式传 `"human"`。一个参数解决「双端来源区分」
- **outline 协议**（`get_tree` 输出 = `apply_outline` 输入）：`- [id:N] content`，2 空格/级。有 id 锚定已有节点，无 id 新建——Agent 读一次即可拿到后续写所需的全部锚点
- **apply_outline 语义**：`merge`（更新锚定节点 + 新建无 id 节点 + **未提及的保留**，不误删 Human 数据）/ `replace`（根 id 保留，其余全删重建）
- **防环**：`move_node` BFS 检查目标父节点不在自身子树内
- 所有 mutation：`map.version += 1` + `publish_change(...)`

### 发现与修复

1. **`tests` 顶层名撞车**：nexusx 依赖链把一个 `tests` 包装进了 site-packages，`from tests.conftest import ...` 解析到错处 → 改用 pytest fixture（`seeded_map`）消除 import
2. **apply_outline KeyError: None**：position 重排循环遍历原始 entries（新建节点 entry 的 id 是 None），改为收集 `resolved_nodes`（flush 后的实际对象）再重排
3. **entity-first GraphQL 返回类型局限**：挂载在 Map 上的 mutation 返回类型统一推断为 Map —— selection 里查 Node 字段（content/position）触发 validation error，且**校验失败时整个请求不执行**（mutation 不会落库）。验收时须用 Map 也有的字段（如 `{ id }`）做 selection；正式接口（Phase 3 UseCaseService + DTO）返回类型显式，无此问题
4. seed 脚本 `sqlite_sequence` 报错（Phase 1 记录）：rowid 别名主键无 AUTOINCREMENT，显式 seed 后 max(id)+1 不会冲突

### 验证结果

- `pytest tests/`：**18 passed**（create/get/add/update/move/delete/apply_outline 正常+边界、events hub 收发/退订）
- GraphiQL 实测（file DB）：
  - `{ Map { list_maps { id title version } } }` → 返回 2 张 seed 图 ✅
  - `{ Map { get_tree(map_id: 1) } }` → 完整缩进 outline（含 [id:N]）✅
  - `mutation { Map { add_node(map_id:1, parent_id:2, content:"KOL 合作") { id } } }` → node 16 落库、position=2、updated_by=agent、version 12→13 ✅
  - `mutation { Map { move_node(node_id:2, new_parent_id:3) { id } } }` → 成环被拒（`RESOLVER_ERROR: 不能把节点移动到自己或它的子树下`）✅
  - `mutation { Map { apply_outline(map_id:2, outline:"...", mode:"merge") { id version } } }` → 锚定更新 + 新建 + 未提及保留 ✅
  - `mutation { Map { delete_node(node_id:16) } }` → `true` ✅
- 演示后已 `load_seed.py --force` 恢复干净数据
