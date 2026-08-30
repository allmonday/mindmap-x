# MindMap X

**English** | [简体中文](README.md)

> You hold the helm; it reads the stars — you share the same chart.

This is **MindMap X**: a self-hosted mind map — you edit it in the browser, agents edit the same map through one API, and changes are visible to both sides in real time.

<img width="1579" height="969" alt="image" src="https://github.com/user-attachments/assets/80cfba49-2fe6-4401-b113-c929bd94e5d8" />

----

Focus drill-down (breadcrumb navigation)

<img width="1029" height="437" alt="image" src="https://github.com/user-attachments/assets/9aef41fe-4883-4e0b-963d-16a5f0a8720d" />

## Why

"AI generates a mind map in one click" tools are everywhere — but the AI walks away after generating. This project answers a different question: **what if the mind map were a shared workspace for humans and agents?**

- **Two-way sync** — what you edit, the agent sees on its next turn; what the agent edits is highlighted on your canvas right away. Both sides are always looking at the same map, never drifting apart
- **Bring any agent** — the service itself is an MCP server: Claude Code, Cursor, or any MCP client connects with one command, and the built-in chat uses the same interface

## Quick Start

### Docker (recommended)

```bash
cp .env.example .env   # optional: model config for the in-page agent; skip to use canvas-only
docker compose up -d   # → http://localhost:8740
```

- All state (SQLite / chat archives / agent sessions) lives in the `mindmap-var` named volume: `down` keeps it, `down -v` wipes it;
- The image builds the frontend and runs DB migrations on startup — pull a newer image, restart, and the schema upgrades itself;
- If pulling base images times out (e.g. on restricted networks), build via a mirror:

```bash
NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine \
BASE_IMAGE=ghcr.m.daocloud.io/astral-sh/uv:python3.12-bookworm-slim \
docker compose build
```

### From source

Requirements: Python ≥ 3.12, Node ^20.19 || ≥22.12 (to build the frontend).

```bash
./scripts/start.sh          # deps → DB migration → frontend build (if missing) → start
./scripts/start.sh --seed   # optional on first run: load sample maps
```

`PORT=9000 ./scripts/start.sh` changes the port; Ctrl+C stops the server and cleans up the port. Frontend dev mode (hot reload):

```bash
cd fe && npm run dev   # port 5173, proxies /api /ws /mcp /voyager to 8740
```

## Connecting Agents

```bash
# MCP (Claude Code; Cursor and other MCP clients work the same way)
claude mcp add --transport http mindmap http://localhost:8740/mcp

# CLI
uv run python -m src.cli mindmap-service get_tree --map-id 1
uv run python -m src.cli mindmap-service apply_outline --map-id 1 \
  --outline "- [id:1] Root
    - [id:2] Branch
      - New node" --mode merge

# REST
curl -X POST localhost:8740/api/mindmap_service/get_tree \
  -H 'Content-Type: application/json' -d '{"map_id": 1}'
```

### In-page agent (embedded strands agents)

The browser chat panel is backed by an embedded [strands agents](https://strandsagents.com/) agent: it operates the map through **the app's own MCP** (loopback streamable-http, the same interface external Claude Code uses), with any OpenAI-compatible gateway as the model — switching providers is a three-line `.env` change (gitignored, auto-loaded at startup, never overrides existing env vars):

```bash
# .env example (DeepSeek / Qwen / Kimi / OpenAI all work the same way)
OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
OPENAI_API_KEY=<zhipu API key>
AGENT_MODEL=glm-5.3-flash
```

When no model gateway is configured, the agent chat button stays visible but grayed out: clicking it pops a dialog listing the environment variables to configure (`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `AGENT_MODEL`, see `.env.example`), and the panel never opens; a gateway failure mid-session shows an explicit banner inside the panel.

## Known Limitations

- Single-user by design; no multi-user real-time collaboration
- SQLite single-process storage (`var/mindmap.db`)
- No XMind / OPML import-export — the outline text protocol is the only exchange format today

## Roadmap

- [ ] Import/export: XMind / OPML / FreeMind
- [x] One-command Docker deployment (`docker compose up -d`)
- [ ] Multi-user collaboration (tree-level OT / CRDT)

## License

[Business Source License 1.1](LICENSE) — source-available: free for learning, modification, and internal business use; offering it to third parties as a product, service, or hosted offering requires a commercial license (allmonday@126.com). Each release automatically converts to Apache-2.0 four years after publication.

> Versions published before 2026-08-30 were released under MIT and remain MIT-licensed.
