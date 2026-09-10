/**
 * 字之穹 — first-person flying galaxy (诗云-style)
 * 8000 stars with glow, nebula background, 3D projection.
 * WASD 飞行 · 拖拽转向 · 滚轮调速 · 点击星辰溯源
 */
import { glyphCache } from './GlyphCache.js';

const STAR_COUNT = 5000;
const FIELD_RADIUS = 5000;
const NEAR = 20;
const FOCAL = 700;
const NEBULA_PATH = 'data:image/svg+xml,...'; // placeholder — we draw nebula procedurally

export class StarField {
  constructor(dataLoader) {
    this.dataLoader = dataLoader;
    this.stars = [];
    this.radicalGroups = [];
    this.focusIdx = -1;
    this.nebulaCanvas = null; // pre-rendered nebula background

    // Camera
    this.pos = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;
    this.speed = 300;
    this.flew = false;

    // Mouse look
    this.dragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.dragMoved = false;

    this.flyTarget = null;
    this.onCharClick = null;
    this._build();
    this._buildNebula();
  }

  _hashRadical(r) {
    let h = 0;
    for (let i = 0; i < r.length; i++) h = (h * 31 + r.charCodeAt(i)) >>> 0;
    return h;
  }

  _build() {
    const pool = this.dataLoader.getRandomChars(STAR_COUNT * 3);
    const used = new Set();
    const groupMap = new Map();

    this.stars = [];
    for (const entry of pool) {
      if (used.has(entry[0])) continue;
      used.add(entry[0]);
      const radical = entry[2] || '一';
      const hash = this._hashRadical(radical);
      let group = groupMap.get(radical);
      if (!group) {
        // 3D cluster: each radical occupies a wedge in the galaxy
        const theta = (hash % 1000) / 1000 * Math.PI * 2;
        const ring = 600 + ((hash >> 3) % 700) / 700 * 3400;
        const tilt = ((hash >> 5) % 100) / 100 * Math.PI * 0.15;
        group = {
          radical, entry,
          cx: Math.cos(theta) * ring,
          cy: Math.sin(tilt) * 200,
          cz: Math.sin(theta) * ring,
          count: 0, scatter: 30,
        };
        groupMap.set(radical, group);
        this.radicalGroups.push(group);
      }
      // Star position: 3D gaussian scatter around cluster center
      this.stars.push({
        entry,
        x: group.cx + (Math.random() - 0.5) * group.scatter * 2.5,
        y: group.cy + (Math.random() - 0.5) * 120,
        z: group.cz + (Math.random() - 0.5) * group.scatter * 2.5,
        brightness: 0.4 + Math.random() * 0.6,
        size: 1.0 + Math.random() * 2.8,
      // star color: 暖金与米白交织（夜墨底上的星辰墨点）
      color: Math.random() < 0.3 ? '#d4c4a0' : Math.random() < 0.5 ? '#eee8d0' : '#f0e6c8',
      });
      group.count++;
      if (this.stars.length >= STAR_COUNT) break;
    }
    // Adjust scatter by group size
    for (const g of groupMap.values()) {
      g.scatter = Math.min(140, 30 + g.count * 2.0);
    }
    // Re-scatter using final scatter
    for (let i = 0; i < this.stars.length; i++) {
      const s = this.stars[i];
      const radical = s.entry[2] || '一';
      const g = groupMap.get(radical);
      if (!g) continue;
      s.x = g.cx + (Math.random() - 0.5) * g.scatter * 2.5;
      s.z = g.cz + (Math.random() - 0.5) * g.scatter * 2.5;
      s.y = g.cy + (Math.random() - 0.5) * 120;
    }
  }

