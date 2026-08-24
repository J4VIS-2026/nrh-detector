/**
 * 브라우저 진입점 - `onnxruntime-web`.
 *
 * **canvas가 축소를 한다.** 의존성이 0개라는 것이 값이지만, **canvas의 축소 알고리즘은
 * 규격에 정해져 있지 않아 브라우저마다 다르다.** opencv `INTER_AREA` 와도 다르므로
 * 탐지가 몇 개 어긋날 수 있다 - 좌표는 어긋나지 않는다(스케일·패딩 계산은 공용이다).
 *
 * 그래서 `settings.resize`에 `"canvas"`가 실린다. 결과만 받은 쪽도 무엇으로 줄인
 * 것인지 알 수 있어야 한다.
 */

import * as ort from 'onnxruntime-web';

import { letterbox, PAD_VALUE, type LetterboxParams } from '../core/letterbox.js';
import { rgbaToTensor } from '../core/tensor.js';
import { detectFromTensor, type Session, type DetectOptions } from '../core/detect.js';
import { readClassMap, readInputSize } from '../core/classmap.js';
import type { DetectionResult } from '../core/schema.js';

/** 브라우저에서 그릴 수 있는 것이면 무엇이든 받는다. */
export type Drawable =
  | HTMLImageElement
  | HTMLVideoElement
  | HTMLCanvasElement
  | ImageBitmap
  | OffscreenCanvas;

export interface DetectorOptions {
  /** 모델 `.onnx`의 URL. */
  modelUrl: string;
  /**
   * 모델을 **어떻게 부를지**. 결과의 `settings.model`에 실린다.
   *
   * 안 주면 `null`이다. URL의 파일명으로 채워 이름인 척하지 않는다 - 받는 쪽이
   * 레지스트리 항목인 줄 알게 된다.
   */
  modelName?: string | null;
  /** ORT 실행 프로바이더. 기본은 `['wasm']`. */
  executionProviders?: string[];
  conf?: number;
  iou?: number;
}

/**
 * 브라우저용 탐지기.
 *
 * ```ts
 * const det = await Detector.open({ modelUrl: '/model.onnx' });
 * const result = await det.detect(document.querySelector('img')!);
 * console.log(result.detections);
 * ```
 */
export class Detector {
  private constructor(
    private readonly session: Session,
    private readonly ortSession: ort.InferenceSession,
    private readonly defaults: { conf?: number; iou?: number },
    private readonly canvas: OffscreenCanvas | HTMLCanvasElement,
    private readonly ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
    /** 모델이 기대하는 입력 한 변. **코드에 고정하지 않고 모델에서 읽는다.** */
    private readonly inputSize: number,
  ) {}

  /** 모델을 받아 세션을 연다. */
  static async open(options: DetectorOptions): Promise<Detector> {
    const res = await fetch(options.modelUrl);
    if (!res.ok) {
      throw new Error(`Cannot fetch model from ${options.modelUrl}: HTTP ${res.status}.`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());

    // **클래스 맵은 모델 바이트에서 직접 읽는다.** 이유는 `core/classmap.ts` 참고
    const classNames = readClassMap(bytes);

    const providers = options.executionProviders ?? ['wasm'];
    const s = await ort.InferenceSession.create(bytes, { executionProviders: providers });

    // **입력 크기도 모델에서 읽는다.** 근거와 찾는 순서는 `core/classmap.ts` 의
    // `readInputSize` 참고. 그래프의 입력 shape 을 먼저 보므로 여기서 넘긴다
    const firstInput = s.inputMetadata?.[0];
    const inputShape =
      firstInput && 'shape' in firstInput ? (firstInput.shape as readonly (number | string)[]) : undefined;
    const inputSize = readInputSize(bytes, inputShape);

    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(inputSize, inputSize)
        : Object.assign(document.createElement('canvas'), {
            width: inputSize,
            height: inputSize,
          });
    const ctx = (canvas as HTMLCanvasElement).getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Cannot get a 2D canvas context.');

    const fileName = options.modelUrl.split('/').pop() ?? '';
    const session: Session = {
      run: async (input, size) => {
        const t = new ort.Tensor('float32', input, [1, 3, size, size]);
        const out = await s.run({ [s.inputNames[0]]: t });
        const o = out[s.outputNames[0]];
        return { data: o.data as Float32Array, dims: o.dims };
      },
      // **요청한 값이 아니라 실제로 쓰인 것**을 담아야 하는데, ORT web은 활성 프로바이더를
      // 보고하지 않는다. 요청값을 그대로 싣고 이 한계를 여기 적어둔다
      providers,
      modelFile: fileName,
      modelName: options.modelName ?? null,
      classNames,
      resize: 'canvas',
    };

    return new Detector(session, s, { conf: options.conf, iou: options.iou }, canvas, ctx as never, inputSize);
  }

  /** 클래스 맵. 모델에서 읽은 것이다. */
  get classNames(): ReadonlyMap<number, string> {
    return this.session.classNames;
  }

  /** 그림 하나를 탐지한다. */
  async detect(image: Drawable, options: DetectOptions = {}): Promise<DetectionResult> {
    const receivedAt = options.receivedAt ?? Date.now() / 1000;
    const t0 = performance.now();
    const { tensor, params } = this.preprocess(image);
    const preprocessMs = performance.now() - t0;

    return detectFromTensor(this.session, tensor, params, preprocessMs, {
      conf: options.conf ?? this.defaults.conf,
      iou: options.iou ?? this.defaults.iou,
      receivedAt,
      stream: options.stream,
    });
  }

  /** 레터박스 + 정규화 + NCHW. 축소는 canvas가 한다. */
  private preprocess(image: Drawable): { tensor: Float32Array; params: LetterboxParams } {
    const w = 'videoWidth' in image ? image.videoWidth : image.width;
    const h = 'videoHeight' in image ? image.videoHeight : image.height;
    if (!w || !h) throw new Error('The image has no size yet. Wait for it to load.');

    const params = letterbox(w, h, this.inputSize);
    const g = this.ctx;

    // 회색으로 덮고 가운데에 놓는다. numpy `np.full` 로 채우는 것과 같다
    g.fillStyle = `rgb(${PAD_VALUE}, ${PAD_VALUE}, ${PAD_VALUE})`;
    g.fillRect(0, 0, this.inputSize, this.inputSize);
    g.drawImage(image as CanvasImageSource, params.padX, params.padY, params.newWidth, params.newHeight);

    const rgba = g.getImageData(0, 0, this.inputSize, this.inputSize).data;
    return { tensor: rgbaToTensor(rgba, this.inputSize), params };
  }

  /** 세션을 닫는다. */
  async close(): Promise<void> {
    await this.ortSession.release();
  }
}

export * from '../core/index.js';
export { createGmc } from './gmc.js';
