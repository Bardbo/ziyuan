/**
 * DetailPanel - shows character etymology when a character is clicked
 */
export class DetailPanel {
  constructor() {
    this.panel = document.getElementById('detail-panel');
    this.isOpen = false;
    this.currentChar = null;

    // Bind elements
    this.elements = {
      char: document.getElementById('panel-char'),
      pinyin: document.getElementById('panel-pinyin'),
      unicode: document.getElementById('panel-unicode'),
      radical: document.getElementById('panel-radical'),
      strokes: document.getElementById('panel-strokes'),
      etymologyType: document.getElementById('panel-etymology-type'),
      origin: document.getElementById('panel-origin'),
      glyphEvolution: document.getElementById('panel-glyph-evolution'),
      meaningEvolution: document.getElementById('panel-meaning-evolution'),
      notes: document.getElementById('panel-notes'),
    };

    // Close button
    document.getElementById('panel-close').addEventListener('click', () => this.close());
  }

  async show(entry, dataLoader) {
    // 防连点串字：每次 show 自增 token，await 后若已被新请求取代则丢弃结果
    const token = (this._showToken = (this._showToken || 0) + 1);
    this.currentChar = entry[0];
    this.isOpen = true;

    // Show basic info from index
    this.elements.char.textContent = entry[0];
    this.elements.pinyin.textContent = `/ ${entry[4]} /`;
    this.elements.unicode.textContent = entry[1];
    this.elements.radical.textContent = entry[2];
    this.elements.strokes.textContent = entry[3];

    // Load full data
    let fullData = await dataLoader.getCharData(entry[0]);
    if (this._showToken !== token) return; // 已被更新的点击取代，丢弃过期结果

    // 完整索引可能仍在后台加载：等其就绪后重试一次，消除时序竞态导致的「未找到」
    if (!fullData && typeof dataLoader.whenFullIndex === 'function') {
      await dataLoader.whenFullIndex();
      if (this._showToken !== token) return;
      fullData = await dataLoader.getCharData(entry[0]);
      if (this._showToken !== token) return;
    }

    if (fullData) {
      this.elements.etymologyType.textContent = fullData.etymology_type || '—';
      this.elements.origin.textContent = fullData.origin || '待考';
      this.elements.glyphEvolution.textContent = fullData.glyph_evolution || '—';
      this.elements.meaningEvolution.textContent = fullData.meaning_evolution || '—';
      this.elements.notes.textContent = fullData.notes || '—';
    } else {
      this.elements.etymologyType.textContent = '—';
      this.elements.origin.textContent = '未找到字源数据';
      this.elements.glyphEvolution.textContent = '—';
      this.elements.meaningEvolution.textContent = '—';
      this.elements.notes.textContent = '—';
    }

    // Show panel
    requestAnimationFrame(() => {
      if (this._showToken !== token) return; // 期间又点了别的字，不弹出过期面板
      this.panel.classList.remove('hidden');
      this.panel.classList.add('visible');
    });
  }

  close() {
    this.isOpen = false;
    this.panel.classList.remove('visible');
    this.panel.classList.add('hidden');
    if (this.onClose) this.onClose();
  }
}