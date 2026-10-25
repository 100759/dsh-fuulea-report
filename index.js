// 辅立码课教学数据报告 —— Host 半边。
//
// 职责：
//   1. 注册本机 HTTP 路由 /fuulea-report/api/*，供工作台页面（Client 半边）调用；
//   2. 学校「绑定」：账号密码只在本机保存一次，之后打开页面直接登录（可切换多所学校）；
//   3. 登录学校站点，读取「管理看板」数据；
//   4. 生成 Markdown / 可打印 HTML / PDF 报告，写到报告目录，并提供
//      「用系统默认应用打开 / 在访达中显示」的原生打开接口。
//
// 只读：只调用 /v2/auth/login/、/v2/dashboard/export/、/v2/dashboard/teach/ 三个接口。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { FuuleaApi, resolveBaseUrl, readCredentialsFile, DEFAULT_CREDENTIALS_FILE } from './lib/api.js'
import { fetchSnapshot, daysInclusive } from './lib/data.js'
import { BindingStore, DEFAULT_BINDINGS_FILE, aliasOf, isValidAlias, mask } from './lib/bindings.js'
import {
  DEFAULT_REPO,
  createVersionChecker,
  detectInstallSource,
  readLocalVersion,
  resolveProfileDir,
  runGithubUpdate,
} from './lib/updater.js'

export const name = 'fuulea-report'
export const inject = ['webServer', 'tools']

const PACKAGE_NAME = 'dsh-fuulea-report'
/** 插件自身目录（package.json 所在目录），用于读取当前版本。 */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))
/** 当前版本以安装的 package.json 为准；读不到时用兜底常量。 */
const VERSION = readLocalVersion(PACKAGE_DIR) || '1.3.0'
const ROUTE_PREFIX = '/fuulea-report/api'
const SNAPSHOT_TTL_MS = 10 * 60 * 1000
const MAX_CACHED_CLIENTS = 24

const DEFAULT_CONFIG = {
  defaultSchool: 'lyyz',
  credentialsFile: DEFAULT_CREDENTIALS_FILE,
  bindingsFile: DEFAULT_BINDINGS_FILE,
  outputDir: '',
  chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  defaultDays: 14,
  requestTimeoutMs: 90_000,
  pdfTimeoutMs: 45_000,
  // 发布与更新：repository 是本插件在 GitHub 上的仓库（owner/repo），
  // checkUpdates=false 可完全关闭联网检查（内网环境用）。
  repository: DEFAULT_REPO,
  checkUpdates: true,
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig || {}) }
  const clients = new Map()
  const snapshots = new Map()
  const pdfJobs = new Set()
  const bindings = new BindingStore(
    config.bindingsFile || process.env.FUULEA_BINDINGS_FILE || DEFAULT_BINDINGS_FILE,
  )
  const versionChecker = createVersionChecker({
    repo: config.repository || DEFAULT_REPO,
    currentVersion: () => VERSION,
    installSource: () => detectInstallSource(resolveProfileDir(), PACKAGE_NAME),
    enabled: config.checkUpdates !== false,
  })

  const state = {
    ctx,
    config,
    bindings,
    clients,
    snapshots,
    pdfJobs,
    versionChecker,
    updating: null,
    workdir: () => {
      try {
        const wd = ctx.get('workingDirectory')
        if (wd && typeof wd.defaultDirectory === 'string' && wd.defaultDirectory) return wd.defaultDirectory
      } catch { /* 没有该服务时用进程目录 */ }
      return process.cwd()
    },
    outputRoot: () => {
      const configured = config.outputDir || process.env.FUULEA_REPORT_DIR || ''
      if (configured) return path.resolve(configured)
      // 页面是 root 级（没有会话上下文），Host 拿不到「当前工作区」；默认放到用户主目录下，
      // 页面与工具结果都会回显实际输出目录，也支持通过配置 outputDir 改到任意位置。
      return path.join(os.homedir(), '辅立码课数据报告')
    },
  }

  // 注意：prefix 路由的 path 不能以 "/" 结尾 —— webserver 的前缀匹配是
  // `pathname === prefix || pathname.startsWith(prefix + "/")`，带尾斜杠会让
  // `${prefix}/` 变成 "//"，所有请求都匹配不到并落到 SPA fallback（表现为 404/405）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => handle(state, req, res),
  }))

  ctx.effect(() => ctx.tools.register(reportTool(state)))

  ctx.effect(() => () => {
    for (const child of pdfJobs) {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    }
    pdfJobs.clear()
  })
}

// ---------------------------------------------------------------- 路由

