import * as vscode from 'vscode';
import { emptyVirtual, joinConditions, realForeignKeys, tableKey } from '../core/virtual';
import type { VirtualStore } from '../ui/virtualObjects';
import type { ConnectionStore } from '../core/connections';
import type { SessionManager } from '../core/sessions';
import { drivers, type ConnectionConfig, type DriverId, type MetaTable } from '../drivers';
import { boundConnection, boundSchema } from '../ui/binding';
import { withCatalog } from '../ui/metaScope';
import { completionContext, RESERVED, type TableRef } from './context';
import { findTable, same } from './meta';
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

const resolveRef = (ref: TableRef, tables: MetaTable[], defaultSchema: string | undefined) => findTable(tables, ref.name, ref.schema, defaultSchema);

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly virtual?: VirtualStore,
  ) {}

  async provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
    const offset = doc.offsetAt(position);
    const cfg = boundConnection(doc, this.store);
    const ctx = completionContext(statementAt(splitStatements(doc.getText(), cfg?.driver), offset), offset);
    if (ctx.kind === 'none') return [];

    const tables = cfg ? await this.tables(cfg) : [];
    const driver = cfg?.driver ?? 'postgres';
    // @schema 바인딩(Switch schema)이 있으면 그 스키마가 기본 — hover · 진단 · 이동과 같다
    const defaultSchema = cfg ? (boundSchema(doc) ?? drivers[cfg.driver].defaultSchema(cfg)) : undefined;
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

    // 외래 키(DB에 정의된 것 · 가상): `JOIN b ON |` 에서 앞 테이블과 잇는 조건을 제안한다
    if (ctx.kind === 'column' && !ctx.qualifier && cfg && ctx.refs.length >= 2) {
      const before = doc.getText(new vscode.Range(position.with(undefined, 0), position));
      if (/\bON\s+\w*$/i.test(before)) {
        const virtual = this.virtual ? await this.virtual.get(cfg).catch(() => undefined) : undefined;
        const sources = [
          { label: 'foreign key', v: { ...emptyVirtual(), foreignKeys: realForeignKeys(tables) } },
          ...(virtual ? [{ label: 'virtual foreign key', v: virtual }] : []),
        ];
        const last = ctx.refs[ctx.refs.length - 1];
        const right = resolveRef(last, tables, defaultSchema);
        const seen = new Set<string>();
        for (const ref of ctx.refs.slice(0, -1)) {
          const left = resolveRef(ref, tables, defaultSchema);
          if (!left || !right) continue;
          for (const { label, v } of sources) {
            const conds = joinConditions(
              v,
              { table: tableKey(left.schema, left.name), alias: ref.alias ?? ref.name },
              { table: tableKey(right.schema, right.name), alias: last.alias ?? last.name },
            );
            for (const cond of conds) {
              if (seen.has(cond)) continue;
              seen.add(cond);
              const item = new vscode.CompletionItem(cond, vscode.CompletionItemKind.Reference);
              item.detail = label;
              item.sortText = `0${cond}`;
              items.push(item);
            }
          }
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
    const tables = await Promise.race([meta.catch(() => [] as MetaTable[]), timeout]);
    // Use pre-introspected objects for system catalogs that are not introspected(기본 켬)
    return withCatalog(cfg, tables);
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
