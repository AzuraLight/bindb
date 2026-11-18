import * as vscode from 'vscode';
import type { ConnectionStore } from '../core/connections';
import type { SessionManager } from '../core/sessions';
import { localObjects, unresolvedReferences } from '../language/diagnostics';
import { splitStatements } from '../language/splitter';
import { boundConnection, boundSchema } from './binding';
import { cachedScope } from './metaScope';

/**
 * 연결에 바인딩된 SQL 파일에 해석되지 않는 테이블 · 열을 경고로 표시한다.
 * 이미 받아 둔 메타데이터로만 판정한다 — 진단 때문에 접속하지 않는다.
 */
export class UnresolvedDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('bindb');
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
  ) {
    this.subs = [
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d, 0)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document, 400)),
      vscode.workspace.onDidCloseTextDocument((d) => this.collection.delete(d.uri)),
      sessions.onDidChange(() => this.refreshAll()),
      store.onDidChange(() => this.refreshAll()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('bindb.diagnostics')) this.refreshAll();
      }),
    ];
    this.refreshAll();
  }

  private refreshAll(): void {
    for (const d of vscode.workspace.textDocuments) this.schedule(d, 0);
  }

  private schedule(doc: vscode.TextDocument, delay: number): void {
    if (doc.languageId !== 'sql') return;
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.update(doc);
      }, delay),
    );
  }

  private async update(doc: vscode.TextDocument): Promise<void> {
    const version = doc.version;
    const cfg = boundConnection(doc, this.store);
    const enabled = vscode.workspace.getConfiguration('bindb').get<boolean>('diagnostics.unresolvedReferences', true);
    const found = cfg && enabled ? await cachedScope(this.sessions, cfg, boundSchema(doc)) : undefined;
    if (doc.isClosed || doc.version !== version) return;
    if (!cfg || !found) {
      this.collection.delete(doc.uri);
      return;
    }
    const statements = splitStatements(doc.getText(), cfg.driver);
    const scope = {
      driver: cfg.driver,
      ...found,
      local: localObjects(statements),
    };
    const out: vscode.Diagnostic[] = [];
    for (const s of statements) {
      for (const p of unresolvedReferences(s, scope)) {
        const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(p.start), doc.positionAt(p.end)), p.message, vscode.DiagnosticSeverity.Warning);
        d.source = 'BindB';
        d.code = p.code;
        out.push(d);
      }
    }
    this.collection.set(doc.uri, out);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const s of this.subs) s.dispose();
    this.collection.dispose();
  }
}
