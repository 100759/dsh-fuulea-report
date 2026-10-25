// Client 半边的本地冒烟测试（不依赖浏览器）：
// 用一个极简 React 替身 + 渲染循环，跑通「打开工作台 → 自动取数 → 生成报告 → 打开文件 →
// 切换/新增学校」的交互路径，捕获渲染期与交互逻辑里的运行时异常。
//
// 用法：node scripts/client-smoke.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = path.join(root, 'client.js')
const sampleFile = path.join(root, 'sample-model.json')
if (!fs.existsSync(sampleFile)) {
  console.error('缺少 sample-model.json：仓库不随附真实学校数据。')
  console.error('请先运行：node scripts/test-data.mjs lyyz 2026-10-08 2026-10-21')
  process.exit(1)
}
const sample = JSON.parse(fs.readFileSync(sampleFile, 'utf8'))

let failures = 0
function check(label, ok, extra = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}

// ---------------------------------------------------------------- 极简 React

let currentInstance = null
let dirty = false
let pendingEffects = []

function nameOf(type) {
  return (type && (type.displayName || type.name)) || 'anonymous'
}

const instances = new Map()

function getInstance(key) {
  let instance = instances.get(key)
  if (!instance) {
    instance = { key, hooks: [], index: 0, ranEffects: [] }
    instances.set(key, instance)
  }
  return instance
}

const React = {
  createElement(type, props, ...children) {
    const nextProps = Object.assign({}, props)
    if (children.length) nextProps.children = children.length === 1 ? children[0] : children
    return { $$el: true, type, props: nextProps, key: nextProps.key }
  },
  useState(initial) {
    const instance = currentInstance
    const index = instance.index++
    if (!(index in instance.hooks)) {
      instance.hooks[index] = typeof initial === 'function' ? initial() : initial
    }
    const setter = (value) => {
      const previous = instance.hooks[index]
      const next = typeof value === 'function' ? value(previous) : value
      if (!Object.is(previous, next)) {
        instance.hooks[index] = next
        dirty = true
      }
    }
    return [instance.hooks[index], setter]
  },
  useEffect(fn) {
    const instance = currentInstance
    const index = instance.index++
    if (!instance.ranEffects.includes(index)) {
      pendingEffects.push({ instance, index, fn })
    }
  },
  useRef(initial) {
    const instance = currentInstance
    const index = instance.index++
    if (!(index in instance.hooks)) instance.hooks[index] = { current: initial }
    return instance.hooks[index]
  },
}

// ---------------------------------------------------------------- 渲染

function renderNode(node, pathKey) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (Array.isArray(node)) {
    return { children: node.map((child, index) => renderNode(child, pathKey + '.' + index)).filter(Boolean) }
  }
  if (!node.$$el) throw new Error('未知节点：' + JSON.stringify(node))
  const { type, props } = node
  if (typeof type === 'function') {
    const key = pathKey + '<' + nameOf(type) + '>'
    const instance = getInstance(key)
    const previous = currentInstance
    currentInstance = instance
    instance.index = 0
    let output
    try {
      output = type(props || {})
    } finally {
      currentInstance = previous
    }
    return renderNode(output, key)
  }
  if (typeof type === 'string') {
    const children = props && props.children
    return {
      type,
      props: props || {},
      children: children === undefined ? [] : [].concat(renderNode(children, pathKey + '>' + type)).filter(Boolean),
    }
  }
  throw new Error('未知元素类型：' + String(type))
}

function collect(node, out = []) {
  if (!node) return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (node.text !== undefined) {
    out.push({ text: node.text })
    return out
  }
  out.push(node)
  if (node.children) collect(node.children, out)
  return out
}

function textOf(node) {
  return collect(node)
    .filter((item) => item.text !== undefined)
    .map((item) => item.text)
    .join(' ')
}

function findAll(node, predicate) {
  return collect(node).filter((item) => item.type !== undefined && predicate(item))
}

function findByType(node, type) {
  return findAll(node, (item) => item.type === type)
}

function findButton(node, text) {
  return findAll(node, (item) => item.type === 'button' && textOf(item).includes(text))
}

// ---------------------------------------------------------------- 环境替身

