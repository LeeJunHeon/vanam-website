// 견적 자동 계산 엔진 — 구글 시트 견적 파일(V3_SHEET_20260914)의 재현.
//
// 왜 옮겼는가: 견적 단가는 지금까지 구글 시트 수식으로만 존재했다.
// 시트는 사람이 열어야 계산되고, 수식 한 칸이 바뀌면 과거 견적을 다시 만들 수 없다.
// → 수식을 순수 함수로 옮겨 가격 DB(price_*)와 입력만으로 같은 숫자가 나오게 한다.
//
// ⚠️ **기준은 엑셀 수식이다.** 아래 구현은 다음 수식의 1:1 번역이며,
//    이름 뒤 괄호의 셀 주소가 원본이다. 고칠 때는 반드시 시트 수식을 먼저 본다.
//      V3_박막공정 G2(층 검증) · H2~AA2(층 파생·계산)
//      V3_계산    H2(품목 검증) · I2~AA2(품목 파생·계산) · B30(정책 상태) · B23:C27(한글 금액)
//      V3_견적입력 B8(견적 상태) · B9/F9/J9(합계)
//
// ⚠️ 엑셀의 '비움'과 0 은 뜻이 다르다. 비움 = DB 기본값, 0 = 0분/0원.
//    그래서 이 파일은 `isBlank`(비움)와 `isNum`(ISNUMBER)을 분리해 쓴다.
//    JS 의 `!x` / `x || 기본값` 은 0 을 비움으로 만들어버리므로 쓰지 않는다.
//
// ⚠️ .ts 가 아니라 .js 인 이유: material-value.js 와 같다 —
//    node 검증 스크립트와 Astro 가 빌드 없이 같은 파일을 그대로 import 해야 한다.
//
// 네트워크·DB·환경변수 접근이 전혀 없는 순수 함수다(테스트 가능성이 유일한 방어선이라서).

// ── 엑셀 의미론 ────────────────────────────────────────────────────────────

/** 엑셀의 빈 셀(`X=""`). null·undefined·빈 문자열만 비움이다 — 0 은 비움이 아니다. */
const isBlank = (v) => v === null || v === undefined || v === '';
/** 엑셀의 `X<>""` */
const notBlank = (v) => !isBlank(v);
/** 엑셀 ISNUMBER — 불리언은 숫자가 아니다. */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** 엑셀 MOD(x,1)=0 (정수인가) */
const isInt = (v) => isNum(v) && Number.isInteger(v);
/** 엑셀에서 `X=TRUE`. 시트는 불리언, D1 은 0/1 정수로 저장한다(스프레드시트도 1=TRUE). */
const isTrue = (v) => v === true || v === 1;
/** 엑셀에서 `X=FALSE` */
const isFalse = (v) => v === false || v === 0;
/** 엑셀 INDEX 가 빈 셀에서 돌려주는 값을 문자열로 통일 */
const asText = (v) => (isBlank(v) ? '' : String(v));

/**
 * 부동소수 오차 제거 — 엑셀은 15자리 유효숫자로 표시·비교한다.
 * 이걸 안 하면 343999.99999999994 가 FLOOR 에서 344000 대신 343000 이 된다.
 * @param {number} x
 */
const fix = (x) => Number(x.toFixed(9));

/** 엑셀 FLOOR(x, unit) — unit 배수로 내림. @param {number} x @param {number} u */
function FLOOR(x, u) {
  return Math.floor(fix(fix(x) / u)) * u;
}

/** 엑셀 ROUND(x, 0) — 0.5 는 0에서 먼 쪽으로(JS Math.round 와 음수에서 다르다). @param {number} x */
function ROUND(x) {
  const v = fix(x);
  return Math.sign(v) * Math.round(Math.abs(v));
}

/** 숫자만 골라 최대값. 엑셀 MAXIFS 는 텍스트("")를 무시하고, 대상이 없으면 0 이다. */
const maxNum = (xs) => { const n = xs.filter(isNum); return n.length ? Math.max(...n) : 0; };
/** 엑셀 MINIFS — 위와 같은 규칙 */
const minNum = (xs) => { const n = xs.filter(isNum); return n.length ? Math.min(...n) : 0; };
/** 엑셀 SUMIF — 텍스트는 0 으로 본다. */
const sumNum = (xs) => xs.reduce((a, b) => a + (isNum(b) ? b : 0), 0);

/** 엑셀 `숫자 & "문자"` 의 숫자 표기(일반 서식). 우리 값 범위에서는 String 과 같다. */
const numText = (v) => (isNum(v) ? String(v) : asText(v));

// ── 가격 정책 ──────────────────────────────────────────────────────────────

/**
 * V3_계산!B30 이 확인하는 필수 키. 하나라도 없거나 둘 이상이면 계산을 멈춘다.
 * (INDEX/MATCH 는 중복 키에서 첫 줄만 집어 조용히 틀린 값을 쓰기 때문)
 */
