/**
 * GeoPortal — Frontend Application
 * Rebuilt tool engine: each tool owns its own event lifecycle.
 * Buffer tool uses dedicated map-click registration/deregistration — no conflicts.
 */
'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:5000/api'
  : '/api';

const DEFAULT_CENTER = [19.0, 72.87];
const DEFAULT_ZOOM   = 13;
const POLL_MS        = 20000;

// ── App State ─────────────────────────────────────────────────────────────────
const S = {
  layers:      {},
  filter:      'all',
  activeTool:  null,
  drawGroup:   null,
  basemaps:    {},
  currentBM:   'dark',
  pollTimer:   null,
  bufCenter:   null,
  bufClickFn:  null,
  p2pPoints:   [],
  p2pClickFn:  null,
  _drawHandler: null,
  _drawCreated: null,
};

let map;

// ── Map Init ──────────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, zoomControl: false, attributionControl: false });

  S.basemaps = {
    dark:      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {maxZoom:22, subdomains:'abcd'}),
    satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom:19}),
    street:    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, subdomains:'abc'}),
    topo:      L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {maxZoom:17, subdomains:'abc'}),
  };
  S.basemaps.dark.addTo(map);
  S.drawGroup = L.featureGroup().addTo(map);

  map.on('mousemove', e => {
    const la = e.latlng.lat, lo = e.latlng.lng;
    document.getElementById('coord-pill').textContent =
      (la >= 0 ? la.toFixed(5)+'°N' : Math.abs(la).toFixed(5)+'°S') + '  ' +
      (lo >= 0 ? lo.toFixed(5)+'°E' : Math.abs(lo).toFixed(5)+'°W');
  });

  map.on('zoomend', updateScale);
  updateScale();
}

function updateScale() {
  const mpp = (156543.03392 * Math.cos(map.getCenter().lat * Math.PI / 180)) / Math.pow(2, map.getZoom());
  const d = mpp * 100;
  document.getElementById('scale-pill').textContent =
    '≈ ' + (d >= 1000 ? (d/1000).toFixed(1)+' km' : Math.round(d)+' m') + ' / 100px';
}

// ── Basemap ───────────────────────────────────────────────────────────────────
function setBasemap(id) {
  if (S.currentBM === id) return;
  map.removeLayer(S.basemaps[S.currentBM]);
  S.basemaps[id].addTo(map).bringToBack();
  S.currentBM = id;
  document.querySelectorAll('.bm-opt').forEach(el => el.classList.toggle('active', el.dataset.bm === id));
}

