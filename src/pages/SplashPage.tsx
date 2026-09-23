import { useEffect, useState } from 'react'
import { BRAND } from '../shared/brand'
import './SplashPage.css'

function SplashPage() {
  const [fadeOut, setFadeOut] = useState(false)

  useEffect(() => {
    document.documentElement.classList.add('splash-transparent')
    document.body.classList.add('splash-transparent')

    const readyTimer = setTimeout(() => {
      try {
        window.electronAPI?.window?.splashReady?.()
      } catch (e) {
        console.error('通知启动屏就绪失败:', e)
      }
    }, 1000)

    const cleanup = window.electronAPI?.window?.onSplashFadeOut?.(() => setFadeOut(true))

    return () => {
      clearTimeout(readyTimer)
      cleanup?.()
      document.documentElement.classList.remove('splash-transparent')
      document.body.classList.remove('splash-transparent')
    }
  }, [])

  return (
    <main className={`splash-page${fadeOut ? ' splash-page--out' : ''}`} aria-label={`${BRAND.displayName}启动页`}>
      <div className="splash-orbit" aria-hidden="true"><span /></div>

      <div className="splash-brand">
        <img className="splash-mark" src="./notewake-mark.svg" alt="" width="46" height="46" />
        <div>
          <div className="splash-name">{BRAND.chineseName}</div>
          <div className="splash-wordmark">{BRAND.name}</div>
        </div>
      </div>

      <div className="splash-message">
        <h1>{BRAND.tagline}</h1>
        <p>从纷繁消息，到心中有数。</p>
      </div>

      <div className="splash-loading" role="status" aria-live="polite">
        <span className="splash-loading-light" aria-hidden="true" />
        <span>正在打开信息助手</span>
        <span className="splash-loading-track" aria-hidden="true"><span /></span>
      </div>
    </main>
  )
}

export default SplashPage
