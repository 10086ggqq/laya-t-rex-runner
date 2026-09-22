/**
 * bench.mjs —— 命令行批量评测
 *
 * 只做一件事：拿现成的权重，在同一种子集上把各个大脑跑一遍，输出可对比的表。
 * 训练流程（distill.mjs）内部也会跑同一套评测，这里是"只想复算结论"时的入口。
 *
 * 用法：
 *   node brain/bench.mjs
 *   node brain/bench.mjs --episodes 12 --delays 0,4,8 --max-ticks 20000
 *   node brain/bench.mjs --brains rule,planner,neural --delays 8
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { benchmark, formatTable } from '../src/bench.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const BRAINS = String(
  arg('brains', 'random,rule,planner,neural,layalite,layalite-neural')
).split(',');
const DELAYS = String(arg('delays', '0,8'))
  .split(',')
  .map(Number);
const EPISODES = Number(arg('episodes', 8));
const MAX_TICKS = Number(arg('max-ticks', 20000));
const SEED_BASE = Number(arg('seed-base', 1000));

function loadWeights(file) {
  const p = path.join(ROOT, 'brain', file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const W = {
  0: loadWeights('weights.json'),
  8: loadWeights('weights-delay8.json'),
};

console.log(`权重：weights.json ${W[0] ? '✓' : '✗（缺失，neural 会跳过）'}   ` +
  `weights-delay8.json ${W[8] ? '✓' : '✗'}`);
console.log(
  `评测：${BRAINS.length} 个大脑 × ${DELAYS.length} 档延迟 × ${EPISODES} 局，` +
    `单局上限 ${MAX_TICKS} 帧，种子基准 ${SEED_BASE}\n`
);

const weightsFor = (brainId, delay) => {
  if (!brainId.includes('neural')) return undefined;
  return W[delay] || W[0] || undefined;
};
const usable = BRAINS.filter((b) => {
  if (!b.includes('neural')) return true;
  if (W[0] || W[8]) return true;
  console.log(`跳过 ${b}：缺少神经权重，请先跑 node brain/distill.mjs`);
  return false;
});

let current = '';
const rows = benchmark({
  brainIds: usable,
  delays: DELAYS,
  episodes: EPISODES,
  maxTicks: MAX_TICKS,
  seedBase: SEED_BASE,
  weights: weightsFor,
  onProgress: ({ brainId, delay, episodes }) => {
    const key = `${brainId}@${delay}`;
    if (key !== current) {
      current = key;
      process.stdout.write(`  跑 ${brainId} @ ${delay}f（${episodes} 局）…\n`);
    }
  },
});

console.log('');
console.log(formatTable(rows));
console.log('');
console.log('列说明：crash = 撞车率；capped = 跑满帧上限（该行分数已封顶，不可再比高低）；');
console.log('        reason = 走完整试算路径的比例；avgMs = 单次决策平均耗时（毫秒）。');
