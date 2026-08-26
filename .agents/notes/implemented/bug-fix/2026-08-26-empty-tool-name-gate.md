# Agent Note: Gate empty tool names at registration and prompt assembly

Status: implemented

English | [中文](2026-08-26-empty-tool-name-gate.zh.md)

## Problem

A model request's tools list could carry a **nameless tool**: dynamic sandbox packages registered through `harness.defineTool` with no name gate; `tools.register` validated output shape, timeout, and the reserved `run_code` name but not a non-empty name; and the system-prompt `assemble` forwarded every provider schema verbatim. A `name: ''` entry entering `header.tools` invites the model to call it every turn — each call fails fast as `UNKNOWN_TOOL` (or triggers provider-side rejection and retry), burning tokens against a tool that can never route. The user-visible symptom is "tools still hanging and consuming tokens after a plugin is closed", which is really the registration and assembly boundaries never rejecting nameless schemas in the first place.

## Decision

Three changes:

1. **`tools.register()`** now rejects an empty or non-string name with a `TypeError`, consistent with the existing output/schema/timeout checks. The defect fails fast at mount time, named in the boot activation audit like any other bad registration.

2. **`harness.defineTool`** (the dynamic package boundary in `cordis-host-runner`'s sandbox guard) now requires a non-empty string name with a teaching message, mirroring the `harness.handle` method-name gate. A dynamic package defining a nameless tool fails its run with a readable error and leaves no registration behind (the failed fiber unwinds its effects).

3. **`SystemPrompt.assemble()`** drops nameless schemas before the tools list is built — a defense-in-depth floor for schemas that reach an assembly without passing through `register` (scope layers, provider-level construction). It does not change the known-name set or block the request; the bad plugin loses only its own tool.

## Alternatives considered

**Only gate `register`.** Rejected: deployed bad plugins would still carry the nameless entry into every assembly, and provider-level construction can bypass `register` entirely.

**Throw from `assemble` on a nameless schema.** Rejected: it converts silent token burn into a failed request on every turn for the whole deployment; dropping the offending schema keeps working requests working.

**Restrict the name charset (e.g. `[a-z0-9_-]`).** Rejected: it would reject legitimate third-party names (dotted, namespaced); a non-empty string is the minimal necessary constraint.

## Consequences

A nameless tool can no longer reach a model request: mounting a plugin that registers one fails fast and names it in the activation audit, and any schema that bypasses `register` is filtered at assembly. Dynamic packages defining a nameless tool get an immediate readable error at run time, and the failed run leaves no registration residue.