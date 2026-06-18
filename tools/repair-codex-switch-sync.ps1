param(
  [string]$CodexHome = "$env:USERPROFILE\.codex",
  [string]$DatabasePath = "$env:USERPROFILE\.cc-switch\cc-switch.db",
  [string]$BackupRoot = "$env:TEMP\cc-switch-codex-repair",
  [int]$KeepBackups = 5,
  [switch]$AllowRunningProcesses
)

$ErrorActionPreference = "Stop"

# Windows 控制台默认代码页（中文系统为 936/GBK）会把 Node 输出的 UTF-8
# stdout 按 GBK 解码，导致 JSON 中文字符串尾部被破坏、ConvertFrom-Json 报红字。
# 强制按 UTF-8 解码子进程输出，并按 UTF-8 渲染中文菜单。
try {
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
  # 某些受限主机不允许改 Console 编码，忽略即可，后续仍可正常工作。
}

function Write-Section($Title) {
  Write-Host ""
  Write-Host "── $Title ──" -ForegroundColor Cyan
  Write-Host ""
}

function Clear-Screen {
  try { Clear-Host } catch { }
}

function Show-Header {
  Clear-Screen
  Write-Host ""
  Write-Host "  ╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
  Write-Host "  ║      Codex / cc-switch 配置维护助手           ║" -ForegroundColor Cyan
  Write-Host "  ╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
  Write-Host ""
}

function Pause-Return {
  Write-Host ""
  Read-Host "按回车返回主菜单" | Out-Null
}

function Write-Kv($Key, $Value, $Color = "Gray") {
  Write-Host ("    {0,-22}" -f $Key) -NoNewline -ForegroundColor DarkGray
  Write-Host $Value -ForegroundColor $Color
}

function Find-Node {
  $candidates = @("node")
  foreach ($candidate in $candidates) {
    try {
      $cmd = Get-Command $candidate -ErrorAction Stop
      return $cmd.Source
    } catch {
      if (Test-Path $candidate) { return $candidate }
    }
  }
  return $null
}

# 依赖预检：唯一硬依赖是 Node.js（含内置 node:sqlite，需 >= 22.5）。
# 缺失或版本过低时给出明确的中文安装/升级指引，而不是抛红字。
function Test-Dependencies {
  $node = Find-Node
  if (-not $node) {
    Write-Host ""
    Write-Host "未检测到 Node.js。" -ForegroundColor Red
    Write-Host "本脚本需要 Node.js >= 22.5（使用其内置 node:sqlite 读取 cc-switch.db，无需额外 npm 安装）。"
    Write-Host "请前往 https://nodejs.org/ 下载安装 LTS（>=22.5），安装后重新运行本脚本。" -ForegroundColor Yellow
    return $null
  }

  $versionRaw = (& $node -v) 2>$null   # 形如 v22.22.2
  $version = $versionRaw -replace '^v', ''
  $parts = $version.Split('.')
  $major = [int]$parts[0]
  $minor = if ($parts.Length -gt 1) { [int]$parts[1] } else { 0 }

  $okVersion = ($major -gt 22) -or ($major -eq 22 -and $minor -ge 5)
  if (-not $okVersion) {
    Write-Host ""
    Write-Host "Node.js 版本过低：当前 $versionRaw，需要 >= 22.5。" -ForegroundColor Red
    Write-Host "node:sqlite 在 Node 22.5 才稳定可用。请升级 Node.js 后重试：https://nodejs.org/" -ForegroundColor Yellow
    return $null
  }

  return @{ Path = $node; Version = $versionRaw }
}

function Test-AppProcesses {
  $codex = @(Get-Process -Name "Codex","codex" -ErrorAction SilentlyContinue)
  $ccSwitch = @(Get-Process | Where-Object { $_.ProcessName -match "cc-switch" })
  return @{
    CodexRunning = $codex.Count -gt 0
    CcSwitchRunning = $ccSwitch.Count -gt 0
  }
}

function Convert-StatusZh($Status) {
  switch ($Status) {
    "healthy" { "健康" }
    "repairable" { "可修复" }
    "broken" { "损坏" }
    "missing" { "不存在" }
    "matched" { "一致" }
    "mismatched" { "不一致" }
    "unknown" { "无法判断" }
    "chatgpt" { "ChatGPT 官方登录态" }
    "api_key" { "API Key" }
    default { $Status }
  }
}

