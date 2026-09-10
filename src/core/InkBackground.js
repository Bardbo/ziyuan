/**
 * InkBackground — 夜墨背景渲染系统（深色墨韵版）
 *
 * 第一性原理：夜里的墨——深沉但不是死黑。
 *   1. 焦墨底 — 深墨色底 + 中心微亮的径向受光（预渲染）
 *   2. 水墨晕染 — 大尺度灰墨 wash 缓慢流动，如夜雾中洇开的墨
 *   3. 纸纹 — 细微噪点平铺（预渲染缓存，给画面"材质"）
 *   4. 墨尘 — 极稀疏的暖金微尘缓浮（夜空中的金色颗粒）
 *
 * 性能：底色 + 纹理预渲染到离屏画布，每帧只重绘动层。
 */
export class InkBackground {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.inkBlobs = [];
    this.splatter = [];
    this.baseCanvas = null;   // 预渲染焦墨底
    this.paperCanvas = null;  // 预渲染纹理
    this.resize();
    this._initBlobs();
    this._initSplatter();
    this._buildBase();
    this._buildPaperTexture();
    this.animate = this.animate.bind(this);
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this._buildBase();
    this._buildPaperTexture();
  }

  // === 水墨晕染 blob ===
  _initBlobs() {
    // 6 个大尺度灰墨水痕，缓慢流动
    for (let i = 0; i < 6; i++) {
      this.inkBlobs.push({
        baseX: 0.15 + Math.random() * 0.7,
        baseY: 0.15 + Math.random() * 0.7,
        ampX: 0.08 + Math.random() * 0.12,
        ampY: 0.06 + Math.random() * 0.10,
        radius: 0.18 + Math.random() * 0.22,
        speedX: 0.00006 + Math.random() * 0.00004,
        speedY: 0.00005 + Math.random() * 0.00004,
        phaseX: Math.random() * Math.PI * 2,
        phaseY: Math.random() * Math.PI * 2,
        // 灰墨 alpha —— 比底色略亮的水墨痕
        ink: 0.02 + Math.random() * 0.028,
      });
    }
  }

  // === 金色墨尘微点 ===
  _initSplatter() {
    for (let i = 0; i < 18; i++) {
      this.splatter.push({
        x: Math.random(),
        y: Math.random(),
        r: 0.4 + Math.random() * 1.2,
        vx: (Math.random() - 0.5) * 0.00008,
        vy: -0.00002 - Math.random() * 0.00006,
        phase: Math.random() * Math.PI * 2,
        twinkle: 0.5 + Math.random() * 1.5,
      });
    }
  }

  // === 预渲染焦墨底（多层光晕：避免「一片死黑」的平面感）===
  _buildBase() {
    const w = this.canvas.width, h = this.canvas.height;
    if (w === 0 || h === 0) return;
    this.baseCanvas = document.createElement('canvas');
    this.baseCanvas.width = w;
    this.baseCanvas.height = h;
    const ctx = this.baseCanvas.getContext('2d');

    // 第一层：焦墨底色（深墨微暖）
    ctx.fillStyle = '#12100c';
    ctx.fillRect(0, 0, w, h);

    // 第二层：三处光晕（fake-bloom kit）—— 让夜墨「被照亮」而非纯黑
    // ① 标题后左上暖光（赭石）
    const b1 = ctx.createRadialGradient(
      w * 0.24, h * 0.18, 0,
      w * 0.24, h * 0.18, Math.max(w, h) * 0.55
    );
    b1.addColorStop(0, 'rgba(150, 116, 70, 0.32)');
    b1.addColorStop(0.45, 'rgba(96, 76, 50, 0.14)');
    b1.addColorStop(1, 'rgba(40, 32, 22, 0)');
    ctx.fillStyle = b1;
    ctx.fillRect(0, 0, w, h);

    // ② 中心烛照（原有受光，本体系主光源）
    const b2 = ctx.createRadialGradient(
      w * 0.5, h * 0.42, 0,
      w * 0.5, h * 0.42, Math.max(w, h) * 0.66
    );
    b2.addColorStop(0, 'rgba(52, 44, 34, 0.58)');
    b2.addColorStop(0.5, 'rgba(34, 30, 24, 0.30)');
    b2.addColorStop(1, 'rgba(24, 21, 16, 0)');
    ctx.fillStyle = b2;
    ctx.fillRect(0, 0, w, h);

    // ③ 底部地平线暖辉（远山落照）
    const b3 = ctx.createRadialGradient(
      w * 0.5, h * 0.96, 0,
      w * 0.5, h * 0.96, Math.max(w, h) * 0.50
    );
    b3.addColorStop(0, 'rgba(120, 84, 56, 0.36)');
    b3.addColorStop(0.5, 'rgba(86, 62, 44, 0.14)');
    b3.addColorStop(1, 'rgba(36, 28, 20, 0)');
    ctx.fillStyle = b3;
    ctx.fillRect(0, 0, w, h);

    // 第四层：四角轻压暗（夜色收边，较原版更淡，避免与 CSS 暗角叠加过沉）
    const vig = ctx.createRadialGradient(
      w / 2, h / 2, Math.min(w, h) * 0.42,
      w / 2, h / 2, Math.max(w, h) * 0.82
    );
    vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vig.addColorStop(0.72, 'rgba(0, 0, 0, 0.10)');
    vig.addColorStop(1, 'rgba(0, 0, 0, 0.30)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
  }

  // === 预渲染纹理（256x256 噪点）===
  _buildPaperTexture() {
    const size = 256;
    this.paperCanvas = document.createElement('canvas');
    this.paperCanvas.width = size;
    this.paperCanvas.height = size;
    const ctx = this.paperCanvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
      const n = Math.random();
      // 暗底上的细微亮噪点——颗粒质感
      const v = 30 + n * 60;
      data[i]     = v + 14;
      data[i + 1] = v + 8;
      data[i + 2] = v;
      data[i + 3] = n > 0.85 ? 22 : 5;
    }
    ctx.putImageData(img, 0, 0);
  }

  animate(time) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // 1) 预渲染焦墨底
    if (this.baseCanvas) {
      ctx.drawImage(this.baseCanvas, 0, 0);
    } else {
      ctx.fillStyle = '#12100c';
      ctx.fillRect(0, 0, w, h);
    }

    // 2) 水墨晕染 —— 灰墨在夜色中洇开
    for (const blob of this.inkBlobs) {
      const cx = w * (blob.baseX + Math.sin(time * blob.speedX + blob.phaseX) * blob.ampX);
      const cy = h * (blob.baseY + Math.cos(time * blob.speedY + blob.phaseY) * blob.ampY);
      const cr = Math.min(w, h) * blob.radius;
      const alpha = blob.ink * (0.8 + 0.2 * Math.sin(time * 0.0002 + blob.phaseX));

      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
      g.addColorStop(0,   `rgba(96, 86, 68, ${alpha})`);
      g.addColorStop(0.4, `rgba(80, 72, 56, ${alpha * 0.5})`);
      g.addColorStop(1,   'rgba(70, 62, 48, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, cr, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3) 纹理平铺
    if (this.paperCanvas) {
      const pattern = ctx.createPattern(this.paperCanvas, 'repeat');
      if (pattern) {
        ctx.globalAlpha = 0.10;
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
      }
    }

    // 4) 金色墨尘微点
    for (const s of this.splatter) {
      s.x += s.vx;
      s.y += s.vy;
      if (s.y < -0.02) { s.y = 1.02; s.x = Math.random(); }
      if (s.x < -0.02) s.x = 1.02;
      if (s.x > 1.02) s.x = -0.02;

      const px = s.x * w;
      const py = s.y * h;
      const tw = 0.3 + (Math.sin(time * 0.0008 + s.phase) + 1) * 0.5 * 0.7;
      const a = s.twinkle * tw * 0.06;
      ctx.fillStyle = `rgba(216, 190, 132, ${a})`;
      ctx.beginPath();
      ctx.arc(px, py, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
