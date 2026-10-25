// 插件安装后的端到端验收：直接打本机 Web 路由。
// 用法：node scripts/verify-installed.mjs [origin] [school] [from] [to]
const origin = process.argv[2] || 'http://127.0.0.1:59285'
const school = process.argv[3] || 'lyyz'
const from = process.argv[4] || '2026-10-08'
const to = process.argv[5] || '2026-10-21'

const api = (p) => `${origin}/fuulea-report/api/${p}`
async function jfetch(url, opts) {
  const res = await fetch(url, opts)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}
const show = (label, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)

const d = await jfetch(api('defaults'))
show('GET /defaults', d.status === 200 && d.json?.ok, `${d.status} ${d.json?.defaults ? JSON.stringify(d.json.defaults) : d.text.slice(0, 120)}`)

const s = await jfetch(api('snapshot'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ school, from, to }) })
const snap = s.json?.snapshot
show('POST /snapshot', s.status === 200 && !!snap, snap ? `${snap.meta.siteTitle} | ${snap.grades.map((g) => g.gradeName + '/' + g.levelName).join(', ')} | tasks=${snap.totals.taskCount} questions=${snap.totals.questionCount}` : s.text.slice(0, 300))

const r = await jfetch(api('report'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ school, from, to }) })
if (r.status === 200 && r.json?.ok) {
  console.log('PASS  POST /report')
  for (const f of r.json.files) console.log(`      ${f.kind.padEnd(8)} ${f.name}  ${(f.bytes / 1024).toFixed(1)}KB  ${f.url}`)
  const pdf = r.json.files.find((f) => f.kind === 'pdf')
  const md = r.json.files.find((f) => f.kind === 'markdown')
  const html = r.json.files.find((f) => f.kind === 'html')
  if (pdf) {
    const { execSync } = await import('node:child_process')
    const out = execSync(`pdftotext -layout "${pdf.path}" - | head -200`, { encoding: 'utf8' })
    const pages = execSync(`pdfinfo "${pdf.path}" | awk '/^Pages/{print $2}'`, { encoding: 'utf8' }).trim()
    console.log(`      PDF pages=${pages} chars=${out.length} head=${JSON.stringify(out.slice(0, 120))}`)
  }
  if (md) console.log('      MD  bytes', (await import('node:fs')).statSync(md.path).size)
  if (html) console.log('      HTML bytes', (await import('node:fs')).statSync(html.path).size)
  console.log('      outputDir:', r.json.outputDir)
  console.log('      warnings:', JSON.stringify(r.json.warnings))
} else {
  show('POST /report', false, r.text.slice(0, 400))
}
