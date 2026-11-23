import type { DriverId } from '../drivers/types';
import { splitStatements } from '../language/splitter';
import { identName, isIdent, upperWord, type Token } from '../language/tokenizer';
import { ddlFor, kw, tableName } from './ddl';

/**
 * 뷰 DDL 편집기(DataGrip의 Go to DDL → 고쳐서 Submit)에 쓰는 순수 함수들.
 * 출처: https://www.jetbrains.com/help/datagrip/modifying-source-code-of-database-objects.html
 */

export interface ViewName {
  schema: string;
  name: string;
}

/** DB에 지금 저장된 뷰 정의를 읽는 쿼리(매개변수: postgres $1 · $2, 나머지 ?). 구조 정보 읽기와 같은 출처를 쓴다 */
export function viewDefinitionQuery(driver: DriverId, v: ViewName): { sql: string; params: string[] } {
  switch (driver) {
    case 'postgres':
      // information_schema.views.view_definition · pg_matviews.definition과 같은 pg_get_viewdef(oid)
      return {
        sql: `SELECT pg_catalog.pg_get_viewdef(c.oid), c.relkind FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v', 'm')`,
        params: [v.schema, v.name],
      };
    case 'mysql':
      return { sql: 'SELECT view_definition FROM information_schema.views WHERE table_schema = ? AND table_name = ?', params: [v.schema, v.name] };
    case 'h2':
      return { sql: 'SELECT VIEW_DEFINITION FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', params: [v.schema, v.name] };
    case 'sqlite':
      // sqlite_master.sql은 CREATE VIEW 문 전체다 — 본문은 viewBodyOf로 꺼낸다
      return { sql: "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?", params: [v.name] };
  }
}

/** 조회 결과 한 행 → 정의(본문)와 머티리얼라이즈드 여부. 행이 없으면 undefined(뷰가 없거나 정의를 볼 권한이 없다) */
export function definitionFromRow(driver: DriverId, row: unknown[] | undefined): { definition: string; materialized: boolean } | undefined {
  if (!row || row[0] == null) return undefined;
  const text = String(row[0]);
  if (driver === 'sqlite') {
    const parsed = parseViewDdl(text, 'sqlite');
    return { definition: 'error' in parsed ? text : parsed.body, materialized: false };
  }
  return { definition: text, materialized: driver === 'postgres' && row[1] === 'm' };
}

/** 두 정의가 같은가(공백 · 줄바꿈 · 끝의 ; 차이는 같다고 본다) */
export function sameDefinition(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/;\s*$/, '').trim();
  return norm(a) === norm(b);
}

/** 편집기에 여는 DDL 글자(CREATE VIEW 이름 AS 정의;). 코드 스타일은 부르는 쪽의 withCodeStyle을 따른다 */
export function viewDdlText(driver: DriverId, v: ViewName, definition: string): string {
  return ddlFor(driver, { kind: 'view', schema: v.schema, name: v.name, columns: [], definition });
}

export interface ParsedView {
  /** 이름 토큰들(schema.name이면 2개) */
  nameParts: Token[];
  /** CREATE 토큰 */
  create: Token;
  /** OR REPLACE 토큰(있으면) */
  orReplace?: [Token, Token];
  /** IF NOT EXISTS 토큰(있으면) */
  ifNotExists?: [Token, Token, Token];
  /** AS 뒤의 본문 */
  body: string;
  /** 문장(앞뒤 공백 · 끝의 ; 없이)과 그 시작 오프셋 */
  text: string;
  start: number;
}

/**
 * CREATE [OR REPLACE] [… 속성 …] VIEW [IF NOT EXISTS] 이름 [(열 …)] [WITH (…)] AS 본문 을 읽는다.
 * 문장 하나여야 한다. MATERIALIZED VIEW는 거부한다(바꾸려면 지우고 다시 만들어야 해서 데이터 · 인덱스가 사라진다).
 */
