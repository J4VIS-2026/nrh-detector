/**
 * 모델의 원시 출력을 원본 이미지 좌표계의 탐지 결과로 바꾼다.
 *
 * 이 모델은 `nms=False`로 export돼서 그래프가 원시 예측까지만 계산하고 멈춘다.
 * 신뢰도 필터, 억제(NMS), 좌표 매핑이 전부 여기 몫이다.
 *
 * **onnxruntime도 모델 파일도 건드리지 않는다.** 일부러 그렇게 뒀다. 아래 계산이 박스가
 * 밀리는 버그의 서식지인데, 3.5MB 모델을 로드해야만 검증할 수 있으면 곤란하다. 손으로
 * 만든 작은 배열로 전부 확인할 수 있어야 한다.
 */

import type { LetterboxParams } from './letterbox.js';
import { bankersRound } from './rounding.js';
import { makeDetection, type Detection } from './schema.js';

export const DEFAULT_CONF = 0.25;
export const DEFAULT_IOU = 0.7;

const EPSILON = 1e-9;

/** 모서리 기준 박스 하나. */
interface Candidate {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
  classId: number;
}

/**
 * 원시 출력 하나를 탐지 결과로 바꾼다.
 *
 * @param raw `output0` 텐서의 값. 모양은 `(1, 4 + 클래스수, 앵커수)`를 **평탄화한 것**.
 * @param channels `4 + 클래스수`.
 * @param anchors 앵커 개수 (640 입력이면 8400).
 * @param params 이 이미지에 대해 전처리가 만들어낸 레터박스 값.
 * @param classNames 클래스 id에서 이름으로. 모델 메타데이터에서 읽은 것.
 * @returns confidence 내림차순의 탐지 결과.
 */
export function postprocess(
  raw: Float32Array | number[],
  channels: number,
  anchors: number,
  params: LetterboxParams,
  classNames: ReadonlyMap<number, string>,
  conf: number = DEFAULT_CONF,
  iou: number = DEFAULT_IOU,
): Detection[] {
  const numClasses = channels - 4;
  if (numClasses <= 0 || anchors <= 0) return [];

  // 텐서는 (채널, 앵커) 순서다. 한 앵커의 값들이 앵커수만큼 떨어져 있다 -
  // 전치된 배열을 만들지 않고 그 간격으로 바로 읽는다
  const candidates: Candidate[] = [];
  for (let a = 0; a < anchors; a++) {
    let best = -Infinity;
    let bestId = -1;
    for (let c = 0; c < numClasses; c++) {
      const s = raw[(4 + c) * anchors + a];
      if (s > best) {
        best = s;
        bestId = c;
      }
    }
    if (best < conf) continue;

    const cx = raw[a];
    const cy = raw[anchors + a];
    const w = raw[2 * anchors + a];
    const h = raw[3 * anchors + a];
    candidates.push({
      x1: cx - w / 2,
      y1: cy - h / 2,
      x2: cx + w / 2,
      y2: cy + h / 2,
      score: best,
      classId: bestId,
    });
  }
  if (candidates.length === 0) return [];

  const kept = classWiseNms(candidates, iou);

  const detections = kept.map((b) => {
    const [x1, y1, x2, y2] = toOriginalCoords(b, params);
    return makeDetection({
      class_id: b.classId,
      class_name: classNames.get(b.classId) ?? `class_${b.classId}`,
      confidence: b.score,
      x1,
      y1,
      x2,
      y2,
      track_id: null,
    });
  });

  detections.sort((a, b) => b.confidence - a.confidence);
  return detections;
}

/**
 * 단일 클래스에 대한 탐욕적 비최대 억제(NMS).
 *
 * @returns 남길 박스. 점수가 높은 것부터.
 */
