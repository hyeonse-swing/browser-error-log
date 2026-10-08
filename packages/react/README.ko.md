# browser-error-log-react

[English](https://github.com/hyeonse-swing/browser-error-log/blob/main/packages/react/README.md) | 한국어

Browser Error Log의 React Error Boundary입니다. 렌더링 오류와 React 컴포넌트 스택을 기존 브라우저 SDK 클라이언트에 전달하므로 앱의 다른 오류와 같은 수집기·정책을 사용합니다.

React peer 범위는 `>=18 <20`입니다. 이 선언이 모든 React 버전·프레임워크 검증을 뜻하지는 않습니다.

## 설치

React 앱에서 브라우저 SDK와 어댑터를 설치합니다.

```sh
npm install browser-error-log browser-error-log-react
```

앱에 React가 이미 설치되어 있어야 합니다. 어댑터는 React를 번들에 넣지 않습니다. 게시 패키지 대신 로컬 소스를 사용하려면 [SDK 가이드](https://github.com/hyeonse-swing/browser-error-log/blob/main/docs/ko/personal-sdk.md)에 따라 프로토콜·브라우저·React tarball을 함께 설치하세요.

## 브라우저 진입점에서 사용

앱 Origin을 허용해 저장소의 자체 호스팅 수집기를 시작합니다.

```sh
MICRO_PROJECTS=my-web MICRO_ALLOWED_ORIGINS=http://localhost:5173 npm run micro
```

브라우저 코드에서 클라이언트를 한 번 초기화하고 보호할 UI를 감쌉니다.

```tsx
import { init } from 'browser-error-log';
import { ErrorBoundary } from 'browser-error-log-react';

const errorLog = init({
  project: 'my-web',
  endpoint: 'http://127.0.0.1:4319/api/events',
  environment: 'development',
  release: 'my-release',
});

export function Root() {
  return (
    <ErrorBoundary
      client={errorLog}
      fallback={(_error, reset) => (
        <section>
          <p>This view could not be displayed.</p>
          <button onClick={reset}>Try again</button>
        </section>
      )}
    >
      <App />
    </ErrorBoundary>
  );
}
```

위 `App`은 앱 컴포넌트입니다. fallback은 React 노드 또는 오류와 reset 콜백을 받는 함수입니다. reset은 Boundary의 오류 상태를 지우고 자식을 다시 렌더링하므로 원인 상태가 그대로라면 다시 실패할 수 있습니다. fallback이 없으면 실패한 Boundary는 아무것도 렌더링하지 않습니다.

SSR 프레임워크에서는 클라이언트 진입점을 사용하세요. 서버에서 SDK를 import할 수는 있지만 서버 오류를 수집하지 않습니다. 이 Boundary는 React가 `componentDidCatch`에 전달한 오류를 처리합니다. 앱에서 처리한 오류에는 `captureException`을 사용하고 전역 JavaScript·Promise·네트워크 오류에는 기본 SDK를 사용하세요. 네이티브 크래시나 서버 오류 처리기는 아닙니다.

수집 기록은 `http://127.0.0.1:4319/`에서 확인할 수 있습니다. 외부 배포에는 자체 HTTPS 수집기와 [자체 호스팅 가이드](https://github.com/hyeonse-swing/browser-error-log/blob/main/docs/ko/micro-server.md)를 사용하세요. 뷰어 암호를 브라우저 코드에 넣지 마세요.

## 호스팅과 비용

인프라는 포함되지 않습니다. 호스팅, 서버, 데이터베이스, 스토리지, 대역폭, 도메인, 백업 및 제3자 서비스는 각 운영자가 선택하고 비용을 부담합니다. 요금은 해당 제공업체가 이 프로젝트 및 유지관리자와 독립적으로 청구합니다.
