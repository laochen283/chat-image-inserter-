// index.js —— SillyTavern 文字插图扩展 v2.4.0
// 新增：图片压缩档位（上传自动压缩）+ 一键压缩现有图片
// 基于 v2.3.1（含点击切换闪烁修复）
// 路径：public/scripts/extensions/third-party/chat-image-inserter/index.js

import { extension_settings } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../../script.js';

const EXT_NAME = 'chat-image-inserter';
const COLLAPSED_KEY = 'cii-collapsed-rules';
const COLLAPSED_GROUPS_KEY = 'cii-collapsed-groups';

const defaultSettings = {
    enabled: true,
    maxWidth: 300,
    recentMessages: 0,
    themeMode: 'auto',
    compressLevel: 0, // 0=原图 1=轻度 2=中度 3=强力 4=极限
    groups: [],
    rules: [],
};

const COMPRESS_PRESETS = [
    { name: '原图', maxSide: 0, quality: 1, desc: '不压缩' },
    { name: '轻度压缩', maxSide: 1600, quality: 0.9, desc: '最大边 1600px · 质量 90%' },
    { name: '中度压缩', maxSide: 1200, quality: 0.85, desc: '最大边 1200px · 质量 85%' },
    { name: '强力压缩', maxSide: 900, quality: 0.8, desc: '最大边 900px · 质量 80%' },
    { name: '极限压缩', maxSide: 600, quality: 0.7, desc: '最大边 600px · 质量 70%' },
];

const DB_NAME = 'cii-images-db';
const DB_VERSION = 3;
const STORE = 'images';

let processedHashes = new WeakMap();
let observer = null;
let debounceTimer = null;
let dbPromise = null;
let processing = false;
let pendingProcess = false;
let switchLock = false;
let compressing = false;
const urlCache = new Map();

/* ================= 提示 / 工具 ================= */

function notify(msg, type = 'info') {
    console.log(`[CII][${type}]`, msg);
    const t = window.toastr;
    if (t && typeof t[type] === 'function') {
        try { t[type](msg); return; } catch { /* fallthrough */ }
    }
    if (type === 'error' || type === 'warning') {
        window.alert('[文字插图] ' + msg);
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function uid(prefix) {
    return prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

/* ================= 图片压缩 ================= */

async function loadImageSource(blob) {
    if (typeof createImageBitmap === 'function') {
        try {
            const bmp = await createImageBitmap(blob);
            return {
                source: bmp,
                width: bmp.width,
                height: bmp.height,
                close: () => { try { bmp.close?.(); } catch { /* ignore */ } },
            };
        } catch { /* fallthrough */ }
    }
    return await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            resolve({
                source: img,
                width: img.naturalWidth,
                height: img.naturalHeight,
                close: () => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } },
            });
        };
        img.onerror = () => {
            try { URL.revokeObjectURL(url); } catch { /* ignore */ }
            reject(new Error('图片加载失败'));
        };
        img.src = url;
    });
}

async function compressImageBlob(blob, level) {
    if (!blob || level <= 0) return blob;
    const preset = COMPRESS_PRESETS[level];
    if (!preset || !preset.maxSide) return blob;

    const type = (blob.type || '').toLowerCase();
    // GIF / SVG 跳过压缩，避免动图丢帧或矢量失真
    if (type.includes('gif') || type.includes('svg')) return blob;

    let loaded;
    try {
        loaded = await loadImageSource(blob);
    } catch (e) {
        console.warn('[CII] 图片解码失败，跳过压缩', e);
        return blob;
    }

    try {
        const { source, width, height } = loaded;
        if (!width || !height) return blob;

        const scale = Math.min(1, preset.maxSide / Math.max(width, height));
        const newW = Math.max(1, Math.round(width * scale));
        const newH = Math.max(1, Math.round(height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = newW;
        canvas.height = newH;
        const ctx = canvas.getContext('2d');
        if (!ctx) return blob;

        // 白色背景填充，避免 PNG 透明通道转 JPEG 时变黑
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, newW, newH);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, 0, 0, newW, newH);

        const outBlob = await new Promise(resolve => {
            canvas.toBlob(
                b => resolve(b),
                'image/jpeg',
                preset.quality,
            );
        });

        // 压缩后如果没变小，保留原图
        if (outBlob && outBlob.size < blob.size) return outBlob;
        return blob;
    } catch (e) {
        console.warn('[CII] 压缩异常，保留原图', e);
        return blob;
    } finally {
        loaded.close?.();
    }
}

/* ================= 折叠状态 ================= */

function loadSet(key) {
    try {
        const arr = JSON.parse(localStorage.getItem(key) || '[]');
        return new Set(Array.isArray(arr) ? arr : []);
    } catch { return new Set(); }
}
function saveSet(key, set) {
    try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* ignore */ }
}

function isRuleCollapsed(id) { return loadSet(COLLAPSED_KEY).has(id); }
function setRuleCollapsed(id, collapsed) {
    const set = loadSet(COLLAPSED_KEY);
    if (collapsed) set.add(id); else set.delete(id);
    saveSet(COLLAPSED_KEY, set);
}

function isGroupCollapsed(id) {
    if (!id) return false;
    return loadSet(COLLAPSED_GROUPS_KEY).has(id);
}
function setGroupCollapsed(id, collapsed) {
    if (!id) return;
    const set = loadSet(COLLAPSED_GROUPS_KEY);
    if (collapsed) set.add(id); else set.delete(id);
    saveSet(COLLAPSED_GROUPS_KEY, set);
}

function isRuleComplete(rule) {
    return !!(rule.pattern && Array.isArray(rule.images) && rule.images.length > 0);
}

function initCollapseForRules() {
    if (localStorage.getItem(COLLAPSED_KEY) !== null) return;
    const s = getSettings();
    const set = new Set();
    for (const rule of s.rules) if (isRuleComplete(rule)) set.add(rule.id);
    saveSet(COLLAPSED_KEY, set);
}

/* ================= IndexedDB ================= */

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
            if (db.objectStoreNames.contains('meta')) {
                try { db.deleteObjectStore('meta'); } catch { /* ignore */ }
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

async function putImage(id, blob, meta = {}) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ blob, meta }, id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function getImage(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function deleteImage(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function clearAllImagesFromDb() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function getStorageStats() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).openCursor();
        let count = 0, bytes = 0;
        req.onsuccess = e => {
            const cursor = e.target.result;
            if (cursor) {
                count++;
                const blob = cursor.value?.blob;
                if (blob && typeof blob.size === 'number') bytes += blob.size;
                cursor.continue();
            } else resolve({ count, bytes });
        };
        req.onerror = () => reject(req.error);
    });
}

/* ================= URL 缓存 ================= */

function releaseImageUrl(key) {
    if (!key) return;
    const url = urlCache.get(key);
    if (url) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
        urlCache.delete(key);
    }
}

async function ensureUrlFromIndexedDB(imageId) {
    if (!imageId) return null;
    if (urlCache.has(imageId)) return urlCache.get(imageId);
    const rec = await getImage(imageId);
    if (!rec || !rec.blob) return null;
    const url = URL.createObjectURL(rec.blob);
    urlCache.set(imageId, url);
    return url;
}

/* ================= 设置 ================= */

function migrateSettings(s) {
    if ('storageMode' in s) delete s.storageMode;
    if ('saveDirName' in s) delete s.saveDirName;
    if ('outputMode' in s) delete s.outputMode;
    if ('imgCollapsible' in s) delete s.imgCollapsible;

    if (typeof s.recentMessages !== 'number') s.recentMessages = 0;
    if (!['auto', 'dark', 'light'].includes(s.themeMode)) s.themeMode = 'auto';
    if (typeof s.compressLevel !== 'number' || s.compressLevel < 0 || s.compressLevel > 4) {
        s.compressLevel = 0;
    }
    if (!Array.isArray(s.groups)) s.groups = [];
    s.groups = s.groups.filter(g => g && typeof g.id === 'string');
    for (const g of s.groups) {
        if (typeof g.name !== 'string' || !g.name) g.name = '未命名分组';
    }
    const validIds = new Set(s.groups.map(g => g.id));
    for (const rule of s.rules) {
        if ('imageFile' in rule) delete rule.imageFile;
        if (!Array.isArray(rule.images)) {
            rule.images = [];
            if (rule.imageId) {
                rule.images.push({
                    imageId: rule.imageId,
                    imageType: rule.imageType || '',
                });
            }
        } else {
            rule.images = rule.images.filter(img =>
                img && typeof img.imageId === 'string'
            );
        }
        delete rule.imageId;
        delete rule.imageType;
        if (typeof rule.maxMatches !== 'number') rule.maxMatches = 1;
        if (typeof rule.removeMatched !== 'boolean') rule.removeMatched = false;
        if (!rule.imagePosition) rule.imagePosition = 'after';
        if (typeof rule.enabled !== 'boolean') rule.enabled = true;
        if (typeof rule.groupId !== 'string' || (rule.groupId && !validIds.has(rule.groupId))) {
            rule.groupId = '';
        }
    }
}

function getSettings() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = structuredClone(defaultSettings);
    }
    const s = extension_settings[EXT_NAME];
    if (!Array.isArray(s.rules)) s.rules = [];
    if (typeof s.maxWidth !== 'number') s.maxWidth = defaultSettings.maxWidth;
    if (typeof s.enabled !== 'boolean') s.enabled = defaultSettings.enabled;
    migrateSettings(s);
    return s;
}

function saveSettings() { saveSettingsDebounced(); }
function resetProcessing() { processedHashes = new WeakMap(); }

function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return h;
}

