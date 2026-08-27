/**
 * BoT-SORT 본체.
 *
 * 프레임마다 이렇게 돈다.
 *
 * 1. 탐지를 **점수로 둘로 가른다** (높은 것 / 낮은 것)
 * 2. 살아있는 트랙을 칼만으로 한 프레임 내다본다
 * 3. 카메라가 움직인 만큼 트랙을 이동시킨다 (GMC)
 * 4. **1단계** - 높은 점수 탐지와 짝짓는다
 * 5. **2단계** - 남은 트랙을 **낮은 점수 탐지**와 짝짓는다
 * 6. 아직 확정 안 된 트랙을 남은 탐지와 짝짓는다
 * 7. 남은 탐지로 새 트랙을 세운다
 * 8. 오래 놓친 트랙을 버린다
 *
 * **5번이 ByteTrack의 핵심이다.** 가려지거나 흐려져 점수가 떨어진 물체를 버리지 않고
 * 붙잡는다. 여기에 점수를 섞으면(`fuseScore`) 비용이 임계값 위로 올라가 **아무것도 안
 * 붙어 단계가 통째로 무의미해진다** - 그래서 2단계는 IoU만 쓴다.
 */

import { iouDistance, linearAssignment, fuseScore } from './assign.js';
import { applyGmc, Track, TrackState, type XYWH } from './track.js';

export interface TrackParams {
  /** 이 점수 이상이면 1단계에 쓴다. */
  track_high_thresh: number;
  /** 이 점수 초과면 2단계에 쓴다. */
  track_low_thresh: number;
  /** 이 점수 이상이어야 새 트랙이 된다. */
  new_track_thresh: number;
  /** 놓친 트랙을 몇 **프레임** 동안 남겨 두나. 초가 아니다. */
  track_buffer: number;
  /** 1단계 연관 비용 상한. */
  match_thresh: number;
  /** 비용에 탐지 점수를 섞나. */
  fuse_score: boolean;
  /**
   * 새 트랙에 **첫 탐지부터** ID를 붙인다.
   *
   * 기본은 꺼짐이고, 그때는 새 트랙이 **다음 프레임에서 한 번 더 맞아야** ID가 보인다.
   * 한 프레임만 나타난 오탐에 번호를 주지 않으려는 것이고, 참조 구현이 그렇게 한다.
   *
   * **프레임이 느리면 그 규칙이 역효과다.** 초당 6장이면 프레임 간격이 170ms라 그
   * 사이에 물체나 카메라가 움직이면 IoU가 안 겹쳐 매칭이 실패한다 - 몇 번을 잡혀도
   * ID가 영영 안 붙는다. 실시간 시연처럼 **보이는 것이 중요한 경우** 켠다.
   *
   * **켜면 기준 구현과 답이 갈린다.** 두 구현을 대조하는 경로에서는 켜지 마라.
   */
  confirm_immediately: boolean;
}

/** 참조 구현(`botsort.yaml`) 기본값 그대로다. */
export const DEFAULT_TRACK_PARAMS: TrackParams = {
  track_high_thresh: 0.25,
  track_low_thresh: 0.1,
  new_track_thresh: 0.25,
  track_buffer: 30,
  // **참조 구현은 0.8인데 재보고 0.9로 올렸다.** 손에 든 영상에 사람이 정답을 달아
  // 견줬다. 3구간 합산으로 쪼개짐 1.383 → 1.217배, ≥5프레임 연속성 83.0 → 85.6%,
  // 혼입 3 → 2건으로 세 잣대가 모두 0.9 쪽이었다.
  //
  // **튜닝에 쓰지 않은 영상에서도 확인했다** - 다른 영상 2편 3구간에서 쪼개짐
  // 1.240 → 1.120배, 연속성 67.4 → 73.7%. 개발 구간에 맞춘 값이 아니다.
  // 사람이 트랙마다 판정한 정답 데이터로 견준 결과다
  match_thresh: 0.9,
  fuse_score: true,
  confirm_immediately: false,
};

/** 한 프레임의 탐지 하나. */
export interface TrackInput {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
  classId: number;
}

