// 报告渲染层：Word（.docx）导出。
//
// 与 report.js 的 buildDocument() 同源：HTML／PDF／Markdown／Word 四种载体
// 由同一份 doc 模型渲染，保证文字、标点、口径完全一致。
//
// 样式沿用《党政机关公文格式》（GB/T 9704—2012）与网页版同一套规范：
//   A4、天头 37mm、订口 28mm、版心 156mm×225mm；正文 12pt（小四）宋体、行高 1.5；
//   章标题黑体 16pt 居中另起页；节标题「（一）」楷体 14pt 顶格；三级标题黑体 12pt；
//   表格 10.5pt、全黑细线、表头浅灰底；图题在图下居中 10.5pt。
//
// 图表：Word 无法承载内联 SVG，故沿用 Markdown 版的降级策略——
// 「图题 + 一行说明 + 同源数据表」，保证信息等价、可核对。
//
// 本文件只依赖 node 内置能力与 docxjs/xlsx 级别的零依赖做法：直接写 OOXML，
// 不引入任何第三方 npm 包，与 charts.js、report.js 的约束一致。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------- 单位换算

/** 磅 → twip（1 pt = 20 twip），OOXML 的长度单位 */
const twip = (pt) => Math.round(pt * 20)
/** 毫米 → twip */
const mmTwip = (mm) => Math.round((mm * 1440) / 25.4)

// ---------------------------------------------------------------- 样式常量
// 与网页版同源：字体栈取 macOS / Windows 共有的中文字体名，Word 打开即用系统字体。

const FONT_SONG = '宋体'
const FONT_HEI = '黑体'
const FONT_KAI = '楷体'
const FONT_LATIN = 'Times New Roman'

const SIZE_BODY = 12 // 小四 12pt
const SIZE_SECTION = 14 // 四号 14pt
const SIZE_CHAPTER = 16 // 三号 16pt
const SIZE_TABLE = 10.5 // 五号 10.5pt
const SIZE_NOTE = 9 // 小五 9pt
const SIZE_COVER_SCHOOL = 22 // 二号 22pt
const SIZE_COVER_TITLE = 26 // 一号 26pt

const LINE_BODY = 360 // 行距 1.5 倍（240 × 1.5）
const LINE_TABLE = 300 // 表格行距 1.25 倍
const LINE_LIST = 320 // 列表行距 1.33 倍（略松于表格、紧于正文）

// A4 + 公文版心
const PAGE_W = mmTwip(210)
const PAGE_H = mmTwip(297)
const MARGIN_TOP = mmTwip(37)
const MARGIN_BOTTOM = mmTwip(35)
const MARGIN_LEFT = mmTwip(28)
const MARGIN_RIGHT = mmTwip(26)
const CONTENT_W = PAGE_W - MARGIN_LEFT - MARGIN_RIGHT // 156mm

// ---------------------------------------------------------------- XML 转义

const esc = (text) =>
  String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 去掉 XML 不允许的控制字符（Word 会因此拒绝打开） */
const sanitize = (text) =>
  String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

// ---------------------------------------------------------------- 段落构造

/**
 * 生成一个 w:p。
 * @param {object} o
 * @param {string} o.text        文本（可含 w:br 之外的纯文字）
 * @param {number} o.size        字号（pt）
 * @param {string} o.font        中文字体（同时作用于 eastAsia 与西文）
 * @param {boolean} o.bold
 * @param {'left'|'center'|'right'|'both'} o.align
 * @param {number} o.indentFirst 首行缩进（pt）
 * @param {number} o.indentLeft  左缩进（pt）
 * @param {number} o.indentHang  悬挂缩进（pt，配合左缩进实现序号悬挂）
 * @param {number} o.before      段前（pt）
 * @param {number} o.after       段后（pt）
 * @param {number} o.line        行距（twip，lineRule=auto 时为 240 的倍数）
 * @param {number} o.letterSpacing 字间空白（pt，用于封面报告名的字距）
 */
