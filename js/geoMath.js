const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_RADIUS_MI = 3958.7613;

export function haversineMiles(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function initialBearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * DEG2RAD;
  const phi2 = lat2 * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (Math.atan2(y, x) * RAD2DEG + 360) % 360;
}

export function destinationPoint(lat, lon, bearingDeg, distanceMiles) {
  const ang = distanceMiles / EARTH_RADIUS_MI;
  const brng = bearingDeg * DEG2RAD;
  const phi1 = lat * DEG2RAD;
  const lam1 = lon * DEG2RAD;
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(ang) + Math.cos(phi1) * Math.sin(ang) * Math.cos(brng)
  );
  const lam2 =
    lam1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(ang) * Math.cos(phi1),
      Math.cos(ang) - Math.sin(phi1) * Math.sin(phi2)
    );
  return { lat: phi2 * RAD2DEG, lon: ((lam2 * RAD2DEG + 540) % 360) - 180 };
}

export function degToCompass(deg) {
  if (deg == null || Number.isNaN(deg)) return '--';
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export function angularDiffDeg(a, b) {
  let diff = ((b - a + 540) % 360) - 180;
  return diff;
}

/**
 * Computes Storm Cell Time-on-Target (TOT) and Closest Point of Approach (CPA)
 * using local tangent-plane vector projection.
 * @param {number} userLat
 * @param {number} userLon
 * @param {number} cellLat
 * @param {number} cellLon
 * @param {number} moveToBearingDeg - Direction storm is moving TOWARD (0=N, 90=E)
 * @param {number} speedMph - Storm ground speed in mph
 */
export function computeStormIntercept(userLat, userLon, cellLat, cellLon, moveToBearingDeg, speedMph) {
  const distMi = haversineMiles(userLat, userLon, cellLat, cellLon);
  const bearingFromUser = initialBearingDeg(userLat, userLon, cellLat, cellLon);
  const bearingToUser = initialBearingDeg(cellLat, cellLon, userLat, userLon);

  if (!speedMph || speedMph < 3 || moveToBearingDeg == null || Number.isNaN(moveToBearingDeg)) {
    return {
      distanceMi: distMi,
      bearingFromUser,
      compassFromUser: degToCompass(bearingFromUser),
      cpaMiles: distMi,
      etaMinutes: null,
      verdict: distMi <= 12 ? 'NEARBY_STATIONARY' : 'STATIONARY',
      verdictLabel: distMi <= 12 ? 'Nearby / Slow-Moving' : 'Slow-Moving'
    };
  }

  // Vector from cell to user (in miles, East = +x, North = +y)
  const relAngleRad = (bearingToUser - moveToBearingDeg) * DEG2RAD;
  const alongTrackMi = distMi * Math.cos(relAngleRad);
  const crossTrackMi = Math.abs(distMi * Math.sin(relAngleRad));

  if (alongTrackMi <= 0) {
    return {
      distanceMi: distMi,
      bearingFromUser,
      compassFromUser: degToCompass(bearingFromUser),
      cpaMiles: distMi,
      etaMinutes: null,
      verdict: 'MOVING_AWAY',
      verdictLabel: 'Moving Away'
    };
  }

  const etaMinutes = Math.round((alongTrackMi / speedMph) * 60);
  let verdict = 'PASSING';
  let verdictLabel = `Passing ${crossTrackMi.toFixed(1)} mi off-track`;

  if (crossTrackMi <= 5 && etaMinutes <= 90) {
    verdict = 'DIRECT_INTERCEPT';
    verdictLabel = `Direct Intercept (CPA ${crossTrackMi.toFixed(1)} mi)`;
  } else if (crossTrackMi <= 12 && etaMinutes <= 90) {
    verdict = 'NEAR_MISS';
    verdictLabel = `Close Pass (CPA ${crossTrackMi.toFixed(1)} mi)`;
  }

  return {
    distanceMi: distMi,
    bearingFromUser,
    compassFromUser: degToCompass(bearingFromUser),
    cpaMiles: crossTrackMi,
    etaMinutes,
    verdict,
    verdictLabel
  };
}

export function buildThreatConePolygon(cellLat, cellLon, moveToBearingDeg, speedMph, minutes = 45) {
  if (!speedMph || speedMph < 5 || moveToBearingDeg == null) return null;
  const travelMi = Math.min(75, Math.max(8, (speedMph * minutes) / 60));
  const spreadDeg = 16;
  const pLeft = destinationPoint(cellLat, cellLon, (moveToBearingDeg - spreadDeg + 360) % 360, travelMi);
  const pMid = destinationPoint(cellLat, cellLon, moveToBearingDeg, travelMi * 1.04);
  const pRight = destinationPoint(cellLat, cellLon, (moveToBearingDeg + spreadDeg) % 360, travelMi);
  return [
    [cellLon, cellLat],
    [pLeft.lon, pLeft.lat],
    [pMid.lon, pMid.lat],
    [pRight.lon, pRight.lat],
    [cellLon, cellLat]
  ];
}

export function geometryCentroid(geometry) {
  if (!geometry) return null;
  let coords = [];
  if (geometry.type === 'Point') return { lon: geometry.coordinates[0], lat: geometry.coordinates[1] };
  if (geometry.type === 'Polygon') coords = geometry.coordinates[0] || [];
  if (geometry.type === 'MultiPolygon') coords = geometry.coordinates?.[0]?.[0] || [];
  if (!coords.length) return null;
  let sumLon = 0, sumLat = 0;
  for (const c of coords) {
    sumLon += c[0];
    sumLat += c[1];
  }
  return { lon: sumLon / coords.length, lat: sumLat / coords.length };
}
