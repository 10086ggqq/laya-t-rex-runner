/**
 * bench.js —— 无头批量评测
 *
 * 同一批 seed 下让每个大脑跑同样的障碍序列，输出分数/存活帧数/动作分布
 * 与决策时延。因为内核是完全确定性的，这组数字可以逐位复现。
 *
 * 支持 reactionDelay：把"感知延迟"当作难度旋钮，
 * 在同一张表里对比"反应快但不会预判"和"反应慢但会预判"。
 */
import { Autopilot } from './autopilot.js';

export const DEFAULT_MAX_TICKS = 20000;

/**
 * 跑一局。
 * @param {object} o
 * @param {string} o.brainId
 * @param {number} o.seed
 * @param {number} [o.maxTicks]
 * @param {number} [o.reactionDelay]
 * @param {object} [o.weights]
 */
export function runEpisode(o) {
  const maxTicks = o.maxTicks ?? DEFAULT_MAX_TICKS;
  const pilot = new Autopilot({
    brainId: o.brainId,
    seed: o.seed,
    reactionDelay: o.reactionDelay ?? 0,
    weights: o.weights,
  });

  while (!pilot.crashed && pilot.world.ticks < maxTicks) pilot.tick();

  const w = pilot.world;
  const fast = pilot.routeCounts.fast || 0;
  const reason = pilot.routeCounts.reason || 0;
  const total = fast + reason || 1;

  return {
    brainId: o.brainId,
    seed: o.seed,
    reactionDelay: o.reactionDelay ?? 0,
    score: w.score,
    ticks: w.ticks,
    crashed: w.crashed,
    capped: !w.crashed && w.ticks >= maxTicks,
    reachedMaxSpeed: w.currentSpeed >= 12.999,
    actionCounts: { ...pilot.actionCounts },
    route: { fast, reason, reasonRatio: reason / total },
    latency: pilot.engine.meter ? pilot.engine.meter.stats : null,
  };
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * 批量评测。
 * @param {object} o
 * @param {string[]} o.brainIds
 * @param {number} [o.episodes] 每个组合跑多少局
 * @param {number[]} [o.delays] 感知延迟档位
 * @param {number} [o.seedBase]
 * @param {number} [o.maxTicks]
 * @param {object|((brainId:string, delay:number)=>object)} [o.weights]
 */
export function benchmark(o) {
  const episodes = o.episodes ?? 10;
  const seedBase = o.seedBase ?? 1000;
  const delays = o.delays ?? [0];
  const rows = [];

  const weightsFor = (brainId, delay) => {
    if (typeof o.weights === 'function') return o.weights(brainId, delay);
    if (o.weights && typeof o.weights === 'object' && delay in o.weights) {
      return o.weights[delay];
    }
    return o.weights;
  };

  for (const delay of delays) {
    for (const brainId of o.brainIds) {
      const eps = [];
      for (let i = 0; i < episodes; i++) {
        const seed = seedBase + i * 7 + 1;
        const ep = runEpisode({
          brainId,
          seed,
          maxTicks: o.maxTicks,
          reactionDelay: delay,
          weights: weightsFor(brainId, delay),
        });
        eps.push(ep);
        if (o.onProgress) o.onProgress({ brainId, delay, i, episodes, ep });
      }
      const scores = eps.map((e) => e.score).sort((a, b) => a - b);
      rows.push({
        brainId,
        delay,
        episodes,
        scoreMean: mean(scores),
        scoreMin: scores[0],
        scoreMax: scores[scores.length - 1],
        scoreMedian: scores[Math.floor(scores.length / 2)],
        ticksMean: mean(eps.map((e) => e.ticks)),
        crashRate: eps.filter((e) => e.crashed).length / eps.length,
        cappedRate: eps.filter((e) => e.capped).length / eps.length,
        maxSpeedRate: eps.filter((e) => e.reachedMaxSpeed).length / eps.length,
        reasonRatio: mean(eps.map((e) => e.route.reasonRatio)),
        latencyAvgMs: mean(eps.map((e) => (e.latency ? e.latency.avg : 0))),
        actionCounts: eps.reduce(
          (acc, e) => {
            for (const k of Object.keys(acc)) acc[k] += e.actionCounts[k];
            return acc;
          },
          { NONE: 0, JUMP: 0, DUCK: 0, DROP: 0 }
        ),
        episodesDetail: eps,
      });
    }
  }
  return rows;
}

/** 把结果渲染成对齐表格（CLI 与 UI 共用） */
export function formatTable(rows) {
  const head = [
    'brain',
    'delay',
    'mean',
    'median',
    'min',
    'max',
    'crash',
    'capped',
    'maxSpd',
    'reason',
    'avgMs',
  ];
  const lines = [head.map((h, i) => pad(h, i <= 1 ? 16 : 7)).join(' ')];
  for (const r of rows) {
    lines.push(
      [
        pad(r.brainId, 16),
        pad(`${r.delay}f`, 7),
        pad(Math.round(r.scoreMean), 7),
        pad(r.scoreMedian, 7),
        pad(r.scoreMin, 7),
        pad(r.scoreMax, 7),
        pad(`${(r.crashRate * 100).toFixed(0)}%`, 7),
        pad(`${(r.cappedRate * 100).toFixed(0)}%`, 7),
        pad(`${(r.maxSpeedRate * 100).toFixed(0)}%`, 7),
        pad(`${(r.reasonRatio * 100).toFixed(0)}%`, 7),
        pad(r.latencyAvgMs.toFixed(3), 7),
      ].join(' ')
    );
  }
  return lines.join('\n');
}

function pad(v, n) {
  return String(v).padEnd(n);
}
