import { basename, delimiter, dirname, join } from 'path'
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs'
import { WindowsSqlcipherReader, type WindowsSqlcipherKeyMaterial } from './windowsSqlcipher'
import { decodeMessageContent, getRowField, coerceRowNumber } from './chat/rowDecoders'

// 消息表 local_type 列在不同微信版本下的可能列名
const MSG_TYPE_COLUMNS = [
  'local_type', 'localType', 'type', 'Type',
  'msg_type', 'msgType', 'MsgType',
  'message_type', 'messageType', 'WCDB_CT_local_type'
]

/**
 * WcdbCore —— 直连微信加密数据库的底层封装。
 * - 不依赖 Electron `app`，可在 utilityProcess 中实例化
 * - 所有资源路径通过 setPaths() 注入
 * - C 符号按需探测，未绑定的新符号不会导致初始化失败（特性可降级）
 */
export class WcdbCore {
  private lib: any = null
  private koffi: any = null
  private initialized = false
  private handle: number | null = null
  private currentPath: string | null = null
  private currentKey: string | null = null
  private currentWxid: string | null = null
  private currentDbStoragePath: string | null = null
  private resourcesPath: string | null = null
  private userDataPath: string | null = null
  private appVersion = ''

  // 已暴露的 C 符号
  private wcdbInit: any = null
  private wcdbShutdown: any = null
  private wcdbOpenAccount: any = null
  private wcdbCloseAccount: any = null
  private wcdbFreeString: any = null
  private wcdbGetLogs: any = null
  private wcdbGetSnsTimeline: any = null
  private wcdbExecQuery: any = null

  // 预留的 C 符号（native 未实现则置 null，特性降级）
  private wcdbExecQueryWithParams: any = null
  private wcdbExportMessageChunk: any = null
  private wcdbGetMessages: any = null
  private wcdbStartMonitorPipe: any = null
  private wcdbStopMonitorPipe: any = null
  private wcdbGetMonitorPipeName: any = null
  private wcdbSetMyWxid: any = null
  private wcdbSetAppVersion: any = null
  private wcdbSetClientInfo: any = null
  private wcdbCheckLicense: any = null

  // 官方 libwcdb_api 被云端拒绝后，直接走 libWCDB 里的 SQLCipher。
  private windowsReader: WindowsSqlcipherReader | null = null
  private currentDatabaseKeys: Record<string, string> | undefined
  private sqliteMode = false
  private preferSqliteFallback = false
  private sqliteOpen: any = null
  private sqliteClose: any = null
  private sqliteKeyFn: any = null
  private sqliteExec: any = null
  private sqlitePrepare: any = null
  private sqliteStep: any = null
  private sqliteFinalize: any = null
  private sqliteColumnCount: any = null
  private sqliteColumnName: any = null
  private sqliteColumnType: any = null
  private sqliteColumnText: any = null
  private sqliteColumnInt64: any = null
  private sqliteColumnDouble: any = null
  private sqliteColumnBlob: any = null
  private sqliteColumnBytes: any = null
  private sqliteErrmsg: any = null
  private sqliteHandles = new Map<string, any>()

  // 管道监控状态
  private monitorPipeClient: any = null
  private monitorCallback: ((type: string, json: string) => void) | null = null
  private monitorReconnectTimer: any = null
  private monitorPipePath: string = ''

  setPaths(resourcesPath: string, userDataPath: string, appVersion = ''): void {
    this.resourcesPath = resourcesPath
    this.userDataPath = userDataPath
    this.appVersion = appVersion
  }

  getUserDataPath(): string | null { return this.userDataPath }

  private getLibraryPath(): string {
    const baseDir = this.resourcesPath || join(process.cwd(), 'resources')
    if (process.platform === 'darwin') return join(baseDir, 'macos', 'libwcdb_api.dylib')
    return join(baseDir, 'wcdb_api.dll')
  }

  private getWindowsCoreLibraryPath(): string {
    const baseDir = this.resourcesPath || join(process.cwd(), 'resources')
    return join(baseDir, 'WCDB.dll')
  }

  private getCoreLibraryPath(): string {
    const baseDir = this.resourcesPath || join(process.cwd(), 'resources')
    if (process.platform === 'darwin') return join(baseDir, 'macos', 'libWCDB.dylib')
    return this.getWindowsCoreLibraryPath()
  }

  private prepareWindowsDllSearchPath(libraryPath: string): { success: boolean; error?: string } {
    if (process.platform === 'darwin') {
      const dylibDir = dirname(libraryPath)
      const currentDyld = process.env.DYLD_LIBRARY_PATH || ''
      if (!currentDyld.includes(dylibDir)) {
        process.env.DYLD_LIBRARY_PATH = dylibDir + (currentDyld ? ':' + currentDyld : '')
      }
      return { success: true }
    }

    if (process.platform !== 'win32') return { success: true }

    const wcdbCorePath = this.getWindowsCoreLibraryPath()
    if (!existsSync(wcdbCorePath)) {
      return { success: false, error: `WCDB 依赖库不存在: ${wcdbCorePath}` }
    }

    const dllDir = dirname(libraryPath)
    const pathParts = (process.env.PATH || '').split(delimiter).filter(Boolean)
    const hasDllDir = pathParts.some(item => item.toLowerCase() === dllDir.toLowerCase())
    if (!hasDllDir) {
      process.env.PATH = [dllDir, ...pathParts].join(delimiter)
    }

    return { success: true }
  }

