import type { SqlDialect } from '../language/tokenizer';
import type { CodeStyle, DriverId, MetaTable } from '../drivers/types';
import { splitStatements } from '../language/splitter';

/*
 * DDL 데이터 소스와 DDL Mapping(DataGrip). SQL 파일 폴더를 데이터 소스로 보고, 실제 데이터 소스와 맞춘다.
 * https://www.jetbrains.com/help/datagrip/2025.3/ddl-mappings.html
 *  - Dump to / Update from: 실제 DB의 구조를 DDL 파일로 쓴다(없어진 객체의 파일은 지운다)
 *  - Apply to: DDL 파일과 실제 DB의 차이로 마이그레이션 스크립트를 만든다
 * vscode · 파일 시스템에 기대지 않는다(파일 내용 ↔ 메타데이터만).
 */

const QUOTE: Record<DriverId, string> = { postgres: '"', mysql: '`', sqlite: '"', h2: '"' };

/** 식별자 하나를 읽는다: "a""b" · `a` · [a] · a */
function unquote(id: string): string {
  const t = id.trim();
  if (/^".*"$/s.test(t)) return t.slice(1, -1).replace(/""/g, '"');
  if (/^`.*`$/s.test(t)) return t.slice(1, -1).replace(/``/g, '`');
  if (/^\[.*\]$/s.test(t)) return t.slice(1, -1);
  return t;
}

/** `a.b` → [a, b] (따옴표 안의 점은 나누지 않는다) */
function splitQualified(text: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote = '';
  for (const ch of text.trim()) {
    if (quote) {
      cur += ch;
      if (ch === quote || (quote === '[' && ch === ']')) quote = '';
    } else if (ch === '"' || ch === '`' || ch === '[') {
      quote = ch;
      cur += ch;
    } else if (ch === '.') {
      parts.push(unquote(cur));
      cur = '';
    } else cur += ch;
  }
  parts.push(unquote(cur));
  return parts;
}

/** 괄호 깊이 0의 쉼표로 나눈다 */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const NAME = String.raw`((?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[\w$]+)(?:\s*\.\s*(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[\w$]+))?)`;
const CREATE_TABLE = new RegExp(String.raw`^\s*create\s+(?:(?:global\s+|local\s+)?(?:temporary|temp)\s+)?(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${NAME}\s*\(([\s\S]*)\)[^)]*$`, 'i');
const CREATE_VIEW = new RegExp(String.raw`^\s*create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?${NAME}(?:\s*\([^)]*\))?\s+as\s+([\s\S]+)$`, 'i');
const TABLE_CONSTRAINT = /^(constraint|primary\s+key|unique|foreign\s+key|check|key|index|fulltext|spatial|exclude|like)\b/i;
const COLUMN_STOP = /\s+(not\s+null|null|default|primary\s+key|unique|references|check|constraint|collate|generated|auto_increment|autoincrement|comment|on\s+update|identity)\b[\s\S]*$/i;

/**
 * DDL 문장들 → 테이블 · 뷰 메타데이터. CREATE TABLE · CREATE VIEW만 본다.
 * 스키마가 없는 이름은 defaultSchema로 둔다.
 */
