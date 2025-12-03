// server.js
//
// Node/Express app that:
//  - Serves a web UI (public/index.html)
//  - Provides /api/aircraft?location=1|2|3
//  - Calls ADSB.lol for aircraft near the selected location
//  - Computes bearing + direction from observer at 43.687737, -65.128691
//  - Fetches cloud ceiling (ft) near Lockeport via AviationWeather METAR API (CYQI)
//  - Uses adsbdb.com, AviationStack, and an OpenSky static routes CSV
//    + OpenFlights / OurAirports data to infer origin/destination city+country
//  - Frontend shows FL labels + route codes on map markers

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------

const RADIUS_KM = 100.0;
const NM_PER_KM = 1.0 / 1.852; // 1 nautical mile ≈ 1.852 km
const RADIUS_NM = Math.round(RADIUS_KM * NM_PER_KM);

const ADSBLOL_URL_TEMPLATE =
  'https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{radius}';

// Free public route API
const ADSBDB_ROUTE_URL = 'https://api.adsbdb.com/v0/callsign/';

// AviationStack API key (from environment variable)
const AVIATIONSTACK_API_KEY = process.env.AVIATION_STACK_API_KEY || null;
const AVIATIONSTACK_FLIGHTS_URL = 'https://api.aviationstack.com/v1/flights';

// OpenFlights airports data (CSV) – includes ICAO, city, country
const OPENFLIGHTS_AIRPORTS_URL =
  'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat';

// OurAirports countries data – name → ISO 2-letter code
const OURAIRPORTS_COUNTRIES_URL =
  'https://ourairports.com/data/countries.csv';

// Local OpenSky static routes CSV (user must download + place here)
// Expected to be named opensky_route_data.csv in the project root
const OPENSKY_ROUTES_CSV_PATH = path.join(__dirname, 'opensky_route_data.csv');

const LOCATIONS = {
  '1': { name: 'Port Elgin, Ontario', lat: 44.434, lon: -81.393 },
  '2': { name: 'Lockeport, Nova Scotia', lat: 43.700, lon: -65.117 },
  '3': { name: 'Mississauga, Ontario', lat: 43.5890, lon: -79.6441 }
};

// Observer position for direction/bearing
const OBS_LAT = 43.687737;
const OBS_LON = -65.128691;

// Nearest METAR station to Lockeport (approx) – Yarmouth Airport
const LOCKEPORT_METAR_STATION = 'CYQI';

// Simple airline mapping by callsign prefix (expand as desired)
const AIRLINE_BY_ICAO_PREFIX = {
  ACA: 'Air Canada',
  JZA: 'Jazz Aviation',
  ROU: 'Air Canada Rouge',
  WJA: 'WestJet',
  WEN: 'WestJet Encore',
  TSC: 'Air Transat',
  POE: 'Porter Airlines',
  QTR: 'Qatar Airways',
  BAW: 'British Airways',
  AFR: 'Air France',
  DLH: 'Lufthansa',
  KLM: 'KLM Royal Dutch Airlines',
  UAL: 'United Airlines',
  AAL: 'American Airlines',
  DAL: 'Delta Air Lines',
  JBU: 'JetBlue',
  SWA: 'Southwest Airlines'
};

// ---------------------------------------------------------------------
// MATH HELPERS
// ---------------------------------------------------------------------

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

// Compute initial bearing from lat1/lon1 → lat2/lon2
function bearingDegrees(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);

  const x = Math.sin(dLon) * Math.cos(phi2);
  const y =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);

  const brng = toDeg(Math.atan2(x, y));
  return (brng + 360) % 360; // normalize to [0, 360)
}

function bearingToDirection(brng) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.floor((brng + 22.5) / 45) % 8;
  return dirs[idx];
}

// ---------------------------------------------------------------------
// CSV HELPER (simple parser that handles quoted fields)
// ---------------------------------------------------------------------

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current);
  return result;
}

// ---------------------------------------------------------------------
// In-memory DB: airports + countries
// ---------------------------------------------------------------------

