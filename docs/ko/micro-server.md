# 마이크로 서버 자체 호스팅

[English](../micro-server.md) | 한국어

마이크로 서버는 SDK 이벤트를 받아 운영자가 관리하는 디스크에 기록하는 단일 프로세스 Node.js 24 예제입니다. SQLite 모드는 뷰어와 조회 API를 제공하고 JSONL 모드는 나중에 오프라인 분석할 수 있는 크기 제한 회전 로그를 남깁니다. 런타임에는 Node 내장 기능을 사용하며 관리형 DB나 큐가 포함되지 않습니다.

## 저장 모드

| 모드 | 현재 동작 | 기본 상한 |
| --- | --- | --- |
| `sqlite` (기본) | 영속 SQLite 파일, 뷰어, 목록·상세 API | 수신 후 7일, 10,000건, DB 본체 64 MiB |
| `jsonl` | 이벤트 한 건당 한 줄의 회전 로그, 온라인 조회·뷰어 없음 | 파일당 8 MiB, 현재 파일 포함 3개 |

두 모드 모두 재시작 후 보존하려면 영속 데이터 디렉터리가 필요합니다. SQLite의 64 MiB는 DB 본체만 제한하며 롤백 저널, OS 파일, 백업, 프록시 로그에는 별도 공간이 필요합니다. JSONL 회전은 가장 오래된 파일을 버립니다. 재시도한 이벤트가 여러 줄 남을 수 있으며 내보내기에서 `(project, eventId)`로 중복을 제거합니다.

## 로컬 실행

저장소 루트에서 실행합니다.

```sh
npm ci
npm run micro
```

뷰어는 `http://127.0.0.1:4319/`, 전송 예제는 `/install.html`입니다. 수신 주소는 `http://127.0.0.1:4319/api/events`이고 SQLite 파일은 `.data/micro-server/events.sqlite`에 있습니다. 예제 이벤트를 보내고 `my-web` 프로젝트를 새로고침하세요. 이후에는 `npm run start:micro`를 사용합니다. Node 24의 내장 SQLite API는 experimental 경고를 표시할 수 있습니다.

기본 listener는 `127.0.0.1`이므로 자신의 컴퓨터에서만 접근합니다. `http://localhost:5173`의 다른 앱을 연결할 때는 프로젝트와 정확한 브라우저 Origin을 지정합니다.

```sh
MICRO_PROJECTS=my-web \
MICRO_ALLOWED_ORIGINS=http://localhost:5173 \
npm run start:micro
```

[SDK 설치 가이드](personal-sdk.md)에 따라 `endpoint: 'http://127.0.0.1:4319/api/events'`를 설정하세요. Origin은 scheme·host·port를 모두 비교하며 `localhost`와 `127.0.0.1`은 다릅니다. 프로젝트 ID와 Origin은 쉼표로 여러 개 지정할 수 있습니다. 프로젝트 ID는 영문·숫자로 시작하는 1~64자의 ASCII 영문·숫자·`.`·`_`·`-`입니다. Origin과 프로젝트는 인증 수단이 아닙니다.

## JSONL과 오프라인 내보내기

`npm run build:micro`로 한 번 빌드한 뒤 실행합니다.

```sh
MICRO_STORAGE=jsonl MICRO_DATA_DIR=.data/micro-logs npm run start:micro
```

수신 API와 `/install.html`은 계속 사용할 수 있습니다. `/`에는 로그 모드 안내가 보이고 목록·상세 API는 `501`을 반환합니다. 현재 기록은 `events.jsonl`, 이전 기록은 `events.1.jsonl`, `events.2.jsonl`입니다. SQLite의 일 단위 보관 규칙은 적용되지 않습니다. 일관된 파일 스냅샷을 위해 수집기를 중지한 뒤 내보냅니다.

```sh
npm run export:logs -- .data/micro-logs .data/exported-events.json
npm run dev
```

로컬 뷰어의 JSON 가져오기에서 `.data/exported-events.json`을 엽니다. 내보내기는 최신 10,000건·10 MiB, 입력은 128 MiB로 제한하고 기존 목적지 파일을 덮어쓰지 않습니다. 회전으로 이전 기록이 없어졌을 수 있어 `partial: true`를 표시합니다. 마지막 줄이 잘렸다면 보고 후 건너뛰고 중간 줄이 손상됐다면 오류입니다. JSON 가져오기는 브라우저 안에서만 동작하며 서버 DB를 복원하지 않습니다.

