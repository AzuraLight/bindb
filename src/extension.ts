import * as vscode from 'vscode';
import { ConnectionStore, workspaceKey } from './core/connections';
import { SessionManager } from './core/sessions';
import { drivers, type ConnectionConfig, type DriverId } from './drivers';
import { SqlCompletionProvider } from './language/completion';
import { splitStatements, statementAt } from './language/splitter';
import { ConnectionPanel, type Applied } from './ui/connectionPanel';
import { UnresolvedDiagnostics } from './ui/diagnostics';
import { SqlHoverProvider } from './ui/hover';
import { BindingStatus, boundConnection, boundSchema, pickConnection, setBinding, setSchemaBinding } from './ui/binding';
import { RunCodeLensProvider } from './ui/codelens';
import { errorText, ExplorerProvider, type Node } from './ui/explorer';
import { AiIntegration } from './ai/integration';
import { classifySql } from './core/classify';
import { stopAllH2Servers } from './drivers/h2';
import { killAllSqliteProcesses } from './drivers/sqlite';
import { HistoryStore } from './core/history';
import { showHistory } from './ui/historyPicker';
import { ident, kw, tableName, withCodeStyle } from './core/ddl';
import { selectList, tableKey } from './core/virtual';
import { registerVirtualCommands, VirtualStore } from './ui/virtualObjects';
import { DdlMapping } from './ui/ddlMapping';
import { ResultPanel } from './ui/resultPanel';

const SQL = { language: 'sql' };

/** 통합 테스트가 쓰는 내부 객체(공개 API가 아니다) */
export interface BindbTestApi {
  store: ConnectionStore;
  sessions: SessionManager;
  ddl: DdlMapping;
  ai: AiIntegration;
  results: ResultPanel;
  history: HistoryStore;
  panelTrace: () => string[];
}

