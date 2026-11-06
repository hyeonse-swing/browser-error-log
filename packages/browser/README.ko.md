# @ihyeon/browser-error-log

[English](https://github.com/hyeonse-swing/browser-error-log/blob/main/packages/browser/README.md) | 한국어

직접 관리하는 수집기에 연결하는 작은 브라우저 오류 SDK입니다. 자체 백엔드 또는 저장소에 포함된 SQLite·회전 JSONL 파일 기반 Node.js 수집기를 사용할 수 있습니다.

## 사용 이유

- **이벤트 목적지를 직접 선택:** 내장 호스팅 endpoint나 별도 분석 목적지는 없습니다. `endpoint` 또는 사용자 지정 `transport`를 지정합니다.
- **작은 브라우저 의존성:** 런타임 프레임워크 의존성이 없고 ESM, CommonJS, TypeScript 선언을 제공합니다. 저장소는 뷰어·선택적 React 어댑터를 제외한 기본 SDK에 gzip 20 KiB 예산을 적용합니다.
- **전송 전 제어:** `beforeSend`로 이벤트를 수정·제외하고 `sanitizeUrl`로 경로 식별자를 제거하며 `shouldCaptureHttp`로 필요한 HTTP 응답을 선택합니다.
- **오류 맥락:** JavaScript 예외, 미처리 Promise, fetch/XHR 실패, 수동 오류에 프로젝트·릴리스·페이지·발생 시각을 기록합니다. Console 수집은 선택 사항입니다.
- **옮길 수 있는 저장 방식:** SQLite 수집기와 실시간 뷰어, JSONL 로그와 로컬 내보내기, 또는 같은 버전 계약을 따르는 자체 백엔드를 선택합니다.

## 설치

```sh
npm install @ihyeon/browser-error-log
```

`@ihyeon/browser-error-log-protocol`은 npm 의존성으로 설치됩니다. 게시 패키지 대신 로컬 소스를 시험하려면 Node.js 24에서 `npm ci`와 `npm run check:package`를 실행하고 [SDK 가이드](https://github.com/hyeonse-swing/browser-error-log/blob/main/docs/ko/personal-sdk.md)에 따라 프로토콜·브라우저 tarball을 함께 설치하세요.

## 세 단계로 연결

1. 소스 체크아웃에서 앱의 정확한 Origin을 허용해 수집기를 시작합니다.

   ```sh
   MICRO_PROJECTS=my-web MICRO_ALLOWED_ORIGINS=http://localhost:5173 npm run micro
   ```

2. 앱의 브라우저 진입점에서 한 번 초기화합니다.

   ```ts
   import { init } from '@ihyeon/browser-error-log';

   export const errorLog = init({
     project: 'my-web',
     endpoint: 'http://127.0.0.1:4319/api/events',
     environment: 'development',
     release: 'my-release',
   });
   ```

3. 진단 오류를 보내고 `http://127.0.0.1:4319/`에서 확인합니다.

   ```ts
   errorLog.captureException(new Error('Connection check'));
   await errorLog.flush();
   console.log(errorLog.getStats()); // 전달 성공 시 sent: 1
   ```

앱 수명 동안 클라이언트를 유지하세요. 테스트 종료나 앱 해제 때 `destroy()`는 계측을 제거하고 대기 이벤트를 버립니다. `flush()`는 SDK 전송 시도가 끝났다는 뜻이지 저장 보장이 아닙니다. `getStats()`와 수집기에서 확인하세요. 탭이 숨겨질 때 브라우저의 `sendBeacon` 큐가 수락한 이벤트도 `sent`에 포함하며, 수집기 저장을 확인한 것은 아닙니다. 초기화 이전 오류는 수집하지 못합니다.

외부 호스팅은 [자체 호스팅 가이드](https://github.com/hyeonse-swing/browser-error-log/blob/main/docs/ko/micro-server.md)를 참고하세요. 운영 앱에는 HTTPS 수집기, 정확한 허용 Origin, 영속 저장, 뷰어 인증이 필요합니다. `localhost`와 `127.0.0.1`은 서로 다른 Origin입니다. 뷰어 암호는 서버에만 두고 SDK 설정에 넣지 마세요.

## 처리한 오류 기록

```ts
try {
  await loadDashboard();
} catch (error) {
  errorLog.captureException(error, { context: { action: 'load-dashboard' } });
}
```

선택적인 `@ihyeon/browser-error-log-react` 패키지는 Error Boundary를 제공합니다. 기본 SDK에는 React가 필요하지 않습니다. SSR에서 import·초기화할 수 있지만 서버 오류는 수집하지 않으므로 프레임워크의 브라우저/클라이언트 진입점에서 초기화하세요.

## 연결된 원인 오류 수집

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events',
  captureErrorCause: true,
});

const cause = new TypeError('Invalid response');
errorLog.captureException(new Error('Dashboard could not load', { cause }));
```

선택 옵션으로 최대 4단계의 `cause` 객체를 따라가 이름·메시지·스택을 기존 `stack` 필드의 `Caused by:` 구간에 붙입니다. 바깥 오류의 이름과 메시지는 유지하며 원인별로 이벤트를 추가하거나 수집 한도를 더 쓰지 않습니다. 수동·전역·Promise·React 수집에 적용하고, console 수집이 켜져 있으면 기존처럼 같은 창의 첫 Error 인자에도 적용합니다. 자동 네트워크 오류 이벤트는 기존 메타데이터 수집 방식을 유지합니다.

문자열 `message` 또는 `stack`이 있는 객체만 따라가며 다른 창에서 생성한 Error도 포함합니다. 원시 값 원인, 그 밖의 객체 데이터, `AggregateError.errors`는 펼치지 않습니다. 순환 참조나 읽을 수 없는 속성은 앱에 영향을 주지 않고 원인 정보 추적을 중단하거나 생략합니다. 기본값은 꺼짐이고 초기화 시 고정하며, 수집이 꺼져 있으면 `cause`를 읽지 않습니다.

유효한 원인이 있으면 바깥 스택은 최대 2,048자, 각 원인 구간은 최대 480자를 사용하며 전체 스택은 기존 4,096자 안으로 제한합니다. 구간을 자르기 전에 기존 텍스트·URL 필터를 적용합니다. 프로토콜 필드나 수집기 갱신 없이 기존 뷰어의 스택 상세에서 볼 수 있습니다. 원인 메시지와 경로에도 민감정보가 있을 수 있으므로 앱별 필터를 검토한 뒤 켜세요. `beforeSend`에서 합쳐진 스택을 수정하거나 `delete event.stack`·`event.stack = undefined`로 제거하고 이벤트 전체를 제외할 수도 있습니다. URL 필터가 실패하면 필터링하지 않은 원인 정보를 보내지 않고 이벤트를 버립니다.

## 리소스 로딩 실패 수집

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events',
  captureResourceErrors: true,
});
```

**이 옵션을 켜기 전에 수집기와 뷰어를 0.2.0 이상으로 갱신하세요.** 자체 백엔드도 스키마와 유형 필터에서 `type: 'resource'`를 허용해야 합니다. 이전 수집기는 새 유형이 섞인 배치 전체를 거부할 수 있습니다. 기본값은 꺼짐이므로 기존 일반 이벤트 유형은 이전 수집기와 계속 사용할 수 있습니다.

초기화 이후 현재 문서에서 발생하는 script·스타일시트 link·img의 로딩 오류를 관찰합니다. 이벤트 유형은 `resource`, 이름은 `ResourceLoadError`이며 `Failed to load script resource` 같은 고정 메시지와 단일 값 `context.resourceTag`(`script`, `link`, `img`)·`context.resourceUrl`을 기록합니다. 이미지의 선택된 `currentSrc`가 있으면 이를 사용합니다. HTTP(S) URL만 기존 URL·텍스트 필터와 context 한도로 기록하며 HTML·요소 텍스트·ID·class·alt·폼 값·srcset 목록은 복사하지 않습니다. 수집기 URL과 지원하지 않는 리소스 종류·스킴은 제외합니다.

요소의 error 이벤트에는 HTTP 상태나 응답 본문이 없으므로 상태·네트워크 소요 시간·스택을 만들어 넣지 않습니다. 파일 누락, 브라우저 정책, 이미지 디코딩 등 여러 이유로 발생할 수 있으며 SDK가 요청을 반복하거나 확인용 요청을 보내지는 않습니다. fetch·XHR 수집과 독립적으로 동작하고 요소의 기존 핸들러와 기본 동작을 유지합니다. 초기화 전 오류나 다른 문서, window까지 전달되지 않는 이벤트 경계 안의 오류는 복원하지 못합니다.

공통 context, 작업 기록, `beforeSend`, 수집 한도, 큐 한도, 진단 통계를 공유합니다. 기존 최대 12개 context 항목 안에서 두 리소스 항목을 공통 context보다 우선합니다. URL·context 콜백 실패 시 이벤트를 버리고 `beforeSend`가 제외하면 필터링으로 집계합니다. `destroy()`는 리스너를 해제합니다. 0.2.0 뷰어의 유형 필터·차트·상세·이력 JSON도 새 유형을 지원합니다.

## 오류 전 작업 기록

```ts
errorLog.addBreadcrumb({ category: 'navigation', message: '결제 화면 진입' });
errorLog.addBreadcrumb({ category: 'action', message: '주문 제출', data: { paymentMethod: 'card', attempt: 1 } });
errorLog.captureException(new Error('주문을 완료하지 못했습니다'));
errorLog.clearBreadcrumbs(); // 새 흐름 시작; 이미 수집한 오류는 당시 기록을 유지
```

클라이언트마다 최근 20개 작업을 UTF-8 JSON 기준 12,000바이트 안에서 유지합니다. 작업 추가만으로 별도 이벤트를 보내지 않으며 이후 오류에 오래된 순서의 복사본을 붙입니다. 각 작업에는 SDK가 만든 UTC 시각, 분류(기본 `manual`, 최대 40자), 메시지(최대 256자), 선택적인 단일 값 데이터(6개 키, 키 80자·문자열 값 200자)가 있습니다. 기존 민감 키·URL·텍스트 필터와 `beforeSend`가 적용되며 `event.breadcrumbs`를 수정하거나 제거할 수 있습니다. `clearBreadcrumbs()`는 이후 수집에 적용되고 `destroy()`도 로컬 작업 기록을 비웁니다.

`init()`은 `BrowserErrorLogBreadcrumbClient`와 원래 `BrowserErrorLogClient`를 확장한 `BrowserErrorLogDiagnosticsClient`를 반환합니다. 기존 클라이언트와 React Error Boundary 모형은 원래 인터페이스를 유지할 수 있습니다. 작업 기록이나 진단 메서드를 쓰는 클라이언트의 타입을 직접 선언할 때는 해당 확장 타입을 사용하세요.

뷰어는 두 오류 상세 화면에 이 기록을 표시하고 히스토리 JSON에도 보존합니다. 자체 호스팅 수집기·뷰어는 작업 기록 지원 버전(0.1.16부터)에서 이 선택 필드를 저장·표시합니다. 이전 수집기는 이벤트를 받아도 작업 기록을 생략할 수 있습니다. 자체 백엔드는 `@ihyeon/browser-error-log-protocol`의 `isBreadcrumbTrail`로 작업 기록을 검증할 수 있습니다.

## 저장 전 작업 기록 필터

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events',
  captureNetworkBreadcrumbs: true,
  beforeBreadcrumb(breadcrumb) {
    const url = breadcrumb.data?.url;
    if (breadcrumb.category === 'http' && typeof url === 'string' && url.endsWith('/api/health')) return null;
    if (breadcrumb.category === 'manual') breadcrumb.category = 'action';
    return breadcrumb;
  },
});
```

동기 콜백 `beforeBreadcrumb`는 유효한 수동·화면 이동·네트워크 작업을 생성할 때 초기 SDK 정제 후 로컬 버퍼에 저장하기 전에 한 번 실행합니다. `false`·`null`을 반환하면 항목을 제외하고, `BreadcrumbInput`을 반환하면 교체하며, 반환하지 않으면 전달한 복사본의 수정 내용을 사용합니다. 반환값에도 기존 필터와 크기 제한을 다시 적용하고 발생 시각은 SDK의 원래 값을 유지하며 추가 필드는 무시합니다.

콜백은 독립된 복사본을 받으므로 나중에 값을 바꿔도 현재 버퍼나 이미 큐에 담긴 오류의 기록을 수정하지 않습니다. 콜백 예외·잘못된 반환값·반환값 정제 실패는 해당 작업만 제외하며 오류 통계를 바꾸지 않습니다. 네트워크 작업을 제외해도 독립 HTTP·네트워크 오류 이벤트는 기존 수집 정책을 따릅니다. 오류 선택에는 `captureNetwork`·`shouldCaptureHttp`·`beforeSend`를 사용하세요. 콜백 실행 중 다시 추가하려는 작업은 무시하며, 콜백에서 클라이언트를 종료하면 이후 그 작업을 저장하지 않습니다.

오류가 작업 기록을 복사할 때, `beforeSend` 반환값 정제, 통계 조회, 전송·재시도에서는 이 콜백을 다시 실행하지 않습니다. 최종 이벤트 필터는 기존 `beforeSend`입니다. 이 옵션으로 추가 이벤트·요청·프로토콜 필드를 만들지 않으며 수집기 갱신도 필요하지 않습니다.

## SPA 화면 이동 자동 기록

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events',
  captureNavigation: true,
});
```

