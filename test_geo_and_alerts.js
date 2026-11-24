import {
  assert,
  assertEqual,
  assertClose,
  assertFinite,
  assertNoNaNDeep,
  describe,
  test
} from './test_framework.js';
import * as geoMath from '../js/geoMath.js';
import * as analyzers from '../js/analyzers.js';
import { audioEngine } from '../js/audio.js';

describe('Point-in-Polygon & Geometry Hardening (@alert-auditor)', () => {
  const squarePoly = {
    type: 'Polygon',
    coordinates: [[
      [-89.0, 34.0],
      [-88.0, 34.0],
      [-88.0, 35.0],
      [-89.0, 35.0],
      [-89.0, 34.0]
    ]]
  };

  const diamondPoly = {
    type: 'Polygon',
    coordinates: [[
      [-88.5, 34.0],
      [-88.0, 34.5],
      [-88.5, 35.0],
      [-89.0, 34.5],
      [-88.5, 34.0]
    ]]
  };

  const polyWithHole = {
    type: 'Polygon',
    coordinates: [
      // Outer ring: [-90, 33] to [-87, 36]
      [[-90.0, 33.0], [-87.0, 33.0], [-87.0, 36.0], [-90.0, 36.0], [-90.0, 33.0]],
      // Interior hole: [-89, 34] to [-88, 35]
      [[-89.0, 34.0], [-88.0, 34.0], [-88.0, 35.0], [-89.0, 35.0], [-89.0, 34.0]]
    ]
  };

  const multiPoly = {
    type: 'MultiPolygon',
    coordinates: [
      [[[-90.0, 34.0], [-89.2, 34.0], [-89.2, 34.8], [-90.0, 34.8], [-90.0, 34.0]]],
      [
        [[-88.8, 34.0], [-88.0, 34.0], [-88.0, 34.8], [-88.8, 34.8], [-88.8, 34.0]],
        // Hole inside 2nd polygon
        [[-88.6, 34.2], [-88.2, 34.2], [-88.2, 34.6], [-88.6, 34.6], [-88.6, 34.2]]
      ]
    ]
  };

  const antimeridianPoly = {
    type: 'Polygon',
    coordinates: [[
      [178.0, 50.0],
      [-178.0, 50.0],
      [-178.0, 55.0],
      [178.0, 55.0],
      [178.0, 50.0]
    ]]
  };

  test('Interior, exterior, exact vertex, and exact horizontal/vertical/diagonal edge checks', () => {
    const pip = geoMath.isPointInGeometry;

    // Interior & Exterior
    assertEqual(pip(34.5, -88.5, squarePoly), true, 'Interior point must be INSIDE');
    assertEqual(pip(33.9, -88.5, squarePoly), false, 'South exterior point must be OUTSIDE');
    assertEqual(pip(35.1, -88.5, squarePoly), false, 'North exterior point must be OUTSIDE');
    assertEqual(pip(34.5, -89.1, squarePoly), false, 'West exterior point must be OUTSIDE');
    assertEqual(pip(34.5, -87.9, squarePoly), false, 'East exterior point must be OUTSIDE');

    // Directly on ALL 4 vertices of square
    assertEqual(pip(34.0, -89.0, squarePoly), true, 'SW vertex must be INSIDE');
    assertEqual(pip(34.0, -88.0, squarePoly), true, 'SE vertex must be INSIDE');
    assertEqual(pip(35.0, -88.0, squarePoly), true, 'NE vertex must be INSIDE');
    assertEqual(pip(35.0, -89.0, squarePoly), true, 'NW vertex must be INSIDE');

    // Directly on ALL 4 edges of square
    assertEqual(pip(34.0, -88.5, squarePoly), true, 'South horizontal edge must be INSIDE');
    assertEqual(pip(35.0, -88.5, squarePoly), true, 'North horizontal edge must be INSIDE');
    assertEqual(pip(34.5, -89.0, squarePoly), true, 'West vertical edge must be INSIDE');
    assertEqual(pip(34.5, -88.0, squarePoly), true, 'East vertical edge must be INSIDE');

    // Directly on diagonal edges & vertices of diamond
    assertEqual(pip(34.25, -88.25, diamondPoly), true, 'SE diagonal edge midpoint must be INSIDE');
    assertEqual(pip(34.75, -88.75, diamondPoly), true, 'NW diagonal edge midpoint must be INSIDE');
    assertEqual(pip(34.5, -88.0, diamondPoly), true, 'East diamond vertex must be INSIDE');
    assertEqual(pip(34.0, -88.0, diamondPoly), false, 'Outside diagonal corner must be OUTSIDE');
  });

  test('Polygon with interior hole and MultiPolygon with hole', () => {
    const pip = geoMath.isPointInGeometry;

    // Polygon with hole
    assertEqual(pip(33.5, -88.5, polyWithHole), true, 'In outer ring, outside hole -> INSIDE');
    assertEqual(pip(34.5, -88.5, polyWithHole), false, 'Strictly inside interior hole -> OUTSIDE');
    assertEqual(pip(33.0, -88.5, polyWithHole), true, 'On outer boundary -> INSIDE');

    // MultiPolygon
    assertEqual(pip(34.4, -89.6, multiPoly), true, 'Inside 1st polygon of MultiPolygon');
    assertEqual(pip(34.4, -89.0, multiPoly), false, 'In gap between polygons of MultiPolygon');
    assertEqual(pip(34.1, -88.4, multiPoly), true, 'Inside 2nd polygon outside hole');
    assertEqual(pip(34.4, -88.4, multiPoly), false, 'Inside hole of 2nd polygon -> OUTSIDE');
    assertEqual(pip(34.0, -88.4, multiPoly), true, 'On edge of 2nd polygon -> INSIDE');
  });

  test('Antimeridian (±180°) crossing polygon works accurately on both sides', () => {
    const pip = geoMath.isPointInGeometry;
    assertEqual(pip(52.5, 179.5, antimeridianPoly), true, '179.5°E inside antimeridian box');
    assertEqual(pip(52.5, -179.5, antimeridianPoly), true, '-179.5°W inside antimeridian box');
    assertEqual(pip(52.5, 180.0, antimeridianPoly), true, '180.0° exactly on antimeridian inside box');
    assertEqual(pip(52.5, -180.0, antimeridianPoly), true, '-180.0° exactly on antimeridian inside box');
    assertEqual(pip(52.5, 178.0, antimeridianPoly), true, 'On west edge 178°E -> INSIDE');
    assertEqual(pip(52.5, -178.0, antimeridianPoly), true, 'On east edge -178°W -> INSIDE');
    assertEqual(pip(52.5, 175.0, antimeridianPoly), false, '175°E outside antimeridian box');
    assertEqual(pip(52.5, -175.0, antimeridianPoly), false, '-175°W outside antimeridian box');
    assertEqual(pip(52.5, 0.0, antimeridianPoly), false, 'Prime meridian 0° must be OUTSIDE');
  });

  test('Swapped [lat, lon] and malformed/NaN geometry coordinates are guarded safely without throwing', () => {
    const pip = geoMath.isPointInGeometry;

    // Swapped [lat, lon] where lon slot has |val| > 90 in the 2nd coordinate (impossible latitude -95!)
    const swappedBadLat = {
      type: 'Polygon',
      coordinates: [[
        [34.0, -95.0],
        [34.0, -94.0],
        [35.0, -94.0],
        [35.0, -95.0],
        [34.0, -95.0]
      ]]
    };
    // Must never throw; must return boolean (either cleanly reject impossible lat > 90 -> false, or normalize cleanly)
    const swappedRes = pip(34.5, -94.5, swappedBadLat);
    assert(typeof swappedRes === 'boolean', 'Swapped [lat, lon] must return boolean without throwing');
    // Crucially, querying impossible test point latitude (>90) MUST return false!
    assertEqual(pip(95.0, -88.5, squarePoly), false, 'Impossible test lat > 90 must return false');
    assertEqual(pip(-95.0, -88.5, squarePoly), false, 'Impossible test lat < -90 must return false');
    assertEqual(pip(NaN, -88.5, squarePoly), false, 'NaN lat must return false');
    assertEqual(pip(34.5, NaN, squarePoly), false, 'NaN lon must return false');

    // Malformed rings must return false without throwing
    assertEqual(pip(34.5, -88.5, null), false, 'null geometry');
    assertEqual(pip(34.5, -88.5, { type: 'Polygon', coordinates: [] }), false, 'empty coordinates');
    assertEqual(pip(34.5, -88.5, { type: 'Polygon', coordinates: [[[-88, 34], [-89, 34]]] }), false, '< 3 vertices');
    assertEqual(pip(34.5, -88.5, { type: 'Polygon', coordinates: [[['bad', null], [NaN, Infinity], [null, undefined]]] }), false, 'NaN/null ring');
  });

  test('haversineMiles, computeStormIntercept & geometryCentroid have zero NaN on edge cases', () => {
    assertEqual(geoMath.haversineMiles(34.6581, -88.5667, 34.6581, -88.5667), 0, 'Same point distance === 0');
    assertClose(geoMath.haversineMiles(0, 0, 0, 1), 69.093, 0.2, '1 deg at equator ~69.09 mi');
    const stationary = geoMath.computeStormIntercept(34.65, -88.56, 34.66, -88.57, null, 0);
    assertNoNaNDeep(stationary, 'stationary intercept');
    assertEqual(stationary.verdict, 'NEARBY_STATIONARY');

    const centroidNull = geoMath.geometryCentroid({ type: 'Polygon', coordinates: [] });
    assertEqual(centroidNull, null, 'Empty polygon centroid is null');
    const centroidSq = geoMath.geometryCentroid(squarePoly);
    assertClose(centroidSq.lat, 34.5, 1e-6, 'Square centroid lat exact (closing vertex ignored)');
    assertClose(centroidSq.lon, -88.5, 1e-6, 'Square centroid lon exact (closing vertex ignored)');

    // Regression: overhead storm cell (dist === 0) must be DIRECT_INTERCEPT (eta 0), NOT MOVING_AWAY
    const overhead = geoMath.computeStormIntercept(34.6581, -88.5667, 34.6581, -88.5667, 45, 35);
    assertEqual(overhead.verdict, 'DIRECT_INTERCEPT', 'Overhead storm cell must be DIRECT_INTERCEPT');
    assertEqual(overhead.etaMinutes, 0, 'Overhead storm cell etaMinutes === 0');

    // Regression: angularDiffDeg across 0/360 wrap and large negative values
    assertClose(geoMath.angularDiffDeg(350, 10), 20, 1e-6, '350 -> 10 deg');
    assertClose(geoMath.angularDiffDeg(10, 350), -20, 1e-6, '10 -> 350 deg');
    assertClose(geoMath.angularDiffDeg(720, -360), 0, 1e-6, 'Large negative wrap');

    // Regression: antimeridian polygon centroid lies at +-180, NOT 0
    const antiCentroid = geoMath.geometryCentroid(antimeridianPoly);
    assert(Math.abs(Math.abs(antiCentroid.lon) - 180) < 0.01, `Antimeridian centroid lon must be near ±180, got ${antiCentroid.lon}`);
    assertClose(antiCentroid.lat, 52.5, 1e-6, 'Antimeridian centroid lat');

    // Regression: point directly on hole boundary is handled cleanly (INSIDE) while interior of hole is OUTSIDE
    assertEqual(geoMath.isPointInGeometry(34.0, -88.5, polyWithHole), true, 'Point on interior hole boundary -> INSIDE');
    assertEqual(geoMath.isPointInGeometry(34.5, -88.5, polyWithHole), false, 'Point strictly inside hole -> OUTSIDE');
  });
});

