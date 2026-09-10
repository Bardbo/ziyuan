/**
 * 字源 · SceneDirector — pure Canvas 2D (no WebGL)
 * Four acts, each a distinct visualization:
 *   一 · 字雨   — characters falling from the sky
 *   二 · 字之魂 — particles converging into a giant glyph
 *   三 · 字之穹 — first-person flying galaxy (诗云-style)
 *   四 · 字之山 — wave wall of characters
 * ↑↓ / 点击上下 1/3 切换场景；←→ 切换场景内内容；字之穹 WASD 飞行.
 */
import { dataLoader } from './core/DataLoader.js';
import { MonkeyTyping } from './core/MonkeyTyping.js';
import { CharacterRain } from './core/CharacterRain.js';
import { ParticleChar } from './core/ParticleChar.js';
import { StarField } from './core/StarField.js';
import { WaveWall } from './core/WaveWall.js';
import { BoidsSwarm } from './core/BoidsSwarm.js';
import { ScrollReveal } from './core/ScrollReveal.js';
import { InkBackground } from './core/InkBackground.js';
import { DetailPanel } from './ui/DetailPanel.js';

const ACT_TITLES = ['猴子打字', '字雨', '字之魂', '字之穹', '字之山', '字鸟', '卷轴'];

export class SceneDirector {
  constructor() {
    this.act = 0;
    this.paused = false;
    this.actStart = performance.now();
    this.scenes = [null, null, null, null, null, null, null];
    this.detailPanel = null;
    this.inkBg = null;
    this.canvas = null;
    this.ctx = null;
    this.keys = {};
    this.dragging = false;
    this.dragMoved = false;

    this.ui = {
      overlay: document.getElementById('transition-overlay'),
      dots: document.querySelectorAll('.act-dot'),
      title: document.getElementById('act-title'),
      progress: document.getElementById('act-progress-bar'),
      curChar: document.getElementById('act-current-char'),
      hint: document.getElementById('act-hint'),
      charCount: document.getElementById('stat-chars'),
      searchInput: document.getElementById('search-input'),
      searchBtn: document.getElementById('search-btn'),
    };
  }

  async init() {
    // motion-pages: ?still 模式 —— 冻结所有时间相关动画，用于确定性截图
    if (window.location.search.includes('still')) {
      document.body.classList.add('still');
    }

    const loadingProgress = document.getElementById('loading-progress');
    await dataLoader.init((p) => {
      loadingProgress.style.width = `${p}%`;
    });

    // Preload the hanzi webfont so canvas glyphs render correctly
    try {
      await Promise.race([
        document.fonts.load('190px "Alibaba PuHuiTi"', '永字八法'),
        new Promise((res) => setTimeout(res, 8000)),
      ]);
    } catch (e) { /* fallback fonts apply */ }
    if (loadingProgress) loadingProgress.style.width = '100%';

    this.ui.charCount.textContent = dataLoader.getTotalChars().toLocaleString();

    // --- Scene canvas (top layer, transparent) ---
    const container = document.getElementById('canvas-container');
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.ctx = this.canvas.getContext('2d');
    this._resizeCanvas();
    container.appendChild(this.canvas);

    // --- Background ink (bottom layer) ---
    this.inkBg = new InkBackground(document.getElementById('bg-canvas'));

    // --- Detail panel ---
    this.detailPanel = new DetailPanel();
    const self = this;
    this.detailPanel.onClose = function () {
      self.paused = false;
      self.actStart = performance.now();
      const s = self.scenes[self.act];
      if (s && s.resetHighlight) s.resetHighlight();
    };

    // --- Mount act 0 ---
    // Pre-construct ALL scenes once (no GC churn on switch)
    this.scenes[0] = new MonkeyTyping(dataLoader);
    this.scenes[1] = new CharacterRain(dataLoader);
    this.scenes[2] = new ParticleChar(dataLoader);
    this.scenes[3] = new StarField(dataLoader);
    this.scenes[4] = new WaveWall(dataLoader);
    this.scenes[5] = new BoidsSwarm(dataLoader);
    this.scenes[6] = new ScrollReveal(dataLoader);
    // Wire click handlers
    for (const s of this.scenes) s.onCharClick = (entry) => this._openChar(entry);
    // Activate act 0
    this.scenes[0].enter(dataLoader);
    this.act = 0;
    this._updateHUD(0);

    // --- Events ---
    this._bindEvents();

    // --- Tools ---
    this._initTools();

    // --- Hide loading ---
    const loadingScreen = document.getElementById('loading-screen');
    loadingScreen.classList.add('fade-out');
    // 入场编排：loading 退场同时让 UI 浮现
    document.body.classList.add('ready');
    if (document.body.classList.contains('still')) {
      document.body.classList.add('settled');
    } else {
      setTimeout(() => document.body.classList.add('settled'), 1600);
    }
    setTimeout(() => { loadingScreen.style.display = 'none'; }, 1200);

    // 流体 UI 的光标跟随光
    this._wireFluidLight();

    this._loop();
  }