export const REQUIRED_POLICY_KEYS = [
  'default_tax_rate', 'markup_default', 'markup_research', 'markup_special',
  'material_charge_basis_nm', 'material_tier1_limit', 'material_tier1_amount',
  'material_tier2_limit', 'material_tier2_amount', 'film_rounding_unit',
  'direct_price_markup_enabled', 'direct_price_rounding', 'film_unit_price_rounding', 'currency',
];

/**
 * 정책 한 줄의 값을 원래 타입으로 되돌린다.
 *
 * 왜 필요한가: 같은 정책이 두 경로로 들어온다 —
 *   ① 엑셀에서 바로 읽은 값(숫자·불리언 그대로)
 *   ② D1 price_policy(전부 TEXT + vtype)
 * 엑셀 검증은 ①과 ②가 **같은 숫자**를 내야 통과다. vtype 이 있으면 그걸 따르고,
 * 없으면 이미 원래 타입이라고 본다. 문자열을 멋대로 숫자로 바꾸지 않는다
 * (엑셀 ISNUMBER 는 "0.1" 과 0.1 을 다르게 보고, 그 차이가 오류 문구를 만든다).
 * @param {{value: unknown, vtype?: string|null}} row
 */
function policyValueOf(row) {
  const { value, vtype } = row;
  if (vtype === 'number') return isBlank(value) ? '' : Number(value);
  if (vtype === 'boolean') return value === true || /^true$/i.test(String(value ?? ''));
  return value;
}

/** 정책 배열 → 키 조회기. 중복을 셀 수 있어야 해서 배열을 그대로 받는다. */
function policyIndex(policy) {
  const list = Array.isArray(policy) ? policy : [];
  /** @type {Map<string, unknown[]>} */
  const byKey = new Map();
  for (const row of list) {
    const k = asText(row?.key);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(policyValueOf(row ?? {}));
  }
  return {
    /** 엑셀 COUNTIF(정책!A:A, key) */
    count: (k) => byKey.get(k)?.length ?? 0,
    /** 엑셀 INDEX/MATCH — 첫 줄. 없으면 비움('') */
    get: (k) => { const a = byKey.get(k); return a && a.length ? a[0] : ''; },
  };
}

/**
 * V3_계산!B30 — 가격 정책 상태. 순서가 곧 우선순위다(첫 번째 문제만 알린다).
 * @param {ReturnType<typeof policyIndex>} pol
 */
function policyStatusOf(pol) {
  for (const k of REQUIRED_POLICY_KEYS) if (pol.count(k) !== 1) return '정책 키 누락 또는 중복';

  // 세율·마진 3종·구간 4값은 0 이상, 기준두께와 절삭 단위는 0 초과여야 한다.
  /** @type {[string, (v: number) => boolean][]} */
  const numeric = [
    ['default_tax_rate', (v) => v >= 0],
    ['markup_default', (v) => v >= 0],
    ['markup_research', (v) => v >= 0],
    ['markup_special', (v) => v >= 0],
    ['material_charge_basis_nm', (v) => v > 0],
    ['material_tier1_limit', (v) => v >= 0],
    ['material_tier1_amount', (v) => v >= 0],
    ['material_tier2_limit', (v) => v >= 0],
    ['material_tier2_amount', (v) => v >= 0],
    ['film_rounding_unit', (v) => v > 0],
  ];
  for (const [k, ok] of numeric) {
    const v = pol.get(k);
    if (isBlank(v) || !isNum(v) || !ok(v)) return '가격 정책 숫자 확인';
  }
  if (pol.get('material_tier2_limit') < pol.get('material_tier1_limit')) return '재료비 구간 순서 확인';

  // 이 엔진은 시트가 쓰던 조합만 계산한다. 다른 조합은 "조용히 다른 금액"이 되므로 막는다.
  if (!(isFalse(pol.get('direct_price_markup_enabled'))
    && pol.get('direct_price_rounding') === 'PRESERVE_ENTERED_AMOUNT'
    && pol.get('film_unit_price_rounding') === 'FLOOR_1000'
    && pol.get('currency') === 'KRW')) return '지원하지 않는 가격 정책';
  return '정상';
}

// ── DB 조회 ────────────────────────────────────────────────────────────────

/** ID 별 행 목록(중복까지 보존 — COUNTIF<>1 검사가 중복을 잡아야 한다). */
function indexBy(rows, idKey) {
  /** @type {Map<string, any[]>} */
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const k = asText(r?.[idKey]);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return {
    count: (k) => m.get(asText(k))?.length ?? 0,
    /** 정확히 1개일 때만 돌려준다(2개 이상이면 어느 쪽인지 알 수 없다). */
    one: (k) => { const a = m.get(asText(k)); return a && a.length === 1 ? a[0] : null; },
  };
}

// ── 한글 금액 (V3_계산!B23:C27) ────────────────────────────────────────────

const KOREAN_DIGIT = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const KOREAN_PLACE = ['천', '백', '십', ''];