  async initialize(): Promise<{ success: boolean; error?: string }> {
    if (this.initialized) return { success: true }
    // Windows uses the independently built SQLCipher reader. It never loads
    // the inherited time-limited wcdb_api.dll, including on reader failures.
    if (process.platform === 'win32') {
      const runtime = WindowsSqlcipherReader.checkRuntime()
      if (!runtime.ok) return { success: false, error: runtime.error || 'Windows 数据库读取组件不可用，请安装完整版本。' }
      this.windowsReader = new WindowsSqlcipherReader()
      this.sqliteMode = true
      this.initialized = true
      return { success: true }
    }

    try {
      this.koffi = require('koffi')
      const libraryPath = this.getLibraryPath()
      if (!existsSync(libraryPath)) {
        const fallback = this.initializeSqliteFallback()
        if (fallback.success) return fallback
        return { success: false, error: `WCDB 原生库不存在: ${libraryPath}` }
      }

      const dllSearchRes = this.prepareWindowsDllSearchPath(libraryPath)
      if (!dllSearchRes.success) return dllSearchRes

      if (this.preferSqliteFallback || this.hasDeniedNativeLicense()) {
        const fallback = this.initializeSqliteFallback()
        if (fallback.success) return fallback
      }

      this.lib = this.koffi.load(libraryPath)

      // 绑定已确定暴露的符号
      this.wcdbInit = this.lib.func('int32 wcdb_init()')
      this.wcdbShutdown = this.lib.func('int32 wcdb_shutdown()')
      this.wcdbOpenAccount = this.lib.func('int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)')
      this.wcdbCloseAccount = this.lib.func('int32 wcdb_close_account(int64 handle)')
      this.wcdbFreeString = this.lib.func('void wcdb_free_string(void* ptr)')
      this.wcdbGetLogs = this.lib.func('int32 wcdb_get_logs(_Out_ void** outJson)')
      this.wcdbGetSnsTimeline = this.lib.func('int32 wcdb_get_sns_timeline(int64 handle, int32 limit, int32 offset, const char* username, const char* keyword, int32 startTime, int32 endTime, _Out_ void** outJson)')
      this.wcdbExecQuery = this.lib.func('int32 wcdb_exec_query(int64 handle, const char* kind, const char* path, const char* sql, _Out_ void** outJson)')

      // 预留符号：native 若未实现则保持 null，特性降级
      const tryBind = (decl: string): any => {
        try { return this.lib.func(decl) } catch { return null }
      }
      this.wcdbExecQueryWithParams = tryBind('int32 wcdb_exec_query_with_params(int64 handle, const char* kind, const char* path, const char* sql, const char* argsJson, _Out_ void** outJson)')
      this.wcdbExportMessageChunk = tryBind('int32 wcdb_export_message_chunk(int64 handle, const char* kind, const char* path, const char* tableName, int64 afterRid, int32 maxRows, int32 startTime, int32 endTime, const char* extraColsJson, _Out_ void** outJson)')
      this.wcdbGetMessages = tryBind('int32 wcdb_get_messages(int64 handle, const char* username, int32 limit, int32 offset, _Out_ void** outJson)')
      this.wcdbStartMonitorPipe = tryBind('int32 wcdb_start_monitor_pipe()')
      this.wcdbStopMonitorPipe = tryBind('int32 wcdb_stop_monitor_pipe()')
      this.wcdbGetMonitorPipeName = tryBind('int32 wcdb_get_monitor_pipe_name(_Out_ void** outName)')
      this.wcdbSetMyWxid = tryBind('int32 wcdb_set_my_wxid(int64 handle, const char* wxid)')
      this.wcdbSetClientInfo = tryBind('int32 wcdb_set_client_info(const char* applicationId, const char* clientType, const char* appVersion)')
      this.wcdbCheckLicense = tryBind('int32 wcdb_check_license()')
      this.wcdbSetAppVersion = tryBind('int32 wcdb_set_app_version(const char* version)')

      const setVersionResult = this.wcdbSetClientInfo
        ? this.wcdbSetClientInfo('ciphertalk', 'desktop', this.appVersion)
        : this.wcdbSetAppVersion
          ? this.wcdbSetAppVersion(this.appVersion)
          : 0
      if (setVersionResult !== 0) {
        return this.fallbackFromLicensed(await this.formatNativeError(setVersionResult))
      }

      if (this.wcdbCheckLicense) {
        const licenseResult = this.wcdbCheckLicense()
        if (licenseResult !== 0) {
          return this.fallbackFromLicensed(await this.formatNativeError(licenseResult))
        }
      }

      const initResult = this.wcdbInit()
      if (initResult !== 0) {
        return this.fallbackFromLicensed(await this.formatNativeError(initResult))
      }

      this.initialized = true
      this.sqliteMode = false
      return { success: true }
    } catch (e: any) {
      return this.fallbackFromLicensed(`WCDB 初始化异常: ${e.message || String(e)}`)
    }
  }

  private fallbackFromLicensed(licensedError: string): { success: boolean; error?: string } {
    this.preferSqliteFallback = true
    const fallback = this.initializeSqliteFallback()
    if (fallback.success) return fallback
    return { success: false, error: licensedError }
  }

