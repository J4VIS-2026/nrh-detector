/**
 * 데모 페이지를 띄우는 작은 서버.
 *
 * **`file://` 로 열면 안 되기 때문에 있는 서버다.** 모듈·wasm·영상 요청이 브라우저에
 * 막힌다.
 *
 * `COOP`/`COEP` 헤더도 붙이지만 **속도 때문은 아니다** - 재보니 1스레드 179ms,
 * 4스레드 180ms 로 같았다. `SharedArrayBuffer` 를 쓰는 경로를 시험해 보려고 켜 둔다.
 *
 * 결과는 페이지가 `POST /result`로 보내고 여기서 찍는다. 브라우저 콘솔을 사람이
 * 들여다볼 필요가 없게 하려는 것이다.
 *
 *     node demo/server.mjs
 *     → http://localhost:8765
 */

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(import.meta.url), '..');
const root = resolve(here, '..');

/**
 * **이 파일은 두 자리에서 돈다.**
 *
 * 1. 이 저장소 안 (`demo/`) — 같은 최상위에 `node_modules`가 있다
 * 2. 설치된 패키지 안 (`node_modules/nrh-detector/demo/`) — 둘 다 없다
 *
 * 2번에서도 돌게 하려고 아래 셋은 여러 자리를 차례로 확인한다. 못 찾으면 그 항목만 안 뜨고
 * 나머지는 그대로 돈다.
 */
const firstThatExists = (...paths) => paths.find((p) => p && existsSync(p));

/** `onnxruntime-web`. 평평하게 깔리면 `node_modules/onnxruntime-web`에 놓인다. */
const ortDist = firstThatExists(
  join(root, 'node_modules', 'onnxruntime-web', 'dist'),
  resolve(root, '..', 'onnxruntime-web', 'dist'),          // 평평한 node_modules
  resolve(root, '..', '..', 'node_modules', 'onnxruntime-web', 'dist'),
);

/**
 * 모델을 어디서 찾나. **위에서부터 차례로 보고 처음 있는 것을 쓴다.**
 *
 * | 순서 | 어디 | 누가 여기 두나 |
 * |---|---|---|
 * | 1 | `NRH_MODEL`이 가리키는 파일 | 다른 데 둔 사람 |
 * | 2 | **`node`를 실행한 경로** (`process.cwd()`) | **받는 사람 — 여기가 기본이다** |
 * | 3 | **저장소 최상위** (`model.onnx`) | **이 저장소에서 개발할 때** |
 * | 4 | 이 파일과 같은 위치 (`demo/model.onnx`) | 데모 폴더째 옮겨 쓰는 사람 |
 * | 5 | 패키지와 같은 위치 (`node_modules/model.onnx`) | 위와 같음 |
 *
 * **2번은 이 파일이 있는 경로가 아니라 `node`를 실행한 경로다.** 둘은 다를 수 있다.
 *
 *     cd C:\myproject
 *     node node_modules/nrh-detector/demo/server.mjs
 *     → C:\myproject\model.onnx 를 찾는다 (server.mjs 가 있는 곳이 아니다)
 *
 * 다른 경로에서 실행하면 거기를 본다 - 헷갈리기 쉬운 자리다. 그럴 때는 `NRH_MODEL`로
 * 직접 가리키는 편이 낫다.
 *
 * **모델은 저장소에 없다.** 3번 자리(저장소 최상위)에 `model.onnx`를 두면 개발 중에는
 * 아무것도 안 해도 그대로 돈다. 테스트도 같은 자리를 본다.
 *
 * **못 찾으면 `/model.onnx`만 404가 나고 나머지는 그대로 돈다.**
 */
const modelFile = firstThatExists(
  process.env.NRH_MODEL,
  join(process.cwd(), 'model.onnx'),
  join(root, 'model.onnx'),
  join(here, 'model.onnx'),
  resolve(root, '..', 'model.onnx'),
);
if (!modelFile) {
  console.warn('model.onnx 를 못 찾았다. 서버를 켠 폴더에 두거나 NRH_MODEL 로 가리켜라.');
}

const PORT = 8765;

/**
 * 검증셋 이미지가 있는 곳. **브라우저에서 mAP를 재려면 필요하다** - 없으면 `/map.html`만
 * 안 돌고 나머지는 그대로 돈다.
 *
 * **경로를 코드에 적지 않는다.** 만든 사람 PC의 구조가 공개 저장소에 남는다.
 * AI Hub 데이터는 사람마다 다른 곳에 있으므로 환경변수로만 받는다.
 */
const valImages = process.env.NRH_VAL_IMAGES;

