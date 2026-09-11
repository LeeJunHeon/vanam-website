// 증착 공정 의뢰 — 공정별 선택 가능한 물질/가스 + 단위 정의.
// 출처: 담당자 제공 "공정 의뢰 양식" 엑셀 Sheet2(물질 목록) + Sheet1(단위 패턴).
// 견적 폼의 공정 시퀀스 빌더가 이 데이터로 드롭다운을 구성한다.
//
// 0907b — 증착 물질 목록은 더 이상 손으로 적지 않는다. 소재 라이브러리
// (src/content/materials/*.json)가 단일 소스이고, Sputter/ALD 의 선택지는 거기서 파생한다.
// 라이브러리에 소재를 추가하면 견적 폼 드롭다운에 자동으로 나타난다(수기 동기화 지점 제거).
// 라이브러리에 대응 항목이 없는 선택지(플라즈마·열처리 가스, Evaporator 물질)만 EXTRAS 로 남긴다.
import { materialValue, materialSortKey, PRODUCT_MAT_FILTER as PRODUCT_MAT_FILTER_RAW } from './material-value.js';
import {
  DELIVERY_METHODS as DELIVERY_METHODS_RAW,
  DELIVERY_VALUES as DELIVERY_VALUES_RAW,
  DELIVERY_NEEDS_SHIPPING as DELIVERY_NEEDS_SHIPPING_RAW,
} from './quote-fields.js';

// 물질의 소재 분류. 제품(Oxides/Nitrides/Metals)에 맞는 물질만 보여주는 데 쓴다.
// 'gas' 는 플라즈마 공정의 가스라 분류와 무관하게 항상 노출.
// 'Semiconductor' 는 라이브러리 분류(Si)를 그대로 받은 것 — content.config.ts 의 category enum 과 같다.
export type MatCat = 'Oxide' | 'Nitride' | 'Metal' | 'Semiconductor' | 'gas';

export type ProcessDef = {
  name: string;
  /** [물질명, 분류] 쌍. 분류로 제품 카테고리 필터링. 빈 배열이면 물질 선택 없음 */
  materials: [string, MatCat][];
  /** 두께/시간 단위. 'nm'=두께, 'min'=시간, null=값 입력 없음 */
  unit: 'nm' | 'min' | null;
  /** 측정 공정인가 (측정은 별도 섹션·선택 사항) */
  isMeasurement?: boolean;
};

// ── 소재 라이브러리에서 증착 물질 파생 ────────────────────────────
// getCollection 이 아니라 glob 인 이유: 이 모듈은 .astro 프런트매터뿐 아니라
// 서버(Workers) 코드·검증 스크립트에서도 Astro 런타임 없이 import 될 수 있어야 한다.
type LibMaterial = { system: 'sputter' | 'ald'; category: Exclude<MatCat, 'gas'>; formula: string };
const libModules = import.meta.glob<LibMaterial | { default: LibMaterial }>(
  '../content/materials/*.json',
  { eager: true },
);
const LIBRARY: LibMaterial[] = Object.values(libModules).map(
  (m) => (('default' in m ? m.default : m) as LibMaterial),
);

// 한 증착 방식(system)의 물질 선택지. value 문자열은 material-value.js 가 만든다(단일 함수).
// 정렬은 소재 라이브러리 칩과 같은 규칙(소문자 알파벳순). 분류별 묶음(optgroup)과 그 순서는
// QuoteForm 클라이언트의 CAT_ORDER 가 정하므로 여기서는 전체를 한 줄로 정렬해 두면 된다.
function fromLibrary(system: 'sputter' | 'ald'): [string, MatCat][] {
  const seen = new Set<string>();
  const out: [string, MatCat][] = [];
  for (const m of LIBRARY) {
    if (m.system !== system) continue;
    const value = materialValue(m.formula);
    if (seen.has(value)) continue; // 같은 방식 안에 같은 화학식이 둘이면 하나만 (선택지 중복 방지)
    seen.add(value);
    out.push([value, m.category]);
  }
  out.sort((a, b) => materialSortKey(a[0]).localeCompare(materialSortKey(b[0]), 'en'));
  return out;
}

// ── extras: 라이브러리에 대응 항목이 없어 파생되지 않는 선택지 ──────────
// (a) 비증착 공정의 가스 — 플라즈마 세정·처리, 열처리 분위기. 소재 라이브러리는 증착 소재만 담는다.
// (b) Evaporator 물질 — 라이브러리의 system 은 sputter/ald 두 가지뿐이라 대응 항목이 없다.
//     (라이브러리에서 sputter 는 "PVD — Sputter & Evaporator" 로 함께 표기되지만,
//      폼의 Evaporator 는 별도 공정이고 실제 취급 물질도 3종뿐이라 현행 목록을 그대로 둔다.)
// 이 목록은 라이브러리가 커져도 자동으로 늘지 않는다 — 손으로 관리한다.
const EXTRAS: Record<string, [string, MatCat][]> = {
  'PlasmaCleaning (In-situ)': [['Ar', 'gas'], ['O2', 'gas']],
  'PlasmaTreatment (Ex-situ)': [['Ar', 'gas'], ['O2', 'gas'], ['N2', 'gas'], ['CF4', 'gas']],
  Evaporator: [['Al', 'Metal'], ['Au', 'Metal'], ['Ni', 'Metal']],
  Annealing: [['ATM', 'gas'], ['N2', 'gas']],
};

