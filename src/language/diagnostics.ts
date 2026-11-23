import type { DriverId, MetaTable } from '../drivers/types';
import { closeOf, CONFLICT, createdName, cteDeclarations, innermostScope, isCallParen, parenChains, RESERVED, tableReferences } from './references';
import type { Statement } from './splitter';
import { findTable, same } from './meta';
import { identName, isIdent, upperWord, type Token } from './tokenizer';

/*
 * 해석되지 않는 참조 찾기 — DataGrip의 "Unresolved reference" 검사(SqlResolve)에 해당한다.
 * 작성 중인 SQL을 다루므로 오탐을 피하는 쪽으로 좁게 잡는다:
 *  - SELECT · WITH · INSERT · UPDATE · DELETE 문만 본다(DDL · 권한 · 세션 문은 넘긴다)
 *  - 테이블: FROM · JOIN · UPDATE · INSERT INTO · DELETE … USING 뒤의 이름.
 *    스키마가 메타데이터에 없으면(조회 안 한 스키마 · 다른 데이터베이스) 판정하지 않는다
 *  - 열: 별칭 · 테이블로 한정한 `a.col`, INSERT 열 목록, 단일 테이블 UPDATE의 SET 대상.
 *    한정하지 않은 열(SELECT col)은 함수 · 키워드 · 출력 별칭과 구분이 어려워 아직 보지 않는다
 *  - CTE · 같은 문서에서 CREATE한 객체 · 서브쿼리 별칭은 알 수 없는 것으로 두고 넘긴다
 */

export interface Problem {
  start: number;
  end: number;
  message: string;
  code: 'unresolved-table' | 'unresolved-column';
}

export interface ResolveScope {
  driver: DriverId;
  tables: readonly MetaTable[];
  /** 한정하지 않은 이름을 찾을 스키마(@schema 바인딩 또는 연결의 기본 스키마) */
  schema?: string;
  /** 같은 문서에서 CREATE한 테이블 · 뷰 이름(소문자, `schema.name` 과 `name` 둘 다) */
  local?: ReadonlySet<string>;
}

const ANALYZED = new Set(['SELECT', 'WITH', 'INSERT', 'REPLACE', 'UPDATE', 'DELETE']);
/** 메타데이터에 없지만 늘 있는 테이블 */
const BUILTIN_TABLES = new Set(['dual']);

const upper = upperWord;

/**
 * 열 자리에 와도 열이 아닌 단어(키워드 · 인자 없는 함수 · 날짜 단위 · 숨은 열 등). 이 이름의 실제 열은 판정하지 않는다.
 * 출처: PostgreSQL 키워드 표 · 시스템 열, MySQL 키워드 · INTERVAL 단위 · SELECT 수식어, SQLite rowid, H2 _ROWID_ · ROWNUM
 */
