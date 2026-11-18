import type { DriverId, MetaTable } from '../drivers/types';
import { createdName, cteDeclarations, tableReferences } from './references';
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

export function unresolvedReferences(statement: Statement, scope: ResolveScope): Problem[] {
  const code = statement.tokens.filter((t) => t.type !== 'comment');
  const first = code[0]?.text === '(' ? upper(code.find((t) => t.text !== '(')) : upper(code[0]);
  if (!first || !ANALYZED.has(first)) return [];

  const ctes = new Set(cteDeclarations(code).map((t) => identName(t).toLowerCase()));
  const refs: Ref[] = [];
  const refTokens = new Set<Token>();
  for (const src of tableReferences(code, first)) {
    const parts = src.parts;
    for (const p of parts) refTokens.add(p);
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
  const missing = (rs: Ref[] | undefined, column: string) =>
    !!rs?.length && rs.every((r) => r.table && r.table.columns.length > 0 && !r.table.columns.some((c) => same(c.name, column)));
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
    if (missing(rs, identName(col))) columnProblem(col, rs!);
    k += 2;
  }

  // INSERT INTO t (a, b)
  if (first === 'INSERT' || first === 'REPLACE') {
    const target = refs[0];
    const at = target ? code.indexOf(target.nameTok) : -1;
    if (target?.table && !target.alias && code[at + 1]?.text === '(') {
      for (let k = at + 2; k < code.length && code[k].text !== ')'; k++) {
        if (isIdent(code[k]) && missing([target], identName(code[k]))) columnProblem(code[k], [target]);
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
        if (startsItem && isIdent(t) && code[k + 1]?.text === '=' && missing(targets, identName(t))) columnProblem(t, targets);
      }
    }
  }

  return problems.sort((a, b) => a.start - b.start);
}
