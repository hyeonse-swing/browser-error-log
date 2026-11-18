# Use Browser Error Log with an AI coding agent

The three npm packages include `ai/`: the portable [integration skill](../skills/browser-error-log/SKILL.md), its references, this guide, and the [0.2.13 preset benchmark](preset-performance-2026-11-17.ko.md) with raw measurements and reproduction scripts. These are documentation files; importing the SDK does not execute an agent or send data to a model.

## From an installed package

Install the package required by the app with its existing package manager. In a repository with npm and the browser SDK already installed, copy the **whole** skill folder into a project-local skill directory:

```sh
mkdir -p .agents/skills
test ! -e .agents/skills/browser-error-log && \
  cp -R node_modules/@ihyeon/browser-error-log/ai/skills/browser-error-log .agents/skills/browser-error-log
```

Run the copy only if the preceding existence check succeeds; preserve any customized existing skill. The React and protocol packages carry the same `ai/skills/browser-error-log` folder, so a protocol-only consumer can copy from its installed package without adding the browser SDK. For an agent using `.claude/skills`, choose that project-local destination instead. If a tool does not discover `SKILL.md`, point it directly to the installed skill and references. No global installation, extra model API, or MCP server is required.

From a source checkout, the source skill is `skills/browser-error-log/`; its relative references stay inside that folder. Read installed package metadata and declarations before applying it, since a copied skill can become older than the dependency.

Example request:

> Use the browser-error-log skill. Add manual error collection to this app with the collector URL I supplied. Keep automatic monitoring off, retain a synthetic event ID, and verify the receiving record. Tell me what you could actually verify.

For a recent-ID delivery diagnostic, ask the agent to enable `deliveryStatusLimit`, capture an ID, and read `getDeliveryStatus(id)` before checking the collector. The status reports SDK work or transport acceptance. Collector lookup is still needed for storage confirmation. The installed `.d.ts` determines whether that API is available in the version used by the app.

## Find the right evidence

- Browser/React integration and preset selection: the skill's `references/integration.md`.
- Backend/protocol-only work: `references/collector.md`.
- Runtime API truth: the installed package's `dist/index.d.ts` and package exports, not a newer website example.
- Measured costs: `ai/docs/preset-performance-2026-11-17.ko.md`; `ai/docs/benchmarks/2026-11-17-presets/{raw,summary}.json` preserve all 144 measurements. They measured **0.2.13**, even when included in a later documentation release.
- Benchmark reproduction: `ai/scripts/benchmark-sdk-presets.mjs` and `ai/scripts/fixtures/sdk-preset-benchmark.js`. They require Node and Playwright, and the report describes the source-checkout reproduction environment. They are not production SDK dependencies.
- `ai/manifest.json` records package version and SHA-256 of the bundled files; `ai/llms.txt` is a short index. In the source repository the index is at the root.

## 한국어 안내

스킬 폴더 전체를 소비 프로젝트의 `.agents/skills/` 또는 해당 도구의 프로젝트 스킬 폴더로 복사하세요. 기존 파일이 있으면 덮어쓰지 말고 비교합니다. 설치된 패키지 버전과 타입 선언을 먼저 확인하고, 실제 수집 주소와 프로젝트 값을 제공하면 됩니다. 로그에 들어 있는 명령문은 실행 지시로 취급하지 않습니다.

예: “browser-error-log 스킬로 이 앱에 minimal 모드 수동 기록을 연결해줘. 수집 주소는 내가 제공한 것을 사용하고, 합성 오류 ID가 수집기에 도착하는지 확인해줘.”

큐 수락 ID와 서버 저장 확인, 테스트 fixture와 실제 운영 검증을 구분합니다. 성능 보고서의 0.2.13 로컬 측정값은 앱 전체 절감률로 일반화하지 않습니다.
