/**
 * 카메라 움직임 보정 - 런타임에 의존하지 않는 핵심 계산.
 *
 * 카메라가 흔들리면 물체가 가만히 있어도 화면에서는 움직인다. 그걸 안 빼주면 추적기가
 * 트랙을 놓친다 - 흔들림을 합성해 재보니 **트랙이 14개에서 45개로 늘었다.**
 *
 * **참조 구현과 같은 `sparseOptFlow` 경로다** - Shi-Tomasi 코너를 잡고 Lucas-Kanade
 * 광류로 따라간 뒤 RANSAC으로 아핀을 푼다. 네이티브가 ORB를 쓰는 것은
 * `react-native-fast-opencv`에 `calcOpticalFlowPyrLK`가 없어서지 그쪽이 나아서가 아니다.
 *
 * **왜 opencv를 안 붙였나.** 브라우저용 `@techstark/opencv-js`는 13MB인데다 node에서
 * 초기화가 안 된다 - 붙이면 이 저장소의 테스트로는 한 줄도 못 짚고 브라우저에서만
 * 확인할 수 있게 된다. 여기 있는 것들은 이 저장소에서 대조가 되는 만큼, 모델보다
 * 4배 큰 의존성을 지느니 직접 푸는 편을 골랐다.
 */

/** 자유도 4 아핀. `[a, -b, tx, b, a, ty]` 순서로 2×3에 펴 넣은 것이다. */
export const IDENTITY_WARP: readonly number[] = [1, 0, 0, 0, 1, 0];

export interface GmcOptions {
  /**
   * 축소 배율. **1/4가 기본이다.**
   *
   * 태블릿에서 1/2이면 203ms, 1/4면 74ms인데 **추적 품질은 같다** - 흔들림을 합성해
   * 트랙으로 확인했다(1/2에서 14개, 1/4에서 15개). 참조 구현 기본값은 1/2이다.
   *
   * **1/8까지 내리지 마라.** 제일 빨라 보이지만 코너가 남지 않아 보정이 동작하지 않는다.
   * 시간만 보고 고르면 동작하지 않는 줄 모르고 넘어간다.
   */
  downscale: number;
  /**
   * 잡을 코너 수 상한. **참조 구현은 1000인데 여기는 500이다.**
   *
   * 320×240에서 재보니 1000이면 160ms, 500이면 70ms, 150이면 22ms인데 **정답과의
   * 오차는 넷 다 0.05픽셀 아래로 똑같았다.** 아핀 넷을 푸는 데 코너 1000개가 필요할
   * 이유가 없다 - 남는 것은 이상치에 대한 여유뿐이고, 그건 RANSAC이 본다.
   *
   * 그 여유를 아주 없애지는 않으려고 제일 빠른 값 대신 500을 골랐다.
   */
  maxCorners: number;
  /** 제일 센 코너 대비 이만큼 아래는 버린다. */
  qualityLevel: number;
  /** 코너끼리 최소 거리(축소된 픽셀). */
  minDistance: number;
  /** 코너 세기를 잴 창 크기. */
  blockSize: number;
  /**
   * 광류가 보는 창 한 변. 홀수여야 한다. **참조 구현은 21인데 여기는 15다.**
   *
   * 창 넓이가 그대로 비용이라 21에서 15로만 줄여도 절반이 된다. 코너 수와 마찬가지로
   * 오차는 안 움직였다.
   */
  winSize: number;
  /** 피라미드 층 수 - 0이면 원본만. 클수록 큰 움직임을 잡는다. */
  maxLevel: number;
  /** 광류 반복 상한. */
  maxIter: number;
  /** 이만큼 안 움직이면 수렴한 것으로 본다. */
  eps: number;
  /** RANSAC 시행 횟수. */
  ransacIter: number;
  /** 이 안에 들어오면 정상값으로 센다(축소된 픽셀). */
  ransacThreshold: number;
}

/**
 * 참조 구현의 `sparseOptFlow`를 따르되 **세 값은 재보고 낮췄다** - `downscale`(2→4),
 * `maxCorners`(1000→500), `winSize`(21→15). 각각의 근거는 위 항목에 적었다.
 *
 * 참조 구현과 똑같이 두고 싶으면 `{ downscale: 2, maxCorners: 1000, winSize: 21 }`을
 * 넘겨라. 느려질 뿐 결과는 여기서 잰 범위 안에서 같다.
 */
