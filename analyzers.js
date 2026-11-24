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

/**
 * Full Winter / Ground Temp / Black Ice / Freezing Fog Suite
 */
export function analyzeWinterSuite(openMeteo, current = {}, groundFreezeThresholdF = 32, nowMs = Date.now()) {
  const safeCurrent = current || {};
  const hourly = openMeteo?.hourly || {};
  const hourlyUnits = openMeteo?.hourly_units || {};
  const tempUnit = hourlyUnits.temperature_2m || '°F';
  const soil0Unit = hourlyUnits.soil_temperature_0cm || tempUnit;
  const soil6Unit = hourlyUnits.soil_temperature_6cm || tempUnit;
  const snowUnit = hourlyUnits.snowfall || 'inch';
  const idx = findCurrentHourIndex(hourly, nowMs, openMeteo?.utc_offset_seconds ?? 0);

  const g0Val = convertTempToF(hourly.soil_temperature_0cm?.[idx], soil0Unit);
  const g6Val = convertTempToF(hourly.soil_temperature_6cm?.[idx], soil6Unit);
  const ground0cmF = g0Val != null ? Math.round(g0Val) : null;
  const ground6cmF = g6Val != null ? Math.round(g6Val) : null;

  const freezingLevelRaw = toFiniteNumber(hourly.freezing_level_height?.[idx]);
  const freezingUnit = normalizeUnitCode(hourlyUnits.freezing_level_height || 'm');
  const freezingLevelFt = freezingLevelRaw != null
    ? Math.max(0, Math.round(freezingUnit === 'm' || freezingUnit === 'meter' ? mToFeet(freezingLevelRaw) : freezingLevelRaw))
    : null;

  const next24Temps = (hourly.temperature_2m || [])
    .slice(idx, idx + 24)
    .map((t) => convertTempToF(t, tempUnit))
    .filter((t) => t != null && Number.isFinite(t));
  const hoursBelowFreezingNext24h = next24Temps.filter((t) => t <= 32).length;
  const minTemp24h = next24Temps.length
    ? Math.round(Math.min(...next24Temps))
    : (toFiniteNumber(safeCurrent.tempF) ?? null);

  const next24Snow = (hourly.snowfall || [])
    .slice(idx, idx + 24)
    .reduce((a, b) => a + Math.max(0, convertSnowfallToInches(b, snowUnit)), 0);
  const precipNow = Math.max(0, toFiniteNumber(openMeteo?.current?.precipitation) ?? 0);
  const wmo = openMeteo?.current?.weather_code ?? 0;
  const airF = toFiniteNumber(safeCurrent.tempF) ?? 50;
  const visMi = Math.max(0, toFiniteNumber(safeCurrent.visibilityMi) ?? 10);

  let hazardLevel = 'CLEAR';
  let statusLabel = 'Clear / Above Freezing';
  let roadBridgeRiskLabel = 'Dry / Safe Road Surfaces';
  const winterAlerts = [];

  const isColdGround = ground0cmF != null && ground0cmF <= groundFreezeThresholdF;
  const isFreezingPrecip = wmo === 56 || wmo === 57 || wmo === 66 || wmo === 67 || (precipNow > 0 && (airF <= 33 || isColdGround));
  const isFreezingFog = wmo === 48 || (visMi <= 0.5 && airF <= 32);
  const isDenseFog = visMi <= 0.5 && airF > 32;

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
  } else if (next24Snow >= 1.0) {
    hazardLevel = 'MODERATE';
    statusLabel = `Accumulating Snow (${next24Snow.toFixed(1)}" / 24h)`;
    roadBridgeRiskLabel = isColdGround ? 'Snow Sticking Immediately to Pavement' : 'Slushy / Melting Initially';
    winterAlerts.push({
      id: 'winter_snow',
      title: 'Accumulating Snow Expected',
      summary: `${next24Snow.toFixed(1)}" snow forecast over next 24h • Ground 0cm: ${ground0cmF ?? '--'}°F.`,
      severity: 'mod'
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
  } else if ((minTemp24h != null && minTemp24h <= 28) || (isColdGround && airF <= 34)) {
    hazardLevel = 'ADVISORY';
    statusLabel = (minTemp24h != null && minTemp24h <= 28) ? `Hard Freeze (${minTemp24h}°F)` : 'Frost / Near-Freezing Surface';
    roadBridgeRiskLabel = 'Watch Shaded Bridges for Patchy Frost';
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
    snow24hIn: Number(next24Snow.toFixed(1)),
    visibilityMi: visMi,
    winterAlerts
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
