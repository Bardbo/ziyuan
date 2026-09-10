/**
 * GlyphCache — pre-renders each hanzi to an offscreen canvas once,
 * then scenes blit via drawImage (fast, crisp, no WebGL needed).
 */
export class GlyphCache {
  constructor(fontFamily = '"Alibaba PuHuiTi","SimSun",serif') {
    this.fontFamily = fontFamily;
    this.cache = new Map();
  }

  /**
   * Get (or create) a cached sprite for a character.
   * @param {string} char single hanzi
   * @param {number} size texture resolution in px (>= max display size)
   * @param {object} opts { color, glow } — tweak style
   */
  get(char, size = 128, opts = {}) {
    const color = opts.color || '#efe7da';
    const glowColor = opts.glow || 'rgba(230,220,200,0.35)';
    const glowBlur = opts.glowBlur != null ? opts.glowBlur : 12;
    const key = `${char}|${size}|${color}|${glowColor}|${glowBlur}`;
    let entry = this.cache.get(key);
    if (entry) return entry;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = glowBlur;
    ctx.fillStyle = color;
    ctx.font = `${Math.floor(size * 0.82)}px ${this.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(char, size / 2, size / 2 + size * 0.02);

    entry = { canvas, size };
    this.cache.set(key, entry);
    return entry;
  }
}

// Singleton shared across all scenes
export const glyphCache = new GlyphCache();