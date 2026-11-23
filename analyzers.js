import {
  angularDiffDeg,
  buildMotionVectorLine,
  buildThreatConePolygon,
  computeStormIntercept,
  degToCompass,
  haversineMiles,
  isPointInGeometry
} from './geoMath.js';

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

function cToF(c) {
  return c == null ? null : (c * 9) / 5 + 32;
}

function kmhToMph(kmh) {
  return kmh == null ? null : kmh * 0.621371;
}

function mToMiles(m) {
  return m == null ? null : m / 1609.344;
}

function paToHpa(pa) {
  return pa == null ? null : pa / 100;
}

function mphToKt(mph) {
  return (mph || 0) * 0.868976;
}

const KT_TO_MS = 0.514444;

function windComponentsKt(spdKt, dirFromDeg) {
  const rad = (dirFromDeg * Math.PI) / 180;
  return [-spdKt * Math.sin(rad), -spdKt * Math.cos(rad)];
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
  let total = 0;
  for (let i = 0; i < levelsMs.length - 1; i++) {
    const [u1, v1] = levelsMs[i];
    const [u2, v2] = levelsMs[i + 1];
    total += (u2 - stormU) * (v1 - stormV) - (u1 - stormU) * (v2 - stormV);
  }
  return total;
}

function findCurrentHourIndex(hourly) {
  const times = hourly?.time || [];
  if (!times.length) return 0;
  const nowMs = Date.now();
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const diff = Math.abs(new Date(times[i]).getTime() - nowMs);
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
export function resolveCurrentConditions(nwsBundle, openMeteo) {
  const cur = openMeteo?.current || {};
  const hourly = openMeteo?.hourly || {};
  const idx = findCurrentHourIndex(hourly);

  const stationTemps = [];
  const stationDews = [];
  const stationNames = [];
  let primaryObs = null;

  const omTemp = cur.temperature_2m ?? null;
  const nwsHourlyTemp = nwsBundle?.hourlyPeriods?.[0]?.temperature ?? null;
  const anchorTemp = nwsHourlyTemp ?? omTemp;

  // Outlier rejection (screens rural municipal AWOS cold-drainage glitches > 4.5°F from NDFD/HRRR anchor)
  const validStations = [];
  for (const obs of nwsBundle?.observations || []) {
    const p = obs.props;
    if (!p) continue;
    if (p.timestamp) {
      const ageMin = (Date.now() - new Date(p.timestamp).getTime()) / 60000;
      if (ageMin > 90) continue;
    }
    const tF = cToF(p.temperature?.value);
    const dF = cToF(p.dewpoint?.value);
    const rh = p.relativeHumidity?.value ?? null;
    const desc = String(p.textDescription || '').toLowerCase();
    const bogusClear100Rh = rh != null && rh >= 99 && (desc.includes('clear') || desc.includes('fair') || desc.includes('sunny'));
    if (tF != null && !Number.isNaN(tF)) {
      if (anchorTemp != null && Math.abs(tF - anchorTemp) > 4.5) continue;
      validStations.push({ obs, tF, dF: bogusClear100Rh ? null : dF, rh: bogusClear100Rh ? null : rh });
    }
  }

  for (const vs of validStations) {
    stationTemps.push(vs.tF);
    stationNames.push(vs.obs.stationId);
    if (!primaryObs) primaryObs = vs.obs;
    if (vs.dF != null && !Number.isNaN(vs.dF)) stationDews.push(vs.dF);
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

  const dewpointF = stationDews.length
    ? (stationDews[0] * 0.55 + (cur.dew_point_2m ?? stationDews[0]) * 0.45)
    : (cur.dew_point_2m ?? null);

  const pressureHpa = paToHpa(primaryObs?.props?.seaLevelPressure?.value)
    ?? paToHpa(primaryObs?.props?.barometricPressure?.value)
    ?? cur.pressure_msl
    ?? hourly.pressure_msl?.[idx]
    ?? cur.surface_pressure
    ?? null;

  const pNowMsl = hourly.pressure_msl?.[idx] ?? cur.pressure_msl ?? null;
  const p3hAgoMsl = idx >= 3 ? hourly.pressure_msl?.[idx - 3] : hourly.pressure_msl?.[0];
  const pressureTrend3h = (pNowMsl != null && p3hAgoMsl != null) ? (pNowMsl - p3hAgoMsl) : 0;

  const windMph = kmhToMph(primaryObs?.props?.windSpeed?.value) ?? cur.wind_speed_10m ?? 0;
  const gustMph = kmhToMph(primaryObs?.props?.windGust?.value) ?? cur.wind_gusts_10m ?? null;
  const windDir = primaryObs?.props?.windDirection?.value ?? cur.wind_direction_10m ?? null;
  const validRh = validStations.find((v) => v.rh != null)?.rh ?? null;
  const humidity = validRh ?? cur.relative_humidity_2m ?? null;
  const visMi = mToMiles(primaryObs?.props?.visibility?.value) ?? mToMiles(hourly.visibility?.[idx]) ?? 10;

  const [wmoLabel, wmoIcon] = wmoInfo(cur.weather_code);
  const conditionText = primaryObs?.props?.textDescription || wmoLabel;

  const sourceLabel = stationNames.length
    ? `NWS ASOS (${stationNames.join(', ')}) + NDFD/NBM + HRRR/GFS`
    : 'NWS NDFD/NBM + NOAA HRRR/GFS';

  const confidence = spreadF <= 2.5 ? 'High' : spreadF <= 5 ? 'Moderate' : 'Variable';

  return {
    tempF: tempF != null ? Math.round(tempF) : null,
    feelsLikeF: cur.apparent_temperature != null ? Math.round(cur.apparent_temperature) : (tempF != null ? Math.round(tempF) : null),
    dewpointF: dewpointF != null ? Math.round(dewpointF) : null,
    humidity: humidity != null ? Math.round(humidity) : null,
    windMph: Math.round(windMph),
    gustMph: gustMph != null ? Math.round(gustMph) : null,
    windDirDeg: windDir,
    windCompass: degToCompass(windDir),
    pressureHpa: pressureHpa != null ? Number(pressureHpa.toFixed(1)) : null,
    pressureInHg: pressureHpa != null ? (pressureHpa * 0.02953).toFixed(2) : '--',
    pressureTrend3h: Number(pressureTrend3h.toFixed(1)),
    visibilityMi: Number(visMi.toFixed(1)),
    cloudCover: cur.cloud_cover ?? null,
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
export function analyzeEnvironment(openMeteo, current, mcdCount = 0, options = {}) {
  const thresholdMode = options.convectiveAlertThreshold || 'STANDARD'; // SENSITIVE | STANDARD | HIGH_ONLY
  const nocturnalEnabled = options.nocturnalReadinessEnabled !== false;

  const hourly = openMeteo?.hourly || {};
  const idx = findCurrentHourIndex(hourly);

  const calcAt = (i) => {
    const cape = hourly.cape?.[i] ?? 0;
    const cin = hourly.convective_inhibition?.[i] ?? 0;
    const tempF = hourly.temperature_2m?.[i] ?? current.tempF ?? 65;
    const dewF = hourly.dew_point_2m?.[i] ?? current.dewpointF ?? 50;

    const w10 = mphToKt(hourly.wind_speed_10m?.[i] ?? current.windMph ?? 0);
    const d10 = hourly.wind_direction_10m?.[i] ?? current.windDirDeg ?? 0;
    const w850 = mphToKt(hourly.wind_speed_850hPa?.[i] ?? hourly.wind_speed_10m?.[i] ?? 0);
    const d850 = hourly.wind_direction_850hPa?.[i] ?? d10;
    const w500 = mphToKt(hourly.wind_speed_500hPa?.[i] ?? hourly.wind_speed_850hPa?.[i] ?? 0);
    const d500 = hourly.wind_direction_500hPa?.[i] ?? d850;

    const [u0, v0] = windComponentsKt(w10, d10);
    const [u850, v850] = windComponentsKt(w850, d850);
    const [u500, v500] = windComponentsKt(w500, d500);

    const has925 = hourly.wind_speed_925hPa?.[i] != null && hourly.wind_direction_925hPa?.[i] != null;
    const [u925, v925] = has925
      ? windComponentsKt(mphToKt(hourly.wind_speed_925hPa[i]), hourly.wind_direction_925hPa[i])
      : [(u0 + u850) * 0.5, (v0 + v850) * 0.5];

    const has700 = hourly.wind_speed_700hPa?.[i] != null && hourly.wind_direction_700hPa?.[i] != null;
    const [u700, v700] = has700
      ? windComponentsKt(mphToKt(hourly.wind_speed_700hPa[i]), hourly.wind_direction_700hPa[i])
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
    const veer850 = angularDiffDeg(d10, d850);

    // Bunkers Right-Mover Storm Motion (m/s)
    const meanU = ((u0 + u925 + u850 + u700 + u500) / 5) * KT_TO_MS;
    const meanV = ((v0 + v925 + v850 + v700 + v500) / 5) * KT_TO_MS;
    const shearU = (u500 - u0) * KT_TO_MS;
    const shearV = (v500 - v0) * KT_TO_MS;
    const shearMag = Math.max(0.01, Math.hypot(shearU, shearV));
    const cx = meanU + 7.5 * (shearV / shearMag);
    const cy = meanV + 7.5 * (-shearU / shearMag);
    const bunkersSpeedKt = Math.hypot(cx, cy) / KT_TO_MS;
    const bunkersHeadingDeg = ((Math.atan2(cx, cy) * 180) / Math.PI + 360) % 360;

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

    // Espy LCL height (m) & 700-500 hPa lapse rate (C/km)
    const tempC = ((tempF - 32) * 5) / 9;
    const dewC = ((dewF - 32) * 5) / 9;
    const lclMeters = Math.max(50, Math.min(5000, Math.round(125 * Math.max(0, tempC - dewC))));

    const t700 = hourly.temperature_700hPa?.[i];
    const t500 = hourly.temperature_500hPa?.[i];
    const h700 = hourly.geopotential_height_700hPa?.[i];
    const h500 = hourly.geopotential_height_500hPa?.[i];
    let lapseRate700to500 = 5.8;
    if (t700 != null && t500 != null && h700 != null && h500 != null && (h500 - h700) > 500) {
      const dTC = ((t700 - t500) * 5) / 9;
      lapseRate700to500 = Math.round((dTC / ((h500 - h700) / 1000)) * 10) / 10;
    }

    // Official SPC Fixed-Layer Significant Tornado Parameter (STP) & Supercell Composite (SCP)
    const bulkShearMs = deepShearKt * KT_TO_MS;
    const lclTerm = lclMeters > 2000 ? 0 : lclMeters < 1000 ? 1 : (2000 - lclMeters) / 1000;
    const shearTerm = bulkShearMs < 12.5 ? 0 : bulkShearMs > 30 ? 1.5 : bulkShearMs / 20;
    const cinAbs = Math.abs(cin);
    const cinTerm = cinAbs >= 200 ? 0 : cinAbs <= 50 ? 1 : (200 - cinAbs) / 150;
    const stp = Math.round(Math.min(12, Math.max(0, (cape / 1500) * lclTerm * (srh0to1 / 150) * shearTerm * cinTerm)) * 10) / 10;
    const scp = Math.round(Math.min(25, Math.max(0, (cape / 1000) * (srh0to3 / 50) * Math.min(1.5, bulkShearMs / 20))) * 10) / 10;

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

  const dewF = current.dewpointF ?? 45;
  const pTrend = current.pressureTrend3h ?? 0;

  const hasInstability = peakCape12h >= 100 || mcdCount > 0;

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

  if (mcdCount > 0) score += 2;

  if (Math.abs(cinNow) >= 200 && mcdCount === 0) {
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

  const hourLocal = new Date().getHours();
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
export function analyzeWinterSuite(openMeteo, current, groundFreezeThresholdF = 32) {
  const hourly = openMeteo?.hourly || {};
  const idx = findCurrentHourIndex(hourly);

  const ground0cmF = hourly.soil_temperature_0cm?.[idx] != null ? Math.round(hourly.soil_temperature_0cm[idx]) : null;
  const ground6cmF = hourly.soil_temperature_6cm?.[idx] != null ? Math.round(hourly.soil_temperature_6cm[idx]) : null;
  const freezingLevelRaw = hourly.freezing_level_height?.[idx] ?? null;
  const freezingUnit = openMeteo?.hourly_units?.freezing_level_height || 'm';
  const freezingLevelFt = freezingLevelRaw != null
    ? Math.round(freezingUnit === 'm' ? freezingLevelRaw * 3.28084 : freezingLevelRaw)
    : null;

  const next24Temps = (hourly.temperature_2m || []).slice(idx, idx + 24);
  const hoursBelowFreezingNext24h = next24Temps.filter((t) => t != null && t <= 32).length;
  const minTemp24h = next24Temps.length ? Math.round(Math.min(...next24Temps)) : current.tempF;

  const next24Snow = (hourly.snowfall || []).slice(idx, idx + 24).reduce((a, b) => a + (b || 0), 0);
  const precipNow = openMeteo?.current?.precipitation ?? 0;
  const wmo = openMeteo?.current?.weather_code ?? 0;
  const airF = current.tempF ?? 50;
  const visMi = current.visibilityMi ?? 10;

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
  } else if (minTemp24h <= 28 || (isColdGround && airF <= 34)) {
    hazardLevel = 'ADVISORY';
    statusLabel = minTemp24h <= 28 ? `Hard Freeze (${minTemp24h}°F)` : 'Frost / Near-Freezing Surface';
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
  const features = stormCellsGeoJson?.features || [];
  const candidates = [];

  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const [lon, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const dist = haversineMiles(userLat, userLon, lat, lon);
    if (dist > maxRadiusMi) continue;

    const p = f.properties || {};
    if (p.valid) {
      const validMs = new Date(p.valid).getTime();
      if (Number.isFinite(validMs)) {
        const ageMin = (nowMs - validMs) / 60000;
        if (ageMin > 25) continue;
      }
    }

    const nexrad = String(p.nexrad || 'NEXRAD').trim().toUpperCase();
    const isTdwr = TDWR_SITES.has(nexrad);
    const radarRangeKm = parseFloat(p.range || '0') || 0;
    const radarRangeMi = radarRangeKm > 0 ? Number((radarRangeKm * 0.621371).toFixed(0)) : null;

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
    const speedMphRaw = Math.round(speedKtRaw * 1.15078);
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
  const speedMph = Math.round(speedKt * 1.15078);
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

/**
 * Classify NWS Alert into Borden Tempest Severe Tiers with Point-in-Polygon & PDS/Observed Detection
 */
export function classifyNwsAlert(feature, userLat = null, userLon = null) {
  const p = feature.properties || {};
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

  const expiresIso = p.expires || p.ends || null;
  const isExpired = expiresIso ? new Date(expiresIso).getTime() < Date.now() : false;

  const insidePolygon = (userLat != null && userLon != null && feature.geometry)
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
    id: feature.id || p.id || `${p.event}_${p.sent}`,
    escalationFingerprint,
    event: p.event || 'Weather Alert',
    headline: p.headline || p.event || '',
    description: p.description || '',
    instruction: p.instruction || '',
    areaDesc: p.areaDesc || '',
    senderName: p.senderName || 'NWS',
    sent: p.sent || null,
    expires: expiresIso,
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
    geometry: feature.geometry || null
  };
}
