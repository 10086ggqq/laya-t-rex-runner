/**
 * heads.js —— 决策头集合
 *
 * 每个"头"都只做一件事：给定世界状态，返回 4 个 typed action 上的分布。
 * 上层（LayaLite 运行时）把它们当成 Laya 的 checkpoint 来路由。
 *
 *   PlannerHead  —— 教师策略。宏动作滚动试算（receding-horizon），
 *                   克隆世界、把候选计划跑到底，用存活帧数打分。
 *                   它决定"数据长什么样"。
 *   NeuralHead   —— 学生策略。27→48→48→4 的小网络，从教师蒸馏而来，
 *                   单次前向 ~微秒级，是真正能跑满 60fps 的 System 1。
 *   RuleHead     —— 手写阈值规则，作为可解释的最小基线。
 *   RandomHead   —— 均匀随机，作为分数下限。
 *   RemoteHead   —— 转发到远端 Laya 服务（laya_service/server.py）。
 */
import { Actions, ActionIndex } from '../core/constants.js';
import { encodeState, FEATURE_DIM } from './features.js';
import { MLP } from './nn.js';

const repeat = (a, n) => new Array(n).fill(a);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 计划（宏）→ 首位动作 */
function leadAction(macro) {
  return macro.seq.length ? macro.seq[0] : 'NONE';
}

/** 试算用的滚动长度：宏跑完之后继续 NONE 观察多久 */
const TAIL = 62;

function scoreMacro(world, macro) {
  const sim = world.clone();
  const seq = macro.seq;
  let survived = 0;
  for (let i = 0; i < seq.length + TAIL; i++) {
    if (sim.crashed) break;
    sim.act(i < seq.length ? seq[i] : 'NONE');
    sim.step();
    survived++;
  }
  // 少量整形：同等存活帧数下更少腾空/更少蹲下更优（留给下一个决策更多选择权）
  const effort = seq.reduce((acc, a) => acc + (a === 'NONE' ? 0 : 1), 0);
  return { score: survived - 0.02 * effort, survived };
}

function softmaxByAction(perAction, temperature = 4) {
  const best = {};
  for (const a of Actions) best[a] = -Infinity;
  for (const [a, s] of Object.entries(perAction)) best[a] = Math.max(best[a] ?? -Infinity, s);
  const max = Math.max(...Object.values(best));
  const exps = {};
  let sum = 0;
  for (const a of Actions) {
    const v = Number.isFinite(best[a]) ? Math.exp((best[a] - max) / temperature) : 0;
    exps[a] = v;
    sum += v;
  }
  const probs = Actions.map((a) => (sum > 0 ? exps[a] / sum : 1 / Actions.length));
  return probs;
}

export class PlannerHead {
  constructor(opts = {}) {
    this.name = 'planner';
    this.horizon = opts.horizon ?? TAIL;
    this.lastPlan = null;
    this.lastStats = null;
  }

  /** 依据当前姿态生成候选计划集合 */
  buildMacros(world) {
    const t = world.trex;
    const macros = [];
    const push = (name, seq) => macros.push({ name, seq });

    if (t.jumping) {
      push('hold', repeat('JUMP', 24));
      push('release', []);
      push('release4_dive', [...repeat('NONE', 4), 'DROP', ...repeat('NONE', 20)]);
      push('dive', ['DROP', ...repeat('NONE', 24)]);
    } else if (t.ducking) {
      push('duck_hold', repeat('DUCK', 40));
      push('stand_up', []);
      push('jump_out', [...repeat('JUMP', 20)]);
    } else {
      push('wait', []);
      for (const k of [0, 6, 12, 20, 30]) {
        for (const hold of [4, 9, 15, 22]) {
          push(`wait${k}_jump${hold}`, [...repeat('NONE', k), ...repeat('JUMP', hold)]);
        }
      }
      push('duck18', repeat('DUCK', 18));
      push('duck40', repeat('DUCK', 40));
      push('dive_guard', ['DROP', ...repeat('NONE', 20)]);
    }

    // 保证 4 个动作都有落点，分布/评分才是 4 维的
    // 注意 fallback 用 [a] 而不是 []：序列首动作必须真的是 a，
    // 否则这个动作拿不到任何评分（回归训练就没有标签了）
    for (const a of Actions) {
      if (!macros.some((m) => leadAction(m) === a)) push(`noop_${a}`, [a]);
    }
    return macros;
  }

