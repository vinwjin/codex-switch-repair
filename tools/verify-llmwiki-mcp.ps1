# verify-llmwiki-mcp.ps1
# 验证 llmwiki-main-vault MCP 入口可读
# 用法: powershell -File verify-llmwiki-mcp.ps1

$ErrorActionPreference = "Continue"

Write-Host "=== llmwiki-main-vault MCP verification ===" -ForegroundColor Cyan
Write-Host ""

# 1. Python 解释器
Write-Host "1. Python interpreter:" -ForegroundColor Yellow
$python = "E:\Documents\Obsidian Vault-LLM-Wiki-PoC\.venv\Scripts\python.exe"
if (Test-Path $python) {
  Write-Host "   EXISTS: $python" -ForegroundColor Green
  & $python --version
} else {
  Write-Host "   MISSING: $python" -ForegroundColor Red
  Write-Host "   Run setup in Obsidian Vault-LLM-Wiki-PoC venv"
}
Write-Host ""

# 2. MCP 入口脚本
Write-Host "2. MCP entry script:" -ForegroundColor Yellow
$mcpEntry = "E:\Documents\Obsidian Vault\tools\run-main-vault-llmwiki-mcp.py"
if (Test-Path $mcpEntry) {
  Write-Host "   EXISTS: $mcpEntry" -ForegroundColor Green
  $size = (Get-Item $mcpEntry).Length
  Write-Host "   Size: $size bytes"
} else {
  Write-Host "   MISSING: $mcpEntry" -ForegroundColor Red
}
Write-Host ""

# 3. config.toml 里的 MCP 块
Write-Host "3. config.toml MCP blocks:" -ForegroundColor Yellow
$cfg = "$env:USERPROFILE\.codex\config.toml"
if (Test-Path $cfg) {
  $llmwiki = Get-Content $cfg | Select-String -Pattern "^\[mcp_servers\.llmwiki"
  if ($llmwiki) {
    $llmwiki | ForEach-Object { Write-Host "   $($_.Line.Trim())" }
  } else {
    Write-Host "   NOT FOUND" -ForegroundColor Red
  }

  Write-Host ""
  Write-Host "   llmwiki command:" -ForegroundColor Yellow
  Get-Content $cfg | Select-String -Pattern "command.*llmwiki|command.*Obsidian" | ForEach-Object { Write-Host "   $($_.Line.Trim())" }
} else {
  Write-Host "   config.toml not found" -ForegroundColor Red
}
Write-Host ""

# 4. 实测启动 MCP（10 秒超时）
Write-Host "4. MCP test launch (10s timeout):" -ForegroundColor Yellow
if ((Test-Path $python) -and (Test-Path $mcpEntry)) {
  Write-Host "   Starting MCP server..."
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $python
  $psi.Arguments = '"' + ($mcpEntry -replace '"', '\"') + '"'
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  Start-Sleep -Seconds 3
  if (-not $proc.HasExited) {
    Write-Host "   MCP running (PID $($proc.Id))" -ForegroundColor Green
    Stop-Process -Id $proc.Id -Force
    Write-Host "   Stopped"
  } else {
    Write-Host "   MCP exited unexpectedly (code $($proc.ExitCode))" -ForegroundColor Red
    Write-Host "   stderr:"
    $proc.StandardError.ReadToEnd().Split([Environment]::NewLine) | Select-Object -Last 20 | ForEach-Object {
      if ($_) { Write-Host "     $_" }
    }
  }
} else {
  Write-Host "   SKIP (Python or MCP entry not found)"
}
Write-Host ""

# 5. WorkBuddy MCP 同步检查
Write-Host "5. WorkBuddy MCP config:" -ForegroundColor Yellow
$wbMcp = "$env:USERPROFILE\.workbuddy\mcp.json"
if (Test-Path $wbMcp) {
  $j = Get-Content $wbMcp -Raw -Encoding UTF8 | ConvertFrom-Json
  $servers = $j.mcpServers.PSObject.Properties | ForEach-Object { $_.Name }
  Write-Host "   mcpServers keys: $($servers -join ', ')"
  if ($servers -contains "llmwiki-main-vault") {
    Write-Host "   llmwiki-main-vault: present" -ForegroundColor Green
  } else {
    Write-Host "   llmwiki-main-vault: NOT IN WORKBUDDY" -ForegroundColor Yellow
  }
} else {
  Write-Host "   mcp.json not found" -ForegroundColor Red
}
Write-Host ""

Write-Host "=== Summary ===" -ForegroundColor Cyan
Write-Host "If all green, llmwiki-main-vault MCP is operational."
Write-Host "If red on Python, run venv setup in Obsidian Vault-LLM-Wiki-PoC."
Write-Host "If yellow on WorkBuddy, re-sync the MCP server config across tools."
