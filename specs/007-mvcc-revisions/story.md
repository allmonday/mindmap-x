# Story: 版本存储 MVCC 化（node_revision 节点行替代整树快照）

## 用户原始需求

> （看到 change log 存储放大的实测后）我现在有点担心这个 change log 的方案会不会导致存储空间占用过大？
> （逐条压缩 → 串流压缩 → 分块讨论后）有没有更聪明的办法？针对于这个特定场景。
> 帮我备份一下数据库，然后按照这个思路重构一下当前的代码。

## Overview Design

问题：`map_revision.snapshot` 每版本存整树明文 JSON（实测全库 1.13 MB / 225 条，
DDD 图树 1.5 KB → 历史 104 KB ≈ 70×；中文 ensure_ascii 转义再放大 2×）。

方案演进（每步实测数据见 scripts/mvcc_prototype.py 输出）：

| 方案 | 全库实测 | 结论 |
|------|---------|------|
| zlib 逐条压缩 | 1139→255 KB（22%） | 改动最小，但跨条重复未利用 |
| 串流压缩 | 1139→48 KB（4.2%） | 收益大但与增量 append 互斥（压缩流封口） |
| **节点级 MVCC** | 2000 版合成序列 58.8 MB→168 KB（0.3%） | **消除冗余而非压缩冗余，天然 append** |

MVCC 核心：每次 mutation 只落"触碰节点"一行新状态（含墓碑），任意版本由
窗口函数物化（亚毫秒）。行是事实（fact），树是投影（projection）。

### 关键实现决策

- **行来源 = 物化上一版 vs 当前树的 diff**（同一事务，SELECT autoflush 机制与全量时代相同），
  不用 session.dirty/new/deleted——apply_outline 中途 flush 会清空 deleted 集合
- **`updated_at` 归一序列化（`_iso_norm`）**：内存对象 aware（`+00:00`）与 SQLite 读回
  naive（`Z`）两种形态必须归一，否则 diff 按字符串比较会把未触碰节点每版重复落行
  （实测抓到的真 bug，原型未暴露——原型两侧都源自快照字符串）
- **collapsed 随内容变更行走**（视图态不单独成行）：restore 后折叠态 = 各节点上次
  编辑时的态，与"目标时刻全树折叠态"有低感知差异，换取"编辑一次一行"
- **`map_revision` 表保留**为版本元数据（action/actor/detail/created_at + 新增 title 列）；
  snapshot 列迁移后置 null（结构保留，数据不可逆——downgrade 前需备份）
- **存量迁移**在 alembic migration 内完成（相邻快照 diff 灌行，逻辑与原型一致），
  对外 `get_revision` 的 snapshot JSON 形状不变，**service/DTO/前端零改动**
- display_id 重用/replace 重排场景物化等价（原型合成序列验证）；节点级历史语义
  在 replace 边界会混入不同逻辑节点（做"节点历史视图"时需定义边界）

## 实现描述

| 层 | 改动 |
|----|------|
| models.py | NodeRevision 模型（WITHOUT ROWID 主键聚簇）；MapRevision 加 title、snapshot 改可空 |
| alembic f5b8d2a4c7e6 | 新表 + title 列 + 存量迁移（快照序列→节点行，首版全量其后相邻 diff）+ snapshot 置 null |
| methods.py | `_iso_norm` / `_latest_nodes`（窗口物化）/ `materialize_tree` / `_write_node_rows`（diff 落行）/ `_commit_with_revision` 重写；`get_revision` 返回 (元数据, 物化树)；`restore_revision` 物化重建 |
| service.py | get_revision 手动组装 RevisionDetail（物化树 → RevisionSnapshotDTO，对外 shape 不变） |
| 测试 | 快照直读断言全部改物化；新增：单编辑单行 / 建基线语义（seed 直写首 mutation 全树行）/ 删子树墓碑 / null note 行 / 手改行制造畸形树拒绝 restore |
| scripts/mvcc_prototype.py | 等价性验证 + 存储基准原型（保留，作为方案文档的一部分） |

## 验证结果

