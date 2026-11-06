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
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode', 'pg-native'],
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/grid/main.tsx'],
    outfile: 'out/webview/grid.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  }),
]);

// sql.js는 wasm 파일을 런타임에 extension.js 옆에서 읽는다.
mkdirSync('out', { recursive: true });
copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm', 'out/sql-wasm.wasm');

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
