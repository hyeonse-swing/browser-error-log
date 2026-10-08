# browser-error-log

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
npm install browser-error-log
```

`browser-error-log-protocol`은 npm 의존성으로 설치됩니다. 게시 패키지 대신 로컬 소스를 시험하려면 Node.js 24에서 `npm ci`와 `npm run check:package`를 실행하고 [SDK 가이드](https://github.com/hyeonse-swing/browser-error-log/blob/main/docs/ko/personal-sdk.md)에 따라 프로토콜·브라우저 tarball을 함께 설치하세요.

## 세 단계로 연결

1. 소스 체크아웃에서 앱의 정확한 Origin을 허용해 수집기를 시작합니다.

   ```sh
   MICRO_PROJECTS=my-web MICRO_ALLOWED_ORIGINS=http://localhost:5173 npm run micro
   ```

2. 앱의 브라우저 진입점에서 한 번 초기화합니다.

   ```ts
   import { init } from 'browser-error-log';

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

앱 수명 동안 클라이언트를 유지하세요. 테스트 종료나 앱 해제 때 `destroy()`는 계측을 제거하고 대기 이벤트를 버립니다. `flush()`는 SDK 전송 시도가 끝났다는 뜻이지 저장 보장이 아닙니다. `getStats()`와 수집기에서 확인하세요. 초기화 이전 오류는 수집하지 못합니다.

외부 호스팅은 [자체 호스팅 가이드](https://github.com/hyeonse-swing/browser-error-log/blob/main/docs/ko/micro-server.md)를 참고하세요. 운영 앱에는 HTTPS 수집기, 정확한 허용 Origin, 영속 저장, 뷰어 인증이 필요합니다. `localhost`와 `127.0.0.1`은 서로 다른 Origin입니다. 뷰어 암호는 서버에만 두고 SDK 설정에 넣지 마세요.

## 처리한 오류 기록

```ts
try {
  await loadDashboard();
} catch (error) {
  errorLog.captureException(error, { context: { action: 'load-dashboard' } });
}
```

선택적인 `browser-error-log-react` 패키지는 Error Boundary를 제공합니다. 기본 SDK에는 React가 필요하지 않습니다. SSR에서 import·초기화할 수 있지만 서버 오류는 수집하지 않으므로 프레임워크의 브라우저/클라이언트 진입점에서 초기화하세요.

## 수집 제어

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events', // 자체 수집기 또는 같은 Origin의 프록시
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
```

기본 HTTP 수집은 5xx와 네트워크 실패를 포함하고 의도적인 취소와 수집기 endpoint를 제외합니다. SDK는 URL 쿼리·해시·자격 정보와 흔한 이메일/토큰 패턴을 제거합니다. 요청/응답 본문, 쿠키, DOM, 폼 입력, 세션 녹화는 수집하지 않습니다. 오류 메시지, URL 경로, 스택, 사용자 지정 context에는 민감정보가 남을 수 있으므로 앱별 필터를 설정하세요. `beforeSend`나 `sanitizeUrl`이 실패하면 이벤트를 버립니다.

사용자 지정 `transport(batch, { signal })`에서는 요청에 `signal`을 전달하고 전송 실패 시 reject하세요. 자동 네트워크 수집을 원하면 자기 전송을 제외할 `endpoint`를 지정해야 합니다. 없으면 사용자 지정 transport에서 네트워크 수집을 끕니다. 기본 전송은 credentials를 보내지 않습니다.

## 전달 제한

기본 큐는 50건, flush 주기는 10초입니다. 배치는 최대 20건 또는 48,000바이트입니다. 각 시도는 5초 제한이고 재시도 가능한 실패는 최대 두 번 재시도합니다. `maxQueueSize`, `flushIntervalMs`, `transportTimeoutMs`는 정해진 범위 안에서 조정할 수 있습니다. 오프라인, 탭 종료, 버퍼 초과, 재시도 소진으로 이벤트가 유실될 수 있습니다. 영속 오프라인 큐나 정확히 한 번의 전달 보장은 없습니다.

## 호스팅과 비용

이 프로젝트는 관리형 모니터링 서비스가 아닌 소프트웨어를 제공합니다. 인프라는 포함되지 않습니다. 호스팅, 서버, 데이터베이스, 스토리지, 대역폭, 도메인, 백업 및 제3자 서비스는 각 운영자가 선택하고 비용을 부담합니다. 요금은 해당 제공업체가 이 프로젝트 및 유지관리자와 독립적으로 청구합니다. 자체 호스팅이 무료 인프라를 뜻하지는 않습니다.