const NOT_COLUMN_WORDS = new Set(
  `ALL AND ANY ARRAY AS ASC AT BETWEEN BINARY BOTH BY CASE CAST COLLATE CONFLICT CONSTRAINT CROSS CUBE CURRENT
   CURRENT_CATALOG CURRENT_DATE CURRENT_ROLE CURRENT_SCHEMA CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER DEFAULT DESC
   DISTINCT DIV DO DUAL DUPLICATE KEY ELSE END ESCAPE EXCEPT EXCLUDE EXISTS FALSE FETCH FILTER FIRST FOLLOWING FOR FROM FULL GLOB
   GROUP GROUPING GROUPS HAVING ILIKE IN INNER INTERSECT INTERVAL INTO IS ISNULL JOIN LAST LATERAL LEADING LEFT LIKE
   LIMIT LOCALTIME LOCALTIMESTAMP LOCK LOCKED MATCH MOD MODE NATURAL NEXT NO NOT NOTHING NOTNULL NOWAIT NULL NULLS OF
   OFFSET ON ONLY OR ORDER ORDINALITY OTHERS OUTER OVER OVERLAPS PARTITION PRECEDING RANGE REGEXP RETURNING RIGHT RLIKE
   ROLLUP ROW ROWS SELECT SEPARATOR SESSION_USER SET SETS SHARE SIMILAR SKIP SOME SOUNDS SYMMETRIC SYSDATE SYSTEM_USER
   SYSTIMESTAMP THEN TIES TO TRAILING TRUE UNBOUNDED UNION UNKNOWN USER USING UTC_DATE UTC_TIME UTC_TIMESTAMP VALUES WHEN
   WHERE WINDOW WITH WITHIN XOR ZONE
   YEAR MONTH WEEK DAY HOUR MINUTE SECOND MICROSECOND MILLISECOND MICROSECONDS MILLISECONDS QUARTER EPOCH DOW DOY
   ISODOW ISOYEAR CENTURY DECADE MILLENNIUM TIMEZONE TIMEZONE_HOUR TIMEZONE_MINUTE SECOND_MICROSECOND MINUTE_MICROSECOND
   MINUTE_SECOND HOUR_MICROSECOND HOUR_SECOND HOUR_MINUTE DAY_MICROSECOND DAY_SECOND DAY_MINUTE DAY_HOUR YEAR_MONTH
   ROWID OID _ROWID_ ROWNUM CTID XMIN XMAX CMIN CMAX TABLEOID
   HIGH_PRIORITY LOW_PRIORITY DELAYED STRAIGHT_JOIN QUICK DISTINCTROW`.split(/\s+/).filter(Boolean),
);
/** 이 단어 뒤에는 열이 올 수 있다(그 밖의 이름 뒤의 이름은 별칭이나 타입의 일부다: a b, double precision) */
const BEFORE_COLUMN = new Set([
  'SELECT', 'DISTINCT', 'DISTINCTROW', 'ALL', 'WHERE', 'AND', 'OR', 'NOT', 'ON', 'BY', 'SET', 'WHEN', 'THEN', 'ELSE', 'CASE',
  'HAVING', 'RETURNING', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'ANY', 'SOME', 'RLIKE', 'REGEXP', 'GLOB', 'DIV', 'MOD',
  'XOR', 'LIMIT', 'OFFSET', 'IS', 'EXISTS', 'TO', 'SIMILAR',
]);
/** 이 단어 바로 뒤의 이름은 열이 아니다(별칭 · 제약 이름 · 창 이름 · 콜레이션 · 잠글 테이블) */
const NAME_AFTER = new Set(['AS', 'OF', 'CONSTRAINT', 'COLLATE', 'WINDOW', 'OVER', 'SEPARATOR', 'ESCAPE', 'INTERVAL']);

interface Ref {
  schema?: string;
  name: string;
  alias?: string;
  /** 이름 토큰(문제 표시 자리) */
  nameTok: Token;
  /** 해석 결과: 테이블, 알 수 없음(CTE · 로컬 · 미조회 스키마), 없음 */
  table?: MetaTable;
  unknown?: boolean;
}

/** 문서 안의 CREATE TABLE · VIEW 이름(그 객체를 쓰는 뒤 문장이 오탐되지 않게) */
export function localObjects(statements: readonly Statement[]): Set<string> {
  const out = new Set<string>();
  for (const s of statements) {
    const c = createdName(s.tokens.filter((t) => t.type !== 'comment'));
    if (!c) continue;
    // [schema.]name — 세 조각 이상이면 앞의 두 조각을 쓴다(예전 동작 그대로)
    const name = identName(c.parts[Math.min(1, c.parts.length - 1)]);
    if (c.parts.length > 1) out.add(`${identName(c.parts[0]).toLowerCase()}.${name.toLowerCase()}`);
    out.add(name.toLowerCase());
  }
  return out;
}

/**
 * 문장 하나에서 찾지 못한 테이블 · 열. 확실하지 않으면 알리지 않는다.
 * @returns 문제들(같은 자리는 한 번만, 위치순)
 */
