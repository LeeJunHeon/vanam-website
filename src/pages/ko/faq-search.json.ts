// FAQ 검색 데이터(KO) — /ko/faq/ 색인 페이지의 검색이 읽는 정적 JSON. 빌드 때 src/data/faq.json 에서 만든다.
import { faqAll } from '../../lib/faq';

export const GET = () =>
  new Response(JSON.stringify(faqAll('ko').map(({ id, q, a }) => ({ id, q, a }))), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
