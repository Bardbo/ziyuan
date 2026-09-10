/**
 * 字之魂 — Canvas 2D particle glyph
 * 2500 particles converge into a giant hanzi, breathing & mouse-repelling.
 */
import { glyphCache } from './GlyphCache.js';

const MAX_PARTICLES = 2500;

function sampleGlyph(char, size = 160) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.font = `140px "Alibaba PuHuiTi","SimSun",serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(char, size / 2, size / 2 + 4);
  const img = ctx.getImageData(0, 0, size, size).data;
  const pts = [];
  for (let y = 0; y < size; y += 2) {
    for (let x = 0; x < size; x += 2) {
      if (img[(y * size + x) * 4 + 3] > 100) {
        pts.push({ x: x - size / 2, y: y - size / 2 });
      }
    }
  }
  if (pts.length > MAX_PARTICLES) {
    const keep = MAX_PARTICLES / pts.length;
    return pts.filter(() => Math.random() < keep);
  }
  return pts;
}

export class ParticleChar {
  constructor(dataLoader) {
    this.dataLoader = dataLoader;
    this.currentEntry = null;
    this.particles = [];
    this.mouseX = 9999; this.mouseY = 9999;
    this.mouseStrength = 0;
    this.onCharClick = null;
    this.charHistory = [];   // browsing history of entries
    this.historyIdx = -1;
    this._nextChar();
  }

  /** Set a specific character entry (update particle targets) */
  _setChar(entry) {
    if (!entry) return;
    this.currentEntry = entry;
    this.currentChar = entry;
    const pts = sampleGlyph(entry[0]);
    if (pts.length === 0) return;
    const hw = 140, hh = 140;
    const targets = pts.map(p => ({ x: p.x / 160 * hw, y: p.y / 160 * hh }));
    while (targets.length < MAX_PARTICLES) {
      const src = targets[Math.floor(Math.random() * targets.length)];
      targets.push({ x: src.x + (Math.random() - 0.5) * 6, y: src.y + (Math.random() - 0.5) * 6 });
    }
    if (this.particles.length === 0) {
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const angle = Math.random() * Math.PI * 2;
        const rad = 300 + Math.random() * 300;
        this.particles.push({
          x: Math.cos(angle) * rad, y: Math.sin(angle) * rad,
          tx: targets[i].x, ty: targets[i].y,
          vx: 0, vy: 0,
        });
      }
    } else {
      for (let i = 0; i < MAX_PARTICLES; i++) {
        this.particles[i].tx = targets[i].x;
        this.particles[i].ty = targets[i].y;
      }
    }
  }

  _nextChar() {
    const entry = this.dataLoader.getRandomChars(1)[0];
    if (!entry) return;
    // Append to history and advance pointer
    this.charHistory.push(entry);
    this.historyIdx = this.charHistory.length - 1;
    this._setChar(entry);
  }

  /** →: forward in history (or generate new char at end) */
  nextContent() {
    if (this.historyIdx < this.charHistory.length - 1) {
      this.historyIdx++;
      this._setChar(this.charHistory[this.historyIdx]);
    } else {
      this._nextChar();
    }
  }

  /** ←: back in history */
  prevContent() {
    if (this.historyIdx > 0) {
      this.historyIdx--;
      this._setChar(this.charHistory[this.historyIdx]);
    }
  }

  enter(dataLoader) {
    // Pick a fresh character and scatter particles for entrance animation
    this._nextChar();
    for (const p of this.particles) {
      const angle = Math.random() * Math.PI * 2;
      const rad = 400 + Math.random() * 300;
      p.x = Math.cos(angle) * rad;
      p.y = Math.sin(angle) * rad;
      p.vx = 0; p.vy = 0;
    }
  }

  jumpToChar(char) {
    const entry = this.dataLoader.getIndexEntry(char);
    if (!entry) return false;
    // Add to history and jump
    this.charHistory.push(entry);
    this.historyIdx = this.charHistory.length - 1;
    this._setChar(entry);
    return true;
  }

  getCurrentEntry() { return this.currentEntry; }

  /** R: re-randomize to a fresh character */
  rerandom() { this._nextChar(); }

  update(dt, time) {
    this.mouseStrength *= 0.94;
    for (const p of this.particles) {
      const dx = p.tx - p.x, dy = p.ty - p.y;
      // Mouse repel
      let repelX = 0, repelY = 0;
      if (this.mouseStrength > 0.01) {
        const mdx = p.x - this.mouseX, mdy = p.y - this.mouseY;
        const md = Math.sqrt(mdx * mdx + mdy * mdy);
        if (md < 140 && md > 0) {
          const f = (1 - md / 140) * this.mouseStrength * 50;
          repelX = (mdx / md) * f;
          repelY = (mdy / md) * f;
        }
      }
      p.vx += dx * 0.06 + repelX * 0.03 + (Math.random() - 0.5) * 0.2;
      p.vy += dy * 0.06 + repelY * 0.03 + (Math.random() - 0.5) * 0.2;
      p.vx *= 0.80; p.vy *= 0.80;
      p.x += p.vx; p.y += p.vy;
    }
  }

  draw(ctx, w, h, time) {
    const cx = w / 2, cy = h / 2;
    const breathe = 1 + Math.sin(time * 0.001 * 0.5) * 0.02;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(breathe, breathe);
    for (const p of this.particles) {
      const sx = p.x, sy = p.y;
      if (Math.abs(sx) > 400 || Math.abs(sy) > 400) continue;
      // 墨色渐变：中心浓亮，边缘淡（夜墨底上）
      const dist = Math.sqrt(sx * sx + sy * sy) / 200;
      const alpha = Math.max(0.3, 1 - dist * 0.5) * 0.85;
      ctx.globalAlpha = alpha;
      const ink = Math.max(0.2, 1 - dist);
      const r = Math.floor(160 + ink * 72);
      const g = Math.floor(144 + ink * 64);
      const bl = Math.floor(116 + ink * 52);
      ctx.fillStyle = `rgb(${r},${g},${bl})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.2 + Math.sin(time * 0.002 + sx * 0.1) * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  handleClick(x, y) {
    if (this.currentEntry && this.onCharClick) {
      const dist = Math.sqrt(x * x + y * y);
      if (dist < 160) {
        this.onCharClick(this.currentEntry);
        return true;
      }
    }
    return false;
  }

  setMouse(x, y) { this.mouseX = x; this.mouseY = y; this.mouseStrength = 1; }
  dispose() {}
}