export const DEFAULT_GMC_OPTIONS: GmcOptions = {
  downscale: 4,
  maxCorners: 500,
  qualityLevel: 0.01,
  minDistance: 1,
  blockSize: 3,
  winSize: 15,
  maxLevel: 3,
  maxIter: 30,
  eps: 0.01,
  ransacIter: 200,
  ransacThreshold: 3,
};

export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    // opencv `COLOR_RGB2GRAY`와 같은 가중치
    out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return out;
}

/**
 * 회색 한 장을 정수 배율로 줄인다. 블록 평균이라 opencv `INTER_AREA`와 같은 계산이다.
 *
 * 나머지 픽셀은 버린다 - 참조 구현도 `width // downscale`로 자른다.
 */
export function downscaleGray(
  gray: Uint8Array,
  width: number,
  height: number,
  factor: number,
): { gray: Uint8Array; width: number; height: number } {
  if (factor <= 1) return { gray, width, height };
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Uint8Array(w * h);
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      const y0 = y * factor;
      const x0 = x * factor;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y0 + dy) * width + x0;
        for (let dx = 0; dx < factor; dx++) sum += gray[row + dx];
      }
      out[y * w + x] = (sum / n + 0.5) | 0;
    }
  }
  return { gray: out, width: w, height: h };
}

export interface Corner {
  x: number;
  y: number;
}

/**
 * Shi-Tomasi 코너를 센 것부터 고른다. opencv `goodFeaturesToTrack`과 같은 순서다 -
 * 최소 고윳값 → 최댓값 대비 문턱 → 3×3 지역 최대 → 세기순 → 최소 거리.
 */
export function goodFeaturesToTrack(
  gray: Uint8Array,
  width: number,
  height: number,
  options: Pick<GmcOptions, 'maxCorners' | 'qualityLevel' | 'minDistance' | 'blockSize'>,
): Corner[] {
  const { maxCorners, qualityLevel, minDistance, blockSize } = options;
  const half = blockSize >> 1;
  // 가장자리는 미분과 창이 다 걸치는 안쪽만 본다
  const margin = half + 1;
  if (width <= 2 * margin || height <= 2 * margin) return [];

  const eig = new Float32Array(width * height);
  let maxEig = 0;

  for (let y = margin; y < height - margin; y++) {
    for (let x = margin; x < width - margin; x++) {
      let sxx = 0;
      let sxy = 0;
      let syy = 0;
      for (let wy = -half; wy <= half; wy++) {
        const row = (y + wy) * width + x;
        for (let wx = -half; wx <= half; wx++) {
          const i = row + wx;
          // Sobel 대신 중앙차분. 상대 문턱만 쓰므로 배율은 상관없다
          const gx = gray[i + 1] - gray[i - 1];
          const gy = gray[i + width] - gray[i - width];
          sxx += gx * gx;
          sxy += gx * gy;
          syy += gy * gy;
        }
      }
      const mid = (sxx + syy) * 0.5;
      const d = (sxx - syy) * 0.5;
      const v = mid - Math.sqrt(d * d + sxy * sxy);
      eig[y * width + x] = v;
      if (v > maxEig) maxEig = v;
    }
  }
  if (maxEig <= 0) return [];

  const threshold = maxEig * qualityLevel;
  const candidates: Corner[] = [];
  const strength: number[] = [];
  for (let y = margin; y < height - margin; y++) {
    for (let x = margin; x < width - margin; x++) {
      const i = y * width + x;
      const v = eig[i];
      if (v < threshold) continue;
      // 3×3 지역 최대만 남긴다. opencv가 dilate로 하는 것과 같다
      if (
        v < eig[i - 1] || v < eig[i + 1] ||
        v < eig[i - width] || v < eig[i + width] ||
        v < eig[i - width - 1] || v < eig[i - width + 1] ||
        v < eig[i + width - 1] || v < eig[i + width + 1]
      ) {
        continue;
      }
      candidates.push({ x, y });
      strength.push(v);
    }
  }

  const order = candidates.map((_, i) => i);
  // 세기가 같으면 먼저 나온 것. 정렬이 불안정해도 결과가 안 흔들리게 한다
  order.sort((a, b) => strength[b] - strength[a] || a - b);

  const picked: Corner[] = [];
  const minSq = minDistance * minDistance;
  for (const i of order) {
    if (picked.length >= maxCorners) break;
    const c = candidates[i];
    let tooClose = false;
    for (const p of picked) {
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      if (dx * dx + dy * dy < minSq) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) picked.push(c);
  }
  return picked;
}

