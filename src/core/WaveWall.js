/**
 * 字之山 — 夜山水墨（生成式 + 动态）
 *
 * 第一性原理：夜山是"剪影与月光"——
 *   · 三远法：远山淡灰、中景重灰、近山焦黑，层层叠压退让；
 *   · 山脚虚：每层山体从山脊往下渐虚，如墨被夜雾吞没；
 *   · 月光雾：淡金雾带横贯山腰，是夜山的空间呼吸。
 *
 * 动态生命感：
 *   · 雁阵——一小队飞鸟（淡金简笔"人"形）缓缓掠过夜空，扇翅、列队、循环；
 *   · 流雾——淡金雾带缓缓漂移，山如浮于夜雾；
 *   · 月轮——暖金月轮带呼吸光晕，照亮山脊；
 *   · 水面——底部墨色水面微波荡漾，倒映月光。
 *
 * 山形：中点位移分形山脊（带棱角）+ 高斯主峰。皴法文字贴山脸、随坡度倾斜，
 * 呈暖金色（月光下的金字皴法）。R 键重新生成山水。点击字溯源。
 */
import { glyphCache } from './GlyphCache.js';

const rand = (a, b) => a + Math.random() * (b - a);

/**
 * 中点位移法生成山脊折线。
 * 返回 [{x, y}]（x ∈ 0..1 单调递增，y 为屏幕高度比例，值越小山越高）。
 * 折线保留棱角——正是斧劈皴山的骨架，不做平滑。
 */
function fractalRidge(x0, x1, baseY, amp, depth) {
  let pts = [
    { x: x0, y: baseY + rand(-amp, amp) * 0.4 },
    { x: x1, y: baseY + rand(-amp, amp) * 0.4 },
  ];
  let curAmp = amp;
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      next.push(a);
      next.push({
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2 + rand(-curAmp, curAmp),
      });
    }
    next.push(pts[pts.length - 1]);
    pts = next;
    curAmp *= 0.52;
  }
  for (const p of pts) p.y = Math.max(0.06, Math.min(0.88, p.y));
  return pts;
}

/** 在生成好的山脊上叠加一个高斯主峰（塑造构图重心） */
function addPeak(ridge, peakX, height, width) {
  for (const p of ridge) {
    p.y -= height * Math.exp(-((p.x - peakX) ** 2) / (2 * width * width));
  }
  for (const p of ridge) p.y = Math.max(0.06, Math.min(0.88, p.y));
}

/** 二分查找 nx 所在段，线性插值出山脊高度 y */
function ridgeYAt(ridge, nx) {
  const x = Math.max(ridge[0].x, Math.min(nx, ridge[ridge.length - 1].x));
  let lo = 0, hi = ridge.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ridge[mid].x < x) lo = mid;
    else hi = mid;
  }
  const a = ridge[lo], b = ridge[hi];
  const t = (x - a.x) / (b.x - a.x || 1);
  return a.y + (b.y - a.y) * t;
}

/** nx 处的山坡坡度（dy/dx，用于皴法字随坡旋转） */
function ridgeSlopeAt(ridge, nx) {
  const x = Math.max(ridge[0].x, Math.min(nx, ridge[ridge.length - 1].x));
  let lo = 0, hi = ridge.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ridge[mid].x < x) lo = mid;
    else hi = mid;
  }
  const a = ridge[lo], b = ridge[hi];
  return (b.y - a.y) / (b.x - a.x || 1);
}

export class WaveWall {
  constructor(dataLoader) {
    this.dataLoader = dataLoader;
    this.cun = [];        // 皴法 texture chars
    this.onCharClick = null;
    this.enterProgress = 1;
    this._build();
    this._initGeese();
  }

