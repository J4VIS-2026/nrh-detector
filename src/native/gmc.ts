/**
 * 카메라 움직임 보정 (React Native).
 *
 * 왜 필요한지는 `core/gmc.ts` 의 파일 설명에 있다.
 *
 * **ORB 경로다.** 참조 구현 기본값은 `sparseOptFlow`인데 **`calcOpticalFlowPyrLK`가
 * `react-native-fast-opencv`에 없다.** 대신 ORB로 코너를 잡고 기술자로 짝지어 같은
 * 아핀을 푼다. 데스크톱에서 견줘보니 아핀 값 자체는 30~40% 다른데 **추적 결과는 같았다**
 * (트랙 15개, 평균 길이 53.8) - 그래서 이 경로를 골랐다.
 *
 * `estimateAffinePartial2D`도 없어서 **아핀은 `core/gmc`가 푼다** - 비율 검사(0.9)로
 * 거른 짝을 RANSAC에 넣는다. 웹과 같은 함수라 이 저장소의 테스트가 그대로 걸린다.
 */

import {
  OpenCV,
  Mat,
  Size,
  ColorConversionCodes,
  InterpolationFlags,
  NormTypes,
} from 'react-native-fast-opencv';

import { estimateSimilarityRansac, IDENTITY_WARP as IDENTITY } from '../core/gmc.js';

export interface GmcOptions {
  /**
   * 축소 배율. **1/4가 기본이다.** 근거는 `core/gmc.ts` 의 `GmcOptions.downscale` 참고.
   *
   * **1/8까지 내리지 마라.** 여기서는 13ms로 제일 빨라 보이지만 **매칭이 0쌍이라
   * 보정이 동작하지 않는다.**
   */
  downscale: number;
  /**
   * ORB가 잡을 최대 코너 수.
   *
   * **500이면 실제 거리 영상에서 매칭이 440쌍 남는다.** 아핀을 풀기에 넉넉하다 -
   * 넉넉해도 너무 넉넉하다. 문서에 적혀 있던 121쌍은 격자 무늬 가짜 프레임에서 나온
   * 값이라 실제의 4분의 1이었다.
   *
   * **짝이 많으면 RANSAC이 비싸진다.** 안쪽 루프가 `반복 × 짝수`라 440쌍에서 36ms가
   * 나왔다. 지금은 일찍 끊어 3ms지만, 여길 더 줄이고 싶으면 `nfeatures`를 내리는 것도
   * 방법이다 - 내리기 전에 트랙 품질을 같이 재라.
   */
  nfeatures: number;
}

export const DEFAULT_GMC_OPTIONS: GmcOptions = { downscale: 4, nfeatures: 500 };

/**
 * 프레임을 받아 2×3 아핀을 돌려주는 함수를 만든다. `Tracker`에 그대로 넣는다.
 *
 * ```ts
 * const tracker = new Tracker({}, createGmc());
 * ```
 *
 * **첫 프레임에는 항등을 돌려준다** - 견줄 이전 프레임이 없다.
 */
export function createGmc(options: Partial<GmcOptions> = {}): (frame: unknown) => number[] {
  const { downscale, nfeatures } = { ...DEFAULT_GMC_OPTIONS, ...options };
  const orb = OpenCV.ORB_create(nfeatures);
  const matcher = OpenCV.BFMatcher_create(NormTypes.NORM_HAMMING, false);

  /**
   * 지난 프레임의 코너와 기술자를 보관한다.
   *
   * **예전에는 매 프레임 지난 것까지 다시 구했다** - 이미 구해뒀던 값을 버리고 또
   * 구하는 것이라, 제일 비싼 단계를 두 번 돌리고 있었다.
   */
  let prev: { small: Mat; feat: ReturnType<typeof OpenCV.detectAndCompute>;
              kp: { x: number; y: number }[] } | null = null;

  return (frame: unknown): number[] => {
    const f = frame as Mat;
    const W = f.cols;
    const H = f.rows;
    const sw = Math.max(1, Math.floor(W / downscale));
    const sh = Math.max(1, Math.floor(H / downscale));

    const gray = Mat.createFromBuffer('uint8', H, W, 1, new Uint8Array(H * W));
    OpenCV.cvtColor(f, gray, ColorConversionCodes.COLOR_RGB2GRAY);
    const small = Mat.createFromBuffer('uint8', sh, sw, 1, new Uint8Array(sh * sw));
    OpenCV.resize(gray, small, Size.create(sw, sh), 0, 0, InterpolationFlags.INTER_AREA);
    gray.release();

    const feat = OpenCV.detectAndCompute(orb, small);
    const kp = feat.keypoints.toArray();
    const cur = { small, feat, kp };

    if (prev === null) {
      prev = cur;
      return [...IDENTITY];
    }

    let out: number[] = [...IDENTITY];
    {
      if (prev.kp.length >= 5 && kp.length >= 5) {
        const knn = OpenCV.knnMatchBF(matcher, prev.feat.descriptors, feat.descriptors, 2);
        try {
          // `queryIdx`는 지난 프레임, `trainIdx`는 이번 프레임을 가리킨다
          const kp0 = prev.kp;
          const kp1 = kp;
          const pairs: number[][] = [];
          for (let i = 0; i < knn.length; i++) {
            const m = knn.get(i);
            if (m.length < 2) continue;
            // 비율 검사 - 1등이 2등보다 확실히 가까울 때만 믿는다. 여기서 거른 짝을
            // 아래 RANSAC 에 넣으므로, 0.9 를 더 낮추면 RANSAC 이 볼 짝이 줄어든다
            if (m[0].distance >= 0.9 * m[1].distance) continue;
            const p = kp0[m[0].queryIdx];
            const q = kp1[m[0].trainIdx];
            if (!p || !q) continue;
            pairs.push([p.x, p.y, q.x, q.y]); // KeyPoint는 pt 없이 x·y를 직접 가진다
          }
          if (pairs.length > 4) {
            const r = estimateSimilarityRansac(pairs, 200, 3);
            if (r) {
              const [ca, cb, tx, ty] = r;
              // **평행이동만 원래 해상도로 되돌린다.** 회전·축척은 배율과 무관하다
              out = [ca, -cb, tx * downscale, cb, ca, ty * downscale];
            }
          }
        } finally {
          knn.release();
        }
      }
    }

    prev.small.release();
    prev.feat.keypoints.release();
    prev.feat.descriptors.release();
    prev = cur;
    return out;
  };
}
