/**
 * 모델 파일에서 클래스 맵을 읽는다.
 *
 * **왜 직접 읽나** - `onnxruntime-web`도 `onnxruntime-react-native`도 모델의
 * `metadata_props`를 노출하지 않는다(`metadata`, `modelMetadata`, `metadataProps`,
 * `customMetadata` 전부 없다). 파이썬 onnxruntime에는 있는데 JS 쪽에는 안 올라와 있다.
 *
 * 그래서 `.onnx` 파일 바이트를 직접 읽는다. 클래스 목록을 코드에 직접 적으면 모델을
 * 바꿀 때 조용히 어긋난다.
 *
 * **전체 protobuf 파서가 아니다.** ModelProto에서 `metadata_props`(필드 14)만 찾아
 * 나머지는 길이만 보고 건너뛴다.
 */

/** 클래스 맵을 못 읽었을 때. */
export class NrhDetectorModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NrhDetectorModelError';
  }
}

/**
 * UTF-8 바이트를 문자열로.
 *
 * **`TextDecoder`를 쓰면 안 된다.** Node와 브라우저에는 있지만 **Hermes(React Native)에는
 * 없다.** 타입 검사도 통과하고 노드 테스트도 통과하는데 폰에서만 `Property 'TextDecoder'
 * doesn't exist`로 오류가 난다 - 실제로 한 번 겪었다.
 *
 * 클래스 이름은 거의 ASCII지만 한글이 들어올 수 있으므로 3바이트까지 제대로 푼다.
 */
function decodeUtf8(b: Uint8Array): string {
  let s = '';
  let i = 0;
  while (i < b.length) {
    const c = b[i++];
    if (c < 0x80) {
      s += String.fromCharCode(c);
    } else if (c < 0xe0) {
      s += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f));
    } else if (c < 0xf0) {
      s += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f));
    } else {
      // 4바이트는 서로게이트 쌍으로 나눠 담는다 (이모지 등)
      const cp =
        ((c & 0x07) << 18) |
        ((b[i++] & 0x3f) << 12) |
        ((b[i++] & 0x3f) << 6) |
        (b[i++] & 0x3f);
      const v = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
  }
  return s;
}

/** protobuf varint 하나를 읽는다. 7비트씩, 최상위 비트가 "더 있다"는 뜻이다. */
function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [value, pos];
    shift += 7;
    if (shift > 63) break;
  }
  throw new NrhDetectorModelError('Malformed varint in model file.');
}

/**
 * ModelProto에서 `metadata_props`를 전부 꺼낸다.
 *
 * 각 항목은 `StringStringEntryProto { key = 1, value = 2 }`다.
 */
export function readMetadata(modelBytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;

  while (i < modelBytes.length) {
    let tag: number;
    [tag, i] = readVarint(modelBytes, i);
    const field = tag >>> 3;
    const wire = tag & 7;

    if (wire === 2) {
      let len: number;
      [len, i] = readVarint(modelBytes, i);
      if (field === 14) {
        const entry = modelBytes.subarray(i, i + len);
        let j = 0;
        let key = '';
        let value = '';
        while (j < entry.length) {
          let t: number;
          [t, j] = readVarint(entry, j);
          if ((t & 7) !== 2) break;
          let n: number;
          [n, j] = readVarint(entry, j);
          const s = decodeUtf8(entry.subarray(j, j + n));
          j += n;
          if (t >>> 3 === 1) key = s;
          else if (t >>> 3 === 2) value = s;
        }
        if (key) out.set(key, value);
      }
      i += len;
    } else if (wire === 0) {
      [, i] = readVarint(modelBytes, i);
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      // 알 수 없는 wire type - 더 가면 엉뚱한 것을 읽는다
      break;
    }
  }
  return out;
}

/**
 * `names` 메타데이터를 클래스 맵으로 바꾼다.
 *
 * **JSON이 아니다.** 파이썬 dict를 문자열로 찍은 형태다.
 *
 *     {0: 'micromobility', 1: 'bus', 2: 'car', ...}
 *
 * 키에 따옴표가 없고 값이 홑따옴표라 **`JSON.parse`는 첫 글자에서 실패한다.** 파이썬은
 * `ast.literal_eval`로 읽는데 JS에는 그런 것이 없다.
 *
 * **`eval`이나 `new Function`으로 때우지 않는다** - 모델 파일이 코드 실행 경로가 된다.
 * 남이 준 모델을 열었을 뿐인데 임의 코드가 도는 것은 받아들일 수 없다.
 *
 * 이름에 **공백이 들어간 것이 있다** (`traffic light`, `fire hydrant`). 따옴표 안을
 * 그대로 쓰므로 문제가 없지만, 받는 쪽에서 이름을 키나 파일명으로 쓰려면 걸린다.
 */
