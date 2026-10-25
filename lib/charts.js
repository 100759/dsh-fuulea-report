// 零依赖内联 SVG 图表（纯字符串输出，不依赖浏览器、不引用外部资源）。
//
// 供 lib/report.js 生成报告插图：
//   - subjectOverviewSvg(grade)：各学科「生均题量（柱）」+「完成率 / 师阅率（折线）」+ 两条均值参考线
//   - teacherOverviewSvg(grade)：任务量前 12 位教师「完成率 / 师阅率」横向分组条形图 + 80% / 95% 达标线
//   - gradeCompareSvg(grades)：跨年级「完成率 / 得分率 / 师阅率均值」分组柱
//   - barComboSvg(options)：通用「分组柱 + 折线」图，上面两个函数复用
//
// 版式定位：正式文件（黑白印刷、宋体正文）用的学术/公文图表，不是网页仪表盘。
//   - 全部文字 Songti SC / SimSun / STSong / serif，与正文一致；字号 标题 13 / 正文与数值 10.5 / 刻度 9.5
//   - 无彩色：柱/条用灰度阶（#1a1a1a 实心 / #8c8c8c 反斜线 / #d9d9d9 双向斜线，第四系列 #4d4d4d 点阵），
//     折线用线型（实线 / 虚线 / 点线）+ 不同标记（实心圆 / 空心圆 / 方块 / 三角）；
//     纹理只作辅助（黑白激光打印会淡化纹理），黑白打印主靠「灰阶深浅 + 线型 + 标记」区分系列
//   - 坐标轴黑色 0.8px，网格 #e8e8e8 细实线；无圆角柱、无彩色图例块、无隔行彩色底纹
//   - 数值标签黑色、无描边（不用 paint-order/stroke 光晕，避免 PDF 嵌入 Type 3 字体）；
//     压在纹理/网格线/参考线上时垫白色底块；布局走「全局候选位置 + 碰撞检测 + 压线微调 + 兜底」
//
// 约束：整份 SVG 不得出现 `url(` 字样（render-test 的正则 /url\(/i 会把它判成外部资源）。
// 因此柱面条纹不用 <pattern> + fill="url(#id)"，而是在按柱面尺寸定位的嵌套 <svg>（局部坐标系）里
// 用反复 <line>/<circle> 直接拼出纹理（textureLinesFor），既不用 clipPath/pattern 引用，也不产生 url(。
//
// 约定：白底、宽 720、viewBox + max-width:100% 可缩放打印；高度随内容自适应。

export const SERIES_COLORS = Object.freeze({
  // 灰度阶：black / gray 为「主系列」，light 为浅灰系列；第四个系列用浅色底 + 黑框 / 纯黑细线
  blue: '#1a1a1a', // 原「蓝」→ 黑
  green: '#8c8c8c', // 原「绿」→ 深灰
  orange: '#d9d9d9', // 原「橙」→ 浅灰
  purple: '#4d4d4d', // 原「紫」→ 中深灰（备用第四系列）
})

const SERIES_PALETTE = Object.freeze([
  SERIES_COLORS.blue,
  SERIES_COLORS.green,
  SERIES_COLORS.orange,
  SERIES_COLORS.purple,
])

// 与正文（宋体）一致的衬线族；不带任何外链字体
const FONT_FAMILY = "'Songti SC', 'SimSun', 'STSong', serif"
const AXIS_TEXT = '#1a1a1a'
const LABEL_TEXT = '#1a1a1a'
const TITLE_TEXT = '#1a1a1a'
const MUTED_TEXT = '#8c8c8c'
const GRID_COLOR = '#e8e8e8'
const AXIS_COLOR = '#1a1a1a'
const REF_LINE = '#a6a6a6' // 均值 / 达标线：浅灰虚线
const REF_TEXT = '#6b6b6b'
const WHITE = '#ffffff'

// 字号（A4 打印仍清晰）
const TITLE_FONT = 13
const LABEL_FONT = 10.5
const TICK_FONT = 9.5
const MIN_LABEL_FONT = 9.5

const AXIS_WIDTH = 0.8 // 坐标轴 / 零基线
const GRID_WIDTH = 0.5 // 网格线

const DASH = {
  solid: '',
  dashed: '6 3',
  dotted: '2 2 6 2',
}
const MARKER_KINDS = ['circle-filled', 'circle-open', 'square', 'triangle']

// 绘图区顶部预留的「标签净空」：最大值柱顶 / 100% 折线点上方也能放下数值标签
const TOP_PAD = 26

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
const fmt1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—')

/** 年级名：「2024级」→「2024 级」，与报告正文一致 */
const gradeLabel = (grade) => String(grade?.gradeName || '').replace(/(\d{4})\s*级/, '$1 级')

const escapeXml = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })

/** 粗略估算文本宽度（用于布局与碰撞检测；中文按 1em，ASCII 按 0.58em，宁大勿小）。 */
function textWidth(text, fontSize) {
  let width = 0
  for (const ch of String(text)) {
    width += /[\x00-\xff]/.test(ch) ? 0.58 * fontSize : 1.0 * fontSize
  }
  return width
}

/** 把文本裁剪到 maxWidth 内（超出加省略号），避免分类名/教师名越界。 */
function fitText(text, maxWidth, fontSize) {
  const raw = String(text == null ? '' : text)
  if (textWidth(raw, fontSize) <= maxWidth) return raw
  let out = ''
  for (const ch of raw) {
    if (textWidth(out + ch + '…', fontSize) > maxWidth) break
    out += ch
  }
  return out ? out + '…' : '…'
}

/** 把最大值向上取整到「好看」的刻度，返回最大刻度、步长与刻度段数。 */
function niceScale(maxValue, targetTicks = 6) {
  const max = Math.max(1, Number(maxValue) || 0)
  const rough = max / targetTicks
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const norm = rough / magnitude
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10
  const step = mult * magnitude
  const top = Math.ceil((max * 1.04) / step) * step
  return { max: top, step, ticks: Math.max(2, Math.round(top / step)) }
}

function tickText(value, step) {
  let decimals = 0
  if (!Number.isInteger(step)) decimals = step >= 1 ? 1 : step >= 0.1 ? 1 : 2
  return String(Number(value.toFixed(decimals)))
}

/** 简单平均，忽略 null / 非数字；全空返回 null。 */
function meanOf(values) {
  const nums = (Array.isArray(values) ? values : []).filter(isNum)
  if (!nums.length) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function svgOpen(width, height, title) {
  const label = escapeXml(title || '图表')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"` +
    ` role="img" aria-label="${label}" style="max-width:100%;height:auto;background:#ffffff">` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${WHITE}"/>`
  )
}

// 注意：文字一律「纯填充」，绝不用 paint-order + stroke 的白色描边光晕——Chrome 打印 PDF 时会为
// 描边文字嵌入 Type 3 字体（不可检索、跨阅读器渲染不一致）。需要压盖背景的标签改用白色 <rect> 底块。
function textEl(x, y, text, opts = {}) {
  const { anchor = 'start', fontSize = LABEL_FONT, fill = LABEL_TEXT, weight = 400 } = opts
  return (
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" font-size="${fontSize}"` +
    ` font-family="${FONT_FAMILY}" fill="${fill}" font-weight="${weight}">${escapeXml(text)}</text>`
  )
}

/** 标签文字的外框（不含内边距），用于白底块与碰撞判断。 */
function labelBoxOf(layout, label) {
  return layout.boxOf(label.x, label.y, label.anchor, label.text, label.fontSize)
}

/** 标签的白色底块（替代原来的白描边光晕）：留 1.6px 内边距，避免与纹理/网格线/参考线粘连。 */
function labelPlate(box) {
  const padX = 1.6
  const padY = 1.2
  return (
    `<rect x="${(box.x0 - padX).toFixed(1)}" y="${(box.y0 - padY).toFixed(1)}"` +
    ` width="${(box.x1 - box.x0 + padX * 2).toFixed(1)}" height="${(box.y1 - box.y0 + padY * 2).toFixed(1)}"` +
    ` fill="${WHITE}"/>`
  )
}

/** 判断外框是否与任一障碍块相交。 */
function hitsAny(box, rects) {
  return rects.some(
    (r) => box.x0 < r.x1 && box.x1 > r.x0 && box.y0 < r.y1 && box.y1 > r.y0,
  )
}

