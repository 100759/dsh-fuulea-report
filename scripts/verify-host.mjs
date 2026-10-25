// 本地验收脚本（不依赖已安装插件，直接挂载 Host 路由）：
//   1. 绑定存储读写 / 权限 / 脱敏
//   2. bind → defaults → snapshot → report → reports → open → unbind 全链路
//
// 用法：node scripts/verify-host.mjs [school] [from] [to]
// 说明：会真实登录一次学校站点（只读 GET），并把绑定/报告写到临时目录，不污染用户主目录。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { BindingStore, aliasOf, isValidAlias } from '../lib/bindings.js'
import { apply } from '../index.js'

const school = process.argv[2] || 'lyyz'
const from = process.argv[3] || '2026-10-08'
const to = process.argv[4] || '2026-10-21'

let failures = 0
function check(label, ok, extra = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fuulea-verify-'))
const bindingsFile = path.join(tmp, 'bindings', 'bindings.json')
const outputDir = path.join(tmp, 'reports')
fs.mkdirSync(outputDir, { recursive: true })

// ---------------------------------------------------------------- 1. 绑定存储

{
  const store = new BindingStore(bindingsFile)
  check('绑定文件初始为空', store.list().length === 0)
  store.save({
    alias: 'demo',
    baseUrl: 'https://demo.fuulea.com',
    siteTitle: '演示中学',
    username: 'demo-admin',
    password: 'secret',
    token: 't',
    tokenExpiresAt: Date.now() + 3600_000,
    user: { siteId: 7, siteTitle: '演示中学', chargedGradeIds: [1, 2] },
  })
  const list = store.list()
  check('保存后列表可读', list.length === 1 && list[0].alias === 'demo' && list[0].siteTitle === '演示中学')
  check('列表不含密码与令牌', !('password' in list[0]) && !('token' in list[0]) && list[0].hasPassword === true)
  check('账号脱敏', list[0].maskedUsername === 'de*****n' || /^\S*\*+\S*$/.test(list[0].maskedUsername), list[0].maskedUsername)
  const mode = fs.statSync(bindingsFile).mode & 0o777
  check('绑定文件权限 0600', mode === 0o600, '0o' + mode.toString(8))
  const raw = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'))
  check('内部存储保留密码与用户信息', raw.schools.demo.password === 'secret' && raw.schools.demo.user.siteId === 7)
  store.setLastRange(from, to)
  store.setLastSchool('demo')
  check('记住最近学校与区间', store.defaultSchool() === 'demo' && store.lastRange().from === from)
  check('别名规范化', aliasOf('https://LYYZ.fuulea.com/x') === 'lyyz' && isValidAlias('a-b1') && !isValidAlias('a b'))
  store.remove('demo')
  check('解除绑定', store.list().length === 0)
  fs.writeFileSync(bindingsFile, '{broken json')
  check('损坏文件容错', store.list().length === 0)
}

// ---------------------------------------------------------------- 2. 路由全链路

const routes = []
const tools = []
const ctx = {
  effect(fn) {
    return fn()
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  tools: {
    register(definition) {
      tools.push(definition)
      return () => {}
    },
  },
  get() {
    return undefined
  },
  logger: { warn: (...args) => console.warn('[warn]', ...args), error: console.error },
}

apply(ctx, {
  defaultSchool: school,
  bindingsFile,
  outputDir,
  defaultDays: 14,
})

const prefix = routes.find((route) => route.kind === 'prefix')
check('注册 prefix 路由', !!prefix && prefix.path === '/fuulea-report/api')
check('注册 Agent 工具', tools.length === 1 && tools[0].name === 'fuulea_teaching_report')

function call(method, sub, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = new Readable({
      read() {
        if (payload !== null) this.push(payload)
        this.push(null)
      },
    })
    req.method = method
    req.url = `/fuulea-report/api/${sub}`
    const chunks = []
    let status = 0
    const res = {
      headers: {},
      writeHead(code, headers) {
        status = code
        this.headers = headers || {}
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk))
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          /* 非 JSON */
        }
        resolve({ status, json, text })
      },
    }
    Promise.resolve(prefix.handler(req, res)).catch(reject)
  })
}

const schoolTitle = { value: '' }

{
  const defaults = await call('GET', 'defaults')
  check('GET /defaults', defaults.status === 200 && defaults.json.ok === true)
  check('默认参数包含绑定信息', Array.isArray(defaults.json.defaults.bindings) && defaults.json.defaults.bindingsFile === bindingsFile)
}

{
  const bad = await call('POST', 'bind', { school: 'bad alias!', username: 'u', password: 'p' })
  check('非法学校别名被拒绝', bad.status === 400 && /子域名/.test(bad.json.error), bad.json && bad.json.error)
}

