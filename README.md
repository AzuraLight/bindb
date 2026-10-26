# BindB — Database IDE

Schema-aware SQL editing and a fast result grid for **PostgreSQL**, **MySQL / MariaDB**, **SQLite** and **H2**, right inside VS Code.

> **Preview.** BindB is early. Expect rough edges, and please [report issues](https://github.com/AzuraLight/bindb/issues).

## Features

- **Database Explorer** — browse connections → schemas → tables and views → columns from the BindB activity bar. Click a table to open its data.
- **Run the statement at the cursor** — press `Cmd+Enter` (macOS) / `Ctrl+Enter`, or click `▶ Run` above any statement. Select text to run exactly that.
- **Fast result grid** — rows stream in page by page as you scroll, so large results open instantly. Copy cells with `Cmd/Ctrl+C`.
- **Completion that knows your schema** — table names after `FROM` / `JOIN`, columns of the tables and aliases used in the statement, `schema.` and `alias.` lookups, and the column list of `INSERT INTO t (…)`.
- **One connection per file** — a `-- @conn: <name>` comment at the top of a `.sql` file picks its connection. The status bar shows it; click to change.
- **Read-only connections** — mark a connection read-only and statements that change data are refused.

## Getting started

1. Open the **BindB** view in the activity bar and choose **Add Connection**.
2. Pick the database type and fill in the details. Passwords are saved in your OS keychain.
3. Click the terminal icon next to the connection to open a query console, write SQL, and press `Cmd/Ctrl+Enter`.

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

- Result cells are read-only for now; editing data in the grid is planned.
- SQLite databases are loaded into memory and written back after each change. Avoid editing the same file from another program while BindB has it open.
- H2 results are fetched in full rather than page by page, and running H2 queries cannot be cancelled.
- No SSH tunnels yet.

## Privacy

BindB connects only to the databases you configure. It sends no telemetry.

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
