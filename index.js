// index.js —— SillyTavern 文字插图扩展 v1.5.0
// 新增：导出/导入 zip 备份、匹配文字是否消失、图片位置（after/start/end）
// 路径：public/scripts/extensions/third-party/chat-image-inserter/index.js

import { extension_settings } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../../script.js';

const EXT_NAME = 'chat-image-inserter';

const defaultSettings = {
    enabled: true,
    maxWidth: 300,
    rules: [],
    // rule: { id, pattern, isRegex, maxMatches, enabled,
    //         removeMatched, imagePosition, imageId, imageType, imageSrc }
};

const DB_NAME = 'cii-images-db';
const DB_VERSION = 3;
const STORE = 'images';

let processedHashes = new WeakMap();
let observer = null;
let debounceTimer = null;
let dbPromise = null;
let processing = false;
let pendingProcess = false;
const urlCache = new Map();

/* ================= 提示 ================= */

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

/* ================= IndexedDB ================= */

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE);
            }
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
        let count = 0;
        let bytes = 0;
        req.onsuccess = e => {
            const cursor = e.target.result;
            if (cursor) {
                count++;
                const blob = cursor.value?.blob;
                if (blob && typeof blob.size === 'number') bytes += blob.size;
                cursor.continue();
            } else {
                resolve({ count, bytes });
            }
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
    for (const rule of s.rules) {
        if ('imageFile' in rule) delete rule.imageFile;
        if (typeof rule.maxMatches !== 'number') rule.maxMatches = 1;
        if (typeof rule.removeMatched !== 'boolean') rule.removeMatched = false;
        if (!rule.imagePosition) rule.imagePosition = 'after';
        if (typeof rule.enabled !== 'boolean') rule.enabled = true;
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

function saveSettings() {
    saveSettingsDebounced();
}

function resetProcessing() {
    processedHashes = new WeakMap();
}

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

function ruleHasImageReady(rule) {
    if (rule.imageSrc) return true;
    return !!rule.imageId && urlCache.has(rule.imageId);
}

function getRuleCachedUrl(rule) {
    if (rule.imageSrc) return rule.imageSrc;
    return rule.imageId ? urlCache.get(rule.imageId) : null;
}

async function getRuleUrl(rule) {
    if (rule.imageSrc) return rule.imageSrc;
    if (!rule.imageId) return null;
    return await ensureUrlFromIndexedDB(rule.imageId);
}

async function ensureAllUrls() {
    const s = getSettings();
    for (const rule of s.rules) {
        if (rule.imageId && !urlCache.has(rule.imageId)) {
            await ensureUrlFromIndexedDB(rule.imageId);
        }
    }
}

/* ================= 匹配与插入 ================= */

function findMatches(text, rule) {
    const ranges = [];
    const pattern = rule.pattern;
    if (!pattern) return ranges;

    if (rule.isRegex) {
        try {
            const re = new RegExp(pattern, 'gi');
            let m;
            while ((m = re.exec(text)) !== null) {
                if (m[0].length === 0) {
                    re.lastIndex++;
                    continue;
                }
                ranges.push({ start: m.index, end: m.index + m[0].length });
            }
        } catch {
            /* 正则非法时忽略 */
        }
    } else {
        let idx = text.indexOf(pattern);
        while (idx !== -1) {
            ranges.push({ start: idx, end: idx + pattern.length });
            idx = text.indexOf(pattern, idx + pattern.length);
        }
    }
    return ranges;
}

function createImageElement(rule) {
    const s = getSettings();
    const src = getRuleCachedUrl(rule);
    if (!src) return null;
    const img = document.createElement('img');
    img.className = 'cii-inserted-image';
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    img.style.maxWidth = (s.maxWidth || 300) + 'px';
    img.style.width = 'auto';
    img.style.height = 'auto';
    img.style.display = 'block';
    img.style.margin = '6px auto';
    img.style.borderRadius = '8px';
    return img;
}

function applyRulesToElement(container) {
    const s = getSettings();

    // 清空旧图片并合并文本节点
    container.querySelectorAll('img.cii-inserted-image').forEach(img => img.remove());
    container.normalize();

    const rules = s.rules.filter(
        r => r.enabled !== false && r.pattern && ruleHasImageReady(r),
    );
    if (!rules.length) return;

    // 收集文本节点
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

    // 每条规则收集匹配，按文档顺序排序后按 maxMatches 限流
    const allMatches = [];
    for (const rule of rules) {
        const ruleMatches = [];
        textNodes.forEach((node, idx) => {
            for (const r of findMatches(node.nodeValue, rule)) {
                ruleMatches.push({
                    node,
                    nodeIdx: idx,
                    start: r.start,
                    end: r.end,
                    rule,
                });
            }
        });
        ruleMatches.sort((a, b) => a.nodeIdx - b.nodeIdx || a.start - b.start);
        const max = getRuleMaxMatches(rule);
        const limited = max > 0 ? ruleMatches.slice(0, max) : ruleMatches;
        allMatches.push(...limited);
    }
    if (!allMatches.length) return;

    // 按 node 分组
    const byNode = new Map();
    for (const m of allMatches) {
        if (!byNode.has(m.node)) byNode.set(m.node, []);
        byNode.get(m.node).push(m);
    }

    const startImages = []; // { rule }
    const endImages = [];   // { rule }

    for (const [node, list] of byNode) {
        // 从右往左处理，避免索引偏移
        list.sort((a, b) => b.start - a.start);

        // 过滤同一节点内重叠匹配
        const filtered = [];
        let lastStart = Infinity;
        for (const m of list) {
            if (m.end <= lastStart) {
                filtered.push(m);
                lastStart = m.start;
            }
        }

        const parent = node.parentNode;
        if (!parent) continue;

        let current = node;

        for (const m of filtered) {
            const pos = m.rule.imagePosition || 'after';

            if (pos === 'start' || pos === 'end') {
                // 全文开头 / 结尾：只处理文字删除（如需），图片稍后统一插入
                if (m.rule.removeMatched) {
                    try {
                        if (m.end > current.nodeValue.length) continue;
                        current.nodeValue =
                            current.nodeValue.slice(0, m.start) +
                            current.nodeValue.slice(m.end);
                    } catch (e) {
                        console.warn('[CII] 删除匹配文字失败', e);
                    }
                }
                if (pos === 'start') startImages.push({ rule: m.rule });
                else endImages.push({ rule: m.rule });
                continue;
            }

            // after 位置：拆分节点，在中间插入图片
            try {
                if (m.end > current.nodeValue.length) continue;
                current.splitText(m.end);
                const mid = current.splitText(m.start);
                const img = createImageElement(m.rule);
                if (!img) continue;

                if (m.rule.removeMatched) {
                    // 文字消失，图片替代
                    parent.insertBefore(img, mid.nextSibling);
                    mid.remove();
                } else {
                    // 保留文字，图片插在文字后面
                    parent.insertBefore(img, mid.nextSibling);
                }
            } catch (e) {
                console.warn('[CII] 插入图片失败', e);
            }
        }
    }

    // 插入全文开头图片
    if (startImages.length) {
        const frag = document.createDocumentFragment();
        for (const { rule } of startImages) {
            const img = createImageElement(rule);
            if (img) frag.appendChild(img);
        }
        container.insertBefore(frag, container.firstChild);
    }

    // 插入全文结尾图片
    for (const { rule } of endImages) {
        const img = createImageElement(rule);
        if (img) container.appendChild(img);
    }
}

async function processAllMessages() {
    if (processing) {
        pendingProcess = true;
        return;
    }
    processing = true;
    try {
        const s = getSettings();

        if (!s.enabled) {
            document.querySelectorAll('#chat .mes_text img.cii-inserted-image').forEach(img => {
                const parent = img.parentNode;
                img.remove();
                parent?.normalize?.();
            });
            return;
        }

        await ensureAllUrls();

        document.querySelectorAll('#chat .mes_text').forEach(el => {
            const text = el.textContent || '';
            const hash = simpleHash(text);
            if (processedHashes.get(el) === hash) return;
            processedHashes.set(el, hash);
            applyRulesToElement(el);
        });
    } finally {
        processing = false;
        if (pendingProcess) {
            pendingProcess = false;
            processAllMessages();
        }
    }
}

function scheduleProcess() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => processAllMessages(), 120);
}

