// 관리자 견적 편집 화면(/admin/quote)의 입력 모델 — 순수 모듈(DOM·네트워크 없음, node 테스트가 빌드 없이 import).
//
// 화면은 "품목 카드 + 카드 안의 층"으로 입력받고, 계산·저장 API 에는 엑셀과 같은 평평한 표(items·layers)를 보낸다.
//   inputFromCards(cards)                카드 → { items, layers, layerRefs } — 계산(/api/admin/quote-calc)·저장에 그대로 보낸다
//   cardsFromInput(input, recipes)       저장된 입력(개정·접수 사본) → { cards, orphans }
//
// ⚠️ 계산은 바꾸지 않는다. 엑셀(엔진)이 오류로 보는 조합을 화면에서 고를 수 없게 할 뿐이다.
//   · 품목 번호(no) = 카드 순서(1부터). 층의 품목 번호(itemNo) = 그 층이 들어 있는 카드 번호. 층 순서(order) = 카드 안 순서.
//     → 카드를 지우거나 옮겨도 번호를 손으로 맞출 일이 없다(예전 표 화면에서 흔하던 실수).
//   · 박막 증착(박막자동): 단위 '회' · 부가세 '별도' · 입력 금액 비움으로 보낸다(엑셀에서 다른 값은 오류다).
//     플라즈마는 포함/미포함(Y/N) — 미포함이면 플라즈마 분은 보내지 않는다. 직접 가산율은 마진 '직접입력'일 때만,
//     기판 장수는 기판을 골랐을 때만 보낸다.
//   · 단가입력·총액입력: 공정·마진·기판 칸은 비워서 보낸다(엑셀 규칙). 층은 보내지 않는다(카드에는 남겨 둔다 —
//     방식을 다시 박막으로 바꾸면 돌아온다).
//   · 칸 값 변환은 예전 화면과 같다(conv): 빈칸 → null · 숫자로 읽히면 숫자(천 단위 쉼표 허용) · 그 외는 문자열 그대로.
//   · 아무것도 넣지 않은 카드는 모든 칸을 비워 보낸다 — 엔진이 빈 줄로 보고 건너뛴다(엑셀의 빈 행과 같다).
//   · 아무것도 넣지 않은 층 줄(레시피·두께·온도가 모두 빈칸)은 보내지 않는다.

export const MAX_ITEMS = 15;   // 엑셀 V3_견적입력 15~29행 (quote-calc·quote-rev 와 같다)
export const MAX_LAYERS = 100; // 엑셀 V3_박막공정 2~101행

/** 가격 방식 — 값은 엑셀 그대로, 이름·설명은 화면용 */
export const METHODS = [
  { value: '박막자동', label: '박막 증착', help: '층(레시피·두께)으로 엑셀과 같은 방식으로 자동 계산합니다. 부가세는 별도로 붙습니다.' },
  { value: '단가입력', label: '단가 입력', help: '1개 값을 넣으면 수량을 곱해 계산합니다. 분석·기판·박스처럼 값이 정해진 줄에 씁니다.' },
  { value: '총액입력', label: '총액 입력', help: '이 줄 전체 금액을 넣습니다. 단가는 금액을 수량으로 나눈 값이 됩니다.' },
];
export const METHOD_VALUES = METHODS.map((m) => m.value);

/** 마진 구분 — 값은 엑셀 그대로 */
export const MARGINS = [
  { value: '기본', label: '기본' },
  { value: '연구소_대학_할인', label: '연구소·대학 할인' },
  { value: '특수물질', label: '특수 물질' },
  { value: '직접입력', label: '직접 입력' },
];

/** 단가·총액 품목에서 자주 쓰는 단위(자유 입력 가능) */
export const UNITS = ['식', 'EA', '개', '장', 'BOX', '회', '시간', 'pt'];

const ITEM_KEYS = ['no', 'name', 'extraSpec', 'method', 'qty', 'unit', 'amount', 'vat', 'margin', 'directMarkup',
  'plasma', 'plasmaMin', 'loadingMin', 'setupMin', 'waitMin', 'substrateId', 'substratePerRun', 'rawText'];
/** 엔진이 '빈 줄'로 보는 칸(번호 제외) — quote-engine.js ITEM_CONTENT_FIELDS 와 같다 */
const ITEM_CONTENT = ITEM_KEYS.slice(1);
/**
 * 카드가 비었는지 볼 때 세는 칸 — 그 방식으로 실제로 보내는 칸만(화면 기본값인 수량 1·단위·부가세·마진·플라즈마는 세지 않는다).
 * 방식을 바꾸면 숨은 칸 값(예: 박막의 로딩 분, 단가의 금액)은 카드에 남지만 보내지 않으니 세지 않는다.
 */
