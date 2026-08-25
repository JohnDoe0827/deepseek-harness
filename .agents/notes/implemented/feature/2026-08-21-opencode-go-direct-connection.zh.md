# Agent Note: OpenCode Go 请求始终直连

Status: implemented

[English](2026-08-21-opencode-go-direct-connection.md) | 中文

## 问题

OpenCode Zen Go 的区域门控以请求来源判定：最新版 deepseek-v4-flash 构建托管在中国，需要工作区开启"部署在中国的模型" opt-in，而服务在流量看起来来自境外时会静默把它关掉。在带环境代理的宿主机上——国内常见配置是通过 Clash 类代理把流量路由到境外出口——被代理的 OpenCode Go 请求会让端点把工作区判为境外，导致 deepseek 模型间歇性 403 `RegionError`，而国内直连的 `deepseek-official` 路由不受影响。Node 的 `fetch` 默认忽略环境代理，但那只是默认的巧合：`--use-env-proxy` 或宿主安装的全局 dispatcher 都会在无任何信号的情况下静默重新路由请求。此外，从国内网络到该端点，HTTP/2 明显比 HTTP/1.1 稳定（HTTP/1.1 上出现长静默卡顿与连接重置，HTTP/2 上未观察到），而用户报告在相同端点与模型上稳定可靠的 OpenCode 客户端正是 HTTP/2 优先的传输。

## 决策

**OpenCode Go 适配器通过直连的 HTTP/2 优先 got 传输发送每个请求。** `got` 协商 HTTP/2 并在不可用时自动回退 HTTP/1.1——与 OpenCode 客户端相同的传输形态——且从不读取环境代理，因此发往 OpenCode Go 端点的每个请求都从机器的真实来源离开，与宿主代理接线无关。got 的环境重试、重定向与状态抛错被显式关闭：重试由 harness 重试策略负责，状态码由适配器稳定的错误映射处理。范围恰是 opencode-go 路由：`deepseek-official`、pi-ai provider 与 harness 自身的 web 工具保持各自的环境传输。`got` 成为 `dsh-llm-opencode-go` 的直接依赖（其 HTTP/2 支持由 http2-wrapper 承载）；原先的 undici fetch 传输被移除。

## 备选方案

**可配置的绕过开关。** 否决：直连本就是该路由的全部意义。端点的区域门控使代理出口成为正确性隐患而非偏好，加开关等于允许配置重新引入故障。

**保留 undici fetch 传输并显式传入直连 dispatcher。** 否决：undici fetch 只有 HTTP/1.1，而这正是本路由上脆弱的协议形态，且保证直连需要 dispatcher 覆盖机制。got 用一个受维护的传输同时交付直连与 HTTP/2。

## 后果

OpenCode Go 请求绝不经过代理且优先协商 HTTP/2，端点始终看到机器的真实来源，deepseek 模型的中国托管 opt-in 状态保持稳定，连接形态与用户验证稳定的 OpenCode 客户端一致。只能通过代理到达 opencode.ai 的部署无法按现状使用本适配器（记录于 Known Limitations）。测试钉住传输契约：got spy 断言 `http2: true` 且重试、重定向、状态抛错均关闭；行为测试设置不可用的代理环境变量，证明请求仍直达端点。细化 [OpenCode Go provider 适配器](2026-08-14-opencode-go-provider.md) 的传输行为。
