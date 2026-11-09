import { tokenize, type SqlDialect, type Token } from './tokenizer';

export interface Statement {
  text: string;
  /** 문서 안에서의 오프셋(첫 토큰 시작 ~ 마지막 토큰 끝, 세미콜론 제외) */
  start: number;
  end: number;
  tokens: Token[];
}

/** PL/pgSQL이 아닌 BEGIN … END 블록(트리거·프로시저 본문) 안의 세미콜론은 문장을 끊지 않는다. */
const BLOCK_OPENERS = new Set(['BEGIN', 'CASE']);
/** MySQL 프로시저의 END IF / END LOOP … 는 BEGIN을 닫지 않는다(여는 쪽도 세지 않으므로). */
const NON_BLOCK_ENDS = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR']);
/**
 * BEGIN이 이 앞뒤에 있으면 열 · 별칭 이름이다(PostgreSQL · MySQL에서 begin은 예약어가 아니다):
 * SELECT begin FROM t, a.begin, begin = 1, ORDER BY begin, count(begin) …
 * 블록 BEGIN은 ) · ROW · AS · DO · THEN · 레이블: 뒤에 오고, 뒤에 문장이 이어진다.
 */
const NAME_BEFORE = new Set(['SELECT', 'DISTINCT', 'WHERE', 'AND', 'OR', 'BY', 'ON', 'SET', ',', '.', '(', '=', '<', '>', '+', '-', '*', '/']);
const NAME_AFTER = new Set(['FROM', 'AS', 'IS', 'IN', 'ASC', 'DESC', ',', '.', ')', '=', '<', '>', '+', '-', '*', '/']);

export function splitStatements(text: string, dialect?: SqlDialect): Statement[] {
  if (dialect === 'mysql' && DELIMITER_LINE.test(text)) return splitMysqlScript(text);
  return splitTokens(text, tokenize(text, dialect));
}

/** 토큰을 ; 로 나눈다(BEGIN … END 블록 안의 ; 는 넘긴다) */
function splitTokens(text: string, tokens: Token[]): Statement[] {
  const out: Statement[] = [];
  let current: Token[] = [];
  let depth = 0;

  const flush = () => {
    const code = current.filter((t) => t.type !== 'comment');
    if (code.length > 0) {
      const start = code[0].start;
      const end = code[code.length - 1].end;
      out.push({ text: text.slice(start, end), start, end, tokens: current.filter((t) => t.start >= start) });
    }
    current = [];
    depth = 0;
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'punct' && t.text === ';' && depth === 0) {
      flush();
      continue;
    }
    if (t.type === 'word') {
      const w = t.text.toUpperCase();
      const next = tokens[k + 1]?.text.toUpperCase();
      // 문장 맨 앞의 BEGIN은 트랜잭션 시작이다(BEGIN · BEGIN TRANSACTION · BEGIN WORK · SQLite BEGIN IMMEDIATE/DEFERRED/EXCLUSIVE ·
      // PostgreSQL BEGIN ISOLATION LEVEL …). 블록 BEGIN(트리거 · 프로시저 본문)은 CREATE … 뒤에 오므로 문장 맨 앞이 아니다.
      const atStart = !current.some((x) => x.type !== 'comment');
      let prev: Token | undefined;
      for (let j = current.length - 1; j >= 0 && !prev; j--) if (current[j].type !== 'comment') prev = current[j];
      const asName = NAME_BEFORE.has(prev?.text.toUpperCase() ?? '') || NAME_AFTER.has(next ?? '');
      if (w === 'BEGIN' && (atStart || asName || next === undefined || next === ';' || next === 'TRANSACTION' || next === 'WORK')) {
        // 블록 아님
      } else if (BLOCK_OPENERS.has(w)) {
        depth++;
      } else if (w === 'END' && depth > 0 && !NON_BLOCK_ENDS.has(next ?? '')) {
        depth--;
      }
    }
    current.push(t);
  }
  flush();
  return out;
}

/** mysql 클라이언트 지시어 `DELIMITER //` (줄 맨 앞). 서버로 보내는 SQL이 아니다 */
const DELIMITER_LINE = /^[ \t]*delimiter[ \t]+\S/im;

/**
 * DELIMITER를 쓰는 MySQL 스크립트(프로시저 · 트리거 덤프):
 *   DELIMITER //
 *   CREATE PROCEDURE p() BEGIN SELECT 1; END//
 *   DELIMITER ;
 * DELIMITER 줄을 경계로 구간을 나눠, ; 구간은 평소대로, 그 밖의 구간은 그 구분자로 나눈다.
 * 구분자는 문자열 · 주석 밖에서만 찾는다. `END$$`는 낱말 하나로 토큰이 되므로 토큰이 아니라 원문 위치로 찾는다.
 */
function splitMysqlScript(text: string): Statement[] {
  const tokens = tokenize(text, 'mysql');
  const inLiteral = new Uint8Array(text.length);
  for (const t of tokens) if (t.type === 'string' || t.type === 'quoted' || t.type === 'comment') inLiteral.fill(1, t.start, t.end);
  const free = (at: number, len: number) => !inLiteral.subarray(at, at + len).some((x) => x === 1);

  const out: Statement[] = [];
  const directive = /^[ \t]*delimiter[ \t]+(\S+)[^\r\n]*/gim;
  let delimiter = ';';
  let pos = 0;
  for (;;) {
    let m: RegExpExecArray | null;
    directive.lastIndex = pos;
    // 문자열 · 주석 안의 "DELIMITER"는 지시어가 아니다
    while ((m = directive.exec(text)) && !free(m.index + m[0].search(/\S/), 1));
    const end = m ? m.index : text.length;
    if (delimiter === ';') {
      out.push(...splitTokens(text, tokens.filter((t) => t.start >= pos && t.end <= end)));
    } else {
      for (let from = pos; from < end; ) {
        let at = text.indexOf(delimiter, from);
        while (at >= 0 && at < end && !free(at, delimiter.length)) at = text.indexOf(delimiter, at + 1);
        const stop = at >= 0 && at < end ? at : end;
        const piece = text.slice(from, stop);
        const toks = tokenize(piece, 'mysql').map((t) => ({ ...t, start: t.start + from, end: t.end + from }));
        const code = toks.filter((t) => t.type !== 'comment');
        if (code.length) {
          const start = code[0].start;
          const last = code[code.length - 1].end;
          out.push({ text: text.slice(start, last), start, end: last, tokens: toks.filter((t) => t.start >= start) });
        }
        from = stop + delimiter.length;
      }
    }
    if (!m) return out;
    delimiter = m[1];
    pos = m.index + m[0].length;
  }
}

/**
 * 커서 위치의 문장. 커서가 문장 사이 빈 곳에 있으면 바로 앞 문장(같은 줄 끝의 `;` 뒤 등)을 고른다.
 */
export function statementAt(statements: Statement[], offset: number): Statement | undefined {
  let before: Statement | undefined;
  for (const s of statements) {
    if (offset >= s.start && offset <= s.end + 1) return s;
    if (s.end < offset) before = s;
  }
  return before ?? statements[0];
}
