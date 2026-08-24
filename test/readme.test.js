/**
 * README가 조용히 낡지 않게 한다.
 *
 * 이 README는 **팀원에게 넘기는 문서**다. 절 이름을 바꾸고 목차를 안 고치면 링크가
 * 끊기는데, 끊긴 링크는 아무 오류도 안 내고 그냥 아무 데도 안 간다.
 *
 * 파일 링크도 막는다. 원격 저장소가 없어서 상대 링크가 안 열린다 - 내용을 안에 담아야
 * 한다. **같은 문서 안의 앵커는 예외다** (목차가 그것이다).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// 줄바꿈을 LF로 통일한다. git이 체크아웃에서 CRLF로 바꿔놓으면 정규식이
// 조용히 안 맞아 "예시가 없다"는 엉뚱한 실패가 난다
const README = readFileSync(join(root, 'README.md'), 'utf-8')
  .split(String.fromCharCode(13))
  .join('');

/** GitHub가 제목에서 앵커를 만드는 규칙. 한글은 그대로 남는다. */
function anchor(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const section = new Set(
  [...README.matchAll(/^#{2,4}\s+(.+)$/gm)].map((m) => anchor(m[1])),
);
const links = [...README.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];

test('목차의 앵커가 실제 절을 가리킨다', () => {
  const broken = links
    .filter(([, , target]) => target.startsWith('#'))
    .filter(([, , target]) => !section.has(target.slice(1)))
    .map(([, text, target]) => `[${text}](${target})`);
  assert.deepEqual(broken, [], '목차를 절 이름에 맞춰 고쳐라');
});

test('앵커가 아닌 링크는 넣지 않는다', () => {
  const bad = links
    .map(([, text, target]) => ({ text, target }))
    .filter(({ target }) => !target.startsWith('#') && !/^https?:\/\//.test(target))
    .map(({ text, target }) => `[${text}](${target})`);
  assert.deepEqual(bad, [], '원격 저장소가 없어 상대 링크가 안 열린다');
});

test('출력 형식의 필드가 실제 스키마와 같다', async () => {
  // README의 예시 JSON을 실제로 파싱해서 필드 이름을 견준다. 필드를 하나 바꿔놓고
  // README를 안 고치면 팀원이 없는 키를 읽게 된다
  const blob = README.match(/```json\n([\s\S]*?)```/);
  assert.ok(blob, 'README에 출력 예시 JSON이 있어야 한다');
  const example = JSON.parse(blob[1]);

  const { makeDetection, serializeResult } = await import('../dist/core/schema.js');
  const real = serializeResult({
    speed: { preprocess: 0, inference: 0, postprocess: 0 },
    settings: {
      conf: 0.25, iou: 0.7, resize: 'canvas', providers: ['wasm'],
      model: null, model_file: 'model.onnx', track: false,
    },
    image: { width: 1920, height: 1080, received_at: 0, stream: null },
    detections: [
      makeDetection({
        class_id: 2, class_name: 'car', confidence: 0.95,
        x1: 3, y1: 351, x2: 618, y2: 802, track_id: null,
      }),
    ],
  });

  assert.deepEqual(Object.keys(example).sort(), Object.keys(real).sort(), '최상위');
  for (const k of ['speed', 'settings', 'image']) {
    assert.deepEqual(Object.keys(example[k]).sort(), Object.keys(real[k]).sort(), k);
  }
  assert.deepEqual(
    Object.keys(example.detections[0]).sort(),
    Object.keys(real.detections[0]).sort(),
    'detections',
  );
});
