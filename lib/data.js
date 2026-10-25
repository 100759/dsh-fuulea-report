// 把智慧教学云「管理看板」的数据整理成报告模型。
//
// 数据来源（全部为只读 GET）：
//   1) /v2/dashboard/export/?siteId&gradeId&from&to  → xlsx（教学统计：学科/教师/班级 三张表）
//      - 学科基本教学：任务量、习题量、完成率、师阅率、留痕率、重练、靶向、资源建设、观看…
//      - 教师教学详情：教师维度同上
//      - 班级学习行为：班级 × 学科学情
//   2) /v2/dashboard/teach/?gradeId&from&to          → JSON（总览 + 学科自学/视频分组）
//      - selfStudy.subjectGroup：自学人次(paperCount)/自学题量(questionCount)
//      - video.subjectGroup：观看人次/观看时长（与 xlsx 一致，可交叉校验）
//
// 模型只包含报告需要的字段；所有百分比均为数值（不是字符串），缺失值为 null。
import { readWorkbook, sheetToRecords } from './xlsx.js'

const SUBJECT_ORDER = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '政治']

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const n = Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}
const sum = (arr, f) => arr.reduce((a, b) => a + (num(b[f]) ?? 0), 0)
const weighted = (arr, valueField, weightField) => {
  let s = 0
  let w = 0
  for (const row of arr) {
    const v = num(row[valueField])
    const wt = num(row[weightField])
    if (v === null || wt === null || wt <= 0) continue
    s += v * wt
    w += wt
  }
  return w > 0 ? s / w : null
}
const mean = (arr, f) => {
  const vals = arr.map((r) => num(r[f])).filter((v) => v !== null)
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}
const round = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d)

/** 短学科名：高中语文 → 语文 */
export function shortSubject(name) {
  return String(name || '').replace(/^(高中|初中|小学)/, '')
}

/**
 * 观看时长（平台单位是「分钟」，导出列为 "H:MM"，如 "24:32" 表示 24 小时 32 分）→ 分钟数。
 */
export function parseDuration(text) {
  if (text === null || text === undefined || text === '') return null
  if (typeof text === 'number') return text
  const parts = String(text).split(':').map((x) => Number(x))
  if (parts.some((n) => !Number.isFinite(n))) return null
  if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return null
}

