# Browser Error Log

[English](README.md) | 한국어

브라우저 오류를 직접 관리하는 인프라에 기록합니다. 프레임워크에 종속되지 않는 브라우저 SDK, React Error Boundary, 작은 자체 호스팅 수집기와 뷰어를 제공합니다. Node.js 24 프로세스 하나로 SQLite에 이벤트를 저장하고 뷰어를 제공할 수 있습니다. 데이터 위치, 보관 기간, 조회 권한은 운영자가 결정합니다. 공개 이벤트 타입과 전송 훅을 사용해 자체 백엔드에 연결할 수도 있습니다.

브라우저 SDK, React 어댑터, 프로토콜의 검증된 MIT 라이선스 `0.1.0` 버전을 npm에서 설치할 수 있습니다. 다국어 지원을 포함한 `0.1.1`은 준비 중이며 아직 게시되지 않았습니다. 수집기와 뷰어는 운영자의 인프라에서 실행합니다. 패키지 정보는 [릴리스 가이드](docs/ko/releasing.md)를 참고하세요. GitHub 소스 릴리스나 태그는 npm 게시와 별개입니다.

## 영구 저장으로 시작하기

Node.js 24와 npm을 사용합니다.

```sh
git clone https://github.com/hyeonse-swing/browser-error-log.git
cd browser-error-log
npm ci
npm run micro
```

