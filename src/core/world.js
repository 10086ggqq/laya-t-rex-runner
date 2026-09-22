/**
 * world.js —— 确定性游戏内核
 *
 * 目标：把 Chromium 小恐龙的"物理 + 生成 + 判定"完整搬到一个可以
 * 单帧步进（step）、可以分叉（clone）、可以重放（seed）的对象里。
 *
 * 为什么必须确定性 + 可分叉：
 *   1) AI 需要"试算"——规划器会克隆世界、把候选动作跑几十帧看会不会撞；
 *   2) 评测需要公平——同一 seed 下 4 个大脑走同一串障碍；
 *   3) 训练需要数据——同一局可以反复采样，标签不会漂。
 *
 * 与上游的差异（仅一处，已注释）：`speedDrop` 落地后是否自动切鸭子，
 * 本项目额外要求"下键确实被按着"，否则 DROP 动作会意外变成蹲下。
 */
import {
  RunnerConfig,
  TrexConfig,
  MS_PER_FRAME,
  FPS,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  GROUND_Y_POS,
  MIN_JUMP_Y,
  ObstacleTypes,
  TrexAnimFrames,
  DistanceMeter,
} from './constants.js';
import { Rng } from './rng.js';
import { checkForCollision } from './collision.js';

export const TrexStatus = {
  CRASHED: 'CRASHED',
  DUCKING: 'DUCKING',
  JUMPING: 'JUMPING',
  RUNNING: 'RUNNING',
  WAITING: 'WAITING',
};

/** 障碍物：与上游 Obstacle 一一对应 */
export class Obstacle {
  constructor(typeConfig, dimensions, gapCoefficient, speed, xOffset, rng) {
    this.typeConfig = typeConfig;
    this.gapCoefficient = gapCoefficient;
    this.rng = rng;
    this.size = rng.int(1, RunnerConfig.MAX_OBSTACLE_LENGTH);
    this.dimensions = dimensions;
    this.remove = false;
    this.xPos = dimensions.WIDTH + (xOffset || 0);
    this.yPos = 0;
    this.width = 0;
    this.collisionBoxes = [];
    this.gap = 0;
    this.speedOffset = 0;
    this.currentFrame = 0;
    this.timer = 0;
    this.followingObstacleCreated = false;
    this.init(speed);
  }

  init(speed) {
    this.cloneCollisionBoxes();

    if (this.size > 1 && this.typeConfig.multipleSpeed > speed) {
      this.size = 1;
    }

    this.width = this.typeConfig.width * this.size;

    if (Array.isArray(this.typeConfig.yPos)) {
      this.yPos = this.rng.pick(this.typeConfig.yPos);
    } else {
      this.yPos = this.typeConfig.yPos;
    }

    // 并排障碍：中段盒子被拉宽，右段盒子贴到最右（与上游一致）
    if (this.size > 1) {
      this.collisionBoxes[1].width =
        this.width - this.collisionBoxes[0].width - this.collisionBoxes[2].width;
      this.collisionBoxes[2].x = this.width - this.collisionBoxes[2].width;
    }

    if (this.typeConfig.speedOffset) {
      this.speedOffset = this.rng.chance(0.5)
        ? this.typeConfig.speedOffset
        : -this.typeConfig.speedOffset;
    }

    this.gap = this.getGap(this.gapCoefficient, speed);
  }

  cloneCollisionBoxes() {
    const src = this.typeConfig.collisionBoxes;
    for (let i = src.length - 1; i >= 0; i--) {
      this.collisionBoxes[i] = {
        x: src[i].x,
        y: src[i].y,
        width: src[i].width,
        height: src[i].height,
      };
    }
  }

  update(deltaTime, speed) {
    if (this.remove) return;
    let s = speed;
    if (this.typeConfig.speedOffset) s += this.speedOffset;
    this.xPos -= Math.floor(((s * FPS) / 1000) * deltaTime);

    if (this.typeConfig.numFrames) {
      this.timer += deltaTime;
      if (this.timer >= this.typeConfig.frameRate) {
        this.currentFrame =
          this.currentFrame === this.typeConfig.numFrames - 1 ? 0 : this.currentFrame + 1;
        this.timer = 0;
      }
    }

    if (!this.isVisible()) this.remove = true;
  }

  getGap(gapCoefficient, speed) {
    const minGap = Math.round(this.width * speed + this.typeConfig.minGap * gapCoefficient);
    const maxGap = Math.round(minGap * RunnerConfig.MAX_GAP_COEFFICIENT);
    return this.rng.int(minGap, maxGap);
  }