/* ================= 监听 ================= */

function startObserver() {
    if (observer) return;
    const chat = document.getElementById('chat');
    if (!chat) {
        setTimeout(startObserver, 1000);
        return;
    }
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

/* ================= 删除单条规则关联图片 ================= */

async function removeRuleImageRefs(rule) {
    const s = getSettings();
    if (rule.imageId) {
        const stillUsed = s.rules.some(r => r.id !== rule.id && r.imageId === rule.imageId);
        if (!stillUsed) {
            try { await deleteImage(rule.imageId); } catch { /* ignore */ }
            releaseImageUrl(rule.imageId);
        }
    }
    rule.imageId = '';
    rule.imageType = '';
    rule.imageSrc = '';
}

/* ================= 上传 ================= */

async function handleUpload(file, $rule) {
    const ruleId = String($rule.attr('data-id'));
    const s = getSettings();
    const rule = s.rules.find(r => String(r.id) === ruleId);
    if (!rule) throw new Error('规则不存在');

    const buffer = await file.arrayBuffer();
    const blob = new Blob([buffer], { type: file.type || 'image/png' });

    await removeRuleImageRefs(rule);

    const imageId = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await putImage(imageId, blob, { name: file.name, type: file.type });

    rule.imageId = imageId;
    rule.imageType = file.type;
    const url = URL.createObjectURL(blob);
    urlCache.set(imageId, url);

    $rule.find('.cii-image-src').text(file.name);
    $rule.find('.cii-preview').attr('src', url);
    $rule.find('.cii-image-preview').addClass('has-image');

    saveSettings();
    resetProcessing();
    scheduleProcess();
    await refreshStats();
    return { msg: '已保存到浏览器 IndexedDB' };
}

/* ================= 预览 ================= */

async function refreshPreview($rule, rule) {
    const $src = $rule.find('.cii-image-src');
    const $preview = $rule.find('.cii-preview');
    const $wrap = $rule.find('.cii-image-preview');

    if (!rule.imageSrc && !rule.imageId) {
        $src.text('');
        $preview.attr('src', '');
        $wrap.removeClass('has-image');
        return;
    }

    const url = await getRuleUrl(rule);
    if (url) {
        $src.text(rule.imageId ? '（已缓存）' : rule.imageSrc);
        $preview.attr('src', url);
        $wrap.addClass('has-image');
    } else {
        $src.text('（图片不可用，请重新上传）');
        $preview.attr('src', '');
        $wrap.removeClass('has-image');
    }
}

/* ================= 存储统计 ================= */

async function refreshStats() {
    try {
        const { count, bytes } = await getStorageStats();
        $('#cii-stat-count').text(count);
        $('#cii-stat-size').text(formatBytes(bytes));
        $('#cii-clear-all')
            .prop('disabled', count === 0)
            .toggleClass('cii-disabled', count === 0);
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
                if (window.JSZip) {
                    clearInterval(timer);
                    resolve(window.JSZip);
                }
            }, 100);
            setTimeout(() => {
                clearInterval(timer);
                reject(new Error('JSZip 加载超时'));
            }, 12000);
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
        script.dataset.ciiJszip = '1';
        script.onload = () => {
            if (window.JSZip) resolve(window.JSZip);
            else reject(new Error('JSZip 未暴露到 window'));
        };
        script.onerror = () => reject(new Error('JSZip 加载失败（网络或 CSP 限制）'));
        document.head.appendChild(script);
        setTimeout(() => reject(new Error('JSZip 加载超时')), 12000);
    });
}

