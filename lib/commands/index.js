import { newCommand, compactCommand } from "./session.js";
import { modelCommand } from "./model.js";
import { presetCommand } from "./preset.js";
import { statusCommand } from "./status.js";
import { helpCommand } from "./help.js";
import { pingCommand, versionCommand, stopCommand } from "./misc.js";
import { getScopePeer } from "../shared/index.js";
/**
 * 构建标准命令列表
 */
export function buildCommandList(deps) {
    const commands = [
        // 通用能力（底层 agent）
        newCommand(deps),
        compactCommand(deps),
        modelCommand(deps),
        presetCommand(deps),
        stopCommand(deps),
        // QQBot 特有
        pingCommand(),
        versionCommand(deps),
        statusCommand(deps),
    ];
    // help 需要访问完整列表（含自身），通过闭包惰性引用
    commands.push(helpCommand(deps, () => commands));
    if (deps.manager.conversations) {
        commands.push({ name: 'permission', category: 'agent', scope: 'all', description: '查看此对话权限或切换已授权的权限模式',
            handler: async (ctx) => {
                const { scope, peerId } = getScopePeer(ctx);
                const service = deps.manager.conversations;
                if (deps.origin !== 'web-owner' && !service.slashAllowed(scope, peerId, ctx.message.senderId))
                    return '此 QQ 对话已停用斜杠命令。请联系机器人超级管理员，或在网页对话设置中开启。';
                const entry = service.entry(scope, peerId);
                const value = (ctx.command?.raw ?? '').trim();
                if (!value) {
                    const record = await deps.manager.restoreExisting(scope, peerId);
                    const editable = deps.origin === 'web-owner' || service.canManage(scope, peerId, ctx.message.senderId);
                    const modes = service.ctx.get('permissionPresets')?.catalog().options.filter(option => entry.policy.allowedPermissions.includes(option.value)).map(option => option.value) ?? [];
                    return `权限：${entry.policy.name}\n模式：${record ? service.currentPermission(record) : entry.policy.permission}\n本对话可用模式${editable ? '' : '（只读）'}：${modes.join('、') || '无'}\n已授权工具：${Object.entries(entry.policy.tools).filter(([, decision]) => decision !== 'deny').map(([name, decision]) => `${name} (${decision})`).join('、') || '无'}\n${editable ? '用 /permission 模式名 切换；' : '仅所有者或此对话控制者可切换；'}授权范围只能由所有者在 DSH 网页修改。`;
                }
                await service.selectPermission(entry.key, value);
                return `权限模式已切换：${value}`;
            },
        });
        for (const command of commands) {
            const original = command.handler;
            const name = Array.isArray(command.name) ? command.name[0] : command.name;
            delete command.authorized;
            command.handler = async (ctx) => {
                const { scope, peerId } = getScopePeer(ctx);
                const service = deps.manager.conversations;
                if (deps.origin !== 'web-owner' && !service.slashAllowed(scope, peerId, ctx.message.senderId))
                    return '此 QQ 对话已停用斜杠命令。请联系机器人超级管理员，或在网页对话设置中开启。';
                const args = (ctx.command?.raw ?? '').trim();
                const mutation = ['new', 'compact', 'stop'].includes(name ?? '') || (['model', 'preset', 'permission'].includes(name ?? '') && args !== '');
                const allowed = deps.origin === 'web-owner' || (name === 'stop' ? service.canStop(scope, peerId, ctx.message.senderId) : service.canManage(scope, peerId, ctx.message.senderId));
                if (mutation && !allowed)
                    return '⚠️ 无权限执行此命令，请联系机器人所有者或本群控制者。';
                if (mutation && name !== 'stop' && service.busy(service.entry(scope, peerId).key))
                    return '当前会话正在生成，请等待结束或发送 /stop。';
                try {
                    return mutation ? await service.withCommandAuthority(scope, peerId, ctx.message.senderId, deps.origin === 'web-owner', name === 'stop', () => original(ctx)) : await original(ctx);
                }
                catch (error) {
                    return `操作失败：${error instanceof Error ? error.message : '请稍后重试'}`;
                }
            };
        }
    }
    return commands;
}
//# sourceMappingURL=index.js.map