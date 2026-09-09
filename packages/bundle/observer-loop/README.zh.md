# @deepseek-ai/dsh-observer-loop

[English](README.md) | 中文

观察者韧性 profile bundle：将[卫生守护](../../guard/observer/README.md)与[保真交接+自动备份](../../guard/context-handoff/README.md)作为覆盖 `dsh-base` 的一个补丁层。任何挂载该 profile 的工作区，无需逐项目配置即可获得完整的孪生/环状/DNA 韧性循环。

## 运行

创建并启动带此 bundle 的 profile（`dsh plugin` 路径会初始化 profile 并把声明 bundle 的包纳入 bundle 层列表）：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-web-app @deepseek-ai/dsh-observer-loop
dsh --profile web
```

在该 profile 下启动的任意工作区中，每个会话都携带此循环：observer 守护卫生（回合预算、静默、回合上限、重复工具调用）；handoff 在达到路由模型上下文窗口的 0.6 时检测臃肿，并将项目+对话+交接文档自动备份到 `$DSH_HOME/backups`，保留 3 代，每日 scrub（`git bundle verify`，丢弃损坏代）；`tool-evolve` 提供种子+显式迭代+养料+成型节点+回溯/突变的迭代工具。`projectDir` 默认取启动工作区，因此一个部署值即可服务所有项目。

## 构成

bundle 补丁插入三行：

| 行 | 插件 | 部署默认 |
|---|---|---|
| `observer` | `@deepseek-ai/dsh-observer` | `tickMs: 1000`、`maxTurnSeconds: 300`、`maxSilenceSeconds: 120`、`maxTurns: 50`、`maxRepeatedToolCalls: 3` |
| `context-handoff` | `@deepseek-ai/dsh-context-handoff` | `thresholdRatio: 0.6`、`backupDir: dshHomePath('backups')`、`keepCycles: 3`、`scrubMs: 86400000`、排除 `.git`/`node_modules`/`lib`/`dist`/`build` |
| `tool-evolve` | `@deepseek-ai/dsh-tool-evolve` | `subagentProvider: spawn`、`maxIterations: 64`、`nodeMode: workspace` |

后续 bundle 层与用户的 `cordis.patch.yml` 按 id 覆盖这些行；补丁替换整行 `config`。孪生/环状配对（`twinId` / `ringIds`）、逐项目 `backupDir` 与自定义预算正是这类覆盖。

## 模型体验

间接地，经由插入的行：每行所属插件负责自己的注入提醒。bundle 本身不贡献任何模型可见文本。

#### KV Cache 影响

无直接影响；每行所属插件负责自身影响。

## 已知限制与待办

- **默认未孪生**——未提供 `twinId`/`ringIds` 覆盖时，observer 观察它看到的每个会话；部署覆盖提供理发师悖论安全的配对。
- **备份依赖宿主 CLI**——默认执行器调用 `git`/`tar`；受限沙箱或无 CLI 的工作区需注入 `backupRunner`。