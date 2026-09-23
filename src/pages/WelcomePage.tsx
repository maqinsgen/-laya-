import { useState, useEffect, useRef, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Alert,
  Button,
  Card,
  Chip,
  ComboBox,
  Description,
  Input,
  InputGroup,
  Label,
  ListBox,
  ProgressBar,
  ScrollShadow,
  Spinner,
  TextField,
  Tooltip,
  Typography
} from '@heroui/react'
import { ArrowLeft, ArrowRight, ArrowsRotateLeft, BookOpen, CircleCheck, Eye, EyeSlash, Fingerprint, FolderOpen, Lock, ShieldCheck, Sparkles } from '@gravity-ui/icons'
import { useAppStore } from '../stores/appStore'
import { dialog } from '../services/ipc'
import * as configService from '../services/config'
import { useAuthStore } from '../stores/authStore'
import { WechatReadiness, useWechatReadiness } from '../components/WechatReadiness'
import { WechatLoginCaptureGuide } from '../components/WechatLoginCaptureGuide'
import { isValidDatabaseKey, normalizeDatabaseKey, sanitizeWechatSetupDraft } from '../shared/wechatSetup'
import { BRAND } from '../shared/brand'
import './WelcomePage.css'

const GUIDE_URL = 'https://ilovebinglu.notion.site/ciphertalk'

const steps = [
  { id: 'intro', title: '开始', desc: '把消息接进来，让重要的事浮现' },
  { id: 'db', title: '找到数据', desc: '自动定位本机微信，保留你的原始数据' },
  { id: 'key', title: '验证连接', desc: '检查环境，获取或填写已有密钥' },
  { id: 'decrypt', title: '完成', desc: '确认连接，可选功能以后再设置' }
]

interface WelcomePageProps {
  standalone?: boolean
}