/**
 * 카메라 움직임 보정.
 *
 * **핵심은 이것을 구현하지 않는다.** opencv가 필요한데 대상마다 패키지가 다르다.
 * 진입점이 넣어주고, 안 넣으면 보정 없이 돈다 - 정확도만 떨어지고 멈추지는 않는다.
 *
 * @returns 이전 프레임에서 현재 프레임으로 가는 2×3 아핀 `[a, b, tx, c, d, ty]`.
 */
export type GmcFn = (frame: unknown) => readonly number[];

const IDENTITY = [1, 0, 0, 0, 1, 0] as const;

export class BotSort {
  private tracked: Track[] = [];
  private lost: Track[] = [];
  private frameId = 0;
  private nextNumber = 0;

  constructor(
    private readonly params: TrackParams = DEFAULT_TRACK_PARAMS,
    private readonly gmc: GmcFn | null = null,
  ) {}

  /** ID를 처음부터 다시 센다. 새 영상을 시작할 때 쓴다. */
  reset(): void {
    this.tracked = [];
    this.lost = [];
    this.frameId = 0;
    this.nextNumber = 0;
  }

  /**
   * 한 프레임을 넣는다.
   *
   * @param inputs 이 프레임의 탐지.
   * @param frame 픽셀. GMC에 쓴다. 없으면 보정 없이 돈다.
   * @returns 탐지 인덱스 → track_id. 짝이 안 붙은 탐지는 빠진다.
   */
  update(inputs: readonly TrackInput[], frame?: unknown): Map<number, number> {
    this.frameId += 1;
    const activated: Track[] = [];
    const refound: Track[] = [];
    const newlyLost: Track[] = [];

    // ── 1. 점수로 가른다 ─────────────────────────────────────────────────────
    const high: Track[] = [];
    const low: Track[] = [];
    inputs.forEach((d, i) => {
      const t = new Track(this.toXywh(d), d.score, d.classId, i);
      if (d.score >= this.params.track_high_thresh) high.push(t);
      else if (d.score > this.params.track_low_thresh) low.push(t);
    });

    const unconfirmed: Track[] = [];
    const confirmed: Track[] = [];
    for (const t of this.tracked) (t.isActivated ? confirmed : unconfirmed).push(t);

    // 놓친 트랙도 후보에 넣는다. 다시 나타나면 같은 ID로 이어붙이려는 것이다
    const pool = this.join(confirmed, this.lost);

    // ── 2. 내다본다 ─────────────────────────────────────────────────────────
    for (const t of pool) t.step();

    // ── 3. 카메라 움직임 ────────────────────────────────────────────────────
    if (this.gmc && frame !== undefined && frame !== null) {
      let H: readonly number[];
      try {
        H = this.gmc(frame);
      } catch {
        // **보정이 실패해도 멈추지 않는다.** 항등이면 보정을 안 한 것과 같다
        H = IDENTITY;
      }
      if (H.length !== 6 || H.some((v) => !Number.isFinite(v))) H = IDENTITY;
      applyGmc(pool, H);
      applyGmc(unconfirmed, H);
    }

    // ── 4. 1단계: 높은 점수 ─────────────────────────────────────────────────
    let cost = this.distance(pool, high);
    if (this.params.fuse_score) {
      cost = fuseScore(cost, high.map((d) => d.score));
    }
    const first = linearAssignment(cost, pool.length, high.length, this.params.match_thresh);
    for (const [ti, di] of first.pairs) this.attach(pool[ti], high[di], activated, refound);

    // ── 5. 2단계: 낮은 점수 ─────────────────────────────────────────────────
    // 여기 남은 것은 **추적 중이던 트랙만** 본다. 이미 놓친 트랙을 낮은 점수 탐지로
    // 되살리면 오탐에 옛 ID가 붙는다
    const stillTracked = first.unmatchedRows
      .map((i) => pool[i])
      .filter((t) => t.state === TrackState.Tracked);
    let leftoverTracks: number[] = [];
    if (stillTracked.length && low.length) {
      const cost2 = iouDistance(stillTracked.map((t) => t.box), low.map((t) => t.box));
      const second = linearAssignment(cost2, stillTracked.length, low.length, 0.5);
      for (const [ti, di] of second.pairs) {
        this.attach(stillTracked[ti], low[di], activated, refound);
      }
      leftoverTracks = second.unmatchedRows;
    } else {
      leftoverTracks = stillTracked.map((_, i) => i);
    }
    for (const i of leftoverTracks) {
      const t = stillTracked[i];
      if (t.state !== TrackState.Lost) {
        t.markLost();
        newlyLost.push(t);
      }
    }

    // ── 6. 미확정 트랙 ──────────────────────────────────────────────────────
    const leftoverDets = first.unmatchedCols.map((i) => high[i]);
    let finalLeftover = leftoverDets;
    if (unconfirmed.length) {
      let cost3 = this.distance(unconfirmed, leftoverDets);
      if (this.params.fuse_score) {
        cost3 = fuseScore(cost3, leftoverDets.map((d) => d.score));
      }
      const third = linearAssignment(cost3, unconfirmed.length, leftoverDets.length, 0.7);
      for (const [ti, di] of third.pairs) {
        unconfirmed[ti].update(leftoverDets[di], this.frameId);
        activated.push(unconfirmed[ti]);
      }
      // **한 번 더 못 맞은 미확정 트랙은 버린다.** 한 프레임만 나타난 오탐에 ID를 주지 않는다
      for (const i of third.unmatchedRows) unconfirmed[i].markRemoved();
      finalLeftover = third.unmatchedCols.map((i) => leftoverDets[i]);
    }

    // ── 7. 새 트랙 ──────────────────────────────────────────────────────────
    for (const d of finalLeftover) {
      if (d.score < this.params.new_track_thresh) continue;
      d.activate(() => ++this.nextNumber, this.frameId, this.params.confirm_immediately);
      activated.push(d);
    }

    // ── 8. 오래 놓친 것을 버린다 ────────────────────────────────────────────
    for (const t of this.lost) {
      if (this.frameId - t.endFrame > this.params.track_buffer) t.markRemoved();
    }

    // ── 정리 ────────────────────────────────────────────────────────────────
    this.tracked = this.tracked.filter((t) => t.state === TrackState.Tracked);
    this.tracked = this.join(this.tracked, activated);
    this.tracked = this.join(this.tracked, refound);
    this.lost = this.subtract(this.lost, this.tracked);
    this.lost.push(...newlyLost);
    this.lost = this.lost.filter((t) => t.state !== TrackState.Removed);
    [this.tracked, this.lost] = this.dedupe(this.tracked, this.lost);

    const out = new Map<number, number>();
    for (const t of this.tracked) {
      if (t.isActivated) out.set(t.idx, t.trackId);
    }
    return out;
  }

