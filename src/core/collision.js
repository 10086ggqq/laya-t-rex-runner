/**
 * 碰撞检测：与 Chromium 上游完全一致的 AABB 逐盒判定。
 *
 * 上游写法留了一个"外层盒 + 细盒"两段式判定，这里原样保留，
 * 因为 AI 能不能通过，取决于和官方一模一样的判定结果。
 */
import { TrexCollisionBoxes, TrexConfig } from './constants.js';

export function makeBox(x, y, width, height) {
  return { x, y, width, height };
}

/** 上游 boxCompare */
export function boxCompare(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** 上游 createAdjustedCollisionBox */
export function createAdjustedCollisionBox(box, adjustment) {
  return makeBox(box.x + adjustment.x, box.y + adjustment.y, box.width, box.height);
}

/**
 * 上游 checkForCollision(obstacle, tRex)
 * @returns {{tRexBox:object, obstacleBox:object}|false}
 */
export function checkForCollision(obstacle, trex) {
  const tRexBox = makeBox(
    trex.xPos + 1,
    trex.yPos + 1,
    TrexConfig.WIDTH - 2,
    TrexConfig.HEIGHT - 2
  );

  const obstacleBox = makeBox(
    obstacle.xPos + 1,
    obstacle.yPos + 1,
    obstacle.typeConfig.width * obstacle.size - 2,
    obstacle.typeConfig.height - 2
  );

  if (!boxCompare(tRexBox, obstacleBox)) return false;

  const table = trex.ducking
    ? TrexCollisionBoxes.DUCKING
    : TrexCollisionBoxes.RUNNING;

  for (let t = 0; t < table.length; t++) {
    const adjTrex = createAdjustedCollisionBox(table[t], tRexBox);
    for (let i = 0; i < obstacle.collisionBoxes.length; i++) {
      const adjObs = createAdjustedCollisionBox(obstacle.collisionBoxes[i], obstacleBox);
      if (boxCompare(adjTrex, adjObs)) {
        return { tRexBox: adjTrex, obstacleBox: adjObs };
      }
    }
  }
  return false;
}

/**
 * 给可视化/调试用：把主角当前所有碰撞盒换算到画布绝对坐标。
 * （碰撞盒坐标原本是相对主角包围盒左上角，绘制调试框时需要绝对坐标）
 */
export function trexBoxesAbsolute(trex) {
  const base = makeBox(
    trex.xPos + 1,
    trex.yPos + 1,
    TrexConfig.WIDTH - 2,
    TrexConfig.HEIGHT - 2
  );
  const table = trex.ducking
    ? TrexCollisionBoxes.DUCKING
    : TrexCollisionBoxes.RUNNING;
  return table.map((b) => createAdjustedCollisionBox(b, base));
}

/** 障碍物碰撞盒绝对坐标（含 size 拉伸后的中段修正，与 Obstacle.init 一致） */
export function obstacleBoxesAbsolute(obstacle) {
  const base = makeBox(
    obstacle.xPos + 1,
    obstacle.yPos + 1,
    obstacle.typeConfig.width * obstacle.size - 2,
    obstacle.typeConfig.height - 2
  );
  return obstacle.collisionBoxes.map((b) => createAdjustedCollisionBox(b, base));
}
