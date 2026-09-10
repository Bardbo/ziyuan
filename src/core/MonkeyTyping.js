/**
 * 猴子打字 — Monkey Typing
 * 乱按键盘，随机打出汉字，如无限猴子敲出莎士比亚。
 * 宣纸质感，打字机风格，每次按键随机生成 1–3 个汉字。
 */
import { glyphCache } from './GlyphCache.js';

const LINE_HEIGHT = 32;
const CHAR_W = 24;
const MAX_LINES = 28;       // visible lines on the "paper"

// 莎士比亚名句中译 — 猴子打字机的默认"作品"
const SHAKESPEARE_QUOTES = [
  '生存还是毁灭，这是一个值得考虑的问题',
  '闪光的东西并不都是金子',
  '真爱之路从来不平坦',
  '名字有什么关系，把玫瑰花叫做别的名称，它还是照样芳香',
  '爱所有人，信任少许人，不负任何人',
  '宁愿做聪明的愚人，不愿做愚蠢的聪明人',
  '愚者自以为聪明，智者却有自知之明',
  '不要惧怕伟大',
  '有的人天生伟大，有的人成就伟大，有的人被赐予伟大',
  '音乐是爱情的食粮，请继续演奏吧',
  '懦夫在死之前已经死过多次，勇士只尝过一次死亡的滋味',
  '慈悲不是出于勉强',
];

export class MonkeyTyping {
  constructor(dataLoader) {
    this.dataLoader = dataLoader;
    this.lines = [...SHAKESPEARE_QUOTES];  // default: Shakespeare quotes
    this.currentLine = SHAKESPEARE_QUOTES.length - 1;
    this.typed = false;    // hasn't typed yet — quotes are "written by the monkey"
    this.history = [];     // array of snapshots for ← → browsing
    this.historyIdx = -1;
    this.typing = [];         // {char, x, y, alpha, size} for animation
    this.enterProgress = 1;
    this.onCharClick = null;
    this._saveSnapshot();
  }

  _saveSnapshot() {
    // Save current lines as a snapshot for history browsing
    this.history.push(this.lines.map(l => l));
    this.historyIdx = this.history.length - 1;
    // Keep history manageable
    if (this.history.length > 100) this.history.shift();
  }

  _restoreSnapshot(idx) {
    this.lines = this.history[idx].map(l => l);
    this.currentLine = this.lines.length - 1;
  }

  /** User pressed a key — type random chars */
  typeChars(count) {
    // First keypress: start a fresh line after the Shakespeare quotes
    if (!this.typed) {
      this.typed = true;
      this.currentLine++;
      this.lines.push('');
    }
    const chars = this.dataLoader.getRandomChars(count);
    for (const entry of chars) {
      const char = entry[0];
      const line = this.lines[this.currentLine];
      // Check if line is full (approx 60 chars per line for 1400px paper)
      if (line.length > 55) {
        this.currentLine++;
        this.lines.push('');
        // Limit total lines
        if (this.lines.length > MAX_LINES + 5) {
          this.lines.shift();
          this.currentLine = this.lines.length - 1;
        }
      }
      this.lines[this.currentLine] += char;
    }
    this._saveSnapshot();
  }

  /** R — clear all text */
  rerandom() {
    this.lines = [''];
    this.currentLine = 0;
    this.typed = true;
    this._saveSnapshot();
  }

  enter() { this.enterProgress = 0; }

  update(dt, time) {
    if (this.enterProgress < 1) {
      this.enterProgress = Math.min(1, this.enterProgress + 0.02);
    }
  }

