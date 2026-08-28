# MindMap X

**English** | [简体中文](README.md)

> **The mind map any agent can operate** — humans and AI co-editing one tree.

You edit the mind map in the browser; agents (the built-in chat, Claude Code, Cursor, CLI scripts…) read and write the **server-authoritative tree** through the same API. Changes from either side propagate in real time over WebSocket: agent edits are highlighted on the canvas, and your manual edits are injected into the agent's context on its next turn.

<img width="1596" height="1024" alt="image" src="https://github.com/user-attachments/assets/b5f91c02-f49a-4825-86f1-8f0744a6833e" />

----

Focus drill-down (breadcrumb navigation)

<img width="1158" height="724" alt="image" src="https://github.com/user-attachments/assets/35ad01a0-b429-4ead-9f44-82601a47ae45" />

----

In-page agent chat

<img width="1595" height="810" alt="image" src="https://github.com/user-attachments/assets/73511cfb-2526-4665-b393-66433b6b60c3" />

## Why

"AI generates a mind map in one click" tools are everywhere — but the AI walks away after generating. This project answers a different question: **what if the mind map were a shared workspace for humans and agents?**

- **Bidirectional co-editing** — you edit the canvas → edit summaries are buffered → injected into the agent's context as `<external_changes>` on its next turn, so the agent's view of the tree never drifts from what you see
- **MCP-native** — the mind map service itself is an MCP server; external Claude Code / Cursor agents connect with one command and share the exact same interface as the in-page agent. Bring your own agent
- **Server-authoritative tree** — every mutation flows through `version +1 → WS broadcast → client refetch`, a single data path. No-ops don't bump the version; view state (folding) never pollutes content-modification markers

## Feature Overview

### Canvas (for humans)

- XMind-style layout: root centered, subtrees mirrored left/right — switchable to a right-only single-direction logical chart
- Node operations: double-click / F2 rename, Tab add child, Enter add sibling, Delete subtree
- Folding: per-node fold toggle + toolbar "fold to level N" batch operation (server-side semantics, `set_fold_level`)
- **Focus drill-down**: select any node with children, hit focus, and it temporarily becomes the canvas root showing only its subtree; breadcrumbs show the ancestor path — click to switch, Esc to exit
- Long text wraps to multiple lines (up to 4, ellipsized beyond, full text on hover)
- WebSocket live sync with exponential-backoff auto-reconnect

### API (for agents)

| Method | Description |
| --- | --- |
| `list_maps` / `get_map` / `get_tree` | Queries: map list / structured full tree / outline text |
| `create_map` / `add_node` / `update_node` / `move_node` / `delete_node` | Point operations: create / add / update / move / delete (with cycle detection) |
| `delete_map` | Delete an entire map (all nodes included; broadcasts `map_deleted`, open clients return to the list) |
| `expand_all` / `set_fold_level` | Batch view state: expand all / fold by level |
| `apply_outline` | Bulk tree write via the outline protocol (below) |

Interactive docs: `/docs` (REST OpenAPI), `/voyager` (GraphQL).

#### The outline protocol

A first-class text protocol for trees — `get_tree` output is directly `apply_outline` input:

```text
- [id:1] Root
  - [id:2] Existing child (id-anchored: updates content and structure)
    - Grandchild (4-space indent = level 2)
  - Brand-new child (no id prefix = create)
```

- Every line starts with `- `; the `N` in `[id:N]` is the node number (display_id, per-map, starting at 1)
- Each 2 spaces of indent is one level deeper — no skipping levels; the first line must be the unindented root
- `merge` mode: anchored updates + creates + **nodes not mentioned are left untouched** (no accidental deletion)
- `replace` mode: keep the root, delete and rebuild everything else

### Bidirectional co-editing

```
Human edits ──REST──▶ server (version+1, records detail)
                       │
                       ├─WS broadcast──▶ every client refetches (single data path)
                       └─buffer────────▶ appended to the next user message as
                                          <external_changes> for the agent
Agent edits ──MCP/GraphQL──▶ same server pipeline; nodes carry an actor marker
```

Folding is **server-persisted view state**: it never touches the node's modified-by/modified-at fields (so agent-edit highlights don't false-fire), and a no-op neither bumps the version nor broadcasts. Focus drill-down is a pure client-side session state and never touches server data.

## Quick Start

Requirements: Python ≥ 3.12, Node ^20.19 || ≥22.12 (to build the frontend).

```bash
# Dependencies + database + seed data (first run)
uv sync --all-extras
uv run alembic upgrade head
uv run python scripts/load_seed.py --force   # optional: load sample maps

# Start (open http://localhost:8740 in a browser)
uv run uvicorn src.main:app --host 0.0.0.0 --port 8740
```

The frontend is a Vite build served by FastAPI (`src/static`). After changing frontend source:

```bash
cd fe && npm install && npm run build   # rebuild into src/static
# or dev mode (hot reload, port 5173, proxies /api /ws /mcp /voyager to 8740)
cd fe && npm run dev
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

All three channels sit on the same UseCaseService ([nexusx](https://pypi.org/project/nexusx/) 6.x: SQLModel + FastAPI — one signature generates REST/CLI/MCP/GraphQL).

### In-page agent (embedded strands agents)

The browser chat panel is backed by an embedded [strands agents](https://strandsagents.com/) agent: it operates the map through **the app's own MCP** (loopback streamable-http, the same interface external Claude Code uses), with any OpenAI-compatible gateway as the model — switching providers is a three-line `.env` change (gitignored, auto-loaded at startup, never overrides existing env vars):

```bash
# .env example (DeepSeek / Qwen / Kimi / OpenAI all work the same way)
OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
OPENAI_API_KEY=<zhipu API key>
AGENT_MODEL=glm-5.3-flash
```

Without configuration the panel shows an explicit error banner (health check: env completeness → gateway probe → MCP handshake).

## Project Structure

```
src/
  main.py                 # FastAPI entry: REST + WS + MCP + static hosting
  chat.py                 # in-page agent (strands) + chat archives
  cli.py                  # UseCase CLI channel
  models.py               # Map/Node entities (display_id external, global id internal)
  service/mindmap/        # domain methods + events hub (WS broadcast / edit buffer)
fe/src/                   # React Flow frontend (editor / chat panel / layout algorithm)
specs/001..004/           # design docs (phase0-3 + story)
tests/                    # pytest (in-memory SQLite, isolated per test)
```

## Known Limitations

- Single-user by design; no multi-user real-time collaboration
- SQLite single-process storage (`var/mindmap.db`)
- No XMind / OPML import-export — the outline text protocol is the only exchange format today
- No Docker / containerized deployment

## Roadmap

- [ ] Import/export: XMind / OPML / FreeMind
- [ ] One-command Docker deployment
- [ ] Multi-user collaboration (tree-level OT / CRDT)
- [ ] Agent awareness of user view state (e.g. the currently focused subtree) — co-editing granularity refined from "tree" to "attention"

## Development

```bash
uv run pytest tests/ -q          # backend tests
cd fe && npm run lint            # frontend oxlint
```

Design notes per module live in `specs/` (001 overall architecture, 002 node dual-id, 003 chat panel, 004 embedded strands agent).

## License

[MIT](LICENSE)