const response = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
})

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuulea-client-'))
const reportDir = path.join(tmpDir, '福建省龙岩第一中学', '2026-10-11_2026-10-24')
fs.mkdirSync(reportDir, { recursive: true })
const pdfPath = path.join(reportDir, '报告.pdf')
const htmlPath = path.join(reportDir, '报告.html')
fs.writeFileSync(pdfPath, 'pdf')
fs.writeFileSync(htmlPath, '<html></html>')

const binding = {
  alias: 'lyyz',
  baseUrl: 'https://lyyz.fuulea.com',
  siteTitle: '福建省龙岩第一中学',
  username: 'lyyzadmin',
  maskedUsername: 'lyy***n',
  boundAt: '2026-10-20T02:00:00.000Z',
  lastUsedAt: '2026-10-24T02:00:00.000Z',
  hasPassword: true,
  tokenValidUntil: Date.now() + 3600_000,
}

const reportPayload = {
  ok: true,
  files: [
    { kind: 'markdown', variant: 'full', label: 'Markdown 报告', name: '报告.md', path: path.join(reportDir, '报告.md'), bytes: 2048, url: '/fuulea-report/api/file?path=x.md' },
    { kind: 'html', variant: 'full', label: '可打印 HTML 报告', name: '报告.html', path: htmlPath, bytes: 4096, url: '/fuulea-report/api/file?path=x.html' },
    { kind: 'pdf', variant: 'full', label: 'PDF 报告', name: '报告.pdf', path: pdfPath, bytes: 8192, url: '/fuulea-report/api/file?path=x.pdf' },
  ],
  stats: { gradeCount: 3, sectionCount: 18, taskCount: 655, questionCount: 23456 },
  warnings: ['示例提示'],
  outputDir: reportDir,
  school: '福建省龙岩第一中学',
}

const calls = { snapshot: 0, report: 0, open: [], defaults: 0, reports: 0, unbind: [], updateCheck: 0, update: 0 }

async function fakeFetch(url, init) {
  const pathname = String(url)
  const method = (init && init.method) || 'GET'
  if (pathname.includes('/defaults')) {
    calls.defaults++
    return response({
      ok: true,
      version: '1.1.0',
      defaults: {
        school: 'lyyz',
        schoolTitle: '福建省龙岩第一中学',
        days: 14,
        from: '2026-10-11',
        to: '2026-10-24',
        lastRange: { from: '2026-10-11', to: '2026-10-24' },
        outputDir: tmpDir,
        chromeAvailable: true,
        credentialsFile: '/tmp/credentials',
        credentialsFileExists: true,
        bindingsFile: '/tmp/bindings.json',
        bindings: [binding],
        lastSchool: 'lyyz',
      },
    })
  }
  if (pathname.includes('/update-check')) {
    calls.updateCheck++
    return response({
      ok: true,
      version: '1.3.0',
      repo: '100759/dsh-fuulea-report',
      repoUrl: 'https://github.com/100759/dsh-fuulea-report',
      latest: '1.4.0',
      updateAvailable: true,
      source: 'github',
      spec: 'github:100759/dsh-fuulea-report',
      disabled: false,
      checkedAt: Date.now(),
      error: '',
    })
  }
  if (pathname.includes('/update')) {
    calls.update++
    return response({ ok: true, from: '1.3.0', to: '1.4.0', latest: '1.4.0', restartRequired: true, message: '已更新到 1.4.0，重启 DeepSeek Harness 后生效' })
  }
  if (pathname.includes('/reports')) {
    calls.reports++
    return response({
      ok: true,
      reports: [
        {
          school: '福建省龙岩第一中学',
          range: '2026-10-11_2026-10-24',
          from: '2026-10-11',
          to: '2026-10-24',
          dir: reportDir,
          updatedAt: '2026-10-24T03:00:00.000Z',
          files: reportPayload.files,
        },
      ],
    })
  }
  if (pathname.includes('/snapshot')) {
    calls.snapshot++
    return response({ ok: true, snapshot: sample, bindings: [binding], lastSchool: 'lyyz' })
  }
  if (pathname.includes('/report') && method === 'POST') {
    calls.report++
    return response(reportPayload)
  }
  if (pathname.includes('/open')) {
    calls.open.push(JSON.parse(init.body))
    return response({ ok: true, action: 'open' })
  }
  if (pathname.includes('/unbind')) {
    calls.unbind.push(JSON.parse(init.body))
    return response({ ok: true, removed: true, bindings: [], lastSchool: '' })
  }
  throw new Error('未模拟的接口：' + method + ' ' + pathname)
}

