// 서류(견적서 · 견적 요청서 · 주문서) — 브라우저 쪽 얇은 래퍼.
//
// HTML 조립은 순수 모듈 doc-excel.js 가 한다(엑셀 「견적서」 탭과 같은 틀 하나 — node 테스트가 가짜 회사 정보로 확인한다).
// 여기서는 ① company.json · 서류용 로고를 넣어 부르고 ② 새 창에 띄운다.
//
// 규칙:
//   - **자동 인쇄하지 않는다.** 창 안의 버튼을 눌러야 인쇄창이 뜬다(내용을 먼저 확인할 수 있어야 한다).
//   - 직인 이미지는 넣지 않는다. 대표자 옆에 "(인)" 글자만 둔다.
//   - 로고는 흰 종이용(진한 글자) src/assets/brand/logo-light.png. public/logo.png 는 어두운 바탕용 흰 글자라 종이에서 안 보인다.
import company from '../data/company.json';
import docLogo from '../assets/brand/logo-light.png';
import { buildQuoteHtml, buildRequestHtml, buildOrderHtml, fitCells, telKr } from './doc-excel.js';

export { money, telKr, koreanAmount, ymdLocal, quoteFromAmount, requestDocFrom, orderDocFrom, specFromDetails, customerLine } from './doc-excel.js';

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
  /** 품목 줄(입력 순서 그대로). 넣은 줄만 그린다 — 빈 줄(null)은 건너뛰고, 빈 줄로 채우지 않는다. */
  items: (QuoteDocItem | null)[];
  supply: number;
  vat: number;
  total: number;
  totalKorean: string;
  /** 'ko'(기본) | 'en' — 영문 견적서(같은 배치, 라벨만 영문) */
  lang?: 'ko' | 'en';
  /** 견적번호 줄 오른쪽 굵은 글자(예: 예상 견적 · 확정 전) — 확정 견적은 비운다 */
  stamp?: string;
  /** 품목표 아래 작은 안내 */
  note?: string;
  /** 안내 위 참고 줄(예: USD 환산) */
  fxNote?: string;
  /** 'USD' 면 금액을 $ 로(한글 금액 없음). 기본 원화 */
  currency?: string;
};

/** 서류 로고 절대 주소 — 새 창(about:blank)에서도 깨지지 않게 */
const logoUrl = (): string => new URL(typeof docLogo === 'string' ? docLogo : docLogo.src, location.href).href;

/** 공급자 연락처 — 한글 서류는 국내 표기(02-…), 영문은 국제 표기(+82-…) */
export const docContact = (lang: 'ko' | 'en'): string => (lang === 'en' ? String(company.tel ?? '') : telKr(company.tel));

/** 견적서 HTML. 창을 여는 것은 openDoc 몫이다. */
export function buildQuoteDoc(o: QuoteDocInput): string {
  return buildQuoteHtml({ ...o, logoUrl: logoUrl() }, company as Record<string, unknown>);
}

/** 견적 요청서 HTML — o 는 requestDocFrom(...) 결과 */
export function buildRequestDoc(o: Record<string, unknown>): string {
  return buildRequestHtml({ ...o, logoUrl: logoUrl() });
}

/** 주문서 HTML — o 는 orderDocFrom(...) 결과 */
export function buildOrderDoc(o: Record<string, unknown>): string {
  return buildOrderHtml({ ...o, logoUrl: logoUrl() }, company as Record<string, unknown>);
}

/** 새 창에 띄운다. 팝업이 막히면 false — 호출부가 안내한다. */
export function openDoc(html: string): boolean {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  // 자동 인쇄하지 않는다 — 내용을 먼저 보고 창 안의 버튼으로 인쇄·PDF 저장한다.
  w.document.getElementById('vn-doc-print')?.addEventListener('click', () => w.print());
  w.document.getElementById('vn-doc-close')?.addEventListener('click', () => w.close());
  // 칸 맞춤(넘치는 칸 글자 줄이기) — 지금 한 번, 글꼴이 늦게 잡히면 한 번 더
  const fit = () => { try { fitCells(w.document); } catch { /* 맞춤 실패해도 문서는 그대로 보인다 */ } };
  fit();
  w.document.fonts?.ready.then(fit).catch(() => {});
  return true;
}
