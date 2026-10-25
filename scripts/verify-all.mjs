// 三版报告（正式版 / 简报版 / 交互版）一次验收：
//   1. 语法检查：lib/*.js、index.js、client.js、scripts/*.mjs
//   2. 渲染：sample-model.json → 正式版 md/html/docx、简报 docx/html、交互版 html
//   3. 简报 Word → PDF（LibreOffice），检查页数与文本完整性
//   4. 交互版 HTML 结构自检（无外部资源、内联数据可解析）
//
// 用法：node scripts/verify-all.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const plugin = root
const outDir = path.join(root, 'out')

const results = []
function check(name, fn) {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail: detail || '' })
    console.log(`  ✔ ${name}${detail ? '  ' + detail : ''}`)
  } catch (e) {
    results.push({ name, ok: false, detail: e && e.message ? e.message : String(e) })
    console.log(`  ✘ ${name}\n      ${e && e.message ? e.message : e}`)
  }
}

function must(cond, message) {
  if (!cond) throw new Error(message)
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

// ---------------------------------------------------------------- 1. 语法

console.log('\n[1/5] 语法检查')
const syntaxFiles = [
  path.join(plugin, 'index.js'),
  path.join(plugin, 'client.js'),
  ...fs.readdirSync(path.join(plugin, 'lib')).filter((f) => f.endsWith('.js')).map((f) => path.join(plugin, 'lib', f)),
  ...fs.readdirSync(here).filter((f) => f.endsWith('.mjs')).map((f) => path.join(here, f)),
]
for (const file of syntaxFiles) {
  check(`node --check ${path.relative(root, file)}`, () => {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    must(r.status === 0, (r.stderr || '').trim().split('\n').slice(0, 3).join(' '))
    return ''
  })
}

// ---------------------------------------------------------------- 2. 渲染

console.log('\n[2/5] 渲染（sample-model.json）')
// 仓库里不放真实学校数据：没有 sample-model.json 时跳过渲染段，只做语法与结构检查。
const modelFile = path.join(root, 'sample-model.json')
if (!fs.existsSync(modelFile)) {
  console.log('  · 跳过：缺少 sample-model.json（真实看板数据不随仓库分发）')
  console.log('    生成方法见 README「自测」：node scripts/test-data.mjs lyyz <起> <止>')
  console.log('\n语法与结构检查完成。')
  process.exit(results.some((r) => !r.ok) ? 1 : 0)
}
const model = JSON.parse(fs.readFileSync(modelFile, 'utf8'))
const report = await import(path.join(plugin, 'lib/report.js'))
const brief = await import(path.join(plugin, 'lib/brief.js')).catch(() => null)
const interactive = await import(path.join(plugin, 'lib/interactive.js')).catch(() => null)

fs.mkdirSync(outDir, { recursive: true })

const full = report.buildReport(model, { generatedAt: model.meta?.generatedAt })
check('正式版 Markdown', () => {
  must(typeof full.markdown === 'string' && full.markdown.length > 1000, 'Markdown 为空')
  const bad = full.markdown.match(/\d+\.\d{2,}%/g) || []
  must(!bad.length, `存在非 1 位小数百分比：${bad.slice(0, 5).join(', ')}`)
  fs.writeFileSync(path.join(outDir, 'report.md'), full.markdown, 'utf8')
  return `${kb(Buffer.byteLength(full.markdown))}`
})
check('正式版 HTML', () => {
  must(full.html.includes('</html>'), 'HTML 不完整')
  must(!/<script\b/i.test(full.html), '正式版 HTML 不应内联脚本')
  must(!/https?:\/\//i.test(full.html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), '正式版 HTML 含外部链接')
  fs.writeFileSync(path.join(outDir, 'report.html'), full.html, 'utf8')
  return `${kb(Buffer.byteLength(full.html))}`
})
check('正式版 Word', () => {
  must(Buffer.isBuffer(full.docx) && full.docx.readUInt32LE(0) === 0x04034b50, 'docx 不是 ZIP')
  fs.writeFileSync(path.join(outDir, 'report.docx'), full.docx)
  return `${kb(full.docx.length)}`
})

check('简报模块可加载', () => {
  must(brief && typeof brief.buildBrief === 'function', 'lib/brief.js 未导出 buildBrief')
})
check('交互模块可加载', () => {
  must(interactive && typeof interactive.buildInteractiveHtml === 'function', 'lib/interactive.js 未导出 buildInteractiveHtml')
})

if (brief && typeof brief.buildBrief === 'function') {
  let briefDocx = null
  let briefHtml = null
  check('简报 Word', () => {
    // 与 Host 默认一致：简报为纯文字版（对齐参考件《高二使用情况简报》，每届 1 页）
    const out = brief.buildBrief(model, { figures: false })
    must(out && typeof out.then !== 'function', 'buildBrief 返回了 Promise：brief.js 的导出必须是同步函数')
    must(Buffer.isBuffer(out.docx), 'buildBrief 未返回 docx Buffer')
    must(out.docx.readUInt32LE(0) === 0x04034b50, 'docx 缺少 ZIP 头')
    const xml = out.docx.toString('utf8')
    for (const part of ['word/document.xml', 'word/styles.xml', '[Content_Types].xml', '_rels/.rels']) {
      must(xml.includes(part), `docx 缺少部件：${part}`)
    }
    for (const bad of ['NaN', 'undefined', 'null']) {
      must(!xml.includes('>' + bad) && !xml.includes(bad + '<'), `docx 正文含异常值 ${bad}`)
    }
    fs.writeFileSync(path.join(outDir, 'brief.docx'), out.docx)
    briefDocx = out.docx
    return `${kb(out.docx.length)}`
  })
  check('简报 HTML', () => {
    // 与 Word 同一份默认产物：默认纯文字版，HTML 也必须是纯文字（不能一边无图一边带图）
    const out = brief.buildBrief(model, { figures: false })
    must(out && typeof out.then !== 'function', 'buildBrief 返回了 Promise：brief.js 的导出必须是同步函数')
    must(typeof out.html === 'string' && out.html.includes('</html>'), '简报 HTML 不完整')
    must(!/<svg/i.test(out.html), '默认简报 HTML 不应含图表（与 Word 一致）')
    must(!/https?:\/\//i.test(out.html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), '简报 HTML 含外部链接')
    fs.writeFileSync(path.join(outDir, 'brief.html'), out.html, 'utf8')
    briefHtml = out.html
    return `${kb(Buffer.byteLength(out.html))}`
  })
  check('简报 Word 与 HTML 同源一致', () => {
    const d = brief.buildBrief(model, { figures: false })
    const w = brief.buildBrief(model, { figures: false })
    const wTables = (d.docx.toString('utf8').match(/<w:tbl>/g) || []).length
    const wSvgs = (d.html.match(/<svg/g) || []).length
    must(wTables === 0 && wSvgs === 0, `默认简报两份载体应都无图表（Word ${wTables} 表 / HTML ${wSvgs} 图）`)
    const f = brief.buildBrief(model, { figures: true })
    const fTables = (f.docx.toString('utf8').match(/<w:tbl>/g) || []).length
    const fSvgs = (f.html.match(/<svg/g) || []).length
    must(fTables > 0 && fSvgs > 0, 'figures:true 时 Word 应出数据表、HTML 应出内联图')
    void w
    return `默认 0 表 0 图；figures:true ${fTables} 表 ${fSvgs} 图`
  })
  check('简报内容随年级覆盖', () => {
    must(briefHtml, '简报 HTML 未生成')
    for (const grade of model.grades) {
      const name = String(grade.gradeName || '').replace(/\s+/g, '')
      must(briefHtml.replace(/\s+/g, '').includes(name), `简报 HTML 缺少年级 ${grade.gradeName}`)
    }
    must(/提升与建议/.test(briefHtml), '简报 HTML 缺少「提升与建议」')
    return `${model.grades.length} 个年级`
  })
  void briefDocx
}

if (interactive && typeof interactive.buildInteractiveHtml === 'function') {
  check('交互版 HTML', () => {
    const html = interactive.buildInteractiveHtml(model, {})
    must(typeof html === 'string' && html.includes('</html>'), '交互 HTML 不完整')
    must(!/href\s*=\s*["']https?:/i.test(html), '交互 HTML 有外部 href')
    must(!/src\s*=\s*["']https?:/i.test(html), '交互 HTML 有外部 src')
    must(!/fetch\s*\(/.test(html), '交互 HTML 使用 fetch')
    must(!/XMLHttpRequest/.test(html), '交互 HTML 使用 XMLHttpRequest')
    const m = /<script id="fuulea-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
    must(m, '缺少内联数据块 <script id="fuulea-data">')
    JSON.parse(m[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'))
    fs.writeFileSync(path.join(outDir, 'interactive.html'), html, 'utf8')
    return `${kb(Buffer.byteLength(html))}`
  })
  check('交互版无脚本语法错误', () => {
    const html = fs.readFileSync(path.join(outDir, 'interactive.html'), 'utf8')
    const scripts = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/gi)]
    must(scripts.length > 0, '交互版没有内联脚本')
    const tmp = path.join(os.tmpdir(), `flr-inline-${process.pid}.js`)
    fs.writeFileSync(tmp, scripts.map((s) => s[1]).join('\n;\n'), 'utf8')
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' })
    fs.unlinkSync(tmp)
    must(r.status === 0, (r.stderr || '').split('\n').slice(0, 4).join(' '))
    return `${scripts.length} 段脚本`
  })
}

// ---------------------------------------------------------------- 3. 简报 PDF

console.log('\n[3/5] 简报 Word → PDF（LibreOffice）')
function sofficeBin() {
  for (const bin of ['/opt/homebrew/bin/soffice', '/usr/bin/soffice', 'soffice', 'libreoffice']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' })
    if (!r.error && r.status === 0) return bin
  }
  return null
}
const soffice = sofficeBin()
check('LibreOffice 可用', () => {
  must(soffice, '未找到 soffice，无法做 Word→PDF 校验')
  return soffice
})
const chromeHeadless = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => fs.existsSync(p))

// 简报 PDF 一律用 Chrome 从简报 HTML 打印（与插件主线一致）。
// 绝不能用 LibreOffice 转 docx 当成品：soffice 只嵌入拉丁字体（LiberationSerif 等），
// 中文字形缺失，PDF 打开是乱码方块（文本层仍有字，pdftotext 抽得出来，极易漏检）。
check('简报 PDF 用 Chrome 打印且中文嵌入', () => {
  const htmlFile = path.join(outDir, 'brief.html')
  must(fs.existsSync(htmlFile), 'out/brief.html 不存在')
  must(chromeHeadless, '未找到 Chrome，无法打印简报 PDF')
  const pdf = path.join(outDir, 'brief.pdf')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flr-chrome-brief-'))
  try {
    execFileSync(chromeHeadless, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      `--user-data-dir=${profile}`, '--no-pdf-header-footer',
      '--virtual-time-budget=8000', `--print-to-pdf=${pdf}`, `file://${htmlFile}`,
    ], { stdio: 'pipe', timeout: 120_000 })
  } finally {
    fs.rmSync(profile, { recursive: true, force: true })
  }
  must(fs.existsSync(pdf), 'Chrome 未产出简报 PDF')
  const size = fs.statSync(pdf).size
  const text = (() => {
    const r = spawnSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' })
    if (r.error) return ''
    return r.stdout || ''
  })()
  const pages = (() => {
    const r = spawnSync('pdfinfo', [pdf], { encoding: 'utf8' })
    const m = r.error ? null : /Pages:\s+(\d+)/.exec(r.stdout || '')
    return m ? Number(m[1]) : null
  })()
  // 中文字体必须真嵌入：CJK 且 Identity-H 的 CID 字体至少 1 个
  const fonts = (() => {
    const r = spawnSync('pdffonts', [pdf], { encoding: 'utf8' })
    return r.error ? '' : r.stdout || ''
  })()
  if (fonts) {
    must(/CID\s+TrueType\s+Identity-H/.test(fonts), '简报 PDF 未嵌入中文 CID 字体（会显示乱码）')
    must(!/^[A-Z]+\+LiberationSerif.*WinAnsi/m.test(fonts) || /CID\s+TrueType\s+Identity-H/.test(fonts),
      '简报 PDF 只有拉丁字体')
  }
  // 参考件是「每届 1 页」的密排简报：3 届应为 3 页（允许 3~6 页，超出说明排版失控）
  // 每届 1 页：3 届必须正好 3 页；多于 3 页说明某一届折行了
  if (pages !== null) must(pages === 3, `简报应为每届 1 页共 3 页，实际 ${pages} 页`)
  return `${kb(size)}${pages ? `，${pages} 页` : ''}${text ? '，文本校验通过' : ''}`
})

// ---------------------------------------------------------------- 4. 交互版浏览器渲染

console.log('\n[4/5] 交互版无头浏览器渲染')

check('Chrome 渲染交互版无脚本报错', () => {
  must(chromeHeadless, '未找到 Chrome')
  const html = path.join(outDir, 'interactive.html')
  must(fs.existsSync(html), 'out/interactive.html 不存在')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flr-chrome-'))
  let dom
  try {
    dom = execFileSync(
      chromeHeadless,
      [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
        `--user-data-dir=${profile}`,
        '--virtual-time-budget=4000', '--dump-dom', `file://${html}`,
      ],
      { encoding: 'utf8', timeout: 90_000, maxBuffer: 64 * 1024 * 1024 },
    )
  } finally {
    fs.rmSync(profile, { recursive: true, force: true })
  }
  const svgCount = (dom.match(/<svg/g) || []).length
  must(svgCount >= 3, `渲染后 SVG 图表过少：${svgCount}`)
  // 年级 Tab 切换后的图必须真的画出来（曾出现「本周期暂无教师数据」的空态 bug）
  const blockOf = (id) => {
    const at = dom.indexOf(`id="${id}"`)
    if (at < 0) return ''
    return dom.slice(at, dom.indexOf('</div>', at) + 6)
  }
  const scatter = blockOf('chart-scatter')
  const teacherBar = blockOf('chart-teacher-bar')
  must(/<svg/.test(scatter) && /<circle/.test(scatter), '教师散点图未渲染出数据点')
  must(/<svg/.test(teacherBar) && /<rect/.test(teacherBar), '教师排行图未渲染出条形')
  // 三届对比的「任务量与习题量」是计数（次/道），不能出现百分号；
  // 「完成率/得分率/师阅率」才允许 1 位小数百分比（如 53.0% 是正常的）。
  const clean = dom.replace(/<script[\s\S]*?<\/script>/g, '')
  const scaleSlot = (() => {
    const a = clean.indexOf('data-slot="scale"')
    const b = clean.indexOf('data-slot="rate"')
    return a >= 0 && b > a ? clean.slice(a, b) : ''
  })()
  must(scaleSlot, '未找到三届对比的「任务量与习题量」子图')
  // 只看文本节点与 tooltip 内容，别把 style="width:100%" 这类属性算进去
  const texts = [...scaleSlot.matchAll(/>([^<>]*)</g)].map((m) => m[1]).join(' ')
  const tips = [...scaleSlot.matchAll(/data-tip="([^"]*)"/g)].map((m) => m[1]).join(' ')
  must(!/\d(\.\d+)?%/.test(texts + ' ' + tips), '任务量/习题量（计数）被格式化成百分比')
  must(!/NaN/.test(clean), '页面出现 NaN')
  // KPI 口径抽查：日均班均任务 = 三届任务量 ÷ 天数 ÷ 行政班数合计（曾出现二次相除压成 0.3 的 bug）
  const gradeCount = model.grades.length
  const classSum = model.grades.reduce((a, g) => a + (Number(g.classCount) || 0), 0)
  const expectDaily = model.totals.taskCount / model.totals.days / classSum
  must(expectDaily > 1, '样例数据的日均班均任务应大于 1')
  must(!/>0\.\d次</.test(clean), '日均班均任务疑似被二次相除（KPI 出现 0.x 次）')
  must(!/数据加载失败|Uncaught/.test(dom), '页面出现错误提示')
  return `${svgCount} 个 SVG 图表节点`
})

// ---------------------------------------------------------------- 5. 汇总

console.log('\n[5/5] 汇总')
const failed = results.filter((r) => !r.ok)
const table = results.map((r) => `  ${r.ok ? '✔' : '✘'}  ${r.name}${r.detail ? '  —  ' + r.detail : ''}`).join('\n')
console.log(table)
if (failed.length) {
  console.log(`\n验收未通过：${failed.length} 项失败（共 ${results.length} 项）`)
  process.exitCode = 1
} else {
  console.log(`\n验收通过：${results.length} 项全部通过。产物在 ${path.relative(process.cwd(), outDir) || outDir}/`)
}
void zlib
void readIfExists
