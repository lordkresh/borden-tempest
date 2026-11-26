import {
  angularDiffDeg,
  buildMotionVectorLine,
  buildThreatConePolygon,
  computeStormIntercept,
  degToCompass,
  geometryCentroid,
  haversineMiles,
  isPointInGeometry,
  isValidLatLon
} from './geoMath.js';
import {
  DEFAULT_TIME_ZONE,
  formatLocalHour,
  formatLocalTime,
  formatUtcClock,
  getCentralHour24,
  parseUtcTimestampMs
} from './weatherApi.js';

export const WOFS_VIEWER_URL = 'https://cbwofs.nssl.noaa.gov/forecast';
export const WOFS_ATTRIBUTION = 'WoFS data courtesy of the National Severe Storms Laboratory using federal funding.';

const WMO_LABELS = {
  0: ['Clear Sky', '☀️'],
  1: ['Mostly Clear', '🌤️'],
  2: ['Partly Cloudy', '⛅'],
  3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'],
  48: ['Freezing Fog', '🌫️'],
  51: ['Light Drizzle', '🌦️'],
  53: ['Drizzle', '🌦️'],
  55: ['Dense Drizzle', '🌧️'],
  56: ['Freezing Drizzle', '🧊'],
  57: ['Heavy Freezing Drizzle', '🧊'],
  61: ['Light Rain', '🌧️'],
  63: ['Moderate Rain', '🌧️'],
  65: ['Heavy Rain', '🌧️'],
  66: ['Freezing Rain', '🧊'],
  67: ['Heavy Freezing Rain', '🧊'],
  71: ['Light Snow', '❄️'],
  73: ['Moderate Snow', '❄️'],
  75: ['Heavy Snow', '❄️'],
  77: ['Snow Grains', '❄️'],
  80: ['Rain Showers', '🌦️'],
  81: ['Heavy Showers', '🌧️'],
  82: ['Violent Showers', '⛈️'],
  85: ['Snow Showers', '🌨️'],
  86: ['Heavy Snow Showers', '🌨️'],
  95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm w/ Hail', '⛈️'],
  99: ['Severe Thunderstorm w/ Hail', '🌩️']
};

export function wmoInfo(code) {
  return WMO_LABELS[code] || ['Fair', '🌤️'];
}

