/**
 * 字鸟 — Boids 文字群（鸟群仿真）
 * Chinese characters flying like a flock of birds.
 *
 * 基于 Craig Reynolds 的经典 Boids 三大规则（分离 / 对齐 / 凝聚），
 * 参考蝙蝠群 Boids 示例的数学实现：每条规则都先做"期望方向归一化到
 * MAX_SPEED"，再求转向力 steer = desired − velocity，最后用 MAX_FORCE
 * 限幅。这样群体行为才自然、稳定、真正成群。
 *
 * 在经典 Boids 之上保留"字鸟"特色：
 *   · 所有字鸟从同一点迸发，向外飞散后聚合成一群；
 *   · 点击空白撒食 → 鸟群被食物吸引（喂食）；
 *   · 点击单只字鸟 → 打开字源详情；
 *   · 鼠标靠近 → 鸟群自然躲避（被惊飞的生命感）。
 *
 * 性能：用空间哈希网格做邻居查询，从 O(n²) 降到近似 O(n)。
 */
import { glyphCache } from './GlyphCache.js';

const BOID_COUNT = 100;

// 感知半径：对齐蝙蝠群参考代码的量级（neighbor_dist = 50）。
// 注意：感知半径不能大——凝聚取的是邻居平均位置，视野一大，
// 平均位置≈群体质心，所有鸟都往质心钻，就会挤成一团。
const PERCEPTION = 55;  // alignment + cohesion 半径
const SEP_RADIUS = 28;  // separation 半径（desired_separation 量级）

// Reynolds 转向参数（对齐参考代码：MAX_SPEED 4 / MAX_FORCE 0.1）
const MAX_SPEED = 4;
const MIN_SPEED = 1.2;
const MAX_FORCE = 0.1;

// 三大规则权重：分离最强（参考代码 1.5 / 1.0 / 1.0）
const SEP_WEIGHT = 1.5;
const ALI_WEIGHT = 1.0;
const COH_WEIGHT = 1.0;

// 字鸟专属力
const FOOD_WEIGHT = 1.4;     // 被食物吸引
const CURSOR_RADIUS = 120;   // 光标驱赶半径
const CURSOR_WEIGHT = 1.7;
const EDGE_BUFFER = 90;      // 边界回避缓冲（柔和，别把鸟群压向中央）
const EDGE_WEIGHT = 1.5;

// 速度 → 墨色分级（夜墨底上的暖浅色：慢=浓亮，快=清淡）
const COLORS = [
  'rgb(200,182,150)',   // 浓——慢速
  'rgb(213,193,160)',   // 重
  'rgb(224,202,168)',   // 淡
  'rgb(233,208,172)',   // 清
  'rgb(240,212,176)',   // 最淡——快速
];
function colorFor(t) {
  const i = Math.min(4, Math.max(0, Math.floor(t * 5)));
  return COLORS[i];
}

/** 把向量限幅到 max 长度，返回 [x, y] */
function limit(x, y, max) {
  const m = Math.hypot(x, y);
  if (m > max && m > 0) {
    const k = max / m;
    return [x * k, y * k];
  }
  return [x, y];
}

/** 把向量缩放（setMag）到给定长度，返回 [x, y] */
function setMag(x, y, mag) {
  const m = Math.hypot(x, y);
  if (m === 0) return [0, 0];
  const k = mag / m;
  return [x * k, y * k];
}

export class BoidsSwarm {
  constructor(dataLoader) {
    this.dataLoader = dataLoader;
    this.boids = [];
    this.foods = [];        // 食物点 { x, y, life }
    this.onCharClick = null;
    this.enterProgress = 1;
    this.cursor = null;     // { x, y, t } 屏幕坐标 + 最近出现时间(秒)
    this._build();
  }