function getRuleMaxMatches(rule) {
    const v = Number(rule.maxMatches);
    if (!Number.isFinite(v) || v < 0) return 1;
    return Math.floor(v);
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function guessExt(type) {
    if (!type) return 'png';
    const t = type.toLowerCase();
    if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
    if (t.includes('png')) return 'png';
    if (t.includes('gif')) return 'gif';
    if (t.includes('webp')) return 'webp';
    if (t.includes('svg')) return 'svg';
    if (t.includes('bmp')) return 'bmp';
    return 'png';
}

/* ================= 规则图片可用性 ================= */

function getImageUrlOfItem(img) {
    if (!img) return null;
    if (img.imageSrc) return img.imageSrc;
    return img.imageId ? (urlCache.get(img.imageId) || null) : null;
}

function getUsableImages(rule) {
    if (!Array.isArray(rule.images)) return [];
    return rule.images.filter(img => !!getImageUrlOfItem(img));
}

function ruleHasImageReady(rule) {
    return getUsableImages(rule).length > 0;
}

async function ensureAllUrls() {
    const s = getSettings();
    for (const rule of s.rules) {
        if (!Array.isArray(rule.images)) continue;
        for (const img of rule.images) {
            if (img.imageId && !urlCache.has(img.imageId)) {
                await ensureUrlFromIndexedDB(img.imageId);
            }
        }
    }
}

/* ================= 匹配 ================= */

function findMatches(text, rule) {
    const ranges = [];
    const pattern = rule.pattern;
    if (!pattern) return ranges;
    if (rule.isRegex) {
        try {
            const re = new RegExp(pattern, 'gi');
            let m;
            while ((m = re.exec(text)) !== null) {
                if (m[0].length === 0) { re.lastIndex++; continue; }
                ranges.push({ start: m.index, end: m.index + m[0].length });
            }
        } catch { /* 正则非法时忽略 */ }
    } else {
        let idx = text.indexOf(pattern);
        while (idx !== -1) {
            ranges.push({ start: idx, end: idx + pattern.length });
            idx = text.indexOf(pattern, idx + pattern.length);
        }
    }
    return ranges;
}

/* ================= 图片元素（多图可切换 —— 修复版） ================= */

function createImageElement(rule) {
    const s = getSettings();
    const usable = getUsableImages(rule);
    if (!usable.length) return null;

    const wrap = document.createElement('div');
    wrap.className = 'cii-img-block';
    if (usable.length > 1) wrap.classList.add('cii-multi');

    const img = document.createElement('img');
    img.className = 'cii-inserted-image';
    img.src = getImageUrlOfItem(usable[0]);
    img.alt = '';
    img.loading = 'lazy';
    img.style.maxWidth = '100%';

    let currentIndex = 0;

    if (usable.length > 1) {
        const indicator = document.createElement('span');
        indicator.className = 'cii-img-indicator';
        indicator.setAttribute('data-text', `1/${usable.length}`);
        indicator.title = '点击图片切换到下一张';

        img.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            switchLock = true;
            currentIndex = (currentIndex + 1) % usable.length;
            const url = getImageUrlOfItem(usable[currentIndex]);
            if (url) img.src = url;
            indicator.setAttribute('data-text', `${currentIndex + 1}/${usable.length}`);
            img.classList.add('cii-switching');
            setTimeout(() => {
                img.classList.remove('cii-switching');
                switchLock = false;
                if (pendingProcess) {
                    pendingProcess = false;
                    scheduleProcess();
                }
            }, 220);
        });

        wrap.appendChild(indicator);
    }

    wrap.appendChild(img);
    return wrap;
}

/* ================= 应用规则到容器 ================= */

function applyRulesToElement(container) {
    const s = getSettings();
    container.querySelectorAll('.cii-img-block').forEach(el => el.remove());
    container.normalize();

    const rules = s.rules.filter(r => r.enabled !== false && r.pattern && ruleHasImageReady(r));
    if (!rules.length) return;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest('script, style')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    const allMatches = [];
    for (const rule of rules) {
        const ruleMatches = [];
        textNodes.forEach((node, idx) => {
            for (const r of findMatches(node.nodeValue, rule)) {
                ruleMatches.push({ node, nodeIdx: idx, start: r.start, end: r.end, rule });
            }
        });
        ruleMatches.sort((a, b) => a.nodeIdx - b.nodeIdx || a.start - b.start);
        const max = getRuleMaxMatches(rule);
        allMatches.push(...(max > 0 ? ruleMatches.slice(0, max) : ruleMatches));
    }
    if (!allMatches.length) return;

    const byNode = new Map();
    for (const m of allMatches) {
        if (!byNode.has(m.node)) byNode.set(m.node, []);
        byNode.get(m.node).push(m);
    }

    const startImages = [], endImages = [];

    for (const [node, list] of byNode) {
        list.sort((a, b) => b.start - a.start);
        const filtered = [];
        let lastStart = Infinity;
        for (const m of list) {
            if (m.end <= lastStart) { filtered.push(m); lastStart = m.start; }
        }

        const parent = node.parentNode;
        if (!parent) continue;
        let current = node;

        for (const m of filtered) {
            const pos = m.rule.imagePosition || 'after';
            if (pos === 'start' || pos === 'end') {
                if (m.rule.removeMatched) {
                    try {
                        if (m.end > current.nodeValue.length) continue;
                        current.nodeValue =
                            current.nodeValue.slice(0, m.start) +
                            current.nodeValue.slice(m.end);
                    } catch (e) { console.warn('[CII] 删除文字失败', e); }
                }
                if (pos === 'start') startImages.push({ rule: m.rule });
                else endImages.push({ rule: m.rule });
                continue;
            }
            try {
                if (m.end > current.nodeValue.length) continue;
                current.splitText(m.end);
                const mid = current.splitText(m.start);
                const block = createImageElement(m.rule);
                if (!block) continue;
                parent.insertBefore(block, mid.nextSibling);
                if (m.rule.removeMatched) mid.remove();
            } catch (e) { console.warn('[CII] 插入图片失败', e); }
        }
    }

    if (startImages.length) {
        const frag = document.createDocumentFragment();
        for (const { rule } of startImages) {
            const block = createImageElement(rule);
            if (block) frag.appendChild(block);
        }
        container.insertBefore(frag, container.firstChild);
    }
    for (const { rule } of endImages) {
        const block = createImageElement(rule);
        if (block) container.appendChild(block);
    }
}

async function processAllMessages() {
    if (switchLock || compressing) { pendingProcess = true; return; }
    if (processing) { pendingProcess = true; return; }
    processing = true;
    try {
        const s = getSettings();
        if (!s.enabled) {
            document.querySelectorAll('#chat .mes_text .cii-img-block').forEach(el => el.remove());
            return;
        }
        await ensureAllUrls();

        const recentN = Math.max(0, Math.floor(Number(s.recentMessages) || 0));
        const allMes = Array.from(document.querySelectorAll('#chat .mes'));
        const total = allMes.length;
        const startIdx = (recentN > 0 && total > recentN) ? (total - recentN) : 0;

        if (recentN > 0) {
            for (let i = 0; i < startIdx; i++) {
                allMes[i].querySelectorAll('.mes_text').forEach(el => {
                    const blocks = el.querySelectorAll('.cii-img-block');
                    if (blocks.length) {
                        blocks.forEach(b => {
                            const parent = b.parentNode;
                            b.remove();
                            parent?.normalize?.();
                        });
                    }
                    processedHashes.delete(el);
                });
            }
        }
        for (let i = startIdx; i < total; i++) {
            allMes[i].querySelectorAll('.mes_text').forEach(el => {
                const text = el.textContent || '';
                const hash = simpleHash(text);
                if (processedHashes.get(el) === hash) return;
                processedHashes.set(el, hash);
                applyRulesToElement(el);
            });
        }
    } finally {
        processing = false;
        if (pendingProcess) { pendingProcess = false; processAllMessages(); }
    }
}

function scheduleProcess() {
    if (switchLock || compressing) { pendingProcess = true; return; }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => processAllMessages(), 120);
}

/* ================= 监听 ================= */

function startObserver() {
    if (observer) return;
    const chat = document.getElementById('chat');
    if (!chat) { setTimeout(startObserver, 1000); return; }
    observer = new MutationObserver(() => {
        if (getSettings().enabled) scheduleProcess();
    });
    observer.observe(chat, { childList: true, subtree: true, characterData: true });
}

function registerEvents() {
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, scheduleProcess);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, scheduleProcess);
    eventSource.on(event_types.MESSAGE_EDITED, scheduleProcess);
    eventSource.on(event_types.MESSAGE_SWIPED, scheduleProcess);
    eventSource.on(event_types.MESSAGE_UPDATED, scheduleProcess);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        resetProcessing();
        scheduleProcess();
    });
}

/* ================= 单规则图片操作 ================= */

async function removeOneImage(rule, imageId) {
    if (!Array.isArray(rule.images)) return;
    const idx = rule.images.findIndex(img => img.imageId === imageId);
    if (idx < 0) return;
    const [removed] = rule.images.splice(idx, 1);

    const s = getSettings();
    const stillUsed = s.rules.some(r =>
        r !== rule && Array.isArray(r.images) && r.images.some(img => img.imageId === removed.imageId)
    );
    if (!stillUsed && removed.imageId) {
        try { await deleteImage(removed.imageId); } catch { /* ignore */ }
        releaseImageUrl(removed.imageId);
    }
    saveSettings();
    resetProcessing();
    scheduleProcess();
    await refreshStats();
}

async function removeRuleImageRefs(rule) {
    if (!Array.isArray(rule.images)) { rule.images = []; return; }
    const s = getSettings();
    for (const img of rule.images) {
        if (!img.imageId) continue;
        const stillUsed = s.rules.some(r =>
            r !== rule && Array.isArray(r.images) && r.images.some(i => i.imageId === img.imageId)
        );
        if (!stillUsed) {
            try { await deleteImage(img.imageId); } catch { /* ignore */ }
            releaseImageUrl(img.imageId);
        }
    }
    rule.images = [];
}

