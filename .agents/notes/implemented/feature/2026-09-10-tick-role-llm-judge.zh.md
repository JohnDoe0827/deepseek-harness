# Agent Note: LLM 判读 tick 角色与观察者静默分类

Status: implemented

[English](2026-09-10-tick-role-llm-judge.md) | 中文

## Problem

舰队 tick 观察者（[2026-08-29-timeline-independent-fleet-observer](2026-08-29-timeline-independent-fleet-observer.md)）只评估确定性预算计数器：回合时长、静默、回合数、重复工具调用。这些规则能发现*卡住*或*循环*相同动作的工作者，但一个工作者可以持续、多样地推进却偏离任务——改错文件、解决另一个问题、或带新参数重跑失败方案。延期的 LLM 判读 tick 角色（每个间隔一次模型调用判读意图）是自然扩展，但无界的按间隔模型开销需要显式选择与独立节奏。

静默预算还有一个与 guard 共享的分类缺口：观察者自己的持久簿记（舰队里的 `fleet/review`、`fleet/run`、`fleet/end`；guard 里的 `observer/notice` 与观察者插件源的 `agent/inbox/spliced` 投递）落入 `default → progress = true` 分支，因此观察者自己的干预刷新了静默时钟。被重复提醒回响的卡住工作者可能看起来永远活着——这正是静默规则要抓的卡死。

## Decision

两个改动一起落地，舰队与 guard：

### 1. LLM 判读 tick 角色（`judge: true`）

`FleetRoleConfig` 增加 `judge?: boolean`；带 `judge: true` 的 tick 角色（且只有 tick 角色——`resolveConfig` 拒绝在 `turn-stopping` 角色上设 `judge: true`）在自己的间隔上对实时活动窗口做一次直接 LLM 调用。`Config` 增加 `judgeIntervalMs`（默认 `tickMs`）与 `judgeTranscriptChars`（默认 `maxTranscriptChars`）。

每个 tick，确定性规则无命中后，每个 `judge: true` 且间隔到期的 tick 角色把任务、近期活动窗口（`judgeWindow`：倒序的 `step/start|step/end|tool/call|assistant/message` 记录，封顶）和角色指令发给角色路由。解析遵循评审契约——无法解析的输出按携带原文的修复请求处理。判定记录为 `kind: 'observer'` 的持久 `fleet/review`（`pass` 只写日志；`fix` 转向其反馈并把运行以 `observer-triggered` 结束）。路由在插件 apply 时解析一次，`judging` 标志丢弃在途间隔，慢模型调用永不排队——跳过的间隔只推迟下一次调用。

### 2. 观察者静默分类（舰队与 guard）

两个 `isProgressEvent` 分类器都把观察者自己的簿记视为非进度：

- 舰队：`fleet/run`、`fleet/review`、`fleet/end`。
- Guard：`observer/notice`。
- 两者：`agent/inbox/spliced` 只在插入的消息为用户源时算进度（只插入插件消息的 splice——观察者自己的 inject/steer——是观察者在说话，不是工作者在工作）。

`todo/write`、`request/header`、`request/context`、`session/end-seed` 与插件源 `user/message` 维持非进度。

## Alternatives considered

**让确定性评估器在规则临近时自己调用 LLM。** 否决：确定性规则是廉价绊线；把模型调用折入其中会在每次接近阈值时花钱并模糊两种成本。判读保持为显式角色标志与独立间隔。

**每个 tick 都判读、无 `judging` 标志。** 否决：慢判读会排队间隔，在卡住的工作者背后堆模型开销。标志丢弃在途重叠；成本以每角色一个在途判读为界。

**只修舰队的静默分类器。** 否决：guard 有同样的缺口（它自己的 `observer/notice` 与插件投递刷新了它的静默时钟）。两个表面共享同一事实流契约，因此一起修。

## Consequences

- 舰队现在能发现*持续推进但偏离任务*的工作者——确定性规则永远不能——代价是 `judgeIntervalMs` 间隔的显式模型开销，由 `judge: true` 选择加入。
- 静默预算度量工作者的进度，而非观察者自己的噪音：在舰队和 guard 中，重复提醒都不再把卡住的工作者维持为"活着"。
- `judge: true` tick 角色的路由在 apply 时解析一次，因此不能跟随运行中途的默认路由变化——turn-stopping 评审角色每次调用解析的路由被收紧为每角色一次。需要判读走不同路由的运行必须重新组合。
- 判读窗口是近期会话日志，不是工作区：文件 diff 与工具结果不包含在内，与评审者相同的仅转录限制。

## Testing

- `packages/codewhale/fleet/tests/tick-observer.spec.ts`（7）：两个判读测试驱动脚本化判读路由——`pass` 记录 `kind: 'observer'` 评审并保持运行活跃；`fix` 转向其反馈并把运行以 `observer-triggered` 结束——加上既有预算规则测试。
- `packages/codewhale/fleet/tests/fleet.spec.ts`（13）：`resolveConfig` 拒绝非 tick 角色上的 `judge: true` 与非正判读预算，并接受带自有路由与预算的判读 tick 角色。
- `packages/codewhale/fleet/tests/loader-composition.spec.ts`（6）：判读 tick 角色通过真实 Loader schema 及其预算挂载。
- `packages/guard/observer/tests/observer.spec.ts`（10）：新测试断言观察者自己的提醒永不刷新静默时钟——1s 回合预算与 3s 静默预算下，尽管 1 级提醒落在窗口中途，静默规则仍在 ~3s 触发。
- Guards：`tsc -b tsconfig.host.json` 覆盖触及包、`oxlint`、包测试套件全部通过。