export function unresolvedReferences(statement: Statement, scope: ResolveScope): Problem[] {
  const code = statement.tokens.filter((t) => t.type !== 'comment');
  const first = code[0]?.text === '(' ? upper(code.find((t) => t.text !== '(')) : upper(code[0]);
  if (!first || !ANALYZED.has(first)) return [];

  const cteToks = cteDeclarations(code);
  const ctes = new Set(cteToks.map((t) => identName(t).toLowerCase()));
  const refs: Ref[] = [];
  const refTokens = new Set<Token>(cteToks);
  /** 열을 알 수 없는 원본(서브쿼리 · 테이블 함수)이 있는 위치 */
  const opaque: Token[] = [];
  for (const src of tableReferences(code, first, (t) => opaque.push(t))) {
    const parts = src.parts;
    for (const p of parts) refTokens.add(p);
    if (src.alias) refTokens.add(src.alias);
    const nameTok = parts[parts.length - 1];
    const ref: Ref = { name: identName(nameTok), alias: src.alias && identName(src.alias), nameTok };
    if (parts.length === 2) ref.schema = identName(parts[0]);
    // db.schema.table — 다른 카탈로그는 판정하지 않는다
    if (parts.length > 2) ref.unknown = true;
    // 닫히지 않은 "… 는 아직 입력 중
    if (parts.some((p) => p.open)) ref.unknown = true;
    refs.push(ref);
  }

  const problems: Problem[] = [];
  const known = [...scope.tables];
  const schemas = new Set(known.map((t) => t.schema.toLowerCase()));
  for (const ref of refs) {
    if (ref.unknown) continue;
    const lname = ref.name.toLowerCase();
    if (!ref.schema && (ctes.has(lname) || BUILTIN_TABLES.has(lname))) {
      ref.unknown = true;
      continue;
    }
    // 스키마 없이 만든 객체는 기본 스키마에 생긴다
    const inDefault = !ref.schema || (!!scope.schema && same(ref.schema, scope.schema));
    if (scope.local?.has(ref.schema ? `${ref.schema.toLowerCase()}.${lname}` : lname) || (inDefault && scope.local?.has(lname))) {
      ref.unknown = true;
      continue;
    }
    const table = findTable(known, ref.name, ref.schema, scope.schema);
    if (table) {
      ref.table = table;
      continue;
    }
    ref.unknown = true;
    const where = ref.schema ?? scope.schema;
    // 조회하지 않은 스키마면 없다고 단정하지 않는다
    if (!where || !schemas.has(where.toLowerCase())) continue;
    // PostgreSQL은 pg_catalog를 search_path 맨 앞에 둔다
    if (!ref.schema && scope.driver === 'postgres' && lname.startsWith('pg_')) continue;
    problems.push({ start: ref.nameTok.start, end: ref.nameTok.end, code: 'unresolved-table', message: `Unable to resolve table '${ref.name}'` });
  }

  // 한정자 → 후보 참조(같은 별칭이 서브쿼리마다 다를 수 있다)
  const byQualifier = new Map<string, Ref[]>();
  const add = (key: string, r: Ref) => byQualifier.set(key.toLowerCase(), [...(byQualifier.get(key.toLowerCase()) ?? []), r]);
  for (const r of refs) {
    if (r.alias) add(r.alias, r);
    else add(r.name, r);
  }
  const missing = (rs: Ref[] | undefined, column: Token) =>
    !!rs?.length && rs.every((r) => r.table && !r.table.partial && r.table.columns.length > 0 && !hasColumn(r.table, column, scope.driver));
  const columnProblem = (tok: Token, rs: Ref[]) =>
    problems.push({
      start: tok.start,
      end: tok.end,
      code: 'unresolved-column',
      message: `Unable to resolve column '${identName(tok)}'${rs.length === 1 ? ` in ${rs[0].table!.name}` : ''}`,
    });

  // a.col
  for (let k = 0; k + 2 < code.length; k++) {
    const q = code[k];
    const col = code[k + 2];
    if (!isIdent(q) || code[k + 1].text !== '.' || !isIdent(col)) continue;
    if (q.open || col.open || refTokens.has(q) || code[k - 1]?.text === '.' || code[k + 3]?.text === '.' || code[k + 3]?.text === '(') continue;
    const rs = byQualifier.get(identName(q).toLowerCase());
    if (missing(rs, col)) columnProblem(col, rs!);
    k += 2;
  }

  // INSERT INTO t (a, b)
  if (first === 'INSERT' || first === 'REPLACE') {
    const target = refs[0];
    const at = target ? code.indexOf(target.nameTok) : -1;
    if (target?.table && !target.alias && code[at + 1]?.text === '(') {
      for (let k = at + 2; k < code.length && code[k].text !== ')'; k++) {
        if (isIdent(code[k]) && missing([target], code[k])) columnProblem(code[k], [target]);
      }
    }
  }

  // UPDATE t SET a = …, b = …
  if (first === 'UPDATE') {
    const set = code.findIndex((t) => upper(t) === 'SET');
    const targets = refs.filter((r) => code.indexOf(r.nameTok) < set);
    if (set > 0 && targets.length === 1 && targets[0].table) {
      let depth = 0;
      for (let k = set + 1; k < code.length; k++) {
        const t = code[k];
        if (t.text === '(') depth++;
        else if (t.text === ')') depth--;
        if (depth > 0) continue;
        if (['WHERE', 'FROM', 'RETURNING', 'ORDER', 'LIMIT'].includes(upper(t) ?? '')) break;
        const startsItem = code[k - 1] === code[set] || code[k - 1]?.text === ',';
        if (startsItem && isIdent(t) && code[k + 1]?.text === '=' && missing(targets, t)) columnProblem(t, targets);
      }
    }
  }

  unqualifiedColumns(code, refs, refTokens, opaque, problems, scope.driver, cteToks);
  // 같은 자리를 두 검사(INSERT 열 목록 · SET 대상과 한정하지 않은 열)가 함께 잡을 수 있다
  const seen = new Set<number>();
  return problems.filter((p) => !seen.has(p.start) && seen.add(p.start)).sort((a, b) => a.start - b.start);
}

