// 서류 HTML → PDF — Cloudflare Browser Run(브라우저 렌더링)의 'pdf' 빠른 작업(REST)을 부른다.
//
// 왜 여기서: 사이트의 서류(견적서·견적 요청서)는 브라우저가 그리는 HTML 이다. 같은 HTML 을 Cloudflare 의
//   헤드리스 크롬이 인쇄하면 고객이 사이트에서 'PDF 저장'한 것과 같은 모양이 나온다(한글 글꼴 Noto CJK 포함).
// 비용: 무료 플랜 하루 10분 · 10초에 1건. 확인 메일 한 통에 1건만 쓴다(서류 여러 장을 PDF 하나로 — quote-ack.js mergeDocPages).
//   너무 잦으면 429 → Retry-After 만큼(최대 12초 + 약간의 흔들림) 기다려 한 번만 다시 시도 — 마감 안에 들어올 때만.
//   그래도 안 되면 PDF 없이 메일을 보낸다(호출부).
// 주소: 지금 문서의 경로(/browser-run/pdf — 2026 이름 변경)를 먼저 쓰고, 404 면 옛 경로(/browser-rendering/pdf)로 한 번 더.
//   (2026-10-02 맥미니에서 실제 토큰으로 둘 다 200 확인 — API 참조 문서에는 아직 옛 경로가 남아 있다)
// 비밀값: CF_ACCOUNT_ID · CF_BROWSER_TOKEN(권한 'Browser Rendering - Edit' 하나만 준 API 토큰) — cloudflare:workers env 에서만 읽는다.
//   ⚠️ 이 파일에는 빌드 환경 변수 문자열(import.meta 다음 env)을 주석으로도 쓰지 않는다(mail-send.ts 와 같은 이유).
// 로고: 서류 로고(src/assets/brand/logo-light.png)는 정적 파일(ASSETS)에서 읽어 data: 주소로 넣는다
//   — PDF 를 만드는 원격 브라우저는 맥미니 로컬 서버(127.0.0.1)에 접근할 수 없다. 인스턴스마다 한 번만 만든다.
import { env as cfEnv } from 'cloudflare:workers';
import { b64 } from './mail-mime.js';

const PDF_MAX = 1024 * 1024; // 서류 두어 장(글꼴 포함 ≈ 250KB)이 이보다 크면 뭔가 잘못된 것 — 메일에 싣지 않는다
const PATHS = ['browser-run/pdf', 'browser-rendering/pdf'];

export type PdfReason = 'no_credentials' | 'no_time' | 'rate_limited' | 'http_error' | 'fetch_error' | 'bad_pdf' | 'too_big';
export type PdfResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: PdfReason; status?: number };

function secret(k: string): string {
  const raw = (cfEnv as Record<string, unknown> | undefined)?.[k] ?? '';
  return typeof raw === 'string' ? raw.trim().replace(/^["']|["']$/g, '') : '';
}

/** PDF 비밀값이 다 있는가 (값은 돌려주지 않는다). 계정 ID 는 32자리 16진수. */
export function pdfConfigured(): boolean {
  return /^[0-9a-f]{32}$/i.test(secret('CF_ACCOUNT_ID')) && Boolean(secret('CF_BROWSER_TOKEN'));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * @param html 완성된 서류 HTML(서류 여러 장이면 장마다 새 쪽)
 * @param opts.script 페이지 안에서 한 번 돌릴 스크립트(칸 맞춤) · opts.ref 접수번호(로그용)
 *             opts.deadline 이 시각(ms)까지는 PDF 를 끝낸다(뒤에 메일 보낼 시간을 호출부가 빼서 준다)
 */
export async function renderPdf(html: string, opts: { script?: string; ref?: string; deadline?: number }): Promise<PdfResult> {
  if (!pdfConfigured()) return { ok: false, reason: 'no_credentials' };
  const deadline = opts.deadline ?? Date.now() + 15000;
  const body = JSON.stringify({
    html,
    ...(opts.script ? { addScriptTag: [{ content: opts.script }] } : {}),
    gotoOptions: { waitUntil: 'networkidle0', timeout: 15000 },
    // 쪽 크기·여백은 서류 CSS(@page A4 · 10mm)를 따른다. 회색 칸(배경색)도 인쇄한다.
    pdfOptions: { format: 'a4', printBackground: true, preferCSSPageSize: true },
  });

  let path = 0;
  let retried429 = false;
  for (;;) {
    const left = deadline - Date.now();
    if (left < 4000) return { ok: false, reason: 'no_time' };
    const url = `https://api.cloudflare.com/client/v4/accounts/${secret('CF_ACCOUNT_ID')}/${PATHS[path]}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret('CF_BROWSER_TOKEN')}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(Math.min(20000, left)),
      });
    } catch (e) {
      console.error('[pdf] 연결 오류:', (e as Error)?.name ?? 'Error', opts.ref ?? '');
      return { ok: false, reason: 'fetch_error' };
    }
    if (res.status === 404 && path + 1 < PATHS.length) {
      path++;
      continue;
    }
    if (res.status === 429 && !retried429) {
      retried429 = true;
      const after = Number(res.headers.get('Retry-After'));
      const pause = Math.min(12, Number.isFinite(after) && after > 0 ? after : 11) * 1000 + Math.floor(Math.random() * 1500);
      // 기다린 뒤에도 만들 시간(4초)이 남을 때만 다시 시도
      if (deadline - Date.now() - pause >= 4000) {
        await wait(pause);
        continue;
      }
    }
    if (!res.ok) {
      console.error('[pdf] 만들기 실패:', res.status, opts.ref ?? '');
      return { ok: false, reason: res.status === 429 ? 'rate_limited' : 'http_error', status: res.status };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > PDF_MAX) {
      console.error('[pdf] 너무 큼:', bytes.length, opts.ref ?? '');
      return { ok: false, reason: 'too_big' };
    }
    // %PDF- 로 시작해야 PDF 다(오류 JSON 이 200 으로 오는 경우 등을 거른다)
    if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
      console.error('[pdf] PDF 가 아님:', bytes.length, opts.ref ?? '');
      return { ok: false, reason: 'bad_pdf' };
    }
    return { ok: true, bytes };
  }
}

// 서류 로고 data: 주소 — 워커 인스턴스가 살아 있는 동안 한 번만 만든다.
let logoCache: { src: string; uri: string } | null = null;

/**
 * 정적 파일(ASSETS 바인딩)에서 로고를 읽어 data: 주소로. 못 읽으면 null(호출부가 사이트 주소로 대신한다).
 * @param src 빌드가 준 로고 경로(/_astro/logo-light.….png)
 */
export async function logoDataUri(src: string): Promise<string | null> {
  if (logoCache?.src === src) return logoCache.uri;
  try {
    const assets = (cfEnv as Record<string, unknown> | undefined)?.ASSETS as { fetch?: (r: Request) => Promise<Response> } | undefined;
    if (!assets?.fetch || !src.startsWith('/')) return null;
    const res = await assets.fetch(new Request(new URL(src, 'https://assets.local')));
    if (!res.ok) return null;
    const uri = `data:image/png;base64,${b64(new Uint8Array(await res.arrayBuffer()))}`;
    logoCache = { src, uri };
    return uri;
  } catch {
    return null;
  }
}
