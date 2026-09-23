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

-- ── 견적 가격 DB (price_*) ─────────────────────────────
-- 구글 시트 견적 파일(V3_SHEET_*)의 DB 시트를 그대로 옮긴 원본 테이블.
-- scripts/price-db-import.mjs 가 엑셀에서 SQL 을 생성해 DELETE→INSERT 로 통째 갱신한다.
--
-- ⚠️ 빈 셀은 NULL 이다. 엑셀에서 '비움'과 0 은 뜻이 다르다
--    (loading_override_min 비움 = 장비 기본값, 0 = 0분 적용).
--    따라서 어떤 열에도 NOT NULL / DEFAULT 를 붙이지 않는다.
-- ⚠️ 숫자 열은 REAL. material_cost_per_nm 에 소수가 들어오고, INTEGER 면 원가가 어긋난다.

-- 가격 정책 (V3_가격정책). 값은 문자열로 보관하고 vtype 이 해석 방법을 알려준다.
CREATE TABLE IF NOT EXISTS price_policy (
  key         TEXT PRIMARY KEY,               -- policy_key
  value       TEXT,                           -- 원문 문자열 (숫자·불리언도 문자열로)
  vtype       TEXT,                           -- number | string | boolean
  applies_to  TEXT,
  notes       TEXT
);

-- 장비 (V3_장비DB)
CREATE TABLE IF NOT EXISTS price_equipment (
  equipment_id        TEXT PRIMARY KEY,
  equipment_name      TEXT,
  process_type        TEXT,                    -- Sputter | ALD …
  rate_per_min        REAL,                    -- 장비요율 원/min
  default_loading_min REAL,
  default_plasma_min  REAL,
  default_setup_min   REAL,
  active              INTEGER,                 -- 0/1
  notes               TEXT
);

-- 레시피 (V3_레시피DB)
CREATE TABLE IF NOT EXISTS price_recipe (
  recipe_id            TEXT PRIMARY KEY,
  material_name        TEXT,
  process_type         TEXT,
  equipment_id         TEXT,
  method               TEXT,                   -- DC Power | RF Power | Ozone …
  material_cost_per_nm REAL,
  growth_nm_per_min    REAL,
  default_temp_c       REAL,
  loading_override_min REAL,                   -- 비움이면 장비 기본값
  plasma_override_min  REAL,
  setup_override_min   REAL,
  legacy_min_charge    REAL,                   -- 옛 최소청구액 (현재 정책은 미적용)
  active               INTEGER,                -- 0/1
  verification_status  TEXT,
  supplier             TEXT,
  notes                TEXT
);

-- 상품 기판 (V3_상품기판DB)
CREATE TABLE IF NOT EXISTS price_substrate (
  catalog_id          TEXT PRIMARY KEY,
  item_name           TEXT,
  category            TEXT,
  unit                TEXT,
  cost_per_unit       REAL,                    -- 낱장 원가 (박막 원가에 포함)
  sale_price_per_unit REAL,
  units_per_pack      REAL,
  legacy_pack_price   REAL,
  size_inch           REAL,
  oxide_nm            REAL,
  supplier            TEXT,
  active              INTEGER,                 -- 0/1
  verification_status TEXT,
  notes               TEXT
);

-- 별칭 (V3_별칭DB). 같은 alias 가 장비 범위별로 여러 줄 있을 수 있어 PK 는 대리키.
CREATE TABLE IF NOT EXISTS price_alias (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type     TEXT,                        -- EQUIPMENT | RECIPE | UNIT
  alias           TEXT,
  equipment_scope TEXT,                        -- 같은 alias 를 장비별로 구분할 때
  canonical_id    TEXT,
  status          TEXT,
  notes           TEXT
);

-- 가져오기 이력. 어느 파일(해시)로 언제 어떤 규칙 버전을 넣었는지 남긴다.
CREATE TABLE IF NOT EXISTS price_import_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  imported_at   TEXT,
  source_file   TEXT,
  source_sha256 TEXT,
  rules_version TEXT,
  counts_json   TEXT
);
