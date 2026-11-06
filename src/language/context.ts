import type { Statement } from './splitter';
import { identName, isIdent, type Token } from './tokenizer';

export interface TableRef {
  schema?: string;
  name: string;
  alias?: string;
}

export interface CompletionContext {
  /** none: 문자열·주석 안 / keyword: 문장 시작 / table: 테이블 이름 자리 / column: 컬럼 자리 */
  kind: 'none' | 'keyword' | 'table' | 'column';
  /** `x.|` 의 x */
  qualifier?: string;
  /** 문장 전체(커서 뒤 포함)에서 모은 FROM/JOIN 대상 */
  refs: TableRef[];
}

const TABLE_CLAUSES = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'TRUNCATE']);
const COLUMN_CLAUSES = new Set([
  'SELECT', 'WHERE', 'ON', 'BY', 'AND', 'OR', 'SET', 'HAVING', 'WHEN', 'THEN', 'ELSE', 'NOT',
  'DISTINCT', 'RETURNING', 'IN', 'BETWEEN', 'LIKE', 'IS', 'VALUES',
]);

/** 별칭으로 읽으면 안 되는 단어 */
export const RESERVED = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL', 'ON',
  'USING', 'GROUP', 'ORDER', 'BY', 'HAVING', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'INTERSECT', 'EXCEPT',
  'SET', 'VALUES', 'RETURNING', 'WINDOW', 'FOR', 'AS', 'AND', 'OR', 'NOT', 'LATERAL', 'WITH', 'INTO',
  'UPDATE', 'DELETE', 'INSERT', 'DEFAULT', 'STRAIGHT_JOIN', 'WHEN', 'THEN', 'ELSE', 'END',
]);

const upper = (t: Token | undefined) => (t?.type === 'word' ? t.text.toUpperCase() : undefined);

/** FROM/JOIN 뒤의 `schema.table [AS] alias` 들 */
export function collectTableRefs(tokens: Token[]): TableRef[] {
  const code = tokens.filter((t) => t.type !== 'comment');
  const refs: TableRef[] = [];

  /** k 위치에서 참조 하나를 읽고 다음 위치를 돌려준다 */
  const readRef = (k: number): number => {
    if (!isIdent(code[k]) || RESERVED.has(upper(code[k]) ?? '')) return k;
    let schema: string | undefined;
    let name = identName(code[k]);
    k++;
    if (code[k]?.text === '.' && isIdent(code[k + 1])) {
      schema = name;
      name = identName(code[k + 1]);
      k += 2;
    }
    // INSERT INTO t (a, b) 의 컬럼 목록은 별칭이 아니다.
    if (upper(code[k]) === 'AS') k++;
    let alias: string | undefined;
    if (isIdent(code[k]) && !RESERVED.has(upper(code[k]) ?? '')) {
      alias = identName(code[k]);
      k++;
    }
    refs.push({ schema, name, alias });
    return k;
  };

  for (let k = 0; k < code.length; k++) {
    const w = upper(code[k]);
    if (!w || !TABLE_CLAUSES.has(w) || w === 'TABLE') continue;
    let j = readRef(k + 1);
    // FROM a, b c, d
    while (w === 'FROM' && code[j]?.text === ',' && j > k + 1) {
      const next = readRef(j + 1);
      if (next === j + 1) break;
      j = next;
    }
  }
  return refs;
}

/**
 * 문장과 커서 오프셋(문서 기준)으로 자동완성 컨텍스트를 판정한다.
 * statement가 없으면(빈 문서 등) keyword.
 */
export function completionContext(statement: Statement | undefined, offset: number): CompletionContext {
  const tokens = statement?.tokens ?? [];
  const refs = collectTableRefs(tokens);

  const at = tokens.find((t) => t.start < offset && offset <= t.end);
  if (at) {
    const lineComment = at.type === 'comment' && !at.text.startsWith('/*');
    if (lineComment) return { kind: 'none', refs };
    if ((at.type === 'comment' || at.type === 'string') && (offset < at.end || at.open)) return { kind: 'none', refs };
  }

  // 입력 중인 단어는 컨텍스트 판정에서 뺀다.
  const typing = at && isIdent(at) && at.end === offset ? at : undefined;
  const cut = typing ? typing.start : offset;
  const before = tokens.filter((t) => t.end <= cut && t.type !== 'comment');

  let qualifier: string | undefined;
  let k = before.length - 1;
  if (before[k]?.text === '.' && isIdent(before[k - 1])) {
    qualifier = identName(before[k - 1]);
    k -= 2;
    // a.b.| — 더 앞의 이름은 판정에 쓰지 않는다
    while (before[k]?.text === '.' && isIdent(before[k - 1])) k -= 2;
  }
  if (k < 0) return { kind: qualifier ? 'column' : 'keyword', qualifier, refs };

  let depth = 0;
  for (; k >= 0; k--) {
    const t = before[k];
    if (t.type === 'punct') {
      if (t.text === ')') depth++;
      else if (t.text === '(') {
        if (depth > 0) {
          depth--;
          continue;
        }
        // INSERT INTO t (col, |
        if (isIdent(before[k - 1]) && upper(before[k - 2]) === 'INTO') {
          return { kind: 'column', qualifier, refs: [{ name: identName(before[k - 1]) }] };
        }
        if (isIdent(before[k - 1]) && before[k - 2]?.text === '.' && upper(before[k - 4]) === 'INTO') {
          return { kind: 'column', qualifier, refs: [{ schema: identName(before[k - 3]), name: identName(before[k - 1]) }] };
        }
      }
      continue;
    }
    if (depth > 0) continue;
    const w = upper(t);
    if (!w) continue;
    if (TABLE_CLAUSES.has(w)) return { kind: 'table', qualifier, refs };
    if (COLUMN_CLAUSES.has(w)) return { kind: 'column', qualifier, refs };
  }
  return { kind: qualifier ? 'column' : 'keyword', qualifier, refs };
}
