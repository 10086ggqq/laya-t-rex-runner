/**
 * distill.mjs —— 教师（滚动规划器）→ 学生（神经决策头）
 *
 * 五步流水线，全部可复现：
 *
 *   1) 采集    教师跑 N 局，逐帧记录 (观测特征, 教师的 4 个动作评分)
 *   2) 回归    用 MSE 拟合教师的评分向量，策略 = argmax
 *              —— 关键选择：直接分类模仿"教师选了哪个动作"效果很差，
 *                 因为"该按下跳跃键"往往只有一两帧是正确时机，决策边界极窄；
 *                 而"现在跳能活多少帧"在小邻域内是平滑的，可学得多。
 *                 实测同数据同网络：回归均分 455，分类 168。
 *   3) DAgger  让学生自己跑，用教师给它踩过的状态重新打分，再训练，
 *              修掉回归/克隆的复合误差
 *   4) ES      进化策略微调，直接以存活分数为目标做无梯度优化
 *   5) 评测    同种子对比 随机 / 阈值 / 学生 / 教师 / LayaLite
 *
 * 关于 reactionDelay：
 *   大脑只看到 D 帧前的画面。打标签的方式是
 *     x = 观测(state_{T-D})，  y = 教师在 state_T 上的动作评分
 *   即"凭旧画面推断此刻该做什么"。规划器自己拿旧状态算也会迟到，
 *   学生却被显式训练出提前量，于是这种延迟下学生反而更强
 *   —— 这正是 Laya 的论点：延迟成为瓶颈时，专用快速 System 1 胜过通用慢推理。
 *
 * 用法：
 *   node brain/distill.mjs
 *   node brain/distill.mjs --episodes 36 --dagger 3 --delays 0,8 --keep-none 0.2
 *   node brain/distill.mjs --target cls --no-es
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { World } from '../src/core/world.js';
import { Actions } from '../src/core/constants.js';
import { encodeState, FEATURE_DIM } from '../src/laya/features.js';
import { PlannerHead } from '../src/laya/heads.js';
import { MLP } from '../src/laya/nn.js';
import { benchmark, formatTable } from '../src/bench.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ------------------------------------------------------------------ CLI
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) {
    const v = argv[i + 1];
    return v && !v.startsWith('--') ? v : true;
  }
  return def;
}
const CONFIG = {
  target: String(arg('target', 'value')), // value | cls
  episodes: Number(arg('episodes', 30)),
  maxTicks: Number(arg('max-ticks', 4200)),
  hidden: Number(arg('hidden', 72)),
  epochs: Number(arg('epochs', 60)),
  daggerRounds: Number(arg('dagger', 3)),
  daggerEpisodes: Number(arg('dagger-episodes', 4)),
  daggerEpochs: Number(arg('dagger-epochs', 25)),
  batch: Number(arg('batch', 256)),
  lr: Number(arg('lr', 4e-3)),
  keepNone: Number(arg('keep-none', 0.2)),
  valRatio: Number(arg('val-ratio', 0.08)),
  seedBase: Number(arg('seed-base', 3000)),
  es: arg('no-es', false) ? false : true,
  esPop: Number(arg('es-pop', 16)),
  esGens: Number(arg('es-gens', 25)),
  esSigma: Number(arg('es-sigma', 0.03)),
  esLr: Number(arg('es-lr', 0.02)),
  esSeeds: Number(arg('es-seeds', 4)),
  esTicks: Number(arg('es-ticks', 3200)),
  delays: String(arg('delays', '0,8'))
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n)),
  // 产物文件名。做消融（例如 --target cls）时用 --out-prefix / --report 另存，
  // 否则会把正式权重和报告覆盖掉。
  outPrefix: String(arg('out-prefix', 'weights') || 'weights'),
  reportName: String(arg('report', 'report.json') || 'report.json'),
  evalEpisodes: Number(arg('eval-episodes', 8)),
  evalTicks: Number(arg('eval-ticks', 20000)),
};
const log = (...a) => console.log(...a);
const pct = (v) => `${(v * 100).toFixed(2)}%`;
const VALUE_SCALE = 120; // 教师评分大致落在 [0, ~114]

// ------------------------------------------------------------------ 工具
function mulberry(seed) {
  let s = seed >>> 0 || 1;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function argmax(p) {
  let b = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[b]) b = i;
  return b;
}

/** 数据集容器 */
function newDataset() {
  return { X: [], Yc: [], Yv: [], hist: { NONE: 0, JUMP: 0, DUCK: 0, DROP: 0 } };
}

