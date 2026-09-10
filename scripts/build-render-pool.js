/**
 * 生成 renderPool.json：只保留当前字体真正能渲染的汉字（基本区+扩展A+兼容+部首），
 * 并在每条记录追加其在完整 index 中的位置 fullIdx，方便直接定位 chunk。
 * 这样首屏只需加载 ~28k 条而不是 10.3 万条，体积从 53MB 降到约 14MB。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DATA_DIR = resolve('public/data');
const index = JSON.parse(readFileSync(resolve(DATA_DIR, 'index.json'), 'utf8'));

function isRenderable(entry) {
  const u = entry[1]; // e.g. "U+4E00"
  const cp = parseInt(u.replace(/^U\+/i, ''), 16);
  if (isNaN(cp)) return true;
  return (
    (cp >= 0x3400 && cp <= 0x4DBF) ||   // Ext A
    (cp >= 0x4E00 && cp <= 0x9FFF) ||   // Basic
    (cp >= 0xF900 && cp <= 0xFAFF) ||   // Compatibility
    (cp >= 0x2E80 && cp <= 0x2EFF)      // Radicals
  );
}

const renderPool = [];
for (let i = 0; i < index.length; i++) {
  const entry = index[i];
  if (isRenderable(entry)) {
    // [char, unicode, radical, strokes, pinyin, fullIdx]
    renderPool.push([...entry, i]);
  }
}

writeFileSync(resolve(DATA_DIR, 'renderPool.json'), JSON.stringify(renderPool));
console.log(`renderPool: ${renderPool.length}/${index.length} entries`);