function para(o) {
  const {
    text = '',
    size = SIZE_BODY,
    font = FONT_SONG,
    latin = FONT_LATIN,
    bold = false,
    align = 'both',
    indentFirst = 0,
    indentLeft = 0,
    indentHang = 0,
    before = 0,
    after = 0,
    line = LINE_BODY,
    letterSpacing = 0,
    keepNext = false,
  } = o || {}

  const pPr = []
  // 段前段后与行距
  const spacing = [`w:line="${Math.round(line)}"`, 'w:lineRule="auto"']
  if (before) spacing.push(`w:before="${twip(before)}"`)
  if (after) spacing.push(`w:after="${twip(after)}"`)
  pPr.push(`<w:spacing ${spacing.join(' ')}/>`)

  // 缩进
  const ind = []
  if (indentLeft) ind.push(`w:left="${twip(indentLeft)}"`)
  if (indentFirst) ind.push(`w:firstLine="${twip(indentFirst)}"`)
  if (indentHang) ind.push(`w:hanging="${twip(indentHang)}"`)
  if (ind.length) pPr.push(`<w:ind ${ind.join(' ')}/>`)

  // 对齐
  pPr.push(`<w:jc w:val="${align}"/>`)

  // 与下段同页：标题不要落在页脚
  if (keepNext) pPr.push('<w:keepNext/>')
  // 避头尾（中文排版）
  pPr.push('<w:kinsoku/>', '<w:overflowPunct/>', '<w:autoSpaceDE/>', '<w:autoSpaceDN/>')

  const rPr = []
  const rFonts = [`w:ascii="${latin}"`, `w:hAnsi="${latin}"`, `w:eastAsia="${font}"`, `w:cs="${latin}"`]
  rPr.push(`<w:rFonts ${rFonts.join(' ')}/>`)
  if (bold) rPr.push('<w:b/>', '<w:bCs/>')
  if (letterSpacing) rPr.push(`<w:spacing w:val="${twip(letterSpacing)}"/>`)
  // 中文按字符单位计算字号：w:sz 为半磅
  rPr.push(`<w:sz w:val="${Math.round(size * 2)}"/>`, `<w:szCs w:val="${Math.round(size * 2)}"/>`)
  // 禁止两端对齐把中文拉散（与网页版同一条排印约束）
  rPr.push('<w:noProof/>')

  const run = `<w:r><w:rPr>${rPr.join('')}</w:rPr><w:t xml:space="preserve">${esc(
    sanitize(text),
  )}</w:t></w:r>`

  return `<w:p><w:pPr>${pPr.join('')}</w:pPr>${run}</w:p>`
}

/** 分页符 */
const pageBreak = () =>
  '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>' +
  '<w:r><w:br w:type="page"/></w:r></w:p>'

// ---------------------------------------------------------------- 表格

/**
 * 生成 w:tbl。cells 为二维数组；aligns 决定每列对齐；widths 为相对权重。
 * 表头浅灰底、全黑 0.5pt 细线；合计行加粗上框线。
 */
function table(block) {
  const { head = [], rows = [], aligns = [], widths = [], totalRow = false } = block || {}
  const cols = head.length || (rows[0] ? rows[0].length : 0)
  if (!cols) return ''

  // 列宽：按相对权重分配到版心宽度
  const weights = widths.length === cols ? widths : Array(cols).fill(1)
  const sum = weights.reduce((a, b) => a + (Number(b) || 0), 0) || 1
  const colTw = weights.map((w) => Math.round((CONTENT_W * (Number(w) || 0)) / sum))

  const border = (side, sz = 4) =>
    `<w:${side} w:val="single" w:sz="${sz}" w:space="0" w:color="000000"/>`
  const tblBorders =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => border(s)).join('') +
    '</w:tblBorders>'

  const cell = (text, colIndex, isHead, isTotal) => {
    const align = isHead ? 'center' : aligns[colIndex] === 'r' ? 'right' : 'center'
    const font = isHead ? FONT_HEI : FONT_SONG
    // 合计行：整行加粗，并且顶边用 1pt 粗线
    const borders = isTotal
      ? `<w:tcBorders>${border('top', 12)}</w:tcBorders>`
      : ''
    const shade = isHead ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''
    const p = para({
      text,
      size: SIZE_TABLE,
      font,
      bold: isHead || isTotal,
      align,
      line: LINE_TABLE,
    })
    return (
      `<w:tc><w:tcPr><w:tcW w:w="${colTw[colIndex]}" w:type="dxa"/>${shade}${borders}` +
      '<w:vAlign w:val="center"/>' +
      // 单格内边距，避免九列表格挤成一团
      `<w:tcMar><w:left w:w="57" w:type="dxa"/><w:right w:w="57" w:type="dxa"/></w:tcMar>` +
      `</w:tcPr>${p}</w:tc>`
    )
  }

  const grid = colTw.map((w) => `<w:gridCol w:w="${w}"/>`).join('')

  const headRow = head.length
    ? '<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>' +
      head.map((text, i) => cell(text, i, true, false)).join('') +
      '</w:tr>'
    : ''

  const bodyRows = rows
    .map((row, ri) => {
      const isTotal = totalRow && ri === rows.length - 1
      return (
        '<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
        row.map((text, i) => cell(text, i, false, isTotal)).join('') +
        '</w:tr>'
      )
    })
    .join('')

  return (
    '<w:tbl><w:tblPr>' +
    `<w:tblW w:w="${CONTENT_W}" w:type="dxa"/>` +
    '<w:jc w:val="center"/>' +
    tblBorders +
    '<w:tblLayout w:type="fixed"/>' +
    '</w:tblPr>' +
    `<w:tblGrid>${grid}</w:tblGrid>${headRow}${bodyRows}</w:tbl>`
  )
}

