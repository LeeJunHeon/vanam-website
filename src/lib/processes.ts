// 증착 공정 의뢰 — 공정별 선택 가능한 물질/가스 + 단위 정의.
// 출처: 담당자 제공 "공정 의뢰 양식" 엑셀 Sheet2(물질 목록) + Sheet1(단위 패턴).
// 견적 폼의 공정 시퀀스 빌더가 이 데이터로 드롭다운을 구성한다.

// 물질의 소재 분류. 제품(Oxides/Nitrides/Metals)에 맞는 물질만 보여주는 데 쓴다.
// 'gas' 는 플라즈마 공정의 가스라 분류와 무관하게 항상 노출.
export type MatCat = 'Oxide' | 'Nitride' | 'Metal' | 'gas';

export type ProcessDef = {
  name: string;
  /** [물질명, 분류] 쌍. 분류로 제품 카테고리 필터링. 빈 배열이면 물질 선택 없음 */
  materials: [string, MatCat][];
  /** 두께/시간 단위. 'nm'=두께, 'min'=시간, null=값 입력 없음 */
  unit: 'nm' | 'min' | null;
  /** 측정 공정인가 (측정은 별도 섹션·선택 사항) */
  isMeasurement?: boolean;
};

// 증착·처리 공정 (엑셀 Sheet2). 물질에 소재 분류를 붙였다.
export const PROCESSES: ProcessDef[] = [
  { name: 'PlasmaCleaning (In-situ)', unit: 'min', materials: [['Ar', 'gas'], ['O2', 'gas']] },
  { name: 'PlasmaTreatment (Ex-situ)', unit: 'min', materials: [['Ar', 'gas'], ['O2', 'gas'], ['N2', 'gas'], ['CF4', 'gas']] },
  { name: 'Sputter', unit: 'nm', materials: [
    ['Al', 'Metal'], ['AlN', 'Nitride'], ['AlScN', 'Nitride'], ['Au', 'Metal'], ['Bi', 'Metal'],
    ['Cr', 'Metal'], ['Hf', 'Metal'], ['HfO2', 'Oxide'], ['IGZO', 'Oxide'], ['ITO', 'Oxide'],
    ['Mo', 'Metal'], ['Pt', 'Metal'], ['Sc', 'Metal'], ['Si', 'Metal'], ['SiN', 'Nitride'],
    ['SiO2', 'Oxide'], ['Ta2O5', 'Oxide'], ['Ti', 'Metal'], ['TiN', 'Nitride'], ['TiO2', 'Oxide'],
    ['VO2', 'Oxide'], ['W', 'Metal'], ['ZnO', 'Oxide'],
  ] },
  { name: 'ALD', unit: 'nm', materials: [['Al2O3', 'Oxide'], ['HfO2', 'Oxide'], ['TiO2', 'Oxide']] },
  { name: 'Evaporator', unit: 'nm', materials: [['Al', 'Metal'], ['Au', 'Metal'], ['Ni', 'Metal']] },
  { name: 'Annealing', unit: 'min', materials: [['ATM', 'gas'], ['N2', 'gas']] },
];

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
// 목록에 없는 제품(multilayers·wafers 등)은 전체 노출(null).
export const PRODUCT_MAT_FILTER: Record<string, MatCat[] | null> = {
  oxides: ['Oxide', 'gas'],
  nitrides: ['Nitride', 'gas'],
  metals: ['Metal', 'gas'],
  multilayers: null, // 다층은 전체 물질 조합
};

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

export const DELIVERY_METHODS: { value: string; en: string; ko: string }[] = [
  { value: 'courier', en: 'Courier', ko: '택배' },
  { value: 'direct', en: 'Pick up in person', ko: '직접 수령' },
];
