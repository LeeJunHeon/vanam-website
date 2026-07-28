// D1 (주문·견적 DB) 접근 헬퍼.
//
// ⚠️ 환경별 차이
//  - 배포(Cloudflare workerd): env.DB 에 D1 바인딩이 있다.
//  - 로컬 dev(순수 Node):       env 가 빈 객체(shim)라 DB 가 없다.
//    → getDb()가 null 을 돌려주고, 호출부는 DB 없이도 동작해야 한다.
//      (문의 폼은 DB 없이도 구글챗 알림은 나가야 하므로)
import { env as cfEnv } from 'cloudflare:workers';

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
let schemaReady: Promise<void> | null = null;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS inquiries (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
    name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, company TEXT, message TEXT,
    product_sku TEXT, product_name TEXT, material TEXT, method TEXT, substrate TEXT,
    thickness TEXT, quantity TEXT, deadline TEXT, details TEXT,
    quoted_amount INTEGER, quote_note TEXT, locale TEXT,
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
  `ALTER TABLE inquiries ADD COLUMN quote_currency TEXT`,
  `ALTER TABLE inquiries ADD COLUMN paid_at TEXT`,
  `ALTER TABLE inquiries ADD COLUMN paid_usd REAL`,
  `ALTER TABLE inquiries ADD COLUMN paypal_order_id TEXT`,
];

export async function ensureSchema(db: D1): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const sql of SCHEMA) await db.prepare(sql).run();
      for (const sql of MIGRATIONS) {
        try {
          await db.prepare(sql).run();
        } catch {
          /* 컬럼이 이미 있으면 무시 */
        }
      }
    })().catch((e) => {
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
