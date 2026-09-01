-- VANAM 주문·견적 데이터베이스 (Cloudflare D1 / SQLite)
-- 금액은 모두 원(KRW) 정수. 부가세 포함가.
--
-- ⚠️ 정합 규칙(0249): 이 파일의 테이블·컬럼 집합은 src/lib/db.ts 의
--    SCHEMA ∪ MIGRATIONS(런타임 스키마)와 항상 완전히 일치해야 한다.
--    scripts/check-schema.mjs 가 npm run verify 에서 이를 강제한다.

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
  details_json     TEXT,           -- 폼 원본 구조(JSON) — 완료/조회/견적서 재구성용 (0249)
  quoted_amount INTEGER,                       -- 관리자가 책정한 견적 금액
  quote_note    TEXT,                          -- 견적 메모 (고객에게 보낼 설명)
  quote_bank    TEXT,                          -- 회신용 입금 계좌 (0249)
  -- 결제 연동 (런타임 MIGRATIONS 와 동일 집합 — 0249 정합화)
  quote_currency    TEXT,
  paypal_order_id   TEXT,
  paypal_capture_id TEXT,
  paid_at       TEXT,
  paid_usd      REAL,
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

  needs_shipping INTEGER NOT NULL DEFAULT 1,   -- 실물 배송이 필요한 주문인가
  ship_name     TEXT,
  ship_phone    TEXT,
  ship_country  TEXT,                         -- ISO 2자리 (KR, US, DE …)
  ship_zip      TEXT,
  ship_addr1    TEXT,                         -- 주소 / Address line 1
  ship_addr2    TEXT,                         -- 상세 주소 / Address line 2
  ship_city     TEXT,                         -- 해외 전용 (국내는 주소에 포함)
  ship_state    TEXT,                         -- 해외 전용 (주/도)
  ship_memo     TEXT,
  ship_courier_acct TEXT,                     -- 착불 시 수령인의 택배사 계정 (FedEx/DHL 등)

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
  -- 운영·결제 확장 (런타임 MIGRATIONS 와 동일 집합 — 0249 정합화)
  desired_date  TEXT,
  order_note    TEXT,
  tracking_no   TEXT,
  tracking_courier TEXT,
  admin_memo    TEXT,
  pay_method    TEXT,
  amount_usd    REAL,
  paid_usd      REAL,
  paypal_order_id   TEXT,
  paypal_capture_id TEXT,
  chat_detail   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

-- ── 설정·캐시 (환율 등) ────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         REAL NOT NULL,
  updated_at    TEXT NOT NULL,
  source        TEXT
);

-- ── 레이트리밋 (버킷:IP 별 시도 횟수 — rate-limit.ts 가 UPSERT 로 원자 관리) ──
CREATE TABLE IF NOT EXISTS rate_limits (
  key           TEXT PRIMARY KEY,
  hits          INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
);

-- ── 주문 항목 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL,
  sku         TEXT NOT NULL,
  name        TEXT NOT NULL,
  unit_price  INTEGER NOT NULL,                -- 주문 시점 단가 (스냅샷)
  qty         INTEGER NOT NULL,
  subtotal    INTEGER NOT NULL,               -- (단가 + 다이싱 비용) × 수량
  -- 웨이퍼 다이싱 옵션 (런타임 MIGRATIONS 와 동일 집합 — 0829)
  dicing      INTEGER NOT NULL DEFAULT 0,     -- 다이싱을 골랐는가 (0/1)
  dicing_fee  INTEGER NOT NULL DEFAULT 0,     -- 주문 시점 박스당 다이싱 비용 (스냅샷)
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inq_created   ON inquiries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inq_status    ON inquiries(status);
CREATE INDEX IF NOT EXISTS idx_ord_created   ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ord_status    ON orders(status);
CREATE INDEX IF NOT EXISTS idx_items_order   ON order_items(order_id);