describe('NWS Alert Expiry, Superseding, Deduplication & Classification (@alert-auditor)', () => {
  const nowMs = Date.UTC(2026, 10, 23, 22, 30, 0);
  const homeLat = 34.6581;
  const homeLon = -88.5667;

  function makeAlert(id, overrides = {}) {
    const props = {
      id,
      event: 'Tornado Warning',
      status: 'Actual',
      messageType: 'Alert',
      sent: new Date(nowMs - 5 * 60000).toISOString(),
      effective: new Date(nowMs - 5 * 60000).toISOString(),
      expires: new Date(nowMs + 25 * 60000).toISOString(),
      ends: new Date(nowMs + 25 * 60000).toISOString(),
      headline: `Test ${id}`,
      description: 'Test warning',
      areaDesc: 'Prentiss, MS',
      senderName: 'NWS Memphis TN',
      parameters: {},
      ...(overrides.properties || {})
    };
    return {
      id,
      type: 'Feature',
      geometry: overrides.geometry !== undefined ? overrides.geometry : {
        type: 'Polygon',
        coordinates: [[[-88.75, 34.55], [-88.40, 34.55], [-88.40, 34.78], [-88.75, 34.78], [-88.75, 34.55]]]
      },
      properties: props
    };
  }

  test('Exports isAlertExpired and filterAndDeduplicateAlerts', () => {
    assertEqual(typeof analyzers.isAlertExpired, 'function', 'isAlertExpired must be exported');
    assertEqual(typeof analyzers.filterAndDeduplicateAlerts, 'function', 'filterAndDeduplicateAlerts must be exported');
  });

  test('isAlertExpired immediately rejects expired, exact-boundary, Cancel, and Expired alerts', () => {
    const isExp = analyzers.isAlertExpired;
    assertEqual(isExp(makeAlert('active'), nowMs), false, 'Future expires is active');
    assertEqual(isExp(makeAlert('exp-past', { properties: { expires: new Date(nowMs - 1000).toISOString(), ends: new Date(nowMs - 1000).toISOString() } }), nowMs), true, 'Past expires is expired');
    assertEqual(isExp(makeAlert('exp-exact', { properties: { expires: new Date(nowMs).toISOString(), ends: new Date(nowMs).toISOString() } }), nowMs), true, 'expires === nowMs must be treated as expired');
    assertEqual(isExp(makeAlert('ends-past', { properties: { expires: new Date(nowMs + 60000).toISOString(), ends: new Date(nowMs - 1000).toISOString() } }), nowMs), true, 'Past ends is expired even if expires later');
    assertEqual(isExp(makeAlert('cancel-msg', { properties: { messageType: 'Cancel' } }), nowMs), true, 'messageType=Cancel must be purged');
    assertEqual(isExp(makeAlert('cancel-status', { properties: { status: 'Cancel' } }), nowMs), true, 'status=Cancel must be purged');
    assertEqual(isExp(makeAlert('expired-status', { properties: { status: 'Expired' } }), nowMs), true, 'status=Expired must be purged');
  });

  test('filterAndDeduplicateAlerts purges expired, superseded (references / replacedBy / Cancel), and duplicates', () => {
    const filterAlerts = analyzers.filterAndDeduplicateAlerts;
    const torActive = makeAlert('urn:oid:tor-1');
    const torDup = makeAlert('urn:oid:tor-1');
    const expiredWarn = makeAlert('urn:oid:exp-1', {
      properties: {
        event: 'Severe Thunderstorm Warning',
        expires: new Date(nowMs - 60000).toISOString(),
        ends: new Date(nowMs - 60000).toISOString()
      }
    });
    const oldWarn = makeAlert('urn:oid:svr-old', {
      properties: { event: 'Severe Thunderstorm Warning', sent: new Date(nowMs - 15 * 60000).toISOString() }
    });
    const newerUpdate = makeAlert('urn:oid:svr-new', {
      properties: {
        event: 'Severe Thunderstorm Warning',
        messageType: 'Update',
        sent: new Date(nowMs - 2 * 60000).toISOString(),
        references: [{ identifier: 'urn:oid:svr-old', '@id': 'https://api.weather.gov/alerts/urn:oid:svr-old' }]
      }
    });
    const cancelledTarget = makeAlert('urn:oid:tor-cancelled-target', {
      properties: { sent: new Date(nowMs - 10 * 60000).toISOString() }
    });
    const cancelNotice = makeAlert('urn:oid:tor-cancel-notice', {
      properties: {
        messageType: 'Cancel',
        sent: new Date(nowMs - 1 * 60000).toISOString(),
        references: [{ identifier: 'urn:oid:tor-cancelled-target' }]
      }
    });
    const replacedTarget = makeAlert('urn:oid:svr-replaced', {
      properties: { event: 'Severe Thunderstorm Warning', replacedBy: 'urn:oid:svr-new' }
    });

    const out = filterAlerts(
      [torActive, torDup, expiredWarn, oldWarn, newerUpdate, cancelledTarget, cancelNotice, replacedTarget],
      homeLat,
      homeLon,
      nowMs
    );
    const ids = out.map((a) => a.id);
    assert(ids.includes('urn:oid:tor-1'), 'Active Tornado Warning kept');
    assertEqual(ids.filter((id) => id === 'urn:oid:tor-1').length, 1, 'Duplicate Tornado Warning deduplicated to 1');
    assert(!ids.includes('urn:oid:exp-1'), 'Expired warning purged');
    assert(!ids.includes('urn:oid:svr-old'), 'Warning superseded via references purged');
    assert(ids.includes('urn:oid:svr-new'), 'Superseding Update warning kept');
    assert(!ids.includes('urn:oid:tor-cancelled-target'), 'Warning referenced by Cancel notice purged');
    assert(!ids.includes('urn:oid:tor-cancel-notice'), 'Cancel notice itself purged');
    assert(!ids.includes('urn:oid:svr-replaced'), 'Warning with replacedBy purged');

    const tor = out.find((a) => a.id === 'urn:oid:tor-1');
    assertEqual(tor.tier, 'CRITICAL', 'Tornado Warning is CRITICAL tier');
    assertEqual(tor.insidePolygon, true, 'Point inside synthetic Tornado Warning polygon');
    assertFinite(tor.expiresMs, 'Canonical expiresMs present');
    assertFinite(tor.sentMs, 'Canonical sentMs present');
  });
});