function New-Payload($Processes) {
  return ([pscustomobject]@{
    codexHome = $CodexHome
    databasePath = $DatabasePath
    backupRoot = $BackupRoot
    keepBackups = $KeepBackups
    allowRunningProcesses = [bool]$AllowRunningProcesses
    processes = $Processes
  } | ConvertTo-Json -Compress)
}

function Invoke-Core($Command, $Payload) {
  $payloadArg = "base64:" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Payload))
  $output = & $script:NodePath $script:CorePath $Command $payloadArg
  if ($LASTEXITCODE -ne 0) {
    throw ($output -join "`n")
  }
  return ($output -join "`n")
}

function Convert-CoreJson($JsonText) {
  $text = [string]::Join("`n", @($JsonText))
  return $text | ConvertFrom-Json
}

function Get-Audit($Processes) {
  $json = Invoke-Core "audit" (New-Payload $Processes)
  return Convert-CoreJson $json
}

function Get-StatusColor($Status) {
  switch ($Status) {
    "healthy" { "Green" }
    "matched" { "Green" }
    "repairable" { "Yellow" }
    "mismatched" { "Yellow" }
    "missing" { "Yellow" }
    "broken" { "Red" }
    "unknown" { "DarkGray" }
    default { "Gray" }
  }
}

function Show-MainMenu($Audit) {
  Write-Section "当前状态"
  Write-Kv "当前 Provider" $Audit.activeProvider.name "White"
  Write-Kv "Provider 登录态" (Convert-StatusZh $Audit.activeProvider.authType) (Get-StatusColor $Audit.activeProvider.authType)
  Write-Kv "live config.toml" (Convert-StatusZh $Audit.liveConfig.status) (Get-StatusColor $Audit.liveConfig.status)
  Write-Kv "common_config_codex" (Convert-StatusZh $Audit.commonSnippet.status) (Get-StatusColor $Audit.commonSnippet.status)
  Write-Kv "auth.json" (Convert-StatusZh $Audit.authSync.status) (Get-StatusColor $Audit.authSync.status)
  Write-Kv "Codex 进程" $(if ($Audit.processes.codexRunning) { '运行中' } else { '已关闭' }) $(if ($Audit.processes.codexRunning) { 'Yellow' } else { 'Green' })
  Write-Kv "cc-switch 进程" $(if ($Audit.processes.ccSwitchRunning) { '运行中' } else { '已关闭' }) $(if ($Audit.processes.ccSwitchRunning) { 'Yellow' } else { 'Green' })

  Write-Section "推荐操作"
  if ($Audit.recommendedActionIds.Count -eq 0) {
    Write-Host "    当前没有推荐的自动修复项，配置看起来是健康的。" -ForegroundColor Green
  } else {
    foreach ($item in $Audit.recommendedActionIds) {
      Write-Host "    • $(Convert-ActionZh $item)" -ForegroundColor Yellow
    }
  }

  Write-Section "菜单"
  Write-Host "    [1] 执行推荐修复"
  Write-Host "    [2] 更新通用配置片段（从当前健康 config.toml 提取）"
  Write-Host "    [3] 选择登录态基准并校准"
  Write-Host "    [4] 查看详细审计"
  Write-Host "    [5] 备份 / 恢复"
  Write-Host "    [R] 重新审计"
  Write-Host "    [Q] 退出" -ForegroundColor DarkGray
  Write-Host ""
}

function Convert-ActionZh($ActionId) {
  switch ($ActionId) {
    "repair_live_config_from_active_provider_and_common" { "修复 live config.toml（补回缺失通用片段）" }
    "repair_auth_json_from_active_provider" { "修复 auth.json（与当前 Provider 登录态对齐）" }
    default { $ActionId }
  }
}