function toFiniteNumber(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export const KT_TO_MS = 1852 / 3600;
export const MS_TO_KT = 3600 / 1852;
export const KT_TO_MPH = 1852 / 1609.344;
export const MPH_TO_KT = 1609.344 / 1852;

export function cToF(c) {
  const n = toFiniteNumber(c);
  return n === null ? null : (n * 9) / 5 + 32;
}

export function fToC(f) {
  const n = toFiniteNumber(f);
  return n === null ? null : ((n - 32) * 5) / 9;
}

export function kmhToMph(kmh) {
  const n = toFiniteNumber(kmh);
  return n === null ? null : n / 1.609344;
}

export function mphToKmh(mph) {
  const n = toFiniteNumber(mph);
  return n === null ? null : n * 1.609344;
}

export function ktToMph(kt) {
  const n = toFiniteNumber(kt);
  return n === null ? null : n * KT_TO_MPH;
}

export function mphToKt(mph) {
  const n = toFiniteNumber(mph);
  return n === null ? null : n * MPH_TO_KT;
}

export function msToMph(ms) {
  const n = toFiniteNumber(ms);
  return n === null ? null : (n * 3600) / 1609.344;
}

export function msToKt(ms) {
  const n = toFiniteNumber(ms);
  return n === null ? null : n * MS_TO_KT;
}

export function ktToMs(kt) {
  const n = toFiniteNumber(kt);
  return n === null ? null : n * KT_TO_MS;
}

export function mToFeet(m) {
  const n = toFiniteNumber(m);
  return n === null ? null : n / 0.3048;
}

export function mToMiles(m) {
  const n = toFiniteNumber(m);
  return n === null ? null : n / 1609.344;
}

export function paToHpa(pa) {
  const n = toFiniteNumber(pa);
  return n === null ? null : n / 100;
}

export function hpaToInHg(hpa) {
  const n = toFiniteNumber(hpa);
  return n === null ? null : n * 0.029529983071445;
}

function normalizeUnitCode(unit) {
  return String(unit || '').trim().toLowerCase();
}

function convertTempToF(val, unitLabel = '°f') {
  const n = toFiniteNumber(val);
  if (n === null) return null;
  const u = normalizeUnitCode(unitLabel);
  if (u.includes('degc') || u === 'c' || u === '°c') return cToF(n);
  return n;
}

function convertWindToMph(val, unitLabel = 'mp/h') {
  const n = toFiniteNumber(val);
  if (n === null) return null;
  const u = normalizeUnitCode(unitLabel);
  if (u.includes('km_h') || u.includes('km/h') || u === 'kmh') return kmhToMph(n);
  if (u.includes('m_s') || u.includes('m/s') || u === 'ms') return msToMph(n);
  if (u === 'kn' || u === 'kt' || u === 'kts' || u.includes(':kt') || u.includes('knot')) return ktToMph(n);
  return n;
}

function convertWindToKt(val, unitLabel = 'mp/h') {
  const n = toFiniteNumber(val);
  if (n === null) return null;
  const u = normalizeUnitCode(unitLabel);
  if (u === 'kn' || u === 'kt' || u === 'kts' || u.includes(':kt') || u.includes('knot')) return n;
  if (u.includes('km_h') || u.includes('km/h') || u === 'kmh') return mphToKt(kmhToMph(n));
  if (u.includes('m_s') || u.includes('m/s') || u === 'ms') return msToKt(n);
  return mphToKt(n);
}

function convertPressureToHpa(val, unitLabel = 'pa') {
  const n = toFiniteNumber(val);
  if (n === null) return null;
  const u = normalizeUnitCode(unitLabel);
  if (u.includes('hpa') || u === 'mb') return n;
  if (u.includes('inhg')) return n / 0.029529983071445;
  return paToHpa(n);
}

function convertVisibilityToMiles(val, unitLabel = 'm') {
  const n = toFiniteNumber(val);
  if (n === null) return null;
  const u = normalizeUnitCode(unitLabel);
  if (u === 'mi' || u === 'mile' || u === 'miles') return n;
  if (u === 'km' || u.includes(':km')) return kmhToMph(n);
  if (u === 'ft' || u === 'feet') return n / 5280;
  return mToMiles(n);
}

function convertSnowfallToInches(val, unitLabel = 'inch') {
  const n = toFiniteNumber(val);
  if (n === null) return 0;
  const u = normalizeUnitCode(unitLabel);
  if (u === 'cm') return n / 2.54;
  if (u === 'mm') return n / 25.4;
  return n;
}

function convertPrecipToInches(val, unitLabel = 'inch') {
  const n = toFiniteNumber(val);
  if (n === null) return 0;
  const raw = normalizeUnitCode(unitLabel);
  const u = raw.includes(':') ? raw.split(':').pop() : raw;
  if (u === 'mm' || u.includes('millimet')) return n / 25.4;
  if (u === 'cm' || u.includes('centimet')) return n / 2.54;
  if (u === 'm' || u === 'meter' || u === 'meters') return n * 39.3700787;
  return n;
}

function windComponentsKt(spdKt, dirFromDeg) {
  const spd = Math.max(0, toFiniteNumber(spdKt) ?? 0);
  const dir = toFiniteNumber(dirFromDeg) ?? 0;
  const rad = (dir * Math.PI) / 180;
  return [-spd * Math.sin(rad), -spd * Math.cos(rad)];
}

function vectorShearKt(spd1Kt, dir1Deg, spd2Kt, dir2Deg) {
  const [u1, v1] = windComponentsKt(spd1Kt, dir1Deg);
  const [u2, v2] = windComponentsKt(spd2Kt, dir2Deg);
  return Math.hypot(u2 - u1, v2 - v1);
}

/**
 * Exact discrete Storm-Relative Helicity integral (Davies-Jones et al. 1990):
 * Positive for clockwise-curving Northern Hemisphere hodographs with RM storm motion to the right.
 */
function integrateSrh(levelsMs, stormU, stormV) {
  if (!Array.isArray(levelsMs) || levelsMs.length < 2 || !Number.isFinite(stormU) || !Number.isFinite(stormV)) {
    return 0;
  }
  let total = 0;
  for (let i = 0; i < levelsMs.length - 1; i++) {
    const [u1, v1] = levelsMs[i];
    const [u2, v2] = levelsMs[i + 1];
    if (!Number.isFinite(u1) || !Number.isFinite(v1) || !Number.isFinite(u2) || !Number.isFinite(v2)) continue;
    total += (u2 - stormU) * (v1 - stormV) - (u1 - stormU) * (v2 - stormV);
  }
  return Number.isFinite(total) ? total : 0;
}

function findCurrentHourIndex(hourly, nowMs = Date.now(), utcOffsetSeconds = 0) {
  const times = hourly?.time || [];
  if (!times.length) return 0;
  const refMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const offsetOpts = Number.isFinite(utcOffsetSeconds) && utcOffsetSeconds !== 0 ? { utcOffsetSeconds } : {};
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const tMs = parseUtcTimestampMs(times[i], offsetOpts);
    if (tMs == null || !Number.isFinite(tMs)) continue;
    const diff = Math.abs(tMs - refMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Matches Android ProWinterAnalyzer.findStartHourIndex (floors nowMs to top of UTC hour). */
function findWinterStartHourIndex(times, nowMs = Date.now(), utcOffsetSeconds = 0) {
  if (!Array.isArray(times) || !times.length) return 0;
  const refMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const floorHourMs = Math.floor(refMs / 3600000) * 3600000;
  const offsetOpts = Number.isFinite(utcOffsetSeconds) && utcOffsetSeconds !== 0 ? { utcOffsetSeconds } : {};
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const tMs = parseUtcTimestampMs(times[i], offsetOpts);
    if (tMs == null || !Number.isFinite(tMs)) continue;
    const diff = Math.abs(tMs - floorHourMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function clampNum(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function isValidIanaTimeZone(tz) {
  const s = String(tz || '').trim();
  if (!s) return false;
  const up = s.toUpperCase();
  if (up === 'GMT' || up === 'UTC' || up === 'ETC/UTC' || up === 'ETC/GMT' || up === 'AUTO') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function resolveLocationTimeZone(nwsBundle = null, openMeteo = null, fallback = DEFAULT_TIME_ZONE) {
  if (isValidIanaTimeZone(nwsBundle?.timeZone)) return nwsBundle.timeZone.trim();
  if (isValidIanaTimeZone(openMeteo?.timezone)) return openMeteo.timezone.trim();
  return isValidIanaTimeZone(fallback) ? fallback : DEFAULT_TIME_ZONE;
}

/**
 * NOAA Rothfusz Heat Index (T >= 80°F && RH >= 40%), otherwise returns airTempF.
 */
export function computeHeatIndexF(tempF, rhPct) {
  const T = toFiniteNumber(tempF);
  const R = toFiniteNumber(rhPct);
  if (T == null || R == null) return T;
  if (T < 80 || R < 40) return T;
  const rh = clampNum(R, 0, 100);
  let hi = -42.379 + 2.04901523 * T + 10.14333127 * rh
    - 0.22475541 * T * rh - 0.00683783 * T * T - 0.05481717 * rh * rh
    + 0.00122874 * T * T * rh + 0.00085282 * T * rh * rh
    - 0.00000199 * T * T * rh * rh;
  if (rh < 13 && T >= 80 && T <= 112) {
    hi -= ((13 - rh) / 4) * Math.sqrt(Math.max(0, (17 - Math.abs(T - 95)) / 17));
  } else if (rh > 85 && T >= 80 && T <= 87) {
    hi += ((rh - 85) / 10) * ((87 - T) / 5);
  }
  return Number.isFinite(hi) ? hi : T;
}

/**
 * Official NWS Wind Chill formula (T <= 50°F && windMph >= 3).
 */
export function computeWindChillF(tempF, windMph) {
  const T = toFiniteNumber(tempF);
  const W = toFiniteNumber(windMph);
  if (T == null || W == null) return T;
  if (T > 50 || W < 3) return T;
  const v16 = Math.pow(W, 0.16);
  const wc = 35.74 + 0.6215 * T - 35.75 * v16 + 0.4275 * T * v16;
  return Number.isFinite(wc) ? wc : T;
}

/**
 * Builds canonical v2.0 Hyper-Local Location Anchor (Spec §3.3 & §9.1).
 */
export function buildLocationAnchor({
  lat,
  lon,
  locationName = null,
  nwsBundle = null,
  openMeteo = null,
  openMeteoEnsemble = null,
  gpsAccuracyM = null,
  isApproxFix = false
} = {}) {
  const nLat = toFiniteNumber(lat);
  const nLon = toFiniteNumber(lon);
  const timeZone = resolveLocationTimeZone(nwsBundle, openMeteo || openMeteoEnsemble);
  const wfoId = nwsBundle?.wfoId || nwsBundle?.gridId || nwsBundle?.cwa || null;
  const gridX = Number.isFinite(Number(nwsBundle?.gridX)) ? Number(nwsBundle.gridX) : null;
  const gridY = Number.isFinite(Number(nwsBundle?.gridY)) ? Number(nwsBundle.gridY) : null;
  const countyName = nwsBundle?.countyName || null;
  const cityLabel = nwsBundle?.cityLabel || locationName || 'Current Location';
  const stateCode = nwsBundle?.stateCode || null;
  const forecastZone = nwsBundle?.forecastZone || null;
  const radarStation = nwsBundle?.radarStation || null;

  const elevM = toFiniteNumber(nwsBundle?.elevationM)
    ?? toFiniteNumber(openMeteoEnsemble?.elevation)
    ?? toFiniteNumber(openMeteo?.elevation)
    ?? null;
  const elevationFt = toFiniteNumber(nwsBundle?.elevationFt)
    ?? (elevM != null ? Math.round(elevM / 0.3048) : null);

  let nearestStationId = null;
  let nearestStationDistMi = null;
  for (const obs of nwsBundle?.observations || []) {
    if (!obs?.stationId) continue;
    let d = toFiniteNumber(obs.distanceMi);
    if (d == null && nLat != null && nLon != null && Array.isArray(obs.coords) && obs.coords.length >= 2) {
      d = haversineMiles(nLat, nLon, Number(obs.coords[1]), Number(obs.coords[0]));
    }
    if (nearestStationId == null || (d != null && (nearestStationDistMi == null || d < nearestStationDistMi))) {
      nearestStationId = obs.stationId;
      nearestStationDistMi = d != null && Number.isFinite(d) ? Number(d.toFixed(1)) : null;
    }
  }

  const badgeParts = [];
  if (wfoId) {
    badgeParts.push(gridX != null && gridY != null ? `NWS ${wfoId} (${gridX},${gridY})` : `NWS ${wfoId}`);
  }
  if (countyName) {
    badgeParts.push(countyName.replace(/\s+County$/i, ' Co.'));
  }
  if (elevationFt != null) {
    badgeParts.push(`${elevationFt.toLocaleString()} ft`);
  }
  if (nearestStationId) {
    badgeParts.push(nearestStationDistMi != null ? `${nearestStationId} ${Math.round(nearestStationDistMi)} mi` : nearestStationId);
  }
  const anchorBadge = badgeParts.length ? badgeParts.join(' · ') : (cityLabel || 'Local Coordinates');

  return {
    lat: nLat,
    lon: nLon,
    cityLabel,
    stateCode,
    countyName,
    wfoId,
    gridX,
    gridY,
    forecastZone,
    radarStation,
    timeZone,
    elevationM: elevM != null ? Number(elevM.toFixed(1)) : null,
    elevationFt,
    nearestStationId,
    nearestStationDistMi,
    anchorBadge,
    gpsAccuracyM: toFiniteNumber(gpsAccuracyM),
    isApproxFix: Boolean(isApproxFix)
  };
}

/**
 * Resamples NWS 2.5 km forecastGridData intervals onto UTC hourly slots (Spec §5.1).
 */
export function resampleNwsGridToHourly(gridData, hourlyTimesMs) {
  if (!gridData || !Array.isArray(hourlyTimesMs) || !hourlyTimesMs.length) return [];
  const props = gridData.properties || gridData;
  const parsedSeriesCache = new Map();

  const parseSeries = (key) => {
    if (parsedSeriesCache.has(key)) return parsedSeriesCache.get(key);
    const raw = props[key];
    if (!raw || !Array.isArray(raw.values)) {
      parsedSeriesCache.set(key, null);
      return null;
    }
    const items = [];
    for (const entry of raw.values) {
      const span = parseNwsValidTimeSpan(entry?.validTime);
      if (!span || span[1] <= span[0]) continue;
      items.push({ start: span[0], end: span[1], value: entry.value });
    }
    const out = { uom: raw.uom || '', items };
    parsedSeriesCache.set(key, out);
    return out;
  };

  const sampleState = (key, tH, converter) => {
    const s = parseSeries(key);
    if (!s) return null;
    const tMid = tH + 1800000;
    for (const it of s.items) {
      if (tH >= it.start && tH < it.end) {
        return converter(it.value, s.uom);
      }
      if (tMid >= it.start && tMid < it.end) {
        return converter(it.value, s.uom);
      }
    }
    return null;
  };

  const sampleAccumInches = (key, tH) => {
    const s = parseSeries(key);
    if (!s) return null;
    const factor = accumFactorInches(s.uom, 1 / 25.4);
    const hEnd = tH + 3600000;
    let sum = 0;
    let covered = false;
    for (const it of s.items) {
      const ov = Math.min(hEnd, it.end) - Math.max(tH, it.start);
      if (ov <= 0) continue;
      covered = true;
      const v = toFiniteNumber(it.value);
      if (v != null && v > 0) {
        sum += (v * factor) * (ov / (it.end - it.start));
      }
    }
    return covered ? sum : null;
  };

  const wxSeries = parseSeries('weather');

  return hourlyTimesMs.map((tH) => {
    let hasSnowWx = false;
    let hasFreezingRainWx = false;
    let hasSleetWx = false;
    let hasRainWx = false;
    let hasPrecipWx = false;
    if (wxSeries) {
      const hEnd = tH + 3600000;
      for (const it of wxSeries.items) {
        if (Math.min(hEnd, it.end) - Math.max(tH, it.start) <= 0) continue;
        const entries = Array.isArray(it.value) ? it.value : [];
        for (const e of entries) {
          const wx = String(e?.weather || '').toLowerCase();
          if (!wx || wx === 'none') continue;
          if (wx.includes('freezing_rain') || wx.includes('freezing_drizzle')) { hasFreezingRainWx = true; hasPrecipWx = true; }
          else if (wx.includes('sleet') || wx.includes('ice_pellets')) { hasSleetWx = true; hasPrecipWx = true; }
          else if (wx.includes('snow')) { hasSnowWx = true; hasPrecipWx = true; }
          else if (wx.includes('rain') || wx.includes('drizzle') || wx.includes('shower') || wx.includes('thunder')) { hasRainWx = true; hasPrecipWx = true; }
        }
      }
    }
    const hasMixedWx = (hasSnowWx && (hasRainWx || hasSleetWx || hasFreezingRainWx)) || (hasSleetWx && hasFreezingRainWx);

    const snowLvlRaw = sampleState('snowLevel', tH, (v, u) => {
      const n = toFiniteNumber(v);
      if (n == null) return null;
      return normalizeUnitCode(u).includes('ft') ? n : mToFeet(n);
    });

    return {
      epochMs: tH,
      tempF: sampleState('temperature', tH, (v, u) => convertTempToF(v, u || 'wmoUnit:degC')),
      dewpointF: sampleState('dewpoint', tH, (v, u) => convertTempToF(v, u || 'wmoUnit:degC')),
      apparentTempF: sampleState('apparentTemperature', tH, (v, u) => convertTempToF(v, u || 'wmoUnit:degC')),
      popPct: sampleState('probabilityOfPrecipitation', tH, (v) => toFiniteNumber(v)),
      qpfIn: sampleAccumInches('quantitativePrecipitation', tH),
      snowIn: sampleAccumInches('snowfallAmount', tH),
      iceIn: sampleAccumInches('iceAccumulation', tH),
      windMph: sampleState('windSpeed', tH, (v, u) => convertWindToMph(v, u || 'wmoUnit:km_h-1')),
      gustMph: sampleState('windGust', tH, (v, u) => convertWindToMph(v, u || 'wmoUnit:km_h-1')),
      windChillF: sampleState('windChill', tH, (v, u) => convertTempToF(v, u || 'wmoUnit:degC')),
      thunderProbPct: sampleState('probabilityOfThunder', tH, (v) => toFiniteNumber(v)),
      skyCoverPct: sampleState('skyCover', tH, (v) => toFiniteNumber(v)),
      visibilityMi: sampleState('visibility', tH, (v, u) => convertVisibilityToMiles(v, u || 'wmoUnit:m')),
      snowLevelFt: snowLvlRaw != null ? Math.round(snowLvlRaw) : null,
      hasSnowWx,
      hasFreezingRainWx,
      hasSleetWx,
      hasRainWx,
      hasMixedWx,
      hasPrecipWx
    };
  });
}

/**
 * Live ASOS/METAR Real-Time MOS Bias Correction with IDW + Elevation Lapse Rate (Spec §4).
 */
export function computeAsosMosCalibration({
  userLat = null,
  userLon = null,
  userElevFt = null,
  userElevationFt = null,
  nwsObservations = null,
  observations = null,
  rawModelHour0 = null,
  rawHour0 = null,
  nowMs = Date.now()
} = {}) {
  const refMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const raw0 = rawModelHour0 || rawHour0 || {};
  const obsList = Array.isArray(nwsObservations) ? nwsObservations : (Array.isArray(observations) ? observations : []);
  const rawT0 = toFiniteNumber(raw0?.tempF);
  const rawTd0 = toFiniteNumber(raw0?.dewpointF);
  const rawW0 = toFiniteNumber(raw0?.windMph);
  const uElev = toFiniteNumber(userElevFt ?? userElevationFt);
  const hasUserCoords = isValidLatLon(Number(userLat), Number(userLon));

  const candidates = [];
  for (const obs of obsList) {
    const p = obs?.props;
    if (!p) continue;
    let ageMin = 15;
    if (p.timestamp || obs.timestampMs != null) {
      const obsMs = obs.timestampMs ?? parseUtcTimestampMs(p.timestamp);
      if (obsMs == null || !Number.isFinite(obsMs)) continue;
      ageMin = (refMs - obsMs) / 60000;
      if (ageMin > 90 || ageMin < -15) continue;
    }

    let distMi = toFiniteNumber(obs.distanceMi);
    if (distMi == null && hasUserCoords) {
      if (Array.isArray(obs.coords) && obs.coords.length >= 2) {
        distMi = haversineMiles(Number(userLat), Number(userLon), Number(obs.coords[1]), Number(obs.coords[0]));
      } else if (isValidLatLon(Number(obs.lat), Number(obs.lon))) {
        distMi = haversineMiles(Number(userLat), Number(userLon), Number(obs.lat), Number(obs.lon));
      }
    }
    if (distMi == null) distMi = 10.0;
    if (distMi > 65.0) continue;

    const tObs = convertTempToF(p.temperature?.value, p.temperature?.unitCode || 'wmoUnit:degC');
    if (tObs == null) continue;
    const tdObs = convertTempToF(p.dewpoint?.value, p.dewpoint?.unitCode || 'wmoUnit:degC');
    const rh = toFiniteNumber(p.relativeHumidity?.value);
    const desc = String(p.textDescription || '').toLowerCase();
    const bogusClear100Rh = rh != null && rh >= 99 && (desc.includes('clear') || desc.includes('fair') || desc.includes('sunny'));

    let stnElevFt = toFiniteNumber(obs.elevationFt);
    if (stnElevFt == null && p.elevation?.value != null) {
      const ev = toFiniteNumber(p.elevation.value);
      if (ev != null) {
        stnElevFt = normalizeUnitCode(p.elevation.unitCode).includes('ft') ? ev : (ev / 0.3048);
      }
    }
    const deltaElevFt = (uElev != null && stnElevFt != null) ? (uElev - stnElevFt) : 0;
    const lapseAdj = clampNum(-0.0035 * deltaElevFt, -5.0, 5.0);
    const tAdj = tObs + lapseAdj;
    const tdAdj = (!bogusClear100Rh && tdObs != null) ? Math.min(tAdj, tdObs + 0.5 * lapseAdj) : null;
    const windObs = convertWindToMph(p.windSpeed?.value, p.windSpeed?.unitCode || 'wmoUnit:km_h-1');
    const gustObs = convertWindToMph(p.windGust?.value, p.windGust?.unitCode || 'wmoUnit:km_h-1');
    const visObs = convertVisibilityToMiles(p.visibility?.value, p.visibility?.unitCode || 'wmoUnit:m');

    const w = (1 / Math.pow(Math.max(3.0, distMi), 1.5)) * Math.max(0.25, 1.0 - Math.max(0, ageMin) / 100.0);
    candidates.push({
      obs,
      stationId: obs.stationId || 'ASOS',
      stationName: obs.stationName || obs.stationId || 'ASOS',
      distMi,
      ageMin: Math.max(0, ageMin),
      tObs,
      tAdj,
      tdAdj,
      rh: bogusClear100Rh ? null : rh,
      windObs: windObs != null ? Math.max(0, windObs) : null,
      gustObs: gustObs != null ? Math.max(0, gustObs) : null,
      visObs: visObs != null ? Math.max(0, visObs) : null,
      weight: w
    });
  }

  // Outlier screen (Spec §4.1 #4): reject |tAdj - T_raw0| > 7.5°F unless >=2 stations agree within 3.0°F
  const valid = candidates.filter((c) => {
    if (rawT0 == null || Math.abs(c.tAdj - rawT0) <= 7.5) return true;
    const agreeing = candidates.filter((other) => Math.abs(other.tAdj - c.tAdj) <= 3.0);
    return agreeing.length >= 2;
  });

  if (!valid.length) {
    return {
      mosApplied: false,
      primaryStationId: null,
      primaryStationName: null,
      primaryStationDistMi: null,
      primaryStationAgeMin: null,
      primaryObs: null,
      stationCount: 0,
      stationIds: [],
      obsTempF: null,
      obsDewpointF: null,
      obsWindMph: null,
      obsVisMi: null,
      rawModelHour0TempF: rawT0 != null ? Number(rawT0.toFixed(1)) : null,
      tempBiasDeltaF: 0,
      dewBiasDeltaF: 0,
      windBiasDeltaMph: 0,
      distanceScale: 0,
      effectiveHour0DeltaF: 0,
      mosSummaryBadge: 'Model Consensus (No Recent ASOS)',
      validStations: []
    };
  }

  valid.sort((a, b) => b.weight - a.weight);
  const primary = valid[0];
  const dMin = Math.min(...valid.map((v) => v.distMi));
  const wSumT = valid.reduce((a, v) => a + v.weight, 0) || 1;
  const obsTempF = valid.reduce((a, v) => a + v.weight * v.tAdj, 0) / wSumT;

  const tdValid = valid.filter((v) => v.tdAdj != null);
  const wSumTd = tdValid.reduce((a, v) => a + v.weight, 0);
  const obsDewpointF = wSumTd > 0 ? tdValid.reduce((a, v) => a + v.weight * v.tdAdj, 0) / wSumTd : null;

  const wValid = valid.filter((v) => v.windObs != null);
  const wSumW = wValid.reduce((a, v) => a + v.weight, 0);
  const obsWindMph = wSumW > 0 ? wValid.reduce((a, v) => a + v.weight * v.windObs, 0) / wSumW : null;

  const tempBiasDeltaF = rawT0 != null ? clampNum(obsTempF - rawT0, -6.0, 6.0) : 0;
  const dewBiasDeltaF = (obsDewpointF != null && rawTd0 != null) ? clampNum(obsDewpointF - rawTd0, -6.0, 6.0) : 0;
  const windBiasDeltaMph = (obsWindMph != null && rawW0 != null) ? clampNum(obsWindMph - rawW0, -8.0, 8.0) : 0;
  const distanceScale = clampNum(1.0 - Math.max(0, dMin - 10.0) / 65.0, 0.35, 1.0);
  const effDelta0 = distanceScale * tempBiasDeltaF;
  const sign = effDelta0 >= 0 ? '+' : '';
  const distRounded = Math.round(primary.distMi);
  const mosSummaryBadge = `${primary.stationId} ${distRounded} mi · ${sign}${effDelta0.toFixed(1)}°F MOS`;

  return {
    mosApplied: true,
    primaryStationId: primary.stationId,
    primaryStationName: primary.stationName,
    primaryStationDistMi: Number(primary.distMi.toFixed(1)),
    primaryStationAgeMin: Math.round(primary.ageMin),
    primaryObs: primary.obs,
    stationCount: valid.length,
    stationIds: valid.map((v) => v.stationId),
    obsTempF: Number(obsTempF.toFixed(1)),
    obsDewpointF: obsDewpointF != null ? Number(obsDewpointF.toFixed(1)) : null,
    obsWindMph: obsWindMph != null ? Number(obsWindMph.toFixed(1)) : null,
    obsVisMi: primary.visObs != null ? Number(primary.visObs.toFixed(1)) : null,
    rawModelHour0TempF: rawT0 != null ? Number(rawT0.toFixed(1)) : null,
    tempBiasDeltaF: Number(tempBiasDeltaF.toFixed(2)),
    dewBiasDeltaF: Number(dewBiasDeltaF.toFixed(2)),
    windBiasDeltaMph: Number(windBiasDeltaMph.toFixed(2)),
    distanceScale: Number(distanceScale.toFixed(3)),
    effectiveHour0DeltaF: Number(effDelta0.toFixed(1)),
    mosSummaryBadge,
    validStations: valid
  };
}

export function applyAsosMosDecayAtHour(asosMos, leadHour) {
  if (!asosMos?.mosApplied || leadHour < 0 || leadHour > 12) {
    return { dTempF: 0, dDewF: 0, dWindMph: 0 };
  }
  const s = Number(asosMos.distanceScale) || 0;
  const decayT = Math.exp(-leadHour / 4.5);
  const decayW = Math.exp(-leadHour / 3.0);
  return {
    dTempF: s * (Number(asosMos.tempBiasDeltaF) || 0) * decayT,
    dDewF: s * (Number(asosMos.dewBiasDeltaF) || 0) * decayT,
    dWindMph: s * (Number(asosMos.windBiasDeltaMph) || 0) * decayW
  };
}

const ENSEMBLE_MODEL_SPECS = [
  { key: 'HRRR', name: 'HRRR', resolution: '3 km', suffixes: ['ncep_hrrr_conus', 'gfs_hrrr'] },
  { key: 'NBM', name: 'NBM', resolution: '2.5 km', suffixes: ['ncep_nbm_conus'] },
  { key: 'ECMWF', name: 'ECMWF', resolution: '0.25°', suffixes: ['ecmwf_ifs025'] },
  { key: 'GFS', name: 'GFS', resolution: '0.25°', suffixes: ['gfs_global', 'gfs_seamless'] }
];

function horizonWeightsForHour(h) {
  if (h <= 6) return { NWS: 0.25, HRRR: 0.35, NBM: 0.25, ECMWF: 0.10, GFS: 0.05 };
  if (h <= 18) return { NWS: 0.28, HRRR: 0.27, NBM: 0.25, ECMWF: 0.13, GFS: 0.07 };
  if (h <= 48) return { NWS: 0.30, HRRR: 0.15, NBM: 0.25, ECMWF: 0.20, GFS: 0.10 };
  return { NWS: 0.25, HRRR: 0.00, NBM: 0.30, ECMWF: 0.30, GFS: 0.15 };
}

function weightedMeanBySource(sourceMap, weights) {
  let sum = 0;
  let wSum = 0;
  for (const [k, val] of Object.entries(sourceMap)) {
    const n = toFiniteNumber(val);
    const w = weights[k] || 0;
    if (n != null && w > 0) {
      sum += n * w;
      wSum += w;
    }
  }
  return wSum > 0 ? sum / wSum : null;
}

function getEnsembleSeriesValue(hourly, units, baseField, suffixes, idx, converter = (v) => toFiniteNumber(v), defaultUnit = '') {
  if (!hourly || idx < 0) return null;
  for (const suf of suffixes) {
    const key = suf ? `${baseField}_${suf}` : baseField;
    const arr = hourly[key];
    if (Array.isArray(arr) && idx < arr.length && arr[idx] != null) {
      return converter(arr[idx], units?.[key] || units?.[baseField] || defaultUnit);
    }
  }
  return null;
}

function hasAnyEnsembleModelSuffix(hourly) {
  if (!hourly || typeof hourly !== 'object') return false;
  return Object.keys(hourly).some((k) =>
    k.endsWith('_ncep_hrrr_conus') ||
    k.endsWith('_ncep_nbm_conus') ||
    k.endsWith('_ecmwf_ifs025') ||
    k.endsWith('_gfs_global') ||
    k.endsWith('_gfs_hrrr')
  );
}

/**
 * 5-Source Horizon-Weighted Multi-Model Consensus + ASOS MOS + Confidence % + All-Weather Hazards (Spec §5).
 */
export function buildMultiModelConsensus({
  nwsBundle = null,
  openMeteoEnsemble = null,
  openMeteo = null,
  locationAnchor = null,
  userLat = null,
  userLon = null,
  userElevFt = null,
  timeZone: explicitTimeZone = null,
  multiDaySpc = null,
  localAlerts = [],
  nowMs = Date.now()
} = {}) {
  const refNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const timeZone = explicitTimeZone || locationAnchor?.timeZone || resolveLocationTimeZone(nwsBundle, openMeteo || openMeteoEnsemble);
  const effLat = locationAnchor?.lat ?? userLat;
  const effLon = locationAnchor?.lon ?? userLon;
  const omElevM = toFiniteNumber((openMeteoEnsemble || openMeteo)?.elevation);
  const effElevFt = locationAnchor?.elevationFt ?? userElevFt ?? nwsBundle?.elevationFt ?? (omElevM != null ? Math.round(omElevM / 0.3048) : null);
  const omSource = (openMeteoEnsemble?.hourly?.time?.length ? openMeteoEnsemble : null) || openMeteo || null;
  const hourly = omSource?.hourly || {};
  const units = omSource?.hourly_units || {};
  const offsetSec = Number.isFinite(omSource?.utc_offset_seconds) ? omSource.utc_offset_seconds : 0;
  const offsetOpts = offsetSec !== 0 ? { utcOffsetSeconds: offsetSec } : {};
  const rawTimes = Array.isArray(hourly.time) ? hourly.time : [];
  const startIdx = rawTimes.length ? findWinterStartHourIndex(rawTimes, refNowMs, offsetSec) : 0;

  const horizonCount = Math.min(72, rawTimes.length ? Math.max(0, rawTimes.length - startIdx) : 48);
  const floorHourMs = Math.floor(refNowMs / 3600000) * 3600000;
  const slotEpochMs = [];
  for (let h = 0; h < horizonCount; h++) {
    const rawT = rawTimes[startIdx + h];
    const ms = rawT ? parseUtcTimestampMs(rawT, offsetOpts) : (floorHourMs + h * 3600000);
    slotEpochMs.push(ms ?? (floorHourMs + h * 3600000));
  }

  const nwsHourlyGrid = nwsBundle?.gridData
    ? resampleNwsGridToHourly(nwsBundle.gridData, slotEpochMs)
    : [];
  const hasNwsGrid = nwsHourlyGrid.some((s) => s.tempF != null || s.qpfIn != null || s.snowIn != null || s.popPct != null);
  const hasEnsemble = hasAnyEnsembleModelSuffix(hourly);

  const fallbackHourly = openMeteo?.hourly || {};
  const fallbackUnits = openMeteo?.hourly_units || {};
  const fallbackStartIdx = Array.isArray(fallbackHourly.time) && fallbackHourly.time.length
    ? findWinterStartHourIndex(fallbackHourly.time, refNowMs, openMeteo?.utc_offset_seconds ?? 0)
    : 0;

  // Detect active model slugs
  const activeModels = [];
  if (hasNwsGrid) activeModels.push('NWS');
  const activeOmSpecs = [];
  if (hasEnsemble) {
    for (const spec of ENSEMBLE_MODEL_SPECS) {
      const present = spec.suffixes.some((suf) => {
        const arr = hourly[`temperature_2m_${suf}`];
        return Array.isArray(arr) && arr.some((v) => toFiniteNumber(v) != null);
      });
      if (present) {
        activeModels.push(spec.name);
        activeOmSpecs.push(spec);
      }
    }
  } else if (Array.isArray(hourly.temperature_2m) && hourly.temperature_2m.some((v) => toFiniteNumber(v) != null)) {
    activeModels.push('HRRR');
    activeOmSpecs.push({ key: 'HRRR', name: 'HRRR', resolution: '3 km', suffixes: [''] });
  }

  // Per-model 48h & 72h summary accumulators
  const modelStats = {};
  const initStat = (name, resolution) => ({
    name,
    resolution,
    minTemp48hF: Infinity,
    maxTemp48hF: -Infinity,
    qpf48hIn: 0,
    snow48hIn: 0,
    ice48hIn: 0,
    peakGust48hMph: 0,
    minTemp72hF: Infinity,
    snow72hIn: 0,
    ice72hIn: 0,
    validCount: 0
  });
  if (hasNwsGrid) modelStats.NWS = initStat('NWS', '2.5 km WFO');
  for (const spec of activeOmSpecs) modelStats[spec.name] = initStat(spec.name, spec.resolution);

  // Pass 1: compute raw multi-model weighted hourly series + per-model stats
  const rawSlots = [];
  let hourlyTempSpreadSum = 0;
  let hourlyTempSpreadCount = 0;

  for (let h = 0; h < horizonCount; h++) {
    const i = startIdx + h;
    const fi = fallbackStartIdx + h;
    const weights = horizonWeightsForHour(h);
    const nws = nwsHourlyGrid[h] || null;

    const tMap = {};
    const tdMap = {};
    const qpfMap = {};
    const popMap = {};
    const snowMap = {};
    const windMap = {};
    const gustMap = {};
    const skyMap = {};
    const appMap = {};
    const visCandidates = [];
    let hasHrrrOrNbmVis = false;
    let gfsVisMi = null;

    if (hasNwsGrid && nws) {
      const nwsPeriodTemp = toFiniteNumber(nwsBundle?.hourlyPeriods?.[h]?.temperature);
      const nwsTempVal = nws.tempF ?? nwsPeriodTemp;
      if (nwsTempVal != null) tMap.NWS = nwsTempVal;
      if (nws.dewpointF != null) tdMap.NWS = nws.dewpointF;
      if (nws.qpfIn != null) qpfMap.NWS = nws.qpfIn;
      if (nws.popPct != null) popMap.NWS = nws.popPct;
      if (nws.snowIn != null) snowMap.NWS = nws.snowIn;
      if (nws.windMph != null) windMap.NWS = nws.windMph;
      if (nws.gustMph != null) gustMap.NWS = nws.gustMph;
      if (nws.skyCoverPct != null) skyMap.NWS = nws.skyCoverPct;
      if (nws.apparentTempF != null) appMap.NWS = nws.apparentTempF;
      if (nws.visibilityMi != null) visCandidates.push(nws.visibilityMi);

      const st = modelStats.NWS;
      if (nwsTempVal != null) {
        st.validCount++;
        if (nwsTempVal < st.minTemp72hF) st.minTemp72hF = nwsTempVal;
        if (h < 48) {
          if (nwsTempVal < st.minTemp48hF) st.minTemp48hF = nwsTempVal;
          if (nwsTempVal > st.maxTemp48hF) st.maxTemp48hF = nwsTempVal;
        }
      } else if (nws.qpfIn != null || nws.snowIn != null || nws.iceIn != null) {
        st.validCount++;
      }
      if (h < 48) {
        if (nws.qpfIn != null) st.qpf48hIn += nws.qpfIn;
        if (nws.snowIn != null) st.snow48hIn += nws.snowIn;
        if (nws.iceIn != null) st.ice48hIn += nws.iceIn;
        const gVal = nws.gustMph ?? nws.windMph ?? 0;
        if (gVal > st.peakGust48hMph) st.peakGust48hMph = gVal;
      }
      if (nws.snowIn != null) st.snow72hIn += nws.snowIn;
      if (nws.iceIn != null) st.ice72hIn += nws.iceIn;
    }

    for (const spec of activeOmSpecs) {
      const tVal = getEnsembleSeriesValue(hourly, units, 'temperature_2m', spec.suffixes, i, convertTempToF, '°F');
      const tdVal = getEnsembleSeriesValue(hourly, units, 'dew_point_2m', spec.suffixes, i, convertTempToF, '°F');
      const qpfVal = getEnsembleSeriesValue(hourly, units, 'precipitation', spec.suffixes, i, convertPrecipToInches, 'inch');
      const popVal = getEnsembleSeriesValue(hourly, units, 'precipitation_probability', spec.suffixes, i);
      const snowVal = getEnsembleSeriesValue(hourly, units, 'snowfall', spec.suffixes, i, convertSnowfallToInches, 'inch');
      const windVal = getEnsembleSeriesValue(hourly, units, 'wind_speed_10m', spec.suffixes, i, convertWindToMph, 'mp/h');
      const gustVal = getEnsembleSeriesValue(hourly, units, 'wind_gusts_10m', spec.suffixes, i, convertWindToMph, 'mp/h');
      const skyVal = getEnsembleSeriesValue(hourly, units, 'cloud_cover', spec.suffixes, i);
      const appVal = getEnsembleSeriesValue(hourly, units, 'apparent_temperature', spec.suffixes, i, convertTempToF, '°F');
      const visVal = getEnsembleSeriesValue(hourly, units, 'visibility', spec.suffixes, i, convertVisibilityToMiles, 'm');
      const wmoVal = getEnsembleSeriesValue(hourly, units, 'weather_code', spec.suffixes, i);

      if (tVal != null) tMap[spec.key] = tVal;
      if (tdVal != null) tdMap[spec.key] = tdVal;
      if (qpfVal != null) qpfMap[spec.key] = Math.max(0, qpfVal);
      if (popVal != null) popMap[spec.key] = clampNum(popVal, 0, 100);
      if (snowVal != null) snowMap[spec.key] = Math.max(0, snowVal);
      if (windVal != null) windMap[spec.key] = Math.max(0, windVal);
      if (gustVal != null) gustMap[spec.key] = Math.max(0, gustVal);
      if (skyVal != null) skyMap[spec.key] = clampNum(skyVal, 0, 100);
      if (appVal != null) appMap[spec.key] = appVal;
      if (visVal != null) {
        const safeVis = Math.max(0, visVal);
        if (spec.key === 'HRRR' || spec.key === 'NBM') {
          visCandidates.push(safeVis);
          hasHrrrOrNbmVis = true;
        } else if (spec.key === 'GFS') {
          gfsVisMi = safeVis;
        }
      }

      const st = modelStats[spec.name];
      if (tVal != null) {
        st.validCount++;
        if (tVal < st.minTemp72hF) st.minTemp72hF = tVal;
        if (h < 48) {
          if (tVal < st.minTemp48hF) st.minTemp48hF = tVal;
          if (tVal > st.maxTemp48hF) st.maxTemp48hF = tVal;
        }
        const pSafe = Math.max(0, qpfVal ?? 0);
        const sSafe = Math.max(0, snowVal ?? 0);
        const wInt = Math.trunc(wmoVal ?? 0);
        const isFz = (wInt === 56 || wInt === 57 || wInt === 66 || wInt === 67) || (pSafe >= 0.004 && sSafe < 0.02 && tVal <= 32.2);
        const iceEst = isFz ? computeHourlyIceAccretion('FREEZING_RAIN', tVal, pSafe) : 0;
        if (h < 48) {
          st.qpf48hIn += pSafe;
          st.snow48hIn += sSafe;
          st.ice48hIn += iceEst;
          const gVal = Math.max(gustVal ?? 0, windVal ?? 0);
          if (gVal > st.peakGust48hMph) st.peakGust48hMph = gVal;
        }
        st.snow72hIn += sSafe;
        st.ice72hIn += iceEst;
      }
    }

    if (!hasHrrrOrNbmVis && gfsVisMi != null) {
      visCandidates.push(gfsVisMi);
    }

    const modelTemps = Object.values(tMap).filter((v) => toFiniteNumber(v) != null);
    const modelTempSpreadF = modelTemps.length >= 2 ? (Math.max(...modelTemps) - Math.min(...modelTemps)) : 0;
    if (h < 48 && modelTemps.length >= 2) {
      hourlyTempSpreadSum += modelTempSpreadF;
      hourlyTempSpreadCount += 1;
    }

    const rawTempF = weightedMeanBySource(tMap, weights)
      ?? convertTempToF(fallbackHourly.temperature_2m?.[fi], fallbackUnits.temperature_2m || '°F')
      ?? toFiniteNumber(nwsBundle?.hourlyPeriods?.[h]?.temperature)
      ?? null;
    const rawDewF = weightedMeanBySource(tdMap, weights)
      ?? convertTempToF(fallbackHourly.dew_point_2m?.[fi], fallbackUnits.dew_point_2m || '°F')
      ?? (rawTempF != null ? rawTempF - 6 : null);
    const rawQpfIn = weightedMeanBySource(qpfMap, weights) ?? 0;
    let rawPopPct = weightedMeanBySource(popMap, weights)
      ?? toFiniteNumber(nwsBundle?.hourlyPeriods?.[h]?.probabilityOfPrecipitation?.value)
      ?? 0;
    if (rawQpfIn >= 0.04) rawPopPct = Math.max(rawPopPct, 60);
    const rawSnowAloftIn = weightedMeanBySource(snowMap, weights) ?? 0;
    const rawWindMph = weightedMeanBySource(windMap, weights) ?? 0;
    const rawGustMph = Math.max(rawWindMph, weightedMeanBySource(gustMap, weights) ?? rawWindMph);
    const rawSkyPct = weightedMeanBySource(skyMap, weights);
    const rawAppF = weightedMeanBySource(appMap, weights);
    const thunderProbPct = nws?.thunderProbPct ?? 0;

    // Representative WMO code (HRRR -> NBM -> ECMWF -> GFS -> fallback)
    const wmoCode = Math.trunc(
      getEnsembleSeriesValue(hourly, units, 'weather_code', ['ncep_hrrr_conus', 'ncep_nbm_conus', 'ecmwf_ifs025', 'gfs_global', ''], i)
      ?? toFiniteNumber(fallbackHourly.weather_code?.[fi])
      ?? 0
    );
    const isDayVal = getEnsembleSeriesValue(hourly, units, 'is_day', ['ncep_hrrr_conus', 'ecmwf_ifs025', 'gfs_global', ''], i)
      ?? toFiniteNumber(fallbackHourly.is_day?.[fi]);

    rawSlots.push({
      leadHour: h,
      epochMs: slotEpochMs[h],
      rawTempF,
      rawDewF,
      rawQpfIn: Math.max(0, rawQpfIn),
      popPct: Math.round(clampNum(rawPopPct, 0, 100)),
      snowAloftIn: Math.max(0, rawSnowAloftIn),
      rawWindMph: Math.max(0, rawWindMph),
      rawGustMph: Math.max(0, rawGustMph),
      skyCoverPct: rawSkyPct != null ? Math.round(clampNum(rawSkyPct, 0, 100)) : null,
      rawAppF,
      visibilityMi: visCandidates.length ? Math.min(...visCandidates) : 10.0,
      thunderProbPct: Math.round(clampNum(thunderProbPct, 0, 100)),
      wmoCode,
      isDay: isDayVal != null ? isDayVal >= 0.5 : null,
      modelTempSpreadF: Number(modelTempSpreadF.toFixed(1)),
      nwsGridSlot: nws
    });
  }

  // Step 2: Live ASOS/METAR MOS Calibration anchored against Hour-0 Raw Multi-Model Consensus
  const h0 = rawSlots[0] || {};
  const asosMos = computeAsosMosCalibration({
    userLat: effLat,
    userLon: effLon,
    userElevFt: effElevFt,
    nwsObservations: nwsBundle?.observations || [],
    rawModelHour0: {
      tempF: h0.rawTempF,
      dewpointF: h0.rawDewF,
      windMph: h0.rawWindMph
    },
    nowMs: refNowMs
  });

  // Step 3: Apply exponential MOS decay (Hours 0–12) & recompute RH, Tw, Feels-Like
  const consensusHourly = rawSlots.map((slot) => {
    const { dTempF, dDewF, dWindMph } = applyAsosMosDecayAtHour(asosMos, slot.leadHour);
    const tempF = slot.rawTempF != null ? (slot.rawTempF + dTempF) : null;
    const dewpointF = slot.rawDewF != null
      ? (tempF != null ? Math.min(tempF, slot.rawDewF + dDewF) : (slot.rawDewF + dDewF))
      : null;
    const windMph = Math.max(0, slot.rawWindMph + dWindMph);
    const gustMph = Math.max(windMph, slot.rawGustMph + dWindMph);
    const rhPct = (tempF != null && dewpointF != null) ? Math.round(deriveRhFromTempDewF(tempF, dewpointF)) : 70;
    const wetBulbF = tempF != null ? computeWetBulbF(tempF, rhPct) : null;

    let feelsLikeF = slot.rawAppF != null ? (slot.rawAppF + dTempF) : tempF;
    if (tempF != null && tempF >= 80 && rhPct >= 40) {
      feelsLikeF = computeHeatIndexF(tempF, rhPct);
    } else if (tempF != null && tempF <= 50 && windMph >= 3) {
      feelsLikeF = computeWindChillF(tempF, windMph);
    }

    const visMi = slot.leadHour === 0 && asosMos.obsVisMi != null
      ? Math.min(asosMos.obsVisMi, slot.visibilityMi)
      : slot.visibilityMi;

    return {
      leadHour: slot.leadHour,
      epochMs: slot.epochMs,
      hourLabel: slot.leadHour === 0 ? 'Now' : formatLocalHour(slot.epochMs, timeZone),
      tempF: tempF != null ? Number(tempF.toFixed(1)) : null,
      rawTempF: slot.rawTempF != null ? Number(slot.rawTempF.toFixed(1)) : null,
      dewpointF: dewpointF != null ? Number(dewpointF.toFixed(1)) : null,
      wetBulbF: wetBulbF != null ? Number(wetBulbF.toFixed(1)) : null,
      rhPct,
      feelsLikeF: feelsLikeF != null ? Number(feelsLikeF.toFixed(1)) : null,
      popPct: slot.popPct,
      qpfIn: Number(slot.rawQpfIn.toFixed(3)),
      snowAloftIn: Number(slot.snowAloftIn.toFixed(3)),
      windMph: Number(windMph.toFixed(1)),
      gustMph: Number(gustMph.toFixed(1)),
      skyCoverPct: slot.skyCoverPct,
      visibilityMi: Number(visMi.toFixed(1)),
      thunderProbPct: slot.thunderProbPct,
      wmoCode: slot.wmoCode,
      isDay: slot.isDay,
      mosDeltaAppliedF: Number(dTempF.toFixed(2)),
      modelTempSpreadF: slot.modelTempSpreadF,
      nwsGridSlot: slot.nwsGridSlot
    };
  });

  // Step 4: Build perModelSummary & Calibrated Forecast Confidence % (Spec §5.4)
  const perModelSummary = Object.values(modelStats)
    .filter((st) => st.validCount > 0)
    .map((st) => ({
      name: st.name,
      resolution: st.resolution,
      minTemp48hF: Number.isFinite(st.minTemp48hF) ? Number(st.minTemp48hF.toFixed(1)) : null,
      maxTemp48hF: Number.isFinite(st.maxTemp48hF) ? Number(st.maxTemp48hF.toFixed(1)) : null,
      qpf48hIn: Number(st.qpf48hIn.toFixed(2)),
      snow48hIn: Number(st.snow48hIn.toFixed(2)),
      ice48hIn: Number(st.ice48hIn.toFixed(2)),
      peakGust48hMph: Math.round(st.peakGust48hMph),
      minTemp72hF: Number.isFinite(st.minTemp72hF) ? Number(st.minTemp72hF.toFixed(1)) : null,
      snow72hIn: Number(st.snow72hIn.toFixed(1)),
      ice72hIn: Number(st.ice72hIn.toFixed(2))
    }));

  const avgHourlyTempSpreadF = hourlyTempSpreadCount > 0 ? (hourlyTempSpreadSum / hourlyTempSpreadCount) : 0;
  const minTemps48 = perModelSummary.map((m) => m.minTemp48hF).filter((v) => v != null);
  const minTempSpreadF = minTemps48.length >= 2 ? (Math.max(...minTemps48) - Math.min(...minTemps48)) : 0;
  const sigmaT = 0.6 * avgHourlyTempSpreadF + 0.4 * minTempSpreadF;

  const qpfs48 = perModelSummary.map((m) => m.qpf48hIn);
  const qpfSpreadIn = qpfs48.length >= 2 ? (Math.max(...qpfs48) - Math.min(...qpfs48)) : 0;
  const snows48 = perModelSummary.map((m) => m.snow48hIn);
  const snowSpreadIn = snows48.length >= 2 ? (Math.max(...snows48) - Math.min(...snows48)) : 0;
  const gusts48 = perModelSummary.map((m) => m.peakGust48hMph);
  const windSpreadMph = gusts48.length >= 2 ? (Math.max(...gusts48) - Math.min(...gusts48)) : 0;

  const nwsSum = perModelSummary.find((m) => m.name === 'NWS');
  const nbmSum = perModelSummary.find((m) => m.name === 'NBM');
  const maxSnow48 = snows48.length ? Math.max(...snows48) : 0;
  const maxIce48 = perModelSummary.length ? Math.max(...perModelSummary.map((m) => m.ice48hIn)) : 0;
  const snowPhaseSplit = maxSnow48 >= 0.25 && (
    (nwsSum && nwsSum.snow48hIn < 0.05) ||
    (nbmSum && nbmSum.snow48hIn < 0.15)
  );
  const icePhaseSplit = maxIce48 >= 0.05 && Boolean(nwsSum && nwsSum.ice48hIn < 0.01);
  const phaseDisagreement = Boolean(snowPhaseSplit || icePhaseSplit);
  const pPhase = phaseDisagreement ? 15 : 0;
  const pMissing = Math.max(0, (4 - perModelSummary.length) * 4);

  const confidencePct = clampNum(
    Math.round(96.0 - 3.2 * sigmaT - 12.0 * qpfSpreadIn - 6.0 * snowSpreadIn - 0.4 * windSpreadMph - pPhase - pMissing),
    25,
    98
  );
  const confidenceTier = confidencePct >= 80 ? 'HIGH' : confidencePct >= 60 ? 'MODERATE' : 'LOW';

  let spreadSummary;
  if (snowPhaseSplit) {
    const snowyNames = perModelSummary.filter((m) => m.snow48hIn >= 0.25).map((m) => m.name).join('/');
    const rainNames = perModelSummary.filter((m) => m.snow48hIn < 0.15).map((m) => m.name).join('/');
    spreadSummary = `Rain/Snow phase split: ${snowyNames} aloft snow vs ${rainNames || 'NWS/NBM'} rain`;
  } else if (icePhaseSplit) {
    spreadSummary = 'Freezing rain/sleet phase uncertainty across models vs NWS grid';
  } else if (perModelSummary.length >= 2) {
    const qualifier = confidenceTier === 'HIGH' ? 'Tight' : confidenceTier === 'MODERATE' ? 'Moderate' : 'Wide';
    spreadSummary = `${qualifier} ${perModelSummary.length}-source consensus (±${sigmaT.toFixed(1)}°F, ±${qpfSpreadIn.toFixed(2)}" QPF)`;
  } else {
    spreadSummary = 'Single-model fallback (reduced consensus confidence)';
  }

  // Step 5: All-Weather Hazards (Spec §5.3: Flash Flood, Wind, Fog, Heat)
  const next24 = consensusHourly.slice(0, 24);
  const peakQpf24hIn = Number(next24.reduce((a, s) => a + (s.qpfIn || 0), 0).toFixed(2));
  let peakQpf6hIn = 0;
  for (let i = 0; i < next24.length; i++) {
    let s6 = 0;
    for (let j = i; j < Math.min(next24.length, i + 6); j++) s6 += next24[j].qpfIn || 0;
    if (s6 > peakQpf6hIn) peakQpf6hIn = s6;
  }
  peakQpf6hIn = Number(peakQpf6hIn.toFixed(2));

  const wpcEro = String(multiDaySpc?.wpcDay1FloodRisk || 'NONE').toUpperCase();
  const localMpdCount = Array.isArray(multiDaySpc?.localMpds) ? multiDaySpc.localMpds.length : 0;
  const hasFfw = (localAlerts || []).some((a) => !a.isExpired && String(a.event || '').toLowerCase().includes('flash flood warning'));
  let floodRisk = 'NONE';
  if (wpcEro === 'HIGH' || hasFfw || peakQpf6hIn >= 4.0) floodRisk = 'EXTREME';
  else if (wpcEro === 'MDT' || (localMpdCount > 0 && peakQpf6hIn >= 2.0) || peakQpf6hIn >= 2.5 || peakQpf24hIn >= 4.0) floodRisk = 'HIGH';
  else if (wpcEro === 'SLGT' || localMpdCount > 0 || peakQpf6hIn >= 1.5 || peakQpf24hIn >= 2.5) floodRisk = 'MODERATE';
  else if (wpcEro === 'MRGL' || peakQpf24hIn >= 1.25) floodRisk = 'LOW';

  const peakGust24hMph = Math.round(next24.reduce((m, s) => Math.max(m, s.gustMph || 0), 0));
  const peakWind24hMph = Math.round(next24.reduce((m, s) => Math.max(m, s.windMph || 0), 0));
  let windRisk = 'CALM';
  if (peakGust24hMph >= 50 || peakWind24hMph >= 35) windRisk = 'HIGH_WIND';
  else if (peakGust24hMph >= 35 || peakWind24hMph >= 25) windRisk = 'WIND_ADVISORY';
  else if (peakGust24hMph >= 25) windRisk = 'BREEZY';

  const minVisibilityMi = Number(
    next24.reduce((m, s) => Math.min(m, s.visibilityMi ?? 10), asosMos.obsVisMi ?? 10).toFixed(1)
  );
  const nowTempEff = consensusHourly[0]?.tempF ?? 50;
  let fogRisk = 'CLEAR';
  if (minVisibilityMi <= 0.5 && nowTempEff <= 32.0) fogRisk = 'FREEZING_FOG';
  else if (minVisibilityMi <= 0.5) fogRisk = 'DENSE_FOG';
  else if (minVisibilityMi < 3.0) fogRisk = 'FOG_MIST';

  const maxHeatIndex24hF = Math.round(
    next24.reduce((m, s) => Math.max(m, computeHeatIndexF(s.tempF, s.rhPct) ?? -99), -99)
  );
  let heatRisk = 'NONE';
  if (maxHeatIndex24hF >= 110) heatRisk = 'EXCESSIVE_HEAT';
  else if (maxHeatIndex24hF >= 105) heatRisk = 'HEAT_ADVISORY';
  else if (maxHeatIndex24hF >= 95) heatRisk = 'HEAT_CAUTION';

  return {
    activeModels,
    timeZone,
    asosMos,
    hourly: consensusHourly,
    perModelSummary,
    confidencePct,
    confidenceTier,
    tempSpreadF: Number(sigmaT.toFixed(1)),
    qpfSpreadIn: Number(qpfSpreadIn.toFixed(2)),
    snowSpreadIn: Number(snowSpreadIn.toFixed(2)),
    windSpreadMph: Math.round(windSpreadMph),
    phaseDisagreement,
    spreadSummary,
    allWeatherHazards: {
      floodRisk,
      windRisk,
      fogRisk,
      heatRisk,
      peakQpf6hIn,
      peakQpf24hIn,
      peakGust24hMph,
      maxHeatIndex24hF: maxHeatIndex24hF > -90 ? maxHeatIndex24hF : null,
      minVisibilityMi
    }
  };
}

/**
 * Multi-station NWS ASOS/AWOS + NDFD/NBM + Open-Meteo (HRRR/NBM/ECMWF/GFS) Accuracy Consensus Resolver
 */
export function resolveCurrentConditions(nwsBundle, openMeteo, nowMs = Date.now(), extras = {}) {
  const cur = openMeteo?.current || {};
  const curUnits = openMeteo?.current_units || {};
  const hourly = openMeteo?.hourly || {};
  const hourlyUnits = openMeteo?.hourly_units || {};
  const refMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const idx = findCurrentHourIndex(hourly, refMs, openMeteo?.utc_offset_seconds ?? 0);

  // If v2.0 consensus & ASOS MOS are supplied, fuse Hero directly per Spec §4.2 #5
  const consensus = extras?.consensus || null;
  const asosMos = extras?.asosMos || consensus?.asosMos || null;
  const locationAnchor = extras?.locationAnchor || null;
  if (consensus && Array.isArray(consensus.hourly) && consensus.hourly.length > 0) {
    const h0 = consensus.hourly[0];
    const primaryObs = asosMos?.primaryObs || null;
    const tempF = asosMos?.mosApplied && asosMos.obsTempF != null && h0.tempF != null
      ? Math.round(0.75 * asosMos.obsTempF + 0.25 * h0.tempF)
      : (h0.tempF != null ? Math.round(h0.tempF) : null);
    const dewpointF = asosMos?.mosApplied && asosMos.obsDewpointF != null && h0.dewpointF != null
      ? Math.round(0.65 * asosMos.obsDewpointF + 0.35 * h0.dewpointF)
      : (h0.dewpointF != null ? Math.round(h0.dewpointF) : null);
    const windMph = Math.round(Math.max(0, asosMos?.obsWindMph ?? h0.windMph ?? 0));
    const obsGustMph = convertWindToMph(primaryObs?.props?.windGust?.value, primaryObs?.props?.windGust?.unitCode || 'wmoUnit:km_h-1');
    const gustMph = obsGustMph != null ? Math.round(Math.max(windMph, obsGustMph)) : (h0.gustMph != null ? Math.round(h0.gustMph) : null);

    const windDir = toFiniteNumber(primaryObs?.props?.windDirection?.value)
      ?? getEnsembleSeriesValue(hourly, hourlyUnits, 'wind_direction_10m', ['ncep_hrrr_conus', 'ncep_nbm_conus', 'ecmwf_ifs025', 'gfs_global', ''], idx)
      ?? toFiniteNumber(cur.wind_direction_10m)
      ?? null;

    const pHpaEns = getEnsembleSeriesValue(hourly, hourlyUnits, 'pressure_msl', ['ncep_hrrr_conus', 'ecmwf_ifs025', 'gfs_global', ''], idx, convertPressureToHpa, 'hPa');
    const p3hAgoEns = idx >= 3
      ? getEnsembleSeriesValue(hourly, hourlyUnits, 'pressure_msl', ['ncep_hrrr_conus', 'ecmwf_ifs025', 'gfs_global', ''], idx - 3, convertPressureToHpa, 'hPa')
      : null;
    const pressureHpa = convertPressureToHpa(primaryObs?.props?.seaLevelPressure?.value, primaryObs?.props?.seaLevelPressure?.unitCode || 'wmoUnit:Pa')
      ?? convertPressureToHpa(primaryObs?.props?.barometricPressure?.value, primaryObs?.props?.barometricPressure?.unitCode || 'wmoUnit:Pa')
      ?? pHpaEns
      ?? convertPressureToHpa(cur.pressure_msl, curUnits.pressure_msl || 'hPa')
      ?? null;
    const pressureTrend3h = (pHpaEns != null && p3hAgoEns != null) ? (pHpaEns - p3hAgoEns) : 0;

    const humidity = (tempF != null && dewpointF != null)
      ? Math.round(deriveRhFromTempDewF(tempF, dewpointF))
      : (h0.rhPct ?? null);
    const feelsLikeF = tempF != null
      ? Math.round(
          tempF >= 80 && (humidity ?? 0) >= 40
            ? computeHeatIndexF(tempF, humidity)
            : (tempF <= 50 && windMph >= 3 ? computeWindChillF(tempF, windMph) : (h0.feelsLikeF ?? tempF))
        )
      : null;

    const visMi = Math.max(0, asosMos?.obsVisMi ?? h0.visibilityMi ?? 10);
    const [wmoLabel, wmoIcon] = wmoInfo(h0.wmoCode ?? cur.weather_code);
    const conditionText = primaryObs?.props?.textDescription || wmoLabel;
    const pressureInHgVal = pressureHpa != null ? hpaToInHg(pressureHpa) : null;
    const modelStr = (consensus.activeModels || []).join(' + ') || 'Multi-Model Consensus';
    const sourceLabel = asosMos?.mosApplied
      ? `ASOS MOS (${asosMos.stationIds.join(', ')}) + ${modelStr}`
      : modelStr;
    const confLabel = consensus.confidenceTier === 'HIGH' ? 'High' : consensus.confidenceTier === 'MODERATE' ? 'Moderate' : 'Low';

    return {
      tempF,
      feelsLikeF,
      dewpointF,
      humidity,
      windMph,
      gustMph,
      windDirDeg: windDir,
      windCompass: degToCompass(windDir),
      pressureHpa: pressureHpa != null ? Number(pressureHpa.toFixed(1)) : null,
      pressureInHg: pressureInHgVal != null ? pressureInHgVal.toFixed(2) : '--',
      pressureTrend3h: Number(pressureTrend3h.toFixed(1)),
      visibilityMi: Number(visMi.toFixed(1)),
      cloudCover: h0.skyCoverPct ?? toFiniteNumber(cur.cloud_cover),
      conditionText,
      icon: wmoIcon,
      sourceLabel,
      spreadF: consensus.tempSpreadF ?? 0,
      confidence: confLabel,
      confidencePct: consensus.confidencePct,
      confidenceTier: consensus.confidenceTier,
      mosSummaryBadge: asosMos?.mosSummaryBadge || 'Model Consensus (No Recent ASOS)',
      mosApplied: Boolean(asosMos?.mosApplied),
      asosMos,
      locationAnchor
    };
  }

  const stationTemps = [];
  const stationDews = [];
  const stationNames = [];
  let primaryObs = null;

  const omTemp = convertTempToF(cur.temperature_2m, curUnits.temperature_2m || '°F');
  const firstNwsPeriod = nwsBundle?.hourlyPeriods?.[0];
  const nwsHourlyTemp = convertTempToF(firstNwsPeriod?.temperature, firstNwsPeriod?.temperatureUnit || 'F');
  const anchorTemp = nwsHourlyTemp ?? omTemp;

  // Outlier rejection (screens rural municipal AWOS cold-drainage glitches > 4.5°F from NDFD/HRRR anchor)
  const validStations = [];
  for (const obs of nwsBundle?.observations || []) {
    const p = obs?.props;
    if (!p) continue;
    if (p.timestamp) {
      const obsMs = parseUtcTimestampMs(p.timestamp);
      if (obsMs == null || !Number.isFinite(obsMs)) continue;
      const ageMin = (refMs - obsMs) / 60000;
      if (ageMin > 90 || ageMin < -15) continue;
    }
    const tF = convertTempToF(p.temperature?.value, p.temperature?.unitCode || 'wmoUnit:degC');
    const dF = convertTempToF(p.dewpoint?.value, p.dewpoint?.unitCode || 'wmoUnit:degC');
    const rh = toFiniteNumber(p.relativeHumidity?.value);
    const desc = String(p.textDescription || '').toLowerCase();
    const bogusClear100Rh = rh != null && rh >= 99 && (desc.includes('clear') || desc.includes('fair') || desc.includes('sunny'));
    if (tF != null && Number.isFinite(tF)) {
      if (anchorTemp != null && Math.abs(tF - anchorTemp) > 4.5) continue;
      validStations.push({ obs, tF, dF: bogusClear100Rh ? null : dF, rh: bogusClear100Rh ? null : rh });
    }
  }

  for (const vs of validStations) {
    stationTemps.push(vs.tF);
    stationNames.push(vs.obs.stationId);
    if (!primaryObs) primaryObs = vs.obs;
    if (vs.dF != null && Number.isFinite(vs.dF)) stationDews.push(vs.dF);
  }

  const samples = [];
  if (nwsHourlyTemp != null) samples.push({ v: nwsHourlyTemp, w: 0.45 });
  stationTemps.forEach((t, i) => samples.push({ v: t, w: i === 0 ? 0.35 : 0.2 }));
  if (omTemp != null) samples.push({ v: omTemp, w: stationTemps.length || nwsHourlyTemp != null ? 0.2 : 1.0 });

  const totalW = samples.reduce((a, s) => a + s.w, 0) || 1;
  const tempF = samples.length
    ? samples.reduce((a, s) => a + s.v * s.w, 0) / totalW
    : omTemp;

  const spreadF = samples.length >= 2
    ? Math.max(...samples.map((s) => s.v)) - Math.min(...samples.map((s) => s.v))
    : 0;

  const omDewF = convertTempToF(cur.dew_point_2m, curUnits.dew_point_2m || curUnits.temperature_2m || '°F');
  const dewpointF = stationDews.length
    ? (stationDews[0] * 0.55 + (omDewF ?? stationDews[0]) * 0.45)
    : omDewF;

  const pressureHpa = convertPressureToHpa(primaryObs?.props?.seaLevelPressure?.value, primaryObs?.props?.seaLevelPressure?.unitCode || 'wmoUnit:Pa')
    ?? convertPressureToHpa(primaryObs?.props?.barometricPressure?.value, primaryObs?.props?.barometricPressure?.unitCode || 'wmoUnit:Pa')
    ?? convertPressureToHpa(cur.pressure_msl, curUnits.pressure_msl || 'hPa')
    ?? convertPressureToHpa(hourly.pressure_msl?.[idx], hourlyUnits.pressure_msl || 'hPa')
    ?? convertPressureToHpa(cur.surface_pressure, curUnits.surface_pressure || 'hPa')
    ?? null;

  const pNowMsl = convertPressureToHpa(hourly.pressure_msl?.[idx], hourlyUnits.pressure_msl || 'hPa')
    ?? convertPressureToHpa(cur.pressure_msl, curUnits.pressure_msl || 'hPa')
    ?? null;
  const p3hAgoRaw = idx >= 3 ? hourly.pressure_msl?.[idx - 3] : hourly.pressure_msl?.[0];
  const p3hAgoMsl = convertPressureToHpa(p3hAgoRaw, hourlyUnits.pressure_msl || 'hPa');
  const pressureTrend3h = (pNowMsl != null && p3hAgoMsl != null) ? (pNowMsl - p3hAgoMsl) : 0;

  const obsWindMph = convertWindToMph(primaryObs?.props?.windSpeed?.value, primaryObs?.props?.windSpeed?.unitCode || 'wmoUnit:km_h-1');
  const omWindMph = convertWindToMph(cur.wind_speed_10m, curUnits.wind_speed_10m || 'mp/h');
  const windMph = Math.max(0, obsWindMph ?? omWindMph ?? 0);

  const obsGustMph = convertWindToMph(primaryObs?.props?.windGust?.value, primaryObs?.props?.windGust?.unitCode || 'wmoUnit:km_h-1');
  const omGustMph = convertWindToMph(cur.wind_gusts_10m, curUnits.wind_gusts_10m || curUnits.wind_speed_10m || 'mp/h');
  const gustRaw = obsGustMph ?? omGustMph;
  const gustMph = gustRaw != null ? Math.max(0, gustRaw) : null;

  const windDir = toFiniteNumber(primaryObs?.props?.windDirection?.value) ?? toFiniteNumber(cur.wind_direction_10m) ?? null;
  const validRh = validStations.find((v) => v.rh != null)?.rh ?? null;
  const humidityRaw = validRh ?? toFiniteNumber(cur.relative_humidity_2m);
  const humidity = humidityRaw != null ? Math.max(0, Math.min(100, humidityRaw)) : null;

  const obsVisMi = convertVisibilityToMiles(primaryObs?.props?.visibility?.value, primaryObs?.props?.visibility?.unitCode || 'wmoUnit:m');
  const omVisMi = convertVisibilityToMiles(hourly.visibility?.[idx], hourlyUnits.visibility || 'm');
  const visMi = Math.max(0, obsVisMi ?? omVisMi ?? 10);

  const [wmoLabel, wmoIcon] = wmoInfo(cur.weather_code);
  const conditionText = primaryObs?.props?.textDescription || wmoLabel;

  const sourceLabel = stationNames.length
    ? `NWS ASOS (${stationNames.join(', ')}) + NDFD/NBM + HRRR/GFS`
    : 'NWS NDFD/NBM + NOAA HRRR/GFS';

  const confidence = spreadF <= 2.5 ? 'High' : spreadF <= 5 ? 'Moderate' : 'Variable';
  const feelsLikeF = convertTempToF(cur.apparent_temperature, curUnits.apparent_temperature || curUnits.temperature_2m || '°F');
  const pressureInHgVal = pressureHpa != null ? hpaToInHg(pressureHpa) : null;

  return {
    tempF: tempF != null ? Math.round(tempF) : null,
    feelsLikeF: feelsLikeF != null ? Math.round(feelsLikeF) : (tempF != null ? Math.round(tempF) : null),
    dewpointF: dewpointF != null ? Math.round(dewpointF) : null,
    humidity: humidity != null ? Math.round(humidity) : null,
    windMph: Math.round(windMph),
    gustMph: gustMph != null ? Math.round(gustMph) : null,
    windDirDeg: windDir,
    windCompass: degToCompass(windDir),
    pressureHpa: pressureHpa != null ? Number(pressureHpa.toFixed(1)) : null,
    pressureInHg: pressureInHgVal != null ? pressureInHgVal.toFixed(2) : '--',
    pressureTrend3h: Number(pressureTrend3h.toFixed(1)),
    visibilityMi: Number(visMi.toFixed(1)),
    cloudCover: toFiniteNumber(cur.cloud_cover),
    conditionText,
    icon: wmoIcon,
    sourceLabel,
    spreadF: Number(spreadF.toFixed(1)),
    confidence
  };
}

/**
 * True Upper-Air Convective, Supercell, Hail (SHIP), Damaging Wind (QLCS/DCAPE),
 * HSLC & Dixie Alley Nocturnal Readiness Analyzer.
 * Uses real 10m -> 925 -> 850 -> 700 -> 500 hPa wind/thermal profiles from NOAA HRRR/GFS
 * fused with official SPC Day 1 Categorical/Probabilistic Outlooks & Active Watches.
 */
function parseSpcProbPct(probStr) {
  const s = String(probStr || '').trim().toUpperCase();
  if (!s || s === 'NONE') return { pct: 0, sig: false, cig: 'NONE', cigRank: 0 };
  const m = s.match(/(\d+)/);
  const cig = s.includes('CIG3') ? 'CIG3' : s.includes('CIG2') ? 'CIG2' : s.includes('CIG1') ? 'CIG1' : s.includes('SIG') ? 'SIGN' : 'NONE';
  const cigRank = cig === 'CIG3' ? 3 : cig === 'CIG2' ? 2 : (cig === 'CIG1' || cig === 'SIGN') ? 1 : 0;
  return { pct: m ? Number(m[1]) : 0, sig: cigRank >= 1, cig, cigRank };
}

function spcCategoryRank(cat) {
  const map = { NONE: 0, TSTM: 1, MRGL: 2, SLGT: 3, ENH: 4, MDT: 5, HIGH: 6 };
  return map[String(cat || 'NONE').trim().toUpperCase()] || 0;
}

const CONVECTIVE_MODE_LABELS = {
  NONE: 'Stable / Non-Convective',
  DISCRETE_SUPERCELL: 'Discrete Supercells',
  HSLC_QLCS: 'HSLC Rotating QLCS / Spin-Up',
  SUPERCELL_MIXED: 'Supercells / Mixed Mode',
  QLCS_SQUALL_LINE: 'QLCS / Bowing Line',
  MULTICELL_CLUSTERS: 'Organized Multicell Clusters',
  PULSE_ORDINARY: 'Pulse / General Thunder'
};

export function classifyConvectiveMode({
  hasConvectiveInstability = false,
  peakCape12h = 0,
  peakStp12h = 0,
  peakScp12h = 0,
  peakShip12h = 0,
  peakBulkShearKt = 0,
  peakShear0to3KmKt = 0,
  peakLowLevelShearKt = 0,
  peakSrh0to1_12h = 0,
  peakDcape12h = 0,
  effDewF = 50,
  spcTorPct = 0
} = {}) {
  if (!hasConvectiveInstability) return { mode: 'NONE', label: CONVECTIVE_MODE_LABELS.NONE };
  if (
    peakStp12h >= 1.0 ||
    peakScp12h >= 4.0 ||
    (peakCape12h >= 500 && peakBulkShearKt >= 40 && peakSrh0to1_12h >= 150) ||
    spcTorPct >= 10
  ) {
    return { mode: 'DISCRETE_SUPERCELL', label: CONVECTIVE_MODE_LABELS.DISCRETE_SUPERCELL };
  }
  if (peakCape12h >= 100 && peakCape12h <= 750 && peakLowLevelShearKt >= 25 && peakBulkShearKt >= 35 && effDewF >= 58) {
    return { mode: 'HSLC_QLCS', label: CONVECTIVE_MODE_LABELS.HSLC_QLCS };
  }
  if (peakScp12h >= 2.0 || peakShip12h >= 1.0 || (peakCape12h >= 500 && peakBulkShearKt >= 35)) {
    return { mode: 'SUPERCELL_MIXED', label: CONVECTIVE_MODE_LABELS.SUPERCELL_MIXED };
  }
  if (peakCape12h >= 250 && (peakShear0to3KmKt >= 30 || peakDcape12h >= 750)) {
    return { mode: 'QLCS_SQUALL_LINE', label: CONVECTIVE_MODE_LABELS.QLCS_SQUALL_LINE };
  }
  if (peakCape12h >= 400 && peakBulkShearKt >= 20) {
    return { mode: 'MULTICELL_CLUSTERS', label: CONVECTIVE_MODE_LABELS.MULTICELL_CLUSTERS };
  }
  return { mode: 'PULSE_ORDINARY', label: CONVECTIVE_MODE_LABELS.PULSE_ORDINARY };
}

export function filterMcdsForLocation(mcdGeoJson, userLat, userLon, nowMs = Date.now()) {
  const refMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const validPt = isValidLatLon(Number(userLat), Number(userLon));
  const localMcds = [];
  const localConvectiveMcds = [];
  const nearbyMcds = [];

  for (const f of mcdGeoJson?.features || []) {
    if (!f || !f.geometry) continue;
    const p = f.properties || {};
    const expMs = parseUtcTimestampMs(p.expire ?? p.utc_expire ?? p.expired);
    if (expMs != null && expMs <= refMs) continue;

    const concerning = String(p.concerning || p.CONCERNING || '').trim();
    const isWinterOnly =
      /\b(SNOW|SLEET|ICE|FREEZING|BLIZZARD|WINTER)\b/i.test(concerning) &&
      !/\b(TORNADO|SEVERE|THUNDERSTORM|SUPERCELL|HAIL|DAMAGING\s+WIND|MCS|SQUALL)\b/i.test(concerning);
    const mdType = isWinterOnly ? 'WINTER' : 'CONVECTIVE';
    const num = p.num ?? p.NUM ?? p.id ?? '';
    const item = {
      num: String(num || ''),
      concerning: concerning || (mdType === 'WINTER' ? 'Winter Mesoscale Discussion' : 'Convective Mesoscale Discussion'),
      watchConfidence: p.watch_confidence ?? p.prob_watch ?? p.watch_prob ?? null,
      mdType,
      issue: p.issue ?? p.utc_issue ?? p.valid ?? null,
      expire: p.expire ?? p.utc_expire ?? null,
      expireMs: expMs,
      feature: f
    };

    if (validPt && isPointInGeometry(Number(userLat), Number(userLon), f.geometry)) {
      localMcds.push({ ...item, distMi: 0 });
      if (mdType === 'CONVECTIVE') localConvectiveMcds.push({ ...item, distMi: 0 });
    } else if (validPt) {
      const ctr = geometryCentroid(f.geometry);
      if (ctr) {
        const distMi = haversineMiles(Number(userLat), Number(userLon), ctr.lat, ctr.lon);
        if (Number.isFinite(distMi) && distMi <= 100.0) {
          nearbyMcds.push({ ...item, distMi: Number(distMi.toFixed(1)) });
        }
      }
    }
  }
  nearbyMcds.sort((a, b) => a.distMi - b.distMi);
  return { localMcds, localConvectiveMcds, localConvectiveMcdCount: localConvectiveMcds.length, nearbyMcds };
}

export function filterMpdsForLocation(mpdGeoJson, userLat, userLon, nowMs = Date.now()) {
  const refMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!isValidLatLon(Number(userLat), Number(userLon))) return [];
  const localMpds = [];
  for (const f of mpdGeoJson?.features || []) {
    if (!f || !f.geometry) continue;
    const p = f.properties || {};
    const expMs = parseUtcTimestampMs(p.expire ?? p.utc_expire ?? p.expired);
    if (expMs != null && expMs <= refMs) continue;
    if (isPointInGeometry(Number(userLat), Number(userLon), f.geometry)) {
      localMpds.push({
        num: String(p.num ?? p.NUM ?? p.id ?? ''),
        concerning: p.concerning || 'Heavy Rainfall / Flash Flooding',
        expire: p.expire ?? p.utc_expire ?? null,
        expireMs: expMs,
        feature: f
      });
    }
  }
  return localMpds;
}

function hazardTierMeta(rank, detail) {
  const tiers = [
    { tier: 'NONE', label: 'None', color: '#64748b' },
    { tier: 'LOW', label: 'Low', color: '#38bdf8' },
    { tier: 'MODERATE', label: 'Moderate', color: '#f59e0b' },
    { tier: 'HIGH', label: 'High', color: '#f43f5e' },
    { tier: 'EXTREME', label: 'Extreme', color: '#d946ef' }
  ];
  const clamped = Math.max(0, Math.min(4, Math.round(rank)));
  return { ...tiers[clamped], rank: clamped, detail: detail || tiers[clamped].label };
}

export function computeMixingRatioGkg(dewpointC, pressureHpa = 1000) {
  const tdC = toFiniteNumber(dewpointC);
  if (tdC == null) return 8.0;
  const pHpa = Math.max(500, Math.min(1060, toFiniteNumber(pressureHpa) ?? 1000));
  const e = 6.112 * Math.exp((17.67 * tdC) / (tdC + 243.5));
  const w = (621.97 * e) / Math.max(200, pHpa - e);
  return Number.isFinite(w) ? Math.max(0, Math.min(35, w)) : 8.0;
}

/**
 * Official NOAA/SPC Significant Hail Parameter (SHIP):
 *   SHIP = (CAPE * mixingRatio_gkg * LR_700_500 * (-T500_C) * min(27, shear06_ms)) / 42,000,000
 * with official SPC regime modifiers for low CAPE (<1300), weak lapse (<5.8), low moisture (<11 g/kg),
 * warm 500 hPa (>-5.5 C), or weak deep shear (<7 m/s).
 * Thresholds: >= 0.5 severe hail (1"+), >= 1.0 significant hail (2"+), >= 2.0 giant hail (2.5"+).
 */
export function computeSpcShip({
  cape = 0,
  mixingRatioGkg = 0,
  lapseRate700to500 = 5.8,
  temp500C = -10,
  bulkShear0to6Ms = 0
} = {}) {
  const c = Math.max(0, toFiniteNumber(cape) ?? 0);
  const w = Math.max(0, toFiniteNumber(mixingRatioGkg) ?? 0);
  const lr = Math.max(0, toFiniteNumber(lapseRate700to500) ?? 0);
  const t500 = toFiniteNumber(temp500C);
  const shr = Math.max(0, toFiniteNumber(bulkShear0to6Ms) ?? 0);
  if (c < 100 || shr < 7.0 || t500 == null || t500 >= -5.5 || lr < 4.5 || w < 4.0) {
    return 0;
  }
  const shrEff = Math.min(27.0, shr);
  let ship = (c * w * lr * (-t500) * shrEff) / 42000000;
  if (c < 1300) ship *= c / 1300;
  if (lr < 5.8) ship *= lr / 5.8;
  if (w < 11.0) ship *= w / 11.0;
  if (t500 > -8.0) ship *= (-t500) / 8.0;
  return Number.isFinite(ship) ? Math.round(Math.min(6.0, Math.max(0, ship)) * 10) / 10 : 0;
}

export function analyzeEnvironment(openMeteo, current = {}, mcdCount = 0, options = {}) {
  const safeCurrent = current || {};
  const thresholdMode = options.convectiveAlertThreshold || 'STANDARD'; // SENSITIVE | STANDARD | HIGH_ONLY
  const nocturnalEnabled = options.nocturnalReadinessEnabled !== false;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const multiDaySpc = options.multiDaySpc || null;
  const consensus = options.consensus || null;
  const timeZone = options.timeZone || consensus?.timeZone || DEFAULT_TIME_ZONE;
  const hasLocalSevereCell = Boolean(options.hasLocalSevereCell);

  const hourly = openMeteo?.hourly || {};
  const hourlyUnits = openMeteo?.hourly_units || {};
  const soundingSuffixes = hasAnyEnsembleModelSuffix(hourly)
    ? ['ncep_hrrr_conus', 'gfs_global', 'ecmwf_ifs025', 'ncep_nbm_conus', '']
    : [''];
  const getVal = (field, i, conv = (v) => toFiniteNumber(v), defUnit = '') =>
    getEnsembleSeriesValue(hourly, hourlyUnits, field, soundingSuffixes, i, conv, defUnit);

  const windUnit = hourlyUnits.wind_speed_10m || hourlyUnits.wind_speed_10m_ncep_hrrr_conus || hourlyUnits.wind_speed_500hPa || 'mp/h';
  const gustUnit = hourlyUnits.wind_gusts_10m || hourlyUnits.wind_gusts_10m_ncep_hrrr_conus || windUnit;
  const tempUnit = hourlyUnits.temperature_2m || hourlyUnits.temperature_2m_ncep_hrrr_conus || '°F';
  const upperTempUnit = hourlyUnits.temperature_700hPa || hourlyUnits.temperature_700hPa_ncep_hrrr_conus || hourlyUnits.temperature_500hPa || tempUnit;
  const offsetSec = openMeteo?.utc_offset_seconds ?? 0;
  const offsetOpts = Number.isFinite(offsetSec) && offsetSec !== 0 ? { utcOffsetSeconds: offsetSec } : {};
  const idx = findCurrentHourIndex(hourly, nowMs, offsetSec);

  const calcAt = (i, relHr = 0) => {
    const consSlot = consensus?.hourly?.[relHr] || null;
    const cape = Math.max(0, getVal('cape', i) ?? 0);
    const cin = getVal('convective_inhibition', i) ?? 0;
    const liftedIndex = getVal('lifted_index', i);
    const tempF = consSlot?.tempF ?? getVal('temperature_2m', i, convertTempToF, tempUnit) ?? toFiniteNumber(safeCurrent.tempF) ?? 65;
    const dewF = consSlot?.dewpointF ?? getVal('dew_point_2m', i, convertTempToF, tempUnit) ?? toFiniteNumber(safeCurrent.dewpointF) ?? 50;
    const sfcPressureHpa = getVal('surface_pressure', i, convertPressureToHpa, 'hPa')
      ?? getVal('pressure_msl', i, convertPressureToHpa, 'hPa')
      ?? toFiniteNumber(safeCurrent.pressureHpa)
      ?? 1005;

    const w10 = Math.max(0,
      (consSlot?.windMph != null ? mphToKt(consSlot.windMph) : null)
      ?? getVal('wind_speed_10m', i, convertWindToKt, windUnit)
      ?? mphToKt(toFiniteNumber(safeCurrent.windMph) ?? 0)
      ?? 0
    );
    const d10 = getVal('wind_direction_10m', i) ?? toFiniteNumber(safeCurrent.windDirDeg) ?? 0;
    const gustMph = Math.max(
      0,
      consSlot?.gustMph ?? getVal('wind_gusts_10m', i, convertWindToMph, gustUnit) ?? toFiniteNumber(safeCurrent.gustMph) ?? ktToMph(w10) ?? 0
    );

    const w850 = Math.max(0, getVal('wind_speed_850hPa', i, convertWindToKt, windUnit) ?? w10);
    const d850 = getVal('wind_direction_850hPa', i) ?? d10;

    const w500 = Math.max(0, getVal('wind_speed_500hPa', i, convertWindToKt, windUnit) ?? w850);
    const d500 = getVal('wind_direction_500hPa', i) ?? d850;

    const [u0, v0] = windComponentsKt(w10, d10);
    const [u850, v850] = windComponentsKt(w850, d850);
    const [u500, v500] = windComponentsKt(w500, d500);

    const w925Val = getVal('wind_speed_925hPa', i, convertWindToKt, windUnit);
    const d925Val = getVal('wind_direction_925hPa', i);
    const [u925, v925] = (w925Val != null && d925Val != null)
      ? windComponentsKt(Math.max(0, w925Val), d925Val)
      : [(u0 + u850) * 0.5, (v0 + v850) * 0.5];

    const w700Val = getVal('wind_speed_700hPa', i, convertWindToKt, windUnit);
    const d700Val = getVal('wind_direction_700hPa', i);
    const [u700, v700] = (w700Val != null && d700Val != null)
      ? windComponentsKt(Math.max(0, w700Val), d700Val)
      : [(u850 + u500) * 0.5, (v850 + v500) * 0.5];

    const hodographPoints = [
      { label: 'Sfc', heightKm: 0.0, uKt: u0, vKt: v0 },
      { label: '925', heightKm: 0.75, uKt: u925, vKt: v925 },
      { label: '850', heightKm: 1.5, uKt: u850, vKt: v850 },
      { label: '700', heightKm: 3.0, uKt: u700, vKt: v700 },
      { label: '500', heightKm: 5.8, uKt: u500, vKt: v500 }
    ];

    const lowShearKt = vectorShearKt(w10, d10, w850, d850);
    const shear0to3KmKt = Math.hypot(u700 - u0, v700 - v0);
    const deepShearKt = vectorShearKt(w10, d10, w500, d500);
    const rawVeer = angularDiffDeg(d10, d850);
    const veer850 = Number.isFinite(rawVeer) ? rawVeer : 0;

    // Bunkers Right-Mover Storm Motion (m/s) — guard zero/near-zero shear cleanly
    const meanU = ((u0 + u925 + u850 + u700 + u500) / 5) * KT_TO_MS;
    const meanV = ((v0 + v925 + v850 + v700 + v500) / 5) * KT_TO_MS;
    const shearU = (u500 - u0) * KT_TO_MS;
    const shearV = (v500 - v0) * KT_TO_MS;
    const rawShearMag = Math.hypot(shearU, shearV);
    const devScale = rawShearMag >= 0.1 ? 7.5 : 0;
    const shearDenom = rawShearMag >= 0.1 ? rawShearMag : 1;
    const cx = meanU + devScale * (shearV / shearDenom);
    const cy = meanV + devScale * (-shearU / shearDenom);
    const bunkersSpeedKt = Math.hypot(cx, cy) / KT_TO_MS;
    const bunkersHeadingDeg = bunkersSpeedKt > 0.01
      ? (((Math.atan2(cx, cy) * 180) / Math.PI) % 360 + 360) % 360
      : 0;

    // 1.0 km interpolated wind vector & exact Davies-Jones SRH
    const u1km = (u925 + (u850 - u925) * (0.25 / 0.75)) * KT_TO_MS;
    const v1km = (v925 + (v850 - v925) * (0.25 / 0.75)) * KT_TO_MS;
    const srh0to1 = Math.max(0, integrateSrh([
      [u0 * KT_TO_MS, v0 * KT_TO_MS],
      [u925 * KT_TO_MS, v925 * KT_TO_MS],
      [u1km, v1km]
    ], cx, cy));
    const srh0to3 = Math.max(0, integrateSrh([
      [u0 * KT_TO_MS, v0 * KT_TO_MS],
      [u925 * KT_TO_MS, v925 * KT_TO_MS],
      [u850 * KT_TO_MS, v850 * KT_TO_MS],
      [u700 * KT_TO_MS, v700 * KT_TO_MS]
    ], cx, cy));

    // Espy LCL height (m), surface mixing ratio (g/kg), & 700-500 hPa lapse rate (°C/km)
    const tempC = fToC(tempF) ?? 18.3;
    const dewC = fToC(dewF) ?? 10.0;
    const dewDepC = Math.max(0, tempC - dewC);
    const lclMeters = Math.max(50, Math.min(5000, Math.round(125 * dewDepC)));
    const mixingRatioGkg = computeMixingRatioGkg(dewC, sfcPressureHpa);

    const t700F = getVal('temperature_700hPa', i, convertTempToF, upperTempUnit);
    const t500F = getVal('temperature_500hPa', i, convertTempToF, upperTempUnit);
    const h700 = getVal('geopotential_height_700hPa', i);
    const h500 = getVal('geopotential_height_500hPa', i);
    const t500C = t500F != null ? fToC(t500F) : null;
    let lapseRate700to500 = 5.8;
    if (t700F != null && t500C != null && h700 != null && h500 != null && (h500 - h700) > 500) {
      const t700C = fToC(t700F);
      const lr = (t700C - t500C) / ((h500 - h700) / 1000);
      if (Number.isFinite(lr)) {
        lapseRate700to500 = Math.round(Math.max(-5, Math.min(15, lr)) * 10) / 10;
      }
    }

    // Official SPC Fixed-Layer STP, SCP, SHIP & Energy-Helicity Index (EHI)
    const bulkShearMs = deepShearKt * KT_TO_MS;
    const lclTerm = lclMeters > 2000 ? 0 : lclMeters < 1000 ? 1 : (2000 - lclMeters) / 1000;
    const stpShearTerm = bulkShearMs < 12.5 ? 0 : bulkShearMs > 30 ? 1.5 : bulkShearMs / 20;
    const scpShearTerm = bulkShearMs < 10 ? 0 : Math.min(1.0, bulkShearMs / 20);
    const cinAbs = Math.abs(cin);
    const cinTerm = cinAbs >= 200 ? 0 : cinAbs <= 50 ? 1 : (200 - cinAbs) / 150;
    const stp = Math.round(Math.min(12, Math.max(0, (cape / 1500) * lclTerm * (srh0to1 / 150) * stpShearTerm * cinTerm)) * 10) / 10;
    const scp = Math.round(Math.min(25, Math.max(0, (cape / 1000) * (srh0to3 / 50) * scpShearTerm)) * 10) / 10;
    const ehi0to1Km = Math.round(Math.min(10.0, Math.max(0, (cape * srh0to1) / 160000)) * 10) / 10;
    const ehi0to3Km = Math.round(Math.min(15.0, Math.max(0, (cape * srh0to3) / 160000)) * 10) / 10;
    const ship = computeSpcShip({
      cape,
      mixingRatioGkg,
      lapseRate700to500,
      temp500C: t500C ?? -10,
      bulkShear0to6Ms: bulkShearMs
    });

    // Evaporative / Downburst Wind Index (DCAPE proxy in J/kg)
    const dcapeProxy = cape >= 200
      ? Math.round(Math.max(0, Math.min(1800, dewDepC * 45 + Math.max(0, lapseRate700to500 - 5.5) * 220 + Math.min(500, cape * 0.25))))
      : 0;

    const slotMs = parseUtcTimestampMs(hourly.time?.[i], offsetOpts) ?? (nowMs + Math.max(0, relHr) * 3600000);
    const compositeRank = stp * 3.0 + scp * 0.65 + ship * 1.6 + ehi0to1Km * 1.2 + (cape >= 200 ? (shear0to3KmKt >= 35 ? 1.2 : 0) : 0);

    return {
      slotMs,
      cape, cin, liftedIndex, dewF, lowShearKt, shear0to3KmKt, deepShearKt, veer850, gustMph,
      srh0to1, srh0to3, lclMeters, lapseRate700to500, temp500C: t500C, mixingRatioGkg,
      stp, scp, ship, ehi0to1Km, ehi0to3Km, dcapeProxy, compositeRank,
      thunderProbPct: consSlot?.thunderProbPct ?? 0,
      bunkersHeadingDeg, bunkersSpeedKt, hodographPoints
    };
  };

  const nowSample = calcAt(idx, 0);
  const window12 = [];
  const totalSlots = Array.isArray(hourly.time) ? hourly.time.length : 0;
  for (let i = idx; i < Math.min(idx + 12, totalSlots); i++) {
    window12.push(calcAt(i, i - idx));
  }
  const samples = window12.length ? window12 : [nowSample];

  const peakCape12h = Math.max(...samples.map((s) => s.cape));
  const peakLowLevelShearKt = Math.round(Math.max(...samples.map((s) => s.lowShearKt)));
  const peakShear0to3KmKt = Math.round(Math.max(...samples.map((s) => s.shear0to3KmKt)));
  const peakBulkShearKt = Math.round(Math.max(...samples.map((s) => s.deepShearKt)));
  const peakStp12h = Number(Math.max(...samples.map((s) => s.stp)).toFixed(1));
  const peakScp12h = Number(Math.max(...samples.map((s) => s.scp)).toFixed(1));
  const peakShip12h = Number(Math.max(...samples.map((s) => s.ship)).toFixed(1));
  const peakEhi0to1_12h = Number(Math.max(...samples.map((s) => s.ehi0to1Km)).toFixed(1));
  const peakEhi0to3_12h = Number(Math.max(...samples.map((s) => s.ehi0to3Km)).toFixed(1));
  const peakSrh0to1_12h = Math.round(Math.max(...samples.map((s) => s.srh0to1)));
  const peakSrh0to3_12h = Math.round(Math.max(...samples.map((s) => s.srh0to3)));
  const peakDcape12h = Math.round(Math.max(...samples.map((s) => s.dcapeProxy)));
  const peakWindGust12hMph = Math.round(Math.max(...samples.map((s) => s.gustMph)));
  const peakLapse12h = Number(Math.max(...samples.map((s) => s.lapseRate700to500)).toFixed(1));
  const peakDew12h = Math.round(Math.max(...samples.map((s) => s.dewF)));
  const nwsThunderProb12h = Math.round(Math.max(...samples.map((s) => s.thunderProbPct || 0), 0));

  let peakSlot = samples[0];
  for (const s of samples) {
    if (s.compositeRank > peakSlot.compositeRank) peakSlot = s;
  }
  const peakThreatTimeLabel = (peakSlot.compositeRank >= 0.8 || peakCape12h >= 250)
    ? formatWinterClock(peakSlot.slotMs, true, timeZone)
    : 'Quiet next 12h';

  const lowLevelShearKt = Math.round(nowSample.lowShearKt);
  const shear0to3KmKt = Math.round(nowSample.shear0to3KmKt);
  const bulkShear0to6KmKt = Math.round(nowSample.deepShearKt);
  const veeringDeg = Math.round(nowSample.veer850);
  const cinNow = Math.round(nowSample.cin);

  const dewF = toFiniteNumber(safeCurrent.dewpointF) ?? Math.round(nowSample.dewF) ?? 45;
  const effDewF = Math.max(dewF, peakDew12h);
  const pTrend = toFiniteNumber(safeCurrent.pressureTrend3h) ?? 0;
  // Strictly local convective MDs only (Spec §1 #2 & §6.1 #2)
  const localConvMcd = multiDaySpc && Number.isFinite(Number(multiDaySpc.localConvectiveMcdCount))
    ? Math.max(0, Math.floor(Number(multiDaySpc.localConvectiveMcdCount)))
    : Math.max(0, Math.floor(toFiniteNumber(mcdCount) ?? 0));
  const activeMcdCount = localConvMcd;

  // Official SPC Day 1 Outlook, 2026 CIG & Active Local Watch Integration
  const spcDay1Cat = String(multiDaySpc?.day1Category || 'NONE').toUpperCase();
  const spcRank = spcCategoryRank(spcDay1Cat);
  const spcTor = parseSpcProbPct(multiDaySpc?.day1TornadoProb);
  const spcHail = parseSpcProbPct(multiDaySpc?.day1HailProb);
  const spcWind = parseSpcProbPct(multiDaySpc?.day1WindProb);
  if (multiDaySpc?.day1TornadoCig && multiDaySpc.day1TornadoCig !== 'NONE') {
    const c = parseSpcProbPct(multiDaySpc.day1TornadoCig);
    if (c.cigRank > spcTor.cigRank) { spcTor.cig = c.cig; spcTor.cigRank = c.cigRank; spcTor.sig = true; }
  }
  if (multiDaySpc?.day1HailCig && multiDaySpc.day1HailCig !== 'NONE') {
    const c = parseSpcProbPct(multiDaySpc.day1HailCig);
    if (c.cigRank > spcHail.cigRank) { spcHail.cig = c.cig; spcHail.cigRank = c.cigRank; spcHail.sig = true; }
  }
  if (multiDaySpc?.day1WindCig && multiDaySpc.day1WindCig !== 'NONE') {
    const c = parseSpcProbPct(multiDaySpc.day1WindCig);
    if (c.cigRank > spcWind.cigRank) { spcWind.cig = c.cig; spcWind.cigRank = c.cigRank; spcWind.sig = true; }
  }

  const activeWatches = Array.isArray(multiDaySpc?.localWatches)
    ? multiDaySpc.localWatches
    : (Array.isArray(multiDaySpc?.activeWatches) ? multiDaySpc.activeWatches : []);
  const hasTorWatch = activeWatches.some((w) => String(w?.type || '').includes('TOR'));
  const hasPdsTorWatch = activeWatches.some((w) => String(w?.type || '').includes('TOR') && w?.isPds);
  const hasSvrWatch = activeWatches.some((w) => String(w?.type || '').includes('SVR') || String(w?.type || '').includes('SEV'));

  const hasInstability = peakCape12h >= 100 || activeMcdCount > 0 || spcRank >= 2 || hasTorWatch || hasSvrWatch || nwsThunderProb12h >= 35;

  let score = 0;
  // Instability (CAPE)
  if (peakCape12h >= 1800) score += 3;
  else if (peakCape12h >= 750) score += 2;
  else if (peakCape12h >= 200) score += 1;

  // Deep-layer supercell shear (0-6 km: 10m -> 500 hPa) — gated on instability
  if (hasInstability) {
    if (peakBulkShearKt >= 45) score += 3;
    else if (peakBulkShearKt >= 35) score += 2;
    else if (peakBulkShearKt >= 25) score += 1;

    // Low-level tornado shear & veering (0-1.5 km: 10m -> 850 hPa)
    if (peakLowLevelShearKt >= 30 && (veeringDeg >= 20 || peakSrh0to1_12h >= 200)) score += 3;
    else if (peakLowLevelShearKt >= 22 && (veeringDeg >= 10 || peakSrh0to1_12h >= 120)) score += 2;
    else if (peakLowLevelShearKt >= 16) score += 1;
  }

  // Low-level moisture (Dewpoint)
  if (effDewF >= 64) score += 2;
  else if (effDewF >= 58) score += 1;

  // Synoptic forcing (3-hr MSLP fall) — gated on instability for convective scoring
  if (hasInstability) {
    if (pTrend <= -3.0) score += 2;
    else if (pTrend <= -1.5) score += 1;
  }

  if (activeMcdCount > 0) score += 2;
  // Official SPC composite & outlook boosts
  if (peakStp12h >= 3.0 || peakShip12h >= 1.5 || peakEhi0to1_12h >= 3.0) score += 2;
  else if (peakStp12h >= 1.0 || peakScp12h >= 4.0 || peakShip12h >= 1.0 || peakEhi0to1_12h >= 1.5) score += 1;
  if (spcRank >= 5 || hasTorWatch) score += 3;
  else if (spcRank >= 4 || hasSvrWatch) score += 2;
  else if (spcRank >= 3) score += 1;

  if (Math.abs(cinNow) >= 200 && activeMcdCount === 0 && !hasTorWatch && !hasSvrWatch && peakStp12h < 1.0) {
    score = Math.round(score * 0.6);
  }

  if (!hasInstability) {
    score = Math.min(score, 2);
  }

  // High-Shear, Low-CAPE (Dixie Alley classic) signature
  const isHslc = hasInstability && peakCape12h >= 100 && peakCape12h <= 750 &&
    peakLowLevelShearKt >= 25 && peakBulkShearKt >= 35 && effDewF >= 58;

  // Strong moisture + shear + CAPE supercell setup
  const isSupercellSetup = hasInstability && (
    (peakCape12h >= 500 && peakBulkShearKt >= 35 && peakLowLevelShearKt >= 20 && effDewF >= 58) ||
    peakScp12h >= 3.0 ||
    peakStp12h >= 1.0
  );

  // Storm-Scale Convective Mode Classifier (Spec §6.3)
  const { mode: convectiveMode, label: convectiveModeLabel } = classifyConvectiveMode({
    hasConvectiveInstability: hasInstability,
    peakCape12h,
    peakStp12h,
    peakScp12h,
    peakShip12h,
    peakBulkShearKt,
    peakShear0to3KmKt,
    peakLowLevelShearKt,
    peakSrh0to1_12h,
    peakDcape12h,
    effDewF,
    spcTorPct: spcTor.pct
  });

  // Individual 3-Hazard Severe Risk Classification with 2026 CIG & EHI Escalation (Spec §6.4)
  let torRank = 0;
  let torDetail = 'Stable / low helicity';
  if (hasPdsTorWatch || peakStp12h >= 4.0 || peakEhi0to1_12h >= 3.0 || (spcTor.pct >= 15 && spcTor.cigRank >= 1) || spcTor.cigRank >= 2) {
    torRank = 4;
    torDetail = hasPdsTorWatch ? 'PDS Tornado Watch Active' : `Peak STP ${peakStp12h} · EHI ${peakEhi0to1_12h} · SRH ${peakSrh0to1_12h}`;
  } else if (hasTorWatch || peakStp12h >= 1.5 || spcTor.pct >= 10 || spcTor.cigRank >= 1 || (isHslc && peakSrh0to1_12h >= 250)) {
    torRank = 3;
    torDetail = hasTorWatch ? 'Tornado Watch Active' : `Peak STP ${peakStp12h} · SRH ${peakSrh0to1_12h} m²/s²`;
  } else if (peakStp12h >= 0.5 || isHslc || spcTor.pct >= 5 || (hasInstability && peakSrh0to1_12h >= 150 && peakBulkShearKt >= 35)) {
    torRank = 2;
    torDetail = isHslc ? `HSLC QLCS/spin-up (${peakSrh0to1_12h} SRH)` : `STP ${peakStp12h} · LCL ${nowSample.lclMeters}m`;
  } else if (spcTor.pct >= 2 || (hasInstability && peakSrh0to1_12h >= 100 && peakCape12h >= 250)) {
    torRank = 1;
    torDetail = spcTor.pct >= 2 ? `SPC ${multiDaySpc.day1TornadoProb} Tornado` : `Isolated rotation (${peakSrh0to1_12h} SRH)`;
  }

  let hailRank = 0;
  let hailDetail = 'Insufficient CAPE / mid-level lapse';
  if (peakShip12h >= 2.0 || (spcHail.pct >= 30 && spcHail.cigRank >= 1) || spcHail.cigRank >= 2) {
    hailRank = 4;
    hailDetail = `Giant Hail 2.5"+ risk (SHIP ${peakShip12h})`;
  } else if (peakShip12h >= 1.0 || spcHail.pct >= 15 || spcHail.cigRank >= 1) {
    hailRank = 3;
    hailDetail = `Sig Hail 2"+ risk (SHIP ${peakShip12h} · LR ${peakLapse12h}°/km)`;
  } else if (peakShip12h >= 0.5 || spcHail.pct >= 5 || (peakCape12h >= 1200 && peakLapse12h >= 6.8 && peakBulkShearKt >= 30)) {
    hailRank = 2;
    hailDetail = `Severe Hail 1"+ (SHIP ${peakShip12h} · CAPE ${Math.round(peakCape12h)})`;
  } else if (peakCape12h >= 400 && peakLapse12h >= 6.2) {
    hailRank = 1;
    hailDetail = `Small/sub-severe hail (CAPE ${Math.round(peakCape12h)})`;
  }

  let windRank = 0;
  let windDetail = 'No damaging convective wind risk';
  const hasConvectiveWindPotential = hasInstability && (peakCape12h >= 200 || hasSvrWatch || hasTorWatch || spcWind.pct >= 5);
  if ((spcWind.pct >= 30 && spcWind.cigRank >= 1) || spcWind.cigRank >= 2 || peakWindGust12hMph >= 75 || (hasConvectiveWindPotential && peakShear0to3KmKt >= 45 && peakDcape12h >= 1000)) {
    windRank = 4;
    windDetail = `Destructive 75+ mph / Derecho (0–3km ${peakShear0to3KmKt} kt)`;
  } else if (hasSvrWatch || spcWind.pct >= 15 || spcWind.cigRank >= 1 || peakWindGust12hMph >= 58 || (hasConvectiveWindPotential && peakShear0to3KmKt >= 35 && (peakDcape12h >= 800 || peakCape12h >= 1000))) {
    windRank = 3;
    windDetail = `Damaging 60+ mph QLCS/Bow (0–3km ${peakShear0to3KmKt} kt · DCAPE ~${peakDcape12h})`;
  } else if (spcWind.pct >= 5 || (hasConvectiveWindPotential && (peakShear0to3KmKt >= 30 || peakDcape12h >= 700 || peakWindGust12hMph >= 45))) {
    windRank = 2;
    windDetail = `Gusty 50–60 mph (0–3km ${peakShear0to3KmKt} kt · Gust ${peakWindGust12hMph} mph)`;
  } else if (hasConvectiveWindPotential && (peakBulkShearKt >= 25 || peakWindGust12hMph >= 35)) {
    windRank = 1;
    windDetail = `Isolated strong gusts (~${peakWindGust12hMph} mph)`;
  }

  const hazards = {
    tornado: hazardTierMeta(torRank, torDetail),
    hail: hazardTierMeta(hailRank, hailDetail),
    wind: hazardTierMeta(windRank, windDetail)
  };
  const maxHazardRank = Math.max(torRank, hailRank, windRank);

  let regime = 'Quiet / Stable';
  let level = 'low';

  if (hasInstability) {
    if (hasPdsTorWatch || spcRank >= 5 || score >= 11 || peakStp12h >= 3.0) {
      regime = 'High-End Severe / Outbreak';
      level = 'high';
    } else if (hasTorWatch || hasSvrWatch || spcRank >= 4 || score >= 9 || (isSupercellSetup && score >= 8) || maxHazardRank >= 3) {
      regime = isHslc ? 'HSLC Rotating Threat' : 'Supercell Favorable';
      level = 'high';
    } else if (spcRank >= 3 || score >= 6 || isHslc || maxHazardRank >= 2) {
      regime = isHslc ? 'HSLC Watchful (Shear-Driven)' : 'Elevated Convective';
      level = 'mod';
    } else if (spcRank >= 2 || (score >= 4 && peakCape12h >= 150)) {
      regime = 'Marginal Convective';
      level = 'mod';
    }
  }

  const hourLocal = getCentralHour24(nowMs, timeZone) ?? new Date(nowMs).getUTCHours();
  const isEveningOrNight = hourLocal >= 17 || hourLocal <= 6;
  const nocturnalEscalated = hasInstability && nocturnalEnabled && isEveningOrNight && (level === 'high' || (level === 'mod' && (isHslc || peakLowLevelShearKt >= 25 || torRank >= 2)));

  const spcTag = spcRank >= 2 ? `SPC Day 1 ${spcDay1Cat}` : null;
  const watchTag = hasPdsTorWatch ? 'PDS TORNADO WATCH' : hasTorWatch ? 'TORNADO WATCH' : hasSvrWatch ? 'SEVERE T-STORM WATCH' : null;
  const prefixTag = [watchTag, spcTag].filter(Boolean).join(' · ');

  const nocturnalRisk = nocturnalEscalated
    ? `${prefixTag ? `${prefixTag}: ` : ''}NOCTURNAL READINESS — Elevated overnight shear/convective setup (Peak ${peakThreatTimeLabel}); keep Borden Tempest open & screen awake.`
    : level === 'high'
      ? `${prefixTag ? `${prefixTag}: ` : ''}High convective & rotating storm potential (Peak ${peakThreatTimeLabel}) — monitor radar closely.`
      : level === 'mod'
        ? `${prefixTag ? `${prefixTag}: ` : ''}Marginal/elevated shear or instability developing (Peak ${peakThreatTimeLabel}) — stay weather aware.`
        : peakBulkShearKt >= 35
          ? `Strong shear aloft (${bulkShear0to6KmKt} kt), but air mass is stable (CAPE ${Math.round(peakCape12h)}) — non-convective.`
          : 'No nocturnal severe-weather readiness escalation needed.';

  // Model Init (UTC + Local) & Forecast Valid Hour Timing Banner (Spec §2.4 & §9.1)
  const hasHrrrData = hasAnyEnsembleModelSuffix(hourly) && (
    toFiniteNumber(hourly.cape_ncep_hrrr_conus?.[idx]) != null ||
    toFiniteNumber(hourly.wind_speed_500hPa_ncep_hrrr_conus?.[idx]) != null ||
    toFiniteNumber(hourly.temperature_2m_ncep_hrrr_conus?.[idx]) != null
  );
  const stormScaleModelName = hasHrrrData
    ? 'HRRR 3km'
    : (hasAnyEnsembleModelSuffix(hourly) ? 'GFS/ECMWF' : 'HRRR/GFS');

  const metaInitMs = parseUtcTimestampMs(options.modelMeta?.initTimeMs ?? options.modelMeta?.last_run_initialisation_time);
  const firstHourlyMs = parseUtcTimestampMs(hourly.time?.[0], offsetOpts);
  const fallbackInitMs = firstHourlyMs != null
    ? firstHourlyMs
    : Math.floor(nowMs / 3600000) * 3600000;
  const modelInitUtcMs = metaInitMs ?? fallbackInitMs;
  const forecastValidUtcMs = peakSlot?.slotMs ?? nowSample?.slotMs ?? nowMs;
  const leadHours = Math.max(0, Math.round((forecastValidUtcMs - modelInitUtcMs) / 3600000));
  const forecastLeadHour = `F${String(leadHours).padStart(2, '0')}`;
  const modelInitUtcLabel = formatUtcClock(modelInitUtcMs);
  const modelInitLocalLabel = formatLocalTime(modelInitUtcMs, timeZone);
  const forecastValidUtcLabel = formatUtcClock(forecastValidUtcMs);
  const forecastValidLocalLabel = formatLocalTime(forecastValidUtcMs, timeZone);
  const modelTimingBanner = `${stormScaleModelName} Init: ${modelInitUtcLabel} (${modelInitLocalLabel}) · Valid: ${forecastValidUtcLabel} (${forecastValidLocalLabel}) [${forecastLeadHour}]`;

  // Honest NSSL Cb-WoFS Operational Window & Standby State (Spec §2.4: 17:00–03:00 UTC select severe days)
  const utcHourNow = new Date(nowMs).getUTCHours();
  const wofsActiveWindow = utcHourNow >= 17 || utcHourNow < 3;
  const isSevereDayForWofs = (
    spcRank >= 2 ||
    activeMcdCount > 0 ||
    activeWatches.length > 0 ||
    peakStp12h >= 0.8 ||
    hasLocalSevereCell
  );
  const wofsGuidanceMode = (wofsActiveWindow && isSevereDayForWofs) ? 'ACTIVE_WINDOW' : 'STANDBY';
  const wofsStandbyReason = wofsGuidanceMode === 'ACTIVE_WINDOW'
    ? 'Severe day inside NSSL 17:00–03:00 UTC WoFS operational window. Open the NSSL Cb-WoFS Viewer or inspect 24/7 operational HRRR 3 km guidance below.'
    : isSevereDayForWofs
      ? 'WoFS Standby — Outside typical 17:00–03:00 UTC experimental run window. Active 24/7 storm-scale guidance: Operational HRRR 3 km + NBM + SPC.'
      : 'WoFS Standby — Experimental NSSL runs operate select severe days 17:00–03:00 UTC. Active 24/7 storm-scale guidance: Operational HRRR 3 km + NBM + SPC.';

  // Respect user's convective alert threshold sensitivity
  const shouldTriggerProactive =
    (thresholdMode === 'HIGH_ONLY' && level === 'high') ||
    (thresholdMode === 'STANDARD' && (level === 'high' || isHslc || nocturnalEscalated)) ||
    (thresholdMode === 'SENSITIVE' && (level === 'high' || level === 'mod'));

  const proactiveAlerts = [];
  if (shouldTriggerProactive) {
    proactiveAlerts.push({
      id: `convective_${level}_${isHslc ? 'hslc' : 'std'}_${nocturnalEscalated ? 'night' : 'day'}`,
      title: nocturnalEscalated ? `Nocturnal ${regime}` : `${regime} Environment`,
      summary: `Mode: ${convectiveModeLabel} • Peak ${peakThreatTimeLabel} • STP ${peakStp12h} • EHI ${peakEhi0to1_12h} • SCP ${peakScp12h} • SHIP ${peakShip12h} • CAPE ${Math.round(peakCape12h)} J/kg • Tor: ${hazards.tornado.label} / Hail: ${hazards.hail.label} / Wind: ${hazards.wind.label}`,
      level
    });
  }

  return {
    regime,
    level,
    score,
    spcCategory: spcDay1Cat,
    convectiveMode,
    convectiveModeLabel,
    localConvectiveMcdCount: activeMcdCount,
    capeNow: Math.round(nowSample.cape),
    peakCape12h: Math.round(peakCape12h),
    cinNow,
    liftedIndexNow: nowSample.liftedIndex != null ? Number(nowSample.liftedIndex.toFixed(1)) : null,
    nwsThunderProb12h,
    lowLevelShearKt,
    peakLowLevelShearKt,
    shear0to3KmKt,
    peakShear0to3KmKt,
    bulkShear0to6KmKt,
    peakBulkShearKt,
    veeringDeg,
    srh0to1Km: Math.round(nowSample.srh0to1),
    peakSrh0to1_12h,
    srh0to3Km: Math.round(nowSample.srh0to3),
    peakSrh0to3_12h,
    stp: nowSample.stp,
    peakStp12h,
    scp: nowSample.scp,
    peakScp12h,
    ship: nowSample.ship,
    peakShip12h,
    ehi0to1Km: nowSample.ehi0to1Km,
    peakEhi0to1_12h,
    ehi0to3Km: nowSample.ehi0to3Km,
    peakEhi0to3_12h,
    dcapeProxy: nowSample.dcapeProxy,
    peakDcape12h,
    peakWindGust12hMph,
    peakThreatTimeLabel,
    hazards,
    lclMeters: nowSample.lclMeters,
    lapseRate700to500: nowSample.lapseRate700to500,
    bunkersHeadingDeg: nowSample.bunkersHeadingDeg,
    bunkersSpeedKt: Math.round(nowSample.bunkersSpeedKt),
    bunkersCompass: degToCompass(nowSample.bunkersHeadingDeg),
    hodographPoints: nowSample.hodographPoints,
    dewpointF: dewF,
    pressureTrend3h: pTrend,
    isHslc,
    nocturnalEscalated,
    nocturnalRisk,
    wofsGuidanceMode,
    wofsStandbyReason,
    wofsViewerUrl: WOFS_VIEWER_URL,
    wofsAttribution: WOFS_ATTRIBUTION,
    wofsFrameBlockedHint: true,
    stormScaleModelName,
    modelInitUtcMs,
    modelInitUtcLabel,
    modelInitLocalLabel,
    forecastValidUtcMs,
    forecastValidUtcLabel,
    forecastValidLocalLabel,
    forecastLeadHour,
    modelTimingBanner,
    wofsProxyLabel: `${stormScaleModelName} + SPC + NEXRAD Storm-Scale`,
    proactiveAlerts
  };
}

/**
 * Evaluates Day 1-3 SPC Categorical/Prob/2026 CIG, WPC Flash Flood ERO/MPDs,
 * and strictly local point-in-polygon SPC Watch Boxes & Mesoscale Discussions (Spec §6.1).
 */
export function evaluateMultiDayOutlooks(userLat, userLon, intel, spcPointOutlooks = null, nowMs = Date.now()) {
  const catRank = { NONE: 0, TSTM: 1, MRGL: 2, SLGT: 3, ENH: 4, MDT: 5, HIGH: 6 };
  const readPropCI = (props, ...keys) => {
    if (!props || typeof props !== 'object') return '';
    for (const k of keys) {
      if (props[k] != null && props[k] !== '') return props[k];
    }
    const low = {};
    for (const [k, v] of Object.entries(props)) low[k.toLowerCase()] = v;
    for (const k of keys) {
      const v = low[k.toLowerCase()];
      if (v != null && v !== '') return v;
    }
    return '';
  };

  const findHighestCat = (fc, propKey = 'LABEL') => {
    let best = 'NONE';
    for (const f of fc?.features || []) {
      if (!f.geometry || !isPointInGeometry(userLat, userLon, f.geometry)) continue;
      const raw = String(readPropCI(f.properties, propKey, 'label', 'outlook', 'label2')).trim().toUpperCase();
      const norm = raw.includes('HIGH') ? 'HIGH'
        : raw.includes('MDT') || raw.includes('MODERATE') ? 'MDT'
        : raw.includes('ENH') ? 'ENH'
        : raw.includes('SLGT') || raw.includes('SLIGHT') ? 'SLGT'
        : raw.includes('MRGL') || raw.includes('MARGINAL') ? 'MRGL'
        : raw.includes('TSTM') ? 'TSTM' : 'NONE';
      if ((catRank[norm] || 0) > (catRank[best] || 0)) best = norm;
    }
    return best;
  };

  const findHighestProb = (fc) => {
    let bestPct = 0;
    let bestCig = 'NONE';
    const cigRank = (c) => (c === 'CIG3' ? 3 : c === 'CIG2' ? 2 : (c === 'CIG1' || c === 'SIGN') ? 1 : 0);
    for (const f of fc?.features || []) {
      if (!f.geometry || !isPointInGeometry(userLat, userLon, f.geometry)) continue;
      const lbl = String(readPropCI(f.properties, 'label', 'label2', 'dn')).trim().toUpperCase();
      if (lbl === 'SIGN' || lbl === 'CIG1' || lbl === 'CIG2' || lbl === 'CIG3') {
        if (cigRank(lbl) > cigRank(bestCig)) bestCig = lbl;
        continue;
      }
      const n = parseFloat(lbl.replace('%', ''));
      if (!Number.isNaN(n) && n > 0) {
        const pct = n <= 1 ? Math.round(n * 100) : Math.round(n);
        if (pct > bestPct) bestPct = pct;
      }
    }
    if (bestPct === 0) return { label: 'NONE', cig: bestCig };
    return { label: bestCig !== 'NONE' ? `${bestPct}% ${bestCig}` : `${bestPct}%`, cig: bestCig };
  };

  const mergeCat = (a, b) => ((catRank[a] || 0) >= (catRank[b] || 0) ? (a || 'NONE') : (b || 'NONE'));
  const mergeProb = (pipStr, pipCig, geoObj) => {
    const pPip = parseSpcProbPct(pipStr);
    const pGeo = parseSpcProbPct(geoObj?.label);
    const pct = Math.max(pPip.pct, pGeo.pct);
    const c1 = pipCig && pipCig !== 'NONE' ? pipCig : pPip.cig;
    const c2 = geoObj?.cig && geoObj.cig !== 'NONE' ? geoObj.cig : pGeo.cig;
    const rank = (c) => (c === 'CIG3' ? 3 : c === 'CIG2' ? 2 : (c === 'CIG1' || c === 'SIGN') ? 1 : 0);
    const bestCig = rank(c1) >= rank(c2) ? c1 : c2;
    return {
      prob: pct > 0 ? (bestCig && bestCig !== 'NONE' ? `${pct}% ${bestCig}` : `${pct}%`) : 'NONE',
      cig: bestCig || 'NONE'
    };
  };

  const refMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const localWatches = (intel?.spcWatchesGeoJson?.features || []).filter((f) => {
    if (!f?.geometry || !isPointInGeometry(userLat, userLon, f.geometry)) return false;
    const expMs = parseUtcTimestampMs(f.properties?.expire ?? f.properties?.utc_expire ?? f.properties?.expired);
    return expMs == null || expMs > refMs;
  }).map((f) => {
    const p = f.properties || {};
    return {
      number: String(p.num || p.SEL || p.watch_num || ''),
      type: String(p.type || '').toUpperCase(),
      isPds: Boolean(p.is_pds || String(p.pds || '').toUpperCase() === 'Y'),
      expireMs: parseUtcTimestampMs(p.expire ?? p.utc_expire ?? p.expired)
    };
  });

  const mcdInfo = filterMcdsForLocation(intel?.mcdGeoJson, userLat, userLon, refMs);
  const localMpds = filterMpdsForLocation(intel?.wpcMpdGeoJson, userLat, userLon, refMs);

  const pip = spcPointOutlooks || {};
  const d1Tor = mergeProb(pip.day1TornadoProb, pip.day1TornadoCig, findHighestProb(intel?.spcDay1TorGeoJson));
  const d1Hail = mergeProb(pip.day1HailProb, pip.day1HailCig, findHighestProb(intel?.spcDay1HailGeoJson));
  const d1Wind = mergeProb(pip.day1WindProb, pip.day1WindCig, findHighestProb(intel?.spcDay1WindGeoJson));

  return {
    day1Category: mergeCat(pip.day1Category, findHighestCat(intel?.spcDay1GeoJson, 'LABEL')),
    day1TornadoProb: d1Tor.prob,
    day1TornadoCig: d1Tor.cig,
    day1HailProb: d1Hail.prob,
    day1HailCig: d1Hail.cig,
    day1WindProb: d1Wind.prob,
    day1WindCig: d1Wind.cig,
    day2Category: mergeCat(pip.day2Category, findHighestCat(intel?.spcDay2GeoJson, 'LABEL')),
    day2TornadoProb: pip.day2TornadoProb || 'NONE',
    day2TornadoCig: pip.day2TornadoCig || 'NONE',
    day2HailProb: pip.day2HailProb || 'NONE',
    day2HailCig: pip.day2HailCig || 'NONE',
    day2WindProb: pip.day2WindProb || 'NONE',
    day2WindCig: pip.day2WindCig || 'NONE',
    day3Category: mergeCat(pip.day3Category, findHighestCat(intel?.spcDay3GeoJson, 'LABEL')),
    day3Prob: pip.day3Prob || 'NONE',
    day3Cig: pip.day3Cig || 'NONE',
    wpcDay1FloodRisk: findHighestCat(intel?.wpcFloodGeoJson, 'OUTLOOK'),
    localWatches,
    activeWatches: localWatches,
    localMcds: mcdInfo.localMcds,
    localConvectiveMcds: mcdInfo.localConvectiveMcds,
    localConvectiveMcdCount: mcdInfo.localConvectiveMcdCount,
    nearbyMcds: mcdInfo.nearbyMcds,
    localMpds
  };
}

function deriveRhFromTempDewF(tempF, dewF) {
  const tc = fToC(tempF);
  const tdc = fToC(dewF);
  if (tc == null || tdc == null) return 75;
  const es = Math.exp((17.625 * tc) / (243.04 + tc));
  const e = Math.exp((17.625 * tdc) / (243.04 + tdc));
  return Math.max(5, Math.min(100, (e / Math.max(1e-6, es)) * 100));
}

export function computeWetBulbF(tempF, rhPct = 75) {
  const tf = toFiniteNumber(tempF);
  if (tf === null) return 32;
  const rh = Math.max(5, Math.min(100, toFiniteNumber(rhPct) ?? 75));
  const tC = ((tf - 32) * 5) / 9;
  const twC =
    tC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(tC + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035;
  return (twC * 9) / 5 + 32;
}

export function dynamicSlrForTempF(tempF) {
  const tf = toFiniteNumber(tempF) ?? 30;
  if (tf >= 31) return 8;
  if (tf >= 26) return 10;
  if (tf >= 18) return 13;
  return 16;
}

/**
 * Official NWS / Kuchera (2004) Dynamic Snow-to-Liquid Ratio (SLR) from lower-tropospheric Tmax.
 * Above 28°F: SLR = 12 + 2*(28 - TmaxF) (wet heavy slush drops to 4:1 near 32–34°F).
 * At/below 28°F: SLR = 12 + (28 - TmaxF) (dry powdery snow up to 20:1 in arctic air).
 */
export function kucheraSlrForProfile(airTempF, temp925F = null, temp850F = null, temp700F = null) {
  const vals = [airTempF, temp925F, temp850F, temp700F]
    .map((v) => toFiniteNumber(v))
    .filter((v) => v != null);
  const tMaxF = vals.length ? Math.max(...vals) : (toFiniteNumber(airTempF) ?? 30);
  const raw = tMaxF > 28.0 ? 12.0 + 2.0 * (28.0 - tMaxF) : 12.0 + (28.0 - tMaxF);
  return Math.max(4, Math.min(20, Math.round(raw)));
}

const PTYPE_META = {
  CLEAR: { code: 'CLEAR', label: 'Clear / Dry', shortLabel: 'Clear', color: '#475569', wintry: false },
  RAIN: { code: 'RAIN', label: 'Rain', shortLabel: 'Rain', color: '#60A5FA', wintry: false },
  COLD_RAIN: { code: 'COLD_RAIN', label: 'Cold Rain', shortLabel: 'Rain', color: '#38BDF8', wintry: false },
  DRY_FREEZE: { code: 'DRY_FREEZE', label: 'Dry Freeze', shortLabel: 'Freeze', color: '#64748B', wintry: false },
  REFREEZE: { code: 'REFREEZE', label: 'Black Ice Refreeze', shortLabel: 'Refreeze', color: '#818CF8', wintry: false },
  WET_SNOW_MELTING: { code: 'WET_SNOW_MELTING', label: 'Wet Snow (Melts)', shortLabel: 'Wet Snow', color: '#67E8F9', wintry: true },
  WINTRY_MIX: { code: 'WINTRY_MIX', label: 'Wintry Mix', shortLabel: 'Mix', color: '#22D3EE', wintry: true },
  ACCUMULATING_SNOW: { code: 'ACCUMULATING_SNOW', label: 'Accumulating Snow', shortLabel: 'Snow', color: '#E0F2FE', wintry: true },
  SNOW: { code: 'ACCUMULATING_SNOW', label: 'Accumulating Snow', shortLabel: 'Snow', color: '#E0F2FE', wintry: true },
  SLEET: { code: 'SLEET', label: 'Sleet (Ice Pellets)', shortLabel: 'Sleet', color: '#A78BFA', wintry: true },
  FREEZING_RAIN: { code: 'FREEZING_RAIN', label: 'Freezing Rain (Glaze)', shortLabel: 'Fz Rain', color: '#F472B6', wintry: true }
};

/**
 * Bourgouin (2000) piecewise-linear Positive/Negative Energy Area proxy (Spec §7.2):
 *   A ~= 0.036 * avg(dT_C) * dZ_m (J/kg)
 * Returns { paJkg (elevated warm nose), naJkg (sub-freezing cold pool below warm nose), paSfcJkg (surface melting layer) }.
 */
export function computeBourgouinAreas(airTempOrOpts = 32, wetBulbArg = null, t925Arg = null, t850Arg = null, t700Arg = null) {
  let airTempF, wetBulbF, temp925F, temp850F, temp700F;
  if (airTempOrOpts && typeof airTempOrOpts === 'object') {
    ({
      airTempF = 32,
      wetBulbF = null,
      temp925F = null,
      temp850F = null,
      temp700F = null
    } = airTempOrOpts);
  } else {
    airTempF = airTempOrOpts;
    wetBulbF = wetBulbArg;
    temp925F = t925Arg;
    temp850F = t850Arg;
    temp700F = t700Arg;
  }
  const t2m = toFiniteNumber(airTempF);
  const t925 = toFiniteNumber(temp925F);
  const t850 = toFiniteNumber(temp850F);
  const t700 = toFiniteNumber(temp700F);
  if (t2m == null || (t925 == null && t850 == null && t700 == null)) {
    return { paJkg: 0, naJkg: 0, paSfcJkg: 0 };
  }

  const pts = [{ z: 0, tC: fToC(t2m) }];
  if (t925 != null) pts.push({ z: 750, tC: fToC(t925) });
  if (t850 != null) pts.push({ z: 1500, tC: fToC(t850) });
  if (t700 != null) pts.push({ z: 3000, tC: fToC(t700) });

  const integrateSegment = (z1, t1, z2, t2) => {
    const dz = z2 - z1;
    if (dz <= 0) return { pos: 0, neg: 0 };
    if (t1 >= 0 && t2 >= 0) {
      return { pos: 0.036 * ((t1 + t2) / 2) * dz, neg: 0 };
    }
    if (t1 <= 0 && t2 <= 0) {
      return { pos: 0, neg: 0.036 * ((-t1 - t2) / 2) * dz };
    }
    const z0 = z1 + (-t1 / (t2 - t1)) * dz;
    const dz1 = z0 - z1;
    const dz2 = z2 - z0;
    if (t1 > 0) {
      return {
        pos: 0.036 * (t1 / 2) * dz1,
        neg: 0.036 * (-t2 / 2) * dz2
      };
    }
    return {
      neg: 0.036 * (-t1 / 2) * dz1,
      pos: 0.036 * (t2 / 2) * dz2
    };
  };

  // Surface melting layer PA_sfc (0–750m using Tw at surface when T2m > 32°F and aloft is sub-freezing)
  let paSfcJkg = 0;
  const twC = fToC(toFiniteNumber(wetBulbF) ?? t2m);
  const aloftCold = (t925 != null && t925 <= 32.5) || (t850 != null && t850 <= 32.5);
  if (t2m > 32.0 && aloftCold && pts.length >= 2) {
    const topRef = pts[1];
    const seg = integrateSegment(0, Math.max(0, twC), topRef.z, topRef.tC);
    paSfcJkg = seg.pos;
  }

  // Elevated warm nose PA and low-level cold pool NA strictly when surface is <= 33°F or cold layer sits beneath warm air
  let paJkg = 0;
  let naJkg = 0;
  let crossedIntoWarmAloft = false;
  if (pts[0].tC <= 0.5) {
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const seg = integrateSegment(a.z, a.tC, b.z, b.tC);
      if (!crossedIntoWarmAloft) {
        naJkg += seg.neg;
        if (seg.pos > 0) {
          crossedIntoWarmAloft = true;
          paJkg += seg.pos;
        }
      } else {
        paJkg += seg.pos;
        if (b.tC < 0) break; // exited top of warm nose
      }
    }
  } else {
    // Surface > 0.5°C: still check for elevated warm nose strictly between 925 and 700 hPa if 925 is cold and 850 is warm
    if (t925 != null && t925 <= 32.0 && t850 != null && t850 > 32.0) {
      const seg925_850 = integrateSegment(750, fToC(t925), 1500, fToC(t850));
      paJkg += seg925_850.pos;
      if (t700 != null) {
        paJkg += integrateSegment(1500, fToC(t850), 3000, fToC(t700)).pos;
      }
    }
  }

  return {
    paJkg: Number(Math.max(0, paJkg).toFixed(1)),
    naJkg: Number(Math.max(0, naJkg).toFixed(1)),
    paSfcJkg: Number(Math.max(0, paSfcJkg).toFixed(1))
  };
}

export function classifyIceRisk(ice72hIn) {
  const v = Math.max(0, toFiniteNumber(ice72hIn) ?? 0);
  if (v >= 0.5) {
    return { tier: 'CATASTROPHIC', label: 'CATASTROPHIC GLAZE', color: '#D946EF', detail: 'Severe tree & power outage emergency (>=0.50")' };
  }
  if (v >= 0.25) {
    return { tier: 'HIGH', label: 'HIGH ICE RISK', color: '#EF4444', detail: 'Damaging glaze accretion & travel shutdown (>=0.25")' };
  }
  if (v >= 0.1) {
    return { tier: 'MODERATE', label: 'MODERATE GLAZE', color: '#F97316', detail: 'Power lines & bridges icing (>=0.10")' };
  }
  if (v >= 0.01) {
    return { tier: 'LOW', label: 'LOW GLAZE', color: '#38BDF8', detail: 'Patchy bridge & elevated surface glaze' };
  }
  return { tier: 'NONE', label: 'NO GLAZE', color: '#475569', detail: 'No measurable freezing rain accretion' };
}

function isPrecipWmoCode(wmo) {
  return (wmo >= 51 && wmo <= 67) || (wmo >= 71 && wmo <= 77) || (wmo >= 80 && wmo <= 86);
}

/**
 * Upgraded Bourgouin + Surface Energy-Balance 10-State Hourly Precipitation Type Classifier (Spec §7.2).
 */
export function classifyHourlyPType({
  airTempF,
  wetBulbF,
  temp925F = null,
  temp850F = null,
  temp700F = null,
  freezingLevelFt = null,
  soil0cmF = null,
  precipIn = 0,
  snowIn = 0,
  wmoCode = 0,
  priorLiquid8hIn = 0,
  groundFreezeThresholdF = 32,
  nwsSlotHasPrecip = false,
  nwsSlotHasSnow = false,
  nwsSlotHasFreezingRain = false,
  nwsSlotHasSleet = false,
  nwsSlotHasMixed = false,
  netSticking = null,
  bourgouin = null
} = {}) {
  const airF = toFiniteNumber(airTempF) ?? 50;
  const twF = toFiniteNumber(wetBulbF) ?? computeWetBulbF(airF, 75);
  const t925 = toFiniteNumber(temp925F);
  const t850 = toFiniteNumber(temp850F);
  const t700 = toFiniteNumber(temp700F);
  const s0 = toFiniteNumber(soil0cmF);
  const pIn = Math.max(0, toFiniteNumber(precipIn) ?? 0);
  const sIn = Math.max(0, toFiniteNumber(snowIn) ?? 0);
  const wmo = Math.trunc(toFiniteNumber(wmoCode) ?? 0);
  const prior8 = Math.max(0, toFiniteNumber(priorLiquid8hIn) ?? 0);
  const threshF = toFiniteNumber(groundFreezeThresholdF) ?? 32;

  const precipActive = pIn >= 0.004 || sIn >= 0.02 || Boolean(nwsSlotHasPrecip) || isPrecipWmoCode(wmo);
  const coldSoil = s0 != null && s0 <= threshF;

  // 1. Dry Hour
  if (!precipActive) {
    const subFreeze = airF <= 32.0 || coldSoil;
    if (subFreeze && prior8 >= 0.03) return 'REFREEZE';
    return subFreeze ? 'DRY_FREEZE' : 'CLEAR';
  }

  const b = bourgouin || computeBourgouinAreas({ airTempF: airF, wetBulbF: twF, temp925F: t925, temp850F: t850, temp700F: t700 });
  const { paJkg, naJkg, paSfcJkg } = b;
  const hasAloft = t925 != null || t850 != null;
  const warmAloftPeak = hasAloft ? Math.max(t925 ?? -Infinity, t850 ?? -Infinity) : -Infinity;
  const warmNosePresent = paJkg > 2.0 || (hasAloft && warmAloftPeak > 33.5 && (airF <= 33.0 || twF <= 32.5 || coldSoil));
  const deepColdPool = naJkg >= (46.0 + 0.66 * paJkg) || (t925 != null && t925 <= 29.5 && airF <= 30.0);

  // 2. Freezing Rain
  if (nwsSlotHasFreezingRain || wmo === 56 || wmo === 57 || wmo === 66 || wmo === 67) return 'FREEZING_RAIN';
  if (warmNosePresent && !deepColdPool && (airF <= 32.5 || twF <= 32.0 || coldSoil)) return 'FREEZING_RAIN';
  if (!hasAloft && pIn >= 0.004 && sIn < 0.01 && (airF <= 32.0 || (coldSoil && airF <= Math.max(34.0, threshF + 1.0)))) {
    return 'FREEZING_RAIN';
  }

  // 3. Sleet / Ice Pellets
  if (nwsSlotHasSleet) return 'SLEET';
  if (warmNosePresent && deepColdPool) return 'SLEET';

  const snowWmo = wmo === 71 || wmo === 73 || wmo === 75 || wmo === 77 || wmo === 85 || wmo === 86;
  const hasSnowSignal = sIn >= 0.02 || Boolean(nwsSlotHasSnow) || snowWmo;

  // 4. Accumulating Snow (cold column + cold surface + net sticking)
  const coldAloftForSnow = (t850 == null || t850 <= 32.5);
  const canStick = netSticking !== null ? (Boolean(netSticking) || airF <= 31.5) : (s0 == null || s0 <= 34.5 || airF <= 31.5);
  if (paJkg <= 2.0 && coldAloftForSnow && twF <= 32.5 && airF <= 33.5 && (hasSnowSignal || (twF <= 32.0 && airF <= 33.0)) && canStick) {
    return 'ACCUMULATING_SNOW';
  }

  // 5. Wet Snow / Melting Mix (Spec §7.2 #5)
  const subFreezingAloft = (t850 != null && t850 <= 32.0) || (t925 != null && t925 <= 32.5) || (!hasAloft && twF <= 35.0);
  if (
    paJkg <= 2.0 &&
    subFreezingAloft &&
    hasSnowSignal &&
    airF <= 39.5 &&
    twF <= 37.0 &&
    paSfcJkg <= 18.0 &&
    (airF > 33.5 || twF > 32.5 || (s0 != null && s0 >= 34.5 && !canStick))
  ) {
    return 'WET_SNOW_MELTING';
  }

  // 6. Wintry Mix
  if (nwsSlotHasMixed || (paJkg >= 1.0 && paJkg <= 6.0 && airF >= 31.0 && airF <= 35.0)) {
    return 'WINTRY_MIX';
  }

  // 7. Cold Rain / Rain
  return airF <= 42.0 ? 'COLD_RAIN' : 'RAIN';
}

export function computeHourlyIceAccretion(pType, airTempF, precipIn) {
  const p = toFiniteNumber(precipIn);
  if (p === null || p <= 0) return 0;
  const tf = toFiniteNumber(airTempF) ?? 32;
  if (pType === 'FREEZING_RAIN') {
    let eff = tf < 27 ? 0.95 : tf < 31 ? 0.85 : 0.65;
    if (p > 0.25 && tf >= 31.5) eff *= 0.8;
    return p * eff;
  }
  if (pType === 'SLEET') return p * 0.15;
  if (pType === 'WINTRY_MIX' && tf <= 32.5) return p * 0.25;
  return 0;
}

function parseIsoDurationMs(durStr) {
  const s = String(durStr || '').trim().toUpperCase();
  const wk = s.match(/^P(\d+)W$/);
  if (wk) {
    const wkMs = Number(wk[1]) * 7 * 86400000;
    return Number.isFinite(wkMs) && wkMs > 0 ? Math.max(3600000, wkMs) : 3600000;
  }
  const m = s.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!m) return 3600000;
  const days = Number(m[1] || 0);
  const hrs = Number(m[2] || 0);
  const mins = Number(m[3] || 0);
  const secs = Number(m[4] || 0);
  const ms = ((days * 24 + hrs) * 3600 + mins * 60 + secs) * 1000;
  return Number.isFinite(ms) && ms > 0 ? Math.max(3600000, ms) : 3600000;
}

function parseNwsValidTimeSpan(validTime) {
  const raw = String(validTime || '');
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash + 1 >= raw.length) return null;
  const startMs = parseUtcTimestampMs(raw.slice(0, slash));
  if (startMs == null) return null;
  const durMs = parseIsoDurationMs(raw.slice(slash + 1));
  return [startMs, startMs + durMs];
}

function accumFactorInches(uom, defaultFactor = 1 / 25.4) {
  const raw = normalizeUnitCode(uom);
  if (!raw) return defaultFactor;
  const u = raw.includes(':') ? raw.split(':').pop() : raw;
  if (u.includes('inch') || u === 'in') return 1;
  if (u.includes('cm')) return 1 / 2.54;
  if (u === 'mm' || u.includes('millimet') || u.includes('kg_m-2') || u.includes('kg/m2')) return 1 / 25.4;
  if (u === 'm' || u === 'meter' || u === 'meters') return 39.3700787;
  return defaultFactor;
}

export function parseNwsGridWinter(gridData, nowMs = Date.now()) {
  const empty = { snow24hIn: 0, snow72hIn: 0, ice24hIn: 0, ice72hIn: 0, minWindChill72hF: null, hasFreezingRainWx: false, hasSleetWx: false, hasSnowWx: false };
  if (!gridData) return empty;
  let parsed = gridData;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return empty;
    }
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const refNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const props = parsed.properties || parsed;
  const end24 = refNowMs + 24 * 3600000;
  const end72 = refNowMs + 72 * 3600000;

  const integrate = (series) => {
    if (!series || !Array.isArray(series.values)) return [0, 0];
    const factor = accumFactorInches(series.uom, 1 / 25.4);
    let s24 = 0;
    let s72 = 0;
    for (const item of series.values) {
      const val = toFiniteNumber(item?.value);
      if (val == null || val <= 0) continue;
      const span = parseNwsValidTimeSpan(item.validTime);
      if (!span || span[1] <= span[0]) continue;
      const totalMs = span[1] - span[0];
      const inches = val * factor;
      const o24 = Math.min(end24, span[1]) - Math.max(refNowMs, span[0]);
      if (o24 > 0) s24 += inches * (o24 / totalMs);
      const o72 = Math.min(end72, span[1]) - Math.max(refNowMs, span[0]);
      if (o72 > 0) s72 += inches * (o72 / totalMs);
    }
    return [Number(s24.toFixed(2)), Number(s72.toFixed(2))];
  };

  const [snow24hIn, snow72hIn] = integrate(props.snowfallAmount);
  const [ice24hIn, ice72hIn] = integrate(props.iceAccumulation);

  let minWindChillRawF = null;
  if (props.windChill && Array.isArray(props.windChill.values)) {
    const wcUnit = props.windChill.uom || 'wmoUnit:degC';
    for (const item of props.windChill.values) {
      const f = convertTempToF(item?.value, wcUnit);
      if (f == null) continue;
      const span = parseNwsValidTimeSpan(item.validTime);
      if (span && (span[1] <= refNowMs || span[0] >= end72)) continue;
      if (minWindChillRawF == null || f < minWindChillRawF) minWindChillRawF = f;
    }
  }
  const minWindChill72hF = minWindChillRawF == null ? null : Math.round(minWindChillRawF);

  let hasFreezingRainWx = false;
  let hasSleetWx = false;
  let hasSnowWx = false;
  if (props.weather && Array.isArray(props.weather.values)) {
    for (const item of props.weather.values) {
      const span = parseNwsValidTimeSpan(item.validTime);
      if (!span || span[1] <= refNowMs || span[0] >= end72) continue;
      const entries = Array.isArray(item.value) ? item.value : [];
      for (const e of entries) {
        const wx = String(e?.weather || '').toLowerCase();
        if (wx.includes('freezing_rain') || wx.includes('freezing_drizzle')) hasFreezingRainWx = true;
        if (wx.includes('sleet') || wx.includes('ice_pellets')) hasSleetWx = true;
        if (wx.includes('snow')) hasSnowWx = true;
      }
    }
  }
  return { snow24hIn, snow72hIn, ice24hIn, ice72hIn, minWindChill72hF, hasFreezingRainWx, hasSleetWx, hasSnowWx };
}

export function wssiImpactRank(impactRaw) {
  const s = String(impactRaw || '').trim().toUpperCase();
  if (s.includes('EXTREME')) return 6;
  if (s.includes('MAJOR')) return 5;
  if (s.includes('MODERATE')) return 4;
  if (s.includes('MINOR')) return 3;
  if (s.includes('LIMITED')) return 2;
  if (s.includes('WINTER WEATHER') || s.includes('WINTER WX')) return 1;
  return 0;
}

export function wssiMetaForRank(rank) {
  switch (rank) {
    case 6: return { label: 'EXTREME', color: '#D946EF' };
    case 5: return { label: 'MAJOR', color: '#EF4444' };
    case 4: return { label: 'MODERATE', color: '#F97316' };
    case 3: return { label: 'MINOR', color: '#FACC15' };
    case 2: return { label: 'LIMITED', color: '#60A5FA' };
    case 1: return { label: 'WINTER WX', color: '#38BDF8' };
    default: return { label: 'NONE', color: '#64748B' };
  }
}

export function evaluateWssiAtPoint(lat, lon, wssiBundle) {
  const nLat = toFiniteNumber(lat);
  const nLon = toFiniteNumber(lon);
  const validPt = nLat !== null && nLon !== null && isValidLatLon(nLat, nLon);
  const layers = wssiBundle?.layers || (wssiBundle && typeof wssiBundle === 'object'
    ? (wssiBundle.type === 'FeatureCollection' ? { 4: wssiBundle } : wssiBundle)
    : null);
  const findBest = (fc) => {
    if (!fc || !Array.isArray(fc.features) || !validPt) return { rank: 0, label: 'NONE', color: '#64748B', validTime: null };
    let bestRank = 0;
    let validTime = null;
    for (const f of fc.features) {
      if (!f?.geometry || !isPointInGeometry(nLat, nLon, f.geometry)) continue;
      const p = f.properties || {};
      const r = wssiImpactRank(p.impact ?? p.IMPACT);
      if (r > bestRank) {
        bestRank = r;
        validTime = p.valid_time ?? p.VALID_TIME ?? null;
      }
    }
    const meta = wssiMetaForRank(bestRank);
    return { rank: bestRank, label: meta.label, color: meta.color, validTime };
  };
  if (!layers) {
    return { day1: 'NONE', day2: 'NONE', day3: 'NONE', overall: 'NONE', snowComponent: 'NONE', iceComponent: 'NONE', highestImpact: 'NONE', highestColor: '#64748B', highestRank: 0, validTime: null };
  }
  const d1 = findBest(layers[1]);
  const d2 = findBest(layers[2]);
  const d3 = findBest(layers[3]);
  const all = findBest(layers[4]);
  const snowC = findBest(layers[9]);
  const iceC = findBest(layers[19]);
  const highestRank = Math.max(d1.rank, d2.rank, d3.rank, all.rank, snowC.rank, iceC.rank);
  const topMeta = wssiMetaForRank(highestRank);
  return {
    day1: d1.label,
    day2: d2.label,
    day3: d3.label,
    overall: all.label,
    snowComponent: snowC.label,
    iceComponent: iceC.label,
    highestImpact: topMeta.label,
    highestColor: topMeta.color,
    highestRank,
    validTime: all.validTime || d1.validTime || d2.validTime || d3.validTime
  };
}

export function analyzeWinterModels(winterModels, nwsSnow72h = null, nwsIce72h = null, nowMs = Date.now(), nwsMinTemp72h = null) {
  const refNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const hourly = winterModels?.hourly || {};
  const units = winterModels?.hourly_units || {};
  const offsetSec = Number.isFinite(winterModels?.utc_offset_seconds) ? winterModels.utc_offset_seconds : 0;
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  const startIdx = times.length ? findWinterStartHourIndex(times, refNowMs, offsetSec) : 0;
  const defs = [
    { name: 'HRRR', suffixes: ['ncep_hrrr_conus', 'gfs_hrrr'] },
    { name: 'NBM', suffixes: ['ncep_nbm_conus'] },
    { name: 'ECMWF', suffixes: ['ecmwf_ifs025'] },
    { name: 'GFS', suffixes: ['gfs_global', 'gfs_seamless'] }
  ];
  const estimates = [];
  const nwsSnowNum = toFiniteNumber(nwsSnow72h);
  const nwsIceNum = toFiniteNumber(nwsIce72h);

  for (const def of defs) {
    const suf = def.suffixes.find((s) => Array.isArray(hourly[`temperature_2m_${s}`]) && hourly[`temperature_2m_${s}`].some((v) => toFiniteNumber(v) != null));
    if (!suf) continue;
    const tArr = hourly[`temperature_2m_${suf}`];
    const tUnit = units[`temperature_2m_${suf}`] || units.temperature_2m || '°F';
    const pUnit = units[`precipitation_${suf}`] || units.precipitation || 'inch';
    const sUnit = units[`snowfall_${suf}`] || units.snowfall || 'inch';
    const pArr = hourly[`precipitation_${suf}`] || [];
    const sArr = hourly[`snowfall_${suf}`] || [];
    const wArr = hourly[`weather_code_${suf}`] || [];
    const limit = Math.min(tArr.length, startIdx + 72);
    let snowSum = 0;
    let iceSum = 0;
    let minT = Infinity;
    let validCount = 0;
    for (let i = startIdx; i < limit; i++) {
      const t = convertTempToF(tArr[i], tUnit);
      if (t == null) continue;
      validCount++;
      if (t < minT) minT = t;
      const p = Math.max(0, convertPrecipToInches(pArr[i], pUnit));
      const s = Math.max(0, convertSnowfallToInches(sArr[i], sUnit));
      const w = Math.trunc(toFiniteNumber(wArr[i]) ?? 0);
      const fz = (w === 56 || w === 57 || w === 66 || w === 67) || (p >= 0.004 && s < 0.02 && t <= 32.2);
      if (fz) {
        iceSum += computeHourlyIceAccretion('FREEZING_RAIN', t, p);
      } else if (s > 0) {
        snowSum += s;
      } else if (p >= 0.004 && t <= 32.0) {
        snowSum += p * dynamicSlrForTempF(t);
      }
    }
    if (validCount > 0) {
      estimates.push({
        modelName: def.name,
        snow72hIn: Number(snowSum.toFixed(1)),
        ice72hIn: Number(iceSum.toFixed(2)),
        minTemp72hF: Number(minT.toFixed(1))
      });
    }
  }
  if (nwsSnowNum !== null || nwsIceNum !== null) {
    const nwsMin = toFiniteNumber(nwsMinTemp72h);
    estimates.unshift({
      modelName: 'NWS',
      snow72hIn: Number(Math.max(0, nwsSnowNum ?? 0).toFixed(1)),
      ice72hIn: Number(Math.max(0, nwsIceNum ?? 0).toFixed(2)),
      minTemp72hF: nwsMin != null ? Number(nwsMin.toFixed(1)) : (estimates.length ? estimates[0].minTemp72hF : 32.0)
    });
  }
  if (!estimates.length) {
    return { estimates: [], snowMinIn: 0, snowMeanIn: 0, snowMaxIn: 0, iceMinIn: 0, iceMeanIn: 0, iceMaxIn: 0, tempSpreadF: 0, agreementLabel: 'N/A' };
  }
  const snows = estimates.map((e) => e.snow72hIn);
  const ices = estimates.map((e) => e.ice72hIn);
  const temps = estimates.map((e) => e.minTemp72hF);
  const snowMinIn = Math.min(...snows);
  const snowMaxIn = Math.max(...snows);
  const iceMinIn = Math.min(...ices);
  const iceMaxIn = Math.max(...ices);
  const tempSpreadF = Number((Math.max(...temps) - Math.min(...temps)).toFixed(1));
  const snowSpread = snowMaxIn - snowMinIn;
  const iceSpread = iceMaxIn - iceMinIn;
  let agreementLabel = 'LOW';
  if (tempSpreadF <= 2.5 && snowSpread <= 1.0 && iceSpread <= 0.08) agreementLabel = 'HIGH';
  else if (tempSpreadF <= 5.0 && snowSpread <= 3.0 && iceSpread <= 0.2) agreementLabel = 'MODERATE';
  return {
    estimates,
    snowMinIn,
    snowMeanIn: Number((snows.reduce((a, b) => a + b, 0) / estimates.length).toFixed(1)),
    snowMaxIn,
    iceMinIn,
    iceMeanIn: Number((ices.reduce((a, b) => a + b, 0) / estimates.length).toFixed(2)),
    iceMaxIn,
    tempSpreadF,
    agreementLabel
  };
}

function formatWinterClock(ms, withDay = true, timeZone = DEFAULT_TIME_ZONE) {
  if (!Number.isFinite(ms)) return '--';
  const tz = (typeof timeZone === 'string' && timeZone.trim()) ? timeZone.trim() : DEFAULT_TIME_ZONE;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      ...(withDay ? { weekday: 'short' } : {}),
      hour: 'numeric',
      timeZoneName: 'short'
    }).format(new Date(ms)).replace(/[\u202f\u00a0]+/g, ' ').trim();
  } catch {
    return '--';
  }
}

