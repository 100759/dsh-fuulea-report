// 极简 XLSX 读取器（零依赖）：只依赖 Node 内置 zlib，读取单元格「值」。
// 智慧教学云的 /v2/dashboard/export/ 返回标准 xlsx（sharedStrings + 内联字符串 + 数字），
// 这里只解析报表所需的最小集合：sharedStrings.xml、workbook.xml、sheet XML。
import zlib from 'node:zlib'

function readCentralDirectory(buf) {
  let eocd = -1
  const stop = Math.max(0, buf.length - 65558)
  for (let i = buf.length - 22; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx：找不到 ZIP 目录结尾')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('xlsx ZIP 目录损坏')
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    entries.push({ name, method, csize, localOff })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function extractEntry(buf, entry) {
  const lo = entry.localOff
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('xlsx 本地文件头损坏: ' + entry.name)
  const nameLen = buf.readUInt16LE(lo + 26)
  const extraLen = buf.readUInt16LE(lo + 28)
  const start = lo + 30 + nameLen + extraLen
  const data = buf.subarray(start, start + entry.csize)
  if (entry.method === 0) return data
  if (entry.method === 8) return zlib.inflateRawSync(data)
  throw new Error('不支持的 xlsx 压缩方式: ' + entry.method)
}

function decodeXmlText(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function parseTextNodes(xml) {
  let out = ''
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
  let m
  while ((m = re.exec(xml))) out += decodeXmlText(m[1])
  return out
}

function parseSharedStrings(xml) {
  const out = []
  const re = /<si>([\s\S]*?)<\/si>/g
  let m
  while ((m = re.exec(xml))) out.push(parseTextNodes(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')))
  return out
}

function colToIndex(ref) {
  const m = /^([A-Z]+)/.exec(String(ref || ''))
  if (!m) return -1
  let n = 0
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function parseSheet(xml, shared) {
  const rows = []
  const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g
  let rm
  while ((rm = rowRe.exec(xml))) {
    const rowIdx = Number(rm[1]) - 1
    const body = rm[2]
    const cells = []
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cm
    while ((cm = cellRe.exec(body))) {
      const attrs = cm[1]
      const inner = cm[2] || ''
      const refm = /\br="([A-Z]+\d+)"/.exec(attrs)
      const ci = refm ? colToIndex(refm[1]) : cells.length
      const tm = /\bt="([^"]+)"/.exec(attrs)
      const type = tm ? tm[1] : 'n'
      let val = null
      if (type === 's') {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner)
        if (vm) val = shared[Number(vm[1])] ?? null
      } else if (type === 'inlineStr') {
        const im = /<is>([\s\S]*?)<\/is>/.exec(inner)
        if (im) val = parseTextNodes(im[1])
      } else if (type === 'str') {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner)
        val = vm ? decodeXmlText(vm[1]) : null
      } else if (type === 'b') {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner)
        val = vm ? Number(vm[1]) === 1 : null
      } else {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner)
        val = vm ? Number(vm[1]) : null
      }
      cells[ci] = val
    }
    rows[rowIdx] = cells
  }
  for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = []
  return rows
}

/** 读取工作簿：返回 { sheets: [{ name, rows }] }，rows 为按行索引的单元格值数组。 */
export function readWorkbook(buf) {
  const entries = readCentralDirectory(buf)
  const byName = new Map(entries.map((e) => [e.name, e]))
  const wbEntry = byName.get('xl/workbook.xml')
  const relEntry = byName.get('xl/_rels/workbook.xml.rels')
  if (!wbEntry || !relEntry) throw new Error('不是有效的 xlsx 工作簿')
  const wbXml = extractEntry(buf, wbEntry).toString('utf8')
  const relXml = extractEntry(buf, relEntry).toString('utf8')
  const rels = new Map()
  {
    const re = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g
    let m
    while ((m = re.exec(relXml))) rels.set(m[1], m[2])
  }
  const shared = []
  const ssEntry = byName.get('xl/sharedStrings.xml')
  if (ssEntry) shared.push(...parseSharedStrings(extractEntry(buf, ssEntry).toString('utf8')))
  const sheets = []
  {
    const re = /<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"[^>]*\/>/g
    let m
    while ((m = re.exec(wbXml))) {
      const name = decodeXmlText(m[1])
      let target = rels.get(m[2]) || ''
      if (!target) continue
      target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '')
      const entry = byName.get(target)
      if (!entry) continue
      sheets.push({ name, rows: parseSheet(extractEntry(buf, entry).toString('utf8'), shared) })
    }
  }
  return { sheets }
}

/**
 * 把「第 3 行是表头、第 4 行起是数据」的工作表转换为对象数组。
 * 智慧教学云导出的三张表（学科/教师/班级）都是这个结构：第 1 行标题、第 2 行分组表头。
 */
export function sheetToRecords(rows, headerRowIndex = 2) {
  const header = (rows[headerRowIndex] || []).map((h) => (h == null ? '' : String(h).trim()))
  const out = []
  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i]
    if (!row || row.every((c) => c == null || c === '')) continue
    const rec = {}
    header.forEach((key, ci) => {
      if (!key) return
      const v = row[ci]
      rec[key] = v === undefined ? null : v
    })
    if (Object.keys(rec).length === 0) continue
    out.push(rec)
  }
  return out
}

export default { readWorkbook, sheetToRecords }
