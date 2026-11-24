# BindB 1.0.0 로드맵 (2026-11-24)

1.0.0은 처음으로 밖에 내보내는 버전이다(그 전까지는 마켓플레이스 · Open VSX 게시 없음, GitHub draft 릴리스만).
그래서 1.0.0의 조건은 "기능이 많다"보다 "처음 쓰는 사람의 환경에서 깨지지 않는다"에 둔다.
정한 것은 **결정한 것**에 날짜와 함께 적는다.

## 지금 (0.4.0, 2026-11-24)

- DB: PostgreSQL · MySQL · SQLite · H2
- 탐색기 · 결과 그리드(편집 · 내보내기) · 트랜잭션 · 쿼리 기록 · 데이터 소스 패널(DataGrip 대화상자 모양)
- SQL 편집기: 자동 완성 · 없는 테이블/열 경고 · 정보 표시 · 선언으로 이동 · 참조 찾기
- 뷰 DDL 편집기(Go to DDL → Submit, 오래된 DDL 경고) · DDL 데이터 소스 · 가상 객체
- SSH(키 · 비밀번호 · 에이전트 · `~/.ssh/config`의 `ProxyJump` / `ProxyCommand`) · SSL
- AI 에이전트용 MCP 서버
- 시험: 단위 테스트 362개, VS Code 통합 테스트, 실제 PostgreSQL 16 · MySQL 26.10 · H2 2.3.232 테스트(환경 변수가 있을 때)
- 2026-11-06 설계 점검의 1~4순위는 0.3.0에서 처리했다([audit-2026-11-06.md](audit-2026-11-06.md)).

## 1.0.0 조건 (제안)

### 1. 세 OS에서 확인
지금까지 모든 시험은 macOS(Apple Silicon)에서만 했다. Windows · Linux에서만 도는 코드가 있다.
- Windows: SSH 에이전트 파이프(`\\.\pipe\openssh-ssh-agent`), ProxyCommand(`shell: true`, `taskkill /T`), 경로 · 줄바꿈
- Linux: `node:sqlite` 자식 프로세스, 키체인(VS Code SecretStorage) 동작
- **결정(2026-11-24): 1.0 조건으로 둔다.** GitHub Actions에서 macOS · Windows · Linux로 단위 테스트와 통합 테스트를 돌린다(실제 DB 테스트는 Linux 서비스 컨테이너로 — 방식은 만들 때 정한다). 지금 저장소에는 CI가 없다.