/**
 * Full 72h Upgraded Bourgouin + Surface Energy-Balance + 5-Model Consensus Winter Suite (Spec §7).
 */
export function analyzeWinterSuite(
  openMeteo,
  current = {},
  groundFreezeThresholdF = 32,
  nowMs = Date.now(),
  extras = {}
) {
  const safeCurrent = current || {};
  const freezeThreshF = toFiniteNumber(groundFreezeThresholdF) ?? 32;
  const refNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const consensus = extras?.consensus || null;
  const timeZone = extras?.timeZone || consensus?.timeZone || DEFAULT_TIME_ZONE;

  const ensemblePayload = extras?.winterModels || (hasAnyEnsembleModelSuffix(openMeteo?.hourly) ? openMeteo : null);
  const omSrc = (openMeteo?.hourly?.time?.length ? openMeteo : null) || ensemblePayload || {};
  const hourly = omSrc?.hourly || {};
  const hourlyUnits = omSrc?.hourly_units || {};
  const ensHourly = ensemblePayload?.hourly || hourly;
  const ensUnits = ensemblePayload?.hourly_units || hourlyUnits;
  const isEns = hasAnyEnsembleModelSuffix(ensHourly);

  const tempUnit = hourlyUnits.temperature_2m || ensUnits.temperature_2m_ncep_hrrr_conus || '°F';
  const dewUnit = hourlyUnits.dew_point_2m || tempUnit;
  const wetUnit = hourlyUnits.wet_bulb_temperature_2m || tempUnit;
  const appUnit = hourlyUnits.apparent_temperature || tempUnit;
  const soil0Unit = ensUnits.soil_temperature_0cm_ecmwf_ifs025 || hourlyUnits.soil_temperature_0cm || tempUnit;
  const soil6Unit = ensUnits.soil_temperature_6cm_ecmwf_ifs025 || hourlyUnits.soil_temperature_6cm || tempUnit;
  const precipUnit = hourlyUnits.precipitation || 'inch';
  const snowUnit = hourlyUnits.snowfall || 'inch';
  const snowDepthUnit = ensUnits.snow_depth_ncep_hrrr_conus || hourlyUnits.snow_depth || 'ft';
  const frzUnit = normalizeUnitCode(ensUnits.freezing_level_height_ncep_hrrr_conus || hourlyUnits.freezing_level_height || 'm');
  const offsetSec = omSrc?.utc_offset_seconds ?? 0;
  const offsetOpts = Number.isFinite(offsetSec) && offsetSec !== 0 ? { utcOffsetSeconds: offsetSec } : {};
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  const idx = times.length ? findWinterStartHourIndex(times, refNowMs, offsetSec) : 0;

  const ensTimes = Array.isArray(ensHourly.time) ? ensHourly.time : times;
  const ensOffsetSec = ensemblePayload?.utc_offset_seconds ?? offsetSec;
  const ensStartIdx = ensTimes.length ? findWinterStartHourIndex(ensTimes, refNowMs, ensOffsetSec) : 0;

  // Helpers enforcing Spec §2.2 & §7.1 null-safe model extraction
  const readSoil0 = (relHr) => {
    const ei = ensStartIdx + relHr;
    const oi = idx + relHr;
    return getEnsembleSeriesValue(ensHourly, ensUnits, 'soil_temperature_0cm', ['ecmwf_ifs025', ''], ei, convertTempToF, soil0Unit)
      ?? convertTempToF(hourly.soil_temperature_0cm?.[oi], soil0Unit);
  };
  const readSoil6 = (relHr) => {
    const ei = ensStartIdx + relHr;
    const oi = idx + relHr;
    return getEnsembleSeriesValue(ensHourly, ensUnits, 'soil_temperature_6cm', ['ecmwf_ifs025', ''], ei, convertTempToF, soil6Unit)
      ?? convertTempToF(hourly.soil_temperature_6cm?.[oi], soil6Unit);
  };
  const readAloftTemp = (field, relHr) => {
    const ei = ensStartIdx + relHr;
    const oi = idx + relHr;
    if (isEns) {
      if (relHr <= 42) {
        const hrrr = getEnsembleSeriesValue(ensHourly, ensUnits, field, ['ncep_hrrr_conus'], ei, convertTempToF, tempUnit);
        if (hrrr != null) return hrrr;
      }
      const ec = getEnsembleSeriesValue(ensHourly, ensUnits, field, ['ecmwf_ifs025'], ei, convertTempToF, tempUnit);
      const gf = getEnsembleSeriesValue(ensHourly, ensUnits, field, ['gfs_global', 'gfs_seamless'], ei, convertTempToF, tempUnit);
      if (ec != null && gf != null) return (ec + gf) / 2;
      if (ec != null) return ec;
      if (gf != null) return gf;
    }
    return convertTempToF(hourly[field]?.[oi], hourlyUnits[field] || tempUnit);
  };
  const readSwRad = (relHr) => {
    const ei = ensStartIdx + relHr;
    const oi = idx + relHr;
    if (isEns) {
      const order = relHr <= 42
        ? ['ncep_hrrr_conus', 'ecmwf_ifs025', 'gfs_global', 'ncep_nbm_conus']
        : ['ecmwf_ifs025', 'gfs_global', 'ncep_hrrr_conus', 'ncep_nbm_conus'];
      const v = getEnsembleSeriesValue(ensHourly, ensUnits, 'shortwave_radiation', order, ei);
      if (v != null) return Math.max(0, v);
    }
    return Math.max(0, toFiniteNumber(hourly.shortwave_radiation?.[oi]) ?? 0);
  };
  const readFrzLevelFt = (relHr) => {
    const ei = ensStartIdx + relHr;
    const oi = idx + relHr;
    const raw = isEns
      ? getEnsembleSeriesValue(ensHourly, ensUnits, 'freezing_level_height', ['ncep_hrrr_conus', 'gfs_global', ''], ei)
      : toFiniteNumber(hourly.freezing_level_height?.[oi]);
    if (raw == null) return null;
    const isMeters = frzUnit === 'm' || frzUnit === 'meter' || frzUnit === 'meters';
    return Math.max(0, Math.round(isMeters ? mToFeet(raw) : raw));
  };

  const g0Val = readSoil0(0);
  const g6Val = readSoil6(0);
  const ground0cmF = g0Val != null ? Math.round(g0Val) : null;
  const ground6cmF = g6Val != null ? Math.round(g6Val) : null;
  const freezingLevelFt = readFrzLevelFt(0);

  const hasNwsGrid = Boolean(extras?.gridData && typeof extras.gridData === 'object');
  const nwsGrid = parseNwsGridWinter(extras?.gridData || null, refNowMs);

  const totalAvailable = Math.max(
    consensus?.hourly?.length || 0,
    times.length ? Math.max(0, times.length - idx) : 0,
    Array.isArray(hourly.temperature_2m) ? Math.max(0, hourly.temperature_2m.length - idx) : 0
  );
  const horizonCount = Math.min(72, totalAvailable);

  const next24Temps = [];
  for (let relHr = 0; relHr < Math.min(24, horizonCount); relHr++) {
    const tVal = consensus?.hourly?.[relHr]?.tempF
      ?? convertTempToF(hourly.temperature_2m?.[idx + relHr], tempUnit)
      ?? getEnsembleSeriesValue(ensHourly, ensUnits, 'temperature_2m', ['ncep_hrrr_conus', 'ncep_nbm_conus', 'ecmwf_ifs025', 'gfs_global'], ensStartIdx + relHr, convertTempToF, tempUnit);
    if (tVal != null && Number.isFinite(tVal)) next24Temps.push(tVal);
  }
  const hoursBelowFreezingNext24h = next24Temps.filter((t) => t <= 32).length;
  const minTemp24h = next24Temps.length
    ? Math.round(Math.min(...next24Temps))
    : (toFiniteNumber(safeCurrent.tempF) ?? null);

  const precipNow = Math.max(0, consensus?.hourly?.[0]?.qpfIn ?? toFiniteNumber(openMeteo?.current?.precipitation) ?? 0);
  const wmo = Math.trunc(consensus?.hourly?.[0]?.wmoCode ?? toFiniteNumber(openMeteo?.current?.weather_code) ?? 0);
  const airF = toFiniteNumber(safeCurrent.tempF) ?? consensus?.hourly?.[0]?.tempF ?? 50;
  const visMi = Math.max(0, toFiniteNumber(safeCurrent.visibilityMi) ?? consensus?.hourly?.[0]?.visibilityMi ?? 10);

  const hourlySlots = [];
  const liquidRing = new Array(8).fill(0);
  const recentWindRing = new Array(4).fill(0);
  let liquidPtr = 0;
  let dryStreakHours = 0;

  let consensusSnow24 = 0;
  let consensusSnow72 = 0;
  let omIce24 = 0;
  let omIce72 = 0;
  let maxSnowDepthIn = 0;
  let maxSnowRateHr = 0;
  let minSoil0cmWintryF = null;
  let minSoil6cmWintryF = null;
  let minAirWintry = null;
  let minWetBulbWintryF = null;
  let rainDuringSnowIn = 0;
  let peakSolarDuringSnowWm2 = 0;
  let anySlotWintry = false;
  let minTemp72hF = null;
  let minWindChill72hF = nwsGrid.minWindChill72hF;
  let hoursSubFreeze72h = 0;
  let slrWeightedSum = 0;
  let slrWeightTotal = 0;

  // Continuous hourly snowpack depth balance (Grass/Elevated vs. Paved Roads/Asphalt)
  let grassPackIn = 0;
  let roadPackIn = 0;
  let peakGrass24 = 0;
  let peakGrass72 = 0;
  let peakRoad24 = 0;
  let peakRoad72 = 0;

  let thermalProfile = {
    airTempF: airF,
    wetBulbF: computeWetBulbF(airF, toFiniteNumber(safeCurrent.humidity) ?? 75),
    temp925F: null,
    temp850F: null,
    temp700F: null,
    freezingLevelFt,
    ground0cmF,
    ground6cmF,
    hasWarmNose: false,
    warmNosePeakF: null,
    warmNosePaJkg: 0,
    coldPoolNaJkg: 0,
    dominantPType: 'CLEAR'
  };

  for (let relHr = 0; relHr < horizonCount; relHr++) {
    const i = idx + relHr;
    const ei = ensStartIdx + relHr;
    const consSlot = consensus?.hourly?.[relHr] || null;
    const nwsSlot = consSlot?.nwsGridSlot || null;
    const slotMs = consSlot?.epochMs ?? parseUtcTimestampMs(times[i], offsetOpts) ?? (refNowMs + relHr * 3600000);

    const ensOrder = ['ncep_hrrr_conus', 'ncep_nbm_conus', 'ecmwf_ifs025', 'gfs_global', ''];
    const t2m = consSlot?.tempF
      ?? convertTempToF(hourly.temperature_2m?.[i], tempUnit)
      ?? getEnsembleSeriesValue(ensHourly, ensUnits, 'temperature_2m', ensOrder, ei, convertTempToF, tempUnit)
      ?? airF;
    const td = consSlot?.dewpointF
      ?? convertTempToF(hourly.dew_point_2m?.[i], dewUnit)
      ?? getEnsembleSeriesValue(ensHourly, ensUnits, 'dew_point_2m', ensOrder, ei, convertTempToF, dewUnit);
    const rhVal = consSlot?.rhPct
      ?? toFiniteNumber(hourly.relative_humidity_2m?.[i])
      ?? getEnsembleSeriesValue(ensHourly, ensUnits, 'relative_humidity_2m', ensOrder, ei)
      ?? (td != null ? deriveRhFromTempDewF(t2m, td) : 75);
    const twF = consSlot?.wetBulbF
      ?? convertTempToF(hourly.wet_bulb_temperature_2m?.[i], wetUnit)
      ?? getEnsembleSeriesValue(ensHourly, ensUnits, 'wet_bulb_temperature_2m', ensOrder, ei, convertTempToF, wetUnit)
      ?? computeWetBulbF(t2m, rhVal);
    const t925 = readAloftTemp('temperature_925hPa', relHr);
    const t850 = readAloftTemp('temperature_850hPa', relHr);
    const t700 = readAloftTemp('temperature_700hPa', relHr);
    const frzFt = readFrzLevelFt(relHr);
    const s0 = readSoil0(relHr);
    const s6 = readSoil6(relHr);
    const windMph = Math.max(0, consSlot?.windMph
      ?? getEnsembleSeriesValue(ensHourly, ensUnits, 'wind_speed_10m', ensOrder, ei, convertWindToMph, 'mp/h')
      ?? 0);

    const precipIn = Math.max(0,
      consSlot?.qpfIn
      ?? (hourly.precipitation?.[i] != null ? convertPrecipToInches(hourly.precipitation[i], precipUnit) : null)
      ?? getEnsembleSeriesValue(ensHourly, ensUnits, 'precipitation', ensOrder, ei, convertPrecipToInches, precipUnit)
      ?? 0
    );
    const rainRaw = Math.max(0,
      getEnsembleSeriesValue(ensHourly, ensUnits, 'rain', ensOrder, ei, convertPrecipToInches, precipUnit)
      ?? convertPrecipToInches(hourly.rain?.[i], hourlyUnits.rain || precipUnit)
    );
    const showersRaw = Math.max(0,
      getEnsembleSeriesValue(ensHourly, ensUnits, 'showers', ensOrder, ei, convertPrecipToInches, precipUnit)
      ?? convertPrecipToInches(hourly.showers?.[i], hourlyUnits.showers || precipUnit)
    );
    const rainIn = Math.max(rainRaw + showersRaw, 0);
    const snowRawIn = Math.max(0,
      consSlot?.snowAloftIn
      ?? (hourly.snowfall?.[i] != null ? convertSnowfallToInches(hourly.snowfall[i], snowUnit) : null)
      ?? getEnsembleSeriesValue(ensHourly, ensUnits, 'snowfall', ensOrder, ei, convertSnowfallToInches, snowUnit)
      ?? 0
    );
    const swRad = readSwRad(relHr);
    const isDayVal = consSlot?.isDay != null
      ? (consSlot.isDay ? 1 : 0)
      : (getEnsembleSeriesValue(ensHourly, ensUnits, 'is_day', ['ncep_hrrr_conus', 'ecmwf_ifs025', 'gfs_global', ''], ei) ?? toFiniteNumber(hourly.is_day?.[i]));
    const isDay = isDayVal != null ? isDayVal >= 0.5 : swRad >= 15;
    const slotWmo = Math.trunc(
      consSlot?.wmoCode
      ?? toFiniteNumber(hourly.weather_code?.[i])
      ?? getEnsembleSeriesValue(ensHourly, ensUnits, 'weather_code', ensOrder, ei)
      ?? 0
    );

    // Wind-drying attenuation for Black-Ice Refreeze (Spec §7.2 #1)
    let effectivePriorLiquid8h = liquidRing.reduce((a, b) => a + b, 0);
    const meanWind4h = recentWindRing.reduce((a, b) => a + b, 0) / 4;
    if (dryStreakHours >= 4 && meanWind4h >= 15.0) {
      effectivePriorLiquid8h *= 0.35;
    }

    // Compute Surface Energy-Balance terms before final snow vs wet-snow sticking check
    const effSoil0 = s0 != null && Number.isFinite(s0) ? s0 : (t2m + 1.5);
    const effSoil6 = s6 != null && Number.isFinite(s6) ? s6 : (effSoil0 + 1.5);
    const bourgouin = computeBourgouinAreas({ airTempF: t2m, wetBulbF: twF, temp925F: t925, temp850F: t850, temp700F: t700 });
    const slotSlr = kucheraSlrForProfile(t2m, t925, t850, t700);
    const prelimSnowIn = snowRawIn > 0 ? snowRawIn : (twF <= 33.5 && t2m <= 35.0 ? precipIn * slotSlr : 0);

    let baseStickEff;
    if (twF <= 31.0) baseStickEff = 1.0;
    else if (twF <= 32.0) baseStickEff = 0.85;
    else if (twF <= 33.0) baseStickEff = prelimSnowIn >= 1.0 ? 0.72 : 0.45;
    else if (twF <= 34.0) baseStickEff = prelimSnowIn >= 1.0 ? 0.42 : 0.14;
    else baseStickEff = (prelimSnowIn >= 1.2 && t2m < 35.5) ? 0.18 : 0.03;

    const prelimRainIn = rainIn > 0 ? rainIn : (t2m > 34.0 ? precipIn * 0.5 : 0);
    const rainFactorRoad = prelimRainIn >= 0.005 ? Math.max(0.0, 1.0 - prelimRainIn / 0.020) : 1.0;
    const rainFactorGrass = prelimRainIn >= 0.005 ? Math.max(0.10, 1.0 - prelimRainIn / 0.045) : 1.0;
    const rateCoolFactor = (prelimSnowIn >= 1.0 && twF <= 33.2 && prelimRainIn < 0.015) ? 0.55 : 1.0;

    const tRoad = 0.50 * effSoil0 + 0.30 * effSoil6 + 0.20 * t2m + (isDay ? swRad / 85.0 : 0.0);
    const tGrass = 0.42 * effSoil0 + 0.13 * effSoil6 + 0.45 * twF + (isDay ? swRad / 220.0 : 0.0);

    const roadMelt =
      Math.max(0.0, (tRoad - 32.0) * 0.13) * rateCoolFactor +
      (isDay ? swRad / 650.0 : 0.0) +
      (prelimRainIn > 0.002 ? prelimRainIn * (Math.max(0.0, t2m - 32.0) * 0.5 + 4.0) : 0.0);
    const grassMelt =
      Math.max(0.0, (tGrass - 32.0) * 0.085) * rateCoolFactor +
      (isDay ? swRad / 1350.0 : 0.0) +
      (prelimRainIn > 0.002 ? prelimRainIn * (Math.max(0.0, t2m - 32.0) * 0.35 + 2.5) : 0.0);

    const warmRoadPenalty = (effSoil0 > 34.0 && twF > 32.2) ? 0.5 : 1.0;
    const prelimAddedGrass = prelimSnowIn * baseStickEff * rainFactorGrass;
    const prelimAddedRoad = prelimSnowIn * baseStickEff * rainFactorRoad * warmRoadPenalty;
    const netSticking = (prelimAddedGrass > grassMelt) || (prelimAddedRoad > roadMelt) || t2m <= 31.5;

    const pType = classifyHourlyPType({
      airTempF: t2m,
      wetBulbF: twF,
      temp925F: t925,
      temp850F: t850,
      temp700F: t700,
      freezingLevelFt: frzFt,
      soil0cmF: s0,
      precipIn,
      snowIn: snowRawIn,
      wmoCode: slotWmo,
      priorLiquid8hIn: effectivePriorLiquid8h,
      groundFreezeThresholdF: freezeThreshF,
      nwsSlotHasPrecip: Boolean(nwsSlot?.hasPrecipWx),
      nwsSlotHasSnow: Boolean(nwsSlot?.hasSnowWx),
      nwsSlotHasFreezingRain: Boolean(nwsSlot?.hasFreezingRainWx),
      nwsSlotHasSleet: Boolean(nwsSlot?.hasSleetWx),
      nwsSlotHasMixed: Boolean(nwsSlot?.hasMixedWx),
      netSticking,
      bourgouin
    });

    const iceIn = computeHourlyIceAccretion(pType, t2m, precipIn);
    let slotSnowIn = 0;
    if (pType === 'ACCUMULATING_SNOW') slotSnowIn = snowRawIn > 0 ? snowRawIn : precipIn * slotSlr;
    else if (pType === 'WET_SNOW_MELTING' || pType === 'WINTRY_MIX') slotSnowIn = snowRawIn;

    if (slotSnowIn > maxSnowRateHr) maxSnowRateHr = slotSnowIn;
    if (slotSnowIn > 0) {
      slrWeightedSum += slotSlr * slotSnowIn;
      slrWeightTotal += slotSnowIn;
      rainDuringSnowIn += rainIn;
      if (swRad > peakSolarDuringSnowWm2) peakSolarDuringSnowWm2 = swRad;
    }

    const effRainIn = rainIn > 0 ? rainIn : ((pType === 'COLD_RAIN' || pType === 'RAIN') ? precipIn : 0);
    const rainFacRoad2 = effRainIn >= 0.005 ? Math.max(0.0, 1.0 - effRainIn / 0.020) : 1.0;
    const rainFacGrass2 = effRainIn >= 0.005 ? Math.max(0.10, 1.0 - effRainIn / 0.045) : 1.0;
    const settle = t2m > 30.0 ? 0.97 : 0.995;
    const addedGrass = slotSnowIn * baseStickEff * rainFacGrass2;
    const addedRoad = slotSnowIn * baseStickEff * rainFacRoad2 * warmRoadPenalty;

    grassPackIn = Math.max(0.0, grassPackIn * settle + addedGrass - grassMelt);
    roadPackIn = Math.max(0.0, roadPackIn * settle + addedRoad - roadMelt);
    if (relHr < 24) {
      if (grassPackIn > peakGrass24) peakGrass24 = grassPackIn;
      if (roadPackIn > peakRoad24) peakRoad24 = roadPackIn;
    }
    if (grassPackIn > peakGrass72) peakGrass72 = grassPackIn;
    if (roadPackIn > peakRoad72) peakRoad72 = roadPackIn;

    const isLiquidBearing =
      pType === 'RAIN' ||
      pType === 'COLD_RAIN' ||
      pType === 'FREEZING_RAIN' ||
      pType === 'WINTRY_MIX' ||
      pType === 'WET_SNOW_MELTING' ||
      pType === 'SLEET';
    liquidRing[liquidPtr % 8] = isLiquidBearing ? precipIn : 0;
    recentWindRing[liquidPtr % 4] = windMph;
    liquidPtr++;
    if (precipIn >= 0.004 || slotSnowIn >= 0.02) dryStreakHours = 0;
    else dryStreakHours += 1;

    const meta = PTYPE_META[pType] || PTYPE_META.CLEAR;
    if (meta?.wintry || slotSnowIn > 0) {
      anySlotWintry = true;
      if (s0 != null && Number.isFinite(s0) && (minSoil0cmWintryF == null || s0 < minSoil0cmWintryF)) {
        minSoil0cmWintryF = Number(s0.toFixed(1));
      }
      if (s6 != null && Number.isFinite(s6) && (minSoil6cmWintryF == null || s6 < minSoil6cmWintryF)) {
        minSoil6cmWintryF = Number(s6.toFixed(1));
      }
      if (Number.isFinite(t2m) && (minAirWintry == null || t2m < minAirWintry)) {
        minAirWintry = Number(t2m.toFixed(1));
      }
      if (Number.isFinite(twF) && (minWetBulbWintryF == null || twF < minWetBulbWintryF)) {
        minWetBulbWintryF = Number(twF.toFixed(1));
      }
    }

    hourlySlots.push({
      epochMs: slotMs,
      hourLabel: formatWinterClock(slotMs, true, timeZone),
      pType,
      pTypeLabel: meta.label,
      pTypeShortLabel: meta.shortLabel,
      pTypeColor: meta.color,
      warmNosePaJkg: bourgouin.paJkg,
      coldPoolNaJkg: bourgouin.naJkg,
      airTempF: Number(t2m.toFixed(1)),
      wetBulbF: Number(twF.toFixed(1)),
      temp925F: t925 != null ? Number(t925.toFixed(1)) : null,
      temp850F: t850 != null ? Number(t850.toFixed(1)) : null,
      temp700F: t700 != null ? Number(t700.toFixed(1)) : null,
      precipIn: Number(precipIn.toFixed(3)),
      snowAloftIn: Number(slotSnowIn.toFixed(2)),
      snowIn: Number(slotSnowIn.toFixed(2)),
      iceIn: Number(iceIn.toFixed(3)),
      soil0cmF: s0 != null ? Number(s0.toFixed(1)) : null,
      soil6cmF: s6 != null ? Number(s6.toFixed(1)) : null,
      grassDepthIn: Number(grassPackIn.toFixed(2)),
      roadDepthIn: Number(roadPackIn.toFixed(2))
    });

    if (relHr < 24) {
      consensusSnow24 += slotSnowIn;
      omIce24 += iceIn;
    }
    consensusSnow72 += slotSnowIn;
    omIce72 += iceIn;

    const sdVal = isEns
      ? getEnsembleSeriesValue(ensHourly, ensUnits, 'snow_depth', ['ncep_hrrr_conus', 'ecmwf_ifs025', 'gfs_global', ''], ei)
      : toFiniteNumber(hourly.snow_depth?.[i]);
    if (sdVal != null && sdVal > 0) {
      const sdU = normalizeUnitCode(snowDepthUnit);
      const sdIn = sdU.includes('ft')
        ? sdVal * 12
        : (sdU === 'm' || sdU === 'meter' || sdU === 'meters')
          ? sdVal * 39.3701
          : sdU === 'cm'
            ? sdVal / 2.54
            : sdVal;
      if (sdIn > maxSnowDepthIn) maxSnowDepthIn = sdIn;
    }
    if (t2m <= 32) hoursSubFreeze72h++;
    if (minTemp72hF == null || t2m < minTemp72hF) minTemp72hF = Number(t2m.toFixed(1));
    const appT = consSlot?.feelsLikeF ?? convertTempToF(hourly.apparent_temperature?.[i], appUnit);
    if (appT != null && (minWindChill72hF == null || appT < minWindChill72hF)) {
      minWindChill72hF = Math.round(appT);
    }

    if (relHr === 0) {
      const peak = t925 != null && t850 != null ? Math.max(t925, t850) : (t850 ?? t925 ?? null);
      const effGround0 = s0 != null ? Number(s0.toFixed(1)) : ground0cmF;
      const subFreezingSfc = t2m <= 32.5 || twF <= 32.0 || (effGround0 != null && effGround0 <= 32.0);
      thermalProfile = {
        airTempF: Number(t2m.toFixed(1)),
        wetBulbF: Number(twF.toFixed(1)),
        temp925F: t925 != null ? Number(t925.toFixed(1)) : null,
        temp850F: t850 != null ? Number(t850.toFixed(1)) : null,
        temp700F: t700 != null ? Number(t700.toFixed(1)) : null,
        freezingLevelFt: frzFt ?? freezingLevelFt,
        ground0cmF: effGround0,
        ground6cmF: s6 != null ? Number(s6.toFixed(1)) : ground6cmF,
        hasWarmNose: (bourgouin.paJkg > 2.0 || (peak != null && peak > 33.5)) && subFreezingSfc,
        warmNosePeakF: peak != null ? Number(peak.toFixed(1)) : null,
        warmNosePaJkg: bourgouin.paJkg,
        coldPoolNaJkg: bourgouin.naJkg,
        dominantPType: pType
      };
    }
  }

  // Track peak Bourgouin PA/NA across any freezing-rain/sleet slot
  const warmNoseSlot = hourlySlots.find((s) => s.pType === 'FREEZING_RAIN' || s.pType === 'SLEET');
  if (warmNoseSlot) {
    thermalProfile.hasWarmNose = true;
    thermalProfile.warmNosePaJkg = Math.max(thermalProfile.warmNosePaJkg || 0, warmNoseSlot.warmNosePaJkg || 0);
    thermalProfile.coldPoolNaJkg = Math.max(thermalProfile.coldPoolNaJkg || 0, warmNoseSlot.coldPoolNaJkg || 0);
    if (thermalProfile.warmNosePeakF == null) {
      const pk = Math.max(warmNoseSlot.temp925F ?? -Infinity, warmNoseSlot.temp850F ?? -Infinity);
      if (Number.isFinite(pk)) thermalProfile.warmNosePeakF = pk;
    }
  }

  if (minSoil0cmWintryF == null && thermalProfile.ground0cmF != null && Number.isFinite(thermalProfile.ground0cmF)) {
    minSoil0cmWintryF = Number(thermalProfile.ground0cmF.toFixed(1));
  }
  if (minSoil6cmWintryF == null && thermalProfile.ground6cmF != null && Number.isFinite(thermalProfile.ground6cmF)) {
    minSoil6cmWintryF = Number(thermalProfile.ground6cmF.toFixed(1));
  }
  if (minAirWintry == null && minTemp72hF != null && Number.isFinite(minTemp72hF)) {
    minAirWintry = Number(minTemp72hF.toFixed(1));
  }
  if (minWetBulbWintryF == null && thermalProfile.wetBulbF != null && Number.isFinite(thermalProfile.wetBulbF)) {
    minWetBulbWintryF = Number(thermalProfile.wetBulbF.toFixed(1));
  }

  // Consensus aloft snow (NOT Math.max(omSnow, nwsSnow)! Per Spec §1 #4 & §7.3)
  const consensusAloftSnow24hIn = Number(consensusSnow24.toFixed(1));
  const consensusAloftSnow72hIn = Number(consensusSnow72.toFixed(1));
  const finalSnow24 = consensusAloftSnow24hIn;
  const finalSnow72 = consensusAloftSnow72hIn;
  const finalIce24 = Number(Math.max(omIce24, nwsGrid.ice24hIn).toFixed(2));
  const finalIce72 = Number(Math.max(omIce72, nwsGrid.ice72hIn).toFixed(2));

  // Build 5-Model Winter Spread (NWS, HRRR, NBM, ECMWF, GFS)
  const nwsMinT = consensus?.perModelSummary?.find((m) => m.name === 'NWS')?.minTemp72hF ?? null;
  const modelSpread = analyzeWinterModels(
    ensemblePayload || null,
    hasNwsGrid ? nwsGrid.snow72hIn : null,
    hasNwsGrid ? nwsGrid.ice72hIn : null,
    refNowMs,
    nwsMinT
  );
  const nbmEst = modelSpread.estimates.find((e) => e.modelName === 'NBM');
  const nbmSnow72hIn = nbmEst ? nbmEst.snow72hIn : null;

  // Mandatory Official NWS Gridpoint Cross-Check Gate (Spec §7.3 Rule A & Rule B)
  let forcedWarmGroundCap = false;
  if (hasNwsGrid && nwsGrid.snow72hIn >= 0.5 && (minSoil0cmWintryF == null || minSoil0cmWintryF <= 33.5)) {
    // Rule A (Cold Ground NWS Floor)
    peakGrass72 = Math.max(peakGrass72, nwsGrid.snow72hIn);
    peakGrass24 = Math.max(peakGrass24, nwsGrid.snow24hIn);
    if (minSoil0cmWintryF == null || minSoil0cmWintryF <= 32.5) {
      peakRoad72 = Math.max(peakRoad72, nwsGrid.snow72hIn);
      peakRoad24 = Math.max(peakRoad24, nwsGrid.snow24hIn);
    }
  } else if (
    hasNwsGrid &&
    nwsGrid.snow72hIn < 0.05 &&
    !nwsGrid.hasSnowWx &&
    minWetBulbWintryF != null && minWetBulbWintryF > 32.5 &&
    minSoil0cmWintryF != null && minSoil0cmWintryF >= 34.5
  ) {
    // Rule B (Warm Ground + NWS 0.0" Cap)
    forcedWarmGroundCap = true;
    peakRoad24 = 0.0;
    peakRoad72 = 0.0;
    const grassCap = (nbmSnow72hIn != null && nbmSnow72hIn < 0.15 && minWetBulbWintryF >= 33.5) ? 0.0 : 0.1;
    peakGrass24 = Math.min(peakGrass24, grassCap);
    peakGrass72 = Math.min(peakGrass72, grassCap);
  }

  const maxAllowedSnow24 = Math.max(finalSnow24, hasNwsGrid ? nwsGrid.snow24hIn : 0);
  const maxAllowedSnow72 = Math.max(finalSnow72, hasNwsGrid ? nwsGrid.snow72hIn : 0);
  const grassSnow24hIn = Number(Math.min(maxAllowedSnow24, peakGrass24).toFixed(1));
  const grassSnow72hIn = Number(Math.min(maxAllowedSnow72, Math.max(peakGrass24, peakGrass72)).toFixed(1));
  const roadSnow24hIn = Number(Math.min(maxAllowedSnow24, peakRoad24).toFixed(1));
  const roadSnow72hIn = Number(Math.min(maxAllowedSnow72, Math.max(peakRoad24, peakRoad72)).toFixed(1));

  const iceRisk = classifyIceRisk(finalIce72);
  let iceRiskDetail = iceRisk.detail;
  if (finalIce72 >= 0.25) iceRiskDetail = `${finalIce72.toFixed(2)}" glaze forecast — ${iceRisk.detail}`;
  else if (finalIce72 >= 0.01) iceRiskDetail = `${finalIce72.toFixed(2)}" ice — ${iceRisk.detail}`;

  const wssi = evaluateWssiAtPoint(extras?.lat, extras?.lon, extras?.wssiBundle);

  const hasWintryActivity =
    finalSnow72 >= 0.05 ||
    finalIce72 >= 0.01 ||
    modelSpread.snowMaxIn >= 0.1 ||
    anySlotWintry;

  const g6ValForNote = minSoil6cmWintryF ?? thermalProfile.ground6cmF ?? ground6cmF;
  const g6Str = g6ValForNote != null && Number.isFinite(g6ValForNote) ? `${Math.round(g6ValForNote)}°F` : '--°F';
  const g0Str = minSoil0cmWintryF != null && Number.isFinite(minSoil0cmWintryF) ? `${Math.round(minSoil0cmWintryF)}°F` : '--°F';
  const twStr = minWetBulbWintryF != null && Number.isFinite(minWetBulbWintryF) ? `${minWetBulbWintryF.toFixed(1)}°F` : '--°F';

  const meltDrivers = [];
  if (minSoil0cmWintryF != null && minSoil0cmWintryF >= 34.0) meltDrivers.push(`0cm ${g0Str}/6cm ${g6Str} warm ground`);
  if (minWetBulbWintryF != null && minWetBulbWintryF > 32.5) meltDrivers.push(`Tw ${twStr}`);
  if (rainDuringSnowIn >= 0.01) meltDrivers.push('mixed rain');
  if (peakSolarDuringSnowWm2 >= 80) meltDrivers.push('daytime sun');
  if (hasNwsGrid && nwsGrid.snow72hIn < 0.05) meltDrivers.push('NWS 0.0"');
  const meltReasonStr = meltDrivers.length ? meltDrivers.join(', ') : `0cm ${g0Str} / 6cm ${g6Str} warm ground`;

  const anySleetOrFzra = hourlySlots.some((s) => s.pType === 'SLEET' || s.pType === 'FREEZING_RAIN');
  const hasSubFreezingIceOrSleet =
    (finalIce72 >= 0.01 || anySleetOrFzra) &&
    (minSoil0cmWintryF == null || minSoil0cmWintryF <= 32.5);

  let groundAccumStatus = 'NO_WINTRY_PRECIP';
  let groundAccumNote = `No wintry precipitation expected in 72h (0cm ${g0Str} / 6cm ${g6Str}, ${hoursSubFreeze72h}h<=32°F).`;

  if (!hasWintryActivity) {
    groundAccumStatus = 'NO_WINTRY_PRECIP';
  } else if (hasSubFreezingIceOrSleet && !forcedWarmGroundCap) {
    groundAccumStatus = 'COLD_GROUND_STICKS';
    groundAccumNote = `Sub-freezing surface (${minSoil0cmWintryF != null ? `${Math.round(minSoil0cmWintryF)}°F ground` : 'freezing temps'}): snow/ice will stick immediately to roads, bridges & overpasses.`;
  } else if (forcedWarmGroundCap || (finalIce72 < 0.05 && roadSnow72hIn < 0.1 && grassSnow72hIn < 0.25)) {
    groundAccumStatus = 'WARM_GROUND_MELTS';
    groundAccumNote = `Will NOT stick (${meltReasonStr}): ${finalSnow72.toFixed(1)}" consensus aloft (models up to ${Math.max(finalSnow72, modelSpread.snowMaxIn).toFixed(1)}") melts on contact — wet roads only (0.0" accum).`;
  } else if (finalIce72 < 0.05 && roadSnow72hIn < 0.15 && grassSnow72hIn >= 0.25) {
    groundAccumStatus = 'GRASS_SLUSH_ONLY';
    groundAccumNote = `Wet roads (0.0"), brief slushy grass/decks ~${grassSnow72hIn.toFixed(1)}" (${meltReasonStr}): melts on pavement from warm subsoil.`;
  } else if (finalIce72 < 0.05 && ((minSoil0cmWintryF != null && minSoil0cmWintryF > 32.5) || roadSnow72hIn < Math.max(0.1, finalSnow72 * 0.55))) {
    groundAccumStatus = 'MARGINAL_SLUSHY';
    groundAccumNote = `Marginal surface (${meltReasonStr}): ~${roadSnow72hIn.toFixed(1)}" slushy roads / ~${grassSnow72hIn.toFixed(1)}" grass out of ${finalSnow72.toFixed(1)}" falling aloft.`;
  } else {
    groundAccumStatus = 'COLD_GROUND_STICKS';
    groundAccumNote = `Sub-freezing surface (${minSoil0cmWintryF != null ? `${Math.round(minSoil0cmWintryF)}°F ground` : 'freezing temps'}): snow/ice will stick immediately to roads, bridges & overpasses.`;
  }

  let changeoverLabel = 'No wintry precip in 72h';
  let refreezeLabel = 'No wet-to-freeze refreeze detected';
  let peakWindowLabel = 'No significant snow/ice peak';
  let thawLabel = 'Stays above freezing (>32°F all 72h)';
  let lastColdIdx = -1;

  for (let i = 0; i < hourlySlots.length; i++) {
    const s = hourlySlots[i];
    const meta = PTYPE_META[s.pType];
    if (meta?.wintry && changeoverLabel.startsWith('No ')) {
      changeoverLabel = `${meta.label} @ ${formatWinterClock(s.epochMs, true, timeZone)}`;
    }
    if (s.pType === 'REFREEZE' && refreezeLabel.startsWith('No ')) {
      refreezeLabel = `Black-ice refreeze @ ${formatWinterClock(s.epochMs, true, timeZone)}`;
    }
    if (
      s.airTempF <= 32 ||
      (s.soil0cmF != null && s.soil0cmF <= 32) ||
      s.pType === 'FREEZING_RAIN' ||
      s.pType === 'REFREEZE' ||
      s.pType === 'DRY_FREEZE'
    ) {
      lastColdIdx = i;
    }
  }
  if (lastColdIdx >= 0) {
    thawLabel = 'Stays <=32°F through 72h';
    for (let i = lastColdIdx + 1; i < hourlySlots.length; i++) {
      if (hourlySlots[i].airTempF >= 34) {
        thawLabel = `Thaw >=34°F @ ${formatWinterClock(hourlySlots[i].epochMs, true, timeZone)}`;
        break;
      }
    }
  }
  if (groundAccumStatus === 'WARM_GROUND_MELTS' || groundAccumStatus === 'GRASS_SLUSH_ONLY') {
    const meltSuffix = groundAccumStatus === 'WARM_GROUND_MELTS' ? '(melts on warm ground)' : '(slushy grass / wet roads)';
    if (!changeoverLabel.startsWith('No ')) {
      const alreadyNoted = /melts|slushy/i.test(changeoverLabel);
      if (!alreadyNoted) {
        changeoverLabel = changeoverLabel.includes(' @ ')
          ? changeoverLabel.replace(' @ ', ` ${meltSuffix} @ `)
          : `${changeoverLabel} ${meltSuffix}`;
      } else if (groundAccumStatus === 'WARM_GROUND_MELTS' && !/melts on warm ground/i.test(changeoverLabel)) {
        changeoverLabel = changeoverLabel.replace(/\(Melts\)/i, '(melts on warm ground)');
      }
    } else if (finalSnow72 >= 0.05 || modelSpread.snowMaxIn >= 0.1) {
      changeoverLabel = `Wet snow/mix aloft ${meltSuffix}`;
    }
  }
  if (hourlySlots.length >= 6) {
    let bestScore = 0;
    let bestStart = -1;
    for (let i = 0; i <= hourlySlots.length - 6; i++) {
      let sc = 0;
      for (let j = 0; j < 6; j++) {
        sc += hourlySlots[i + j].snowIn + hourlySlots[i + j].iceIn * 12;
      }
      if (sc > bestScore) {
        bestScore = sc;
        bestStart = i;
      }
    }
    if (bestStart >= 0 && bestScore > 0.05) {
      peakWindowLabel = `${formatWinterClock(hourlySlots[bestStart].epochMs, false, timeZone)} – ${formatWinterClock(hourlySlots[bestStart + 5].epochMs, true, timeZone)}`;
    }
  }

  const effKucheraSlr = slrWeightTotal > 0
    ? Math.max(4, Math.min(20, Math.round(slrWeightedSum / slrWeightTotal)))
    : kucheraSlrForProfile(minAirWintry ?? thermalProfile.airTempF ?? 30, thermalProfile.temp925F, thermalProfile.temp850F, thermalProfile.temp700F);
  const slrLabel = (finalSnow72 > 0 || roadSnow72hIn > 0) ? `${effKucheraSlr}:1 Kuchera` : 'Dry / 10:1';

  let headline = '72H MONITORING';
  if (finalIce72 >= 0.5 || (wssi.highestRank >= 5 && finalIce72 >= 0.25)) {
    headline = `MAJOR ICE STORM (${finalIce72.toFixed(2)}")`;
  } else if (finalIce72 >= 0.25) {
    headline = `ICE STORM DANGER (${finalIce72.toFixed(2)}")`;
  } else if (groundAccumStatus === 'WARM_GROUND_MELTS') {
    if (wssi.highestRank >= 3) {
      headline = `WPC WSSI: ${wssi.highestImpact}`;
    } else if (consensusAloftSnow72hIn >= 0.4) {
      headline = 'WET SNOW / WILL NOT STICK';
    } else if (consensusAloftSnow72hIn >= 0.05 || modelSpread.snowMaxIn >= 0.1) {
      headline = 'WET FLAKES / RAIN (0.0" ACCUM)';
    } else {
      headline = '72H MONITORING';
    }
  } else if (groundAccumStatus === 'GRASS_SLUSH_ONLY') {
    headline = `SLUSHY GRASS ONLY (~${grassSnow72hIn.toFixed(1)}")`;
  } else if (roadSnow72hIn >= 4.0) {
    headline = `WINTER STORM (${roadSnow72hIn.toFixed(1)}" Snow)`;
  } else if (finalIce72 >= 0.1) {
    headline = `FREEZING RAIN (${finalIce72.toFixed(2)}" Ice)`;
  } else if (roadSnow72hIn >= 0.5) {
    headline = `STICKING SNOW (${roadSnow72hIn.toFixed(1)}" Roads)`;
  } else if (hourlySlots.some((s) => s.pType === 'REFREEZE')) {
    headline = 'BLACK ICE REFREEZE';
  } else if (wssi.highestRank >= 3) {
    headline = `WPC WSSI: ${wssi.highestImpact}`;
  }

  let hazardLevel = 'CLEAR';
  let statusLabel = 'Clear / Above Freezing';
  let roadBridgeRiskLabel = 'Dry / Safe Road Surfaces';
  const winterAlerts = [];

  const isColdGround = ground0cmF != null && ground0cmF <= freezeThreshF;
  const isFreezingPrecip = wmo === 56 || wmo === 57 || wmo === 66 || wmo === 67 || (precipNow > 0 && (airF <= 32.0 || isColdGround));
  const isFreezingFog = wmo === 48 || (visMi <= 0.5 && airF <= 32);
  const isDenseFog = visMi <= 0.5 && airF > 32;
  const hasRefreezeSlot = hourlySlots.some((s) => s.pType === 'REFREEZE');
  const isStickingSnowAlert =
    groundAccumStatus !== 'WARM_GROUND_MELTS' &&
    groundAccumStatus !== 'GRASS_SLUSH_ONLY' &&
    (roadSnow72hIn >= 1.0 || grassSnow72hIn >= 2.0);

  if (isFreezingPrecip) {
    hazardLevel = 'CRITICAL';
    statusLabel = 'Black Ice / Freezing Rain';
    roadBridgeRiskLabel = 'Bridges & Overpasses Icing Rapidly';
    winterAlerts.push({
      id: 'winter_black_ice',
      title: 'Black Ice / Freezing Rain Hazard',
      summary: `Ground ${ground0cmF ?? '--'}°F (6cm: ${ground6cmF ?? '--'}°F) • Air ${airF}°F • Vis ${visMi} mi • ${roadBridgeRiskLabel}`,
      severity: 'high'
    });
  } else if (isFreezingFog) {
    hazardLevel = 'HIGH';
    statusLabel = 'Freezing Fog Danger';
    roadBridgeRiskLabel = 'Rime Ice & Slick Bridges Possible';
    winterAlerts.push({
      id: 'winter_freezing_fog',
      title: 'Freezing Fog Danger',
      summary: `Air ${airF}°F • Ground ${ground0cmF ?? '--'}°F • Visibility ${visMi} mi — black ice possible on elevated roads.`,
      severity: 'high'
    });
  } else if (finalIce72 >= 0.25) {
    hazardLevel = 'CRITICAL';
    statusLabel = `Damaging Ice Storm (${finalIce72.toFixed(2)}" Glaze)`;
    roadBridgeRiskLabel = iceRisk.detail;
    winterAlerts.push({
      id: 'winter_ice_glaze',
      title: `Ice Storm Glaze Threat (${finalIce72.toFixed(2)}")`,
      summary: `${changeoverLabel} • Peak: ${peakWindowLabel} • ${iceRisk.detail}`,
      severity: 'high'
    });
  } else if (isStickingSnowAlert) {
    hazardLevel = roadSnow72hIn >= 4.0 ? 'HIGH' : 'MODERATE';
    statusLabel = roadSnow72hIn >= 4.0
      ? `Winter Storm Snow (${roadSnow72hIn.toFixed(1)}" Roads)`
      : `Accumulating Snow (${roadSnow72hIn.toFixed(1)}" Roads / ${grassSnow72hIn.toFixed(1)}" Grass)`;
    roadBridgeRiskLabel = groundAccumStatus === 'COLD_GROUND_STICKS'
      ? 'Snow Sticking Immediately to Pavement'
      : 'Slushy Accumulation on Roads & Bridges';
    winterAlerts.push({
      id: 'winter_snow',
      title: 'Accumulating Snow Expected',
      summary: `${roadSnow72hIn.toFixed(1)}" road / ${grassSnow72hIn.toFixed(1)}" grass sticking (${finalSnow72.toFixed(1)}" consensus aloft) • Ground 0cm: ${g0Str}.`,
      severity: roadSnow72hIn >= 4.0 ? 'high' : 'mod'
    });
  } else if (finalIce72 >= 0.1 || wssi.highestRank >= 4) {
    hazardLevel = 'HIGH';
    statusLabel = finalIce72 >= 0.1 ? `Freezing Rain Glaze (${finalIce72.toFixed(2)}")` : `WPC WSSI ${wssi.highestImpact} Impact`;
    roadBridgeRiskLabel = finalIce72 >= 0.1 ? iceRisk.detail : `WSSI Overall: ${wssi.overall}`;
    winterAlerts.push({
      id: 'winter_pro_advisory',
      title: headline,
      summary: `${changeoverLabel} • ${refreezeLabel} • Models: ${modelSpread.agreementLabel}`,
      severity: 'high'
    });
  } else if (isDenseFog) {
    hazardLevel = 'ADVISORY';
    statusLabel = 'Dense Fog Advisory';
    roadBridgeRiskLabel = `Low Visibility (${visMi} mi)`;
    winterAlerts.push({
      id: 'winter_dense_fog',
      title: 'Dense Fog Advisory',
      summary: `Visibility reduced to ${visMi} mi • Air ${airF}°F.`,
      severity: 'mod'
    });
  } else if ((minTemp24h != null && minTemp24h <= 28) || (isColdGround && airF <= 34) || hasRefreezeSlot || finalIce72 >= 0.01) {
    hazardLevel = 'ADVISORY';
    if (finalIce72 >= 0.01) {
      statusLabel = `Light Glaze / Icing (${finalIce72.toFixed(2)}")`;
      roadBridgeRiskLabel = 'Elevated Surfaces & Bridges Slick';
    } else if (hasRefreezeSlot) {
      statusLabel = refreezeLabel;
      roadBridgeRiskLabel = 'Wet Roads Refreezing After Sunset';
      winterAlerts.push({
        id: 'winter_refreeze',
        title: 'Black-Ice Refreeze Hazard',
        summary: `${refreezeLabel} • Wet roads refreezing after sunset — bridges & overpasses slick.`,
        severity: 'high'
      });
    } else {
      statusLabel = (minTemp24h != null && minTemp24h <= 28) ? `Hard Freeze (${minTemp24h}°F)` : 'Frost / Near-Freezing Surface';
      roadBridgeRiskLabel = 'Watch Shaded Bridges for Patchy Frost';
    }
  }

  if (
    (groundAccumStatus === 'WARM_GROUND_MELTS' || groundAccumStatus === 'GRASS_SLUSH_ONLY') &&
    (hazardLevel === 'CLEAR' || (hazardLevel === 'ADVISORY' && !isDenseFog && !hasRefreezeSlot && finalIce72 < 0.01 && !(minTemp24h != null && minTemp24h <= 28)))
  ) {
    roadBridgeRiskLabel = groundAccumNote;
  } else if (groundAccumStatus === 'MARGINAL_SLUSHY' && hazardLevel === 'CLEAR') {
    roadBridgeRiskLabel = groundAccumNote;
  }

  return {
    hazardLevel,
    statusLabel,
    roadBridgeRiskLabel,
    ground0cmF,
    ground6cmF,
    freezingLevelFt,
    hoursBelowFreezingNext24h,
    minTemp24h,
    snow24hIn: roadSnow24hIn,
    fallingSnow24hIn: consensusAloftSnow24hIn,
    visibilityMi: visMi,
    winterAlerts,
    proWinter: {
      thermalProfile,
      hourlySlots,
      snow24hIn: finalSnow24,
      snow72hIn: finalSnow72,
      consensusAloftSnow24hIn,
      consensusAloftSnow72hIn,
      fallingSnow24hIn: finalSnow24,
      fallingSnow72hIn: finalSnow72,
      grassSnow24hIn,
      grassSnow72hIn,
      roadSnow24hIn,
      roadSnow72hIn,
      groundAccumStatus,
      groundAccumNote,
      minSoil0cmWintryF,
      minSoil6cmWintryF,
      minWetBulbWintryF,
      rainDuringSnowIn: Number(rainDuringSnowIn.toFixed(2)),
      peakSolarDuringSnowWm2: Math.round(peakSolarDuringSnowWm2),
      hasNwsGrid,
      nwsSnow72hIn: Number(nwsGrid.snow72hIn.toFixed(1)),
      maxSnowDepthIn: Number(maxSnowDepthIn.toFixed(1)),
      slrLabel,
      ice24hIn: finalIce24,
      ice72hIn: finalIce72,
      nwsIce72hIn: Number(nwsGrid.ice72hIn.toFixed(2)),
      minTemp72hF,
      minWindChill72hF,
      hoursSubFreeze72h,
      iceRiskTier: iceRisk.tier,
      iceRiskLabel: iceRisk.label,
      iceRiskColor: iceRisk.color,
      iceRiskDetail,
      changeoverLabel,
      peakWindowLabel,
      refreezeLabel,
      thawLabel,
      headline,
      modelSpread,
      wssi
    }
  };
}

