# npm 릴리스

[English](../releasing.md) | 한국어

[GitHub 저장소](https://github.com/hyeonse-swing/browser-error-log)에 MIT 라이선스 소스가 있습니다. SDK 패키지 3개 모두 `0.1.0`이 게시되었습니다. 브라우저 SDK와 프로토콜은 `0.1.1`도 게시되었지만 `browser-error-log-react@0.1.1`은 게시되지 않았고 React 어댑터의 최신 공개 버전은 `0.1.0`입니다. `0.1.2` 유지보수 릴리스는 준비 중이며 아직 게시되지 않았습니다. workspace 루트와 앱은 private입니다. npm 게시와 GitHub 릴리스·태그는 별개입니다.

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

## 준비 중인 `0.1.2` 유지보수 릴리스

`0.1.2`는 후보이며 아직 게시되거나 레지스트리에서 검증된 릴리스가 아닙니다. 유지보수 변경 내용은 다음과 같습니다.

- 브라우저 SDK는 오류 텍스트와 context의 상대 URL 형태 값에서 쿼리 문자열을 제거하고 상대 경로는 유지합니다. 슬래시 포함 경로, 슬래시 없는 같은 디렉터리 경로, 쿼리만 있는 참조, 대괄호·해시가 있는 경우도 처리합니다. 이는 최선형 마스킹이며 완전한 비식별화를 보장하지 않습니다.
- React Error Boundary는 컴포넌트가 `null`, `undefined`, `false`, `0`, 빈 문자열, 그 밖의 `Error`가 아닌 값, 또는 `toString`이 예외를 던지는 값을 throw해도 fallback에 `Error`를 전달합니다. 원래 throw된 값은 `captureException`에 그대로 전달합니다.
- JSONL 시작 시 기존 로그가 낮아진 파일 크기·개수 상한을 넘으면, 이미 수신 확인된 기록을 삭제하지 않고 시작을 거절합니다. 잘린 마지막 줄 복구는 계속 지원합니다.
- 대시보드 테스트는 시계를 고정해 fixture가 현재 날짜에 따라 실패하지 않게 했습니다. 런타임 동작은 바뀌지 않습니다.

`npm run check`에서 타입 검사, 12개 파일의 테스트 96개, 빌드가 통과했고 브라우저 SDK gzip 크기는 20,480바이트 제한 중 4,934바이트였습니다. `npm run check:package`에서 분리된 환경의 `0.1.2` tarball 설치와 TypeScript·ESM·CommonJS·SSR·React 없는 브라우저 전용 검사가 통과했습니다. 빌드된 마이크로 서버 smoke 검사도 통과했습니다. 레지스트리 게시와 검증은 아직 완료되지 않았습니다.

릴리스 검증 명령은 다음과 같습니다.

```sh
npm ci
npm run check
npm run check:package
npm run check:micro
```

현재 게시된 브라우저 SDK는 `npm install browser-error-log`로 설치하고 프로토콜 의존성은 자동으로 설치됩니다. React에는 게시된 `0.1.0` 조합인 `npm install browser-error-log@0.1.0 browser-error-log-react@0.1.0`을 사용하세요. `0.1.2` workspace의 `check:package`는 `output/packages/`에 `browser-error-log-protocol-0.1.2.tgz`, `browser-error-log-0.1.2.tgz`, `browser-error-log-react-0.1.2.tgz`를 만듭니다. [SDK 가이드](personal-sdk.md)를 참고하세요. 로컬 tarball만으로 레지스트리 게시가 증명되지는 않습니다.

## 다음 릴리스

npm의 게시된 버전은 변경할 수 없습니다. `0.1.0`이나 이후 게시한 버전을 다시 게시하지 말고 다음 릴리스마다 새 버전을 사용하세요.

1. MIT 라이선스가 포함 소스·자산에 계속 적용되는지 확인합니다. `company/`, 로컬 데이터, 비밀, 로그, 검증 결과는 패키지 tarball에 넣지 않습니다.
2. 패키지 메타데이터, README, 의존성 버전, tarball 파일을 갱신·검토합니다. workspace 루트와 앱은 private으로 유지합니다.
3. 위 로컬 검사를 실행합니다. 인증된 npm 계정과 필요한 로그인·2FA를 사용하고 자격증명·토큰을 저장소, 명령 인수, 로그에 남기지 않습니다. 프로토콜 → 브라우저 SDK → React 어댑터 순서로 게시합니다.
4. npm에서 새 버전, `dist.integrity`, tarball 내용을 확인합니다. 레지스트리 패키지를 새 consumer에 설치해 TypeScript·ESM·CommonJS·SSR을 다시 시험합니다.
5. GitHub 릴리스나 태그를 만든다면 npm 게시와 별도로 생성·검증합니다.

루트 패키지의 `private: true`는 의도된 설정입니다. SDK 패키지 게시를 위해 변경하거나 루트를 게시하지 마세요. 로컬 `npm pack`, GitHub 태그, 워크플로 시작만으로 npm 게시가 증명되지는 않습니다.

인프라는 포함되지 않습니다. 호스팅, 서버, 데이터베이스, 스토리지, 대역폭, 도메인, 백업 및 제3자 서비스는 각 운영자가 선택하고 비용을 부담합니다. 요금은 해당 제공업체가 이 프로젝트 및 유지관리자와 독립적으로 청구합니다.
