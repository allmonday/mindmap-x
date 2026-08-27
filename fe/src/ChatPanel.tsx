import { useEffect, useRef, useState } from 'react'

interface ChatMsg {
  role: 'user' | 'agent'
  text: string
  streaming?: boolean
  error?: boolean
}

interface Props {
  mapId: number
  onClose: () => void
}

// 页内 Agent 对话面板：变更即时反馈由画布的 /ws 通道负责，这里只做对话文本。
export function ChatPanel({ mapId, onClose }: Props) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [healthErr, setHealthErr] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMessages([])
    setHealthErr(null)
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/chat/${mapId}`)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'status') {
        if (!msg.ok) setHealthErr(msg.reason ?? 'Agent 对话不可用')
        return
      }
      if (msg.type === 'history') {
        // 服务端持久化的历史对话（跨会话延续），一次性格式化为气泡
        setMessages(
          (msg.messages as { role: 'user' | 'agent'; text: string }[]).map((m) => ({
            role: m.role === 'user' ? ('user' as const) : ('agent' as const),
            text: m.text,
          })),
        )
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
    return () => ws.close()
  }, [mapId])

  // 流式追加时自动滚到底
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const disabled = !!healthErr || busy || !connected

  const send = () => {
    const text = draft.trim()
    if (!text || disabled) return
    setMessages((prev) => [...prev, { role: 'user', text }])
    setDraft('')
    setBusy(true)
    wsRef.current?.send(JSON.stringify({ type: 'user', text }))
  }

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <span className="chat-title">💬 Agent 对话</span>
        <span className={`ws-dot ${connected ? 'live' : 'dead'}`} />
        <span className="chat-sub">
          {healthErr ? '不可用' : busy ? '思考中…' : connected ? '就绪 · 它的操作会实时出现在画布上' : '连接中…'}
        </span>
        <div className="spacer" />
        <button className="btn icon" onClick={onClose} title="收起对话" aria-label="收起对话">▾</button>
      </div>

      {healthErr && <div className="chat-banner">{healthErr}</div>}

      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && !healthErr && (
          <div className="chat-empty">
            例如：「在 #2 下加一个子节点，内容是竞品分析」<br />
            节点编号见画布角标（#N），每张图从 1 开始。
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble-row ${m.role}`}>
            <div className={`bubble ${m.role} ${m.error ? 'err' : ''}`}>
              {m.text}
              {m.streaming && <span className="cursor">▍</span>}
            </div>
          </div>
        ))}
        {busy && messages[messages.length - 1]?.role !== 'agent' && (
          <div className="bubble-row agent">
            <div className="bubble agent thinking">…</div>
          </div>
        )}
      </div>

      <div className="chat-input-row">
        <textarea
          className="chat-input"
          value={draft}
          placeholder={healthErr ? 'Agent 对话不可用' : '输入指令，Enter 发送，Shift+Enter 换行'}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="btn primary" disabled={disabled} onClick={send}>发送</button>
      </div>
    </div>
  )
}
