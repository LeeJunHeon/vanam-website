-- VANAM 주문·견적 데이터베이스 (Cloudflare D1 / SQLite)
-- 금액은 모두 원(KRW) 정수. 부가세 포함가.

-- ── 문의 · 견적 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inquiries (
  id            TEXT PRIMARY KEY,              -- INQ-20260713-A1B2
  type          TEXT NOT NULL,                 -- general | quote
  status        TEXT NOT NULL DEFAULT 'new',   -- new | quoted | replied | closed
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  company       TEXT,
  message       TEXT,                          -- 일반 문의 내용
  product_sku   TEXT,                          -- 견적: 대상 상품
  product_name  TEXT,
  material      TEXT,
  method        TEXT,
  substrate     TEXT,
  thickness     TEXT,
  quantity      TEXT,
  deadline      TEXT,
  details       TEXT,
  quoted_amount INTEGER,                       -- 관리자가 책정한 견적 금액
  quote_note    TEXT,                          -- 견적 메모 (고객에게 보낼 설명)
  locale        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

-- ── 주문 ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,              -- ORD-20260713-A1B2
  status        TEXT NOT NULL DEFAULT 'pending',
                -- pending(결제대기) | paid(결제완료) | preparing(제작중)
                -- | shipped(발송) | done(완료) | cancelled(취소) | refunded(환불)
  amount        INTEGER NOT NULL,              -- 총 결제 금액 (서버 재계산)
  currency      TEXT NOT NULL DEFAULT 'KRW',

  buyer_name    TEXT NOT NULL,
  buyer_email   TEXT NOT NULL,
  buyer_phone   TEXT,
  buyer_company TEXT,

  ship_name     TEXT,
  ship_phone    TEXT,
  ship_zip      TEXT,
  ship_addr1    TEXT,
  ship_addr2    TEXT,
  ship_memo     TEXT,

  tax_invoice   INTEGER NOT NULL DEFAULT 0,    -- 세금계산서 요청(0/1)
  tax_biz_no    TEXT,                          -- 사업자등록번호
  tax_biz_name  TEXT,                          -- 상호
  tax_ceo       TEXT,                          -- 대표자
  tax_email     TEXT,                          -- 계산서 수신 이메일

  inquiry_id    TEXT,                          -- 견적에서 이어진 주문이면 연결
  agreed_terms  INTEGER NOT NULL DEFAULT 0,    -- 청약철회 제한 고지 동의(0/1)

  payment_key   TEXT,                          -- 토스 paymentKey
  payment_method TEXT,
  paid_at       TEXT,

  locale        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

-- ── 주문 항목 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL,
  sku         TEXT NOT NULL,
  name        TEXT NOT NULL,
  unit_price  INTEGER NOT NULL,                -- 주문 시점 단가 (스냅샷)
  qty         INTEGER NOT NULL,
  subtotal    INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inq_created   ON inquiries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inq_status    ON inquiries(status);
CREATE INDEX IF NOT EXISTS idx_ord_created   ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ord_status    ON orders(status);
CREATE INDEX IF NOT EXISTS idx_items_order   ON order_items(order_id);