const FILM_CONTENT = ['name', 'extraSpec', 'loadingMin', 'setupMin', 'waitMin', 'substrateId', 'rawText'];
const DIRECT_CONTENT = ['name', 'extraSpec', 'amount', 'rawText'];

const NUM_RE = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?$/;
/**
 * 엑셀 의미의 칸 값 변환 — 예전 화면과 같다.
 * 빈칸 → null · 숫자로 읽히면 number(천 단위 쉼표 허용) · 그 외는 문자열 그대로(앞뒤 공백 포함). 0 은 0.
 * @param {unknown} raw
 */
export const conv = (raw) => {
  const s = raw === null || raw === undefined ? '' : String(raw);
  const t = s.trim();
  if (t === '') return null;
  if (/\d/.test(t) && NUM_RE.test(t)) return Number(t.replace(/,/g, ''));
  return s;
};

const str = (v) => (v === null || v === undefined ? '' : String(v));
const blank = (v) => str(v).trim() === '';
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** 가격 DB 의 active 값(1·true·'1'·'TRUE')을 참으로 */
export const isActive = (v) => v === 1 || v === true || ['1', 'true', 'y', 'yes'].includes(str(v).trim().toLowerCase());

let seq = 0;
/** 화면에서 카드·층을 구분하는 열쇠(저장하지 않는다) */
export const nextKey = () => ++seq;

/** @typedef {{key:number, recipeId:string, thicknessNm:string, repeat:string, tempC:string}} Layer */
/**
 * @typedef {{key:number, method:string, name:string, extraSpec:string, qty:string, unit:string, amount:string, vat:string,
 *   margin:string, directMarkup:string, plasma:string, plasmaMin:string, loadingMin:string, setupMin:string, waitMin:string,
 *   substrateId:string, substratePerRun:string, rawText:string, equipmentId:string, layers:Layer[]}} Card
 */

/** 빈 층 줄(반복 1) @param {Partial<Layer>} [v] @returns {Layer} */
export function newLayer(v = {}) {
  return { key: nextKey(), recipeId: '', thicknessNm: '', repeat: '1', tempC: '', ...v };
}

/**
 * 새 카드. 박막 증착이면 빈 층 한 줄로 시작한다.
 * unit 은 단가·총액 품목에서만 쓰고(기본 '식'), 박막 증착은 보낼 때 '회'로 고정한다.
 * @param {string} [method] @param {Partial<Card>} [v] @returns {Card}
 */
export function newCard(method = '박막자동', v = {}) {
  const m = METHOD_VALUES.includes(method) ? method : '박막자동';
  return {
    key: nextKey(), method: m, name: '', extraSpec: '', qty: '1', unit: '식', amount: '', vat: '별도',
    margin: '기본', directMarkup: '', plasma: 'N', plasmaMin: '', loadingMin: '', setupMin: '', waitMin: '',
    substrateId: '', substratePerRun: '', rawText: '', equipmentId: '',
    layers: m === '박막자동' ? [newLayer()] : [],
    ...v,
  };
}

/** @param {Layer} l */
export const isBlankLayer = (l) => [l?.recipeId, l?.thicknessNm, l?.tempC].every(blank);

/** 아무것도 넣지 않은 카드인가 — 엔진에는 빈 줄로 간다. @param {Card} c */
export function isBlankCard(c) {
  if (c?.method !== '박막자동') return DIRECT_CONTENT.every((k) => blank(c?.[k]));
  if (!FILM_CONTENT.every((k) => blank(c?.[k]))) return false;
  // 조건부로 보내는 칸 — 직접 가산율(마진 직접입력일 때) · 플라즈마 분(포함일 때) · 기판 장수(기판을 골랐을 때 — 위 substrateId 로 이미 셈)
  if (c.margin === '직접입력' && !blank(c.directMarkup)) return false;
  if (c.plasma === 'Y' && !blank(c.plasmaMin)) return false;
  return (c.layers ?? []).every(isBlankLayer);
}

const BLANK_ITEM = Object.fromEntries(ITEM_CONTENT.map((k) => [k, null]));