/** URL 앞부분 → 실제 폴더. */
const MOUNTS = [
  ['/dist/', join(root, 'dist')],
  ['/ort/', ortDist],
  ['/fixtures/', join(root, 'test', 'fixtures')],
  // **데모가 쓰는 샘플 사진.** 직접 찍은 것이라 저장소에 들어 있다.
  // 다른 사진을 쓰려면 `NRH_SAMPLES` 로 폴더를 가리킨다
  ['/samples/', process.env.NRH_SAMPLES ?? join(here, 'samples')],
  ['/val/', valImages],
  /*
   * **데모 클립.** `sidewalk-640.mp4` 하나가 저장소에 들어 있다 (360×640, 20초, 2.2MB).
   * 나머지는 여기 넣어도 되지만 저장소에는 안 들어간다(`.gitignore`).
   *
   * 이렇게 만든다:
   *
   *     ffmpeg -ss 30 -t 20 -i <원본.mp4> \
   *            -c:v libx264 -preset veryfast -crf 26 -an -movflags +faststart \
   *            demo/clips/sidewalk-640.mp4
   *
   * **`+faststart`가 중요하다** - 폰이 찍은 mp4는 색인이 파일 끝에 있어서, 그대로 두면
   * 브라우저가 끝까지 받아야 재생을 시작한다.
   *
   * **`-c copy`로 자르지 마라.** 빠르지만 비트레이트가 그대로라 20초가 10~14MB가 된다.
   * 다시 인코딩하면 같은 화질에 1.7MB다.
   */
  ['/clips/', join(here, 'clips')],
  // 640으로 줄여둔 영상. 원본은 100~700MB라 브라우저에 부담이 된다
  ['/small/', process.env.NRH_VIDEOS_SMALL],
  // 원본 영상 폴더. 없으면 그 항목만 안 뜨고 나머지는 그대로 돈다
  ['/videos/', process.env.NRH_VIDEOS],
  ['/', here],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

function resolvePath(url) {
  const urlPath = decodeURIComponent(url.split('?')[0]);
  // **모델은 파일 하나라 따로 잡는다.** 폴더가 아니라서 mount로는 안 걸린다
  if (urlPath === '/model.onnx' && modelFile) return modelFile;
  for (const [prefix, dir] of MOUNTS) {
    // 못 찾은 자리는 건너뛴다 - 설치된 패키지 안에서는 없는 것이 정상이다
    if (!dir || !urlPath.startsWith(prefix)) continue;
    const rest = urlPath.slice(prefix.length) || 'index.html';
    // `..`로 밖으로 나가는 것을 막는다. **폴더도 resolve를 거쳐야 한다** - 윈도우에서
    // `G:/a/b`와 `G:\a\b`는 문자열로 다르다. 안 맞추면 멀쩡한 파일이 404가 된다
    const rootDir = resolve(dir);
    const candidate = resolve(rootDir, rest);
    if (!candidate.startsWith(rootDir)) return null;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const server = createServer(async (req, res) => {
  // **무엇을 요청했는지 남긴다.** 브라우저가 조용히 멈출 때 여기가 유일한 단서다
  if (process.env.NRH_LOG) {
    console.log(`${req.method} ${decodeURIComponent((req.url ?? '').slice(0, 80))}` +
                `${req.headers.range ? '  ' + req.headers.range : ''}`);
  }
  // **결과 받기**
  if (req.method === 'POST' && req.url === '/result') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf-8');
    console.log('\n===== 브라우저 결과 =====');
    try {
      const j = JSON.parse(text);
      for (const line of j.lines ?? []) console.log(line);
      await writeFile(join(root, 'out', 'web-result.json'), JSON.stringify(j, null, 1));
      console.log('\n(out/web-result.json 에 저장)');
    } catch {
      console.log(text);
    }
    res.writeHead(204, headers());
    res.end();
    return;
  }

  // **그림 받기.** 헤드리스 스크린샷이 너무 일찍 찍혀서, 페이지가 다 그린 뒤에
  // 직접 보내게 했다
  if (req.method === 'POST' && req.url === '/image') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = Buffer.concat(chunks).toString('utf-8');
    const b64 = url.slice(url.indexOf(',') + 1);
    const dest = join(root, 'out', 'verify-0.9.0', 'artifacts', 'web-detections.png');
    await writeFile(dest, Buffer.from(b64, 'base64'));
    console.log(`그림 저장: ${dest}`);
    res.writeHead(204, headers());
    res.end();
    return;
  }

  // **재현 가능한 이미지 목록.** 기준선을 잴 때 쓰는 그 목록 그대로다 -
  // 다른 이미지로 재면 두 숫자를 견줄 수 없다
  if (req.method === 'GET' && (req.url ?? '').startsWith('/vallist')) {
    // 목록 파일도 경로를 코드에 적지 않는다. `NRH_VAL_LIST`로 알려준다
    if (!process.env.NRH_VAL_LIST) {
      res.writeHead(404, headers());
      res.end('NRH_VAL_LIST 에 이미지 목록 파일을 가리켜라');
      return;
    }
    const n = Number(new URL(req.url, 'http://x').searchParams.get('n') ?? 500);
    const text = await readFile(process.env.NRH_VAL_LIST, 'utf-8');
    const list = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, n);
    res.writeHead(200, { ...headers(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // 실시간 데모가 고를 수 있게 영상 목록을 준다
  if (req.method === 'GET' && req.url === '/videolist') {
    // 가벼운 것부터 내놓는다. 원본은 뒤에 붙여 고를 수 있게만 해둔다
    const at = (p) => MOUNTS.find(([prefix]) => prefix === p)?.[1];
    const sources = [['/clips/', join(here, 'clips')],
                     ['/small/', at('/small/')],
                     ['/videos/', at('/videos/')]];
    const { readdir } = await import('node:fs/promises');
    const list = [];
    for (const [prefix, dir] of sources) {
      if (!dir) continue;
      try {
        for (const name of await readdir(dir)) {
          if (/\.(mp4|mov|webm|mkv)$/i.test(name)) list.push(prefix + name);
        }
      } catch { /* 그 폴더가 없으면 건너뛴다 */ }
    }
    res.writeHead(200, { ...headers(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // **브라우저가 낸 탐지를 받는다.** 기준값을 낼 때 쓴 채점기가 그대로 읽는다
  if (req.method === 'POST' && req.url === '/detections') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const dest = join(root, 'out', 'web-detections.json');
    await writeFile(dest, body);
    console.log(`탐지 저장: ${dest} (${(body.length / 1048576).toFixed(1)}MB)`);
    res.writeHead(204, headers());
    res.end();
    return;
  }

  const filePath = resolvePath(req.url ?? '/');
  if (!filePath) {
    res.writeHead(404, headers());
    res.end('not found: ' + req.url);
    return;
  }
  const mime = MIME[extname(filePath)] ?? 'application/octet-stream';
  // **html만 저장을 막는다.** 고쳐가며 보는 것이 그것뿐이다
  const cacheable = !mime.startsWith('text/html');

  // **영상은 부분 요청을 받아줘야 한다.** 200MB짜리를 통째로 보내면 브라우저가 다
   // 받을 때까지 재생을 못 시작하고, 앞뒤로 옮기는 것도 안 된다
  const { stat } = await import('node:fs/promises');
  const { createReadStream } = await import('node:fs');
  const size = (await stat(filePath)).size;
  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [a, b] = range.replace('bytes=', '').split('-');
    const start = a === '' ? Math.max(0, size - Number(b)) : Number(a);
    const end = a === '' || b === '' ? size - 1 : Math.min(Number(b), size - 1);
    if (start >= size || start > end) {
      res.writeHead(416, { ...headers(cacheable), 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers(cacheable),
      'Content-Type': mime,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    createReadStream(filePath, { start: start, end: end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers(cacheable), 'Content-Type': mime, 'Accept-Ranges': 'bytes',
                       'Content-Length': size });
  createReadStream(filePath).pipe(res);
});

/**
 * **교차 출처 격리 헤더.** 이 둘이 있어야 `SharedArrayBuffer`가 켜지고 WASM이
 * 여러 스레드를 쓴다.
 */
/**
 * @param cacheable 브라우저가 저장해도 되는 것인가.
 *
 * **`no-store`는 고쳐가며 보는 것에만 붙인다.** 페이지와 결과 응답이 그렇다.
 *
 * 나머지에는 붙이면 안 된다. ORT의 wasm이 **25.6MB**이고 모델이 3.3MB인데, 저장을
 * 금지하면 **페이지를 열 때마다 30MB를 새로 받는다.** 그동안 영상 요청이 뒤로 밀려
 * `readyState`가 0에서 안 올라간다 - 오류도 안 나고 "탐지되다 마는" 것으로 보인다.
 * 미디어는 앞뒤로 조각을 다시 받아가며 버퍼를 쌓아야 해서 더욱 그렇다.
 */
function headers(cacheable = false) {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    // `no-cache`는 "저장하되 쓸 때 확인하라"다. 고친 파일은 바로 반영되면서 큰 것은
    // 다시 안 받는다
    'Cache-Control': cacheable ? 'no-cache' : 'no-store',
  };
}

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}  (COOP/COEP 켜짐 - SharedArrayBuffer 사용 가능)`);
});
