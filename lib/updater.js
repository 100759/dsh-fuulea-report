// 版本检查与一键更新。
//
// 数据来源（只读）：GitHub 上本插件仓库 HEAD 的 package.json（raw.githubusercontent.com），
// 与「本机已安装版本」比较，判断是否有新版本；有新版本时页面上的版本徽标显示红点。
//
// 更新动作（仅当本机是按 GitHub 源安装时才执行）：
//   pluginManager 同样是在 profile 目录里跑 pnpm，因此这里使用相同的
//   `pnpm add github:<owner>/<repo>`（git 依赖每次都会重新解析到最新提交）。
//   更新落盘后，运行中的进程仍持有旧模块，需要重启 DeepSeek Harness 才生效。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 发布仓库（插件主页）。 */
export const DEFAULT_REPO = '100759/dsh-fuulea-report'

/** 版本检查缓存时长：10 分钟。 */
const CHECK_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 12_000
const UPDATE_TIMEOUT_MS = 180_000

/** 读取某个目录下 package.json 的版本号。 */
export function readLocalVersion(pkgDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** 本机 profile 目录：优先环境变量，其次 $DSH_HOME/profiles/<DSH_PROFILE>，最后从本模块位置向上找。 */
export function resolveProfileDir(packageDir) {
  const fromEnv = String(process.env.DSH_PROFILE_DIR || '').trim()
  if (fromEnv) return path.resolve(fromEnv)
  const profile = String(process.env.DSH_PROFILE || '').trim()
  const home = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
  if (profile) {
    const candidate = path.join(home, 'profiles', profile)
    if (fs.existsSync(candidate)) return candidate
  }
  // 环境变量不可用时（例如桌面端进程没注入），从安装位置向上找 profile：
  // 已安装的在 <profile>/node_modules/<pkg>，源码调试的在其任意子目录，都能走到 profile 根。
  let dir = packageDir ? path.resolve(packageDir) : ''
  for (let i = 0; i < 6 && dir; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      if (pkg && pkg.dsh && pkg.dsh.profile) return dir
    } catch { /* 该层没有 package.json，继续向上 */ }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // 再退回扫描 ~/.dsh/profiles/*，找出真正声明了这个依赖的 profile。
  try {
    const root = path.join(home, 'profiles')
    for (const name of fs.readdirSync(root)) {
      const dir2 = path.join(root, name)
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir2, 'package.json'), 'utf8'))
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
        if (deps['dsh-fuulea-report']) return dir2
      } catch { /* 跳过 */ }
    }
  } catch { /* 没有 profiles 目录 */ }
  return ''
}

/**
 * 从各种「指向 GitHub 仓库」的依赖写法里解析出 owner/repo。
 * pnpm 允许的写法都认：
 *   github:owner/repo[#ref]
 *   owner/repo[#ref]（GitHub 简写，pnpm 也接受）
 *   git+https://github.com/owner/repo.git[#ref]
 *   https://github.com/owner/repo[.git][#ref]
 *   git+ssh://git@github.com/owner/repo.git[#ref]
 *   git://github.com/owner/repo.git
 * 解析不出来返回空串。
 */
export function parseGithubRepo(spec) {
  const raw = String(spec || '').trim()
  if (!raw) return ''
  // 去掉 #ref 与 ?query
  const body = raw.split('#')[0].split('?')[0].trim()

  // 1) github:owner/repo
  if (/^github:/i.test(body)) {
    const rest = body.slice('github:'.length).trim().replace(/\.git$/i, '')
    return /^[\w.-]+\/[\w.-]+$/.test(rest) ? rest : ''
  }

  // 2) 完整 URL（含 git+https / git+ssh / https / git）
  const urlMatch = /^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(body)
  if (urlMatch) {
    const owner = urlMatch[1]
    const repo = urlMatch[2].replace(/\.git$/i, '')
    return owner && repo ? `${owner}/${repo}` : ''
  }

  // 3) owner/repo 简写
  if (/^[\w.-]+\/[\w.-]+$/.test(body) && !body.includes(':')) {
    return body
  }
  return ''
}

/**
 * 本机这个包是怎么装的（取决于 profile/package.json 里的依赖写法）：
 *   github / link / file / registry / unknown
 *
 * 注意：只要是「指向 GitHub 仓库」的写法，一律归为 github 并给出 repo，
 * 否则用户用 git+https:// 安装时会被判成 git，页面上的「立即更新」直接禁用。
 */
