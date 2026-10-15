# npm 릴리스

[English](../releasing.md) | 한국어

[GitHub 저장소](https://github.com/hyeonse-swing/browser-error-log)에 MIT 라이선스 소스가 있습니다. 아래 릴리스 기록은 기존 스코프 없는 브라우저 SDK, 프로토콜, React 어댑터의 검증된 버전입니다. SDK 패키지 3개 모두 `0.1.0`이 게시되었고, 브라우저 SDK와 프로토콜은 `0.1.1`도 게시되었습니다. `browser-error-log-react@0.1.1`은 게시되지 않았으며, `0.1.2` 이전 React 어댑터의 최신 공개 버전은 `0.1.0`이었습니다. workspace 루트와 앱은 private입니다. npm 게시와 GitHub 릴리스·태그는 별개입니다.

## 검증된 `@ihyeon` 스코프 릴리스 `0.1.5`

2026년 10월 12일 세 패키지를 public으로 게시했으며 npm `latest`가 모두 `0.1.5`입니다. npm에서 내려받은 tarball의 SHA-512 값이 검토한 최초 게시 파일과 일치합니다. 새 레지스트리 consumer에서 protocol 단독 설치, React 없는 SDK 설치, React 타입·ESM·CommonJS·SSR 검사가 통과했습니다. 필요한 기능만 설치할 수 있도록 개별 패키지를 유지합니다.

| 기존 패키지 | 스코프 패키지 | 사용 대상 |
| --- | --- | --- |
| `browser-error-log` | `@ihyeon/browser-error-log` | 브라우저 앱; React 불필요 |
| `browser-error-log-react` | `@ihyeon/browser-error-log-react` | Error Boundary를 쓰는 React 앱 |
| `browser-error-log-protocol` | `@ihyeon/browser-error-log-protocol` | 이벤트 계약만 쓰는 수집기·뷰어 |

SDK는 새 protocol 패키지에 의존하고 React 어댑터는 새 SDK에 의존합니다. React 자체는 peer dependency로 유지합니다. 기존 공개 버전과 릴리스 태그의 이름·무결성 기록은 그대로 보존합니다. 새 패키지를 설치하는 앱은 의존성과 import 경로를 함께 바꿔야 합니다. npm alias나 호환 wrapper는 포함하지 않습니다.

2026년 10월 12일 기존 이름의 npm 패키지 3개는 모든 버전에 각 `@ihyeon/*` 패키지로 이동하라는 안내를 붙여 deprecated 처리했습니다. 기존 버전 목록, latest 태그, tarball URL, 무결성 값은 유지했습니다. 기존 React 패키지를 새 consumer에 설치했을 때 세 패키지의 이동 안내가 표시됐고 SDK·React·protocol의 CommonJS·SSR 검사가 계속 통과했습니다. 새 스코프 패키지는 deprecated 처리하지 않고 활성 상태로 유지합니다.

최초 스코프 릴리스는 인증된 `ihyeon` 계정으로 직접 게시했으며 기존 GitHub 릴리스 태그와 별개입니다. 세 패키지에 GitHub 소유자 `hyeonse-swing`, 저장소 `browser-error-log`, 워크플로 `publish.yml`, 환경 `npm`의 Trusted Publishing을 설정하고 게시를 허용했습니다. 이 소스 전환이 `main`에 반영되면 자동 릴리스도 새 스코프 패키지 이름을 사용합니다. 이번 최초 게시에서 새 GitHub 태그나 GitHub Release는 만들지 않았습니다. 기존 `v0.1.5` 태그는 이전 이름의 릴리스로 유지하며 다음 자동 patch 릴리스는 새 버전·태그를 사용합니다. [Trusted Publishing 문서](https://docs.npmjs.com/trusted-publishers/)에서 설정 방식을 확인할 수 있습니다.

로컬에서 애플리케이션 테스트 96개, 릴리스 테스트 15개, 타입 검사, SDK·뷰어 빌드, 독립 tarball consumer, 빌드된 마이크로 서버 smoke, Chromium·WebKit 전송 테스트 6개가 통과했습니다. 브라우저 SDK는 gzip 4,934바이트입니다. 새 스코프의 tarball 파일명에는 `ihyeon-` 접두사가 붙습니다. 예: `ihyeon-browser-error-log-protocol-0.1.5.tgz`. 아래 검증 결과는 기존 이름의 패키지 기록입니다.

## 검증된 `0.1.0` 패키지

2026년 10월 8일 게시되었습니다.

| 패키지 | 역할 |
| --- | --- |
| [browser-error-log](https://www.npmjs.com/package/browser-error-log/v/0.1.0) | 브라우저 SDK |
| [browser-error-log-react](https://www.npmjs.com/package/browser-error-log-react/v/0.1.0) | 선택적 React Error Boundary |
| [browser-error-log-protocol](https://www.npmjs.com/package/browser-error-log-protocol/v/0.1.0) | 이벤트·조회 계약 |

`0.1.0` 레지스트리의 3개 아티팩트 모두 검토한 tarball의 SHA-512 무결성 값과 일치합니다. 새 consumer 설치에서 TypeScript, ESM, CommonJS, SSR smoke 검사와 React 없는 브라우저 전용 설치가 통과했습니다. `0.1.0` 로컬 릴리스 검사에서는 테스트 74개, 패키지 검사, 빌드된 마이크로 서버 검사가 통과했습니다.

## 게시된 `0.1.1` 패키지

| 패키지 | 역할 |
| --- | --- |
| [browser-error-log](https://www.npmjs.com/package/browser-error-log/v/0.1.1) | 브라우저 SDK |
| [browser-error-log-protocol](https://www.npmjs.com/package/browser-error-log-protocol/v/0.1.1) | 이벤트·조회 계약 |

링크한 `0.1.1` 두 버전은 npm 레지스트리에서 확인됩니다. 로컬 `0.1.1` React tarball이 게시된 것으로 해석하면 안 됩니다. 로컬 다국어 검사에서는 테스트 81개, SDK 빌드, 패키지 검사, 마이크로 서버 검사가 통과했습니다. 이 로컬 결과는 레지스트리 검증과 별개입니다.

이 저장소에서 빌드한 뷰어·데모·설치 예제에는 영어 기본 언어 선택기가 있으며 브라우저 저장소를 사용할 수 있으면 선택을 기억합니다. 영어·한국어 문서는 양방향으로 연결됩니다. 이 UI는 소스 저장소에서 빌드하며 **브라우저 SDK 런타임의 기능이 아닙니다.**

## 게시된 `0.1.2` 유지보수 릴리스

`0.1.2` 패키지 3개 모두 npm 레지스트리에서 게시·검증되었습니다.

| 패키지 | 역할 |
| --- | --- |
| [browser-error-log](https://www.npmjs.com/package/browser-error-log/v/0.1.2) | 브라우저 SDK |
| [browser-error-log-react](https://www.npmjs.com/package/browser-error-log-react/v/0.1.2) | 선택적 React Error Boundary |
| [browser-error-log-protocol](https://www.npmjs.com/package/browser-error-log-protocol/v/0.1.2) | 이벤트·조회 계약 |

레지스트리 아티팩트의 SHA-512 무결성 값이 검토한 tarball과 일치합니다. 레지스트리 패키지를 새 consumer에 설치한 TypeScript·ESM·CommonJS·SSR smoke 검사와 React 없는 브라우저 전용 설치가 통과했습니다. 유지보수 변경 내용은 다음과 같습니다.

- 브라우저 SDK는 오류 텍스트와 context의 상대 URL 형태 값에서 쿼리 문자열을 제거하고 상대 경로는 유지합니다. 슬래시 포함 경로, 슬래시 없는 같은 디렉터리 경로, 쿼리만 있는 참조, 대괄호·해시가 있는 경우도 처리합니다. 이는 최선형 마스킹이며 완전한 비식별화를 보장하지 않습니다.
- React Error Boundary는 컴포넌트가 `null`, `undefined`, `false`, `0`, 빈 문자열, 그 밖의 `Error`가 아닌 값, 또는 `toString`이 예외를 던지는 값을 throw해도 fallback에 `Error`를 전달합니다. 원래 throw된 값은 `captureException`에 그대로 전달합니다.
- JSONL 시작 시 기존 로그가 낮아진 파일 크기·개수 상한을 넘으면, 이미 수신 확인된 기록을 삭제하지 않고 시작을 거절합니다. 잘린 마지막 줄 복구는 계속 지원합니다.
- 대시보드 테스트는 시계를 고정해 fixture가 현재 날짜에 따라 실패하지 않게 했습니다. 런타임 동작은 바뀌지 않습니다.

`npm run check`에서 타입 검사, 12개 파일의 테스트 96개, 빌드가 통과했고 브라우저 SDK gzip 크기는 20,480바이트 제한 중 4,934바이트였습니다. `npm run check:package`에서 분리된 환경의 `0.1.2` tarball 설치와 TypeScript·ESM·CommonJS·SSR·React 없는 브라우저 전용 검사가 통과했습니다. 빌드된 마이크로 서버 smoke 검사도 통과했습니다.

릴리스 검증 명령은 다음과 같습니다.

```sh
npm ci
npm run check
npm run check:package
npm run check:micro
```

최신 브라우저 SDK는 `npm install browser-error-log`로 설치하고 프로토콜 의존성은 자동으로 설치됩니다. React에는 `npm install browser-error-log browser-error-log-react`를 사용하세요. `0.1.2` workspace의 `check:package`는 `output/packages/`에 `browser-error-log-protocol-0.1.2.tgz`, `browser-error-log-0.1.2.tgz`, `browser-error-log-react-0.1.2.tgz`를 만듭니다. [SDK 가이드](personal-sdk.md)를 참고하세요. 로컬 tarball만으로 레지스트리 게시가 증명되지는 않습니다.

## 검증된 `0.1.3` 자동 릴리스

첫 자동 릴리스는 2026년 10월 12일 완료됐습니다. `main` 푸시로 `0.1.3` 버전 커밋과 태그를 생성한 뒤, [GitHub Actions가 세 패키지를 모두 게시](https://github.com/hyeonse-swing/browser-error-log/actions/runs/38190950148)했습니다. 인증은 npm Trusted Publishing을 사용했습니다. 다운로드한 세 tarball 모두 `v0.1.3`에 기록한 SHA-512와 일치하며, npm에 provenance 증명이 포함되어 있습니다.

워크플로에서 릴리스 검사 7개, 애플리케이션 테스트 96개, 타입 검사, 빌드, 패키지·마이크로 서버 검사가 통과했습니다. 레지스트리에서 새로 설치한 TypeScript·ESM·CommonJS·SSR 검사와 React 없는 브라우저 전용 설치도 통과했습니다.

## 검증된 `0.1.4` 자동 릴리스

2026년 10월 12일 [후속 릴리스](https://github.com/hyeonse-swing/browser-error-log/actions/runs/38191998049)에서 세 패키지 모두 `0.1.4`로 게시됐습니다. 릴리스 검사 9개, 애플리케이션 테스트 96개, 타입 검사, 빌드, 패키지·마이크로 서버 검사와 레지스트리 새 설치 검사가 통과했습니다. 검증 당시 세 패키지 모두 npm의 `latest` 버전이었고 provenance 증명이 포함되어 있었으며, 다운로드한 tarball의 SHA-512가 `v0.1.4`에 기록한 값과 일치했습니다.

이 릴리스부터 게시 성공 후 준비 단계를 명시적으로 실행하며, 다음 릴리스를 허용하기 전에 GitHub API로 해당 게시 작업의 성공을 확인합니다. [자동 후속 검사](https://github.com/hyeonse-swing/browser-error-log/actions/runs/38192593921)도 성공했고, 추가 SDK 변경이 없어 버전을 올리지 않고 종료했습니다.

## main 푸시 후 자동 릴리스

SDK 변경을 `main`에 푸시하면 [Prepare npm release](https://github.com/hyeonse-swing/browser-error-log/actions/workflows/prepare.yml)가 시작됩니다. 이전 릴리스 이후 패키지·빌드 관련 변경을 확인하고 공통 patch 버전을 올린 뒤 릴리스 검사를 실행합니다. 루트 README, 가이드, 뷰어만 바뀐 경우에는 SDK를 게시하지 않습니다.

준비 단계는 패키지 버전, 의존성 고정 버전, lockfile, SDK 버전 값을 함께 커밋하고 해당 커밋에 `vX.Y.Z` 태그를 붙여 푸시합니다. 이어서 그 태그로 [Publish npm release](https://github.com/hyeonse-swing/browser-error-log/actions/workflows/publish.yml)를 실행합니다. 게시 단계는 정확히 그 소스를 다시 빌드·검사하고 프로토콜 → 브라우저 SDK → React 어댑터 순서로 게시한 뒤 레지스트리 파일과 새 설치를 검증합니다. 검증 후 별도 작업이 기존 태그의 [GitHub Release](https://github.com/hyeonse-swing/browser-error-log/releases)를 만들고 커밋 기반 변경 내역, 비교 링크, 세 npm 패키지 링크를 기록합니다. 같은 릴리스를 다시 실행하면 기존 GitHub Release를 재사용합니다. 태그는 릴리스 버전을 예약하며, 게시 워크플로가 성공해야 릴리스 완료입니다.

인증에는 GitHub OIDC 기반의 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)을 사용합니다. 각 패키지는 `hyeonse-swing/browser-error-log` 저장소, `publish.yml` 워크플로, `npm` 환경에 직접 게시 권한으로 연결됩니다. GitHub의 해당 환경에는 `v*` 태그만 허용하며, 저장소 ruleset으로 해당 태그의 변경·삭제를 막습니다. npm 토큰 시크릿은 필요하지 않습니다. Trusted Publisher 연결을 변경할 때에는 npm이 유지관리자에게 2단계 인증을 요청할 수 있습니다.

게시가 중간에 멈추면 원래 태그로 실패한 게시 워크플로를 다시 실행합니다. 이미 게시된 패키지는 무결성을 확인하고, 없는 패키지만 게시합니다. 해당 태그를 옮기거나 같은 버전의 소스를 바꾸지 마세요. 미완료 릴리스가 있으면 준비 단계는 버전을 추가로 올리지 않습니다. npm 검증과 GitHub Release 생성이 성공하면 게시 워크플로가 준비 단계를 명시적으로 다시 실행해 그동안 들어온 SDK 변경을 확인합니다. 이때 해당 태그의 npm 게시·GitHub Release 작업이 모두 성공했고 모든 패키지가 태그에 기록된 파일과 일치해야 다음 버전으로 진행합니다. 같은 검사를 수동으로 시작할 수도 있습니다.

```sh
# vX.Y.Z를 실패한 릴리스의 기존 태그로 바꿉니다.
gh workflow run publish.yml --repo hyeonse-swing/browser-error-log --ref vX.Y.Z
gh workflow run prepare.yml --repo hyeonse-swing/browser-error-log --ref main
```

저장소 About의 웹사이트와 README 배지는 npm에 연결됩니다. GitHub Releases에서는 저장소의 버전 기록을 확인할 수 있습니다. GitHub의 Packages 사이드바는 별도 레지스트리인 GitHub Packages용이며, 이 패키지들은 npmjs.org에 게시합니다.

## 수동 minor·major 릴리스

기본 동작은 자동 patch 릴리스입니다. minor 또는 major 버전을 의도적으로 선택하려면 `main`에서 `release_bump` 입력으로 준비 단계를 실행합니다.

```sh
gh workflow run prepare.yml --repo hyeonse-swing/browser-error-log --ref main -f release_bump=minor
# major 릴리스가 필요한 경우:
gh workflow run prepare.yml --repo hyeonse-swing/browser-error-log --ref main -f release_bump=major
```

minor는 minor 버전을 올리고 patch를 0으로, major는 major 버전을 올리고 minor·patch를 0으로 만듭니다. 명시적인 수동 요청은 새 SDK 파일 변경이 없어도 릴리스를 만듭니다. 이전 릴리스 완료 여부를 확인하고 동일한 검사, 버전 동기화, 변경 불가 태그 기반 게시 절차를 거칩니다. 이전 릴리스가 미완료이면 필요할 때 게시를 재개하고, 완료 후 수동 버전 증가를 다시 요청해야 한다고 알립니다. 푸시와 자동 후속 실행은 patch를 사용합니다. 공개 API를 변경할 때에는 호환성을 직접 판단해야 하며, 워크플로가 diff만으로 호환성을 추론하지는 않습니다.

수동 minor·major는 위 명령으로 매번 새 준비 실행을 요청합니다. 같은 요청이 다른 버전까지 예약하지 않도록 기존 준비 실행의 재실행은 거절합니다. 원래 실행에서 이미 태그를 만들었다면 해당 태그의 게시를 재개한 뒤 새 버전을 요청하세요.

## PR·브라우저 검사

[Verify changes](https://github.com/hyeonse-swing/browser-error-log/actions/workflows/ci.yml)는 `main` 대상 PR에서 실행되며 수동으로 실행할 수도 있습니다. 릴리스 로직, TypeScript, 애플리케이션 테스트, 빌드, 패키지 consumer, 마이크로 서버, 실제 Chromium·WebKit 전송을 검사합니다. 작업에는 저장소 읽기 권한만 있으며 패키지를 게시하지 않습니다. 브라우저 검사 실패 시 증거 파일을 워크플로 아티팩트로 7일간 보관합니다.

로컬에서는 `npx playwright install --with-deps chromium webkit` 후 `npm run check:browser`로 실행합니다. SDK와 수집기를 빌드하고 임시 로컬 데이터를 사용해 런타임 오류, 처리되지 않은 Promise 거부, HTTP 실패가 수집기에 도착하는지 검사합니다. 이 브라우저 엔진 검사로 실제 기기나 WebView 호환성까지 검증한 것은 아닙니다.

## 수동 릴리스 체크리스트

npm의 게시된 버전은 변경할 수 없습니다. `0.1.0`이나 이후 게시한 버전을 다시 게시하지 말고 다음 릴리스마다 새 버전을 사용하세요.

1. MIT 라이선스가 포함 소스·자산에 계속 적용되는지 확인합니다. `company/`, 로컬 데이터, 비밀, 로그, 검증 결과는 패키지 tarball에 넣지 않습니다.
2. 패키지 메타데이터, README, 의존성 버전, tarball 파일을 갱신·검토합니다. workspace 루트와 앱은 private으로 유지합니다.
3. 위 로컬 검사를 실행합니다. 인증된 npm 계정과 필요한 로그인·2FA를 사용하고 자격증명·토큰을 저장소, 명령 인수, 로그에 남기지 않습니다. 프로토콜 → 브라우저 SDK → React 어댑터 순서로 게시합니다.
4. npm에서 새 버전, `dist.integrity`, tarball 내용을 확인합니다. 레지스트리 패키지를 새 consumer에 설치해 TypeScript·ESM·CommonJS·SSR을 다시 시험합니다.
5. GitHub 릴리스나 태그를 만든다면 npm 게시와 별도로 생성·검증합니다.

루트 패키지의 `private: true`는 의도된 설정입니다. SDK 패키지 게시를 위해 변경하거나 루트를 게시하지 마세요. 로컬 `npm pack`, GitHub 태그, 워크플로 시작만으로 npm 게시가 증명되지는 않습니다.

인프라는 포함되지 않습니다. 호스팅, 서버, 데이터베이스, 스토리지, 대역폭, 도메인, 백업 및 제3자 서비스는 각 운영자가 선택하고 비용을 부담합니다. 요금은 해당 제공업체가 이 프로젝트 및 유지관리자와 독립적으로 청구합니다.