export function nms(boxes: readonly Candidate[], iouThreshold: number): Candidate[] {
  if (boxes.length === 0) return [];

  // **동점은 인덱스가 작은 쪽이 먼저다.** 파이썬이 `np.argsort(-scores, kind="stable")`로
  // 같은 규칙을 쓴다. 이 모델은 int8이라 점수가 이산값이고 동점이 흔해서, 규칙이
  // 없으면 어느 박스가 남을지가 정렬 구현에 달리게 된다
  const order = boxes
    .map((_, i) => i)
    .sort((a, b) => boxes[b].score - boxes[a].score || a - b);

  const keep: Candidate[] = [];
  const dead = new Uint8Array(boxes.length);
  const areas = boxes.map((b) => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1));

  for (const i of order) {
    if (dead[i]) continue;
    keep.push(boxes[i]);
    const A = boxes[i];
    for (const j of order) {
      if (j === i || dead[j]) continue;
      const B = boxes[j];
      const ow = Math.max(0, Math.min(A.x2, B.x2) - Math.max(A.x1, B.x1));
      const oh = Math.max(0, Math.min(A.y2, B.y2) - Math.max(A.y1, B.y1));
      const inter = ow * oh;
      const union = areas[i] + areas[j] - inter;
      if (inter / (union + EPSILON) > iouThreshold) dead[j] = 1;
    }
  }
  return keep;
}

/**
 * 같은 클래스 안에서만 억제한다. 클래스를 넘나들며 억제하지 않는다.
 *
 * **기둥 앞에 선 사람은 기둥과 같은 픽셀을 차지하지만 둘 다 남아야 한다.**
 *
 * **기준 구현과 같은 방법을 쓴다** - 클래스마다 좌표를 각자의 구간으로 옮겨 한 번에
 * 처리한다. 클래스별로 나눠 돌려도 남는 집합은 같지만 **순서가 달라진다.** 동점이
 * 흔한 모델이라(int8) 순서 차이가 곧 다른 박스로 이어져서, 방법까지 맞춰야 기준값과
 * 정확히 같은 답이 나온다.
 */
export function classWiseNms(boxes: readonly Candidate[], iouThreshold: number): Candidate[] {
  if (boxes.length === 0) return [];

  // 대역 폭은 **모든 좌표의 최댓값 + 1**이다. 클래스 하나를 통째로 옮겨도 옆 클래스와
  // 절대 겹치지 않을 만큼 벌어진다
  let max = 0;
  for (const b of boxes) {
    if (b.x1 > max) max = b.x1;
    if (b.y1 > max) max = b.y1;
    if (b.x2 > max) max = b.x2;
    if (b.y2 > max) max = b.y2;
  }
  const band = Math.max(max, 0) + 1;

  const shifted = boxes.map((b) => {
    const o = b.classId * band;
    return { ...b, x1: b.x1 + o, y1: b.y1 + o, x2: b.x2 + o, y2: b.y2 + o };
  });

  // 옮겨 놓은 것으로 억제하고, 돌려줄 때는 **원래 좌표**로 돌아간다
  const kept = nms(shifted, iouThreshold);
  const back = new Map(shifted.map((m, i) => [m, boxes[i]]));
  return kept.map((m) => back.get(m)!);
}

/**
 * 640 좌표계의 박스를 원본 이미지로 되돌리고, 잘라내고, 정수로 반올림한다.
 *
 * 전처리가 이 이미지에 대해 기록해둔 패딩과 스케일을 **그대로 쓴다.** 다시 계산하지
 * 않으므로 두 단계가 어긋날 수 없다.
 *
 * 반올림은 **은행가 반올림**이다 (numpy `rint`와 같다). `Math.round`를 쓰면 높이 1280
 * 이미지에서 좌표의 25%가 1px 어긋난다.
 */
export function toOriginalCoords(
  b: Candidate,
  params: LetterboxParams,
): [number, number, number, number] {
  const clip = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  const x1 = clip((b.x1 - params.padX) / params.scale, params.origWidth);
  const y1 = clip((b.y1 - params.padY) / params.scale, params.origHeight);
  const x2 = clip((b.x2 - params.padX) / params.scale, params.origWidth);
  const y2 = clip((b.y2 - params.padY) / params.scale, params.origHeight);
  return [bankersRound(x1), bankersRound(y1), bankersRound(x2), bankersRound(y2)];
}
