// 自包含轻量 i18n：LangContext + Provider + useI18n。
// 不引依赖（69 key × 2 语言，react-i18next 过重）。
// key 按语义分组（ws.* / node.* / fold.* …）；t(key, params?) 支持 {name} 插值。
// zh 用 as const 提供 key 字面量联合，en 声明为 Record<I18nKey, string>：
// 缺 key / 多 key 都是编译错误（tsc 即校验，天然防漏译）。
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export type Lang = 'zh' | 'en'
const STORAGE_KEY = 'lang'

const zh = {
  // ── common ──
  'common.loading': '加载中…',
  'common.back': '返回',
  'common.backToList': '返回列表',
  'common.apply': '应用',
  'common.cancel': '取消',
  // ── 列表页 ──
  'map.placeholder': '新脑图标题…',
  'map.searchPlaceholder': '搜索脑图…',
  'map.newCard': '新建',
  'map.deleteConfirm': '确认删除',
  'map.deleteThis': '删除此脑图',
  'map.deleteAria': '删除 {title}',
  'map.empty': '还没有脑图，先创建一张。',
  // ── ws 状态 ──
  'ws.sync': '实时同步: {state}',
  'ws.live': '实时',
  'ws.connecting': '连接中',
  'ws.dead': '已断开',
  // ── 编辑器 ──
  'editor.agentChat': 'Agent 对话',
  'editor.nodeNote': '节点备注（d）',
  'editor.outlineEdit': 'outline 编辑',
  'editor.backToFull': '返回全图',
  'editor.focusTo': '聚焦到「{content}」',
  'editor.expandAll': '展开所有节点',
  'crumb.siblingsAria': '同级节点快速导航',
  // ── 布局切换 ──
  'layout.balanced.title': '当前：左右对称，点击切换为一律靠右',
  'layout.balanced.aria': '布局：左右对称',
  'layout.right.title': '当前：一律靠右，点击切换为左右对称',
  'layout.right.aria': '布局：一律靠右',
  // ── 层级刻度条（2 3 … N 全）──
  'fold.hint': '折叠到指定层级：保留前 N 层可见，更深层收起',
  'fold.toLevel': '折叠至 {lv} 层',
  'fold.allLabel': '全',
  // ── outline 弹层 ──
  'outline.title': 'outline 编辑（与 Agent 同协议：`- [id:N] 内容`，2 空格缩进一级）',
  'outline.merge': 'merge（锚定更新 + 新建，未提及保留）',
  'outline.replace': 'replace（保留根，其余全删重建）',
  // ── 节点（MindNodeView 内 + addChild 默认名）──
  'node.saveTitle': '保存（Enter）',
  'node.saveAria': '保存',
  'node.addTitle': '加子级（Tab）',
  'node.addAria': '加子级',
  'node.addNoteTitle': '添加备注',
  'node.focusTitle': '聚焦：只看此节点的子树（Esc / 点面包屑根节点退出）',
  'node.focusAria': '聚焦',
  'node.deleteTitle': '删除（Delete）',
  'node.deleteAria': '删除',
  'node.deleteConfirm': '再点一次确认删除子树',
  'node.deleteConfirmBtn': '确认删除？',
  'node.expand': '展开',
  'node.collapse': '折叠',
  'node.addPlaceholder': '子节点内容…',
  'node.addSiblingPlaceholder': '同级节点内容…',
  // ── 聊天面板 ──
  'chat.title': '💬 Agent 对话',
  'chat.unavailable': 'Agent 对话不可用',
  'chat.gatedTitle': 'Agent 对话未配置',
  'chat.gatedBody': '配置模型网关后即可使用：在 .env（或容器环境变量）中设置下面三个变量后重启服务，示例见 .env.example。',
  'chat.gatedBodyDesktop': '配置模型网关后即可使用：在数据目录创建 .env（~/Library/Application Support/MindMapX/.env），设置下面三个变量后重启应用。',
  // 健康检查失败原因（reason_code → 文案，参数由服务端 reason_detail 插值）
  'chat.gate.envMissing': '未配置模型网关环境变量: {missing}（OpenAI 兼容网关三项，见 README）',
  'chat.gate.gatewayHttp': '模型网关返回 HTTP {status}（检查 OPENAI_BASE_URL / OPENAI_API_KEY）',
  'chat.gate.gatewayUnreachable': '模型网关不可达（{error}）——检查 OPENAI_BASE_URL: {base}',
  'chat.gate.mcpHttp': 'MCP 端点返回 HTTP {status}',
  'chat.gate.mcpUnreachable': 'MCP 服务不可达: {error}',
  'chat.statusUnavailable': '不可用',
  'chat.thinking': '思考中…',
  'chat.ready': '就绪 · 它的操作会实时出现在画布上',
  'chat.connecting': '连接中…',
  'chat.thinkingProcess': '💭 思考过程',
  'chat.backToChat': '返回对话',
  'chat.history': '🕘 历史对话',
  'chat.records': '🕘 对话记录',
  'chat.clearContext': '清除 context（当前对话归档为历史，Agent 重新开始）',
  'chat.clearContextAria': '清除 context',
  'chat.viewHistory': '查看历史对话',
  'chat.backToCurrent': '回到当前对话',
  'chat.historyAria': '历史对话',
  'chat.close': '收起对话',

  // ── 节点备注面板（DetailPanel） ──
  'note.title': '节点备注',
  'note.viewMode': '备注视图切换',
  'note.noneSelected': '点击画布上的节点查看它的备注',
  'note.empty': '此节点还没有备注',
  'note.emptyHint': '把长内容放进备注（markdown），让节点标题保持简短',
  'note.add': '添加备注',
  'note.preview': '预览',
  'note.source': '源码',
  'note.save': '保存',
  'note.saveHint': 'Ctrl+Enter 快捷保存',
  'note.saving': '保存中…',
  'note.saved': '已保存',
  'note.close': '收起备注',
  'note.pin': '固定面板（点其他节点不收起）',
  'note.unpin': '取消固定',
  'note.markTitle': '查看备注',
  'chat.empty1': '例如：「在 #2 下加一个子节点，内容是竞品分析」',
  'chat.empty2': '节点编号见画布角标（#N），每张图从 1 开始。',
  'chat.archiveEmpty1': '还没有历史对话',
  'chat.archiveEmpty2': '点上方橡皮擦，把当前对话归档、让 Agent 重新开始。',
  'chat.noPreview': '（无预览）',
  'chat.archiveMeta': '{time} · {count} 条',
  'chat.inputPlaceholder': '输入指令，Enter 发送',
  'chat.sendTitle': 'Enter 发送 · Shift+Enter 换行',
  'chat.send': '发送',
  'chat.stop': '停止',
  'chat.stopping': '正在停止…',
  'chat.interrupted': '⏹ 已中断',
  // ── 版本历史（快照/时间线/回滚） ──
  'rev.open': '查看版本历史（时间线与回滚）',
  'rev.title': '版本历史',
  'rev.current': '当前',
  'rev.loading': '加载版本中…',
  'rev.empty': '还没有历史版本（下一次修改会产生第一个快照）',
  'rev.selectHint': '选择左侧版本查看它的变更与完整内容',
  'rev.restore': '回滚到此版本',
  'rev.restoreConfirm': '确认回滚？将新建版本，历史不丢失',
  'rev.restoring': '回滚中…',
  'rev.cannotRestoreCurrent': '已是当前版本',
  'rev.diffTitle': 'v{version} 的变更（相对上一版本）',
  'rev.diffEmpty': '此版本与上一版本无差异',
  'rev.added': '新增',
  'rev.removed': '删除',
  'rev.note': '备注变更',
  'rev.changed': '内容变更',
  'rev.moved': '移动/重排',
  'rev.folded': '折叠状态变更',
  'rev.titleChanged': '标题变更',
  'rev.tabDiff': '差异',
  'rev.tabPreview': '预览',
  'rev.action.map_created': '创建脑图',
  'rev.action.node_added': '新增节点',
  'rev.action.node_updated': '更新节点',
  'rev.action.node_moved': '移动节点',
  'rev.action.node_deleted': '删除节点',
  'rev.action.expanded_all': '全部展开',
  'rev.action.folded_to_level': '按层折叠',
  'rev.action.outline_applied': 'outline 写入',
  'rev.action.revision_restored': '版本回滚',
} as const

