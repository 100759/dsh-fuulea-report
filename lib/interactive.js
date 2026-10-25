// 交互式 HTML 报告（单文件、零依赖、纯字符串拼装）。
//
// 对外只导出一个函数：
//   buildInteractiveHtml(model, opts) → 完整 HTML 字符串
//
// 约定（与 SPEC-brief.md §3 / §4 / §5 一致）：
//   - 单文件：内联 <style> + 内联 <script>；数据以
//     <script id="fuulea-data" type="application/json">…</script> 内联，
//     内容里的 "</" 一律写成 "<\/"，避免提前闭合 script 标签；
//   - 零外部资源：不出现指向 http(s) 的 src= / href=，不用 fetch / XMLHttpRequest /
//     import() / new Image，也不用 url(#id) 这类引用式填充（图表全部直接画元素，便于截图与打印）；
//   - 所有图表都是本文件内自绘的内联 SVG（bar / groupBar / line / radar / scatter / stack），
//     容器 width:100%，SVG 用 viewBox + preserveAspectRatio="xMinYMin meet"，
//     字号折算进 viewBox 并按容器宽度等比缩放，窄屏不横向溢出；
//   - 页面中文、浅色为默认，prefers-color-scheme: dark 时切换深色；
//     @media print 隐藏全部交互控件、整页铺开。
//
// 数据口径以 SPEC-report.md §1 为准：率一律是数值（83.6 表示 83.6%），缺失为 null；
// 展示保留 1 位小数（100 显示 100.0%），整数不加千分位，
// 观看时长直接用模型里的 durationText（已是「时:分」）。

/* ------------------------------------------------------------------ 基础工具 */

/** XML / HTML 转义（数据里都是中文校名人名，仍需防 & < >） */
const esc = (s) =>
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

/** 数值判空：只认有限数字，其余（null / undefined / NaN / 空串 / 布尔）一律视为缺失 */
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 百分比：1 位小数 + %，缺失「—」 */
const pct = (v) => {
  const x = n(v)
  return x === null ? '—' : `${x.toFixed(1)}%`
}

/** 整数（四舍五入、不加千分位），缺失「—」 */
const int = (v) => {
  const x = n(v)
  return x === null ? '—' : String(Math.round(x))
}

/** 一般数值：1 位小数，缺失「—」 */
const dec1 = (v) => {
  const x = n(v)
  return x === null ? '—' : x.toFixed(1)
}

/** 安全取对象/数组字段 */
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [])

/** 忽略缺失的平均值 */
const mean = (list) => {
  const nums = list.map(n).filter((x) => x !== null)
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
}

/** 加权平均：值或权缺失的条目跳过 */
const weightedMean = (rows) => {
  let sum = 0
  let weight = 0
  for (const row of rows) {
    const v = n(row.value)
    const w = n(row.weight)
    if (v === null || w === null || w <= 0) continue
    sum += v * w
    weight += w
  }
  return weight > 0 ? sum / weight : null
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

/** 粗略文本宽度（中文按 1em、ASCII 按 0.56em，宁大勿小），用于避让与截断 */
const textW = (text, size) => {
  let w = 0
  for (const ch of String(text)) w += /[\x00-\xff]/.test(ch) ? size * 0.56 : size
  return w
}

/** 截断到 maxWidth 内（超出加省略号） */
const fit = (text, maxWidth, size) => {
  const raw = String(text == null ? '' : text)
  if (textW(raw, size) <= maxWidth) return raw
  let out = ''
  for (const ch of raw) {
    if (textW(`${out}${ch}…`, size) > maxWidth) break
    out += ch
  }
  return out ? `${out}…` : '…'
}

/** 坐标轴「好看」上限：返回 { max, step } */
const niceScale = (maxValue, targetTicks = 5) => {
  const max = Math.max(1, n(maxValue) ?? 1)
  const rough = max / Math.max(2, targetTicks)
  const mag = 10 ** Math.floor(Math.log10(rough))
  const norm = rough / mag
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10
  const step = mult * mag
  return { max: Math.ceil((max * 1.02) / step) * step, step }
}

const tickText = (value, step) => {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
  return String(Number(value.toFixed(decimals)))
}

/** 仅保留数字字符的 id 片段（用于 class 名与 data-*） */
const slug = (s) => String(s == null ? '' : s).replace(/[^0-9a-zA-Z]/g, '')

/* ------------------------------------------------------------------ 配色与字体 */

// 浅色主题（默认）：
//   - 文字/结构色沿用正式版报告的「黑 + 灰色阶」基调（#1a1a1a / #8c8c8c / #e8e8e8），
//     保证与 Word / PDF 正式报告观感一致；
//   - 图表需要一个可区分的系列色板，取低饱和的深色系，深色模式下整体提亮（见深色变量）。
const LIGHT = {
  bg: '#f4f5f7',
  panel: '#ffffff',
  line: '#e4e6ea',
  grid: '#eef0f3',
  axis: '#1a1a1a',
  text: '#1a1a1a',
  text2: '#5b6068',
  muted: '#8c8c8c',
  accent: '#2f6fed',
  accentSoft: '#e8f0fe',
  series: ['#2f6fed', '#22a06b', '#e8833a', '#8b5cf6', '#0e9aa7', '#c2410c', '#6b7280', '#a16207', '#be185d'],
  good: '#22a06b',
  warn: '#e8833a',
  bad: '#d64545',
}

const DARK = {
  bg: '#15161a',
  panel: '#1d1f24',
  line: '#2c2f36',
  grid: '#26292f',
  axis: '#c9ced6',
  text: '#e6e8eb',
  text2: '#a6acb6',
  muted: '#7f8794',
  accent: '#6ea0ff',
  accentSoft: '#24304a',
  series: ['#6ea0ff', '#4fd08f', '#f0a35e', '#b18cff', '#3fc7d4', '#e07a5f', '#9aa3ae', '#d4b106', '#e56fa8'],
  good: '#4fd08f',
  warn: '#f0a35e',
  bad: '#ef7b7b',
}

// 页面字体：与正式版 HTML 同族（中文黑体族优先，无则回落系统无衬线）+ Times New Roman
const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Heiti SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif'

// 学科配色（每个学科在雷达 / 条形 / 散点 / 堆叠里同色）：按学科序号取色板，
// 不依赖数据顺序，九个学科正好一次用完色板。
const SUBJECT_SLOT = {
  语文: 0, 数学: 1, 英语: 2, 物理: 3, 化学: 4, 生物: 5, 历史: 6, 地理: 7, 政治: 8,
}
const colorOfSubject = (short, index, palette) => {
  const slot = SUBJECT_SLOT[short]
  const i = typeof slot === 'number' ? slot : index
  return palette.series[i % palette.series.length]
}

/* ------------------------------------------------------------------ SVG 基础 */

// 注：作为 HTML 片段内联的 <svg> 处在 HTML 命名空间解析规则下，浏览器会自动按 SVG 命名空间处理，
// 不需要 xmlns 声明；不加声明反而让整份文档里不出现任何 http(s) 文本，便于「零外部资源」自检。
const SVG_NS = ''

/** 开一个内联 SVG：viewBox + 等比缩放，宽度交给容器（100%），不设固定 width 属性 */
const svgOpen = (w, h, label) =>
  `<svg ${SVG_NS} viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="${esc(
    label,
  )}" class="chart-svg" style="width:100%;height:auto;display:block">`

/** 文本元素：纯填充，不做描边光晕（描边文字在 PDF 里会变成不可检索字形） */
const text = (x, y, str, o = {}) => {
  const {
    size = 13,
    fill = 'currentColor',
    anchor = 'start',
    weight = 400,
    opacity = null,
    extra = '',
  } = o
  return (
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" text-anchor="${anchor}"` +
    ` fill="${fill}"${weight !== 400 ? ` font-weight="${weight}"` : ''}` +
    `${opacity === null ? '' : ` opacity="${opacity}"`}${extra}>${esc(str)}</text>`
  )
}

const rect = (x, y, w, h, o = {}) => {
  const { fill = 'none', rx = 0, opacity = null, extra = '' } = o
  return (
    `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}"` +
    ` height="${Math.max(0, h).toFixed(1)}"${rx ? ` rx="${rx}"` : ''} fill="${fill}"` +
    `${opacity === null ? '' : ` opacity="${opacity}"`}${extra}/>`
  )
}

const line = (x1, y1, x2, y2, o = {}) => {
  const { stroke = '#999', width = 1, dash = '', opacity = null, extra = '' } = o
  return (
    `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"` +
    ` stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}` +
    `${opacity === null ? '' : ` opacity="${opacity}"`}${extra}/>`
  )
}

/** 顶层分组：承载可切换显隐的系列 */
const group = (seriesKey, inner, extra = '') =>
  `<g data-series="${esc(seriesKey)}"${extra}>${inner}</g>`

/** 空图占位（数据缺失时也不白屏） */
const emptySvg = (theme, label, hint = '本周期暂无数据') =>
  [
    svgOpen(720, 180, label),
    rect(0, 0, 720, 180, { fill: theme.panel }),
    text(360, 92, hint, { size: 15, fill: theme.muted, anchor: 'middle' }),
    '</svg>',
  ].join('')

/* ------------------------------------------------------------------ 图表：横向条形 */

/**
 * 横向条形图（可在前端重新排序、切换指标）。
 * spec = {
 *   title, rows: [{ label, value, meta }], ticks, hint,
 *   valueFmt: 'pct' | 'int', color: (row) => color, xMax, unit,
 * }
 * 返回 SVG 字符串（行上带 data-row 与 title 属性，前端据此实现 hover tooltip 与重排）。
 */
function barSvg(theme, spec) {
  const rows = (spec.rows || []).filter((r) => r && n(r.value) !== null)
  if (!rows.length) return emptySvg(theme, spec.title, spec.hint || '本周期暂无数据')
  const fmt = spec.valueFmt === 'pct' ? pct : int
  const W = 720
  const padL = 92
  const padR = 76
  const top = 26
  const rowH = 30
  const H = top + rows.length * rowH + 34
  const plotW = W - padL - padR
  const maxVal = Math.max(...rows.map((r) => n(r.value) ?? 0), n(spec.xMax) ?? 0)
  const scale = n(spec.xMax) !== null ? { max: spec.xMax, step: spec.xMax / 5 } : niceScale(maxVal, 5)
  const x = (v) => padL + (clamp(v, 0, scale.max) / scale.max) * plotW
  const parts = [svgOpen(W, H, spec.title), rect(0, 0, W, H, { fill: theme.panel })]

  // 纵向网格 + 刻度
  for (let t = 0; t <= scale.max + 1e-9; t += scale.step) {
    const px = x(t)
    parts.push(line(px, top - 6, px, H - 26, { stroke: theme.grid, width: 1 }))
    parts.push(text(px, H - 8, tickText(t, scale.step), { size: 12, fill: theme.muted, anchor: 'middle' }))
  }

  rows.forEach((row, i) => {
    const cy = top + i * rowH + rowH / 2
    const barH = Math.min(20, rowH - 10)
    const color = spec.color ? spec.color(row) : theme.series[0]
    const value = n(row.value) ?? 0
    const w = Math.max(value > 0 ? 1.5 : 0, padL + (value / scale.max) * plotW - padL)
    const tip = [
      row.meta?.title || row.label,
      row.meta?.lines || `${spec.unit || ''}${fmt(row.value)}`,
    ].filter(Boolean)
    parts.push(
      group(
        row.meta?.series || 'default',
        rect(padL, cy - barH / 2, w, barH, { fill: color, rx: 3, opacity: 0.9 }) +
          text(padL - 10, cy + 4.5, fit(row.label, padL - 16, 13), {
            size: 13,
            fill: theme.text,
            anchor: 'end',
          }) +
          text(Math.min(padL + w + 8, W - 6), cy + 4.5, `${spec.unit || ''}${fmt(row.value)}`, {
            size: 12.5,
            fill: theme.text2,
            anchor: 'start',
            extra: ' data-val="1"',
          }),
        ` data-row="${i}" data-label="${esc(row.label)}" data-value="${esc(fmt(row.value))}"` +
          ` data-tip="${esc(tip.join('\n'))}"`,
      ),
    )
  })
  parts.push('</svg>')
  return parts.join('')
}

/* ------------------------------------------------------------------ 图表：分组柱 + 折线（三届对比） */

/**
 * 分组柱 + 折线，直接由 HTML（不是 SVG）工具条切换指标；本次实现为「每个指标一张 SVG，
 * 由前端按当前指标显示其中一张」，避免折线与其他指标混在同一个坐标系里。
 * spec = { title, categories: [名], bars: [{name, values, color}], line: {name, values, color} }
 */
function compareSvg(theme, spec) {
  const cats = spec.categories || []
  const bars = spec.bars || []
  if (!cats.length || !bars.length) return emptySvg(theme, spec.title, '本周期暂无年级数据')
  const W = 720
  const H = 300
  const padL = 56
  const padR = 24
  const top = 58
  const bottom = 40
  const plotW = W - padL - padR
  const plotH = H - top - bottom
  // 数量（次/道/人次）与比率（%）量纲不同：由 spec.fmt 指定本图统一格式，
  // 不能一律按百分比格式化，否则会出现「204.0%」这类把计数当比率的错误。
  const fmtKind = spec.fmt === 'pct' ? 'pct' : 'int'
  const fmtVal = (v) => (fmtKind === 'pct' ? pct(v) : int(v))
  const maxVal = Math.max(fmtKind === 'pct' ? 100 : 0, ...bars.flatMap((b) => b.values.map((v) => n(v) ?? 0)))
  const scale = niceScale(maxVal, 5)
  const y = (v) => top + plotH - (clamp(v, 0, scale.max) / scale.max) * plotH
  const bandW = plotW / Math.max(1, cats.length)
  const innerW = Math.min(bandW * 0.62, 96)
  const barW = innerW / Math.max(1, bars.length)
  const parts = [svgOpen(W, H, spec.title), rect(0, 0, W, H, { fill: theme.panel })]

  // 横向网格与刻度
  for (let t = 0; t <= scale.max + 1e-9; t += scale.step) {
    const py = y(t)
    parts.push(line(padL, py, W - padR, py, { stroke: theme.grid, width: 1 }))
    parts.push(
      text(padL - 8, py + 4, `${tickText(t, scale.step)}${fmtKind === 'pct' ? '%' : ''}`, {
        size: 12,
        fill: theme.muted,
        anchor: 'end',
      }),
    )
  }

  // 图例（图例项带 data-series，点击可在前端显隐）
  const legend = bars
    .map((b, i) => ({ name: b.name, color: b.color, key: `bar${i}` }))
    .concat(spec.line ? [{ name: spec.line.name, color: spec.line.color, key: 'line', isLine: true }] : [])
  let lx = padL
  const legendItems = legend.map((item) => {
    const w = textW(item.name, 12.5) + 30
    const seg = item.isLine
      ? line(lx, 22, lx + 14, 22, { stroke: item.color, width: 2.4 }) +
        `<circle cx="${(lx + 7).toFixed(1)}" cy="22" r="3.6" fill="${item.color}"/>`
      : rect(lx, 15, 14, 12, { fill: item.color, rx: 2 })
    lx += w
    return { html: seg + text(lx - w + 20, 26, item.name, { size: 12.5, fill: theme.text2 }), w }
  })
  // 图例放不下就折到第二行（最多两行；本页最多 4 项，不会溢出的同时保证不越界）
  const legendHtml = legendItems
    .map((item, i) => {
      const offset = legendItems.slice(0, i).reduce((s, it) => s + it.w, 0)
      if (padL + offset + item.w > W - padR) {
        // 第二行：整体下移 18px
        return `<g transform="translate(0,18)">${item.html}</g>`
      }
      return item.html
    })
    .join('')
  parts.push(`<g class="legend">${legendHtml}</g>`)

  bars.forEach((b, bi) => {
    const inner = cats
      .map((cat, ci) => {
        const v = n(b.values[ci])
        const bx = padL + ci * bandW + (bandW - innerW) / 2 + bi * barW
        const color = b.color || theme.series[bi % theme.series.length]
        const by = v === null ? y(0) : y(v)
        const tip = `${cat}\n${b.name}：${fmtVal(v)}`
        return (
          rect(bx, by, Math.max(1, barW - 3), Math.max(0, y(0) - by), {
            fill: color,
            rx: 3,
            opacity: 0.92,
            extra: ` data-ci="${ci}" data-tip="${esc(tip)}"`,
          }) + (v === null ? '' : text(bx + Math.max(1, barW - 3) / 2, by - 6, fmtVal(v), {
            size: 11.5,
            fill: theme.text2,
            anchor: 'middle',
          }))
        )
      })
      .join('')
    parts.push(group(`bar${bi}`, inner))
  })

  if (spec.line) {
    const inner = cats
      .map((cat, ci) => {
        const v = n(spec.line.values[ci])
        if (v === null) return ''
        const cx = padL + ci * bandW + bandW / 2
        return `<circle cx="${cx.toFixed(1)}" cy="${y(v).toFixed(1)}" r="4.6" fill="${theme.panel}" stroke="${
          spec.line.color
        }" stroke-width="2.6" data-ci="${ci}" data-tip="${esc(`${cat}\n${spec.line.name}：${fmtVal(v)}`)}"/>`
      })
      .join('')
    const pts = cats
      .map((cat, ci) => {
        const v = n(spec.line.values[ci])
        return v === null ? null : [padL + ci * bandW + bandW / 2, y(v)]
      })
      .filter(Boolean)
    const path = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`)
      .join(' ')
    parts.push(
      group(
        'line',
        `<path d="${path}" fill="none" stroke="${spec.line.color}" stroke-width="2.4" stroke-linejoin="round"/>${inner}`,
      ),
    )
  }

  // 分类名（放不下则截断，不横向溢出）
  cats.forEach((cat, ci) => {
    parts.push(
      text(padL + ci * bandW + bandW / 2, H - 14, fit(cat, bandW - 8, 13), {
        size: 13,
        fill: theme.text,
        anchor: 'middle',
      }),
    )
  })
  parts.push('</svg>')
  return parts.join('')
}

/* ------------------------------------------------------------------ 图表：雷达 */

/**
 * 雷达图：axes = [{ key, label, best? }]，series = [{ name, color, values: {key: 0..100}, tip }]
 * 归一化口径：每个指标按本年级内该指标的「max(最大值, 60)」缩放，
 * 因此不同量纲（率 / 人次占比）能放在同一张图上；轴标签直接标注实际数值。
 */
function radarSvg(theme, spec) {
  const axes = spec.axes || []
  const series = (spec.series || []).filter((s) => s && s.values)
  if (!axes.length || !series.length) return emptySvg(theme, spec.title, spec.hint || '本周期暂无数据')
  const W = 720
  const H = 430
  const cx = W / 2
  const cy = H / 2 + 8
  const R = Math.min(150, H / 2 - 74)
  const angle = (i) => (Math.PI * 2 * i) / axes.length - Math.PI / 2
  const pt = (i, r) => [cx + Math.cos(angle(i)) * r, cy + Math.sin(angle(i)) * r]

  // 每个轴的归一化上限
  const axisMax = axes.map((ax) => {
    const vals = series.map((s) => n(s.values[ax.key])).filter((v) => v !== null)
    const m = vals.length ? Math.max(...vals) : 0
    return Math.max(ax.best ? 60 : 50, m * 1.18 || 50)
  })

  const parts = [svgOpen(W, H, spec.title), rect(0, 0, W, H, { fill: theme.panel })]
  // 网格：4 圈
  for (let k = 1; k <= 4; k += 1) {
    const r = (R * k) / 4
    const pts = axes.map((_, i) => pt(i, r).map((v) => v.toFixed(1)).join(',')).join(' ')
    parts.push(`<polygon points="${pts}" fill="none" stroke="${theme.grid}" stroke-width="1"/>`)
  }
  axes.forEach((_, i) => {
    const [x2, y2] = pt(i, R)
    parts.push(line(cx, cy, x2, y2, { stroke: theme.grid, width: 1 }))
  })

  // 各系列
  series.forEach((s) => {
    const pts = axes.map((ax, i) => {
      const v = n(s.values[ax.key])
      const r = v === null ? 0 : (clamp(v, 0, axisMax[i]) / axisMax[i]) * R
      return pt(i, r)
    })
    const poly = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
    const dots = pts
      .map((p, i) => {
        const v = n(s.values[axes[i].key])
        return (
          `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.4" fill="${s.color}" stroke="${theme.panel}" stroke-width="1.4"` +
          ` data-tip="${esc(s.tip ? s.tip(axes[i].key) : `${s.name}·${axes[i].label}`)}"/>`
        )
      })
      .join('')
    parts.push(
      group(
        s.key || s.name,
        `<polygon points="${poly}" fill="${s.color}" fill-opacity="0.12" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>${dots}`,
      ),
    )
  })

  // 轴标签：沿半径外侧放，按象限对齐，避免重叠
  axes.forEach((ax, i) => {
    const ang = angle(i)
    const [lx, ly] = pt(i, R + 24)
    const cos = Math.cos(ang)
    const sin = Math.sin(ang)
    const anchor = Math.abs(cos) < 0.25 ? 'middle' : cos > 0 ? 'start' : 'end'
    const dx = anchor === 'start' ? 2 : anchor === 'end' ? -2 : 0
    const dy = sin < -0.5 ? -4 : sin > 0.5 ? 12 : 5
    parts.push(
      text(lx + dx, ly + dy, fit(ax.label, 150, 13), { size: 13, fill: theme.text, anchor }),
    )
  })

  // 图例（最多 4 行，放在左上角，与雷达不重叠）
  const items = series.slice(0, 4)
  items.forEach((s, i) => {
    const ly = 20 + i * 20
    parts.push(
      group(
        s.key || s.name,
        line(20, ly - 4, 38, ly - 4, { stroke: s.color, width: 2.6 }) +
          `<circle cx="29" cy="${ly - 4}" r="3.2" fill="${s.color}"/>` +
          text(44, ly, fit(s.name, 140, 12.5), { size: 12.5, fill: theme.text2 }),
      ),
    )
  })
  parts.push('</svg>')
  return parts.join('')
}