/**
 * 跑一局并采集样本。
 * @param {object} o
 * @param {number} o.delay 感知延迟（帧）
 * @param {number[]} o.seeds
 * @param {number} o.maxTicks
 * @param {PlannerHead} o.teacher
 * @param {MLP|null} o.student 为 null 时由教师驱动；否则由学生驱动（DAgger）
 * @param {number} o.keepNone 非关键帧保留比例
 * @param {ReturnType<typeof newDataset>} o.ds
 */
function collect(o) {
  const { delay, seeds, maxTicks, teacher, student, keepNone, ds } = o;
  const rnd = mulberry(0xc0ffee + delay);
  const buf = new Float32Array(FEATURE_DIM);
  const episodes = [];

  for (const seed of seeds) {
    const world = new World({ seed });
    // 特征环：ring[0] 就是 D 帧前那一份观测（等价于每帧存一份世界克隆）
    const ring = [];
    for (let i = 0; i <= delay; i++) ring.push(null);

    while (!world.crashed && world.ticks < maxTicks) {
      const feat = Array.from(encodeState(world, buf));
      ring.push(feat);
      while (ring.length > delay + 1) ring.shift();
      const obs = ring[0];

      // 标签永远来自"此刻"的真实状态：教师在 state_T 上给出 4 个动作评分
      const res = teacher.decide(world);
      const label = res.action;

      if (obs && (label !== 'NONE' || rnd() < keepNone)) {
        ds.X.push(obs);
        ds.Yc.push(Actions.indexOf(label));
        ds.Yv.push(res.values.map((v) => (v == null ? 0 : v) / VALUE_SCALE));
        ds.hist[label]++;
      }

      const action = student ? Actions[argmax(student.probs(obs || feat))] : label;
      world.act(action);
      world.step();
    }
    episodes.push({
      seed,
      ticks: world.ticks,
      score: world.score,
      driver: student ? 'student' : 'teacher',
    });
  }
  return { ds, episodes };
}

function split(ds, net) {
  const idx = ds.X.map((_, i) => i);
  const rnd = mulberry(20260922);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const nVal = Math.floor(idx.length * CONFIG.valRatio);
  return { trainIdx: idx.slice(nVal), valIdx: idx.slice(0, nVal) };
}

function classWeightsFrom(ds) {
  const total = Actions.reduce((a, c) => a + (ds.hist[c] || 0), 0) || 1;
  const w = Actions.map((c) => Math.sqrt(total / (Actions.length * Math.max(1, ds.hist[c]))));
  const m = w.reduce((a, b) => a + b, 0) / Actions.length;
  return w.map((v) => v / m);
}