export type I18nKey = keyof typeof zh

const en: Record<I18nKey, string> = {
  'common.loading': 'Loading…',
  'common.back': 'Back',
  'common.backToList': 'Back to list',
  'common.apply': 'Apply',
  'common.cancel': 'Cancel',
  'map.placeholder': 'New map title…',
  'map.searchPlaceholder': 'Search maps…',
  'map.newCard': 'New',
  'map.deleteConfirm': 'Confirm delete',
  'map.deleteThis': 'Delete this map',
  'map.deleteAria': 'Delete {title}',
  'map.empty': 'No maps yet — create one.',
  'ws.sync': 'Live sync: {state}',
  'ws.live': 'Live',
  'ws.connecting': 'Connecting',
  'ws.dead': 'Disconnected',
  'editor.agentChat': 'Agent chat',
  'editor.nodeNote': 'Node notes (d)',
  'editor.outlineEdit': 'Outline edit',
  'editor.backToFull': 'Back to full map',
  'editor.focusTo': 'Focus on "{content}"',
  'editor.expandAll': 'Expand all nodes',
  'crumb.siblingsAria': 'Quick navigation to sibling nodes',
  'layout.balanced.title': 'Current: balanced — click for right-aligned',
  'layout.balanced.aria': 'Layout: balanced',
  'layout.right.title': 'Current: right-aligned — click for balanced',
  'layout.right.aria': 'Layout: right-aligned',
  'fold.hint': 'Fold to level: keep the first N levels visible, deeper collapsed',
  'fold.toLevel': 'Fold to level {lv}',
  'fold.allLabel': 'All',
  'outline.title': 'Outline edit (same protocol as Agent: `- [id:N] content`, 2-space indent per level)',
  'outline.merge': 'merge (anchor updates + creates, unmentioned kept)',
  'outline.replace': 'replace (keep root, delete & rebuild the rest)',
  'node.saveTitle': 'Save (Enter)',
  'node.saveAria': 'Save',
  'node.addTitle': 'Add child (Tab)',
  'node.addAria': 'Add child',
  'node.addNoteTitle': 'Add note',
  'node.focusTitle': 'Focus: view this subtree only (Esc or breadcrumb root to exit)',
  'node.focusAria': 'Focus',
  'node.deleteTitle': 'Delete (Delete key)',
  'node.deleteAria': 'Delete',
  'node.deleteConfirm': 'Click again to delete the subtree',
  'node.deleteConfirmBtn': 'Sure?',
  'node.expand': 'Expand',
  'node.collapse': 'Collapse',
  'node.addPlaceholder': 'Child content…',
  'node.addSiblingPlaceholder': 'Sibling content…',
  'chat.title': '💬 Agent chat',
  'chat.unavailable': 'Agent chat unavailable',
  'chat.gatedTitle': 'Agent chat not configured',
  'chat.gatedBody': 'Set these three variables in .env (or container environment) and restart the service — see .env.example:',
  'chat.gatedBodyDesktop': 'Create .env in the app data directory (~/Library/Application Support/MindMapX/.env) with these three variables, then restart the app:',
  'chat.gate.envMissing': 'Model gateway env vars missing: {missing} (the three OpenAI-compatible vars, see README)',
  'chat.gate.gatewayHttp': 'Model gateway returned HTTP {status} (check OPENAI_BASE_URL / OPENAI_API_KEY)',
  'chat.gate.gatewayUnreachable': 'Model gateway unreachable ({error}) — check OPENAI_BASE_URL: {base}',
  'chat.gate.mcpHttp': 'MCP endpoint returned HTTP {status}',
  'chat.gate.mcpUnreachable': 'MCP service unreachable: {error}',
  'chat.statusUnavailable': 'Unavailable',
  'chat.thinking': 'Thinking…',
  'chat.ready': 'Ready · its changes appear on the canvas live',
  'chat.connecting': 'Connecting…',
  'chat.thinkingProcess': '💭 Thinking',
  'chat.backToChat': 'Back to chat',
  'chat.history': '🕘 History',
  'chat.records': '🕘 Conversation',
  'chat.clearContext': 'Clear context (archives current chat, agent restarts)',
  'chat.clearContextAria': 'Clear context',
  'chat.viewHistory': 'View chat history',
  'chat.backToCurrent': 'Back to current chat',
  'chat.historyAria': 'Chat history',
  'chat.close': 'Hide chat',

  // ── 节点备注面板（DetailPanel） ──
  'note.title': 'Node note',
  'note.viewMode': 'Note view mode',
  'note.noneSelected': 'Click a node to read its note',
  'note.empty': 'No note yet',
  'note.emptyHint': 'Put long-form content here (markdown); keep titles short',
  'note.add': 'Add note',
  'note.preview': 'Preview',
  'note.source': 'Source',
  'note.save': 'Save',
  'note.saveHint': 'Save with Ctrl+Enter',
  'note.saving': 'Saving…',
  'note.saved': 'Saved',
  'note.close': 'Hide note',
  'note.pin': 'Pin panel (stays when selecting other nodes)',
  'note.unpin': 'Unpin',
  'note.markTitle': 'View note',
  'chat.empty1': 'e.g. "Add a child under #2 with content: competitive analysis"',
  'chat.empty2': 'Node IDs are the canvas badges (#N), starting from 1 per map.',
  'chat.archiveEmpty1': 'No chat history yet',
  'chat.archiveEmpty2': 'Click the eraser above to archive the current chat and restart the agent.',
  'chat.noPreview': '(no preview)',
  'chat.archiveMeta': '{time} · {count} msgs',
  'chat.inputPlaceholder': 'Type a command, Enter to send',
  'chat.sendTitle': 'Enter to send · Shift+Enter for newline',
  'chat.send': 'Send',
  'chat.stop': 'Stop',
  'chat.stopping': 'Stopping…',
  'chat.interrupted': '⏹ Interrupted',
  'rev.open': 'Version history (timeline & restore)',
  'rev.title': 'Version history',
  'rev.current': 'current',
  'rev.loading': 'Loading revisions…',
  'rev.empty': 'No revisions yet — the next change creates the first snapshot',
  'rev.selectHint': 'Select a version to see its changes and full content',
  'rev.restore': 'Restore this version',
  'rev.restoreConfirm': 'Confirm restore? Creates a new version; history is kept',
  'rev.restoring': 'Restoring…',
  'rev.cannotRestoreCurrent': 'Already the current version',
  'rev.diffTitle': 'Changes in v{version} (vs previous)',
  'rev.diffEmpty': 'No changes from the previous version',
  'rev.added': 'Added',
  'rev.removed': 'Removed',
  'rev.note': 'Note',
  'rev.changed': 'Changed',
  'rev.moved': 'Moved/reordered',
  'rev.folded': 'Fold state changed',
  'rev.titleChanged': 'Title changed',
  'rev.tabDiff': 'Diff',
  'rev.tabPreview': 'Preview',
  'rev.action.map_created': 'Create map',
  'rev.action.node_added': 'Add node',
  'rev.action.node_updated': 'Update node',
  'rev.action.node_moved': 'Move node',
  'rev.action.node_deleted': 'Delete node',
  'rev.action.expanded_all': 'Expand all',
  'rev.action.folded_to_level': 'Fold to level',
  'rev.action.outline_applied': 'Outline apply',
  'rev.action.revision_restored': 'Restore',
}

