'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function classifyAuth(auth) {
  if (!auth || typeof auth !== 'object') return 'unknown';

  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : {};

  if (
    auth.auth_mode === 'chatgpt' &&
    (tokens.access_token || tokens.id_token || tokens.refresh_token)
  ) {
    return 'chatgpt';
  }

  if (
    auth.auth_mode === 'apikey' ||
    auth.OPENAI_API_KEY ||
    tokens.OPENAI_API_KEY
  ) {
    return 'api_key';
  }

  return 'unknown';
}

function authTypeZh(authType) {
  if (authType === 'chatgpt') return 'ChatGPT 官方登录态';
  if (authType === 'api_key') return 'API Key';
  return '未识别';
}

function summarizeTomlSections(text) {
  const seen = new Set();
  const duplicateHeaders = [];
  const topLevelTools = [];
  const sharedHeaders = [];
  const providerHeaders = [];

  for (const line of String(text || '').split(/\r?\n/)) {
    const headerMatch = line.match(/^\[([^\]]+)\]\s*$/);
    if (!headerMatch) continue;

    const header = `[${headerMatch[1]}]`;
    const key = headerMatch[1];

    if (seen.has(header) && !duplicateHeaders.includes(header)) {
      duplicateHeaders.push(header);
    }
    seen.add(header);

    if (/^tools\./.test(key)) topLevelTools.push(header);

    if (
      /^plugins\./.test(key) ||
      /^marketplaces\./.test(key) ||
      /^mcp_servers\./.test(key) ||
      key === 'features' ||
      key === 'desktop' ||
      key === 'windows' ||
      /^tui\./.test(key)
    ) {
      sharedHeaders.push(header);
    }

    if (/^model_providers\./.test(key)) providerHeaders.push(header);
  }

  return {
    duplicateHeaders,
    topLevelTools,
    sharedHeaders,
    providerHeaders,
  };
}

function sectionKeyFromHeader(header) {
  const match = String(header || '').match(/^\[([^\]]+)\]\s*$/);
  return match ? match[1] : '';
}

function isAllowedSharedSectionKey(key) {
  return (
    /^plugins\./.test(key) ||
    /^marketplaces\./.test(key) ||
    /^mcp_servers\./.test(key) ||
    key === 'features' ||
    key === 'desktop' ||
    key === 'windows' ||
    /^tui\./.test(key)
  );
}

function hasSensitiveKey(text) {
  return /^\s*["']?[^#=\r\n]*(key|token|cookie|session|secret|password)[^#=\r\n]*["']?\s*=/im.test(
    String(text || ''),
  );
}

function auditState(input) {
  const liveSummary = summarizeTomlSections(input.liveConfig);
  const commonSummary = summarizeTomlSections(input.commonSnippet);

  const missingSharedHeaders = commonSummary.sharedHeaders.filter(
    (header) => !liveSummary.sharedHeaders.includes(header),
  );

  const liveHasDuplicateHeaders = liveSummary.duplicateHeaders.length > 0;
  const liveHasTopLevelTools = liveSummary.topLevelTools.length > 0;
  const commonBroken = commonSummary.duplicateHeaders.length > 0;
  const liveConfigStatus = liveHasDuplicateHeaders
    ? 'broken'
    : (missingSharedHeaders.length > 0 || liveHasTopLevelTools) && !commonBroken
      ? 'repairable'
      : 'healthy';

  const activeAuthType = input.activeProvider?.authType || 'unknown';
  const liveAuthType = input.liveAuthType || 'unknown';
  const authStatus =
    activeAuthType === 'unknown' || liveAuthType === 'unknown'
      ? 'unknown'
      : activeAuthType === liveAuthType
        ? 'matched'
        : 'mismatched';

  const recommendedActionIds = [];
  if (liveConfigStatus === 'repairable') {
    recommendedActionIds.push('repair_live_config_from_active_provider_and_common');
  }
  if (authStatus === 'mismatched') {
    recommendedActionIds.push('repair_auth_json_from_active_provider');
  }

  const commonCaptureAllowed =
    liveConfigStatus === 'healthy' &&
    !liveHasDuplicateHeaders &&
    !liveHasTopLevelTools &&
    !commonBroken;

  return {
    activeProvider: input.activeProvider,
    liveConfig: {
      status: liveConfigStatus,
      missingSharedHeaders,
      duplicateHeaders: liveSummary.duplicateHeaders,
      topLevelTools: liveSummary.topLevelTools,
    },
    commonSnippet: {
      status: commonBroken ? 'broken' : commonSummary.sharedHeaders.length ? 'healthy' : 'missing',
      sharedHeaders: commonSummary.sharedHeaders,
      duplicateHeaders: commonSummary.duplicateHeaders,
    },
    authSync: {
      status: authStatus,
      activeProviderAuthType: activeAuthType,
      liveAuthType,
    },
    commonCapture: {
      allowed: commonCaptureAllowed,
      reasonZh: commonCaptureAllowed
        ? '当前 live config.toml 可以作为通用配置片段来源。'
        : '当前 live config.toml 不适合作为通用配置片段来源。',
    },
    recommendedActionIds,
    processes: input.processes || { codexRunning: false, ccSwitchRunning: false },
  };
}

