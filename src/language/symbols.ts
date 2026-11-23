import type { MetaTable } from '../drivers/types';
import { createdName, cteDeclarations, innermostScope, parenChains, RESERVED, tableReferences } from './references';
import type { Statement } from './splitter';
import { findTable, same } from './meta';
import { identName, isIdent, upperWord, type Token } from './tokenizer';

/*
 * 문서 안의 이름 위치(정의로 이동 · 사용처 찾기용). DataGrip의 Go to Declaration · Find Usages에 해당.
 * 같은 대상을 가리키는 위치는 같은 key를 갖는다:
 *  - t:schema.table   테이블 · 뷰(메타데이터로 풀거나, 문서의 CREATE로)
 *  - c:schema.table.column
 *  - a:<문장 시작>:alias   별칭(문장 안에서만)
 *  - q:<문장 시작>:cte     WITH 이름(문장 안에서만)
 * decl은 그 이름을 정의한 자리(별칭 선언, WITH 이름, CREATE TABLE · VIEW 이름과 열 정의)다.
 */

export interface Occurrence {
  start: number;
  end: number;
  key: string;
  decl?: boolean;
}

export interface SymbolScope {
  tables: readonly MetaTable[];
  /** 한정하지 않은 이름을 먼저 찾을 스키마 */
  schema?: string;
}

const upper = upperWord;
const tableKeyOf = (schema: string | undefined, name: string) => `t:${(schema ?? '').toLowerCase()}.${name.toLowerCase()}`;
const columnKeyOf = (tableKey: string, column: string) => `c:${tableKey.slice(2)}.${column.toLowerCase()}`;
/** 열 자리에 와도 열이 아닌 단어 */
const NOT_COLUMN = new Set([...RESERVED, 'TRUE', 'FALSE', 'NULL', 'IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'CASE', 'EXISTS', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST', 'DISTINCT', 'ALL', 'ANY', 'SOME', 'INTERVAL']);

interface Target {
  key: string;
  table?: MetaTable;
  /** 문서의 CREATE TABLE에서 읽은 열 이름(메타데이터에 없는 표) */
  localColumns?: string[];
}

/** ALTER TABLE x · DROP TABLE|VIEW [IF EXISTS] x, y · TRUNCATE [TABLE] x · CREATE INDEX … ON x 의 테이블 이름들 */
function ddlTargets(code: Token[]): Token[][] {
  const out: Token[][] = [];
  const read = (k: number): number => {
    while (['IF', 'EXISTS', 'ONLY'].includes(upper(code[k]) ?? '')) k++;
    if (!isIdent(code[k])) return -1;
    const parts = [code[k]];
    k++;
    while (code[k]?.text === '.' && isIdent(code[k + 1])) {
      parts.push(code[k + 1]);
      k += 2;
    }
    out.push(parts);
    return k;
  };
  const w0 = upper(code[0]);
  const w1 = upper(code[1]);
  if (w0 === 'ALTER' && (w1 === 'TABLE' || w1 === 'VIEW')) read(2);
  else if (w0 === 'TRUNCATE') read(w1 === 'TABLE' ? 2 : 1);
  else if (w0 === 'DROP' && (w1 === 'TABLE' || w1 === 'VIEW')) {
    let k = read(2);
    while (k > 0 && code[k]?.text === ',') k = read(k + 1);
  } else if (w0 === 'CREATE') {
    const on = code.findIndex((t) => upper(t) === 'ON');
    if (on > 0 && code.slice(0, on).some((t) => upper(t) === 'INDEX')) read(on + 1);
  }
  return out;
}

/** 문서 전체(문장들)의 이름 위치 */
export function documentSymbols(statements: readonly Statement[], scope: SymbolScope): Occurrence[] {
  // 문서의 CREATE TABLE · VIEW: 메타데이터에 없어도 정의로 이동할 수 있게
  const local = new Map<string, string[]>();
  for (const s of statements) {
    const code = s.tokens.filter((t) => t.type !== 'comment');
    const c = createdName(code);
    if (!c) continue;
    const name = identName(c.parts[c.parts.length - 1]);
    const schema = c.parts.length > 1 ? identName(c.parts[c.parts.length - 2]) : scope.schema;
    local.set(tableKeyOf(schema, name), columnDefinitions(code, c.next).map(identName));
  }
  return statements.flatMap((s) => statementSymbols(s, scope, local));
}

