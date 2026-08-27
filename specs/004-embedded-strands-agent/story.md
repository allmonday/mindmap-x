# Story: 内嵌 strands Agent 替换 claude CLI 对话后端

## 用户原始需求

> 如果我希望应用自己使用类似 strands 的框架，串一个 agent 来调用大模型来调用 MCP 的话，当前的代码应该如何调整？也就是说我得将应用自己的 MCP，暴露给应用自己的 strands agent.
> （评审中）是不是 MCP 使用 stdio 的模式更好？→ 经对比维持 streamable-http loopback
> （评审中）模型后端确认：OpenAI 兼容网关；claude CLI 后端彻底替换

## Overview Design

```
ChatPanel ──WS /chat/{map_id}──► src/chat.py
                                   │ asyncio.to_thread（工作线程）
                                   ▼
                     strands Agent（同步 agent() + callback_handler）
                       │ tools = MCPClient(url=/mcp).list_tools_sync()（with 内快照）
                       │ model = OpenAIModel（OPENAI_BASE_URL/OPENAI_API_KEY/AGENT_MODEL|OPENAI_MODEL）
                       ▼
             loopback streamable-http → 本服务 /mcp → 改树 → /ws 广播 → 画布 <50ms 刷新
```

- **MCP 仍是唯一权威工具接口**：内嵌 strands / 外部 Claude Code / Cursor 共用 `/mcp`
- **不选 stdio**（评审结论）：stdio = 独立子进程直连 DB → events 快速路径失效（退到 0.4s 轮询）+ 第二个 DB 写进程；loopback http 开销仅本机 1-3ms/次
- 健康检查三级：env 完整性（`AGENT_MODEL` 回退 `OPENAI_MODEL`）→ 网关 `GET /models` 探活 → MCP initialize 握手

## 实现描述（踩坑记录——strands 1.53.0 与文档示例的差异）

| 坑 | 现象 | 修复 |
|----|------|------|
| 包名 | `strands-openai` 不存在（PyPI） | `strands-agents[openai]`（extra 形式） |
| 同步 MCPClient 死锁 | `with MCPClient(...)` 在协程里调用：`__enter__` 阻塞事件循环等初始化，而它等的 MCP 响应需要本进程事件循环服务（loopback）→ 自锁（WS keepalive 超时断开） | **整轮 agent 丢 `asyncio.to_thread`**；同步 `callback_handler` 经 `loop.call_soon_threadsafe` 桥回事件循环转发 WS |
| ToolProvider 双重管理 | `tools=[mcp]` 使 Agent 自行 start provider，与 with 冲突："the client session is currently running" | with 内 `tools=list(mcp.list_tools_sync())`（该版本无 `.tools` 属性） |
| 回调签名 | 回调是 `handler(**kwargs)`（事件 dict 展开传入，无事件对象） | `def on_event(**kwargs)`；文本增量判别 `"delta" in kwargs and isinstance(data, str) and not kwargs.get("complete")` |

超时：`asyncio.timeout` 包 async 侧（工作线程不可强杀，自然结束无害）；busy：主循环 create_task 后继续 receive（不 await）。

## 验证结果

- 健康检查：无 env → 「未配置模型网关环境变量」；env 齐网关断 → 网关原因；全配 → 全绿 ✓
- 端到端（DeepSeek 网关真实模型）：「在 #2 下加子节点」→ 流式 delta 逐字回复 → `- [id:7] strands 内嵌验收` 真实落树 ✓
- 会话延续：第二轮「刚才那个节点」→ 正确锚定 #7，建 #8 ✓
- busy 拒绝 ✓；pytest 21 passed 无回归 ✓
