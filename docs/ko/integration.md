# v1 연동 계약

[English](../integration.md) | 한국어

현재 브라우저 SDK와 뷰어의 계약입니다. 포함된 [마이크로 서버](micro-server.md)는 SQLite로 이 계약을 구현합니다. 운영자는 `packages/protocol`의 타입으로 자체 백엔드를 만들 수도 있습니다.

## 이벤트 수신

기본 SDK는 설정한 `endpoint`로 `credentials: 'omit'`을 사용해 `POST application/json`을 보냅니다. 본문은 `EventBatch`입니다.

```json
{
  "schemaVersion": 1,
  "events": [{
    "schemaVersion": 1,
    "eventId": "stable-generated-id",
    "project": "my-web",
    "environment": "staging",
    "release": "build-id",
    "sdkVersion": "<installed-sdk-version>",
    "occurredAt": "2026-10-02T07:00:00.000Z",
    "viewId": "document-instance-id",
    "sequence": 1,
    "elapsedMs": 1500,
    "type": "javascript",
    "message": "Example error",
    "page": "https://example.invalid/products",
    "runtime": "browser"
  }]
}
```

예시의 `sdkVersion`은 자리 표시자이며 SDK가 설치된 패키지 버전으로 설정합니다. 선택 필드는 `name`, `stack`, `componentStack`, `browser`, `context`, `network`입니다. `context` 값은 문자열, 유한한 숫자, boolean, null이며 `network`에는 `method`, `url`, `durationMs`, 선택적인 `status`가 있습니다. 발생 시각은 ISO UTC이고 서버는 `receivedAt`을 추가할 수 있습니다. 클라이언트가 제공하는 `project`와 `Origin`은 인증 정보가 아닙니다.

선택 필드 `breadcrumbs`는 최대 20개 작업(UTF-8 JSON 12,000바이트)을 기록 순서로 보존합니다. 각 항목은 표준 UTC `occurredAt`, `category`(40자), `message`(256자), 선택적인 단일 값 `data`(6개 키, 키 80자·문자열 값 200자)입니다. 프로토콜의 `isBreadcrumbTrail`로 검증하고 저장·JSON 내보내기에도 필드를 보존하세요. 스키마 v1의 선택 필드 추가이며 자체 호스팅 수집기·뷰어를 갱신해야 보존합니다. 이전 영속 수집기는 이 필드를 생략할 수 있습니다. 프로토콜 검증은 구조·크기를 확인하며 민감정보 제거는 SDK와 앱별 정책을 적용해야 합니다.

2xx 응답은 전체 배치의 수신 성공을 뜻하며 SDK는 본문을 사용하지 않습니다. 429, 5xx, 네트워크 실패는 첫 시도 후 같은 이벤트 ID로 최대 두 번 재시도합니다. 그 외 4xx는 영구 실패입니다. 시도별 기본 시간 제한은 5초입니다. SDK는 일부 수락을 해석할 수 없으므로 백엔드는 배치를 검증하고 원자적으로 영속 저장하거나 중복 확인을 마친 뒤 2xx를 반환하고 `(project, eventId)`로 중복을 제거해야 합니다.

마이크로 서버는 요청당 최대 64 KiB와 100건을 허용하고 각 이벤트를 검증합니다. 이는 예제 서버의 제한이며 모든 백엔드의 계약 상수는 아닙니다. 자체 배포에서는 별도 요청 제한, 스키마 검증, 조회 인증, 보관 정책, 앱별 데이터 제거를 적용하세요.

