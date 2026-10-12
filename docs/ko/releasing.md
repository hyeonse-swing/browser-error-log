# npm 릴리스

[English](../releasing.md) | 한국어

[GitHub 저장소](https://github.com/hyeonse-swing/browser-error-log)에 MIT 라이선스 소스가 있습니다. 브라우저 SDK, 프로토콜, React 어댑터의 `0.1.2` 버전이 npm에 게시되어 있습니다. SDK 패키지 3개 모두 `0.1.0`도 게시되었고, 브라우저 SDK와 프로토콜은 `0.1.1`도 게시되었습니다. `browser-error-log-react@0.1.1`은 게시되지 않았으며, `0.1.2` 이전 React 어댑터의 최신 공개 버전은 `0.1.0`이었습니다. workspace 루트와 앱은 private입니다. npm 게시와 GitHub 릴리스·태그는 별개입니다.

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

## main 푸시 후 자동 릴리스

SDK 변경을 `main`에 푸시하면 [Prepare npm release](https://github.com/hyeonse-swing/browser-error-log/actions/workflows/prepare.yml)가 시작됩니다. 이전 릴리스 이후 패키지·빌드 관련 변경을 확인하고 공통 patch 버전을 올린 뒤 릴리스 검사를 실행합니다. 루트 README, 가이드, 뷰어만 바뀐 경우에는 SDK를 게시하지 않습니다.

준비 단계는 패키지 버전, 의존성 고정 버전, lockfile, SDK 버전 값을 함께 커밋하고 해당 커밋에 `vX.Y.Z` 태그를 붙여 푸시합니다. 이어서 그 태그로 [Publish npm release](https://github.com/hyeonse-swing/browser-error-log/actions/workflows/publish.yml)를 실행합니다. 게시 단계는 정확히 그 소스를 다시 빌드·검사하고 프로토콜 → 브라우저 SDK → React 어댑터 순서로 게시한 뒤 레지스트리 파일과 새 설치를 검증합니다. 태그는 릴리스 버전을 예약하며, 게시 워크플로가 성공해야 릴리스 완료입니다.

인증에는 GitHub OIDC 기반의 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)을 사용합니다. 각 패키지는 `hyeonse-swing/browser-error-log` 저장소, `publish.yml` 워크플로, `npm` 환경에 직접 게시 권한으로 연결됩니다. GitHub의 해당 환경에는 `v*` 태그만 허용하며, 저장소 ruleset으로 해당 태그의 변경·삭제를 막습니다. npm 토큰 시크릿은 필요하지 않습니다. Trusted Publisher 연결을 변경할 때에는 npm이 유지관리자에게 2단계 인증을 요청할 수 있습니다.

게시가 중간에 멈추면 원래 태그로 실패한 게시 워크플로를 다시 실행합니다. 이미 게시된 패키지는 무결성을 확인하고, 없는 패키지만 게시합니다. 해당 태그를 옮기거나 같은 버전의 소스를 바꾸지 마세요. 미완료 릴리스가 있으면 준비 단계는 버전을 추가로 올리지 않습니다. 게시가 성공하면 준비 단계가 다시 실행되어 그동안 들어온 SDK 변경을 확인합니다. 같은 검사를 수동으로 시작할 수도 있습니다.

```sh
# vX.Y.Z를 실패한 릴리스의 기존 태그로 바꿉니다.
gh workflow run publish.yml --repo hyeonse-swing/browser-error-log --ref vX.Y.Z
gh workflow run prepare.yml --repo hyeonse-swing/browser-error-log --ref main
```

저장소 About의 웹사이트와 README 배지는 npm에 연결됩니다. GitHub의 Packages 사이드바는 별도 레지스트리인 GitHub Packages용이며, 이 패키지들은 npmjs.org에 게시합니다.

## 수동 릴리스 체크리스트

npm의 게시된 버전은 변경할 수 없습니다. `0.1.0`이나 이후 게시한 버전을 다시 게시하지 말고 다음 릴리스마다 새 버전을 사용하세요.

1. MIT 라이선스가 포함 소스·자산에 계속 적용되는지 확인합니다. `company/`, 로컬 데이터, 비밀, 로그, 검증 결과는 패키지 tarball에 넣지 않습니다.
2. 패키지 메타데이터, README, 의존성 버전, tarball 파일을 갱신·검토합니다. workspace 루트와 앱은 private으로 유지합니다.
3. 위 로컬 검사를 실행합니다. 인증된 npm 계정과 필요한 로그인·2FA를 사용하고 자격증명·토큰을 저장소, 명령 인수, 로그에 남기지 않습니다. 프로토콜 → 브라우저 SDK → React 어댑터 순서로 게시합니다.
4. npm에서 새 버전, `dist.integrity`, tarball 내용을 확인합니다. 레지스트리 패키지를 새 consumer에 설치해 TypeScript·ESM·CommonJS·SSR을 다시 시험합니다.
5. GitHub 릴리스나 태그를 만든다면 npm 게시와 별도로 생성·검증합니다.

루트 패키지의 `private: true`는 의도된 설정입니다. SDK 패키지 게시를 위해 변경하거나 루트를 게시하지 마세요. 로컬 `npm pack`, GitHub 태그, 워크플로 시작만으로 npm 게시가 증명되지는 않습니다.

인프라는 포함되지 않습니다. 호스팅, 서버, 데이터베이스, 스토리지, 대역폭, 도메인, 백업 및 제3자 서비스는 각 운영자가 선택하고 비용을 부담합니다. 요금은 해당 제공업체가 이 프로젝트 및 유지관리자와 독립적으로 청구합니다.
