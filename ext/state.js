'use strict';

// Shared by startup, cross-tab reconciliation and backup validation.
const QuietTabState = (() => {
  const PRESETS = { light: { accent: '#3b5bdb', bg: '#f6f5f2', text: '#1c1c1e' }, dark: { accent: '#8ea2ff', bg: '#121214', text: '#ececee' } };
  const DEFAULT = {
    mode: 'light', colors: { ...PRESETS.light },
    pattern: 'dots', patOp: 50, patSize: 22,
    generation: '', bgKey: 'bg', hasImg: false, overlay: true, dim: 10, blur: 0,
    canvas: true, pan: { x: 0, y: 0 },
    barPos: 'bottom', showBar: true, showClock: true, clockSize: 100,
    secAccent: true, shortcutsEnabled: true,
    h24: true, secs: true, showDate: true,
    board: [],
    links: [{ id: 1, name: 'Google', url: 'https://google.com' }, { id: 2, name: 'GitHub', url: 'https://github.com' }, { id: 3, name: 'YouTube', url: 'https://youtube.com' }, { id: 4, name: 'Gmail', url: 'https://mail.google.com' }]
  };

  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const bounded = (value, min, max, fallback) =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  const validId = id => typeof id === 'string' && /^[a-z0-9_-]{1,100}$/i.test(id)
    && id !== 'bg' && !id.startsWith('bg_') && !(id in Object.prototype) && id !== 'prototype';

  function normUrl(input) {
    if (typeof input !== 'string') return null;
    const value = input.trim();
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
    try {
      const url = new URL(/^[a-z][\w+.-]*:/i.test(value) && !/^[\w.-]+:\d+(?:[/?#]|$)/.test(value)
        ? value : 'https://' + value);
      return ['http:', 'https:', 'chrome:', 'edge:', 'chrome-extension:'].includes(url.protocol) && url.hostname
        ? url.href : null;
    } catch { return null; }
  }

  function distinct(list, parse) {
    const seen = new Set();
    const result = [];
    for (const raw of list) {
      if (!record(raw) || seen.has(raw.id)) continue;
      const entry = parse(raw);
      if (entry) { seen.add(entry.id); result.push(entry); }
    }
    return result;
  }

  function boardItem(raw) {
    if (!validId(raw.id) || !['img', 'note', 'todo'].includes(raw.type)) return null;
    const { id, type } = raw;
    const item = { id, type, pinned: raw.pinned === true };
    if (raw.u === 'px') item.u = 'px';
    const fallback = item.u ? 100 : 0.2;
    item.x = bounded(raw.x, -1e7, 1e7, fallback);
    item.y = bounded(raw.y, -1e7, 1e7, fallback);
    item.r = bounded(raw.r, -180, 180, 0);
    item.z = bounded(raw.z, 1, 1e6, 1);
    if (type === 'img') {
      item.w = bounded(raw.w, 100, 1200, 240);
      item.square = raw.square === true;
    } else {
      if (typeof raw.color === 'string' && /^[a-z]{1,16}$/.test(raw.color) && !(raw.color in Object.prototype)) item.color = raw.color;
      if (type === 'note') {
        item.text = typeof raw.text === 'string' ? raw.text : '';
        item.w = bounded(raw.w, 140, 1000, 230);
        item.scale = +(item.w / 230).toFixed(3);
      } else {
        item.title = typeof raw.title === 'string' ? raw.title : '';
        item.scale = bounded(raw.scale, 0.5, 3, bounded(raw.w, 130, 780, 260) / 260);
        item.w = Math.round(item.scale * 260);
        item.tasks = distinct(Array.isArray(raw.tasks) ? raw.tasks : [], task => validId(task.id)
          ? { id: task.id, text: typeof task.text === 'string' ? task.text : '', done: task.done === true } : null);
      }
    }
    return item;
  }

  function normalizeSettings(input) {
    const raw = record(input) ? input : {};
    const out = structuredClone(DEFAULT);
    out.mode = raw.mode === 'dark' ? 'dark' : 'light';
    out.colors = { ...PRESETS[out.mode] };
    for (const key of Object.keys(out.colors)) {
      if (typeof raw.colors?.[key] === 'string' && /^#[0-9a-f]{6}$/i.test(raw.colors[key])) out.colors[key] = raw.colors[key].toLowerCase();
    }
    for (const key of Object.keys(DEFAULT)) {
      if (typeof DEFAULT[key] === 'boolean' && typeof raw[key] === 'boolean') out[key] = raw[key];
    }
    for (const [key, min, max] of [['patOp', 5, 100], ['patSize', 12, 64], ['dim', 0, 80], ['blur', 0, 20], ['clockSize', 50, 160]]) {
      out[key] = bounded(raw[key], min, max, DEFAULT[key]);
    }
    if (['plain', 'dots', 'grid'].includes(raw.pattern)) out.pattern = raw.pattern;
    if (['bottom', 'top', 'left', 'right'].includes(raw.barPos)) out.barPos = raw.barPos;
    if (typeof raw.generation === 'string' && /^[a-z0-9-]{1,64}$/i.test(raw.generation)) out.generation = raw.generation;
    if (typeof raw.bgKey === 'string' && /^bg_[a-z0-9_-]{1,96}$/i.test(raw.bgKey)) out.bgKey = raw.bgKey;
    out.pan = { x: bounded(raw.pan?.x, -1e7, 1e7, 0), y: bounded(raw.pan?.y, -1e7, 1e7, 0) };
    out.board = distinct(Array.isArray(raw.board) ? raw.board : [], boardItem);
    out.links = distinct(Array.isArray(raw.links) ? raw.links : DEFAULT.links, link => {
      const url = normUrl(link.url);
      return url && (validId(link.id) || Number.isSafeInteger(link.id))
        ? { id: link.id, name: typeof link.name === 'string' ? link.name : '', url } : null;
    });
    return out;
  }

  // Apply the fields the local editor changed to the latest committed record.
  // A remote deletion wins over an edit to an item that no longer exists.
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function mergeValue(base, local, remote) {
    if (equal(local, base)) return remote;
    if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
      const original = new Map(base.map(item => [item.id, item]));
      const edited = new Map(local.map(item => [item.id, item]));
      const merged = new Map();
      for (const item of remote) {
        if (!original.has(item.id)) merged.set(item.id, item);
        else if (edited.has(item.id)) merged.set(item.id, mergeValue(original.get(item.id), edited.get(item.id), item));
      }
      for (const item of local) if (!original.has(item.id)) merged.set(item.id, item);
      const priorOrder = base.filter(item => edited.has(item.id)).map(item => item.id);
      const nextOrder = local.filter(item => original.has(item.id)).map(item => item.id);
      if (!equal(priorOrder, nextOrder) || local.some((item, i) => !original.has(item.id) && i < local.length - 1)) {
        return [...local.filter(item => merged.has(item.id)).map(item => merged.get(item.id)),
          ...[...merged.values()].filter(item => !edited.has(item.id))];
      }
      return [...merged.values()];
    }
    if (record(base) && record(local) && record(remote)) {
      const out = { ...remote };
      for (const key of Object.keys(local)) {
        if (!equal(base[key], local[key])) out[key] = mergeValue(base[key], local[key], remote[key]);
      }
      return out;
    }
    return local;
  }

  function imageDataBlob(value) {
    if (typeof value !== 'string') throw new Error('Missing image data');
    const comma = value.indexOf(',');
    if (comma < 0 || comma > 50) throw new Error('Invalid image data');
    const match = /^data:(image\/(?:jpeg|png|gif|webp|avif|bmp));base64$/i.exec(value.slice(0, comma));
    if (!match) throw new Error('Unsupported image data');
    const bytes = Uint8Array.from(atob(value.slice(comma + 1)), char => char.charCodeAt(0));
    if (!bytes.length) throw new Error('Empty image');
    return new Blob([bytes], { type: match[1].toLowerCase() });
  }

  return { DEFAULT, PRESETS, normalizeSettings, normUrl, mergeValue, imageDataBlob };
})();