/* ------------------------------------------------------------------ 图表：散点 */

/**
 * 教师散点图：X = 完成率，Y = 师阅率，半径 = 任务量，颜色 = 学科。
 * 缺失任一坐标的教师不画（但表里仍有），避免把「阅卷率 0」误读。
 */
function scatterSvg(theme, spec) {
  const W = 720
  // 纵向分层（DOM getBBox 实测校准，改高度前先算这三条基线）：
  //   刻度文字  top+plotH+18
  //   x 轴标题  top+plotH+42
  //   图例一行  top+plotH+74
  // bottom=104 给这三层留够空间，H 随之放大；否则图例会压住「完成率」标题。
  const H = 484
  const padL = 58
  const padR = 24
  const top = 26
  const bottom = 104
  const plotW = W - padL - padR
  const plotH = H - top - bottom
  const points = (spec.points || []).filter((p) => n(p.x) !== null && n(p.y) !== null)
  if (!points.length) return emptySvg(theme, spec.title, spec.hint || '本周期暂无教师数据')
  const maxTask = Math.max(1, ...points.map((p) => n(p.task) ?? 0))
  const x0 = 40 // X 轴最小 40%，避免所有点挤在右侧
  // 坐标映射命名避开单字母 x / y / r：它们与 text(x, y, ...) / rect(x, y, ...) 的形参同名，
  // 在本函数作用域里只要再出现一个同名局部（哪怕只是回调参数），映射函数就会指向
  // 未初始化的局部绑定（TDZ），pxOf(...) 抛错或返回 undefined，整张图静默变空、且不报可读错误。
  const pxOf = (v) => padL + ((clamp(v, x0, 100) - x0) / (100 - x0)) * plotW
  const pyOf = (v) => top + plotH - (clamp(v, 0, 100) / 100) * plotH
  const rOf = (taskCount) => 3.4 + Math.sqrt((n(taskCount) ?? 0) / maxTask) * 12
  const parts = [svgOpen(W, H, spec.title), rect(0, 0, W, H, { fill: theme.panel })]

  // 网格
  for (let v = x0; v <= 100; v += 20) {
    parts.push(line(pxOf(v), top, pxOf(v), top + plotH, { stroke: theme.grid, width: 1 }))
    parts.push(text(pxOf(v), top + plotH + 18, `${v}%`, { size: 12, fill: theme.muted, anchor: 'middle' }))
  }
  for (let v = 0; v <= 100; v += 20) {
    parts.push(line(padL, pyOf(v), W - padR, pyOf(v), { stroke: theme.grid, width: 1 }))
    parts.push(text(padL - 8, pyOf(v) + 4, `${v}%`, { size: 12, fill: theme.muted, anchor: 'end' }))
  }
  // 参考线：完成率 80%、师阅率 80%（与简报的「双高」口径一致）
  parts.push(line(pxOf(80), top, pxOf(80), top + plotH, { stroke: theme.muted, width: 1, dash: '5 4', opacity: 0.6 }))
  parts.push(line(padL, pyOf(80), W - padR, pyOf(80), { stroke: theme.muted, width: 1, dash: '5 4', opacity: 0.6 }))

  // 轴标题（Y 轴标题用独立的 <text>，不能用本文件的 text()：其首参会遮蔽坐标映射函数 x）
  const yTitlePos = (top + plotH / 2).toFixed(1)
  parts.push(
    text(padL + plotW / 2, top + plotH + 42, '完成率', { size: 13, fill: theme.text2, anchor: 'middle' }),
    `<text x="24" y="${yTitlePos}" font-size="13" text-anchor="middle" fill="${
      theme.text2
    }" transform="rotate(-90 24 ${yTitlePos})">师阅率</text>`,
  )

  // 点：半径大的先画，避免小点被压住
  const sorted = [...points].sort((a, b) => (n(b.task) ?? 0) - (n(a.task) ?? 0))
  const inner = sorted
    .map((p) => {
      const fill = p.color
      const tip = p.tip || `${p.name}\n${p.subject}`
      return (
        `<circle cx="${pxOf(p.x).toFixed(1)}" cy="${pyOf(p.y).toFixed(1)}" r="${rOf(p.task).toFixed(1)}" fill="${fill}"` +
        ` fill-opacity="0.72" stroke="${fill}" stroke-width="1.4" data-tip="${esc(tip)}"/>`
      )
    })
    .join('')
  parts.push(group('pts', inner))

  // 图例：学科（点击可显隐对应系列），单行横向排布。
  // 注意：回调参数不能用单字母 s / i —— 本文件其余图表函数里 x / y / r 是坐标映射，
  // 这里用 si / subj / legendX 明确命名，避免与形参同名造成遮蔽与 TDZ。
  const subs = []
  for (const p of points) if (!subs.includes(p.subject)) subs.push(p.subject)
  const perItem = (plotW - 10) / Math.max(1, Math.min(subs.length, 9))
  subs.slice(0, 9).forEach((subj, si2) => {
    const sample = points.find((p) => p.subject === subj)
    const legendX = padL + si2 * perItem
    const legendY = top + plotH + 74
    parts.push(
      group(
        `sub-${si2}`,
        `<circle cx="${(legendX + 5).toFixed(1)}" cy="${legendY - 4}" r="5" fill="${sample.color}" fill-opacity="0.8"/>` +
          text(fit(subj, perItem - 16, 12), legendX + 14, legendY, { size: 12, fill: theme.text2 }),
      ),
    )
  })
  parts.push(
    text(W - padR, top - 8, `圆点面积按任务量，最大 ${int(maxTask)} 次`, {
      size: 11.5,
      fill: theme.muted,
      anchor: 'end',
    }),
  )
  parts.push('</svg>')
  return parts.join('')
}

