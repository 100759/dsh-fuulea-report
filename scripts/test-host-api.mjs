// 直接用假 ctx 加载 Host 半边，验证 /fuulea-report/api/* 路由（无需安装插件）。
import { Readable } from 'node:stream'
import { apply } from '../index.js'

let handler = null
const disposers = []
let toolDef = null
const ctx = {
  webServer: { register: (route) => { handler = route.handler; return () => { handler = null } } },
  tools: { register: (def) => { toolDef = def; return () => { toolDef = null } } },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
  get: (name) => (name === 'workingDirectory' ? { defaultDirectory: process.cwd() } : undefined),
}
apply(ctx, {})

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = Readable.from(payload ? [Buffer.from(payload)] : [])
    req.method = method
    req.url = url
    req.headers = { 'content-type': 'application/json' }
    const chunks = []
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(code, headers) { this.statusCode = code; this.headers = headers || {} },
      end(buf) { if (buf) chunks.push(Buffer.from(buf)); resolve({ status: this.statusCode, headers: this.headers, body: Buffer.concat(chunks).toString('utf8') }) },
      write(buf) { if (buf) chunks.push(Buffer.from(buf)); return true },
      on() {}, once() {}, emit() {},
    }
    handler(req, res)
    req.on('error', reject)
  })
}

const [cmd, a, b] = process.argv.slice(2)
try {
  if (cmd === 'defaults') {
    const r = await call('GET', '/fuulea-report/api/defaults')
    console.log(r.status, r.body.slice(0, 600))
  } else if (cmd === 'snapshot') {
    const r = await call('POST', '/fuulea-report/api/snapshot', { school: a || 'lyyz', from: '2026-10-08', to: '2026-10-21' })
    const j = JSON.parse(r.body)
    console.log(r.status, 'ok=', j.ok, j.error || '')
    if (j.snapshot) {
      const s = j.snapshot
      console.log('site:', s.meta.siteTitle, 'grades:', s.grades.map(g => g.gradeName).join(','), 'totals:', JSON.stringify(s.totals))
      console.log('warnings:', JSON.stringify(s.warnings))
    }
  } else if (cmd === 'report') {
    const r = await call('POST', '/fuulea-report/api/report', { school: a || 'lyyz', from: '2026-10-08', to: '2026-10-21' })
    const j = JSON.parse(r.body)
    console.log(r.status, 'ok=', j.ok, j.error || '')
    if (j.files) console.log('files:', j.files.map(f => `${f.kind}:${f.name} (${f.bytes}B) ${f.url}`).join('\n'), '\noutputDir:', j.outputDir, '\nwarnings:', JSON.stringify(j.warnings))
  } else if (cmd === 'tool') {
    if (!toolDef) throw new Error('tool 未注册')
    console.log('tool:', toolDef.name, '| params:', Object.keys(toolDef.parameters).join(','))
    const value = await toolDef.execute({ action: 'preview', school: a || 'lyyz', from: '2026-10-08', to: '2026-10-21' })
    const blocks = toolDef.output.render({}, value)
    console.log('render:', blocks[0].text)
  } else {
    console.log('用法: node scripts/test-host-api.mjs defaults|snapshot|report|tool [school]')
  }
} finally {
  for (const d of disposers) d()
}