### 2. 알려진 제한을 고침
**결정(2026-11-24): 다음 버전(0.5.0)에서 고친다.**
- H2: 배열 열은 그리드에서 편집할 수 없다.
- MySQL 읽기 전용: DB 차원에서는 세션이 되돌릴 수 있어 실행 전 분류기에 의존한다.
- SSH: `Match` 블록은 건너뛴다. known_hosts의 `@cert-authority`는 쓰지 않는다. (점프 호스트를 `~/.ssh/config`에서만 읽는 것은 정한 방식이라 그대로 둔다.)
- DDL 편집: 뷰만 된다 → 머티리얼라이즈드 뷰 · 함수 · 프로시저 · 트리거. DataGrip은 트리거 · 프로시저 · 함수 · 뷰의 소스를 고쳐 Submit한다([문서](https://www.jetbrains.com/help/datagrip/modifying-source-code-of-database-objects.html)).

### 3. 확인 못 한 것을 확인
- DataGrip 스키마 패턴 문법 전체
- MySQL `CLIENT_FOUND_ROWS`(같은 값으로 저장하면 영향받은 행 수가 0인지 — 그리드 편집의 "1행이 아니면 되돌림"에 영향)
- MySQL `CALL`의 결과 집합 여러 개
- H2 1.x의 뷰 정의 형식(CREATE 문 전체로 주는지)

### 4. 공개 준비
- **결정(2026-11-24): `package.json`의 `"preview": true`를 1.0에서 뗀다.**
- **결정(2026-11-24): Open VSX에만 게시한다**(VS Code Marketplace는 하지 않는다). gitline처럼 `vX` 태그를 밀면 CI가 세 OS 테스트 → 패키지 → GitHub 릴리스(노트는 CHANGELOG) → Open VSX 게시를 한다. Open VSX 토큰은 저장소 비밀 값(`OVSX_PAT`)으로 둔다.
- README: 처음 쓰는 사람용 시작 안내 · 화면 그림, 개인정보(원격 전송 없음) 문구는 이미 있다
- 제3자 고지(THIRD_PARTY_NOTICES.md)는 패키지 때 만든다 — 그대로

## 기능 후보 (2026-11-24 승인)

알려진 제한(위 2절, 0.5.0)과 겹치는 것(DDL 편집 범위 · SSH · H2)은 빼고 남은 후보다.
기준: 처음 쓰는 사람이 DB 도구에 기본으로 기대하는가, 지금 구조로 크지 않게 넣을 수 있는가.

| 후보 | 지금 | 제안 | 이유 |
|---|---|---|---|
| 실행 계획(Explain Plan) | 없음 | **1.0에 넣음** | DB 도구의 기본 기능. 문장 실행 · 결과 그리드가 이미 있어 EXPLAIN 결과를 보여 주는 데서 시작할 수 있다. DataGrip에도 있다(문서 주소는 확인 안 됨) |
| SQL 서식 맞추기(Reformat) | 없음 | **1.0에 넣음** | 편집기에서 기본으로 기대하는 기능. 직접 만들기보다 서식 라이브러리를 쓰는 쪽을 조사한다(방언 · 라이선스 확인 안 됨). DataGrip Ctrl+Alt+L([문서](https://www.jetbrains.com/help/datagrip/reformat-and-rearrange-code.html)) |
| MariaDB | 없음 | **1.0에 넣음(확인부터)** | 사용자가 많다. MySQL 드라이버로 붙는지, 구조 정보 · `SHOW CREATE VIEW` 등이 같은지 실제 서버로 확인하고 차이만 고친다(지금은 확인 안 됨) |
| 이름 바꾸기 | 없음(참조 찾기는 있음) | 1.0 뒤 | 별칭 · WITH 이름만이면 작지만, 객체 이름은 DB 변경(`ALTER … RENAME`)과 다른 파일까지 이어져 크다. DataGrip Shift+F6([문서](https://www.jetbrains.com/help/datagrip/refactoring-source-code.html)) |
| CSV 등 데이터 가져오기 | 없음(내보내기만) | 1.0 뒤 | 형식 · 타입 맞추기 · 대용량 처리까지 범위가 크다. DataGrip 문서 확인 안 됨 |
| 테이블 만들기 · 고치기 대화상자 | 없음 | 1.0 뒤 | 화면과 DB별 DDL 생성이 모두 새로 필요해 가장 크다. 확인 안 됨 |

## 결정한 것

- 세 OS CI(macOS · Windows · Linux)는 1.0 조건이다 (2026-11-24)
- 게시는 Open VSX만 한다 (2026-11-24)
- 게시 방식: `vX` 태그를 밀면 CI가 테스트 · 패키지 · 릴리스 · Open VSX 게시를 한다(gitline 방식) (2026-11-24)
- `preview` 표시는 1.0에서 뗀다 (2026-11-24)
- 알려진 제한(2절)은 다음 버전(0.5.0)에서 고친다 (2026-11-24)
- 1.0 기능: 실행 계획 · SQL 서식 · MariaDB. 1.0 뒤: 이름 바꾸기 · 데이터 가져오기 · 테이블 대화상자 (2026-11-24)

## 진행 순서

1. 0.5.0: 알려진 제한 고침(2절)
2. 세 OS CI → Windows · Linux에서 깨지는 것 고침
3. 확인 못 한 것 확인(실제 서버)
4. 1.0에 넣기로 한 기능
5. 공개 준비(README · `preview` 떼기 · 태그 게시 CI) → 1.0.0