// ---------------------------------------------------------------- 标题编号

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']

// ---------------------------------------------------------------- 主渲染

/**
 * 由 doc 模型（report.js 的 buildDocument 结果）生成 Word 文档。
 * @returns {Buffer}
 */
export function buildDocxBuffer(doc) {
  const parts = []

  // ---- 封面 ----
  const { cover } = doc
  parts.push(
    para({
      text: cover.school,
      size: SIZE_COVER_SCHOOL,
      font: FONT_HEI,
      align: 'center',
      before: 90, // 版心下移约 3cm，与网页版封面重心一致
      line: 360,
    }),
  )
  parts.push(
    para({ text: cover.period, size: SIZE_SECTION, align: 'center', before: 18, line: 400 }),
  )
  parts.push(para({ text: '', size: SIZE_BODY, align: 'center', before: 0 }))
  parts.push(
    para({
      text: cover.title,
      size: SIZE_COVER_TITLE,
      font: FONT_HEI,
      align: 'center',
      before: 150,
      line: 360,
      letterSpacing: 5, // 字距 0.2em
    }),
  )
  parts.push(
    para({
      text: cover.gradeList,
      size: SIZE_SECTION,
      font: FONT_KAI,
      align: 'center',
      before: 30,
      line: 400,
    }),
  )
  // 封面页脚：数据来源与生成时间，贴在版面底部。
  // Word 没有 CSS 的绝对定位，用一段固定段前留白把两行推到版心下沿附近
  // （按版心 225mm、封面其余元素约占 150mm 反推，约为 380pt）。
  parts.push(
    para({ text: cover.footLines?.[0] || '', size: SIZE_NOTE, align: 'left', line: 300, before: 150 }),
  )
  if (cover.footLines && cover.footLines.length > 1) {
    parts.push(para({ text: cover.footLines[1], size: SIZE_NOTE, align: 'left', line: 300 }))
  }
  parts.push(pageBreak())

  // ---- 目录 ----
  if (Array.isArray(doc.contents) && doc.contents.length) {
    parts.push(
      para({
        text: '目录',
        size: SIZE_CHAPTER,
        font: FONT_HEI,
        align: 'center',
        after: 18,
        line: 360,
      }),
    )
    for (const line of doc.contents) {
      parts.push(
        para({ text: line, size: SIZE_BODY, align: 'left', line: 400, after: 6 }),
      )
    }
    parts.push(pageBreak())
  }

  // ---- 正文各章 ----
  doc.chapters.forEach((chapter, chapterIndex) => {
    const isFirst = chapterIndex === 0
    if (!isFirst || (doc.contents && doc.contents.length)) {
      // 目录已分页，第一章直接续排；其余章节另起一页
      if (!isFirst) parts.push(pageBreak())
    }

    // 章标题：附录不编章序
    const title = chapter.appendix ? chapter.title : `${CN_NUM[chapterIndex] || chapterIndex + 1}、${chapterTitleOf(chapter, chapterIndex)}`
    parts.push(
      para({
        text: title,
        size: SIZE_CHAPTER,
        font: FONT_HEI,
        align: 'center',
        before: 12,
        after: 14,
        line: 360,
        keepNext: true,
      }),
    )

    for (const block of chapter.blocks) {
      parts.push(...renderBlock(block))
    }
  })

  const body = parts.join('')
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body}` +
    '<w:sectPr>' +
    `<w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/>` +
    `<w:pgMar w:top="${MARGIN_TOP}" w:right="${MARGIN_RIGHT}" w:bottom="${MARGIN_BOTTOM}" ` +
    `w:left="${MARGIN_LEFT}" w:header="0" w:footer="0" w:gutter="0"/>` +
    `<w:cols w:space="425"/>` +
    '</w:sectPr></w:body></w:document>'

  return xml
}

/** 章标题：doc 里带的是「一、xxx」或「附录　xxx」，这里只取章名部分 */
function chapterTitleOf(chapter, index) {
  const raw = String(chapter.title || '')
  // 已带「一、」前缀的去掉，由调用处按序号重编（保证序号与顺序一致）
  const m = raw.match(/^[一二三四五六七八九十]+、(.+)$/)
  return m ? m[1] : raw
}

function renderBlock(block) {
  if (!block || !block.t) return []
  switch (block.t) {
    case 'h2':
      // 节标题：（一）整体情况 —— 楷体 14pt，顶格
      return [
        para({
          text: block.text,
          size: SIZE_SECTION,
          font: FONT_KAI,
          align: 'left',
          before: 14,
          after: 6,
          line: LINE_BODY,
          keepNext: true,
        }),
      ]
    case 'h3':
      // 三级标题：1. 基础教学 —— 黑体 12pt，顶格
      return [
        para({
          text: block.text,
          size: SIZE_BODY,
          font: FONT_HEI,
          align: 'left',
          before: 10,
          after: 4,
          line: LINE_BODY,
          keepNext: true,
        }),
      ]
    case 'h4':
      return [
        para({
          text: block.text,
          size: SIZE_BODY,
          align: 'left',
          before: 6,
          after: 2,
          line: LINE_BODY,
          keepNext: true,
        }),
      ]
    case 'p':
      // 正文：首行缩进两字（2 × 12pt = 24pt），两端对齐
      return [para({ text: block.text, indentFirst: 24, after: 3, line: LINE_BODY })]
    case 'note':
      return [para({ text: block.text, size: SIZE_TABLE, indentFirst: 0, after: 4 })]
    case 'small':
      // 表注：表下 9pt，顶格
      return [para({ text: block.text, size: SIZE_NOTE, align: 'left', before: 2, after: 8, line: 300 })]
    case 'ol':
      // 条目之间不额外留空行：段后 0，靠行距形成节奏（与 PDF 版一致）
      return (block.items || []).map((item, i) => {
        const no = block.ordered === 'cn' ? `（${CN_NUM[i] || i + 1}）` : `${i + 1}.`
        return para({
          text: `${no}${item}`,
          indentLeft: 48,
          indentHang: 24,
          after: 0,
          line: LINE_LIST,
        })
      })
    case 'ul':
      return (block.items || []).map((item) =>
        para({ text: `·${item}`, indentLeft: 48, indentHang: 24, after: 0, line: LINE_LIST }),
      )
    case 'notelist':
      return (block.items || []).map((item, i) =>
        para({
          text: `（${CN_NUM[i] || i + 1}）${item}`,
          indentLeft: 48,
          indentHang: 24,
          after: 2,
          line: LINE_LIST,
        }),
      )
    case 'table': {
      const out = [table(block)]
      return out
    }
    case 'fig': {
      // Word 无法承载 SVG：图题 + 说明 + 同源数据表
      const out = [
        para({
          // 图序与图题之间用半角空格：全角空格会让 Word 把它当作可断行点，PDF 提取时切成两段
          text: `图 ${block.n} ${block.caption}`,
          size: SIZE_TABLE,
          align: 'center',
          before: 6,
          after: 2,
          line: LINE_TABLE,
          keepNext: true,
        }),
      ]
      if (block.data) {
        out.push(
          para({
            text: '（图表见 HTML／PDF 版；数据见下表。）',
            size: SIZE_NOTE,
            align: 'center',
            after: 2,
            line: 280,
          }),
        )
        out.push(table(block.data))
      }
      out.push(para({ text: '', size: 6, after: 0, line: 240 }))
      return out
    }
    default:
      return []
  }
}

// ---------------------------------------------------------------- OOXML 打包

/** 最小化的 content types */
const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  '</Types>'

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '</Relationships>'

const DOC_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>'

/** 默认样式：正文宋体小四、中文断行规则；不定义 Word 内置标题样式（标题直接用直接格式） */
const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  `<w:rFonts w:ascii="${FONT_LATIN}" w:hAnsi="${FONT_LATIN}" w:eastAsia="${FONT_SONG}" w:cs="${FONT_LATIN}"/>` +
  `<w:sz w:val="${SIZE_BODY * 2}"/><w:szCs w:val="${SIZE_BODY * 2}"/>` +
  '<w:lang w:val="en-US" w:eastAsia="zh-CN"/>' +
  '</w:rPr></w:rPrDefault>' +
  `<w:pPrDefault><w:pPr><w:spacing w:line="${LINE_BODY}" w:lineRule="auto"/>` +
  '<w:jc w:val="both"/></w:pPr></w:pPrDefault>' +
  '</w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
  '<w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '</w:styles>'

function coreXml(doc) {
  const title = `${doc.cover.school}辅立码课系统教学数据报告`
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(title)}</dc:title>` +
    `<dc:subject>${esc(doc.cover.period)}</dc:subject>` +
    '<dc:creator>辅立码课数据报告</dc:creator>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    '</cp:coreProperties>'
  )
}

