import * as vscode from 'vscode';
import { addConnectionWizard } from './connectionWizard';
import { ConnectionStore } from './core/connections';
import { SessionManager } from './core/sessions';
import { drivers, type ConnectionConfig } from './drivers';
import { SqlCompletionProvider } from './language/completion';
import { splitStatements, statementAt } from './language/splitter';
import { BindingStatus, boundConnection, pickConnection, setBinding } from './ui/binding';
import { RunCodeLensProvider } from './ui/codelens';
import { errorText, ExplorerProvider, type Node } from './ui/explorer';
import { ResultPanel } from './ui/resultPanel';

const SQL = { language: 'sql' };

export function activate(context: vscode.ExtensionContext): void {
  const store = new ConnectionStore(context.secrets);
  const sessions = new SessionManager(store);
  const results = new ResultPanel(context.extensionUri, sessions);
  const explorer = new ExplorerProvider(store, sessions);

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

  const runStatement = async (uri?: vscode.Uri, offset?: number) => {
    const editor = vscode.window.activeTextEditor;
    const doc = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
    if (!doc) return;

    let sql: string | undefined;
    const selection = editor?.document === doc && offset === undefined ? editor.selection : undefined;
    if (selection && !selection.isEmpty) {
      sql = doc.getText(selection).trim().replace(/;\s*$/, '');
    } else {
      const at = offset ?? (editor ? doc.offsetAt(editor.selection.active) : 0);
      sql = statementAt(splitStatements(doc.getText()), at)?.text;
    }
    if (!sql) {
      vscode.window.showInformationMessage('No SQL statement at the cursor.');
      return;
    }
    const cfg = await connectionFor(doc);
    if (cfg) await results.run(cfg, sql);
  };

  context.subscriptions.push(
    store,
    sessions,
    results,
    explorer,
    new BindingStatus(store),
    vscode.window.registerTreeDataProvider('bindb.explorer', explorer),
    vscode.languages.registerCodeLensProvider(SQL, new RunCodeLensProvider()),
    vscode.languages.registerCompletionItemProvider(SQL, new SqlCompletionProvider(store, sessions), '.'),

    vscode.commands.registerCommand('bindb.addConnection', async () => {
      const cfg = await addConnectionWizard(store);
      if (!cfg) return;
      try {
        await sessions.metadata(cfg);
        vscode.window.showInformationMessage(`Connected to ${cfg.name}.`);
      } catch (e) {
        vscode.window.showWarningMessage(`Saved "${cfg.name}", but could not connect: ${errorText(e)}`);
      }
    }),

    vscode.commands.registerCommand('bindb.removeConnection', async (node?: Node) => {
      const cfg = await connectionOf(node, 'Remove which connection?');
      if (!cfg) return;
      const ok = await vscode.window.showWarningMessage(`Remove connection "${cfg.name}"?`, { modal: true }, 'Remove');
      if (ok !== 'Remove') return;
      await sessions.disconnect(cfg.id);
      await store.remove(cfg.id);
    }),

    vscode.commands.registerCommand('bindb.refresh', async (node?: Node) => {
      const cfg = await connectionOf(node, 'Refresh which connection?');
      if (!cfg) return;
      await vscode.window.withProgress(
        { location: { viewId: 'bindb.explorer' }, title: `Refreshing ${cfg.name}` },
        () => sessions.metadata(cfg, true).catch((e) => vscode.window.showErrorMessage(errorText(e))),
      );
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
    vscode.commands.registerCommand('bindb.cancelQuery', () => results.cancel()),

    vscode.commands.registerCommand('bindb.previewTable', async (node?: Node) => {
      if (node?.kind !== 'table') return;
      const { cfg, table } = node;
      const q = drivers[cfg.driver].quote;
      const ident = (s: string) => q + s.split(q).join(q + q) + q;
      const target = cfg.driver === 'sqlite' ? ident(table.name) : `${ident(table.schema)}.${ident(table.name)}`;
      await results.run(cfg, `SELECT * FROM ${target}`);
    }),
  );
}

export function deactivate(): void {}
