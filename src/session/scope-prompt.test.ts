import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { ConfigSchema } from '../config.ts';
import { ConversationService } from '../runtime/conversation-service.ts';
import { SessionManager } from './session-manager.ts';
import type { DshAgent, DshAgentRegistry } from './types.ts';
import type { RoleSettings } from '../shared/conversation-protocol.ts';

vi.mock('../model/model-resolver.ts', () => ({ ModelResolver: class {
  resolveDefault() { return { provider: 'p', model: 'm' }; }
} }));
vi.mock('../host/adapter.ts', () => ({ createHostAdapter: () => ({ capabilities: [] }) }));

interface Prompt { sections: Array<{ name: string; order: number; text: string }> }
type Assemble = (assembly: unknown, context: { agent?: DshAgent }, next: () => Promise<Prompt>) => Promise<Prompt>;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qq-scope-prompt-')); roots.push(root);
  const live = new Map<string, DshAgent>();
  const sessions = new Map<string, Session>();
  const hooks: { assemble?: Assemble } = {};
  const registry: DshAgentRegistry = {
    get: id => live.get(id),
    create: async () => { throw new Error('No Agent creation in prompt assembly'); },
    resume: async () => { throw new Error('No Agent resume in prompt assembly'); },
  };
  const services = { sessions: { get: (id: string) => sessions.get(id) } };
  const ctx = { get: (name: string) => name === 'sessions' ? services.sessions : undefined,
    on: (event: string, handler: Assemble) => { if (event === 'system-prompt/assemble') hooks.assemble = handler; return () => {}; }, effect: () => {},
  } as unknown as Context;
  const config = ConfigSchema.default({ appId: 'fixture', appSecret: 'dummy', cwd: root,
    sessionIdleTimeout: 0, groupPrompt: 'GROUP_EXTRA', directPrompt: 'DIRECT_EXTRA' })();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const manager = new SessionManager(ctx, registry, config, logger);
  let service = new ConversationService(ctx, manager, config, logger, root);
  manager.conversations = service;
  const agent = (id: string, parentSession?: string): DshAgent => {
    const session = Session.create(SessionId(id), undefined, { version: 4, isSeeded: false, id: SessionId(id), cwd: root, createdAt: Date.now(), ...(parentSession ? { parentSession: SessionId(parentSession) } : {}) });
    const value: DshAgent = { id, session, ctx, status: 'idle', inbox: { nextTurn: [], nextStep: [] },
      cancel: vi.fn(), followup: vi.fn(), whenIdle: async () => {}, runMaintenance: async task => task(new AbortController().signal) };
    sessions.set(id, session); live.set(id, value); return value;
  };
  const bind = (scope: 'group' | 'c2c', peerId: string, id: string, role: RoleSettings) => {
    const entry = service.entry(scope, peerId);
    service.store.updatePolicy(entry.key, entry.policy.version, { ...entry.policy, role });
    service.store.bindSession(entry.key, id);
  };
  const restart = () => {
    service = new ConversationService(ctx, manager, config, logger, root);
    manager.conversations = service;
  };
  const assemble = async (value?: DshAgent) => {
    if (!hooks.assemble) throw new Error('Prompt hook was not registered');
    return hooks.assemble({}, { agent: value }, async () => ({ sections: [{ name: 'base', order: 0, text: 'BASE_PROMPT' }] }));
  };
  return { manager, agent, bind, restart, assemble, live };
}

const role = (description: string): RoleSettings => ({ description, tone: `${description}_TONE`, world: `${description}_WORLD`, prompt: `${description}_PROMPT` });
const prompt = (assembled: Prompt) => assembled.sections.map(section => section.text).join('\n');

describe('QQ scope prompt on native Session recovery', () => {
  it('assembles the first native request from persisted ownership before manager restoration', async () => {
    const f = fixture();
    f.bind('group', 'a', 'group-a', role('ROLE_A'));
    f.bind('group', 'b', 'group-b', role('ROLE_B'));
    f.bind('c2c', 'private', 'private', role('ROLE_PRIVATE'));
    f.restart();
    expect(f.manager.findBySessionId('group-a')).toBeUndefined();
    const groupA = prompt(await f.assemble(f.agent('group-a')));
    expect(groupA).toContain('BASE_PROMPT'); expect(groupA).toContain('GROUP_EXTRA');
    expect(groupA).toContain('ROLE_A'); expect(groupA).toContain('语气：ROLE_A_TONE');
    expect(groupA).toContain('世界观：ROLE_A_WORLD'); expect(groupA).toContain('ROLE_A_PROMPT');
    expect(groupA).not.toContain('ROLE_B'); expect(groupA).not.toContain('DIRECT_EXTRA');
    const groupB = prompt(await f.assemble(f.agent('group-b', 'group-a')));
    expect(groupB).toContain('ROLE_B'); expect(groupB).not.toContain('ROLE_A');
    const direct = prompt(await f.assemble(f.agent('private')));
    expect(direct).toContain('DIRECT_EXTRA'); expect(direct).toContain('ROLE_PRIVATE');
    expect(direct).not.toContain('GROUP_EXTRA');
  });

  it('uses the requested historical Session snapshot and its descendants after role rotation', async () => {
    const f = fixture();
    f.bind('group', 'g', 'old', role('OLD_ROLE'));
    f.bind('group', 'g', 'current', role('CURRENT_ROLE'));
    f.bind('group', 'g', 'current', role('PENDING_ROLE'));
    f.restart();
    f.agent('old');
    const old = prompt(await f.assemble(f.live.get('old')));
    expect(old).toContain('OLD_ROLE'); expect(old).not.toContain('CURRENT_ROLE');
    const current = prompt(await f.assemble(f.agent('current')));
    expect(current).toContain('CURRENT_ROLE'); expect(current).not.toContain('OLD_ROLE');
    expect(current).not.toContain('PENDING_ROLE');
    f.agent('child', 'old');
    const descendant = prompt(await f.assemble(f.agent('grandchild', 'child')));
    expect(descendant).toContain('OLD_ROLE'); expect(descendant).not.toContain('CURRENT_ROLE');
  });

  it('does not inject into unrelated, absent, replaced, or forged Agents', async () => {
    const f = fixture(); f.bind('group', 'g', 'known', role('GROUP_ROLE')); f.restart();
    const known = f.agent('known');
    const unrelated = f.agent('unrelated');
    const forged = { ...known };
    expect(prompt(await f.assemble(unrelated))).toBe('BASE_PROMPT');
    expect(prompt(await f.assemble())).toBe('BASE_PROMPT');
    expect(prompt(await f.assemble(forged))).toBe('BASE_PROMPT');
    f.agent('known');
    expect(prompt(await f.assemble(known))).toBe('BASE_PROMPT');
    expect(prompt(await f.assemble(f.live.get('known')))).toContain('GROUP_ROLE');
  });
});
