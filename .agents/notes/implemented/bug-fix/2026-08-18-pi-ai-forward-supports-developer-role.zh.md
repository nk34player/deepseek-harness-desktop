# Agent Note: pi-ai forwards the developer-role compat switch

Status: implemented

[English](2026-08-18-pi-ai-forward-supports-developer-role.md) | 中文

## 问题

`dsh-llm-pi-ai` 的 `compat` profile 接受并转发 `thinkingFormat` 与
`supportsReasoningEffort`，但 `supportsDeveloperRole`——一个有效的 pi-ai
`OpenAICompletionsCompat` 字段，用来表示端点是否接受 OpenAI 的 `developer`
角色（相对通用的 `system`）——被丢弃了。拒绝 `developer`（HTTP 400）的提供方
收到的每个请求都带着 `role: "developer"`，且无从更正；`settings.yaml` 里的
`compat.supportsDeveloperRole: false` 被静默丢弃。

## 决策

把 `supportsDeveloperRole` 加入 compat profile：schema（`config.ts`）、
`PiAiCompatProfile` 类型、`resolveModelCompat` 转发（路由默认、按模型胜出、
以 spread 保留已安装 catalog 的 compat），以及「仅存在于 `openai-completions`」
的模型／路由防护。pi-ai 于是对声明 `false` 的提供方选择 `system`，请求便携带
`role: "system"`。

## 后果

- `compat.supportsDeveloperRole` 可在路由与模型上配置，并沿与推理开关相同的
  模型 → 路由 → catalog → URL 检测链解析。
- 重新生成了 `docs/config-catalog.md`（生成器会把运行时 schema 与声明的配置
  类型交叉核对，因此新增字段得到校验）。

## 验证

`resolveProfiles` 会转发该开关（catalog.spec 新增用例）；llm-pi-ai 类型检查与
catalog／config／adapter 测试套件全绿（104 项）。
