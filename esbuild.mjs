import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// 개발 빌드가 남긴 소스맵이 VSIX에 섞이지 않게 비운다.
if (production) rmSync('out', { recursive: true, force: true });

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    // sqliteHost: SQLite를 돌리는 자식 프로세스(src/drivers/sqlite.ts가 fork한다)
    entryPoints: { extension: 'src/extension.ts', sqliteHost: 'src/drivers/sqliteHost.ts' },
    outdir: 'out',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    // ssh2의 선택적 네이티브 가속(cpu-features · sshcrypto.node)은 없으면 순수 JS로 돈다. 번들에서 뺀다.
    external: ['vscode', 'pg-native', 'cpu-features', '*.node'],
  }),
  esbuild.context({
    ...common,
    entryPoints: { grid: 'webview/grid/main.tsx', connection: 'webview/connection/main.tsx' },
    outdir: 'out/webview',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  }),
]);

// JDBC 연동 런타임(scripts/build-java.mjs가 만들어 커밋한 jar). src/drivers/jdbc/bridge.ts가 out/ 옆에서 찾는다
mkdirSync('out', { recursive: true });
copyFileSync('java/bindb-jdbc.jar', 'out/bindb-jdbc.jar');

// 예전 SQLite wasm 파일이 out/에 남아 패키지에 들어가지 않게 지운다
rmSync('out/sql-wasm.wasm', { force: true });
rmSync('out/sqlite3.wasm', { force: true });

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