function emptySvg(title, hint = '本周期暂无可用数据') {
  const t = fitText(String(title || '图表'), 692, TITLE_FONT)
  const h = fitText(String(hint || ''), 692, 11)
  return [
    svgOpen(720, 180, title),
    textEl(360, 88, t, { anchor: 'middle', fontSize: TITLE_FONT, fill: TITLE_TEXT, weight: 'bold' }),
    textEl(360, 116, h, { anchor: 'middle', fontSize: LABEL_FONT, fill: MUTED_TEXT }),
    '</svg>',
  ].join('')
}

// ---------------------------------------------------------------------------
// 系列样式：灰度 + 纹理 / 线型 / 标记（index 决定，黑白打印可区分）
// ---------------------------------------------------------------------------
// 纹理模式：diag 斜线（左上→右下）、backdiag 反斜线（左下→右上）、cross 双向斜线、dots 点阵、grid 方网格
const BAR_TEXTURES = ['diag', 'backdiag', 'cross', 'dots', 'grid', 'diag', 'backdiag']

/** 某个系列（柱/条）的灰度底与纹理。 */
function barStyle(index) {
  const color = SERIES_PALETTE[index % SERIES_PALETTE.length]
  return {
    color,
    texture: BAR_TEXTURES[index % BAR_TEXTURES.length],
    edge: color === SERIES_COLORS.orange ? '#1a1a1a' : 'none',
  }
}

/** 某个折线系列的灰度、线型与标记。 */
function lineStyle(index) {
  return {
    color: SERIES_PALETTE[index % SERIES_PALETTE.length],
    dash: DASH[(['solid', 'dashed', 'dotted', 'dashed'])[index % 4]],
    marker: MARKER_KINDS[index % MARKER_KINDS.length],
  }
}

/**
 * 生成纹理线（局部坐标 0..w / 0..h）。
 * 返回 <line>/<circle> 片段数组，由调用方套上颜色；不产生 clipPath / pattern 引用，故 SVG 里没有 `url(`。
 * @param {'diag'|'backdiag'|'cross'|'dots'|'grid'} tex
 * @param {number} w @param {number} h
 * @param {object} [opts] density：线距（默认 5；图例等小尺寸传 1 即更真实地铺满）
 */
function textureLinesFor(tex, w, h, opts = {}) {
  const W = Math.max(1, Math.round(w))
  const H = Math.max(1, Math.round(h))
  if (W < 3 || H < 3) return []
  const tight = (opts.density || 5) <= 2
  const step = tight ? 3 : 5
  const lines = []
  if (tex === 'diag' || tex === 'cross') {
    const diag = Math.round(Math.sqrt(W * W + H * H)) + step
    for (let d = -H; d <= diag; d += step) {
      const x1 = Math.max(0, d)
      const y1 = Math.max(0, -d)
      const reach = Math.min(W - d, H)
      if (reach <= 0 || x1 > W) continue
      const x2 = Math.min(W, d + H)
      const y2 = Math.min(H, W - d < 0 ? 0 : W - d)
      if (x2 <= x1 || y2 <= y1) continue
      lines.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`)
    }
  }
  if (tex === 'backdiag' || tex === 'cross') {
    for (let d = 0; d <= W + H; d += step) {
      const x1 = Math.max(0, d - H)
      const y1 = Math.min(H, d)
      const x2 = Math.min(W, d)
      const y2 = Math.max(0, d - W)
      if (x2 <= x1 || y1 <= y2) continue
      lines.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`)
    }
  }
  if (tex === 'dots') {
    for (let yy = step / 2 + 0.5; yy < H; yy += step) {
      for (let xx = step / 2 + 0.5; xx < W; xx += step) {
        lines.push(`<circle cx="${xx.toFixed(1)}" cy="${yy.toFixed(1)}" r="0.9"/>`)
      }
    }
  }
  if (tex === 'grid') {
    for (let xx = step; xx < W; xx += step) {
      lines.push(`<line x1="${xx}" y1="0" x2="${xx}" y2="${H}"/>`)
    }
    for (let yy = step; yy < H; yy += step) {
      lines.push(`<line x1="0" y1="${yy}" x2="${W}" y2="${yy}"/>`)
    }
  }
  return lines
}

/**
 * 柱面（或条形）填充：灰度底 + 纹理线。
 * 纹理在一个按柱面尺寸裁切的嵌套 <svg> 里用局部坐标画反复 <line>，因此只需传左上角 x/y，
 * 不产生 clipPath / pattern 引用，也绝不出现 `url(` 字样。
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {object} style barStyle() 的结果
 */
function texturedRect(x, y, w, h, style) {
  if (!(w > 0) || !(h > 0)) return ''
  const fill = style.color || SERIES_COLORS.blue
  const edge = style.edge && style.edge !== 'none' ? style.edge : ''
  const out = [
    `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"` +
      ` fill="${fill}"${edge ? ` stroke="${edge}" stroke-width="0.6"` : ''}/>`,
  ]
  const tex = style.texture
  if (!tex) return out.join('')

  // 纹理颜色：浅灰底用深灰线，深灰底用白线，黑底用浅灰线（灰阶打印后仍能看出纹理，又不致整块发黑）
  const stroke =
    fill === '#d9d9d9'
      ? '#6b6b6b'
      : fill === '#8c8c8c' || fill === '#4d4d4d'
        ? '#ffffff'
        : '#b3b3b3'
  const W = Math.max(1, Math.round(w))
  const H = Math.max(1, Math.round(h))
  // 纹理太窄/太矮时退化为「只画底 + 边框」，避免糊成一片
  if (W < 3 || H < 3) return out.join('')
  const lines = textureLinesFor(tex, W, H, { density: style.density })
  if (lines.length) {
    out.push(
      `<svg x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"` +
        ` overflow="visible" stroke="${stroke}" stroke-width="0.7" fill="${stroke}" shape-rendering="crispEdges">` +
        lines.join('') +
        '</svg>',
    )
  }
  return out.join('')
}

/** 折线系列标记（实心圆 / 空心圆 / 方块 / 三角），白底黑边打印/缩放后仍可区分。 */
function markerEl(kind, cx, cy, color) {
  const c = color || SERIES_COLORS.blue
  switch (kind) {
    case 'circle-open':
      return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.2" fill="${WHITE}" stroke="${c}" stroke-width="1.4"/>`
    case 'square':
      return `<rect x="${(cx - 3).toFixed(1)}" y="${(cy - 3).toFixed(1)}" width="6" height="6" fill="${WHITE}" stroke="${c}" stroke-width="1.4"/>`
    case 'triangle':
      return (
        `<polygon points="${cx.toFixed(1)},${(cy - 3.8).toFixed(1)} ${(cx + 3.6).toFixed(1)},${(cy + 2.6).toFixed(1)}` +
        ` ${(cx - 3.6).toFixed(1)},${(cy + 2.6).toFixed(1)}" fill="${WHITE}" stroke="${c}" stroke-width="1.3"/>`
      )
    default:
      return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3" fill="${c}" stroke="${WHITE}" stroke-width="0.8"/>`
  }
}

/**
 * 图例标记（与图中一致：柱 = 白底细框 + 该系的纹理；折线 = 该系线型 + 标记）。
 * 小尺寸（10px）里铺灰底会让图例整体发灰，故只画纹理线、不填灰底。
 */
function legendSwatch(x, y, style, swatch, isLine) {
  if (isLine) {
    const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : ''
    return [
      `<line x1="${x.toFixed(1)}" y1="${(y - 4).toFixed(1)}" x2="${(x + swatch).toFixed(1)}" y2="${(y - 4).toFixed(1)}"` +
        ` stroke="${style.color}" stroke-width="1.6"${dash}/>`,
      markerEl(style.marker, x + swatch / 2, y - 4, style.color),
    ].join('')
  }
  const y0 = y - 10
  const lines = textureLinesFor(style.texture, swatch, swatch, { density: 1 })
  return [
    `<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${swatch}" height="${swatch}"` +
      ` fill="${WHITE}" stroke="${AXIS_COLOR}" stroke-width="0.5"/>`,
    lines.length
      ? `<g transform="translate(${x.toFixed(1)},${y0.toFixed(1)})" stroke="${LABEL_TEXT}" stroke-width="0.6" fill="${LABEL_TEXT}" shape-rendering="crispEdges">${lines.join('')}</g>`
      : '',
  ].join('')
}

