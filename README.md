# BindB — Database IDE

Schema-aware SQL editing and a fast result grid for **PostgreSQL**, **MySQL / MariaDB**, **SQLite** and **H2**, right inside VS Code.

> **Preview.** BindB is early. Expect rough edges, and please [report issues](https://github.com/AzuraLight/bindb/issues).

## Features

- **Database Explorer** — browse connections → schemas → tables and views → columns from the BindB activity bar. Click a table to open its data.
- **Run the statement at the cursor** — press `Cmd+Enter` (macOS) / `Ctrl+Enter`, or click `▶ Run` above any statement. Select text to run exactly that.
- **Fast result grid** — rows stream in page by page as you scroll, so large results open instantly. Copy cells with `Cmd/Ctrl+C`.
- **Completion that knows your schema** — table names after `FROM` / `JOIN`, columns of the tables and aliases used in the statement, `schema.` and `alias.` lookups, and the column list of `INSERT INTO t (…)`.
- **One connection per file** — a `-- @conn: <name>` comment at the top of a `.sql` file picks its connection. The status bar shows it; click to change.
- **Data Sources panel** — add, edit and remove connections in one place: General / Options / SSL tabs, **Test Connection** with the server version, URL paste, SSL (`require` / `verify`) for PostgreSQL and MySQL, and a connect timeout.
- **Result grid** — WHERE / ORDER BY bar, click-to-sort headers, export all rows to CSV / TSV / JSON / Markdown / SQL INSERT, Copy as, and editing table data with Preview / Submit / Revert.
- **Query History** — `Cmd/Ctrl+Alt+E` searches what you ran on each connection.
- **Read-only connections** — mark a connection read-only and statements that change data are refused.

## Getting started

1. Open the **BindB** view in the activity bar and choose **Add Connection**.
2. The **Data Sources** panel opens. Fill in host or file and credentials — or paste a connection URL — and click **Test Connection**. SSL and read-only are on the **SSL** and **Options** tabs. Passwords are saved in your OS keychain.
3. To change connections later, click the gear in the explorer title, or right-click a connection → **Edit Connection**.
4. Click the terminal icon next to the connection to open a query console, write SQL, and press `Cmd/Ctrl+Enter`.

## H2

H2 has no Node.js driver, so BindB talks to H2's built-in PostgreSQL protocol server. Two modes:

- **Running H2 server** — start H2 with `java -cp h2.jar org.h2.tools.Server -pg` (default port 5435) and connect to it.
- **Database file** — pick a `.mv.db` file and BindB starts the server for you. This needs `java` on your `PATH` and the path to an `h2-*.jar` in the `bindb.h2.jarPath` setting. BindB does not ship H2 itself.

## Settings

| Setting | Description |
|---|---|
| `bindb.connections` | Connection definitions. Edited by **Add Connection**; passwords are not stored here. |
| `bindb.h2.jarPath` | Path to `h2-*.jar`, used to open H2 database files. |
| `bindb.grid.pageSize` | Rows fetched per page in the result grid (default 500). |

## Known limitations

- SQLite databases are loaded into memory and written back after each change. Avoid editing the same file from another program while BindB has it open.
- H2 results are fetched in full rather than page by page, and running H2 queries cannot be cancelled.
- No SSH tunnels yet.

## Privacy

BindB connects only to the databases you configure. It sends no telemetry.

## AI agents (MCP)

Turn on **BindB: Enable MCP Server for AI Agents** to let AI agents read your schemas and run read-only
queries through a local MCP server (127.0.0.1 only, token required).

- **GitHub Copilot** (agent mode) finds it automatically.
- **Claude Code**: run **BindB: Connect Claude Code (MCP)**.
- **Codex**: run **BindB: Connect Codex (MCP)**.

Queries run in a read-only transaction that is always rolled back. Writing needs the
`bindb.ai.allowWrites` setting and your confirmation for every statement; read-only connections are never written.
**BindB: Copy Schema for AI Chat** copies a schema as Markdown for any other chat.

## Logos

Database logos come from [Simple Icons](https://simpleicons.org) (CC0). Each logo is a trademark of its owner.

## License

[MIT](LICENSE). Bundled open-source components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

```sh
npm install
npm run build      # or: npm run watch
npm test
npm run package    # regenerates notices and builds the .vsix
```

Press `F5` in VS Code to launch an Extension Development Host.