/* ------------------------------------------------------------------ 图表：堆叠条形 */

/**
 * 堆叠条形：各学科一行，三段（自学人次 / 自学题量 / 观看人次）。
 * 三段量纲差很多（人次几十~几百，题量几百~几千），按「各段在全体学科中的最大值为 100」
 * 分别归一化后叠成 0~300 的比例条，图例里标注各自的真实最大值，条目里读的是真实数值。
 */
function stackSvg(theme, spec) {
  const rows = spec.rows || []
  const segs = spec.segments || []
  if (!rows.length || !segs.length) return emptySvg(theme, spec.title, spec.hint || '本周期暂无数据')
  const W = 720
  const padL = 96
  const padR = 22
  const top = 48
  const rowH = 34
  const H = top + rows.length * rowH + 16
  const plotW = W - padL - padR
  const maxOf = segs.map((seg) => Math.max(1, ...rows.map((r) => n(r[seg.key]) ?? 0)))
  const total = segs.length * 100
  // 同上：映射函数不叫 x / y，避免与 text(x, y, ...) 的形参同名
  const pxOf = (v) => padL + (clamp(v, 0, total) / total) * plotW
  const parts = [svgOpen(W, H, spec.title), rect(0, 0, W, H, { fill: theme.panel })]

  // 图例
  let lx = padL
  segs.forEach((seg, i) => {
    const name = `${seg.name}（最大 ${int(maxOf[i])}）`
    parts.push(
      group(
        seg.key,
        rect(lx, 16, 13, 12, { fill: seg.color, rx: 2 }) +
          text(lx + 18, 26.5, name, { size: 12, fill: theme.text2 }),
      ),
    )
    lx += textW(name, 12) + 46
  })

  rows.forEach((row, ri) => {
    const cy = top + ri * rowH + rowH / 2
    let acc = 0
    const segHtml = segs
      .map((seg, si) => {
        const v = n(row[seg.key]) ?? 0
        const unit = (v / maxOf[si]) * 100
        const x0 = pxOf(acc)
        const w = pxOf(acc + unit) - pxOf(acc)
        acc += unit
        const tip = `${row.label}\n${seg.name}：${int(v)}`
        const label = v > 0 && w > 34 ? text(x0 + w / 2, cy + 4.5, int(v), {
          size: 11.5,
          fill: '#ffffff',
          anchor: 'middle',
          weight: 500,
        }) : ''
        return (
          `<rect x="${x0.toFixed(1)}" y="${(cy - 10).toFixed(1)}" width="${Math.max(0, w).toFixed(
            1,
          )}" height="20" fill="${seg.color}" rx="2" data-tip="${esc(tip)}"/>` + label
        )
      })
      .join('')
    parts.push(
      group(
        `row${ri}`,
        text(padL - 10, cy + 4.5, fit(row.label, padL - 18, 13), {
          size: 13,
          fill: theme.text,
          anchor: 'end',
        }) + segHtml,
      ),
    )
  })
  parts.push('</svg>')
  return parts.join('')
}

/* ------------------------------------------------------------------ 数据整理 */

/** 年级标签：「2024级」→「2024级」；没有年级名时兜底 */
const gradeNameOf = (grade, i) => {
  const name = String(grade?.gradeName ?? '').trim()
  if (name) return name
  return `年级${i + 1}`
}

/** 从 grade 计算展示用的派生指标（全部走 n() 判空） */
function subjectRow(s, index) {
  const short = String(s.short ?? s.name ?? `学科${index + 1}`).trim()
  const booklet = obj(s.booklet)
  const target = obj(s.target)
  const self = obj(s.self)
  const watch = obj(s.watch)
  const resource = obj(s.resource)
  const taskCount = n(s.taskCount)
  return {
    key: `${slug(short) || index}-${index}`,
    label: short,
    name: String(s.name ?? short),
    missing: s.missing === true || taskCount === null,
    taskCount,
    exerciseTaskCount: n(s.exerciseTaskCount),
    questionCount: n(s.questionCount),
    avgQuestionsByStudent: n(s.avgQuestionsByStudent),
    finishPercent: n(s.finishPercent),
    markPercent: n(s.markPercent),
    teacherMarkPercent: n(s.teacherMarkPercent),
    correctPercent: n(s.correctPercent),
    bookletTaskCount: n(booklet.taskCount),
    bookletCoverPercent: n(booklet.coverPercent),
    targetTaskCount: n(target.taskCount),
    targetQuestionCount: n(target.questionCount),
    selfPersonCount: n(self.personCount),
    selfQuestionCount: n(self.questionCount),
    selfSharePercent: n(self.sharePercent),
    watchCount: n(watch.count),
    watchDurationText: watch.durationText ? String(watch.durationText) : '—',
    resourceTag: n(resource.tag),
    resourceAudio: n(resource.audio),
    resourceVideo: n(resource.video),
  }
}

/** 教师行 */
function teacherRow(t, index, colorOf) {
  const short = String(t.short ?? t.subject ?? '').trim()
  const booklet = obj(t.booklet)
  const target = obj(t.target)
  return {
    key: `t${index}`,
    name: String(t.name ?? `教师${index + 1}`).trim(),
    subject: short || '未标注',
    taskCount: n(t.taskCount),
    questionCount: n(t.questionCount),
    finishPercent: n(t.finishPercent),
    teacherMarkPercent: n(t.teacherMarkPercent),
    markPercent: n(t.markPercent),
    correctPercent: n(t.correctPercent),
    teacherMarkQuestionCount: n(t.teacherMarkQuestionCount),
    bookletTaskCount: n(booklet.taskCount),
    bookletCoverPercent: n(booklet.coverPercent),
    targetTaskCount: n(target.taskCount),
    color: colorOf(short),
  }
}

/** 年级汇总（summary 缺字段时按学科加权兜底，不编造） */
function gradeSummary(grade, subjects) {
  const summary = obj(grade?.summary)
  const active = subjects.filter((s) => !s.missing && (s.taskCount ?? 0) > 0)
  const taskCount =
    n(summary.taskCount) ??
    (active.length ? active.reduce((a, s) => a + (s.taskCount ?? 0), 0) : null)
  const questionCount =
    n(summary.questionCount) ??
    (active.length ? active.reduce((a, s) => a + (s.questionCount ?? 0), 0) : null)
  const days = n(summary.days) ?? null
  const classCount = n(grade?.classCount)
  const finishPercent =
    n(summary.finishPercent) ??
    weightedMean(active.map((s) => ({ value: s.finishPercent, weight: s.taskCount })))
  const correctPercent =
    n(summary.correctPercent) ??
    weightedMean(active.map((s) => ({ value: s.correctPercent, weight: s.questionCount })))
  const markPercent =
    // 师阅率均值：优先 summary.teacherMarkPercentAvg（SPEC-brief §2.1），
    // 其次按任务量对学科 teacherMarkPercent 加权，最后按学科简单平均
    n(summary.teacherMarkPercentAvg) ??
    n(summary.markPercent) ??
    weightedMean(active.map((s) => ({ value: s.teacherMarkPercent, weight: s.taskCount }))) ??
    mean(active.map((s) => s.teacherMarkPercent))
  const dailyClassTask =
    n(summary.dailyClassTask) ??
    (taskCount !== null && days && classCount ? taskCount / days / classCount : null)
  const dailyClassQuestion =
    n(summary.dailyClassQuestion) ??
    (questionCount !== null && days && classCount ? questionCount / days / classCount : null)
  const selfPersonCount =
    n(summary.selfPersonCount) ?? n(grade?.selfStudy?.totalPersonCount) ?? null
  const watchCount = n(summary.watchCount) ?? n(grade?.watch?.count) ?? null
  const watchDurationText = obj(grade?.watch).durationText
    ? String(grade.watch.durationText)
    : obj(summary).watchDurationText
      ? String(summary.watchDurationText)
      : '—'
  return {
    days,
    classCount,
    taskCount,
    questionCount,
    dailyTask: n(summary.dailyTask),
    dailyClassTask,
    dailyClassQuestion,
    finishPercent,
    correctPercent,
    markPercent,
    selfPersonCount,
    watchCount,
    watchDurationText,
  }
}

/** 把 model 整理成前端直接可用（且已判空）的结构 */
function normalizeModel(model, theme) {
  const src = obj(model)
  const meta = obj(src.meta)
  const totals = obj(src.totals)
  const gradesSrc = arr(src.grades)
  const colorOf = (short, index) => colorOfSubject(short, index ?? 0, theme)

  const grades = gradesSrc.map((g, gi) => {
    const subjects = arr(g.subjects).map((s, si) => subjectRow(s, si))
    const teachers = arr(g.teachers).map((t, ti) => teacherRow(t, ti, colorOf))
    const summary = gradeSummary(g, subjects)
    // 学科均分（表里用「均值」行/参考，不写进模型）
    const active = subjects.filter((s) => !s.missing && (s.taskCount ?? 0) > 0)
    return {
      key: `g${gi}`,
      name: gradeNameOf(g, gi),
      levelName: String(g.levelName ?? '').trim(),
      classCount: n(g.classCount),
      adminClasses: Array.isArray(g.adminClasses) ? g.adminClasses.map(String) : [],
      summary,
      subjects,
      teachers,
      means: {
        taskCount: mean(active.map((s) => s.taskCount)),
        questionCount: mean(active.map((s) => s.questionCount)),
        finishPercent: mean(active.map((s) => s.finishPercent)),
        teacherMarkPercent: mean(active.map((s) => s.teacherMarkPercent)),
        markPercent: mean(active.map((s) => s.markPercent)),
        correctPercent: mean(active.map((s) => s.correctPercent)),
      },
      missingSubjects: subjects.filter((s) => s.missing).map((s) => s.label),
    }
  })

  return {
    school: String(meta.siteTitle ?? meta.schoolAlias ?? '学校').trim() || '学校',
    from: String(meta.from ?? '').trim(),
    to: String(meta.to ?? '').trim(),
    days: n(meta.days) ?? n(totals.days),
    generatedAt: String(meta.generatedAt ?? '').trim(),
    totals: {
      gradeCount: n(totals.gradeCount) ?? grades.length,
      taskCount: n(totals.taskCount),
      questionCount: n(totals.questionCount),
      dailyTask: n(totals.dailyTask),
      dailyQuestion: n(totals.dailyQuestion),
      selfPersonCount: n(totals.selfPersonCount),
      watchCount: n(totals.watchCount),
      watchDurationText: totals.watchDurationText ? String(totals.watchDurationText) : '—',
    },
    warnings: arr(src.warnings).length ? src.warnings.map(String) : [],
    grades,
  }
}

/* ------------------------------------------------------------------ 格式化辅助 */

