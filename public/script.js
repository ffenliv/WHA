// public/script.js

let map;
let markersLayer;
let trailLayer;
let lastAircraft = [];
let distanceSortAscending = true;

// trail history: key (icao24 or callsign) -> array of {lat, lon}
const trails = {};
const MAX_TRAIL_POINTS = 20;

function initMap() {
  const defaultLat = 43.700;
  const defaultLon = -65.117;

  map = L.map('map').setView([defaultLat, defaultLon], 9);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  // Trails under markers
  trailLayer = L.layerGroup().addTo(map);
  markersLayer = L.layerGroup().addTo(map);
}

function clearMarkers() {
  if (markersLayer) {
    markersLayer.clearLayers();
  }
  // Important: we do NOT clear trailLayer here; trails persist and are pruned
}

function airportCodeFromIcao(icao) {
  if (!icao) return '';
  const up = icao.toUpperCase();
  if (up.length === 4 && (up.startsWith('K') || up.startsWith('C'))) {
    return up.slice(1);
  }
  return up;
}

function addAircraftMarker(ac) {
  if (ac.lat == null || ac.lon == null) return;

  const lat = ac.lat;
  const lon = ac.lon;
  const heading = ac.headingDeg != null ? ac.headingDeg : 0;

  const spdShort = ac.speedKt != null ? Math.round(ac.speedKt) : null;
  const altShort = ac.altitudeFt != null ? Math.round(ac.altitudeFt) : null;

  // Flight level text
  let flightLevelText = '';
  if (altShort != null && altShort > 0) {
    const roundedForFl =
      altShort < 10000
        ? Math.round(altShort / 1000) * 1000
        : Math.round(altShort / 2000) * 2000;

    const fl = Math.round(roundedForFl / 100);
    flightLevelText = 'FL' + fl.toString().padStart(3, '0');
  }

  const line1Parts = [];
  if (spdShort != null) line1Parts.push(`${spdShort}kt`);
  if (flightLevelText) line1Parts.push(flightLevelText);
  const line1 = line1Parts.join(' ');

  const originCode = airportCodeFromIcao(ac.originIcao);
  const destCode = airportCodeFromIcao(ac.destinationIcao);
  const line2 =
    originCode && destCode ? `${originCode} → ${destCode}` : '';

  let labelHtml = '';
  if (line1 || line2) {
    labelHtml += `<div class="aircraft-label">`;
    if (line1) labelHtml += `${line1}`;
    if (line2) labelHtml += `<br/>${line2}`;
    labelHtml += '</div>';
  }

  const icon = L.divIcon({
    className: 'aircraft-arrow-icon',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    html: `
      <div class="aircraft-arrow" style="transform: rotate(${heading}deg);"></div>
      ${labelHtml}
    `
  });

  const marker = L.marker([lat, lon], { icon });

  const altText = altShort != null ? altShort + ' ft' : 'N/A';
  const spdText = spdShort != null ? spdShort + ' kt' : 'N/A';
  const lookText =
    ac.lookDirection && ac.bearingDeg != null
      ? `${ac.lookDirection} (${ac.bearingDeg.toFixed(1)}°)`
      : 'N/A';
  const distText =
    ac.distanceKm != null ? ac.distanceKm.toFixed(1) + ' km' : 'N/A';

  const flightAwareUrl = ac.callsign
    ? `https://flightaware.com/live/flight/${encodeURIComponent(
        ac.callsign.trim()
      )}`
    : null;

  const popupHtml = `
    <strong>${ac.callsign || ''}</strong><br/>
    Model: ${ac.model || ''}<br/>
    Airline: ${ac.airline || ''}<br/>
    Origin: ${ac.originDisplay || ''}<br/>
    Destination: ${ac.destinationDisplay || ''}<br/>
    Alt: ${altText}<br/>
    Speed: ${spdText}<br/>
    Heading: ${
      ac.headingDeg != null ? ac.headingDeg.toFixed(0) + '°' : 'N/A'
    }<br/>
    Distance: ${distText}<br/>
    Look: ${lookText}<br/>
    FlightAware: ${
      flightAwareUrl
        ? `<a href="${flightAwareUrl}" target="_blank" rel="noopener noreferrer">${ac.callsign}</a>`
        : 'N/A'
    }
  `;

  marker.bindPopup(popupHtml);
  marker.addTo(markersLayer);
}

