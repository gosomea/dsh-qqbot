import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { ConfigSchema } from '../config.ts';
import { ConversationService } from '../runtime/conversation-service.ts';
import { ConversationStore } from '../conversations/index.ts';
import { SessionManager } from './session-manager.ts';
import type { DshAgent, DshAgentRegistry } from './types.ts';

vi.mock('../model/model-resolver.ts', () => ({ ModelResolver: class {
  private ids = new Map<string, string>();
  getPreset() { return undefined; }
  setPreset() {}
  getSessionId(key: string) { return this.ids.get(key); }
  setSessionId(key: string, value: string) { this.ids.set(key, value); }
  getEffectiveRoute() { return { provider: 'p', model: 'm' }; }
  getResumeRoute() { return this.getEffectiveRoute(); }
  resolveDefault() { return this.getEffectiveRoute(); }
  async validateRoute(route: { provider: string; model: string }) { return route; }
} }));
const { attachFallback } = vi.hoisted(() => ({ attachFallback: vi.fn(async () => {}) }));
vi.mock('../host/adapter.ts', () => ({ createHostAdapter: () => ({ capabilities: [], resolveAgent: async () => undefined, sessionEvents: () => [], attachSessionToWorkspace: attachFallback }) }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qq-workbench-')); roots.push(root);
  const live = new Map<string, DshAgent>();
  const handles = new Map<string, { agent: DshAgent; dispose: ReturnType<typeof vi.fn> }>();
  const selected = new Map<string, string>();
  const workspaces = new Map(['a', 'b'].map(id => [id, { id, title: id, path: join(root, id), attachSession: vi.fn(async () => {}), detachSession: vi.fn(async () => {}) }]));
  const set = vi.fn((session: Session, value: string) => { selected.set(session.id, value); session.append('permission/preset', { preset: value }); });
  const tools = { register: () => () => {}, definitions: () => [{ name: 'read' }, { name: 'write' }], restrict: () => () => {}, guard: () => () => {}, setExecutor: vi.fn(() => () => {}) };
  const services: Record<string, unknown> = {
    workspaceRegistry: { get: (id: string) => workspaces.get(id), archivedSessionIds: [] as string[], unarchiveSession: vi.fn(async () => {}) }, tools,
    agentPresets: { defaultId: 'standard', resolve: async (id?: string) => ({ id: id ?? 'standard' }), mount: async () => {}, list: async () => [{ id: 'standard' }, { id: 'chosen' }] },
    sessions: { get: (id: string) => live.get(id)?.session, flush: async () => true },
    agents: { get: (id: string) => live.get(id) },
    permissionPresets: { current: (session: Session) => selected.get(session.id) ?? 'read-only', set,
      catalog: () => ({ options: ['read-only', 'workspace-write', 'danger-full-access', 'custom'].map(value => ({ value })) }) },
  };
  const ctx = { systemPrompt: { getSectionOrder: () => 1 }, get: (name: string) => services[name], on: () => () => {}, effect: () => {} } as unknown as Context;
  const create = vi.fn<DshAgentRegistry['create']>(async options => {
    const session = Session.create(SessionId(options.sessionId), undefined, { version: 4, isSeeded: false, id: SessionId(options.sessionId), cwd: options.meta?.cwd ?? root, createdAt: Date.now() });
    // Host initialization may choose a different global default. QQ creation
    // must still seed this conversation's explicit read-only default.
    selected.set(session.id, 'workspace-write');
    const agent: DshAgent = { id: session.id, session, ctx, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, model: { current: () => ({ provider: 'p', model: 'm' }) }, cancel: vi.fn(), followup: vi.fn(), whenIdle: async () => {}, runMaintenance: async task => task(new AbortController().signal) };
    const handle = { agent, dispose: vi.fn(async () => { live.delete(session.id); }) }; handles.set(session.id, handle); live.set(session.id, agent); return handle;
  });
  const registry: DshAgentRegistry = { get: id => live.get(id), create, resume: async () => { throw new Error('missing'); } };
  const config = ConfigSchema.default({ appId: 'fixture', appSecret: 'dummy', cwd: root, sessionIdleTimeout: 0 })();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const manager = new SessionManager(ctx, registry, config, logger);
  const service = new ConversationService(ctx, manager, config, logger, root); manager.conversations = service;
  const current = () => manager.getOrCreate('group', 'g', 'actor', { scope: 'group', targetId: 'g' });
  const initial = service.entry('group', 'g');
  service.store.updatePolicy(initial.key, initial.policy.version, { ...initial.policy, toolMode: 'restricted', nativeTools: false, allowedPresets: ['standard', 'chosen'], allowedPermissions: ['read-only'] });
  const key = initial.key;
  return { root, manager, service, key, current, create, set, selected, workspaces, handles, tools, services, ctx, config, logger };
}

describe('QQ native workbench ownership', () => {
  it('attaches an unbound new Session using the directory in its native header', async () => {
    const f = fixture();
    const record = await f.current();
    expect(record.agent.session.header?.cwd).toBe(f.root);
    expect(attachFallback).toHaveBeenCalledExactlyOnceWith(record.sessionId, f.root);
  });
});
