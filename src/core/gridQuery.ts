import { splitStatements } from '../language/splitter';
import { classifySql } from './classify';
import { tokenize, type SqlDialect } from '../language/tokenizer';

/*
 * 결과 그리드의 WHERE / ORDER BY 줄(DataGrip Data editor의 filter · sort).
 *  - 테이블 데이터: SELECT … FROM 테이블 WHERE … ORDER BY …
 *  - 쿼리 결과: SELECT * FROM (원래 쿼리) bindb_q WHERE … ORDER BY …
 * 정렬은 컬럼 이름 대신 순번(ORDER BY 2 DESC)을 쓴다 — 이름이 겹치거나 특수문자여도 된다.
 */

export interface SortKey {
  /** 0부터 센 컬럼 위치 */
  column: number;
  desc: boolean;
}

export interface GridFilter {
  where?: string;
  orderBy?: string;
}

/** 감쌀 수 있는 쿼리인가: 문장 하나이고 SELECT · WITH · VALUES · TABLE로 시작 */
export function isWrappable(sql: string, dialect?: SqlDialect): boolean {
  const statements = splitStatements(sql, dialect).filter((s) => s.text.trim());
  if (statements.length !== 1) return false;
  // (SELECT …) UNION (SELECT …) 처럼 괄호로 시작해도 된다
  const first = tokenize(statements[0].text, dialect).find((t) => t.type !== 'comment' && !(t.type === 'punct' && t.text === '('));
  return !!first && /^(select|with|values|table)$/i.test(first.text);
}

/** 사용자가 쓴 조각이 문장 하나 안에 머무는가: 세미콜론 · 닫히지 않은 따옴표/주석 · 괄호 짝 */
export function checkFragment(text: string, label: 'WHERE' | 'ORDER BY', dialect?: SqlDialect): string | undefined {
  let depth = 0;
  for (const t of tokenize(text, dialect)) {
    if (t.open) return `${label}: an unclosed ${t.type === 'comment' ? 'comment' : 'quote'}.`;
    // 줄 주석: -- · # (mysql) · // (h2). 블록 주석 /* */ 만 허용
    if (t.type === 'comment' && !t.text.startsWith('/*')) return `${label}: line comments are not allowed here.`;
    if (t.type === 'punct' && t.text === ';') return `${label}: ";" is not allowed.`;
    if (t.type === 'punct' && t.text === '(') depth++;
    if (t.type === 'punct' && t.text === ')' && --depth < 0) return `${label}: unbalanced parentheses.`;
  }
  return depth !== 0 ? `${label}: unbalanced parentheses.` : undefined;
}

/** 원래 쿼리 끝의 세미콜론 · 주석을 정리한다 */
function body(sql: string, dialect?: SqlDialect): string {
  const s = splitStatements(sql, dialect).filter((x) => x.text.trim());
  return (s[0]?.text ?? sql).trim();
}

function duplicateName(columns: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const c of columns) {
    const k = c.toLowerCase();
    if (seen.has(k)) return c;
    seen.add(k);
  }
  return undefined;
}

/** 정렬 키 → ORDER BY 조각 */
export function orderByOf(keys: readonly SortKey[]): string {
  return keys.map((k) => `${k.column + 1}${k.desc ? ' DESC' : ''}`).join(', ');
}

/** 헤더 클릭: 없음 → 오름차순 → 내림차순 → 없음. additive(Shift)면 다른 키를 유지 */
export function toggleSort(keys: readonly SortKey[], column: number, additive: boolean): SortKey[] {
  const cur = keys.find((k) => k.column === column);
  const next: SortKey | undefined = !cur ? { column, desc: false } : !cur.desc ? { column, desc: true } : undefined;
  const rest = additive ? keys.filter((k) => k.column !== column) : [];
  return next ? [...rest, next] : rest;
}

export type BuildResult = { ok: true; sql: string } | { ok: false; error: string };

/**
 * 필터를 적용한 SQL.
 * @param source 테이블이면 { table: 인용된 이름, select: 컬럼 목록(기본 *) }, 쿼리면 { query }
 */
export function buildFilteredSql(
  /** query면 columns: 지금 보이는 결과의 열 이름(겹치는 이름 확인) */
  source: { table: string; select?: string } | { query: string; columns?: readonly string[] },
  filter: GridFilter,
  /** Code style의 키워드 대소문자 */
  kw: (k: string) => string = (k) => k.toUpperCase(),
  /** 문자열 · 주석 규칙을 고를 DB(연결의 드라이버) */
  dialect?: SqlDialect,
): BuildResult {
  const where = filter.where?.trim();
  const orderBy = filter.orderBy?.trim();
  for (const [text, label] of [
    [where, 'WHERE'],
    [orderBy, 'ORDER BY'],
  ] as const) {
    if (!text) continue;
    const err = checkFragment(text, label, dialect);
    if (err) return { ok: false, error: err };
  }
  let base: string;
  if ('table' in source) base = `${kw('select')} ${source.select ?? '*'} ${kw('from')} ${source.table}`;
  else {
    if (!where && !orderBy) return { ok: true, sql: body(source.query, dialect) };
    if (!isWrappable(source.query, dialect)) return { ok: false, error: 'Filtering and sorting work on SELECT queries only.' };
    // 필터 · 정렬은 쿼리를 다시 실행한다 — WITH … AS (DELETE …) 같은 쿼리는 그때마다 데이터를 바꾼다
    // (PostgreSQL은 이런 WITH를 부속 쿼리 안에 둘 수도 없다)
    if (classifySql(source.query, dialect ?? 'postgres').kind !== 'read') {
      return { ok: false, error: 'Filtering and sorting run the query again, and this query changes data.' };
    }
    // MySQL · H2는 감싼 부속 쿼리의 열 이름이 겹치면 거부한다(Duplicate column name). 대소문자를 가리지 않고 본다
    const dup = dialect === 'mysql' || dialect === 'h2' ? duplicateName(source.columns ?? []) : undefined;
    if (dup) return { ok: false, error: `Two result columns are named "${dup}". Give them different aliases to filter or sort.` };
    // 원래 쿼리의 마지막 줄이 주석이어도 닫는 괄호가 주석에 먹히지 않게 줄을 바꾼다
    base = `${kw('select')} * ${kw('from')} (\n${body(source.query, dialect)}\n) bindb_q`;
  }
  return { ok: true, sql: `${base}${where ? `\n${kw('where')} ${where}` : ''}${orderBy ? `\n${kw('order by')} ${orderBy}` : ''}` };
}
