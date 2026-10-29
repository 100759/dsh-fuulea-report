# 更新日志

## 1.5.2

- **修复「立即更新」按钮变灰点不动**：判定只认 `github:` 前缀，用
  `git+https://github.com/...` 或 `https://github.com/...` 安装的用户被判成 `git`，
  按钮直接禁用。现在只要是「指向 GitHub 仓库」的写法都算 GitHub 安装
  （`github:` / `git+https://` / `https://github.com/` / `git+ssh://` / `owner/repo` 简写），
  由新增的 `parseGithubRepo()` 统一解析 owner/repo。
- 修复「变灰但不说原因」：原来禁用原因只写在按钮 `title` 上，而禁用按钮的 tooltip
  根本不会弹出。现在 `GET /update-check` 下发 `canUpdate` 与 `updateBlockedReason`，
  版本面板把原因作为正文直接显示，并给出可复制的 `dsh plugin add github:...` 命令。
- 客户端改为信任 Host 下发的 `canUpdate`，不再自己判断 `source === 'github'`
  （两边各判一套正是这次问题的来源）。
- 修复 Windows 上一键更新必定失败：`pnpm` 是 `.cmd` 批处理，Node 18+ 不再隐式套 shell，
  直接 `spawn` 会以 `EINVAL` 失败。现在 Windows 上显式 `shell: true` 并对含空格的
  路径（`C:\Program Files`、中文用户名）做引号化。
- `findPnpm()` 补齐 Windows 查找位置（`%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`、
  `%ProgramFiles%\nodejs`），并同时尝试 `pnpm.cmd` / `pnpm.exe` / `pnpm.bat`。
- 自测：`verify-host.mjs` 新增 8 种 GitHub 写法识别 + 5 种非 GitHub 写法不误判 +
  6 条安装源判定 + 4 条 update-check 字段校验；`client-smoke.mjs` 新增可更新/不可更新
  两种状态下的按钮禁用与提示可见性断言。

## 1.5.1

- **修复 Windows 上 PDF 生成失败**：`chromePath` 原来写死成 macOS 的
  `/Applications/Google Chrome.app/...`，在 Windows 上必然不存在，PDF 直接报
  「未找到 Chrome」。现在改为按平台自动探测，Windows 依次找 Chrome（Program Files /
  Program Files (x86) / LocalAppData）、系统自带 Edge、Brave，macOS 与 Linux 同样有候选清单；
  自动探测不到时仍可用 `chromePath` 手动指定绝对路径。
- 修复 `file://` 地址拼接：原代码用 `` `file://${htmlFile}` `` 拼字符串，Windows 路径会变成
  `file://C:\...`（非法 URL），且含中文/空格的目录不会被百分号编码。改用 `pathToFileURL()`。
- 修复「时好时坏」：Windows 上 Chrome/Edge 打印成功后仍可能返回非 0 退出码，原代码只认
  `code === 0`，会把成功的任务判成失败。现在以 PDF 是否真的落盘（>1KB）为准，并轮询等待
  异步写盘完成。
- 老版本浏览器不认 `--headless=new` 时自动退回 `--headless` 重试一次（超时不重试）。
- 生成前先删除同名旧 PDF，避免本次失败却因上次残留文件而被误判为成功。
- `GET /defaults` 的 `chromeAvailable` 改为实际探测结果，并新增 `chromePath` 字段回显；
  Windows 上没装 Chrome 但装了 Edge 时不再误报「未检测到 Chrome」。

## 1.5.0

- **默认不再自动拉取数据**：打开工作台只回填上次的学校与统计区间，点「获取数据」才联网取数；
  切换学校也改为只提示「点获取数据」，不再自动发一次 `/snapshot`。
- 工具栏新增「打开时自动拉取」勾选框：勾上即恢复旧行为（打开页面 / 切换学校直接取数），
  默认不勾选；勾选状态只影响当前页面会话。
- 新增 Host 配置 `autoFetch`（默认 `false`），`GET /defaults` 返回该值，页面据此决定勾选框初值；
  需要固定自动取数的部署在 `cordis.patch.yml` 里设 `autoFetch: true` 即可。
