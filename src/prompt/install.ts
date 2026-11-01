/**
 * 把 QQ 的 prompt section/context 注册到某个 agent 的 ctx（per-agent scope）。
 *
 * 与 installPolicy 同生命周期：agent 挂载时安装，agent 销毁时 dispose。
 * 使用 DSH 正规扩展点 ctx.systemPrompt.section()/context()，不再走 system-prompt/assemble waterfall。
 * 所有 section.text 都是惰性函数，每步组装时现读 entry —— 改补充词/人设即时生效，无需重注册。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { QQScope } from './scope.ts';
import { RULES_SECTION_NAME, RULES_ORDER, RULES_TEXT } from './rules.ts';
import { SCOPE_SECTION_NAME, SCOPE_ORDER, scopeText } from './scope.ts';
import { PERSONA_SECTION_NAME, PERSONA_ORDER, selectPersonaText } from './persona.ts';
import { EXTRA_SECTION_NAME, EXTRA_ORDER, selectExtraPrompt } from './extra.ts';
import { TURN_META_CONTEXT_NAME, TURN_META_ORDER, turnMetaText, type TurnMeta } from './turn-meta.ts';

/** 当前会话 prompt 需要的数据（惰性读取，保证热更新）。 */
export interface QQPromptEntry {
  readonly scope: QQScope;
  /** 人设 role-card markdown（可为空）。 */
  personaCard(): string;
  /** 补充提示词（群/私分字段）。 */
  extraPrompts(): { group?: string; direct?: string };
}

/** 每个 agent 的"本轮运行时元信息"，由 inbound 每轮写入、context 函数读取。 */
export interface TurnMetaHolder {
  current?: TurnMeta;
}

/** 已安装的 QQ prompt 句柄：可更新本轮元信息。 */
export interface QQPromptHandle {
  /** 记录本轮元信息（来源/@/发送者/时间）；下一轮组装时生效。 */
  setTurnMeta(meta: TurnMeta | undefined): void;
  dispose(): void;
}

interface SystemPromptLike {
  section(section: { name: string; order: number; text: string | ((context: unknown) => string); interpolate?: boolean }): () => void;
  context(context: { name: string; order: number; text: string | ((context: unknown) => string); interpolate?: boolean }): () => void;
}

/** 在 agent.ctx 上安装 QQ prompt sections/contexts；返回可更新的句柄。 */
export function installQQPrompt(agentCtx: Context, entry: QQPromptEntry): QQPromptHandle {
  const service = agentCtx.get('systemPrompt') as SystemPromptLike | undefined;
  if (service === undefined) throw new Error('当前宿主缺少 systemPrompt 服务，无法注入 QQ prompt');

  const holder: TurnMetaHolder = {};
  const disposers: Array<() => void> = [];
  disposers.push(service.section({ name: RULES_SECTION_NAME, order: RULES_ORDER, text: RULES_TEXT }));
  disposers.push(service.section({ name: SCOPE_SECTION_NAME, order: SCOPE_ORDER, text: () => scopeText(entry.scope) }));
  disposers.push(service.section({ name: PERSONA_SECTION_NAME, order: PERSONA_ORDER, text: () => selectPersonaText(entry.personaCard(), entry.scope) }));
  disposers.push(service.section({ name: EXTRA_SECTION_NAME, order: EXTRA_ORDER, text: () => selectExtraPrompt(entry.extraPrompts(), entry.scope) }));
  disposers.push(service.context({ name: TURN_META_CONTEXT_NAME, order: TURN_META_ORDER, text: () => (holder.current ? turnMetaText(holder.current) : '') }));

  return {
    setTurnMeta(meta) { holder.current = meta; },
    dispose() { for (const dispose of disposers.reverse()) dispose(); },
  };
}