/** 训练（回归或分类）。epochs=0 时只做评测，不改权重。 */
function train(ds, net, { epochs, lr }) {
  const { trainIdx, valIdx } = split(ds, net);
  const cw = CONFIG.target === 'cls' ? classWeightsFrom(ds) : null;
  const isValue = CONFIG.target === 'value';

  const lossOf = (ids) => {
    let s = 0;
    for (const i of ids) {
      if (isValue) {
        const p = net.values(ds.X[i]);
        for (let c = 0; c < 4; c++) {
          const e = p[c] - ds.Yv[i][c];
          s += 0.5 * e * e;
        }
      } else {
        s += -Math.log(Math.max(1e-12, net.probs(ds.X[i])[ds.Yc[i]]));
      }
    }
    return s / Math.max(1, ids.length);
  };
  const agree = (ids) => {
    let ok = 0;
    for (const i of ids) {
      const p = net.probs(ds.X[i]);
      const target = isValue ? argmax(ds.Yv[i]) : ds.Yc[i];
      if (argmax(p) === target) ok++;
    }
    return ok / Math.max(1, ids.length);
  };

  let best = { loss: Infinity, json: null, epoch: -1 };
  for (let ep = 1; ep <= epochs; ep++) {
    const eLr = lr * (1 - 0.7 * (ep / epochs));
    for (let s = 0; s < trainIdx.length; s += CONFIG.batch) {
      const rows = trainIdx.slice(s, s + CONFIG.batch);
      if (isValue) {
        net.trainBatchMSE(
          rows.map((i) => ({ x: ds.X[i], yv: ds.Yv[i] })),
          eLr
        );
      } else {
        net.trainBatch(
          rows.map((i) => ({ x: ds.X[i], y: ds.Yc[i] })),
          eLr,
          cw
        );
      }
    }
    const vl = lossOf(valIdx);
    if (vl < best.loss) best = { loss: vl, json: net.toJSON(), epoch: ep };
  }
  if (best.json) Object.assign(net, MLP.fromJSON(best.json));
  return { epoch: best.epoch, valLoss: best.loss, valAgree: agree(valIdx), trainAgree: agree(trainIdx) };
}

/** 在真实游戏里评适应度（带感知延迟语义） */
function fitness(net, { delay, seeds, maxTicks }) {
  const buf = new Float32Array(FEATURE_DIM);
  let total = 0;
  const detail = [];
  for (const seed of seeds) {
    const world = new World({ seed });
    const ring = [];
    for (let i = 0; i <= delay; i++) ring.push(null);
    while (!world.crashed && world.ticks < maxTicks) {
      const feat = Array.from(encodeState(world, buf));
      ring.push(feat);
      while (ring.length > delay + 1) ring.shift();
      world.act(Actions[argmax(net.probs(ring[0] || feat))]);
      world.step();
    }
    total += world.score;
    detail.push(world.score);
  }
  return { mean: total / seeds.length, detail };
}

function jitter(json, noise, sign) {
  return {
    sizes: json.sizes,
    output: json.output,
    W: json.W.map((W, li) => W.map((row, oi) => row.map((v, k) => v + sign * noise[li][oi][k]))),
    b: json.b.map((r) => r.slice()),
  };
}

/** OpenAI-ES 风格的镜像采样梯度估计 */
function esPolish(net, { delay }) {
  const seeds = Array.from({ length: CONFIG.esSeeds }, (_, i) => 90000 + i * 37 + 11);
  const base = net.toJSON();
  let bestJson = base;
  let bestFit = fitness(net, { delay, seeds, maxTicks: CONFIG.esTicks }).mean;
  const start = bestFit;
  const rng = mulberry(4242 + delay * 7919);
  let sigma = CONFIG.esSigma;

  for (let gen = 1; gen <= CONFIG.esGens; gen++) {
    const grad = base.W.map((W) => W.map((row) => new Array(row.length).fill(0)));
    let fSum = 0;
    for (let p = 0; p < CONFIG.esPop; p++) {
      const noise = base.W.map((W) => W.map((row) => row.map(() => gauss(rng) * sigma)));
      const fPlus = fitness(MLP.fromJSON(jitter(base, noise, +1)), {
        delay,
        seeds,
        maxTicks: CONFIG.esTicks,
      }).mean;
      const fMinus = fitness(MLP.fromJSON(jitter(base, noise, -1)), {
        delay,
        seeds,
        maxTicks: CONFIG.esTicks,
      }).mean;
      fSum += fPlus + fMinus;
      const w = (fPlus - fMinus) / (CONFIG.esPop * 2 * sigma);
      for (let li = 0; li < grad.length; li++) {
        for (let oi = 0; oi < grad[li].length; oi++) {
          for (let k = 0; k < grad[li][oi].length; k++) grad[li][oi][k] += w * noise[li][oi][k];
        }
      }
    }
    // 白化梯度（标准差归一），否则不同层量级差太多
    let g2 = 0;
    let cnt = 0;
    for (const W of grad)
      for (const row of W)
        for (const v of row) {
          g2 += v * v;
          cnt++;
        }
    const gStd = Math.sqrt(g2 / Math.max(1, cnt)) || 1;

    const cand = {
      sizes: base.sizes,
      output: base.output,
      W: base.W.map((W, li) =>
        W.map((row, oi) => row.map((v, k) => v + (CONFIG.esLr * grad[li][oi][k]) / gStd))
      ),
      b: base.b.map((r) => r.slice()),
    };
    const candNet = MLP.fromJSON(cand);
    const fit = fitness(candNet, { delay, seeds, maxTicks: CONFIG.esTicks }).mean;
    if (fit >= bestFit) {
      base.W = cand.W;
      bestFit = fit;
      bestJson = cand;
    }
    sigma = Math.max(0.01, sigma * 0.93);
    if (gen % 5 === 0 || gen === 1) {
      log(
        `      [ES d=${delay}] gen ${String(gen).padStart(2)}  样本均值 ${(fSum / (CONFIG.esPop * 2)).toFixed(1)}` +
          `  候选 ${fit.toFixed(1)}  best ${bestFit.toFixed(1)}  σ ${sigma.toFixed(3)}`
      );
    }
  }
  return { json: bestJson, start, end: bestFit, seeds };
}