const dicts: Record<Lang, Record<I18nKey, string>> = { zh, en }

// 仅用于日期格式化（toLocaleString）；文案不走 Intl
const LOCALES: Record<Lang, string> = { zh: 'zh-CN', en: 'en-US' }

// 服务端时间一律 UTC，但 SQLite 的 DateTime 读回丢 tzinfo → REST 返回无 offset 的裸 ISO，
// JS 会把无时区串按本地时间解析（等于把 UTC 当本地直接显示，差一个时区）。
// 这里统一：无 offset 视为 UTC 补 'Z' 再格式化；带 offset/Z 的原样解析。全 UI 共用。
export function fmtTime(iso: string, locale: string): string {
  if (!iso) return ''
  const s = /[Zz]$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`
  return new Date(s).toLocaleString(locale, { hour12: false })
}

// localStorage（显式选择优先）→ navigator.language（zh* → zh，en* → en）→ 'zh' 兜底
const detectLang = (): Lang => {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === 'zh' || saved === 'en') return saved
  const nav = navigator.language?.toLowerCase() ?? ''
  return nav.startsWith('zh') ? 'zh' : nav.startsWith('en') ? 'en' : 'zh'
}

interface I18n {
  lang: Lang
  setLang: (l: Lang) => void
  locale: string
  t: (key: I18nKey, params?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18n | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(detectLang)

  // 持久化 + <html lang> 同步（挂载时也执行一次，覆盖 index.html 的静态值）
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, lang)
    document.documentElement.lang = lang
  }, [lang])

  const t = useCallback(
    (key: I18nKey, params?: Record<string, string | number>) => {
      let s = dicts[lang][key] ?? key // 未知 key 原样显示，肉眼可辨
      if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v))
      return s
    },
    [lang],
  )

  return <I18nContext.Provider value={{ lang, setLang, locale: LOCALES[lang], t }}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within <I18nProvider>') // 忘接 Provider 直接炸，不静默
  return ctx
}
