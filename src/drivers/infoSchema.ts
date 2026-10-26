import { queryAll } from './cursor';
import type { MetaTable, Session } from './types';

/**
 * information_schema 표준 뷰로 테이블·컬럼을 읽는다. PostgreSQL, MySQL, H2 공용.
 * 드라이버마다 행 이름의 대소문자가 달라서 rowMode는 배열로 받는다.
 */
export async function introspectInfoSchema(session: Session, schemaFilter: string): Promise<MetaTable[]> {
  const tables = await queryAll(
    session,
    `SELECT table_schema, table_name, table_type FROM information_schema.tables
     WHERE ${schemaFilter} ORDER BY table_schema, table_name`,
  );
  const columns = await queryAll(
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
  return [...byKey.values()];
}
