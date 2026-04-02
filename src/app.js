// ───────────── State ─────────────
let currentData = null; // { grid: Float64Array[], rows, cols }
let debounceTimer = null;

// ───────────── DOM refs ─────────────
const $ = (sel) => document.querySelector(sel);
const preview = $('#preview-container');

// All slider/select/input IDs that affect rendering
const paramIds = [
  'numLines','samplesPerLine','lineSpacing','amplitude','transectAngle',
  'strokeWidth','fillOpacity','smoothing',
  'lineColor','bgColor',
  'interpolation','hOffset','margin','plotOffsetX','plotOffsetY','canvasW','canvasH',
  'titleText','subtitleText','titleFont','titleSize','subtitleSize','titleColor','titlePosition','borderWidth'
];

// ───────────── Init controls ─────────────
function readParam(id) {
  const el = $(`#${id}`);
  if (!el) return null;
  if (el.type === 'color') return el.value;
  if (el.tagName === 'SELECT') return el.value;
  if (el.type === 'text') return el.value;
  return parseFloat(el.value);
}

function params() {
  const p = {};
  paramIds.forEach(id => p[id] = readParam(id));
  return p;
}

// Display values next to sliders and listen for changes
paramIds.forEach(id => {
  const el = $(`#${id}`);
  if (!el) return;
  const valEl = $(`#val-${id}`);
  if (valEl) valEl.textContent = id === 'transectAngle' ? el.value + '°' : el.value;
  el.addEventListener('input', () => {
    if (valEl) valEl.textContent = id === 'transectAngle' ? el.value + '°' : el.value;
    scheduleRender();
  });
});

// ───────────── Double-click to edit numeric values ─────────────
document.querySelectorAll('.value').forEach(valEl => {
  valEl.style.cursor = 'pointer';
  valEl.title = 'Double-click to edit';
  valEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const id = valEl.id.replace('val-', '');
    const slider = $(`#${id}`);
    if (!slider || slider.type !== 'range') return;

    const currentVal = valEl.textContent.replace('°', '');
    const input = document.createElement('input');
    input.type = 'number';
    input.value = currentVal;
    input.min = slider.min;
    input.max = slider.max;
    input.step = slider.step;
    input.style.cssText = 'width:50px; font-size:12px; font-family:monospace; color:var(--text-dim); background:var(--input-bg); border:1px solid var(--accent); border-radius:3px; padding:0 3px; text-align:right; outline:none;';

    const commit = () => {
      let v = parseFloat(input.value);
      if (isNaN(v)) v = parseFloat(currentVal);
      v = Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), v));
      slider.value = v;
      valEl.textContent = id === 'transectAngle' ? v + '°' : v;
      if (input.parentNode === valEl) valEl.removeChild(input);
      scheduleRender();
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      if (ev.key === 'Escape') { ev.preventDefault(); valEl.textContent = id === 'transectAngle' ? currentVal + '°' : currentVal; }
    });
    input.addEventListener('blur', commit);

    valEl.textContent = '';
    valEl.appendChild(input);
    input.focus();
    input.select();
  });
});

// ───────────── Reset to defaults ─────────────
// Capture the default value of every param control on page load
const DEFAULTS = {};
paramIds.forEach(id => {
  const el = $(`#${id}`);
  if (el) DEFAULTS[id] = el.value;
});

$('#btn-reset').addEventListener('click', () => {
  paramIds.forEach(id => {
    const el = $(`#${id}`);
    if (!el || DEFAULTS[id] === undefined) return;
    el.value = DEFAULTS[id];
    const valEl = $(`#val-${id}`);
    if (valEl) valEl.textContent = id === 'transectAngle' ? el.value + '°' : el.value;
  });
  scheduleRender();
});

