import {
  angularDiffDeg,
  buildMotionVectorLine,
  buildThreatConePolygon,
  computeStormIntercept,
  degToCompass,
  haversineMiles,
  isPointInGeometry,
  isValidLatLon
} from './geoMath.js';
import {
  DEFAULT_TIME_ZONE,
  getCentralHour24,
  parseUtcTimestampMs
} from './weatherApi.js';

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

/**
 * Multi-station NWS ASOS/AWOS + NDFD/NBM + Open-Meteo (HRRR/GFS) Accuracy Consensus Resolver
 */
export function resolveCurrentConditions(nwsBundle, openMeteo, nowMs = Date.now()) {
  const cur = openMeteo?.current || {};
  const curUnits = openMeteo?.current_units || {};
  const hourly = openMeteo?.hourly || {};
  const hourlyUnits = openMeteo?.hourly_units || {};
  const refMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const idx = findCurrentHourIndex(hourly, refMs, openMeteo?.utc_offset_seconds ?? 0);

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
 * True Upper-Air Convective, Supercell, HSLC & Dixie Alley Nocturnal Readiness Analyzer
 * Uses real 10m -> 850 hPa (~0-1.5km) and 10m -> 500 hPa (~0-6km) vector wind shear from NOAA HRRR/GFS.
 */
export function analyzeEnvironment(openMeteo, current = {}, mcdCount = 0, options = {}) {
  const safeCurrent = current || {};
  const thresholdMode = options.convectiveAlertThreshold || 'STANDARD'; // SENSITIVE | STANDARD | HIGH_ONLY
  const nocturnalEnabled = options.nocturnalReadinessEnabled !== false;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();

  const hourly = openMeteo?.hourly || {};
  const hourlyUnits = openMeteo?.hourly_units || {};
  const windUnit = hourlyUnits.wind_speed_10m || hourlyUnits.wind_speed_500hPa || 'mp/h';
  const tempUnit = hourlyUnits.temperature_2m || '°F';
  const upperTempUnit = hourlyUnits.temperature_700hPa || tempUnit;
  const idx = findCurrentHourIndex(hourly, nowMs, openMeteo?.utc_offset_seconds ?? 0);

  const calcAt = (i) => {
    const cape = Math.max(0, toFiniteNumber(hourly.cape?.[i]) ?? 0);
    const cin = toFiniteNumber(hourly.convective_inhibition?.[i]) ?? 0;
    const tempF = convertTempToF(hourly.temperature_2m?.[i], tempUnit) ?? toFiniteNumber(safeCurrent.tempF) ?? 65;
    const dewF = convertTempToF(hourly.dew_point_2m?.[i], hourlyUnits.dew_point_2m || tempUnit) ?? toFiniteNumber(safeCurrent.dewpointF) ?? 50;

    const w10 = Math.max(0, convertWindToKt(hourly.wind_speed_10m?.[i], hourlyUnits.wind_speed_10m || windUnit)
      ?? mphToKt(toFiniteNumber(safeCurrent.windMph) ?? 0)
      ?? 0);
    const d10 = toFiniteNumber(hourly.wind_direction_10m?.[i]) ?? toFiniteNumber(safeCurrent.windDirDeg) ?? 0;

    const w850 = Math.max(0, convertWindToKt(hourly.wind_speed_850hPa?.[i], hourlyUnits.wind_speed_850hPa || windUnit) ?? w10);
    const d850 = toFiniteNumber(hourly.wind_direction_850hPa?.[i]) ?? d10;

    const w500 = Math.max(0, convertWindToKt(hourly.wind_speed_500hPa?.[i], hourlyUnits.wind_speed_500hPa || windUnit) ?? w850);
    const d500 = toFiniteNumber(hourly.wind_direction_500hPa?.[i]) ?? d850;

    const [u0, v0] = windComponentsKt(w10, d10);
    const [u850, v850] = windComponentsKt(w850, d850);
    const [u500, v500] = windComponentsKt(w500, d500);

    const w925Val = convertWindToKt(hourly.wind_speed_925hPa?.[i], hourlyUnits.wind_speed_925hPa || windUnit);
    const d925Val = toFiniteNumber(hourly.wind_direction_925hPa?.[i]);
    const [u925, v925] = (w925Val != null && d925Val != null)
      ? windComponentsKt(Math.max(0, w925Val), d925Val)
      : [(u0 + u850) * 0.5, (v0 + v850) * 0.5];

    const w700Val = convertWindToKt(hourly.wind_speed_700hPa?.[i], hourlyUnits.wind_speed_700hPa || windUnit);
    const d700Val = toFiniteNumber(hourly.wind_direction_700hPa?.[i]);
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

    // Espy LCL height (m) & 700-500 hPa lapse rate (°C/km)
    const tempC = fToC(tempF) ?? 18.3;
    const dewC = fToC(dewF) ?? 10.0;
    const lclMeters = Math.max(50, Math.min(5000, Math.round(125 * Math.max(0, tempC - dewC))));

    const t700Raw = toFiniteNumber(hourly.temperature_700hPa?.[i]);
    const t500Raw = toFiniteNumber(hourly.temperature_500hPa?.[i]);
    const h700 = toFiniteNumber(hourly.geopotential_height_700hPa?.[i]);
    const h500 = toFiniteNumber(hourly.geopotential_height_500hPa?.[i]);
    let lapseRate700to500 = 5.8;
    if (t700Raw != null && t500Raw != null && h700 != null && h500 != null && (h500 - h700) > 500) {
      const t700C = normalizeUnitCode(upperTempUnit).includes('c') ? t700Raw : fToC(t700Raw);
      const t500C = normalizeUnitCode(upperTempUnit).includes('c') ? t500Raw : fToC(t500Raw);
      const lr = (t700C - t500C) / ((h500 - h700) / 1000);
      if (Number.isFinite(lr)) {
        lapseRate700to500 = Math.round(Math.max(-5, Math.min(15, lr)) * 10) / 10;
      }
    }

    // Official SPC Fixed-Layer Significant Tornado Parameter (STP) & Supercell Composite Parameter (SCP)
    const bulkShearMs = deepShearKt * KT_TO_MS;
    const lclTerm = lclMeters > 2000 ? 0 : lclMeters < 1000 ? 1 : (2000 - lclMeters) / 1000;
    const stpShearTerm = bulkShearMs < 12.5 ? 0 : bulkShearMs > 30 ? 1.5 : bulkShearMs / 20;
    const scpShearTerm = bulkShearMs < 10 ? 0 : Math.min(1.0, bulkShearMs / 20);
    const cinAbs = Math.abs(cin);
    const cinTerm = cinAbs >= 200 ? 0 : cinAbs <= 50 ? 1 : (200 - cinAbs) / 150;
    const stp = Math.round(Math.min(12, Math.max(0, (cape / 1500) * lclTerm * (srh0to1 / 150) * stpShearTerm * cinTerm)) * 10) / 10;
    const scp = Math.round(Math.min(25, Math.max(0, (cape / 1000) * (srh0to3 / 50) * scpShearTerm)) * 10) / 10;

    return {
      cape, cin, lowShearKt, deepShearKt, veer850,
      srh0to1, srh0to3, lclMeters, lapseRate700to500, stp, scp,
      bunkersHeadingDeg, bunkersSpeedKt, hodographPoints
    };
  };

  const nowSample = calcAt(idx);
  const window12 = [];
  for (let i = idx; i < Math.min(idx + 12, (hourly.time || []).length); i++) {
    window12.push(calcAt(i));
  }

  const peakCape12h = window12.length ? Math.max(...window12.map((s) => s.cape)) : nowSample.cape;
  const peakLowLevelShearKt = Math.round(window12.length ? Math.max(...window12.map((s) => s.lowShearKt)) : nowSample.lowShearKt);
  const peakBulkShearKt = Math.round(window12.length ? Math.max(...window12.map((s) => s.deepShearKt)) : nowSample.deepShearKt);

  const lowLevelShearKt = Math.round(nowSample.lowShearKt);
  const bulkShear0to6KmKt = Math.round(nowSample.deepShearKt);
  const veeringDeg = Math.round(nowSample.veer850);
  const cinNow = Math.round(nowSample.cin);

  const dewF = toFiniteNumber(safeCurrent.dewpointF) ?? 45;
  const pTrend = toFiniteNumber(safeCurrent.pressureTrend3h) ?? 0;
  const activeMcdCount = Math.max(0, Math.floor(toFiniteNumber(mcdCount) ?? 0));

  const hasInstability = peakCape12h >= 100 || activeMcdCount > 0;

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
    if (peakLowLevelShearKt >= 30 && veeringDeg >= 20) score += 3;
    else if (peakLowLevelShearKt >= 22 && veeringDeg >= 10) score += 2;
    else if (peakLowLevelShearKt >= 16) score += 1;
  }

  // Low-level moisture (Dewpoint)
  if (dewF >= 64) score += 2;
  else if (dewF >= 58) score += 1;

  // Synoptic forcing (3-hr MSLP fall) — gated on instability for convective scoring
  if (hasInstability) {
    if (pTrend <= -3.0) score += 2;
    else if (pTrend <= -1.5) score += 1;
  }

  if (activeMcdCount > 0) score += 2;

  if (Math.abs(cinNow) >= 200 && activeMcdCount === 0) {
    score = Math.round(score * 0.6);
  }

  if (!hasInstability) {
    score = Math.min(score, 2);
  }

  // High-Shear, Low-CAPE (Dixie Alley classic) signature
  const isHslc = hasInstability && peakCape12h >= 100 && peakCape12h <= 750 &&
    peakLowLevelShearKt >= 25 && peakBulkShearKt >= 35 && dewF >= 58;

  // Strong moisture + shear + CAPE supercell setup
  const isSupercellSetup = hasInstability && peakCape12h >= 500 && peakBulkShearKt >= 35 && peakLowLevelShearKt >= 20 && dewF >= 58;

  let regime = 'Quiet / Stable';
  let level = 'low';

  if (hasInstability) {
    if (score >= 9 || (isSupercellSetup && score >= 8)) {
      regime = isHslc ? 'HSLC Rotating Threat' : 'Supercell Favorable';
      level = 'high';
    } else if (score >= 6 || isHslc) {
      regime = isHslc ? 'HSLC Watchful (Shear-Driven)' : 'Elevated Convective';
      level = 'mod';
    } else if (score >= 4 && peakCape12h >= 150) {
      regime = 'Marginal Convective';
      level = 'mod';
    }
  }

  const hourLocal = getCentralHour24(nowMs, options.timeZone || DEFAULT_TIME_ZONE) ?? new Date(nowMs).getUTCHours();
  const isEveningOrNight = hourLocal >= 17 || hourLocal <= 6;
  const nocturnalEscalated = hasInstability && nocturnalEnabled && isEveningOrNight && (level === 'high' || (level === 'mod' && (isHslc || peakLowLevelShearKt >= 25)));

  const nocturnalRisk = nocturnalEscalated
    ? 'NOCTURNAL READINESS: Elevated overnight shear/convective setup — keep Borden Tempest open & screen awake.'
    : level === 'high'
      ? 'High convective & rotating storm potential — monitor radar closely.'
      : level === 'mod'
        ? 'Marginal/elevated shear or instability developing — stay weather aware.'
        : peakBulkShearKt >= 35
          ? `Strong shear aloft (${bulkShear0to6KmKt} kt), but air mass is stable (CAPE ${Math.round(peakCape12h)}) — non-convective.`
          : 'No nocturnal severe-weather readiness escalation needed.';

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
      summary: `0–6km Shear ${bulkShear0to6KmKt} kt (peak ${peakBulkShearKt} kt) • 0–1.5km Shear ${lowLevelShearKt} kt (${veeringDeg >= 0 ? '+' : ''}${veeringDeg}° veer) • CAPE ${Math.round(peakCape12h)} J/kg • Td ${dewF}°F • Pressure ${pTrend >= 0 ? '+' : ''}${pTrend} hPa/3hr`,
      level
    });
  }

  return {
    regime,
    level,
    score,
    capeNow: Math.round(nowSample.cape),
    peakCape12h: Math.round(peakCape12h),
    cinNow,
    lowLevelShearKt,
    peakLowLevelShearKt,
    bulkShear0to6KmKt,
    peakBulkShearKt,
    veeringDeg,
    srh0to1Km: Math.round(nowSample.srh0to1),
    srh0to3Km: Math.round(nowSample.srh0to3),
    stp: nowSample.stp,
    scp: nowSample.scp,
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
    proactiveAlerts
  };
}