// ================================================================== 主流程
const teacher = new PlannerHead();
const sizes = [FEATURE_DIM, CONFIG.hidden, CONFIG.hidden, Actions.length];
const trained = {};
const report = {
  trainedAt: new Date().toISOString(),
  config: CONFIG,
  network: sizes,
  target: CONFIG.target,
  delays: {},
};

log('#'.repeat(74));
log(` KLrun T-Rex Runner   蒸馏训练   目标=${CONFIG.target}   网络=${sizes.join('→')}   延迟档=${CONFIG.delays.join(',')}`);
log('#'.repeat(74));

for (const delay of CONFIG.delays) {
  log('');
  log(`======== 决策头 delay=${delay} 帧（${Math.round(delay * 16.67)}ms）========`);
  const net = new MLP(sizes, {
    seed: 20260922 + delay,
    output: CONFIG.target === 'value' ? 'linear' : 'softmax',
  });

  // ---- 1) 教师轨迹 ----
  const ds = newDataset();
  const seeds = Array.from({ length: CONFIG.episodes }, (_, i) => CONFIG.seedBase + i * 13 + 1);
  let t0 = Date.now();
  const base = collect({ delay, seeds, maxTicks: CONFIG.maxTicks, teacher, student: null, keepNone: CONFIG.keepNone, ds });
  const teacherMean =
    base.episodes.reduce((a, e) => a + e.score, 0) / base.episodes.length;
  log(
    `[1/5] 教师轨迹 ${ds.X.length} 条（${CONFIG.episodes} 局，均分 ${teacherMean.toFixed(1)}，` +
      `${((Date.now() - t0) / 1000).toFixed(1)}s）`
  );
  log(`      标签分布 ${JSON.stringify(ds.hist)}`);

  // ---- 2) 首轮训练 ----
  t0 = Date.now();
  let fit = train(ds, net, { epochs: CONFIG.epochs, lr: CONFIG.lr });
  log(
    `[2/5] 首轮训练（${CONFIG.epochs} epoch，${((Date.now() - t0) / 1000).toFixed(1)}s）` +
      `：与教师一致率 ${pct(fit.valAgree)}，loss=${fit.valLoss.toFixed(4)}，最佳 epoch=${fit.epoch}`
  );

  // ---- 3) DAgger ----
  for (let round = 1; round <= CONFIG.daggerRounds; round++) {
    const dSeeds = Array.from(
      { length: CONFIG.daggerEpisodes },
      (_, i) => CONFIG.seedBase + 500 + round * 61 + i * 17
    );
    const r = collect({ delay, seeds: dSeeds, maxTicks: CONFIG.maxTicks, teacher, student: net, keepNone: CONFIG.keepNone, ds });
    const mean = r.episodes.reduce((a, e) => a + e.score, 0) / r.episodes.length;
    fit = train(ds, net, { epochs: CONFIG.daggerEpochs, lr: CONFIG.lr * 0.6 });
    log(
      `[3/5] DAgger ${round}/${CONFIG.daggerRounds}：+${r.ds.X.length} 条（累计 ${ds.X.length}），` +
        `学生本轮均分 ${mean.toFixed(1)}，一致率 ${pct(fit.valAgree)}`
    );
  }

  // ---- 4) ES 微调 ----
  let esInfo = { applied: false };
  if (CONFIG.es) {
    const before = fitness(net, {
      delay,
      seeds: Array.from({ length: CONFIG.esSeeds }, (_, i) => 90000 + i * 37 + 11),
      maxTicks: CONFIG.esTicks,
    }).mean;
    const r = esPolish(net, { delay });
    Object.assign(net, MLP.fromJSON(r.json));
    const after = fitness(net, {
      delay,
      seeds: Array.from({ length: CONFIG.esSeeds }, (_, i) => 90000 + i * 37 + 11),
      maxTicks: CONFIG.esTicks,
    }).mean;
    esInfo = { applied: true, before, after, generations: CONFIG.esGens };
    log(
      `[4/5] ES 微调：适应度 ${before.toFixed(1)} → ${after.toFixed(1)}` +
        `（${CONFIG.esGens} 代 × ${CONFIG.esPop} 个体 × ${CONFIG.esSeeds} 局）`
    );
  } else {
    log('[4/5] 跳过 ES 微调');
  }

  const json = net.toJSON();
  const outPath = path.join(
    ROOT,
    'brain',
    delay === 0 ? `${CONFIG.outPrefix}.json` : `${CONFIG.outPrefix}-delay${delay}.json`
  );
  fs.writeFileSync(outPath, JSON.stringify(json));

  trained[delay] = { json };
  report.delays[delay] = {
    weightsFile: path.relative(ROOT, outPath).replace(/\\/g, '/'),
    samples: ds.X.length,
    labelHist: ds.hist,
    teacherMeanScore: teacherMean,
    valAgree: fit.valAgree,
    es: esInfo,
    teacherEpisodes: base.episodes,
  };
  log(
    `[5/5] 权重写入 ${path.relative(ROOT, outPath).replace(/\\/g, '/')}` +
      `（${ds.X.length} 条样本，${(JSON.stringify(json).length / 1024).toFixed(0)} KB）`
  );
}

