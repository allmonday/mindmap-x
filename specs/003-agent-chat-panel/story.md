# Story: 底部 Agent 对话面板（页内直接对话，变更即时可见）

## 用户原始需求

> 我需要在画面中……可以展开一个聊天对话框。这个东西可以是一个 xterm.js 以及 PTY 连接的命令行界面。第一步的时候简化一下。
> 我改主意了，这个最好是放在下方，而不是左边打开。功能是直接在页面上和 MCP 对话，这样子可以即时的看到变更效果，不需要有个单独的 Terminal。
> 我还需要你在启动之前确保这个 MCP 是存在的，否则的话需要在页面上给出错误消息。

（用户口述的 "NCP"/"Extend JS" 均为 MCP / xterm.js）

## 需求说明

- 底部可展开聊天抽屉，直接对 Agent 说指令，Agent 经 mindmap MCP 改树，画布即时变化
- 启动前健康检查：CLI 存在 + MCP 端点可达，不健康在页面给明确错误（用户不发消息就知道为什么不能用）
- 第一步简化：不做 xterm.js + PTY 完整终端（后续方向）；不做聊天历史持久化
- 计划：`~/.claude/plans/polymorphic-roaming-muffin.md`（用户 review 后批准）

## Overview Design

```
ChatPanel（底部抽屉）──WS /chat/{map_id}──► src/chat.py
                                              │ spawn（每轮一次，argv 数组无 shell）
                                              ▼
                              claude -p <msg> --mcp-config <本服务 /mcp>
                                  --allowedTools "mcp__mindmap__*"（最小权限）
                                  --resume <session_id>（会话延续）
                                  --output-format stream-json --verbose
                              │                    │
              Agent 调 MCP 改树 │                    │ stdout 流式解析
                              ▼                    ▼
                 /ws/{map_id} 广播（已有）    delta/done/error 事件
                              ▼                    ▼
                    画布即时刷新（橙色 AI 标记）   聊天气泡流式追加
```

关键点：变更即时反馈复用既有 WS 广播链路，本需求唯一增量是「对话通道」。

## 实现描述

| 文件 | 内容 |
|------|------|
| `src/chat.py` | `GET /api/chat/status` 健康检查（`shutil.which` + MCP initialize 握手，3s 超时）；`WS /chat/{map_id}`（连接即推 status；busy 拒绝并发；180s 超时 kill；进程非零退出清 session_id 降级为全新会话）；system prompt 注入 map_id + display_id 语义 |
| `src/main.py` | 挂载 chat router |
| `fe/src/ChatPanel.tsx` | 底部抽屉（34vh）：健康横幅（红色 + 禁用输入）、user/agent 气泡流式、busy/思考中状态、Enter 发送 |
| `fe/src/MindMapEditor.tsx` | 💬 按钮切换面板 |
| `fe/src/App.css` / `fe/vite.config.ts` | 面板样式 / `/chat` dev proxy |

### 发现与修复

1. **静态 mount 截胡**：`Mount("/", StaticFiles)` 注册在 chat router 之前——`GET /api/chat/status` 被当静态文件（404）、WS 进了只收 http scope 的 StaticFiles（`assert scope["type"]=="http"` → 握手 500）。修复：静态 mount 必须是全文件最后注册的路由（已加注释固化此约束）
2. Agent 每轮都警惕 `parent_id` 是全局键——system prompt 补一句「parent_id 是内部键，操作用 display_id」

## 验证结果

- 健康检查：正常 `{ok:true, cli:true, mcp:true}`；`AGENT_CHAT_CMD=no-such-cli` 时 `{ok:false, reason:"未找到 Agent CLI…"}` ✓
- 端到端：「在 #2 下加一个子节点…」→ Agent 调 MCP 建节点 → 流式回复（含自述编号）→ `get_tree` 确认 `- [id:5] 聊天面板端到端验收` 挂在 #2 下 ✓
- 会话延续：第二轮「把刚才改名的那个节点加子节点」正确解析为 #5 → `- [id:6] 延续成功` ✓
- busy：第一条处理中发第二条 → busy 拒绝，无第二个进程 ✓
- `pytest`：21 passed 无回归 ✓