  isVisible() {
    return this.xPos + this.width > 0;
  }

  /** 障碍物右边缘到主角左边缘的像素距离（负数表示已越过主角） */
  dxTo(trexXPos) {
    return this.xPos - (trexXPos + TrexConfig.WIDTH);
  }
}

/** 主角：与上游 Trex 一一对应 */
export class Trex {
  constructor() {
    this.config = TrexConfig;
    this.xPos = TrexConfig.START_X_POS;
    this.yPos = GROUND_Y_POS;
    this.groundYPos = GROUND_Y_POS;
    this.minJumpHeight = MIN_JUMP_Y;
    this.currentFrame = 0;
    this.currentAnimFrames = TrexAnimFrames.WAITING.frames;
    this.msPerFrame = TrexAnimFrames.WAITING.msPerFrame;
    this.timer = 0;
    this.status = TrexStatus.WAITING;
    this.jumping = false;
    this.ducking = false;
    this.duckHeld = false; // 本项目的输入状态（下键是否按住）
    this.jumpVelocity = 0;
    this.reachedMinHeight = false;
    this.speedDrop = false;
    this.jumpCount = 0;
  }

  update(deltaTime, opt_status) {
    this.timer += deltaTime;

    if (opt_status) {
      this.status = opt_status;
      this.currentFrame = 0;
      this.msPerFrame = TrexAnimFrames[opt_status].msPerFrame;
      this.currentAnimFrames = TrexAnimFrames[opt_status].frames;
    }

    if (this.timer >= this.msPerFrame) {
      this.currentFrame =
        this.currentFrame === this.currentAnimFrames.length - 1 ? 0 : this.currentFrame + 1;
      this.timer = 0;
    }

    // 上游：speedDrop 落地后自动蹲下。这里多加 duckHeld 判定（见文件头注释）
    if (this.speedDrop && this.yPos === this.groundYPos) {
      this.speedDrop = false;
      if (this.duckHeld) this.setDuck(true);
    }
  }

  startJump(speed) {
    if (this.jumping) return;
    this.update(0, TrexStatus.JUMPING);
    this.jumpVelocity = this.config.INITIAL_JUMP_VELOCITY - speed / 10;
    this.jumping = true;
    this.reachedMinHeight = false;
    this.speedDrop = false;
  }

  endJump() {
    if (this.reachedMinHeight && this.jumpVelocity < this.config.DROP_VELOCITY) {
      this.jumpVelocity = this.config.DROP_VELOCITY;
    }
  }

  updateJump(deltaTime) {
    const msPerFrame = TrexAnimFrames[this.status].msPerFrame;
    const framesElapsed = deltaTime / msPerFrame;

    if (this.speedDrop) {
      this.yPos += Math.round(this.jumpVelocity * this.config.SPEED_DROP_COEFFICIENT * framesElapsed);
    } else {
      this.yPos += Math.round(this.jumpVelocity * framesElapsed);
    }
    this.jumpVelocity += this.config.GRAVITY * framesElapsed;

    if (this.yPos < this.minJumpHeight || this.speedDrop) this.reachedMinHeight = true;
    if (this.yPos < this.config.MAX_JUMP_HEIGHT || this.speedDrop) this.endJump();

    if (this.yPos > this.groundYPos) {
      this.reset();
      this.jumpCount++;
    }

    this.update(deltaTime);
  }

  setSpeedDrop() {
    this.speedDrop = true;
    this.jumpVelocity = 1;
  }

  setDuck(isDucking) {
    if (isDucking && this.status !== TrexStatus.DUCKING) {
      this.update(0, TrexStatus.DUCKING);
      this.ducking = true;
    } else if (!isDucking && this.status === TrexStatus.DUCKING) {
      this.update(0, TrexStatus.RUNNING);
      this.ducking = false;
    }
  }

  reset() {
    this.yPos = this.groundYPos;
    this.jumpVelocity = 0;
    this.jumping = false;
    this.ducking = false;
    this.update(0, TrexStatus.RUNNING);
    this.speedDrop = false;
    this.jumpCount = 0;
  }

  /** 离地高度（像素） */
  get clearance() {
    return this.groundYPos - this.yPos;
  }

  clone() {
    const t = new Trex();
    Object.assign(t, this);
    t.currentAnimFrames = this.currentAnimFrames.slice();
    return t;
  }
}

