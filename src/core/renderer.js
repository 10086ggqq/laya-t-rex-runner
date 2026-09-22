/**
 * renderer.js —— Canvas 精灵渲染（与官方画面同源）
 *
 * 渲染本身不参与判定，AI 拿不到这里的任何信息，所以"看得见"和"会玩"
 * 是两件独立的事。调试模式会把主角/障碍的真实碰撞盒画出来，
 * 方便肉眼核对"这一跳到底差几像素"。
 */
import {
  SpriteDefinition,
  TrexAnimFrames,
  TrexConfig,
  DistanceMeter,
} from './constants.js';
import { trexBoxesAbsolute, obstacleBoxesAbsolute } from './collision.js';

const SPRITE_1X = 'assets/offline-sprite-1x.png';
const SPRITE_2X = 'assets/offline-sprite-2x.png';

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   * @param {number} [opts.scale] 画面放大倍数（2 = 用 2x 精灵图 1:1 呈现）
   * @param {boolean} [opts.debug]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.scale = opts.scale ?? 2;
    this.hidpi = this.scale >= 2;
    this.debug = !!opts.debug;
    this.width = 600;
    this.height = 150;
    this.ctx = canvas.getContext('2d');
    canvas.width = this.width * this.scale;
    canvas.height = this.height * this.scale;
    this.ctx.imageSmoothingEnabled = true;
    this.spritePos = this.hidpi ? SpriteDefinition.HDPI : SpriteDefinition.LDPI;

    // 地平线两块贴图
    this.horizon = {
      width: 600,
      height: 12,
      y: 127,
      x: [0, 600],
      srcX: [this.spritePos.HORIZON.x, this.spritePos.HORIZON.x + 600],
    };
    this.horizonInited = false;
    this.image = null;
    this.ready = false;
    this.lastScore = 0;
  }

  async load() {
    const src = this.hidpi ? SPRITE_2X : SPRITE_1X;
    this.image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`精灵图加载失败：${src}`));
      img.src = src;
    });
    this.ready = true;
    return this;
  }

  _k() {
    return this.hidpi ? 2 : 1; // 源图缩放系数
  }

  _resetHorizon() {
    this.horizon.x = [0, 600];
    this.horizonInited = true;
  }

  /** 推进地平线滚动（纯视觉） */
  _updateHorizon(deltaTime, speed) {
    if (!this.horizonInited) this._resetHorizon();
    const increment = Math.floor(speed * (60 / 1000) * deltaTime);
    const h = this.horizon;
    const line = h.x[0] <= 0 ? 0 : 1;
    const other = line === 0 ? 1 : 0;
    h.x[line] -= increment;
    h.x[other] = h.x[line] + h.width;
    if (h.x[line] <= -h.width) {
      h.x[line] += h.width * 2;
      h.x[other] = h.x[line] - h.width;
    }
  }

  draw(world, opts = {}) {
    const ctx = this.ctx;
    if (!this.ready) return;
    const k = this._k();
    const debug = opts.debug ?? this.debug;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.scale(this.scale, this.scale);

    // 背景
    ctx.fillStyle = opts.bg || '#f7f7f7';
    ctx.fillRect(0, 0, this.width, this.height);

    this._drawHorizon(world, opts);
    this._drawObstacles(world);
    this._drawTrex(world);
    this._drawScore(world, opts);

    if (world.crashed) this._drawRestart();
    if (debug) this._drawDebug(world);
    if (opts.hud) this._drawHud(opts.hud);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  _drawHorizon(world, opts) {
    if (world.playing && !world.crashed) {
      this._updateHorizon(1000 / 60, world.currentSpeed);
    } else if (!this.horizonInited) {
      this._resetHorizon();
    }
    const ctx = this.ctx;
    const k = this._k();
    const h = this.horizon;
    const sp = this.spritePos.HORIZON;
    for (let i = 0; i < 2; i++) {
      ctx.drawImage(
        this.image,
        h.srcX[i],
        sp.y,
        600 * k,
        12 * k,
        Math.round(h.x[i]),
        h.y,
        600,
        12
      );
    }
  }

  _drawObstacles(world) {
    const ctx = this.ctx;
    const k = this._k();
    for (const o of world.horizon.obstacles) {
      const srcW = o.typeConfig.width;
      const srcH = o.typeConfig.height;
      let sourceX = srcW * o.size * (0.5 * (o.size - 1)) + this.spritePos[o.typeConfig.type].x;
      // 帧偏移同样要按图倍率换算：2x 图上翼龙两帧相距 92（46×2）。
      // 少乘 k 会让 currentFrame>0 的那一帧落到帧缝里，翅膀抖成碎片。
      if (o.currentFrame > 0) sourceX += srcW * o.currentFrame * k;
      ctx.drawImage(
        this.image,
        sourceX,
        this.spritePos[o.typeConfig.type].y,
        srcW * o.size * k,
        srcH * k,
        Math.round(o.xPos),
        Math.round(o.yPos),
        o.typeConfig.width * o.size,
        o.typeConfig.height
      );
    }
  }

  _drawTrex(world) {
    const ctx = this.ctx;
    const k = this._k();
    const t = world.trex;
    const ducking = t.ducking && t.status !== 'CRASHED';
    const frame = t.currentAnimFrames[Math.min(t.currentFrame, t.currentAnimFrames.length - 1)];
    // 源矩形必须按精灵图倍率换算：2x 图上恐龙占 88 宽（44×2）、高 94（47×2）。
    // 这里漏乘 k 会只截到恐龙的左半边，是画面"鬼畜"的直接原因之一。
    const srcW = (ducking ? TrexConfig.WIDTH_DUCK : TrexConfig.WIDTH) * k;
    const srcH = TrexConfig.HEIGHT * k;
    const sp = this.spritePos.TREX;
    const dw = ducking ? TrexConfig.WIDTH_DUCK : TrexConfig.WIDTH;

    ctx.drawImage(
      this.image,
      frame + sp.x,
      sp.y,
      srcW,
      srcH,
      Math.round(t.xPos),
      Math.round(t.yPos),
      dw,
      TrexConfig.HEIGHT
    );
  }

  _drawScore(world, opts) {
    const ctx = this.ctx;
    const k = this._k();
    const sp = this.spritePos.TEXT_SPRITE;

    const drawNumber = (value, x, y) => {
      const str = String(Math.max(0, Math.floor(value))).padStart(5, '0').slice(-5);
      for (let i = 0; i < 5; i++) {
        const digit = Number(str[i]);
        ctx.drawImage(
          this.image,
          10 * digit + sp.x,
          sp.y,
          10 * k,
          13 * k,
          Math.round(x + i * 11),
          y,
          10,
          13
        );
      }
    };

    const x0 = this.width - 11 * 6;
    drawNumber(world.score, x0, 5);
    if (opts.best != null) drawNumber(opts.best, x0 - 11 * 6, 5);
  }

  _drawRestart() {
    const ctx = this.ctx;
    const k = this._k();
    const sp = this.spritePos.RESTART;
    const w = 36;
    const h = 32;
    ctx.drawImage(
      this.image,
      sp.x,
      sp.y,
      36 * k,
      32 * k,
      Math.round((this.width - w) / 2),
      Math.round((this.height - h) / 2 - 6),
      w,
      h
    );
  }

  _drawDebug(world) {
    const ctx = this.ctx;

    // 主角碰撞盒
    ctx.strokeStyle = '#e53935';
    ctx.lineWidth = 1;
    for (const b of trexBoxesAbsolute(world.trex)) {
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.width, b.height);
    }

    // 障碍碰撞盒 + 到主角的距离
    for (const o of world.horizon.obstacles) {
      ctx.strokeStyle = '#43a047';
      for (const b of obstacleBoxesAbsolute(o)) {
        ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.width, b.height);
      }
      ctx.strokeStyle = 'rgba(67,160,71,0.45)';
      ctx.setLineDash([3, 3]);
      const dx = o.dxTo(world.trex.xPos);
      if (dx > 0 && dx < 400) {
        ctx.beginPath();
        ctx.moveTo(world.trex.xPos + TrexConfig.WIDTH, 12);
        ctx.lineTo(o.xPos, 12);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#2e7d32';
        ctx.font = '7px monospace';
        ctx.fillText(`${Math.round(dx)}px / ${Math.round(world.ticksToImpact(o))}t`, world.trex.xPos + 46, 10);
      }
      ctx.setLineDash([]);
    }
  }

  _drawHud(hud) {
    const ctx = this.ctx;
    ctx.font = '9px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(hud.text || '', 8, this.height - 6);
    if (hud.action) {
      ctx.font = 'bold 10px ui-monospace, Menlo, monospace';
      ctx.fillStyle = hud.color || '#1a73e8';
      ctx.fillText(hud.action, 8, 14);
    }
  }

  /** 截图成 PNG（用于导出对比图） */
  toDataURL() {
    return this.canvas.toDataURL('image/png');
  }
}

export { TrexAnimFrames, DistanceMeter };
