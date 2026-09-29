// 가격 DB 워커 메모리 캐시 — 순수 모듈. SQL 은 넣지 않는다(price-db.ts 가 콜백으로 준다).
//
// 왜 있는가: 예상 견적 버튼·견적 접수·관리자 계산기가 부를 때마다 가격 표 4개(약 60행)를 D1 에서 다시 읽었다.
// 가격이 바뀌는 길은 가져오기(관리자 [가격 DB 올리기] apply · npm run price:import)뿐이고 둘 다
// price_import_log 에 새 줄을 쓴다 → 최신 가져오기 번호 1행만 읽어 같으면 메모리 값을 그대로 쓴다.
//
//   · 번호가 캐시 번호와 같음 → 캐시(가격 표 조회 0번)
//   · 다르거나 캐시 없음      → load() 로 다시 읽고 번호와 함께 저장
//   · 번호 없음(가져오기 기록 없음) → 캐시하지 않고 매번 load()
//
// ⚠️ price_* 표를 손으로(SQL 콘솔 등) 고치면 기록 번호가 그대로라 캐시가 모른다 — 인스턴스가 바뀔 때까지 옛 값.
//    손으로 고쳤으면 가져오기를 다시 하거나 price_import_log 에 줄을 하나 더 쓴다.
// ⚠️ price:import 는 표를 채운 뒤 마지막에 기록을 쓴다. 기록 전에 멈추면 번호가 안 바뀌어 캐시가 옛(또는 중간) 값을
//    계속 쓸 수 있다 → 가져오기를 다시 끝까지 한다.
// ⚠️ 돌려주는 객체는 깊게 얼린다(표 배열·행 객체까지). 계산 코드가 실수로 고치면 다음 요청이 조용히 틀린 값을
//    쓰는 대신 그 자리에서 TypeError 가 난다(ESM 은 strict mode).

/**
 * 객체·배열을 끝까지 얼린다. 이미 언 것은 건너뛴다.
 * @template T @param {T} o @returns {T}
 */
export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * 캐시 하나(워커 인스턴스당 하나 — price-db.ts 모듈 변수).
 * @returns {<T>(o: { latestId: () => Promise<unknown>, load: () => Promise<T> }) => Promise<T>}
 */
export function createPriceDbCache() {
  /** @type {{ id: unknown, db: any } | null} */
  let cache = null;
  return async ({ latestId, load }) => {
    const id = await latestId();
    if (id === null || id === undefined) {
      cache = null;
      return deepFreeze(await load());
    }
    if (cache && cache.id === id) return cache.db;
    const db = deepFreeze(await load());
    cache = { id, db };
    return db;
  };
}
