// 自包含主题：ThemeContext + Provider + useTheme（照 i18n.tsx 同款模式）。
// 三态存储（light/dark/system），resolved = 实际生效值（恒 'light' | 'dark'），
// 挂在 <html data-theme> 上驱动 CSS 变量覆盖层（index.css）。
// 首帧的 data-theme 由 index.html 内联脚本设置（防 FOUC），本 Provider 接管
// 后续切换；两处的 resolve 规则刻意双份——修改判定逻辑时两处同步。
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
const STORAGE_KEY = 'theme'

const detectTheme = (): Theme => {
  const s = localStorage.getItem(STORAGE_KEY)
  return s === 'light' || s === 'dark' ? s : 'system' // 缺省 = 跟随系统
}

const resolveTheme = (t: Theme): ResolvedTheme =>
  t === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
    : t

interface ThemeCtx {
  theme: Theme
  resolved: ResolvedTheme
  setTheme: (t: Theme) => void
}

const ThemeContext = createContext<ThemeCtx | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(detectTheme)
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(detectTheme()))
  // 首挂载不播过渡（FOUC 脚本已把 data-theme 设成终值，再过渡一遍等于闪一次）
  const firstApply = useRef(true)

  // system 态下实时跟随 OS（系统设置切深色，页面不刷新也跟进）；
  // 显式 light/dark 时监听器空转（onChange 里判 theme === 'system'）
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (theme === 'system') setResolved(resolveTheme('system'))
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange) // StrictMode 双执行安全
  }, [theme])

  // 持久化 + 把三态选择翻译成实际生效值（resolved 的变化经下方 effect 同步 DOM）
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, theme)
    setResolved(resolveTheme(theme))
  }, [theme])

  // 同步 <html data-theme>：唯一写点（手动切换与 system 跟随都经 resolved 汇聚）。
  // 变化时挂 .theme-transitioning 播 300ms 颜色过渡（index.css），避免瞬切闪眼；
  // reflow 重置保证连续切换从当前插值色起跳；reduced-motion 用户跳过
  useEffect(() => {
    const root = document.documentElement
    if (firstApply.current) {
      firstApply.current = false
    } else if (root.dataset.theme !== resolved) {
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        root.classList.remove('theme-transitioning')
        void root.offsetWidth // 强制 reflow：终止进行中的过渡，新过渡从当前色起
        root.classList.add('theme-transitioning')
        window.setTimeout(() => root.classList.remove('theme-transitioning'), 360)
      }
    }
    root.dataset.theme = resolved
  }, [resolved])

  return <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
