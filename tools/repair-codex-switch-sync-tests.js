'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('./repair-codex-switch-sync-core');

test('classifies ChatGPT auth by auth content, not provider name', () => {
  const auth = {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: '<TOKEN>',
      id_token: '<TOKEN>',
      refresh_token: '<TOKEN>',
    },
  };

  assert.equal(core.classifyAuth(auth), 'chatgpt');
});

test('classifies API key auth from top-level OPENAI_API_KEY', () => {
  assert.equal(core.classifyAuth({ OPENAI_API_KEY: '<API_KEY>' }), 'api_key');
});

test('classifies API key auth from tokens.OPENAI_API_KEY', () => {
  assert.equal(core.classifyAuth({ tokens: { OPENAI_API_KEY: '<API_KEY>' } }), 'api_key');
});

test('classifies unknown auth when no supported credential shape exists', () => {
  assert.equal(core.classifyAuth({ auth_mode: 'chatgpt' }), 'unknown');
});

test('summarizes shared config sections without relying on fixed plugin counts', () => {
  const text = [
    'model = "gpt-5.5"',
    '[model_providers.custom]',
    'name = "example"',
    '[plugins."browser@example"]',
    'enabled = true',
    '[marketplaces.example]',
    'source = "C:/example"',
    '[mcp_servers.node_repl]',
    'command = "C:/node_repl.exe"',
    '[mcp_servers.node_repl.env]',
    'NODE_REPL_NODE_PATH = "C:/node.exe"',
    '[mcp_servers.demo.tools.read]',
    'approval_mode = "approve"',
  ].join('\n');

  assert.deepEqual(core.summarizeTomlSections(text), {
    duplicateHeaders: [],
    topLevelTools: [],
    sharedHeaders: [
      '[plugins."browser@example"]',
      '[marketplaces.example]',
      '[mcp_servers.node_repl]',
      '[mcp_servers.node_repl.env]',
      '[mcp_servers.demo.tools.read]',
    ],
    providerHeaders: ['[model_providers.custom]'],
  });
});

test('detects duplicate table headers', () => {
  const text = ['[plugins.demo]', 'enabled = true', '[plugins.demo]', 'enabled = false'].join('\n');
  assert.deepEqual(core.summarizeTomlSections(text).duplicateHeaders, ['[plugins.demo]']);
});

test('recommends repairing live config when common snippet has missing shared sections', () => {
  const liveConfig = '[mcp_servers.node_repl]\ncommand = "C:/missing/node_repl.exe"\n';
  const commonSnippet = [
    '[mcp_servers.node_repl]',
    'command = "C:/existing/node_repl.exe"',
    '[mcp_servers.demo.tools.read]',
    'approval_mode = "approve"',
  ].join('\n');

  const report = core.auditState({
    activeProvider: { name: 'Example API', authType: 'api_key', config: 'model_provider = "custom"\n' },
    liveConfig,
    commonSnippet,
    liveAuthType: 'chatgpt',
    existingPaths: new Set(['C:/existing/node_repl.exe']),
    processes: { codexRunning: false, ccSwitchRunning: false },
  });

  assert.equal(report.authSync.status, 'mismatched');
  assert.equal(report.liveConfig.status, 'repairable');
  assert.deepEqual(report.recommendedActionIds, [
    'repair_live_config_from_active_provider_and_common',
    'repair_auth_json_from_active_provider',
  ]);
});

test('blocks common snippet capture when live config is worse than existing common snippet', () => {
  const report = core.auditState({
    activeProvider: { name: 'Example API', authType: 'api_key', config: '' },
    liveConfig: '[mcp_servers.node_repl]\ncommand = "C:/missing/node_repl.exe"\n',
    commonSnippet: '[mcp_servers.node_repl]\ncommand = "C:/existing/node_repl.exe"\n[mcp_servers.demo.tools.read]\napproval_mode = "approve"\n',
    liveAuthType: 'api_key',
    existingPaths: new Set(['C:/existing/node_repl.exe']),
    processes: { codexRunning: false, ccSwitchRunning: false },
  });

  assert.equal(report.commonCapture.allowed, false);
  assert.match(report.commonCapture.reasonZh, /不适合作为通用配置片段来源/);
});

test('builds concrete Chinese repair preview without leaking secrets', () => {
  const preview = core.buildRepairPreview({
    activeProvider: { name: 'Example API', authType: 'api_key' },
    recommendedActionIds: [
      'repair_live_config_from_active_provider_and_common',
      'repair_auth_json_from_active_provider',
    ],
    liveConfig: { missingSharedHeaders: ['[plugins.demo]'] },
  });

  assert.match(preview.textZh, /修复 live config\.toml/);
  assert.match(preview.textZh, /修复 auth\.json/);
  assert.match(preview.textZh, /API Key/);
  assert.doesNotMatch(preview.textZh, /<API_KEY>|<TOKEN>|refresh_token|access_token/);
});