  _build() {
    // ---- 三层山体：远(淡灰) → 中(重灰) → 近(焦黑)，各带分形山脊 ----
    const far = fractalRidge(-0.08, 1.08, 0.34, 0.035, 4);
    const mid = fractalRidge(-0.08, 1.08, 0.44, 0.055, 5);
    addPeak(mid, rand(0.18, 0.34), rand(0.06, 0.10), 0.09);   // 左侧次峰
    const near = fractalRidge(-0.08, 1.08, 0.55, 0.075, 5);
    addPeak(near, rand(0.55, 0.78), rand(0.16, 0.24), 0.10);  // 右侧主峰

    // 夜山墨色：比夜底略亮的灰阶，远淡近浓；山脚渐虚（被夜雾吞没）
    this.layers = [
      {
        ridge: far,
        inkTop: 'rgba(108, 98, 78, 0.30)', inkBot: 'rgba(108, 98, 78, 0.03)',
        stroke: 'rgba(196, 182, 148, 0.14)', lw: 0.7,
      },
      {
        ridge: mid,
        inkTop: 'rgba(74, 65, 51, 0.52)', inkBot: 'rgba(74, 65, 51, 0.06)',
        stroke: 'rgba(208, 192, 156, 0.22)', lw: 0.9,
      },
      {
        ridge: near,
        inkTop: 'rgba(44, 38, 29, 0.82)', inkBot: 'rgba(44, 38, 29, 0.10)',
        stroke: 'rgba(224, 208, 170, 0.34)', lw: 1.2,
      },
    ];

    // ---- 皴法字：贴着中山/近山的山脊下沿排布，随坡度旋转 ----
    const pool = this.dataLoader.getRandomChars(110 * 2);
    this.cun = [];
    for (let i = 0; i < 110; i++) {
      const onNear = Math.random() < 0.62;   // 近山为主，中山为辅
      const layer = onNear ? this.layers[2] : this.layers[1];
      const nx = rand(0.02, 0.98);
      const ry = ridgeYAt(layer.ridge, nx);
      // 只放在山脸内：山脊下方 0.5%..14% 高度处
      const ny = ry + rand(0.005, 0.14);
      if (ny > 0.92) continue;
      const slope = ridgeSlopeAt(layer.ridge, nx);
      this.cun.push({
        entry: pool[i % pool.length],
        layer: onNear ? 2 : 1,
        nx, ny,
        size: onNear ? (13 + Math.random() * 14) : (8 + Math.random() * 8),
        rotation: Math.atan(slope) * 0.7 + (Math.random() - 0.5) * 0.12,
        ink: 0.35 + Math.random() * 0.45,
        phase: Math.random() * Math.PI * 2,
      });
    }
    // 按纵向排一次序（绘制顺序稳定，远字先画）
    this.cun.sort((a, b) => a.ny - b.ny);
  }

  // ---- 雁阵：一小队飞鸟缓缓掠过夜空 ----
  _initGeese() {
    const w = window.innerWidth, h = window.innerHeight;
    this.geese = {
      x: -w * 0.15,
      y: h * rand(0.12, 0.22),
      vx: rand(16, 26),            // px/s，向右飞
      count: 5 + Math.floor(Math.random() * 5),
      spacing: 13,
      phase: Math.random() * Math.PI * 2,
    };
  }

  enter() { this.enterProgress = 0; }

  /** R — 重新生成山水 + 雁阵 */
  rerandom() { this._build(); this._initGeese(); }

  update(dt, time) {
    if (this.enterProgress < 1) this.enterProgress = Math.min(1, this.enterProgress + 0.012);
    // 雁阵飞行
    const w = window.innerWidth, h = window.innerHeight;
    const g = this.geese;
    g.x += g.vx * dt;
    g.y += Math.sin(time * 0.0006 + g.phase) * 0.06; // 缓缓起伏
    const span = g.count * g.spacing + 60;
    if (g.vx > 0 && g.x - span > w * 1.05) {
      // 从右侧消失 → 从左侧重生（换个高度、队形）
      g.x = -w * 0.1;
      g.y = h * rand(0.10, 0.24);
      g.count = 5 + Math.floor(Math.random() * 5);
      g.vx = rand(16, 26);
    }
  }