// ---------------------------------------------------------------------------
// 标签排版引擎：全局候选位置 + 包围盒碰撞检测 + 越界代价 + 兜底
// ---------------------------------------------------------------------------
function createLabelLayout() {
  const boxes = []
  const PAD = 1.5

  const boxOf = (x, y, anchor, text, fontSize) => {
    const w = textWidth(text, fontSize)
    const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x
    return { x0, x1: x0 + w, y0: y - fontSize * 0.82, y1: y + fontSize * 0.26 }
  }
  const expand = (b) => ({ x0: b.x0 - PAD, x1: b.x1 + PAD, y0: b.y0 - PAD, y1: b.y1 + PAD })
  const overlapArea = (a, b) => {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
    const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
    return w > 0 && h > 0 ? w * h : 0
  }
  const cost = (box, bounds) => {
    let c = 0
    if (bounds) {
      const dx = Math.max(0, bounds.x0 - box.x0) + Math.max(0, box.x1 - bounds.x1)
      const dy = Math.max(0, bounds.y0 - box.y0) + Math.max(0, box.y1 - bounds.y1)
      c += (dx + dy) * 1000
    }
    for (const p of boxes) c += overlapArea(box, expand(p)) * 10
    return c
  }
  return {
    boxOf,
    cost,
    add: (box) => boxes.push(box),
    addAll: (list) => boxes.push(...list),
  }
}

/**
 * 依次尝试候选位置：字号优先 10.5，其次 9.5（仍 ≥ 下限）；可选标签（折线值）放不下就省略，
 * 必显标签（柱值）在极端情况下也保证落位（取冲突代价最小的候选）。
 */
function placeLabel(layout, candidates, req, bounds, opts = {}) {
  const { optional = false, shrink = true } = opts
  const sizes = [req.fontSize || LABEL_FONT]
  if (shrink && sizes[0] > MIN_LABEL_FONT) sizes.push(MIN_LABEL_FONT)

  let fallback = null
  for (const fontSize of sizes) {
    for (const c of candidates) {
      const label = {
        x: c.x,
        y: c.y,
        anchor: c.anchor || 'middle',
        text: req.text,
        fontSize,
        color: c.color || req.color || LABEL_TEXT,
        plate: c.halo === undefined ? req.halo !== false : c.halo,
      }
      const box = layout.boxOf(label.x, label.y, label.anchor, label.text, fontSize)
      const damage = layout.cost(box, bounds)
      if (damage === 0) {
        layout.add(box)
        return label
      }
      if (!fallback || damage < fallback.damage) fallback = { damage, box, label }
    }
  }
  if (optional || !fallback) return null
  layout.add(fallback.box)
  return fallback.label
}

function renderLabel(label) {
  if (!label) return ''
  return textEl(label.x, label.y, label.text, {
    anchor: label.anchor,
    fontSize: label.fontSize,
    fill: label.color,
    weight: 'bold',
  })
}

// 折线数据点标签：优先点在上下方（远离折线），其次左右错开，最后斜向；都放不下则省略
//（折线值可退让，柱值必须可读）。
function lineLabelCandidates(x, y) {
  return [
    { x, y: y - 12, anchor: 'middle' },
    { x, y: y + 20, anchor: 'middle' },
    { x, y: y - 26, anchor: 'middle' },
    { x, y: y + 34, anchor: 'middle' },
    { x: x + 10, y: y + 4, anchor: 'start' },
    { x: x - 10, y: y + 4, anchor: 'end' },
    { x: x + 10, y: y - 9, anchor: 'start' },
    { x: x - 10, y: y - 9, anchor: 'end' },
    { x: x + 10, y: y + 16, anchor: 'start' },
    { x: x - 10, y: y + 16, anchor: 'end' },
  ]
}

// 柱值标签：柱顶上方 → 更高处 → 更远处错开（黑白印刷不往柱内塞白字，
// 柱面有纹理，白字压在纹理上无法辨读；柱值一律放在柱面之外、带白描边）。
function barLabelCandidates(cx, top, barW, barH, text) {
  if (barH < 14) {
    // 极矮的柱：标签放到零基线下方（X 轴分类名之上），避免盖住柱面
    return [
      { x: cx, y: top + 12, anchor: 'middle' },
      { x: cx, y: top - 6, anchor: 'middle' },
      { x: cx, y: top + 22, anchor: 'middle' },
    ]
  }
  return [
    { x: cx, y: top - 6, anchor: 'middle' },
    { x: cx, y: top - 17, anchor: 'middle' },
    { x: cx, y: top - 28, anchor: 'middle' },
    { x: cx, y: top - 39, anchor: 'middle' },
  ]
}

// ---------------------------------------------------------------------------
// 标题 + 图例（标题一行；图例在标题下一行右对齐，放不下则换行；返回绘图区起点与占用包围盒）
// ---------------------------------------------------------------------------
function layoutHeader(title, legendItems, width) {
  const font = LABEL_FONT
  const gap = 18
  const swatch = 10
  const pad = 14

  const items = (Array.isArray(legendItems) ? legendItems : []).map((it) => {
    const name = String(it?.name ?? '')
    return {
      name,
      style: it?.style || barStyle(0),
      line: Boolean(it?.line),
      w: swatch + 6 + textWidth(name, font),
    }
  })

  const rows = []
  let row = []
  let rowW = 0
  for (const it of items) {
    const add = row.length ? gap + it.w : it.w
    if (row.length && rowW + add > width - pad * 2) {
      rows.push({ items: row, width: rowW })
      row = []
      rowW = 0
    }
    row.push(it)
    rowW += row.length > 1 ? gap + it.w : it.w
  }
  if (row.length) rows.push({ items: row, width: rowW })

  const titleText = fitText(String(title || ''), width - pad * 2, TITLE_FONT)
  const titleW = titleText ? textWidth(titleText, TITLE_FONT) : 0

  // 图例统一另起一行、右对齐：与正文式图表（标题在上、图例居次）一致，且不会与长标题打架
  const firstLegendY = titleText ? 38 : 20

  const parts = []
  const obstacles = []
  if (titleText) {
    parts.push(
      textEl(pad, 20, titleText, { fontSize: TITLE_FONT, fill: TITLE_TEXT, weight: 'bold' }),
    )
    obstacles.push({ x0: pad - 1, x1: pad + titleW + 1, y0: 6, y1: 26 })
  }
  rows.forEach((r, ri) => {
    let x = width - pad - r.width
    const y = firstLegendY + ri * 16
    for (const it of r.items) {
      parts.push(legendSwatch(x, y, it.style, swatch, it.line))
      parts.push(textEl(x + swatch + 6, y, it.name, { fontSize: font, fill: LABEL_TEXT }))
      x += it.w + gap
    }
    obstacles.push({ x0: width - pad - r.width - 1, x1: width - pad, y0: y - 12, y1: y + 5 })
  })

  const plotTop = rows.length
    ? firstLegendY + (rows.length - 1) * 16 + 13
    : titleText
      ? 36
      : 20
  return { parts, obstacles, plotTop }
}

// ---------------------------------------------------------------------------
// 参考线（均值 / 达标线）：浅灰虚线 + 小字标注
// ---------------------------------------------------------------------------
/**
 * @param {object} spec
 * @param {number} spec.x1 @param {number} spec.x2     水平线起止
 * @param {number} spec.y
 * @param {string} spec.label
 * @param {'left'|'right'} [spec.side]  标注位置：右端（结束）或左端
 * @param {number} [spec.labelY]        标注基线（默认线下方 4）
 */
function refLineH(spec, width) {
  const { x1, x2, y, label, side = 'right' } = spec
  const text = String(label || '')
  const fontSize = TICK_FONT
  const w = textWidth(text, fontSize)
  const parts = [
    `<line x1="${x1.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y.toFixed(1)}"` +
      ` stroke="${REF_LINE}" stroke-width="0.8" stroke-dasharray="5 3"/>`,
  ]
  let tx
  let anchor
  if (side === 'right') {
    tx = clamp(x2 - 2, 0, width - 2)
    anchor = 'end'
  } else {
    tx = clamp(x1 + 2, 2, width)
    anchor = 'start'
  }
  parts.push(
    textEl(tx, spec.labelY ?? y - 4, text, {
      anchor,
      fontSize,
      fill: REF_TEXT,
    }),
  )
  return { svg: parts.join(''), box: { x0: tx - (anchor === 'end' ? w : 0), x1: tx + (anchor === 'end' ? 0 : w), y0: (spec.labelY ?? y - 4) - fontSize, y1: (spec.labelY ?? y - 4) + 2 } }
}