// ───────────── Canvas size presets ─────────────
document.querySelectorAll('.size-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const w = parseInt(btn.dataset.w);
    const h = parseInt(btn.dataset.h);
    $('#canvasW').value = w;
    $('#canvasH').value = h;
    $('#val-canvasW').textContent = w;
    $('#val-canvasH').textContent = h;
    document.querySelectorAll('.size-preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    scheduleRender();
  });
});

// ───────────── Bilinear sample helper ─────────────
/**
 * Sample a value from the source grid using bilinear interpolation.
 * @param {{ grid: Float64Array[], rows: number, cols: number }} source - Elevation grid
 * @param {number} gr - Fractional row index (clamped to grid bounds)
 * @param {number} gc - Fractional column index (clamped to grid bounds)
 * @returns {number} Interpolated value
 */
function bilinearSample(source, gr, gc) {
  gr = Math.max(0, Math.min(source.rows - 1, gr));
  gc = Math.max(0, Math.min(source.cols - 1, gc));
  const r0 = Math.floor(gr), r1 = Math.min(r0 + 1, source.rows - 1);
  const c0 = Math.floor(gc), c1 = Math.min(c0 + 1, source.cols - 1);
  const rt = gr - r0, ct = gc - c0;
  const v00 = source.grid[r0][c0], v10 = source.grid[r1][c0];
  const v01 = source.grid[r0][c1], v11 = source.grid[r1][c1];
  return (1 - rt) * ((1 - ct) * v00 + ct * v01) + rt * ((1 - ct) * v10 + ct * v11);
}

// ───────────── Resample with rotation (transect angle) ─────────────
/**
 * Resample the source elevation grid to target dimensions with optional rotation.
 * Projects corner points to find rotated extent, then samples via bilinear interpolation.
 * @param {{ grid: Float64Array[], rows: number, cols: number }} source
 * @param {number} targetRows - Output row count (numLines)
 * @param {number} targetCols - Output column count (samplesPerLine)
 * @param {number} angleDeg - Transect rotation in degrees (0 = east-west, 90 = north-south)
 * @returns {{ grid: Float64Array[], rows: number, cols: number }}
 */
function resampleGrid(source, targetRows, targetCols, angleDeg) {
  const theta = (angleDeg || 0) * Math.PI / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const centerR = (source.rows - 1) / 2;
  const centerC = (source.cols - 1) / 2;

  const corners = [
    [-centerC, -centerR], [source.cols - 1 - centerC, -centerR],
    [-centerC, source.rows - 1 - centerR], [source.cols - 1 - centerC, source.rows - 1 - centerR]
  ];
  let minLine = Infinity, maxLine = -Infinity;
  let minPerp = Infinity, maxPerp = -Infinity;
  for (const [dc, dr] of corners) {
    const lineProj = dc * cosT + dr * sinT;
    const perpProj = dc * (-sinT) + dr * cosT;
    minLine = Math.min(minLine, lineProj);
    maxLine = Math.max(maxLine, lineProj);
    minPerp = Math.min(minPerp, perpProj);
    maxPerp = Math.max(maxPerp, perpProj);
  }

  const grid = [];
  for (let r = 0; r < targetRows; r++) {
    const perpPos = minPerp + (r / (targetRows - 1)) * (maxPerp - minPerp);
    const row = new Float64Array(targetCols);
    for (let c = 0; c < targetCols; c++) {
      const linePos = minLine + (c / (targetCols - 1)) * (maxLine - minLine);
      const gc = centerC + linePos * cosT + perpPos * (-sinT);
      const gr = centerR + linePos * sinT + perpPos * cosT;
      row[c] = bilinearSample(source, gr, gc);
    }
    grid.push(row);
  }
  return { grid, rows: targetRows, cols: targetCols };
}

// ───────────── Smoothing (moving average) ─────────────
/**
 * Smooth a single row of elevation data using a symmetric moving average.
 * @param {Float64Array} row - Input elevation values
 * @param {number} kernel - Half-width of the averaging window (0 = no smoothing)
 * @returns {Float64Array} Smoothed row
 */
