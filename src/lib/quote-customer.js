// 고객 화면용 예상 견적 판정 — 견적 테스트 모드(/api/quote-estimate) 전용. 순수 모듈.
//
// 고객에게는 세 가지 중 하나만 보여준다:
//   estimate — 자동 계산이 전부 되는 경우의 합계(부가세 포함) + USD 환산 + 유효기간
//   manual   — 하나라도 자동 계산이 안 되는 항목이 섞이면 금액 없이 "담당자 확인" 항목 목록
//   invalid  — 고객 입력 문제(샘플 수·두께·반복 구간 등) 목록
// customer 객체에는 단가·공급가액·세액·원가·장비/레시피/기판 ID 를 절대 넣지 않는다.
// 내부 확인용 값은 debug 로만 돌려준다(운영 전환 시 API 에서 통째로 제거).
//
// ⚠️ 규칙은 DB 값으로 런타임에 판단한다. 실제 장비·레시피·기판 ID·단가를 코드에 적지 않는다.
// ⚠️ 엔진(computeQuote)과 USD 표기(formatUsd)는 인자로 받는다 — node 테스트가 빌드 없이 쓰기 위해.
import { mapFormToQuote, conv, parseThickness, DEPOSITION } from './quote-map.js';

/** 이 수량 이상이면 담당자 확인 — 1회 투입 장수 표가 오면 planRuns 만 바꾸면 된다. */
export const SAMPLE_MANUAL_MIN = 10;

/** 두께(nm) 단위 공정 · 시간(min) 단위 공정 — src/lib/processes.ts 의 단위와 같다 */
const NM_PROCESSES = ['Sputter', 'ALD', 'Evaporator'];
const MIN_PROCESSES = ['PlasmaCleaning (In-situ)', 'PlasmaTreatment (Ex-situ)', 'Annealing'];

/** 기판 등급을 고르는 종류(폼 value) */
export const GRADED_TYPES = ['Silicon', 'Silicon oxide'];
export const GRADES = ['Test', 'Prime'];
/** 폼 크기 value → 인치 */
const SIZE_INCH = { '4inch': 4, '6inch': 6, '2inch_or_piece': 2 };

const TEXT = {
  ko: {
    samples: '샘플 수량을 1 이상의 정수로 입력해 주세요.',
    noSteps: '공정을 1개 이상 추가해 주세요.',
    process: (n) => `${n}단계 공정을 선택해 주세요.`,
    material: (n) => `${n}단계 물질을 선택해 주세요.`,
    thickness: (n) => `${n}단계 두께를 숫자로 입력해 주세요.`,
    minutes: (n) => `${n}단계 시간을 숫자로 입력해 주세요.`,
    repeatRange: '반복 구간의 시작·끝 단계를 다시 선택해 주세요.',
    repeatCount: '반복 횟수는 2 이상의 정수로 입력해 주세요.',
    grade: '기판 등급(Test / Prime)을 선택해 주세요.',
    step: (n, p, m) => `${n}단계 ${p}${m ? ` ${m}` : ''}`,
    measure: (m) => `분석: ${m}`,
    substrate: (t, s, g) => `기판: ${[t, s, g].filter(Boolean).join(' ')}`,
    sizeOther: '기타 크기',
    typeOther: '기타 종류',
    size2: '2 inch 이하·조각',
    manySamples: `샘플 수량 ${SAMPLE_MANUAL_MIN}개 이상`,
    repeatCross: (a, b) => `반복 구간 ${a}~${b}단계 (장비를 오가는 반복)`,
    repeatNonDep: (a, b) => `반복 구간 ${a}~${b}단계 (증착 외 단계 포함)`,
    pricing: '가격 자료 확인',
  },
  en: {
    samples: 'Enter the number of samples as a whole number of 1 or more.',
    noSteps: 'Add at least one process step.',
    process: (n) => `Select the process for step ${n}.`,
    material: (n) => `Select the material for step ${n}.`,
    thickness: (n) => `Enter the thickness for step ${n} as a number.`,
    minutes: (n) => `Enter the time for step ${n} as a number.`,
    repeatRange: 'Select the first and last steps of the repeat again.',
    repeatCount: 'Enter the repeat count as a whole number of 2 or more.',
    grade: 'Select the substrate grade (Test / Prime).',
    step: (n, p, m) => `Step ${n} ${p}${m ? ` ${m}` : ''}`,
    measure: (m) => `Analysis: ${m}`,
    substrate: (t, s, g) => `Substrate: ${[t, s, g].filter(Boolean).join(' ')}`,
    sizeOther: 'other size',
    typeOther: 'other type',
    size2: '≤2 inch / piece',
    manySamples: `${SAMPLE_MANUAL_MIN} or more samples`,
    repeatCross: (a, b) => `Repeat steps ${a}–${b} (alternates between tools)`,
    repeatNonDep: (a, b) => `Repeat steps ${a}–${b} (includes non-deposition steps)`,
    pricing: 'Pricing data review',
  },
};

