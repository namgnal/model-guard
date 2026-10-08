(() => {
  const key = 'model-guard-theme';
  const modes = ['light', 'dark', 'system'];
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let mode = 'system';
  try { const saved = localStorage.getItem(key); if (modes.includes(saved)) mode = saved; } catch {}
  function apply() {
    const resolved = mode === 'system' ? (system.matches ? 'dark' : 'light') : mode;
    root.dataset.theme = resolved;
    root.dataset.themeMode = mode;
    document.querySelectorAll('[data-theme-mode]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.themeMode === mode));
    });
    const note = document.getElementById('theme-note');
    if (note) note.textContent = mode === 'system'
      ? `跟随系统 · 当前${resolved === 'dark' ? '深色' : '浅色'}`
      : `${resolved === 'dark' ? '深色' : '浅色'}外观`;
  }
  // Apply before the stylesheet paints, avoiding a bright flash on a dark screen.
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-mode]').forEach(button => {
      button.addEventListener('click', () => {
        mode = button.dataset.themeMode;
        try { localStorage.setItem(key, mode); } catch {}
        apply();
      });
    });
    apply();
    requestAnimationFrame(() => root.classList.add('theme-ready'));
  });
  system.addEventListener('change', () => { if (mode === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      mode = modes.includes(event.newValue) ? event.newValue : 'system';
      apply();
    }
  });
})();