const APP_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
  'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  '<Application>辅立码课数据报告</Application></Properties>'

// ---------------------------------------------------------------- ZIP 写入（无依赖）
// docx 本质是 ZIP。这里只写 stored（不压缩）条目：实现简单、体积可接受，
// 且避免引入任何第三方压缩库。Word / WPS / Pages 均可正常打开。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function zipStore(entries) {
  // entries: [{ name, data: Buffer }]
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date（1980-01-01）
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBuf, data)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(0, 10)
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0x21, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt16LE(0, 30) // extra
    cen.writeUInt16LE(0, 32) // comment
    cen.writeUInt16LE(0, 34) // disk
    cen.writeUInt16LE(0, 36) // internal attrs
    cen.writeUInt32LE(0, 38) // external attrs
    cen.writeUInt32LE(offset, 42)
    central.push({ cen, nameBuf })

    offset += local.length + nameBuf.length + data.length
  }

  const centralStart = offset
  for (const { cen, nameBuf } of central) {
    chunks.push(cen, nameBuf)
    offset += cen.length + nameBuf.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(offset - centralStart, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)
  chunks.push(end)

  return Buffer.concat(chunks)
}

/** 由 doc 模型直接产出 .docx 二进制 */
export function buildDocx(doc) {
  const documentXml = buildDocxBuffer(doc)
  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOC_RELS, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(coreXml(doc), 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from(APP_XML, 'utf8') },
  ])
}

