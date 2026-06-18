'use strict';

// 端到端沙箱测试：用合成 cc-switch.db + 合成 .codex 跑通所有 CLI 命令。
// 绝不读写真实 ~/.codex 或 ~/.cc-switch。所有数据为占位符，无真实密钥。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const CORE = path.join(__dirname, 'repair-codex-switch-sync-core.js');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-e2e-'));
  const codexHome = path.join(root, '.codex');
  const ccDir = path.join(root, '.cc-switch');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(ccDir, { recursive: true });
  return {
    root,
    codexHome,
    databasePath: path.join(ccDir, 'cc-switch.db'),
    backupRoot: path.join(root, 'backup'),
    configPath: path.join(codexHome, 'config.toml'),
    authPath: path.join(codexHome, 'auth.json'),
  };
}

function seedDb(databasePath, { liveProviderConfig, commonSnippet }) {
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, sort_index INTEGER, is_current BOOLEAN)');
  // 与真实 cc-switch.db 一致：key 为 PRIMARY KEY，capture-common 的 ON CONFLICT(key) 才成立
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  const apikeyCfg = JSON.stringify({ auth: { auth_mode: 'apikey', OPENAI_API_KEY: '<API_KEY>' }, config: liveProviderConfig });
  const chatgptCfg = JSON.stringify({ auth: { auth_mode: 'chatgpt', tokens: { access_token: '<TOKEN>', id_token: '<TOKEN>', refresh_token: '<TOKEN>' } }, config: 'model_provider = "openai"\n' });
  const ins = db.prepare('INSERT INTO providers (id,app_type,name,settings_config,sort_index,is_current) VALUES (?,?,?,?,?,?)');
  ins.run('p1', 'codex', 'Synthetic API', apikeyCfg, 0, 1);
  ins.run('p2', 'codex', 'Synthetic ChatGPT', chatgptCfg, 1, 0);
  ins.run('p3', 'claude', 'Other App', '{}', 2, 0);
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('common_config_codex', commonSnippet);
  db.close();
}

function runCore(command, payloadObj) {
  const arg = 'base64:' + Buffer.from(JSON.stringify(payloadObj)).toString('base64');
  const out = execFileSync(process.execPath, [CORE, command, arg], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : null;
}

// 一个共享的「可修复」场景：live 缺 common 里的 [plugins.demo]，且 live 是 chatgpt、active 是 apikey。
function buildRepairableSandbox() {
  const sb = makeSandbox();
  const liveProviderConfig = 'model = "demo"\nmodel_provider = "custom"\n[model_providers.custom]\nname = "Synthetic"\n';
  const commonSnippet = '[plugins.demo]\nenabled = true\n[mcp_servers.demo.tools.read]\napproval_mode = "approve"\n';
  // live config.toml 缺少 common 里的 [plugins.demo] -> repairable
  fs.writeFileSync(sb.configPath, 'model = "demo"\n[mcp_servers.demo.tools.read]\napproval_mode = "approve"\n', 'utf8');
  // live auth.json 是 chatgpt，但 active provider 是 apikey -> mismatched
  fs.writeFileSync(sb.authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: '<TOKEN>' } }, null, 2), 'utf8');
  seedDb(sb.databasePath, { liveProviderConfig, commonSnippet });
  return sb;
}

function basePayload(sb, extra = {}) {
  return {
    codexHome: sb.codexHome,
    databasePath: sb.databasePath,
    backupRoot: sb.backupRoot,
    keepBackups: 5,
    allowRunningProcesses: false,
    processes: { codexRunning: false, ccSwitchRunning: false },
    ...extra,
  };
}

