export type TokenType = 'word' | 'quoted' | 'string' | 'number' | 'comment' | 'punct' | 'param';

export interface Token {
  type: TokenType;
  text: string;
  start: number;
  /** 끝 오프셋(exclusive). 닫히지 않은 문자열·주석은 텍스트 끝까지 */
  end: number;
  /** 닫히지 않은 문자열·주석·인용 식별자 */
  open?: boolean;
}

/** 문법 규칙을 고를 DB. 없으면(연결 모름) 여러 방언을 너그럽게 받아들이는 예전 규칙 */
export type SqlDialect = 'postgres' | 'mysql' | 'sqlite' | 'h2';

/**
 * 작성 중인(깨진) SQL도 끝까지 토큰으로 나누는 관용 토크나이저.
 * 방언별 규칙(공식 문서):
 *  - postgres: '…'에서 백슬래시는 글자 그대로(standard_conforming_strings 기본 on), E'…'만 \ 이스케이프,
 *    $tag$…$tag$, /* *\/는 중첩, #은 연산자 — https://www.postgresql.org/docs/current/sql-syntax-lexical.html
 *  - mysql: '…' · "…"에서 \ 이스케이프, # 주석, --는 뒤에 공백 · 제어 문자가 있어야 주석, /* *\/ 중첩 없음,
 *    /*! … *\/ 는 실행되는 코드 — https://dev.mysql.com/doc/refman/8.4/en/comments.html ,
 *    https://dev.mysql.com/doc/refman/8.4/en/string-literals.html
 *  - sqlite: 백슬래시 이스케이프 없음, -- · /* *\/(중첩 없음) — https://www.sqlite.org/lang_expr.html ,
 *    https://www.sqlite.org/lang_comment.html
 *  - h2: 백슬래시 이스케이프 없음, -- · // · /* *\/(중첩), $$…$$ — https://h2database.com/html/grammar.html
 */