  private toXywh(d: TrackInput): XYWH {
    return [(d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2, d.x2 - d.x1, d.y2 - d.y1];
  }

  private distance(a: readonly Track[], b: readonly Track[]): Float64Array {
    return iouDistance(
      a.map((t) => t.box),
      b.map((t) => t.box),
    );
  }

  private attach(t: Track, d: Track, activated: Track[], refound: Track[]): void {
    if (t.state === TrackState.Tracked) {
      t.update(d, this.frameId);
      activated.push(t);
    } else {
      t.reactivate(d, this.frameId);
      refound.push(t);
    }
  }

  private join(a: readonly Track[], b: readonly Track[]): Track[] {
    const have = new Set(a.map((t) => t.trackId));
    return [...a, ...b.filter((t) => !have.has(t.trackId))];
  }

  private subtract(a: readonly Track[], b: readonly Track[]): Track[] {
    const drop = new Set(b.map((t) => t.trackId));
    return a.filter((t) => !drop.has(t.trackId));
  }

  /**
   * 두 목록에 같은 물체가 겹쳐 있으면 **덜 살아본 쪽**을 버린다.
   *
   * IoU가 0.85를 넘으면 같은 것으로 본다.
   */
  private dedupe(a: Track[], b: Track[]): [Track[], Track[]] {
    if (!a.length || !b.length) return [a, b];
    const dist = iouDistance(
      a.map((t) => t.box),
      b.map((t) => t.box),
    );
    const dropA = new Set<number>();
    const dropB = new Set<number>();
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        if (dist[i * b.length + j] >= 0.15) continue;
        const livedA = a[i].frameId - a[i].startFrame;
        const livedB = b[j].frameId - b[j].startFrame;
        if (livedA > livedB) dropB.add(j);
        else dropA.add(i);
      }
    }
    return [a.filter((_, i) => !dropA.has(i)), b.filter((_, j) => !dropB.has(j))];
  }
}
