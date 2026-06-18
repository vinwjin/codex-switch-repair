# check-config-toml.ps1
# 检查 Codex config.toml 健康度
# 用法: powershell -File check-config-toml.ps1

$cfg = "$env:USERPROFILE\.codex\config.toml"

if (-not (Test-Path $cfg)) {
  Write-Error "config.toml not found: $cfg"
  exit 1
}

Write-Host "=== Codex config.toml health check ===" -ForegroundColor Cyan
Write-Host ""

# 1. SHA256 (参考值，Codex 运行后会因 pipe GUID 变化)
Write-Host "1. SHA256:" -ForegroundColor Yellow
$hash = (Get-FileHash $cfg -Algorithm SHA256).Hash
Write-Host "   $hash"
Write-Host "   Note: SHA256 changes when Codex rewrites pipe GUID. Use structural checks below for validation."
Write-Host ""

# 2. 文件大小
Write-Host "2. File size:" -ForegroundColor Yellow
$size = (Get-Item $cfg).Length
Write-Host "   $size bytes"
Write-Host "   Expected: ~4660 bytes (may vary slightly)"
Write-Host ""

# 3. 顶层 [tools.*] 块（应为 0——tools 审批应嵌套在 mcp_servers 下）
Write-Host "3. Top-level [tools.*] blocks (should be 0):" -ForegroundColor Yellow
$topTools = @(Get-Content $cfg | Select-String -Pattern '^\[tools\.' )
$topTools | ForEach-Object { Write-Host "   $($_.Line.Trim())" }
Write-Host "   Total: $($topTools.Count) (expected 0)" -ForegroundColor $(if ($topTools.Count -eq 0) { "Green" } else { "Red" })
Write-Host ""

# 4. 嵌套 mcp tools
Write-Host "4. Nested mcp_servers.*.tools.*:" -ForegroundColor Yellow
$nested = @(Get-Content $cfg | Select-String -Pattern '^\[mcp_servers\.[^.]+\.tools\.')
$nested | ForEach-Object { Write-Host "   $($_.Line.Trim())" }
Write-Host "   Total: $($nested.Count) (expected 3)" -ForegroundColor $(if ($nested.Count -eq 3) { "Green" } else { "Red" })
Write-Host ""

# 5. plugins
Write-Host "5. [plugins.*]:" -ForegroundColor Yellow
$plugins = @(Get-Content $cfg | Select-String -Pattern '^\[plugins\.')
$plugins | ForEach-Object { Write-Host "   $($_.Line.Trim())" }
Write-Host "   Total: $($plugins.Count) (expected 12)" -ForegroundColor $(if ($plugins.Count -eq 12) { "Green" } else { "Red" })
Write-Host ""

# 6. mcp_servers 总数
Write-Host "6. mcp_servers (all):" -ForegroundColor Yellow
$mcps = @(Get-Content $cfg | Select-String -Pattern '^\[mcp_servers\.')
$mcps | ForEach-Object { Write-Host "   $($_.Line.Trim())" }
Write-Host "   Total: $($mcps.Count) (expected 7: 2 servers + 2 env + 3 nested tools)" -ForegroundColor $(if ($mcps.Count -eq 7) { "Green" } else { "Red" })
Write-Host ""

# 7. marketplaces
Write-Host "7. [marketplaces.*]:" -ForegroundColor Yellow
$marketplaces = @(Get-Content $cfg | Select-String -Pattern '^\[marketplaces\.')
$marketplaces | ForEach-Object { Write-Host "   $($_.Line.Trim())" }
Write-Host "   Total: $($marketplaces.Count) (expected 3)" -ForegroundColor $(if ($marketplaces.Count -eq 3) { "Green" } else { "Red" })
Write-Host ""

# 8. tui
Write-Host "8. [tui.*]:" -ForegroundColor Yellow
$tuis = @(Get-Content $cfg | Select-String -Pattern '^\[tui\.')
$tuis | ForEach-Object { Write-Host "   $($_.Line.Trim())" }
Write-Host "   Total: $($tuis.Count) (expected 1)" -ForegroundColor $(if ($tuis.Count -eq 1) { "Green" } else { "Red" })
Write-Host ""

# 9. duplicate key 检查 (Node.js)
Write-Host "9. duplicate key check (Node.js):" -ForegroundColor Yellow
$tempScript = Join-Path $env:TEMP "check-toml-dup-$(Get-Random).js"
@"
const fs = require('fs');
const txt = fs.readFileSync(process.argv[1], 'utf8');
const lines = txt.split('\n');
const keys = {};
const dups = [];
lines.forEach((l, i) => {
  const m = l.match(/^\[([^\]]+)\]/);
  if (m) {
    const k = m[1];
    if (keys[k] !== undefined) dups.push('line ' + (i+1) + ' dup [' + k + '] (first at line ' + keys[k] + ')');
    else keys[k] = i+1;
  }
});
if (dups.length) {
  console.log('!!! DUPLICATE:');
  dups.forEach(d => console.log('  ' + d));
  process.exit(1);
} else {
  console.log('OK: no duplicate key');
}
"@ | Set-Content $tempScript -Encoding UTF8

