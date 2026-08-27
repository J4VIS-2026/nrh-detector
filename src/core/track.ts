/**
 * 트랙 하나 - BoT-SORT의 `BOTrack`.
 *
 * 한 물체가 프레임을 넘나들며 갖는 상태다. 칼만 상태(위치·크기·속도), 살아있는지,
 * 몇 프레임째인지를 기록해 둔다.
 */

import { correct, initiate, predict, type KalmanState } from './kalman.js';
import type { Box } from './assign.js';

export const TrackState = {
  New: 0,
  Tracked: 1,
  Lost: 2,
  Removed: 3,
} as const;
export type TrackStateValue = (typeof TrackState)[keyof typeof TrackState];

/**
 * `(x, y, w, h)` - 중심과 크기.
 *
 * BoT-SORT는 **종횡비가 아니라 너비를 직접** 추적한다. 원조 SORT 계열은 `(x, y, a, h)`로
 * 종횡비를 쓰는데, 그러면 너비 변화가 높이에 얽힌다.
 */
export type XYWH = [number, number, number, number];

export class Track {
  state: TrackStateValue = TrackState.New;
  trackId = 0;
  isActivated = false;
  kalman: KalmanState | null = null;
  trackletLen = 0;
  frameId = 0;
  startFrame = 0;

  /** 칼만 상태가 서기 전에 쓸 원본 관측. */
  private readonly firstObs: XYWH;

  constructor(
    xywh: XYWH,
    public score: number,
    public cls: number,
    /** 이 프레임 탐지 배열에서의 원래 인덱스. 결과를 되짚는 데 쓴다. */
    public idx: number,
  ) {
    this.firstObs = [...xywh] as XYWH;
  }

  get endFrame(): number {
    return this.frameId;
  }

  /** 지금 추정 위치, `(x, y, w, h)`. */
  get xywh(): XYWH {
    if (!this.kalman) return [...this.firstObs] as XYWH;
    const m = this.kalman.mean;
    return [m[0], m[1], m[2], m[3]];
  }

  /** 지금 추정 위치, 모서리 기준. 연관에 쓰는 형태다. */
  get box(): Box {
    const [x, y, w, h] = this.xywh;
    return { x1: x - w / 2, y1: y - h / 2, x2: x + w / 2, y2: y + h / 2 };
  }

  /**
   * 한 프레임 앞을 내다본다.
   *
   * **추적 중이 아니면 크기 속도를 0으로 죽인다.** 놓친 트랙이 계속 커지거나 작아지면
   * 다시 만났을 때 IoU가 안 맞는다.
   */
  step(): void {
    if (!this.kalman) return;
    const mean = Float64Array.from(this.kalman.mean);
    if (this.state !== TrackState.Tracked) {
      mean[6] = 0;
      mean[7] = 0;
    }
    this.kalman = predict({ mean, cov: this.kalman.cov });
  }

  /**
   * 새 트랙으로 세운다.
   *
   * @param confirmImmediately 참이면 **첫 탐지부터** ID가 보인다. 거짓이면 다음
   *   프레임에서 한 번 더 맞아야 한다 - 한 프레임만 나타난 오탐을 거르려는 것이다.
   */
  activate(nextId: () => number, frameId: number, confirmImmediately = false): void {
    this.trackId = nextId();
    const [x, y, w, h] = this.firstObs;
    this.kalman = initiate(x, y, w, h);
    this.trackletLen = 0;
    this.state = TrackState.Tracked;
    // **첫 프레임에서만 바로 확정한다.** 그 뒤에 나타난 것은 한 번 더 맞아야 한다 -
    // 한 프레임만 나타난 오탐에 ID를 주지 않으려는 것이다.
    // 프레임이 느려 그 한 번을 못 맞추는 경우를 위해 옵션으로 열어둔다
    if (frameId === 1 || confirmImmediately) this.isActivated = true;
    this.frameId = frameId;
    this.startFrame = frameId;
  }

