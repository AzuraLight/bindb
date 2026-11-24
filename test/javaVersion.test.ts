import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { javaVersion } from '../src/drivers/jdbc/bridge';

// java -version 출력(표준 오류)을 흉내 내는 가짜 실행 파일로 주 버전 읽기를 본다
describe('javaVersion', { skip: process.platform === 'win32' && 'POSIX shell scripts' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bindb-java-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  /** stderr에 text를 쓰고 code로 끝나는 가짜 java */
  const fake = (text: string, code = 0) => {
    const file = path.join(dir, `java${++n}`);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${text}' >&2\nexit ${code}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it('reads the major version of modern and 1.x releases', async () => {
    assert.equal(await javaVersion(fake('openjdk version "21.0.13.1" 2026-11-17 LTS')), 21);
    assert.equal(await javaVersion(fake('openjdk version "11.0.2" 2019-01-15')), 11);
    assert.equal(await javaVersion(fake('openjdk version "17" 2021-09-14')), 17);
    assert.equal(await javaVersion(fake('java version "1.8.0_391"')), 8);
  });

  it('finds java through the PATH of the given environment (the data source VM environment), like the JVM spawn does', async () => {
    const bin = mkdtempSync(path.join(dir, 'bin-'));
    const file = path.join(bin, 'java');
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' 'openjdk version "17.0.1"' >&2\n`);
    chmodSync(file, 0o755);
    const home = process.env.JAVA_HOME;
    delete process.env.JAVA_HOME;
    try {
      assert.equal(await javaVersion(undefined, { PATH: bin }), 17);
    } finally {
      if (home !== undefined) process.env.JAVA_HOME = home;
    }
  });

  it('is undefined when java cannot run or prints no version (macOS stub without a runtime)', async () => {
    assert.equal(await javaVersion(fake('The operation couldn’t be completed. Unable to locate a Java Runtime.', 1)), undefined);
    assert.equal(await javaVersion(fake('something else')), undefined);
    assert.equal(await javaVersion(path.join(dir, 'no-such-java')), undefined);
  });
});
