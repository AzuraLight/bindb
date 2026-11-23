import type { CodeStyle, DriverId } from '../drivers/types';
import { splitStatements } from '../language/splitter';
import { identName, isIdent, tokenize, upperWord, type Token } from '../language/tokenizer';
import { kw, tableName, withCodeStyle } from './ddl';

/*
 * 뷰 DDL 편집기(DataGrip의 Go to DDL → 고쳐서 Submit)에 쓰는 순수 함수들.
 * 출처: https://www.jetbrains.com/help/datagrip/modifying-source-code-of-database-objects.html
 */

/** 편집하는 뷰(스키마로 한정한 이름) */
export interface ViewName {
  schema: string;
  name: string;
}

/**
 * DB에 지금 저장된 뷰 하나. 본문만 다시 만들면 속성(보안 옵션 · CHECK OPTION · DEFINER · 열 목록)이 사라지므로
 * 머리(header)와 꼬리(trailer)를 DB에서 함께 읽어 편집기 DDL에 넣는다.
 */
export interface ViewSource {
  /** AS 뒤의 본문(구조 정보 읽기가 캐시하는 정의와 같은 출처) */
  definition: string;
  /** CREATE … VIEW 이름 [(열 …)] [WITH (옵션)] AS 까지 */
  header: string;
  /** 본문 뒤의 절(MySQL WITH … CHECK OPTION). 없으면 빈 글자 */
  trailer: string;
  materialized: boolean;
  /** SQLite: 이 뷰의 트리거(DROP VIEW가 함께 지우므로 다시 만든다) */
  triggers: string[];
}

/** 정의를 읽는 조회 하나(매개변수: postgres $1 · $2, 나머지 ?) */
export interface SourceQuery {
  sql: string;
  params: string[];
}

const backtick = (s: string) => '`' + s.split('`').join('``') + '`';

/**
 * 뷰 정의를 읽는 조회들. 첫 조회가 행을 돌려주지 않으면 뷰가 없는 것이다(나머지는 실행하지 않는다).
 *  - postgres: pg_get_viewdef(information_schema.views · pg_matviews와 같은 함수) + reloptions(security_barrier · security_invoker · check_option)
 *  - mysql: information_schema.views(본문 · CHECK_OPTION) + SHOW CREATE VIEW(ALGORITHM · DEFINER · SQL SECURITY · 열 목록)
 *  - h2: INFORMATION_SCHEMA.VIEWS
 *  - sqlite: sqlite_master의 CREATE VIEW 문 전체 + 그 뷰의 트리거
 */
export function viewSourceQueries(driver: DriverId, v: ViewName): SourceQuery[] {
  switch (driver) {
    case 'postgres':
      return [
        {
          sql: `SELECT pg_catalog.pg_get_viewdef(c.oid), c.relkind, pg_catalog.array_to_string(c.reloptions, ', ') FROM pg_catalog.pg_class c
                  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v', 'm')`,
          params: [v.schema, v.name],
        },
      ];
    case 'mysql':
      return [
        { sql: 'SELECT view_definition, check_option FROM information_schema.views WHERE table_schema = ? AND table_name = ?', params: [v.schema, v.name] },
        // SHOW는 자리 표시자를 받지 않는다 — 식별자를 인용해 넣는다
        { sql: `SHOW CREATE VIEW ${backtick(v.schema)}.${backtick(v.name)}`, params: [] },
      ];
    case 'h2':
      return [{ sql: 'SELECT VIEW_DEFINITION FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', params: [v.schema, v.name] }];
    case 'sqlite':
      return [
        { sql: "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?", params: [v.name] },
        { sql: "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE AND sql IS NOT NULL ORDER BY rowid", params: [v.name] },
      ];
  }
}

/**
 * viewSourceQueries를 차례로 실행해 뷰 정의를 읽는다.
 * @param run 조회 하나를 실행해 모든 행을 돌려주는 함수
 * @param style 만들어 넣는 머리(CREATE VIEW 이름 AS)의 코드 스타일. withCodeStyle은 await를 넘지 못해 여기서 적용한다
 * @returns 뷰가 없거나 정의를 볼 권한이 없으면 undefined
 */
