import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { mdComponents } from './Mermaid'
import { chatApi, gateReasonText, localAgentApi, type ArchiveDoc, type ArchiveMeta, type ChatGateStatus } from './api'
import { fmtTime, useI18n } from './i18n'
import { ProviderConfigModal } from './ProviderConfigModal'

interface ChatMsg {
  role: 'user' | 'agent'
  text: string
  thinking?: string // 推理模型的思考过程（可折叠展示，不回传 LLM）
  streaming?: boolean
  error?: boolean
  interrupted?: boolean // 本轮被用户中断（done.interrupted），仅前端呈现
  tools?: ToolChip[] // 工具调用轨迹（本地 Claude Code 的 tool_use 事件，chip 展示）
}

interface ToolChip {
  name: string
  preview?: string
}

// Agent 形式：strands = 页内 SDK Agent；local = 服务端 spawn 的本机 Claude Code
type AgentKind = 'strands' | 'local'

interface Props {
  mapId: number
  width: number
  onResize: (w: number) => void
  onClose: () => void
}

// 三个视图：当前对话 / 归档列表 / 单个归档详情（只读）
type View = { kind: 'chat' } | { kind: 'archives' } | { kind: 'archive'; id: string }

// ── 图标（stroke 用 currentColor 继承按钮配色） ────────────────────────

const SendIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </svg>
)

const ClearIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
    <path d="M22 21H7" />
    <path d="m5 11 9 9" />
  </svg>
)

// 实心方块 = 停止（业界惯例，与发送箭头形成强对比）
const StopIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>
)

const HistoryIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l3 2" />
  </svg>
)

const GearIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </svg>
)

