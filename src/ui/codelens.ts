import * as vscode from 'vscode';
import type { ConnectionStore } from '../core/connections';
import { splitStatements } from '../language/splitter';
import { boundConnection } from './binding';
import { DDL_SCHEME } from './viewSource';

/** 문장마다 `▶ Run` */
export class RunCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private readonly store: ConnectionStore) {}

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    // 뷰 DDL 편집기는 실행하지 않고 Submit한다
    if (doc.uri.scheme === DDL_SCHEME) return [];
    // 묶인 연결의 문법으로 나눈다(실행 때와 같은 규칙이어야 ▶가 그 문장을 실행한다)
    return splitStatements(doc.getText(), boundConnection(doc, this.store)?.driver).map((s) => {
      const range = new vscode.Range(doc.positionAt(s.start), doc.positionAt(s.end));
      return new vscode.CodeLens(range, {
        title: '$(play) Run',
        command: 'bindb.runStatement',
        arguments: [doc.uri, s.start],
      });
    });
  }
}