test('e2e audit: detects repairable live config + auth mismatch, no secrets in output', () => {
  const sb = buildRepairableSandbox();
  const report = runCore('audit', basePayload(sb));
  assert.equal(report.activeProvider.name, 'Synthetic API');
  assert.equal(report.activeProvider.authType, 'api_key');
  assert.equal(report.liveConfig.status, 'repairable');
  assert.equal(report.authSync.status, 'mismatched');
  assert.equal(report.providers.length, 2); // 只算 codex provider
  const raw = JSON.stringify(report);
  assert.doesNotMatch(raw, /<API_KEY>|<TOKEN>|access_token|OPENAI_API_KEY/);
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('e2e write guard: apply-recommended blocked when process running', () => {
  const sb = buildRepairableSandbox();
  let threw = false;
  try {
    runCore('apply-recommended', basePayload(sb, { processes: { codexRunning: true, ccSwitchRunning: false } }));
  } catch (e) {
    threw = true;
    assert.match(String(e.stderr || e.message), /正在运行/);
  }
  assert.equal(threw, true);
  assert.equal(fs.existsSync(sb.backupRoot), false, '被拦截时不应创建备份');
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('e2e apply-recommended: repairs config + auth, creates backup, re-audit healthy', () => {
  const sb = buildRepairableSandbox();
  const result = runCore('apply-recommended', basePayload(sb));
  assert.deepEqual(result.actions.sort(), ['auth.json', 'config.toml']);
  assert.ok(fs.existsSync(result.backupDir), '应创建备份目录');
  assert.ok(fs.existsSync(path.join(result.backupDir, 'config.toml')));
  assert.ok(fs.existsSync(path.join(result.backupDir, 'manifest.json')));
  // 修复后 live config 含 [plugins.demo]，auth 变为 api_key
  const newConfig = fs.readFileSync(sb.configPath, 'utf8');
  assert.match(newConfig, /\[plugins\.demo\]/);
  assert.equal(result.after.liveConfig.status, 'healthy');
  assert.equal(result.after.authSync.status, 'matched');
  // manifest 不含密钥
  const manifest = fs.readFileSync(path.join(result.backupDir, 'manifest.json'), 'utf8');
  assert.doesNotMatch(manifest, /<API_KEY>|<TOKEN>|access_token/);
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('e2e backup + list-backups + restore round-trip', () => {
  const sb = buildRepairableSandbox();
  const original = fs.readFileSync(sb.configPath, 'utf8');
  const backup = runCore('backup', basePayload(sb, { action: 'manual' }));
  assert.ok(fs.existsSync(backup.backupDir));
  const list = runCore('list-backups', basePayload(sb));
  assert.equal(list.length, 1);
  // 篡改 live config，再从备份恢复
  fs.writeFileSync(sb.configPath, 'CORRUPTED\n', 'utf8');
  const restore = runCore('restore', basePayload(sb, { backupDir: backup.backupDir, file: 'config.toml' }));
  assert.equal(restore.ok, true);
  assert.equal(fs.readFileSync(sb.configPath, 'utf8'), original);
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('e2e capture-common: blocked when live config not healthy', () => {
  const sb = buildRepairableSandbox(); // live 是 repairable
  const result = runCore('capture-common', basePayload(sb));
  assert.equal(result.ok, false);
  assert.match(result.messageZh, /不适合作为通用配置片段来源/);
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('e2e capture-common: succeeds + updates DB when live healthy', () => {
  const sb = makeSandbox();
  // healthy: live 包含 common 的全部 shared section（这里 common 为空，live 有 plugins）
  fs.writeFileSync(sb.configPath, 'model = "demo"\n[plugins.alpha]\nenabled = true\n[features]\nx = 1\n', 'utf8');
  fs.writeFileSync(sb.authPath, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: '<API_KEY>' }), 'utf8');
  seedDb(sb.databasePath, { liveProviderConfig: 'model_provider = "custom"\n', commonSnippet: '' });
  const result = runCore('capture-common', basePayload(sb));
  assert.equal(result.ok, true);
  const db = new DatabaseSync(sb.databasePath);
  const saved = db.prepare("SELECT value FROM settings WHERE key='common_config_codex'").get().value;
  db.close();
  assert.match(saved, /\[plugins\.alpha\]/);
  assert.doesNotMatch(saved, /model_provider|<API_KEY>/);
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('e2e apply-auth-baseline: calibrate to non-active provider requires confirm', () => {
  const sb = buildRepairableSandbox();
  // provider 2 = ChatGPT，非 active；不带 confirmMismatch 应被拦
  let threw = false;
  try {
    runCore('apply-auth-baseline', basePayload(sb, { providerIndex: 2 }));
  } catch (e) {
    threw = true;
    assert.match(String(e.stderr || e.message), /不是当前 active provider/);
  }
  assert.equal(threw, true);
  // 带 confirmMismatch 应成功写 auth.json 为 chatgpt
  const ok = runCore('apply-auth-baseline', basePayload(sb, { providerIndex: 2, confirmMismatch: true }));
  assert.equal(ok.ok, true);
  const auth = JSON.parse(fs.readFileSync(sb.authPath, 'utf8'));
  assert.equal(auth.auth_mode, 'chatgpt');
  fs.rmSync(sb.root, { recursive: true, force: true });
});

test('e2e apply-recommended preserves live-only sections (backfill, not rebuild)', () => {
  const sb = makeSandbox();
  // live 含一个 common/provider 都没有的 [model_providers.custom]，修复后必须保留
  fs.writeFileSync(sb.configPath, 'model = "demo"\n[model_providers.custom]\nname = "x"\n[mcp_servers.demo.tools.read]\napproval_mode = "approve"\n', 'utf8');
  fs.writeFileSync(sb.authPath, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: '<API_KEY>' }), 'utf8');
  // common 多出 [plugins.demo] -> repairable；provider.config 不含 model_providers
  seedDb(sb.databasePath, {
    liveProviderConfig: 'model_provider = "custom"\n',
    commonSnippet: '[plugins.demo]\nenabled = true\n[mcp_servers.demo.tools.read]\napproval_mode = "approve"\n',
  });
  const result = runCore('apply-recommended', basePayload(sb));
  const newConfig = fs.readFileSync(sb.configPath, 'utf8');
  assert.match(newConfig, /\[model_providers\.custom\]/, '必须保留 live 独有的 model_providers.custom');
  assert.match(newConfig, /\[plugins\.demo\]/, '应补回 common 的缺失 section');
  assert.equal(result.after.liveConfig.status, 'healthy');
  fs.rmSync(sb.root, { recursive: true, force: true });
});

module.exports = { makeSandbox, seedDb, runCore };
