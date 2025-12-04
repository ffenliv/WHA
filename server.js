// server.js
//
// Full-feature ADS-B viewer Node/Express app with:
//  - ADSB.lol data source
//  - Multiple locations & radius selection
//  - Bearing/direction and distance from observer
//  - Cloud ceiling from AviationWeather METAR (CYQI)
//  - Route lookup via adsbdb + AeroDataBox + AviationStack
//  - Airport city/country via OpenFlights + OurAirports
//  - Frontend with map + data table in tabs, red triangle markers, FL labels, FlightAware link

require('dotenv').config();

const express = require('express');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------

const DEFAULT_RADIUS_KM = 100.0;
const NM_PER_KM = 1.0 / 1.852; // 1 nautical mile ≈ 1.852 km

const ADSBLOL_URL_TEMPLATE =
  'https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{radius}';

// adsbdb route API
const ADSBDB_ROUTE_URL = 'https://api.adsbdb.com/v0/callsign/';

// AviationStack API (optional, from environment)
const AVIATIONSTACK_API_KEY = process.env.AVIATION_STACK_API_KEY || null;
const AVIATIONSTACK_FLIGHTS_URL = 'https://api.aviationstack.com/v1/flights';

// AeroDataBox API via RapidAPI (optional, from environment)
const AERODATABOX_API_KEY = process.env.AERODATABOX_API_KEY || null;
const AERODATABOX_HOST =
  process.env.AERODATABOX_HOST || 'aerodatabox.p.rapidapi.com';

const AERODATABOX_FLIGHT_URL_TEMPLATE =
  'https://aerodatabox.p.rapidapi.com/flights/number/{flightNumber}';

// OpenFlights airports data (CSV)
const OPENFLIGHTS_AIRPORTS_URL =
  'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat';

// OurAirports countries data
const OURAIRPORTS_COUNTRIES_URL =
  'https://ourairports.com/data/countries.csv';

// Observer locations
const LOCATIONS = {
  '1': { name: 'Port Elgin, Ontario', lat: 44.434, lon: -81.393 },
  '2': { name: 'Lockeport, Nova Scotia', lat: 43.700, lon: -65.117 },
  '3': { name: 'Mississauga, Ontario', lat: 43.5890, lon: -79.6441 }
};

// Observer for bearing/direction display
const OBS_LAT = 43.687737;
const OBS_LON = -65.128691;

// METAR station for cloud ceiling near Lockeport (Yarmouth)
const LOCKEPORT_METAR_STATION = 'CYQI';

// Airline mapping by callsign prefix
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

// ICAO -> IATA airline code
const ICAO_TO_IATA = {
  ACA: 'AC',
  JZA: 'QK',
  ROU: 'RV',
  WJA: 'WS',
  WEN: 'WR',
  TSC: 'TS',
  POE: 'PD',
  QTR: 'QR',
  BAW: 'BA',
  AFR: 'AF',
  DLH: 'LH',
  KLM: 'KL',
  UAL: 'UA',
  AAL: 'AA',
  DAL: 'DL',
  JBU: 'B6',
  SWA: 'WN'
};

// Earth radius for distance calc
const EARTH_RADIUS_KM = 6371;

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

function bearingDegrees(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);

  const x = Math.sin(dLon) * Math.cos(phi2);
  const y =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);

  const brng = toDeg(Math.atan2(x, y));
  return (brng + 360) % 360;
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function bearingToDirection(brng) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.floor((brng + 22.5) / 45) % 8;
  return dirs[idx];
}

// ---------------------------------------------------------------------
// CSV utilities
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
// Airport & Country DBs
// ---------------------------------------------------------------------

let airportsByIcao = null;
let countryNameToIso2 = null;

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
// ADSB.lol
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
// Route lookup via adsbdb + AeroDataBox + AviationStack
// ---------------------------------------------------------------------

const routeCache = {}; // callsign -> { originIcao, destinationIcao } or null
const routeSourceStats = {}; // airlineKey -> { adsbdb, aerodatabox, aviationstack }

function getAirlineKeyFromCallsign(callsignKey) {
  if (!callsignKey) return 'DEFAULT';
  const cs = callsignKey.trim().toUpperCase();
  const m = cs.match(/^([A-Z]+)/);
  return m ? m[1] : 'DEFAULT';
}

function recordRouteSourceSuccess(airlineKey, sourceName) {
  if (!routeSourceStats[airlineKey]) {
    routeSourceStats[airlineKey] = {
      adsbdb: 0,
      aerodatabox: 0,
      aviationstack: 0
    };
  }
  if (routeSourceStats[airlineKey][sourceName] == null) {
    routeSourceStats[airlineKey][sourceName] = 0;
  }
  routeSourceStats[airlineKey][sourceName] += 1;
}

function getRouteSourceOrderForAirline(airlineKey) {
  const defaultOrder = ['adsbdb', 'aerodatabox', 'aviationstack'];
  const stats = routeSourceStats[airlineKey];
  if (!stats) return defaultOrder;

  return [...defaultOrder].sort((a, b) => {
    const sa = stats[a] || 0;
    const sb = stats[b] || 0;
    return sb - sa;
  });
}

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

function parseFlightNumberFromCallsign(callsignKey) {
  if (!callsignKey) return null;
  const cs = callsignKey.trim().toUpperCase();
  const m = cs.match(/^([A-Z]{2,3})(\d{1,4})$/);
  if (!m) return null;
  return {
    icaoCode: m[1],
    flightNumber: m[2]
  };
}