/** 便捷入口：给定 report.js 的 buildDocument 结果，写到指定路径 */
export function writeDocx(doc, filePath) {
  const buf = buildDocx(doc)
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, buf)
  return filePath
}

// =======================================================================
// 简报版（1~2 页速览）
//
// 版式对照《高二/高三使用情况简报》的成品 docx（XML 实测）：
//   A4（11906×16838 twip）；页边距上下 1440、左右 1800 twip（25.4mm / 31.75mm）；
//   正文 10.5pt（w:sz=21）宋体 + Times New Roman；标题加粗居中 10.5pt；
//   小节标题（学科方面：/教师层面：/提升与建议：）14pt（w:sz=28）宋体、不加粗、顶格；
//   条目「•」+ 正文，段落左对齐（不两端对齐）、首行缩进两字符（420 twip = 21pt）；
//   下级正文条目无符号、缩进一级。
//
// 与正式版互不影响：下面所有函数与常量都取自本文件已有的 para/table/zipStore 等私有工具，
// buildDocx / buildDocxBuffer / writeDocx 的行为与输出保持不变。
// =======================================================================

const BRIEF = {
  sizeBody: 10.5, // 五号
  sizeSection: 14, // 四号（w:sz=28）
  sizeCaption: 9, // 小五（图题）
  marginTop: 1440, // twip
  marginBottom: 1440,
  marginLeft: 1800,
  marginRight: 1800,
  indentFirst: 21, // 两字符（10.5pt × 2）
  indentLevel: 21, // 每个条目级别的左缩进
  line: 240, // 行距 1.0（简报是 1~2 页速览，用单倍行距换取一页容纳）
  bullet: '•',
}