const ROUTES = {
  'GET defaults': async (state) => {
    const list = state.bindings.list()
    const lastSchool = state.bindings.defaultSchool()
    const school = lastSchool || state.config.defaultSchool
    const bound = list.find((item) => item.alias === school) || null
    return {
      ok: true,
      version: VERSION,
      repo: state.config.repository || DEFAULT_REPO,
      repoUrl: `https://github.com/${state.config.repository || DEFAULT_REPO}`,
      defaults: {
        school,
        schoolTitle: bound ? bound.siteTitle : '',
        days: state.config.defaultDays,
        ...defaultWindow(state.config.defaultDays),
        lastRange: state.bindings.lastRange(),
        outputDir: state.outputRoot(),
        chromeAvailable: fs.existsSync(state.config.chromePath),
        credentialsFile: state.config.credentialsFile,
        credentialsFileExists: fs.existsSync(state.config.credentialsFile),
        bindingsFile: state.bindings.file,
        bindings: list,
        lastSchool,
      },
    }
  },

  'POST bind': async (state, body) => {
    const params = body || {}
    const alias = requireAlias(params.school)
    const username = String(params.username || '').trim()
    const password = String(params.password || '')
    if (!username) throw new Error('请填写账号')
    if (!password) throw new Error('请填写密码')

    const baseUrl = resolveBaseUrl(alias)
    const api = new FuuleaApi({ baseUrl, username, password })
    let user
    try {
      user = await api.login()
    } catch (e) {
      throw new Error(`绑定「${alias}」失败：${e && e.message ? e.message : e}`)
    }
    const record = state.bindings.save({
      alias,
      baseUrl,
      siteTitle: (user && user.siteTitle) || '',
      username,
      password,
      token: api.token,
      tokenExpiresAt: api.expiresAt,
      user: pickUser(user),
    })
    invalidateClients(state, baseUrl)
    clearSnapshots(state, alias)
    return {
      ok: true,
      binding: mask(record),
      bindings: state.bindings.list(),
      lastSchool: state.bindings.defaultSchool(),
    }
  },

  'POST unbind': async (state, body) => {
    const alias = requireAlias((body || {}).school)
    const removed = state.bindings.remove(alias)
    invalidateClients(state, resolveBaseUrl(alias))
    clearSnapshots(state, alias)
    return {
      ok: true,
      removed,
      bindings: state.bindings.list(),
      lastSchool: state.bindings.defaultSchool(),
    }
  },

  'POST snapshot': async (state, body) => {
    const snapshot = await snapshotFor(state, body || {})
    return { ok: true, snapshot, bindings: state.bindings.list(), lastSchool: state.bindings.defaultSchool() }
  },

  // POST report：body 支持 { school, from, to, gradeIds, username, password, mode, formats }
  //   mode: full（默认）| brief | interactive
  //   formats: 省略则用该模式的默认格式（full=md/html/pdf/docx、brief=docx/pdf、interactive=html）
  //   返回值在原结构之上增加 mode / modeTitle / formats，其余字段保持向后兼容。
  'POST report': async (state, body) => {
    const params = body || {}
    const mode = normalizeMode(params.mode)
    const snapshot = await snapshotFor(state, params)
    const result = await generateReport(state, snapshot, { ...params, mode })
    return { ok: true, ...result, mode, bindings: state.bindings.list() }
  },

  // GET reports：原有 school/range/from/to/dir/updatedAt/files 不变；
  //   新增 variants（本目录出现过的版本）与每个文件的 variant / label。
  'GET reports': async (state) => ({ ok: true, reports: listReports(state), outputDir: state.outputRoot() }),

  // GET update-check：检查 GitHub 上是否有新版本（force=1 跳过缓存，用于点「立即检查」）。
  'GET update-check': async (state, body, url) => {
    const force = Boolean(url && url.searchParams.get('force'))
    const info = await state.versionChecker.check(force)
    return {
      ok: true,
      version: VERSION,
      repo: info.repo,
      repoUrl: info.repoUrl,
      latest: info.latest,
      updateAvailable: info.updateAvailable,
      source: info.source,
      spec: info.spec,
      disabled: info.disabled,
      checkedAt: info.checkedAt,
      error: info.error,
      updating: Boolean(state.updating),
    }
  },

  // POST update：从 GitHub 重新安装到本机 profile（仅 GitHub 源安装可用）。
  //   返回后需要重启 DeepSeek Harness，新版本代码才会生效。
  'POST update': async (state) => {
    const info = await state.versionChecker.check(true)
    if (info.disabled) throw new Error('插件配置里已关闭联网检查（checkUpdates=false），无法自动更新')
    if (info.source === 'link') {
      throw new Error('本机是以本地目录方式安装的（link），更新请直接修改源码目录，或改从 GitHub 安装')
    }
    if (info.source !== 'github') {
      throw new Error(
        '本机不是从 GitHub 安装的，无法一键更新。请手动执行：dsh plugin --profile ' +
          (process.env.DSH_PROFILE || '<profile>') +
          ' add github:' +
          info.repo,
      )
    }
    if (state.updating) throw new Error('正在更新中，请稍候…')
    const repo = info.repo || state.config.repository || DEFAULT_REPO
    state.updating = (async () => {
      const result = await runGithubUpdate({
        profileDir: resolveProfileDir(),
        repo,
        packageName: PACKAGE_NAME,
      })
      return result
    })()
    try {
      const result = await state.updating
      return {
        ok: true,
        from: result.from,
        to: result.to,
        latest: info.latest,
        restartRequired: true,
        message: `已更新到 ${result.to || info.latest}，重启 DeepSeek Harness 后生效`,
      }
    } finally {
      state.updating = null
      // 更新后重新检查一次，页面徽标不会继续显示红点。
      state.versionChecker.check(true).catch(() => {})
    }
  },

  'POST open': async (state, body) => {
    const params = body || {}
    const target = String(params.path || '').trim()
    if (!target) throw new Error('缺少要打开的文件路径')
    const root = path.resolve(state.outputRoot())
    const abs = path.resolve(root, target)
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error('只能打开报告目录内的文件')
    }
    if (!fs.existsSync(abs)) throw new Error('文件不存在：' + target)
    const action = params.reveal ? 'reveal' : 'open'
    await openWithSystem(abs, action)
    return { ok: true, path: abs, action }
  },
}

