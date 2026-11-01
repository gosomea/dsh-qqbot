import { createElement as h, useEffect, useRef, useState, type ReactNode, type ChangeEvent } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { ConversationView, DeliveryRecord } from '../shared/conversation-protocol.ts';
import { splitLines } from './conversation-state.ts';
import type { RuntimeStateWire } from '../shared/runtime-protocol.ts';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { BindPanelBody, QQ_BOT_LOGO_PATH, useBindState } from './bind-page.ts';
import { type SelectorSource } from './host-selectors.ts';
import { QQConversationView } from './qq-conversation-view.ts';
export { QQConversationView } from './qq-conversation-view.ts';
import { QQOperationDialog } from './qq-operation-dialog.ts';
import { deliveryExplanation, deliverySummary, passiveReplyFeedback } from './delivery-feedback.ts';
import { QQSessionStore, useQQSessionStore, type QQAnswerPreview } from './qq-session-store.ts';

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
  const resumable = store.resumeSessionId();
  return h('section', { className: 'imqc imqq-welcome', 'aria-label': 'QQ 会话' },
    h('svg', { viewBox: '0 0 24 24', 'aria-hidden': true }, h('path', { d: QQ_BOT_LOGO_PATH, fill: 'currentColor' })),
    h('h3', null, 'QQ 会话'),
    h('p', { className: 'imqc-state', role: 'status' }, directory.runtime ? PHASE_LABELS[directory.runtime.phase] : '读取连接状态…'),
    h('p', { className: 'imqc-hint' }, entries.length ? '在左侧选择群聊或联系人，继续当前会话或查看历史。' : '收到 QQ 消息后，群聊和联系人会出现在左侧。可先管理账号和授权范围。'),
    h('p', { className: 'imqc-hint' }, '会话使用原生聊天页的输入框、模型和权限控件。选择目录中的对话不会自动创建任务。'),
    bind.state?.phase !== 'bound' ? h(BindPanelBody, bind) : null,
    directory.error ? h('p', { className: 'imqc-error', role: 'alert' }, directory.error) : null,
    h('div', { className: 'imqq-welcomeActions' },
      resumable ? h(Button, { variant: 'outline', size: 'sm', onClick: () => store.openSession(resumable) }, '继续 QQ 会话') : null,
      h(Button, { variant: 'outline', size: 'sm', onClick: onOpenSettings }, '账号设置')));
}

export function QQAccountOwners({ store }: { store: QQSessionStore }): ReactNode {
  const directory = useQQSessionStore(store);
  const [ownersOpen, setOwnersOpen] = useState(false);
  const [owners, setOwners] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const ready = directory.directory !== null && !directory.loading && directory.error === null;
  return h('section', { className: 'imqc', 'aria-label': 'QQ 所有者' }, h('h3', null, 'QQ 所有者'),
    h('p', { className: 'imqc-hint' }, ready ? `${directory.directory?.ownerIds.length} 个所有者 OpenID。所有者可管理群聊和私聊的授权。` : directory.error ? '无法读取所有者名单，请刷新后重试。' : '正在读取所有者名单…'),
    h(Button, { variant: 'outline', size: 'sm', disabled: busy || !ready, onClick: () => { setOwnersOpen(!ownersOpen); setOwners((directory.directory?.ownerIds ?? []).join('\n')); } }, ownersOpen ? '取消编辑' : '编辑所有者'),
    ownersOpen ? h('div', { className: 'imqc-preview' }, h('p', { className: 'imqc-hint' }, 'QQ 所有者 OpenID，每行一个'),
      h('textarea', { rows: 3, disabled: busy || !ready, value: owners, 'aria-label': '机器人所有者 OpenID', onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setOwners(event.target.value) }),
      error ? h('p', { className: 'imqc-error', role: 'alert' }, error) : null,
      h(Button, { variant: 'outline', size: 'sm', disabled: busy || !ready, onClick: () => { if (pending.current || !ready) return; pending.current = true; setBusy(true); setError(null); void store.perform({ action: 'owners', ownerIds: splitLines(owners) }).then(() => setOwnersOpen(false)).catch((cause: unknown) => setError(errorMessage(cause))).finally(() => { pending.current = false; setBusy(false); }); } }, busy ? '保存中…' : '保存')) : null,
    !ready ? h(Button, { variant: 'ghost', size: 'sm', disabled: directory.loading, onClick: store.refresh }, directory.loading ? '读取中…' : '刷新所有者名单') : null);
}