export function parseDdl(sql: string, defaultSchema: string, dialect?: SqlDialect): MetaTable[] {
  const out: MetaTable[] = [];
  for (const { text } of splitStatements(sql, dialect)) {
    const t = CREATE_TABLE.exec(text);
    if (t) {
      const [schema, name] = qualified(t[1], defaultSchema);
      const columns = splitTop(t[2])
        .filter((def) => def && !TABLE_CONSTRAINT.test(def))
        .map((def) => {
          const m = /^("(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|[\w$]+)\s*([\s\S]*)$/.exec(def);
          if (!m) return undefined;
          const type = m[2].replace(COLUMN_STOP, '').trim();
          return { name: unquote(m[1]), type: type || undefined };
        })
        .filter((c): c is { name: string; type: string | undefined } => !!c);
      out.push({ schema, name, kind: 'table', columns });
      continue;
    }
    const v = CREATE_VIEW.exec(text);
    if (v) {
      const [schema, name] = qualified(v[1], defaultSchema);
      out.push({ schema, name, kind: 'view', columns: [], definition: v[2].trim() });
    }
  }
  return out;
}

function qualified(text: string, defaultSchema: string): [string, string] {
  const parts = splitQualified(text);
  return parts.length > 1 ? [parts[0], parts[1]] : [defaultSchema, parts[0]];
}

/** Code style(Options · Other). 없으면 키워드 대문자 · 식별자 늘 따옴표 */
let style: CodeStyle = { keywordCase: 'upper', quoteIdentifiers: 'always' };
/** 이 스타일로 fn을 실행한다(생성 함수들이 같은 스타일을 쓰게) */
export function withCodeStyle<T>(s: CodeStyle | undefined, fn: () => T): T {
  const prev = style;
  style = s ?? { keywordCase: 'upper', quoteIdentifiers: 'always' };
  try {
    return fn();
  } finally {
    style = prev;
  }
}
/** 키워드(공백으로 나뉜 여러 단어 가능)를 스타일대로 */
export const kw = (k: string) => (style.keywordCase === 'upper' ? k.toUpperCase() : k.toLowerCase());

export const ident = (driver: DriverId, s: string) =>
  style.quoteIdentifiers === 'needed' && /^[a-z_][a-z0-9_]*$/.test(s) && !RESERVED.has(s.toUpperCase())
    ? s
    : QUOTE[driver] + s.split(QUOTE[driver]).join(QUOTE[driver] + QUOTE[driver]) + QUOTE[driver];
export const tableName = (driver: DriverId, t: Pick<MetaTable, 'schema' | 'name'>) =>
  driver === 'sqlite' ? ident(driver, t.name) : `${ident(driver, t.schema)}.${ident(driver, t.name)}`;

/** 따옴표 없이 쓰면 안 되는 흔한 예약어 */
const RESERVED = new Set(
  'SELECT FROM WHERE TABLE ORDER GROUP BY USER INDEX KEY PRIMARY FOREIGN REFERENCES CHECK DEFAULT NULL NOT AND OR AS ON JOIN LIMIT OFFSET VALUES INSERT UPDATE DELETE CREATE DROP ALTER COLUMN VIEW UNIQUE CONSTRAINT CASE WHEN THEN ELSE END ALL ANY DESC ASC'.split(' '),
);

/** 객체 하나의 DDL 파일 내용 */
export function ddlFor(driver: DriverId, t: MetaTable): string {
  if (t.kind === 'view') {
    if (!t.definition) return `-- ${t.schema}.${t.name}: view definition is not available\n`;
    return `${kw('create view')} ${tableName(driver, t)} ${kw('as')}\n${t.definition.trim().replace(/;\s*$/, '')};\n`;
  }
  const cols = t.columns.map((c) => `    ${ident(driver, c.name)} ${c.type ?? 'text'}`);
  return `${kw('create table')} ${tableName(driver, t)}\n(\n${cols.join(',\n')}\n);\n`;
}

/** DDL 폴더 안에서 객체 파일의 상대 경로(DataGrip처럼 스키마 폴더 / 객체 이름.sql) */
export function ddlPath(driver: DriverId, t: Pick<MetaTable, 'schema' | 'name' | 'kind'>): string {
  // 경로 구분자 · 금지 문자 · 앞의 점(.. 포함)을 바꾼다 — 스키마 이름이 ".."여도 폴더 밖으로 나가지 않게
  const safe = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, (m) => '_'.repeat(m.length)) || '_';
  const file = `${safe(t.name)}${t.kind === 'view' ? '.view' : ''}.sql`;
  return driver === 'sqlite' ? file : `${safe(t.schema)}/${file}`;
}

export interface SchemaDiff {
  /** 실제 DB에만 있는 객체 */
  onlyInSource: MetaTable[];
  /** DDL에만 있는 객체 */
  onlyInDdl: MetaTable[];
  /** 둘 다 있지만 컬럼이 다른 테이블 */
  changed: { source: MetaTable; ddl: MetaTable; added: string[]; removed: string[]; retyped: string[] }[];
}

