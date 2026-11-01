# QQ 发送错误与被动回复时限

日期：2026-10-31。分支 `codex/qq-upstream-compatible`，未提交、未发布。只改 QQ 插件及说明，使用未修改的 stock Host f3803c9；日常3080保持原进程。

## 修改

- 从 SDK ApiError 提取 HTTP 状态、QQ业务码和平台原因。明确4xx拒绝（408除外）记为failed；网络、408、5xx及无法解析确认的情况保留unknown。提示有长度限制和凭据/来源字段脱敏，不保存完整SDK异常路径。
- 发送预览、记录页显示被动回复来源的真实截止时间和倒计时。达到截止后切换为“被动回复窗口已过期”，无有效来源时按钮明确为“尝试主动发送到 QQ”。没有把窗口有效等同于剩余次数或保证送达。
- 获准且去重通过后、mention过滤前记录回复来源。不@消息只有平台实际推送后才能提供ID；不因此触发模型或开启磁盘记录。重复消息、列表读取、查询记录不延长时限。
- 手动发送在队列开始时选择同一对话的有效来源，各分段保持同一来源，分段前复查到期。原生QQ轮次保留其原目标。不因拒绝自动换来源或重试。
- 原有unknown记录不猜测补码。群记录模式保持原状，默认recent没有完整流水；archive才把实际获准收到的规范化消息写到messages.jsonl，默认7天。具体说明见[原生会话说明](../../../guides/native-sessions.md)。

## 已验证

- 66个Vitest文件、698项通过，包含真实DSH执行器策略测试、实际ReactDOM Modal/反馈组件及到期计时测试。
- 服务端、客户端类型检查与插件构建通过；公开接口扫描111个生产文件通过。
- 官方CLI安装内容寻址包到已有qqbot-packcheck profile，197个包内文件与安装结果逐一匹配；测试和私密证据未进入包。
- 独立源码审查未发现本轮已证实的P1/P2。
- 同SDK真实主动发送诊断返回HTTP400/40034105“主动消息失败, 无权限”。通过更新后的会话发送接口再次验证，结果保存为failed，原始错误码可查询；同operationId重复调用返回相同终态。
- 子agent通过QQ原生CUA在已授权c++测试群只发送一条普通消息：21:50:27，QQ客户端可见，但插件lastReceivedAt仍null、普通群推送未观测、没有回复来源。此结果只证明本次没收到，不宣称账号永久无法开通。
- 同群实际@测试于21:52:22发送，插件收到消息，生成截止21:57:22的五分钟来源。来源后来已过期。被动发送目标选择、分段中途过期、重复不延长TTL在入口/服务回归中通过。随后按用户选择取消归档后，真实被动手动发送也已验证，见下文。

## 归档阻碍与用户选择后的恢复

现有c++当前Session `session-47c1801d-e260-4be3-b14f-014c59849ed4` 在DSH全局归档列表中。只读核对确认：ArchivedSessionGate使本次@输入产生turn/start→inbox/spliced→turn/end(blocked)，没有模型step；原生导航的clearArchivedCurrent会清除已归档main，因此出现空白与随后Sidebar reference released取消日志。没有证据表明本轮反馈UI改动导致此归档状态。

用户随后明确选择继续原会话、取消归档并保留上下文。通过公开 workspace/unarchiveSession 只移除当前c++Session的归档标记，其余3条归档保留。SessionID及QQ映射保持不变，没有新建会话或重放此前blocked的输入。原生主聊天现在能够正常打开，旧4轮回答仍可见。

恢复后，网页生成仅网页回答QQ_WEB_SEND_OK，确认未自动发往QQ。子agent于22:11:06在同一c++群实际@机器人，22:11:22在QQ客户端看到QQ_UNARCHIVE_OK回复；API也记录accepted。随后网页预览显示同群目标、原Session及22:16:07截止的有效窗口，显式确认后API接受1/1段，22:12:45由子agent在QQ客户端只读截图核对收到QQ_WEB_SEND_OK。实际模型为deepseek-codebuddy/deepseek-v4.1-flash、reasoning high。

发送记录页面已实际显示被动倒计时、新成功记录和既有40034105失败详情，旧unknown记录继续保留原状态。22:16:07自然到期后，浏览器发送记录与发送预览均实际显示“被动回复窗口已过期”，预览按钮切换为“尝试主动发送到 QQ”。此次仅核对显示，没有再次主动发送。

## 保留状态与证据

保留已有扫码绑定、QQ策略与当前Session映射。真实测试增加了对应入站计数/运行事件和一条明确失败的诊断投递；未开启群记录、未更换模型/预设/权限；仅按用户明确选择取消当前c++会话归档。

私密材料在 `.audit/qq-upstream/send-feedback-*`，包含构建/测试日志、普通消息与@接收对照、原生catalog/state快照和明确拒绝结果。SDK首轮独立诊断记录为 `.audit/qq-upstream/send-investigation-20261031.json`。这些文件不进入npm安装包。

恢复后的界面证据：[有效窗口](../../../.audit/qq-upstream/send-feedback-unarchived-window.png)、[显式发送接受](../../../.audit/qq-upstream/send-feedback-unarchived-accepted.png)。

自然到期证据：[发送记录](../../../.audit/qq-upstream/send-feedback-unarchived-expired.png)、[过期发送预览](../../../.audit/qq-upstream/send-feedback-unarchived-expired-preview.png)。
