// 견적 요청 접수 확인 메일 — 실행부(DB 읽기 · 서류 PDF · 발송 · 기록).
//
// 부르는 곳: ① 접수(api/inquiry.ts) — 응답을 보낸 뒤 waitUntil 로(고객 화면을 늦추지 않는다)
//            ② 관리자 [확인 메일 (다시) 보내기](api/admin/quote-mail.ts)
// 순서: 접수 행 읽기 → 보낼 수 있는지(주소·빌드·설정·보안 확인·하루 상한 — 아니면 PDF 도 만들지 않고 '안 보냄'으로 기록)
//       → '보내는 중' 기록 → 고객 견적 요약(조회 화면과 같은 customerQuoteView)
//       → 서류 PDF(예상 견적서 + 견적 요청서 / 요청서만) → 메일(mail-send.ts — 유일한 발송 통로)
//       → inquiries.ack_mail 에 결과 기록 → 실패면 담당자 구글챗(운영 빌드만)
// 원칙: 여기서 무슨 일이 나도 접수 자체에는 영향이 없다(예외를 밖으로 던지지 않는다).
//       PDF 를 못 만들면 PDF 없이 보낸다(본문에 조회 링크 — 거기서 인쇄·PDF 저장 가능).
//       워커의 백그라운드 작업은 응답 뒤 30초 안에 끝나야 한다 → 전체 마감 24초, 메일 보낼 몫 7초를 남기고 PDF 를 만든다.
//       마감을 넘겨 끊겨도 '보내는 중' 기록이 남아 관리자 화면에 '중단됨'으로 보인다(조용히 사라지지 않는다).
//       로그에는 접수번호와 결과만 — 이름·주소·내용은 남기지 않는다.
// 남용 방지(운영 빌드의 자동 발송만): 보안 확인(Turnstile)을 통과한 접수만 · 같은 주소 하루 3통 · 하루 전체 50통.
//   회사 메일(hello@)로 남의 주소에 글을 실어 보내는 통로가 되지 않게 한다. 관리자가 직접 누른 발송은 제한하지 않는다.
import { getCollection } from 'astro:content';
import type { D1 } from './db';
import { nowIso } from './db';
import { sendMail, gmailConfigured, MAIL_LIVE } from './mail-send';
import { renderPdf, pdfConfigured, logoDataUri } from './doc-pdf';
import { isSafeAddress } from './mail-mime.js';
import {
  mailAllowed, hostAllowed, isFreshPending, ackContent, estimateOf, attachmentName, pdfTitle, mergeDocPages, fitScript,
  ackRecord, requestDocArgs, ACK_REASON_KO, kstText, lookupLink,
} from './quote-ack.js';
import { buildQuoteHtml, buildRequestHtml, requestDocFrom, fitCells, STYLE, telKr } from './doc-excel.js';
import { docOptions } from './quote-view-render.js';
import { customerQuoteView } from './quote-revision.js';
import { latestRevision } from './quote-store';
import { readRate } from './fx';
import { formatUsd } from './price';
import { SUBSTRATE_SIZES, DELIVERY_METHODS } from './processes';
import { sendChat } from './chat-send';
import company from '../data/company.json';
import siteData from '../data/site.json';
import docLogo from '../assets/brand/logo-light.png';

export type AckResult = {
  status: 'sent' | 'failed' | 'skipped';
  reason: string | null;
  /** 'quote'(예상 견적서+요청서) · 'request'(요청서) · 'none:사유'(못 붙임) · null(만들 단계 전에 끝남) */
  pdf: string | null;
  code?: number | null;
};

/** 운영 사이트 주소(조회 링크·로고 대체 주소) — astro.config.mjs 의 site 와 같다 */
const SITE = 'https://vanam.co.kr';
const RUN_MS = 24_000;       // 전체 마감(워커 백그라운드 30초 안)
const MAIL_RESERVE_MS = 7_000; // PDF 를 만든 뒤 메일 보낼 몫
const DAY_MS = 24 * 60 * 60 * 1000;
const RECIPIENT_DAILY_MAX = 3;
const GLOBAL_DAILY_MAX = 50;

/** 이 언어의 코드값 라벨(기판 크기·전달 방식) — 조회 화면과 같은 원본(lib/processes) */
function mapsFor(lang: 'ko' | 'en') {
  return {
    sizeMap: Object.fromEntries(SUBSTRATE_SIZES.map((x) => [x.value, lang === 'ko' ? x.ko : x.en])),
    deliveryMap: Object.fromEntries(DELIVERY_METHODS.map((x) => [x.value, lang === 'ko' ? x.ko : x.en])),
  };
}