선택 옵션으로 같은 창의 `history.pushState`, `history.replaceState`, 뒤로/앞으로 가기를 통한 문서 내부 이동을 기록합니다. 각 `navigation` 작업에는 필터를 적용한 `from`·`to` URL과 `trigger`가 있습니다. 기본 URL 정책은 자격 정보·쿼리·해시를 제거하며, 필터 후 URL이 같으면 작업을 추가하지 않습니다. 해시만 사용하는 라우터에는 수동 작업 기록이나 앱별 context를 사용하세요.

초기화 이후부터 수동 기록과 같은 최대 20개·12,000바이트 버퍼를 공유합니다. `clearBreadcrumbs()`로 이후 오류의 기록을 비우면 다음 이동부터 다시 기록합니다. 버퍼는 현재 문서의 메모리에 있으며 전체 페이지 로드 간에는 이어지지 않습니다. History의 state와 title 인자는 작업 기록에 복사하지 않습니다. `sanitizeUrl`·`beforeSend` 제어를 유지하며 `destroy()`는 해당 클라이언트의 계측을 해제합니다. 호스트가 History 메서드를 잠그거나 교체하면 이동을 기록하지 못할 수 있습니다.

## 네트워크 요청 자동 기록

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events',
  captureNetworkBreadcrumbs: true,
});
```

선택 옵션으로 완료된 fetch·XHR 응답(2xx·4xx·5xx 포함)과 실제 전송 실패를 기존 제한된 작업 기록에 붙입니다. 응답은 분류 `http`, 메시지 `HTTP response`, 단일 값 데이터 `data.method`, `data.url`, `data.durationMs`, `data.status`로 기록합니다. 전송 실패는 분류 `network`, 메시지 `Network failure`이며 상태 코드를 생략합니다. 브라우저가 opaque 응답에 상태 `0`을 반환하면 뷰어는 상태를 확인할 수 없다고 표시합니다. URL에는 기존 필터를 적용하고 최대 200자로 제한합니다. 본문·헤더·실패 메시지는 기록에 복사하지 않으며, 의도적인 취소와 수집기 요청도 제외합니다.

요청은 완료 순서로 기록하고 진행 중인 요청은 아직 오류의 복사본에 포함하지 않습니다. 요청 기록만으로 별도 이벤트를 보내거나 오류 통계를 늘리지 않습니다. 독립적인 오류 이벤트는 기존 `captureNetwork`와 `shouldCaptureHttp`가 제어합니다. 요청 기록만 원하면 `captureNetwork: false`를 함께 지정하세요. 상태 선택 콜백이 false를 반환해도 요청 기록은 남으므로 기록 필터링에는 `beforeSend`를 사용합니다. 오류 수집이 켜진 상태에서 선택 콜백이 예외를 던지면 해당 요청의 보고를 제외합니다. `clearBreadcrumbs()`는 이후 수집에 사용할 공통 버퍼(최대 20개·12,000바이트)를 비웁니다.

사용자 지정 transport에는 제외할 수집기의 `endpoint`를 제공해야 합니다. 없으면 두 자동 네트워크 경로를 모두 끕니다. 기존 breadcrumb 계약을 사용하므로 작업 기록을 지원하는 0.1.16 이상의 수집기·뷰어와 함께 사용할 수 있습니다.

## 수집 제어

```ts
let currentAppSection = 'checkout';