const sandbox = {
  window: { __ModuleLoader__: { load() {} }, confirm: () => true, open: () => null },
  document: { createElement: () => ({ style: {}, setAttribute() {}, select() {} }), body: { appendChild() {}, removeChild() {} }, execCommand: () => true },
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: fakeFetch,
  console,
  setTimeout,
  clearTimeout,
  AbortController,
  URL,
  TextEncoder,
}
sandbox.window.window = sandbox.window
sandbox.globalThis = sandbox

const source = fs.readFileSync(clientPath, 'utf8')
const context = vm.createContext(sandbox)
let registration = null
sandbox.window.__ModuleLoader__ = {
  load(value) {
    registration = value
  },
}
vm.runInContext(source, context, { filename: 'fuulea-report/client.js' })
check('client.js 注册模块', !!registration && registration.id === 'dsh-fuulea-report')

const factory = registration.factory
const moduleFace = factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error('未模拟的模块：' + specifier)
})
check('factory 返回 inject/apply', Array.isArray(moduleFace.inject) && typeof moduleFace.apply === 'function')

const slots = {}
const ctx = {
  slots: {
    inject(name, callback) {
      const result = callback()
      slots[name] = result
      return () => {}
    },
    register(options, component) {
      return { options, component }
    },
  },
}
moduleFace.apply(ctx)
check('注册左侧入口', !!slots['sidebar.panellist'] && slots['sidebar.panellist'].options.id === 'fuulea-report')
check('注册主面板', !!slots.main && slots.main.options.key === 'fuulea-report')

const ReportPage = slots.main.component
const treeRef = { current: null }