/** 4자리 묶음 하나를 읽는다. 1도 "일"을 붙인다(110 → 일백일십). @param {number} n 0~9999 */
function koreanGroup(n) {
  const d = String(n).padStart(4, '0');
  let s = '';
  for (let i = 0; i < 4; i++) {
    const x = Number(d[i]);
    if (x !== 0) s += KOREAN_DIGIT[x] + KOREAN_PLACE[i];
  }
  return s;
}

/**
 * 합계를 조·억·만·원 4자리 묶음으로 읽는다. 0 은 "영".
 * @param {number} total
 * @returns {string} 1203300 → '일백이십만삼천삼백'
 */
export function koreanAmount(total) {
  if (!isNum(total)) return '';
  if (total === 0) return '영';
  /** @type {[number, string][]} */
  const groups = [
    [Math.trunc(total / 1e12) % 10000, '조'],
    [Math.trunc(total / 1e8) % 10000, '억'],
    [Math.trunc(total / 1e4) % 10000, '만'],
    [Math.trunc(total) % 10000, ''],
  ];
  return groups.map(([v, suffix]) => (v === 0 ? '' : koreanGroup(v) + suffix)).join('');
}

// ── 층 (V3_박막공정) ───────────────────────────────────────────────────────

/**
 * @typedef {object} LayerInput
 * @property {number|null} [itemNo]      품목 번호 (A)
 * @property {number|null} [order]       층 순서 (B)
 * @property {string|null} [recipeId]    레시피 ID (C)
 * @property {number|null} [thicknessNm] 두께 nm (D)
 * @property {number|null} [repeat]      층 반복 (E)
 * @property {number|null} [tempC]       표시 온도 °C (F) — 비우면 레시피 기본값
 */

/**
 * @typedef {object} ItemInput
 * @property {number|null} [no]          번호 (A)
 * @property {string|null} [name]        품명 (B)
 * @property {string|null} [extraSpec]   추가 규격 (C)
 * @property {string|null} [method]      가격 방식 (D) 박막자동|단가입력|총액입력
 * @property {number|null} [qty]         수량 (E)
 * @property {string|null} [unit]        단위 (F)
 * @property {number|null} [amount]      입력 금액 (G)
 * @property {string|null} [vat]         부가세 기준 (H) 별도|포함
 * @property {string|null} [margin]      마진 구분 (I) 기본|연구소_대학_할인|특수물질|직접입력
 * @property {number|null} [directMarkup] 직접 가산율 (J)
 * @property {string|null} [plasma]      플라즈마 (K) Y|N
 * @property {number|null} [plasmaMin]   플라즈마 분 (L)
 * @property {number|null} [loadingMin]  로딩 분 (M)
 * @property {number|null} [setupMin]    셋업 분 (N)
 * @property {number|null} [waitMin]     대기 분 (O)
 * @property {string|null} [substrateId] 기판 ID (P)
 * @property {number|null} [substratePerRun] 기판 장수/회 (Q)
 * @property {string|null} [rawText]     입력 원문 (R)
 */

/** 견적입력 B15:R15 가 전부 비었는가(COUNTA=0). 번호(A)는 세지 않는다. */
const ITEM_CONTENT_FIELDS = ['name', 'extraSpec', 'method', 'qty', 'unit', 'amount', 'vat',
  'margin', 'directMarkup', 'plasma', 'plasmaMin', 'loadingMin', 'setupMin', 'waitMin',
  'substrateId', 'substratePerRun', 'rawText'];
/** 직접 금액 품목에서 비어 있어야 하는 칸 (견적입력 I15:Q15) */
const DIRECT_FORBIDDEN_FIELDS = ['margin', 'directMarkup', 'plasma', 'plasmaMin', 'loadingMin',
  'setupMin', 'waitMin', 'substrateId', 'substratePerRun'];

/** 박막공정 A2:F2 가 전부 비었는가(COUNTA=0) */
const LAYER_CONTENT_FIELDS = ['itemNo', 'order', 'recipeId', 'thicknessNm', 'repeat', 'tempC'];

const isEmptyRow = (row, fields) => fields.every((f) => isBlank(row?.[f]));

/**
 * 층의 DB 파생값 (V3_박막공정 H2:R2, Y2). 검증 전에 계산한다 — 검증이 이 값을 본다.
 */
