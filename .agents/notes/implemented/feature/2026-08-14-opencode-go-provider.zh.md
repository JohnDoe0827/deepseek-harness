# Agent Note: OpenCode Go provider 适配器

Status: implemented

[English](2026-08-14-opencode-go-provider.md) | 中文

## 问题

OpenCode Go（OpenCode Zen Go 订阅）在 `https://opencode.ai/zen/go/v1` 的 OpenAI 兼容 chat-completions 表面上服务其编码阵容——DeepSeek、Kimi、Qwen、GLM 模型，用 `OPENCODE_GO_API_KEY` 风格的 bearer token 认证。想把 API 切换到该订阅的 harness 用户没有原生 provider：自定义 provider 路径（llm-pi-ai）需要手工构建 profile，内置 DeepSeek 适配器也不能以不同的凭据契约指向其他厂商端点。

## 决策

**与 `llm-deepseek` 对称的专用 `llm-opencode-go` 适配器包。** `dsh-llm-opencode-go` 在 `ctx.llm` 上注册 `opencode-go` provider 路由和一个可配置 provider 条目（显示名 "OpenCode Go"），连接事实按请求解析（`llm-opencode-go:` 设置段覆盖条目配置；key 从 `OPENCODE_GO_API_KEY` 凭据引用解析），并像 DeepSeek 适配器一样作为 base bundle 行挂载，因此 Web 的 Models 页面会列出它，把会话默认模型切换到 `opencode-go/*` 模型即可路由请求。

**适配器只服务 OpenAI 兼容表面，且仅文本。** wire 映射是 OpenAI chat-completions 协议（system/user/assistant/tool 消息、带 `include_usage` 的流式、标准 delta 词汇含 `reasoning_content`）。适配器不声明推理档阶梯并拒绝图片块：该表面既没有文档化的稳定 effort 词汇也没有多模态输入，因此显式 `reasoningEffort` 以 `UNSUPPORTED_REASONING_EFFORT` 失败、图片内容以 `UNSUPPORTED_CONTENT` 失败，而不是被静默丢弃。

**咨询目录默认是 Go 订阅的编码阵容**（`deepseek-v4-flash`、`deepseek-v4-pro`、`kimi-k3`、`qwen3.6-plus`），可通过 `models` 覆盖；请求保持不受限制。

## 曾考虑的替代方案

**llm-pi-ai provider profile 预设。** 不采用：pi-ai 的 provider-profile 机制是社区多 provider 路径；一等适配器让 provider 以与每个内置 provider 相同的设置/凭据分层进入已安装目录。pi-ai 的 SDK 其实已经内置 `opencode-go`，因此原生适配器与其可配置提供方目录条目冲突：pi-ai 的 catalog 现在让出该路由（`catalogProviderIds()` 过滤它，两个 README 都记录了），而手工为其编写 pi-ai profile 仍可解析，目录冲突时会保留原生条目继续服务。

**用不同 base URL 复用 DeepSeek 适配器。** 不采用：凭据契约（env 引用）、目录和错误词汇都不同，且 DeepSeek 适配器会发送任何其他端点都不该收到的 DeepSeek 特有头和 thinking 字段。

**先抽取共享的 OpenAI 兼容适配器层。** 延后：fetch/SSE 传输与 provider 注册形态与 `dsh-llm-deepseek` 同构（克隆以该理由标记 `jscpd:ignore`），抽取共享层会改动核心 llm 包并在同一变更中迁移 DeepSeek 适配器。

## 后果

harness 用户可以在 Models 页面添加 OpenCode Go API key：页面 provider 编辑器带有一个精选的 `opencode-go` 布局（key 输入框、base URL 和咨询模型目录——与 DeepSeek 相同的直连 family 形态），因此卡片渲染出可编辑字段，而不是只有"其余字段在 settings.yaml 中"的提示，且其保存按钮可用。用户按会话保留或切换到 `opencode-go` 模型，并通过 `$DSH_HOME/settings.yaml` 轮换 key 或端点，变更到达下一次请求。适配器与 DeepSeek 适配器一起挂载在 base bundle 中，因此每个 profile 都列出两个 provider。wire 形状与错误映射测试覆盖传输；loader-composition 测试通过真实 Loader 端到端证明设置编辑的端点切换；UI 测试覆盖精选的 `opencode-go` 布局。核心 llm 契约零改动。适配器的传输行为（始终直连、绕过代理）由 [OpenCode Go 直连](2026-08-21-opencode-go-direct-connection.md) note 细化。