// Update in-memory trails based on lastAircraft, then redraw polylines
function updateAndDrawTrails() {
  if (!trailLayer || !map) return;

  // Build set of active keys this frame
  const activeKeys = new Set();

  // Update trails with latest positions
  for (const ac of lastAircraft) {
    if (ac.lat == null || ac.lon == null) continue;
    const key = ac.icao24 || ac.callsign;
    if (!key) continue;
    activeKeys.add(key);

    if (!trails[key]) {
      trails[key] = [];
    }
    const list = trails[key];
    const lastPoint = list[list.length - 1];
    if (!lastPoint || lastPoint.lat !== ac.lat || lastPoint.lon !== ac.lon) {
      list.push({ lat: ac.lat, lon: ac.lon });
      if (list.length > MAX_TRAIL_POINTS) {
        list.shift();
      }
    }
  }

  // Remove trails for aircraft no longer present
  for (const key of Object.keys(trails)) {
    if (!activeKeys.has(key)) {
      delete trails[key];
    }
  }

  // Redraw all trail polylines
  trailLayer.clearLayers();
  for (const key of Object.keys(trails)) {
    const pts = trails[key];
    if (!pts || pts.length < 2) continue;
    const latlngs = pts.map((p) => [p.lat, p.lon]);
    L.polyline(latlngs, {
      color: 'blue',
      weight: 2,
      opacity: 0.5
    }).addTo(trailLayer);
  }
}

