# @ihyeon/browser-error-log-protocol

[English](https://github.com/hyeonse-swing/browser-error-log/blob/main/packages/protocol/README.md) | 한국어

Browser Error Log SDK·수집기·뷰어를 위한 버전이 있는 TypeScript 계약입니다. SDK를 자체 백엔드에 연결하거나 뷰어 데이터 소스를 구현할 때 사용하세요.

직접 사용하는 경우 설치합니다. `@ihyeon/browser-error-log`도 의존성으로 포함합니다.

```sh
npm install @ihyeon/browser-error-log-protocol
```

게시 패키지 대신 로컬 소스 tarball을 사용하려면 Node.js 24에서 `npm ci`, `npm run check:package`를 실행하고 `output/packages/ihyeon-browser-error-log-protocol-0.1.15.tgz`를 절대 경로로 설치합니다. [SDK 가이드](https://github.com/hyeonse-swing/browser-error-log/blob/main/docs/ko/personal-sdk.md)를 참고하세요.

## 이벤트·조회 계약

```ts
import {
  SCHEMA_VERSION,
  EVENT_LABELS,
  type ErrorEventRecord,
  type EventBatch,
  type EventFilter,
  type EventPage,
  type EventDataSource,
} from '@ihyeon/browser-error-log-protocol';

function makeBatch(events: ErrorEventRecord[]): EventBatch {
  return { schemaVersion: SCHEMA_VERSION, events };
}
```

- `ErrorEventRecord`는 프로젝트·환경·릴리스·이벤트 ID·발생 시각·종류·메시지·페이지·런타임과 선택적인 스택·네트워크·context를 담는 v1 이벤트입니다.
- `EventBatch`는 `{ schemaVersion: 1, events: [...] }`로 이벤트를 묶어 전송합니다.
- `EventFilter`는 프로젝트·환경·종류·텍스트 검색·기간·커서·건수 제한을 지원합니다.
- `EventPage`는 `events`와 선택적인 `nextCursor`를 반환합니다.
- `EventDataSource`는 뷰어용 `listEvents(filter, signal?)`, `getEvent(project, eventId, signal?)`을 정의합니다.
- `EVENT_LABELS`는 영어 표시 이름을 제공합니다. 이벤트 종류 식별자는 바뀌지 않습니다.

`Breadcrumb`는 선택적인 `ErrorEventRecord.breadcrumbs` 타입입니다. `BREADCRUMB_LIMITS`와 `isBreadcrumbTrail(value)`는 최대 20개·UTF-8 JSON 12,000바이트, 표준 UTC `occurredAt`(`Date.toISOString()`), 비어 있지 않은 분류·메시지(40자·256자), 선택적인 단일 값 `data`(6개 키, 키 80자·문자열 값 200자)를 검증합니다. 알 수 없는 작업 필드, 중첩 데이터, 유한하지 않은 숫자는 거부하고 빈 배열은 허용합니다. 검증은 내용을 가리지 않으므로 SDK 필터나 앱의 서버 측 제거 정책을 함께 사용하세요.

이 패키지는 전체 이벤트를 검증하거나 DB·HTTP 서버를 제공하지 않습니다. 수집기의 입력을 검증하고 중복 제거·조회는 `(project, eventId)`로 범위를 정하세요. 클라이언트의 `occurredAt`과 서버의 `receivedAt`을 구분합니다.

[연동 계약](https://github.com/hyeonse-swing/browser-error-log/blob/main/docs/ko/integration.md)은 HTTP API를 설명합니다. `examples/micro-server`는 영속 SQLite 또는 로그 전용 JSONL 수집기를 구현합니다. 메모리 기반 개발 수집기는 데모입니다.

## 호스팅과 비용

인프라는 포함되지 않습니다. 호스팅, 서버, 데이터베이스, 스토리지, 대역폭, 도메인, 백업 및 제3자 서비스는 각 운영자가 선택하고 비용을 부담합니다. 요금은 해당 제공업체가 이 프로젝트 및 유지관리자와 독립적으로 청구합니다.