function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        try { document.body.removeChild(a); } catch { /* ignore */ }
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }, 1500);
}

async function exportData() {
    let JSZip;
    try {
        JSZip = await ensureJSZip();
    } catch (e) {
        notify('无法加载压缩库：' + (e?.message || e), 'error');
        return;
    }

    const s = getSettings();
    const zip = new JSZip();

    const config = {
        format: 'chat-image-inserter',
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: {
            enabled: s.enabled,
            maxWidth: s.maxWidth,
        },
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
            imageFile: null,
        };
        if (rule.imageId) {
            const rec = await getImage(rule.imageId);
            if (rec && rec.blob) {
                const ext = guessExt(rec.blob.type || rule.imageType);
                const filename = `images/rule_${i}.${ext}`;
                zip.file(filename, rec.blob);
                exportRule.imageFile = filename;
                imageCount++;
            }
        }
        config.rules.push(exportRule);
    }

    if (config.rules.length === 0) {
        notify('当前没有规则可导出', 'warning');
        return;
    }

    zip.file('config.json', JSON.stringify(config, null, 2));

    let blob;
    try {
        blob = await zip.generateAsync({
            type: 'blob',
            compression: 'STORE', // 图片本身已压缩，用 STORE 更快
            compressionOptions: { level: 0 },
        });
    } catch (e) {
        notify('打包失败：' + (e?.message || e), 'error');
        return;
    }

    const ts = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const filename = `chat-image-inserter_${stamp}.zip`;
    triggerDownload(blob, filename);
    notify(`已导出 ${config.rules.length} 条规则、${imageCount} 张图片（${filename}）`, 'success');
}

