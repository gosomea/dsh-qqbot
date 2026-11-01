import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ToolCallId, UserMessage } from '@deepseek-ai/dsh-llm';
import type { HumanReply, QQOperation } from './qq-operations.ts';
import { QQOperations, payloadHash } from './qq-operations.ts';
import { classifyTurn, classifyTurnInputs } from './qq-turn.ts';
import { SessionId } from '@deepseek-ai/dsh-session';
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-permission-presets';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { ConversationStore } from '../conversations/index.ts';
import { defaultPolicy, validatePolicy, validatePolicyTools, catalogTools, installPolicy, toolCatalogEntry } from '../policy/index.ts';
import type { ConversationEntry, ConversationPolicy, ConversationSnapshot, ToolCatalogEntry, DeliveryRecord, GroupMessageRecord } from '../shared/conversation-protocol.ts';
import { PLUGIN_HOME, resolveAgentCwd } from '../shared/dirs.ts';
import { getProfileDir } from '../shared/index.ts';
import { updateProfileConfig } from '../setup/persist.ts';
import type { SessionManager } from '../session/session-manager.ts';
import type { SessionRecord, DshAgent } from '../session/types.ts';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { QQBotSender } from '../transport/outbound-buffer.ts';
import { ConversationIngressQueue, ConversationQueue } from './conversation-queue.ts';
import { nativeSession } from './native-channel.ts';
import { chunkMarkdownText } from '../transport/chunker.ts';
import { getCachedReplySources } from '../transport/msgid-cache.ts';
import { OperationRetention } from './operation-retention.ts';
import { SessionOperations } from './session-operations.ts';
import { redactRecordingText } from './recording-redaction.ts';
import { deliveryFailure, DeliveryNotSubmittedError } from './delivery-error.ts';
import { defaultQQAgentSettings, validateQQAgentSettings, type QQAgentSettings } from '../shared/agent-settings.ts';
import { permissionSandbox } from '../shared/policy-settings.ts';

/** Owns channel intent independently from the lifetime of an activated Agent. */
export class ConversationService {
  readonly store: ConversationStore;
  readonly selfIds = new Set<string>();
  readonly queue = new ConversationQueue();
  readonly ingestion = new ConversationIngressQueue();
  readonly operations: QQOperations;
  private readonly sessionOperations: SessionOperations;
  private readonly operationRetention = new OperationRetention();
  private readonly outboundContext = new AsyncLocalStorage<{ provenance: 'command' | 'interaction' | 'sdk'; sourceMessageId?: string }>();
  private readonly outboundTracking = new AsyncLocalStorage<boolean>();
  withOutboundContext<T>(context: { provenance: 'command' | 'interaction' | 'sdk'; sourceMessageId?: string }, send: () => T): T { return this.outboundContext.run(context, send); }
  withTrackedSend<T>(send: () => T): T { return this.outboundTracking.run(true, send); }
  private readonly inputWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly settling = new Map<string, Promise<void>>();
  private readonly activationFloor = new Map<string, number>();
  private readonly reservations = new Map<string, number>();
  reserveTrigger(key: string): () => void {
    this.reservations.set(key, (this.reservations.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.reservations.get(key) ?? 1) - 1;
      if (count) this.reservations.set(key, count); else this.reservations.delete(key);
    };
  }
  private readonly attached = new WeakSet<object>();
  private readonly policyDisposers = new Map<string, () => void>();
  private readonly catalogs = new Map<string, ToolCatalogEntry>();
  private readonly deliveryQueue = new ConversationQueue();
  private sender?: QQBotSender;
  private readonly commandAuthority = new AsyncLocalStorage<{scope: ChatScope; peerId: string; actor: string; webOwner: boolean; stopping: boolean}>();
  withCommandAuthority<T>(scope: ChatScope, peerId: string, actor: string, webOwner: boolean, stopping: boolean, action: () => Promise<T> | T): Promise<T> | T { return this.commandAuthority.run({scope, peerId, actor, webOwner, stopping}, action); }
  assertCommandAuthority(scope: ChatScope, peerId: string): void {
    const caller = this.commandAuthority.getStore(); if (!caller) return;
    if (caller.scope !== scope || caller.peerId !== peerId || !this.admitted(scope, peerId)) throw new Error('命令的对话权限已变更');
    if (!caller.webOwner && !(caller.stopping ? this.canStop(scope, peerId, caller.actor) : this.canManage(scope, peerId, caller.actor))) throw new Error('命令操作者的权限已撤销');
  }

