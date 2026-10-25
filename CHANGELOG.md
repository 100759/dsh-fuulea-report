# 更新日志

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