// ── API ───────────────────────────────────────────────────────────────────────
async function api(path, opts) {
  try {
    const r = await fetch(API + path, Object.assign({ headers: {'Content-Type':'application/json'} }, opts || {}));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch(e) { console.warn('[API]', path, e.message); return null; }
}

async function checkServer() {
  const d = await api('/health');
  const dot = document.getElementById('srv-dot');
  const txt = document.getElementById('srv-txt');
  if (d) { dot.className = 'status-indicator on'; txt.textContent = 'Online · ' + d.layers + ' layers'; }
  else   { dot.className = 'status-indicator off'; txt.textContent = 'Offline'; }
  return !!d;
}

// ── Layer loading ─────────────────────────────────────────────────────────────
async function loadLayers() {
  const d = await api('/layers');
  if (!d) return;
  const names = new Set(d.layers.map(l => l.name));
  for (const n in S.layers) {
    if (!names.has(n)) { map.removeLayer(S.layers[n].lyr); delete S.layers[n]; }
  }
  for (const meta of d.layers) {
    if (!S.layers[meta.name]) await addLayer(meta);
    else S.layers[meta.name].meta = meta;
  }
  renderList();
}

async function addLayer(meta) {
  const d = await api('/layers/' + meta.name);
  if (!d) return;
  const lyr = buildLeafletLayer(d);
  lyr.addTo(map);
  S.layers[meta.name] = { meta, lyr, visible: true, opacity: 1 };
}

function buildLeafletLayer(d) {
  const { type, style, geojson, name } = d;
  const onFeat = (ft, layer) => layer.on('click', e => { L.DomEvent.stopPropagation(e); showFeat(ft.properties, name); });

  if (type === 'point') {
    return L.geoJSON(geojson, {
      pointToLayer: (_, ll) => L.circleMarker(ll, {
        radius:style.radius||7, color:style.color, fillColor:style.fillColor||style.color,
        fillOpacity:style.fillOpacity||0.9, weight:style.weight||2,
      }),
      onEachFeature: onFeat,
    });
  }
  if (type === 'polyline') {
    return L.geoJSON(geojson, {
      style: () => ({ color:style.color, weight:style.weight||3, opacity:0.9 }),
      onEachFeature: onFeat,
    });
  }
  return L.geoJSON(geojson, {
    style: () => ({ color:style.color, fillColor:style.fillColor||style.color, fillOpacity:style.fillOpacity||0.2, weight:style.weight||2, opacity:0.9 }),
    onEachFeature: onFeat,
  });
}

// ── Layer panel ───────────────────────────────────────────────────────────────
function renderList() {
  const list    = document.getElementById('lp-list');
  const entries = Object.values(S.layers).filter(e => S.filter === 'all' || e.meta.type === S.filter);

  if (!entries.length) {
    list.innerHTML = '<div class="lp-loading"><i class="fa-solid fa-circle-exclamation"></i> No layers</div>';
    return;
  }

  list.innerHTML = entries.map(e => {
    const { meta, visible, opacity } = e;
    const disp  = meta.name.replace(/_/g, ' ');
    const tLbl  = meta.type === 'polyline' ? 'LINE' : meta.type.toUpperCase();
    const color = meta.style.color;
    return '<div class="layer-item ' + (visible ? '' : 'dimmed') + '" id="li-' + meta.name + '">' +
      '<div class="li-row">' +
        '<div class="li-check ' + (visible ? 'on' : '') + '" style="--lc:' + color + '" onclick="toggleVis(\'' + meta.name + '\')"></div>' +
        '<div class="li-swatch" style="background:' + color + '"></div>' +
        '<div class="li-info">' +
          '<div class="li-name">' + disp + '</div>' +
          '<div class="li-meta"><span class="li-type">' + tLbl + '</span><span class="li-cnt">' + meta.count.toLocaleString() + ' ft</span></div>' +
        '</div>' +
        '<div class="li-btns">' +
          '<button class="li-btn" title="Zoom to layer" onclick="zoomLayer(\'' + meta.name + '\')"><i class="fa-solid fa-expand"></i></button>' +
          '<button class="li-btn" title="Opacity" onclick="toggleOpRow(\'' + meta.name + '\')"><i class="fa-solid fa-sliders"></i></button>' +
        '</div>' +
      '</div>' +
      '<div class="li-opacity hidden" id="op-' + meta.name + '">' +
        '<label>Opacity</label>' +
        '<input type="range" class="opa-slider" min="0" max="1" step="0.05" value="' + opacity + '" data-n="' + meta.name + '" oninput="setOpacity(this)"/>' +
        '<span class="opa-val" id="opv-' + meta.name + '">' + Math.round(opacity*100) + '%</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

function toggleVis(name) {
  const e = S.layers[name]; if (!e) return;
  e.visible = !e.visible;
  e.visible ? e.lyr.addTo(map) : map.removeLayer(e.lyr);
  renderList();
}

function setOpacity(slider) {
  const name = slider.dataset.n, val = parseFloat(slider.value);
  const e = S.layers[name]; if (!e) return;
  e.opacity = val;
  document.getElementById('opv-' + name).textContent = Math.round(val*100) + '%';
  e.lyr.eachLayer && e.lyr.eachLayer(l => l.setStyle && l.setStyle({ opacity: val, fillOpacity: val * 0.6 }));
}

function toggleOpRow(name) { document.getElementById('op-' + name) && document.getElementById('op-' + name).classList.toggle('hidden'); }
function zoomLayer(name) {
  const e = S.layers[name]; if (!e) return;
  try { const b = e.lyr.getBounds(); if (b.isValid()) { map.fitBounds(b, {padding:[28,28]}); return; } } catch(_) {}
  const b = e.meta.bounds;
  if (b) map.fitBounds([[b[1],b[0]],[b[3],b[2]]], {padding:[28,28]});
}
function filterType(t, btn) {
  S.filter = t;
  document.querySelectorAll('.lf-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderList();
}
function togglePanel() {
  document.getElementById('layer-panel').classList.toggle('hidden');
  document.getElementById('tb-layers').classList.toggle('active');
}
function bulkVisibility(show) {
  for (const n in S.layers) {
    const e = S.layers[n]; e.visible = show;
    show ? e.lyr.addTo(map) : map.removeLayer(e.lyr);
  }
  renderList();
}
function fitAll() {
  const bounds = L.latLngBounds([]);
  for (const e of Object.values(S.layers)) {
    if (!e.visible) continue;
    try { const b = e.lyr.getBounds(); if (b.isValid()) bounds.extend(b); } catch(_) {
      const b = e.meta.bounds; if (b) bounds.extend([[b[1],b[0]],[b[3],b[2]]]);
    }
  }
  if (bounds.isValid()) map.fitBounds(bounds, {padding:[36,36]});
}
async function refreshLayers() {
  const i = document.querySelector('#tb-refresh i');
  i.classList.add('fa-spin');
  await api('/refresh', {method:'POST'});
  await loadLayers();
  i.classList.remove('fa-spin');
  fitAll();
  toast('Layers refreshed', 'ok');
}

// ── Feature info ──────────────────────────────────────────────────────────────
function showFeat(props, layerName) {
  document.getElementById('fp-title').textContent = layerName.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase());
  const rows = Object.entries(props).filter(function(kv) { return kv[1] !== null && kv[1] !== undefined; });
  document.getElementById('fp-body').innerHTML = rows.length
    ? rows.map(function(kv) { return '<div class="fp-row"><span class="fp-key">' + kv[0] + '</span><span class="fp-val">' + kv[1] + '</span></div>'; }).join('')
    : '<div style="color:var(--c-txt3);font-size:11px;padding:6px">No attributes</div>';
  document.getElementById('feat-panel').classList.remove('hidden');
}
function closeFeat() { document.getElementById('feat-panel').classList.add('hidden'); }

// ═══════════════════════════════════════════════════════════════════════
//  TOOL ENGINE
// ═══════════════════════════════════════════════════════════════════════

function activateTool(name) {
  stopCurrentTool();
  S.activeTool = name;
  ['polygon','line','buffer','p2p'].forEach(t =>
    document.getElementById('tb-' + t) && document.getElementById('tb-' + t).classList.toggle('active', t === name)
  );
  var hints = {
    polygon: 'Click vertices on the map — double-click to close polygon',
    line:    'Click points on the map — double-click to finish the line',
    buffer:  'Click anywhere on the map to set the buffer center point',
    p2p:     'Click Point 1 on the map',
  };
  showHint(hints[name] || '');
  if (name === 'polygon') startPolygon();
  else if (name === 'line')   startLine();
  else if (name === 'buffer') startBuffer();
  else if (name === 'p2p')    startP2P();
}

function stopCurrentTool() {
  var t = S.activeTool;
  if (!t) return;
  if ((t === 'polygon' || t === 'line') && S._drawHandler) {
    try { S._drawHandler.disable(); } catch(err) {}
    if (S._drawCreated) map.off('draw:created', S._drawCreated);
    S._drawHandler = null; S._drawCreated = null;
  }
  if (t === 'buffer') {
    if (S.bufClickFn) { map.off('click', S.bufClickFn); S.bufClickFn = null; }
    S.bufCenter = null;
    hideBufPanel();
  }
  if (t === 'p2p') {
    if (S.p2pClickFn) { map.off('click', S.p2pClickFn); S.p2pClickFn = null; }
    S.p2pPoints = [];
  }
  map.getContainer().style.cursor = '';
  S.activeTool = null;
  hideHint();
  ['polygon','line','buffer','p2p'].forEach(id =>
    document.getElementById('tb-' + id) && document.getElementById('tb-' + id).classList.remove('active')
  );
}

function cancelTool() { stopCurrentTool(); toast('Tool cancelled', 'warn'); }

function showHint(msg) {
  document.getElementById('tool-hint-txt').textContent = msg;
  document.getElementById('tool-hint').classList.remove('hidden');
}
function hideHint() { document.getElementById('tool-hint').classList.add('hidden'); }

function showResults(titleHtml, bodyHtml) {
  document.getElementById('rp-title').innerHTML = titleHtml;
  document.getElementById('rp-body').innerHTML  = bodyHtml;
  document.getElementById('results-panel').classList.remove('hidden');
}
function closeResults() { document.getElementById('results-panel').classList.add('hidden'); }

// ── TOOL 1: Polygon Area ─────────────────────────────────────────────────────
function startPolygon() {
  map.getContainer().style.cursor = 'crosshair';
  var handler = new L.Draw.Polygon(map, {
    shapeOptions: { color:'#00d4ff', fillColor:'#00d4ff', fillOpacity:.12, weight:2, dashArray:'6 3' },
    allowIntersection: false,
  });
  S._drawHandler = handler;
  S._drawCreated = function(e) {
    S.drawGroup.addLayer(e.layer);
    showAreaResult(geodesicArea(e.layer.getLatLngs()[0]));
    stopCurrentTool();
  };
  map.on('draw:created', S._drawCreated);
  handler.enable();
}

function geodesicArea(latlngs) {
  var R = 6371000, area = 0, n = latlngs.length;
  for (var i = 0; i < n; i++) {
    var j = (i + 1) % n;
    var lat1 = latlngs[i].lat * Math.PI / 180, lat2 = latlngs[j].lat * Math.PI / 180;
    var dLng = (latlngs[j].lng - latlngs[i].lng) * Math.PI / 180;
    area += dLng * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs(area * R * R / 2);
}

function showAreaResult(sqm) {
  showResults(
    '<i class="fa-solid fa-draw-polygon"></i> Area Measurement',
    section('Computed Area', grid([
      val('Square Meters', fmt(sqm), 'sq.m'),
      val('Square Feet',   fmt(sqm * 10.7639), 'sq.ft'),
      val('Hectares',      (sqm / 10000).toFixed(4), 'ha'),
      val('Acres',         (sqm / 4046.856).toFixed(4), 'ac'),
    ]))
  );
}

// ── TOOL 2: Line Distance ─────────────────────────────────────────────────────
function startLine() {
  map.getContainer().style.cursor = 'crosshair';
  var handler = new L.Draw.Polyline(map, {
    shapeOptions: { color:'#00d4ff', weight:2.5, dashArray:'8 4', opacity:.9 },
  });
  S._drawHandler = handler;
  S._drawCreated = function(e) {
    S.drawGroup.addLayer(e.layer);
    var pts = e.layer.getLatLngs();
    showDistResult(polyDist(pts), pts);
    stopCurrentTool();
  };
  map.on('draw:created', S._drawCreated);
  handler.enable();
}

function haversine(p1, p2) {
  var R = 6371000;
  var f1 = p1.lat * Math.PI/180, f2 = p2.lat * Math.PI/180;
  var df = (p2.lat - p1.lat) * Math.PI/180, dl = (p2.lng - p1.lng) * Math.PI/180;
  var a = Math.sin(df/2)*Math.sin(df/2) + Math.cos(f1)*Math.cos(f2)*Math.sin(dl/2)*Math.sin(dl/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function polyDist(pts) {
  var d = 0;
  for (var i = 0; i < pts.length-1; i++) d += haversine(pts[i], pts[i+1]);
  return d;
}

function calcBearing(p1, p2) {
  var f1 = p1.lat*Math.PI/180, f2 = p2.lat*Math.PI/180, dl = (p2.lng-p1.lng)*Math.PI/180;
  var y = Math.sin(dl)*Math.cos(f2);
  var x = Math.cos(f1)*Math.sin(f2) - Math.sin(f1)*Math.cos(f2)*Math.cos(dl);
  return ((Math.atan2(y, x)*180/Math.PI)+360)%360;
}

function showDistResult(m, pts) {
  var extra = pts.length >= 2 ? section('Direction', grid([
    val('Bearing', calcBearing(pts[0], pts[pts.length-1]).toFixed(1), '°'),
    val('Segments', pts.length - 1, 'segs'),
  ])) : '';
  showResults(
    '<i class="fa-solid fa-ruler"></i> Distance Measurement',
    section('Total Distance', grid([
      val('Meters',     fmt(m),                  'm'),
      val('Feet',       fmt(m * 3.28084),        'ft'),
      val('Kilometers', (m/1000).toFixed(4),    'km'),
      val('Miles',      (m/1609.344).toFixed(4),'mi'),
    ])) + extra
  );
}

// ── TOOL 3: Buffer (FIXED — dedicated click handler with proper add/remove) ───
function startBuffer() {
  S.bufCenter = null;
  showBufPanel(false);
  map.getContainer().style.cursor = 'crosshair';

  // CRITICAL: Create the handler as a named variable stored in state
  // so map.off() can reference the exact same function object
  S.bufClickFn = function handleBufClick(e) {
    // STEP 1: Immediately deregister — prevents double-click issues
    map.off('click', S.bufClickFn);
    S.bufClickFn = null;

    // Store center
    S.bufCenter = e.latlng;

    // Visual marker
    S.drawGroup.addLayer(L.circleMarker(e.latlng, {
      radius:8, color:'#00d4ff', fillColor:'#00d4ff', fillOpacity:1, weight:2.5,
    }));

    // Restore cursor — user is done clicking
    map.getContainer().style.cursor = '';

    // Reveal the distance inputs in panel
    showBufPanel(true, e.latlng);
    showHint('Center placed — enter distance in the panel and click Generate Buffer');
  };

  map.on('click', S.bufClickFn);
}

function showBufPanel(step2, latlng) {
  document.getElementById('buf-panel').classList.remove('hidden');
  document.getElementById('buf-step2').classList.toggle('hidden', !step2);
  document.getElementById('buf-inputs').classList.toggle('hidden', !step2);
  if (step2 && latlng) {
    document.getElementById('buf-coord-txt').textContent =
      latlng.lat.toFixed(5) + '°, ' + latlng.lng.toFixed(5) + '°';
  }
}

function hideBufPanel() {
  document.getElementById('buf-panel').classList.add('hidden');
  document.getElementById('buf-step2').classList.add('hidden');
  document.getElementById('buf-inputs').classList.add('hidden');
}

function applyBuffer() {
  if (!S.bufCenter) { toast('Click on the map first to set the center point', 'warn'); return; }
  var raw  = parseFloat(document.getElementById('buf-dist').value);
  var unit = document.getElementById('buf-unit').value;
  if (isNaN(raw) || raw <= 0) { toast('Enter a valid positive distance', 'warn'); return; }
  var CONV = { m:1, km:1000, ft:0.3048, mi:1609.344 };
  var radiusM = raw * CONV[unit];

  // Draw circle
  var circle = L.circle(S.bufCenter, {
    radius:radiusM, color:'#00d4ff', fillColor:'#00d4ff', fillOpacity:.1, weight:2, dashArray:'6 3',
  });
  S.drawGroup.addLayer(circle);
  map.fitBounds(circle.getBounds(), {padding:[28,28]});

  var sqm  = Math.PI * radiusM * radiusM;
  showResults(
    '<i class="fa-solid fa-circle-dot"></i> Buffer Analysis',
    section('Buffer Parameters', grid([
      val('Radius',   fmt(radiusM),   'm'),
      val('Diameter', fmt(radiusM*2), 'm'),
    ])) +
    section('Buffer Area', grid([
      val('Square Meters', fmt(sqm),                    'sq.m'),
      val('Square Feet',   fmt(sqm * 10.7639),          'sq.ft'),
      val('Hectares',      (sqm / 10000).toFixed(4),   'ha'),
      val('Acres',         (sqm / 4046.856).toFixed(4),'ac'),
    ]))
  );

  toast('Buffer generated — ' + fmt(radiusM) + ' m radius', 'ok');
  hideBufPanel();
  hideHint();
  S.bufCenter  = null;
  S.activeTool = null;
  document.getElementById('tb-buffer') && document.getElementById('tb-buffer').classList.remove('active');
  map.getContainer().style.cursor = '';
}

// ── TOOL 4: Point-to-Point (FIXED — dedicated listener) ──────────────────────
function startP2P() {
  S.p2pPoints = [];
  map.getContainer().style.cursor = 'crosshair';
  var count = 0;

  S.p2pClickFn = function handleP2PClick(e) {
    count++;
    S.p2pPoints.push(e.latlng);

    S.drawGroup.addLayer(L.circleMarker(e.latlng, {
      radius:8, color:'#ff9800', fillColor:'#ff9800', fillOpacity:1, weight:2.5,
    }));
    S.drawGroup.addLayer(L.marker(e.latlng, {
      icon: L.divIcon({
        html: '<div style="background:#0e1420;border:1px solid #ff9800;color:#ff9800;font-family:monospace;font-size:10px;padding:2px 5px;border-radius:3px;white-space:nowrap">P' + count + '</div>',
        iconAnchor: [0, 0], className: '',
      }),
    }));

    if (count === 1) {
      showHint('Point 1 placed — click Point 2 on the map');
    } else if (count === 2) {
      // Deregister immediately
      map.off('click', S.p2pClickFn);
      S.p2pClickFn = null;

      S.drawGroup.addLayer(L.polyline(S.p2pPoints, { color:'#ff9800', weight:2.5, dashArray:'6 3' }));
      showP2PResult(haversine(S.p2pPoints[0], S.p2pPoints[1]), S.p2pPoints[0], S.p2pPoints[1]);

      map.getContainer().style.cursor = '';
      S.p2pPoints = []; S.activeTool = null;
      hideHint();
      document.getElementById('tb-p2p') && document.getElementById('tb-p2p').classList.remove('active');
    }
  };

  map.on('click', S.p2pClickFn);
}

function showP2PResult(m, p1, p2) {
  var dLatM = Math.abs(p2.lat - p1.lat) * 111320;
  var dLngM = Math.abs(p2.lng - p1.lng) * 111320 * Math.cos(p1.lat * Math.PI/180);
  showResults(
    '<i class="fa-solid fa-arrows-left-right"></i> Point-to-Point Distance',
    section('Straight-Line Distance', grid([
      val('Meters',     fmt(m),                  'm'),
      val('Feet',       fmt(m * 3.28084),        'ft'),
      val('Kilometers', (m/1000).toFixed(4),    'km'),
      val('Miles',      (m/1609.344).toFixed(4),'mi'),
    ])) +
    section('Components', grid([
      val('Bearing',     calcBearing(p1, p2).toFixed(1), '°'),
      val('Δ Latitude',  fmt(dLatM), 'm'),
      val('Δ Longitude', fmt(dLngM), 'm'),
    ]))
  );
}

// ── Clear ─────────────────────────────────────────────────────────────────────
function clearAll() {
  stopCurrentTool();
  S.drawGroup.clearLayers();
  closeResults();
  hideBufPanel();
  hideHint();
  toast('All drawings cleared', 'ok');
}

// ── HTML helpers ──────────────────────────────────────────────────────────────
function val(lbl, num, unit) {
  return '<div class="rp-val"><div class="rp-val-lbl">' + lbl + '</div><div class="rp-val-num">' + num + '<span class="rp-val-unit">' + unit + '</span></div></div>';
}
function grid(items) { return '<div class="rp-grid">' + items.join('') + '</div>'; }
function section(title, content) {
  return '<div class="rp-section"><div class="rp-sec-title">' + title + '</div>' + content + '</div>';
}
function fmt(n) {
  n = +n;
  if (n >= 1e6)  return (n/1e6).toFixed(2) + 'M';
  if (n >= 1000) return Number(n.toFixed(1)).toLocaleString();
  if (n >= 100)  return n.toFixed(1);
  if (n >= 1)    return n.toFixed(2);
  return n.toFixed(4);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type, ms) {
  type = type || 'info'; ms = ms || 3000;
  var icons = { ok:'fa-circle-check', err:'fa-circle-xmark', warn:'fa-triangle-exclamation', info:'fa-circle-info' };
  var el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = '<i class="fa-solid ' + (icons[type]||icons.info) + '"></i><span>' + msg + '</span>';
  document.getElementById('toast-stack').appendChild(el);
  setTimeout(function() {
    el.style.opacity = '0'; el.style.transform = 'translateX(110%)'; el.style.transition = 'all .25s';
    setTimeout(function() { el.remove(); }, 260);
  }, ms);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  initMap();
  var ok = await checkServer();
  await loadLayers();
  fitAll();
  if (!ok) toast('Running with sample data — backend offline', 'warn');
  else     toast('GeoPortal ready', 'ok');
  S.pollTimer = setInterval(async function() {
    await checkServer();
    await loadLayers();
  }, POLL_MS);
}

document.addEventListener('DOMContentLoaded', boot);
