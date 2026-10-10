# @deepseek-ai/dsh-llm-opencode-go

[English](README.md) | 中文

DeepSeek Harness LLM 接缝的 OpenCode Go（OpenCode Zen Go 订阅）chat-completions 适配器：在 `ctx.llm` 上注册 `opencode-go` provider 路由，指向 `https://opencode.ai/zen/go/v1` 的 OpenAI 兼容表面。会话可以在与 DeepSeek 及其他已注册 provider 相同的选择器里把默认模型切换到 `opencode-go/*` 模型。

## 组合方式

插件注册一个 provider 路由（`opencode-go`，显示名 "OpenCode Go"）和一个可配置 provider 条目，因此 Web 的 Models 页面可以写入 API key 和每 provider 设置。连接事实按请求解析：`llm-opencode-go:` 用户设置段（`$DSH_HOME/settings.yaml`）覆盖在 `cordis.yml` 条目配置之上，API key 通过凭据接缝从 `OPENCODE_GO_API_KEY` 引用解析（默认；`apiKeyEnv` 可改名）。编辑 base URL、目录或 key 后无需重启即到达下一次请求；端点还会从可信环境层回退到 `$OPENCODE_GO_BASE_URL`。

适配器的请求始终直连，且走 HTTP/2 优先的传输：got 自动协商 HTTP/2 并在不可用时回退 HTTP/1.1（与 OpenCode 客户端相同的传输形态），且从不读取环境代理，因此 OpenCode Go 流量始终从机器的真实来源离开。端点的区域门控——中国托管的 deepseek opt-in——以请求来源判定，代理出口的境外 IP 会静默翻转该状态，所以本路由刻意豁免宿主配置的任何代理。其他 provider 与 harness 自身的 web 工具保持各自的环境传输。

适配器仅文本（图片块返回 `UNSUPPORTED_CONTENT`），且不声明推理档阶梯：OpenAI 兼容表面没有文档化的稳定 effort 词汇，因此显式 `reasoningEffort` 会以 `UNSUPPORTED_REASONING_EFFORT` 响亮失败，而不是被静默丢弃。咨询模型目录默认是 OpenCode Go 支持的完整模型清单（73 条——DeepSeek V4.1 Flash、Claude、Gemini、GPT、Grok、Kimi、GLM、Qwen、MiniMax，以及 `-free` 社区通道，见本 README 的"目录"一节），可通过 `models` 覆盖。

## 模型体验

### 请求路由

#### 模型看到什么

除普通请求外别无其他：适配器把 harness 会话序列化为 OpenAI chat-completions 消息，并把响应以文本、推理和工具调用块流式返回。`opencode-go` provider 与模型来自会话记录的路径。

#### Token 影响

零直接 token；请求即会话本身。端点报告的用量映射为 harness token 计数（减去缓存读取）。

#### KV Cache 影响

按会话由 provider 键控：OpenCode Go 要求每个请求都携带 `x-opencode-session` 头，并在其携带的稳定 id 下复用提示缓存状态，因此适配器发送会话的 session id（手工构建的请求没有时会发送一个新 UUID），同一会话的重复请求可受益于 provider 的缓存。`llm-opencode-go:` 设置编辑只在改变端点或模型时改变请求前缀。

## 目录

默认咨询目录是 OpenCode Go 订阅所服务的完整模型清单：73 条，覆盖 DeepSeek（V4.1 Flash、V4 Flash、V4 Flash Vision Exp、V4 Pro）、Anthropic Claude（Fable、Haiku、Opus、Sonnet）、Google Gemini、OpenAI GPT、xAI Grok、Kimi、GLM、Qwen、MiniMax、MiMo、Muse Spark、Jev、Ling、Nemotron——包括 `-free` 社区通道。每一项都使用相同的 1,000,000 token `defaultContextWindow`；逐模型的容量与输出上限不在交付清单内。各模型的参考价格（每百万 token 的 输入/输出/缓存读/缓存写，美元）由订阅方公开的价格表承载，不在此目录中——harness 计 token，不计货币。

## 已知限制与待办

- **仅 OpenAI 表面** — OpenCode Go 的 Anthropic 原生 `/messages` 模型不路由；适配器服务承载编码阵容的 chat-completions 表面。
- **始终直连** — 请求绕过宿主配置的任何代理；只能通过代理到达 opencode.ai 的部署无法按现状使用本适配器。
- **无推理阶梯** — `reasoningEffort` 请求响亮失败，而不是映射到未文档化的 wire 词汇。
- **仅文本** — 拒绝图片内容；表面上的多模态模型不提供服务。
- **共享适配器管线** — fetch/SSE 传输与 provider 注册形态与 `dsh-llm-deepseek` 同构；抽取共享的 OpenAI 兼容适配器层留待后续。
