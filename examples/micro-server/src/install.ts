import { init } from 'browser-error-log';
import { getLocale, setLocale, subscribeLocale } from '../../../apps/i18n/locale';

const en = {
  language: 'Language', heading: 'Connect the SDK',
  intro: 'Send a sample error to your self-hosted collector. Find it in the dashboard in SQLite mode, or in your log files in JSONL mode.',
  endpoint: 'Collector endpoint', project: 'Project', send: 'Send a sample error',
  connect: 'Connect your app',
  setup: "Install the SDK package, then initialize it once in your browser entry point. The project must match your collector's allowlist, and a separate app origin must be included in MICRO_ALLOWED_ORIGINS.",
  viewer: "Open this collector's viewer",
  costs: 'Infrastructure is not included. You choose and pay for your hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services. Any charges are billed separately by your providers, not by this project or its maintainers.',
  ready: 'Ready to send', sending: 'Sending…', accepted: 'The collector accepted one error.',
  failed: 'Delivery failed. Check the endpoint, allowed origin, project, and collector status.',
  invalid: 'Check your SDK configuration.', sent: 'Sent', queued: 'Queued', dropped: 'Dropped',
  logOnly: 'JSONL log-only mode is enabled. The event query API and live viewer are unavailable.',
};
const ko: Record<keyof typeof en, string> = {
  language: '언어', heading: 'SDK 연결',
  intro: '직접 운영하는 수집 서버에 예제 오류를 전송합니다. SQLite 모드에서는 대시보드에서, JSONL 모드에서는 로그 파일에서 확인하세요.',
  endpoint: '수집 서버 주소', project: '프로젝트', send: '예제 오류 전송',
  connect: '내 앱 연결하기',
  setup: 'SDK 패키지를 설치한 뒤 브라우저 진입점에서 한 번만 초기화하세요. 프로젝트는 수집 서버의 허용 목록과 일치해야 하며, 다른 앱의 출처는 MICRO_ALLOWED_ORIGINS에 등록해야 합니다.',
  viewer: '이 수집 서버의 뷰어 열기',
  costs: '인프라는 제공되지 않습니다. 호스팅, 서버, 데이터베이스, 저장 공간, 트래픽, 도메인, 백업 및 외부 서비스는 운영자가 직접 선택하고 비용을 부담합니다. 요금은 이 프로젝트나 관리자가 아닌 각 서비스 제공자가 별도로 청구합니다.',
  ready: '전송 준비 완료', sending: '전송 중…', accepted: '수집 서버가 오류 1건을 수신했습니다.',
  failed: '전송에 실패했습니다. 서버 주소, 허용 출처, 프로젝트 및 수집 서버 상태를 확인하세요.',
  invalid: 'SDK 설정을 확인하세요.', sent: '전송', queued: '대기', dropped: '버림',
  logOnly: 'JSONL 로그 전용 모드입니다. 이벤트 조회 API와 실시간 뷰어는 사용할 수 없습니다.',
};

const language = document.querySelector<HTMLSelectElement>('#language');
const endpoint = document.querySelector<HTMLInputElement>('#endpoint');
const project = document.querySelector<HTMLInputElement>('#project');
const status = document.querySelector<HTMLElement>('#status');
const send = document.querySelector<HTMLButtonElement>('#send');
let statusKey: 'ready' | 'sending' | 'accepted' | 'failed' | 'invalid' = 'ready';
let stats: ReturnType<ReturnType<typeof init>['getStats']> | undefined;

function renderLanguage(): void {
  const locale = getLocale();
  const text = locale === 'ko' ? ko : en;
  document.documentElement.lang = locale;
  document.title = endpoint ? `${text.heading} · Browser Error Log` : 'Browser Error Log';
  if (language) language.value = locale;
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = element.dataset.i18n as keyof typeof en;
    if (Object.hasOwn(text, key)) element.textContent = text[key];
  }
  if (status) {
    status.textContent = text[statusKey] + (stats
      ? `\n${text.sent} ${stats.sent.toLocaleString(locale)} · ${text.queued} ${stats.queued.toLocaleString(locale)} · ${text.dropped} ${stats.dropped.toLocaleString(locale)}`
      : '');
  }
}

language?.addEventListener('change', () => setLocale(language.value === 'ko' ? 'ko' : 'en'));
subscribeLocale(renderLanguage);
renderLanguage();

if (endpoint && project && send) {
  endpoint.value = `${location.origin}/api/events`;
  const update = () => {
    const snippet = document.querySelector('#snippet');
    if (snippet) snippet.textContent = `import { init } from 'browser-error-log';\n\nconst errorLog = init({\n  project: ${JSON.stringify(project.value)},\n  endpoint: ${JSON.stringify(endpoint.value)},\n  environment: 'production',\n  release: 'my-release',\n});`;
  };
  endpoint.addEventListener('input', update);
  project.addEventListener('input', update);
  update();
  send.addEventListener('click', async () => {
    send.disabled = true;
    statusKey = 'sending';
    stats = undefined;
    renderLanguage();
    let client: ReturnType<typeof init> | undefined;
    try {
      client = init({ project: project.value, endpoint: endpoint.value, environment: 'example', release: 'micro-server-example' });
      client.captureException(new Error('Micro server SDK example'), { context: { source: 'synthetic-example' } });
      await client.flush();
      stats = client.getStats();
      statusKey = stats.sent === 1 ? 'accepted' : 'failed';
    } catch {
      statusKey = 'invalid';
    } finally {
      client?.destroy();
      send.disabled = false;
      renderLanguage();
    }
  });
}
