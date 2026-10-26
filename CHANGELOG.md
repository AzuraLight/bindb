# Changelog

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