function smoothRow(row, kernel) {
  if (kernel <= 0) return row;
  const out = new Float64Array(row.length);
  for (let i = 0; i < row.length; i++) {
    let sum = 0, count = 0;
    for (let k = -kernel; k <= kernel; k++) {
      const idx = i + k;
      if (idx >= 0 && idx < row.length) { sum += row[idx]; count++; }
    }
    out[i] = sum / count;
  }
  return out;
}

// ───────────── Normalize grid to [0, 1] ─────────────
/**
 * Normalize all grid values to the [0, 1] range based on global min/max.
 * @param {{ grid: Float64Array[], rows: number, cols: number }} data
 * @returns {{ grid: Float64Array[], rows: number, cols: number }}
 */
function normalizeGrid(data) {
  let min = Infinity, max = -Infinity;
  for (const row of data.grid) {
    for (let i = 0; i < row.length; i++) {
      if (row[i] < min) min = row[i];
      if (row[i] > max) max = row[i];
    }
  }
  const range = max - min || 1;
  const grid = data.grid.map(row => {
    const out = new Float64Array(row.length);
    for (let i = 0; i < row.length; i++) out[i] = (row[i] - min) / range;
    return out;
  });
  return { grid, rows: data.rows, cols: data.cols };
}

// ───────────── SVG path builders ─────────────
function buildLinearPath(points) {
  let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i][0].toFixed(2)} ${points[i][1].toFixed(2)}`;
  }
  return d;
}

/**
 * Build a smooth SVG path using Catmull-Rom to cubic Bezier conversion.
 * Tension of 6 gives gentle curves that closely follow the data points.
 * @param {number[][]} points - Array of [x, y] coordinate pairs
 * @returns {string} SVG path d attribute
 */
function buildSmoothPath(points) {
  if (points.length < 2) return buildLinearPath(points);
  let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const tension = 6;
    const cp1x = p1[0] + (p2[0] - p0[0]) / tension;
    const cp1y = p1[1] + (p2[1] - p0[1]) / tension;
    const cp2x = p2[0] - (p3[0] - p1[0]) / tension;
    const cp2y = p2[1] - (p3[1] - p1[1]) / tension;
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

function buildStepPath(points) {
  let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` H ${points[i][0].toFixed(2)} V ${points[i][1].toFixed(2)}`;
  }
  return d;
}

// ───────────── Render ─────────────
/**
 * Main render function. Resamples elevation data, applies smoothing,
 * computes auto-scaling to fit canvas, skips flat rows (variance < 0.005),
 * and builds the SVG with separate fill polygons (occlusion) and stroke paths.
 * The +2px on closePath baseline prevents sub-pixel gaps between fill polygons.
 */
function render() {
  const p = params();
  const W = p.canvasW;
  const H = p.canvasH;
  const marginPx = p.margin;
  const plotW = W - 2 * marginPx;
  const numLines = Math.round(p.numLines);
  const samplesPerLine = Math.round(p.samplesPerLine);
  const lineSpacing = p.lineSpacing;
  const amplitude = p.amplitude;

  // If no data loaded, show placeholder
  if (!currentData) {
    preview.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="${p.bgColor}"/>
      <text x="${W/2}" y="${H/2}" text-anchor="middle" fill="${p.lineColor}" font-size="18" font-family="${p.titleFont}" opacity="0.4">Select a location and fetch elevation data</text>
    </svg>`;
    return;
  }

  // Resample source data to match current line/sample settings (with rotation)
  const data = normalizeGrid(resampleGrid(currentData, numLines, samplesPerLine, p.transectAngle));

  // Apply smoothing
  const smoothed = data.grid.map(row => smoothRow(row, Math.round(p.smoothing)));

  // ── Compute title block height ──
  const titlePos = p.titlePosition || 'top';
  let titleBlockH = 0;
  if (p.titleText)    titleBlockH += p.titleSize * 1.3;
  if (p.subtitleText) titleBlockH += p.subtitleSize * 1.3;
  if (titleBlockH > 0) titleBlockH += 10;

  // ── Compute natural plot height, then scale to fit canvas ──
  const totalBaselineSpan = (numLines - 1) * lineSpacing;
  const naturalPlotH = totalBaselineSpan + amplitude;
  const availableH = H - 2 * marginPx - titleBlockH;

  const scaleFactor = naturalPlotH > availableH ? availableH / naturalPlotH : 1;
  const scaledAmplitude = amplitude * scaleFactor;
  const scaledSpacing = lineSpacing * scaleFactor;
  const scaledPlotH = (numLines - 1) * scaledSpacing + scaledAmplitude;

  // Center vertically in available area, then apply manual offset
  const titleAbove = titlePos === 'top' ? titleBlockH : 0;
  const topOffset = marginPx + titleAbove
    + Math.max(0, (availableH - scaledPlotH) / 2)
    + p.plotOffsetY;

  const pathBuilder = p.interpolation === 'smooth' ? buildSmoothPath
                    : p.interpolation === 'step' ? buildStepPath
                    : buildLinearPath;

  let paths = '';
  for (let r = 0; r < numLines; r++) {
    // Skip flat rows (rivers, ocean, tile gaps)
    const rowData = smoothed[r];
    let rMin = rowData[0], rMax = rowData[0];
    for (let i = 1; i < rowData.length; i++) {
      if (rowData[i] < rMin) rMin = rowData[i];
      if (rowData[i] > rMax) rMax = rowData[i];
    }
    if (rMax - rMin < 0.005) continue;

    const baseY = topOffset + scaledAmplitude + r * scaledSpacing;
    const offsetX = r * p.hOffset + p.plotOffsetX;
    const points = [];
    for (let c = 0; c < samplesPerLine; c++) {
      const x = marginPx + (c / (samplesPerLine - 1)) * plotW + offsetX;
      const y = baseY - rowData[c] * scaledAmplitude;
      points.push([x, y]);
    }

    const ridgePath = pathBuilder(points);
    const lastPt = points[points.length - 1];
    const firstPt = points[0];
    const closePath = ` L ${lastPt[0].toFixed(2)} ${(baseY + 2).toFixed(2)} L ${firstPt[0].toFixed(2)} ${(baseY + 2).toFixed(2)} Z`;

    // Fill polygon (occludes lines behind) — no stroke
    paths += `<path d="${ridgePath}${closePath}" fill="${p.bgColor}" fill-opacity="${p.fillOpacity}" stroke="none"/>`;
    // Ridge line only — no fill
    paths += `<path d="${ridgePath}" fill="none" stroke="${p.lineColor}" stroke-width="${p.strokeWidth}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  // Title and subtitle
  let titleSvg = '';
  const titleX = W / 2;
  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  let titleY;
  if (titlePos === 'top') {
    titleY = marginPx;
    if (p.titleText) {
      titleY += p.titleSize;
      titleSvg += `<text x="${titleX}" y="${titleY}" text-anchor="middle" fill="${p.titleColor}" font-size="${p.titleSize}" font-family="${p.titleFont}" font-weight="700">${esc(p.titleText)}</text>`;
    }
    if (p.subtitleText) {
      titleY += p.subtitleSize * 1.3 + 4;
      titleSvg += `<text x="${titleX}" y="${titleY}" text-anchor="middle" fill="${p.titleColor}" font-size="${p.subtitleSize}" font-family="${p.titleFont}" opacity="0.7">${esc(p.subtitleText)}</text>`;
    }
  } else {
    // Bottom placement — position below the plot
    titleY = H - marginPx;
    if (p.subtitleText) {
      titleSvg += `<text x="${titleX}" y="${titleY}" text-anchor="middle" fill="${p.titleColor}" font-size="${p.subtitleSize}" font-family="${p.titleFont}" opacity="0.7">${esc(p.subtitleText)}</text>`;
      titleY -= p.subtitleSize * 1.3 + 4;
    }
    if (p.titleText) {
      titleSvg += `<text x="${titleX}" y="${titleY}" text-anchor="middle" fill="${p.titleColor}" font-size="${p.titleSize}" font-family="${p.titleFont}" font-weight="700">${esc(p.titleText)}</text>`;
    }
  }

  const borderW = p.borderWidth || 0;
  const innerX = borderW;
  const innerY = borderW;
  const innerW = W - 2 * borderW;
  const innerH = H - 2 * borderW;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <clipPath id="inner-clip"><rect x="${innerX}" y="${innerY}" width="${innerW}" height="${innerH}"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="${p.bgColor}"/>
  <g clip-path="url(#inner-clip)">
  ${paths}
  </g>
  ${titleSvg}
</svg>`;

  preview.innerHTML = svg;
}

