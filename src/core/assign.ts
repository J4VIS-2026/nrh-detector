/**
 * 트랙과 탐지를 짝짓는다.
 *
 * IoU로 비용 행렬을 만들고, 총비용이 가장 작아지는 짝을 찾는다(선형 배정). 그리디로
 * 가까운 것부터 집으면 **한 트랙이 엉뚱한 탐지를 가로채** 뒤의 트랙이 밀리는 일이
 * 생긴다 - 전체 비용을 함께 푸는 이유가 그것이다.
 *
 * **Hungarian을 직접 짰다.** `munkres` 패키지가 있지만 빈 행렬에서 예외를 내고
 * (`Cannot read property 'length' of undefined`, J0에서 확인), 무엇보다 **동점 처리를
 * 우리가 직접 정해야** 한다 - NMS에서 같은 문제를 한 번 겪었다.
 */

/** 모서리 기준 박스. */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const EPS = 1e-7;

/**
 * IoU **거리** 행렬. `1 - IoU`라서 **작을수록 가깝다.**
 *
 * @returns `a.length × b.length` 행 우선 평탄 배열.
 */
export function iouDistance(a: readonly Box[], b: readonly Box[]): Float64Array {
  const M = new Float64Array(a.length * b.length);
  for (let i = 0; i < a.length; i++) {
    const A = a[i];
    const areaA = (A.x2 - A.x1) * (A.y2 - A.y1);
    for (let j = 0; j < b.length; j++) {
      const B = b[j];
      const w = Math.max(0, Math.min(A.x2, B.x2) - Math.max(A.x1, B.x1));
      const h = Math.max(0, Math.min(A.y2, B.y2) - Math.max(A.y1, B.y1));
      const inter = w * h;
      const union = areaA + (B.x2 - B.x1) * (B.y2 - B.y1) - inter;
      M[i * b.length + j] = 1 - inter / (union + EPS);
    }
  }
  return M;
}

/**
 * 비용에 탐지 신뢰도를 섞는다.
 *
 * `1 - (1 - 비용) × score`. **확신이 낮은 탐지는 IoU가 좋아도 비용이 올라간다.**
 *
 * 2단계 연관(낮은 점수 탐지)에는 **쓰지 않는다** - 점수가 낮으니 비용이 임계값 위로
 * 올라가 아무것도 안 붙게 된다. ByteTrack 논문이 그래서 IoU만 쓴다.
 */
export function fuseScore(cost: Float64Array, scores: readonly number[]): Float64Array {
  if (cost.length === 0) return cost;
  const cols = scores.length;
  const out = new Float64Array(cost.length);
  for (let i = 0; i < cost.length; i++) {
    out[i] = 1 - (1 - cost[i]) * scores[i % cols];
  }
  return out;
}

export interface Assignment {
  /** `[행, 열]` 짝. 비용이 임계값을 넘는 짝은 빠진다. */
  pairs: [number, number][];
  unmatchedRows: number[];
  unmatchedCols: number[];
}

/**
 * 총비용이 최소가 되는 짝을 찾고, 임계값을 넘는 짝은 버린다.
 *
 * @param cost `행수 × 열수` 행 우선 평탄 배열.
 * @param threshold 이 값보다 비싼 짝은 안 맺는다.
 */
export function linearAssignment(
  cost: Float64Array,
  rows: number,
  cols: number,
  threshold: number,
): Assignment {
  if (rows === 0 || cols === 0) {
    return {
      pairs: [],
      unmatchedRows: Array.from({ length: rows }, (_, i) => i),
      unmatchedCols: Array.from({ length: cols }, (_, i) => i),
    };
  }

  const rowOfCol = hungarian(cost, rows, cols);

  const pairs: [number, number][] = [];
  const rowUsed = new Uint8Array(rows);
  const colUsed = new Uint8Array(cols);
  for (let j = 0; j < cols; j++) {
    const i = rowOfCol[j];
    if (i < 0) continue;
    if (cost[i * cols + j] > threshold) continue;
    pairs.push([i, j]);
    rowUsed[i] = 1;
    colUsed[j] = 1;
  }
  // 행 번호 오름차순. 파이썬 `linear_sum_assignment`도 행 순으로 돌려준다
  pairs.sort((p, q) => p[0] - q[0]);

  const unmatchedRows: number[] = [];
  for (let i = 0; i < rows; i++) if (!rowUsed[i]) unmatchedRows.push(i);
  const unmatchedCols: number[] = [];
  for (let j = 0; j < cols; j++) if (!colUsed[j]) unmatchedCols.push(j);

  return { pairs, unmatchedRows, unmatchedCols };
}

/**
 * Jonker-Volgenant 방식의 Hungarian. 열마다 짝지어진 행을 돌려준다(없으면 -1).
 *
 * 행이 열보다 많으면 남는 행은 짝이 없다. 그 반대도 마찬가지다. **동점이면 인덱스가
 * 작은 쪽을 고른다** - 다른 곳(NMS)과 같은 규칙이라야 결과가 재현된다.
 */
function hungarian(cost: Float64Array, rows: number, cols: number): Int32Array {
  // 내부는 "행 ≤ 열"을 가정한다. 뒤집혀 있으면 전치해서 풀고 되돌린다
  if (rows > cols) {
    const T = new Float64Array(cost.length);
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) T[j * rows + i] = cost[i * cols + j];
    }
    // 전치해서 푼 결과는 **원래 행으로 색인된다** (전치된 열 = 원래 행). 값이 원래
    // 열이므로 행과 열을 바꿔 담아야 한다 - 그냥 그대로 돌려주면 행과 열이 뒤바뀐 답이 된다
    const colOfRow = hungarian(T, cols, rows);
    const out = new Int32Array(cols).fill(-1);
    for (let i = 0; i < rows; i++) {
      const j = colOfRow[i];
      if (j >= 0) out[j] = i;
    }
    return out;
  }

  const INF = Infinity;
  const u = new Float64Array(rows + 1);
  const v = new Float64Array(cols + 1);
  const p = new Int32Array(cols + 1).fill(-1); // 열 -> 행
  const way = new Int32Array(cols + 1).fill(-1);

  for (let i = 0; i < rows; i++) {
    p[cols] = i;
    let j0 = cols;
    const minv = new Float64Array(cols + 1).fill(INF);
    const used = new Uint8Array(cols + 1);

    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;
      for (let j = 0; j < cols; j++) {
        if (used[j]) continue;
        const cur = cost[i0 * cols + j] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      if (j1 < 0) break; // 남은 열이 없다
      for (let j = 0; j <= cols; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== -1);

    // 증가 경로를 따라가며 짝을 옮긴다
    while (j0 !== cols) {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    }
  }

  const rowOfCol = new Int32Array(cols).fill(-1);
  for (let j = 0; j < cols; j++) if (p[j] >= 0) rowOfCol[j] = p[j];
  return rowOfCol;
}
