import { createElement as h, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import type { QQAgentSettings } from '../shared/agent-settings.ts';
import type { ConversationView, ToolCatalogEntry } from '../shared/conversation-protocol.ts';
import type { SelectorSource } from './host-selectors.ts';
import { QQAgentSettingsForm } from './qq-agent-settings-form.ts';
import { useQQAgentCatalog } from './qq-agent-catalog.ts';
import type { QQSessionStore } from './qq-session-store.ts';

interface PeerDraft {
  version: number;
  settings: QQAgentSettings;
  alias: string;
  receiveEnabled: boolean;
  recordingVersion: number;
  maxMessages: number;
  countEdited: boolean;
}
interface RetainedDraft { draft: PeerDraft; base: PeerDraft }
const drafts = new Map<string, RetainedDraft>();
function current(entry: ConversationView, settings: QQAgentSettings): PeerDraft {
  return { version: entry.policy.version, settings: structuredClone(settings), alias: entry.alias, receiveEnabled: entry.policy.receiveEnabled !== false,
    recordingVersion: entry.recording?.version ?? 0, maxMessages: entry.recording?.enabled ? entry.recording.maxMessages ?? 1000 : 0,
    countEdited: false };
}
function settingsChanged(base: PeerDraft, draft: PeerDraft): boolean {
  return base.alias !== draft.alias || base.receiveEnabled !== draft.receiveEnabled || JSON.stringify(base.settings) !== JSON.stringify(draft.settings);
}
function recordingChanged(base: PeerDraft, draft: PeerDraft, entry: ConversationView): boolean {
  return base.maxMessages !== draft.maxMessages || (draft.countEdited && entry.recording?.retentionDays !== 0);
}

export function QQPeerSettings({ entry, store, tools, selectorSource }: {
  entry: ConversationView; store: QQSessionStore; tools: readonly ToolCatalogEntry[]; selectorSource: SelectorSource;
}): ReactNode {
  if (!entry.settings) return h('p', { role: 'status', className: 'imqc-hint' }, '会话设置暂不可用，请刷新 QQ 目录。');
  return h(PeerSettingsDraft, { key: entry.key, entry, settings: entry.settings, store, tools, selectorSource });
}

function PeerSettingsDraft({ entry, settings, store, tools, selectorSource }: {
  entry: ConversationView; settings: QQAgentSettings; store: QQSessionStore; tools: readonly ToolCatalogEntry[]; selectorSource: SelectorSource;
}): ReactNode {
  const [retained, setRetained] = useState<RetainedDraft>(() => drafts.get(entry.key) ?? (() => { const draft = current(entry, settings); return { draft, base: draft }; })());
  const { draft, base } = retained;
  const catalog = useQQAgentCatalog(selectorSource);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  const changedSettings = settingsChanged(base, draft);
  const changedRecording = recordingChanged(base, draft, entry);
  const dirty = changedSettings || changedRecording;
  const settingsConflict = base.version !== entry.policy.version;
  const recordingConflict = base.recordingVersion !== (entry.recording?.version ?? 0);
  const validCount = Number.isSafeInteger(draft.maxMessages) && draft.maxMessages >= 0 && draft.maxMessages <= 1_000_000;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (dirty) drafts.set(entry.key, retained); else drafts.delete(entry.key); }, [entry.key, retained, dirty]);
  useEffect(() => {
    if (!dirty && (settingsConflict || recordingConflict)) { const value = current(entry, settings); setRetained({ draft: value, base: value }); }
  }, [dirty, settingsConflict, recordingConflict, entry, settings]);
  const patch = (next: Partial<PeerDraft>): void => { setRetained(value => ({ ...value, draft: { ...value.draft, ...next } })); setError(''); setNotice(''); };
  const discard = (): void => { const value = current(entry, settings); setRetained({ draft: value, base: value }); drafts.delete(entry.key); setError(''); setNotice(''); };
  const admit = (): void => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    void store.perform({ action: 'admit', key: entry.key, enabled: true }).then(result => {
      if (mounted.current) setNotice(result.notice ?? '接入规则已保存，请等待目录确认接收状态。');
    }).catch((cause: unknown) => { if (mounted.current) setError(cause instanceof Error ? cause.message : '接入规则保存失败'); })
      .finally(() => { pending.current = false; if (mounted.current) setBusy(false); });
  };
  const save = (recordingOnly = false): void => {
    const saveSettings = changedSettings && !recordingOnly;
    const saveRecording = changedRecording;
    if (pending.current || (!saveSettings && !saveRecording) || (saveSettings && (entry.running || settingsConflict)) || (saveRecording && (!entry.recording || recordingConflict || !validCount))) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    const action = saveSettings
      ? { action: 'settings' as const, key: entry.key, expectedVersion: base.version, settings: draft.settings, alias: draft.alias, receiveEnabled: draft.receiveEnabled,
        ...(saveRecording ? { recording: { expectedVersion: base.recordingVersion, maxMessages: draft.maxMessages } } : {}) }
      : { action: 'recording' as const, key: entry.key, expectedVersion: base.recordingVersion, enabled: draft.maxMessages > 0, maxMessages: draft.maxMessages, retentionDays: 0 };
    void store.perform(action).then(result => {
      const saved = result.snapshot?.conversations.find(value => value.key === entry.key);
      if (!saved?.settings) throw new Error('保存结果未确认，草稿已保留。请刷新目录核对。');
      const value = current(saved, saved.settings);
      const next = recordingOnly && changedSettings ? { draft: { ...draft, recordingVersion: value.recordingVersion, maxMessages: value.maxMessages, countEdited: false }, base: { ...base, recordingVersion: value.recordingVersion, maxMessages: value.maxMessages } } : { draft: value, base: value };
      if (recordingOnly && changedSettings) drafts.set(entry.key, next); else drafts.delete(entry.key);
      if (mounted.current) { setRetained(next); setNotice(result.notice ?? (saveSettings ? '会话设置已保存。Agent 预设、工作目录和补充提示词在下次新会话生效。' : '记录数量已保存。')); }
    }).catch((cause: unknown) => { if (mounted.current) setError(cause instanceof Error ? cause.message : '保存失败，草稿已保留。'); })
      .finally(() => { pending.current = false; if (mounted.current) setBusy(false); });
  };
  return h('section', { className: 'imqc-peerSettings', 'aria-label': '会话设置', 'aria-busy': busy },
    h('div', { className: 'imqc-inline' }, h('span', null, '接收此 QQ 对话'), h(Switch, { label: '接收此 QQ 对话', checked: draft.receiveEnabled, disabled: busy, onChange: receiveEnabled => patch({ receiveEnabled }) })),
    !entry.admitted && entry.policy.receiveEnabled !== false ? h('div', { className: 'imqc-banner' }, h('p', { className: 'imqc-hint' }, '此对话当前未获接收许可。接收开关仍受账号访问范围约束；加入访问名单后才能接收。'),
      h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: admit }, '启用此对话并加入访问名单')) : null,
    h('label', { className: 'imqc-field' }, h('span', null, 'QQ 备注'), h(Input, { value: draft.alias, maxLength: 100, disabled: busy, 'aria-label': 'QQ 备注', onChange: (event: ChangeEvent<HTMLInputElement>) => patch({ alias: event.target.value }) })),
    h(QQAgentSettingsForm, { settings: draft.settings, tools, catalog, disabled: busy, onChange: value => patch({ settings: value }), onRefreshCatalog: catalog.refresh,
      askTools: Object.entries(entry.policy.tools).filter(([, decision]) => decision === 'ask').map(([id]) => id) }),
    h('label', { className: 'imqc-field' }, h('span', null, '保留消息记录条数'), h(Input, { type: 'number', min: 0, max: 1_000_000, step: 1, value: draft.maxMessages, disabled: busy || !entry.recording, 'aria-label': '保留消息记录条数', onChange: (event: ChangeEvent<HTMLInputElement>) => patch({ maxMessages: Number(event.target.value), countEdited: true }) })),
    h('p', { className: 'imqc-hint' }, '仅保留实际收到的 QQ 消息和机器人投递正文，按总条数保留，不按天过期。0 表示停止新增记录，已有记录保留。'),
    entry.recording?.retentionDays ? h('p', { className: 'imqc-hint' }, `现有记录仍使用 ${entry.recording.retentionDays} 天期限；编辑并保存记录数量后改为仅按条数保留。`) : null,
    entry.recordingError ? h('p', { role: 'alert', className: 'imqc-error' }, entry.recordingError) : null,
    h('p', { className: 'imqc-hint' }, 'Agent 预设、工作目录和补充提示词在下次新会话生效。保存不会开始任务；模型和当前权限仍可在原生输入区调整。'),
    h(Button, { variant: 'outline', size: 'sm', disabled: busy || entry.running || !entry.admitted, onClick: () => store.openOperation(entry, 'new') }, '新建会话…'),
    entry.running ? h('p', { role: 'status', className: 'imqc-hint' }, '任务运行中，可继续编辑草稿；任务结束后再保存会话设置。消息记录数量可独立保存。') : null,
    settingsConflict && changedSettings || recordingConflict && changedRecording ? h('p', { role: 'alert', className: 'imqc-error' }, '设置已在其他位置更新。草稿保留，请放弃修改以载入最新设置。') : null,
    !validCount ? h('p', { role: 'alert', className: 'imqc-error' }, '记录条数必须是 0 到 1000000 之间的整数。') : null,
    error ? h('p', { role: 'alert', className: 'imqc-error' }, error) : null,
    notice ? h('p', { role: 'status', className: 'imqc-hint' }, notice) : null,
    h('div', { className: 'imqc-actions imqc-saveBar' },
      h(Button, { variant: 'ghost', size: 'sm', disabled: busy || !dirty, onClick: discard }, '放弃修改'),
      h(Button, { variant: 'primary', size: 'sm', disabled: busy || !dirty || (changedSettings && (entry.running || settingsConflict)) || (changedRecording && (!validCount || recordingConflict || !entry.recording)), onClick: () => save() }, busy ? '保存中…' : '保存会话设置'),
      changedRecording && changedSettings && entry.running ? h(Button, { variant: 'outline', size: 'sm', disabled: busy || !validCount || recordingConflict || !entry.recording, onClick: () => save(true) }, '仅保存记录数量') : null,
      h('span', { role: 'status', className: 'imqc-hint' }, dirty ? '有未保存修改。' : '已保存。')));
}
