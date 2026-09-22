# Provider adapters (cline / qoder): assumptions and known limitations

This document is the "Assumptions and known limitations" companion for the PR
that adds the two self-written provider adapters:
`packages/core/src/providers/cline.ts` and `packages/core/src/providers/qoder.ts`.
Each section states the assumption or limitation, cites the exact code it rests
on, and says what a PR reviewer should take away from it. All line numbers refer
to the working tree at the time of writing.

---

## 1. `qoder` and `qoder-cn` share one `qoder:<uuid>` session namespace

**Background.** Qoder ships as two separate Desktop installs — the
international build (`~/.qoder`) and the CN build (`~/.qoder-cn`) — and the
codebase models them as two providers (`qoder` and `qoder-cn`) built from one
factory. Both providers mint session ids in the same `qoder:<uuid>` namespace
rather than in per-install namespaces.

**Evidence.**

- The adapter header states the design: "Two installs, two providers … Session
  ids share the `qoder:<uuid>` namespace (UUIDs are globally unique); the
  `source` column distinguishes the installs" (`qoder.ts:14-18`).
- Both providers derive ids through the same helpers:
  `namespacedSessionId` returns `` `qoder:${nativeId}` `` (`qoder.ts:113-115`)
  and `nativeSessionId` strips exactly the `qoder:` prefix (`qoder.ts:117-119`).
- The install distinction is carried on the session row, not the id: the
  session record is yielded with `source: name` (`qoder.ts:627`), where `name`
  is `'qoder'` or `'qoder-cn'` (`qoder.ts:52`).
- Both providers are registered side by side from one factory
  (`builtins.ts:29-30`, `qoder.ts:660-666`).

**Note for the reviewer.** The shared namespace is safe in practice because
the two Desktop installs are independent account systems: each install
generates its own session UUIDs, and there is no product path that copies
transcripts between `~/.qoder` and `~/.qoder-cn`. A collision would require
two independent UUIDv4 draws to match, which is negligible. The failure mode,
if it ever happened, would be two installs fighting over one session row
(`delete-session` + full reparse from each side); the `source` column would
still identify which install wrote the current content. We considered
`qoder-cn:<uuid>` as a separate prefix and rejected it: it would make the
`raw()` lookup prefix dispatch (`qoder.ts:638-642`) and every existing
`qoder:` uuid shape two-armed for no practical benefit.

---

## 2. WSL coverage gap: one install location per provider, Windows or WSL

**Background.** The qoder adapters compute their default install layout from
the Windows user profile: `installDir` is `join(homedir(), '.qoder-cn')` /
`join(homedir(), '.qoder')` and `dbPath` points into
`AppData/Roaming/<appId>/main.sqlite` (`qoder.ts:60-80`). A Qoder CLI
installed inside WSL keeps its data at the Linux-side `~/.qoder-cn`, which
these defaults never see.

**Evidence.**

- Defaults are homedir-derived Windows paths (`qoder.ts:66-67`, `qoder.ts:77-78`).
- `withRoot` accepts a `rootDir` override, so a user can point the provider at
  a `\\wsl$\<distro>\home\<user>\.qoder-cn` path (`qoder.ts:86-94`). For a
  rootDir-only override the db path is re-derived from the new root's sibling
  `AppData` (`qoder.ts:89-92`), and the header documents that a missing db
  degrades gracefully — null titles, suppressed tombstones, never a crash
  (`qoder.ts:82-85`; the degraded paths are `readSessions` returning `null` on
  open failure, `qoder.ts:168-174`, and titles falling back to `null`,
  `qoder.ts:548`).
- The registration site wires exactly one instance per provider, each with a
  single `rootDir`: `createQoderProvider({ rootDir: roots['qoder'] })` and
  `createQoderCnProvider({ rootDir: roots['qoder-cn'] })` (`builtins.ts:29-30`,
  registry assembled in `builtins.ts:21-32`).

**Note for the reviewer.** A rootDir override makes either the Windows install
or one WSL distro visible, but because `builtins.ts` registers one instance per
provider name, both cannot be indexed at the same time — it is an either/or
configuration, not multi-root. Covering Windows + WSL simultaneously needs
either multi-root support in the provider contract or a second registered
instance with its own provider id; both are deliberate design changes, not
bugfixes. We recommend tracking this as a follow-up issue rather than
expanding this PR.

---

## 3. Cline projection trade-offs: result transports are skipped as user turns; unhandled block types are not projected

**Background.** Cline CLI transcripts are Anthropic-style content-block arrays
(`text` / `thinking` / `tool_use` / `tool_result` / `image`,
`cline.ts:6-8`). The projection makes two deliberate trade-offs about what
does *not* become a message record.

**Evidence.**

- A user-role message whose content is *only* `tool_result` blocks is treated
  as a result transport, not a user turn: the header states this
  (`cline.ts:19-22`) and the projection implements it via `isResultCarrier`,
  which routes the results to the tool call they answer and `continue`s
  without emitting any message record (`cline.ts:210-220`). Consequently such
  messages also stay out of the parent chain (the chain is maintained across
  messages via `previousMessageUuid`, `cline.ts:170-173`, `cline.ts:229`).
- The projection only renders four block types: it filters for `text`,
  `thinking`, and `tool_use` blocks (`cline.ts:222-224`) and emits records
  from the thinking/text/tool_use loops plus tool results
  (`cline.ts:259-300`). Other block types present in the format — notably
  `image` — are silently dropped from the projection (they survive only in the
  raw payload returned by `raw()`, `cline.ts:342-367`).