/** 垂直线（达标线）+ 顶部小字 */
function refLineV(spec) {
  const { x, y1, y2, label } = spec
  const parts = [
    `<line x1="${x.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y2.toFixed(1)}"` +
      ` stroke="${REF_LINE}" stroke-width="0.8" stroke-dasharray="5 3"/>`,
  ]
  const text = String(label || '')
  const fontSize = TICK_FONT
  const w = textWidth(text, fontSize)
  parts.push(
    textEl(x, y1 - 4, text, { anchor: 'middle', fontSize, fill: REF_TEXT }),
  )
  return { svg: parts.join(''), box: { x0: x - w / 2, x1: x + w / 2, y0: y1 - 4 - fontSize, y1: y1 - 2 } }
}

// ---------------------------------------------------------------------------
// 通用「分组柱 + 折线」
// ---------------------------------------------------------------------------
/**
 * @param {object} options
 * @param {string} [options.title]        图表标题（左上）
 * @param {string[]} [options.categories] X 轴分类（中文，建议短名）
 * @param {Array} [options.bars]          [{ name, color, values: (number|null)[] }] 左侧柱系列
 * @param {Array} [options.lines]         [{ name, color, values: (number|null)[] }] 右侧折线（按百分比）
 * @param {Array|number} [options.rightRefLines] 右侧轴参考线：{value,label,labelIndex} 或数值（均值线 / 达标线）
 * @param {number} [options.width]        画布宽（默认 720）
 * @param {number} [options.height]       画布高（默认 300）
 * @param {number} [options.leftMax]      左侧轴最大值（不传则自动取整）
 * @param {number} [options.rightMax]     右侧轴最大值（默认 100）
 * @param {string} [options.hint]         无数据时的提示
 */