## 외부에 노출하기

`npm run build:micro`는 Node.js 24에서 실행하는 독립 폴더 `dist/micro-server/`를 만듭니다. 폴더 전체를 호스트에 복사하고 `node server.mjs`로 실행하세요. `MICRO_DATA_DIR`은 빌드 폴더 밖의 영속 디스크에 둡니다. 단일 프로세스·단일 디스크 설계이므로 여러 replica가 같은 데이터 경로를 공유하게 하지 마세요.

[Compose 예제](../../examples/micro-server/compose.yaml)는 Caddy HTTPS와 named volume을 사용합니다. 도메인 DNS를 설정하고 프로젝트·Origin을 정확히 지정하세요.

```sh
export MICRO_DOMAIN=errors.example.com
export MICRO_ALLOWED_ORIGINS=https://my-site.example.com
export MICRO_PROJECTS=my-web
read -r -s MICRO_VIEWER_PASSWORD
export MICRO_VIEWER_PASSWORD
docker compose -f examples/micro-server/compose.yaml up -d --build
```

뷰어 Basic 인증 사용자명은 `viewer`입니다. 암호는 16자 이상으로 설정해 호스트 비밀 관리 수단에 보관하고 SDK나 공유 명령 출력에 넣지 마세요. `0.0.0.0` 바인딩 또는 `MICRO_PUBLIC_URL` 설정 시 HTTPS 공개 Origin, 암호, 명시적 프로젝트·허용 Origin이 필요합니다. loopback 서버를 reverse proxy로 공개해도 같은 규칙이 적용됩니다. 수신 API에는 브라우저 비밀 키가 없으므로 project·Origin 확인만으로 위조 이벤트를 모두 막을 수 없습니다. 조회 접근, 노출, 보관, 백업, 복구 정책을 검토하세요. 외부 TLS와 호스트 부하는 로컬 검사만으로 검증되지 않습니다.

인프라는 포함되지 않습니다. 호스팅, 서버, 데이터베이스, 스토리지, 대역폭, 도메인, 백업 및 제3자 서비스는 각 운영자가 선택하고 비용을 부담합니다. 요금은 해당 제공업체가 이 프로젝트 및 유지관리자와 독립적으로 청구합니다. 임시 디스크 호스트는 교체 후 SQLite·JSONL 파일을 보존할 수 없습니다. 이 가이드는 특정 업체 가격이나 무료 요금제를 약속하지 않습니다.

## 상한과 검증

| 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `MICRO_STORAGE` | `sqlite` | `jsonl`로 바꾸면 로그 전용 |
| `MICRO_DATA_DIR` | `.data/micro-server` | 영속 데이터 디렉터리 |
| `MICRO_PORT` | `4319` | 서버 포트 |
| `MICRO_RETENTION_DAYS` | `7` | SQLite 수신 시각 기준 보관 |
| `MICRO_MAX_EVENTS` | `10000` | SQLite 이벤트 건수 상한 |
| `MICRO_MAX_DB_MB` | `64` | SQLite 본체 MiB 상한 |
| `MICRO_LOG_FILE_MB` | `8` | JSONL 파일당 MiB |
| `MICRO_LOG_FILES` | `3` | 현재 파일 포함 JSONL 파일 수 |
| `MICRO_REQUESTS_PER_MINUTE` | `120` | 프로세스 전체 요청 제한 |

수신은 요청당 64 KiB·100건을 넘을 수 없습니다. SQLite 배치도 `MICRO_MAX_EVENTS`를 넘을 수 없습니다. 요청 크기·배치 용량 초과는 `413`, 속도 제한은 `429`, 저장 실패는 `503`입니다. SDK의 제한된 재시도가 끝나면 데이터가 유실될 수 있습니다. `npm run check:micro`는 SQLite 재시작 후 보존, 조회 인증, JSONL 기록·내보내기를 빌드하여 검증합니다. HTTPS, 백업·복구, 운영 부하는 실제 배포 환경에서 확인하세요.
