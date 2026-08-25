# @deepseek-ai/dsh-codewhale

[English](README.md) | 中文

DeepSeek Harness 的 CodeWhale profile bundle：把[宪法](../../codewhale/constitution/README.md)、[回合快照](../../codewhale/snapshot/README.md)和[舰队评审](../../codewhale/fleet/README.md)三个插件作为 `dsh-base` 之上的一层补丁。

## 运行

创建并启动 `codewhale` profile（`dsh plugin` 路径会初始化 profile，并把声明 bundle 的包合并进 bundle 层列表）：

```sh
dsh plugin --profile codewhale add @deepseek-ai/dsh-web-app @deepseek-ai/dsh-codewhale
dsh --profile codewhale
```

该 profile 启动带三个插件的 Web UI。名为 `codewhale.constitution.yml` 的工作区宪法文件（见宪法 README）在下一次写决策或请求组装时生效；快照存放在 `$DSH_HOME/codewhale/snapshots`；舰队带一个默认的 `reviewer` 角色，走会话默认 provider/model，可通过 profile 或用户 `cordis.patch.yml` 按角色覆盖。

## 组合方式

bundle 补丁插入三行：

| 行 | 插件 | 部署默认值 |
|---|---|---|
| `codewhale-constitution` | `@deepseek-ai/dsh-codewhale-constitution` | `file: codewhale.constitution.yml` |
| `codewhale-snapshot` | `@deepseek-ai/dsh-codewhale-snapshot` | 存储于 `dshHomePath('codewhale', 'snapshots')`，排除 `.git`/`node_modules`/`dist`/`build`/`.dsh` |
| `codewhale-fleet` | `@deepseek-ai/dsh-codewhale-fleet` | 一个走会话默认路由的 `reviewer` 角色，`maxRounds: 2` |

更晚的 bundle 层和用户的 `cordis.patch.yml` 按 id 覆盖这些行；补丁替换整行 `config`。

## 模型体验

间接，通过插入的行：每行的包拥有自己的提示分段、注入提示和评审调用。bundle 本身不贡献模型可见文本。

#### KV Cache 影响

无直接作用；每个插入行的包拥有各自的效果。

## 已知限制与待办

- **TUI 仍是社区插件** — 该 profile 以 Web UI 优先；终端用户在此 bundle 旁挂载 TUI 插件（例如 `dsh-tianshu-tui`）。
- **补丁替换整行配置** — profile 覆盖必须重述行保留的每个字段；没有深合并层。
