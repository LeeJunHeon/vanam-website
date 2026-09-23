// 고객 견적 폼 입력 → 엑셀(V3) 견적 입력 형식(items·layers) 변환. 순수 모듈 — DB·네트워크 없음.
//
// 견적 테스트 모드(/api/quote-estimate)가 쓴다. 폼은 "공정 시퀀스"(행 순서대로 공정·물질·값)를 받고,
// 엑셀은 "품목(가격 방식·회수·플라즈마…)"과 "층(레시피·두께·반복)"을 받는다. 그 사이를 여기서 잇는다.
//
// ⚠️ 판단을 지어내지 않는다.
//   - 레시피 후보가 여러 개인데 사람이 고르지 않았으면 고르지 않는다("장비 선택 필요").
//     임시 우선순위 규칙은 두지 않는다 — 장비 선택 규칙표는 관리자 자료가 오면 따로 만든다.
//   - 가격 데이터가 없는 공정(Ex-situ 플라즈마·어닐링·Evaporator·분석)은 금액에서 빼고 사유를 남긴다.
//   - 숫자로 읽히지 않는 값은 원문 그대로 넘긴다 → 엔진이 엑셀과 같은 오류 문구를 낸다.
//
// .js 인 이유: 서버(Workers)와 node 검증 스크립트(scripts/test-quote-map.mjs)가 빌드 없이 같이 쓴다.
import { materialValue } from './material-value.js';

export const MAX_ITEMS = 15;   // 엑셀 V3_견적입력 15~29행
export const MAX_LAYERS = 100; // 엑셀 V3_박막공정 2~101행

/** 가격이 계산되는 증착 공정 (폼 공정 이름 = 레시피 process_type) */
export const DEPOSITION = ['Sputter', 'ALD'];
/** 품목에 플라즈마 분으로 붙는 공정 */
export const PLASMA = 'PlasmaCleaning (In-situ)';

export const REASON = {
  noPrice: '가격 데이터 없음',
  noRecipe: '레시피 없음',
  chooseEquipment: '장비 선택 필요',
  noDeposition: '붙일 증착 품목 없음',
};

/** 변환을 거부할 때 던진다. API 는 400 으로 돌려준다. */
export class QuoteMapError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 엑셀 의미의 입력 변환: 빈칸 → null · 숫자로 읽히면 number(천 단위 쉼표 허용) · 그 외 원문.
 * 0 은 0 이다(빈칸이 아니다).
 * @param {unknown} v
 * @returns {string | number | null}
 */
export function conv(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  const t = String(v).trim();
  if (t === '') return null;
  if (/\d/.test(t) && /^-?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ''));
  return String(v);
}

/**
 * 두께: 쉼표·공백·'nm' 을 뺀 뒤 숫자면 number, 아니면 원문(엔진이 "두께: 양수 필요").
 * @param {unknown} v
 */
export function parseThickness(v) {
  if (v === null || v === undefined) return null;
  const raw = String(v);
  if (raw.trim() === '') return null;
  const s = raw.replace(/,/g, '').replace(/nm/gi, '').replace(/\s+/g, '');
  return /^-?\d+(?:\.\d+)?$/.test(s) || /^-?\.\d+$/.test(s) ? Number(s) : raw.trim();
}

/** 레시피 물질명에서 괄호 부분을 떼고 폼 value 로 정규화. 'AlN(Samsung)' → 'AlN' */
export const recipeMaterialValue = (name) => materialValue(String(name ?? '').replace(/\([^)]*\)/g, '').trim());

const isActive = (v) => v === true || v === 1 || v === '1';

/**
 * 폼의 (공정, 물질값) → 활성 레시피 후보.
 * @param {{recipe_id: string, material_name: string, process_type: string, equipment_id: string, method?: string, active?: unknown}[]} recipes
 * @returns {Record<string, {recipe_id: string, material_name: string, equipment_id: string, method: string}[]>}
 *   키는 `${공정}|${물질값}` (예: 'Sputter|Ti')
 */
export function recipeCandidates(recipes) {
  /** @type {Record<string, any[]>} */
  const out = {};
  for (const r of Array.isArray(recipes) ? recipes : []) {
    if (!isActive(r?.active)) continue;
    if (!DEPOSITION.includes(String(r.process_type))) continue;
    const key = `${r.process_type}|${recipeMaterialValue(r.material_name)}`;
    (out[key] ??= []).push({
      recipe_id: String(r.recipe_id),
      material_name: String(r.material_name ?? ''),
      equipment_id: String(r.equipment_id ?? ''),
      method: String(r.method ?? ''),
    });
  }
  return out;
}