async function handle(state, req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  if (!url.pathname.startsWith(ROUTE_PREFIX)) return json(res, 404, { ok: false, error: '未知路由' })
  const sub = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')

  try {
    // 文件下载：GET /file?path=<相对报告目录的路径>
    if (req.method === 'GET' && sub === 'file') {
      return serveFile(state, url, res)
    }
    const key = `${req.method} ${sub}`
    const route = ROUTES[key]
    if (!route) return json(res, 404, { ok: false, error: `未知接口 ${key}` })
    const body = req.method === 'POST' ? await readJsonBody(req) : null
    // 更新要走一次 pnpm 安装，给更长的超时；其余接口用统一超时。
    const timeoutMs = key === 'POST update' ? 240_000 : state.config.requestTimeoutMs
    const payload = await withTimeout(route(state, body, url), timeoutMs, '接口处理超时')
    return json(res, 200, payload)
  } catch (e) {
    return json(res, 400, { ok: false, error: e && e.message ? e.message : String(e) })
  }
}

// ---------------------------------------------------------------- 数据

function defaultWindow(days) {
  const d = Math.max(1, Number(days) || 14)
  const to = new Date()
  to.setDate(to.getDate() - 1)
  const from = new Date(to)
  from.setDate(from.getDate() - (d - 1))
  return { from: isoDate(from), to: isoDate(to) }
}

function isoDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function requireAlias(raw) {
  const alias = aliasOf(raw)
  if (!alias) throw new Error('请填写学校子域名（例如 lyyz）')
  if (!isValidAlias(alias)) throw new Error('学校子域名只能包含字母、数字和连字符（例如 lyyz）')
  return alias
}

function invalidateClients(state, baseUrl) {
  const prefix = String(baseUrl).replace(/\/+$/, '') + '|'
  for (const key of [...state.clients.keys()]) {
    if (key.startsWith(prefix)) state.clients.delete(key)
  }
}

function clearSnapshots(state, alias) {
  const prefix = alias + '|'
  for (const key of [...state.snapshots.keys()]) {
    if (key.startsWith(prefix)) state.snapshots.delete(key)
  }
}

/**
 * 凭据解析优先级：本次请求填写的账号密码 > 本机绑定 > 技能包凭据文件。
 * @returns {{ client: FuuleaApi, alias: string, source: 'input'|'binding'|'file' }}
 */
function clientFor(state, school, body) {
  const alias = aliasOf(school)
  const baseUrl = resolveBaseUrl(alias)
  const inputUser = String(body.username || '').trim()
  const inputPass = String(body.password || '')
  const bound = state.bindings.get(alias)

  let username = ''
  let password = ''
  let source = ''
  let token = ''
  let tokenExpiresAt = 0
  let savedUser = null

  if (inputUser && inputPass) {
    username = inputUser
    password = inputPass
    source = 'input'
  } else if (bound && bound.username && bound.password) {
    username = bound.username
    password = bound.password
    source = 'binding'
    token = bound.token
    tokenExpiresAt = bound.tokenExpiresAt
    savedUser = bound.user || null
  } else {
    const saved = readCredentialsFile(state.config.credentialsFile, alias)
    if (saved) {
      username = saved.username
      password = saved.password
      source = 'file'
    }
  }

  if (!username || !password) {
    throw new Error(
      `「${alias}」还没有绑定账号：请在学校设置里填写一次账号密码（之后会自动登录），` +
      `或在 ${state.config.credentialsFile} 中配置「${alias}|账号|密码」`,
    )
  }

  // 只有「令牌未过期且保存了登录用户信息」时才复用令牌；否则回退到账号密码登录，
  // 因为报告取数需要登录返回的 siteId / chargedGradeIds。
  const reuseToken = Boolean(
    source === 'binding' && token && savedUser && tokenExpiresAt && tokenExpiresAt - Date.now() > 120_000,
  )
  const cacheKey = `${baseUrl}|${username}|${reuseToken ? 'token' : 'pass'}`
  let client = state.clients.get(cacheKey)
  if (!client) {
    client = new FuuleaApi({
      baseUrl,
      username,
      password,
      token: reuseToken ? token : undefined,
    })
    if (reuseToken) {
      client.expiresAt = tokenExpiresAt
      client.user = savedUser
    }
    state.clients.set(cacheKey, client)
    if (state.clients.size > MAX_CACHED_CLIENTS) {
      const oldest = state.clients.keys().next().value
      if (oldest !== undefined) state.clients.delete(oldest)
    }
  } else {
    // 绑定里换了账号/密码时，直接更新客户端凭据，避免沿用旧密码。
    client.username = username
    client.password = password
  }
  return { client, alias, source }
}

async function snapshotFor(state, body) {
  const alias = requireAlias(body.school || state.bindings.defaultSchool() || state.config.defaultSchool || 'lyyz')
  const def = defaultWindow(state.config.defaultDays)
  const from = String(body.from || def.from)
  const to = String(body.to || def.to)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('日期格式应为 YYYY-MM-DD')
  }
  if (new Date(from) > new Date(to)) throw new Error('开始日期不能晚于结束日期')
  if (daysInclusive(from, to) > 366) throw new Error('统计区间不能超过一年')

  const cacheKey = [alias, from, to, body.gradeIds ? body.gradeIds.join(',') : ''].join('|')
  const cached = state.snapshots.get(cacheKey)
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) {
    state.bindings.setLastSchool(alias)
    state.bindings.setLastRange(from, to)
    return cached.snapshot
  }

  const { client, source } = clientFor(state, alias, body)
  const snapshot = await fetchSnapshot(client, { from, to, gradeIds: body.gradeIds || null })
  persistBinding(state, alias, client, source, snapshot)
  state.snapshots.set(cacheKey, { at: Date.now(), snapshot })
  // 只保留最近 8 份，避免长时间运行内存膨胀
  if (state.snapshots.size > 8) {
    const oldest = [...state.snapshots.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) state.snapshots.delete(oldest[0])
  }
  return snapshot
}