async function renderUntilStable() {
  for (let round = 0; round < 25; round++) {
    dirty = false
    pendingEffects = []
    const mounted = []
    const instanceCountBefore = instances.size
    // 收集本轮需要执行的新 effect
    const tree = renderNode(React.createElement(ReportPage, {}), 'root')
    treeRef.current = tree
    for (const effect of pendingEffects) {
      if (effect.instance.ranEffects.includes(effect.index)) continue
      effect.instance.ranEffects.push(effect.index)
      mounted.push(effect)
    }
    for (const effect of mounted) {
      try {
        const cleanup = effect.fn()
        if (typeof cleanup === 'function') effect.instance.cleanup = cleanup
      } catch (err) {
        throw new Error('effect 执行失败：' + (err && err.message ? err.message : err))
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    void instanceCountBefore
    if (!dirty) return tree
  }
  throw new Error('渲染未在 25 轮内稳定')
}

let tree
try {
  tree = await renderUntilStable()
} catch (err) {
  check('首次渲染（自动取数）', false, err && err.message)
  process.exit(1)
}

let pageText = textOf(tree)
check('渲染标题与工具栏', pageText.includes('教学数据报告') && pageText.includes('辅助') === false && pageText.includes('获取数据') && pageText.includes('生成正式版'))
check('已绑定学校展示', pageText.includes('福建省龙岩第一中学') && pageText.includes('lyy***n') && pageText.includes('已绑定'))
check('自动取数（无需再输入账号密码）', calls.snapshot === 1, 'snapshot 调用 ' + calls.snapshot + ' 次')
check('版本检查发出（红点数据来源）', calls.updateCheck >= 1, 'update-check 调用 ' + calls.updateCheck + ' 次')
check('版本徽标显示新版本红点', pageText.includes('v1.3.0') && pageText.includes('可更新'))
check('升级面板渲染（立即更新 / 检查更新）', pageText.includes('有新版本可用：v1.4.0') && pageText.includes('立即更新') && pageText.includes('检查更新'))
check('三届合计与年级 Tab 渲染', pageText.includes('三届合计') && pageText.includes('2024级') && pageText.includes('2025级') && pageText.includes('2026级'))
check('学科/教师/自学表格渲染', pageText.includes('学科统计') && pageText.includes('教师统计') && pageText.includes('自学数据'))
check('拉取默认值与历史报告', calls.defaults === 1 && calls.reports >= 1)
check('历史报告区块渲染', pageText.includes('历史报告') && pageText.includes('打开 PDF'))
check('绑定时长提示（本机保存账号）', pageText.includes('账号只保存在本机'))

// ---- 生成报告（正式版 / 简报 / 交互版三颗；主路径仍为「生成正式版」）
const reportButtons = findButton(tree, '生成正式版')
check('「生成正式版」按钮可用', reportButtons.length === 1 && reportButtons[0].props.disabled === false)
const modeButtons = findAll(tree, (item) => item.type === 'button' && /^生成(正式版|简报|交互版)/.test(textOf(item)))
check('工具栏有「生成正式版 / 生成简报 / 生成交互版」三颗按钮', modeButtons.length === 3)
reportButtons[0].props.onClick({ preventDefault() {} })
await renderUntilStable()
tree = treeRef.current
pageText = textOf(tree)
check('生成报告请求发出', calls.report === 1)
check('报告面板渲染', pageText.includes('报告已生成') && pageText.includes('打开最新报告') && pageText.includes('PDF 报告'))
check('报告统计摘要', pageText.includes('包含 3 个年级'))

// ---- 打开 PDF（Host 原生打开）
const openPdfButtons = findAll(tree, (item) => item.type === 'button' && textOf(item) === '打开 PDF')
check('报告文件有「打开 PDF」按钮', openPdfButtons.length >= 1, '共 ' + openPdfButtons.length + ' 个')
openPdfButtons[0].props.onClick({ preventDefault() {} })
await renderUntilStable()
tree = treeRef.current
pageText = textOf(tree)
check('打开动作调用 Host /open', calls.open.length === 1 && calls.open[0].path === pdfPath, JSON.stringify(calls.open[0] || null))
check('打开成功状态回显', pageText.includes('已打开'))

// ---- 打开报告目录
const openDirButtons = findAll(tree, (item) => item.type === 'button' && textOf(item) === '打开文件夹')
check('报告目录有「打开文件夹」按钮', openDirButtons.length === 1)
openDirButtons[0].props.onClick({ preventDefault() {} })
await renderUntilStable()
check('打开目录调用 Host /open', calls.open.some((call) => call.path === reportDir))

// ---- 切换学校（选择「绑定其他学校」）
const selects = findByType(treeRef.current, 'select')
check('学校下拉存在', selects.length === 1)
selects[0].props.onChange({ target: { value: '__add__' } })
await renderUntilStable()
tree = treeRef.current
pageText = textOf(tree)
check('进入新增学校模式', pageText.includes('新学校子域名') && pageText.includes('绑定并登录') && pageText.includes('账号'))

// ---- 切回已绑定学校
const selectsAgain = findByType(treeRef.current, 'select')
selectsAgain[0].props.onChange({ target: { value: 'lyyz' } })
await renderUntilStable()
tree = treeRef.current
check('切回已绑定学校后再次自动取数', calls.snapshot === 2 && textOf(tree).includes('已绑定'))
check('切回后已退出新增模式', !textOf(tree).includes('新学校子域名'))

// ---- 解除绑定
const unbindButtons = findAll(tree, (item) => item.type === 'button' && textOf(item) === '解除绑定')
check('存在「解除绑定」入口', unbindButtons.length === 1)
unbindButtons[0].props.onClick({ preventDefault() {} })
await renderUntilStable()
check('解除绑定调用 Host', calls.unbind.length === 1 && calls.unbind[0].school === 'lyyz')
pageText = textOf(treeRef.current)
check('解除后回到未绑定状态', pageText.includes('未绑定账号') && pageText.includes('学校子域名') && pageText.includes('绑定并登录'))

// ---- 再次渲染不报错（防止 hooks 顺序问题）
try {
  await renderUntilStable()
  check('二次渲染稳定', true)
} catch (err) {
  check('二次渲染稳定', false, err && err.message)
}

console.log('')
console.log(failures === 0 ? '全部用例通过' : `${failures} 个用例失败`)
process.exit(failures === 0 ? 0 : 1)