const TDWR_SITES = new Set([
  'MEM', 'BNA', 'ATL', 'DFW', 'DAL', 'HOU', 'IAH', 'MCI', 'MSP', 'ORD', 'MDW',
  'STL', 'CLT', 'RDU', 'MIA', 'FLL', 'MCO', 'TPA', 'DEN', 'SLC', 'PHX', 'LAS',
  'EWR', 'JFK', 'PHL', 'BWI', 'DCA', 'IAD', 'BOS', 'DTW', 'CVG', 'CMH', 'CLE',
  'IND', 'MKE', 'PIT', 'MSY', 'OKC', 'TUL', 'ICT', 'SDF', 'DAY', 'PBI', 'SJU'
]);

function parseMesoRank(rawMeso) {
  const s = String(rawMeso || '').trim().toUpperCase();
  if (!s || s === 'NONE' || s === '0' || s === 'NULL' || s === 'UNC' || s === 'NA') return 0;
  const num = parseInt(s, 10);
  if (!Number.isNaN(num)) return Math.max(0, Math.min(20, num));
  if (s.includes('SIG') || s.includes('STRONG') || s.includes('3D') || s.includes('MESO')) return 4;
  return 0;
}

/**
 * NEXRAD Storm Cell Threat & Time-on-Target (TOT) Intercept Engine
 * Verified against IEM nexrad_attr.geojson:
 * - `drct` is meteorological FROM direction; moving-TO bearing = (drct + 180) % 360.
 * - Rejects shallow non-convective showers/clutter (e.g. MDA shear on 4.6 kft / VIL 2 rain).
 * - Spatially deduplicates overlapping radar detections within 8 miles into one confirmed cell.
 */
