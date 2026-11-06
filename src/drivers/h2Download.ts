import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/*
 * Drivers · H2 · Driver files: Maven Central에서 H2 jar를 내려받는다(DataGrip의 "Download ver. N").
 * 내려받은 파일은 Maven Central이 함께 주는 SHA-1과 맞는지 확인한 뒤에만 저장한다.
 */

const BASE = 'https://repo1.maven.org/maven2/com/h2database/h2';

/** 받을 수 있는 판(최신이 앞) */
export async function h2Versions(fetchFn: typeof fetch = fetch): Promise<{ latest: string; versions: string[] }> {
  const res = await fetchFn(`${BASE}/maven-metadata.xml`);
  if (!res.ok) throw new Error(`Maven Central: HTTP ${res.status}`);
  const xml = await res.text();
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]).reverse();
  const latest = /<release>([^<]+)<\/release>/.exec(xml)?.[1] ?? versions[0];
  if (!latest) throw new Error('Maven Central returned no H2 versions.');
  return { latest, versions };
}

/** version의 jar를 folder에 내려받고 경로를 돌려준다 */
export async function downloadH2(version: string, folder: string, fetchFn: typeof fetch = fetch): Promise<string> {
  if (!/^[0-9][0-9A-Za-z.-]*$/.test(version)) throw new Error(`Invalid version "${version}".`);
  const jarUrl = `${BASE}/${version}/h2-${version}.jar`;
  const [jar, sha] = await Promise.all([fetchFn(jarUrl), fetchFn(`${jarUrl}.sha1`)]);
  if (!jar.ok) throw new Error(`Download failed: HTTP ${jar.status}`);
  if (!sha.ok) throw new Error(`Checksum download failed: HTTP ${sha.status}`);
  const bytes = Buffer.from(await jar.arrayBuffer());
  const expected = (await sha.text()).trim().split(/\s+/)[0].toLowerCase();
  const actual = createHash('sha1').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch for h2-${version}.jar (expected ${expected}, got ${actual}).`);
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `h2-${version}.jar`);
  await writeFile(file, bytes);
  return file;
}
