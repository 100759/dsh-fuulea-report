// 学校绑定存储：把「学校 + 账号密码 + 登录令牌」保存在本机，供下次打开工作台时直接登录，
// 不再要求用户重复输入账号密码；同时记录最近使用的学校与报告区间，用于切换与默认值。
//
// 存储位置（可用插件配置 bindingsFile 覆盖，或用环境变量 FUULEA_BINDINGS_FILE）：
//   ~/.fuulea-report/bindings.json      （目录 0700，文件 0600）
//
// 只在本机保存，不上传；密码为明文本地保存（与既有「技能包凭据文件」的做法一致），
// 页面上只回显账号与学校名，不回显密码。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_BINDINGS_FILE = path.join(os.homedir(), '.fuulea-report', 'bindings.json')

const STORE_VERSION = 2

/** 空白存储结构。 */
export function emptyStore() {
  return { version: STORE_VERSION, lastSchool: '', lastRange: null, schools: {} }
}

/** 规范化学校别名（只保留子域名首段）。 */
export function aliasOf(input) {
  let text = String(input || '').trim().toLowerCase()
  text = text.replace(/^https?:\/\//, '')
  text = text.replace(/\/+$/, '')
  const dot = text.indexOf('.')
  if (dot > 0) text = text.slice(0, dot)
  return text
}

/** 校验学校别名：字母数字开头，可含连字符。 */
export function isValidAlias(alias) {
  return /^[a-z0-9][a-z0-9-]*$/.test(alias)
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null
  const alias = aliasOf(raw.alias)
  if (!alias || !isValidAlias(alias)) return null
  const record = {
    alias,
    baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : `https://${alias}.fuulea.com`,
    siteTitle: typeof raw.siteTitle === 'string' ? raw.siteTitle : '',
    username: typeof raw.username === 'string' ? raw.username : '',
    password: typeof raw.password === 'string' ? raw.password : '',
    token: typeof raw.token === 'string' ? raw.token : '',
    tokenExpiresAt: Number.isFinite(Number(raw.tokenExpiresAt)) ? Number(raw.tokenExpiresAt) : 0,
    // 登录返回的用户信息（只保留报告需要的字段，用于复用未过期令牌时免登录）。
    user: normalizeUser(raw.user),
    boundAt: typeof raw.boundAt === 'string' ? raw.boundAt : '',
    lastUsedAt: typeof raw.lastUsedAt === 'string' ? raw.lastUsedAt : '',
  }
  return record
}

const USER_FIELDS = [
  'siteId',
  'siteTitle',
  'chargedGradeIds',
  'manageGradeIds',
  'userName',
  'firstName',
  'isSuper',
  'id',
  'userId',
]

function normalizeUser(raw) {
  if (!raw || typeof raw !== 'object') return null
  const user = {}
  for (const key of USER_FIELDS) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    user[key] = value
  }
  return Object.keys(user).length ? user : null
}

/**
 * 本机绑定存储。读写都做容错：文件损坏时读取返回空存储并把坏文件备份为 .broken，
 * 后续写入会重新生成；不会因为凭据文件异常导致插件不可用。
 */
export class BindingStore {
  constructor(file) {
    this.file = file && String(file).trim() ? path.resolve(String(file).trim()) : DEFAULT_BINDINGS_FILE
    this.cached = null
    this.cachedMtime = 0
  }

