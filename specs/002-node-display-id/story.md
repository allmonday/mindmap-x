# Story: 节点 ID 改为 map 内编号（display_id）

## 用户原始需求

> 我不希望有历史兼容性问题。我的要求是，每一个 map 里面的节点，它的 ID 应该是从一开始的。现在它们是跨 map 来累计的，会导致 ID 的数字过大，这意味着你可能需要有一个新的列来记录它的 display_id。

## 需求说明

- 痛点：全局自增 id 跨 map 累计（map 4 已到 #98..#170），角标数字大且无意义，Agent 引用冗长
- 明确不做历史兼容层：对外接口语义直接切换，已有数据重编
- 计划：见 `~/.claude/plans/polymorphic-roaming-muffin.md`（已批准）

## Overview Design

### 双 ID 架构

| ID | 性质 | 用途 |
|----|------|------|
| `node.id`（全局主键） | 内部 | DB 主键、parent_id 自引用 FK、环检测/子树收集——不对外暴露 |
| `node.display_id`（新列） | map 内唯一，每图从 1 起，`UNIQUE(map_id, display_id)` | REST/CLI/MCP 参数、outline `[id:N]`、前端角标——对外唯一 ID 语义 |

单节点 mutation 统一以 `(map_id, display_id)` 定位（display_id 仅 map 内唯一）。

### 分配规则

- `create_map`：根 = 1；`add_node`/merge 新建：map 内 max+1（删除不复用，编号稳定）
- `apply_outline replace`：按 outline 顺序重排 1..n（数字保持小）；merge：锚定节点保留原编号

### 关键实现决策

- 迁移手写（非 autogenerate）：batch 加列（nullable）→ 窗口函数 `ROW_NUMBER() OVER (PARTITION BY map_id ORDER BY id)` 回填 1..n → batch 加 UNIQUE + NOT NULL
- **DefineSubset 自动注入主键/FK 供 DataLoader 键解析**——`SubsetConfig(omit_fields=["id"])` 从输出剔除全局主键（内部仍参与加载；`fields` 与 `omit_fields` 互斥）
- NodeDTO 增 `parent: NodeRef`（仅 display_id，防 parent 链递归加载）——前端「加兄弟」用 `parent.display_id`，组树仍用 `parent_id`（内部结构键）
- 旧「parent 属于其他图」检查删除：`(map_id, display_id)` 定位天然只命中本图节点
- outline 新校验：多个 level-0 行拒绝（防双根）

## 实现描述（合并 Phase 1-3 记录）

| 层 | 改动 |
|----|------|
| Schema | `Node.display_id` 列 + `alembic/versions/b3f1a2c4d5e6`（回填每图 1..n + 唯一约束） |
| methods.py | `_get_node(map_id, display_id)`；update/move/delete 签名加 map_id；add_node 分配 max+1；get_tree/apply_outline 全切 display_id |
| dtos.py | NodeDTO/NodeRef 用 SubsetConfig omit 全局 id；parent 引用关系 |
| service.py | update/move/delete 加 map_id 透传 |
| 前端 | types（display_id + parent 引用）、api（map_id 参数）、editor/layout（display_id 体系组树与操作） |
| seed/测试 | seed_data.json 注入 display_id；20 用例（新增跨图隔离、双根拒绝） |

## 验证结果

- `pytest`：20 passed
- 迁移后每 map `display_id = 1..n`（map 4: 1..60），`UNIQUE(map_id, display_id)` 生效，FK 无损
- `get_tree map 4` → `[id:1]..[id:60]` 小数字
- CLI `update_node --map-id 4 --node-id 2` 精确命中；`add_node(parent=#2)` 新节点编号 = map 内下一个号（#61）
- REST `get_map`：全局 id 零泄漏（含 parent 引用），omit 后 DataLoader 关系加载正常
- WS 端到端：CLI add_node → changed 事件实时推送
