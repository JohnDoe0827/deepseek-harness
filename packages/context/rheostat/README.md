# @deepseek-ai/dsh-rheostat

English | [中文](README.zh.md)

The style dial (滑动变阻器): one per-session position in [0, 1] that slides the model's response style between 0 mode (terse, quiet) and 1 mode (expressive, lively).

## What it does

The dial is a number in [0, 1], defaulting to the neutral middle 0.5. Every request assembly renders a `rheostat:style` prompt section describing the current position and the style instruction for its mode band:

- positions ≤ 0.25 — 0 mode · 极简静默: answers are terse, conclusion-first, no filler.
- positions ≥ 0.75 — 1 mode · 饱满热烈: answers are full, detailed, expressive.
- in between — 0 与 1 之间 · 均衡: a blend, leaning terse near 0 and expressive near 1.

The position is logged as a `rheostat/position` session event (whole-value replace, last write wins), so resume and fork restore it without a live mirror. Anyone can slide it:

- the model calls `rheostat_set(position)` and reads `rheostat_get()` (the prompt section already states the position, so the get tool exists for programmatic consumers);
- the user runs the `/rheostat [<0..1>]` command (bare `/rheostat` reads the position).

## The sliding boundary

A model slide appends the `rheostat/position` event directly during tool execution. A user's `/rheostat` selection made between turns also appends immediately and injects a short notice; a selection made during an open turn stays pending until the next accepted in-turn pre-step, which commits it durably and narrates the change into that request — the same boundary plan-mode uses, because `Session.append` from an arbitrary command handler during an open turn is not a supported publication point. The pending selection is visible to the very next prompt assembly (the section reads it before the durable commit), so the style switch is not delayed by the boundary.

## Configuration

None. The default position (0.5) and the style text are product definitions, not deployment choices.

## The prompt section

`rheostat:style` registers at order 40 — after the deployment persona (0) and before plan-mode guidance (50), so plan-mode rules can still override the dial when a plan is under review. The section is empty when an assembly has no agent.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Prompt section

#### What the model sees

One section in every request that carries an agent, rendered from the folded (or pending) position. The verbatim band bodies live in [src/index.ts](src/index.ts) (`styleText`): the terse 0 band, the balanced middle band, and the expressive 1 band each replace the `{position}` and `{mode label}` placeholders in the template below and append their own guidance sentence.

##### Verbatim template

```markdown
滑动变阻器（style dial）位于 {position}，处于 {mode label}。
{band guidance}
用户可以用 /rheostat <0..1> 滑动它，你也可以调用 rheostat_set 工具。
```

##### Rendered example at position 0.00

```markdown
滑动变阻器（style dial）位于 0.00，处于 0 模式 · 极简静默。 调整回答风格：只给结论，不给铺垫；能用一句话绝不用两句；删掉寒暄、修饰与重复；列表尽量短。 像 0 一样安静、克制、留白。用户可以用 /rheostat <0..1> 滑动它，你也可以调用 rheostat_set 工具。
```

##### Rendered example at position 1.00

```markdown
滑动变阻器（style dial）位于 1.00，处于 1 模式 · 饱满热烈。 调整回答风格：尽情展开；主动补充背景、细节和例子；表达有温度、有存在感；可以热情、夸张、有节奏；把每个想法点亮，绝不缺席。 像 1 一样明亮、响亮、内容丰富。用户可以用 /rheostat <0..1> 滑动它，你也可以调用 rheostat_set 工具。
```

#### Token effect

Fixed small cost on every request where an agent is present (one section of ~120 characters); the position value changes the interpolated number, not the structure.

#### KV Cache effect

Prefix-stable while the section registration and position are unchanged. A slide appends a new `rheostat/position` event, which changes the section's interpolated text and invalidates reuse from the point the new position first renders. Between slides the section is byte-identical across requests and does not invalidate reuse.

### Tool schema

#### What the model sees

The generated [`rheostat_set` and `rheostat_get` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-rheostat).

#### Token effect

Fixed schema cost on every request where the tools are visible.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from these schemas.

### Tool-call history and result

#### What the model sees

`rheostat_set` returns exactly `{ position, mode }` with `mode` one of `terse` / `balanced` / `expressive`, rendered as `Style dial slid to <position> — <mode label>.`; `rheostat_get` returns the same value rendered as `Style dial at <position> — <mode label>.` Stable failures are `Error: rheostat_set requires an owning agent session`, `Error: rheostat_get requires an owning agent session`, and `Error: rheostat position must be between 0 and 1, got <n>` (or `Error: rheostat position must be a finite number, got <value>`). A `/rheostat` slide also appends a `user/message` notice (`The user slid the style dial (滑动变阻器) to <position> (<mode label>).`), which the next request sees as plugin-sourced context.

#### Token effect

Growth is fixed-shape per call and independent of dial history; the `rheostat/position` event itself is UI/replay state, not a second model message.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Per-session scope only** — the dial belongs to the one agent session that set it; there is no shared/global dial across sessions, and a non-agent caller is rejected.
- **Style is guidance, not enforcement** — the section instructs the model's style; the model may still deviate, and there is no post-processing to force terse or verbose output.
- **Discrete mode bands, continuous position** — the mode label switches at 0.25/0.75 while the position stays continuous; a finer-grained interpolation of the guidance itself is deferred.
