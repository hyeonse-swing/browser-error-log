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
