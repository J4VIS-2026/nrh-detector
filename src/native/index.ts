/**
 * React Native 진입점 - `onnxruntime-react-native` + `react-native-fast-opencv`.
 *
 * **canvas가 없다.** 그래서 축소·패딩·정규화를 opencv가 한다. 브라우저 쪽과 리샘플러가
 * 다르므로 탐지가 몇 개 어긋날 수 있고, 그래서 `settings.resize`에 `"opencv"`가 실린다.
 *
 * **전처리를 통째로 opencv에 넘긴 것은 재보고 정한 것이다.** 같은 계산을 JS 반복문으로
 * 하면 태블릿에서 68ms, opencv로 넘기면 41ms다. 출력은 같다(최대 오차 6e-8).
 * 640×640×3 = 123만 개를 Hermes가 도는 것이 그만큼 비싸다.
 */

import { InferenceSession, Tensor } from 'onnxruntime-react-native';
import {
  OpenCV,
  Mat,
  MatVector,
  Size,
  Scalar,
  BorderTypes,
  DataTypes,
  InterpolationFlags,
} from 'react-native-fast-opencv';

import { letterbox, PAD_VALUE, type LetterboxParams } from '../core/letterbox.js';
import { detectFromTensor, type Session, type DetectOptions } from '../core/detect.js';
import { readClassMap, readInputSize } from '../core/classmap.js';
import type { DetectionResult } from '../core/schema.js';

export interface DetectorOptions {
  /** 기기에 있는 모델 `.onnx`의 경로. */
  modelPath: string;
  /** 모델 파일 바이트. 클래스 맵을 읽는 데 쓴다 (ORT가 metadata를 안 준다). */
  modelBytes: Uint8Array;
  modelName?: string | null;
  /** ORT 실행 프로바이더. **기본은 `['cpu']`가 맞다** - 아래 설명 참고. */
  executionProviders?: string[];
  conf?: number;
  iou?: number;
}

// **`noUpscale` 옵션을 뺐다.** 640보다 작게 들어오면 늘리지 말자는 것이었는데,
// 참조 구현(ultralytics `LetterBox`)의 `scaleup` 기본값이 `True`고 학습도 그렇게 했다 -
// 안 늘리면 물체가 모델이 배운 것보다 작게 들어간다. 기준 구현에 없는 옵션이라
// 켜는 순간 두 구현이 갈리기도 한다.

/**
 * React Native용 탐지기.
 *
 * **`nnapi`나 `xnnpack`을 켜지 마라.** 두 기기(2020년 태블릿, 2023년 플립5)에서 재보니
 * `xnnpack`이 2.4~2.5배, `nnapi`가 2.7~2.8배 **느렸다.** 3년 차이 나는 기기에서 배수가
 * 거의 같아 드라이버 품질 문제가 아니다.
 */
export class Detector {
  private constructor(
    private readonly session: Session,
    private readonly ortSession: InferenceSession,
    private readonly defaults: { conf?: number; iou?: number },
    /** 모델이 기대하는 입력 한 변. **코드에 고정하지 않고 모델에서 읽는다.** */
    private readonly inputSize: number,
  ) {}

  /**
   * 전처리가 쓰는 `Mat`들. **프레임마다 새로 잡지 않고 다시 쓴다.**
   *
   * 크기가 프레임 크기와 입력 크기로만 정해져서 매번 같다. 새로 잡으면 프레임마다
   * 7MB를 만들고 버리게 된다.
   *
   * 프레임 크기가 바뀌면(카메라 설정을 바꾸면) 버리고 다시 잡는다.
   */
  private buffers: {
    key: string;
    small: Mat;
    padded: Mat;
    floats: Mat;
    /**
     * 모델에 넣을 텐서. **이것도 다시 쓴다.**
     *
     * 매 프레임 전체가 덮여 쓰이므로 남은 값이 새는 일은 없다. 밖으로 나가지도 않는다 -
     * `detect()`가 돌려주는 것은 탐지 결과뿐이고, 이 배열은 ORT까지만 간다.
     *
     * **`detect()`를 기다리지 않고 겹쳐 부르면 깨진다.** 앞 프레임이 아직 ORT 안에
     * 있는데 다음 프레임이 같은 배열을 덮어쓰기 때문이다.
     */
    tensor: Float32Array;
  } | null = null;