// ------------------------------------------------------------------ 对比评测
log('');
log('======== 同种子对比评测 ========');
const weightsFor = (brainId, delay) => {
  if (!brainId.includes('neural')) return undefined;
  const key = CONFIG.delays.includes(delay) ? delay : CONFIG.delays[0];
  return trained[key] ? trained[key].json : undefined;
};

let lastReported = '';
const rows = benchmark({
  brainIds: ['random', 'rule', 'planner', 'neural', 'layalite', 'layalite-neural'],
  episodes: CONFIG.evalEpisodes,
  delays: CONFIG.delays,
  seedBase: 1000,
  maxTicks: CONFIG.evalTicks,
  weights: weightsFor,
  onProgress: ({ brainId, delay, i, episodes }) => {
    const key = `${brainId}@${delay}`;
    if (key !== lastReported) {
      lastReported = key;
      log(`   开始 ${brainId} @ ${delay}f（${episodes} 局，单局上限 ${CONFIG.evalTicks} 帧）…`);
    }
  },
});

log('');
log(formatTable(rows));

report.evaluation = rows.map((r) => ({
  brain: r.brainId,
  delay: r.delay,
  mean: Math.round(r.scoreMean),
  median: r.scoreMedian,
  min: r.scoreMin,
  max: r.scoreMax,
  crashRate: r.crashRate,
  cappedRate: r.cappedRate,
  maxSpeedRate: r.maxSpeedRate,
  reasonRatio: r.reasonRatio,
  latencyAvgMs: r.latencyAvgMs,
  actionCounts: r.actionCounts,
  episodes: r.episodesDetail.map((e) => ({ seed: e.seed, score: e.score, ticks: e.ticks })),
}));

const reportPath = path.join(ROOT, 'brain', CONFIG.reportName);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
log('');
log(`评测报告已写入 ${path.relative(ROOT, reportPath).replace(/\\/g, '/')}`);