let airportsByIcao = null; // { ICAO: { city, countryName } }
let countryNameToIso2 = null; // { "Canada": "CA", ... }

async function loadCountryDb() {
  if (countryNameToIso2) return countryNameToIso2;

  try {
    const resp = await axios.get(OURAIRPORTS_COUNTRIES_URL, {
      timeout: 15000,
      responseType: 'text'
    });
    const text = resp.data;
    const lines = text.split(/\r?\n/);
    const map = {};

    const header = lines[0] || '';
    const headerCols = parseCsvLine(header);
    const codeIdx = headerCols.indexOf('code');
    const nameIdx = headerCols.indexOf('name');

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = parseCsvLine(line);
      const code = cols[codeIdx];
      const name = cols[nameIdx];
      if (!code || !name) continue;
      map[name] = code;
    }
    countryNameToIso2 = map;
  } catch (err) {
    console.error('[AIRPORTS] Failed to load countries:', err.message);
    countryNameToIso2 = {};
  }

  return countryNameToIso2;
}

async function loadAirportDb() {
  if (airportsByIcao) return airportsByIcao;

  try {
    const resp = await axios.get(OPENFLIGHTS_AIRPORTS_URL, {
      timeout: 20000,
      responseType: 'text'
    });
    const text = resp.data;
    const lines = text.split(/\r?\n/);
    const map = {};

    for (const line of lines) {
      if (!line.trim()) continue;
      const cols = parseCsvLine(line);
      if (cols.length < 6) continue;
      const city = cols[2];
      const countryName = cols[3];
      const icao = cols[5];
      if (!icao) continue;
      map[icao.toUpperCase()] = {
        city,
        countryName
      };
    }

    airportsByIcao = map;
  } catch (err) {
    console.error('[AIRPORTS] Failed to load airports:', err.message);
    airportsByIcao = {};
  }

  return airportsByIcao;
}

async function getAirportDisplay(icaoCode) {
  if (!icaoCode) return null;
  const icao = icaoCode.toUpperCase();

  const [airports, countries] = await Promise.all([
    loadAirportDb(),
    loadCountryDb()
  ]);

  const info = airports[icao];
  if (!info) return null;

  const city = info.city || '';
  const countryName = info.countryName || '';
  const iso2 = countries[countryName] || null;

  if (!city && !countryName) return null;

  if (city && iso2) {
    return `${city}, ${iso2}`;
  } else if (city && countryName) {
    return `${city}, ${countryName}`;
  } else if (city) {
    return city;
  } else if (countryName) {
    return countryName;
  }
  return null;
}

// ---------------------------------------------------------------------
// OpenSky static routes CSV (local file)
// ---------------------------------------------------------------------

let openskyRoutesByCallsign = null; // { CALLSIGN: { originIcao, destinationIcao } }

