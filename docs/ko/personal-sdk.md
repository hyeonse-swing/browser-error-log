# 브라우저 SDK 설치·연결

[English](../personal-sdk.md) | 한국어

SDK는 `endpoint` 또는 사용자 지정 `transport`로 연결합니다. React는 선택 사항입니다. 영속 저장을 시작하려면 [자체 호스팅 가이드](micro-server.md)를 참고하세요.

검증된 MIT 라이선스 `0.1.0` SDK 패키지는 npm에서 설치할 수 있습니다. 다국어 지원 `0.1.1`은 로컬에서 준비 중이며 아직 게시되지 않았습니다. 대상 앱에서 브라우저 SDK를 설치합니다.

```sh
npm install browser-error-log
```

기존 React 18/19 앱에는 어댑터도 설치합니다.

```sh
npm install browser-error-log browser-error-log-react
```

`browser-error-log-protocol`은 공개 타입이나 상수를 앱에서 직접 import하지 않으면 의존성으로 설치됩니다.

## 선택 사항: 소스에서 로컬 tarball 만들기

Node.js 24와 npm으로 저장소 루트에서 실행합니다.

```sh
npm ci
npm run check:package
```

스크립트는 `output/packages/`에 `0.1.1` tarball 3개를 만들고 독립 consumer에 설치하여 React 없는 브라우저 설치, TypeScript 타입 선언, ESM/CJS export, SSR import를 확인합니다. 로컬 개발 경로이며 npm에 게시하지 않습니다.

대상 앱에서 `SDK_DIR`을 이 저장소의 절대 경로로 바꾸세요.

```sh
SDK_DIR="/absolute/path/to/browser-error-log"
npm install "$SDK_DIR/output/packages/browser-error-log-protocol-0.1.1.tgz" \
  "$SDK_DIR/output/packages/browser-error-log-0.1.1.tgz"
```

기존 React 18/19 앱에는 3개 tarball을 같은 명령으로 설치합니다.

```sh
SDK_DIR="/absolute/path/to/browser-error-log"
npm install "$SDK_DIR/output/packages/browser-error-log-protocol-0.1.1.tgz" \
  "$SDK_DIR/output/packages/browser-error-log-0.1.1.tgz" \
  "$SDK_DIR/output/packages/browser-error-log-react-0.1.1.tgz"
```

기본 브라우저 패키지에는 React가 필요하지 않습니다. 앱 번들러용 ESM, CommonJS, TypeScript 선언을 제공하지만 CDN 전역 스크립트는 제공하지 않습니다.

## 포함된 수집기에 연결하기

대상 앱이 `http://localhost:5173`에 있다면 이 저장소에서 SQLite 수집기를 실행합니다.

```sh
MICRO_PROJECTS=my-web MICRO_ALLOWED_ORIGINS=http://localhost:5173 npm run micro
```

Origin은 host·port까지 정확히 일치해야 하며 `localhost`와 `127.0.0.1`은 다릅니다. 앱의 브라우저 진입점에서 한 번 초기화합니다.

```ts
import { init } from 'browser-error-log';

export const errorLog = init({
  project: 'my-web',
  environment: 'development',
  release: 'local-example',
  endpoint: 'http://127.0.0.1:4319/api/events',
  captureConsole: false,
});

errorLog.captureException(new Error('SDK installation check'));
await errorLog.flush();
console.log(errorLog.getStats());
```

`http://127.0.0.1:4319/`를 새로고침하고 `my-web`을 선택하세요. `sent`가 늘었다는 것은 전송 성공 응답을 받았다는 뜻이며 백업이나 종단 간 전달 보장은 아닙니다. `init()`은 렌더링 함수 밖에 둡니다. 테스트·HMR 정리 시 필요하면 `await errorLog.flush()` 후 `errorLog.destroy()`로 계측과 타이머를 해제하세요.

## 설정 참조

| 옵션 | 기본값 | 역할 |
| --- | --- | --- |
| `project` | 필수 | 프로젝트별 기록 묶음, 수집기 허용 목록과 일치 |
| `endpoint` | 없음 | 수집 주소; `transport`가 없으면 필수 |
| `transport` | 내장 fetch 전송 | 중단 `signal`과 함께 `EventBatch` 전송, 실패 시 reject |
| `environment` / `release` | `development` / `unknown` | 배포 환경·빌드 표시 |
| `runtime` | `browser` | `browser`, `webview-ios`, `webview-android`, `unknown`; 네이티브 계측이 아닌 표시값 |
| `enabled` | `true` | `false`면 수집 중지 |
| `captureNetwork` | `true` | fetch/XHR 관찰; 사용자 지정 전송에는 `endpoint`도 필요 |
| `captureConsole` | `false` | `console.error` 수집 선택 |
| `shouldCaptureHttp` | 5xx 응답 | 수집할 HTTP 상태 선택 |
| `sanitizeUrl` | 내장 URL 정리 | 내장 정리 전에 앱별 경로 식별자 제거 |
| `beforeSend` | 사용자 지정 필터 없음 | 이벤트 수정 또는 `false`/`null`로 삭제 |
| `flushIntervalMs` | `10000` | ms 단위 flush 주기, 10–60,000으로 제한 |
| `maxQueueSize` | `50` | 버퍼 이벤트 수, 1–100으로 제한 |
| `transportTimeoutMs` | `5000` | 시도별 ms 제한, 250–60,000으로 제한 |

