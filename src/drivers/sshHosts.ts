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
  identityFile?: string;
}

/** ~/.ssh/config 내용에서 alias에 맞는 값을 모은다(처음 나온 값이 이긴다 — OpenSSH 규칙) */
export function resolveSshConfig(text: string, alias: string, home = ''): SshConfigEntry {
  const out: SshConfigEntry = {};
  let applies = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = /^(\S+)\s*(?:=\s*|\s+)(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      applies = value.split(/\s+/).some((p) => !p.startsWith('!') && globMatch(p, alias)) && !value.split(/\s+/).some((p) => p.startsWith('!') && globMatch(p.slice(1), alias));
      continue;
    }
    if (key === 'match' || !applies) {
      if (key === 'match') applies = false;
      continue;
    }
    if (key === 'hostname' && out.hostName === undefined) out.hostName = value.replace(/%h/g, alias);
    else if (key === 'user' && out.user === undefined) out.user = value;
    else if (key === 'port' && out.port === undefined) out.port = Number(value) || undefined;
    else if (key === 'identityfile' && out.identityFile === undefined) out.identityFile = value.replace(/^~(?=\/|$)/, home);
  }
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

/** known_hosts 내용에서 host:port의 키를 찾는다. 같은 키가 있으면 known, 호스트는 있는데 키가 다르면 changed */
export function checkKnownHost(knownHosts: string, host: string, port: number, key: Buffer): HostKeyStatus {
  const name = hostPattern(host, port);
  const keyB64 = key.toString('base64');
  let seenHost = false;
  for (const raw of knownHosts.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    // @revoked: 이 키는 거부한다. @cert-authority는 여기서 쓰지 않는다
    if (parts[0] === '@revoked') {
      if (parts[3] === keyB64) return 'changed';
      continue;
    }
    if (parts[0].startsWith('@')) continue;
    const [hosts, , b64] = parts;
    if (!b64 || !hostsMatch(hosts, name)) continue;
    seenHost = true;
    if (b64 === keyB64) return 'known';
  }
  return seenHost ? 'changed' : 'unknown';
}

function hostsMatch(field: string, name: string): boolean {
  if (field.startsWith('|1|')) {
    // 해시된 항목: |1|base64(salt)|base64(HMAC-SHA1(salt, host))
    const [, , salt, hash] = field.split('|');
    if (!salt || !hash) return false;
    return createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64') === hash;
  }
  return field.split(',').some((p) => !p.startsWith('!') && globMatch(p, name));
}

/** known_hosts에 덧붙일 줄(평문 호스트) */
export function knownHostsLine(host: string, port: number, keyType: string, key: Buffer): string {
  return `${hostPattern(host, port)} ${keyType} ${key.toString('base64')}\n`;
}

/** SSH 공개키 바이트의 맨 앞 문자열이 키 종류(ssh-ed25519 등) */
export function keyType(key: Buffer): string {
  const len = key.readUInt32BE(0);
  return key.subarray(4, 4 + len).toString('ascii');
}
