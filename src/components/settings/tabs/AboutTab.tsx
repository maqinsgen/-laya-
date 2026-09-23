import { BRAND } from '../../../shared/brand'
import { Alert, Button, Chip, Label, ProgressBar, Separator, Typography } from '@heroui/react'
import { ArrowDownToLine, ArrowUpRightFromSquare, ArrowsRotateLeft, LogoGithub, ShieldCheck } from '@gravity-ui/icons'
import type { UpdateDownloadProgressPayload } from '../../../types/electron'
import type { UpdateInfo } from '../types'
import { formatFileSize, formatSpeed } from '../utils'

interface AboutTabProps {
  appVersion: string
  updateInfo: UpdateInfo | null
  isDownloading: boolean
  downloadProgress: number
  downloadProgressDetail: UpdateDownloadProgressPayload | null
  isCheckingUpdate: boolean
  onUpdateNow: () => void
  onCheckUpdate: () => void
}

const projectLinks = [
  { label: '上游 CipherTalk', url: 'https://github.com/ILoveBingLu/CipherTalk' },
  { label: 'WeFlow', url: 'https://github.com/hicccc77/WeFlow' }
]

const relatedLinks = [
  { label: '上游官网', url: 'https://miyu.aiqji.com' },
  { label: 'ChatLab', url: 'https://chatlab.fun' }
]

