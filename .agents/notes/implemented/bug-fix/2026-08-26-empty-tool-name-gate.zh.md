# Agent Note：在注册与提示词组装边界拦截空工具名

Status: implemented

[English](2026-08-26-empty-tool-name-gate.md) | 中文

## 问题

模型请求的 tools 列表可能携带**无名工具**：动态沙箱包经 `harness.defineTool` 注册时没有任何 name 门禁；`tools.register` 校验了 output 形状、超时与保留名 `run_code`，却漏了 name 非空；system-prompt 的 `assemble` 则原样转发每个 provider 的 schema。一个 `name: ''` 条目一旦进入 `header.tools`，模型每一轮都可能去调用它——每次调用都以 `UNKNOWN_TOOL` 快速失败（或触发 provider 侧拒绝与重试），对一个永远无法路由的工具持续消耗 token。用户看到的症状是"插件关闭后仍有工具挂起、消耗 token"，根因其实是注册与组装两个边界从一开始就没有拒绝无名 schema。

## 决策

三处改动：

1. **`tools.register()`** 现在对空名或非字符串名抛 `TypeError`，与既有的 output/schema/timeout 校验风格一致。坏注册在挂载期即快速失败，与其他坏注册一样在启动激活审计中被点名。

2. **`harness.defineTool`**（`cordis-host-runner` 沙箱守卫中的动态包边界）现在要求非空字符串名，报错信息为教学式，与 `harness.handle` 的方法名门禁一致。定义无名工具的动态包运行时会得到可读错误，且不留注册残留（失败的 fiber 会卸载其 effect）。

3. **`SystemPrompt.assemble()`** 在构建工具列表前丢弃无名 schema——这是针对不经 `register` 就到达组装路径的 schema（scope 层、provider 级构造）的纵深防御底。它不改变已知名集合、不阻断请求；坏插件只是失去自己的工具。

## 备选方案

**只拦 `register`。** 否决：已部署的坏插件仍会每轮组装都带着无名条目，且 provider 级构造可以完全绕过 `register`。

**`assemble` 遇到无名 schema 直接抛错。** 否决：这会把"静默烧 token"变成整个部署每一轮请求都失败；丢弃违规 schema 才能保住正常请求。

**收紧 name 字符集（如 `[a-z0-9_-]`）。** 否决：会拒绝合法的第三方命名（带点、带命名空间）；非空字符串是必要的最小约束。

## 结果

无名工具从此无法进入模型请求：挂载一个注册了无名工具的插件会快速失败并在激活审计中指名；任何绕过 `register` 的 schema 都会在组装时被过滤。定义无名工具的动态包在运行时立即得到可读错误，且失败运行不留注册残留。