  constructor(readonly ctx: Context, readonly manager: SessionManager, readonly config: ImQQBotConfig, readonly logger: Logger, dataDir = PLUGIN_HOME) {
    const operationDir = join(dataDir, `operations-${createHash('sha256').update(config.appId).digest('hex')}`);
    this.operations = new QQOperations(operationDir);
    this.sessionOperations = new SessionOperations(operationDir);
    this.store = new ConversationStore(dataDir, config.appId, { defaultPolicy: () => {
      const policy = defaultPolicy('chat', resolveAgentCwd(config.cwd));
      policy.requireMention = config.requireMention;
      const route = manager.getDefaultModel();
      policy.allowedModels = [`${route.provider}/${route.model}`];
      policy.allowedPresets = [manager.getDefaultPreset?.() || 'standard'];
      return policy;
    }, defaultSettings: () => ({ ...defaultQQAgentSettings(), preset: config.preset?.trim() || '', model: config.provider && config.model ? { provider: config.provider, model: config.model } : null, cwd: config.cwd || '', prompt: config.groupPrompt || config.directPrompt || '' }),
      resolveSettings: settings => ({ ...settings, preset: settings.preset || manager.getDefaultPreset?.() || '', model: settings.model ?? manager.getDefaultModel(), cwd: settings.cwd || resolveAgentCwd(config.cwd) }),
      projectSettings: entry => ({ ...defaultQQAgentSettings(), preset: manager.getEffectivePreset?.(entry.scope, entry.peerId) || manager.getDefaultPreset?.() || config.preset || '', model: manager.getEffectiveModel?.(entry.scope, entry.peerId) ?? manager.getDefaultModel(), cwd: entry.policy.cwd || resolveAgentCwd(config.cwd), prompt: [(entry.scope === 'group' ? config.groupPrompt : config.directPrompt), this.describeRole(entry.policy.role)].filter(Boolean).join('\n'), execution: entry.policy.nativeTools === true ? { kind: 'native', permission: entry.policy.resources.sandbox } : { kind: 'custom', permission: entry.policy.resources.sandbox, tools: Object.entries(entry.policy.tools).filter(([, decision]) => decision !== 'deny').map(([id]) => id) } }),
    });
    this.store.migratePrefs();
    this.selfIds.add(config.appId);
    for (const entry of this.store.list()) for (const row of entry.sessions) {
      const session = ctx.get('sessions')?.get(SessionId(row.sessionId));
      if (session) this.activationFloor.set(row.sessionId, session.snapshotEvents().length - 1);
    }
    ctx.on('agent/created', ({ agent }) => {
      const entry = this.conversationForSession(agent.id);
      if (entry) { this.activationFloor.set(agent.id, agent.session.snapshotEvents().length - 1); this.guardAgent(agent, entry.key); }
      return undefined;
    }, { global: true, prepend: true });
  }
  async activityRecord(key: string, sender: string, target: ReplyTarget, withinQueue = false): Promise<SessionRecord> {
    return this.ingestion.run(key, async () => {
      let entry = this.requireEntry(key);
      this.assertNotArchived(entry);
      let record = await this.manager.getOrCreate(entry.scope, entry.peerId, sender, target);
      entry = this.requireEntry(key);
      const row = entry.sessions.find(item => item.sessionId === record.sessionId);
      const count = row?.receivedMessages ?? 0;
      const policy = entry.lifecycle;
      const due = policy && ((policy.rotateDays > 0 && Date.now() - (row?.startedAt ?? Date.now()) >= policy.rotateDays * 86_400_000) || (policy.maxMessages > 0 && count >= policy.maxMessages));
      if (due && !this.reservations.get(key) && (withinQueue || this.queue.pending(key) === 0) && record.agent.status !== 'running' && !record.agent.inbox?.nextTurn.length && !record.agent.inbox?.nextStep.length) {
        await this.manager.remove(entry.scope, entry.peerId);
        record = await this.manager.getOrCreate(entry.scope, entry.peerId, sender, target);
      }
      await this.reconcileBackground(record);
      return record;
    });
  }
  setSender(sender: QQBotSender): void { this.sender = sender; }
  admitted(scope: ChatScope, peerId: string): boolean {
    const mode = scope === 'group' ? this.config.access.groupMode : this.config.access.c2cMode;
    const allow = scope === 'group' ? this.config.access.groupAllow : this.config.access.c2cAllow;
    const enabled = this.store.get(this.store.key(scope, peerId))?.policy.receiveEnabled !== false;
    return enabled && (mode === 'open' || (mode === 'allowlist' && allow.includes(peerId)));
  }
  setAdmission(key: string, enabled: boolean): boolean {
    let entry = this.requireEntry(key);
    this.assertCommandAuthority(entry.scope, entry.peerId);
    if (!enabled) {
      this.updatePolicy(key, entry.policy.version, { ...entry.policy, receiveEnabled: false }, entry.alias);
      return false;
    }
    const access = this.config.access;
    const mode = entry.scope === 'group' ? access.groupMode : access.c2cMode;
    const allow = entry.scope === 'group' ? access.groupAllow : access.c2cAllow;
    const globalAllowed = mode === 'open' || (mode === 'allowlist' && allow.includes(entry.peerId));
    if (!globalAllowed) {
      // Keep the local gate closed across the non-atomic profile/policy writes.
      if (entry.policy.receiveEnabled !== false) {
        this.updatePolicy(key, entry.policy.version, { ...entry.policy, receiveEnabled: false }, entry.alias);
        entry = this.requireEntry(key);
      }
      const profile = getProfileDir();
      const next = [...new Set([...(mode === 'disabled' ? [] : allow), entry.peerId])];
      const patch: ImQQBotConfig['access'] = entry.scope === 'group'
        ? { ...access, groupMode: 'allowlist', groupAllow: next }
        : { ...access, c2cMode: 'allowlist', c2cAllow: next };
      if (!profile || !updateProfileConfig({ access: patch }, profile, this.logger)) {
        throw new Error(`全局访问配置保存失败${profile ? '' : '（未找到可写的部署配置）'}，此 QQ 对话仍停用；已取消的任务不会恢复。`);
      }
      this.config.access = patch;
    }
    try {
      entry = this.store.ensure(entry.scope, entry.peerId, { admitted: true });
      this.updatePolicy(key, entry.policy.version, { ...entry.policy, receiveEnabled: true }, entry.alias);
    } catch (error) {
      const current = this.requireEntry(key);
      const state = current.policy.receiveEnabled === false ? '此 QQ 对话仍停用' : '此 QQ 对话的接收开关已保存';
      throw new Error(`${globalAllowed ? '' : '全局访问配置已保存，'}${state}；启用未完成：${error instanceof Error ? error.message : String(error)}。已取消的任务不会恢复。`, { cause: error });
    }
    return !globalAllowed;
  }
  ensure(scope: ChatScope, peerId: string, senderId?: string, senderName?: string): ConversationEntry {
    return this.store.ensure(scope, peerId, { senderId, senderName, admitted: this.admitted(scope, peerId) });
  }
  /** The synchronous capture transaction runs at the serialized ingress boundary. */
  recordInbound(key: string, message: GroupMessageRecord, trigger = false): { accepted: false } | { accepted: true; cursor: number; releaseTrigger: (() => void) | undefined } {
    const entry = this.requireEntry(key);
    if (!this.admitted(entry.scope, entry.peerId) || this.store.hasMessage(key, message.id)) return { accepted: false };
    if (!this.store.recordMessage(key, { ...message, ...(entry.currentSessionId ? { sessionId: entry.currentSessionId } : {}) })) return { accepted: false };
    if (!trigger && entry.currentSessionId) {
      const row = entry.sessions.find(item => item.sessionId === entry.currentSessionId);
      this.store.noteReceived(key, entry.currentSessionId, row?.receivedMessages ?? 0);
    }
    const { cursor } = this.store.snapshotBackground(key, message.id);
    if (entry.recording?.enabled || trigger) this.store.noteMessage(key, message.text, message.at);
    return { accepted: true, cursor, releaseTrigger: trigger ? this.reserveTrigger(key) : undefined };
  }
  entry(scope: ChatScope, peerId: string): ConversationEntry { return this.ensure(scope, peerId); }
  isOwner(actor?: string): boolean { return !!actor && this.store.ownerIds().includes(actor); }
  slashAllowed(scope: ChatScope, peerId: string, actor?: string): boolean { return this.isOwner(actor) || this.entry(scope, peerId).settings?.slashCommands !== false; }
  canManage(scope: ChatScope, peerId: string, actor?: string): boolean {
    if (!actor) return false;
    return this.isOwner(actor) || (scope === 'c2c' ? actor === peerId : this.entry(scope, peerId).policy.controllers.includes(actor));
  }
  canApprove(scope: ChatScope, peerId: string, actor?: string): boolean {
    return !!actor && (this.isOwner(actor) || this.entry(scope, peerId).policy.approvers.includes(actor));
  }
  canAnswer(scope: ChatScope, peerId: string, actor?: string): boolean {
    const record = this.manager.getSessionRecord(scope, peerId);
    return !!actor && (actor === (record ? this.interactionRecord(record.sessionId)?.senderId : undefined) || this.canManage(scope, peerId, actor));
  }
  canStop(scope: ChatScope, peerId: string, actor?: string): boolean { return this.canAnswer(scope, peerId, actor); }
  validateSelection(scope: ChatScope, peerId: string, kind: 'model' | 'preset', value: string): void {
    this.assertCommandAuthority(scope, peerId);
    // Native conversations follow the selected Agent; only restricted (custom-tool) policies carry an allowlist ceiling.
    if (this.entry(scope, peerId).policy.nativeTools !== false) return;
    if (!this.allowedSelections(scope, peerId, kind).includes(value)) throw new Error(`该会话未授权${kind === 'model' ? '模型' : '预设'}：${value}，请由所有者在对话设置中配置。`);
  }
  allowedSelections(scope: ChatScope, peerId: string, kind: 'model' | 'preset'): readonly string[] {
    const policy = this.entry(scope, peerId).policy;
    const allowed = kind === 'model' ? policy.allowedModels : policy.allowedPresets;
    if (allowed.length) return allowed;
    const fallback = kind === 'model' ? this.manager.getDefaultModel() : undefined;
    return [fallback ? `${fallback.provider}/${fallback.model}` : this.manager.getDefaultPreset?.() || this.config.preset || 'standard'];
  }
  attach(record: SessionRecord, workspaceId?: string, presetId?: string): void {
    const entry = this.ensure(record.scope, record.peerId, record.senderId);
    if (this.attached.has(record.agent)) { this.store.bindSession(entry.key, record.sessionId, workspaceId, record.agent.session.header?.cwd, presetId); return; }
    if (!this.activationFloor.has(record.sessionId)) this.activationFloor.set(record.sessionId, nativeSession(record).snapshotEvents().length - 1);
    this.refreshCatalog(record.agent);
    this.applyExecutionPolicy(record, entry.policy, !entry.sessions.some(row => row.sessionId === record.sessionId));
    this.policyDisposers.set(record.sessionId, installPolicy(record.agent.ctx, {
      agentId: record.sessionId,
      getPolicy: () => this.effectivePolicy(entry.key, record.sessionId),
      getCatalog: () => [...this.catalogs.values()],
      protectedDescendant: agent => this.protectedDescendant(entry.key, agent),
      onDenied: (tool: string, reason: string) => this.logger.warn(`QQ tool policy denied: ${tool} ${reason}`),
    }));
    this.store.bindSession(entry.key, record.sessionId, workspaceId, record.agent.session.header?.cwd, presetId);
    this.attached.add(record.agent);
  }
  private effectivePolicy(key: string, sessionId: string, record = this.manager.findBySessionId(sessionId)): ConversationPolicy {
    const entry = this.requireEntry(key);
    const policy = entry.policy;
    const permission = record ? this.currentPermission(record) : policy.permission;
    const permissionAllowed = record ? this.permissionAllowed(record) : policy.nativeTools === false ? policy.allowedPermissions.includes(permission) : !!permissionSandbox(policy.resources.sandbox);
    const tools = Object.fromEntries(Object.entries(policy.tools).map(([id, decision]) => [id, permissionAllowed ? decision : 'deny']));
    tools.qqbot_send_file = 'deny';
    return { ...policy, permission, receiveEnabled: this.admitted(entry.scope, entry.peerId) && permissionAllowed, resources: { ...policy.resources, sandbox: record ? this.ctx.get('sandboxPolicy')?.overrideOf(nativeSession(record)) ?? policy.resources.sandbox : policy.resources.sandbox }, tools };
  }
  private refreshCatalog(agent: DshAgent): void {
    try {
      const tools = agent.ctx.get('tools');
      if (tools && typeof tools === 'object' && 'definitions' in tools && typeof tools.definitions === 'function') {
        const source = tools as Parameters<typeof catalogTools>[0];
        for (const item of [...catalogTools(source), ...catalogTools(source, agent)]) this.catalogs.set(item.id, item);
      }
      const runtime: unknown = agent.ctx.get('ptcRuntime');
      if (runtime && typeof runtime === 'object' && 'sandboxMode' in runtime && runtime.sandboxMode !== undefined) this.catalogs.set('run_code', toolCatalogEntry({ name: 'run_code', description: '受本群权限约束的代码执行；需单独授权并使用实际沙箱。' }));
    } catch { /* Optional service availability is reflected by an empty catalog. */ }
  }
  snapshot(): ConversationSnapshot {
    for (const entry of this.store.list()) {
      const record = this.manager.getSessionRecord(entry.scope, entry.peerId);
      if (record) this.refreshCatalog(record.agent);
    }
    return { ownerIds: this.store.ownerIds(), defaults: this.store.defaults(), errors: [...this.store.errors(), ...this.operationRetention.errors()], tools: [...this.catalogs.values()], conversations: this.store.list().map(entry => {
      const status = this.manager.getStatus(entry.scope, entry.peerId);
      const record = this.manager.getSessionRecord(entry.scope, entry.peerId);
      const workspace = entry.workspaceId ? this.ctx.get('workspaceRegistry')?.get(WorkspaceId(entry.workspaceId)) : undefined;
      const route = status.provider && status.model ? `${status.provider}/${status.model}` : null;
      const fallback = this.manager.getEffectiveModel(entry.scope, entry.peerId);
      const replySources = getCachedReplySources(entry.scope, entry.peerId);
      const native = record ? nativeSession(record) : entry.currentSessionId ? this.ctx.get('sessions')?.get(SessionId(entry.currentSessionId)) : undefined;
      const permission = native ? this.ctx.get('permissionPresets')?.current(native) ?? this.persistedPermission(native.snapshotEvents()) : null;
      const sandbox = native ? this.ctx.get('sandboxPolicy')?.resolve({ session: native }).mode ?? null : null;
      return { ...entry, admitted: this.admitted(entry.scope, entry.peerId), running: this.manager.getSessionRecord(entry.scope, entry.peerId)?.agent.status === 'running', currentModel: route ?? (fallback ? `${fallback.provider}/${fallback.model}` : null),
        currentPermission: permission,
        archived: !!entry.currentSessionId && !!this.ctx.get('workspaceRegistry')?.archivedSessionIds?.includes(SessionId(entry.currentSessionId)),
        recordingError: this.store.recordingError(entry.key),
        permissionConflict: permission && !(record ? this.permissionAllowed(record) : !!permissionSandbox(sandbox ?? '')) ? `当前原生权限 ${permission} 不在本对话允许范围内；工具已限制，请显式选择获准权限。` : null,
        effectiveRestriction: { toolMode: entry.policy.toolMode ?? 'restricted', permission, sandbox },
        currentWorkspace: workspace ? { id: workspace.id, title: workspace.title, path: workspace.path } : null,
        selectablePresets: [...this.allowedSelections(entry.scope, entry.peerId, 'preset')],
        passiveReply: { expiresAt: replySources.find(source => source.expiresAt > Date.now())?.expiresAt ?? replySources[0]?.expiresAt ?? null },
        currentPreset: status.preset ?? null, nextPreset: status.nextPreset ?? null, deliveryState: this.store.deliveries(entry.key)[0]?.state ?? null };
    }) };
  }
  updatePolicy(key: string, expectedVersion: number, input: unknown, alias: string): void {
    const before = this.requireEntry(key);
    this.assertCommandAuthority(before.scope, before.peerId);
    const policy = validatePolicy(input);
    if (JSON.stringify([before.policy.tools, before.policy.resources, before.policy.permission, before.policy.toolMode]) !== JSON.stringify([policy.tools, policy.resources, policy.permission, policy.toolMode])) validatePolicyTools(policy, [...this.catalogs.values()]);
    const record = this.manager.getSessionRecord(before.scope, before.peerId);
    // Revocations apply immediately; new authority is applied only when idle.
    if (record?.agent.status === 'running' && !isReduction(before.policy, policy)) throw new Error('会话正在生成，请停止后再扩大权限或更换配置。');
    this.store.updatePolicy(key, expectedVersion, policy, alias);
    if (record) {
      this.manager.questionChannel?.cancelPending(record.sessionKey);
      this.manager.approvalChannel?.cancelPending(record.sessionKey);
      record.agent.cancel({ kind: 'user' });
      if (before.policy.permission !== policy.permission) this.applyExecutionPolicy(record, policy, true);
      const nextGuard = installPolicy(record.agent.ctx, { agentId: record.sessionId, getPolicy: () => this.effectivePolicy(key, record.sessionId), getCatalog: () => [...this.catalogs.values()], protectedDescendant: agent => this.protectedDescendant(key, agent) });
      this.policyDisposers.get(record.sessionId)?.();
      this.policyDisposers.set(record.sessionId, nextGuard);
    }
  }
  private applyExecutionPolicy(record: SessionRecord, policy: ConversationPolicy, force = false): void {
    // A restored native selection is authoritative; unrelated policy edits must
    // not reset it to the creation default or change Host-wide defaults.
    if (!force && record.agent.session.snapshotEvents().some(event => event.type === 'permission/preset' || event.type === 'sandbox/mode')) return;
    const permissions = this.ctx.get('permissionPresets');
    if (permissions?.catalog().options.some(option => option.value === policy.permission)) permissions.set(nativeSession(record), policy.permission);
    else {
      setSandboxMode(nativeSession(record), policy.resources.sandbox);
      setApprovalPolicy(nativeSession(record), policy.resources.sandbox === 'danger-full-access' ? 'never' : 'ask');
    }
  }
  currentPermission(record: SessionRecord): string {
    return this.ctx.get('permissionPresets')?.current(nativeSession(record)) ?? this.persistedPermission(nativeSession(record).snapshotEvents()) ?? this.entry(record.scope, record.peerId).policy.permission;
  }
  private sandbox(record: SessionRecord): string {
    const session = nativeSession(record);
    const actual = this.ctx.get('sandboxPolicy')?.resolve({ session }).mode;
    if (actual) return actual;
    for (const event of [...session.snapshotEvents()].reverse()) if (event.type === 'sandbox/mode') return event.data.mode;
    return this.entry(record.scope, record.peerId).policy.resources.sandbox;
  }
  private permissionAllowed(record: SessionRecord): boolean {
    const policy = this.entry(record.scope, record.peerId).policy;
    return policy.nativeTools === false ? policy.allowedPermissions.includes(this.currentPermission(record)) : !!permissionSandbox(this.sandbox(record));
  }
  resolveWorkspace(id: string): Workspace {
    if (!id.trim() || id.length > 256 || id.includes('\0')) throw new Error('工作区标识无效');
    const workspace = this.ctx.get('workspaceRegistry')?.get(WorkspaceId(id));
    if (!workspace) throw new Error('工作区不存在，请刷新后重试');
    return workspace;
  }
  assertCurrentSession(key: string, id: unknown): void {
    if (id !== undefined && (typeof id !== 'string' || this.requireEntry(key).currentSessionId !== id)) throw new Error('当前会话已更新，请返回当前会话后重试');
  }
  async selectPermission(key: string, value: string): Promise<void> {
    const entry = this.requireEntry(key);
    this.assertCommandAuthority(entry.scope, entry.peerId);
    if (this.busy(key)) throw new Error('会话正在生成，请先停止');
    const service = this.ctx.get('permissionPresets');
    if ((!service || !service.catalog().options.some(option => option.value === value)) && !permissionSandbox(value)) throw new Error('该 DSH 权限预设当前不可用');
    // Restricted (custom-tool) policies still carry a per-conversation permission allowlist.
    if (entry.policy.nativeTools === false && !entry.policy.allowedPermissions.includes(value)) throw new Error('该会话未授权此权限预设');
    const record = await this.manager.restoreExisting(entry.scope, entry.peerId);
    if (!record) throw new Error('请先创建会话');
    await record.agent.runMaintenance(async signal => {
      signal.throwIfAborted();
      this.assertCommandAuthority(entry.scope, entry.peerId);
      if (this.requireEntry(key).policy.nativeTools === false && !this.requireEntry(key).policy.allowedPermissions.includes(value)) throw new Error('该权限预设授权已撤销');
      const mode = permissionSandbox(value);
      if (service?.catalog().options.some(option => option.value === value)) service.set(nativeSession(record), value);
      else if (mode) { setSandboxMode(nativeSession(record), mode); setApprovalPolicy(nativeSession(record), mode === 'danger-full-access' ? 'never' : 'ask'); }
    });
    if (entry.settings) this.store.updateSettings(key, entry.policy.version, { ...entry.settings, execution: { ...entry.settings.execution, permission: permissionSandbox(value) ?? entry.settings.execution.permission } }, entry.alias, entry.policy.receiveEnabled !== false);
  }
  async selectWorkspace(key: string, id: string): Promise<SessionRecord> {
    const entry = this.requireEntry(key);
    if (this.busy(key)) throw new Error('会话正在生成，请先停止');
    this.resolveWorkspace(id);
    return this.queue.run(key, () => this.ingestion.run(key, async () => {
      this.assertCommandAuthority(entry.scope, entry.peerId);
      if (entry.workspaceId === id) {
        const current = await this.manager.restoreExisting(entry.scope, entry.peerId);
        if (current) return current;
      }
      return this.manager.replaceSession(entry.scope, entry.peerId, id);
    }));
  }
  async createSession(key: string, input: { operationId: string; expectedCurrentSessionId: string | null; expectedPolicyVersion: number; workspaceId: string; presetId: string }): Promise<string> {
    return this.queue.run(key, () => this.ingestion.run(key, async () => {
      const replay = this.sessionOperations.begin(input.operationId, { key, ...input });
      if (replay) return replay;
      let committed: string | undefined;
      try {
        const assertCurrent = (): void => {
          const entry = this.requireEntry(key);
          if (entry.currentSessionId !== input.expectedCurrentSessionId || entry.policy.version !== input.expectedPolicyVersion) throw new Error('当前会话或配置版本已更新，请刷新后重试');
          this.assertCommandAuthority(entry.scope, entry.peerId);
          const live = entry.currentSessionId ? this.ctx.get('agents')?.get(SessionId(entry.currentSessionId)) : undefined;
          if (live?.status === 'running' || live?.inbox.nextTurn.length || live?.inbox.nextStep.length || (this.reservations.get(key) ?? 0) > 0) throw new Error('会话正在生成或排队，请停止后重试');
          this.validateSelection(entry.scope, entry.peerId, 'preset', input.presetId);
          this.resolveWorkspace(input.workspaceId);
        };
        assertCurrent();
        const entry = this.requireEntry(key);
        const record = await this.manager.replaceSession(entry.scope, entry.peerId, input.workspaceId, { presetId: input.presetId, assertCurrent });
        committed = record.sessionId;
        this.sessionOperations.complete(input.operationId, record.sessionId);
        return record.sessionId;
      } catch (error) {
        // A committed mapping is authoritative even if the operation receipt failed.
        if (committed) return committed;
        this.sessionOperations.fail(input.operationId, error instanceof Error ? error.message : '创建失败');
        throw error;
      }
    }));
  }
  private isArchived(entry: ConversationEntry): boolean { return !!entry.currentSessionId && !!this.ctx.get('workspaceRegistry')?.archivedSessionIds?.includes(SessionId(entry.currentSessionId)); }
  private assertNotArchived(entry: ConversationEntry): void { if (this.isArchived(entry)) throw new Error('当前 QQ 会话已归档，请在网页明确恢复后再发送消息；此消息未自动重投'); }
  async unarchive(key: string, sessionId: string): Promise<void> {
    const entry = this.requireEntry(key);
    if (!sessionId || entry.currentSessionId !== sessionId) throw new Error('当前会话已更新，请刷新后明确选择要恢复的会话');
    const registry = this.ctx.get('workspaceRegistry');
    if (!registry) throw new Error('工作区服务不可用');
    this.assertCommandAuthority(entry.scope, entry.peerId);
    await registry.unarchiveSession(SessionId(sessionId));
  }
  private persistedPermission(events: readonly { type: string; data?: unknown }[]): string | null {
    for (const event of [...events].reverse()) {
      if (event.type !== 'permission/preset' || !event.data || typeof event.data !== 'object' || !('preset' in event.data)) continue;
      if (typeof event.data.preset === 'string') return event.data.preset;
    }
    return null;
  }
  async savePolicy(key: string, expectedVersion: number, input: unknown, alias: string): Promise<void> {
    const before = this.requireEntry(key);
    const next = validatePolicy(input);
    const changeMode = (before.policy.toolMode ?? 'restricted') !== (next.toolMode ?? 'restricted');
    if (!changeMode) { this.updatePolicy(key, expectedVersion, next, alias); return; }
    if (this.busy(key)) throw new Error('请等待当前任务完成后更换 Agent 工作能力');
    validatePolicyTools(next, [...this.catalogs.values()]);
    await this.queue.run(key, () => this.ingestion.run(key, async () => {
      this.updatePolicy(key, expectedVersion, next, alias);
      try { await this.manager.replaceSession(before.scope, before.peerId); }
      catch (error) {
        const current = this.requireEntry(key);
        // Do not overwrite a concurrent revocation or another owner's update.
        if (current.policy.version === expectedVersion + 1) this.updatePolicy(key, current.policy.version, before.policy, before.alias);
        throw error;
      }
    }));
  }
  async saveDefaults(expectedVersion: number, input: unknown): Promise<void> {
    const settings = validateQQAgentSettings(input);
    await this.validateAgentSettings(settings);
    this.store.updateDefaults(expectedVersion, settings);
  }
  private async validateAgentSettings(settings: QQAgentSettings): Promise<void> {
    if (settings.model) await this.manager.validateModelSetting(settings.model);
    if (settings.preset) {
      const presets = await this.manager.listPresets();
      if (!presets.some(preset => preset.id === settings.preset)) throw new Error('Agent 预设当前不可用，请刷新后重试');
    }
    if (settings.execution.kind === 'custom') {
      for (const id of settings.execution.tools) {
        const tool = this.catalogs.get(id);
        if (!tool?.available) throw new Error(`工具 ${id} 当前不可用`);
      }
    }
  }
  async saveSettings(key: string, expectedVersion: number, input: unknown, alias: string, receiveEnabled: boolean, recording?: { expectedVersion: number; maxMessages: number }): Promise<string | undefined> {
    const before = this.requireEntry(key);
    this.assertCommandAuthority(before.scope, before.peerId);
    if (this.busy(key)) throw new Error('会话正在生成，请停止后再保存设置。记录条数可单独保存。');
    const settings = validateQQAgentSettings(input);
    const preview = this.store.previewSettings(key, expectedVersion, settings, alias, receiveEnabled, recording);
    const executionChanged = JSON.stringify(before.settings?.execution) !== JSON.stringify(settings.execution);
    await this.validateAgentSettings(settings);
    const changedModel = JSON.stringify(before.settings?.model) !== JSON.stringify(settings.model);
    const route = changedModel ? await this.manager.validateModelSetting(settings.model ?? this.manager.getDefaultModel()) : undefined;
    const record = before.currentSessionId ? await this.manager.restoreExisting(before.scope, before.peerId) : undefined;
    if (record?.agent.status === 'running' || record?.agent.inbox?.nextTurn.length || record?.agent.inbox?.nextStep.length) throw new Error('会话正在生成或排队，请停止后再保存');
    if (route && record && !record.agent.model?.select) throw new Error('当前宿主不支持原生模型选择，设置保持不变。');
    const apply = async (): Promise<void> => {
      if (this.requireEntry(key).policy.version !== expectedVersion) throw new Error('配置已更新，请刷新后重试');
      this.store.previewSettings(key, expectedVersion, settings, alias, receiveEnabled, recording);
      const oldRoute = record?.agent.model?.current() ?? record?.modelRoute;
      const oldSandbox = record ? this.sandbox(record) : undefined;
      const previousSession = record ? nativeSession(record) : undefined;
      const oldPermission = record ? this.currentPermission(record) : undefined;
      const oldApproval = previousSession ? this.ctx.get('approval')?.overrideOf(previousSession)
        ?? [...previousSession.snapshotEvents()].reverse().find(event => event.type === 'approval/policy')?.data.policy
        ?? this.ctx.get('approval')?.config.policy ?? 'ask' : undefined;
      try {
        if (record && route) { record.agent.model?.select?.(route); record.modelRoute = route; }
        if (record && executionChanged) this.applyExecutionPolicy(record, preview.policy, true);
        this.store.updateSettings(key, expectedVersion, settings, alias, receiveEnabled, recording);
      } catch (error) {
        if (record && route && oldRoute) { record.agent.model?.select?.(oldRoute); record.modelRoute = oldRoute; }
        if (record && executionChanged) {
          const session = nativeSession(record);
          const permissions = this.ctx.get('permissionPresets');
          if (oldPermission && oldPermission !== 'custom' && permissions?.catalog().options.some(option => option.value === oldPermission)) permissions.set(session, oldPermission);
          setSandboxMode(session, permissionSandbox(oldSandbox ?? '') ?? before.policy.resources.sandbox);
          if (oldApproval === 'ask' || oldApproval === 'never') setApprovalPolicy(session, oldApproval);
        }
        throw error;
      }
    };
    await this.queue.run(key, () => this.ingestion.run(key, () => record ? record.agent.runMaintenance(async signal => { signal.throwIfAborted(); await apply(); }) : apply()));
    if (record && executionChanged) {
      this.policyDisposers.get(record.sessionId)?.();
      this.policyDisposers.set(record.sessionId, installPolicy(record.agent.ctx, { agentId: record.sessionId, getPolicy: () => this.effectivePolicy(key, record.sessionId), getCatalog: () => [...this.catalogs.values()], protectedDescendant: agent => this.protectedDescendant(key, agent) }));
    }
    this.pruneExpired();
    const nextSession = before.settings?.prompt !== settings.prompt || before.settings?.cwd !== settings.cwd || before.settings?.preset !== settings.preset;
    return [nextSession ? '设置已保存。提示词、工作目录和 Agent 预设将在新会话生效；当前上下文保留。可点击新会话立即应用。' : '', receiveEnabled && !this.admitted(before.scope, before.peerId) ? '此对话仍被全局访问规则阻止。请使用启用对话操作配置访问规则，或在连接设置中允许此 QQ 标识。' : ''].filter(Boolean).join('\n') || undefined;
  }
  recordModelSetting(scope: ChatScope, peerId: string, model: QQAgentSettings['model']): void {
    const entry = this.entry(scope, peerId);
    if (entry.settings) this.store.updateSettings(entry.key, entry.policy.version, { ...entry.settings, model }, entry.alias, entry.policy.receiveEnabled !== false);
  }
  recordPresetSetting(scope: ChatScope, peerId: string, preset: string): void {
    const entry = this.entry(scope, peerId);
    if (entry.settings) this.store.updateSettings(entry.key, entry.policy.version, { ...entry.settings, preset }, entry.alias, entry.policy.receiveEnabled !== false);
  }
  requireEntry(key: string): ConversationEntry {
    const entry = this.store.get(key);
    if (!entry) throw new Error('QQ 对话不存在');
    return entry;
  }
  async enqueueQQ(record: SessionRecord, message: UserMessage, originalReceived: { messageId: string; senderId: string; [key: string]: unknown }, cutoff: number, backgroundRefs: readonly string[]): Promise<void> {
    const entry = this.requireEntry(record.sessionKey);
    this.assertNotArchived(entry);
    if (!this.admitted(record.scope, record.peerId) || entry.policy.replyEnabled === false) throw new Error('该对话已停止回复');
    const route = record.agent.model?.current() ?? record.modelRoute;
    if (route) this.validateSelection(record.scope, record.peerId, 'model', `${route.provider}/${route.model}`);
    if (!this.permissionAllowed(record)) throw new Error('当前权限预设尚未获准');
    if (record.agentPreset) this.validateSelection(record.scope, record.peerId, 'preset', record.agentPreset);
    const operationId = `qq-${createHash('sha256').update(`${entry.key}:${originalReceived.messageId}`).digest('hex')}`;
    if (this.operations.has(operationId)) return;
    const prepared = this.operations.prepare({ operationId, conversationKey: entry.key, sessionId: SessionId(record.sessionId),
      generation: this.generation(entry, record.sessionId), policyVersion: String(entry.policy.version), message,
      target: { ...record.replyTarget }, cutoff, backgroundRefs, originalReceived });
    if (!prepared.created) return;
    const entered = new Promise<void>((resolve, reject) => { this.inputWaiters.set(message.id, { resolve, reject }); });
    try { record.agent.followup(message); }
    catch (error) { this.inputWaiters.delete(message.id); throw error; }
    // Backpressure ends at proven admission, not at driver idleness or final output.
    await entered;
  }
  private generation(entry: ConversationEntry, sessionId: string): number {
    const index = entry.sessions.findIndex(row => row.sessionId === sessionId);
    if (index < 0) throw new Error('QQ Session 归属无效');
    return index;
  }
  private activeQQ(sessionId: string, turn?: number): QQOperation | undefined {
    const record = this.manager.findBySessionId(sessionId);
    if (!record) return undefined;
    const events = nativeSession(record).snapshotEvents();
    const number = turn ?? [...events].reverse().find(event => event.type === 'turn/start')?.data.turn;
    if (typeof number !== 'number' || events.some(event => event.type === 'turn/end' && event.data.turn === number)) return undefined;
    const verdict = classifyTurnInputs(events, number, this.operations.forSession(sessionId), this.operations.receiptsForSession(sessionId));
    return verdict.kind === 'qq' ? this.operations.lookup(verdict.operationId) : undefined;
  }
  interactionRecord(sessionId: string, turn?: number): SessionRecord | undefined {
    const operation = this.activeQQ(sessionId, turn);
    const record = this.manager.findBySessionId(sessionId);
    if (!operation || !record || !this.authorized(operation)) return undefined;
    const source = operation.originalReceived;
    const senderId = source && typeof source === 'object' && 'senderId' in source && typeof source.senderId === 'string' ? source.senderId : '';
    return { ...record, senderId, replyTarget: { ...operation.target } };
  }
  async recordHumanReply(reply: Omit<HumanReply, 'sessionId' | 'callId'> & { sessionId: string; callId: string }): Promise<void> {
    const record = this.interactionRecord(reply.sessionId, reply.turn);
    if (!record || !this.canAnswer(record.scope, record.peerId, reply.actor) || !validCallId(reply.callId)) throw new Error('QQ 回答来源或授权已失效');
    this.operations.recordHumanReply({ ...reply, sessionId: SessionId(reply.sessionId), callId: reply.callId });
  }
  private authorized(operation: QQOperation): boolean {
    const entry = this.store.get(operation.conversationKey);
    return !!entry && entry.currentSessionId === operation.sessionId
      && this.generation(entry, operation.sessionId) === operation.generation
      && String(entry.policy.version) === operation.policyVersion
      && !this.isArchived(entry) && entry.policy.replyEnabled !== false && this.admitted(entry.scope, entry.peerId);
  }
  private async reconcileBackground(record: SessionRecord): Promise<void> {
    const operations = this.operations.forSession(record.sessionId).filter(operation => this.inputWaiters.has(operation.message.id) || operation.cutoff > this.store.consumedCursor(operation.conversationKey));
    if (!operations.length) return;
    const session = nativeSession(record);
    try {
      if (!await this.ctx.get('sessions')?.flush(session)) throw new Error('QQ 输入持久化未确认');
      const events = session.snapshotEvents();
      for (const operation of operations) {
        const input = events.find(event => event.type === 'user/message' && event.data.id === operation.message.id);
        if (!input || input.type !== 'user/message') continue;
        const prefix = events.slice(0, input.seq + 1);
        const turn = [...prefix].reverse().find(event => event.type === 'turn/start');
        if (!turn || turn.type !== 'turn/start') continue;
        const verdict = classifyTurnInputs(prefix, turn.data.turn, this.operations.forSession(record.sessionId), this.operations.receiptsForSession(record.sessionId));
        const waiter = this.inputWaiters.get(operation.message.id);
        if (verdict.kind === 'qq' && verdict.operationId === operation.operationId) {
          this.store.commitBackground(operation.conversationKey, operation.cutoff);
          waiter?.resolve(); this.inputWaiters.delete(operation.message.id);
        } else if (waiter) { waiter.reject(new Error('QQ 输入已被网页或队列操作修改，未自动重投')); this.inputWaiters.delete(operation.message.id); }
      }
    } catch (cause) {
      const error = new Error('QQ 输入持久化未确认', { cause });
      for (const operation of operations) { this.inputWaiters.get(operation.message.id)?.reject(error); this.inputWaiters.delete(operation.message.id); }
      record.agent.cancel({ kind: 'user' }, { keepInbox: true });
      throw error;
    }
  }
  async observeSessionEvent(sessionId: string, type: string, data: Record<string, unknown>, eventSeq?: number): Promise<void> {
    let record = this.manager.findBySessionId(sessionId);
    if (!record) {
      const entry = this.store.getBySessionId(sessionId);
      if (entry?.currentSessionId === sessionId && this.ctx.get('agents')?.get(SessionId(sessionId))) record = await this.manager.restoreExisting(entry.scope, entry.peerId);
    }
    if (!record) return;
    if (type === 'user/message') await this.reconcileBackground(record);
    if (type === 'agent/inbox/spliced' && data.outcome === 'canceled') {
      const live = this.ctx.get('agents')?.get(SessionId(sessionId));
      const events = nativeSession(record).snapshotEvents();
      for (const operation of this.operations.forSession(sessionId)) {
        if (!this.inputWaiters.has(operation.message.id) || events.some(event => event.type === 'user/message' && event.data.id === operation.message.id)) continue;
        const queued = live?.inbox.nextTurn.find(item => item.id === operation.message.id);
        const edited = Array.isArray(data.inserted) && data.inserted.some(item => item && typeof item === 'object' && 'id' in item && item.id === operation.message.id);
        if (!queued || payloadHash(queued) !== operation.payloadHash || edited) {
          this.inputWaiters.get(operation.message.id)?.reject(new Error('QQ 排队请求已取消或修改')); this.inputWaiters.delete(operation.message.id);
        }
      }
    }
    if (type === 'turn/end' && typeof data.turn === 'number') {
      const live = this.ctx.get('agents')?.get(SessionId(sessionId));
      const events = nativeSession(record).snapshotEvents();
      for (const operation of this.operations.forSession(sessionId)) {
        if (!this.inputWaiters.has(operation.message.id)) continue;
        const queued = live?.inbox.nextTurn.some(item => item.id === operation.message.id) || live?.inbox.nextStep.some(item => item.id === operation.message.id);
        if (!queued && !events.some(event => event.type === 'user/message' && event.data.id === operation.message.id)) {
          this.inputWaiters.get(operation.message.id)?.reject(new Error('QQ 请求未确认进入模型，未自动重投')); this.inputWaiters.delete(operation.message.id);
        }
      }
      if (eventSeq === undefined || eventSeq <= (this.activationFloor.get(sessionId) ?? -1)) return;
      const key = `${sessionId}:${data.turn}`;
      if (this.settling.has(key)) return this.settling.get(key);
      const settled = this.settleTurn(record, data.turn).finally(() => {
        this.settling.delete(key);
        for (const operation of this.operations.forSession(sessionId)) {
          const queued = live?.inbox.nextTurn.some(item => item.id === operation.message.id) || live?.inbox.nextStep.some(item => item.id === operation.message.id);
          if (!queued && !this.inputWaiters.has(operation.message.id)) this.operations.markTerminal(operation.operationId);
        }
      });
      this.settling.set(key, settled); return settled;
    }
  }
  private async settleTurn(record: SessionRecord, turn: number): Promise<void> {
    const session = nativeSession(record);
    if (!await this.ctx.get('sessions')?.flush(session)) throw new Error('QQ 轮次尚未确认持久化');
    const verdict = classifyTurn(session.snapshotEvents(), turn, this.operations.forSession(record.sessionId), this.operations.receiptsForSession(record.sessionId));
    if (verdict.kind !== 'qq' || verdict.inputSeq <= (this.activationFloor.get(record.sessionId) ?? -1)) return;
    const operation = this.operations.lookup(verdict.operationId);
    if (!operation || !this.authorized(operation)) return;
    const id = `auto-${createHash('sha256').update(`${record.sessionId}:${operation.generation}:${turn}:${verdict.finalMessageId}`).digest('hex')}`;
    await this.deliver(operation.conversationKey, id, verdict.text, operation.target, () => this.authorized(operation), 'qq', { sourceSessionId: record.sessionId, sourceMessageId: verdict.finalMessageId, answerId: verdict.finalMessageId, turnId: String(turn), provenance: 'automatic' });
  }
  async sweepOperationRetention(): Promise<void> {
    await this.operationRetention.sweep(this.ctx.get('sessionPersistence'), this.operations, key => this.operationCutoff(key), operation => this.protectedOperation(operation), this.expiredOperationBodies());
  }
  private operationCutoff(key: string): number { const days = this.store.get(key)?.recording?.retentionDays ?? 7; return days === 0 ? -Infinity : Date.now() - days * 86_400_000; }
  private expiredOperationBodies(): (operation: QQOperation) => boolean {
    const cache = new Map<string, ReadonlySet<string>>();
    return operation => {
      let expired = cache.get(operation.conversationKey);
      if (!expired) { expired = this.store.expiredMessageIds(operation.conversationKey); cache.set(operation.conversationKey, expired); }
      const original = operation.originalReceived;
      const sourceId = original && typeof original === 'object' && 'messageId' in original && typeof original.messageId === 'string' ? original.messageId : undefined;
      return (!!sourceId && expired.has(sourceId)) || operation.backgroundRefs.some(id => expired.has(id));
    };
  }
  private protectedOperation(operation: QQOperation): boolean {
    const live = this.ctx.get('agents')?.get(operation.sessionId);
    return live?.status === 'running' || !!live?.inbox.nextTurn.some(item => item.id === operation.message.id) || !!live?.inbox.nextStep.some(item => item.id === operation.message.id) || this.inputWaiters.has(operation.message.id);
  }
  pruneExpired(): void {
    this.store.pruneExpired();
    for (const operation of this.operations.all()) {
      const session = this.ctx.get('sessions')?.get(operation.sessionId);
      const live = this.ctx.get('agents')?.get(operation.sessionId);
      const queued = live?.inbox.nextTurn.some(item => item.id === operation.message.id) || live?.inbox.nextStep.some(item => item.id === operation.message.id);
      if (!session || live?.status === 'running' || queued || this.inputWaiters.has(operation.message.id)) continue;
      const last = [...session.snapshotEvents()].reverse().find(event => event.type === 'turn/start' || event.type === 'turn/end');
      if (last?.type === 'turn/end') this.operations.markTerminal(operation.operationId);
    }
    this.operations.retireExpired(key => this.operationCutoff(key), operation => this.protectedOperation(operation), this.expiredOperationBodies());
  }
  busy(key: string): boolean {
    const entry = this.requireEntry(key);
    const live = entry.currentSessionId ? this.ctx.get('agents')?.get(SessionId(entry.currentSessionId)) : undefined;
    return (this.reservations.get(key) ?? 0) > 0 || this.queue.pending(key) > 0 || live?.status === 'running' || !!live?.inbox.nextTurn.length || !!live?.inbox.nextStep.length;
  }
  background(record: SessionRecord, cutoff: number, messageId: string) { return this.store.snapshotBackground(record.sessionKey, messageId, cutoff); }
  reset(scope: ChatScope, peerId: string): void { this.store.resetBackground(this.entry(scope, peerId).key); }
  rolePrompt(sessionId: string): string {
    const visited = new Set<string>();
    let id: string | undefined = sessionId;
    while (id && !visited.has(id)) {
      visited.add(id);
      const entry = this.store.getBySessionId(id);
      if (entry) {
        const row = entry.sessions.find(row => row.sessionId === id);
        if (row?.prompt !== undefined) return row.prompt;
        return [entry.scope === 'group' ? this.config.groupPrompt : this.config.directPrompt, this.describeRole(row?.role ?? entry.policy.role)].filter(Boolean).join('\n');
      }
      id = this.ctx.get('sessions')?.get(SessionId(id))?.header.parentSession;
    }
    return '';
  }
  private describeRole(role: ConversationPolicy['role']): string { return [role.description, role.tone && `语气：${role.tone}`, role.world && `世界观：${role.world}`, role.prompt].filter(Boolean).join('\n'); }
  cwd(scope: ChatScope, peerId: string): string { const entry = this.entry(scope, peerId); return entry.settings?.cwd || (entry.workspaceId ? this.resolveWorkspace(entry.workspaceId).path : entry.policy.cwd || resolveAgentCwd(this.config.cwd)); }
  async send(key: string, operationId: string, text: string, source?: { sessionId: string; messageId: string }): Promise<DeliveryRecord> {
    const entry = this.requireEntry(key);
    if (source) {
      if (!entry.sessions.some(row => row.sessionId === source.sessionId)) throw new Error('回答不属于此 QQ 对话');
      const resolved = await this.ctx.get('sessionController')?.resolveAgent(SessionId(source.sessionId));
      if (!resolved || 'error' in resolved) throw new Error('无法读取原生回答');
      const session = this.ctx.get('sessions')?.get(SessionId(source.sessionId));
      const exists = session?.snapshotEvents().some(event => event.type === 'assistant/message' && event.data.message.id === source.messageId);
      if (!exists) throw new Error('原生回答不存在，请重新选择');
    }
    return this.deliver(key, operationId, text, { scope: entry.scope, targetId: entry.peerId }, () => this.admitted(entry.scope, entry.peerId), 'manual', { provenance: 'web', ...(source ? { sourceSessionId: source.sessionId, sourceMessageId: source.messageId, answerId: source.messageId } : {}) });
  }
  private async deliver(key: string, operationId: string, text: string, target: ReplyTarget, allowed: () => boolean, origin: 'qq' | 'manual' = 'qq', provenance: import('../shared/conversation-protocol.ts').DeliveryProvenance = {}): Promise<DeliveryRecord> {
    if (!allowed()) throw new Error('该对话或本轮发送资格已撤销');
    if (!text.trim() || text.length > 100_000) throw new Error('发送内容不能为空或超过 100000 字符');
    const sender = this.sender;
    if (!sender) throw new Error('QQ 发送通道不可用');
    const chunks = chunkMarkdownText(text, this.config.textChunkLimit);
    const started = this.store.beginDelivery(key, operationId, redactRecordingText(text, [this.config.appSecret]), chunks.length, false, provenance);
    if (!started.created) return started.record;
    return this.deliveryQueue.run(key, async () => {
      const sources = getCachedReplySources(target.scope, target.targetId);
      const source = origin === 'manual' ? sources.find(source => source.expiresAt > Date.now()) : sources.find(source => source.id === (target.msgId ?? target.eventId));
      const resolvedTarget: ReplyTarget = source ? { ...target, ...(source.kind === 'msg' ? { msgId: source.id } : { eventId: source.id }) } : target;
      const parts: DeliveryRecord['parts'] = chunks.map((_text, index) => ({ index, state: 'pending' }));
      this.store.updateDelivery(key, operationId, { state: 'sending', parts });
      for (const [index, chunk] of chunks.entries()) {
        if (!allowed()) {
          parts[index] = { index, state: 'failed' };
          this.store.updateDelivery(key, operationId, { state: 'failed', parts, error: '发送授权已撤销，后续分段未发送' });
          break;
        }
        if (source && source.expiresAt <= Date.now()) {
          parts[index] = { index, state: 'failed' };
          this.store.updateDelivery(key, operationId, { state: 'failed', parts, error: '被动回复窗口已过期，后续分段未发送。请在 QQ 中重新联系机器人。' });
          break;
        }
        let receipt: unknown;
        try { receipt = await this.withTrackedSend(() => sender.sendMarkdown({ ...resolvedTarget }, chunk)); }
        catch (error) {
          const failure = deliveryFailure(error, [this.config.appSecret]);
          parts[index] = { index, state: failure.state };
          this.store.updateDelivery(key, operationId, { ...failure, parts });
          this.logger.warn(`QQ delivery ${operationId}: ${failure.state}; ${failure.error}`);
          break;
        }
        parts[index] = { index, state: 'accepted', ...(platformReceiptId(receipt) ? { receiptId: platformReceiptId(receipt) } : {}) };
        this.store.updateDelivery(key, operationId, { state: index === chunks.length - 1 ? 'accepted' : 'sending', parts });
      }
      const result = this.store.deliveries(key).find(row => row.id === operationId);
      if (!result) throw new Error('投递记录不可用');
      return result;
    }).catch(error => {
      const record = this.store.deliveries(key).find(row => row.id === operationId);
      if (record?.state === 'pending') this.store.updateDelivery(key, operationId, { state: 'failed', error: '发送队列已满，请核对后手动重试' });
      throw error;
    });
  }
  async trackAutomatic<Result>(target: ReplyTarget, text: string, send: () => Promise<Result>, fallbackProvenance: 'automatic' | 'sdk' = 'automatic'): Promise<Result> {
    if (this.outboundTracking.getStore()) return send();
    if (!this.admitted(target.scope, target.targetId)) throw new Error('该对话已停止接收与发送');
    const entry = this.entry(target.scope, target.targetId);
    const key = entry.key;
    const id = `auto-${randomUUID()}`;
    const context = this.outboundContext.getStore();
    const session = entry.currentSessionId ? this.ctx.get('sessions')?.get(SessionId(entry.currentSessionId)) : undefined;
    const turn = session ? [...session.snapshotEvents()].reverse().find(event => event.type === 'turn/start') : undefined;
    this.store.beginDelivery(key, id, redactRecordingText(text, [this.config.appSecret]), 1, false, {
      ...(entry.currentSessionId ? { sourceSessionId: entry.currentSessionId } : {}),
      ...(turn?.type === 'turn/start' ? { turnId: String(turn.data.turn) } : {}),
      ...(context ?? { provenance: fallbackProvenance }),
    });
    this.store.updateDelivery(key, id, { state: 'sending' });
    try {
      if (!this.admitted(target.scope, target.targetId)) throw new DeliveryNotSubmittedError('发送前该对话权限已撤销');
      const source = getCachedReplySources(target.scope, target.targetId).find(item => item.id === (target.msgId ?? target.eventId));
      if (source && source.expiresAt <= Date.now()) throw new DeliveryNotSubmittedError('被动回复窗口已过期（群聊为 5 分钟），请在 QQ 中重新联系机器人后显式发送；未自动重发。');
      const result = await this.withTrackedSend(send);
      this.store.updateDelivery(key, id, { state: 'accepted', parts: [{ index: 0, state: 'accepted', ...(platformReceiptId(result) ? { receiptId: platformReceiptId(result) } : {}) }] });
      return result;
    } catch (error) {
      const failure = deliveryFailure(error, [this.config.appSecret]);
      this.store.updateDelivery(key, id, { ...failure, parts: [{ index: 0, state: failure.state }] });
      this.logger.warn(`QQ delivery ${id}: ${failure.state}; ${failure.error}`);
      throw error;
    }
  }
  conversationForSession(sessionId: string): ConversationEntry | undefined {
    const visited = new Set<string>();
    let id: string | undefined = sessionId;
    while (id && !visited.has(id)) {
      visited.add(id);
      const entry = this.store.getBySessionId(id);
      if (entry) return entry;
      id = this.ctx.get('sessions')?.get(SessionId(id))?.header.parentSession;
    }
    return undefined;
  }
  private protectedDescendant(key: string, agent: unknown): boolean {
    return !!agent && typeof agent === 'object' && this.attached.has(agent)
      && 'id' in agent && typeof agent.id === 'string' && this.conversationForSession(agent.id)?.key === key;
  }
  private guardAgent(agent: Agent, key: string): void {
    if (this.attached.has(agent)) return;
    this.refreshCatalog(agent);
    const dispose = installPolicy(agent.ctx, { agentId: agent.id,
      getPolicy: () => {
        const entry = this.requireEntry(key);
        const permission = this.ctx.get('permissionPresets')?.current(agent.session) ?? entry.policy.permission;
        const sandbox = this.ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode;
        const allowed = !!permissionSandbox(sandbox ?? entry.policy.resources.sandbox);
        const tools = Object.fromEntries(Object.entries(entry.policy.tools).map(([id, decision]) => [id, allowed ? decision : 'deny']));
        tools.qqbot_send_file = 'deny';
        return { ...entry.policy, permission, receiveEnabled: this.admitted(entry.scope, entry.peerId) && allowed, tools };
      }, getCatalog: () => [...this.catalogs.values()],
      protectedDescendant: descendant => this.protectedDescendant(key, descendant),
      onDenied: tool => this.logger.warn(`QQ policy denied ${tool}`),
    });
    this.policyDisposers.get(agent.id)?.();
    this.policyDisposers.set(agent.id, dispose);
    this.attached.add(agent);
  }
  release(_sessionId: string): void {
    // Session history keeps its policy ceiling when reopened through the native UI.
  }

}