async function handleUpload(files, $rule) {
    const ruleId = String($rule.attr('data-id'));
    const s = getSettings();
    const rule = s.rules.find(r => String(r.id) === ruleId);
    if (!rule) throw new Error('规则不存在');
    if (!Array.isArray(rule.images)) rule.images = [];

    const compressLevel = s.compressLevel || 0;
    let totalOld = 0;
    let totalNew = 0;

    for (const file of files) {
        const buffer = await file.arrayBuffer();
        let blob = new Blob([buffer], { type: file.type || 'image/png' });
        totalOld += blob.size;

        if (compressLevel > 0) {
            try {
                const compressed = await compressImageBlob(blob, compressLevel);
                if (compressed && compressed.size > 0) blob = compressed;
            } catch (e) {
                console.warn('[CII] 压缩失败，使用原图', e);
            }
        }
        totalNew += blob.size;

        const imageId = uid('img_');
        await putImage(imageId, blob, { name: file.name, type: blob.type });
        const url = URL.createObjectURL(blob);
        urlCache.set(imageId, url);
        rule.images.push({ imageId, imageType: blob.type });
    }

    saveSettings();
    resetProcessing();
    scheduleProcess();
    await refreshStats();

    if (compressLevel > 0 && totalOld > totalNew) {
        notify(`已添加 ${files.length} 张图片（压缩：${formatBytes(totalOld)} → ${formatBytes(totalNew)}）`, 'success');
    } else if (compressLevel > 0) {
        notify(`已添加 ${files.length} 张图片（原图较小，压缩后未变小，保留原图）`, 'success');
    } else {
        notify(`已添加 ${files.length} 张图片`, 'success');
    }
}

/* ================= 批量压缩现有图片 ================= */

async function recompressAllImages() {
    if (compressing) {
        notify('正在压缩中，请稍候', 'warning');
        return;
    }
    const s = getSettings();
    const level = s.compressLevel || 0;
    const preset = COMPRESS_PRESETS[level];

    if (level <= 0) {
        notify('当前压缩档位为「原图」，请先选择要应用的压缩档位', 'warning');
        return;
    }

    // 收集去重后的图片 id
    const imageIdSet = new Set();
    for (const rule of s.rules) {
        if (!Array.isArray(rule.images)) continue;
        for (const img of rule.images) {
            if (img.imageId) imageIdSet.add(img.imageId);
        }
    }
    const imageIds = [...imageIdSet];

    if (!imageIds.length) {
        notify('当前没有可压缩的图片', 'info');
        return;
    }

    const ok = window.confirm(
        `即将按「${preset.name}」（${preset.desc}）重新压缩 ${imageIds.length} 张图片。\n\n` +
        `• 图片会按档位降低分辨率和画质\n` +
        `• 已压缩的图片不会被保留原图\n` +
        `• 此操作不可撤销\n\n` +
        `继续？`,
    );
    if (!ok) return;

    compressing = true;
    const $btn = $('#cii-recompress-all');
    const $btnText = $btn.find('span');
    const originalText = $btnText.text();
    $btn.prop('disabled', true).addClass('cii-disabled');
    $btnText.text(`压缩中 0/${imageIds.length}`);

    try {
        let totalOld = 0;
        let totalNew = 0;
        let compressed = 0;
        let skipped = 0;

        for (let i = 0; i < imageIds.length; i++) {
            const imageId = imageIds[i];
            try {
                const rec = await getImage(imageId);
                if (!rec || !rec.blob) {
                    skipped++;
                    continue;
                }

                const oldSize = rec.blob.size;
                totalOld += oldSize;

                let newBlob = rec.blob;
                try {
                    const result = await compressImageBlob(rec.blob, level);
                    if (result && result.size < oldSize) {
                        newBlob = result;
                    }
                } catch (e) {
                    console.warn('[CII] 压缩单张失败', imageId, e);
                }

                if (newBlob !== rec.blob) {
                    await putImage(imageId, newBlob, {
                        name: rec.meta?.name || '',
                        type: newBlob.type,
                    });
                    releaseImageUrl(imageId);
                    totalNew += newBlob.size;
                    compressed++;
                } else {
                    totalNew += oldSize;
                    skipped++;
                }
            } catch (e) {
                console.warn('[CII] 压缩处理异常', imageId, e);
                skipped++;
            }

            if (i % 3 === 0 || i === imageIds.length - 1) {
                $btnText.text(`压缩中 ${i + 1}/${imageIds.length}`);
            }
        }

        await ensureAllUrls();
        await refreshStats();
        renderRules();
        resetProcessing();
        pendingProcess = false;
        scheduleProcess();

        const savedPercent = totalOld > 0
            ? Math.round((1 - totalNew / totalOld) * 100)
            : 0;

        notify(
            `压缩完成！已压缩 ${compressed} 张 / 跳过 ${skipped} 张\n` +
            `${formatBytes(totalOld)} → ${formatBytes(totalNew)}` +
            (savedPercent > 0 ? `（节省 ${savedPercent}%）` : ''),
            'success',
        );
    } catch (e) {
        console.error('[CII] 批量压缩失败', e);
        notify('批量压缩失败：' + (e?.message || e), 'error');
    } finally {
        compressing = false;
        $btn.prop('disabled', false).removeClass('cii-disabled');
        $btnText.text(originalText);
    }
}

/* ================= 预览（多图缩略图网格） ================= */

async function refreshPreview($rule, rule) {
    const $grid = $rule.find('.cii-image-grid');
    if (!$grid.length) return;

    $grid.find('.cii-image-item').remove();

    const $addBtn = $grid.find('.cii-image-add');
    const images = Array.isArray(rule.images) ? rule.images : [];
    const $src = $rule.find('.cii-image-src');

    if (images.length === 0) {
        $src.text('暂无图片 · 点击「添加图片」上传');
        return;
    }

    $src.text(`共 ${images.length} 张图片${images.length > 1 ? ' · 正文中点击图片可切换' : ''}`);

    for (const img of images) {
        let url = getImageUrlOfItem(img);
        if (!url && img.imageId) {
            url = await ensureUrlFromIndexedDB(img.imageId);
        }
        if (!url) continue;

        const $item = $(`
            <div class="cii-image-item" data-image-id="${escapeHtml(img.imageId || '')}">
                <img src="${escapeHtml(url)}" alt="">
                <button type="button" class="cii-image-remove" title="删除这张图片">×</button>
            </div>
        `);
        $addBtn.before($item);
    }
}

/* ================= 存储统计 ================= */

async function refreshStats() {
    try {
        const { count, bytes } = await getStorageStats();
        $('#cii-stat-count').text(count);
        $('#cii-stat-size').text(formatBytes(bytes));
        $('#cii-clear-all').prop('disabled', count === 0).toggleClass('cii-disabled', count === 0);
    } catch (e) {
        console.warn('[CII] 统计失败', e);
        $('#cii-stat-count').text('?');
        $('#cii-stat-size').text('?');
    }
}

/* ================= 导出 / 导入 ================= */

function ensureJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise((resolve, reject) => {
        if (document.querySelector('script[data-cii-jszip]')) {
            const timer = setInterval(() => {
                if (window.JSZip) { clearInterval(timer); resolve(window.JSZip); }
            }, 100);
            setTimeout(() => { clearInterval(timer); reject(new Error('JSZip 超时')); }, 12000);
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
        script.dataset.ciiJszip = '1';
        script.onload = () => {
            if (window.JSZip) resolve(window.JSZip);
            else reject(new Error('JSZip 未暴露'));
        };
        script.onerror = () => reject(new Error('JSZip 加载失败'));
        document.head.appendChild(script);
        setTimeout(() => reject(new Error('JSZip 超时')), 12000);
    });
}

function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => {
        try { document.body.removeChild(a); } catch { /* ignore */ }
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }, 1500);
}

async function exportData() {
    let JSZip;
    try { JSZip = await ensureJSZip(); }
    catch (e) { notify('无法加载压缩库：' + (e?.message || e), 'error'); return; }

    const s = getSettings();
    const zip = new JSZip();
    const config = {
        format: 'chat-image-inserter',
        version: 4,
        exportedAt: new Date().toISOString(),
        settings: {
            enabled: s.enabled,
            maxWidth: s.maxWidth,
            recentMessages: s.recentMessages,
            compressLevel: s.compressLevel,
        },
        groups: s.groups.map(g => ({ id: g.id, name: g.name })),
        rules: [],
    };

    let imageCount = 0;
    for (let i = 0; i < s.rules.length; i++) {
        const rule = s.rules[i];
        const exportRule = {
            pattern: rule.pattern || '',
            isRegex: !!rule.isRegex,
            maxMatches: getRuleMaxMatches(rule),
            enabled: rule.enabled !== false,
            removeMatched: !!rule.removeMatched,
            imagePosition: rule.imagePosition || 'after',
            groupId: rule.groupId || '',
            imageFiles: [],
            imageFile: null,
        };
        const imagesArr = Array.isArray(rule.images) ? rule.images : [];
        for (let j = 0; j < imagesArr.length; j++) {
            const img = imagesArr[j];
            if (!img.imageId) continue;
            const rec = await getImage(img.imageId);
            if (rec && rec.blob) {
                const ext = guessExt(rec.blob.type || img.imageType);
                const filename = `images/rule_${i}_${j}.${ext}`;
                zip.file(filename, rec.blob);
                exportRule.imageFiles.push(filename);
                imageCount++;
            }
        }
        if (exportRule.imageFiles.length > 0) {
            exportRule.imageFile = exportRule.imageFiles[0];
        }
        config.rules.push(exportRule);
    }
    if (config.rules.length === 0 && config.groups.length === 0) {
        notify('当前没有规则或分组可导出', 'warning');
        return;
    }
    zip.file('config.json', JSON.stringify(config, null, 2));

    let blob;
    try { blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }); }
    catch (e) { notify('打包失败：' + (e?.message || e), 'error'); return; }

    const ts = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const filename = `chat-image-inserter_${stamp}.zip`;
    triggerDownload(blob, filename);
    notify(`已导出 ${config.groups.length} 个分组、${config.rules.length} 条规则、${imageCount} 张图片`, 'success');
}

