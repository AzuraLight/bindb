import { createHash } from 'node:crypto';

/** 비밀 값 종류: DB 비밀번호 · SSL 클라이언트 키 비밀번호 · SSH 비밀번호(또는 키 암호) */
export type SecretKind = 'password' | 'sslKey' | 'ssh';
export const PREFIX: Record<SecretKind, string> = { password: 'bindb.pw', sslKey: 'bindb.sslkey', ssh: 'bindb.ssh' };

/**
 * 키체인 항목 이름. 키체인은 모든 작업 공간이 함께 쓴다.
 *  - 전역 연결 · 공유 SSH 설정: bindb.pw.<id>
 *  - 프로젝트 연결: bindb.pw.project.<작업 공간>.<id>
 * 프로젝트 연결을 id 하나로 저장하면, 공개 저장소에 드러난 id를 그대로 쓰고 호스트만 바꾼 다른 저장소가
 * 그 비밀번호를 자기 호스트로 보내게 할 수 있다(전역 연결과 같은 id도 마찬가지).
 */
export function secretKey(kind: SecretKind, id: string, workspace?: string): string {
  return workspace ? `${PREFIX[kind]}.project.${workspace}.${id}` : `${PREFIX[kind]}.${id}`;
}

/** 작업 공간을 가리키는 짧은 이름(.code-workspace 파일 또는 첫 폴더) */
export function workspaceKey(uri: { toString(): string } | undefined): string | undefined {
  return uri ? createHash('sha256').update(uri.toString()).digest('hex').slice(0, 16) : undefined;
}
