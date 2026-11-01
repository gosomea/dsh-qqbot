import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationConflictError, ConversationStore } from './index.ts';
import { parseRecording } from './validation.ts';
import type { GroupMessageRecord, TimelineEntry } from '../shared/conversation-protocol.ts';

let root = '';
let now = 1_800_000_000_000;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'qq-recording-count-')); now = 1_800_000_000_000; });
afterEach(() => { rmSync(root, { force: true, recursive: true }); });
function store(): ConversationStore { return new ConversationStore(root, 'app', { now: () => now }); }
function message(id: string, text = id, at = now): GroupMessageRecord {
  return { id, text, senderId: 'member', senderName: 'sender', at, mentioned: false, attachments: [{ name: `${text}.png`, type: 'image' }] };
}
function path(key: string, kind: 'messages' | 'deliveries'): string {
  return join(root, 'conversations', createHash('sha256').update(key).digest('hex'), `${kind}.jsonl`);
}
function count(target: ConversationStore, key: string, maxMessages: number): void {
  const entry = target.get(key);
  if (!entry?.recording) throw new Error('Recording missing');
  target.updateRecording(key, entry.recording.version, { enabled: true, retentionDays: 7, maxMessages });
}
function available(rows: TimelineEntry[]): string[] {
  return rows.filter(row => (row.direction === 'inbound' ? row.message.bodyState : row.delivery.bodyState) === 'available')
    .map(row => row.direction === 'inbound' ? row.message.id : row.delivery.id);
}