function loadOpenSkyRoutesDb() {
  if (openskyRoutesByCallsign !== null) return openskyRoutesByCallsign;

  const map = {};
  if (!fs.existsSync(OPENSKY_ROUTES_CSV_PATH)) {
    console.warn(
      '[OPENSKY ROUTES] File not found at',
      OPENSKY_ROUTES_CSV_PATH,
      '- skipping static routes.'
    );
    openskyRoutesByCallsign = map;
    return openskyRoutesByCallsign;
  }

  try {
    const raw = fs.readFileSync(OPENSKY_ROUTES_CSV_PATH, 'utf8');
    const lines = raw.split(/\r?\n/);
    if (lines.length < 2) {
      openskyRoutesByCallsign = map;
      return openskyRoutesByCallsign;
    }

    const header = parseCsvLine(lines[0]);
    const lowerHeader = header.map((h) => (h || '').toLowerCase());

    // Try to find relevant columns by name heuristic
    const callsignIdx =
      lowerHeader.indexOf('callsign') >= 0
        ? lowerHeader.indexOf('callsign')
        : lowerHeader.findIndex((h) => h.includes('callsign'));

    const originIdxCandidates = [
      'origin',
      'originairport',
      'origin_airport',
      'departureairport',
      'departure_airport',
      'estdepartureairport'
    ];
    const destIdxCandidates = [
      'destination',
      'destinationairport',
      'destination_airport',
      'arrivalairport',
      'arrival_airport',
      'estarrivalairport'
    ];

    const originIdx = lowerHeader.findIndex((h) =>
      originIdxCandidates.some((key) => h === key)
    );
    const destIdx = lowerHeader.findIndex((h) =>
      destIdxCandidates.some((key) => h === key)
    );

    if (callsignIdx < 0 || originIdx < 0 || destIdx < 0) {
      console.warn(
        '[OPENSKY ROUTES] Could not find expected columns (callsign/origin/destination).'
      );
      openskyRoutesByCallsign = map;
      return openskyRoutesByCallsign;
    }

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = parseCsvLine(line);
      if (cols.length <= destIdx) continue;

      const cs = (cols[callsignIdx] || '').trim().toUpperCase();
      const origin = (cols[originIdx] || '').trim().toUpperCase();
      const dest = (cols[destIdx] || '').trim().toUpperCase();
      if (!cs || !origin || !dest) continue;

      // Normalize callsign by stripping spaces
      const key = cs.replace(/\s+/g, '');
      if (!key) continue;

      if (!map[key]) {
        map[key] = {
          originIcao: origin,
          destinationIcao: dest
        };
      }
    }

    console.log(
      '[OPENSKY ROUTES] Loaded',
      Object.keys(map).length,
      'routes from CSV.'
    );
  } catch (err) {
    console.error('[OPENSKY ROUTES] Error loading CSV:', err.message);
  }

  openskyRoutesByCallsign = map;
  return openskyRoutesByCallsign;
}

async function fetchRouteFromOpenSkyStatic(callsignKey) {
  const routes = loadOpenSkyRoutesDb();
  if (!routes || !Object.keys(routes).length) return null;

  // We store keys without spaces
  const keyNoSpaces = callsignKey.replace(/\s+/g, '');
  const hit = routes[keyNoSpaces];
  if (!hit) return null;

  return {
    originIcao: hit.originIcao,
    destinationIcao: hit.destinationIcao
  };
}

// ---------------------------------------------------------------------
// ADSB.lol fetch
// ---------------------------------------------------------------------

async function fetchAircraftRaw(lat, lon, radiusNm) {
  const url = ADSBLOL_URL_TEMPLATE
    .replace('{lat}', String(lat))
    .replace('{lon}', String(lon))
    .replace('{radius}', String(radiusNm));

  try {
    const resp = await axios.get(url, { timeout: 15000 });
    return resp.data || {};
  } catch (err) {
    console.error('[ADSB] Error contacting ADSB.lol:', err.message);
    return {};
  }
}

// ---------------------------------------------------------------------
// Route lookup via adsbdb.com + AviationStack + OpenSky static
// ---------------------------------------------------------------------

const routeCache = {}; // callsign -> { originIcao, destinationIcao } or null

async function fetchRouteFromAdsbdb(callsignKey) {
  const url = ADSBDB_ROUTE_URL + encodeURIComponent(callsignKey);

  try {
    const resp = await axios.get(url, { timeout: 8000 });
    const data = resp.data || {};

    let origin = data.origin;
    let destination = data.destination;

    if ((!origin || !destination) && data.route) {
      origin = origin || data.route.origin;
      destination = destination || data.route.destination;
    }

    if (!origin || !destination) {
      return null;
    }

    return {
      originIcao: String(origin).toUpperCase(),
      destinationIcao: String(destination).toUpperCase()
    };
  } catch (err) {
    console.error('[ROUTE] adsbdb error for', callsignKey, ':', err.message);
    return null;
  }
}