const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events', // 자체 수집기 또는 같은 Origin의 프록시
  context: { buildChannel: 'stable' },
  getContext: () => ({ appSection: currentAppSection }),
  captureConsole: false,
  beforeSend(event) {
    if (event.message.includes('Expected diagnostic')) return null;
    return event;
  },
  sanitizeUrl(url) {
    return url.replace(/\/users\/[^/?#]+/g, '/users/:id');
  },
  shouldCaptureHttp(status) {
    return status >= 500;
  },
});

currentAppSection = 'account'; // 이후 이벤트에는 현재 값을 사용
```

초기화 시 `context`를 지정하면 자동 수집을 포함한 모든 이벤트에 공통 진단 정보를 붙입니다. 동기 콜백 `getContext`는 이벤트 수집 시 한 번 호출해 현재 앱 상태를 읽으며, `undefined`를 반환하면 동적 항목을 추가하지 않습니다. 최대 12개의 단일 값 항목 안에서 `captureException(error, { context })`의 개별 값, `getContext`, 초기화 `context` 순서로 우선합니다. 동일한 민감 키·URL·텍스트 필터가 적용되고, `beforeSend`에서 합쳐진 context를 수정하거나 제거할 수 있습니다. 이미 큐에 담긴 이벤트는 수집 당시 값을 유지합니다. `getContext`가 예외를 던지면 앱에 영향을 주지 않고 해당 이벤트를 버립니다.

`captureConsole: true`로 `console.error` 호출을 수집할 수 있습니다. 인자를 합친 메시지는 유지하며, 같은 창에서 생성된 첫 번째 `Error` 인자의 이름과 스택도 기록합니다. 동일한 민감정보 필터와 `beforeSend` 제어가 적용됩니다.

기본 HTTP 수집은 5xx와 네트워크 실패를 포함하고 의도적인 취소와 수집기 endpoint를 제외합니다. SDK는 URL 쿼리·해시·자격 정보와 흔한 이메일/토큰 패턴을 제거합니다. 요청/응답 본문, 쿠키, 페이지 HTML, 요소 텍스트, 폼 입력, 세션 녹화는 수집하지 않습니다. 오류 메시지, URL 경로, 스택, 사용자 지정 context에는 민감정보가 남을 수 있으므로 앱별 필터를 설정하세요. `beforeSend`나 `sanitizeUrl`이 실패하면 이벤트를 버립니다.

사용자 지정 `transport(batch, { signal })`에서는 요청에 `signal`을 전달하고 전송 실패 시 reject하세요. 자동 네트워크 오류 수집이나 요청 기록을 원하면 자기 전송을 제외할 `endpoint`를 지정해야 합니다. 없으면 사용자 지정 transport에서 두 경로를 모두 끕니다. 기본 전송은 credentials를 보내지 않습니다.

## 오류 폭주 제한

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events',
  maxEventsPerMinute: 60,
});
```

