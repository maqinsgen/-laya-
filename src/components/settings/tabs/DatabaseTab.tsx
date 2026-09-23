import { useEffect, useState } from 'react'
import { Alert, Avatar, Button, Card, Chip, ComboBox, Description, Fieldset, Input, InputGroup, Label, ListBox, Separator, TextField, Typography } from '@heroui/react'
import { useRef, type ReactNode } from 'react'
import { ArrowRotateLeft, ArrowsRotateLeft, Check, CircleCheck, Copy, Eye, EyeSlash, FolderOpen, Key, Magnifier, Picture, PlugConnection, ShieldCheck, Thunderbolt, Xmark } from '@gravity-ui/icons'
import { useAppStore } from '../../../stores/appStore'
import type { AccountProfile } from '../../../types/account'
import { dialog } from '../../../services/ipc'
import * as configService from '../../../services/config'
import { WechatReadiness, useWechatReadiness } from '../../WechatReadiness'
import { WechatLoginCaptureGuide } from '../../WechatLoginCaptureGuide'
import { isValidDatabaseKey, normalizeDatabaseKey } from '../../../shared/wechatSetup'
import { ACCOUNT_CONFIG_KEYS, hasSettingsChanges, useSettingsStore } from '../settingsStore'

interface DatabaseTabProps {
  showMessage: (text: string, success: boolean) => void
}

type SecretFieldId = 'decryptKey' | 'imageXorKey' | 'imageAesKey'

interface PathFieldOptions {
  label: ReactNode
  helperText: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  onBrowse?: () => void
  onReset?: () => void
  browseLabel?: string
  resetLabel?: string
}

interface SecretFieldOptions {
  id: SecretFieldId
  label: ReactNode
  helperText: string
  placeholder: string
  value: string
  onChange: (value: string) => void
}

