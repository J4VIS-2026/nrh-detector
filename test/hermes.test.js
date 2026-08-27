/**
 * Hermes에 없는 것을 쓰지 않았는가.
 *
 * **이 저장소가 실제로 밟은 함정이다.** `classmap.ts`가 `TextDecoder`를 썼는데
 * 타입 검사도 통과하고 노드 테스트도 전부 통과했다. **폰에서만** 오류가 났다 -
 * `Property 'TextDecoder' doesn't exist`.
 *
 * React Native는 Hermes 엔진에서 돈다. 브라우저도 Node도 아니라서 둘 다에 있는 것이
 * 여기엔 없을 수 있다. J0에서 직접 확인한 것들이다.
 *
 * 빌드 산출물(`dist/`)을 훑는다. **소스가 아니라 산출물을 보는 이유**는 tsc가 넣는
 * helper가 이런 것을 가져올 수 있어서다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

/** 기기에서 확인했다 (2026-08-05). */
const missing = [
  'TextDecoder',
  'TextEncoder',
  'WebAssembly',
  'SharedArrayBuffer',
  'WeakRef',
  'structuredClone',
  'FinalizationRegistry',
];

/** 브라우저 진입점은 예외다 - 거기는 Hermes가 아니다. */
const webOnly = ['web'];

function jsFiles(dir) {
  const result = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const filePath = join(dir, item.name);
    if (item.isDirectory()) result.push(...jsFiles(filePath));
    else if (item.name.endsWith('.js')) result.push(filePath);
  }
  return result;
}

test('Hermes에 없는 전역을 쓰지 않는다', { skip: existsSync(dist) ? false : 'dist가 없다 (npm run build)' }, () => {
  const matched = [];
  for (const filePath of jsFiles(dist)) {
    const rel = filePath.slice(dist.length + 1).split('\\').join('/');
    if (webOnly.some((w) => rel.startsWith(w + '/'))) continue;
    const text = readFileSync(filePath, 'utf-8');
    for (const name of missing) {
      // 주석 안에서 언급하는 것은 괜찮다 - 실제 호출만 본다
      const codeOnly = text
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
        .join('\n');
      if (new RegExp(`\\b${name}\\b`).test(codeOnly)) matched.push(`${rel}: ${name}`);
    }
  }
  assert.deepEqual(matched, [], 'Hermes에 없다 - 폰에서만 오류가 난다');
});

test('없는것 목록이 비어 있지 않다', () => {
  // 목록을 실수로 비우면 위 테스트가 항상 통과한다
  assert.ok(missing.length >= 5);
});
