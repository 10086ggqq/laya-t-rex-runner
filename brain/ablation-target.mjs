/**
 * ablation-target.mjs —— 消融实验：模仿「动作」还是模仿「价值」？
 *
 * 这是本项目最关键的一次设计取舍，所以单独留一个可复现脚本。
 *
 * 两个目标函数，同一份教师数据、同一个网络、同一套超参：
 *   cls   —— 分类：交叉熵拟合"教师选了哪个动作"（带类别频率加权）
 *   value —— 回归：MSE 拟合"教师给每个动作的存活评分"，策略 = argmax
 *
 * 预期结论：分类的帧准确率高得多，实战却差得多。
 * 原因是"该按跳跃键"往往只有一两帧是正确时机，决策边界极窄；
 * 而"现在跳能活多少帧"在小邻域内是平滑的、可学的。
 *
 * 用法：
 *   node brain/ablation-target.mjs
 *   node brain/ablation-target.mjs --episodes 10 --epochs 30 --hidden 64
 */
import { World } from '../src/core/world.js';
import { Actions } from '../src/core/constants.js';
import { encodeState, FEATURE_DIM } from '../src/laya/features.js';
import { PlannerHead } from '../src/laya/heads.js';
import { MLP } from '../src/laya/nn.js';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const CFG = {
  episodes: Number(arg('episodes', 10)),
  epochs: Number(arg('epochs', 30)),
  hidden: Number(arg('hidden', 64)),
  lr: Number(arg('lr', 4e-3)),
  maxTicks: Number(arg('max-ticks', 4200)),
  keepNone: Number(arg('keep-none', 0.15)),
  seedBase: Number(arg('seed-base', 3000)),
  evalSeeds: Number(arg('eval-seeds', 8)),
  evalTicks: Number(arg('eval-ticks', 20000)),
};
const VALUE_SCALE = 120;

// ------------------------------------------------------------------ 采集一次，两种目标共用
console.log(`采集教师轨迹：${CFG.episodes} 局 × ${CFG.maxTicks} 帧`);
const teacher = new PlannerHead();
const buf = new Float32Array(FEATURE_DIM);
const X = [];
const Yc = [];
const Yv = [];

// 下采样用固定种子的随机流，否则两次运行的结果不可比
let keepSeed = 0x51ed270b;
const keepRnd = () => {
  keepSeed = (keepSeed + 0x6d2b79f5) >>> 0;
  let t = keepSeed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

for (let e = 0; e < CFG.episodes; e++) {
  const w = new World({ seed: CFG.seedBase + e * 13 + 1 });
  while (!w.crashed && w.ticks < CFG.maxTicks) {
    const r = teacher.decide(w);
    const a = r.action;
    // 教师约 54% 的帧都在说"不动"，全留会把数据集淹没；这里保留全部关键帧
    if (a !== 'NONE' || keepRnd() < CFG.keepNone) {
      X.push(Array.from(encodeState(w, buf)));
      Yc.push(Actions.indexOf(a));
      Yv.push(r.values.map((v) => (v == null ? 0 : v) / VALUE_SCALE));
    }
    w.act(a);
    w.step();
  }
}
const hist = {};
for (const y of Yc) hist[Actions[y]] = (hist[Actions[y]] || 0) + 1;
console.log(`样本 ${X.length} 条，标签分布 ${JSON.stringify(hist)}\n`);

const idx = X.map((_, i) => i);
let s = 20260922;
const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
for (let i = idx.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [idx[i], idx[j]] = [idx[j], idx[i]];
}
const nVal = Math.floor(idx.length * 0.08);
const valIdx = idx.slice(0, nVal);
const trainIdx = idx.slice(nVal);

const amax = (p) => {
  let b = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[b]) b = i;
  return b;
};

function classWeights() {
  const hist = [0, 0, 0, 0];
  for (const i of trainIdx) hist[Yc[i]]++;
  const w = hist.map((n) => Math.sqrt(X.length / (4 * Math.max(1, n))));
  const m = w.reduce((a, b) => a + b, 0) / 4;
  return w.map((v) => v / m);
}

function evaluate(net, seeds, maxTicks) {
  let total = 0;
  const detail = [];
  for (const seed of seeds) {
    const w = new World({ seed });
    const b = new Float32Array(FEATURE_DIM);
    while (!w.crashed && w.ticks < maxTicks) {
      w.act(Actions[amax(net.probs(encodeState(w, b)))]);
      w.step();
    }
    total += w.score;
    detail.push(w.score);
  }
  return { mean: total / seeds.length, detail };
}

const results = [];

for (const mode of ['cls', 'value']) {
  console.log(`──── 目标 = ${mode === 'cls' ? '分类（模仿动作）' : '回归（模仿价值）'} ────`);
  const net = new MLP([FEATURE_DIM, CFG.hidden, CFG.hidden, 4], {
    seed: 7,
    output: mode === 'value' ? 'linear' : 'softmax',
  });
  const cw = mode === 'cls' ? classWeights() : null;
  if (cw) console.log(`   类别权重 ${cw.map((v) => v.toFixed(2)).join(' ')}`);

  const t0 = Date.now();
  for (let ep = 1; ep <= CFG.epochs; ep++) {
    const lr = CFG.lr * (1 - 0.7 * (ep / CFG.epochs));
    for (let i = 0; i < trainIdx.length; i += 256) {
      const rows = trainIdx.slice(i, i + 256);
      if (mode === 'value') {
        net.trainBatchMSE(rows.map((k) => ({ x: X[k], yv: Yv[k] })), lr);
      } else {
        net.trainBatch(rows.map((k) => ({ x: X[k], y: Yc[k] })), lr, cw);
      }
    }
  }

  // 与教师的一致率（分类看动作，回归看 argmax）
  let hit = 0;
  for (const i of valIdx) {
    const target = mode === 'value' ? amax(Yv[i]) : Yc[i];
    if (amax(net.probs(X[i])) === target) hit++;
  }
  const agree = hit / valIdx.length;
  const fit = evaluate(
    net,
    Array.from({ length: CFG.evalSeeds }, (_, i) => 1000 + i * 7 + 1),
    CFG.evalTicks
  );

  console.log(
    `   与教师一致率 ${(agree * 100).toFixed(1)}%   实战均分 ${fit.mean.toFixed(0)}   ` +
      `(${((Date.now() - t0) / 1000).toFixed(1)}s)`
  );
  console.log(`   逐局分数 ${JSON.stringify(fit.detail)}\n`);
  results.push({ mode, agree, mean: fit.mean, detail: fit.detail });
}

console.log('════ 汇总 ════');
console.log('目标                          与教师一致率   实战均分');
for (const r of results) {
  const label = r.mode === 'cls' ? '分类：模仿动作（交叉熵）' : '回归：模仿价值（MSE）';
  console.log(
    `${label.padEnd(28)} ${((r.agree * 100).toFixed(1) + '%').padStart(12)} ` +
      `${r.mean.toFixed(0).padStart(10)}`
  );
}
const cls = results.find((r) => r.mode === 'cls');
const val = results.find((r) => r.mode === 'value');
console.log(
  `\n结论：一致率低 ${((cls.agree - val.agree) * 100).toFixed(1)} 个点，实战强 ` +
    `${(val.mean / Math.max(1, cls.mean)).toFixed(1)} 倍。`
);