  static async open(options: DetectorOptions): Promise<Detector> {
    // **클래스 맵은 모델 바이트에서 직접 읽는다.** 이유는 `core/classmap.ts` 참고
    const classNames = readClassMap(options.modelBytes);

    const providers = options.executionProviders ?? ['cpu'];
    const s = await InferenceSession.create(options.modelPath, {
      executionProviders: providers,
    });

    // **입력 크기도 모델에서 읽는다.** 근거와 찾는 순서는 `core/classmap.ts` 의
    // `readInputSize` 참고. 그래프의 입력 shape 을 먼저 보므로 여기서 넘긴다
    const firstInput = s.inputMetadata?.[0];
    const inputShape =
      firstInput && 'shape' in firstInput ? (firstInput.shape as readonly (number | string)[]) : undefined;
    const inputSize = readInputSize(options.modelBytes, inputShape);

    const fileName = options.modelPath.split(/[\\/]/).pop() ?? '';
    const session: Session = {
      run: async (input, size) => {
        const t = new Tensor('float32', input, [1, 3, size, size]);
        const out = await s.run({ [s.inputNames[0]]: t });
        const o = out[s.outputNames[0]];
        return { data: o.data as Float32Array, dims: o.dims };
      },
      providers,
      modelFile: fileName,
      modelName: options.modelName ?? null,
      classNames,
      resize: 'opencv',
    };

    return new Detector(session, s, { conf: options.conf, iou: options.iou }, inputSize);
  }

  get classNames(): ReadonlyMap<number, string> {
    return this.session.classNames;
  }

  /**
   * 프레임 하나를 탐지한다.
   *
   * @param frame RGB uint8 `Mat`. vision-camera에서 왔다면 색 순서를 먼저 맞춰야 한다 -
   *   **BGR로 넣으면 예외 없이 정확도만 떨어진다.**
   */
  async detect(frame: Mat, options: DetectOptions = {}): Promise<DetectionResult> {
    const receivedAt = options.receivedAt ?? Date.now() / 1000;
    const t0 = Date.now();
    const { tensor, params } = this.preprocess(frame);
    const preprocessMs = Date.now() - t0;

    return detectFromTensor(this.session, tensor, params, preprocessMs, {
      conf: options.conf ?? this.defaults.conf,
      iou: options.iou ?? this.defaults.iou,
      receivedAt,
      stream: options.stream,
    });
  }

  /**
   * 레터박스 + 정규화 + NCHW를 전부 opencv로.
   *
   *     resize → copyMakeBorder(114) → convertTo(CV_32F, 1/255) → split → set ×3
   *
   * JS에 남는 것은 면 3장을 옮기는 복사뿐이다. **바꿀 일이 생기면 기준 구현의 출력과 반드시
   * 대조해라** - 전처리가 틀리면 예외가 안 나고 정확도만 조용히 떨어진다.
   */
  private preprocess(frame: Mat): { tensor: Float32Array; params: LetterboxParams } {
    const params = letterbox(frame.cols, frame.rows, this.inputSize);
    const S = this.inputSize;

    const key = `${frame.cols}x${frame.rows}x${S}`;
    if (this.buffers?.key !== key) {
      this.buffers?.small.release();
      this.buffers?.padded.release();
      this.buffers?.floats.release();
      this.buffers = {
        key,
        small: Mat.createFromBuffer('uint8', params.newHeight, params.newWidth, 3,
                                    new Uint8Array(params.newHeight * params.newWidth * 3)),
        padded: Mat.createFromBuffer('uint8', S, S, 3, new Uint8Array(S * S * 3)),
        floats: Mat.createFromBuffer('float32', S, S, 3, new Float32Array(S * S * 3)),
        tensor: new Float32Array(S * S * 3),
      };
    }
    const { small, padded, floats, tensor } = this.buffers;

    OpenCV.resize(
      frame,
      small,
      Size.create(params.newWidth, params.newHeight),
      0,
      0,
      InterpolationFlags.INTER_AREA,
    );

    OpenCV.copyMakeBorder(
      small,
      padded,
      params.padY,
      S - params.newHeight - params.padY,
      params.padX,
      S - params.newWidth - params.padX,
      BorderTypes.BORDER_CONSTANT,
      Scalar.create(PAD_VALUE, PAD_VALUE, PAD_VALUE),
    );

    OpenCV.convertTo(padded, floats, DataTypes.CV_32F, 1 / 255, 0);

    // HWC → CHW. 인터리브를 푸는 것이 split이다
    const planes = MatVector.create();
    OpenCV.split(floats, planes);

    const plane = S * S;
    for (let c = 0; c < 3; c++) {
      const p = planes.get(c);
      tensor.set(p.toBuffer('float32').buffer, c * plane);
      p.release();
    }


    // 면은 `split`이 새로 만든 것이라 매번 버린다. 나머지는 `this.buffers`가 가지고 있다
    planes.release();
    return { tensor, params };
  }

  async close(): Promise<void> {
    this.buffers?.small.release();
    this.buffers?.padded.release();
    this.buffers?.floats.release();
    this.buffers = null;
    await this.ortSession.release();
  }
}

export * from '../core/index.js';

export { createGmc, DEFAULT_GMC_OPTIONS, type GmcOptions } from './gmc.js';
