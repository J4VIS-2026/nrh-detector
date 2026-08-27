/**
 * **개발용이다 - 재료가 저장소 밖에 있어 받은 그대로는 안 돈다.**
 *
 * **미리 뽑아둔 아핀으로 추적만 돌린다.** 보정 방식이 추적에 얼마나 먹히는지 보려는
 * 것이라, 아핀을 밖에서 뽑아 넣고 나머지는 같게 둔다.
 *
 * `warps-both.json`이 필요하다.
 *
 *     node tools/track_with_warps.mjs out/verify-0.9.0/artifacts/real-gmc-s15
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Tracker } from '../dist/core/tracker.js';

const inputsDir = process.argv[2];
const ref2 = JSON.parse(readFileSync(join(inputsDir, 'reference.json'), 'utf-8'));
const warps = JSON.parse(readFileSync(join(inputsDir, 'warps-both.json'), 'utf-8'));
const N = ref2.count;
const fps = 58.76 / (ref2.stride ?? 1);

const side = (d) => Math.sqrt((d.x2 - d.x1) * (d.y2 - d.y1));
const bucket = [
  { name: '아주 작음 (<40px)', bottom: 0, top: 40 },
  { name: '작음 (40~80px)', bottom: 40, top: 80 },
  { name: '보통 (80~160px)', bottom: 80, top: 160 },
  { name: '큼 (160px~)', bottom: 160, top: Infinity },
];
const bucketOf = (d) => bucket.findIndex((g) => side(d) >= g.bottom && side(d) < g.top);

function tracked(warps) {
  let i = 0;
  const T = new Tracker({}, warps ? () => warps[i] : undefined);
  const stats = bucket.map(() => ({ hit: 0, total: 0, trackIds: new Set() }));
  for (i = 0; i < N; i++) {
    const input = ref2.detections[i].map((d) => ({ ...d, track_id: null }));
    const r = T.update({ settings: {}, detections: input }, warps ? {} : undefined);
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

const off = tracked(null);
const orb = tracked(warps.orb);
const flow = tracked(warps.flow);

console.log(`${ref2.video}, ${N}프레임, 초당 ${fps.toFixed(1)}장\n`);
console.log('크기 구간                탐지수    ID 붙은 비율                    트랙 수');
console.log('                                  보정끔    ORB(앱)  광류(웹)     끔 / ORB / 광류');
for (let k = 0; k < bucket.length; k++) {
  const [a, b, c] = [off[k], orb[k], flow[k]];
  if (a.total === 0) continue;
  const p = (x) => ((x.hit / Math.max(1, x.total)) * 100).toFixed(1).padStart(6);
  console.log(
    `${bucket[k].name.padEnd(22)} ${String(a.total).padStart(5)}   ` +
      `${p(a)}%  ${p(b)}%  ${p(c)}%    ` +
      `${String(a.trackIds.size).padStart(3)} / ${String(b.trackIds.size).padStart(3)} / ${String(c.trackIds.size).padStart(3)}`,
  );
}
