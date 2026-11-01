# 审计报告：宿主零改动 / 插件自闭环 核实

仓库：dsh-qqbot-upstream-compatible（分支 codex/qq-upstream-compatible，相对 linux main 36 commits / 260 files / +30492−3922）
宿主：deepseek-harness @ f3803c9697 (release 0.2.2-alpha.2)
审计方式：只读 + 运行仓库自带守卫 scripts/check-stock-host.mjs

## 一、结论（判定）

**宿主零改动：成立。**

1. 宿主工作树 git status 仅剩未跟踪的 tmp-delivery/（交付/审计临时目录，非宿主源码修改），HEAD 干净（f3803c9697）。
2. 插件 repo 无 .gitmodules、无 git submodule（git submodule status 为空），不通过 submodule 引用或嵌入宿主。
3. 插件无任何指向宿主源码的自定义补丁。唯一 .patch 是 .audit/qq-defaults-refactor-20261101/baseline.patch，diff 目标全部是插件自身文件（.gitignore/.npmignore/README/lib/*），不涉及 host 路径。
4. 仓库自带守卫 `node scripts/check-stock-host.mjs` → status=passed，files=132，failures=[]（扫描 src 里已退役/私有符号、私有 import、禁用的包）。
5. install.sh 走 dsh 官方 `dsh plugin --profile <name> add` 机制；dsh.bundle.patch 指向的 cordis.patch.yml 只“往宿主 loader 树里 insert 一个插件行”，属 DSH 公开的 bundle patch 元数据，不是改写宿主源码。

**依赖全部走公开接口：基本成立（未发现私有符号 hack）。**

1. 所有 @deepseek-ai/* 静态 import 均能在 package.json 的 dependencies/peerDependencies/devDependencies 中找到声明，未声明包数 = 0。
2. type-only 与 runtime import 均指向各包公开入口；唯一 /src/ 深层路径出现在测试文件 src/client/qq-sidebar-navigation.test.ts:2（非生产代码，不进 lib 产物）。
3. ctx.get('...') 使用的服务名全部是宿主真实提供（agents / sessions / sessionController / workspaceRegistry / permissionPresets / agentPresets / sandboxPolicy / approval / attachments / llm / tools / ptcRuntime / sessionPersistence / userQuestions / sessionQuery / systemPrompt），逐一在宿主 packages 找到 provide() 或 super(ctx,'name')。
4. ctx.systemPrompt / ctx.uiWorkspace / ctx.remote.* 均为公开扩展点；client 侧 inject 声明的 slots/remote/uiWorkspace/locale/layout/uiSession/sessions/webServer 均在宿主存在。
5. 无 require() 内部路径（grep 仅命中插件自身 this.require(key) 私有方法）；无 node_modules/... 硬编码运行时 import。

**lib/ 入库构建产物：确认存在“提交构建产物 vs 源码”一致性风险（见风险项）。**

## 二、证据清单（文件:行号）

### E1 无 submodule
- ls .gitmodules → NO_GITMODULES；git submodule status → 空。

### E2 dsh.bundle.patch 只是公开 bundle 元数据
- package.json: dsh.bundle.patch = ./cordis.patch.yml；其内容为单个 `- insert: [ {id: im-qqbot, name: '@tencent-connect/dsh-qqbot', config: ...} ]`，仅向宿主 loader 树插入插件行。

### E3 脚本不修改宿主
- scripts/link-stock-host.mjs：只改写插件自己 package.json 的 devDependencies link 路径；运行前校验宿主 `git diff --quiet HEAD`（宿主有改动则报错），末尾打印 “The Host was not modified.”
- scripts/check-stock-host.mjs：纯只读扫描器 + 退出码，不写文件。
- scripts/prepare-test-pkg.js：只改本仓库 package.json 的 name 与 cordis.patch.yml 的 name（内网包名替换），不碰宿主。
- install.sh：调 `dsh plugin ... add`，不 patch 宿主。

### E4 宿主工作树
- cd <host> && git status --porcelain → 仅 ?? tmp-delivery/（未跟踪）；HEAD=f3803c9697。

### E5 服务名均为公开接口（抽样）
- src/runtime/conversation-service.ts:449-522,653-664：ctx.get('sessions'|'sandboxPolicy'|'permissionPresets'|'workspaceRegistry'|'approval'|'agents')。
- src/features/question-channel.ts:265：ctx.get('userQuestions')（宿主 packages/interaction/user-questions/src/index.ts:86 super(ctx,'userQuestions')）。
- src/session/session-manager.ts:122-156：ctx.get('agentPresets'|'sessionQuery'|'sessionPersistence')（sessionQuery 见 packages/session-query/session-query/src/index.ts:106）。
- src/prompt/install.ts:44：agentCtx.get('systemPrompt')。
- src/client/index.ts:30 inject=[...'remote','remote.session','remote.workspace','remote.agentPresets','remote.permissionPresets','locale','uiWorkspace']；:110-131 使用 ctx.remote.permissionPresets / ctx.remote.session.modelCatalog / ctx.uiWorkspace.pickDirectory / ctx.remote.workspace.create / ctx.remote.agentPresets.list。

### E6 “as unknown as” 强转都是收窄公开界面，不是私有 hack
- src/index.ts:26 ctx.agents（inject 已声明 'agents'）、:27 ctx.logger。
- src/setup/index.ts:70/89/119：ctx.inject(...)/ctx.effect(...) —— cordis 公开 Context 成员（vendor/cordis/lib/types/context.d.ts 明确 get/provide/inject/effect）。
- src/model/model-resolver.ts:241 ctx.get 可选获取；:250 类型校验失败抛明确错误。
- src/host/adapter.ts:112 safeGet 包 ctx.get。
- 结论：均为“接口最小化 / 可选获取”的可移植写法（适配宿主新旧版本），未访问宿主未导出符号，未改写宿主服务方法（无 userQuestions.ask= 之类）。

### E7 唯一 /src/ 深层 import 在测试
- src/client/qq-sidebar-navigation.test.ts:2 → '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'（测试专属，产物不入 lib）。

### E8 lib/ 跟踪状态
- git ls-files lib | wc -l → 103（全部 .js）；git ls-files 'lib/**/*.d.ts' = 0、'lib/**/*.map' = 0（.gitignore 显式排除 lib/**/*.d.ts 与 lib/**/*.map）。
- 磁盘 find lib -type f = 410（含 .d.ts/.map，未入库）；lib 顶层 4 个 .js + 16 个子目录。
- src 跟踪 209 个文件（含 tests）。