async function fetchRouteFromAviationStack(callsignKey) {
  if (!AVIATIONSTACK_API_KEY) return null;

  try {
    const resp = await axios.get(AVIATIONSTACK_FLIGHTS_URL, {
      timeout: 8000,
      params: {
        access_key: AVIATIONSTACK_API_KEY,
        flight_icao: callsignKey
      }
    });

    const body = resp.data || {};
    const flights = Array.isArray(body.data) ? body.data : [];
    if (!flights.length) return null;

    const f = flights[0] || {};
    const dep = f.departure || {};
    const arr = f.arrival || {};

    const originIcao = dep.icao || dep.icao_code || null;
    const destinationIcao = arr.icao || arr.icao_code || null;

    if (!originIcao || !destinationIcao) {
      return null;
    }

    return {
      originIcao: String(originIcao).toUpperCase(),
      destinationIcao: String(destinationIcao).toUpperCase()
    };
  } catch (err) {
    if (err.response) {
      console.error(
        '[ROUTE] AviationStack error for',
        callsignKey,
        'status=',
        err.response.status,
        'data=',
        JSON.stringify(err.response.data)
      );
      if (err.response.status === 404) {
        return null;
      }
    } else {
      console.error('[ROUTE] AviationStack request failed:', err.message);
    }
    return null;
  }
}

async function fetchRouteForCallsign(callsign) {
  if (!callsign) return null;
  const key = callsign.trim().toUpperCase();
  if (!key) return null;

  if (Object.prototype.hasOwnProperty.call(routeCache, key)) {
    return routeCache[key];
  }

  // 1) adsbdb
  const fromAdsbdb = await fetchRouteFromAdsbdb(key);
  if (fromAdsbdb) {
    routeCache[key] = fromAdsbdb;
    return fromAdsbdb;
  }

  // 2) AviationStack
  const fromAviationStack = await fetchRouteFromAviationStack(key);
  if (fromAviationStack) {
    routeCache[key] = fromAviationStack;
    return fromAviationStack;
  }

  // 3) OpenSky static routes (local CSV)
  const fromOpenSky = await fetchRouteFromOpenSkyStatic(key);
  if (fromOpenSky) {
    routeCache[key] = fromOpenSky;
    return fromOpenSky;
  }

  routeCache[key] = null;
  return null;
}

// ---------------------------------------------------------------------
// AIRCRAFT FORMATTER
// ---------------------------------------------------------------------

function inferAirlineFromCallsign(flight) {
  if (!flight) return '';
  const letters = flight.replace(/[^A-Za-z]/g, '').toUpperCase();
  if (!letters) return '';
  const prefix = letters.slice(0, 3);
  return AIRLINE_BY_ICAO_PREFIX[prefix] || '';
}

function baseFormatAircraft(ac) {
  const callsign = (ac.flight || ac.Call || '').trim();
  const icao24 = (ac.hex || ac.Icao || '').trim();

  const mdl = ac.mdl || ac.Mdl || '';
  const t = ac.t || ac.Type || '';
  let model = '';
  if (mdl && t) model = `${mdl} (${t})`;
  else model = mdl || t || '';

  let airline = (ac.Op || ac.op || ac.operator || '').trim();
  if (!airline) {
    airline = inferAirlineFromCallsign(callsign);
  }

  const alt =
    ac.alt_baro != null
      ? Number(ac.alt_baro)
      : ac.Alt != null
      ? Number(ac.Alt)
      : null;
  const gs =
    ac.gs != null ? Number(ac.gs) : ac.Spd != null ? Number(ac.Spd) : null;

  const lat = ac.lat != null ? Number(ac.lat) : null;
  const lon = ac.lon != null ? Number(ac.lon) : null;

  const trackRaw =
    ac.track != null
      ? Number(ac.track)
      : ac.trak != null
      ? Number(ac.trak)
      : ac.Trak != null
      ? Number(ac.Trak)
      : null;
  const headingDeg = Number.isFinite(trackRaw) ? trackRaw : null;

  let bearingDeg = null;
  let lookDirection = null;
  if (lat != null && lon != null && !Number.isNaN(lat) && !Number.isNaN(lon)) {
    const br = bearingDegrees(OBS_LAT, OBS_LON, lat, lon);
    bearingDeg = Math.round(br * 10) / 10;
    lookDirection = bearingToDirection(br);
  }

  return {
    callsign,
    icao24,
    model,
    airline,
    altitudeFt: Number.isFinite(alt) ? alt : null,
    speedKt: Number.isFinite(gs) ? gs : null,
    lookDirection,
    bearingDeg,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    headingDeg,

    originIcao: null,
    destinationIcao: null,
    originDisplay: null,
    destinationDisplay: null
  };
}

