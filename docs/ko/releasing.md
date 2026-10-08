# npm 릴리스

[English](../releasing.md) | 한국어

[GitHub 저장소](https://github.com/hyeonse-swing/browser-error-log)에 MIT 라이선스 소스가 있습니다. `browser-error-log-protocol`, `browser-error-log`, `browser-error-log-react`의 `0.1.0` 버전은 npm에 게시되었습니다. workspace 루트와 앱은 private이며 SDK 패키지 3개만 공개됩니다. 이번 npm 게시 과정에서 GitHub 릴리스나 태그는 만들지 않았습니다.

## 검증된 `0.1.0` 패키지

2026년 10월 8일 게시되었습니다.

| 패키지 | 역할 |
| --- | --- |
| [browser-error-log](https://www.npmjs.com/package/browser-error-log/v/0.1.0) | 브라우저 SDK |
| [browser-error-log-react](https://www.npmjs.com/package/browser-error-log-react/v/0.1.0) | 선택적 React Error Boundary |
| [browser-error-log-protocol](https://www.npmjs.com/package/browser-error-log-protocol/v/0.1.0) | 이벤트·조회 계약 |

`0.1.0` 레지스트리의 3개 아티팩트 모두 검토한 tarball의 SHA-512 무결성 값과 일치합니다. 새 consumer 설치에서 TypeScript, ESM, CommonJS, SSR smoke 검사와 React 없는 브라우저 전용 설치가 통과했습니다. `0.1.0` 로컬 릴리스 검사에서는 테스트 74개, 패키지 검사, 빌드된 마이크로 서버 검사가 통과했습니다.

## `0.1.1` 다국어 릴리스 후보

게시 전인 `0.1.1` 업데이트는 뷰어·데모·설치 예제에 영어 기본 언어 선택기를 추가합니다. 브라우저 저장소를 사용할 수 있으면 선택을 기억합니다. 영어·한국어 문서를 양방향으로 연결했습니다. SDK 런타임 API와 v1 이벤트 스키마는 바뀌지 않으며 `sdkVersion`이 새 패키지 릴리스를 식별합니다. 로컬 다국어 검사에서는 테스트 81개가 통과했습니다. 이는 로컬 결과이며 **npm에서 `0.1.1`을 설치할 수 있다는 증거가 아닙니다.**

게시 전 로컬 검증 재현 명령은 다음과 같습니다.

```sh
npm ci
npm run check
npm run check:package
npm run check:micro
```

현재 게시된 패키지 설치 명령은 `npm install browser-error-log`, React 앱에서는 `npm install browser-error-log browser-error-log-react`이며 새 릴리스 확인 전에는 npm이 `0.1.0`을 설치할 수 있습니다. 프로토콜 패키지는 직접 import하지 않으면 의존성으로 설치됩니다. 이 `0.1.1` 소스 체크아웃에서 `check:package`는 `output/packages/`에 `browser-error-log-protocol-0.1.1.tgz`, `browser-error-log-0.1.1.tgz`, `browser-error-log-react-0.1.1.tgz`를 만듭니다. [SDK 가이드](personal-sdk.md)를 참고하세요. 로컬 tarball은 레지스트리 게시 증거가 아닙니다.

## 다음 릴리스

npm의 게시된 버전은 변경할 수 없습니다. `0.1.0`이나 이후 게시한 버전을 다시 게시하지 말고 다음 릴리스마다 새 버전을 사용하세요.

1. MIT 라이선스가 포함 소스·자산에 계속 적용되는지 확인합니다. `company/`, 로컬 데이터, 비밀, 로그, 검증 결과는 패키지 tarball에 넣지 않습니다.
2. 패키지 메타데이터, README, 의존성 버전, tarball 파일을 갱신·검토합니다. workspace 루트와 앱은 private으로 유지합니다.
3. 위 로컬 검사를 실행합니다. 인증된 npm 계정과 필요한 로그인·2FA를 사용하고 자격증명·토큰을 저장소, 명령 인수, 로그에 남기지 않습니다. 프로토콜 → 브라우저 SDK → React 어댑터 순서로 게시합니다.
4. npm에서 새 버전, `dist.integrity`, tarball 내용을 확인합니다. 레지스트리 패키지를 새 consumer에 설치해 TypeScript·ESM·CommonJS·SSR을 다시 시험합니다.
5. GitHub 릴리스나 태그를 만든다면 npm 게시와 별도로 생성·검증합니다.

루트 패키지의 `private: true`는 의도된 설정입니다. SDK 패키지 게시를 위해 변경하거나 루트를 게시하지 마세요. 로컬 `npm pack`, GitHub 태그, 워크플로 시작만으로 npm 게시가 증명되지는 않습니다.

인프라는 포함되지 않습니다. 호스팅, 서버, 데이터베이스, 스토리지, 대역폭, 도메인, 백업 및 제3자 서비스는 각 운영자가 선택하고 비용을 부담합니다. 요금은 해당 제공업체가 이 프로젝트 및 유지관리자와 독립적으로 청구합니다.