function scheduleRender() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(render, 30);
}

// ───────────── Elevation via Terrain RGB Tiles ─────────────
const PRESETS = {
  'banff':        { south: 51.05, north: 51.3, west: -115.75, east: -115.4, title: 'Banff', subtitle: 'Alberta, Canada' },
  'everest':      { south: 27.85, north: 28.1, west: 86.75, east: 87.05, title: 'Mt Everest', subtitle: 'Nepal / Tibet' },
  'crater-lake':  { south: 42.88, north: 42.98, west: -122.18, east: -122.04, title: 'Crater Lake', subtitle: 'Oregon, USA' },
  'fjords':       { south: 61.0, north: 61.4, west: 6.0, east: 7.2, title: 'Norwegian Fjords', subtitle: 'Western Norway' },
  'innsbruck':    { south: 47.2, north: 47.35, west: 11.3, east: 11.5, title: 'Innsbruck', subtitle: 'Tyrol, Austria' },
  'sossusvlei':   { south: -24.82, north: -24.62, west: 15.2, east: 15.45, title: 'Sossusvlei', subtitle: 'Namib Desert, Namibia' },
};

// ───────────── Leaflet Map ─────────────
let leafletMap = null;
let selectionRect = null;
let isDrawing = false;
let drawStart = null;