  _wireFluidLight() {
    // 仅在指针真正悬停的 .fluid 元素上更新 --mx/--my（百分比，相对元素自身）
    window.addEventListener('pointermove', (e) => {
      const el = e.target && e.target.closest ? e.target.closest('.fluid') : null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
      el.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
    }, { passive: true });
  }

  _resizeCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _bindEvents() {
    const self = this;

    window.addEventListener('resize', () => {
      this._resizeCanvas();
      this.inkBg.resize();
    });

    // Click: center region → scene interaction (scene switching via bottom dots only)
    this.canvas.addEventListener('click', (e) => {
      if (this.dragMoved && this.act === 3) { this.dragMoved = false; return; } // was a drag-look in 字之穹
      // Center → scene interaction (center-relative coords)
      const rx = e.clientX - window.innerWidth / 2;
      const ry = e.clientY - window.innerHeight / 2;
      const s = this.scenes[this.act];
      if (s && s.handleClick) {
        const handled = s.handleClick(rx, ry);
        if (handled) return;
      }
      if (this.act === 1 && s && s.currentEntry) {
        this._openChar(s.currentEntry);
      }
    });

    // ---------- Mouse look (drag to turn camera — 字之穹 only) ----------
    this.canvas.addEventListener('mousedown', (e) => {
      if (this.act === 3) { this.dragging = true; this.dragMoved = false; }
    });
    window.addEventListener('mouseup', () => { this.dragging = false; });

    this.canvas.addEventListener('pointermove', (e) => {
      if (this.dragging && this.act === 2) {
        const dx = e.movementX || 0;
        const dy = e.movementY || 0;
        if (Math.abs(dx) + Math.abs(dy) > 0) this.dragMoved = true;
        const s = this.scenes[this.act];
        if (s && s.lookDrag) s.lookDrag(dx, dy);
        return;
      }
      const rx = e.clientX - window.innerWidth / 2;
      const ry = e.clientY - window.innerHeight / 2;
      const s = this.scenes[this.act];
      if (s && s.setMouse) s.setMouse(rx, ry);
    });

    // Scroll → adjust flight speed (字之穹)
    this.canvas.addEventListener('wheel', (e) => {
      const s = this.scenes[this.act];
      if (s && s.setSpeedFactor) {
        s.setSpeedFactor(e.deltaY > 0 ? 0.8 : 1.25);
        e.preventDefault();
      }
    }, { passive: false });

    // HUD dots: manual switching
    this.ui.dots.forEach((dot) => {
      dot.addEventListener('click', () => {
        const idx = parseInt(dot.dataset.act, 10);
        if (idx !== self.act) self._switchAct(idx);
      });
    });

    // Keyboard: WASD flight (字之穹), ←→ scene content, R re-randomize, 猴子打字 any key
    window.addEventListener('keydown', (e) => {
      if (e.target && e.target.tagName === 'INPUT') return;
      this.keys[e.key.toLowerCase()] = true;
      if (e.key === 'ArrowLeft') {
        const s = this.scenes[this.act];
        if (s && s.prevContent) s.prevContent();
      } else if (e.key === 'ArrowRight') {
        const s = this.scenes[this.act];
        if (s && s.nextContent) s.nextContent();
      } else if (e.key.toLowerCase() === 'r') {
        const s = this.scenes[this.act];
        if (s && s.rerandom) s.rerandom(dataLoader);
      } else {
        // Any other key → type random chars (猴子打字)
        const s = this.scenes[this.act];
        if (s && s.typeChars) {
          const count = 1 + Math.floor(Math.random() * 3); // 1–3 chars per key
          s.typeChars(count);
        }
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys[e.key.toLowerCase()] = false;
    });

    // Search → jump to act 1 (字之魂 particle morph)
    const doSearch = () => {
      const char = this.ui.searchInput.value.trim();
      if (!char) return;
      const entry = dataLoader.getIndexEntry(char);
      if (!entry) return;
      this._switchAct(1);
      setTimeout(() => {
        const s = this.scenes[1];
        if (s && s.jumpToChar) s.jumpToChar(char);
        this._openChar(entry);
      }, 350);
    };
    this.ui.searchBtn.addEventListener('click', doSearch);
    this.ui.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch();
    });
  }

  _mountAct(idx) {
    this.act = idx;
    const s = this.scenes[idx];
    if (s && s.enter) s.enter(this.dataLoader || dataLoader);
    this._updateHUD(idx);
    this.actStart = performance.now();
  }

  _updateHUD(idx) {
    this.ui.dots.forEach((d, i) => d.classList.toggle('active', i === idx));
    this.ui.title.textContent = ACT_TITLES[idx];
    this.ui.hint.textContent =
      idx === 0 ? '乱按键盘打字 · R 清空' :
      idx === 1 ? 'R 换新字 · 点击字溯源' :
      idx === 2 ? '← → 浏览字 · R 随机新字' :
      idx === 3 ? 'WASD 飞行 · 拖拽转向 · 滚轮调速 · ← → 跳星团' :
      idx === 4 ? 'R 换新山水 · 点击字溯源' :
      idx === 5 ? '点击撒食喂鸟 · 点字溯源 · R 换群' :
      'R 换新文 · 点击卷轴溯源';
  }

  _openChar(entry) {
    if (!entry) return;
    this.paused = true;
    this.detailPanel.show(entry, dataLoader);
  }

  _switchAct(idx) {
    if (idx === this.act) return;
    // 墨晕过渡：快速遮罩 → 切换 → 露出
    const overlay = this.ui.overlay;
    overlay.classList.add('fade-in');
    setTimeout(() => {
      this._mountAct(idx);
      setTimeout(() => overlay.classList.remove('fade-in'), 30);
    }, 220);
  }

  _loop() {
    // motion-pages: ?still 模式 —— 冻结画布，先以固定步长预热场景，再渲染一帧确定态后停 RAF
    // （两次截图必须逐像素一致；否则 CSS 冻了、canvas 还在动，仍非确定态）
    if (document.body.classList.contains('still')) {
      const s = this.scenes[this.act];
      const steps = 150;
      for (let i = 0; i < steps; i++) {
        if (s && s.update) s.update(1 / 60, i / 60);
      }
      this.inkBg.animate(0);
      this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      if (s && s.draw) s.draw(this.ctx, window.innerWidth, window.innerHeight, 0);
      return;
    }

    const self = this;
    let last = performance.now();

    const animate = (now) => {
      requestAnimationFrame(animate);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const elapsed = now / 1000;

      // Background always
      self.inkBg.animate(now);

      // Clear scene canvas every frame (Canvas 2D does NOT auto-clear)
      self.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      // Active scene
      const s = self.scenes[self.act];
      if (s) {
        if (s.applyInput) s.applyInput(self.keys, dt);
        if (s.update) s.update(dt, elapsed);
        if (s.draw) s.draw(self.ctx, window.innerWidth, window.innerHeight, now);
      }
    };
    requestAnimationFrame(animate);
  }

  _initTools() {
    // Direct launch icons → open tool page (no gear panel)
    document.querySelectorAll('.tool-launch-icon').forEach((icon) => {
      icon.addEventListener('click', (e) => {
        e.stopPropagation();
        const tool = icon.dataset.tool;
        if (tool === 'character-art') {
          if (!this.characterArt) {
            import('./tools/CharacterArt.js').then((mod) => {
              this.characterArt = new mod.CharacterArt();
              this.characterArt.onCharClick = (entry) => this._openChar(entry);
              this.characterArt.show();
            });
          } else {
            this.characterArt.show();
          }
        }
      });
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const director = new SceneDirector();
  director.init().catch(console.error);
  window.__director = director;
});