// 页内 Agent 对话面板：变更即时反馈由画布的 /ws 通道负责，这里只做对话文本。
export function ChatPanel({ mapId, width, onResize, onClose }: Props) {
  const { t, locale } = useI18n()
  // Agent 形式跨会话记忆；两套通道历史独立（strands 落盘 / local 服务端内存），
  // 切换时各自重连重推 history
  const [agent, setAgent] = useState<AgentKind>(
    () => (localStorage.getItem('chatAgent') as AgentKind) || 'strands',
  )
  useEffect(() => {
    localStorage.setItem('chatAgent', agent)
  }, [agent])
  // 本地 Claude Code 全局开关（LOCAL_AGENT_ENABLED，默认关）：关 = 隐藏形式
  // 切换条、localStorage 残留 'local' 回退 strands；探测失败也按关处理（入口
  // 不亮比误亮安全——打磨期特性宁可藏拙）
  const [localEnabled, setLocalEnabled] = useState(false)
  useEffect(() => {
    let alive = true
    localAgentApi
      .status()
      .then((s) => { if (alive) setLocalEnabled(s.enabled !== false) })
      .catch(() => { /* 网络异常：保持隐藏 */ })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (!localEnabled && agent === 'local') setAgent('strands')
  }, [localEnabled, agent])
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // 附着到"你不在时启动/继续的一轮"（服务端 resume 消息）：状态栏用专属文案
  // 区分于本轮发起的思考；done/error/断线时与 busy 一同复位
  const [resumed, setResumed] = useState(false)
  const [stopping, setStopping] = useState(false) // 已发 interrupt、等待 done（防重复点击）
  const [healthErr, setHealthErr] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  // 配置弹窗 + 配置保存后的强制重连轮次：健康检查在 WS 握手时跑，改完配置
  // 立即 bump 让 effect 重建连接（不等指数退避），服务端现读新配置即恢复
  const [cfgOpen, setCfgOpen] = useState(false)
  const [connEpoch, setConnEpoch] = useState(0)
  const [view, setView] = useState<View>({ kind: 'chat' })
  const [archives, setArchives] = useState<ArchiveMeta[]>([])
  const [archiveDoc, setArchiveDoc] = useState<ArchiveDoc | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // 输入框随内容自动增高（上限 120px 后改内部滚动）；发送后 draft 清空自动缩回。
  // 空态固定 38px：placeholder 在窄面板折两行会虚高 scrollHeight。
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = draft ? `${Math.min(el.scrollHeight, 120)}px` : '38px'
  }, [draft])

  useEffect(() => {
    setMessages([])
    setHealthErr(null)
    setBusy(false)
    setResumed(false)
    setStopping(false)
    setView({ kind: 'chat' })
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'

    // 断线自动重连（指数退避 1s→8s 封顶，连上即复位）；重连后服务端会重推
    // status + history，本地消息自然重同步为服务端权威状态。
    let closed = false // 组件卸载/换图：停止重连
    let ws: WebSocket | null = null
    let timer: number | undefined
    let heartbeat: number | undefined
    let attempt = 0
    // 断连观测：close 时经 sendBeacon 上报服务端落日志
    // （1000 正常关 / 1001 going away / 1006 网络异常——移动端问题的铁证）
    let lastClose: { code: number; reason: string } | null = null

    const connect = () => {
      if (closed) return
      // 两种 Agent 形式各自的通道：strands /chat（SDK 进程内）；
      // local /local-chat（服务端 spawn 本机 claude -p）
      const path = agent === 'local' ? `/local-chat/${mapId}` : `/chat/${mapId}`
      ws = new WebSocket(`${proto}://${location.host}${path}`)
      wsRef.current = ws

      ws.onopen = () => {
        attempt = 0
        setConnected(true)
        // 应用层心跳：局域网/移动网络路径上中间设备常不透传协议层 ping/pong，
        // 只对真实数据流量重置空闲计时——25s 一跳把空闲连接续命
        heartbeat = window.setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
        }, 25000)
      }
      ws.onclose = (ev: CloseEvent) => {
        setConnected(false)
        setBusy(false) // 旧连接上在跑的一轮已不可达（done 发不到这里），解锁输入
        setResumed(false)
        setStopping(false)
        window.clearInterval(heartbeat)
        if (!closed) {
          lastClose = { code: ev.code, reason: ev.reason }
          console.warn(`[chat-ws] closed: code=${ev.code} reason=${ev.reason || '(empty)'}`)
          // 立即走 HTTP 上报（不能搭 WS：重连失败循环里 WS 永远发不出去——
          // 恰是最需要观测的场景）；sendBeacon 页面卸载也能到达
          try {
            navigator.sendBeacon?.(
              '/api/ws-close-report',
              JSON.stringify({ channel: agent, map_id: mapId, ...lastClose }),
            )
          } catch {
            /* 观测性上报：失败即忽略 */
          }
        }
        if (closed) return
        const delay = Math.min(1000 * 2 ** attempt, 8000)
        attempt += 1
        timer = window.setTimeout(connect, delay)
      }
      ws.onmessage = onMessage
    }
    connect()

    function onMessage(e: MessageEvent) {
      const msg = JSON.parse(e.data)
      if (msg.type === 'status') {
        // 两套端点形状不同：strands {ok, reason_code…} / local {available, version}
        setHealthErr(
          agent === 'local'
            ? msg.available
              ? null
              : t('chat.localUnavailable')
            : msg.ok
              ? null
              : msg.reason_code
                ? gateReasonText(t, msg.reason_code, msg.reason_detail)
                : t('chat.unavailable'),
        )
        return
      }
      if (msg.type === 'tool') {
        // 本地 Claude Code 的工具调用（tool_use 块）：chip 追加到当前流式气泡
        const chip = { name: String(msg.name ?? '?'), preview: msg.input_preview }
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'agent' && last.streaming) {
            return [...prev.slice(0, -1), { ...last, tools: [...(last.tools ?? []), chip] }]
          }
          return [...prev, { role: 'agent' as const, text: '', tools: [chip], streaming: true }]
        })
        return
      }
      if (msg.type === 'history') {
        // 服务端持久化的历史对话（跨会话延续），一次性格式化为气泡
        setMessages(
          (msg.messages as { role: 'user' | 'agent'; text: string; thinking?: string }[]).map((m) => ({
            role: m.role === 'user' ? ('user' as const) : ('agent' as const),
            text: m.text,
            thinking: m.thinking,
          })),
        )
        return
      }
      if (msg.type === 'resume') {
        // 附着到在跑的一轮（切图回来/断线重连时服务端先发此标记再重放缓冲）：
        // busy 态让输入禁用、停止按钮出现，随后 delta/reasoning 续流照常追加
        setBusy(true)
        setResumed(true)
        return
      }
      if (msg.type === 'reasoning') {
        // 思考增量：累积到当前流式 agent 气泡的 thinking（推理模型先思考后作答）
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'agent' && last.streaming) {
            return [...prev.slice(0, -1), { ...last, thinking: (last.thinking ?? '') + msg.text }]
          }
          return [...prev, { role: 'agent' as const, text: '', thinking: msg.text, streaming: true }]
        })
        return
      }
      if (msg.type === 'cleared') {
        // context 已重置：当前对话归档为历史，列表可能多了一条
        setMessages([])
        if (view.kind === 'archives') void loadArchives()
        return
      }
      if (msg.type === 'delta') {
        // 增量追加到当前流式 agent 气泡（没有则开一个）
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'agent' && last.streaming) {
            return [...prev.slice(0, -1), { ...last, text: last.text + msg.text }]
          }
          return [...prev, { role: 'agent', text: msg.text, streaming: true }]
        })
      } else if (msg.type === 'done') {
        const wasInterrupted = !!msg.interrupted
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'agent')
            return [
              ...prev.slice(0, -1),
              { ...last, streaming: false, interrupted: wasInterrupted || last.interrupted },
            ]
          // 首字节前被中断（无流式气泡）：开一个只挂标记的空气泡
          if (wasInterrupted) return [...prev, { role: 'agent' as const, text: '', interrupted: true }]
          return prev
        })
        setBusy(false)
        setResumed(false)
        setStopping(false)
      } else if (msg.type === 'busy') {
        setMessages((prev) => [...prev, { role: 'agent', text: msg.message, error: true }])
      } else if (msg.type === 'error') {
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          // 流式中途失败：落在当前气泡；未开始：开新气泡
          if (last?.role === 'agent' && last.streaming) {
            return [...prev.slice(0, -1), { ...last, text: msg.message, streaming: false, error: true }]
          }
          return [...prev, { role: 'agent', text: msg.message, error: true }]
        })
        setBusy(false)
        setResumed(false)
        setStopping(false) // 超时/异常与中断竞态时也要复位，防停止按钮卡死
      }
    }

    return () => {
      closed = true
      window.clearTimeout(timer)
      window.clearInterval(heartbeat)
      if (ws) {
        // 摘掉旧连接全部回调再关闭：close() 是异步握手，close 事件可能晚于
        // 新连接的 onopen 到达（移动端网络慢/键盘扰动时必现）——僵尸 onclose
        // 会把新连接刚置好的 connected 打成 false，且再无事件能拉回（卡死
        // "连接中"）。解绑后旧连接静默终结，UI 状态完全由新 effect 驱动
        ws.onopen = null
        ws.onmessage = null
        ws.onclose = null
        ws.onerror = null
        ws.close()
      }
    }
  }, [mapId, agent, connEpoch]) // eslint-disable-line react-hooks/exhaustive-deps -- view/loadArchives 只在 cleared 分支读取，避免重连循环

  // 流式追加时自动滚到底
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  // ── 归档视图 ─────────────────────────────────────────────────────────
  const loadArchives = async () => {
    try {
      setArchives(await chatApi.archives(mapId))
    } catch {
      /* 网络异常时保留现有列表 */
    }
  }

  const openArchive = async (id: string) => {
    try {
      setArchiveDoc(await chatApi.archive(mapId, id))
      setView({ kind: 'archive', id })
    } catch {
      /* 单个归档读取失败：留在列表 */
    }
  }

  const showArchives = () => {
    if (view.kind === 'chat') {
      setArchiveDoc(null)
      void loadArchives()
      setView({ kind: 'archives' })
    } else {
      setView({ kind: 'chat' })
    }
  }

  const clearContext = () => wsRef.current?.send(JSON.stringify({ type: 'clear' }))

  const disabled = !!healthErr || busy || !connected

  const send = () => {
    const text = draft.trim()
    if (!text || disabled) return
    setMessages((prev) => [...prev, { role: 'user', text }])
    setDraft('')
    setBusy(true)
    wsRef.current?.send(JSON.stringify({ type: 'user', text }))
  }

  // 停止：服务端在下一取消检查点截断（通常亚秒级，最坏 = 当前 LLM 请求
  // 首字节），结果由 done.interrupted 表达；这里本地置 stopping 防重复点击
  const stop = () => {
    if (!busy || stopping) return
    setStopping(true)
    wsRef.current?.send(JSON.stringify({ type: 'interrupt' }))
  }

  // 气泡列表（当前对话与归档详情共用渲染）
  // agent 正常回复是 markdown；思考过程渲染为可折叠区域（流式思考时展开、
  // 正文开始后自动收起）；user 指令与错误消息保持纯文本（防误解析）
  const bubbles = (msgs: ChatMsg[], streaming = true) => (
    <>
      {msgs.map((m, i) => (
        <div key={i} className={`bubble-row ${m.role}`}>
          <div className={`bubble ${m.role} ${m.error ? 'err' : ''}`}>
            {m.tools && m.tools.length > 0 && (
              // 工具调用轨迹（本地 Claude Code）：名字做 chip，悬浮看入参预览
              <div className="chat-tools">
                {m.tools.map((tool, j) => (
                  <span
                    key={j}
                    className="chat-tool-chip"
                    title={tool.preview || undefined}
                  >
                    ⚙ {tool.name.replace(/^mcp__mindmap__/, '')}
                  </span>
                ))}
              </div>
            )}
            {m.thinking && (
              <details className="thinking" open={streaming && m.streaming && !m.text}>
                <summary>{t('chat.thinkingProcess')}</summary>
                <div className="thinking-body">
                  {m.thinking}
                  {streaming && m.streaming && !m.text && <span className="cursor">▍</span>}
                </div>
              </details>
            )}
            {m.text &&
              (m.role === 'agent' && !m.error ? (
                <div className="md">
                  <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{m.text}</Markdown>
                </div>
              ) : (
                m.text
              ))}
            {streaming && m.streaming && m.text && <span className="cursor">▍</span>}
            {m.interrupted && <div className="interrupted-note">{t('chat.interrupted')}</div>}
          </div>
        </div>
      ))}
    </>
  )

  return (
    <div className="chat-panel" style={{ width }}>
      {/* 左缘拖拽调宽：面板贴右缘，鼠标左移宽度增大（280px ~ min(90vw, 760px)） */}
      <div
        className="chat-resize"
        onMouseDown={(e) => {
          e.preventDefault()
          const startX = e.clientX
          const startW = width
          const onMove = (ev: MouseEvent) =>
            onResize(Math.min(Math.max(startW + startX - ev.clientX, 280), Math.min(window.innerWidth * 0.9, 760)))
          const onUp = () => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            document.body.classList.remove('chat-resizing')
          }
          document.body.classList.add('chat-resizing')
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
        }}
      />
      <div className="chat-head">
        {view.kind === 'chat' ? (
          <>
            <span className="chat-title">{t('chat.title')}</span>
            <span className={`ws-dot ${connected ? 'live' : 'dead'}`} />
            <span className="chat-sub">
              {healthErr
                ? t('chat.statusUnavailable')
                : busy
                  ? stopping
                    ? t('chat.stopping')
                    : resumed
                      ? t('chat.resumed')
                      : t('chat.thinking')
                  : connected
                    ? t('chat.ready')
                    : t('chat.connecting')}
            </span>
          </>
        ) : (
          <>
            <button className="btn icon" onClick={() => setView({ kind: 'chat' })} title={t('chat.backToChat')} aria-label={t('chat.backToChat')}>←</button>
            <span className="chat-title">{view.kind === 'archives' ? t('chat.history') : t('chat.records')}</span>
            {view.kind === 'archive' && (
              <span className="chat-sub">
                {archiveDoc ? fmtTime(archiveDoc.created_at, locale) : ''}
              </span>
            )}
          </>
        )}
        <div className="spacer" />
        {view.kind === 'chat' && (
          <button
            className="btn icon"
            disabled={busy || !connected}
            onClick={clearContext}
            title={t('chat.clearContext')}
            aria-label={t('chat.clearContextAria')}
          >
            <ClearIcon />
          </button>
        )}
        {/* 归档是 strands 会话的功能（local 通道内存历史，无归档落盘） */}
        {agent === 'strands' && (
          <button
            className={`btn icon ${view.kind !== 'chat' ? 'active' : ''}`}
            onClick={showArchives}
            title={view.kind === 'chat' ? t('chat.viewHistory') : t('chat.backToCurrent')}
            aria-label={t('chat.historyAria')}
          >
            <HistoryIcon />
          </button>
        )}
        {/* 模型网关配置（仅 strands 通道走 provider 配置；local 是本机 claude） */}
        {agent === 'strands' && (
          <button
            className="btn icon"
            onClick={() => setCfgOpen(true)}
            title={t('chat.providerSettings')}
            aria-label={t('chat.providerSettings')}
          >
            <GearIcon />
          </button>
        )}
        <button className="btn icon" onClick={onClose} title={t('chat.close')} aria-label={t('chat.close')}>▸</button>
      </div>

      {healthErr && view.kind === 'chat' && (
        <div className="chat-banner">
          {healthErr}
          {agent === 'strands' && (
            <button className="btn sm banner-action" onClick={() => setCfgOpen(true)}>
              {t('chat.providerSettings')}
            </button>
          )}
        </div>
      )}

      {view.kind === 'chat' && (
        <div className="chat-list" ref={listRef}>
          {messages.length === 0 && !healthErr && (
            <div className="chat-empty">
              {t('chat.empty1')}<br />
              {t('chat.empty2')}
            </div>
          )}
          {bubbles(messages)}
          {busy && messages[messages.length - 1]?.role !== 'agent' && (
            <div className="bubble-row agent">
              <div className="bubble agent thinking">…</div>
            </div>
          )}
        </div>
      )}

      {view.kind === 'archives' && (
        <div className="chat-list">
          {archives.length === 0 && (
            <div className="chat-empty">
              {t('chat.archiveEmpty1')}<br />
              {t('chat.archiveEmpty2')}
            </div>
          )}
          {archives.map((a) => (
            <button key={a.id} className="archive-item" onClick={() => void openArchive(a.id)}>
              <span className="archive-preview" title={a.preview || undefined}>{a.preview || t('chat.noPreview')}</span>
              <span className="archive-meta">
                {t('chat.archiveMeta', {
                  time: fmtTime(a.created_at, locale),
                  count: a.count,
                })}
              </span>
            </button>
          ))}
        </div>
      )}

      {view.kind === 'archive' && (
        <div className="chat-list">
          <button className="btn sm archive-back" onClick={() => setView({ kind: 'archives' })}>← {t('common.backToList')}</button>
          {archiveDoc &&
            bubbles(
              archiveDoc.messages.map((m) => ({
                role: m.role === 'user' ? ('user' as const) : ('agent' as const),
                text: m.text,
                thinking: m.thinking,
              })),
              false, // 归档是只读记录，不渲染流式光标
            )}
        </div>
      )}

      {view.kind === 'chat' && (
        <>
        {/* Agent 形式切换：strands（页内 SDK）/ Claude Code（本机 spawn）。
            放输入区上方——"你正在跟谁说话"的语义在这里最直观。
            localEnabled=false（全局开关关/探测失败）整条隐藏，只留 strands */}
        {localEnabled && (
        <div className="chat-agent-bar">
          <div className="seg" role="group" aria-label={t('chat.agentSelect')}>
            <button
              className={`btn sm${agent === 'strands' ? ' active' : ''}`}
              aria-pressed={agent === 'strands'}
              onClick={() => setAgent('strands')}
            >
              {t('chat.agentStrands')}
            </button>
            <button
              className={`btn sm${agent === 'local' ? ' active' : ''}`}
              aria-pressed={agent === 'local'}
              onClick={() => setAgent('local')}
            >
              {t('chat.agentLocal')}
            </button>
          </div>
          {agent === 'local' && <span className="chat-agent-hint">{t('chat.localHint')}</span>}
        </div>
        )}
        <div className="chat-input-row">
          <textarea
            className="chat-input"
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder={healthErr ? t('chat.unavailable') : t('chat.inputPlaceholder')}
            title={t('chat.sendTitle')}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // 事件层隔离（同备注 textarea 的做法）：不冒泡到 window 的全局
              // 快捷键——activeElement 推断在 disabled 丢焦点等场景不可靠
              e.stopPropagation()
              // IME 组词中的 Enter（含 Shift）是选词不是发送（与 rf-editor 同款判定）
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
          {/* busy 时变形为停止按钮：中断在跑的一轮（interrupt WS 消息） */}
          {busy ? (
            <button
              className="btn chat-send stop"
              disabled={stopping}
              onClick={stop}
              title={stopping ? t('chat.stopping') : t('chat.stop')}
              aria-label={stopping ? t('chat.stopping') : t('chat.stop')}
            >
              <StopIcon />
            </button>
          ) : (
            <button className="btn chat-send" disabled={disabled} onClick={send} title={t('chat.send')} aria-label={t('chat.send')}>
              <SendIcon />
            </button>
          )}
        </div>
        </>
      )}

      {/* 模型网关配置（齿轮入口）：保存成功 → 立即重连（服务端 WS 握手时现读新
          配置跑 health_check），错误横幅随新连接的 status 消息自然清除/更新 */}
      {cfgOpen && (
        <ProviderConfigModal
          onClose={() => setCfgOpen(false)}
          onSaved={(s: ChatGateStatus) => {
            setHealthErr(
              s.ok
                ? null
                : s.reason_code
                  ? gateReasonText(t, s.reason_code, s.reason_detail)
                  : t('chat.unavailable'),
            )
            setConnEpoch((e) => e + 1)
            if (s.ok) setCfgOpen(false)
          }}
        />
      )}
    </div>
  )
}
