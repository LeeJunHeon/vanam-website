// 배송비 정책. Keystatic '사업자 정보'에서 국내/해외 각각 고른다.
// 문구는 여기서 관리하므로 국문/영문을 따로 입력할 필요가 없다.
export type ShipMode = 'free' | 'collect' | 'quote';

export const SHIP_LABEL: Record<ShipMode, { ko: string; en: string }> = {
  free: {
    ko: '무료 배송',
    en: 'Free shipping',
  },
  collect: {
    // 수령인이 자신의 택배사 계정(FedEx/DHL 등)으로 부담하는 방식.
    // 연구기관·기업 간 국제 거래에서 흔하다.
    ko: '수령인 착불 (수령인의 택배사 계정으로 청구)',
    en: 'Freight collect (billed to the recipient’s courier account)',
  },
  quote: {
    ko: '주문 확인 후 배송비를 별도 안내드립니다',
    en: 'Shipping is quoted separately after we review your order',
  },
};

export const shipLabel = (mode: string | undefined, locale: 'ko' | 'en'): string => {
  const m = (mode ?? 'free') as ShipMode;
  return (SHIP_LABEL[m] ?? SHIP_LABEL.free)[locale];
};

export const isCollect = (mode: string | undefined) => mode === 'collect';
