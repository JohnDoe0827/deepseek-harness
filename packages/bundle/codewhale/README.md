# @deepseek-ai/dsh-codewhale

English | [中文](README.zh.md)

The CodeWhale profile bundle for DeepSeek Harness: the [constitution](../../codewhale/constitution/README.md), [turn snapshots](../../codewhale/snapshot/README.md), and [fleet review](../../codewhale/fleet/README.md) plugins as one patch layer over `dsh-base`.

## Run

Create and boot a `codewhale` profile (the `dsh plugin` path initializes the profile and reconciles bundle-declaring packages into the bundle layer list):

```sh
dsh plugin --profile codewhale add @deepseek-ai/dsh-web-app @deepseek-ai/dsh-codewhale
dsh --profile codewhale
```

The profile boots the Web UI with the three plugins active. A workspace constitution file named `codewhale.constitution.yml` (see the constitution README) takes effect on the next write decision or request assembly; snapshots land under `$DSH_HOME/codewhale/snapshots`; the fleet ships one default `reviewer` role routed through the session's default provider/model, overridable per role through a profile or user `cordis.patch.yml`.

## Composition

The bundle patch inserts three rows:

| Row | Plugin | Deployment defaults |
|---|---|---|
| `codewhale-constitution` | `@deepseek-ai/dsh-codewhale-constitution` | `file: codewhale.constitution.yml` |
| `codewhale-snapshot` | `@deepseek-ai/dsh-codewhale-snapshot` | store under `dshHomePath('codewhale', 'snapshots')`, excludes `.git`/`node_modules`/`dist`/`build`/`.dsh` |
| `codewhale-fleet` | `@deepseek-ai/dsh-codewhale-fleet` | one `reviewer` role on the session default route, `maxRounds: 2` |

Later bundle layers and the user's `cordis.patch.yml` override these rows by id; a patch replaces a row's whole `config`.

## Model Experience

Indirectly, through the inserted rows: each row's package owns its prompt sections, injected notices, and review calls. The bundle itself contributes no model-visible text.

#### KV Cache effect

None directly; each inserted row's package owns its effect.

## Known Limitations and Deferred Work

- **TUI remains a community plugin** — the profile is Web-UI-first; terminal users mount a TUI plugin (for example `dsh-tianshu-tui`) beside this bundle.
- **A patch replaces whole row configs** — profile overrides must restate every field a row keeps; there is no deep-merge layer.