async function importData(file) {
    let JSZip;
    try {
        JSZip = await ensureJSZip();
    } catch (e) {
        notify('无法加载压缩库：' + (e?.message || e), 'error');
        return;
    }

    let zip;
    try {
        zip = await JSZip.loadAsync(file);
    } catch (e) {
        notify('无法解析 zip：' + (e?.message || e), 'error');
        return;
    }

    const configFile = zip.file('config.json');
    if (!configFile) {
        notify('导入包缺少 config.json，可能不是本插件导出的文件', 'error');
        return;
    }

    let config;
    try {
        config = JSON.parse(await configFile.async('string'));
    } catch (e) {
        notify('config.json 解析失败：' + (e?.message || e), 'error');
        return;
    }

    if (!config || !Array.isArray(config.rules)) {
        notify('配置格式错误：缺少 rules 数组', 'error');
        return;
    }

    if (config.rules.length === 0) {
        notify('导入包中没有规则', 'warning');
        return;
    }

    const s = getSettings();
    const newRules = [];
    let imageLoaded = 0;

    for (let i = 0; i < config.rules.length; i++) {
        const r = config.rules[i];
        const rule = {
            id: 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + i,
            pattern: typeof r.pattern === 'string' ? r.pattern : '',
            isRegex: !!r.isRegex,
            maxMatches: typeof r.maxMatches === 'number' ? Math.max(0, Math.floor(r.maxMatches)) : 1,
            enabled: r.enabled !== false,
            removeMatched: !!r.removeMatched,
            imagePosition: ['after', 'start', 'end'].includes(r.imagePosition) ? r.imagePosition : 'after',
            imageId: '',
            imageType: '',
            imageSrc: '',
        };

        if (r.imageFile) {
            const imgFile = zip.file(r.imageFile);
            if (imgFile) {
                try {
                    const blob = await imgFile.async('blob');
                    const typedBlob = blob.type ? blob : new Blob([blob], { type: 'image/png' });
                    const imageId = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + i;
                    await putImage(imageId, typedBlob, { name: r.imageFile, type: typedBlob.type });
                    const url = URL.createObjectURL(typedBlob);
                    urlCache.set(imageId, url);
                    rule.imageId = imageId;
                    rule.imageType = typedBlob.type;
                    imageLoaded++;
                } catch (e) {
                    console.warn('[CII] 图片导入失败', r.imageFile, e);
                }
            }
        }

        newRules.push(rule);
    }

    const mode = window.confirm(
        `即将导入 ${newRules.length} 条规则、${imageLoaded} 张图片。\n\n` +
        `点「确定」：追加到现有规则（原有规则保留）\n` +
        `点「取消」：放弃本次导入`,
    );
    if (!mode) {
        // 回滚已经写入的图片
        for (const rule of newRules) {
            if (rule.imageId) {
                try { await deleteImage(rule.imageId); } catch { /* ignore */ }
                releaseImageUrl(rule.imageId);
            }
        }
        return;
    }

    s.rules.push(...newRules);
    saveSettings();

    await ensureAllUrls();
    renderRules();
    resetProcessing();
    scheduleProcess();
    await refreshStats();

    notify(`已导入 ${newRules.length} 条规则、${imageLoaded} 张图片`, 'success');
}

/* ================= 清除全部图片 ================= */