/**
 * 成功登录取数后把账号写回本机绑定：
 *  - 用户在页面里填过账号密码（source=input）→ 自动绑定，下次直接登录；
 *  - 已绑定的学校 → 刷新令牌、站点名与最近使用时间；
 *  - 仅用技能包凭据文件的学校 → 不落盘，保持原有凭据来源。
 */
function persistBinding(state, alias, client, source, snapshot) {
  const user = client.user || {}
  const siteTitle = (user && user.siteTitle) || (snapshot && snapshot.meta && snapshot.meta.siteTitle) || ''
  const tokenExpiresAt = client.expiresAt || 0
  const userSnapshot = pickUser(user)
  const existing = state.bindings.get(alias)
  try {
    if (source === 'input' || (!existing && source === 'binding')) {
      state.bindings.save({
        alias,
        baseUrl: client.baseUrl,
        siteTitle,
        username: client.username,
        password: client.password,
        token: client.token,
        tokenExpiresAt,
        user: userSnapshot,
      })
    } else if (existing) {
      state.bindings.patch(alias, {
        siteTitle: siteTitle || existing.siteTitle,
        username: client.username,
        password: client.password,
        token: client.token || existing.token,
        tokenExpiresAt: tokenExpiresAt || existing.tokenExpiresAt,
        user: userSnapshot || existing.user,
        lastUsedAt: new Date().toISOString(),
      })
    }
    state.bindings.setLastSchool(alias)
    if (snapshot && snapshot.meta) state.bindings.setLastRange(snapshot.meta.from, snapshot.meta.to)
  } catch (e) {
    // 绑定写入失败不能影响取数本身；页面仍可正常展示数据。
    try {
      state.ctx.logger.warn('fuulea-report: 保存绑定失败：' + (e && e.message ? e.message : e))
    } catch { /* 没有 logger */ }
  }
}

/** 只保留报告取数需要的登录用户字段，用于复用未过期令牌时免登录。 */
function pickUser(user) {
  if (!user || typeof user !== 'object') return null
  const out = {}
  for (const key of ['siteId', 'siteTitle', 'chargedGradeIds', 'manageGradeIds', 'userName', 'firstName', 'isSuper', 'id', 'userId']) {
    if (user[key] !== undefined && user[key] !== null) out[key] = user[key]
  }
  return Object.keys(out).length ? out : null
}

// ---------------------------------------------------------------- 报告

// 三种导出模式（见 SPEC-brief.md §0 / §4 / §5）：
//   full        正式版：Markdown / HTML（可打印）/ Word / PDF
//   brief       简报版：Word + PDF（PDF 由简报 HTML 交给 Chrome 打印）
//   interactive 交互版：单文件 HTML（不生成 PDF）
const REPORT_MODES = ['full', 'brief', 'interactive']
const MODE_FORMATS = {
  full: ['markdown', 'html', 'pdf', 'docx'],
  brief: ['docx', 'pdf'],
  interactive: ['html'],
}
const MODE_TITLE = { full: '正式版', brief: '简报版', interactive: '交互版' }
// 输出文件基名（SPEC-brief.md §5）；正式版保持不变（向后兼容）。
const MODE_BASENAME = {
  full: (site, from, to) => `${site}教学数据报告(${from}~${to})`,
  brief: (site, from, to) => `${site}使用简报(${from}~${to})`,
  interactive: (site, from, to) => `${site}交互数据报告(${from}~${to})`,
}
// 正式版文件标签保持原样（历史契约），简报/交互版用各自的标签。
const MODE_FILE_LABEL = {
  full: { markdown: 'Markdown 报告', html: '可打印 HTML 报告', docx: 'Word 报告', pdf: 'PDF 报告' },
  brief: { docx: '简报 Word', pdf: '简报 PDF', html: '简报 HTML', markdown: '简报 Markdown' },
  interactive: { html: '交互式 HTML 报告' },
}

function normalizeMode(raw) {
  const mode = String(raw || '').trim().toLowerCase()
  return REPORT_MODES.includes(mode) ? mode : 'full'
}

/** 请求的格式：显式给出则取交集，否则用该模式的默认格式。 */
function normalizeFormats(mode, raw) {
  const allowed = MODE_FORMATS[mode]
  if (!Array.isArray(raw) || !raw.length) return allowed.slice()
  const picked = allowed.filter((f) => raw.includes(f))
  return picked.length ? picked : allowed.slice()
}

/** 动态加载 lib 模块：模块暂不存在时给出中文错误而不是崩溃。 */
async function loadLib(fileName, label) {
  try {
    return await import('./lib/' + fileName)
  } catch (e) {
    const reason = e && e.message ? e.message : String(e)
    throw new Error(`${label}生成模块不可用（lib/${fileName} 未就绪）：${reason}`)
  }
}

