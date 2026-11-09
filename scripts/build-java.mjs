// JDBC 연동 런타임(java/bridge)을 java/bindb-jdbc.jar로 컴파일한다.
// 결과 jar는 저장소에 커밋한다 — 평소 빌드(npm run build)에는 JDK가 필요 없고, Java 소스를 고쳤을 때만 이걸 돌린다.
// JDK 찾기: BINDB_JDK → JAVA_HOME → PATH의 javac. --release 11: H2 2.x와 같은 최소 버전.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const home = process.env.BINDB_JDK ?? process.env.JAVA_HOME;
const tool = (name) => (home ? path.join(home, 'bin', name) : name);
const src = 'java/bridge/src';
const out = 'java/bindb-jdbc.jar';

const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const full = path.join(dir, f);
    if (statSync(full).isDirectory()) walk(full);
    else if (f.endsWith('.java')) files.push(full);
  }
};
walk(src);

const classes = mkdtempSync(path.join(tmpdir(), 'bindb-jdbc-'));
try {
  execFileSync(tool('javac'), ['--release', '11', '-encoding', 'UTF-8', '-Xlint:all', '-Werror', '-d', classes, ...files], { stdio: 'inherit' });
  if (existsSync(out)) rmSync(out);
  // 같은 소스면 같은 jar가 나오게 시각을 고정한다(--date, JDK 17+)
  execFileSync(tool('jar'), ['--create', '--file', out, '--date', '2026-01-01T00:00:00Z', '-C', classes, '.'], { stdio: 'inherit' });
  console.log(`${out}: ${statSync(out).size} bytes from ${files.length} source file(s)`);
} finally {
  rmSync(classes, { recursive: true, force: true });
}
