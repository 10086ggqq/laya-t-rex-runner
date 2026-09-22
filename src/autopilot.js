/**
 * autopilot.js —— 观察 → 提问 → 决策 → 执行 的闭环
 *
 * 一帧一次：把世界快照交给决策引擎，拿到 typed answer，执行其中的动作，
 * 然后再推进物理。没有任何人工作弊（不读未来障碍的生成随机数，不跳过碰撞判定）。
 *
 * reactionDelay：
 *   大脑只能看到 D 帧之前的画面（模拟人类 ~130ms 的反应时间）。
 *   实现方式是每帧存一份世界克隆，读到的是 D 帧前那一份。
 *   注意这是**感知延迟**，不是执行延迟：指令立刻生效，但看到的是旧画面，
 *   所以"提前量"必须由策略自己想清楚——这正是阈值规则会崩、
 *   而学习到的策略能补回来的地方。
 */
import { World } from './core/world.js';
import { createBrain } from './brains.js';
import { buildQuestions } from './laya/heads.js';

export class Autopilot {
  constructor(opts = {}) {
    this.opts = opts;
    this.seed = opts.seed ?? 1;
    this.reactionDelay = opts.reactionDelay ?? 0;
    this.maxTrace = opts.maxTrace ?? 120;
    this.rebuild(opts.brainId ?? 'layalite-neural');
  }

  setReactionDelay(d) {
    this.reactionDelay = d;
    this.reset(this.seed);
  }

  rebuild(brainId) {
    this.brainId = brainId;
    const { engine, meta, remote } = createBrain(brainId, {
      ...this.opts,
      seed: this.seed,
    });
    this.engine = engine;
    this.meta = meta;
    this.remote = !!remote;
    this.reset(this.seed);
  }

  reset(seed = this.seed) {
    this.seed = seed;
    this.world = new World({ seed });
    this.trace = [];
    this.actionCounts = { NONE: 0, JUMP: 0, DUCK: 0, DROP: 0 };
    this.routeCounts = { fast: 0, reason: 0 };
    this.last = null;
    // 感知延迟用的环形缓冲：长度为 D+1，[0] 就是大脑"看到"的那一帧
    this._buffer = [];
    if (this.reactionDelay > 0) {
      for (let i = 0; i <= this.reactionDelay; i++) this._buffer.push(this.world.clone());
    }
    if (this.engine && typeof this.engine.reset === 'function') this.engine.reset();
    return this;
  }

  /** 大脑实际能观察到的世界（延迟 D 帧） */
  get observation() {
    if (this.reactionDelay <= 0) return this.world;
    return this._buffer[0] || this.world;
  }

  tick() {
    const res = this.engine.predict(this.observation, buildQuestions());
    return this._commit(res);
  }

  async tickAsync() {
    const res = await this.engine.predictAsync(this.observation, buildQuestions());
    return this._commit(res);
  }

  _commit(res) {
    const action = res.action.label;
    this.world.act(action);
    this.world.step();
    this.actionCounts[action] = (this.actionCounts[action] || 0) + 1;
    if (res.meta && res.meta.path) {
      this.routeCounts[res.meta.path] = (this.routeCounts[res.meta.path] || 0) + 1;
    }

    if (this.reactionDelay > 0) {
      this._buffer.push(this.world.clone());
      while (this._buffer.length > this.reactionDelay + 1) this._buffer.shift();
    }

    this.last = res;
    if (this.trace.length >= this.maxTrace) this.trace.shift();
    this.trace.push({
      tick: this.world.ticks,
      action,
      confidence: res.action && res.action.confidence != null ? res.action.confidence : 0,
      urgency: res.urgency ? res.urgency.value : null,
      safe: res.safe_to_idle ? res.safe_to_idle.label : null,
      path: res.meta ? res.meta.path : '-',
      head: res.meta ? res.meta.head : '-',
      latencyMs: res.meta ? res.meta.latencyMs : 0,
      score: this.world.score,
    });
    return res;
  }

  get crashed() {
    return this.world.crashed;
  }

  get stats() {
    const w = this.world;
    return {
      score: w.score,
      ticks: w.ticks,
      speed: w.currentSpeed,
      crashed: w.crashed,
      reactionDelay: this.reactionDelay,
      actions: { ...this.actionCounts },
      routes: { ...this.routeCounts },
      latency: this.engine.meter ? this.engine.meter.stats : null,
      calls: this.engine.calls || 0,
    };
  }
}
