/**
 * 흔들림 보정이 **되돌려야 할 값을 실제로 되돌리는가.**
 *
 * 보정은 조용히 틀리는 쪽이다 - 아핀이 어긋나도 예외가 안 나고 추적 정확도만
 * 떨어진다. 그래서 **정답을 아는 시험지**로 잰다. 진짜 사진을 우리가 정한 아핀으로
 * 비틀어 두 번째 프레임을 만들었으니, 보정이 그 아핀을 찾아내야 한다.
 *
 * 기준 데이터는 `test/fixtures/gmc.json` 과 `gmc-frames.bin` 에 들어 있다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  Gmc,
  goodFeaturesToTrack,
  calcOpticalFlowPyrLK,
  solveSimilarity,
  estimateSimilarityRansac,
  downscaleGray,
  rgbaToGray,
  DEFAULT_GMC_OPTIONS,
} from '../dist/core/gmc.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'gmc.json');
const exists = existsSync(fixturePath);
const stride = exists ? false : '기준 데이터가 없다 - test/fixtures/gmc.json 이 있어야 한다';

function sheet() {
  const j = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  const blob = new Uint8Array(readFileSync(join(here, 'fixtures', 'gmc-frames.bin')));
  const n = j.width * j.height;
  return {
    width: j.width,
    height: j.height,
    first: blob.subarray(0, n),
    cases: j.cases.map((c) => ({ ...c, frame: blob.subarray(c.offset, c.offset + n) })),
  };
}

test('정한 아핀을 되돌린다', { skip: stride }, () => {
  const t = sheet();
  for (const kase of t.cases) {
    // 이미 줄여둔 그림이라 배율은 1이다
    const gmc = new Gmc({ downscale: 1 });
    gmc.applySmall(t.first, t.width, t.height, 1);
    const w = gmc.applySmall(kase.frame, t.width, t.height, 1);

    const truth = kase.truth;
    // 평행이동은 픽셀이라 절대값으로 본다. 0.5px 안이면 보정으로 쓸 만하다
    assert.ok(
      Math.abs(w[2] - truth[2]) < 0.5,
      `${kase.name}: tx ${w[2].toFixed(3)} 인데 정답은 ${truth[2].toFixed(3)}`,
    );
    assert.ok(
      Math.abs(w[5] - truth[5]) < 0.5,
      `${kase.name}: ty ${w[5].toFixed(3)} 인데 정답은 ${truth[5].toFixed(3)}`,
    );
    // 회전·축척은 무차원이라 작게 잡는다. 320px 폭에서 0.005면 가장자리가 1.6px 움직인다
    assert.ok(Math.abs(w[0] - truth[0]) < 0.005, `${kase.name}: a ${w[0]} 인데 정답은 ${truth[0]}`);
    assert.ok(Math.abs(w[1] - truth[1]) < 0.005, `${kase.name}: b ${w[1]} 인데 정답은 ${truth[1]}`);
  }
});

test('opencv 와 크게 벌어지지 않는다', { skip: stride }, () => {
  // **직접 푼 것이라 맞춰 볼 상대가 필요하다.** 값이 똑같을 수는 없다 - 코너를 고르는
  // 방식도 광류도 opencv와 구현이 다르다. 벌어지는 폭만 잰다
  const t = sheet();
  for (const kase of t.cases) {
    const gmc = new Gmc({ downscale: 1 });
    gmc.applySmall(t.first, t.width, t.height, 1);
    const w = gmc.applySmall(kase.frame, t.width, t.height, 1);
    const p = kase.opencv;
    assert.ok(Math.abs(w[2] - p[2]) < 0.5, `${kase.name}: tx ${w[2]} 대 기준값 ${p[2]}`);
    assert.ok(Math.abs(w[5] - p[5]) < 0.5, `${kase.name}: ty ${w[5]} 대 기준값 ${p[5]}`);
  }
});

test('같은 프레임을 두 번 주면 항등이다', { skip: stride }, () => {
  // 안 움직였는데 움직였다고 하면 추적기가 멀쩡한 트랙을 흔든다
  const t = sheet();
  const gmc = new Gmc({ downscale: 1 });
  gmc.applySmall(t.first, t.width, t.height, 1);
  const w = gmc.applySmall(t.first, t.width, t.height, 1);
  assert.ok(Math.abs(w[0] - 1) < 1e-3, `a=${w[0]}`);
  assert.ok(Math.abs(w[1]) < 1e-3, `b=${w[1]}`);
  assert.ok(Math.abs(w[2]) < 0.05, `tx=${w[2]}`);
  assert.ok(Math.abs(w[5]) < 0.05, `ty=${w[5]}`);
});

test('첫 프레임은 항등이다', { skip: stride }, () => {
  const t = sheet();
  const gmc = new Gmc();
  assert.deepEqual(gmc.applySmall(t.first, t.width, t.height, 1), [1, 0, 0, 0, 1, 0]);
});

test('reset하면 다시 첫 프레임이 된다', { skip: stride }, () => {
  const t = sheet();
  const gmc = new Gmc({ downscale: 1 });
  gmc.applySmall(t.first, t.width, t.height, 1);
  gmc.reset();
  // reset을 안 했으면 여기서 평행이동이 잡힌다
  assert.deepEqual(gmc.applySmall(t.cases[0].frame, t.width, t.height, 1), [1, 0, 0, 0, 1, 0]);
});

test('배율을 주면 평행이동만 되돌린다', { skip: stride }, () => {
  // 회전·축척은 배율과 무관하다. 여기까지 곱하면 화면이 뒤틀린다
  const t = sheet();
  const one = new Gmc({ downscale: 1 });
  one.applySmall(t.first, t.width, t.height, 1);
  const a = one.applySmall(t.cases[2].frame, t.width, t.height, 1);

  const four = new Gmc({ downscale: 1 });
  four.applySmall(t.first, t.width, t.height, 1);
  const b = four.applySmall(t.cases[2].frame, t.width, t.height, 4);

  assert.ok(Math.abs(b[2] - a[2] * 4) < 1e-9);
  assert.ok(Math.abs(b[5] - a[5] * 4) < 1e-9);
  assert.equal(b[0], a[0], '회전·축척은 그대로다');
  assert.equal(b[1], a[1]);
});

test('원본 해상도로 넣어도 같은 값이 나온다', { skip: stride }, () => {
  // `apply`는 안에서 줄인다. 줄여서 넣은 것과 결과가 같아야 두 경로가 한 몸이다
  const t = sheet();
  const inside = new Gmc({ downscale: 2 });
  inside.apply(t.first, t.width, t.height);
  const a = inside.apply(t.cases[0].frame, t.width, t.height);

  const outside = new Gmc({ downscale: 2 });
  const small1 = downscaleGray(t.first, t.width, t.height, 2);
  const small2 = downscaleGray(t.cases[0].frame, t.width, t.height, 2);
  outside.applySmall(small1.gray, small1.width, small1.height, 2);
  const b = outside.applySmall(small2.gray, small2.width, small2.height, 2);

  assert.deepEqual(a, b);
});

test('1/4로 줄여도 정답을 찾는다', { skip: stride }, () => {
  // **기본값이 1/4이다.** 여기서 실패하면 실제로 쓰는 설정이 깨진 것이다
  const t = sheet();
  const kase = t.cases[0];
  const gmc = new Gmc({ downscale: 4 });
  gmc.apply(t.first, t.width, t.height);
  const w = gmc.apply(kase.frame, t.width, t.height);
  // 1/4에서는 한 픽셀이 원본 네 픽셀이라 오차도 네 배로 본다
  assert.ok(Math.abs(w[2] - kase.truth[2]) < 1.5, `tx=${w[2]}`);
  assert.ok(Math.abs(w[5] - kase.truth[5]) < 1.5, `ty=${w[5]}`);
});

test('평평한 그림에서는 항등을 낸다', () => {
  // 코너가 없으면 풀 수 없다. **그때 아무 값이나 내면 추적이 망가진다**
  const flat = new Uint8Array(64 * 64).fill(128);
  const gmc = new Gmc({ downscale: 1 });
  gmc.applySmall(flat, 64, 64, 1);
  assert.deepEqual(gmc.applySmall(flat, 64, 64, 1), [1, 0, 0, 0, 1, 0]);
});

test('코너를 세기순으로 최대 개수까지만 고른다', { skip: stride }, () => {
  const t = sheet();
  const ten = goodFeaturesToTrack(t.first, t.width, t.height, {
    ...DEFAULT_GMC_OPTIONS,
    maxCorners: 10,
  });
  assert.equal(ten.length, 10);
  const many = goodFeaturesToTrack(t.first, t.width, t.height, DEFAULT_GMC_OPTIONS);
  assert.ok(many.length > 100, `코너가 ${many.length}개뿐이다`);
  // 상한을 줄이면 센 것부터 남으므로 앞이 그대로여야 한다
  assert.deepEqual(many.slice(0, 10), ten);
});

test('광류가 옮겨진 점을 따라간다', { skip: stride }, () => {
  const t = sheet();
  const kase = t.cases[0]; // 평행이동 (7, -4)
  const corners = goodFeaturesToTrack(t.first, t.width, t.height, DEFAULT_GMC_OPTIONS);
  const moved = calcOpticalFlowPyrLK(
    t.first,
    kase.frame,
    t.width,
    t.height,
    corners,
    DEFAULT_GMC_OPTIONS,
  );

  let survived = 0;
  let correct = 0;
  for (let i = 0; i < corners.length; i++) {
    const q = moved[i];
    if (q === null) continue;
    survived++;
    if (Math.abs(q.x - corners[i].x - 7) < 1 && Math.abs(q.y - corners[i].y + 4) < 1) correct++;
  }
  assert.ok(survived > corners.length * 0.5, `${corners.length}개 중 ${survived}개만 살았다`);
  // 전부 맞을 수는 없다 - 가장자리로 나간 점, 무늬가 반복되는 곳이 있다
  assert.ok(correct > survived * 0.7, `${survived}개 중 ${correct}개만 맞았다`);
});

test('RANSAC이 이상치를 걸러낸다', () => {
  // **이게 없으면 광류가 한둘만 헛나가도 아핀이 통째로 밀린다**
  const pair = [];
  for (let i = 0; i < 40; i++) {
    const x = (i % 8) * 20 + 5;
    const y = Math.floor(i / 8) * 20 + 5;
    pair.push([x, y, x + 3, y - 2]); // 전부 (3, -2)만큼 움직였다
  }
  // 다섯 개를 엉뚱한 데로 보낸다
  for (let i = 0; i < 5; i++) pair[i * 7] = [pair[i * 7][0], pair[i * 7][1], 300 - i * 30, 5 + i * 40];

  const naive = solveSimilarity(pair);
  const filtered = estimateSimilarityRansac(pair, 200, 3);
  assert.ok(filtered !== null);
  assert.ok(Math.abs(filtered[2] - 3) < 0.1, `tx=${filtered[2]}`);
  assert.ok(Math.abs(filtered[3] + 2) < 0.1, `ty=${filtered[3]}`);
  assert.ok(Math.abs(naive[2] - 3) > 1, '이상치를 안 거르면 밀린다는 것이 이 시험의 전제다');
});

test('RANSAC이 같은 입력에 같은 답을 낸다', () => {
  // `Math.random`을 쓰면 답이 흔들려 이 파일로 못 짚는다
  const pair = [];
  for (let i = 0; i < 30; i++) pair.push([i * 3, i * 2, i * 3 + 1, i * 2 + 1]);
  assert.deepEqual(estimateSimilarityRansac(pair, 200, 3), estimateSimilarityRansac(pair, 200, 3));
});

test('RGBA를 회색으로 바꾼다', () => {
  const rgba = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
  const g = rgbaToGray(rgba, 3, 1);
  assert.equal(g[0], 255);
  assert.equal(g[1], 0);
  // 빨강은 R 가중치만 남는다. 파랑으로 읽히면 여기가 29가 된다
  assert.equal(g[2], 76);
});

test('축소가 블록 평균이다', () => {
  const g = new Uint8Array([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]);
  const r = downscaleGray(g, 4, 4, 2);
  assert.equal(r.width, 2);
  assert.equal(r.height, 2);
  assert.deepEqual([...r.gray], [25, 45, 105, 125]);
});