function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : '操作失败'; }
function usePassiveReplyFeedback(passiveReply: ConversationView['passiveReply']): ReturnType<typeof passiveReplyFeedback> {
  const [now, setNow] = useState(Date.now);
  const expiresAt = passiveReply?.expiresAt;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = (): void => {
      const current = Date.now();
      setNow(current);
      if (expiresAt !== undefined && expiresAt !== null && expiresAt > current) timer = setTimeout(update, Math.min(1000, expiresAt - current));
    };
    update();
    return () => { if (timer !== undefined) clearTimeout(timer); };
  }, [expiresAt]);
  return passiveReplyFeedback(passiveReply, now);
}
export function QQConversationOverlay({ store, selectorSource, useWorkspaces, useSessions, defaultWorkspaceName }: { store: QQSessionStore; selectorSource: SelectorSource; defaultWorkspaceName: string; useWorkspaces: PropsRuntime<'shell.overlay'>['useWorkspaces']; useSessions?: PropsRuntime<'shell.overlay'>['useSessions'] }): ReactNode {
  const state = useQQSessionStore(store);
  const workspaces = useWorkspaces((snapshot) => snapshot.items);
  const overlay = state.overlay;
  if (overlay?.kind === 'drawer') {
    const target = overlay.target;
    const entry = store.conversation(target.key);
    return h(Modal, { key: `${target.key}/${target.sessionId}`, title: `${target.name} · QQ 设置`, open: true, closeLabel: '关闭', className: 'imqq-settingsModal', onClose: store.closeDrawer,
      children: entry ? h(QQConversationView, { sessionId: target.sessionId, conversationKey: target.key, initialTab: target.tab, store, selectorSource, useSessions, useWorkspaces, defaultWorkspaceName }) : h('p', { role: 'alert' }, '此 QQ 对话已不可用，请刷新目录。') });
  }
  if (overlay?.kind === 'operation') return h(QQOperationDialog, { key: `${overlay.target.kind}/${overlay.target.key}`, target: overlay.target, store, selectorSource, workspaces, defaultWorkspaceName });
  if (overlay?.kind === 'answer') return h(Modal, { key: overlay.preview.operationId, title: `发送到 ${overlay.preview.name}`, open: true, closeLabel: '关闭', className: 'imqq-answerPreview', onClose: store.closePreview, children: h(AnswerPreview, { preview: overlay.preview, store }) });
  return null;
}

function AnswerPreview({ preview, store }: { preview: QQAnswerPreview; store: QQSessionStore }): ReactNode {
  useQQSessionStore(store);
  const replyFeedback = usePassiveReplyFeedback(store.conversation(preview.key)?.passiveReply);
  const [busy, setBusy] = useState(false);
  const [delivery, setDelivery] = useState<DeliveryRecord | null>(null);
  const [attempted, setAttempted] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const valid = store.canSend(preview);
  return h('div', null, h('p', { className: 'imqc-hint' }, `目标 ${preview.name} · 会话 ${preview.sessionId.slice(-8)}`), h('p', { className: 'imqc-hint' }, replyFeedback.summary), h('p', { className: 'imqc-hint' }, '仅发送以下最终回答。'), h('pre', { className: 'imqc-messageText' }, preview.text),
    !valid ? h('p', { role: 'alert', className: 'imqc-error' }, '此对话的授权或当前会话已变化，请关闭预览并重新选择回答。') : null,
    error ? h('p', { role: 'alert', className: 'imqc-error' }, error) : null,
    delivery ? h('div', { role: 'status' }, h('p', null, deliverySummary(delivery)), h('p', { className: 'imqc-hint' }, deliveryExplanation(delivery)), delivery.error ? h('p', { className: 'imqc-error' }, delivery.error) : null) : null,
    h(Button, { variant: 'primary', size: 'sm', disabled: busy || !valid || attempted, onClick: () => {
      if (!store.canSend(preview) || pending.current || attempted) return;
      pending.current = true; setAttempted(true); setBusy(true); setError(null);
      void store.sendAnswer(preview).then((result) => { if (result.delivery) setDelivery(result.delivery); else setError('未确认发送结果，请查看发送记录。'); }).catch((cause: unknown) => setError(`发送结果未确认：${errorMessage(cause)}。请查看发送记录并核对 QQ，本次操作不会重发。`)).finally(() => { pending.current = false; setBusy(false); });
    } }, busy ? '提交中…' : attempted ? '本次发送已提交' : replyFeedback.sendLabel));
}
