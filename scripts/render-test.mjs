// 报告渲染层自测脚本：
//   读 sample-model.json（龙岩一中真实数据模型）→ 生成三版产物：
//     正式版 out/report.md + out/report.html + out/report.docx
//     简报版 out/brief.docx + out/brief.html
//     交互版 out/interactive.html
//
// 用法：node scripts/render-test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildReport } from '../lib/report.js'
import { buildBrief } from '../lib/brief.js'
import { buildInteractiveHtml } from '../lib/interactive.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outDir = path.join(root, 'out')

const modelFile = path.join(root, 'sample-model.json')
if (!fs.existsSync(modelFile)) {
  console.error('缺少 sample-model.json：仓库不随附真实学校数据。')
  console.error('请先运行：node scripts/test-data.mjs lyyz 2026-10-08 2026-10-21（需本机已有该校凭据）')
  process.exit(1)
}
const model = JSON.parse(fs.readFileSync(modelFile, 'utf8'))

const report = buildReport(model, { generatedAt: model.meta?.generatedAt })

if (typeof report.markdown !== 'string' || !report.markdown.trim()) {
  throw new Error('buildReport 未返回 Markdown 内容')
}
if (typeof report.html !== 'string' || !report.html.includes('</html>')) {
  throw new Error('buildReport 未返回完整 HTML 文档')
}