async function clearAllCachedImages() {
    let stats;
    try {
        stats = await getStorageStats();
    } catch (e) {
        notify('读取存储统计失败：' + (e?.message || e), 'error');
        return;
    }

    if (stats.count === 0) {
        notify('当前没有缓存的图片', 'info');
        return;
    }

    const ok = window.confirm(
        `确定要清除全部 ${stats.count} 张缓存图片（共 ${formatBytes(stats.bytes)}）吗？\n\n` +
        `• 规则、匹配文字、启用状态都会保留\n` +
        `• 但每张图片需要重新上传\n` +
        `• 此操作不可撤销`,
    );
    if (!ok) return;

    const s = getSettings();
    for (const rule of s.rules) {
        rule.imageId = '';
        rule.imageType = '';
        rule.imageSrc = '';
    }
    saveSettings();

    try {
        await clearAllImagesFromDb();
    } catch (e) {
        notify('清空 IndexedDB 失败：' + (e?.message || e), 'error');
        return;
    }

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

/* ================= 设置界面 ================= */

function buildRuleHtml(rule, index) {
    const $el = $(`
        <div class="cii-rule" data-id="${rule.id}">
            <div class="cii-rule-head">
                <div class="cii-rule-title">
                    <span class="cii-rule-badge">#${index + 1}</span>
                    <span class="cii-rule-name">匹配规则</span>
                </div>
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

            <div class="cii-field">
                <label class="cii-label">匹配文字</label>
                <input type="text" class="text_pole cii-pattern" placeholder="例如：*微笑*  或   ^.+$">
                <label class="cii-check" title="按正则表达式匹配">
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
                <label class="cii-check cii-check-wide" title="匹配到的文字会被删除，只显示图片">
                    <input type="checkbox" class="cii-remove">
                    <span>匹配文字消失（只显示图片）</span>
                </label>
            </div>

            <div class="cii-image-area">
                <div class="cii-image-preview">
                    <img class="cii-preview" alt="">
                    <div class="cii-preview-empty">
                        <i class="fa-regular fa-image"></i>
                        <span>暂无图片</span>
                    </div>
                </div>
                <div class="cii-image-actions">
                    <label class="cii-btn cii-btn-primary">
                        <i class="fa-solid fa-upload"></i>
                        <span>上传图片</span>
                        <input type="file" class="cii-upload" accept="image/*" hidden>
                    </label>
                    <button type="button" class="cii-btn cii-btn-secondary cii-clear-image">
                        <i class="fa-solid fa-eraser"></i>
                        <span>清除图片</span>
                    </button>
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

function renderRules() {
    const s = getSettings();
    const $rules = $('#cii-rules').empty();
    if (!s.rules.length) {
        $rules.append(`
            <div class="cii-empty">
                <i class="fa-regular fa-folder-open"></i>
                <span>还没有规则</span>
                <small>点击下方「添加规则」开始</small>
            </div>
        `);
        return;
    }
    s.rules.forEach((rule, i) => $rules.append(buildRuleHtml(rule, i)));
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

function buildSettingsHtml() {
    return `
        <div id="cii-settings" class="cii-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-wand-magic-sparkles cii-accent-icon"></i> 文字插图 (Chat Image Inserter)</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">

                    <div class="cii-card">
                        <div class="cii-card-title"><i class="fa-solid fa-sliders"></i> 常规设置</div>
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
                    </div>

                    <div class="cii-card">
                        <div class="cii-card-title"><i class="fa-solid fa-database"></i> 存储管理</div>
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
                        <div class="cii-dim cii-tiny">图片存储在浏览器 IndexedDB 中；卸载或清除酒馆数据会一并删除，请自行保留原图备份。</div>
                    </div>

                    <div class="cii-card">
                        <div class="cii-card-title"><i class="fa-solid fa-file-zipper"></i> 数据备份与分享</div>
                        <div class="cii-row">
                            <button type="button" class="cii-btn cii-btn-primary" id="cii-export">
                                <i class="fa-solid fa-download"></i>
                                <span>导出规则与图片</span>
                            </button>
                            <label class="cii-btn cii-btn-secondary">
                                <i class="fa-solid fa-upload"></i>
                                <span>导入分享包</span>
                                <input type="file" id="cii-import" accept=".zip,application/zip" hidden>
                            </label>
                        </div>
                        <div class="cii-dim cii-tiny">
                            导出的 zip 会下载到浏览器「下载」文件夹（手机同样可用），内含 <code>config.json</code> 和图片；<br>
                            他人导入后即可获得完全相同的规则与图片。
                        </div>
                    </div>

                    <div class="cii-card cii-card-rules">
                        <div class="cii-card-title"><i class="fa-solid fa-list-check"></i> 匹配规则</div>
                        <div id="cii-rules"></div>
                        <button type="button" class="cii-btn cii-btn-add" id="cii-add-rule">
                            <i class="fa-solid fa-plus"></i>
                            <span>添加规则</span>
                        </button>
                    </div>

                </div>
            </div>
        </div>
    `;
}

/* ================= 事件绑定 ================= */

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
        .off('click.cii', '#cii-clear-all')
        .on('click.cii', '#cii-clear-all', function (e) {
            e.preventDefault();
            clearAllCachedImages();
        });

    $(document)
        .off('click.cii', '#cii-export')
        .on('click.cii', '#cii-export', function (e) {
            e.preventDefault();
            exportData();
        });

    $(document)
        .off('change.cii', '#cii-import')
        .on('change.cii', '#cii-import', async function () {
            const file = this.files && this.files[0];
            this.value = '';
            if (!file) return;
            try {
                await importData(file);
            } catch (e) {
                console.error('[CII] 导入失败', e);
                notify('导入失败：' + (e?.message || e), 'error');
            }
        });

    $(document)
        .off('click.cii', '#cii-add-rule')
        .on('click.cii', '#cii-add-rule', function (e) {
            e.preventDefault();
            const s = getSettings();
            s.rules.push({
                id: 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                pattern: '',
                isRegex: false,
                imageId: '',
                imageType: '',
                imageSrc: '',
                maxMatches: 1,
                enabled: true,
                removeMatched: false,
                imagePosition: 'after',
            });
            saveSettings();
            renderRules();
        });

    $('#cii-rules')
        .off('input.cii', '.cii-pattern')
        .on('input.cii', '.cii-pattern', function () {
            updateRule(String($(this).closest('.cii-rule').attr('data-id')), {
                pattern: $(this).val(),
            });
        });

    $('#cii-rules')
        .off('change.cii', '.cii-regex')
        .on('change.cii', '.cii-regex', function () {
            updateRule(String($(this).closest('.cii-rule').attr('data-id')), {
                isRegex: this.checked,
            });
        });

    $('#cii-rules')
        .off('change.cii', '.cii-rule-enabled')
        .on('change.cii', '.cii-rule-enabled', function () {
            updateRule(String($(this).closest('.cii-rule').attr('data-id')), {
                enabled: this.checked,
            });
        });

    $('#cii-rules')
        .off('input.cii', '.cii-maxmatches')
        .on('input.cii', '.cii-maxmatches', function () {
            const v = Math.max(0, Math.floor(Number(this.value) || 0));
            updateRule(String($(this).closest('.cii-rule').attr('data-id')), {
                maxMatches: v,
            });
        });

    $('#cii-rules')
        .off('change.cii', '.cii-imagepos')
        .on('change.cii', '.cii-imagepos', function () {
            updateRule(String($(this).closest('.cii-rule').attr('data-id')), {
                imagePosition: this.value,
            });
        });

    $('#cii-rules')
        .off('change.cii', '.cii-remove')
        .on('change.cii', '.cii-remove', function () {
            updateRule(String($(this).closest('.cii-rule').attr('data-id')), {
                removeMatched: this.checked,
            });
        });

    $('#cii-rules')
        .off('click.cii', '.cii-delete-rule')
        .on('click.cii', '.cii-delete-rule', async function (e) {
            e.preventDefault();
            const $rule = $(this).closest('.cii-rule');
            const id = String($rule.attr('data-id'));
            const s = getSettings();
            const rule = s.rules.find(r => String(r.id) === id);
            if (!rule) return;
            if (!window.confirm('确定删除这条规则吗？')) return;
            await removeRuleImageRefs(rule);
            s.rules = s.rules.filter(r => String(r.id) !== id);
            saveSettings();
            renderRules();
            resetProcessing();
            scheduleProcess();
            await refreshStats();
        });

    $('#cii-rules')
        .off('click.cii', '.cii-clear-image')
        .on('click.cii', '.cii-clear-image', async function (e) {
            e.preventDefault();
            const $rule = $(this).closest('.cii-rule');
            const id = String($rule.attr('data-id'));
            const s = getSettings();
            const rule = s.rules.find(r => String(r.id) === id);
            if (!rule) return;

            await removeRuleImageRefs(rule);
            saveSettings();

            $rule.find('.cii-image-src').text('');
            $rule.find('.cii-preview').attr('src', '');
            $rule.find('.cii-image-preview').removeClass('has-image');
            resetProcessing();
            scheduleProcess();
            await refreshStats();
        });

    $('#cii-rules')
        .off('change.cii', '.cii-upload')
        .on('change.cii', '.cii-upload', async function () {
            const file = this.files && this.files[0];
            if (!file) return;
            const $rule = $(this).closest('.cii-rule');
            try {
                $rule.addClass('cii-uploading');
                await handleUpload(file, $rule);
                notify('图片已保存到浏览器本地', 'success');
            } catch (e) {
                console.error('[CII] 保存失败', e);
                notify('图片保存失败: ' + (e?.message || e), 'error');
            } finally {
                $rule.removeClass('cii-uploading');
                this.value = '';
            }
        });
}

/* ================= 样式 ================= */

function injectStyles() {
    if (document.getElementById('cii-styles')) return;
    const style = document.createElement('style');
    style.id = 'cii-styles';
    style.textContent = `
        .cii-settings {
            --cii-radius: 10px;
            --cii-gap: 10px;
            --cii-card-bg: var(--SmartThemeBlurTintColor, rgba(28, 28, 38, 0.55));
            --cii-border: var(--SmartThemeBorderColor, rgba(255,255,255,0.12));
            --cii-text: var(--SmartThemeBodyColor, #ddd);
            --cii-text-dim: var(--SmartThemeEmColor, rgba(200,200,220,0.65));
            --cii-accent: var(--SmartThemeQuoteColor, #7aa2f7);
            --cii-danger: #f7768e;
            padding: 4px 0;
            color: var(--cii-text);
        }

        .cii-settings .cii-accent-icon { color: var(--cii-accent); margin-right: 4px; }

        .cii-settings .cii-card {
            background: var(--cii-card-bg);
            border: 1px solid var(--cii-border);
            border-radius: var(--cii-radius);
            padding: 10px 12px;
            margin: 8px 0;
            box-shadow: 0 2px 8px rgba(0,0,0,0.12);
        }
        .cii-settings .cii-card-title {
            font-weight: 600;
            font-size: 0.92em;
            margin-bottom: 8px;
            color: var(--cii-text);
            display: flex;
            align-items: center;
            gap: 6px;
            opacity: 0.9;
        }
        .cii-settings .cii-card-title i { color: var(--cii-accent); }

        .cii-settings .cii-row {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }
        .cii-settings .cii-spacer { flex: 1; }

        .cii-settings .cii-label {
            font-size: 0.85em;
            color: var(--cii-text-dim);
            min-width: 60px;
            flex-shrink: 0;
        }
        .cii-settings .cii-field {
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 6px 0;
        }
        .cii-settings .cii-field-hint {
            font-size: 0.82em;
            color: var(--cii-text-dim);
        }
        .cii-settings .cii-num { width: 82px !important; }
        .cii-settings .cii-unit { color: var(--cii-text-dim); }

        .cii-settings .text_pole,
        .cii-settings select.text_pole {
            border-radius: 6px;
            transition: border-color .15s, box-shadow .15s;
        }
        .cii-settings .text_pole:focus {
            border-color: var(--cii-accent);
            box-shadow: 0 0 0 2px rgba(122,162,247,0.15);
            outline: none;
        }

        .cii-settings .cii-switch {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            user-select: none;
        }
        .cii-settings .cii-switch input { display: none; }
        .cii-settings .cii-switch-track {
            position: relative;
            display: inline-block;
            width: 38px;
            height: 20px;
            border-radius: 999px;
            background: rgba(150,150,160,0.35);
            transition: background .2s;
            flex-shrink: 0;
        }
        .cii-settings .cii-switch-thumb {
            position: absolute;
            top: 2px; left: 2px;
            width: 16px; height: 16px;
            border-radius: 50%;
            background: #fff;
            box-shadow: 0 1px 3px rgba(0,0,0,0.4);
            transition: transform .2s;
        }
        .cii-settings .cii-switch input:checked + .cii-switch-track {
            background: var(--cii-accent);
        }
        .cii-settings .cii-switch input:checked + .cii-switch-track .cii-switch-thumb {
            transform: translateX(18px);
        }
        .cii-settings .cii-switch-label {
            font-size: 0.9em;
            color: var(--cii-text);
        }
        .cii-settings .cii-inline-label {
            font-size: 0.85em;
            color: var(--cii-text-dim);
        }

        .cii-settings .cii-check {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 0.85em;
            color: var(--cii-text-dim);
            cursor: pointer;
            white-space: nowrap;
        }
        .cii-settings .cii-check-wide {
            font-size: 0.86em;
            color: var(--cii-text);
            padding: 2px 0;
        }

        .cii-settings .cii-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 7px;
            border: 1px solid var(--cii-border);
            background: transparent;
            color: var(--cii-text);
            font-size: 0.88em;
            cursor: pointer;
            transition: transform .12s, background .15s, border-color .15s, box-shadow .15s;
            white-space: nowrap;
        }
        .cii-settings .cii-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 3px 8px rgba(0,0,0,0.18);
        }
        .cii-settings .cii-btn:active { transform: translateY(0); }

        .cii-settings .cii-btn-primary {
            background: linear-gradient(180deg, var(--cii-accent), color-mix(in srgb, var(--cii-accent) 75%, black));
            border-color: transparent;
            color: #fff;
        }
        .cii-settings .cii-btn-primary:hover {
            box-shadow: 0 4px 12px rgba(122,162,247,0.35);
        }
        .cii-settings .cii-btn-secondary:hover {
            border-color: var(--cii-accent);
            color: var(--cii-accent);
        }
        .cii-settings .cii-btn-danger {
            color: var(--cii-danger);
            border-color: color-mix(in srgb, var(--cii-danger) 50%, transparent);
        }
        .cii-settings .cii-btn-danger:hover {
            background: color-mix(in srgb, var(--cii-danger) 15%, transparent);
            border-color: var(--cii-danger);
        }
        .cii-settings .cii-btn.cii-disabled,
        .cii-settings .cii-btn:disabled {
            opacity: 0.4;
            pointer-events: none;
            box-shadow: none;
            transform: none;
        }
        .cii-settings .cii-btn-add {
            width: 100%;
            justify-content: center;
            margin-top: 6px;
            border-style: dashed;
            color: var(--cii-accent);
            border-color: color-mix(in srgb, var(--cii-accent) 50%, transparent);
        }
        .cii-settings .cii-btn-add:hover {
            background: color-mix(in srgb, var(--cii-accent) 12%, transparent);
            border-style: solid;
        }

        .cii-settings .cii-icon-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 30px; height: 30px;
            border-radius: 7px;
            border: 1px solid var(--cii-border);
            background: transparent;
            color: var(--cii-text-dim);
            cursor: pointer;
            transition: all .15s;
            padding: 0;
        }
        .cii-settings .cii-icon-btn:hover {
            background: rgba(255,255,255,0.06);
            color: var(--cii-text);
        }
        .cii-settings .cii-icon-btn.cii-danger:hover {
            background: color-mix(in srgb, var(--cii-danger) 15%, transparent);
            color: var(--cii-danger);
            border-color: var(--cii-danger);
        }

        .cii-settings .cii-stat-row {
            display: flex;
            align-items: center;
            gap: 16px;
            flex-wrap: wrap;
        }
        .cii-settings .cii-stat {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        .cii-settings .cii-stat-value {
            font-weight: 700;
            font-size: 1.15em;
            color: var(--cii-accent);
        }
        .cii-settings .cii-stat-label {
            font-size: 0.78em;
            color: var(--cii-text-dim);
        }
        .cii-settings .cii-dim { color: var(--cii-text-dim); }
        .cii-settings .cii-tiny { font-size: 0.78em; margin-top: 6px; line-height: 1.5; }
        .cii-settings code {
            background: rgba(255,255,255,0.08);
            padding: 1px 4px;
            border-radius: 3px;
            font-size: 0.92em;
        }

        .cii-settings .cii-card-rules { padding-bottom: 8px; }
        .cii-settings .cii-rule {
            border: 1px solid var(--cii-border);
            border-radius: 8px;
            padding: 10px;
            margin: 8px 0;
            background: rgba(0,0,0,0.08);
            transition: border-color .15s, box-shadow .15s;
        }
        .cii-settings .cii-rule:hover {
            border-color: color-mix(in srgb, var(--cii-accent) 40%, var(--cii-border));
            box-shadow: 0 2px 10px rgba(0,0,0,0.15);
        }
        .cii-settings .cii-rule-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 6px;
            padding-bottom: 6px;
            border-bottom: 1px dashed var(--cii-border);
        }
        .cii-settings .cii-rule-title {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.9em;
        }
        .cii-settings .cii-rule-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 28px;
            height: 22px;
            padding: 0 6px;
            border-radius: 6px;
            background: color-mix(in srgb, var(--cii-accent) 20%, transparent);
            color: var(--cii-accent);
            font-size: 0.8em;
            font-weight: 600;
        }
        .cii-settings .cii-rule-name {
            color: var(--cii-text-dim);
        }
        .cii-settings .cii-rule-actions {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .cii-settings .cii-image-area {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-top: 8px;
            flex-wrap: wrap;
        }
        .cii-settings .cii-image-preview {
            position: relative;
            width: 84px;
            height: 84px;
            flex-shrink: 0;
            border: 1px dashed var(--cii-border);
            border-radius: 8px;
            background: rgba(0,0,0,0.15);
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .cii-settings .cii-image-preview .cii-preview {
            max-width: 100%;
            max-height: 100%;
            display: none;
            object-fit: cover;
        }
        .cii-settings .cii-image-preview.has-image { border-style: solid; }
        .cii-settings .cii-image-preview.has-image .cii-preview { display: block; }
        .cii-settings .cii-image-preview.has-image .cii-preview-empty { display: none; }

        .cii-settings .cii-preview-empty {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 2px;
            color: var(--cii-text-dim);
            font-size: 0.72em;
        }
        .cii-settings .cii-preview-empty i { font-size: 1.4em; opacity: 0.6; }

        .cii-settings .cii-image-actions {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px;
            flex: 1;
            min-width: 200px;
        }
        .cii-settings .cii-image-src {
            font-size: 0.78em;
            flex-basis: 100%;
            word-break: break-all;
        }

        .cii-settings .cii-empty {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 4px;
            padding: 16px 8px;
            color: var(--cii-text-dim);
            text-align: center;
        }
        .cii-settings .cii-empty i { font-size: 1.6em; opacity: 0.55; }
        .cii-settings .cii-empty small { font-size: 0.78em; opacity: 0.7; }

        .cii-settings .cii-rule.cii-uploading { opacity: 0.55; pointer-events: none; }

        .cii-inserted-image { transition: opacity 0.2s; }
    `;
    document.head.appendChild(style);
}

/* ================= 初始化 ================= */

async function loadSettings() {
    const s = getSettings();
    $('#cii-enabled').prop('checked', s.enabled !== false);
    $('#cii-maxwidth').val(s.maxWidth || 300);
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

    bindEvents();
    await loadSettings();
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