  /** 读取原始存储（含密码，仅 Host 内部使用）。 */
  read() {
    let stat = null
    try {
      stat = fs.statSync(this.file)
    } catch {
      this.cached = emptyStore()
      this.cachedMtime = 0
      return this.cached
    }
    if (this.cached && stat.mtimeMs === this.cachedMtime) return this.cached
    let store = null
    try {
      const text = fs.readFileSync(this.file, 'utf8')
      store = JSON.parse(text)
    } catch (err) {
      this.backupBroken()
      store = null
    }
    const next = emptyStore()
    if (store && typeof store === 'object') {
      next.lastSchool = aliasOf(store.lastSchool)
      const range = store.lastRange
      if (range && typeof range === 'object') {
        const from = typeof range.from === 'string' ? range.from : ''
        const to = typeof range.to === 'string' ? range.to : ''
        if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to) {
          next.lastRange = { from, to }
        }
      }
      const schools = store.schools && typeof store.schools === 'object' ? store.schools : {}
      for (const key of Object.keys(schools)) {
        const record = normalizeRecord(schools[key])
        if (record) next.schools[record.alias] = record
      }
    }
    if (next.lastSchool && !next.schools[next.lastSchool]) next.lastSchool = ''
    this.cached = next
    this.cachedMtime = stat.mtimeMs
    return next
  }

  /** 原子写回存储（临时文件 + rename），权限 0600。 */
  write(store) {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const body = JSON.stringify(store, null, 2) + '\n'
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
    try {
      fs.chmodSync(tmp, 0o600)
    } catch {
      /* 某些文件系统不支持 chmod */
    }
    fs.renameSync(tmp, this.file)
    try {
      fs.chmodSync(this.file, 0o600)
    } catch {
      /* 忽略 */
    }
    this.cached = store
    try {
      this.cachedMtime = fs.statSync(this.file).mtimeMs
    } catch {
      this.cachedMtime = 0
    }
    return store
  }

  backupBroken() {
    try {
      const backup = `${this.file}.broken-${Date.now()}`
      fs.renameSync(this.file, backup)
    } catch {
      /* 忽略 */
    }
  }

  /** 绑定列表（不含密码），按最近使用时间倒序。 */
  list() {
    const store = this.read()
    return Object.values(store.schools)
      .map((record) => mask(record))
      .sort((a, b) => String(b.lastUsedAt || b.boundAt).localeCompare(String(a.lastUsedAt || a.boundAt)))
  }

  /** 内部使用：含密码的记录。 */
  get(alias) {
    const store = this.read()
    return store.schools[aliasOf(alias)] || null
  }

  /** 保存/更新一条绑定。 */
  save(input) {
    const record = normalizeRecord(input)
    if (!record) throw new Error('绑定信息不完整，无法保存')
    const store = this.read()
    const previous = store.schools[record.alias]
    if (previous) {
      record.boundAt = record.boundAt || previous.boundAt
      record.token = record.token || previous.token
      record.tokenExpiresAt = record.tokenExpiresAt || previous.tokenExpiresAt
      record.siteTitle = record.siteTitle || previous.siteTitle
      record.user = record.user || previous.user
    }
    record.boundAt = record.boundAt || new Date().toISOString()
    record.lastUsedAt = new Date().toISOString()
    store.schools[record.alias] = record
    store.lastSchool = record.alias
    this.write(store)
    return record
  }

  /** 局部更新（刷新令牌 / 最近使用时间 / 站点名）。 */
  patch(alias, patch) {
    const store = this.read()
    const key = aliasOf(alias)
    const current = store.schools[key]
    if (!current) return null
    const next = Object.assign({}, current, patch || {}, { alias: key })
    store.schools[key] = normalizeRecord(next) || current
    this.write(store)
    return store.schools[key]
  }

  /** 解除绑定；若解除的是最近使用的学校，则回退到另一所学校。 */
  remove(alias) {
    const store = this.read()
    const key = aliasOf(alias)
    if (!store.schools[key]) return false
    delete store.schools[key]
    if (store.lastSchool === key) {
      const remaining = Object.keys(store.schools).sort()
      store.lastSchool = remaining[0] || ''
    }
    this.write(store)
    return true
  }

  setLastSchool(alias) {
    const store = this.read()
    const key = aliasOf(alias)
    if (!key || store.lastSchool === key) return
    store.lastSchool = store.schools[key] ? key : ''
    this.write(store)
  }

  setLastRange(from, to) {
    const store = this.read()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return
    if (store.lastRange && store.lastRange.from === from && store.lastRange.to === to) return
    store.lastRange = { from, to }
    this.write(store)
  }

  /** 默认学校：最近使用 > 第一所绑定学校。 */
  defaultSchool() {
    const store = this.read()
    if (store.lastSchool && store.schools[store.lastSchool]) return store.lastSchool
    const keys = Object.keys(store.schools).sort()
    return keys[0] || ''
  }

  lastRange() {
    return this.read().lastRange
  }
}

/** 对外脱敏：不返回密码与令牌。 */
export function mask(record) {
  if (!record) return null
  return {
    alias: record.alias,
    baseUrl: record.baseUrl,
    siteTitle: record.siteTitle,
    username: record.username,
    maskedUsername: maskUsername(record.username),
    boundAt: record.boundAt,
    lastUsedAt: record.lastUsedAt,
    hasPassword: Boolean(record.password),
    tokenValidUntil: record.tokenExpiresAt > Date.now() ? record.tokenExpiresAt : 0,
  }
}

/** 账号脱敏：保留首尾，中间用 * 代替。 */
export function maskUsername(username) {
  const text = String(username || '')
  if (!text) return ''
  if (text.length <= 2) return text[0] + '*'
  if (text.length <= 4) return text[0] + '*'.repeat(text.length - 2) + text[text.length - 1]
  return text.slice(0, 2) + '*'.repeat(Math.min(6, text.length - 3)) + text.slice(-1)
}

export default { BindingStore, DEFAULT_BINDINGS_FILE, emptyStore, aliasOf, isValidAlias, mask, maskUsername }