// 基本质量检查：百分比必须 1 位小数；HTML 单文件、无外部资源
const badPercents = report.markdown.match(/\d+\.\d{2,}%/g) || []
if (badPercents.length) throw new Error(`存在非 1 位小数的百分比：${badPercents.slice(0, 5).join(', ')}`)
const external = []
if (/<script\b/i.test(report.html)) external.push('<script>')
if (/<link\b/i.test(report.html)) external.push('<link>')
if (/<img\b/i.test(report.html)) external.push('<img>')
if (/url\(/i.test(report.html)) external.push('url()')
if (/https?:\/\/(?!www\.w3\.org\/2000\/svg)/i.test(report.html)) external.push('外部链接')
if (external.length) throw new Error(`HTML 包含外部资源或脚本：${external.join(', ')}`)

fs.mkdirSync(outDir, { recursive: true })
const mdFile = path.join(outDir, 'report.md')
const htmlFile = path.join(outDir, 'report.html')
fs.writeFileSync(mdFile, report.markdown, 'utf8')
fs.writeFileSync(htmlFile, report.html, 'utf8')

// Word：docx 是 ZIP 包，校验签名与关键部件齐全，避免产出「打不开的 .docx」
const docxFile = path.join(outDir, 'report.docx')
if (!Buffer.isBuffer(report.docx) || report.docx.length < 5000) {
  throw new Error('buildReport 未返回有效的 docx 二进制')
}
if (report.docx.readUInt32LE(0) !== 0x04034b50) {
  throw new Error('docx 缺少 ZIP 文件头')
}
fs.writeFileSync(docxFile, report.docx)
const docxText = report.docx.toString('utf8')
for (const part of ['word/document.xml', 'word/styles.xml', '[Content_Types].xml', '_rels/.rels']) {
  if (!docxText.includes(part)) throw new Error(`docx 缺少部件：${part}`)
}
// 正文段落与表格必须真实落到 document.xml 里
const docxXmlStart = docxText.indexOf('<w:document')
if (docxXmlStart < 0) throw new Error('docx 缺少 w:document 根元素')
const docxTables = (docxText.match(/<w:tbl>/g) || []).length
if (docxTables < 8) throw new Error(`docx 表格数量异常：${docxTables}`)

const kb = (n) => `${(n / 1024).toFixed(1)} KB`
const mdSize = fs.statSync(mdFile).size
const htmlSize = fs.statSync(htmlFile).size
const stats = report.stats
const missing = (report.markdown.match(/缺失/g) || []).length
const percentCount = (report.markdown.match(/\d+\.\d%/g) || []).length

console.log('报告渲染自测通过')
console.log(`  数据源：${path.relative(root, modelFile)}（${model.meta?.siteTitle || ''} ${model.meta?.from}~${model.meta?.to}）`)
console.log(`  Markdown：${path.relative(root, mdFile)}（${kb(mdSize)}）`)
console.log(`  HTML：${path.relative(root, htmlFile)}（${kb(htmlSize)}）`)
console.log(`  Word：${path.relative(root, docxFile)}（${kb(fs.statSync(docxFile).size)}，${docxTables} 张表）`)
console.log(
  `  规模：${stats.gradeCount} 个年级 / ${stats.chapterCount} 章 / ${stats.sectionCount} 小节 / ${stats.figureCount} 张图 / ${stats.tableCount} 张表`,
)
console.log(
  `  数据：任务 ${stats.taskCount} 次、习题 ${stats.questionCount} 道、自学 ${stats.selfPersonCount} 人次、观看 ${stats.watchCount} 人次`,
)
console.log(`  检查：${percentCount} 处 1 位小数百分比，${missing} 处「缺失」标注，HTML 无外部资源`)

// ---------------------------------------------------------------- 简报版

const brief = buildBrief(model, { figures: false })
if (!Buffer.isBuffer(brief.docx) || brief.docx.readUInt32LE(0) !== 0x04034b50) {
  throw new Error('简报 docx 不是合法 ZIP')
}
const briefXml = brief.docx.toString('utf8')
for (const part of ['word/document.xml', 'word/styles.xml', '[Content_Types].xml', '_rels/.rels']) {
  if (!briefXml.includes(part)) throw new Error(`简报 docx 缺少部件：${part}`)
}
if (/NaN|undefined/.test(briefXml)) throw new Error('简报 docx 正文含 NaN/undefined')
if (typeof brief.html !== 'string' || !brief.html.includes('</html>')) {
  throw new Error('简报 HTML 不完整')
}
for (const grade of model.grades) {
  if (!brief.html.replace(/\s+/g, '').includes(String(grade.gradeName).replace(/\s+/g, ''))) {
    throw new Error(`简报 HTML 缺少年级 ${grade.gradeName}`)
  }
}
if (!brief.html.includes('提升与建议')) throw new Error('简报 HTML 缺少「提升与建议」')
fs.writeFileSync(path.join(outDir, 'brief.docx'), brief.docx)
fs.writeFileSync(path.join(outDir, 'brief.html'), brief.html, 'utf8')
console.log(`  简报：out/brief.docx（${kb(fs.statSync(path.join(outDir, 'brief.docx')).size)}）+ out/brief.html（${kb(Buffer.byteLength(brief.html))}）`)
console.log(`  简报统计：${brief.stats.sectionCount} 个小节 / ${brief.stats.itemCount} 条 / ${brief.stats.gradeCount} 个年级`)

// ---------------------------------------------------------------- 交互版

const interactiveHtml = buildInteractiveHtml(model, {})
if (!interactiveHtml.includes('</html>')) throw new Error('交互版 HTML 不完整')
if (/href\s*=\s*["']https?:/i.test(interactiveHtml)) throw new Error('交互版 HTML 含外部 href')
if (/src\s*=\s*["']https?:/i.test(interactiveHtml)) throw new Error('交互版 HTML 含外部 src')
if (/fetch\s*\(/.test(interactiveHtml)) throw new Error('交互版 HTML 使用了 fetch')
if (/XMLHttpRequest/.test(interactiveHtml)) throw new Error('交互版 HTML 使用了 XMLHttpRequest')
const dataMatch = /<script id="fuulea-data" type="application\/json">([\s\S]*?)<\/script>/.exec(interactiveHtml)
if (!dataMatch) throw new Error('交互版 HTML 缺少内联数据块')
JSON.parse(dataMatch[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'))
fs.writeFileSync(path.join(outDir, 'interactive.html'), interactiveHtml, 'utf8')
console.log(`  交互版：out/interactive.html（${kb(Buffer.byteLength(interactiveHtml))}，数据已内联、无外部资源）`)
