import fs from 'node:fs'
import { FuuleaApi, resolveBaseUrl, readCredentialsFile, DEFAULT_CREDENTIALS_FILE } from '../lib/api.js'
import { fetchSnapshot } from '../lib/data.js'

const alias = process.argv[2] || 'lyyz'
const from = process.argv[3] || '2026-10-08'
const to = process.argv[4] || '2026-10-21'
const creds = readCredentialsFile(DEFAULT_CREDENTIALS_FILE, alias)
if (!creds) throw new Error('no creds for ' + alias)
const api = new FuuleaApi({ baseUrl: resolveBaseUrl(alias), ...creds })
const snap = await fetchSnapshot(api, { from, to })
fs.writeFileSync('sample-model.json', JSON.stringify(snap, null, 2))
console.log('site:', snap.meta.siteTitle, 'grades:', snap.grades.map(g => g.gradeName + '/' + g.levelName + '/班' + g.classCount).join(', '))
for (const g of snap.grades) {
  console.log(`\n== ${g.gradeName} ${g.levelName}`)
  console.log(' summary', JSON.stringify(g.summary))
  console.log(' subjects:', g.subjects.map(s => `${s.short}:${s.taskCount ?? '-'}/${s.questionCount ?? '-'}/${s.finishPercent ?? '-'}%/${s.teacherMarkPercent ?? '-'}%/${s.tracePercent ?? '-'}`).join(' '))
  console.log(' teachers:', g.teachers.length, 'self:', g.selfStudy.totalPersonCount, g.selfStudy.totalQuestionCount, 'top:', g.selfStudy.top && g.selfStudy.top.short, 'watch:', g.watch.count, g.watch.durationText)
}
console.log('\ntotals', JSON.stringify(snap.totals))
console.log('warnings', snap.warnings)