// 증착·처리 공정 (엑셀 Sheet2). 순서·이름·단위는 기존 그대로.
export const PROCESSES: ProcessDef[] = [
  { name: 'PlasmaCleaning (In-situ)', unit: 'min', materials: EXTRAS['PlasmaCleaning (In-situ)']! },
  { name: 'PlasmaTreatment (Ex-situ)', unit: 'min', materials: EXTRAS['PlasmaTreatment (Ex-situ)']! },
  { name: 'Sputter', unit: 'nm', materials: fromLibrary('sputter') },
  { name: 'ALD', unit: 'nm', materials: fromLibrary('ald') },
  { name: 'Evaporator', unit: 'nm', materials: EXTRAS['Evaporator']! },
  { name: 'Annealing', unit: 'min', materials: EXTRAS['Annealing']! },
];

// 견적 폼 공정 이름 ↔ 라이브러리 system. CTA 의 ?system= 을 폼의 공정으로 되돌릴 때 쓴다.
export const SYSTEM_TO_PROCESS: Record<string, string> = { sputter: 'Sputter', ald: 'ALD' };

// 측정 공정 (별도 섹션 · 선택 사항). 물질·값 없음.
export const MEASUREMENTS: ProcessDef[] = [
  { name: 'SheetResistance', unit: null, materials: [], isMeasurement: true },
  { name: 'Ellipsometer', unit: null, materials: [], isMeasurement: true },
  // Technology '분석·측정' 12종(물질 7 + 소자 5)을 선택지로 그대로 노출 — analysis 컬렉션 표기와 동일
  { name: 'SEM (include EDS)', unit: null, materials: [], isMeasurement: true },
  { name: 'TEM (include EDS)', unit: null, materials: [], isMeasurement: true },
  { name: 'XRD', unit: null, materials: [], isMeasurement: true },
  { name: 'XPS', unit: null, materials: [], isMeasurement: true },
  { name: 'UPS', unit: null, materials: [], isMeasurement: true },
  { name: 'AFM', unit: null, materials: [], isMeasurement: true },
  { name: 'Raman', unit: null, materials: [], isMeasurement: true },
  { name: 'I–V', unit: null, materials: [], isMeasurement: true },
  { name: 'C–V', unit: null, materials: [], isMeasurement: true },
  { name: 'Pulse', unit: null, materials: [], isMeasurement: true },
  { name: 'Ferroelectric', unit: null, materials: [], isMeasurement: true },
  { name: 'Piezoelectric', unit: null, materials: [], isMeasurement: true },
  { name: 'Hall', unit: null, materials: [], isMeasurement: true },
  { name: 'PPMS', unit: null, materials: [], isMeasurement: true },
];

// 제품 ID(products/*.json 파일명) → 물질 소재 분류 매핑.
// 이 제품의 공정 물질 드롭다운에 어떤 분류를 보여줄지 결정한다.
// 실체는 material-value.js 에 있다 — CTA 가 보내는 제품 페이지(CATEGORY_TO_PRODUCT)와
// 짝을 이뤄야 하고, 그 정합을 node 검증 스크립트가 확인해야 하기 때문. 여기서는 타입만 입힌다.
export const PRODUCT_MAT_FILTER = PRODUCT_MAT_FILTER_RAW as Record<string, MatCat[] | null>;

// 기판 종류/크기/전달 — [값(영문 고정), 한글 라벨]. 값은 데이터로 저장, 라벨만 언어별 표시.
export const SUBSTRATES: [string, string][] = [
  ['Silicon', 'Silicon'],
  ['Silicon oxide', 'Silicon oxide'],
  ['Glass', 'Glass'],
  ['Sapphire', 'Sapphire'],
];

export const SUBSTRATE_SIZES: { value: string; en: string; ko: string }[] = [
  { value: '2inch_or_piece', en: '2 inch or smaller / coupon', ko: '2 inch 이하 or 조각 시편' },
  { value: '4inch', en: '4 inch', ko: '4 inch' },
  { value: '6inch', en: '6 inch', ko: '6 inch' },
];

// 기판 전달 방식 — 실체는 quote-fields.js 에 있다(node 검증 스크립트가 빌드 없이 읽어야 하므로).
// 여기서는 타입만 입혀 다시 내보낸다. material-value.js ↔ PRODUCT_MAT_FILTER 와 같은 구조다.
export const DELIVERY_METHODS = DELIVERY_METHODS_RAW as { value: string; en: string; ko: string; needsShipping?: boolean }[];
/** 서버 검증용 허용값 목록. */
export const DELIVERY_VALUES = DELIVERY_VALUES_RAW as string[];
/** 배송지 입력이 필요한 전달 방식(코드값). */
export const DELIVERY_NEEDS_SHIPPING = DELIVERY_NEEDS_SHIPPING_RAW as string[];