  _build() {
    const pool = this.dataLoader.getRandomChars(BOID_COUNT * 2);
    const w = window.innerWidth, h = window.innerHeight;
    // 所有字鸟从画布内一个随机点迸发
    const px = w * (0.25 + Math.random() * 0.5);
    const py = h * (0.25 + Math.random() * 0.5);
    this.spawnPoint = { x: px, y: py };

    this.boids = [];
    for (let i = 0; i < BOID_COUNT; i++) {
      const entry = pool[i % pool.length];
      const angle = Math.random() * Math.PI * 2;
      const speed = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED) * 2;
      this.boids.push({
        entry,
        x: px + (Math.random() - 0.5) * 10,
        y: py + (Math.random() - 0.5) * 10,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 12 + Math.random() * 12,
        alpha: 0.55 + Math.random() * 0.35,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  enter() { this.enterProgress = 0; }

  rerandom(dataLoader) {
    this._build();
    this.foods = [];
  }

  /** 鼠标移动 → 记录光标（屏幕坐标），用于"惊飞"驱赶 */
  setMouse(rx, ry) {
    const w = window.innerWidth, h = window.innerHeight;
    this.cursor = { x: rx + w / 2, y: ry + h / 2, t: performance.now() / 1000 };
  }

  /** 点击：优先命中字鸟 → 溯源；否则撒食喂鸟 */
  handleClick(rx, ry) {
    const sx = rx + window.innerWidth / 2;
    const sy = ry + window.innerHeight / 2;

    let best = null, bestD = 26;
    for (const b of this.boids) {
      const d = Math.hypot(sx - b.x, sy - b.y);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (best) {
      if (this.onCharClick) this.onCharClick(best.entry);
      return true;
    }

    // 撒一小簇食物
    for (let i = 0; i < 6; i++) {
      this.foods.push({
        x: sx + (Math.random() - 0.5) * 40,
        y: sy + (Math.random() - 0.5) * 40,
        life: 1.0,
      });
    }
    if (this.foods.length > 60) this.foods.splice(0, this.foods.length - 60);
    return false;
  }

  update(dt, time) {
    if (this.enterProgress < 1) this.enterProgress = Math.min(1, this.enterProgress + 0.015);

    // 食物缓慢衰减
    for (let i = this.foods.length - 1; i >= 0; i--) {
      this.foods[i].life -= dt * 0.12;
      if (this.foods[i].life <= 0) this.foods.splice(i, 1);
    }

    const boids = this.boids;
    const w = window.innerWidth, h = window.innerHeight;
    const n = boids.length;

    // ---- 构建空间哈希网格（cell = PERCEPTION），加速邻居查询 ----
    const cell = PERCEPTION;
    const grid = new Map();
    const key = (cx, cy) => cx + ',' + cy;
    for (let i = 0; i < n; i++) {
      const b = boids[i];
      const cx = Math.floor(b.x / cell);
      const cy = Math.floor(b.y / cell);
      const k = key(cx, cy);
      let arr = grid.get(k);
      if (!arr) { arr = []; grid.set(k, arr); }
      arr.push(i);
    }

    // 缓慢变化的"风"，给鸟群一个迁徙方向感
    const windX = Math.cos(time * 0.05) * 0.02;
    const windY = Math.sin(time * 0.07) * 0.02;

    // 光标是否"有效"（最近 1.2 秒内移动过）
    const cursorActive = this.cursor && (time - this.cursor.t) < 1.2;

    for (let i = 0; i < n; i++) {
      const b = boids[i];

      // 收集邻居（自身 cell + 8 邻格）
      let sepX = 0, sepY = 0, sepCount = 0;
      let aliX = 0, aliY = 0, aliCount = 0;
      let cohX = 0, cohY = 0, cohCount = 0;

      const bcx = Math.floor(b.x / cell);
      const bcy = Math.floor(b.y / cell);
      for (let gx = bcx - 1; gx <= bcx + 1; gx++) {
        for (let gy = bcy - 1; gy <= bcy + 1; gy++) {
          const arr = grid.get(key(gx, gy));
          if (!arr) continue;
          for (let a = 0; a < arr.length; a++) {
            const j = arr[a];
            if (j === i) continue;
            const o = boids[j];
            const dx = o.x - b.x, dy = o.y - b.y;
            const d = Math.hypot(dx, dy);
            if (d > 0 && d < PERCEPTION) {
              // 分离：只统计很近的邻居，方向归一化后累加
              if (d < SEP_RADIUS) {
                sepX -= dx / d;
                sepY -= dy / d;
                sepCount++;
              }
              // 对齐：累加邻居速度
              aliX += o.vx;
              aliY += o.vy;
              aliCount++;
              // 凝聚：累加邻居位置
              cohX += o.x;
              cohY += o.y;
              cohCount++;
            }
          }
        }
      }

      let ax = 0, ay = 0;

      // ---- 分离（Separation）----
      if (sepCount > 0) {
        let [dx, dy] = setMag(sepX, sepY, MAX_SPEED);
        let [sx2, sy2] = limit(dx - b.vx, dy - b.vy, MAX_FORCE);
        ax += sx2 * SEP_WEIGHT;
        ay += sy2 * SEP_WEIGHT;
      }
      // ---- 对齐（Alignment）----
      if (aliCount > 0) {
        let [dx, dy] = setMag(aliX / aliCount, aliY / aliCount, MAX_SPEED);
        let [sx2, sy2] = limit(dx - b.vx, dy - b.vy, MAX_FORCE);
        ax += sx2 * ALI_WEIGHT;
        ay += sy2 * ALI_WEIGHT;
      }
      // ---- 凝聚（Cohesion）----
      if (cohCount > 0) {
        const tx = cohX / cohCount - b.x;
        const ty = cohY / cohCount - b.y;
        let [dx, dy] = setMag(tx, ty, MAX_SPEED);
        let [sx2, sy2] = limit(dx - b.vx, dy - b.vy, MAX_FORCE);
        ax += sx2 * COH_WEIGHT;
        ay += sy2 * COH_WEIGHT;
      }

      // ---- 食物吸引（seek 最近食物）----
      if (this.foods.length > 0) {
        let nearest = null, nd = Infinity;
        for (const f of this.foods) {
          const dx = f.x - b.x, dy = f.y - b.y;
          const d = dx * dx + dy * dy;
          if (d < nd) { nd = d; nearest = f; }
        }
        if (nearest) {
          const d = Math.sqrt(nd) || 1;
          if (d > 4) {
            let [dx, dy] = setMag(nearest.x - b.x, nearest.y - b.y, MAX_SPEED);
            let [sx2, sy2] = limit(dx - b.vx, dy - b.vy, MAX_FORCE);
            ax += sx2 * FOOD_WEIGHT * nearest.life;
            ay += sy2 * FOOD_WEIGHT * nearest.life;
          } else {
            nearest.life -= dt * 0.4; // 吃到食物
          }
        }
      }

      // ---- 光标驱赶（被惊飞）----
      if (cursorActive) {
        const dx = b.x - this.cursor.x, dy = b.y - this.cursor.y;
        const d = Math.hypot(dx, dy);
        if (d < CURSOR_RADIUS && d > 0) {
          const strength = (1 - d / CURSOR_RADIUS);
          let [sx2, sy2] = setMag(dx, dy, MAX_SPEED);
          let [fx, fy] = limit(sx2 - b.vx, sy2 - b.vy, MAX_FORCE);
          ax += fx * CURSOR_WEIGHT * strength;
          ay += fy * CURSOR_WEIGHT * strength;
        }
      }

      // ---- 边界回避（柔和转向，确保不飞出屏幕）----
      let edgeX = 0, edgeY = 0;
      const eb = EDGE_BUFFER;
      if (b.x < eb) edgeX = (eb - b.x) / eb;
      else if (b.x > w - eb) edgeX = -(b.x - (w - eb)) / eb;
      if (b.y < eb) edgeY = (eb - b.y) / eb;
      else if (b.y > h - eb) edgeY = -(b.y - (h - eb)) / eb;
      // 已经越界则强力拉回
      if (b.x < 0) edgeX += 1;
      if (b.x > w) edgeX -= 1;
      if (b.y < 0) edgeY += 1;
      if (b.y > h) edgeY -= 1;
      const [ex, ey] = limit(edgeX * EDGE_WEIGHT, edgeY * EDGE_WEIGHT, MAX_FORCE * 4);
      ax += ex;
      ay += ey;

      // ---- 微风 ----
      ax += windX;
      ay += windY;

      // ---- 积分 ----
      b.vx += ax;
      b.vy += ay;

      // 限速 + 最小速度（鸟群永不静止）
      let speed = Math.hypot(b.vx, b.vy);
      if (speed > MAX_SPEED) {
        b.vx = (b.vx / speed) * MAX_SPEED;
        b.vy = (b.vy / speed) * MAX_SPEED;
      } else if (speed < MIN_SPEED && speed > 0.001) {
        b.vx = (b.vx / speed) * MIN_SPEED;
        b.vy = (b.vy / speed) * MIN_SPEED;
      }

      b.x += b.vx;
      b.y += b.vy;
    }
  }

  draw(ctx, w, h, now) {
    const e = this.enterProgress;
    const ease = 1 - Math.pow(1 - e, 3);

    // === 食物：发光谷粒 ===
    for (const f of this.foods) {
      const alpha = f.life * 0.55;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#e0c870';
      ctx.beginPath();
      ctx.arc(f.x, f.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha * 0.18;
      ctx.beginPath();
      ctx.arc(f.x, f.y, 9, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // === 迸发点：呼吸光环 ===
    if (this.spawnPoint) {
      ctx.globalAlpha = 0.1 * ease;
      ctx.strokeStyle = 'rgba(230,215,180,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(this.spawnPoint.x, this.spawnPoint.y, 10 + Math.sin(now * 0.002) * 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (const b of this.boids) {
      const sx = b.x, sy = b.y;
      if (sx < -40 || sx > w + 40 || sy < -40 || sy > h + 40) continue;

      const speed = Math.hypot(b.vx, b.vy);
      const t = Math.max(0, Math.min(1, (speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)));
      const size = b.size * (0.6 + 0.4 * ease);
      const color = colorFor(t);

      ctx.save();
      ctx.translate(sx, sy);

      // ---- 字形（正立文字，按速度分档的暖墨辉光）----
      ctx.globalAlpha = b.alpha * ease;
      const glow = 4 + t * 8;
      const spr = glyphCache.get(b.entry[0], 64, { color, glowBlur: glow });
      const gs = size * 1.3;
      ctx.drawImage(spr.canvas, -gs / 2, -gs / 2, gs, gs);

      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  dispose() {
    this.boids = [];
    this.foods = [];
  }
}
