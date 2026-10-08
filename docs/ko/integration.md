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
    "sdkVersion": "0.1.1",
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

선택 필드는 `name`, `stack`, `componentStack`, `browser`, `context`, `network`입니다. `context` 값은 문자열, 유한한 숫자, boolean, null이며 `network`에는 `method`, `url`, `durationMs`, 선택적인 `status`가 있습니다. 발생 시각은 ISO UTC이고 서버는 `receivedAt`을 추가할 수 있습니다. 클라이언트가 제공하는 `project`와 `Origin`은 인증 정보가 아닙니다.

2xx 응답은 전체 배치의 수신 성공을 뜻하며 SDK는 본문을 사용하지 않습니다. 429, 5xx, 네트워크 실패는 첫 시도 후 같은 이벤트 ID로 최대 두 번 재시도합니다. 그 외 4xx는 영구 실패입니다. 시도별 기본 시간 제한은 5초입니다. SDK는 일부 수락을 해석할 수 없으므로 백엔드는 배치를 검증하고 원자적으로 영속 저장하거나 중복 확인을 마친 뒤 2xx를 반환하고 `(project, eventId)`로 중복을 제거해야 합니다.

마이크로 서버는 요청당 최대 64 KiB와 100건을 허용하고 각 이벤트를 검증합니다. 이는 예제 서버의 제한이며 모든 백엔드의 계약 상수는 아닙니다. 자체 배포에서는 별도 요청 제한, 스키마 검증, 조회 인증, 보관 정책, 앱별 데이터 제거를 적용하세요.

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

초기화 이후부터 수집하므로 이전 이벤트는 복원할 수 없습니다. 취소한 요청은 제외합니다. 요청/응답 본문, 쿠키, 폼 값, DOM, 세션 리플레이는 기록하지 않습니다. URL·메시지 마스킹은 최선형이므로 앱별 검토가 필요합니다. `endpoint` 없는 사용자 지정 transport는 자기 요청의 재수집을 막기 위해 자동 네트워크 수집을 끕니다. `beforeSend` 또는 `sanitizeUrl` 실패 시 해당 이벤트를 버립니다. 소스맵 복원, 네이티브 크래시, 알림, 서버 전체 집계는 구현되지 않았습니다. 자체 구현 경로는 [백엔드 계약](server-request.md)을 참고하세요.
