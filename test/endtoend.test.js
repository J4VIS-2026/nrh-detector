/**
 * 기준 구현 대조 1층 - **같은 텐서를 넣어 최종 탐지가 같은가.**
 *
 * 이미지에서 시작하면 안 된다. canvas와 opencv `INTER_AREA`는 원본 픽셀에 주는 가중치가
 * 달라 몇 픽셀이 다르게 나오는데, 그 상태로 견주면 **후처리가 틀린 것인지 리샘플러가
 * 다른 것인지 못 가린다.** 그래서 기준 구현이 만든 캔버스를 그대로 넣는다.
 *
 * **원시 텐서가 아니라 최종 탐지를 견준다.** WASM과 네이티브는 원시 출력의 비트가
 * 63%만 같은데도 최종 탐지는 완전히 일치한다 - 실수 연산 순서가 달라서 생기는 차이가
 * conf 필터와 NMS를 지나면 사라진다. 원시 텐서로 견주면 멀쩡한 구현을 실패로 읽는다.
 *
 * 모델과 `onnxruntime-web`이 있어야 돈다. 없으면 건너뛴다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { letterbox } from '../dist/core/letterbox.js';
import { rgbToTensor } from '../dist/core/tensor.js';
import { detectFromTensor } from '../dist/core/detect.js';
import { readClassMap } from '../dist/core/classmap.js';
import { serializeResult } from '../dist/core/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(readFileSync(join(here, 'fixtures', 'reference.json'), 'utf-8'));

// **모델은 이 저장소에 없다.** 저장소 최상위에 `model.onnx`를 두거나 `NRH_MODEL`로
// 알려준다. 경로를 코드에 적으면 만든 사람 PC의 구조가 공개 저장소에 남는다
const modelPath =
  process.env.NRH_MODEL ?? fileURLToPath(new URL('../model.onnx', import.meta.url));

const canvasPath = join(here, 'fixtures', 'street-canvas.bin');
const canRun = ref.endToEnd !== null && existsSync(modelPath) && existsSync(canvasPath);

test(
  '같은 텐서를 넣으면 기준값과 같은 탐지가 나온다',
  { skip: canRun ? false : '모델이나 기준 데이터가 없다' },
  async () => {
    const ort = await import('onnxruntime-web');
    const item = ref.endToEnd;

    const modelBytes = new Uint8Array(readFileSync(modelPath));
    const classNames = readClassMap(modelBytes);
    const s = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] });

    const session = {
      run: async (input, size) => {
        const t = new ort.Tensor('float32', input, [1, 3, size, size]);
        const r = await s.run({ [s.inputNames[0]]: t });
        const o = r[s.outputNames[0]];
        return { data: o.data, dims: o.dims };
      },
      providers: ['wasm'],
      modelFile: item.model_file,
      modelName: null,
      classNames: classNames,
      resize: 'reference',
    };

    // 기준 구현이 만든 640x640 uint8 캔버스. 정규화와 NCHW 전치만 JS가 한다
    const canvas = new Uint8Array(readFileSync(canvasPath));
    const tensor = rgbToTensor(canvas, item.canvasSize);
    const value = letterbox(item.origWidth, item.origHeight, item.canvasSize);

    const result = await detectFromTensor(session, tensor, value, 0, { conf: item.conf, iou: item.iou });
    const got = serializeResult(result).detections;

    await s.release();

    assert.equal(got.length, item.detections.length, '탐지 개수');

    // **클래스와 confidence는 정확히 같아야 한다.** 여기가 어긋나면 진짜 버그다
    const table = (ds) =>
      ds
        .map((d) => `${d.class_name}@${d.confidence.toFixed(3)}`)
        .sort()
        .join(' ');
    assert.equal(table(got), table(item.detections), '클래스와 confidence');

    // **좌표까지 정확히 같아야 한다.** 느슨하게 두면 역변환이 조금 어긋난 것도 통과한다
    const keyOf = (d) =>
      `${d.class_name} ${d.x1},${d.y1},${d.x2},${d.y2} ${d.confidence.toFixed(3)}`;
    assert.deepEqual(got.map(keyOf), item.detections.map(keyOf));
  },
);

/**
 * **한때 좌표가 안 맞았다.** 왜 그랬고 무엇을 고쳤는지 남겨둔다 - 같은 함정에 다시
 * 빠지면 이 테스트를 느슨하게 만들고 싶어질 것이다.
 *
 * 처음 붙였을 때 9개 중 4개의 박스가 달랐다. 원시 출력의 **박스 채널은 비트까지
 * 같았고**(최대차 0), 같은 원시 출력을 양쪽 후처리에 넣어도 똑같이 4개가 갈렸다.
 * 즉 WASM 탓이 아니라 **NMS에서 누가 이기느냐**의 차이였다.
 *
 * 원인은 **int8 양자화가 점수를 이산값으로 만든다**는 것이다. 이 이미지에서 conf를
 * 통과한 후보 68개 중 **서로 다른 점수는 23개뿐이고 59개가 동점**이었다. 동점이면
 * 정렬 순서가 승자를 정하는데, `np.argsort` 기본값(quicksort)이 안정 정렬이 아니라 **순서가
 * 규정돼 있지 않았다.** 높은 인덱스 우선(4/9)도 낮은 인덱스 우선(5/9)도 재현하지 못했다.
 *
 * **고친 방법**: 양쪽 다 동점을 **인덱스가 작은 쪽 먼저**로 깬다. 기준 구현은
 * `np.argsort(-scores, kind="stable")`, JS는 `점수 내림차순 || 인덱스 오름차순`이다.
 * 클래스별 억제 방식도 기준 구현과 같게 맞췄다(좌표를 구간별로 옮겨 한 번에) - 나눠 돌리면 살아남는
 * 집합은 같아도 순서가 달라진다.
 *
 * 그래서 지금은 **좌표까지 정확히** 견줄 수 있다. 느슨하게 두면 역변환이 어긋난 것도
 * 같이 통과한다.
 */
