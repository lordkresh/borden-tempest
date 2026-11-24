import {
  assert,
  assertEqual,
  assertClose,
  assertNoNaNDeep,
  describe,
  test,
  withMockFetch
} from './test_framework.js';
import * as weatherApi from '../js/weatherApi.js';
import { updater } from '../js/updater.js';

// Valid minimal 1x1 PNG bytes (67 bytes)
const VALID_PNG_BYTES = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0)
);

// Minimal valid GZIP header + body (> 18 bytes)
const VALID_GZIP_BYTES = new Uint8Array([
  0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00
]);

// Genuine ICD 2620001 NEXRAD Level-III binary frame (WMO SDUS header + 18-byte MHB + PDB divider -1 + body)
function buildValidNexradLevel3(msgCode = 153, bodyLen = 128) {
  const header = new TextEncoder().encode('SDUS54 KGWX 232200\r\r\nN0BGWX\r\r\n');
  const msgLen = 18 + 102 + bodyLen; // MHB (18) + PDB (102) + symbology body
  const buf = new Uint8Array(header.length + msgLen);
  buf.set(header, 0);
  const view = new DataView(buf.buffer);
  const off = header.length;
  view.setUint16(off, msgCode, false);         // Message Code 153 = Super-Res Base Refl N0B
  view.setUint32(off + 8, msgLen, false);      // Message Length
  view.setInt16(off + 18, -1, false);          // Product Description Block divider (-1)
  return buf;
}

const VALID_NEXRAD_L3_BYTES = buildValidNexradLevel3(153, 128);
const VALID_NEXRAD_L2_BYTES = new TextEncoder().encode('AR2V0006.480\x00\x00\x00\x00KGWX' + 'A'.repeat(32));

