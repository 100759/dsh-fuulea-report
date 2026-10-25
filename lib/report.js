// 报告渲染层：把 data.js 产出的数据模型渲染成
//   - Markdown 报告（GFM 表格，章节层级与 PDF 一致）
//   - 可打印 HTML（单文件、内联 CSS / 内联 SVG，A4 打印）
//   - Word 文档（.docx，公文版式，由 docx.js 打包）
//
// 只依赖 Node 内置能力与同目录的 charts.js / docx.js，不访问网络、不写文件。
import { subjectOverviewSvg, teacherOverviewSvg, gradeCompareSvg } from './charts.js'
import { buildDocx as buildWordFromDoc } from './docx.js'

// ---------------------------------------------------------------- 格式化

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const round1 = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null)

/** 百分比：一律 1 位小数；缺失显示「缺失」 */
const pct = (v) => (isNum(v) ? `${v.toFixed(1)}%` : '缺失')
/** 数值：1 位小数 */
const num1 = (v) => (isNum(v) ? v.toFixed(1) : '缺失')
/** 整数（不加千分位，与平台/参考报告一致） */
const intStr = (v) => (isNum(v) ? String(Math.round(v)) : '缺失')
/** 表格整数单元格：缺失用「—」（与时间起止同一符号，见 EM_DASH 说明） */
const intCell = (v) => (isNum(v) ? String(Math.round(v)) : '—')
/** 表格百分比单元格：一律 1 位小数，缺失用「—」 */
const pctCell = (v) => (isNum(v) ? `${v.toFixed(1)}%` : '—')
/** 表格小数单元格：1 位小数，缺失用「—」 */
const numCell = (v) => (isNum(v) ? v.toFixed(1) : '—')

const asZero = (v) => (isNum(v) ? v : 0)

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

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']
const cnNum = (n) => CN_NUM[n - 1] || String(n)

/** "2026-10-08" → "2026 年 10 月 8 日" */
function dateText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''))
  if (!m) return ''
  return `${Number(m[1])} 年 ${Number(m[2])} 月 ${Number(m[3])} 日`
}

/** 统计周期（时间起止）：按 GB/T 15834 用一字线「—」，不用浪纹线 */
function dateRange(from, to) {
  const a = dateText(from)
  const b = dateText(to)
  if (!a || !b) return a || b || ''
  return `${a}${EM_DASH}${b}`
}

