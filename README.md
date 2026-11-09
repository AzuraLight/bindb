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

H2 is a Java database, so BindB runs the H2 JDBC driver in a small Java process that starts when you connect and stops when the last H2 connection closes — the same design DataGrip uses. It talks to BindB over standard input/output and opens no network port.

- **Embedded** — pick a `.mv.db` file (or a 1.4 `.h2.db` file with an H2 1.4 jar).
- **Remote** — an H2 TCP server, `jdbc:h2:tcp://host:9092/db`.
- **URL only** — any H2 JDBC URL, including `jdbc:h2:mem:…`.

You need Java 11 or later (`JAVA_HOME` or `java` on `PATH`) and an `h2-*.jar` (Drivers → H2 → Download, or `bindb.h2.jarPath`). Each H2 jar opens only its own file format (1.4 → format 1, 2.0–2.1 → 2, 2.2+ → 3); BindB tells you which jar a file needs. BindB does not ship H2 or Java. Settings such as `AUTO_SERVER=TRUE` go in the data source's driver options.

## Settings

| Setting | Description |
|---|---|
| `bindb.connections` | Connection definitions. Edited by **Add Connection**; passwords are not stored here. |
| `bindb.h2.jarPath` | Path to the H2 driver `h2-*.jar`. |
| `bindb.grid.pageSize` | Rows fetched per page in the result grid (default 500). |

## Known limitations

- SQLite databases are loaded into memory and written back after each change. Avoid editing the same file from another program while BindB has it open.
- An embedded H2 file is locked while BindB has it open. To use it from your app at the same time, add `AUTO_SERVER=TRUE` to both.
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
