# SDK 모드별 실측 — 2026-11-17

`@ihyeon/browser-error-log@0.2.13` 공개 설치본의 `minimal`, `standard`, `detailed`를 같은 로컬 브라우저 작업으로 비교했다. 기능을 추가로 수정하거나 다른 버전을 비교한 결과가 아니다.

## 결과를 먼저 읽기

동일한 **수동 오류 1,000건**을 모두 수집·전송한 조건에서:

- minimal은 standard보다 메인 스레드 작업 CPU 시간이 **51.8%**, 수집 요청 본문이 **50.9%** 적었다. 별도 메모리 단계에서 수동 오류 40건이 큐에 대기할 때 추가 JS 힙은 **67.7%** 적었다.
- minimal은 detailed보다 메인 스레드 작업 CPU 시간이 **78.2%**, 수집 요청 본문이 **64.9%** 적었다. 별도 메모리 단계에서 수동 오류 40건이 큐에 대기할 때 추가 JS 힙은 **76.5%** 적었다.

이는 이 합성 작업의 측정값이다. 앱 전체 CPU 사용률이나 전체 메모리가 같은 비율로 줄어든다는 뜻은 아니다. minimal은 스택·원인 오류 정보와 자동 진단을 생략하는 선택이며, 동일한 진단 정보를 더 싸게 보존하는 모드는 아니다.

오류 없는 성공 요청·페이지 이동에서는 minimal과 standard의 CPU 차이가 작았고, 반복값의 불확실성 구간이 0을 포함했다. 이 조건에서 minimal의 CPU 우위를 확정하지 않는다. 세 모드 모두 수집 서버 전송은 0바이트였다.

세 모드는 동일한 ESM **28,682바이트 / gzip 9,080바이트** 파일을 사용한다. 다운로드 크기는 달라지지 않는다. gzip은 파일을 로컬 압축한 크기이며 이 실험의 HTTP 업로드는 압축하지 않았다.

## 측정 조건

- 시간: **2026-11-17 16:39:26–16:40:30 KST**. 예비 검증 1회는 최종 통계에서 제외했다.
- 기기: Apple M1 Pro, 논리 CPU 8개, RAM 32 GiB, macOS 26.6.2 / Darwin 25.6.0.
- 실행 환경: Node 24.22.1, Playwright 1.64.0, Chromium 156.0.8078.4, headless, 1280×800.
- SDK: npm 공개 0.2.13 설치본. 릴리스 소스 `d26130776800a38bb844d07e4861f2bf2c13f71e`.
- SDK ESM SHA-256: `aa2e9cbbbcf2273eb5582633cf4fda4e6e25de400505972ed72b9f0d2e8e6498`.
- 반복: **3작업 × 4조건(SDK 없음 포함) × 12회 = 144회**. 매 조건마다 새 브라우저 프로세스를 열었다. 4회 단위로 모드 순서·선행 조건을 균형 있게 바꾸고, 작업 순서도 3회 단위로 회전했다.
- 각 셀에서 본 작업량의 20%를 워밍업한 뒤 클라이언트를 다시 만들고, GC와 수집 카운터 초기화를 마친 후 계측했다. 워밍업·다운로드·모듈 파싱·초기화 시간은 본 작업 CPU에 포함하지 않는다.
- 외부 서비스·계정은 쓰지 않았다. loopback HTTP 수집기는 즉시 200을 반환하고 실제 요청 본문 바이트와 이벤트를 집계했다.
- 기본 fetch 전송을 사용했다. `flushIntervalMs: 60000`만 공통으로 지정해 타이머가 짧은 시험 도중 끼어들지 않게 했다. 큐 50건·배치 최대 20건·48,000바이트 상한, sampling 1, 중복 억제·분당 제한 비활성 등 나머지는 기본값이다.
- 오류마다 새 Error 객체를 만들며, 5단계 호출 깊이·원인 Error 1개·고정 componentStack·스칼라 context를 동일하게 제공했다. beforeSend 등 사용자 훅은 없다.
- CPU·네트워크 throttling은 하지 않았다. 다른 앱이 켜진 개발 머신의 측정이며 전용 실험실·실기기·운영 성능 검증은 아니다.

## 지표를 어떻게 읽나

**CPU**는 CDP `Performance.enable({timeDomain: 'threadTicks'})`의 `TaskDuration` 전후 차이다. 실제 스레드가 실행한 시간을 쓰며, 작업과 명시적 flush/응답 완료를 포함한다. SDK 코드만 따로 분리한 비용이 아니라 이 페이지 작업 구간의 메인 스레드 작업 시간이다. GC 강제 실행과 메모리·RSS 샘플링은 이 구간 밖이다. [공식 시간 도메인 정의](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Performance.pdl).

