import * as vscode from 'vscode';
import { objectVisible, parseObjectFilter, schemaVisible } from '../core/connectionDraft';
import type { ConnectionStore } from '../core/connections';
import type { SessionManager } from '../core/sessions';
import { drivers, type ConnectionConfig, type MetaTable } from '../drivers';
import { tableKey, type VirtualColumn, type VirtualForeignKey, type VirtualView } from '../core/virtual';
import type { VirtualStore } from './virtualObjects';
import { DRIVER_LOGOS } from '../shared/driverLogos';

export type Node =
  | { kind: 'connection'; cfg: ConnectionConfig }
  /** postgres에서 Single database mode를 끄면 서버의 데이터베이스들이 보인다 */
  | { kind: 'database'; cfg: ConnectionConfig; database: string }
  | { kind: 'schema'; cfg: ConnectionConfig; schema: string; tables: MetaTable[]; database?: string }
  | { kind: 'table'; cfg: ConnectionConfig; table: MetaTable; database?: string }
  | { kind: 'column'; cfg: ConnectionConfig; table: MetaTable; column: MetaTable['columns'][number] }
  | { kind: 'message'; text: string; error?: boolean }
  /** 가상 객체(Virtual objects and attributes). virtualKind · index는 지우기 명령이 쓴다 */
  | { kind: 'virtual'; cfg: ConnectionConfig; virtualKind: 'view'; index: number; view: VirtualView }
  | { kind: 'virtual'; cfg: ConnectionConfig; virtualKind: 'fk'; index: number; fk: VirtualForeignKey; table: string }
  | { kind: 'virtual'; cfg: ConnectionConfig; virtualKind: 'column'; index: number; column: VirtualColumn };

