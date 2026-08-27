/**
 * BoT-SORT의 칼만 필터 (XYWH).
 *
 * 상태는 8차원 `(x, y, w, h, vx, vy, vw, vh)`다. `(x, y)`는 박스 중심, `w`·`h`는 너비와
 * 높이, 나머지 넷은 각각의 속도다. 등속 운동을 가정하고 관측은 `(x, y, w, h)` 넷이다.
 *
 * **행렬 라이브러리를 안 쓴다.** 크기가 8×8과 4×4로 고정이라 직접 도는 편이 빠르고,
 * 무엇보다 **의존성이 하나도 안 붙는다** - 이 모듈을 받는 쪽이 설치할 것이 줄어든다.
 *
 * 배열은 전부 **행 우선(row-major) 평탄 배열**이다. `C[i * 8 + j]`가 `C[i][j]`다.
 */

/** 위치 불확실성 가중치. 참조 구현 값 그대로다. */
const POS_WEIGHT = 1 / 20;
/** 속도 불확실성 가중치. */
const VEL_WEIGHT = 1 / 160;

function mul8(A: Float64Array, B: Float64Array, out: Float64Array): void {
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      let s = 0;
      for (let k = 0; k < 8; k++) s += A[i * 8 + k] * B[k * 8 + j];
      out[i * 8 + j] = s;
    }
  }
}

/**
 * 등속 운동 행렬. 단위행렬에 `dt = 1`짜리 속도 항을 더한 것이다.
 *
 *     x' = x + vx,  w' = w + vw,  속도는 그대로
 */
const MOTION = (() => {
  const F = new Float64Array(64);
  for (let i = 0; i < 8; i++) F[i * 8 + i] = 1;
  for (let i = 0; i < 4; i++) F[i * 8 + (4 + i)] = 1;
  return F;
})();

export interface KalmanState {
  /** 길이 8. */
  mean: Float64Array;
  /** 8×8을 평탄화한 길이 64. */
  cov: Float64Array;
}

/**
 * 관측 하나로 트랙을 새로 세운다.
 *
 * 속도는 0으로 시작하고, 불확실성은 **박스 크기에 비례**한다 - 큰 물체는 몇 픽셀
 * 움직여도 같은 물체지만 작은 물체는 아니기 때문이다.
 */
export function initiate(x: number, y: number, w: number, h: number): KalmanState {
  const mean = new Float64Array(8);
  mean[0] = x;
  mean[1] = y;
  mean[2] = w;
  mean[3] = h;

  const std = [
    2 * POS_WEIGHT * w,
    2 * POS_WEIGHT * h,
    2 * POS_WEIGHT * w,
    2 * POS_WEIGHT * h,
    10 * VEL_WEIGHT * w,
    10 * VEL_WEIGHT * h,
    10 * VEL_WEIGHT * w,
    10 * VEL_WEIGHT * h,
  ];
  const cov = new Float64Array(64);
  for (let i = 0; i < 8; i++) cov[i * 8 + i] = std[i] * std[i];
  return { mean, cov };
}

/**
 * 한 프레임 앞을 내다본다.
 *
 * `mean = F @ mean`, `cov = F @ cov @ Fᵀ + Q`. `Q`(운동 잡음)는 대각이고 **지금 박스
 * 크기에 비례**한다.
 */
export function predict(s: KalmanState): KalmanState {
  const { mean, cov } = s;
  const w = mean[2];
  const h = mean[3];
  const std = [
    POS_WEIGHT * w,
    POS_WEIGHT * h,
    POS_WEIGHT * w,
    POS_WEIGHT * h,
    VEL_WEIGHT * w,
    VEL_WEIGHT * h,
    VEL_WEIGHT * w,
    VEL_WEIGHT * h,
  ];

  const newMean = new Float64Array(8);
  for (let i = 0; i < 8; i++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v += MOTION[i * 8 + k] * mean[k];
    newMean[i] = v;
  }

  const tmp = new Float64Array(64);
  mul8(MOTION, cov, tmp);
  const newCov = new Float64Array(64);
  // tmp @ Fᵀ
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      let v = 0;
      for (let k = 0; k < 8; k++) v += tmp[i * 8 + k] * MOTION[j * 8 + k];
      newCov[i * 8 + j] = v;
    }
  }
  for (let i = 0; i < 8; i++) newCov[i * 8 + i] += std[i] * std[i];

  return { mean: newMean, cov: newCov };
}