/** ISO 时间 → 本地「YYYY-MM-DD HH:MM」；解析不了就原样返回（不编造时间） */
function fmtDateTime(iso) {
  const raw = String(iso || '').trim()
  if (!raw) return '—'
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const ratio = (a, b) => (n(a) !== null && n(b) ? (n(a) / n(b)) * 100 : null)

/* 指标定义：学科排序条形图、学科明细表、教师排行共用 */
const SUBJECT_METRICS = [
  { key: 'taskCount', label: '任务量', fmt: 'int', unit: '', better: 'desc' },
  { key: 'exerciseTaskCount', label: '习题任务量', fmt: 'int', unit: '', better: 'desc' },
  { key: 'questionCount', label: '习题量', fmt: 'int', unit: '', better: 'desc' },
  { key: 'avgQuestionsByStudent', label: '生均题量', fmt: 'num1', unit: '道', better: 'desc' },
  { key: 'finishPercent', label: '完成率', fmt: 'pct', unit: '', better: 'desc' },
  { key: 'teacherMarkPercent', label: '师阅率', fmt: 'pct', unit: '', better: 'desc' },
  { key: 'markPercent', label: '阅卷率', fmt: 'pct', unit: '', better: 'desc' },
  { key: 'correctPercent', label: '得分率', fmt: 'pct', unit: '', better: 'desc' },
]

const BAR_METRICS = ['taskCount', 'questionCount', 'finishPercent', 'teacherMarkPercent', 'correctPercent']
const TEACHER_BAR_METRICS = ['taskCount', 'finishPercent', 'teacherMarkPercent']
const metricDef = (key) => SUBJECT_METRICS.find((m) => m.key === key) || SUBJECT_METRICS[0]
const fmtBy = (fmt, v) => (fmt === 'pct' ? pct(v) : fmt === 'num1' ? dec1(v) : int(v))

/* ------------------------------------------------------------------ 各区块 HTML */

/** 顶部标题 + KPI */
function headerHtml(m) {
  const period = m.from && m.to ? `${m.from} 至 ${m.to}` : '统计区间未提供'
  const days = n(m.days)
  const span = days === null ? '' : `（${days} 天）`
  return `<header class="hero">
  <div class="hero-badge">交互式数据报告</div>
  <h1 class="hero-title">${esc(m.school)}</h1>
  <p class="hero-sub">${esc(period)}${esc(span)}</p>
  <p class="hero-meta">统计区间 ${esc(m.from || '—')} — ${esc(m.to || '—')}　·　${esc(
    int(m.totals.gradeCount),
  )} 个年级　·　生成时间 ${esc(fmtDateTime(m.generatedAt))}</p>
</header>`
}

function kpiHtml(m) {
  const gs = m.grades
  // 年级级指标：有 totals 时优先 totals；否则按年级汇总加权（不编造）
  const sumTask = gs.length ? gs.reduce((a, g) => a + (g.summary.taskCount ?? 0), 0) : null
  const sumQ = gs.length ? gs.reduce((a, g) => a + (g.summary.questionCount ?? 0), 0) : null
  const sumClass = gs.length ? gs.reduce((a, g) => a + (g.classCount ?? 0), 0) : null
  const days = n(m.days)
  const taskTotal = n(m.totals.taskCount) ?? (gs.length ? sumTask : null)
  const qTotal = n(m.totals.questionCount) ?? (gs.length ? sumQ : null)
  // 日均班均任务 = 任务总量 ÷ 天数 ÷ 三届行政班数合计。
  // 注意不能用 totals.dailyTask 再除一遍天数——dailyTask 本身就是「每日」口径，
  // 二次相除会把 4.25 压成 0.3（曾出现该错误）。
  const dailyClassTask =
    taskTotal !== null && days && sumClass
      ? taskTotal / days / sumClass
      : mean(gs.map((g) => g.summary.dailyClassTask))
  const finishAvg = weightedMean(gs.map((g) => ({ value: g.summary.finishPercent, weight: g.summary.taskCount })))
  const markAvg = weightedMean(gs.map((g) => ({ value: g.summary.markPercent, weight: g.summary.taskCount })))
  const correctAvg = weightedMean(
    gs.map((g) => ({ value: g.summary.correctPercent, weight: g.summary.questionCount })),
  )
  const selfTotal = n(m.totals.selfPersonCount) ?? (gs.length ? gs.reduce((a, g) => a + (g.summary.selfPersonCount ?? 0), 0) : null)
  const watchTotal = n(m.totals.watchCount) ?? (gs.length ? gs.reduce((a, g) => a + (g.summary.watchCount ?? 0), 0) : null)

  const cards = [
    { label: '任务量', value: int(taskTotal), unit: '次', note: `${int(m.totals.gradeCount)} 个年级合计` },
    { label: '日均班均任务', value: dec1(dailyClassTask), unit: '次', note: '三届任务量 ÷ 天数 ÷ 行政班数合计' },
    { label: '习题量', value: int(qTotal), unit: '道', note: '三个年级合计' },
    { label: '完成率', value: pct(finishAvg), unit: '', note: '按任务量加权' },
    { label: '阅卷率', value: pct(markAvg), unit: '', note: '按任务量加权（师阅率均值）' },
    { label: '得分率', value: pct(correctAvg), unit: '', note: '按习题量加权' },
    { label: '自学人次', value: int(selfTotal), unit: '人次', note: '学生自主学习' },
    {
      label: '视频观看',
      value: int(watchTotal),
      unit: '人次',
      note: m.totals.watchDurationText && m.totals.watchDurationText !== '—' ? `累计 ${esc(m.totals.watchDurationText)}（时:分）` : '观看时长未提供',
    },
  ]
  return `<section id="kpis" class="kpis" aria-label="关键指标">
${cards
  .map(
    (c) => `  <div class="kpi">
    <div class="kpi-label">${esc(c.label)}</div>
    <div class="kpi-value">${c.value}${c.unit ? `<span class="kpi-unit">${esc(c.unit)}</span>` : ''}</div>
    <div class="kpi-note">${c.note}</div>
  </div>`,
  )
  .join('\n')}
</section>`
}

/** 年级 Tab 工具条 */
function tabsHtml(m) {
  return `<nav id="tabs" class="tabs" role="tablist" aria-label="年级切换">
${m.grades
  .map(
    (g, i) =>
      `  <button type="button" class="tab${i === 0 ? ' is-active' : ''}" role="tab" data-grade="${i}" aria-selected="${
        i === 0 ? 'true' : 'false'
      }">${esc(g.name)}${g.levelName ? `<span class="tab-sub">${esc(g.levelName)}</span>` : ''}</button>`,
  )
  .join('\n')}
</nav>`
}

/** ① 三届对比 */
function compareCardHtml(m, theme) {
  const cats = m.grades.map((g) => g.name)
  const get = (fn) => m.grades.map((g) => fn(g.summary, g))
  const taskChart = compareSvg(theme, {
    title: '三届任务量与习题量对比',
    fmt: 'int',
    categories: cats,
    bars: [
      { name: '任务量（次）', values: get((s) => s.taskCount), color: theme.series[0] },
      { name: '习题量（道）', values: get((s) => s.questionCount), color: theme.series[1] },
    ],
  })
  const rateChart = compareSvg(theme, {
    title: '三届完成率、得分率与师阅率均值对比',
    fmt: 'pct',
    categories: cats,
    bars: [
      { name: '完成率', values: get((s) => s.finishPercent), color: theme.series[0] },
      { name: '得分率', values: get((s) => s.correctPercent), color: theme.series[1] },
      { name: '师阅率均值', values: get((s) => s.markPercent), color: theme.series[2] },
    ],
  })
  const scaleChart = compareSvg(theme, {
    title: '三届自学与视频观看规模对比',
    fmt: 'int',
    categories: cats,
    bars: [
      { name: '自学人次（人次）', values: get((s) => s.selfPersonCount), color: theme.series[2] },
      { name: '视频观看人次（人次）', values: get((s) => s.watchCount), color: theme.series[3] },
    ],
  })
  return `<section id="sec-compare" class="card">
  <div class="card-head">
    <h2>① 三届对比</h2>
    <div class="chart-ctrl" data-ctrl="compare">
      <label class="ctl-label" for="compare-metric">对比指标</label>
      <select id="compare-metric" class="ctl-select" data-role="compare-metric">
        <option value="scale" selected>任务量与习题量</option>
        <option value="rate">完成率 / 得分率 / 师阅率</option>
        <option value="self">自学与观看人次</option>
      </select>
    </div>
  </div>
  <div class="chart-wrap" id="chart-compare" data-active="scale">
    <div class="chart-slot" data-slot="scale">${taskChart}</div>
    <div class="chart-slot" data-slot="rate" hidden>${rateChart}</div>
    <div class="chart-slot" data-slot="self" hidden>${scaleChart}</div>
  </div>
  <p class="chart-note">柱为各年级合计值，折线（如有）为同一指标的趋势线；点击图例可单独隐藏某个系列，鼠标悬停查看具体数值。</p>
</section>`
}

/** ② 学科雷达 */
function radarCardHtml(m, theme) {
  const options = m.grades
    .flatMap((g) => g.subjects.map((s) => ({ label: s.label, key: `${g.key}-${s.key}` })))
  // 以第一个年级的学科顺序作为多选项（跨年级按学科名去重）
  const seen = []
  for (const o of options) if (!seen.includes(o.label)) seen.push(o.label)
  const picks = seen
    .map(
      (label, i) =>
        `<label class="pick"><input type="checkbox" data-role="radar-pick" value="${esc(label)}"${
          i < 4 ? ' checked' : ''
        }><span class="pick-dot" style="background:${colorOfSubject(label, i, theme)}"></span>${esc(label)}</label>`,
    )
    .join('\n      ')
  return `<section id="sec-radar" class="card">
  <div class="card-head">
    <h2>② 学科画像（雷达）</h2>
    <div class="chart-ctrl">
      <button type="button" class="ctl-btn" data-role="radar-all">全选</button>
      <button type="button" class="ctl-btn" data-role="radar-none">清空</button>
    </div>
  </div>
  <div class="picks" id="radar-picks" aria-label="选择学科">
      ${picks}
  </div>
  <div class="chart-wrap" id="chart-radar"></div>
  <p class="chart-note">五轴：完成率、师阅率、得分率、重练覆盖率、自学人次占比（%）。各轴按本年级最大值归一，轴旁数值为实际值；最多同时对比 4 个学科。</p>
</section>`
}

/** ③ 学科排序条形 */
function subjectBarCardHtml(theme) {
  return `<section id="sec-subject-bar" class="card">
  <div class="card-head">
    <h2>③ 学科排序</h2>
    <div class="chart-ctrl">
      <label class="ctl-label" for="subject-metric">排序指标</label>
      <select id="subject-metric" class="ctl-select" data-role="subject-metric">
        ${BAR_METRICS.map(
          (key) => `<option value="${key}"${key === 'taskCount' ? ' selected' : ''}>${esc(metricDef(key).label)}</option>`,
        ).join('')}
      </select>
      <button type="button" class="ctl-btn" data-role="subject-order" data-order="desc">降序</button>
    </div>
  </div>
  <div id="top-subject-bar"></div>
  <div class="chart-wrap" id="chart-subject-bar"></div>
  <p class="chart-note">按当前指标排序；缺失数据的学科显示「—」，只参与表格，不进入条形图。</p>
</section>`
}

/** ④ 学科明细表 */
function subjectTableCardHtml(theme) {
  const cols = [
    { key: 'label', label: '学科', align: 'left' },
    { key: 'taskCount', label: '任务', align: 'right' },
    { key: 'questionCount', label: '习题', align: 'right' },
    { key: 'avgQuestionsByStudent', label: '生均题量', align: 'right', fmt: 'num1' },
    { key: 'finishPercent', label: '完成率', align: 'right' },
    { key: 'teacherMarkPercent', label: '师阅率', align: 'right' },
    { key: 'markPercent', label: '阅卷率', align: 'right' },
    { key: 'correctPercent', label: '得分率', align: 'right' },
    { key: 'bookletTaskCount', label: '重练任务', align: 'right' },
    { key: 'bookletCoverPercent', label: '覆盖率', align: 'right' },
    { key: 'targetTaskCount', label: '靶向任务', align: 'right' },
    { key: 'watchCount', label: '观看人次', align: 'right' },
  ]
  return `<section id="sec-subject-table" class="card">
  <div class="card-head">
    <h2>④ 学科明细</h2>
    <div class="chart-ctrl"><span class="ctl-hint">点击表头排序，再次点击切换升降序</span></div>
  </div>
  <div class="table-scroll">
    <table id="subject-table" class="data-table">
      <thead><tr>${cols
        .map(
          (c) =>
            `<th data-sort="${c.key}" class="${c.align === 'right' ? 'num' : ''}" scope="col" tabindex="0" role="button">${esc(
              c.label,
            )}<span class="sort-arrow"></span></th>`,
        )
        .join('')}</tr></thead>
      <tbody><tr><td colspan="${cols.length}" class="table-empty">本周期暂无数据</td></tr></tbody>
    </table>
  </div>
  <p class="chart-note">列口径与正式报告一致；缺失（含整科未布置作业）显示「—」，该行以浅色标注。</p>
</section>`
}

/** ⑤⑥ 教师画像 */
function teacherCardHtml(theme) {
  return `<section id="sec-teacher" class="card">
  <div class="card-head">
    <h2>⑤ 教师散点（完成率 × 师阅率）</h2>
    <div class="chart-ctrl"><span class="ctl-hint">半径 = 任务量，颜色 = 学科</span></div>
  </div>
  <div class="chart-wrap" id="chart-scatter"></div>
  <p class="chart-note">右上象限（完成率、师阅率均 ≥ 80%）为使用较全面的教师；悬停查看姓名与指标。</p>

  <div class="sub-head">
    <h2>⑥ 教师排行</h2>
    <div class="chart-ctrl">
      <label class="ctl-label" for="teacher-metric">排行指标</label>
      <select id="teacher-metric" class="ctl-select" data-role="teacher-metric">
        ${TEACHER_BAR_METRICS.map(
          (key) => `<option value="${key}"${key === 'taskCount' ? ' selected' : ''}>${esc(metricDef(key).label)}</option>`,
        ).join('')}
      </select>
      <label class="ctl-label" for="teacher-top">显示</label>
      <select id="teacher-top" class="ctl-select" data-role="teacher-top">
        <option value="10" selected>前 10 位</option>
        <option value="all">全部</option>
      </select>
    </div>
  </div>
  <div class="chart-wrap" id="chart-teacher-bar"></div>
</section>`
}

/** ⑦ 自学与观看 */
function selfCardHtml(theme, m) {
  return `<section id="sec-self" class="card">
  <div class="card-head">
    <h2>⑦ 自学与视频观看</h2>
    <div class="chart-ctrl"><span class="ctl-hint">三段按各自最大值归一后堆叠</span></div>
  </div>
  <div class="chart-wrap" id="chart-self-stack"></div>
  <div class="self-summary" id="self-summary"></div>
