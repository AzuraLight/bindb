# Changelog

## 0.2.0

Requires VS Code 1.103 or later (Node.js 22.17 in the extension host, for the built-in `node:sqlite`).

### Security and data safety — from code review and an audit against official documentation

The audit is in `docs/audit-2026-11-06.md`; items not listed here are still open.

- **SQLite runs on the real file through Node's built-in SQLite (`node:sqlite`), in its own process.**
  The previous driver loaded the whole file into memory and wrote it back, so changes made by another
  app at the same time were silently overwritten and the file could be corrupted.
  - SQLite now does its own locking and journaling, and WAL databases are read and written normally.
  - The extension host no longer freezes while a query runs or waits for a lock.
  - **Cancel** stops the SQLite process. An interrupted write is rolled back by SQLite's journal, and
    the next query reconnects.
  - Results are buffered in that process (up to 100,000 rows, the rest read on demand), so other apps
    are not blocked by a half-read result.
  - Several statements in one execution are refused instead of running only the first.
  - Large integers stay exact (BigInt).
  - `INSERT … RETURNING` runs when executed and reports changed rows.
  - The `@sqlite.org/sqlite-wasm` dependency is gone.
- **PostgreSQL / H2 dates and times are passed through as the server's text.** node-postgres turned
  them into JavaScript dates in the local time zone, which shifted values (UTC+9: `2024-01-01` became
  `2023-12-31T15:00Z`), dropped microseconds, and could make a grid edit keyed on a date change the
  wrong row.
- **SQL is split and checked with each database's own lexical rules**:
  - PostgreSQL: backslash escapes only in `E'…'`; `#` is an operator; nested comments.
  - MySQL: `#` comments; `-- ` needs a space; `"…"` is a string; `/*! … */` is code.
  - SQLite: no backslash escapes.
  - H2: `//` comments, nested comments, `$$…$$`.

  Before, `'a\'; DELETE …` could hide a second statement. This applies to running statements,
  CodeLens, completion, DDL files, the grid's WHERE / ORDER BY bar, startup scripts and the read-only
  check.
- **Read-only is enforced before running**, not only by the database:
  - Read-only connections and the AI `run_query` tool refuse writes, side-effect functions (also when
    written as quoted names), row locks (`FOR UPDATE / SHARE / NO KEY UPDATE / KEY SHARE`,
    `LOCK IN SHARE MODE`), `EXPLAIN ANALYZE … INTO`, and SQLite `PRAGMA x(value)`, `optimize`,
    `incremental_vacuum` and `wal_checkpoint`.
  - SQLite read-only and AI sessions open the file read-only, so SQLite itself rejects writes.
- `BEGIN IMMEDIATE`, `BEGIN ISOLATION LEVEL …` and other `BEGIN` forms at the start of a statement are
  transactions, not blocks.

### Added — result grid

- **WHERE / ORDER BY bar** above the results (Enter applies, Esc restores) and **sorting by clicking a
  column header** (asc → desc → off; Shift adds a column). Query results are wrapped as
  `SELECT * FROM (…) bindb_q`; statements that cannot be wrapped (SHOW, PRAGMA, …) say so. `;`, line
  comments, unclosed quotes and unbalanced parentheses in the bar are refused.
- **Edit table data** (Open Table Data): edit cells, Set NULL / Set DEFAULT, add and delete rows, then
  **Preview**, **Submit** or **Revert**. Rows are found by their primary key (SQLite tables without one
  by `rowid`); values are sent as parameters, never pasted into SQL. Submit runs in one transaction and
  rolls everything back if any change fails or does not hit exactly one row. With manual transaction
  control the changes stay in the open transaction for you to commit. Views, query results, read-only
  connections and tables without a key are read-only and say why.
- **Export** all rows (not only the loaded page) to CSV, TSV, JSON, Markdown or SQL INSERT, streamed to a
  file with progress and cancel; **Copy as** the same formats from the selection.
- **Query History** (`Cmd/Ctrl+Alt+E`): search what you ran per connection, insert it or run it again;
  repeats fold together; Clear Query History.

### Fixed — found while testing the grid on real servers

- H2 embedded files opened by more than one session started a second H2 server on the same file;
  sessions now share one server, which is stopped when the last session closes or VS Code exits.
- A connection dropped by the server (for example `pg_terminate_backend`) raised an unhandled error;
  BindB now drops that session and reconnects on next use.

### Added — AI agents

- **MCP server for AI agents** (`bindb.ai.mcpServer.enabled`, off by default): a local Streamable HTTP
  server on 127.0.0.1 with a bearer token. Tools: `list_connections`, `get_schema`, `run_query`
  (read-only transaction, always rolled back, row limit, long values truncated), `explain_query`, and
  `execute_statement` (only with `bindb.ai.allowWrites`, never on read-only connections, and each
  statement is confirmed in VS Code). Passwords and connection strings are never returned.
- **Copilot** agent mode picks the server up automatically (`mcpServerDefinitionProviders`).
- **Connect Claude Code (MCP)** runs or copies `claude mcp add --transport http --scope user …`
  (the token stays in `~/.claude.json`, not in the repository); **Connect Codex (MCP)** adds
  `[mcp_servers.bindb]` to `~/.codex/config.toml`. **Copy Schema for AI Chat** copies a
  connection's schema as Markdown; **Regenerate MCP Token** rotates the token.