SDK의 선택 옵션 `maxEventsPerMinute`는 클라이언트별 직전 60초의 새 큐 진입 건수를 제한합니다. 유한한 값은 소수점을 내리고 1~1,000으로 조정하며, 생략하거나 유한하지 않으면 제한을 끕니다. 모든 오류 유형이 한도를 공유합니다. 초과 이벤트는 제외하고 기존 `dropped` 통계에 반영하며 집계·지연 이벤트를 별도로 보내지 않습니다. `beforeSend`가 제외한 이벤트와 객체 중복은 한도를 쓰지 않고, 한도가 가득 차면 초과 이벤트의 `beforeSend`를 생략합니다. flush·재시도·beacon 전송·작업 기록은 한도를 초기화하거나 추가로 쓰지 않습니다. 전송 필드가 바뀌지 않아 수집기 갱신이 필요하지 않습니다. 현재 문서의 클라이언트에만 적용하므로 서버 측 제한이나 HTTP 요청 수의 상한을 대신하지 않습니다.

`captureNavigation: true`를 선택하면 같은 창의 문서 내부 History 이동을 기존 작업 기록에 추가합니다. 분류는 `navigation`, 메시지는 `Navigation`, 단일 값 데이터는 `data.from`, `data.to`, `data.trigger`(`pushState`, `replaceState`, `popstate`, `hashchange`)입니다. URL 필터 적용 후 같은 URL이면 생략하며 서버·JSON 계약은 유지합니다. 앱별 동작에는 수동 작업 기록도 사용할 수 있습니다.

`captureNetworkBreadcrumbs: true`는 완료된 fetch·XHR 정보를 같은 작업 기록에 추가합니다. HTTP 응답은 분류 `http`, 메시지 `HTTP response`, 단일 값 데이터 `data.method`, `data.url`, `data.durationMs`, `data.status`를 사용합니다. 실제 전송 실패는 분류 `network`, 메시지 `Network failure`이며 상태를 생략합니다. opaque 응답의 브라우저 상태 `0`은 유지합니다. 의도적인 취소·수집기 요청과 본문·헤더·실패 메시지는 제외합니다. 완료 순서를 유지하고 독립 오류 선택은 기존 `captureNetwork`·`shouldCaptureHttp`가 제어합니다. 사용자 지정 transport에는 자동 네트워크 보고를 위한 `endpoint`가 필요합니다. 저장·JSON 형식은 유지합니다.

`getDiagnostics()`는 `EventBatch`나 `ErrorEventRecord`에 포함되지 않는 SDK 로컬 API입니다. 큐·전송·폐기 총합, 전송 중인 이벤트 수, 별도의 `beforeSend` 제외·동일 객체 중복 제외 횟수, 원인별 `droppedByReason`(`rateLimit`, `queueOverflow`, `payloadTooLarge`, `processingError`, `deliveryError`, `destroyed`)를 제공합니다. 원인별 합은 기존 `dropped` 총합과 같습니다. 통계를 읽을 때는 콜백 실행이나 요청 없이 독립 복사본을 반환합니다. 서버 갱신이나 진단 endpoint가 필요 없으며 `getStats()`도 유지합니다. SDK가 관측한 판단과 최선형 전송 통계이므로 수집기의 저장 완료를 뜻하지는 않습니다.

`captureErrorCause: true`는 오류 형태의 `cause` 객체를 최대 4단계 따라가 기존 `stack` 문자열에 `Caused by:` 구간으로 붙이는 선택 옵션입니다. 바깥 이름·메시지와 이벤트 수는 유지합니다. 문자열 이름·메시지·스택만 쓰며 임의의 원인 데이터나 AggregateError 배열은 직렬화하지 않습니다. 필터 적용 후 바깥 2,048자·각 원인 구간 480자로 전체 스택 4,096자 한도를 공유합니다. 예외 수집 경로와 기존 같은 창의 첫 console Error에 적용하고 자동 네트워크 이벤트는 기존 메타데이터 수집 방식을 유지합니다. `beforeSend`에서 stack을 삭제하거나 `undefined`로 지정하면 전체 스택을 제거합니다. 프로토콜 필드 추가나 수집기·뷰어 갱신은 필요 없습니다.

## 리소스 이벤트 호환성 (0.2.0)