async function generateReport(state, snapshot, params) {
  const opts = params || {}
  const mode = normalizeMode(opts.mode)
  const formats = normalizeFormats(mode, opts.formats)
  let buildReport
  try {
    ({ buildReport } = await loadLib('report.js', '报告渲染'))
  } catch (e) {
    throw new Error('报告渲染模块不可用（lib/report.js 未就绪）：' + (e.message || e))
  }

  const generatedAt = snapshot.meta.generatedAt
  const siteSafe = safeName(snapshot.meta.siteTitle || snapshot.meta.host)
  const dir = path.join(state.outputRoot(), siteSafe, `${snapshot.meta.from}_${snapshot.meta.to}`)
  fs.mkdirSync(dir, { recursive: true })
  const baseName = MODE_BASENAME[mode](siteSafe, snapshot.meta.from, snapshot.meta.to)
  const files = []
  const warnings = [...(snapshot.warnings || [])]

  const write = (ext, content) => {
    const file = path.join(dir, `${baseName}.${ext}`)
    fs.writeFileSync(file, content, 'utf8')
    return file
  }
  const addFile = (labelKey, file, label) => {
    files.push(fileEntry(labelKey, file, state, label || MODE_FILE_LABEL[mode][labelKey] || '报告文件', mode))
  }

  let result = null
  if (mode === 'full') {
    // 正式版：保持原有行为与文件名（Markdown / 可打印 HTML / Word / PDF）
    const report = buildReport(snapshot, { generatedAt })
    if (formats.includes('markdown') && typeof report.markdown === 'string') {
      addFile('markdown', write('md', report.markdown))
    }
    let htmlFile = null
    if ((formats.includes('html') || formats.includes('pdf')) && typeof report.html === 'string') {
      htmlFile = write('html', report.html)
      if (formats.includes('html')) addFile('html', htmlFile)
    }
    if (formats.includes('docx') && Buffer.isBuffer(report.docx)) {
      const docxFile = path.join(dir, `${baseName}.docx`)
      fs.writeFileSync(docxFile, report.docx)
      addFile('docx', docxFile)
    }
    if (formats.includes('pdf') && htmlFile) {
      const pdfFile = path.join(dir, `${baseName}.pdf`)
      try {
        await renderPdf(state, htmlFile, pdfFile)
        addFile('pdf', pdfFile)
      } catch (e) {
        warnings.push('PDF 生成失败（' + e.message + '），已保留 HTML 可打印版')
      }
    }
    result = report
  } else if (mode === 'brief') {
    result = await buildBriefMode(state, snapshot, { formats, generatedAt, siteSafe, dir, baseName, write, addFile, warnings })
  } else {
    result = await buildInteractiveMode(snapshot, { generatedAt, write, addFile })
  }

  return {
    mode,
    modeTitle: MODE_TITLE[mode],
    formats,
    files,
    stats: (result && result.stats) || {},
    warnings,
    outputDir: dir,
    school: snapshot.meta.siteTitle,
  }
}

/**
 * 简报版：Word（lib/brief.js → buildBrief，返回 { docx, html, brief, stats }）
 * + PDF（buildBriefHtml 写临时 HTML 后沿用 Chrome 打印，打印完立即清理临时文件）。
 */