function layerDerived(layer, recipes, equipment) {
  const recipeId = layer.recipeId;
  const rOk = notBlank(recipeId) && recipes.count(recipeId) === 1;
  const rec = rOk ? recipes.one(recipeId) : null;

  const equipmentId = rOk ? asText(rec.equipment_id) : '';         // H
  const eOk = notBlank(equipmentId) && equipment.count(equipmentId) === 1;
  const eq = eOk ? equipment.one(equipmentId) : null;

  const blankOr = (v) => (isBlank(v) ? '' : v);
  // 레시피 override 가 '비어 있지 않으면' 그것, 아니면 장비 기본값 (P2/Q2/R2)
  const override = (recKey, eqKey) => {
    if (!eOk) return '';
    const ov = rec?.[recKey];
    return notBlank(ov) ? ov : blankOr(eq?.[eqKey]);
  };

  return {
    equipmentId,                                                    // H
    materialName: rOk ? asText(rec.material_name) : '',             // I
    processType: rOk ? asText(rec.process_type) : '',               // J
    method: rOk ? asText(rec.method) : '',                          // K
    // L: 표시 온도를 넣었으면 그것(0 도 유효), 아니면 레시피 기본 온도
    tempApplied: rOk ? (notBlank(layer.tempC) ? layer.tempC : blankOr(rec.default_temp_c)) : '',
    materialCostPerNm: rOk ? blankOr(rec.material_cost_per_nm) : '', // M
    growthNmPerMin: rOk ? blankOr(rec.growth_nm_per_min) : '',       // N
    ratePerMin: eOk ? blankOr(eq.rate_per_min) : '',                 // O
    loadingDefaultMin: override('loading_override_min', 'default_loading_min'), // P
    plasmaDefaultMin: override('plasma_override_min', 'default_plasma_min'),    // Q
    setupDefaultMin: override('setup_override_min', 'default_setup_min'),       // R
    legacyMinCharge: rOk ? blankOr(rec.legacy_min_charge) : '',      // Y (현재 정책 미적용)
    _recipe: rec, _equipment: eq, _recipeOk: rOk, _equipmentOk: eOk,
  };
}

/**
 * V3_박막공정!G2 — 층 검증. 순서가 우선순위다(첫 번째 문구만 돌려준다).
 */
function layerStatusOf(layer, d, ctx) {
  const { policyStatus, layers, recipes, equipment, itemByNo } = ctx;
  if (isEmptyRow(layer, LAYER_CONTENT_FIELDS)) return '';

  const no = layer.itemNo;
  if (!(isNum(no) && no >= 1 && no <= 15 && isInt(no))) return '품목 번호는 1~15 정수';
  if (policyStatus !== '정상') return '가격 정책 확인';
  if (!(isNum(layer.order) && layer.order > 0)) return '층 순서: 양의 정수 필요';
  if (!isInt(layer.order)) return '층 순서: 정수 필요';
  // COUNTIFS(품목, 순서) — 자기 자신을 포함해 정확히 1이어야 한다
  if (layers.filter((l) => l.itemNo === no && l.order === layer.order).length !== 1) {
    return '같은 품목의 층 순서 중복';
  }
  if (isBlank(layer.recipeId)) return '레시피 ID 필요';
  if (recipes.count(layer.recipeId) === 0) return '등록되지 않은 레시피';
  if (recipes.count(layer.recipeId) > 1) return '레시피 ID 중복';
  if (!(isNum(layer.thicknessNm) && layer.thicknessNm > 0)) return '두께: 양수 필요';
  if (!(isNum(layer.repeat) && layer.repeat > 0)) return '층 반복: 양의 정수 필요';
  if (!isInt(layer.repeat)) return '층 반복: 정수 필요';
  if (notBlank(layer.tempC) && !isNum(layer.tempC)) return '표시 온도: 숫자 필요';

  // 연결된 견적 품목 쪽 확인 (INDEX('V3_견적입력'!D/B, 품목번호))
  const item = itemByNo.get(no);
  if (asText(item?.method) !== '박막자동') return '해당 품목이 박막자동 아님';
  if (isBlank(item?.name)) return '해당 견적 품명이 비어 있음';

  if (d._recipeOk && !isTrue(d._recipe.active)) return '사용 중지 레시피';
  if (equipment.count(d.equipmentId) !== 1) return '장비 ID 누락 또는 중복';
  if (!isTrue(d._equipment.active)) return '사용 중지 장비';
  if (asText(d._equipment.process_type) !== d.processType) return '레시피와 장비 공정 불일치';

  if (!(isNum(d.materialCostPerNm) && d.materialCostPerNm >= 0)) return '재료 원가 확인 필요';
  if (!(isNum(d.growthNmPerMin) && d.growthNmPerMin > 0)) return '증착속도 확인 필요';
  if (!(isNum(d.ratePerMin) && d.ratePerMin >= 0)) return '장비요율 확인 필요';
  // P·Q·R 순서 = 로딩·플라즈마·셋업 (엑셀과 동일)
  if (!(isNum(d.loadingDefaultMin) && d.loadingDefaultMin >= 0)) return '장비 기본시간 확인 필요';
  if (!(isNum(d.plasmaDefaultMin) && d.plasmaDefaultMin >= 0)) return '장비 기본시간 확인 필요';
  if (!(isNum(d.setupDefaultMin) && d.setupDefaultMin >= 0)) return '장비 기본시간 확인 필요';
  return '정상';
}

