// 국제 전화번호 입력(intl-tel-input) 공통 초기화 모듈.
// 각 폼(문의·견적·주문)의 전화 입력에 국기 드롭다운 + 국가번호 선택 + 자동 포맷을 붙인다.
// utils 포함 번들(intlTelInputWithUtils)을 써서 별도 utils 로드가 필요 없다.
import intlTelInput from 'intl-tel-input/intlTelInputWithUtils';
import 'intl-tel-input/build/css/intlTelInput.css';

type Iti = ReturnType<typeof intlTelInput>;

// 초기화한 인스턴스를 input 별로 보관(제출 시 국제번호를 뽑기 위해)
const registry = new WeakMap<HTMLInputElement, Iti>();

/**
 * 전화 input 하나에 intl-tel-input 을 적용한다.
 * @param input 대상 <input type="tel">
 * @param locale 'ko' | 'en' — 국가 선택 UI 언어
 */
export function initTelInput(input: HTMLInputElement, locale: string): Iti {
  const iti = intlTelInput(input, {
    // 기본 국가: 한국. (방문자 IP 자동감지는 외부 요청이 필요해 끄고, 명시적으로 한국 고정)
    initialCountry: 'kr',
    // 한국을 최상단에 두고, 자주 쓰는 국가를 위로
    countryOrder: ['kr', 'us', 'jp', 'cn', 'gb', 'de'],
    // 국가번호(+82)를 입력칸 옆에 항상 표시 → 사용자는 번호만 입력
    separateDialCode: true,
    // 제출값은 항상 국제표준(E.164, 예: +821012345678)으로 관리
    numberDisplayFormat: 'NATIONAL',
    // 국가 선택 UI 언어(영/한)
    i18n: locale === 'ko' ? koLocale : undefined,
  });
  registry.set(input, iti);
  return iti;
}

/**
 * 폼 제출 직전 호출: 각 전화 input 의 화면 표시값을 국제표준 번호(+82...)로 바꿔서
 * FormData 가 올바른 값을 전송하게 한다. 값이 비어있으면 건드리지 않는다.
 */
export function normalizeTelInputs(root: ParentNode = document): void {
  root.querySelectorAll<HTMLInputElement>('input[type="tel"]').forEach((input) => {
    const iti = registry.get(input);
    if (!iti) return;
    const val = input.value.trim();
    if (!val) return; // 선택 항목이 비어있으면 그대로 둔다
    const intl = iti.getNumber(); // E.164 형식 (+821012345678)
    if (intl) input.value = intl;
  });
}

// 국가 선택 드롭다운의 한글 라벨(주요 국가만; 나머지는 라이브러리 기본 영문 사용)
const koLocale: Record<string, string> = {
  kr: '대한민국',
  us: '미국',
  jp: '일본',
  cn: '중국',
  gb: '영국',
  de: '독일',
  fr: '프랑스',
  tw: '대만',
  hk: '홍콩',
  sg: '싱가포르',
  ca: '캐나다',
  au: '호주',
};