/** 分钟 → "HH:MM"（时:分，与平台展示一致） */
export function formatDuration(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—'
  const total = Math.round(minutes)
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 分钟 → 小时（保留 1 位小数） */
export function toHours(minutes) {
  return minutes === null || minutes === undefined || !Number.isFinite(minutes) ? null : Math.round((minutes / 60) * 10) / 10
}

/** 学年与年级名：2024级 在 2026 年 10 月 → 高三年级 */
export function levelNameOf(gradeName, refDateISO) {
  const m = /(\d{4})级/.exec(String(gradeName || ''))
  if (!m) return ''
  const entryYear = Number(m[1])
  const d = new Date(refDateISO || Date.now())
  const y = d.getFullYear()
  const month = d.getMonth() + 1
  const academicYear = month >= 8 ? y : y - 1
  const gradeNo = academicYear - entryYear + 1
  if (gradeNo === 1) return '高一年级'
  if (gradeNo === 2) return '高二年级'
  if (gradeNo === 3) return '高三年级'
  return `${gradeNo}年级`
}

function isoDate(d) {
  const dt = d instanceof Date ? d : new Date(d)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const day = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function daysInclusive(from, to) {
  const a = new Date(from + 'T00:00:00')
  const b = new Date(to + 'T00:00:00')
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1)
}

function pickSheet(workbook, name) {
  return workbook.sheets.find((s) => s.name === name) || null
}

function subjectFrom(row, teachSubject) {
  const name = String(row['学科'] || '')
  const watchMin = parseDuration(row['观看时长'])
  const self = teachSubject
    ? {
        personCount: num(teachSubject.paperCount),
        questionCount: num(teachSubject.questionCount),
        sharePercent: null, // 在年级层统一算占比
      }
    : null
  return {
    name,
    short: shortSubject(name),
    missing: num(row['任务量']) === null && num(row['习题量']) === null,
    taskCount: num(row['任务量']),
    exerciseTaskCount: num(row['习题任务']),
    exerciseTaskPerTeacher: num(row['师均习题任务']),
    questionCount: num(row['习题量']),
    avgQuestionsByStudent: num(row['生均题量']),
    submitPercent: num(row['提交率']),
    finishPercent: num(row['完成率']),
    correctPercent: num(row['得分率']),
    subjectiveTaskCount: num(row['主观任务数']),
    subjectiveQuestionCount: num(row['主观题数']),
    tagPercent: num(row['题目标签率']),
    markPercent: num(row['阅卷率']),
    teacherMarkShare: num(row['师阅占比']),
    teacherMarkQuestionCount: num(row['师阅题目']),
    teacherMarkPercent: num(row['师阅率']),
    studentMarkPercent: num(row['学生阅卷率']),
    reviewPercent: num(row['复核率']),
    tracePercent: num(row['留痕率']),
    booklet: {
      taskCount: num(row['重练任务数']),
      coverPercent: num(row['重练覆盖率']),
      finishPercent: num(row['重练完成率']),
      correctPercent: num(row['重练得分率']),
    },
    target: {
      taskCount: num(row['靶向任务']),
      questionCount: num(row['靶向习题']),
      finishPercent: num(row['靶向完成率']),
      classCount: num(row['靶向班']),
      studentCount: num(row['靶向学生']),
    },
    resource: {
      tag: num(row['打标签']),
      audio: num(row['音频讲解']),
      video: num(row['视频讲解']),
    },
    self,
    watch: {
      count: num(row['观看人次']),
      durationMin: watchMin,
      durationText: formatDuration(watchMin),
    },
  }
}

function teacherFrom(row, short) {
  return {
    name: String(row['姓名'] || ''),
    subject: String(row['学科'] || ''),
    short,
    taskCount: num(row['任务量']),
    exerciseTaskCount: num(row['习题任务']),
    questionCount: num(row['习题量']),
    avgQuestionsByStudent: num(row['生均题量']),
    submitPercent: num(row['提交率']),
    finishPercent: num(row['完成率']),
    correctPercent: num(row['得分率']),
    subjectiveTaskCount: num(row['主观任务数']),
    subjectiveQuestionCount: num(row['主观题数']),
    markPercent: num(row['阅卷率']),
    teacherMarkShare: num(row['师阅占比']),
    teacherMarkQuestionCount: num(row['师阅题目']),
    teacherMarkPercent: num(row['师阅率']),
    tracePercent: num(row['留痕率']),
    booklet: {
      taskCount: num(row['重练任务数']),
      coverPercent: num(row['重练覆盖率']),
      finishPercent: num(row['重练完成率']),
      correctPercent: num(row['重练得分率']),
    },
    target: {
      taskCount: num(row['靶向任务']),
      questionCount: num(row['靶向习题']),
      finishPercent: num(row['靶向完成率']),
      classCount: num(row['靶向班']),
      studentCount: num(row['靶向学生']),
    },
    resource: {
      tag: num(row['打标签']),
      audio: num(row['音频讲解']),
      video: num(row['视频讲解']),
    },
  }
}

function classFrom(row) {
  return {
    className: String(row['班级'] || ''),
    type: String(row['类型'] || ''),
    subject: String(row['学科'] || ''),
    short: shortSubject(row['学科']),
    teacher: String(row['教师'] || ''),
    taskCount: num(row['任务量']),
    questionCount: num(row['习题量']),
    finishPercent: num(row['完成率']),
    correctPercent: num(row['得分率']),
    teacherMarkPercent: num(row['师阅率']),
    tracePercent: num(row['留痕率']),
    bookletTaskCount: num(row['重练任务数']),
    bookletCoverPercent: num(row['重练覆盖率']),
    selfPersonCount: num(row['自学人次']),
    selfQuestionCount: num(row['自学题量']),
    watchCount: num(row['观看人次']),
  }
}

/** 由「xlsx 工作簿 + teach JSON」生成单个年级的模型。 */
export function buildGradeModel({ gradeId, workbook, teach, from, to }) {
  const sheetSubject = pickSheet(workbook, '学科基本教学')
  const sheetTeacher = pickSheet(workbook, '教师教学详情')
  const sheetClass = pickSheet(workbook, '班级学习行为')
  if (!sheetSubject) throw new Error(`年级 ${gradeId} 的导出缺少「学科基本教学」工作表`)

  const subjectRows = sheetToRecords(sheetSubject.rows)
  const teacherRows = sheetTeacher ? sheetToRecords(sheetTeacher.rows) : []
  const classRows = sheetClass ? sheetToRecords(sheetClass.rows) : []

  const gradeNameMatch = /(\d{4}级)/.exec(String(sheetSubject.rows?.[0]?.[0] || teach?.gradeName || ''))
  const gradeName = gradeNameMatch ? gradeNameMatch[1] : `年级${gradeId}`

  const teachSelf = new Map()
  const teachVideo = new Map()
  for (const s of teach?.selfStudy?.subjectGroup || []) teachSelf.set(String(s.name), s)
  for (const s of teach?.video?.subjectGroup || []) teachVideo.set(String(s.name), s)

  const subjects = subjectRows
    .map((row) => {
      const name = String(row['学科'] || '')
      const model = subjectFrom(row, teachSelf.get(name))
      const teachWatch = teachVideo.get(name)
      if (teachWatch) {
        model.watch.count = num(teachWatch.watchCount) ?? model.watch.count
        const minutes = num(teachWatch.watchDuration)
        if (minutes !== null) {
          model.watch.durationMin = minutes
          model.watch.durationText = formatDuration(minutes)
        }
      }
      return model
    })
    .sort((a, b) => {
      const ia = SUBJECT_ORDER.indexOf(a.short)
      const ib = SUBJECT_ORDER.indexOf(b.short)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })

  // 自学占比（按年级自学人次为分母）
  const selfTotalPerson = subjects.reduce((a, s) => a + (s.self?.personCount ?? 0), 0)
  for (const s of subjects) {
    if (s.self && selfTotalPerson > 0) s.self.sharePercent = round(((s.self.personCount ?? 0) / selfTotalPerson) * 100, 1)
  }

  const teachers = teacherRows
    .map((row) => teacherFrom(row, shortSubject(row['学科'])))
    .filter((t) => t.name && ((t.taskCount ?? 0) > 0 || (t.booklet.taskCount ?? 0) > 0 || (t.target.taskCount ?? 0) > 0))

  // 「班级学习行为」表里混有跨学科汇总行（学科列为「总计」/「合计」/「小计」，数值是学科合计的翻倍），
  // 既不是真实班级行也会污染班均/班际口径 —— 统一剔除，只保留有班级名与学科名的明细行。
  const isSummaryRow = (row) => /^(总计|合计|小计)$/.test(String(row['学科'] || '').trim())
  const classes = classRows
    .filter((row) => !isSummaryRow(row) && String(row['班级'] || '').trim() && String(row['学科'] || '').trim())
    .map(classFrom)
    .filter((c) => c.className)
  const adminClasses = [...new Set(classes.filter((c) => c.type === '行政班').map((c) => c.className))]
  const classCount = adminClasses.length || 0

  const days = daysInclusive(from, to)
  const taskCount = sum(subjects, 'taskCount')
  const exerciseTaskCount = sum(subjects, 'exerciseTaskCount')
  const questionCount = sum(subjects, 'questionCount')
  const finishPercent = weighted(subjects, 'finishPercent', 'taskCount')
  const correctPercent = weighted(subjects, 'correctPercent', 'questionCount')
  const teacherMarkPercentAvg = mean(subjects, 'teacherMarkPercent')
  // 阅卷率（markPercent）按任务量加权：只统计有任务量的学科，缺失为 null。
  // 简报版（lib/brief.js）优先用它；没有时回退 teacherMarkPercentAvg。
  const markPercent = weighted(subjects, 'markPercent', 'taskCount')
  const watchCount = subjects.reduce((a, s) => a + (s.watch.count ?? 0), 0)
  const watchDurationMin = subjects.reduce((a, s) => a + (s.watch.durationMin ?? 0), 0)
  const selfPerson = subjects.reduce((a, s) => a + (s.self?.personCount ?? 0), 0)
  const selfQuestion = subjects.reduce((a, s) => a + (s.self?.questionCount ?? 0), 0)

  const summary = {
    days,
    taskCount,
    exerciseTaskCount,
    questionCount,
    materialTaskRatio: taskCount > 0 ? round((1 - exerciseTaskCount / taskCount) * 100, 1) : null,
    dailyTask: round(taskCount / days, 2),
    dailyClassTask: classCount > 0 ? round(taskCount / (days * classCount), 2) : null,
    dailyQuestion: round(questionCount / days, 2),
    dailyClassQuestion: classCount > 0 ? round(questionCount / (days * classCount), 2) : null,
    finishPercent: round(finishPercent, 2),
    correctPercent: round(correctPercent, 2),
    teacherMarkPercentAvg: round(teacherMarkPercentAvg, 2),
    markPercent: round(markPercent, 2),
    watchCount,
    watchDurationMin: Math.round(watchDurationMin * 10) / 10,
    watchDurationText: formatDuration(watchDurationMin),
    watchHours: toHours(watchDurationMin),
    selfPersonCount: selfPerson,
    selfQuestionCount: selfQuestion,
  }

  const activeSelf = subjects
    .filter((s) => (s.self?.personCount ?? 0) > 0)
    .sort((a, b) => (b.self.personCount ?? 0) - (a.self.personCount ?? 0))[0]

  return {
    gradeId,
    gradeName,
    levelName: levelNameOf(gradeName, from),
    classCount,
    adminClasses,
    summary,
    subjects,
    teachers,
    classes,
    selfStudy: {
      totalPersonCount: selfPerson,
      totalQuestionCount: selfQuestion,
      top: activeSelf
        ? {
            name: activeSelf.name,
            short: activeSelf.short,
            personCount: activeSelf.self.personCount,
            questionCount: activeSelf.self.questionCount,
            sharePercent: activeSelf.self.sharePercent,
          }
        : null,
    },
    watch: {
      count: watchCount,
      durationMin: Math.round(watchDurationMin * 10) / 10,
      durationText: formatDuration(watchDurationMin),
      hours: toHours(watchDurationMin),
    },
  }
}

/** 抓取完整模型：登录 → 每个年级导出 xlsx + teach JSON → buildGradeModel → 汇总。 */
export async function fetchSnapshot(api, { from, to, gradeIds = null } = {}) {
  if (!from || !to) throw new Error('缺少统计起止日期')
  const fromISO = isoDate(from)
  const toISO = isoDate(to)
  if (new Date(fromISO) > new Date(toISO)) throw new Error('开始日期不能晚于结束日期')

  await api.ensureAuth()
  const user = api.user || {}
  let gradeList = Array.isArray(gradeIds) && gradeIds.length ? gradeIds.map(Number) : null
  if (!gradeList) {
    const candidates = []
    for (const key of ['chargedGradeIds', 'manageGradeIds']) {
      const v = user[key]
      if (Array.isArray(v)) candidates.push(...v.map(Number))
    }
    gradeList = [...new Set(candidates)]
    if (!gradeList.length) {
      gradeList = await discoverGradeIds(api)
    }
  }
  if (!gradeList.length) throw new Error('当前账号没有可用的年级（chargedGradeIds 为空）')

  const warnings = []
  const grades = []
  for (const gradeId of gradeList) {
    const label = `年级 ${gradeId}`
    let workbook = null
    try {
      const buf = await api.getBinary('/v2/dashboard/export/', {
        siteId: user.siteId, gradeId, from: fromISO, to: toISO,
      })
      workbook = readWorkbook(buf)
    } catch (e) {
      warnings.push(`${label} 导出失败：${e.message}`)
      continue
    }
    let teach = null
    try {
      const res = await api.get('/v2/dashboard/teach/', { gradeId, from: fromISO, to: toISO })
      if (res.status === 200 && res.json) teach = res.json
      else warnings.push(`${label} 学情总览读取失败（HTTP ${res.status}），自学数据可能缺失`)
    } catch (e) {
      warnings.push(`${label} 学情总览读取失败：${e.message}`)
    }
    try {
      grades.push(buildGradeModel({ gradeId, workbook, teach, from: fromISO, to: toISO }))
    } catch (e) {
      warnings.push(`${label} 数据解析失败：${e.message}`)
    }
  }

  const entryYear = (g) => Number((/(\d{4})级/.exec(g.gradeName) || [])[1] || 0)
  grades.sort((a, b) => entryYear(a) - entryYear(b))

  const totals = {
    gradeCount: grades.length,
    taskCount: grades.reduce((a, g) => a + g.summary.taskCount, 0),
    questionCount: grades.reduce((a, g) => a + g.summary.questionCount, 0),
    selfPersonCount: grades.reduce((a, g) => a + g.summary.selfPersonCount, 0),
    selfQuestionCount: grades.reduce((a, g) => a + g.summary.selfQuestionCount, 0),
    watchCount: grades.reduce((a, g) => a + g.summary.watchCount, 0),
    watchDurationMin: Math.round(grades.reduce((a, g) => a + g.summary.watchDurationMin, 0) * 10) / 10,
  }
  const days = daysInclusive(fromISO, toISO)
  totals.days = days
  totals.dailyTask = round(totals.taskCount / days, 2)
  totals.dailyQuestion = round(totals.questionCount / days, 2)
  totals.watchDurationText = formatDuration(totals.watchDurationMin)
  totals.watchHours = toHours(totals.watchDurationMin)

  const siteTitle = user.siteTitle || api.host
  return {
    meta: {
      schoolAlias: api.host.split('.')[0],
      host: api.host,
      baseUrl: api.baseUrl,
      siteId: user.siteId ?? null,
      siteTitle,
      from: fromISO,
      to: toISO,
      days,
      generatedAt: new Date().toISOString(),
      user: { userName: user.userName || '', firstName: user.firstName || '', isSuper: !!user.isSuper },
    },
    grades,
    totals,
    warnings,
  }
}

/** 兜底：/v2/classrooms/grades/ 拿年级列表。 */
async function discoverGradeIds(api) {
  try {
    const res = await api.get('/v2/classrooms/grades/', {})
    if (res.status === 200 && Array.isArray(res.json)) {
      return res.json.map((g) => Number(g.id)).filter((x) => Number.isFinite(x))
    }
  } catch {
    /* 忽略 */
  }
  return []
}

export { SUBJECT_ORDER }

export default { fetchSnapshot, buildGradeModel, shortSubject, parseDuration, formatDuration, toHours, levelNameOf, daysInclusive }