</section>`
}

/* ------------------------------------------------------------------ 内联样式 */

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: ${LIGHT.bg};
  --panel: ${LIGHT.panel};
  --line: ${LIGHT.line};
  --grid: ${LIGHT.grid};
  --text: ${LIGHT.text};
  --text2: ${LIGHT.text2};
  --muted: ${LIGHT.muted};
  --accent: ${LIGHT.accent};
  --accent-soft: ${LIGHT.accentSoft};
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 8px 24px rgba(16, 24, 40, 0.06);
  --radius: 14px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: ${DARK.bg};
    --panel: ${DARK.panel};
    --line: ${DARK.line};
    --grid: ${DARK.grid};
    --text: ${DARK.text};
    --text2: ${DARK.text2};
    --muted: ${DARK.muted};
    --accent: ${DARK.accent};
    --accent-soft: ${DARK.accentSoft};
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.35);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 0 0 56px;
  background: var(--bg);
  color: var(--text);
  font-family: ${FONT_STACK};
  font-size: 15px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}
.page { width: 100%; max-width: 1180px; margin: 0 auto; padding: 0 20px; }
h1, h2, h3 { margin: 0; font-weight: 600; letter-spacing: 0.01em; }
p { margin: 0; }
.num-text { font-variant-numeric: tabular-nums; }

/* 顶部 */
.hero { padding: 40px 0 22px; }
.hero-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12.5px;
  letter-spacing: 0.08em;
}
.hero-title { margin-top: 12px; font-size: 30px; line-height: 1.3; }
.hero-sub { margin-top: 6px; font-size: 17px; color: var(--text2); font-variant-numeric: tabular-nums; }
.hero-meta { margin-top: 8px; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }

/* KPI */
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 22px; }
.kpi {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 16px 18px;
  min-width: 0;
}
.kpi-label { font-size: 13px; color: var(--text2); }
.kpi-value {
  margin-top: 6px;
  font-size: 27px;
  line-height: 1.2;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.kpi-unit { margin-left: 4px; font-size: 13px; font-weight: 400; color: var(--muted); }
.kpi-note { margin-top: 6px; font-size: 12px; color: var(--muted); }

/* Tab */
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px;
  margin: 0 0 18px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 999px;
  box-shadow: var(--shadow);
  position: sticky;
  top: 8px;
  z-index: 20;
}
.tab {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text2);
  font: inherit;
  font-size: 14.5px;
  padding: 8px 20px;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.tab:hover { background: var(--accent-soft); color: var(--accent); }
.tab.is-active { background: var(--accent); color: #fff; }
.tab-sub { margin-left: 6px; font-size: 12px; opacity: 0.8; }

/* 卡片 */
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 20px 22px 18px;
  margin-bottom: 18px;
  min-width: 0;
  overflow: hidden;
}
.card-head {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.card h2 { font-size: 17px; }
.sub-head {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  align-items: center;
  justify-content: space-between;
  margin: 22px 0 10px;
  padding-top: 18px;
  border-top: 1px dashed var(--line);
}
.chart-ctrl { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.ctl-label { font-size: 13px; color: var(--muted); }
.ctl-hint { font-size: 12.5px; color: var(--muted); }
.ctl-select {
  appearance: none;
  font: inherit;
  font-size: 13.5px;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 5px 28px 5px 10px;
  cursor: pointer;
}
.ctl-select:focus-visible, .ctl-btn:focus-visible, .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ctl-btn {
  font: inherit;
  font-size: 13.5px;
  color: var(--text2);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 5px 12px;
  cursor: pointer;
}
.ctl-btn:hover { border-color: var(--accent); color: var(--accent); }
.ctl-btn.is-active { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }

/* 图 */
.chart-wrap { width: 100%; min-width: 0; }
.chart-wrap svg { display: block; }
.chart-note { margin-top: 10px; font-size: 12.5px; color: var(--muted); }
.chart-empty {
  padding: 44px 16px;
  text-align: center;
  color: var(--muted);
  font-size: 14px;
  border: 1px dashed var(--line);
  border-radius: 10px;
}
.legend text, .chart-svg text { user-select: none; }
.chart-svg [data-row], .chart-svg circle[data-tip], .chart-svg rect[data-tip] { cursor: default; }
.chart-svg .legend [data-series] { cursor: pointer; }
.chart-svg .is-hidden { opacity: 0.22; }

/* 学科多选 */
.picks { display: flex; flex-wrap: wrap; gap: 8px 14px; margin-bottom: 10px; }
.pick { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; color: var(--text2); cursor: pointer; }
.pick input { accent-color: var(--accent); margin: 0; }
.pick-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }

/* 表格 */
.table-scroll { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13.5px; min-width: 760px; }
.data-table th, .data-table td { padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.data-table th {
  position: relative;
  text-align: left;
  font-weight: 600;
  font-size: 13px;
  color: var(--text2);
  cursor: pointer;
  user-select: none;
  background: transparent;
}
.data-table th.num, .data-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.data-table th:hover { color: var(--accent); }
.data-table th[data-dir="desc"] .sort-arrow::after { content: "▼"; font-size: 9px; margin-left: 4px; color: var(--accent); }
.data-table th[data-dir="asc"] .sort-arrow::after { content: "▲"; font-size: 9px; margin-left: 4px; color: var(--accent); }
.data-table tbody tr:hover { background: var(--accent-soft); }
.data-table tbody tr.row-missing td { color: var(--muted); }
.data-table td.dash { color: var(--muted); }
.data-table tr.mean-row td { font-weight: 600; border-top: 1px solid var(--line); color: var(--text2); }
.table-empty { text-align: center; color: var(--muted); padding: 28px 0; }

/* 自学小结 */
.self-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.self-item { border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; min-width: 0; }
.self-item .k { font-size: 12.5px; color: var(--muted); }
.self-item .v { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; }

/* 空状态 */
.empty-state {
  padding: 60px 20px;
  text-align: center;
  color: var(--muted);
  font-size: 15px;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  margin-bottom: 18px;
}

/* tooltip */
#tooltip {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 999;
  max-width: 260px;
  padding: 8px 11px;
  border-radius: 8px;
  background: rgba(26, 28, 33, 0.94);
  color: #fff;
  font-size: 12.5px;
  line-height: 1.55;
  white-space: pre-line;
  pointer-events: none;
  opacity: 0;
  transform: translate3d(0, 0, 0);
  transition: opacity 0.12s ease;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
}
#tooltip.is-on { opacity: 1; }
#tooltip .tip-title { font-weight: 600; }

/* 打印：隐藏所有交互控件，卡片铺开、不分页截断 */
@media print {
  @page { size: A4; margin: 12mm 10mm; }
  :root { color-scheme: light; }
  body { background: #fff; color: #000; padding: 0; font-size: 11pt; }
  .page { max-width: none; padding: 0; }
  .tabs, .chart-ctrl, .ctl-select, .ctl-btn, .ctl-label, .ctl-hint, .picks, #tooltip,
  .hero-badge, .chart-note { display: none !important; }
  .card, .kpi {
    box-shadow: none;
    border: 0.5pt solid #999;
    border-radius: 0;
    break-inside: avoid;
    page-break-inside: avoid;
    background: #fff;
  }
  .kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .card { margin-bottom: 8mm; padding: 8px 10px; }
  .card h2 { font-size: 13pt; }
  .chart-wrap svg { width: 100% !important; }
  .hero { padding: 0 0 12px; }
  .hero-title { font-size: 20pt; }
  [hidden] { display: none !important; }
  .table-scroll { overflow: visible; }
  .data-table { min-width: 0; }
  .data-table th, .data-table td { white-space: normal; }
  .chart-svg .is-hidden { opacity: 1; }
}

/* 窄屏 */
@media (max-width: 1024px) {
  .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .page { padding: 0 12px; }
  .hero { padding: 26px 0 16px; }
  .hero-title { font-size: 23px; }
  .hero-sub { font-size: 15px; }
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .kpi { padding: 12px 14px; }
  .kpi-value { font-size: 22px; }
  .self-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .card { padding: 16px 14px; }
  .tabs { top: 0; border-radius: 12px; }
  .tab { padding: 7px 14px; font-size: 13.5px; }
}
`

/* ------------------------------------------------------------------ 内联脚本 */

