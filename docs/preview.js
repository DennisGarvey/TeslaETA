const preview = document.querySelector('#product-preview');
const appearanceButtons = [...preview.querySelectorAll('[data-preview-theme]')];
const unitSelector = preview.querySelector('#preview-units');
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const arrival = new Date(Date.now() + 18 * 60_000);
const arrivalFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

let appearance = 'light';

function updateAppearance() {
  preview.dataset.previewDark = String(appearance === 'dark' || (appearance === 'auto' && systemDark.matches));
  for (const button of appearanceButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.previewTheme === appearance));
  }
}

for (const button of appearanceButtons) {
  button.addEventListener('click', () => {
    appearance = button.dataset.previewTheme;
    updateAppearance();
  });
}

systemDark.addEventListener('change', updateAppearance);
updateAppearance();

unitSelector.addEventListener('change', () => {
  const metric = unitSelector.value === 'metric';
  preview.querySelector('#preview-speed').textContent = metric ? '68' : '42';
  preview.querySelector('#preview-speed-unit').textContent = metric ? 'km/h' : 'mph';
  preview.querySelector('#preview-distance').textContent = metric ? '15.4' : '9.6';
  preview.querySelector('#preview-distance-unit').textContent = metric ? 'km remaining' : 'mi remaining';
});

function updateArrival() {
  preview.querySelector('#preview-arrival-time').textContent = arrivalFormatter.format(arrival);
  preview.querySelector('#preview-minutes').textContent = String(Math.max(0, Math.ceil((arrival.getTime() - Date.now()) / 60_000)));
}

updateArrival();
window.setInterval(updateArrival, 15_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateArrival(); });