function AboutTab({
  appVersion,
  updateInfo,
  isDownloading,
  downloadProgress,
  downloadProgressDetail,
  isCheckingUpdate,
  onUpdateNow,
  onCheckUpdate
}: AboutTabProps) {
  const updateVersion = updateInfo?.version || updateInfo?.diagnostics?.targetVersion
  const transferredBytes = downloadProgressDetail?.transferred ?? updateInfo?.diagnostics?.downloadedBytes ?? 0
  const totalBytes = downloadProgressDetail?.total ?? updateInfo?.diagnostics?.totalBytes ?? 0
  const currentYear = new Date().getFullYear()
  const updateSourceLabel = updateInfo?.updateSource === 'r2' ? 'R2 镜像' : updateInfo?.updateSource === 'custom' ? '自定义源' : updateInfo?.updateSource === 'github' ? 'GitHub' : '默认'
  const policySourceLabel = updateInfo?.policySource === 'r2' ? 'R2 策略' : updateInfo?.policySource === 'custom' ? '自定义策略' : updateInfo?.policySource === 'github' ? 'GitHub 策略' : '无'

  const openExternal = (url: string) => {
    void window.electronAPI.shell.openExternal(url)
  }

  const openAgreement = () => {
    void window.electronAPI.window.openAgreementWindow()
  }

  const renderUpdateContent = () => {
    if (updateInfo?.hasUpdate) {
      return (
        <div className="space-y-4">
          <Alert status={updateInfo.forceUpdate ? 'warning' : 'success'}>
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>
                {isDownloading
                  ? `正在下载 v${updateVersion || '新版本'}`
                  : updateInfo.forceUpdate
                    ? '检测到强制更新'
                    : `新版本 v${updateVersion || '...'} 可用`}
              </Alert.Title>
              {(updateInfo.message || updateInfo.title || updateInfo.releaseNotes) && (
                <Alert.Description>
                  {updateInfo.message || updateInfo.title || updateInfo.releaseNotes}
                </Alert.Description>
              )}
            </Alert.Content>
          </Alert>

          {isDownloading ? (
            <div className="space-y-3">
              <ProgressBar value={downloadProgress} valueLabel={`${downloadProgress.toFixed(0)}%`}>
                <div className="flex items-center justify-between gap-3">
                  <Label>下载进度</Label>
                  <ProgressBar.Output />
                </div>
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
                <span>{formatFileSize(transferredBytes)} / {formatFileSize(totalBytes)}</span>
                <span>速度 {formatSpeed(downloadProgressDetail?.bytesPerSecond ?? 0)}</span>
              </div>
            </div>
          ) : (
            <Button type="button" onPress={onUpdateNow} isDisabled={isDownloading}>
              <ArrowDownToLine width={16} height={16} /> 立即更新
            </Button>
          )}
        </div>
      )
    }

    return (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Typography.Paragraph size="sm" color="muted">
          当前版本已安装。可以手动检查是否有新的稳定版本。
        </Typography.Paragraph>
        <Button
          type="button"
          variant="secondary"
          onPress={onCheckUpdate}
          isDisabled={isCheckingUpdate || isDownloading}
        >
          <ArrowsRotateLeft width={16} height={16} className={isCheckingUpdate ? 'spin' : undefined} />
          {isCheckingUpdate ? '检查中...' : '检查更新'}
        </Button>
      </div>
    )
  }

  return (
    <div className="tab-content space-y-8">
      <section className="flex flex-col gap-6 pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col items-start gap-5 sm:flex-row sm:items-center">
          <img
            src="./notewake-mark.svg"
            alt={BRAND.displayName}
            className="pointer-events-none h-auto w-32 shrink-0 object-contain select-none"
          />
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Typography.Heading level={2} className="text-2xl font-semibold text-foreground">
                {BRAND.displayName}
              </Typography.Heading>
              <Chip size="sm" variant="soft">
                <Chip.Label>v{appVersion || '...'}</Chip.Label>
              </Chip>
            </div>
            <Typography.Paragraph size="sm" color="muted" className="max-w-2xl">
              基于 CipherTalk 的个人信息助手派生版。保留原作者 ILoveBingLu 署名与 CC BY-NC-SA 4.0 许可。
            </Typography.Paragraph>
            <div className="flex flex-wrap items-center gap-2">
              <Chip size="sm" color={updateInfo?.hasUpdate ? 'warning' : 'success'} variant="soft">
                <Chip.Label>{!BRAND.upstreamUpdatesEnabled ? '派生版 · 手动更新' : updateInfo?.hasUpdate ? '有新版本' : '已是当前版本'}</Chip.Label>
              </Chip>
              <Chip size="sm" variant="secondary">
                <Chip.Label>本地数据</Chip.Label>
              </Chip>
              <Chip size="sm" variant="secondary">
                <Chip.Label>免费软件</Chip.Label>
              </Chip>
            </div>
          </div>
        </div>
      </section>

      <Separator />

      <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-4">
          <div className="space-y-1">
            <Typography.Heading level={3} className="text-lg font-semibold text-foreground">软件更新</Typography.Heading>
            <Typography.Paragraph size="sm" color="muted">检查更新、下载新版本，并查看当前更新状态。</Typography.Paragraph>
          </div>
          {BRAND.upstreamUpdatesEnabled ? renderUpdateContent() : <Typography.Paragraph size="sm" color="muted">独立更新源尚未配置。此版本不会下载上游安装包覆盖你的改进，请使用维护者提供的版本手动更新。</Typography.Paragraph>}
        </div>

        <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
          <div className="space-y-1">
            <dt className="text-xs text-muted">当前版本</dt>
            <dd className="text-sm font-medium text-foreground">v{appVersion || '...'}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted">更新通道</dt>
            <dd className="text-sm font-medium text-foreground">{BRAND.upstreamUpdatesEnabled ? updateSourceLabel : '手动更新'}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted">策略来源</dt>
            <dd className="text-sm font-medium text-foreground">{BRAND.upstreamUpdatesEnabled ? policySourceLabel : '不使用上游强制更新策略'}</dd>
          </div>
        </dl>
      </section>

      <Separator />

      <section className="grid gap-8 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="space-y-1">
            <Typography.Heading level={3} className="text-lg font-semibold text-foreground">开源项目</Typography.Heading>
            <Typography.Paragraph size="sm" color="muted">项目源码与相关依赖。</Typography.Paragraph>
          </div>
          <div className="flex flex-col gap-2">
            {projectLinks.map(link => (
              <Button
                key={link.url}
                type="button"
                variant="secondary"
                className="w-full justify-start"
                onPress={() => openExternal(link.url)}
              >
                <LogoGithub width={16} height={16} />
                {link.label}
                <ArrowUpRightFromSquare width={14} height={14} className="ml-auto" />
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <Typography.Heading level={3} className="text-lg font-semibold text-foreground">相关链接</Typography.Heading>
            <Typography.Paragraph size="sm" color="muted">官方网站、配套产品与用户协议。</Typography.Paragraph>
          </div>
          <div className="flex flex-col gap-2">
            {relatedLinks.map(link => (
              <Button
                key={link.url}
                type="button"
                variant="secondary"
                className="w-full justify-start"
                onPress={() => openExternal(link.url)}
              >
                <ArrowUpRightFromSquare width={16} height={16} />
                {link.label}
              </Button>
            ))}
            <Button type="button" variant="outline" className="w-full justify-start" onPress={openAgreement}>
              <ShieldCheck width={16} height={16} />
              用户协议
            </Button>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>免费软件声明</Alert.Title>
            <Alert.Description>
              本软件免费提供。如发现未经授权的付费售卖或二次分发，请谨慎辨别，并优先从官方渠道获取。
            </Alert.Description>
          </Alert.Content>
        </Alert>
        <Typography.Paragraph size="xs" color="muted" className="text-center">
          基于 CipherTalk · 原作者 ILoveBingLu · CC BY-NC-SA 4.0
        </Typography.Paragraph>
      </section>
    </div>
  )
}

export default AboutTab