  /** 画一层山：山脊浓 → 山脚渐虚（墨被夜雾吞没） */
  _drawLayer(ctx, w, h, layer, ease) {
    const { ridge } = layer;
    const topY = Math.min(...ridge.map(p => p.y)) * h;

    const grad = ctx.createLinearGradient(0, topY, 0, h * 1.02);
    grad.addColorStop(0, layer.inkTop);
    grad.addColorStop(0.55, layer.inkBot);
    grad.addColorStop(1, 'rgba(60, 52, 40, 0.02)');
    ctx.globalAlpha = 0.4 + 0.6 * ease;
    ctx.fillStyle = grad;

    ctx.beginPath();
    ctx.moveTo(ridge[0].x * w, h + 5);
    for (const p of ridge) ctx.lineTo(p.x * w, p.y * h);
    ctx.lineTo(ridge[ridge.length - 1].x * w, h + 5);
    ctx.closePath();
    ctx.fill();

    // 山脊线：月光勾边——近山亮边明显，远山几乎不见
    ctx.strokeStyle = layer.stroke;
    ctx.lineWidth = layer.lw;
    ctx.beginPath();
    ctx.moveTo(ridge[0].x * w, ridge[0].y * h);
    for (let i = 1; i < ridge.length; i++) ctx.lineTo(ridge[i].x * w, ridge[i].y * h);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** 月光雾带：淡金雾横贯，缓缓漂移（夜山的呼吸） */
  _drawMist(ctx, w, h, y, height, alpha, time, drift) {
    const off = Math.sin(time * 0.00022 + drift) * w * 0.04;
    const g = ctx.createLinearGradient(0, y - height, 0, y + height);
    g.addColorStop(0, 'rgba(226, 212, 178, 0)');
    g.addColorStop(0.5, `rgba(226, 212, 178, ${alpha})`);
    g.addColorStop(1, 'rgba(226, 212, 178, 0)');
    ctx.save();
    ctx.translate(off, 0);
    ctx.fillStyle = g;
    ctx.fillRect(-w * 0.15, y - height, w * 1.3, height * 2);
    ctx.restore();
  }

  /** 雁阵：淡金简笔飞鸟，"人"形双翅随时间扇动 */
  _drawGeese(ctx, time, ease) {
    const g = this.geese;
    const span = g.count * g.spacing + 60;
    if (g.x + span < -window.innerWidth * 0.2) return;

    ctx.strokeStyle = `rgba(216, 200, 164, ${0.65 * ease})`;
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';

    for (let i = 0; i < g.count; i++) {
      // V 字队形：0 = 领头，随后左右依次排开
      const row = Math.ceil(i / 2);
      const side = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1);
      const gx = g.x - row * g.spacing;
      const gy = g.y + side * row * g.spacing * 0.75;
      // 扇翅
      const flap = Math.sin(time * 0.008 + i * 1.4 + g.phase) * 3;

      ctx.beginPath();
      // 左翅
      ctx.moveTo(gx - 6, gy + flap * 0.2);
      ctx.quadraticCurveTo(gx - 3, gy - 4 + flap, gx, gy);
      // 右翅
      ctx.quadraticCurveTo(gx + 3, gy - 4 + flap, gx + 6, gy + flap * 0.2);
      ctx.stroke();
    }
  }

