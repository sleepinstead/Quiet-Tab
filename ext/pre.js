(() => {
  try {
    const m = localStorage.getItem('qt-mode');
    const bg = localStorage.getItem('qt-bg');
    const r = document.documentElement.style;
    if (m === 'light' || m === 'dark') r.colorScheme = m;
    if (bg) {
      r.setProperty('--bg', bg);
      r.backgroundColor = bg;
    } else if (m === 'dark') {
      r.backgroundColor = '#121214';
    } else if (m === 'light') {
      r.backgroundColor = '#f6f5f2';
    }
    const sb = localStorage.getItem('qt-show-bar');
    if (sb === '0') document.documentElement.classList.add('no-bar');
  } catch (e) {}
})();
