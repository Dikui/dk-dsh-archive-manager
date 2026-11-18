# dk-dsh-archive-manager

An archive center for DeepSeek Harness.

DSH's built-in archive is a registry-global set of session ids. It can hide an
archived session from the sidebar, but it does not carry an archive time, note,
tag, preview, capacity view, or batch restore. This plugin adds those surfaces
without changing the built-in archive set or deleting any data.

## Features

- **Archive center panel** — a native panel entry in the sidebar panel list and
  a full `main` panel, not a floating dialog.
- **Search, filters, and sorting** — title, workspace, cwd, note, tag, or id;
  all / with note / tagged / unknown archive time / missing log; newest, oldest,
  recently active, largest log, or title.
- **Archive metadata** — archive time (observed live), note up to 2000 chars,
  and up to 20 tags. Existing archives whose time predates the plugin are shown
  as unknown, never guessed.
- **Read-only preview** — session header, workspace, timestamps, event/turn/
  step/tool counts, first user message, latest assistant reply, and top tools.
  Opening a preview never unarchives or resumes the session.
- **Full transcript** — load the complete event log one bounded page at a time;
  each event is clipped, and paging is read-only.
- **Archive audit trail** — each metadata record keeps up to 50 archive/restore
  events with timestamp and source (you, the plugin observer, or the system),
  shown as a timeline in the preview.
- **Saved views** — save the current search, filter, sort, and tag as a named
  view (up to 50); apply or delete it from the toolbar. Views live in a separate
  v1 domain so the entries schema needs no migration.
- **Batch workspace** — a dedicated tab, not a modal. Filter the candidate pool
  by time range (past 24 hours / 7 / 30 / 90 days or all time), time basis
  (last activity or created), and state (open, archived, or both); then search,
  sort, and select the exact rows to archive, restore, or export from a sticky
  footer. The Host applies time and state filters before capping the pool, so
  narrowing the range reveals older sessions instead of hiding them behind the
  first page. Active rows show the reported activity; the Host refuses to stop
  or archive them until the user explicitly confirms. No silent `stopActivity`.
- **Restore** — one session or a selection, through
  `workspaceRegistry.unarchiveSession`.
- **Capacity** — summed session-log size and unknown-size count. Attachment
  bytes are not included.
- **Export** — per-session or batch download through the built-in
  `/api/session.export` ZIP route (which includes descendants and attachments).
- **Archive notice timestamp** — the built-in archive toast is extended with the
  archive time recorded by this plugin.
- **Optional Agent retrieval** — when the profile sets `tools: true`, registers
  three read-only tools: `archive_list`, `archive_search`, and `archive_read`.
  They return bounded metadata/snippets or one transcript page, never a full
  transcript, and are off by default.
- **Bilingual UI** — English and Chinese, with theme-token styling and keyboard
  operable rows.

## What it deliberately does not do

- No physical deletion or recycle bin. DSH has no safe session-deletion API;
  this plugin never removes logs, attachments, index entries, or lineage.
- No scheduled or automatic archiving.
- No silent `stopActivity`. Batch archive refuses active sessions until the
  user confirms; there is no timer, retry, or background stop.
- No automatic open after restore. The public Client surface does not expose
  session selection to other plugins, so the UI says to open the restored
  session from the session list.
- No multi-user roles or audit permissions.

## Install

The plugin has no build step.

```bash
plugin_manager install_bundle target=file:/path/to/dk-dsh-archive-manager
```

Then restart or refresh DSH so the Host and Client bundles load. The panel
appears in the sidebar panel list as **Archive Manager / 归档管理**.

Agent retrieval is opt-in. Set the plugin option `tools: true` in this
profile's plugin configuration, then restart DSH. The
`archive_list`/`archive_search`/`archive_read` tools are read-only and bounded;
they remain absent when the option is omitted or false.

## Development

```bash
npm test
npm run check
```

`npm test` runs the pure model, JSON-store, and Host-route contract tests with
`node:test`. The Host and Client halves are plain ESM/UMD-style modules and are
syntax-checked by `npm run check`.

## How it works

- Host routes: `POST /api/dk-dsh-archive-manager/{list,preview,entry,transcript,
  candidates,archive-many,unarchive,unarchive-many,views,view-save,view-delete,
  notice}`. Every route requires same-origin JSON plus the
  `x-dk-archive-manager: 1` header, caps the body at 256 KiB, and caps a batch
  operation at 200 ids. Transcript pages are capped at 100 rows (40 by
  default); saved views are capped at 50 per profile.
- The archive set comes from the public
  `workspaceRegistry.archivedSessionIds` getter, with
  `workspaceController.follow` as a fallback.
- Metadata is stored in the `archive_manager` v1 domain KV table `entries`;
  saved views use the separate `archive_manager_views` v1 table `views`. When
  the domain facility is unavailable, both use an atomically written JSON
  fallback under `$DSH_HOME/archive-manager/entries.json` (version 2, which still
  reads version 1).
- A `workspace/session-archived` listener records the archive time unless the
  batch route already wrote the user-sourced record. The built-in archive set
  remains the source of truth for membership; sidecar records only decorate it.
- Batch candidates call the public `workspace/session-activity` waterfall to
  label active rows. The actual archive call never passes `stopActivity` unless
  the user confirmed; the Host's own activity refusal is the final guard.
- `candidates` accepts `range` (`all`, `24h`, `7d`, `30d`, `90d`), `basis`
  (`activity` or `created`), and `state` (`all`, `open`, `archived`). It filters
  before slicing up to 200 open and 100 archived rows, and returns
  `openTotal`, `archivedTotal`, `total`, `truncatedOpen`, and
  `truncatedArchived` so the Client can say when a range is still too broad.
  The activity basis uses the session log's mtime because session headers do
  not carry an activity timestamp; if the log cannot be located, it falls back
  to `createdAt`. Search and sort inside the batch workspace are local to the
  loaded rows.
- The Client talks to the Host with `fetch` and registers into the `main` and
  `sidebar.panellist` slots. It does not depend on internal Client services.
  The archive-notice waterfall can only change the toast text/tone, so the
  plugin adds the timestamp but cannot add an “open Archive Manager” button.

## Known limits

- Archive times for sessions archived before the plugin was installed are
  unknown; there is no historical timestamp in DSH.
- Archive log size comes from the persistence snapshot when cheap, otherwise
  from `fs.stat(location.path)`. Attachments are separate and are not counted.
- A ghost entry (id in the archive set, log file gone) can be listed and
  restored, but its preview is unavailable.
- Batch export opens one browser download per zip; browsers may ask for
  permission or block multiple downloads.
- Full-transcript paging reads the session log in the Host and returns one
  bounded page. DSH has no streaming/paged read API, so a very large log still
  costs one full read per page request.
- Restore does not select the session in the conversation view. The public
  Client slot/service surface does not expose session selection, so the plugin
  deliberately does not reach into the private workspace store.
- The archive notice can only change `text` and `tone`; it cannot add an
  action button. The added timestamp is therefore informational.
- The candidate pool returns up to 200 open sessions and up to 100 archived
  rows after time/state filtering; `openTotal` and `archivedTotal` still cover
  the complete matching set, and the Client warns when either cap truncates it.