export function parseViewDdl(text: string, driver: DriverId): ParsedView | { error: string } {
  const statements = splitStatements(text, driver).filter((s) => s.tokens.some((t) => t.type !== 'comment'));
  if (statements.length !== 1) return { error: 'The DDL must be exactly one CREATE VIEW statement.' };
  const s = statements[0];
  const code = s.tokens.filter((t) => t.type !== 'comment');
  if (upperWord(code[0]) !== 'CREATE') return { error: 'The DDL must start with CREATE VIEW.' };
  // VIEW 키워드: CREATE와 VIEW 사이에는 OR REPLACE · ALGORITHM = … · DEFINER = … · SQL SECURITY … · TEMP 같은 속성만 온다
  let k = 1;
  let orReplace: ParsedView['orReplace'];
  while (k < code.length && upperWord(code[k]) !== 'VIEW') {
    const w = upperWord(code[k]);
    if (w === 'MATERIALIZED') return { error: 'Materialized views cannot be edited here yet: changing one means dropping it, which loses its data and indexes.' };
    if (w === 'AS' || code[k].text === '(') return { error: 'The DDL must be a CREATE VIEW statement.' };
    if (w === 'OR' && upperWord(code[k + 1]) === 'REPLACE') orReplace = [code[k], code[k + 1]];
    k++;
  }
  if (k >= code.length) return { error: 'The DDL must be a CREATE VIEW statement.' };
  k++;
  let ifNotExists: ParsedView['ifNotExists'];
  if (upperWord(code[k]) === 'IF' && upperWord(code[k + 1]) === 'NOT' && upperWord(code[k + 2]) === 'EXISTS') {
    ifNotExists = [code[k], code[k + 1], code[k + 2]];
    k += 3;
  }
  const nameParts: Token[] = [];
  while (isIdent(code[k])) {
    nameParts.push(code[k]);
    if (code[k + 1]?.text !== '.') break;
    k += 2;
  }
  if (!nameParts.length) return { error: 'The view name is missing after CREATE VIEW.' };
  // 이름 뒤 첫 AS(괄호 밖): (열 목록) · WITH (옵션) 은 건너뛴다
  let depth = 0;
  let as: Token | undefined;
  for (k = code.indexOf(nameParts[nameParts.length - 1]) + 1; k < code.length; k++) {
    const t = code[k];
    if (t.text === '(') depth++;
    else if (t.text === ')') depth--;
    else if (depth === 0 && upperWord(t) === 'AS') {
      as = t;
      break;
    }
  }
  if (!as) return { error: 'AS and the query are missing after the view name.' };
  const body = text.slice(as.end, s.end).trim();
  if (!body) return { error: 'The query after AS is empty.' };
  return { nameParts, create: code[0], orReplace, ifNotExists, body, text: text.slice(s.start, s.end), start: s.start };
}

/** 편집한 DDL이 이 뷰를 가리키는가(이름을 바꾸는 것은 지원하지 않는다) */
function namesView(parts: Token[], v: ViewName, driver: DriverId): boolean {
  // 인용하지 않은 이름은 대소문자를 가리지 않고 비교한다(DB마다 접는 방향이 달라 엄격히 맞추지 않는다)
  const eq = (tok: Token, want: string) => (tok.type === 'quoted' ? identName(tok) === want : tok.text.toLowerCase() === want.toLowerCase());
  const name = parts[parts.length - 1];
  if (parts.length > 2) return false;
  if (!eq(name, v.name)) return false;
  if (parts.length === 2 && driver !== 'sqlite') return eq(parts[0], v.schema);
  if (parts.length === 2) return eq(parts[0], 'main') || eq(parts[0], v.schema);
  return true;
}

/**
 * Submit할 마이그레이션 문장들. 이름은 스키마로 한정한다(세션의 현재 스키마와 상관없이 같은 뷰를 바꾸도록).
 *  - postgres · mysql · h2: CREATE OR REPLACE VIEW (속성 · 열 목록 · 옵션은 쓴 그대로)
 *  - sqlite: OR REPLACE가 없어 DROP VIEW 뒤 CREATE VIEW (부르는 쪽이 한 트랜잭션으로 묶는다)
 * 코드 스타일은 부르는 쪽의 withCodeStyle을 따른다.
 */
export function viewMigration(driver: DriverId, ddl: string, v: ViewName): { statements: string[] } | { error: string } {
  const parsed = parseViewDdl(ddl, driver);
  if ('error' in parsed) return parsed;
  if (!namesView(parsed.nameParts, v, driver)) {
    const written = parsed.nameParts.map((t) => t.text).join('.');
    return { error: `Renaming is not supported: the DDL creates ${written}, but this editor is for ${v.schema}.${v.name}.` };
  }
  const qualified = tableName(driver, { schema: v.schema, name: v.name });
  const at = (t: Token) => t.start - parsed.start;
  // 뒤에서부터 바꿔야 앞의 오프셋이 어긋나지 않는다
  const edits: { from: number; to: number; text: string }[] = [
    { from: at(parsed.nameParts[0]), to: at(parsed.nameParts[parsed.nameParts.length - 1]) + parsed.nameParts[parsed.nameParts.length - 1].text.length, text: qualified },
  ];
  // 지우는 토큰 뒤의 공백도 함께 지운다(본문의 공백은 건드리지 않는다)
  const drop = (toks: Token[]) => {
    let to = at(toks[toks.length - 1]) + toks[toks.length - 1].text.length;
    while (/[ \t]/.test(parsed.text[to] ?? '')) to++;
    return { from: at(toks[0]), to, text: '' };
  };
  if (driver === 'sqlite') {
    if (parsed.orReplace) edits.push(drop(parsed.orReplace));
  } else {
    if (parsed.ifNotExists) edits.push(drop(parsed.ifNotExists));
    if (!parsed.orReplace) edits.push({ from: at(parsed.create) + parsed.create.text.length, to: at(parsed.create) + parsed.create.text.length, text: ` ${parsed.create.text === parsed.create.text.toLowerCase() ? 'or replace' : 'OR REPLACE'}` });
  }
  let sql = parsed.text;
  for (const e of edits.sort((a, b) => b.from - a.from)) sql = sql.slice(0, e.from) + e.text + sql.slice(e.to);
  if (driver === 'sqlite') return { statements: [`${kw('drop view')} ${qualified}`, sql] };
  return { statements: [sql] };
}
