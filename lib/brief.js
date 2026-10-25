// 简报渲染层：1~2 页速览（总体 → 学科 → 教师 → 提升与建议）。
//
// 与正式版 report.js 共用同一个数据模型（见 SPEC-report.md §1），口径一致：
//   - 总述段保留 1 位小数；条目内百分比一律取整（与定稿参考简报一致）；
//   - 数据缺失（null）一律省略该条，绝不输出 NaN / undefined / null / 「缺失」；
//   - 不访问网络、不写文件、零第三方依赖（纯 Node ESM）。
//
// 接口一律**同步**（不返回 Promise）：Host 的 index.js 与验收脚本都按同步调用。
// 三个载体由同一份 doc 模型（buildBriefDocument）渲染：
//   - buildBriefDocument(model, opts) → briefDoc（或多年级容器 briefDocs）
//   - buildBriefHtml(model, opts)     → 单文件 HTML（A4，Chrome --print-to-pdf 打印 PDF）
//   - buildBrief(model, opts)         → { docx, html, brief, stats }
//   - buildBriefDocx(model, opts)     → Word（.docx Buffer，版式见 docx.js 的 buildBriefDocx）
//
// 简报按年级分段：opts.gradeIds 未指定时，model.grades 全部年级各出一节，每届一段完整结构。
//
// 【阅卷率口径】总述段的「平均阅卷率」按下列优先级取值，全程不编造：
//   1) grade.summary.markPercent（模型已算好时直接用）；
//   2) 学科 markPercent（阅卷率）按习题任务量 taskCount 加权平均；
//   3) grade.summary.teacherMarkPercentAvg（师阅率简单平均）兜底。
// 样例模型属第 2 种：2024 级得到 78.6%，而师阅率均值是 70.4%——前者更贴近参考简报
// 「平均阅卷率」的定义（阅卷率而非师阅率），故优先取它。实际用了哪一档记在
// stats.markPercentSource（'summary' / 'subjectWeighted' / 'teacherMarkPercentAvg'）。
//
// 【图表】HTML 默认出图（opts.figures 默认 true，内联 SVG）；Word 默认不出（true 时输出
// 「图题 + 同源数据表」，与正式版 docx 的降级策略一致）。SVG 取自 charts.js 的
// briefSubjectSvg / briefTeacherSvg，函数缺失或抛错时自动降级为「图题 + 数据表」，绝不崩。

import { buildBriefDocx as buildBriefWord } from './docx.js'
// 图表来自 charts.js 的 briefSubjectSvg / briefTeacherSvg（图表成员实现）。
// 这里按命名空间静态导入：函数缺失或改名时 typeof 判断即可降级为「图题 + 数据表」，不会崩。
import * as charts from './charts.js'

// ---------------------------------------------------------------- 格式化

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const round1 = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null)
const round2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null)
const asZero = (v) => (isNum(v) ? v : 0)

/** 条目内百分比：取整（72%）。缺失返回 null（调用方据此省略整条） */
const pctInt = (v) => (isNum(v) ? `${Math.round(v)}%` : null)
/** 总述段百分比：1 位小数（84.1%） */
const pct1 = (v) => (isNum(v) ? `${v.toFixed(1)}%` : null)
/** 日均等小数：去尾零（3.62 / 28.2） */
const numSmart = (v) => {
  if (!isNum(v)) return null
  return String(Math.round(v * 100) / 100)
}
/** 整数计数 */
const intStr = (v) => (isNum(v) ? String(Math.round(v)) : null)

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

/** 把可能含 null 的片段拼成一句：任一片段缺失则整句作废（返回 null） */
function join(parts, sep = '') {
  const list = Array.isArray(parts) ? parts : [parts]
  if (list.some((p) => p === null || p === undefined || p === '')) return null
  return list.join(sep)
}

/** 形如「甲、乙、丙」；空数组返回 null */
const joinList = (items) => (Array.isArray(items) && items.length ? items.join('、') : null)

// ---------------------------------------------------------------- 模型访问

const subjectsOf = (grade) =>
  Array.isArray(grade?.subjects) ? grade.subjects.filter((s) => s && (s.short || s.name)) : []
const shortOf = (s) => String(s?.short || s?.name || '').replace(/^(高中|初中|小学)/, '')
const summaryOf = (grade) => grade?.summary || {}
const teachersOf = (grade) =>
  Array.isArray(grade?.teachers) ? grade.teachers.filter((t) => t && t.name) : []
/** 本周期有任务记录的教师（无任务账号不计入分母，与正式版同口径） */
const activeTeachersOf = (grade) =>
  teachersOf(grade).filter((t) => asZero(t.taskCount) > 0 && !isAdminAccount(t))

/** 平台通用账号（不是任课教师），教师层面各条都不应出现 */
const ADMIN_ACCOUNT_NAMES = new Set(['教研管理', '管理员', '系统管理员', '校级管理', '年级管理', '教学管理'])
const isAdminAccount = (t) => ADMIN_ACCOUNT_NAMES.has(String(t?.name || ''))

/** 缺失学科：missing 标记，或任务量缺失 / 为 0 */
const isMissingSubject = (s) => !s || s.missing === true || !(isNum(s.taskCount) && s.taskCount > 0)
const activeSubjects = (grade) => subjectsOf(grade).filter((s) => !isMissingSubject(s))
const missingSubjects = (grade) => subjectsOf(grade).filter(isMissingSubject)