export async function readViewSource(
  driver: DriverId,
  v: ViewName,
  run: (q: SourceQuery) => Promise<unknown[][]>,
  style?: CodeStyle,
): Promise<ViewSource | undefined> {
  const [first, ...rest] = viewSourceQueries(driver, v);
  const row = (await run(first))[0];
  if (!row || row[0] == null) return undefined;
  const more: unknown[][][] = [];
  for (const q of rest) more.push(await run(q));
  return withCodeStyle(style, () => viewSourceFromRows(driver, v, row, more));
}

/**
 * 조회 결과 → ViewSource.
 * @param row 첫 조회의 행
 * @param more 나머지 조회의 결과(viewSourceQueries 순서)
 */
export function viewSourceFromRows(driver: DriverId, v: ViewName, row: unknown[], more: unknown[][][] = []): ViewSource {
  /** 만들어 넣는 머리: CREATE VIEW 이름 [WITH (옵션)] AS */
  const makeHeader = (options = '') => `${kw('create view')} ${tableName(driver, v)}${options ? ` ${kw('with')} (${options})` : ''} ${kw('as')}`;
  const plainHeader = makeHeader();
  const text = String(row[0]);
  switch (driver) {
    case 'postgres': {
      const header = makeHeader(row[2] ? String(row[2]) : '');
      return { definition: text, header, trailer: '', materialized: row[1] === 'm', triggers: [] };
    }
    case 'mysql': {
      const create = more[0]?.[0]?.[1];
      const parsed = create == null ? undefined : parseViewDdl(String(create), 'mysql');
      const check = String(row[1] ?? 'NONE').toUpperCase();
      const trailer = check === 'CASCADED' || check === 'LOCAL' ? ` ${kw(`with ${check} check option`)}` : '';
      return { definition: text, header: parsed && !('error' in parsed) ? parsed.header : plainHeader, trailer, materialized: false, triggers: [] };
    }
    default: {
      const split = splitViewText(driver, text);
      const triggers = driver === 'sqlite' ? (more[0] ?? []).map((r) => String(r[0])) : [];
      if (split) return { definition: split.body, header: split.header, trailer: '', materialized: false, triggers };
      return { definition: text, header: plainHeader, trailer: '', materialized: false, triggers };
    }
  }
}

/**
 * 저장된 정의가 CREATE VIEW 문 전체면(SQLite, H2 1.x로 알려짐) 머리와 본문으로 나눈다.
 * 구조 정보 읽기가 캐시한 정의에도 쓴다(그대로 쓰면 편집기에 머리가 두 번 들어간다).
 * @returns 본문만이거나 읽지 못하면 undefined
 */
export function splitViewText(driver: DriverId, text: string): { header: string; body: string } | undefined {
  const parsed = /^\s*create\b/i.test(text) ? parseViewDdl(text, driver) : undefined;
  return parsed && !('error' in parsed) ? { header: parsed.header, body: parsed.body } : undefined;
}

/**
 * 두 정의가 같은가. 토큰으로 비교하므로 공백 · 줄바꿈 · 주석 · 끝의 ; 차이는 같다고 보고,
 * 문자열 리터럴 안의 차이는 다르다고 본다.
 */
export function sameDefinition(a: string, b: string, driver: DriverId): boolean {
  const toks = (s: string) => {
    const t = tokenize(s, driver)
      .filter((x) => x.type !== 'comment')
      .map((x) => x.text);
    while (t[t.length - 1] === ';') t.pop();
    return t;
  };
  const x = toks(a);
  const y = toks(b);
  return x.length === y.length && x.every((s, i) => s === y[i]);
}

/** 본문 · 머리 · 꼬리가 모두 같은가(Submit 때 DB에서 바뀌었는지 판단한다) */
export function sameSource(a: ViewSource, b: ViewSource, driver: DriverId): boolean {
  return sameDefinition(a.definition, b.definition, driver) && sameDefinition(a.header, b.header, driver) && sameDefinition(a.trailer, b.trailer, driver);
}

/** 편집기에 여는 DDL 글자: 머리 + 본문 + 꼬리 + ; */
export function viewDdlText(source: Pick<ViewSource, 'header' | 'definition' | 'trailer'>): string {
  return `${source.header}\n${source.definition.trim().replace(/;\s*$/, '')}${source.trailer};\n`;
}