async function enrichAircraftWithRoutes(aircraftList) {
  const tasks = aircraftList.map(async (ac) => {
    if (!ac.callsign) return ac;

    try {
      const route = await fetchRouteForCallsign(ac.callsign);
      if (!route) return ac;

      ac.originIcao = route.originIcao;
      ac.destinationIcao = route.destinationIcao;

      const [originDisplay, destDisplay] = await Promise.all([
        getAirportDisplay(route.originIcao),
        getAirportDisplay(route.destinationIcao)
      ]);

      ac.originDisplay = originDisplay;
      ac.destinationDisplay = destDisplay;
    } catch (err) {
      console.error('[ROUTE] Error enriching aircraft', ac.callsign, err.message);
    }

    return ac;
  });

  return Promise.all(tasks);
}

// ---------------------------------------------------------------------
// Cloud ceiling via AviationWeather METAR API (free, no key)
// ---------------------------------------------------------------------

async function fetchCloudCeilingForLockeport() {
  const station = LOCKEPORT_METAR_STATION;
  const url = `https://aviationweather.gov/api/data/metar?ids=${station}&format=json`;

  try {
    const resp = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'adsbviewer-node (example@example.com)'
      }
    });

    const arr = resp.data;
    if (!Array.isArray(arr) || arr.length === 0) {
      return null;
    }

    const metar = arr[0];
    const sky = metar.skyCondition;
    if (!Array.isArray(sky)) return null;

    let lowestCeilingFt = null;

    for (const layer of sky) {
      const cover = layer.cover;
      const baseHundreds = layer.base;
      if (!cover || baseHundreds == null) continue;

      if (cover === 'BKN' || cover === 'OVC') {
        const baseFt = Number(baseHundreds) * 100;
        if (!Number.isFinite(baseFt)) continue;
        if (lowestCeilingFt == null || baseFt < lowestCeilingFt) {
          lowestCeilingFt = baseFt;
        }
      }
    }

    return lowestCeilingFt;
  } catch (err) {
    console.error('[METAR] Error fetching METAR:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// Combine everything for one location
// ---------------------------------------------------------------------

async function getAircraftForLocationKey(locationKey) {
  const loc = LOCATIONS[locationKey] || LOCATIONS['2'];
  const data = await fetchAircraftRaw(loc.lat, loc.lon, RADIUS_NM);
  const rawList = Array.isArray(data.ac) ? data.ac : [];

  const baseAircraft = rawList.map(baseFormatAircraft);
  const aircraft = await enrichAircraftWithRoutes(baseAircraft);

  let cloudCeilingFt = null;
  if (locationKey === '2') {
    cloudCeilingFt = await fetchCloudCeilingForLockeport();
  }

  return {
    locationKey,
    location: loc.name,
    centerLat: loc.lat,
    centerLon: loc.lon,
    radiusKm: RADIUS_KM,
    cloudCeilingFt,
    aircraft
  };
}

// ---------------------------------------------------------------------
// EXPRESS SETUP
// ---------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/aircraft', async (req, res) => {
  const location = req.query.location || '2';
  try {
    const result = await getAircraftForLocationKey(location);
    res.json(result);
  } catch (err) {
    console.error('[API] Error in /api/aircraft:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ADSBViewer Node app listening on http://localhost:${PORT}`);
});