/**
 * 한정하지 않은 열(SELECT nmae FROM users): 그 자리를 감싼 범위(서브쿼리)부터 바깥으로, 보이는 테이블 어디에도 없을 때만.
 * 보이는 범위에 열을 모르는 원본(서브쿼리 · 테이블 함수 · WITH 이름 · 메타데이터에 없거나 열을 안 읽은 테이블)이 있으면 넘긴다.
 * @param refs 문장의 테이블 참조(메타데이터에서 찾은 테이블 포함)
 * @param refTokens 테이블 이름 · 별칭 · WITH 이름 토큰(열로 보지 않는다)
 * @param opaque 열을 모르는 원본의 여는 ( 토큰
 * @param problems 찾은 문제를 여기에 더한다
 * @param cteToks WITH 이름 토큰(그 본문은 본 쿼리의 테이블을 볼 수 없다)
 */
function unqualifiedColumns(
  code: Token[],
  refs: Ref[],
  refTokens: Set<Token>,
  opaque: Token[],
  problems: Problem[],
  driver: DriverId,
  cteToks: Token[],
): void {
  if (!refs.length) return;
  const chains = parenChains(code);
  const scopeAt = (tok: Token) => innermostScope(chains, code, tok);
  const { skip, aliases } = nonColumnPositions(code, refTokens, chains, driver);
  // WITH 이름 (열 …) AS [NOT] [MATERIALIZED] ( 본문 ): 본문의 여는 ( 위치
  const cteBodies = new Set<number>();
  for (const name of cteToks) {
    let j = code.indexOf(name) + 1;
    if (code[j]?.text === '(') j = closeOf(code, j) + 1;
    if (upper(code[j]) !== 'AS') continue;
    j++;
    if (upper(code[j]) === 'NOT') j++;
    if (upper(code[j]) === 'MATERIALIZED') j++;
    if (code[j]?.text === '(') cteBodies.add(j);
  }
  const byScope = new Map<number, Ref[]>();
  for (const r of refs) {
    const s = scopeAt(r.nameTok);
    byScope.set(s, [...(byScope.get(s) ?? []), r]);
  }
  // 열을 모르는 원본: 놓인 범위와 그 괄호 위치(그 괄호 안의 토큰에게는 자기 자신이라 보이지 않는다)
  const opaqueAt = opaque.map((t) => ({ scope: scopeAt(t), paren: code.indexOf(t) }));
  // 열 대신 쓸 수 있는 이름: 별칭 · 테이블 이름(PostgreSQL 행 참조) · WITH 이름 · 출력 별칭(ORDER BY · GROUP BY에서)
  const names = new Set<string>(aliases);
  for (const r of refs) names.add((r.alias ?? r.name).toLowerCase()).add(r.name.toLowerCase());
  for (let k = 1; k < code.length; k++) {
    const t = code[k];
    const prev = code[k - 1];
    if (!isIdent(t) || refTokens.has(t)) continue;
    if (NAME_AFTER.has(upper(prev) ?? '')) names.add(identName(t).toLowerCase());
    // AS 없이 붙인 별칭: name n · count(*) c · 'x' label · 1 one
    else if (
      (prev?.text === ')' || prev?.type === 'string' || prev?.type === 'number' || (isIdent(prev) && !BEFORE_COLUMN.has(upper(prev) ?? ''))) &&
      code[k + 1]?.text !== '(' && code[k + 1]?.text !== '.'
    )
      names.add(identName(t).toLowerCase());
  }

  // 0번은 문장 첫 키워드(REPLACE INTO의 REPLACE 등)라 열이 아니다
  for (let k = 1; k < code.length; k++) {
    const t = code[k];
    if (!isIdent(t) || t.open || refTokens.has(t) || skip.has(k)) continue;
    const prev = code[k - 1];
    const next = code[k + 1];
    // a.b · f(…) · ::type · DATE '…' 같은 형식 리터럴 · SQLite $이름 매개변수
    if (prev?.text === '.' || next?.text === '.' || next?.text === '(' || prev?.text === ':' || next?.type === 'string') continue;
    if (prev?.text === '$' && prev.end === t.start) continue;
    const w = t.type === 'word' ? t.text.toUpperCase() : undefined;
    if (w && (NOT_COLUMN_WORDS.has(w) || RESERVED.has(w) || w.startsWith('SQL_'))) continue;
    if (isIdent(prev) && !BEFORE_COLUMN.has(upper(prev) ?? '')) continue;
    const name = identName(t);
    if (names.has(name.toLowerCase())) continue;

    let found = false;
    let unsure = false;
    // CTE 본문은 그 WITH가 붙은 쿼리의 FROM을 보지 못한다. 그보다 바깥 쿼리(WITH가 서브쿼리 안에 있을 때)는 보인다
    const chain = chains[k];
    const visible = chain.filter((_, i) => !cteBodies.has(chain[i + 1]));
    for (const scope of visible) {
      if (opaqueAt.some((o) => o.scope === scope && !chain.includes(o.paren))) unsure = true;
      for (const r of byScope.get(scope) ?? []) {
        if (r.unknown || !r.table || r.table.partial || r.table.columns.length === 0) unsure = true;
        else if (hasColumn(r.table, t, driver)) found = true;
      }
    }
    if (found || unsure) continue;
    problems.push({ start: t.start, end: t.end, code: 'unresolved-column', message: `Unable to resolve column '${name}'` });
  }
}

