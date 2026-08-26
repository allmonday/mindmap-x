# Phase 1: Schema + ER Diagram + mock seed

## 需求说明

按 phase0.md 确认的实体（Map / Node 自引用树）建立纯实体模型（无业务方法）、file-backed SQLite + alembic 迁移、mock seed 数据、Voyager ER 可视化。

## 实现描述

### 产出文件

| 文件 | 内容 |
|------|------|
| `src/db.py` | async engine（`sqlite+aiosqlite:///./var/mindmap.db`）+ session factory；模块级 `os.makedirs("var")` 保证目录存在 |
| `src/models.py` | 纯实体 Map + Node（docstring + Field description 齐全）；所有 Relationship 带 `lazy: noload`；自引用 `remote_side: "Node.id"`；显式 `List["Node"]`/`Optional["Node"]` typing（避免坑 8）；尾部预留 `mount_method()`（Phase 2）与 `ErManager + Resolver` |
| `src/database.py` | `init_db()` no-op（持久化场景：schema 由 alembic 管） |
| `src/main.py` | FastAPI + CORS + lifespan + Voyager（`create_use_case_voyager(services=[], er_manager=er)`）挂 `/voyager` |
| `alembic/` | env.py：`import src.models` + `SQLModel.metadata` + sync URL 环境变量 + `render_as_batch=True`（offline/online 双处）；script.py.mako 加 `import sqlmodel` |
| `alembic/versions/a284330e3cb6_init_schema.py` | baseline：`map`、`node` 两表，自引用 FK `parent_id→node.id` 已人工检查正确 |
| `var/seed_data.json` | 2 棵图 / 14 节点：`Q3 产品规划`（3 级 10 节点，human/agent 混合修改标记）+ `读书笔记：DDIA`（4 节点） |
| `scripts/load_seed.py` | 同步驱动灌 seed（保留 ID + 时间戳），`--force` 覆盖 |

### 关键决策与修复

- **自增序列**：seed 脚本最初尝试 `update sqlite_sequence`，报 `no such table: sqlite_sequence`。根因：SQLModel 整型主键是普通 rowid 别名（迁移无 AUTOINCREMENT），新行 id = max(id)+1，显式 seed 后不会冲突 → 删除该逻辑。

### 验证结果

- `alembic upgrade head` 成功，`alembic_version = a284330e3cb6`，表 `['alembic_version', 'map', 'node']`
- `scripts/load_seed.py --force`：2 maps / 14 nodes 灌入，树结构、position、updated_by 抽查正确
- `uvicorn src.main:app` 启动后：`GET /` 返回服务信息，`GET /voyager/` HTTP 200（ER 图可视化可访问）
