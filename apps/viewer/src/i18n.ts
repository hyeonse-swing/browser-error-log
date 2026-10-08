import { EVENT_LABELS, type EventType } from 'browser-error-log-protocol';
import type { Locale } from '../../i18n/locale';

const korean: Record<string, string> = {
  'BROWSER / LOG': '브라우저 / 오류 기록', WORKSPACE: '작업 공간', 'ERROR LOG': '오류 기록',
  MONITORING: '모니터링', OVERVIEW: '개요', EVENTS: '이벤트', 'EVENT STREAM': '이벤트 흐름',
  '01 / TIMELINE': '01 / 타임라인', '02 / INSPECTOR': '02 / 상세', '— END OF LOG': '— 기록 끝',
  'EVENT DETAIL': '이벤트 상세', 'ERROR MONITORING / OVERVIEW': '오류 모니터링 / 개요',
  '01 / TREND': '01 / 추이', '02 / TYPES': '02 / 유형', '03 / PROJECTS': '03 / 프로젝트',
  '04 / ENVIRONMENTS': '04 / 환경', '05 / RELEASES': '05 / 릴리스', '06 / PAGES': '06 / 페이지',
  '07 / RUNTIMES': '07 / 런타임', '08 / HTTP STATUS': '08 / HTTP 상태', '09 / TOP ERRORS': '09 / 주요 오류',
  'Queried at': '조회 완료', 'Error type distribution, total': '오류 유형별 분포, 총',
  'Local API': '로컬 API', 'Connected API': '연결된 API',
  'Could not load data.': '데이터를 불러오지 못했습니다.',
  'Loading was canceled. Run the query to start again.': '불러오기를 취소했습니다. 조회를 눌러 다시 시작하세요.',
  'Could not verify the history page limit.': '이력 페이지 제한을 확인할 수 없습니다.',
  'History filter has an invalid date.': '이력 필터의 날짜가 유효하지 않습니다.',
  'Event occurrence time is invalid.': '이벤트의 발생 시각이 유효하지 않습니다.',
  'Start date cannot be later than end date.': '시작 날짜는 종료 날짜보다 늦을 수 없습니다.',
  'Browser Error Log': '브라우저 오류 기록', 'Last 24 hours': '최근 24시간', 'Last 7 days': '최근 7일',
  'Last 30 days': '최근 30일', 'All time': '전체 기간', 'Custom range': '직접 지정',
  'An unknown error occurred.': '알 수 없는 오류가 발생했습니다.', 'Refresh failed · showing previous results:': '새로고침 실패 · 이전 결과 표시 중:',
  'This event could not be found.': '이 기록을 찾을 수 없습니다.', 'Could not load older events:': '이전 기록을 더 불러오지 못했습니다:',
  Copied: '복사됨', 'Copy failed': '복사 실패', 'Monitoring navigation': '모니터링 메뉴',
  'Error Dashboard': '오류 대시보드', 'Event Timeline': '이벤트 타임라인', 'Test Tools': '검증 도구',
  'Trigger Errors': '오류 재현', 'Trigger errors in the browser and inspect the capture flow.': '브라우저에서 오류를 만들고 수집 흐름을 확인합니다.',
  'Local Test': '로컬 검증', 'Connected Data Source': '연결된 데이터 소스', 'Select view': '보기 선택', Dashboard: '대시보드',
  'Explore captured browser errors in chronological order.': '브라우저에서 수집된 오류를 시간순으로 살펴보세요.',
  'Auto-refresh': '자동 새로고침', Refresh: '새로고침', 'Stored in memory; cleared on restart': '메모리 저장, 재시작 시 초기화',
  'Event filters': '이벤트 필터', Project: '프로젝트', Environment: '환경', Type: '유형', 'Time range': '기간', Search: '검색',
  'All projects': '전체 프로젝트', 'All environments': '전체 환경', 'All types': '모든 유형',
  'Search message, page, or ID': '메시지, 페이지, ID 검색', 'Event list': '이벤트 목록', 'Occurred / type': '발생 시각 / 유형',
  Event: '이벤트', 'Project / environment': '프로젝트 / 환경', 'Loading events': '기록을 불러오는 중입니다',
  'Could not load events': '기록을 불러오지 못했습니다', Retry: '다시 시도',
  'No events match your filters': '조건에 맞는 기록이 없습니다', 'Change the filters or trigger an error.': '필터를 바꾸거나 오류를 재현해 보세요.',
  'Clear filters': '필터 초기화', 'Loading…': '불러오는 중…', 'Load older events': '이전 기록 더 보기',
  'You reached the last event': '마지막 기록입니다', 'Event details': '이벤트 상세', 'Copy event JSON': '이벤트 JSON 복사',
  'Copy JSON': 'JSON 복사', 'Back to list': '목록으로', 'Select an event': '기록을 선택하세요',
  'Select an event from the list to': '목록에서 이벤트를 선택하면', 'see its details here.': '여기에 상세 정보가 표시됩니다.',
  'Could not load event details': '상세 정보를 불러오지 못했습니다', 'Loading event details': '상세 정보를 불러오는 중입니다',
  'Could not refresh event details:': '최신 상세 정보를 확인하지 못했습니다:', 'Occurrence details': '발생 정보',
  'Occurred at': '발생 시각', 'Received at': '수신 시각', Release: '릴리스', Runtime: '런타임', Browser: '브라우저',
  'Location and identifiers': '위치 및 식별자', Page: '페이지', 'Event ID': '이벤트 ID', 'View ID': '뷰 ID',
  'Elapsed time': '경과 시간', Network: '네트워크', 'HTTP status': '응답 코드', 'No response': '응답 없음',
  Duration: '소요 시간', 'Stack trace': '스택 트레이스', 'Component stack': '컴포넌트 스택',
  'Additional context': '추가 정보', 'Times are shown in your browser’s local time.': '시간은 현재 브라우저의 현지 시간으로 표시됩니다.',
  'Representative error event': '대표 오류 기록', 'Close details': '상세 닫기', 'Close ×': '닫기 ×',
  'No record': '기록 없음', Unspecified: '미지정', 'Release / Runtime': '릴리스 / 런타임', Response: '응답', None: '없음',
  'See when, where, and which errors increased.': '언제, 어디에서, 어떤 오류가 늘었는지 확인하세요.',
  'Historical data JSON file': '과거 데이터 JSON 파일', 'Import JSON': 'JSON 불러오기', 'Save query data ↓': '조회 데이터 저장 ↓',
  'JSON FILE': 'JSON 파일', 'API SOURCE': 'API 데이터', 'Local test data · cleared on restart': '로컬 검증용 데이터 · 재시작 시 초기화',
  'Connected service data': '연결된 서비스 데이터', 'Return to API': 'API로 돌아가기', 'Error types': '오류 유형',
  'Query period': '조회 기간', 'Message, page, release': '메시지, 페이지, 릴리스', 'Start time': '시작 시각',
  'End time': '종료 시각', 'Filters changed. Run the query to apply them.': '필터를 변경했습니다. 조회를 눌러 적용하세요.',
  'This file is analyzed in your browser and is not sent to the server.': '파일은 이 브라우저에서만 분석하며 서버로 전송하지 않습니다.',
  'Load stored events for the selected period.': '선택한 기간의 보관된 기록을 불러옵니다.', 'Run again': '다시 조회', Query: '조회',
  'Query status': '조회 안내', Cancel: '취소', 'No occurrence time to show': '표시할 발생 시각이 없습니다',
  'Only some events were included': '일부 기록만 집계했습니다', 'This export contains only some events.': '이 파일은 일부 기록만 포함한 내보내기 자료입니다.',
  'The charts use the events retrieved. Narrow the time range or project and run the query again.': '아래 그래프는 조회된 기록 기준입니다. 기간·프로젝트를 좁혀 다시 조회하세요.',
  'No errors match the selected filters': '선택한 조건에 오류 기록이 없습니다',
  'Change the time range or filters, or import historical JSON.': '기간이나 필터를 변경하거나 과거 JSON 파일을 불러오세요.',
  'These counts exclude duplicate errors. Total requests and visitors are not collected, so they do not represent error rates or affected users.': '집계 기준은 중복을 제외한 오류 기록입니다. 전체 요청·방문자 수를 수집하지 않아 오류율이나 영향 사용자 수를 뜻하지 않습니다.',
  'How to load historical data': '과거 데이터를 불러오는 방법',
  'The API queries by occurrence time. A connected server must provide persistent storage and history. The development demo keeps up to 2,000 events in memory and clears them on restart.': 'API는 발생 시각으로 기간을 조회합니다. 연결된 서버가 영구 저장과 과거 기록을 제공해야 합니다. 개발 데모는 메모리에 최대 2,000건을 보관하며 재시작하면 초기화됩니다.',
  'Import a file saved from this page, a v1 event array, or a JSON object in the': '이 화면에서 저장한 파일, v1 이벤트 배열 또는',
  'format. The limit is 10 MiB and 10,000 events. Refreshing clears file analysis; import the file again to restore it.': '형식의 JSON 객체를 불러올 수 있습니다. 한도는 10 MiB와 10,000건입니다. 새로고침하면 파일 분석 결과가 사라지므로 다시 불러오세요.',
  'Download sample history JSON ↓': '과거 데이터 예제 JSON 받기 ↓', 'Error trend': '오류 발생 추이',
  'No errors to show over time.': '표시할 시간별 오류 기록이 없습니다.', 'No events': '발생 기록 없음',
  'Hover over a bar or use the keyboard to see counts by interval.': '막대에 마우스를 올리거나 키보드로 이동하면 구간별 건수를 볼 수 있습니다.',
  'Counts by time interval': '시간별 건수 표', 'Time interval': '시간 구간', Total: '전체',
  'No events in this period.': '해당 기간에 기록이 없습니다.', 'No errors in this period.': '해당 기간에 오류 기록이 없습니다.',
  'Captured error': '수집된 오류', 'Captured errors': '수집된 오류',
  'Unique error message': '오류 메시지 종류', 'Unique error messages': '오류 메시지 종류',
  'Network error': '네트워크 관련 오류', 'Network errors': '네트워크 관련 오류', Projects: '프로젝트',
  'Events in the selected period': '선택한 기간의 이벤트', 'By project, type, and message': '프로젝트·유형·메시지 기준',
  'HTTP errors + connection failures': 'HTTP 오류 + 연결 실패', 'Projects with events': '기록이 있는 프로젝트',
  'Captured event summary': '수집 이벤트 요약', 'By project': '프로젝트별', 'By environment': '환경별',
  'By release': '릴리스별', 'By page': '페이지별', 'By runtime': '런타임별',
  'HTTP status codes': 'HTTP 응답 코드', 'No HTTP errors with a status code.': '응답 코드가 있는 HTTP 오류 기록이 없습니다.',
  'Top errors': '자주 발생한 오류', 'Grouped by project, type, and message · up to 8': '프로젝트·유형·메시지별 묶음 · 최대 8개',
  'View details': '상세 보기', 'Last occurred': '마지막 발생',
};