const key = (t: MetaTable) => `${t.schema.toLowerCase()}\u0000${t.name.toLowerCase()}`;
const normType = (t?: string) => (t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** 실제 데이터 소스(source)와 DDL 데이터 소스(ddl)의 차이. scope가 있으면 그 스키마만 */
export function diffSchemas(source: MetaTable[], ddl: MetaTable[], scope?: string[]): SchemaDiff {
  const inScope = (t: MetaTable) => !scope?.length || scope.some((s) => s.toLowerCase() === t.schema.toLowerCase());
  const a = new Map(source.filter(inScope).map((t) => [key(t), t]));
  const b = new Map(ddl.filter(inScope).map((t) => [key(t), t]));
  const diff: SchemaDiff = { onlyInSource: [], onlyInDdl: [], changed: [] };
  for (const [k, t] of a) if (!b.has(k)) diff.onlyInSource.push(t);
  for (const [k, t] of b) if (!a.has(k)) diff.onlyInDdl.push(t);
  for (const [k, s] of a) {
    const d = b.get(k);
    if (!d || s.kind !== 'table' || d.kind !== 'table') continue;
    const sc = new Map(s.columns.map((c) => [c.name.toLowerCase(), c]));
    const dc = new Map(d.columns.map((c) => [c.name.toLowerCase(), c]));
    const added = [...dc.keys()].filter((c) => !sc.has(c)).map((c) => dc.get(c)!.name);
    const removed = [...sc.keys()].filter((c) => !dc.has(c)).map((c) => sc.get(c)!.name);
    const retyped = [...sc.keys()]
      .filter((c) => dc.has(c) && dc.get(c)!.type && sc.get(c)!.type && normType(dc.get(c)!.type) !== normType(sc.get(c)!.type))
      .map((c) => sc.get(c)!.name);
    if (added.length || removed.length || retyped.length) diff.changed.push({ source: s, ddl: d, added, removed, retyped });
  }
  return diff;
}

/** 마이그레이션의 변경 하나(Migration 창에서 고른다) */
export interface MigrationChange {
  label: string;
  sql: string;
  /** 지우는 변경(DROP). 기본으로 고르지 않는다 */
  destructive: boolean;
}

/** Apply to <data source>: DDL을 기준으로 실제 DB를 맞추는 변경들 */
export function migrationChanges(driver: DriverId, diff: SchemaDiff): MigrationChange[] {
  const out: MigrationChange[] = [];
  for (const t of diff.onlyInDdl) out.push({ label: `Create ${t.kind} ${t.schema}.${t.name}`, sql: ddlFor(driver, t).trim(), destructive: false });
  for (const c of diff.changed) {
    const name = tableName(driver, c.ddl);
    for (const col of c.added) {
      const def = c.ddl.columns.find((x) => x.name === col)!;
      out.push({ label: `Add column ${c.ddl.name}.${col}`, sql: `${kw('alter table')} ${name} ${kw('add column')} ${ident(driver, col)} ${def.type ?? 'text'};`, destructive: false });
    }
    for (const col of c.retyped) {
      const def = c.ddl.columns.find((x) => x.name.toLowerCase() === col.toLowerCase())!;
      out.push({ label: `Change type of ${c.ddl.name}.${col} to ${def.type}`, sql: alterType(driver, name, ident(driver, col), def.type ?? 'text'), destructive: false });
    }
    for (const col of c.removed) {
      out.push({ label: `Drop column ${c.ddl.name}.${col}`, sql: `${kw('alter table')} ${name} ${kw('drop column')} ${ident(driver, col)};`, destructive: true });
    }
  }
  for (const t of diff.onlyInSource) {
    out.push({ label: `Drop ${t.kind} ${t.schema}.${t.name}`, sql: `${kw(t.kind === 'view' ? 'drop view' : 'drop table')} ${tableName(driver, t)};`, destructive: true });
  }
  return out;
}

/**
 * 고른 변경으로 스크립트를 만든다. picked가 없으면 지우는 변경은 주석으로 넣는다.
 */
export function migrationSql(driver: DriverId, diff: SchemaDiff, picked?: Set<string>): string {
  const lines = migrationChanges(driver, diff)
    .filter((c) => !picked || picked.has(c.label))
    .map((c) => (!picked && c.destructive ? `-- ${c.sql}` : c.sql));
  return lines.join('\n\n') + (lines.length ? '\n' : '');
}

function alterType(driver: DriverId, table: string, col: string, type: string): string {
  switch (driver) {
    case 'mysql':
      return `${kw('alter table')} ${table} ${kw('modify column')} ${col} ${type};`;
    case 'sqlite':
      return `-- SQLite cannot change a column type in place: ${table}.${col} → ${type}`;
    case 'h2':
      return `${kw('alter table')} ${table} ${kw('alter column')} ${col} ${type};`;
    default:
      return `${kw('alter table')} ${table} ${kw('alter column')} ${col} ${kw('type')} ${type};`;
  }
}