### Added — more of DataGrip's Data Sources dialog

- Options: Default introspection level (1 names only / 2 no sources / 3 everything), pre-introspected
  system catalogs for completion, virtual objects (virtual foreign keys with JOIN … ON completion,
  virtual views, virtual columns computed in Open Table Data; kept in a per-data-source file),
  session templates, Before connection (VS Code tasks), Code style for generated SQL, data source color.
- SSH: shared SSH configurations, Parse config file `~/.ssh/config`, keep-alive, Strict host key
  checking (Yes / Accept New / No / Ask, with `~/.ssh/known_hosts` including hashed entries).
- SSL: Use truststore (bundled Node.js CAs, operating-system store) and Copy from another data source.
- Schemas: Expand All / Collapse All. Drivers: H2 Class, Download ver. N and version choice from
  Maven Central (SHA-1 checked). Data Source Templates (no credentials). DDL mapping Apply now asks
  which changes to apply (drops unticked by default) before opening the script, and
  **Run All Statements** runs a whole file.

### Fixed

- MySQL **Verify full** did not check the server host name (mysql2 needs `verifyIdentity`).
- H2 listed its `information_schema` / `pg_catalog` tables as user tables.
- Keep-alive queries never ran after a result had been read to the end.
- **SQLite databases with FTS5 tables failed to load** ("no such module: fts5"). The SQLite built into
  VS Code includes FTS5 (checked on VS Code 1.103: SQLite 3.50.0).

### Changed

- **Data Sources panel modelled on DataGrip's Data Sources and Drivers dialog** (laid out after
  JetBrains' published screenshots): Data Sources | Drivers on the left with Add (by type), Remove,
  Duplicate, Go to Driver, Back/Forward, Global / Project / DDL groups and Problems; Name and Comment,
  General · Options · SSH/SSL · Schemas · Advanced tabs, Test Connection with the server version, and
  OK / Cancel / Apply. Right-click a data source for Duplicate, Reset Changes, Change Driver,
  Make Global / Move to Project and Remove. The explorer's + is a menu of database types.
- Driver logos from Simple Icons in the panel and the explorer.

### Added

- **General:** Connection type (default, URL only; H2 Remote / Embedded), Authentication
  (User & Password, No auth, pgpass for PostgreSQL), password Save (Never, Until restart, For session,
  Forever), and a URL built from the fields — paste one to fill them in.
- **Options:** Read-only, Transaction control (Manual adds Commit / Rollback commands), Switch schema
  (Automatic / Manual / Disable, with a `-- @schema:` console comment and a Switch Schema command),
  Time zone, Session control (single shared, shared + introspection, dedicated per console),
  keep-alive query, auto-disconnect, connect timeout, Single database mode (off lists the server's
  PostgreSQL databases in the explorer), Startup script; Introspection: Auto sync after DDL, Load
  sources for (view definitions as tooltips), Track databases/schemas creation and deletion, and
  an automatic introspection interval.
- **SSH/SSL:** SSH tunnel (password, key pair with passphrase, OpenSSH agent; dynamic or fixed local
  port) and SSL with CA, client certificate, client key and key password, Require / Verify full.
- **Schemas:** load the server's databases and schemas and tick the ones to show; Schema pattern,
  Object filter (`table:-tmp_.*`), Show internal system schemas, Show template databases.
- **Advanced:** driver connection options (name / value), and VM options, VM environment and working
  directory for the H2 Embedded java process; relative file paths resolve against the working directory.
- **Project data sources** stored in the workspace settings.
- **DDL data sources and DDL mapping:** a folder of `.sql` files as a data source; Create DDL Mapping;
  Dump to / Update from writes the database objects into the files (deleting files of objects that
  no longer exist, after a confirmation); Apply to opens a migration script for review (drops commented out).

### Fixed

- PostgreSQL had no connect timeout and could wait indefinitely on an unreachable host (default now 10 s).

## 0.1.0

First preview release.

### Added

- **Connections** for PostgreSQL, MySQL/MariaDB, SQLite and H2. Definitions live in the
  `bindb.connections` setting; passwords are stored in the OS keychain.
- **H2 support** through H2's built-in PostgreSQL protocol server — connect to a running
  `org.h2.tools.Server -pg`, or pick a `.mv.db` file and BindB starts the server for you
  (requires `java` and `bindb.h2.jarPath`).
- **Database Explorer** in the activity bar: connections → schemas → tables/views → columns.
  Click a table to open its data.
- **Run statement at cursor** with `Cmd/Ctrl+Enter` or the `▶ Run` CodeLens. A selection runs as-is.
- **Result grid** with virtual scrolling that pages rows in as you scroll, VS Code theme colors,
  and cell copy.
- **Schema-aware completion**: tables after `FROM`/`JOIN`, columns of the tables and aliases in
  the statement, `schema.` / `alias.` lookups, and `INSERT INTO t (…)` column lists.
- **Per-file connection** via a `-- @conn: <name>` comment, shown and changed from the status bar.
- **Read-only connections** that refuse statements which modify data.