/** parseViewDdl이 읽은 CREATE VIEW 문. 토큰 위치는 마이그레이션에서 글자를 바꾸는 데 쓴다 */
export interface ParsedView {
  /** 이름 토큰들(schema.name이면 2개) */
  nameParts: Token[];
  create: Token;
  orReplace?: [Token, Token];
  ifNotExists?: [Token, Token, Token];
  /** AS 뒤의 본문 */
  body: string;
  /** CREATE부터 AS까지의 원문(속성 · 열 목록 포함) */
  header: string;
  /** 문장(앞뒤 공백 · 끝의 ; 없이)과 그 시작 오프셋 */
  text: string;
  start: number;
}

/**
 * CREATE [OR REPLACE] [… 속성 …] VIEW [IF NOT EXISTS] 이름 [(열 …)] [WITH (…)] AS 본문 을 읽는다.
 * 문장 하나여야 한다. MATERIALIZED VIEW는 거부한다(바꾸려면 지우고 다시 만들어야 해서 데이터 · 인덱스가 사라진다).
 * @returns 읽은 문장, 또는 사용자에게 보일 거부 이유
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
  return { nameParts, create: code[0], orReplace, ifNotExists, body, header: text.slice(s.start, as.end), text: text.slice(s.start, s.end), start: s.start };
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
 *  - sqlite: OR REPLACE가 없어 DROP VIEW IF EXISTS 뒤 CREATE VIEW, 이어서 DROP VIEW가 지운 트리거를 다시 만든다
 *    (부르는 쪽이 한 트랜잭션으로 묶는다 — 트리거를 다시 만들 수 없으면 모두 되돌린다)
 * 코드 스타일은 부르는 쪽의 withCodeStyle을 따른다.
 * @param ddl 편집기의 DDL(CREATE VIEW 문 하나)
 * @param v 편집기가 연 뷰(DDL의 이름이 이 뷰가 아니면 거부한다)
 * @param triggers SQLite: 지금 이 뷰에 걸린 트리거들의 CREATE TRIGGER 문
 * @returns 차례로 실행할 문장들, 또는 사용자에게 보일 거부 이유
 */
export function viewMigration(driver: DriverId, ddl: string, v: ViewName, triggers: readonly string[] = []): { statements: string[] } | { error: string } {
  const parsed = parseViewDdl(ddl, driver);
  if ('error' in parsed) return parsed;
  if (!namesView(parsed.nameParts, v, driver)) {
    const written = parsed.nameParts.map((t) => t.text).join('.');
    return { error: `Renaming is not supported: the DDL creates ${written}, but this editor is for ${v.schema}.${v.name}.` };
  }
  // 이름은 코드 스타일과 상관없이 늘 인용한다: "필요할 때만"은 소문자 · 일부 예약어만 보고 판단해,
  // H2(인용하지 않으면 대문자로 접는다)에서 다른 뷰를 만들거나 SQLite에서 예약어 이름이 구문 오류가 된다
  const qualified = withCodeStyle({ keywordCase: 'upper', quoteIdentifiers: 'always' }, () => tableName(driver, { schema: v.schema, name: v.name }));
  const at = (t: Token) => t.start - parsed.start;
  /** 토큰 끝(문장 기준 오프셋) */
  const endOf = (t: Token) => at(t) + t.text.length;
  // 뒤에서부터 바꿔야 앞의 오프셋이 어긋나지 않는다
  const edits: { from: number; to: number; text: string }[] = [
    { from: at(parsed.nameParts[0]), to: endOf(parsed.nameParts[parsed.nameParts.length - 1]), text: qualified },
  ];
  // 지우는 토큰 뒤의 공백도 함께 지운다(본문의 공백은 건드리지 않는다)
  const drop = (toks: Token[]) => {
    let to = endOf(toks[toks.length - 1]);
    while (/[ \t]/.test(parsed.text[to] ?? '')) to++;
    return { from: at(toks[0]), to, text: '' };
  };
  if (driver === 'sqlite') {
    if (parsed.orReplace) edits.push(drop(parsed.orReplace));
  } else {
    if (parsed.ifNotExists) edits.push(drop(parsed.ifNotExists));
    if (!parsed.orReplace) edits.push({ from: endOf(parsed.create), to: endOf(parsed.create), text: ` ${parsed.create.text === parsed.create.text.toLowerCase() ? 'or replace' : 'OR REPLACE'}` });
  }
  let sql = parsed.text;
  for (const e of edits.sort((a, b) => b.from - a.from)) sql = sql.slice(0, e.from) + e.text + sql.slice(e.to);
  if (driver === 'sqlite') return { statements: [`${kw('drop view if exists')} ${qualified}`, sql, ...triggers] };
  return { statements: [sql] };
}