export function barComboSvg(options = {}) {
  const {
    title = '',
    categories = [],
    bars = [],
    lines = [],
    rightRefLines = [],
    width = 720,
    height = 300,
    leftMax = null,
    rightMax = 100,
    hint = '本周期暂无可用数据',
  } = options

  const chartTitle = String(title ?? '')
  const cats = (Array.isArray(categories) ? categories : []).map((c) => String(c ?? ''))
  const rawBars = (Array.isArray(bars) ? bars : []).filter((s) => s && Array.isArray(s.values))
  const rawLines = (Array.isArray(lines) ? lines : []).filter((s) => s && Array.isArray(s.values))
  const n = cats.length

  const barList = rawBars.map((s, i) => ({
    name: String(s.name ?? '柱状值'),
    ...barStyle(i),
    values: s.values,
  }))
  const lineList = rawLines.map((s, i) => ({
    name: String(s.name ?? '折线值'),
    ...lineStyle(i),
    values: s.values,
  }))

  const hasBar = barList.some((s) => {
    for (let i = 0; i < n; i++) if (isNum(s.values[i])) return true
    return false
  })
  const hasLine = lineList.some((s) => {
    for (let i = 0; i < n; i++) if (isNum(s.values[i])) return true
    return false
  })
  if (!n || (!hasBar && !hasLine)) return emptySvg(chartTitle, hint)

  // ---- 图例 + 标题 ----
  const legendItems = [
    ...barList.map((s) => ({ name: s.name, style: s, line: false })),
    ...lineList.map((s) => ({ name: s.name, style: s, line: true })),
  ]
  const header = layoutHeader(chartTitle, legendItems, width)

  // ---- 边距与刻度 ----
  let maxBar = 0
  for (const s of barList) {
    for (let i = 0; i < n; i++) {
      const v = s.values[i]
      if (isNum(v) && v > maxBar) maxBar = v
    }
  }
  const scale = niceScale(maxBar > 0 ? maxBar : 1, 6)
  const leftTop = isNum(leftMax) && leftMax > 0 ? leftMax : scale.max
  const leftTicks = isNum(leftMax) && leftMax > 0 ? 4 : scale.ticks
  const leftStep = leftTop / leftTicks

  const rightTop = isNum(rightMax) && rightMax > 0 ? rightMax : 100
  const rightTicks = 4
  const rightStep = rightTop / rightTicks

  const leftLabelW = Math.max(
    textWidth(String(leftTop), TICK_FONT),
    textWidth(tickText(leftTop, leftStep), TICK_FONT),
  )
  const rightLabelW = textWidth(`${tickText(rightTop, rightStep)}%`, TICK_FONT)
  const ml = Math.max(46, Math.ceil(leftLabelW + 20))
  const mr = Math.max(44, Math.ceil((hasLine ? rightLabelW : 0) + 18))

  const mb = 42
  const plotTop = header.plotTop
  const plotLeft = ml
  const plotW = Math.max(140, width - ml - mr)
  const plotRight = plotLeft + plotW
  const h = Math.max(height, plotTop + mb + 100)
  const plotBottom = h - mb
  const plotH = Math.max(60, plotBottom - plotTop)

  const innerTop = plotTop + TOP_PAD
  const innerH = Math.max(30, plotH - TOP_PAD)
  const yOf = (value, top) => innerTop + innerH * (1 - clamp(value, 0, top) / top)
  const yLeft = (v) => yOf(v, leftTop)
  const yRight = (v) => yOf(v, rightTop)

  const slot = plotW / n
  const center = (i) => plotLeft + slot * (i + 0.5)

  const parts = [svgOpen(width, h, chartTitle), ...header.parts]

  // ---- 网格线与坐标轴（黑轴、浅灰细网格） ----
  const gridSource = hasBar
    ? Array.from({ length: leftTicks + 1 }, (_, i) => ({
        value: i * leftStep,
        y: yLeft(i * leftStep),
      }))
    : Array.from({ length: rightTicks + 1 }, (_, i) => ({
        value: (rightTop / rightTicks) * i,
        y: yRight((rightTop / rightTicks) * i),
      }))
  for (let i = 0; i < gridSource.length; i++) {
    const g = gridSource[i]
    parts.push(
      `<line x1="${plotLeft}" y1="${g.y.toFixed(1)}" x2="${plotRight}" y2="${g.y.toFixed(1)}" stroke="${i === 0 ? AXIS_COLOR : GRID_COLOR}" stroke-width="${i === 0 ? AXIS_WIDTH : GRID_WIDTH}"/>`,
    )
    if (hasBar) {
      parts.push(
        textEl(plotLeft - 8, g.y + 3.3, tickText(g.value, leftStep), {
          anchor: 'end',
          fontSize: TICK_FONT,
          fill: AXIS_TEXT,
        }),
      )
    }
  }
  // Y 轴竖线（细）：与横轴同一视觉重量
  parts.push(
    `<line x1="${plotLeft}" y1="${innerTop - 4}" x2="${plotLeft}" y2="${plotBottom}" stroke="${AXIS_COLOR}" stroke-width="${AXIS_WIDTH}"/>`,
  )
  if (hasLine) {
    for (let i = 0; i <= rightTicks; i++) {
      const value = (rightTop / rightTicks) * i
      const y = yRight(value)
      parts.push(
        textEl(plotRight + 8, y + 3.3, `${tickText(value, rightStep)}%`, {
          fontSize: TICK_FONT,
          fill: AXIS_TEXT,
        }),
      )
    }
    parts.push(
      `<line x1="${plotRight}" y1="${innerTop - 4}" x2="${plotRight}" y2="${plotBottom}" stroke="${AXIS_COLOR}" stroke-width="${AXIS_WIDTH}"/>`,
    )
  }

  // ---- 柱（灰度 + 纹理，无圆角） ----
  const gap = barList.length > 1 ? Math.min(4, Math.max(2, (slot * 0.72) / 100)) : 0
  const groupW = Math.max(6, Math.min(slot * 0.72, barList.length === 1 ? 46 : 132))
  const barW =
    barList.length > 1 ? Math.max(4, (groupW - gap * (barList.length - 1)) / barList.length) : groupW

  const barReqs = []
  const barRects = []
  for (let si = 0; si < barList.length; si++) {
    const series = barList[si]
    for (let i = 0; i < n; i++) {
      const v = series.values[i]
      if (!isNum(v)) continue
      const x = center(i) - groupW / 2 + si * (barW + gap)
      const y = yLeft(v)
      const barH = Math.max(0, plotBottom - y)
      if (barH <= 1) {
        parts.push(
          texturedRect(x, plotBottom - 1.5, barW, 1.5, { ...series, texture: null }),
        )
      } else {
        parts.push(texturedRect(x, y, barW, barH, series))
      }
      barRects.push({ x0: x, x1: x + barW, y0: y, y1: plotBottom })
      barReqs.push({
        cx: x + barW / 2,
        top: y,
        barW,
        barH,
        text: fmt1(v),
        value: v,
        order: si * n + i,
      })
    }
  }

  // ---- 参考线（右侧轴，均值 / 达标线）：画在柱与折线之下，标注稍后再排 ----
  const refReqs = []
  const refSpecs = (Array.isArray(rightRefLines) ? rightRefLines : [rightRefLines])
    .map((r) => (isNum(r) ? { value: r } : r))
    .filter((r) => r && isNum(r.value) && r.value >= 0 && r.value <= rightTop)
  for (const r of refSpecs) {
    const y = yRight(r.value)
    const label = r.label ? String(r.label) : `均值 ${fmt1(r.value)}`
    parts.push(
      `<line x1="${plotLeft}" y1="${y.toFixed(1)}" x2="${plotRight}" y2="${y.toFixed(1)}"` +
        ` stroke="${REF_LINE}" stroke-width="0.8" stroke-dasharray="5 3"/>`,
    )
    // 标注位置：默认贴右端；传 labelIndex 则放在该分类的槽位上（不同分类处两条线错开，便于读数）
    const labelIndex = Number.isInteger(r.labelIndex) ? clamp(r.labelIndex, 0, n - 1) : null
    refReqs.push({ y, label, side: r.side || 'right', labelIndex })
  }

  // ---- 折线（遇 null 断开）、线型与数据点 ----
  const lineReqs = []
  const markerBoxes = []
  for (let li = 0; li < lineList.length; li++) {
    const series = lineList[li]
    const points = []
    for (let i = 0; i < n; i++) {
      const v = series.values[i]
      points.push(isNum(v) ? { x: center(i), y: yRight(v), value: v, index: i } : null)
    }
    let run = []
    const flush = () => {
      if (run.length >= 2) {
        const dash = series.dash ? ` stroke-dasharray="${series.dash}"` : ''
        parts.push(
          `<polyline points="${run.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${series.color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="butt"${dash}/>`,
        )
      }
      run = []
    }
    for (const p of points) {
      if (p) run.push(p)
      else flush()
    }
    flush()
    for (const p of points) {
      if (!p) continue
      parts.push(markerEl(series.marker, p.x, p.y, series.color))
      markerBoxes.push({ x0: p.x - 5, x1: p.x + 5, y0: p.y - 5, y1: p.y + 5 })
      lineReqs.push({ x: p.x, y: p.y, text: fmt1(p.value), color: series.color, index: p.index })
    }
  }

  // ---- 数值标签排版（柱值优先，折线值可退让） ----
  // 无白描边光晕后，标签不能再压在网格线 / 参考虚线上（细线穿过文字会糊），
  // 因此把这些细线登记为「软障碍」：候选位置压到它们时，优先上下微调错开。
  const layout = createLabelLayout()
  header.obstacles.forEach((b) => layout.add(b))
  layout.addAll(markerBoxes)
  const labelBounds = { x0: plotLeft - 2, x1: plotRight + 2, y0: plotTop + 1, y1: plotBottom - 2 }
  const softLines = gridSource.map((g) => ({
    x0: plotLeft,
    x1: plotRight,
    y0: g.y - 0.9,
    y1: g.y + 0.9,
  }))
  for (const r of refReqs) softLines.push({ x0: plotLeft, x1: plotRight, y0: r.y - 0.9, y1: r.y + 0.9 })

  /** 候选位置与网格/参考线相交时：上下各挪 4px / 8px 找一个不压线的落点（保持水平位置不变）。 */
  const dodgeLines = (cand, text, fontSize) => {
    const test = (y) =>
      hitsAny(layout.boxOf(cand.x, y, cand.anchor, text, fontSize), softLines)
    if (!test(cand.y)) return [cand]
    const out = [cand]
    for (const dy of [-4, 4, -8, 8, -12, 12]) {
      if (!test(cand.y + dy)) out.push({ ...cand, y: cand.y + dy })
    }
    return out
  }

  const labels = []
  const sortedBarReqs = barReqs
    .slice()
    .sort((a, b) => b.value - a.value || a.order - b.order)
  for (const req of sortedBarReqs) {
    const base = barLabelCandidates(req.cx, req.top, req.barW, req.barH, req.text)
    const candidates = base.flatMap((c) => dodgeLines(c, req.text, LABEL_FONT))
    const label = placeLabel(
      layout,
      candidates,
      { text: req.text, color: LABEL_TEXT, plate: true, fontSize: LABEL_FONT },
      labelBounds,
    )
    if (label) labels.push({ label })
  }
  lineReqs.sort((a, b) => a.index - b.index)
  for (const req of lineReqs) {
    const candidates = lineLabelCandidates(req.x, req.y).flatMap((c) =>
      dodgeLines(c, req.text, LABEL_FONT),
    )
    const label = placeLabel(
      layout,
      candidates,
      { text: req.text, color: LABEL_TEXT, plate: true, fontSize: LABEL_FONT },
      labelBounds,
      { optional: true },
    )
    if (label) labels.push({ label, line: true })
  }
  // 标签压在柱面纹理 / 网格线 / 参考虚线上时，垫一块白色底块（取代原来的白描边光晕），
  // 保证黑字与底纹不互相干扰，也避免细线穿过文字。
  for (const item of labels) {
    const label = item.label
    const box = labelBoxOf(layout, label)
    if (label.plate || hitsAny(box, barRects) || hitsAny(box, softLines)) {
      parts.push(labelPlate(box))
    }
    parts.push(renderLabel(label))
  }

  // ---- 参考线标注（在数值标签之后，避开已排标签） ----
  for (const r of refReqs) {
    const fontSize = TICK_FONT
    const w = textWidth(r.label, fontSize)
    let cands
    if (r.labelIndex != null) {
      const cx = center(r.labelIndex)
      // 放在分类槽中部：先在上方，再在下方；宽度超出槽宽时改为贴槽左侧
      const fits = w + 8 <= slot
      cands = fits
        ? [
            { x: cx, y: r.y - 4, anchor: 'middle' },
            { x: cx, y: r.y + 11, anchor: 'middle' },
          ]
        : [
            { x: cx - slot / 2 + 3, y: r.y - 4, anchor: 'start' },
            { x: cx - slot / 2 + 3, y: r.y + 11, anchor: 'start' },
          ]
    } else if (r.side === 'left') {
      cands = [
        { x: plotLeft + 3, y: r.y - 4, anchor: 'start' },
        { x: plotLeft + 3, y: r.y + 11, anchor: 'start' },
      ]
    } else {
      cands = [
        { x: plotRight - 2, y: r.y - 4, anchor: 'end' },
        { x: plotRight - 2, y: r.y + 11, anchor: 'end' },
      ]
    }
    const placed = placeLabel(
      layout,
      cands,
      { text: r.label, color: REF_TEXT, plate: true, fontSize },
      labelBounds,
      { shrink: false },
    )
    const p = placed || { x: cands[0].x, y: cands[0].y, anchor: cands[0].anchor, fontSize }
    // 白底块把均值虚线在标注处「断开」，标注不会与虚线互相糊在一起
    parts.push(labelPlate(labelBoxOf(layout, { ...p, text: r.label })))
    parts.push(
      textEl(p.x, p.y, r.label, {
        anchor: p.anchor,
        fontSize,
        fill: REF_TEXT,
      }),
    )
    void w
  }

  // ---- X 轴分类标签（裁剪到槽宽内，避免相邻文字压叠） ----
  const maxCatW = Math.max(16, slot - 6)
  for (let i = 0; i < n; i++) {
    const label = fitText(cats[i], maxCatW, LABEL_FONT)
    parts.push(
      textEl(center(i), h - 14, label, {
        anchor: 'middle',
        fontSize: LABEL_FONT,
        fill: LABEL_TEXT,
      }),
    )
  }

  parts.push('</svg>')
  return parts.join('')
}

