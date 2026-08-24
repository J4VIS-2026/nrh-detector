/**
 * 추적이 기준값과 같은 ID를 붙이는가.
 *
 * **GMC를 끄고 견준다.** 카메라 움직임 보정은 opencv가 하는데 대상마다 구현이 달라서,
 * 켜면 추적 알고리즘이 틀린 것인지 보정이 다른 것인지 못 가린다. 보정은 위에 얹는
 * 층이라 따로 확인한다.
 *
 * 입력은 **기준 구현이 낸 탐지 그대로**다. 탐지가 갈리면 추적도 따라 갈리므로 그 변수를
 * 뺀다 - 이 테스트는 오직 추적만 본다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Tracker } from '../dist/core/tracker.js';
import { linearAssignment, iouDistance } from '../dist/core/assign.js';

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(readFileSync(join(here, 'fixtures', 'reference.json'), 'utf-8'));

/** 탐지 목록을 최소한의 탐지결과 모양으로 감싼다. */
function toResult(input) {
  return {
    speed: { preprocess: 0, inference: 0, postprocess: 0 },
    settings: {
      conf: 0.25, iou: 0.7, resize: 'reference', providers: [],
      model: null, model_file: '', track: false,
    },
    image: { width: 1920, height: 1080, received_at: 0, stream: null },
    detections: input.map((d) => ({
      class_id: d.classId, class_name: `c${d.classId}`, confidence: d.score,
      x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2,
      width: d.x2 - d.x1, height: d.y2 - d.y1, track_id: null,
    })),
  };
}

const exists = ref.tracking !== null && ref.tracking !== undefined;

test('추적이 기준값과 같은 ID를 붙인다', { skip: exists ? false : '기준 데이터가 없다' }, () => {
  const T = new Tracker();
  const got = [];
  for (const f of ref.tracking.frames) {
    const r = T.update(toResult(f.input));
    got.push(r.detections.map((d) => d.track_id));
  }

  const want = ref.tracking.frames.map((f) => f.track_ids);
  assert.equal(got.length, want.length, '프레임 수');

  // **ID 번호까지 같아야 한다.** 번호가 달라도 분할만 같으면 "맞다"고 볼 수도 있지만,
  // 그렇게 느슨하게 보면 새 트랙을 세는 순서가 뒤집혀도 안 걸린다
  let otherFrame = 0;
  const example = [];
  for (let i = 0; i < want.length; i++) {
    if (JSON.stringify(got[i]) !== JSON.stringify(want[i])) {
      otherFrame++;
      if (example.length < 3) example.push(`${i}: PY ${JSON.stringify(want[i])} JS ${JSON.stringify(got[i])}`);
    }
  }
  assert.equal(otherFrame, 0, `${otherFrame}/${want.length}프레임이 다르다\n  ${example.join('\n  ')}`);
});

test('트랙 수와 평균 길이가 기준값과 같다', { skip: exists ? false : '기준 데이터가 없다' }, () => {
  const T = new Tracker();
  const len = new Map();
  let idCount = 0;
  for (const f of ref.tracking.frames) {
    for (const d of T.update(toResult(f.input)).detections) {
      if (d.track_id === null) continue;
      idCount++;
      len.set(d.track_id, (len.get(d.track_id) ?? 0) + 1);
    }
  }
  const wantIdCount = ref.tracking.frames.reduce(
    (s, f) => s + f.track_ids.filter((t) => t !== null).length, 0);
  const wantTracks = new Set(
    ref.tracking.frames.flatMap((f) => f.track_ids).filter((t) => t !== null)).size;

  assert.equal(idCount, wantIdCount, 'ID 붙은 탐지 수');
  assert.equal(len.size, wantTracks, '트랙 수');
});

test('추적을 거치면 settings.track이 참이 된다', () => {
  const T = new Tracker();
  const r = T.update(toResult([{ x1: 10, y1: 10, x2: 50, y2: 50, score: 0.9, classId: 0 }]));
  assert.equal(r.settings.track, true, '이 값은 추적기가 정한다 - 탐지기는 항상 거짓을 낸다');
});

test('reset하면 ID를 처음부터 다시 센다', () => {
  const one = [{ x1: 10, y1: 10, x2: 50, y2: 50, score: 0.9, classId: 0 }];
  const T = new Tracker();
  T.update(toResult(one));
  const firstId = T.update(toResult(one)).detections[0].track_id;
  T.reset();
  T.update(toResult(one));
  assert.equal(T.update(toResult(one)).detections[0].track_id, firstId);
});

test('빈 프레임에서 죽지 않는다', () => {
  // munkres 패키지가 빈 행렬에서 예외를 냈다. 직접 짠 이유 중 하나다
  const T = new Tracker();
  assert.doesNotThrow(() => T.update(toResult([])));
  assert.equal(linearAssignment(new Float64Array(0), 0, 0, 0.8).pairs.length, 0);
  assert.equal(iouDistance([], []).length, 0);
});

test('선형배정이 그리디보다 총비용이 낮은 답을 찾는다', () => {
  // 그리디면 0행이 0열(0.10)을 집고 1행은 1열(0.90)밖에 없어 합 1.00이 된다.
  // 최적은 0-1(0.20) + 1-0(0.30) = 0.50이다
  const cost = Float64Array.from([0.1, 0.2, 0.3, 0.9]);
  const r = linearAssignment(cost, 2, 2, 1.0);
  const sum = r.pairs.reduce((s, [i, j]) => s + cost[i * 2 + j], 0);
  assert.equal(r.pairs.length, 2);
  assert.ok(sum < 0.6, `총비용 ${sum} - 그리디에 빠졌다`);
});
