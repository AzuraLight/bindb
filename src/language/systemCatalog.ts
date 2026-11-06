import type { DriverId, MetaTable } from '../drivers/types';

/*
 * Use pre-introspected objects for system catalogs that are not introspected (DataGrip Options · Introspection).
 * 시스템 스키마를 조회하지 않아도 자동완성에 쓰도록 미리 만든 시스템 카탈로그 목록(자주 쓰는 것만).
 * 컬럼은 각 DBMS 문서의 표준 컬럼 중 자주 쓰는 것이다.
 */

const t = (schema: string, name: string, columns: string, kind: MetaTable['kind'] = 'view'): MetaTable => ({
  schema,
  name,
  kind,
  columns: columns
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((name) => ({ name })),
});

/** information_schema(SQL 표준) — PostgreSQL · MySQL · H2 공통 */
const infoSchema = (schema: string) => [
  t(schema, 'tables', 'table_catalog, table_schema, table_name, table_type'),
  t(schema, 'columns', 'table_catalog, table_schema, table_name, column_name, ordinal_position, column_default, is_nullable, data_type, character_maximum_length'),
  t(schema, 'views', 'table_catalog, table_schema, table_name, view_definition'),
  t(schema, 'schemata', 'catalog_name, schema_name, schema_owner'),
  t(schema, 'table_constraints', 'constraint_catalog, constraint_schema, constraint_name, table_schema, table_name, constraint_type'),
  t(schema, 'key_column_usage', 'constraint_schema, constraint_name, table_schema, table_name, column_name, ordinal_position'),
  t(schema, 'referential_constraints', 'constraint_schema, constraint_name, unique_constraint_schema, unique_constraint_name, update_rule, delete_rule'),
  t(schema, 'routines', 'routine_schema, routine_name, routine_type, data_type'),
];

const CATALOG: Record<DriverId, MetaTable[]> = {
  postgres: [
    ...infoSchema('information_schema'),
    t('pg_catalog', 'pg_class', 'oid, relname, relnamespace, relkind, reltuples, relpages, relowner', 'table'),
    t('pg_catalog', 'pg_namespace', 'oid, nspname, nspowner', 'table'),
    t('pg_catalog', 'pg_attribute', 'attrelid, attname, atttypid, attnum, attnotnull, attisdropped', 'table'),
    t('pg_catalog', 'pg_index', 'indexrelid, indrelid, indisunique, indisprimary, indkey', 'table'),
    t('pg_catalog', 'pg_constraint', 'oid, conname, connamespace, contype, conrelid, confrelid, conkey, confkey', 'table'),
    t('pg_catalog', 'pg_type', 'oid, typname, typnamespace, typtype, typcategory', 'table'),
    t('pg_catalog', 'pg_proc', 'oid, proname, pronamespace, prorettype, proargtypes', 'table'),
    t('pg_catalog', 'pg_database', 'oid, datname, datdba, encoding, datistemplate, datallowconn', 'table'),
    t('pg_catalog', 'pg_roles', 'oid, rolname, rolsuper, rolcanlogin, rolcreatedb'),
    t('pg_catalog', 'pg_tables', 'schemaname, tablename, tableowner, hasindexes'),
    t('pg_catalog', 'pg_views', 'schemaname, viewname, viewowner, definition'),
    t('pg_catalog', 'pg_indexes', 'schemaname, tablename, indexname, indexdef'),
    t('pg_catalog', 'pg_settings', 'name, setting, unit, category, short_desc'),
    t('pg_catalog', 'pg_stat_activity', 'pid, datname, usename, application_name, client_addr, state, query, query_start, backend_start, wait_event'),
    t('pg_catalog', 'pg_stat_user_tables', 'relid, schemaname, relname, seq_scan, idx_scan, n_live_tup, n_dead_tup, last_vacuum, last_analyze'),
    t('pg_catalog', 'pg_locks', 'locktype, database, relation, pid, mode, granted'),
  ],
  mysql: [
    ...infoSchema('information_schema'),
    t('information_schema', 'statistics', 'table_schema, table_name, non_unique, index_name, seq_in_index, column_name'),
    t('information_schema', 'processlist', 'id, user, host, db, command, time, state, info'),
    t('mysql', 'user', 'host, user, plugin, account_locked', 'table'),
    t('performance_schema', 'events_statements_summary_by_digest', 'schema_name, digest_text, count_star, sum_timer_wait, avg_timer_wait'),
  ],
  sqlite: [t('main', 'sqlite_schema', 'type, name, tbl_name, rootpage, sql', 'table'), t('main', 'sqlite_master', 'type, name, tbl_name, rootpage, sql', 'table')],
  h2: [
    ...infoSchema('INFORMATION_SCHEMA').map((x) => ({ ...x, name: x.name.toUpperCase(), columns: x.columns.map((c) => ({ name: c.name.toUpperCase() })) })),
    t('INFORMATION_SCHEMA', 'SETTINGS', 'SETTING_NAME, SETTING_VALUE'),
    t('INFORMATION_SCHEMA', 'SESSIONS', 'SESSION_ID, USER_NAME, EXECUTING_STATEMENT, SESSION_START'),
  ],
};

/** 메타데이터에 아직 없는 시스템 카탈로그 객체 */
export function systemCatalog(driver: DriverId, have: readonly MetaTable[]): MetaTable[] {
  const known = new Set(have.map((x) => `${x.schema.toLowerCase()}.${x.name.toLowerCase()}`));
  return CATALOG[driver].filter((x) => !known.has(`${x.schema.toLowerCase()}.${x.name.toLowerCase()}`));
}