/** 이 테이블에 열이 있는가. PostgreSQL · H2에서 따옴표로 감싼 이름은 대소문자까지 같아야 한다(따옴표 없는 이름만 접힌다) */
function hasColumn(table: MetaTable, tok: Token, driver: DriverId): boolean {
  const name = identName(tok);
  const exact = tok.type === 'quoted' && (driver === 'postgres' || driver === 'h2');
  return table.columns.some((c) => (exact ? c.name === name : same(c.name, name)));
}

/**
 * 열 자리처럼 보여도 열이 아닌 토큰 위치(skip)와, 열 대신 쓸 수 있는 이름(aliases):
 *  - SQLite 충돌 처리: INSERT · UPDATE OR REPLACE / IGNORE / ABORT / FAIL / ROLLBACK
 *  - 인덱스: SQLite INDEXED BY 이름 · NOT INDEXED, MySQL USE / FORCE / IGNORE INDEX|KEY [FOR …] (이름 …)
 *  - 이름 붙인 인자: f(name => 1) · f(name := 1) (PostgreSQL)
 *  - 형식: TIMESTAMP / TIME WITH[OUT] TIME ZONE, IS [NOT] JSON
 *  - MySQL 전문 검색: IN BOOLEAN MODE · IN NATURAL LANGUAGE MODE
 *  - JSON_TABLE … COLUMNS (열 정의 …)
 *  - 타입 · 문자 집합: MySQL · H2 CONVERT(식, 타입), CHARACTER SET 이름, 함수 안의 RETURNING 타입(JSON_VALUE 등)
 *  - MySQL 파티션 선택: 테이블 PARTITION (이름 …)
 *  - PostgreSQL 유니코드 문자열 U&'…'의 U
 *  - 열 별칭 목록(aliases): 별칭(a, b) · AS 이름(a, b) · WITH 이름(a, b) — 뒤에서 열처럼 쓰인다
 * @param chains parenChains(code)의 결과
 */
