// D1 (주문·견적 DB) 접근 헬퍼.
//
// ⚠️ 환경별 차이
//  - 배포(Cloudflare workerd): env.DB 에 D1 바인딩이 있다.
//  - 로컬 dev(순수 Node):       env 가 빈 객체(shim)라 DB 가 없다.
//    → getDb()가 null 을 돌려주고, 호출부는 DB 없이도 동작해야 한다.
//      (문의 폼은 DB 없이도 구글챗 알림은 나가야 하므로)
import { env as cfEnv } from 'cloudflare:workers';
import { runSchemaInit, schemaVersionOf } from './schema-init.js';

export type D1 = {
  prepare: (sql: string) => {
    bind: (...v: unknown[]) => {
      run: () => Promise<unknown>;
      all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
      first: <T = Record<string, unknown>>() => Promise<T | null>;
    };
    run: () => Promise<unknown>;
    all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
    first: <T = Record<string, unknown>>() => Promise<T | null>;
  };
  batch: (stmts: unknown[]) => Promise<unknown>;
  exec: (sql: string) => Promise<unknown>;
};

export function getDb(): D1 | null {
  const db = (cfEnv as Record<string, unknown> | undefined)?.DB;
  return (db as D1) ?? null;
}

// ── 테이블 자동 생성 ────────────────────────────────────
// migrations/0001_init.sql 과 동일한 내용. 워커 인스턴스당 한 번만 실행된다.
// (수동 마이그레이션 없이도 첫 요청에서 스키마가 준비되도록)
// ⚠️ 무료 플랜은 요청당 D1 호출 50번이 한도다 — 스키마 버전 표식이 맞으면 D1 1번으로 끝낸다(schema-init.js).
//    아래 SCHEMA·MIGRATIONS 를 한 글자라도 바꾸면 버전이 바뀌어 다음 인스턴스가 전체 점검을 한 번 한다.
let schemaReady: Promise<void> | null = null;

