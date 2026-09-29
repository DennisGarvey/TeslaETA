// Keep marker anchors inside a smaller map rectangle, clear of map controls.
export function safeFitPadding({ x, y }) {
  return {
    paddingTopLeft: [Math.min(72, Math.floor(x * 0.25)), Math.min(84, Math.floor(y * 0.35))],
    paddingBottomRight: [Math.min(88, Math.floor(x * 0.35)), Math.min(56, Math.floor(y * 0.25))]
  };
}

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

// The admin fleet map can follow one car or keep the whole fleet in view.
export function followFleetLocations(map, getPoints, getSelectedPoint, fitAll, centerSelected, button, onSelectionChange) {
  let selectedId = null, following = true, fitting = false, lastTarget = '';
  function indicate() {
    button.hidden = selectedId == null && following;
    button.textContent = selectedId == null ? 'Recenter' : 'Show all vehicles';
    button.title = selectedId == null ? 'Fit all vehicle locations and resume automatic tracking' : 'Fit all vehicle locations';
  }
  function pause() { if (!fitting) { following = false; indicate(); } }
  function update(force = false) {
    if (!following) return;
    let selectedPoint = selectedId == null ? null : getSelectedPoint(selectedId);
    if (selectedId != null && !selectedPoint) {
      selectedId = null; onSelectionChange(null); indicate(); force = true;
    }
    const points = selectedId == null ? getPoints() : [selectedPoint];
    const target = JSON.stringify([selectedId, points]);
    if (!points.length || (!force && target === lastTarget)) return;
    fitting = true;
    try {
      if (selectedId == null) fitAll(points);
      else centerSelected(selectedPoint, force);
      lastTarget = target;
    } finally { fitting = false; }
  }
  function select(id) {
    if (!getSelectedPoint(id)) return;
    selectedId = id; following = true; onSelectionChange(id); indicate(); update(true);
  }
  function showAll() {
    selectedId = null; following = true; onSelectionChange(null); indicate(); update(true);
  }
  map.on('dragstart movestart zoomstart', pause);
  map.on('resize', () => update(true));
  button.onclick = showAll;
  indicate();
  return { update, select, showAll, selected: () => selectedId };
}