export function parseClassMap(names: string): Map<number, string> {
  const map = new Map<number, string>();
  const s = names.trim();
  if (!s.startsWith('{') || !s.endsWith('}')) {
    throw new NrhDetectorModelError(
      `Cannot parse class map: expected a dict literal, got ${JSON.stringify(s.slice(0, 40))}.`,
    );
  }

  let i = 1;
  const end = s.length - 1;
  while (i < end) {
    // 키 - 숫자
    while (i < end && /[\s,]/.test(s[i])) i++;
    if (i >= end) break;
    const keyStart = i;
    while (i < end && /[0-9]/.test(s[i])) i++;
    if (i === keyStart) {
      throw new NrhDetectorModelError(`Cannot parse class map: expected a digit at ${i}.`);
    }
    const id = Number(s.slice(keyStart, i));

    while (i < end && /\s/.test(s[i])) i++;
    if (s[i] !== ':') {
      throw new NrhDetectorModelError(`Cannot parse class map: expected ':' at ${i}.`);
    }
    i++;
    while (i < end && /\s/.test(s[i])) i++;

    // 값 - 따옴표로 감싼 문자열. 파이썬 repr은 보통 홑따옴표지만 이름에 홑따옴표가
    // 들어가면 겹따옴표로 바뀌므로 둘 다 받는다
    const quote = s[i];
    if (quote !== "'" && quote !== '"') {
      throw new NrhDetectorModelError(`Cannot parse class map: expected a quote at ${i}.`);
    }
    i++;
    let name = '';
    while (i < end && s[i] !== quote) {
      if (s[i] === '\\') {
        i++;
        name += s[i] === 'n' ? '\n' : s[i] === 't' ? '\t' : s[i];
      } else {
        name += s[i];
      }
      i++;
    }
    if (s[i] !== quote) {
      throw new NrhDetectorModelError('Cannot parse class map: unterminated string.');
    }
    i++;
    map.set(id, name);
  }

  if (map.size === 0) {
    throw new NrhDetectorModelError('Cannot parse class map: no entries found.');
  }
  return map;
}

/**
 * 모델이 기대하는 입력 한 변을 읽는다.
 *
 * **코드에 640을 고정해 두면 모델을 바꿀 때 조용히 깨진다.** 클래스 맵은 모델에서 읽으면서
 * 입력 크기만 코드에 고정해 두면 앞뒤가 안 맞는다 - 480으로 재학습한 모델을 넣으면 640으로
 * 레터박스해서 넣게 되고, ORT가 모양이 안 맞는다고 오류를 낸다.
 *
 * **찾는 순서는 기준 구현과 같다.**
 *
 * 1. **그래프에 적힌 입력 shape** - `[1, 3, 640, 640]`의 셋째 값. 모델이 실제로 받는
 *    크기라 가장 믿을 만하다. 동적 축이면 `-1`이나 문자열이라 못 쓴다.
 * 2. `imgsz` 메타데이터 - ultralytics가 `[640, 640]` 꼴로 적어둔다.
 * 3. 640 - 그 값으로 학습한 모델이 대부분이라, 둘 다 없다고 못 열 이유는 없다.
 *
 * @param inputShape 세션이 보고하는 입력 shape. 없으면 메타데이터만 본다.
 * @throws 정사각이 아니면. 레터박스가 정사각을 전제로 짜여 있다.
 */
export function readInputSize(
  modelBytes: Uint8Array,
  inputShape?: readonly (number | string)[],
  fallback = 640,
): number {
  // 1. 그래프가 먼저다
  if (inputShape && inputShape.length === 4) {
    const h = inputShape[2];
    const w = inputShape[3];
    if (typeof h === 'number' && Number.isInteger(h) && h > 0) {
      if (typeof w === 'number' && Number.isInteger(w) && w > 0 && w !== h) {
        throw new NrhDetectorModelError(
          `Model input is not square (${h}x${w}). Letterbox assumes a square input.`,
        );
      }
      return h;
    }
  }

  // 2. 메타데이터
  const raw = readMetadata(modelBytes).get('imgsz');
  if (raw === undefined) return fallback;
  const nums = raw.match(/\d+/g);
  if (!nums || nums.length === 0) return fallback;
  const sides = nums.map(Number);
  if (sides.length >= 2 && sides[0] !== sides[1]) {
    throw new NrhDetectorModelError(
      `Model input is not square (imgsz=${raw}). Letterbox assumes a square input.`,
    );
  }
  return sides[0];
}

/** 모델 바이트에서 클래스 맵까지 한 번에. */
export function readClassMap(modelBytes: Uint8Array): Map<number, string> {
  const meta = readMetadata(modelBytes);
  const names = meta.get('names');
  if (names === undefined) {
    throw new NrhDetectorModelError(
      "Model metadata has no 'names' entry. Cannot determine the class map.",
    );
  }
  return parseClassMap(names);
}
