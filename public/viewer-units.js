(() => {
  const key = 'tesla-eta-units';
  const selector = document.getElementById('units');
  const speed = document.getElementById('speed-unit');
  const distance = document.getElementById('distance-unit');

  try {
    const saved = localStorage.getItem(key);
    if (saved === 'imperial' || saved === 'metric') selector.value = saved;
  } catch { /* Use the default when storage is unavailable. */ }

  function updateLabels() {
    const metric = selector.value === 'metric';
    speed.textContent = metric ? 'km/h' : 'mph';
    distance.textContent = metric ? 'km remaining' : 'mi remaining';
  }

  updateLabels();
  for (const element of [selector, speed, distance]) {
    element.removeAttribute('data-units-pending');
  }

  selector.addEventListener('change', () => {
    updateLabels();
    try { localStorage.setItem(key, selector.value); }
    catch { /* Keep the choice for this page. */ }
  });
})();
