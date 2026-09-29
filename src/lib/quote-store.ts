// 견적 개정(quote_revisions) 읽기·쓰기.
//
// 새 개정은 "기준 개정 + 1" 을 INSERT … VALUES 로 넣는다. 두 곳이 같은 기준으로 동시에 저장하면
// UNIQUE(inquiry_id, rev) 위반으로 한쪽이 실패한다 → conflict 로 돌려준다(낙관적 잠금).
// ⚠️ INSERT … SELECT 로 번호를 구하지 않는다 — scripts/check-schema.mjs 가 INSERT … VALUES 형태로 컬럼을 읽는다.
import type { D1 } from './db';
import { nowIso } from './db';

export type RevisionRow = {
  rev: number;
  source: string;
  kind: string;
  total: number | null;
  input_json: string | null;
  result_json: string | null;
  doc_json: string | null;
  manual_json: string | null;
  seen_total: number | null;
  price_sha: string | null;
  note: string | null;
  created_at: string;
};

export type RevisionSummary = Pick<RevisionRow, 'rev' | 'source' | 'kind' | 'total' | 'seen_total' | 'price_sha' | 'note' | 'created_at'>;

/** 견적 탭 카드 요약용 행(summarizeRevisions 입력) */
export type RevisionListRow = Pick<RevisionRow, 'rev' | 'source' | 'kind' | 'total' | 'seen_total' | 'manual_json' | 'created_at'> & { inquiry_id: string };

/** 가장 최근 개정 (없으면 null) */
export async function latestRevision(d: D1, inquiryId: string): Promise<RevisionRow | null> {
  const row = await d
    .prepare(`SELECT rev, source, kind, total, input_json, result_json, doc_json, manual_json, seen_total, price_sha, note, created_at
      FROM quote_revisions WHERE inquiry_id = ? ORDER BY rev DESC LIMIT 1`)
    .bind(inquiryId)
    .first<RevisionRow>();
  return row ?? null;
}

/** 특정 개정 (없으면 null) — latestRevision 과 같은 컬럼 */
export async function getRevision(d: D1, inquiryId: string, rev: number): Promise<RevisionRow | null> {
  const row = await d
    .prepare(`SELECT rev, source, kind, total, input_json, result_json, doc_json, manual_json, seen_total, price_sha, note, created_at
      FROM quote_revisions WHERE inquiry_id = ? AND rev = ?`)
    .bind(inquiryId, rev)
    .first<RevisionRow>();
  return row ?? null;
}

/** 개정 요약 목록 (rev 오름차순) — 관리자 이력 표가 쓴다(메모 포함) */
export async function listRevisions(d: D1, inquiryId: string): Promise<RevisionSummary[]> {
  const { results } = await d
    .prepare(`SELECT rev, source, kind, total, seen_total, price_sha, note, created_at
      FROM quote_revisions WHERE inquiry_id = ? ORDER BY rev ASC`)
    .bind(inquiryId)
    .all<RevisionSummary>();
  return results ?? [];
}

export type NewRevision = {
  source: 'auto' | 'admin';
  kind: 'estimate' | 'manual';
  total: number | null;
  input?: unknown;
  result?: unknown;
  doc?: unknown;
  manual?: unknown;
  seenTotal?: number | null;
  priceSha?: string | null;
  note?: string | null;
};

const js = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

/**
 * 기준 개정(baseRev) 다음 번호를 넣는 준비된 문장 — D1 batch 에 다른 문장과 함께 넣을 때 쓴다.
 * UNIQUE(inquiry_id, rev) 위반은 실행하는 쪽(batch·run)에서 난다.
 */
export function revisionInsertStatement(d: D1, inquiryId: string, baseRev: number, row: NewRevision) {
  const rev = baseRev + 1;
  const stmt = d
    .prepare(
      `INSERT INTO quote_revisions (inquiry_id, rev, source, kind, total, input_json, result_json, doc_json, manual_json, seen_total, price_sha, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      inquiryId, rev, row.source, row.kind, row.total ?? null,
      js(row.input), js(row.result), js(row.doc), js(row.manual),
      row.seenTotal ?? null, row.priceSha ?? null, row.note ?? null, nowIso(),
    );
  return { rev, stmt };
}

/** UNIQUE(inquiry_id, rev) 위반인가 — 낙관적 잠금 충돌 */
export const isUniqueViolation = (e: unknown) => /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e));

/**
 * 기준 개정(baseRev) 다음 번호로 저장한다. 같은 번호가 이미 있으면 conflict.
 * UNIQUE 위반만 conflict 로 바꾸고 그 외 오류는 그대로 던진다.
 */
export async function insertRevision(
  d: D1,
  inquiryId: string,
  baseRev: number,
  row: NewRevision,
): Promise<{ ok: true; rev: number } | { ok: false; conflict: true }> {
  const { rev, stmt } = revisionInsertStatement(d, inquiryId, baseRev, row);
  try {
    await stmt.run();
    return { ok: true, rev };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, conflict: true };
    throw e;
  }
}

/**
 * 최근 문의 300건(관리자 목록과 같은 범위)의 개정 요약 행 — 견적 탭 카드용.
 * 금액 근거(input·result·doc)는 읽지 않는다.
 */
export async function listRevisionSummariesForRecent(d: D1): Promise<RevisionListRow[]> {
  const { results } = await d
    .prepare(`SELECT inquiry_id, rev, source, kind, total, seen_total, manual_json, created_at
      FROM quote_revisions
      WHERE inquiry_id IN (SELECT id FROM inquiries ORDER BY created_at DESC LIMIT 300)
      ORDER BY inquiry_id, rev`)
    .all<RevisionListRow>();
  return results ?? [];
}