function Confirm-Write($Message) {
  Write-Host ""
  Write-Host $Message -ForegroundColor Yellow
  if (($script:Processes.CodexRunning -or $script:Processes.CcSwitchRunning) -and -not $AllowRunningProcesses) {
    Write-Host "检测到 Codex 或 cc-switch 正在运行。为避免运行时覆盖，本次写入已禁用。" -ForegroundColor Yellow
    return $false
  }
  if ($AllowRunningProcesses -and ($script:Processes.CodexRunning -or $script:Processes.CcSwitchRunning)) {
    Write-Host "你已允许在进程运行时写入；Codex/cc-switch 可能在修复过程中改写文件。" -ForegroundColor Yellow
  }
  Write-Host "备份目录：$BackupRoot"
  $answer = Read-Host "是否继续？输入 y 继续，其他键取消"
  return $answer -eq "y"
}

function Invoke-RecommendedRepair {
  $payload = New-Payload $script:Processes
  $preview = Convert-CoreJson (Invoke-Core "preview-recommended" $payload)
  Write-Section "修复预览"
  Write-Host $preview.textZh
  if (-not (Confirm-Write "将备份 config.toml、auth.json、cc-switch.db（存在时），然后执行推荐修复。")) { return }
  $result = Convert-CoreJson (Invoke-Core "apply-recommended" $payload)
  Write-Host $result.messageZh -ForegroundColor Green
  Write-Host "备份：$($result.backupDir)"
}

function Invoke-CaptureCommon {
  if (-not $script:Audit.commonCapture.allowed) {
    Write-Host $script:Audit.commonCapture.reasonZh -ForegroundColor Yellow
    return
  }
  if (-not (Confirm-Write "将从当前 live config.toml 捕获通用 section 并更新 common_config_codex。")) { return }
  $result = Convert-CoreJson (Invoke-Core "capture-common" (New-Payload $script:Processes))
  Write-Host $result.messageZh
  if ($result.backupDir) { Write-Host "备份：$($result.backupDir)" }
}

function Invoke-AuthBaseline {
  $providers = @($script:Audit.providers)
  if ($providers.Count -eq 0) {
    Write-Host "未检测到 Codex Provider。" -ForegroundColor Yellow
    return
  }

  Write-Section "登录态 Provider"
  for ($i = 0; $i -lt $providers.Count; $i++) {
    $mark = if ($providers[$i].active) { "（当前）" } else { "" }
    Write-Host "[$($i + 1)] $($providers[$i].name) - $(Convert-StatusZh $providers[$i].authType) $mark"
  }
  Write-Host "[0] 取消"
  $choice = Read-Host "请选择要校准到 live auth.json 的登录态 Provider"
  if ($choice -eq "0" -or [string]::IsNullOrWhiteSpace($choice)) { return }

  $selected = $providers[[int]$choice - 1]
  if (-not $selected) {
    Write-Host "选择无效。" -ForegroundColor Yellow
    return
  }

  $payloadObj = New-PayloadObject
  $payloadObj.providerIndex = [int]$choice
  $payloadObj.confirmMismatch = [bool](-not $selected.active)

  if (-not $selected.active) {
    Write-Host "所选 Provider 不是当前 active provider；这可能会让 auth.json 与 active provider 暂时不一致。" -ForegroundColor Yellow
  }
  if (-not (Confirm-Write "将把 live auth.json 校准到：$($selected.name)。不会打印密钥或 token 正文。")) { return }
  $result = Convert-CoreJson (Invoke-Core "apply-auth-baseline" ($payloadObj | ConvertTo-Json -Compress))
  Write-Host $result.messageZh
  Write-Host "备份：$($result.backupDir)"
}

function New-PayloadObject {
  return [pscustomobject]@{
    codexHome = $CodexHome
    databasePath = $DatabasePath
    backupRoot = $BackupRoot
    keepBackups = $KeepBackups
    allowRunningProcesses = [bool]$AllowRunningProcesses
    processes = $script:Processes
  }
}