export function tokenize(text: string, dialect?: SqlDialect): Token[] {
  const backslashIn = (quote: string, eString: boolean) =>
    dialect === undefined ? quote === "'" : dialect === 'mysql' ? quote === "'" || quote === '"' : dialect === 'postgres' && eString && quote === "'";
  const hashComment = dialect === undefined || dialect === 'mysql';
  const nestedComments = dialect === 'postgres' || dialect === 'h2';
  /** MySQL /*! … *\/ 안: 표시만 주석으로 두고 안쪽은 코드로 읽는다 */
  let inExecutable = false;
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;

  const push = (type: TokenType, start: number, end: number, open = false) => {
    tokens.push({ type, text: text.slice(start, end), start, end, ...(open ? { open } : {}) });
    i = end;
  };

  /** quote로 닫히는 구간 끝. 같은 따옴표 두 번은 이스케이프 */
  const closeQuote = (start: number, quote: string, eString = false): [number, boolean] => {
    const escapes = backslashIn(quote, eString);
    let j = start + 1;
    while (j < n) {
      if (text[j] === '\\' && escapes) {
        j += 2;
        continue;
      }
      if (text[j] === quote) {
        if (text[j + 1] === quote) {
          j += 2;
          continue;
        }
        return [j + 1, false];
      }
      j++;
    }
    return [n, true];
  };

  while (i < n) {
    const c = text[i];
    const start = i;

    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && text[i + 1] === '-' && (dialect !== 'mysql' || i + 2 >= n || /[\s\x00-\x1f]/.test(text[i + 2]))) {
      const nl = text.indexOf('\n', i);
      push('comment', start, nl < 0 ? n : nl);
      continue;
    }
    if (c === '/' && text[i + 1] === '/' && dialect === 'h2') {
      const nl = text.indexOf('\n', i);
      push('comment', start, nl < 0 ? n : nl);
      continue;
    }
    if (inExecutable && c === '*' && text[i + 1] === '/') {
      inExecutable = false;
      push('comment', start, start + 2);
      continue;
    }
    if (c === '#' && hashComment) {
      const nl = text.indexOf('\n', i);
      push('comment', start, nl < 0 ? n : nl);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      if (dialect === 'mysql' && text[i + 2] === '!' && !inExecutable) {
        // 실행 주석: /*! 와 버전 숫자(5 · 6자리)만 표시로 두고, 안쪽은 코드
        const m = /^\/\*!(\d{6}(?=\s|\*\/)|\d{5})?/.exec(text.slice(i))!;
        inExecutable = true;
        push('comment', start, start + m[0].length);
        continue;
      }
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (nestedComments && text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      push('comment', start, depth > 0 ? n : j, depth > 0);
      continue;
    }
    if ((c === 'E' || c === 'e') && text[i + 1] === "'" && dialect === 'postgres' && !/[\w$]/.test(text[i - 1] ?? '')) {
      const [end, open] = closeQuote(start + 1, "'", true);
      push('string', start, end, open);
      continue;
    }
    if (c === "'") {
      const [end, open] = closeQuote(start, "'");
      push('string', start, end, open);
      continue;
    }
    if (c === '"' && dialect === 'mysql') {
      // MySQL: ANSI_QUOTES가 꺼져 있으면(기본) "…"는 문자열
      const [end, open] = closeQuote(start, '"');
      push('string', start, end, open);
      continue;
    }
    if (c === '"' || c === '`') {
      const [end, open] = closeQuote(start, c);
      push('quoted', start, end, open);
      continue;
    }
    if (c === '[') {
      const close = text.indexOf(']', i);
      // `[`가 배열 문법(pg)일 수도 있으니 식별자처럼 생긴 경우만 인용 식별자로 본다.
      if (close > 0 && /^\[[^\]\n]+\]$/.test(text.slice(start, close + 1)) && /[A-Za-z_]/.test(text[i + 1] ?? '')) {
        push('quoted', start, close + 1);
        continue;
      }
    }
    if (c === '$') {
      // 달러 인용: postgres $tag$ · h2 $$ 만. mysql · sqlite에는 없다
      const tag = dialect === 'mysql' || dialect === 'sqlite' ? null : /^\$([A-Za-z_][\w]*)?\$/.exec(text.slice(i));
      if (tag && !(dialect === 'h2' && tag[0] !== '$$')) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        push('string', start, close < 0 ? n : close + tag[0].length, close < 0);
        continue;
      }
      const num = /^\$\d+/.exec(text.slice(i));
      if (num) {
        push('param', start, start + num[0].length);
        continue;
      }
    }
    if ((c === ':' || c === '@') && /[A-Za-z_]/.test(text[i + 1] ?? '') && text[i - 1] !== ':') {
      const m = /^[:@][A-Za-z_]\w*/.exec(text.slice(i))!;
      push('param', start, start + m[0].length);
      continue;
    }
    if (c === '?') {
      push('param', start, start + 1);
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(\d*\.?\d+(e[+-]?\d+)?|\d+\.)/i.exec(text.slice(i))!;
      push('number', start, start + m[0].length);
      continue;
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      const m = /^[A-Za-z_\u0080-￿][\w$\u0080-￿]*/.exec(text.slice(i))!;
      push('word', start, start + m[0].length);
      continue;
    }
    push('punct', start, start + 1);
  }
  return tokens;
}

/** 단어 토큰이면 대문자로(키워드 비교용), 아니면 undefined */
export const upperWord = (t: Token | undefined): string | undefined => (t?.type === 'word' ? t.text.toUpperCase() : undefined);

/** 인용 식별자의 따옴표를 벗긴다 */
export function identName(tok: Token): string {
  if (tok.type !== 'quoted') return tok.text;
  const inner = tok.text.slice(1, tok.open ? undefined : -1);
  const q = tok.text[0];
  return q === '[' ? inner : inner.split(q + q).join(q);
}

export function isIdent(tok: Token | undefined): tok is Token {
  return !!tok && (tok.type === 'word' || tok.type === 'quoted');
}