{
  // 使用本机技能包凭据做一次真实登录 → 绑定
  const { readCredentialsFile, DEFAULT_CREDENTIALS_FILE } = await import('../lib/api.js')
  const saved = readCredentialsFile(DEFAULT_CREDENTIALS_FILE, aliasOf(school))
  if (!saved) {
    console.log(`SKIP  ${school} 没有本机凭据，跳过真实登录相关用例`)
  } else {
    const bound = await call('POST', 'bind', { school, username: saved.username, password: saved.password })
    check('POST /bind（真实登录）', bound.status === 200 && bound.json.ok === true, bound.json && bound.json.error)
    const binding = bound.json && bound.json.binding
    check('绑定返回学校名与脱敏账号', !!binding && !!binding.siteTitle && !binding.password && !binding.token)
    schoolTitle.value = binding ? binding.siteTitle : ''
    check('绑定列表包含学校', bound.json.bindings.some((item) => item.alias === aliasOf(school)))

    const defaults = await call('GET', 'defaults')
    check('默认学校为最近绑定学校', defaults.json.defaults.school === aliasOf(school) && defaults.json.defaults.lastSchool === aliasOf(school))
    check('defaults 不回传密码', !JSON.stringify(defaults.json).includes(saved.password))

    const snapshot = await call('POST', 'snapshot', { school, from, to })
    const snap = snapshot.json && snapshot.json.snapshot
    check('POST /snapshot（免账号密码，使用绑定）', snapshot.status === 200 && !!snap, snapshot.json && snapshot.json.error)
    if (snap) {
      check('快照包含学校名 / 年级 / 合计', !!snap.meta.siteTitle && snap.grades.length > 0 && typeof snap.totals.taskCount === 'number',
        `${snap.meta.siteTitle} | 年级 ${snap.grades.length} | 任务 ${snap.totals.taskCount}`)
      check('快照区间正确', snap.meta.from === from && snap.meta.to === to)
    }

    const report = await call('POST', 'report', { school, from, to, formats: ['markdown', 'html'] })
    check('POST /report', report.status === 200 && report.json.ok === true, report.json && report.json.error)
    const files = (report.json && report.json.files) || []
    check('生成 Markdown + HTML', files.length === 2 && files.every((file) => fs.existsSync(file.path) && file.bytes > 1000))
    check('文件带可打开地址', files.every((file) => /^\/fuulea-report\/api\/file\?path=/.test(file.url)))

    const reports = await call('GET', 'reports')
    check('GET /reports 扫描历史报告', reports.status === 200 && reports.json.reports.length >= 1,
      `${reports.json.reports.length} 份`)
    const bundle = reports.json.reports[0]
    check('历史报告含文件与目录', bundle.files.length === 2 && fs.existsSync(bundle.dir), bundle.dir)
    check('历史报告更新时间取最新文件时间', Date.now() - Date.parse(bundle.updatedAt) < 10 * 60 * 1000,
      bundle.updatedAt)

    // 更旧的历史报告应排在后面
    const olderDir = path.join(outputDir, '更早的学校', '2026-01-01_2026-01-02')
    fs.mkdirSync(olderDir, { recursive: true })
    const olderFile = path.join(olderDir, '旧报告.md')
    fs.writeFileSync(olderFile, '# 旧报告')
    const oldTime = new Date(Date.now() - 7 * 24 * 3600 * 1000)
    fs.utimesSync(olderFile, oldTime, oldTime)
    const reports2 = await call('GET', 'reports')
    check('历史报告按更新时间倒序', reports2.json.reports.length === 2 && reports2.json.reports[0].dir === bundle.dir,
      reports2.json.reports.map((item) => item.dir).join(' | '))

    const forbidden = await call('POST', 'open', { path: '/etc/hosts' })
    check('open 拒绝报告目录外的文件', forbidden.status === 400 && /只能打开/.test(forbidden.json.error))
    const missing = await call('POST', 'open', { path: path.join(outputDir, 'nope.pdf') })
    check('open 拒绝不存在的文件', missing.status === 400 && /不存在/.test(missing.json.error))

    const raw = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'))
    const record = raw.schools[aliasOf(school)]
    check('快照后绑定已保存令牌与用户信息',
      !!record && !!record.password && typeof record.token === 'string' && record.token.length > 20 && !!record.user && !!record.user.siteId)
    check('快照后记录最近区间', raw.lastRange && raw.lastRange.from === from && raw.lastRange.to === to)

    const unbound = await call('POST', 'unbind', { school })
    check('POST /unbind', unbound.status === 200 && unbound.json.ok === true && unbound.json.removed === true)
    check('解除后绑定列表为空', unbound.json.bindings.length === 0)
  }
}

console.log('')
console.log(failures === 0 ? '全部用例通过' : `${failures} 个用例失败`)
console.log('临时目录：' + tmp)
process.exit(failures === 0 ? 0 : 1)