/** Al2O3 → Al₂O₃, N2 → N₂ (고객 문구 표기용) */
const SUBS = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
export const prettyFormula = (s) => String(s ?? '').replace(/(?<=[A-Za-z)])(\d+)/g, (d) => [...d].map((c) => SUBS[+c]).join(''));

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isActive = (v) => v === true || v === 1 || v === '1';

/**
 * 회수 계획 — 지금은 1회 투입 장수 표가 없어서 샘플 수량만 본다.
 * SAMPLE_MANUAL_MIN 미만이면 1회, 이상이면 담당자 확인. 표가 오면 이 함수만 바꾼다.
 * @param {number} sampleCount
 * @returns {{runs: number, manual: boolean}}
 */
export function planRuns(sampleCount) {
  return { runs: 1, manual: sampleCount >= SAMPLE_MANUAL_MIN };
}

/**
 * 구매 요청 기판 매칭.
 * @param {{catalog_id: string, item_name: string, size_inch: unknown, oxide_nm: unknown, cost_per_unit: unknown, active: unknown}[]} rows
 * @param {{type: string, size: string, grade?: string}} sel 폼 value 그대로
 * @returns {{status: 'ok'|'none'|'ambiguous', row?: any, matched: string[]}}
 */
export function matchSubstrate(rows, sel) {
  const inch = SIZE_INCH[String(sel?.size ?? '')];
  const type = String(sel?.type ?? '');
  const grade = String(sel?.grade ?? '');
  const has = (name, word) => new RegExp(word, 'i').test(String(name ?? ''));
  const oxide = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const typeOk = {
    Silicon: (r) => has(r.item_name, 'boron') && oxide(r.oxide_nm) === null,
    'Silicon oxide': (r) => has(r.item_name, 'boron') && oxide(r.oxide_nm) > 0,
    Sapphire: (r) => has(r.item_name, 'sapphire'),
  }[type];
  if (!inch || !typeOk) return { status: 'none', matched: [] };
  const gradeWord = { Test: 'test', Prime: 'prime' }[grade];
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => isActive(r.active) && Number(r.size_inch) === inch && typeOk(r))
    .filter((r) => !GRADED_TYPES.includes(type) || (gradeWord && has(r.item_name, gradeWord)))
    .sort((a, b) => String(a.catalog_id).localeCompare(String(b.catalog_id)));
  const matched = list.map((r) => String(r.catalog_id));
  if (list.length === 0) return { status: 'none', matched };
  const costs = new Set(list.map((r) => String(r.cost_per_unit)));
  if (costs.size > 1) return { status: 'ambiguous', matched };
  return { status: 'ok', row: list[0], matched };
}

/** YYYY-MM-DD + n일 */
export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * 고객 입력 검증. 문제가 있으면 계산하지 않는다.
 * @returns {{step?: number, field: string, message: string}[]}
 */
export function validateForm(form, T) {
  const errs = [];
  const steps = Array.isArray(form?.steps) ? form.steps : [];
  const n = conv(form?.sampleCount);
  if (!(isInt(n) && n >= 1)) errs.push({ field: 'sampleCount', message: T.samples });
  if (steps.length === 0) errs.push({ field: 'process', message: T.noSteps });
  steps.forEach((s, i) => {
    const no = i + 1;
    const p = String(s?.process ?? '');
    if (!p) return errs.push({ step: no, field: 'process', message: T.process(no) });
    if (!String(s?.material ?? '').trim()) return errs.push({ step: no, field: 'material', message: T.material(no) });
    if (NM_PROCESSES.includes(p)) {
      const t = parseThickness(s?.value);
      if (!(typeof t === 'number' && t > 0)) errs.push({ step: no, field: 'value', message: T.thickness(no) });
    } else if (MIN_PROCESSES.includes(p)) {
      const m = conv(s?.value);
      if (!(typeof m === 'number' && m >= 0)) errs.push({ step: no, field: 'value', message: T.minutes(no) });
    }
  });
  const g = form?.repeatGroup;
  if (g) {
    const from = conv(g.from), to = conv(g.to), count = conv(g.count);
    const inRange = (v) => isInt(v) && v >= 1 && v <= steps.length;
    if (!inRange(from) || !inRange(to) || from > to) errs.push({ field: 'repeat', message: T.repeatRange });
    if (!(isInt(count) && count >= 2)) errs.push({ field: 'repeatCount', message: T.repeatCount });
  }
  if (form?.delivery === 'purchase' && GRADED_TYPES.includes(String(form?.substrateType ?? ''))
    && !GRADES.includes(String(form?.substrateGrade ?? ''))) {
    errs.push({ field: 'substrateGrade', message: T.grade });
  }
  return errs;
}

/**
 * 고객 응답 + 내부 확인용 debug.
 * @param {object} args
 * @param {any} args.form 폼 입력 (steps·repeatGroup·measurements·sampleCount·delivery·substrateType·substrateSize·substrateGrade·locale)
 * @param {{policy: any[], recipes: any[], equipment: any[], substrates: any[]}} args.priceDb
 * @param {(db: any, q: any) => any} args.computeQuote
 * @param {(krw: number, rate: number) => string} args.formatUsd
 * @param {number} args.usdRate
 * @param {string} args.today 한국 날짜 YYYY-MM-DD
 */