// Stats tab rendering
function renderStats() {
  const statsEl = document.getElementById('statsContent');
  if (!statsEl) return;

  if (!lastAircraft || lastAircraft.length === 0) {
    statsEl.innerHTML = '<p>No aircraft data available.</p>';
    return;
  }

  const total = lastAircraft.length;

  // Altitude bands
  const bands = {
    '<5000': 0,
    '5k–10k': 0,
    '10k–20k': 0,
    '>20k': 0
  };

  // Airline counts
  const airlineCounts = {};

  // Distances
  let distSum = 0;
  let distCount = 0;
  let maxDist = 0;

  for (const ac of lastAircraft) {
    const alt = ac.altitudeFt != null ? ac.altitudeFt : null;
    if (alt != null) {
      if (alt < 5000) bands['<5000']++;
      else if (alt < 10000) bands['5k–10k']++;
      else if (alt < 20000) bands['10k–20k']++;
      else bands['>20k']++;
    }

    const airline = ac.airline || 'Unknown';
    airlineCounts[airline] = (airlineCounts[airline] || 0) + 1;

    if (ac.distanceKm != null) {
      distSum += ac.distanceKm;
      distCount++;
      if (ac.distanceKm > maxDist) {
        maxDist = ac.distanceKm;
      }
    }
  }

  const avgDist = distCount > 0 ? distSum / distCount : null;

  // Top airlines by count
  const topAirlines = Object.entries(airlineCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  let html = '';

  html += `<h2>Current Stats</h2>`;
  html += `<p><strong>Total aircraft:</strong> ${total}</p>`;

  if (avgDist != null) {
    html += `<p><strong>Average distance from observer:</strong> ${avgDist.toFixed(
      1
    )} km (max ${maxDist.toFixed(1)} km)</p>`;
  }

  html += `
    <h3>Altitude Distribution</h3>
    <table>
      <thead>
        <tr>
          <th>Band</th>
          <th>Count</th>
        </tr>
      </thead>
      <tbody>
        <tr><td>&lt; 5,000 ft</td><td>${bands['<5000']}</td></tr>
        <tr><td>5,000–10,000 ft</td><td>${bands['5k–10k']}</td></tr>
        <tr><td>10,000–20,000 ft</td><td>${bands['10k–20k']}</td></tr>
        <tr><td>&gt; 20,000 ft</td><td>${bands['>20k']}</td></tr>
      </tbody>
    </table>
  `;

  html += `
    <h3>Top Airlines (by count)</h3>
    <table>
      <thead>
        <tr>
          <th>Airline</th>
          <th>Count</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const [airline, count] of topAirlines) {
    html += `<tr><td>${airline}</td><td>${count}</td></tr>`;
  }

  html += `
      </tbody>
    </table>
  `;

  statsEl.innerHTML = html;
}

function renderView() {
  const tbody = document.getElementById('resultsBody');
  if (!tbody) return;

  tbody.innerHTML = '';
  clearMarkers();

  if (!lastAircraft || lastAircraft.length === 0) {
    // still update stats (shows "no data")
    renderStats();
    updateAndDrawTrails();
    return;
  }

  const sorted = [...lastAircraft];

  sorted.sort((a, b) => {
    const da = a.distanceKm != null ? a.distanceKm : Infinity;
    const db = b.distanceKm != null ? b.distanceKm : Infinity;
    return distanceSortAscending ? da - db : db - da;
  });

  for (const ac of sorted) {
    const tr = document.createElement('tr');

    function cell(text) {
      const td = document.createElement('td');
      td.textContent = text ?? '';
      return td;
    }

    const altText =
      ac.altitudeFt != null ? Math.round(ac.altitudeFt).toString() : '';
    const spdText =
      ac.speedKt != null ? Math.round(ac.speedKt).toString() : '';
    let lookText = '';
    if (ac.lookDirection && ac.bearingDeg != null) {
      lookText = `${ac.lookDirection} (${ac.bearingDeg.toFixed(1)}°)`;
    }
    const distText =
      ac.distanceKm != null ? ac.distanceKm.toFixed(1) : '';

    tr.appendChild(cell(ac.callsign || ''));
    tr.appendChild(cell(ac.airline || ''));
    tr.appendChild(cell(ac.originDisplay || ''));
    tr.appendChild(cell(ac.destinationDisplay || ''));
    tr.appendChild(cell(ac.model || ''));
    tr.appendChild(cell(altText));
    tr.appendChild(cell(spdText));
    tr.appendChild(cell(distText));
    tr.appendChild(cell(lookText));

    tbody.appendChild(tr);

    addAircraftMarker(ac);
  }

  // After markers/table are updated, update trails and stats
  updateAndDrawTrails();
  renderStats();
}

async function fetchAircraft() {
  const locationSelect = document.getElementById('locationSelect');
  const radiusSelect = document.getElementById('radiusSelect');
  const statusEl = document.getElementById('status');

  const loc = locationSelect.value;
  const radiusKm = radiusSelect ? radiusSelect.value : '';

  statusEl.textContent = 'Loading...';
  lastAircraft = [];
  clearMarkers();
  renderView();

  try {
    const params = new URLSearchParams();
    params.set('location', loc);
    if (radiusKm) {
      params.set('radiusKm', radiusKm);
    }

    const resp = await fetch(`/api/aircraft?${params.toString()}`);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();

    const aircraft = data.aircraft || [];
    const locName = data.location || '';
    const centerLat = data.centerLat;
    const centerLon = data.centerLon;
    const radiusKmUsed = data.radiusKm || radiusKm || 0;
    const cloudCeilingFt = data.cloudCeilingFt;

    if (map && centerLat != null && centerLon != null) {
      map.setView([centerLat, centerLon], 9);
    }

    let statusText = '';
    if (aircraft.length === 0) {
      statusText = `No aircraft currently reported within ~${radiusKmUsed} km of ${locName}.`;
    } else {
      statusText = `Found ${aircraft.length} aircraft within ~${radiusKmUsed} km of ${locName}.`;
    }

    if (cloudCeilingFt != null) {
      statusText += ` | Cloud ceiling near Lockeport (CYQI): ${Math.round(
        cloudCeilingFt
      )} ft`;
    }

    statusEl.textContent = statusText;

    lastAircraft = aircraft;
    renderView();
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error fetching data: ${err.message}`;
  }
}