function DatabaseTab({ showMessage }: DatabaseTabProps) {
  const { setDbConnected, setLoading, setMyWxid: setCurrentWxid, userInfo } = useAppStore()
  const isMac = window.navigator.platform.toLowerCase().includes('mac')
  const decryptKey = useSettingsStore(s => s.config.decryptKey)
  const dbPath = useSettingsStore(s => s.config.dbPath)
  const readiness = useWechatReadiness(dbPath)
  const wxid = useSettingsStore(s => s.config.wxid)
  const cachePath = useSettingsStore(s => s.config.cachePath)
  const imageXorKey = useSettingsStore(s => s.config.imageXorKey)
  const imageAesKey = useSettingsStore(s => s.config.imageAesKey)
  const displayName = useSettingsStore(s => s.config.displayName)
  const wechatNumber = useSettingsStore(s => s.config.wechatNumber)
  const phone = useSettingsStore(s => s.config.phone)
  const hasUnsavedAccountChanges = useSettingsStore(s => (
    hasSettingsChanges(s.config, s.initialConfig, ACCOUNT_CONFIG_KEYS)
  ))
  const setField = useSettingsStore(s => s.setField)
  const rebaseFields = useSettingsStore(s => s.rebaseFields)
  const setDecryptKey = (value: string) => setField('decryptKey', value)
  const setDbPath = (value: string) => setField('dbPath', value)
  const setWxid = (value: string) => setField('wxid', value)
  const setCachePath = (value: string) => setField('cachePath', value)
  const setImageXorKey = (value: string) => setField('imageXorKey', value)
  const setImageAesKey = (value: string) => setField('imageAesKey', value)

  const [accountsList, setAccountsList] = useState<AccountProfile[]>([])
  const [activeAccountId, setActiveAccountId] = useState('')
  const [wxidOptions, setWxidOptions] = useState<string[]>([])
  const [isScanningWxid, setIsScanningWxid] = useState(false)
  const [isAccountVerified, setIsAccountVerified] = useState(false)
  const [isVerifyingAccount, setIsVerifyingAccount] = useState(false)
  const [isLoading, setIsLoadingState] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isGettingKey, setIsGettingKey] = useState(false)
  const [keyStatus, setKeyStatus] = useState('')
  const [visibleSecrets, setVisibleSecrets] = useState<Record<SecretFieldId, boolean>>({
    decryptKey: false,
    imageXorKey: false,
    imageAesKey: false
  })
  const [copiedSecret, setCopiedSecret] = useState<SecretFieldId | null>(null)
  const copyTimerRef = useRef<number | null>(null)
  const mounted = useRef(false)
  const keyRequest = useRef(0)
  const keyBusy = useRef(false)
  const activeKeyRequest = useRef<number | null>(null)
  const removeKeyStatus = useRef<(() => void) | null>(null)
  const verifyRequest = useRef(0)
  const scanRequest = useRef(0)
  const readFormIdentity = () => {
    const config = useSettingsStore.getState().config
    return JSON.stringify([config.dbPath, config.decryptKey, config.wxid, config.editingAccountId])
  }

  useEffect(() => {
    mounted.current = true
    void refreshAccountsState()
    return () => {
      mounted.current = false
      keyRequest.current++
      verifyRequest.current++
      scanRequest.current++
      removeKeyStatus.current?.()
      if (keyBusy.current) void window.electronAPI.wxKey.cancel().catch(() => {})
      keyBusy.current = false
      activeKeyRequest.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  const getAccountDisplayName = (account?: AccountProfile | null) => {
    if (!account) return '未命名账号'

    const activeNickname = account.id === activeAccountId ? userInfo?.nickName?.trim() : ''
    if (activeNickname) return activeNickname

    const savedName = account.displayName?.trim()
    if (savedName && savedName !== '未命名账号') return savedName

    return account.wxid?.trim() || '未命名账号'
  }

  const applyAccountToForm = (account: AccountProfile | null) => {
    rebaseFields({
      editingAccountId: account?.id || '',
      decryptKey: account?.decryptKey || '',
      dbPath: account?.dbPath || '',
      wxid: account?.wxid || '',
      cachePath: account?.cachePath || '',
      imageXorKey: account?.imageXorKey || '',
      imageAesKey: account?.imageAesKey || '',
      displayName: account?.displayName || '',
      wechatNumber: account?.wechatNumber || '',
      phone: account?.phone || '',
    })
    setIsAccountVerified(Boolean(account?.decryptKey && account?.dbPath && account?.wxid))
  }

  const refreshAccountsState = async (preferredEditingId?: string) => {
    const request = keyRequest.current
    const initialIdentity = readFormIdentity()
    const [accounts, activeAccount] = await Promise.all([
      configService.listAccounts(),
      configService.getActiveAccount()
    ])
    const editingId = preferredEditingId || activeAccount?.id || accounts[0]?.id || ''
    const editingAccount = accounts.find(item => item.id === editingId) || activeAccount || accounts[0] || null
    if (mounted.current && request === keyRequest.current && initialIdentity === readFormIdentity()) {
      setAccountsList(accounts)
      setActiveAccountId(activeAccount?.id || '')
      applyAccountToForm(editingAccount)
    }
    return { accounts, activeAccount, editingAccount }
  }

  const handleGetKey = async () => {
    if (!mounted.current || keyBusy.current) return
    const request = ++keyRequest.current
    keyBusy.current = true
    activeKeyRequest.current = request
    let expectedIdentity = readFormIdentity()
    const isCurrent = () => mounted.current && request === keyRequest.current && readFormIdentity() === expectedIdentity
    const applyKey = (key: string) => { setDecryptKey(key); expectedIdentity = readFormIdentity() }
    const applyWxid = (value: string) => { setWxid(value); expectedIdentity = readFormIdentity() }
    setIsGettingKey(true)
    setKeyStatus('正在检查连接环境…')

    let cleanupStatus: (() => void) | undefined
    try {
      const report = await readiness.refresh()
      if (!isCurrent()) return
      if (!report?.canAutoGet) { showMessage(report?.summary || '请先完成环境检查', false); return }
      const unsubscribe = window.electronAPI.wxKey.onStatus(({ status }) => {
        if (isCurrent()) setKeyStatus(status)
      })
      let listening = true
      cleanupStatus = () => {
        if (!listening) return
        listening = false
        unsubscribe()
        if (removeKeyStatus.current === cleanupStatus) removeKeyStatus.current = null
      }
      removeKeyStatus.current = cleanupStatus

      const result = await window.electronAPI.wxKey.startGetKey(undefined, dbPath || undefined, wxid || undefined)
      cleanupStatus()
      if (!isCurrent()) return
      if (!result.success || !result.key || !isValidDatabaseKey(result.key)) {
        showMessage(result.error || '获取密钥失败', false)
        setKeyStatus('')
        return
      }
      applyKey(result.key)
      setIsAccountVerified(false)
      const acc = result.account
      if (acc) {
        if (acc.name) setField('displayName', acc.name)
        if (acc.number) setField('wechatNumber', acc.number)
        if (acc.phone) setField('phone', acc.phone)
      }
      let validatedWxid = result.validatedWxid
      if (!validatedWxid && isMac && dbPath) {
        setKeyStatus('密钥已获取，正在验证账号目录…')
        const resolved = await window.electronAPI.wcdb.resolveValidWxid(dbPath, result.key)
        if (!isCurrent()) return
        if (resolved.success) validatedWxid = resolved.wxid
      }
      if (validatedWxid) {
        applyWxid(validatedWxid)
        setIsAccountVerified(true)
        showMessage(`密钥获取成功！已验证账号: ${validatedWxid}`, true)
        setKeyStatus('')
        return
      }
      if (acc?.wxid) {
        applyWxid(acc.wxid)
        showMessage(`密钥获取成功！已识别候选账号: ${acc.wxid}，请继续验证目录。`, true)
        setKeyStatus('')
        return
      }

      setKeyStatus('正在检测当前登录账号…')
      let accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10)
      if (!isCurrent()) return
      if (!accountInfo) {
        accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60)
        if (!isCurrent()) return
      }
      if (accountInfo) {
        applyWxid(accountInfo.wxid)
        showMessage(`密钥获取成功！已识别候选账号: ${accountInfo.wxid}，请继续验证目录。`, true)
      } else {
        const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
        if (!isCurrent()) return
        setWxidOptions(wxids)
        if (wxids.length === 1) applyWxid(wxids[0])
        showMessage(wxids.length
          ? `密钥获取成功，识别到 ${wxids.length} 个候选账号目录，请选择后验证。`
          : '密钥获取成功，请手动填写账号目录后继续验证。', true)
      }
      setKeyStatus('')
    } catch (e) {
      if (!isCurrent()) return
      showMessage(`获取密钥失败: ${e}`, false)
      setKeyStatus('')
    } finally {
      cleanupStatus?.()
      if (activeKeyRequest.current === request) {
        activeKeyRequest.current = null
        keyBusy.current = false
        if (mounted.current) setIsGettingKey(false)
      }
    }
  }

  const handleCancelGetKey = async () => {
    if (!mounted.current || activeKeyRequest.current === null) return
    const request = ++keyRequest.current
    activeKeyRequest.current = null
    verifyRequest.current++
    scanRequest.current++
    removeKeyStatus.current?.()
    setIsVerifyingAccount(false)
    setIsScanningWxid(false)
    setKeyStatus('正在取消…')
    try {
      await window.electronAPI.wxKey.cancel()
      if (mounted.current && request === keyRequest.current) setKeyStatus('已取消获取密钥')
    } catch {
      if (mounted.current && request === keyRequest.current) showMessage('取消未确认，请等待当前操作结束。', false)
    } finally {
      if (mounted.current && request === keyRequest.current) {
        keyBusy.current = false
        setIsGettingKey(false)
      }
    }
  }

  const handleOpenWelcomeWindow = async () => {
    try {
      await window.electronAPI.window.openWelcomeWindow('add-account')
    } catch (e) {
      showMessage('打开引导窗口失败', false)
    }
  }

  const handleSwitchAccountAndReconnect = async (account: AccountProfile) => {
    if (account.id === activeAccountId) {
      showMessage('当前没有待切换账号', false)
      return
    }

    if (hasUnsavedAccountChanges) {
      showMessage('当前账号配置有未保存的修改，请先保存再执行切换', false)
      return
    }

    const target = account
    if (!target.dbPath || !target.decryptKey || !target.wxid) {
      showMessage('待切换账号配置不完整，请先保存并补全账号信息', false)
      return
    }

    setIsLoadingState(true)
    setLoading(true, '正在切换账号...')
    try {
      const switched = await configService.setActiveAccount(target.id)
      if (!switched) {
        throw new Error('切换账号失败')
      }

      const result = await window.electronAPI.wcdb.testConnection(target.dbPath, target.decryptKey, target.wxid)
      if (!result.success) {
        throw new Error(result.error || '账号重连失败')
      }

      await window.electronAPI.chat.close()
      await window.electronAPI.chat.refreshCache()
      await window.electronAPI.chat.connect()
      setDbConnected(true, target.dbPath)
      setCurrentWxid(target.wxid)
      await refreshAccountsState(target.id)
      showMessage(`已切换到账号：${getAccountDisplayName(target)}`, true)
    } catch (e) {
      showMessage(`切换账号失败: ${e}`, false)
    } finally {
      setIsLoadingState(false)
      setLoading(false)
    }
  }

  const handleSelectDbPath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择微信数据库根目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setDbPath(result.filePaths[0])
        setWxid('')
        setWxidOptions([])
        setIsAccountVerified(false)
        showMessage('已选择数据库目录', true)
      }
    } catch (e) {
      showMessage('选择目录失败', false)
    }
  }

  const handleSelectCachePath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择缓存目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setCachePath(result.filePaths[0])
        showMessage('已选择缓存目录', true)
      }
    } catch (e) {
      showMessage('选择缓存目录失败', false)
    }
  }

  // 扫描 wxid
  const handleScanWxid = async () => {
    if (!mounted.current) return
    if (!dbPath) {
      showMessage('请先配置数据库路径', false)
      return
    }
    if (isScanningWxid) return

    const request = ++scanRequest.current
    const identity = readFormIdentity()
    const isCurrent = () => mounted.current && request === scanRequest.current && readFormIdentity() === identity
    setIsScanningWxid(true)
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      if (!isCurrent()) return
      setIsAccountVerified(false)
      if (wxids.length === 0) {
        showMessage('未检测到账号目录（需包含 db_storage 文件夹）', false)
        setWxidOptions([])
      } else if (wxids.length === 1) {
        // 只有一个账号，直接设置
        setWxid(wxids[0])
        showMessage(`已检测到候选账号目录：${wxids[0]}（待验证）`, true)
        setWxidOptions([])
      } else {
        let selectedWxid = ''

        if (isValidDatabaseKey(decryptKey)) {
          const resolved = await window.electronAPI.wcdb.resolveValidWxid(dbPath, decryptKey)
          if (!isCurrent()) return
          if (resolved.success && resolved.wxid && wxids.includes(resolved.wxid)) {
            selectedWxid = resolved.wxid
            setWxid(selectedWxid)
          }
        }

        if (!selectedWxid) {
          let accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10)
          if (!isCurrent()) return
          if (!accountInfo) {
            accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60)
            if (!isCurrent()) return
          }

          if (accountInfo && wxids.includes(accountInfo.wxid)) {
            selectedWxid = accountInfo.wxid
            setWxid(selectedWxid)
          }
        }

        setWxidOptions(wxids)
        showMessage(
          selectedWxid
            ? `检测到 ${wxids.length} 个候选账号目录，已按最新活动优先选择：${selectedWxid}`
            : `检测到 ${wxids.length} 个候选账号目录，请选择后验证`,
          true
        )
      }
    } catch (e) {
      if (!isCurrent()) return
      showMessage(`扫描失败: ${e}`, false)
    } finally {
      if (mounted.current && request === scanRequest.current) setIsScanningWxid(false)
    }
  }

  // 选择 wxid
  const handleSelectWxid = async (selectedWxid: string) => {
    setWxid(selectedWxid)
    setIsAccountVerified(false)
    showMessage(`已选择候选账号目录：${selectedWxid}（待验证）`, true)
  }

  const handleVerifyAccountDirectory = async () => {
    if (!mounted.current) return
    if (!dbPath) { showMessage('请先选择数据库目录', false); return }
    if (!decryptKey || !isValidDatabaseKey(decryptKey)) { showMessage('请先配置64位解密密钥', false); return }
    if (!wxid) { showMessage('请先选择账号目录', false); return }

    const request = ++verifyRequest.current
    const identity = readFormIdentity()
    const isCurrent = () => mounted.current && request === verifyRequest.current && readFormIdentity() === identity
    setIsVerifyingAccount(true)
    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (!isCurrent()) return
      if (result.success) {
        setIsAccountVerified(true)
        showMessage(`账号目录验证成功：${wxid}`, true)
      } else {
        setIsAccountVerified(false)
        showMessage(result.error || '账号目录验证失败，请更换目录重试', false)
      }
    } catch (e) {
      if (!isCurrent()) return
      setIsAccountVerified(false)
      showMessage(`账号目录验证失败: ${e}`, false)
    } finally {
      if (mounted.current && request === verifyRequest.current) setIsVerifyingAccount(false)
    }
  }

  const handleTestConnection = async () => {
    if (!dbPath) { showMessage('请先选择数据库目录', false); return }
    if (!decryptKey) { showMessage('请先输入解密密钥', false); return }
    if (!isValidDatabaseKey(decryptKey)) { showMessage('密钥必须是64位十六进制字符（0–9、a–f）', false); return }
    if (!wxid) { showMessage('请先选择账号目录', false); return }
    if (!isAccountVerified) { showMessage('请先验证账号目录', false); return }

    setIsTesting(true)
    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (result.success) {
        showMessage('连接测试成功！数据库可正常访问', true)
      } else {
        showMessage(result.error || '连接测试失败', false)
      }
    } catch (e) {
      showMessage(`连接测试失败: ${e}`, false)
    } finally {
      setIsTesting(false)
    }
  }

  const toggleSecretVisibility = (id: SecretFieldId) => {
    setVisibleSecrets(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const handleCopySecret = async (id: SecretFieldId, value: string) => {
    if (!value) return

    try {
      await navigator.clipboard.writeText(value)
      setCopiedSecret(id)

      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }

      copyTimerRef.current = window.setTimeout(() => {
        setCopiedSecret(null)
        copyTimerRef.current = null
      }, 1400)
    } catch (error) {
      setCopiedSecret(null)
      console.error('复制密钥失败:', error)
    }
  }

  const renderStatus = (message: string) => {
    if (!message) return null

    return (
      <Alert status="accent">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{message}</Alert.Title>
        </Alert.Content>
      </Alert>
    )
  }

  const renderPathField = ({
    label,
    helperText,
    placeholder,
    value,
    onChange,
    onBrowse,
    onReset,
    browseLabel = '浏览选择',
    resetLabel = '恢复默认'
  }: PathFieldOptions) => (
    <TextField fullWidth value={value} onChange={onChange}>
      <Label>{label}</Label>
      <InputGroup fullWidth variant="secondary">
        <InputGroup.Input placeholder={placeholder} />
        {(onBrowse || onReset) && (
          <InputGroup.Suffix className="pr-0">
            {onBrowse && (
              <Button type="button" variant="ghost" size="sm" isIconOnly onPress={onBrowse} aria-label={browseLabel}>
                <FolderOpen width={16} height={16} />
              </Button>
            )}
            {onReset && (
              <Button type="button" variant="ghost" size="sm" isIconOnly onPress={onReset} aria-label={resetLabel}>
                <ArrowRotateLeft width={16} height={16} />
              </Button>
            )}
          </InputGroup.Suffix>
        )}
      </InputGroup>
      <Description>{helperText}</Description>
    </TextField>
  )

  const renderSecretField = ({
    id,
    label,
    helperText,
    placeholder,
    value,
    onChange
  }: SecretFieldOptions) => {
    const visible = visibleSecrets[id]
    const copied = copiedSecret === id

    return (
      <TextField fullWidth value={value} onChange={onChange}>
        <Label>{label}</Label>
        <InputGroup fullWidth variant="secondary">
          <InputGroup.Input type={visible ? 'text' : 'password'} placeholder={placeholder} />
          <InputGroup.Suffix className="pr-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              isIconOnly
              onPress={() => toggleSecretVisibility(id)}
              aria-label={visible ? '隐藏密钥' : '显示密钥'}
            >
              {visible ? <EyeSlash width={16} height={16} /> : <Eye width={16} height={16} />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              isIconOnly
              onPress={() => handleCopySecret(id, value)}
              isDisabled={!value}
              aria-label={copied ? '密钥已复制' : '复制密钥'}
            >
              {copied ? <Check width={16} height={16} /> : <Copy width={16} height={16} />}
            </Button>
          </InputGroup.Suffix>
        </InputGroup>
        <Description>{helperText}</Description>
      </TextField>
    )
  }

  const renderDatabaseTab = () => {
    return (
    <div className="tab-content space-y-8">
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Typography.Heading level={3} className="text-lg font-semibold text-foreground">
            账号管理
          </Typography.Heading>
          <Button type="button" variant="primary" size="sm" onPress={handleOpenWelcomeWindow}>
            <Thunderbolt width={16} height={16} /> 新增账号
          </Button>
        </div>

        {accountsList.length > 0 ? (
          <div className="space-y-3">
            <Typography.Paragraph size="sm" color="muted">{accountsList.length} 个账号</Typography.Paragraph>

            {accountsList.map((account) => {
              const isActive = account.id === activeAccountId
              const displayName = getAccountDisplayName(account)
              const fallback = displayName.slice(0, 1).toUpperCase()

              return (
                <Card key={account.id} className="w-full items-stretch sm:flex-row">
                  <Avatar size="lg" color="accent" variant="soft" className="shrink-0 self-center">
                    {isActive && userInfo?.avatarUrl ? (
                      <Avatar.Image src={userInfo.avatarUrl} alt={displayName} />
                    ) : null}
                    <Avatar.Fallback>{fallback}</Avatar.Fallback>
                  </Avatar>

                  <div className="flex min-w-0 flex-1 flex-col gap-3">
                    <Card.Header className="gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Card.Title className="truncate text-base">{displayName}</Card.Title>
                        {isActive && (
                          <Chip size="sm" variant="primary" color="success">
                            <CircleCheck width={12} height={12} />
                            <Chip.Label>当前激活</Chip.Label>
                          </Chip>
                        )}
                      </div>
                      <Card.Description className="truncate">微信 ID：{account.wxid || '未设置'}</Card.Description>
                      {(account.wechatNumber || account.phone) && (
                        <Card.Description className="truncate">
                          {[
                            account.wechatNumber && `微信号：${account.wechatNumber}`,
                            account.phone && `手机号：${account.phone}`,
                          ].filter(Boolean).join('　')}
                        </Card.Description>
                      )}
                    </Card.Header>

                    <Card.Footer className="mt-auto flex w-full flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <span className="block text-xs text-muted">数据库目录</span>
                        <span className="block truncate text-sm font-medium text-foreground">
                          {account.dbPath || '未设置数据库路径'}
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant={isActive ? 'outline' : 'secondary'}
                        size="sm"
                        className="w-full sm:w-auto"
                        onPress={() => handleSwitchAccountAndReconnect(account)}
                        isDisabled={isActive || isLoading}
                      >
                        <ArrowsRotateLeft width={16} height={16} className={isLoading && !isActive ? 'spin' : undefined} />
                        {isActive ? '当前账号' : '切换并重连'}
                      </Button>
                    </Card.Footer>
                  </div>
                </Card>
              )
            })}
          </div>
        ) : (
          <Alert status="default">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>暂无已保存账号</Alert.Title>
              <Alert.Description>请先新增一个账号。</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
      </section>

      <Separator variant="tertiary" />

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]">
        <div className="space-y-8">
          <section>
            <Card className="h-fit">
              <Card.Header>
                <Card.Title>数据库配置</Card.Title>
                <Card.Description>
                  {isMac
                    ? '登录时获取会在微信登录后自动校验账号。已有可用连接无需重复获取。'
                    : '配置微信数据库路径和解密密钥。'}
                </Card.Description>
              </Card.Header>
              <Card.Content>
                <div className="mb-4"><WechatReadiness report={readiness.report} checking={readiness.checking} error={readiness.error} onRefresh={() => void readiness.refresh()} /></div>
                {isMac && <div className="mb-4"><WechatLoginCaptureGuide
                  busy={isGettingKey} disabled={readiness.checking || !readiness.report?.canAutoGet || !dbPath}
                  status={keyStatus} onStart={() => void handleGetKey()} onCancel={() => void handleCancelGetKey()}
                /></div>}
                <Fieldset>
                  <Fieldset.Group className="grid gap-4">
                    {renderSecretField({
                      id: 'decryptKey',
                      label: '解密密钥',
                      helperText: isMac
                        ? '64位十六进制密钥。可使用已有密钥，或按上方步骤重新获取。'
                        : '64位十六进制密钥，用于验证当前账号数据库连接',
                      placeholder: '请输入或自动获取解密密钥',
                      value: decryptKey,
                      onChange: (value) => {
                        setDecryptKey(normalizeDatabaseKey(value))
                        setIsAccountVerified(false)
                      }
                    })}
                    {!isMac && renderStatus(keyStatus)}
                    {renderPathField({
                      label: '数据库根目录',
                      helperText: '选择微信账号数据所在目录，通常是 WeChat Files 的上级或包含 db_storage 的目录',
                      placeholder: '请选择微信数据库根目录',
                      value: dbPath,
                      onChange: (value) => {
                        setDbPath(value)
                        setWxid('')
                        setWxidOptions([])
                        setIsAccountVerified(false)
                      },
                      onBrowse: handleSelectDbPath
                    })}
                  </Fieldset.Group>
                </Fieldset>
              </Card.Content>
              {!isMac && <Card.Footer className="flex flex-wrap gap-2">
                <Button type="button" variant="primary" size="sm" onPress={handleGetKey} isDisabled={isGettingKey || readiness.checking || !readiness.report?.canAutoGet}>
                  <Key width={16} height={16} /> {isGettingKey ? '获取中...' : '自动获取密钥'}
                </Button>
                {isGettingKey && (
                  <Button type="button" variant="outline" size="sm" onPress={handleCancelGetKey}>
                    <Xmark width={16} height={16} /> 取消
                  </Button>
                )}
              </Card.Footer>}
            </Card>
          </section>

          <section>
            <Card className="h-fit">
              <Card.Header className="flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                  <Card.Title>账号验证</Card.Title>
                  <Card.Description>确认 wxid 与数据库目录匹配。</Card.Description>
                </div>
                <Chip size="sm" variant="soft" color={isAccountVerified ? 'success' : 'warning'}>
                  <Chip.Label>{isAccountVerified ? '已验证' : '未验证'}</Chip.Label>
                </Chip>
              </Card.Header>
              <Card.Content>
                <Fieldset>
                  <Fieldset.Group className="grid gap-4">
                    <ComboBox
                      allowsCustomValue
                      fullWidth
                      inputValue={wxid}
                      selectedKey={wxidOptions.includes(wxid) ? wxid : null}
                      onInputChange={(value) => {
                        setWxid(value)
                        setIsAccountVerified(false)
                      }}
                      onSelectionChange={(key) => {
                        if (key != null) void handleSelectWxid(String(key))
                      }}
                      menuTrigger="focus"
                      variant="secondary"
                    >
                      <Label>账号验证配置</Label>
                      <ComboBox.InputGroup>
                        <Input placeholder="例如 wxid_xxxxx" variant="secondary" />
                        <ComboBox.Trigger />
                      </ComboBox.InputGroup>
                      <ComboBox.Popover>
                        <ListBox>
                          {wxidOptions.map((option) => (
                            <ListBox.Item key={option} id={option} textValue={option}>
                              {option}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </ComboBox.Popover>
                      <Description>请选择或填写候选账号目录，验证成功后才会作为当前账号配置保存</Description>
                    </ComboBox>
                  </Fieldset.Group>
                </Fieldset>
              </Card.Content>
              <Card.Footer className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onPress={handleScanWxid} isDisabled={isScanningWxid || !dbPath}>
                  <Magnifier width={16} height={16} className={isScanningWxid ? 'spin' : undefined} /> {isScanningWxid ? '扫描中...' : '扫描账号'}
                </Button>
                <Button type="button" variant="outline" size="sm" onPress={handleVerifyAccountDirectory} isDisabled={isVerifyingAccount || !dbPath || !decryptKey || !wxid}>
                  <ShieldCheck width={16} height={16} /> {isVerifyingAccount ? '验证中...' : '验证账号'}
                </Button>
                <Button type="button" variant="secondary" size="sm" onPress={handleTestConnection} isDisabled={isTesting || !isAccountVerified}>
                  <PlugConnection width={16} height={16} /> {isTesting ? '测试中...' : '测试连接'}
                </Button>
              </Card.Footer>
            </Card>
          </section>
        </div>

        <div className="space-y-8">
          <section>
            <Card className="h-fit">
              <Card.Header>
                <Card.Title>缓存目录</Card.Title>
                <Card.Description>可选配置，留空时使用默认目录。</Card.Description>
              </Card.Header>
              <Card.Content>
                {renderPathField({
                  label: '目录路径',
                  helperText: '建议选择空间充足的磁盘',
                  placeholder: '留空使用默认目录',
                  value: cachePath,
                  onChange: setCachePath,
                  onBrowse: handleSelectCachePath,
                  onReset: () => setCachePath('')
                })}
              </Card.Content>
            </Card>
          </section>

          <section>
            <Card className="h-fit">
              <Card.Header>
                <Card.Title>图片解密</Card.Title>
                <Card.Description>图片解密是可选功能，不影响文字消息分析。</Card.Description>
              </Card.Header>
              <Card.Content>
                <Fieldset>
                  <Fieldset.Group className="grid gap-4">
                    {renderSecretField({
                      id: 'imageXorKey',
                      label: 'XOR 密钥',
                      helperText: isMac ? 'kvcomm 校验成功后返回的 XOR 密钥，格式如 0x53' : '2位十六进制，如 0x53',
                      placeholder: '例如: 0x12',
                      value: imageXorKey,
                      onChange: setImageXorKey
                    })}
                    {renderSecretField({
                      id: 'imageAesKey',
                      label: 'AES 密钥',
                      helperText: isMac ? '16位字符串；优先走 kvcomm + wxid 验真，失败才回退到内存扫描' : '至少16个字符；自动获取时使用 Rust native 内存扫描',
                      placeholder: '例如: b123456789012345...',
                      value: imageAesKey,
                      onChange: setImageAesKey
                    })}
                    {renderStatus(imageKeyStatus)}
                    <Description>
                      {isMac ? '优先扫描 kvcomm 和模板文件；只有前者不可用时才回退到微信进程内存扫描。' : 'Windows 使用 Rust native 扫描微信进程内存；请先在电脑微信中打开几张图片，再执行自动获取。'}
                    </Description>
                  </Fieldset.Group>
                </Fieldset>
              </Card.Content>
              <Card.Footer>
                <Button type="button" variant="primary" size="sm" onPress={handleGetImageKey} isDisabled={isGettingImageKey}>
                  <Picture width={16} height={16} /> {isGettingImageKey ? '获取中...' : '自动获取图片密钥'}
                </Button>
              </Card.Footer>
            </Card>
          </section>
        </div>
      </div>
    </div>
    )
  }

  const [isGettingImageKey, setIsGettingImageKey] = useState(false)
  const [imageKeyStatus, setImageKeyStatus] = useState('')

  const handleGetImageKey = async () => {
    if (isGettingImageKey) return
    if (!dbPath) {
      showMessage('请先配置数据库路径', false)
      return
    }
    if (!wxid) {
      showMessage('请先配置 wxid', false)
      return
    }

    setIsGettingImageKey(true)
    setImageKeyStatus(isMac ? '正在从 kvcomm / 模板文件获取图片密钥...' : '正在通过 Rust native 扫描微信内存...')

    try {
      // 构建用户目录路径（用于 wxid 匹配）
      const separator = dbPath.includes('\\') && !dbPath.includes('/') ? '\\' : '/'
      const userDir = `${dbPath.replace(/[\\/]+$/, '')}${separator}${wxid}`

      const removeListener = window.electronAPI.imageKey.onProgress((msg) => {
        setImageKeyStatus(msg)
      })

      const result = await window.electronAPI.imageKey.getImageKeys(userDir)
      removeListener()

      if (result.success) {
        if (result.xorKey !== undefined) {
          const xorKeyHex = `0x${result.xorKey.toString(16).padStart(2, '0')}`
          setImageXorKey(xorKeyHex)
        }
        if (result.aesKey) {
          setImageAesKey(result.aesKey)
        }
        showMessage('图片密钥获取成功！', true)
        setImageKeyStatus('')
      } else {
        showMessage(result.error || '获取图片密钥失败', false)
        setImageKeyStatus('')
      }
    } catch (e) {
      showMessage(`获取图片密钥失败: ${e}`, false)
      setImageKeyStatus('')
    } finally {
      setIsGettingImageKey(false)
    }
  }


  return (
    <>
      {renderDatabaseTab()}
    </>
  )
}

export default DatabaseTab