  draw(ctx, w, h, time) {
    const cx = w / 2;
    const cy = h / 2;
    const e = this.enterProgress;
    const ease = 1 - Math.pow(1 - e, 3);

    // === Text area: floating, no paper background (keeps HUD visible) ===
    // Limit so text stays above the bottom HUD (dots at ~80% height)
    const maxH = h * 0.72;
    const textTop = h * 0.08;
    const lineW = Math.min(w * 0.8, 880);

    // Faint vertical line grid (optional, very subtle)
    ctx.strokeStyle = 'rgba(200, 180, 150, 0.05)';
    ctx.lineWidth = 0.5;
    const leftX = cx - lineW / 2;
    for (let x = leftX; x < leftX + lineW; x += CHAR_W * 2) {
      ctx.beginPath();
      ctx.moveTo(x, textTop);
      ctx.lineTo(x, textTop + maxH);
      ctx.stroke();
    }

    // === Draw text lines ===
    const linesPerView = Math.floor(maxH / LINE_HEIGHT);
    const startLine = Math.max(0, this.lines.length - linesPerView + 1);

    ctx.save();
    ctx.beginPath();
    ctx.rect(leftX - 10, textTop - 5, lineW + 20, maxH + 10);
    ctx.clip();

    for (let i = startLine; i < this.lines.length; i++) {
      const line = this.lines[i];
      const lineY = textTop + (i - startLine) * LINE_HEIGHT;
      const lineAlpha = ease < 1 && i === this.lines.length - 1
        ? Math.min(1, ease * 3)
        : 1;

      ctx.globalAlpha = 0.78 * lineAlpha;
      ctx.fillStyle = '#d8ccb0';
      ctx.font = '18px "Alibaba PuHuiTi","KaiTi","SimSun",serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';

      for (let ci = 0; ci < line.length; ci++) {
        const charAlpha = lineAlpha * (0.7 + 0.3 * Math.sin(time * 0.002 + ci * 0.5));
        ctx.globalAlpha = 0.75 * charAlpha;
        ctx.fillText(line[ci], leftX + 10 + ci * CHAR_W, lineY);
      }
    }

    // Cursor blink
    if (this.lines.length > 0 && this.lines[this.currentLine]) {
      const lastLine = this.lines[this.currentLine];
      const cursorX = leftX + 10 + lastLine.length * CHAR_W;
      const cursorY = textTop + (this.currentLine - startLine) * LINE_HEIGHT;
      const blink = 0.5 + 0.5 * Math.sin(time * 0.004);
      ctx.globalAlpha = 0.5 * blink;
      ctx.fillStyle = '#c8503a';
      ctx.fillRect(cursorX, cursorY + 2, 2, LINE_HEIGHT - 6);
    }

    ctx.restore();
    ctx.globalAlpha = 1;

    // === Top corner hint (small, unobtrusive) ===
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#9a8c74';
    ctx.font = '12px "KaiTi","STKaiti",serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('乱按键盘 · 猴子打字', w - 30, 20);
    ctx.globalAlpha = 1;
  }

  handleClick(x, y) {
    // x,y center-relative → locate the clicked character precisely
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cx = w / 2;
    const maxH = h * 0.72;
    const textTop = h * 0.08;
    const lineW = Math.min(w * 0.8, 880);
    const leftX = cx - lineW / 2;

    const sx = x + cx;        // absolute screen X
    const clickY = y + h / 2; // absolute screen Y

    const linesPerView = Math.floor(maxH / LINE_HEIGHT);
    const startLine = Math.max(0, this.lines.length - linesPerView + 1);

    // Find the row (0..linesPerView) clicked
    const row = Math.floor((clickY - textTop) / LINE_HEIGHT);
    if (row < 0 || row >= linesPerView) return false;
    const lineIdx = startLine + row;
    if (lineIdx < 0 || lineIdx >= this.lines.length) return false;
    const line = this.lines[lineIdx];
    if (!line || line.length === 0) return false;

    // Find the column (character index)
    const col = Math.floor((sx - (leftX + 10)) / CHAR_W);
    if (col < 0 || col >= line.length) return false;
    const char = line[col];

    const entry = this.dataLoader.getIndexEntry(char);
    if (entry && this.onCharClick) {
      this.onCharClick(entry);
      return true;
    }
    return false;
  }

  setMouse() {}
  dispose() {}
}