보조 CPU는 `SystemInfo.getProcessInfo`에서 같은 렌더러 PID들의 누적 `cpuTime` 차를 합산했다. 메인 스레드 외 렌더러 스레드를 포함하지만 브라우저·GPU·별도 네트워크 프로세스·Node 수집기는 제외한다. 샘플 호출 경계가 주 지표보다 조금 넓다. `ScriptDuration`은 CDP에서 호출한 작업을 전부 포괄하지 않아 일부 조건에서 0이며, 성능 결론에는 쓰지 않았다. [공식 process CPU 정의](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/SystemInfo.pdl).

**메모리**는 CPU 시험과 분리한 한 배치에서 측정했다. 모듈이 이미 로드된 상태에서 클라이언트 없음 → 초기화 → 미전송 큐 → flush 완료 순서로 강제 GC 후 `Runtime.getHeapUsage.usedSize`를 읽었다. 따라서 ‘클라이언트 증가’는 SDK 모듈 전체 크기가 아니며, ‘큐 대기 증가’도 해당 isolate의 JS 힙 변화량이다. 순간 할당량·peak·메모리 누수 판정이 아니다. `ps`의 RSS는 해당 시점 렌더러 전체 상주 메모리로, SDK 전용 메모리 절감률로 바꾸지 않았다. [공식 isolate heap 정의](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json).

**전송량**은 수집 서버가 실제 받은 UTF-8 JSON 요청 본문의 합이다. HTTP 헤더·TCP/TLS·재전송·SDK 다운로드·합성 앱의 성공/실패 응답은 제외한다. POST 수는 별도로 표시했다. 모든 표의 값은 **12회 중앙값**, 대괄호는 **25–75백분위수(IQR)**다. KiB=1,024바이트, MiB=1,048,576바이트.

## 1. 같은 수동 오류 1,000건

40건 생성 후 flush를 25번 반복했다. 세 SDK 모드 모두 1,000건을 전송했으므로 수집 건수 차이 없이 스택·원인 처리 등의 차이를 비교한다. SDK 없는 조건도 같은 Error를 생성하지만 기록 호출은 없다.

| 모드 | 메인 스레드 CPU ms [IQR] | 렌더러 전체 스레드 CPU ms | 수집 본문 KiB | 이벤트 / POST |
| --- | ---: | ---: | ---: | ---: |
| SDK 없음 | 4.29 [4.14–4.41] | 4.48 | 0.00 | 0 / 0 |
| minimal | 35.17 [34.34–35.93] | 50.86 | 588.20 | 1000 / 50 |
| standard | 72.97 [71.95–74.30] | 95.46 | 1,196.75 | 1000 / 50 |
| detailed | 161.09 [160.69–163.09] | 190.21 | 1,675.72 | 1000 / 50 |

별도 메모리 단계에서는 **40건만 만든 뒤 flush 전**에 읽었다. 자동 flush가 발생하지 않았고 대기 이벤트 수가 정확히 40건인지 검사했다.

| 모드 | 초기화 시 클라이언트 힙 증가 KiB | 40건 큐 대기 힙 증가 KiB [IQR] | 큐 대기 전체 JS 힙 MiB | flush 후 힙 증가 KiB | 렌더러 RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| SDK 없음 | 0.05 | 0.00 [0.00–0.00] | 1.078 | 0.26 | 94.03 |
| minimal | 4.07 | 16.67 [16.67–16.67] | 1.248 | 12.90 | 105.18 |
| standard | 4.61 | 51.64 [48.93–51.64] | 1.314 | 26.11 | 113.62 |
| detailed | 5.12 | 71.03 [71.03–71.03] | 1.340 | 27.40 | 119.95 |

초기화된 클라이언트 자체의 증분은 약 4–5 KiB로 작았다. 큐에 대기하는 스택·원인 문자열이 커질수록 모드 차이가 커졌다. flush 후에도 내부 자료구조·캐시와 브라우저 작업에 따른 힙 증가가 남았으며, 이 단일 시점으로 누수 유무를 판단하지 않는다.

## 2. 오류 없는 활동

성공 fetch 200회와 `history.replaceState` 200회를 수행했다. detailed는 이동·네트워크 breadcrumb를 만들지만 오류 이벤트가 없으므로 세 모드 모두 수집 POST가 없다. 메모리 단계는 성공 요청·이동 10쌍이다.

| 모드 | 메인 스레드 CPU ms [IQR] | 수집 본문 / 이벤트 | 활동 후 힙 증가 KiB | 렌더러 RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| SDK 없음 | 32.29 [31.93–33.82] | 0 B / 0 | 0.00 | 96.93 |
| minimal | 32.55 [32.06–35.18] | 0 B / 0 | 0.11 | 97.38 |
| standard | 34.23 [33.88–35.25] | 0 B / 0 | 0.11 | 98.34 |
| detailed | 42.96 [40.73–44.51] | 0 B / 0 | 1.31 | 101.34 |

minimal 대비 standard의 CPU 중앙값 차이는 약 4.9%였지만 paired bootstrap 95% 구간이 **−3.1%–9.5%**로 0을 포함했다. **차이가 확실하다고 판단하지 않는다.** detailed 대비 차이는 약 24.2%였고 같은 구간은 17.7%–26.6%였다. 0.11 KiB 같은 작은 메모리 차이는 앱 전체에 실질적인 영향을 준다고 일반화하지 않는다. 장시간 idle 타이머·배터리 소모는 이 작업의 측정 대상이 아니다.