/** CREATE TABLE t ( a int, b text, PRIMARY KEY (a) ) 의 열 이름 토큰 */
function columnDefinitions(code: Token[], k: number): Token[] {
  if (code[k]?.text !== '(') return [];
  const out: Token[] = [];
  let depth = 0;
  for (let j = k; j < code.length; j++) {
    const t = code[j];
    if (t.text === '(') depth++;
    else if (t.text === ')' && --depth === 0) break;
    else if (depth === 1 && (code[j - 1].text === '(' || code[j - 1].text === ',') && isIdent(t)) {
      const w = upper(t);
      if (w && ['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'KEY', 'INDEX', 'EXCLUDE', 'LIKE'].includes(w)) continue;
      out.push(t);
    }
  }
  return out;
}

function statementSymbols(s: Statement, scope: SymbolScope, local: Map<string, string[]>): Occurrence[] {
  const code = s.tokens.filter((t) => t.type !== 'comment');
  const first = code[0]?.text === '(' ? upper(code.find((t) => t.text !== '(')) : upper(code[0]);
  if (!first) return [];
  const out: Occurrence[] = [];
  const used = new Set<Token>();
  const add = (tok: Token, key: string, decl = false) => {
    if (tok.open) return;
    used.add(tok);
    out.push({ start: tok.start, end: tok.end, key, ...(decl ? { decl } : {}) });
  };

  const ctes = new Map<string, string>();
  for (const t of cteDeclarations(code)) {
    const key = `q:${s.start}:${identName(t).toLowerCase()}`;
    ctes.set(identName(t).toLowerCase(), key);
    add(t, key, true);
  }

  /** [schema.]table 토큰들을 대상으로 */
  const resolve = (parts: Token[]): Target | undefined => {
    if (parts.length > 2) return undefined;
    const name = identName(parts[parts.length - 1]);
    const schema = parts.length === 2 ? identName(parts[0]) : undefined;
    if (!schema && ctes.has(name.toLowerCase())) return { key: ctes.get(name.toLowerCase())! };
    const t = findTable(scope.tables, name, schema, scope.schema);
    if (t) return { key: tableKeyOf(t.schema, t.name), table: t };
    const key = tableKeyOf(schema ?? scope.schema, name);
    return { key, localColumns: local.get(key) };
  };
  const tableOcc = (parts: Token[], target: Target | undefined, decl = false) => {
    if (!target) return;
    add(parts[parts.length - 1], target.key, decl);
    // schema.table 의 schema 토큰은 다른 이름으로 잡히지 않게만 둔다
    for (const p of parts.slice(0, -1)) used.add(p);
  };
  const hasColumn = (target: Target, column: string) =>
    target.table ? target.table.columns.some((c) => same(c.name, column)) : !!target.localColumns?.some((c) => same(c, column));

  // CREATE TABLE · VIEW 이름과 열 정의
  const created = createdName(code);
  if (created) {
    const target = resolve(created.parts);
    tableOcc(created.parts, target && { key: target.key }, true);
    if (target) for (const c of columnDefinitions(code, created.next)) add(c, columnKeyOf(target.key, identName(c)), true);
  }
  for (const parts of ddlTargets(code)) tableOcc(parts, resolve(parts));

  // 괄호 범위: 서브쿼리마다 별칭 · 테이블이 따로다. 각 토큰을 감싼 ( 위치들(바깥 → 안, 맨 앞 -1 = 문장 전체)
  const chains = parenChains(code);
  const scopeOf = (tok: Token) => innermostScope(chains, code, tok);

  // FROM · JOIN … 의 테이블과 별칭(범위별)
  const aliases = new Map<string, { key: string; target: Target }>(); // `${범위}:${별칭}`
  const bare = new Map<string, Target>(); // `${범위}:${이름}`
  const sources = new Map<number, Target[]>();
  for (const ref of tableReferences(code, first)) {
    const nameTok = ref.parts[ref.parts.length - 1];
    const target = resolve(ref.parts);
    // db.schema.table — 다른 카탈로그는 풀지 않되, 조각이 다른 이름으로 잡히지 않게 한다
    if (!target) {
      for (const p of ref.parts) used.add(p);
      continue;
    }
    tableOcc(ref.parts, target);
    const scope = scopeOf(nameTok);
    sources.set(scope, [...(sources.get(scope) ?? []), target]);
    if (ref.alias) {
      const name = identName(ref.alias).toLowerCase();
      const key = `a:${s.start}:${scope}:${name}`;
      aliases.set(`${scope}:${name}`, { key, target });
      add(ref.alias, key, true);
    } else bare.set(`${scope}:${identName(nameTok).toLowerCase()}`, target);
  }
  /** k 위치에서 보이는 별칭 · 테이블 이름(안쪽 범위부터, 없으면 문장 어디서든) */
  const lookup = <V>(map: Map<string, V>, k: number, name: string): V | undefined => {
    const chain = chains[k] ?? [-1];
    for (let i = chain.length - 1; i >= 0; i--) {
      const v = map.get(`${chain[i]}:${name}`);
      if (v) return v;
    }
    for (const [key, v] of map) if (key.slice(key.indexOf(':') + 1) === name) return v;
    return undefined;
  };
  /** 한정자 하나(별칭 또는 테이블 이름)를 풀고 위치를 기록한다 */
  const qualifier = (tok: Token, k: number): Target | undefined => {
    const q = identName(tok).toLowerCase();
    const alias = lookup(aliases, k, q);
    if (alias) {
      add(tok, alias.key);
      return alias.target;
    }
    const target = lookup(bare, k, q);
    if (target) add(tok, target.key);
    return target;
  };

  // a.col · s.t.col (점으로 이은 이름을 한 덩어리로 읽는다. 네 조각 이상은 다른 카탈로그라 넘긴다)
  for (let k = 0; k < code.length; k++) {
    const t = code[k];
    if (!isIdent(t) || used.has(t) || code[k - 1]?.text === '.') continue;
    if (code[k + 1]?.text !== '.' || !isIdent(code[k + 2])) continue;
    const parts = [t];
    let j = k + 1;
    while (code[j]?.text === '.' && isIdent(code[j + 1])) {
      parts.push(code[j + 1]);
      j += 2;
    }
    k = j - 1;
    if (code[j]?.text === '(' || parts.length > 3) {
      // schema.fn(…) · db.schema.table.col
      for (const p of parts) used.add(p);
      continue;
    }
    const colTok = parts[parts.length - 1];
    let target: Target | undefined;
    if (parts.length === 3) {
      target = resolve(parts.slice(0, 2));
      tableOcc(parts.slice(0, 2), target);
    } else target = qualifier(t, code.indexOf(t));
    if (target && !target.key.startsWith('q:') && hasColumn(target, identName(colTok))) add(colTok, columnKeyOf(target.key, identName(colTok)));
    for (const p of parts) used.add(p);
  }

  // MySQL DELETE a, b FROM … / DELETE a.* FROM … : DELETE 와 FROM 사이는 지울 대상(별칭 · 테이블)
  if (first === 'DELETE' && upper(code[1]) !== 'FROM') {
    for (let k = 1; k < code.length && upper(code[k]) !== 'FROM'; k++) {
      if (isIdent(code[k]) && !used.has(code[k])) qualifier(code[k], k);
    }
  }

  // INSERT INTO t (a, b) … 의 열 목록은 대상 테이블의 열이다(뒤의 SELECT와 섞지 않는다)
  if (first === 'INSERT' || first === 'REPLACE') {
    const into = code.findIndex((t) => upper(t) === 'INTO');
    const refTok = code.slice(into + 1).find((t) => isIdent(t));
    let k = refTok ? code.indexOf(refTok) + 1 : -1;
    while (code[k]?.text === '.' && isIdent(code[k + 1])) k += 2;
    const target = refTok && lookup(bare, code.indexOf(refTok), identName(refTok).toLowerCase());
    if (target && code[k]?.text === '(') {
      for (let j = k + 1; j < code.length && code[j].text !== ')'; j++) {
        const c = code[j];
        if (isIdent(c) && !used.has(c) && hasColumn(target, identName(c))) add(c, columnKeyOf(target.key, identName(c)));
        else if (isIdent(c)) used.add(c);
      }
    }
    // 뒤의 SELECT · VALUES에서 한정하지 않은 열은 대상 테이블이 아니라 SELECT의 테이블에서 찾는다
    if (target) for (const [scope, list] of sources) sources.set(scope, list.filter((x) => x !== target));
  }

  // SELECT 목록의 출력 별칭(… AS name): ORDER BY에서 그 이름은 열이 아니라 출력 별칭이다
  const outputAliases = new Set<string>();
  for (let k = 1; k < code.length; k++) {
    if (upper(code[k - 1]) === 'AS' && isIdent(code[k]) && !used.has(code[k]) && code[k + 1]?.text !== '(') outputAliases.add(identName(code[k]).toLowerCase());
  }
  const afterOrderBy = (k: number) => {
    const depth = chains[k].length;
    for (let j = k - 1; j >= 0; j--) {
      if (chains[j].length !== depth) continue;
      const w = upper(code[j]);
      if (w === 'BY' && upper(code[j - 1]) === 'ORDER') return true;
      if (w && ['SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'UNION', 'INTERSECT', 'EXCEPT'].includes(w)) return false;
    }
    return false;
  };

  // 한정하지 않은 열: 안쪽 범위부터, 그 범위의 테이블 중 한 곳에만 있을 때
  for (let k = 0; k < code.length; k++) {
    const t = code[k];
    if (!isIdent(t) || used.has(t)) continue;
    if (code[k - 1]?.text === '.' || code[k + 1]?.text === '.' || code[k + 1]?.text === '(') continue;
    if (upper(code[k - 1]) === 'AS' || NOT_COLUMN.has(upper(t) ?? '')) continue;
    const name = identName(t);
    if (outputAliases.has(name.toLowerCase()) && afterOrderBy(k)) continue;
    const chain = chains[k];
    for (let i = chain.length - 1; i >= 0; i--) {
      const list = sources.get(chain[i]) ?? [];
      const owners = list.filter((x) => !x.key.startsWith('q:') && hasColumn(x, name));
      // 열을 모르는 원본(WITH 이름 · 메타데이터에 없는 테이블)이 함께 있으면 어느 쪽인지 단정하지 않는다
      if (list.some((x) => x.key.startsWith('q:') || (!x.table && !x.localColumns))) break;
      if (!owners.length) continue;
      if (new Set(owners.map((o) => o.key)).size === 1) add(t, columnKeyOf(owners[0].key, name));
      break;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** offset에 있는 이름 */
export function symbolAt(symbols: readonly Occurrence[], offset: number): Occurrence | undefined {
  return symbols.find((o) => o.start <= offset && offset < o.end) ?? symbols.find((o) => o.end === offset);
}

/** 대상이 메타데이터의 테이블 · 열이면 [schema, table, column?] */
export function dbObjectOf(key: string, scope: SymbolScope): { table: MetaTable; column?: string } | undefined {
  if (!key.startsWith('t:') && !key.startsWith('c:')) return undefined;
  for (const t of scope.tables) {
    const tk = tableKeyOf(t.schema, t.name);
    if (key === tk) return { table: t };
    if (key.startsWith(`c:${tk.slice(2)}.`)) {
      const col = t.columns.find((c) => columnKeyOf(tk, c.name) === key);
      if (col) return { table: t, column: col.name };
    }
  }
  return undefined;
}