`maxEventsPerMinute`는 클라이언트별로 직전 60초 동안 큐에 새로 담는 이벤트 수를 제한하는 선택 옵션입니다. 기본값은 제한 없음입니다. 유한한 값은 소수점을 내리고 1~1,000 범위로 조정하며, 생략하거나 유한하지 않은 값을 지정하면 제한을 끕니다. 수동·React 수집, 전역 오류, Promise, console, 선택한 HTTP·네트워크 실패가 같은 한도를 공유합니다. 초과 이벤트는 나중에 보내도록 보관하지 않고 즉시 제외하며 `getStats().dropped`에 반영합니다. 각 이벤트를 큐에 담은 지 60초가 지나면 그만큼 다시 수집할 수 있습니다.

큐를 비우는 flush로 한도가 초기화되지 않습니다. 재시도와 beacon 전송은 이미 담긴 이벤트를 사용하므로 추가 한도를 쓰지 않고, 작업 기록도 한도를 쓰지 않습니다. 같은 Error 객체의 중복 수집과 `beforeSend`가 제외한 이벤트는 한도를 쓰지 않습니다. 한도가 가득 차면 초과 이벤트의 `beforeSend` 호출을 생략합니다. 큐에 담긴 이벤트가 나중에 큐에서 밀려나거나 전송에 실패해도 사용한 한도는 유지합니다.

