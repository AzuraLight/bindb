import * as vscode from 'vscode';
import { splitStatements } from '../language/splitter';

/** 문장마다 `▶ Run` */
export class RunCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    return splitStatements(doc.getText()).map((s) => {
      const range = new vscode.Range(doc.positionAt(s.start), doc.positionAt(s.end));
      return new vscode.CodeLens(range, {
        title: '$(play) Run',
        command: 'bindb.runStatement',
        arguments: [doc.uri, s.start],
      });
    });
  }
}