/** 地平线层：只保留障碍物与生成逻辑（云/昼夜不影响判定） */
export class Horizon {
  constructor(dimensions, gapCoefficient, rng) {
    this.dimensions = dimensions;
    this.gapCoefficient = gapCoefficient;
    this.rng = rng;
    this.obstacles = [];
    this.obstacleHistory = [];
    this.runningTime = 0;
  }

  update(deltaTime, currentSpeed, updateObstacles) {
    this.runningTime += deltaTime;
    if (updateObstacles) this.updateObstacles(deltaTime, currentSpeed);
  }

  updateObstacles(deltaTime, currentSpeed) {
    const updated = this.obstacles.slice(0);

    for (let i = 0; i < this.obstacles.length; i++) {
      const obstacle = this.obstacles[i];
      obstacle.update(deltaTime, currentSpeed);
      if (obstacle.remove) updated.shift();
    }
    this.obstacles = updated;

    if (this.obstacles.length > 0) {
      const last = this.obstacles[this.obstacles.length - 1];
      if (
        last &&
        !last.followingObstacleCreated &&
        last.isVisible() &&
        last.xPos + last.width + last.gap < this.dimensions.WIDTH
      ) {
        this.addNewObstacle(currentSpeed);
        last.followingObstacleCreated = true;
      }
    } else {
      this.addNewObstacle(currentSpeed);
    }
  }

  addNewObstacle(currentSpeed) {
    const idx = this.rng.int(0, ObstacleTypes.length - 1);
    const type = ObstacleTypes[idx];

    if (this.duplicateObstacleCheck(type.type) || currentSpeed < type.minSpeed) {
      this.addNewObstacle(currentSpeed);
      return;
    }

    this.obstacles.push(
      new Obstacle(type, this.dimensions, this.gapCoefficient, currentSpeed, type.width, this.rng)
    );
    this.obstacleHistory.unshift(type.type);
    if (this.obstacleHistory.length > 1) {
      this.obstacleHistory.splice(RunnerConfig.MAX_OBSTACLE_DUPLICATION);
    }
  }

  duplicateObstacleCheck(nextType) {
    let dup = 0;
    for (let i = 0; i < this.obstacleHistory.length; i++) {
      dup = this.obstacleHistory[i] === nextType ? dup + 1 : 0;
    }
    return dup >= RunnerConfig.MAX_OBSTACLE_DUPLICATION;
  }

  clone(rng) {
    const h = new Horizon(this.dimensions, this.gapCoefficient, rng);
    h.runningTime = this.runningTime;
    h.obstacleHistory = this.obstacleHistory.slice();
    h.obstacles = this.obstacles.map((o) => {
      const c = Object.create(Obstacle.prototype);
      Object.assign(c, o);
      c.collisionBoxes = o.collisionBoxes.map((b) => ({ ...b }));
      c.rng = rng;
      return c;
    });
    return h;
  }
}

/**
 * World —— 一个完整可重放的对局。
 *
 * 用法：
 *   const w = new World({ seed: 42 });
 *   w.act('JUMP');
 *   w.step();
 */
export class World {
  constructor(opts = {}) {
    this.width = opts.width || DEFAULT_WIDTH;
    this.height = opts.height || DEFAULT_HEIGHT;
    this.gapCoefficient = opts.gapCoefficient ?? RunnerConfig.GAP_COEFFICIENT;
    this.dimensions = { WIDTH: this.width, HEIGHT: this.height };
    this.seed = opts.seed ?? 1;
    this.reset(this.seed);
  }

  reset(seed = this.seed) {
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.trex = new Trex();
    this.horizon = new Horizon(this.dimensions, this.gapCoefficient, this.rng);
    this.currentSpeed = RunnerConfig.SPEED;
    this.runningTime = 0;
    this.distanceRan = 0;
    this.ticks = 0;
    this.playing = true;
    this.crashed = false;
    this.lastAction = 'NONE';
    // 直接跳过上游的"入场动画"，让 AI 从第 0 帧就开始接管
    this.trex.xPos = TrexConfig.START_X_POS;
    this.trex.update(0, TrexStatus.RUNNING);
    return this;
  }

  /** 执行一个 typed action（语义等价于上游的键盘事件） */
  act(action) {
    this.lastAction = action;
    const t = this.trex;
    if (!this.playing || this.crashed) return;

    switch (action) {
      case 'JUMP':
        t.duckHeld = false;
        if (t.ducking) {
          t.speedDrop = false;
          t.setDuck(false);
        }
        t.startJump(this.currentSpeed);
        break;

      case 'DUCK':
        t.duckHeld = true;
        if (t.jumping) {
          if (!t.speedDrop) t.setSpeedDrop();
        } else if (!t.ducking) {
          t.setDuck(true);
        }
        break;

      case 'DROP':
        t.duckHeld = false;
        if (t.jumping && !t.speedDrop) t.setSpeedDrop();
        break;

      case 'NONE':
      default:
        t.duckHeld = false;
        if (t.jumping) t.endJump();
        if (t.ducking || t.speedDrop) {
          t.speedDrop = false;
          t.setDuck(false);
        }
        break;
    }
  }

