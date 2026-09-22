/**
 * bundle.mjs —— 把整个演示站打成「单文件 HTML」，双击即开
 *
 * 为什么需要它：
 *   项目本体是 ES Module + fetch 的形态，浏览器不允许拿 file:// 直接跑
 *   （module 脚本受 CORS 限制、fetch 读不了本地文件），所以原来必须
 *   `node tools/serve.mjs` 起服务。这里把所有模块扁平化内联进一个
 *   <script>（普通脚本，非 module），把权重 JSON 和精灵图一并塞进页面，
 *   于是单文件在 file:// 下也能完整运行。
 *
 * 用法：node tools/bundle.mjs [输出路径]
 *   默认输出 dist/laya-t-rex-runner.html
 *
 * 打包策略（保持源码零改动，全部在构建期做）：
 *   1. 按拓扑序拼接模块，剥掉 import / export，让它们共处同一作用域；
 *   2. brain/weights*.json  → 内联成 JS 字面量，喂给重写后的 loadWeights()；
 *   3. assets/*.png        → data URI，替换 renderer.js 里的两个路径常量；
 *   4. bench.worker.js     → 内联成 Blob Worker；file:// 下若被拦，自动降级为主线程执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.resolve(ROOT, process.argv[2] || 'dist/laya-t-rex-runner.html');

/** 主线程依赖序（保证每个模块出现时，它 import 的东西都已定义） */
const MAIN_ORDER = [
  'core/constants.js',
  'core/rng.js',
  'core/collision.js',
  'core/world.js',
  'core/renderer.js',
  'laya/features.js',
  'laya/nn.js',
  'laya/heads.js',
  'laya/typed-decision.js',
  'brains.js',
  'autopilot.js',
  'bench.js',
  'ui.js',
];

/** Worker 侧依赖序：不需要渲染器和 UI */
const WORKER_ORDER = [
  'core/constants.js',
  'core/rng.js',
  'core/collision.js',
  'core/world.js',
  'laya/features.js',
  'laya/nn.js',
  'laya/heads.js',
  'laya/typed-decision.js',
  'brains.js',
  'autopilot.js',
  'bench.js',
];

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** 剥掉 ESM 语法，留下可直接拼接的语句 */
function flatten(rel) {
  let src = read(rel);
  // import ... from '...';  —— 含跨行形式
  src = src.replace(/^[ \t]*import[\s\S]*?from[ \t]*['"][^'"]+['"][ \t]*;?[ \t]*$/gm, '');
  // export { a, b };  —— 纯再导出，符号在别处已定义
  src = src.replace(/^[ \t]*export[ \t]*\{[^}]*\}[ \t]*;?[ \t]*$/gm, '');
  // export const/function/class ...  —— 只摘掉关键字
  src = src.replace(/^([ \t]*)export[ \t]+(?=(?:async[ \t]+)?(?:const|let|var|function|class)\b)/gm, '$1');
  return src.trim();
}

/**
 * clamp 在 features.js 与 heads.js 各定义了一份。
 * 两者源码逐字符相同才允许去重，否则直接报错——避免悄悄改变语义。
 */
function dedupeClamp(modules, quiet) {
  const re = /^const clamp = \(v, lo, hi\) => \(v < lo \? lo : v > hi \? hi : v\);$/m;
  const hits = modules.filter((m) => re.test(m.code));
  if (hits.length < 2) return modules;
  const defs = new Set(hits.map((m) => re.exec(m.code)[0]));
  if (defs.size !== 1) {
    throw new Error('clamp 在多个模块中定义且实现不一致，需人工确认后再打包');
  }
  const keep = hits[0];
  if (!quiet) {
    console.log(`  · 去重 clamp：保留 ${keep.rel}，移除 ${hits.slice(1).map((h) => h.rel).join(', ')}`);
  }
  // 只删多余的，保留第一份定义——按引用比对，不能用下标（源码顺序 ≠ 定义顺序）
  return modules.map((m) =>
    m === keep ? m : { ...m, code: m.code.replace(re, `/* clamp 已由 ${keep.rel} 提供 */`) },
  );
}