async function importData(file) {
    let JSZip;
    try { JSZip = await ensureJSZip(); }
    catch (e) { notify('无法加载压缩库：' + (e?.message || e), 'error'); return; }

    let zip;
    try { zip = await JSZip.loadAsync(file); }
    catch (e) { notify('无法解析 zip：' + (e?.message || e), 'error'); return; }

    const configFile = zip.file('config.json');
    if (!configFile) { notify('导入包缺少 config.json', 'error'); return; }

    let config;
    try { config = JSON.parse(await configFile.async('string')); }
    catch (e) { notify('config.json 解析失败：' + (e?.message || e), 'error'); return; }

    if (!config || !Array.isArray(config.rules)) { notify('配置格式错误', 'error'); return; }

    const groupIdMap = new Map();
    const newGroups = [];
    for (const g of (config.groups || [])) {
        if (!g || !g.id) continue;
        const newId = uid('g_') + '_' + newGroups.length;
        groupIdMap.set(g.id, newId);
        newGroups.push({
            id: newId,
            name: typeof g.name === 'string' && g.name ? g.name : '未命名分组',
        });
    }

    const newRules = [];
    let imageLoaded = 0;
    for (let i = 0; i < config.rules.length; i++) {
        const r = config.rules[i];
        const mappedGroup = r.groupId && groupIdMap.has(r.groupId) ? groupIdMap.get(r.groupId) : '';
        const rule = {
            id: uid('r_') + '_' + i,
            groupId: mappedGroup,
            pattern: typeof r.pattern === 'string' ? r.pattern : '',
            isRegex: !!r.isRegex,
            maxMatches: typeof r.maxMatches === 'number' ? Math.max(0, Math.floor(r.maxMatches)) : 1,
            enabled: r.enabled !== false,
            removeMatched: !!r.removeMatched,
            imagePosition: ['after', 'start', 'end'].includes(r.imagePosition) ? r.imagePosition : 'after',
            images: [],
        };

        const imageFiles = Array.isArray(r.imageFiles)
            ? r.imageFiles
            : (r.imageFile ? [r.imageFile] : []);

        for (let j = 0; j < imageFiles.length; j++) {
            const imgFile = zip.file(imageFiles[j]);
            if (!imgFile) continue;
            try {
                const blob = await imgFile.async('blob');
                const typedBlob = blob.type ? blob : new Blob([blob], { type: 'image/png' });
                const imageId = uid('img_') + '_' + i + '_' + j;
                await putImage(imageId, typedBlob, { name: imageFiles[j], type: typedBlob.type });
                const url = URL.createObjectURL(typedBlob);
                urlCache.set(imageId, url);
                rule.images.push({ imageId, imageType: typedBlob.type });
                imageLoaded++;
            } catch (e) { console.warn('[CII] 图片导入失败', e); }
        }
        newRules.push(rule);
    }

    const ok = window.confirm(
        `即将导入 ${newGroups.length} 个分组、${newRules.length} 条规则、${imageLoaded} 张图片，追加到现有内容。\n继续？`,
    );
    if (!ok) {
        for (const rule of newRules) {
            for (const img of rule.images) {
                if (img.imageId) {
                    try { await deleteImage(img.imageId); } catch { /* ignore */ }
                    releaseImageUrl(img.imageId);
                }
            }
        }
        return;
    }

    const s = getSettings();
    s.groups.push(...newGroups);
    s.rules.push(...newRules);
    saveSettings();

    await ensureAllUrls();
    const set = loadSet(COLLAPSED_KEY);
    for (const rule of newRules) set.add(rule.id);
    saveSet(COLLAPSED_KEY, set);

    renderRules();
    resetProcessing();
    scheduleProcess();
    await refreshStats();
    notify(`已导入 ${newGroups.length} 个分组、${newRules.length} 条规则、${imageLoaded} 张图片`, 'success');
}

/* ================= 清除全部 ================= */

async function clearAllCachedImages() {
    let stats;
    try { stats = await getStorageStats(); }
    catch (e) { notify('读取统计失败：' + (e?.message || e), 'error'); return; }
    if (stats.count === 0) { notify('当前没有缓存的图片', 'info'); return; }
    const ok = window.confirm(
        `确定清除全部 ${stats.count} 张图片（${formatBytes(stats.bytes)}）吗？\n规则会保留，但需要重新上传图片。`,
    );
    if (!ok) return;
    const s = getSettings();
    for (const rule of s.rules) rule.images = [];
    saveSettings();
    try { await clearAllImagesFromDb(); }
    catch (e) { notify('清空失败：' + (e?.message || e), 'error'); return; }
    for (const url of urlCache.values()) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
    urlCache.clear();
    resetProcessing();
    scheduleProcess();
    renderRules();
    await refreshStats();
    notify(`已清除 ${stats.count} 张缓存图片`, 'success');
}

/* ================= 规则 / 分组 HTML ================= */

function buildPatternPreview(rule) {
    if (!rule.pattern) return '（未设置匹配文字）';
    const n = Array.isArray(rule.images) ? rule.images.length : 0;
    return `「${rule.pattern}」${n > 1 ? ` · ${n}图` : ''}`;
}

function buildRuleHtml(rule, globalIndex) {
    const s = getSettings();
    const collapsed = isRuleCollapsed(rule.id);
    const previewText = escapeHtml(buildPatternPreview(rule));
    const groupOptions = s.groups.map(g =>
        `<option value="${escapeHtml(g.id)}"${g.id === rule.groupId ? ' selected' : ''}>${escapeHtml(g.name)}</option>`
    ).join('');

    const $el = $(`
        <div class="cii-rule${collapsed ? ' collapsed' : ''}" data-id="${rule.id}">
            <div class="cii-rule-head">
                <button type="button" class="cii-rule-toggle" title="展开 / 折叠">
                    <i class="fa-solid fa-chevron-down"></i>
                </button>
                <span class="cii-rule-badge">#${globalIndex}</span>
                <span class="cii-rule-preview-text">${previewText}</span>
                <div class="cii-rule-actions">
                    <label class="cii-switch" title="启用 / 禁用此规则">
                        <input type="checkbox" class="cii-rule-enabled">
                        <span class="cii-switch-track"><span class="cii-switch-thumb"></span></span>
                    </label>
                    <button type="button" class="cii-icon-btn cii-danger cii-delete-rule" title="删除规则">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>
            <div class="cii-rule-body">
                <div class="cii-field">
                    <label class="cii-label">匹配文字</label>
                    <input type="text" class="text_pole cii-pattern" placeholder="例如：*微笑*">
                    <label class="cii-check" title="按正则匹配">
                        <input type="checkbox" class="cii-regex">
                        <span>正则</span>
                    </label>
                </div>
                <div class="cii-field">
                    <label class="cii-label">每则上限</label>
                    <input type="number" class="text_pole cii-maxmatches" min="0" step="1" style="max-width:80px;">
                    <span class="cii-field-hint">次（0 = 不限）</span>
                </div>
                <div class="cii-field">
                    <label class="cii-label">图片位置</label>
                    <select class="text_pole cii-imagepos" style="flex:1;">
                        <option value="after">匹配文字后面</option>
                        <option value="start">全文开头</option>
                        <option value="end">全文结尾</option>
                    </select>
                </div>
                <div class="cii-field">
                    <label class="cii-check cii-check-wide" title="匹配文字会被删除，只保留图片">
                        <input type="checkbox" class="cii-remove">
                        <span>匹配文字消失（只显示图片）</span>
                    </label>
                </div>
                <div class="cii-field">
                    <label class="cii-label">所属分组</label>
                    <select class="text_pole cii-rulegroup" style="flex:1;">
                        <option value="">📌 未分组</option>
                        ${groupOptions}
                    </select>
                </div>
                <div class="cii-image-area">
                    <div class="cii-image-grid">
                        <label class="cii-image-add" title="添加图片（可多选）">
                            <i class="fa-solid fa-plus"></i>
                            <span>添加</span>
                            <input type="file" class="cii-upload" accept="image/*" multiple hidden>
                        </label>
                    </div>
                    <div class="cii-image-src cii-dim"></div>
                </div>
            </div>
        </div>
    `);
    $el.find('.cii-rule-enabled').prop('checked', rule.enabled !== false);
    $el.find('.cii-pattern').val(rule.pattern || '');
    $el.find('.cii-regex').prop('checked', !!rule.isRegex);
    $el.find('.cii-maxmatches').val(getRuleMaxMatches(rule));
    $el.find('.cii-imagepos').val(rule.imagePosition || 'after');
    $el.find('.cii-remove').prop('checked', !!rule.removeMatched);
    refreshPreview($el, rule);
    return $el;
}

function buildGroupHtml(group, groupRules, opts = {}) {
    const { isUngrouped = false } = opts;
    const collapsed = isUngrouped ? false : isGroupCollapsed(group.id);
    const groupId = group.id || '';

    const $el = $(`
        <div class="cii-group${collapsed ? ' collapsed' : ''}${isUngrouped ? ' cii-group-ungrouped' : ''}" data-group-id="${escapeHtml(groupId)}">
            <div class="cii-group-head">
                <button type="button" class="cii-group-toggle">
                    <i class="fa-solid fa-chevron-down"></i>
                </button>
                <span class="cii-group-icon">${isUngrouped ? '📌' : '📁'}</span>
                <span class="cii-group-name">${escapeHtml(group.name)}</span>
                <span class="cii-group-count">${groupRules.length}</span>
                <div class="cii-spacer"></div>
                ${!isUngrouped ? `
                    <button type="button" class="cii-icon-btn cii-rename-group" title="重命名分组">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button type="button" class="cii-icon-btn cii-danger cii-delete-group" title="删除分组">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                ` : ''}
            </div>
            <div class="cii-group-body"></div>
        </div>
    `);

    const $body = $el.find('.cii-group-body');
    if (groupRules.length === 0) {
        $body.append('<div class="cii-group-empty">📭 这个分组还没有规则哦～</div>');
    } else {
        for (const rule of groupRules) {
            const globalIdx = getGlobalIndex(rule.id) + 1;
            $body.append(buildRuleHtml(rule, globalIdx));
        }
    }
    return $el;
}

function getGlobalIndex(ruleId) {
    const s = getSettings();
    return s.rules.findIndex(r => r.id === ruleId);
}

