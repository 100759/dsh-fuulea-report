// 智慧教学云（fuulea）直连客户端：账号密码登录 + fl-sec-sign 签名 + 二进制下载。
// 只依赖 Node 内置能力（fetch / TextEncoder / node:zlib），可直接在 DSH Host 插件里运行。
//
// 关键事实（2026-10 实测）：
//  - 登录：POST /v2/auth/login/  {username, password}  → 返回 { token, siteId, siteTitle, chargedGradeIds, ... }
//  - 业务请求需要三个头：Authorization: jwt <token>、uuid、fl-sec-sign: <hex>,<unix秒>
//  - fl-sec-sign 的签名串 = `${METHOD} ${path}?${q}&none=${ts}&key=${key}&agent=${uuid}&uuid=${uuid}`
//    其中 key = JWT 签名段 sig[0:3]+sig[8:10]+sig[-5:]，q 为「key 小写=值」按原 key 排序后用 & 连接。
//  - 签名算法是 murmurhash3_x64_128（不是 md5），实现见 ./murmur3.js。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hex32 } from './murmur3.js'

export const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export const DEFAULT_CREDENTIALS_FILE = path.join(
  os.homedir(), '.workbuddy', 'skills', 'fuulea-teaching-cloud', 'scripts', '.credentials',
)

/** 从 jwt 的签名段派生签名 key。 */
export function signKeyOf(token) {
  const sig = String(token).split('.').pop()
  return sig.substring(0, 3) + sig.substring(8, 10) + sig.substring(sig.length - 5)
}

/** 生成一次请求的 fl-sec-sign 头值。 */
export function makeSign(key, uuid, method, pathname, params = {}) {
  const ts = Math.floor(Date.now() / 1000)
  const sp = new URLSearchParams()
  for (const k of Object.keys(params)) {
    const v = params[k]
    if (v !== null && v !== undefined) sp.set(k, String(v))
  }
  const q = Array.from(sp.keys()).sort().map((k) => k.toLowerCase() + '=' + sp.get(k)).join('&').trim()
  const s = `${method} ${pathname}?${q}&none=${ts}&key=${key}&agent=${uuid}&uuid=${uuid}`
  return `${hex32(new TextEncoder().encode(s))},${ts}`
}

/** 从本机技能包的凭据文件读取某个站点别名的账号密码（格式：别名|账号|密码）。 */
export function readCredentialsFile(file, alias) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const [a, u, p] = line.split('|')
      if (a === alias && u && p) return { username: u, password: p }
    }
  } catch {
    /* 凭据文件不存在或不可读时回落到显式参数 */
  }
  return null
}

/** 学校别名 → 站点地址；已是完整 URL 时原样返回。 */
export function resolveBaseUrl(schoolOrUrl) {
  const v = String(schoolOrUrl || '').trim().replace(/\/+$/, '')
  if (!v) return 'https://lyyz.fuulea.com'
  if (/^https?:\/\//i.test(v)) return v
  // 允许直接填写主机名（lyyz.fuulea.com）或学校子域名（lyyz）
  if (v.includes('.') || v.includes(':')) return `https://${v}`
  return `https://${v}.fuulea.com`
}

export class FuuleaApi {
  constructor({ baseUrl, username, password, uuid, token } = {}) {
    this.baseUrl = String(baseUrl || 'https://lyyz.fuulea.com').replace(/\/+$/, '')
    this.username = username || ''
    this.password = password || ''
    this.uuid = uuid || `v3_${Math.floor(Date.now() / 1000)}`
    this.token = token || ''
    this.user = null
    this.expiresAt = 0
  }

  get host() {
    return this.baseUrl.replace(/^https?:\/\//, '')
  }

  /** 账号密码登录；成功后记录 token 与用户信息。 */
  async login() {
    if (!this.username || !this.password) throw new Error('缺少账号或密码')
    const res = await fetch(`${this.baseUrl}/v2/auth/login/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': DEFAULT_UA,
        Origin: this.baseUrl,
        Referer: `${this.baseUrl}/`,
      },
      body: JSON.stringify({ username: this.username, password: this.password }),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON 时下面统一报错 */ }
    if (!res.ok || !json || !json.token) {
      const detail = json && (json.detail || json.message)
      throw new Error(`登录失败（HTTP ${res.status}）${detail ? '：' + detail : ''}`)
    }
    this.token = json.token
    this.user = json
    this.expiresAt = readJwtExpiry(json.token) * 1000
    return json
  }

  /** 未登录 / 即将过期时自动登录。 */
  async ensureAuth() {
    const fresh = this.token && (!this.expiresAt || this.expiresAt - Date.now() > 120_000)
    if (!fresh) await this.login()
    return this
  }

  #headers(pathname, params, extra = {}) {
    const sign = makeSign(signKeyOf(this.token), this.uuid, 'GET', pathname, params)
    return {
      Authorization: `jwt ${this.token}`,
      uuid: this.uuid,
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${this.baseUrl}/dashboard`,
      'User-Agent': DEFAULT_UA,
      'fl-sec-sign': sign,
      ...extra,
    }
  }

  /** 原始 GET，返回 Response。401 时自动重登一次。 */
  async rawGet(pathname, params = {}, { retryAuth = true } = {}) {
    await this.ensureAuth()
    const qs = new URLSearchParams()
    for (const k of Object.keys(params)) {
      const v = params[k]
      if (v !== null && v !== undefined) qs.set(k, String(v))
    }
    const url = `${this.baseUrl}${pathname}${qs.toString() ? '?' + qs.toString() : ''}`
    let res = await fetch(url, { headers: this.#headers(pathname, params) })
    if (res.status === 401 && retryAuth) {
      this.token = ''
      await this.login()
      res = await fetch(url, { headers: this.#headers(pathname, params) })
    }
    return res
  }

  /** GET JSON：{ status, json, text }。 */
  async get(pathname, params = {}) {
    const res = await this.rawGet(pathname, params)
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 保留 text 供调用方判断 */ }
    return { status: res.status, json, text }
  }

  /** GET 二进制（例如 xlsx 导出）。 */
  async getBinary(pathname, params = {}) {
    const res = await this.rawGet(pathname, params)
    if (res.status !== 200) {
      const text = await res.text()
      throw new Error(`下载失败（HTTP ${res.status}）${pathname}：${text.slice(0, 180)}`)
    }
    return Buffer.from(await res.arrayBuffer())
  }
}

function readJwtExpiry(token) {
  try {
    const payload = String(token).split('.')[1]
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return Number(json.exp) || 0
  } catch {
    return 0
  }
}

export default { FuuleaApi, resolveBaseUrl, makeSign, signKeyOf, readCredentialsFile, DEFAULT_UA }