/**
 * @typedef {object} FormStep 폼 공정 시퀀스 한 행 + 그 행의 테스트 입력
 * @property {string} process
 * @property {string} [material]
 * @property {string} [value]
 * @property {string} [unit]
 * @property {string} [etc]
 * @property {string} [recipeId]  후보가 여럿일 때 고른 레시피
 * @property {unknown} [repeat]   층 반복 (비우면 1)
 * @property {unknown} [tempC]    표시 온도 (비우면 레시피 기본)
 *
 * @typedef {object} FormInput
 * @property {FormStep[]} steps
 * @property {string[]} [measurements]
 * @property {unknown} [sampleCount]
 * @property {string} [delivery]
 * @property {{perRun?: unknown, runs?: unknown, margin?: string, directMarkup?: unknown,
 *   loadingMin?: unknown, setupMin?: unknown, waitMin?: unknown,
 *   substrateId?: string, substratePerRun?: unknown}} [test]
 */

/**
 * 회수: 직접 입력이 있으면 그 값, 없으면 ceil(샘플 수 ÷ 1회 투입 장수). 투입 장수가 비면 1회.
 * @param {FormInput} form
 */
export function runsOf(form) {
  const t = form.test ?? {};
  const direct = conv(t.runs);
  if (direct !== null) return direct;
  const per = conv(t.perRun);
  if (per === null) return 1;
  const n = conv(form.sampleCount);
  if (typeof n === 'number' && typeof per === 'number' && n > 0 && per > 0) return Math.ceil(n / per);
  return null; // 계산 불가 → 엔진이 "수량은 양수"
}

/**
 * 폼 입력 → { items, layers, plan, extras }.
 * @param {FormInput} form
 * @param {Parameters<typeof recipeCandidates>[0]} recipes
 */
