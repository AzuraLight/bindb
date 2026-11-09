import { queryAll } from './cursor';
import { levelsBySchema, loadsSources } from './introspection';
import type { ConnectionConfig, MetaTable, Session } from './types';

/**
 * information_schema 표준 뷰로 테이블·컬럼을 읽는다. PostgreSQL, MySQL, H2 공용.
 * 드라이버마다 행 이름의 대소문자가 달라서 rowMode는 배열로 받는다.
 * 스키마마다 수준(introspection.ts)을 따른다: 1 = 이름만(열 타입 · 기본키 없음), 2 = 소스 코드 빼고, 3 = 전부.
 * @param current 현재 스키마(자동 수준에서 더 자세히 읽는다)
 */
export async function introspectInfoSchema(
  session: Session,
  schemaFilter: string,
  cfg?: ConnectionConfig,
  isSystem: (schema: string) => boolean = () => false,
  current?: string,
): Promise<MetaTable[]> {
  const tables = await queryAll(
    session,
    `SELECT table_schema, table_name, table_type FROM information_schema.tables
     WHERE ${schemaFilter} ORDER BY table_schema, table_name`,
  );
  const levels = levelsBySchema(cfg ?? {}, tables.map(([s]) => String(s)), current, isSystem);
  const levelOf = (schema: unknown) => levels.get(String(schema)) ?? 3;

  const byKey = new Map<string, MetaTable>();
  for (const [schema, name, type] of tables) {
    const t: MetaTable = {
      schema: String(schema),
      name: String(name),
      kind: /VIEW/i.test(String(type)) ? 'view' : 'table',
      columns: [],
      level: levelOf(schema),
    };
    byKey.set(`${t.schema}\u0000${t.name}`, t);
  }
  if (!byKey.size) return [];

  // 열 이름은 1단계에서도 읽는다(DataGrip: 이름 · 시그니처). 타입은 2단계부터
  const columns = await queryAll(
    session,
    `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
     WHERE ${schemaFilter} ORDER BY table_schema, table_name, ordinal_position`,
  );
  for (const [schema, table, name, type] of columns) {
    const t = byKey.get(`${schema}\u0000${table}`);
    if (!t) continue;
    t.columns.push({ name: String(name), type: t.level === 1 || type == null ? undefined : String(type) });
  }

  // 기본키(그리드 편집이 행을 찾는 데 쓴다): 2단계부터. 못 읽는 서버면 기본키 없이 둔다
  if ([...levels.values()].some((l) => l >= 2)) {
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
        if (t && (t.level ?? 3) >= 2) (t.primaryKey ??= []).push(String(column));
      }
    } catch {
      // information_schema에 제약 정보가 없는 서버
    }
  }

  // Options · Load sources for: 뷰 정의는 3단계 스키마에서만(All schemas / All excl. system schemas / None)
  const wantsSources = [...byKey.values()].some((t) => t.kind === 'view' && loadsSources(cfg ?? {}, t.level ?? 3, isSystem(t.schema)));
  if (wantsSources) {
    try {
      const views = await queryAll(
        session,
        `SELECT table_schema, table_name, view_definition FROM information_schema.views WHERE ${schemaFilter}`,
      );
      for (const [schema, name, def] of views) {
        const t = byKey.get(`${schema}\u0000${name}`);
        if (t && def != null && loadsSources(cfg ?? {}, t.level ?? 3, isSystem(t.schema))) t.definition = String(def);
      }
    } catch {
      // 뷰 정의를 못 읽는 서버(권한 등)면 정의 없이 둔다.
    }
  }
  return [...byKey.values()];
}