function initMap() {
  if (leafletMap) return;

  const south = parseFloat($('#lat-south').value);
  const north = parseFloat($('#lat-north').value);
  const west = parseFloat($('#lng-west').value);
  const east = parseFloat($('#lng-east').value);

  leafletMap = L.map('location-map', {
    zoomControl: true,
    attributionControl: true,
  }).fitBounds([[south, west], [north, east]], { padding: [30, 30] });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 18,
  }).addTo(leafletMap);

  selectionRect = L.rectangle([[south, west], [north, east]], {
    color: '#e94560',
    weight: 2,
    fillOpacity: 0.15,
    dashArray: '6 3',
  }).addTo(leafletMap);

  leafletMap.on('mousedown', (e) => {
    if (e.originalEvent.button === 0 && e.originalEvent.shiftKey) {
      const target = e.originalEvent.target;
      if (target.closest('.leaflet-control')) return;
      isDrawing = true;
      drawStart = e.latlng;
      leafletMap.dragging.disable();
      e.originalEvent.preventDefault();
    }
  });

  leafletMap.on('mousemove', (e) => {
    if (!isDrawing || !drawStart) return;
    const bounds = L.latLngBounds(drawStart, e.latlng);
    selectionRect.setBounds(bounds);
  });

  leafletMap.on('mouseup', (e) => {
    if (!isDrawing) return;
    isDrawing = false;
    leafletMap.dragging.enable();
    if (drawStart) {
      const bounds = L.latLngBounds(drawStart, e.latlng);
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      if (Math.abs(ne.lat - sw.lat) > 0.005 && Math.abs(ne.lng - sw.lng) > 0.005) {
        selectionRect.setBounds(bounds);
        syncInputsFromRect();
      }
    }
    drawStart = null;
  });
}

