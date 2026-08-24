/**
 * 기준값과 같은 답이 나오는가.
 *
 * 기준 데이터는 `test/fixtures/` 에 들어 있다. **이 테스트가 이 모듈의 존재
 * 이유다** - 여기가 통과하지 않으면 나머지가 다 돌아가도 쓸 수 없다.
 *
 * 여기서 잡히는 실패는 전부 **조용한** 것들이다. 반올림 규칙이 다르면 박스가 1px 밀리고,
 * 패딩 계산이 어긋나면 좌표가 통째로 밀린다. 예외는 안 난다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { bankersRound } from '../dist/core/rounding.js';
import { letterbox } from '../dist/core/letterbox.js';
import { postprocess } from '../dist/core/postprocess.js';
import { serializeResult } from '../dist/core/schema.js';
import { parseClassMap } from '../dist/core/classmap.js';

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(readFileSync(join(here, 'fixtures', 'reference.json'), 'utf-8'));

test('반올림이 파이썬 round와 같다', () => {
  for (const { input, want } of ref.rounding) {
    assert.equal(bankersRound(input), want, `round(${input})`);
  }
});

test('Math.round를 썼다면 이 테스트가 잡아낸다', () => {
  // 파이썬 638, JS Math.round 639. 둘이 갈리는 값이 기준에 실제로 들어 있는지 본다 -
  // 안 들어 있으면 위 테스트가 통과해도 아무것도 보장하지 못한다
  const differing = ref.rounding.filter(({ input, want }) => Math.round(input) !== want);
  assert.ok(differing.length >= 4, `갈리는 값이 ${differing.length}개뿐이다`);
});

test('레터박스 스케일과 패딩이 기준값과 같다', () => {
  for (const item of ref.letterbox) {
    const answer = letterbox(item.origWidth, item.origHeight, item.inputSize);
    assert.equal(answer.padX, item.padX, `${item.origWidth}x${item.origHeight} padX`);
    assert.equal(answer.padY, item.padY, `${item.origWidth}x${item.origHeight} padY`);
    assert.ok(
      Math.abs(answer.scale - item.scale) < 1e-12,
      `${item.origWidth}x${item.origHeight} scale ${answer.scale} != ${item.scale}`,
    );
  }
});

test('후처리가 기준값과 같은 탐지를 낸다', () => {
  const p = ref.postprocess;
  const raw = new Float32Array(Buffer.from(p.raw_base64, 'base64').buffer.slice(0));
  const name = new Map(Object.entries(p.classNames).map(([k, v]) => [Number(k), v]));

  for (const kase of p.cases) {
    const value = letterbox(kase.origWidth, kase.origHeight);
    const got = postprocess(raw, p.channels, p.anchors, value, name, p.conf, p.iou);

    const shape = serializeResult({
      speed: { preprocess: 0, inference: 0, postprocess: 0 },
      settings: {
        conf: p.conf, iou: p.iou, resize: 'none', providers: [],
        model: null, model_file: '', track: false,
      },
      image: { width: kase.origWidth, height: kase.origHeight, received_at: 0, stream: null },
      detections: got,
    }).detections;

    const labels = `${kase.origWidth}x${kase.origHeight}`;
    assert.equal(shape.length, kase.detections.length, `${labels} 탐지 개수`);

    // confidence가 같으면 순서가 정해져 있지 않다 (`np.argsort` 가 안정 정렬이 아니다).
    // 그래서 순서가 아니라 **집합**으로 견준다
    const keyOf = (d) =>
      `${d.class_id}|${d.x1},${d.y1},${d.x2},${d.y2}|${d.confidence.toFixed(3)}`;
    const wantSet = new Set(kase.detections.map(keyOf));
    for (const d of shape) {
      assert.ok(wantSet.has(keyOf(d)), `${labels}에 없는 탐지: ${keyOf(d)}`);
    }
  }
});

test('width와 height가 좌표에서 나온다', () => {
  const p = ref.postprocess;
  for (const kase of p.cases) {
    for (const d of kase.detections) {
      assert.equal(d.width, d.x2 - d.x1);
      assert.equal(d.height, d.y2 - d.y1);
    }
  }
});

test('클래스 맵은 JSON이 아니라 파이썬 dict 문자열이다', () => {
  const item = "{0: 'micromobility', 7: 'person', 21: 'traffic light', 23: 'tree_trunk'}";
  assert.throws(() => JSON.parse(item), '이게 JSON이면 직접 파싱할 이유가 없다');

  const map = parseClassMap(item);
  assert.equal(map.get(0), 'micromobility');
  assert.equal(map.get(7), 'person');
  assert.equal(map.get(21), 'traffic light', '공백이 든 이름');
  assert.equal(map.get(23), 'tree_trunk');
  assert.equal(map.size, 4);
});

test('클래스 맵이 깨졌으면 조용히 넘어가지 않는다', () => {
  for (const bad of ['', '[]', '{}', '{0: person}', "{a: 'x'}", "{0 'x'}"]) {
    assert.throws(() => parseClassMap(bad), `통과하면 안 된다: ${bad}`);
  }
});