const mm=(v)=>Math.round((v*1440)/25.4)


/** 简报正文里禁止出现的占位：数据缺失时该条应已省略，这里只做最后一道防线 */
const BRIEF_BAD_WORDS = /NaN|undefined|null|缺失/

/** 简报单页的页面设置（A4 + 上下 1440 / 左右 1800） */
function briefSectPr() {
  const pw = 11906
  const ph = 16838
  return (
    '<w:sectPr>' +
    `<w:pgSz w:w="${pw}" w:h="${ph}"/>` +
    `<w:pgMar w:top="${BRIEF.marginTop || mm(25.4)}" w:right="${BRIEF.marginRight}" ` +
    `w:bottom="${BRIEF.marginBottom || mm(25.4)}" w:left="${BRIEF.marginLeft || mm(31.75)}" ` +
    'w:header="851" w:footer="992" w:gutter="0"/>' +
    '<w:cols w:space="425" w:num="1"/>' +
    '<w:docGrid w:type="lines" w:linePitch="312" w:charSpace="0"/>' +
    '</w:sectPr>'
  )
}

/** 简报版样式：默认正文 10.5pt 宋体 + Times New Roman，左对齐 */
const BRIEF_STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  `<w:rFonts w:ascii="${FONT_LATIN}" w:hAnsi="${FONT_LATIN}" w:eastAsia="${FONT_SONG}" w:cs="${FONT_LATIN}"/>` +
  `<w:sz w:val="${Math.round(BRIEF.sizeBody * 2)}"/><w:szCs w:val="${Math.round(BRIEF.sizeBody * 2)}"/>` +
  '<w:lang w:val="en-US" w:eastAsia="zh-CN"/>' +
  '</w:rPr></w:rPrDefault>' +
  `<w:pPrDefault><w:pPr><w:spacing w:line="${BRIEF.line}" w:lineRule="auto"/>` +
  '<w:jc w:val="left"/></w:pPr></w:pPrDefault>' +
  '</w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
  '<w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '</w:styles>'

/** 简报标题：加粗、居中、10.5pt */
function briefTitlePara(title) {
  return para({
    text: title,
    size: BRIEF.sizeBody,
    font: FONT_SONG,
    bold: true,
    align: 'center',
    line: BRIEF.line,
    after: 2,
    keepNext: true,
  })
}

/** 小节标题：14pt 宋体、不加粗、顶格 */
function briefSectionPara(name) {
  // 参考简报的小节标题是「四号 + 单倍行距」，段前后各留 3pt 形成层次
  return para({
    text: name,
    size: BRIEF.sizeSection,
    font: FONT_SONG,
    bold: false,
    align: 'left',
    before: 3,
    after: 3,
    line: 240,
    keepNext: true,
  })
}

/** 总述段：首行缩进两字符、左对齐 */
function briefIntroPara(line) {
  return para({
    text: line,
    size: BRIEF.sizeBody,
    font: FONT_SONG,
    align: 'left',
    indentFirst: BRIEF.indentFirst,
    line: BRIEF.line,
  })
}

/**
 * 条目段。
 * - type=bullet：一级「• 文本」（左缩进 21pt，悬挂 21pt，符号与正文对齐整齐）；
 *   二级「•」+ 缩进两级。
 * - type=text：无符号，缩进一级（level=1 时两级），首行再缩进两字符。
 */
function briefItemPara(item) {
  const level = Math.max(0, Math.min(2, Number(item?.level) || 0))
  const body = String(item?.text ?? '')
  if (!body) return ''
  if (item.type === 'bullet') {
    return para({
      text: `${BRIEF.bullet}${body}`,
      size: BRIEF.sizeBody,
      font: FONT_SONG,
      align: 'left',
      indentLeft: BRIEF.indentLevel * (level + 1),
      indentHang: BRIEF.indentLevel,
      line: BRIEF.line,
    })
  }
  return para({
    text: body,
    size: BRIEF.sizeBody,
    font: FONT_SONG,
    align: 'left',
    indentLeft: BRIEF.indentLevel * Math.max(1, level),
    indentFirst: BRIEF.indentFirst,
    line: BRIEF.line,
  })
}

