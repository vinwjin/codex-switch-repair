# codex-switch-repair

> 审计并修复 [cc-switch](https://github.com/farion1231/cc-switch) 与 [Codex](https://openai.com/codex) 之间配置同步问题的命令行维护工具。

## 这是什么

[cc-switch](https://github.com/farion1231/cc-switch) 通过改写 `~/.codex/config.toml` 与 `auth.json` 来切换 Codex 的 provider。在多 provider、带通用配置片段（插件 / MCP / marketplace 等共享 section）的场景下，切换有时会留下两类不一致：

- **config.toml 漂移** —— live 配置丢失了本应共享的 section，或出现重复表头、结构损坏。
- **登录态错位** —— `auth.json` 的登录态（ChatGPT / API Key）与当前 active provider 对不上。

这些问题往往要手动比对 TOML 和数据库才能定位，容易出错。本工具把这件事自动化：**先审计、后修复**——先用中文报告当前同步状态，再给出推荐修复项，确认后才写入，且写入前一定先备份。

## 解决什么问题

- 一眼看清 live config.toml、通用配置片段、auth.json 三者当前是否同步。
- 把漂移的 config.toml 非破坏式地修复回应有状态。
- 把错位的 auth.json 登录态校准回与当前 provider 一致。
- 全过程可备份、可回滚、不泄露任何凭据。

## 核心特性

- **内容驱动判定** —— 靠 `auth.json` 内容识别登录态，而非 provider 名称，重命名 provider 不会误判。
- **非破坏式修复** —— 以现有 live 配置为基底，只补回缺失的共享 section，去重合并，保留 `[model_providers.custom]` 等本地独有内容，绝不整体推倒重建。
- **写前必备份** —— 写入前把 `config.toml` / `auth.json` / `cc-switch.db` 备份到外部目录，附带脱敏 manifest，可随时回滚。
- **脱敏输出** —— 任何屏幕输出、备份记录都不含 API key / token / cookie / 完整 `auth.json`。
- **运行时保护** —— 检测到 Codex 或 cc-switch 正在运行时，写操作默认禁用，避免与应用抢写。
- **零额外依赖** —— 只需 Node.js（使用内置 `node:sqlite` 读取数据库），无需 `npm install`，无需编译原生模块。

## 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | **>= 22.5** | 使用内置 `node:sqlite`，无需安装任何 npm 包 |
| Windows PowerShell | 5.1+ | 系统自带 |

启动时会自动预检 Node 版本，缺失或过低会给出中文安装 / 升级指引，而非抛错。

## 使用

```powershell
.\tools\repair-codex-switch-sync.ps1
```

推荐在关闭 Codex 和 cc-switch 后运行。工具会先审计并展示状态，列出推荐修复项；任何写入都需显式确认，并在写入前完成备份。

默认读取标准路径，可按需覆盖：

```powershell
.\tools\repair-codex-switch-sync.ps1 `
  -CodexHome    "$env:USERPROFILE\.codex" `
  -DatabasePath "$env:USERPROFILE\.cc-switch\cc-switch.db" `
  -BackupRoot   "D:\backups\codex"
```

## 设计原则

- 用 `settings_config.auth` 内容识别 `chatgpt` / `api_key` / `unknown`，不依赖 provider 名称。
- 以 `common_config_codex` 作为**动态**通用片段基准，不内置任何固定模板。
- 修复 config.toml 采用 backfill：保留 live 独有内容、去重合并、不产生重复表头。
- 不写死任何本机 runtime hash、插件数量、marketplace 数量或 MCP 名称——换机器照样可用。
- 凭据零泄露：不打印、不写入备份 manifest。

## 测试

```bash
npm test          # 24 个用例：单元 + 端到端沙箱
npm run test:unit # 仅单元测试
npm run test:e2e  # 仅端到端（合成 cc-switch.db + 合成 .codex）
```

全部测试使用合成数据，绝不触碰真实配置。

## 工程结构

```
tools/
  repair-codex-switch-sync.ps1        # 交互式入口（菜单 / 确认 / 进程检测）
  repair-codex-switch-sync-core.js    # 纯 Node 核心（审计 / 修复 / 备份 / 恢复）
  repair-codex-switch-sync-tests.js   # 单元测试
  repair-codex-switch-sync-e2e.js     # 端到端沙箱测试
```

## 路线图

核心 `core.js` 已是跨平台纯 Node；交互层目前为 PowerShell（仅 Windows）。计划用 Node 重写交互层并提供 `bin`，实现 `npx codex-switch-repair` 全平台一条命令运行。

## 许可证

[MIT](./LICENSE)
