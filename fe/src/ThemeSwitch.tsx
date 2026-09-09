// 主题切换器：三段拼合 pill（日/月/显示器图标，currentColor），
// 与 LangSwitch 同构（复用 .btn / .btn.sm / .active 体系 + .lang-switch 布局规则）。
// 三态是并列选择而非顺序偏好——pill 当前态一眼可辨、直达任意态
//（单按钮循环会藏起「跟随系统」且看不到当前态）。
import { useI18n } from './i18n'
import { useTheme, type Theme } from './theme'

// lucide sun / moon / monitor 同款线条
const SunIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
)

const MoonIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </svg>
)

const MonitorIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <path d="M12 17v4M8 21h8" />
  </svg>
)

export function ThemeSwitch() {
  const { t } = useI18n()
  const { theme, setTheme } = useTheme()
  const options: { theme: Theme; label: string; icon: React.ReactNode }[] = [
    { theme: 'light', label: t('theme.light'), icon: <SunIcon /> },
    { theme: 'dark', label: t('theme.dark'), icon: <MoonIcon /> },
    { theme: 'system', label: t('theme.system'), icon: <MonitorIcon /> },
  ]
  return (
    <div className="theme-switch" role="group" aria-label={t('theme.label')}>
      {options.map((o) => (
        <button
          key={o.theme}
          type="button"
          className={`btn sm${theme === o.theme ? ' active' : ''}`}
          title={o.label}
          aria-label={o.label}
          aria-pressed={theme === o.theme}
          onClick={() => setTheme(o.theme)}
        >
          {o.icon}
        </button>
      ))}
    </div>
  )
}
