# backup-codex-config.ps1
# 一键备份 Codex config.toml + auth.json
# 用法: powershell -File backup-codex-config.ps1 [-Reason "pre-patch"]

param(
  [string]$Reason = "manual"
)

$ErrorActionPreference = "Stop"

$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$prefix = "config.toml.bak-$ts-$Reason"

$targets = @(
  @{ Path = "$env:USERPROFILE\.codex\config.toml"; Dest = "$env:USERPROFILE\.codex\$prefix" },
  @{ Path = "$env:USERPROFILE\.codex\auth.json";   Dest = "$env:USERPROFILE\.codex\auth.json.bak-$ts-$Reason" }
)

foreach ($t in $targets) {
  if (Test-Path $t.Path) {
    Copy-Item $t.Path $t.Dest -Force
    $size = (Get-Item $t.Dest).Length
    Write-Host "OK: $($t.Dest) ($size bytes)" -ForegroundColor Green
  } else {
    Write-Warning "MISSING: $($t.Path)"
  }
}

Write-Host ""
Write-Host "Backup complete. Files:" -ForegroundColor Cyan
Get-ChildItem "$env:USERPROFILE\.codex\*.bak-$ts-*" | Format-Table Name, Length, LastWriteTime -AutoSize | Out-String | Write-Host