export function t(locale: Locale, english: string): string {
  return locale === 'ko' ? korean[english] ?? english : english;
}

const koreanTypes: Record<EventType, string> = {
  javascript: 'JavaScript 오류', promise: 'Promise 오류', react: 'React 오류', console: '콘솔 오류',
  http: 'HTTP 오류', network: '네트워크 실패', manual: '직접 기록',
};

export function eventLabel(locale: Locale, type: EventType): string {
  return locale === 'ko' ? koreanTypes[type] : EVENT_LABELS[type];
}

export function numberText(locale: Locale, value: number): string {
  return value.toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US');
}

export function countText(locale: Locale, count: number, englishSingular: string, englishPlural: string, koreanUnit = '건'): string {
  return locale === 'ko' ? `${numberText(locale, count)}${koreanUnit}` : `${numberText(locale, count)} ${count === 1 ? englishSingular : englishPlural}`;
}

export function localizeError(locale: Locale, message: string): string {
  if (locale !== 'ko') return message;
  const replacements: [RegExp, string][] = [
    [/Refresh failed · showing previous results:/g, '새로고침 실패 · 이전 조회 결과 표시 중:'],
    [/Could not load older events:/g, '이전 기록을 더 불러오지 못했습니다:'],
    [/An unknown error occurred\./g, '알 수 없는 오류가 발생했습니다.'],
    [/This event could not be found\./g, '이 기록을 찾을 수 없습니다.'],
    [/Could not load data\./g, '데이터를 불러오지 못했습니다.'],
    [/Loading was canceled\. Run the query to start again\./g, '불러오기를 취소했습니다. 조회를 눌러 다시 시작하세요.'],
    [/Check the start and end times\. The start cannot be later than the end\./g, '시작·종료 시각을 확인하세요. 시작은 종료보다 늦을 수 없습니다.'],
    [/JSON files must be 10 MiB or smaller\. Import a shorter time range\./g, 'JSON 파일은 10 MiB 이하여야 합니다. 기간을 나누어 불러오세요.'],
    [/Request failed\. \(HTTP (\d+)\)/g, '요청에 실패했습니다. (HTTP $1)'],
    [/Import files cannot exceed 10 MiB\./g, '가져오기 파일은 10 MiB를 넘을 수 없습니다.'],
    [/This is not a valid JSON file\./g, '유효한 JSON 파일이 아닙니다.'],
    [/Unsupported history file version\. schemaVersion 1 is required\./g, '지원하지 않는 이력 파일 버전입니다. schemaVersion 1이 필요합니다.'],
    [/Import file has no events array\./g, '가져오기 파일에 events 배열이 없습니다.'],
    [/You can import up to ([\d,]+) events\./g, '이벤트는 최대 $1건까지 가져올 수 있습니다.'],
    [/History (\d+) page is empty but returned a next cursor\./g, '이력 $1페이지가 비어 있지만 다음 커서를 반환했습니다.'],
    [/History (\d+) page repeated a cursor\./g, '이력 $1페이지에서 커서가 반복되었습니다.'],
    [/History (\d+) page has an invalid event list\./g, '이력 $1페이지의 이벤트 목록이 유효하지 않습니다.'],
    [/History (\d+) page has an invalid next cursor\./g, '이력 $1페이지의 다음 커서가 유효하지 않습니다.'],
    [/Could not verify the history page limit\./g, '이력 페이지 제한을 확인할 수 없습니다.'],
    [/Import file\.partial must be a boolean\./g, '가져오기 파일의 partial은 불리언이어야 합니다.'],
    [/History filter has an invalid date\./g, '이력 필터의 날짜가 유효하지 않습니다.'],
    [/Event occurrence time is invalid\./g, '이벤트의 발생 시각이 유효하지 않습니다.'],
    [/Start date cannot be later than end date\./g, '시작 날짜는 종료 날짜보다 늦을 수 없습니다.'],
    [/Start date is invalid\./g, '시작 날짜가 유효하지 않습니다.'],
    [/End date is invalid\./g, '종료 날짜가 유효하지 않습니다.'],
    [/History (\d+) event (\d+)/g, '이력 $1페이지 이벤트 $2'],
    [/History page (\d+)/g, '이력 $1페이지'],
    [/Imported event/g, '가져오기 이벤트'],
    [/Exported event/g, '내보내기 이벤트'],
    [/Import file/g, '가져오기 파일'],
    [/\.schemaVersion must be 1\./g, '.schemaVersion은 1이어야 합니다.'],
    [/\.type is invalid\./g, '.type이 유효하지 않습니다.'],
    [/\.runtime is invalid\./g, '.runtime이 유효하지 않습니다.'],
    [/\.sequence must be a non-negative integer\./g, '.sequence는 0 이상의 정수여야 합니다.'],
    [/\.elapsedMs must be non-negative\./g, '.elapsedMs는 0 이상이어야 합니다.'],
    [/\.network\.durationMs must be non-negative\./g, '.network.durationMs는 0 이상이어야 합니다.'],
    [/\.network\.status must be an integer from 0 to 599\./g, '.network.status는 0부터 599까지의 정수여야 합니다.'],
    [/ must be an object\./g, '은(는) 객체여야 합니다.'],
    [/ must be a non-empty string\./g, '은(는) 비어 있지 않은 문자열이어야 합니다.'],
    [/ must be a string\./g, '은(는) 문자열이어야 합니다.'],
    [/ must be a finite number\./g, '은(는) 유한한 숫자여야 합니다.'],
    [/ must be an ISO date with a timezone\./g, '은(는) 시간대가 포함된 ISO 날짜여야 합니다.'],
    [/ must be a string, finite number, boolean, or null\./g, '은(는) 문자열, 유한한 숫자, 불리언 또는 null이어야 합니다.'],
    [/ has an invalid date or timezone\./g, '의 날짜 또는 시간대가 유효하지 않습니다.'],
    [/ has an invalid date\./g, '의 날짜가 유효하지 않습니다.'],
  ];
  return t(locale, replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), message));
}
