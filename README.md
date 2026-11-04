# dsh-agents-md-editor

A DSH bundle: one left-sidebar entry that opens an editor page for the Agent
instructions file, `~/.dsh/AGENTS.md`.

- **Left sidebar entry** — registered in `sidebar.panellist`; the matching
  `main` keyed panel is the page the entry opens.
- **Live** — the page polls the file's sha1 version every 2s. An edit made
  elsewhere (the agent, another editor) appears automatically while the buffer
  is clean; with unsaved text it raises a banner instead of overwriting.
- **Safe save** — `POST /agents-md-editor/api/save` carries the version the
  page loaded and is refused with `conflict` (409) if the file changed
  meanwhile. Writes go to a temp sibling and are renamed into place, so a
  crash never leaves a truncated instructions file.
- **Draft survives panel switches** — switching to the conversation and back
  restores unsaved text.
- **Follows the host type scale** — every size reads the theme's own variables
  (`--dsh-content-font-size`, `--dsh-content-font-size-secondary`), so
  Settings → General → body font size resizes this page too; no px values are
  hardcoded.

## Install

From the registry:

```sh
dsh plugin --profile desktop add dsh-agents-md-editor
```

From a local checkout (development):

```sh
dsh plugin --profile desktop add ./dsh-agents-md-editor
```

Either way the bundle lands in the profile, and the left sidebar grows one entry
(「代理说明编辑器」/「Agent Instructions Editor」).

## Configuration

`filePath` (default `~/.dsh/AGENTS.md`) is the only file the plugin reads and
writes. `~` and `~/` are expanded; a relative value resolves against the Host
process working directory.

```yaml
- id: agents-md-editor
  name: 'dsh-agents-md-editor'
  config:
    filePath: '~/.dsh/AGENTS.md'
```

## Routes

Both routes are gated by `ctx.connection.requestRejection` — the same
browser-trust fence the shipped plugins use — and neither accepts a path:

| Route | Method | Body / result |
| --- | --- | --- |
| `/agents-md-editor/api/state` | GET | `{ exists, path, content, version, mtimeMs, size }` |
| `/agents-md-editor/api/save` | POST | `{ content, baseVersion }` → `{ path, version, mtimeMs, size, savedAt }` |

`version` is the sha1 of the file's UTF-8 bytes.

## Notes

The Host half writes with `node:fs` rather than the file sandbox, because the
target deliberately lives outside the session workspace and a UI action has no
approval channel. The route table takes no user-supplied path, so the reachable
surface is the single configured file.

## Verifying

```sh
node test/host.test.mjs   # or: npm test
```

22 checks against a throwaway file in the OS temp directory: missing file,
first create, normal save, stale `baseVersion` → 409 with the file untouched,
405/404/400, the trust fence → 403, and `~` expansion. The real
`~/.dsh/AGENTS.md` is never opened.

## License

MIT — see [LICENSE](LICENSE).