`captureResourceErrors: true`는 관측 가능한 script·스타일시트 link·img 로딩 실패를 새 `resource` 유형으로 수집합니다. 스키마는 v1을 유지하고 기존 context의 단일 값 `resourceTag`(`script`, `link`, `img`)·`resourceUrl` 필드를 사용합니다. 요소 error 이벤트에서 알 수 없는 HTTP 상태·응답 데이터·시간·스택은 넣지 않습니다. 기존 context 한도와 SDK 필터를 적용합니다.

**리소스 수집을 켜기 전에 수집기·뷰어를 0.2.0 이상으로 배포하세요.** 자체 백엔드도 이벤트 허용 목록과 조회 유형에 `resource`를 추가해야 합니다. 이전 검증기는 리소스가 섞인 배치 전체를 거부할 수 있으며 옵션 기본값은 꺼짐입니다. 포함된 수집기·SQLite/JSONL 저장·유형 조회·뷰어 차트와 상세·이력 가져오기/내보내기는 0.2.0에서 이 유형을 지원하며 DB 마이그레이션은 필요 없습니다. fetch·XHR의 HTTP 오류·전송 실패와는 별도로 집계합니다.

## 이벤트 조회

뷰어의 기본 API 경로는 `/api`이며 목록과 상세 조회를 사용합니다.

```text
GET /api/events?project=...&environment=...&type=...&query=...&from=...&to=...&cursor=...&limit=30
-> { "events": [...], "nextCursor": "optional-opaque-cursor" }

GET /api/events/:eventId?project=my-web
-> ErrorEventRecord 또는 404
```

`from`/`to`는 ISO UTC 시각입니다. `(project, eventId)`를 식별자로 사용하고 안정적인 최신순 정렬과 커서 경계를 제공하세요. 호출자에게 허용된 프로젝트로 조회를 제한해야 하며 CORS만으로는 권한을 부여할 수 없습니다. 뷰어의 TypeScript `EventDataSource`는 `listEvents(filter, signal)`과 `getEvent(project, eventId, signal)`을 제공합니다. 같은 Origin의 다른 API 경로를 쓰려면 뷰어 진입 스크립트 전에 설정합니다.

```html
<script>
  window.__ERROR_LOG_VIEWER_CONFIG__ = {
    apiBase: '/monitoring', mode: 'live', title: 'Browser Error Log'
  };
</script>
```

뷰어는 선택한 기간에서 최대 커서 100페이지와 고유 이벤트 10,000건을 가져와 브라우저에서 차트를 계산합니다. 상한에 도달하면 부분 결과로 표시하며 전체 DB 집계가 아닙니다. JSON 입출력은 브라우저 로컬 작업이며 최대 10 MiB·10,000건을 받고 `partial` 값을 유지합니다. 가져오기는 서버 업로드나 DB 복원이 아닙니다. 차트는 수집된 이벤트 건수이며 사용자 수나 전체 요청 대비 오류율이 아닙니다.

## 수집 경계

초기화 이후부터 수집하므로 이전 이벤트는 복원할 수 없습니다. 취소한 요청은 제외합니다. 요청/응답 본문, 쿠키, 폼 값, 페이지 HTML, 요소 텍스트, 세션 리플레이는 기록하지 않습니다. URL·메시지 마스킹은 최선형이므로 앱별 검토가 필요합니다. `endpoint` 없는 사용자 지정 transport는 자기 요청의 재수집을 막기 위해 자동 fetch·XHR 수집을 끕니다. 리소스 수집은 독립적으로 현재 문서의 HTTP(S) 리소스 URL을 관측하며 지원하지 않는 요소·다른 문서·window에 전달되지 않는 이벤트는 범위 밖입니다. `beforeSend` 또는 `sanitizeUrl` 실패 시 해당 이벤트를 버립니다. 소스맵 복원, 네이티브 크래시, 알림, 서버 전체 집계는 구현되지 않았습니다. 자체 구현 경로는 [백엔드 계약](server-request.md)을 참고하세요.
