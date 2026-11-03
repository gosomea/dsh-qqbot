import { createElement as h, type ReactNode } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';

import type { RuntimeStateWire } from '../shared/runtime-protocol.ts';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { BindPanelBody, QQ_BOT_LOGO_PATH, useBindState } from './bind-page.ts';
import { type SelectorSource } from './host-selectors.ts';
import { QQConversationView } from './qq-conversation-view.ts';
export { QQConversationView } from './qq-conversation-view.ts';
import { QQOperationDialog } from './qq-operation-dialog.ts';

import { QQSessionStore, useQQSessionStore } from './qq-session-store.ts';
import { PairClaimPanel } from './qq-pairing.ts';
import { SlashCommandList } from './slash-command-list.ts';

const PHASE_LABELS: Record<RuntimeStateWire['phase'], string> = { unbound: '等待绑定', connecting: '正在连接', ready: '已连接', reconnecting: '正在重连', failed: '连接失败', stopped: '已停止' };
export function activityLabel(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null || timestamp === 0) return '暂无活动';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
export interface ConversationPanelProps { onOpenSettings: () => void; store: QQSessionStore }

export function ConversationPanel({ onOpenSettings, store }: ConversationPanelProps): ReactNode {
  const bind = useBindState();
  const directory = useQQSessionStore(store);
  const entries = directory.directory?.conversations ?? [];
  const resumable = store.resumeTarget();
  return h('section', { className: 'imqc imqq-welcome', 'aria-label': 'QQ 会话' },
    h('svg', { viewBox: '0 0 24 24', 'aria-hidden': true }, h('path', { d: QQ_BOT_LOGO_PATH, fill: 'currentColor' })),
    h('div', { className: 'imqq-welcomeTitle' },
      h('h3', null, 'QQ 会话'),
      h('span', { className: 'imqc-state imqq-welcomeState', role: 'status' }, directory.runtime ? PHASE_LABELS[directory.runtime.phase] : '读取连接状态…')),
    h('p', { className: 'imqc-hint' }, entries.length ? '在左侧选择群聊或联系人，继续当前会话或查看历史。' : '收到 QQ 消息后，群聊和联系人会出现在左侧。可先管理账号和授权范围。'),
    h('p', { className: 'imqc-hint' }, '会话使用原生聊天页的输入框、模型和权限控件。选择目录中的对话不会自动创建任务。'),
    bind.state?.phase !== 'bound' ? h(BindPanelBody, bind) : null,
    directory.error ? h('p', { className: 'imqc-error', role: 'alert' }, directory.error) : null,
    h('div', { className: 'imqq-welcomeActions' },
      resumable ? h(Button, { variant: 'outline', size: 'sm', onClick: () => store.openSession(resumable.sessionId) }, `继续与「${resumable.name}」的会话`) : null,
      h(Button, { variant: 'outline', size: 'sm', onClick: onOpenSettings }, '账号设置')),
    resumable ? h('p', { className: 'imqc-hint' }, `「继续」会打开最近活跃对话「${resumable.name}」的当前会话；要开新会话，请在左侧该对话的「＋」或菜单里新建。`) : null);
}

export function QQAccountOwners({ store, t, bound = true }: { store: QQSessionStore; t?: import('./qq-locale.ts').QQTranslate; bound?: boolean }): ReactNode {
  const title = t ? t('owners.title') : '斜杠命令超管';
  const commands = useQQSessionStore(store).directory?.commands ?? [];
  return h('section', { className: 'imqc', 'aria-label': title },
    h(PairClaimPanel, { purpose: 'owner', title, enabled: bound,
      description: t ? t('owners.hint') : '所有 QQ 斜杠命令仅限此名单中的全局超管使用，名单对所有已启用且获准接入的 QQ 对话生效。不开放额外工具，不绕过执行权限。审批和提问按钮仍按原权限处理；DSH 网页斜杠命令不受此名单限制。',
      hint: '点「添加…」生成一次性配对码，然后在 QQ 里直接给机器人发送这个码；对方点「确认」后即可加入。' }),
    commands.length > 0 ? h(SlashCommandList, { commands }) : null);
}

export function QQConversationOverlay({ store, selectorSource, t, useWorkspaces, useSessions, defaultWorkspaceName }: { store: QQSessionStore; selectorSource: SelectorSource; t: import('./qq-locale.ts').QQTranslate; defaultWorkspaceName: string; useWorkspaces: PropsRuntime<'shell.overlay'>['useWorkspaces']; useSessions?: PropsRuntime<'shell.overlay'>['useSessions'] }): ReactNode {
  const state = useQQSessionStore(store);
  const workspaces = useWorkspaces((snapshot) => snapshot.items);
  const overlay = state.overlay;
  if (overlay?.kind === 'drawer') {
    const target = overlay.target;
    const entry = store.conversation(target.key);
    return h(Modal, { key: `${target.key}/${target.sessionId}`, title: `${target.name} · QQ 设置`, open: true, closeLabel: '关闭', className: 'imqq-settingsModal', contentClassName: 'imqq-settingsContent', onClose: store.closeDrawer,
      children: entry ? h(QQConversationView, { sessionId: target.sessionId, conversationKey: target.key, initialTab: target.tab, store, selectorSource, t, useSessions, useWorkspaces, defaultWorkspaceName }) : h('p', { role: 'alert' }, '此 QQ 对话已不可用，请刷新目录。') });
  }
  if (overlay?.kind === 'operation') return h(QQOperationDialog, { key: `${overlay.target.kind}/${overlay.target.key}`, target: overlay.target, store, selectorSource, workspaces, defaultWorkspaceName });
  return null;
}
