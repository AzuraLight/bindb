import * as vscode from 'vscode';
import type { ConnectionStore } from '../core/connections';
import type { SessionManager } from '../core/sessions';
import { drivers, type ConnectionConfig, type MetaTable } from '../drivers';

export type Node =
  | { kind: 'connection'; cfg: ConnectionConfig }
  | { kind: 'schema'; cfg: ConnectionConfig; schema: string; tables: MetaTable[] }
  | { kind: 'table'; cfg: ConnectionConfig; table: MetaTable }
  | { kind: 'column'; cfg: ConnectionConfig; table: MetaTable; column: MetaTable['columns'][number] }
  | { kind: 'message'; text: string; error?: boolean };

const DRIVER_ICON: Record<string, string> = {
  postgres: 'database',
  mysql: 'database',
  sqlite: 'file-binary',
  h2: 'database',
};

export class ExplorerProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
  ) {
    this.subs = [store.onDidChange(() => this.changed.fire(undefined)), sessions.onDidChange(() => this.changed.fire(undefined))];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'connection': {
        const open = this.sessions.isOpen(node.cfg.id);
        const item = new vscode.TreeItem(node.cfg.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `conn:${node.cfg.id}`;
        item.description = describe(node.cfg);
        item.contextValue = open ? 'connection-open' : 'connection';
        item.iconPath = new vscode.ThemeIcon(
          DRIVER_ICON[node.cfg.driver] ?? 'database',
          open ? new vscode.ThemeColor('charts.green') : undefined,
        );
        item.tooltip = `${drivers[node.cfg.driver].label}${node.cfg.readOnly ? ' (read-only)' : ''}`;
        return item;
      }
      case 'schema': {
        const item = new vscode.TreeItem(node.schema, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `schema:${node.cfg.id}:${node.schema}`;
        item.description = `${node.tables.length}`;
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'schema';
        return item;
      }
      case 'table': {
        const item = new vscode.TreeItem(node.table.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `table:${node.cfg.id}:${node.table.schema}.${node.table.name}`;
        item.iconPath = new vscode.ThemeIcon(node.table.kind === 'view' ? 'eye' : 'table');
        item.contextValue = 'table';
        item.command = { command: 'bindb.previewTable', title: 'Open Table Data', arguments: [node] };
        return item;
      }
      case 'column': {
        const item = new vscode.TreeItem(node.column.name, vscode.TreeItemCollapsibleState.None);
        item.description = node.column.type?.toLowerCase();
        item.iconPath = new vscode.ThemeIcon('symbol-field');
        item.contextValue = 'column';
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.error ? 'error' : 'info');
        item.tooltip = node.text;
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) return this.store.list().map((cfg) => ({ kind: 'connection', cfg }));
    switch (node.kind) {
      case 'connection': {
        let tables: MetaTable[];
        try {
          tables = await this.sessions.metadata(node.cfg);
        } catch (e) {
          return [{ kind: 'message', text: errorText(e), error: true }];
        }
        const bySchema = new Map<string, MetaTable[]>();
        for (const t of tables) bySchema.set(t.schema, [...(bySchema.get(t.schema) ?? []), t]);
        // 테이블이 한 스키마뿐이면 스키마 단계를 건너뛴다(SQLite 등).
        if (bySchema.size === 1) return tables.map((table) => ({ kind: 'table', cfg: node.cfg, table }));
        if (bySchema.size === 0) return [{ kind: 'message', text: 'No tables' }];
        const preferred = drivers[node.cfg.driver].defaultSchema(node.cfg)?.toLowerCase();
        return [...bySchema.entries()]
          .sort(([a], [b]) => (a.toLowerCase() === preferred ? -1 : b.toLowerCase() === preferred ? 1 : a.localeCompare(b)))
          .map(([schema, list]) => ({ kind: 'schema', cfg: node.cfg, schema, tables: list }));
      }
      case 'schema':
        return node.tables.map((table) => ({ kind: 'table', cfg: node.cfg, table }));
      case 'table':
        return node.table.columns.map((column) => ({ kind: 'column', cfg: node.cfg, table: node.table, column }));
      default:
        return [];
    }
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}

function describe(cfg: ConnectionConfig): string {
  if (cfg.file) return cfg.file.split(/[\\/]/).pop() ?? cfg.file;
  return [cfg.host ?? 'localhost', cfg.database].filter(Boolean).join('/');
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
