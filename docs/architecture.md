# Architecture and runtime boundaries

## Purpose

`dsh-synapse` is a presentation and organization layer for DeepSeek Harness conversations. It turns existing DSH sessions, turns, and forks into a visual map without replacing the systems that own those conversations.

## Profile integration

The package contributes `cordis.patch.yml`, which inserts the `dsh-synapse` service into whichever DSH profile lists the package as a bundle — `desktop` for the desktop app, `web` for the `dsh web` command. It reuses the existing DSH Web server and client runtime.

The plugin:

- does not start a second HTTP server;
- does not create a second model or agent runtime;
- does not replace DSH authentication or permission checks;
- stays inert in a profile that does not list it, so installing it into the wrong profile only means the map never appears (see the installation table in the user guide).

## Conversation ownership

DSH session logs remain the source of truth for conversation content and lifecycle. Native DSH operations own:

- creating and opening sessions;
- sending follow-up messages;
- forking sessions;
- archiving sessions;
- model and tool execution;
- permission and approval decisions.

Synapse projects committed DSH events into cards and sends user actions back through the native DSH session bridge.

## Harness compatibility

This revision is built and verified against DeepSeek Harness `0.1.7-rc.2`. Both halves call Harness APIs directly, so a Harness release that changes them requires a matching plugin release.

Host half (`index.js`) calls:

- `ctx.webServer.register({ kind, path, handler })`, the route registry of `@deepseek-ai/dsh-host-webserver`;
- `ctx.sessions.list()`, the live `Session` objects of `@deepseek-ai/dsh-session`;
- the untagged (global) `session/created` and `session/event` listeners;
- `session.snapshotEvents()` for a projection replay, `session.inheritedEventCount` for the durable fork cut, and `session.header.cwd` for workspace grouping.

Client half (`client.js`), through `dsh.client.inject` in `package.json`:

- `sessions.list`, `sessions.binding`, `sessions.create`, `sessions.fork` from `@deepseek-ai/dsh-api-session-controller`, plus `sessions.retain`/`release` for two purposes: owning a reference across a prompt round-trip, and owning one for every *running* Session whose live reply the map mirrors, because no Harness release mints a Session scope implicitly any more and an unowned Session has no readable Chat view;
- `workspaces.list` from `@deepseek-ai/dsh-api-workspace-controller`;
- `uiWorkspace.openSession` from `@deepseek-ai/dsh-client-ui-workspace` for selecting a Session;
- `uiConversation.binding(sessionId).target('chat')` from `@deepseek-ai/dsh-client-ui-conversation` for the streaming reply and the turn anchor index, because the Client builds a view snapshot only after something subscribes to its target. A Session the browser does not observe still reports its `running` flag, which the list row carries.

Two Harness dependencies are worth re-checking on every upgrade:

- `snapshotEvents()` is marked deprecated: Harness is moving complete session logs out of memory. Rebuilding this canvas from history needs the full sequence, so the call remains, and it needs a storage-backed successor (an asynchronous paged read) before Harness removes it.
- The browser half must acquire its own `SessionReference` before sending a prompt; borrowing an Agent scope no longer opens one.

## Canvas metadata

By default, Synapse stores canvas metadata at:

```text
$DSH_HOME/synapse/workspaces.json
```

The file contains organizational state such as workspace mapping, card layout, and fork anchors. It does not replace session logs.

Consequences:

- deleting the file resets canvas organization but does not delete conversations;
- uninstalling the plugin keeps the file, so reinstalling restores the canvas;
- older schema versions migrate when loaded;
- two processes sharing the same file can still produce last-writer-wins replacement despite locking and external-change warnings.

Run one `dsh web` instance for each shared profile.

## Projection model

With `autoProjection` enabled, committed DSH session events are grouped by working directory and projected into the corresponding Synapse workspace.

Each user question becomes a conversation card. The following assistant messages are folded into that turn, and the final assistant reply is shown as the answer. Forked sessions connect to the parent turn at the durable DSH seed boundary rather than at an arbitrary canvas coordinate.

