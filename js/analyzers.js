import {
  angularDiffDeg,
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

function vectorShearKt(spd1Kt, dir1Deg, spd2Kt, dir2Deg) {
  const u1 = -spd1Kt * Math.sin((dir1Deg * Math.PI) / 180);
  const v1 = -spd1Kt * Math.cos((dir1Deg * Math.PI) / 180);
  const u2 = -spd2Kt * Math.sin((dir2Deg * Math.PI) / 180);
  const v2 = -spd2Kt * Math.cos((dir2Deg * Math.PI) / 180);
  return Math.hypot(u2 - u1, v2 - v1);
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

  for (const obs of nwsBundle?.observations || []) {
    const p = obs.props;
    if (!p) continue;
    // Skip stale observations older than 2.5 hours
    if (p.timestamp) {
      const ageMin = (Date.now() - new Date(p.timestamp).getTime()) / 60000;
      if (ageMin > 150) continue;
    }
    const tF = cToF(p.temperature?.value);
    const dF = cToF(p.dewpoint?.value);
    if (tF != null && !Number.isNaN(tF)) {
      stationTemps.push(tF);
      stationNames.push(obs.stationId);
      if (!primaryObs) primaryObs = obs;
    }
    if (dF != null && !Number.isNaN(dF)) stationDews.push(dF);
  }

  const omTemp = cur.temperature_2m ?? null;
  const nwsHourlyTemp = nwsBundle?.hourlyPeriods?.[0]?.temperature ?? null;

  const samples = [];
  stationTemps.forEach((t, i) => samples.push({ v: t, w: i === 0 ? 0.55 : 0.3 }));
  if (nwsHourlyTemp != null) samples.push({ v: nwsHourlyTemp, w: 0.2 });
  if (omTemp != null) samples.push({ v: omTemp, w: stationTemps.length ? 0.25 : 1.0 });

  const totalW = samples.reduce((a, s) => a + s.w, 0) || 1;
  const tempF = samples.length
    ? samples.reduce((a, s) => a + s.v * s.w, 0) / totalW
    : omTemp;

  const spreadF = samples.length >= 2
    ? Math.max(...samples.map((s) => s.v)) - Math.min(...samples.map((s) => s.v))
    : 0;

  const dewpointF = stationDews.length
    ? (stationDews[0] * 0.65 + (cur.dew_point_2m ?? stationDews[0]) * 0.35)
    : (cur.dew_point_2m ?? null);

  const pressureHpa = paToHpa(primaryObs?.props?.barometricPressure?.value)
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
  const humidity = primaryObs?.props?.relativeHumidity?.value ?? cur.relative_humidity_2m ?? null;
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
    const w10 = mphToKt(hourly.wind_speed_10m?.[i] ?? current.windMph ?? 0);
    const d10 = hourly.wind_direction_10m?.[i] ?? current.windDirDeg ?? 0;
    const w850 = mphToKt(hourly.wind_speed_850hPa?.[i] ?? hourly.wind_speed_10m?.[i] ?? 0);
    const d850 = hourly.wind_direction_850hPa?.[i] ?? d10;
    const w500 = mphToKt(hourly.wind_speed_500hPa?.[i] ?? hourly.wind_speed_850hPa?.[i] ?? 0);
    const d500 = hourly.wind_direction_500hPa?.[i] ?? d850;
    const lowShearKt = vectorShearKt(w10, d10, w850, d850);
    const deepShearKt = vectorShearKt(w10, d10, w500, d500);
    const veer850 = angularDiffDeg(d10, d850); // positive = clockwise veering (helicity)
    return { cape, cin, lowShearKt, deepShearKt, veer850 };
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

  let score = 0;
  // Instability (CAPE)
  if (peakCape12h >= 1800) score += 3;
  else if (peakCape12h >= 750) score += 2;
  else if (peakCape12h >= 200) score += 1;

  // Deep-layer supercell shear (0-6 km: 10m -> 500 hPa)
  if (peakBulkShearKt >= 45) score += 3;
  else if (peakBulkShearKt >= 35) score += 2;
  else if (peakBulkShearKt >= 25) score += 1;

  // Low-level tornado shear & veering (0-1.5 km: 10m -> 850 hPa)
  if (peakLowLevelShearKt >= 30 && veeringDeg >= 20) score += 3;
  else if (peakLowLevelShearKt >= 22 && veeringDeg >= 10) score += 2;
  else if (peakLowLevelShearKt >= 16) score += 1;

  // Low-level moisture (Dewpoint)
  if (dewF >= 64) score += 2;
  else if (dewF >= 58) score += 1;

  // Synoptic forcing (3-hr MSLP fall)
  if (pTrend <= -3.0) score += 2;
  else if (pTrend <= -1.5) score += 1;

  if (mcdCount > 0) score += 2;

  // High-Shear, Low-CAPE (Dixie Alley classic) signature
  const isHslc = peakCape12h >= 100 && peakCape12h <= 750 &&
    peakLowLevelShearKt >= 25 && peakBulkShearKt >= 35 && dewF >= 58;

  // Strong moisture + shear + CAPE supercell setup
  const isSupercellSetup = peakCape12h >= 500 && peakBulkShearKt >= 35 && peakLowLevelShearKt >= 20 && dewF >= 58;

  let regime = 'Quiet / Stable';
  let level = 'low';

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

  const hourLocal = new Date().getHours();
  const isEveningOrNight = hourLocal >= 17 || hourLocal <= 6;
  const nocturnalEscalated = nocturnalEnabled && isEveningOrNight && (level === 'high' || (level === 'mod' && (isHslc || peakLowLevelShearKt >= 25)));

  const nocturnalRisk = nocturnalEscalated
    ? 'NOCTURNAL READINESS: Elevated overnight shear/convective setup — keep Borden Tempest open & screen awake.'
    : level === 'high'
      ? 'High convective & rotating storm potential — monitor radar closely.'
      : level === 'mod'
        ? 'Marginal/elevated shear or instability developing — stay weather aware.'
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
    dewpointF: dewF,
    pressureTrend3h: pTrend,
    isHslc,
    nocturnalEscalated,
    nocturnalRisk,
    proactiveAlerts
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

/**
 * NEXRAD Storm Cell Threat & Time-on-Target (TOT) Intercept Engine
 * Verified: IEM nexrad_attr.geojson `drct` is meteorological FROM direction; moving-TO bearing = (drct + 180) % 360.
 */
export function analyzeStormCells(stormCellsGeoJson, userLat, userLon, maxRadiusMi = 120) {
  const features = stormCellsGeoJson?.features || [];
  const analyzed = [];

  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const [lon, lat] = coords;
    const dist = haversineMiles(userLat, userLon, lat, lon);
    if (dist > maxRadiusMi) continue;

    const p = f.properties || {};
    // Skip stale NEXRAD storm cell reports older than 25 minutes
    if (p.valid) {
      const ageMin = (Date.now() - new Date(p.valid).getTime()) / 60000;
      if (ageMin > 25) continue;
    }

    const tvs = String(p.tvs || '').toUpperCase();
    const meso = String(p.meso || '').toUpperCase();
    const maxSizeIn = parseFloat(p.max_size || '0') || 0;
    const poh = parseFloat(p.poh || '0') || 0;
    const posh = parseFloat(p.posh || '0') || 0;
    const topKft = parseFloat(p.top || '0') || 0;
    const maxDbz = parseFloat(p.max_dbz || '0') || 0;

    const speedKt = parseFloat(p.sknt || '0') || 0;
    const speedMph = Math.round(speedKt * 1.15078);
    const drctFrom = p.drct != null && p.drct !== '' ? parseFloat(p.drct) : null;
    const moveToBearing = drctFrom != null && !Number.isNaN(drctFrom) && speedKt > 0
      ? (drctFrom + 180) % 360
      : null;

    const hasTvs = tvs === 'TVS' || tvs === 'ETVS';
    const hasMeso = Boolean(meso && meso !== 'NONE' && meso !== '0' && meso !== 'NULL' && meso !== 'UNC');

    let threatLevel = 'STRONG';
    let threatScore = 1;
    let color = '#ff9800';

    if (hasTvs) {
      threatLevel = 'TORNADO_TVS';
      threatScore = 4;
      color = '#ff2b4a';
    } else if (hasMeso || maxSizeIn >= 1.5) {
      threatLevel = 'SUPERCELL';
      threatScore = 3;
      color = '#d946ef';
    } else if (maxSizeIn >= 0.75 || posh >= 40 || topKft >= 40 || maxDbz >= 62) {
      threatLevel = 'SEVERE';
      threatScore = 2;
      color = '#ff6600';
    } else {
      if (dist > 45) continue;
      color = '#facc15';
    }

    const intercept = computeStormIntercept(userLat, userLon, lat, lon, moveToBearing, speedMph);
    const coneCoords = buildThreatConePolygon(lat, lon, moveToBearing, speedMph, 45);

    analyzed.push({
      id: `${p.nexrad || 'RAD'}_${p.storm_id || 'X'}`,
      nexrad: p.nexrad || 'NEXRAD',
      stormId: p.storm_id || 'CELL',
      lat,
      lon,
      tvs: hasTvs ? tvs : null,
      meso: hasMeso ? meso : null,
      maxHailIn: maxSizeIn,
      maxDbz,
      poh,
      posh,
      topKft,
      speedMph,
      moveToBearing,
      moveToCompass: moveToBearing != null ? degToCompass(moveToBearing) : '--',
      threatLevel,
      threatScore,
      color,
      intercept,
      coneCoords
    });
  }

  analyzed.sort((a, b) => {
    const aDirect = a.intercept.verdict === 'DIRECT_INTERCEPT' ? 12 : a.intercept.verdict === 'NEAR_MISS' ? 6 : 0;
    const bDirect = b.intercept.verdict === 'DIRECT_INTERCEPT' ? 12 : b.intercept.verdict === 'NEAR_MISS' ? 6 : 0;
    return (b.threatScore * 4 + bDirect - b.intercept.distanceMi * 0.05) - (a.threatScore * 4 + aDirect - a.intercept.distanceMi * 0.05);
  });

  return analyzed.slice(0, 40);
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
    tier,
    color,
    rank,
    geometry: feature.geometry || null
  };
}
