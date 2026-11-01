/** 生成 user 消息的分段文本块；空段省略。 */
export function assembleUserBlocks(input) {
    const blocks = [];
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
//# sourceMappingURL=user-blocks.js.map