Only a turn a person typed becomes a card. The harness also writes its own `user/message` rows — the runtime-context snapshot, the skill catalogue `<system-reminder>` — and those carry a structured `data.source.kind`; injected kinds (`skill-catalog`, plus the runtime snapshot's text marker) are not projected, so they neither occupy a card nor steal the answer from the real question. Existing projections are pruned the same way when the store loads.

Projected messages keep only a preview (280 characters), not the body. The body already lives in the DSH session log, and a workspace file full of copies is what made one workspace reach several megabytes and stall the canvas (issue #42). The canvas asks the Host for the bodies of the cards it actually mounts (`GET /synapse/api/threads/:id/full`), and the detail view asks for a whole thread at once; when a session is archived or gone from DSH the previews stay and the card is marked unavailable instead of rendering blank.

Bodies returned by the detail fetch are capped at 200 000 characters (`MAX_BODY_CHARS`), while the preview stays at 280; a truncated body carries a marker so the card can say the rest lives in DSH.

Projection writes are coalesced during event bursts, and live updates reuse cached Markdown and patch the active card instead of rebuilding the complete canvas. Card coordinates remain visual metadata only and never determine conversation lineage.

Archiving is owned by DSH. The map mirrors `archivedSessionIds` from the Workspace snapshot to stop drawing cards for archived sessions, and its own archive action calls the Workspace `archiveSession` so both sides share one archive set (issue #21 / #19).

## Tool process folding

Live events pair tool calls and results by `callId` and render them inside the related assistant reply instead of as standalone conversation cards.

Legacy v3 migrations did not always have durable call IDs. Those records pair each tool call with the next tool result by order during migration.

## Node insight

The lens adds a read-only derivation layer on top of the projection:

- `GET /synapse/api/threads/:id/insights` groups one session log by user turn and returns `intent`, `risk`, `files`, and `stats` for each turn, keyed by the user message's `seq`.
- Live sessions are read through `session.snapshotEvents()`; closed sessions go through `SessionLogReader`. When neither is available (an archived session whose log is gone), the Host falls back to the stored message previews, which carry tool names but not arguments.
- `insight.js` is a pure rule engine: intent from the user's wording, risk from tool classes and command text, files from `write` / `edit` / `apply_patch` arguments plus recognisable shell redirects. It never calls a model, never writes to DSH, and returns the same result for the same log.
- The client keeps the open panel, the section, and one response per thread in browser memory only. Opening a panel forces one refresh so the newest committed turn is visible; nothing about the insight is persisted in `workspaces.json`.

The panel therefore has no model, permission, or session-lifecycle effect. Its risk score is a heuristic hint and the UI labels it as such.

## Single-session retrospective

`GET /synapse/api/threads/:id/retrospective` scopes the review to the tree rooted at the thread's root (the thread plus every fork below it) and reuses the same per-thread insight payload:

- `retrospective.js` flattens the tree into turn cards, links each fork's first card to the parent turn that existed at `sourceSeedLength`, follows the active branch to its latest card, and scores every step against the inferred goal.
- Each card is stamped with its causal depth (`layer`); the default canvas lays one depth per column, and the client adds L badges, column labels and per-layer contribution.
- The rule pass is deterministic: file changes, read-only exploration, final convergence and goal setting are positive; failed turns, critical/high risk and a correction on the next turn are negative. Positive scores are normalized to exactly 100%, negative scores are measured against total meaningful movement, and `effectivePercent = 100 − delay`.
- `llm-review.js` optionally calls the DSH default model through `ctx.llm.prepareCall(...)`: it condenses the goal, reviews each step, and writes the prompt-coaching section. The final score is `45% rule + 55% model`; the model call has a 25 s deadline and failure falls back to rules. Results are cached per thread/message-count for 30 s.
- Cards are numbered chronologically inside the root tree; the number is rendered on the canvas and reused in the review narrative and prompt coaching. Numbers are derived, so deletions leave stable gaps rather than renumbering later cards.
- The client keeps the drawer, card tint and open state in memory only; nothing is persisted.
- Ignoring a card writes `workspace.deletedCards` (`rootCardId`, `threadId`, `cardIds`, card summaries, `mode: 'soft' | 'hide' | 'cut'`, `reason`, `at`). The canvas hides the subtree and the retrospective filters it with a capped delay penalty.
- `mode: 'soft'` additionally registers `synapse:retracted-cards` through `ctx.inject(['systemPrompt'])`; its text callback looks up the requesting DSH session (and its Synapse ancestor chain) and appends a sourced context snapshot after retained history. That tells the main model to ignore the marked cards on the next request without editing the session log or the cached prompt prefix.
- `mode: 'cut'` is created only after the client forks at the parent answer's `sourceSeq`; the new branch does not contain the cut card or its later turns. The old branch remains in DSH and is hidden from the active canvas.
- Legacy entries normalize to `mode: 'hide'` so they never suddenly alter model context. Restore removes soft/hide records; cut records are retained because the fork cannot be undone.

## Browser-local state

Some interaction state, such as dragged card positions and branch anchors, may be cached in browser local storage to keep the canvas responsive. Durable workspace metadata is still written through the Synapse service.

Private-browsing restrictions or local-storage failures must not prevent DSH conversations from operating; they only reduce persistence of visual preferences.

## Host validation

The `/synapse` endpoint always accepts `localhost` and `127.0.0.1`. Additional LAN or proxy authorities must be listed in `trustedHosts` as a host or `host:port` value.

This validation is part of the Web surface and does not replace broader network access controls.

## Model and KV-cache impact

The insight layer reads session events only after DSH commits them. The retrospective's optional model pass is an **auxiliary model call** issued through the Host LLM service with its own system prompt; it is not part of the chat session and does not modify:

- the conversation's system prompts or user request content;
- tool schemas or registries;
- provider routing;
- approval context.

It can consume provider tokens when a review is opened and is controlled by `llmReview` / `llm` config. Because it never rewrites the chat request, it does not invalidate an otherwise reusable chat KV-cache prefix.

## Operational limitations

- The bundled patch applies to any profile that lists the package as a bundle (`desktop`, `web`); a profile that does not list it stays untouched.
- Canvas metadata and session content have different owners and backup requirements.
- A single shared metadata file is not a multi-writer database.
- Browser state can be cleared independently from DSH Home data.
- Historical migrations may have less precise tool-call pairing than live projection.

## Related documentation

- [Chinese user guide](zh-CN/README.md)
- [English user guide](en/README.md)
- [Development and release guide](development.md)
- [Project overview](../README.md)
