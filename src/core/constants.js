/**
 * constants.js
 *
 * 全部数值直接抄自 Chromium 内置小恐龙（T-Rex Runner）源码，
 * 上游镜像：https://github.com/wayou/t-rex-runner (gh-pages)
 * 对应 Chromium: components/neterror/resources/offline.js
 *
 * 保留原名以便和上游逐行对照，方便核对 AI 决策是否"公平地"基于同一套物理。
 */

export const FPS = 60;
export const MS_PER_FRAME = 1000 / FPS; // 16.6667 ms
export const DEFAULT_WIDTH = 600;
export const DEFAULT_HEIGHT = 150;

/** Runner.config —— 全局环境参数 */
export const RunnerConfig = {
  ACCELERATION: 0.001, // 每帧速度增量
  BOTTOM_PAD: 10,
  CLEAR_TIME: 3000, // 开局 3s 不生成障碍
  GAP_COEFFICIENT: 0.6,
  GRAVITY: 0.6, // 世界重力（用于速度换算，仅作参考）
  INITIAL_JUMP_VELOCITY: 12,
  MAX_OBSTACLE_LENGTH: 3,
  MAX_OBSTACLE_DUPLICATION: 2,
  MAX_SPEED: 13, // 速度上限
  MIN_JUMP_HEIGHT: 35,
  SPEED: 6, // 起始速度
  MAX_GAP_COEFFICIENT: 1.5,
};

/** Trex.config —— 主角参数 */
export const TrexConfig = {
  DROP_VELOCITY: -5, // 松手后上升速度被钳制到的值
  GRAVITY: 0.6,
  HEIGHT: 47,
  HEIGHT_DUCK: 25,
  INITIAL_JUMP_VELOCITY: -10, // 起跳初速度
  MAX_JUMP_HEIGHT: 30, // 到达该 y 时开始收力
  MIN_JUMP_HEIGHT: 30,
  SPEED_DROP_COEFFICIENT: 3, // 空中按下的加速下坠倍率
  SPRITE_WIDTH: 262,
  START_X_POS: 50, // 主角固定 x
  WIDTH: 44,
  WIDTH_DUCK: 59,
};

/** 主角站在地面时的 y */
export const GROUND_Y_POS =
  DEFAULT_HEIGHT - TrexConfig.HEIGHT - RunnerConfig.BOTTOM_PAD; // 93
/** 起跳最小高度对应的 y（低于此值视为"达到最小高度"） */
export const MIN_JUMP_Y = GROUND_Y_POS - TrexConfig.MIN_JUMP_HEIGHT; // 63

/** 碰撞盒（相对坐标，与上游一致） */
export const TrexCollisionBoxes = {
  DUCKING: [{ x: 1, y: 18, width: 55, height: 25 }],
  RUNNING: [
    { x: 22, y: 0, width: 17, height: 16 },
    { x: 1, y: 18, width: 30, height: 9 },
    { x: 10, y: 35, width: 14, height: 8 },
    { x: 1, y: 24, width: 29, height: 5 },
    { x: 5, y: 30, width: 21, height: 4 },
    { x: 9, y: 34, width: 15, height: 4 },
  ],
};

/** 动作空间（本项目的扩展：把键盘语义抽象成 4 个 typed action） */
export const Actions = ['NONE', 'JUMP', 'DUCK', 'DROP'];
export const ActionIndex = { NONE: 0, JUMP: 1, DUCK: 2, DROP: 3 };

/**
 * 障碍物类型表。
 * minGap      障碍物之间的最小像素间距
 * multipleSpeed 允许多个并排出现的最小速度
 * speedOffset 相对地平线的速度偏移（翼龙专属）
 */