/** 图题：图下 9pt 居中 */
function briefCaptionPara(caption, before = 4) {
  return para({
    text: caption,
    size: BRIEF.sizeCaption,
    font: FONT_SONG,
    align: 'center',
    before,
    after: 2,
    line: 264,
  })
}

/**
 * 简报图表：Word 无法承载内联 SVG，按与正式版一致的降级策略输出
 * 「图题 + 同源数据表」——数据表用的就是图里那组数字，Word 读者能看到数值，信息等价可核对。
 * 位图入口保留：fig.png 为 PNG Buffer 且 opts.embedPng 为真时，图题下不再提示「见网页版」。
 */
function briefFigureParts(fig, opts) {
  if (!fig || typeof fig !== 'object') return []
  const out = []
  const hasPng = Buffer.isBuffer(fig.png) && !!opts && opts.embedPng === true
  const hasTable = fig.data && Array.isArray(fig.data.head) && fig.data.head.length && Array.isArray(fig.data.rows)
  if (fig.caption) {
    out.push(briefCaptionPara(hasPng ? fig.caption : `${fig.caption}（数据见下表）`, 6))
  }
  if (hasTable) out.push(table(fig.data))
  return out
}

/** 单届简报的正文段落序列（不含页面设置） */
function briefBodyParas(doc, opts) {
  const parts = []
  if (!doc || typeof doc !== 'object') return parts
  parts.push(briefTitlePara(doc.title || '使用简报'))
  for (const line of doc.intro || []) {
    if (line) parts.push(briefIntroPara(line))
  }
  for (const section of doc.sections || []) {
    if (!section || !Array.isArray(section.items) || !section.items.length) continue
    parts.push(briefSectionPara(section.name || ''))
    for (const item of section.items) {
      const p = briefItemPara(item)
      if (p) parts.push(p)
    }
  }
  if (briefFiguresOn(opts)) {
    for (const fig of doc.figures || []) parts.push(...briefFigureParts(fig, opts))
  }
  return parts
}

/**
 * 简报 Word 是否出「图题 + 数据表」：
 * - 未指定 opts.figures → false（与参考简报版式完全一致，只有正文）；
 * - true 或 {teacher,subject} → 出；对象里某一项显式为 false 则不出该项。
 */
function briefFiguresOn(opts) {
  const raw = opts && opts.figures
  if (raw && typeof raw === 'object') return raw.teacher !== false || raw.subject !== false
  return raw === true
}

/**
 * 简报版 .docx。
 * @param {object|object[]} briefDoc 单届 briefDoc（brief.js 的 buildBriefDocument 结果），
 *                                   或多年级容器 { multi:true, docs:[...] }、briefDoc 数组
 * @param {object} opts { figures?: boolean|{teacher,subject}, embedPng?: boolean }
 * @returns {Buffer}
 */
export function buildBriefDocx(briefDoc, opts = {}) {
  const docs = Array.isArray(briefDoc)
    ? briefDoc
    : briefDoc && Array.isArray(briefDoc.docs)
      ? briefDoc.docs
      : briefDoc && typeof briefDoc === 'object'
        ? [briefDoc]
        : []
  if (!docs.length) throw new Error('简报数据为空：无法生成 Word')

  const parts = []
  docs.forEach((doc, index) => {
    if (index > 0) parts.push(pageBreak())
    parts.push(...briefBodyParas(doc, opts))
  })

  // 多年级：每届一节（分节符），各自 A4 与页边距一致；单届只需一个 sectPr
  const body = parts.join('')
  const sectPr = briefSectPr()
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body}${sectPr}</w:body></w:document>`

  const first = docs[0] || {}
  const title = docs.length > 1 ? `${first.gradeName || ''}等使用简报` : String(first.title || '使用简报')
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const core =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(title)}</dc:title>` +
    '<dc:creator>辅立码课数据报告</dc:creator>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    '</cp:coreProperties>'

  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from(BRIEF_CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(xml, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOC_RELS, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(BRIEF_STYLES, 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(core, 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from(APP_XML, 'utf8') },
  ])
}

/** 简报版 content types：只列实际写入的部件 */
const BRIEF_CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  '</Types>'

export default { buildDocx, writeDocx, buildDocxBuffer, buildBriefDocx }
