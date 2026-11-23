import { identName, isIdent, upperWord, type Token } from './tokenizer';

/*
 * 문장에서 테이블 자리 · WITH 이름 · CREATE 이름을 읽는다.
 * 진단 · 정의로 이동 · 사용처 찾기 · hover · 자동완성이 같은 판독을 쓴다.
 */

/** 별칭으로 읽으면 안 되는 단어 */
export const RESERVED = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL', 'ON',
  'USING', 'GROUP', 'ORDER', 'BY', 'HAVING', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'INTERSECT', 'EXCEPT',
  'SET', 'VALUES', 'RETURNING', 'WINDOW', 'FOR', 'AS', 'AND', 'OR', 'NOT', 'LATERAL', 'WITH', 'INTO',
  'UPDATE', 'DELETE', 'INSERT', 'DEFAULT', 'STRAIGHT_JOIN', 'WHEN', 'THEN', 'ELSE', 'END',
]);

/** 이 단어 뒤의 `(`는 함수 호출이 아니라 묶음 · 서브쿼리 */
const GROUP_BEFORE = new Set([
  ...RESERVED, 'IN', 'EXISTS', 'ANY', 'ALL', 'SOME', 'IS', 'LIKE', 'BETWEEN', 'CASE', 'ARRAY', 'ROW', 'RECURSIVE',
]);
/** 테이블 이름 앞에 올 수 있는 수식어 */
const TABLE_MODIFIERS = new Set(['ONLY', 'LOW_PRIORITY', 'IGNORE', 'QUICK', 'DELAYED', 'HIGH_PRIORITY']);
/** 별칭 자리에 오지만 별칭이 아닌 단어 */
const NOT_ALIAS = new Set([...RESERVED, 'TABLESAMPLE', 'PARTITION', 'FORCE', 'USE', 'IGNORE', 'NATURAL', 'START', 'CONNECT', 'QUALIFY']);
const upper = upperWord;

/** CREATE [OR REPLACE] [TEMP] TABLE|VIEW [IF NOT EXISTS] [schema.]name — 이름 토큰들과 그 뒤 위치 */
export function createdName(code: Token[]): { parts: Token[]; next: number } | undefined {
  if (upper(code[0]) !== 'CREATE') return undefined;
  let k = 1;
  while (k < 7 && k < code.length && !['TABLE', 'VIEW'].includes(upper(code[k]) ?? '')) k++;
  if (!['TABLE', 'VIEW'].includes(upper(code[k]) ?? '')) return undefined;
  k++;
  while (['IF', 'NOT', 'EXISTS'].includes(upper(code[k]) ?? '')) k++;
  if (!isIdent(code[k])) return undefined;
  const parts = [code[k]];
  k++;
  while (code[k]?.text === '.' && isIdent(code[k + 1])) {
    parts.push(code[k + 1]);
    k += 2;
  }
  return { parts, next: k };
}

/** 테이블 자리에 쓴 이름: parts = [schema.]table 토큰들, alias = 별칭 토큰 */
export interface SourceRef {
  parts: Token[];
  alias?: Token;
}

/**
 * FROM · JOIN · UPDATE · INSERT INTO · DELETE … USING 뒤의 테이블 이름들.
 * code는 주석을 뺀 토큰, first는 문장 첫 키워드(대문자).
 */