const meanBy = (arr, fn) => {
  const vals = arr.map(fn).filter(isNum)
  if (!vals.length) return null
  return vals.reduce((a, b) => a + b, 0) / vals.length
}
const sumBy = (arr, fn) => arr.reduce((acc, x) => acc + (isNum(fn(x)) ? fn(x) : 0), 0)
const weightedMean = (items, valueFn, weightFn) => {
  let sum = 0
  let w = 0
  for (const item of items) {
    const v = valueFn(item)
    const wt = weightFn(item)
    if (isNum(v) && isNum(wt) && wt > 0) {
      sum += v * wt
      w += wt
    }
  }
  return w > 0 ? sum / w : null
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
const median = (values) => {
  const vals = values.filter(isNum).slice().sort((a, b) => a - b)
  if (!vals.length) return null
  const mid = vals.length >> 1
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2
}

// ---------------------------------------------------------------- 日期与标题

/** "2026-10-08" → "2026年10月8日"（与参考简报一致，不带空格） */
function dateCn(iso) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(iso || ''))
  if (!m) return null
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`
}

const LEVEL_SHORT = { 高三年级: '高三', 高二年级: '高二', 高一年级: '高一', 初三年级: '初三', 初二年级: '初二', 初一年级: '初一' }

/** 学段简称：优先 levelName（高三/高二/高一），否则按入学年份与统计区间推算 */
function levelShortOf(grade, fromISO) {
  const level = String(grade?.levelName || '')
  if (LEVEL_SHORT[level]) return LEVEL_SHORT[level]
  const m = /(\d{4})\s*级/.exec(String(grade?.gradeName || ''))
  if (m) {
    const entry = Number(m[1])
    const ym = /^(\d{4})-(\d{1,2})/.exec(String(fromISO || ''))
    if (ym) {
      const year = Number(ym[1])
      const month = Number(ym[2])
      const academicYear = month >= 8 ? year : year - 1
      const no = academicYear - entry + 1
      return ['高一', '高二', '高三'][no - 1] || ''
    }
  }
  return ''
}

/** 标题：{年级名}{学段}{起}-{止}使用简报，例「2024级高三2026年10月8日-2026年10月21日使用简报」 */
function titleOf(grade, meta) {
  const gradeName = String(grade?.gradeName || grade?.gradeId || '').trim()
  const level = levelShortOf(grade, meta?.from)
  const from = dateCn(meta?.from || summaryOf(grade).fromISO)
  const to = dateCn(meta?.to || summaryOf(grade).toISO)
  const head = `${gradeName}${level}`
  if (from && to) return `${head}${from}-${to}使用简报`
  if (from || to) return `${head}${from || to}使用简报`
  return `${head}使用简报`
}

// ---------------------------------------------------------------- 指标汇总

/**
 * 年级层指标（总述与各选取规则共用一份，保证同一数字只算一次）。
 * markPercent 口径：模型有 summary.markPercent 直接用；否则用学科阅卷率按任务量加权；
 * 都没有时用 summary.teacherMarkPercentAvg 兜底（见 SPEC-brief §2.1）。
 */
function gradeMetrics(grade) {
  const summary = summaryOf(grade)
  const subs = activeSubjects(grade)
  // 选中「学科均值」时只用两项指标都有效的学科，避免简单平均被空值拉偏
  const paired = subs.filter((s) => isNum(s.finishPercent) && isNum(s.teacherMarkPercent))
  const subjectAvg = {
    finish: meanBy(paired, (s) => s.finishPercent),
    teacherMark: meanBy(paired, (s) => s.teacherMarkPercent),
    taskCount: meanBy(paired, (s) => s.taskCount),
  }
  const markWeighted = weightedMean(subs, (s) => s.markPercent, (s) => s.taskCount)
  const markPercent = isNum(summary.markPercent)
    ? summary.markPercent
    : isNum(markWeighted)
      ? markWeighted
      : isNum(summary.teacherMarkPercentAvg)
        ? summary.teacherMarkPercentAvg
        : null
  const markSource = isNum(summary.markPercent)
    ? 'summary'
    : isNum(markWeighted)
      ? 'subjectWeighted'
      : isNum(summary.teacherMarkPercentAvg)
        ? 'teacherMarkPercentAvg'
        : null
  return {
    summary,
    subs,
    subjectAvg,
    markPercent,
    markSource,
    taskCount: summary.taskCount,
    exerciseTaskCount: summary.exerciseTaskCount,
    questionCount: summary.questionCount,
    days: isNum(summary.days) ? summary.days : null,
    finishPercent: summary.finishPercent,
    correctPercent: summary.correctPercent,
    dailyClassTask: summary.dailyClassTask,
    dailyClassQuestion: summary.dailyClassQuestion,
  }
}

/** 自学 / 视频 / 重练 / 靶向：年级层汇总 */
function activityStats(grade) {
  const subs = subjectsOf(grade)
  const ss = grade?.selfStudy || {}
  const selfPerson = isNum(ss.totalPersonCount)
    ? ss.totalPersonCount
    : sumBy(subs, (s) => s.self?.personCount)
  const selfQuestion = isNum(ss.totalQuestionCount)
    ? ss.totalQuestionCount
    : sumBy(subs, (s) => s.self?.questionCount)
  const watchCount = isNum(grade?.watch?.count)
    ? grade.watch.count
    : isNum(summaryOf(grade).watchCount)
      ? summaryOf(grade).watchCount
      : sumBy(subs, (s) => s.watch?.count)
  const bookletCount = sumBy(subs, (s) => s.booklet?.taskCount)
  const hasBookletData = subs.some((s) => isNum(s.booklet?.taskCount))
  const targetCount = sumBy(subs, (s) => s.target?.taskCount)
  const targetQuestion = sumBy(subs, (s) => s.target?.questionCount)
  const hasTargetData = subs.some((s) => isNum(s.target?.taskCount))
  return {
    selfPerson,
    selfQuestion,
    watchCount,
    bookletCount,
    hasBookletData,
    targetCount,
    targetQuestion,
    hasTargetData,
  }
}

// ---------------------------------------------------------------- 选取规则
// 阈值严格按 SPEC-brief.md §2.2 / §2.3 / §2.4

const BRIEF = {
  comprehensiveMax: 3, // 「使用较全面的学科」最多 3 个
  bookletGoodMax: 3, // 「错题重练做得较好的学科」最多 3 个
  highMark: 90, // 「阅卷率较高」阈值
  highMarkMax: 6,
  highFinish: 85, // 「作业完成率较高」阈值
  highFinishMax: 3,
  lowFinish: 75,
  lowMark: 60,
  lowMarkMax: 3,
  selfMarkTeacher: 30, // 「阅卷以学生自批为主」：师阅率 < 30 且阅卷率 ≥ 40
  selfMarkOverall: 40,
  selfMarkMax: 3,
  teacherFinish: 80,
  teacherMark: 80,
  teacherComprehensiveMax: 4,
  teacherBookletMax: 3,
  teacherTargetMax: 3,
  teacherLowTasks: 3, // 「使用量偏少」：任务量 ≤ 3
}

/** 条目：{ type: 'bullet'|'text', text, level }（level 0 顶格，1 缩进一级） */
const bullet = (text, level = 0) => ({ type: 'bullet', text, level })
const text = (text2, level = 1) => ({ type: 'text', text: text2, level })

/** 学科条目：完成率、师阅率、习题任务数都高于年级学科均值，最多 3 个，按任务量降序 */
function comprehensiveSubjects(grade, m) {
  const avg = m.subjectAvg
  const hit = m.subs.filter(
    (s) =>
      isNum(avg.finish) &&
      isNum(avg.teacherMark) &&
      isNum(avg.taskCount) &&
      s.finishPercent > avg.finish &&
      s.teacherMarkPercent > avg.teacherMark &&
      s.taskCount > avg.taskCount,
  )
  return sortByDesc(hit, (s) => s.taskCount).slice(0, BRIEF.comprehensiveMax)
}

/**
 * 错题重练做得较好的学科：先按覆盖率（取整）分组，组内按重练次数降序，最多 3 个。
 * 不用「覆盖率*1000+次数」这类综合分：那会让「2 次覆盖 100%」压过「29 次覆盖 100%」。
 */
function goodBookletSubjects(grade) {
  const hit = subjectBookletRows(grade)
    .slice()
    .sort(
      (a, b) =>
        Math.round(b.cover) - Math.round(a.cover) ||
        b.count - a.count ||
        String(shortOf(a.s)).localeCompare(String(shortOf(b.s)), 'zh'),
    )
  return hit.slice(0, BRIEF.bookletGoodMax)
}
/** 有重练记录的学科：[{ s, count, cover }] */
function subjectBookletRows(grade) {
  return activeSubjects(grade)
    .filter((s) => isNum(s.booklet?.taskCount) && s.booklet.taskCount > 0 && isNum(s.booklet?.coverPercent))
    .map((s) => ({ s, count: s.booklet.taskCount, cover: s.booklet.coverPercent }))
}

/** 阅卷率较高的学科（对照「阅卷率」列，缺失时用师阅率兜底） */
const markOf = (s) => (isNum(s.markPercent) ? s.markPercent : isNum(s.teacherMarkPercent) ? s.teacherMarkPercent : null)

function highMarkSubjects(grade) {
  // 按整十下界归类：90~99 归「90%以上」，其余整十依次类推，避免出现「均在 90.0% 以上」这类小数组
  const hit = activeSubjects(grade)
    .map((s) => ({ s, v: markOf(s) }))
    .filter((row) => isNum(row.v) && row.v >= BRIEF.highMark)
  if (!hit.length) return { list: [], floor: null }
  const floor = Math.floor(Math.min(...hit.map((r) => r.v)) / 10) * 10
  const list = sortByDesc(
    hit.filter((r) => r.v >= floor).map((r) => r.s),
    markOf,
  ).slice(0, BRIEF.highMarkMax)
  return { list, floor }
}

function highFinishSubjects(grade) {
  return sortByDesc(
    activeSubjects(grade).filter((s) => isNum(s.finishPercent) && s.finishPercent >= BRIEF.highFinish),
    (s) => s.finishPercent,
  ).slice(0, BRIEF.highFinishMax)
}

function lowFinishSubjects(grade) {
  return sortByAsc(
    activeSubjects(grade).filter((s) => isNum(s.finishPercent) && s.finishPercent < BRIEF.lowFinish),
    (s) => s.finishPercent,
  )
}

function lowMarkSubjects(grade) {
  return sortByAsc(
    activeSubjects(grade).filter((s) => isNum(markOf(s)) && markOf(s) < BRIEF.lowMark),
    markOf,
  )
}

/** 阅卷以学生自批为主：师阅率 < 30 且阅卷率 ≥ 40 */
function selfMarkSubjects(grade) {
  return sortByAsc(
    activeSubjects(grade).filter(
      (s) =>
        isNum(s.teacherMarkPercent) &&
        isNum(markOf(s)) &&
        s.teacherMarkPercent < BRIEF.selfMarkTeacher &&
        markOf(s) >= BRIEF.selfMarkOverall,
    ),
    (s) => s.teacherMarkPercent,
  ).slice(0, BRIEF.selfMarkMax)
}

/** 使用数据全面的教师：任务量 ≥ 中位数、完成率 ≥ 80%、阅卷率 ≥ 80%，最多 4 位 */
function comprehensiveTeachers(grade) {
  const list = activeTeachersOf(grade)
  const med = median(list.map((t) => t.taskCount))
  if (!isNum(med)) return []
  return sortByDesc(
    list.filter(
      (t) =>
        isNum(t.finishPercent) &&
        isNum(markOf(t)) &&
        t.taskCount >= med &&
        t.finishPercent >= BRIEF.teacherFinish &&
        markOf(t) >= BRIEF.teacherMark,
    ),
    (t) => t.taskCount,
  ).slice(0, BRIEF.teacherComprehensiveMax)
}

/** 错题重练突出的老师：重练次数 + 覆盖率综合前 3 */
function bookletTeachers(grade) {
  const list = activeTeachersOf(grade).filter(
    (t) => isNum(t.booklet?.taskCount) && t.booklet.taskCount > 0 && isNum(t.booklet?.coverPercent),
  )
  return list
    .slice()
    .sort(
      (a, b) =>
        Math.round(b.booklet.coverPercent) - Math.round(a.booklet.coverPercent) ||
        b.booklet.taskCount - a.booklet.taskCount ||
        String(a.name).localeCompare(String(b.name), 'zh'),
    )
    .slice(0, BRIEF.teacherBookletMax)
}

/** 靶向教学突出的教师：靶向任务数前 3（任务数相同按题量） */
function targetTeachers(grade) {
  const list = activeTeachersOf(grade).filter((t) => isNum(t.target?.taskCount) && t.target.taskCount > 0)
  return list
    .slice()
    .sort(
      (a, b) =>
        b.target.taskCount - a.target.taskCount ||
        asZero(b.target.questionCount) - asZero(a.target.questionCount) ||
        String(a.name).localeCompare(String(b.name), 'zh'),
    )
    .slice(0, BRIEF.teacherTargetMax)
}

/**
 * 使用量偏少的教师：任务量 1~3 次（按次数升序），含本期只做了重练/靶向、
 * 未布置作业任务的账号；平台通用账号（如「教研管理」）不计入，避免把管理账号当教师。
 */
function lowTaskTeachers(grade) {
  const list = teachersOf(grade).filter(
    (t) =>
      !isAdminAccount(t) &&
      asZero(t.taskCount) <= BRIEF.teacherLowTasks &&
      (isNum(t.taskCount) || asZero(t.booklet?.taskCount) > 0 || asZero(t.target?.taskCount) > 0),
  )
  return sortByAsc(list, (t) => asZero(t.taskCount))
}


// ---------------------------------------------------------------- 各小节文案

/** 两段总述 */
function introOf(grade, m, act) {
  const t = intStr(m.taskCount)
  const c = isNum(grade?.classCount) && grade.classCount > 0 ? intStr(grade.classCount) : null
  const d = numSmart(m.dailyClassTask)
  const q = intStr(m.questionCount)
  const k = numSmart(m.dailyClassQuestion)
  const f = pct1(m.finishPercent)
  const mk = pct1(m.markPercent)
  const s = pct1(m.correctPercent)

  const first = join(
    [
      t ? `本周期内合计发布任务${t}次` : null,
      c ? `（${c}个班）` : null,
      d ? `，日均班均${d}次；` : null,
      q ? `习题量${q}道` : null,
      k ? `，日均班均${k}道；` : null,
      f ? `平均完成率${f}` : null,
      mk ? `，平均阅卷率${mk}` : null,
      s ? `，平均得分率${s}` : null,
      '。',
    ],
    '',
  )

  const second = join(
    [
      isNum(act.selfPerson) && isNum(act.selfQuestion)
        ? `学生自主学习${intStr(act.selfPerson)}人次、${intStr(act.selfQuestion)}道题；`
        : null,
      isNum(act.watchCount) ? `视频观看${intStr(act.watchCount)}人次；` : null,
      act.hasBookletData ? `错题重练${intStr(act.bookletCount)}次；` : null,
      act.hasTargetData ? `靶向任务${intStr(act.targetCount)}次、${intStr(act.targetQuestion)}道题。` : null,
    ],
    '',
  )

  const out = []
  if (first) out.push(first)
  if (second) out.push(second.replace(/；$/, '。'))
  return out
}

/** 学科方面 */
function subjectSection(grade, m) {
  const items = []

  // ① 使用较全面的学科
  const comprehensive = comprehensiveSubjects(grade, m)
  if (comprehensive.length) {
    items.push(bullet('使用较全面的学科：'))
    for (const s of comprehensive) {
      const line = join([
        shortOf(s),
        '：习题任务',
        intStr(s.taskCount),
        '次，完成率',
        pctInt(s.finishPercent),
        '，阅卷率',
        pctInt(markOf(s)),
      ])
      if (line) items.push(text(line))
    }
  } else {
    items.push(bullet('使用较全面的学科：本周期各学科使用均不均衡，详见正式报告'))
  }

  // ② 错题重练做得较好的学科
  const booklets = goodBookletSubjects(grade)
  if (booklets.length) {
    const parts = booklets
      .map((r) => join([shortOf(r.s), '（', intStr(r.count), '次，覆盖', pctInt(r.cover), '）']))
      .filter(Boolean)
    if (parts.length) items.push(bullet(`错题重练做得较好的学科：${parts.join('、')}`))
  } else if (m.subs.some((s) => isNum(s.booklet?.taskCount))) {
    items.push(bullet('错题重练做得较好的学科：本周期尚无学科开展错题重练'))
  }

  // ③ 阅卷率较高的学科
  const highMark = highMarkSubjects(grade)
  if (highMark.list.length) {
    const names = highMark.list.map(shortOf)
    const line =
      names.length === 1
        ? `${names[0]}阅卷率达${pctInt(markOf(highMark.list[0]))}`
        : `${joinList(names)}，阅卷率均在${highMark.floor}%以上`
    items.push(bullet(`阅卷率较高的学科：${line}`))
  } else if (activeSubjects(grade).some((s) => isNum(markOf(s)))) {
    items.push(bullet(`阅卷率较高的学科：各学科阅卷率均未达${BRIEF.highMark}%`))
  }

  // ④ 作业完成率较高的学科
  const highFinish = highFinishSubjects(grade)
  if (highFinish.length) {
    const names = highFinish.map(shortOf)
    let line = null
    if (names.length === 1) {
      line = `${names[0]}完成率达${pctInt(highFinish[0].finishPercent)}`
    } else if (names.length === 2) {
      line = `${joinList(names)}完成率均在${Math.floor(Math.min(...highFinish.map((s) => s.finishPercent)))}%以上`
    } else {
      // 三个及以上：用「均在 N%以上」而不是「N% 左右」——三个学科的完成率可能相差 10 个百分点
      // （如 99.4/91.8/90.0），写「95% 左右」会与其中两个都不符，读者无法核对。
      const floor = Math.floor(Math.min(...highFinish.map((s) => s.finishPercent)) / 5) * 5
      line = `${joinList(names)}完成率均在${floor}%以上`
    }
    if (line) items.push(bullet(`作业完成率较高的学科：${line}`))
  }

  // ⑤ 完成率偏低
  const lowFinish = lowFinishSubjects(grade)
  if (lowFinish.length) {
    const parts = lowFinish
      .slice(0, 3)
      .map((s) => join([shortOf(s), '(', pctInt(s.finishPercent), ')']))
      .filter(Boolean)
    if (parts.length) items.push(bullet(`${parts.join('、')}完成率偏低，需关注学生完成情况`))
  }

  // ⑥ 阅卷率偏低
  const lowMark = lowMarkSubjects(grade)
  if (lowMark.length) {
    const parts = lowMark
      .slice(0, BRIEF.lowMarkMax)
      .map((s) => join([shortOf(s), '(', pctInt(markOf(s)), ')']))
      .filter(Boolean)
    if (parts.length) {
      items.push(bullet(`${parts.join('、')}阅卷率偏低，建议及时批改、形成讲评闭环`))
    }
  }

  // ⑦ 阅卷以学生自批为主
  const selfMarked = selfMarkSubjects(grade)
  if (selfMarked.length) {
    const parts = selfMarked
      .map((s) =>
        join([
          shortOf(s),
          '（师阅率',
          pctInt(s.teacherMarkPercent),
          '，阅卷率',
          pctInt(markOf(s)),
          '）',
        ]),
      )
      .filter(Boolean)
    if (parts.length) {
      items.push(bullet(`阅卷以学生自批为主：${parts.join('、')}，建议主干题、主观题由教师亲批`))
    }
  }

  // ⑧ 整周未布置作业的学科（逐科一条）
  for (const s of missingSubjects(grade)) {
    const people = s.self?.personCount
    const questions = s.self?.questionCount
    const watch = s.watch?.count
    const cell = []
    if (isNum(people)) cell.push(`学生自学${intStr(people)}人次`)
    if (isNum(questions)) cell.push(`${intStr(questions)}题`)
    if (isNum(watch)) cell.push(`视频观看${intStr(watch)}人次`)
    const tail = cell.length ? `（${cell.join('、')}）` : ''
    items.push(bullet(`${shortOf(s)}学科本周期未布置任何作业${tail}`))
  }

  return { name: '学科方面：', items }
}

/** 教师层面 */
function teacherSection(grade, m) {
  const items = []
  const days = isNum(m.days) && m.days > 0 ? m.days : null

  // ① 使用数据全面的教师
  const comprehensive = comprehensiveTeachers(grade)
  if (comprehensive.length) {
    items.push(bullet('使用数据全面的教师：习题任务较多，完成率与阅卷率综合较高'))
    for (const t of comprehensive) {
      const daily = days ? numSmart(t.taskCount / days) : null
      const head = join([
        `${t.name}老师：任务${intStr(t.taskCount)}次`,
        daily ? `（日均${daily}次）` : null,
        '，完成率',
        pctInt(t.finishPercent),
        '，阅卷率',
        pctInt(markOf(t)),
      ])
      if (!head) continue
      const cover =
        isNum(t.booklet?.taskCount) && t.booklet.taskCount > 0 && isNum(t.booklet?.coverPercent)
          ? `，错题重练覆盖${pctInt(t.booklet.coverPercent)}`
          : ''
      items.push(text(`${head}${cover}`))
    }
  }

  // ② 错题重练突出的老师
  const bookletTops = bookletTeachers(grade)
  if (bookletTops.length) {
    items.push(bullet('错题重练突出的老师：'))
    for (const t of bookletTops) {
      const line = join([
        `${t.name}老师：重练${intStr(t.booklet.taskCount)}次，覆盖率`,
        pctInt(t.booklet.coverPercent),
      ])
      if (line) items.push(text(line))
    }
  }

  // ③ 靶向教学突出的教师
  const targetTops = targetTeachers(grade)
  if (targetTops.length) {
    items.push(bullet('靶向教学突出的教师：'))
    for (const t of targetTops) {
      const q = asZero(t.target.questionCount)
      const line =
        q > 0
          ? join([`${t.name}老师：靶向任务${intStr(t.target.taskCount)}次、`, `${intStr(q)}道题`])
          : join([`${t.name}老师：靶向任务${intStr(t.target.taskCount)}次，`, '未配置习题'])
      if (line) items.push(text(line))
    }
  }

  // ④ 使用量偏少的教师
  const low = lowTaskTeachers(grade)
  if (low.length) {
    const names = low.map((t) => t.name)
    const shown = names.length > 3 ? `${names.slice(0, 3).join('、')}等` : names.join('、')
    // 与参考简报同体例：「任务量N次及以下」，N 即筛选阈值（BRIEF.teacherLowTasks = 3）
    items.push(
      bullet(
        `使用量偏少的教师：${low.length}人（任务量${BRIEF.teacherLowTasks}次及以下），${shown}，建议跟进使用情况`,
      ),
    )
  }

  return { name: '教师层面：', items }
}

/**
 * 提升与建议（3~5 条，必须带具体数字 / 学科名）。
 * 每条都是条目对象（type=bullet + level=0），与参考简报的「第 3 级项目符号」体例一致。
 */
function adviceSection(grade, m) {
  const items = []
  const push = (line) => {
    if (line) items.push(bullet(line))
  }

  // ① 阅卷短板
  const lowMark = lowMarkSubjects(grade)
  if (lowMark.length) {
    const names = lowMark.slice(0, BRIEF.lowMarkMax).map(shortOf)
    const rest = lowMark.slice(BRIEF.lowMarkMax)
    const nameText = rest.length ? `${names.join('、')}等${lowMark.length}个学科` : names.join('、')
    const zero = lowMark.filter((s) => asZero(markOf(s)) === 0).map(shortOf)
    const detail = zero.length ? `，其中${zero.join('、')}尚未开始批改` : ''
    push(
      `优先补齐阅卷短板：${nameText}阅卷率低于${BRIEF.lowMark}%${detail}，建议布置后48小时内完成批改，让讲评有据可依`,
    )
  } else if (activeSubjects(grade).some((s) => isNum(markOf(s)))) {
    push(`优先补齐阅卷短板：本周期各学科阅卷率均在${BRIEF.lowMark}%以上，阅卷环节整体较好，建议继续保持`)
  }

  // ② 完成率
  const lowFinish = lowFinishSubjects(grade)
  if (lowFinish.length) {
    const names = lowFinish.slice(0, 3).map(shortOf)
    const more = lowFinish.length > 3 ? `等${lowFinish.length}个学科` : ''
    push(
      `关注学生完成率：${names.join('、')}${more}完成率低于${BRIEF.lowFinish}%，建议结合班级学情适当控制单次题量、明确截止时间`,
    )
  } else if (activeSubjects(grade).some((s) => isNum(s.finishPercent))) {
    push(
      `关注学生完成率：本周期各学科完成率均不低于${BRIEF.lowFinish}%，建议保持题量与截止时间的一致性，巩固完成度`,
    )
  }

  // ③ 错题重练覆盖面
  const bookletRows = activeSubjects(grade)
    .map((s) => ({ s, cover: s.booklet?.coverPercent, count: s.booklet?.taskCount }))
    .filter((r) => isNum(r.cover))
  if (bookletRows.length) {
    const weak = sortByAsc(bookletRows, (r) => r.cover).filter((r) => r.cover < 100)
    if (weak.length) {
      const parts = weak.slice(0, 3).map((r) => `${shortOf(r.s)}覆盖率${pctInt(r.cover)}`)
      const more = weak.length > 3 ? `等${weak.length}个学科` : ''
      push(
        `扩大错题重练覆盖面：${parts.join('、')}${more}，建议每次讲评后自动生成重练任务，形成“错题—重练—讲评”闭环`,
      )
    } else {
      const names = bookletRows.filter((r) => r.cover >= 100).map((r) => shortOf(r.s))
      push(
        `巩固错题重练：${names.slice(0, 4).join('、')}重练覆盖率已达100%，建议保持每次讲评后生成重练任务，形成“错题—重练—讲评”闭环`,
      )
    }
  }

  // ④ 未布置作业学科
  const missing = missingSubjects(grade)
  if (missing.length) {
    const names = missing.map(shortOf).join('、')
    push(`${names}尚未开展作业布置，建议先从一个班、一次课后作业起步，跑通流程后再铺开`)
  }

  // ⑤ 固定建议
  push('建议各学科组开展1—2次平台示范课，把数据用在习题讲评与分层辅导上，提升系统对教学的支撑度')

  return { name: '提升与建议：', items }
}

// ---------------------------------------------------------------- 图表（可选）

/** HTML 版图表的降级数据表（charts.js 的简报函数未就绪时使用） */
function subjectTable(grade) {
  const subs = activeSubjects(grade)
  if (!subs.length) return null
  return {
    head: ['学科', '习题任务', '完成率', '阅卷率', '师阅率'],
    aligns: ['', 'r', 'r', 'r', 'r'],
    widths: [3, 3, 3, 3, 3],
    rows: subs.map((s) => [
      shortOf(s),
      intStr(s.taskCount) || '—',
      pctInt(s.finishPercent) || '—',
      pctInt(markOf(s)) || '—',
      pctInt(s.teacherMarkPercent) || '—',
    ]),
  }
}

function teacherTable(grade) {
  const rows = sortByDesc(activeTeachersOf(grade), (t) => t.taskCount).slice(0, 8)
  if (!rows.length) return null
  return {
    head: ['教师', '学科', '任务', '完成率', '阅卷率', '重练覆盖'],
    aligns: ['', '', 'r', 'r', 'r', 'r'],
    widths: [3, 2, 2, 3, 3, 3],
    rows: rows.map((t) => [
      t.name,
      shortOf(t),
      intStr(t.taskCount) || '—',
      pctInt(t.finishPercent) || '—',
      pctInt(markOf(t)) || '—',
      isNum(t.booklet?.coverPercent) && asZero(t.booklet?.taskCount) > 0
        ? pctInt(t.booklet.coverPercent)
        : '—',
    ]),
  }
}

/**
 * 解析 opts.figures：Word 默认 false，HTML 默认 true。
 * 既接受布尔，也接受 { teacher: true, subject: true } 对象。
 */
function resolveFigures(opts, mode) {
  const docx = mode === 'docx'
  const clamp = (v) => (mode === 'docx' ? false : !!v)
  const raw = opts ? opts.figures : undefined
  if (raw === false || raw === null) return { teacher: false, subject: false }
  if (raw === true || raw === undefined) {
    const on = !docx
    return { teacher: on, subject: on }
  }
  if (typeof raw === 'object') {
    const on = (v) => clamp(v === undefined ? !docx : v)
    return { teacher: on(raw.teacher), subject: on(raw.subject) }
  }
  return { teacher: false, subject: false }
}

/**
 * 图表（同步）：用 charts.js 的 briefSubjectSvg / briefTeacherSvg。
 * 函数不存在、返回空串或抛错时，降级为「图题 + 同源数据表」，绝不抛错、绝不输出空图框。
 * @returns {Array<{key, caption, svg, data}>}
 */
function buildFigures(grade, which) {
  const out = []
  const gradeName = String(grade?.gradeName || '')

  if (which.subject) {
    const fig = { key: 'subject', caption: `${gradeName} 各学科完成率与阅卷率对比`, svg: null, data: subjectTable(grade) }
    if (typeof charts.briefSubjectSvg === 'function') {
      try {
        const svg = charts.briefSubjectSvg(grade)
        if (typeof svg === 'string' && svg.trim()) fig.svg = svg
      } catch {
        /* 图表异常：保留数据表 */
      }
    }
    if (fig.svg || fig.data) out.push(fig)
  }

  if (which.teacher) {
    const fig = { key: 'teacher', caption: `${gradeName} 教师完成率与阅卷率对比（按任务量前 8 位）`, svg: null, data: teacherTable(grade) }
    if (typeof charts.briefTeacherSvg === 'function') {
      try {
        const svg = charts.briefTeacherSvg(grade)
        if (typeof svg === 'string' && svg.trim()) fig.svg = svg
      } catch {
        /* 图表异常：保留数据表 */
      }
    }
    if (fig.svg || fig.data) out.push(fig)
  }

  return out
}

// ---------------------------------------------------------------- doc 模型

function gradeStats(grade, m, act, sections) {
  const s = summaryOf(grade)
  return {
    gradeId: grade.gradeId ?? null,
    gradeName: String(grade.gradeName || ''),
    levelName: String(grade.levelName || ''),
    classCount: isNum(grade.classCount) ? grade.classCount : null,
    days: isNum(s.days) ? s.days : null,
    taskCount: isNum(s.taskCount) ? s.taskCount : null,
    exerciseTaskCount: isNum(s.exerciseTaskCount) ? s.exerciseTaskCount : null,
    questionCount: isNum(s.questionCount) ? s.questionCount : null,
    dailyTask: isNum(s.dailyTask) ? s.dailyTask : null,
    dailyClassTask: round2(s.dailyClassTask),
    dailyQuestion: isNum(s.dailyQuestion) ? s.dailyQuestion : null,
    dailyClassQuestion: round2(s.dailyClassQuestion),
    finishPercent: round2(s.finishPercent),
    // 阅卷率：summary.markPercent → 学科按任务量加权 → teacherMarkPercentAvg 兜底
    markPercent: round2(m.markPercent),
    markPercentSource: m.markSource,
    teacherMarkPercentAvg: round2(s.teacherMarkPercentAvg),
    correctPercent: round2(s.correctPercent),
    selfPersonCount: round2(act.selfPerson),
    selfQuestionCount: round2(act.selfQuestion),
    watchCount: round2(act.watchCount),
    bookletTaskCount: act.hasBookletData ? round2(act.bookletCount) : null,
    targetTaskCount: act.hasTargetData ? round2(act.targetCount) : null,
    targetQuestionCount: act.hasTargetData ? round2(act.targetQuestion) : null,
    subjectCount: m.subs.length,
    missingSubjects: missingSubjects(grade).map(shortOf),
    sectionCount: sections.length,
    itemCount: sections.reduce((acc, x) => acc + x.items.length, 0),
  }
}

/**
 * 单年级的简报 doc 模型。
 * @param {object} grade
 * @param {object} ctx  { meta, opts }
 */
function briefDocOf(grade, ctx) {
  const m = gradeMetrics(grade)
  const act = activityStats(grade)
  const intro = introOf(grade, m, act)
  const sections = [subjectSection(grade, m), teacherSection(grade, m), adviceSection(grade, m)].filter(
    (s) => s.items.length > 0,
  )
  return {
    title: titleOf(grade, ctx.meta),
    gradeName: String(grade.gradeName || ''),
    levelName: String(grade.levelName || ''),
    intro,
    sections,
    figures: [], // 由 buildBriefDocument 异步填充（可选）
    stats: gradeStats(grade, m, act, sections),
  }
}

/** 取出要出的年级：opts.gradeIds（gradeId 或 gradeName 均可） */
function selectGrades(model, opts) {
  const grades = (Array.isArray(model?.grades) ? model.grades : []).filter(
    (g) => g && Array.isArray(g.subjects),
  )
  const ids = opts?.gradeIds
  if (!Array.isArray(ids) || !ids.length) return grades
  const wanted = new Set(ids.map((x) => String(x)))
  return grades.filter((g) => wanted.has(String(g.gradeId)) || wanted.has(String(g.gradeName)))
}

/**
 * 生成简报 doc 模型。
 * - 未指定 opts.gradeIds 时，model.grades 全部年级各出一节：
 *   返回容器 `{ multi: true, title, docs, stats }`，docs 为每届一份完整 briefDoc（标题各不相同）；
 * - 指定单个 gradeIds 时直接返回该届的 briefDoc；
 * - 指定多个 gradeIds 时返回容器。
 * @returns {object}
 */
export function buildBriefDocument(model, opts = {}) {
  if (!model || typeof model !== 'object') {
    throw new Error('报告数据为空：无法生成简报')
  }
  const grades = selectGrades(model, opts)
  if (!grades.length) {
    throw new Error('报告数据为空：缺少年级明细，无法生成简报')
  }
  const ctx = { meta: model.meta || {}, opts }
  const docs = grades.map((grade) => briefDocOf(grade, ctx))

  // 可选插图：HTML 默认开、Word 默认关；任一图失败都不影响正文
  const which = resolveFigures(opts, opts.figuresMode === 'docx' ? 'docx' : 'html')
  if (which.teacher || which.subject) {
    for (let i = 0; i < docs.length; i += 1) {
      docs[i].figures = buildFigures(grades[i], which)
    }
  }

  const stats = aggregateStats(docs, model, grades)
  if (docs.length === 1) {
    return Object.assign(docs[0], { stats: Object.assign({}, docs[0].stats, stats.overall) })
  }
  return {
    multi: true,
    title: containerTitle(model, docs),
    docs,
    stats,
  }
}

function containerTitle(model, docs) {
  const meta = model?.meta || {}
  const from = dateCn(meta.from)
  const to = dateCn(meta.to)
  const school = meta.siteTitle || meta.schoolAlias || ''
  const range = from && to ? `${from}-${to}` : ''
  const gradeNames = docs.map((d) => d.gradeName).filter(Boolean).join('、')
  const stem = `${school}使用简报`
  if (gradeNames && range) return `${stem}（${gradeNames}，${range}）`
  if (range) return `${stem}（${range}）`
  return stem
}

function aggregateStats(docs, model, grades) {
  const meta = model?.meta || {}
  const tasks = docs.map((d) => d.stats.taskCount).filter(isNum)
  const questions = docs.map((d) => d.stats.questionCount).filter(isNum)
  return {
    gradeCount: docs.length,
    gradeNames: docs.map((d) => d.gradeName),
    from: meta.from || null,
    to: meta.to || null,
    days: isNum(meta.days) ? meta.days : docs[0]?.stats.days ?? null,
    taskCount: tasks.length ? tasks.reduce((a, b) => a + b, 0) : null,
    questionCount: questions.length ? questions.reduce((a, b) => a + b, 0) : null,
    sectionCount: docs.reduce((a, d) => a + d.sections.length, 0),
    itemCount: docs.reduce((a, d) => a + d.stats.itemCount, 0),
    figureCount: docs.reduce((a, d) => a + d.figures.length, 0),
    titles: docs.map((d) => d.title),
    overall: {
      gradeCount: docs.length,
      gradeNames: docs.map((d) => d.gradeName),
      sectionCount: docs.reduce((a, d) => a + d.sections.length, 0),
      itemCount: docs.reduce((a, d) => a + d.stats.itemCount, 0),
    },
  }
}

// ---------------------------------------------------------------- Word 渲染

/**
 * 简报 Word（.docx Buffer）。版式见 docx.js 的 buildBriefDocx；
 * Word 默认不放位图（opts.figures 默认 false），图表降级为「图题 + 数据表」。
 * @returns {Buffer}
 */
export function buildBriefDocx(model, opts = {}) {
  const brief = buildBriefDocument(model, { ...opts, figuresMode: 'docx' })
  return buildBriefWord(brief, opts)
}

// ---------------------------------------------------------------- HTML 渲染

const HTML_STYLES = `
/* A4 + 25.4mm/31.75mm 页边距：与简报 Word 版一致（上下 1440、左右 1800 twip）。
   正文 10.5pt 宋体 + Times New Roman，行距 1.2，左对齐（不两端对齐，避免中文散字）。
   行距取 1.2 而非 1.3：1.3 时 2024 级（条目最多的一届）末行落在 755pt，
   距版心下沿 770pt 只剩 15pt（约一行），真实数据稍有波动就会溢出到第 4 页；
   1.2 时余量 62pt，留足一页的安全边界，观感上仍是密排。 */