클라이언트는 `captureException(error, extra?)`, `flush()`, `getStats()`, `destroy()`를 제공합니다. `extra`에는 `context`, `componentStack`, 이벤트 `type`을 넣을 수 있습니다. `getStats()`는 `queued`, `sent`, `dropped`를 반환합니다. `flush()` 완료는 실패를 포함해 전송 시도가 끝났다는 뜻이며 성공 확인이 아닙니다. `destroy()`는 SDK 작업을 취소하고 대기 이벤트를 버리므로 초기화 직후 바로 호출하지 마세요.

## React와 SSR

같은 클라이언트를 React 어댑터에 전달합니다.

```tsx
import { ErrorBoundary } from 'browser-error-log-react';
import { errorLog } from './error-log';

<ErrorBoundary client={errorLog} fallback={(_error, reset) => (
  <section><p>This view could not load.</p><button onClick={reset}>Try again</button></section>
)}>
  <App />
</ErrorBoundary>
```

SSR에서 SDK import는 가능하지만 서버의 `init()`은 오류를 수집하지 않습니다. Next.js 같은 프레임워크에서는 브라우저 진입점에서 활성 클라이언트를 만드세요. 앱의 `catch`에서 처리한 오류는 `captureException`을 직접 호출합니다. 이 브라우저 SDK는 네이티브 모바일 크래시나 종료된 WebView 프로세스를 보고할 수 없습니다.

## 자체 백엔드와 데이터 제어

`endpoint`를 v1 수집기로 지정하거나 사용자 지정 전송을 제공합니다.

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/monitoring/events',
  transport: async (batch, { signal }) => {
    const response = await fetch('/monitoring/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch), signal, credentials: 'omit',
    });
    if (!response.ok) throw new Error(`Collector responded ${response.status}`);
  },
});
```

기본 전송은 `POST application/json`, `credentials: 'omit'`을 사용합니다. 사용자 지정 전송에서 자동 네트워크 수집을 원하면 자기 요청을 제외할 수 있도록 `endpoint`도 넣으세요. 없으면 자동 네트워크 수집은 꺼집니다. 시간 초과·정리 시 요청을 중단하도록 `signal`을 전달하세요. 사용자 지정 transport가 던진 오류는 재시도 대상이므로 백엔드에서 고려해야 합니다. 서버 비밀을 브라우저 설정에 넣지 마세요. [v1 계약](integration.md)과 [백엔드 가이드](server-request.md)를 참고하세요.

SDK는 전역 JavaScript 예외, 미처리 Promise, fetch/XHR 실패, HTTP 5xx를 기본 수집합니다. `shouldCaptureHttp`로 응답 상태를 바꿀 수 있고 `console.error`는 선택 사항입니다. URL 쿼리·해시·사용자 정보를 제거하고 흔한 민감정보 패턴을 가립니다. 요청/응답 본문, 쿠키, 입력값, DOM 스냅샷은 수집하지 않습니다. 모든 민감정보를 식별하지는 못하므로 `sanitizeUrl(url)`로 경로를 정리하고 `beforeSend(event)`로 이벤트를 수정·삭제하세요. 훅이 예외를 던지면 이벤트를 버립니다.

전달은 최선형입니다. 기본 큐는 최대 50건이고 배치 크기 제한, 시도별 기본 5초 제한, 재시도 가능한 실패에 최대 두 번의 재시도가 있습니다. `transportTimeoutMs`는 250~60,000ms로 설정합니다. 중단 신호를 무시하는 사용자 지정 전송은 SDK 시간 초과 후에도 외부에서 계속될 수 있습니다. 오프라인, 탭 종료, 큐 초과로 유실될 수 있습니다. 재시도는 같은 이벤트 ID를 사용하므로 서버에서 중복을 제거해야 합니다. `viewId`는 SDK 인스턴스 식별자이며 사용자 세션 추적 기능이 아닙니다.
