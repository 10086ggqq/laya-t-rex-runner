/**
 * 可复现随机数。
 *
 * 上游游戏直接用 Math.random()，AI 评测必须能"同一局重放"才能公平比较，
 * 所以这里把所有随机来源收敛到一个显式 Rng 实例。
 * 接口刻意对齐上游的 getRandomNum(min, max)：闭区间整数。
 */
export class Rng {
  constructor(seed = 1) {
    this.seed = seed >>> 0;
    this.s = (seed >>> 0) || 1;
  }

  /** [0,1) */
  next() {
    // mulberry32
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 上游 getRandomNum：闭区间 [min, max] 的整数 */
  int(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** 所有元素里随机取一个 */
  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }

  chance(p) {
    return this.next() < p;
  }

  reset(seed) {
    this.seed = seed >>> 0;
    this.s = (seed >>> 0) || 1;
  }

  /** 用于分叉：复制出互不相关的独立流 */
  fork(tag = 0) {
    const child = new Rng(((this.seed * 2654435761) ^ (tag * 40503 + 1)) >>> 0);
    return child;
  }
}