describe('QQ logical message count retention', () => {
  it('zero stops new bodies and preserves previously saved records across restart', () => {
    const target = store(); const entry = target.ensure('group', 'paused');
    target.recordMessage(entry.key, message('saved', 'KEEP_EXISTING_BODY'));
    count(target, entry.key, 0);
    target.recordMessage(entry.key, message('paused', 'DO_NOT_SAVE_NEW_BODY'));
    const reopened = store();
    expect(available(reopened.timeline(entry.key).items)).toContain('saved');
    expect(readFileSync(path(entry.key, 'messages'), 'utf8')).toContain('KEEP_EXISTING_BODY');
    expect(readFileSync(path(entry.key, 'messages'), 'utf8')).not.toContain('DO_NOT_SAVE_NEW_BODY');
    expect(reopened.get(entry.key)?.recording).toMatchObject({ enabled: false, maxMessages: 0 });
  });
  it('counts mixed directions once and orders by stable timeline order despite timestamps and delivery updates', () => {
    const target = store(); const entry = target.ensure('group', 'mixed'); count(target, entry.key, 3);
    target.recordMessage(entry.key, message('first', 'OLD_FIRST_BODY', now + 86_400_000));
    target.beginDelivery(entry.key, 'outgoing', 'OLD_OUTGOING_BODY');
    target.updateDelivery(entry.key, 'outgoing', { state: 'sending', error: 'OLD_OUTGOING_BODY failed once' });
    target.updateDelivery(entry.key, 'outgoing', { state: 'accepted' });
    target.recordMessage(entry.key, message('third', 'THIRD_BODY', now - 100 * 86_400_000));
    target.updateDelivery(entry.key, 'outgoing', { state: 'accepted' });
    expect(available(target.timeline(entry.key).items)).toEqual(['third', 'outgoing', 'first']);
    target.recordMessage(entry.key, message('fourth'));
    expect(available(target.timeline(entry.key).items)).toEqual(['fourth', 'third', 'outgoing']);
    target.recordMessage(entry.key, message('fifth'));
    expect(available(target.timeline(entry.key).items)).toEqual(['fifth', 'fourth', 'third']);
    expect(readFileSync(path(entry.key, 'messages'), 'utf8')).not.toContain('OLD_FIRST_BODY');
    expect(readFileSync(path(entry.key, 'deliveries'), 'utf8')).not.toContain('OLD_OUTGOING_BODY');
    const rows = target.timeline(entry.key).items;
    expect(rows).toHaveLength(3);
    expect(target.deliveries(entry.key)[0]).toMatchObject({ id: 'outgoing', text: '', bodyState: 'expired', state: 'accepted' });
    expect(target.get(entry.key)?.recording).toMatchObject({ retentionDays: 0, maxMessages: 3 });
  });

  it('preserves unresolved bodies beyond the limit and expires a completed old delivery immediately', () => {
    const target = store(); const entry = target.ensure('c2c', 'pending'); count(target, entry.key, 1);
    target.beginDelivery(entry.key, 'pending', 'PENDING_BODY', 1, false);
    target.updateDelivery(entry.key, 'pending', { state: 'sending' });
    target.recordMessage(entry.key, message('latest'));
    expect(target.deliveries(entry.key)[0]).toMatchObject({ text: 'PENDING_BODY', state: 'sending', bodyState: 'available' });
    const completed = target.updateDelivery(entry.key, 'pending', { state: 'accepted', parts: [{ index: 0, state: 'accepted', receiptId: 'receipt' }] });
    expect(completed).toMatchObject({ text: '', state: 'accepted', bodyState: 'expired', parts: [{ receiptId: 'receipt' }] });
    target.beginDelivery(entry.key, 'uncertain', 'UNCERTAIN_BODY', 1, false);
    target.updateDelivery(entry.key, 'uncertain', { state: 'unknown' });
    target.recordMessage(entry.key, message('newest'));
    const reopened = store();
    expect(reopened.deliveries(entry.key).find(row => row.id === 'uncertain')).toMatchObject({ text: 'UNCERTAIN_BODY', state: 'unknown', bodyState: 'available' });
    expect(reopened.beginDelivery(entry.key, 'uncertain', 'UNCERTAIN_BODY', 1, false).created).toBe(false);
  });

  it('counts an incoming message and outgoing operation with the same identity as separate rows', () => {
    const target = store(); const entry = target.ensure('group', 'namespaces'); count(target, entry.key, 2);
    target.recordMessage(entry.key, message('same', 'INCOMING_BODY'));
    target.beginDelivery(entry.key, 'same', 'OUTGOING_BODY', 1, false);
    target.updateDelivery(entry.key, 'same', { state: 'accepted' });
    expect(target.timeline(entry.key).items.map(row => row.direction)).toEqual(['outbound', 'inbound']);
    target.recordMessage(entry.key, message('latest'));
    expect(target.timeline(entry.key).items.map(row => row.direction)).toEqual(['inbound', 'outbound']);
    expect(target.deliveries(entry.key)[0]).toMatchObject({ id: 'same', text: 'OUTGOING_BODY', bodyState: 'available' });
    expect(target.expiredMessageIds(entry.key)).toEqual(new Set(['same']));
    expect(target.recordMessage(entry.key, message('same', 'INCOMING_BODY'))).toBe(false);
  });

  it('purges all body copies, reports search tombstones, and retains nonreplay identities across restart', () => {
    const target = store(); const entry = target.ensure('group', 'purge'); count(target, entry.key, 10);
    target.recordMessage(entry.key, message('old-input', 'PRIVATE_INPUT_BODY'));
    target.beginDelivery(entry.key, 'old-output', 'PRIVATE_OUTPUT_BODY');
    target.updateDelivery(entry.key, 'old-output', { state: 'sending' });
    target.updateDelivery(entry.key, 'old-output', { state: 'accepted', parts: [{ index: 0, state: 'accepted' }] });
    target.noteMessage(entry.key, 'PRIVATE_INPUT_BODY', now);
    const before = target.timeline(entry.key, { query: 'PRIVATE_' });
    now += 1;
    target.recordMessage(entry.key, message('retained'));
    count(target, entry.key, 1);
    expect(target.get(entry.key)?.lastMessage).toBe('');
    const changes = target.timeline(entry.key, { after: before.snapshot, query: 'PRIVATE_', limit: 1000 });
    expect(changes.items.filter(row => row.direction === 'inbound' ? row.message.bodyState === 'expired' : row.delivery.bodyState === 'expired')).toHaveLength(2);
    expect(JSON.stringify(changes)).not.toContain('PRIVATE_');
    expect(target.timeline(entry.key, { query: 'PRIVATE_' }).items).toEqual([]);
    expect(target.messages(entry.key, { query: 'PRIVATE_' })).toEqual([]);
    expect(target.expiredMessageIds(entry.key)).toEqual(new Set(['old-input']));
    expect(target.snapshotBackground(entry.key, 'retained').text).not.toContain('PRIVATE_');
    const catalogPath = join(root, `conversations-${createHash('sha256').update('app').digest('hex')}.json`);
    for (const file of [path(entry.key, 'messages'), path(entry.key, 'deliveries'), catalogPath]) expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE_');
    const reopened = store();
    expect(reopened.recordMessage(entry.key, message('old-input', 'PRIVATE_INPUT_BODY'))).toBe(false);
    expect(reopened.beginDelivery(entry.key, 'old-output', 'PRIVATE_OUTPUT_BODY')).toMatchObject({ created: false, record: { text: '', state: 'accepted', bodyState: 'expired' } });
    expect(() => reopened.beginDelivery(entry.key, 'old-output', 'other body')).toThrow(ConversationConflictError);
    expect(() => reopened.updateDelivery(entry.key, 'old-output', { state: 'sending' })).toThrow();
    expect(reopened.timeline(entry.key).items).toHaveLength(1);
    expect(available(reopened.timeline(entry.key).items)).toEqual(['retained']);
  });

  it('disables recording at zero without treating zero as unlimited or changing native Session metadata', () => {
    const target = store(); const entry = target.ensure('group', 'zero');
    target.bindSession(entry.key, 'native-old'); target.bindSession(entry.key, 'native-current');
    target.recordMessage(entry.key, message('prior', 'PRIOR_BODY'));
    const before = target.get(entry.key);
    count(target, entry.key, 0);
    expect(target.get(entry.key)).toMatchObject({ currentSessionId: 'native-current', sessions: before?.sessions, nativeLog: before?.nativeLog, lifecycle: before?.lifecycle, policy: before?.policy, recording: { enabled: false, maxMessages: 0, retentionDays: 0 } });
    target.recordMessage(entry.key, message('disabled', 'DISABLED_BODY'));
    target.beginDelivery(entry.key, 'disabled-out', 'DISABLED_OUTPUT_BODY', 1, false);
    expect(readFileSync(path(entry.key, 'messages'), 'utf8')).toContain('PRIOR_BODY');
    expect(readFileSync(path(entry.key, 'messages'), 'utf8')).not.toContain('DISABLED_BODY');
    expect(readFileSync(path(entry.key, 'deliveries'), 'utf8')).not.toContain('DISABLED_OUTPUT_BODY');
    expect(target.messages(entry.key)).toMatchObject([{ id: 'prior', text: 'PRIOR_BODY' }]);
    expect(store().get(entry.key)?.currentSessionId).toBe('native-current');
  });

  it('preserves old day settings until an explicit count save and supports no day expiry', () => {
    const target = store(); const entry = target.ensure('group', 'legacy');
    const legacy = target.updateRecording(entry.key, 1, { enabled: true, retentionDays: 3 });
    expect(legacy.recording).not.toHaveProperty('maxMessages');
    target.recordMessage(entry.key, message('day-body'));
    now += 4 * 86_400_000;
    expect(target.messages(entry.key)).toEqual([]);
    const reopened = store();
    expect(reopened.get(entry.key)?.recording).toMatchObject({ retentionDays: 3 });
    expect(reopened.get(entry.key)?.recording).not.toHaveProperty('maxMessages');
    reopened.updateRecording(entry.key, legacy.recording!.version, { enabled: true, retentionDays: 0 });
    reopened.recordMessage(entry.key, message('no-expiry', 'NO_EXPIRY_BODY', now - 100 * 86_400_000));
    expect(reopened.messages(entry.key)).toMatchObject([{ id: 'no-expiry', text: 'NO_EXPIRY_BODY' }]);
  });

  it('validates persisted count limits and does not revive tombstones after increasing the limit', () => {
    const base = { version: 1, enabled: true, since: now, retentionDays: 0 };
    for (const value of [-1, 1.5, NaN, Infinity, 1_000_001, '3']) expect(() => parseRecording({ ...base, maxMessages: value })).toThrow(TypeError);
    expect(parseRecording({ ...base, maxMessages: 0 }).enabled).toBe(false);
    const target = store(); const entry = target.ensure('group', 'no-revival'); count(target, entry.key, 1);
    target.recordMessage(entry.key, message('old', 'OLD_BODY'));
    target.recordMessage(entry.key, message('fresh'));
    count(target, entry.key, 100);
    const nativeFile = join(root, 'native-session.jsonl'); const nativeBytes = '{"text":"NATIVE_BODY"}\n'; writeFileSync(nativeFile, nativeBytes);
    target.pruneExpired();
    expect(readFileSync(nativeFile, 'utf8')).toBe(nativeBytes);
    expect(store().messages(entry.key)).toMatchObject([{ id: 'fresh' }]);
    expect(readFileSync(path(entry.key, 'messages'), 'utf8')).not.toContain('OLD_BODY');
  });
});
