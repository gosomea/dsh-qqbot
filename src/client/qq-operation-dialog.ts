import { createElement as h, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client';
import { parseAgentPresets, type PresetChoice, type SelectorSource } from './host-selectors.ts';
import { QQSelect, qqWorkspaceTitle } from './qq-controls.ts';
import { QQSessionStore, useQQSessionStore, type QQNavigationIntent, type QQOperationTarget } from './qq-session-store.ts';

/** Workspace and preset are committed together under one guarded operation identity. */
export function QQOperationDialog({ target, store, workspaces, selectorSource, defaultWorkspaceName }: {
  target: QQOperationTarget; store: QQSessionStore; workspaces: WorkspaceSnapshot['items']; selectorSource: SelectorSource; defaultWorkspaceName: string;
}): ReactNode {
  useQQSessionStore(store);
  const entry = store.conversation(target.key);
  const currentWorkspaceId = target.workspaceId ?? workspaces.find(workspace => workspace.sessionIds.some(id => id === target.sessionId))?.workspaceId ?? '';
  const [workspaceId, setWorkspaceId] = useState(currentWorkspaceId);
  const [presetId, setPresetId] = useState(target.presetId ?? '');
  const [presets, setPresets] = useState<PresetChoice[]>([]);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const pending = useRef(false); const operationId = useRef(crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const intent = useRef<QQNavigationIntent | null>(null);
  useEffect(() => () => intent.current?.cancel(), []);
  useEffect(() => {
    let active = true;
    void selectorSource.listAgentPresets().then(parseAgentPresets).then(items => { if (active) setPresets(items); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : '无法读取预设'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [selectorSource]);
  const close = (): void => { intent.current?.cancel(); store.closeDrawer(); };
  const changed = entry?.currentSessionId !== target.sessionId || entry?.policy.version !== target.policyVersion;
  const allowedPresets = entry?.selectablePresets ?? entry?.policy.allowedPresets ?? [];
  const authorityMissing = entry?.selectablePresets === undefined && !entry?.policy.allowedPresets.length;
  const workspaceAvailable = workspaces.some(workspace => workspace.workspaceId === workspaceId);
  const presetAvailable = allowedPresets.includes(presetId) && presets.some(preset => preset.id === presetId && !preset.broken);
  const disabled = busy || loading || !entry?.admitted || entry.running || changed || !workspaceAvailable || !presetAvailable;
  const submit = (event: FormEvent): void => {
    event.preventDefault(); if (disabled || pending.current || !entry) return;
    pending.current = true; setBusy(true); setError(null);
    const navigation = store.navigationIntent(); intent.current = navigation;
    void store.perform({ action: 'create-session', key: target.key, operationId: operationId.current, expectedCurrentSessionId: target.sessionId,
      expectedPolicyVersion: target.policyVersion, workspaceId, presetId }).then(result => {
      if (!navigation.current()) return;
      const outcome = store.openActionResult(navigation, result, target.key);
      if (outcome === 'opened') close(); else if (outcome === 'unavailable') setError('会话操作已完成，请刷新目录确认当前会话。');
    }).catch((cause: unknown) => { if (navigation.current()) setError(cause instanceof Error ? cause.message : '新建失败；重试仍使用同一操作编号。'); })
      .finally(() => { pending.current = false; setBusy(false); });
  };
  return h(Modal, { open: true, onClose: close, title: '新建 QQ 会话', closeLabel: '关闭', className: 'imqq-editModal', children:
    h('form', { className: 'imqq-editForm', onSubmit: submit },
      h('p', { className: 'imqq-dialogHint' }, target.name),
      h('p', { className: 'imqq-dialogHint' }, '工作区和 Agent 预设默认使用当前值。确认后 QQ 新消息进入新会话，旧历史保留；此操作不提交提问。'),
      !currentWorkspaceId ? h('p', { role: 'status', className: 'imqq-dialogHint' }, '当前会话尚未绑定可用的 DSH 工作区，请为新会话选择工作区。') : null,
      h('label', { className: 'imqc-field' }, h('span', null, '工作区'), h(QQSelect, { label: '新 QQ 会话的工作区', value: workspaceId, onChange: setWorkspaceId, disabled: busy, placeholder: '选择工作区', options: workspaces.map(workspace => ({ value: workspace.workspaceId, label: `${qqWorkspaceTitle(workspace.title, workspace.path, defaultWorkspaceName)}${workspace.workspaceId === currentWorkspaceId ? '（当前）' : ''}`, description: workspace.path })) })),
      h('label', { className: 'imqc-field' }, h('span', null, 'Agent 预设'), h(QQSelect, { label: '新 QQ 会话的 Agent 预设', value: presetId, onChange: setPresetId, disabled: busy || loading, placeholder: loading ? '读取预设…' : '选择 Agent 预设', options: presets.map(preset => ({ value: preset.id, label: preset.name, description: preset.broken ?? (!allowedPresets.includes(preset.id) ? '此对话未授权' : preset.description), disabled: Boolean(preset.broken) || !allowedPresets.includes(preset.id) })) })),
      authorityMissing ? h('p', { role: 'status', className: 'imqq-dialogHint' }, '未取得此对话继承的预设授权，请刷新 QQ 目录后重试。') : null,
      changed ? h('p', { role: 'alert', className: 'imqq-dialogHint' }, '当前 QQ 会话或策略已变化，请关闭后重新打开操作。') : entry?.running ? h('p', { className: 'imqq-dialogHint' }, '当前会话正在回复，结束后可新建会话。') : !entry?.admitted ? h('p', { className: 'imqq-dialogHint' }, '请先授权此 QQ 对话。') : null,
      workspaces.length === 0 ? h('p', { role: 'status', className: 'imqq-dialogHint' }, '还没有可用工作区，请先在 DSH 工作区导航中添加工作区。') : null,
      error ? h('p', { role: 'alert', className: 'imqq-error' }, error) : null,
      h('div', { className: 'imqq-dialogActions' }, h(Button, { variant: 'ghost', size: 'sm', onClick: close }, '取消'), h(Button, { type: 'submit', variant: 'primary', size: 'sm', disabled }, busy ? '新建中…' : '确认新建会话'))) });
}