  private hasDeniedNativeLicense(): boolean {
    try {
      const leasePath = join(
        process.env.HOME || '',
        'Library/Application Support/WCDBApi/licenses/ciphertalk.jws'
      )
      if (!existsSync(leasePath)) return false
      const payloadPart = readFileSync(leasePath, 'utf8').trim().split('.')[1]
      if (!payloadPart) return false
      const json = Buffer.from(payloadPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
      const payload = JSON.parse(json)
      if (payload?.allowed !== false) return false
      const reason = `${payload?.reason || ''} ${payload?.version_status || ''}`
      return /native_version_too_old|app_version_too_old|native_version_unsupported/i.test(reason)
    } catch {
      return false
    }
  }

  private async formatNativeError(code: number): Promise<string> {
    const logs = await this.printLogs()
    const mapped = this.mapStatusCode(code)
    if (!logs) return mapped
    if (/native_version_too_old|app_version_too_old/i.test(logs)) {
      return `${mapped}（官方桥接库已被云端标记过期，将尝试本地 SQLCipher） | ${logs}`
    }
    return `${mapped} | ${logs}`
  }

  private initializeSqliteFallback(): { success: boolean; error?: string } {
    try {
      if (!this.koffi) this.koffi = require('koffi')
      const corePath = this.getCoreLibraryPath()
      if (!existsSync(corePath)) {
        return { success: false, error: `WCDB 核心库不存在: ${corePath}` }
      }
      this.prepareWindowsDllSearchPath(corePath)
      const lib = this.koffi.load(corePath)
      this.sqliteOpen = lib.func('int sqlite3_open_v2(const char *filename, _Out_ void **ppDb, int flags, const char *zVfs)')
      this.sqliteClose = lib.func('int sqlite3_close_v2(void *db)')
      this.sqliteKeyFn = lib.func('int sqlite3_key(void *db, const void *pKey, int nKey)')
      this.sqliteExec = lib.func('int sqlite3_exec(void *db, const char *sql, void *cb, void *arg, _Out_ void **errmsg)')
      this.sqlitePrepare = lib.func('int sqlite3_prepare_v2(void *db, const char *zSql, int nByte, _Out_ void **ppStmt, _Out_ void **pzTail)')
      this.sqliteStep = lib.func('int sqlite3_step(void *stmt)')
      this.sqliteFinalize = lib.func('int sqlite3_finalize(void *stmt)')
      this.sqliteColumnCount = lib.func('int sqlite3_column_count(void *stmt)')
      this.sqliteColumnName = lib.func('const char *sqlite3_column_name(void *stmt, int iCol)')
      this.sqliteColumnType = lib.func('int sqlite3_column_type(void *stmt, int iCol)')
      this.sqliteColumnText = lib.func('const char *sqlite3_column_text(void *stmt, int iCol)')
      this.sqliteColumnInt64 = lib.func('int64 sqlite3_column_int64(void *stmt, int iCol)')
      this.sqliteColumnDouble = lib.func('double sqlite3_column_double(void *stmt, int iCol)')
      this.sqliteColumnBlob = lib.func('const void *sqlite3_column_blob(void *stmt, int iCol)')
      this.sqliteColumnBytes = lib.func('int sqlite3_column_bytes(void *stmt, int iCol)')
      this.sqliteErrmsg = lib.func('const char *sqlite3_errmsg(void *db)')
      this.sqliteMode = true
      this.initialized = true
      console.warn('[wcdbCore] 官方 WCDB 桥接不可用，已回退到 libWCDB SQLCipher')
      return { success: true }
    } catch (e: any) {
      return { success: false, error: `SQLCipher 回退初始化失败: ${e.message || String(e)}` }
    }
  }

  // ============== 路径解析 ==============
  private findSessionDbs(dir: string, depth = 0, results: string[] = []): string[] {
    if (depth > 5) return results
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (entry.toLowerCase() === 'session.db') {
          const fullPath = join(dir, entry)
          if (statSync(fullPath).isFile() && !results.includes(fullPath)) {
            results.push(fullPath)
          }
        }
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        try {
          if (statSync(fullPath).isDirectory()) {
            this.findSessionDbs(fullPath, depth + 1, results)
          }
        } catch {
          // ignore
        }
      }
    } catch (e) {
      console.error('查找 session.db 失败:', e)
    }
    return results
  }

  private scoreSessionDbPath(filePath: string): number {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase()
    let score = 0
    if (normalized.endsWith('/session/session.db')) score += 40
    if (normalized.includes('/db_storage/session/')) score += 20
    if (normalized.includes('/db_storage/')) score += 10
    return score
  }

  private getCandidateSessionDbs(dbStoragePath: string): string[] {
    return this.findSessionDbs(dbStoragePath)
      .sort((a, b) => this.scoreSessionDbPath(b) - this.scoreSessionDbPath(a) || a.localeCompare(b))
  }

  private resolveDbStoragePath(dbPath: string, wxid: string): string | null {
    if (!dbPath) return null
    const normalizedDbPath = dbPath.replace(/[\\/]+$/, '')
    if (basename(normalizedDbPath).toLowerCase() === 'db_storage' && existsSync(normalizedDbPath)) return normalizedDbPath
    const direct = join(normalizedDbPath, 'db_storage')
    if (existsSync(direct)) return direct
    if (wxid) {
      const viaWxid = join(normalizedDbPath, wxid, 'db_storage')
      if (existsSync(viaWxid)) return viaWxid
      try {
        const lowerWxid = wxid.toLowerCase()
        for (const entry of readdirSync(normalizedDbPath)) {
          const entryPath = join(normalizedDbPath, entry)
          try { if (!statSync(entryPath).isDirectory()) continue } catch { continue }
          const lowerEntry = entry.toLowerCase()
          if (lowerEntry !== lowerWxid && !lowerEntry.startsWith(`${lowerWxid}_`)) continue
          const candidate = join(entryPath, 'db_storage')
          if (existsSync(candidate)) return candidate
        }
      } catch { /* ignore */ }
    }
    return null
  }

  private tryOpenWithCandidates(sessionDbPaths: string[], hexKey: string, storeHandle = true, databaseKeys?: Record<string, string>): { success: boolean; handle?: number; matchedPath?: string; rawKey?: boolean; errors: string[] } {
    const errors: string[] = []
    for (const sessionDbPath of sessionDbPaths) {
      if (this.sqliteMode) {
        const opened = this.sqliteOpenEncrypted(sessionDbPath, hexKey, storeHandle, databaseKeys)
        if (opened.ok) {
          return { success: true, handle: 1, matchedPath: sessionDbPath, rawKey: opened.rawKey, errors }
        }
        errors.push(`${sessionDbPath} => ${opened.error || 'SQLCipher 打开失败'}`)
        continue
      }
      const handleOut = [0]
      const result = this.wcdbOpenAccount(sessionDbPath, hexKey, handleOut)
      if (result === 0 && handleOut[0] > 0) {
        return { success: true, handle: handleOut[0], matchedPath: sessionDbPath, errors }
      }
      errors.push(`${sessionDbPath} => ${this.mapStatusCode(result)}`)
    }
    return { success: false, errors }
  }

  private normalizeHexKey(hexKey: string): string {
    return String(hexKey || '').trim().replace(/^0x/i, '').toLowerCase()
  }

  private sqliteKeyMaterials(hexKey: string): Buffer[] {
    const hex = this.normalizeHexKey(hexKey)
    const materials: Buffer[] = []
    if (/^[0-9a-f]+$/.test(hex) && hex.length % 2 === 0) {
      materials.push(Buffer.from(hex, 'hex'))
    }
    if (hex) materials.push(Buffer.from(hex, 'utf8'))
    // sqlite3_key treats binary/ASCII bytes as passphrases and applies its KDF.
    // A captured derived SQLCipher key needs the 67-byte BLOB literal instead.
    if (/^[0-9a-f]{64}$/.test(hex)) materials.push(Buffer.from(`x'${hex}'`, 'ascii'))
    return materials
  }

  private sqliteExecPragma(db: any, sql: string): void {
    if (this.sqliteExec) {
      const errOut = [null as any]
      this.sqliteExec(db, sql, null, null, errOut)
      return
    }
    this.sqliteQuery(db, sql)
  }

  private sqliteOpenEncrypted(filePath: string, hexKey: string, storeHandle = true, databaseKeys?: Record<string, string>): { ok: boolean; rawKey?: boolean; error?: string } {
    if (this.windowsReader) return this.windowsOpenEncrypted(filePath, hexKey, storeHandle, databaseKeys)
    if (!this.sqliteOpen || !existsSync(filePath)) {
      return { ok: false, error: `数据库不存在: ${filePath}` }
    }
    const materials = this.sqliteKeyMaterials(hexKey)
    if (materials.length === 0) {
      return { ok: false, error: '密钥为空或格式无效' }
    }
    // Connection tests own a separate handle and must not evict live databases.
    if (storeHandle) this.sqliteClosePath(filePath)

    const SQLITE_OPEN_READONLY = 0x00000001
    const SQLITE_OPEN_READWRITE = 0x00000002
    const SQLITE_OPEN_URI = 0x00000040
    // 官方 libwcdb_api 也是 sqlite3_key + PRAGMA cipher_page_size 后探测 sqlite_master。
    // 兼容微信口令材料与 SQLCipher raw literal；探测仅使用只读连接。
    const openSpecs = [
      { path: filePath, flags: SQLITE_OPEN_READONLY },
      ...(storeHandle ? [{ path: filePath, flags: SQLITE_OPEN_READWRITE }] : []),
      { path: `file:${filePath}?mode=ro`, flags: SQLITE_OPEN_READONLY | SQLITE_OPEN_URI },
    ]
    const pageSizes = [4096, 1024, 0]
    let lastError = ''

    for (const material of materials) {
      for (const spec of openSpecs) {
        for (const pageSize of pageSizes) {
          const dbOut = [null as any]
          const openRc = this.sqliteOpen(spec.path, dbOut, spec.flags, null)
          const db = dbOut[0]
          if (openRc !== 0 || !db) {
            lastError = `sqlite3_open_v2=${openRc}`
            continue
          }
          const keyRc = this.sqliteKeyFn(db, material, material.length)
          if (keyRc !== 0) {
            lastError = `sqlite3_key=${keyRc}`
            this.sqliteClose(db)
            continue
          }
          if (pageSize > 0) {
            this.sqliteExecPragma(db, `PRAGMA cipher_page_size = ${pageSize}`)
          }
          const probe = this.sqliteQuery(db, 'SELECT count(*) AS c FROM sqlite_master')
          if (probe.ok) {
            if (storeHandle) this.sqliteHandles.set(filePath, db)
            else this.sqliteClose(db)
            return { ok: true, rawKey: material.length === 67 && material[0] === 0x78 }
          }
          lastError = probe.error || this.sqliteErrmsg?.(db) || 'file is not a database'
          this.sqliteClose(db)
        }
      }
    }
    return { ok: false, error: lastError || 'SQLCipher 密钥不匹配' }
  }

  private windowsOpenEncrypted(filePath: string, hexKey: string, storeHandle: boolean, databaseKeys?: Record<string, string>): {ok: boolean; rawKey?: boolean; error?: string} {
    const reader = this.windowsReader!
    let saltHex = ''
    let descriptor: number | undefined
    try {
      descriptor = openSync(filePath, 'r')
      const salt = Buffer.alloc(16)
      if (readSync(descriptor, salt, 0, 16, 0) !== 16) return { ok: false, error: '数据库文件不完整。' }
      saltHex = salt.toString('hex')
    } catch { return { ok: false, error: '无法读取数据库文件。' } }
    finally { if (descriptor !== undefined) closeSync(descriptor) }
    const hex = this.normalizeHexKey(hexKey)
    if (!/^[0-9a-f]{64}$/.test(hex)) return { ok: false, error: '微信密钥格式无效。' }
    const materials: WindowsSqlcipherKeyMaterial[] = []
    if (databaseKeys) {
      const raw = databaseKeys[saltHex]
      if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) return { ok: false, error: '这个数据库还没有已验证的密钥，请打开对应聊天后重新获取。' }
      materials.push({ kind: 'raw', keyHex: raw, saltHex })
    } else {
      // Existing single passphrases keep working. A derived raw key is tried
      // separately and must still pass the multi-database connection probe.
      materials.push({ kind: 'passphrase', value: Buffer.from(hex, 'hex') }, { kind: 'passphrase', value: hex }, { kind: 'raw', keyHex: hex, saltHex })
    }
    let error = '数据库密钥未通过验证。'
    for (const material of materials) {
      let db: ReturnType<WindowsSqlcipherReader['open']> | undefined
      try {
        db = reader.open(filePath, material)
        const probe = reader.query(db, 'SELECT count(*) AS c FROM sqlite_master')
        if (!probe.ok) { error = probe.error || error; continue }
        if (storeHandle) {
          this.sqliteClosePath(filePath)
          this.sqliteHandles.set(filePath, db)
          db = undefined
        }
        return { ok: true, rawKey: material.kind === 'raw' }
      } catch { error = '数据库密钥或加密格式未通过验证，请重新获取。' }
      finally { if (db) reader.close(db) }
    }
    return { ok: false, error }
  }

  private sqliteClosePath(filePath: string): void {
    const db = this.sqliteHandles.get(filePath)
    if (!db) return
    this.sqliteHandles.delete(filePath)
    try { if (this.windowsReader) this.windowsReader.close(db); else this.sqliteClose?.(db) } catch { /* ignore */ }
  }

  private sqliteCloseAll(): void {
    for (const [filePath] of this.sqliteHandles) {
      this.sqliteClosePath(filePath)
    }
  }

  private resolveKindPath(kind: string, path: string): string | null {
    const direct = String(path || '').trim()
    if (direct && existsSync(direct)) return direct
    const root = this.currentDbStoragePath
    if (!root) return direct && existsSync(direct) ? direct : null
    const k = String(kind || '').toLowerCase()
    if (k === 'session') return join(root, 'session', 'session.db')
    if (k === 'contact') return join(root, 'contact', 'contact.db')
    if (k === 'sns' || k === 'moment') return join(root, 'sns', 'sns.db')
    if (direct) {
      const rel = join(root, direct)
      if (existsSync(rel)) return rel
      const nested = join(root, k || 'message', direct)
      if (existsSync(nested)) return nested
    }
    return null
  }

  private sqliteQuery(db: any, sql: string): { ok: boolean; rows?: any[]; error?: string } {
    if (this.windowsReader) return this.windowsReader.query(db, sql)
    const stmtOut = [null as any]
    const tailOut = [null as any]
    const rc = this.sqlitePrepare(db, sql, -1, stmtOut, tailOut)
    const stmt = stmtOut[0]
    if (rc !== 0 || !stmt) {
      return { ok: false, error: this.sqliteErrmsg?.(db) || `sqlite3_prepare_v2=${rc}` }
    }
    try {
      const rows: any[] = []
      const SQLITE_ROW = 100
      const SQLITE_DONE = 101
      while (true) {
        const step = this.sqliteStep(stmt)
        if (step === SQLITE_DONE) break
        if (step !== SQLITE_ROW) {
          return { ok: false, error: this.sqliteErrmsg?.(db) || `sqlite3_step=${step}` }
        }
        const colCount = this.sqliteColumnCount(stmt)
        const row: Record<string, any> = {}
        for (let i = 0; i < colCount; i++) {
          const name = String(this.sqliteColumnName(stmt, i) || `col${i}`)
          const type = this.sqliteColumnType(stmt, i)
          if (type === 5) {
            row[name] = null
          } else if (type === 1) {
            const raw = this.sqliteColumnInt64(stmt, i)
            row[name] = typeof raw === 'bigint' ? Number(raw) : raw
          } else if (type === 2) {
            row[name] = this.sqliteColumnDouble(stmt, i)
          } else if (type === 4) {
            const bytes = this.sqliteColumnBytes(stmt, i)
            const ptr = this.sqliteColumnBlob(stmt, i)
            if (!ptr || bytes <= 0) {
              row[name] = ''
            } else {
              row[name] = Buffer.from(this.koffi.decode(ptr, 'uint8_t', bytes)).toString('hex')
            }
          } else {
            row[name] = this.sqliteColumnText(stmt, i) || ''
          }
        }
        rows.push(row)
      }
      return { ok: true, rows }
    } finally {
      try { this.sqliteFinalize(stmt) } catch { /* ignore */ }
    }
  }

  // ============== 连接生命周期 ==============
  async open(dbPath: string, hexKey: string, wxid: string, databaseKeys?: Record<string, string>): Promise<boolean> {
    try {
      if (
        this.handle !== null &&
        this.currentPath === dbPath &&
        this.currentKey === hexKey &&
        this.currentWxid === wxid &&
        JSON.stringify(this.currentDatabaseKeys) === JSON.stringify(databaseKeys)
      ) {
        return true
      }

      const initRes = await this.initialize()
      if (!initRes.success) return false

      if (this.handle !== null) {
        this.close()
        const reinitRes = await this.initialize()
        if (!reinitRes.success) return false
      }

      const dbStoragePath = this.resolveDbStoragePath(dbPath, wxid)
      if (!dbStoragePath) {
        console.error('数据库目录不存在:', dbPath)
        return false
      }

      const sessionDbPaths = this.getCandidateSessionDbs(dbStoragePath)
      if (sessionDbPaths.length === 0) {
        console.error('未找到 session.db 文件:', dbStoragePath)
        return false
      }

      const openResult = this.tryOpenWithCandidates(sessionDbPaths, hexKey, true, databaseKeys)
      if (!openResult.success || !openResult.handle) {
        await this.printLogs()
        return false
      }

      const handle = openResult.handle
      if (handle <= 0) return false

      this.handle = handle
      this.currentPath = dbPath
      this.currentKey = hexKey
      this.currentWxid = wxid
      this.currentDbStoragePath = dbStoragePath
      this.currentDatabaseKeys = databaseKeys
      this.initialized = true

      // 可选：若 native 支持，则绑定当前 wxid
      if (this.wcdbSetMyWxid && wxid) {
        try {
          this.wcdbSetMyWxid(this.handle, wxid)
        } catch (e) {
          console.warn('wcdb_set_my_wxid 调用失败（可忽略）:', e)
        }
      }

      return true
    } catch (e) {
      console.error('打开数据库异常:', e)
      return false
    }
  }

  close(): void {
    this.sqliteCloseAll()
    if (!this.sqliteMode && this.handle !== null && this.wcdbCloseAccount) {
      try { this.wcdbCloseAccount(this.handle) } catch (e) { console.error('关闭 WCDB 句柄失败:', e) }
    }
    if (!this.sqliteMode && this.initialized && this.wcdbShutdown) {
      try { this.wcdbShutdown() } catch (e) { console.error('WCDB shutdown 失败:', e) }
    }
    this.handle = null
    this.initialized = false
    this.sqliteMode = false
    this.lib = null
    this.currentPath = null
    this.currentKey = null
    this.currentWxid = null
    this.currentDbStoragePath = null
    this.currentDatabaseKeys = undefined
    this.windowsReader = null
  }

  shutdown(): void { this.close() }

  isConnected(): boolean { return this.initialized && this.handle !== null }

  async testConnection(dbPath: string, hexKey: string, wxid: string, databaseKeys?: Record<string, string>): Promise<{ success: boolean; error?: string; sessionCount?: number }> {
    try {
      if (this.handle !== null && this.currentPath === dbPath && this.currentKey === hexKey && this.currentWxid === wxid && JSON.stringify(this.currentDatabaseKeys) === JSON.stringify(databaseKeys)) {
        return { success: true, sessionCount: 0 }
      }

      const hadActive = this.handle !== null
      const prevPath = this.currentPath
      const prevKey = this.currentKey
      const prevWxid = this.currentWxid

      const initRes = await this.initialize()
      if (!initRes.success) return { success: false, error: initRes.error || 'WCDB 初始化失败' }

      const dbStoragePath = this.resolveDbStoragePath(dbPath, wxid)
      if (!dbStoragePath) return { success: false, error: `未找到账号目录或 db_storage: ${dbPath}` }

      const sessionDbPaths = this.getCandidateSessionDbs(dbStoragePath)
      if (sessionDbPaths.length === 0) return { success: false, error: `未找到 session.db 文件: ${dbStoragePath}` }

      const openResult = this.tryOpenWithCandidates(sessionDbPaths, hexKey, false, databaseKeys)
      if (!openResult.success || !openResult.handle || !openResult.matchedPath) {
        const logs = this.sqliteMode ? '' : await this.printLogs()
        return {
          success: false,
          error: `数据库打开失败 | db_storage=${dbStoragePath} | tried=${sessionDbPaths.join(', ')}${openResult.errors.length ? ` | details=${openResult.errors.join(' ; ')}` : ''}${logs ? ` | logs=${logs}` : ''}`
        }
      }

      if (openResult.handle <= 0) return { success: false, error: '无效的数据库句柄' }

      if (this.sqliteMode && openResult.rawKey) {
        // A SQLCipher derived key can be specific to one file's salt. Never
        // promote it to an account credential after only opening session.db.
        const contactPath = join(dbStoragePath, 'contact', 'contact.db')
        const messageDir = join(dbStoragePath, 'message')
        const messagePaths = existsSync(messageDir)
          ? readdirSync(messageDir, { withFileTypes: true })
              .filter(entry => entry.isFile() && /^message_\d+\.db$/i.test(entry.name))
              .map(entry => join(messageDir, entry.name))
          : []
        if (!existsSync(contactPath) || messagePaths.length === 0) {
          return { success: false, error: '候选只通过单个数据库验证，尚不能确认为整个账号的密钥。现有配置会保留。' }
        }
        for (const filePath of [contactPath, ...messagePaths]) {
          if (!this.sqliteOpenEncrypted(filePath, hexKey, false, databaseKeys).ok) {
            return { success: false, error: '候选只能打开部分数据库，不能作为整个账号的密钥。现有配置会保留。' }
          }
        }
      }

      // The SQLite probe already closed its own handle. Keep any active account
      // and cached database handles intact on both successful and failed tests.
      if (this.sqliteMode) return { success: true, sessionCount: 0 }

      try {
        // 先关闭刚打开的测试句柄，再 shutdown。
        // 带着未关闭的数据库句柄做全局 shutdown 会导致 native 崩溃（整个 app 闪退）。
        if (this.wcdbCloseAccount && openResult.handle) {
          try { this.wcdbCloseAccount(openResult.handle) } catch (e) { console.error('关闭测试句柄失败:', e) }
        }
        if (this.wcdbCloseAccount && this.handle !== null) {
          try { this.wcdbCloseAccount(this.handle) } catch (e) { console.error('关闭旧句柄失败:', e) }
        }
        this.wcdbShutdown()
        this.handle = null
        this.currentPath = null
        this.currentKey = null
        this.currentWxid = null
        this.currentDbStoragePath = null
        this.initialized = false
      } catch (e) {
        console.error('关闭测试数据库时出错:', e)
      }

      if (hadActive && prevPath && prevKey && prevWxid) {
        try { await this.open(prevPath, prevKey, prevWxid) } catch { /* ignore restore failure */ }
      }

      return { success: true, sessionCount: 0 }
    } catch (e) {
      console.error('测试连接异常:', e)
      return { success: false, error: String(e) }
    }
  }

  // ============== 查询接口 ==============
  async execQuery(kind: string, path: string, sql: string): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    if (this.sqliteMode) {
      const filePath = this.resolveKindPath(kind, path)
      if (!filePath) return { success: false, error: `未找到 ${kind} 数据库: ${path || ''}` }
      let db = this.sqliteHandles.get(filePath)
      if (!db) {
        if (!this.currentKey) return { success: false, error: '缺少数据库密钥' }
        const opened = this.sqliteOpenEncrypted(filePath, this.currentKey, true, this.currentDatabaseKeys)
        if (!opened.ok) return { success: false, error: opened.error || '打开数据库失败' }
        db = this.sqliteHandles.get(filePath)
      }
      const result = this.sqliteQuery(db, sql)
      return result.ok
        ? { success: true, rows: result.rows || [] }
        : { success: false, error: result.error }
    }
    try {
      const outJson = [null]
      const result = this.wcdbExecQuery(this.handle, kind, path || '', sql, outJson)
      if (result !== 0 || !outJson[0]) {
        return { success: false, error: this.mapStatusCode(result) }
      }
      const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
      this.wcdbFreeString(outJson[0])
      return { success: true, rows: JSON.parse(jsonStr) }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  }

  /**
   * 参数化查询。
   * 参数数组需序列化为 `[{type:'string'|'int'|'double'|'bytes'|'null', value:any}]`。
   * 若 native 未绑定该符号，将抛出明确错误。
   */
  async execQueryWithParams(kind: string, path: string, sql: string, params?: any[]): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    if (!this.wcdbExecQueryWithParams) {
      return { success: false, error: 'native 未支持参数化查询' }
    }
    try {
      const typed = (params || []).map(this.inferParamDescriptor)
      const argsJson = JSON.stringify(typed)
      const outJson = [null]
      const result = this.wcdbExecQueryWithParams(this.handle, kind, path || '', sql, argsJson, outJson)
      if (result !== 0 || !outJson[0]) {
        return { success: false, error: this.mapStatusCode(result) }
      }
      const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
      this.wcdbFreeString(outJson[0])
      return { success: true, rows: JSON.parse(jsonStr) }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  }

  private inferParamDescriptor(value: any): { type: string; value: any } {
    if (value === null || value === undefined) {
      return { type: 'null', value: null }
    }
    if (typeof value === 'object' && value && typeof (value as any).type === 'string' && 'value' in value) {
      return value as { type: string; value: any }
    }
    if (typeof value === 'number') {
      return Number.isInteger(value) ? { type: 'int', value } : { type: 'double', value }
    }
    if (typeof value === 'bigint') {
      return { type: 'int', value: value.toString() }
    }
    if (typeof value === 'boolean') {
      return { type: 'int', value: value ? 1 : 0 }
    }
    if (Buffer.isBuffer(value)) {
      return { type: 'bytes', value: value.toString('base64') }
    }
    if (value instanceof Uint8Array) {
      return { type: 'bytes', value: Buffer.from(value).toString('base64') }
    }
    return { type: 'string', value: String(value) }
  }

  /**
   * 导出专用批量读取：keyset 分批查询、列裁剪、时间下推与内容解码全部在本进程内完成，
   * 每次调用最多返回 maxRows 条紧凑行（content/localType 已解码），
   * 避免把 SELECT m.* 的原始大对象（含 hex/base64 blob）逐批经 IPC 搬回主进程。
   */
  async readMessageChunk(
    kind: string,
    path: string,
    tableName: string,
    opts: { afterRid: number; maxRows?: number; startTime?: number; endTime?: number; extraCols?: string[] }
  ): Promise<{ success: boolean; rows?: any[]; lastRid?: number; done?: boolean; error?: string }> {
    if (!/^[A-Za-z0-9_]+$/.test(tableName)) {
      return { success: false, error: `非法表名: ${tableName}` }
    }

    // 优先走原生 wcdb_export_message_chunk：列裁剪/时间过滤/zstd 解码全在 DLL 内完成，
    // content 直接以解码文本返回，省掉 blob→hex→JSON→parse→fzstd 整条搬运链。
    // 原生失败或未绑定（Mac/旧 DLL）时回退下方 JS 实现。
    if (this.wcdbExportMessageChunk && this.initialized && this.handle !== null) {
      try {
        const outJson = [null]
        const rc = this.wcdbExportMessageChunk(
          this.handle, kind, path || '', tableName,
          typeof opts.afterRid === 'number' ? opts.afterRid : -1,
          Math.max(1, opts.maxRows || 20000),
          typeof opts.startTime === 'number' ? Math.floor(opts.startTime) : 0,
          typeof opts.endTime === 'number' ? Math.floor(opts.endTime) : 0,
          JSON.stringify((opts.extraCols || []).filter(c => /^[A-Za-z0-9_]+$/.test(c))),
          outJson
        )
        if (rc === 0 && outJson[0]) {
          const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
          this.wcdbFreeString(outJson[0])
          const parsed = JSON.parse(jsonStr)
          return { success: true, rows: parsed.rows || [], lastRid: parsed.lastRid, done: !!parsed.done }
        }
      } catch { /* 回退 JS 实现 */ }
    }

    const name2id = await this.execQuery(kind, path, "SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'")
    const hasName2Id = !!(name2id.success && name2id.rows && name2id.rows.length > 0)

    // 附加透传列（如 packed_info_data），仅接受合法标识符
    const extraCols = (opts.extraCols || []).filter(c => /^[A-Za-z0-9_]+$/.test(c))
    let pickedExtras = extraCols

    // 列裁剪：只取导出需要的列；PRAGMA 失败时回退 m.*（仍保留就地解码与时间下推的收益）
    let selectCols = 'm.*'
    let hasCreateTime = true
    const pragma = await this.execQuery(kind, path, `PRAGMA table_info(${tableName})`)
    if (pragma.success && pragma.rows && pragma.rows.length > 0) {
      const cols = new Set(pragma.rows.map((r: any) => String(r.name)))
      hasCreateTime = cols.has('create_time')
      const wanted = [
        'local_id', 'localId', 'server_id', 'msg_svr_id', 'msgSvrId', 'MsgSvrID',
        'create_time', 'is_send', 'message_content', 'compress_content'
      ]
      pickedExtras = extraCols.filter(c => cols.has(c))
      const picked = [...new Set([...wanted.filter(c => cols.has(c)), ...MSG_TYPE_COLUMNS.filter(c => cols.has(c)), ...pickedExtras])]
      if (picked.length > 0) selectCols = picked.map(c => `m."${c}"`).join(', ')
    }

    let sql: string
    if (hasName2Id) {
      sql = `SELECT ${selectCols}, n.user_name AS sender_username, m.rowid AS __rid FROM ${tableName} m LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid`
    } else {
      sql = `SELECT ${selectCols}, m.rowid AS __rid FROM ${tableName} m`
    }
    let timeCond = ''
    if (hasCreateTime && typeof opts.startTime === 'number' && typeof opts.endTime === 'number') {
      timeCond = ` AND m.create_time >= ${Math.floor(opts.startTime)} AND m.create_time <= ${Math.floor(opts.endTime)}`
    }

    const maxRows = Math.max(1, opts.maxRows || 20000)
    const out: any[] = []
    let lastRid = typeof opts.afterRid === 'number' ? opts.afterRid : -1
    let done = false
    while (out.length < maxRows) {
      const batch = await this.execQuery(kind, path, `${sql} WHERE m.rowid > ${lastRid}${timeCond} ORDER BY m.rowid ASC LIMIT 2000`)
      if (!batch.success) return { success: false, error: batch.error }
      const rows = batch.rows || []
      if (rows.length === 0) { done = true; break }
      for (const row of rows) {
        const compact: Record<string, any> = {
          __rid: row.__rid,
          local_id: row.local_id ?? row.localId ?? null,
          server_id: row.server_id ?? row.msg_svr_id ?? row.msgSvrId ?? row.MsgSvrID ?? null,
          create_time: coerceRowNumber(row.create_time, 0),
          is_send: row.is_send ?? null,
          sender_username: row.sender_username ?? null,
          localType: this.resolveLocalType(row),
          content: decodeMessageContent(row.message_content, row.compress_content)
        }
        for (const c of pickedExtras) compact[c] = row[c]
        out.push(compact)
      }
      lastRid = rows[rows.length - 1].__rid
      if (rows.length < 2000) { done = true; break }
    }
    return { success: true, rows: out, lastRid, done }
  }

  /** 兼容不同微信版本的 local_type 列名与字符串类型值 */
  private resolveLocalType(row: Record<string, any>, fallback = 1): number {
    let zeroCandidate: number | undefined
    for (const fieldName of MSG_TYPE_COLUMNS) {
      const value = getRowField(row, [fieldName])
      if (value === null || value === undefined || value === '') continue
      const parsed = coerceRowNumber(value, Number.NaN)
      if (!Number.isFinite(parsed)) continue
      if (parsed > 0) return parsed
      if (parsed === 0 && zeroCandidate === undefined) zeroCandidate = parsed
    }
    return zeroCandidate ?? fallback
  }

  async getSnsTimeline(limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    if (this.sqliteMode) {
      return { success: false, error: '当前 WCDB 回退模式暂不支持朋友圈时间线接口' }
    }
    try {
      const outJson = [null]
      const usernamesJson = usernames && usernames.length > 0 ? JSON.stringify(usernames) : ''
      const result = this.wcdbGetSnsTimeline(
        this.handle,
        limit,
        offset,
        usernamesJson,
        keyword || '',
        startTime || 0,
        endTime || 0,
        outJson
      )
      if (result !== 0) {
        return { success: false, error: this.mapStatusCode(result) }
      }
      if (!outJson[0]) {
        return { success: true, timeline: [] }
      }
      const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
      this.wcdbFreeString(outJson[0])
      return { success: true, timeline: JSON.parse(jsonStr) }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  }

  private decodeJsonPtr(outPtr: any): string | null {
    if (!outPtr) return null
    try {
      const jsonStr = this.koffi.decode(outPtr, 'char', -1)
      this.wcdbFreeString(outPtr)
      return jsonStr
    } catch {
      try { this.wcdbFreeString(outPtr) } catch { /* ignore */ }
      return null
    }
  }

  private parseMessageJson(jsonStr: string): any[] {
    const raw = String(jsonStr || '')
    if (!raw) return []
    const needsInt64Normalize = /"server_id"\s*:\s*-?\d{16,}/.test(raw)
    const normalized = needsInt64Normalize
      ? raw.replace(/("server_id"\s*:\s*)(-?\d{16,})/g, '$1"$2"')
      : raw
    const parsed = JSON.parse(normalized)
    return Array.isArray(parsed) ? parsed : [parsed]
  }

  async getNativeMessages(sessionId: string, limit: number, offset: number): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    return { success: false, error: 'direct native 消息读取已禁用，请使用 cursor 路径' }
  }

  // ============== 命名管道监控 ==============
  /**
   * 启动 native 侧的命名管道监控并订阅事件回调。
   * 若 native 未导出管道相关符号则返回 false（功能降级）。
   */
  setMonitor(callback: (type: string, json: string) => void): boolean {
    if (!this.wcdbStartMonitorPipe) {
      return false
    }
    this.monitorCallback = callback
    try {
      const result = this.wcdbStartMonitorPipe()
      if (result !== 0) {
        return false
      }

      let pipePath = process.platform === 'win32'
        ? '\\\\.\\pipe\\ciphertalk_monitor'
        : '/tmp/weflow_monitor_pipe'
      if (this.wcdbGetMonitorPipeName) {
        try {
          const namePtr = [null as any]
          if (this.wcdbGetMonitorPipeName(namePtr) === 0 && namePtr[0]) {
            pipePath = this.koffi.decode(namePtr[0], 'char', -1)
            this.wcdbFreeString(namePtr[0])
          }
        } catch {
          // ignore，落回默认管道名
        }
      }
      this.connectMonitorPipe(pipePath)
      return true
    } catch (e) {
      console.error('[wcdbCore] setMonitor exception:', e)
      return false
    }
  }

  private connectMonitorPipe(pipePath: string): void {
    this.monitorPipePath = pipePath
    const net = require('net')

    setTimeout(() => {
      if (!this.monitorCallback) return

      this.monitorPipeClient = net.createConnection(this.monitorPipePath, () => {})

      let buffer = ''
      this.monitorPipeClient.on('data', (data: Buffer) => {
        const rawChunk = data.toString('utf8')
        const normalizedChunk = rawChunk
          .replace(/\u0000/g, '\n')
          .replace(/}\s*{/g, '}\n{')

        buffer += normalizedChunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (line.trim()) {
            try {
              const parsed = JSON.parse(line)
              this.monitorCallback?.(parsed.action || 'update', line)
            } catch {
              this.monitorCallback?.('update', line)
            }
          }
        }

        const tail = buffer.trim()
        if (tail.startsWith('{') && tail.endsWith('}')) {
          try {
            const parsed = JSON.parse(tail)
            this.monitorCallback?.(parsed.action || 'update', tail)
            buffer = ''
          } catch {
            // 不可解析则继续等待下一块数据
          }
        }
      })

      this.monitorPipeClient.on('error', () => {
        // 保持静默，交由 close 回调触发重连
      })

      this.monitorPipeClient.on('close', () => {
        this.monitorPipeClient = null
        this.scheduleReconnect()
      })
    }, 100)
  }

  private scheduleReconnect(): void {
    if (this.monitorReconnectTimer || !this.monitorCallback) return
    this.monitorReconnectTimer = setTimeout(() => {
      this.monitorReconnectTimer = null
      if (this.monitorCallback && !this.monitorPipeClient) {
        this.connectMonitorPipe(this.monitorPipePath)
      }
    }, 3000)
  }

  stopMonitor(): void {
    this.monitorCallback = null
    if (this.monitorReconnectTimer) {
      clearTimeout(this.monitorReconnectTimer)
      this.monitorReconnectTimer = null
    }
    if (this.monitorPipeClient) {
      try {
        this.monitorPipeClient.destroy()
      } catch {
        // ignore
      }
      this.monitorPipeClient = null
    }
    if (this.wcdbStopMonitorPipe) {
      try {
        this.wcdbStopMonitorPipe()
      } catch {
        // ignore
      }
    }
  }

  // ============== 日志 / 错误码 ==============
  private async printLogs(): Promise<string> {
    try {
      if (!this.wcdbGetLogs) return ''
      const outPtr = [null as any]
      const result = this.wcdbGetLogs(outPtr)
      if (result === 0 && outPtr[0]) {
        const jsonStr = this.koffi.decode(outPtr[0], 'char', -1)
        // console.error('WCDB 内部日志:', jsonStr)
        this.wcdbFreeString(outPtr[0])
        return jsonStr
      }
    } catch (e) {
      console.error('获取 WCDB 日志失败:', e)
    }
    return ''
  }

  private mapStatusCode(code: number): string {
    switch (code) {
      case 0: return '成功'
      case -1: return '参数错误'
      case -2: return '密钥错误'
      case -3:
      case -4: return '数据库打开失败'
      case -5: return '查询执行失败'
      case -6: return 'WCDB 尚未初始化'
      case -7: return 'WCDB 表结构不匹配'
      case -8: return '本机安全状态校验失败'
      case -9: return 'WCDB 授权已过期，请更新应用后重试'
      case -10: return 'WCDB 客户端身份无效'
      case -11: return 'WCDB 首次启用需要连接网络'
      case -12: return 'WCDB 授权签名无效'
      case -13: return 'WCDB 授权被拒绝，请使用官方应用组件'
      case -14: return '当前设备或账号已被停用'
      case -15: return '当前应用已被停用'
      case -16: return 'WCDB 云端授权服务暂时不可用'
      case -17: return '当前 CipherTalk 版本不受支持，请更新后重试'
      case -18: return '当前 WCDB 原生库版本不受支持，请更新应用后重试'
      default: return `WCDB 错误码: ${code}`
    }
  }

}
