import * as vscode from 'vscode';
import type { ConnectionStore } from '../core/connections';
import type { SessionManager } from '../core/sessions';
import { drivers, type ConnectionConfig, type DriverId, type MetaTable } from '../drivers';
import { boundConnection } from '../ui/binding';
import { completionContext, RESERVED, type TableRef } from './context';
import { splitStatements, statementAt } from './splitter';

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'USING',
  'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'AS', 'ASC', 'DESC',
  'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'RETURNING', 'WITH',
  'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'CREATE INDEX', 'CREATE VIEW', 'TRUNCATE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'EXPLAIN',
];
const FUNCTIONS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CAST', 'LOWER', 'UPPER', 'LENGTH', 'TRIM', 'NOW', 'CURRENT_TIMESTAMP'];

/** 따옴표 없이 쓸 수 있는 식별자인가 — 드라이버의 대소문자 접기 규칙에 따른다 */
const PLAIN: Record<DriverId, RegExp> = {
  postgres: /^[a-z_][a-z0-9_$]*$/,
  h2: /^[A-Z_][A-Z0-9_]*$/,
  mysql: /^[A-Za-z_][A-Za-z0-9_$]*$/,
  sqlite: /^[A-Za-z_][A-Za-z0-9_]*$/,
};

function quoteIdent(driver: DriverId, name: string): string {
  if (PLAIN[driver].test(name) && !RESERVED.has(name.toUpperCase())) return name;
  const q = drivers[driver].quote;
  return q + name.split(q).join(q + q) + q;
}

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

function resolveRef(ref: TableRef, tables: MetaTable[], defaultSchema: string | undefined): MetaTable | undefined {
  const candidates = tables.filter((t) => same(t.name, ref.name) && (!ref.schema || same(t.schema, ref.schema)));
  return candidates.find((t) => same(t.schema, defaultSchema)) ?? candidates[0];
}

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
  ) {}

  async provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
    const offset = doc.offsetAt(position);
    const ctx = completionContext(statementAt(splitStatements(doc.getText()), offset), offset);
    if (ctx.kind === 'none') return [];

    const cfg = boundConnection(doc, this.store);
    const tables = cfg ? await this.tables(cfg) : [];
    const driver = cfg?.driver ?? 'postgres';
    const defaultSchema = cfg ? drivers[cfg.driver].defaultSchema(cfg) : undefined;
    const items: vscode.CompletionItem[] = [];

    if (ctx.kind === 'table') {
      const inSchema = ctx.qualifier ? tables.filter((t) => same(t.schema, ctx.qualifier)) : tables;
      for (const t of inSchema) items.push(this.tableItem(t, driver, !ctx.qualifier && !same(t.schema, defaultSchema)));
      if (!ctx.qualifier) {
        for (const schema of new Set(tables.map((t) => t.schema))) {
          const item = new vscode.CompletionItem(schema, vscode.CompletionItemKind.Module);
          item.insertText = quoteIdent(driver, schema);
          item.detail = 'schema';
          item.sortText = `2${schema}`;
          items.push(item);
        }
      }
    }

    if (ctx.kind === 'column') {
      if (ctx.qualifier) {
        const ref = ctx.refs.find((r) => same(r.alias, ctx.qualifier)) ?? ctx.refs.find((r) => !r.alias && same(r.name, ctx.qualifier));
        const table = ref ? resolveRef(ref, tables, defaultSchema) : resolveRef({ name: ctx.qualifier }, tables, defaultSchema);
        if (table) {
          for (const c of table.columns) items.push(this.columnItem(c, table, driver));
        } else {
          // `schema.` 로 쓴 경우
          for (const t of tables.filter((t) => same(t.schema, ctx.qualifier))) items.push(this.tableItem(t, driver, false));
        }
        return items;
      }
      for (const ref of ctx.refs) {
        const table = resolveRef(ref, tables, defaultSchema);
        if (!table) continue;
        if (ref.alias) {
          const alias = new vscode.CompletionItem(ref.alias, vscode.CompletionItemKind.Variable);
          alias.detail = `alias of ${table.name}`;
          alias.sortText = `1${ref.alias}`;
          items.push(alias);
        }
        for (const c of table.columns) items.push(this.columnItem(c, table, driver, ref.alias));
      }
      for (const fn of FUNCTIONS) {
        const item = new vscode.CompletionItem(fn, vscode.CompletionItemKind.Function);
        item.insertText = new vscode.SnippetString(`${fn}($0)`);
        item.sortText = `3${fn}`;
        items.push(item);
      }
    }

    for (const kw of KEYWORDS) {
      const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
      item.sortText = `${ctx.kind === 'keyword' ? 0 : 4}${kw}`;
      items.push(item);
    }
    return items;
  }

  /** 메타데이터가 아직 없으면 받아 오되, 오래 걸리면 키워드만 먼저 보여 준다. */
  private async tables(cfg: ConnectionConfig): Promise<MetaTable[]> {
    const meta = this.sessions.cachedMetadata(cfg.id) ?? this.sessions.metadata(cfg);
    const timeout = new Promise<MetaTable[]>((resolve) => setTimeout(() => resolve([]), 1500));
    return Promise.race([meta.catch(() => [] as MetaTable[]), timeout]);
  }

  private tableItem(t: MetaTable, driver: DriverId, qualify: boolean): vscode.CompletionItem {
    const item = new vscode.CompletionItem(
      { label: t.name, description: t.schema },
      t.kind === 'view' ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Struct,
    );
    item.insertText = qualify ? `${quoteIdent(driver, t.schema)}.${quoteIdent(driver, t.name)}` : quoteIdent(driver, t.name);
    item.filterText = t.name;
    item.detail = `${t.kind} · ${t.columns.length} columns`;
    item.sortText = `${qualify ? 1 : 0}${t.name}`;
    return item;
  }

  private columnItem(c: MetaTable['columns'][number], t: MetaTable, driver: DriverId, alias?: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem({ label: c.name, detail: c.type ? ` ${c.type.toLowerCase()}` : undefined, description: alias ?? t.name }, vscode.CompletionItemKind.Field);
    item.insertText = quoteIdent(driver, c.name);
    item.filterText = c.name;
    item.sortText = `0${c.name}`;
    return item;
  }
}
