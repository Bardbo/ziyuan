# -*- coding: utf-8 -*-
"""ziyuan 项目推送前安全扫描"""
import os

# 敏感关键词（普通字符串）
keywords = [
    'Administrator', 'C:/Users', 'C:\\Users', 'D:/Documents', 'D:\\Documents',
    'AppData', 'workbuddy', '.hermes', 'obsidian', '大刘', '小王', 'Key3',
    'password', 'api_key', 'apiKey', 'api-key', 'secret', 'sk-', 'bearer',
    'token=', 'AKIA', 'ghp_',
]

files = []
for root, dirs, fs in os.walk('.'):
    dirs[:] = [d for d in dirs if d not in ('node_modules', 'dist', '.git', '__pycache__')]
    for f in fs:
        if f.endswith(('.py', '.js', '.mjs', '.json', '.md', '.html', '.bat', '.css')):
            if 'chunks' in root or 'fonts' in root or f == 'scan_security.py':
                continue
            files.append(os.path.join(root, f))

print(f'扫描 {len(files)} 个文件...')
issues = []
for p in files:
    try:
        content = open(p, encoding='utf-8', errors='ignore').read()
    except Exception:
        continue
    low = content.lower()
    for kw in keywords:
        idx = low.find(kw.lower())
        if idx >= 0:
            line_no = content[:idx].count('\n') + 1
            line = content.split('\n')[line_no - 1].strip()[:80]
            issues.append(f'{p}:{line_no}: [{kw}] {line}')

if issues:
    print(f'⚠️ 发现 {len(issues)} 处：')
    for i in issues[:20]:
        print('  ', i)
else:
    print('✅ 全部干净，无任何敏感信息')