function syncInputsFromRect() {
  if (!selectionRect) return;
  const b = selectionRect.getBounds();
  $('#lat-south').value = b.getSouth().toFixed(4);
  $('#lat-north').value = b.getNorth().toFixed(4);
  $('#lng-west').value = b.getWest().toFixed(4);
  $('#lng-east').value = b.getEast().toFixed(4);
}

function syncRectFromInputs() {
  if (!selectionRect || !leafletMap) return;
  const south = parseFloat($('#lat-south').value);
  const north = parseFloat($('#lat-north').value);
  const west = parseFloat($('#lng-west').value);
  const east = parseFloat($('#lng-east').value);
  if (isNaN(south) || isNaN(north) || isNaN(west) || isNaN(east)) return;
  if (south >= north || west >= east) return;
  const bounds = L.latLngBounds([[south, west], [north, east]]);
  selectionRect.setBounds(bounds);
  leafletMap.fitBounds(bounds, { padding: [30, 30], animate: true });
}

['lat-south', 'lat-north', 'lng-west', 'lng-east'].forEach(id => {
  $(`#${id}`).addEventListener('change', syncRectFromInputs);
});

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const p = PRESETS[btn.dataset.preset];
    $('#lat-south').value = p.south;
    $('#lat-north').value = p.north;
    $('#lng-west').value = p.west;
    $('#lng-east').value = p.east;
    if (p.title) { $('#titleText').value = p.title; }
    if (p.subtitle) { $('#subtitleText').value = p.subtitle; }
    syncRectFromInputs();
    scheduleRender();
    fetchElevation();
  });
});

$('#btn-fetch').addEventListener('click', fetchElevation);

// Auto-fill subtitle with center coordinates
$('#btn-auto-coords').addEventListener('click', () => {
  const south = parseFloat($('#lat-south').value);
  const north = parseFloat($('#lat-north').value);
  const west = parseFloat($('#lng-west').value);
  const east = parseFloat($('#lng-east').value);
  if (isNaN(south) || isNaN(north) || isNaN(west) || isNaN(east)) return;
  const cLat = ((south + north) / 2);
  const cLng = ((west + east) / 2);
  const latDir = cLat >= 0 ? 'N' : 'S';
  const lngDir = cLng >= 0 ? 'E' : 'W';
  const text = `${Math.abs(cLat).toFixed(2)}\u00B0${latDir}, ${Math.abs(cLng).toFixed(2)}\u00B0${lngDir}`;
  $('#subtitleText').value = text;
  scheduleRender();
});

// Convert lat/lng to tile coordinates
function latLngToTile(lat, lng, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

// Load a terrain tile image and return its pixel data
function loadTilePixels(z, x, y) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);
      resolve({ data: imageData.data, width: img.width, height: img.height });
    };
    img.onerror = () => reject(new Error(`Failed to load tile ${z}/${x}/${y}`));
    img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  });
}

/**
 * Decode Terrarium RGB encoding to elevation in metres.
 * Formula: elevation = (R * 256 + G + B / 256) - 32768
 * @see https://github.com/tilezen/joerd/blob/master/docs/formats.md
 */
function terrariumElevation(r, g, b) {
  return (r * 256 + g + b / 256) - 32768;
}

/**
 * Fetch terrain tiles for the current bounding box, decode Terrarium RGB pixels
 * to elevation, and populate currentData. NaN values (missing tiles) are filled
 * via nearest-neighbour interpolation.
 */
