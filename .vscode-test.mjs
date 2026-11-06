// 통합 테스트: 실제 VS Code를 내려받아 이 확장을 띄운다(@vscode/test-cli).
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'test-integration/**/*.test.js',
  version: process.env.BINDB_VSCODE_VERSION ?? 'stable',
  mocha: { ui: 'bdd', timeout: 60_000 },
  // Before connection 테스트가 쓰는 tasks.json이 있는 폴더로 연다
  workspaceFolder: 'test-integration/workspace',
  launchArgs: ['--disable-extensions'],
});
