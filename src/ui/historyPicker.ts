import * as vscode from 'vscode';
import type { ConnectionStore } from '../core/connections';
import { searchEntries, type HistoryEntry, type HistoryStore } from '../core/history';
import type { ResultPanel } from './resultPanel';
import { boundConnection, pickConnection } from './binding';

/*
 * Query History(DataGrip: Browse Query History, Ctrl+Alt+E). 연결마다 실행한 문장을 찾아
 * 콘솔에 넣거나 바로 다시 실행한다.
 */
export async function showHistory(store: ConnectionStore, history: HistoryStore, results: ResultPanel, clear: boolean): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const bound = editor?.document.languageId === 'sql' ? boundConnection(editor.document, store) : undefined;
  const cfg = bound ?? (await pickConnection(store, clear ? 'Clear the history of which connection?' : 'History of which connection?'));
  if (!cfg) return;
  if (clear) {
    const ok = await vscode.window.showWarningMessage(`Clear the query history of ${cfg.name}?`, { modal: true }, 'Clear');
    if (ok === 'Clear') await history.clear(cfg.id);
    return;
  }
  const entries = await history.list(cfg.id);
  if (!entries.length) {
    vscode.window.showInformationMessage(`No query history for ${cfg.name} yet.`);
    return;
  }
  type Item = vscode.QuickPickItem & { entry: HistoryEntry };
  const run: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('play'), tooltip: 'Run again' };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = `Query History — ${cfg.name}`;
  qp.placeholder = 'Type to search. Enter inserts into the editor; ▶ runs it again.';
  qp.matchOnDescription = false;
  const render = (q: string) =>
    (qp.items = searchEntries(entries, q).map((entry) => ({
      label: entry.sql.replace(/\s+/g, ' ').slice(0, 200),
      description: [new Date(entry.at).toLocaleString(), entry.ms !== undefined ? `${entry.ms} ms` : '', entry.rows !== undefined ? `${entry.rows} rows` : '', entry.count ? `×${entry.count}` : '']
        .filter(Boolean)
        .join(' · '),
      detail: entry.error ? `$(error) ${entry.error}` : undefined,
      buttons: [run],
      alwaysShow: true,
      entry,
    })));
  render('');
  qp.onDidChangeValue(render);
  qp.onDidTriggerItemButton(async (e) => {
    qp.hide();
    await results.run(cfg, e.item.entry.sql);
  });
  qp.onDidAccept(async () => {
    const item = qp.selectedItems[0];
    qp.hide();
    if (!item) return;
    const target = vscode.window.activeTextEditor;
    if (target && target.document.languageId === 'sql') {
      await target.edit((b) => b.replace(target.selection, item.entry.sql));
    } else {
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `-- @conn: ${cfg.name}\n${item.entry.sql}\n` });
      await vscode.window.showTextDocument(doc);
    }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}