/** V3_박막공정!S2:X2, Z2 — 층 계산. 검증이 '정상'일 때만 채운다. */
function layerCompute(layer, d, pol) {
  const basis = pol.get('material_charge_basis_nm');
  const basisCost = d.materialCostPerNm * basis;                    // S 기준두께 원가
  // T 구간 단가: 0원이면 0, 1구간·2구간 한도 안이면 정액, 넘으면 실제 원가
  const tierAmount = basisCost === 0 ? 0
    : basisCost <= pol.get('material_tier1_limit') ? pol.get('material_tier1_amount')
      : basisCost <= pol.get('material_tier2_limit') ? pol.get('material_tier2_amount')
        : basisCost;
  const tierCount = Math.ceil(layer.thicknessNm / basis);           // U 구간 수 (CEILING)
  // V 재료비/회 — RAW_PER_NM 은 두께 비례, TIER_100NM 은 구간 정액 × 구간 수
  const materialCost = pol.get('material_pricing_policy') === 'RAW_PER_NM'
    ? d.materialCostPerNm * layer.thicknessNm * layer.repeat
    : tierAmount * tierCount * layer.repeat;
  const depositMin = layer.thicknessNm / d.growthNmPerMin * layer.repeat; // W 증착시간 분/회
  const depositCost = depositMin * d.ratePerMin;                    // X 증착장비비/회

  // Z 출력 규격: Sputter/ALD 는 방법(DC Power 등)을 붙이지 않는다. 30°C 는 R.T 로 읽는다.
  const proc = d.processType.toUpperCase();
  const spec = d.materialName + ' ' + numText(layer.thicknessNm) + ' nm'
    + (proc === 'SPUTTER' || proc === 'ALD' ? '' : (d.method === '' ? '' : ' (' + d.method + ')'))
    + (layer.repeat === 1 ? '' : ' × ' + numText(layer.repeat))
    + (isBlank(d.tempApplied) ? '' : ' / ' + (d.tempApplied === 30 ? 'R.T' : numText(d.tempApplied) + '°C'));

  return { basisCost, tierAmount, tierCount, materialCost, depositMin, depositCost, spec };
}

// ── 품목 (V3_계산) ─────────────────────────────────────────────────────────

/** V3_계산!I2:S2, U2, AC2:AE2 — 품목의 층 집계·공정 시간·요율·기판원가·가산율. */
function itemDerived(item, ctx) {
  const { pol, layerRows, equipment, substrates } = ctx;
  const film = asText(item.method) === '박막자동';
  const blank = { layerCount: '', equipmentId: '', materialCost: '', depositMin: '', depositCost: '',
    loadingMin: '', setupMin: '', plasmaMin: '', waitMin: '', ratePerMin: '', substrateCost: '',
    markup: '', sameEquipmentLayers: '', errorLayers: '' };
  if (!film) return { film, ...blank };

  const mine = layerRows.filter((r) => r.layer.itemNo === item.no); // 입력 순서 유지
  const layerCount = mine.length;                                   // I
  const first = mine[0];
  const equipmentId = layerCount === 0 ? '' : first.derived.equipmentId; // J (AC2 = 첫 공정 행)

  // MAXIFS/MINIFS 는 텍스트를 무시한다 — 오류 층의 ''는 자동으로 빠진다.
  const loadDefaults = mine.map((r) => r.derived.loadingDefaultMin);
  const setupDefaults = mine.map((r) => r.derived.setupDefaultMin);
  const plasmaDefaults = mine.map((r) => r.derived.plasmaDefaultMin);

  const eqOne = equipment.count(equipmentId) === 1 ? equipment.one(equipmentId) : null;
  const subId = item.substrateId;
  const subOne = notBlank(subId) && substrates.count(subId) === 1 ? substrates.one(subId) : null;

  return {
    film,
    layerCount,                                                              // I
    equipmentId,                                                             // J
    materialCost: sumNum(mine.map((r) => r.materialCost)),                   // K
    depositMin: sumNum(mine.map((r) => r.depositMin)),                       // L
    depositCost: sumNum(mine.map((r) => r.depositCost)),                     // M
    // N/O: 입력값이 '비어 있지 않으면' 그 값(0 포함), 아니면 층별 기본값의 최대
    loadingMin: notBlank(item.loadingMin) ? item.loadingMin : (layerCount === 0 ? 0 : maxNum(loadDefaults)),
    setupMin: notBlank(item.setupMin) ? item.setupMin : (layerCount === 0 ? 0 : maxNum(setupDefaults)),
    // P: 플라즈마 N 이면 무조건 0. Y 면 입력값, 비었으면 층별 기본값의 최대
    plasmaMin: asText(item.plasma) === 'N' ? 0
      : notBlank(item.plasmaMin) ? item.plasmaMin : (layerCount === 0 ? 0 : maxNum(plasmaDefaults)),
    waitMin: isBlank(item.waitMin) ? 0 : item.waitMin,                       // Q
    ratePerMin: eqOne ? (isBlank(eqOne.rate_per_min) ? '' : eqOne.rate_per_min) : '', // R
    // S: 기판 ID 가 비면 0. 있으면 (DB 1건 + 장수 숫자)일 때만 낱장원가 × 장수
    substrateCost: isBlank(subId) ? 0
      : (subOne && isNum(item.substratePerRun) ? subOne.cost_per_unit * item.substratePerRun : ''),
    markup: markupOf(item, pol),                                             // U
    sameEquipmentLayers: mine.filter((r) => r.derived.equipmentId === equipmentId).length, // AD
    errorLayers: mine.filter((r) => r.status !== '정상').length,              // AE
    _layers: mine, _loadDefaults: loadDefaults, _setupDefaults: setupDefaults, _substrate: subOne,
  };
}

