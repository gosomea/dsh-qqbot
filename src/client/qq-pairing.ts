/**
 * 配对码认领 UI —— Web 侧生成一次性码、展示已认领成员、撤销。
 *
 * 与 QQ 侧 `/claim 码` 配合：Web 生成码 → 用户在 QQ 发送 → 机器人写名单。
 * 本组件只负责 Web 端的码展示与已认领列表；真正的 openid 绑定在服务端完成。
 */
import { createElement as h, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { fetchJson } from './http.ts';
import {
  PAIR_ISSUE_PATH, PAIR_REVOKE_PATH, PAIR_STATUS_PATH, openidTail,
  type ClaimedMember, type PairPurpose, type PairStatusWire,
} from '../shared/pairing-protocol.ts';

/** 配对状态轮询间隔（进行中的码需要实时反映"已认领"）。 */
const POLL_MS = 2000;

function usePairStatus(active: boolean): { status: PairStatusWire | null; error: string | null; reload: () => void } {
  const [status, setStatus] = useState<PairStatusWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const load = (): void => { void fetchJson<PairStatusWire>(PAIR_STATUS_PATH, { cache: 'no-store' }).then((s) => { if (!stopped) { setStatus(s); setError(null); } }).catch((c: unknown) => { if (!stopped) setError(c instanceof Error ? c.message : '读取认领状态失败'); }); };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [active, tick]);
  return { status, error, reload };
}

/** 单个用途的认领面板：生成码 / 展示进行中的码 / 已认领成员列表（可撤销）。 */
export function PairClaimPanel({ purpose, title, hint }: {
  purpose: PairPurpose; title: string; hint?: string;
}): ReactNode {
  const { status, error, reload } = usePairStatus(true);
  const members: ClaimedMember[] = status === null ? [] : purpose === 'owner' ? status.owners : purpose === 'allow-group' ? status.allowGroup : status.allowC2c;
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // 轮询到"该码已认领"（challenges 里消失且成员新增）时提示。
  useEffect(() => {
    if (code === null || status === null) return;
    if (!status.challenges.some((c) => c.code === code.code)) { setCode(null); setMsg('已认领 ✔'); }
  }, [status, code]);

  const issue = (): void => {
    if (busy) return;
    setBusy(true); setMsg(null);
    void fetchJson<{ code: string; expiresAt: number }>(PAIR_ISSUE_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose }) })
      .then((r) => { setCode({ code: r.code, expiresAt: r.expiresAt }); reload(); })
      .catch((c: unknown) => setMsg(c instanceof Error ? c.message : '生成配对码失败'))
      .finally(() => setBusy(false));
  };
  const revoke = (openid: string): void => {
    if (busy) return;
    setBusy(true); setMsg(null);
    void fetchJson(PAIR_REVOKE_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose, openid }) })
      .then(() => reload())
      .catch((c: unknown) => setMsg(c instanceof Error ? c.message : '移除失败'))
      .finally(() => setBusy(false));
  };

  const secs = code ? Math.max(0, Math.round((code.expiresAt - Date.now()) / 1000)) : 0;
  return h('div', { className: 'imqc-pair' },
    h('div', { className: 'imqc-inline' }, h('strong', null, title), h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: issue }, code ? '重新生成' : '在 QQ 认领…')),
    hint ? h('p', { className: 'imqc-hint' }, hint) : null,
    code ? h('div', { className: 'imqc-pairCode' },
      h('span', { className: 'imqc-hint' }, '在 QQ 给机器人发送：'),
      h('code', null, `/claim ${code.code}`),
      h('span', { className: 'imqc-hint' }, `（${secs}s 内有效，认领成功后自动消失）`)) : null,
    msg ? h('p', { className: 'imqc-hint', role: 'status' }, msg) : null,
    error ? h('p', { className: 'imqc-error', role: 'alert' }, error) : null,
    members.length === 0
      ? h('p', { className: 'imqc-hint' }, '尚未认领任何成员。')
      : h('ul', { className: 'imqc-pairMembers' }, ...members.map((m) => h('li', { key: `${m.openid}:${m.scene}` },
          h('span', null, `${m.nickname || '(未命名)'} · ${openidTail(m.openid)}${m.sceneName ? ` · ${m.scene === 'group' ? '群' : '私聊'}「${m.sceneName}」` : ''}`),
          h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => revoke(m.openid) }, '移除')))));
}