async function fetchElevation() {
  const south = parseFloat($('#lat-south').value);
  const north = parseFloat($('#lat-north').value);
  const west = parseFloat($('#lng-west').value);
  const east = parseFloat($('#lng-east').value);
  const zoom = parseInt($('#zoom').value);

  if (south >= north || west >= east) {
    $('#api-status').textContent = 'Error: South must be < North, West must be < East';
    return;
  }

  const status = $('#api-status');
  showLoading(true);
  status.textContent = 'Calculating tiles...';

  try {
    const TILE_SIZE = 256;
    const topLeft = latLngToTile(north, west, zoom);
    const bottomRight = latLngToTile(south, east, zoom);
    const tileMinX = topLeft.x;
    const tileMaxX = bottomRight.x;
    const tileMinY = topLeft.y;
    const tileMaxY = bottomRight.y;
    const tilesX = tileMaxX - tileMinX + 1;
    const tilesY = tileMaxY - tileMinY + 1;
    const totalTiles = tilesX * tilesY;

    status.textContent = `Fetching ${totalTiles} tile${totalTiles > 1 ? 's' : ''}...`;

    const tileMap = {};
    const promises = [];
    for (let ty = tileMinY; ty <= tileMaxY; ty++) {
      for (let tx = tileMinX; tx <= tileMaxX; tx++) {
        const key = `${tx}_${ty}`;
        promises.push(
          loadTilePixels(zoom, tx, ty).then(pixels => { tileMap[key] = pixels; })
        );
      }
    }
    await Promise.all(promises);

    status.textContent = 'Decoding elevation...';

    const n = Math.pow(2, zoom);
    function lngToPxF(lng) {
      return ((lng + 180) / 360 * n - tileMinX) * TILE_SIZE;
    }
    function latToPxF(lat) {
      const latRad = lat * Math.PI / 180;
      return ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n - tileMinY) * TILE_SIZE;
    }

    const pxLeft = lngToPxF(west);
    const pxRight = lngToPxF(east);
    const pxTop = latToPxF(north);
    const pxBottom = latToPxF(south);

    const outCols = Math.min(Math.round(pxRight - pxLeft), 300);
    const outRows = Math.min(Math.round(pxBottom - pxTop), 300);

    const grid = [];
    let elevMin = Infinity, elevMax = -Infinity;

    // Helper: sample a single pixel from the composite tile grid
    function samplePixel(px, py) {
      const tileCol = Math.floor(px / TILE_SIZE);
      const tileRow = Math.floor(py / TILE_SIZE);
      const localX = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(px - tileCol * TILE_SIZE)));
      const localY = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(py - tileRow * TILE_SIZE)));
      const tileKey = `${tileMinX + tileCol}_${tileMinY + tileRow}`;
      const tile = tileMap[tileKey];
      if (!tile) return NaN;
      const idx = (localY * tile.width + localX) * 4;
      return terrariumElevation(tile.data[idx], tile.data[idx + 1], tile.data[idx + 2]);
    }

    for (let r = 0; r < outRows; r++) {
      const row = new Float64Array(outCols);
      const py = pxTop + (r / (outRows - 1)) * (pxBottom - pxTop);
      for (let c = 0; c < outCols; c++) {
        const px = pxLeft + (c / (outCols - 1)) * (pxRight - pxLeft);
        const elev = samplePixel(px, py);
        row[c] = elev;
        if (!isNaN(elev)) {
          if (elev < elevMin) elevMin = elev;
          if (elev > elevMax) elevMax = elev;
        }
      }
      grid.push(row);
    }

    // Fix NaN values: interpolate from nearest valid neighbours
    for (let r = 0; r < outRows; r++) {
      for (let c = 0; c < outCols; c++) {
        if (isNaN(grid[r][c])) {
          let found = false;
          for (let d = 1; d < Math.max(outRows, outCols) && !found; d++) {
            for (const [dr, dc] of [[0,-d],[0,d],[-d,0],[d,0]]) {
              const nr = r + dr, nc = c + dc;
              if (nr >= 0 && nr < outRows && nc >= 0 && nc < outCols && !isNaN(grid[nr][nc])) {
                grid[r][c] = grid[nr][nc];
                found = true;
                break;
              }
            }
          }
          if (!found) grid[r][c] = elevMin !== Infinity ? elevMin : 0;
        }
      }
    }

    currentData = { grid, rows: outRows, cols: outCols };
    status.textContent = `Loaded: ${outRows} × ${outCols} (${totalTiles} tiles, ${Math.round(elevMin)}–${Math.round(elevMax)} m)`;
    scheduleRender();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    console.error(err);
  }
  showLoading(false);
}