const SCHEMA = [
  // 사이트 운영값 저장소(현재는 USD/KRW 환율 하나). key 단일 PK 라 UPSERT 로 안전하게 갱신된다.
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value REAL NOT NULL,
    updated_at TEXT NOT NULL,
    source TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS inquiries (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
    name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, company TEXT, message TEXT,
    product_sku TEXT, product_name TEXT, material TEXT, method TEXT, substrate TEXT,
    thickness TEXT, quantity TEXT, deadline TEXT, details TEXT, details_json TEXT,
    quoted_amount INTEGER, quote_note TEXT, quote_bank TEXT, locale TEXT,
    created_at TEXT NOT NULL, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
    amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'KRW',
    buyer_name TEXT NOT NULL, buyer_email TEXT NOT NULL, buyer_phone TEXT, buyer_company TEXT,
    ship_name TEXT, ship_phone TEXT, ship_zip TEXT, ship_addr1 TEXT, ship_addr2 TEXT, ship_memo TEXT,
    tax_invoice INTEGER NOT NULL DEFAULT 0, tax_biz_no TEXT, tax_biz_name TEXT, tax_ceo TEXT, tax_email TEXT,
    inquiry_id TEXT, agreed_terms INTEGER NOT NULL DEFAULT 0,
    payment_key TEXT, payment_method TEXT, paid_at TEXT, locale TEXT,
    created_at TEXT NOT NULL, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL,
    sku TEXT NOT NULL, name TEXT NOT NULL,
    unit_price INTEGER NOT NULL, qty INTEGER NOT NULL, subtotal INTEGER NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS idx_inq_created ON inquiries(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_inq_status ON inquiries(status)`,
  `CREATE INDEX IF NOT EXISTS idx_ord_created ON orders(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ord_status ON orders(status)`,
  `CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id)`,
  // 레이트리밋: (버킷:IP) 별 시도 횟수. rate-limit.ts 가 UPSERT 로 원자적 관리.
  //   key = "login:1.2.3.4" 등, window_start = 창 시작 시각(ms epoch)
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY, hits INTEGER NOT NULL, window_start INTEGER NOT NULL)`,

  // ── 견적 가격 DB (price_*) ────────────────────────────────────────────
  // 구글 시트 견적 파일(V3_SHEET_*)의 DB 시트를 그대로 옮긴 원본 테이블.
  // scripts/price-db-import.mjs 가 엑셀에서 생성해 DELETE→INSERT 로 통째 갱신한다.
  //
  // ⚠️ 두 가지 원칙
  //  ① 빈 셀은 NULL 로 넣는다. 엑셀에서 '비움'과 0 은 뜻이 다르다
  //     (예: loading_override_min 비움 = 장비 기본값 사용, 0 = 0분 적용).
  //     NOT NULL DEFAULT 0 을 붙이면 이 구분이 조용히 사라진다 → 어떤 열에도 붙이지 않는다.
  //  ② 숫자 열은 REAL 이다. material_cost_per_nm 처럼 소수가 들어오고,
  //     INTEGER 로 받으면 반올림되어 원가가 어긋난다.
  //
  // ⚠️ CREATE TABLE 문자열 안에 주석(--)을 쓰지 말 것.
  //    scripts/check-schema.mjs 는 db.ts 쪽 SQL 에서 주석을 제거하지 않아
  //    주석 뒤 컬럼을 못 읽고 init.sql 과 어긋난 것으로 오판한다.
  `CREATE TABLE IF NOT EXISTS price_policy (
    key TEXT PRIMARY KEY, value TEXT, vtype TEXT, applies_to TEXT, notes TEXT)`,
  `CREATE TABLE IF NOT EXISTS price_equipment (
    equipment_id TEXT PRIMARY KEY, equipment_name TEXT, process_type TEXT,
    rate_per_min REAL, default_loading_min REAL, default_plasma_min REAL, default_setup_min REAL,
    active INTEGER, notes TEXT)`,
  `CREATE TABLE IF NOT EXISTS price_recipe (
    recipe_id TEXT PRIMARY KEY, material_name TEXT, process_type TEXT, equipment_id TEXT, method TEXT,
    material_cost_per_nm REAL, growth_nm_per_min REAL, default_temp_c REAL,
    loading_override_min REAL, plasma_override_min REAL, setup_override_min REAL,
    legacy_min_charge REAL, active INTEGER, verification_status TEXT, supplier TEXT, notes TEXT)`,
  `CREATE TABLE IF NOT EXISTS price_substrate (
    catalog_id TEXT PRIMARY KEY, item_name TEXT, category TEXT, unit TEXT,
    cost_per_unit REAL, sale_price_per_unit REAL, units_per_pack REAL, legacy_pack_price REAL,
    size_inch REAL, oxide_nm REAL, supplier TEXT, active INTEGER, verification_status TEXT, notes TEXT)`,
  `CREATE TABLE IF NOT EXISTS price_alias (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT, alias TEXT, equipment_scope TEXT,
    canonical_id TEXT, status TEXT, notes TEXT)`,
  `CREATE TABLE IF NOT EXISTS price_import_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, imported_at TEXT, source_file TEXT, source_sha256 TEXT,
    rules_version TEXT, counts_json TEXT)`,

  // ── 견적 개정 (quote_revisions) ──────────────────────────────────────
  // 문의 한 건의 견적 이력. 접수 시 자동 계산(auto)과 담당자 저장(admin)이 개정 번호를 1,2,3… 올린다.
  // 고객에게 나가는 금액은 doc_json 이 유일한 원천이다(input_json·result_json 은 내부 전용 — 원가 포함).
  // 새 개정은 "기준 개정 + 1" 로 INSERT 한다 — 두 곳이 동시에 저장하면 UNIQUE 위반으로 한쪽이 실패(낙관적 잠금).
  // 컬럼 설명은 migrations/0001_init.sql 에 있다(여기 CREATE 문자열 안에는 주석을 넣지 않는다).
  `CREATE TABLE IF NOT EXISTS quote_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, inquiry_id TEXT NOT NULL, rev INTEGER NOT NULL,
    source TEXT NOT NULL, kind TEXT NOT NULL, total INTEGER,
    input_json TEXT, result_json TEXT, doc_json TEXT, manual_json TEXT,
    seen_total INTEGER, price_sha TEXT, note TEXT, created_at TEXT NOT NULL,
    UNIQUE (inquiry_id, rev))`,
  `CREATE INDEX IF NOT EXISTS idx_qrev_inq ON quote_revisions(inquiry_id, rev)`,
];

// 이미 만들어진 테이블에 컬럼을 덧붙일 때 쓴다.
// CREATE TABLE IF NOT EXISTS 는 기존 테이블을 바꾸지 않으므로 ALTER 가 필요하고,
// ALTER 는 컬럼이 이미 있으면 에러를 내므로 개별적으로 삼킨다. (D1엔 IF NOT EXISTS가 없다)
const MIGRATIONS = [
  `ALTER TABLE orders ADD COLUMN ship_country TEXT`,
  `ALTER TABLE orders ADD COLUMN ship_city TEXT`,
  `ALTER TABLE orders ADD COLUMN ship_state TEXT`,
  `ALTER TABLE orders ADD COLUMN needs_shipping INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE orders ADD COLUMN ship_courier_acct TEXT`,
  `ALTER TABLE orders ADD COLUMN tracking_no TEXT`,
  `ALTER TABLE orders ADD COLUMN tracking_courier TEXT`,
  `ALTER TABLE orders ADD COLUMN admin_memo TEXT`,
  // 결제·주문 컬럼: 코드가 쓰고 있으나 CREATE TABLE 에 없어 기존 DB 에서 누락되던 것들
  `ALTER TABLE orders ADD COLUMN desired_date TEXT`,
  `ALTER TABLE orders ADD COLUMN order_note TEXT`,
  `ALTER TABLE orders ADD COLUMN paid_usd REAL`,
  `ALTER TABLE orders ADD COLUMN paypal_order_id TEXT`,
  `ALTER TABLE orders ADD COLUMN amount_usd REAL`,
  `ALTER TABLE orders ADD COLUMN paypal_capture_id TEXT`,
  `ALTER TABLE orders ADD COLUMN chat_detail TEXT`,
  `ALTER TABLE orders ADD COLUMN pay_method TEXT`,
  `ALTER TABLE inquiries ADD COLUMN paypal_capture_id TEXT`,
  `ALTER TABLE inquiries ADD COLUMN quote_currency TEXT`,
  `ALTER TABLE inquiries ADD COLUMN paid_at TEXT`,
  `ALTER TABLE inquiries ADD COLUMN paid_usd REAL`,
  `ALTER TABLE inquiries ADD COLUMN paypal_order_id TEXT`,
  // 0249: 코드(inquiry.ts·admin/quote.ts)가 항상 쓰는데 세 스키마 어디에도 없던 컬럼.
  //   운영 DB엔 수동으로 넣어둬 살아 있었지만, DB 재생성 시 폴백이
  //   "구조화 사본 없이 / 계좌 없이" 조용히 데이터를 버리던 재현 불가 지뢰.
  `ALTER TABLE inquiries ADD COLUMN details_json TEXT`,
  `ALTER TABLE inquiries ADD COLUMN quote_bank TEXT`,
  // 0829: 웨이퍼 다이싱 옵션. 주문 항목별로 '골랐는가'와 '그때의 박스당 금액'을 함께 굳힌다.
  //   금액을 같이 저장해야 나중에 단가표가 바뀌어도 그 주문의 청구 근거가 그대로 남는다.
  //   옛 주문에는 값이 없다 → DEFAULT 0 으로 '다이싱 아니오'가 된다.
  `ALTER TABLE order_items ADD COLUMN dicing INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE order_items ADD COLUMN dicing_fee INTEGER NOT NULL DEFAULT 0`,
];

// 스키마 버전 — SCHEMA·MIGRATIONS 문장 전체의 지문(settings 'schema_version' 에 숫자로 저장)
const SCHEMA_VERSION = schemaVersionOf([...SCHEMA, ...MIGRATIONS]);

export async function ensureSchema(db: D1): Promise<void> {
  if (!schemaReady) {
    schemaReady = runSchemaInit({
      schema: SCHEMA,
      migrations: MIGRATIONS,
      version: SCHEMA_VERSION,
      readMarker: async () => {
        const row = await db
          .prepare(`SELECT value FROM settings WHERE key = 'schema_version'`)
          .first<{ value: number | string | null }>();
        const v = Number(row?.value);
        return row && Number.isFinite(v) ? v : null;
      },
      writeMarker: async (v: number) => {
        await db
          .prepare(
            `INSERT INTO settings (key, value, updated_at, source) VALUES ('schema_version', ?, ?, 'schema')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, source = excluded.source`,
          )
          .bind(v, new Date().toISOString())
          .run();
      },
      exec: (sql: string) => db.prepare(sql).run(),
      tableColumns: async (table: string) => {
        if (!/^\w+$/.test(table)) throw new Error(`표 이름이 이상합니다: ${table}`);
        const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
        return new Set((results ?? []).map((r) => r.name));
      },
      warn: (...a: unknown[]) => console.warn(...a),
      log: (m: string) => console.log(m),
    }).then(() => undefined).catch((e) => {
      schemaReady = null; // 실패하면 다음 요청에서 재시도
      throw e;
    });
  }
  return schemaReady;
}

/** 스키마를 보장한 DB. 없으면 null. */
export async function db(): Promise<D1 | null> {
  const d = getDb();
  if (!d) return null;
  try {
    await ensureSchema(d);
    return d;
  } catch (e) {
    console.error('[db] 스키마 준비 실패:', e);
    return null;
  }
}

// ── 아이디 생성 ────────────────────────────────────────
// INQ-20260713-A1B2 / ORD-20260713-A1B2 (날짜 + 랜덤 4자)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자(I,L,O,0,1) 제외
export function newId(prefix: 'INQ' | 'ORD'): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => ALPHABET[b % ALPHABET.length])
    .join('');
  return `${prefix}-${ymd}-${rnd}`;
}

export const nowIso = () => new Date().toISOString();

/**
 * 알림 문구에 쓰는 한국 시간 표기 (`2026-08-06 03:19`).
 * ⚠️ **저장에는 쓰지 말 것** — DB 에는 반드시 nowIso()(UTC)를 넣는다.
 *    저장을 KST 로 바꾸면 기존 데이터와 뒤섞여 정렬·비교가 전부 어긋난다.
 *    이건 **사람이 읽는 알림 전용**이다. 알림을 보는 사람은 한국에 있는데
 *    UTC 로 찍으면 실제 시각과 9시간, 날짜는 하루까지 어긋나 보인다.
 */
export const nowKst = () =>
  new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 16);