async function buildBriefMode(state, snapshot, ctx) {
  const { formats, generatedAt, siteSafe, dir, baseName, write, addFile, warnings } = ctx
  const briefLib = await loadLib('brief.js', '简报')
  if (typeof briefLib.buildBrief !== 'function') {
    throw new Error('简报生成模块缺少 buildBrief 导出（lib/brief.js 未就绪）')
  }
  // 简报版对齐参考件《高二使用情况简报》：纯文字、每届 1 页、无图表。
  // 图表能力保留在交互版（lib/interactive.js）；需要图文简报时可显式传
  // figures: { teacher: true, subject: true }（会在每届后附「图题 + 同源数据表」）。
  const opts = { generatedAt, figures: false }
  let built = briefLib.buildBrief(snapshot, opts)
  if (built && typeof built.then === 'function') built = await built

  let docxBuffer = null
  let briefHtml = null
  let stats = {}
  let briefDoc = null
  if (Buffer.isBuffer(built)) {
    docxBuffer = built
  } else if (built && typeof built === 'object') {
    if (Buffer.isBuffer(built.docx)) docxBuffer = built.docx
    if (typeof built.html === 'string') briefHtml = built.html
    if (built.stats && typeof built.stats === 'object') stats = built.stats
    if (built.brief && typeof built.brief === 'object') briefDoc = built.brief
  }
  // 兜底：buildBrief 没给 docx 时单独取 buildBriefDocument + docx 渲染
  if (!Buffer.isBuffer(docxBuffer) && typeof briefLib.buildBriefDocument === 'function') {
    briefDoc = briefDoc || briefLib.buildBriefDocument(snapshot, { generatedAt })
    const docxModule = await loadLib('docx.js', 'Word 文档')
    const render = docxModule.buildBriefDocxBuffer || docxModule.buildDocxBuffer
    if (typeof render !== 'function') throw new Error('Word 模块缺少 buildBriefDocxBuffer 导出（lib/docx.js 未就绪）')
    docxBuffer = render(briefDoc)
  }

  if (formats.includes('docx')) {
    if (!Buffer.isBuffer(docxBuffer)) throw new Error('简报 Word 生成失败：模块没有返回 .docx 内容')
    const docxFile = path.join(dir, `${baseName}.docx`)
    fs.writeFileSync(docxFile, docxBuffer)
    addFile('docx', docxFile)
  }

  if ((formats.includes('pdf') || formats.includes('html')) && typeof briefHtml !== 'string') {
    if (typeof briefLib.buildBriefHtml === 'function') {
      briefHtml = briefLib.buildBriefHtml(snapshot, { ...opts, doc: briefDoc })
      if (briefHtml && typeof briefHtml.then === 'function') briefHtml = await briefHtml
    }
  }

  // Chrome --print-to-pdf 只吃 HTML：简报 HTML 写临时文件打印，打印完立即清理。
  // （只有显式要求 html 时，才把简报 HTML 另存到报告目录。）
  let tempHtml = null
  let htmlWarning = ''
  if (formats.includes('pdf')) {
    if (typeof briefHtml === 'string' && briefHtml) {
      const tempDir = path.join(os.tmpdir(), 'fuulea-report-brief')
      fs.mkdirSync(tempDir, { recursive: true })
      tempHtml = path.join(tempDir, `${safeName(siteSafe)}-${Date.now()}-${process.pid}.html`)
      fs.writeFileSync(tempHtml, briefHtml, 'utf8')
    } else {
      htmlWarning = '简报 PDF 生成失败（简报 HTML 不可用），已保留简报 Word'
    }
  }
  try {
    if (formats.includes('pdf') && tempHtml) {
      const pdfFile = path.join(dir, `${baseName}.pdf`)
      try {
        await renderPdf(state, tempHtml, pdfFile)
        addFile('pdf', pdfFile)
      } catch (e) {
        warnings.push('简报 PDF 生成失败（' + e.message + '），已保留简报 Word')
      }
    } else if (htmlWarning) {
      warnings.push(htmlWarning)
    }
    if (formats.includes('html') && typeof briefHtml === 'string' && briefHtml) {
      const htmlFile = write('html', briefHtml)
      addFile('html', htmlFile)
    }
  } finally {
    if (tempHtml) {
      try { fs.rmSync(tempHtml, { force: true }) } catch { /* 临时文件已删除 */ }
    }
  }
  return { stats, brief: briefDoc }
}

/** 交互版：单文件 HTML（buildInteractiveHtml）。 */
async function buildInteractiveMode(snapshot, ctx) {
  const { generatedAt, write, addFile } = ctx
  const lib = await loadLib('interactive.js', '交互版')
  if (typeof lib.buildInteractiveHtml !== 'function') {
    throw new Error('交互版生成模块缺少 buildInteractiveHtml 导出（lib/interactive.js 未就绪）')
  }
  const html = await lib.buildInteractiveHtml(snapshot, { generatedAt })
  if (typeof html !== 'string' || !html.trim()) {
    throw new Error('交互版生成模块没有返回 HTML 内容（lib/interactive.js）')
  }
  const file = write('html', html)
  addFile('html', file)
  return { stats: {} }
}

/** 报告目录内文件 → 前端可直接使用的描述（kind/label/variant + 打开地址）。 */
function fileEntry(kind, file, state, label, variant) {
  const rel = path.relative(state.outputRoot(), file).split(path.sep).join('/')
  const resolved = variant || variantOfFile(file)
  return {
    kind,
    label,
    variant: resolved,
    name: path.basename(file),
    path: file,
    bytes: fs.statSync(file).size,
    url: `${ROUTE_PREFIX}/file?path=${encodeURIComponent(rel)}`,
  }
}

/** 按文件名识别版本：含「使用简报」→ brief；含「交互数据报告」→ interactive；否则 full。 */
function variantOfFile(file) {
  const name = path.basename(String(file || ''))
  if (name.includes('使用简报')) return 'brief'
  if (name.includes('交互数据报告')) return 'interactive'
  return 'full'
}

function kindOfFile(file) {
  switch (path.extname(file).toLowerCase()) {
    case '.pdf': return 'pdf'
    case '.docx': return 'docx'
    case '.html': return 'html'
    case '.md': return 'markdown'
    default: return 'file'
  }
}

const FILE_LABEL = { pdf: 'PDF 报告', docx: 'Word 报告', html: '可打印 HTML 报告', markdown: 'Markdown 报告', file: '报告文件' }

/** 历史报告列表里的文件标签（按版本区分，前端据此分组与显示按钮文案）。 */
const VARIANT_FILE_LABEL = {
  full: FILE_LABEL,
  brief: { pdf: '简报 PDF', docx: '简报 Word', html: '简报 HTML', markdown: '简报 Markdown', file: '报告文件' },
  interactive: { pdf: 'PDF 报告', docx: 'Word 报告', html: '交互式 HTML 报告', markdown: 'Markdown 报告', file: '报告文件' },
}

function labelOfFile(file) {
  const variant = variantOfFile(file)
  const kind = kindOfFile(file)
  return (VARIANT_FILE_LABEL[variant] || FILE_LABEL)[kind] || '报告文件'
}

const FILE_ORDER = { pdf: 0, docx: 1, html: 2, markdown: 3, file: 4 }
const VARIANT_ORDER = { full: 0, brief: 1, interactive: 2 }

