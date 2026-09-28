// Programmatic fits are synchronous so only user camera changes pause following.
export function followLocations(map, getPoints, fitPoints, button) {
  let following = true, fitting = false, lastPoints = '';
  function indicate() {
    button.hidden = following;
    button.textContent = 'Recenter';
    button.title = 'Fit both locations and resume automatic tracking';
  }
  function pause() { if (!fitting) { following = false; indicate(); } }
  function update(force = false) {
    if (!following) return;
    const points = getPoints(), signature = JSON.stringify(points);
    if (!points.length || (!force && signature === lastPoints)) return;
    fitting = true;
    try { fitPoints(points); lastPoints = signature; }
    finally { fitting = false; }
  }
  map.on('dragstart movestart zoomstart', pause);
  map.on('resize', () => update(true));
  button.onclick = () => { following = true; indicate(); update(true); };
  indicate();
  return { update };
}