// ───────────── Export ─────────────
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Fetch the active Google Font's CSS and inline all @font-face rules as
 * base64 data URIs so the SVG renders correctly when rasterised to canvas.
 * Returns a <style> string ready to inject into an SVG <defs> block.
 */
async function getInlineFontStyle() {
  const fontFamily = readParam('titleFont');
  if (!fontFamily) return '';
  // Extract the bare family name (e.g. "'Bebas Neue', sans-serif" → "Bebas Neue")
  const match = fontFamily.match(/^'([^']+)'/);
  if (!match) return '';
  const family = match[1];

  try {
    // Fetch the Google Fonts CSS (request woff2 via user-agent hint)
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;700&display=swap`;
    const cssResp = await fetch(cssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const cssText = await cssResp.text();

    // Find all url() references and replace with base64 data URIs
    const urlPattern = /url\((https:\/\/[^)]+)\)/g;
    const urls = [...cssText.matchAll(urlPattern)].map(m => m[1]);
    let inlined = cssText;
    for (const fontUrl of urls) {
      try {
        const resp = await fetch(fontUrl);
        const buf = await resp.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        const ext = fontUrl.includes('.woff2') ? 'woff2' : 'woff';
        inlined = inlined.replace(fontUrl, `data:font/${ext};base64,${base64}`);
      } catch { /* skip failed font files */ }
    }
    return `<style>${inlined}</style>`;
  } catch {
    return '';
  }
}

$('#btn-export-svg').addEventListener('click', () => {
  const svgEl = preview.querySelector('svg');
  if (!svgEl) return;
  const blob = new Blob([svgEl.outerHTML], { type: 'image/svg+xml' });
  downloadBlob(blob, 'contourist.svg');
});

async function exportRaster(format) {
  const svgEl = preview.querySelector('svg');
  if (!svgEl) return;
  const scale = parseInt($('#exportScale').value) || 2;
  const W = parseFloat(svgEl.getAttribute('width'));
  const H = parseFloat(svgEl.getAttribute('height'));

  // Clone SVG and embed font for correct rasterisation
  const clone = svgEl.cloneNode(true);
  const fontStyle = await getInlineFontStyle();
  if (fontStyle) {
    const defsEl = clone.querySelector('defs') || document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    if (!clone.querySelector('defs')) clone.insertBefore(defsEl, clone.firstChild);
    defsEl.insertAdjacentHTML('beforeend', fontStyle);
  }

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');

  // For JPG, fill background first (no transparency support)
  if (format === 'jpeg') {
    ctx.fillStyle = readParam('bgColor') || '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const svgData = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const quality = format === 'jpeg' ? 0.92 : undefined;
    canvas.toBlob((canvasBlob) => {
      if (canvasBlob) {
        const ext = format === 'jpeg' ? 'jpg' : 'png';
        downloadBlob(canvasBlob, `contourist_${W * scale}x${H * scale}.${ext}`);
      }
    }, mimeType, quality);
  };
  img.src = url;
}

$('#btn-export-png').addEventListener('click', () => exportRaster('png'));
$('#btn-export-jpg').addEventListener('click', () => exportRaster('jpeg'));

// ───────────── Loading overlay ─────────────
function showLoading(show) {
  $('#loading').classList.toggle('active', show);
}

// ───────────── Zoom display ─────────────
$('#zoom').addEventListener('input', () => {
  $('#val-zoom').textContent = $('#zoom').value;
});

// ───────────── Init map immediately ─────────────
setTimeout(() => { initMap(); }, 100);

// ───────────── Initial render ─────────────
render();