- A message with no renderable text/thinking at all still gets a visible
  anchor: an empty `tool_use`-typed record is emitted so tool calls have a
  carrier (`cline.ts:270-273`).

**Note for the reviewer.** The planning notes for this document described this
section as "skipping non-terminating compaction API messages". We could not
verify that framing: there is no compaction-specific logic anywhere in
`cline.ts` or its tests (checked `git log -p` for the file, the working-tree
diff, and `tests/cline-parse.test.mjs`), and the Cline CLI session format this
adapter reads does not carry compaction marker messages. The section above
therefore documents the skipping behavior that actually exists. Consequences
to be aware of: (a) message_count intentionally excludes result transports
(`visibleCount` is only incremented for anchored messages, `cline.ts:274`);
(b) image-only turns collapse to an empty anchor record. Both are consistent
with the full-snapshot, `countMode: 'total'` reparse model (`cline.ts:304-317`)
— if Cline ever rewrites history (including any future compaction), the next
parse replaces the session wholesale via the `delete-session` head
(`cline.ts:452`), so no stale projection accumulates.

---

## 4. Qoder's freshness guard runs *after* the yields, and relies on persist always running inside a transaction

**Background.** Both adapters guard against the source changing while a
snapshot is being parsed, but qoder checks freshness at a different point in
the record stream than cline does. The styles differ; the safety is
equivalent *only because of where parse is consumed*.

**Evidence.**

- cline performs both stat checks before any record is yielded: it reads the
  two JSON files, compares `before`/`after` cursors, and only then yields
  (`cline.ts:438-443`; yields start at `cline.ts:452-454`).
- qoder yields records as it parses (`qoder.ts:565`, `qoder.ts:596-609`,
  `qoder.ts:615-628`) and only afterwards re-derives the cursor and throws if
  it moved (`qoder.ts:629-635`). There is also a pre-parse guard
  (`qoder.ts:561-564`), so a change is caught either before streaming starts
  or after it ends.
- The throw is safe because of the consumer-side contract: `persist` drives
  the generator lazily and writes records into the database as they arrive
  (`persist.ts:319-332`), so by the time the post-yield guard throws, partial
  rows *have been written* — inside the surrounding transaction.
  `indexProviderPlan` calls `persist` inside `runTransaction`
  (`provider-indexing.ts:276-295`), which the indexer wires to
  `runRetryableWriteTransaction` (`indexer.ts:287`), which delegates to
  `runWriteTransaction` (`write-coordinator.ts:97-105`). Any exception —
  including the guard's — triggers `ROLLBACK` (`tx.ts:104-116`), and no cursor
  is persisted for the unit (`persist.ts:333-338` is never reached), so the
  next run retries it.

**Note for the reviewer.** This is an *implicit* contract: qoder's parse is
only as safe as the guarantee that `persist` is always invoked inside
`runWriteTransaction`. That is true of every current call site
(`provider-indexing.ts:292`, and the strict variant runs in a caller-owned
transaction, `provider-indexing.ts:321-343`), but nothing in the type system
enforces it. If a future caller ever drains a parse generator outside a
transaction, qoder's post-yield guard would throw after partial writes had
already committed. We kept the post-yield guard because the transcript files
can only be re-statted cheaply at the end (a pre-read-only guard cannot cover
a long parse of a large JSONL), but we flag the invariant explicitly here so
reviewers can decide whether it deserves an assertion or a comment at the
`persist` entry point.


---

## 5. Qoder tombstone units use a different key shape than qoder session units

**Background.** Every adapter emits a "tombstone" unit when a previously
indexed session disappears, so the persisted rows can be retracted. In qoder,
the key of that tombstone unit is deliberately not the same shape as the key
of a live session unit.

**Evidence.**

- Live session units are keyed by transcript path: `const key = jsonlPath`
  (`qoder.ts:527`), pushed at `qoder.ts:538-554`. The transcript is the
  presence truth for a live session, so the path is the natural cursor key.
- Tombstone units are keyed by `` `${dbPath}#${sessionId}` ``
  (`qoder.ts:459-464`) — the deleted transcript path no longer exists, so the
  key is derived from the GUI database path plus the namespaced session id.
  Cline by contrast keys both kinds by session directory
  (`cline.ts:411` and `cline.ts:427`).
- The tombstone's `parse` returns `null` without yielding
  (`qoder.ts:559-560`); retraction happens through `retractSessionIds`, which
  `persist` applies before consuming the stream (`persist.ts:226`,
  `qoder.ts:462`), and `indexer.ts:291` accounts for the same ids when
  tracking planned retractions. A `null` cursor means no `index_state` row is
  written for the tombstone key (`persist.ts:335-338`).

**Note for the reviewer.** Two consequences, both intentional. First, qoder
`index_state` cursor rows are always keyed by transcript path; the
`dbPath#sessionId` tombstone keys never accumulate cursor state, so there is
no orphaned cursor churn when sessions are deleted. Second, unlike cline
(`cline.ts:375`), qoder defines no `sessionUnitKey` hook, so nothing outside
the provider ever needs to reconstruct either key shape — but if a future
feature needs to map a live session back to its unit key, it must know the
two shapes differ.

---

*Prepared for PR review. Line numbers were verified against the working tree;
if any cited hunk moves during review, re-check the reference rather than
assuming it still holds.*