/**
 * 상태를 관측 공간(4차원)으로 내린다.
 *
 * 관측 행렬이 `[I₄ 0]`이라 앞 4×4를 떼어내는 것과 같다. 굳이 행렬곱을 돌리지 않는다.
 *
 * @param confidence 주면 **NSA-Kalman** - 신뢰도가 낮은 탐지일수록 관측 잡음을 키운다.
 */
function project(s: KalmanState, confidence?: number): { mean: Float64Array; cov: Float64Array } {
  const w = s.mean[2];
  const h = s.mean[3];
  const std = [POS_WEIGHT * w, POS_WEIGHT * h, POS_WEIGHT * w, POS_WEIGHT * h];
  const scale = confidence === undefined ? 1 : Math.max(1 - confidence, 0.05);

  const mean = new Float64Array(4);
  for (let i = 0; i < 4; i++) mean[i] = s.mean[i];

  const cov = new Float64Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) cov[i * 4 + j] = s.cov[i * 8 + j];
    cov[i * 4 + i] += std[i] * std[i] * scale;
  }
  return { mean, cov };
}

/**
 * `A @ X = B`를 푼다. `A`는 4×4, `B`는 4×n. 부분 피벗 가우스 소거다.
 *
 * 역행렬을 만들어 곱하지 않는 이유는 그쪽이 수치적으로 더 나쁘기 때문이다.
 */
function solve(A: Float64Array, B: Float64Array, n: number): Float64Array {
  const a = Float64Array.from(A);
  const b = Float64Array.from(B);

  for (let c = 0; c < 4; c++) {
    let pivot = c;
    for (let r = c + 1; r < 4; r++) {
      if (Math.abs(a[r * 4 + c]) > Math.abs(a[pivot * 4 + c])) pivot = r;
    }
    if (pivot !== c) {
      for (let k = 0; k < 4; k++) {
        const t = a[c * 4 + k];
        a[c * 4 + k] = a[pivot * 4 + k];
        a[pivot * 4 + k] = t;
      }
      for (let k = 0; k < n; k++) {
        const t = b[c * n + k];
        b[c * n + k] = b[pivot * n + k];
        b[pivot * n + k] = t;
      }
    }
    const d = a[c * 4 + c];
    if (d === 0) continue; // 특이 행렬 - 그 행을 0으로 두고 계속한다
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[r * 4 + c] / d;
      if (f === 0) continue;
      for (let k = c; k < 4; k++) a[r * 4 + k] -= f * a[c * 4 + k];
      for (let k = 0; k < n; k++) b[r * n + k] -= f * b[c * n + k];
    }
  }
  for (let c = 0; c < 4; c++) {
    const d = a[c * 4 + c];
    if (d === 0) continue;
    for (let k = 0; k < n; k++) b[c * n + k] /= d;
  }
  return b;
}

/**
 * 관측으로 상태를 고친다.
 *
 * `K = cov @ Hᵀ @ (H cov Hᵀ + R)⁻¹`를 풀어서 얻고, `mean += K @ (z - Hmean)`,
 * `cov -= K @ S @ Kᵀ`.
 */
export function correct(
  s: KalmanState,
  z: readonly [number, number, number, number],
  confidence?: number,
): KalmanState {
  const { mean: pm, cov: S } = project(s, confidence);

  // B = (cov @ Hᵀ)ᵀ = cov의 위쪽 4×8. H가 [I₄ 0]이라 이렇게 된다
  const B = new Float64Array(4 * 8);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 8; j++) B[i * 8 + j] = s.cov[i * 8 + j];
  }
  // X는 4×8. 칼만 이득 K는 그 전치라 8×4다
  const X = solve(S, B, 8);

  const newMean = Float64Array.from(s.mean);
  for (let i = 0; i < 8; i++) {
    let v = 0;
    for (let k = 0; k < 4; k++) v += (z[k] - pm[k]) * X[k * 8 + i];
    newMean[i] += v;
  }

  // K @ S -> 8×4
  const KS = new Float64Array(8 * 4);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 4; j++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += X[k * 8 + i] * S[k * 4 + j];
      KS[i * 4 + j] = v;
    }
  }
  const newCov = Float64Array.from(s.cov);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += KS[i * 4 + k] * X[k * 8 + j];
      newCov[i * 8 + j] -= v;
    }
  }
  return { mean: newMean, cov: newCov };
}
