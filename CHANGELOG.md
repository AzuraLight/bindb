# Changelog

## Unreleased

### Added

- **Unresolved reference warnings** in SQL files bound to a connection, like DataGrip's inspection:
  unknown tables after `FROM` / `JOIN` / `UPDATE` / `INSERT INTO` / `DELETE … USING`, unknown columns
  qualified by a table or alias (`u.nmae`), in `INSERT` column lists and in single-table `UPDATE … SET`.
  Only already-loaded metadata is used (no connection is opened for this). Schemas that were not
  introspected, CTEs, objects created earlier in the same file, table functions and subqueries are not
  judged. Unqualified columns are not checked yet. Setting: `bindb.diagnostics.unresolvedReferences`.

## 0.3.0 — 2026-11-09

Not published to marketplaces (BindB stays private until 1.0.0). Two changes need action after updating:
**passwords of project-scoped connections must be entered once more**, and **remote H2 connections that
pointed at an H2 PostgreSQL server (port 5435) must be changed to its TCP server (port 9092)**.

### Changed — closer to DataGrip's Data Sources options

- **Introspection level is automatic by default**, as in DataGrip: the current schema gets level 3 up to
  1000 objects (2 up to 3000, otherwise 1), other schemas level 2 up to 3000, system schemas level 2 up to
  100. The data source's Default level still overrides it, and **each schema can have its own level**
  (right-click a schema or connection → Introspection Level…; the explorer shows `L1`–`L3`). Level 1 now
  reads column names without types, as DataGrip does, instead of no columns at all. _Data sources without a
  Default level used level 3 everywhere; other schemas now get level 2 (no view definitions)._
- **Session templates override** the data source as DataGrip's do: Authentication, User, Read-only (on,
  off or inherit — a template can now turn read-only off), Startup script (replaces the data source's
  instead of being appended) and, for H2, the driver file. Grid edits and the AI write tool honour a
  template's read-only.
- **Transaction isolation level** (Options → Transaction control): Read uncommitted, Read committed,
  Repeatable read or Serializable for PostgreSQL, MySQL and H2.
- **Keep-alive query** can be changed (default `SELECT 1`); it must be one read-only statement.
- **Copy from** copies SSH settings only, like DataGrip.
- **Create database** for H2 Embedded creates the file when it does not exist.
- **Introspect using JDBC metadata** for H2 (Advanced); used automatically for H2 1.x, whose
  `INFORMATION_SCHEMA` reports column types as JDBC numbers.
- The password **Save** selector explains where passwords are kept (VS Code has no separate IDE password
  settings).

### Fixed

- A read-only H2 data source failed to connect when it had a time zone or a startup script (`SET …` was
  refused as a write).


### Fixed — found by edge-case testing on real PostgreSQL 16 and MySQL servers

- **Read-only connections could be bypassed with parentheses.** A statement starting with `(` — for
  example `(SELECT GET_LOCK('k', 1))` on MySQL or `(SELECT CSVWRITE(…))` on H2 — was classified as empty
  and skipped the read-only check. Leading parentheses are now looked through, and anything that does
  not start with a keyword is treated as a write.
- More PostgreSQL functions count as writes on read-only connections and in AI queries: advisory locks
  (`pg_try_advisory_lock`, `pg_advisory_lock_shared`, …, which survive a rollback), statistics resets,
  `dblink_connect`, replication slots and `lo_from_bytea`.
- **PostgreSQL `COPY … TO STDOUT` / `FROM STDIN` froze the connection** with an uncaught error inside
  node-postgres. These are now refused with a message; `COPY … TO / FROM` a server file still runs.
- **MySQL `CALL` with several result sets mixed them into one grid**, including the final OK packet as a
  row. The grid now shows the first result set that has columns, with its own rows — also when an earlier
  `SELECT` returned no rows or an `UPDATE` came first.
- **PostgreSQL arrays, `point` and other non-scalar values are shown as PostgreSQL text** (`{"a,b",NULL}`,
  `(1,2)`) instead of JSON (`["a,b",null]`, `{"x":1,"y":2}`). Editing such a cell failed with
  "malformed array literal"; copy and export used the JSON form. Only booleans, integers, floats, `bytea`
  and `json`/`jsonb` are still converted (H2 too, through the same PostgreSQL protocol).
- **MySQL `DELIMITER` scripts** (procedure and trigger dumps) run statement by statement. The `DELIMITER`
  lines are client directives and are no longer sent to the server.
- A column named `begin` (allowed in PostgreSQL and MySQL) no longer merges the next statement into it.
- Columns named like write keywords (`SELECT copy, load FROM t`, `ORDER BY create`) are no longer refused on
  read-only connections. Writes inside reads (`WITH … AS (DELETE …)`, H2 `FINAL TABLE (INSERT …)`,
  `EXPLAIN ANALYZE DELETE`) still are.
- The grid's WHERE / ORDER BY bar refuses MySQL `#` and H2 `//` line comments like `--`, and queries that
  start with a parenthesis (`(SELECT …) UNION (SELECT …)`) can be filtered and sorted.

### Changed — H2 connects through JDBC

