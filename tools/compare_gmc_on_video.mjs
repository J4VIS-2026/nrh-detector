/**
 * **개발용이다 - 재료가 저장소 밖에 있어 받은 그대로는 안 돈다.**
 *
 * 진짜 손에 든 영상에서 흔들림 보정을 검증한다.
 *
 * 재료는 미리 뽑아 둔 프레임과 축소 결과다. **실제 영상에는 정답이 없으므로**
 * 두 가지를 대신 본다.
 *
 * 1. **파이썬 opencv와 얼마나 벌어지나.** 두 구현이 똑같은 픽셀을 본다 - 축소는
 *    파이썬이 하고 그 결과를 넘겨받으므로 축소 방식 차이가 안 섞인다.
 * 2. **보정이 실제로 일을 하나.** 같은 탐지를 넣고 보정을 켰을 때와 껐을 때 트랙이
 *    얼마나 쪼개지는지 센다. 1번이 아무리 맞아도 이게 안 나오면 소용없다.
 *
 *     node tools/compare_gmc_on_video.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Gmc } from '../dist/core/gmc.js';
import { Tracker } from '../dist/core/tracker.js';

const here = dirname(fileURLToPath(import.meta.url));
// 재료 폴더는 인자로 바꿀 수 있다 - 건너뛰기를 다르게 뽑은 것끼리 견주려면 필요하다
const inputsDir = process.argv[2] ?? join(here, '..', 'out', 'verify-0.9.0', 'artifacts', 'real-gmc');

const ref2 = JSON.parse(readFileSync(join(inputsDir, 'reference.json'), 'utf-8'));
const blob = new Uint8Array(readFileSync(join(inputsDir, 'frames-gray.bin')));
const { smallWidth: W, smallHeight: H, downscale: S, count: N } = ref2;
const oneFrame = W * H;

const frames = [];
for (let i = 0; i < N; i++) frames.push(blob.subarray(i * oneFrame, (i + 1) * oneFrame));

const fps = 58.76 / (ref2.stride ?? 1);
console.log(
  `${ref2.video} 프레임 ${ref2.start}부터 ${N}장, ${ref2.stride ?? 1}프레임마다 한 장` +
    ` (초당 ${fps.toFixed(1)}장). 작은 그림 ${W}x${H} (1/${S})\n`,
);

// ── 1. 파이썬 opencv와 얼마나 벌어지나 ────────────────────────────────────────
const gmc = new Gmc({ downscale: S });
const ours = [];
const start = performance.now();
for (const f of frames) ours.push(gmc.applySmall(f, W, H, S));
const perFrame = (performance.now() - start) / N;

const shiftDiff = [];
const rotDiff = [];
let identityCount = 0;
for (let i = 1; i < N; i++) {
  const a = ours[i];
  const b = ref2.warps[i];
  shiftDiff.push(Math.hypot(a[2] - b[2], a[5] - b[5]));
  rotDiff.push(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]));
  if (a[0] === 1 && a[1] === 0 && a[2] === 0 && a[5] === 0) identityCount++;
}

const stats = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  return {
    median: s[s.length >> 1],
    mean: s.reduce((p, c) => p + c, 0) / s.length,
    max: s[s.length - 1],
    p95: s[Math.floor(s.length * 0.95)],
  };
};

const pyShift = ref2.warps.slice(1).map((w) => Math.hypot(w[2], w[5]));
const t = stats(shiftDiff);
const r = stats(rotDiff);
const m = stats(pyShift);

console.log('── 파이썬 opencv와의 차이 ──');
console.log(`파이썬이 잰 실제 흔들림: 중앙값 ${m.median.toFixed(1)}px, 최대 ${m.max.toFixed(1)}px`);
console.log(`평행이동 차이: 중앙값 ${t.median.toFixed(2)}px, 평균 ${t.mean.toFixed(2)}, p95 ${t.p95.toFixed(2)}, 최대 ${t.max.toFixed(2)}`);
console.log(`회전+축척 차이: 중앙값 ${r.median.toFixed(5)}, 최대 ${r.max.toFixed(5)}`);
console.log(`흔들림 대비 차이: ${((t.median / m.median) * 100).toFixed(1)}%`);
console.log(`보정을 포기한 프레임(항등): ${identityCount}/${N - 1}`);
console.log(`한 프레임 ${perFrame.toFixed(1)}ms\n`);

// ── 2. 보정이 실제로 일을 하나 ────────────────────────────────────────────────
function tracked(useGmc) {
  const g = new Gmc({ downscale: S });
  const T = new Tracker({}, useGmc ? (f) => g.applySmall(f, W, H, S) : undefined);
  const len = new Map();
  let withId2 = 0;
  let total = 0;
  for (let i = 0; i < N; i++) {
    const result = {
      settings: {},
      detections: ref2.detections[i].map((d) => ({ ...d, track_id: null })),
    };
    const out = T.update(result, frames[i]);
    for (const d of out.detections) {
      total++;
      if (d.track_id === null) continue;
      withId2++;
      len.set(d.track_id, (len.get(d.track_id) ?? 0) + 1);
    }
  }
  const longOnes = [...len.values()].filter((v) => v >= 3);
  return {
    trackCount: len.size,
    meanLen: [...len.values()].reduce((p, c) => p + c, 0) / Math.max(1, len.size),
    longTracks: longOnes.length,
    idRate: (withId2 / total) * 100,
  };
}

const off = tracked(false);
const on = tracked(true);

console.log('── 보정이 일을 하나 (같은 탐지, 보정만 켜고 끔) ──');
console.log('                    보정 끔    보정 켬');
console.log(`트랙 개수           ${String(off.trackCount).padStart(7)}    ${String(on.trackCount).padStart(7)}   (적을수록 안 쪼개진 것)`);
console.log(`평균 트랙 길이      ${off.meanLen.toFixed(1).padStart(7)}    ${on.meanLen.toFixed(1).padStart(7)}   (길수록 좋다)`);
console.log(`3프레임 이상 트랙   ${String(off.longTracks).padStart(7)}    ${String(on.longTracks).padStart(7)}`);
console.log(`ID 붙은 탐지 비율   ${off.idRate.toFixed(1).padStart(6)}%    ${on.idRate.toFixed(1).padStart(6)}%`);
console.log(`\n탐지 ${ref2.detections.reduce((p, c) => p + c.length, 0)}개, 프레임 ${N}장`);
