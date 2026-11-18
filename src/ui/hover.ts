import * as vscode from 'vscode';
import type { ConnectionStore } from '../core/connections';
import type { SessionManager } from '../core/sessions';
import { hoverAt } from '../language/hover';
import { splitStatements, statementAt } from '../language/splitter';
import { boundConnection, boundSchema } from './binding';
import { cachedScope } from './metaScope';

/** 바인딩된 SQL 파일에서 테이블 · 별칭 · 열 · 스키마에 마우스를 올리면 메타데이터를 보여 준다(이미 받아 둔 것만) */
export class SqlHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
  ) {}

  async provideHover(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const cfg = boundConnection(doc, this.store);
    const scope = cfg && (await cachedScope(this.sessions, cfg, boundSchema(doc)));
    if (!cfg || !scope) return undefined;
    const offset = doc.offsetAt(position);
    const info = hoverAt(statementAt(splitStatements(doc.getText(), cfg.driver), offset), offset, scope);
    if (!info) return undefined;
    return new vscode.Hover(new vscode.MarkdownString(info.markdown), new vscode.Range(doc.positionAt(info.start), doc.positionAt(info.end)));
  }
}