/** V3_계산!U2 — 가산율. 직접입력이면 입력값(비우면 비움), 아니면 정책값. */
function markupOf(item, pol) {
  const m = asText(item.margin);
  if (m === '직접입력') return isBlank(item.directMarkup) ? '' : item.directMarkup;
  if (m === '기본') return pol.get('markup_default');
  if (m === '연구소_대학_할인') return pol.get('markup_research');
  if (m === '특수물질') return pol.get('markup_special');
  return '';
}

/** V3_계산!H2 — 품목 검증. 공통 → 방식별. 순서가 우선순위다. */
function itemStatusOf(item, d, ctx) {
  const { pol, policyStatus, items, layerRows } = ctx;
  if (isEmptyRow(item, ITEM_CONTENT_FIELDS)) return '';

  const method = asText(item.method);
  // 엑셀은 행마다 번호가 못 박혀 있어 A2<>1 로 검사한다. 엔진은 배열이라
  // 같은 뜻이 "1~15 정수이고 서로 겹치지 않는다"가 된다.
  const noOk = isNum(item.no) && item.no >= 1 && item.no <= 15 && isInt(item.no)
    && items.filter((x) => x.no === item.no).length === 1;
  if (!noOk) return '품목 번호 변경 금지';
  if (isBlank(item.name)) return '품명 필요';
  if (method !== '박막자동' && method !== '단가입력' && method !== '총액입력') return '가격 방식 확인';
  if (!(isNum(item.qty) && item.qty > 0)) return '수량은 양수';
  if (isBlank(item.unit)) return '단위 필요';
  const vat = asText(item.vat);
  if (vat !== '별도' && vat !== '포함') return '부가세 기준 확인';
  const taxRate = pol.get('default_tax_rate');
  if (pol.count('default_tax_rate') !== 1 || !isNum(taxRate) || taxRate < 0) return '부가세율 확인 필요';
  if (policyStatus !== '정상') return '가격 정책 확인';

  if (method === '박막자동') {
    if (policyStatus !== '정상') return '가격 정책 확인';
    if (asText(item.unit) !== '회') return '박막 수량 단위는 회';
    if (!isInt(item.qty)) return '박막 횟수는 정수';
    if (vat !== '별도') return '박막자동은 부가세 별도 계산';
    if (notBlank(item.amount)) return '박막자동 입력 금액은 비워주세요';
    if (d.layerCount === 0) return '박막공정 입력 필요';
    if (d.errorLayers > 0) return '박막공정 오류 확인';
    if (d.sameEquipmentLayers !== d.layerCount) return '서로 다른 장비는 품목을 나누세요';
    if (!(isNum(d.markup) && d.markup >= 0)) return '마진 구분/직접 가산율 확인';
    if (asText(item.margin) !== '직접입력' && notBlank(item.directMarkup)) return '직접 가산율은 직접입력 선택 시 사용';
    const plasma = asText(item.plasma);
    if (plasma !== 'Y' && plasma !== 'N') return '플라즈마 Y/N 확인';
    if (plasma === 'N' && notBlank(item.plasmaMin) && item.plasmaMin !== 0) return '플라즈마 N인데 시간이 입력됨';
    for (const t of [d.loadingMin, d.setupMin, d.plasmaMin, d.waitMin]) {
      if (!(isNum(t) && t >= 0)) return '공정 시간은 0 이상 숫자';
    }
    const subId = item.substrateId;
    const perRun = item.substratePerRun;
    if (isBlank(subId) && notBlank(perRun) && perRun !== 0) return '기판 ID 필요';
    if (notBlank(subId)) {
      if (ctx.substrates.count(subId) !== 1) return '기판 ID 누락 또는 중복';
      if (!(isNum(perRun) && perRun > 0)) return '기판 장수/회는 양수';
      if (!isInt(perRun)) return '기판 장수는 정수';
      const sub = d._substrate;
      if (!isTrue(sub.active)) return '사용 중지 기판';
      const cost = sub.cost_per_unit;
      if (isBlank(cost) || !isNum(cost) || cost < 0) return '기판 원가 확인 필요';
    }
    // 정책 확정 대기 항목 — 값이 바뀌면 금액이 달라지므로 계산을 멈춘다.
    if (!isFalse(pol.get('minimum_charge_enabled'))) return '최소청구 정책 확정 필요';
    const mp = pol.get('material_pricing_policy');
    if (mp !== 'TIER_100NM' && mp !== 'RAW_PER_NM') return '재료비 정책 확인';
    // 다층에서 층별 기본값이 서로 다르면 "어느 쪽을 1회 청구할지" 사람이 정해야 한다.
    if (d.layerCount > 1 && isBlank(item.loadingMin)
      && maxNum(d._loadDefaults) !== minNum(d._loadDefaults)) return '다층 공통 로딩 분을 지정하세요';
    if (d.layerCount > 1 && isBlank(item.setupMin)
      && maxNum(d._setupDefaults) !== minNum(d._setupDefaults)) return '다층 공통 셋업 분을 지정하세요';
    return '정상';
  }

  // 단가입력 · 총액입력
  if (!(isNum(item.amount) && item.amount >= 0)) return '입력 금액은 0 이상 숫자';
  if (!isInt(item.amount)) return '입력 금액은 원 단위 정수';
  if (DIRECT_FORBIDDEN_FIELDS.some((f) => notBlank(item[f]))) return '직접 금액 품목의 공정/마진 칸은 비워주세요';
  if (layerRows.some((r) => r.layer.itemNo === item.no)) return '직접 금액 품목에 박막공정이 연결됨';
  return '정상';
}