function jsonResponse(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function binaryResponse(bytes, status = 200, contentType = 'image/png') {
  return new Response(bytes, {
    status,
    headers: { 'Content-Type': contentType }
  });
}

describe('Data Pipeline & Network Resilience (@data-auditor)', () => {
  test('Exports required staleness, UTC/Central time, and binary radar helpers', () => {
    assertEqual(weatherApi.STALE_THRESHOLD_MS, 15 * 60 * 1000, 'STALE_THRESHOLD_MS must be 15 minutes');
    assertEqual(typeof weatherApi.parseUtcTimestampMs, 'function', 'parseUtcTimestampMs must be exported');
    assertEqual(typeof weatherApi.formatCentralTime, 'function', 'formatCentralTime must be exported');
    assertEqual(typeof weatherApi.evaluateDataStaleness, 'function', 'evaluateDataStaleness must be exported');
    assertEqual(typeof weatherApi.validateRadarBinaryFrame, 'function', 'validateRadarBinaryFrame must be exported');
    assertEqual(typeof weatherApi.fetchRadarBinaryFrame, 'function', 'fetchRadarBinaryFrame must be exported');
  });

  test('parseUtcTimestampMs parses UTC ISO, offset ISO, naive ISO as UTC, and epoch ms safely', () => {
    const parse = weatherApi.parseUtcTimestampMs;
    const expected = Date.UTC(2026, 10, 23, 22, 15, 0); // 2026-11-23T22:15:00Z
    assertEqual(parse('2026-11-23T22:15:00Z'), expected, 'UTC Z ISO');
    assertEqual(parse('2026-11-23T22:15Z'), expected, 'UTC Z short ISO');
    assertEqual(parse('2026-11-23T16:15:00-06:00'), expected, 'Offset -06:00 ISO');
    assertEqual(parse('2026-11-23T22:15:00'), expected, 'Naive ISO must default strictly to UTC');
    assertEqual(parse('2026-11-23T22:15'), expected, 'Naive short ISO must default strictly to UTC');
    assertEqual(parse(expected), expected, 'Numeric epoch ms');
    assertEqual(parse(new Date(expected)), expected, 'Date instance');
    assertEqual(parse(null), null, 'null returns null');
    assertEqual(parse('not-a-timestamp'), null, 'garbage returns null');
    assertEqual(parse(NaN), null, 'NaN returns null');
  });

  test('formatCentralTime strictly converts UTC to America/Chicago (CST & CDT) regardless of host TZ', () => {
    const fmt = weatherApi.formatCentralTime;
    // Winter (CST = UTC-6): 2026-01-15T20:30:00Z -> 2:30 PM CST
    const winterMs = Date.UTC(2026, 0, 15, 20, 30, 0);
    const winterStr = fmt(winterMs, 'America/Chicago');
    assert(typeof winterStr === 'string' && winterStr.length > 0, 'winter formatted string non-empty');
    assert(winterStr.includes('2:30') && winterStr.toUpperCase().includes('PM'), `Expected 2:30 PM in America/Chicago CST, got "${winterStr}"`);

    // Summer (CDT = UTC-5): 2026-07-15T20:30:00Z -> 3:30 PM CDT
    const summerMs = Date.UTC(2026, 6, 15, 20, 30, 0);
    const summerStr = fmt(summerMs, 'America/Chicago');
    assert(summerStr.includes('3:30') && summerStr.toUpperCase().includes('PM'), `Expected 3:30 PM in America/Chicago CDT, got "${summerStr}"`);

    // Midnight UTC rollover to previous day evening in Chicago (02:05Z -> 8:05 PM CST)
    const midnightRollover = Date.UTC(2026, 0, 16, 2, 5, 0);
    const rollStr = fmt(midnightRollover, 'America/Chicago');
    assert(rollStr.includes('8:05') && rollStr.toUpperCase().includes('PM'), `Expected 8:05 PM CST rollover, got "${rollStr}"`);
  });

  test('evaluateDataStaleness enforces hard >15-minute threshold on radar frames & Open-Meteo', () => {
    const evalStale = weatherApi.evaluateDataStaleness;
    const nowMs = Date.UTC(2026, 10, 23, 22, 30, 0);

    // 1. Fresh (< 15m): 14m 59s old -> NOT stale
    const freshRes = evalStale({
      radarFrames: [{ timestampMs: nowMs - (14 * 60 + 59) * 1000, timestamp: new Date(nowMs - (14 * 60 + 59) * 1000) }],
      openMeteo: { current: { time: new Date(nowMs - 5 * 60 * 1000).toISOString() }, _meta: { fetchedAtMs: nowMs - 2 * 60 * 1000, latestModelTimeMs: nowMs - 5 * 60 * 1000 } },
      nowMs
    });
    assertEqual(freshRes.isStale, false, 'Fresh data (<15m) must NOT be stale');
    assert(Array.isArray(freshRes.staleSources) && freshRes.staleSources.length === 0, 'Fresh staleSources must be empty');

    // 2. Stale Radar (> 15m): 16m old radar, fresh Open-Meteo -> MUST be stale
    const staleRadar = evalStale({
      radarFrames: [
        { timestampMs: nowMs - 36 * 60 * 1000, timestamp: new Date(nowMs - 36 * 60 * 1000) },
        { timestampMs: nowMs - 16 * 60 * 1000, timestamp: new Date(nowMs - 16 * 60 * 1000) }
      ],
      openMeteo: { current: { time: new Date(nowMs - 3 * 60 * 1000).toISOString() }, _meta: { fetchedAtMs: nowMs - 60 * 1000, latestModelTimeMs: nowMs - 3 * 60 * 1000 } },
      nowMs
    });
    assertEqual(staleRadar.isStale, true, 'Radar >15m MUST trigger isStale=true');
    assert(staleRadar.staleSources.length >= 1, 'staleSources must list radar');
    assert(typeof staleRadar.summary === 'string' && staleRadar.summary.length > 0, 'summary must be descriptive');

    // 3. Stale Open-Meteo (> 15m): fresh radar, 20m old Open-Meteo -> MUST be stale
    const staleOm = evalStale({
      radarFrames: [{ timestampMs: nowMs - 2 * 60 * 1000, timestamp: new Date(nowMs - 2 * 60 * 1000) }],
      openMeteo: { current: { time: new Date(nowMs - 20 * 60 * 1000).toISOString() }, _meta: { fetchedAtMs: nowMs - 20 * 60 * 1000, latestModelTimeMs: nowMs - 20 * 60 * 1000 } },
      nowMs
    });
    assertEqual(staleOm.isStale, true, 'Open-Meteo >15m MUST trigger isStale=true');
    assert(staleOm.staleSources.length >= 1, 'staleSources must list Open-Meteo');

    // 4. Exact boundary: 15m + 1ms -> stale
    const edgeStale = evalStale({
      radarFrames: [{ timestampMs: nowMs - (15 * 60 * 1000 + 1), timestamp: new Date(nowMs - (15 * 60 * 1000 + 1)) }],
      openMeteo: { current: { time: new Date(nowMs - 1000).toISOString() }, _meta: { fetchedAtMs: nowMs - 1000, latestModelTimeMs: nowMs - 1000 } },
      nowMs
    });
    assertEqual(edgeStale.isStale, true, '15m + 1ms must be strictly > 15m stale');

    // 5. Empty / null inputs must never throw or return NaN
    const emptyRes = evalStale({ nowMs });
    assertNoNaNDeep(emptyRes, 'evaluateDataStaleness empty');
  });

  test('validateRadarBinaryFrame accepts valid PNG/GZIP/NEXRAD L3 and rejects truncated/corrupted frames', () => {
    const validate = weatherApi.validateRadarBinaryFrame;

    // Valid frames
    const pngOk = validate(VALID_PNG_BYTES.buffer, 'image/png');
    assertEqual(pngOk.valid, true, `Valid PNG should pass: ${JSON.stringify(pngOk)}`);

    const gzOk = validate(VALID_GZIP_BYTES.buffer, 'application/gzip');
    assertEqual(gzOk.valid, true, `Valid GZIP should pass: ${JSON.stringify(gzOk)}`);

    const l3Ok = validate(VALID_NEXRAD_L3_BYTES.buffer, 'application/octet-stream');
    assertEqual(l3Ok.valid, true, `Valid NEXRAD Level-III should pass: ${JSON.stringify(l3Ok)}`);

    const l2Ok = validate(VALID_NEXRAD_L2_BYTES.buffer, 'application/octet-stream');
    assertEqual(l2Ok.valid, true, `Valid NEXRAD Level-II should pass: ${JSON.stringify(l2Ok)}`);

    // Truncated NEXRAD Level-III (declared msgLen larger than received bytes) must be rejected
    const truncL3 = VALID_NEXRAD_L3_BYTES.slice(0, 64);
    assertEqual(validate(truncL3.buffer, 'application/octet-stream').valid, false, 'Truncated NEXRAD Level-III must be rejected');

    // Corrupted NEXRAD Level-III PDB divider must be rejected
    const badPdbL3 = new Uint8Array(VALID_NEXRAD_L3_BYTES);
    const hdrLen = new TextEncoder().encode('SDUS54 KGWX 232200\r\r\nN0BGWX\r\r\n').length;
    new DataView(badPdbL3.buffer).setInt16(hdrLen + 18, 42, false);
    assertEqual(validate(badPdbL3.buffer, 'application/octet-stream').valid, false, 'Bad NEXRAD PDB divider must be rejected');

    // Invalid / corrupted / truncated frames
    const emptyRes = validate(new ArrayBuffer(0), 'image/png');
    assertEqual(emptyRes.valid, false, 'Empty 0-byte buffer must be rejected');

    const truncatedPng = VALID_PNG_BYTES.slice(0, 20); // valid PNG header, missing IEND
    const truncRes = validate(truncatedPng.buffer, 'image/png');
    assertEqual(truncRes.valid, false, 'Truncated PNG missing IEND must be rejected');

    const htmlAsPng = new TextEncoder().encode('<html><body>503 Service Unavailable</body></html>');
    const htmlRes = validate(htmlAsPng.buffer, 'image/png');
    assertEqual(htmlRes.valid, false, 'HTML error page disguised as image/png must be rejected');

    const badMagic = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]);
    const badRes = validate(badMagic.buffer, 'application/octet-stream');
    assertEqual(badRes.valid, false, 'Corrupt random 8-byte binary must be rejected');
  });

  test('fetchRadarBinaryFrame fast-fails on 404 & CORS, retries bounded on 503, rejects truncated binary, and aborts on timeout', async () => {
    const fetchBin = weatherApi.fetchRadarBinaryFrame;

    // 1. 404 fails fast (1 attempt only, NO retry storm)
    let attempts404 = 0;
    await withMockFetch(async () => {
      attempts404 += 1;
      return new Response('Not Found', { status: 404 });
    }, async () => {
      const res = await fetchBin('https://unidata-nexrad-level3.s3.amazonaws.com/missing.bin', { maxRetries: 3, retryBaseDelayMs: 5 });
      assertEqual(res.ok, false, '404 must return ok:false');
      assertEqual(attempts404, 1, `404 must fail fast on 1 attempt, got ${attempts404}`);
    });

    // 2. 503 retries bounded with backoff and succeeds when 3rd attempt returns valid PNG
    let attempts503 = 0;
    const timestamps503 = [];
    await withMockFetch(async () => {
      attempts503 += 1;
      timestamps503.push(performance.now());
      if (attempts503 < 3) return new Response('Busy', { status: 503 });
      return binaryResponse(VALID_PNG_BYTES, 200, 'image/png');
    }, async () => {
      const res = await fetchBin('https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/test.png', { maxRetries: 3, retryBaseDelayMs: 15 });
      assertEqual(res.ok, true, `Should succeed on 3rd attempt after 503s: ${JSON.stringify(res)}`);
      assertEqual(attempts503, 3, 'Should make exactly 3 attempts');
      assert(timestamps503[2] - timestamps503[0] >= 15, 'Backoff delay should occur between retries');
    });

    // 3. Persistent 503 stops after bounded retries without throwing unhandled rejection
    let attemptsPersist = 0;
    await withMockFetch(async () => {
      attemptsPersist += 1;
      return new Response('Service Unavailable', { status: 503 });
    }, async () => {
      const res = await fetchBin('https://unidata-nexrad-level3.s3.amazonaws.com/down.bin', { maxRetries: 2, retryBaseDelayMs: 5 });
      assertEqual(res.ok, false, 'Persistent 503 must return ok:false');
      assert(attemptsPersist <= 3, `Retries must be bounded (<=3), got ${attemptsPersist}`);
    });

    // 4. CORS / network drop (TypeError: Failed to fetch) degrades cleanly
    await withMockFetch(async () => {
      throw new TypeError('Failed to fetch');
    }, async () => {
      const res = await fetchBin('https://unidata-nexrad-level3.s3.amazonaws.com/cors.bin', { maxRetries: 1, retryBaseDelayMs: 5 });
      assertEqual(res.ok, false, 'Network/CORS drop must degrade cleanly with ok:false');
    });

    // 5. Truncated binary frame rejected cleanly
    await withMockFetch(async () => {
      return binaryResponse(VALID_PNG_BYTES.slice(0, 16), 200, 'image/png');
    }, async () => {
      const res = await fetchBin('https://mesonet.agron.iastate.edu/cache/tile.py/trunc.png', { maxRetries: 1, retryBaseDelayMs: 5 });
      assertEqual(res.ok, false, 'Truncated PNG must return ok:false');
    });

    // 6. Timeout abort triggers AbortController cleanly
    await withMockFetch(async (_url, init) => {
      return new Promise((_resolve, reject) => {
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }
      });
    }, async () => {
      const t0 = performance.now();
      const res = await fetchBin('https://unidata-nexrad-level3.s3.amazonaws.com/hang.bin', { timeoutMs: 40, maxRetries: 0 });
      const elapsed = performance.now() - t0;
      assertEqual(res.ok, false, 'Timed-out fetch must return ok:false');
      assert(elapsed < 1000, `Timeout should abort promptly, took ${elapsed}ms`);
    });

    // 7. Content-Length truncation mismatch rejected cleanly & fallbackUrl recovery works
    await withMockFetch(async (url) => {
      if (url.includes('primary.png')) {
        return new Response(VALID_PNG_BYTES.slice(0, 20), {
          status: 200,
          headers: { 'Content-Type': 'image/png', 'Content-Length': '67' }
        });
      }
      return binaryResponse(VALID_PNG_BYTES, 200, 'image/png');
    }, async () => {
      const res = await fetchBin('https://unidata-nexrad-level3.s3.amazonaws.com/primary.png', {
        maxRetries: 0,
        fallbackUrl: 'https://mesonet.agron.iastate.edu/cache/tile.py/fallback.png'
      });
      assertEqual(res.ok, true, 'Fallback URL should recover when primary returns truncated Content-Length');
      assertEqual(res.usedFallback, true, 'usedFallback should be true');
    });
  });

  test('Public fetchers attach _meta timestamps, do not poison TTL cache on error, and have zero unhandled rejections offline', async () => {
    // 1. Offline / mid-fetch drop: fetchIemStormIntel & fetchNwsAlerts & buildRadarFrames degrade cleanly
    await withMockFetch(async () => {
      throw new TypeError('Network dropped mid-fetch');
    }, async () => {
      const intel = await weatherApi.fetchIemStormIntel(1, { force: true });
      assert(intel && intel.stormCellsGeoJson && Array.isArray(intel.stormCellsGeoJson.features), 'IEM intel fallback valid');

      const alerts = await weatherApi.fetchNwsAlerts(34.6581, -88.5667, 'MS');
      assert(alerts && Array.isArray(alerts.localFeatures) && Array.isArray(alerts.regionalFeatures), 'NWS alerts fallback valid');

      const frames = await weatherApi.buildRadarFrames('N0B', 'KGWX');
      assert(Array.isArray(frames) && frames.length >= 1, 'Radar frames fallback returns at least 1 frame');
    });

    // 2. Cache non-poisoning: first call fails 503, second call succeeds 200
    let spcCalls = 0;
    await withMockFetch(async () => {
      spcCalls += 1;
      if (spcCalls <= 4) return new Response('503', { status: 503 });
      return jsonResponse({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { LABEL: 'SLGT' } }] });
    }, async () => {
      const first = await weatherApi.fetchSpcOverlayLayer(3, true);
      assertEqual(first.features.length, 0, 'Failed SPC fetch falls back to empty FC');
      // Now next call (even without force!) must NOT be stuck with a poisoned cached error
      const second = await weatherApi.fetchSpcOverlayLayer(3, false);
      assertEqual(second.features.length, 1, 'Subsequent fetch must succeed because failed call did not poison TTL cache');
    });

    // 3. fetchOpenMeteo & buildRadarFrames attach _meta / timestampMs
    const nowIso = new Date().toISOString();
    await withMockFetch(async (url) => {
      if (url.includes('open-meteo.com')) {
        return jsonResponse({
          current: { time: nowIso, temperature_2m: 72 },
          hourly: { time: [nowIso], temperature_2m: [72] }
        });
      }
      if (url.includes('radar.py')) {
        return jsonResponse({ scans: [{ ts: nowIso.slice(0, 16) + 'Z' }] });
      }
      return jsonResponse({});
    }, async () => {
      const om = await weatherApi.fetchOpenMeteo(34.6581, -88.5667);
      assert(om && om._meta && typeof om._meta.fetchedAtMs === 'number', 'fetchOpenMeteo must attach _meta.fetchedAtMs');

      const frames = await weatherApi.buildRadarFrames('N0B', 'KGWX');
      assert(frames.length > 0, 'buildRadarFrames returned frames');
      assert(frames[0].timestamp instanceof Date || typeof frames[0].timestampMs === 'number', 'Radar frame has normalized timestamp');
    });
  });

  test('updater.checkForUpdates handles 503, network errors, and timeouts gracefully without throwing', async () => {
    await withMockFetch(async () => {
      return new Response('Service Unavailable', { status: 503 });
    }, async () => {
      const r = await updater.checkForUpdates(true);
      assertEqual(r.status, 'ERROR', '503 update check must return ERROR cleanly');
    });

    await withMockFetch(async () => {
      throw new TypeError('Offline');
    }, async () => {
      const r = await updater.checkForUpdates(true);
      assertEqual(r.status, 'ERROR', 'Offline update check must return ERROR cleanly');
    });
  });

  test('Regressions for @data-auditor #31 fixes: undefined-id alerts, compact IEM UTC, utc_offset_seconds, omitted siteId fallback', async () => {
    // 1. Compact 12-digit IEM UTC timestamp
    assertEqual(weatherApi.parseUtcTimestampMs('202611232215'), Date.UTC(2026, 10, 23, 22, 15, 0), '12-digit compact UTC');

    // 2. Alert dedupe must NOT drop multiple alerts missing id
    await withMockFetch(async (url) => {
      if (url.includes('area=MS')) {
        return jsonResponse({
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', properties: { event: 'Wind Advisory', sent: '2026-11-23T22:00:00Z' } },
            { type: 'Feature', properties: { event: 'Flood Advisory', sent: '2026-11-23T22:05:00Z' } }
          ]
        });
      }
      return jsonResponse({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { event: 'Freeze Watch', sent: '2026-11-23T22:00:00Z' } }] });
    }, async () => {
      const res = await weatherApi.fetchNwsAlerts(34.6581, -88.5667, 'MS');
      assertEqual(res.regionalFeatures.length, 3, 'Alerts without id must NOT collide on undefined in dedupe Set');
    });

    // 3. Open-Meteo utc_offset_seconds normalization (-21600 = CST UTC-6) -> 16:00 local = 22:00Z
    await withMockFetch(async () => {
      return jsonResponse({
        utc_offset_seconds: -21600,
        current: { time: '2026-11-23T16:00', temperature_2m: 70 },
        hourly: { time: ['2026-11-23T16:00'], temperature_2m: [70] }
      });
    }, async () => {
      const om = await weatherApi.fetchOpenMeteo(34.6581, -88.5667);
      assertEqual(om.current.time, '2026-11-23T22:00:00.000Z', 'Open-Meteo naive local time normalized to UTC via utc_offset_seconds');
      assertEqual(om._meta.latestModelTimeMs, Date.UTC(2026, 10, 23, 22, 0, 0), 'latestModelTimeMs matches normalized UTC');
    });

    // 4. buildRadarFrames with omitted siteId uses normalized rawSite ('KGWX'), never 'undefined'
    await withMockFetch(async () => new Response('503', { status: 503 }), async () => {
      const frames = await weatherApi.buildRadarFrames('N0B', undefined, { maxRetries: 0 });
      assert(!frames[0].label.includes('undefined'), `Radar frame label must not contain 'undefined': ${frames[0].label}`);
      assert(frames[0].label.includes('KGWX'), `Radar frame label should default to KGWX: ${frames[0].label}`);
    });
  });

  test('Regressions for #35: fetchNwsAfd 64-entry cache cap & fetchIemStormIntel expired wpc_ero eviction', async () => {
    weatherApi.clearWeatherApiCache();

    // 1. fetchNwsAfd respects 64-entry cache cap & degrades cleanly on malformed payloads
    const fetchCounts = new Map();
    await withMockFetch(async (url) => {
      if (url.includes('/locations/BAD')) {
        return jsonResponse({ unexpected: true });
      }
      const locMatch = url.match(/\/locations\/(CWA\d+)/);
      if (locMatch) {
        const key = locMatch[1];
        fetchCounts.set(key, (fetchCounts.get(key) || 0) + 1);
        return jsonResponse({ '@graph': [{ id: `prod_${key}` }] });
      }
      if (url.includes('/products/prod_')) {
        return jsonResponse({
          issuanceTime: '2026-11-23T22:00:00Z',
          issuingOffice: 'NWS Test',
          productText: '.SYNOPSIS...\nTest AFD text.'
        });
      }
      return jsonResponse({});
    }, async () => {
      // Malformed/missing AFD returns null cleanly
      const bad = await weatherApi.fetchNwsAfd('BAD', false, { maxRetries: 0 });
      assertEqual(bad, null, 'Malformed AFD list must return null cleanly');

      // Populate 66 distinct CWAs (exceeds 64-entry cap -> oldest CWA00 must be evicted)
      for (let i = 0; i < 66; i++) {
        const cwa = `CWA${String(i).padStart(2, '0')}`;
        const res = await weatherApi.fetchNwsAfd(cwa, false, { maxRetries: 0 });
        assert(res && res.fullText.includes('Test AFD'), `AFD ${cwa} fetched`);
      }
      assertEqual(fetchCounts.get('CWA00'), 1, 'CWA00 fetched once initially');
      assertEqual(fetchCounts.get('CWA65'), 1, 'CWA65 fetched once initially');

      // Re-fetching newest CWA65 should hit cache (still 1 fetch)
      await weatherApi.fetchNwsAfd('CWA65', false, { maxRetries: 0 });
      assertEqual(fetchCounts.get('CWA65'), 1, 'Newest CWA65 should remain cached');

      // Re-fetching oldest CWA00 MUST refetch because 64-entry cap evicted it!
      await weatherApi.fetchNwsAfd('CWA00', false, { maxRetries: 0 });
      assertEqual(fetchCounts.get('CWA00'), 2, 'Oldest CWA00 must have been evicted by 64-entry cache cap');
    });

    // 2. fetchIemStormIntel does NOT reuse an expired wpc_ero cache entry
    weatherApi.clearWeatherApiCache();
    let wpcFetchCount = 0;
    await withMockFetch(async (url) => {
      if (url.includes('wpc_precip_hazards')) {
        wpcFetchCount += 1;
        return jsonResponse({
          type: 'FeatureCollection',
          features: [{ type: 'Feature', properties: { OUTLOOK: wpcFetchCount === 1 ? 'SLGT' : 'ENH' }, geometry: null }]
        });
      }
      return jsonResponse({ type: 'FeatureCollection', features: [] });
    }, async () => {
      const initial = await weatherApi.fetchIemStormIntel(1, { includeFlood: true, force: true, maxRetries: 0 });
      assertEqual(initial.wpcFloodGeoJson.features.length, 1, 'Initial WPC flood loaded');
      assertEqual(wpcFetchCount, 1, 'WPC fetched once');

      // Within TTL: includeFlood=false reuses valid cached wpc_ero
      const cached = await weatherApi.fetchIemStormIntel(1, { includeFlood: false, maxRetries: 0 });
      assertEqual(cached.wpcFloodGeoJson.features[0]?.properties?.OUTLOOK, 'SLGT', 'Fresh cached wpc_ero reused');

      // Advance Date.now() past 15-minute TTL -> MUST NOT reuse expired wpc_ero!
      const origNow = Date.now;
      const futureMs = origNow() + 16 * 60 * 1000;
      Date.now = () => futureMs;
      try {
        const afterExpiryNoFetch = await weatherApi.fetchIemStormIntel(1, { includeFlood: false, maxRetries: 0 });
        assertEqual(afterExpiryNoFetch.wpcFloodGeoJson.features.length, 0, 'Expired wpc_ero must NOT be reused when includeFlood=false');

        const afterExpiryRefetch = await weatherApi.fetchIemStormIntel(1, { includeFlood: true, maxRetries: 0 });
        assertEqual(wpcFetchCount, 2, 'Expired wpc_ero must re-fetch when includeFlood=true');
        assertEqual(afterExpiryRefetch.wpcFloodGeoJson.features[0]?.properties?.OUTLOOK, 'ENH', 'Refetched fresh WPC payload returned');
      } finally {
        Date.now = origNow;
      }
    });
  });

  test('Regressions for #35: updater.js malformed schema, stalled timeout & idempotent init() listener guard', async () => {
    // 1. Non-JSON / HTML response rejected cleanly
    await withMockFetch(async () => {
      return new Response('<html>502 Bad Gateway</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    }, async () => {
      const r = await updater.checkForUpdates(true, { force: true, maxRetries: 0 });
      assertEqual(r.status, 'ERROR', 'Non-JSON manifest must return ERROR');
      assertEqual(r.errorCode, 'INVALID_JSON', `Expected INVALID_JSON, got ${r.errorCode}`);
    });

    // 2. JSON missing numeric versionCode rejected cleanly
    await withMockFetch(async () => {
      return jsonResponse({ versionName: '2.0.0' });
    }, async () => {
      const r = await updater.checkForUpdates(true, { force: true, maxRetries: 0 });
      assertEqual(r.status, 'ERROR', 'Missing versionCode must return ERROR');
      assertEqual(r.errorCode, 'INVALID_MANIFEST', `Expected INVALID_MANIFEST, got ${r.errorCode}`);
    });

    // 3. Stalled fetch aborts cleanly on timeout without throwing
    await withMockFetch(async (_url, init) => {
      return new Promise((_resolve, reject) => {
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }
      });
    }, async () => {
      const t0 = performance.now();
      const r = await updater.checkForUpdates(true, { force: true, timeoutMs: 40, maxRetries: 0 });
      const elapsed = performance.now() - t0;
      assertEqual(r.status, 'ERROR', 'Stalled manifest fetch must return ERROR');
      assertEqual(r.errorCode, 'TIMEOUT', `Expected TIMEOUT, got ${r.errorCode}`);
      assert(elapsed < 800, `Timeout should abort promptly, took ${elapsed}ms`);
    });

    // 4. Calling updater.init() multiple times MUST NOT stack duplicate updatefound listeners
    let registerCalls = 0;
    let updateFoundListeners = 0;
    const fakeReg = {
      installing: null,
      waiting: null,
      update: async () => {},
      addEventListener: (ev, _fn) => {
        if (ev === 'updatefound') updateFoundListeners += 1;
      }
    };
    const origSwDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'serviceWorker');
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: null,
        register: async () => {
          registerCalls += 1;
          return fakeReg;
        }
      }
    });
    try {
      await withMockFetch(async () => jsonResponse({ versionCode: 8, versionName: '1.6.1' }), async () => {
        await updater.init(() => {});
        await updater.init(() => {});
        await updater.init(() => {});
      });
      assertEqual(registerCalls, 1, `updater.init() called 3x must register SW only once, got ${registerCalls}`);
      assertEqual(updateFoundListeners, 1, `updater.init() called 3x must attach updatefound listener only once, got ${updateFoundListeners}`);
    } finally {
      if (origSwDesc) {
        Object.defineProperty(navigator, 'serviceWorker', origSwDesc);
      } else {
        delete navigator.serviceWorker;
      }
    }
  });

  test('Regressions for @ios-pwa-auditor #41-2: NWS cached-points offline throw, IEM null cellsFetchedAtMs, NEXRAD msgLen<18, PNG missing IDAT, Central hour helpers', async () => {
    // 1. NEXRAD Level-III with msgLen === 0 or < 18 must be rejected
    const zeroLenL3 = new Uint8Array(VALID_NEXRAD_L3_BYTES);
    const hdrLen = new TextEncoder().encode('SDUS54 KGWX 232200\r\r\nN0BGWX\r\r\n').length;
    new DataView(zeroLenL3.buffer).setUint32(hdrLen + 8, 0, false);
    assertEqual(weatherApi.validateRadarBinaryFrame(zeroLenL3.buffer, 'application/octet-stream').valid, false, 'NEXRAD Level-III msgLen=0 must be rejected');

    const shortLenL3 = new Uint8Array(VALID_NEXRAD_L3_BYTES);
    new DataView(shortLenL3.buffer).setUint32(hdrLen + 8, 12, false);
    assertEqual(weatherApi.validateRadarBinaryFrame(shortLenL3.buffer, 'application/octet-stream').valid, false, 'NEXRAD Level-III msgLen=12 (<18) must be rejected');

    // 2. PNG with signature + IHDR + IEND but missing IDAT chunk must be rejected
    const pngNoIdat = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR len=13
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
      0x1f, 0x15, 0xc4, 0x89,                         // IHDR CRC
      0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, // IEND len=0
      0xae, 0x42, 0x60, 0x82                          // IEND CRC
    ]);
    assertEqual(weatherApi.validateRadarBinaryFrame(pngNoIdat.buffer, 'image/png').valid, false, 'PNG missing IDAT chunk must be rejected');

    // 3. formatCentralHour & getCentralHour24 ignore Pacific/Honolulu host TZ
    assertEqual(typeof weatherApi.formatCentralHour, 'function', 'formatCentralHour exported');
    assertEqual(typeof weatherApi.getCentralHour24, 'function', 'getCentralHour24 exported');
    // 2026-01-15T01:00:00Z = 7:00 PM CST (hour 19)
    assertEqual(weatherApi.getCentralHour24(Date.UTC(2026, 0, 15, 1, 0, 0), 'America/Chicago'), 19, '01:00Z winter -> 19 in Chicago');
    // 2026-07-15T01:00:00Z = 8:00 PM CDT (hour 20)
    assertEqual(weatherApi.getCentralHour24(Date.UTC(2026, 6, 15, 1, 0, 0), 'America/Chicago'), 20, '01:00Z summer -> 20 in Chicago');
    const hrStr = weatherApi.formatCentralHour(Date.UTC(2026, 0, 15, 1, 0, 0), 'America/Chicago');
    assert(hrStr.includes('7') && hrStr.toUpperCase().includes('PM'), `Expected 7 PM CST, got ${hrStr}`);

    // 4. fetchNwsPointBundle: cached /points/ + all live forecast/hourly/obs failing offline MUST throw NWS_OFFLINE
    weatherApi.clearWeatherApiCache();
    let offlineMode = false;
    await withMockFetch(async (url) => {
      if (offlineMode) throw new TypeError('Offline');
      if (url.includes('/points/')) {
        return jsonResponse({
          properties: {
            cwa: 'MEG',
            radarStation: 'KGWX',
            forecast: 'https://api.weather.gov/gridpoints/MEG/88,41/forecast',
            forecastHourly: 'https://api.weather.gov/gridpoints/MEG/88,41/forecast/hourly',
            observationStations: 'https://api.weather.gov/gridpoints/MEG/88,41/stations',
            relativeLocation: { properties: { city: 'Booneville', state: 'MS' } }
          }
        });
      }
      if (url.endsWith('/forecast') || url.endsWith('/forecast/hourly')) {
        return jsonResponse({ properties: { periods: [{ temperature: 72 }] } });
      }
      if (url.endsWith('/stations')) {
        return jsonResponse({ features: [{ properties: { stationIdentifier: 'KTUP' } }] });
      }
      return jsonResponse({ properties: { timestamp: new Date().toISOString(), temperature: { value: 22, unitCode: 'wmoUnit:degC' } } });
    }, async () => {
      // Warm 6h /points/ cache first
      const warm = await weatherApi.fetchNwsPointBundle(34.6581, -88.5667, { maxRetries: 0 });
      assertEqual(warm.cwa, 'MEG', 'Initial NWS point bundle succeeded');

      // Now go completely offline -> /points/ hits 6h cache, but live forecast/hourly/obs all fail -> MUST throw!
      offlineMode = true;
      let threwOffline = false;
      try {
        await weatherApi.fetchNwsPointBundle(34.6581, -88.5667, { maxRetries: 0 });
      } catch (err) {
        threwOffline = err && (err.code === 'NWS_OFFLINE' || String(err.message).toLowerCase().includes('offline'));
      }
      assertEqual(threwOffline, true, 'Cached /points/ with zero live NWS fetches must throw NWS_OFFLINE');
    });

    // 5. fetchIemStormIntel offline: _meta.fetchedAtMs must be null (NOT fabricated Date.now()) and anyCoreFeedSucceeded=false
    weatherApi.clearWeatherApiCache();
    await withMockFetch(async () => {
      throw new TypeError('Offline');
    }, async () => {
      const intel = await weatherApi.fetchIemStormIntel(1, { force: true, maxRetries: 0 });
      assertEqual(intel._meta.fetchedAtMs, null, 'Failed nexrad_attr.geojson must set _meta.fetchedAtMs=null');
      assertEqual(intel._meta.anyCoreFeedSucceeded, false, 'Failed IEM storm intel must set anyCoreFeedSucceeded=false');
      assert(Array.isArray(intel._meta.succeededFeeds) && intel._meta.succeededFeeds.length === 0, 'Failed IEM storm intel must have empty succeededFeeds');
    });
  });

  test('Regressions for @ios-pwa-auditor #41-4: updater Retry-After support & already-waiting SW surfaced on relaunch', async () => {
    // 1. Retry-After header honored on 503 before recovering on 2nd attempt
    let tries = 0;
    const t0 = performance.now();
    await withMockFetch(async () => {
      tries += 1;
      if (tries === 1) {
        return new Response('Busy', { status: 503, headers: { 'Retry-After': '0' } });
      }
      return jsonResponse({ versionCode: 8, versionName: '1.6.1', publishedAt: '2026-11-24T04:45:00Z' });
    }, async () => {
      const r = await updater.checkForUpdates(true, { force: true, maxRetries: 2, retryBaseDelayMs: 5 });
      assertEqual(r.status, 'UP_TO_DATE', 'Should recover after 503 with Retry-After');
      assertEqual(tries, 2, 'Should make exactly 2 attempts');
      assert(performance.now() - t0 < 2000, 'Retry-After: 0 completes promptly');
    });

    // 2. Fresh init() with an already-waiting SW surfaces update immediately even when version.json is offline!
    const prevInited = updater._initialized;
    const prevReg = updater.registration;
    const prevAvail = updater.updateAvailable;
    const prevCb = updater.onUpdateFoundCallback;
    const origSwDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'serviceWorker');
    let notifiedWaiting = 0;
    const fakeWaitingReg = {
      installing: null,
      waiting: { postMessage: () => {} },
      update: async () => {},
      addEventListener: () => {}
    };
    updater._initialized = false;
    updater.registration = null;
    updater.updateAvailable = false;
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: { scriptURL: '/sw.js' },
        register: async () => fakeWaitingReg
      }
    });
    try {
      await withMockFetch(async () => { throw new TypeError('Offline'); }, async () => {
        await updater.init(() => { notifiedWaiting += 1; });
      });
      assertEqual(updater.updateAvailable, true, 'Already-waiting SW must set updateAvailable=true even offline');
      assert(notifiedWaiting >= 1, 'Already-waiting SW must trigger onUpdateFound callback immediately on relaunch');
    } finally {
      updater._initialized = prevInited;
      updater.registration = prevReg;
      updater.updateAvailable = prevAvail;
      updater.onUpdateFoundCallback = prevCb;
      if (origSwDesc) {
        Object.defineProperty(navigator, 'serviceWorker', origSwDesc);
      } else {
        delete navigator.serviceWorker;
      }
    }
  });
});
