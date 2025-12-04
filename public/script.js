// public/script.js

let map;
let markersLayer;
let lastAircraft = [];
let distanceSortAscending = true;

function initMap() {
  const defaultLat = 43.700;
  const defaultLon = -65.117;

  map = L.map('map').setView([defaultLat, defaultLon], 9);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
}

function clearMarkers() {
  if (markersLayer) {
    markersLayer.clearLayers();
  }
}

function airportCodeFromIcao(icao) {
  if (!icao) return '';
  const up = icao.toUpperCase();

  // Simple heuristic: for North American ICAOs (KXXX / CXXX),
  // strip the leading K/C to get the common 3-letter code.
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
    if (line1) {
      labelHtml += `${line1}`;
    }
    if (line2) {
      labelHtml += `<br/>${line2}`;
    }
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

function renderView() {
  const tbody = document.getElementById('resultsBody');
  if (!tbody) return;

  tbody.innerHTML = '';
  clearMarkers();

  if (!lastAircraft || lastAircraft.length === 0) return;

  const sorted = [...lastAircraft];

  sorted.sort((a, b) => {
    const da = a.distanceKm != null ? a.distanceKm : Infinity;
    const db = b.distanceKm != null ? b.distanceKm : Infinity;
    if (distanceSortAscending) {
      return da - db;
    }
    return db - da;
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

document.addEventListener('DOMContentLoaded', () => {
  initMap();

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

  fetchAircraft();
});
