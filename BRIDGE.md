# 原生恢复调度协议

调度可由用户明确配置的 Codex heartbeat 执行；无需代理、账号转接或 Windows 计划任务。此文不代表调度已经启用，实际状态以 Codex automation 与控制台为准。

1. 先运行 `node scripts/guard.mjs targets` 获取已登记的本机会话，逐一处理，最多8个一组用原生 `wait_threads`、`timeoutMs: 0` 读取真实桌面状态。零会话时安静退出，不自行添加任务或发起账号检测。不要用自行启动的 app-server 的 `notLoaded` 推断桌面任务停止。
2. 对每个目标使用 `node scripts/guard.mjs status --target <UUID>`。所有后续任务命令都显式传相同 `--target`，不使用网页选中对象。关闭、手动暂停、任务完成、等待输入／审批时不检测、不续跑；某一轮 completed 本身不代表整个工作完成，需结合守望 halt 和最近摘要判断。
3. 获得该目标真实快照后可调用 `bridge-ready --target <UUID>`，仅更新调度连接证明。目标活跃或存在本监测器造成、确认停止且仍有授权未完工作的 halt 时，调用 `doctor --target <UUID>` 和 `tick --target <UUID>`。`tick` 控制间隔、共享预算和并发，不使用 `probe` 强制刷新。记录不变时不打扰用户。
4. 若模式为 observe，只记录检测结果；不能暂停或恢复目标任务。保护模式必须已经由准备检查允许。
5. 仅当 protect 模式达到 `phase=ready`，再次获取不超过 30 秒的新快照。目标须为 idle、latestTurn.id 等于 halt.turnId、没有 activeFlags／错误／待用户事项。必要时用 `read_thread` 看这一轮的最新摘要；若是完成工作或用户决定引起的停止，则不恢复。
6. 将 JSON 通过标准输入交给 `claim-resume --target <UUID>`：`threadId, status:"idle", turnId, needsAttention:false, checkedAt`。其中 checkedAt 是获取原生快照时的毫秒时间戳，threadId 必须与 target 相同。仅在这些值来自真实快照时填写，不能为了通过校验补造。
7. claim 成功会返回 threadId、actionId 和带一次性标记的完整 prompt。调用原生 `send_message_to_thread` 一次，使用该 prompt，省略 model/thinking。成功与否均不要自行重发同一恢复消息。
8. 真实 `UserPromptSubmit` Hook 确认标记、时效、当前证据后才解除门控。发送失败或结果不确定时保持暂停并通知用户，禁止为了“重试”重置状态。

只在检测结论改变、真正暂停／恢复、明确失败或需要用户处理时通知。正常或未知但无变化时保持安静。电脑与 Codex 必须可运行；未运行期间没有持续监测保证。