test('summarizes providers without leaking secrets', () => {
  const provider = {
    name: 'Example',
    is_current: 1,
    settings_config: JSON.stringify({
      auth: { OPENAI_API_KEY: '<API_KEY>' },
      config: 'model_provider = "custom"\nmodel = "demo"\n',
    }),
  };

  const summary = core.summarizeProviderRow(provider);

  assert.equal(summary.name, 'Example');
  assert.equal(summary.active, true);
  assert.equal(summary.authType, 'api_key');
  assert.equal(summary.hasConfig, true);
  assert.equal(JSON.stringify(summary).includes('<API_KEY>'), false);
  assert.equal(JSON.stringify(summary).includes('OPENAI_API_KEY'), false);
});

test('builds backup manifest without secret values', () => {
  const manifest = core.buildBackupManifest({
    action: 'repair',
    codexHome: 'C:/Users/example/.codex',
    databasePath: 'C:/Users/example/.cc-switch/cc-switch.db',
    activeProvider: { name: 'Example', authType: 'api_key' },
    liveConfigSha256: 'abc',
    commonSnippetSha256: 'def',
  });

  const text = JSON.stringify(manifest);
  assert.match(text, /Example/);
  assert.doesNotMatch(text, /<API_KEY>|<TOKEN>|access_token|refresh_token|id_token/);
});

test('builds effective config from provider config plus common snippet', () => {
  const providerConfig = 'model_provider = "custom"\nmodel = "demo"\n[model_providers.custom]\nname = "Example"\n';
  const commonSnippet = '[plugins.demo]\nenabled = true\n[mcp_servers.demo.tools.read]\napproval_mode = "approve"\n';

  const result = core.buildEffectiveConfig(providerConfig, commonSnippet);

  assert.match(result, /model_provider = "custom"/);
  assert.match(result, /\[model_providers\.custom\]/);
  assert.match(result, /\[plugins\.demo\]/);
  assert.match(result, /\[mcp_servers\.demo\.tools\.read\]/);
});

test('merge dedups overlapping section headers (no duplicate tables)', () => {
  // provider 与 common 都含 [mcp_servers.node_repl] 和 [desktop]：合并后不能出现重复表头
  const providerConfig = 'model = "x"\n[mcp_servers.node_repl]\ncommand = "P"\n[desktop]\na = 1\n';
  const commonSnippet = '[mcp_servers.node_repl]\ncommand = "C"\n[desktop]\nb = 2\n[plugins.demo]\nenabled = true\n';

  const result = core.buildEffectiveConfig(providerConfig, commonSnippet);
  const summary = core.summarizeTomlSections(result);

  assert.deepEqual(summary.duplicateHeaders, [], '不应有重复表头');
  // provider 优先：node_repl 应保留 provider 的 command = "P"
  assert.match(result, /command = "P"/);
  assert.doesNotMatch(result, /command = "C"/);
  // common 独有的 section 应被补回
  assert.match(result, /\[plugins\.demo\]/);
});

test('merge dedups overlapping top-level keys (provider wins)', () => {
  const providerConfig = 'model = "provider-model"\n[a]\nx = 1\n';
  const commonSnippet = 'model = "common-model"\nextra = true\n[b]\ny = 2\n';

  const result = core.buildEffectiveConfig(providerConfig, commonSnippet);

  assert.match(result, /model = "provider-model"/);
  assert.doesNotMatch(result, /model = "common-model"/);
  assert.match(result, /extra = true/); // common 独有的顶层 key 补回
});

test('rejects common snippet capture when shared section contains sensitive key', () => {
  const liveConfig = '[mcp_servers.demo.env]\nOPENAI_API_KEY = "<API_KEY>"\n';
  const result = core.extractCommonSnippetFromLive(liveConfig);

  assert.equal(result.allowed, false);
  assert.match(result.reasonZh, /敏感字段/);
});

test('lists auth baseline candidates by content-derived type', () => {
  const result = core.listAuthBaselineCandidates([
    { name: 'A', authType: 'chatgpt', active: false },
    { name: 'B', authType: 'api_key', active: true },
  ]);

  assert.deepEqual(result, [
    { index: 1, name: 'A', authType: 'chatgpt', active: false },
    { index: 2, name: 'B', authType: 'api_key', active: true },
  ]);
});