  /** Pre-render a nebula background texture (夜墨中的淡金云气) */
  _buildNebula() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const ctx = c.getContext('2d');
    // 夜墨底
    ctx.fillStyle = '#0a0806';
    ctx.fillRect(0, 0, 256, 256);
    // 淡金云气 blobs
    for (let i = 0; i < 20; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const r = 20 + Math.random() * 80;
      const alpha = 0.02 + Math.random() * 0.04;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(80, 60, 40, ${alpha})`);
      g.addColorStop(0.5, `rgba(60, 40, 30, ${alpha * 0.5})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
    }
    this.nebulaCanvas = c;
  }

  enter() {
    this.pos = { x: 0, y: 0, z: 0 };
    this.yaw = Math.random() * Math.PI * 2;
    this.pitch = 0;
    this.speed = 300;
  }

  rerandom(dataLoader) {
    const pool = this.dataLoader.getRandomChars(100);
    let pi = 0;
    for (const s of this.stars) {
      if (pool.length > 0) { s.entry = pool[pi % pool.length]; pi++; }
    }
    for (const g of this.radicalGroups) {
      const e = this.dataLoader.getRandomChars(1)[0];
      if (e) g.entry = e;
    }
  }

  /** ←→: jump to next/prev radical cluster */
  nextContent() { this._flyToGroup(1); }
  prevContent() { this._flyToGroup(-1); }

  _flyToGroup(dir) {
    if (this.radicalGroups.length === 0) return;
    this.focusIdx = (this.focusIdx + 1 + dir + this.radicalGroups.length) % this.radicalGroups.length;
    const g = this.radicalGroups[this.focusIdx];
    const dist = 260;
    const a = Math.atan2(g.cz, g.cx);
    // Smooth fly to cluster viewpoint
    this.flyTarget = {
      x: g.cx - Math.cos(a) * dist,
      y: g.cy + 30,
      z: g.cz - Math.sin(a) * dist,
    };
    this._aimAt(g.cx, g.cy, g.cz);
  }

  _aimAt(px, py, pz) {
    const dx = px - this.pos.x;
    const dy = py - this.pos.y;
    const dz = pz - this.pos.z;
    this.yaw = Math.atan2(dx, dz);
    this.pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
  }

  applyInput(keys, dt) {
    const cy = Math.cos(this.pitch), sy = Math.sin(this.pitch);
    const fwd = { x: Math.sin(this.yaw) * cy, y: sy, z: Math.cos(this.yaw) * cy };
    const right = { x: Math.cos(this.yaw), y: 0, z: -Math.sin(this.yaw) };
    let dx = 0, dy = 0, dz = 0;
    if (keys['w']) { dx += fwd.x; dy += fwd.y; dz += fwd.z; }
    if (keys['s']) { dx -= fwd.x; dy -= fwd.y; dz -= fwd.z; }
    if (keys['a']) { dx -= right.x; dz -= right.z; }
    if (keys['d']) { dx += right.x; dz += right.z; }
    if (keys['q']) { dy += 1; }
    if (keys['Shift']) { dy -= 1; }
    const m = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (m > 0.001) {
      this.pos.x += (dx / m) * this.speed * dt;
      this.pos.y += (dy / m) * this.speed * dt;
      this.pos.z += (dz / m) * this.speed * dt;
      this.flew = true;
    }
    // Smooth fly to cluster target
    if (this.flyTarget) {
      const t = this.flyTarget;
      const k = 1.0; // smooth fly: reaches target in ~4s, visible but gentle
      this.pos.x += (t.x - this.pos.x) * k * dt;
      this.pos.y += (t.y - this.pos.y) * k * dt;
      this.pos.z += (t.z - this.pos.z) * k * dt;
      if (Math.abs(t.x - this.pos.x) < 3 && Math.abs(t.z - this.pos.z) < 3) this.flyTarget = null;
    }
  }

  update(dt, time) {}

  /** 3D → screen projection */
  _project(x, y, z, w, h) {
    const dx = x - this.pos.x, dy = y - this.pos.y, dz = z - this.pos.z;
    const cy = Math.cos(this.pitch), sy = Math.sin(this.pitch);
    const fwd = { x: Math.sin(this.yaw) * cy, y: sy, z: Math.cos(this.yaw) * cy };
    const right = { x: Math.cos(this.yaw), y: 0, z: -Math.sin(this.yaw) };
    const up = {
      x: fwd.y * right.z - fwd.z * right.y,
      y: fwd.z * right.x - fwd.x * right.z,
      z: fwd.x * right.y - fwd.y * right.x,
    };
    const depth = dx * fwd.x + dy * fwd.y + dz * fwd.z;
    if (depth < NEAR) return null;
    const u = dx * right.x + dy * right.y + dz * right.z;
    const v = dx * up.x + dy * up.y + dz * up.z;
    const scale = FOCAL / depth;
    return { x: w / 2 + u * scale, y: h / 2 - v * scale, scale, depth };
  }

  draw(ctx, w, h, time) {
    // Draw nebula background (tiled, scrolling slowly)
    if (this.nebulaCanvas) {
      const nw = this.nebulaCanvas.width, nh = this.nebulaCanvas.height;
      const panX = (time * 0.0002) % nw;
      const panY = (time * 0.0001) % nh;
      // Draw tile with slight parallax
      ctx.globalAlpha = 0.35;
      for (let tx = -1; tx <= 1; tx++) {
        for (let ty = -1; ty <= 1; ty++) {
          ctx.drawImage(this.nebulaCanvas, tx * nw + panX, ty * nh + panY, w, h);
        }
      }
      ctx.globalAlpha = 1;
    }

    // Project all stars — cull off-screen early to avoid sorting waste
    const projected = [];
    for (const s of this.stars) {
      const p = this._project(s.x, s.y, s.z, w, h);
      if (!p) continue;
      // 视口裁剪：跳过投影到屏幕外远处的大量星
      if (p.x < -80 || p.x > w + 80 || p.y < -80 || p.y > h + 80) continue;
      projected.push({ s, p });
    }
    projected.sort((a, b) => b.p.depth - a.p.depth);

    // Draw stars
    for (const { s, p } of projected) {
      const scale = p.scale;

      // Distant: tiny dot with glow
      if (scale < 0.3) {
        const alpha = Math.min(0.5, s.brightness * scale * 2.5);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = s.color;
        const r = Math.max(0.6, s.size * scale * 0.4);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      // Medium: small glow (radial gradient)
      if (scale < 0.8) {
        const alpha = Math.min(0.7, s.brightness * scale);
        ctx.globalAlpha = alpha;
        const r = Math.max(1.2, s.size * scale * 0.6);
        // Glow halo
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        // Outer glow
        ctx.globalAlpha = alpha * 0.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 2.5, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      // Near: bright star with strong glow + character glyph
      const alpha = Math.min(0.95, s.brightness * scale);
      ctx.globalAlpha = alpha;

      // Outer glow
      const glowR = s.size * scale * 1.2;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR * 3);
      const col = s.color;
      g.addColorStop(0, col);
      g.addColorStop(0.2, col);
      g.addColorStop(0.6, `${col}66`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, glowR * 3, 0, Math.PI * 2);
      ctx.fill();

      // Core dot
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2, glowR * 0.5), 0, Math.PI * 2);
      ctx.fill();

      // Character label (only for moderately close stars)
      if (scale > 1.0) {
        const glyphSize = Math.min(100, Math.max(24, 38 * scale));
        ctx.globalAlpha = Math.min(0.9, alpha);
        const spr = glyphCache.get(s.entry[0], 80, { color: '#f0e6c8', glowBlur: 12 });
        const gs = glyphSize * 1.3;
        ctx.drawImage(spr.canvas, p.x - gs / 2, p.y - gs / 2 - glyphSize * 0.15, gs, gs);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Screen raycast for click */
  _pick(sx, sy, w, h) {
    let best = null, bestD = 30;
    for (const s of this.stars) {
      const p = this._project(s.x, s.y, s.z, w, h);
      if (!p) continue;
      const d = Math.sqrt((sx - p.x) ** 2 + (sy - p.y) ** 2);
      // Near stars have bigger hit area
      const hitR = p.scale > 1.0 ? 40 : p.scale > 0.5 ? 18 : 8;
      if (d < hitR && d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  handleClick(x, y) {
    const w = window.innerWidth, h = window.innerHeight;
    const sx = x + w / 2, sy = y + h / 2;
    const star = this._pick(sx, sy, w, h);
    if (star && this.onCharClick) {
      this.onCharClick(star.entry);
      return true;
    }
    return false;
  }

  lookDrag(dx, dy) {
    this.yaw -= dx * 0.005;
    this.pitch += dy * 0.005;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
  }

  setSpeedFactor(factor) {
    this.speed = Math.max(50, Math.min(5000, this.speed * factor));
  }

  setMouse() {}
  dispose() {}
}