// 注意：这段脚本放在模板字符串里，脚本内部唯一以 </ 开头的习惯写法（HTML 字符串结束标签）
// 必须写成 "<\\/" / "<" + "/script>" 的形式，否则会提前闭合当前的 <script>。
const SCRIPT = String.raw`
(function () {
  'use strict';
  var root = document.getElementById('app');
  if (!root) return;
  var dataEl = document.getElementById('fuulea-data');
  var DATA = null;
  try {
    DATA = JSON.parse(dataEl ? dataEl.textContent : 'null');
  } catch (err) {
    DATA = null;
  }
  if (!DATA || !DATA.grades || !DATA.grades.length) {
    root.insertAdjacentHTML(
      'beforeend',
      '<div class="empty-state">暂无年级数据，无法生成交互图表。</div>',
    );
    return;
  }

  var SERIES = DATA.series || [];
  var SUBJ_COLORS = DATA.colors || {};
  var METRICS = DATA.metrics || [];
  var BAR_METRICS = DATA.barMetrics || [];
  var TEACHER_BAR_METRICS = DATA.teacherBarMetrics || [];

  var state = {
    grade: 0,
    subjectMetric: BAR_METRICS[0] || 'taskCount',
    subjectOrder: 'desc',
    teacherMetric: TEACHER_BAR_METRICS[0] || 'taskCount',
    teacherTop: 10,
    compare: 'scale',
    radarPicks: [],
    hidden: {}, // 每个图一个 { seriesKey: true }
  };
  var MAX_RADAR = 4;

  /* ---------- 工具 ---------- */
  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }
  function num(v) { return isNum(v) ? v : null; }
  function pct(v) {
    return isNum(v) ? v.toFixed(1) + '%' : '—';
  }
  function int(v) {
    return isNum(v) ? String(Math.round(v)) : '—';
  }
  function dec1(v) {
    return isNum(v) ? v.toFixed(1) : '—';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function metricDef(key) {
    for (var i = 0; i < METRICS.length; i += 1) if (METRICS[i].key === key) return METRICS[i];
    return METRICS[0] || { key: key, label: key, fmt: 'int' };
  }
  function fmtBy(fmt, v) {
    return fmt === 'pct' ? pct(v) : fmt === 'num1' ? dec1(v) : int(v);
  }
  function grade() {
    return DATA.grades[state.grade] || DATA.grades[0];
  }
  function el(id) {
    return document.getElementById(id);
  }
  function prefersReduced() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* ---------- tooltip ---------- */
  var tip = el('tooltip');
  function showTip(evt, text) {
    if (!tip || !text) return;
    tip.textContent = text;
    tip.classList.add('is-on');
    moveTip(evt);
  }
  function moveTip(evt) {
    if (!tip || !tip.classList.contains('is-on')) return;
    var pad = 14;
    var w = tip.offsetWidth;
    var h = tip.offsetHeight;
    var x = evt.clientX + pad;
    var y = evt.clientY + pad;
    if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = evt.clientY - h - pad;
    tip.style.left = Math.max(4, x) + 'px';
    tip.style.top = Math.max(4, y) + 'px';
  }
  function hideTip() {
    if (tip) tip.classList.remove('is-on');
  }
  document.addEventListener('mouseover', function (evt) {
    var node = evt.target && evt.target.closest ? evt.target.closest('[data-tip]') : null;
    if (node) showTip(evt, node.getAttribute('data-tip'));
  });
  document.addEventListener('mousemove', function (evt) {
    if (evt.target && evt.target.closest && evt.target.closest('[data-tip]')) moveTip(evt);
  });
  document.addEventListener('mouseout', function (evt) {
    var node = evt.target && evt.target.closest ? evt.target.closest('[data-tip]') : null;
    if (!node) return;
    var to = evt.relatedTarget;
    if (to && node.contains(to)) return;
    hideTip();
  });
  window.addEventListener('scroll', hideTip, true);

  /* ---------- 图例显隐 ---------- */
  function hiddenMap(chartKey) {
    if (!state.hidden[chartKey]) state.hidden[chartKey] = {};
    return state.hidden[chartKey];
  }
  function applyHidden(container, chartKey) {
    if (!container) return;
    var map = hiddenMap(chartKey);
    var nodes = container.querySelectorAll('[data-series]');
    for (var i = 0; i < nodes.length; i += 1) {
      var k = nodes[i].getAttribute('data-series');
      if (map[k]) nodes[i].classList.add('is-hidden');
      else nodes[i].classList.remove('is-hidden');
    }
  }
  function toggleSeries(chartKey, container, key) {
    if (!key) return;
    var map = hiddenMap(chartKey);
    map[key] = !map[key];
    applyHidden(container, chartKey);
  }
  function bindLegend(chartKey, container) {
    if (!container) return;
    var legend = container.querySelector('.legend') || container.querySelector('svg');
    if (!legend) return;
    legend.addEventListener('click', function (evt) {
      var node = evt.target && evt.target.closest ? evt.target.closest('[data-series]') : null;
      if (!node) return;
      // 只在图例区域响应：散点图的点位分组不参与点击显隐
      if (container.querySelector('.legend') && !node.closest('.legend')) return;
      toggleSeries(chartKey, container, node.getAttribute('data-series'));
    });
    // 悬停图例时轻微提示
    legend.addEventListener('mousemove', function (evt) {
      var node = evt.target && evt.target.closest ? evt.target.closest('[data-series]') : null;
      if (node && node !== legend) hideTip();
    });
  }

  /* ---------- ① 三届对比 ---------- */
  function renderCompare() {
    var box = el('chart-compare');
    if (box) box.setAttribute('data-active', state.compare);
  }

  /* ---------- ② 雷达 ---------- */
  var AXES = [
    { key: 'finishPercent', label: '完成率' },
    { key: 'teacherMarkPercent', label: '师阅率' },
    { key: 'correctPercent', label: '得分率' },
    { key: 'coverPercent', label: '重练覆盖率' },
    { key: 'selfShare', label: '自学人次占比' },
  ];
  function radarAxes() {
    return AXES.filter(function (ax) {
      return ax.key !== 'coverPercent' || grade().subjects.some(function (s) {
        return !s.missing && isNum(s.bookletCoverPercent);
      });
    });
  }
  function renderRadar() {
    var box = el('chart-radar');
    if (!box) return;
    var g = grade();
    var picks = state.radarPicks;
    if (!picks.length) {
      box.innerHTML = '<div class="chart-empty">请在上方选择至少一个学科。</div>';
      return;
    }
    var series = [];
    for (var i = 0; i < picks.length; i += 1) {
      var label = picks[i];
      var sub = null;
      for (var j = 0; j < g.subjects.length; j += 1) if (g.subjects[j].label === label) sub = g.subjects[j];
      if (!sub) continue;
      var values = {
        finishPercent: num(sub.finishPercent),
        teacherMarkPercent: num(sub.teacherMarkPercent),
        correctPercent: num(sub.correctPercent),
        coverPercent: num(sub.bookletCoverPercent),
        selfShare: num(sub.selfSharePercent),
      };
      series.push({
        key: 's-' + label,
        name: label,
        color: SUBJ_COLORS[label] || SERIES[i % SERIES.length],
        values: values,
        tip: function (subj, vals) {
          return function (key) {
            var ax = null;
            for (var a = 0; a < AXES.length; a += 1) if (AXES[a].key === key) ax = AXES[a];
            var v = vals[key];
            return subj.label + ' · ' + (ax ? ax.label : key) + '：' + (key === 'coverPercent' || key === 'selfShare' ? dec1(v) + '%' : pct(v));
          };
        }(sub, values),
      });
    }
    if (!series.length) {
      box.innerHTML = '<div class="chart-empty">所选学科在本年级无数据。</div>';
      return;
    }
    var spec = { title: g.name + ' 学科画像', axes: radarAxes(), series: series, hint: '本周期暂无学科数据' };
    var svg = window.__fuuleaChart ? window.__fuuleaChart('radar', spec) : '';
    if (!svg) {
      box.innerHTML = '<div class="chart-empty">本周期暂无数据</div>';
      return;
    }
    box.innerHTML = svg;
    if (window.__fuuleaChartTheme) box.firstChild.setAttribute('style', box.firstChild.getAttribute('style') || '');
    bindLegend('radar', box);
    applyHidden(box, 'radar');
  }
  function syncRadarPicks() {
    var inputs = document.querySelectorAll('[data-role="radar-pick"]');
    var checked = [];
    for (var i = 0; i < inputs.length; i += 1) if (inputs[i].checked) checked.push(inputs[i].value);
    if (checked.length > MAX_RADAR) {
      // 超出上限：保留最早选中的，取消本次新增
      for (var k = MAX_RADAR; k < checked.length; k += 1) {
        var extra = checked[k];
        for (var m = 0; m < inputs.length; m += 1) if (inputs[m].value === extra) inputs[m].checked = false;
      }
      checked = checked.slice(0, MAX_RADAR);
    }
    state.radarPicks = checked;
    renderRadar();
  }

  /* ---------- ③ 学科排序 ---------- */
  function subjectRows(metricKey) {
    var g = grade();
    var rows = [];
    for (var i = 0; i < g.subjects.length; i += 1) {
      var s = g.subjects[i];
      var v = num(s[metricKey]);
      if (s.missing || v === null) continue;
      rows.push({
        label: s.label,
        value: v,
        key: s.key,
        color: SUBJ_COLORS[s.label] || SERIES[i % SERIES.length],
        tip: s.label + '\n任务量：' + int(s.taskCount) + ' 次\n完成率：' + pct(s.finishPercent) + '\n师阅率：' + pct(s.teacherMarkPercent) + '\n得分率：' + pct(s.correctPercent),
      });
    }
    rows.sort(function (a, b) {
      return state.subjectOrder === 'desc' ? b.value - a.value : a.value - b.value;
    });
    return rows;
  }
  function renderSubjectBar() {
    var box = el('chart-subject-bar');
    var topBox = el('top-subject-bar');
    if (!box) return;
    var g = grade();
    var metric = metricDef(state.subjectMetric);
    var rows = subjectRows(state.subjectMetric);
    if (!rows.length) {
      box.innerHTML = '<div class="chart-empty">本周期暂无数据</div>';
      if (topBox) topBox.innerHTML = '';
      return;
    }
    var best = rows[0];
    var meta = METRICS[0];
    for (var i = 0; i < METRICS.length; i += 1) if (METRICS[i].key === state.subjectMetric) meta = METRICS[i];
    if (topBox) {
      topBox.innerHTML =
        '<p class="chart-note" style="margin:0 0 6px">' +
        esc(g.name) + '「' + esc(meta.label) + '」最高：<strong>' + esc(best.label) + '</strong> ' +
        esc(fmtBy(meta.fmt, best.value)) +
        (g.missingSubjects.length ? '　·　未布置作业：' + esc(g.missingSubjects.join('、')) : '') +
        '</p>';
    }
    renderBarInto(box, 'subject-bar', {
      title: g.name + ' 各学科' + meta.label,
      rows: rows,
      valueFmt: meta.fmt,
      unit: '',
      xMax: meta.fmt === 'pct' ? 100 : null,
      hint: '本周期暂无学科数据',
    });
  }

  /* ---------- ④ 学科明细表 ---------- */
  var tableSort = { key: 'taskCount', dir: 'desc' };
  var TABLE_COLS = [
    { key: 'label', label: '学科', align: 'left', fmt: 'text' },
    { key: 'taskCount', label: '任务', align: 'right', fmt: 'int' },
    { key: 'questionCount', label: '习题', align: 'right', fmt: 'int' },
    { key: 'avgQuestionsByStudent', label: '生均题量', align: 'right', fmt: 'num1' },
    { key: 'finishPercent', label: '完成率', align: 'right', fmt: 'pct' },
    { key: 'teacherMarkPercent', label: '师阅率', align: 'right', fmt: 'pct' },
    { key: 'markPercent', label: '阅卷率', align: 'right', fmt: 'pct' },
    { key: 'correctPercent', label: '得分率', align: 'right', fmt: 'pct' },
    { key: 'bookletTaskCount', label: '重练任务', align: 'right', fmt: 'int' },
    { key: 'bookletCoverPercent', label: '覆盖率', align: 'right', fmt: 'pct' },
    { key: 'targetTaskCount', label: '靶向任务', align: 'right', fmt: 'int' },
    { key: 'watchCount', label: '观看人次', align: 'right', fmt: 'int' },
  ];
  function cellText(col, row) {
    var v = row[col.key];
    if (col.fmt === 'text') return String(v == null ? '—' : v);
    if (col.fmt === 'pct') return pct(v);
    if (col.fmt === 'num1') return dec1(v);
    return int(v);
  }
  function renderSubjectTable() {
    var table = el('subject-table');
    if (!table) return;
    var g = grade();
    var tbody = table.querySelector('tbody');
    if (!g.subjects.length) {
      tbody.innerHTML = '<tr><td colspan="' + TABLE_COLS.length + '" class="table-empty">本周期暂无数据</td></tr>';
      return;
    }
    var rows = g.subjects.slice();
    rows.sort(function (a, b) {
      var va = a[tableSort.key];
      var vb = b[tableSort.key];
      if (tableSort.key === 'label') {
        return tableSort.dir === 'asc'
          ? String(va).localeCompare(String(vb), 'zh-Hans-CN')
          : String(vb).localeCompare(String(va), 'zh-Hans-CN');
      }
      var na = num(va);
      var nb = num(vb);
      // 缺失值永远排在最后
      if (na === null && nb === null) return 0;
      if (na === null) return 1;
      if (nb === null) return -1;
      return tableSort.dir === 'desc' ? nb - na : na - nb;
    });
    var html = rows.map(function (row) {
      return '<tr class="' + (row.missing ? 'row-missing' : '') + '">' + TABLE_COLS.map(function (col) {
        var v = row[col.key];
        var cls = col.align === 'right' ? 'num' : '';
        if (col.fmt !== 'text' && num(v) === null) cls += ' dash';
        return '<td class="' + cls + '">' + esc(cellText(col, row)) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    // 均值行（缺失学科不计入）
    var means = g.means || {};
    var meanRow = '<tr class="mean-row">' + TABLE_COLS.map(function (col, i) {
      if (i === 0) return '<td>年级均值</td>';
      var v = means[col.key];
      if (col.fmt === 'text') return '<td class="num">—</td>';
      return '<td class="num">' + (num(v) === null ? '—' : esc(fmtBy(col.fmt, v))) + '</td>';
    }).join('') + '</tr>';
    tbody.innerHTML = html + meanRow;
    var ths = table.querySelectorAll('th[data-sort]');
    for (var i = 0; i < ths.length; i += 1) {
      var th = ths[i];
      if (th.getAttribute('data-sort') === tableSort.key) th.setAttribute('data-dir', tableSort.dir);
      else th.removeAttribute('data-dir');
    }
  }
  function bindTableSort() {
    var table = el('subject-table');
    if (!table) return;
    table.querySelector('thead').addEventListener('click', function (evt) {
      var th = evt.target.closest ? evt.target.closest('th[data-sort]') : null;
      if (!th) return;
      var key = th.getAttribute('data-sort');
      if (tableSort.key === key) tableSort.dir = tableSort.dir === 'desc' ? 'asc' : 'desc';
      else {
        tableSort.key = key;
        tableSort.dir = key === 'label' ? 'asc' : 'desc';
      }
      renderSubjectTable();
    });
    table.querySelector('thead').addEventListener('keydown', function (evt) {
      if (evt.key !== 'Enter' && evt.key !== ' ') return;
      var th = evt.target.closest ? evt.target.closest('th[data-sort]') : null;
      if (!th) return;
      evt.preventDefault();
      th.click();
    });
  }

  /* ---------- ⑤ 散点 ---------- */
  function renderScatter() {
    var box = el('chart-scatter');
    if (!box) return;
    var g = grade();
    if (!g.teachers.length) {
      box.innerHTML = '<div class="chart-empty">本周期暂无教师数据</div>';
      return;
    }
    var pts = [];
    for (var i = 0; i < g.teachers.length; i += 1) {
      var t = g.teachers[i];
      pts.push({
        name: t.name,
        subject: t.subject,
        x: t.finishPercent,
        y: t.teacherMarkPercent,
        task: t.taskCount,
        color: t.color,
        tip:
          t.name + '（' + t.subject + '）\n任务 ' + int(t.taskCount) + ' 次\n完成率 ' + pct(t.finishPercent) +
          '\n阅卷率 ' + pct(t.markPercent) + '\n师阅率 ' + pct(t.teacherMarkPercent) + '\n得分率 ' + pct(t.correctPercent),
      });
    }
    var spec = { title: g.name + ' 教师完成率与师阅率', points: pts, hint: '本周期暂无教师数据' };
    var svg = window.__fuuleaChart ? window.__fuuleaChart('scatter', spec) : '';
    if (!svg) {
      box.innerHTML = '<div class="chart-empty">本周期暂无教师数据</div>';
      return;
    }
    box.innerHTML = svg;
    bindLegend('scatter', box);
    applyHidden(box, 'scatter');
  }

  /* ---------- ⑥ 教师排行 ---------- */
  function renderTeacherBar() {
    var box = el('chart-teacher-bar');
    if (!box) return;
    var g = grade();
    if (!g.teachers.length) {
      box.innerHTML = '<div class="chart-empty">本周期暂无教师数据</div>';
      return;
    }
    var metric = metricDef(state.teacherMetric);
    var list = g.teachers.filter(function (t) {
      return num(t[state.teacherMetric]) !== null;
    });
    if (!list.length) {
      box.innerHTML = '<div class="chart-empty">本周期暂无教师数据</div>';
      return;
    }
    list.sort(function (a, b) {
      return num(b[state.teacherMetric]) - num(a[state.teacherMetric]) || (num(b.taskCount) || 0) - (num(a.taskCount) || 0);
    });
    if (state.teacherTop !== 'all') list = list.slice(0, state.teacherTop);
    var rows = list.map(function (t) {
      return {
        label: t.name,
        value: num(t[state.teacherMetric]),
        color: t.color,
        meta: {
          title: t.name + '（' + t.subject + '）',
          lines: metric.label + '：' + fmtBy(metric.fmt, t[state.teacherMetric]) + '\n任务 ' + int(t.taskCount) +
            ' 次 · 完成率 ' + pct(t.finishPercent) + '\n阅卷率 ' + pct(t.markPercent) + ' · 师阅率 ' + pct(t.teacherMarkPercent) +
            '\n得分率 ' + pct(t.correctPercent),
          series: 'teachers',
        },
      };
    });
    renderBarInto(box, 'teacher-bar', {
      title: g.name + ' 教师' + metric.label + '排行',
      rows: rows,
      valueFmt: metric.fmt,
      unit: '',
      xMax: metric.fmt === 'pct' ? 100 : null,
      hint: '本周期暂无教师数据',
    });
  }

  /* ---------- ⑦ 自学与观看 ---------- */
  function renderSelf() {
    var box = el('chart-self-stack');
    var sumBox = el('self-summary');
    if (!box) return;
    var g = grade();
    var rows = [];
    for (var i = 0; i < g.subjects.length; i += 1) {
      var s = g.subjects[i];
      rows.push({ label: s.label, selfPersonCount: s.selfPersonCount, selfQuestionCount: s.selfQuestionCount, watchCount: s.watchCount });
    }
    if (!rows.length) {
      box.innerHTML = '<div class="chart-empty">本周期暂无数据</div>';
      if (sumBox) sumBox.innerHTML = '';
      return;
    }
    var spec = {
      title: g.name + ' 各学科自学与观看',
      rows: rows,
      segments: [
        { key: 'selfPersonCount', name: '自学人次', color: SERIES[0] },
        { key: 'selfQuestionCount', name: '自学题量', color: SERIES[1] },
        { key: 'watchCount', name: '观看人次', color: SERIES[2] },
      ],
      hint: '本周期暂无数据',
    };
    var svg = window.__fuuleaChart ? window.__fuuleaChart('stack', spec) : '';
    if (!svg) {
      box.innerHTML = '<div class="chart-empty">本周期暂无数据</div>';
      return;
    }
    box.innerHTML = svg;
    bindLegend('self', box);
    applyHidden(box, 'self');

    var sp = 0;
    var sq = 0;
    var wc = 0;
    for (var k = 0; k < g.subjects.length; k += 1) {
      sp += num(g.subjects[k].selfPersonCount) || 0;
      sq += num(g.subjects[k].selfQuestionCount) || 0;
      wc += num(g.subjects[k].watchCount) || 0;
    }
    var watchText = g.summary.watchDurationText || '—';
    var items = [
      { k: '自学人次', v: int(sp) },
      { k: '自学题量', v: int(sq) },
      { k: '视频观看人次', v: int(wc) },
      { k: '观看时长（时:分）', v: watchText },
    ];
    if (sumBox) {
      sumBox.innerHTML = items.map(function (it) {
        return '<div class="self-item"><div class="k">' + esc(it.k) + '</div><div class="v num-text">' + esc(it.v) + '</div></div>';
      }).join('');
    }
  }

  /* ---------- 通用：条形图渲染 ---------- */
  function renderBarInto(box, chartKey, spec) {
    if (!box) return;
    var svg = window.__fuuleaChart ? window.__fuuleaChart('bar', spec) : '';
    if (!svg) {
      box.innerHTML = '<div class="chart-empty">' + esc(spec.hint || '本周期暂无数据') + '</div>';
      return;
    }
    box.innerHTML = svg;
    bindLegend(chartKey, box);
    applyHidden(box, chartKey);
  }

  /* ---------- 联动渲染 ---------- */
  function renderGrade() {
    var g = grade();
    renderSubjectBar();
    renderSubjectTable();
    renderScatter();
    renderTeacherBar();
    renderSelf();
    renderRadar();
    // Tab 上标注缺失学科
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i += 1) {
      var gg = DATA.grades[i];
      var isOn = i === state.grade;
      tabs[i].classList.toggle('is-active', isOn);
      tabs[i].setAttribute('aria-selected', isOn ? 'true' : 'false');
      var sub = tabs[i].querySelector('.tab-sub');
      if (sub && gg) sub.textContent = gg.levelName || '';
    }
    var cap = el('grade-caption');
    if (cap) {
      var bits = [];
      if (g.classCount !== null) bits.push(int(g.classCount) + ' 个行政班');
      if (g.summary.taskCount !== null) bits.push('任务 ' + int(g.summary.taskCount) + ' 次');
      if (g.summary.questionCount !== null) bits.push('习题 ' + int(g.summary.questionCount) + ' 道');
      if (g.missingSubjects.length) bits.push('未布置作业：' + g.missingSubjects.join('、'));
      cap.textContent = bits.join('　·　');
    }
  }

  /* ---------- 绑定 ---------- */
  function bind() {
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].addEventListener('click', function (evt) {
        var idx = parseInt(evt.currentTarget.getAttribute('data-grade'), 10);
        if (!isFinite(idx) || idx === state.grade) return;
        state.grade = idx;
        hideTip();
        // 雷达默认选中有数据的学科
        renderGrade();
      });
    }
    var sm = document.querySelector('[data-role="subject-metric"]');
    if (sm) {
      sm.addEventListener('change', function () {
        state.subjectMetric = sm.value;
        renderSubjectBar();
      });
    }
    var sb = document.querySelector('[data-role="subject-order"]');
    if (sb) {
      sb.addEventListener('click', function () {
        state.subjectOrder = state.subjectOrder === 'desc' ? 'asc' : 'desc';
        sb.setAttribute('data-order', state.subjectOrder);
        sb.textContent = state.subjectOrder === 'desc' ? '降序' : '升序';
        renderSubjectBar();
      });
    }
    var tm = document.querySelector('[data-role="teacher-metric"]');
    if (tm) {
      tm.addEventListener('change', function () {
        state.teacherMetric = tm.value;
        renderTeacherBar();
      });
    }
    var tt = document.querySelector('[data-role="teacher-top"]');
    if (tt) {
      tt.addEventListener('change', function () {
        state.teacherTop = tt.value === 'all' ? 'all' : parseInt(tt.value, 10);
        renderTeacherBar();
      });
    }
    var cm = document.querySelector('[data-role="compare-metric"]');
    if (cm) {
      cm.addEventListener('change', function () {
        state.compare = cm.value;
        renderCompare();
      });
    }
    var picks = document.querySelectorAll('[data-role="radar-pick"]');
    for (var p = 0; p < picks.length; p += 1) picks[p].addEventListener('change', syncRadarPicks);
    var allBtn = document.querySelector('[data-role="radar-all"]');
    if (allBtn) {
      allBtn.addEventListener('click', function () {
        var inputs = document.querySelectorAll('[data-role="radar-pick"]');
        var count = 0;
        for (var q = 0; q < inputs.length; q += 1) {
          var on = count < MAX_RADAR;
          inputs[q].checked = on;
          if (on) count += 1;
        }
        syncRadarPicks();
      });
    }
    var noneBtn = document.querySelector('[data-role="radar-none"]');
    if (noneBtn) {
      noneBtn.addEventListener('click', function () {
        var inputs = document.querySelectorAll('[data-role="radar-pick"]');
        for (var q = 0; q < inputs.length; q += 1) inputs[q].checked = false;
        syncRadarPicks();
      });
    }
    bindTableSort();
  }

  // 初始状态：默认选中有任务数据的学科（最多 4 个）
  (function initRadarPicks() {
    var g = grade();
    var picks = [];
    for (var i = 0; i < g.subjects.length && picks.length < MAX_RADAR; i += 1) {
      if (!g.subjects[i].missing && (g.subjects[i].taskCount || 0) > 0) picks.push(g.subjects[i].label);
    }
    if (!picks.length) {
      for (var j = 0; j < g.subjects.length && picks.length < MAX_RADAR; j += 1) picks.push(g.subjects[j].label);
    }
    state.radarPicks = picks;
    var inputs = document.querySelectorAll('[data-role="radar-pick"]');
    for (var k = 0; k < inputs.length; k += 1) inputs[k].checked = picks.indexOf(inputs[k].value) >= 0;
  })();

  bind();
  renderCompare();
  renderGrade();
})();
`