export function detectInstallSource(profileDir, packageName) {
  const result = { source: 'unknown', spec: '', repo: '', profileDir: profileDir || '' }
  if (!profileDir) return result
  let pkg = null
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return result
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  const spec = String(deps[packageName] || '')
  result.spec = spec
  if (!spec) return result

  if (spec.startsWith('link:') || spec.startsWith('file:') || spec.startsWith('workspace:')) {
    result.source = 'link'
    return result
  }

  // 先尝试按 GitHub 仓库解析：github: / git+https:// / https://github.com/ / owner/repo
  const repo = parseGithubRepo(spec)
  if (repo) {
    result.source = 'github'
    result.repo = repo
    return result
  }

  if (spec.startsWith('git') || spec.includes('://')) {
    result.source = 'git'
  } else {
    result.source = 'registry'
  }
  return result
}

/** 版本号比较：返回 1 表示 a 更新，-1 表示 b 更新，0 表示相同。 */
export function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split(/[.+-]/)
  const pb = String(b || '').replace(/^v/i, '').split(/[.+-]/)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i], 10)
    const nb = parseInt(pb[i], 10)
    const va = Number.isFinite(na) ? na : 0
    const vb = Number.isFinite(nb) ? nb : 0
    if (va > vb) return 1
    if (va < vb) return -1
  }
  return 0
}

/**
 * 读取 GitHub 上最新 package.json 的版本。
 * 先走 contents API（实时，无 CDN 缓存滞后），失败再退回 raw.githubusercontent.com
 * （raw 的 HEAD 有 CDN 缓存，刚发版后可能仍返回旧内容）。
 */
export async function fetchRemotePackage(repo, options) {
  const owner = String(repo || DEFAULT_REPO)
  const timeoutMs = (options && options.timeoutMs) || FETCH_TIMEOUT_MS
  const errors = []

  // 1) contents API：{ content: base64 }
  try {
    const body = await getJson(`https://api.github.com/repos/${owner}/contents/package.json?ref=HEAD`, timeoutMs)
    if (body && typeof body.content === 'string') {
      const text = Buffer.from(body.content, 'base64').toString('utf8')
      const pkg = JSON.parse(text)
      if (typeof pkg.version === 'string') {
        return {
          version: pkg.version,
          description: typeof pkg.description === 'string' ? pkg.description : '',
          repoUrl: `https://github.com/${owner}`,
        }
      }
    }
    errors.push('contents API 未返回版本号')
  } catch (e) {
    errors.push('contents API：' + (e && e.message ? e.message : String(e)))
  }

  // 2) raw 兜底
  try {
    const pkg = await getJson(`https://raw.githubusercontent.com/${owner}/HEAD/package.json?t=${Date.now()}`, timeoutMs)
    if (pkg && typeof pkg.version === 'string') {
      return {
        version: pkg.version,
        description: typeof pkg.description === 'string' ? pkg.description : '',
        repoUrl: `https://github.com/${owner}`,
      }
    }
    errors.push('raw 未返回版本号')
  } catch (e) {
    errors.push('raw：' + (e && e.message ? e.message : String(e)))
  }

  throw new Error(errors.join('；') || '无法读取 GitHub 上的 package.json')
}

