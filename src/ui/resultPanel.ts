import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { SessionManager } from '../core/sessions';
import type { ConnectionConfig, QueryCursor } from '../drivers';
import type { CellValue, HostToWebview, WebviewToHost } from '../shared/protocol';
import { errorText } from './explorer';

interface Current {
  qid: string;
  cfg: ConnectionConfig;
  cursor?: QueryCursor;
  offset: number;
  started: number;
  fetching: boolean;
}

/** 결과 그리드. M1은 패널 하나를 재사용한다. */
export class ResultPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private queue: HostToWebview[] = [];
  private current?: Current;
  private seq = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessions: SessionManager,
  ) {}

  /** 문장을 실행하고 결과를 그리드로 보여 준다. */
  async run(cfg: ConnectionConfig, sql: string): Promise<void> {
    this.ensurePanel();
    const qid = `q${++this.seq}`;
    const cur: Current = { qid, cfg, offset: 0, started: Date.now(), fetching: false };
    this.current = cur;
    this.post({ t: 'running', qid, sql, connection: cfg.name });

    let cursor: QueryCursor;
    try {
      cursor = await this.sessions.execute(cfg, sql);
    } catch (e) {
      this.post({ t: 'result/error', qid, message: errorText(e) });
      return;
    }
    if (this.current !== cur) {
      // 실행 중에 다른 문장이 시작됐다. 이 결과는 버린다(다음 실행이 커서를 닫는다).
      return;
    }
    if (cursor.columns.length === 0) {
      this.post({ t: 'result/update', qid, affectedRows: cursor.affectedRows ?? null, elapsedMs: Date.now() - cur.started });
      await cursor.close();
      return;
    }
    cur.cursor = cursor;
    this.post({ t: 'result/start', qid, sql, connection: cfg.name, columns: cursor.columns });
    await this.fetchMore(cur);
    this.post({ t: 'result/stats', qid, elapsedMs: Date.now() - cur.started });
  }

  async cancel(): Promise<void> {
    const cur = this.current;
    if (cur) await this.sessions.cancel(cur.cfg).catch(() => {});
  }

  private async fetchMore(cur: Current): Promise<void> {
    if (!cur.cursor || cur.fetching) return;
    cur.fetching = true;
    const pageSize = vscode.workspace.getConfiguration('bindb').get<number>('grid.pageSize', 500);
    try {
      const { rows, done } = await this.sessions.fetch(cur.cfg, cur.cursor, pageSize);
      this.post({ t: 'result/rows', qid: cur.qid, offset: cur.offset, rows: rows.map((r) => r.map(toCell)), done });
      cur.offset += rows.length;
      if (done) cur.cursor = undefined;
    } catch (e) {
      cur.cursor = undefined;
      this.post({ t: 'result/error', qid: cur.qid, message: errorText(e) });
    } finally {
      cur.fetching = false;
    }
  }

  private onMessage(msg: WebviewToHost): void {
    switch (msg.t) {
      case 'ready':
        this.ready = true;
        for (const m of this.queue.splice(0)) void this.panel?.webview.postMessage(m);
        break;
      case 'fetch':
        if (this.current?.qid === msg.qid) void this.fetchMore(this.current);
        break;
      case 'cancel':
        if (this.current?.qid === msg.qid) void this.cancel();
        break;
    }
  }

  private post(msg: HostToWebview): void {
    if (this.ready) void this.panel?.webview.postMessage(msg);
    else this.queue.push(msg);
  }

  private ensurePanel(): void {
    if (this.panel) {
      if (!this.panel.visible) this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    const outUri = vscode.Uri.joinPath(this.extensionUri, 'out', 'webview');
    const panel = vscode.window.createWebviewPanel(
      'bindb.results',
      'BindB Results',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [outUri] },
    );
    const nonce = randomBytes(16).toString('base64');
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(outUri, 'grid.js'));
    const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(outUri, 'grid.css'));
    panel.webview.html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
</head><body><div id="root"></div><div id="portal" style="position:fixed;left:0;top:0;z-index:9999"></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
    panel.webview.onDidReceiveMessage((m: WebviewToHost) => this.onMessage(m));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
      this.queue = [];
      this.current = undefined;
    });
    this.panel = panel;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

/** 드라이버가 돌려준 값을 webview로 보낼 수 있는 형태로 */
export function toCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : String(v);
    case 'bigint':
      return v.toString();
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (v instanceof Uint8Array) return { $bin: v.byteLength };
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
