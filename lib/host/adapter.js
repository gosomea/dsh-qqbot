import { SessionId } from '@deepseek-ai/dsh-session';
/** 插件创建的工作区显示名；仅在该 cwd 尚无工作区时生效（幂等 create 不改既有 title） */
const WORKSPACE_TITLE = 'QQBot';
/** 取出可用的 workspaceRegistry；形态不匹配返回 undefined（dsh-workspace 未挂载时无侧边栏） */
function workspaceRegistry(ctx) {
    const registry = safeGet(ctx, 'workspaceRegistry');
    return typeof registry?.create === 'function' ? registry : undefined;
}
/** 模块级函数的动态 import 结果缓存（spec 变量路径绕开本地依赖类型检查） */
export function createHostAdapter(ctx, logger) {
    const capabilities = [];
    // events 读取路径只有运行时才能确定，sessionEvents 内自适应
    capabilities.push('sessionEvents(s自适应)');
    let resolveFn;
    const presets = safeGet(ctx, 'agentPresets');
    if (presets && typeof presets.serviceFor === 'function') {
        resolveFn = (agent, name) => presets.serviceFor(agent, name);
        capabilities.push('serviceFor(presets实例方法)');
    }
    else {
        capabilities.push('serviceFor(Agent作用域)');
    }
    return {
        capabilities,
        sessionEvents(session) {
            if (typeof session.snapshotEvents === 'function')
                return session.snapshotEvents();
            const legacy = session.events;
            return Array.isArray(legacy) ? legacy : [];
        },
        async serviceFor(agent, name) {
            const scoped = agent.ctx;
            if (scoped && typeof scoped === 'object' && 'get' in scoped && typeof scoped.get === 'function') {
                try {
                    const value = scoped.get(name);
                    if (value !== undefined && value !== null)
                        return value;
                }
                catch { /* Legacy preset lookup remains available when scoped injection is absent. */ }
            }
            if (!resolveFn)
                return undefined;
            try {
                return resolveFn(agent, name);
            }
            catch {
                return undefined;
            }
        },
        async resolveAgent(sessionId) {
            const controller = safeGet(ctx, 'sessionController');
            if (!controller?.resolveAgent)
                throw new Error('当前宿主缺少原生会话恢复接口，原会话保持不变。');
            const result = await controller.resolveAgent(SessionId(sessionId));
            if ('agent' in result)
                return result.agent;
            if (result.error.code === 'session/not-found')
                return undefined;
            throw result.error;
        },
        async attachSessionToWorkspace(sessionId, cwd) {
            const registry = workspaceRegistry(ctx);
            if (!registry) {
                // 未挂载 dsh-workspace（如 headless profile）→ 无侧边栏，属预期降级
                logger?.debug?.(`host adapter: workspaceRegistry 未挂载，跳过会话 ${sessionId} 的工作区归属`);
                return;
            }
            try {
                const workspace = await registry.create(cwd, WORKSPACE_TITLE);
                if (!workspace || typeof workspace.attachSession !== 'function') {
                    // 宿主接口演进：返回对象不含 attachSession → warn 避免静默失效
                    logger?.warn?.(`host adapter: workspaceRegistry.create 返回了无 attachSession 的对象，跳过会话 ${sessionId}`);
                    return;
                }
                await workspace.attachSession(sessionId);
                logger?.debug?.(`host adapter: attached session ${sessionId} to workspace ${workspace.path ?? cwd}`);
            }
            catch (err) {
                // 仅影响侧边栏展示，绝不打断消息处理；但属异常（cwd 不匹配/目录缺失等），warn 留痕
                logger?.warn?.(`host adapter: workspace attach failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
        globalService(name) {
            return safeGet(ctx, name);
        },
    };
}
/** ctx.get 的非抛出版本 */
function safeGet(ctx, name) {
    try {
        return ctx.get(name);
    }
    catch {
        return undefined;
    }
}
/** 测试辅助：模块缓存已移除，保留空实现以兼容既有测试调用。 */
export function _resetAdapterCache() { }
//# sourceMappingURL=adapter.js.map