export function estimateForCustomer({ form, priceDb, computeQuote, formatUsd, usdRate, today }) {
  const locale = form?.locale === 'en' ? 'en' : 'ko';
  const T = TEXT[locale];
  const steps = Array.isArray(form?.steps) ? form.steps : [];

  const errors = validateForm(form, T);
  if (errors.length) return { customer: { kind: 'invalid', errors }, debug: { flags: { stage: 'validate' }, errors } };

  const sampleCount = /** @type {number} */ (conv(form.sampleCount));
  const manual = [];
  const addManual = (label) => { if (!manual.includes(label)) manual.push(label); };

  // 회수
  const runsPlan = planRuns(sampleCount);
  if (runsPlan.manual) addManual(T.manySamples);

  // 반복 구간
  const g = form.repeatGroup ? { from: conv(form.repeatGroup.from), to: conv(form.repeatGroup.to), count: conv(form.repeatGroup.count) } : null;
  /** @type {Record<number, number>} */
  const layerRepeats = {};
  if (g) for (let k = g.from; k <= g.to; k++) layerRepeats[k] = g.count;

  // 기판 (구매 요청일 때만)
  let substrate = { status: 'notPurchase', matched: [] };
  let substrateId = null;
  if (form.delivery === 'purchase') {
    substrate = matchSubstrate(priceDb.substrates, { type: form.substrateType, size: form.substrateSize, grade: form.substrateGrade });
    if (substrate.status === 'ok') substrateId = String(substrate.row.catalog_id);
    else {
      const type = String(form.substrateType ?? '');
      const size = String(form.substrateSize ?? '');
      addManual(T.substrate(
        type === '__other__' || !type ? T.typeOther : type,
        size === '__other__' || !size ? T.sizeOther : size === '2inch_or_piece' ? T.size2 : size.replace('inch', ' inch'),
        GRADED_TYPES.includes(type) ? form.substrateGrade : '',
      ));
    }
  }

  const mapped = mapFormToQuote(form, priceDb.recipes, {
    margin: '기본', runs: runsPlan.runs, substrateId, layerRepeats,
  });

  // 산정 제외 단계 → 고객 항목명
  for (const e of mapped.extras) {
    addManual(e.kind === 'measurement' ? T.measure(e.process) : T.step(e.step, e.process, prettyFormula(e.material)));
  }

  // 반복 구간: 증착 외 단계가 끼거나, 구간 안 단계가 서로 다른 품목(장비)이면 담당자 확인
  if (g) {
    const inside = mapped.plan.steps.filter((s) => s.step >= g.from && s.step <= g.to);
    if (inside.some((s) => !DEPOSITION.includes(s.process))) addManual(T.repeatNonDep(g.from, g.to));
    else if (new Set(inside.map((s) => s.itemNo)).size > 1) addManual(T.repeatCross(g.from, g.to));
  }

  const result = mapped.items.length ? computeQuote(priceDb, { items: mapped.items, layers: mapped.layers }) : null;
  if (result && result.status !== '정상') addManual(T.pricing); // 입력은 검증했으니 남은 오류는 가격 자료 쪽

  const policyDays = Number((priceDb.policy ?? []).find((p) => p.key === 'quote_valid_days')?.value);
  const validDays = Number.isFinite(policyDays) && policyDays > 0 ? policyDays : null;

  /** @type {any} */
  let customer;
  if (manual.length || !result) customer = { kind: 'manual', manual };
  else {
    const total = /** @type {number} */ (result.total);
    customer = {
      kind: 'estimate',
      totalKrw: total,
      totalKrwText: `₩${total.toLocaleString('ko-KR')}`,
      totalUsdText: formatUsd(total, usdRate),
      usdRate,
      validDays,
      validUntil: validDays ? addDays(today, validDays) : null,
    };
  }

  const debug = {
    plan: mapped.plan,
    input: { items: mapped.items, layers: mapped.layers },
    result,
    extras: mapped.extras,
    flags: {
      samples: { count: sampleCount, runs: runsPlan.runs, manualAtOrAbove: SAMPLE_MANUAL_MIN, manual: runsPlan.manual },
      repeatGroup: g ? { ...g, layers: mapped.layers.filter((l) => l.repeat !== 1).map((l) => ({ itemNo: l.itemNo, order: l.order, repeat: l.repeat })) } : null,
      substrate: { ...substrate, row: undefined, chosen: substrateId },
      manual,
    },
  };
  return { customer, debug };
}

/** 고객 응답에 절대 들어가면 안 되는 키 — 테스트·게이트가 쓴다 */
export const FORBIDDEN_CUSTOMER_KEYS = ['unitPrice', 'supply', 'vat', 'cost', 'breakdown', 'recipeId', 'recipe_id',
  'equipmentId', 'equipment_id', 'substrateId', 'catalog_id', 'items', 'layers', 'markup', 'plan', 'result'];
