/**
 * 카메라 움직임 보정 (브라우저).
 *
 * **축소는 canvas가 한다.** `drawImage`로 1/4 크기 canvas에 그리면 브라우저가 줄여
 * 주므로, 자바스크립트는 원본이 아니라 **줄어든 그림만** 읽으면 된다 - 1280×720에서
 * 921,600픽셀 대신 57,600픽셀이다. 계산 자체는 `core/gmc`가 한다.
 *
 * ```ts
 * import { Tracker } from 'nrh-detector/web';
 * import { createGmc } from 'nrh-detector/web';
 *
 * const tracker = new Tracker({}, createGmc());
 * ```
 */

import { Gmc, DEFAULT_GMC_OPTIONS, rgbaToGray, type GmcOptions } from '../core/gmc.js';
import type { Drawable } from './index.js';

export { DEFAULT_GMC_OPTIONS, type GmcOptions };

/**
 * `Tracker`에 그대로 넣을 수 있는 보정 함수를 만든다.
 *
 * 받는 프레임은 `detect()`에 넣는 것과 같은 것이면 된다 - `<video>`, `<img>`,
 * canvas, `ImageBitmap`.
 */
export function createGmc(options: Partial<GmcOptions> = {}): (frame: unknown) => number[] {
  const o = { ...DEFAULT_GMC_OPTIONS, ...options };
  const gmc = new Gmc(o);

  let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

  return (frame: unknown): number[] => {
    const image = frame as Drawable;
    const W = 'videoWidth' in image ? image.videoWidth : image.width;
    const H = 'videoHeight' in image ? image.videoHeight : image.height;
    if (!W || !H) return [...DEFAULT_WARP];

    const w = Math.max(1, Math.floor(W / o.downscale));
    const h = Math.max(1, Math.floor(H / o.downscale));

    if (canvas === null || canvas.width !== w || canvas.height !== h) {
      canvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(w, h)
          : Object.assign(document.createElement('canvas'), { width: w, height: h });
      canvas.width = w;
      canvas.height = h;
      ctx = (canvas as HTMLCanvasElement).getContext('2d', {
        willReadFrequently: true,
      }) as never;
    }
    if (!ctx) return [...DEFAULT_WARP];

    ctx.drawImage(image as CanvasImageSource, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    return gmc.applySmall(rgbaToGray(rgba, w, h), w, h, o.downscale);
  };
}

const DEFAULT_WARP = [1, 0, 0, 0, 1, 0];
