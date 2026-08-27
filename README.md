# nrh-detector (JavaScript)

보행 장애물 24종을 탐지하고 연속 프레임에서 같은 객체를 추적합니다.
**브라우저(React)와 React Native 양쪽에서 씁니다.**

- [설치](#설치)
- [빠른 시작](#빠른-시작)
  - [브라우저 (React)](#브라우저-react)
  - [React Native](#react-native)
- [출력 형식](#출력-형식)
  - [detections](#detections)
  - [image](#image)
  - [settings](#settings)
  - [speed](#speed)
- [추적](#추적)
  - [흔들림 보정](#흔들림-보정)
- [클래스 맵](#클래스-맵)
- [이름 규칙](#이름-규칙)
- [기준 구현과의 대조](#기준-구현과의-대조)
- [돌려볼 수 있는 데모](#돌려볼-수-있는-데모)
- [아직 없는 것](#아직-없는-것)
- [빠르게, 그리고 제대로 돌리기](#빠르게-그리고-제대로-돌리기)
- [직접 빌드하고 시험하기](#직접-빌드하고-시험하기)

---

## 설치

npm 에 올리지 않았습니다. **받은 배포 파일(`.tgz`)을 경로로 설치하세요.**

```bash
npm install ./nrh-detector-0.10.1.tgz    # 파일 이름의 버전은 받은 것에 맞추세요
```

배포 파일을 직접 만들려면 아래 **직접 빌드하고 시험하기**를 보세요.

런타임은 **대상에 맞는 것을 직접 넣습니다.** 하나로 둘을 덮을 수 없어서 그렇습니다 —
패키지가 다르고 버전도 다릅니다.

```bash
# 브라우저
npm install onnxruntime-web

# React Native
npm install onnxruntime-react-native react-native-fast-opencv react-native-nitro-modules
```

**모델 파일은 패키지에 안 들어 있습니다.** 허깅페이스에서 받으세요.

    https://huggingface.co/J4VIS-2026/yolov8n-sidewalk-obstacle

`model.onnx` 하나(3.5MB)를 받아 **웹은 URL로, React Native는 앱 에셋으로** 넣습니다.

---

## 빠른 시작

### 브라우저 (React)

```ts
import { Detector } from 'nrh-detector/web';

const det = await Detector.open({ modelUrl: '/model.onnx' });

const img = document.querySelector('img')!;
const result = await det.detect(img);

for (const d of result.detections) {
  console.log(`${d.class_name} ${d.confidence.toFixed(2)} @ ${d.x1},${d.y1}`);
}
```

`detect()`에 넣을 수 있는 것: `HTMLImageElement`, `HTMLVideoElement`, `HTMLCanvasElement`,
`ImageBitmap`, `OffscreenCanvas`.

**`<img>`는 로드가 끝난 뒤에 넣으세요.** 아직이면 크기가 0이라 예외가 납니다.

### React Native

```ts
import { Detector } from 'nrh-detector/native';

const det = await Detector.open({
  modelPath: 모델경로,     // 파일 경로 - ORT가 읽습니다
  modelBytes: 모델바이트,  // 같은 파일의 바이트 - 클래스 맵을 읽습니다
});

const result = await det.detect(mat);   // RGB uint8 Mat
```

**경로와 바이트를 둘 다 줘야 합니다.** ORT는 경로로 모델을 열고, 클래스 맵은 저희가
파일 바이트를 직접 파싱해서 읽기 때문입니다 (아래 **클래스 맵** 절 참고).

**`Mat`은 RGB여야 합니다.** vision-camera는 보통 BGR이나 YUV로 줍니다. **색 순서가
틀리면 예외가 안 나고 정확도만 조용히 떨어집니다** — 반드시 먼저 맞추세요.

```ts
import { OpenCV, ColorConversionCodes } from 'react-native-fast-opencv';
OpenCV.cvtColor(bgr, rgb, ColorConversionCodes.COLOR_BGR2RGB);
```

---

## 출력 형식

`detect()`가 돌려주는 것입니다. **필드 이름을 `snake_case` 로 두었습니다** — 다른 언어로
만든 도구와 결과를 그대로 주고받기 위한 것입니다.

```json
{
  "speed": { "preprocess": 8.7, "inference": 149.2, "postprocess": 2.9 },
  "settings": {
    "conf": 0.25, "iou": 0.7, "resize": "canvas",
    "providers": ["wasm"], "model": null,
    "model_file": "model.onnx", "track": false
  },
  "image": { "width": 1920, "height": 1080, "received_at": 1754438400.5, "stream": null },
  "detections": [
    {
      "class_name": "car", "class_id": 2, "confidence": 0.95,
      "x1": 3, "y1": 351, "x2": 618, "y2": 802,
      "width": 615, "height": 451, "track_id": null
    }
  ]
}
```

JSON으로 내보낼 때는 `serializeResult()`를 쓰세요. `confidence`를 소수 3자리로 줄입니다 —
객체 상태에서는 원래 정밀도를 유지하다가 내보낼 때만 줄이는데, 그래야 두 점수가 같은
값으로 반올림돼도 정렬 순서가 유지됩니다.

### detections

**confidence 내림차순으로 정렬돼 있습니다.**

| 필드 | 뜻 |
|---|---|
| `class_name` | 클래스 이름. **공백이 든 것이 있습니다** (`traffic light`) |
| `class_id` | 클래스 번호 |
| `confidence` | 0~1 |
| `x1` `y1` `x2` `y2` | **원본 이미지 좌표계**의 정수. 640이 아닙니다 |
| `width` `height` | `x2 - x1`, `y2 - y1`. 좌표에서 파생되므로 어긋날 수 없습니다 |
| `track_id` | 추적 ID. 추적을 안 쓰면 `null` (아래 **추적**) |

좌표는 **이미 반올림된 정수**입니다. 원본 이미지 밖으로 나가지 않게 잘라둡니다.

`track_id`는 **키가 항상 있고 값만 달라집니다.** 추적 여부에 따라 필드가 생겼다 없어지면
받는 쪽이 두 모양을 다뤄야 합니다.

### image

넣은 그림에 대한 것입니다. 크기가 **640이 아니라 원본**인 것처럼, 나머지도 받은 그림
기준입니다.

| 필드 | 뜻 |
|---|---|
| `width` `height` | 원본 크기 |
| `received_at` | **우리가 이 그림을 받은 시각** (unix epoch 초) |
| `stream` | 스트림에서 왔으면 `{frame_index, timestamp_ms}`, 아니면 `null` |

`received_at`은 **촬영 시각이 아닙니다.** 센서에서 오는 시간은 저희 바깥입니다. 프레임을
직접 읽어 넘긴다면 **손에 넣은 시각을 직접 넣어주세요** — 안 그러면 그 사이에 흐른
시간만큼 늦은 값이 됩니다.

```ts
const receivedAt = Date.now() / 1000;
const result = await det.detect(frame, { receivedAt });
```

카메라는 `stream.timestamp_ms`가 항상 `null`입니다 — 시작도 끝도 없어서 "몇 초 지점"이라는
것이 없습니다. 시간 축이 필요하면 `received_at`을 쓰세요.

### settings

**이 결과를 무엇으로 만들었는지**입니다. 결과를 파일로 넘겨받은 쪽도 알 수 있어야 해서
같이 다닙니다.

| 필드 | 뜻 |
|---|---|
| `conf` `iou` | 쓴 임계값 |
| `resize` | 무엇으로 줄였나 — 웹은 `"canvas"`, RN은 `"opencv"` |
| `providers` | 실행 프로바이더 |
| `model` | 모델을 **어떻게 불렀는지**. 안 정했으면 `null` |
| `model_file` | 실제로 열린 **파일 이름**. 폴더 경로는 안 넣습니다 |
| `track` | 추적을 거쳤는지 |

`model`과 `model_file`이 따로인 이유는, 이름만으로는 부족하기 때문입니다 — 두 사람이 각자
자기 모델을 `v2`라고 부르면 같은 문자열이 다른 모델을 가리킵니다.

### speed

단계별 밀리초입니다.

**`preprocess`는 대상마다 하는 일이 다릅니다.** 웹은 canvas 그리기 + 정규화, RN은 opencv
전체입니다. 두 대상의 값을 나란히 비교하지 마세요.

---

## 추적

프레임마다 독립적으로 탐지하므로 3번 프레임의 볼라드와 4번 프레임의 볼라드가 같은
것인지 알 방법이 없습니다. `Tracker`가 그 동일성을 붙입니다.

```ts
import { Tracker } from 'nrh-detector/web';   // native도 같습니다

const T = new Tracker();

for await (const frame of frames) {
  const r = T.update(await det.detect(frame), frame);
  for (const d of r.detections) {
    console.log(d.track_id, d.class_name);   // 같은 물체는 같은 번호
  }
}
```

**상태를 들고 있으므로 영상 하나에 하나씩** 씁니다. 다른 영상을 시작하려면 새로 만들거나
`reset()`을 부르세요.

`track_id`가 `null`로 남는 탐지가 있습니다. 방금 나타나 아직 확정 안 됐거나, 어느 트랙에도
안 붙은 것들입니다. **한 프레임만 나타난 오탐에 번호를 주지 않으려는** 것이라 정상입니다.

**`confirm_immediately`로 첫 탐지부터 ID를 붙일 수 있습니다.**

```ts
const T = new Tracker({ confirm_immediately: true });
```

기본은 꺼짐이고, 그때는 새 트랙이 **다음 프레임에서 한 번 더 맞아야** ID가 보입니다.

**프레임이 느리면 그 규칙이 역효과입니다.** 초당 6장이면 간격이 170ms라 그 사이 물체나
카메라가 움직이면 IoU가 안 겹쳐 매칭이 실패합니다 — **몇 번을 잡혀도 ID가 영영 안
붙습니다.** 실시간 시연처럼 보이는 것이 중요하면 켜세요.

**켜면 기준값과 답이 갈립니다.**

`track_buffer`(기본 30)는 놓친 트랙을 몇 **프레임** 들고 있을지입니다. **초가 아닙니다** —
프레임을 건너뛰면 같은 버퍼가 더 긴 실제 시간을 뜻하게 됩니다.

### 흔들림 보정

카메라가 흔들리면 물체가 가만히 있어도 화면에서는 움직입니다. 그걸 안 빼주면 트랙이
끊깁니다 — 흔들림을 합성해 재보니 **트랙이 14개에서 45개로 늘었습니다.**

**양쪽 다 있습니다.** 쓰는 법은 같고, 가져오는 곳만 다릅니다.

```ts
// 브라우저
import { Tracker, createGmc } from 'nrh-detector/web';
const T = new Tracker({}, createGmc());
const r = T.update(result, video);   // detect()에 넣는 것과 같은 것을 주면 됩니다

// React Native
import { Tracker, createGmc } from 'nrh-detector/native';
const T = new Tracker({}, createGmc());
const r = T.update(result, mat);
```

**두 번째 인자로 프레임을 줘야 보정이 돕니다.** 안 주면 보정 없이 추적만 돌아갑니다 —
멈추지는 않고 카메라가 흔들릴 때 ID가 더 자주 끊깁니다.

**기본 축소는 1/4입니다.** 재보고 정한 값입니다 — 태블릿에서 1/2이면 203ms, 1/4면
74ms인데 **추적 품질은 같습니다**(트랙 14개 대 15개).

**1/8까지 내리지 마세요.** 제일 빨라 보이지만 **짝이 안 남아 보정이 죽습니다.**
시간만 보고 고르면 죽은 줄 모르고 넘어갑니다.

비용은 이렇습니다.

| | 프레임 | 한 프레임 |
|---|---|---|
| 브라우저 (Chrome, Ryzen 7 7800X3D) | 1280×720 | 45ms |
| Galaxy Z Flip 5 | 1280×720 | 27ms |
| Galaxy Tab S6 Lite | 1280×720 | 74ms |

**브라우저는 opencv를 안 씁니다.** 웹용 opencv 패키지가 13MB인데 — 모델의 4배입니다 —
`sparseOptFlow`를 직접 짜 넣었습니다. 원본과 같은 알고리즘입니다(Shi-Tomasi 코너 →
Lucas-Kanade 광류 → RANSAC 아핀). 정한 아핀으로 비튼 사진을 되돌려 재보니 **오차
0.06픽셀**이었고, 손에 들고 찍은 실제 보행 영상에서는 opencv 와 **흔들림의 13%**
안에서 맞았습니다.

**프레임을 건너뛸수록 값을 합니다.** 실제 영상에서 잰 것입니다 — 같은 탐지를 넣고 보정만
켜고 껐습니다.

| 초당 넣은 프레임 | 프레임 간 흔들림 | 트랙 개수 (끔 → 켬) | 평균 트랙 길이 |
|---|---|---|---|
| 58.8장 (원본 그대로) | 7.8px | 13 → 14 | 62.0 → 57.6 |
| **9.8장** (앱의 실제 속도) | 17.1px | **35 → 14** | **15.3 → 41.4** |

원본 fps 그대로면 프레임 간 흔들림이 작아 추적기가 보정 없이도 따라갑니다. **초당 10장쯤
넣는 실제 조건에서 트랙이 2.5배 덜 쪼개집니다.**

`createGmc()`에 넘길 수 있는 값들입니다. 기본값은 재보고 정한 것이라 그대로 두셔도 됩니다.

| 이름 | 기본 | 뜻 |
|---|---|---|
| `downscale` | `4` | 몇 분의 1로 줄여서 볼지 |
| `maxCorners` | `500` | 잡을 코너 수 상한 |
| `winSize` | `15` | 광류가 보는 창 한 변 |
| `maxLevel` | `3` | 피라미드 층 수 — 클수록 큰 흔들림을 잡습니다 |

원본 BoT-SORT 는 `maxCorners` 1000, `winSize` 21 입니다. 320×240에서 재보니 그 값이 160ms,
여기 기본값이 38ms인데 **정답과의 오차는 둘 다 0.05픽셀 아래로 같았습니다.**

---

## 클래스 맵

```ts
det.classNames.get(2);        // 'car'
[...det.classNames.values()]; // 전체 목록
```

**목록을 코드에 직접 적지 마세요.** 모델에 딸린 것이라 모델을 바꾸면 달라집니다.

**이름에 공백이 든 것이 있습니다** (`traffic light`, `fire hydrant`, `potted plant`).
이름을 객체 키나 파일명으로 쓰려면 걸립니다.

```ts
const withSpace = [...det.classNames.values()].filter((n) => n.includes(' '));
```

### 입력 크기도 모델에서 읽습니다

**640을 코드에 고정해 두지 않았습니다.** 480으로 재학습한 모델을 넣어도 그대로 돕니다 —
고정해 뒀으면 레터박스를 640으로 해서 보내고 ORT가 모양이 안 맞는다고 오류를 냈을 겁니다.

찾는 순서는 이렇습니다.

1. **그래프에 적힌 입력 shape** — 모델이 실제로 받는 크기라 가장 믿을 만합니다
2. `imgsz` 메타데이터 — export할 때 적힌 값입니다
3. 640

**정사각이 아니면 예외를 냅니다** — 레터박스가 정사각을 전제로 짜여 있어서, 조용히
넘기면 좌표가 어긋난 채로 돕니다.

### 왜 모델 파일을 직접 읽나

`onnxruntime-web`도 `onnxruntime-react-native`도 **모델의 `metadata_props`를 노출하지
않습니다.** 세션 객체를 다 뒤져봐도 (`metadata`, `modelMetadata`, `metadataProps`,
`customMetadata`) 없습니다. 파이썬 onnxruntime에는 있는데 JS 공통 계층에 안 올라와
있습니다.

그래서 `.onnx` 바이트에서 필요한 부분만 직접 읽습니다. 3.5MB 파일에서 **1.1ms** 걸립니다.

**`names` 값은 JSON이 아닙니다.** 파이썬 dict를 문자열로 찍은 형태라 키에 따옴표가 없고
값이 홑따옴표입니다.

```
{0: 'micromobility', 1: 'bus', 2: 'car', ...}
```

`JSON.parse`는 첫 글자에서 죽습니다. `eval`이나 `new Function`도 쓰지 않았습니다 — 그러면
**모델 파일이 코드 실행 경로가 됩니다.**

---

## 이름 규칙

**이름은 전부 영어이고, 주석과 문서는 한글입니다.** 출력 JSON 필드는
`snake_case`(`class_name`, `track_id`, `received_at`)를 씁니다.

| 무엇 | 이름 |
|---|---|
| 탐지기 | `Detector.open()`, `det.detect()`, `det.classNames`, `det.close()` |
| 추적기 | `new Tracker()`, `T.update()`, `T.reset()` |
| 흔들림 보정 | `createGmc()` |
| 직렬화 | `serializeResult()` |
| 계산 | `letterbox()`, `postprocess()`, `bankersRound()`, `readClassMap()` |

---

## 기준 구현과의 대조

이 모듈은 처음부터 만든 것이 아니라 **먼저 만들어 둔 기준 구현을 옮긴 것**입니다.
기준 구현 자체는 배포하지 않지만, **그것이 낸 답을 `test/fixtures/` 에 굳혀 두었습니다.**
받자마자 `npm test` 로 대조해 볼 수 있습니다.

**patch만 다른 것은 출력이 같다는 뜻입니다.** 출력이 달라지는 수정은 버그 수정이라도
minor를 올립니다.

### 정말 같은 답이 나오나

`npm test`가 그것을 봅니다.

| 무엇 | 어떻게 |
|---|---|
| 반올림 | 파이썬 `round`/`rint`와 같은 값 16개 |
| 레터박스 스케일·패딩 | 11가지 원본 크기 |
| 후처리 | 합성 텐서, 세 가지 크기, **탐지 582개 전부** |
| 끝까지 | 진짜 모델, **9개가 좌표까지 정확히** |
| 추적 | 60프레임 영상, **track_id 번호까지 전부** |

### 완전히 같지는 않은 한 가지

**축소 알고리즘이 대상마다 다릅니다.**

| | 무엇으로 |
|---|---|
| 기준값 | opencv `INTER_AREA` |
| 브라우저 | canvas — **규격에 정해져 있지 않아 브라우저마다 다릅니다** |
| React Native | opencv `INTER_AREA` |

같은 사진이라도 줄인 픽셀이 조금 달라서 **탐지가 몇 개 갈릴 수 있습니다.** 좌표 계산은
공용이라 **박스가 밀리지는 않습니다.**

그래서 결과의 `settings.resize`에 무엇을 썼는지 실립니다.

---

## 돌려볼 수 있는 데모

**데모는 배포 파일에도 들어 있습니다.** 설치만 해도 모듈이 실제로 도는지 볼 수 있습니다.

`model.onnx` 를 **서버를 켜는 폴더에** 두고(없으면 어디에 둘지 알려줍니다) 켜세요.

```sh
node node_modules/nrh-detector/demo/server.mjs   # 설치해서 쓰는 경우
node demo/server.mjs                             # 저장소를 받아 빌드한 경우
```

모델을 다른 곳에 두었으면 `NRH_MODEL` 로 알려주면 됩니다.

| 주소 | 무엇 |
|---|---|
| `localhost:8765/live.html` | **실시간 탐지.** 웹캠이나 영상 파일을 넣고 박스·추적 번호를 봅니다 |
| `localhost:8765/` | 한 장으로 속도를 잽니다. 기준값 대조는 저장소를 받아야 뜹니다 |
| `localhost:8765/map.html` | 검증셋으로 브라우저 mAP를 잽니다 (이미지 폴더가 있어야 합니다) |

`live.html`은 주소로 설정을 줄 수 있습니다: `?video=/videos/내영상.mp4&fit=0&gmc=0&instant=1`

**샘플 영상은 안 들어 있습니다.** 「내 영상 열기」로 파일을 고르거나 웹캠을 쓰세요.
`demo/clips/` 에 mp4 를 두면 목록에 뜹니다 — 만드는 법이 `demo/server.mjs` 주석에 있습니다.

**웹캠은 `https://` 또는 `localhost`에서만 됩니다.** 브라우저 규칙입니다.

---

## 아직 없는 것

- **영상 파일 처리.** 영상을 통째로 넣는 함수가 없습니다. 프레임을 뽑아 한 장씩
  넣는 것은 됩니다.
- **그리기 도우미.** 박스를 화면에 그리는 코드는 앱 쪽에서 짜야 합니다.
  `demo/live.html`이 canvas로 그리는 예입니다 — 베껴 쓰시면 됩니다.

---

## 빠르게, 그리고 제대로 돌리기

**전부 재보고 적은 것입니다.**

### 브라우저와 React Native 둘 다

**int8 모델을 쓰세요.** float32보다 2배 이상 빠르고 12.3MB 가 3.5MB 가 되는데 **정확도는
그대로**입니다 (F1 0.777 → 0.778).

**세션을 한 번만 여세요.** `Detector.open()`은 모델을 받아 파싱하므로 비쌉니다. 열어두고
`detect()`만 반복하세요 — 컴포넌트가 리렌더될 때마다 부르면 안 됩니다.

**`detect()`를 매 프레임 부르지 마세요.** 이전 호출이 안 끝났는데 또 부르면 큐가 쌓입니다.
한 장 끝나면 다음 장을 넣는 식으로 돌리세요.

**흔들림 보정은 필요할 때만 켜세요.** 고정된 카메라면 `Tracker`에 `createGmc()`를
넘기지 마세요. 붙는 비용은 위 **흔들림 보정** 절의 표에 있습니다.

### 브라우저

**`webgpu`를 쓰지 마세요.** 예외 없이 **탐지 7,999개짜리 쓰레기**를 냅니다 — 전부
`micromobility`에 `y1=y2=0`입니다. 느리기까지 합니다(1,435ms). 기본값 `['wasm']`을 쓰세요.

**`COOP`/`COEP`를 붙이지 마세요.** 멀티스레드가 효과 0입니다 — 스레드 16개짜리 컴퓨터에서
1스레드 179ms, 4스레드 180ms로 같습니다. int8 QDQ 모델이라 연산이 잘게 쪼개져 있어 나누는
이득보다 맞추는 비용이 큽니다. 헤더를 붙이면 외부 이미지·스크립트만 막힙니다.

**정적 파일에 캐시를 걸어두세요.** ORT의 wasm이 25.6MB, 모델이 3.5MB입니다.
`Cache-Control: no-store`로 두면 방문자가 열 때마다 30MB를 받고, 그동안 카메라·영상 요청이
뒤로 밀려 **아무 오류 없이 안 도는 것처럼 보입니다.**

**탐지와 화면 갱신을 분리하세요.** `<video>`는 브라우저가 60fps로 재생하게 두고, 탐지는 한
장이 끝날 때마다 다음 장을 집습니다. `requestAnimationFrame`으로 걸면 프레임이 밀립니다.

**웹은 원래 느립니다.** Chrome(Ryzen 7 7800X3D)에서 프레임당 168ms — 초당 6.0장입니다.
같은 모델이 데스크톱 네이티브에서 16ms이니 **WASM 벌금이 10배**입니다.

### React Native

**기기를 식히세요.** 같은 폰에서 식었을 때 추론 95ms, 뜨거울 때 250ms로 **2~3배**
벌어집니다. **다른 어떤 최적화보다 큽니다.** 충전 케이블을 빼고 화면 밝기를 낮추세요.

**`nnapi`와 `xnnpack`을 켜지 마세요.** 빨라 보이지만 느립니다.

| | Galaxy Tab S6 Lite (2020) | Galaxy Z Flip 5 (2023) |
|---|---|---|
| `cpu` | 기준 | 기준 |
| `xnnpack` | 2.4배 느림 | 2.5배 느림 |
| `nnapi` | 2.7배 느림 | 2.8배 느림 |

3년 차이 나는 기기에서 배수가 거의 같습니다 — 드라이버 품질 문제가 아닙니다.

**캡처를 640에 4:3으로 맞추세요.** 모델 입력이 640×640이라 642×482로 찍으면 줄일 일이
거의 없습니다. 폰 가로 화면(2.47:1)을 정사각에 넣으면 41%만 정보이고 나머지는 회색
여백인데 계산은 다 합니다 — 4:3이면 75%를 씁니다.

**다음 프레임을 미리 찍으세요.** 카메라에서 한 장 받는 데 50~150ms가 드는데, 그동안 JS는
추론을 기다리며 놉니다. 겹쳐 걸면 그 시간이 사라집니다.

**프레임당 비용은 추론만이 아닙니다.** 플립5에서 추론이 36ms인데 전체는 75ms입니다 —
전처리 9ms, 후처리 3ms, 흔들림 보정 27ms 가 더 붙습니다.

---

## 학습 데이터 출처

> **이 결과물은 AI 허브의 「인도보행 영상」 데이터셋을 활용하였습니다.**

번들 모델은 이 데이터로 학습했습니다. **AI Hub가 2차 저작물 활용의 조건으로 출처
표기를 요구합니다** — 이 문구를 지우지 마세요.

**원본 이미지·라벨은 이 저장소에 없습니다.** 넣으면 안 됩니다. 자세한 것은
`NOTICE.md`의 「학습 데이터」 절에 있습니다.

---

## 직접 빌드하고 시험하기

```bash
npm install
npm run build      # TypeScript → dist/
npm test
npm pack           # → nrh-detector-0.10.1.tgz (배포 파일)
```

**모델을 저장소 최상위에 `model.onnx`로 두면** 테스트가 전부 돕니다. 없으면 모델이
필요한 것만 건너뜁니다 — `skipped`가 0인지 보세요.

**`npm pack` 은 빌드를 하지 않습니다.** `dist/` 를 그대로 묶기만 하므로 **반드시
`npm run build` 를 먼저 하세요.** 안 그러면 낡은 `dist/` 가 그대로 나갑니다.

만들어진 `.tgz` 는 `.gitignore` 로 막혀 있어 저장소에는 안 올라갑니다.

---

## 라이선스

**AGPL-3.0-only** 입니다. 추적기(BoT-SORT)와 모델을 Ultralytics 에서 가져왔고 그것이
AGPL-3.0 이라 고를 수 있는 것이 아니었습니다. 전문은 `LICENSE`, 가져온 코드의 출처는
`NOTICE.md` 에 있습니다.

Copyright (C) 2026 J4VIS