export function analyzeStormCells(stormCellsGeoJson, userLat, userLon, maxRadiusMi = 120, nowMs = Date.now()) {
  if (!isValidLatLon(userLat, userLon)) return [];
  const refMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const features = stormCellsGeoJson?.features || [];
  const candidates = [];

  for (const f of features) {
    const coords = f?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const [lon, lat] = coords;
    if (!isValidLatLon(lat, lon)) continue;
    const dist = haversineMiles(userLat, userLon, lat, lon);
    if (!Number.isFinite(dist) || dist > maxRadiusMi) continue;

    const p = f.properties || {};
    if (p.valid) {
      const validMs = parseAlertTimestampMs(p.valid);
      if (validMs != null) {
        const ageMin = (refMs - validMs) / 60000;
        if (ageMin > 25) continue;
      }
    }

    const nexrad = String(p.nexrad || 'NEXRAD').trim().toUpperCase();
    const isTdwr = TDWR_SITES.has(nexrad);
    const radarRangeKm = parseFloat(p.range || '0') || 0;
    const radarRangeMi = radarRangeKm > 0 ? Number(kmhToMph(radarRangeKm).toFixed(0)) : null;

    const rawTvs = String(p.tvs || '').trim().toUpperCase();
    const rawMeso = String(p.meso || '').trim().toUpperCase();
    const mesoRank = parseMesoRank(rawMeso);
    const maxSizeIn = parseFloat(p.max_size || '0') || 0;
    const poh = parseFloat(p.poh || '0') || 0;
    const posh = parseFloat(p.posh || '0') || 0;
    const vil = parseFloat(p.vil || '0') || 0;
    const topKft = parseFloat(p.top || '0') || 0;
    const maxDbz = parseFloat(p.max_dbz || '0') || 0;
    const maxDbzHeightKft = parseFloat(p.max_dbz_height || '0') || 0;

    // 1. Reject shallow rain showers, ground clutter & bird/chaff artifacts outright
    if (topKft < 14 && vil < 8 && maxDbz < 52 && maxSizeIn < 0.5) continue;

    const hasRawTvs = rawTvs === 'TVS' || rawTvs === 'ETVS';
    const hasRawMeso = mesoRank > 0;
    const hasDeepConvection = topKft >= 20 && (vil >= 15 || maxDbz >= 55 || maxSizeIn >= 0.75);
    const tdwrConvectiveOk = !isTdwr || (maxDbz >= 58 && vil >= 15);

    let threatLevel = 'STRONG';
    let threatScore = 1;
    let color = '#facc15';
    let verifiedTvs = null;
    let verifiedMeso = null;
    let mesoFiltered = false;

    if (hasRawTvs && (topKft >= 18 || vil >= 12 || maxDbz >= 52) && tdwrConvectiveOk) {
      threatLevel = 'TORNADO_TVS';
      threatScore = 4;
      color = '#ff2b4a';
      verifiedTvs = rawTvs;
      if (hasRawMeso && hasDeepConvection) verifiedMeso = rawMeso;
    } else if (
      tdwrConvectiveOk &&
      (
        (hasRawMeso && mesoRank >= 3 && hasDeepConvection) ||
        (hasRawMeso && mesoRank >= 2 && topKft >= 22 && vil >= 20 && maxDbz >= 58) ||
        (maxSizeIn >= 1.5 && topKft >= 22 && vil >= 25)
      )
    ) {
      threatLevel = 'SUPERCELL';
      threatScore = 3;
      color = '#d946ef';
      verifiedMeso = hasRawMeso ? rawMeso : null;
    } else if (
      (maxSizeIn >= 0.75 && topKft >= 18) ||
      (posh >= 50 && vil >= 20) ||
      (vil >= 35 && maxDbz >= 58) ||
      (topKft >= 38 && maxDbz >= 55)
    ) {
      threatLevel = 'SEVERE';
      threatScore = 2;
      color = '#ff7a18';
      if (hasRawMeso) mesoFiltered = true;
    } else {
      // Only retain genuinely convective non-severe storms within 55 mi
      if (dist > 55 || topKft < 18 || maxDbz < 50 || vil < 10) continue;
      threatLevel = 'STRONG';
      threatScore = 1;
      color = '#facc15';
      if (hasRawMeso) mesoFiltered = true;
    }

    // 2. Verified Storm Motion (IEM drct = meteorological FROM -> moveTo = (drct + 180) % 360)
    const speedKtRaw = parseFloat(p.sknt || '0') || 0;
    const speedMphRaw = Math.round(ktToMph(speedKtRaw) ?? 0);
    const drctFromRaw = p.drct != null && p.drct !== '' ? parseFloat(p.drct) : null;
    const motionUnreliable =
      speedKtRaw <= 0 ||
      drctFromRaw == null ||
      Number.isNaN(drctFromRaw) ||
      speedMphRaw > 95 ||
      (speedMphRaw > 80 && (topKft < 20 || vil < 10));

    const speedMph = motionUnreliable ? 0 : speedMphRaw;
    const moveFromBearing = motionUnreliable ? null : Math.round(((drctFromRaw % 360) + 360) % 360);
    const moveToBearing = motionUnreliable ? null : Math.round((moveFromBearing + 180) % 360);
    const moveToCompass = moveToBearing != null ? degToCompass(moveToBearing) : '--';
    const moveFromCompass = moveFromBearing != null ? degToCompass(moveFromBearing) : '--';
    const motionSummary = speedMph >= 3 && moveToBearing != null
      ? `Moving ${moveToCompass} (${String(moveToBearing).padStart(3, '0')}°) @ ${speedMph} mph · from ${moveFromCompass}`
      : 'Stationary / Slow-Moving';

    const intercept = computeStormIntercept(userLat, userLon, lat, lon, moveToBearing, speedMph);
    const coneCoords = buildThreatConePolygon(lat, lon, moveToBearing, speedMph, 45);
    const vectorLine = buildMotionVectorLine(lat, lon, moveToBearing, speedMph, 45);

    const obsQualityScore =
      (!isTdwr ? 500 : 0) +
      threatScore * 120 -
      Math.min(radarRangeKm || 120, 320) * 0.8 +
      vil * 1.5 +
      maxDbz;

    candidates.push({
      id: `${nexrad}_${p.storm_id || 'X'}`,
      nexrad,
      isTdwr,
      stormId: p.storm_id || 'CELL',
      valid: p.valid || null,
      lat,
      lon,
      radarRangeKm,
      radarRangeMi,
      tvs: verifiedTvs,
      meso: verifiedMeso,
      mesoRank,
      mesoFiltered,
      maxHailIn: maxSizeIn,
      maxDbz,
      maxDbzHeightKft,
      vil,
      poh,
      posh,
      topKft,
      speedMph,
      moveFromBearing,
      moveFromCompass,
      moveToBearing,
      moveToCompass,
      motionUnreliable,
      motionSummary,
      threatLevel,
      threatScore,
      color,
      intercept,
      coneCoords,
      vectorLine,
      confirmingRadars: [nexrad],
      obsQualityScore
    });
  }

  // 3. Spatial Multi-Radar Deduplication (merge overlapping radar observations within 8 miles)
  candidates.sort((a, b) => b.obsQualityScore - a.obsQualityScore);
  const clustered = [];

  for (const cand of candidates) {
    const host = clustered.find((existing) => haversineMiles(existing.lat, existing.lon, cand.lat, cand.lon) <= 8);
    if (!host) {
      clustered.push({ ...cand, confirmingRadars: [...cand.confirmingRadars] });
      continue;
    }

    if (!host.confirmingRadars.includes(cand.nexrad)) {
      host.confirmingRadars.push(cand.nexrad);
      host.confirmingRadars.sort();
    }

    // Merge verified maxima from non-TDWR WSR-88D confirmations (never degrade host primary coords/motion)
    if (!cand.isTdwr) {
      host.maxHailIn = Math.max(host.maxHailIn, cand.maxHailIn);
      host.vil = Math.max(host.vil, cand.vil);
      host.maxDbz = Math.max(host.maxDbz, cand.maxDbz);
      host.topKft = Math.max(host.topKft, cand.topKft);
      host.posh = Math.max(host.posh, cand.posh);
      host.poh = Math.max(host.poh, cand.poh);
      if (cand.threatScore > host.threatScore) {
        host.threatScore = cand.threatScore;
        host.threatLevel = cand.threatLevel;
        host.color = cand.color;
        if (cand.tvs) host.tvs = cand.tvs;
        if (cand.meso) host.meso = cand.meso;
      }
    }
  }

  clustered.sort((a, b) => {
    const aDirect = a.intercept.verdict === 'DIRECT_INTERCEPT' ? 14 : a.intercept.verdict === 'NEAR_MISS' ? 7 : 0;
    const bDirect = b.intercept.verdict === 'DIRECT_INTERCEPT' ? 14 : b.intercept.verdict === 'NEAR_MISS' ? 7 : 0;
    return (b.threatScore * 5 + bDirect - b.intercept.distanceMi * 0.05) - (a.threatScore * 5 + aDirect - a.intercept.distanceMi * 0.05);
  });

  return clustered.slice(0, 35);
}

