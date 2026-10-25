// 辅立码课教学数据报告 —— Client 半边（浏览器模块）。
//
// 在「工作台」左侧面板列表注册「教学数据报告」入口（sidebar.panellist / id=fuulea-report），
// 并在 layout 的 main 键控槽（key=fuulea-report）渲染整页工作台：
//   学校切换（本机已绑定的学校）→ 统计区间 →「获取数据」→ 三届合计、年级切换、
//   学科 / 教师 / 自学三张表 →「生成报告」→ 打开 / 定位 / 复制报告文件 → 历史报告。
//
// 账号只在首次使用时填写一次：Host 取数成功后会把「学校 + 账号密码」保存在本机，
// 之后打开页面直接进入。凭据只在本机保存，页面不回显密码。
//
// 约束：
//   - 只通过 require('react') 取 React，不依赖任何 Harness Client 包；
//   - 所有请求走同源 Host 接口 /fuulea-report/api/*（defaults / bind / unbind / snapshot /
//     report / reports / open / file）；
//   - 样式只用 --dsw-alias-* / --dsw-specific-* 主题 token，浅色/深色主题都可读；
//   - 不 append 到 document.body，不读取其它插件 DOM。

window.__ModuleLoader__.load({
  id: 'dsh-fuulea-report',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef

    const PANEL_ID = 'fuulea-report'
    const API_BASE = '/fuulea-report/api'
    const CSS_ID = 'fuulea-report-styles'
    const TEACHER_TABLE_LIMIT = 15
    const HISTORY_LIMIT = 6
    const DEFAULT_DAYS = 14
    const SCHOOL_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]*$/i
    const INITIAL_WINDOW = defaultWindow(DEFAULT_DAYS)

    const FILE_KIND_LABEL = { markdown: 'MD', html: 'HTML', pdf: 'PDF', docx: 'DOCX' }

    // 三种导出模式：正式版 / 简报版 / 交互版（与 Host 的 mode / variant 一一对应）。
    const REPORT_MODES = [
      {
        mode: 'full',
        variant: 'full',
        title: '正式版',
        button: '生成正式版',
        busyButton: '生成正式版…',
        busyText: '正在生成正式版报告（Markdown / HTML / Word / PDF）…',
        formats: ['markdown', 'html', 'pdf', 'docx'],
        hint: '完整公文版式：Markdown、可打印 HTML、Word（.docx）、PDF',
      },
      {
        mode: 'brief',
        variant: 'brief',
        title: '简报版',
        button: '生成简报',
        busyButton: '生成简报…',
        busyText: '正在生成简报版（Word / PDF）…',
        formats: ['docx', 'pdf'],
        hint: '1~2 页速览：总体 → 学科 → 教师 → 提升与建议（Word、PDF）',
      },
      {
        mode: 'interactive',
        variant: 'interactive',
        title: '交互版',
        button: '生成交互版',
        busyButton: '生成交互版…',
        busyText: '正在生成交互版报告（单文件 HTML）…',
        formats: ['html'],
        hint: '单文件 HTML：图表可交互、可双击打开，无需外部资源',
      },
    ]
    const VARIANT_TITLE = { full: '正式版', brief: '简报版', interactive: '交互版' }
    const VARIANT_ORDER = { full: 0, brief: 1, interactive: 2 }
    const BUSY_MODE_PREFIX = 'report:'

    function modeConfig(mode) {
      return REPORT_MODES.find(function (item) {
        return item.mode === mode
      }) || REPORT_MODES[0]
    }

    /** 文件所属版本：优先用 Host 返回的 variant，缺省时按文件名识别（老版本 Host 兼容）。 */
    function variantOfFile(file) {
      if (!file) return 'full'
      if (file.variant === 'full' || file.variant === 'brief' || file.variant === 'interactive') return file.variant
      const name = String(file.name || file.path || '')
      if (name.indexOf('使用简报') >= 0) return 'brief'
      if (name.indexOf('交互数据报告') >= 0) return 'interactive'
      return 'full'
    }

    function groupReportFiles(files) {
      const groups = []
      for (const item of REPORT_MODES) groups.push({ variant: item.variant, title: item.title, files: [] })
      const list = sortReportFiles(files)
      for (const file of list) {
        const variant = variantOfFile(file)
        const group = groups.find(function (item) {
          return item.variant === variant
        })
        if (group) group.files.push(file)
      }
      return groups.filter(function (group) {
        return group.files.length > 0
      })
    }

    /** 打开按钮文案：「打开 PDF」；简报/交互版带版本名，交互版用「浏览器打开」。 */
    function fileOpenLabel(file) {
      const variant = variantOfFile(file)
      const kind = FILE_KIND_LABEL[file && file.kind] || '文件'
      if (variant === 'interactive') return '浏览器打开'
      if (variant === 'brief') return '打开 简报' + kind
      return '打开 ' + kind
    }

    // ---------------------------------------------------------------- 格式化工具

    function isNil(value) {
      return value === null || value === undefined
    }

    function toFiniteNumber(value) {
      if (isNil(value)) return null
      const n = Number(value)
      return Number.isFinite(n) ? n : null
    }

    function fmtInt(value) {
      const n = toFiniteNumber(value)
      if (n === null) return '—'
      return Math.round(n).toLocaleString('zh-CN')
    }

    function fmtFixed(value, digits) {
      const n = toFiniteNumber(value)
      if (n === null) return '—'
      return n.toFixed(typeof digits === 'number' ? digits : 1)
    }

    function fmtPercent(value) {
      const n = toFiniteNumber(value)
      if (n === null) return '—'
      return n.toFixed(1) + '%'
    }

    function fmtSize(bytes) {
      const n = toFiniteNumber(bytes)
      if (n === null || n < 0) return ''
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(2) + ' MB'
    }

    function fmtDateTime(iso) {
      if (!iso) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return String(iso)
      try {
        return date.toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      } catch (err) {
        return date.toISOString().replace('T', ' ').slice(0, 16)
      }
    }

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    function isoDate(date) {
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    }

    /** 默认统计窗口：截止昨天，共 days 天（与 Host 的 defaultWindow 保持一致）。 */
    function defaultWindow(days) {
      const span = Math.max(1, Number(days) || DEFAULT_DAYS)
      const to = new Date()
      to.setDate(to.getDate() - 1)
      const from = new Date(to)
      from.setDate(from.getDate() - (span - 1))
      return { from: isoDate(from), to: isoDate(to) }
    }

    /** 统计区间快捷选择：最近 N 天（截止昨天）。 */
    function windowOfDays(days) {
      return defaultWindow(days)
    }

    function isIsoDate(value) {
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    }

    /** 允许粘贴完整站点地址：取首段子域名。 */
    function normalizeSchoolAlias(raw) {
      let text = String(raw || '').trim()
      text = text.replace(/^https?:\/\//i, '')
      text = text.replace(/\/+$/, '')
      const dot = text.indexOf('.')
      if (dot > 0) text = text.slice(0, dot)
      return text
    }

    function messageOf(err) {
      if (!err) return '未知错误'
      if (typeof err === 'string') return err
      if (typeof err.message === 'string' && err.message) return err.message
      return String(err)
    }

    function isAbortError(err) {
      return !!err && (err.name === 'AbortError' || err.code === 20)
    }

    function makeAbortController() {
      if (typeof AbortController === 'function') {
        return new AbortController()
      }
      return null
    }

    function signalOf(controller) {
      return controller ? controller.signal : undefined
    }

    function abortController(controller) {
      if (!controller) return
      try {
        controller.abort()
      } catch (err) {
        /* 已经结束 */
      }
    }

    function isMissingSubject(subject) {
      if (!subject) return true
      return subject.missing === true || isNil(subject.taskCount)
    }

    function subjectsOf(grade) {
      return grade && Array.isArray(grade.subjects) ? grade.subjects : []
    }

    function teachersOf(grade) {
      return grade && Array.isArray(grade.teachers) ? grade.teachers : []
    }

    function schoolLabel(binding) {
      if (!binding) return ''
      const title = binding.siteTitle || binding.alias
      return title + '（' + binding.alias + '）'
    }

    function sortReportFiles(files) {
      const order = { pdf: 0, docx: 1, html: 2, markdown: 3 }
      return (Array.isArray(files) ? files.slice() : []).sort(function (a, b) {
        const left = order[a && a.kind] === undefined ? 9 : order[a.kind]
        const right = order[b && b.kind] === undefined ? 9 : order[b.kind]
        return left - right
      })
    }

    function primaryReportFile(files) {
      const sorted = sortReportFiles(files)
      return sorted.length ? sorted[0] : null
    }

    // ---------------------------------------------------------------- 剪贴板

    function copyToClipboard(text) {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text)
      }
      return new Promise(function (resolve, reject) {
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.setAttribute('readonly', '')
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand && document.execCommand('copy')
          document.body.removeChild(area)
          ok ? resolve() : reject(new Error('浏览器不支持自动复制'))
        } catch (err) {
          reject(err)
        }
      })
    }

    // ---------------------------------------------------------------- 网络

    async function requestJson(path, init, controller) {
      let response
      try {
        response = await fetch(
          API_BASE + path,
          Object.assign({ cache: 'no-store' }, init || {}, { signal: signalOf(controller) }),
        )
      } catch (err) {
        if (isAbortError(err)) throw err
        throw new Error('网络请求失败，未连接到本机报告服务：' + messageOf(err))
      }
      let payload = null
      try {
        payload = await response.json()
      } catch (err) {
        throw new Error('接口返回了无法解析的内容（HTTP ' + response.status + '）')
      }
      if (!response.ok || (payload && payload.ok === false)) {
        const detail =
          payload && typeof payload.error === 'string' && payload.error
            ? payload.error
            : '请求失败（HTTP ' + response.status + '）'
        throw new Error(detail)
      }
      return payload || {}
    }

    function postJson(path, body, controller) {
      return requestJson(
        path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        },
        controller,
      )
    }

    // ---------------------------------------------------------------- 样式

    const FLR_CSS =
      '.flr-page{display:flex;flex-direction:column;width:100%;min-width:0;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6;box-sizing:border-box}' +
      '.flr-page *,.flr-page *::before,.flr-page *::after{box-sizing:border-box}' +
      '.flr-page :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}' +
      '.flr-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}' +
      '.flr-content{max-width:1280px;margin:0 auto;padding:0 clamp(20px,3vw,44px) 64px}' +
      '.flr-header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px 24px;padding-top:28px;margin-bottom:16px}' +
      '[data-platform="darwin"] .flr-header{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}' +
      '.flr-heading{min-width:0}' +
      '.flr-title{margin:0;font-size:20px;font-weight:600;line-height:28px;letter-spacing:.01em}' +
      '.flr-subtitle{margin:2px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}' +
      '.flr-header-side{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px 10px;min-width:0;max-width:560px}' +
      '.flr-source{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);text-align:right}' +
      // 版本徽标 / 更新红点
      '.flr-version{position:relative;display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap;transition:border-color .15s,color .15s}' +
      '.flr-version:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}' +
      '.flr-version[aria-expanded="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}' +
      '.flr-version--new{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}' +
      '.flr-version-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#e5484d);box-shadow:0 0 0 0 rgba(229,72,77,.55);animation:flr-pulse 1.8s ease-out infinite}' +
      '@keyframes flr-pulse{0%{box-shadow:0 0 0 0 rgba(229,72,77,.5)}70%{box-shadow:0 0 0 6px rgba(229,72,77,0)}100%{box-shadow:0 0 0 0 rgba(229,72,77,0)}}' +
      '.flr-update{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:12px 16px;margin:0 0 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:20px}' +
      '.flr-update--new{border-color:var(--dsw-alias-state-error-primary)}' +
      '.flr-update-main{flex:1 1 320px;min-width:0}' +
      '.flr-update-title{margin:0;display:flex;align-items:center;gap:7px;font-weight:600;color:var(--dsw-alias-label-primary)}' +
      '.flr-update-meta{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}' +
      '.flr-update-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}' +
      '.flr-update code{font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;word-break:break-all}' +
      '.flr-chip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}' +
      '.flr-chip--ok{border-color:var(--dsw-alias-state-success-primary,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}' +
      '.flr-chip--warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}' +
      '.flr-chip--ok::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22a06b);flex:none}' +
      '.flr-chip--warn::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#e8833a);flex:none}' +
      '.flr-toolbar{padding:16px 18px;margin-bottom:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1)}' +
      '.flr-toolbar-row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 14px}' +
      '.flr-toolbar-row+.flr-toolbar-row{margin-top:12px}' +
      '.flr-toolbar-row--actions{padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}' +
      '.flr-field{display:flex;flex-direction:column;gap:5px;min-width:0}' +
      '.flr-field--grow{flex:1 1 220px}' +
      '.flr-field-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}' +
      '.flr-input{height:34px;min-width:0;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;transition:border-color .15s}' +
      '.flr-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.72}' +
      '.flr-input:focus{border-color:var(--dsw-alias-brand-primary)}' +
      '.flr-input:disabled{opacity:.6;cursor:not-allowed}' +
      '.flr-input--date{width:150px}' +
      '.flr-input--cred{width:170px}' +
      '.flr-select{height:34px;min-width:0;max-width:340px;padding:0 30px 0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-secondary) 50%),linear-gradient(135deg,var(--dsw-alias-label-secondary) 50%,transparent 50%);background-position:calc(100% - 16px) 15px,calc(100% - 11px) 15px;background-size:5px 5px,5px 5px;background-repeat:no-repeat;cursor:pointer;transition:border-color .15s}' +
      '.flr-select:focus{border-color:var(--dsw-alias-brand-primary)}' +
      '.flr-select:disabled{opacity:.6;cursor:not-allowed}' +
      '.flr-domain{display:inline-flex;align-items:center;height:34px;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);overflow:hidden;transition:border-color .15s}' +
      '.flr-domain:focus-within{border-color:var(--dsw-alias-brand-primary)}' +
      '.flr-domain-text{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:32px;white-space:nowrap}' +
      '.flr-domain-text--prefix{padding-left:10px}' +
      '.flr-domain-text--suffix{padding-right:10px}' +
      '.flr-domain-input{width:110px;min-width:0;height:32px;padding:0 2px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}' +
      '.flr-domain-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.72}' +
      '.flr-spacer{flex:1 1 auto}' +
      '.flr-check{display:inline-flex;align-items:center;gap:6px;height:34px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;user-select:none}' +
      '.flr-check input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}' +
      '.flr-check input:disabled{cursor:not-allowed}' +
      '.flr-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-left:auto}' +
      '.flr-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 16px;border:1px solid transparent;border-radius:9px;font:inherit;font-size:13px;line-height:1;white-space:nowrap;cursor:pointer;text-decoration:none;transition:opacity .15s,background-color .15s,border-color .15s;color:var(--dsw-alias-label-primary)}' +
      '.flr-btn:disabled{opacity:.55;cursor:not-allowed}' +
      '.flr-btn--primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted,#fff)}' +
      '.flr-btn--primary:not(:disabled):hover{opacity:.9}' +
      '.flr-btn--ghost{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}' +
      '.flr-btn--ghost:not(:disabled):hover{background:var(--dsw-alias-bg-layer-2)}' +
      '.flr-btn--small{height:28px;padding:0 12px;font-size:12px}' +
      '.flr-btn--tiny{height:24px;padding:0 9px;font-size:12px;border-radius:7px}' +
      '.flr-btn--danger{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-state-error-primary)}' +
      '.flr-btn--danger:not(:disabled):hover{background:var(--dsw-alias-bg-layer-2)}' +
      '.flr-generate{display:inline-flex;flex-wrap:wrap;align-items:center;gap:8px}' +
      '.flr-btn--gen{height:34px}' +
      '.flr-linkbtn{padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}' +
      '.flr-linkbtn:hover{text-decoration:underline}' +
      '.flr-linkbtn:disabled{opacity:.55;cursor:not-allowed;text-decoration:none}' +
      '.flr-presets{display:inline-flex;flex-wrap:wrap;gap:6px}' +
      '.flr-preset{height:34px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:32px;cursor:pointer;transition:background-color .15s,color .15s}' +
      '.flr-preset:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}' +
      '.flr-preset[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}' +
      '.flr-preset:disabled{opacity:.55;cursor:not-allowed}' +
      '.flr-hints{display:flex;flex-direction:column;gap:3px;margin:12px 0 0;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}' +
      '.flr-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.flr-hint code{font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;word-break:break-all;color:var(--dsw-alias-label-primary)}' +
      '.flr-inline-status{display:flex;align-items:center;gap:8px;margin:0 0 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.flr-spinner{flex:none;width:13px;height:13px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:flr-spin .8s linear infinite}' +
      '@keyframes flr-spin{to{transform:rotate(360deg)}}' +
      '.flr-alert{display:flex;align-items:flex-start;gap:9px;padding:10px 14px;margin:0 0 16px;border:1px solid var(--dsw-alias-border-l1);border-left-width:3px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:20px}' +
      '.flr-alert--error{border-color:var(--dsw-alias-state-error-primary);border-left-width:3px}' +
      '.flr-alert--warn{border-color:var(--dsw-alias-state-warn-primary);border-left-width:3px}' +
      '.flr-alert-icon{flex:none;margin-top:1px;font-size:13px;font-weight:700;line-height:18px}' +
      '.flr-alert--error .flr-alert-icon{color:var(--dsw-alias-state-error-primary)}' +
      '.flr-alert--warn .flr-alert-icon{color:var(--dsw-alias-state-warn-primary)}' +
      '.flr-alert-body{flex:1;min-width:0}' +
      '.flr-alert-title{margin:0;font-weight:500;color:var(--dsw-alias-label-primary)}' +
      '.flr-alert-message{margin:0;overflow-wrap:anywhere}' +
      '.flr-alert-list{margin:3px 0 0;padding-left:18px}' +
      '.flr-alert-list li{overflow-wrap:anywhere}' +
      '.flr-infobar{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 22px;padding:10px 16px;margin-bottom:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-specific-sidebar-fill)}' +
      '.flr-info{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:12px;line-height:18px}' +
      '.flr-info-label{flex:none;color:var(--dsw-alias-label-secondary)}' +
      '.flr-info-value{min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}' +
      '.flr-section{margin-bottom:22px}' +
      '.flr-section-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 16px;margin-bottom:10px}' +
      '.flr-section-title{margin:0;font-size:15px;font-weight:600;line-height:22px}' +
      '.flr-section-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.flr-section-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}' +
      '.flr-cards{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}' +
      '.flr-card{display:flex;flex-direction:column;gap:3px;min-width:0;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}' +
      '.flr-card--totals{background:var(--dsw-alias-bg-layer-2)}' +
      '.flr-card-label{overflow:hidden;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;text-overflow:ellipsis}' +
      '.flr-card-value{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-size:20px;font-weight:600;line-height:28px;font-variant-numeric:tabular-nums}' +
      '.flr-card-unit{margin-left:2px;font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary)}' +
      '.flr-card-hint{overflow:hidden;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap;text-overflow:ellipsis}' +
      '.flr-tabs{display:inline-flex;flex-wrap:wrap;gap:6px;padding:4px;margin:0 0 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}' +
      '.flr-tab{display:flex;flex-direction:column;align-items:flex-start;gap:0;padding:6px 14px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:18px;cursor:pointer;transition:background-color .15s,color .15s}' +
      '.flr-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}' +
      '.flr-tab[aria-selected="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 1px var(--dsw-alias-border-l1)}' +
      '.flr-tab-name{font-size:13px;font-weight:600;line-height:18px}' +
      '.flr-tab-level{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}' +
      '.flr-table-wrap{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}' +
      '.flr-table-scroll{overflow-x:auto;scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}' +
      '.flr-table{width:100%;border-collapse:collapse;font-size:13px;line-height:20px}' +
      '.flr-table th{padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-weight:500;white-space:nowrap}' +
      '.flr-table td{padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);white-space:nowrap;font-variant-numeric:tabular-nums}' +
      '.flr-table tbody tr:last-child td{border-bottom:0}' +
      '.flr-table tbody tr:hover td{background:var(--dsw-alias-bg-layer-2)}' +
      '.flr-table .flr-num{text-align:right}' +
      '.flr-table .flr-text{text-align:left}' +
      '.flr-table tr.is-muted td{color:var(--dsw-alias-label-secondary)}' +
      '.flr-table-empty{padding:26px 12px;text-align:center;color:var(--dsw-alias-label-secondary);white-space:normal}' +
      '.flr-table-foot{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.flr-subject-cell{display:inline-flex;align-items:center;gap:6px;min-width:0}' +
      '.flr-tag-missing{display:inline-block;padding:0 6px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:999px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary)}' +
      '.flr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:56px 24px;border:1px dashed var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);text-align:center}' +
      '.flr-empty-title{margin:0;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}' +
      '.flr-empty-text{margin:0;max-width:560px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}' +
      '.flr-loading{display:flex;align-items:center;gap:10px;padding:22px 24px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}' +
      '.flr-report{padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}' +
      '.flr-report-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 16px;margin-bottom:12px}' +
      '.flr-report-title{margin:0;font-size:15px;font-weight:600;line-height:22px}' +
      '.flr-report-stats{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.flr-report-modes{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.flr-report-mode-tag{color:var(--dsw-alias-label-primary)}' +
      '.flr-report-groups{display:flex;flex-direction:column;gap:14px}' +
      '.flr-report-group{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}' +
      '.flr-report-group[data-variant="brief"]{border-left:3px solid var(--dsw-alias-brand-primary)}' +
      '.flr-report-group[data-variant="interactive"]{border-left:3px solid var(--dsw-alias-state-success-primary,#22a06b)}' +
      '.flr-report-group-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}' +
      '.flr-report-group-title{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}' +
      '.flr-report-group-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.flr-files{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}' +
      '.flr-file{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;min-width:0;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}' +
      '.flr-file-badge{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:50px;height:22px;padding:0 8px;border-radius:6px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted,#fff);font-size:11px;font-weight:600;letter-spacing:.02em}' +
      '.flr-file-main{display:flex;flex:1 1 200px;flex-direction:column;min-width:0}' +
      '.flr-file-name{overflow:hidden;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis}' +
      '.flr-file-meta{overflow:hidden;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;text-overflow:ellipsis}' +
      '.flr-file-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:none}' +
      '.flr-file-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}' +
      '.flr-file-status.is-busy{color:var(--dsw-alias-brand-primary)}' +
      '.flr-file-status.is-done{color:var(--dsw-alias-state-success-primary,#22a06b)}' +
      '.flr-file-status.is-error{color:var(--dsw-alias-state-error-primary)}' +
      '.flr-dir{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:12px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.flr-dir code{font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--dsw-alias-label-primary);word-break:break-all}' +
      '.flr-report-hint{margin:8px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.flr-report-warn{margin:12px 0 0}' +
      '.flr-report-warn .flr-alert{margin:0}' +
      '.flr-history{display:flex;flex-direction:column;gap:8px}' +
      '.flr-history-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}' +
      '.flr-history-main{display:flex;flex:1 1 260px;flex-direction:column;min-width:0}' +
      '.flr-history-title{overflow:hidden;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis}' +
      '.flr-history-meta{overflow:hidden;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;text-overflow:ellipsis}' +
      '.flr-history-files{display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:none}' +
      '.flr-history-more{margin-top:2px;align-self:flex-start}' +
      '@media (max-width:1100px){.flr-cards{grid-template-columns:repeat(3,minmax(0,1fr))}}' +
      '@media (max-width:760px){.flr-actions{width:100%;margin-left:0}.flr-btn{flex:1}.flr-source{text-align:left}.flr-history-files{width:100%}.flr-generate{width:100%}.flr-report-group{padding:8px 10px}}' +
      '@media (max-width:620px){.flr-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.flr-input--date,.flr-input--cred{width:100%}.flr-field{flex:1 1 100%}.flr-select{max-width:none;width:100%}}'

    // ---------------------------------------------------------------- 基础组件

    /** 左侧面板图标：直接作为行内图标子节点渲染（size 由侧栏给出 16/18）。 */
    function PanelIcon(props) {
      const size = (props && props.size) || 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', {
          key: 'frame',
          x: 2.75,
          y: 3.25,
          width: 14.5,
          height: 13.5,
          rx: 3.25,
          stroke: 'currentColor',
          strokeWidth: 1.3,
        }),
        h('path', {
          key: 'bars',
          d: 'M6.6 13.2v-2.9M10 13.2V7.4M13.4 13.2v-1.8',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
      )
    }

    function StyleSheet() {
      return h('style', { 'data-flr-style': CSS_ID }, FLR_CSS)
    }

    // ---------------------------------------------------------------- 版本与更新

    /**
     * 版本徽标：显示当前版本；GitHub 上有新版本时带一个红点（并轻微脉冲），
     * 点击展开/收起版本面板。红点state来自 Host 的 GET /update-check。
     */
    function VersionBadge(props) {
      const info = props.info
      const version = (info && info.current) || props.fallbackVersion || ''
      const hasNew = Boolean(info && info.updateAvailable)
      return h(
        'button',
        {
          type: 'button',
          className: 'flr-version' + (hasNew ? ' flr-version--new' : ''),
          'aria-expanded': props.open ? 'true' : 'false',
          title: hasNew
            ? '有新版本 ' + info.latest + '，点击查看更新'
            : '当前版本 ' + (version || '未知') + '，点击查看版本信息',
          onClick: props.onToggle,
        },
        hasNew ? h('span', { className: 'flr-version-dot', 'aria-hidden': 'true' }) : null,
        h('span', null, 'v' + (version || '—')),
        hasNew ? h('span', null, '· 可更新') : null,
      )
    }

    /**
     * 版本面板：有新版本时显示「立即更新」；更新成功后提示重启 Harness。
     * Host 侧只在按 GitHub 源安装时才允许一键更新（本地 link 安装会给出说明）。
     */
    function UpdatePanel(props) {
      const info = props.info
      const status = props.status
      if (!info) return null
      const hasNew = Boolean(info.updateAvailable)
      const checkError = info.error || ''
      const sourceText = {
        github: 'GitHub 安装',
        link: '本地目录安装',
        git: 'Git 安装',
        registry: 'npm 安装',
        unknown: '安装方式未知',
      }[info.source] || '安装方式未知'
      const canUpdate = hasNew && info.source === 'github' && !status.busy
      const restartPending = Boolean(info.restartPending)
      const metaParts = []
      metaParts.push('当前 ' + ((info.current || '—') + ''))
      if (info.latest) metaParts.push('最新 ' + info.latest)
      metaParts.push(sourceText)
      if (info.checkedAt) metaParts.push('检查于 ' + fmtDateTime(new Date(info.checkedAt).toISOString()))

      return h(
        'div',
        { className: 'flr-update' + (hasNew ? ' flr-update--new' : '') },
        h(
          'div',
          { className: 'flr-update-main' },
          h(
            'p',
            { className: 'flr-update-title' },
            hasNew ? h('span', { className: 'flr-version-dot', 'aria-hidden': 'true' }) : null,
            restartPending
              ? '已更新到 v' + (info.current || '') + '，重启 Harness 后生效'
              : hasNew
                ? '有新版本可用：v' + info.latest
                : '已是最新版本',
          ),
          h('p', { className: 'flr-update-meta' }, metaParts.join(' · ')),
          restartPending
            ? h(
                'p',
                { className: 'flr-update-meta' },
                '新版本已装好，正在运行的仍是 v' + (info.running || '旧版本') + '；重启 DeepSeek Harness 即切换。',
              )
            : null,
          checkError ? h('p', { className: 'flr-update-meta' }, '检查更新失败：' + checkError) : null,
          status.message ? h('p', { className: 'flr-update-meta' }, status.message) : null,
        ),
        h(
          'div',
          { className: 'flr-update-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'flr-btn flr-btn--ghost flr-btn--tiny',
              disabled: status.busy,
              onClick: props.onCheck,
            },
            status.checking ? '检查中…' : '检查更新',
          ),
          hasNew
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'flr-btn flr-btn--primary flr-btn--tiny',
                  disabled: !canUpdate,
                  title:
                    info.source === 'github'
                      ? '从 GitHub 重新安装最新版'
                      : '当前不是 GitHub 安装，无法一键更新：请重新执行 dsh plugin add github:' + (info.repo || ''),
                  onClick: props.onUpdate,
                },
                status.busy ? '更新中…' : '立即更新',
              )
            : null,
          info.repoUrl
            ? h(
                'a',
                {
                  className: 'flr-btn flr-btn--ghost flr-btn--tiny',
                  href: info.repoUrl + '#readme',
                  target: '_blank',
                  rel: 'noreferrer noopener',
                },
                '查看更新说明',
              )
            : null,
        ),
      )
    }

    function MetricCard(props) {
      const classes = 'flr-card' + (props.tone === 'totals' ? ' flr-card--totals' : '')
      return h(
        'div',
        { className: classes },
        h('div', { className: 'flr-card-label', title: props.label }, props.label),
        h(
          'div',
          { className: 'flr-card-value' },
          props.value,
          props.unit ? h('span', { className: 'flr-card-unit' }, props.unit) : null,
        ),
        props.hint ? h('div', { className: 'flr-card-hint', title: props.hint }, props.hint) : null,
      )
    }

    function Section(props) {
      return h(
        'section',
        { className: 'flr-section', 'aria-label': props.title },
        h(
          'div',
          { className: 'flr-section-head' },
          h('h2', { className: 'flr-section-title' }, props.title),
          props.actions
            ? h('div', { className: 'flr-section-actions' }, props.actions)
            : props.note
              ? h('p', { className: 'flr-section-note' }, props.note)
              : null,
        ),
        props.children,
      )
    }

    function DataTable(props) {
      const columns = props.columns || []
      const rows = props.rows || []
      const body =
        rows.length === 0
          ? h(
              'tr',
              null,
              h('td', { className: 'flr-table-empty', colSpan: columns.length || 1 }, props.emptyText || '暂无数据'),
            )
          : rows.map((row) =>
              h(
                'tr',
                { key: row.key, className: row.muted ? 'is-muted' : undefined },
                row.cells.map((cell, index) =>
                  h(
                    'td',
                    {
                      key: index,
                      className: columns[index] && columns[index].align === 'right' ? 'flr-num' : 'flr-text',
                    },
                    cell,
                  ),
                ),
              ),
            )
      return h(
        'div',
        { className: 'flr-table-wrap' },
        h(
          'div',
          { className: 'flr-table-scroll' },
          h(
            'table',
            { className: 'flr-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                columns.map((column, index) =>
                  h(
                    'th',
                    {
                      key: index,
                      scope: 'col',
                      className: column.align === 'right' ? 'flr-num' : 'flr-text',
                    },
                    column.label,
                  ),
                ),
              ),
            ),
            h('tbody', null, body),
          ),
        ),
        props.footer ? h('div', { className: 'flr-table-foot' }, props.footer) : null,
      )
    }

    function Alert(props) {
      const warn = props.tone === 'warn'
      return h(
        'div',
        { className: 'flr-alert ' + (warn ? 'flr-alert--warn' : 'flr-alert--error'), role: warn ? 'status' : 'alert' },
        h('span', { className: 'flr-alert-icon', 'aria-hidden': 'true' }, warn ? '!' : '⚠'),
        h(
          'div',
          { className: 'flr-alert-body' },
          props.title ? h('p', { className: 'flr-alert-title' }, props.title) : null,
          props.items && props.items.length
            ? h(
                'ul',
                { className: 'flr-alert-list' },
                props.items.map((item, index) => h('li', { key: index }, item)),
              )
            : props.message
              ? h('p', { className: 'flr-alert-message' }, props.message)
              : null,
        ),
      )
    }

    function InfoBar(props) {
      const items = props.items || []
      return h(
        'div',
        { className: 'flr-infobar' },
        items.map((item, index) =>
          h(
            'span',
            { className: 'flr-info', key: index },
            h('span', { className: 'flr-info-label' }, item.label + '：'),
            h('span', { className: 'flr-info-value', title: item.title || undefined }, item.value),
          ),
        ),
      )
    }

    function EmptyState(props) {
      const bound = props.bound
      return h(
        'div',
        { className: 'flr-empty' },
        h('p', { className: 'flr-empty-title' }, bound ? '还没有数据' : '先绑定学校，之后打开即可直接使用'),
        h(
          'p',
          { className: 'flr-empty-text' },
          bound
            ? '选择统计区间后点击「获取数据」，即可查看管理看板中的教学数据；也可以直接生成报告。'
            : '选择已绑定的学校，或填写学校子域名与一次账号密码。取数成功后账号会保存在本机，下次打开工作台无需再输入。',
        ),
        h('p', { className: 'flr-empty-text' }, '打开页面不会自动联网取数，需要点击「获取数据」才拉取。'),
        h('p', { className: 'flr-empty-text' }, '数据只读拉取，不会修改学校站点上的任何内容。'),
      )
    }

    function LoadingState(props) {
      return h(
        'div',
        { className: 'flr-loading', role: 'status' },
        h('span', { className: 'flr-spinner', 'aria-hidden': 'true' }),
        h('span', null, props.text),
      )
    }

    // ---------------------------------------------------------------- 数据展示

    const SUBJECT_COLUMNS = [
      { label: '学科', align: 'left' },
      { label: '任务', align: 'right' },
      { label: '习题', align: 'right' },
      { label: '生均题量', align: 'right' },
      { label: '完成率', align: 'right' },
      { label: '师阅率', align: 'right' },
      { label: '留痕率', align: 'right' },
      { label: '重练覆盖率', align: 'right' },
      { label: '靶向题', align: 'right' },
    ]

    const TEACHER_COLUMNS = [
      { label: '姓名', align: 'left' },
      { label: '学科', align: 'left' },
      { label: '任务', align: 'right' },
      { label: '习题', align: 'right' },
      { label: '完成率', align: 'right' },
      { label: '师阅率', align: 'right' },
      { label: '师阅题目', align: 'right' },
    ]

    const SELF_COLUMNS = [
      { label: '学科', align: 'left' },
      { label: '自学人次', align: 'right' },
      { label: '自学题量', align: 'right' },
      { label: '观看人次', align: 'right' },
      { label: '观看时长', align: 'right' },
    ]

    function subjectTableRows(grade) {
      return subjectsOf(grade).map((subject) => {
        const missing = isMissingSubject(subject)
        const pick = (value) => (missing ? '—' : value)
        return {
          key: String(subject.name || subject.short || ''),
          muted: missing,
          cells: [
            h(
              'span',
              { className: 'flr-subject-cell' },
              h('span', { title: subject.name || undefined }, subject.short || subject.name || '—'),
              missing ? h('span', { className: 'flr-tag-missing' }, '缺失') : null,
            ),
            pick(fmtInt(subject.taskCount)),
            pick(fmtInt(subject.questionCount)),
            pick(fmtFixed(subject.avgQuestionsByStudent, 1)),
            pick(fmtPercent(subject.finishPercent)),
            pick(fmtPercent(subject.teacherMarkPercent)),
            pick(fmtPercent(subject.tracePercent)),
            pick(fmtPercent(subject.booklet ? subject.booklet.coverPercent : null)),
            pick(fmtInt(subject.target ? subject.target.questionCount : null)),
          ],
        }
      })
    }

    function sortedTeacherRows(grade) {
      const teachers = teachersOf(grade).slice()
      teachers.sort((left, right) => {
        const leftValue = toFiniteNumber(left && left.teacherMarkQuestionCount)
        const rightValue = toFiniteNumber(right && right.teacherMarkQuestionCount)
        const a = leftValue === null ? -1 : leftValue
        const b = rightValue === null ? -1 : rightValue
        if (a !== b) return b - a
        return String((left && left.name) || '').localeCompare(String((right && right.name) || ''), 'zh-CN')
      })
      return teachers
    }

    function teacherTableRows(teachers, limit) {
      return teachers.slice(0, limit).map((teacher, index) => ({
        key: String(teacher.name || '') + '#' + index,
        cells: [
          teacher.name || '—',
          teacher.subject || teacher.short || '—',
          fmtInt(teacher.taskCount),
          fmtInt(teacher.questionCount),
          fmtPercent(teacher.finishPercent),
          fmtPercent(teacher.teacherMarkPercent),
          fmtInt(teacher.teacherMarkQuestionCount),
        ],
      }))
    }

    function selfStudyRows(grade) {
      return subjectsOf(grade).map((subject) => {
        const missing = isMissingSubject(subject)
        const pick = (value) => (missing ? '—' : value)
        const self = subject.self || null
        const watch = subject.watch || null
        return {
          key: String(subject.name || subject.short || ''),
          muted: missing,
          cells: [
            h('span', { title: subject.name || undefined }, subject.short || subject.name || '—'),
            pick(fmtInt(self ? self.personCount : null)),
            pick(fmtInt(self ? self.questionCount : null)),
            pick(fmtInt(watch ? watch.count : null)),
            pick(watch && watch.durationText ? watch.durationText : '—'),
          ],
        }
      })
    }

    function GradeSection(props) {
      const grade = props.grade
      const summary = (grade && grade.summary) || {}
      const subjects = subjectsOf(grade)
      const teachers = teachersOf(grade)
      const missingNames = subjects
        .filter((subject) => isMissingSubject(subject))
        .map((subject) => subject.short || subject.name || '未知学科')
      const sortedTeachers = sortedTeacherRows(grade)
      const teacherRows = teacherTableRows(sortedTeachers, TEACHER_TABLE_LIMIT)
      const selfStudy = (grade && grade.selfStudy) || {}
      const watch = (grade && grade.watch) || {}
      const gradeNoteParts = []
      if (grade && grade.levelName) gradeNoteParts.push(grade.levelName)
      if (grade && toFiniteNumber(grade.classCount) !== null) gradeNoteParts.push(fmtInt(grade.classCount) + ' 个行政班')
      if (toFiniteNumber(summary.days) !== null) gradeNoteParts.push('统计 ' + fmtInt(summary.days) + ' 天')

      const subjectNoteParts = []
      if (missingNames.length) subjectNoteParts.push('缺失学科：' + missingNames.join('、') + '（本周期无任务数据，以「—」展示）')
      subjectNoteParts.push('师阅率与留痕率为空时表示本周期无对应数据')

      const selfNoteParts = []
      if (toFiniteNumber(selfStudy.totalPersonCount) !== null) {
        selfNoteParts.push('自学合计 ' + fmtInt(selfStudy.totalPersonCount) + ' 人次 / ' + fmtInt(selfStudy.totalQuestionCount) + ' 题')
      }
      if (selfStudy.top && selfStudy.top.name) {
        selfNoteParts.push(
          '最活跃：' + selfStudy.top.name + '（' + fmtInt(selfStudy.top.personCount) + ' 人次，占 ' + fmtPercent(selfStudy.top.sharePercent) + '）',
        )
      }
      if (toFiniteNumber(watch.count) !== null) {
        selfNoteParts.push('观看合计 ' + fmtInt(watch.count) + ' 人次 / ' + (watch.durationText || '—'))
      }

      return h(
        'div',
        null,
        h(
          Section,
          { title: (grade && grade.gradeName ? grade.gradeName : '年级') + '概览', note: gradeNoteParts.join(' · ') },
          h(
            'div',
            { className: 'flr-cards' },
            h(MetricCard, { label: '任务数', value: fmtInt(summary.taskCount) }),
            h(MetricCard, { label: '习题数', value: fmtInt(summary.questionCount) }),
            h(MetricCard, { label: '完成率', value: fmtPercent(summary.finishPercent), hint: '按任务量加权' }),
            h(MetricCard, { label: '得分率', value: fmtPercent(summary.correctPercent), hint: '按习题量加权' }),
            h(MetricCard, { label: '资料任务占比', value: fmtPercent(summary.materialTaskRatio) }),
            h(MetricCard, { label: '师阅率均值', value: fmtPercent(summary.teacherMarkPercentAvg), hint: '简单平均，忽略缺失' }),
          ),
        ),
        h(
          Section,
          {
            title: '学科统计',
            note: subjectNoteParts.join('；'),
          },
          h(DataTable, {
            columns: SUBJECT_COLUMNS,
            rows: subjectTableRows(grade),
            emptyText: '本周期没有学科数据',
          }),
        ),
        h(
          Section,
          {
            title: '教师统计',
            note: '按「师阅题目」降序',
          },
          h(DataTable, {
            columns: TEACHER_COLUMNS,
            rows: teacherRows,
            emptyText: '本周期没有教师数据',
            footer:
              '共 ' +
              fmtInt(teachers.length) +
              ' 位教师' +
              (teachers.length > TEACHER_TABLE_LIMIT ? '，按师阅题目降序展示前 ' + TEACHER_TABLE_LIMIT + ' 位' : ''),
          }),
        ),
        h(
          Section,
          { title: '自学数据', note: selfNoteParts.join(' · ') },
          h(DataTable, {
            columns: SELF_COLUMNS,
            rows: selfStudyRows(grade),
            emptyText: '本周期没有自学数据',
          }),
        ),
      )
    }

    function TotalsSection(props) {
      const totals = props.totals || {}
      const noteParts = []
      if (toFiniteNumber(totals.gradeCount) !== null) noteParts.push(fmtInt(totals.gradeCount) + ' 个年级')
      if (toFiniteNumber(totals.days) !== null) noteParts.push('统计 ' + fmtInt(totals.days) + ' 天')
      return h(
        Section,
        { title: '三届合计', note: noteParts.join(' · ') },
        h(
          'div',
          { className: 'flr-cards' },
          h(MetricCard, { tone: 'totals', label: '任务数', value: fmtInt(totals.taskCount) }),
          h(MetricCard, { tone: 'totals', label: '习题数', value: fmtInt(totals.questionCount) }),
          h(MetricCard, { tone: 'totals', label: '日均任务', value: fmtFixed(totals.dailyTask, 2) }),
          h(MetricCard, { tone: 'totals', label: '日均习题', value: fmtFixed(totals.dailyQuestion, 2) }),
          h(MetricCard, {
            tone: 'totals',
            label: '自学人次',
            value: fmtInt(totals.selfPersonCount),
            hint: toFiniteNumber(totals.selfQuestionCount) !== null ? '题量 ' + fmtInt(totals.selfQuestionCount) : null,
          }),
          h(MetricCard, {
            tone: 'totals',
            label: '观看时长',
            value: totals.watchDurationText || '—',
            unit: totals.watchDurationText ? '时:分' : '',
            hint: toFiniteNumber(totals.watchHours) !== null ? '约 ' + fmtFixed(totals.watchHours, 1) + ' 小时' : null,
          }),
        ),
      )
    }

    // ---------------------------------------------------------------- 报告文件

    function statusOf(fileStatus, file, action) {
      if (!file || !file.path) return ''
      return fileStatus[(action === 'reveal' ? 'r:' : 'o:') + file.path] || ''
    }

    function statusText(status) {
      if (status === 'opening') return '正在打开…'
      if (status === 'revealing') return '正在定位…'
      if (status === 'opened') return '已打开'
      if (status === 'revealed') return '已定位'
      if (status === 'error') return '操作失败'
      return ''
    }

    function statusClass(status) {
      if (!status) return 'flr-file-status'
      if (status === 'error') return 'flr-file-status is-error'
      if (status === 'opened' || status === 'revealed') return 'flr-file-status is-done'
      return 'flr-file-status is-busy'
    }

    function FileActions(props) {
      const file = props.file
      const status = props.status
      const busy = status === 'opening' || status === 'revealing'
      return h(
        'div',
        { className: 'flr-file-actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'flr-btn flr-btn--ghost flr-btn--tiny',
            disabled: props.disabled || busy,
            title:
              variantOfFile(file) === 'interactive'
                ? '用浏览器打开交互版报告（单文件 HTML，图表可交互）'
                : '用系统默认应用打开（PDF 用预览、HTML 用浏览器、Word 用 Pages/Word）',
            onClick: function () {
              props.onOpen(file)
            },
          },
          props.label || fileOpenLabel(file),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'flr-btn flr-btn--ghost flr-btn--tiny',
            disabled: props.disabled || busy,
            title: '在访达中显示该文件',
            onClick: function () {
              props.onReveal(file)
            },
          },
          '在访达中显示',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'flr-btn flr-btn--ghost flr-btn--tiny',
            disabled: busy,
            title: '复制文件完整路径',
            onClick: function () {
              props.onCopy(file.path, '文件路径')
            },
          },
          '复制路径',
        ),
        status ? h('span', { className: statusClass(status), role: 'status' }, statusText(status)) : null,
      )
    }

    /** 一组文件（同一版本）：标题 + 文件行，沿用原有的 打开 / 在访达中显示 / 复制路径。 */
    function ReportFileGroup(props) {
      const group = props.group
      return h(
        'div',
        { className: 'flr-report-group', 'data-variant': group.variant },
        h(
          'div',
          { className: 'flr-report-group-head' },
          h('span', { className: 'flr-report-group-title' }, group.title),
          h('span', { className: 'flr-report-group-note' }, group.files.length + ' 个文件'),
        ),
        h(
          'ul',
          { className: 'flr-files' },
          group.files.map(function (file, index) {
            return h(
              'li',
              { className: 'flr-file', key: (file && (file.kind || file.name)) || index },
              h('span', { className: 'flr-file-badge' }, FILE_KIND_LABEL[file && file.kind] || 'FILE'),
              h(
                'div',
                { className: 'flr-file-main' },
                h('span', { className: 'flr-file-name', title: file && file.name }, (file && (file.label || file.name)) || '报告文件'),
                h(
                  'span',
                  { className: 'flr-file-meta', title: file && file.path },
                  [(file && file.name) || '', fmtSize(file && file.bytes)].filter(Boolean).join(' · '),
                ),
              ),
              h(FileActions, {
                file: file,
                label: fileOpenLabel(file),
                status: statusOf(props.fileStatus, file, 'open'),
                disabled: props.busy,
                onOpen: props.onOpen,
                onReveal: props.onReveal,
                onCopy: props.onCopy,
              }),
            )
          }),
        ),
      )
    }

    function ReportPanel(props) {
      const report = props.report || {}
      const files = sortReportFiles(report.files)
      const groups = groupReportFiles(files)
      const warnings = Array.isArray(report.warnings) ? report.warnings : []
      const variants = groups.map(function (group) {
        return group.variant
      })
      const statsVariant = report.mode
        ? normalizeVariant(report.mode)
        : variants.length === 1
          ? variants[0]
          : 'full'
      const statsText = props.statsText || reportStatsText(report.stats, statsVariant)
      const primary = primaryReportFile(files)
      const primaryStatus = primary ? statusOf(props.fileStatus, primary, 'open') : ''
      const primaryBusy = primaryStatus === 'opening' || primaryStatus === 'revealing'
      const total = files.length

      const head = h(
        'div',
        { className: 'flr-report-head' },
        h(
          'div',
          null,
          h('h2', { className: 'flr-report-title' }, '报告已生成'),
          statsText ? h('p', { className: 'flr-report-stats' }, statsText) : null,
          variants.length > 1
            ? h(
                'p',
                { className: 'flr-report-modes' },
                variants.map(function (variant, index) {
                  return h(
                    'span',
                    { className: 'flr-report-mode-tag', key: variant },
                    (index ? ' · ' : '') + (VARIANT_TITLE[variant] || variant),
                  )
                }),
              )
            : null,
        ),
        primary
          ? h(
              'div',
              { className: 'flr-file-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'flr-btn flr-btn--primary flr-btn--small',
                  disabled: primaryBusy,
                  onClick: function () {
                    props.onOpen(primary)
                  },
                },
                primaryBusy ? '正在打开…' : '打开最新报告',
              ),
              primaryStatus === 'error'
                ? h('span', { className: 'flr-file-status is-error' }, '打不开？点下方「复制路径」手动打开')
                : null,
            )
          : null,
      )

      const body = total
        ? h(
            'div',
            { className: 'flr-report-groups' },
            groups.map(function (group) {
              return h(ReportFileGroup, {
                group: group,
                key: group.variant,
                busy: props.busy,
                fileStatus: props.fileStatus,
                onOpen: props.onOpen,
                onReveal: props.onReveal,
                onCopy: props.onCopy,
              })
            }),
          )
        : h('p', { className: 'flr-report-hint' }, '生成完成，但没有返回可打开的报告文件。')

      const dir = report.outputDir
        ? h(
            'p',
            { className: 'flr-dir' },
            h('span', null, '输出目录：'),
            h('code', { title: report.outputDir }, report.outputDir),
            h(
              'button',
              {
                type: 'button',
                className: 'flr-btn flr-btn--ghost flr-btn--tiny',
                onClick: function () {
                  props.onOpenDir(report.outputDir)
                },
              },
              '打开文件夹',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'flr-btn flr-btn--ghost flr-btn--tiny',
                onClick: function () {
                  props.onCopy(report.outputDir, '输出目录')
                },
              },
              '复制路径',
            ),
          )
        : null

      const hasPdf = files.some(function (file) {
        return file && file.kind === 'pdf'
      })
      const hasDocx = files.some(function (file) {
        return file && file.kind === 'docx'
      })
      const pdfHint =
        !hasPdf && files.length
          ? h(
              'p',
              { className: 'flr-report-hint' },
              variants.indexOf('interactive') >= 0
                ? '交互版不生成 PDF：直接「浏览器打开」即可查看与截图；需要 PDF 请用正式版或简报版。'
                : '本次没有生成 PDF：可打开「可打印 HTML」后用浏览器打印为 PDF。',
            )
          : null
      // Word 版为送审用主文件：适合学校内部批注流转；PDF 版为最终定稿格式
      const docxHint =
        !hasDocx && variants.indexOf('brief') >= 0
          ? h(
              'p',
              { className: 'flr-report-hint' },
              '本次没有生成简报 Word：可在「生成简报」时确认 Host 的 lib/brief.js 可用后重试。',
            )
          : null

      return h(
        Section,
        { title: '报告文件', note: report.school || '' },
        h(
          'div',
          { className: 'flr-report' },
          head,
          body,
          dir,
          pdfHint,
          docxHint,
          warnings.length
            ? h('div', { className: 'flr-report-warn' }, h(Alert, { tone: 'warn', title: '生成过程中的提示', items: warnings }))
            : null,
        ),
      )
    }

    function normalizeVariant(value) {
      return value === 'brief' || value === 'interactive' || value === 'full' ? value : 'full'
    }

    function HistorySection(props) {
      const reports = Array.isArray(props.reports) ? props.reports : []
      const [expanded, setExpanded] = useState(false)
      if (!reports.length) return null
      const shown = expanded ? reports : reports.slice(0, HISTORY_LIMIT)
      const rows = shown.map(function (bundle, index) {
        const title = (bundle.school || '报告') + ' · ' + (bundle.from || '') + ' ~ ' + (bundle.to || '')
        const files = sortReportFiles(bundle.files)
        const variantNames = []
        for (const file of files) {
          const variant = variantOfFile(file)
          if (variantNames.indexOf(variant) < 0) variantNames.push(variant)
        }
        variantNames.sort(function (a, b) {
          return (VARIANT_ORDER[a] === undefined ? 9 : VARIANT_ORDER[a]) - (VARIANT_ORDER[b] === undefined ? 9 : VARIANT_ORDER[b])
        })
        const variantText = variantNames.map(function (variant) {
          return VARIANT_TITLE[variant] || variant
        }).join(' / ')
        const bundleStatus = files.map(function (file) {
          return statusOf(props.fileStatus, file, 'open')
        }).find(Boolean) || ''
        return h(
          'div',
          { className: 'flr-history-row', key: (bundle.dir || '') + index },
          h(
            'div',
            { className: 'flr-history-main' },
            h('span', { className: 'flr-history-title', title: bundle.dir }, title),
            h(
              'span',
              { className: 'flr-history-meta' },
              (variantText ? variantText + ' · ' : '') +
                '更新于 ' + fmtDateTime(bundle.updatedAt) + ' · ' + bundle.files.length + ' 个文件',
            ),
          ),
          h(
            'div',
            { className: 'flr-history-files' },
            files.map(function (file) {
              const status = statusOf(props.fileStatus, file, 'open')
              const busy = status === 'opening' || status === 'revealing'
              return h(
                'button',
                {
                  key: file.kind + file.path,
                  type: 'button',
                  className: 'flr-btn flr-btn--ghost flr-btn--tiny',
                  disabled: props.busy || busy,
                  title: file.path,
                  onClick: function () {
                    props.onOpen(file)
                  },
                },
                fileOpenLabel(file),
              )
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'flr-btn flr-btn--ghost flr-btn--tiny',
                disabled: props.busy,
                title: '在访达中显示报告文件夹',
                onClick: function () {
                  props.onRevealDir(bundle.dir)
                },
              },
              '在访达中显示',
            ),
            bundleStatus ? h('span', { className: statusClass(bundleStatus), role: 'status' }, statusText(bundleStatus)) : null,
          ),
        )
      })
      return h(
        Section,
        {
          title: '历史报告',
          note: '最近 ' + reports.length + ' 份 · 点击即可用系统默认应用打开',
        },
        h('div', { className: 'flr-history' }, rows),
        reports.length > HISTORY_LIMIT
          ? h(
              'button',
              {
                type: 'button',
                className: 'flr-btn flr-btn--ghost flr-btn--tiny flr-history-more',
                onClick: function () {
                  setExpanded((value) => !value)
                },
              },
              expanded ? '收起' : '显示全部 ' + reports.length + ' 份',
            )
          : null,
      )
    }

    // ---------------------------------------------------------------- 页面

    function ReportPage() {
      const [boot, setBoot] = useState({ loading: true, defaults: null, version: '' })
      const [schools, setSchools] = useState([])
      const [form, setForm] = useState({
        school: '',
        from: INITIAL_WINDOW.from,
        to: INITIAL_WINDOW.to,
      })
      const [creds, setCreds] = useState({ username: '', password: '' })
      const [credOpen, setCredOpen] = useState(false)
      const [addSchoolMode, setAddSchoolMode] = useState(false)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [snapshot, setSnapshot] = useState(null)
      const [activeGradeId, setActiveGradeId] = useState(null)
      const [report, setReport] = useState(null)
      const [history, setHistory] = useState([])
      const [fileStatus, setFileStatus] = useState({})
      const [version, setVersion] = useState(null)
      const [versionOpen, setVersionOpen] = useState(false)
      const [versionStatus, setVersionStatus] = useState({ checking: false, busy: false, message: '' })
      // 打开页面 / 切换学校时是否自动拉取。默认关：只回填默认学校与区间，
      // 等用户点「获取数据」再联网取数（Host 配置 autoFetch=true 时默认打开）。
      const [autoFetch, setAutoFetch] = useState(false)

      const mountedRef = useRef(true)
      const busyRef = useRef('')
      const runIdRef = useRef(0)
      const snapshotAbortRef = useRef(null)
      const reportAbortRef = useRef(null)
      const bindAbortRef = useRef(null)
      const statusTimersRef = useRef({})
      const versionBusyRef = useRef(false)
      const versionCheckRef = useRef(false)

      function setBusySafe(value) {
        busyRef.current = value || ''
        setBusy(value || '')
      }

      function flashStatus(key, status) {
        setFileStatus(function (prev) {
          const next = Object.assign({}, prev)
          next[key] = status
          return next
        })
        const existing = statusTimersRef.current[key]
        if (existing) clearTimeout(existing)
        statusTimersRef.current[key] = setTimeout(function () {
          delete statusTimersRef.current[key]
          if (!mountedRef.current) return
          setFileStatus(function (prev) {
            if (!prev[key]) return prev
            const next = Object.assign({}, prev)
            delete next[key]
            return next
          })
        }, 2600)
      }

      // 卸载时停止所有进行中的请求，避免残留 setState。
      useEffect(function () {
        mountedRef.current = true
        return function () {
          mountedRef.current = false
          abortController(snapshotAbortRef.current)
          abortController(reportAbortRef.current)
          abortController(bindAbortRef.current)
          snapshotAbortRef.current = null
          reportAbortRef.current = null
          bindAbortRef.current = null
          for (const key of Object.keys(statusTimersRef.current)) clearTimeout(statusTimersRef.current[key])
        }
      }, [])

      function applySchools(list) {
        setSchools(Array.isArray(list) ? list : [])
      }

      async function loadHistory() {
        try {
          const payload = await requestJson('/reports', { method: 'GET' })
          if (!mountedRef.current) return
          setHistory(Array.isArray(payload.reports) ? payload.reports : [])
        } catch (err) {
          /* 历史报告读取失败不影响主流程 */
        }
      }

      // 版本检查：页面打开时查一次（Host 侧缓存 10 分钟），有新版本就在徽标上点红点。
      async function loadVersion(force) {
        try {
          const payload = await requestJson('/update-check' + (force ? '?force=1' : ''), { method: 'GET' })
          if (!mountedRef.current) return null
          const info = {
            current: payload.version || '',
            running: payload.runningVersion || '',
            latest: payload.latest || '',
            updateAvailable: Boolean(payload.updateAvailable),
            restartPending: Boolean(payload.restartPending),
            source: payload.source || 'unknown',
            spec: payload.spec || '',
            repo: payload.repo || '',
            repoUrl: payload.repoUrl || '',
            disabled: Boolean(payload.disabled),
            checkedAt: payload.checkedAt || 0,
            error: payload.error || '',
          }
          setVersion(info)
          return info
        } catch (err) {
          if (!mountedRef.current) return null
          return null
        }
      }

      async function checkUpdates() {
        if (versionBusyRef.current) return
        versionBusyRef.current = true
        setVersionStatus({ checking: true, busy: false, message: '' })
        try {
          await loadVersion(true)
          setVersionStatus({ checking: false, busy: false, message: '' })
        } finally {
          versionBusyRef.current = false
          if (mountedRef.current) setVersionStatus(function (prev) { return Object.assign({}, prev, { checking: false }) })
        }
      }

      async function runUpdate() {
        if (versionBusyRef.current) return
        versionBusyRef.current = true
        setVersionStatus({ checking: false, busy: true, message: '正在从 GitHub 安装最新版，请稍候…' })
        setError('')
        try {
          const payload = await postJson('/update', {})
          if (!mountedRef.current) return
          setVersionStatus({
            checking: false,
            busy: false,
            message:
              (payload && payload.message ? payload.message : '更新完成') +
              (payload && payload.restartRequired ? '（请重启 DeepSeek Harness 让新版本生效）' : ''),
          })
          setNotice(
            '插件已更新到 ' +
              ((payload && (payload.to || payload.latest)) || '最新版') +
              '：重启 DeepSeek Harness 后生效。重启前当前页面仍运行旧版本。',
          )
          await loadVersion(true)
        } catch (err) {
          if (!mountedRef.current) return
          setVersionStatus({ checking: false, busy: false, message: '' })
          setError('更新失败：' + messageOf(err))
        } finally {
          versionBusyRef.current = false
        }
      }

      // 读取 Host 默认参数（已绑定学校 / 日期 / 凭据文件 / Chrome 可用性）。
      // 默认只回填学校与区间，不自动取数：由用户点「获取数据」再拉，
      // 避免每次打开工作台都联网请求一次看板（Host 配置 autoFetch=true 可恢复自动取数）。
      useEffect(function () {
        let alive = true
        const controller = makeAbortController()
        setBoot({ loading: true, defaults: null, version: '' })
        requestJson('/defaults', { method: 'GET' }, controller)
          .then(function (payload) {
            if (!alive || !mountedRef.current) return
            const defaults = (payload && payload.defaults) || {}
            const list = Array.isArray(defaults.bindings) ? defaults.bindings : []
            const lastSchool = defaults.lastSchool && list.some((b) => b.alias === defaults.lastSchool)
              ? defaults.lastSchool
              : list.length
                ? list[0].alias
                : ''
            const school = lastSchool || (defaults.school || 'lyyz')
            const from = isIsoDate(defaults.from) ? defaults.from : INITIAL_WINDOW.from
            const to = isIsoDate(defaults.to) ? defaults.to : INITIAL_WINDOW.to
            const allowAuto = defaults.autoFetch === true
            setBoot({ loading: false, defaults: defaults, version: (payload && payload.version) || '' })
            applySchools(list)
            setForm({ school: school, from: from, to: to })
            setAutoFetch(allowAuto)
            loadHistory()
            // 版本检查与取数并行：不阻塞主流程，失败也只在版本面板里提示。
            loadVersion(false)
            if (allowAuto && lastSchool) {
              // 已绑定且允许自动取数：直接拉一次（失败时只在页面上提示，不阻塞其他操作）
              loadSnapshot({ school: lastSchool, from: from, to: to, useCreds: false })
            }
          })
          .catch(function (err) {
            if (!alive || !mountedRef.current || isAbortError(err)) return
            setBoot({ loading: false, defaults: null, version: '' })
            setNotice('未能读取本机默认参数（' + messageOf(err) + '），请手动填写学校与日期后重试。')
          })
        return function () {
          alive = false
          abortController(controller)
        }
      }, [])

      const defaults = boot.defaults || {}
      const grades = snapshot && Array.isArray(snapshot.grades) ? snapshot.grades : []
      const activeGrade =
        grades.find(function (grade) {
          return String(grade.gradeId) === String(activeGradeId)
        }) ||
        grades[0] ||
        null
      const currentBinding = schools.find(function (item) {
        return item.alias === form.school
      })
      const schoolIsBound = Boolean(currentBinding)
      const needManualSchool = addSchoolMode || !schoolIsBound
      const showCredEditor = !schoolIsBound || credOpen

      function setField(key, value) {
        setForm(function (prev) {
          const next = Object.assign({}, prev)
          next[key] = value
          return next
        })
      }

      function setCredField(key, value) {
        setCreds(function (prev) {
          const next = Object.assign({}, prev)
          next[key] = value
          return next
        })
      }

      function validate(fields) {
        const school = normalizeSchoolAlias(fields.school)
        if (!school) return '请填写学校子域名（例如 lyyz）'
        if (!SCHOOL_ALIAS_PATTERN.test(school)) return '学校子域名只能包含字母、数字和连字符（例如 lyyz）'
        if (!isIsoDate(fields.from) || !isIsoDate(fields.to)) return '请选择开始日期与结束日期'
        if (new Date(fields.from) > new Date(fields.to)) return '开始日期不能晚于结束日期'
        return ''
      }

      function snapshotBody(fields, useCreds) {
        const body = {
          school: normalizeSchoolAlias(fields.school),
          from: fields.from,
          to: fields.to,
        }
        if (useCreds) {
          const username = String(fields.username || '').trim()
          if (username) body.username = username
          if (fields.password) body.password = fields.password
        }
        return body
      }

      async function loadSnapshot(overrides) {
        if (busyRef.current) return false
        const next = Object.assign(
          { school: form.school, from: form.from, to: form.to, username: '', password: '' },
          overrides || {},
        )
        const invalid = validate(next)
        if (invalid) {
          setError(invalid)
          return false
        }
        const useCreds = overrides && overrides.useCreds === true
        if (useCreds && (!String(next.username || '').trim() || !next.password)) {
          setError('这所学校还没有绑定账号，请填写账号与密码后再获取数据（只需填一次，之后会自动登录）。')
          return false
        }
        const runId = ++runIdRef.current
        abortController(snapshotAbortRef.current)
        const controller = makeAbortController()
        snapshotAbortRef.current = controller
        setBusySafe('snapshot')
        setError('')
        setNotice('')
        try {
          const payload = await postJson('/snapshot', snapshotBody(next, useCreds), controller)
          if (!mountedRef.current || runIdRef.current !== runId) return false
          const nextSnapshot = payload && payload.snapshot
          if (!nextSnapshot || typeof nextSnapshot !== 'object') throw new Error('接口没有返回数据模型')
          const nextGrades = Array.isArray(nextSnapshot.grades) ? nextSnapshot.grades : []
          setSnapshot(nextSnapshot)
          setReport(null)
          setActiveGradeId(nextGrades.length ? nextGrades[0].gradeId : null)
          setForm(function (prev) {
            return Object.assign({}, prev, { school: normalizeSchoolAlias(next.school), from: next.from, to: next.to })
          })
          if (Array.isArray(payload.bindings)) applySchools(payload.bindings)
          if (useCreds && Array.isArray(payload.bindings) && payload.bindings.some((b) => b.alias === normalizeSchoolAlias(next.school))) {
            setCredOpen(false)
            setAddSchoolMode(false)
            setCreds({ username: '', password: '' })
            setNotice('已保存这所学校的账号，下次打开工作台会自动登录，无需再输入。')
          }
          loadHistory()
          return true
        } catch (err) {
          if (!mountedRef.current || runIdRef.current !== runId || isAbortError(err)) return false
          setSnapshot(null)
          setReport(null)
          setActiveGradeId(null)
          setError('拉取教学数据失败：' + messageOf(err))
          return false
        } finally {
          if (mountedRef.current && runIdRef.current === runId) setBusySafe('')
          if (snapshotAbortRef.current === controller) snapshotAbortRef.current = null
        }
      }

      async function bindSchool() {
        if (busyRef.current) return
        const alias = normalizeSchoolAlias(form.school)
        if (!alias) {
          setError('请填写学校子域名（例如 lyyz）')
          return
        }
        if (!SCHOOL_ALIAS_PATTERN.test(alias)) {
          setError('学校子域名只能包含字母、数字和连字符（例如 lyyz）')
          return
        }
        const savedBinding = schools.find((item) => item.alias === alias) || null
        const username = String(creds.username || '').trim() || (savedBinding ? savedBinding.username : '')
        const password = creds.password
        if (!username) {
          setError('请填写账号')
          return
        }
        if (!password) {
          if (savedBinding) {
            // 账号密码都没改：收起编辑区即可，不重复提交。
            setCredOpen(false)
            setCreds({ username: '', password: '' })
            setNotice('账号未变化，继续使用已保存的登录信息。')
            return
          }
          setError('请填写密码')
          return
        }
        const runId = ++runIdRef.current
        abortController(bindAbortRef.current)
        const controller = makeAbortController()
        bindAbortRef.current = controller
        setBusySafe('bind')
        setError('')
        setNotice('')
        try {
          const payload = await postJson(
            '/bind',
            { school: alias, username: username, password: password },
            controller,
          )
          if (!mountedRef.current || runIdRef.current !== runId) return
          if (Array.isArray(payload.bindings)) applySchools(payload.bindings)
          const binding = payload.binding || null
          setCreds({ username: '', password: '' })
          setCredOpen(false)
          setAddSchoolMode(false)
          setForm(function (prev) {
            return Object.assign({}, prev, { school: alias })
          })
          setNotice('已绑定「' + ((binding && (binding.siteTitle || binding.alias)) || alias) + '」，下次打开无需再输入账号密码。')
          busyRef.current = ''
          setBusySafe('')
          await loadSnapshot({ school: alias, from: form.from, to: form.to, useCreds: false })
        } catch (err) {
          if (!mountedRef.current || runIdRef.current !== runId || isAbortError(err)) return
          setError('绑定失败：' + messageOf(err))
        } finally {
          if (mountedRef.current && runIdRef.current === runId) setBusySafe('')
          if (bindAbortRef.current === controller) bindAbortRef.current = null
        }
      }

      async function unbindSchool() {
        if (busyRef.current) return
        const alias = normalizeSchoolAlias(form.school)
        if (!alias) return
        const binding = schools.find((item) => item.alias === alias)
        const label = (binding && (binding.siteTitle || binding.alias)) || alias
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('解除「' + label + '」的账号绑定？解除后需要重新输入账号密码（报告文件不受影响）。')) return
        }
        setBusySafe('unbind')
        setError('')
        setNotice('')
        try {
          const payload = await postJson('/unbind', { school: alias })
          if (!mountedRef.current) return
          if (Array.isArray(payload.bindings)) applySchools(payload.bindings)
          setSnapshot(null)
          setReport(null)
          setActiveGradeId(null)
          setCredOpen(true)
          setAddSchoolMode(true)
          setCreds({ username: '', password: '' })
          setNotice('已解除「' + label + '」的绑定。重新填写账号密码即可再次绑定。')
        } catch (err) {
          if (!mountedRef.current) return
          setError('解除绑定失败：' + messageOf(err))
        } finally {
          if (mountedRef.current) setBusySafe('')
        }
      }

      /**
       * 生成报告文件。mode 三选一：full（正式版）/ brief（简报版）/ interactive（交互版）；
       * 各自上传该版本的 formats，Host 按 mode 产出并回传 variant 供前端分组。
       */
      async function generateReport(mode) {
        if (busyRef.current || !snapshot) return
        const config = modeConfig(mode)
        const runId = ++runIdRef.current
        abortController(reportAbortRef.current)
        const controller = makeAbortController()
        reportAbortRef.current = controller
        setBusySafe(BUSY_MODE_PREFIX + config.mode)
        setError('')
        setNotice('')
        try {
          const requestBody = {
            school: normalizeSchoolAlias(form.school),
            from: (snapshot.meta && snapshot.meta.from) || form.from,
            to: (snapshot.meta && snapshot.meta.to) || form.to,
            mode: config.mode,
            formats: config.formats,
          }
          const payload = await postJson('/report', requestBody, controller)
          if (!mountedRef.current || runIdRef.current !== runId) return
          setReport({
            mode: (payload && payload.mode) || config.mode,
            modeTitle: (payload && payload.modeTitle) || config.title,
            files: payload && Array.isArray(payload.files) ? payload.files : [],
            stats: (payload && payload.stats) || null,
            warnings: payload && Array.isArray(payload.warnings) ? payload.warnings : [],
            outputDir: (payload && payload.outputDir) || '',
            school: (payload && payload.school) || '',
          })
          loadHistory()
        } catch (err) {
          if (!mountedRef.current || runIdRef.current !== runId || isAbortError(err)) return
          setError('生成' + config.title + '失败：' + messageOf(err))
        } finally {
          if (mountedRef.current && runIdRef.current === runId) setBusySafe('')
          if (reportAbortRef.current === controller) reportAbortRef.current = null
        }
      }

      async function openFile(file, reveal) {
        if (!file || !file.path) return
        const key = (reveal ? 'r:' : 'o:') + file.path
        if (fileStatus[key] === 'opening' || fileStatus[key] === 'revealing') return
        flashStatus(key, reveal ? 'revealing' : 'opening')
        try {
          await postJson('/open', { path: file.path, reveal: !!reveal })
          if (!mountedRef.current) return
          flashStatus(key, reveal ? 'revealed' : 'opened')
        } catch (err) {
          if (!mountedRef.current) return
          flashStatus(key, 'error')
          if (reveal) {
            setNotice('在访达中定位失败：' + messageOf(err) + '。文件路径：' + file.path)
            return
          }
          // Host 原生打开失败时退回浏览器新标签页打开文件地址。
          let popup = null
          try {
            popup = window.open(file.url, '_blank', 'noopener,noreferrer')
          } catch (e) {
            popup = null
          }
          setNotice(
            popup
              ? '系统默认应用打开失败（' + messageOf(err) + '），已改用浏览器标签页打开。'
              : '系统默认应用打开失败（' + messageOf(err) + '），浏览器也拦截了新标签页。可点「复制路径」后用其他应用打开。',
          )
        }
      }

      function openDir(dir) {
        if (!dir) return
        const key = 'o:' + dir
        flashStatus(key, 'opening')
        postJson('/open', { path: dir })
          .then(function () {
            if (mountedRef.current) flashStatus(key, 'opened')
          })
          .catch(function (err) {
            if (!mountedRef.current) return
            flashStatus(key, 'error')
            setNotice('打开报告目录失败：' + messageOf(err))
          })
      }

      function revealDir(dir) {
        if (!dir) return
        const key = 'r:' + dir
        flashStatus(key, 'revealing')
        postJson('/open', { path: dir, reveal: true })
          .then(function () {
            if (mountedRef.current) flashStatus(key, 'revealed')
          })
          .catch(function (err) {
            if (!mountedRef.current) return
            flashStatus(key, 'error')
            setNotice('在访达中定位失败：' + messageOf(err))
          })
      }

      function copyText(text, label) {
        if (!text) return
        copyToClipboard(text)
          .then(function () {
            if (mountedRef.current) setNotice((label || '内容') + '已复制到剪贴板。')
          })
          .catch(function (err) {
            if (mountedRef.current) setNotice('复制失败：' + messageOf(err) + '。可手动选择复制：' + text)
          })
      }

      function onSubmit(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        const alias = normalizeSchoolAlias(form.school)
        const bound = schools.some((item) => item.alias === alias)
        loadSnapshot({
          school: alias,
          from: form.from,
          to: form.to,
          username: creds.username,
          password: creds.password,
          useCreds: !bound || (credOpen && (String(creds.username || '').trim() !== '' || creds.password !== '')),
        })
      }

      function selectSchool(event) {
        const value = event && event.target ? event.target.value : ''
        setError('')
        setNotice('')
        if (value === '__add__') {
          setAddSchoolMode(true)
          setCredOpen(true)
          setCreds({ username: '', password: '' })
          setForm(function (prev) {
            return Object.assign({}, prev, { school: '' })
          })
          return
        }
        const binding = schools.find((item) => item.alias === value)
        setAddSchoolMode(false)
        setCredOpen(false)
        setCreds({ username: '', password: '' })
        setForm(function (prev) {
          return Object.assign({}, prev, { school: value })
        })
        // 切到另一所学校：先清掉上一所学校的数据，避免旧数据挂在新学校名下。
        if (snapshot && String((snapshot.meta && snapshot.meta.schoolAlias) || '') !== value) {
          abortController(snapshotAbortRef.current)
          setSnapshot(null)
          setReport(null)
          setActiveGradeId(null)
        }
        // 只有显式开启「自动拉取」时，切换学校后才直接取数；默认等用户点「获取数据」。
        if (binding && autoFetch) {
          loadSnapshot({ school: value, from: form.from, to: form.to, useCreds: false })
        } else if (binding) {
          setNotice('已切换到「' + (binding.siteTitle || binding.alias) + '」，点「获取数据」拉取该学校的数据。')
        }
      }

      function applyPreset(days) {
        const range = windowOfDays(days)
        setForm(function (prev) {
          return Object.assign({}, prev, { from: range.from, to: range.to })
        })
      }

      function selectGrade(gradeId) {
        setActiveGradeId(gradeId)
      }

      // 站点信息条 / 顶部数据来源
      const meta = (snapshot && snapshot.meta) || {}
      const subjectCount = grades.reduce(function (sum, grade) {
        return sum + subjectsOf(grade).length
      }, 0)
      const teacherCount = grades.reduce(function (sum, grade) {
        return sum + teachersOf(grade).length
      }, 0)

      const sourceText = snapshot
        ? '数据来源：' + (meta.siteTitle || meta.host || '学校管理看板') + ' · 只读'
        : '数据来源：辅立码课智慧教学云 · 管理看板（只读）'

      const infoItems = snapshot
        ? [
            { label: '站点', value: meta.siteTitle || '—', title: meta.host },
            { label: '地址', value: meta.host || '—' },
            { label: '统计区间', value: (meta.from || '—') + ' ~ ' + (meta.to || '—') },
            { label: '天数', value: fmtInt(meta.days) + ' 天' },
            { label: '生成时间', value: fmtDateTime(meta.generatedAt) },
            {
              label: '数据条数',
              value: fmtInt(grades.length) + ' 个年级 · ' + fmtInt(subjectCount) + ' 条学科 · ' + fmtInt(teacherCount) + ' 位教师',
            },
          ]
        : []

      const warnings = snapshot && Array.isArray(snapshot.warnings) ? snapshot.warnings : []
      const busyMode = busy.indexOf(BUSY_MODE_PREFIX) === 0 ? busy.slice(BUSY_MODE_PREFIX.length) : ''
      const busyText =
        busy === 'snapshot'
          ? '正在从学校站点拉取管理看板数据…'
          : busyMode
            ? modeConfig(busyMode).busyText
            : busy === 'bind'
              ? '正在验证账号并绑定学校…'
              : busy === 'unbind'
                ? '正在解除绑定…'
                : ''

      const hints = []
      if (bindingsFileHint(defaults)) {
        hints.push(
          h(
            'p',
            { className: 'flr-hint', key: 'binding' },
            '账号只保存在本机：',
            h('code', null, defaults.bindingsFile || ''),
            '（文件权限 0600，不上传）。已绑定的学校下次打开自动登录。',
          ),
        )
      }
      if (!schoolIsBound && defaults.credentialsFile) {
        hints.push(
          h(
            'p',
            { className: 'flr-hint', key: 'cred' },
            '也可以不填账号：会读取本机已保存凭据 ',
            h('code', null, defaults.credentialsFile),
          ),
        )
      }
      if (defaults.chromeAvailable === false) {
        hints.push(
          h(
            'p',
            { className: 'flr-hint', key: 'chrome' },
            '未检测到本机 Chrome：生成 PDF 可能失败，报告仍会输出 Markdown 与可打印 HTML。',
          ),
        )
      }

      const presetButtons = [
        { days: 7, label: '近 7 天' },
        { days: 14, label: '近 14 天' },
        { days: 30, label: '近 30 天' },
      ].map(function (preset) {
        const range = windowOfDays(preset.days)
        const active = form.from === range.from && form.to === range.to
        return h(
          'button',
          {
            key: preset.days,
            type: 'button',
            className: 'flr-preset',
            'aria-pressed': active ? 'true' : 'false',
            disabled: busy !== '',
            onClick: function () {
              applyPreset(preset.days)
            },
          },
          preset.label,
        )
      })

      const schoolSelect = schools.length
        ? h(
            'select',
            {
              id: 'flr-school',
              className: 'flr-select',
              value: needManualSchool ? '__add__' : form.school,
              disabled: busy !== '',
              'aria-label': '选择学校',
              onChange: selectSchool,
            },
            schools.map(function (item) {
              return h('option', { key: item.alias, value: item.alias }, schoolLabel(item))
            }),
            h('option', { value: '__add__' }, '＋ 绑定其他学校…'),
          )
        : null

      return h(
        'div',
        { className: 'flr-page', 'aria-busy': busy ? 'true' : 'false' },
        h(StyleSheet),
        h(
          'div',
          { className: 'flr-scroll' },
          h(
            'div',
            { className: 'flr-content' },
            h(
              'header',
              { className: 'flr-header' },
              h(
                'div',
                { className: 'flr-heading' },
                h('h1', { className: 'flr-title' }, '教学数据报告'),
                h('p', { className: 'flr-subtitle' }, '辅立码课 · 智慧教学云管理看板'),
              ),
              h(
                'div',
                { className: 'flr-header-side' },
                h('span', { className: 'flr-chip flr-chip--ok' }, '只读'),
                schools.length ? h('span', { className: 'flr-chip' }, '已绑定 ' + schools.length + ' 所学校') : null,
                h(VersionBadge, {
                  info: version,
                  fallbackVersion: boot.version || '',
                  open: versionOpen,
                  onToggle: function () {
                    setVersionOpen(function (prev) {
                      return !prev
                    })
                  },
                }),
                h('p', { className: 'flr-source' }, sourceText),
              ),
            ),

            // 版本面板：有新版本时这里出现升级提示与「立即更新」按钮。
            versionOpen || (version && version.updateAvailable)
              ? h(UpdatePanel, {
                  info: version,
                  status: versionStatus,
                  onCheck: checkUpdates,
                  onUpdate: runUpdate,
                })
              : null,

            h(
              'form',
              { className: 'flr-toolbar', onSubmit: onSubmit },
              h(
                'div',
                { className: 'flr-toolbar-row' },
                h(
                  'div',
                  { className: 'flr-field', style: { flex: '0 1 auto' } },
                  h('label', { className: 'flr-field-label', htmlFor: 'flr-school' }, schools.length ? '学校' : '学校子域名'),
                  schoolSelect ||
                    h(
                      'div',
                      { className: 'flr-domain' },
                      h('span', { className: 'flr-domain-text flr-domain-text--prefix' }, 'https://'),
                      h('input', {
                        id: 'flr-school',
                        className: 'flr-domain-input',
                        value: form.school,
                        placeholder: 'lyyz',
                        spellCheck: false,
                        autoComplete: 'off',
                        disabled: busy !== '',
                        'aria-label': '学校子域名',
                        onChange: function (event) {
                          setField('school', event.target.value)
                        },
                        onBlur: function (event) {
                          setField('school', normalizeSchoolAlias(event.target.value))
                        },
                      }),
                      h('span', { className: 'flr-domain-text flr-domain-text--suffix' }, '.fuulea.com'),
                    ),
                ),
                schoolIsBound
                  ? h(
                      'span',
                      { className: 'flr-chip flr-chip--ok', title: currentBinding.username || '' },
                      (currentBinding.siteTitle || currentBinding.alias) +
                        (currentBinding.maskedUsername ? ' · ' + currentBinding.maskedUsername : ''),
                    )
                  : h('span', { className: 'flr-chip flr-chip--warn' }, '未绑定账号'),
                schoolIsBound
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'flr-linkbtn',
                        disabled: busy !== '',
                        onClick: function () {
                          setCredOpen(function (value) {
                            return !value
                          })
                          setCreds({ username: '', password: '' })
                          setError('')
                        },
                      },
                      credOpen ? '收起账号' : '更换账号',
                    )
                  : null,
                schoolIsBound
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'flr-linkbtn',
                        disabled: busy !== '',
                        onClick: unbindSchool,
                      },
                      '解除绑定',
                    )
                  : null,
                h('div', { className: 'flr-spacer' }),
                h(
                  'div',
                  { className: 'flr-presets', role: 'group', 'aria-label': '统计区间快捷选择' },
                  presetButtons,
                ),
              ),

              addSchoolMode && schools.length
                ? h(
                    'div',
                    { className: 'flr-toolbar-row' },
                    h(
                      'div',
                      { className: 'flr-field', style: { flex: '0 1 260px' } },
                      h('label', { className: 'flr-field-label', htmlFor: 'flr-alias' }, '新学校子域名'),
                      h(
                        'div',
                        { className: 'flr-domain' },
                        h('span', { className: 'flr-domain-text flr-domain-text--prefix' }, 'https://'),
                        h('input', {
                          id: 'flr-alias',
                          className: 'flr-domain-input',
                          value: form.school,
                          placeholder: 'lyyz',
                          spellCheck: false,
                          autoComplete: 'off',
                          disabled: busy !== '',
                          'aria-label': '新学校子域名',
                          onChange: function (event) {
                            setField('school', event.target.value)
                          },
                          onBlur: function (event) {
                            setField('school', normalizeSchoolAlias(event.target.value))
                          },
                        }),
                        h('span', { className: 'flr-domain-text flr-domain-text--suffix' }, '.fuulea.com'),
                      ),
                    ),
                  )
                : null,

              showCredEditor
                ? h(
                    'div',
                    { className: 'flr-toolbar-row' },
                    h(
                      'div',
                      { className: 'flr-field', style: { flex: '1 1 180px' } },
                      h('label', { className: 'flr-field-label', htmlFor: 'flr-username' }, schoolIsBound ? '新账号（可选）' : '账号'),
                      h('input', {
                        id: 'flr-username',
                        className: 'flr-input flr-input--cred',
                        value: creds.username,
                        placeholder: schoolIsBound ? '留空沿用 ' + (currentBinding.maskedUsername || '已保存账号') : '学校账号',
                        spellCheck: false,
                        autoComplete: 'off',
                        disabled: busy !== '',
                        onChange: function (event) {
                          setCredField('username', event.target.value)
                        },
                      }),
                    ),
                    h(
                      'div',
                      { className: 'flr-field', style: { flex: '1 1 180px' } },
                      h('label', { className: 'flr-field-label', htmlFor: 'flr-password' }, schoolIsBound ? '新密码（可选）' : '密码'),
                      h('input', {
                        id: 'flr-password',
                        className: 'flr-input flr-input--cred',
                        type: 'password',
                        value: creds.password,
                        placeholder: schoolIsBound ? '改账号时填写；留空则不修改' : '只保存到本机',
                        autoComplete: 'off',
                        disabled: busy !== '',
                        onChange: function (event) {
                          setCredField('password', event.target.value)
                        },
                      }),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'flr-btn flr-btn--ghost',
                        disabled: busy !== '',
                        onClick: bindSchool,
                      },
                      busy === 'bind' ? '验证中…' : schoolIsBound ? '验证并保存' : '绑定并登录',
                    ),
                    schoolIsBound
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'flr-btn flr-btn--ghost',
                            disabled: busy !== '',
                            onClick: function () {
                              setCredOpen(false)
                              setCreds({ username: '', password: '' })
                            },
                          },
                          '取消',
                        )
                      : null,
                  )
                : null,

              h(
                'div',
                { className: 'flr-toolbar-row' },
                h(
                  'div',
                  { className: 'flr-field' },
                  h('label', { className: 'flr-field-label', htmlFor: 'flr-from' }, '开始日期'),
                  h('input', {
                    id: 'flr-from',
                    className: 'flr-input flr-input--date',
                    type: 'date',
                    value: form.from,
                    disabled: busy !== '',
                    onChange: function (event) {
                      setField('from', event.target.value)
                    },
                  }),
                ),
                h(
                  'div',
                  { className: 'flr-field' },
                  h('label', { className: 'flr-field-label', htmlFor: 'flr-to' }, '结束日期'),
                  h('input', {
                    id: 'flr-to',
                    className: 'flr-input flr-input--date',
                    type: 'date',
                    value: form.to,
                    disabled: busy !== '',
                    onChange: function (event) {
                      setField('to', event.target.value)
                    },
                  }),
                ),
                h(
                  'label',
                  {
                    className: 'flr-check',
                    htmlFor: 'flr-autofetch',
                    title: '勾选后，打开工作台或切换学校会立即拉取数据；不勾选则只在点「获取数据」时联网。',
                  },
                  h('input', {
                    id: 'flr-autofetch',
                    type: 'checkbox',
                    checked: autoFetch,
                    disabled: busy !== '',
                    onChange: function (event) {
                      setAutoFetch(Boolean(event.target.checked))
                    },
                  }),
                  '打开时自动拉取',
                ),
                h(
                  'div',
                  { className: 'flr-actions' },
                  h(
                    'button',
                    { type: 'submit', className: 'flr-btn flr-btn--primary', disabled: busy !== '' },
                    busy === 'snapshot' ? '拉取中…' : '获取数据',
                  ),
                  h(
                    'span',
                    { className: 'flr-generate', role: 'group', 'aria-label': '生成报告' },
                    REPORT_MODES.map(function (item) {
                      const isPrimary = item.mode === 'full'
                      const isBusy = busy === BUSY_MODE_PREFIX + item.mode
                      return h(
                        'button',
                        {
                          key: item.mode,
                          type: 'button',
                          className: isPrimary ? 'flr-btn flr-btn--primary flr-btn--gen' : 'flr-btn flr-btn--ghost flr-btn--gen',
                          'data-mode': item.mode,
                          disabled: busy !== '' || !snapshot,
                          title: !snapshot ? '请先获取数据' : item.hint,
                          onClick: function () {
                            generateReport(item.mode)
                          },
                        },
                        isBusy ? item.busyButton : item.button,
                      )
                    }),
                  ),
                ),
              ),

              hints.length
                ? h('div', { className: 'flr-hints' }, hints)
                : boot.loading
                  ? h('div', { className: 'flr-hints' }, h('p', { className: 'flr-hint' }, '正在读取本机默认参数…'))
                  : null,
            ),

            error ? h(Alert, { tone: 'error', title: '出错了', message: error }) : null,
            notice ? h(Alert, { tone: 'warn', message: notice }) : null,
            busyText
              ? h(
                  'p',
                  { className: 'flr-inline-status', role: 'status' },
                  h('span', { className: 'flr-spinner', 'aria-hidden': 'true' }),
                  h('span', null, busyText),
                )
              : null,

            snapshot
              ? h(
                  'div',
                  null,
                  h(InfoBar, { items: infoItems }),
                  warnings.length
                    ? h(Alert, { tone: 'warn', title: '拉取数据时的提示', items: warnings })
                    : null,
                  report
                    ? h(ReportPanel, {
                        report: report,
                        statsText: reportStatsText(report.stats, report.mode || 'full'),
                        busy: busy !== '',
                        fileStatus: fileStatus,
                        onOpen: openFile,
                        onReveal: function (file) {
                          openFile(file, true)
                        },
                        onCopy: copyText,
                        onOpenDir: openDir,
                      })
                    : null,
                  h(TotalsSection, { totals: snapshot.totals }),
                  grades.length === 0
                    ? h(
                        'div',
                        { className: 'flr-empty' },
                        h('p', { className: 'flr-empty-title' }, '该统计区间没有年级数据'),
                        h('p', { className: 'flr-empty-text' }, '请调整统计区间后重新获取数据。'),
                      )
                    : h(
                        'div',
                        null,
                        h(
                          'div',
                          { className: 'flr-tabs', role: 'tablist', 'aria-label': '选择年级' },
                          grades.map(function (grade) {
                            const selected = activeGrade && grade.gradeId === activeGrade.gradeId
                            return h(
                              'button',
                              {
                                key: String(grade.gradeId),
                                type: 'button',
                                role: 'tab',
                                'aria-selected': selected ? 'true' : 'false',
                                className: 'flr-tab',
                                onClick: function () {
                                  selectGrade(grade.gradeId)
                                },
                              },
                              h('span', { className: 'flr-tab-name' }, grade.gradeName || '—'),
                              h(
                                'span',
                                { className: 'flr-tab-level' },
                                (grade.levelName || '') +
                                  (grade.summary ? ' · 完成率 ' + fmtPercent(grade.summary.finishPercent) : ''),
                              ),
                            )
                          }),
                        ),
                        activeGrade ? h(GradeSection, { grade: activeGrade }) : null,
                      ),
                )
              : busy === 'snapshot'
                ? h(LoadingState, { text: '正在从学校站点拉取管理看板数据，请稍候…' })
                : h(EmptyState, { bound: schools.length > 0 }),

            h(HistorySection, {
              reports: history,
              busy: busy !== '',
              fileStatus: fileStatus,
              onOpen: openFile,
              onReveal: function (file) {
                openFile(file, true)
              },
              onCopy: copyText,
              onRevealDir: revealDir,
            }),
          ),
        ),
      )
    }

    function bindingsFileHint(defaults) {
      return Boolean(defaults && defaults.bindingsFile)
    }

    function reportStatsText(stats, variant) {
      const title = VARIANT_TITLE[variant || 'full'] || '正式版'
      if (!stats || typeof stats !== 'object') return title
      const parts = []
      const gradeCount = toFiniteNumber(stats.gradeCount)
      if (gradeCount !== null) parts.push(fmtInt(gradeCount) + ' 个年级')
      const sectionCount = toFiniteNumber(stats.sectionCount)
      if (sectionCount !== null) parts.push(fmtInt(sectionCount) + ' 个章节')
      const taskCount = toFiniteNumber(stats.taskCount)
      if (taskCount !== null) parts.push('任务 ' + fmtInt(taskCount))
      const questionCount = toFiniteNumber(stats.questionCount)
      if (questionCount !== null) parts.push('习题 ' + fmtInt(questionCount))
      return title + (parts.length ? ' · 包含 ' + parts.join(' · ') : '')
    }

    // ---------------------------------------------------------------- 插件注册

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: function () {
                return '教学数据报告'
              },
            },
            PanelIcon,
          )
        })
        ctx.slots.inject('main', function () {
          return ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
            },
            ReportPage,
          )
        })
      },
    }
  },
})