  decide(world) {
    const macros = this.buildMacros(world);
    const results = [];
    let best = null;
    for (const m of macros) {
      const r = scoreMacro(world, m);
      results.push({ ...m, ...r });
      if (!best || r.score > best.score) best = { ...m, ...r };
    }

    const perAction = {};
    for (const r of results) {
      const a = leadAction(r);
      perAction[a] = Math.max(perAction[a] ?? -Infinity, r.score);
    }

    this.lastPlan = { action: leadAction(best), macro: best.name, survived: best.survived };
    this.lastStats = {
      candidates: results.length,
      steps: results.reduce((acc, r) => acc + r.survived, 0),
      top: results
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((r) => ({ name: r.name, survived: r.survived })),
    };

    return {
      action: leadAction(best),
      probs: softmaxByAction(perAction),
      // values：教师对"每个动作能活多少帧"的估计。
      // 回归训练用这一路信号，比直接模仿动作稳得多。
      values: ActionIndex
        ? Actions.map((a) => (Number.isFinite(perAction[a]) ? perAction[a] : null))
        : null,
      detail: this.lastPlan,
      cost: this.lastStats,
    };
  }
}

export class NeuralHead {
  /** @param {MLP} net */
  constructor(net) {
    this.name = 'neural';
    this.net = net;
    this._buf = new Float32Array(FEATURE_DIM);
  }

  static fromJSON(obj) {
    return new NeuralHead(MLP.fromJSON(obj));
  }

  decide(world) {
    const f = encodeState(world, this._buf);
    const probs = Array.from(this.net.probs(f));
    let bi = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[bi]) bi = i;
    return {
      action: Actions[bi],
      probs,
      detail: { temperature: 0, confidence: probs[bi] },
      cost: { params: this.net.sizes.reduce((a, b) => a + b, 0) },
    };
  }
}

export class RuleHead {
  constructor() {
    this.name = 'rule';
    this.airHold = 0;
    this.duckHold = 0;
  }

  decide(world) {
    const t = world.trex;
    const o = world.nextObstacle();
    const probs = [0.25, 0.25, 0.25, 0.25];
    const set = (a, v = 0.9) => {
      const idx = ActionIndex[a];
      for (let i = 0; i < 4; i++) probs[i] = i === idx ? v : (1 - v) / 3;
    };

    let action = 'NONE';
    if (t.jumping) {
      action = this.airHold > 0 ? 'JUMP' : 'NONE';
      this.airHold = Math.max(0, this.airHold - 1);
    } else if (o) {
      const eta = world.ticksToImpact(o);
      const isPtero = o.typeConfig.type === 'PTERODACTYL';
      const lowBird = isPtero && o.yPos >= 90;
      const highBird = isPtero && o.yPos < 90;
      if (highBird) {
        action = eta <= 9 ? 'DUCK' : 'NONE';
        if (eta <= 9) this.duckHold = 14;
      } else if (isPtero || o.typeConfig.type === 'CACTUS_LARGE') {
        if (eta <= 11) {
          action = 'JUMP';
          this.airHold = 18;
        }
      } else if (eta <= 10) {
        action = 'JUMP';
        this.airHold = 10;
      }
    }
    if (t.ducking && action !== 'DUCK') this.duckHold = 0;
    set(action);
    return { action, probs, detail: { rule: 'threshold' }, cost: {} };
  }
}

export class RandomHead {
  constructor(seed = 1) {
    this.name = 'random';
    this.s = seed >>> 0 || 1;
  }

  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  decide() {
    const i = Math.min(3, Math.floor(this.next() * 4));
    const probs = [0.25, 0.25, 0.25, 0.25];
    return { action: Actions[i], probs, detail: { uniform: true }, cost: {} };
  }
}

/**
 * 把世界状态压缩成一段"状态文档"，再送去远端 Laya。
 * 这里刻意用自然语言而不是张量：Laya 的输入就是文本/JSON 文档。
 */
export function stateDocument(world) {
  const s = world.snapshot();
  const obstacles = s.obstacles.length
    ? s.obstacles
        .map(
          (o, i) =>
            `  ${i + 1}. ${o.type.toLowerCase().replace('_', ' ')} x ${o.size}, ` +
            `top edge at y=${o.yPos}, ${Math.round(o.dx)} px ahead ` +
            `(~${Math.round(o.ticksToImpact)} frames)`
        )
        .join('\n')
    : '  (none visible)';
  return [
    `T-Rex runner state, frame ${s.tick}.`,
    `Ground speed ${s.speed.toFixed(2)} px/frame (max 13).`,
    `Runner: ${s.trex.jumping ? 'airborne' : s.trex.ducking ? 'ducking' : 'on the ground'}` +
      `, feet ${s.trex.clearance} px above the ground, vertical velocity ` +
      `${s.trex.jumpVelocity.toFixed(1)}.`,
    `Score ${s.score}.`,
    `Obstacles ahead, nearest first:`,
    obstacles,
  ].join('\n');
}