// ---------------------------------------------------------------------------
// 各学科：生均题量（柱）+ 完成率 / 师阅率（折线）+ 两条均值参考线
// ---------------------------------------------------------------------------
/** 缺失学科不画柱，正文另行说明；均值取该年级有效学科（有任务的）的简单平均。 */
export function subjectOverviewSvg(grade = {}) {
  const gradeName = gradeLabel(grade)
  const subjects = (Array.isArray(grade?.subjects) ? grade.subjects : []).filter(
    (s) => s && s.short && !s.missing && (isNum(s.taskCount) ? s.taskCount > 0 : false),
  )
  const chartTitle = `${gradeName}各学科生均题量与完成率、师阅率对比`
  if (!subjects.length) {
    return emptySvg(chartTitle, '本周期无学科任务数据')
  }

  // 均值：该年级有效学科（有任务的）简单平均，非加权
  const finishAvg = meanOf(subjects.map((s) => s.finishPercent))
  const markAvg = meanOf(subjects.map((s) => s.teacherMarkPercent))
  const refLines = []
  if (isNum(finishAvg)) {
    refLines.push({
      value: finishAvg,
      label: `完成率均值 ${fmt1(finishAvg)}`,
      labelIndex: 0,
    })
  }
  if (isNum(markAvg)) {
    refLines.push({
      value: markAvg,
      label: `师阅率均值 ${fmt1(markAvg)}`,
      labelIndex: Math.max(1, subjects.length - 1),
    })
  }

  return barComboSvg({
    title: chartTitle,
    categories: subjects.map((s) => s.short),
    bars: [
      {
        name: '生均题量（道）',
        color: SERIES_COLORS.blue,
        values: subjects.map((s) => s.avgQuestionsByStudent),
      },
    ],
    lines: [
      {
        name: '完成率（%）',
        color: SERIES_COLORS.green,
        values: subjects.map((s) => s.finishPercent),
      },
      {
        name: '师阅率（%）',
        color: SERIES_COLORS.orange,
        values: subjects.map((s) => s.teacherMarkPercent),
      },
    ],
    rightRefLines: refLines,
    width: 720,
    height: 330,
    hint: '本周期无学科任务数据',
  })
}

// ---------------------------------------------------------------------------
// 任务量前 12 位教师：完成率 / 师阅率横向分组条形图（教师名在左侧，值标在右侧列）
// ---------------------------------------------------------------------------
export function teacherOverviewSvg(grade = {}) {
  const gradeName = gradeLabel(grade)
  const teachers = (Array.isArray(grade?.teachers) ? grade.teachers : [])
    .filter((t) => t && t.name && (isNum(t.taskCount) ? t.taskCount > 0 : false))
    .slice()
    .sort(
      (a, b) =>
        (b.taskCount || 0) - (a.taskCount || 0) ||
        String(a.name).localeCompare(String(b.name), 'zh'),
    )
    .slice(0, 12)
  const chartTitle = `${gradeName}教师完成率与师阅率对比（任务量前 12 位）`
  if (!teachers.length) return emptySvg(chartTitle, '本周期无教师任务数据')

  const width = 720
  const ml = 92
  // 右侧统一数值列：「完成率 / 师阅率」，不再随条末漂移，避免跨行误读
  const mr = 104
  const rowH = 20
  const mb = 26
  const barH = 4

  const series = [
    { key: 'finishPercent', name: '完成率（%）', ...barStyle(0) },
    { key: 'teacherMarkPercent', name: '师阅率（%）', ...barStyle(1) },
  ]
  const header = layoutHeader(
    chartTitle,
    series.map((s) => ({ name: s.name, style: s, line: false })),
    width,
  )

  // 达标线标注在绘图区上方单独留一行（不压图例、不落进首行数据）
  const TARGET_LABEL_GAP = 13
  const plotTop = header.plotTop + TARGET_LABEL_GAP
  const plotLeft = ml
  const plotRight = width - mr
  const plotW = plotRight - plotLeft
  const plotH = teachers.length * rowH
  const plotBottom = plotTop + plotH
  const h = plotBottom + mb
  const xOf = (v) => plotLeft + (clamp(v, 0, 100) / 100) * plotW

  const parts = [svgOpen(width, h, chartTitle), ...header.parts]

  // 纵向网格 + 底部百分比轴（黑白：只用细网格，不用隔行底纹，避免打印成灰带）
  for (let i = 0; i <= 4; i++) {
    const x = xOf(i * 25)
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${plotTop}" x2="${x.toFixed(1)}" y2="${plotBottom}" stroke="${i === 0 ? AXIS_COLOR : GRID_COLOR}" stroke-width="${i === 0 ? AXIS_WIDTH : GRID_WIDTH}"/>`,
    )
  }
  parts.push(
    `<line x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="${AXIS_COLOR}" stroke-width="${AXIS_WIDTH}"/>`,
  )

  // 达标线：完成率 80%、师阅率 95%（浅灰虚线 + 顶部小字）
  const targets = [
    { value: 80, label: '80%' },
    { value: 95, label: '95%' },
  ]
  const targetXs = []
  for (const t of targets) {
    const x = xOf(t.value)
    targetXs.push(x)
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${(plotTop - 7).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(plotBottom + 2).toFixed(1)}"` +
        ` stroke="${REF_LINE}" stroke-width="0.8" stroke-dasharray="5 3"/>`,
    )
    parts.push(
      textEl(x, plotTop - 10, t.label, {
        anchor: 'middle',
        fontSize: TICK_FONT,
        fill: REF_TEXT,
      }),
    )
  }

  for (let i = 0; i < teachers.length; i++) {
    const t = teachers[i]
    const yCenter = plotTop + rowH * (i + 0.5)
    const name = fitText(String(t.name || ''), ml - 20, LABEL_FONT)
    parts.push(
      textEl(ml - 10, yCenter + 3.6, name, {
        anchor: 'end',
        fontSize: LABEL_FONT,
        fill: LABEL_TEXT,
      }),
    )

    const labelParts = []
    for (let si = 0; si < series.length; si++) {
      const s = series[si]
      const v = t[s.key]
      const barY = si === 0 ? yCenter - 6 : yCenter + 2
      if (isNum(v)) {
        const barW = Math.max(1.5, (clamp(v, 0, 100) / 100) * plotW)
        parts.push(texturedRect(plotLeft, barY, barW, barH, s))
      }
      if (si > 0) labelParts.push(`<tspan fill="${MUTED_TEXT}"> / </tspan>`)
      labelParts.push(
        `<tspan fill="${isNum(v) ? LABEL_TEXT : MUTED_TEXT}">${escapeXml(isNum(v) ? fmt1(v) : '—')}</tspan>`,
      )
    }
    // 两个数值与教师名共用同一基线；跨行不会重叠或错认
    parts.push(
      `<text x="${(plotRight + 8).toFixed(1)}" y="${(yCenter + 3.6).toFixed(1)}" font-size="${LABEL_FONT}" font-family="${FONT_FAMILY}" font-weight="bold">${labelParts.join('')}</text>`,
    )
  }

  // 底部百分比刻度
  for (let i = 0; i <= 4; i++) {
    parts.push(
      textEl(xOf(i * 25), plotBottom + 15, `${i * 25}%`, {
        anchor: 'middle',
        fontSize: TICK_FONT,
        fill: AXIS_TEXT,
      }),
    )
  }

  parts.push('</svg>')
  return parts.join('')
}

// ---------------------------------------------------------------------------
// 跨年级对比：完成率 / 得分率 / 师阅率均值（三系列分组柱，全部百分比）
// ---------------------------------------------------------------------------
/** @param {Array} grades 数据模型中的 grades（每个含 gradeName、summary、subjects） */
export function gradeCompareSvg(grades = []) {
  const list = (Array.isArray(grades) ? grades : []).filter(
    (g) => g && typeof g === 'object',
  )
  const chartTitle = '各年级完成率、得分率与师阅率均值对比'
  if (!list.length) return emptySvg(chartTitle, '本周期暂无年级数据')

  const rows = list.map((g, i) => {
    const summary = g.summary && typeof g.summary === 'object' ? g.summary : {}
    const subs = (Array.isArray(g.subjects) ? g.subjects : []).filter((s) => s && !s.missing)
    const finish = isNum(summary.finishPercent)
      ? summary.finishPercent
      : meanOf(subs.map((s) => s.finishPercent))
    const correct = isNum(summary.correctPercent)
      ? summary.correctPercent
      : meanOf(subs.map((s) => s.correctPercent))
    const mark = isNum(summary.teacherMarkPercentAvg)
      ? summary.teacherMarkPercentAvg
      : meanOf(subs.map((s) => s.teacherMarkPercent))
    const name =
      gradeLabel(g) || String(g.levelName || '').trim() || `年级 ${i + 1}`
    return { name, finish, correct, mark }
  })

  const values = [
    rows.map((r) => r.finish),
    rows.map((r) => r.correct),
    rows.map((r) => r.mark),
  ]
  if (!values.some((arr) => arr.some(isNum))) return emptySvg(chartTitle, '本周期暂无年级数据')

  return barComboSvg({
    title: chartTitle,
    categories: rows.map((r) => r.name),
    bars: [
      { name: '完成率（%）', color: SERIES_COLORS.blue, values: values[0] },
      { name: '得分率（%）', color: SERIES_COLORS.green, values: values[1] },
      { name: '师阅率均值（%）', color: SERIES_COLORS.orange, values: values[2] },
    ],
    width: 720,
    height: 260,
    leftMax: 100,
    hint: '本周期暂无年级数据',
  })
}

