import { tokenize, type Token } from './tokenizer';

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

export function splitStatements(text: string): Statement[] {
  const tokens = tokenize(text);
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
      // BEGIN; / BEGIN TRANSACTION / BEGIN WORK 은 트랜잭션 시작이지 블록이 아니다.
      if (w === 'BEGIN' && (next === undefined || next === ';' || next === 'TRANSACTION' || next === 'WORK')) {
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