export class ExplorerProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly extensionUri: vscode.Uri,
    private readonly virtual: VirtualStore,
  ) {
    this.subs = [
      store.onDidChange(() => this.changed.fire(undefined)),
      sessions.onDidChange(() => this.changed.fire(undefined)),
      virtual.onDidChange(() => this.changed.fire(undefined)),
    ];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'connection': {
        const open = this.sessions.isOpen(node.cfg.id);
        const item = new vscode.TreeItem(node.cfg.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `conn:${node.cfg.id}`;
        item.description = describe(node.cfg);
        // 메뉴 조건: connection(-open) + DDL Mapping 여부 / DDL data source는 ddlsource
        item.contextValue =
          node.cfg.kind === 'ddl' ? 'ddlsource' : `${open ? 'connection-open' : 'connection'}${node.cfg.ddlMapping ? ' mapped' : ''}`;
        // 드라이버 로고(Simple Icons). 연결 중이면 설명에 표시를 붙인다
        item.iconPath =
          node.cfg.kind === 'ddl'
            ? new vscode.ThemeIcon('file-code')
            : node.cfg.color
              ? colored(node.cfg.driver, node.cfg.color)
              : vscode.Uri.joinPath(this.extensionUri, 'media', 'drivers', `${node.cfg.driver}.svg`);
        if (open) item.description = `● ${item.description}`;
        item.tooltip = [
          `${drivers[node.cfg.driver].label}${node.cfg.readOnly ? ' (read-only)' : ''}${node.cfg.scope === 'project' ? ' · project' : ''}`,
          node.cfg.comment,
        ]
          .filter(Boolean)
          .join('\n');
        return item;
      }
      case 'database': {
        const item = new vscode.TreeItem(node.database, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `db:${node.cfg.id}:${node.database}`;
        item.iconPath = new vscode.ThemeIcon('database');
        item.contextValue = 'database';
        if (node.database === node.cfg.database) item.description = 'default';
        return item;
      }
      case 'schema': {
        const item = new vscode.TreeItem(node.schema, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `schema:${node.cfg.id}:${node.database ?? ''}:${node.schema}`;
        // 객체 수 · 읽은 수준(Introspection Level). 1단계면 열 타입이 없다
        const level = node.tables[0]?.level;
        item.description = level ? `${node.tables.length} · L${level}` : `${node.tables.length}`;
        item.tooltip = level ? `Introspection level ${level}${node.cfg.schemaLevels?.[node.schema] ? ' (set for this schema)' : node.cfg.introspectionLevel ? '' : ' (auto)'}` : undefined;
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'schema';
        return item;
      }
      case 'table': {
        const item = new vscode.TreeItem(node.table.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `table:${node.cfg.id}:${node.database ?? ''}:${node.table.schema}.${node.table.name}`;
        item.iconPath = new vscode.ThemeIcon(node.table.kind === 'view' ? 'eye' : 'table');
        item.contextValue = 'table';
        item.command = { command: 'bindb.previewTable', title: 'Open Table Data', arguments: [node] };
        if (node.table.definition) {
          // Load sources for: 뷰 정의를 툴팁으로
          const md = new vscode.MarkdownString();
          md.appendCodeblock(node.table.definition.trim(), 'sql');
          item.tooltip = md;
        }
        return item;
      }
      case 'column': {
        const item = new vscode.TreeItem(node.column.name, vscode.TreeItemCollapsibleState.None);
        item.description = node.column.type?.toLowerCase();
        item.iconPath = new vscode.ThemeIcon('symbol-field');
        item.contextValue = 'column';
        return item;
      }
      case 'virtual': {
        if (node.virtualKind === 'view') {
          const item = new vscode.TreeItem(node.view.name, vscode.TreeItemCollapsibleState.None);
          item.description = 'virtual view';
          item.iconPath = new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.purple'));
          item.tooltip = new vscode.MarkdownString().appendCodeblock(node.view.sql, 'sql');
          item.command = { command: 'bindb.virtual.openView', title: 'Open Virtual View', arguments: [node] };
          item.contextValue = 'virtual';
          return item;
        }
        if (node.virtualKind === 'fk') {
          const out = node.fk.table.toLowerCase() === node.table.toLowerCase();
          const label = out
            ? `${node.fk.columns.join(', ')} → ${node.fk.refTable}(${node.fk.refColumns.join(', ')})`
            : `${node.fk.table}(${node.fk.columns.join(', ')}) → ${node.fk.refColumns.join(', ')}`;
          const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
          item.description = 'virtual foreign key';
          item.iconPath = new vscode.ThemeIcon('references', new vscode.ThemeColor('charts.purple'));
          item.contextValue = 'virtual';
          return item;
        }
        const item = new vscode.TreeItem(node.column.name, vscode.TreeItemCollapsibleState.None);
        item.description = `virtual = ${node.column.expression}`;
        item.iconPath = new vscode.ThemeIcon('symbol-field', new vscode.ThemeColor('charts.purple'));
        item.contextValue = 'virtual';
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
    try {
      switch (node.kind) {
        case 'connection': {
          // Single database mode를 끈 postgres: 서버의 데이터베이스부터
          if (node.cfg.kind !== 'ddl' && node.cfg.driver === 'postgres' && !node.cfg.singleDatabase && node.cfg.connectionType !== 'url') {
            const dbs = await this.sessions.databases(node.cfg);
            if (dbs.length > 1) return dbs.map((database) => ({ kind: 'database', cfg: node.cfg, database }));
          }
          return this.schemasOf(node.cfg, await this.sessions.metadata(node.cfg));
        }
        case 'database': {
          const own = node.database === node.cfg.database;
          const tables = await this.sessions.metadata(node.cfg, false, own ? undefined : node.database);
          return this.schemasOf(node.cfg, tables, own ? undefined : node.database);
        }
        case 'schema':
          return [
            ...node.tables.map((table): Node => ({ kind: 'table', cfg: node.cfg, table, database: node.database })),
            ...(await this.virtualViews(node.cfg, node.schema)),
          ];
        case 'table': {
          const v = await this.virtual.get(node.cfg);
          const key = tableKey(node.table.schema, node.table.name);
          const same = (a: string) => a.toLowerCase() === key.toLowerCase();
          return [
            ...node.table.columns.map((column): Node => ({ kind: 'column', cfg: node.cfg, table: node.table, column })),
            ...v.columns.flatMap((column, index): Node[] => (same(column.table) ? [{ kind: 'virtual', cfg: node.cfg, virtualKind: 'column', index, column }] : [])),
            ...v.foreignKeys.flatMap((fk, index): Node[] =>
              same(fk.table) || same(fk.refTable) ? [{ kind: 'virtual', cfg: node.cfg, virtualKind: 'fk', index, fk, table: key }] : [],
            ),
          ];
        }
        default:
          return [];
      }
    } catch (e) {
      return [{ kind: 'message', text: errorText(e), error: true }];
    }
  }

  /** Schemas 탭의 Schema pattern · Object filter를 적용해 스키마 노드로 묶는다 */
  private async virtualViews(cfg: ConnectionConfig, schema: string): Promise<Node[]> {
    const v = await this.virtual.get(cfg).catch(() => undefined);
    return (v?.views ?? []).flatMap((view, index): Node[] =>
      view.schema.toLowerCase() === schema.toLowerCase() ? [{ kind: 'virtual', cfg, virtualKind: 'view', index, view }] : [],
    );
  }

  private async schemasOf(cfg: ConnectionConfig, tables: MetaTable[], database?: string): Promise<Node[]> {
    const rules = parseObjectFilter(cfg.objectFilter ?? '');
    const current = drivers[cfg.driver].defaultSchema(cfg);
    const visible = tables.filter(
      (t) =>
        schemaVisible(cfg.schemaPattern ?? '', { database: database ?? cfg.database, currentSchema: current }, t.schema) &&
        objectVisible(rules, t.kind, t.name),
    );
    const bySchema = new Map<string, MetaTable[]>();
    for (const t of visible) bySchema.set(t.schema, [...(bySchema.get(t.schema) ?? []), t]);
    // 테이블이 한 스키마뿐이면 스키마 단계를 건너뛴다(SQLite 등).
    if (bySchema.size === 1) {
      // 테이블이 한 스키마뿐이면 스키마 단계를 건너뛴다(SQLite 등) — 가상 뷰도 여기에
      const only = [...bySchema.keys()][0];
      return [...visible.map((table): Node => ({ kind: 'table', cfg, table, database })), ...(await this.virtualViews(cfg, only))];
    }
    if (bySchema.size === 0) return [{ kind: 'message', text: tables.length ? 'No objects match the schema pattern or object filter' : 'No tables' }];
    const preferred = current?.toLowerCase();
    return [...bySchema.entries()]
      .sort(([a], [b]) => (a.toLowerCase() === preferred ? -1 : b.toLowerCase() === preferred ? 1 : a.localeCompare(b)))
      .map(([schema, list]) => ({ kind: 'schema', cfg, schema, tables: list, database }));
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}

/** 데이터 소스 색: 로고 아이콘 오른쪽 아래에 색 점을 붙인 SVG */
function colored(driver: ConnectionConfig['driver'], color: string): vscode.Uri {
  const logo = DRIVER_LOGOS[driver];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="${logo.hex}"/>` +
    `<g transform="translate(2.5 2.5) scale(0.4583)"><path fill="#fff" d="${logo.path}"/></g>` +
    `<circle cx="12.5" cy="12.5" r="3.5" fill="${color}" stroke="#fff" stroke-width="1"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function describe(cfg: ConnectionConfig): string {
  if (cfg.kind === 'ddl') return `DDL · ${cfg.ddlFolder ?? ''}`;
  if (cfg.connectionType === 'url' && cfg.url) return cfg.url.replace(/^jdbc:/, '');
  if (cfg.file) return cfg.file.split(/[\\/]/).pop() ?? cfg.file;
  return [cfg.host ?? 'localhost', cfg.database].filter(Boolean).join('/');
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