한도는 현재 문서의 해당 클라이언트에 속하며 새 클라이언트나 전체 페이지 로드에서는 새로 시작합니다. 큐 진입 건수를 제한하므로 HTTP 요청 수·바이트·서버 전체 트래픽이나 이벤트 생성 작업량의 상한을 뜻하지는 않습니다. 수집기에는 별도의 서버 측 제한을 적용하세요.

## SDK 수집·전송 진단

```ts
await errorLog.flush();
const diagnostics = errorLog.getDiagnostics();
console.log(diagnostics.inFlight, diagnostics.filtered, diagnostics.deduplicated);
console.table(diagnostics.droppedByReason);
```

`getDiagnostics()`는 기존 `queued`·`sent`·`dropped`에 `inFlight`(재시도 대기를 포함한 전송 배치 내 이벤트 수), `filtered`(`beforeSend`가 `false` 또는 `null`을 반환한 횟수), `deduplicated`(`captureException`의 기존 동일 객체 중복 제외 횟수)와 다음 원인별 건수를 더해 반환합니다.

| `droppedByReason` 키 | 집계하는 이벤트 |
| --- | --- |
| `rateLimit` | `maxEventsPerMinute` 초과로 제외 |
| `queueOverflow` | 큐가 가득 차서 밀려남 |
| `payloadTooLarge` | 이벤트 또는 배치 바이트 한도 초과 |
| `processingError` | 관측한 전처리·민감정보 필터·콜백 실패로 제외 |
| `deliveryError` | 영구 전송 실패 또는 재시도 소진 |
| `destroyed` | `destroy()`로 큐나 진행 중인 전송에서 폐기 |