  draw(ctx, w, h, time) {
    const ease = 1 - Math.pow(1 - this.enterProgress, 2);

    // === 1. 夜空：不填色——夜墨底从全局背景透出 ===

    // === 2. 月轮（暖金，带呼吸光晕） ===
    const mx = w * 0.76, my = h * 0.15;
    const mr = Math.min(w, h) * 0.032;
    const haloR = mr * (4.4 + 0.3 * Math.sin(time * 0.0004));
    const haloG = ctx.createRadialGradient(mx, my, mr * 0.3, mx, my, haloR);
    haloG.addColorStop(0, 'rgba(226, 206, 158, 0.12)');
    haloG.addColorStop(0.5, 'rgba(226, 206, 158, 0.04)');
    haloG.addColorStop(1, 'rgba(226, 206, 158, 0)');
    ctx.fillStyle = haloG;
    ctx.fillRect(mx - haloR, my - haloR, haloR * 2, haloR * 2);

    const moonG = ctx.createRadialGradient(mx, my, mr * 0.2, mx, my, mr);
    moonG.addColorStop(0, 'rgba(238, 222, 180, 0.95)');
    moonG.addColorStop(0.75, 'rgba(224, 206, 162, 0.78)');
    moonG.addColorStop(1, 'rgba(206, 188, 146, 0.55)');
    ctx.fillStyle = moonG;
    ctx.beginPath();
    ctx.arc(mx, my, mr, 0, Math.PI * 2);
    ctx.fill();

    // === 3. 雁阵掠空 ===
    this._drawGeese(ctx, time, ease);

    // === 4. 远山 → 雾 → 中山 → 雾 → 近山（三远叠压） ===
    this._drawLayer(ctx, w, h, this.layers[0], ease);
    this._drawMist(ctx, w, h, h * 0.40, h * 0.032, 0.30 * ease, time, 0);
    this._drawLayer(ctx, w, h, this.layers[1], ease);
    this._drawMist(ctx, w, h, h * 0.52, h * 0.040, 0.36 * ease, time, 2.1);
    this._drawLayer(ctx, w, h, this.layers[2], ease);
    this._drawMist(ctx, w, h, h * 0.68, h * 0.034, 0.28 * ease, time, 4.2);

    // === 5. 皴法文字：贴各自山脸，随坡度倾斜（月光金字） ===
    for (const c of this.cun) {
      const px = c.nx * w;
      const py = (c.ny * ease + (1 - ease) * 0.62) * h;
      // 缓存屏幕上实际绘制位置，供 handleClick 命中测试（与渲染严格一致）
      c._sx = px;
      c._sy = py;

      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(c.rotation);
      // 近山金字浓亮、中山金字偏淡（跟随所在层的月光）
      const layerInk = c.layer === 2 ? 1.0 : 0.55;
      ctx.globalAlpha = Math.min(0.68, c.ink * layerInk * (0.75 + 0.25 * ease));
      const spr = glyphCache.get(c.entry[0], 48, {
        color: 'rgb(216, 190, 132)',
        glowBlur: 2,
      });
      const gs = c.size * 1.15;
      ctx.drawImage(spr.canvas, -gs / 2, -gs / 2, gs, gs);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // === 6. 水面：夜墨洗染 + 微波荡漾 + 月光倒影 ===
    const water = ctx.createLinearGradient(0, h * 0.84, 0, h);
    water.addColorStop(0, 'rgba(60, 52, 40, 0)');
    water.addColorStop(0.4, 'rgba(60, 52, 40, 0.10)');
    water.addColorStop(1, 'rgba(48, 42, 32, 0.28)');
    ctx.fillStyle = water;
    ctx.fillRect(0, h * 0.84, w, h * 0.16);

    // 月光倒影：月下方一列竖向碎光
    ctx.globalAlpha = 0.10 * ease;
    for (let i = 0; i < 9; i++) {
      const ry = h * 0.86 + i * (h * 0.016);
      const rw = mr * (0.9 - i * 0.07) * (0.7 + 0.3 * Math.sin(time * 0.001 + i));
      ctx.fillStyle = 'rgba(226, 206, 158, 1)';
      ctx.fillRect(mx - rw / 2 + Math.sin(time * 0.0006 + i * 2) * 6, ry, rw, 1.5);
    }
    ctx.globalAlpha = 1;

    // 微波
    ctx.strokeStyle = 'rgba(190, 175, 145, 0.10)';
    ctx.lineWidth = 0.8;
    for (let row = 0; row < 5; row++) {
      const wy = h * 0.88 + row * 11 + Math.sin(time * 0.0004 + row * 1.2) * 2;
      ctx.beginPath();
      for (let x = 0; x < w; x += 6) {
        const yy = wy + Math.sin(x * 0.02 + time * 0.0006 + row * 1.5) * 2;
        if (x === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
  }

  handleClick(x, y) {
    // 入参 x,y 是中心相对坐标（main.js 已做 clientX - w/2），换算回屏幕坐标
    const sx = x + window.innerWidth / 2;
    const sy = y + window.innerHeight / 2;

    // 命中测试：找最近且在字号半径内的皴法字
    let best = null, bestD = Infinity;
    for (const c of this.cun) {
      if (c._sx == null) continue;
      const d = Math.hypot(sx - c._sx, sy - c._sy);
      const r = Math.max(c.size * 0.9, 20); // 命中半径随字号缩放
      if (d < r && d < bestD) { bestD = d; best = c; }
    }
    if (best && this.onCharClick) {
      this.onCharClick(best.entry);
      return true;
    }
    return false;
  }

  dispose() {}
}
