/**
 * nn.js —— 极简多层感知机（前向 + Adam 反向传播）
 *
 * 不引入任何依赖，因为这里要的是"能在浏览器里直接跑、也能在 Node 里训练"
 * 的最小实现。结构：全连接 + tanh 隐层 + softmax 输出。
 *
 * 决策头的规模刻意很小（27 → 48 → 48 → 4，约 5k 参数），
 * 对应 Laya 那种"单次前向、不生成文本、没有解析环节"的定位。
 */

function gaussian(rng) {
  // Box-Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MLP {
  /**
   * @param {number[]} sizes 例如 [27, 48, 48, 4]
   * @param {object} [opts]
   * @param {number} [opts.seed]
   * @param {'softmax'|'linear'} [opts.output] 输出层类型
   *   softmax —— 分类（直接模仿教师动作，交叉熵）
   *   linear  —— 回归（模仿教师对该动作的"存活评分"，均方误差）
   *   经验上回归版对时序精度要求高的控制任务明显更稳：动作只有一个正确的帧，
   *   而"现在跳能活多少帧"在小邻域内是平滑的。
   */
  constructor(sizes, opts = {}) {
    this.sizes = sizes.slice();
    this.output = opts.output || 'softmax';
    this.depth = sizes.length - 1;
    const rng = makeRng(opts.seed || 12345);
    this.W = [];
    this.b = [];
    for (let i = 0; i < this.depth; i++) {
      const fanIn = sizes[i];
      const fanOut = sizes[i + 1];
      const scale = Math.sqrt(2 / fanIn);
      const W = [];
      for (let o = 0; o < fanOut; o++) {
        const row = new Float64Array(fanIn);
        for (let k = 0; k < fanIn; k++) row[k] = gaussian(rng) * scale;
        W.push(row);
      }
      this.W.push(W);
      this.b.push(new Float64Array(fanOut));
    }
    // Adam 状态
    this._mW = this.W.map((W) => W.map((r) => new Float64Array(r.length)));
    this._vW = this.W.map((W) => W.map((r) => new Float64Array(r.length)));
    this._mb = this.b.map((r) => new Float64Array(r.length));
    this._vb = this.b.map((r) => new Float64Array(r.length));
    this._t = 0;
  }

  /** 前向：返回各层激活值 */
  forward(x) {
    const acts = [x];
    let cur = x;
    for (let i = 0; i < this.depth; i++) {
      const W = this.W[i];
      const b = this.b[i];
      const out = new Float64Array(b.length);
      for (let o = 0; o < W.length; o++) {
        let s = b[o];
        const row = W[o];
        for (let k = 0; k < row.length; k++) s += row[k] * cur[k];
        out[o] = s;
      }
      if (i < this.depth - 1) {
        for (let o = 0; o < out.length; o++) out[o] = Math.tanh(out[o]);
      } else if (this.output === 'softmax') {
        let max = -Infinity;
        for (let o = 0; o < out.length; o++) if (out[o] > max) max = out[o];
        let sum = 0;
        for (let o = 0; o < out.length; o++) {
          out[o] = Math.exp(out[o] - max);
          sum += out[o];
        }
        for (let o = 0; o < out.length; o++) out[o] /= sum;
      }
      acts.push(out);
      cur = out;
    }
    return acts;
  }

  probs(x) {
    const acts = this.forward(x);
    return acts[acts.length - 1];
  }

  /** 回归模式下也复用：返回的是各动作的预测评分 */
  values(x) {
    return this.probs(x);
  }

  argmax(x) {
    const p = this.probs(x);
    let bi = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[bi]) bi = i;
    return bi;
  }

  /**
   * 一个小批量的交叉熵梯度更新（Adam）
   *
   * classWeights 是这套东西能不能用的关键：小恐龙里 ~86% 的帧标签都是"不动"，
   * 不加权的话网络会学成"永远不动"，valAcc 看着有 93%，实战连第一个仙人掌都过不去。
   * 按类别频率开根号倒数加权，把注意力拉回真正决定生死的少数帧上。
   *
   * @param {{x:number[]|Float64Array, y:number}[]} batch
   * @param {number} lr
   * @param {number[]} [classWeights] 长度 = 类别数
   * @returns {number} 加权平均 loss
   */
  trainBatch(batch, lr = 1e-3, classWeights = null) {
    const n = batch.length;
    if (!n) return 0;
    const gW = this.W.map((W) => W.map((r) => new Float64Array(r.length)));
    const gb = this.b.map((r) => new Float64Array(r.length));
    let loss = 0;
    let wSum = 0;

    for (const sample of batch) {
      const sw = classWeights ? classWeights[sample.y] : 1;
      wSum += sw;
      const acts = this.forward(sample.x);
      const p = acts[acts.length - 1];
      loss += sw * -Math.log(Math.max(1e-12, p[sample.y]));

      // 输出层误差
      let delta = new Float64Array(p.length);
      for (let o = 0; o < p.length; o++) delta[o] = sw * (p[o] - (o === sample.y ? 1 : 0));

      for (let i = this.depth - 1; i >= 0; i--) {
        const prev = acts[i];
        const W = this.W[i];
        for (let o = 0; o < W.length; o++) {
          const d = delta[o];
          if (d !== 0) {
            const grow = gW[i][o];
            for (let k = 0; k < prev.length; k++) grow[k] += d * prev[k];
          }
          gb[i][o] += d;
        }
        if (i > 0) {
          const nd = new Float64Array(prev.length);
          for (let k = 0; k < prev.length; k++) {
            let s = 0;
            for (let o = 0; o < W.length; o++) s += W[o][k] * delta[o];
            nd[k] = s * (1 - prev[k] * prev[k]); // tanh'
          }
          delta = nd;
        }
      }
    }

    // Adam
    this._adam(gW, gb, wSum || n, lr);

    return loss / (wSum || 1);
  }

  /**
   * 回归训练：让 4 个输出逼近教师给出的"每个动作能活多少帧"。
   * @param {{x:number[]|Float64Array, yv:number[]|Float64Array}[]} batch
   * @param {number} lr
   * @returns {number} 平均 MSE
   */
  trainBatchMSE(batch, lr = 1e-3) {
    const n = batch.length;
    if (!n) return 0;
    const gW = this.W.map((W) => W.map((r) => new Float64Array(r.length)));
    const gb = this.b.map((r) => new Float64Array(r.length));
    let loss = 0;

    for (const sample of batch) {
      const acts = this.forward(sample.x);
      const p = acts[acts.length - 1];
      const dim = p.length;
      let delta = new Float64Array(dim);
      for (let o = 0; o < dim; o++) {
        const err = p[o] - sample.yv[o];
        loss += 0.5 * err * err;
        delta[o] = err / dim;
      }

      for (let i = this.depth - 1; i >= 0; i--) {
        const prev = acts[i];
        const W = this.W[i];
        for (let o = 0; o < W.length; o++) {
          const d = delta[o];
          if (d !== 0) {
            const grow = gW[i][o];
            for (let k = 0; k < prev.length; k++) grow[k] += d * prev[k];
          }
          gb[i][o] += d;
        }
        if (i > 0) {
          const nd = new Float64Array(prev.length);
          for (let k = 0; k < prev.length; k++) {
            let s = 0;
            for (let o = 0; o < W.length; o++) s += W[o][k] * delta[o];
            nd[k] = s * (1 - prev[k] * prev[k]);
          }
          delta = nd;
        }
      }
    }

    this._adam(gW, gb, n, lr);
    return loss / n;
  }

  _adam(gW, gb, n, lr) {
    this._t++;
    const b1 = 0.9;
    const b2 = 0.999;
    const eps = 1e-8;
    const c1 = 1 - Math.pow(b1, this._t);
    const c2 = 1 - Math.pow(b2, this._t);
    for (let i = 0; i < this.depth; i++) {
      for (let o = 0; o < this.W[i].length; o++) {
        const row = this.W[i][o];
        const grow = gW[i][o];
        const m = this._mW[i][o];
        const v = this._vW[i][o];
        for (let k = 0; k < row.length; k++) {
          const g = grow[k] / n;
          m[k] = b1 * m[k] + (1 - b1) * g;
          v[k] = b2 * v[k] + (1 - b2) * g * g;
          row[k] -= (lr * (m[k] / c1)) / (Math.sqrt(v[k] / c2) + eps);
        }
        const gbi = gb[i][o] / n;
        this._mb[i][o] = b1 * this._mb[i][o] + (1 - b1) * gbi;
        this._vb[i][o] = b2 * this._vb[i][o] + (1 - b2) * gbi * gbi;
        this.b[i][o] -=
          (lr * (this._mb[i][o] / c1)) / (Math.sqrt(this._vb[i][o] / c2) + eps);
      }
    }
  }

  toJSON() {
    return {
      sizes: this.sizes,
      output: this.output,
      W: this.W.map((W) => W.map((r) => Array.from(r))),
      b: this.b.map((r) => Array.from(r)),
    };
  }

  static fromJSON(obj) {
    const net = new MLP(obj.sizes, { seed: 1, output: obj.output || 'softmax' });
    net.W = obj.W.map((W) => W.map((r) => Float64Array.from(r)));
    net.b = obj.b.map((r) => Float64Array.from(r));
    return net;
  }
}