function WelcomePage({ standalone = false }: WelcomePageProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { isDbConnected, setDbConnected, setMyWxid: setCurrentWxid } = useAppStore()
  const { enableAuth, disableAuth, isAuthEnabled } = useAuthStore()

  const [stepIndex, setStepIndex] = useState(0)
  const [dbPath, updateDbPath] = useState('')
  const [decryptKey, updateDecryptKey] = useState('')
  const [imageXorKey, setImageXorKey] = useState('')
  const [imageAesKey, setImageAesKey] = useState('')
  const [cachePath, setCachePath] = useState('')
  const [wxid, updateWxid] = useState('')
  const formIdentity = useRef({ dbPath, decryptKey, wxid })
  formIdentity.current = { dbPath, decryptKey, wxid }
  const setDbPath = (value: string) => { formIdentity.current.dbPath = value; updateDbPath(value) }
  const setDecryptKey = (value: string) => { formIdentity.current.decryptKey = value; updateDecryptKey(value) }
  const setWxid = (value: string) => { formIdentity.current.wxid = value; updateWxid(value) }
  const [wxidOptions, setWxidOptions] = useState<string[]>([])
  // 内存提取到的账号字段：昵称 / 微信号 / 手机号（用于保存到账号档案）
  const [accountName, setAccountName] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [accountPhone, setAccountPhone] = useState('')
  const [verifiedIdentity, setVerifiedIdentity] = useState('')
  const isAccountVerified = verifiedIdentity === JSON.stringify([dbPath, decryptKey, wxid])
  const clearVerification = () => setVerifiedIdentity('')
  const [manualKeyOpen, setManualKeyOpen] = useState(false)
  const keyRequest = useRef(0)
  const mounted = useRef(false)
  const keyBusy = useRef(false)
  const activeKeyRequest = useRef<number | null>(null)
  const verifyRequest = useRef(0)
  const scanRequest = useRef(0)
  const accountSelectionRevision = useRef(0)
  const readiness = useWechatReadiness(dbPath, steps[stepIndex].id === 'key')
  const [isVerifyingAccount, setIsVerifyingAccount] = useState(false)
  const [error, setError] = useState('')

  const [isScanningWxid, setIsScanningWxid] = useState(false)
  const [isDetectingPath, setIsDetectingPath] = useState(false)
  const [isFetchingDbKey, setIsFetchingDbKey] = useState(false)
  const [isFetchingImageKey, setIsFetchingImageKey] = useState(false)
  const [showDecryptKey, setShowDecryptKey] = useState(false)
  const [dbKeyStatus, setDbKeyStatus] = useState('')
  const [imageKeyStatus, setImageKeyStatus] = useState('')
  const [authStatus, setAuthStatus] = useState('')
  const [isEnablingAuth, setIsEnablingAuth] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [showWechatPathPrompt, setShowWechatPathPrompt] = useState(false)
  const [customWechatPath, setCustomWechatPath] = useState('')
  const [isDecrypting, setIsDecrypting] = useState(false)
  const [decryptStatus, setDecryptStatus] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [hasCache, setHasCache] = useState(false)
  const [platformInfo, setPlatformInfo] = useState<{ platform: string; arch: string }>({
    platform: 'win32',
    arch: 'x64'
  })
  const autoDetectDbPathAttemptedRef = useRef(false)

  const isMac = platformInfo.platform === 'darwin'
  const biometricLabel = isMac ? 'Touch ID' : 'Windows Hello'
  const isAddAccountMode = new URLSearchParams(location.search).get('mode') === 'add-account'

  useEffect(() => {
    mounted.current = true
    const removeStatus = window.electronAPI.wxKey?.onStatus?.((payload) => {
      if (mounted.current && activeKeyRequest.current === keyRequest.current) setDbKeyStatus(payload.status)
    })
    const removeImageProgress = window.electronAPI.imageKey?.onProgress?.((msg) => {
      setImageKeyStatus(msg)
    })

    void window.electronAPI.app.getPlatformInfo().then(info => { if (mounted.current) setPlatformInfo(info) }).catch(() => {
      // ignore
    })

    // 从缓存加载配置
    const loadCachedConfig = () => {
      try {
        const cached = localStorage.getItem('welcomeConfig')
        if (cached) {
          const config = sanitizeWechatSetupDraft(JSON.parse(cached))
          // Sanitize legacy secrets even when this window is adding an account.
          localStorage.setItem('welcomeConfig', JSON.stringify(config))
          if (isAddAccountMode) return
          if (config.dbPath) {
            setDbPath(config.dbPath)
            setHasCache(true)
          }
          if (config.cachePath) {
            setCachePath(config.cachePath)
          }
          if (config.wxid) {
            setWxid(config.wxid)
          }

        }
      } catch (e) {
        // Malformed legacy JSON may itself contain a key. Remove it and avoid
        // logging the parse exception, which can quote the original contents.
        try { localStorage.removeItem('welcomeConfig') } catch { /* storage unavailable */ }
        console.error('加载缓存配置失败，已尝试清理旧草稿')
      }
    }
    loadCachedConfig()

    // 自动检测最佳缓存路径（如果缓存中没有）
    const initCachePath = async () => {
      if (!cachePath) {
        try {
          const result = await window.electronAPI.dbPath.getBestCachePath()
          if (mounted.current && result.success && result.path) {
            setCachePath(result.path)
          }
        } catch (e) {
          console.error('获取缓存路径失败:', e)
        }
      }
    }
    initCachePath()

    return () => {
      mounted.current = false
      keyRequest.current++
      verifyRequest.current++
      scanRequest.current++
      if (keyBusy.current) void window.electronAPI.wxKey.cancel().catch(() => {})
      keyBusy.current = false
      activeKeyRequest.current = null
      removeStatus?.()
      removeImageProgress?.()
    }
  }, [isAddAccountMode])

  useEffect(() => {
    setWxidOptions([])
    clearVerification()
    // 注意：不要清空 wxid，因为它可能是从缓存加载的
    // setWxid('')
  }, [dbPath])

  const verifyAccountDirectory = async (candidateWxid: string, key: string, silent = false, ownerIsCurrent = () => true) => {
    if (!mounted.current || !ownerIsCurrent()) return false
    const request = ++verifyRequest.current
    const isCurrent = () => mounted.current && request === verifyRequest.current && ownerIsCurrent() &&
      formIdentity.current.dbPath === dbPath && formIdentity.current.decryptKey === key && formIdentity.current.wxid === candidateWxid
    if (!dbPath || !candidateWxid || !isValidDatabaseKey(key)) {
      clearVerification()
      setIsVerifyingAccount(false)
      return false
    }

    setIsVerifyingAccount(true)
    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, key, candidateWxid)
      if (!isCurrent()) return false
      if (result.success) {
        setVerifiedIdentity(JSON.stringify([dbPath, key, candidateWxid]))
        if (!silent) setDbKeyStatus(`账号目录验证成功：${candidateWxid}`)
        return true
      }

      clearVerification()
      if (!silent) setError(result.error || '账号目录验证失败，请重新选择')
      return false
    } catch (e) {
      if (!isCurrent()) return false
      clearVerification()
      if (!silent) setError(`账号目录验证失败: ${e}`)
      return false
    } finally {
      if (mounted.current && request === verifyRequest.current) setIsVerifyingAccount(false)
    }
  }

  // 保存配置到缓存
  useEffect(() => {
    if (isAddAccountMode) return
    const config = {
      dbPath,
      cachePath,
      wxid
    }
    try {
      localStorage.setItem('welcomeConfig', JSON.stringify(config))
    } catch (e) {
      console.error('保存配置到缓存失败:', e)
    }
  }, [dbPath, cachePath, wxid, isAddAccountMode])

  const currentStep = steps[stepIndex]
  const rootClassName = `welcome-page${isClosing ? ' is-closing' : ''}${standalone ? ' is-standalone' : ''}`
  const progressValue = ((stepIndex + 1) / steps.length) * 100

  useEffect(() => {
    if (currentStep.id !== 'db') return
    if (dbPath) return
    if (autoDetectDbPathAttemptedRef.current) return

    autoDetectDbPathAttemptedRef.current = true
    void handleAutoDetectPath(true)
  }, [currentStep.id, dbPath])

  const handleOpenGuide = () => {
    void window.electronAPI.shell.openExternal(GUIDE_URL)
  }

  const handleResetCachePath = async () => {
    try {
      const result = await window.electronAPI.dbPath.getBestCachePath()
      if (result.success && result.path) {
        setCachePath(result.path)
      }
    } catch (e) {
      setError('获取默认缓存路径失败')
    }
  }

  const handleSelectPath = async () => {
    try {
      const result = await dialog.openFile({
        title: '选择微信数据库目录',
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        setDbPath(result.filePaths[0])
        setError('')
      }
    } catch (e) {
      setError('选择目录失败')
    }
  }

  const handleAutoDetectPath = async (silent = false) => {
    if (isDetectingPath) return

    setIsDetectingPath(true)
    if (!silent) setError('')

    try {
      const result = await window.electronAPI.dbPath.autoDetect()
      if (result.success && result.path) {
        setDbPath(result.path)
        setError('')
        return
      }

      if (!silent) {
        setError(result.error || '未能自动检测到微信数据库目录')
      }
    } catch (e) {
      if (!silent) {
        setError(`自动检测失败: ${e}`)
      }
    } finally {
      setIsDetectingPath(false)
    }
  }

  const handleOpenDetectedPath = async () => {
    if (!dbPath) {
      setError('当前没有可打开的数据库目录')
      return
    }

    try {
      const result = await window.electronAPI.shell.openPath(dbPath)
      if (result) {
        setError(result)
      }
    } catch (e) {
      setError(`打开目录失败: ${e}`)
    }
  }



  const handleSelectCachePath = async () => {
    try {
      const result = await dialog.openFile({
        title: '选择缓存目录',
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        setCachePath(result.filePaths[0])
        setError('')
      }
    } catch (e) {
      setError('选择缓存目录失败')
    }
  }

  const handleScanWxid = async (silent = false, ownerIsCurrent = () => true, key = decryptKey) => {
    if (!mounted.current || !ownerIsCurrent()) return []
    if (!dbPath) {
      if (!silent) setError('请先选择数据库目录')
      return []
    }
    if (isScanningWxid) return []
    const request = ++scanRequest.current
    const accountRevision = accountSelectionRevision.current
    const isCurrent = () => mounted.current && request === scanRequest.current && ownerIsCurrent() &&
      accountSelectionRevision.current === accountRevision && formIdentity.current.dbPath === dbPath && formIdentity.current.decryptKey === key
    setIsScanningWxid(true)
    if (!silent) setError('')
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      if (!isCurrent()) return []
      setWxidOptions(wxids)
      clearVerification()
      if (wxids.length > 0) {
        let selectedWxid = ''

        if (isValidDatabaseKey(key)) {
          const resolved = await window.electronAPI.wcdb.resolveValidWxid(dbPath, key)
          if (!isCurrent()) return []
          if (resolved.success && resolved.wxid && wxids.includes(resolved.wxid)) {
            selectedWxid = resolved.wxid
          }
        }

        if (!selectedWxid) {
          let accountInfo: { wxid: string; dbPath: string } | null = null
          accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10)
          if (!isCurrent()) return []
          if (!accountInfo) {
            accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60)
            if (!isCurrent()) return []
          }

          if (accountInfo && wxids.includes(accountInfo.wxid)) {
            selectedWxid = accountInfo.wxid
          }
        }

        if (!selectedWxid) {
          const wxidAccount = wxids.find(id => id.startsWith('wxid_'))
          selectedWxid = wxidAccount || wxids[0]
        }

        if (selectedWxid) {
          setWxid(selectedWxid)
          if (!silent) setError('')
        } else {
          if (!silent) setError('未能自动确定正确账号目录，请手动选择')
        }
      } else {
        if (!silent) setError('未检测到账号目录，请检查路径')
      }
      return wxids
    } catch (e) {
      if (!isCurrent()) return []
      if (!silent) setError(`扫描失败: ${e}`)
      return []
    } finally {
      if (mounted.current && request === scanRequest.current) setIsScanningWxid(false)
    }
  }

  const handleAutoGetDbKey = async (wechatPath?: string) => {
    if (!mounted.current || keyBusy.current || readiness.checking) return
    const request = ++keyRequest.current
    keyBusy.current = true
    activeKeyRequest.current = request
    const accountRevision = accountSelectionRevision.current
    let expectedKey = formIdentity.current.decryptKey
    const isCurrent = () => mounted.current && request === keyRequest.current &&
      accountSelectionRevision.current === accountRevision && formIdentity.current.dbPath === dbPath && formIdentity.current.decryptKey === expectedKey
    setIsFetchingDbKey(true)
    setError('')
    setDbKeyStatus('正在准备获取密钥...')
    try {
      const report = await readiness.refresh()
      if (!isCurrent()) return
      if (!report?.canAutoGet) {
        setError(report?.summary || '请先完成环境检查')
        setManualKeyOpen(true)
        return
      }
      const result = await window.electronAPI.wxKey.startGetKey(wechatPath, dbPath || undefined, wxid || undefined)
      if (!isCurrent()) return
      if (result.success && result.key && isValidDatabaseKey(result.key)) {
        expectedKey = result.key
        setDecryptKey(result.key)
        setManualKeyOpen(true)
        // 留存内存提取到的账号字段，保存账号时写入档案
        if (result.account) {
          setAccountName(result.account.name || '')
          setAccountNumber(result.account.number || '')
          setAccountPhone(result.account.phone || '')
        }
        setDbKeyStatus('密钥获取成功，正在验证账号目录...')
        setError('')
        setShowWechatPathPrompt(false)

        if (result.validatedWxid) {
          setWxid(result.validatedWxid)
          setVerifiedIdentity(JSON.stringify([dbPath, result.key, result.validatedWxid]))
          const acc = result.account
          const extra = acc && (acc.name || acc.number)
            ? `（${[acc.name && `昵称: ${acc.name}`, acc.number && `微信号: ${acc.number}`].filter(Boolean).join('，')}）`
            : ''
          setDbKeyStatus(`密钥获取成功，已验证账号目录: ${result.validatedWxid}${extra}`)
          return
        }

        if (dbPath) {
          const resolved = await window.electronAPI.wcdb.resolveValidWxid(dbPath, result.key)
          if (!isCurrent()) return
          if (resolved.success && resolved.wxid) {
            setWxid(resolved.wxid)
            setVerifiedIdentity(JSON.stringify([dbPath, result.key, resolved.wxid]))
            setDbKeyStatus(`密钥获取成功，已验证账号目录: ${resolved.wxid}`)
            return
          }
        }

        // DLL 直接返回了 wxid：用它定位并验证账号目录，避免落到“扫描文件夹让用户选”
        if (result.account?.wxid) {
          setWxid(result.account.wxid)
          const ok = await verifyAccountDirectory(result.account.wxid, result.key, true, isCurrent)
          if (!isCurrent()) return
          if (ok) {
            const a = result.account
            const extra = (a.name || a.number)
              ? `（${[a.name && `昵称: ${a.name}`, a.number && `微信号: ${a.number}`].filter(Boolean).join('，')}）`
              : ''
            setDbKeyStatus(`密钥获取成功，已验证账号目录: ${result.account.wxid}${extra}`)
            return
          }
        }

        // 先尝试当前登录账号检测（强信号）
        let accountInfo: { wxid: string; dbPath: string } | null = null
        if (dbPath) {
          accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10)
          if (!isCurrent()) return
          if (!accountInfo) {
            accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60)
            if (!isCurrent()) return
          }
        }

        if (accountInfo) {
          setWxid(accountInfo.wxid)
          const ok = await verifyAccountDirectory(accountInfo.wxid, result.key, true, isCurrent)
          if (!isCurrent()) return
          if (ok) {
            setDbKeyStatus(`密钥获取成功，已验证账号目录: ${accountInfo.wxid}`)
            return
          }
        }

        const wxids = await handleScanWxid(true, isCurrent, result.key)
        if (!isCurrent()) return
        if (wxids.length > 1) {
          // 多账号时仅作为候选，等待用户选择后再验证
          setDbKeyStatus(`密钥获取成功，识别到 ${wxids.length} 个候选账号目录，请选择后验证`)
        } else if (wxids.length === 1) {
          const ok = await verifyAccountDirectory(wxids[0], result.key, true, isCurrent)
          if (!isCurrent()) return
          setDbKeyStatus(ok ? '密钥获取成功，已自动识别并验证账号目录' : '密钥获取成功，请手动确认账号目录')
        } else {
          setDbKeyStatus('密钥获取成功，请手动选择并验证账号目录')
        }
      } else {
        if (result.needManualPath) {
          setShowWechatPathPrompt(true)
          setDbKeyStatus('需要手动选择微信安装位置')
        } else {
          setError(result.error || '自动获取密钥失败')
          setDbKeyStatus('')
        }
      }
    } catch (e) {
      if (!isCurrent()) return
      setError(`自动获取密钥失败: ${e}`)
      setDbKeyStatus('')
    } finally {
      if (activeKeyRequest.current === request) {
        activeKeyRequest.current = null
        keyBusy.current = false
        if (mounted.current) setIsFetchingDbKey(false)
      }
    }
  }

  const handleCancelDbKey = async () => {
    if (!mounted.current || activeKeyRequest.current === null) return
    const request = ++keyRequest.current
    verifyRequest.current++
    scanRequest.current++
    activeKeyRequest.current = null
    setIsVerifyingAccount(false)
    setIsScanningWxid(false)
    setDbKeyStatus('正在取消…')
    try {
      await window.electronAPI.wxKey.cancel()
      if (mounted.current && request === keyRequest.current) {
        setDbKeyStatus('已取消。你可以重新检查环境，或填写已有密钥。')
      }
    } catch {
      if (mounted.current && request === keyRequest.current) setError('取消未确认，请等待当前操作结束。')
    } finally {
      if (mounted.current && request === keyRequest.current) {
        keyBusy.current = false
        setIsFetchingDbKey(false)
      }
    }
  }

  const handleSelectWechatPath = async () => {
    try {
      const result = await dialog.openFile({
        title: '选择微信程序 (Weixin.exe)',
        properties: ['openFile'],
        filters: [
          { name: '微信程序', extensions: ['exe'] }
        ]
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const path = result.filePaths[0]
        if (path.toLowerCase().endsWith('weixin.exe')) {
          setCustomWechatPath(path)
          setError('')
        } else {
          setError('请选择 Weixin.exe 文件')
        }
      }
    } catch (e) {
      setError('选择文件失败')
    }
  }

  const handleConfirmWechatPath = () => {
    if (!customWechatPath) {
      setError('请先选择微信程序')
      return
    }
    handleAutoGetDbKey(customWechatPath)
  }

  const handleAutoGetImageKey = async () => {
    if (isFetchingImageKey) return
    if (!dbPath) {
      setError('请先选择数据库目录')
      return
    }
    setIsFetchingImageKey(true)
    setError('')
    setImageKeyStatus('正在准备获取图片密钥...')
    try {
      const accountPath = wxid ? `${dbPath}/${wxid}` : dbPath
      const result = await window.electronAPI.imageKey.getImageKeys(accountPath)
      if (result.success) {
        if (typeof result.xorKey === 'number') {
          setImageXorKey(`0x${result.xorKey.toString(16).toUpperCase().padStart(2, '0')}`)
        }
        if (result.aesKey) {
          setImageAesKey(result.aesKey)
        }
        setImageKeyStatus('已获取图片密钥')

        // 发送系统通知
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(`${BRAND.name} - 图片密钥获取成功`, {
            body: '已成功获取图片密钥，可以继续下一步操作',
            icon: './logo.png'
          })
        }
      } else {
        setError(result.error || '自动获取图片密钥失败')
      }
    } catch (e) {
      setError(`自动获取图片密钥失败: ${e}`)
    } finally {
      setIsFetchingImageKey(false)
    }
  }

  const canGoNext = () => {
    if (currentStep.id === 'intro') return true
    if (currentStep.id === 'db') return Boolean(dbPath && cachePath)
    if (currentStep.id === 'cache') return Boolean(cachePath)
    if (currentStep.id === 'key') return isValidDatabaseKey(decryptKey) && Boolean(wxid) && isAccountVerified
    if (currentStep.id === 'image') return true
    if (currentStep.id === 'security') return true
    if (currentStep.id === 'decrypt') return false // 最后一步，不能下一步
    return false
  }

  const handleNext = () => {
    if (!canGoNext()) {
      if (currentStep.id === 'db' && !dbPath) setError('请先选择数据库目录')
      if (currentStep.id === 'cache' && !cachePath) setError('请填写缓存目录')
      if (currentStep.id === 'key') {
        if (!isValidDatabaseKey(decryptKey)) setError('密钥应为 64 位十六进制字符（0–9、a–f）')
        else if (!wxid) setError('请先选择账号目录')
        else if (!isAccountVerified) setError('账号目录尚未验证，请先验证后继续')
      }
      return
    }
    setError('')
    setStepIndex((prev) => Math.min(prev + 1, steps.length - 1))
  }

  const handleBack = () => {
    setError('')
    setStepIndex((prev) => Math.max(prev - 1, 0))
  }

  const canJumpToStep = (index: number) => {
    if (isFetchingDbKey || isDecrypting) return false
    if (index <= stepIndex) return true
    if (index === stepIndex + 1) return canGoNext()
    return false
  }

  const handleJumpToStep = (index: number) => {
    if (!canJumpToStep(index)) {
      handleNext()
      return
    }
    setError('')
    setStepIndex(index)
  }

  const handleConfirm = async () => {
    if (!dbPath) { setError('请先选择数据库目录'); return }
    if (!wxid) { setError('请先选择账号目录'); return }
    if (!isAccountVerified) { setError('账号目录尚未验证，请先验证'); return }
    if (!decryptKey || !isValidDatabaseKey(decryptKey)) { setError('请填写有效的 64 位十六进制密钥'); return }

    setIsDecrypting(true)
    setError('')
    setDecryptStatus('正在验证数据库连接…')

    try {
      setDecryptStatus('正在测试数据库连接...')

      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (!result.success) {
        setError(result.error || 'WCDB 连接失败')
        setDecryptStatus('')
        setIsDecrypting(false)
        return
      }

      setDecryptStatus('验证成功，正在保存账号…')
      const savedAccount = await configService.saveAccount({
        dbPath,
        decryptKey,
        wxid,
        cachePath,
        imageXorKey,
        imageAesKey,
        wechatNumber: accountNumber,
        phone: accountPhone,
        displayName: accountName || wxid || '未命名账号'
      })

      if (!savedAccount) {
        throw new Error('保存账号配置失败')
      }

      await configService.setActiveAccount(savedAccount.id)
      setCurrentWxid(wxid)

      setDecryptStatus('连接成功，配置保存完成...')

      localStorage.removeItem('welcomeConfig')

      setDbConnected(true, dbPath)
      setCurrentWxid(wxid)

      if (standalone) {
        setIsClosing(true)
        setTimeout(() => {
          window.electronAPI.window.completeWelcome()
        }, 450)
      } else {
        navigate('/todo')
      }
    } catch (e) {
      setError(`连接失败: ${e}`)
      setDecryptStatus('')
      setCountdown(0)
    } finally {
      setIsDecrypting(false)
    }
  }

  const handleSelectWxidCandidate = (candidateWxid: string) => {
    accountSelectionRevision.current++
    setWxid(candidateWxid)
    clearVerification()
    if (isValidDatabaseKey(decryptKey)) {
      void verifyAccountDirectory(candidateWxid, decryptKey)
    }
  }

  const handleEnterHome = () => {
    if (standalone) {
      setIsClosing(true)
      setTimeout(() => {
        window.electronAPI.window.completeWelcome()
      }, 450)
    } else {
      navigate('/todo')
    }
  }

  const renderInfoList = (items: ReactNode[]) => (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {items.map((item, index) => (
        <li key={index} className="flex min-w-0 items-start gap-2 text-sm leading-6 text-foreground">
          <CircleCheck width={15} height={15} className="mt-1 shrink-0 text-accent" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  )

  const renderStatusAlert = (message: string, status: 'default' | 'accent' | 'success' | 'warning' | 'danger' = 'default') => (
    <Alert status={status}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{message}</Alert.Description>
      </Alert.Content>
    </Alert>
  )

  const renderTextField = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: {
      placeholder?: string
      description?: ReactNode
      type?: string
      suffix?: ReactNode
    } = {}
  ) => (
    <TextField fullWidth value={value} onChange={onChange}>
      <Label>{label}</Label>
      <InputGroup fullWidth variant="secondary">
        <InputGroup.Input type={options.type || 'text'} placeholder={options.placeholder} />
        {options.suffix && <InputGroup.Suffix className="pr-0">{options.suffix}</InputGroup.Suffix>}
      </InputGroup>
      {options.description ? <Description>{options.description}</Description> : null}
    </TextField>
  )

  const renderStepInfo = () => {
    if (currentStep.id === 'intro') {
      return (
        <div className="flex min-w-0 flex-col gap-3.5">
          <Typography.Heading level={4}>准备开始</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">
            只需找到数据、验证账号，就能开始整理微信消息。图片解密和应用锁都可以稍后配置。
          </Typography.Paragraph>
          {renderInfoList(['此连接过程只在本机进行，不上传密钥', 'AI 分析仅在配置服务商后启用', '也可以先用邮箱和手动待办'])}
        </div>
      )
    }

    if (currentStep.id === 'db') {
      return (
        <div className="flex min-w-0 flex-col gap-3.5">
          <Typography.Heading level={4}>数据库目录</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">
            系统会优先自动识别当前设备上的微信数据存储目录。
          </Typography.Paragraph>
          {renderInfoList([
            '进入本步骤后会先尝试自动检测',
            '检测到结果后可直接打开文件夹确认',
            isMac ? '未命中时手动选择版本目录或账号目录' : '未命中时按微信存储位置手动选择'
          ])}
          {!isMac && renderStatusAlert('目录路径不可包含中文，如有中文请先在微信中迁移到英文目录。', 'warning')}
        </div>
      )
    }

    if (currentStep.id === 'cache') {
      return (
        <div className="flex min-w-0 flex-col gap-3.5">
          <Typography.Heading level={4}>缓存目录</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">
            缓存目录用于存储头像、表情与图片等本地媒体缓存。
          </Typography.Paragraph>
          {renderInfoList([
            isMac ? '默认使用文稿目录下的 CipherTalkData' : '自动选择更适合存储的磁盘',
            '需要预留足够空间',
            '后续仍可在设置中修改'
          ])}
        </div>
      )
    }

    if (currentStep.id === 'key') {
      return (
        <div className="flex min-w-0 flex-col gap-3.5">
          <Typography.Heading level={4}>解密密钥</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">
            此步骤会在本机完成密钥识别与账号目录校验。
          </Typography.Paragraph>
          {renderInfoList([
            isMac ? '先停留微信登录页，监听就绪后再登录' : '点击自动获取后按提示登录微信',
            '识别完成后会尝试匹配账号目录',
            '密钥不会写入向导的浏览器草稿'
          ])}
          {renderStatusAlert(isMac ? '若系统环境不满足要求，界面会直接给出提示。' : '密钥不会上传到服务器。', 'default')}
        </div>
      )
    }

    if (currentStep.id === 'image') {
      return (
        <div className="flex min-w-0 flex-col gap-3.5">
          <Typography.Heading level={4}>图片密钥</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">
            图片密钥用于解密微信图片，可自动获取，也可以稍后手动填写。
          </Typography.Paragraph>
          {renderInfoList([
            isMac ? '优先通过 kvcomm 码和模板文件推导' : '通过 Rust native 扫描微信进程内存',
            isMac ? 'kvcomm 失败时再回退到进程内存扫描' : '请先在电脑微信中打开几张图片',
            '此步骤可跳过'
          ])}
        </div>
      )
    }

    if (currentStep.id === 'security') {
      return (
        <div className="flex min-w-0 flex-col gap-3.5">
          <Typography.Heading level={4}>安全防护</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">
            应用锁是可选项，用于在启动应用时增加一道系统验证。
          </Typography.Paragraph>
          {renderInfoList([
            `使用 ${biometricLabel} 进行认证`,
            isMac ? '设备不支持时可跳过后改用密码' : '支持面部识别、指纹或 PIN 码',
            '适合共享设备或公共电脑'
          ])}
          {renderStatusAlert('推荐开启，但不会影响继续完成初始化。', 'success')}
        </div>
      )
    }

    return (
      <div className="flex min-w-0 flex-col gap-3.5">
        <Typography.Heading level={4}>连接数据库</Typography.Heading>
        <Typography.Paragraph size="sm" color="muted">
          最后一步会验证本地数据库连接，成功后保存账号。
        </Typography.Paragraph>
        {renderInfoList(['验证数据库目录、账号目录和密钥', '连接成功后保存当前账号配置', '完成后自动进入主应用'])}
        {renderStatusAlert('请确认前面的必填项都已正确配置。', 'warning')}
      </div>
    )
  }

  const renderDbStep = () => (
    <div className="flex min-w-0 flex-col gap-3.5">
      {hasCache && renderStatusAlert('已从缓存加载配置数据。', 'success')}
      {renderTextField('数据库根目录', dbPath, setDbPath, {
        placeholder: isMac
          ? '~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9'
          : 'C:\\Users\\xxx\\Documents\\xwechat_files',
        description: isMac ? '请选择微信版本目录或账号根目录。' : '请选择微信-设置-存储位置对应的目录。'
      })}
      <div className="flex flex-wrap items-center gap-2.5">
        <Button className="min-w-33 justify-center" type="button" variant="primary" onPress={() => void handleAutoDetectPath()} isPending={isDetectingPath}>
          <span className="grid size-4 shrink-0 place-items-center">
            {isDetectingPath ? <Spinner size="sm" color="current" /> : <Sparkles width={16} height={16} />}
          </span>
          <span className="min-w-[5em] text-left">{isDetectingPath ? '自动检测中' : '自动检测'}</span>
        </Button>
        <Button type="button" variant="secondary" onPress={() => void handleSelectPath()}>
          <FolderOpen width={16} height={16} /> 浏览选择目录
        </Button>
        {dbPath && (
          <Button type="button" variant="tertiary" onPress={() => void handleOpenDetectedPath()}>
            <FolderOpen width={16} height={16} /> 打开此文件夹
          </Button>
        )}
      </div>
      {!isMac && renderStatusAlert('目录路径不可包含中文。如有中文，请在微信设置中更改存储位置并迁移至英文目录。', 'warning')}
    </div>
  )

  const renderCacheStep = () => (
    <div className="flex min-w-0 flex-col gap-3.5">
      {renderTextField('缓存目录', cachePath, setCachePath, {
        placeholder: isMac ? '~/Documents/CipherTalkData' : 'D:\\CipherTalkDB',
        description: isMac ? '用于头像、表情与图片缓存，默认已选文稿目录。' : '用于头像、表情与图片缓存，已自动选择最佳磁盘。'
      })}
      <div className="flex flex-wrap items-center gap-2.5">
        <Button type="button" variant="primary" onPress={() => void handleSelectCachePath()}>
          <FolderOpen width={16} height={16} /> 浏览选择
        </Button>
        <Button type="button" variant="secondary" onPress={() => void handleResetCachePath()}>
          <ArrowsRotateLeft width={16} height={16} /> 恢复默认
        </Button>
      </div>
    </div>
  )

  const renderKeyStep = () => (
    <div className="flex min-w-0 flex-col gap-3.5">
      <WechatReadiness report={readiness.report} checking={readiness.checking} error={readiness.error} onRefresh={() => void readiness.refresh()} />
      {isMac ? <WechatLoginCaptureGuide
        busy={isFetchingDbKey} disabled={readiness.checking || !readiness.report?.canAutoGet || !dbPath}
        status={dbKeyStatus} onStart={() => void handleAutoGetDbKey()} onCancel={() => void handleCancelDbKey()}
      /> : <div className="welcome-key-actions">
        <Button type="button" variant="primary" onPress={() => void handleAutoGetDbKey()} isPending={isFetchingDbKey} isDisabled={isFetchingDbKey || readiness.checking || !readiness.report?.canAutoGet}>
          <Sparkles width={16} height={16} />{isFetchingDbKey ? '正在获取并验证…' : '自动获取并验证'}
        </Button>
        {isFetchingDbKey && <Button type="button" variant="secondary" onPress={handleCancelDbKey}>取消获取</Button>}
      </div>}
      {!readiness.checking && readiness.report && !readiness.report.canAutoGet && <p className="welcome-inline-note">当前环境暂不支持自动获取。可以使用已有密钥，或先返回信息助手连接邮箱。</p>}
      {!isMac && dbKeyStatus && renderStatusAlert(dbKeyStatus, isAccountVerified ? 'success' : 'default')}
      <details className="welcome-optional" open={manualKeyOpen} onToggle={(event) => setManualKeyOpen(event.currentTarget.open)}>
      <summary>已有密钥 / 手动验证账号</summary>
      <div className="welcome-optional-body">
      <ComboBox
        allowsCustomValue
        className="w-full"
        defaultFilter={() => true}
        fullWidth
        inputValue={wxid}
        menuTrigger="manual"
        selectedKey={wxidOptions.includes(wxid) ? wxid : null}
        onInputChange={(value) => {
          accountSelectionRevision.current++
          setWxid(value.trim())
          clearVerification()
        }}
        onSelectionChange={(key) => {
          if (key != null) handleSelectWxidCandidate(String(key))
        }}
      >
        <Label>账号目录</Label>
        <ComboBox.InputGroup>
          <Input placeholder="获取密钥后将自动填充" />
          {wxidOptions.length > 0 && <ComboBox.Trigger />}
        </ComboBox.InputGroup>
        <Description>
          <span className="inline-flex flex-wrap items-center gap-2">
            状态：
            <Chip size="sm" variant="soft" color={isAccountVerified ? 'success' : 'warning'}>
              <Chip.Label>{isAccountVerified ? '已验证' : '未验证'}</Chip.Label>
            </Chip>
            {wxidOptions.length > 0 && (
              <span className="text-muted">检测到 {wxidOptions.length} 个候选，可展开选择。</span>
            )}
          </span>
        </Description>
        {wxidOptions.length > 0 && (
          <ComboBox.Popover className="max-h-56 overflow-auto" placement="bottom start">
            <ListBox aria-label="候选账号目录">
              {wxidOptions.map((id) => (
                <ListBox.Item key={id} id={id} textValue={id}>
                  <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                    <FolderOpen width={16} height={16} />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <Label className="truncate">{id}</Label>
                    <Description>
                      {wxid === id
                        ? isAccountVerified ? '已验证，可继续下一步' : '当前选择，等待验证'
                        : isValidDatabaseKey(decryptKey) ? '选择后自动验证' : '选择后填入密钥再验证'}
                    </Description>
                  </div>
                  {wxid === id && (
                    <Chip color={isAccountVerified ? 'success' : 'warning'} variant="soft" size="sm" className="shrink-0">
                      <Chip.Label>{isAccountVerified ? '已验证' : '当前'}</Chip.Label>
                    </Chip>
                  )}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </ComboBox.Popover>
        )}
      </ComboBox>

      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          type="button"
          variant="secondary"
          onPress={() => void verifyAccountDirectory(wxid, decryptKey)}
          isDisabled={isVerifyingAccount || !wxid || !isValidDatabaseKey(decryptKey)}
          isPending={isVerifyingAccount}
        >
          {isVerifyingAccount ? <Spinner size="sm" color="current" /> : <ShieldCheck width={16} height={16} />}
          {isVerifyingAccount ? '验证中' : '验证账号目录'}
        </Button>
        <Button
          type="button"
          variant="tertiary"
          onPress={() => void handleScanWxid()}
          isDisabled={!dbPath || isScanningWxid}
          isPending={isScanningWxid}
        >
          {isScanningWxid ? <Spinner size="sm" color="current" /> : <FolderOpen width={16} height={16} />}
          扫描账号目录
        </Button>
      </div>

      {renderTextField('解密密钥', decryptKey, (value) => { setDecryptKey(normalizeDatabaseKey(value)); clearVerification() }, {
        placeholder: '粘贴 64 位十六进制密钥',
        description: decryptKey && !isValidDatabaseKey(decryptKey) ? '格式不正确：需要 64 位 0–9、a–f 字符；粘贴空格会自动清理。' : '已有密钥可以直接验证，无需重复获取。',
        type: showDecryptKey ? 'text' : 'password',
        suffix: (
          <Tooltip delay={0}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label={showDecryptKey ? '隐藏密钥' : '显示密钥'}
              onPress={() => setShowDecryptKey(!showDecryptKey)}
            >
              {showDecryptKey ? <EyeSlash width={16} height={16} /> : <Eye width={16} height={16} />}
            </Button>
            <Tooltip.Content>{showDecryptKey ? '隐藏密钥' : '显示密钥'}</Tooltip.Content>
          </Tooltip>
        )
      })}

      </div></details>

      {!isMac && showWechatPathPrompt && (
        <Card variant="secondary" className="w-full">
          <Card.Header>
            <Card.Title>选择微信程序</Card.Title>
            <Card.Description>未能自动找到微信安装位置，请手动选择 Weixin.exe。</Card.Description>
          </Card.Header>
          <Card.Content className="flex min-w-0 flex-col gap-3.5">
            {renderTextField('微信程序路径', customWechatPath, setCustomWechatPath, {
              placeholder: 'C:\\Program Files\\Tencent\\WeChat\\Weixin.exe'
            })}
            <div className="flex flex-wrap items-center gap-2.5">
              <Button type="button" variant="secondary" onPress={() => void handleSelectWechatPath()}>
                <FolderOpen width={16} height={16} /> 浏览选择
              </Button>
              <Button type="button" variant="primary" onPress={handleConfirmWechatPath}>
                确认并继续
              </Button>
            </div>
          </Card.Content>
        </Card>
      )}

      <p className="welcome-inline-note">{isMac ? '自动获取只读扫描本机微信，可能需要系统管理员授权；不会替你关闭安全保护。' : '请先打开微信。系统会提示何时登录；不会自动强制退出微信。'} 获取成功后仍需验证密钥与账号是否匹配。</p>
    </div>
  )

  const renderImageStep = () => (
    <div className="flex min-w-0 flex-col gap-3.5">
      {renderTextField('图片 XOR 密钥', imageXorKey, setImageXorKey, {
        placeholder: '例如：0xA4'
      })}
      {renderTextField('图片 AES 密钥', imageAesKey, setImageAesKey, {
        placeholder: '16 位密钥'
      })}
      <Button
        type="button"
        variant="secondary"
        className="self-start"
        onPress={() => void handleAutoGetImageKey()}
        isDisabled={isFetchingImageKey}
        isPending={isFetchingImageKey}
      >
        {isFetchingImageKey ? <Spinner size="sm" color="current" /> : <Sparkles width={16} height={16} />}
        {isFetchingImageKey ? '获取中' : '自动获取图片密钥'}
      </Button>
      {imageKeyStatus && renderStatusAlert(imageKeyStatus, 'default')}
      {isFetchingImageKey && renderStatusAlert(isMac ? '正在尝试 kvcomm / 内存扫描，请稍候。' : '正在通过 Rust native 扫描微信内存，请稍候。', 'accent')}
      <Description>{isMac ? '优先从 kvcomm 和模板文件推导，失败后回退到内存扫描。' : 'Windows 使用 Rust native 内存扫描；如获取失败，请先在电脑微信中打开查看几张图片后重试。'}</Description>
    </div>
  )

  const renderSecurityStep = () => (
    <div className="flex min-w-0 flex-col gap-3.5">
      <Card variant="secondary" className="w-full">
        <Card.Header className="flex-row items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid size-12 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
              {isMac ? <Lock width={28} height={28} /> : <Fingerprint width={28} height={28} />}
            </div>
            <div className="min-w-0">
              <Card.Title>{biometricLabel} 认证</Card.Title>
              <Card.Description>
                {isMac ? '启用 Touch ID 以保护您的数据。' : '启用 Windows Hello 以保护您的数据。'}
              </Card.Description>
            </div>
          </div>
          {isAuthEnabled && (
            <Chip size="sm" variant="soft" color="success">
              <CircleCheck width={12} height={12} />
              <Chip.Label>已启用</Chip.Label>
            </Chip>
          )}
        </Card.Header>
        <Card.Content>
          <Description>
            {isMac ? '启用后，每次打开应用都需要进行系统 Touch ID 验证。' : '启用后，每次打开应用都需要进行生物识别或 PIN 码验证。'}
          </Description>
        </Card.Content>
        <Card.Footer className="flex-wrap gap-2">
          {!isAuthEnabled ? (
            <Button
              type="button"
              variant="primary"
              onPress={async () => {
                setIsEnablingAuth(true)
                setAuthStatus(`正在等待${biometricLabel}验证...`)
                const result = await enableAuth()
                setIsEnablingAuth(false)
                if (result.success) {
                  setAuthStatus('已成功启用认证保护')
                } else {
                  setError(result.error || '启用失败')
                  setAuthStatus('')
                }
              }}
              isPending={isEnablingAuth}
            >
              {isEnablingAuth ? <Spinner size="sm" color="current" /> : <ShieldCheck width={16} height={16} />}
              {isEnablingAuth ? '正在配置' : '启用应用锁'}
            </Button>
          ) : (
            <Button
              type="button"
              variant="danger"
              onPress={async () => {
                await disableAuth()
                setAuthStatus('')
              }}
            >
              关闭保护
            </Button>
          )}
        </Card.Footer>
      </Card>
      {authStatus && renderStatusAlert(authStatus, 'success')}
    </div>
  )

  const renderSummaryItem = (label: string, value: ReactNode) => (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-3.5 border-b border-dashed border-border py-2.5 last:border-b-0">
      <span className="text-[13px] text-muted">{label}</span>
      <strong className="break-all text-right font-mono text-[13px] font-semibold text-foreground">{value}</strong>
    </div>
  )

  const renderDecryptStep = () => (
    <div className="flex min-w-0 flex-col gap-3.5">
      <Card variant="secondary" className="w-full">
        <Card.Header>
          <Card.Title>配置摘要</Card.Title>
          <Card.Description>确认无误后连接数据库。</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-0">
          {renderSummaryItem('数据库目录', dbPath || '未设置')}
          {renderSummaryItem('缓存目录', cachePath || '未设置')}
          {renderSummaryItem('账号目录', wxid ? `${wxid}${isAccountVerified ? '（已验证）' : '（未验证）'}` : '未设置')}
          {renderSummaryItem('解密密钥', decryptKey ? '已设置 (64位)' : '未设置')}
          {renderSummaryItem('图片密钥', imageXorKey || imageAesKey ? '已设置' : '未设置（可选）')}
        </Card.Content>
      </Card>
      <details className="welcome-optional"><summary>可选：图片解密与应用锁</summary><div className="welcome-optional-body">{renderImageStep()}{renderSecurityStep()}</div></details>
      <Button type="button" variant="primary" fullWidth onPress={() => void handleConfirm()} isPending={isDecrypting}>
        {isDecrypting ? <Spinner size="sm" color="current" /> : <ShieldCheck width={16} height={16} />}
        {isDecrypting ? '连接中' : '连接数据库'}
      </Button>
      {decryptStatus && countdown === 0 && renderStatusAlert(decryptStatus, 'accent')}
      {!isDecrypting && !decryptStatus && <Description className="text-center">验证成功后，保存账号并进入信息助手。</Description>}
    </div>
  )

  const renderStepForm = () => {
    if (currentStep.id === 'intro') {
      return (
        <div className="flex min-h-82.5 flex-col items-center justify-center gap-3.5 text-center">
          <div className="grid size-18 place-items-center rounded-lg bg-accent-soft text-accent">
            <Sparkles width={34} height={34} />
          </div>
          <Typography.Heading level={3}>连接你的微信消息</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">已有密钥可直接验证；自动获取是否可用，取决于当前系统和微信版本。</Typography.Paragraph>
        </div>
      )
    }
    if (currentStep.id === 'db') return <>{renderDbStep()}<details className="welcome-optional"><summary>缓存位置 · 已使用推荐目录</summary><div className="welcome-optional-body">{renderCacheStep()}</div></details></>
    if (currentStep.id === 'cache') return renderCacheStep()
    if (currentStep.id === 'key') return renderKeyStep()
    if (currentStep.id === 'image') return renderImageStep()
    if (currentStep.id === 'security') return renderSecurityStep()
    return renderDecryptStep()
  }

  if (isDbConnected && !isAddAccountMode) {
    return (
      <div className={rootClassName}>
        <div className="welcome-shell z-1 my-4 flex min-h-[min(640px,100%)] w-[min(1080px,calc(100vw-48px))] flex-col gap-3">
          <Card className="m-auto w-[min(420px,100%)] items-center p-6 pt-9 text-center">
            <div className="grid size-20 place-items-center rounded-lg bg-accent-soft text-accent">
              <CircleCheck width={48} height={48} />
            </div>
            <Card.Header className="items-center text-center">
              <Card.Title>已连接数据库</Card.Title>
              <Card.Description>配置已完成，可以开始使用了。</Card.Description>
            </Card.Header>
            <Card.Footer className="justify-center">
              <Button type="button" variant="primary" size="lg" onPress={handleEnterHome}>
              进入信息助手
              </Button>
            </Card.Footer>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className={rootClassName}>
      {/* 全屏倒计时覆盖层 */}
      {countdown > 0 && (
        <div className="countdown-overlay">
          <div className="countdown-content">
            <div className="countdown-number-large">{countdown}</div>
            <div className="countdown-text-large">秒后进入应用</div>
          </div>
        </div>
      )}

      <div className="welcome-shell z-1 my-4 flex min-h-[min(640px,calc(100%-32px))] w-[min(1080px,calc(100vw-48px))] flex-col gap-3">
        <Card className="shrink-0">
          <Card.Content className="welcome-header-layout grid items-center gap-6 pb-2">
            <div className="welcome-brand-row flex min-w-0 items-center justify-between gap-3">
              <div className="welcome-brand-identity flex min-w-0 items-center gap-3">
                <img src="./notewake-mark.svg" alt={BRAND.displayName} className="size-11 shrink-0 rounded-lg shadow-[0_10px_24px_color-mix(in_oklch,var(--foreground)_12%,transparent)]" />
                <div className="min-w-0">
                  <Typography.Heading level={3}>{BRAND.displayName}</Typography.Heading>
                  <Typography.Paragraph size="sm" color="muted">{currentStep.desc}</Typography.Paragraph>
                </div>
              </div>
              <Button type="button" variant="secondary" size="sm" onPress={handleOpenGuide} className="shrink-0">
                <BookOpen width={16} height={16} />
                使用教程
              </Button>
              {!standalone && <Button type="button" variant="ghost" size="sm" onPress={() => navigate('/todo')} isDisabled={isFetchingDbKey || isDecrypting}>稍后连接</Button>}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <Chip color="accent" variant="soft" size="sm">
                  <Chip.Label>{stepIndex + 1} / {steps.length}</Chip.Label>
                </Chip>
                <Typography.Paragraph size="sm" weight="medium">{currentStep.title}</Typography.Paragraph>
              </div>
              <ProgressBar aria-label="初始化进度" value={progressValue} valueLabel={`${Math.round(progressValue)}%`}>
                <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
              </ProgressBar>
            </div>
          </Card.Content>
          <div className="welcome-step-nav">
            {steps.map((step, index) => {
              const active = index === stepIndex
              const done = index < stepIndex
              const jumpable = canJumpToStep(index)
              return (
                <Tooltip key={step.id} delay={0}>
                  <button
                    type="button"
                    aria-label={`第 ${index + 1} 步 ${step.title}`}
                    aria-current={active ? 'step' : undefined}
                    disabled={!jumpable}
                    onClick={() => handleJumpToStep(index)}
                    className={`grid h-7.5 min-w-0 place-items-center rounded-lg border text-xs font-bold transition-colors ${
                      done
                        ? 'border-success bg-success text-success-foreground'
                        : active
                          ? 'border-accent bg-accent text-accent-foreground'
                          : jumpable
                            ? 'border-border bg-surface-secondary text-muted hover:border-accent'
                            : 'cursor-not-allowed border-border bg-surface-secondary text-muted opacity-60'
                    }`}
                  >
                    <span>{done ? <CircleCheck width={14} height={14} /> : `0${index + 1}`}</span><span>{step.title}</span>
                  </button>
                  <Tooltip.Content>{step.title}</Tooltip.Content>
                </Tooltip>
              )
            })}
          </div>
        </Card>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,0.86fr)_minmax(440px,1.14fr)] gap-3 max-[940px]:grid-cols-1">
          <Card className="flex min-h-0 flex-col max-[940px]:hidden">
            <Card.Header>
              <Card.Title>{currentStep.title}</Card.Title>
              <Card.Description>{currentStep.desc}</Card.Description>
            </Card.Header>
            <Card.Content className="min-h-0">
              <ScrollShadow hideScrollBar className="h-full min-h-0" size={64}>
                {renderStepInfo()}
              </ScrollShadow>
            </Card.Content>
            <Card.Footer>
              <Chip size="sm" variant="soft" color="success">
                <ShieldCheck width={12} height={12} />
                <Chip.Label>仅本地处理</Chip.Label>
              </Chip>
            </Card.Footer>
          </Card>

          <Card className="flex min-h-0 flex-col">
            <Card.Header className="flex-row items-start justify-between gap-3">
              <div className="min-w-0">
                <Card.Title>{currentStep.title}</Card.Title>
                <Card.Description>{currentStep.desc}</Card.Description>
              </div>
              <Chip size="sm" variant="soft" color={canGoNext() || currentStep.id === 'decrypt' ? 'accent' : 'warning'}>
                <Chip.Label>{currentStep.id === 'decrypt' ? '最终确认' : canGoNext() ? '可继续' : '待完成'}</Chip.Label>
              </Chip>
            </Card.Header>
            <Card.Content className="min-h-0">
              <ScrollShadow hideScrollBar className="h-full min-h-0 pr-0.5" size={56}>
                {renderStepForm()}
              </ScrollShadow>
            </Card.Content>
            {error && (
              <div className="px-4 pb-3">
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert>
              </div>
            )}
            <Card.Footer className="flex shrink-0 justify-between gap-3">
              <Button type="button" variant="tertiary" onPress={handleBack} isDisabled={stepIndex === 0 || isDecrypting || isFetchingDbKey}>
                <ArrowLeft width={16} height={16} /> 上一步
              </Button>
              {stepIndex < steps.length - 1 && (
                <Button type="button" variant="primary" onPress={handleNext} isDisabled={!canGoNext() || isFetchingDbKey}>
                  下一步 <ArrowRight width={16} height={16} />
                </Button>
              )}
            </Card.Footer>
          </Card>
        </div>
      </div>
    </div>
  )
}

export default WelcomePage