/* ------------------------------------------------------------------ 前端图表"函数索引" */
//
// 页面里的 SVG 需要随 Tab / 指标切换重画，而 SVG 生成逻辑必须与构建期同源（一份代码）。
// 做法：把上面几个图表函数在构建期渲染成 <template>（静态首屏），同时把「生成函数」
// 通过 window.__fuuleaChart 暴露给前端，前端只需传 spec 即可得到同样的 SVG。
// 下面是序列化后的最小版本（与上方函数一一对应，改动时两边同步；函数体只做字符串拼装，无副作用）。

const CHART_RUNTIME = String.raw`
(function () {
  'use strict';
  var THEME = JSON.parse(document.getElementById('fuulea-theme').textContent);
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  // 数值判空统一用 num()。注意：绝不要在本作用域再声明名为 n / x / y / r 的「函数」——
  // 函数声明会被提升（声明提前的值为 undefined），而图表函数里的坐标映射 x 会捕获到这个值，
  // 于是 x(...) 静默返回 undefined，图表整体变成空白且不抛错，极难排查。
  function num(v) { return isNum(v) ? v : null; }
  function pct(v) { return isNum(v) ? v.toFixed(1) + '%' : '—'; }
  function int(v) { return isNum(v) ? String(Math.round(v)) : '—'; }
  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
  function textW(t, size) {
    var w = 0;
    var s = String(t);
    for (var i = 0; i < s.length; i += 1) w += /[\x00-\xff]/.test(s.charAt(i)) ? size * 0.56 : size;
    return w;
  }
  function fit(t, maxW, size) {
    var raw = String(t == null ? '' : t);
    if (textW(raw, size) <= maxW) return raw;
    var out = '';
    for (var i = 0; i < raw.length; i += 1) {
      if (textW(out + raw.charAt(i) + '…', size) > maxW) break;
      out += raw.charAt(i);
    }
    return out ? out + '…' : '…';
  }
  function niceScale(maxValue, targetTicks) {
    var max = Math.max(1, num(maxValue) === null ? 1 : maxValue);
    var rough = max / Math.max(2, targetTicks || 5);
    var mag = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
    var norm = rough / mag;
    var mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    var step = mult * mag;
    return { max: Math.ceil((max * 1.02) / step) * step, step: step };
  }
  function tickText(v, step) {
    var d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    return String(Number(v.toFixed(d)));
  }
  function svgOpen(w, h, label) {
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMinYMin meet" role="img" aria-label="' + esc(label) + '" class="chart-svg" style="width:100%;height:auto;display:block">';
  }
  function text(x, y, str, o) {
    o = o || {};
    var size = o.size || 13;
    var fill = o.fill || 'currentColor';
    var anchor = o.anchor || 'start';
    var weight = o.weight || 400;
    return '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" font-size="' + size + '" text-anchor="' + anchor + '" fill="' + fill + '"' + (weight !== 400 ? ' font-weight="' + weight + '"' : '') + '>' + esc(str) + '</text>';
  }
  function rect(x, y, w, h, o) {
    o = o || {};
    return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + Math.max(0, w).toFixed(1) + '" height="' + Math.max(0, h).toFixed(1) + '"' + (o.rx ? ' rx="' + o.rx + '"' : '') + ' fill="' + (o.fill || 'none') + '"' + (o.opacity == null ? '' : ' opacity="' + o.opacity + '"') + (o.extra || '') + '/>';
  }
  function line(x1, y1, x2, y2, o) {
    o = o || {};
    return '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="' + (o.stroke || '#999') + '" stroke-width="' + (o.width || 1) + '"' + (o.dash ? ' stroke-dasharray="' + o.dash + '"' : '') + '/>';
  }
  function group(key, inner) {
    return '<g data-series="' + esc(key) + '">' + inner + '</g>';
  }
  function emptySvg(label, hint) {
    return svgOpen(720, 180, label) + rect(0, 0, 720, 180, { fill: THEME.panel }) + text(360, 92, hint || '本周期暂无数据', { size: 15, fill: THEME.muted, anchor: 'middle' }) + '</svg>';
  }
  function bar(spec) {
    var rows = (spec.rows || []).filter(function (r) { return r && num(r.value) !== null; });
    if (!rows.length) return emptySvg(spec.title, spec.hint);
    var fmt = spec.valueFmt === 'pct' ? pct : int;
    var W = 720, padL = 92, padR = 76, top = 26, rowH = 30;
    var H = top + rows.length * rowH + 34;
    var plotW = W - padL - padR;
    var maxV = num(spec.xMax) === null ? 0 : spec.xMax;
    for (var i = 0; i < rows.length; i += 1) maxV = Math.max(maxV, num(rows[i].value) || 0);
    var scale = num(spec.xMax) !== null ? { max: spec.xMax, step: spec.xMax / 5 } : niceScale(maxV, 5);
    var pxOf = function (v) { return padL + (clamp(v, 0, scale.max) / scale.max) * plotW; };
    var out = [svgOpen(W, H, spec.title), rect(0, 0, W, H, { fill: THEME.panel })];
    for (var t = 0; t <= scale.max + 1e-9; t += scale.step) {
      var px = pxOf(t);
      out.push(line(px, top - 6, px, H - 26, { stroke: THEME.grid, width: 1 }));
      out.push(text(px, H - 8, tickText(t, scale.step), { size: 12, fill: THEME.muted, anchor: 'middle' }));
    }
    rows.forEach(function (row, idx) {
      var cy = top + idx * rowH + rowH / 2;
      var barH = Math.min(20, rowH - 10);
      var color = spec.color ? spec.color(row) : THEME.series[0];
      var value = num(row.value) || 0;
      var w = Math.max(value > 0 ? 1.5 : 0, padL + (value / scale.max) * plotW - padL);
      var tip = (row.meta && row.meta.title ? row.meta.title : row.label) + '\n' + (row.meta && row.meta.lines ? row.meta.lines : (spec.unit || '') + fmt(row.value));
      out.push('<g data-series="' + esc((row.meta && row.meta.series) || 'default') + '" data-row="' + idx + '">' + rect(padL, cy - barH / 2, w, barH, { fill: color, rx: 3, opacity: 0.9, extra: ' data-tip="' + esc(tip) + '"' }) + text(padL - 10, cy + 4.5, fit(row.label, padL - 16, 13), { size: 13, fill: THEME.text, anchor: 'end' }) + text(Math.min(padL + w + 8, W - 6), cy + 4.5, (spec.unit || '') + fmt(row.value), { size: 12.5, fill: THEME.text2 }) + '</g>');
    });
    out.push('</svg>');
    return out.join('');
  }
  function radar(spec) {
    var axes = spec.axes || [];
    var series = (spec.series || []).filter(function (s) { return s && s.values; });
    if (!axes.length || !series.length) return emptySvg(spec.title, spec.hint);
    var W = 720, H = 430, cx = W / 2, cy = H / 2 + 8;
    var R = Math.min(150, H / 2 - 74);
    var angle = function (i) { return (Math.PI * 2 * i) / axes.length - Math.PI / 2; };
    var pt = function (i, r) { return [cx + Math.cos(angle(i)) * r, cy + Math.sin(angle(i)) * r]; };
    var axisMax = axes.map(function (ax) {
      var vals = series.map(function (s) { return num(s.values[ax.key]); }).filter(function (v) { return v !== null; });
      var m = vals.length ? Math.max.apply(null, vals) : 0;
      return Math.max(ax.best ? 60 : 50, m * 1.18 || 50);
    });
    var out = [svgOpen(W, H, spec.title), rect(0, 0, W, H, { fill: THEME.panel })];
    for (var k = 1; k <= 4; k += 1) {
      var r = (R * k) / 4;
      var pts = axes.map(function (_, i) { return pt(i, r).map(function (v) { return v.toFixed(1); }).join(','); }).join(' ');
      out.push('<polygon points="' + pts + '" fill="none" stroke="' + THEME.grid + '" stroke-width="1"/>');
    }
    axes.forEach(function (_, i) { var p2 = pt(i, R); out.push(line(cx, cy, p2[0], p2[1], { stroke: THEME.grid, width: 1 })); });
    series.forEach(function (s) {
      var ptsArr = axes.map(function (ax, i) {
        var v = num(s.values[ax.key]);
        var rr = v === null ? 0 : (clamp(v, 0, axisMax[i]) / axisMax[i]) * R;
        return pt(i, rr);
      });
      var poly = ptsArr.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
      var dots = ptsArr.map(function (p, i) {
        var tip = s.tip ? s.tip(axes[i].key) : s.name + '·' + axes[i].label;
        return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.4" fill="' + s.color + '" stroke="' + THEME.panel + '" stroke-width="1.4" data-tip="' + esc(tip) + '"/>';
      }).join('');
      out.push(group(s.key || s.name, '<polygon points="' + poly + '" fill="' + s.color + '" fill-opacity="0.12" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round"/>' + dots));
    });
    axes.forEach(function (ax, i) {
      var ang = angle(i);
      var lp = pt(i, R + 24);
      var cos = Math.cos(ang), sin = Math.sin(ang);
      var anchor = Math.abs(cos) < 0.25 ? 'middle' : cos > 0 ? 'start' : 'end';
      var dx = anchor === 'start' ? 2 : anchor === 'end' ? -2 : 0;
      var dy = sin < -0.5 ? -4 : sin > 0.5 ? 12 : 5;
      out.push(text(lp[0] + dx, lp[1] + dy, fit(ax.label, 150, 13), { size: 13, fill: THEME.text, anchor: anchor }));
    });
    series.slice(0, 4).forEach(function (sr, si) {
      var li = 20 + si * 20;
      out.push(group(sr.key || sr.name, line(20, li - 4, 38, li - 4, { stroke: sr.color, width: 2.6 }) + '<circle cx="29" cy="' + (li - 4) + '" r="3.2" fill="' + sr.color + '"/>' + text(44, li, fit(sr.name, 140, 12.5), { size: 12.5, fill: THEME.text2 })));
    });
    out.push('</svg>');
    return out.join('');
  }
  function scatter(spec) {
    // 与构建期 scatterSvg 保持一致：刻度 +18 / x 轴标题 +42 / 图例 +74，bottom=104
    var W = 720, H = 484, padL = 58, padR = 24, top = 26, bottom = 104;
    var plotW = W - padL - padR, plotH = H - top - bottom;
    var points = (spec.points || []).filter(function (p) { return num(p.x) !== null && num(p.y) !== null; });
    if (!points.length) return emptySvg(spec.title, spec.hint);
    var maxTask = 1;
    points.forEach(function (p) { maxTask = Math.max(maxTask, num(p.task) || 0); });
    var x0 = 40;
    var pxOf = function (v) { return padL + ((clamp(v, x0, 100) - x0) / (100 - x0)) * plotW; };
    var pyOf = function (v) { return top + plotH - (clamp(v, 0, 100) / 100) * plotH; };
    var rOf = function (taskCount) { return 3.4 + Math.sqrt((num(taskCount) || 0) / maxTask) * 12; };
    var out = [svgOpen(W, H, spec.title), rect(0, 0, W, H, { fill: THEME.panel })];
    for (var v = x0; v <= 100; v += 20) {
      out.push(line(pxOf(v), top, pxOf(v), top + plotH, { stroke: THEME.grid, width: 1 }));
      out.push(text(pxOf(v), top + plotH + 18, v + '%', { size: 12, fill: THEME.muted, anchor: 'middle' }));
    }
    for (var u = 0; u <= 100; u += 20) {
      out.push(line(padL, pyOf(u), W - padR, pyOf(u), { stroke: THEME.grid, width: 1 }));
      out.push(text(padL - 8, pyOf(u) + 4, u + '%', { size: 12, fill: THEME.muted, anchor: 'end' }));
    }
    out.push(line(pxOf(80), top, pxOf(80), top + plotH, { stroke: THEME.muted, width: 1, dash: '5 4' }));
    out.push(line(padL, pyOf(80), W - padR, pyOf(80), { stroke: THEME.muted, width: 1, dash: '5 4' }));
    out.push(text(padL + plotW / 2, top + plotH + 42, '完成率', { size: 13, fill: THEME.text2, anchor: 'middle' }));
    var cyText = (top + plotH / 2).toFixed(1);
    out.push('<text x="24" y="' + cyText + '" font-size="13" text-anchor="middle" fill="' + THEME.text2 + '" transform="rotate(-90 24 ' + cyText + ')">师阅率</text>');
    var sorted = points.slice().sort(function (a, b) { return (num(b.task) || 0) - (num(a.task) || 0); });
    out.push(group('pts', sorted.map(function (p) {
      var tip = p.tip || (p.name + '\n' + p.subject);
      return '<circle cx="' + pxOf(p.x).toFixed(1) + '" cy="' + pyOf(p.y).toFixed(1) + '" r="' + rOf(p.task).toFixed(1) + '" fill="' + p.color + '" fill-opacity="0.72" stroke="' + p.color + '" stroke-width="1.4" data-tip="' + esc(tip) + '"/>';
    }).join('')));
    var subs = [];
    points.forEach(function (p) { if (subs.indexOf(p.subject) < 0) subs.push(p.subject); });
    // 图例回调参数名避开单字母 s / i，避免与系列名、索引混淆
    subs.forEach(function (subj, si) {
      var item = null;
      for (var k = 0; k < points.length; k += 1) if (points[k].subject === subj) { item = points[k]; break; }
      var lx = padL + (si % 9) * ((plotW - 10) / 9);
      var ly = top + plotH + 74;
      out.push('<g data-series="' + esc(subj) + '" class="legend-item">' + '<circle cx="' + (lx + 5).toFixed(1) + '" cy="' + (ly - 4) + '" r="5" fill="' + item.color + '" fill-opacity="0.8"/>' + text(lx + 14, ly, fit(subj, (plotW - 10) / 9 - 14, 12), { size: 12, fill: THEME.text2 }) + '</g>');
    });
    out.push(text(W - padR, top - 8, '圆点面积按任务量，最大 ' + int(maxTask) + ' 次', { size: 11.5, fill: THEME.muted, anchor: 'end' }));
    out.push('</svg>');
    return out.join('');
  }
  function stack(spec) {
    var rows = spec.rows || [];
    var segs = spec.segments || [];
    if (!rows.length || !segs.length) return emptySvg(spec.title, spec.hint);
    var W = 720, padL = 96, padR = 22, top = 48, rowH = 34;
    var H = top + rows.length * rowH + 16;
    var plotW = W - padL - padR;
    var maxOf = segs.map(function (seg) {
      var m = 1;
      rows.forEach(function (r) { m = Math.max(m, num(r[seg.key]) || 0); });
      return m;
    });
    var total = segs.length * 100;
    var pxOf = function (v) { return padL + (clamp(v, 0, total) / total) * plotW; };
    var out = [svgOpen(W, H, spec.title), rect(0, 0, W, H, { fill: THEME.panel })];
    out.push('<g class="legend">');
    var lx = padL;
    segs.forEach(function (seg, i) {
      var name = seg.name + '（最大 ' + int(maxOf[i]) + '）';
      out.push('<g data-series="' + esc(seg.key) + '">' + rect(lx, 16, 13, 12, { fill: seg.color, rx: 2 }) + text(lx + 18, 26.5, name, { size: 12, fill: THEME.text2 }) + '</g>');
      lx += textW(name, 12) + 46;
    });
    out.push('</g>');
    rows.forEach(function (row, ri) {
      var cy = top + ri * rowH + rowH / 2;
      var acc = 0;
      var segHtml = segs.map(function (seg, si) {
        var v = num(row[seg.key]) || 0;
        var unit = (v / maxOf[si]) * 100;
        var x0 = pxOf(acc);
        var w = pxOf(acc + unit) - pxOf(acc);
        acc += unit;
        var tip = row.label + '\n' + seg.name + '：' + int(v);
        var label = v > 0 && w > 34 ? text(x0 + w / 2, cy + 4.5, int(v), { size: 11.5, fill: '#ffffff', anchor: 'middle', weight: 500 }) : '';
        return '<rect x="' + x0.toFixed(1) + '" y="' + (cy - 10).toFixed(1) + '" width="' + Math.max(0, w).toFixed(1) + '" height="20" fill="' + seg.color + '" rx="2" data-tip="' + esc(tip) + '"/>' + label;
      }).join('');
      out.push('<g data-series="row' + ri + '">' + text(padL - 10, cy + 4.5, fit(row.label, padL - 18, 13), { size: 13, fill: THEME.text, anchor: 'end' }) + segHtml + '</g>');
    });
    out.push('</svg>');
    return out.join('');
  }
  window.__fuuleaChart = function (kind, spec) {
    try {
      if (kind === 'bar') return bar(spec);
      if (kind === 'radar') return radar(spec);
      if (kind === 'scatter') return scatter(spec);
      if (kind === 'stack') return stack(spec);
      return '';
    } catch (err) {
      return '';
    }
  };
})();
`