export function isReduction(old: ConversationPolicy, next: ConversationPolicy): boolean {
  const rank = { deny: 0, ask: 1, allow: 2 };
  const sandboxRank: Record<string, number> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 };
  const subset = (before: readonly string[], after: readonly string[]): boolean => after.every(value => before.includes(value));
  const fixed = (policy: ConversationPolicy) => ({ ...policy, version: 0, tools: {}, resources: null,
    controllers: [], approvers: [], allowedModels: [], allowedPresets: [], allowedPermissions: [], permission: 'read-only', receiveEnabled: true, replyEnabled: true });
  if (JSON.stringify(fixed(old)) !== JSON.stringify(fixed(next))) return false;
  if (old.receiveEnabled === false && next.receiveEnabled !== false) return false;
  if (old.replyEnabled === false && next.replyEnabled !== false) return false;
  if (next.permission !== old.permission && ((sandboxRank[next.permission] ?? Infinity) > (sandboxRank[old.permission] ?? -1))) return false;
  for (const name of ['controllers', 'approvers', 'allowedModels', 'allowedPresets', 'allowedPermissions'] as const) if (!subset(old[name], next[name])) return false;
  if (!Object.entries(next.tools).every(([name, decision]) => rank[decision] <= rank[old.tools[name] ?? 'deny'])) return false;
  const before = old.resources, after = next.resources;
  for (const name of ['readRoots', 'writeRoots', 'sendRoots'] as const) if (!subset(before[name], after[name])) return false;
  if ((!before.executionEnabled && after.executionEnabled) || (sandboxRank[after.sandbox] ?? Infinity) > (sandboxRank[before.sandbox] ?? -1)) return false;
  if (after.maxFiles > before.maxFiles || after.maxFileMB > before.maxFileMB) return false;
  if (before.networkDomains.length && (!after.networkDomains.length || !subset(before.networkDomains, after.networkDomains))) return false;
  return true;
}

function validCallId(value: string): value is ToolCallId { return value.length > 0 && value.length <= 1024 && !value.includes('\0'); }

export function platformReceiptId(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  if ('id' in result && typeof result.id === 'string') return result.id;
  if ('message' in result) return platformReceiptId(result.message);
  return undefined;
}
