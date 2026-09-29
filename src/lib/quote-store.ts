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

export type RevisionSummary = Pick<RevisionRow, 'rev' | 'source' | 'kind' | 'total' | 'seen_total' | 'price_sha' | 'created_at'>;

/** 가장 최근 개정 (없으면 null) */
export async function latestRevision(d: D1, inquiryId: string): Promise<RevisionRow | null> {
  const row = await d
    .prepare(`SELECT rev, source, kind, total, input_json, result_json, doc_json, manual_json, seen_total, price_sha, note, created_at
      FROM quote_revisions WHERE inquiry_id = ? ORDER BY rev DESC LIMIT 1`)
    .bind(inquiryId)
    .first<RevisionRow>();
  return row ?? null;
}

/** 개정 요약 목록 (rev 오름차순) */
export async function listRevisions(d: D1, inquiryId: string): Promise<RevisionSummary[]> {
  const { results } = await d
    .prepare(`SELECT rev, source, kind, total, seen_total, price_sha, created_at
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
 * 기준 개정(baseRev) 다음 번호로 저장한다. 같은 번호가 이미 있으면 conflict.
 * UNIQUE 위반만 conflict 로 바꾸고 그 외 오류는 그대로 던진다.
 */
export async function insertRevision(
  d: D1,
  inquiryId: string,
  baseRev: number,
  row: NewRevision,
): Promise<{ ok: true; rev: number } | { ok: false; conflict: true }> {
  const rev = baseRev + 1;
  try {
    await d
      .prepare(
        `INSERT INTO quote_revisions (inquiry_id, rev, source, kind, total, input_json, result_json, doc_json, manual_json, seen_total, price_sha, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        inquiryId, rev, row.source, row.kind, row.total ?? null,
        js(row.input), js(row.result), js(row.doc), js(row.manual),
        row.seenTotal ?? null, row.priceSha ?? null, row.note ?? null, nowIso(),
      )
      .run();
    return { ok: true, rev };
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e))) return { ok: false, conflict: true };
    throw e;
  }
}
