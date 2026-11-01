var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { SessionId } from '@deepseek-ai/dsh-session';
/** 模块级函数的动态 import 结果缓存（spec 变量路径绕开本地依赖类型检查） */
const moduleCache = new Map();
async function importModule(spec, logger) {
    if (moduleCache.has(spec))
        return moduleCache.get(spec);
    let mod;
    try {
        mod = (await import(__rewriteRelativeImportExtension(spec)));
    }
    catch {
        mod = undefined;
        logger?.warn(`host adapter: module not resolvable: ${spec}`);
    }
    moduleCache.set(spec, mod);
    return mod;
}
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
        capabilities.push('serviceFor(serviceForAgent动态)');
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
            if (resolveFn) {
                try {
                    return resolveFn(agent, name);
                }
                catch { /* 宿主实现差异，走模块函数 */ }
            }
            const mod = await importModule('@deepseek-ai/dsh-agent-presets', logger);
            const fn = mod?.serviceForAgent;
            if (typeof fn !== 'function')
                return undefined;
            try {
                return fn(ctx, agent, name);
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
/** 测试辅助：清空模块缓存 */
export function _resetAdapterCache() {
    moduleCache.clear();
}
//# sourceMappingURL=adapter.js.map