/* ------------------------------------------------------------------ 文档 */

/**
 * 构建交互式 HTML 报告。
 * @param {object} model 数据模型（结构见 SPEC-report.md §1）
 * @param {object} [opts] { theme?: 'light'|'dark' 预留；generatedAt?: string }
 * @returns {string} 完整 HTML 文档
 */
export function buildInteractiveHtml(model, opts = {}) {
  const theme = LIGHT
  const m = normalizeModel(model, theme)
  const options = obj(opts)
  if (!m.grades.length) {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.school)}交互数据报告</title>
<style>${STYLES}</style>
</head>
<body>
<div class="page">
${headerHtml(m)}
<div class="empty-state">本周期暂无年级数据。</div>
</div>
</body>
</html>
`
  }

  // 前端需要的主题色（浅色固定；深色模式由 CSS 变量控制页面底色，
  // 图表内部颜色与浅色一致，在深色卡片上依然可读，故不重复下发一套深色）。
  const themeJson = {
    panel: theme.panel,
    grid: theme.grid,
    axis: theme.axis,
    text: theme.text,
    text2: theme.text2,
    muted: theme.muted,
    series: theme.series,
    good: theme.good,
    warn: theme.warn,
  }

  const colors = {}
  m.grades.forEach((g) =>
    g.subjects.forEach((s, i) => {
      if (!(s.label in colors)) colors[s.label] = colorOfSubject(s.label, i, theme)
    }),
  )

  const dataJson = {
    school: m.school,
    from: m.from,
    to: m.to,
    days: m.days,
    generatedAt: m.generatedAt,
    totals: m.totals,
    grades: m.grades,
    colors,
    series: theme.series,
    metrics: SUBJECT_METRICS,
    barMetrics: BAR_METRICS,
    teacherBarMetrics: TEACHER_BAR_METRICS,
  }
  // 关键：JSON 进 <script type="application/json"> 前先把 "</" 转成 "<\/"，
  // 防止数据里出现 </script> 之类的片段提前闭合标签（JSON.parse 不受影响）
  const dataText = JSON.stringify(dataJson).replace(/<\//g, '<\\/').replace(/\u2028|\u2029/g, (c) =>
    c === '\u2028' ? '\\u2028' : '\\u2029',
  )
  const themeText = JSON.stringify(themeJson).replace(/<\//g, '<\\/')

  const title = `${m.school}交互数据报告（${m.from || ''}~${m.to || ''}）`
  const yearLabel = options.year ? `　·　${esc(String(options.year))}` : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="fuulea-report">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="page" id="app">
${headerHtml(m)}
${kpiHtml(m)}
${tabsHtml(m)}
<p class="hero-meta" id="grade-caption"></p>
${compareCardHtml(m, theme)}
${radarCardHtml(m, theme)}
${subjectBarCardHtml(theme)}
${subjectTableCardHtml(theme)}
${teacherCardHtml(theme)}
${selfCardHtml(theme, m)}
<footer class="chart-note" style="margin-top:18px">
数据来源：${esc(m.school)}辅立码课（智慧教学云）管理看板，统计区间 ${esc(m.from || '—')} 至 ${esc(
    m.to || '—',
  )}${yearLabel}。口径与正式报告一致；百分数为 1 位小数，缺失显示「—」。
</footer>
</div>
<div id="tooltip" role="status" aria-live="polite"></div>
<script id="fuulea-data" type="application/json">${dataText}</script>
<script id="fuulea-theme" type="application/json">${themeText}</script>
<script>${CHART_RUNTIME}</script>
<script>${SCRIPT}</script>
</body>
</html>
`
}

export default { buildInteractiveHtml }