[뷰어](http://127.0.0.1:4319/)와 [연결 예제](http://127.0.0.1:4319/install.html)를 엽니다. 언어 선택의 기본값은 영어이며 브라우저 저장소를 사용할 수 있으면 선택한 언어를 기억합니다. 수집기는 `POST http://127.0.0.1:4319/api/events`를 받고 `.data/micro-server/events.sqlite`에 저장합니다. 예제 오류를 전송한 뒤 뷰어를 새로고침하고 `my-web`을 선택하세요. 기본 서버는 로컬 컴퓨터에서만 접근할 수 있습니다. 첫 빌드 후에는 같은 데이터 디렉터리를 사용해 `npm run start:micro`로 다시 시작합니다.

SQLite 기본값은 서버 수신 시점부터 7일, 이벤트 10,000건, DB 본체 64 MiB입니다. 저널 파일과 백업에는 별도 공간이 필요합니다. JSONL, 외부 HTTPS 연결, 용량 설정은 [자체 호스팅 가이드](docs/ko/micro-server.md)에 있습니다.

## 다른 앱 연결하기

대상 웹앱에서 SDK를 설치합니다.

```sh
npm install browser-error-log
```

기존 React 18/19 앱에는 어댑터를 추가합니다.

```sh
npm install browser-error-log browser-error-log-react
```

일반적인 앱 연결에는 `browser-error-log`만 설치하면 됩니다. SDK와 수집기가 공유하는 이벤트 타입·상수 패키지인 `browser-error-log-protocol`은 자동으로 설치됩니다. protocol 자체는 오류를 수집하거나 서버를 실행하지 않습니다. React Error Boundary가 필요할 때만 `browser-error-log-react`를 추가하세요. 소스 체크아웃의 로컬 tarball 경로도 [SDK 가이드](docs/ko/personal-sdk.md)에 설명합니다.

앱 주소가 `http://localhost:5173`이라면 정확한 브라우저 Origin을 허용해 수집기를 시작합니다.

```sh
MICRO_PROJECTS=my-web MICRO_ALLOWED_ORIGINS=http://localhost:5173 npm run start:micro
```

앱의 브라우저 진입점에서 한 번 초기화합니다.

```ts
import { init } from 'browser-error-log';

export const errorLog = init({
  project: 'my-web',
  environment: 'development',
  release: 'local-example',
  endpoint: 'http://127.0.0.1:4319/api/events',
});

errorLog.captureException(new Error('Connection check'));
await errorLog.flush();
```

뷰어의 `my-web` 프로젝트에 이벤트가 표시됩니다. SDK는 전역 JavaScript 예외, 처리되지 않은 Promise, fetch/XHR 연결 실패, HTTP 5xx도 기본 수집합니다. `console.error` 수집은 선택 사항입니다. React 렌더링 오류는 [`ErrorBoundary`](docs/ko/personal-sdk.md#react와-ssr)를 사용할 수 있습니다. 클라이언트 수명, 사용자 지정 전송, 데이터 필터는 [SDK 가이드](docs/ko/personal-sdk.md)를 참고하세요.

## 얻을 수 있는 것

- **데이터 경로 소유:** SQLite 수집기, 회전 JSONL 로그, 자체 백엔드 중 선택하고 보관·접근·백업·삭제 정책을 직접 정합니다.
- **오류 맥락 확인:** 프로젝트·환경·종류·기간으로 필터링하고 메시지·릴리스·페이지를 검색하며 스택·네트워크 상태를 확인합니다. 제한된 JSON 스냅샷을 내보내 오프라인에서 분석할 수 있습니다. 차트는 수집된 이벤트 건수이며 사용자 수나 전체 요청 대비 오류율이 아닙니다.
- **유연한 연결:** 기본 endpoint 또는 `transport(batch, { signal })`을 사용합니다. 공개 이벤트와 뷰어 데이터 소스 타입으로 자체 백엔드를 구현할 수 있습니다.
- **제한된 보고 작업:** 큐·배치·시간 제한·재시도가 유한하며 전달은 최선형입니다. 진단 작업이 앱 오류를 대체하지 않도록 설계했습니다.

SDK는 URL의 쿼리·해시·사용자 정보를 제거하고 흔한 민감정보 패턴을 가립니다. **완전한 비식별화는 보장하지 않습니다.** 앱에 맞는 `sanitizeUrl`과 `beforeSend` 규칙을 추가하세요. 요청/응답 본문, 쿠키, 폼 값, DOM 스냅샷, 세션 리플레이는 수집하지 않습니다. 소스맵 자동화, 알림, 네이티브 크래시, 전달 보장도 제공하지 않습니다.

인프라는 포함되지 않습니다. 호스팅, 서버, 데이터베이스, 스토리지, 대역폭, 도메인, 백업 및 제3자 서비스는 각 운영자가 선택하고 비용을 부담합니다. 요금은 해당 제공업체가 이 프로젝트 및 유지관리자와 독립적으로 청구합니다.

## 다른 실행 경로

`npm run dev`는 `http://127.0.0.1:4317/`에서 메모리 전용 로컬 데모를 실행합니다. 샘플 기록은 합성 데이터이며 수집 기록은 재시작하면 사라집니다. 뷰어·데모·설치 예제의 언어 선택은 영어가 기본이고 브라우저 저장소를 사용할 수 있으면 선택을 기억합니다. `npm run collector`는 4318 포트의 별도 메모리 수집기입니다. 파일에 남기려면 `npm run micro`를 사용하세요. 자세한 내용은 [v1 연동 계약](docs/ko/integration.md), [자체 백엔드 계약](docs/ko/server-request.md), [로드맵](docs/ko/expansion-roadmap.md)에 있습니다.

| 경로 | 역할 |
| --- | --- |
| `packages/browser` | 프레임워크 독립 브라우저 SDK |
| `packages/react` | React Error Boundary 어댑터 |
| `packages/protocol` | v1 이벤트·조회 타입 |
| `apps/viewer` | 대시보드, 타임라인, 상세, JSON 입출력 |
| `apps/demo`, `apps/local-collector` | 메모리 전용 로컬 개발 예제 |
| `examples/micro-server` | 파일 기반 SQLite 또는 JSONL 수집기 |

코드와 빌드 예제는 `npm run check`, `npm run check:package`, `npm run check:micro`로 검증합니다. 외부 TLS, 특정 배포 환경, 실제 기기 동작은 해당 환경에서 별도 확인해야 합니다.
