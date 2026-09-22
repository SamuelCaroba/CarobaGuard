# OpenCode integration contract

Researched against OpenCode 1.18.25 and exercised end-to-end against 1.18.26 on
2026-09-02. CarobaGuard starts `opencode serve --hostname 127.0.0.1 --port <free>`
with `OPENCODE_SERVER_PASSWORD` set to an ephemeral random secret.

The adapter uses `/global/health`, `/session`, `/session/:id/message`, `/event`,
and the `/question` request/reply endpoints.
The API publishes an OpenAPI 3.1 document at `/doc`; compatibility is checked by
health/version before use. Context can be injected as a no-reply text part before
the user's prompt. Permission requests arrive on SSE and are answered only after
CarobaGuard applies its own scope policy.

OpenCode state may persist in its normal data directory, while CarobaGuard stores
the stable mapping and permission mode in SQLite. Stopping the child therefore
reclaims active memory without discarding session identity.

The lifecycle is `Sleeping -> Starting -> Ready`, with `Error` reserved for
startup failure, unexpected child exit or loss of the internal event stream.
Health probes and stream connection are bounded by timeouts. Ordinary API calls
have a 30-second limit; model message calls have a 15-minute limit so an Approval
request can remain paused while the administrator decides. Responses are streamed
into a bounded 4 MiB buffer.

The browser treats the remote message history as the authoritative chat state. It
reconciles that history when OpenCode reports a ready/idle/completed session, when
the browser SSE connection opens again, and when the authenticated event relay
reports that its bounded receiver skipped events. A failed message `POST` is
therefore checked against remote history before an error is shown; retries use a
bounded backoff instead of continuous polling.

Permission flow:

1. OpenCode emits `permission.asked` or `permission.v2.asked` on its loopback SSE.
2. CarobaGuard forwards the event to authenticated operators without exposing the
   OpenCode port or credentials.
3. An operator replies through the CSRF-protected CarobaGuard API, supplying the local session ID. The backend checks the active workspace, pending request and mode.
4. CarobaGuard relays only `once` or `reject`. A session grant is kept in memory and never changes global or native saved permissions.
5. Completed tool parts are audited separately and deduplicated by `callID`,
   including in Unrestricted mode.

Interactive question flow:

1. OpenCode emits `question.asked` (or its v2 counterpart) and pauses the tool.
2. CarobaGuard displays the bounded question payload only for mapped AI sessions.
3. An authenticated operator replies or rejects through the CSRF-protected API;
   Unrestricted sessions additionally require an administrator.
4. CarobaGuard relays the decision to loopback OpenCode and audits it without
   storing the answer text.

Primary references:

- https://dev.opencode.ai/docs/server/
- https://dev.opencode.ai/docs/sdk/
- https://dev.opencode.ai/docs/permissions/

## Browser workspace

The OpenCode page separates session navigation, conversation setup and shared
process controls. Session mode is always shown beside the conversation title;
the process warning refers to the running child, not the selected history entry.
Under **Configurações e processo**, **Mostrar aviso de Unrestricted** controls
only that warning banner. This browser-local preference uses
`carobaguard.showUnrestrictedWarning` in localStorage and defaults to visible.
It does not alter authorization, confirmation requirements or the session badge.

Session search covers title, directory and mode. Unsent drafts are kept separately
in memory per session and cleared on logout. Escape closes the history/setup
panel and restores focus; Ctrl/Cmd+Enter sends a message. Panels reflow into the
document on smaller screens, so they do not require modal focus trapping.
Permission cards are scoped to the selected remote session and remove resolved
requests by ID, including when an SSE reply arrives before the HTTP reply.

The history toolbar supports manual reconciliation without reposting prompts.
Failed prompts can be restored for editing only when the input is empty, preserving
the current draft. Completed assistant responses can be copied as plain text.
POST callbacks are tied to their original request object so a late reply cannot
settle a newer request in the same session after interruption or recovery.

The backend remains authoritative for mode authorization, including resuming
Unrestricted sessions: the current process mode alone does not reveal the global
authorization setting. The UI disables actions for known RBAC restrictions and
reports backend failures without changing the security policy.

Run client regressions with `node --test tests/*.test.js` and syntax checks with
`node --check web/app.js`. Browser verification should additionally cover all
three modes, narrow viewports, keyboard focus, errors, and preference persistence.

## Persistent Session Manager

See [the session audit and API contract](session-manager-audit.md) for lifecycle,
locking, restart recovery, local history, bounded timeline, temporary grants and
validation commands. Reading offline history no longer starts a Read-Only child.
The terminal remains an independent administrative PTY; session output comes from
OpenCode tool messages.
