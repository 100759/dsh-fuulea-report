# 教学数据报告（dsh-fuulea-report）

DeepSeek Harness 工作台插件：从**辅立码课 / 智慧教学云**学校站点拉取「管理看板」数据，一键生成三届
（2024/2025/2026 级）教学数据报告。支持任意学校子域名；账号只在本机保存一次，之后打开工作台
自动登录，并可在已绑定的多所学校之间切换。

- 仓库：<https://github.com/100759/dsh-fuulea-report>
- 安装：`dsh plugin --profile <你的 profile> add github:100759/dsh-fuulea-report`（或在插件管理里填这个 git 地址）
- 更新：页面右上角的版本徽标在**有新版本时显示红点**，点开可直接「立即更新」；也可执行上面的安装命令（git 依赖每次都会取最新提交），更新后重启 DeepSeek Harness 生效。

## 安装

```bash
# 1) 装到你的 DSH profile（示例用 desktop；web 端就换成 --profile web）
dsh plugin --profile desktop add github:100759/dsh-fuulea-report
```

插件自带 `cordis.patch.yml`，安装后会自动在 profile 里插入 `fuulea-report` 这一行；
若插件管理里显示为未启用，手动启用一次即可。重启 DeepSeek Harness 后，工作台左侧出现
「教学数据报告」入口。

> 只想用本地源码调试：`dsh plugin --profile desktop add link:/path/to/dsh-fuulea-report`
> （link 安装时页面上的「立即更新」不可用，改为直接改源码）。

## 版本与更新

- 页面右上角显示当前版本（如 `v1.4.0`）；Host 每 10 分钟最多查一次 GitHub 上的最新版本。
- **有新版本时**：徽标变成红色并带一个跳动的红点，下方自动展开一条升级提示，含
  「立即更新 / 检查更新 / 查看更新说明」。
- 点「立即更新」会在本机 profile 里执行 `pnpm add github:100759/dsh-fuulea-report`
  （即重新拉到最新提交），完成后提示**重启 DeepSeek Harness** 让新版本生效；
  重启前版本面板会显示「已更新到 vX，重启 Harness 后生效」，红点同时消失。
- 关闭联网检查：在 `cordis.patch.yml` 的 config 里加 `checkUpdates: false`（内网或合规环境）；
  换仓库地址用 `repository: owner/repo`。

## 功能

- 工作台左侧新增「教学数据报告」入口，点击进入整页工作台。
- **学校绑定与切换**：首次填写学校子域名 + 账号密码（或使用本机已保存凭据），取数成功后账号写入
  本机绑定存储；之后打开页面自动登录并自动取数，不再需要输入账号密码。
  - 下拉框列出所有已绑定学校，可一键切换（切换后自动取数）；
  - 「＋ 绑定其他学校…」新增绑定；「更换账号」更新账号密码；「解除绑定」删除某所学校的本机凭据。
- 统计区间快捷选择（近 7 / 14 / 30 天）与自定义起止日期。
- 页面展示：三届合计概览、分年级指标卡、学科统计表、教师统计表、自学数据表。
- **三种导出模式**（工具栏三颗按钮，各自独立生成，互不覆盖）：

  | 版本 | 用途 | 产出文件 | 命名 |
  | --- | --- | --- | --- |
  | **正式版** | 送审/归档的完整公文报告（封面、目录、逐届三章、总结、口径附录） | Markdown、可打印 HTML、Word（.docx）、PDF | `<学校>教学数据报告(<起>~<止>).md/.html/.docx/.pdf` |
  | **简报版** | 领导 5 分钟读完的速览（1~2 页，对齐《使用情况简报》体例） | Word（.docx）、PDF | `<学校>使用简报(<起>~<止>).docx/.pdf` |
  | **交互版** | 数据图像化、可在浏览器里点选查看的单文件报告 | 单文件 HTML（图表可交互） | `<学校>交互数据报告(<起>~<止>).html` |

  全部写到 `<报告目录>/<学校>/<起止>/`，同一区间三种版本共存、互不覆盖。
- **简报版**：纯文字密排，每届 1 页；总述（任务/习题/完成率/阅卷率/得分率 + 自学/观看/重练/靶向）→
  学科方面（使用较全面、错题重练较好、阅卷率较高、完成率较高、完成率/阅卷率偏低、学生自批为主、
  整周未布置作业）→ 教师层面（使用全面、重练突出、靶向突出、使用量偏少）→ 提升与建议（每条带具体
  学科与数字）。阈值集中在 `lib/brief.js` 顶部 `BRIEF` 常量，可按校调整。
- **交互版**：单文件 HTML，零外部资源（无 CDN、无字体、无图片），双击即可离线打开：
  顶部 KPI 卡；① 三届对比 ② 学科雷达（最多同屏 4 科）③ 学科排序（指标可切换）
  ④ 可排序学科明细表 ⑤ 教师散点（完成率 × 师阅率，半径=任务量）⑥ 教师排行 ⑦ 自学与观看堆叠。
  年级 Tab 可切换、图例可点选显隐、悬停有数值气泡；深色模式自适应；`@media print` 隐藏交互控件。
