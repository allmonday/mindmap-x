// 中/EN 切换器：两个拼合 pill，当前项高亮（复用 .btn / .btn.sm / .active 体系）
import { useI18n, type Lang } from './i18n'

const OPTIONS: { lang: Lang; label: string }[] = [
  { lang: 'zh', label: '中' },
  { lang: 'en', label: 'EN' },
]

export function LangSwitch() {
  const { lang, setLang } = useI18n()
  return (
    <div className="lang-switch" role="group" aria-label="语言 / Language">
      {OPTIONS.map((o) => (
        <button
          key={o.lang}
          type="button"
          className={`btn sm${lang === o.lang ? ' active' : ''}`}
          aria-pressed={lang === o.lang}
          onClick={() => setLang(o.lang)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
