/**
 * bench.worker.js —— 在后台线程跑基准评测
 *
 * 每个大脑 × 每个延迟 × 每局上限 20000 帧，全在主线程跑会把界面卡死，
 * 所以放到 Worker 里，跑完把汇总表回传。
 */
import { benchmark } from './bench.js';

self.onmessage = (e) => {
  const { brainIds, delays, episodes, maxTicks, seedBase, weights } = e.data;
  try {
    const weightsFor = (brainId, delay) => {
      if (!brainId.includes('neural')) return undefined;
      return weights[delay] || weights[0] || undefined;
    };
    const rows = benchmark({
      brainIds,
      delays,
      episodes,
      maxTicks,
      seedBase,
      weights: weightsFor,
      onProgress: ({ brainId, delay, i, episodes: eps }) =>
        self.postMessage({ type: 'progress', brainId, delay, i, episodes: eps }),
    });
    self.postMessage({
      type: 'done',
      rows: rows.map((r) => ({
        brain: r.brainId,
        delay: r.delay,
        mean: r.scoreMean,
        median: r.scoreMedian,
        min: r.scoreMin,
        max: r.scoreMax,
        crash: r.crashRate,
        capped: r.cappedRate,
        reasonRatio: r.reasonRatio,
        avgMs: r.latencyAvgMs,
      })),
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
};