/**
 * 카드 → 엔진 입력(엑셀 견적입력·박막공정 표와 같은 모양).
 * layerRefs[k] = [카드 위치, 카드 안 층 위치] — 계산 결과의 층(result.layers[k])을 화면 줄에 다시 붙일 때 쓴다.
 * @param {Card[]} cards
 * @returns {{items: Record<string, unknown>[], layers: Record<string, unknown>[], layerRefs: [number, number][]}}
 */
export function inputFromCards(cards) {
  const items = [];
  const layers = [];
  /** @type {[number, number][]} */
  const layerRefs = [];
  (Array.isArray(cards) ? cards : []).forEach((c, i) => {
    const no = i + 1;
    if (isBlankCard(c)) {
      items.push({ no, ...BLANK_ITEM });
      return;
    }
    if (c.method === '박막자동') {
      const plasmaOn = c.plasma === 'Y';
      const hasSub = !blank(c.substrateId);
      items.push({
        no, name: conv(c.name), extraSpec: conv(c.extraSpec), method: '박막자동', qty: conv(c.qty), unit: '회',
        amount: null, vat: '별도', margin: conv(c.margin), directMarkup: c.margin === '직접입력' ? conv(c.directMarkup) : null,
        plasma: plasmaOn ? 'Y' : 'N', plasmaMin: plasmaOn ? conv(c.plasmaMin) : null,
        loadingMin: conv(c.loadingMin), setupMin: conv(c.setupMin), waitMin: conv(c.waitMin),
        substrateId: hasSub ? conv(c.substrateId) : null, substratePerRun: hasSub ? conv(c.substratePerRun) : null,
        rawText: conv(c.rawText),
      });
      let order = 0;
      (c.layers ?? []).forEach((l, j) => {
        if (isBlankLayer(l)) return;
        order += 1;
        layers.push({ itemNo: no, order, recipeId: conv(l.recipeId), thicknessNm: conv(l.thicknessNm), repeat: conv(l.repeat), tempC: conv(l.tempC) });
        layerRefs.push([i, j]);
      });
      return;
    }
    items.push({
      no, name: conv(c.name), extraSpec: conv(c.extraSpec), method: c.method, qty: conv(c.qty), unit: conv(c.unit),
      amount: conv(c.amount), vat: conv(c.vat), margin: null, directMarkup: null, plasma: null, plasmaMin: null,
      loadingMin: null, setupMin: null, waitMin: null, substrateId: null, substratePerRun: null, rawText: conv(c.rawText),
    });
  });
  return { items, layers, layerRefs };
}

/**
 * 저장된 입력(items·layers) → 카드. 개정 불러오기·접수 사본 채우기에 쓴다.
 *   · 빈 줄 품목은 카드로 만들지 않는다.
 *   · 층은 저장된 품목 번호(no)가 같은 박막 품목 카드에 들어간다(같은 번호가 둘이면 앞의 것 — 엔진과 같다).
 *     붙을 곳이 없는 층은 orphans 로 돌려준다(화면이 알리고 계산에서는 뺀다).
 *   · 카드의 장비 = 그 카드 첫 층 중 가격 DB 에 있는 레시피의 장비.
 * @param {unknown} input
 * @param {{recipe_id: unknown, equipment_id: unknown}[]} [recipes]
 * @returns {{cards: Card[], orphans: {itemNo: unknown, recipeId: string, thicknessNm: string}[]}}
 */
