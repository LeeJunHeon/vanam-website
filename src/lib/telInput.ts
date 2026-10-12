// 국제 전화번호 입력(intl-tel-input) 공통 초기화 모듈.
// 각 폼(문의·견적·주문)의 전화 입력에 국기 드롭다운 + 국가번호 선택 + 자동 포맷을 붙인다.
// utils 포함 번들(intlTelInputWithUtils)을 써서 별도 utils 로드가 필요 없다.
//
// 10-12 정리(운영 점검에서 나온 것):
//   · 제출값을 국제표준(E.164)으로 바꾸는 것은 **번호 규칙으로 확인된 경우에만** 한다.
//     예전에는 무조건 getNumber() 로 바꿔서, 영문 페이지에서 국가를 안 바꾼 미국 번호가 +82 번호로
//     저장되거나(2015550123 → +822015550123), 내선(ext. 123)이 사라지거나, 0082 로 시작한 번호가 망가졌다.
//     확인되지 않는 번호는 고객이 쓴 그대로 보낸다(담당자가 읽고 연락할 수 있다).
//   · 입력칸 값을 직접 바꾸지 않는다 — 제출 데이터에만 반영한다(telValues).
//     예전에는 [견적 요청서 다운로드]만 눌러도 칸의 번호가 +8210… 으로 바뀌어 보였다.
//   · 국가 기본값: 한국어 페이지 = 한국, 영문 페이지 = 브라우저 언어의 지역(없으면 미국).
//   · 국가 선택창 한국어: 라이브러리의 ko 번역(국가명 전체 + 검색창 문구)을 쓴다.
import intlTelInput from 'intl-tel-input/intlTelInputWithUtils';
import koI18n from 'intl-tel-input/i18n/ko';
import 'intl-tel-input/build/css/intlTelInput.css';

type Iti = ReturnType<typeof intlTelInput>;

// 초기화한 인스턴스를 input 별로 보관(제출 시 국제번호를 뽑기 위해)
const registry = new WeakMap<HTMLInputElement, Iti>();

/** 영문 페이지의 처음 국가 — 브라우저 언어 목록의 지역(en-US → us). 라이브러리가 아는 국가만. */
function guessCountry(): string {
  try {
    const known = new Set(intlTelInput.getCountryData().map((c) => c.iso2));
    const langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]) ?? [];
    for (const l of langs) {
      const region = String(l ?? '').split(/[-_]/)[1]?.toLowerCase();
      if (region && region.length === 2 && known.has(region as never)) return region;
    }
  } catch { /* 무시 — 아래 기본값 */ }
  return 'us';
}

/**
 * 전화 input 하나에 intl-tel-input 을 적용한다.
 * @param input 대상 <input type="tel">
 * @param locale 'ko' | 'en' — 국가 선택 UI 언어 · 처음 국가
 */
export function initTelInput(input: HTMLInputElement, locale: string): Iti {
  const ko = String(locale).startsWith('ko');
  const iti = intlTelInput(input, {
    // 처음 국가: 한국어 페이지는 한국, 영문 페이지는 브라우저 언어의 지역(방문자 IP 조회는 외부 요청이라 쓰지 않는다)
    initialCountry: ko ? 'kr' : guessCountry(),
    // 한국을 최상단에 두고, 자주 쓰는 국가를 위로
    countryOrder: ['kr', 'us', 'jp', 'cn', 'gb', 'de'],
    // 국가번호(+82)를 입력칸 옆에 항상 표시 → 사용자는 번호만 입력(국가는 국기 메뉴에서 고른다)
    separateDialCode: true,
    numberDisplayFormat: 'NATIONAL',
    // 입력 중 국가 형식으로 자동 포맷(하이픈·공백) — 표시 전용. 제출값은 telValues 가 정한다.
    formatAsYouType: true,
    // 번호 판정은 유선·휴대폰 모두(라이브러리 기본은 휴대폰만이라 유선번호가 국가번호 없이 저장됐다)
    validationNumberTypes: null,
    // 국가 선택 UI 언어(영/한) — 한국어는 라이브러리 번역(국가명 전체·검색창 문구)
    i18n: ko ? koI18n : undefined,
  });
  registry.set(input, iti);
  return iti;
}

/**
 * 전화 input 하나의 제출값.
 *   번호 규칙으로 확인되면 국제표준(+821012345678, 내선이 있으면 ' ext. 123'), 아니면 고객이 쓴 그대로.
 */
export function telValue(input: HTMLInputElement): string {
  const raw = input.value.trim();
  if (!raw) return '';
  const iti = registry.get(input);
  if (!iti) return raw;
  try {
    if (iti.isValidNumber()) {
      const e164 = iti.getNumber();
      if (e164) {
        const ext = iti.getExtension?.() ?? '';
        return ext ? `${e164} ext. ${ext}` : e164;
      }
    }
  } catch { /* 판정 불가 — 그대로 보낸다 */ }
  return raw;
}

/**
 * 제출 데이터의 전화 항목을 제출값으로 바꾼다(입력칸은 건드리지 않는다).
 * @param root 폼(또는 그 조상) — 안의 input[type=tel][name] 이 대상
 * @param data FormData 로 만든 제출 데이터
 */
export function applyTelValues(root: ParentNode, data: Record<string, unknown>): void {
  root.querySelectorAll<HTMLInputElement>('input[type="tel"][name]').forEach((input) => {
    if (input.name in data) data[input.name] = telValue(input);
  });
}