@page { size: A4; margin: 25.4mm 31.75mm; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
html, body { margin: 0; padding: 0; background: #ffffff; }
body {
  font-family: "宋体", "Songti SC", "SimSun", "STSong", serif;
  font-size: 10.5pt;
  line-height: 1.20;
  color: #000;
  -webkit-font-smoothing: antialiased;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.brief { display: block; }
.brief + .brief { page-break-before: always; break-before: page; }
h1.brief-title {
  margin: 0 0 2pt;
  font-size: 10.5pt;
  font-weight: bold;
  text-align: center;
  line-height: 1.20;
}
p {
  margin: 0;
  text-indent: 21pt;
  text-align: left;
  line-height: 1.20;
}
h2.brief-section {
  margin: 2pt 0;
  font-family: "宋体", "Songti SC", "SimSun", serif;
  font-size: 14pt;
  font-weight: normal;
  line-height: 1.2;
  page-break-after: avoid;
  break-after: avoid;
}
/* 条目：• 用 text-indent:-21pt 做到「行首悬挂、折行与正文对齐」，比绝对定位更省版面、
   也不会因字体缺字把圆点挤成空框 */
p.bullet {
  text-indent: -21pt;
  padding-left: 21pt;
}
p.bullet > span.dot { display: inline-block; width: 21pt; text-indent: 0; }
p.bullet.level1, p.text.level1 { padding-left: 42pt; text-indent: 21pt; }
p.text { text-indent: 21pt; padding-left: 0; }
figure.brief-fig {
  margin: 6pt 0 3pt;
  page-break-inside: avoid;
  break-inside: avoid;
}
figure.brief-fig svg { display: block; width: 100%; height: auto; }
figure.brief-fig figcaption {
  margin-top: 3pt;
  font-size: 9pt;
  text-align: center;
  text-indent: 0;
}
table.brief-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 10.5pt;
}
table.brief-table th, table.brief-table td {
  border: 0.5pt solid #000;
  padding: 1pt 2pt;
  text-align: center;
  word-break: break-all;
}
table.brief-table th { background: #F2F2F2; font-weight: bold; }
table.brief-table td.num { text-align: right; }
`

function htmlItem(item) {
  const level = item.level ? ` level${item.level}` : ''
  if (item.type === 'bullet') {
    return `<p class="bullet${level}"><span class="dot">•</span>${esc(item.text)}</p>`
  }
  return `<p class="text${level}">${esc(item.text)}</p>`
}

function htmlTableFor(data) {
  if (!data || !Array.isArray(data.head) || !Array.isArray(data.rows)) return ''
  const aligns = data.aligns || []
  const head = `<tr>${data.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>`
  const rows = data.rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, i) => `<td${aligns[i] === 'r' ? ' class="num"' : ''}>${esc(cell)}</td>`)
          .join('')}</tr>`,
    )
    .join('')
  return `<table class="brief-table"><thead>${head}</thead><tbody>${rows}</tbody></table>`
}

function figureHtml(fig) {
  if (fig.svg && typeof fig.svg === 'string') {
    return `<figure class="brief-fig">${fig.svg}<figcaption>${esc(fig.caption)}</figcaption></figure>`
  }
  if (!fig.data) return ''
  return `<figure class="brief-fig">${htmlTableFor(fig.data)}<figcaption>${esc(fig.caption)}</figcaption></figure>`
}

function docHtml(doc) {
  const parts = [`<h1 class="brief-title">${esc(doc.title)}</h1>`]
  for (const line of doc.intro || []) parts.push(`<p>${esc(line)}</p>`)
  for (const section of doc.sections || []) {
    parts.push(`<h2 class="brief-section">${esc(section.name)}</h2>`)
    for (const item of section.items || []) parts.push(htmlItem(item))
  }
  for (const fig of doc.figures || []) {
    const html = figureHtml(fig)
    if (html) parts.push(html)
  }
  return `<section class="brief">\n${parts.join('\n')}\n</section>`
}

/**
 * 简报的网页可打印版（A4）。单文件、无外部资源，可直接用 Chrome --print-to-pdf 出 PDF。
 * 图表来自 charts.js 的 briefTeacherSvg / briefSubjectSvg；未就绪时自动降级为「图题 + 数据表」。
 * @returns {string}
 */
export function buildBriefHtml(model, opts = {}) {
  const figures = opts.figures === undefined ? true : opts.figures
  const brief = buildBriefDocument(model, { ...opts, figures, figuresMode: 'html' })
  return renderBriefPage(brief)
}

// ---------------------------------------------------------------- 一次性产出

/**
 * 一次构建简报的全部载体。
 * @param {object} model
 * @param {object} opts { gradeIds?, figures? }
 * @returns {{docx: Buffer, html: string, brief: object, stats: object}}
 */
export function buildBrief(model, opts = {}) {
  // 默认出「纯文字版」：与参考件《使用情况简报》一致，每届 1 页。
  // 只有显式传 figures: true 才插图（每届会变成 2 页：正文 + 图题/数据表）。
  // 注意 docx 与 html 必须用同一份 brief 对象渲染，否则会出现
  // 「Word 3 页、HTML 打印 6 页」这种两份产物不一致的问题（曾发生）。
  const figures = opts.figures === undefined ? false : opts.figures
  const brief = buildBriefDocument(model, { ...opts, figures, figuresMode: 'html' })
  const docx = buildBriefWord(brief, { ...opts, figures })
  const html = renderBriefPage(brief)
  return { docx, html, brief, stats: brief.stats }
}

/** HTML 页面骨架：单文件、零外部资源；多年级每届一页（打印分页） */
function renderBriefPage(brief) {
  const docs = brief && brief.multi ? brief.docs : [brief]
  const title = (brief && brief.title) || '使用简报'
  const body = docs.filter(Boolean).map(docHtml).join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${HTML_STYLES}</style>
</head>
<body>
<div id="brief">
${body}
</div>
</body>
</html>
`
}

export default { buildBrief, buildBriefDocument, buildBriefHtml, buildBriefDocx }
