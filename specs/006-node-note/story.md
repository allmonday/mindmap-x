# Story: 节点 markdown 备注（note 字段 + 右侧备注面板）

## 用户原始需求

> 我想加个功能，可以渲染 markdown，在 node 中，帮我评估一下。
> （评估后改向）markdown 的内容还是加到 node 的字段中，点击节点在侧边栏里面渲染。

## 需求说明

- 痛点：节点 content 是画布短标题，Agent 生成的长内容（背景/细节/论述）没有落点——撑长 content 会破坏画布可读性
- 已否决方案：节点内直接渲染 markdown——布局引擎依赖 canvas 纯函数测量（`fe/src/layout.ts` measure），markdown 块级元素打破"内容→尺寸"线性模型，成本高风险大
- 计划：见 `~/.claude/plans/pure-churning-dahl.md`（已批准）

## Overview Design

### content / note 分工

| 字段 | 语义 | 参与布局测量 | 渲染位置 |
|------|------|--------------|----------|
| `content` | 画布短标题（一行） | ✅ canvas measureText | 节点内纯文本 |
| `note`（新） | markdown 长文备注 | ❌ 完全不参与 | 右侧备注面板（源码/预览切换） |

### note 语义约定

- `null` = 无备注；写入空串归一为 `null`（methods 层 `note or None`，DB 只有两态）
- `update_node(note=...)`：`None`=不动，`""`=清空（REST/MCP 侧靠 JSON.stringify 丢弃 undefined 键实现"不传=不动"）
- note 变更归入**内容变更**：刷 `updated_by/updated_at`、version+1、落快照、进 Agent 通知
- 快照/restore 带全 note（restore 用 `sn.get("note")` 兼容旧快照）

### 关键实现决策

- **字段定名 `note` 而非 `detail`**：`MapRevision.detail` 已表示"版本改动摘要"，Node 上再用 detail 会在快照 JSON（`revision.detail` vs `revision.nodes[].detail`）与代码里语义重名
- **NodeRef omit `note`**：parent 引用只带 display_id 语义——markdown 长文不随每个节点的 parent 引用 ×N 膨胀全树 payload
- **新增 `get_node` query**：outline 行协议不含 note，Agent 写后需要读回入口
- **apply_outline replace 保留 note**：删除前按 display_id 收集 `old_notes`，锚定行重建时带回；顺带把锚定表收缩为根——修掉既有脏路径（replace+锚定会 mutate 已 delete+flush 的 ORM 对象，且与 docstring"display_id 重排为 1..n"矛盾，收缩后回归文档语义）
- **Agent prompt 补分工守则**：长内容写 note 而不是撑长 content
- 前端：右侧 DetailPanel 复用 ChatPanel 悬浮骨架（互斥），点击/键盘选中联动，脏编辑自动保存（切节点/unmount flush + 基线前移防双写）

## 实现描述

| 层 | 改动 |
|----|------|
| Schema | `Node.note` 列（sa.Text 可空）+ `alembic/versions/e4a9c1f6b8d2` |
| dtos.py | NodeRef omit_fields 加 note；RevisionNodeDTO 加 `note: str \| None = None` |
| methods.py | update_node/add_node 加 note 形参；新增 get_node；_build_snapshot/restore_revision 带 note；apply_outline replace 保留 |
| service.py | 透传 + get_node query（MCP/REST/CLI 从签名自动生成，零注册） |
| chat.py | SYSTEM_PROMPT 补 get_node 工具 + 节点分工守则 |
| 前端 | types/api/RevisionPanel note 流转；DetailPanel 组件（源码/预览 + 脏编辑自动保存）；MindMapEditor 集成（互斥/快捷键 d/Esc 链/节点 ✎ 标记 + nodesSig/rfNodes key 两处签名）；App.css（面板骨架共享 + `.md` 样式通用化）；i18n 双语 |

## 验证结果

- `uv run pytest`：70 passed（含快照断言同步 2 处 + 新增 10 用例：读写往返 / 空串清空归一 NULL /
  None 不动 / 仅 note 走内容变更分支 / get_node 缺失报错 / add_node 带 note / replace+merge 保留 / NodeRef 防泄漏 / 快照 restore 往返 / 旧快照缺 key 兜 None）
- `alembic upgrade head`：node 表新增 `note TEXT` 可空列；downgrade 往返无错
- 前端：`npm run generate-client`（NodeDto/RevisionNodeDto 带 note、getNode 生成）、
  `tsc -b`、`oxlint`（无新增 warning，stash 前后 8=8）、`vite build` 全过
- MCP 端到端（compose_query，换行 `\n` 转义）：
  - `update_node(note=多行 markdown)` 写入 → `get_node` 读回全文一致，content 未动
  - `get_map`：nodes 带 note；**parent 引用无 note**（NodeRef 防膨胀生效）
  - `get_tree` outline 不含 note（行协议不破坏）
  - `add_node(note=...)` 初始备注落库
  - `apply_outline(replace)` 带锚定：#2 content 更新 + note 原样带回；未锚定新行 note=null；
    display_id 回归 docstring 的顺序重排
- REST：`/api/mindmap_service/get_node` 端点出现于 openapi.json