export function tableReferences(code: Token[], first: string, onOpaque?: (tok: Token) => void): SourceRef[] {
  const refs: SourceRef[] = [];
  /** 함수 호출 괄호 깊이(EXTRACT(x FROM y) · SUBSTRING(… FROM …) 안의 FROM은 테이블 자리가 아니다) */
  const frames: ('call' | 'group')[] = [];

  /** k의 ( 와 짝인 ) 다음 위치 */
  const afterGroup = (k: number): number => {
    let depth = 0;
    for (let j = k; j < code.length; j++) {
      if (code[j].text === '(') depth++;
      else if (code[j].text === ')' && --depth === 0) return j + 1;
    }
    return code.length;
  };
  /** [AS] alias 를 건너뛴다 */
  const skipAlias = (j: number): number => {
    if (upper(code[j]) === 'AS') j++;
    return isIdent(code[j]) && !NOT_ALIAS.has(upper(code[j]) ?? '') ? j + 1 : j;
  };

  const readRef = (k: number, columnList = false): number => {
    while (TABLE_MODIFIERS.has(upper(code[k]) ?? '')) k++;
    if (!isIdent(code[k]) || RESERVED.has(upper(code[k]) ?? '')) return k;
    const parts = [code[k]];
    let j = k + 1;
    while (code[j]?.text === '.' && isIdent(code[j + 1])) {
      parts.push(code[j + 1]);
      j += 2;
    }
    // generate_series(…) · unnest(…) 같은 테이블 함수: 테이블로 넣지 않고 괄호와 별칭을 건너뛴다
    if (code[j]?.text === '(' && !columnList) {
      onOpaque?.(code[j]);
      return skipAlias(afterGroup(j));
    }
    if (upper(code[j]) === 'AS') j++;
    let alias: Token | undefined;
    if (isIdent(code[j]) && !NOT_ALIAS.has(upper(code[j]) ?? '')) {
      alias = code[j];
      j++;
    }
    refs.push({ parts, alias });
    return j;
  };

  for (let k = 0; k < code.length; k++) {
    const t = code[k];
    if (t.text === '(') {
      const prev = code[k - 1];
      frames.push(isIdent(prev) && !GROUP_BEFORE.has(upper(prev) ?? '') ? 'call' : 'group');
      continue;
    }
    if (t.text === ')') {
      frames.pop();
      continue;
    }
    if (frames.includes('call')) continue;
    const w = upper(t);
    if (!w) continue;
    const prev = upper(code[k - 1]);
    let tableHere = false;
    if (w === 'FROM') tableHere = prev !== 'DISTINCT'; // IS DISTINCT FROM
    else if (w === 'JOIN') tableHere = true;
    else if (w === 'UPDATE') tableHere = k === 0 || code[k - 1]?.text === ')'; // FOR UPDATE · ON DUPLICATE KEY UPDATE · DO UPDATE 제외
    else if (w === 'INTO') tableHere = prev === 'INSERT' || prev === 'REPLACE' || prev === 'IGNORE' || prev === 'DELAYED' || prev === 'LOW_PRIORITY' || prev === 'HIGH_PRIORITY';
    else if (w === 'USING') tableHere = first === 'DELETE' && code[k + 1]?.text !== '(';
    if (!tableHere) continue;
    // 바깥 반복은 k를 건너뛰지 않는다 — 괄호(서브쿼리) 안의 FROM도 이어서 읽고 괄호 깊이도 맞게 센다
    /** 목록 항목 하나: 테이블 · 테이블 함수 · (SELECT …) s · LATERAL (…) x */
    const item = (n: number): number => {
      if (w !== 'INTO' && upper(code[n]) === 'LATERAL') n++;
      if (w !== 'INTO' && code[n]?.text === '(') {
        onOpaque?.(code[n]);
        return skipAlias(afterGroup(n));
      }
      return readRef(n, w === 'INTO');
    };
    let j = item(k + 1);
    while ((w === 'FROM' || w === 'USING') && code[j]?.text === ',' && j > k + 1) {
      const next = item(j + 1);
      if (next === j + 1) break;
      j = next;
    }
  }
  // 쉼표 목록을 먼저 읽어 순서가 섞일 수 있다 — 문서 순서로
  return refs.sort((a, b) => a.parts[0].start - b.parts[0].start);
}

/**
 * 각 토큰을 감싼 ( 위치들(바깥 → 안). 맨 앞 -1은 문장 전체. 서브쿼리마다 별칭 · 테이블 범위를 나누는 데 쓴다.
 * 토큰 자신이 ( 이면 그 괄호는 포함하지 않고, ) 이면 이미 닫힌 것으로 본다.
 */
export function parenChains(code: Token[]): number[][] {
  const chains: number[][] = [];
  const stack: number[] = [-1];
  for (let k = 0; k < code.length; k++) {
    if (code[k].text === ')' && stack.length > 1) stack.pop();
    chains.push([...stack]);
    if (code[k].text === '(') stack.push(k);
  }
  return chains;
}

/** 토큰을 바로 감싼 범위(가장 안쪽 ( 위치, 문장 전체면 -1). chains는 parenChains(code)의 결과 */
export function innermostScope(chains: number[][], code: Token[], tok: Token): number {
  const chain = chains[code.indexOf(tok)];
  return chain[chain.length - 1];
}

/** WITH [RECURSIVE] a [(…)] AS [NOT] [MATERIALIZED] ( … ), b AS ( … ) 의 이름 토큰들 */
export function cteDeclarations(code: Token[]): Token[] {
  const out: Token[] = [];
  for (let k = 0; k < code.length; k++) {
    const prev = upper(code[k - 1]);
    if (!(prev === 'WITH' || prev === 'RECURSIVE' || code[k - 1]?.text === ',') || !isIdent(code[k])) continue;
    let j = k + 1;
    if (code[j]?.text === '(') {
      let depth = 0;
      for (; j < code.length; j++) {
        if (code[j].text === '(') depth++;
        else if (code[j].text === ')' && --depth === 0) break;
      }
      j++;
    }
    if (upper(code[j]) !== 'AS') continue;
    // SELECT a, b AS c 와 구분: CTE는 AS 뒤에 ( 가 온다
    j++;
    while (['NOT', 'MATERIALIZED'].includes(upper(code[j]) ?? '')) j++;
    if (code[j]?.text === '(') out.push(code[k]);
  }
  return out;
}