async function getJson(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
        'user-agent': 'dsh-fuulea-report',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 版本检查（带内存缓存）。
 * @returns {{ current: string, latest: string, updateAvailable: boolean,
 *             repo: string, repoUrl: string, source: string, spec: string,
 *             checkedAt: number, error: string }}
 */
export function createVersionChecker(options) {
  const opts = options || {}
  const cache = { info: null, at: 0, pending: null }

  async function check(force) {
    const now = Date.now()
    if (!force && cache.info && now - cache.at < CHECK_TTL_MS) return cache.info
    if (cache.pending) return cache.pending
    cache.pending = (async () => {
      // running：当前进程加载的版本（重启前不变）；installed：磁盘上已装的版本（更新后立刻变）。
      const running = opts.currentVersion ? opts.currentVersion() : ''
      const installed = opts.installedVersion ? opts.installedVersion() : running
      const current = installed || running
      const repo = opts.repo || DEFAULT_REPO
      const install = opts.installSource ? opts.installSource() : { source: 'unknown', spec: '' }
      const base = {
        current,
        running,
        installed,
        // 已装新版本但进程还跑着旧代码：需要重启才能生效。
        restartPending: Boolean(installed && running && installed !== running),
        latest: '',
        updateAvailable: false,
        repo,
        repoUrl: `https://github.com/${repo}`,
        source: install.source,
        spec: install.spec,
        checkedAt: now,
        disabled: false,
        error: '',
      }
      // 配置里关闭了联网检查：不发起请求，只在页面上显示当前版本。
      if (opts.enabled === false) {
        return { ...base, disabled: true }
      }
      try {
        const remote = await fetchRemotePackage(repo, { timeoutMs: opts.timeoutMs })
        const info = {
          ...base,
          latest: remote.version,
          // 与「磁盘上已装的版本」比较：刚更新完就不会继续显示红点。
          updateAvailable: Boolean(remote.version) && compareVersions(remote.version, current) > 0,
          checkedAt: Date.now(),
        }
        cache.info = info
        cache.at = Date.now()
        return info
      } catch (e) {
        const info = { ...base, error: e && e.message ? e.message : String(e), checkedAt: Date.now() }
        // 失败只保留很短时间，避免网络恢复后长时间显示旧结论。
        cache.info = info
        cache.at = Date.now() - (CHECK_TTL_MS - 60_000)
        return info
      } finally {
        cache.pending = null
      }
    })()
    return cache.pending
  }

  function cached() {
    return cache.info
  }

  return { check, cached }
}

/**
 * Windows 命令行引号化：路径含空格（Program Files、中文用户名）时必须加引号，
 * 否则 cmd 会把路径截断成两段。已带引号的不重复处理。
 */
function quoteWin(value) {
  const text = String(value == null ? '' : value)
  if (!text) return '""'
  if (/^".*"$/.test(text)) return text
  // cmd 里 " 需要成对转义；这里只处理最常见的空格/特殊字符场景。
  return `"${text.replace(/"/g, '""')}"`
}

/** 找出 pnpm 可执行文件：PATH 里没有时再试几个常见安装位置。 */
export function findPnpm() {
  const extra = process.platform === 'win32'
    ? [
      path.join(process.env.APPDATA || '', 'npm'),
      path.join(process.env.LOCALAPPDATA || '', 'pnpm'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'pnpm'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
    ]
    : [
      path.join(os.homedir(), 'Library', 'pnpm'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      path.join(os.homedir(), '.local', 'share', 'pnpm'),
      path.join(os.homedir(), '.nvm', 'current', 'bin'),
    ]
  // Windows 上 pnpm 可能是 pnpm.cmd / pnpm.exe / pnpm.ps1，逐个试。
  const names = process.platform === 'win32'
    ? ['pnpm.cmd', 'pnpm.exe', 'pnpm.bat', 'pnpm']
    : ['pnpm']
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of [...dirs, ...extra]) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch { /* 忽略不可读目录 */ }
    }
  }
  return ''
}

/**
 * 从 GitHub 重新安装到本机 profile（git 依赖每次都会解析到最新提交）。
 * @returns {Promise<{ ok: boolean, from: string, to: string, log: string }>}
 */
export function runGithubUpdate(options) {
  const opts = options || {}
  const profileDir = opts.profileDir
  const repo = opts.repo || DEFAULT_REPO
  const packageName = opts.packageName
  if (!profileDir) return Promise.reject(new Error('找不到本机 profile 目录（DSH_PROFILE_DIR 未设置）'))
  const pnpm = findPnpm()
  if (!pnpm) return Promise.reject(new Error('本机没有找到 pnpm，无法自动更新；请手动执行 pnpm add github:' + repo))

  const before = readLocalVersion(path.join(profileDir, 'node_modules', packageName))
  const args = ['add', 'github:' + repo, '--reporter=append-only']

  // Windows 上 pnpm 是 .cmd 批处理，Node 18+ 出于安全考虑不再隐式套 shell，
  // 直接 spawn 会以 EINVAL 失败。这里显式走 shell 并把参数整体引号化。
  const isWin = process.platform === 'win32'
  const spawnTarget = isWin ? quoteWin(pnpm) : pnpm
  const spawnArgs = isWin
    ? args.map((a) => quoteWin(a))
    : args

  // PATH 里补上常见安装目录：桌面端进程的 PATH 往往比交互式终端窄。
  const extraPath = isWin
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'), path.join(process.env.APPDATA || '', 'npm')]
    : ['/opt/homebrew/bin', '/usr/local/bin']
  const envPath = [String(process.env.PATH || ''), ...extraPath.filter(Boolean)].join(path.delimiter)

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(spawnTarget, spawnArgs, {
        cwd: profileDir,
        env: { ...process.env, PATH: envPath },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: isWin,
        windowsHide: true,
      })
    } catch (e) {
      reject(e)
      return
    }
    let log = ''
    const collect = (chunk) => {
      log += chunk.toString()
      if (log.length > 20_000) log = log.slice(-20_000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      reject(new Error('更新超时（' + Math.round(UPDATE_TIMEOUT_MS / 1000) + ' 秒）'))
    }, opts.timeoutMs || UPDATE_TIMEOUT_MS)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error('无法执行 pnpm：' + e.message))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const after = readLocalVersion(path.join(profileDir, 'node_modules', packageName))
      if (code !== 0) {
        reject(new Error('pnpm 更新失败（退出码 ' + code + '）：' + tail(log)))
        return
      }
      resolve({ ok: true, from: before, to: after || before, log: tail(log) })
    })
  })
}

function tail(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean)
  return lines.slice(-6).join('\n')
}