- **报告文件打开**：报告行提供「打开 PDF / 打开 HTML / 打开 MD」——由 Host 调用系统默认应用
  （macOS `open`、Windows `explorer`、Linux `xdg-open`）打开，不依赖浏览器弹窗，不会「点了没反应」；
  另有「在访达中显示」「复制路径」「打开文件夹」。
- **历史报告**：自动扫描报告目录，列出最近生成的报告并按版本（正式版/简报版/交互版）分组标注，
  可直接打开，无需重新取数；历史目录里的老报告也会按文件名自动归类。

## 数据来源（全部只读 GET，不写平台数据）

| 接口 | 用途 |
| --- | --- |
| `POST /v2/auth/login/` | 账号密码登录，取 JWT（约 24 小时有效，插件内自动续期） |
| `GET /v2/dashboard/export/` | 「教学统计」xlsx：学科基本教学 / 教师教学详情 / 班级学习行为 三张表 |
| `GET /v2/dashboard/teach/` | 学情总览 JSON：学科自学（人次/题量）与视频观看（人次/时长）分组 |

平台 `/v2` 接口需要 `Authorization: jwt <token>`、`uuid`、`fl-sec-sign` 三个请求头，签名算法是
murmurhash3_x64_128（见 `lib/murmur3.js`、`lib/api.js`）。

## 本机保存了什么

绑定存储在 `~/.fuulea-report/bindings.json`（目录 `0700`、文件 `0600`，可用配置 `bindingsFile` 或
环境变量 `FUULEA_BINDINGS_FILE` 改位置）：

```json
{
  "version": 2,
  "lastSchool": "demo",
  "lastRange": { "from": "2026-10-08", "to": "2026-10-21" },
  "schools": {
    "demo": {
      "alias": "demo",
      "baseUrl": "https://demo.fuulea.com",
      "siteTitle": "示例中学",
      "username": "demo-admin",
      "password": "……",
      "token": "……",
      "tokenExpiresAt": 1790000000000,
      "user": { "siteId": 1, "chargedGradeIds": [1, 2, 3] },
      "boundAt": "…", "lastUsedAt": "…"
    }
  }
}
```

- 密码为**明文本机保存**（与既有「技能包凭据文件」做法一致），只写本机、不写日志、不上传；
  页面与接口只回显账号脱敏值（如 `de*****n`），不回传密码。
- 令牌未过期（>2 分钟）且保存了登录用户信息时直接复用令牌，否则自动用保存的密码重新登录。

## 配置（`cordis.patch.yml` 的 config，均可省略）

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `defaultSchool` | `lyyz` | 首次使用（尚未绑定任何学校）时的默认学校子域名 |
| `bindingsFile` | `~/.fuulea-report/bindings.json` | 学校绑定存储路径 |
| `credentialsFile` | `~/.workbuddy/skills/fuulea-teaching-cloud/scripts/.credentials` | 兼容旧凭据文件（`别名\|账号\|密码`） |
| `outputDir` | `<用户主目录>/辅立码课数据报告` | 报告输出目录（也可用环境变量 `FUULEA_REPORT_DIR`） |
| `chromePath` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | HTML→PDF 用的浏览器 |
| `defaultDays` | `14` | 页面默认统计天数（截止到昨天） |
| `requestTimeoutMs` | `90000` | 单次接口超时 |
| `pdfTimeoutMs` | `45000` | PDF 打印超时 |
| `repository` | `100759/dsh-fuulea-report` | 检查更新所用的 GitHub 仓库（`owner/repo`） |
| `checkUpdates` | `true` | 是否联网检查新版本；`false` 则只显示当前版本、不请求 GitHub |

凭据优先级：本次页面填写的账号密码 > 本机绑定 > 兼容凭据文件。

## Agent 工具

插件还注册了一个只读工具 `fuulea_teaching_report`：`action=preview` 取数返回三届概览，
`action=generate` 生成报告文件；`mode` 选择版本（`full` 正式版 / `brief` 简报版 /
`interactive` 交互版，默认 `full`）。与页面共用同一套 Host 逻辑（含本机绑定），方便在对话里直接说
「帮我生成 demo 学校 10 月 8 日到 21 日的报告」「给我一份这周的简报」「生成交互版数据报告」。

## Host 接口（本机同源）

| 方法 / 路径 | 说明 |
| --- | --- |
| `GET  /fuulea-report/api/defaults` | 默认学校/日期/输出目录/Chrome 可用性 + 已绑定学校列表（不含密码） |
| `POST /fuulea-report/api/bind` | 验证账号密码并保存绑定（`school`、`username`、`password`） |
| `POST /fuulea-report/api/unbind` | 解除某所学校的绑定（`school`） |
| `POST /fuulea-report/api/snapshot` | 取数，返回报告模型（缓存 10 分钟）；带账号密码成功时自动绑定 |
| `POST /fuulea-report/api/report` | 生成报告文件（`mode` = full/brief/interactive，默认 full；`formats` 按版本取值：full = markdown/html/pdf/docx、brief = docx/pdf、interactive = html） |
| `GET  /fuulea-report/api/reports` | 扫描报告目录，返回最近报告及其打开地址 |
| `POST /fuulea-report/api/open` | 用系统默认应用打开报告（`path`；`reveal: true` 为在文件管理器中定位） |
| `GET  /fuulea-report/api/file?path=<相对路径>` | 直接读取报告文件（浏览器兜底打开/下载） |
| `GET  /fuulea-report/api/update-check` | 检查 GitHub 上的最新版本（`?force=1` 跳过 10 分钟缓存）；返回 `current/latest/updateAvailable/source` |
| `POST /fuulea-report/api/update` | 从 GitHub 重新安装到本机 profile（仅 `source=github` 可用），返回 `from/to/restartRequired` |

