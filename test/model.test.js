/**
 * 진짜 `.onnx` 파일에서 클래스 맵이 읽히는가.
 *
 * `classmap.ts`의 protobuf 리더는 **손으로 짠 것**이다. 문자열 파서만 테스트하면
 * 리더가 틀려도 안 걸린다 - 실제 파일로 한 번은 봐야 한다.
 *
 * 모델은 이 저장소에 없다(3.5MB). 저장소 최상위에 `model.onnx` 를 두면 돌고,
 * 없으면 건너뛴다. 다른 곳에 있으면 `NRH_MODEL` 로 알려준다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readClassMap, readMetadata, readInputSize } from '../dist/core/classmap.js';

/**
 * **모델은 이 저장소에 없다.** 저장소 최상위에 `model.onnx`를 두면 이 테스트가 돈다.
 * 다른 곳에 있으면 `NRH_MODEL`로 알려준다.
 *
 * 경로를 코드에 적어 두면 만든 사람 PC의 구조가 공개 저장소에 그대로 남고, 폴더
 * 이름만 바꿔도 테스트가 조용히 건너뛰어진다.
 */
const DEFAULT_MODEL = fileURLToPath(new URL('../model.onnx', import.meta.url));
const modelPath = process.env.NRH_MODEL ?? DEFAULT_MODEL;
const exists = existsSync(modelPath);

test('진짜 모델에서 클래스 24개를 읽는다', { skip: exists ? false : '모델 파일이 없다' }, () => {
  const bytes = new Uint8Array(readFileSync(modelPath));
  const map = readClassMap(bytes);

  assert.equal(map.size, 24);
  assert.equal(map.get(0), 'micromobility');
  assert.equal(map.get(7), 'person');
  assert.equal(map.get(23), 'tree_trunk');
  // 공백이 든 이름 - 받는 쪽이 이름을 키로 쓰려 할 때 걸리는 지점이다
  assert.equal(map.get(14), 'fire hydrant');
  assert.equal(map.get(17), 'potted plant');
  assert.equal(map.get(21), 'traffic light');
});

test('메타데이터에 names가 실제로 있다', { skip: exists ? false : '모델 파일이 없다' }, () => {
  const bytes = new Uint8Array(readFileSync(modelPath));
  const meta = readMetadata(bytes);
  assert.ok(meta.has('names'));
  assert.ok(meta.has('imgsz'), '입력 크기도 여기 있다');
  assert.equal(meta.get('imgsz'), '[640, 640]');
});

test('입력 크기를 모델에서 읽는다', { skip: exists ? false : '모델 파일이 없다' }, () => {
  // **640을 코드에 고정해 두면 안 된다.** 480으로 재학습한 모델을 넣었을 때 640으로
  // 레터박스해서 보내면 ORT가 모양이 안 맞는다고 오류를 낸다
  const bytes = new Uint8Array(readFileSync(modelPath));
  assert.equal(readInputSize(bytes), 640);
});

test('그래프 shape이 imgsz보다 우선한다', { skip: exists ? false : '모델 파일이 없다' }, () => {
  // 그래프에 적힌 것이 모델이 실제로 받는 크기라 더 믿을 만하다.
  // imgsz는 export할 때 적힌 값이라 어긋날 수 있다
  const bytes = new Uint8Array(readFileSync(modelPath));
  assert.equal(readInputSize(bytes, [1, 3, 480, 480]), 480, '그래프를 먼저 본다');
  assert.equal(readInputSize(bytes, [1, 3, 'h', 'w']), 640, '동적 축이면 imgsz로');
  assert.equal(readInputSize(bytes, undefined), 640, 'shape이 없으면 imgsz로');
});

test('정사각이 아니면 조용히 넘어가지 않는다', () => {
  // 레터박스가 정사각을 전제로 짜여 있다. 넘기면 좌표가 어긋난 채로 돈다
  assert.throws(() => readInputSize(new Uint8Array(0), [1, 3, 480, 640]));
});

test('아무것도 없으면 640으로 본다', () => {
  // 메타데이터가 없는 모델도 열 수 있어야 한다. 대부분 640으로 학습한다
  assert.equal(readInputSize(new Uint8Array(0)), 640);
  assert.equal(readInputSize(new Uint8Array(0), undefined, 480), 480);
});
