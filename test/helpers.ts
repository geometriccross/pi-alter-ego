/**
 * テスト対象が入力を変更していないことを確かめるため、共有フィクスチャを入れ子までその場で凍結する。
 * コピーは作らず、プリミティブ値はそのまま扱う。
 *
 * @param value 循環参照のないプレーンオブジェクト・配列などのテストデータ。到達する子オブジェクトも凍結する。
 * @returns 同じ値・参照を元の型 T のまま返す。prepareRequest や questionsForHook などに渡し、入力の変更を検出する。
 */
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
