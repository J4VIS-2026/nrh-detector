/**
 * 픽셀을 모델 입력 텐서로.
 *
 * **줄이고 채우는 것은 여기 없다.** 그것은 대상마다 다르다 - 브라우저는 canvas가,
 * RN은 opencv가 한다. 여기는 **이미 640×640이 된 픽셀**을 받아 0-1로 정규화하고
 * NCHW로 옮기는 일만 한다.
 *
 * 그 경계를 이렇게 그은 이유는 **리샘플러가 대상마다 다르기 때문**이다. canvas의 축소
 * 알고리즘은 규격에 정해져 있지 않아 브라우저마다 다르고, opencv `INTER_AREA`와도 다르다.
 * 그 차이는 여기서 없앨 수 없으므로, **없앨 수 있는 부분(정규화·전치)만 한 곳에 모은다.**
 */

/** 정규화에 쓰는 값. 파이썬은 `padded.astype(float32) / 255.0`이다. */
const DIVISOR = 255;

/**
 * RGBA 픽셀(canvas `getImageData`가 주는 것)을 NCHW float32 텐서로.
 *
 * canvas는 알파 채널을 꼭 붙여서 준다. 알파는 버린다 - 모델은 3채널이다.
 *
 * @param rgba `size * size * 4` 길이. canvas에서 그대로 온 것.
 * @param size 정사각 한 변 (640).
 */
export function rgbaToTensor(
  rgba: Uint8ClampedArray | Uint8Array,
  size: number,
): Float32Array {
  const plane = size * size;
  const expected = plane * 4;
  if (rgba.length !== expected) {
    throw new RangeError(
      `Expected ${expected} RGBA bytes for ${size}x${size}, got ${rgba.length}.`,
    );
  }
  const tensor = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const s = i * 4;
    tensor[i] = rgba[s] / DIVISOR;
    tensor[plane + i] = rgba[s + 1] / DIVISOR;
    tensor[2 * plane + i] = rgba[s + 2] / DIVISOR;
  }
  return tensor;
}

/**
 * RGB 픽셀(알파 없음)을 NCHW float32 텐서로.
 *
 * @param rgb `size * size * 3` 길이.
 * @param size 정사각 한 변 (640).
 */
export function rgbToTensor(
  rgb: Uint8ClampedArray | Uint8Array,
  size: number,
): Float32Array {
  const plane = size * size;
  const expected = plane * 3;
  if (rgb.length !== expected) {
    throw new RangeError(
      `Expected ${expected} RGB bytes for ${size}x${size}, got ${rgb.length}.`,
    );
  }
  const tensor = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const s = i * 3;
    tensor[i] = rgb[s] / DIVISOR;
    tensor[plane + i] = rgb[s + 1] / DIVISOR;
    tensor[2 * plane + i] = rgb[s + 2] / DIVISOR;
  }
  return tensor;
}
