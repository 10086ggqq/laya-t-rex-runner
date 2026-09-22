/**
 * verify-bundle.cjs —— 单文件产物的自检
 *
 * 校验 dist/klrun-trex-runner.html：
 *   1. 结构性：无残留 ESM 语法、无外链资源、精灵图已内联
 *   2. 语法：内联的主脚本与 Worker 脚本都能被解析
 *   3. 行为：把内联 Worker 代码放进 vm 里真跑一遍评测，确认数值有效
 *
 * 用法：node tools/verify-bundle.cjs   （或 npm run verify:bundle）
 */
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILE = process.argv[2] || path.join(ROOT, 'dist/klrun-trex-runner.html');

let failed = 0;
const ok = (label, extra) => console.log('  [通过] ' + label + (extra ? '  ' + extra : ''));
const bad = (label, extra) => {
  console.log('  [失败] ' + label + (extra ? '  ' + extra : ''));
  failed++;
};

if (!fs.existsSync(FILE)) {
  console.error('找不到产物：' + FILE + '\n请先运行 node tools/bundle.mjs');
  process.exit(1);
}
const html = fs.readFileSync(FILE, 'utf8');
console.log('产物：' + path.relative(ROOT, FILE) + '  (' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB)\n');

// ---------------------------------------------------------------- 1. 结构
console.log('结构检查');
/^\s*(import|export)\s/m.test(html) ? bad('残留 ESM 语法') : ok('无残留 import/export');
/src="src\//.test(html) ? bad('仍有 src/ 外链') : ok('无 src/ 外链');
/assets\/offline-sprite/.test(html) ? bad('精灵图未内联') : ok('精灵图已内联为 data URI');
/data:image\/png;base64,/.test(html) ? ok('data URI 存在') : bad('未找到 data URI');

const workerMatch = /<script type="text\/plain" id="klrun-bench-worker">([\s\S]*?)<\/script>/.exec(html);
const mainMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!workerMatch) bad('未找到内联 Worker 脚本');
else ok('内联 Worker 脚本', workerMatch[1].length + ' 字符');
if (!mainMatches.length) bad('未找到内联主脚本');
else ok('内联主脚本', mainMatches[mainMatches.length - 1][1].length + ' 字符');

// ---------------------------------------------------------------- 2. 语法
if (workerMatch && mainMatches.length) {
  console.log('\n语法检查');
  for (const [label, code] of [
    ['Worker 脚本', workerMatch[1]],
    ['主脚本', mainMatches[mainMatches.length - 1][1]],
  ]) {
    try {
      new vm.Script(code, { filename: label });
      ok(label + ' 可解析');
    } catch (e) {
      bad(label + ' 解析失败', e.message);
    }
  }
}

// ---------------------------------------------------------------- 3. 行为
if (workerMatch) {
  console.log('\n行为检查（在 vm 里真跑一次评测）');
  try {
    const messages = [];
    const self = { postMessage: (msg) => messages.push(msg) };
    const ctx = vm.createContext({ self, console, performance: { now: () => Date.now() } });
    vm.runInContext(workerMatch[1], ctx);
    if (typeof self.onmessage !== 'function') throw new Error('Worker 未注册 onmessage');

    const t0 = Date.now();
    self.onmessage({
      data: { brainIds: ['random', 'rule'], delays: [0], episodes: 1, maxTicks: 3000, seedBase: 1000, weights: {} },
    });
    const elapsed = Date.now() - t0;

    const err = messages.find((x) => x.type === 'error');
    const done = messages.find((x) => x.type === 'done');
    if (err) throw new Error(err.message);
    if (!done) throw new Error('没有收到 done 消息');

    ok('评测跑完', elapsed + ' ms，' + done.rows.length + ' 行结果');
    let anyNaN = false;
    for (const r of done.rows) {
      const vals = [r.mean, r.median, r.min, r.max, r.crash, r.reasonRatio, r.avgMs];
      const hasNaN = vals.some((v) => v == null || Number.isNaN(v));
      if (hasNaN) anyNaN = true;
      console.log(
        '         ' + String(r.brain).padEnd(10) + ' mean=' + r.mean +
        '  撞车=' + (r.crash * 100).toFixed(0) + '%' + (hasNaN ? '   <-- 含 NaN' : ''),
      );
    }
    anyNaN ? bad('结果含 NaN/空值') : ok('所有指标数值有效');
  } catch (e) {
    bad('行为检查异常', e.message);
  }
}

console.log('\n' + (failed === 0 ? '全部通过 —— 单文件可直接双击打开运行' : failed + ' 项未通过'));
process.exit(failed === 0 ? 0 : 1);