- `uv run pytest`：72 passed（含 MVCC 行形态新用例）
- 真实库迁移（备份 var/mindmap.db.bak-20260901-mvcc）：225 快照 → 994 行节点行，
  VACUUM 后 **1.4 MB → 256 KB（5.5×）**；title 全部提取，snapshot 全置 null
- 端到端（MCP）：DDD 图 v24 物化出 35 节点完整树（含 1KB markdown note 无损）；
  单节点编辑恰好落 1 行（对比旧方案每次 8-12 KB 整树 JSON）；restore v24 往返
  内容/标题/备注全部恢复

## 追加（2026-09-02）：版本面板改为「版本间变化」直供

MVCC 红利兑现：新增 `get_revision_changes` query（`_latest_nodes(vN)` vs
`_latest_nodes(prev)`，prev = version<N 的最大版本，首版本全 added），RevisionPanel
的 diff tab 从「快照 vs 当前树的前端比较」（回滚影响预览）改为直接渲染后端变更集
（git log 风格：该版本当时改了什么）；kind 含新增的 `note`；徽章语义色反转
（added 绿 / removed 红）。双 tab 结构：变更 + 完整内容（SnapshotPreview 保留）。
回滚安全性由既有两步确认兜底。测试 75 passed；实测 v28 恰 1 行 note、
v14 首版本 35 行全 added、浏览器双 tab 正常。

## 追加（2026-09-02）：行语义翻转 after → before（undo log 终态）

原型验证（scripts/undo_prototype.py：真实库逐版本回溯 == 正向物化、坑场景全过、
after=next-before 推导链成立）后正式落地：

- **行存 before**（最小充分集）：新增=值列全 NULL（判别式 content IS NULL）、
  修改=变更前状态、删除=deleted+被删前状态（复活值）；after = 同节点下一行
  before / 最新态，可推导不落盘
- **写入 = 显式快照**：mutation 入口/变更前构造 `before` 传
  `_commit_with_revision`（必传 kwarg）。备选的 before_flush 事件方案被否：
  类级全局监听 + 首触优先 + bulk delete 盲区 + 视图态区分，隐藏行为多
- **物化 = undo 链**（`_undo_to`）：node 表当前态锚 + 逆序撤销 >target 的行，
  亚毫秒；接受折叠视图态污染（collapsed 无产品意义）
- **get_revision_changes**：before 行 + undo(v) 推导 after；**folded 判型移除**
  （node 表折叠漂移会伪造徽章）；「首版本全 added」语义消亡（before 显式可知）
- migration `b7d5f3a9c2e4` 清空历史（after 行 = 毒数据），时间线从切换时刻重记
- 落地过程中 golden 逐版本测试抓到两个真 bug：① replace 锚定重建行把 before
  错置 None（同号时应保留旧快照值 = 修改行）② restore 复活的节点必须在
  before 里显式补 None（insert 行），否则 undo 该版本时无法消失——
  `_write_node_rows` 不做 cur-before 差集（部分快照 mutation 的差集全是
  未触碰节点），由信息完整的调用方负责
- 测试 76 passed（含 golden 逐版本守护）；真实库迁移后 MCP 端到端：
  行形态 / undo 物化往返 / changes 的 old_content / restore 回滚全部正确

## 追加（2026-09-02）：存储形态列式 → before JSON 单列

`c8e6a2f4b1d9`：七个镜像字段列替换为一个 `before JSON` 列（表当时为空，
纯 schema 重建）。动机：**Node 字段演进零 DDL**——新字段只需进
`_DIFF_FIELDS` 语义清单（哪些字段参与版本/忽略规则是业务知识，与存储正交），
node_revision 表结构不再随 Node 动。附带改善：insert 判别式从
`content IS NULL`（依赖业务不变式）变为 `before IS NULL`；`_undo_to` 撤销
循环缩为 `tree[did] = dict(r.before)` 一行（sa.JSON 自动反序列化）。
代价：节点历史的字段级 SQL 查询要走 JSON 函数（当前无此需求）。
"加字段"的操作面从 migration×2+五处代码缩到**一行清单**。