function buildModules(order, quiet) {
  const mods = order.map((rel) => ({ rel, code: flatten(rel) }));
  return dedupeClamp(mods, quiet);
}

const banner = (label) =>
  `\n/* ==================== ${label} ==================== */\n`;

// ---------------------------------------------------------------- 主 bundle
const mainCode = buildModules(MAIN_ORDER)
  .map((m) => banner(m.rel) + m.code + '\n')
  .join('');

// ---------------------------------------------------------------- 数据内联
const weights = {
  0: JSON.parse(fs.readFileSync(path.join(ROOT, 'brain/weights.json'), 'utf8')),
  8: JSON.parse(fs.readFileSync(path.join(ROOT, 'brain/weights-delay8.json'), 'utf8')),
};
// JSON 里不会出现 </script>，但仍做一次转义兜底
const weightsLiteral = JSON.stringify(weights).replace(/<\//g, '<\\/');

const b64 = (p) => fs.readFileSync(path.join(ROOT, p)).toString('base64');
const SPRITE_1X = `data:image/png;base64,${b64('assets/offline-sprite-1x.png')}`;
const SPRITE_2X = `data:image/png;base64,${b64('assets/offline-sprite-2x.png')}`;

// ------------------------------------------------------------- Worker 代码
/** 评测载荷的执行体，主线程降级路径与 Worker 共用 */
const BENCH_RUNNER = `
function __layaTRexRunBench(data, post) {
  const weightsFor = (brainId, delay) => {
    if (!brainId.includes('neural')) return undefined;
    return data.weights[delay] || data.weights[0] || undefined;
  };
  try {
    const rows = benchmark({
      brainIds: data.brainIds,
      delays: data.delays,
      episodes: data.episodes,
      maxTicks: data.maxTicks,
      seedBase: data.seedBase,
      weights: weightsFor,
      onProgress: ({ brainId, delay, i, episodes: eps }) => post({ type: 'progress', brainId, delay, i, episodes: eps }),
    });
    post({
      type: 'done',
      rows: rows.map((r) => ({
        brain: r.brainId, delay: r.delay, mean: r.scoreMean, median: r.scoreMedian,
        min: r.scoreMin, max: r.scoreMax, crash: r.crashRate, capped: r.cappedRate,
        reasonRatio: r.reasonRatio, avgMs: r.latencyAvgMs,
      })),
    });
  } catch (err) {
    post({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
}
`;

const workerCode =
  buildModules(WORKER_ORDER, true)
    .map((m) => banner(m.rel) + m.code + '\n')
    .join('') +
  banner('bench runner + worker bootstrap') +
  BENCH_RUNNER +
  '\nself.onmessage = (e) => __layaTRexRunBench(e.data, (m) => self.postMessage(m));\n';

if (/<\/script/i.test(workerCode)) throw new Error('Worker 代码里出现了 </script，需要转义');

// ---------------------------------------------------------------- 宿主改造
// 宿主代码：在主 bundle 副本上做定点改写（src/ 源码本身保持零改动）
let host = mainCode;

// 1) 权重：改为读内联数据，保留 fetch 作为回退（万一被单独拿去用）
const OLD_LOAD = /async function loadWeights\(\)\s*\{[\s\S]*?\n\}/;
if (!OLD_LOAD.test(host)) throw new Error('未找到 loadWeights()，源码结构可能已变化');
host = host.replace(
  OLD_LOAD,
  `async function loadWeights() {
  const inline = typeof __layaTRexWeights !== 'undefined' ? __layaTRexWeights : null;
  if (inline) {
    for (const k of Object.keys(inline)) state.weights[Number(k)] = inline[k];
    document.body.dataset.weights = Object.keys(state.weights).join(',') || 'none';
    return;
  }
  const files = ['brain/weights.json', 'brain/weights-delay8.json'];
  for (const f of files) {
    try {
      const r = await fetch(f, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      const delay = /delay(\\d+)/.exec(f) ? Number(/delay(\\d+)/.exec(f)[1]) : 0;
      state.weights[delay] = j;
    } catch (e) {
      console.warn('[layatrex] 未能加载 ' + f);
    }
  }
  document.body.dataset.weights = Object.keys(state.weights).join(',') || 'none';
}`,
);

// 2) 精灵图：路径常量换成 data URI
for (const [name, uri] of [['SPRITE_1X', SPRITE_1X], ['SPRITE_2X', SPRITE_2X]]) {
  const re = new RegExp(`const ${name} = '[^']*';`);
  if (!re.test(host)) throw new Error(`未找到 ${name} 常量`);
  host = host.replace(re, `const ${name} = '${uri}';`);
}

// 3) Worker：改为从内联 <script> 造 Blob；file:// 下若被拦则退回主线程
const OLD_WORKER = `new Worker('src/bench.worker.js', { type: 'module' })`;
if (!host.includes(OLD_WORKER)) throw new Error('未找到 Worker 创建语句');
host = host.replace(OLD_WORKER, 'makeBenchWorker()');

const WORKER_FACTORY = `
// —— 单文件模式：从内联 <script> 造 Worker；file:// 下若被策略拦截，降级为主线程执行 ——
function makeBenchWorker() {
  const el = document.getElementById('layatrex-bench-worker');
  if (el && typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
    try {
      const blob = new Blob([el.textContent], { type: 'text/javascript' });
      return new Worker(URL.createObjectURL(blob));
    } catch (e) {
      console.warn('[layatrex] Blob Worker 不可用，改在主线程跑基准测试', e);
    }
  }
  const w = { onmessage: null, onerror: null };
  w.postMessage = (data) =>
    setTimeout(() => {
      __layaTRexRunBench(data, (m) => {
        if (typeof w.onmessage === 'function') w.onmessage({ data: m });
      });
    }, 0);
  w.terminate = () => {};
  return w;
}
`;

// ---------------------------------------------------------------- 组装页面
const tpl = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SCRIPT_TAG = '<script type="module" src="src/ui.js"></script>';
if (!tpl.includes(SCRIPT_TAG)) throw new Error('index.html 里未找到入口 script 标签');

const inlineScript = [
  banner('内联权重（由 brain/weights*.json 生成）'),
  `const __layaTRexWeights = ${weightsLiteral};`,
  '\n',
  WORKER_FACTORY,
  BENCH_RUNNER,
  banner('应用代码（src/ 扁平化内联）'),
  host,
].join('\n');

const html = tpl.replace(
  SCRIPT_TAG,
  `<script type="text/plain" id="layatrex-bench-worker">${workerCode}</script>\n` +
    `<script>\n${inlineScript}\n</script>`,
);

// ---------------------------------------------------------------- 落盘 + 自检
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');

const problems = [];
if (/<\/script/i.test(host)) problems.push('主脚本中出现 </script');
if (/^\s*(import|export)\s/m.test(mainCode)) problems.push('主 bundle 残留 import/export');
if (/src="src\//.test(html)) problems.push('仍有 src/ 外链');
if (/assets\/offline-sprite/.test(html)) problems.push('精灵图未内联');

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('\n打包完成');
console.log('  输出      ' + path.relative(ROOT, OUT));
console.log('  总体积    ' + kb(Buffer.byteLength(html)));
console.log('  主脚本    ' + kb(Buffer.byteLength(inlineScript)));
console.log('  Worker    ' + kb(Buffer.byteLength(workerCode)));
console.log('  权重      ' + kb(Buffer.byteLength(weightsLiteral)));
console.log('  精灵图    ' + kb(Buffer.byteLength(SPRITE_1X) + Buffer.byteLength(SPRITE_2X)));
console.log('  外部请求  0（全部内联）');
if (problems.length) {
  console.error('\n自检未通过：');
  problems.forEach((p) => console.error('  ! ' + p));
  process.exit(1);
}
console.log('  自检     通过：无残留 ESM 语法 / 无外链资源');
