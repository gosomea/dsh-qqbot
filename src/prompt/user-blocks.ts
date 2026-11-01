/**
 * 本轮 user 消息正文的 block 组装（[引用]/[群聊背景]/[用户正文]）。
 * 元信息（来源/@/发送者/时间）不在这里，走 turn-meta 的 runtime context。
 */
export interface UserBlockInput {
  /** 用户正文（已含语音转录/附件标签）。 */
  body: string;
  /** 被引用消息的原文（可选）。 */
  quote?: string;
  /** 群聊非 @ 的背景消息（仅资料，可选）。 */
  background?: string;
}

/** 生成 user 消息的分段文本块；空段省略。 */
export function assembleUserBlocks(input: UserBlockInput): string[] {
  const blocks: string[] = [];
  if (input.quote && input.quote.trim()) {
    blocks.push(`[引用的消息]
${input.quote.trim()}
[当前消息]`);
  }
  if (input.background && input.background.trim()) {
    blocks.push(`[群聊背景，仅作资料]
${input.background.trim()}
[当前消息]`);
  }
  blocks.push(input.body);
  return blocks;
}