function nonColumnPositions(code: Token[], refTokens: Set<Token>, chains: number[][], driver: DriverId): { skip: Set<number>; aliases: Set<string> } {
  const skip = new Set<number>();
  const aliases = new Set<string>();
  const w = (k: number) => upper(code[k]) ?? '';
  const adjacent = (a: Token | undefined, b: Token | undefined) => !!a && !!b && a.end === b.start;
  const group = (open: number, into: (k: number) => void) => {
    const close = closeOf(code, open);
    for (let j = open + 1; j < close; j++) into(j);
    return close;
  };
  for (let k = 0; k < code.length; k++) {
    const t = code[k];
    const next = code[k + 1];
    if (w(k) === 'OR' && (w(k - 1) === 'INSERT' || w(k - 1) === 'UPDATE') && CONFLICT.has(w(k + 1))) skip.add(k + 1);
    if (w(k) === 'INDEXED' && (w(k + 1) === 'BY' || w(k - 1) === 'NOT')) {
      skip.add(k);
      if (w(k + 1) === 'BY') skip.add(k + 2);
    }
    if (['USE', 'FORCE', 'IGNORE'].includes(w(k)) && (w(k + 1) === 'INDEX' || w(k + 1) === 'KEY')) {
      let j = k + 2;
      if (w(j) === 'FOR') j += w(j + 1) === 'JOIN' ? 2 : 3;
      if (code[j]?.text === '(') k = group(j, (x) => skip.add(x));
      continue;
    }
    if (isIdent(t) && (next?.text === '=>' || next?.text === ':=' || (next?.text === '=' && code[k + 2]?.text === '>' && adjacent(next, code[k + 2])) || (next?.text === ':' && code[k + 2]?.text === '=' && adjacent(next, code[k + 2])))) {
      skip.add(k);
    }
    if ((w(k) === 'TIMESTAMP' || w(k) === 'TIME') && (w(k + 1) === 'WITH' || w(k + 1) === 'WITHOUT') && w(k + 2) === 'TIME') skip.add(k);
    if (w(k) === 'JSON' && (w(k - 1) === 'IS' || (w(k - 1) === 'NOT' && w(k - 2) === 'IS'))) skip.add(k);
    if (w(k + 1) === 'MODE' && ((w(k) === 'BOOLEAN' && w(k - 1) === 'IN') || (w(k) === 'LANGUAGE' && w(k - 1) === 'NATURAL' && w(k - 2) === 'IN'))) skip.add(k);
    if ((w(k) === 'COLUMNS' || w(k) === 'PARTITION') && next?.text === '(') {
      k = group(k + 1, (x) => skip.add(x));
      continue;
    }
    // CONVERT(식, 타입): 첫 쉼표 뒤는 타입이다(PostgreSQL convert는 인자가 모두 식이라 제외)
    if ((driver === 'mysql' || driver === 'h2') && w(k) === 'CONVERT' && next?.text === '(') {
      const close = closeOf(code, k + 1);
      let depth = 0;
      for (let j = k + 2; j < close; j++) {
        if (code[j].text === '(') depth++;
        else if (code[j].text === ')') depth--;
        else if (depth === 0 && code[j].text === ',') {
          for (let x = j + 1; x < close; x++) skip.add(x);
          break;
        }
      }
    }
    if (w(k - 1) === 'SET' && w(k - 2) === 'CHARACTER') skip.add(k);
    // 함수 괄호 안의 단어들. DML의 RETURNING 열 · JOIN … ON 열과 구분한다
    const open = chains[k][chains[k].length - 1];
    const fn = isCallParen(code, open) ? w(open - 1) : '';
    // JSON_VALUE(… RETURNING int)의 타입
    if (fn && w(k) === 'RETURNING' && isIdent(next)) skip.add(k + 1);
    // SQL/JSON: … ON EMPTY · ON ERROR · OMIT QUOTES ON SCALAR STRING, ERROR ON ERROR · EMPTY ON EMPTY
    if (fn && w(k - 1) === 'ON' && ['EMPTY', 'ERROR', 'SCALAR'].includes(w(k))) skip.add(k);
    if (fn && ['EMPTY', 'ERROR'].includes(w(k)) && w(k + 1) === 'ON') skip.add(k);
    // 첫 인자가 열이 아닌 함수: EXTRACT(필드 FROM …) · GET_FORMAT(DATE, …) · XMLELEMENT(NAME 이름, …) · XMLPI(NAME 이름 …)
    if (code[k - 1]?.text === '(' && (fn === 'EXTRACT' || fn === 'GET_FORMAT' || ((fn === 'XMLELEMENT' || fn === 'XMLPI') && w(k) === 'NAME'))) skip.add(k);
    // 유니코드 정규형: x IS [NOT] NFC NORMALIZED · normalize(x, NFC)
    const nf = ['NFC', 'NFD', 'NFKC', 'NFKD'].includes(w(k));
    if ((nf && (w(k + 1) === 'NORMALIZED' || (fn === 'NORMALIZE' && code[k - 1]?.text === ','))) || (w(k) === 'NORMALIZED' && (w(k - 1) === 'IS' || w(k - 1) === 'NOT'))) skip.add(k);
    // COLLATION FOR (식) (PostgreSQL)
    if (w(k) === 'COLLATION' && w(k + 1) === 'FOR') skip.add(k);
    // SELECT TOP n (H2 · SQL Server 문법)
    if (w(k) === 'TOP' && ['SELECT', 'DISTINCT', 'ALL'].includes(w(k - 1)) && (next?.type === 'number' || next?.text === '(')) skip.add(k);
    // U&'…' 유니코드 문자열의 U, U&"…" 유니코드 식별자(이스케이프를 풀지 않으므로 판정하지 않는다)
    if (w(k) === 'U' && next?.text === '&' && adjacent(t, next) && (code[k + 2]?.type === 'string' || code[k + 2]?.type === 'quoted') && adjacent(next, code[k + 2])) {
      skip.add(k);
      if (code[k + 2].type === 'quoted') skip.add(k + 2);
    }
    // 별칭(열 …): FROM users u(a, b) · VALUES (…) AS n (i, m) · WITH c(a, b) AS
    // INSERT INTO [s.]t (열 …)의 테이블 이름은 제외한다(그 목록은 실제 열이다)
    const tableName = w(k - 1) === 'INTO' || code[k - 1]?.text === '.';
    // AS MATERIALIZED ( 본문 )은 별칭 목록이 아니라 CTE 본문이다
    if (isIdent(t) && next?.text === '(' && ((refTokens.has(t) && !tableName) || (w(k - 1) === 'AS' && w(k) !== 'MATERIALIZED'))) {
      group(k + 1, (x) => {
        if (isIdent(code[x])) aliases.add(identName(code[x]).toLowerCase());
      });
    }
  }
  return { skip, aliases };
}
