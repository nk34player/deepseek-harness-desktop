# Agent Note: native notifications from the web GUI to the OS

Status: implemented

[English](2026-08-18-desktop-notification-pipeline.md) | 中文

## 问题

桌面外壳只为 harness supervisor 事件（崩溃、反复重启、恢复）弹出原生通知。Web GUI 知道的一切——审批请求、更新可用——都停留在窗口内部，因此用户在另一个应用里时完全收不到提醒。根本没有渲染进程到主进程的通知通道：`window.dshDesktop` 暴露了窗口控制、偏好、深链和更新，但没有任何显示通知的方法。

## 决策

新增一条窄的渲染进程到主进程通知通道：

- preload 桥接新增 `notify({ title, body })`，由外壳中的 `dsh:notification-show` IPC 处理器支撑。处理器在信任边界校验载荷（格式错误的载荷被丢弃，绝不抛出），遵循通知偏好与 `Notification.isSupported()`，并使用应用图标显示 Electron `Notification`。
- Web GUI 有两个触发点（都仅限桌面，无桥接时静默无操作）：
  - 会话管理器的 `approval/requested` 帧处理弹出「`<toolName>`」需要审批——每个新审批只弹一次；重放仍待处理的请求是幂等的，不得再次提醒。
  - ui-update 状态源在进入 `available` 阶段时弹出发现新版本 `<version>`（相同版本的重复推送不会再次提醒）。

产品文案为中文。运行时只保留它调用的最小桥接面（`notify?: { title, body }`），外壳会重新校验，因此对象层绝不信任渲染进程的载荷。

## 备选方案

**专门的 notification 服务并配置哪些事件需要通知**——已拒绝。审批需要、更新可用这两个最高价值事件已覆盖当前需求；可配置策略推迟到出现更多通知来源时再做。

**从审批面板组件（ui-conversation）弹出通知**——已拒绝。面板只为当前查看的会话渲染，后台会话的审批永远无法提醒用户；帧处理器能看到每个会话。

## 后果

- 用户在另一个应用中工作时，会在 agent 请求审批以及有新版本可用时收到提醒；崩溃／重启／恢复通知仍由外壳拥有。
- 通知偏好（系统通知开关）现在约束所有渲染进程弹出的通知，而不只是外壳自己的。
- 通道仅限桌面：纯 `dsh web` 运行没有桥接，每个调用点都是受保护的 no-op。