/**
 * Evaluates Day 1-3 SPC Categorical, Day 1 Tornado/Hail/Wind %, WPC Flash Flood ERO,
 * and active SPC Watch Boxes at the user's exact coordinates.
 */
export function evaluateMultiDayOutlooks(userLat, userLon, intel) {
  const catRank = { NONE: 0, TSTM: 1, MRGL: 2, SLGT: 3, ENH: 4, MDT: 5, HIGH: 6 };
  const findHighestCat = (fc, propKey = 'LABEL') => {
    let best = 'NONE';
    for (const f of fc?.features || []) {
      if (!f.geometry || !isPointInGeometry(userLat, userLon, f.geometry)) continue;
      const raw = String(f.properties?.[propKey] || f.properties?.OUTLOOK || f.properties?.LABEL2 || '').trim().toUpperCase();
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
    let isSign = false;
    for (const f of fc?.features || []) {
      if (!f.geometry || !isPointInGeometry(userLat, userLon, f.geometry)) continue;
      const lbl = String(f.properties?.LABEL || '').trim().toUpperCase();
      if (lbl === 'SIGN') { isSign = true; continue; }
      const n = parseFloat(lbl.replace('%', ''));
      if (!Number.isNaN(n)) {
        const pct = n <= 1 ? Math.round(n * 100) : Math.round(n);
        if (pct > bestPct) bestPct = pct;
      }
    }
    if (bestPct === 0) return 'NONE';
    return isSign ? `${bestPct}% SIG` : `${bestPct}%`;
  };

  const activeWatches = (intel?.spcWatchesGeoJson?.features || []).filter((f) =>
    f.geometry && isPointInGeometry(userLat, userLon, f.geometry)
  ).map((f) => {
    const p = f.properties || {};
    return {
      number: p.num || p.SEL || '',
      type: String(p.type || '').toUpperCase(),
      isPds: Boolean(p.is_pds || String(p.pds || '').toUpperCase() === 'Y')
    };
  });

  return {
    day1Category: findHighestCat(intel?.spcDay1GeoJson, 'LABEL'),
    day1TornadoProb: findHighestProb(intel?.spcDay1TorGeoJson),
    day1HailProb: findHighestProb(intel?.spcDay1HailGeoJson),
    day1WindProb: findHighestProb(intel?.spcDay1WindGeoJson),
    day2Category: findHighestCat(intel?.spcDay2GeoJson, 'LABEL'),
    day3Category: findHighestCat(intel?.spcDay3GeoJson, 'LABEL'),
    wpcDay1FloodRisk: findHighestCat(intel?.wpcFloodGeoJson, 'OUTLOOK'),
    activeWatches
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

const PTYPE_META = {
  CLEAR: { code: 'CLEAR', label: 'Clear / Dry', shortLabel: 'Clear', color: '#475569', wintry: false },
  COLD_RAIN: { code: 'COLD_RAIN', label: 'Cold Rain', shortLabel: 'Rain', color: '#38BDF8', wintry: false },
  DRY_FREEZE: { code: 'DRY_FREEZE', label: 'Dry Freeze', shortLabel: 'Freeze', color: '#64748B', wintry: false },
  REFREEZE: { code: 'REFREEZE', label: 'Black Ice Refreeze', shortLabel: 'Refreeze', color: '#818CF8', wintry: false },
  WINTRY_MIX: { code: 'WINTRY_MIX', label: 'Wintry Mix', shortLabel: 'Mix', color: '#22D3EE', wintry: true },
  SNOW: { code: 'SNOW', label: 'Snow', shortLabel: 'Snow', color: '#E0F2FE', wintry: true },
  SLEET: { code: 'SLEET', label: 'Sleet (Ice Pellets)', shortLabel: 'Sleet', color: '#A78BFA', wintry: true },
  FREEZING_RAIN: { code: 'FREEZING_RAIN', label: 'Freezing Rain (Glaze)', shortLabel: 'Fz Rain', color: '#F472B6', wintry: true }
};

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

export function classifyHourlyPType({
  airTempF,
  wetBulbF,
  temp925F = null,
  temp850F = null,
  freezingLevelFt = null,
  soil0cmF = null,
  precipIn = 0,
  snowIn = 0,
  wmoCode = 0,
  priorLiquid8hIn = 0,
  groundFreezeThresholdF = 32
} = {}) {
  const airF = toFiniteNumber(airTempF) ?? 50;
  const twF = toFiniteNumber(wetBulbF) ?? computeWetBulbF(airF, 75);
  const t925 = toFiniteNumber(temp925F);
  const t850 = toFiniteNumber(temp850F);
  const frzFt = toFiniteNumber(freezingLevelFt);
  const s0 = toFiniteNumber(soil0cmF);
  const pIn = Math.max(0, toFiniteNumber(precipIn) ?? 0);
  const sIn = Math.max(0, toFiniteNumber(snowIn) ?? 0);
  const wmo = Math.trunc(toFiniteNumber(wmoCode) ?? 0);
  const prior8 = Math.max(0, toFiniteNumber(priorLiquid8hIn) ?? 0);
  const threshF = toFiniteNumber(groundFreezeThresholdF) ?? 32;

  const precipActive = pIn >= 0.004 || sIn >= 0.02 || isPrecipWmoCode(wmo);
  const coldSoil = s0 != null && s0 <= threshF;

  if (!precipActive) {
    const subFreeze = airF <= 32 || coldSoil;
    if (subFreeze && prior8 >= 0.03) return 'REFREEZE';
    return subFreeze ? 'DRY_FREEZE' : 'CLEAR';
  }

  let warmPeak = -Infinity;
  if (t925 != null) warmPeak = Math.max(warmPeak, t925);
  if (t850 != null) warmPeak = Math.max(warmPeak, t850);
  const hasAloft = warmPeak > -Infinity;
  const hasWarmNose = hasAloft && warmPeak > 33.0;
  const deepRefreeze =
    (t925 != null && t925 <= 30.0 && airF <= 29.0) ||
    (t850 != null && t850 > 33.5 && t925 != null && t925 <= 29.0 && twF <= 30.0);

  if (wmo === 56 || wmo === 57 || wmo === 66 || wmo === 67) return 'FREEZING_RAIN';
  if (hasWarmNose && !deepRefreeze && (airF <= 32.5 || twF <= 32.0 || coldSoil)) return 'FREEZING_RAIN';
  if (!hasAloft && pIn >= 0.004 && sIn < 0.01 && (airF <= 32.0 || (coldSoil && airF <= Math.max(34.0, threshF + 1.0)))) {
    return 'FREEZING_RAIN';
  }
  if (hasWarmNose && deepRefreeze) return 'SLEET';

  const snowWmo = wmo === 71 || wmo === 73 || wmo === 75 || wmo === 77 || wmo === 85 || wmo === 86;
  if (!hasWarmNose && (airF <= 33.5 || twF <= 32.0) && (sIn >= 0.02 || snowWmo || (twF <= 32.5 && airF <= 34.0))) {
    return 'SNOW';
  }
  if (((sIn >= 0.02 || snowWmo) && airF <= 42.0) || (twF <= 34.5 && (airF <= 35.5 || (frzFt != null && frzFt <= 1800)))) {
    return 'WINTRY_MIX';
  }
  return airF <= 42.0 ? 'COLD_RAIN' : 'CLEAR';
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

export function analyzeWinterModels(winterModels, nwsSnow72h = null, nwsIce72h = null, nowMs = Date.now()) {
  const refNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const hourly = winterModels?.hourly || {};
  const units = winterModels?.hourly_units || {};
  const offsetSec = Number.isFinite(winterModels?.utc_offset_seconds) ? winterModels.utc_offset_seconds : 0;
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  const startIdx = times.length ? findWinterStartHourIndex(times, refNowMs, offsetSec) : 0;
  const defs = [
    { name: 'HRRR', suffix: 'gfs_hrrr' },
    { name: 'GFS', suffix: 'gfs_seamless' },
    { name: 'ECMWF', suffix: 'ecmwf_ifs025' }
  ];
  const estimates = [];
  for (const def of defs) {
    const tArr = hourly[`temperature_2m_${def.suffix}`];
    if (!Array.isArray(tArr) || !tArr.length) continue;
    const tUnit = units[`temperature_2m_${def.suffix}`] || units.temperature_2m || '°F';
    const pUnit = units[`precipitation_${def.suffix}`] || units.precipitation || 'inch';
    const sUnit = units[`snowfall_${def.suffix}`] || units.snowfall || 'inch';
    const pArr = hourly[`precipitation_${def.suffix}`] || [];
    const sArr = hourly[`snowfall_${def.suffix}`] || [];
    const wArr = hourly[`weather_code_${def.suffix}`] || [];
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
  const nwsSnowNum = toFiniteNumber(nwsSnow72h);
  const nwsIceNum = toFiniteNumber(nwsIce72h);
  if (nwsSnowNum !== null || nwsIceNum !== null) {
    estimates.push({
      modelName: 'NWS',
      snow72hIn: Number(Math.max(0, nwsSnowNum ?? 0).toFixed(1)),
      ice72hIn: Number(Math.max(0, nwsIceNum ?? 0).toFixed(2)),
      minTemp72hF: estimates.length ? estimates[0].minTemp72hF : 32.0
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

function formatWinterClock(ms, withDay = true) {
  if (!Number.isFinite(ms)) return '--';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: DEFAULT_TIME_ZONE,
      ...(withDay ? { weekday: 'short' } : {}),
      hour: 'numeric',
      timeZoneName: 'short'
    }).format(new Date(ms)).replace(/[\u202f\u00a0]+/g, ' ').trim();
  } catch {
    return '--';
  }
}

/**
 * Full 72h Pro Winter / Ground Temp / Thermal Profile / Glaze Ice / WSSI Suite
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
  const hourly = openMeteo?.hourly || {};
  const hourlyUnits = openMeteo?.hourly_units || {};
  const tempUnit = hourlyUnits.temperature_2m || '°F';
  const dewUnit = hourlyUnits.dew_point_2m || tempUnit;
  const wetUnit = hourlyUnits.wet_bulb_temperature_2m || tempUnit;
  const appUnit = hourlyUnits.apparent_temperature || tempUnit;
  const soil0Unit = hourlyUnits.soil_temperature_0cm || tempUnit;
  const soil6Unit = hourlyUnits.soil_temperature_6cm || tempUnit;
  const precipUnit = hourlyUnits.precipitation || 'inch';
  const snowUnit = hourlyUnits.snowfall || 'inch';
  const snowDepthUnit = hourlyUnits.snow_depth || 'ft';
  const t925Unit = hourlyUnits.temperature_925hPa || tempUnit;
  const t850Unit = hourlyUnits.temperature_850hPa || tempUnit;
  const t700Unit = hourlyUnits.temperature_700hPa || tempUnit;
  const frzUnit = normalizeUnitCode(hourlyUnits.freezing_level_height || 'm');
  const offsetSec = openMeteo?.utc_offset_seconds ?? 0;
  const offsetOpts = Number.isFinite(offsetSec) && offsetSec !== 0 ? { utcOffsetSeconds: offsetSec } : {};
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  const idx = times.length ? findWinterStartHourIndex(times, refNowMs, offsetSec) : 0;

  const g0Val = convertTempToF(hourly.soil_temperature_0cm?.[idx], soil0Unit);
  const g6Val = convertTempToF(hourly.soil_temperature_6cm?.[idx], soil6Unit);
  const ground0cmF = g0Val != null ? Math.round(g0Val) : null;
  const ground6cmF = g6Val != null ? Math.round(g6Val) : null;

  const freezingLevelRaw = toFiniteNumber(hourly.freezing_level_height?.[idx]);
  const isMetersFrz = frzUnit === 'm' || frzUnit === 'meter' || frzUnit === 'meters';
  const freezingLevelFt = freezingLevelRaw != null
    ? Math.max(0, Math.round(isMetersFrz ? mToFeet(freezingLevelRaw) : freezingLevelRaw))
    : null;

  const next24Temps = (hourly.temperature_2m || [])
    .slice(idx, idx + 24)
    .map((t) => convertTempToF(t, tempUnit))
    .filter((t) => t != null && Number.isFinite(t));
  const hoursBelowFreezingNext24h = next24Temps.filter((t) => t <= 32).length;
  const minTemp24h = next24Temps.length
    ? Math.round(Math.min(...next24Temps))
    : (toFiniteNumber(safeCurrent.tempF) ?? null);

  const next24SnowLegacy = (hourly.snowfall || [])
    .slice(idx, idx + 24)
    .reduce((a, b) => a + Math.max(0, convertSnowfallToInches(b, snowUnit)), 0);
  const precipNow = Math.max(0, toFiniteNumber(openMeteo?.current?.precipitation) ?? 0);
  const wmo = Math.trunc(toFiniteNumber(openMeteo?.current?.weather_code) ?? 0);
  const airF = toFiniteNumber(safeCurrent.tempF) ?? 50;
  const visMi = Math.max(0, toFiniteNumber(safeCurrent.visibilityMi) ?? 10);

  // 72h thermal column & P-type trajectory
  const nwsGrid = parseNwsGridWinter(extras?.gridData || null, refNowMs);
  const totalAvailable = Math.max(
    times.length,
    Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m.length : 0
  );
  const end72Idx = Math.min(totalAvailable, idx + 72);
  const hourlySlots = [];
  const liquidRing = new Array(8).fill(0);
  let liquidPtr = 0;
  let omSnow24 = 0;
  let omSnow72 = 0;
  let omIce24 = 0;
  let omIce72 = 0;
  let maxSnowDepthIn = 0;
  let maxSnowRateHr = 0;
  let minSoil0cmWintryF = null;
  let minAirWintry = null;
  let anySlotWintry = false;
  let minTemp72hF = null;
  let minWindChill72hF = nwsGrid.minWindChill72hF;
  let hoursSubFreeze72h = 0;
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
    dominantPType: 'CLEAR'
  };

  for (let i = idx; i < end72Idx; i++) {
    const relHr = i - idx;
    const slotMs = parseUtcTimestampMs(times[i], offsetOpts) ?? (refNowMs + relHr * 3600000);
    const t2m = convertTempToF(hourly.temperature_2m?.[i], tempUnit) ?? airF;
    const td = convertTempToF(hourly.dew_point_2m?.[i], dewUnit);
    const rhVal = toFiniteNumber(hourly.relative_humidity_2m?.[i]) ?? (td != null ? deriveRhFromTempDewF(t2m, td) : 75);
    const twF = convertTempToF(hourly.wet_bulb_temperature_2m?.[i], wetUnit) ?? computeWetBulbF(t2m, rhVal);
    const t925 = convertTempToF(hourly.temperature_925hPa?.[i], t925Unit);
    const t850 = convertTempToF(hourly.temperature_850hPa?.[i], t850Unit);
    const t700 = convertTempToF(hourly.temperature_700hPa?.[i], t700Unit);
    const frzRaw = toFiniteNumber(hourly.freezing_level_height?.[i]);
    const frzFt = frzRaw != null ? Math.max(0, Math.round(isMetersFrz ? mToFeet(frzRaw) : frzRaw)) : null;
    const s0 = convertTempToF(hourly.soil_temperature_0cm?.[i], soil0Unit);
    const s6 = convertTempToF(hourly.soil_temperature_6cm?.[i], soil6Unit);
    const precipIn = Math.max(0, convertPrecipToInches(hourly.precipitation?.[i], precipUnit));
    const snowRawIn = Math.max(0, convertSnowfallToInches(hourly.snowfall?.[i], snowUnit));
    const slotWmo = Math.trunc(toFiniteNumber(hourly.weather_code?.[i]) ?? 0);
    const priorLiquid8hIn = liquidRing.reduce((a, b) => a + b, 0);

    const pType = classifyHourlyPType({
      airTempF: t2m,
      wetBulbF: twF,
      temp925F: t925,
      temp850F: t850,
      freezingLevelFt: frzFt,
      soil0cmF: s0,
      precipIn,
      snowIn: snowRawIn,
      wmoCode: slotWmo,
      priorLiquid8hIn,
      groundFreezeThresholdF: freezeThreshF
    });
    const iceIn = computeHourlyIceAccretion(pType, t2m, precipIn);
    let slotSnowIn = 0;
    if (pType === 'SNOW') slotSnowIn = snowRawIn > 0 ? snowRawIn : precipIn * dynamicSlrForTempF(t2m);
    else if (pType === 'WINTRY_MIX') slotSnowIn = snowRawIn;
    if (slotSnowIn > maxSnowRateHr) maxSnowRateHr = slotSnowIn;

    liquidRing[liquidPtr % 8] = (pType === 'COLD_RAIN' || pType === 'CLEAR' || pType === 'FREEZING_RAIN' || pType === 'WINTRY_MIX' || pType === 'SLEET') ? precipIn : 0;
    liquidPtr++;

    const meta = PTYPE_META[pType] || PTYPE_META.CLEAR;
    if (meta?.wintry || slotSnowIn > 0) {
      anySlotWintry = true;
      if (s0 != null && Number.isFinite(s0) && (minSoil0cmWintryF == null || s0 < minSoil0cmWintryF)) {
        minSoil0cmWintryF = Number(s0.toFixed(1));
      }
      if (Number.isFinite(t2m) && (minAirWintry == null || t2m < minAirWintry)) {
        minAirWintry = Number(t2m.toFixed(1));
      }
    }
    hourlySlots.push({
      epochMs: slotMs,
      hourLabel: formatWinterClock(slotMs, true),
      pType,
      pTypeLabel: meta.label,
      pTypeShortLabel: meta.shortLabel,
      pTypeColor: meta.color,
      airTempF: Number(t2m.toFixed(1)),
      wetBulbF: Number(twF.toFixed(1)),
      temp925F: t925 != null ? Number(t925.toFixed(1)) : null,
      temp850F: t850 != null ? Number(t850.toFixed(1)) : null,
      precipIn: Number(precipIn.toFixed(3)),
      snowIn: Number(slotSnowIn.toFixed(2)),
      iceIn: Number(iceIn.toFixed(3)),
      soil0cmF: s0 != null ? Number(s0.toFixed(1)) : null
    });

    if (relHr < 24) {
      omSnow24 += slotSnowIn;
      omIce24 += iceIn;
    }
    omSnow72 += slotSnowIn;
    omIce72 += iceIn;

    const sdVal = toFiniteNumber(hourly.snow_depth?.[i]);
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
    const appT = convertTempToF(hourly.apparent_temperature?.[i], appUnit);
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
        hasWarmNose: peak != null && peak > 33.0 && subFreezingSfc,
        warmNosePeakF: peak != null ? Number(peak.toFixed(1)) : null,
        dominantPType: pType
      };
    }
  }

  if (hourlySlots.some((s) => s.pType === 'FREEZING_RAIN' || s.pType === 'SLEET')) {
    thermalProfile.hasWarmNose = true;
  }

  if (minSoil0cmWintryF == null && thermalProfile.ground0cmF != null && Number.isFinite(thermalProfile.ground0cmF)) {
    minSoil0cmWintryF = Number(thermalProfile.ground0cmF.toFixed(1));
  }
  if (minAirWintry == null && minTemp72hF != null && Number.isFinite(minTemp72hF)) {
    minAirWintry = Number(minTemp72hF.toFixed(1));
  }

  const finalSnow24 = Number(Math.max(omSnow24, nwsGrid.snow24hIn).toFixed(1));
  const finalSnow72 = Number(Math.max(omSnow72, nwsGrid.snow72hIn).toFixed(1));
  const finalIce24 = Number(Math.max(omIce24, nwsGrid.ice24hIn).toFixed(2));
  const finalIce72 = Number(Math.max(omIce72, nwsGrid.ice72hIn).toFixed(2));

  const iceRisk = classifyIceRisk(finalIce72);
  let iceRiskDetail = iceRisk.detail;
  if (finalIce72 >= 0.25) iceRiskDetail = `${finalIce72.toFixed(2)}" glaze forecast — ${iceRisk.detail}`;
  else if (finalIce72 >= 0.01) iceRiskDetail = `${finalIce72.toFixed(2)}" ice — ${iceRisk.detail}`;

  const wssi = evaluateWssiAtPoint(extras?.lat, extras?.lon, extras?.wssiBundle);
  const modelSpread = analyzeWinterModels(
    extras?.winterModels || null,
    nwsGrid.snow72hIn > 0 ? nwsGrid.snow72hIn : finalSnow72,
    nwsGrid.ice72hIn > 0 ? nwsGrid.ice72hIn : finalIce72,
    refNowMs
  );

  const hasWintryActivity =
    finalSnow72 >= 0.05 ||
    finalIce72 >= 0.01 ||
    modelSpread.snowMaxIn >= 0.1 ||
    anySlotWintry;

  const g6ValForNote = thermalProfile.ground6cmF ?? ground6cmF;
  const g6Str = g6ValForNote != null && Number.isFinite(g6ValForNote) ? `${Math.round(g6ValForNote)}°F` : '--°F';
  const g0Str = minSoil0cmWintryF != null && Number.isFinite(minSoil0cmWintryF) ? `${Math.round(minSoil0cmWintryF)}°F` : '--°F';

  let groundAccumStatus = 'NO_WINTRY_PRECIP';
  let groundAccumNote = `No wintry precipitation expected in 72h (0cm ${g0Str} / 6cm ${g6Str}, ${hoursSubFreeze72h}h<=32°F).`;
  let roadSnow72hIn = 0.0;

  if (!hasWintryActivity) {
    groundAccumStatus = 'NO_WINTRY_PRECIP';
    roadSnow72hIn = 0.0;
  } else if (
    finalIce72 < 0.05 &&
    maxSnowRateHr < 1.0 &&
    minSoil0cmWintryF != null &&
    (
      minSoil0cmWintryF >= 37.0 ||
      (minAirWintry != null && minAirWintry >= 33.5 && minSoil0cmWintryF >= 34.5) ||
      (hoursSubFreeze72h === 0 && minSoil0cmWintryF >= 34.0)
    )
  ) {
    groundAccumStatus = 'WARM_GROUND_MELTS';
    roadSnow72hIn = 0.0;
    groundAccumNote = `Ground too warm to stick (0cm ${Math.round(minSoil0cmWintryF)}°F / 6cm ${g6Str}, ${hoursSubFreeze72h}h<=32°F): any falling snow/mix melts on contact — wet roads only, no accumulation.`;
  } else if (finalIce72 < 0.05 && minSoil0cmWintryF != null && minSoil0cmWintryF > 32.5) {
    groundAccumStatus = 'MARGINAL_SLUSHY';
    roadSnow72hIn = Number((finalSnow72 * 0.25).toFixed(1));
    groundAccumNote = `Marginal ground (${Math.round(minSoil0cmWintryF)}°F): melts initially on roads; slushy coating mainly on grass, decks & elevated bridges during heavier bursts.`;
  } else {
    groundAccumStatus = 'COLD_GROUND_STICKS';
    roadSnow72hIn = finalSnow72;
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
      changeoverLabel = `${meta.label} @ ${formatWinterClock(s.epochMs, true)}`;
    }
    if (s.pType === 'REFREEZE' && refreezeLabel.startsWith('No ')) {
      refreezeLabel = `Black-ice refreeze @ ${formatWinterClock(s.epochMs, true)}`;
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
        thawLabel = `Thaw >=34°F @ ${formatWinterClock(hourlySlots[i].epochMs, true)}`;
        break;
      }
    }
  }
  if (groundAccumStatus === 'WARM_GROUND_MELTS') {
    if (!changeoverLabel.startsWith('No ')) {
      changeoverLabel = changeoverLabel.includes(' @ ')
        ? changeoverLabel.replace(' @ ', ' (melts on warm ground) @ ')
        : `${changeoverLabel} (melts on warm ground)`;
    } else if (finalSnow72 >= 0.05 || modelSpread.snowMaxIn >= 0.1) {
      changeoverLabel = 'Flakes / model snow flux (melts on warm ground)';
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
      peakWindowLabel = `${formatWinterClock(hourlySlots[bestStart].epochMs, false)} – ${formatWinterClock(hourlySlots[bestStart + 5].epochMs, true)}`;
    }
  }

  const tForSlr = minTemp72hF ?? thermalProfile.airTempF ?? 30;
  const slrLabel = finalSnow72 > 0 ? `${dynamicSlrForTempF(tForSlr)}:1 SLR` : 'Dry / 10:1';

  let headline = '72H MONITORING';
  if (finalIce72 >= 0.5 || (wssi.highestRank >= 5 && finalIce72 >= 0.25)) {
    headline = `MAJOR ICE STORM (${finalIce72.toFixed(2)}")`;
  } else if (finalIce72 >= 0.25) {
    headline = `ICE STORM DANGER (${finalIce72.toFixed(2)}")`;
  } else if (groundAccumStatus === 'WARM_GROUND_MELTS') {
    if (wssi.highestRank >= 3) {
      headline = `WPC WSSI: ${wssi.highestImpact}`;
    } else if (finalSnow72 >= 0.1 || modelSpread.snowMaxIn >= 0.2) {
      headline = 'MELTING FLAKES / WARM GROUND';
    } else {
      headline = '72H MONITORING';
    }
  } else if (finalSnow72 >= 4.0) {
    headline = `WINTER STORM (${finalSnow72.toFixed(1)}" Snow)`;
  } else if (finalIce72 >= 0.1) {
    headline = `FREEZING RAIN (${finalIce72.toFixed(2)}" Ice)`;
  } else if (finalSnow72 >= 0.5) {
    headline = `SNOW FORECAST (${finalSnow72.toFixed(1)}" / 72h)`;
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
  const isFreezingPrecip = wmo === 56 || wmo === 57 || wmo === 66 || wmo === 67 || (precipNow > 0 && (airF <= 33 || isColdGround));
  const isFreezingFog = wmo === 48 || (visMi <= 0.5 && airF <= 32);
  const isDenseFog = visMi <= 0.5 && airF > 32;
  const hasRefreezeSlot = hourlySlots.some((s) => s.pType === 'REFREEZE');

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
  } else if (groundAccumStatus !== 'WARM_GROUND_MELTS' && (next24SnowLegacy >= 1.0 || finalSnow24 >= 1.0 || finalSnow72 >= 4.0)) {
    hazardLevel = finalSnow72 >= 4.0 ? 'HIGH' : 'MODERATE';
    const snowDisp = Math.max(next24SnowLegacy, finalSnow24);
    statusLabel = finalSnow72 >= 4.0
      ? `Winter Storm Snow (${finalSnow72.toFixed(1)}" / 72h)`
      : `Accumulating Snow (${snowDisp.toFixed(1)}" / 24h)`;
    roadBridgeRiskLabel = isColdGround ? 'Snow Sticking Immediately to Pavement' : 'Slushy / Melting Initially';
    winterAlerts.push({
      id: 'winter_snow',
      title: 'Accumulating Snow Expected',
      summary: `${snowDisp.toFixed(1)}" snow 24h (${finalSnow72.toFixed(1)}" 72h) • Ground 0cm: ${ground0cmF ?? '--'}°F.`,
      severity: finalSnow72 >= 4.0 ? 'high' : 'mod'
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
    groundAccumStatus === 'WARM_GROUND_MELTS' &&
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
    snow24hIn: Number(next24SnowLegacy.toFixed(1)),
    visibilityMi: visMi,
    winterAlerts,
    proWinter: {
      thermalProfile,
      hourlySlots,
      snow24hIn: finalSnow24,
      snow72hIn: finalSnow72,
      roadSnow72hIn,
      groundAccumStatus,
      groundAccumNote,
      minSoil0cmWintryF,
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