export function activate(context: vscode.ExtensionContext): BindbTestApi {
  // 프로젝트 연결의 비밀 값은 작업 공간마다 따로 둔다(.code-workspace 파일 또는 첫 폴더)
  const store = new ConnectionStore(context.secrets, workspaceKey(vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri));
  const sessions = new SessionManager(store);
  const history = new HistoryStore(vscode.Uri.joinPath(context.globalStorageUri, 'history.json').fsPath);
  const results = new ResultPanel(context.extensionUri, sessions, history);
  const virtual = new VirtualStore(vscode.Uri.joinPath(context.globalStorageUri, 'virtual').fsPath);
  const explorer = new ExplorerProvider(store, sessions, context.extensionUri, virtual);
  const ddl = new DdlMapping(store, sessions);
  ConnectionPanel.driverDir = vscode.Uri.joinPath(context.globalStorageUri, 'drivers').fsPath;
  const ai = new AiIntegration(context, store, sessions);

  /** 트리 노드 또는 명령 팔레트에서 연결을 고른다 */
  const connectionOf = async (node: Node | undefined, placeHolder: string): Promise<ConnectionConfig | undefined> =>
    node && 'cfg' in node ? node.cfg : pickConnection(store, placeHolder);

  /** 파일에 묶인 연결. 없으면 고르게 하고 주석으로 묶는다. */
  const connectionFor = async (doc: vscode.TextDocument): Promise<ConnectionConfig | undefined> => {
    const bound = boundConnection(doc, store);
    if (bound) return bound;
    const cfg = await pickConnection(store, 'Run on which connection?');
    if (cfg) await setBinding(doc, cfg.name);
    return cfg;
  };

  /** 저장 결과 반영: 바뀌거나 지운 연결은 세션을 끊고, 새로 만들거나 바꾼 연결은 접속해 본다. */
  const onApplied = async ({ added, updated, removed }: Applied) => {
    for (const id of [...removed, ...updated.map((c) => c.id)]) await sessions.disconnect(id);
    for (const id of removed) await history.remove(id).catch(() => {});
    for (const cfg of [...added, ...updated]) {
      sessions.metadata(cfg).catch((e) => vscode.window.showWarningMessage(`Saved "${cfg.name}", but could not connect: ${errorText(e)}`));
    }
  };
  const showPanel = (target: { select?: string; addNew?: DriverId; pickDriver?: boolean; createDdlMapping?: boolean }) =>
    ConnectionPanel.show(context.extensionUri, store, target, (r) => void onApplied(r));

  const runStatement = async (uri?: vscode.Uri, offset?: number) => {
    const editor = vscode.window.activeTextEditor;
    const doc = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
    if (!doc) return;

    // 문장을 나누는 규칙(문자열 · 주석)은 DB마다 다르다 — 연결을 먼저 정한다
    const cfg = await connectionFor(doc);
    if (!cfg) return;
    let sql: string | undefined;
    const selection = editor?.document === doc && offset === undefined ? editor.selection : undefined;
    if (selection && !selection.isEmpty) {
      sql = doc.getText(selection).trim().replace(/;\s*$/, '');
    } else {
      const at = offset ?? (editor ? doc.offsetAt(editor.selection.active) : 0);
      sql = statementAt(splitStatements(doc.getText(), cfg.driver), at)?.text;
    }
    if (!sql) {
      vscode.window.showInformationMessage('No SQL statement at the cursor.');
      return;
    }
    await results.run(cfg, sql, contextOf(doc));
  };

  /** 콘솔 문서 → 실행 문맥(Dedicated sessions의 세션 구분, Switch schema) */
  const contextOf = (doc: vscode.TextDocument) => ({ client: doc.uri.toString(), schema: boundSchema(doc) });

  /** 지금 편집기의 SQL 문서와 그 연결 */
  const activeConsole = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'sql') return undefined;
    const cfg = boundConnection(doc, store);
    return cfg ? { doc, cfg } : undefined;
  };

  const endTransaction = async (how: 'COMMIT' | 'ROLLBACK') => {
    const c = activeConsole();
    if (!c) {
      vscode.window.showInformationMessage('Open a SQL console bound to a connection first.');
      return;
    }
    try {
      await sessions.endTransaction(c.cfg, how, contextOf(c.doc));
      vscode.window.setStatusBarMessage(`${c.cfg.name}: ${how === 'COMMIT' ? 'committed' : 'rolled back'}`, 3000);
    } catch (e) {
      vscode.window.showErrorMessage(errorText(e));
    }
  };

  context.subscriptions.push(
    store,
    sessions,
    virtual,
    ...registerVirtualCommands(store, sessions, virtual),
    // 가상 객체 파일을 손으로 고쳐 저장하면 탐색기를 새로 그린다
    vscode.workspace.onDidSaveTextDocument((doc) => {
      for (const c of store.list()) if (virtual.fileOf(c) === doc.uri.fsPath) virtual.notifyChanged(c.id);
    }),
    vscode.commands.registerCommand('bindb.virtual.openView', async (node?: { cfg: ConnectionConfig; view?: { sql: string } }) => {
      if (!node?.view) return;
      // 가상 뷰 파일은 저장소에서 올 수 있다 — 읽기 문장만 실행한다
      const c = classifySql(node.view.sql, node.cfg.driver);
      if (c.kind !== 'read') {
        vscode.window.showErrorMessage(`This virtual view was not run: its SQL is not a read-only query (${c.reason ?? c.kind}).`);
        return;
      }
      await results.run(node.cfg, node.view.sql);
    }),
    ai,
    results,
    explorer,
    new BindingStatus(store),
    vscode.window.registerTreeDataProvider('bindb.explorer', explorer),
    vscode.languages.registerCodeLensProvider(SQL, new RunCodeLensProvider(store)),
    vscode.languages.registerCompletionItemProvider(SQL, new SqlCompletionProvider(store, sessions, virtual), '.', ' '),
    new UnresolvedDiagnostics(store, sessions),
    vscode.languages.registerHoverProvider(SQL, new SqlHoverProvider(store, sessions)),

    vscode.commands.registerCommand('bindb.addConnection', () => showPanel({ pickDriver: true })),
    vscode.commands.registerCommand('bindb.manageConnections', () => showPanel({})),
    ...(Object.keys(drivers) as DriverId[]).map((d) =>
      vscode.commands.registerCommand(`bindb.add.${d}`, () => showPanel({ addNew: d })),
    ),

    vscode.commands.registerCommand('bindb.editConnection', async (node?: Node) => {
      const cfg = await connectionOf(node, 'Edit which connection?');
      if (cfg) showPanel({ select: cfg.id });
    }),

    vscode.commands.registerCommand('bindb.removeConnection', async (node?: Node) => {
      const cfg = await connectionOf(node, 'Remove which connection?');
      if (!cfg) return;
      const ok = await vscode.window.showWarningMessage(`Remove connection "${cfg.name}"?`, { modal: true }, 'Remove');
      if (ok !== 'Remove') return;
      await sessions.disconnect(cfg.id);
      await store.remove(cfg.id);
      await history.remove(cfg.id).catch(() => {});
    }),

    vscode.commands.registerCommand('bindb.refresh', async (node?: Node) => {
      const cfg = await connectionOf(node, 'Refresh which connection?');
      if (!cfg) return;
      await vscode.window.withProgress(
        { location: { viewId: 'bindb.explorer' }, title: `Refreshing ${cfg.name}` },
        () => sessions.metadata(cfg, true).catch((e) => vscode.window.showErrorMessage(errorText(e))),
      );
    }),

    // 탐색기 · Introspection Level: 데이터 소스의 Default level 또는 스키마 하나의 수준(DataGrip과 같다)
    vscode.commands.registerCommand('bindb.introspectionLevel', async (node?: Node) => {
      const cfg = node && 'cfg' in node ? store.get(node.cfg.id) : await pickConnection(store, 'Introspection level of which connection?');
      if (!cfg) return;
      const schema = node?.kind === 'schema' ? node.schema : undefined;
      const current = schema ? cfg.schemaLevels?.[schema] : cfg.introspectionLevel;
      const levels: { label: string; level?: 1 | 2 | 3; detail: string }[] = [
        { label: schema ? 'Inherit' : 'Auto', detail: schema ? 'Use the data source default' : 'By schema size, as DataGrip: current schema ≤ 1000 objects → 3, ≤ 3000 → 2, otherwise 1' },
        { label: 'Level 1', level: 1, detail: 'Names only (column types are not read)' },
        { label: 'Level 2', level: 2, detail: 'Everything except source code' },
        { label: 'Level 3', level: 3, detail: 'Everything' },
      ];
      const pick = await vscode.window.showQuickPick(
        levels.map((l) => ({ ...l, description: l.level === current ? 'current' : undefined })),
        { placeHolder: schema ? `Introspection level of ${schema}` : `Default introspection level of ${cfg.name}` },
      );
      if (!pick) return;
      const { id, ...rest } = cfg;
      if (schema) {
        const schemaLevels = { ...(cfg.schemaLevels ?? {}) };
        if (pick.level) schemaLevels[schema] = pick.level;
        else delete schemaLevels[schema];
        rest.schemaLevels = Object.keys(schemaLevels).length ? schemaLevels : undefined;
      } else {
        rest.introspectionLevel = pick.level;
      }
      const updated = await store.update(id, rest);
      // Auto sync처럼 바꾸면 바로 다시 읽는다
      await sessions.metadata(updated, true).catch((e) => vscode.window.showErrorMessage(errorText(e)));
    }),

    vscode.commands.registerCommand('bindb.disconnect', async (node?: Node) => {
      const cfg = await connectionOf(node, 'Disconnect which connection?');
      if (cfg) await sessions.disconnect(cfg.id);
    }),

    vscode.commands.registerCommand('bindb.openConsole', async (node?: Node) => {
      const cfg = await connectionOf(node, 'Open a console for which connection?');
      if (!cfg) return;
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `-- @conn: ${cfg.name}\n\n` });
      const editor = await vscode.window.showTextDocument(doc);
      const end = doc.lineAt(doc.lineCount - 1).range.end;
      editor.selection = new vscode.Selection(end, end);
    }),

    vscode.commands.registerCommand('bindb.selectConnection', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || doc.languageId !== 'sql') return;
      const cfg = await pickConnection(store, 'Connection for this file');
      if (cfg) await setBinding(doc, cfg.name);
    }),

    vscode.commands.registerCommand('bindb.runStatement', runStatement),
    vscode.commands.registerCommand('bindb.queryHistory', () => showHistory(store, history, results, false)),
    vscode.commands.registerCommand('bindb.clearHistory', () => showHistory(store, history, results, true)),
    vscode.commands.registerCommand('bindb.runAll', async (uri?: vscode.Uri) => {
      const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
      if (!doc) return;
      const cfg = await connectionFor(doc);
      if (!cfg) return;
      const statements = splitStatements(doc.getText(), cfg.driver).map((s) => s.text).filter((t) => t.trim());
      if (!statements.length) {
        vscode.window.showInformationMessage('No SQL statements in this file.');
        return;
      }
      const ctx = contextOf(doc);
      // 마지막 문장 앞까지는 실행만, 마지막 문장은 결과 그리드로
      const done = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Running ${statements.length} statement(s) on ${cfg.name}`, cancellable: true },
        async (progress, token) => {
          for (let i = 0; i < statements.length - 1; i++) {
            if (token.isCancellationRequested) return i;
            progress.report({ message: `${i + 1}/${statements.length}`, increment: 100 / statements.length });
            try {
              await (await sessions.execute(cfg, statements[i], ctx)).close();
            } catch (e) {
              vscode.window.showErrorMessage(`Statement ${i + 1} of ${statements.length} failed: ${errorText(e)}`);
              return i;
            }
          }
          return statements.length - 1;
        },
      );
      if (done === statements.length - 1) await results.run(cfg, statements[done], ctx);
    }),
    vscode.commands.registerCommand('bindb.ddl.create', (node?: Node) => node && 'cfg' in node && showPanel({ select: node.cfg.id, createDdlMapping: true })),
    vscode.commands.registerCommand('bindb.ddl.dump', (node?: Node) => node && 'cfg' in node && ddl.dump(node.cfg).catch((e) => vscode.window.showErrorMessage(errorText(e)))),
    vscode.commands.registerCommand('bindb.ddl.update', (node?: Node) => node && 'cfg' in node && ddl.update(node.cfg).catch((e) => vscode.window.showErrorMessage(errorText(e)))),
    vscode.commands.registerCommand('bindb.ddl.apply', (node?: Node) => node && 'cfg' in node && ddl.apply(node.cfg).catch((e) => vscode.window.showErrorMessage(errorText(e)))),
    vscode.commands.registerCommand('bindb.commit', () => endTransaction('COMMIT')),
    vscode.commands.registerCommand('bindb.rollback', () => endTransaction('ROLLBACK')),
    vscode.commands.registerCommand('bindb.switchSchema', async () => {
      const c = activeConsole();
      if (!c) {
        vscode.window.showInformationMessage('Open a SQL console bound to a connection first.');
        return;
      }
      try {
        const tables = await sessions.metadata(c.cfg);
        const schemas = [...new Set(tables.map((t) => t.schema))].sort();
        const picked = await vscode.window.showQuickPick(schemas, { placeHolder: `Schema for this console (${c.cfg.name})` });
        if (!picked) return;
        await sessions.switchSchema(c.cfg, picked, contextOf(c.doc));
        await setSchemaBinding(c.doc, picked);
      } catch (e) {
        vscode.window.showErrorMessage(errorText(e));
      }
    }),
    vscode.commands.registerCommand('bindb.cancelQuery', () => results.cancel()),

    vscode.commands.registerCommand('bindb.previewTable', async (node?: Node) => {
      if (node?.kind !== 'table') return;
      const { cfg, table } = node;
      // 테이블 데이터: 편집 · WHERE/ORDER BY가 테이블에 바로 붙는다. 가상 컬럼도 함께 계산한다
      const v = await virtual.get(cfg).catch(() => undefined);
      let list = withCodeStyle(cfg.codeStyle, () => (v ? selectList(v, tableKey(table.schema, table.name), (s) => ident(cfg.driver, s)) : '*'));
      // 가상 컬럼 식도 파일에서 온다 — 읽기가 아니면 가상 컬럼 없이 연다
      if (list !== '*' && classifySql(`SELECT ${list} FROM t`, cfg.driver).kind !== 'read') {
        vscode.window.showWarningMessage('Virtual columns were left out: an expression is not read-only.');
        list = '*';
      }
      await results.openTable(cfg, table, { database: node.database }, list);
    }),
  );
  return { store, sessions, ddl, ai, results, history, panelTrace: () => [...ConnectionPanel.trace] };
}

export function deactivate(): void {
  stopAllH2Servers();
  killAllSqliteProcesses();
}