function Invoke-BackupMenu {
  Write-Section "备份 / 恢复"
  Write-Host "[1] 立即创建备份"
  Write-Host "[2] 查看最近备份"
  Write-Host "[3] 从备份恢复 config.toml"
  Write-Host "[4] 从备份恢复 auth.json"
  Write-Host "[5] 从备份恢复 cc-switch.db"
  Write-Host "[0] 返回"
  $choice = Read-Host "请选择"

  if ($choice -eq "1") {
    if (-not (Confirm-Write "将创建只含文件副本和脱敏 manifest 的备份。")) { return }
    $result = Convert-CoreJson (Invoke-Core "backup" (New-Payload $script:Processes))
    Write-Host "备份已创建：$($result.backupDir)" -ForegroundColor Green
    return
  }

  if ($choice -eq "2") {
    Show-Backups
    return
  }

  $fileMap = @{ "3" = "config.toml"; "4" = "auth.json"; "5" = "cc-switch.db" }
  if (-not $fileMap.ContainsKey($choice)) { return }
  $backups = @(Get-Backups)
  if ($backups.Count -eq 0) {
    Write-Host "没有可用备份。" -ForegroundColor Yellow
    return
  }
  Show-Backups $backups
  $backupChoice = Read-Host "请选择备份编号，或输入 0 取消"
  if ($backupChoice -eq "0" -or [string]::IsNullOrWhiteSpace($backupChoice)) { return }
  $backup = $backups[[int]$backupChoice - 1]
  if (-not $backup) {
    Write-Host "选择无效。" -ForegroundColor Yellow
    return
  }

  $targetFile = $fileMap[$choice]
  Write-Host "将恢复：$targetFile"
  Write-Host "来源备份：$($backup.path)"
  if (-not (Confirm-Write "目标文件将被备份后替换。")) { return }
  $payload = New-PayloadObject
  $payload.backupDir = $backup.path
  $payload.file = $targetFile
  $result = Convert-CoreJson (Invoke-Core "restore" ($payload | ConvertTo-Json -Compress))
  Write-Host $result.messageZh -ForegroundColor Green
}

function Get-Backups {
  return Convert-CoreJson (Invoke-Core "list-backups" (New-Payload $script:Processes))
}

function Show-Backups($Backups = $null) {
  if ($null -eq $Backups) { $Backups = @(Get-Backups) }
  if ($Backups.Count -eq 0) {
    Write-Host "没有可用备份。"
    return
  }
  for ($i = 0; $i -lt $Backups.Count; $i++) {
    $manifest = $Backups[$i].manifest
    Write-Host "[$($i + 1)] $($Backups[$i].name) $($manifest.action) $($manifest.activeProvider.name) $($Backups[$i].path)"
  }
}

Show-Header

$dep = Test-Dependencies
if (-not $dep) {
  Write-Host ""
  Write-Host "依赖未就绪，已停止。修复依赖后请重新运行。" -ForegroundColor Red
  return
}

$script:NodePath = $dep.Path
$script:CorePath = Join-Path $PSScriptRoot "repair-codex-switch-sync-core.js"
$script:Processes = Test-AppProcesses

Write-Kv "Node.js" "$($dep.Version)  ($script:NodePath)" "Gray"
Write-Kv "CodexHome" $CodexHome "Gray"
Write-Kv "DatabasePath" $DatabasePath "Gray"
Write-Kv "BackupRoot" $BackupRoot "Gray"

if (($script:Processes.CodexRunning -or $script:Processes.CcSwitchRunning) -and -not $AllowRunningProcesses) {
  Write-Host ""
  Write-Host "  ⚠ 检测到 Codex 或 cc-switch 正在运行。写操作默认禁用；请关闭后再修复。" -ForegroundColor Yellow
}

Start-Sleep -Milliseconds 600

while ($true) {
  Show-Header
  $script:Processes = Test-AppProcesses
  $script:Audit = Get-Audit $script:Processes
  Show-MainMenu $script:Audit

  $choice = (Read-Host "  请选择").Trim()

  switch -Regex ($choice) {
    "^[Qq0]$" { Show-Header; Write-Host "  已退出。再见。" -ForegroundColor Cyan; Write-Host ""; return }
    "^[Rr]$"  { continue }
    "^1$"     { Invoke-RecommendedRepair; Pause-Return }
    "^2$"     { Invoke-CaptureCommon; Pause-Return }
    "^3$"     { Invoke-AuthBaseline; Pause-Return }
    "^4$"     {
      Write-Section "详细审计"
      Write-Host ($script:Audit | ConvertTo-Json -Depth 8)
      Pause-Return
    }
    "^5$"     { Invoke-BackupMenu; Pause-Return }
    default   { Write-Host "  无效选择：$choice" -ForegroundColor Yellow; Start-Sleep -Milliseconds 800 }
  }
}
