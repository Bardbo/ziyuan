/**
 * DataLoader - handles loading character data, caching in IndexedDB
 */
const DB_NAME = 'HanziRainDB';
const DB_VERSION = 1;
const STORE_NAME = 'charData';

export class DataLoader {
  constructor() {
    this.index = null;
    this.fullIndex = null;
    this.fullIndexReady = false;
    this._fullIndexPromise = null;
    this.manifest = null;
    this.stats = null;
    this.db = null;
    this.ready = false;
  }

  async init(onProgress) {
    // 首屏只加载 renderPool（约 1.1MB / 2.8 万条可渲染汉字），完整 index（5.3MB / 10.3 万条）后台懒加载
    const [renderPool, manifest, stats] = await Promise.all([
      this._loadJSON('/data/renderPool.json'),
      this._loadJSON('/data/manifest.json'),
      this._loadJSON('/data/stats.json'),
    ]);

    this.index = renderPool;     // 初始索引就是可渲染池；fullIndex 加载后替换为完整索引
    this.renderablePool = renderPool;
    this.manifest = manifest;
    this.stats = stats;

    if (onProgress) onProgress(40);

    // Open IndexedDB（仅用于缓存 chunk，不预加载）
    this.db = await this._openDB();
    if (onProgress) onProgress(70);

    // 后台静默加载完整索引，使搜索/溯源可覆盖全部汉字
    this._fullIndexPromise = this._loadFullIndexInBackground();

    this.ready = true;
    if (onProgress) onProgress(100);
  }

  async _loadFullIndexInBackground() {
    try {
      const full = await this._loadJSON('/data/index.json');
      this.fullIndex = full;
      // 完整索引加载后替换 this.index，使 getIndexEntry/getCharData 能覆盖所有汉字
      this.index = full;
      this.fullIndexReady = true;
    } catch (e) {
      console.warn('[hanzi] full index background load failed', e);
    }
  }

  /** 等待后台完整索引加载完成（已加载则立即 resolved） */
  whenFullIndex() {
    return this._fullIndexPromise || Promise.resolve();
  }

  /** Get a character's full data by its char value */
  async getCharData(char) {
    const idx = this._binarySearch(char);
    if (idx < 0) return null;

    // renderPool 条目末尾带有 fullIdx；完整索引则直接用当前位置
    const entry = this.index[idx];
    const fullIdx = entry.length > 5 ? entry[5] : idx;

    const chunkIdx = Math.floor(fullIdx / this.manifest.chunkSize);
    const chunk = await this._ensureChunk(chunkIdx);
    const offset = fullIdx - chunkIdx * this.manifest.chunkSize;
    return chunk[offset] || null;
  }

  /** Get the lightweight entry for a character */
  getIndexEntry(char) {
    const idx = this._binarySearch(char);
    if (idx < 0) return null;
    return this.index[idx];
  }

  /** Get a random set of characters for the rain (renderable subset) */
  getRandomChars(count) {
    const result = [];
    const pool = this.renderablePool.length > 0 ? this.renderablePool : this.index;
    const len = pool.length;
    for (let i = 0; i < count; i++) {
      result.push(pool[Math.floor(Math.random() * len)]);
    }
    return result;
  }

  /** Get total character count */
  getTotalChars() {
    return this.stats ? this.stats.totalChars : (this.index ? this.index.length : 0);
  }

  // --- Renderable pool: chars that our webfont + system fonts can draw ---
  _buildRenderablePool() {
    if (!this.index) return;
    this.renderablePool = this.index.filter((entry) => {
      const u = entry[1]; // e.g. 'U+4E00'
      const cp = parseInt(u.replace(/^U\+/i, ''), 16);
      if (isNaN(cp)) return true;
      // Basic block + Ext A + compatibility ideographs + radical supplement
      // Alibaba PuHuiTi 实测 cmap 仅覆盖这些区(共约 27,544 汉字)
      // 扩展B/C/D/E(U+20000+)字体仅有数十个字形 → 必须排除以避免豆腐块
      return (
        (cp >= 0x3400 && cp <= 0x4DBF) ||   // Ext A: 6,582 glyphs in font
        (cp >= 0x4E00 && cp <= 0x9FFF) ||   // Basic: 20,976 glyphs in font
        (cp >= 0xF900 && cp <= 0xFAFF) ||   // Compatibility: 12 glyphs in font
        (cp >= 0x2E80 && cp <= 0x2EFF)      // Radicals: 14 glyphs in font
      );
    });
    console.log(`[hanzi] renderable pool: ${this.renderablePool.length}/${this.index.length}`);
  }

  // --- Private helpers ---

  _binarySearch(char) {
    const arr = this.index;
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = arr[mid][0];
      if (c === char) return mid;
      if (c < char) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  async _ensureChunk(chunkIdx) {
    const tx = this.db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const key = `chunk_${String(chunkIdx).padStart(4, '0')}`;
    let data = await this._request(store.get(key));

    if (!data) {
      // Load from file
      const chunkFile = this.manifest.chunks[chunkIdx].file;
      data = await this._loadJSON(`/data/chunks/${chunkFile}`);

      // Cache in IndexedDB
      const writeTx = this.db.transaction(STORE_NAME, 'readwrite');
      const writeStore = writeTx.objectStore(STORE_NAME);
      await this._request(writeStore.put(data, key));
    }

    return data;
  }

  async _loadJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load ${url}`);
    return resp.json();
  }

  async _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async _request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}

// Singleton
export const dataLoader = new DataLoader();