export function cardsFromInput(input, recipes = []) {
  const src = isObj(input) ? input : {};
  const items = (Array.isArray(src.items) ? src.items : []).filter(isObj).slice(0, MAX_ITEMS);
  const layers = (Array.isArray(src.layers) ? src.layers : []).filter(isObj);
  const eqOf = new Map((Array.isArray(recipes) ? recipes : []).map((r) => [str(r?.recipe_id), str(r?.equipment_id)]));
  /** @type {Card[]} */
  const cards = [];
  /** @type {Map<unknown, Card>} */
  const byNo = new Map();
  for (const it of items) {
    if (ITEM_CONTENT.every((k) => blank(it[k]))) continue;
    const own = layers.filter((l) => l.itemNo === it.no);
    const m = str(it.method).trim();
    const method = METHOD_VALUES.includes(m) ? m : (own.length ? '박막자동' : '단가입력');
    const film = method === '박막자동';
    const card = newCard(method, {
      name: str(it.name), extraSpec: str(it.extraSpec), qty: str(it.qty),
      unit: film ? '식' : str(it.unit), amount: film ? '' : str(it.amount), vat: film ? '별도' : str(it.vat),
      margin: film ? str(it.margin) : '기본', directMarkup: film ? str(it.directMarkup) : '',
      plasma: film && str(it.plasma).trim().toUpperCase() === 'Y' ? 'Y' : 'N', plasmaMin: film ? str(it.plasmaMin) : '',
      loadingMin: film ? str(it.loadingMin) : '', setupMin: film ? str(it.setupMin) : '', waitMin: film ? str(it.waitMin) : '',
      substrateId: film ? str(it.substrateId) : '', substratePerRun: film ? str(it.substratePerRun) : '',
      rawText: str(it.rawText), layers: [],
    });
    cards.push(card);
    if (film && !byNo.has(it.no)) byNo.set(it.no, card);
  }
  const orphans = [];
  for (const l of layers) {
    const layer = { recipeId: str(l.recipeId), thicknessNm: str(l.thicknessNm), repeat: str(l.repeat), tempC: str(l.tempC) };
    const card = byNo.get(l.itemNo);
    if (card) card.layers.push(newLayer(layer));
    else if (!isBlankLayer(layer)) orphans.push({ itemNo: l.itemNo ?? null, recipeId: layer.recipeId, thicknessNm: layer.thicknessNm });
  }
  for (const c of cards) {
    if (c.method !== '박막자동') continue;
    if (!c.layers.length) c.layers.push(newLayer());
    const known = c.layers.find((l) => eqOf.has(l.recipeId.trim()));
    c.equipmentId = known ? eqOf.get(known.recipeId.trim()) ?? '' : '';
  }
  return { cards, orphans };
}

// ── 드롭다운 ─────────────────────────────────────────────────────────────────

/**
 * 장비 선택지 — 레시피가 하나라도 있는 장비만. 장비 표에 없는 장비 ID 를 가리키는 레시피도 고를 수 있게
 * '(장비 정보 없음)'으로 넣는다(엔진이 오류 문구로 알려 준다).
 * @param {{equipment_id: unknown, equipment_name?: unknown, process_type?: unknown, active?: unknown}[]} equipment
 * @param {{recipe_id: unknown, equipment_id: unknown}[]} recipes
 */
export function equipmentOptions(equipment, recipes) {
  const used = new Set((recipes ?? []).map((r) => str(r.equipment_id)));
  const known = (equipment ?? []).filter((e) => used.has(str(e.equipment_id)));
  const nameCount = new Map();
  for (const e of known) nameCount.set(str(e.equipment_name).trim(), (nameCount.get(str(e.equipment_name).trim()) ?? 0) + 1);
  const seen = new Set();
  const out = [];
  for (const e of known) {
    const id = str(e.equipment_id);
    if (seen.has(id)) continue;
    seen.add(id);
    const name = str(e.equipment_name).trim() || id;
    const proc = str(e.process_type).trim();
    const dup = (nameCount.get(name) ?? 0) > 1;
    out.push({ value: id, label: `${name}${proc ? ` (${proc})` : ''}${dup ? ` · ${id}` : ''}${isActive(e.active) ? '' : ' — 사용 중지'}`, active: isActive(e.active) });
  }
  for (const id of used) {
    if (seen.has(id) || id === '') continue;
    seen.add(id);
    out.push({ value: id, label: `${id} (장비 정보 없음)`, active: false });
  }
  return out;
}

/**
 * 레시피 선택지 — equipmentId 가 있으면 그 장비 것만. 이름 = '물질 · 방식'(같은 장비 안에서 겹치면 레시피 ID 를 붙인다).
 * @param {{recipe_id: unknown, material_name?: unknown, method?: unknown, equipment_id: unknown, active?: unknown}[]} recipes
 * @param {string} [equipmentId]
 */