export default {
  SERIES_COLORS,
  barComboSvg,
  subjectOverviewSvg,
  teacherOverviewSvg,
  gradeCompareSvg,
}

// ===========================================================================
// 简报用图表（brief）：彩色系列色、11px 以上字号、整数百分比
// ---------------------------------------------------------------------------
// 与上面「正式报告」的黑白学术图区别：简报用于网页速览与横版速读，
// 按 SPEC-report §3 的固定系列色（#2f6fed / #22a06b / #e8833a / #8b5cf6）着色，
// 白底、宽 720，数值一律整数百分比（如 88%），缺失学科显示「—」而不是 0。
// 只复用既有排版设施（svgOpen / textEl / emptySvg / fitText / textWidth / labelLayout），
// 不改动任何既有函数与导出。
// ===========================================================================
const BRIEF = Object.freeze({
  finish: '#2f6fed', // 完成率
  mark: '#22a06b', // 师阅率 / 阅卷率
  axis: '#1a1a1a',
  grid: '#e8f0f5',
  text: '#1a1a1a',
  muted: '#8a94a6',
  missing: '#c7ccd6',
  missingText: '#8a94a6',
  white: '#ffffff',
  legendFont: 11,
  labelFont: 11,
  tickFont: 11,
})

/** 整数百分比文本：「88%」（非数字返回「—」）；不做四舍五入的二次修正，直接取整。 */
const briefPct = (v) => (isNum(v) ? `${Math.round(clamp(v, 0, 100))}%` : '—')

/** 简报图例的色块标记（圆角小方块，与柱色一致）。 */
function briefSwatch(x, yTop, color, size = 10) {
  return (
    `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${size}" height="${size}" rx="2" ry="2"` +
    ` fill="${color}"/>`
  )
}

/**
 * 简报图例：返回色块、文字与总宽；由调用方决定靠左还是靠右。
 * items: [{ name, color }]
 */
function briefLegendParts(items, x, baseline) {
  const parts = []
  const gap = 20
  const size = 10
  let cx = x
  for (const it of items) {
    parts.push(briefSwatch(cx, baseline - size + 0.5, it.color, size))
    parts.push(
      textEl(cx + size + 6, baseline, it.name, {
        fontSize: BRIEF.legendFont,
        fill: BRIEF.text,
      }),
    )
    cx += size + 6 + textWidth(it.name, BRIEF.legendFont) + gap
  }
  return { parts, width: cx - x - gap }
}

/**
 * 简报用「教师完成率 / 阅卷率」对比图（分组柱）。
 * 取任务量前 10 位教师（任务量降序，同量按姓名），分组柱：完成率（#2f6fed）、师阅率（#22a06b）；
 * y 轴 0~100%，顶部图例，柱顶整数百分比，x 轴姓名标签（去「老师」后缀、过长用 fitText 截断）。
 * @param {object} grade sample-model.json 的 grades[i]
 */
export function briefTeacherSvg(grade = {}) {
  const gradeName = gradeLabel(grade)
  const teachers = (Array.isArray(grade?.teachers) ? grade.teachers : [])
    .filter((t) => t && String(t.name || '').trim() && (isNum(t.taskCount) ? t.taskCount > 0 : false))
    .slice()
    .sort(
      (a, b) =>
        (b.taskCount || 0) - (a.taskCount || 0) ||
        String(a.name).localeCompare(String(b.name), 'zh'),
    )
    .slice(0, 10)

  const chartTitle = `${gradeName}教师完成率与阅卷率对比（任务量前 10 位）`
  if (!teachers.length) return emptySvg('教师完成率与阅卷率', '本周期无教师任务数据')

  // 有教师但没有百分比时仍出图：柱不画、标签显示「—」，与学科图口径一致（不编造 0%）

  const width = 720
  const height = 280
  const n = teachers.length

  // ---- 顶部：标题一行，图例在标题下方左侧 ----
  const pad = 16
  const titleText = fitText(chartTitle, width - pad * 2, TITLE_FONT)
  const parts = [svgOpen(width, height, chartTitle)]
  parts.push(textEl(pad, 22, titleText, { fontSize: TITLE_FONT, fill: BRIEF.text, weight: 'bold' }))
  const legend = briefLegendParts(
    [
      { name: '完成率', color: BRIEF.finish },
      { name: '阅卷率', color: BRIEF.mark },
    ],
    pad,
    46,
  )
  parts.push(...legend.parts)

  // 绘图区顶部留出 TOP_PAD 的「标签净空」：100% 的柱顶标签才放得下，不会顶到图例行
  const plotTop = 82
  const plotBottom = height - 34
  const ml = 48
  const mr = 20
  const plotLeft = ml
  const plotRight = width - mr
  const plotW = plotRight - plotLeft
  const innerTop = plotTop
  const innerH = plotBottom - plotTop
  const yOf = (v) => innerTop + innerH * (1 - clamp(v, 0, 100) / 100)

  // ---- 网格 + 左轴刻度（0~100%，5 格） ----
  for (let i = 0; i <= 5; i++) {
    const v = i * 20
    const y = yOf(v)
    parts.push(
      `<line x1="${plotLeft}" y1="${y.toFixed(1)}" x2="${plotRight}" y2="${y.toFixed(1)}"` +
        ` stroke="${i === 0 ? BRIEF.axis : BRIEF.grid}" stroke-width="${i === 0 ? 1 : 0.6}"/>`,
    )
    parts.push(
      textEl(plotLeft - 7, y + 3.8, `${v}%`, {
        anchor: 'end',
        fontSize: BRIEF.tickFont,
        fill: BRIEF.muted,
      }),
    )
  }

  // ---- 分组柱 ----
  const slot = plotW / n
  const gap = 3
  const groupW = Math.min(slot * 0.6, 44)
  const barW = (groupW - gap) / 2
  const series = [
    { key: 'finishPercent', color: BRIEF.finish },
    { key: 'teacherMarkPercent', color: BRIEF.mark },
  ]

  const layout = createLabelLayout()
  // 图例/标题占位：柱顶标签不得压到图例文字（100% 标签会被顶到图例行上方，必须避让）
  const headerObstacles = [
    { x0: pad, x1: pad + titleText ? pad + textWidth(titleText, TITLE_FONT) : pad, y0: 6, y1: 28 },
    { x0: pad, x1: pad + legend.width, y0: 34, y1: 50 },
  ]
  // 上界取到标题下沿（40）：100% 柱顶标签要能抬到绘图区之上，否则会被「越界代价」压回、
  // 与同组另一柱的标签糊在一起。下界到零基线，标签不会掉进 X 轴姓名行。
  const labelBounds = { x0: plotLeft - 2, x1: plotRight + 2, y0: 40, y1: plotBottom - 2 }
  const labelReqs = []

  for (let i = 0; i < n; i++) {
    const t = teachers[i]
    const cx = plotLeft + slot * (i + 0.5)
    for (let si = 0; si < series.length; si++) {
      const s = series[si]
      const v = t[s.key]
      const x = cx - groupW / 2 + si * (barW + gap)
      if (!isNum(v)) {
        // 无百分比：不画柱（不编造 0%），零基线上留一条极浅占位条，标签显示「—」
        parts.push(
          `<rect x="${x.toFixed(1)}" y="${(plotBottom - 1.5).toFixed(1)}" width="${barW.toFixed(1)}"` +
            ` height="1.5" fill="${BRIEF.missing}" fill-opacity="0.35"/>`,
        )
        labelReqs.push({ cx: x + barW / 2, top: plotBottom, text: '—', value: -1, si, i })
        continue
      }
      const y = yOf(v)
      const barH = Math.max(0, plotBottom - y)
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1.5, barH).toFixed(1)}"` +
          ` fill="${s.color}"/>`,
      )
      labelReqs.push({ cx: x + barW / 2, top: y, text: briefPct(v), value: v, si, i })
    }
    // x 轴姓名：去「老师」后缀，再按槽宽截断
    const short = String(t.name || '')
      .trim()
      .replace(/老师$/, '')
    const label = fitText(short, Math.max(18, slot - 6), BRIEF.labelFont)
    parts.push(
      textEl(cx, plotBottom + 18, label, {
        anchor: 'middle',
        fontSize: BRIEF.labelFont,
        fill: BRIEF.text,
      }),
    )
  }

  // ---- 柱顶整数百分比 ----
  // 每根柱的标签都指向「自己的柱顶」，两列（完成率/阅卷率）按各自柱心居中；
  // 同一组里两列离得近（约 6px 间隙）时，「完成率」标签自动抬高一档，与「阅卷率」标签错开高度，
  // 保证每根柱顶都恰好有一个数字，不会两串字糊成一片。
  // 本图不铺白色底块（plate=false）：数字本来就落在柱子上方的留白里，白块反而会切断网格线。
  const LABEL_TEXT_H = 13 // 11px 字号的行高（留 1px 余量）
  const placedBoxes = []
  const sorted = labelReqs.slice().sort((a, b) => a.i - b.i || b.value - a.value)
  for (const req of sorted) {
    const peers = labelReqs.filter((o) => o.i === req.i && o.si !== req.si)
    // 本列柱心与同组另一列柱心的水平距离
    const dx = peers.length ? Math.abs(peers[0].cx - req.cx) : 999
    // 两列太近：完成率（si=0）让一手，抬高一档；两柱同高时也只抬一档（同高两柱本身会并排显示）
    // 同组两列柱心间距不足「两个数字并排」的宽度时，两列标签各自向外让开 3px（柱仍指得准），
    // 让不下才把「完成率」抬高一档错开高度。
    const need = textWidth(req.text, BRIEF.labelFont) / 2 + 4
    const crowded = dx < need * 2
    const shift = crowded && req.si === 0 ? LABEL_TEXT_H : 0
    const nx = crowded ? req.cx + (req.si === 0 ? -3 : 3) : req.cx
    // 只走两档：先「贴柱顶（必要时抬一档）」，实在不行才「再抬一档」；
    // 两档都放不下时回到贴柱顶的位置——宁可紧贴一根柱，也不让数字漂到图例或别的柱子上方。
    const makeBox = (yy) => layout.boxOf(nx, yy, 'middle', req.text, BRIEF.labelFont)
    const clash = (box) =>
      placedBoxes.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0) ||
      hitsAny(box, headerObstacles)
    const wanted = req.top - 5 - shift
    let chosen = wanted
    for (const yy of [wanted, wanted - LABEL_TEXT_H]) {
      const box = makeBox(yy)
      if (box.y0 < labelBounds.y0) continue
      if (!clash(box)) {
        chosen = yy
        break
      }
    }
    placedBoxes.push(makeBox(chosen))
    parts.push(
      textEl(nx, chosen, req.text, {
        anchor: 'middle',
        fontSize: BRIEF.labelFont,
        fill: req.value < 0 ? BRIEF.missingText : BRIEF.text,
      }),
    )
  }

  parts.push('</svg>')
  return parts.join('')
}

