#!/usr/bin/env python3
"""Preprocess chars.json into a lightweight index for the web app."""
import json
import os
import math
import argparse

parser = argparse.ArgumentParser(description="Preprocess chars.json into web data")
parser.add_argument("src", nargs="?", default="chars.json", help="path to chars.json")
parser.add_argument("--dst", default="public/data", help="output directory (default: public/data)")
args = parser.parse_args()

SRC = args.src
DST = args.dst

os.makedirs(DST, exist_ok=True)

print("Loading chars.json...")
with open(SRC, "r", encoding="utf-8") as f:
    chars = json.load(f)

print(f"Total characters: {len(chars)}")

# --- 1. Lightweight index (char, unicode, radical, strokes, pinyin) ---
# Compact format: list of [char, unicode, radical, strokes, pinyin]
index = []
for c in chars:
    index.append([
        c["char"],
        c["unicode"],
        c["radical"],
        c["strokes"],
        c["pinyin"]
    ])

index_path = os.path.join(DST, "index.json")
with open(index_path, "w", encoding="utf-8") as f:
    json.dump(index, f, ensure_ascii=False)
print(f"Index written: {index_path} ({len(index)} entries)")

# --- 2. Full data chunks (for on-demand loading) ---
# Each chunk: 2000 chars, ~1MB each
CHUNK_SIZE = 2000
num_chunks = math.ceil(len(chars) / CHUNK_SIZE)

chunks_dir = os.path.join(DST, "chunks")
os.makedirs(chunks_dir, exist_ok=True)

chunk_manifest = []
for i in range(num_chunks):
    start = i * CHUNK_SIZE
    end = min(start + CHUNK_SIZE, len(chars))
    chunk = chars[start:end]
    chunk_file = f"chunk_{i:04d}.json"
    chunk_path = os.path.join(chunks_dir, chunk_file)
    with open(chunk_path, "w", encoding="utf-8") as f:
        json.dump(chunk, f, ensure_ascii=False)
    chunk_manifest.append({
        "file": chunk_file,
        "start": start,
        "end": end,
        "count": end - start
    })
    if (i + 1) % 50 == 0:
        print(f"  Chunks: {i + 1}/{num_chunks}")

# Write manifest
manifest_path = os.path.join(DST, "manifest.json")
with open(manifest_path, "w", encoding="utf-8") as f:
    json.dump({
        "total": len(chars),
        "chunkSize": CHUNK_SIZE,
        "numChunks": num_chunks,
        "chunks": chunk_manifest
    }, f, ensure_ascii=False, indent=2)
print(f"Manifest written: {manifest_path}")

# --- 3. Stats for the UI ---
radicals = {}
total_strokes = 0
for c in chars:
    r = c["radical"]
    radicals[r] = radicals.get(r, 0) + 1
    try:
        total_strokes += int(c["strokes"])
    except (ValueError, TypeError):
        total_strokes += 0

# Top radicals
top_radicals = sorted(radicals.items(), key=lambda x: -x[1])[:50]

stats = {
    "totalChars": len(chars),
    "uniqueRadicals": len(radicals),
    "avgStrokes": round(total_strokes / len(chars), 1),
    "topRadicals": [{"radical": r, "count": c} for r, c in top_radicals]
}
stats_path = os.path.join(DST, "stats.json")
with open(stats_path, "w", encoding="utf-8") as f:
    json.dump(stats, f, ensure_ascii=False, indent=2)
print(f"Stats written: {stats_path}")

# --- 4. File sizes ---
for fname in ["index.json", "manifest.json", "stats.json"]:
    fpath = os.path.join(DST, fname)
    size_mb = os.path.getsize(fpath) / 1024 / 1024
    print(f"  {fname}: {size_mb:.2f} MB")

total_chunks_mb = sum(
    os.path.getsize(os.path.join(chunks_dir, c["file"]))
    for c in chunk_manifest
) / 1024 / 1024
print(f"  chunks/ total: {total_chunks_mb:.2f} MB ({num_chunks} files)")

print("\nDone!")