export function recipeOptions(recipes, equipmentId = '') {
  const list = (recipes ?? []).filter((r) => !equipmentId || str(r.equipment_id) === equipmentId);
  const base = (r) => [str(r.material_name).trim(), str(r.method).trim()].filter(Boolean).join(' · ') || str(r.recipe_id);
  const count = new Map();
  for (const r of list) {
    const k = `${str(r.equipment_id)}\u0000${base(r)}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  return list.map((r) => ({
    value: str(r.recipe_id),
    label: `${base(r)}${(count.get(`${str(r.equipment_id)}\u0000${base(r)}`) ?? 0) > 1 ? ` (${str(r.recipe_id)})` : ''}${isActive(r.active) ? '' : ' — 사용 중지'}`,
    equipmentId: str(r.equipment_id),
    active: isActive(r.active),
  }));
}

/**
 * 기판 선택지 — 이름(겹치면 ID) · 사용 중지 표시.
 * @param {{catalog_id: unknown, item_name?: unknown, active?: unknown}[]} substrates
 */
export function substrateOptions(substrates) {
  const list = substrates ?? [];
  const count = new Map();
  for (const s of list) count.set(str(s.item_name).trim(), (count.get(str(s.item_name).trim()) ?? 0) + 1);
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const id = str(s.catalog_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = str(s.item_name).trim() || id;
    out.push({ value: id, label: `${name}${(count.get(name) ?? 0) > 1 ? ` · ${id}` : ''}${isActive(s.active) ? '' : ' — 사용 중지'}`, active: isActive(s.active) });
  }
  return out;
}

/** 장비를 바꿨을 때 다른 장비의 레시피가 든 층을 비운다(층 줄은 남긴다). 비운 개수를 돌려준다. @param {Card} card @param {Map<string,string>} eqOf */
export function clearForeignRecipes(card, eqOf) {
  let n = 0;
  for (const l of card.layers) {
    const id = l.recipeId.trim();
    if (id && eqOf.get(id) !== card.equipmentId) { l.recipeId = ''; n += 1; }
  }
  return n;
}

// ── 계산 결과 → 화면 표시 ────────────────────────────────────────────────────

/** 가격 DB(정책) 쪽 문제 — 칸이 아니라 엑셀 가격정책을 고쳐야 한다 */
export const POLICY_STATUSES = ['가격 정책 확인', '부가세율 확인 필요', '최소청구 정책 확정 필요', '재료비 정책 확인'];

/** 품목 상태 문구(엔진·엑셀 그대로) → 표시할 칸 */
export const ITEM_STATUS_FIELD = {
  '품명 필요': 'name',
  '가격 방식 확인': 'method',
  '수량은 양수': 'qty',
  '박막 횟수는 정수': 'qty',
  '단위 필요': 'unit',
  '부가세 기준 확인': 'vat',
  '입력 금액은 0 이상 숫자': 'amount',
  '입력 금액은 원 단위 정수': 'amount',
  '박막공정 입력 필요': 'layers',
  '박막공정 오류 확인': 'layers',
  '서로 다른 장비는 품목을 나누세요': 'equipment',
  '마진 구분/직접 가산율 확인': 'margin',
  '직접 가산율은 직접입력 선택 시 사용': 'margin',
  '플라즈마 Y/N 확인': 'plasma',
  '플라즈마 N인데 시간이 입력됨': 'plasma',
  '공정 시간은 0 이상 숫자': 'times',
  '다층 공통 로딩 분을 지정하세요': 'loadingMin',
  '다층 공통 셋업 분을 지정하세요': 'setupMin',
  '기판 ID 필요': 'substrateId',
  '기판 ID 누락 또는 중복': 'substrateId',
  '사용 중지 기판': 'substrateId',
  '기판 원가 확인 필요': 'substrateId',
  '기판 장수/회는 양수': 'substratePerRun',
  '기판 장수는 정수': 'substratePerRun',
};

/** 층 상태 문구 → 표시할 칸('name' 은 품목의 품명 칸) */
export const LAYER_STATUS_FIELD = {
  '레시피 ID 필요': 'recipeId',
  '등록되지 않은 레시피': 'recipeId',
  '레시피 ID 중복': 'recipeId',
  '사용 중지 레시피': 'recipeId',
  '두께: 양수 필요': 'thicknessNm',
  '층 반복: 양의 정수 필요': 'repeat',
  '층 반복: 정수 필요': 'repeat',
  '표시 온도: 숫자 필요': 'tempC',
  '해당 견적 품명이 비어 있음': 'name',
};

/** 자주 나오는 상태에 덧붙이는 설명(문구 자체는 엑셀과 같게 두고 아래에 한 줄) */
export const STATUS_HINT = {
  '박막공정 입력 필요': '층을 한 줄 이상 넣으세요(레시피·두께).',
  '박막공정 오류 확인': '빨간 표시가 있는 층을 고치세요.',
  '서로 다른 장비는 품목을 나누세요': '한 품목에는 한 장비의 레시피만 넣을 수 있습니다. 다른 장비 층은 새 박막 증착 품목으로 옮기세요.',
  '다층 공통 로딩 분을 지정하세요': '층마다 장비 기본 로딩 시간이 달라, 이 품목에 쓸 로딩 분을 [공정 시간 조정]에 넣어야 합니다.',
  '다층 공통 셋업 분을 지정하세요': '층마다 장비 기본 셋업 시간이 달라, 이 품목에 쓸 셋업 분을 [공정 시간 조정]에 넣어야 합니다.',
  '마진 구분/직접 가산율 확인': "마진을 고르세요. '직접 입력'이면 가산율(예: 0.3)도 넣습니다.",
  '박막 횟수는 정수': '횟수는 1, 2, 3 같은 정수로 넣습니다.',
  '입력 금액은 원 단위 정수': '금액은 원 단위 정수로 넣습니다(소수점 없이).',
  '공정 시간은 0 이상 숫자': '[공정 시간 조정]의 분 값은 0 이상 숫자로 넣습니다.',
  '기판 ID 필요': '기판 장수를 넣었으면 기판도 고르세요.',
  '등록되지 않은 레시피': '가격 DB 에 없는 레시피입니다. 목록에서 다시 고르세요.',
  '사용 중지 레시피': '가격 DB 에서 사용 중지된 레시피입니다. 다른 레시피를 고르세요.',
  '해당 견적 품명이 비어 있음': '이 품목의 품명을 넣으세요.',
  '품명 필요': '견적서에 나갈 품명을 넣으세요.',
  '수량은 양수': '수량은 0보다 큰 숫자로 넣습니다.',
  '단위 필요': '단위를 넣으세요(예: 식, EA, BOX).',
  '부가세 기준 확인': '부가세 별도·포함 중 하나를 고르세요.',
  '입력 금액은 0 이상 숫자': '금액을 원 단위 숫자로 넣으세요.',
  '레시피 ID 필요': '목록에서 레시피를 고르세요.',
  '두께: 양수 필요': '두께를 nm 단위의 0보다 큰 숫자로 넣으세요.',
  '층 반복: 양의 정수 필요': '반복은 1 이상의 정수로 넣습니다.',
  '층 반복: 정수 필요': '반복은 1 이상의 정수로 넣습니다.',
  '표시 온도: 숫자 필요': '온도는 숫자로 넣거나 비워 두세요(비우면 레시피 기본).',
};

/** 품목 상태 → 칸. 정상·빈 줄·모르는 문구는 null @param {unknown} status */
export const fieldForItemStatus = (status) => ITEM_STATUS_FIELD[str(status)] ?? null;
/** 층 상태 → 칸 @param {unknown} status */
export const fieldForLayerStatus = (status) => LAYER_STATUS_FIELD[str(status)] ?? null;
/** @param {unknown} status */
export const isPolicyStatus = (status) => POLICY_STATUSES.includes(str(status));

/**
 * 계산 결과에서 '확인할 곳' 목록 — 합계 칸에 띄운다(품목 순서대로, 품목 → 그 품목의 층).
 *   · 가격 정책 문제(모든 줄에 같은 문구가 붙는다)는 빼고, 화면이 result.policyStatus 로 한 번만 알린다.
 *   · 층 오류가 있으면 품목 문구('박막공정 오류 확인')는 빼고 층마다 알린다.
 *   · 품명이 비어 있으면 층마다 붙는 '해당 견적 품명이 비어 있음'은 빼고 품목 문구 하나만 둔다.
 * @param {{items?: {status?: unknown}[], layers?: {status?: unknown}[]}} result
 * @param {[number, number][]} layerRefs inputFromCards 의 layerRefs
 * @returns {{card: number, layer: number | null, status: string}[]}
 */
export function problemsOf(result, layerRefs) {
  const out = [];
  const items = Array.isArray(result?.items) ? result.items : [];
  const layers = Array.isArray(result?.layers) ? result.layers : [];
  const bad = (s) => s !== '' && s !== '정상' && !isPolicyStatus(s);
  items.forEach((it, i) => {
    const s = str(it?.status);
    if (bad(s) && s !== '박막공정 오류 확인') out.push({ card: i, layer: null, status: s });
    layers.forEach((l, k) => {
      const ls = str(l?.status);
      const ref = layerRefs?.[k];
      if (!ref || ref[0] !== i || !bad(ls)) return;
      if (ls === '해당 견적 품명이 비어 있음' && s === '품명 필요') return;
      out.push({ card: i, layer: ref[1], status: ls });
    });
  });
  return out;
}
