/**
 * ui.js —— 浏览器演示：游戏画面 + AI 驾驶舱
 *
 * 驾驶舱刻意把"决策过程"暴露出来，而不是只显示一个分数：
 * 每一帧都在问三个 typed question（选动作 / 有多急 / 不动安不安全），
 * 这里把它们原样画出来，包括被路由到哪条路径、花了多少微秒。
 */
import { Autopilot } from './autopilot.js';
import { Renderer } from './core/renderer.js';
import { BRAINS, brainMeta } from './brains.js';
import { Actions } from './core/constants.js';
import { stateDocument } from './laya/heads.js';
import { describeState } from './laya/features.js';

const $ = (id) => document.getElementById(id);
const fmt = (v, n = 2) => (v == null ? '—' : Number(v).toFixed(n));

const state = {
  autopilot: null,
  renderer: null,
  weights: {},
  running: true,
  stepOnce: false,
  speed: 1,
  seed: 1,
  brainId: 'layalite-neural',
  reactionDelay: 0,
  debug: false,
  best: Number(localStorage.getItem('klrun.best') || 0),
  ticksThisSecond: 0,
  decPerSec: 0,
  fps: 0,
  _acc: 0,
  _lastFpsAt: performance.now(),
  _frames: 0,
};

// ------------------------------------------------------------------ 权重
async function loadWeights() {
  const files = ['brain/weights.json', 'brain/weights-delay8.json'];
  for (const f of files) {
    try {
      const r = await fetch(f, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      const delay = /delay(\d+)/.exec(f) ? Number(/delay(\d+)/.exec(f)[1]) : 0;
      state.weights[delay] = j;
    } catch (e) {
      console.warn(`[klrun] 未能加载 ${f}（先跑 node brain/distill.mjs 生成它）`);
    }
  }
  document.body.dataset.weights = Object.keys(state.weights).join(',') || 'none';
}

function weightsFor(delay) {
  return state.weights[delay] || state.weights[0] || null;
}

// ------------------------------------------------------------------ 构建
function buildAutopilot() {
  const brain = brainMeta(state.brainId);
  let weights = null;
  if (state.brainId.includes('neural')) {
    weights = weightsFor(state.reactionDelay);
    if (!weights) {
      toast('缺少神经权重：请先运行 node brain/distill.mjs');
      state.brainId = 'layalite';
      return buildAutopilot();
    }
  }
  state.autopilot = new Autopilot({
    brainId: state.brainId,
    seed: state.seed,
    reactionDelay: state.reactionDelay,
    weights,
    maxTrace: 60,
  });
  renderBrainSwitch();
  $('brain-hint').textContent = `${brain.label} · ${brain.hint}`;
  setHudColor(brain.color);
}

function renderBrainSwitch() {
  const box = $('brain-switch');
  box.innerHTML = '';
  for (const b of BRAINS) {
    const btn = document.createElement('button');
    btn.className = 'chip' + (b.id === state.brainId ? ' active' : '');
    btn.textContent = b.label;
    btn.title = b.hint;
    btn.style.setProperty('--accent', b.color);
    btn.onclick = async () => {
      state.brainId = b.id;
      buildAutopilot();
      await renderOnce();
    };
    box.appendChild(btn);
  }
}

let hudColor = '#1a73e8';
function setHudColor(c) {
  hudColor = c;
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

// ------------------------------------------------------------------ 渲染
function paintBars(res) {
  const box = $('choice-bars');
  const probs = res.action.probs;
  const max = Math.max(...probs, 0.0001);
  box.innerHTML = '';
  Actions.forEach((a, i) => {
    const p = probs[i] ?? 0;
    const row = document.createElement('div');
    row.className = 'bar-row' + (a === res.action.label ? ' picked' : '');
    row.innerHTML = `
      <span class="bar-label">${a}</span>
      <span class="bar-track"><i style="width:${((p / max) * 100).toFixed(1)}%"></i></span>
      <span class="bar-val">${(p * 100).toFixed(1)}%</span>`;
    box.appendChild(row);
  });
}

function paintCockpit(res) {
  $('chosen-action').textContent = res.action.label;
  $('chosen-action').style.color = actionColor(res.action.label);
  $('chosen-conf').textContent = `${(res.action.confidence * 100).toFixed(1)}%`;

  paintBars(res);

  const u = res.urgency ? res.urgency.value : 0;
  $('urgency-fill').style.width = `${(u * 100).toFixed(0)}%`;
  $('urgency-val').textContent = u.toFixed(3);
  $('urgency-basis').textContent = res.urgency ? res.urgency.basis : '';

  const safe = res.safe_to_idle ? res.safe_to_idle.label === 'yes' : false;
  const nb = $('noul-badge');
  nb.textContent = safe ? '保持不动：安全' : '保持不动：会撞';
  nb.className = 'badge ' + (safe ? 'ok' : 'bad');

  const m = res.meta;
  $('meta-path').textContent = m.path === 'reason' ? 'reason（完整试算）' : 'fast（廉价路径）';
  $('meta-path').className = 'pill ' + m.path;
  $('meta-head').textContent = m.head;
  $('meta-latency').textContent = `${fmt(m.latencyMs, 3)} ms`;
  $('meta-why').textContent = m.routeWhy;
  if (res.meta.cost && res.meta.cost.candidates) {
    $('meta-cost').textContent = `试算 ${res.meta.cost.candidates} 个计划 / ${res.meta.cost.steps} 帧`;
  } else {
    $('meta-cost').textContent = '';
  }
}

function actionColor(a) {
  return { NONE: '#5f6368', JUMP: '#1a73e8', DUCK: '#8430ce', DROP: '#e8710a' }[a] || '#5f6368';
}

function paintLog() {
  const tbody = $('log-body');
  const rows = state.autopilot.trace.slice(-11).reverse();
  tbody.innerHTML = rows
    .map(
      (t) => `<tr>
        <td class="num">${t.tick}</td>
        <td><span class="dot" style="background:${actionColor(t.action)}"></span>${t.action}</td>
        <td class="num">${(t.confidence * 100).toFixed(0)}%</td>
        <td class="num">${fmt(t.urgency, 2)}</td>
        <td>${t.safe === 'yes' ? '<span class="mini ok">安全</span>' : '<span class="mini bad">危险</span>'}</td>
        <td><span class="mini ${t.path}">${t.path}</span></td>
        <td class="num">${fmt(t.latencyMs, 3)}</td>
      </tr>`
    )
    .join('');
}

function paintStats() {
  const p = state.autopilot;
  const s = p.stats;
  $('stat-score').textContent = s.score;
  $('stat-best').textContent = state.best;
  $('stat-ticks').textContent = s.ticks;
  $('stat-speed').textContent = fmt(s.speed, 2);
  $('stat-dps').textContent = Math.round(state.decPerSec);
  $('stat-fps').textContent = Math.round(state.fps);
  const lat = s.latency;
  $('stat-lat').textContent = lat && lat.n ? `${fmt(lat.avg, 3)} / ${fmt(lat.p95, 3)}` : '—';
  $('stat-calls').textContent = s.calls;
  $('stat-actions').textContent =
    `N${s.actions.NONE} / J${s.actions.JUMP} / D${s.actions.DUCK} / F${s.actions.DROP}`;
  $('state-doc').textContent = describeState(p.world);
}

function paintCanvas(res) {
  const p = state.autopilot;
  state.renderer.draw(p.world, {
    debug: state.debug,
    best: state.best,
    hud: res
      ? {
          action: `${res.action.label}  ${(res.action.confidence * 100).toFixed(0)}%`,
          color: actionColor(res.action.label),
          text:
            `${state.brainId} · ${state.reactionDelay}f 延迟 · ` +
            `${res.meta.path} · ${fmt(res.meta.latencyMs, 3)}ms · 得分 ${p.world.score}` +
            (p.world.crashed ? ' · 已撞车' : ''),
        }
      : null,
  });
}

async function renderOnce(res) {
  paintCockpit(res || state.autopilot.last || blankResult());
  paintCanvas(res);
  paintLog();
  paintStats();
}

function blankResult() {
  return {
    action: { label: state.autopilot.world.lastAction, probs: [0.25, 0.25, 0.25, 0.25], confidence: 0.25 },
    urgency: { value: 0, basis: '' },
    safe_to_idle: { label: 'yes' },
    meta: { path: 'fast', head: '-', latencyMs: 0, routeWhy: '等待首帧' },
  };
}

// ------------------------------------------------------------------ 主循环
function loop(now) {
  requestAnimationFrame(loop);
  const p = state.autopilot;

  const dt = now - state._lastFpsAt;
  if (dt >= 500) {
    state.fps = (state._frames * 1000) / dt;
    state.decPerSec = (state.ticksThisSecond * 1000) / dt;
    state._frames = 0;
    state.ticksThisSecond = 0;
    state._lastFpsAt = now;
  }
  state._frames++;

  let last = null;
  if (!state.running && !state.stepOnce) {
    paintCanvas(null);
    paintStats();
    return;
  }
  if (p.remote) {
    // 远端大脑由 startRemotePump 驱动
    return;
  }

  const budget = state.stepOnce ? 1 : state.speed;
  state.stepOnce = false;

  for (let i = 0; i < budget; i++) {
    if (p.crashed) {
      if (p.world.score > state.best) {
        state.best = p.world.score;
        localStorage.setItem('klrun.best', String(state.best));
      }
      break;
    }
    try {
      if (p.remote) break; // 远端大脑走异步路径
      last = p.tick();
      state.ticksThisSecond++;
    } catch (err) {
      state.running = false;
      toast(String(err.message || err));
      break;
    }
  }

  paintCanvas(last);
  if (last) paintCockpit(last);
  paintLog();
  paintStats();
}

// ------------------------------------------------------------------ 基准测试
async function runBench() {
  const btn = $('bench-run');
  btn.disabled = true;
  btn.textContent = '评测中…';
  const tbody = $('bench-body');
  tbody.innerHTML = '<tr><td colspan="7" class="muted">正在同种子对比各大脑，请稍候…</td></tr>';

  try {
    const worker = new Worker('src/bench.worker.js', { type: 'module' });
    const episodes = Number($('bench-episodes').value || 6);
    const delays = [0, 8];
    const brainIds = ['random', 'rule', 'planner', 'neural', 'layalite', 'layalite-neural'];
    const payload = {
      brainIds,
      delays,
      episodes,
      maxTicks: 20000,
      seedBase: 1000,
      weights: state.weights,
    };
    const rows = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        if (e.data.type === 'progress') {
          $('bench-progress').textContent = `${e.data.brainId} @ ${e.data.delay}f  ${e.data.i + 1}/${e.data.episodes}`;
        } else if (e.data.type === 'done') {
          resolve(e.data.rows);
        } else if (e.data.type === 'error') {
          reject(new Error(e.data.message));
        }
      };
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage(payload);
    });
    worker.terminate();
    $('bench-progress').textContent = '';
    renderBench(rows);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="bad">评测失败：${e.message}</td></tr>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '重新评测';
  }
}