/** 扫描报告目录，返回最近的报告（学校 / 区间 / 文件），供工作台直接打开历史报告。 */
function listReports(state) {
  const root = state.outputRoot()
  const bundles = []
  let schoolDirs = []
  try {
    schoolDirs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return bundles
  }
  for (const schoolEntry of schoolDirs) {
    if (!schoolEntry.isDirectory() || schoolEntry.name.startsWith('.')) continue
    const schoolPath = path.join(root, schoolEntry.name)
    let rangeDirs = []
    try {
      rangeDirs = fs.readdirSync(schoolPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const rangeEntry of rangeDirs) {
      if (!rangeEntry.isDirectory() || rangeEntry.name.startsWith('.')) continue
      const dirPath = path.join(schoolPath, rangeEntry.name)
      let names = []
      try {
        names = fs.readdirSync(dirPath)
      } catch {
        continue
      }
      const files = []
      let latestMtime = 0
      for (const entry of names) {
        if (!/\.(pdf|docx|html|md)$/i.test(entry)) continue
        const abs = path.join(dirPath, entry)
        let stat = null
        try {
          stat = fs.statSync(abs)
        } catch {
          continue
        }
        if (!stat.isFile()) continue
        latestMtime = Math.max(latestMtime, stat.mtimeMs)
        const kind = kindOfFile(abs)
        const variant = variantOfFile(abs)
        files.push(fileEntry(kind, abs, state, labelOfFile(abs), variant))
      }
      if (!files.length) continue
      // 先按版本分组（正式版 → 简报版 → 交互版），组内 PDF 优先，其次 Word、HTML、Markdown
      files.sort((a, b) => {
        const va = VARIANT_ORDER[a.variant] ?? 9
        const vb = VARIANT_ORDER[b.variant] ?? 9
        if (va !== vb) return va - vb
        return (FILE_ORDER[a.kind] ?? 9) - (FILE_ORDER[b.kind] ?? 9)
      })
      const variants = [...new Set(files.map((f) => f.variant))]
      let updatedAt = latestMtime
      if (!updatedAt) {
        try {
          updatedAt = fs.statSync(dirPath).mtimeMs
        } catch { /* 忽略 */ }
      }
      const rangeMatch = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(rangeEntry.name)
      bundles.push({
        school: schoolEntry.name,
        range: rangeEntry.name,
        from: rangeMatch ? rangeMatch[1] : '',
        to: rangeMatch ? rangeMatch[2] : '',
        dir: dirPath,
        updatedAt: new Date(updatedAt || Date.now()).toISOString(),
        variants,
        files,
      })
    }
  }
  bundles.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return bundles.slice(0, 30)
}

function renderPdf(state, htmlFile, pdfFile) {
  return new Promise((resolve, reject) => {
    const chrome = state.config.chromePath
    if (!chrome || !fs.existsSync(chrome)) {
      reject(new Error('未找到 Chrome（请配置 chromePath）'))
      return
    }
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuulea-report-chrome-'))
    const args = [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-crash-reporter',
      '--no-first-run',
      '--no-pdf-header-footer',
      `--user-data-dir=${profileDir}`,
      `--print-to-pdf=${pdfFile}`,
      '--virtual-time-budget=10000',
      `file://${htmlFile}`,
    ]
    let child
    try {
      child = spawn(chrome, args, { stdio: 'ignore' })
    } catch (e) {
      reject(e)
      return
    }
    state.pdfJobs.add(child)
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      reject(new Error('PDF 生成超时'))
    }, state.config.pdfTimeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      state.pdfJobs.delete(child)
      reject(e)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      state.pdfJobs.delete(child)
      try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
      if (code === 0 && fs.existsSync(pdfFile) && fs.statSync(pdfFile).size > 1000) resolve()
      else reject(new Error(`Chrome 退出码 ${code}`))
    })
  })
}

// ---------------------------------------------------------------- 系统打开

/**
 * 用系统默认应用打开文件（或定位到文件所在位置）。
 * 说明：桌面端页面里用 <a target="_blank"> 交给外部浏览器并不可靠（Electron 会拦截弹窗，
 * 表现为「点了没反应」），因此统一由 Host 调用系统命令打开，保证有可见反馈。
 */
function openWithSystem(target, action) {
  const platform = process.platform
  let command = ''
  let args = []
  if (platform === 'darwin') {
    command = 'open'
    args = action === 'reveal' ? ['-R', target] : [target]
  } else if (platform === 'win32') {
    if (action === 'reveal') {
      command = 'explorer.exe'
      args = [`/select,${target}`]
    } else {
      command = 'cmd.exe'
      args = ['/c', 'start', '', target]
    }
  } else {
    command = 'xdg-open'
    args = [action === 'reveal' && safeIsFile(target) ? path.dirname(target) : target]
  }

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore' })
    } catch (e) {
      reject(new Error(`无法调用系统打开命令（${command}）：${e.message}`))
      return
    }
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else {
        try { child.unref() } catch { /* 忽略 */ }
        resolve()
      }
    }
    const timer = setTimeout(() => finish(new Error('调用系统打开命令超时')), 8000)
    child.once('error', (e) => finish(new Error(`无法调用系统打开命令（${command}）：${e.message}`)))
    child.once('spawn', () => finish())
  })
}

function safeIsFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- Agent 工具

/** 让 Agent 也会「取数生成报告」：与页面共用同一套 Host 方法。 */
function fmtPct(v) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(1) + '%'
}