/**
 * Laya 的 typed questions（choice / score / noul）
 *
 * 注意 criteria 的形状必须和 laya 的约定一致，否则真实服务会报
 * "options exceed head_max_len" 之类的错：
 *   choice —— criteria 是 {选项: 说明}
 *   score  —— criteria 是**有序列表**（0..k-1 档），返回值是档位期望
 *   noul   —— 选项恒为 [false, true]，criteria 可选 {false, true} 说明
 */
export function buildQuestions() {
  return {
    action: {
      type: 'choice',
      instructions:
        'Pick the single control input for this frame that keeps the runner alive longest.',
      criteria: {
        NONE: 'do nothing, keep running on the ground',
        JUMP: 'press and hold the jump key',
        DUCK: 'press and hold the down key, lowering the body',
        DROP: 'release the jump and fall faster to land sooner',
      },
    },
    urgency: {
      type: 'score',
      instructions:
        'How urgent is it for the runner to change what it is currently doing?',
      criteria: [
        'completely safe, no obstacle matters yet',
        'obstacle is approaching, there is comfortable slack',
        'an action will be needed within a handful of frames',
        'the decision has to be made right now',
        'collision is imminent unless the input changes this frame',
      ],
    },
    safe_to_idle: {
      type: 'noul',
      instructions:
        'If the runner keeps its current input unchanged, will it stay collision-free for the next 30 frames?',
      criteria: {
        true: 'yes, the next 30 frames are collision-free',
        false: 'no, it collides within 30 frames',
      },
    },
  };
}

export class RemoteHead {
  constructor(url = 'http://127.0.0.1:8766') {
    this.name = 'laya-remote';
    this.url = url;
    this.lastLatency = 0;
  }

  async decideAsync(world) {
    const t0 = performance.now ? performance.now() : Date.now();
    const res = await fetch(`${this.url}/predict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: stateDocument(world), questions: buildQuestions() }),
    });
    if (!res.ok) throw new Error(`Laya 服务返回 ${res.status}`);
    const json = await res.json();
    this.lastLatency = (performance.now ? performance.now() : Date.now()) - t0;

    // laya 的返回形状：{ answers: { action:{choice,probabilities}, urgency:{score,...}, safe_to_idle:{noul} } }
    const a = json.action || (json.answers && json.answers.action) || {};
    const u = json.urgency || (json.answers && json.answers.urgency) || {};
    const s = json.safe_to_idle || (json.answers && json.answers.safe_to_idle) || {};

    const label = a.label || a.choice || 'NONE';
    let probs = a.probs;
    if (!probs && a.probabilities) {
      probs = Actions.map((k) => a.probabilities[k] ?? 0);
    }
    if (!Array.isArray(probs) || probs.length !== 4) probs = [0.25, 0.25, 0.25, 0.25];

    let urgencyValue = u.value;
    if (urgencyValue == null && u.score != null) {
      const k = (u.levels || 5) - 1;
      urgencyValue = k > 0 ? u.score / k : 0;
    }

    let safeLabel = s.label;
    if (!safeLabel && s.noul != null) safeLabel = s.noul >= 0.5 ? 'yes' : 'no';
    const safeP = s.p != null ? s.p : s.noul != null ? s.noul : 0.5;

    const idx = Actions.indexOf(label);
    const confidence = a.confidence != null ? a.confidence : probs[idx] || 0;

    // 返回形状刻意和 LayaLite.predict() 完全一致，
    // 这样远端大脑和其它大脑在上层是同一套渲染/日志代码
    return {
      action: {
        type: 'choice',
        label: Actions.includes(label) ? label : 'NONE',
        probs,
        criteria: Actions.slice(),
        confidence,
      },
      urgency: {
        type: 'score',
        value: urgencyValue == null ? 0 : urgencyValue,
        basis: u.score != null ? `Laya score ${u.score}/${(u.levels || 5) - 1}` : '',
      },
      safe_to_idle: {
        type: 'noul',
        label: safeLabel || 'yes',
        p: safeP,
        horizon: 30,
      },
      meta: {
        engine: json.engine || 'laya',
        path: 'remote',
        routeWhy: '每次决策都是一次 HTTP 往返，路由交给远端服务',
        head: json.engine === 'fallback-rule' ? 'laya-service(fallback)' : 'laya-service',
        latencyMs: this.lastLatency,
        cost: { usage: json.usage || {} },
        detail: { remote: true },
      },
    };
  }
}

export { leadAction, scoreMacro, softmaxByAction, clamp };