/** V3_계산!T2:AA2, AB2 — 품목 계산. 검증이 '정상'일 때만 금액을 채운다. */
function itemCompute(item, d, status, pol) {
  const method = asText(item.method);
  const vat = asText(item.vat);
  const taxRate = pol.get('default_tax_rate');
  const film = method === '박막자동';

  // T·V·W: 원가 → 가산 → 절삭 전 단가 (박막자동 + 정상일 때만)
  const cost = film && status === '정상'
    ? d.materialCost + d.depositCost + (d.loadingMin + d.setupMin + d.plasmaMin + d.waitMin) * d.ratePerMin + d.substrateCost
    : '';
  const markupAmount = film && status === '정상' ? cost * d.markup : '';
  const priceBeforeFloor = film && status === '정상' ? cost + markupAmount : '';

  if (status !== '정상') {
    return { unitPrice: '', supply: '', vatAmount: '', total: '', spec: '', cost, markupAmount, priceBeforeFloor };
  }

  // X 공급 단가: 박막은 천원 절삭. 직접 금액은 포함이면 세액을 빼고, 총액입력은 수량으로 나눈다.
  const unitPrice = film
    ? FLOOR(priceBeforeFloor, pol.get('film_rounding_unit'))
    : (vat === '포함' ? item.amount / (1 + taxRate) : item.amount) / (method === '총액입력' ? item.qty : 1);
  const supply = ROUND(unitPrice * item.qty);                            // Y
  // Z 세액: 직접 금액 + 부가세 포함이면 "입력 총액 − 공급가액"으로 총액을 보존한다.
  const vatAmount = !film && vat === '포함'
    ? ROUND(item.amount * (method === '단가입력' ? item.qty : 1)) - supply
    : ROUND(supply * taxRate);
  const total = supply + vatAmount;                                      // AA

  // AB 출력 규격: 층 규격을 입력 순서대로 줄바꿈 연결(빈 것은 건너뜀)
  const spec = film
    ? [...d._layers.map((r) => r.spec).filter((s) => s !== ''),
      ...(d.plasmaMin > 0 ? [`Plasma Cleaning: ${numText(d.plasmaMin)} min`] : []),
      ...(d.waitMin > 0 ? [`Waiting: ${numText(d.waitMin)} min`] : []),
      ...(isBlank(item.extraSpec) ? [] : [asText(item.extraSpec)])].join('\n')
    : asText(item.extraSpec);

  return { unitPrice, supply, vatAmount, total, spec, cost, markupAmount, priceBeforeFloor };
}

// ── 공개 API ───────────────────────────────────────────────────────────────

/** 엑셀의 빈 결과('')는 JSON 에서 null 로 내보낸다. */
const out = (v) => (v === '' ? null : v);

/**
 * 견적 한 건을 계산한다. 순수 함수 — 같은 입력이면 항상 같은 결과.
 *
 * @param {{policy: {key: string, value: unknown, vtype?: string|null}[],
 *          recipes: any[], equipment: any[], substrates: any[]}} priceDb
 *   가격 DB. 중복 검사를 해야 해서 맵이 아니라 배열로 받는다.
 * @param {{items?: ItemInput[], layers?: LayerInput[]}} quote
 * @returns {{status: string, policyStatus: string,
 *            supply: number|null, vat: number|null, total: number|null, totalKorean: string|null,
 *            items: any[], layers: any[]}}
 */
