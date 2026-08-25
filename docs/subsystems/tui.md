# Interactive Terminal (TUI)

English | [中文](tui.zh.md)

This page documents the interactive terminal (TUI) surface services contributed by `@deepseek-ai/dsh-tui`: the `tui` overlay/rendering service (`TuiExtensionService`, `ctx.tui`), the `tuiPrompt` live prompt-value registry (`TuiPromptService`, `ctx.tuiPrompt`), and the `tuiResumeHost` process-handoff boundary (`TuiResumeHost`, `ctx.tuiResumeHost`). Each service is identified precisely from the package source; nothing beyond what that source declares is recorded.

Source: [`packages/ui/tui/src/index.ts`](../../packages/ui/tui/src/index.ts)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtui--tuiextensionservice-abstract-seam"></a>

### `ctx.tui` — `TuiExtensionService` (abstract seam)

Optional terminal-local interaction service provided by one mounted TUI.

The concrete provider retains pi-tui, focus, and terminal lifecycle state. Plugins receive only effect-owned overlay sessions.

```ts cordis-catalog
/**
 * Queue an interactive overlay owned by the calling plugin fiber.
 *
 * The TUI displays one overlay at a time in FIFO order. Disposing the caller
 * removes a queued overlay or closes an active one before plugin teardown
 * settles. This live presentation is neither logged nor replayed.
 *
 * @param request - component factory, layout constraints, and cancellation.
 * @returns the effect-owned overlay session.
 * @throws when the TUI has begun shutting down.
 */
abstract openOverlay(request: TuiOverlayRequest): TuiOverlaySession
```

Source: [`packages/ui/tui/src/index.ts:245`](../../packages/ui/tui/src/index.ts)

<a id="ctxtuiprompt--tuipromptservice"></a>

### `ctx.tuiPrompt` — `TuiPromptService`

Context-global mutable values interpolated by TUI theme prompt templates. A registration, mutation, or disposal schedules one coalesced notification to the renderer subscribed with TuiPromptService.subscribe, so a value that changes on its own schedule (not only in response to a UI event) still redraws. Notification is a direct in-service callback, not a Cordis event.

```ts cordis-catalog
/**
 * Register one globally unique template value under the calling Cordis effect.
 * @param name - Lowercase slash-separated template name.
 * @param initialValue - Initial trusted ANSI-capable fragment.
 * @returns A mutable handle whose disposal unregisters the name.
 */
register(name: string, initialValue?: string): TuiPromptValueHandle

/**
 * Read a registered fragment without evaluating plugin code.
 * @param name - Exact registered template name.
 * @returns The current fragment, or `undefined` when unknown or unavailable.
 */
get(name: string): string | undefined

/**
 * Observe registration and value changes. The listener runs after a coalesced
 * microtask following any burst of mutations; the renderer re-reads current
 * values on that callback. The subscription is owned by the calling Cordis
 * effect, so it is removed when the subscriber's fiber disposes; the returned
 * disposer removes it early. Listener failures are contained — a synchronous
 * throw or a rejected returned promise cannot starve the other observers.
 * @param listener - Invoked once per coalesced change burst. Delivery does
 *   not wait on a returned promise; its rejection is only observed and logged,
 *   never left unhandled, so an async listener cannot order later observers.
 * @returns A disposer that removes the subscription.
 */
subscribe(listener: () => unknown): TuiPromptUnsubscribe
```

Source: [`packages/ui/tui/src/prompt.ts:104`](../../packages/ui/tui/src/prompt.ts)

<a id="ctxtuiresumehost--tuiresumehost"></a>

### `ctx.tuiResumeHost` — `TuiResumeHost`

Process-lifecycle owner used by the shipped CLI for an atomic resume handoff.

```ts cordis-catalog
/**
 * Dispose the current app and replace it with a runtime for `sessionId` in
 * `cwd`. Success does not return. A host may reject before it commits
 * teardown; after commit it owns fatal reporting and process exit.
 * @param sessionId - validated persisted session selected by the user.
 * @param cwd - the selected session's own workspace, which the replacement
 *   process must run in: process cwd, not the restored session header, is what
 *   filesystem and shell tools resolve against. It may differ from the current
 *   workspace, so a host that cannot enter it must reject before committing
 *   teardown.
 * @returns a promise that never settles on success: the host owns process
 *   teardown and exit once it commits the handoff.
 */
handoff(sessionId: SessionId, cwd: string): Promise<never>
```

Types: [SessionId](core.md)

Source: [`packages/ui/tui/src/runtime.ts:13`](../../packages/ui/tui/src/runtime.ts)
<!-- END GENERATED cordis-surface -->
