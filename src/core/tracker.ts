/**
 * 프레임을 넘나드는 객체 ID.
 *
 * 탐지는 프레임마다 독립이라 3번 프레임의 볼라드와 4번 프레임의 볼라드가 같은
 * 것인지 알 방법이 없다. 여기가 그 동일성을 붙인다.
 *
 * **탐지기와 분리돼 있다.** 추적은 추론이 아니고, 묶어두면 모델을 열지 않고는 추적
 * 로직을 테스트할 수 없게 된다.
 */

import { BotSort, DEFAULT_TRACK_PARAMS, type GmcFn, type TrackParams } from './botsort.js';
import type { DetectionResult } from './schema.js';

export { DEFAULT_TRACK_PARAMS, type TrackParams, type GmcFn };

/**
 * 결과를 순서대로 넣으면 `track_id`를 채워 돌려준다.
 *
 * **상태가 쌓이므로 영상 하나에 하나씩** 쓴다. 다른 영상을 시작하려면 새로
 * 만들거나 `reset()`을 부른다.
 *
 * `track_buffer`는 **넣은 프레임 수**를 센다. 초가 아니다 - 프레임을 건너뛰면 같은
 * 버퍼가 더 긴 실제 시간을 뜻하게 된다.
 *
 * ```ts
 * const tracker = new Tracker();
 * for await (const frame of frames) {
 *   const r = tracker.update(await det.detect(frame), frame);
 *   for (const d of r.detections) console.log(d.track_id, d.class_name);
 * }
 * ```
 */
export class Tracker {
  private readonly inner: BotSort;

  constructor(params?: Partial<TrackParams>, gmc?: GmcFn) {
    this.inner = new BotSort({ ...DEFAULT_TRACK_PARAMS, ...params }, gmc ?? null);
  }

  /**
   * 탐지에 ID를 붙인 새 결과를 돌려준다.
   *
   * @param result 탐지기가 낸 결과.
   * @param frame 그 프레임의 픽셀. 카메라 움직임 보정에 쓴다. 안 주면 보정 없이
   *   간다 - **정확도만 떨어지고 멈추지는 않는다.**
   *
   * ID를 못 받은 탐지는 `track_id`가 `null`로 남는다. 새로 나타났거나(아직 확정 전)
   * 어느 트랙에도 안 붙은 것들이다.
   */
  update(result: DetectionResult, frame?: unknown): DetectionResult {
    const inputs = result.detections.map((d) => ({
      x1: d.x1,
      y1: d.y1,
      x2: d.x2,
      y2: d.y2,
      score: d.confidence,
      classId: d.class_id,
    }));
    const ids = this.inner.update(inputs, frame);

    return {
      ...result,
      // **`track`을 정하는 곳은 여기다.** 탐지기는 항상 거짓으로 내보내므로, 이 값이
      // 참이면 실제로 추적을 거쳤다는 뜻이 된다
      settings: { ...result.settings, track: true },
      detections: result.detections.map((d, i) => ({
        ...d,
        track_id: ids.has(i) ? ids.get(i)! : null,
      })),
    };
  }

  /** 트랙을 전부 버리고 ID를 처음부터 다시 센다. */
  reset(): void {
    this.inner.reset();
  }
}
