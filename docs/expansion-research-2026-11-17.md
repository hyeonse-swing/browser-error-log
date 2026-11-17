# SDK 오류 추적 확장 조사 — 2026-11-17

## 확인한 현재 동작

- 공개 `origin/main`은 `99c09c4`이며 SDK·프로토콜·React 패키지 버전은 0.2.11이다. 공개 저장소의 열린 GitHub 이슈는 `gh issue list --state open` 결과 0건이다.
- SDK는 수동 `captureException(error, extra?)` 호출에서 이벤트 ID를 생성하지만 반환형이 `void`여서 호출자가 해당 기록을 고객 문의나 재현 기록과 연결할 수 없다. 이벤트는 `(project, eventId)`로 조회하고 재시도 시 같은 ID를 유지한다 (`packages/browser/src/index.ts`, `docs/integration.md`).
- 기존 `getContext`, breadcrumb, 진단 카운터, 반복 오류 억제, 전달 재시도는 이미 있다. 소스맵·이슈 묶음은 별도 저장/권한 정책이 필요한 로드맵 항목이다. 이번 작업은 수집된 단일 오류의 식별 가능성에 집중한다.
- [Sentry의 이벤트 조회 API](https://docs.sentry.io/api/events/retrieve-an-event-for-a-project/)도 프로젝트와 이벤트 ID를 개별 오류 조회 키로 사용한다. 이는 ID를 호출자에게 노출하는 활용 사례의 참고이며, 이 저장소의 전송 성공을 보증하는 근거는 아니다.

## 선택과 범위

`init()`이 반환하는 새 `BrowserErrorLogCaptureClient`의 `captureException`이 오류가 실제 SDK 큐에 받아들여졌을 때 그 이벤트의 `eventId`를 반환하고, 비활성화·중복·필터·샘플링·제한·처리 오류에서는 `undefined`를 반환한다. 기존 `BrowserErrorLogClient`와 `BrowserErrorLogDiagnosticsClient` 인터페이스의 `void` 반환 계약은 유지해 React 어댑터와 사용자 제공 mock/구현의 호환성을 지킨다. 새 반환값을 쓸 때는 `init()`의 추론 타입 또는 `BrowserErrorLogCaptureClient`를 사용한다. 와이어 스키마나 수집기·뷰어 계약은 바꾸지 않는다. 반환된 ID는 **큐 수락**의 증거이며 서버 저장이나 조회 가능성을 보장하지 않는다. 자동 수집에는 이 반환 경로를 적용하지 않는다.

## 검증 기준

1. 수동 캡처 반환 ID와 실제 전송 이벤트 ID가 일치하고 재시도에도 유지된다.
2. 동일 객체 중복, `beforeSend` 거부, rate limit, 비활성/파괴된 클라이언트는 ID를 반환하지 않는다.
3. React 어댑터 포함 타입·테스트·빌드와 독립 설치 패키지 검사가 통과하며 기존 이벤트 필드·개인정보 기본값은 그대로다.

## 후속 과제

반환 ID를 사용자에게 보여줄지, 내부 지원 기록에 붙일지는 앱의 개인정보·운영 정책으로 정한다. 전송 실패·브라우저 종료·수집기에서 거부된 이벤트에는 ID만 남을 수 있다. 이 기능은 정확히 한 번 전송이나 서버 조회 성공을 뜻하지 않는다.

## 후속 조사: 성능별 수집 모드 (2026-11-17, v0.2.12 기준)

사용자가 자동 수집 범위를 게임의 성능 설정처럼 간단히 고르고, 필요하면 개별 옵션으로 조정할 수 있는 방식을 요청했다. 작업 시작 시 `origin/main`은 `a52e627` / SDK 0.2.12이고 `gh issue list`의 열린 이슈는 0건이다. 현재 `packages/browser/src/index.ts`의 초기화 경로와 SDK 안내를 확인했다.

| 현재 스위치 | 기존 기본값 | 설치/처리 범위 |
| --- | --- | --- |
| `captureGlobalErrors` | 켜짐 | 전역 `error` 리스너 |
| `captureUnhandledRejections` | 켜짐 | 전역 `unhandledrejection` 리스너 |
| `captureNetwork` | 켜짐 | fetch/XHR 계측, 사용자 transport는 `endpoint`가 있어야 설치 |
| `captureConsole` | 꺼짐 | `console.error` 래핑 |
| `captureResourceErrors` | 꺼짐 | 이미지·스크립트·스타일 리소스 오류 리스너 |
| `captureNavigation` | 꺼짐 | History 이동 breadcrumb 계측 |
| `captureNetworkBreadcrumbs` | 꺼짐 | fetch/XHR 완료 breadcrumb 계측, 사용자 transport는 `endpoint` 필요 |
| `captureErrorCause` | 꺼짐 | 수집된 Error의 `cause` 열람 및 정리 |
| `captureStack` (신규) | 켜짐 | `stack`·`componentStack` 저장; 꺼지면 오류·원인 스택을 읽거나 저장하지 않음 |

수집 빈도·전송량에는 별도 `sampleRate`, `maxEventsPerMinute`, `dedupeIntervalMs`, `ignoreMessages`, `maxQueueSize`, `maxBatchSize`, `flushIntervalMs` 등이 있다. `enabled:false`는 전체 수집 중지다. 모드에서 이 제한값을 암묵적으로 바꾸면 사용자가 기대하는 보존/손실 정책이 달라지므로 그대로 둔다. 타이머와 pagehide/visibility 전송 처리는 수동 모드에서도 유지해 큐에 수락된 수동 이벤트가 기존 방식으로 전송되게 한다.

결정: `preset?: 'minimal' | 'standard' | 'detailed'`와 `captureStack?: boolean`을 SDK 설정에 추가한다. 기본 `standard`는 기존 8개 스위치 기본값과 스택 포함 동작이 완전히 같다. `minimal`은 8개 자동 계측·원인 열람을 모두 끄고 스택도 생략하지만 `captureException`과 `addBreadcrumb`는 유지한다. `detailed`는 기존 범위 내에서 8개를 켜고 스택을 포함한다. 명시한 개별 boolean은 선택된 모드보다 우선하고, `undefined`는 모드값을 따른다. 한 클라이언트에서 초기화 시 값을 복사해 고정하며 사용자 제공 설정 객체는 수정하지 않는다. 와이어 스키마, 요청/응답 본문 수집 규칙, 개인정보 정리, 큐/샘플링 한도는 바꾸지 않는다. `captureStack:false`에서 `beforeSend`가 추가한 스택도 최종 이벤트에서 제거한다.

기본 빌드 `npm run build:sdk`에서 SDK ESM gzip은 **8,935 bytes**(20,480 bytes 예산)였다. 새 모드는 하나의 동일한 패키지 안에서 런타임 계측 범위를 고른다. 번들 다운로드 크기를 모드별로 줄이는 기능이 아니므로, 완성 후 같은 빌드 명령으로 gzip 크기를 다시 측정한다. 실제 CPU·메모리 절감률은 측정하지 않은 채 숫자로 주장하지 않는다.

검증: minimal에서 fetch/XHR·console·History 래핑과 전역 오류 리스너가 설치되지 않아도 수동 캡처가 기존 전송으로 전달되는지 확인한다. 수동 이벤트의 메시지·이름은 유지하되 stack·componentStack·cause getter를 건드리지 않고, `beforeSend`로 스택을 주입해도 최종 전송에 포함하지 않는지 확인한다. 기본 standard, detailed, 명시 false/true 및 undefined 우선순위, 두 클라이언트 격리, `enabled:false`, 생성 뒤 원본 옵션 변경에도 초기값 유지, 빌드/패키지/브라우저 검사를 확인한다.

구현 후 확인: `npm run check`에서 타입 검사·단위 테스트 381건·빌드가 통과했다. `npm run check:package`의 오프라인 tarball 설치, ESM/CJS·선언·SSR 검사가 통과했고, `npm run check:browser`의 Chromium/WebKit 54건이 통과했다. 프리셋 전용 단위 검사는 자동 계측 설치 여부, 수동 전송, 기존 기본 동작, 상세 모드, 명시 boolean·`undefined` 우선순위, 잘못된 JavaScript 값의 기본값 유지, 클라이언트별 초기값 고정, `enabled:false`, 종료 후 재초기화, 스택·원인 getter 및 `beforeSend` 주입 차단을 확인했다. SDK ESM gzip은 같은 `npm run build:sdk` 조건에서 **9,080 bytes**로 기준 8,935 bytes보다 145 bytes 증가했으며 20,480 bytes 예산 안이다. 이 수치는 패키지 크기만 나타낸다. 실제 브라우저 CPU·메모리와 수집기 저장률은 측정하지 않았다.