function renderBench(rows) {
  const tbody = $('bench-body');
  tbody.innerHTML = rows
    .map((r) => {
      const meta = brainMeta(r.brain);
      const capped = r.capped === 1 ? ' <span class="mini ok">封顶</span>' : '';
      return `<tr>
        <td><span class="dot" style="background:${meta.color}"></span>${meta.label}</td>
        <td class="num">${r.delay}f</td>
        <td class="num strong">${Math.round(r.mean)}${capped}</td>
        <td class="num">${r.median}</td>
        <td class="num">${r.min} – ${r.max}</td>
        <td class="num ${r.crash === 1 ? 'bad' : 'ok'}">${(r.crash * 100).toFixed(0)}%</td>
        <td class="num">${(r.reasonRatio * 100).toFixed(0)}%</td>
        <td class="num">${fmt(r.avgMs, 3)}</td>
      </tr>`;
    })
    .join('');
}

// ------------------------------------------------------------------ 事件
function bind() {
  $('speed').oninput = (e) => {
    state.speed = Number(e.target.value);
    $('speed-val').textContent = `${state.speed}×`;
  };
  $('delay').oninput = (e) => {
    state.reactionDelay = Number(e.target.value);
    $('delay-val').textContent = `${state.reactionDelay} 帧（${Math.round(state.reactionDelay * 16.67)}ms）`;
    buildAutopilot();
  };
  $('seed').onchange = (e) => {
    state.seed = Number(e.target.value) || 1;
    state.autopilot.seed = state.seed;
    state.autopilot.reset(state.seed);
  };
  $('reroll').onclick = () => {
    state.seed = Math.floor(Math.random() * 99999) + 1;
    $('seed').value = state.seed;
    state.autopilot.seed = state.seed;
    state.autopilot.reset(state.seed);
  };
  $('restart').onclick = () => {
    state.autopilot.reset(state.seed);
    state.running = true;
    $('pause').textContent = '暂停';
  };
  $('pause').onclick = () => {
    state.running = !state.running;
    $('pause').textContent = state.running ? '暂停' : '继续';
  };
  $('step').onclick = () => {
    state.running = false;
    $('pause').textContent = '继续';
    state.stepOnce = true;
  };
  $('debug').onchange = (e) => {
    state.debug = e.target.checked;
    state.renderer.debug = state.debug;
  };
  $('bench-run').onclick = runBench;
  $('bench-episodes').onchange = () => {};
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      $('pause').click();
    }
  });
}

// ------------------------------------------------------------------ 启动
async function main() {
  state.renderer = new Renderer($('game'), { scale: 2 });
  try {
    await state.renderer.load();
  } catch (e) {
    toast('精灵图加载失败，请用本地静态服务器打开（npm run serve）');
    return;
  }
  await loadWeights();
  bind();
  buildAutopilot();
  await renderOnce();
  requestAnimationFrame(loop);
  if (!Object.keys(state.weights).length) {
    toast('未找到 brain/weights.json —— 神经大脑不可用，可先用 LayaLite（规划器）。');
  }
}

main();