function buildFlightNumberCandidates(callsignKey) {
  const parsed = parseFlightNumberFromCallsign(callsignKey);
  if (!parsed) return [];

  const candidates = new Set();
  const { icaoCode, flightNumber } = parsed;

  candidates.add(`${icaoCode}${flightNumber}`);

  const iata = ICAO_TO_IATA[icaoCode];
  if (iata) {
    candidates.add(`${iata}${flightNumber}`);
  }

  return Array.from(candidates);
}

async function fetchRouteFromAeroDataBox(callsignKey) {
  if (!AERODATABOX_API_KEY) return null;

  const candidates = buildFlightNumberCandidates(callsignKey);
  if (!candidates.length) return null;

  for (const flightNumber of candidates) {
    const url = AERODATABOX_FLIGHT_URL_TEMPLATE.replace(
      '{flightNumber}',
      encodeURIComponent(flightNumber)
    );

    try {
      const resp = await axios.get(url, {
        timeout: 8000,
        headers: {
          'X-RapidAPI-Key': AERODATABOX_API_KEY,
          'X-RapidAPI-Host': AERODATABOX_HOST
        }
      });

      const body = resp.data;
      const flights = Array.isArray(body) ? body : body.flights || body.data || [];
      if (!Array.isArray(flights) || flights.length === 0) continue;

      const f = flights[0];
      const dep = f.departure || f.dep || {};
      const arr = f.arrival || f.arr || {};

      const originIcao =
        dep.icao || dep.icaoCode || dep.icao_code || dep.airportIcao || null;
      const destinationIcao =
        arr.icao || arr.icaoCode || arr.icao_code || arr.airportIcao || null;

      if (!originIcao || !destinationIcao) {
        continue;
      }

      return {
        originIcao: String(originIcao).toUpperCase(),
        destinationIcao: String(destinationIcao).toUpperCase()
      };
    } catch (err) {
      if (err.response) {
        console.error(
          '[ROUTE] AeroDataBox error for',
          callsignKey,
          'candidate=',
          flightNumber,
          'status=',
          err.response.status,
          'data=',
          JSON.stringify(err.response.data)
        );
      } else {
        console.error(
          '[ROUTE] AeroDataBox request failed for',
          callsignKey,
          'candidate=',
          flightNumber,
          ':',
          err.message
        );
      }
    }
  }

  return null;
}

async function fetchRouteFromAviationStack(callsignKey) {
  if (!AVIATIONSTACK_API_KEY) return null;

  const parsed = parseFlightNumberFromCallsign(callsignKey);
  let flightIata = null;
  if (parsed) {
    const iata = ICAO_TO_IATA[parsed.icaoCode];
    if (iata) {
      flightIata = `${iata}${parsed.flightNumber}`;
    }
  }

  const params = {
    access_key: AVIATIONSTACK_API_KEY,
    flight_icao: callsignKey
  };
  if (flightIata) {
    params.flight_iata = flightIata;
  }

  try {
    const resp = await axios.get(AVIATIONSTACK_FLIGHTS_URL, {
      timeout: 8000,
      params
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

  const airlineKey = getAirlineKeyFromCallsign(key);
  const sourceOrder = getRouteSourceOrderForAirline(airlineKey);

  for (const source of sourceOrder) {
    let result = null;

    if (source === 'adsbdb') {
      result = await fetchRouteFromAdsbdb(key);
    } else if (source === 'aerodatabox') {
      result = await fetchRouteFromAeroDataBox(key);
    } else if (source === 'aviationstack') {
      result = await fetchRouteFromAviationStack(key);
    }

    if (result && result.originIcao && result.destinationIcao) {
      routeCache[key] = result;
      recordRouteSourceSuccess(airlineKey, source);
      return result;
    }
  }

  routeCache[key] = null;
  return null;
}

// ---------------------------------------------------------------------
// Aircraft formatting
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
  let distanceFromObserverKm = null;

  if (lat != null && lon != null && !Number.isNaN(lat) && !Number.isNaN(lon)) {
    const br = bearingDegrees(OBS_LAT, OBS_LON, lat, lon);
    bearingDeg = Math.round(br * 10) / 10;
    lookDirection = bearingToDirection(br);

    const dist = distanceKm(OBS_LAT, OBS_LON, lat, lon);
    if (Number.isFinite(dist)) {
      distanceFromObserverKm = dist;
    }
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
    distanceKm: distanceFromObserverKm,

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
// Cloud ceiling via AviationWeather METAR
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
// Combined fetch
// ---------------------------------------------------------------------

async function getAircraftForLocationKey(locationKey, radiusKmRaw) {
  const loc = LOCATIONS[locationKey] || LOCATIONS['2'];

  let radiusKm = Number(radiusKmRaw);
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
    radiusKm = DEFAULT_RADIUS_KM;
  }
  if (radiusKm < 1) radiusKm = 1;
  if (radiusKm > 2000) radiusKm = 2000;

  const radiusNm = Math.round(radiusKm * NM_PER_KM);

  const data = await fetchAircraftRaw(loc.lat, loc.lon, radiusNm);
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
    radiusKm,
    cloudCeilingFt,
    aircraft
  };
}

// ---------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/aircraft', async (req, res) => {
  const location = req.query.location || '2';
  const radiusKm = req.query.radiusKm;
  try {
    const result = await getAircraftForLocationKey(location, radiusKm);
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