## 3. 자동 오류가 섞인 활동

200회 반복마다 수동 오류 1건, 전역 ErrorEvent 1건, `console.error` 1건, HTTP 500 1건, 성공 fetch 1건, history 이동 1건을 발생시켰다. 10회마다 flush했다. 의도한 이벤트 수는 minimal 200건, standard 600건, detailed 800건이다. Promise 거부·리소스 실패·XHR·React 어댑터는 이 작업에 포함하지 않았다.

| 모드 | 메인 스레드 CPU ms [IQR] | 수집 본문 KiB | 이벤트 / POST | 한 배치 큐 힙 증가 KiB | 렌더러 RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| SDK 없음 | 69.76 [67.83–74.00] | 0.00 | 0 / 0 | 0.00 | 102.50 |
| minimal | 83.92 [81.91–90.55] | 117.98 | 200 / 20 | 4.34 | 107.35 |
| standard | 119.28 [118.89–121.98] | 579.98 | 600 / 40 | 21.66 | 113.93 |
| detailed | 205.35 [202.06–217.46] | 3,527.33 | 800 / 79 | 82.09 | 141.93 |

이 조건에서 minimal은 standard보다 CPU 29.6%·전송 본문 79.7%, detailed보다 CPU 59.1%·전송 본문 96.7% 적었다. **자동 오류를 수집하지 않아 기록 건수도 줄어든 결과**이므로 같은 정보량의 최적화로 소개하지 않는다. detailed의 POST가 더 많은 것은 breadcrumb가 붙은 이벤트가 커져 배치 바이트 상한에 먼저 도달하기 때문이다.

## 반복 편차와 확인한 조건

- 모든 144회에서 예상 이벤트 종류·개수·수신 SDK 버전을 확인했다. CPU 종료 시 queued/inFlight/dropped/filtered/deduplicated 모두 0이었다. 전송량이 작아진 이유가 큐 초과·유실·샘플링은 아니다.
- 메모리 단계는 CPU 시험과 별도이며 큐가 비워지기 전에 이벤트가 전송되지 않았음을 확인했다. 모든 측정에서 렌더러 PID 집합이 유지됐고 CPU 수치가 유한했다.
- 수동 작업에서 minimal의 standard 대비 CPU 감소 51.8%의 paired bootstrap 95% 구간은 **50.6%–53.0%**였다. 같은 순서 블록의 12쌍을 3,000회 재표집했다. 이는 이 실험 반복의 불확실성으로, 모든 기기·서비스의 효과 범위가 아니다.
- 원시 기록은 이상치 제거 없이 모두 보존했다. 각 metric의 중앙값·IQR·최솟값·최댓값과 비교 구간은 summary.json에 있다. RSS로 SDK 메모리 절감률을 계산하지 않는다.

## 재실행

아래 명령은 이 SDK 저장소의 소스를 체크아웃한 루트에서 실행한다. npm 패키지에도 동일한 보고서·원시값·계측 스크립트를 `ai/` 안에 포함하지만, SDK 설치만으로 Playwright 개발 의존성이나 브라우저가 설치되지는 않는다.

```sh
npm ci --no-audit --no-fund
mkdir -p output/preset-consumer
printf '{"private":true,"type":"module"}\n' > output/preset-consumer/package.json
npm install --prefix output/preset-consumer --ignore-scripts --no-audit --no-fund @ihyeon/browser-error-log@0.2.13
npx playwright install chromium
node scripts/benchmark-sdk-presets.mjs \
  --sdk-dir output/preset-consumer/node_modules/@ihyeon/browser-error-log \
  --out output/preset-benchmark \
  --repetitions 12
```

이 스크립트의 RSS 측정은 POSIX `ps`가 있는 환경을 전제로 하며, 이 기록은 macOS에서 실행했다. 다른 OS·Chrome 버전·기기에서는 수치가 달라질 수 있다. 실행 중인 다른 앱은 자동으로 종료하지 않는다. 스크립트는 자신이 연 브라우저와 loopback 서버를 정상 종료·예외 처리 시 정리한다.

## 파일

- [계측 스크립트](../scripts/benchmark-sdk-presets.mjs) · [동일 작업 fixture](../scripts/fixtures/sdk-preset-benchmark.js)
- [원시 측정 144회](benchmarks/2026-11-17-presets/raw.json) · [집계·편차](benchmarks/2026-11-17-presets/summary.json)

기존 릴리스 때의 “CPU·메모리 절감률 미측정”은 당시 상태이며, 이 문서가 후속 로컬 측정이다. 이 측정에서는 SDK 런타임 소스를 수정하지 않았다. 후속 문서 배포에서 이 보고서를 포함해도 측정 대상 버전은 0.2.13으로 유지된다.
