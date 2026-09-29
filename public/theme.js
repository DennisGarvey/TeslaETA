const themeKey = 'teslaEtaAppearance';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
let theme = 'auto';
try {
  const saved = localStorage.getItem(themeKey);
  if (saved === 'light' || saved === 'dark') theme = saved;
} catch { /* Storage may be unavailable; Auto still works. */ }

function applyTheme() {
  document.documentElement.classList.toggle('theme-dark', theme === 'dark' || (theme === 'auto' && systemDark.matches));
  document.querySelectorAll('.theme-switch button').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.theme === theme));
  });
}

applyTheme();
systemDark.addEventListener('change', () => { if (theme === 'auto') applyTheme(); });
document.addEventListener('DOMContentLoaded', () => {
  applyTheme();
  document.querySelectorAll('.theme-switch button').forEach(button => {
    button.addEventListener('click', () => {
      theme = button.dataset.theme;
      try { localStorage.setItem(themeKey, theme); } catch { /* Keep the choice for this page. */ }
      applyTheme();
    });
  });
});
