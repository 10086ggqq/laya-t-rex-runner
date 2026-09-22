/**
 * brains.js —— 大脑注册表
 *
 * 把"决策头"和"LayaLite 运行时"组装成可以直接插进游戏的大脑。
 * 关键区别：
 *   planner / neural / rule / random —— 纯策略，不做路由，用于消融对比
 *   layalite        —— 规划器 + 阈值头的双 checkpoint 路由（完整形态）
 *   layalite-neural —— 神经头 + 阈值头的双 checkpoint 路由
 *   laya-remote     —— 把提问发给真正的 Laya 服务
 */
import { LayaLite, Router } from './laya/typed-decision.js';
import { PlannerHead, NeuralHead, RuleHead, RandomHead, RemoteHead } from './laya/heads.js';

export const BRAINS = [
  {
    id: 'random',
    label: '随机',
    labelEn: 'Random',
    hint: '均匀随机按四个键，分数下限',
    color: '#9aa0a6',
  },
  {
    id: 'rule',
    label: '阈值规则',
    short: 'Rule',
    labelEn: 'Threshold rule',
    hint: '手写阈值：障碍进入若干帧就跳/蹲',
    color: '#4285f4',
  },
  {
    id: 'neural',
    label: '神经决策头',
    labelEn: 'Neural head',
    hint: '27→48→48→4 小网络，从规划器蒸馏而来',
    color: '#0f9d58',
  },
  {
    id: 'planner',
    label: '滚动规划器',
    labelEn: 'Rollout planner',
    hint: '克隆世界试算候选计划，教师策略',
    color: '#f4b400',
  },
  {
    id: 'layalite',
    label: 'LayaLite（规划器）',
    labelEn: 'LayaLite (planner)',
    hint: 'Router 按紧迫度切换廉价/完整路径',
    color: '#a142f4',
  },
  {
    id: 'layalite-neural',
    label: 'LayaLite（神经）',
    labelEn: 'LayaLite (neural)',
    hint: 'Router + 神经头，接近零延迟的 System 1',
    color: '#00acc1',
  },
  {
    id: 'laya-remote',
    label: 'Laya 远端服务',
    labelEn: 'Laya remote',
    hint: 'POST 到本地 Laya 服务（需先启动 laya_service）',
    color: '#e8710a',
    remote: true,
  },
];

export function brainMeta(id) {
  return BRAINS.find((b) => b.id === id) || BRAINS[0];
}

/**
 * @param {string} id
 * @param {object} opts
 * @param {object} [opts.weights] 神经头权重（neural / layalite-neural 需要）
 * @param {number} [opts.seed]
 * @param {number} [opts.nearWindow] Router 的紧迫窗口
 * @param {number} [opts.fastHeadMode] 'rule' | 'none'
 */
export function createBrain(id, opts = {}) {
  const seed = opts.seed ?? 20260922;
  const nearWindow = opts.nearWindow ?? 26;

  const requireWeights = () => {
    if (!opts.weights) {
      throw new Error(
        `brain "${id}" 需要神经权重：请先执行  node brain/distill.mjs  生成 brain/weights.json`
      );
    }
    return opts.weights;
  };

  switch (id) {
    case 'random':
      return {
        engine: new LayaLite({ head: new RandomHead(seed), router: null, id }),
        meta: brainMeta(id),
      };

    case 'rule':
      return {
        engine: new LayaLite({ head: new RuleHead(), router: null, id }),
        meta: brainMeta(id),
      };

    case 'planner':
      return {
        engine: new LayaLite({ head: new PlannerHead(), router: null, id }),
        meta: brainMeta(id),
      };

    case 'neural':
      return {
        engine: new LayaLite({
          head: NeuralHead.fromJSON(requireWeights()),
          router: null,
          id,
        }),
        meta: brainMeta(id),
      };

    case 'layalite':
      return {
        engine: new LayaLite({
          head: new PlannerHead(),
          fastHead: opts.fastHeadMode === 'none' ? new RuleHead() : new RuleHead(),
          router: new Router({ nearWindow }),
          id,
        }),
        meta: brainMeta(id),
      };

    case 'layalite-neural':
      return {
        engine: new LayaLite({
          head: NeuralHead.fromJSON(requireWeights()),
          fastHead: new RuleHead(),
          router: new Router({ nearWindow }),
          id,
        }),
        meta: brainMeta(id),
      };

    case 'laya-remote': {
      const remote = new RemoteHead(opts.remoteUrl);
      return {
        engine: {
          id,
          meter: { push() {}, get stats() { return { n: 0, avg: 0, p50: 0, p95: 0, max: 0 }; } },
          calls: 0,
          predictAsync: (world, questions) => remote.decideAsync(world, questions),
        },
        meta: brainMeta(id),
        remote: true,
      };
    }

    default:
      throw new Error(`unknown brain: ${id}`);
  }
}

export function availableBrainIds() {
  return BRAINS.map((b) => b.id);
}