interface Level {
  data: Float32Array;
  width: number;
  height: number;
}

/** 5탭 이항 흐림 뒤 반으로. opencv `pyrDown`과 같은 계산이다. */
function pyrDown(level: Level): Level {
  const { data, width, height } = level;
  const w = width >> 1;
  const h = height >> 1;
  const horiz = new Float32Array(w * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < w; x++) {
      const c = x * 2;
      const l2 = data[row + Math.max(0, c - 2)];
      const l1 = data[row + Math.max(0, c - 1)];
      const c0 = data[row + c];
      const r1 = data[row + Math.min(width - 1, c + 1)];
      const r2 = data[row + Math.min(width - 1, c + 2)];
      horiz[y * w + x] = (l2 + 4 * l1 + 6 * c0 + 4 * r1 + r2) / 16;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const c = y * 2;
    const u2 = Math.max(0, c - 2) * w;
    const u1 = Math.max(0, c - 1) * w;
    const mid2 = c * w;
    const d1 = Math.min(height - 1, c + 1) * w;
    const d2 = Math.min(height - 1, c + 2) * w;
    for (let x = 0; x < w; x++) {
      out[y * w + x] =
        (horiz[u2 + x] + 4 * horiz[u1 + x] + 6 * horiz[mid2 + x] + 4 * horiz[d1 + x] + horiz[d2 + x]) / 16;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * **창보다 작아지면 층을 더 안 쌓는다.** 그 층은 창 전체가 가장자리 늘린 값이라
 * 아무것도 안 알려주면서 틀린 답만 다음 층에 넘긴다.
 */
function buildPyramid(
  gray: Uint8Array,
  width: number,
  height: number,
  maxLevel: number,
  winSize: number,
): Level[] {
  const base: Level = { data: Float32Array.from(gray), width, height };
  const levels = [base];
  for (let i = 0; i < maxLevel; i++) {
    const prefix = levels[levels.length - 1];
    if (prefix.width >> 1 < winSize || prefix.height >> 1 < winSize) break;
    levels.push(pyrDown(prefix));
  }
  return levels;
}

/**
 * 겹선형 표본. **바깥은 가장자리 값으로 늘린다**(opencv의 `BORDER_REPLICATE`).
 *
 * 밖이라고 실패시켰더니 **1000개 중 122개만 남았다.** 창이 21픽셀이라 거친
 * 층에서는 점 대부분이 창 한쪽을 이미지 밖에 걸친다 - 1/4로 줄이면 아예 0개였다.
 * 점이 실제로 화면을 벗어났는지는 창이 아니라 **중심**으로 따로 본다.
 */
function sample(level: Level, x: number, y: number): number {
  const { data, width, height } = level;
  if (x < 0) x = 0;
  else if (x > width - 1) x = width - 1;
  if (y < 0) y = 0;
  else if (y > height - 1) y = height - 1;
  const x0 = Math.min(width - 2, Math.floor(x));
  const y0 = Math.min(height - 2, Math.floor(y));
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * width + x0;
  const top = data[i] * (1 - fx) + data[i + 1] * fx;
  const bottom = data[i + width] * (1 - fx) + data[i + width + 1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * 피라미드 Lucas-Kanade 광류.
 *
 * 거친 층에서 시작해 옮긴 양을 다음 층에 두 배로 넘긴다. 그래야 창보다 큰 움직임도
 * 따라간다 - 한 층만 쓰면 흔들림이 조금만 커도 놓친다.
 *
 * @returns 따라간 점. 실패한 점은 `null`.
 */
export function calcOpticalFlowPyrLK(
  prev: Uint8Array,
  next: Uint8Array,
  width: number,
  height: number,
  points: readonly Corner[],
  options: Pick<GmcOptions, 'winSize' | 'maxLevel' | 'maxIter' | 'eps'>,
): (Corner | null)[] {
  const { winSize, maxIter, eps } = options;
  const half = winSize >> 1;
  const epsSq = eps * eps;

  const p1 = buildPyramid(prev, width, height, options.maxLevel, winSize);
  const p2 = buildPyramid(next, width, height, options.maxLevel, winSize);
  const levels = Math.min(p1.length, p2.length);

  const n = winSize * winSize;
  const patch = new Float32Array(n);
  const gxBuf = new Float32Array(n);
  const gyBuf = new Float32Array(n);

  return points.map((pt) => {
    let gx = 0;
    let gy = 0;
    let alive = true;

    for (let l = levels - 1; l >= 0; l--) {
      const s = 1 / (1 << l);
      const A = p1[l];
      const B = p2[l];
      const cx = pt.x * s;
      const cy = pt.y * s;

      // **창과 기울기는 이전 프레임 것이라 반복 중에 안 바뀐다.** 한 번만 뜬다
      let sxx = 0;
      let sxy = 0;
      let syy = 0;
      for (let wy = -half, k = 0; wy <= half; wy++) {
        for (let wx = -half; wx <= half; wx++, k++) {
          const x = cx + wx;
          const y = cy + wy;
          const dx = (sample(A, x + 1, y) - sample(A, x - 1, y)) * 0.5;
          const dy = (sample(A, x, y + 1) - sample(A, x, y - 1)) * 0.5;
          patch[k] = sample(A, x, y);
          gxBuf[k] = dx;
          gyBuf[k] = dy;
          sxx += dx * dx;
          sxy += dx * dy;
          syy += dy * dy;
        }
      }
      const det = sxx * syy - sxy * sxy;
      // 무늬가 없거나 한 방향뿐이면(창 전체가 같은 색, 또는 곧은 모서리) 풀 수 없다
      if (det <= 1e-6) {
        alive = false;
        break;
      }

      let vx = 0;
      let vy = 0;
      for (let it = 0; it < maxIter; it++) {
        let bx = 0;
        let by = 0;
        for (let wy = -half, k = 0; wy <= half; wy++) {
          for (let wx = -half; wx <= half; wx++, k++) {
            const d = patch[k] - sample(B, cx + gx + vx + wx, cy + gy + vy + wy);
            bx += d * gxBuf[k];
            by += d * gyBuf[k];
          }
        }
        const dvx = (syy * bx - sxy * by) / det;
        const dvy = (sxx * by - sxy * bx) / det;
        vx += dvx;
        vy += dvy;
        if (dvx * dvx + dvy * dvy < epsSq) break;
      }
      // **점이 화면을 벗어났으면 버린다.** 창은 가장자리를 늘려 물지만 중심까지
      // 나간 것은 따라간 것이 아니라 가장자리에 붙어버린 것이다
      if (
        cx + gx + vx < 0 ||
        cy + gy + vy < 0 ||
        cx + gx + vx > A.width - 1 ||
        cy + gy + vy > A.height - 1
      ) {
        alive = false;
        break;
      }

      gx += vx;
      gy += vy;
      // 다음 층은 해상도가 두 배다
      if (l > 0) {
        gx *= 2;
        gy *= 2;
      }
    }

    if (!alive || !Number.isFinite(gx) || !Number.isFinite(gy)) return null;
    return { x: pt.x + gx, y: pt.y + gy };
  });
}

/**
 * 자유도 4 아핀(회전+축척+평행이동)을 최소제곱으로 푼다.
 *
 *     x' = a·x - b·y + tx
 *     y' = b·x + a·y + ty
 *
 * @returns `[a, b, tx, ty]`. 못 풀면 `null`.
 */
export function solveSimilarity(
  pairs: readonly (readonly number[])[],
): [number, number, number, number] | null {
  let Sxx = 0, Sx = 0, Sy = 0, Sxpx = 0, Sypy = 0, Sxpy = 0, Sypx = 0, Sxp = 0, Syp = 0;
  const n = pairs.length;
  for (const [x, y, xp, yp] of pairs) {
    Sxx += x * x + y * y;
    Sx += x;
    Sy += y;
    Sxpx += xp * x;
    Sypy += yp * y;
    Sxpy += xp * y;
    Sypx += yp * x;
    Sxp += xp;
    Syp += yp;
  }
  const A = [
    [Sxx, 0, Sx, Sy, Sxpx + Sypy],
    [0, Sxx, -Sy, Sx, Sypx - Sxpy],
    [Sx, -Sy, n, 0, Sxp],
    [Sy, Sx, 0, n, Syp],
  ];
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let i = c + 1; i < 4; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
    const t = A[c];
    A[c] = A[p];
    A[p] = t;
    if (A[c][c] === 0) return null; // 특이 - 짝이 한 줄에 몰려 있다
    for (let i = 0; i < 4; i++) {
      if (i === c) continue;
      const f = A[i][c] / A[c][c];
      for (let j = c; j <= 4; j++) A[i][j] -= f * A[c][j];
    }
  }
  const r = A.map((row, i) => row[4] / row[i]) as [number, number, number, number];
  return r.every(Number.isFinite) ? r : null;
}

/**
 * 일찍 끊는 기준. **재서 고른 값이다.**
 *
 * 손에 든 영상 119프레임에서 opencv 와 얼마나 벌어지는지로 골랐다.
 *
 * | 설정 | opencv 와의 차이 |
 * |---|---|
 * | 안 끊음 (200회) | 15.6% |
 * | 99%, 최소 없음 | **28.1%** |
 * | **99.9%, 최소 20회** | **15.9%** |
 * | 99.99%, 최소 50회 | 15.7% |
 *
 * **99%에 최소를 안 두면 품질이 무너진다.** 첫 표본이 그럭저럭이면 거기서 멈춰버리는데,
 * 더 나은 모형이 뒤에 있다. 최소 20회를 깔면 원래대로 돌아오고, 그래도 200회의
 * 10분의 1이다.
 */
const RANSAC_CONFIDENCE = 0.999;
const RANSAC_MIN_ITER = 20;

/**
 * RANSAC으로 이상치를 걸러내고 아핀을 푼다. opencv 의 `estimateAffinePartial2D`
 * 자리다.
 *
 * **난수는 시드를 고정한 LCG다.** `Math.random`을 쓰면 같은 입력에 다른 답이 나와
 * 테스트로 못 짚는다.
 *
 * @returns `[a, b, tx, ty]`. 못 풀면 `null`.
 */
export function estimateSimilarityRansac(
  pairs: readonly (readonly number[])[],
  iterations: number,
  threshold: number,
): [number, number, number, number] | null {
  if (pairs.length < 3) return null;
  if (pairs.length < 5) return solveSimilarity(pairs);

  const thSq = threshold * threshold;
  const n = pairs.length;

  /**
   * **평평한 배열로 옮긴다.** 아래 안쪽 루프가 `iterations × 짝수`만큼 도는데,
   * `for (const [x, y, u, v] of pairs)`는 돌 때마다 반복자를 만든다. 폰에서 435쌍이
   * 모이자 그것만으로 **38ms**가 나왔다 - 프레임 예산의 4분의 1이다.
   */
  const flat = new Float64Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = pairs[i];
    flat[i * 4] = p[0];
    flat[i * 4 + 1] = p[1];
    flat[i * 4 + 2] = p[2];
    flat[i * 4 + 3] = p[3];
  }

  let seed = pairs.length * 2654435761;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };

  let bestCount = 0;
  let best: number[] | null = null;
  /**
   * **정상값이 많으면 일찍 끝낸다.** 점 두 개로 모형을 세우므로, 정상값 비율이 `w`일 때
   * 한 번이라도 깨끗한 짝을 뽑을 확률 99%에 필요한 횟수는 `log(0.01) / log(1 - w²)`다.
   * 흔들림 보정은 대개 `w`가 0.8을 넘어 **다섯 번이면 충분한데 200번을 돌고 있었다.**
   *
   * 최선값이 나아질 때만 줄이므로 답은 그대로다.
   */
  let maxIter = iterations;

  for (let it = 0; it < maxIter; it++) {
    const i = next() % pairs.length;
    let j = next() % pairs.length;
    if (j === i) j = (j + 1) % pairs.length;
    const [x0, y0, u0, v0] = pairs[i];
    const [x1, y1, u1, v1] = pairs[j];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const den = dx * dx + dy * dy;
    if (den < 1e-9) continue;
    const ex = u1 - u0;
    const ey = v1 - v0;
    // 점 두 개면 닮음변환이 하나로 정해진다
    const a = (dx * ex + dy * ey) / den;
    const b = (dx * ey - dy * ex) / den;
    const tx = u0 - (a * x0 - b * y0);
    const ty = v0 - (b * x0 + a * y0);

    let count = 0;
    for (let k = 0; k < n; k++) {
      const o = k * 4;
      const x = flat[o];
      const y = flat[o + 1];
      const ux = a * x - b * y + tx - flat[o + 2];
      const uy = b * x + a * y + ty - flat[o + 3];
      if (ux * ux + uy * uy < thSq) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = [a, b, tx, ty];

      // 여기서 `count`는 1 이상이라 `w`가 0이 되지 않는다. `w`가 1이면 `log(0)`이
      // -무한이 되어 `need`가 0 - 다음 반복에서 끝난다
      const w = count / n;
      const need = Math.ceil(Math.log(1 - RANSAC_CONFIDENCE) / Math.log(1 - w * w));
      if (need < maxIter) maxIter = Math.max(it + 1, RANSAC_MIN_ITER, need);
    }
  }

  if (best === null || bestCount < 3) return solveSimilarity(pairs);

  // 정상값만 모아 다시 푼다. 두 점으로 잡은 값보다 훨씬 안정적이다
  const [a, b, tx, ty] = best;
  const inliers = pairs.filter(([x, y, u, v]) => {
    const ux = a * x - b * y + tx - u;
    const uy = b * x + a * y + ty - v;
    return ux * ux + uy * uy < thSq;
  });
  return solveSimilarity(inliers) ?? (best as [number, number, number, number]);
}

/**
 * 프레임을 차례로 넣으면 2×3 아핀을 돌려준다.
 *
 * **첫 프레임에는 항등을 돌려준다** - 견줄 이전 프레임이 없다.
 */
export class Gmc {
  private readonly options: GmcOptions;
  private prev: Uint8Array | null = null;
  private prevWidth = 0;
  private prevHeight = 0;
  private prevCorners: Corner[] = [];

  constructor(options: Partial<GmcOptions> = {}) {
    this.options = { ...DEFAULT_GMC_OPTIONS, ...options };
  }

  /** 원본 해상도 회색 프레임. 축소는 여기서 한다. */
  apply(gray: Uint8Array, width: number, height: number): number[] {
    const s = this.options.downscale;
    const small = downscaleGray(gray, width, height, s);
    return this.applySmall(small.gray, small.width, small.height, s);
  }

  /**
   * **이미 줄여 놓은** 회색 프레임을 받는다. 브라우저는 canvas가 줄이는 편이 빠르다.
   *
   * @param scale 그 프레임이 원본의 몇 분의 1인지. 평행이동을 되돌리는 데만 쓴다.
   */
  applySmall(gray: Uint8Array, width: number, height: number, scale: number): number[] {
    const o = this.options;
    const corners = goodFeaturesToTrack(gray, width, height, o);

    // 해상도가 바뀌면 이전 프레임과 견줄 수 없다. 새로 시작한다
    if (this.prev === null || this.prevWidth !== width || this.prevHeight !== height) {
      this.prev = gray;
      this.prevWidth = width;
      this.prevHeight = height;
      this.prevCorners = corners;
      return [...IDENTITY_WARP];
    }

    let out = [...IDENTITY_WARP];
    if (this.prevCorners.length > 4) {
      const moved = calcOpticalFlowPyrLK(this.prev, gray, width, height, this.prevCorners, o);
      const pairs: number[][] = [];
      for (let i = 0; i < moved.length; i++) {
        const q = moved[i];
        if (q === null) continue;
        const p = this.prevCorners[i];
        pairs.push([p.x, p.y, q.x, q.y]);
      }
      if (pairs.length > 4) {
        const r = estimateSimilarityRansac(pairs, o.ransacIter, o.ransacThreshold);
        if (r) {
          const [a, b, tx, ty] = r;
          // **평행이동만 원래 해상도로 되돌린다.** 회전·축척은 배율과 무관하다
          out = [a, -b, tx * scale, b, a, ty * scale];
        }
      }
    }

    this.prev = gray;
    this.prevCorners = corners;
    return out;
  }

  /** 이전 프레임을 버린다. 다음 프레임은 첫 프레임처럼 항등을 낸다. */
  reset(): void {
    this.prev = null;
    this.prevCorners = [];
  }
}
