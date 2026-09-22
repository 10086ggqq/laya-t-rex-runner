/**
 * features.js —— 状态 → 定长特征向量
 *
 * 神经决策头（System 1）的输入。刻意保持低维：27 维，
 * 纯几何量，不做任何"游戏语义"的高层封装，
 * 让网络自己学"什么时候该跳"。
 */
import { RunnerConfig, TrexConfig, GROUND_Y_POS } from '../core/constants.js';

export const FEATURE_DIM = 27;
export const NB_FEATURE_DIM = 3; // 全局 9 维 + 3 个障碍槽 × 6 维

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 把世界状态编码成定长向量 */
export function encodeState(world, out) {
  const f = out || new Float32Array(FEATURE_DIM);
  const t = world.trex;
  const obs = world.pendingObstacles();

  // —— 全局 9 维 ——
  f[0] = world.currentSpeed / RunnerConfig.MAX_SPEED;
  f[1] = clamp(t.clearance / 100, 0, 1.2);
  f[2] = t.jumping ? 1 : 0;
  f[3] = t.ducking ? 1 : 0;
  f[4] = t.speedDrop ? 1 : 0;
  f[5] = clamp(t.jumpVelocity / 15, -1, 1);
  f[6] = clamp(world.score / 5000, 0, 1);
  f[7] = Math.min(obs.length, 3) / 3;
  f[8] = clamp(world.ticks / 10000, 0, 1);

  // —— 3 个最近障碍 × 6 维 ——
  for (let s = 0; s < 3; s++) {
    const o = obs[s];
    const b = 9 + s * 6;
    if (!o) {
      f[b] = 1; // dx 归一化后 1 = "还很远/不存在"
      f[b + 1] = 0;
      f[b + 2] = 0;
      f[b + 3] = 0;
      f[b + 4] = 0;
      f[b + 5] = 0;
      continue;
    }
    f[b] = clamp(o.dxTo(t.xPos) / 600, -0.3, 1);
    f[b + 1] = o.typeConfig.type === 'CACTUS_SMALL' ? 1 : 0;
    f[b + 2] = o.typeConfig.type === 'CACTUS_LARGE' ? 1 : 0;
    f[b + 3] = o.typeConfig.type === 'PTERODACTYL' ? 1 : 0;
    f[b + 4] = o.yPos / 150;
    f[b + 5] = (o.typeConfig.width * o.size) / 75;
  }

  return f;
}

/** 给日志/展示用：把特征翻译成人能读的几行 */
export function describeState(world) {
  const s = world.snapshot();
  const lines = [
    `speed=${s.speed.toFixed(2)}  score=${s.score}  tick=${s.tick}`,
    `trex y=${s.trex.yPos} (clearance ${s.trex.clearance}) ` +
      `${s.trex.jumping ? 'jumping' : s.trex.ducking ? 'ducking' : 'running'}`,
  ];
  if (!s.obstacles.length) lines.push('no obstacle ahead');
  else {
    for (const o of s.obstacles) {
      lines.push(
        `- ${o.type} size=${o.size} dx=${Math.round(o.dx)} y=${o.yPos} ` +
          `w=${o.width} h=${o.height} eta=${Math.round(o.ticksToImpact)}t`
      );
    }
  }
  return lines.join('\n');
}

export { GROUND_Y_POS, TrexConfig };