export function computeQuote(priceDb, quote) {
  const pol = policyIndex(priceDb?.policy);
  const policyStatus = policyStatusOf(pol);
  const recipes = indexBy(priceDb?.recipes, 'recipe_id');
  const equipment = indexBy(priceDb?.equipment, 'equipment_id');
  const substrates = indexBy(priceDb?.substrates, 'catalog_id');

  const items = (Array.isArray(quote?.items) ? quote.items : []).map((x) => ({ ...x }));
  const layers = (Array.isArray(quote?.layers) ? quote.layers : []).map((x) => ({ ...x }));

  // 층이 품목의 가격 방식·품명을 보고, 품목이 층의 집계를 본다.
  // 한쪽만 방향이 있어 순환은 없다: 층 검증(G) → 품목 파생(I~) → 품목 검증(H).
  const itemByNo = new Map();
  for (const it of items) if (!itemByNo.has(it.no)) itemByNo.set(it.no, it);

  // ① 층: DB 파생 → 검증 → 계산
  const layerRows = layers.map((layer) => {
    const derived = layerDerived(layer, recipes, equipment);
    const status = layerStatusOf(layer, derived, { policyStatus, layers, recipes, equipment, itemByNo });
    const computed = status === '정상' ? layerCompute(layer, derived, pol)
      : { basisCost: '', tierAmount: '', tierCount: '', materialCost: '', depositMin: '', depositCost: '', spec: '' };
    return { layer, derived, status, ...computed };
  });

  // ② 품목: 층 집계 → 검증 → 계산
  const ctx = { pol, policyStatus, items, layerRows, equipment, substrates };
  const itemRows = items.map((item) => {
    const d = itemDerived(item, ctx);
    const status = itemStatusOf(item, d, ctx);
    return { item, d, status, ...itemCompute(item, d, status, pol) };
  });

  // ③ 견적 상태 (V3_견적입력!B8) — 오류가 하나라도 있으면 금액을 내보내지 않는다.
  const layerFilled = layerRows.filter((r) => r.status !== '');
  const itemFilled = itemRows.filter((r) => r.status !== '');
  let status;
  if (itemFilled.length === 0) status = '입력 대기';
  else if (layerFilled.length !== layerFilled.filter((r) => r.status === '정상').length) status = '공정 입력 확인';
  else if (itemFilled.length !== itemFilled.filter((r) => r.status === '정상').length) status = '품목 입력 확인';
  else status = '정상';

  const ok = status === '정상';
  const supply = ok ? sumNum(itemRows.map((r) => r.supply)) : null;
  const vat = ok ? sumNum(itemRows.map((r) => r.vatAmount)) : null;
  const total = ok ? sumNum(itemRows.map((r) => r.total)) : null;

  return {
    status,
    policyStatus,
    supply,
    vat,
    total,
    totalKorean: ok ? koreanAmount(total) : null,
    items: itemRows.map((r) => ({
      no: r.item.no ?? null,
      status: r.status,
      unitPrice: out(r.unitPrice),
      supply: out(r.supply),
      vat: out(r.vatAmount),
      total: out(r.total),
      spec: r.spec,
      breakdown: {
        layerCount: out(r.d.layerCount),              // I
        equipmentId: out(r.d.equipmentId),            // J
        materialCost: out(r.d.materialCost),          // K
        depositMin: out(r.d.depositMin),              // L
        depositCost: out(r.d.depositCost),            // M
        loadingMin: out(r.d.loadingMin),              // N
        setupMin: out(r.d.setupMin),                  // O
        plasmaMin: out(r.d.plasmaMin),                // P
        waitMin: out(r.d.waitMin),                    // Q
        ratePerMin: out(r.d.ratePerMin),              // R
        substrateCost: out(r.d.substrateCost),        // S
        cost: out(r.cost),                            // T
        markup: out(r.d.markup),                      // U
        markupAmount: out(r.markupAmount),            // V
        priceBeforeFloor: out(r.priceBeforeFloor),    // W
      },
    })),
    layers: layerRows.map((r) => ({
      itemNo: r.layer.itemNo ?? null,
      order: r.layer.order ?? null,
      recipeId: r.layer.recipeId ?? null,
      thicknessNm: r.layer.thicknessNm ?? null,
      repeat: r.layer.repeat ?? null,
      tempC: r.layer.tempC ?? null,
      status: r.status,
      spec: r.spec,
      equipmentId: out(r.derived.equipmentId),        // H
      materialName: out(r.derived.materialName),      // I
      processType: out(r.derived.processType),        // J
      method: out(r.derived.method),                  // K
      tempApplied: out(r.derived.tempApplied),        // L
      materialCostPerNm: out(r.derived.materialCostPerNm), // M
      growthNmPerMin: out(r.derived.growthNmPerMin),  // N
      ratePerMin: out(r.derived.ratePerMin),          // O
      loadingDefaultMin: out(r.derived.loadingDefaultMin), // P
      plasmaDefaultMin: out(r.derived.plasmaDefaultMin),   // Q
      setupDefaultMin: out(r.derived.setupDefaultMin),     // R
      basisCost: out(r.basisCost),                    // S
      tierAmount: out(r.tierAmount),                  // T
      tierCount: out(r.tierCount),                    // U
      materialCost: out(r.materialCost),              // V
      depositMin: out(r.depositMin),                  // W
      depositCost: out(r.depositCost),                // X
      legacyMinCharge: out(r.derived.legacyMinCharge), // Y (참고용 — 현재 정책은 미적용)
    })),
  };
}
