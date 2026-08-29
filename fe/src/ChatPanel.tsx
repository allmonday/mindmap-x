import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { chatApi, gateReasonText, type ArchiveDoc, type ArchiveMeta } from './api'
import { fmtTime, useI18n } from './i18n'

interface ChatMsg {
  role: 'user' | 'agent'
  text: string
  thinking?: string // 推理模型的思考过程（可折叠展示，不回传 LLM）
  streaming?: boolean
  error?: boolean
}

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

const HistoryIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l3 2" />
  </svg>
)

// 页内 Agent 对话面板：变更即时反馈由画布的 /ws 通道负责，这里只做对话文本。
export function ChatPanel({ mapId, width, onResize, onClose }: Props) {
  const { t, locale } = useI18n()
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [healthErr, setHealthErr] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
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
    setView({ kind: 'chat' })
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'

    // 断线自动重连（指数退避 1s→8s 封顶，连上即复位）；重连后服务端会重推
    // status + history，本地消息自然重同步为服务端权威状态。
    let closed = false // 组件卸载/换图：停止重连
    let ws: WebSocket | null = null
    let timer: number | undefined
    let attempt = 0

    const connect = () => {
      if (closed) return
      ws = new WebSocket(`${proto}://${location.host}/chat/${mapId}`)
      wsRef.current = ws

      ws.onopen = () => {
        attempt = 0
        setConnected(true)
      }
      ws.onclose = () => {
        setConnected(false)
        setBusy(false) // 旧连接上在跑的一轮已不可达（done 发不到这里），解锁输入
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
        setHealthErr(
          msg.ok
            ? null
            : msg.reason_code
              ? gateReasonText(t, msg.reason_code, msg.reason_detail)
              : t('chat.unavailable'),
        )
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
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'agent') return [...prev.slice(0, -1), { ...last, streaming: false }]
          return prev
        })
        setBusy(false)
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
      }
    }

    return () => {
      closed = true
      window.clearTimeout(timer)
      ws?.close()
    }
  }, [mapId]) // eslint-disable-line react-hooks/exhaustive-deps -- view/loadArchives 只在 cleared 分支读取，避免重连循环

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

  // 气泡列表（当前对话与归档详情共用渲染）
  // agent 正常回复是 markdown；思考过程渲染为可折叠区域（流式思考时展开、
  // 正文开始后自动收起）；user 指令与错误消息保持纯文本（防误解析）
  const bubbles = (msgs: ChatMsg[], streaming = true) => (
    <>
      {msgs.map((m, i) => (
        <div key={i} className={`bubble-row ${m.role}`}>
          <div className={`bubble ${m.role} ${m.error ? 'err' : ''}`}>
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
                  <Markdown>{m.text}</Markdown>
                </div>
              ) : (
                m.text
              ))}
            {streaming && m.streaming && m.text && <span className="cursor">▍</span>}
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
              {healthErr ? t('chat.statusUnavailable') : busy ? t('chat.thinking') : connected ? t('chat.ready') : t('chat.connecting')}
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
        <button
          className={`btn icon ${view.kind !== 'chat' ? 'active' : ''}`}
          onClick={showArchives}
          title={view.kind === 'chat' ? t('chat.viewHistory') : t('chat.backToCurrent')}
          aria-label={t('chat.historyAria')}
        >
          <HistoryIcon />
        </button>
        <button className="btn icon" onClick={onClose} title={t('chat.close')} aria-label={t('chat.close')}>▸</button>
      </div>

      {healthErr && view.kind === 'chat' && <div className="chat-banner">{healthErr}</div>}

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
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <button className="btn chat-send" disabled={disabled} onClick={send} title={t('chat.send')} aria-label={t('chat.send')}>
            <SendIcon />
          </button>
        </div>
      )}
    </div>
  )
}
