/**
 * CharacterArt — 字符画转换器
 * Upload image/video and render as a stream of Chinese characters.
 *
 * 交互：
 *   · 点击画布上的字 → 打开该字的字源详情（字画溯源）
 *   · 上传视频 → 逐帧渲染为字符画
 *   · 下载按钮 → 导出当前字符画为 PNG
 *
 * ── 三条关键不变量 ────────────────────────────────────────────────
 * 1. 宽高比：字符网格的行列由「源图长宽比 ÷ 字符胞宽高比」推导，再按
 *    contain 方式居中放进画布 —— 绝不拉伸到容器尺寸。
 * 2. 墨色可见性：深底上作画，暗部像素必须被提亮到可见区间，否则字是隐形的。
 *    做法：取源色「归一化色相」，再按亮度重定标到 52..248，保留原图色彩关系。
 * 3. 字梯度取自 dataLoader 索引按笔画数分位采样 —— 梯度里的每个字必定
 *    ① 在基本区（字体可渲染，无豆腐块）② 存在于索引（点击必定能溯源）。
 */
import { dataLoader } from '../core/DataLoader.js';
import { DetailPanel } from '../ui/DetailPanel.js';
import { Muxer, ArrayBufferTarget } from '../lib/mp4-muxer.mjs';

/** 保底梯度（dataLoader 尚未就绪时使用），按视觉墨量 稀 → 密 排列 */
const FALLBACK_HANZI =
  '一卜匕十厂七丁人入又几力乃二三千工土士寸下大丈万上小口山千川夕久么凡' +
  '之尸弓己子女门日木水火天云不中心手毛片化什公今分六方文勿风勾办以双书' +
  '田由甲申只央兄册电生失丘付代仙们仪白目石立车示礼禾穴它主市兰写让永司' +
  '民出发成百存而页匠至光当早虫曲同因回岁肉年先丢竹休件任伤价华自向行舟' +
  '全会合企众伞色壮衣产充羊并关米江池汤宇守安完家宵宴宿密富实宝宗定宜官' +
  '空帘穿突窗窝窥站竟章童端竞产彦形影彩彰须彪彬彭';

/** ASCII 梯度：index 0 = 墨最少，末位 = 墨最多 */
const ASCII_RAMP = ' .:-=+*#%@';

/** 字符胞宽高比（cellW / cellH）—— 汉字近正方，等宽 ASCII 约 0.54 */
const CELL_ASPECT = { hanzi: 1.0, ascii: 0.54 };

/** 基础列数（密度 1..3 的倍率） */
const BASE_COLS = 96;

/** 墨色亮度区间：最暗也保持可见，最亮不过曝 */
const INK_MIN = 90;
const INK_MAX = 248;

export class CharacterArt {
  constructor() {
    if (typeof window !== 'undefined') window.__CA = this;   // 调试/性能剖析句柄
    this.canvas = document.getElementById('ca-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.video = null;
    this.playing = false;
    this.rafId = null;
    this.lastImage = null;
    this.grid = [];        // 渲染网格：点击溯源用
    this.detailPanel = null;
    this.ramp = null;      // 懒构建的汉字梯度
    this.dpr = 1;
    this.cssW = 0;
    this.cssH = 0;
    // 视频高清录制用的离屏画布
    this._recording = false;
    this._recorder = null;
    this.recCanvas = null;
    this.recCtx = null;
    this.recW = 0;
    this.recH = 0;
    this._discardRecording = false;
    this._abortSynthesis = false;
    this._bindEvents();
    window.addEventListener('resize', () => {
      if (!document.getElementById('tool-character-art').classList.contains('hidden')) {
        this._resize();
      }
    });
  }

  // ───────────────────────── 字梯度 ─────────────────────────

  /**
   * 从项目索引生成「按笔画数分位采样」的汉字梯度。
   * 只取基本区（U+4E00–9FFF）—— 字体对该区是满覆盖，不会出现豆腐块；
   * 且采样源就是索引本身，所以梯度里的字一定能被 getIndexEntry 查到。
   */
  _buildRamp() {
    if (this.ramp) return this.ramp;
    const N = 56;
    try {
      const pool = [];
      for (const e of dataLoader.index) {
        const cp = parseInt(e[1].slice(2), 16);
        if (cp >= 0x4e00 && cp <= 0x9fff) pool.push(e);
      }
      if (pool.length < N) throw new Error('pool too small');
      pool.sort((a, b) => (a[3] || 0) - (b[3] || 0));
      const ramp = [];
      for (let i = 0; i < N; i++) {
        ramp.push(pool[Math.floor((i * (pool.length - 1)) / (N - 1))][0]);
      }
      this.ramp = ramp.join('');
    } catch (err) {
      console.warn('[字符画] 索引梯度构建失败，使用保底梯度:', err);
      this.ramp = FALLBACK_HANZI;
    }
    return this.ramp;
  }

  /** 取「字符」输入框内容（trim 后） */
  _getCustomText() {
    const el = document.getElementById('ca-text-input');
    return el ? el.value.trim() : '';
  }

  /** 输入框是否有有效文字（用于切换「随机选字」模式） */
  _customActive() {
    return this._getCustomText().length > 0;
  }

  /**
   * 选取字符集：
   *   · ascii 风格 → 固定 ASCII 梯度
   *   · 输入框有内容 → 用输入框中的字（去重、去掉空白）作为字符集
   *   · 否则 → 字库按笔画分位采样的梯度（_buildRamp）
   * 注：自定义文字模式下，每个字格从该字符集中【随机抽取】一个字（见 _drawGrid 的 random），
   *     而非按亮度排成由淡到浓的梯度；画面靠每字的源图像素着色成形。
   */
  _getRamp(style) {
    if (style === 'ascii') return ASCII_RAMP;
    const custom = this._getCustomText();
    if (custom) {
      const seen = new Set();
      const chars = [];
      for (const ch of custom) {
        if (ch === ' ' || ch === '\n' || ch === '\t') continue;
        if (!seen.has(ch)) { seen.add(ch); chars.push(ch); }
      }
      if (chars.length) return chars.join('');
    }
    return this._buildRamp();
  }

  // ───────────────────────── 事件 ─────────────────────────

  _bindEvents() {
    const $ = (id) => document.getElementById(id);

    $('ca-image-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      this._stopVideo();
      const img = new Image();
      img.onload = () => {
        this._renderImage(img);
        $('ca-empty').style.display = 'none';
        $('ca-download').textContent = '下载图片';
      };
      img.onerror = () => this._toast('图片读取失败，请换一张试试');
      img.src = URL.createObjectURL(file);
      e.target.value = '';   // 允许重复选同一个文件
    });

    $('ca-video-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      this._stopVideo();
      this._videoFile = file;          // 保留原文件：合成/录制时需解码其中的音轨
      const video = document.createElement('video');
      video.src = URL.createObjectURL(file);
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      this.video = video;
      this._warmUpCodec();          // 预热编解码子系统：避免首次点下载时 codec 探测失败
      $('ca-play').textContent = '▶';
      $('ca-video-controls').hidden = false;
      $('ca-empty').style.display = 'none';
      $('ca-download').textContent = '下载视频';

      // 元数据就绪前 videoWidth/Height 为 0 → 必须等 loadedmetadata 再播
      video.addEventListener('loadedmetadata', () => {
        video.play().then(() => {
          this.playing = true;
          $('ca-play').textContent = '⏸';
          this._renderVideoFrame();
        }).catch(() => {
          // 自动播放被拦截：停在首帧，用户可手动点播放
          this.playing = false;
          $('ca-play').textContent = '▶';
          this._renderVideoFrame();
        });
      });

      video.addEventListener('error', () => {
        this._toast('视频格式不支持，请尝试 mp4 / webm');
      });
      e.target.value = '';
    });

    $('ca-play').addEventListener('click', () => {
      if (!this.video) return;
      const $p = $('ca-play');
      if (this.playing) {
        this.video.pause();
        this.playing = false;
        $p.textContent = '▶';
        if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
      } else {
        this.video.play().then(() => {
          this.playing = true;
          $p.textContent = '⏸';
          this._renderVideoFrame();
        }).catch(() => {});
      }
    });

    // 密度/风格/自定义字符 改动 → 对当前素材重新渲染（图片与视频都支持）
    const rerender = () => {
      if (this.video) this._renderVideoFrame();
      else if (this.lastImage) this._renderImage(this.lastImage);
    };
    $('ca-density').addEventListener('input', rerender);
    $('ca-style').addEventListener('change', rerender);
    $('ca-text-input').addEventListener('input', rerender);

    $('ca-download').addEventListener('click', () => this._download());

    this.canvas.addEventListener('click', (e) => this._handleClick(e));