  /**
   * 놓쳤던 트랙을 다시 붙인다. **ID는 유지한다.**
   *
   * **칼만에 신뢰도를 안 넘긴다.** 넘기면 NSA-Kalman이 켜져 관측 잡음이 신뢰도에 따라
   * 달라지는데, 참조 구현(BoT-SORT)은 이 기능을 갖고만 있고 쓰지 않는다. 넘겼더니
   * 예측 위치가 미세하게 밀리고 그것이 IoU를 통해 **연관 결과를 바꿨다.**
   */
  reactivate(fresh: Track, frameId: number): void {
    const [x, y, w, h] = fresh.xywh;
    if (this.kalman) this.kalman = correct(this.kalman, [x, y, w, h]);
    this.trackletLen = 0;
    this.state = TrackState.Tracked;
    this.isActivated = true;
    this.frameId = frameId;
    this.score = fresh.score;
    this.cls = fresh.cls;
    this.idx = fresh.idx;
  }

  /** 짝지어진 탐지로 갱신한다. 신뢰도를 칼만에 안 넘기는 이유는 `reactivate` 참고. */
  update(fresh: Track, frameId: number): void {
    this.frameId = frameId;
    this.trackletLen += 1;
    const [x, y, w, h] = fresh.xywh;
    if (this.kalman) this.kalman = correct(this.kalman, [x, y, w, h]);
    this.state = TrackState.Tracked;
    this.isActivated = true;
    this.score = fresh.score;
    this.cls = fresh.cls;
    this.idx = fresh.idx;
  }

  markLost(): void {
    this.state = TrackState.Lost;
  }

  markRemoved(): void {
    this.state = TrackState.Removed;
  }
}

/**
 * 카메라가 움직인 만큼 트랙을 이동시킨다.
 *
 * `H`는 이전 프레임에서 현재 프레임으로 가는 2×3 아핀이다. 회전·축척 부분은 네 쌍의
 * `(x, y)`에 모두 걸고, 평행이동은 **위치에만** 건다 - 속도는 옮기는 것이 아니라
 * 돌리기만 해야 한다.
 *
 * 이걸 안 하면 카메라가 흔들릴 때 트랙이 제자리에 남아 ID가 끊긴다. 실제로 흔들림을
 * 근거는 `core/gmc.ts` 의 파일 설명에 있다.
 */
export function applyGmc(tracks: readonly Track[], H: readonly number[]): void {
  if (tracks.length === 0) return;
  const [a, b, tx, c, d, ty] = H;

  for (const t of tracks) {
    if (!t.kalman) continue;
    const m = t.kalman.mean;
    const newMean = new Float64Array(8);
    for (let k = 0; k < 4; k++) {
      const p = m[k * 2];
      const q = m[k * 2 + 1];
      newMean[k * 2] = a * p + b * q;
      newMean[k * 2 + 1] = c * p + d * q;
    }
    newMean[0] += tx;
    newMean[1] += ty;

    // cov = R @ cov @ Rᵀ. R은 2×2를 네 번 대각으로 쌓은 것이라 블록으로 돈다
    const cov = t.kalman.cov;
    const tmp = new Float64Array(64);
    for (let k = 0; k < 4; k++) {
      for (let j = 0; j < 8; j++) {
        const p = cov[k * 2 * 8 + j];
        const q = cov[(k * 2 + 1) * 8 + j];
        tmp[k * 2 * 8 + j] = a * p + b * q;
        tmp[(k * 2 + 1) * 8 + j] = c * p + d * q;
      }
    }
    const newCov = new Float64Array(64);
    for (let i = 0; i < 8; i++) {
      for (let k = 0; k < 4; k++) {
        const p = tmp[i * 8 + k * 2];
        const q = tmp[i * 8 + k * 2 + 1];
        newCov[i * 8 + k * 2] = a * p + b * q;
        newCov[i * 8 + k * 2 + 1] = c * p + d * q;
      }
    }
    t.kalman = { mean: newMean, cov: newCov };
  }
}
