import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ConnectionStore } from '../core/connections';
import type { SessionManager } from '../core/sessions';
import { loadVirtual, saveVirtual, tableKey, type VirtualObjects } from '../core/virtual';
import type { ConnectionConfig, MetaTable } from '../drivers';

/** 데이터 소스별 가상 객체 파일(Options · Virtual objects and attributes). 없으면 확장 저장소의 external-data-<id>.json */
export class VirtualStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<string>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly defaultDir: string) {}

  fileOf(cfg: ConnectionConfig): string {
    return cfg.virtualObjectsFile || path.join(this.defaultDir, `external-data-${cfg.id}.json`);
  }

  /** 매번 파일을 읽는다(손으로 고친 내용을 덮어쓰지 않게). 파일은 작다 */
  get(cfg: ConnectionConfig): Promise<VirtualObjects> {
    return loadVirtual(this.fileOf(cfg));
  }

  async update(cfg: ConnectionConfig, fn: (v: VirtualObjects) => void): Promise<void> {
    const v = await this.get(cfg);
    fn(v);
    await saveVirtual(this.fileOf(cfg), v);
    this.changed.fire(cfg.id);
  }

  /** 파일이 바뀌면(손으로 고쳐 저장) 탐색기를 새로 그린다 */
  notifyChanged(cfgId: string): void {
    this.changed.fire(cfgId);
  }

  dispose(): void {
    this.changed.dispose();
  }
}

type TableNode = { cfg: ConnectionConfig; table: MetaTable };

/** 가상 객체 명령 */
export function registerVirtualCommands(store: ConnectionStore, sessions: SessionManager, virtual: VirtualStore): vscode.Disposable[] {
  const pickColumn = (t: MetaTable, placeHolder: string) =>
    vscode.window.showQuickPick(t.columns.map((c) => c.name), { placeHolder, canPickMany: true });

  return [
    vscode.commands.registerCommand('bindb.virtual.addForeignKey', async (node?: TableNode) => {
      if (!node?.table) return;
      const cols = await pickColumn(node.table, `Columns of ${node.table.name} that reference another table`);
      if (!cols?.length) return;
      const tables = (await sessions.metadata(node.cfg)).filter((t) => t.kind === 'table');
      const ref = await vscode.window.showQuickPick(
        tables.map((t) => ({ label: t.name, description: t.schema, t })),
        { placeHolder: 'Referenced table' },
      );
      if (!ref) return;
      const refCols: string[] = [];
      for (const c of cols) {
        const r = await vscode.window.showQuickPick(ref.t.columns.map((x) => x.name), { placeHolder: `${node.table.name}.${c} references ${ref.t.name}.…` });
        if (!r) return;
        refCols.push(r);
      }
      await virtual.update(node.cfg, (v) =>
        v.foreignKeys.push({ table: tableKey(node.table.schema, node.table.name), columns: cols, refTable: tableKey(ref.t.schema, ref.t.name), refColumns: refCols }),
      );
    }),
    vscode.commands.registerCommand('bindb.virtual.addColumn', async (node?: TableNode) => {
      if (!node?.table) return;
      const name = await vscode.window.showInputBox({ prompt: `Virtual column name on ${node.table.name}` });
      if (!name) return;
      const expression = await vscode.window.showInputBox({ prompt: `SQL expression for ${name}`, placeHolder: 'e.g. price * quantity' });
      if (!expression) return;
      await virtual.update(node.cfg, (v) => v.columns.push({ table: tableKey(node.table.schema, node.table.name), name, expression }));
    }),
    vscode.commands.registerCommand('bindb.virtual.addView', async (node?: { cfg: ConnectionConfig; schema?: string }) => {
      const cfg = node?.cfg;
      if (!cfg) return;
      const editor = vscode.window.activeTextEditor;
      const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).trim() : '';
      const name = await vscode.window.showInputBox({ prompt: 'Virtual view name' });
      if (!name) return;
      const sql = selected || (await vscode.window.showInputBox({ prompt: `SQL for ${name}`, placeHolder: 'SELECT …' }));
      if (!sql) return;
      const schema = node?.schema ?? (await sessions.metadata(cfg))[0]?.schema ?? 'main';
      await virtual.update(cfg, (v) => v.views.push({ schema, name, sql }));
    }),
    vscode.commands.registerCommand('bindb.virtual.remove', async (node?: { cfg: ConnectionConfig; virtualKind: 'fk' | 'view' | 'column'; index: number }) => {
      if (!node) return;
      const ok = await vscode.window.showWarningMessage('Remove this virtual object?', { modal: true }, 'Remove');
      if (ok !== 'Remove') return;
      await virtual.update(node.cfg, (v) => {
        const list = node.virtualKind === 'fk' ? v.foreignKeys : node.virtualKind === 'view' ? v.views : v.columns;
        list.splice(node.index, 1);
      });
    }),
    vscode.commands.registerCommand('bindb.virtual.openFile', async (node?: { cfg: ConnectionConfig }) => {
      const cfg = node?.cfg;
      if (!cfg) return;
      const file = virtual.fileOf(cfg);
      await virtual.update(cfg, () => {}); // 파일이 없으면 빈 파일을 만든다
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    }),
  ];
}
