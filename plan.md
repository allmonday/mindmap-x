# 聊天侧边栏"清除 context"（归档历史）+ 收尾输入框高度

## Context

两个事项：

1. **新需求**：内嵌 strands Agent 每条消息都带全量历史发 LLM（`var/sessions/session_mindmap-map{N}/`），对话越长 token 越爆。需要 **clear 按钮**重置 context。用户明确要求：**clear 之前的内容不删除，作为历史 chat 保留、可点击查看**。即 clear = 归档当前对话 + Agent 从新 context 开始。
2. **在途收尾**：输入框自动增高剩一个 bug——空态 56px（占位符两行撑高 scrollHeight），修法已明确。

## Part A：收尾输入框高度（fe/src/ChatPanel.tsx）

autosize effect 加空态分支：`el.style.height = draft ? \`${Math.min(el.scrollHeight, 120)}px\` : '38px'`；占位符缩短为 `"输入指令，Enter 发送"`。

## Part B：清除 context + 历史归档

### 数据流

```
点 clear → WS {type:'clear'}
  服务端（非 busy）：
    1. 读当前历史 _history_payload(map_id)，非空则写归档文件
       var/chat_history/map{N}/chat_YYYYmmdd-HHMMSS.json  {"created_at","messages":[{role,text}]}
    2. 删除 strands 会话目录（_clear_session，即上一版方案的 delete_session + SessionException 兜底）
    3. 回 {"type":"cleared"}
  前端：setMessages([])，归档列表刷新
```

context 重置原理不变：strands `FileSessionManager` 目录删掉后，下次 `_run_agent` 从零载入；busy 拒绝逻辑不变（in-flight 删除会被工作线程落盘复活，busy 是 WS 连接局部变量，入口必须走 WS 消息）。

### 后端 `src/chat.py`

- `_ARCHIVE_DIR = os.getenv("CHAT_ARCHIVE_DIR", "var/chat_history")`，按 map 分目录
- `_archive_current(map_id)`：读 `_history_payload` → 非空则原子写 `chat_{timestamp}.json`（`datetime.now().strftime('%Y%m%d-%H%M%S')`）
- `_clear_session(map_id)`：`FileSessionManager(...).delete_session(...)`，捕获 `SessionException`
- WS 主循环加 `clear` 分支：busy → 回 `busy`；否则 `asyncio.to_thread(_archive_current + _clear_session)` → 回 `cleared`
- REST（沿用已有 `GET /api/chat/status` 的 router 模式）：
  - `GET /api/chat/archives?map_id=N` → `[{id, created_at, count, preview}]`（preview=首条用户消息截断）
  - `GET /api/chat/archives/{archive_id}?map_id=N` → `{id, created_at, messages:[{role,text}]}`
  - archive_id 校验 `^[A-Za-z0-9_-]+$` 防路径穿越；文件不存在的会话目录返回空列表

### 前端 `fe/src/ChatPanel.tsx`

- `ClearIcon`（橡皮擦 SVG）+ `HistoryIcon`（时钟 SVG），`chat-head` 关闭按钮左侧两个按钮：
  - **清除 context**：`disabled={busy || !connected}`，`title="清除 context（当前对话归档为历史，Agent 重新开始）"`，发 `{type:'clear'}`
  - **历史**：`title="查看历史对话"`，切换归档视图
- 视图状态 `view: 'chat' | 'archives' | 'archive'`（本地 state）：
  - `archives`：在 chat-list 区域渲染归档列表（时间 · N 条 · 预览），点击进入 `archive`
  - `archive`：只读气泡渲染该归档消息；头部出现"← 返回对话"
  - 视图非 `chat` 时隐藏输入行
- `onmessage` 加 `cleared` 分支：`setMessages([])`
- 归档数据用 fetch 直连 `/api/chat/archives...`（参考 `fe/src/api.ts` 的错误处理约定）

### 样式 `fe/src/App.css`

- `.chat-head .btn.icon { display: inline-flex; align-items: center; }`（SVG 居中）
- 归档列表条目样式（复用 slate 灰 + 圆角卡片语言）

### 文档

`specs/004-embedded-strands-agent/story.md` 追加变更记录：clear 归档协议、busy 拒绝原因、`var/chat_history/` 结构。

## 验证

**注意**：8740 的 uvicorn 未开 `--reload`，改 `src/chat.py` 后需重启才能生效。

1. `cd fe && npm run build`；重启 uvicorn
2. Part A：输入框高度矩阵（空/1 行/2 行/10 行 → 38/38/~58/120，按钮恒 38）
3. Part B（浏览器，map 1 有 26 条历史）：
   - 点清除 → 气泡清空；点"历史"→ 列表 1 条（26 条消息 + 预览）→ 点击可完整查看 → 返回当前对话
   - **刷新页面** → 历史列表仍在（服务端持久化）；当前对话为空
   - `ls var/chat_history/map1/` 有归档 JSON；`var/sessions/session_mindmap-map1` 已删
   - 清除后发新消息 → 正常回复（新 context）
   - busy 守卫：Agent 思考中点清除 → "稍后再清空"提示、历史不动