function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchHistory() {
  const dateInput = document.getElementById('historyDate');
  const flightKeyInput = document.getElementById('historyFlightKey');
  const limitInput = document.getElementById('historyLimit');
  const statusEl = document.getElementById('historyStatus');
  const table = document.getElementById('historyTable');
  const tbody = document.getElementById('historyBody');

  if (!dateInput || !statusEl || !table || !tbody) {
    return;
  }

  const date = dateInput.value || todayISO();
  const flightKey = flightKeyInput ? flightKeyInput.value.trim() : '';
  const limit = limitInput ? limitInput.value : '500';

  const url = new URL('/api/flight-history', window.location.origin);
  url.searchParams.set('date', date);
  url.searchParams.set('limit', limit || '500');
  if (flightKey) {
    url.searchParams.set('flightKey', flightKey);
  }

  statusEl.textContent = 'Loading history...';
  tbody.innerHTML = '';

  try {
    const resp = await fetch(url.toString());
    if (!resp.ok) {
      throw new Error('HTTP ' + resp.status);
    }
    const data = await resp.json();

    if (!Array.isArray(data) || data.length === 0) {
      statusEl.textContent = `No history entries found for ${date}.`;
      table.style.display = 'none';
      return;
    }

    statusEl.textContent = `Loaded ${data.length} entr${data.length === 1 ? 'y' : 'ies'} for ${date}.`;

    for (const entry of data) {
      const tr = document.createElement('tr');

      const dateTd = document.createElement('td');
      dateTd.textContent = entry.date || '';
      tr.appendChild(dateTd);

      const flightTd = document.createElement('td');
      const keyDiv = document.createElement('div');
      keyDiv.textContent = entry.flightKey || '';
      const metaDiv = document.createElement('div');
      metaDiv.className = 'history-flight-meta';
      const metaParts = [];
      if (entry.callsign) metaParts.push(entry.callsign);
      if (entry.icao24) metaParts.push(entry.icao24);
      metaDiv.textContent = metaParts.join(' · ');
      flightTd.appendChild(keyDiv);
      if (metaDiv.textContent) {
        flightTd.appendChild(metaDiv);
      }
      tr.appendChild(flightTd);

      const locTd = document.createElement('td');
      const locName = entry.locationName || '(unknown)';
      const locParts = [];
      if (entry.locationKey) locParts.push(`Key ${entry.locationKey}`);
      if (entry.radiusKm != null) locParts.push(`Radius ${entry.radiusKm} km`);
      const locMeta = locParts.join(' · ');
      locTd.innerHTML = `<div>${locName}</div>`;
      if (locMeta) {
        const span = document.createElement('div');
        span.className = 'history-meta';
        span.textContent = locMeta;
        locTd.appendChild(span);
      }
      tr.appendChild(locTd);

      const routeTd = document.createElement('td');
      const origin = entry.originIcao || '';
      const dest = entry.destinationIcao || '';
      if (origin || dest) {
        routeTd.textContent = `${origin || '???'} → ${dest || '???'}`;
      } else {
        routeTd.textContent = '';
      }
      tr.appendChild(routeTd);

      const loggedTd = document.createElement('td');
      loggedTd.textContent = entry.loggedAt || '';
      tr.appendChild(loggedTd);

      tbody.appendChild(tr);
    }

    table.style.display = 'table';
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Error loading history: ' + err.message;
    table.style.display = 'none';
  }
}

function initTabs() {
  const buttons = document.querySelectorAll('.tab-button');
  const panels = document.querySelectorAll('.tab-panel');

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-tab');

      buttons.forEach((b) => b.classList.remove('active'));
      panels.forEach((p) => p.classList.remove('active'));

      btn.classList.add('active');
      const targetPanel = document.getElementById(targetId);
      if (targetPanel) {
        targetPanel.classList.add('active');
      }

      if (targetId === 'mapTab' && map) {
        setTimeout(() => {
          map.invalidateSize();
        }, 0);
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initTabs();

  const refreshBtn = document.getElementById('refreshBtn');
  const radiusSelect = document.getElementById('radiusSelect');
  const locationSelect = document.getElementById('locationSelect');
  const distanceHeader = document.getElementById('distanceHeader');

  refreshBtn.addEventListener('click', fetchAircraft);

  if (radiusSelect) {
    radiusSelect.addEventListener('change', fetchAircraft);
  }
  if (locationSelect) {
    locationSelect.addEventListener('change', fetchAircraft);
  }
  if (distanceHeader) {
    distanceHeader.addEventListener('click', () => {
      distanceSortAscending = !distanceSortAscending;
      renderView();
    });
  }

  // History tab wiring
  const historyDate = document.getElementById('historyDate');
  const historyRefreshBtn = document.getElementById('historyRefreshBtn');
  if (historyDate) {
    historyDate.value = todayISO();
  }
  if (historyRefreshBtn) {
    historyRefreshBtn.addEventListener('click', () => {
      fetchHistory();
    });
  }

  fetchAircraft();
});
