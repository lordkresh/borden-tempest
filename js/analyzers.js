import { angularDiffDeg, buildThreatConePolygon, computeStormIntercept, degToCompass, haversineMiles } from './geoMath.js';

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
 * Multi-station NWS ASOS/AWOS + Open-Meteo Accuracy Consensus Resolver
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

  // Weighted accuracy consensus: live ASOS observations carry highest weight, blended with NDFD & Open-Meteo
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
    ? `NWS Consensus (${stationNames.join(', ')}) + Open-Meteo`
    : 'Open-Meteo Hyperlocal + NDFD';

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
 * Convective, Supercell, HSLC & Dixie Alley Nocturnal Readiness Analyzer
 */
export function analyzeEnvironment(openMeteo, current, mcdCount = 0) {
  const hourly = openMeteo?.hourly || {};
  const idx = findCurrentHourIndex(hourly);

  const capeNow = hourly.cape?.[idx] ?? 0;
  const next12Cape = (hourly.cape || []).slice(idx, idx + 12);
  const peakCape12h = next12Cape.length ? Math.max(...next12Cape.map((v) => v || 0)) : capeNow;

  // Compute low-level bulk shear proxy (10m to 180m / ~0-1.5km extrapolated low-level jet shear)
  const w10 = (hourly.wind_speed_10m?.[idx] ?? current.windMph ?? 0) * 0.868976; // kt
  const d10 = hourly.wind_direction_10m?.[idx] ?? current.windDirDeg ?? 0;
  const w180 = (hourly.wind_speed_180m?.[idx] ?? hourly.wind_speed_120m?.[idx] ?? current.windMph ?? 0) * 0.868976; // kt
  const d180 = hourly.wind_direction_180m?.[idx] ?? hourly.wind_direction_120m?.[idx] ?? d10;

  // Vector difference scaled to 0-1.5km layer estimate
  const u1 = -w10 * Math.sin((d10 * Math.PI) / 180);
  const v1 = -w10 * Math.cos((d10 * Math.PI) / 180);
  const u2 = -w180 * Math.sin((d180 * Math.PI) / 180);
  const v2 = -w180 * Math.cos((d180 * Math.PI) / 180);
  const rawVecShearKt = Math.hypot(u2 - u1, v2 - v1);
  const lowLevelShearKt = Math.round(rawVecShearKt * 1.85);
  const veeringDeg = Math.round(angularDiffDeg(d10, d180)); // positive = clockwise veering (helicity)

  const dewF = current.dewpointF ?? 45;
  const pTrend = current.pressureTrend3h ?? 0;

  let regime = 'Quiet / Stable';
  let level = 'low';
  let score = 0;

  if (peakCape12h >= 1500) score += 3;
  else if (peakCape12h >= 500) score += 2;
  else if (peakCape12h >= 150) score += 1;

  if (lowLevelShearKt >= 30 && veeringDeg >= 15) score += 3;
  else if (lowLevelShearKt >= 20) score += 2;
  else if (lowLevelShearKt >= 12) score += 1;

  if (dewF >= 64) score += 2;
  else if (dewF >= 58) score += 1;

  if (pTrend <= -3.0) score += 2;
  else if (pTrend <= -1.5) score += 1;

  if (mcdCount > 0) score += 2;

  const isHslc = peakCape12h >= 100 && peakCape12h <= 750 && lowLevelShearKt >= 25 && dewF >= 58;

  if (score >= 7) {
    regime = isHslc ? 'HSLC Rotating Threat' : 'Supercell Favorable';
    level = 'high';
  } else if (score >= 4) {
    regime = isHslc ? 'HSLC Watchful (Shear-Driven)' : 'Marginal Convective';
    level = 'mod';
  }

  // Nocturnal Readiness check (sunset to sunrise risk window)
  const hourLocal = new Date().getHours();
  const isEveningOrNight = hourLocal >= 17 || hourLocal <= 6;
  const nocturnalRisk = (level !== 'low' && isEveningOrNight)
    ? 'Elevated nocturnal convective setup — keep alerts active overnight.'
    : level === 'high'
      ? 'High convective potential developing — monitor radar closely.'
      : 'No nocturnal severe-weather readiness escalation needed.';

  const proactiveAlerts = [];
  if (level === 'high' || (level === 'mod' && isHslc)) {
    proactiveAlerts.push({
      id: 'convective_env_active',
      title: `${regime} Environment`,
      summary: `0–1.5km Shear ~${lowLevelShearKt} kt (${veeringDeg >= 0 ? '+' : ''}${veeringDeg}° veer) • CAPE ${Math.round(peakCape12h)} J/kg • Td ${dewF}°F • Pressure ${pTrend >= 0 ? '+' : ''}${pTrend} hPa/3hr`,
      level
    });
  }

  return {
    regime,
    level,
    score,
    capeNow: Math.round(capeNow),
    peakCape12h: Math.round(peakCape12h),
    lowLevelShearKt,
    veeringDeg,
    dewpointF: dewF,
    pressureTrend3h: pTrend,
    isHslc,
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
    const tvs = String(p.tvs || '').toUpperCase();
    const meso = String(p.meso || '').toUpperCase();
    const maxSizeIn = parseFloat(p.max_size || '0') || 0;
    const poh = parseFloat(p.poh || '0') || 0;
    const posh = parseFloat(p.posh || '0') || 0;
    const topKft = parseFloat(p.top || '0') || 0;

    // IEM drct is direction storm is moving FROM (or moving toward? In NEXRAD STI drct = azimuth storm moves FROM in meteorological convention; let's normalize carefully: IEM nexrad_attr drct is motion FROM degrees, sknt is knots)
    const speedKt = parseFloat(p.sknt || '0') || 0;
    const speedMph = Math.round(speedKt * 1.15078);
    const drctFrom = p.drct != null && p.drct !== '' ? parseFloat(p.drct) : null;
    const moveToBearing = drctFrom != null && !Number.isNaN(drctFrom) ? (drctFrom + 180) % 360 : null;

    const hasTvs = tvs === 'TVS' || tvs === 'ETVS';
    const hasMeso = meso && meso !== 'NONE' && meso !== '0' && meso !== 'NULL';

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
    } else if (maxSizeIn >= 0.75 || posh >= 40 || topKft >= 40) {
      threatLevel = 'SEVERE';
      threatScore = 2;
      color = '#ff6600';
    } else {
      // Skip weak non-severe garden-variety cells beyond 45 miles to keep UI sharp
      if (dist > 45) continue;
      color = '#facc15';
    }

    const intercept = computeStormIntercept(userLat, userLon, lat, lon, moveToBearing, speedMph);
    const coneCoords = buildThreatConePolygon(lat, lon, moveToBearing, speedMph, 45);

    analyzed.push({
      id: `${p.nexrad || 'RAD'}_${p.storm_id || 'X'}_${lat.toFixed(2)}`,
      nexrad: p.nexrad || 'NEXRAD',
      stormId: p.storm_id || 'CELL',
      lat,
      lon,
      tvs: hasTvs ? tvs : null,
      meso: hasMeso ? meso : null,
      maxHailIn: maxSizeIn,
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
    const aDirect = a.intercept.verdict === 'DIRECT_INTERCEPT' ? 10 : a.intercept.verdict === 'NEAR_MISS' ? 5 : 0;
    const bDirect = b.intercept.verdict === 'DIRECT_INTERCEPT' ? 10 : b.intercept.verdict === 'NEAR_MISS' ? 5 : 0;
    return (b.threatScore * 4 + bDirect - b.intercept.distanceMi * 0.05) - (a.threatScore * 4 + aDirect - a.intercept.distanceMi * 0.05);
  });

  return analyzed.slice(0, 40);
}