describe('Unit Conversions & Exact Hand-Calculated Severe-Weather Math (@alert-auditor)', () => {
  test('Unit conversion functions match exact meteorological constants and guard null/NaN', () => {
    assertEqual(typeof analyzers.ktToMph, 'function', 'ktToMph exported');
    assertEqual(typeof analyzers.mphToKt, 'function', 'mphToKt exported');
    assertEqual(typeof analyzers.kmhToMph, 'function', 'kmhToMph exported');
    assertEqual(typeof analyzers.mToFeet, 'function', 'mToFeet exported');
    assertEqual(typeof analyzers.mToMiles, 'function', 'mToMiles exported');
    assertEqual(typeof analyzers.cToF, 'function', 'cToF exported');
    assertEqual(typeof analyzers.paToHpa, 'function', 'paToHpa exported');

    assertClose(analyzers.ktToMph(50), 57.539, 0.02, '50 kt -> mph');
    assertClose(analyzers.mphToKt(57.539), 50.0, 0.02, '57.539 mph -> kt');
    assertClose(analyzers.kmhToMph(100), 62.1371, 0.01, '100 km/h -> mph');
    assertClose(analyzers.mToFeet(1000), 3280.84, 0.05, '1000 m -> ft');
    assertClose(analyzers.mToMiles(1609.344), 1.0, 1e-5, '1609.344 m -> 1 mi');
    assertClose(analyzers.cToF(0), 32.0, 1e-6, '0°C -> 32°F');
    assertClose(analyzers.cToF(100), 212.0, 1e-6, '100°C -> 212°F');
    assertClose(analyzers.cToF(-40), -40.0, 1e-6, '-40°C -> -40°F');
    assertClose(analyzers.paToHpa(101325), 1013.25, 1e-4, '101325 Pa -> 1013.25 hPa');

    // Null / NaN safety
    assertEqual(analyzers.cToF(null), null, 'cToF(null) -> null');
    assertEqual(analyzers.kmhToMph(null), null, 'kmhToMph(null) -> null');
    assertEqual(analyzers.paToHpa(null), null, 'paToHpa(null) -> null');
    assert(!Number.isNaN(analyzers.mphToKt(NaN)), 'mphToKt(NaN) must not produce NaN');
    assert(!Number.isNaN(analyzers.ktToMph(NaN)), 'ktToMph(NaN) must not produce NaN');
  });

  test('analyzeEnvironment matches exact hand-calculated CAPE, SRH, 0-6km & 0-1.5km shear, Bunkers RM, LCL, lapse, STP & SCP', () => {
    const nowIso = new Date().toISOString();
    const MPH_PER_KT = 1 / 0.868976; // exact inverse so mphToKt yields exact kt inputs
    const om = {
      hourly_units: { wind_speed_10m: 'mp/h', temperature_2m: '°F' },
      hourly: {
        time: [nowIso],
        cape: [1500],
        convective_inhibition: [-25],
        temperature_2m: [77],   // 25°C
        dew_point_2m: [68],     // 20°C -> LCL = 125 * 5 = 625m (<1000 => lclTerm=1.0)
        wind_speed_10m: [10 * MPH_PER_KT],
        wind_direction_10m: [180],
        wind_speed_925hPa: [25 * MPH_PER_KT],
        wind_direction_925hPa: [210],
        wind_speed_850hPa: [40 * MPH_PER_KT],
        wind_direction_850hPa: [240],
        wind_speed_700hPa: [50 * MPH_PER_KT],
        wind_direction_700hPa: [255],
        wind_speed_500hPa: [60 * MPH_PER_KT],
        wind_direction_500hPa: [270],
        temperature_700hPa: [41], // 5°C
        temperature_500hPa: [5],  // -15°C
        geopotential_height_700hPa: [3000],
        geopotential_height_500hPa: [5500] // dZ = 2.5km -> 20/2.5 = 8.0 C/km
      }
    };
    const current = { tempF: 77, dewpointF: 68, windMph: 10 * MPH_PER_KT, windDirDeg: 180, pressureTrend3h: -2.0 };
    const env = analyzers.analyzeEnvironment(om, current, 0);

    assertNoNaNDeep(env, 'analyzeEnvironment exact');
    assertEqual(env.capeNow, 1500, 'CAPE = 1500');
    assertEqual(env.cinNow, -25, 'CIN = -25');
    assertEqual(env.lowLevelShearKt, 36, '0-1.5km bulk shear = round(36.0555) = 36 kt');
    assertEqual(env.bulkShear0to6KmKt, 61, '0-6km bulk shear = round(60.8276) = 61 kt');
    assertEqual(env.lclMeters, 625, 'Espy LCL = 625 m');
    assertClose(env.lapseRate700to500, 8.0, 0.05, '700-500 hPa lapse rate = 8.0 C/km');
    assertClose(env.bunkersSpeedKt, 29, 1, 'Bunkers RM speed ~29 kt');
    assertClose(env.bunkersHeadingDeg, 92.92, 0.5, 'Bunkers RM heading ~92.9°');
    assertClose(env.srh0to1Km, 169, 2, '0-1 km SRH ~169 m²/s²');
    assertClose(env.srh0to3Km, 343, 2, '0-3 km SRH ~343 m²/s²');
    assertClose(env.stp, 1.7, 0.1, 'Fixed-layer STP = 1.7');
    // Official SPC SCP uses EBWD term capped at 1.0 for >= 20 m/s: (1500/1000)*(343.422/50)*1.0 = 10.3
    assertClose(env.scp, 10.3, 0.2, 'Official SPC Supercell Composite SCP = 10.3');

    // Also verify SCP shear threshold: < 10 m/s (~19.4 kt) -> SCP = 0; 15 m/s (~29.2 kt) -> linear 0.75
    const lowShearOm = {
      hourly_units: { wind_speed_10m: 'mp/h', temperature_2m: '°F' },
      hourly: {
        time: [nowIso],
        cape: [2000],
        convective_inhibition: [0],
        temperature_2m: [80],
        dew_point_2m: [70],
        wind_speed_10m: [5 * MPH_PER_KT],
        wind_direction_10m: [180],
        wind_speed_850hPa: [10 * MPH_PER_KT],
        wind_direction_850hPa: [210],
        wind_speed_500hPa: [12 * MPH_PER_KT],
        wind_direction_500hPa: [240]
      }
    };
    const lowShearEnv = analyzers.analyzeEnvironment(lowShearOm, { tempF: 80, dewpointF: 70 }, 0);
    assertEqual(lowShearEnv.scp, 0, 'SCP must be 0 when 0-6km bulk shear < 10 m/s');
  });

  test('analyzeEnvironment produces ZERO NaN on degenerate/zero-shear/null/extreme-CIN inputs', () => {
    const nowIso = new Date().toISOString();
    // 1. Completely empty / null payload
    const emptyEnv = analyzers.analyzeEnvironment(null, {}, 0);
    assertNoNaNDeep(emptyEnv, 'empty analyzeEnvironment');

    // 2. Zero wind shear (u500 == u0, v500 == v0 -> division-by-zero trap in Bunkers!)
    const zeroShearEnv = analyzers.analyzeEnvironment({
      hourly: {
        time: [nowIso],
        cape: [-50],
        convective_inhibition: [-350],
        temperature_2m: [50],
        dew_point_2m: [60], // dewpoint > temp edge case!
        wind_speed_10m: [0],
        wind_direction_10m: [0],
        wind_speed_850hPa: [0],
        wind_direction_850hPa: [0],
        wind_speed_500hPa: [0],
        wind_direction_500hPa: [0],
        temperature_700hPa: [null],
        temperature_500hPa: [null],
        geopotential_height_700hPa: [3000],
        geopotential_height_500hPa: [3000] // dZ = 0 division-by-zero trap!
      }
    }, { tempF: 50, dewpointF: 60 }, 0);
    assertNoNaNDeep(zeroShearEnv, 'zeroShearEnv');
    assertEqual(zeroShearEnv.stp, 0, 'STP must clamp to 0 on negative CAPE / extreme CIN / zero shear');
    assertEqual(zeroShearEnv.scp, 0, 'SCP must clamp to 0 on zero shear');
    assertEqual(zeroShearEnv.bunkersSpeedKt, 0, 'Calm zero-shear air must NOT produce phantom 7.5 m/s Bunkers motion');
    assert(zeroShearEnv.capeNow >= 0, 'Negative CAPE should clamp cleanly or stay non-NaN');
  });

  test('Regressions for @alert-auditor #33: summer null hourly temp (no 0°F Hard Freeze) & audioEngine play() race', async () => {
    const nowIso = new Date().toISOString();
    // 1. Summer hourly temperatures containing null must NOT coerce null -> 0°F and trigger Hard Freeze!
    const winter = analyzers.analyzeWinterSuite({
      current: { precipitation: 0, weather_code: 0 },
      hourly_units: { temperature_2m: '°F', snowfall: 'inch', freezing_level_height: 'm' },
      hourly: {
        time: [nowIso, new Date(Date.now() + 3600000).toISOString(), new Date(Date.now() + 7200000).toISOString()],
        temperature_2m: [82, null, 79],
        snowfall: [0, null, 0],
        soil_temperature_0cm: [76, 75, 74],
        soil_temperature_6cm: [74, 74, 73],
        freezing_level_height: [4200, 4200, 4200]
      }
    }, { tempF: 82, visibilityMi: 10 }, 32);
    assertEqual(winter.hazardLevel, 'CLEAR', 'Summer null temp must NOT trigger Hard Freeze');
    assertEqual(winter.minTemp24h, 79, 'minTemp24h must ignore null entries');

    // 2. audioEngine play() race: earlier aborted play() rejection must NOT wipe out newer active siren
    const OrigAudio = window.Audio;
    let rejectFirst;
    let callCount = 0;
    window.Audio = class MockAudio {
      constructor(src) { this.src = src; this.loop = false; this.listeners = {}; }
      addEventListener(ev, fn) { this.listeners[ev] = fn; }
      removeEventListener() {}
      pause() {}
      play() {
        callCount += 1;
        if (callCount === 1) {
          return new Promise((_res, rej) => { rejectFirst = rej; });
        }
        return Promise.resolve();
      }
    };
    try {
      const p1 = audioEngine.play('tornado_siren_wail', false);
      const p2 = audioEngine.play('supercell_alert_alarm', false);
      await p2;
      rejectFirst(new Error('Aborted first play'));
      await p1;
      assertEqual(audioEngine.currentId, 'supercell_alert_alarm', 'Second active siren must NOT be wiped by first play rejection');
      audioEngine.stop();
    } finally {
      window.Audio = OrigAudio;
    }
  });

  test('Regressions for #35: resolveCurrentConditions unit-code resilience (NWS WMO & Open-Meteo °C/kmh/ms/kn)', () => {
    const nowIso = new Date().toISOString();

    // Case A: NWS observation with wmoUnit:degC, wmoUnit:km_h-1, wmoUnit:Pa, wmoUnit:m
    const nwsBundle = {
      hourlyPeriods: [{ temperature: 68 }],
      observations: [{
        stationId: 'KTUP',
        props: {
          timestamp: nowIso,
          textDescription: 'Clear',
          temperature: { value: 20.0, unitCode: 'wmoUnit:degC' },       // 68°F
          dewpoint: { value: 10.0, unitCode: 'wmoUnit:degC' },          // 50°F
          relativeHumidity: { value: 52.4 },
          windSpeed: { value: 32.1869, unitCode: 'wmoUnit:km_h-1' },    // 20 mph
          windGust: { value: 10.0, unitCode: 'wmoUnit:m_s-1' },         // 22.37 mph
          windDirection: { value: 180 },
          seaLevelPressure: { value: 101325, unitCode: 'wmoUnit:Pa' },  // 1013.25 hPa / 29.92 inHg
          visibility: { value: 8046.72, unitCode: 'wmoUnit:m' }         // 5.0 mi
        }
      }]
    };
    const omMetric = {
      current_units: {
        temperature_2m: '°C',
        dew_point_2m: '°C',
        apparent_temperature: '°C',
        wind_speed_10m: 'km/h',
        pressure_msl: 'hPa'
      },
      current: {
        time: nowIso,
        temperature_2m: 20.0,       // 68°F
        dew_point_2m: 10.0,         // 50°F
        apparent_temperature: 20.0, // 68°F
        wind_speed_10m: 32.1869,    // 20 mph
        pressure_msl: 1013.25
      },
      hourly_units: { visibility: 'm', pressure_msl: 'hPa' },
      hourly: { time: [nowIso], visibility: [8046.72], pressure_msl: [1013.25] }
    };
    const resA = analyzers.resolveCurrentConditions(nwsBundle, omMetric);
    assertNoNaNDeep(resA, 'resolveCurrentConditions NWS WMO + metric');
    assertEqual(resA.tempF, 68, '20°C -> 68°F');
    assertEqual(resA.dewpointF, 50, '10°C -> 50°F');
    assertEqual(resA.windMph, 20, '32.1869 km/h -> 20 mph');
    assertEqual(resA.gustMph, 22, '10 m/s -> 22 mph');
    assertClose(resA.pressureHpa, 1013.3, 0.1, '101325 Pa -> 1013.3 hPa');
    assertEqual(resA.pressureInHg, '29.92', '1013.25 hPa -> 29.92 inHg');
    assertClose(resA.visibilityMi, 5.0, 0.05, '8046.72 m -> 5.0 mi');

    // Case B: Open-Meteo only with knots ('kn') & m/s wind units + °C temps
    const resKn = analyzers.resolveCurrentConditions(null, {
      current_units: { temperature_2m: '°C', dew_point_2m: '°C', wind_speed_10m: 'kn', wind_gusts_10m: 'm/s', pressure_msl: 'hPa' },
      current: { time: nowIso, temperature_2m: 25.0, dew_point_2m: 15.0, wind_speed_10m: 20.0, wind_gusts_10m: 15.0, pressure_msl: 1008.5 },
      hourly_units: { visibility: 'm', pressure_msl: 'hPa' },
      hourly: { time: [nowIso], visibility: [16093.44], pressure_msl: [1008.5] }
    });
    assertNoNaNDeep(resKn, 'resolveCurrentConditions Open-Meteo kn + m/s');
    assertEqual(resKn.tempF, 77, '25°C -> 77°F');
    assertEqual(resKn.dewpointF, 59, '15°C -> 59°F');
    assertEqual(resKn.windMph, 23, '20 kn -> 23 mph');
    assertEqual(resKn.gustMph, 34, '15 m/s -> 34 mph');
    assertClose(resKn.visibilityMi, 10.0, 0.05, '16093.44 m -> 10.0 mi');
  });

  test('v1.6.0/v1.6.1 CAPE/CIN cap gating: zero-CAPE windy day stays Quiet/Stable & strong CIN (-250) damps score', () => {
    const nowMs = Date.UTC(2026, 10, 23, 21, 0, 0);
    const nowIso = new Date(nowMs).toISOString();
    const MPH_PER_KT = 1 / 0.868976;

    const makeSetup = (capeArr, cinVal, opts = {}) => ({
      hourly_units: { wind_speed_10m: 'mp/h', temperature_2m: '°F' },
      hourly: {
        time: capeArr.map((_, i) => new Date(nowMs + i * 3600000).toISOString()),
        cape: capeArr,
        convective_inhibition: capeArr.map(() => cinVal),
        temperature_2m: capeArr.map(() => 76),
        dew_point_2m: capeArr.map(() => opts.dewF ?? 66),
        wind_speed_10m: capeArr.map(() => 15 * MPH_PER_KT),
        wind_direction_10m: capeArr.map(() => 180),
        wind_speed_925hPa: capeArr.map(() => 32 * MPH_PER_KT),
        wind_direction_925hPa: capeArr.map(() => 205),
        wind_speed_850hPa: capeArr.map(() => 48 * MPH_PER_KT),
        wind_direction_850hPa: capeArr.map(() => 235),
        wind_speed_700hPa: capeArr.map(() => 58 * MPH_PER_KT),
        wind_direction_700hPa: capeArr.map(() => 255),
        wind_speed_500hPa: capeArr.map(() => 70 * MPH_PER_KT),
        wind_direction_500hPa: capeArr.map(() => 270)
      }
    });

    const strongSynopticCurrent = { tempF: 76, dewpointF: 66, windMph: 15 * MPH_PER_KT, windDirDeg: 180, pressureTrend3h: -4.0 };

    // 1. Zero-CAPE windy day (huge shear + strong pressure fall + Td 66, CAPE = 0, mcdCount = 0)
    // MUST stay Quiet / Stable, level 'low', score <= 2, no HSLC, no nocturnal escalation, no proactive alerts!
    const zeroCape = analyzers.analyzeEnvironment(
      makeSetup([0, 0, 0, 0], -10),
      strongSynopticCurrent,
      0,
      { nowMs, convectiveAlertThreshold: 'SENSITIVE', nocturnalReadinessEnabled: true }
    );
    assertNoNaNDeep(zeroCape, 'zeroCape windy day');
    assertEqual(zeroCape.regime, 'Quiet / Stable', 'Zero-CAPE windy day must stay Quiet / Stable');
    assertEqual(zeroCape.level, 'low', 'Zero-CAPE windy day must stay level=low');
    assert(zeroCape.score <= 2, `Zero-CAPE windy day score must be capped <= 2, got ${zeroCape.score}`);
    assertEqual(zeroCape.isHslc, false, 'Zero-CAPE must NOT trigger HSLC');
    assertEqual(zeroCape.nocturnalEscalated, false, 'Zero-CAPE must NOT trigger nocturnal escalation');
    assertEqual(zeroCape.proactiveAlerts.length, 0, 'Zero-CAPE must emit 0 proactive convective alerts');
    assert(zeroCape.bulkShear0to6KmKt >= 45, `Expected strong shear aloft >= 45kt, got ${zeroCape.bulkShear0to6KmKt}`);
    assert(zeroCape.nocturnalRisk.toLowerCase().includes('stable'), `Expected non-convective stable explanation, got: ${zeroCape.nocturnalRisk}`);

    // 2. Strong CIN (-250 J/kg) cap dampening vs uncapped (-10 J/kg) when mcdCount === 0
    const uncapped = analyzers.analyzeEnvironment(
      makeSetup([1500, 1500], -10),
      strongSynopticCurrent,
      0,
      { nowMs }
    );
    const strongCap = analyzers.analyzeEnvironment(
      makeSetup([1500, 1500], -250),
      strongSynopticCurrent,
      0,
      { nowMs }
    );
    assertNoNaNDeep(uncapped, 'uncapped');
    assertNoNaNDeep(strongCap, 'strongCap');
    assertEqual(strongCap.cinNow, -250, 'cinNow preserves -250');
    assertEqual(strongCap.stp, 0, 'Strong CIN (-250) must clamp STP to 0');
    assertEqual(strongCap.score, Math.round(uncapped.score * 0.6), `Strong CIN (-250) must damp score by 0.6x (${uncapped.score} -> ${Math.round(uncapped.score * 0.6)}), got ${strongCap.score}`);
    assert(strongCap.score < uncapped.score, 'Capped score must be strictly lower than uncapped score');

    // 3. Active MCD (mcdCount = 1) overrides CIN dampening
    const strongCapWithMcd = analyzers.analyzeEnvironment(
      makeSetup([1500, 1500], -250),
      strongSynopticCurrent,
      1,
      { nowMs }
    );
    assert(strongCapWithMcd.score > strongCap.score, 'Active MCD must bypass CIN cap dampening');

    // 4. peakCape12h vs capeNow: CAPE=0 now, CAPE=1200 in 4 hours -> instability enabled by 12h outlook
    const futureInstab = analyzers.analyzeEnvironment(
      makeSetup([0, 0, 0, 0, 1200, 1200], -15),
      strongSynopticCurrent,
      0,
      { nowMs }
    );
    assertEqual(futureInstab.capeNow, 0, 'capeNow is 0');
    assertEqual(futureInstab.peakCape12h, 1200, 'peakCape12h captures upcoming 1200 J/kg instability');
    assert(futureInstab.level !== 'low', `Upcoming 1200 CAPE + strong shear should escalate above low, got ${futureInstab.level}`);

    // 5. Dixie Alley HSLC signature (CAPE 350, strong low & deep shear, Td 62°F)
    const hslc = analyzers.analyzeEnvironment(
      makeSetup([350, 350], -10, { dewF: 62 }),
      { ...strongSynopticCurrent, dewpointF: 62 },
      0,
      { nowMs }
    );
    assertEqual(hslc.isHslc, true, 'Classic Dixie Alley HSLC setup must set isHslc=true');
    assert(hslc.regime.includes('HSLC'), `Expected HSLC regime, got ${hslc.regime}`);
    assert(nowIso.endsWith('Z'), 'Sanity check ISO timestamp');
  });

  test('Regressions for @ios-pwa-auditor #41-3 & #41-5: mcdCount=null/NaN CIN cap, America/Chicago nocturnal TZ & audioEngine interrupted resume', async () => {
    const MPH_PER_KT = 1 / 0.868976;
    const makePayload = (nowMs, cape, cin) => ({
      hourly_units: { wind_speed_10m: 'mp/h', temperature_2m: '°F' },
      hourly: {
        time: [new Date(nowMs).toISOString()],
        cape: [cape],
        convective_inhibition: [cin],
        temperature_2m: [76],
        dew_point_2m: [66],
        wind_speed_10m: [15 * MPH_PER_KT],
        wind_direction_10m: [180],
        wind_speed_850hPa: [48 * MPH_PER_KT],
        wind_direction_850hPa: [235],
        wind_speed_500hPa: [70 * MPH_PER_KT],
        wind_direction_500hPa: [270]
      }
    });
    const cur = { tempF: 76, dewpointF: 66, windMph: 15 * MPH_PER_KT, windDirDeg: 180, pressureTrend3h: -3.5 };

    // 1. mcdCount=null or NaN MUST NOT bypass |cinNow| >= 200 cap damping!
    const tsNoonChicago = Date.UTC(2026, 0, 15, 18, 0, 0); // 12:00 PM CST (daytime in Chicago)
    const zeroMcd = analyzers.analyzeEnvironment(makePayload(tsNoonChicago, 1500, -250), cur, 0, { nowMs: tsNoonChicago });
    const nullMcd = analyzers.analyzeEnvironment(makePayload(tsNoonChicago, 1500, -250), cur, null, { nowMs: tsNoonChicago });
    const nanMcd = analyzers.analyzeEnvironment(makePayload(tsNoonChicago, 1500, -250), cur, NaN, { nowMs: tsNoonChicago });
    assertEqual(nullMcd.score, zeroMcd.score, 'mcdCount=null must apply same CIN cap damping as 0');
    assertEqual(nanMcd.score, zeroMcd.score, 'mcdCount=NaN must apply same CIN cap damping as 0');

    // 2. America/Chicago Nocturnal Readiness ignores Pacific/Honolulu host TZ!
    // 2026-01-15T01:00:00Z -> 7:00 PM CST (night in Chicago = escalated!), 3:00 PM HST (day in Honolulu)
    const chicagoNightMs = Date.UTC(2026, 0, 15, 1, 0, 0);
    const chicagoNight = analyzers.analyzeEnvironment(makePayload(chicagoNightMs, 1500, -10), cur, 0, { nowMs: chicagoNightMs });
    assertEqual(chicagoNight.nocturnalEscalated, true, '7 PM CST (3 PM HST) must escalate nocturnal readiness in America/Chicago');

    // 2026-01-15T15:00:00Z -> 9:00 AM CST (day in Chicago = NOT escalated!), 5:00 AM HST (night in Honolulu)
    const chicagoDayMs = Date.UTC(2026, 0, 15, 15, 0, 0);
    const chicagoDay = analyzers.analyzeEnvironment(makePayload(chicagoDayMs, 1500, -10), cur, 0, { nowMs: chicagoDayMs });
    assertEqual(chicagoDay.nocturnalEscalated, false, '9 AM CST (5 AM HST) must NOT escalate nocturnal readiness in America/Chicago');

    // 3. audioEngine.unlockForIOS() resumes an 'interrupted' AudioContext even when unlocked === true!
    const prevCtx = audioEngine.audioCtx;
    const prevUnlocked = audioEngine.unlocked;
    const prevAudioCtxCtor = window.AudioContext;
    let resumeCalls = 0;
    const mockCtx = {
      state: 'interrupted',
      resume: async () => {
        resumeCalls += 1;
        mockCtx.state = 'running';
      },
      createBuffer: () => ({}),
      createBufferSource: () => ({ connect: () => {}, start: () => {} }),
      destination: {}
    };
    window.AudioContext = function MockAudioContext() { return mockCtx; };
    try {
      audioEngine.audioCtx = mockCtx;
      audioEngine.unlocked = true; // Simulate iOS app-switcher interrupt after prior unlock!
      audioEngine.unlockForIOS();
      await new Promise((r) => setTimeout(r, 15));
      assertEqual(resumeCalls, 1, 'unlockForIOS must call resume() on interrupted AudioContext even if unlocked was true');
      assertEqual(audioEngine.unlocked, true, 'unlockForIOS restores unlocked=true after context resumes to running');
    } finally {
      audioEngine.audioCtx = prevCtx;
      audioEngine.unlocked = prevUnlocked;
      window.AudioContext = prevAudioCtxCtor;
    }
  });
});
