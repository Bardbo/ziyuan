/**
 * 卷轴 — 状元文 Scroll
 * An ancient imperial exam essay (状元卷) slowly unfurling.
 * Multiple lines of calligraphy text, aged paper, vermilion seals.
 */
import { glyphCache } from './GlyphCache.js';

const UNROLL_SPEED = 0.006;
// Generate a longer "essay" so the scroll fills completely
const ESSAY_LENGTH = 400;

export class ScrollReveal {
  constructor(dataLoader) {
    this.dataLoader = dataLoader;
    this.currentEntry = null;
    this.essay = '';
    this.essayEntries = [];   // 与 essay 字符一一对应的 entry 数组，供点击命中映射
    this.unrollProgress = 0;
    this.onCharClick = null;
    this._grainCanvas = null;  // 缓存宣纸纹理
    this._layout = null;       // draw() 缓存的版面参数，供 handleClick 命中测试
    this._generateEssay();
    this._buildGrain();
  }

  /** 预渲染宣纸纹理（避免每帧 50 次随机 fillRect） */
  _buildGrain() {
    const w = 740, h = 520;
    this._grainCanvas = document.createElement('canvas');
    this._grainCanvas.width = w;
    this._grainCanvas.height = h;
    const ctx = this._grainCanvas.getContext('2d');
    for (let i = 0; i < 200; i++) {
      const gx = Math.random() * w;
      const gy = Math.random() * h;
      ctx.globalAlpha = 0.02;
      ctx.fillStyle = Math.random() > 0.5 ? '#c8b898' : '#d8c8a8';
      ctx.fillRect(gx, gy, Math.random() * 4 + 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  _generateEssay() {
    const pool = this.dataLoader.getRandomChars(ESSAY_LENGTH * 2);
    const chosen = pool.slice(0, ESSAY_LENGTH);
    this.essay = chosen.map(e => e[0]).join('');
    this.essayEntries = chosen;
    this.currentEntry = chosen[0];
  }

  enter() { this.unrollProgress = 0; }

  rerandom() { this._generateEssay(); }

  nextContent() { this.rerandom(); }
  prevContent() { this.rerandom(); }

  getCurrentEntry() { return this.currentEntry; }

  update(dt, time) {
    if (this.unrollProgress < 1) {
      this.unrollProgress = Math.min(1, this.unrollProgress + UNROLL_SPEED);
    }
  }

  draw(ctx, w, h, time) {
    const cx = w / 2, cy = h / 2;
    const e = this.unrollProgress;
    const ease = 1 - Math.pow(1 - e, 2);

    // === Scroll dimensions ===
    const scrollW = Math.min(w * 0.82, 740);
    const scrollH = Math.min(h * 0.68, 520);
    const rollerR = 12;
    const paperX = cx - scrollW / 2;
    const paperY = cy - scrollH / 2;
    const visibleW = scrollW * ease;

    // === Paper (aged 宣纸) ===
    ctx.save();
    ctx.beginPath();
    ctx.rect(paperX, paperY, visibleW, scrollH);
    ctx.clip();

    // Paper base — warm aged color
    const paperGrad = ctx.createLinearGradient(paperX, 0, paperX + scrollW, 0);
    paperGrad.addColorStop(0, '#e8dcc0');
    paperGrad.addColorStop(0.3, '#f0e8d0');
    paperGrad.addColorStop(0.7, '#f0e8d0');
    paperGrad.addColorStop(1, '#e8dcc0');
    ctx.fillStyle = paperGrad;
    ctx.fillRect(paperX, paperY, scrollW, scrollH);

    // Paper grain — 缓存纹理，不再每帧生成
    if (this._grainCanvas) {
      ctx.globalAlpha = 1;
      ctx.drawImage(this._grainCanvas, paperX, paperY, scrollW, scrollH);
    }
    ctx.globalAlpha = 1;

    // === Vertical ruling lines (like ancient exam paper) ===
    ctx.strokeStyle = 'rgba(120, 100, 80, 0.12)';
    ctx.lineWidth = 0.5;
    const margin = 28;
    const colW = 24;
    for (let x = paperX + margin; x < paperX + scrollW - margin; x += colW) {
      ctx.beginPath();
      ctx.moveTo(x, paperY + 12);
      ctx.lineTo(x, paperY + scrollH - 12);
      ctx.stroke();
    }

    // === Text: vertical columns, right-to-left (traditional) ===
    const fontSize = Math.min(18, colW * 0.8);
    const charsPerCol = Math.floor((scrollH - 40) / (fontSize * 1.5));
    const maxCols = Math.max(1, Math.floor((scrollW - margin * 2) / colW));
    const cols = Math.min(maxCols, Math.ceil(this.essay.length / charsPerCol));

    // 缓存版面参数，供 handleClick 做命中测试（坐标与绘制严格一致）
    this._layout = {
      paperX, paperY, scrollW, scrollH, margin, colW,
      fontSize, charsPerCol, cols, visibleW,
    };

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#2a1f14';

    for (let col = 0; col < cols && col * charsPerCol < this.essay.length; col++) {
      const startIdx = col * charsPerCol;
      const endIdx = Math.min(startIdx + charsPerCol, this.essay.length);
      const textCol = this.essay.slice(startIdx, endIdx);

      // Right-to-left: first column is on the right
      const colX = paperX + scrollW - margin - (col + 1) * colW;

      for (let row = 0; row < textCol.length; row++) {
        const char = textCol[row];
        const charY = paperY + 24 + row * fontSize * 1.5;
        const alpha = 0.75 + 0.15 * Math.sin(time * 0.001 + row * 0.3 + col * 0.5);
        ctx.globalAlpha = alpha * ease;
        ctx.font = `${fontSize}px "KaiTi","STKaiti","Alibaba PuHuiTi",serif`;
        ctx.fillText(char, colX, charY);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // === Roller (right side, follows unroll) ===
    if (visibleW > 10) {
      this._drawRoller(ctx, paperX + visibleW, cy, rollerR, scrollH);
    }

    // === Left roller (fixed) ===
    this._drawRoller(ctx, paperX, cy, rollerR, scrollH);

    // === Vermilion seal stamps ===
    // Each seal only appears once the unrolled paper has actually reached it,
    // fading in across the seal's own width as the scroll passes over it.
    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    // Right-bottom seal ('字'): left edge at paper-local x = scrollW - 46.
    // Begins fading in just as the paper reaches its left edge, fully in by its right edge.
    const rightSealProg = clamp01((visibleW - (scrollW - 56)) / 48);
    if (rightSealProg > 0) {
      const sealSize = 28;
      ctx.save();
      ctx.strokeStyle = `rgba(180, 60, 40, ${0.3 * rightSealProg + 0.05})`;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(paperX + scrollW - 46, paperY + scrollH - 42, sealSize, sealSize);
      ctx.fillStyle = `rgba(180, 60, 40, ${0.2 * rightSealProg})`;
      ctx.font = '12px "KaiTi","STKaiti",serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('字', paperX + scrollW - 32, paperY + scrollH - 28);
      ctx.restore();
    }

    // Left seal ('魂'): left edge at paper-local x = 18.
    const leftSealProg = clamp01((visibleW - 8) / 30);
    if (leftSealProg > 0) {
      ctx.save();
      ctx.strokeStyle = `rgba(180, 60, 40, ${0.2 * leftSealProg + 0.05})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(paperX + 18, paperY + 14, 20, 20);
      ctx.fillStyle = `rgba(180, 60, 40, ${0.15 * leftSealProg})`;
      ctx.font = '9px "KaiTi","STKaiti",serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('魂', paperX + 28, paperY + 24);
      ctx.restore();
    }

    // === Subtle edge darkening ===
    const vignette = ctx.createRadialGradient(cx, cy, scrollW * 0.3, cx, cy, scrollW * 0.75);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.12)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }

  _drawRoller(ctx, x, cy, r, h) {
    ctx.save();
    const halfH = h / 2;
    const grad = ctx.createLinearGradient(x - r, 0, x + r, 0);
    grad.addColorStop(0, '#5a3d20');
    grad.addColorStop(0.2, '#7a5a38');
    grad.addColorStop(0.5, '#8b6b48');
    grad.addColorStop(0.8, '#7a5a38');
    grad.addColorStop(1, '#4a3018');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(x, cy - halfH, r, r * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x, cy + halfH, r, r * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(x - r, cy - halfH + r * 0.4, r * 2, h - r * 0.8);
    ctx.globalAlpha = 0.06;
    ctx.strokeStyle = '#3a2510';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 6; i++) {
      const gy = cy - halfH + (i / 6) * h;
      ctx.beginPath();
      ctx.moveTo(x - r * 0.6, gy);
      ctx.lineTo(x + r * 0.6, gy + Math.sin(i * 1.5) * 1.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  handleClick(x, y) {
    const L = this._layout;
    if (!L || !this.essayEntries || !this.essayEntries.length) return false;

    // 入参 x,y 是中心相对坐标（main.js 已做 clientX - w/2），换算回屏幕坐标
    const w = window.innerWidth, h = window.innerHeight;
    const sx = x + w / 2;
    const sy = y + h / 2;

    // 相对宣纸左上角的坐标
    const rxRel = sx - L.paperX;
    const ryRel = sy - L.paperY;
    if (rxRel < 0 || rxRel > L.visibleW) return false; // 未展开区域不可点
    if (ryRel < 0 || ryRel > L.scrollH) return false;

    // 反算列（从右到左，0 列在最右）与行
    const col = Math.max(0, Math.min(L.cols - 1,
      Math.floor((L.scrollW - L.margin - rxRel) / L.colW)));
    const row = Math.max(0, Math.min(L.charsPerCol - 1,
      Math.floor((ryRel - 24) / (L.fontSize * 1.5))));
    const index = col * L.charsPerCol + row;
    if (index < 0 || index >= this.essayEntries.length) return false;

    const entry = this.essayEntries[index];
    if (this.onCharClick) this.onCharClick(entry);
    return true;
  }

  setMouse() {}
  dispose() {}
}