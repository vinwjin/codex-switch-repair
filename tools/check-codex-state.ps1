# check-codex-state.ps1
# 检查 Codex 运行态健康度
# 用法: powershell -File check-codex-state.ps1

$ErrorActionPreference = "Continue"

Write-Host "=== Codex 0.140 run-state check ===" -ForegroundColor Cyan
Write-Host ""

$nodePath = "node"   # 使用 PATH 中的 node（需 Node >= 22.5，含内置 node:sqlite）
if (-not (Get-Command $nodePath -ErrorAction SilentlyContinue)) {
  Write-Warning "未找到 node（需 Node >= 22.5）。部分依赖 node 的检查将跳过。"
}

# 1. Codex 进程
Write-Host "1. Codex process:" -ForegroundColor Yellow
$procs = Get-Process -Name "codex" -ErrorAction SilentlyContinue
if ($procs) {
  $procs | Select-Object Id, ProcessName, StartTime | Format-Table -AutoSize | Out-String | Write-Host
} else {
  Write-Host "   not running" -ForegroundColor Gray
}
Write-Host ""

# 2. Codex 安装版本
Write-Host "2. Codex version (version.json):" -ForegroundColor Yellow
$ver = "$env:USERPROFILE\.codex\version.json"
if (Test-Path $ver) {
  Get-Content $ver -Raw | ConvertFrom-Json | Format-List | Out-String | Write-Host
} else {
  Write-Host "   not found" -ForegroundColor Red
}
Write-Host ""

# 3. WindowsApps 实际版本
Write-Host "3. WindowsApps Codex versions:" -ForegroundColor Yellow
$apps = Get-ChildItem "C:\Program Files\WindowsApps" -Filter "OpenAI.Codex_*" -ErrorAction SilentlyContinue
if ($apps) {
  $apps | ForEach-Object { Write-Host "   $($_.Name)" }
} else {
  Write-Host "   none" -ForegroundColor Red
}
Write-Host ""

# 4. cua_node runtime
Write-Host "4. cua_node runtime:" -ForegroundColor Yellow
$cua = "$env:LOCALAPPDATA\OpenAI\Codex\runtimes\cua_node"
if (Test-Path $cua) {
  Get-ChildItem $cua | ForEach-Object { Write-Host "   $($_.Name)" }
  $nodeRepl = Get-ChildItem $cua -Recurse -Filter "node_repl.exe" -ErrorAction SilentlyContinue
  if ($nodeRepl) {
    $nodeRepl | ForEach-Object { Write-Host "   node_repl.exe: $($_.FullName)" }
  } else {
    Write-Host "   node_repl.exe NOT FOUND" -ForegroundColor Red
  }
} else {
  Write-Host "   not found" -ForegroundColor Red
}
Write-Host ""

# 5. session_index.jsonl
Write-Host "5. session_index.jsonl:" -ForegroundColor Yellow
$idx = "$env:USERPROFILE\.codex\session_index.jsonl"
if (Test-Path $idx) {
  $lines = (Get-Content $idx).Count
  Write-Host "   $lines lines"
} else {
  Write-Host "   not found"
}
Write-Host ""

# 6. state_5.sqlite
Write-Host "6. state_5.sqlite:" -ForegroundColor Yellow
$db = "$env:USERPROFILE\.codex\state_5.sqlite"
if (Test-Path $db) {
  Write-Host "   exists ($([math]::Round((Get-Item $db).Length/1KB, 2)) KB)"
  if (Get-Command $nodePath -ErrorAction SilentlyContinue) {
    & $nodePath -e "
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path'); const os = require('node:os');
const db = new DatabaseSync(path.join(os.homedir(), '.codex', 'state_5.sqlite'));
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
console.log('   tables:', tables.map(t => t.name).join(', '));
for (const t of tables) {
  const r = db.prepare(\`SELECT COUNT(*) as n FROM \${t}\`).get();
  console.log(\`   \${t}: \${r.n} rows\`);
}
"
  }
} else {
  Write-Host "   not found" -ForegroundColor Red
}
Write-Host ""

# 7. .codex-global-state.json 关键字段
Write-Host "7. .codex-global-state.json key state:" -ForegroundColor Yellow
$gs = "$env:USERPROFILE\.codex\.codex-global-state.json"
if (Test-Path $gs) {
  if (Get-Command $nodePath -ErrorAction SilentlyContinue) {
    & $nodePath -e "
const fs = require('fs');
const path = require('node:path'); const os = require('node:os');
const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', '.codex-global-state.json'), 'utf8'));
const a = s['electron-persisted-atom-state'];
console.log('   agent-mode[local]:', a['agent-mode-by-host-id']?.local);
console.log('   skip-full-access-confirm:', a['skip-full-access-confirm']);
console.log('   primary-runtime-install-ready:', a['electron:onboarding-primary-runtime-install-ready']);
console.log('   welcome-pending:', a['electron:onboarding-welcome-pending']);
console.log('   projectless-thread-ids:', (s['projectless-thread-ids'] || []).length);
"
  }
} else {
  Write-Host "   not found" -ForegroundColor Red
}
Write-Host ""

# 8. plugins cache
Write-Host "8. plugins cache:" -ForegroundColor Yellow
$cache = "$env:USERPROFILE\.codex\plugins\cache"
if (Test-Path $cache) {
  Get-ChildItem $cache | ForEach-Object {
    $count = (Get-ChildItem $_.FullName -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count
    Write-Host "   $($_.Name): $count items"
  }
} else {
  Write-Host "   not found" -ForegroundColor Red
}
Write-Host ""

# 9. cc-switch 状态
Write-Host "9. cc-switch state:" -ForegroundColor Yellow
$csdb = "$env:USERPROFILE\.cc-switch\cc-switch.db"
if (Test-Path $csdb) {
  Write-Host "   db exists"
  if (Get-Command $nodePath -ErrorAction SilentlyContinue) {
    & $nodePath -e "
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path'); const os = require('node:os');
const db = new DatabaseSync(path.join(os.homedir(), '.cc-switch', 'cc-switch.db'));
const rows = db.prepare(\"SELECT name, is_current, provider_type FROM providers WHERE app_type='codex' ORDER BY sort_index\").all();
console.log('   codex providers:');
rows.forEach(r => console.log('     -', r.name, r.is_current ? '(ACTIVE)' : '', r.provider_type || ''));
"
  }
} else {
  Write-Host "   not found" -ForegroundColor Red
}
Write-Host ""

# 10. auth.json auth_mode
Write-Host "10. auth.json auth_mode:" -ForegroundColor Yellow
$auth = "$env:USERPROFILE\.codex\auth.json"
if (Test-Path $auth) {
  $j = Get-Content $auth -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "   auth_mode: $($j.auth_mode)"
  Write-Host "   tokens fields: $(($j.tokens.PSObject.Properties | ForEach-Object { $_.Name }) -join ', ')"
} else {
  Write-Host "   not found" -ForegroundColor Red
}
Write-Host ""

Write-Host "=== Summary ===" -ForegroundColor Cyan
Write-Host "If any item is red, run tools/repair-codex-switch-sync.ps1 to audit and repair."
