/**
 * 字雨 — Canvas 2D character rain
 * Characters fall DOWNWARD from the sky with varying sizes, opacity, and drift.
 */
import { glyphCache } from './GlyphCache.js';

const COUNT = 400;
const BASE_SPEED = 0.4;

export class CharacterRain {
  constructor(dataLoader) {
    this.dataLoader = dataLoader;
    this.viewW = window.innerWidth;
    this.viewH = window.innerHeight;
    this.chars = [];
    this.mouseX = 0;
    this.mouseY = 0;
    this._init();
  }

  _init() {
    for (let i = 0; i < COUNT; i++) {
      this.chars.push({
        char: '字',
        x: Math.random() * 2000 - 1000,
        y: Math.random() * 1200 - 600,
        speed: BASE_SPEED + Math.random() * 0.6,
        size: 18 + Math.random() * 28,
        phase: Math.random() * Math.PI * 2,
        opacity: 0.2 + Math.random() * 0.5,
        sway: 0.3 + Math.random() * 0.5,
        // 墨色深浅：越大的字（前景）越浓
        ink: 0.5 + Math.random() * 0.5,
      });
    }
    // 按尺寸排序一次（小=远在后，大=近在前），避免每帧排序
    this.chars.sort((a, b) => a.size - b.size);
  }

  enter(dataLoader) {
    const hh = this.viewH / 2;
    for (const c of this.chars) {
      const entry = dataLoader.getRandomChars(1)[0];
      if (entry) c.char = entry[0];
      // Spawn ABOVE the top edge, will fall DOWN
      c.y = -hh - 50 - Math.random() * 300;
      c.x = (Math.random() - 0.5) * 1800;
    }
  }

  /** R: re-randomize all falling characters */
  rerandom(dataLoader) {
    this.enter(dataLoader);
  }

  update(dt, time) {
    const hh = this.viewH / 2;
    for (const c of this.chars) {
      c.y += c.speed; // grow y = move DOWN on screen
      c.x += Math.sin(time * 0.6 + c.phase) * c.sway;
      // Mouse repel
      const dx = c.x - this.mouseX;
      const dy = c.y - this.mouseY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 120 && dist > 0) {
        c.x += (dx / dist) * 3 * (1 - dist / 120);
        c.y += (dy / dist) * 3 * (1 - dist / 120);
      }
      // Recycle to top after passing bottom
      if (c.y > hh + 80) {
        const entry = this.dataLoader ? this.dataLoader.getRandomChars(1)[0] : null;
        if (entry) c.char = entry[0];
        c.y = -hh - 50 - Math.random() * 300;
        c.x = (Math.random() - 0.5) * 1800;
        c.speed = BASE_SPEED + Math.random() * 0.6;
      }
    }
  }

  draw(ctx, w, h, time) {
    const hw = w / 2, hh = h / 2;
    // 不再每帧排序——_init 中已按 size 排序
    for (const c of this.chars) {
      const sx = c.x + hw;
      const sy = c.y + hh;
      if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50) continue;
      const size = c.size * 1.2;
      let o = c.opacity;
      // 入场淡入/出场淡出
      const normY = (c.y + hh) / h;
      if (normY < 0.08) o *= normY / 0.08;
      if (normY > 0.92) o *= (1 - normY) / 0.08;
      // 墨色：前景字浓（亮），远景字淡（夜墨底上）
      const inkColor = c.ink > 0.8 ? '#eee4cc' : c.ink > 0.6 ? '#c6b99e' : '#9a8d75';
      ctx.globalAlpha = o;
      const spr = glyphCache.get(c.char, 64, { color: inkColor, glowBlur: 0 });
      ctx.drawImage(spr.canvas, sx - size / 2, sy - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  handleClick(x, y) {
    let best = null, bestDist = 9999;
    for (const c of this.chars) {
      const dx = c.x - x, dy = c.y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    // mouse repels chars, so use a very generous hit radius (≈1/4 screen width)
    if (best && bestDist < 400 && this.onCharClick) {
      const entry = this.dataLoader.getIndexEntry(best.char);
      if (entry) this.onCharClick(entry);
      return true;
    }
    return false;
  }

  setMouse(x, y) { this.mouseX = x; this.mouseY = y; }
  dispose() {}
}