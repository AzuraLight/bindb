import { splitStatements } from '../language/splitter';
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
  const first = tokenize(statements[0].text, dialect).find((t) => t.type !== 'comment');
  return !!first && /^(select|with|values|table)$/i.test(first.text);
}

/** 사용자가 쓴 조각이 문장 하나 안에 머무는가: 세미콜론 · 닫히지 않은 따옴표/주석 · 괄호 짝 */
export function checkFragment(text: string, label: 'WHERE' | 'ORDER BY', dialect?: SqlDialect): string | undefined {
  let depth = 0;
  for (const t of tokenize(text, dialect)) {
    if (t.open) return `${label}: an unclosed ${t.type === 'comment' ? 'comment' : 'quote'}.`;
    if (t.type === 'comment' && t.text.startsWith('--')) return `${label}: line comments are not allowed here.`;
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
  source: { table: string; select?: string } | { query: string },
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
    // 원래 쿼리의 마지막 줄이 주석이어도 닫는 괄호가 주석에 먹히지 않게 줄을 바꾼다
    base = `${kw('select')} * ${kw('from')} (\n${body(source.query, dialect)}\n) bindb_q`;
  }
  return { ok: true, sql: `${base}${where ? `\n${kw('where')} ${where}` : ''}${orderBy ? `\n${kw('order by')} ${orderBy}` : ''}` };
}