- **H2 now runs its own JDBC driver** in a small Java process (`java/bridge`, 14 KB) that starts when you
  connect and stops when the last H2 connection closes — the same design as DataGrip's driver process.
  BindB used H2's PostgreSQL protocol server before, which forces lower-case names, so **databases made by
  Java apps with default settings (schema `PUBLIC`) could not be opened at all**.
  - Embedded files, **Remote = H2 TCP server** (`jdbc:h2:tcp://…`, default port 9092) and URL only
    (including `jdbc:h2:mem:`). _Remote H2 connections that pointed at an H2 PostgreSQL server (port 5435)
    need to be changed to its TCP server._
  - Results are read page by page and running queries can be cancelled (both were missing for H2).
  - H2 1.4 `.h2.db` files open with an H2 1.4 jar; databases made in PostgreSQL mode by earlier BindB
    versions still open.
  - No network port is opened (the PostgreSQL server listened on a local port with H2's `sa` account).
  - Grid edits on H2 use `?` parameters; H2 array columns are read-only in the grid (writing back the
    shown text `[a, b]` would store a one-element array). The H2 jar is needed for every H2 mode, not only files.
  - Driver options of an H2 data source are added to the JDBC URL (`;AUTO_SERVER=TRUE` …).

### Security — remaining items from `docs/audit-2026-11-06.md`

- **Project connections keep their secrets per workspace.** The keychain is shared by every workspace, and
  a project connection's password was stored under its id alone, so another repository that reused a
  published id with a different host received that password. Project connections now use a
  workspace-specific key, and a project connection with the same id as a global one is ignored.
  _Passwords of existing project connections need to be entered once more._
- Shared SSH configurations are read from user settings only (a workspace could redefine one by id).
- `bindb.ai.allowWrites`, `bindb.ai.mcpServer.*` and `bindb.ssh.configurations` can only be set in user
  settings, `bindb.h2.jarPath` in user or remote-machine settings — not from a repository's
  `.vscode/settings.json`.
- **The MCP server checks `Host` and `Origin`** (required by the MCP Streamable HTTP spec): requests from
  web pages or rebound host names get 403 even with the token.
- **Connect Claude Code** runs `claude mcp add-json` directly (no shell history, no temporary file); the
  copied command works in PowerShell on Windows and its temporary token file is removed after 10 minutes
  or when VS Code closes. **Connect Codex** can store only an environment variable name
  (`bearer_token_env_var = "BINDB_MCP_TOKEN"`) instead of the token.

### Fixed — remaining items from the audit

- PostgreSQL **materialized views** appear in the explorer (as views, with columns and definition).
- **Switching schema keeps the rest of `search_path`** (`"sales", "$user", public` instead of `"sales"`),
  so functions and types of extensions in `public` are still found.
- **Manual transaction mode** no longer wraps statements that cannot run in a transaction block
  (`VACUUM`, `CREATE INDEX CONCURRENTLY`, `CREATE DATABASE`, `ALTER SYSTEM`, …) in `BEGIN`.
- **Query cancel on PostgreSQL uses the protocol CancelRequest** instead of logging in again to call
  `pg_cancel_backend`, so it also works at the connection limit, without extra privileges and through
  PgBouncer.
- **SSL modes follow libpq**: new **Prefer** (SSL if the server supports it, otherwise plain) and
  **Verify CA** (chain only); **Require** with a CA file verifies the chain like libpq. URLs keep
  `sslmode=prefer` / `verify-ca` and MySQL `ssl-mode=PREFERRED` / `VERIFY_CA` instead of turning them into
  `require`.
- **Filtering and sorting a query result** refuses queries that change data (they would run again) and,
  on MySQL and H2, results with duplicate column names — with a message instead of a server error.
- **SQL INSERT export for MySQL** writes strings that contain `\` as `_utf8mb4 X'…'`, which means the same
  with and without `NO_BACKSLASH_ESCAPES`.
- **H2 jar and file format are checked before opening**: each H2 jar opens only its own format
  (1.4 → format 1, 2.0–2.1 → 2, 2.2+ → 3; verified with 1.4.200, 2.1.214 and 2.3.232), and `.h2.db`
  PageStore files are explained, instead of a bare "Connection terminated unexpectedly".
- **NULL survives copy and paste inside the grid** (it was pasted back as an empty string). Text copied to
  other apps is unchanged.
- **SSH**: every `IdentityFile` (and the default `id_ed25519` / `id_ecdsa` / `id_rsa`) is tried in order;
  `Include` and the `%h %p %r %u %d` tokens are read; keyboard-interactive authentication answers password
  prompts and asks for one-time codes; the Windows OpenSSH agent pipe is used when `SSH_AUTH_SOCK` is not
  set; hosts that need `ProxyJump` / `ProxyCommand` are refused with a message instead of connecting
  directly.
- **known_hosts**: negated patterns (`!host`) are honoured, a key of another type is treated as new rather
  than changed, `@revoked` is refused, and `/etc/ssh/ssh_known_hosts` is read too.

### Tests

- `test/realdb.test.ts` runs against real servers when `BINDB_TEST_PG` / `BINDB_TEST_MYSQL` are set
  (`host:port`), and is skipped otherwise. `BINDB_TEST_MYSQL_CA` (the server's `ca.pem`) adds the SSL
  mode checks.
- `test/audit.test.ts`, `test-integration/security.test.js` and SSH authentication tests against an
  in-process SSH server.

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