  /** 推进一帧（默认 16.667ms，即 60fps） */
  step(deltaTime = MS_PER_FRAME) {
    if (!this.playing || this.crashed) {
      this.trex.update(deltaTime);
      return;
    }

    this.ticks++;

    if (this.trex.jumping) this.trex.updateJump(deltaTime);

    this.runningTime += deltaTime;
    const hasObstacles = this.runningTime > RunnerConfig.CLEAR_TIME;

    this.horizon.update(deltaTime, this.currentSpeed, hasObstacles);

    const collision =
      hasObstacles && checkForCollision(this.horizon.obstacles[0], this.trex);

    if (!collision) {
      this.distanceRan += (this.currentSpeed * deltaTime) / MS_PER_FRAME;
      if (this.currentSpeed < RunnerConfig.MAX_SPEED) {
        this.currentSpeed += RunnerConfig.ACCELERATION;
      }
    } else {
      this.gameOver();
    }

    this.trex.update(deltaTime);
  }

  gameOver() {
    this.playing = false;
    this.crashed = true;
    this.trex.update(0, TrexStatus.CRASHED);
  }

  /** 展示用分数（与上游 DistanceMeter 一致） */
  get score() {
    return Math.round(Math.ceil(this.distanceRan) * DistanceMeter.COEFFICIENT);
  }

  /** 当前及前方障碍物（按 x 排序，已过滤身后的） */
  pendingObstacles() {
    return this.horizon.obstacles.filter(
      (o) => o.xPos + o.width > this.trex.xPos + 2
    );
  }

  /** 最近的可碰撞障碍物 */
  nextObstacle() {
    return this.pendingObstacles()[0] || null;
  }

  /** 给规则大脑用：下一个障碍物还有多少帧撞上来 */
  ticksToImpact(obstacle) {
    if (!obstacle) return Infinity;
    const dx = obstacle.dxTo(this.trex.xPos);
    const perTick = this.currentSpeed; // 每帧位移 ≈ speed * 1.0 px
    return Math.max(0, dx) / Math.max(0.001, perTick);
  }

  /**
   * 状态快照：既是给 Laya 的 state document 原料，也是神经网络的特征原料。
   */
  snapshot() {
    const obstacles = this.pendingObstacles().slice(0, 3).map((o) => ({
      type: o.typeConfig.type,
      size: o.size,
      xPos: o.xPos,
      yPos: o.yPos,
      width: o.width,
      height: o.typeConfig.height,
      gap: o.gap,
      dx: o.dxTo(this.trex.xPos),
      ticksToImpact: this.ticksToImpact(o),
    }));

    return {
      tick: this.ticks,
      speed: this.currentSpeed,
      score: this.score,
      distanceRan: this.distanceRan,
      crashed: this.crashed,
      trex: {
        xPos: this.trex.xPos,
        yPos: this.trex.yPos,
        clearance: this.trex.clearance,
        groundYPos: this.trex.groundYPos,
        jumping: this.trex.jumping,
        ducking: this.trex.ducking,
        speedDrop: this.trex.speedDrop,
        jumpVelocity: this.trex.jumpVelocity,
        status: this.trex.status,
      },
      obstacles,
    };
  }

  /**
   * 分叉出一个独立世界（用于试算）。
   * 随机流也被复制，所以"如果我不跳"和"如果我跳"未来面对的是同一串障碍。
   */
  clone() {
    const w = Object.create(World.prototype);
    w.width = this.width;
    w.height = this.height;
    w.gapCoefficient = this.gapCoefficient;
    w.dimensions = this.dimensions;
    w.seed = this.seed;
    const rng = new Rng(0);
    rng.seed = this.rng.seed;
    rng.s = this.rng.s;
    w.rng = rng;
    w.trex = this.trex.clone();
    w.horizon = this.horizon.clone(rng);
    w.currentSpeed = this.currentSpeed;
    w.runningTime = this.runningTime;
    w.distanceRan = this.distanceRan;
    w.ticks = this.ticks;
    w.playing = this.playing;
    w.crashed = this.crashed;
    w.lastAction = this.lastAction;
    return w;
  }
}
