// 交互指南侧边栏：编辑器左侧滑出，列出长按/拖拽语义/快捷键等隐性交互。
// 内容从 MindMapEditor 的实现整理（改交互时记得同步这里）；文案走 i18n
// 双语。按键用 kbd 标记（不进 i18n——Tab/Enter 等无需翻译）
import { useI18n, type I18nKey } from './i18n'

/** 问号图标（lucide circle-help 同款：圆 + 问号） */
const HelpIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <path d="M12 17h.01" />
  </svg>
)

type HelpItem = { keys?: string[]; label: I18nKey; desc: I18nKey }

function HelpPanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()

  const sections: { title: I18nKey; items: HelpItem[] }[] = [
    {
      title: 'help.secNode',
      items: [
        { label: 'help.click', desc: 'help.clickD' },
        { keys: ['F2', 'Ctrl+Enter'], label: 'help.dblclick', desc: 'help.dblclickD' },
        { label: 'help.contextMenu', desc: 'help.contextMenuD' },
        { label: 'help.hold', desc: 'help.holdD' },
        { label: 'help.dragPick', desc: 'help.dragPickD' },
        { label: 'help.dragOn', desc: 'help.dragOnD' },
        { label: 'help.dragGap', desc: 'help.dragGapD' },
        { label: 'help.dragBlank', desc: 'help.dragBlankD' },
        { label: 'help.dragSub', desc: 'help.dragSubD' },
        { label: 'help.foldDot', desc: 'help.foldDotD' },
      ],
    },
    {
      title: 'help.secAdd',
      items: [
        { keys: ['Tab'], label: 'help.addTab', desc: 'help.addTabD' },
        { keys: ['Enter'], label: 'help.addSib', desc: 'help.addSibD' },
        { label: 'help.inputKeys', desc: 'help.inputKeysD' },
        { keys: ['Delete'], label: 'help.del', desc: 'help.delD' },
      ],
    },
    {
      title: 'help.secNav',
      items: [
        { keys: ['↑', '↓'], label: 'help.navV', desc: 'help.navVD' },
        { keys: ['←', '→'], label: 'help.navH', desc: 'help.navHD' },
        { keys: ['Ctrl+P'], label: 'help.goto', desc: 'help.gotoD' },
        { keys: ['Esc'], label: 'help.esc', desc: 'help.escD' },
      ],
    },
    {
      title: 'help.secView',
      items: [
        { keys: ['d'], label: 'help.note', desc: 'help.noteD' },
        { label: 'help.crumb', desc: 'help.crumbD' },
        { label: 'help.focus', desc: 'help.focusD' },
        { label: 'help.tools', desc: 'help.toolsD' },
        { label: 'help.theme', desc: 'help.themeD' },
        { label: 'help.foldSync', desc: 'help.foldSyncD' },
        { label: 'help.chat', desc: 'help.chatD' },
      ],
    },
  ]

  return (
    <div className="help-panel" role="dialog" aria-label={t('help.title')}>
      <div className="help-head">
        <span className="help-title">{t('help.title')}</span>
        <div className="spacer" />
        <button className="btn icon" onClick={onClose} title={t('help.close')} aria-label={t('help.close')}>
          ✕
        </button>
      </div>
      <div className="help-body">
        {sections.map((s) => (
          <section key={s.title}>
            <h4>{t(s.title)}</h4>
            {s.items.map((it) => (
              <div className="help-item" key={it.label}>
                <div className="help-item-head">
                  {it.keys?.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                  <span className="help-item-label">{t(it.label)}</span>
                </div>
                <div className="help-item-desc">{t(it.desc)}</div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}

export { HelpIcon, HelpPanel }