/** 메일 본문의 상품 이름 — 카탈로그 이름(접수 때 브라우저가 보낸 글자 대신) · 없으면 저장된 이름 */
async function productLabel(q: Record<string, unknown>, lang: 'ko' | 'en'): Promise<string> {
  const sku = String(q.product_sku ?? '');
  try {
    const p = sku ? (await getCollection('products')).find((x) => x.id === sku) : undefined;
    if (p) return lang === 'ko' ? String(p.data.name) : String((p.data as Record<string, unknown>).name_en ?? p.data.name);
  } catch {
    /* 저장된 이름으로 */
  }
  return String(q.product_name ?? q.material ?? '');
}

/**
 * 하루 상한 — 같은 주소로 보낸 접수 건 수 · 전체 보낸 건 수(지난 24시간, 이 건 제외).
 * @returns 넘었으면 사유, 아니면 null · alert = 전체 상한에 처음 닿았는가(구글챗 한 번만)
 */
async function capCheck(d: D1, id: string, email: string): Promise<{ reason: 'recipient_cap' | 'daily_cap'; alert: boolean } | null> {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const row = await d.prepare(`SELECT
      SUM(CASE WHEN lower(email) = lower(?) AND json_extract(ack_mail, '$.sentAt') IS NOT NULL THEN 1 ELSE 0 END) AS mine,
      SUM(CASE WHEN json_extract(ack_mail, '$.sentAt') IS NOT NULL THEN 1 ELSE 0 END) AS total,
      SUM(CASE WHEN json_extract(ack_mail, '$.reason') = 'daily_cap' THEN 1 ELSE 0 END) AS capped
    FROM inquiries WHERE created_at > ? AND id <> ? AND ack_mail IS NOT NULL`)
    .bind(email, since, id)
    .first<{ mine: number | null; total: number | null; capped: number | null }>();
  if ((Number(row?.total) || 0) >= GLOBAL_DAILY_MAX) return { reason: 'daily_cap', alert: (Number(row?.capped) || 0) === 0 };
  if ((Number(row?.mine) || 0) >= RECIPIENT_DAILY_MAX) return { reason: 'recipient_cap', alert: false };
  return null;
}

type AckOpts = { by: 'auto' | 'admin'; origin: string; verified?: boolean };

/**
 * 이 접수 건에 확인 메일을 보낼 수 있는가 — 주소·빌드·접속 주소·설정·(운영 빌드 자동 발송이면) 보안 확인·하루 상한.
 * runQuoteAck(실제 발송)와 ackPlanned(접수 응답 — 완료 화면이 '메일을 보냈다'고 안내해도 되는지)가 같은 판정을 쓴다.
 * @returns 막는 사유(보낼 수 있으면 null) · capAlert = 하루 전체 상한에 처음 닿았는가(구글챗 한 번만)
 */
async function ackBlock(d: D1, id: string, to: string, opts: AckOpts): Promise<{ reason: string; capAlert?: boolean } | null> {
  const allowed = mailAllowed(MAIL_LIVE, to, isSafeAddress);
  if (!allowed.ok) return { reason: allowed.reason };
  if (!hostAllowed(MAIL_LIVE, opts.origin)) return { reason: 'blocked_host' };
  if (!gmailConfigured()) return { reason: 'no_credentials' };
  if (MAIL_LIVE && opts.by === 'auto') {
    if (!opts.verified) return { reason: 'unverified' };
    const cap = await capCheck(d, id, to);
    if (cap) return { reason: cap.reason, capAlert: cap.alert };
  }
  return null;
}

/**
 * 접수 직후 자동 확인 메일이 나갈 건인가(판정만 — 보내지 않고 기록도 남기지 않는다). 예외를 던지지 않는다.
 * 접수 응답의 ack 로 내려가 완료 화면이 이때만 '접수 확인 메일을 보내드렸습니다'를 띄운다
 * (상한·테스트 빌드·설정 없음으로 안 나가는 건에 '보냈다'고 말하지 않게). PDF·Gmail 실패는 여기서 알 수 없다 — 그때는 담당자 알림.
 */
export async function ackPlanned(d: D1, id: string, to: string, opts: Omit<AckOpts, 'by'>): Promise<boolean> {
  try {
    return (await ackBlock(d, id, String(to ?? '').trim(), { ...opts, by: 'auto' })) === null;
  } catch {
    return false;
  }
}