- 切换到另一所学校时先清掉上一所学校的数据，避免旧数据挂在新学校名下。
- 空状态新增提示「打开页面不会自动联网取数，需要点击『获取数据』才拉取」。
- 自测更新：`scripts/client-smoke.mjs` 覆盖「默认不取数 → 点获取数据取数 → 开关勾选后切换即取数」，
  共 41 项断言。

## 1.4.1

- 修复随包自测脚本：`scripts/client-smoke.mjs` 的 `client.js` 路径按仓库根解析；
  缺少 `sample-model.json` 时打印清晰提示并退出，不再抛 ENOENT。

## 1.4.0

- 一键更新后不再残留红点：版本比较改为「GitHub 最新版 vs 磁盘上已装的版本」，
  并新增 `restartPending` —— 已装好新版本但进程还跑着旧代码时，版本面板提示
  「已更新到 vX，重启 Harness 后生效」，红点消失。
- `GET /update-check` 新增 `runningVersion`（当前进程加载的版本）。

## 1.3.3

- 改进：检查更新优先走 GitHub contents API（实时），失败再退回 `raw.githubusercontent.com`。
  之前只用 raw，刚发布新版本时它的 CDN 缓存可能仍返回旧版本号，导致红点要等几分钟才出现。

## 1.3.2

- 修复：读取本机默认参数失败时，版本徽标也能显示当前版本（之前会显示 `v—`）。

## 1.3.1

- 修复：桌面端进程里没有 `DSH_PROFILE_DIR` / `DSH_PROFILE` 环境变量时，识别不到本机 profile，
  导致页面上「立即更新」被误判为不可用、版本面板显示「安装方式未知」。
  现在会从安装位置向上查找带 `dsh.profile` 的 profile 目录，再退回扫描 `~/.dsh/profiles/*`。

## 1.3.0

发布到 GitHub，供同事安装复用；新增版本检查与一键更新。

### 新增

- **版本检查**：页面右上角显示当前版本；Host 读取 GitHub 上 `package.json` 的版本号做比较，
  结果缓存 10 分钟。新增接口 `GET /fuulea-report/api/update-check`。
- **更新红点**：GitHub 上有新版本时，版本徽标变红并显示跳动的红点，下方自动展开升级提示条，
  含「立即更新 / 检查更新 / 查看更新说明」。
- **一键更新**：`POST /fuulea-report/api/update` 在本机 profile 里执行
  `pnpm add github:100759/dsh-fuulea-report`，完成后提示重启 DeepSeek Harness 生效。
  仅当本机以 GitHub 源安装时可用；`link:` 安装会提示直接改源码。
- 新配置项 `repository`（更新检查的仓库，默认 `100759/dsh-fuulea-report`）与
  `checkUpdates`（默认 `true`，内网可关）。
- `lib/updater.js`：版本比较、远程版本读取、安装来源识别、pnpm 更新执行。
- 仓库文件：`LICENSE`（MIT）、`.gitignore`、`CHANGELOG.md`。

### 变更

- 包名由 `@local/fuulea-report` 改为 `dsh-fuulea-report`，可直接从 GitHub 安装给他人复用。
- `package.json` 增加 `repository` / `homepage` / `bugs` / `keywords` / `engines` / `license`，
  `exports` 补 `./cordis.patch.yml` 与 `./package.json`。
- 版本号不再硬编码在 `index.js`：改为读取安装目录 `package.json` 的 `version`。
- 自测脚本随包分发（`scripts/`）；仓库不包含真实学校数据 `sample-model.json`，
  缺少该文件时 `verify-all.mjs` 只跑语法与结构检查并明确提示。

## 1.2.0

- 新增简报版（Word + PDF）与交互版（单文件可交互 HTML）两种导出，与正式版并存互不覆盖。
- 历史报告按版本分组，支持打开 / 在访达中显示 / 复制路径。

## 1.1.0

- 新增交互式数据看板（三届合计、年级切换、学科/教师/自学表格）。

## 1.0.0

- 首个版本：学校绑定与切换、管理看板取数、正式版报告（Markdown / HTML / Word / PDF）。