/** 分钟 → "HH:MM"（时:分），仅作兜底 */
function formatMinutes(minutes) {
  if (!isNum(minutes)) return '缺失'
  const total = Math.round(minutes)
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
const toHours = (minutes) => (isNum(minutes) ? Math.round((minutes / 60) * 10) / 10 : null)

// ---------------------------------------------------------------- 模型访问

const sumBy = (arr, fn) => arr.reduce((acc, x) => acc + (isNum(fn(x)) ? fn(x) : 0), 0)
const meanBy = (arr, fn) => {
  const vals = arr.map(fn).filter(isNum)
  if (!vals.length) return null
  return vals.reduce((a, b) => a + b, 0) / vals.length
}
const sortByDesc = (arr, fn) =>
  arr.slice().sort((a, b) => {
    const va = fn(a)
    const vb = fn(b)
    return (isNum(vb) ? vb : -Infinity) - (isNum(va) ? va : -Infinity)
  })
const sortByAsc = (arr, fn) =>
  arr.slice().sort((a, b) => {
    const va = fn(a)
    const vb = fn(b)
    return (isNum(va) ? va : Infinity) - (isNum(vb) ? vb : Infinity)
  })

/**
 * 数值区间连接号：GB/T 15834—2011 规定实数范围用浪纹线「～」。
 * 时间、地域等项目的起止仍用一字线「—」（见 dateRange）。全篇不得使用「-」「–」表示范围。
 * 表格空值占位符与时间起止统一用「—」：数值区间已改用浪纹线「～」，两种用法不会产生歧义，
 * 全篇只用一种横线，避免「－」「—」两种相近符号混排。
 */
const TILDE = '～'
const EM_DASH = '—'

/** 一组数值的区间文案（统一 1 位小数）；无有效值返回 null */
function rangeText(values) {
  const vals = values.filter(isNum)
  if (!vals.length) return null
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  return Math.abs(max - min) < 0.05 ? pct(min) : `${pct(min)}${TILDE}${pct(max)}`
}

/** 加权平均：值缺失或权重非正时跳过；无有效样本返回 null */
function weightedMean(items, valueFn, weightFn) {
  let sum = 0
  let weightSum = 0
  for (const item of items) {
    const value = valueFn(item)
    const weight = weightFn(item)
    if (isNum(value) && isNum(weight) && weight > 0) {
      sum += value * weight
      weightSum += weight
    }
  }
  return weightSum > 0 ? sum / weightSum : null
}

const subjectsOf = (grade) =>
  Array.isArray(grade?.subjects)
    ? grade.subjects.filter((s) => s && (s.short || s.name))
    : []
const shortOf = (s) => s.short || String(s.name || '').replace(/^(高中|初中|小学)/, '')
const withTasks = (grade) =>
  subjectsOf(grade).filter((s) => !s.missing && isNum(s.taskCount) && s.taskCount > 0)
/**
 * 本周期有任务记录的教师。无任务记录的账号（未绑定或本期未使用）不计入教师统计的分母，
 * 否则「20 位教师中 15 位……」会把从未使用的账号算进比例。清单与图表同口径。
 */
const teachersOf = (grade) =>
  (Array.isArray(grade?.teachers) ? grade.teachers : []).filter(
    (t) => t && t.name && isNum(t.taskCount) && t.taskCount > 0,
  )
/** 源表全部教师账号（含无任务记录者），仅用于核对差异 */
const allTeachersOf = (grade) =>
  Array.isArray(grade?.teachers) ? grade.teachers.filter((t) => t && t.name) : []
/** 有任务记录的教师：无任务账号（疑似未绑定）不计入教师统计的分母 */
const activeTeachersOf = (grade) => teachersOf(grade).filter((t) => asZero(t.taskCount) > 0)
/** 本期无任何任务记录的教师姓名（单列说明，不参与比例计算） */
const idleTeacherNames = (grade) =>
  teachersOf(grade)
    .filter((t) => asZero(t.taskCount) <= 0)
    .map((t) => t.name)
const summaryOf = (grade) => grade?.summary || {}

/** "2024级" → "2024 级"（正文与标题统一留空格，和参考报告一致） */
const gradeLabel = (grade) => String(grade?.gradeName || '').replace(/(\d{4})\s*级/, '$1 级')

const gradeHeading = (grade) =>
  `${gradeLabel(grade)}${grade && grade.levelName ? `（${grade.levelName}）` : ''}`

/** 缺失学科：带 missing 标记，或任务量缺失 / 为 0 */
const isMissingSubject = (subject) =>
  !subject || subject.missing === true || !(isNum(subject.taskCount) && subject.taskCount > 0)

/** 整周未布置任务的学科（missing 或任务量为 0 / 缺失） */
const missingSubjects = (grade) => subjectsOf(grade).filter(isMissingSubject)

const subjectOrderIndex = (grade, subject) => subjectsOf(grade).indexOf(subject)

function bookletStats(grade) {
  const list = subjectsOf(grade).filter((s) => asZero(s.booklet?.taskCount) > 0)
  return { list, total: sumBy(list, (s) => s.booklet.taskCount) }
}

function targetStats(grade) {
  const subs = subjectsOf(grade)
  return {
    taskCount: sumBy(subs, (s) => s.target?.taskCount),
    questionCount: sumBy(subs, (s) => s.target?.questionCount),
    list: subs.filter((s) => asZero(s.target?.questionCount) > 0),
  }
}

function resourceStats(grade) {
  const subs = subjectsOf(grade)
  return {
    tag: sumBy(subs, (s) => s.resource?.tag),
    audio: sumBy(subs, (s) => s.resource?.audio),
    video: sumBy(subs, (s) => s.resource?.video),
  }
}

/** 全年级阅卷留痕率汇总：空值按 0.0% 口径计入 */
function traceStats(ctx) {
  const rows = []
  for (const grade of ctx.grades) {
    for (const subject of withTasks(grade)) {
      rows.push({ grade, subject, value: asZero(subject.tracePercent) })
    }
  }
  return {
    rows,
    zeros: rows.filter((row) => row.value === 0),
    mean: meanBy(rows, (row) => row.value),
    best: sortByDesc(rows, (row) => row.value)[0] || null,
  }
}

function totalBookletOf(grade) {
  return bookletStats(grade).total
}

function totalsOf(model) {
  const t = model?.totals || {}
  const grades = Array.isArray(model?.grades) ? model.grades : []
  const meta = model?.meta || {}
  const days = isNum(t.days) ? t.days : isNum(meta.days) ? meta.days : 1
  const taskCount = isNum(t.taskCount)
    ? t.taskCount
    : sumBy(grades, (g) => summaryOf(g).taskCount)
  const questionCount = isNum(t.questionCount)
    ? t.questionCount
    : sumBy(grades, (g) => summaryOf(g).questionCount)
  const watchCount = isNum(t.watchCount)
    ? t.watchCount
    : sumBy(grades, (g) => summaryOf(g).watchCount)
  const watchDurationMin = isNum(t.watchDurationMin)
    ? t.watchDurationMin
    : sumBy(grades, (g) => summaryOf(g).watchDurationMin)
  return {
    gradeCount: isNum(t.gradeCount) ? t.gradeCount : grades.length,
    days,
    taskCount,
    questionCount,
    dailyTask: isNum(t.dailyTask) ? t.dailyTask : taskCount / days,
    dailyQuestion: isNum(t.dailyQuestion) ? t.dailyQuestion : questionCount / days,
    selfPersonCount: isNum(t.selfPersonCount)
      ? t.selfPersonCount
      : sumBy(grades, (g) => summaryOf(g).selfPersonCount),
    selfQuestionCount: isNum(t.selfQuestionCount)
      ? t.selfQuestionCount
      : sumBy(grades, (g) => summaryOf(g).selfQuestionCount),
    watchCount,
    watchDurationMin,
    watchDurationText: t.watchDurationText || formatMinutes(watchDurationMin),
    watchHours: isNum(t.watchHours) ? t.watchHours : toHours(watchDurationMin),
  }
}

// ---------------------------------------------------------------- 选取规则

const DOUBLE_HIGH_SUBJECT = { finish: 80, mark: 90 }
const DOUBLE_HIGH_TEACHER = { finish: 80, mark: 95 }
const LOW_FINISH = 75
const HIGH_FINISH = 85
const LOW_MARK_FOR_SUMMARY = 2

function doubleHighSubjects(grade, max = 5) {
  return sortByDesc(
    withTasks(grade).filter(
      (s) =>
        isNum(s.finishPercent) &&
        s.finishPercent >= DOUBLE_HIGH_SUBJECT.finish &&
        isNum(s.teacherMarkPercent) &&
        s.teacherMarkPercent >= DOUBLE_HIGH_SUBJECT.mark,
    ),
    (s) => s.finishPercent,
  ).slice(0, max)
}

function highFinishSubjects(grade, max = 4) {
  return sortByDesc(
    withTasks(grade).filter((s) => isNum(s.finishPercent) && s.finishPercent >= HIGH_FINISH),
    (s) => s.finishPercent,
  ).slice(0, max)
}

function lowFinishSubjects(grade, max = 3) {
  return withTasks(grade)
    .filter((s) => isNum(s.finishPercent) && s.finishPercent < LOW_FINISH)
    .sort((a, b) => a.finishPercent - b.finishPercent)
    .slice(0, max)
}

function lowMarkSubjects(grade, threshold, max = 5) {
  return withTasks(grade)
    .filter((s) => asZero(s.teacherMarkPercent) < threshold)
    .sort((a, b) => asZero(a.teacherMarkPercent) - asZero(b.teacherMarkPercent))
    .slice(0, max)
}

function doubleHighTeachers(grade, max = 5) {
  return sortByDesc(
    teachersOf(grade).filter(
      (t) =>
        isNum(t.finishPercent) &&
        t.finishPercent >= DOUBLE_HIGH_TEACHER.finish &&
        isNum(t.teacherMarkPercent) &&
        t.teacherMarkPercent >= DOUBLE_HIGH_TEACHER.mark,
    ),
    (t) => t.finishPercent,
  ).slice(0, max)
}

/** 任务量前 N 位教师（与教师对比图的取数口径一致：按任务量降序，同量按姓名） */
function topTaskTeachers(grade, max = 12) {
  return teachersOf(grade)
    .slice()
    .sort(
      (a, b) =>
        (asZero(b.taskCount) - asZero(a.taskCount)) ||
        String(a.name).localeCompare(String(b.name), 'zh'),
    )
    .slice(0, max)
}

function topMarkTeachers(grade, max = 3) {
  return sortByDesc(
    teachersOf(grade).filter(
      (t) => isNum(t.teacherMarkQuestionCount) && t.teacherMarkQuestionCount > 0,
    ),
    (t) => t.teacherMarkQuestionCount,
  ).slice(0, max)
}

function topTargetTeachers(grade, max = 3) {
  return sortByDesc(
    teachersOf(grade).filter((t) => isNum(t.target?.taskCount) && t.target.taskCount > 0),
    (t) => t.target.taskCount,
  ).slice(0, max)
}

function bookletLowFinishTeachers(grade, max = 4) {
  return teachersOf(grade)
    .filter(
      (t) => asZero(t.booklet?.taskCount) > 0 && isNum(t.booklet?.finishPercent) && t.booklet.finishPercent < 60,
    )
    .sort((a, b) => a.booklet.finishPercent - b.booklet.finishPercent)
    .slice(0, max)
}

/** 重练覆盖率最高学科：100% 优先，其次按覆盖率降序（同值按学科顺序） */
function primaryBookletSubject(grade) {
  const { list } = bookletStats(grade)
  const ranked = list
    .filter((s) => isNum(s.booklet?.coverPercent))
    .sort(
      (a, b) =>
        b.booklet.coverPercent - a.booklet.coverPercent ||
        subjectOrderIndex(grade, a) - subjectOrderIndex(grade, b),
    )
  if (!ranked.length) return null
  return ranked.find((s) => s.booklet.coverPercent >= 100) || ranked[0]
}

// ---------------------------------------------------------------- 文案片段

const fmtSubjectDouble = (s) => `${shortOf(s)}（${pct(s.finishPercent)}，${pct(s.teacherMarkPercent)}）`
const fmtSubjectFinish = (s) => `${shortOf(s)}（${pct(s.finishPercent)}）`
const fmtSubjectMark = (s) => `${shortOf(s)}（${pct(asZero(s.teacherMarkPercent))}）`
const fmtSubjectQuestions = (s) => `${shortOf(s)}（${num1(s.avgQuestionsByStudent)} 道）`
const fmtSubjectTarget = (s) => `${shortOf(s)}（${intStr(s.target?.questionCount)} 道）`
const fmtSubjectCover = (s) => `${shortOf(s)}（${pct(s.booklet?.coverPercent)}）`
const MARKED_TITLE_RE = /(老师|教师|主任|书记|校长|组长|备课组长|教研员|督学)$/
/** 姓名后已有职称的不再追加「教师」。中文姓名习惯连写（如「王小明」（86.2%，…）），
 *  不加「·」「：」等间隔符；源表姓氏字段可能自带职称，此时直接沿用。 */
const withTitle = (name) => {
  const text = String(name ?? '').trim()
  return MARKED_TITLE_RE.test(text) ? text : `${text}老师`
}
const fmtTeacherDouble = (t) => `${withTitle(t.name)}（${pct(t.finishPercent)}，${pct(t.teacherMarkPercent)}）`
const fmtTeacherMarkQ = (t) => `${withTitle(t.name)}（${intStr(t.teacherMarkQuestionCount)} 题）`
/** 靶向任务：题量为 0 时不得写成「题量 0 道」（发任务而无题，正式文件视为自相矛盾） */
const fmtTeacherTarget = (t) => {
  const tasks = intStr(t.target?.taskCount)
  const questions = asZero(t.target?.questionCount)
  return questions > 0
    ? `${withTitle(t.name)}发布靶向任务 ${tasks} 次，靶向习题 ${intStr(questions)} 道`
    : `${withTitle(t.name)}发布靶向任务 ${tasks} 次（未配置习题）`
}
const fmtTeacherBookletLow = (t) => `${withTitle(t.name)}（${pct(t.booklet?.finishPercent)}）`

const joinList = (items) => items.join('、')

function doubleHighTeacherSentence(grade) {
  const list = doubleHighTeachers(grade)
  if (!list.length) return '本周期无完成率与师阅率均达标的教师。'
  return `完成率与师阅率均达标的教师有${joinList(list.map(fmtTeacherDouble))}。`
}

function markTopSentence(grade) {
  const list = topMarkTeachers(grade)
  if (!list.length) return '阅卷量方面，本周期暂无师阅题目记录。'
  return `阅卷量方面，师阅题目最多的教师为${joinList(list.map(fmtTeacherMarkQ))}。`
}

function targetTopSentence(grade) {
  const list = topTargetTeachers(grade)
  if (!list.length) return '靶向教学方面，本周期未发布靶向任务。'
  return `靶向教学方面，${list.map(fmtTeacherTarget).join('；')}。`
}

// ---------------------------------------------------------------- 文档结构

/**
 * 图：HTML 版渲染内联 SVG；Markdown 版无法承载 SVG，改为「图题 + 一行说明 + 同源数据表」，
 * 保证两种载体信息等价（同取自 doc 模型中的同一份数据）。
 */
function figureBlock(ctx, svg, caption, data = null) {
  ctx.figures += 1
  return { t: 'fig', n: ctx.figures, svg, caption, data }
}

function coverKpis(ctx) {
  const { grades, totals } = ctx
  const finishRange = rangeText(grades.map((g) => summaryOf(g).finishPercent)) || '缺失'
  const markRange = rangeText(grades.map((g) => summaryOf(g).teacherMarkPercentAvg)) || '缺失'
  return [
    { label: '任务总量', value: `${intStr(totals.taskCount)} 次` },
    { label: '习题总量', value: `${intStr(totals.questionCount)} 道` },
    { label: '学科完成率区间', value: finishRange },
    { label: '师阅率均值区间', value: markRange },
  ]
}

function buildCover(ctx) {
  const { meta, grades, opts } = ctx
  const school = meta.siteTitle || meta.schoolAlias || meta.host || '学校'
  // 统计周期为时间起止，按 GB/T 15834 用一字线「—」；年级列表用顿号
  const period = dateRange(meta.from, meta.to)
  const gradeList = `（${grades.map((g) => gradeLabel(g)).join('、')}）`
  const source = meta.host ? `辅立码课 / 智慧教学云（${meta.host}）` : '辅立码课 / 智慧教学云'
  const generatedAt = opts.generatedAt || meta.generatedAt
  const footLines = [`数据来源：${source}`]
  if (generatedAt) footLines.push(`生成时间：${dateText(generatedAt)}`)
  const kpis = coverKpis(ctx)
  return {
    school,
    period,
    title: '辅立码课系统教学数据报告',
    gradeList,
    kpis,
    // 封面不出现 KPI 卡片与「·」分隔；正文引用口径时用分号分隔
    kpiLine: kpis.map((kpi) => `${kpi.label} ${kpi.value}`).join('；'),
    footLines,
  }
}

/** 「整体情况」章的主要结论：只写数据支持得住的判断 */
function mainConclusionBlocks(ctx) {
  const { grades } = ctx
  const blocks = []

  const sentences = []
  const withRates = grades.filter(
    (g) => isNum(summaryOf(g).finishPercent) && isNum(summaryOf(g).correctPercent),
  )
  if (withRates.length) {
    const gaps = withRates.map(
      (g) => asZero(summaryOf(g).finishPercent) - asZero(summaryOf(g).correctPercent),
    )
    const minGap = Math.min(...gaps)
    const maxGap = Math.max(...gaps)
    const gapText =
      Math.abs(maxGap - minGap) < 0.05
        ? `${minGap.toFixed(1)} 个百分点`
        : `${minGap.toFixed(1)}${TILDE}${maxGap.toFixed(1)} 个百分点`
    if (gaps.every((gap) => gap > 0)) {
      sentences.push(
        `各年级得分率均低于完成率，差距为 ${gapText}，作业提交情况较好，但正确率明显低于完成率，讲评与二次订正环节需加强。`,
      )
    } else {
      sentences.push(
        `各年级完成率与得分率相差 ${gapText}，完成情况与正确率之间尚未形成稳定对应关系。`,
      )
    }
  }

  const markRanked = sortByAsc(
    grades.filter((g) => isNum(summaryOf(g).teacherMarkPercentAvg)),
    (g) => summaryOf(g).teacherMarkPercentAvg,
  )
  if (markRanked.length) {
    const lowest = markRanked[0]
    const lowestValue = summaryOf(lowest).teacherMarkPercentAvg
    if (markRanked.length > 1) {
      const highest = markRanked[markRanked.length - 1]
      const highestValue = summaryOf(highest).teacherMarkPercentAvg
      sentences.push(
        `师阅率是当前最突出的薄弱环节：${gradeLabel(lowest)}学科师阅率均值仅 ${pct(lowestValue)}，为各年级最低，比最高的 ${gradeLabel(highest)}（${pct(highestValue)}）低 ${(highestValue - lowestValue).toFixed(1)} 个百分点。`,
      )
    } else {
      sentences.push(
        `师阅率方面，${gradeLabel(lowest)}学科师阅率均值为 ${pct(lowestValue)}，阅卷及时性仍需持续关注。`,
      )
    }
  }

  if (sentences.length) blocks.push({ t: 'p', text: sentences.join('') })

  const parts = []
  const missingPairs = grades
    .map((g) => ({ grade: g, list: missingSubjects(g) }))
    .filter((item) => item.list.length)
  if (missingPairs.length) {
    parts.push(
      `${joinList(missingPairs.map((item) => `${gradeLabel(item.grade)}${joinList(item.list.map(shortOf))}`))}整周未布置教学任务，基础教学与阅卷指标缺失，需在下一周期补足`,
    )
  }

  const targetRows = grades.map((g) => ({ grade: g, ...targetStats(g) }))
  const targetTotal = sumBy(targetRows, (row) => row.questionCount)
  if (targetTotal > 0) {
    const richest = sortByDesc(targetRows, (row) => row.questionCount)[0]
    const poorest = sortByAsc(targetRows, (row) => row.questionCount)[0]
    if (richest && poorest && richest.questionCount > poorest.questionCount) {
      parts.push(
        `靶向教学分布不均衡，${gradeLabel(richest.grade)}累计靶向习题 ${intStr(richest.questionCount)} 道，占各年级靶向习题总量的 ${pct((richest.questionCount / targetTotal) * 100)}，而 ${gradeLabel(poorest.grade)}仅 ${intStr(poorest.questionCount)} 道`,
      )
    } else {
      parts.push(`各年级靶向习题合计 ${intStr(targetTotal)} 道，整体使用仍偏少`)
    }
  } else {
    parts.push('各年级本周期均未开展靶向教学')
  }

  const trace = traceStats(ctx)
  if (trace.rows.length && !parts.length) {
    parts.push(
      `阅卷留痕率整体偏低，各年级学科留痕率均值为 ${pct(trace.mean)}，其中 ${intStr(trace.zeros.length)} 个学科为 0.0%`,
    )
  }
  if (parts.length) blocks.push({ t: 'p', text: `${parts.join('；')}。` })
  return blocks
}

/** 年级总览表 + 跨年级对比图 */
function gradeOverviewBlocks(ctx) {
  const { grades, totals } = ctx
  const rows = grades.map((g) => {
    const s = summaryOf(g)
    return [
      gradeLabel(g),
      intCell(s.taskCount),
      intCell(s.questionCount),
      numCell(s.dailyTask),
      pctCell(s.finishPercent),
      pctCell(s.correctPercent),
      pctCell(s.materialTaskRatio),
      pctCell(s.teacherMarkPercentAvg),
      intCell(doubleHighTeachers(g, 99).length),
    ]
  })
  const taskTotal = sumBy(grades, (g) => summaryOf(g).taskCount)
  const exerciseKnown = grades.some((g) => isNum(summaryOf(g).exerciseTaskCount))
  const exerciseTotal = sumBy(grades, (g) => summaryOf(g).exerciseTaskCount)
  const materialWeighted =
    exerciseKnown && taskTotal > 0
      ? (1 - exerciseTotal / taskTotal) * 100
      : weightedMean(grades, (g) => summaryOf(g).materialTaskRatio, (g) => summaryOf(g).taskCount)
  rows.push([
    '合计',
    intCell(totals.taskCount),
    intCell(totals.questionCount),
    numCell(totals.dailyTask),
    pctCell(weightedMean(grades, (g) => summaryOf(g).finishPercent, (g) => summaryOf(g).taskCount)),
    pctCell(
      weightedMean(grades, (g) => summaryOf(g).correctPercent, (g) => summaryOf(g).questionCount),
    ),
    pctCell(materialWeighted),
    '—',
    intCell(grades.reduce((acc, g) => acc + doubleHighTeachers(g, 99).length, 0)),
  ])
  return [
    {
      t: 'table',
      head: [
        '年级',
        '任务量（次）',
        '习题量（道）',
        '日均任务（次）',
        '完成率',
        '得分率',
        '资料任务占比',
        '师阅率均值',
        '双达标教师',
      ],
      aligns: ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
      widths: [11, 10, 10, 12, 10, 10, 14, 11, 12],
      totalRow: true,
      rows,
    },
    {
      t: 'small',
      text: `注：合计行的完成率、得分率与资料任务占比按相应任务量或习题量加权；师阅率均值不作跨年级合计；双达标教师指完成率与师阅率均达标（完成率不低于 80.0%、师阅率不低于 95.0%）的教师。`,
    },
  ]
}

function overallBlocks(ctx) {
  const { grades, totals, meta, model } = ctx
  const blocks = []
  const names = grades.map((g) => gradeLabel(g)).join('、')
  const gradeIntro = grades.length === 3 ? `${names}三个年级` : `${names}（共 ${grades.length} 个年级）`
  const gradeCountLabel = grades.length === 3 ? '三个年级' : `${grades.length} 个年级`
  const period = dateRange(meta.from, meta.to)
  const taskOrder = sortByDesc(grades, (g) => summaryOf(g).taskCount)
    .map((g) => `${gradeLabel(g)}（${intStr(summaryOf(g).taskCount)} 次）`)
    .join('、')
  const questionOrder = sortByDesc(grades, (g) => summaryOf(g).questionCount)
    .map((g) => `${gradeLabel(g)}（${intStr(summaryOf(g).questionCount)} 道）`)
    .join('、')
  blocks.push({
    t: 'p',
    text: `本报告覆盖 ${gradeIntro}，统计周期均为 ${period}（共 ${intStr(totals.days)} 天）。${gradeCountLabel}合计布置任务 ${intStr(totals.taskCount)} 次、习题 ${intStr(totals.questionCount)} 道，日均分别为 ${num1(totals.dailyTask)} 次、${num1(totals.dailyQuestion)} 道。`,
  })
  blocks.push({
    t: 'p',
    text: `任务量由高到低为 ${taskOrder}；习题量由高到低为 ${questionOrder}。`,
  })
  blocks.push({
    t: 'p',
    text: `任务平均完成率方面，${grades.map((g) => `${gradeLabel(g)} ${pct(summaryOf(g).finishPercent)}`).join('、')}；得分率方面，${grades.map((g) => `${gradeLabel(g)} ${pct(summaryOf(g).correctPercent)}`).join('、')}。`,
  })
  // 体例：先「主要结论」，后附年级总览表与对比图作为数据支撑（公文先结论、后佐证）
  blocks.push({ t: 'h2', text: '（一）主要结论' })
  blocks.push(...mainConclusionBlocks(ctx))
  blocks.push({ t: 'h2', text: '（二）年级总览' })
  blocks.push(...gradeOverviewBlocks(ctx))
  blocks.push(
    figureBlock(
      ctx,
      gradeCompareSvg(grades),
      '各年级完成率、得分率与师阅率均值对比',
      {
        head: ['年级', '完成率', '得分率', '师阅率均值'],
        aligns: ['l', 'r', 'r', 'r'],
        widths: [25, 25, 25, 25],
        rows: grades.map((g) => [
          gradeLabel(g),
          pctCell(summaryOf(g).finishPercent),
          pctCell(summaryOf(g).correctPercent),
          pctCell(summaryOf(g).teacherMarkPercentAvg),
        ]),
      },
    ),
  )
  blocks.push({
    t: 'p',
    text: `第二至第四章按年级分别展开，第五章为总结，文末为数据口径说明。`,
  })
  const warnings = Array.isArray(model?.warnings) ? model.warnings.filter(Boolean) : []
  if (warnings.length) {
    blocks.push({ t: 'note', text: `数据获取说明：${warnings.join('；')}。相关缺失指标已在正文相应位置注明。` })
  }
  return blocks
}

function overallGradeBlocks(grade, ctx) {
  const s = summaryOf(grade)
  const blocks = []
  const days = isNum(s.days) ? s.days : ctx.meta.days
  const period = dateRange(ctx.meta.from, ctx.meta.to)
  const classCount = isNum(grade.classCount) ? grade.classCount : 0
  let text = `本周期为 ${period}（共 ${intStr(days)} 天）的教学数据。${gradeLabel(grade)}布置任务总量为 ${intStr(s.taskCount)} 次，日均布置任务数为 ${num1(s.dailyTask)} 次`
  if (classCount > 0) {
    text += `，日均班均为 ${num1(s.dailyClassTask)} 次（按 ${classCount} 个行政班计）`
  }
  text += `；其中资料任务占比为 ${pct(s.materialTaskRatio)}，除去之后，布置习题总量为 ${intStr(s.questionCount)} 道，日均布置题量为 ${num1(s.dailyQuestion)} 道`
  if (classCount > 0) {
    text += `，日均班均为 ${num1(s.dailyClassQuestion)} 道题目`
  } else {
    text += `（未识别到行政班信息，班均数据从略）`
  }
  text += `。任务平均完成率为 ${pct(s.finishPercent)}，得分率平均为 ${pct(s.correctPercent)}。`
  blocks.push({ t: 'p', text })

  const missing = missingSubjects(grade)
  if (missing.length) {
    const names = joinList(missing.map(shortOf))
    const residual = missing
      .map((sub) => {
        const parts = []
        if (asZero(sub.watch?.count) > 0) parts.push('视频观看')
        if (asZero(sub.target?.taskCount) > 0 || asZero(sub.target?.questionCount) > 0) parts.push('靶向')
        return parts.length ? { name: shortOf(sub), parts } : null
      })
      .filter(Boolean)
    let extra = ''
    if (residual.length === 1) {
      extra = `（该学科仍有${residual[0].parts.join('与')}记录）`
    } else if (residual.length > 1) {
      extra = `（${residual.map((r) => `${r.name}仍有${r.parts.join('与')}记录`).join('，')}）`
    }
    blocks.push({
      t: 'p',
      text: `${names}本周期未布置任何教学任务，其基础教学、阅卷、错题重练等指标在源表中为空，报告中相应位置标注“缺失”${extra}。`,
    })
  }
  return blocks
}

// ---------------------------------------------------------------- 学科维度

/** 图表后的数据观察：比较生均题量高低与完成率之间的关系 */
function subjectLoadObservation(grade) {
  const subs = withTasks(grade).filter((s) => isNum(s.avgQuestionsByStudent))
  if (!subs.length) return '各学科生均习题量数据缺失，暂无法比较题量投入与完成情况的关系。'
  const meanLoad = meanBy(subs, (s) => s.avgQuestionsByStudent)
  const high = subs.filter(
    (s) => isNum(meanLoad) && s.avgQuestionsByStudent > meanLoad && isNum(s.finishPercent),
  )
  const low = subs.filter(
    (s) => isNum(meanLoad) && s.avgQuestionsByStudent <= meanLoad && isNum(s.finishPercent),
  )
  if (isNum(meanLoad) && high.length >= 2 && low.length >= 2) {
    const highFinish = meanBy(high, (s) => s.finishPercent)
    const lowFinish = meanBy(low, (s) => s.finishPercent)
    const relation =
      highFinish >= lowFinish
        ? '题量投入与完成率总体同向，未出现“题量越大、完成越差”的现象。'
        : '生均题量偏高的学科完成率反而偏低，需关注作业量与学生承受度的匹配。'
    // 分组完成率为简单平均，与图中「年级完成率均值」参考线（按任务量加权）口径不同，此处注明
    const weighted = summaryOf(grade).finishPercent
    const note = isNum(weighted) ? `（此二值为分组简单平均；图中参考线为按任务量加权的年级完成率 ${pct(weighted)}）` : ''
    return `由上图可见，生均题量高于本年级学科均值（${num1(meanLoad)} 道）的 ${high.length} 个学科，完成率平均为 ${pct(highFinish)}；低于均值的 ${low.length} 个学科为 ${pct(lowFinish)}${note}。${relation}`
  }
  const top = sortByDesc(subs, (s) => s.avgQuestionsByStudent)[0]
  return `由上图可见，生均题量最高的学科为${fmtSubjectQuestions(top)}，其完成率为 ${pct(top.finishPercent)}、师阅率为 ${pct(asZero(top.teacherMarkPercent))}。`
}

function subjectBasics(grade, ctx) {
  const blocks = []
  const subs = withTasks(grade)

  // 生均题量：最多 3 个 / 最少 2 个
  const ranked = sortByDesc(
    subs.filter((s) => isNum(s.avgQuestionsByStudent)),
    (s) => s.avgQuestionsByStudent,
  )
  if (ranked.length) {
    const top = ranked.slice(0, 3)
    const bottom =
      ranked.length > 3
        ? ranked
            .slice(3)
            .sort((a, b) => a.avgQuestionsByStudent - b.avgQuestionsByStudent)
            .slice(0, 2)
        : []
    let text = `生均题量：生均题量最多的学科为${joinList(top.map(fmtSubjectQuestions))}`
    if (bottom.length) text += `；最少的为${joinList(bottom.map(fmtSubjectQuestions))}`
    blocks.push({ t: 'p', text: `${text}。` })
  } else {
    blocks.push({ t: 'p', text: '生均题量：本周期各学科暂无有效的生均题量数据。' })
  }

  blocks.push(
    figureBlock(
      ctx,
      subjectOverviewSvg(grade),
      '各学科生均习题量与完成率、师阅率对比',
      {
        head: ['学科', '生均题量（道）', '完成率', '师阅率'],
        aligns: ['l', 'r', 'r', 'r'],
        widths: [22, 26, 26, 26],
        rows: withTasks(grade).map((s) => [
          s.name || shortOf(s),
          numCell(s.avgQuestionsByStudent),
          pctCell(s.finishPercent),
          pctCell(s.teacherMarkPercent),
        ]),
      },
    ),
  )
  blocks.push({ t: 'p', text: subjectLoadObservation(grade) })

  // 完成率
  const high = highFinishSubjects(grade, 4)
  const low = lowFinishSubjects(grade, 3)
  const highText = high.length
    ? `完成率较高的学科为${joinList(high.map(fmtSubjectFinish))}`
    : '无完成率达到 85.0% 的学科'
  const lowText = low.length
    ? `完成率偏低的学科为${joinList(low.map(fmtSubjectFinish))}`
    : '无完成率低于 75.0% 的学科'
  blocks.push({ t: 'p', text: `完成率：${highText}；${lowText}。` })

  // 师阅率
  const avgMark = isNum(summaryOf(grade).teacherMarkPercentAvg)
    ? summaryOf(grade).teacherMarkPercentAvg
    : meanBy(subs, (s) => s.teacherMarkPercent)
  if (isNum(avgMark)) {
    const below = lowMarkSubjects(grade, avgMark, 5)
    blocks.push({
      t: 'p',
      text: below.length
        ? `师阅率：${gradeLabel(grade)}各学科平均师阅率为 ${pct(avgMark)}。低于该值的学科为${joinList(below.map(fmtSubjectMark))}。`
        : `师阅率：${gradeLabel(grade)}各学科平均师阅率为 ${pct(avgMark)}，无低于该值的学科。`,
    })
  } else {
    blocks.push({ t: 'p', text: `师阅率：${gradeLabel(grade)}各学科师阅数据缺失。` })
  }

  // 阅卷留痕率（null 视为 0，非 0 学科降序列出）
  const traced = subs
    .filter((s) => asZero(s.tracePercent) > 0)
    .sort((a, b) => asZero(b.tracePercent) - asZero(a.tracePercent))
  // 未布置任务的学科（如 2024 级地理）同样计入「其余学科为 0」，与参考报告口径一致
  const zeroTrace = subjectsOf(grade).filter((s) => !(asZero(s.tracePercent) > 0))
  if (traced.length) {
    let text = `阅卷留痕率：${joinList(traced.map((s) => `${shortOf(s)}（${pct(s.tracePercent)}）`))}`
    text += zeroTrace.length ? `；其余学科为 0（${joinList(zeroTrace.map(shortOf))}）。` : '。'
    blocks.push({ t: 'p', text })
  } else {
    blocks.push({
      t: 'p',
      text: '阅卷留痕率：本周期所有学科阅卷留痕率均为 0.0%，主观题批改留痕有待加强。',
    })
  }
  return blocks
}

function bookletTargetBlocks(grade) {
  const blocks = []
  const booklet = bookletStats(grade)
  if (booklet.list.length) {
    const ranked = booklet.list
      .filter((s) => isNum(s.booklet?.coverPercent))
      .sort(
        (a, b) =>
          b.booklet.coverPercent - a.booklet.coverPercent ||
          subjectOrderIndex(grade, a) - subjectOrderIndex(grade, b),
      )
    const primary = ranked.find((s) => s.booklet.coverPercent >= 100) || ranked[0]
    let text = `重练覆盖率：${gradeLabel(grade)}共 ${booklet.list.length} 个学科布置了错题重练任务，累计 ${intStr(booklet.total)} 次`
    if (primary) {
      const rest = ranked.filter((s) => s !== primary).slice(0, 3)
      text += `；覆盖率最高的学科为${fmtSubjectCover(primary)}`
      if (rest.length) text += `，其余学科为${joinList(rest.map(fmtSubjectCover))}`
      text += '。'
    } else {
      text += '。'
    }
    blocks.push({ t: 'p', text })
  } else {
    blocks.push({ t: 'p', text: `重练覆盖率：${gradeLabel(grade)}本周期未布置错题重练任务。` })
  }

  const target = targetStats(grade)
  if (target.taskCount > 0 || target.questionCount > 0) {
    const top = sortByDesc(target.list, (s) => s.target.questionCount).slice(0, 3)
    let text = `靶向任务：${gradeLabel(grade)}累计发布靶向任务 ${intStr(target.taskCount)} 次、靶向习题 ${intStr(target.questionCount)} 道`
    if (top.length) text += `；靶向习题量较多的学科为${joinList(top.map(fmtSubjectTarget))}`
    blocks.push({ t: 'p', text: `${text}。` })
  } else {
    blocks.push({ t: 'p', text: `靶向任务：${gradeLabel(grade)}本周期未发布靶向任务。` })
  }

  const resource = resourceStats(grade)
  blocks.push({
    t: 'p',
    text: `资源建设：本周期知识点关联 ${intStr(resource.tag)} 次，音频讲解 ${intStr(resource.audio)} 次，视频讲解 ${intStr(resource.video)} 次。`,
  })
  return blocks
}

function selfStudyBlocks(grade) {
  const blocks = []
  const subs = subjectsOf(grade)
  const rows = subs.map((s) => [
    s.name || shortOf(s),
    intCell(s.self?.personCount),
    intCell(s.self?.questionCount),
    intCell(s.watch?.count),
    s.watch?.durationText || '—',
  ])
  blocks.push({
    t: 'table',
    head: ['学科', '自学人次', '自学题量', '观看人次', '观看时长'],
    aligns: ['l', 'r', 'r', 'r', 'r'],
    widths: [26, 19, 19, 17, 19],
    rows,
  })

  const s = summaryOf(grade)
  const top = grade.selfStudy?.top || null
  const totalPerson = isNum(s.selfPersonCount)
    ? s.selfPersonCount
    : isNum(grade.selfStudy?.totalPersonCount)
      ? grade.selfStudy.totalPersonCount
      : sumBy(subs, (x) => x.self?.personCount)
  const totalQuestion = isNum(s.selfQuestionCount)
    ? s.selfQuestionCount
    : isNum(grade.selfStudy?.totalQuestionCount)
      ? grade.selfStudy.totalQuestionCount
      : sumBy(subs, (x) => x.self?.questionCount)
  const watchCount = isNum(s.watchCount) ? s.watchCount : sumBy(subs, (x) => x.watch?.count)
  const durationMin = isNum(s.watchDurationMin)
    ? s.watchDurationMin
    : sumBy(subs, (x) => x.watch?.durationMin)
  const durationText = s.watchDurationText || grade.watch?.durationText || formatMinutes(durationMin)
  const hours = isNum(s.watchHours) ? s.watchHours : toHours(durationMin)

  let text = `小结：${gradeLabel(grade)}学生主动开展自学 ${intStr(totalPerson)} 人次、完成自学题目 ${intStr(totalQuestion)} 道`
  if (top) {
    text += `；自学最活跃的学科为${top.short || shortOf(top)}（${intStr(top.personCount)} 人次、${intStr(top.questionCount)} 道，占本年级自学人次的 ${pct(top.sharePercent)}）`
  }
  text += `。观看视频共 ${intStr(watchCount)} 人次，累计时长 ${durationText}（时：分），约 ${num1(hours)} 小时。`
  blocks.push({ t: 'p', text })
  return blocks
}

/** 学科关键指标汇总：9 个学科全部列出，缺失学科保留行并以「—」标注 */
function subjectMetricsBlocks(grade) {
  const rows = subjectsOf(grade).map((subject) => {
    if (isMissingSubject(subject)) {
      return [subject.name || shortOf(subject), '—', '—', '—', '—', '—', '—', '—', '—']
    }
    return [
      subject.name || shortOf(subject),
      intCell(subject.taskCount),
      numCell(subject.avgQuestionsByStudent),
      pctCell(subject.finishPercent),
      pctCell(subject.correctPercent),
      pctCell(subject.teacherMarkPercent),
      pct(asZero(subject.tracePercent)),
      pctCell(subject.booklet?.coverPercent),
      intCell(subject.target?.questionCount),
    ]
  })
  const missing = missingSubjects(grade)
  const missingNote = missing.length
    ? `${joinList(missing.map(shortOf))}整周未布置任务，整行以「—」标注`
    : '本周期各学科均有教学任务'
  return [
    {
      t: 'table',
      head: [
        '学科',
        '任务量',
        '生均题量',
        '完成率',
        '得分率',
        '师阅率',
        '留痕率',
        '重练覆盖率',
        '靶向习题量',
      ],
      aligns: ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
      widths: [15, 10, 10, 10, 10, 13, 10, 11, 11],
      rows,
    },
    {
      t: 'small',
      text: `注：任务量单位为次、生均题量单位为道、靶向习题量单位为道；留痕率的空值按 0.0% 口径展示，未布置重练任务的学科其重练覆盖率以「—」表示；${missingNote}。`,
    },
  ]
}

// ---------------------------------------------------------------- 教师维度

function teacherBasics(grade, ctx) {
  const blocks = []
  const doubleHigh = doubleHighTeachers(grade)
  if (doubleHigh.length) {
    blocks.push({
      t: 'p',
      text: `完成率与师阅率均达标的教师（完成率不低于 80.0%、师阅率不低于 95.0%）有${joinList(doubleHigh.map(fmtTeacherDouble))}。`,
    })
  } else {
    blocks.push({
      t: 'p',
      text: `本周期未出现完成率与师阅率均达标的教师（口径为完成率不低于 80.0%、师阅率不低于 95.0%），阅卷及时性有待提升。`,
    })
  }
  blocks.push({ t: 'p', text: markTopSentence(grade) })
  blocks.push({ t: 'p', text: targetTopSentence(grade) })
  // 分析文字置于图前，可利用上一页余量；图与图注始终作为整体换页
  blocks.push(
    figureBlock(
      ctx,
      teacherOverviewSvg(grade),
      '任务量前 12 位教师的完成率与师阅率对比',
      {
        head: ['教师', '任务量（次）', '完成率', '师阅率'],
        aligns: ['l', 'r', 'r', 'r'],
        widths: [22, 26, 26, 26],
        rows: topTaskTeachers(grade, 12).map((t) => [
          t.name,
          intCell(t.taskCount),
          pctCell(t.finishPercent),
          pctCell(t.teacherMarkPercent),
        ]),
      },
    ),
  )
  return blocks
}

function teacherBookletBlocks(grade) {
  const blocks = []
  const teachers = teachersOf(grade)
  const withBooklet = teachers.filter((t) => asZero(t.booklet?.taskCount) > 0)
  if (withBooklet.length) {
    const total = sumBy(withBooklet, (t) => t.booklet.taskCount)
    const over80 = withBooklet.filter(
      (t) => isNum(t.booklet?.coverPercent) && t.booklet.coverPercent > 80,
    ).length
    const lowAll = bookletLowFinishTeachers(grade, 99)
    const low = lowAll.slice(0, 4)
    const idleAccounts = allTeachersOf(grade).length - teachers.length
    const idleText = idleAccounts > 0 ? `，另有 ${idleAccounts} 个无任务记录的账号未计入` : ''
    let text = `错题重练方面，${gradeLabel(grade)}本周期有任务记录的 ${teachers.length} 位教师中，${withBooklet.length} 位布置了重练任务${idleText}，累计 ${intStr(total)} 次，重练覆盖率高于 80.0% 的教师 ${over80} 位；`
    text += lowAll.length
      ? `完成率低于 60.0% 的教师共 ${lowAll.length} 位（${lowAll.length > 4 ? '完成率最低的 4 位为' : ''}${joinList(low.map(fmtTeacherBookletLow))}），建议重点关注。`
      : '本周期无完成率低于 60.0% 的教师，整体提交情况较好。'
    blocks.push({ t: 'p', text })
  } else {
    blocks.push({ t: 'p', text: `错题重练方面，${gradeLabel(grade)}本周期未布置错题重练任务。` })
  }
  return blocks
}

function gradeSummaryBlocks(grade) {
  const blocks = []
  const s = summaryOf(grade)
  const classCount = isNum(grade.classCount) ? grade.classCount : 0
  let text = `本周期，${gradeLabel(grade)}布置任务 ${intStr(s.taskCount)} 次（日均 ${num1(s.dailyTask)} 次`
  if (classCount > 0) text += `、日均班均 ${num1(s.dailyClassTask)} 次`
  text += `），习题 ${intStr(s.questionCount)} 道（日均 ${num1(s.dailyQuestion)} 道），资料任务占比 ${pct(s.materialTaskRatio)}，任务平均完成率 ${pct(s.finishPercent)}，得分率 ${pct(s.correctPercent)}。`
  blocks.push({ t: 'p', text })

  const subs = withTasks(grade)
  const teachers = teachersOf(grade)
  const points = []

  // 1. 学科表现
  const finishGap = asZero(s.finishPercent) - asZero(s.correctPercent)
  const highCount = highFinishSubjects(grade, 99).length
  const lowFinishCount = lowFinishSubjects(grade, 99).length
  const avgMark = isNum(s.teacherMarkPercentAvg)
    ? s.teacherMarkPercentAvg
    : meanBy(subs, (x) => x.teacherMarkPercent)
  const aboveMarkCount = isNum(avgMark)
    ? subs.filter((x) => asZero(x.teacherMarkPercent) >= avgMark).length
    : 0
  if (subs.length) {
    points.push(
      `学科表现：${subs.length} 个学科中，完成率不低于 85.0% 的 ${highCount} 个、低于 75.0% 的 ${lowFinishCount} 个，师阅率不低于年级均值 ${isNum(avgMark) ? pct(avgMark) : '—'} 的 ${aboveMarkCount} 个；完成率与得分率相差 ${finishGap.toFixed(1)} 个百分点。`,
    )
  }

  // 2. 教学闭环
  const booklet = bookletStats(grade)
  const target = targetStats(grade)
  const lowCoverCount = booklet.list.filter(
    (x) => isNum(x.booklet?.coverPercent) && x.booklet.coverPercent < 60,
  ).length
  const targetShare =
    isNum(target.questionCount) && asZero(s.questionCount) > 0
      ? (target.questionCount / s.questionCount) * 100
      : null
  const coverText =
    lowCoverCount > 0
      ? `，其中 ${lowCoverCount} 个学科覆盖率低于 60.0%`
      : '，各学科覆盖率均不低于 60.0%'
  points.push(
    `教学闭环：${booklet.list.length} 个学科布置错题重练、累计 ${intStr(booklet.total)} 次${coverText}；靶向任务 ${intStr(target.taskCount)} 次、靶向习题 ${intStr(target.questionCount)} 道${isNum(targetShare) ? `，约占本年级习题量的 ${pct(targetShare)}` : ''}。`,
  )

  // 3. 教师使用
  const withBooklet = teachers.filter((t) => asZero(t.booklet?.taskCount) > 0)
  const doubleHighCount = doubleHighTeachers(grade, 99).length
  const lowBookletTeachers = bookletLowFinishTeachers(grade, 99).length
  const topMark = topMarkTeachers(grade, 3)
  const markQuestionTotal = sumBy(teachers, (t) => t.teacherMarkQuestionCount)
  const topMarkShare =
    markQuestionTotal > 0
      ? (sumBy(topMark, (t) => t.teacherMarkQuestionCount) / markQuestionTotal) * 100
      : null
  const doubleHighText =
    doubleHighCount > 0
      ? `完成率与师阅率均达标教师 ${doubleHighCount} 位`
      : '完成率与师阅率均达标教师为 0 位，阅卷及时性需提升'
  const markText = isNum(topMarkShare)
    ? `师阅题目量前 3 位合计占本年级师阅总量的 ${pct(topMarkShare)}`
    : '本周期暂无师阅题目记录'
  // 分母只计本周期有任务记录的教师，并显式点明未计入的账号数
  const idleAccounts = allTeachersOf(grade).length - teachers.length
  const idleText = idleAccounts > 0 ? `（另有 ${idleAccounts} 个无任务记录的账号未计入）` : ''
  const bookletTeacherText =
    teachers.length > 0 && withBooklet.length === teachers.length
      ? `本周期有任务记录的 ${teachers.length} 位教师均布置了错题重练任务${idleText}`
      : `本周期有任务记录的 ${teachers.length} 位教师中 ${withBooklet.length} 位布置了错题重练任务${idleText}`
  points.push(`教师使用：${bookletTeacherText}；${doubleHighText}；${markText}。`)

  // 4. 需重点关注（只给数量与位置，不重复前文名单）
  const watch = []
  const missing = missingSubjects(grade)
  if (missing.length) watch.push(`${joinList(missing.map(shortOf))}整周未布置教学任务`)
  const zeroMarkSubjects = subs.filter((x) => asZero(x.teacherMarkPercent) === 0)
  if (zeroMarkSubjects.length > 0) {
    // 学科数不超过 3 个时直接点名，便于责任到学科；超过 3 个只给数量，避免清单冗长
    watch.push(
      zeroMarkSubjects.length <= 3
        ? `${joinList(zeroMarkSubjects.map(shortOf))}师阅率为 0.0%`
        : `${zeroMarkSubjects.length} 个学科师阅率为 0.0%`,
    )
  }
  const zeroTraceSubjects = subs.filter((x) => asZero(x.tracePercent) === 0)
  if (zeroTraceSubjects.length > 0) {
    watch.push(
      zeroTraceSubjects.length <= 3
        ? `${joinList(zeroTraceSubjects.map(shortOf))}阅卷留痕率为 0.0%`
        : `${zeroTraceSubjects.length} 个有任务学科阅卷留痕率为 0.0%`,
    )
  }
  if (lowBookletTeachers > 0) watch.push(`${lowBookletTeachers} 位教师重练完成率低于 60.0%`)
  if (isNum(targetShare) && targetShare < 5) watch.push('靶向教学使用偏少')
  points.push(
    watch.length
      ? `需重点关注：${joinList(watch)}；名单见本章（二）（三），建议下一周期跟进。`
      : '需重点关注：本周期未发现整周缺任务、师阅率为 0 的学科，教师重练完成情况整体达标，建议保持当前节奏。',
  )

  blocks.push({ t: 'ul', items: points })
  return blocks
}

// ---------------------------------------------------------------- 末章（四、总结）

function summaryBlocks(ctx) {
  const { grades, totals } = ctx
  const blocks = []
  const gradeCountLabel = grades.length === 3 ? '三个年级' : '各年级'

  // （一）任务与习题规模
  blocks.push({ t: 'h2', text: '（一）任务与习题规模' })
  const taskOrder = sortByDesc(grades, (g) => summaryOf(g).taskCount)
    .map((g) => `${gradeLabel(g)}（${intStr(summaryOf(g).taskCount)} 次）`)
    .join('、')
  blocks.push({
    t: 'p',
    text: `${gradeCountLabel}合计布置任务 ${intStr(totals.taskCount)} 次、习题 ${intStr(totals.questionCount)} 道，日均分别为 ${num1(totals.dailyTask)} 次、${num1(totals.dailyQuestion)} 道。任务量由高到低为 ${taskOrder}；资料任务占比分别为 ${grades.map((g) => `${gradeLabel(g)} ${pct(summaryOf(g).materialTaskRatio)}`).join('、')}。`,
  })

  // （二）完成率与得分率
  blocks.push({ t: 'h2', text: '（二）完成率与得分率' })
  const gaps = grades.map((g) => ({
    g,
    gap: asZero(summaryOf(g).finishPercent) - asZero(summaryOf(g).correctPercent),
  }))
  const gapValues = gaps.map((x) => x.gap)
  const minGap = Math.min(...gapValues)
  const maxGap = Math.max(...gapValues)
  const gapRangeText =
    Math.abs(maxGap - minGap) < 0.05
      ? `${minGap.toFixed(1)}`
      : `${minGap.toFixed(1)}${TILDE}${maxGap.toFixed(1)}`
  const allBelow = gapValues.every((v) => v > 0)
  const gapSentence = allBelow
    ? `${gradeCountLabel}得分率均低于完成率 ${gapRangeText} 个百分点，作业提交情况较好，但正确率明显低于完成率，需在讲评与二次订正环节加强。`
    : `${gradeCountLabel}完成率与得分率相差 ${gapRangeText} 个百分点，正确率与完成率尚未形成稳定对应关系，需在讲评与二次订正环节加强。`
  blocks.push({
    t: 'p',
    text: `完成率：${grades.map((g) => `${gradeLabel(g)} ${pct(summaryOf(g).finishPercent)}`).join('、')}；得分率：${grades.map((g) => `${gradeLabel(g)} ${pct(summaryOf(g).correctPercent)}`).join('、')}。${gapSentence}`,
  })

  // （三）错题重练、靶向教学与自学
  blocks.push({ t: 'h2', text: '（三）错题重练、靶向教学与自学' })
  const targetByGrade = grades.map((g) => ({ g, ...targetStats(g) }))
  const maxTarget = sortByDesc(targetByGrade, (x) => x.questionCount)[0]
  const maxSelf = sortByDesc(grades, (g) => summaryOf(g).selfPersonCount)[0]
  const minBooklet = sortByAsc(grades, (g) => totalBookletOf(g))[0]
  if (maxTarget && maxSelf && minBooklet) {
    blocks.push({
      t: 'p',
      text: `三个年级中，${gradeLabel(maxTarget.g)}靶向习题最多（${intStr(maxTarget.questionCount)} 道），${gradeLabel(maxSelf)}自学最活跃（${intStr(summaryOf(maxSelf).selfPersonCount)} 人次、${intStr(summaryOf(maxSelf).selfQuestionCount)} 道），${gradeLabel(minBooklet)}错题重练次数最少（${intStr(totalBookletOf(minBooklet))} 次）。`,
    })
  }
  const rows = grades.map((g) => {
    const s = summaryOf(g)
    return [
      gradeLabel(g),
      intCell(totalBookletOf(g)),
      intCell(targetStats(g).questionCount),
      intCell(s.selfPersonCount),
      intCell(s.selfQuestionCount),
      intCell(s.watchCount),
      gradeWatchText(g),
    ]
  })
  rows.push([
    '合计',
    intCell(sumBy(grades, (g) => totalBookletOf(g))),
    intCell(sumBy(targetByGrade, (x) => x.questionCount)),
    intCell(sumBy(grades, (g) => summaryOf(g).selfPersonCount)),
    intCell(sumBy(grades, (g) => summaryOf(g).selfQuestionCount)),
    intCell(sumBy(grades, (g) => summaryOf(g).watchCount)),
    totals.watchDurationText || formatMinutes(totals.watchDurationMin),
  ])
  blocks.push({
    t: 'table',
    head: [
      '年级',
      '错题重练次数',
      '靶向习题（道）',
      '自学人次',
      '自学题量（道）',
      '观看人次',
      '观看时长（时:分）',
    ],
    aligns: ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
    widths: [11, 16, 13, 13, 14, 12, 21],
    totalRow: true,
    rows,
  })

  // （四）共性问题与建议
  blocks.push({ t: 'h2', text: '（四）共性问题与建议' })
  // 建议条款：序号由 HTML 的「（一）（二）」式与 Markdown 的阿拉伯数字各自渲染
  blocks.push({ t: 'ol', ordered: 'cn', items: adviceItems(ctx) })
  return blocks
}

function gradeWatchText(grade) {
  const s = summaryOf(grade)
  return s.watchDurationText || grade.watch?.durationText || formatMinutes(s.watchDurationMin)
}

function adviceItems(ctx) {
  const { grades, totals } = ctx
  const gradeCountLabel = grades.length === 3 ? '三个年级' : '各年级'
  const items = []

  // 1. 阅卷环节
  const markAvgList = grades
    .map((g) => `${gradeLabel(g)} ${pct(summaryOf(g).teacherMarkPercentAvg)}`)
    .join('、')
  const zeroMark = []
  for (const g of grades) {
    for (const s of withTasks(g)) {
      if (asZero(s.teacherMarkPercent) === 0) zeroMark.push(`${gradeLabel(g)}${shortOf(s)}`)
    }
  }
  const zeroMarkText = zeroMark.length
    ? `，其中 ${joinList(zeroMark.slice(0, 3))}等学科的师阅率为 0.0%`
    : ''
  const markRanked = sortByAsc(
    grades.filter((g) => isNum(summaryOf(g).teacherMarkPercentAvg)),
    (g) => summaryOf(g).teacherMarkPercentAvg,
  )
  const markSpread =
    markRanked.length > 1
      ? (
          summaryOf(markRanked[markRanked.length - 1]).teacherMarkPercentAvg -
          summaryOf(markRanked[0]).teacherMarkPercentAvg
        ).toFixed(1)
      : null
  const markSpreadText =
    markSpread !== null ? `，年级间最高与最低相差 ${markSpread} 个百分点` : ''
  const lowMarkSubjectCount = grades.reduce(
    (acc, g) =>
      acc +
      withTasks(g).filter(
        (s) => asZero(s.teacherMarkPercent) > 0 && asZero(s.teacherMarkPercent) < 30,
      ).length,
    0,
  )
  const lowMarkText =
    lowMarkSubjectCount > 0 ? `，另有 ${lowMarkSubjectCount} 个学科师阅率低于 30.0%` : ''
  items.push(
    `阅卷环节是${gradeCountLabel}的共同薄弱环节，学科平均师阅率分别为 ${markAvgList}${markSpreadText}${zeroMarkText}${lowMarkText}；建议按周公示各学科阅卷完成情况，将师阅率纳入教学常规检查，并对师阅率明显偏低的学科逐科约谈。`,
  )

  // 2. 阅卷留痕率
  const traceAvgList = grades
    .map((g) => `${gradeLabel(g)} ${pct(meanBy(withTasks(g), (s) => asZero(s.tracePercent)))}`)
    .join('、')
  let zeroTraceCount = 0
  for (const g of grades) {
    for (const s of withTasks(g)) if (asZero(s.tracePercent) === 0) zeroTraceCount += 1
  }
  items.push(
    `“阅卷留痕率”整体偏低，${gradeCountLabel}学科留痕率均值分别为 ${traceAvgList}，共有 ${zeroTraceCount} 个学科为 0.0%；建议统一要求主观题批改留痕，便于教研复盘与学情回溯。`,
  )

  // 3. 错题重练
  const bookletParts = grades
    .map((g) => `${gradeLabel(g)} ${bookletStats(g).list.length} 个学科（累计 ${intStr(totalBookletOf(g))} 次）`)
    .join('、')
  const lowCover = []
  for (const g of grades) {
    for (const s of bookletStats(g).list) {
      if (isNum(s.booklet?.coverPercent) && s.booklet.coverPercent < 60) {
        lowCover.push({ g, s, value: s.booklet.coverPercent })
      }
    }
  }
  lowCover.sort((a, b) => a.value - b.value)
  const lowCoverText = lowCover.length
    ? `${joinList(lowCover.slice(0, 3).map((x) => `${gradeLabel(x.g)}${shortOf(x.s)}（${pct(x.value)}）`))}等学科的重练覆盖率低于 60.0%`
    : '部分学科的重练覆盖率仍不足'
  const lowFinishBookletTeachers = []
  for (const g of grades) {
    for (const t of bookletLowFinishTeachers(g, 99)) {
      lowFinishBookletTeachers.push({ g, t })
    }
  }
  const worstBookletTeacher = sortByAsc(
    lowFinishBookletTeachers,
    (x) => x.t.booklet.finishPercent,
  )[0]
  const worstBookletText = worstBookletTeacher
    ? `，最低为 ${gradeLabel(worstBookletTeacher.g)}${worstBookletTeacher.t.name}（${pct(worstBookletTeacher.t.booklet.finishPercent)}）`
    : ''
  items.push(
    `错题重练的覆盖面与完成情况仍不均衡，${bookletParts}布置了重练任务，但 ${lowCoverText}；全年级共有 ${lowFinishBookletTeachers.length} 位教师重练任务完成率低于 60.0%${worstBookletText}；建议在每次周测后固定安排一次错题重练任务，形成“测—练—评”闭环。`,
  )

  // 4. 靶向教学不均衡
  const targetByGrade = grades.map((g) => ({
    g,
    taskCount: targetStats(g).taskCount,
    questionCount: targetStats(g).questionCount,
  }))
  const targetTotal = sumBy(targetByGrade, (x) => x.questionCount)
  const maxTarget = sortByDesc(targetByGrade, (x) => x.questionCount)[0]
  const minTarget = sortByAsc(targetByGrade, (x) => x.questionCount)[0]
  if (maxTarget && minTarget && maxTarget.questionCount > 0 && targetTotal > 0) {
    const topSubject = sortByDesc(
      targetStats(maxTarget.g).list,
      (s) => s.target.questionCount,
    )[0]
    const topSubjectText = topSubject
      ? `，其中${shortOf(topSubject)} ${intStr(topSubject.target.questionCount)} 道、占该年级靶向习题量的 ${pct((topSubject.target.questionCount / maxTarget.questionCount) * 100)}`
      : ''
    items.push(
      `靶向教学使用不均衡，${gradeLabel(minTarget.g)}累计发布靶向任务 ${intStr(minTarget.taskCount)} 次、靶向习题 ${intStr(minTarget.questionCount)} 道，而 ${gradeLabel(maxTarget.g)}为 ${intStr(maxTarget.taskCount)} 次、${intStr(maxTarget.questionCount)} 道，占各年级靶向习题总量的 ${pct((maxTarget.questionCount / targetTotal) * 100)}${topSubjectText}；建议结合学情数据扩大靶向班与靶向学生的覆盖范围。`,
    )
  } else {
    items.push(
      `靶向教学整体使用偏少，${gradeCountLabel}累计靶向习题仅 ${intStr(targetTotal)} 道，个别年级几乎未开展；建议结合学情数据扩大靶向班与靶向学生的覆盖范围。`,
    )
  }
  return items
}

// ---------------------------------------------------------------- 附录：数据口径

function appendixBlocks() {
  // 逐条编号，并与正文相应位置一一对应（每条末尾注明对应章节，便于复核）
  return [
    {
      t: 'p',
      text: '本报告各项指标的统计与计算口径如下，逐条对应正文相应位置，供复核与跨周期对比时参考。',
    },
    {
      t: 'notelist',
      items: [
        '任务量与习题量：取自平台「学科基本教学」表，按学科合计。任务量包含资料任务与习题任务，习题量不含资料任务。（对应第一章及各年级「（一）整体情况」）',
        '资料任务占比：即任务中资料类任务所占比例，以 1 减习题任务数除以任务量计算，数值越高表示资料类任务越多。（对应第一章及各年级「（一）整体情况」）',
        '日均任务与班均任务：日均任务以任务量除以统计天数计算；日均班均任务以任务量除以统计天数与行政班数之积计算。日均题量与班均题量的计算方式相同。（对应各年级「（一）整体情况」）',
        '任务平均完成率与得分率：任务平均完成率为各学科完成率按任务量加权；得分率为各学科得分率按习题量加权，均采用平台统计口径，不等同于各学科的简单平均。（对应第一章「（一）主要结论」及第五章「（二）完成率与得分率」）',
        '师阅率与师阅率均值：师阅率指教师已批阅题目占应交题目的比例，正文首次出现处括注「教师已阅题目占比」；师阅率均值为各学科师阅率的简单平均（忽略空值）。封面「学科完成率区间」与「师阅率均值区间」分别为各年级上述两项指标的最小值至最大值，数值范围以浪纹线「～」标示。（对应封面及各年级「（二）学科维度统计」）',
        '图的参考线与正文口径的差异：各年级学科对比图与教师对比图中的均值线、达标线为图表参考线。学科图的两条均值线为该年级有效学科的简单平均，而正文「任务平均完成率」为按任务量加权，两者口径不同，数值可能不一致；正文分组比较（生均题量高于或低于学科均值的两组）亦为简单平均，已在相应段落括注说明。教师图的 80.0% 与 95.0% 两条线为完成率与师阅率的达标阈值，用于目视判断，不作为统计结果。（对应各年级「（二）学科维度统计」与「（三）教师维度统计」）',
        '阅卷留痕率：即主观题批改中留下批改痕迹的题目占比。正文与学科关键指标表均对空值按 0.0% 口径展示；整周未布置任务的学科整行以「—」标注；空值占位符与统计周期所用的一字线同为「—」，数值区间另用浪纹线「～」，全篇不混用其它横线符号。（对应各年级「（二）学科维度统计」）',
        '靶向教学：靶向任务为面向靶向班或靶向学生发布的任务，靶向习题为其所配习题量。存在仅有任务记录、未配置习题的情形，正文对题量为 0 的教师注明「未配置习题」，不以「0 道」表述。（对应各年级「（三）教师维度统计」及第五章「（四）共性问题与建议」）',
        '教师统计口径：教师维度的全部比例（布置重练任务教师占比、达标教师数、师阅题目量占比等）均以本周期有任务记录的教师为分母。平台源表中本期无任何任务记录的账号（多为任教学科或班级尚未绑定）不参与分母计算，正文明示其人数，建议核实后再纳入后续统计。（对应各年级「（三）教师维度统计」）',
        '错题重练：重练覆盖率为布置错题重练任务的学生（或班级）占该学科学生（或班级）的比例；正文「重练覆盖率高于 80.0%」与判定阈值 80.0% 一致，不含等于 80.0% 的情形。（对应各年级「（三）教师维度统计」）',
        '观看时长：为平台以「时:分」表示的口径（如 83:11 约 83.2 小时），小时数由分钟折算并保留 1 位小数，不与时分二次换算。（对应各年级「（二）学科维度统计·自学数据」）',
        '缺失数据处理：整周未布置任务的学科（如 2024 级地理）标注「缺失」而非计 0，其自学、观看与靶向等旁路数据仍按源表展示。数据来自学校站点「管理看板」实时接口，统计截止时间以平台为准，可能与历史报告存在细微差异。（对应第一章及各年级「（一）整体情况」）',
      ],
    },
  ]
}

// ---------------------------------------------------------------- 组装文档

function buildDocument(model, opts = {}) {
  if (!model || typeof model !== 'object') {
    throw new Error('报告数据为空：无法生成报告')
  }
  const meta = model.meta || {}
  const grades = (Array.isArray(model.grades) ? model.grades : []).filter(
    (g) => g && Array.isArray(g.subjects),
  )
  if (!grades.length) {
    throw new Error('报告数据为空：缺少年级明细，无法生成报告')
  }
  const ctx = {
    model,
    meta,
    grades,
    totals: totalsOf(model),
    opts,
    figures: 0,
  }
  const cover = buildCover(ctx)
  // 章序一律由序号自动生成：一、整体情况 → 二～N、各年级 → 末章、总结；附录不编章序
  const chapterSources = [
    { name: '整体情况', pageBreak: false, blocks: overallBlocks(ctx) },
    ...grades.map((grade) => ({
      name: gradeHeading(grade),
      pageBreak: true,
      blocks: gradeBlocks(grade, ctx),
    })),
    { name: '总结', pageBreak: true, blocks: summaryBlocks(ctx) },
  ]
  const chapters = chapterSources.map((chapter, index) => ({
    title: `${cnNum(index + 1)}、${chapter.name}`,
    pageBreak: chapter.pageBreak,
    blocks: chapter.blocks,
  }))
  chapters.push({
    title: '附录 数据口径说明',
    pageBreak: true,
    appendix: true,
    blocks: appendixBlocks(ctx),
  })

  // 目录与正文同源：章用「`一、`+章名」，附录单列「附录　…」（不编章序）
  const contents = chapters.map((c) => (c.appendix ? c.title : c.title))
  const allBlocks = chapters.flatMap((c) => c.blocks)
  const stats = {
    school: cover.school,
    gradeCount: grades.length,
    gradeNames: grades.map((g) => gradeLabel(g)),
    days: ctx.totals.days,
    from: meta.from || '',
    to: meta.to || '',
    taskCount: ctx.totals.taskCount,
    questionCount: ctx.totals.questionCount,
    dailyTask: round1(ctx.totals.dailyTask),
    dailyQuestion: round1(ctx.totals.dailyQuestion),
    watchCount: ctx.totals.watchCount,
    watchDurationText: ctx.totals.watchDurationText,
    watchHours: round1(ctx.totals.watchHours),
    selfPersonCount: ctx.totals.selfPersonCount,
    selfQuestionCount: ctx.totals.selfQuestionCount,
    chapterCount: chapters.length,
    contents,
    appendixCount: chapters.filter((c) => c.appendix).length,
    sectionCount: allBlocks.filter((b) => b.t === 'h2').length,
    figureCount: allBlocks.filter((b) => b.t === 'fig').length,
    tableCount: allBlocks.filter((b) => b.t === 'table').length,
    generatedAt: meta.generatedAt || opts.generatedAt || null,
  }
  return { cover, chapters, contents, stats }
}

function gradeBlocks(grade, ctx) {
  const blocks = []
  blocks.push({ t: 'h2', text: '（一）整体情况' })
  blocks.push(...overallGradeBlocks(grade, ctx))
  blocks.push({ t: 'h2', text: '（二）学科维度统计' })
  blocks.push({ t: 'h3', text: '1. 基础教学' })
  blocks.push(...subjectBasics(grade, ctx))
  blocks.push({ t: 'h3', text: '2. 错题重练、靶向教学与资源建设' })
  blocks.push(...bookletTargetBlocks(grade))
  blocks.push({ t: 'h3', text: '3. 学科关键指标汇总' })
  blocks.push(...subjectMetricsBlocks(grade))
  blocks.push({ t: 'h3', text: '4. 自学数据' })
  blocks.push(...selfStudyBlocks(grade))
  blocks.push({ t: 'h2', text: '（三）教师维度统计' })
  // 导语只在首个年级出现一次，避免逐章重复同一句套话
  if (!ctx.teacherIntroShown) {
    blocks.push({ t: 'p', text: '教师维度以任务发布量、完成率与师阅率为主要观察口径。' })
    ctx.teacherIntroShown = true
  }
  blocks.push({ t: 'h3', text: '1. 基础教学' })
  blocks.push(...teacherBasics(grade, ctx))
  blocks.push({ t: 'h3', text: '2. 错题重练、靶向教学与资源建设' })
  blocks.push(...teacherBookletBlocks(grade))
  blocks.push({ t: 'h2', text: '（四）总结' })
  blocks.push(...gradeSummaryBlocks(grade))
  return blocks
}

// ---------------------------------------------------------------- Markdown 渲染

function mdTable(table) {
  const head = `| ${table.head.join(' | ')} |`
  const divider = `| ${table.aligns.map((a) => (a === 'r' ? '---:' : '---')).join(' | ')} |`
  const rows = table.rows.map((row) => `| ${row.join(' | ')} |`)
  return [head, divider, ...rows].join('\n')
}

function blockToMarkdown(block) {
  switch (block.t) {
    case 'h2':
      // 节标题：（一）整体情况
      return `### ${block.text}`
    case 'h3':
      // 三级标题：1. 基础教学
      return `#### ${block.text}`
    case 'h4':
      // 四级标题：（1）……
      return `##### ${block.text}`
    case 'p':
      return block.text
    case 'note':
      return block.text
    case 'ol':
      return block.items.map((item, i) => `${i + 1}. ${item}`).join('\n\n')
    case 'ul':
      return block.items.map((item) => `- ${item}`).join('\n\n')
    case 'notelist':
      return block.items.map((item, i) => `${i + 1}. ${item}`).join('\n\n')
    case 'small':
      // 表注：表下、9pt 宋体、前缀「注：」，不做整段斜体
      return block.text
    case 'table':
      return mdTable(block)
    case 'fig': {
      // 图题在图下，图序与图题之间空一字；Markdown 无法承载 SVG，
      // 故降级为「图题 + 说明 + 同源数据表」，保证与 HTML／PDF 版信息等价
      const lines = [`图 ${block.n}　${block.caption}`]
      if (block.data) {
        lines.push('（图表见 HTML／PDF 版；数据见下表。）')
        lines.push(mdTable(block.data))
      } else {
        lines.push('（图表见 HTML／PDF 版。）')
      }
      return lines.join('\n\n')
    }
    default:
      return ''
  }
}

function renderMarkdown(doc) {
  const out = []
  // 封面：学校全称 / 统计周期 / 报告名 / 年级副标题；不使用 KPI 卡片与「·」分隔
  out.push(`# ${doc.cover.school}`)
  out.push(doc.cover.period)
  out.push(`## ${doc.cover.title}`)
  out.push(doc.cover.gradeList)
  if (doc.cover.footLines?.length) out.push(doc.cover.footLines.join('  \n'))
  if (doc.contents?.length) {
    out.push('## 目录')
    out.push(doc.contents.map((line) => `- ${line}`).join('\n'))
  }
  for (const chapter of doc.chapters) {
    out.push(`## ${chapter.title}`)
    for (const block of chapter.blocks) {
      const text = blockToMarkdown(block)
      if (text) out.push(text)
    }
  }
  return `${out.join('\n\n').replace(/\n{3,}/g, '\n\n')}\n`
}

// ---------------------------------------------------------------- HTML 渲染

// 版式依据《党政机关公文格式》（GB/T 9704—2012）的版面与字体规范：
// 版心 156mm × 225mm，天头 37mm，订口 28mm；正文 12pt 宋体；数字用 Times New Roman；
// 标题层级「一、」「（一）」「1.」依次用黑体 / 楷体 / 黑体；全篇黑字，不设页眉、页脚、页码。
// 本报告为教学数据报告，不套用红头、版记。
const HTML_STYLES = `
@page { size: A4; margin: 37mm 26mm 35mm 28mm; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
html, body { margin: 0; padding: 0; background: #ffffff; }
body {
  font-family: "Songti SC", "SimSun", "STSong", serif;
  font-size: 12pt;
  line-height: 1.6;
  color: #000;
  -webkit-font-smoothing: antialiased;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
h1, h2, h3, h4 { margin: 0; color: #000; font-weight: normal; page-break-after: avoid; break-after: avoid; }
p { margin: 0 0 0.6em; }
#report { display: block; }

/* ---------- 封面：学校全称 / 统计周期 / 报告名 / 年级副标题 ---------- */
.cover {
  /* 封面单独一页；页脚以绝对定位贴版面底部，不随上半部分内容变化而错位 */
  position: relative;
  page-break-after: always;
  break-after: page;
  min-height: 222mm;
  display: block;
  text-align: center;
}
.cover-school {
  /* 封面整体下移，使「学校—周期—报告名」落在版心上半部的视觉重心上 */
  padding-top: 30mm;
  font-family: "Heiti SC", "SimHei", "Songti SC", serif;
  font-size: 22pt;
  line-height: 1.6;
  letter-spacing: 0.06em;
  text-align: center;
}
.cover-period {
  margin-top: 8mm;
  font-size: 14pt;
  line-height: 2;
  text-align: center;
}
.cover-title {
  margin-top: 46mm;
  font-family: "Heiti SC", "SimHei", "Songti SC", serif;
  font-size: 26pt;
  line-height: 1.6;
  letter-spacing: 0.2em;
  text-align: center;
}
.cover-grades {
  margin-top: 10mm;
  font-family: "Kaiti SC", "KaiTi", "STKaiti", serif;
  font-size: 14pt;
  line-height: 2;
  text-align: center;
}
.cover-foot {
  /* 贴页脚：相对 .cover 绝对定位到底边，字体或内容变化都不会上浮/下沉 */
  position: absolute;
  left: 0;
  bottom: 0;
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  font-size: 9pt;
  line-height: 1.9;
  text-align: left;
  text-indent: 0;
}

/* ---------- 目录 ---------- */
.toc { page-break-after: always; break-after: page; }
.toc-title {
  margin: 0 0 6mm;
  font-family: "Heiti SC", "SimHei", "Songti SC", serif;
  font-size: 16pt;
  line-height: 1.6;
  /* 不使用全角空格、也不用 letter-spacing：二者都会把「目录」拆成两个文本片段，
     导致 PDF 提取/检索乱序。标题本身已居中，两字间距由 font-size 自然承担。 */
  letter-spacing: 0;
  text-align: center;
}
.toc-list { margin: 0; padding: 0; list-style: none; }
.toc-list li { margin: 0 0 2.4mm; text-indent: 0; font-size: 12pt; line-height: 1.8; }
figcaption, .toc-list li, p.small, p.note { text-indent: 0; }

/* ---------- 章、节、目 ---------- */
.chapter { padding: 0; }
.chapter--break { page-break-before: always; break-before: page; }
.chapter-title {
  font-family: "Heiti SC", "SimHei", "Songti SC", serif;
  font-size: 16pt;
  line-height: 1.6;
  margin: 4mm 0 5mm;
  text-align: center;
  page-break-after: avoid;
  break-after: avoid;
}
.chapter--first .chapter-title { margin-top: 0; }
h2 {
  font-family: "Kaiti SC", "KaiTi", "STKaiti", serif;
  font-size: 14pt;
  line-height: 1.7;
  text-align: left;
  text-indent: 0;
  margin: 4mm 0 1.6mm;
}
h3 {
  font-family: "Heiti SC", "SimHei", "Songti SC", serif;
  font-size: 12pt;
  line-height: 1.7;
  text-align: left;
  text-indent: 0;
  margin: 3mm 0 1.2mm;
}
h4 {
  /* 四级标题：（1）……，仿宋（无仿宋时回落到宋体） */
  font-family: "STFangsong", "FangSong", "Songti SC", "SimSun", "STSong", serif;
  font-size: 12pt;
  line-height: 1.6;
  text-align: left;
  text-indent: 0;
  margin: 2mm 0 1mm;
}

/* ---------- 正文 ---------- */
p {
  margin: 0 0 0.35em;
  text-indent: 2em;
  /*
   * 正文采用左对齐（右端往往不齐），原因如下，勿轻易改回 justify：
   * Chrome 打印对中文段落做 text-align: justify 时，行内拉丁字符（年份、
   * 百分数、括号）过多会把中文字距强行拉开，产生「完 成 率 ： 完 成 率 较 高」
   * 这类散字行；实测本报告 21 页中有 3 页出现该现象，正式文件不可接受。
   * 左对齐 + 两端不齐，但字距均匀、版面干净，优于散字。
   */
  text-align: left;
  orphans: 2;
  widows: 2;
}
/* 末段落不留外边距，避免文末产生空白页 */
section > :last-child, #report > :last-child { margin-bottom: 0; }
/* 说明段与表注不是自然段，不首行缩进 */
p.note {
  margin: 2mm 0 1.6mm;
  font-size: 10.5pt;
  line-height: 1.7;
  text-indent: 0;
}
p.small {
  margin: 0.8mm 0 3mm;
  font-size: 9pt;
  line-height: 1.6;
  text-indent: 0;
  text-align: left;
  color: #000;
}
/* 数字与西文：Times New Roman，等宽数字，保证表格列与正文数字对齐 */
.num, td.num, th.num, .tnum { font-variant-numeric: tabular-nums; }
.cover-period, .cover-grades, .cover-foot, td, th, figcaption, p.small, .toc-list {
  font-variant-numeric: tabular-nums;
}

/* ---------- 列表：中文公文用「（一）」「1.」式序号，不用项目符号点 ---------- */
ol.advice, ul.points, ol.caliber {
  margin: 0.6mm 0 2.4mm;
  padding-left: 0;
  list-style: none;
}
ol.advice li, ul.points li, ol.caliber li {
  margin: 0 0 0.55em;
  padding-left: 0;
  text-indent: 2em;
  text-align: left;
  page-break-inside: avoid;
  break-inside: avoid;
}
ol.caliber li { text-indent: 2em; }
/* 条款「（一）」式：序号悬挂，正文与序号后首字对齐，续行缩进 2 字 */
ol.advice--cn li { padding-left: 4em; text-indent: -2em; }
ol.advice--cn li .clause-no { display: inline; }
ol.advice--cn li::after { content: ""; }

/* ---------- 表格 ---------- */
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  word-break: break-all;
  font-size: 10.5pt;
  line-height: 1.45;
  margin: 1mm 0 1.2mm;
  /* 长表若跨页，表头随页重复；本报告各表均控制在单页内，未出现续表 */
  page-break-inside: avoid;
  break-inside: avoid;
}
thead { display: table-header-group; }
tr { page-break-inside: avoid; break-inside: avoid; }
/* 表格：全篇 0.5pt 黑线；字号 10.5pt；内边距取小值以保证九列在版心内不折行 */
th, td {
  border: 0.5pt solid #000;
  padding: 0.4mm 1mm;
  color: #000;
  vertical-align: middle;
}
th {
  background: #f2f2f2;
  font-family: "Heiti SC", "SimHei", "Songti SC", serif;
  font-size: 10.5pt;
  font-weight: normal;
  text-align: center;
}
td { text-align: center; }
td.num { text-align: right; }
td, th { font-variant-numeric: tabular-nums; }
td { font-family: "Songti SC", "SimSun", "STSong", serif; }

/* ---------- 图 ---------- */
figure.chart {
  margin: 1.6mm 0 2.4mm;
  padding: 0;
  text-align: center;
  page-break-inside: avoid;
  break-inside: avoid;
}
figure.chart svg { display: block; width: 100%; height: auto; max-width: 100%; margin: 0 auto; }
figcaption {
  margin-top: 1.2mm;
  font-family: "Songti SC", "SimSun", "STSong", serif;
  font-size: 10.5pt;
  line-height: 1.6;
  text-align: center;
  text-indent: 0;
  color: #000;
}
/* 合计行：加粗并对全行加一道粗上框线（公文表式惯例） */
tr.total td, tr.total th { font-family: "Heiti SC", "SimHei", "Songti SC", serif; }
tr.total td { border-top: 1pt solid #000; }
.keep { page-break-inside: avoid; break-inside: avoid; }
`

/** 表头单元格：可在词与词之间换行（如「日均／任务（次）」），避免整词被拆成两行 */
const thHtml = (cell, isNum) =>
  `<th${isNum ? ' class="num"' : ''}>${esc(cell)
    .replace(/（/g, '<wbr>（')
    .replace(/覆盖率/g, '<wbr>覆盖率')
    // 两字量词位置断行：「任务量」→「任务／量」、「题量」同理，避免单字孤行
    .replace(/([^量（])(量)/g, '$1<wbr>$2')}</th>`

function htmlTable(table) {
  const widths =
    Array.isArray(table.widths) && table.widths.length === table.head.length ? table.widths : null
  const colgroup = widths
    ? `<colgroup>${widths.map((w) => `<col style="width:${w}%">`).join('')}</colgroup>`
    : ''
  const head = `<thead><tr>${table.head
    .map((cell, i) => thHtml(cell, table.aligns?.[i] === 'r'))
    .join('')}</tr></thead>`
  const body = `<tbody>${table.rows
    .map(
      (row, rowIndex) =>
        // 合计行加类名，供打印样式加粗与加一道上框线
        `<tr${rowIndex === table.rows.length - 1 && table.totalRow ? ' class="total"' : ''}>${row
          .map(
            (cell, i) =>
              `<td${table.aligns?.[i] === 'r' ? ' class="num"' : ''}>${esc(cell)}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('')}</tbody>`
  return `<table>${colgroup}${head}${body}</table>`
}

/** 中文序号：（一）（二）……；列表改为「（一）」式，替代项目符号点 */
const CN_PAREN = [
  '（一）', '（二）', '（三）', '（四）', '（五）',
  '（六）', '（七）', '（八）', '（九）', '（十）',
  '（十一）', '（十二）', '（十三）', '（十四）', '（十五）',
  '（十六）', '（十七）', '（十八）', '（十九）', '（二十）',
]
const cnParen = (n) => CN_PAREN[n - 1] || `（${n}）`

function blockToHtml(block) {
  switch (block.t) {
    case 'h2':
      return `<h2>${esc(block.text)}</h2>`
    case 'h3':
      return `<h3>${esc(block.text)}</h3>`
    case 'h4':
      return `<h4>${esc(block.text)}</h4>`
    case 'p':
      return `<p>${esc(block.text)}</p>`
    case 'note':
      return `<p class="note">${esc(block.text)}</p>`
    case 'ol':
      if (block.ordered === 'cn') {
        // 公文式条款序号：（一）（二）……，不出现阿拉伯「1.」
        return `<ol class="advice advice--cn">\n${block.items
          .map((item, i) => `<li><span class="clause-no">${cnParen(i + 1)}</span>${esc(item)}</li>`)
          .join('\n')}\n</ol>`
      }
      return `<ol class="advice">\n${block.items.map((item) => `<li>${esc(item)}</li>`).join('\n')}\n</ol>`
    case 'ul':
      return `<ul class="points">\n${block.items.map((item) => `<li>${esc(item)}</li>`).join('\n')}\n</ul>`
    case 'notelist':
      return `<ol class="caliber">\n${block.items
        .map((item, i) => `<li>${cnParen(i + 1)}${esc(item)}</li>`)
        .join('\n')}\n</ol>`
    case 'small':
      return `<p class="small">${esc(block.text)}</p>`
    case 'table':
      return htmlTable(block)
    case 'fig':
      return `<figure class="chart">\n${block.svg}\n<figcaption>图 ${block.n}　${esc(block.caption)}</figcaption>\n</figure>`
    default:
      return ''
  }
}

function renderHtml(doc) {
  const { cover } = doc
  const title = `${cover.school}辅立码课系统教学数据报告`
  // 封面：学校全称（黑体 22pt）、统计周期（宋体 14pt）、空行、报告名（黑体 26pt，字距 0.2em）、
  // 副标题年级列表（楷体 14pt）；页脚为左对齐的「数据来源」「生成时间」。不设 KPI 卡片、不设彩色短线。
  const coverHtml = `<section class="cover">
<div class="cover-school">${esc(cover.school)}</div>
<div class="cover-period">${esc(cover.period)}</div>
<div class="cover-title">${esc(cover.title)}</div>
<div class="cover-grades">${esc(cover.gradeList)}</div>
<div class="cover-foot">${cover.footLines.map((line) => esc(line)).join('<br>')}</div>
</section>`
  const tocHtml = doc.contents?.length
    ? `<section class="toc">
<div class="toc-title">目录</div>
<ul class="toc-list">
${doc.contents.map((line) => `<li>${esc(line)}</li>`).join('\n')}
</ul>
</section>`
    : ''
  const chaptersHtml = doc.chapters
    .map((chapter, index) => {
      const classes = `chapter${index === 0 ? ' chapter--first' : ' chapter--break'}`
      return `<section class="${classes}">
<h1 class="chapter-title">${esc(chapter.title)}</h1>
${chapter.blocks.map(blockToHtml).join('\n')}
</section>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${HTML_STYLES}</style>
</head>
<body>
<div id="report">
${coverHtml}
${tocHtml}
${chaptersHtml}
</div>
</body>
</html>
`
}

// ---------------------------------------------------------------- 对外接口

/** 完整 Markdown 报告 */
export function buildMarkdown(model, opts = {}) {
  return renderMarkdown(buildDocument(model, opts))
}

/** 完整可打印 HTML 报告（单文件、内联 CSS / SVG） */
export function buildHtml(model, opts = {}) {
  return renderHtml(buildDocument(model, opts))
}

/** 一次构建三种输出：{ markdown, html, stats } */
export function buildReport(model, opts = {}) {
  const doc = buildDocument(model, opts)
  return {
    markdown: renderMarkdown(doc),
    html: renderHtml(doc),
    docx: buildWordFromDoc(doc),
    stats: doc.stats,
  }
}

/**
 * 完整 Word 报告（.docx 二进制 Buffer）。
 * 与 HTML／Markdown 由同一份 doc 模型渲染，样式沿用同一套公文规范；
 * Word 无法承载内联 SVG，图表按 Markdown 版策略降级为「图题 + 数据表」。
 */
export function buildDocx(model, opts = {}) {
  return buildWordFromDoc(buildDocument(model, opts))
}

export default { buildMarkdown, buildHtml, buildDocx, buildReport }