$nodePath = "node"   # 使用 PATH 中的 node（需 Node >= 22.5）
if (Get-Command $nodePath -ErrorAction SilentlyContinue) {
  & $nodePath $tempScript $cfg
  if ($LASTEXITCODE -ne 0) { Write-Host "   FAIL" -ForegroundColor Red }
  else { Write-Host "   PASS" -ForegroundColor Green }
} else {
  Write-Host "   SKIP (未找到 node，需 Node >= 22.5)" -ForegroundColor Yellow
}
Remove-Item $tempScript -Force -ErrorAction SilentlyContinue
Write-Host ""

# 10. bundled marketplace 路径可读（.tmp 副本，非 WindowsApps）
Write-Host "10. bundled marketplace path (.tmp):" -ForegroundColor Yellow
$bundledPath = "$env:USERPROFILE\.codex\.tmp\bundled-marketplaces\openai-bundled\plugins"
if (Test-Path $bundledPath) {
  Write-Host "    EXISTS: $bundledPath" -ForegroundColor Green
  $bPlugins = Get-ChildItem $bundledPath -Directory | Select-Object Name
  $bPlugins | ForEach-Object { Write-Host "      - $($_.Name)" }
  if ($bPlugins.Count -ne 4) {
    Write-Host "    Expected 4 plugins, got $($bPlugins.Count)" -ForegroundColor Yellow
  }
} else {
  Write-Host "    MISSING: $bundledPath" -ForegroundColor Red
}
Write-Host ""

# 11. primary marketplace 路径可读
Write-Host "11. primary marketplace path:" -ForegroundColor Yellow
$primaryPath = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\plugins\openai-primary-runtime\plugins"
if (Test-Path $primaryPath) {
  Write-Host "    EXISTS: $primaryPath" -ForegroundColor Green
  $pPlugins = Get-ChildItem $primaryPath -Directory | Select-Object Name
  $pPlugins | ForEach-Object { Write-Host "      - $($_.Name)" }
  if ($pPlugins.Count -ne 4) {
    Write-Host "    Expected 4 plugins, got $($pPlugins.Count)" -ForegroundColor Yellow
  }
} else {
  Write-Host "    MISSING: $primaryPath" -ForegroundColor Red
}
Write-Host ""

# 12. curated marketplace 路径可读
Write-Host "12. curated marketplace path (.tmp):" -ForegroundColor Yellow
$curatedPath = "$env:USERPROFILE\.codex\.tmp\plugins"
if (Test-Path "$curatedPath\.agents\plugins\marketplace.json") {
  Write-Host "    EXISTS: $curatedPath" -ForegroundColor Green
  $curatedMj = Get-Content "$curatedPath\.agents\plugins\marketplace.json" -Raw
  if ($curatedMj -match '"name"\s*:\s*"([^"]+)"') {
    Write-Host "    marketplace.json name: $($Matches[1])" -ForegroundColor Green
  }
  # 检查关键 curated 插件目录
  $curatedPlugins = @("gmail", "superpowers", "carta-crm", "github")
  foreach ($p in $curatedPlugins) {
    $pPath = "$curatedPath\plugins\$p"
    if (Test-Path $pPath) {
      Write-Host "      - $p : OK" -ForegroundColor Green
    } else {
      Write-Host "      - $p : MISSING" -ForegroundColor Red
    }
  }
} else {
  Write-Host "    MISSING: $curatedPath\.agents\plugins\marketplace.json" -ForegroundColor Red
}
Write-Host ""

# 13. github plugin 引用的 marketplace 名称
Write-Host "13. github plugin marketplace ref:" -ForegroundColor Yellow
$cfgContent = Get-Content $cfg -Raw
if ($cfgContent -match '\[plugins\."github@([^"]+)"\]') {
  $ref = $Matches[1]
  Write-Host "    github@$ref" -ForegroundColor $(if ($ref -eq "openai-curated") { "Green" } else { "Red" })
  Write-Host "    Expected: openai-curated"
} else {
  Write-Host "    github plugin not found in config.toml" -ForegroundColor Red
}
Write-Host ""

# 14. cua_node hash 检查
Write-Host "14. cua_node hash:" -ForegroundColor Yellow
$cfgText = Get-Content $cfg -Raw
$newHashCount = ([regex]::Matches($cfgText, 'a89897d3d9baa117')).Count
$oldHashCount = ([regex]::Matches($cfgText, '789504f803e82e2b')).Count
Write-Host "    a89897d3d9baa117 (current): $newHashCount occurrences (expected 4)"
Write-Host "    789504f803e82e2b (old): $oldHashCount occurrences (expected 0)"
if ($newHashCount -eq 4 -and $oldHashCount -eq 0) {
  Write-Host "    PASS" -ForegroundColor Green
} else {
  Write-Host "    FAIL" -ForegroundColor Red
}
Write-Host ""

Write-Host "=== Summary ===" -ForegroundColor Cyan
Write-Host "If all checks pass, config.toml is healthy."
Write-Host "If any check fails, run tools/repair-codex-switch-sync.ps1 to audit and repair."
