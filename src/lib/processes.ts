// 증착 공정 의뢰 — 공정별 선택 가능한 물질/가스 + 단위 정의.
// 출처: 담당자 제공 "공정 의뢰 양식" 엑셀 Sheet2(물질 목록) + Sheet1(단위 패턴).
// 견적 폼의 공정 시퀀스 빌더가 이 데이터로 드롭다운을 구성한다.

export type ProcessDef = {
  /** 공정 종류 (표시명 = 값) */
  name: string;
  /** 선택 가능한 물질/가스. 빈 배열이면 물질 선택 없음(측정류) */
  materials: string[];
  /** 두께/시간 입력의 단위. 'nm'=두께, 'min'=시간, null=값 입력 없음(측정류) */
  unit: 'nm' | 'min' | null;
};

// 엑셀 Sheet2 순서 그대로. 물질은 알파벳 순(엑셀 기준).
export const PROCESSES: ProcessDef[] = [
  { name: 'PlasmaCleaning (In-situ)', materials: ['Ar', 'O2'], unit: 'min' },
  { name: 'PlasmaTreatment (Ex-situ)', materials: ['Ar', 'O2', 'N2', 'CF4'], unit: 'min' },
  { name: 'Sputter', materials: ['Al', 'AlN', 'AlScN', 'Au', 'Bi', 'Cr', 'Hf', 'HfO2', 'IGZO', 'ITO', 'Mo', 'Pt', 'Sc', 'Si', 'SiN', 'SiO2', 'Ta2O5', 'Ti', 'TiN', 'TiO2', 'VO2', 'W', 'ZnO'], unit: 'nm' },
  { name: 'ALD', materials: ['Al2O3', 'HfO2', 'TiO2'], unit: 'nm' },
  { name: 'Evaporator', materials: ['Al', 'Au', 'Ni'], unit: 'nm' },
  { name: 'Annealing', materials: ['ATM', 'N2'], unit: 'min' },
  { name: 'SheetResistance', materials: [], unit: null },
  { name: 'Ellipsometer', materials: [], unit: null },
];

// 기판 종류 (구글 폼 "기판 종류")
export const SUBSTRATES = ['Silicon', 'Silicon oxide', 'Glass', 'Sapphire'] as const;

// 기판 크기 (구글 폼 "기판 크기")
export const SUBSTRATE_SIZES = ['2 inch 이하 or 조각 시편', '4 inch', '6 inch'] as const;

// 기판 전달 방식 (구글 폼 "기판 전달 방식")
export const DELIVERY_METHODS = ['직접 전달', '택배', '구매'] as const;
