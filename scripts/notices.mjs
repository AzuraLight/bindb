// 번들(out/extension.js, out/webview/grid.js)에 실제로 들어간 패키지의 라이선스 원문을
// THIRD_PARTY_NOTICES.md로 모은다. 압축된 번들에서는 각 파일 머리의 저작권 표시가 사라지므로
// MIT 등 라이선스가 요구하는 고지를 이 파일로 대신한다.
import * as esbuild from 'esbuild';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const entries = [
  { entryPoints: ['src/extension.ts'], platform: 'node', external: ['vscode', 'pg-native'] },
  { entryPoints: ['webview/grid/main.tsx'], platform: 'browser' },
];

/** node_modules/<name>/… 또는 node_modules/@scope/<name>/… 에서 패키지 폴더 */
function packageDir(input) {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  return m?.[1];
}

const dirs = new Set();
for (const opts of entries) {
  const result = await esbuild.build({ ...opts, bundle: true, write: false, metafile: true, outdir: 'out-notices', logLevel: 'silent' });
  for (const input of Object.keys(result.metafile.inputs)) {
    const dir = packageDir(input);
    if (dir) dirs.add(dir);
  }
}
// sql.js의 wasm은 esbuild를 거치지 않고 복사된다(esbuild.mjs).
dirs.add('node_modules/sql.js');

const MIT_TEMPLATE = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** README의 `## License` 절. 다음 `## ` 제목 전까지 */
function readmeLicense(dir) {
  const readme = readdirSync(dir).find((f) => /^readme(\.|$)/i.test(f));
  if (!readme) return undefined;
  const m = /^#+\s*licen[sc]e\s*$([\s\S]*?)(?=^#+\s|(?![\s\S]))/im.exec(readFileSync(path.join(dir, readme), 'utf8'));
  const text = m?.[1].trim();
  // 배지만 있는 절은 쓸모가 없다.
  return text && /permission is hereby granted|copyright/i.test(text) ? text : undefined;
}

function licenseText(dir, pkg, license) {
  const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
  if (file) return { text: readFileSync(path.join(dir, file), 'utf8').trim() };
  const fromReadme = readmeLicense(dir);
  if (fromReadme) return { text: fromReadme, note: 'from the package README' };
  if (license === 'MIT') {
    const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
    if (author) return { text: MIT_TEMPLATE(author.replace(/\s*<[^>]*>/, '')), note: 'standard MIT text; the package declares MIT but ships no license file' };
  }
  return {};
}

const packages = [...dirs]
  .map((dir) => {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'UNKNOWN';
    return {
      name: pkg.name,
      version: pkg.version,
      license,
      repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url,
      ...licenseText(dir, pkg, license),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const missing = packages.filter((p) => !p.text);
if (missing.length) {
  console.warn(`License file not found for: ${missing.map((p) => p.name).join(', ')}`);
}

let out = `# Third-Party Notices

BindB bundles the following open-source packages. Each is distributed under its own license, reproduced below.

| Package | Version | License |
|---|---|---|
${packages.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`).join('\n')}

BindB does not bundle the H2 database engine. When you open an H2 database file, BindB runs the
\`h2-*.jar\` you configure in \`bindb.h2.jarPath\`; H2 is dual-licensed under MPL 2.0 and EPL 1.0.
`;
for (const p of packages) {
  out += `\n---\n\n## ${p.name} ${p.version}\n\nLicense: ${p.license}${p.repository ? `  \nSource: ${p.repository.replace(/^git\+/, '')}` : ''}${p.note ? `  \nText: ${p.note}` : ''}\n\n`;
  out += p.text ? '```\n' + p.text + '\n```\n' : '_No license file shipped with the package; see the license field above._\n';
}

writeFileSync('THIRD_PARTY_NOTICES.md', out);
console.log(`THIRD_PARTY_NOTICES.md: ${packages.length} packages`);
if (!existsSync('LICENSE')) console.warn('LICENSE is missing.');
