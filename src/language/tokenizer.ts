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

/**
 * 작성 중인(깨진) SQL도 끝까지 토큰으로 나누는 관용 토크나이저.
 * 방언 차이는 최소만 다룬다: '…', "…", `…`, [..](mssql), $tag$…$tag$(pg), --, #(mysql), /* *\/.
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;

  const push = (type: TokenType, start: number, end: number, open = false) => {
    tokens.push({ type, text: text.slice(start, end), start, end, ...(open ? { open } : {}) });
    i = end;
  };

  /** quote로 닫히는 구간 끝. 같은 따옴표 두 번은 이스케이프 */
  const closeQuote = (start: number, quote: string): [number, boolean] => {
    let j = start + 1;
    while (j < n) {
      if (text[j] === '\\' && quote === "'") {
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
    if (c === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      push('comment', start, nl < 0 ? n : nl);
      continue;
    }
    if (c === '#') {
      const nl = text.indexOf('\n', i);
      push('comment', start, nl < 0 ? n : nl);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      push('comment', start, close < 0 ? n : close + 2, close < 0);
      continue;
    }
    if (c === "'") {
      const [end, open] = closeQuote(start, "'");
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
      const tag = /^\$([A-Za-z_][\w]*)?\$/.exec(text.slice(i));
      if (tag) {
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
