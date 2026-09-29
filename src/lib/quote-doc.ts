// 관리자 견적 계산기(/admin/quote)의 견적서 미리보기 — 엑셀 '견적서' 탭 배치를 그대로 옮겼다.
//
// quote-sheet.ts(고객용 견적 요청서·견적서)와는 다른 문서다. 그쪽은 고객 화면 공용 틀이고,
// 이쪽은 사내에서 엑셀로 뽑던 견적서를 대신한다. 서로 건드리지 않는다.
//
// 규칙 (quote-sheet.ts 와 같음):
//   - **자동 인쇄하지 않는다.** 창 안의 버튼을 눌러야 인쇄창이 뜬다.
//   - 직인 이미지는 넣지 않는다. 대표자 옆에 "(인)" 글자만 둔다.
//   - A4 세로. 품목표는 엑셀처럼 15줄 고정 — 빈 줄도 칸을 유지한다.
import company from '../data/company.json';
import { buildQuoteDocHtml } from './quote-doc-core.js';

export type QuoteDocInfo = {
  customer: string;   // 고객(귀하)
  ref: string;        // 참조
  title: string;      // 견적명
  date: string;       // 견적일 YYYY-MM-DD
  quoteNo: string;    // 견적번호
  manager: string;    // 담당자
  contact: string;    // 연락처
  delivery: string;   // 납품기한
  validDays: string;  // 견적 유효 일수
  payment: string;    // 대금 지불방식
};

export type QuoteDocItem = {
  name: string;
  spec: string;
  qty: unknown;
  unit: unknown;
  unitPrice: number | null;
  supply: number | null;
  vat: number | null;
};

export type QuoteDocInput = {
  info: QuoteDocInfo;
  /** 품목 줄(입력 순서 그대로). 15줄보다 적으면 빈 줄로 채운다. */
  items: (QuoteDocItem | null)[];
  supply: number;
  vat: number;
  total: number;
  totalKorean: string;
  /** 로고 절대 주소 — 새 창(about:blank)에서도 깨지지 않게 호출부가 넘긴다 */
  logoUrl: string;
  /** 'ko'(기본) | 'en' — 영문 견적서(같은 배치, 라벨만 영문) */
  lang?: 'ko' | 'en';
  /** 제목 옆 표시(예: 예상 견적 · 확정 전) */
  stamp?: string;
  /** 하단 안내 문단 */
  note?: string;
  /** 합계 아래 참고 줄(예: USD 환산) */
  fxNote?: string;
};

// HTML 조립은 순수 모듈 quote-doc-core.js 가 한다(node 테스트가 가짜 회사 정보로 출력을 고정한다).
// 여기서는 company.json 을 넣어 부르는 얇은 래퍼만 둔다 — 기존 호출부(buildQuoteDoc·money·telKr)는 그대로.
export { money, telKr } from './quote-doc-core.js';

/** 견적서 HTML 을 만든다. 창을 여는 것은 호출부(openQuoteDoc) 몫이다. */
export function buildQuoteDoc(o: QuoteDocInput): string {
  return buildQuoteDocHtml(o, company as Record<string, unknown>);
}

/** 새 창에 띄운다. 팝업이 막히면 false — 호출부가 안내한다. */
export function openQuoteDoc(html: string): boolean {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  // 자동 인쇄하지 않는다 — 내용을 먼저 보고 창 안의 버튼으로 인쇄·PDF 저장한다.
  w.document.getElementById('vn-doc-print')?.addEventListener('click', () => w.print());
  w.document.getElementById('vn-doc-close')?.addEventListener('click', () => w.close());
  return true;
}
