import { createHash, createHmac } from 'node:crypto';

/*
 * SSH 설정 파일과 known_hosts(OpenSSH 형식).
 *  - Parse config file ~/.ssh/config: Host 별칭 → HostName · User · Port · IdentityFile
 *  - Strict host key checking: known_hosts에 있는 키와 맞는지(해시된 |1|salt|hash 항목 포함)
 */

export interface SshConfigEntry {
  hostName?: string;
  user?: string;
  port?: number;
  /** 첫 IdentityFile(예전 호출부용) */
  identityFile?: string;
  /** IdentityFile 전부, 나온 순서대로(OpenSSH는 차례로 시도한다) */
  identityFiles: string[];
  /** 아직 지원하지 않는다 — 있으면 바로 접속하지 않고 알린다 */
  proxyJump?: string;
  proxyCommand?: string;
}

export interface ResolveOptions {
  /** ~ 와 %d */
  home?: string;
  /** %u */
  localUser?: string;
  /** Include 패턴(~/.ssh 기준 상대 경로 · 글롭) → 그 파일들의 내용. 없으면 Include를 건너뛴다 */
  include?: (pattern: string) => string[];
}

/**
 * ~/.ssh/config 내용에서 alias에 맞는 값을 모은다(처음 나온 값이 이긴다 — OpenSSH 규칙).
 *  - Include: 그 자리에 파일 내용을 넣는다. Host 블록 안의 Include는 그 블록이 맞을 때만(ssh_config(5))
 *  - Match 블록은 조건을 평가하지 않고 건너뛴다(잘못 적용하는 것보다 안전)
 *  - 토큰: %h(호스트) · %p(포트) · %r(원격 사용자) · %u(로컬 사용자) · %d(홈) · %%
 * https://man.openbsd.org/ssh_config.5
 */
export function resolveSshConfig(text: string, alias: string, homeOrOpts: string | ResolveOptions = ''): SshConfigEntry {
  const o: ResolveOptions = typeof homeOrOpts === 'string' ? { home: homeOrOpts } : homeOrOpts;
  const home = o.home ?? '';
  const out: SshConfigEntry = { identityFiles: [] };
  let applies = true; // 첫 Host 줄 앞은 모든 호스트에 해당한다
  let depth = 0;
  const visit = (content: string) => {
    if (++depth > 16) return; // Include 순환
    for (const raw of content.split('\n')) {
      const line = raw.replace(/#.*/, '').trim();
      if (!line) continue;
      const m = /^(\S+)\s*(?:=\s*|\s+)(.+)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim().replace(/^"(.*)"$/, '$1');
      if (key === 'host') {
        const pats = value.split(/\s+/);
        applies = pats.some((p) => !p.startsWith('!') && globMatch(p, alias)) && !pats.some((p) => p.startsWith('!') && globMatch(p.slice(1), alias));
        continue;
      }
      if (key === 'match') {
        applies = false;
        continue;
      }
      if (!applies) continue;
      if (key === 'include') {
        for (const pattern of value.split(/\s+/)) for (const file of o.include?.(pattern.replace(/^~(?=\/|$)/, home)) ?? []) visit(file);
        continue;
      }
      if (key === 'hostname' && out.hostName === undefined) out.hostName = value;
      else if (key === 'user' && out.user === undefined) out.user = value;
      else if (key === 'port' && out.port === undefined) out.port = Number(value) || undefined;
      else if (key === 'identityfile' && value.toLowerCase() !== 'none') out.identityFiles.push(value);
      else if (key === 'proxyjump' && out.proxyJump === undefined && value.toLowerCase() !== 'none') out.proxyJump = value;
      else if (key === 'proxycommand' && out.proxyCommand === undefined && value.toLowerCase() !== 'none') out.proxyCommand = value;
    }
    depth--;
  };
  visit(text);
  // 토큰은 값을 다 모은 뒤 바꾼다(%p · %r은 다른 줄의 Port · User)
  const tokens: Record<string, string> = {
    h: alias,
    p: String(out.port ?? 22),
    r: out.user ?? o.localUser ?? '',
    u: o.localUser ?? '',
    d: home,
    '%': '%',
  };
  const expand = (v: string) => v.replace(/%([hprud%])/g, (_, t: string) => tokens[t]);
  if (out.hostName) out.hostName = expand(out.hostName);
  tokens.h = out.hostName ?? alias;
  out.identityFiles = out.identityFiles.map((f) => expand(f).replace(/^~(?=\/|$)/, home));
  if (out.identityFiles.length) out.identityFile = out.identityFiles[0];
  return out;
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(value);
}

/** known_hosts에서 쓰는 호스트 표기: 22번이 아니면 [host]:port */
export function hostPattern(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** 키의 SHA256 지문(ssh-keygen -l 과 같은 모양) */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

export type HostKeyStatus = 'known' | 'unknown' | 'changed';

export type HostKeyResult = HostKeyStatus | 'revoked';

/**
 * known_hosts 내용에서 host:port의 키를 찾는다(sshd(8) SSH_KNOWN_HOSTS FILE FORMAT).
 *  - 같은 종류 · 같은 키가 있으면 known
 *  - 같은 종류인데 키가 다르면 changed
 *  - 그 호스트에 다른 종류의 키만 있으면 unknown(새 키 종류 — 처음 보는 키처럼 묻는다)
 *  - @revoked 키면 revoked(무조건 거부)
 *  - @cert-authority 줄은 인증서용이라 일반 호스트 키와 비교하지 않는다
 * 여러 파일(~/.ssh/known_hosts · /etc/ssh/ssh_known_hosts)은 내용을 이어 붙여 넘긴다.
 */
export function checkKnownHost(knownHosts: string, host: string, port: number, key: Buffer): HostKeyResult {
  const name = hostPattern(host, port);
  const keyB64 = key.toString('base64');
  const type = keyType(key);
  let changed = false;
  let known = false;
  for (const raw of knownHosts.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === '@revoked') {
      if (parts[3] === keyB64 && hostsMatch(parts[1], name)) return 'revoked';
      continue;
    }
    if (parts[0].startsWith('@')) continue;
    const [hosts, lineType, b64] = parts;
    if (!b64 || !hostsMatch(hosts, name)) continue;
    if (b64 === keyB64) known = true;
    else if (lineType === type) changed = true;
  }
  return known ? 'known' : changed ? 'changed' : 'unknown';
}

/** 쉼표로 나눈 패턴들: 하나라도 맞고, !패턴은 하나도 맞지 않아야 한다 */
function hostsMatch(field: string, name: string): boolean {
  if (field.startsWith('|1|')) {
    // 해시된 항목: |1|base64(salt)|base64(HMAC-SHA1(salt, host))
    const [, , salt, hash] = field.split('|');
    if (!salt || !hash) return false;
    return createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64') === hash;
  }
  const pats = field.split(',');
  if (pats.some((p) => p.startsWith('!') && globMatch(p.slice(1), name))) return false;
  return pats.some((p) => !p.startsWith('!') && globMatch(p, name));
}

/** known_hosts에 덧붙일 줄(평문 호스트) */
export function knownHostsLine(host: string, port: number, keyType: string, key: Buffer): string {
  return `${hostPattern(host, port)} ${keyType} ${key.toString('base64')}\n`;
}

/** SSH 공개키 바이트의 맨 앞 문자열이 키 종류(ssh-ed25519 등) */
export function keyType(key: Buffer): string {
  if (key.length < 4) return '';
  const len = key.readUInt32BE(0);
  return key.subarray(4, 4 + len).toString('ascii');
}
