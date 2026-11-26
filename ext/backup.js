// The portable v2 format always uses "bg" for the background. Runtime blob
// keys belong to one installation and are assigned afresh on restore.
const QuietTabBackup = (() => {
  const limit = 128 * 1024 * 1024;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  function imageKeys(settings) {
    return [
      ...(settings.hasImg ? [['bg', settings.bgKey]] : []),
      ...settings.board.filter(item => item.type === 'img').map(item => [item.id, item.id])
    ];
  }

  function encode(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function serialize(settings, getBlob) {
    const portable = { ...settings };
    delete portable.generation;
    delete portable.bgKey;
    const result = { app: 'quiet-tab', v: 2, settings: portable, blobs: Object.create(null) };
    let bytes = new Blob([JSON.stringify(result)]).size;
    for (const [name, key] of imageKeys(settings)) {
      const blob = await getBlob(key);
      if (!blob) throw new Error('A saved image is missing. Remove it or replace it before exporting.');
      bytes += 4 * Math.ceil(blob.size / 3) + name.length + 64;
      if (bytes > limit) throw new Error('Backup exceeds 128 MiB. Remove some images and try again.');
      result.blobs[name] = await encode(blob);
    }
    const file = new Blob([JSON.stringify(result)], { type: 'application/json' });
    if (file.size > limit) throw new Error('Backup exceeds 128 MiB.');
    return file;
  }

  async function parse(file) {
    if (file.size > limit) throw new Error('Backup exceeds 128 MiB.');
    const backup = JSON.parse(await file.text());
    if (backup?.app !== 'quiet-tab' || backup.v !== 2 || !object(backup.settings) ||
        !Array.isArray(backup.settings.board) || !Array.isArray(backup.settings.links) ||
        !object(backup.blobs)) throw new Error('Invalid backup');
    const settings = QuietTabState.normalizeSettings(backup.settings);
    if (settings.board.length !== backup.settings.board.length ||
        settings.links.length !== backup.settings.links.length) throw new Error('Invalid backup items');
    const images = new Map();
    async function stage(name, prefix) {
      if (!Object.hasOwn(backup.blobs, name)) throw new Error('Missing image');
      const blob = QuietTabState.imageDataBlob(backup.blobs[name]);
      // Confirm the browser can actually display these bytes before replacing saved data.
      const bitmap = await createImageBitmap(blob, { resizeWidth: 1, resizeHeight: 1 });
      bitmap.close();
      const key = prefix + crypto.randomUUID();
      images.set(key, blob);
      return key;
    }
    settings.bgKey = settings.hasImg ? await stage('bg', 'bg_') : 'bg';
    for (const item of settings.board) {
      if (item.type === 'img') item.id = await stage(item.id, 'pin_');
    }
    return { settings, images };
  }
  return { parse, serialize, imageKeys };
})();
