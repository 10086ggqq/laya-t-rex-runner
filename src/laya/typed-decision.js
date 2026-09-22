/**
 * typed-decision.js —— Laya 风格的类型化决策运行时（LayaLite）
 *
 * 说明清楚边界：这里实现的是 Laya 的**接口契约与路由/时延语义**，
 * 不是它的权重。上游 Laya（convaiinnovations/laya）是
 * "多语言、非自回归的 System 1 决策引擎，对任意状态做 typed decisions，
 *  单次前向 33ms，无文本生成、无需解析"，本文件把同一套契约
 * 落到小恐龙上：
 *
 *   state document  →  questions  →  typed answers
 *   （世界快照文本）    choice/score/noul   （动作/紧迫度/安全与否）
 *
 * 三个原语：
 *   choice  —— 在一组带自然语言说明的选项里打分（这里是 4 个操作）
 *   score   —— 连续量（这里是"改动作的紧迫度"）
 *   noul    —— 二元判定（中文叫"有无"，这里是"保持不动是否安全"）
 *
 * Router：Laya 用一个 Router 在多个 checkpoint 之间选。
 * 这里按"离障碍还有多少帧"路由：
 *   远处 → 廉价的 fast 路径（阈值头），
 *   近处 → 完整的 reason 路径（规划器/神经头）。
 * 只有被路由到的那条路径会消耗算力，这就是 System 1 的省电方式。
 */
import { Actions } from '../core/constants.js';
import { RuleHead } from './heads.js';

export const PRIMITIVES = ['choice', 'score', 'noul'];

export class Router {
  /**
   * @param {object} opts
   * @param {number} opts.nearWindow 最近障碍进入多少帧内才走 reason 路径
   */
  constructor(opts = {}) {
    this.nearWindow = opts.nearWindow ?? 26;
    this.history = [];
  }

  route(world) {
    const o = world.nextObstacle();
    const eta = o ? world.ticksToImpact(o) : Infinity;
    const airborne = world.trex.jumping || world.trex.ducking;
    const reason = eta <= this.nearWindow || airborne;
    this.history.push({ reason: reason ? 'reason' : 'fast', eta });
    if (this.history.length > 240) this.history.shift();
    return {
      path: reason ? 'reason' : 'fast',
      eta,
      why: reason
        ? airborne
          ? '运行中姿态未落定，需要完整试算'
          : `最近障碍 ${Math.round(eta)} 帧内到达`
        : `最近障碍 ${Number.isFinite(eta) ? Math.round(eta) + ' 帧外' : '不可见'}，走廉价路径`,
    };
  }
}

/** 时延统计（对齐 Laya 的"每问一次花多少 ms"的关注点） */
export class LatencyMeter {
  constructor(window = 120) {
    this.window = window;
    this.samples = [];
  }

  push(ms) {
    this.samples.push(ms);
    if (this.samples.length > this.window) this.samples.shift();
  }

  get stats() {
    if (!this.samples.length) return { n: 0, avg: 0, p50: 0, p95: 0, max: 0 };
    const s = this.samples.slice().sort((a, b) => a - b);
    const sum = s.reduce((a, b) => a + b, 0);
    return {
      n: s.length,
      avg: sum / s.length,
      p50: s[Math.floor(s.length * 0.5)],
      p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
      max: s[s.length - 1],
    };
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class LayaLite {
  /**
   * @param {object} opts
   * @param {{decide:(world:any)=>{action:string,probs:number[],detail:any,cost:any}}} opts.head 主决策头
   * @param {Router} [opts.router]
   * @param {object} [opts.fastHead] 廉价路径用头，默认 RuleHead
   * @param {string} [opts.id] checkpoint 名
   */
  constructor(opts = {}) {
    this.head = opts.head;
    this.fastHead = opts.fastHead || new RuleHead();
    // router 传 null 表示不做路由，永远走完整路径（用于"纯策略"基线对比）
    this.router = opts.router === undefined ? new Router() : opts.router;
    this.id = opts.id || 'layalite-typed-decisions';
    this.meter = new LatencyMeter();
    this.calls = 0;
    this.lastInput = 'NONE';
  }

  /**
   * 单次前向 = 一次 head.decide，随后把三个 typed question 一次性读出来。
   * @returns {{action:object, urgency:object, safe_to_idle:object, meta:object}}
   */
  predict(world, questions = {}) {
    const t0 = now();
    const route = this.router
      ? this.router.route(world)
      : { path: 'reason', eta: Infinity, why: '未启用路由，始终使用完整路径' };
    const head = route.path === 'reason' ? this.head : this.fastHead;
    const res = head.decide(world);
    this.calls++;
    this.lastInput = world.lastAction;

    // —— choice：动作分布 ——
    const probs = res.probs && res.probs.length === 4 ? res.probs : [0.25, 0.25, 0.25, 0.25];
    const label = res.action;
    const choice = {
      type: 'choice',
      label,
      probs,
      criteria: Actions.slice(),
      confidence: probs[Actions.indexOf(label)] ?? 0,
    };

    // —— score：改动作的紧迫度 = 1 - P(维持当前输入) ——
    const keepIdx = Math.max(0, Actions.indexOf(this.lastInput));
    const urgencyValue =
      route.path === 'reason' ? clamp01(1 - probs[keepIdx]) : clamp01(1 - probs[keepIdx]) * 0.35;
    const urgency = {
      type: 'score',
      value: urgencyValue,
      basis: `1 - P(keep ${this.lastInput}) = ${(1 - probs[keepIdx]).toFixed(3)}`,
    };

    // —— noul：保持当前输入 30 帧是否安全（真实试算，不是猜） ——
    const probe = world.clone();
    const keep = this.lastInput;
    let safe = true;
    for (let i = 0; i < 30; i++) {
      probe.act(keep);
      probe.step();
      if (probe.crashed) {
        safe = false;
        break;
      }
    }
    const safe_to_idle = {
      type: 'noul',
      label: safe ? 'yes' : 'no',
      p: safe ? 1 : 0,
      horizon: 30,
    };

    const dt = now() - t0;
    this.meter.push(dt);

    return {
      action: choice,
      urgency,
      safe_to_idle,
      meta: {
        engine: this.id,
        path: route.path,
        routeWhy: route.why,
        head: head.name,
        latencyMs: dt,
        cost: res.cost || {},
        detail: res.detail || {},
        questionCount: Object.keys(questions).length || 3,
      },
    };
  }
}

function now() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}
