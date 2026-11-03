import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';

import type {} from '@deepseek-ai/dsh-agent-preset-registry/types';
import type {} from '@deepseek-ai/dsh-permission-presets/types';
import type { SelectorSource } from './host-selectors.ts';
import type { QQTranslate } from './qq-locale.ts';
import { QQSessionStore, useQQSessionStore, type QQDrawerTab } from './qq-session-store.ts';
import { conversationName } from './conversation-state.ts';

export function QQConversationView({ sessionId, store, t, useSessions, useProjection, conversationKey, initialTab }: {
  sessionId: string | null; store: QQSessionStore; selectorSource: SelectorSource; t: QQTranslate; conversationKey?: string; initialTab?: QQDrawerTab;
  useSessions?: PropsRuntime<'conversation.view'>['useSessions']; useWorkspaces?: PropsRuntime<'conversation.view'>['useWorkspaces']; useProjection?: PropsRuntime<'conversation.view'>['useProjection']; defaultWorkspaceName?: string;
}): ReactNode {
  const state = useQQSessionStore(store);
  const summaries = useSessions?.(snapshot => snapshot.byId) ?? {};
  const projectedPreset = useProjection?.('agentPreset');
  const projectedPermissions = useProjection?.('permissions');
  const summary = sessionId ? summaries[SessionId(sessionId)] : undefined;
  const nativePreset = projectedPreset !== undefined ? projectedPreset : summary?.projectionValues?.agentPreset;
  const nativePermission = (projectedPermissions ?? summary?.projectionValues?.permissions)?.currentValue;
  const rootRef = useRef<HTMLElement | null>(null);
  const entry = conversationKey ? store.conversation(conversationKey) : sessionId ? store.entry(sessionId) : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unarchive, setUnarchive] = useState(false);
  const activeKey = useRef(entry?.key);
  activeKey.current = entry?.key;
  useEffect(() => { setError(''); setUnarchive(false); }, [sessionId, conversationKey, initialTab]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.scrollTop = 0;
    const view = root.ownerDocument.defaultView;
    for (let parent = root.parentElement; parent; parent = parent.parentElement) {
      const overflow = view?.getComputedStyle(parent).overflowY;
      if (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden') parent.scrollTop = 0;
    }
  }, [sessionId, conversationKey, entry?.key]);
  if (!entry) return h('section', { ref: rootRef, className: 'imqc imqc-full' }, h('p', { role: 'status' }, '正在读取 QQ 对话…'));
  const historical = sessionId !== null && entry.currentSessionId !== sessionId;
  const restore = (): void => {
    if (busy || !entry.currentSessionId) return;
    const key = entry.key;
    setBusy(true); setError('');
    void store.perform({ action: 'unarchive', key, sessionId: entry.currentSessionId }).then(() => { if (activeKey.current === key) setUnarchive(false); })
      .catch((cause: unknown) => { if (activeKey.current === key) setError(cause instanceof Error ? cause.message : '取消归档失败'); })
      .finally(() => { if (activeKey.current === key) setBusy(false); });
  };
  return h('section', { ref: rootRef, className: 'imqc imqc-settingsView', 'aria-label': t('view.settings.title') },
    h('header', { className: 'imqc-viewHeading' }, h('h3', null, conversationName(entry)), h('span', { className: 'imqc-hint' }, entry.scope === 'group' ? 'QQ 群聊' : 'QQ 私聊')),
    error ? h('p', { className: 'imqc-error', role: 'alert' }, error) : null,
    state.directory?.errors?.map(message => h('p', { key: message, role: 'alert', className: 'imqc-error' }, message)),
    h('div', { className: 'imqc-body' },
      historical
        ? h('div', { className: 'imqc-banner', role: 'status' }, h('strong', null, '这是历史会话，设置只读'),
          h('p', null, '历史会话的实际配置以原生轨迹为准。QQ 新消息进入当前会话。'),
          h('p', { className: 'imqc-hint' }, `此会话 Agent 预设：${nativePreset === undefined ? '未读取' : nativePreset ?? '未配置'}；权限：${nativePermission ?? '未读取'}。`),
          entry.currentSessionId ? h(Button, { variant: 'outline', size: 'sm', onClick: () => store.openSession(entry.currentSessionId ?? '') }, '返回当前会话') : null)
        : h('div', null,
          entry.archived ? h('div', { className: 'imqc-banner', role: 'status' }, h('strong', null, '当前 QQ 会话已归档'), h('p', null, '取消归档后继续接收，或新建会话。'),
            h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => setUnarchive(true) }, '取消归档继续…'),
            unarchive ? h('div', { className: 'imqc-actions' }, h('p', null, '确认取消归档并让 QQ 消息继续进入此会话？'), h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: restore }, '确认取消归档'), h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => setUnarchive(false) }, '取消')) : null) : null,
          h(Button, {variant:'outline', size:'sm', disabled: !entry.admitted || entry.running, onClick:()=>store.openOperation(entry)}, '新建 QQ 会话'))));
}