/**
 * Classify NWS Alert into Borden Tempest Alert Tiers
 */
export function classifyNwsAlert(feature) {
  const p = feature.properties || {};
  const ev = (p.event || '').toLowerCase();
  const params = p.parameters || {};
  const tornadoDetection = params.tornadoDetection?.[0] || null;
  const tornadoDamageThreat = params.tornadoDamageThreat?.[0] || null;
  const maxWindGust = params.maxWindGust?.[0] || null;
  const maxHailSize = params.maxHailSize?.[0] || null;
  const isTornadoEmergency = (tornadoDamageThreat || '').toUpperCase() === 'CATASTROPHIC' ||
    (p.headline || '').toLowerCase().includes('tornado emergency');

  let tier = 'ADVISORY';
  let color = '#00d4ff';
  let rank = 1;

  if (ev.includes('tornado warning') || ev.includes('flash flood emergency')) {
    tier = 'CRITICAL';
    color = '#ff2b4a';
    rank = 5;
  } else if (ev.includes('severe thunderstorm warning') || ev.includes('flash flood warning')) {
    tier = 'SEVERE';
    color = '#ff9800';
    rank = 4;
  } else if (ev.includes('tornado watch') || ev.includes('severe thunderstorm watch')) {
    tier = 'WATCH';
    color = '#facc15';
    rank = 3;
  } else if (ev.includes('winter') || ev.includes('ice storm') || ev.includes('blizzard') || ev.includes('freeze') || ev.includes('snow') || ev.includes('fog')) {
    tier = 'WINTER';
    color = '#56ccf2';
    rank = 2;
  }

  return {
    id: feature.id || p.id || `${p.event}_${p.sent}`,
    event: p.event || 'Weather Alert',
    headline: p.headline || p.event || '',
    description: p.description || '',
    instruction: p.instruction || '',
    areaDesc: p.areaDesc || '',
    senderName: p.senderName || 'NWS',
    sent: p.sent || null,
    expires: p.expires || p.ends || null,
    severity: p.severity || 'Unknown',
    urgency: p.urgency || 'Unknown',
    tornadoDetection,
    tornadoDamageThreat,
    isTornadoEmergency,
    maxWindGust,
    maxHailSize,
    tier,
    color,
    rank,
    geometry: feature.geometry || null
  };
}
