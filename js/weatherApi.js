const NWS_BASE = 'https://api.weather.gov';
const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_BASE = 'https://geocoding-api.open-meteo.com/v1/search';
const IEM_BASE = 'https://mesonet.agron.iastate.edu';
const SPC_DAY1_URL = 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson';

export const RADAR_PRODUCTS = [
  { code: 'CONUS_MOSAIC', shortLabel: 'CONUS', name: 'CONUS High-Res Composite Reflectivity', singleSite: false },
  { code: 'N0B', shortLabel: 'Refl N0B', name: 'Super-Res Base Reflectivity (0.5°)', singleSite: true },
  { code: 'N0G', shortLabel: 'Vel N0G', name: 'Super-Res Base Velocity (0.5°)', singleSite: true },
  { code: 'N0C', shortLabel: 'CC ρhv', name: 'Correlation Coefficient (Debris)', singleSite: true },
  { code: 'N0X', shortLabel: 'ZDR N0X', name: 'Differential Reflectivity (ZDR)', singleSite: true },
  { code: 'EET', shortLabel: 'Tops EET', name: 'Enhanced Echo Tops', singleSite: true }
];

async function fetchJson(url, headers = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchNwsPointBundle(lat, lon) {
  const rLat = Number(lat).toFixed(4);
  const rLon = Number(lon).toFixed(4);
  const pointData = await fetchJson(`${NWS_BASE}/points/${rLat},${rLon}`, { Accept: 'application/geo+json' });
  const props = pointData?.properties || {};

  const [forecastRes, hourlyRes, stationsRes] = await Promise.allSettled([
    props.forecast ? fetchJson(props.forecast, { Accept: 'application/geo+json' }) : Promise.resolve(null),
    props.forecastHourly ? fetchJson(props.forecastHourly, { Accept: 'application/geo+json' }) : Promise.resolve(null),
    props.observationStations ? fetchJson(props.observationStations, { Accept: 'application/geo+json' }) : Promise.resolve(null)
  ]);

  // Multi-station consensus: query up to 3 closest ASOS/AWOS stations in parallel
  const stationFeatures = (stationsRes.status === 'fulfilled' && stationsRes.value?.features)
    ? stationsRes.value.features.slice(0, 3)
    : [];

  const obsResults = await Promise.allSettled(
    stationFeatures.map(async (sf) => {
      const sid = sf.properties?.stationIdentifier;
      if (!sid) return null;
      const obs = await fetchJson(`${NWS_BASE}/stations/${sid}/observations/latest`, { Accept: 'application/geo+json' }, 8000);
      return {
        stationId: sid,
        stationName: sf.properties?.name || sid,
        coords: sf.geometry?.coordinates || null,
        props: obs?.properties || null
      };
    })
  );

  const observations = obsResults
    .filter((r) => r.status === 'fulfilled' && r.value && r.value.props)
    .map((r) => r.value);

  const relLoc = props.relativeLocation?.properties;
  const cityLabel = relLoc ? `${relLoc.city}, ${relLoc.state}` : null;

  return {
    cityLabel,
    stateCode: relLoc?.state || null,
    cwa: props.cwa || null,
    radarStation: props.radarStation || null,
    forecastPeriods: forecastRes.status === 'fulfilled' ? (forecastRes.value?.properties?.periods || []) : [],
    hourlyPeriods: hourlyRes.status === 'fulfilled' ? (hourlyRes.value?.properties?.periods || []) : [],
    observations
  };
}

export async function fetchNwsAlerts(lat, lon, stateCode = null) {
  const rLat = Number(lat).toFixed(4);
  const rLon = Number(lon).toFixed(4);

  const [pointAlertsRes, areaAlertsRes] = await Promise.allSettled([
    fetchJson(`${NWS_BASE}/alerts/active?point=${rLat},${rLon}`, { Accept: 'application/geo+json' }),
    stateCode
      ? fetchJson(`${NWS_BASE}/alerts/active?area=${stateCode}`, { Accept: 'application/geo+json' })
      : Promise.resolve({ features: [] })
  ]);

  const localFeatures = pointAlertsRes.status === 'fulfilled' ? (pointAlertsRes.value?.features || []) : [];
  const regionalFeatures = areaAlertsRes.status === 'fulfilled' ? (areaAlertsRes.value?.features || []) : [];

  const localIds = new Set(localFeatures.map((f) => f.id || f.properties?.id));
  const combined = [...localFeatures];
  for (const rf of regionalFeatures) {
    const id = rf.id || rf.properties?.id;
    if (!localIds.has(id)) combined.push(rf);
  }

  return {
    localFeatures,
    regionalFeatures: combined
  };
}

export async function fetchOpenMeteo(lat, lon) {
  const params = new URLSearchParams({
    latitude: Number(lat).toFixed(4),
    longitude: Number(lon).toFixed(4),
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
    forecast_days: '3',
    current: [
      'temperature_2m',
      'relative_humidity_2m',
      'apparent_temperature',
      'dew_point_2m',
      'precipitation',
      'rain',
      'snowfall',
      'weather_code',
      'cloud_cover',
      'pressure_msl',
      'surface_pressure',
      'wind_speed_10m',
      'wind_direction_10m',
      'wind_gusts_10m'
    ].join(','),
    hourly: [
      'temperature_2m',
      'dew_point_2m',
      'relative_humidity_2m',
      'apparent_temperature',
      'precipitation_probability',
      'precipitation',
      'snowfall',
      'weather_code',
      'pressure_msl',
      'surface_pressure',
      'visibility',
      'wind_speed_10m',
      'wind_direction_10m',
      'wind_speed_80m',
      'wind_direction_80m',
      'wind_speed_120m',
      'wind_direction_120m',
      'wind_speed_180m',
      'wind_direction_180m',
      'wind_gusts_10m',
      'cape',
      'freezing_level_height',
      'soil_temperature_0cm',
      'soil_temperature_6cm'
    ].join(',')
  });

  return fetchJson(`${OPEN_METEO_BASE}?${params.toString()}`);
}

export async function fetchIemStormIntel() {
  const [cellsRes, lsrRes, mcdRes, spcRes] = await Promise.allSettled([
    fetchJson(`${IEM_BASE}/geojson/nexrad_attr.geojson`, {}, 10000),
    fetchJson(`${IEM_BASE}/geojson/lsr.geojson?hours=6`, {}, 10000),
    fetchJson(`${IEM_BASE}/geojson/mcd.geojson`, {}, 10000),
    fetchJson(SPC_DAY1_URL, {}, 10000)
  ]);

  return {
    stormCellsGeoJson: cellsRes.status === 'fulfilled' ? cellsRes.value : { type: 'FeatureCollection', features: [] },
    lsrGeoJson: lsrRes.status === 'fulfilled' ? lsrRes.value : { type: 'FeatureCollection', features: [] },
    mcdGeoJson: mcdRes.status === 'fulfilled' ? mcdRes.value : { type: 'FeatureCollection', features: [] },
    spcDay1GeoJson: spcRes.status === 'fulfilled' ? spcRes.value : { type: 'FeatureCollection', features: [] }
  };
}

export async function buildRadarFrames(productCode, siteId) {
  const now = new Date();
  if (productCode === 'CONUS_MOSAIC') {
    const offsets = [45, 40, 35, 30, 25, 20, 15, 10, 5, 0];
    return offsets.map((minsAgo) => {
      const t = new Date(now.getTime() - minsAgo * 60000);
      const suffix = minsAgo === 0 ? '' : `-m${String(minsAgo).padStart(2, '0')}m`;
      return {
        id: `conus_${minsAgo}`,
        tileUrl: `${IEM_BASE}/cache/tile.py/1.0.0/nexrad-n0q-900913${suffix}/{z}/{x}/{y}.png`,
        timestamp: t,
        label: minsAgo === 0 ? 'LIVE (CONUS)' : `-${minsAgo}m · ${formatClock(t)}`,
        feedLabel: 'IEM CONUS High-Res'
      };
    });
  }

  // Single-site NEXRAD RIDGE via IEM (strip leading K for 3-char IEM radar code)
  const site3 = (siteId || 'KGWX').replace(/^K/i, '').toUpperCase();
  const startIso = new Date(now.getTime() - 75 * 60000).toISOString().slice(0, 16) + 'Z';
  const endIso = now.toISOString().slice(0, 16) + 'Z';

  try {
    const res = await fetchJson(
      `${IEM_BASE}/json/radar.py?operation=list&radar=${site3}&product=${productCode}&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`,
      {},
      8000
    );
    const scans = (res?.scans || []).slice(-10);
    if (scans.length > 0) {
      return scans.map((sc, idx) => {
        const tsStr = sc.ts; // e.g. "2026-11-21T12:45Z"
        const d = new Date(tsStr);
        const ridgeTs = tsStr.replace(/[-:TZ]/g, '').slice(0, 12); // YYYYMMDDHHMM
        const isLast = idx === scans.length - 1;
        return {
          id: `ridge_${site3}_${productCode}_${ridgeTs}`,
          tileUrl: `${IEM_BASE}/cache/tile.py/1.0.0/ridge::${site3}-${productCode}-${ridgeTs}/{z}/{x}/{y}.png`,
          timestamp: d,
          label: `${siteId} ${productCode} · ${formatClock(d)}${isLast ? ' (Latest)' : ''}`,
          feedLabel: `IEM RIDGE ${siteId}`
        };
      });
    }
  } catch {
    // fallback to latest live single-site tile
  }

  return [
    {
      id: `ridge_${site3}_${productCode}_0`,
      tileUrl: `${IEM_BASE}/c/tile.py/1.0.0/ridge::${site3}-${productCode}-0/{z}/{x}/{y}.png`,
      timestamp: now,
      label: `${siteId} ${productCode} · LIVE`,
      feedLabel: `IEM RIDGE ${siteId}`
    }
  ];
}

export async function searchLocations(query) {
  const q = query.trim();
  if (!q) return [];
  const url = `${GEOCODE_BASE}?name=${encodeURIComponent(q)}&count=8&language=en&format=json`;
  const data = await fetchJson(url, {}, 8000);
  const results = data?.results || [];
  return results
    .filter((r) => r.country_code === 'US' || results.length <= 3)
    .map((r) => ({
      name: r.admin1 ? `${r.name}, ${r.admin1}` : r.name,
      sub: [r.admin2, r.country].filter(Boolean).join(' • '),
      lat: r.latitude,
      lon: r.longitude
    }));
}

function formatClock(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
