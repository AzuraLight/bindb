import type { ColumnMeta, FetchResult, QueryCursor, Session } from './types';

/**
 * 드라이버별 "n행 더 읽기" 함수를 QueryCursor로 감싼다.
 * readMore가 요청보다 적게 돌려주면 끝까지 읽은 것으로 본다.
 */
export class BufferedCursor implements QueryCursor {
  private buf: unknown[][];
  private closed = false;

  constructor(
    readonly columns: ColumnMeta[],
    initial: unknown[][],
    private exhausted: boolean,
    private readonly readMore: (n: number) => Promise<unknown[][]>,
    private readonly onClose: () => Promise<void>,
    readonly affectedRows?: number,
  ) {
    this.buf = initial;
  }

  async fetch(n: number): Promise<FetchResult> {
    while (this.buf.length < n && !this.exhausted && !this.closed) {
      const want = n - this.buf.length;
      const more = await this.readMore(want);
      this.buf.push(...more);
      if (more.length < want) this.exhausted = true;
    }
    const rows = this.buf.splice(0, n);
    const done = this.exhausted && this.buf.length === 0;
    if (done) await this.close();
    return { rows, done };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.buf = [];
    await this.onClose();
  }
}

/** 결과셋 없는 문장의 커서 */
export function emptyCursor(affectedRows?: number, columns: ColumnMeta[] = []): QueryCursor {
  return new BufferedCursor(columns, [], true, async () => [], async () => {}, affectedRows);
}

/** 메모리에 다 올라온 결과를 커서로 */
export function arrayCursor(columns: ColumnMeta[], rows: unknown[][], affectedRows?: number): QueryCursor {
  return new BufferedCursor(columns, rows, true, async () => [], async () => {}, affectedRows);
}

export async function queryAll(session: Session, sql: string): Promise<unknown[][]> {
  const cursor = await session.execute(sql);
  const out: unknown[][] = [];
  try {
    for (;;) {
      const { rows, done } = await cursor.fetch(1000);
      out.push(...rows);
      if (done) break;
    }
  } finally {
    await cursor.close();
  }
  return out;
}
