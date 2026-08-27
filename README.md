# Agent MindMap

人 + AI Agent 协同脑图：Human 在浏览器编辑，Agent（Claude Code / Codex 等）经 CLI / MCP / REST 读写**同一棵树**，双方修改通过 WebSocket 实时互见（Agent 改动的节点带橙色 AI 标记）。

基于 [nexusx](https://pypi.org/project/nexusx/) 6.x（SQLModel + FastAPI + UseCaseService 三接口生成）+ React Flow 前端。

## 启动

```bash
# 依赖 + 数据库 + 种子数据（首次）
uv sync --all-extras
uv run alembic upgrade head
uv run python scripts/load_seed.py --force   # 可选：灌入示例脑图

# 启动服务（浏览器打开 http://localhost:8740）
uv run uvicorn src.main:app --host 0.0.0.0 --port 8740
```

前端为 Vite 构建产物，已托管在 FastAPI（`src/static`）。改前端源码后：

```bash
cd fe && npm install && npm run build   # 重新构建到 src/static
# 或开发模式（热更新，5173 端口，代理 /api /ws /mcp /voyager 到 8740）
cd fe && npm run dev
```

## Agent 接入

```bash
# CLI（bash 直接调用）
uv run python -m src.cli mindmap-service get_tree --map-id 1
uv run python -m src.cli mindmap-service apply_outline --map-id 1 \
  --outline "- [id:1] 根
    - [id:2] 分支
      - 新节点" --mode merge      # merge 不误删未提及节点

# MCP（Claude Code）
claude mcp add --transport http mindmap http://localhost:8740/mcp

# REST（OpenAPI 文档见 /docs）
curl -X POST localhost:8740/api/mindmap_service/get_tree -H 'Content-Type: application/json' -d '{"map_id": 1}'
```

## 页内 Agent 对话（内嵌 strands agents）

浏览器 💬 面板对话的后端是应用内嵌的 [strands agents](https://strandsagents.com/) Agent：
它经**本应用自己的 MCP**（loopback streamable-http，与外部 Claude Code 共用同一接口）操作脑图，
模型走任意 OpenAI 兼容网关（DeepSeek / 通义 / Kimi / OpenAI 均可）。环境变量：

```bash
OPENAI_BASE_URL=https://api.deepseek.com/v1   # 你的网关地址
OPENAI_API_KEY=sk-xxx
AGENT_MODEL=deepseek-chat                      # 缺省回退 OPENAI_MODEL
```

未配置时面板会显示明确的错误横幅（健康检查：env 完整性 → 网关探活 → MCP 握手）。
设计细节见 `specs/004-embedded-strands-agent/`。

outline 协议：`- [id:N] 内容`，2 空格缩进一级；`[id:N]` 锚定已有节点，无 id 则新建。

## 测试

```bash
uv run pytest tests/ -q
```

详细设计记录见 `specs/001-agent-mindmap/`（phase0-3 + story）。
