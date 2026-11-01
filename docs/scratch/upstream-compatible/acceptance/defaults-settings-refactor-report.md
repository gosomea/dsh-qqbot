# QQ 默认配置与会话设置重构验收

本轮把 QQ 设置收敛为新对话默认值和每个群、联系人的独立配置。只修改 QQ 插件，DSH 宿主保持原样。没有提交、推送、发布或部署到日常实例。

## 实现行为

- 全局默认与单对话共用同一个字段组件。配置 Agent 预设、模型、原生权限、额外提示词、工作目录与斜杠命令。
- 原生权限使用 DSH 的沙箱与审批能力。自定义工具在原生基础权限之上选择工具，提供搜索、多选、筛选全选和清空，使用原生弹层。已有目录与额外审批约束不会自动取消。
- 默认配置在首次准入时复制。修改全局默认不改已有对话。清空提示词后不会暗中注入旧 QQ 提示词；模型、预设继承宿主实际默认，旧对话保留原值。
- 会话设置只保留配置与消息记录两个页面。历史 Session 位于左侧群聊或私聊子树，默认五条后查看更多。打开历史不改接收映射。
- 接收、备注和配置集中保存。模型与权限空闲时应用。Agent 预设、目录和提示词通过新 Session 应用，旧 Session 上下文保留。
- 新对话默认保存最近 1,000 条逻辑收发记录，状态更新不重复计数。输入 0 停止新增正文，已有正文保留。旧按天规则在明确保存条数前保持不变。
- 数量清理同步处理账本、预览、缓存和已结束执行请求里的正文副本，保留防重复发送与去重标识。未决任务保留必要快照，重启不回放。
- 所有者可在关闭斜杠命令的对话中继续使用命令，仍受该对话的工具与资源限制。关闭命令不会把命令当作普通模型任务。

使用说明见[默认配置、对话设置与消息记录](../../../guides/settings-and-message-records.md)。

## 验证层级

最终运行结果与日志存放在本机 `.audit/qq-defaults-refactor-20261101/`，不进入发布包。报告应与该目录内的 `verification.json`、`host-matrix.json`、`live-evidence.json` 和 `package.log` 一起阅读。

完整测试为 76 个文件、774 项通过，包含真实 stock Host 工具执行器的七项集成用例。客户端弹层单独复测为 20 个文件、165 项通过。类型检查、公开 API 扫描、服务端和客户端构建均通过。离线夹具通过 15 项 Node 和 19 项 Python 检查。

隔离 Host 使用已登记的 `qqbot-commands` 部署，独立 Home、数据和测试工作目录，QQ HTTP 与 WebSocket 只连接本地夹具，不调用模型。九项运行时检查通过，覆盖全局版本冲突、首次复制、群和私聊隔离、整体设置与数量原子保存、命令关闭、所有者例外、总数裁剪及重启不外发。最终构建另外创建七个原生 Session，验证预设同时保存与六条历史。浏览器确认默认五条、展开第六条，以及打开历史不改变接收映射。

安装包通过支持的 CLI 安装到 `qqbot-packcheck` profile，逐文件校验安装结果与打包字节一致，确认声明入口完整、插件启用，且没有测试、审计文件或记忆服务依赖。

## 真实 QQ 与浏览器

2026-11-01 上海时间，本轮通过 CUA 在已授权机器人私聊和 c++ 测试群验证。

- 02:42:19 私聊 `/bot-status` 收到状态回复。
- 02:42:43 群内真实 @ 后 `/bot-status` 收到状态回复。
- 02:42:57 群内发送固定模型测试，02:43:04 实际收到 `QQ_DEFAULTS_REFACTOR_OK`。
- 原生 `request/header` 确认 `deepseek-codebuddy/deepseek-v4.1-flash`、推理等级 `high`。QQ 账本记录一次入站、一次自动回复，接口接受一段。
- 02:52:09 在最终构建再次群内真实 @ 测试，02:52:16 收到精确回复 `QQ_DEFAULTS_FINAL_OK`，无重试。
- 02:43:12 普通非 @ 标记在 QQ 客户端可见，但本轮插件未收到推送，记录查询为零。不能据此宣称有全量普通群消息权限。

真实浏览器验证了默认值保存与独立 API 读回，已有对话策略和映射保持不变。随后恢复原默认值。验证了深浅主题、约 505 像素主内容区、工具筛选弹层和 Escape 关闭，最后恢复原深色主题。

截图为本机私有测试证据。

- [默认设置深色](../../../.audit/qq-defaults-refactor-20261101/defaults-dark.png)。
- [默认设置浅色](../../../.audit/qq-defaults-refactor-20261101/defaults-light.png)。
- [会话设置深色](../../../.audit/qq-defaults-refactor-20261101/peer-dark.png)。
- [窄内容区浅色](../../../.audit/qq-defaults-refactor-20261101/peer-narrow-light.png)。
- [历史默认五条](../../../.audit/qq-defaults-refactor-20261101/history-five.png)。
- [历史展开](../../../.audit/qq-defaults-refactor-20261101/history-expanded.png)。
- [工具筛选](../../../.audit/qq-defaults-refactor-20261101/tools-dark.png)。
- [最终统一收发记录](../../../.audit/qq-defaults-refactor-20261101/timeline-final.png)。
- [QQ 群实际回复](../../../.audit/qq-defaults-refactor-20261101/qq-group-final.png)。
- [最终构建的 QQ 回复](../../../.audit/qq-defaults-refactor-20261101/qq-final-build.png)。

## 独立审查与修复

独立审查证明并修复了保存失败时丢失原生审批状态、数量接口漏传上限两项问题。回滚测试使用真实 Session 设置函数与实际文件重命名失败，也覆盖请求等待期间原生设置发生变化。补充修复了组合新建后预设与后续默认不一致、恢复旧 Session 覆盖待生效目录、隐藏旧默认值以及关闭记录误清历史正文的问题。

完整审查与可重复命令见本机[安全审查证据](../../../../.audit/qq-defaults-refactor-20261101/review/safety-review.md)。

## 保留与边界

真实测试 Home 为 `~/.local/share/dsh-qqbot-ui-test`，预览端口 3192。机器人绑定、已有私聊和群聊当前 Session、历史开始时间及授权策略保持不变。日常 3080 进程未重启，宿主没有新增已跟踪改动。

工作目录留空使用 QQ 默认工作目录。原生只读不等于读取只能发生在工作区。无法证明继承权限的外部子 Agent 工具保持不可用。旧策略可以保留，但本轮不再提供原来的多层高级矩阵 UI。原生空白 Session 的欢迎页可能暂不显示会话视图标签，可从左侧对话菜单进入设置。

本轮采用 Model the Domain 统一配置形状，采用 Subtract Before You Add 删除重复编辑页，采用 Prove It Works 分开记录单元、真实 Host、真实 QQ 和视觉证据。审计轨迹为 `.audit/qq-defaults-refactor-20261101/decisions.tsv`。