/**
 * 简报用「学科完成率 / 阅卷率」对比图（横向分组条形图）。
 * 全部学科按模型顺序（含 missing 的）逐行列出；缺失学科两条均显示「—」而非 0。
 * 宽 720、高度按学科数自适应（9 科约 300）。
 * @param {object} grade sample-model.json 的 grades[i]
 */
export function briefSubjectSvg(grade = {}) {
  const gradeName = gradeLabel(grade)
  const subjects = (Array.isArray(grade?.subjects) ? grade.subjects : []).filter(
    (s) => s && String(s.short || s.name || '').trim(),
  )
  const chartTitle = `${gradeName}各学科完成率与阅卷率对比`
  if (!subjects.length) return emptySvg('学科完成率与阅卷率', '本周期无学科任务数据')

  const width = 720
  const pad = 16
  const headerH = 76 // 标题 22 + 图例 46 + 与首行的间距
  const rowH = 26
  const mb = 34 // 轴刻度行
  const height = Math.round(headerH + subjects.length * rowH + mb)

  const nameW = 62
  const ml = pad + nameW + 10
  const valueW = 96 // 右侧「完成率 / 阅卷率」数值列
  const plotLeft = ml
  const plotRight = width - pad - valueW
  const plotW = plotRight - plotLeft
  const xOf = (v) => plotLeft + (clamp(v, 0, 100) / 100) * plotW

  const parts = [svgOpen(width, height, chartTitle)]
  const titleText = fitText(chartTitle, width - pad * 2, TITLE_FONT)
  parts.push(textEl(pad, 22, titleText, { fontSize: TITLE_FONT, fill: BRIEF.text, weight: 'bold' }))
  const legend = briefLegendParts(
    [
      { name: '完成率', color: BRIEF.finish },
      { name: '阅卷率', color: BRIEF.mark },
    ],
    pad,
    46,
  )
  parts.push(...legend.parts)

  const plotTop = headerH - 8
  const plotBottom = plotTop + subjects.length * rowH
  const barH = 7
  const yOfRow = (i) => plotTop + rowH * (i + 0.5)

  // ---- 纵向网格（0/25/50/75/100%） ----
  for (let i = 0; i <= 4; i++) {
    const x = xOf(i * 25)
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${plotTop}" x2="${x.toFixed(1)}" y2="${plotBottom}"` +
        ` stroke="${i === 0 ? BRIEF.axis : BRIEF.grid}" stroke-width="${i === 0 ? 1 : 0.6}"/>`,
    )
  }
  // 底部百分比刻度
  for (let i = 0; i <= 4; i++) {
    parts.push(
      textEl(xOf(i * 25), plotBottom + 16, `${i * 25}%`, {
        anchor: 'middle',
        fontSize: BRIEF.tickFont,
        fill: BRIEF.muted,
      }),
    )
  }

  const series = [
    { key: 'finishPercent', color: BRIEF.finish, y: -5 },
    { key: 'teacherMarkPercent', color: BRIEF.mark, y: 4 },
  ]

  for (let i = 0; i < subjects.length; i++) {
    const s = subjects[i]
    const missing = Boolean(s.missing)
    const yCenter = yOfRow(i)
    const name = fitText(String(s.short || s.name), nameW, BRIEF.labelFont)
    parts.push(
      textEl(plotLeft - 8, yCenter + 4, name, {
        anchor: 'end',
        fontSize: BRIEF.labelFont,
        fill: missing ? BRIEF.missingText : BRIEF.text,
      }),
    )

    const valueParts = []
    for (let si = 0; si < series.length; si++) {
      const sr = series[si]
      const v = missing ? null : s[sr.key]
      const by = yCenter + sr.y - barH / 2
      if (isNum(v)) {
        const w = Math.max(1.5, (clamp(v, 0, 100) / 100) * plotW)
        parts.push(
          `<rect x="${plotLeft}" y="${by.toFixed(1)}" width="${w.toFixed(1)}" height="${barH}" fill="${sr.color}"/>`,
        )
      } else {
        // 缺失学科：整行画一条极浅的「无数据」占位条（非 0 长度），数值显示「—」
        parts.push(
          `<rect x="${plotLeft}" y="${by.toFixed(1)}" width="${(plotW * 0.02).toFixed(1)}" height="${barH}"` +
            ` fill="${BRIEF.missing}" fill-opacity="0.35"/>`,
        )
      }
      if (si > 0) valueParts.push(`<tspan fill="${BRIEF.muted}"> / </tspan>`)
      const txt = briefPct(v)
      valueParts.push(
        `<tspan fill="${isNum(v) ? BRIEF.text : BRIEF.missingText}" font-weight="bold">${escapeXml(txt)}</tspan>`,
      )
    }
    // 右侧统一数值列：完成率 / 阅卷率，与学科名同一基线
    parts.push(
      `<text x="${(plotRight + 10).toFixed(1)}" y="${(yCenter + 4).toFixed(1)}" font-size="${BRIEF.labelFont}"` +
        ` font-family="${FONT_FAMILY}">${valueParts.join('')}</text>`,
    )
  }

  // 右侧数值列的表头小字（说明两列含义），放在图例同行右端
  parts.push(
    textEl(width - pad, 46, '完成率 / 阅卷率', {
      anchor: 'end',
      fontSize: BRIEF.legendFont,
      fill: BRIEF.muted,
    }),
  )

  parts.push('</svg>')
  return parts.join('')
}