function renderRules() {
    const s = getSettings();
    const $rules = $('#cii-rules').empty();

    if (s.rules.length === 0 && s.groups.length === 0) {
        $rules.append(`
            <div class="cii-empty">
                <div class="cii-empty-emoji">🎀</div>
                <span>还没有规则哦～</span>
                <small>点击下方「添加规则」开始叭</small>
            </div>
        `);
        return;
    }

    const validGroupIds = new Set(s.groups.map(g => g.id));

    if (s.groups.length > 0) {
        for (const group of s.groups) {
            const groupRules = s.rules.filter(r => r.groupId === group.id);
            $rules.append(buildGroupHtml(group, groupRules, { isUngrouped: false }));
        }
        const ungrouped = s.rules.filter(r => !r.groupId || !validGroupIds.has(r.groupId));
        if (ungrouped.length > 0) {
            $rules.append(buildGroupHtml(
                { id: '', name: '未分组' },
                ungrouped,
                { isUngrouped: true },
            ));
        }
    } else {
        s.rules.forEach((rule, i) => $rules.append(buildRuleHtml(rule, i + 1)));
    }
}

function updateRule(id, patch) {
    const s = getSettings();
    const rule = s.rules.find(r => String(r.id) === String(id));
    if (!rule) return;
    Object.assign(rule, patch);
    saveSettings();
    resetProcessing();
    scheduleProcess();
}

function toggleRuleCollapse($rule) {
    const id = String($rule.attr('data-id'));
    const nowCollapsed = !$rule.hasClass('collapsed');
    $rule.toggleClass('collapsed', nowCollapsed);
    setRuleCollapsed(id, nowCollapsed);
}

function toggleGroupCollapse($group) {
    const groupId = $group.attr('data-group-id');
    if (!groupId) return;
    const nowCollapsed = !$group.hasClass('collapsed');
    $group.toggleClass('collapsed', nowCollapsed);
    setGroupCollapsed(groupId, nowCollapsed);
}

/* ================= 主题 ================= */

function applyTheme(mode) {
    const $el = $('#cii-settings');
    $el.removeClass('cii-theme-dark cii-theme-light');
    if (mode === 'dark') $el.addClass('cii-theme-dark');
    else if (mode === 'light') $el.addClass('cii-theme-light');
}

/* ================= 设置 HTML ================= */

function buildSettingsHtml() {
    return `
        <div id="cii-settings" class="cii-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-wand-magic-sparkles cii-accent-icon"></i> 文字插图 <span class="cii-en-title">Chat Image Inserter</span></b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">

                    <div class="cii-card">
                        <div class="cii-card-title">
                            <span class="cii-emoji">✨</span>
                            <span>常规设置</span>
                        </div>
                        <div class="cii-row">
                            <label class="cii-switch cii-switch-labeled">
                                <input type="checkbox" id="cii-enabled">
                                <span class="cii-switch-track"><span class="cii-switch-thumb"></span></span>
                                <span class="cii-switch-label">启用</span>
                            </label>
                            <div class="cii-spacer"></div>
                            <label class="cii-inline-label">图片最大宽度</label>
                            <input type="number" id="cii-maxwidth" class="text_pole cii-num" min="40" max="1200" step="10">
                            <span class="cii-unit">px</span>
                        </div>
                        <div class="cii-row" style="margin-top:10px;">
                            <label class="cii-inline-label" style="min-width:auto;">界面主题</label>
                            <select id="cii-theme" class="text_pole" style="min-width:150px;">
                                <option value="auto">🌗 跟随酒馆 / 系统</option>
                                <option value="dark">🌙 强制暗色</option>
                                <option value="light">☀️ 强制亮色</option>
                            </select>
                            <div class="cii-spacer"></div>
                            <label class="cii-inline-label">匹配最近</label>
                            <input type="number" id="cii-recent" class="text_pole cii-num" min="0" max="9999" step="1">
                            <span class="cii-unit">条（0 = 全部）</span>
                        </div>
                    </div>

                    <div class="cii-card">
                        <div class="cii-card-title">
                            <span class="cii-emoji">🗜️</span>
                            <span>图片压缩</span>
                        </div>
                        <div class="cii-row">
                            <label class="cii-inline-label" style="min-width:auto;">压缩档位</label>
                            <select id="cii-compress" class="text_pole" style="flex:1;min-width:220px;">
                                ${COMPRESS_PRESETS.map((p, i) =>
                                    `<option value="${i}">${escapeHtml(p.name)}${i > 0 ? ' · ' + escapeHtml(p.desc) : ''}</option>`
                                ).join('')}
                            </select>
                        </div>
                        <div class="cii-row" style="margin-top:10px;">
                            <button type="button" class="cii-btn cii-btn-secondary" id="cii-recompress-all">
                                <i class="fa-solid fa-compress"></i>
                                <span>压缩现有图片</span>
                            </button>
                        </div>
                        <div class="cii-dim cii-tiny">
                            上传新图片时按所选档位自动压缩；点「压缩现有图片」可对已存储的图片批量重新压缩。<br>
                            GIF 和 SVG 不会被压缩（避免动画丢帧或矢量失真）；压缩后统一为 JPEG 格式。<br>
                            原图比压缩结果小时会保留原图，不会无意义地变大。
                        </div>
                    </div>

                    <div class="cii-card">
                        <div class="cii-card-title">
                            <span class="cii-emoji">💾</span>
                            <span>存储管理</span>
                        </div>
                        <div class="cii-row cii-stat-row">
                            <div class="cii-stat">
                                <span class="cii-stat-value" id="cii-stat-count">0</span>
                                <span class="cii-stat-label">张图片</span>
                            </div>
                            <div class="cii-stat">
                                <span class="cii-stat-value" id="cii-stat-size">0 B</span>
                                <span class="cii-stat-label">占用空间</span>
                            </div>
                            <div class="cii-spacer"></div>
                            <button type="button" class="cii-btn cii-btn-danger cii-disabled" id="cii-clear-all">
                                <i class="fa-solid fa-trash-can"></i>
                                <span>清除全部图片</span>
                            </button>
                        </div>
                        <div class="cii-dim cii-tiny">图片存在浏览器本地，卸载或清理数据会丢失，建议保留原图备份～</div>
                    </div>

                    <div class="cii-card">
                        <div class="cii-card-title">
                            <span class="cii-emoji">📦</span>
                            <span>数据备份与分享</span>
                        </div>
                        <div class="cii-row">
                            <button type="button" class="cii-btn cii-btn-primary" id="cii-export">
                                <i class="fa-solid fa-download"></i>
                                <span>导出分组 / 规则 / 图片</span>
                            </button>
                            <label class="cii-btn cii-btn-secondary">
                                <i class="fa-solid fa-upload"></i>
                                <span>导入分享包</span>
                                <input type="file" id="cii-import" accept=".zip,application/zip" hidden>
                            </label>
                        </div>
                        <div class="cii-dim cii-tiny">
                            支持一条规则多张图片；导出时所有图片一并打包～
                        </div>
                    </div>

                    <div class="cii-card cii-card-rules">
                        <div class="cii-card-title">
                            <span class="cii-emoji">🌸</span>
                            <span>匹配规则</span>
                            <span class="cii-spacer"></span>
                            <span class="cii-dim cii-tiny-inline">点击分组 / 规则头部可折叠</span>
                        </div>
                        <div id="cii-rules"></div>
                        <div class="cii-actions-row">
                            <button type="button" class="cii-btn cii-btn-add" id="cii-add-rule">
                                <i class="fa-solid fa-plus"></i>
                                <span>添加规则</span>
                            </button>
                            <button type="button" class="cii-btn cii-btn-add cii-btn-add-group" id="cii-add-group">
                                <i class="fa-solid fa-folder-plus"></i>
                                <span>添加分组</span>
                            </button>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    `;
}

/* ================= 内联重命名 ================= */

