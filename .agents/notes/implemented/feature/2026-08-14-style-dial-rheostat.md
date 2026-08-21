# Agent Note: the style dial (滑动变阻器) plugin

Status: implemented

English | [中文](2026-08-14-style-dial-rheostat.zh.md)

## Problem

A user wanted a playful, persistent "mode" control in the harness: a dial that slides continuously between 0 (terse, quiet answers) and 1 (expressive, lively answers), switching the model's response style per session. Nothing in the shipped tree covered continuous user- or model-adjustable response style: plan mode is a boolean collaboration state, personas are static deployment config, and time-context injects facts rather than style.

## Decision

**A new `dsh-rheostat` package (`packages/context/rheostat`) mounting a per-session style dial in the base bundle.** The dial is one number in [0, 1], defaulting to 0.5. It is:

- **Durable session state** — logged as a `rheostat/position` session event (log-only, non-surface, whole-value replace, last write wins), so resume and fork restore it and the session log stays the single source of truth; the invariant companion rejects incoherent positions in the log.
- **Model-visible** — a `rheostat:style` prompt section (order 40, after the persona at 0 and before plan-mode guidance at 50) renders the folded position and the style instruction for its band (≤ 0.25 terse 0 mode, ≥ 0.75 expressive 1 mode, in between a blend) in the conversation's language — `detectLanguage` classifies the most recent user message as Chinese or English, defaulting to Chinese before any user message exists. Plan-mode rules still override the dial when a plan is under review because they render later.
- **Controlled by the model** — `rheostat_set(position)` slides the dial (rejecting out-of-range positions loud), `rheostat_get()` reads it for programmatic consumers; both require an owning agent session.
- **Controlled by the user** — the `/rheostat [<0..1>]` command slides it (bare `/rheostat` reads it).

**A user's in-turn selection rides the plan-mode pending boundary.** A command selection made during an open turn stays pending until the next accepted in-turn pre-step, which commits it durably and narrates the change into that request; the pending value is already visible to the next prompt assembly, so the style switch is not delayed. A model's `rheostat_set` appends directly during tool execution, like `todo_write`. The boundary exists because `Session.append` from an arbitrary command handler during an open turn is not a supported publication point — the same reasoning as the [plan-mode collaboration-state note](../simplification/2026-07-22-plan-specific-collaboration-state.md).

## Alternatives considered

**A boolean "0 or 1" mode like plan mode.** Rejected: the request was explicitly a slide between 0 and 1, and a continuous position lets the model and user blend styles proportionally instead of flipping.

**Clamping invalid positions instead of rejecting.** Rejected: a model passing `1.5` is a model error; failing loud teaches the correct range and keeps the invariant (log positions are always in [0, 1]) trivially true.

**Configurable default position and style text.** Deferred: the default (0.5) and the band text are product definitions; a deployment can already override the whole section by shadowing `rheostat:style` in a preset.

**A web-UI slider.** Deferred: the dial's controls (command + tools) and the section are the product; a dedicated Chat node renderer for a literal slider is separate client work.

## Consequences

Every profile that stacks the base bundle gains the dial: the section costs a small fixed number of tokens per request and is prefix-stable between slides, and sliding changes the interpolated text (KV-cache reuse invalidates from the first request at the new position). The `rheostat/position` event joined the generated persistence catalog. The catalog scope sentence now covers non-`tool-*` packages that register tools, because `rheostat_set`/`rheostat_get` are catalogued like any other tool. The tool, command, and section are each covered by unit tests; a full-loop mock-model test and a real-Loader composition test prove the assembled behavior.
