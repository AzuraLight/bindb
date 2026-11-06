import { queryAll } from './cursor';
import type { ConnectionConfig, MetaTable, Session } from './types';

/**
 * information_schema 표준 뷰로 테이블·컬럼을 읽는다. PostgreSQL, MySQL, H2 공용.
 * 드라이버마다 행 이름의 대소문자가 달라서 rowMode는 배열로 받는다.
 */
export async function introspectInfoSchema(
  session: Session,
  schemaFilter: string,
  cfg?: ConnectionConfig,
  isSystem: (schema: string) => boolean = () => false,
): Promise<MetaTable[]> {
  const tables = await queryAll(
    session,
    `SELECT table_schema, table_name, table_type FROM information_schema.tables
     WHERE ${schemaFilter} ORDER BY table_schema, table_name`,
  );
  // Default level 1: 이름만 — 컬럼을 읽지 않는다
  const level = cfg?.introspectionLevel ?? 3;
  const columns = level === 1 ? [] : await queryAll(
    session,
    `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
     WHERE ${schemaFilter} ORDER BY table_schema, table_name, ordinal_position`,
  );

  const byKey = new Map<string, MetaTable>();
  for (const [schema, name, type] of tables) {
    const t: MetaTable = {
      schema: String(schema),
      name: String(name),
      kind: /VIEW/i.test(String(type)) ? 'view' : 'table',
      columns: [],
    };
    byKey.set(`${t.schema}\u0000${t.name}`, t);
  }
  for (const [schema, table, name, type] of columns) {
    byKey.get(`${schema}\u0000${table}`)?.columns.push({ name: String(name), type: type == null ? undefined : String(type) });
  }
  // 기본키(그리드 편집이 행을 찾는 데 쓴다). 못 읽는 서버면 기본키 없이 둔다
  if (level !== 1) {
    try {
      const keys = await queryAll(
        session,
        `SELECT k.table_schema, k.table_name, k.column_name, k.ordinal_position
           FROM information_schema.key_column_usage k
          WHERE ${schemaFilter.replace(/\btable_schema\b/g, 'k.table_schema')}
            AND EXISTS (SELECT 1 FROM information_schema.table_constraints c
                         WHERE c.constraint_type = 'PRIMARY KEY'
                           AND c.constraint_name = k.constraint_name
                           AND c.table_schema = k.table_schema
                           AND c.table_name = k.table_name)
          ORDER BY k.table_schema, k.table_name, k.ordinal_position`,
      );
      for (const [schema, table, column] of keys) {
        const t = byKey.get(`${schema}\u0000${table}`);
        if (t) (t.primaryKey ??= []).push(String(column));
      }
    } catch {
      // information_schema에 제약 정보가 없는 서버
    }
  }

  // Options · Load sources for: 뷰 정의를 읽는다(All schemas / All excl. system schemas / None)
  // Default level 2: 소스 코드(뷰 정의)는 읽지 않는다
  const load = level < 3 ? 'none' : (cfg?.loadSources ?? 'nonSystem');
  if (load !== 'none' && [...byKey.values()].some((t) => t.kind === 'view')) {
    try {
      const views = await queryAll(
        session,
        `SELECT table_schema, table_name, view_definition FROM information_schema.views WHERE ${schemaFilter}`,
      );
      for (const [schema, name, def] of views) {
        if (load === 'nonSystem' && isSystem(String(schema))) continue;
        const t = byKey.get(`${schema}\u0000${name}`);
        if (t && def != null) t.definition = String(def);
      }
    } catch {
      // 뷰 정의를 못 읽는 서버(권한 등)면 정의 없이 둔다.
    }
  }
  return [...byKey.values()];
}