export function mapFormToQuote(form, recipes) {
  const cands = recipeCandidates(recipes);
  const steps = Array.isArray(form?.steps) ? form.steps : [];
  const t = form?.test ?? {};

  /** @type {{no:number, equipmentId:string, process:string, materials:string[], etcs:string[], plasma:(number|string)[], layers:any[], stepNos:number[]}[]} */
  const groups = [];
  /** @type {{step:number|null, process:string, material:string, reason:string}[]} */
  const extras = [];
  /** @type {{step:number, process:string, material:string, role:string, itemNo:number|null, recipeId:string|null, reason:string|null}[]} */
  const planSteps = [];

  let cur = null;           // 이어 붙일 수 있는 현재 품목
  /** @type {{step:number, value:number|string|null, planIdx:number, process:string, material:string}[]} */
  let pendingPlasma = [];   // 다음 증착 품목을 기다리는 플라즈마

  const attachPlasma = (g) => {
    for (const p of pendingPlasma) {
      g.plasma.push(p.value);
      planSteps[p.planIdx].itemNo = g.no;
    }
    pendingPlasma = [];
  };

  steps.forEach((s, i) => {
    const stepNo = i + 1;
    const process = String(s?.process ?? '');
    const material = String(s?.material ?? '');
    const plan = { step: stepNo, process, material, role: 'extra', itemNo: null, recipeId: null, reason: null };
    planSteps.push(plan);

    if (process === PLASMA) {
      plan.role = 'plasma';
      pendingPlasma.push({ step: stepNo, value: conv(s?.value), planIdx: planSteps.length - 1, process, material });
      return; // 플라즈마는 품목을 끊지 않는다
    }

    const extra = (reason) => {
      plan.reason = reason;
      extras.push({ step: stepNo, process, material, reason });
      cur = null; // 사이에 낀 단계는 품목을 끊는다
    };

    if (!DEPOSITION.includes(process)) return extra(REASON.noPrice);

    const list = cands[`${process}|${materialValue(material)}`] ?? [];
    const chosen = String(s?.recipeId ?? '').trim();
    if (chosen && !list.some((r) => r.recipe_id === chosen)) {
      throw new QuoteMapError('bad_recipe', `${stepNo}단계: 선택한 레시피(${chosen})가 ${process} ${material} 후보가 아닙니다`);
    }
    if (list.length === 0) return extra(REASON.noRecipe);
    let recipe = null;
    if (chosen) recipe = list.find((r) => r.recipe_id === chosen);
    else if (list.length === 1) recipe = list[0];
    if (!recipe) return extra(REASON.chooseEquipment);

    plan.role = 'deposit';
    plan.recipeId = recipe.recipe_id;
    if (!cur || cur.equipmentId !== recipe.equipment_id) {
      cur = { no: groups.length + 1, equipmentId: recipe.equipment_id, process, materials: [], etcs: [], plasma: [], layers: [], stepNos: [] };
      groups.push(cur);
    }
    cur.materials.push(material);
    cur.stepNos.push(stepNo);
    const etc = String(s?.etc ?? '').trim();
    if (etc) cur.etcs.push(etc);
    const rep = conv(s?.repeat);
    cur.layers.push({
      itemNo: cur.no,
      order: cur.layers.length + 1,
      recipeId: recipe.recipe_id,
      thicknessNm: parseThickness(s?.value),
      repeat: rep === null ? 1 : rep,
      tempC: conv(s?.tempC),
    });
    plan.itemNo = cur.no;
    attachPlasma(cur);
  });

  // 뒤에 증착이 없는 플라즈마는 직전 품목에 붙인다. 품목이 하나도 없으면 산정 제외.
  if (pendingPlasma.length) {
    const last = groups[groups.length - 1];
    if (last) attachPlasma(last);
    else {
      for (const p of pendingPlasma) {
        planSteps[p.planIdx].reason = REASON.noDeposition;
        extras.push({ step: p.step, process: p.process, material: p.material, reason: REASON.noDeposition });
      }
      pendingPlasma = [];
    }
  }

  for (const m of Array.isArray(form?.measurements) ? form.measurements : []) {
    extras.push({ step: null, process: String(m), material: '', reason: REASON.noPrice });
  }

  const layerCount = groups.reduce((a, g) => a + g.layers.length, 0);
  if (groups.length > MAX_ITEMS) throw new QuoteMapError('too_many_items', `품목이 ${groups.length}개입니다(최대 ${MAX_ITEMS}개)`);
  if (layerCount > MAX_LAYERS) throw new QuoteMapError('too_many_layers', `층이 ${layerCount}개입니다(최대 ${MAX_LAYERS}개)`);

  const runs = runsOf(form ?? {});
  const purchase = String(form?.delivery ?? '') === 'purchase' && String(t.substrateId ?? '').trim() !== '';
  const subPerRun = conv(t.substratePerRun) ?? conv(t.perRun) ?? conv(form?.sampleCount);

  /** 플라즈마 분 합치기 — 숫자는 더하고, 숫자가 아닌 값이 있으면 그 원문을 그대로 넘긴다. */
  const plasmaMin = (vals) => {
    const bad = vals.find((v) => typeof v !== 'number' && v !== null);
    if (bad !== undefined) return bad;
    const nums = vals.filter((v) => typeof v === 'number');
    return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
  };

  const items = groups.map((g, gi) => {
    const hasPlasma = g.plasma.length > 0;
    const first = gi === 0 && purchase;
    return {
      no: g.no,
      name: `${g.process} ${g.materials.join('/')}`,
      extraSpec: g.etcs.length ? g.etcs.join('; ') : null,
      method: '박막자동',
      qty: runs,
      unit: '회',
      amount: null,
      vat: '별도',
      margin: String(t.margin ?? '').trim() || '기본',
      directMarkup: conv(t.directMarkup),
      plasma: hasPlasma ? 'Y' : 'N',
      plasmaMin: hasPlasma ? plasmaMin(g.plasma) : null,
      loadingMin: conv(t.loadingMin),
      setupMin: conv(t.setupMin),
      waitMin: conv(t.waitMin),
      // 같은 샘플이 여러 품목을 거쳐도 기판은 첫 증착 품목에서 한 번만 청구한다.
      substrateId: first ? String(t.substrateId).trim() : null,
      substratePerRun: first ? subPerRun : null,
      rawText: null,
    };
  });
  const layers = groups.flatMap((g) => g.layers);

  return {
    items,
    layers,
    plan: {
      runs,
      items: groups.map((g) => ({
        no: g.no, equipmentId: g.equipmentId, steps: g.stepNos,
        recipes: g.layers.map((l) => l.recipeId), plasma: g.plasma.length > 0,
      })),
      steps: planSteps,
    },
    extras,
  };
}