function buildRepairPreview(report) {
  const ids = report.recommendedActionIds || [];
  const lines = ['将执行以下修复：', ''];
  let index = 1;

  if (ids.includes('repair_live_config_from_active_provider_and_common')) {
    lines.push(`${index}. 修复 live config.toml`);
    lines.push('   - 用当前 Provider 的路由配置生成 provider 部分');
    lines.push('   - 从 common_config_codex 补回缺失的通用配置片段');
    const missing = report.liveConfig?.missingSharedHeaders || [];
    if (missing.length) {
      lines.push(`   - 将补回缺失 section：${missing.join(', ')}`);
    }
    index += 1;
  }

  if (ids.includes('repair_auth_json_from_active_provider')) {
    lines.push(`${index}. 修复 auth.json`);
    lines.push(`   - 当前 Provider 登录态：${authTypeZh(report.activeProvider?.authType)}`);
    lines.push('   - 将 auth.json 改为当前 Provider 对应登录态');
    lines.push('   - 不显示、不打印 API key 或 token 正文');
    index += 1;
  }

  if (index === 1) {
    lines.push('当前没有推荐的自动修复项。');
  } else {
    lines.push('');
    lines.push(`${index}. 修复后复查`);
    lines.push('   - 检查 config.toml 结构');
    lines.push('   - 检查 auth.json 与当前 Provider 是否一致');
  }

  return { textZh: lines.join('\n') };
}