/**
 * Parse NWS CAP eventMotionDescription (e.g. "2026-11-22T20:55:00-00:00...storm...250DEG...35KT")
 * where direction is meteorological FROM, converting to TOWARD motion.
 */
function parseNwsEventMotion(rawMotion) {
  const str = Array.isArray(rawMotion) ? rawMotion[0] : rawMotion;
  if (!str) return null;
  const m = String(str).match(/(\d{1,3})\s*DEG\.{2,3}(\d{1,3})\s*KT/i);
  if (!m) return null;
  const fromDeg = ((parseInt(m[1], 10) % 360) + 360) % 360;
  const speedKt = parseInt(m[2], 10);
  if (Number.isNaN(fromDeg) || Number.isNaN(speedKt)) return null;
  const moveToBearing = (fromDeg + 180) % 360;
  const speedMph = Math.round(ktToMph(speedKt) ?? 0);
  const moveToCompass = degToCompass(moveToBearing);
  const moveFromCompass = degToCompass(fromDeg);
  return {
    moveToBearing,
    moveToCompass,
    moveFromBearing: fromDeg,
    moveFromCompass,
    speedMph,
    summary: speedMph > 0
      ? `Moving ${moveToCompass} (${String(moveToBearing).padStart(3, '0')}°) @ ${speedMph} mph · from ${moveFromCompass}`
      : 'Nearly stationary'
  };
}

