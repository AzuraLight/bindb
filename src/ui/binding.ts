import * as vscode from 'vscode';
import type { ConnectionStore } from '../core/connections';
import type { ConnectionConfig } from '../drivers';

/** `.sql` 파일 맨 위 몇 줄 안의 `-- @conn: <이름>` 주석으로 연결을 정한다. */
const BINDING = /^\s*--\s*@conn:\s*(.+?)\s*$/;
const SCAN_LINES = 5;

function bindingLine(doc: vscode.TextDocument): { line: number; name: string } | undefined {
  for (let i = 0; i < Math.min(SCAN_LINES, doc.lineCount); i++) {
    const m = BINDING.exec(doc.lineAt(i).text);
    if (m) return { line: i, name: m[1] };
  }
  return undefined;
}

export function boundConnection(doc: vscode.TextDocument, store: ConnectionStore): ConnectionConfig | undefined {
  const b = bindingLine(doc);
  return b ? store.findByName(b.name) : undefined;
}

export function bindingName(doc: vscode.TextDocument): string | undefined {
  return bindingLine(doc)?.name;
}

export async function setBinding(doc: vscode.TextDocument, name: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  const existing = bindingLine(doc);
  const text = `-- @conn: ${name}`;
  if (existing) edit.replace(doc.uri, doc.lineAt(existing.line).range, text);
  else edit.insert(doc.uri, new vscode.Position(0, 0), `${text}\n`);
  await vscode.workspace.applyEdit(edit);
}

export async function pickConnection(store: ConnectionStore, placeHolder: string): Promise<ConnectionConfig | undefined> {
  const list = store.list();
  if (list.length === 0) {
    const add = 'Add Connection';
    if ((await vscode.window.showInformationMessage('No BindB connections yet.', add)) === add) {
      await vscode.commands.executeCommand('bindb.addConnection');
    }
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    list.map((c) => ({ label: c.name, description: c.driver, cfg: c })),
    { placeHolder },
  );
  return picked?.cfg;
}

/** 상태 표시줄: 현재 SQL 파일에 묶인 연결 */
export class BindingStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly subs: vscode.Disposable[];

  constructor(private readonly store: ConnectionStore) {
    this.item.command = 'bindb.selectConnection';
    this.subs = [
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) this.update();
      }),
      store.onDidChange(() => this.update()),
    ];
    this.update();
  }

  private update(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'sql') {
      this.item.hide();
      return;
    }
    const name = bindingName(doc);
    const cfg = boundConnection(doc, this.store);
    if (cfg) {
      this.item.text = `$(database) ${cfg.name}`;
      this.item.tooltip = 'BindB: connection for this file (click to change)';
      this.item.backgroundColor = undefined;
    } else {
      this.item.text = name ? `$(warning) ${name}` : '$(database) Select connection';
      this.item.tooltip = name ? `BindB: no connection named "${name}"` : 'BindB: choose a connection for this file';
      this.item.backgroundColor = name ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    }
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
    this.subs.forEach((s) => s.dispose());
  }
}
