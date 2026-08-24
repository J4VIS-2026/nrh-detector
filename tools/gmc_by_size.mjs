/**
 * **개발용이다 - 재료가 저장소 밖에 있어 받은 그대로는 안 돈다.**
 *
 * **작은 물체가 왜 안 따라붙나** - 보정이 모자란 건가, 프레임이 드물어 겹침이 없는 건가.
 *
 * 손에 든 폰으로 걸으면서 쓰니 초당 3~4장이 나왔고 작은 물체 추적이 무너졌다. 두 가지가
 * 동시에 의심됐다.
 *
 * 그래서 **물체 크기별로 나눠 잰다.** 크기를 가로질러 같은 방향이면 프레임 간격 문제이고,
 * 작은 것만 무너지면 겹침 문제다. 보정을 켜고 꺼서 보면 보정 몫도 갈린다.
 *
 * **프레임 간 이동량과 물체 크기를 같이 본다.** 물체가 자기 폭보다 많이 움직이면 IoU가
 * 0이라 어떤 보정을 해도 1단계 짝짓기가 안 된다 - 그때는 보정이 문제가 아니다.
 *
 *     node tools/gmc_by_size.mjs out/verify-0.9.0/artifacts/real-gmc-s15
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Gmc } from '../dist/core/gmc.js';
import { Tracker } from '../dist/core/tracker.js';

const inputsDir = process.argv[2];
const ref2 = JSON.parse(readFileSync(join(inputsDir, 'reference.json'), 'utf-8'));
const blob = new Uint8Array(readFileSync(join(inputsDir, 'frames-gray.bin')));
const { smallWidth: W, smallHeight: H, downscale: S, count: N } = ref2;
const oneFrame = W * H;
const frames = [];
for (let i = 0; i < N; i++) frames.push(blob.subarray(i * oneFrame, (i + 1) * oneFrame));

const fps = 58.76 / (ref2.stride ?? 1);
const srcWidth = ref2.frameWidth;
const srcHeight = ref2.frameHeight;

/** 박스 한 변의 대표 길이(픽셀). 원본 해상도 기준. */
const side = (d) => Math.sqrt((d.x2 - d.x1) * (d.y2 - d.y1));

/** 크기 구간. 원본 1080×1920에서의 픽셀이다. */
const bucket = [
  { name: '아주 작음 (<40px)', bottom: 0, top: 40 },
  { name: '작음 (40~80px)', bottom: 40, top: 80 },
  { name: '보통 (80~160px)', bottom: 80, top: 160 },
  { name: '큼 (160px~)', bottom: 160, top: Infinity },
];

function bucketOf(d) {
  const s = side(d);
  return bucket.findIndex((g) => s >= g.bottom && s < g.top);
}

function tracked(useGmc) {
  const g = new Gmc({ downscale: S });
  const T = new Tracker({}, useGmc ? (f) => g.applySmall(f, W, H, S) : undefined);

  // 구간마다 (ID 붙은 탐지, 전체 탐지, 트랙 id 집합)
  const stats = bucket.map(() => ({ hit: 0, total: 0, trackIds: new Set() }));

  for (let i = 0; i < N; i++) {
    const input = ref2.detections[i].map((d) => ({ ...d, track_id: null }));
    const r = T.update({ settings: {}, detections: input }, frames[i]);
    for (const d of r.detections) {
      const k = bucketOf(d);
      if (k < 0) continue;
      stats[k].total++;
      if (d.track_id === null) continue;
      stats[k].hit++;
      stats[k].trackIds.add(d.track_id);
    }
  }
  return stats;
}

// ── 물체가 자기 폭보다 많이 움직이나 ─────────────────────────────────────────
// 파이썬이 잰 카메라 이동량(원본 픽셀)과 물체 크기를 견준다
const shift = ref2.warps.slice(1).map((w) => Math.hypot(w[2], w[5]));
shift.sort((a, b) => a - b);
const medShift = shift[shift.length >> 1];

console.log(
  `${ref2.video}, ${N}프레임, ${ref2.stride ?? 1}프레임마다 (초당 ${fps.toFixed(1)}장)` +
    `  원본 ${srcWidth}x${srcHeight}`,
);
console.log(`카메라가 프레임 사이에 움직인 양: 중앙값 ${medShift.toFixed(0)}px, 최대 ${shift[shift.length - 1].toFixed(0)}px\n`);

const off = tracked(false);
const on = tracked(true);

console.log('크기 구간              탐지수   ID붙은비율(끔→켬)      트랙수(끔→켬)   카메라이동/물체크기');
for (let k = 0; k < bucket.length; k++) {
  const a = off[k];
  const b = on[k];
  if (a.total === 0) continue;
  const typicalSize = (bucket[k].bottom + Math.min(bucket[k].top, 300)) / 2;
  const ratio = medShift / typicalSize;
  const p = (x) => ((x.hit / Math.max(1, x.total)) * 100).toFixed(1).padStart(5);
  console.log(
    `${bucket[k].name.padEnd(20)} ${String(a.total).padStart(6)}   ` +
      `${p(a)}% → ${p(b)}%   ` +
      `${String(a.trackIds.size).padStart(6)} → ${String(b.trackIds.size).padStart(4)}   ` +
      `${ratio.toFixed(2)}배`,
  );
}

console.log('\n※ 카메라이동/물체크기가 1을 넘으면 물체가 자기 폭보다 많이 움직였다는 뜻이다.');
console.log('   그러면 IoU가 0이라 보정을 아무리 잘해도 1단계 짝짓기가 안 된다.');