## 目录

```
index.js          Host 半边：HTTP 路由、绑定、登录取数编排、写文件、Chrome 打 PDF、系统打开
client.js         Client 半边：sidebar.panellist 入口 + main 整页工作台
lib/bindings.js   学校绑定存储（本机凭据 + 令牌，0600）
lib/api.js        登录 + fl-sec-sign 签名 + 下载
lib/murmur3.js    murmurhash3 x64 128
lib/xlsx.js       零依赖 xlsx 读取（只读单元格值）
lib/data.js       数据清洗与报告模型（含口径计算）
lib/report.js     正式版渲染（Markdown / HTML / 调度 Word）
lib/brief.js      简报版：doc 模型 + 文案规则（阈值集中在顶部 BRIEF 常量）+ 简报 HTML
lib/interactive.js 交互版：单文件 HTML，自绘 SVG（bar/barH/radar/scatter/stack），内联数据与脚本
lib/docx.js       Word 渲染与 OOXML 打包（零依赖；含正式版公文版式与简报版密排版式）
lib/charts.js     正式版与简报版的内联 SVG 图表
lib/updater.js    版本检查与一键更新（读 GitHub package.json、比较版本、跑 pnpm 重新安装）
```

## 更新检查是怎么做的

- 当前版本读的是安装目录里 `package.json` 的 `version`，不在代码里硬编码。
- 最新版本读 `https://raw.githubusercontent.com/<repository>/HEAD/package.json`（只用 GET，不带凭据），
  结果缓存 10 分钟；网络失败只在版本面板里显示原因，不影响取数与生成报告。
- 判断「能否一键更新」看本机 profile 的 `package.json` 里这个包是怎么装的：
  `github:` → 可以；`link:` / `file:` → 页面提示改源码；其它 → 提示手动命令。
- 更新就是在本机 profile 目录执行 `pnpm add github:<repository>`，git 依赖每次都会解析到最新提交；
  写完新文件后需要重启 DeepSeek Harness，运行中的进程才会加载新模块。

## 自测

```bash
node scripts/verify-host.mjs          # Host 路由全链路（真实登录一次，只写临时目录）
node scripts/client-smoke.mjs         # Client 渲染 / 交互冒烟（无需浏览器）
node scripts/render-test.mjs          # 正式版渲染 → out/report.md + out/report.html + out/report.docx
node scripts/verify-all.mjs           # 三版全量验收（语法 / 渲染 / 简报 PDF / 交互版浏览器渲染）
```

`verify-all.mjs` 覆盖 34 项检查：全部源文件 `node --check`；正式版 md/html/docx 产出与「百分比一律
1 位小数」；简报 docx 合法性与「无 NaN/undefined」；简报 HTML 覆盖三个年级且含「提升与建议」；
简报 PDF 用 LibreOffice 转出后校验页数（3 届 ≤6 页）与关键文本；交互版 HTML 无外部资源、内联数据可
解析、内联脚本可 `--check`、无头 Chrome 渲染出全部 SVG 图表且教师散点/排行非空态、各宽度无重叠与
越界。

> 仓库**不包含** `sample-model.json`（真实学校看板数据）。渲染类检查需要它，先在本机生成：

```bash
node scripts/test-data.mjs lyyz 2026-10-08 2026-10-21   # 用本机已保存的凭据拉一次真实数据
```

缺少该文件时，`verify-all.mjs` 只跑语法与结构检查，并打印上面这行提示后正常退出。

## 报告口径（写进报告附录，便于复核）

- 任务量 / 习题量：各学科合计（平台导出「学科基本教学」表）。
- 资料任务占比 = 1 − 习题任务数 ÷ 任务量。
- 日均任务 = 任务量 ÷ 天数；日均班均 = 任务量 ÷（天数 × 行政班数）。
- 任务平均完成率 = 各学科完成率按任务量加权；得分率 = 各学科得分率按习题量加权。
- 师阅率均值 = 各学科师阅率的简单平均（忽略空值）。
- 观看时长为平台的「时:分」口径（如 83:11 ≈ 83.2 小时）。
- 地理等整周未布置任务的学科，报告中标注「缺失」而非计 0。

## 说明

- 只读：不发布任务、不改成绩、不写平台数据。
- 报告数据来自学校站点实时接口，与平台「管理看板」页面同源，可能因统计截止时间不同而与历史报告有少许差异。