### E9 打包配置
- package.json 无 "files" 字段（靠 .npmignore 白名单式排除）。
- .npmignore 排除 src/、dev、tsconfig、tests/、scripts/verify-qqbot.mjs、TESTING.md、scripts/link-native-host.mjs、scripts/check-stock-host.mjs、scripts/workbench-*.py、*.map、.audit/ 等 → 发布包以 lib 产物为准。
- .gitignore 注释：“lib/ 构建产物入库（GitHub 安装开箱即用），但排除类型与 sourcemap”。

### E10 lib 与 src 同步性
- 最近一次提交 b5b5f6c 同时改 lib 与 src（同一 commit）；近 40 次提交 38 次动 lib、40 次动 src、36 次同时动两者——大体同步。
- 当前工作树存在未提交改动：src/client/qq-sidebar.ts（1 行 +）尚未重建到 lib。

## 三、风险项

1. **提交构建产物（103 个 lib/*.js）入 git：非常规但属有意取舍。** 好处是 GitHub 直接安装（不跑 build）可用；风险是源码与产物需人工双提交保持同步，存在滞后窗口（当前 src/client/qq-sidebar.ts 已有未提交改动，未同步到 lib/client.js）。任一“改 src 忘 build/提交 lib”都会导致 git 内源码与用户实际运行产物不一致。
2. **package.json 缺 files 字段**：发布内容完全依赖 .npmignore 排除规则，后续新增目录若忘加进 .npmignore 会被打进 npm 包（当前覆盖较全，风险可控）。
3. **src/host/adapter.ts:79 动态 import '@deepseek-ai/dsh-agent-presets'**：该包名未在 package.json 声明，且当前宿主不存在导出 serviceForAgent 的 @deepseek-ai/dsh-agent-presets 包（宿主实际公开包为 dsh-agent-preset-registry，提供实例方法 serviceFor，见 packages/preset/agent-preset-registry/src/index.ts:340）。该动态 import 属“新宿主模块函数”兼容回退分支，实际走主路径 presets.serviceFor；回退分支若在旧/异形宿主触发会静默失败（catch 返回 undefined）。属版本漂移兼容垫片，非私有 hack，但为“未声明 + 当前无法解析”的软依赖，建议清理或文档标注。
4. **as unknown as 广用**：虽均为公开成员收窄，但削弱类型安全，宿主 API 形态变更易在运行时才暴露（adapter 层已部分兜底）。
5. **测试文件引用 /src/ 深层路径**（src/client/qq-sidebar-navigation.test.ts:2）：仅测试、不进产物，但未 link 源码的 CI 上会解析失败。

## 四、复核命令
- 宿主零改动：cd <host> && git status --porcelain && git log -1 --format=%h
- 守卫：node scripts/check-stock-host.mjs --root .
- 未声明包：对比 src 中 from '@deepseek-ai/*' 与 package.json 三类依赖 → 差集为空
- lib 跟踪：git ls-files lib | wc -l = 103；.d.ts/.map 未跟踪
