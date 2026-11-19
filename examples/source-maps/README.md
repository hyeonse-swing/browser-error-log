# 로컬 소스맵 등록 예제

이 예제의 이벤트는 합성 자료다. 같은 `/assets/app.js` 이름으로 빌드한 A·B 릴리스가 각각 다른 원본 TypeScript 줄을 가리킨다. 원본 식별자 위치는 A의 `release-a.ts:2:3`, B의 `release-b.ts:7:3`이다.

저장소 루트에서 한 터미널로 뷰어를 켠다.

```sh
npm ci
npm run dev
```

다른 터미널에서 새 출력 디렉터리를 지정해 예제 파일을 만든다. 디렉터리가 이미 있으면 다른 이름을 사용한다.

```sh
node examples/source-maps/build-fixture.mjs --output-dir /tmp/bel-source-map-example-1
```

`http://127.0.0.1:4317/`에서 `Import JSON`으로 출력된 `events.json`을 연다. `Local source maps`를 펼쳐 아래 두 쌍을 차례로 등록한다.

| 릴리스 | Registration manifest | Source map file |
|---|---|---|
| A | `A/manifest.json` | `A/assets/app.js.map` |
| B | `B/manifest.json` | `B/assets/app.js.map` |

`Top errors`에서 A와 B의 합성 오류를 각각 열어 `Original locations`를 확인한다. A 맵을 제거하면 A 오류는 미매핑 상태가 되고 B는 계속 원본 위치를 보여준다. 맵은 현재 뷰어 탭에만 등록된다. JS 빌드와 맵은 출력 디렉터리에만 있고, 예제의 배포 주소 `app.example.test`에는 업로드하지 않는다.

실제 SDK 수집과 SQLite 수집기, 빌드된 뷰어를 함께 검사하려면 저장소 루트에서 다음 명령을 실행한다. 이 검사는 Chromium·Firefox·WebKit에서 같은 URL의 두 빌드를 번갈아 제공한다.

```sh
npm run build:micro
npx --no-install playwright test source-maps.spec.mjs
```