원인별 건수의 합은 `dropped`입니다. `filtered`와 `deduplicated`는 별도 항목으로 기존 `getStats()` 동작을 유지합니다. 재시도 횟수는 최종 전송 실패 전에는 버린 이벤트로 세지 않으며, beacon 시도가 실패하면 큐를 유지합니다. `sent`도 기존처럼 브라우저 beacon 큐의 수락을 포함하므로 수집기의 저장 완료를 보장하지 않습니다.

호출마다 로컬 숫자 통계만 담은 독립 복사본을 반환합니다. 추가 이벤트를 전송하거나 수집 콜백을 실행하지 않고 URL·오류 원문·본문을 포함하지 않습니다. 통계는 클라이언트 수명 동안 누적되며 `destroy()` 후에도 읽을 수 있고 이때 `inFlight`는 0입니다. flush나 작업 기록 정리로 초기화하지 않으며 비활성·SSR 클라이언트는 0으로 시작합니다. 제외한 수집기 요청·의도적인 취소·선택하지 않은 HTTP 상태·무시한 작업 기록 입력은 통계를 늘리지 않습니다. SDK가 관측한 판단의 통계이므로 초기화 전 오류나 서버 전체 수신 여부를 보여주지는 않습니다. 수집기 갱신은 필요 없으며 기존 `getStats()`는 세 필드를 그대로 반환합니다.

## 전달 제한

기본 큐는 50건, flush 주기는 10초입니다. 배치는 최대 20건 또는 48,000바이트입니다. 각 시도는 5초 제한이고 재시도 가능한 실패는 최대 두 번 재시도합니다. `maxQueueSize`, `flushIntervalMs`, `transportTimeoutMs`는 정해진 범위 안에서 조정할 수 있습니다. 오프라인, 탭 종료, 버퍼 초과, 재시도 소진으로 이벤트가 유실될 수 있습니다. 영속 오프라인 큐나 정확히 한 번의 전달 보장은 없습니다.

## 호스팅과 비용

이 프로젝트는 관리형 모니터링 서비스가 아닌 소프트웨어를 제공합니다. 인프라는 포함되지 않습니다. 호스팅, 서버, 데이터베이스, 스토리지, 대역폭, 도메인, 백업 및 제3자 서비스는 각 운영자가 선택하고 비용을 부담합니다. 요금은 해당 제공업체가 이 프로젝트 및 유지관리자와 독립적으로 청구합니다. 자체 호스팅이 무료 인프라를 뜻하지는 않습니다.