export const ObstacleTypes = [
  {
    type: 'CACTUS_SMALL',
    width: 17,
    height: 35,
    yPos: 105,
    multipleSpeed: 4,
    minGap: 120,
    minSpeed: 0,
    collisionBoxes: [
      { x: 0, y: 7, width: 5, height: 27 },
      { x: 4, y: 0, width: 6, height: 34 },
      { x: 10, y: 4, width: 7, height: 14 },
    ],
  },
  {
    type: 'CACTUS_LARGE',
    width: 25,
    height: 50,
    yPos: 90,
    multipleSpeed: 7,
    minGap: 120,
    minSpeed: 0,
    collisionBoxes: [
      { x: 0, y: 12, width: 7, height: 38 },
      { x: 8, y: 0, width: 7, height: 49 },
      { x: 13, y: 10, width: 10, height: 38 },
    ],
  },
  {
    type: 'PTERODACTYL',
    width: 46,
    height: 40,
    yPos: [100, 75, 50], // 可变高度
    yPosMobile: [100, 50],
    multipleSpeed: 999,
    minSpeed: 8.5, // 速度 8.5 之后才会出现
    minGap: 150,
    collisionBoxes: [
      { x: 15, y: 15, width: 16, height: 5 },
      { x: 18, y: 21, width: 24, height: 6 },
      { x: 2, y: 14, width: 4, height: 3 },
      { x: 6, y: 10, width: 4, height: 7 },
      { x: 10, y: 8, width: 6, height: 9 },
    ],
    numFrames: 2,
    frameRate: 1000 / 6,
    speedOffset: 0.8,
  },
];

/** 精灵图内坐标（LDPI = 1x 图，HDPI = 2x 图） */
export const SpriteDefinition = {
  LDPI: {
    CACTUS_LARGE: { x: 332, y: 2 },
    CACTUS_SMALL: { x: 228, y: 2 },
    CLOUD: { x: 86, y: 2 },
    HORIZON: { x: 2, y: 54 },
    MOON: { x: 484, y: 2 },
    PTERODACTYL: { x: 134, y: 2 },
    RESTART: { x: 2, y: 2 },
    TEXT_SPRITE: { x: 655, y: 2 },
    TREX: { x: 848, y: 2 },
    STAR: { x: 645, y: 2 },
  },
  HDPI: {
    CACTUS_LARGE: { x: 652, y: 2 },
    CACTUS_SMALL: { x: 446, y: 2 },
    CLOUD: { x: 166, y: 2 },
    HORIZON: { x: 2, y: 104 },
    MOON: { x: 954, y: 2 },
    PTERODACTYL: { x: 260, y: 2 },
    RESTART: { x: 2, y: 2 },
    TEXT_SPRITE: { x: 1294, y: 2 },
    TREX: { x: 1678, y: 2 },
    STAR: { x: 1276, y: 2 },
  },
};

/**
 * Trex 动画帧（sprite 内的 x 偏移）。
 *
 * 这些偏移必须是 2x 精灵图上的真实帧起点：站立/跑动帧间隔 88（44×2），
 * 低头帧间隔 118（59×2）。原来的 [44, 0] / [88, 132] / [220] / [264, 323]
 * 是 1x 语义，直接套在 2x 图上会让其中一半的帧落进帧与帧之间的缝隙，
 * 取到"半只恐龙"或隔壁帧的残片 —— 画面看起来就在抽搐，即所谓的鬼畜。
 */
export const TrexAnimFrames = {
  WAITING: { frames: [0, 88], msPerFrame: 1000 / 3 },
  RUNNING: { frames: [0, 88], msPerFrame: 1000 / 12 },
  CRASHED: { frames: [88], msPerFrame: 1000 / 60 },
  JUMPING: { frames: [0], msPerFrame: 1000 / 60 },
  DUCKING: { frames: [176, 294], msPerFrame: 1000 / 8 },
};

export const DistanceMeter = {
  dimensions: { WIDTH: 10, HEIGHT: 13, DEST_WIDTH: 11 },
  yPos: [0, 13, 27, 40, 53, 67, 80, 93, 107, 120],
  MAX_DISTANCE_UNITS: 5,
  COEFFICIENT: 0.025, // 像素距离 → 分数
};