function parseAlertTimestampMs(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (raw instanceof Date) {
    const ms = raw.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  // Naive ISO timestamps without timezone suffix are treated strictly as UTC to prevent local-TZ drift
  const normalized = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)
    ? `${s.replace(' ', 'T')}Z`
    : s;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

export function canonicalAlertId(rawId) {
  if (rawId === null || rawId === undefined) return '';
  let s = String(rawId).trim();
  if (!s) return '';
  const alertsPathIdx = s.toLowerCase().lastIndexOf('/alerts/');
  if (alertsPathIdx >= 0) {
    s = s.slice(alertsPathIdx + '/alerts/'.length);
  }
  return s.trim().toLowerCase();
}

function extractAlertIdVariants(featureOrAlert) {
  const variants = new Set();
  if (!featureOrAlert || typeof featureOrAlert !== 'object') return variants;
  const p = featureOrAlert.properties || featureOrAlert;
  const candidates = [
    featureOrAlert.id,
    featureOrAlert.canonicalId,
    featureOrAlert.identifier,
    featureOrAlert.atId,
    p['@id'],
    p.id,
    p.identifier
  ];
  for (const c of candidates) {
    if (!c) continue;
    const raw = String(c).trim().toLowerCase();
    if (raw) variants.add(raw);
    const canon = canonicalAlertId(c);
    if (canon) variants.add(canon);
  }
  return variants;
}

function extractReferencedIds(featureOrAlert) {
  const refs = new Set();
  if (!featureOrAlert || typeof featureOrAlert !== 'object') return [];
  const p = featureOrAlert.properties || featureOrAlert;
  const rawRefs = p.references ?? featureOrAlert.references;

  const addToken = (tok) => {
    if (!tok) return;
    const s = String(tok).trim();
    if (!s) return;
    // CAP space-delimited reference format: "sender,identifier,sent"
    if (s.includes(',')) {
      const parts = s.split(',');
      if (parts[1]) {
        const c = canonicalAlertId(parts[1]);
        if (c) refs.add(c);
      }
      return;
    }
    const rawLow = s.toLowerCase();
    refs.add(rawLow);
    const canon = canonicalAlertId(s);
    if (canon) refs.add(canon);
  };

  if (Array.isArray(rawRefs)) {
    for (const r of rawRefs) {
      if (!r) continue;
      if (typeof r === 'string') {
        for (const piece of r.trim().split(/\s+/)) addToken(piece);
      } else if (typeof r === 'object') {
        addToken(r.identifier);
        addToken(r['@id']);
        addToken(r.id);
      }
    }
  } else if (typeof rawRefs === 'string') {
    for (const piece of rawRefs.trim().split(/\s+/)) addToken(piece);
  }

  return Array.from(refs);
}

/**
 * Determines whether an NWS GeoJSON alert feature or classified alert is expired, cancelled,
 * or explicitly superseded via `replacedBy` at `nowMs`.
 */
export function isAlertExpired(featureOrAlert, nowMs = Date.now()) {
  if (!featureOrAlert || typeof featureOrAlert !== 'object') return true;
  const refMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const p = featureOrAlert.properties || featureOrAlert;

  const status = String(p.status ?? featureOrAlert.status ?? '').trim().toLowerCase();
  if (status === 'cancel' || status === 'cancelled' || status === 'canceled' || status === 'expired') {
    return true;
  }

  const messageType = String(p.messageType ?? featureOrAlert.messageType ?? '').trim().toLowerCase();
  if (messageType === 'cancel') {
    return true;
  }

  const replacedBy = p.replacedBy ?? featureOrAlert.replacedBy;
  if (typeof replacedBy === 'string' && replacedBy.trim().length > 0) {
    const replacedAtMs = parseAlertTimestampMs(p.replacedAt ?? featureOrAlert.replacedAt);
    if (replacedAtMs == null || replacedAtMs <= refMs) {
      return true;
    }
  }

  const expiresMs = Number.isFinite(featureOrAlert.expiresMs)
    ? featureOrAlert.expiresMs
    : parseAlertTimestampMs(p.expires ?? featureOrAlert.expires);
  if (expiresMs != null && expiresMs <= refMs) {
    return true;
  }

  const endsMs = Number.isFinite(featureOrAlert.endsMs)
    ? featureOrAlert.endsMs
    : parseAlertTimestampMs(p.ends ?? featureOrAlert.ends);
  if (endsMs != null && endsMs <= refMs) {
    return true;
  }

  return false;
}

/**
 * Classify NWS Alert into Borden Tempest Severe Tiers with Point-in-Polygon & PDS/Observed Detection
 */
export function classifyNwsAlert(feature, userLat = null, userLon = null, nowMs = Date.now()) {
  const refMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const p = feature?.properties || {};
  const ev = (p.event || '').toLowerCase();
  const params = p.parameters || {};
  const tornadoDetection = params.tornadoDetection?.[0] || null;
  const tornadoDamageThreat = params.tornadoDamageThreat?.[0] || null;
  const thunderstormDamageThreat = params.thunderstormDamageThreat?.[0] || null;
  const flashFloodDamageThreat = params.flashFloodDamageThreat?.[0] || null;
  const maxWindGust = params.maxWindGust?.[0] || null;
  const maxHailSize = params.maxHailSize?.[0] || null;
  const stormMotion = parseNwsEventMotion(params.eventMotionDescription);

  const isTornadoEmergency = (tornadoDamageThreat || '').toUpperCase() === 'CATASTROPHIC' ||
    (p.headline || '').toLowerCase().includes('tornado emergency') ||
    (p.description || '').toLowerCase().includes('tornado emergency');

  const isPdsOrObserved = isTornadoEmergency ||
    (tornadoDetection || '').toUpperCase() === 'OBSERVED' ||
    (tornadoDamageThreat || '').toUpperCase() === 'CONSIDERABLE' ||
    (p.description || '').toLowerCase().includes('particularly dangerous situation');

  const isDestructiveSevere = (thunderstormDamageThreat || '').toUpperCase() === 'DESTRUCTIVE' ||
    (thunderstormDamageThreat || '').toUpperCase() === 'CONSIDERABLE';

  const isFlashFloodEmergency = (flashFloodDamageThreat || '').toUpperCase() === 'CATASTROPHIC' ||
    (p.headline || '').toLowerCase().includes('flash flood emergency');

  const sentMs = parseAlertTimestampMs(p.sent);
  const effectiveMs = parseAlertTimestampMs(p.effective || p.onset);
  const expiresMs = parseAlertTimestampMs(p.expires);
  const endsMs = parseAlertTimestampMs(p.ends);
  const expiresIso = p.expires || p.ends || null;
  const references = extractReferencedIds(feature);
  const rawId = feature?.id || p.id || p['@id'] || `${p.event || 'Alert'}_${p.sent || ''}`;
  const canonicalId = canonicalAlertId(rawId) || String(rawId).toLowerCase();

  const isExpired = isAlertExpired(feature, refMs);

  const insidePolygon = (userLat != null && userLon != null && feature?.geometry)
    ? isPointInGeometry(userLat, userLon, feature.geometry)
    : null;

  let tier = 'ADVISORY';
  let color = '#00d4ff';
  let rank = 1;

  if (ev.includes('tornado warning') || isFlashFloodEmergency || ev.includes('extreme wind warning')) {
    tier = 'CRITICAL';
    color = '#ff2b4a';
    rank = isTornadoEmergency ? 7 : isPdsOrObserved ? 6 : 5;
  } else if (ev.includes('severe thunderstorm warning') || ev.includes('flash flood warning') || ev.includes('snow squall warning')) {
    tier = 'SEVERE';
    color = isDestructiveSevere ? '#ff4444' : '#ff9800';
    rank = isDestructiveSevere ? 4.5 : 4;
  } else if (ev.includes('tornado watch') || ev.includes('severe thunderstorm watch')) {
    tier = 'WATCH';
    color = '#facc15';
    rank = ev.includes('tornado watch') ? 3.5 : 3;
  } else if (ev.includes('winter') || ev.includes('ice storm') || ev.includes('blizzard') || ev.includes('freeze') || ev.includes('snow') || ev.includes('fog')) {
    tier = 'WINTER';
    color = '#56ccf2';
    rank = 2;
  }

  const escalationFingerprint = [
    tier,
    tornadoDetection || '',
    tornadoDamageThreat || '',
    thunderstormDamageThreat || '',
    flashFloodDamageThreat || '',
    isTornadoEmergency ? 'TE' : ''
  ].join('|');

  return {
    id: rawId,
    canonicalId,
    identifier: p.id || feature?.id || p['@id'] || null,
    atId: p['@id'] || feature?.id || null,
    status: p.status || 'Actual',
    messageType: p.messageType || 'Alert',
    references,
    replacedBy: p.replacedBy || null,
    replacedAt: p.replacedAt || null,
    escalationFingerprint,
    event: p.event || 'Weather Alert',
    headline: p.headline || p.event || '',
    description: p.description || '',
    instruction: p.instruction || '',
    areaDesc: p.areaDesc || '',
    senderName: p.senderName || 'NWS',
    sent: p.sent || null,
    effective: p.effective || null,
    expires: expiresIso,
    ends: p.ends || null,
    sentMs,
    effectiveMs,
    expiresMs,
    endsMs,
    isExpired,
    insidePolygon,
    severity: p.severity || 'Unknown',
    urgency: p.urgency || 'Unknown',
    tornadoDetection,
    tornadoDamageThreat,
    thunderstormDamageThreat,
    isTornadoEmergency,
    isPdsOrObserved,
    isDestructiveSevere,
    isFlashFloodEmergency,
    maxWindGust,
    maxHailSize,
    stormMotion,
    tier,
    color,
    rank,
    geometry: feature?.geometry || null
  };
}

/**
 * Classifies (if raw GeoJSON), purges expired/cancelled/superseded NWS alerts,
 * deduplicates by canonical ID, and sorts by severity rank & polygon containment.
 */
export function filterAndDeduplicateAlerts(features, userLat = null, userLon = null, nowMs = Date.now()) {
  if (!Array.isArray(features) || features.length === 0) return [];
  const refMs = Number.isFinite(nowMs) ? nowMs : Date.now();

  // Pass 1: collect all superseded IDs across ALL alerts (including Cancel & Update messages)
  const supersededIds = new Set();
  for (const item of features) {
    if (!item || typeof item !== 'object') continue;
    const selfVariants = extractAlertIdVariants(item);
    const refs = extractReferencedIds(item);
    for (const refId of refs) {
      if (refId && !selfVariants.has(refId)) {
        supersededIds.add(refId);
      }
    }
    const p = item.properties || item;
    if (typeof p.replacedBy === 'string' && p.replacedBy.trim().length > 0) {
      const replacedAtMs = parseAlertTimestampMs(p.replacedAt ?? item.replacedAt);
      if (replacedAtMs == null || replacedAtMs <= refMs) {
        for (const v of selfVariants) supersededIds.add(v);
      }
    }
  }

  // Pass 2: classify/refresh, drop expired/cancelled/superseded, and deduplicate by canonical ID
  const byCanon = new Map();
  for (const item of features) {
    if (!item || typeof item !== 'object') continue;
    const isRawFeature = Boolean(item.properties) || item.tier === undefined;
    const alert = isRawFeature
      ? classifyNwsAlert(item, userLat, userLon, refMs)
      : {
        ...item,
        canonicalId: item.canonicalId || canonicalAlertId(item.id || item.identifier || item.atId),
        isExpired: isAlertExpired(item, refMs),
        insidePolygon: (userLat != null && userLon != null && item.geometry)
          ? isPointInGeometry(userLat, userLon, item.geometry)
          : item.insidePolygon ?? null
      };

    if (alert.isExpired) continue;

    const idVariants = extractAlertIdVariants(alert);
    let isSuperseded = false;
    for (const v of idVariants) {
      if (supersededIds.has(v)) {
        isSuperseded = true;
        break;
      }
    }
    if (isSuperseded) continue;

    const dedupKey = alert.canonicalId || canonicalAlertId(alert.id) || `${alert.event}_${alert.sentMs ?? ''}`;
    const existing = byCanon.get(dedupKey);
    if (!existing) {
      byCanon.set(dedupKey, alert);
    } else {
      const existingSent = existing.sentMs ?? -Infinity;
      const candSent = alert.sentMs ?? -Infinity;
      const preferCand =
        candSent > existingSent ||
        (candSent === existingSent && alert.rank > existing.rank) ||
        (candSent === existingSent && alert.rank === existing.rank && !existing.geometry && Boolean(alert.geometry)) ||
        (candSent === existingSent && alert.rank === existing.rank && existing.insidePolygon !== true && alert.insidePolygon === true);
      if (preferCand) {
        byCanon.set(dedupKey, alert);
      }
    }
  }

  return Array.from(byCanon.values()).sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    const aIn = a.insidePolygon === true ? 1 : 0;
    const bIn = b.insidePolygon === true ? 1 : 0;
    if (bIn !== aIn) return bIn - aIn;
    return (b.sentMs ?? 0) - (a.sentMs ?? 0);
  });
}