function reportTool(state) {
  return {
    name: 'fuulea_teaching_report',
    description:
      '从辅立码课（智慧教学云）学校站点拉取「管理看板」数据并生成教学数据报告。' +
      'action=preview 只取数并返回三届概览与关键指标；action=generate 额外生成报告文件并返回路径。' +
      'mode 选择报告版本（默认 full）：' +
      'full=正式版（Markdown/可打印 HTML/Word/PDF，文件名「<学校>教学数据报告(<起>~<止>)」）；' +
      'brief=简报版（1~2 页速览，Word + PDF，文件名「<学校>使用简报(<起>~<止>)」）；' +
      'interactive=交互版（单文件 HTML，图表可交互，文件名「<学校>交互数据报告(<起>~<止>)」）。' +
      '只读操作，不会修改平台数据。school 为学校子域名（如 lyyz，对应 https://lyyz.fuulea.com）。',
    // dsh / DeepSeek 函数调用要求 parameters 是标准 JSON Schema：
    // 顶层必须是 type: 'object' 并带 properties。之前的「扁平参数表」写法
    // 没有 type 字段，dsh 转给 API 时 type 变成 null，被拒（INVALID_REQUEST）。
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['preview', 'generate'],
          description: 'preview = 只取数返回概览；generate = 生成报告文件',
        },
        mode: {
          type: 'string',
          enum: ['full', 'brief', 'interactive'],
          description:
            '报告版本（action=generate 时生效，默认 full）：' +
            'full = 正式版，生成 .md/.html/.docx/.pdf；' +
            'brief = 简报版，生成「使用简报」.docx/.pdf；' +
            'interactive = 交互版，生成「交互数据报告」交互式 .html（单文件，图表可交互）。',
        },
        school: {
          type: 'string',
          description: '学校子域名，如 lyyz；省略则用插件配置的默认学校',
        },
        from: {
          type: 'string',
          description: '统计开始日期，YYYY-MM-DD，省略则默认最近 N 天',
        },
        to: {
          type: 'string',
          description: '统计结束日期，YYYY-MM-DD，省略则默认昨天',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          modeTitle: { type: 'string' },
          siteTitle: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          totals: { type: 'object', additionalProperties: true },
          grades: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                gradeName: { type: 'string' },
                levelName: { type: 'string' },
                taskCount: { type: 'number' },
                questionCount: { type: 'number' },
                finishPercent: { type: 'number' },
                correctPercent: { type: 'number' },
                classCount: { type: 'number' },
              },
            },
          },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                kind: { type: 'string' },
                variant: { type: 'string' },
                label: { type: 'string' },
                name: { type: 'string' },
                path: { type: 'string' },
                bytes: { type: 'number' },
                url: { type: 'string' },
              },
            },
          },
          warnings: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {}
        if (!v.ok) return [{ type: 'text', text: '生成失败：' + (v.error || '未知错误') }]
        const lines = [
          `站点：${v.siteTitle}　区间：${v.from} ~ ${v.to}` + (v.modeTitle ? `　版本：${v.modeTitle}` : ''),
          `合计：任务 ${v.totals?.taskCount} 次、习题 ${v.totals?.questionCount} 道`,
          ...(v.grades || []).map((g) => `${g.gradeName}（${g.levelName}）任务 ${g.taskCount} 次 / 习题 ${g.questionCount} 道 / 完成率 ${fmtPct(g.finishPercent)} / 得分率 ${fmtPct(g.correctPercent)}`),
        ]
        if (v.files?.length) {
          lines.push('报告文件：')
          for (const f of v.files) lines.push(`- ${f.label}：${f.path}`)
        }
        if (v.warnings?.length) lines.push('提示：' + v.warnings.join('；'))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      const params = args || {}
      try {
        const snapshot = await snapshotFor(state, {
          school: params.school,
          from: params.from,
          to: params.to,
        })
        const base = {
          ok: true,
          siteTitle: snapshot.meta.siteTitle,
          from: snapshot.meta.from,
          to: snapshot.meta.to,
          totals: snapshot.totals,
          grades: snapshot.grades.map((g) => ({
            gradeName: g.gradeName,
            levelName: g.levelName,
            taskCount: g.summary.taskCount,
            questionCount: g.summary.questionCount,
            finishPercent: g.summary.finishPercent,
            correctPercent: g.summary.correctPercent,
            classCount: g.classCount,
          })),
          warnings: snapshot.warnings || [],
        }
        if (params.action !== 'generate') return base
        const mode = normalizeMode(params.mode)
        const result = await generateReport(state, snapshot, { mode })
        return {
          ...base,
          mode,
          modeTitle: MODE_TITLE[mode],
          files: result.files,
          warnings: [...base.warnings, ...result.warnings],
        }
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) }
      }
    },
    presentCall: (args) => ({ card: 'generic', title: '生成教学数据报告', kind: 'other', rawInput: args }),
  }
}

// ---------------------------------------------------------------- 文件服务

async function serveFile(state, url, res) {
  const rel = url.searchParams.get('path') || ''
  const root = state.outputRoot()
  const abs = path.resolve(root, rel)
  const rootResolved = path.resolve(root)
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    return json(res, 403, { ok: false, error: '只能读取报告目录内的文件' })
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return json(res, 404, { ok: false, error: '文件不存在：' + rel })
  }
  const ext = path.extname(abs).toLowerCase()
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.md': 'text/markdown; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
  }
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Content-Length': fs.statSync(abs).size,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`,
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(abs).pipe(res)
}

// ---------------------------------------------------------------- 工具

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report'
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try { resolve(JSON.parse(text)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export default { name, inject, apply }
