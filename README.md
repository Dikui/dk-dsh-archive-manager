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
- **Restore** — one session or a selection, through
  `workspaceRegistry.unarchiveSession`.
- **Capacity** — summed session-log size and unknown-size count. Attachment
  bytes are not included.
- **Export** — per-session or batch download through the built-in
  `/api/session.export` ZIP route (which includes descendants and attachments).
- **Bilingual UI** — English and Chinese, with theme-token styling and keyboard
  operable rows.

## What it deliberately does not do

- No physical deletion or recycle bin. DSH has no safe session-deletion API;
  this plugin never removes logs, attachments, index entries, or lineage.
- No scheduled or automatic archiving.
- No silent `stopActivity`. Restore only; archiving stays with the built-in
  sidebar flow.
- No multi-user roles or audit permissions.

## Install

The plugin has no build step.

```bash
plugin_manager install_bundle target=file:/path/to/dk-dsh-archive-manager
```

Then restart or refresh DSH so the Host and Client bundles load. The panel
appears in the sidebar panel list as **Archive Manager / 归档管理**.

## Development

```bash
npm test
npm run check
```

`npm test` runs the pure model, JSON-store, and Host-route contract tests with
`node:test`. The Host and Client halves are plain ESM/UMD-style modules and are
syntax-checked by `npm run check`.

## How it works

- Host routes: `POST /api/dk-dsh-archive-manager/{list,preview,entry,unarchive,unarchive-many}`.
  Every route requires same-origin JSON plus the `x-dk-archive-manager: 1`
  header, caps the body at 256 KiB, and caps a batch restore at 200 ids.
- The archive set comes from the public
  `workspaceRegistry.archivedSessionIds` getter, with
  `workspaceController.follow` as a fallback.
- Metadata is stored in the `archive_manager` v1 domain KV table `entries`, with
  an atomically written JSON fallback under `$DSH_HOME/archive-manager/entries.json`
  when the domain facility is unavailable.
- A `workspace/session-archived` listener records the archive time. The built-in
  archive set remains the source of truth for membership; sidecar records only
  decorate it.
- The Client talks to the Host with `fetch` and registers into the `main` and
  `sidebar.panellist` slots. It does not depend on internal Client services.

## Known limits

- Archive times for sessions archived before the plugin was installed are
  unknown; there is no historical timestamp in DSH.
- Archive log size comes from the persistence snapshot when cheap, otherwise
  from `fs.stat(location.path)`. Attachments are separate and are not counted.
- A ghost entry (id in the archive set, log file gone) can be listed and
  restored, but its preview is unavailable.
- Batch export opens one browser download per zip; browsers may ask for
  permission or block multiple downloads.