    $('ca-close').addEventListener('click', () => {
      this._stopVideo();
      this._hide();
    });
  }

  /**
   * 轻量提示：在画布区的状态浮层显示一行文字，2.2s 后自动隐藏（不残留、不遮挡画面）。
   * 与「导出进度」共用 #ca-status；提示不带进度条。
   */
  _toast(msg) {
    const box = document.getElementById('ca-status');
    const txt = document.getElementById('ca-status-text');
    const bar = box && box.querySelector('.ca-status-bar');
    if (!box || !txt) return;
    txt.textContent = msg;
    if (bar) bar.hidden = true;                 // 提示不带进度条
    box.hidden = false;
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => { box.hidden = true; }, 2200);
  }

  /** 开始显示一个带进度条的状态（合成进度用） */
  _showProgress(pct) {
    const box = document.getElementById('ca-status');
    const bar = box && box.querySelector('.ca-status-bar');
    if (!box) return;
    clearTimeout(this._statusTimer);
    box.hidden = false;
    if (bar) bar.hidden = false;
    this._setProgress(pct);
  }

  /** 更新合成进度条：pct 取 0~100，基于已合成帧数（单调递增，不乱跳） */
  _setProgress(pct) {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    const txt = document.getElementById('ca-status-text');
    const fill = document.getElementById('ca-status-fill');
    if (txt) txt.textContent = `合成中… ${pct}%`;
    if (fill) fill.style.width = pct + '%';
  }

  /** 隐藏状态浮层（合成完成 / 失败兜底时调用，确保不残留「合成中 X%」） */
  _hideStatus() {
    const box = document.getElementById('ca-status');
    if (!box) return;
    clearTimeout(this._statusTimer);
    box.hidden = true;
  }

  // ───────────────────────── 渲染 ─────────────────────────

  /**
   * 计算字符网格的行列数。
   * 关键：cols 只由密度决定、rows 只由「源图长宽比 × 胞宽高比」决定 —— 与输出
   * 像素尺寸无关。于是「屏幕渲染」与「高清导出」共用同一套网格，仅每格像素不同。
   */
  _computeGrid(sw, sh, style, density) {
    const A = CELL_ASPECT[style] || CELL_ASPECT.hanzi;
    const cols = Math.max(8, Math.round(BASE_COLS * density * 0.6));
    const rows = Math.max(2, Math.round((cols * A * sh) / sw));
    return { cols, rows };
  }

  _render(source, style) {
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    if (!sw || !sh) return;
    const W = this.cssW, H = this.cssH;
    if (W <= 0 || H <= 0) return;

    const density = parseInt(document.getElementById('ca-density').value, 10) || 2;
    const { cols, rows } = this._computeGrid(sw, sh, style, density);
    const ramp = this._getRamp(style);

    // 屏幕画布：按 DPR 变换，之后一律按 CSS 像素作图
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const random = this._customActive();
    this._drawGrid(this.ctx, W, H, source, style, cols, rows, ramp, true, random);
  }

  /**
   * 把 source 渲染成字符画到给定 ctx（屏幕或离屏高清画布通用）。
   * @param recordGrid 仅对屏幕画布记录点击溯源网格（离屏导出不记录）
   * @param random  true=每个字格从 ramp 字符集中随机抽取（自定义文字模式）；
   *                false=按亮度在 ramp 中定位（字库/ASCII 梯度模式）
   */
  _drawGrid(ctx, W, H, source, style, cols, rows, ramp, recordGrid = false, random = false) {
    const A = CELL_ASPECT[style] || CELL_ASPECT.hanzi;
    // contain 拟合：取能同时塞进画布的最大胞宽
    const cw = Math.min(W / cols, (A * H) / rows);
    const ch = cw / A;
    const outW = cols * cw, outH = rows * ch;
    const ox = Math.max(0, (W - outW) / 2);
    const oy = Math.max(0, (H - outH) / 2);

    ctx.fillStyle = '#0f0b08';
    ctx.fillRect(0, 0, W, H);

    // 降采样到 cols×rows 取色（temp 画布与网格同尺寸，不引入形变）；
    // 复用临时画布（按 cols×rows 缓存）+ willReadFrequently 加速回读，避免每帧重建。
    const key = cols + 'x' + rows;
    let tmp = this._tmpCanvas;
    if (!tmp || tmp._key !== key) {
      tmp = document.createElement('canvas');
      tmp.width = cols;
      tmp.height = rows;
      tmp._key = key;
      tmp._ctx = tmp.getContext('2d', { willReadFrequently: true });
      this._tmpCanvas = tmp;
    }
    const tctx = tmp._ctx;
    tctx.drawImage(source, 0, 0, cols, rows);
    const data = tctx.getImageData(0, 0, cols, rows).data;

    const fontPx = Math.max(3, ch * 0.92);
    const fontStr = `${fontPx.toFixed(2)}px "Alibaba PuHuiTi","Noto Serif SC","SimSun",monospace`;
    // fillText 路径：font/对齐只设一次（逐格重设 font 会重置文本度量，极慢）；逐格仅改 fillStyle + fillText。
    // 已验证：1280 下每帧 ~30ms（font 仅设一次后更快），可稳定「一源帧:一输出帧」零丢帧导出（rVFC 不会合帧）。
    // 字形图集(drawImage+multiply 染色)在软件渲染下反而 ~180ms/帧，比 fillText 更慢，已弃用。
    ctx.font = fontStr;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (recordGrid) this.grid = [];

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;

        // 亮度 → 墨量（深底作画：越亮的地方墨越重）；墨色由源像素决定，
        // 故即便随机选字，画面仍靠颜色成形。
        const t = lum / 255;
        const char = random
          ? (ramp.length ? ramp[(Math.random() * ramp.length) | 0] : ' ')
          : ramp[Math.max(0, Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1))))];
        if (char === ' ') continue;

        // 提亮到可见区间，同时保留原色相：
        // 先把源色按最大通道归一化得到色相，再整体重定标到 INK_MIN..INK_MAX
        const mx = Math.max(r, g, b);
        const v = INK_MIN + t * (INK_MAX - INK_MIN);
        let cr, cg, cb;
        if (mx < 8) {
          // 近黑像素没有色相可言 → 用中性暖墨，避免除零且保证可见
          cr = v; cg = v * 0.93; cb = v * 0.80;
        } else {
          cr = (r / mx) * v; cg = (g / mx) * v; cb = (b / mx) * v;
        }

        const cx = ox + x * cw;
        const cy = oy + y * ch;
        ctx.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
        ctx.fillText(char, cx + cw / 2, cy + ch / 2);
        if (recordGrid) this.grid.push({ char, x: cx, y: cy, w: cw, h: ch });
      }
    }
  }

  // 字形图集方案（drawImage + multiply 染色）在软件渲染下反而比 fillText 更慢（~180ms/帧 vs ~30ms），
  // 会触发 rVFC 合帧丢帧 → 导出卡顿，已弃用。当前统一走 _drawGrid 内的 fillText 路径。

  _renderImage(img) {
    this.lastImage = img;
    const style = document.getElementById('ca-style').value;
    this._render(img, style);
  }

  _renderVideoFrame() {
    if (!this.video) return;
    // 元数据未就绪时跳过（loadedmetadata 后会再调一次）
    if (!this.video.videoWidth || !this.video.videoHeight) return;
    const style = document.getElementById('ca-style').value;
    this._render(this.video, style);          // 屏幕预览 + 点击溯源网格
    // 录制时同步绘制高清离屏画布（字符数相同，仅每格像素更大）
    if (this._recording && this.recCtx) {
      const sw = this.video.videoWidth, sh = this.video.videoHeight;
      const density = parseInt(document.getElementById('ca-density').value, 10) || 2;
      const { cols, rows } = this._computeGrid(sw, sh, style, density);
      const ramp = this._getRamp(style);
      const random = this._customActive();
      this._drawGrid(this.recCtx, this.recW, this.recH, this.video, style, cols, rows, ramp, false, random);
    }
    if (this.playing) {
      this.rafId = requestAnimationFrame(() => this._renderVideoFrame());
    }
  }

  // ───────────────────────── 交互 ─────────────────────────

  _handleClick(e) {
    if (this.grid.length === 0) return;
    const rect = this.canvas.getBoundingClientRect();
    // 画布按 DPR 变换作图，但 rect 是 CSS 像素 → 直接用 CSS 坐标比对
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    for (const cell of this.grid) {
      if (px >= cell.x && px < cell.x + cell.w &&
          py >= cell.y && py < cell.y + cell.h) {
        this._openChar(cell.char);
        return;
      }
    }
  }

  _openChar(char) {
    if (!char || char === ' ') return;
    const entry = dataLoader.getIndexEntry(char);
    if (!entry) { this._toast(`「${char}」暂未收录字源`); return; }
    if (this.onCharClick) {
      this.onCharClick(entry);
    } else {
      if (!this.detailPanel) {
        this.detailPanel = new DetailPanel();
        this.detailPanel.onClose = () => {};
      }
      this.detailPanel.show(entry, dataLoader);
    }
  }

  /** 下载：图片 → 高清 PNG；视频 → 离线合成 MP4（回退实时录制） */
  _download() {
    if (this.grid.length === 0) { this._toast('请先上传图片或视频'); return; }
    if (this.video) { this._synthesizeVideo(); return; }
    this._exportImage(this.lastImage, document.getElementById('ca-style').value);
  }

  /**
   * 高清导出：渲染到离屏大画布（每字约 CELL_PX 像素），与屏幕分辨率解耦，
   * 保证放大后汉字依然清晰。
   */
  _exportImage(source, style) {
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    if (!sw || !sh) return;
    const density = parseInt(document.getElementById('ca-density').value, 10) || 2;
    const { cols, rows } = this._computeGrid(sw, sh, style, density);
    const A = CELL_ASPECT[style] || CELL_ASPECT.hanzi;

    // 单一导出模式：与网页「同一套网格(cols×rows)」渲染，但按源图比例铺满、每字 ~40px。
    // → 字符网格/密度与网页完全一致；
    // → 导出保持原图宽高比，不再带网页面板比例造成的黑边；
    // → 放大/打印查看时汉字清晰（每字有真实像素，非拉伸）。
    const MAX = 9000;                            // 防止极端尺寸爆内存
    const CELL_PX = 40;                          // 每字约 40px，保证放大后清晰
    let exportW = cols * CELL_PX;
    let exportH = Math.round(rows * CELL_PX / A);
    // 等比压缩到 MAX，避免爆内存/浏览器画布限制（保持源图比例）
    if (Math.max(exportW, exportH) > MAX) {
      const s = MAX / Math.max(exportW, exportH);
      exportW = Math.round(exportW * s);
      exportH = Math.round(exportH * s);
    }

    const c = document.createElement('canvas');
    c.width = exportW; c.height = exportH;
    const cx = c.getContext('2d');
    const ramp = this._getRamp(style);
    const random = this._customActive();
    this._drawGrid(cx, exportW, exportH, source, style, cols, rows, ramp, false, random);

    c.toBlob((blob) => {
      if (!blob) { this._toast('导出失败，请重试'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `字源字符画_${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      this._toast('高清图片已导出 ✔');
    }, 'image/png');
  }

  /** 浏览器是否支持 WebCodecs 离线合成（VideoEncoder + VideoFrame） */
  _canSynthesize() {
    return (typeof VideoEncoder !== 'undefined') && (typeof VideoFrame !== 'undefined');
  }

  /**
   * 选取受支持的 H.264 配置（高 profile/level 优先，逐步降级），并确定样本数据格式。
   * 返回 { codec, format } 或 null。
   *
   * ★ format='avc' vs 'annexb'（实测结论，直接决定导出视频能否流畅播放）：
   *   · 'avc'    → Chrome 输出的样本数据【已经是长度前缀格式】，且在关键帧的
   *                meta.decoderConfig.description 里【直接给出正确的 avcC】(实测 42 字节)。
   *                MP4 封装零手工处理 —— 这是最标准、最不易出错的路径，优先使用。
   *   · 'annexb' → Chrome 【完全不提供】 description（实测 12 个 chunk 的 descLen 全为 0），
   *                只能从码流里抽 SPS/PPS 手工拼 avcC，并把起始码逐条转成长度前缀。
   *                这两处手工逻辑一旦有偏差，解码器就会按错误参数解析，报
   *                "error while decoding MB x y, bytestream -N"（错误集中在画面底部宏块行）
   *                → 播放器花屏 / 跳帧 / 一顿一顿。因此只在 'avc' 不可用时才回退。
   */
  async _pickH264(w, h, bitrate, fps) {
    const candidates = ['avc1.640033', 'avc1.640032', 'avc1.640028', 'avc1.42E01E', 'avc1.42001f'];
    for (const codec of candidates) {
      for (const format of ['avc', 'annexb']) {
        try {
          const res = await VideoEncoder.isConfigSupported({
            codec, width: w, height: h, bitrate, framerate: fps, avc: { format },
          });
          if (res && res.supported) return { codec, format };
        } catch (_) {}
      }
    }
    return null;
  }

  /**
   * 预热 WebCodecs：编解码子系统在【首次】被使用前常处于未就绪状态，导致首帧
   * isConfigSupported 抖动返回不支持 —— 这正是「第一次点下载没反应、第二次才正常」的根因。
   * 上传视频后先用极小尺寸做一次真实编码把子系统热起来，这样用户点下载时探测必定成功，
   * 一次点击即可导出。纯预热处理：全程 try/catch 静默失败，不影响主流程。
   */
  async _warmUpCodec() {
    if (!this._canSynthesize()) return;
    try {
      const picked = await this._pickH264(320, 240, 1_000_000, 30);
      if (!picked) return;
      const codec = picked.codec;
      const enc = new VideoEncoder({ output: () => {}, error: () => {} });
      enc.configure({ codec, width: 320, height: 240, bitrate: 1_000_000, framerate: 30 });
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      const g = c.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, 320, 240);
      const frame = new VideoFrame(c, { timestamp: 0, duration: 33333 });
      enc.encode(frame, { keyFrame: true });
      frame.close();
      await enc.flush();
      enc.close();
    } catch (_) {}
  }

  /** 等待 video seek 到指定时间（含已就位 / 超时兜底） */
  _seekTo(video, t) {
    return new Promise((resolve) => {
      if (Math.abs(video.currentTime - t) < 1e-3) { resolve(); return; }
      let done = false;
      const finish = () => { if (done) return; done = true; video.removeEventListener('seeked', finish); resolve(); };
      video.addEventListener('seeked', finish);
      try { video.currentTime = t; } catch (_) { finish(); }
      setTimeout(finish, 1200);
    });
  }

  /** 等待视频元数据就绪（videoWidth / duration 可用），超时则放行 */
  _awaitMetadata(timeout = 3000) {
    const v = this.video;
    if (!v) return Promise.resolve(false);
    const ready = () => v.videoWidth && isFinite(v.duration) && v.duration > 0;
    if (ready()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        v.removeEventListener('loadedmetadata', finish);
        clearTimeout(t);
        resolve(ready());
      };
      v.addEventListener('loadedmetadata', finish);
      const t = setTimeout(finish, timeout);
    });
  }

  // ───────────────────────── 音频（保留原音轨） ─────────────────────────

  /** 选取受支持的 AAC 配置（优先 48k，逐步降级到 44.1k / 32k） */
  async _pickAAC() {
    if (typeof AudioEncoder === 'undefined') return null;
    const rates = [48000, 44100, 32000];
    for (const rate of rates) {
      try {
        const res = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: 2, bitrate: 192000 });
        if (res && res.supported) return { sampleRate: rate, numberOfChannels: 2, bitrate: 192000 };
      } catch (_) {}
    }
    return null;
  }

  /** 解码视频文件中的音轨为 AudioBuffer；失败返回 null */
  async _decodeAudioFile(file) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      const arr = await file.arrayBuffer();
      const ctx = new Ctx();
      try {
        return await ctx.decodeAudioData(arr);
      } finally {
        try { await ctx.close(); } catch (_) {}
      }
    } catch (e) { console.log('[字符画] 无音轨或音轨解码失败，将导出为无声视频'); return null; }
  }

  /** 把任意采样率的 AudioBuffer 重采样到目标采样率 / 声道数（AAC 需要固定参数） */
  async _resampleAudio(srcBuffer, targetRate, targetChannels) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) return srcBuffer;
    const frames = Math.max(1, Math.ceil(srcBuffer.duration * targetRate));
    const ctx = new Ctx(targetChannels, frames, targetRate);
    const src = ctx.createBufferSource();
    src.buffer = srcBuffer;
    src.connect(ctx.destination);
    src.start();
    return await ctx.startRendering();
  }

  /** 把 AudioBuffer 逐帧（1024/帧）喂给 AudioEncoder，封装为 AAC（f32-planar） */
  _encodeAudioFrames(encoder, buffer, sampleRate, channels) {
    const frameSize = 1024;
    const total = buffer.length;
    const ch = [];
    for (let c = 0; c < channels; c++) ch.push(buffer.getChannelData(c));
    let offset = 0;
    while (offset < total) {
      const len = Math.min(frameSize, total - offset);
      const data = new Float32Array(channels * len);
      for (let c = 0; c < channels; c++) data.set(ch[c].subarray(offset, offset + len), c * len);
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: len,
        numberOfChannels: channels,
        timestamp: Math.round((offset / sampleRate) * 1e6),
        data,
      });
      encoder.encode(audioData);
      audioData.close();
      offset += len;
    }
  }

  /**
   * 实测源视频帧率：短播一小段，用「实际呈现的视频帧数」÷ mediaTime 增量算出真实帧率。
   * 输出沿用该帧率即可做到「1 源帧 : 1 输出帧」，无需补帧/丢帧，画面才连贯。
   * 探测失败（浏览器无 rVFC / 取不到 mediaTime）返回 null，由调用方退回 30fps。
   *
   * 关键坑：部分浏览器按「显示器刷新率」触发 rVFC（如 60Hz 屏上 30fps 视频会回 60 次/秒，
   * 但 mediaTime 仍按 30fps 前进）。若简单数回调次数会误判成 60fps → 时长/帧格错乱。
   * 所以只统计 mediaTime 真正前进的次数（或用 metadata.presentedFrames 差值，最准）。
   */
  _probeSourceFps(probeMs = 700) {
    const v = this.video;
    if (!v || typeof v.requestVideoFrameCallback !== 'function') return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false, handle = 0;
      let startMt = null, startNow = 0, startPf = null, count = 0, lastMt = null;
      const done = (val) => {
        if (settled) return;
        settled = true;
        try { if (handle && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(handle); } catch (_) {}
        resolve(val);
      };
      const onFrame = (now, md) => {
        if (settled) return;
        const mt = (md && typeof md.mediaTime === 'number') ? md.mediaTime : (v.currentTime || 0);
        const pf = (md && typeof md.presentedFrames === 'number') ? md.presentedFrames : null;
        if (startMt === null) {                       // 首个回调只记基准，不计帧
          startMt = mt; startNow = now; startPf = pf; lastMt = mt;
          handle = v.requestVideoFrameCallback(onFrame);
          return;
        }
        // 只在「真正呈现了新一帧」时计数：优先用 presentedFrames（最准），否则看 mediaTime 是否前进
        if (pf !== null && startPf !== null) count = pf - startPf;
        else if (Math.abs(mt - lastMt) > 1e-4) { count++; lastMt = mt; }
        const dMt = mt - startMt;
        if (dMt <= 0) {                               // 播放回绕（短片 loop）→ 重置基准重测
          startMt = mt; startNow = now; startPf = pf; lastMt = mt; count = 0;
          handle = v.requestVideoFrameCallback(onFrame);
          return;
        }
        // 用墙上时间决定探测窗口，用 mediaTime 增量算帧率（mediaTime 才是内容速率）
        if ((now - startNow) >= probeMs && dMt > 0.15 && count > 0) { done(this._snapFps(count / dMt)); return; }
        handle = v.requestVideoFrameCallback(onFrame);
      };
      v.loop = false;                                 // 探测期间不要回绕
      handle = v.requestVideoFrameCallback(onFrame);
      v.play().catch(() => {});
      setTimeout(() => done(null), probeMs + 2500);   // 兜底：取不到就退回默认
    });
  }

  /** 把测得帧率吸附到常见帧率（测量有抖动，吸附后更稳、也更利于补帧对齐） */
  _snapFps(raw) {
    if (!isFinite(raw) || raw <= 0) return null;
    const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
    for (const c of common) if (Math.abs(raw - c) < 1.0) return c;
    const f = Math.round(raw * 10) / 10;
    return Math.min(60, Math.max(10, f));
  }

  /** 把音频精确裁到指定时长：多则截断、少则以静音补齐，确保音视频长度一致 */
  _fitAudioToDuration(buffer, duration) {
    const target = Math.max(1, Math.round(duration * buffer.sampleRate));
    if (buffer.length === target) return buffer;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const tmp = new Ctx();
    const out = tmp.createBuffer(buffer.numberOfChannels, target, buffer.sampleRate);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const src = buffer.getChannelData(c);
      const dst = out.getChannelData(c);
      const n = Math.min(src.length, target);
      dst.set(src.subarray(0, n));   // 前部拷贝，剩余保持静音补齐
    }
    try { tmp.close(); } catch (_) {}
    return out;
  }

  /**
   * 视频导出（离线逐帧合成，不走实时录制）：
   * 逐帧把字符画渲染到离屏画布 → 编码成 VideoFrame → 直接用 mp4-muxer 封装成 MP4(H.264)。
   * 码率 / 分辨率全可控，画质远高于 MediaRecorder 默认；速度也快于实时。
   * 尽量保留原音轨：用 AudioEncoder(AAC) 解码原文件音轨并一并封装进 MP4。
   * 浏览器不支持 WebCodecs 时回退为 _recordVideo() 实时录制。
   */
  async _synthesizeVideo() {
    if (!this.video) { this._toast('请先上传视频'); return; }
    // 上一次导出仍在进行中 → 直接忽略重复点击并给出提示。
    // 没有这个「早退」就会有两次并发合成抢同一个 video 元素，产出两份文件（且其中一份时长不对）。
    if (this._recording) { this._toast('正在导出中，请稍候…'); return; }
    if (!this._canSynthesize()) { this._recordVideo(); return; }

    // ★ 一进来就加锁：下面「等元数据 / 探测帧率 / 重试 codec」最长可达数秒。
    //   若像以前那样等到编码前才加锁，用户在此期间再次点击会启动【第二次并发合成】——
    //   两个合成共用同一个 video 元素与画布，互相抢 currentTime / playbackRate，
    //   于是产出「一个时长不够 + 一个正确」的两份文件。加锁后重复点击直接被忽略，
    //   且用 try/finally 包住全程，保证任何异常都能解锁，不会把导出卡死。
    this._recording = true;
    this._abortSynthesis = false;
    document.getElementById('ca-download').textContent = '合成中…';
    this._showProgress(0);   // 显示进度浮层（带进度条），由 _setProgress 驱动，导出结束/失败再隐藏
    // 记录导出前的视频状态，导出结束后还原（否则预览会被留在「播完暂停 + playbackRate=0.6」的冻结态）
    const vPrev = this.video ? {
      loop: this.video.loop,
      muted: this.video.muted,
      playbackRate: this.video.playbackRate,
      playing: this.playing,
    } : null;
    try {
    // 等元数据就绪：videoWidth/duration 偶在首帧未齐（尤其是刚上传就点下载），
    // 先等到位再算尺寸/时长，避免 outW/outH=0 或 duration 非有限 → 误判「不支持」走录制回退。
    await this._awaitMetadata();

    const sw = this.video.videoWidth, sh = this.video.videoHeight;
    const style = document.getElementById('ca-style').value;
    const density = parseInt(document.getElementById('ca-density').value, 10) || 2;
    const { cols, rows } = this._computeGrid(sw, sh, style, density);
    const CELL_PX = 32;
    let outW = cols * CELL_PX;
    let outH = Math.round(rows * CELL_PX / (CELL_ASPECT[style] || CELL_ASPECT.hanzi));
    // 长边封顶，兼顾画质与 H.264 level 兼容性；可用 ?edge= 覆盖，方便对比不同分辨率下的帧率/耗时。
    // 默认 1280：导出编码快约 4 倍，配合「降速不丢帧」策略，绝大多数视频都能在合理时间内
    // 产出完整、顺滑、时长正确的 MP4，而不再卡死或无限挂起。需要更高清可设 ?edge=1920 等。
    const MAX_EDGE = (() => {
      try { const e = parseInt(new URLSearchParams(location.search).get('edge'), 10); if (e >= 256 && e <= 4096) return e; } catch (_) {}
      return 1280;
    })();
    if (Math.max(outW, outH) > MAX_EDGE) {
      const s = MAX_EDGE / Math.max(outW, outH);
      outW = Math.round(outW * s);
      outH = Math.round(outH * s);
    }
    // ★ 输出尺寸必须对齐到 16 的倍数（而非仅仅偶数）。
    //   H.264 以 16×16 宏块为单位编码：若高/宽不是 16 的倍数，最后一个宏块行/列就是不完整的，
    //   部分编码器（尤其软件编码器）会写出被截断的 slice，解码时报
    //   "error while decoding MB x y, bytestream -N"，且错误集中在画面底部宏块行 →
    //   播放器表现为花屏、跳帧、一顿一顿（实测 1920×1086 导出有 47~70 条解码错误）。
    //   但「简单向上取整」会微破宽高比 → 两侧/上下露出背景色黑边（与图片导出同款问题）。
    //   故：先 16 对齐宽，再让高严格按「原图比例」回推并 16 对齐，使最终比例仍≈原图，
    //   _drawGrid 的 contain 拟合不再因此产生黑边；最后若仍超 MAX_EDGE 则等比再压一次。
    outW = Math.round(outW / 16) * 16;
    outH = Math.round((outW * sh / sw) / 16) * 16;
    if (Math.max(outW, outH) > MAX_EDGE) {
      const s = MAX_EDGE / Math.max(outW, outH);
      outW = Math.round(outW * s / 16) * 16;
      outH = Math.round(outH * s / 16) * 16;
    }

    const duration = this.video.duration;
    if (!isFinite(duration) || duration <= 0) { this._hideStatus(); this._toast('无法读取视频时长，改用录制'); this._recordVideo(true); return; }

    // ★ 关键：输出帧率必须对齐源视频帧率。若源是 24/25fps 却按 30fps 输出，
    //   每秒要凭空多出 5~6 帧 → 只能复制上一帧 → 画面一顿一顿（judder）。
    //   用 rVFC 实测源帧率（按 mediaTime 计数），据此定 fps，做到 1 源帧 : 1 输出帧。
    const probedFps = await this._probeSourceFps();
    const fps = probedFps || 30;

    const bitrate = Math.min(20_000_000, Math.max(4_000_000, Math.round(outW * outH * 4)));
    // 首帧 VideoEncoder.isConfigSupported 在部分浏览器偶发不可靠（编解码子系统尚未热好）→
    // 误判为「不支持」而走录制回退，表现为「第一次点下载没反应 / 出图，第二次才正常」。
    // 这里多次退避重试等编解码器热起来再判定；只有全部失败才认定真不支持。
    // 成功时 attempt 0 立即返回、零延迟；仅首帧抖动时才进入重试循环（最多约 2s）。
    let picked = null;
    for (let attempt = 0; attempt < 8 && !picked; attempt++) {
      picked = await this._pickH264(outW, outH, bitrate, fps);
      if (!picked && attempt < 7) await new Promise((r) => setTimeout(r, 250));
    }
    if (!picked) { this._hideStatus(); this._toast('当前浏览器不支持 MP4 合成，改用录制'); this._recordVideo(true); return; }
    const codec = picked.codec;
    // 'avc' = 浏览器直出长度前缀样本 + 现成的 avcC；'annexb' = 需手工转码 + 手工拼 avcC（见 _pickH264 注释）
    const srcFormat = picked.format;

    // 输出时长对齐到 fps 网格：取整到最接近的帧数（round 而非 ceil，偏差 ≤ 半帧），
    // 音轨也裁到同一个 videoLen → 音视频严格等长，且几乎等于原始时长。
    const totalFrames = Math.max(1, Math.round(duration * fps));
    const videoLen = totalFrames / fps;

    // ── 音频：尽量保留原音轨（解码原文件 → 重采样 → AAC 编码 → 一并封装） ──
    let audioBuffer = null, aac = null;
    try {
      // 注意：Chrome 未实现 HTMLMediaElement.audioTracks（为 undefined），
      // 不能用「有音轨才解码」来判定，否则主浏览器会丢掉音轨。
      // 仅当 audioTracks 明确存在且为空（确知无声）时才跳过；其余一律尝试解码。
      const at = this.video.audioTracks;
      const explicitlyNoAudio = (at && at.length === 0);
      if (!explicitlyNoAudio && this._videoFile) {
        aac = await this._pickAAC();
        if (aac) {
          const raw = await this._decodeAudioFile(this._videoFile);
          if (raw) {
            audioBuffer = await this._resampleAudio(raw, aac.sampleRate, aac.numberOfChannels);
            audioBuffer = this._fitAudioToDuration(audioBuffer, videoLen);   // 音轨裁到与视频等长
          }
        }
      }
    } catch (e) { console.warn('[字符画] 音频准备失败，仅合成视频', e); audioBuffer = null; }

    const canvas = document.createElement('canvas');
    canvas.width = outW; canvas.height = outH;
    const ctx = canvas.getContext('2d');
    const ramp = this._getRamp(style);
    const random = this._customActive();

    // ★ 关键：H.264 必须显式声明 avc format（见 _pickH264 的详细注释）。
    //   MP4 容器要求样本数据是「长度前缀」NAL：
    //   · format='avc'    → 浏览器直出长度前缀样本，并在关键帧 meta 里给出现成的 avcC → 原样封装即可。
    //   · format='annexb' → 浏览器给的是起始码流且【不提供】avcC，只能手工转码 + 手工拼 avcC 兜底。
    //   另外：mp4-muxer 在 finalize() 会读 decoderConfig.colorSpace，若为 null 会直接抛错崩溃
    //   （表现就是「点了下载全部失败」），所以 decoderConfig 必须确保拿到。
    let videoDecoderConfig = null;   // 捕获/拼出的 decoderConfig，finalize 前做兜底校验
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          const raw = this._readChunkBytes(chunk);
          if (!raw) return;
          if (!this._firstRaw) this._firstRaw = raw;   // 留作 finalize 前兜底重试

          // avc 格式：样本已是长度前缀 → 原样使用；decoderConfig 直接用浏览器给的（含正确 avcC）。
          const avcBytes = (srcFormat === 'avc') ? raw : this._annexbToAvc(raw);
          if (srcFormat !== 'avc') {
            // 仅 annexb 才需要从码流里抽 SPS/PPS 手工拼 avcC
            if (!videoDecoderConfig) {
              const dc = this._buildAvcDecoderConfig(raw);
              if (dc) videoDecoderConfig = dc;
            }
          }
          // avc 模式下浏览器在【关键帧】的 meta 里给出 description(avcC)；
          // 若个别浏览器仍未给出，再退回「从码流手工拼」兜底。
          if (!videoDecoderConfig && meta && meta.decoderConfig && meta.decoderConfig.description) {
            videoDecoderConfig = meta.decoderConfig;
          }
          if (!videoDecoderConfig) {
            const dc = this._buildAvcDecoderConfig(raw);
            if (dc) videoDecoderConfig = dc;
          }
          // 直接用 addVideoChunkRaw 喂「长度前缀(avc) 字节 + decoderConfig」，
          // 绕开「新建 EncodedVideoChunk / sample.copyTo」在某些浏览器会抛错、导致 decoderConfig
          // 没写进 muxer、最终 finalize 读 colorSpace 崩」的坑；timestamp/duration 给 0 兜底防 undefined 抛错。
          muxer.addVideoChunkRaw(
            avcBytes,
            chunk.type,
            chunk.timestamp ?? 0,
            chunk.duration ?? 0,
            { decoderConfig: videoDecoderConfig || undefined }
          );
        } catch (e) {
          if (!this._dcErrLogged) { this._dcErrLogged = true; console.warn('[字符画][diag] addVideoChunkRaw 异常', e); }
        }
      },
      error: (e) => { console.error('[字符画] 编码错误', e); },
    });
    // 用 _pickH264 选定的格式：优先 'avc'（浏览器直出长度前缀 + 现成 avcC），不可用时才回退 'annexb'。
    encoder.configure({ codec, width: outW, height: outH, bitrate, framerate: fps, avc: { format: srcFormat } });

    // 先把音轨（若有）编码好，成功后才把 audio 写进 muxer 配置，避免声明了音轨却无数据
    let audioReady = false;
    let audioChunks = [];
    if (audioBuffer) {
      try {
        const aEnc = new AudioEncoder({
          output: (chunk, meta) => { audioChunks.push({ chunk, meta }); },
          error: (e) => console.error('[字符画] 音频编码错误', e),
        });
        await aEnc.configure({ codec: 'mp4a.40.2', sampleRate: aac.sampleRate, numberOfChannels: aac.numberOfChannels, bitrate: aac.bitrate });
        this._encodeAudioFrames(aEnc, audioBuffer, aac.sampleRate, aac.numberOfChannels);
        await aEnc.flush();
        audioReady = true;
      } catch (e) {
        console.warn('[字符画] 音频编码失败，仅保留视频', e);
        audioBuffer = null;
      }
    }
    const muxerConfig = {
      target: new ArrayBufferTarget(),
      // frameRate 在 mp4-muxer 里即 timeScale（见 lib 第 1571 行），VFR 必须用高 timeScale
      // 否则每帧时长被量化到 1/fps（~33ms）→ 反而引入顿挫。90000 是 MP4 常用高精度 timeScale。
      video: { codec: 'avc', width: outW, height: outH, frameRate: 90000 },
      fastStart: 'in-memory',
      // 关键：视频源的「首帧 DTS」往往不是 0（rVFC 给出的首帧 mediaTime 可能是 4µs 之类的小偏移），
      // 而 mp4-muxer 默认 firstTimestampBehavior='strict' 会因此直接抛错，导致【首帧（关键帧）被丢弃
      // → decoderConfig 永远写不进 muxer → finalize 读 colorSpace 崩】。
      // 设 'offset'：muxer 会自动把所有时间戳减去首帧时间戳，首帧归零、相对间隔（VFR 真实时序）完全保留。
      firstTimestampBehavior: 'offset',
    };
    if (audioReady) muxerConfig.audio = { codec: 'aac', sampleRate: aac.sampleRate, numberOfChannels: aac.numberOfChannels };
    const muxer = new Muxer(muxerConfig);
    if (audioReady) for (const { chunk, meta } of audioChunks) muxer.addAudioChunk(chunk, meta);

      const total = totalFrames;
      const frameDur = 1_000_000 / fps;        // 微秒
      let pts = 0, frameIndex = 0;
      // 关键帧间隔取整：fps 可能是 29.97/59.94 等非整数，`frameIndex % (fps*2) === 0`
      // 用浮点取模永远不为 0 → 关键帧永不插入、GOP 过长。取整后保证约每 2 秒一个关键帧。
      const keyInt = Math.max(1, Math.round(fps * 2));

      // 优先用 requestVideoFrameCallback：视频正常播放，每呈现一帧即时编码，
      // 完全避免逐帧 seek（之前慢的主因）。速度≈实时（比 seek 方案快数倍）。
      // 取帧策略（实测结论：seek 全面优于 rVFC，故以 seek 为默认）：
      //  · seek（默认）：逐帧精确定位到 i/fps，等 seeked 落定后再画再编码。
      //    与播放速率无关、不可能合帧，时间戳天然等距(CFR) → 数学上必定顺滑。
      //    实测 1080p/5s：150/150 帧、PTS 间隔 stdev=0.00ms、与源 lag=0 相关 r=0.864、耗时 31s。
      //  · rVFC（?rvfc=1）：视频播放中每呈现一帧即编码。但画的是 video 元素「当前显示帧」，
      //    它比 metadata.mediaTime 稳定滞后 1 帧（实测 lag=+1，r=0.605），且主线程一忙就合帧丢帧
      //    （实测 149/150 帧、PTS stdev=1.76ms、t=7.4s 处有一个 67ms 顿点）→ 这正是"卡顿"的根源。
      const optRVFC = (() => {
        try { return new URLSearchParams(location.search).get('rvfc') === '1'; } catch (_) { return false; }
      })();
      const useRVFC = optRVFC && (typeof this.video.requestVideoFrameCallback === 'function');

      if (useRVFC) {
        await new Promise(async (resolve) => {
          let rvfcHandle = 0, done = false;
          let pendingMt = null;          // 当前画布上那帧的 mediaTime（已画未编码）
          let currentMt = 0;             // 最近一次回调的 mediaTime
          let drawMs = 0, drawN = 0;
          let cbMs = 0, cbN = 0;            // 整段回调用时（画 + 编码 + 建帧），仅用于 __DBG 诊断
          // 单帧绘制耗时用「指数滑动平均」跟踪：比「全段累计均值」更能跟上画面复杂度变化，
          // 避免被前面简单/暗场帧拉低均值 → 到复杂帧时仍按低成本设高速率 → 主线程忙不过来被合帧丢帧。
          let emaDraw = 0, lastDrawnMt = null;
          const dbg = (typeof window !== 'undefined' && window.__DBG) ? [] : null;
          const TS = (t) => Math.max(0, Math.round(t * 1e6));
          // 看门狗：正常导出时 onFrame 会频繁触发并不断刷新 lastCb；若 6 秒无任何回调
          // （视频未真正播放 / 某些环境 rVFC 不触发 / 卡死），强制收尾，绝不无限挂起——
          // 否则用户会看到「点了下载却永远没反应」。
          let lastCb = performance.now();
          const wd = setInterval(() => {
            if (done) return;
            if (performance.now() - lastCb > 6000) {
              console.warn('[char-export] rVFC 超时无回调，强制收尾');
              clearInterval(wd);
              finish();
            }
          }, 1000);
          const cleanup = () => {
            try { clearInterval(wd); } catch (_) {}
            try { if (rvfcHandle && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(rvfcHandle); } catch (_) {}
            this.video.removeEventListener('ended', onEnded);
          };
          // 把「画布上那一帧」编码出去，时长 = 与 endMt 的间隔（VFR：真实帧间隔）
          const encodePending = (endMt) => {
            if (pendingMt === null) return;
            const dur = Math.max(1, TS(endMt - pendingMt));
            const frame = new VideoFrame(canvas, { timestamp: TS(pendingMt), duration: dur });
            encoder.encode(frame, { keyFrame: (frameIndex % keyInt) === 0 });
            frame.close();
            pendingMt = null;
            frameIndex++;
          };
          const finish = () => {
            if (done) return; done = true;
            // 末帧：时长精确补到视频结束点（duration），既保证尾帧被收录，
            // 又让总时长严格 = 源时长（避免 Math.max 上溢/下溢导致的长短不一）。
            if (!this._abortSynthesis && pendingMt !== null) encodePending(duration);
            if (dbg) {
              const sum = dbg.reduce((a, b) => a + b.sync, 0);
              console.log(`[char-export] frames=${frameIndex} expected≈${(duration*fps)|0} ` +
                `avgSync=${(sum/dbg.length).toFixed(1)}ms maxSync=${Math.max(...dbg.map(d=>d.sync)).toFixed(1)}ms ` +
                `srcFps=${fps}`);
            }
            cleanup();
            resolve();
          };
          const onEnded = () => { finish(); };
          const onFrame = (now, metadata) => {
            if (done || this._abortSynthesis) { finish(); return; }
            // onFrame 心跳：lastCb 已在下方刷新（喂看门狗），此处不再打点
            const mt = (metadata && typeof metadata.mediaTime === 'number') ? metadata.mediaTime : this.video.currentTime;
            currentMt = mt;
            lastCb = performance.now();        // 喂狗：证明当前还在正常逐帧回调
            const cb0 = performance.now();
            // 1) 把上一帧（此刻仍在画布上）编码，时长 = 与当前帧的真实间隔。
            //    → 严格「一源帧 : 一输出帧」，时间戳=真实 mediaTime，画面既不重复也不丢，最顺滑。
            if (pendingMt !== null && mt - pendingMt > 1e-6) {
              encodePending(mt);
              if (frameIndex % 8 === 0) this._setProgress((frameIndex / total) * 100);
            }
            // （诊断日志已移除；如需帧级诊断，在控制台置 window.__DBG=true 后由下方 dbg 汇总输出）
            // 2) 把当前帧画到画布（同一 mediaTime 的重复回调不重画，避免冗余/重复）
            let lastDraw = 0;
            if (pendingMt === null) {
              const t0 = performance.now();
              try {
                this._drawGrid(ctx, outW, outH, this.video, style, cols, rows, ramp, false, random);
              } catch (e) { if (!this._drawErrLogged) { this._drawErrLogged = true; console.error('[字源] 绘制异常，已跳过该帧', e); } }
              lastDraw = performance.now() - t0; drawMs += lastDraw; drawN++;
              pendingMt = mt;
              // EMA 跟踪单帧真实绘制耗时
              emaDraw = emaDraw === 0 ? lastDraw : emaDraw * 0.6 + lastDraw * 0.4;
              // 合帧检测：本次回调 mediaTime 相对「上一绘制帧」跳过了多帧 → 主线程太忙、被浏览器合帧丢帧了。
              // 必须立刻大幅降速，否则会持续丢帧 → 导出视频一顿一顿。用「实际跳过的真实间隔」反推单帧至少这么久。
              if (lastDrawnMt !== null) {
                const skipped = (mt - lastDrawnMt) * fps;   // 理论应≈1；>1.5 即已丢帧
                if (skipped > 1.5) {
                  const cur = this.video.playbackRate;
                  const r2 = Math.max(0.1, cur * 0.6);       // 立刻砍到 60%
                  if (Math.abs(r2 - cur) > 0.01) this.video.playbackRate = r2;
                  emaDraw = Math.max(emaDraw, (mt - lastDrawnMt) * 1000 * 0.5);
                }
              }
              lastDrawnMt = mt;
            }
            if (dbg) dbg.push({ mt: +mt.toFixed(4), sync: +(performance.now() - cb0).toFixed(2), draw: +lastDraw.toFixed(2) });
            cbMs += performance.now() - cb0; cbN++;
            // 3) 自适应降速（关键：必须留足余量，否则 rVFC 会合帧丢帧）。
            //    rVFC 的真相：浏览器只在「有视频帧被呈现」时触发回调；若上一帧的绘制
            //    还没结束、下一帧就被呈现了，中间这些帧会被【合并】成一次回调 → 丢帧 → 卡顿。
            //    所以必须让「单帧绘制耗时」严格小于「按当前 playbackRate 算出的真实帧间隔」。
            //    用 EMA 跟踪单帧绘制耗时（跟得上复杂度变化），目标占用率按输出分辨率自适应：
            //    1080p 编码/回读成本更高，需更保守（约 0.12 才零丢帧）；720p 用 0.25 即可
            //    （fillText 路径已验证 ~320/360 帧）。占用率越低越顺滑、导出越慢。
            const target = (outH >= 1080) ? 0.12 : 0.25;
            const intervalNeeded = emaDraw / target;              // 需要的真实帧间隔(ms)
            const wantRate = (1000 / fps) / Math.max(1, intervalNeeded);
            const rate = Math.min(1, Math.max(0.1, wantRate));
            if (Math.abs(rate - this.video.playbackRate) > 0.01) this.video.playbackRate = rate;
            if (currentMt >= duration - 1e-3) finish();
            else if (!done) rvfcHandle = this.video.requestVideoFrameCallback(onFrame);
          };
          this.video.loop = false;
          this.video.playbackRate = (outH >= 1080) ? 0.12 : 0.25;   // 起步即按分辨率降速，避免前几帧合帧丢帧
          this.video.addEventListener('ended', onEnded);
          // 关键：必须等 seek 真正落到 0（seeked 事件）后再 play + 注册 rVFC。
          // 否则首个 rVFC 回调会命中「seek 前的旧帧」（预览已自动播放过，currentTime 可能 ~3-4s），
          // 首帧时间戳偏移数秒 → firstTimestampBehavior:'offset' 把整段时间轴左移 →
          // 导出视频被截短数秒（源前几秒丢失、总时长变短）。_seekTo 已内置 1.2s 超时兜底。
          await this._seekTo(this.video, 0);
          this.video.play().catch(() => {});
          rvfcHandle = this.video.requestVideoFrameCallback(onFrame);
        });
      } else {
        // 回退：无 rVFC 的浏览器仍逐帧 seek（较慢）
        this.video.loop = false;
        this.video.pause();
        await this._seekTo(this.video, 0);
        while (frameIndex < total) {
          if (this._abortSynthesis) break;
          this._drawGrid(ctx, outW, outH, this.video, style, cols, rows, ramp, false, random);
          const frame = new VideoFrame(canvas, { timestamp: pts, duration: frameDur });
          encoder.encode(frame, { keyFrame: frameIndex % keyInt === 0 });
          frame.close();
          pts += frameDur;
          frameIndex++;
          if (frameIndex % 8 === 0) this._setProgress((frameIndex / total) * 100);
          const next = frameIndex / fps;
          if (next < duration) {
            await this._seekTo(this.video, Math.min(next, duration - 1e-3));
          } else {
            break;
          }
        }
      }

      // 兜底：仅对「逐帧 seek 回退路径（CFR）」做尾部补齐，保证总帧数 = total、时长 = total/fps。
      // VFR 路径用真实 mediaTime 时间戳，帧数自然对齐，不再补帧（否则会把末尾冻结成静止画面）。
      if (!this._abortSynthesis && !useRVFC && frameIndex < total) {
        while (frameIndex < total) {
          const frame = new VideoFrame(canvas, { timestamp: pts, duration: frameDur });
          encoder.encode(frame, { keyFrame: frameIndex % keyInt === 0 });
          frame.close();
          pts += frameDur; frameIndex++;
        }
      }

      if (this._abortSynthesis) {
        try { encoder.reset(); } catch (_) {}
    } else {
      await encoder.flush();
      // 兜底校验：若编码器始终没给出 decoderConfig（理论上加了 avc format 后不会），
      // 强行 finalize 会崩在 mp4-muxer 读 colorSpace；这里主动抛错 → catch 转 MediaRecorder 录制，
      // 至少能稳定产出一份可播放视频，而不是「点了下载什么都没发生」。
      if (!videoDecoderConfig) {
        // 兜底重试：用首帧原始字节再尝试拼一次 avcC（应对「首输出帧是 delta / 解析偶发失败」等边界）。
        if (this._firstRaw) {
          const dc = this._buildAvcDecoderConfig(this._firstRaw);
          if (dc) videoDecoderConfig = dc;
        }
        if (!videoDecoderConfig) {
          console.log(`[字符画][diag] finalize 兜底失败：已加入视频样本数=${this._dcN || 0}，首帧 raw 长度=${this._firstRaw ? this._firstRaw.length : 0}`);
          throw new Error('编码器未输出 H.264 配置(decoderConfig)，无法封装 MP4');
        }
      }
      muxer.finalize();
        const { buffer } = muxer.target;
        const blob = new Blob([buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `字源字符画_${Date.now()}.mp4`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        this._hideStatus();   // 进度浮层收起，避免「合成中 X%」残留
        this._toast(audioReady ? '视频已合成（MP4 · 含原音轨）✔' : '视频已合成（MP4）✔');
      }
    } catch (e) {
      console.error('[字符画] 合成失败', e);
      if (!this._abortSynthesis) {
        const msg = (e && e.message) ? e.message : String(e);
        // 把真实错误显示出来，避免「点了没反应」却不知道原因
        this._hideStatus();
        this._toast('合成出错（已转录制）：' + msg.slice(0, 48));
        this._recordVideo(true);
      }
    } finally {
      // 若导出已交给 _recordVideo 接管（异步录制进行中），锁要留到录制的 onstop 再释放，
      // 这里提前解锁会让用户在录制期间点击 → 再起一次导出 → 重复下载多个文件。
      if (!this._recorder) this._recording = false;
      this._abortSynthesis = false;
      document.getElementById('ca-download').textContent = '下载视频';
      // 还原导出前的视频状态，避免预览画面被留在「播完暂停 + 变速」的冻结卡死态。
      // 录制回退路径会自己管理 video，故 _recorder 存在时不碰。
      if (this.video && !this._recorder) {
        this.video.loop = vPrev ? vPrev.loop : true;
        this.video.muted = vPrev ? vPrev.muted : true;
        this.video.playbackRate = vPrev ? vPrev.playbackRate : 1;
        if (vPrev && vPrev.playing) {
          try { this.video.currentTime = 0; } catch (_) {}
          this.video.play().catch(() => {});   // 恢复预览循环播放
        }
      }
    }
  }

  /**
   * 从首帧编码数据里解析 SPS/PPS 并拼出 mp4-muxer 需要的 decoderConfig（avcC）。
   * 当浏览器 encoder 不在输出 meta 里提供 decoderConfig 时作为兜底，确保 finalize 不崩。
   * 返回 { description: Uint8Array(avcC), colorSpace: undefined } 或 null。
   */
  /**
   * 从编码器输出的关键帧「字节」里解析 SPS/PPS 并拼出 mp4-muxer 需要的 decoderConfig（avcC）。
   * 配合 annexb 编码：SPS/PPS 内嵌在关键帧码流中，与浏览器是否提供 meta.decoderConfig 无关。
   * 返回 { description: Uint8Array(avcC), colorSpace: undefined } 或 null。
   */
  _buildAvcDecoderConfig(raw) {
    try {
      if (!raw || raw.length === 0) return null;
      const nals = this._extractNals(raw);
      const sps = nals.find((n) => (n[0] & 0x1f) === 7);
      const pps = nals.find((n) => (n[0] & 0x1f) === 8);
      if (!sps || sps.length < 4 || !pps || pps.length < 2) return null;
      // 构造 AVCDecoderConfigurationRecord（avcC）：6 固定字节 + SPS(2长度+SPS) + PPS(1数量+2长度+PPS)
      const avcc = new Uint8Array(11 + sps.length + pps.length);
      let o = 0;
      avcc[o++] = 1;                       // configurationVersion
      avcc[o++] = sps[1];                  // AVCProfileIndication
      avcc[o++] = sps[2];                  // profile_compatibility
      avcc[o++] = sps[3];                  // AVCLevelIndication
      avcc[o++] = 0xFF;                    // 6bit reserved + lengthSizeMinusOne(3)
      avcc[o++] = 0xE0 | 1;               // 3bit reserved + numOfSequenceParameterSets(1)
      avcc[o++] = (sps.length >> 8) & 0xFF;
      avcc[o++] = sps.length & 0xFF;
      avcc.set(sps, o); o += sps.length;
      avcc[o++] = 1;                       // numOfPictureParameterSets
      avcc[o++] = (pps.length >> 8) & 0xFF;
      avcc[o++] = pps.length & 0xFF;
      avcc.set(pps, o); o += pps.length;
      return { description: avcc, colorSpace: undefined };
    } catch (e) { return null; }
  }

  /** 从 EncodedVideoChunk 取出编码字节（兼容各浏览器实现）。 */
  _readChunkBytes(chunk) {
    try {
      if (chunk && typeof chunk.copyTo === 'function') {
        const ab = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(ab);
        return new Uint8Array(ab);
      }
      if (chunk && chunk.data) {
        return (chunk.data instanceof Uint8Array) ? chunk.data
             : (chunk.data instanceof ArrayBuffer) ? new Uint8Array(chunk.data)
             : new Uint8Array(chunk.data);
      }
    } catch (_) {}
    return null;
  }

  /**
   * annexb(起始码) 码流转 MP4 要求的「长度前缀(avc)」格式；若已是长度前缀则原样返回。
   * 起始码判定：前导 00 00 01 或 00 00 00 01（H.264 防竞争字节保证码流内不会出现伪起始码）。
   */
  _annexbToAvc(raw) {
    if (!(raw[0] === 0 && raw[1] === 0 && (raw[2] === 1 || (raw[2] === 0 && raw[3] === 1)))) {
      return raw;
    }
    const out = [];
    let i = 0;
    while (i < raw.length) {
      let sc = 0;
      if (raw[i] === 0 && raw[i + 1] === 0 && raw[i + 2] === 1) sc = 3;
      else if (i + 3 < raw.length && raw[i] === 0 && raw[i + 1] === 0 && raw[i + 2] === 0 && raw[i + 3] === 1) sc = 4;
      if (!sc) { i++; continue; }
      i += sc;
      const start = i;
      let j = i;
      while (j + 3 <= raw.length) {
        if (raw[j] === 0 && raw[j + 1] === 0 && raw[j + 2] === 1) break;
        if (j + 3 < raw.length && raw[j] === 0 && raw[j + 1] === 0 && raw[j + 2] === 0 && raw[j + 3] === 1) break;
        j++;
      }
      let end = j;
      while (end > start && raw[end - 1] === 0) end--;
      if (end > start) {
        const nalu = raw.subarray(start, end);
        const len = nalu.length;
        out.push((len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF);
        for (let k = 0; k < nalu.length; k++) out.push(nalu[k]);
      }
      i = j;
    }
    return new Uint8Array(out);
  }

  /**
   * 从编码器输出的关键帧字节里抽取 NAL 单元。
   * 关键：先判断是否 annexb（码流头含起始码 00 00 01 / 00 00 00 01），
   * 是则按起始码切分；否则才按 avc 的 4 字节长度前缀解析。
   * （旧实现「先按长度前缀解析」会把 annexb 起始码 00 00 00 01 误读成长度=1，
   *   切出 1 字节的伪 SPS → _buildAvcDecoderConfig 因 sps 过短返回 null → 最终 finalize 读 colorSpace 崩。）
   */
  _extractNals(buf) {
    return this._hasAnnexbStartCode(buf)
      ? this._nalsFromAnnexb(buf)
      : this._nalsFromLengthPrefix(buf);
  }

  /** 码流头若干字节内是否含 H.264 起始码（防竞争字节保证码流内不会出现伪起始码）。 */
  _hasAnnexbStartCode(buf) {
    const n = Math.min(buf.length, 64);
    for (let i = 0; i + 3 <= n; i++) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) return true;
      if (i + 4 <= n && buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) return true;
    }
    return false;
  }

  _nalsFromAnnexb(buf) {
    const out = [];
    let j = 0;
    while (j < buf.length) {
      let sc = 0;
      if (buf[j] === 0 && buf[j + 1] === 0 && buf[j + 2] === 1) sc = 3;
      else if (j + 3 < buf.length && buf[j] === 0 && buf[j + 1] === 0 && buf[j + 2] === 0 && buf[j + 3] === 1) sc = 4;
      if (!sc) { j++; continue; }
      j += sc;
      const start = j;
      let k = j;
      while (k + 3 <= buf.length) {
        if (buf[k] === 0 && buf[k + 1] === 0 && buf[k + 2] === 1) break;
        if (k + 3 < buf.length && buf[k] === 0 && buf[k + 1] === 0 && buf[k + 2] === 0 && buf[k + 3] === 1) break;
        k++;
      }
      let end = k;
      while (end > start && buf[end - 1] === 0) end--;
      if (end > start) out.push(buf.subarray(start, end));
      j = k;
    }
    return out;
  }

  _nalsFromLengthPrefix(buf) {
    const out = [];
    let i = 0;
    while (i + 4 <= buf.length) {
      const len = (buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3];
      i += 4;
      if (len <= 0 || i + len > buf.length) break;
      out.push(buf.subarray(i, i + len));
      i += len;
    }
    return out;
  }

  /**
   * 视频导出：把字符画画布实时录制成 webm（MediaRecorder + captureStream）。
   * 录制的是「高清离屏画布」（每字约 CELL_PX 像素，与屏幕分辨率解耦），
   * 因此导出的视频同样清晰。浏览器不支持录制时回退为导出当前帧 PNG。
   * 此为 WebCodecs 不可用时的回退路径。
   */
  _recordVideo(fromSynth = false) {
    if (!this.video) { this._toast('请先上传视频'); return; }
    // fromSynth=true 表示由 _synthesizeVideo 交接过来（锁由它持有、它随后 return），
    // 此处必须允许接管；若照旧因 _recording 已为 true 就直接 return，录制回退将永远不生效。
    if (this._recording && !fromSynth) return;
    const canRecord = (typeof MediaRecorder !== 'undefined') && HTMLCanvasElement.prototype.captureStream;
    if (!canRecord) {
      if (fromSynth) { this._cleanupRecording(); this._toast('浏览器不支持视频合成/录制'); return; }
      this._toast('浏览器不支持视频录制，已导出当前帧');
      this._exportImage(this.video, document.getElementById('ca-style').value);
      return;
    }

    // 准备高清离屏画布（与 _exportImage 同一套网格/像素尺度）
    const sw = this.video.videoWidth, sh = this.video.videoHeight;
    const style = document.getElementById('ca-style').value;
    const density = parseInt(document.getElementById('ca-density').value, 10) || 2;
    const { cols, rows } = this._computeGrid(sw, sh, style, density);
    const CELL_PX = 40;
    let recW = cols * CELL_PX;
    let recH = Math.round(rows * CELL_PX / (CELL_ASPECT[style] || CELL_ASPECT.hanzi));
    // 关键：VP8 编码器分辨率上限为 4096×4096，竖屏/方形高密度视频极易超限，
    // 超限会令编码静默失败 → 产出无法播放的损坏文件。故视频导出上限压到 4096。
    const MAXV = 4096;
    if (recW > MAXV || recH > MAXV) {
      const s = MAXV / Math.max(recW, recH);
      recW = Math.round(recW * s);
      recH = Math.round(recH * s);
    }
    this.recW = recW; this.recH = recH;
    this.recCanvas = document.createElement('canvas');
    this.recCanvas.width = recW; this.recCanvas.height = recH;
    this.recCtx = this.recCanvas.getContext('2d');
    // 先画一帧（至少保证有内容、不空录）
    const ramp = this._getRamp(style);
    try { this._drawGrid(this.recCtx, recW, recH, this.video, style, cols, rows, ramp, false); } catch (_) {}

    // 优先 MP4(H.264，哪都能播)，否则 webm（vp9/vp8）；按实际 mime 决定后缀
    const sup = (t) => (MediaRecorder.isTypeSupported ? MediaRecorder.isTypeSupported(t) : false);
    const types = ['video/mp4;codecs=h264', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = types.find((t) => sup(t)) || 'video/webm';
    const ext = mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm';

    // 合成流：画布出字符画画面 + 原视频的音轨（尽量保留原声）
    const stream = this.recCanvas.captureStream(30);
    let hadAudio = false;
    const prevMuted = this.video.muted;
    try {
      const vs = this.video.captureStream
        ? this.video.captureStream()
        : (this.video.mozCaptureStream ? this.video.mozCaptureStream() : null);
      if (vs) {
        const at = vs.getAudioTracks();
        if (at.length) { at.forEach((t) => stream.addTrack(t)); hadAudio = true; }
      }
    } catch (_) {}
    if (hadAudio) this.video.muted = false;   // 取消静音，captureStream 才能录到原音

    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16_000_000 });
    } catch (e) {
      this.video.muted = prevMuted;
      this._cleanupRecording();
      if (fromSynth) { this._toast('视频录制不可用，请重试'); return; }
      this._toast('视频录制不可用，已导出当前帧');
      this._exportImage(this.video, document.getElementById('ca-style').value);
      return;                       // ← 必须返回：否则下面会拿 undefined 的 recorder 继续跑并抛错
    }
    if (!recorder) return;
    this._recorder = recorder;

    const chunks = [];
    this._recording = true;
    this._discardRecording = false;
    document.getElementById('ca-download').textContent = '录制中…';

    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.onstop = () => {
      document.getElementById('ca-download').textContent = '下载视频';
      if (this.video) this.video.muted = prevMuted;   // 还原静音状态（video 可能已被置空，需判空）
      const discard = this._discardRecording;
      this._cleanupRecording();
      if (discard) return;                       // 中途关闭 → 丢弃
      if (chunks.length) {
        const blob = new Blob(chunks, { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `字源字符画_${Date.now()}.${ext}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        this._toast(hadAudio ? `视频已导出（.${ext} · 含原音轨）✔` : `视频已导出（.${ext}）✔`);
      } else {
        if (fromSynth) { this._toast('录制为空，请重试'); return; }
        this._toast('录制为空，已导出当前帧');
        const fb = this.video || this.lastImage;
        if (fb) this._exportImage(fb, document.getElementById('ca-style').value);
      }
    };

    const onEnded = () => {
      this.playing = false;
      if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
      try { recorder.stop(); } catch (_) {}
      if (this.video) { this.video.loop = true; this.video.muted = prevMuted; }   // 还原静音状态
    };
    this.video.loop = false;
    this.video.addEventListener('ended', onEnded, { once: true });

    this.video.currentTime = 0;
    this.video.play().then(() => {
      this.playing = true;
      this._renderVideoFrame();
    }).catch(() => {});
    recorder.start(100);            // timeslice：每 100ms 落一块，避免单块封装写坏
    this._toast('正在录制视频…');
  }

  /** 清理高清录制画布与状态（不触发下载） */
  _cleanupRecording() {
    this.recCanvas = null;
    this.recCtx = null;
    this.recW = 0;
    this.recH = 0;
    this._recorder = null;
    this._recording = false;
  }

  _stopVideo() {
    // 合成/录制中关闭 → 放弃，避免意外下载
    if (this._recording) this._abortSynthesis = true;
    if (this._recorder) {
      this._discardRecording = true;
      try { this._recorder.stop(); } catch (_) {}
    }
    this._cleanupRecording();
    if (this.video) {
      this.video.pause();
      if (this.video.src && URL.revokeObjectURL) URL.revokeObjectURL(this.video.src);
      this.video = null;
    }
    this.playing = false;
    this.lastImage = null;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    const ctr = document.getElementById('ca-video-controls');
    if (ctr) ctr.hidden = true;
  }

  // ───────────────────────── 显示 / 尺寸 ─────────────────────────

  show() {
    document.getElementById('tool-character-art').classList.remove('hidden');
    this._resize();
    if (this.lastImage) this._renderImage(this.lastImage);
    else if (this.video) this._renderVideoFrame();
  }

  _hide() {
    document.getElementById('tool-character-art').classList.add('hidden');
    this._stopVideo();
  }

  _resize() {
    const wrap = document.querySelector('.tool-canvas-wrap');
    if (!wrap) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(320, wrap.clientWidth - 24);
    const cssH = Math.max(240, wrap.clientHeight - 24);

    this.dpr = dpr;
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;

    // 尺寸变化后重画当前素材（保持比例重新拟合）
    if (this.lastImage) this._renderImage(this.lastImage);
    else if (this.video) this._renderVideoFrame();
    else {
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.fillStyle = '#0f0b08';
      this.ctx.fillRect(0, 0, cssW, cssH);
    }
  }
}