function beginRenameGroup($group, saveFn) {
    const $name = $group.find('.cii-group-name').first();
    if (!$name.length || $name.hasClass('editing')) return;
    const currentName = $name.text();
    $name.addClass('editing');

    const $input = $(`<input type="text" class="text_pole cii-group-name-input">`).val(currentName);
    $name.hide().after($input);
    $input.trigger('focus').select();

    let finished = false;
    const finish = (save) => {
        if (finished) return;
        finished = true;
        const val = $input.val().trim();
        $input.remove();
        $name.removeClass('editing').show();
        if (save && val && val !== currentName) {
            $name.text(val);
            if (saveFn) saveFn(val);
        }
    };
    $input.on('blur', () => finish(true));
    $input.on('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
}

/* ================= 事件 ================= */

function bindEvents() {
    $(document)
        .off('change.cii', '#cii-enabled')
        .on('change.cii', '#cii-enabled', function () {
            getSettings().enabled = this.checked;
            saveSettings();
            resetProcessing();
            scheduleProcess();
        });

    $(document)
        .off('input.cii', '#cii-maxwidth')
        .on('input.cii', '#cii-maxwidth', function () {
            const v = Math.max(40, Math.min(1200, Number(this.value) || 300));
            getSettings().maxWidth = v;
            saveSettings();
            resetProcessing();
            scheduleProcess();
        });

    $(document)
        .off('input.cii', '#cii-recent')
        .on('input.cii', '#cii-recent', function () {
            const v = Math.max(0, Math.min(9999, Math.floor(Number(this.value) || 0)));
            getSettings().recentMessages = v;
            saveSettings();
            resetProcessing();
            scheduleProcess();
        });

    $(document)
        .off('change.cii', '#cii-theme')
        .on('change.cii', '#cii-theme', function () {
            getSettings().themeMode = this.value;
            saveSettings();
            applyTheme(this.value);
        });

    $(document)
        .off('change.cii', '#cii-compress')
        .on('change.cii', '#cii-compress', function () {
            const v = Math.max(0, Math.min(4, Math.floor(Number(this.value) || 0)));
            getSettings().compressLevel = v;
            saveSettings();
        });

    $(document)
        .off('click.cii', '#cii-recompress-all')
        .on('click.cii', '#cii-recompress-all', function (e) {
            e.preventDefault();
            recompressAllImages();
        });

    $(document)
        .off('click.cii', '#cii-clear-all')
        .on('click.cii', '#cii-clear-all', function (e) {
            e.preventDefault(); clearAllCachedImages();
        });

    $(document)
        .off('click.cii', '#cii-export')
        .on('click.cii', '#cii-export', function (e) {
            e.preventDefault(); exportData();
        });

    $(document)
        .off('change.cii', '#cii-import')
        .on('change.cii', '#cii-import', async function () {
            const file = this.files && this.files[0];
            this.value = '';
            if (!file) return;
            try { await importData(file); }
            catch (e) {
                console.error('[CII] 导入失败', e);
                notify('导入失败：' + (e?.message || e), 'error');
            }
        });

    $(document)
        .off('click.cii', '#cii-add-rule')
        .on('click.cii', '#cii-add-rule', function (e) {
            e.preventDefault();
            const s = getSettings();
            const id = uid('r_');
            s.rules.push({
                id, groupId: '',
                pattern: '', isRegex: false,
                images: [],
                maxMatches: 1, enabled: true,
                removeMatched: false, imagePosition: 'after',
            });
            saveSettings();
            setRuleCollapsed(id, false);
            renderRules();
            const $el = $(`#cii-rules .cii-rule[data-id="${id}"]`);
            if ($el.length) {
                $el[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                $el.find('.cii-pattern').trigger('focus');
            }
        });

    $(document)
        .off('click.cii', '#cii-add-group')
        .on('click.cii', '#cii-add-group', function (e) {
            e.preventDefault();
            const s = getSettings();
            const id = uid('g_');
            s.groups.push({ id, name: '新分组' });
            saveSettings();
            setGroupCollapsed(id, false);
            renderRules();
            const $group = $(`#cii-rules .cii-group[data-group-id="${id}"]`);
            if ($group.length) {
                $group[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                setTimeout(() => {
                    beginRenameGroup($group, val => {
                        const st = getSettings();
                        const g = st.groups.find(x => x.id === id);
                        if (g) { g.name = val; saveSettings(); }
                    });
                }, 120);
            }
        });

    $('#cii-rules')
        .off('click.cii', '.cii-group-head')
        .on('click.cii', '.cii-group-head', function (e) {
            if ($(e.target).closest('.cii-rename-group, .cii-delete-group, .cii-group-name-input').length) return;
            const $group = $(this).closest('.cii-group');
            if ($group.hasClass('cii-group-ungrouped')) return;
            toggleGroupCollapse($group);
        });

    $('#cii-rules')
        .off('click.cii', '.cii-rename-group')
        .on('click.cii', '.cii-rename-group', function (e) {
            e.preventDefault(); e.stopPropagation();
            const $group = $(this).closest('.cii-group');
            const groupId = $group.attr('data-group-id');
            beginRenameGroup($group, val => {
                const s = getSettings();
                const g = s.groups.find(x => x.id === groupId);
                if (g) { g.name = val; saveSettings(); }
            });
        });

    $('#cii-rules')
        .off('click.cii', '.cii-delete-group')
        .on('click.cii', '.cii-delete-group', function (e) {
            e.preventDefault(); e.stopPropagation();
            const $group = $(this).closest('.cii-group');
            const groupId = $group.attr('data-group-id');
            const s = getSettings();
            const group = s.groups.find(g => g.id === groupId);
            if (!group) return;
            const groupRules = s.rules.filter(r => r.groupId === groupId);
            const msg = groupRules.length > 0
                ? `确定删除分组「${group.name}」吗？\n组内 ${groupRules.length} 条规则会变为"未分组"，规则本身不会被删除。`
                : `确定删除分组「${group.name}」吗？`;
            if (!window.confirm(msg)) return;
            s.groups = s.groups.filter(g => g.id !== groupId);
            for (const rule of groupRules) rule.groupId = '';
            saveSettings();
            renderRules();
        });

    $('#cii-rules')
        .off('click.cii', '.cii-rule-head')
        .on('click.cii', '.cii-rule-head', function (e) {
            if ($(e.target).closest('.cii-switch, .cii-delete-rule').length) return;
            toggleRuleCollapse($(this).closest('.cii-rule'));
        });

    $('#cii-rules')
        .off('input.cii', '.cii-pattern')
        .on('input.cii', '.cii-pattern', function () {
            const $rule = $(this).closest('.cii-rule');
            const id = String($rule.attr('data-id'));
            const pattern = $(this).val();
            updateRule(id, { pattern });
            const rule = getSettings().rules.find(r => String(r.id) === id);
            $rule.find('.cii-rule-preview-text').text(
                escapeHtml(buildPatternPreview({ pattern, images: rule?.images || [] })),
            );
        });

    $('#cii-rules').off('change.cii', '.cii-regex').on('change.cii', '.cii-regex', function () {
        updateRule(String($(this).closest('.cii-rule').attr('data-id')), { isRegex: this.checked });
    });

    $('#cii-rules').off('change.cii', '.cii-rule-enabled').on('change.cii', '.cii-rule-enabled', function () {
        updateRule(String($(this).closest('.cii-rule').attr('data-id')), { enabled: this.checked });
    });

    $('#cii-rules').off('input.cii', '.cii-maxmatches').on('input.cii', '.cii-maxmatches', function () {
        const v = Math.max(0, Math.floor(Number(this.value) || 0));
        updateRule(String($(this).closest('.cii-rule').attr('data-id')), { maxMatches: v });
    });

    $('#cii-rules').off('change.cii', '.cii-imagepos').on('change.cii', '.cii-imagepos', function () {
        updateRule(String($(this).closest('.cii-rule').attr('data-id')), { imagePosition: this.value });
    });

    $('#cii-rules').off('change.cii', '.cii-remove').on('change.cii', '.cii-remove', function () {
        updateRule(String($(this).closest('.cii-rule').attr('data-id')), { removeMatched: this.checked });
    });

    $('#cii-rules').off('change.cii', '.cii-rulegroup').on('change.cii', '.cii-rulegroup', function () {
        const $rule = $(this).closest('.cii-rule');
        const id = String($rule.attr('data-id'));
        const val = $(this).val() || '';
        updateRule(id, { groupId: val });
        renderRules();
        setTimeout(() => {
            const $target = $(`#cii-rules .cii-rule[data-id="${id}"]`);
            if ($target.length) $target[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 60);
    });

    $('#cii-rules')
        .off('click.cii', '.cii-delete-rule')
        .on('click.cii', '.cii-delete-rule', async function (e) {
            e.preventDefault(); e.stopPropagation();
            const $rule = $(this).closest('.cii-rule');
            const id = String($rule.attr('data-id'));
            const s = getSettings();
            const rule = s.rules.find(r => String(r.id) === id);
            if (!rule) return;
            if (!window.confirm('确定删除这条规则吗？')) return;
            await removeRuleImageRefs(rule);
            s.rules = s.rules.filter(r => String(r.id) !== id);
            setRuleCollapsed(id, false);
            saveSettings();
            renderRules();
            resetProcessing();
            scheduleProcess();
            await refreshStats();
        });

    $('#cii-rules')
        .off('change.cii', '.cii-upload')
        .on('change.cii', '.cii-upload', async function () {
            const files = Array.from(this.files || []);
            if (!files.length) return;
            const $rule = $(this).closest('.cii-rule');
            try {
                $rule.addClass('cii-uploading');
                await handleUpload(files, $rule);
                const ruleId = String($rule.attr('data-id'));
                const rule = getSettings().rules.find(r => String(r.id) === ruleId);
                await refreshPreview($rule, rule);
                if (rule) {
                    $rule.find('.cii-rule-preview-text').text(escapeHtml(buildPatternPreview(rule)));
                }
            } catch (e) {
                console.error('[CII] 保存失败', e);
                notify('保存失败：' + (e?.message || e), 'error');
            } finally {
                $rule.removeClass('cii-uploading');
                this.value = '';
            }
        });

    $('#cii-rules')
        .off('click.cii', '.cii-image-remove')
        .on('click.cii', '.cii-image-remove', async function (e) {
            e.preventDefault(); e.stopPropagation();
            const $item = $(this).closest('.cii-image-item');
            const imageId = String($item.attr('data-image-id') || '');
            const $rule = $(this).closest('.cii-rule');
            const ruleId = String($rule.attr('data-id'));
            const s = getSettings();
            const rule = s.rules.find(r => String(r.id) === ruleId);
            if (!rule || !imageId) return;

            await removeOneImage(rule, imageId);
            await refreshPreview($rule, rule);
            $rule.find('.cii-rule-preview-text').text(escapeHtml(buildPatternPreview(rule)));
        });
}

/* ================= 样式 ================= */

function injectStyles() {
    if (document.getElementById('cii-styles')) return;
    const style = document.createElement('style');
    style.id = 'cii-styles';
    style.textContent = `
        .cii-settings {
            --cii-pink: #ffb7d5;
            --cii-pink-deep: #f06ba8;
            --cii-purple: #c4a7ff;
            --cii-purple-deep: #a889e8;
            --cii-radius: 14px;
            --cii-radius-sm: 10px;
            --cii-card-bg: var(--SmartThemeBlurTintColor, rgba(40, 30, 55, 0.55));
            --cii-card-bg-2: rgba(255, 183, 213, 0.06);
            --cii-border: rgba(255, 183, 213, 0.28);
            --cii-border-hover: rgba(255, 183, 213, 0.55);
            --cii-text: var(--SmartThemeBodyColor, #ecdcef);
            --cii-text-dim: var(--SmartThemeEmColor, rgba(220, 200, 230, 0.65));
            --cii-danger: #ff7a9c;
            --cii-glow: 0 6px 22px rgba(255, 183, 213, 0.12);
            --cii-input-bg: rgba(0, 0, 0, 0.2);
            --cii-rule-bg: rgba(0, 0, 0, 0.1);
            --cii-rule-head-hover: rgba(255, 183, 213, 0.06);
            padding: 4px 0;
            color: var(--cii-text);
            font-family: inherit;
        }
        .cii-settings.cii-theme-dark {
            --cii-card-bg: rgba(35, 28, 50, 0.92);
            --cii-card-bg-2: rgba(255, 183, 213, 0.08);
            --cii-border: rgba(255, 183, 213, 0.32);
            --cii-text: #ecdcef;
            --cii-text-dim: rgba(200, 180, 220, 0.72);
            --cii-input-bg: rgba(0, 0, 0, 0.4);
            --cii-rule-bg: rgba(0, 0, 0, 0.25);
            --cii-rule-head-hover: rgba(255, 183, 213, 0.08);
        }
        .cii-settings.cii-theme-light {
            --cii-card-bg: rgba(255, 250, 252, 0.96);
            --cii-card-bg-2: rgba(255, 183, 213, 0.14);
            --cii-border: rgba(240, 107, 168, 0.38);
            --cii-text: #3a2e45;
            --cii-text-dim: rgba(90, 70, 100, 0.75);
            --cii-danger: #e0457e;
            --cii-glow: 0 6px 22px rgba(240, 107, 168, 0.15);
            --cii-input-bg: rgba(255, 255, 255, 0.96);
            --cii-rule-bg: rgba(255, 255, 255, 0.55);
            --cii-rule-head-hover: rgba(240, 107, 168, 0.08);
        }

        .cii-settings .cii-accent-icon {
            background: linear-gradient(135deg, #ffb7d5 0%, #c4a7ff 100%);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            margin-right: 4px;
            font-weight: 700;
        }
        .cii-settings .cii-en-title {
            font-size: 0.78em;
            color: var(--cii-pink-deep);
            opacity: 0.75;
            margin-left: 6px;
            letter-spacing: 0.3px;
        }
        .cii-settings .cii-card {
            background: linear-gradient(135deg,
                var(--cii-card-bg) 0%,
                var(--cii-card-bg-2) 100%);
            border: 1.5px solid var(--cii-border);
            border-radius: var(--cii-radius);
            padding: 12px 14px;
            margin: 10px 0;
            box-shadow: var(--cii-glow),
                        inset 0 1px 0 rgba(255, 255, 255, 0.05);
            position: relative;
        }
        .cii-settings .cii-card-title {
            font-weight: 700;
            font-size: 0.95em;
            margin-bottom: 10px;
            color: var(--cii-text);
            display: flex;
            align-items: center;
            gap: 6px;
            letter-spacing: 0.3px;
        }
        .cii-settings .cii-emoji {
            font-size: 1.1em;
            filter: drop-shadow(0 1px 2px rgba(255, 183, 213, 0.5));
        }
        .cii-settings .cii-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .cii-settings .cii-spacer { flex: 1; }
        .cii-settings .cii-label {
            font-size: 0.85em;
            color: var(--cii-text-dim);
            min-width: 64px;
            flex-shrink: 0;
        }
        .cii-settings .cii-field {
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 8px 0;
        }
        .cii-settings .cii-field-hint { font-size: 0.82em; color: var(--cii-text-dim); }
        .cii-settings .cii-num { width: 82px !important; }
        .cii-settings .cii-unit { color: var(--cii-text-dim); }

        .cii-settings .text_pole,
        .cii-settings select.text_pole {
            border-radius: var(--cii-radius-sm);
            border: 1.5px solid var(--cii-border);
            background: var(--cii-input-bg);
            color: var(--cii-text);
            transition: border-color .2s, box-shadow .2s, background .2s;
        }
        .cii-settings .text_pole:hover { border-color: var(--cii-border-hover); }
        .cii-settings .text_pole:focus {
            border-color: var(--cii-pink-deep);
            box-shadow: 0 0 0 3px rgba(255, 183, 213, 0.2);
            outline: none;
        }

        .cii-settings .cii-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
        .cii-settings .cii-switch input { display: none; }
        .cii-settings .cii-switch-track {
            position: relative;
            display: inline-block;
            width: 40px;
            height: 22px;
            border-radius: 999px;
            background: rgba(150, 130, 170, 0.4);
            transition: background .25s;
            flex-shrink: 0;
            box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.25);
        }
        .cii-settings .cii-switch-thumb {
            position: absolute;
            top: 2px; left: 2px;
            width: 18px; height: 18px;
            border-radius: 50%;
            background: #fff;
            box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3),
                        0 0 8px rgba(255, 183, 213, 0.6);
            transition: transform .25s cubic-bezier(.68,-.55,.27,1.55);
        }
        .cii-settings .cii-switch input:checked + .cii-switch-track {
            background: linear-gradient(135deg, #ffb7d5 0%, #c4a7ff 100%);
        }
        .cii-settings .cii-switch input:checked + .cii-switch-track .cii-switch-thumb {
            transform: translateX(18px);
        }
        .cii-settings .cii-switch-label { font-size: 0.9em; color: var(--cii-text); }
        .cii-settings .cii-inline-label { font-size: 0.85em; color: var(--cii-text-dim); }

        .cii-settings .cii-check { display: inline-flex; align-items: center; gap: 5px; font-size: 0.85em; color: var(--cii-text-dim); cursor: pointer; white-space: nowrap; }
        .cii-settings .cii-check input[type="checkbox"] { accent-color: var(--cii-pink-deep); }
        .cii-settings .cii-check-wide { font-size: 0.86em; color: var(--cii-text); padding: 2px 0; }

        .cii-settings .cii-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 7px 14px;
            border-radius: var(--cii-radius-sm);
            border: 1.5px solid var(--cii-border);
            background: transparent;
            color: var(--cii-text);
            font-size: 0.88em;
            cursor: pointer;
            transition: transform .15s, background .2s, border-color .2s, box-shadow .2s;
            white-space: nowrap;
            font-weight: 500;
        }
        .cii-settings .cii-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(255, 183, 213, 0.2); }
        .cii-settings .cii-btn:active { transform: translateY(0); }
        .cii-settings .cii-btn-primary {
            background: linear-gradient(135deg, #ffb7d5 0%, #c4a7ff 100%);
            border-color: transparent;
            color: #fff;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
            box-shadow: 0 3px 10px rgba(255, 183, 213, 0.3);
        }
        .cii-settings .cii-btn-primary:hover { box-shadow: 0 5px 18px rgba(255, 183, 213, 0.45); }
        .cii-settings .cii-btn-secondary:hover {
            border-color: var(--cii-pink-deep);
            color: var(--cii-pink-deep);
            background: rgba(255, 183, 213, 0.08);
        }
        .cii-settings .cii-btn-danger {
            color: var(--cii-danger);
            border-color: rgba(255, 122, 156, 0.5);
        }
        .cii-settings .cii-btn-danger:hover {
            background: rgba(255, 122, 156, 0.15);
            border-color: var(--cii-danger);
        }
        .cii-settings .cii-btn.cii-disabled,
        .cii-settings .cii-btn:disabled {
            opacity: 0.35;
            pointer-events: none;
            box-shadow: none;
            transform: none;
        }
        .cii-settings .cii-actions-row { display: flex; gap: 8px; margin-top: 10px; }
        .cii-settings .cii-btn-add {
            flex: 1;
            justify-content: center;
            border-style: dashed;
            color: var(--cii-pink-deep);
            border-color: rgba(255, 183, 213, 0.5);
            background: rgba(255, 183, 213, 0.04);
        }
        .cii-settings .cii-btn-add:hover {
            background: rgba(255, 183, 213, 0.12);
            border-style: solid;
            border-color: var(--cii-pink-deep);
        }
        .cii-settings .cii-btn-add-group {
            color: var(--cii-purple-deep);
            border-color: rgba(196, 167, 255, 0.5);
        }
        .cii-settings .cii-btn-add-group:hover {
            background: rgba(196, 167, 255, 0.12);
            border-color: var(--cii-purple-deep);
        }

        .cii-settings .cii-icon-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 30px; height: 30px;
            border-radius: 9px;
            border: 1.5px solid var(--cii-border);
            background: transparent;
            color: var(--cii-text-dim);
            cursor: pointer;
            transition: all .18s;
            padding: 0;
        }
        .cii-settings .cii-icon-btn:hover {
            background: rgba(255, 255, 255, 0.06);
            color: var(--cii-text);
            transform: translateY(-1px);
        }
        .cii-settings .cii-icon-btn.cii-danger:hover {
            background: rgba(255, 122, 156, 0.15);
            color: var(--cii-danger);
            border-color: var(--cii-danger);
        }

        .cii-settings .cii-stat-row { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
        .cii-settings .cii-stat { display: flex; flex-direction: column; gap: 2px; }
        .cii-settings .cii-stat-value {
            font-weight: 800;
            font-size: 1.25em;
            background: linear-gradient(135deg, #ffb7d5, #c4a7ff);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            letter-spacing: 0.3px;
        }
        .cii-settings .cii-stat-label { font-size: 0.78em; color: var(--cii-text-dim); }
        .cii-settings .cii-dim { color: var(--cii-text-dim); }
        .cii-settings .cii-tiny { font-size: 0.78em; margin-top: 8px; line-height: 1.55; }
        .cii-settings .cii-tiny-inline { font-size: 0.78em; font-weight: 400; letter-spacing: 0; }

        .cii-settings .cii-card-rules { padding-bottom: 12px; }
        .cii-settings .cii-group {
            position: relative;
            border: 1.5px solid var(--cii-border);
            border-radius: var(--cii-radius);
            margin: 12px 0;
            background: rgba(0, 0, 0, 0.04);
            overflow: hidden;
            transition: border-color .2s, box-shadow .2s;
        }
        .cii-settings .cii-group:hover {
            border-color: var(--cii-border-hover);
            box-shadow: 0 3px 18px rgba(255, 183, 213, 0.14);
        }
        .cii-settings .cii-group-ungrouped {
            border-style: dashed;
            background: rgba(0, 0, 0, 0.02);
        }
        .cii-settings .cii-group-head {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 10px 12px;
            cursor: pointer;
            user-select: none;
            background: linear-gradient(135deg,
                rgba(255, 183, 213, 0.12) 0%,
                rgba(196, 167, 255, 0.12) 100%);
            border-bottom: 1px solid transparent;
            transition: background .2s, border-color .2s;
        }
        .cii-settings .cii-group:not(.collapsed) .cii-group-head {
            border-bottom-color: var(--cii-border);
        }
        .cii-settings .cii-group-head:hover {
            background: linear-gradient(135deg,
                rgba(255, 183, 213, 0.22) 0%,
                rgba(196, 167, 255, 0.22) 100%);
        }
        .cii-settings .cii-group-ungrouped .cii-group-head {
            background: linear-gradient(135deg,
                rgba(200, 200, 220, 0.08) 0%,
                rgba(200, 200, 220, 0.04) 100%);
            cursor: default;
        }
        .cii-settings .cii-group-toggle {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 22px; height: 22px;
            border: none;
            background: transparent;
            color: var(--cii-pink-deep);
            cursor: pointer;
            padding: 0;
            flex-shrink: 0;
        }
        .cii-settings .cii-group-toggle i { transition: transform .25s; font-size: 0.85em; }
        .cii-settings .cii-group.collapsed .cii-group-toggle i { transform: rotate(-90deg); }
        .cii-settings .cii-group-icon { font-size: 1em; filter: drop-shadow(0 1px 2px rgba(255, 183, 213, 0.4)); }
        .cii-settings .cii-group-name {
            font-weight: 700;
            font-size: 0.94em;
            color: var(--cii-text);
            letter-spacing: 0.3px;
            padding: 2px 6px;
            border-radius: 6px;
            transition: background .15s;
            cursor: pointer;
        }
        .cii-settings .cii-group-name:hover { background: rgba(255, 255, 255, 0.08); }
        .cii-settings .cii-group-name.editing { display: none; }
        .cii-settings .cii-group-name-input {
            min-width: 120px;
            max-width: 260px;
            font-size: 0.92em !important;
            font-weight: 700;
            padding: 3px 8px !important;
            height: auto !important;
        }
        .cii-settings .cii-group-count {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 22px;
            height: 20px;
            padding: 0 8px;
            border-radius: 999px;
            background: rgba(255, 183, 213, 0.28);
            color: var(--cii-pink-deep);
            font-size: 0.72em;
            font-weight: 700;
            letter-spacing: 0.3px;
            flex-shrink: 0;
        }
        .cii-settings .cii-group-body { padding: 10px 10px 6px; animation: cii-fade-in .25s ease; }
        .cii-settings .cii-group.collapsed .cii-group-body { display: none; }
        .cii-settings .cii-group-empty {
            text-align: center;
            padding: 14px 8px;
            color: var(--cii-text-dim);
            font-size: 0.85em;
            opacity: 0.75;
        }

        .cii-settings .cii-rule {
            position: relative;
            border: 1.5px solid var(--cii-border);
            border-radius: var(--cii-radius-sm);
            margin: 8px 0;
            background: var(--cii-rule-bg);
            overflow: hidden;
            transition: border-color .2s, box-shadow .2s;
        }
        .cii-settings .cii-rule:hover {
            border-color: var(--cii-border-hover);
            box-shadow: 0 3px 16px rgba(255, 183, 213, 0.15);
        }
        .cii-settings .cii-rule::before {
            content: '';
            position: absolute;
            left: 0; top: 10px; bottom: 10px;
            width: 3px;
            border-radius: 0 3px 3px 0;
            background: linear-gradient(180deg, #ffb7d5, #c4a7ff);
            opacity: 0;
            transition: opacity .25s;
        }
        .cii-settings .cii-rule:hover::before { opacity: 1; }
        .cii-settings .cii-rule-head {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 10px;
            cursor: pointer;
            user-select: none;
            transition: background .15s;
        }
        .cii-settings .cii-rule-head:hover { background: var(--cii-rule-head-hover); }
        .cii-settings .cii-rule-toggle {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 24px; height: 24px;
            border: none;
            background: transparent;
            color: var(--cii-pink-deep);
            cursor: pointer;
            padding: 0;
            flex-shrink: 0;
        }
        .cii-settings .cii-rule-toggle i { transition: transform .25s; font-size: 0.85em; }
        .cii-settings .cii-rule.collapsed .cii-rule-toggle i { transform: rotate(-90deg); }
        .cii-settings .cii-rule-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 30px;
            height: 22px;
            padding: 0 8px;
            border-radius: 999px;
            background: linear-gradient(135deg, #ffb7d5 0%, #c4a7ff 100%);
            color: #fff;
            font-size: 0.75em;
            font-weight: 800;
            flex-shrink: 0;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
            box-shadow: 0 2px 6px rgba(255, 183, 213, 0.3);
        }
        .cii-settings .cii-rule-preview-text {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 0.85em;
            color: var(--cii-text-dim);
        }
        .cii-settings .cii-rule-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
        .cii-settings .cii-rule-body {
            padding: 4px 10px 10px;
            border-top: 1px dashed var(--cii-border);
            animation: cii-fade-in .25s ease;
        }
        .cii-settings .cii-rule.collapsed .cii-rule-body { display: none; }
        @keyframes cii-fade-in {
            from { opacity: 0; transform: translateY(-4px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .cii-settings .cii-image-area {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-top: 10px;
        }
        .cii-settings .cii-image-grid {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: flex-start;
        }
        .cii-settings .cii-image-item {
            position: relative;
            width: 72px;
            height: 72px;
            border-radius: 10px;
            overflow: hidden;
            border: 1.5px solid var(--cii-border);
            background: rgba(0, 0, 0, 0.15);
            transition: border-color .2s, box-shadow .2s;
            flex-shrink: 0;
        }
        .cii-settings .cii-image-item:hover {
            border-color: var(--cii-pink-deep);
            box-shadow: 0 3px 12px rgba(255, 183, 213, 0.25);
        }
        .cii-settings .cii-image-item img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
        }
        .cii-settings .cii-image-remove {
            position: absolute;
            top: 2px;
            right: 2px;
            width: 20px;
            height: 20px;
            border-radius: 50%;
            border: none;
            background: rgba(0, 0, 0, 0.65);
            color: #fff;
            cursor: pointer;
            font-size: 0.85em;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
            opacity: 0;
            transition: opacity .15s, background .15s;
            z-index: 2;
        }
        .cii-settings .cii-image-item:hover .cii-image-remove { opacity: 1; }
        .cii-settings .cii-image-remove:hover { background: rgba(255, 122, 156, 0.9); }

        .cii-settings .cii-image-add {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 2px;
            width: 72px;
            height: 72px;
            border: 1.5px dashed var(--cii-border);
            border-radius: 10px;
            background: rgba(255, 183, 213, 0.04);
            color: var(--cii-text-dim);
            font-size: 0.72em;
            cursor: pointer;
            flex-shrink: 0;
            transition: all .2s;
        }
        .cii-settings .cii-image-add:hover {
            border-color: var(--cii-pink-deep);
            background: rgba(255, 183, 213, 0.12);
            color: var(--cii-pink-deep);
        }
        .cii-settings .cii-image-add i { font-size: 1.2em; }

        .cii-settings .cii-image-src {
            font-size: 0.78em;
            word-break: break-all;
        }

        .cii-settings .cii-empty {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 24px 8px;
            color: var(--cii-text-dim);
            text-align: center;
        }
        .cii-settings .cii-empty-emoji {
            font-size: 2.2em;
            filter: drop-shadow(0 2px 4px rgba(255, 183, 213, 0.5));
            animation: cii-float 3s ease-in-out infinite;
        }
        @keyframes cii-float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-6px); }
        }
        .cii-settings .cii-empty small { font-size: 0.78em; opacity: 0.7; }

        .cii-settings .cii-rule.cii-uploading { opacity: 0.55; pointer-events: none; }

        /* ============ 聊天里插入的图片（支持多图切换） ============ */
        .cii-img-block {
            position: relative;
            display: inline-block;
            margin: 6px auto;
            max-width: 100%;
            line-height: 0;
            vertical-align: middle;
        }
        .cii-img-block .cii-inserted-image {
            display: block;
            max-width: 100%;
            height: auto;
            border-radius: 10px;
            cursor: default;
            transition: opacity 0.2s, transform 0.2s, box-shadow 0.2s;
            user-select: none;
        }
        .cii-img-block.cii-multi .cii-inserted-image {
            cursor: pointer;
        }
        .cii-img-block.cii-multi:hover .cii-inserted-image {
            transform: scale(1.01);
            box-shadow: 0 4px 16px rgba(255, 183, 213, 0.35);
        }
        .cii-img-block .cii-inserted-image.cii-switching {
            opacity: 0.4;
        }
        .cii-img-indicator {
            position: absolute;
            bottom: 6px;
            right: 6px;
            padding: 2px 8px;
            border-radius: 10px;
            background: rgba(0, 0, 0, 0.55);
            color: #fff;
            font-size: 0.7em;
            font-weight: 600;
            pointer-events: none;
            user-select: none;
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
            z-index: 2;
            line-height: 1.3;
            letter-spacing: 0.3px;
        }
        .cii-img-indicator::before {
            content: attr(data-text);
        }
    `;
    document.head.appendChild(style);
}

/* ================= 初始化 ================= */

async function loadSettings() {
    const s = getSettings();
    $('#cii-enabled').prop('checked', s.enabled !== false);
    $('#cii-maxwidth').val(s.maxWidth || 300);
    $('#cii-recent').val(Math.max(0, Math.floor(Number(s.recentMessages) || 0)));
    $('#cii-theme').val(s.themeMode || 'auto');
    $('#cii-compress').val(String(s.compressLevel || 0));
    renderRules();
    await refreshStats();
}

jQuery(async () => {
    injectStyles();

    const $container = $('#extensions_settings2').length
        ? $('#extensions_settings2')
        : $('#extensions_settings');

    $('#cii-settings').remove();
    $container.append(buildSettingsHtml());

    applyTheme(getSettings().themeMode);

    bindEvents();
    await loadSettings();
    initCollapseForRules();
    renderRules();
    startObserver();
    registerEvents();

    await ensureAllUrls();
    renderRules();

    setTimeout(() => {
        resetProcessing();
        scheduleProcess();
    }, 800);
});

window.addEventListener('beforeunload', () => {
    for (const url of urlCache.values()) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
    urlCache.clear();
});