async function record(d: D1, id: string, prev: unknown, r: Parameters<typeof ackRecord>[1]): Promise<void> {
  try {
    await d.prepare(`UPDATE inquiries SET ack_mail = ? WHERE id = ?`).bind(ackRecord(prev, r), id).run();
  } catch (e) {
    console.warn('[ack-mail] 결과 기록 실패:', id, (e as Error)?.name ?? 'Error');
  }
}

/**
 * 확인 메일 한 통(접수 한 건). 예외를 던지지 않는다.
 * @param d 접수 행이 저장된 DB · @param id 접수번호
 * @param opts.by 'auto'(접수 직후) | 'admin'(관리자가 누름) · opts.origin 요청이 들어온 주소
 *             opts.verified 접수 때 보안 확인(Turnstile)을 실제로 통과했는가(자동 발송만 본다)
 */
export async function runQuoteAck(d: D1, id: string, opts: AckOpts): Promise<AckResult> {
  const deadline = Date.now() + RUN_MS;
  let q: Record<string, unknown> | null = null;
  try {
    q = await d.prepare(`SELECT * FROM inquiries WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  } catch (e) {
    // 행을 못 읽었으면 이전 기록을 모른다 — 덮어쓰지 않고 알림·로그만 남긴다
    console.error('[ack-mail] 접수 행 읽기 실패:', id, (e as Error)?.name ?? 'Error');
    const r: AckResult = { status: 'failed', reason: 'error', pdf: null };
    await alertFailure(id, r);
    return r;
  }
  if (!q) return { status: 'skipped', reason: 'no_inquiry', pdf: null };
  if (q.type !== 'quote') return { status: 'skipped', reason: 'not_quote', pdf: null };
  // 이미 보내는 중이면(접수 직후 자동 발송이 아직 도는 중 등) 두 번 보내지 않는다
  if (isFreshPending(q.ack_mail)) return { status: 'skipped', reason: 'in_progress', pdf: null };

  const lang: 'ko' | 'en' = q.locale === 'ko' ? 'ko' : 'en';
  const to = String(q.email ?? '').trim();
  try {
    const block = await ackBlock(d, id, to, opts);
    if (block) {
      if (block.capAlert) {
        await sendChat(`⚠️ 접수 확인 메일 — 오늘 자동 발송 상한(${GLOBAL_DAILY_MAX}통)에 닿아 멈췄습니다.\n접수번호 ${id}\n남용인지 확인하고, 필요하면 관리자 견적 탭에서 직접 보내세요.`,
          { tag: 'ack-mail', ref: id }).catch(() => undefined);
      }
      return finish(d, id, q, opts.by, { status: 'skipped', reason: block.reason, pdf: null });
    }
    await record(d, id, q.ack_mail ?? null, { status: 'pending', by: opts.by, at: nowIso() });
    return finish(d, id, q, opts.by, await compose(d, q, id, lang, to, opts.origin, deadline));
  } catch (e) {
    console.error('[ack-mail] 처리 오류:', id, (e as Error)?.name ?? 'Error');
    return finish(d, id, q, opts.by, { status: 'failed', reason: 'error', pdf: null });
  }
}

/** 실패 알림 — 운영 빌드만 나간다(chat-send.ts 가 그 밖의 빌드는 막는다). 개인정보는 넣지 않는다. */
async function alertFailure(id: string, result: AckResult): Promise<void> {
  const why = ACK_REASON_KO[result.reason as keyof typeof ACK_REASON_KO] ?? result.reason ?? '';
  await sendChat(`⚠️ 접수 확인 메일 실패\n접수번호 ${id}\n사유: ${why}${result.code ? ` (HTTP ${result.code})` : ''}\n관리자 견적 탭에서 [확인 메일 다시 보내기]로 다시 보낼 수 있습니다.`,
    { tag: 'ack-mail', ref: id }).catch(() => undefined);
}

/** 결과 기록 + 실패면 구글챗 + 한 줄 로그 */
async function finish(d: D1, id: string, q: Record<string, unknown>, by: 'auto' | 'admin', result: AckResult): Promise<AckResult> {
  // 이전 기록 = 읽은 행의 값('보내는 중' 기록은 그 위에 잠깐 덮었다가 여기서 결과로 다시 덮는다)
  await record(d, id, q.ack_mail ?? null, { ...result, by, at: nowIso() });
  if (result.status === 'failed') await alertFailure(id, result);
  console.log(`[ack-mail] ${id} ${result.status}${result.reason ? ` ${result.reason}` : ''} pdf=${result.pdf ?? '-'}`);
  return result;
}

/** 서류 PDF + 본문을 만들어 보낸다(보낼 수 있는지 확인은 끝난 뒤) */
async function compose(
  d: D1, q: Record<string, unknown>, id: string, lang: 'ko' | 'en', to: string, origin: string, deadline: number,
): Promise<AckResult> {
  // 고객 견적 요약 — 조회 화면과 같은 함수. 실패하면 견적 없이(요청서만) 간다.
  let view: ReturnType<typeof customerQuoteView> = null;
  try {
    const revision = await latestRevision(d, id);
    if (revision) {
      const fx = await readRate(d);
      view = customerQuoteView({
        revision,
        inquiry: { quoted_amount: q.quoted_amount ?? null, quote_currency: q.quote_currency ?? null, paid_at: q.paid_at ?? null },
        locale: lang, usdRate: fx.rate, formatUsd,
      });
    }
  } catch (e) {
    console.warn('[ack-mail] 견적 요약 실패(요청서만 보냄):', id, (e as Error)?.name ?? 'Error');
    view = null;
  }
  const T = ((siteData as Record<string, any>)[lang] ?? (siteData as Record<string, any>).en).quote.view as Record<string, string>;
  const estimate = estimateOf(view);

  // 서류 PDF — 예상 견적이면 [예상 견적서, 견적 요청서], 아니면 [견적 요청서]. 요청서 날짜 = 접수일(조회 화면과 같게).
  let attachment: { filename: string; contentType: string; bytes: Uint8Array } | null = null;
  let pdf: string;
  if (!pdfConfigured()) pdf = 'none:no_credentials';
  else {
    try {
      const logoUrl = (await logoDataUri(docLogo.src)) ?? new URL(docLogo.src, SITE).href;
      const date = kstText(String(q.created_at ?? '')).slice(0, 10) || kstText(nowIso()).slice(0, 10);
      const reqHtml = buildRequestHtml({ ...requestDocFrom(requestDocArgs(q, lang, date, mapsFor(lang))), logoUrl });
      const qo = estimate ? docOptions(view, T, lang) : null;
      const htmls = qo ? [buildQuoteHtml({ ...qo, logoUrl }, company as Record<string, unknown>), reqHtml] : [reqHtml];
      const r = await renderPdf(mergeDocPages(htmls, STYLE, { lang, title: pdfTitle(lang, id, Boolean(qo)) }),
        { script: fitScript(fitCells), ref: id, deadline: deadline - MAIL_RESERVE_MS });
      if (r.ok) {
        attachment = { filename: attachmentName(lang, id, Boolean(qo)), contentType: 'application/pdf', bytes: r.bytes };
        pdf = qo ? 'quote' : 'request';
      } else {
        pdf = `none:${r.reason}`;
      }
    } catch (e) {
      console.warn('[ack-mail] PDF 준비 실패(PDF 없이 보냄):', id, (e as Error)?.name ?? 'Error');
      pdf = 'none:error';
    }
  }

  const c = ackContent({
    lang, live: MAIL_LIVE, id,
    name: String(q.name ?? ''), company: String(q.company ?? ''),
    product: await productLabel(q, lang), receivedAt: String(q.created_at ?? ''),
    estimate, T, attachment: attachment ? (pdf === 'quote' ? 'quote' : 'request') : null,
    // 조회 링크 — 운영은 vanam.co.kr · 테스트 빌드는 지금 접속한 주소. 받는 주소를 # 뒤에 실어 누르면 바로 조회된다
    lookupUrl: lookupLink({ live: MAIL_LIVE, site: SITE, origin, lang, id, email: to }),
    tel: lang === 'en' ? String(company.tel ?? '') : telKr(company.tel), email: String(company.email ?? ''), site: SITE,
  });
  const sent = await sendMail({
    to, fromName: lang === 'en' ? 'VanaM Inc.' : '반암 VanaM',
    subject: c.subject, text: c.text, html: c.html, attachments: attachment ? [attachment] : [],
  }, { tag: 'ack-mail', ref: id, origin, deadline });

  if (sent.sent) return { status: 'sent', reason: null, pdf };
  // 보내기 직전 판정(주소·빌드·설정)으로 멈춘 것은 '안 보냄', 그 밖은 '실패'
  const skipped = sent.reason === 'blocked_build' || sent.reason === 'blocked_host' || sent.reason === 'bad_recipient' || sent.reason === 'no_credentials';
  return { status: skipped ? 'skipped' : 'failed', reason: sent.reason, pdf, code: sent.status ?? null };
}