function parseSettingsConfig(settingsConfig) {
  try {
    const parsed = JSON.parse(settingsConfig || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function summarizeProviderRow(row, options = {}) {
  const parsed = parseSettingsConfig(row.settings_config);
  const auth = parsed.auth && typeof parsed.auth === 'object' ? parsed.auth : {};
  const result = {
    id: row.id,
    name: row.name,
    active: !!row.is_current,
    authType: classifyAuth(auth),
    hasConfig: typeof parsed.config === 'string' && parsed.config.length > 0,
    configSha256: parsed.config ? sha256(parsed.config) : null,
  };

  if (options.includeSecrets) {
    result.auth = auth;
    result.config = parsed.config || '';
  } else {
    result.authShape = summarizeAuthShape(auth);
  }

  return result;
}

function summarizeAuthShape(auth) {
  const tokens = auth && typeof auth.tokens === 'object' ? auth.tokens : {};
  return {
    authMode: auth?.auth_mode || null,
    hasOpenAiApiKey: !!auth?.OPENAI_API_KEY || !!tokens.OPENAI_API_KEY,
    hasAccessToken: !!tokens.access_token,
    hasIdToken: !!tokens.id_token,
    hasRefreshToken: !!tokens.refresh_token,
  };
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function buildBackupManifest(input) {
  return {
    timestamp: new Date().toISOString(),
    action: input.action,
    codexHome: input.codexHome,
    databasePath: input.databasePath,
    activeProvider: {
      name: input.activeProvider?.name || '(none)',
      authType: input.activeProvider?.authType || 'unknown',
    },
    liveConfigSha256: input.liveConfigSha256,
    commonSnippetSha256: input.commonSnippetSha256,
    authShapeSummary: input.authShapeSummary,
  };
}

// 把 TOML 文本解析为 { preamble: 首个 section 之前的行, sections: [{header, body}] }
function parseTomlDoc(text) {
  const lines = String(text || '').split(/\r?\n/);
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (/^\[[^\]]+\]\s*$/.test(line)) {
      if (current) sections.push(current);
      current = { header: line.trim(), bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
    else preamble.push(line);
  }
  if (current) sections.push(current);
  return { preamble, sections };
}

function topLevelKeyOf(line) {
  const m = String(line).match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
  return m ? m[1] : null;
}

// 按 section 头与顶层 key 去重地合并 provider 配置与通用片段。
// provider 优先（先出现者胜），common 只补回 provider 中缺失的 section / 顶层 key。
// 这样既能补回缺失的通用配置，又绝不产生重复表头或重复 key。
function buildEffectiveConfig(providerConfig, commonSnippet) {
  const left = parseTomlDoc(providerConfig);
  const right = parseTomlDoc(commonSnippet);

  const seenKeys = new Set();
  const preambleLines = [];
  for (const line of left.preamble) {
    const k = topLevelKeyOf(line);
    if (k) seenKeys.add(k);
    preambleLines.push(line);
  }
  for (const line of right.preamble) {
    const k = topLevelKeyOf(line);
    if (k && seenKeys.has(k)) continue;
    if (k) seenKeys.add(k);
    if (line.trim() === '' && preambleLines.length === 0) continue;
    preambleLines.push(line);
  }

  const seenHeaders = new Set();
  const outSections = [];
  for (const section of [...left.sections, ...right.sections]) {
    if (seenHeaders.has(section.header)) continue;
    seenHeaders.add(section.header);
    outSections.push(section);
  }

  const blocks = [];
  const pre = preambleLines.join('\n').trim();
  if (pre) blocks.push(pre);
  for (const section of outSections) {
    const body = section.bodyLines.join('\n').replace(/\s+$/, '');
    blocks.push(body ? `${section.header}\n${body}` : section.header);
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

function extractCommonSnippetFromLive(text) {
  const summary = summarizeTomlSections(text);
  if (summary.duplicateHeaders.length) {
    return { allowed: false, snippet: '', reasonZh: '发现重复 table header，不能捕获通用配置片段。' };
  }
  if (summary.topLevelTools.length) {
    return { allowed: false, snippet: '', reasonZh: '发现顶层 [tools.*]，不能安全捕获通用配置片段。' };
  }

  const sections = splitTomlSections(text);
  const kept = [];
  for (const section of sections) {
    const key = sectionKeyFromHeader(section.header);
    if (!isAllowedSharedSectionKey(key)) continue;
    if (hasSensitiveKey(section.body)) {
      return { allowed: false, snippet: '', reasonZh: `共享 section ${section.header} 含敏感字段，不能捕获。` };
    }
    kept.push(`${section.header}\n${section.body.trim()}`.trim());
  }

  if (!kept.length) {
    return { allowed: false, snippet: '', reasonZh: 'live config.toml 中没有可捕获的通用配置片段。' };
  }

  return { allowed: true, snippet: `${kept.join('\n\n')}\n`, reasonZh: '可以捕获通用配置片段。' };
}

function splitTomlSections(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (/^\[[^\]]+\]\s*$/.test(line)) {
      if (current) sections.push(current);
      current = { header: line.trim(), bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  if (current) sections.push(current);
  return sections.map((section) => ({
    header: section.header,
    body: section.bodyLines.join('\n'),
  }));
}

function listAuthBaselineCandidates(providers) {
  return providers.map((provider, index) => ({
    index: index + 1,
    name: provider.name,
    authType: provider.authType,
    active: provider.active,
  }));
}

function loadSqlite() {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (error) {
    throw new Error(`当前 Node.js 不支持 node:sqlite，无法读取 cc-switch.db：${error.message}`);
  }
}

function normalizePath(filePath) {
  return path.resolve(String(filePath || ''));
}

function readJsonFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function readState(payload, options = {}) {
  const codexHome = normalizePath(payload.codexHome);
  const databasePath = normalizePath(payload.databasePath);
  const configPath = path.join(codexHome, 'config.toml');
  const authPath = path.join(codexHome, 'auth.json');
  const liveConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const liveAuth = readJsonFileSafe(authPath);

  let providers = [];
  let commonSnippet = '';
  if (fs.existsSync(databasePath)) {
    const DatabaseSync = loadSqlite();
    const db = new DatabaseSync(databasePath);
    try {
      const providerRows = db.prepare(
        "SELECT id,name,is_current,settings_config FROM providers WHERE app_type='codex' ORDER BY sort_index",
      ).all();
      providers = providerRows.map((row) => summarizeProviderRow(row, options));
      commonSnippet = db.prepare(
        "SELECT value FROM settings WHERE key='common_config_codex'",
      ).get()?.value || '';
    } finally {
      db.close();
    }
  }

  const activeProvider = providers.find((provider) => provider.active) || providers[0] || {
    name: '(none)',
    active: false,
    authType: 'unknown',
    hasConfig: false,
    config: '',
  };

  return {
    codexHome,
    databasePath,
    configPath,
    authPath,
    liveConfig,
    liveAuth,
    liveAuthType: classifyAuth(liveAuth),
    providers,
    activeProvider,
    commonSnippet,
  };
}

function buildAuditReport(payload, options = {}) {
  const state = readState(payload, options);
  const report = auditState({
    activeProvider: sanitizeProviderForReport(state.activeProvider),
    liveConfig: state.liveConfig,
    commonSnippet: state.commonSnippet,
    liveAuthType: state.liveAuthType,
    existingPaths: new Set(),
    processes: normalizeProcesses(payload.processes),
  });
  report.providers = state.providers.map(sanitizeProviderForReport);
  report.paths = {
    codexHome: state.codexHome,
    databasePath: state.databasePath,
  };
  return report;
}

function sanitizeProviderForReport(provider) {
  if (!provider) return provider;
  const { auth, config, ...safe } = provider;
  if (!safe.authShape && auth) safe.authShape = summarizeAuthShape(auth);
  return safe;
}

function normalizeProcesses(processes) {
  return {
    codexRunning: !!(processes?.codexRunning ?? processes?.CodexRunning),
    ccSwitchRunning: !!(processes?.ccSwitchRunning ?? processes?.CcSwitchRunning),
  };
}

function createBackup(payload, action, state = readState(payload, { includeSecrets: true })) {
  const backupRoot = normalizePath(payload.backupRoot);
  fs.mkdirSync(backupRoot, { recursive: true });
  const stamp = timestampForPath();
  const dir = path.join(backupRoot, stamp);
  fs.mkdirSync(dir, { recursive: false });

  copyIfExists(state.configPath, path.join(dir, 'config.toml'));
  copyIfExists(state.authPath, path.join(dir, 'auth.json'));
  copyIfExists(state.databasePath, path.join(dir, 'cc-switch.db'));

  const manifest = buildBackupManifest({
    action,
    codexHome: state.codexHome,
    databasePath: state.databasePath,
    activeProvider: state.activeProvider,
    liveConfigSha256: sha256(state.liveConfig),
    commonSnippetSha256: sha256(state.commonSnippet),
    authShapeSummary: summarizeAuthShape(state.liveAuth),
  });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  pruneBackups(backupRoot, Number(payload.keepBackups || 5));
  return { backupDir: dir, manifest };
}

function timestampForPath() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function copyIfExists(source, target) {
  if (source && fs.existsSync(source)) fs.copyFileSync(source, target);
}

function pruneBackups(backupRoot, keepBackups) {
  if (!Number.isFinite(keepBackups) || keepBackups < 1) return;
  const dirs = fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8}-\d{6}/.test(entry.name))
    .map((entry) => path.join(backupRoot, entry.name))
    .sort()
    .reverse();
  for (const dir of dirs.slice(keepBackups)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function listBackups(payload) {
  const backupRoot = normalizePath(payload.backupRoot);
  if (!fs.existsSync(backupRoot)) return [];
  return fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8}-\d{6}/.test(entry.name))
    .map((entry) => {
      const dir = path.join(backupRoot, entry.name);
      const manifestPath = path.join(dir, 'manifest.json');
      return {
        name: entry.name,
        path: dir,
        manifest: readJsonFileSafe(manifestPath),
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

async function main(argv) {
  const command = argv[2];
  if (!command) return;
  const payload = parsePayloadArg(argv[3]);

  if (command === 'audit') {
    process.stdout.write(JSON.stringify(buildAuditReport(payload), null, 2));
    return;
  }

  if (command === 'preview-recommended') {
    process.stdout.write(JSON.stringify(buildRepairPreview(buildAuditReport(payload)), null, 2));
    return;
  }

  if (command === 'backup') {
    const state = readState(payload, { includeSecrets: true });
    process.stdout.write(JSON.stringify(createBackup(payload, payload.action || 'manual', state), null, 2));
    return;
  }

  if (command === 'list-backups') {
    process.stdout.write(JSON.stringify(listBackups(payload), null, 2));
    return;
  }

  if (command === 'apply-recommended') {
    process.stdout.write(JSON.stringify(applyRecommended(payload), null, 2));
    return;
  }

  if (command === 'capture-common') {
    process.stdout.write(JSON.stringify(captureCommon(payload), null, 2));
    return;
  }

  if (command === 'apply-auth-baseline') {
    process.stdout.write(JSON.stringify(applyAuthBaseline(payload), null, 2));
    return;
  }

  if (command === 'restore') {
    process.stdout.write(JSON.stringify(restoreFromBackup(payload), null, 2));
    return;
  }

  throw new Error(`未知命令：${command}`);
}

function parsePayloadArg(value) {
  if (!value) return {};
  if (String(value).startsWith('base64:')) {
    return JSON.parse(Buffer.from(String(value).slice('base64:'.length), 'base64').toString('utf8'));
  }
  return JSON.parse(value);
}

function ensureWriteAllowed(payload) {
  const processes = normalizeProcesses(payload.processes);
  if ((processes.codexRunning || processes.ccSwitchRunning) && !payload.allowRunningProcesses) {
    const error = new Error('检测到 Codex 或 cc-switch 正在运行。请先关闭，或使用 -AllowRunningProcesses 明确覆盖。');
    error.exitCode = 2;
    throw error;
  }
}

function applyRecommended(payload) {
  ensureWriteAllowed(payload);
  const state = readState(payload, { includeSecrets: true });
  const before = buildAuditReport(payload);
  const backup = createBackup(payload, 'apply-recommended', state);
  const actions = [];

  if (before.recommendedActionIds.includes('repair_live_config_from_active_provider_and_common')) {
    // 审计信号是「live 缺少 common 里的共享 section」，因此采用 backfill：
    // 以现有 live config 为基底，只补回缺失的共享 section，保留 live 独有内容
    // （如 [model_providers.custom] 等运行时路由），绝不整体推倒重建。
    const effective = buildEffectiveConfig(state.liveConfig, state.commonSnippet);
    // 写前防线：合并结果绝不能含重复表头或顶层 [tools.*]，否则会写出损坏的 config.toml。
    const check = summarizeTomlSections(effective);
    if (check.duplicateHeaders.length || check.topLevelTools.length) {
      const error = new Error(
        `修复中止：生成的 config.toml 含重复表头或顶层 [tools.*]，未写入。重复：${check.duplicateHeaders.join(', ') || '无'}；顶层 tools：${check.topLevelTools.join(', ') || '无'}`,
      );
      error.exitCode = 3;
      throw error;
    }
    fs.mkdirSync(state.codexHome, { recursive: true });
    fs.writeFileSync(state.configPath, effective, 'utf8');
    actions.push('config.toml');
  }

  if (before.recommendedActionIds.includes('repair_auth_json_from_active_provider')) {
    fs.mkdirSync(state.codexHome, { recursive: true });
    fs.writeFileSync(state.authPath, JSON.stringify(state.activeProvider.auth || {}, null, 2) + '\n', 'utf8');
    actions.push('auth.json');
  }

  return {
    messageZh: actions.length ? '推荐修复已完成。' : '当前没有需要执行的推荐修复。',
    actions,
    backupDir: backup.backupDir,
    after: buildAuditReport(payload),
  };
}

function captureCommon(payload) {
  ensureWriteAllowed(payload);
  const state = readState(payload, { includeSecrets: true });
  const audit = auditState({
    activeProvider: state.activeProvider,
    liveConfig: state.liveConfig,
    commonSnippet: state.commonSnippet,
    liveAuthType: state.liveAuthType,
    processes: normalizeProcesses(payload.processes),
  });
  if (!audit.commonCapture.allowed) {
    return { ok: false, messageZh: audit.commonCapture.reasonZh };
  }
  const extracted = extractCommonSnippetFromLive(state.liveConfig);
  if (!extracted.allowed) return { ok: false, messageZh: extracted.reasonZh };

  const backup = createBackup(payload, 'capture-common', state);
  const DatabaseSync = loadSqlite();
  const db = new DatabaseSync(state.databasePath);
  try {
    db.prepare(
      "INSERT INTO settings(key, value) VALUES('common_config_codex', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(extracted.snippet);
  } finally {
    db.close();
  }
  return { ok: true, messageZh: 'common_config_codex 已更新。', backupDir: backup.backupDir };
}

function applyAuthBaseline(payload) {
  ensureWriteAllowed(payload);
  const selectedIndex = Number(payload.providerIndex);
  const state = readState(payload, { includeSecrets: true });
  const selected = state.providers[selectedIndex - 1];
  if (!selected) throw new Error('未找到选择的 Provider。');
  if (!selected.active && !payload.confirmMismatch) {
    const error = new Error('所选 Provider 不是当前 active provider；这可能会让 live auth.json 与 active provider 不一致。');
    error.exitCode = 2;
    throw error;
  }
  const backup = createBackup(payload, 'apply-auth-baseline', state);
  fs.mkdirSync(state.codexHome, { recursive: true });
  fs.writeFileSync(state.authPath, JSON.stringify(selected.auth || {}, null, 2) + '\n', 'utf8');
  const actions = ['auth.json'];
  if (selected.active) {
    const effective = buildEffectiveConfig(selected.config, state.commonSnippet);
    const check = summarizeTomlSections(effective);
    if (check.duplicateHeaders.length || check.topLevelTools.length) {
      const error = new Error(
        `config.toml 重建中止：含重复表头或顶层 [tools.*]，仅写入了 auth.json。重复：${check.duplicateHeaders.join(', ') || '无'}`,
      );
      error.exitCode = 3;
      throw error;
    }
    fs.writeFileSync(state.configPath, effective, 'utf8');
    actions.push('config.toml');
  }
  return { ok: true, messageZh: '登录态基准已校准。', actions, backupDir: backup.backupDir };
}

function restoreFromBackup(payload) {
  ensureWriteAllowed(payload);
  const backupDir = normalizePath(payload.backupDir);
  const targetName = String(payload.file || '');
  const allowed = new Set(['config.toml', 'auth.json', 'cc-switch.db']);
  if (!allowed.has(targetName)) throw new Error('不支持的恢复文件。');
  const state = readState(payload, { includeSecrets: true });
  const source = path.join(backupDir, targetName);
  if (!fs.existsSync(source)) throw new Error(`备份中不存在 ${targetName}`);
  const targets = {
    'config.toml': state.configPath,
    'auth.json': state.authPath,
    'cc-switch.db': state.databasePath,
  };
  createBackup(payload, `restore-before-${targetName}`, state);
  copyIfExists(source, targets[targetName]);
  return { ok: true, messageZh: `${targetName} 已恢复。`, source, target: targets[targetName] };
}

if (require.main === module) {
  main(process.argv).catch((error) => {
    console.error(error.message);
    process.exit(error.exitCode || 1);
  });
}

module.exports = {
  classifyAuth,
  authTypeZh,
  summarizeTomlSections,
  auditState,
  buildRepairPreview,
  summarizeProviderRow,
  buildBackupManifest,
  buildEffectiveConfig,
  extractCommonSnippetFromLive,
  listAuthBaselineCandidates,
  buildAuditReport,
  createBackup,
  listBackups,
  main,
};
