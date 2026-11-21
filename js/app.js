import {
  RADAR_PRODUCTS,
  buildRadarFrames,
  fetchIemStormIntel,
  fetchNwsAlerts,
  fetchNwsPointBundle,
  fetchOpenMeteo,
  searchLocations
} from './weatherApi.js';
import {
  analyzeEnvironment,
  analyzeStormCells,
  analyzeWinterSuite,
  classifyNwsAlert,
  resolveCurrentConditions,
  wmoInfo
} from './analyzers.js';
import { findNearestNexradStation, getStationsSortedByDistance } from './nexradStations.js';
import { geometryCentroid } from './geoMath.js';
import { RadarMapController } from './radarMap.js';
import { SIREN_CATALOG, audioEngine } from './audio.js';
import { APP_LOCAL_VERSION, updater } from './updater.js';

const STORAGE_KEY_SETTINGS = 'borden_tempest_ios_settings_v1';
const STORAGE_KEY_LOCATIONS = 'borden_tempest_ios_locations_v1';

const DEFAULT_SETTINGS = {
  tornadoSoundId: 'tornado_siren_eas',
  convectiveAlertsEnabled: true,
  proactiveTotAlertsEnabled: true,
  winterAlertsEnabled: true,
  nocturnalReadinessEnabled: true,
  groundFreezeThresholdF: 32,
  radarProduct: 'CONUS_MOSAIC',
  radarOpacity: 0.78,
  basemap: 'dark',
  autoRefreshMinutes: 3,
  dismissedIosBanner: false
};

const DEFAULT_LOCATION = {
  id: 'default_booneville',
  name: 'Booneville, MS',
  lat: 34.6581,
  lon: -88.5667
};

const state = {
  tab: 'dashboard',
  settings: loadJson(STORAGE_KEY_SETTINGS, DEFAULT_SETTINGS),
  savedLocations: loadJson(STORAGE_KEY_LOCATIONS, [DEFAULT_LOCATION]),
  activeLocation: null,
  selectedRadarSite: null,
  isLoading: false,
  lastUpdated: null,
  nwsBundle: null,
  openMeteo: null,
  current: null,
  environment: null,
  winter: null,
  localAlerts: [],
  regionalAlerts: [],
  stormCells: [],
  iemIntel: null,
  activePlayingSoundId: null,
  lastUpdateCheck: null,
  notifiedAlertIds: new Set()
};

state.activeLocation = state.savedLocations[0] || DEFAULT_LOCATION;

const radarMap = new RadarMapController('radar-map-container', {
  onFrameChange: (fr, idx, total) => {
    const timeEl = document.getElementById('radar-frame-time');
    const feedEl = document.getElementById('radar-feed-tag');
    const scrub = document.getElementById('radar-scrubber');
    if (scrub) {
      scrub.max = Math.max(0, total - 1);
      scrub.value = idx;
    }
    if (timeEl) timeEl.textContent = fr ? fr.label : 'No radar frames';
    if (feedEl) feedEl.textContent = fr ? fr.feedLabel : 'IEM';
  },
  onInspectCell: (cell) => openInspectSheet('cell', cell),
  onInspectAlert: (alert) => openInspectSheet('alert', alert)
});

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return Array.isArray(fallback) ? [...fallback] : { ...fallback };
    const parsed = JSON.parse(raw);
    return Array.isArray(fallback) ? parsed : { ...fallback, ...parsed };
  } catch {
    return Array.isArray(fallback) ? [...fallback] : { ...fallback };
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(state.settings));
}

function saveLocations() {
  localStorage.setItem(STORAGE_KEY_LOCATIONS, JSON.stringify(state.savedLocations));
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 2800);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ==================== BOOTSTRAP ==================== */
document.addEventListener('DOMContentLoaded', () => {
  // Unlock Web Audio on first user touch for iOS Safari
  const unlockOnce = () => {
    audioEngine.unlockForIOS();
    window.removeEventListener('touchstart', unlockOnce);
    window.removeEventListener('click', unlockOnce);
  };
  window.addEventListener('touchstart', unlockOnce, { passive: true });
  window.addEventListener('click', unlockOnce, { passive: true });

  audioEngine.onStateChange = (playingId) => {
    state.activePlayingSoundId = playingId;
    document.getElementById('btn-siren-stop')?.classList.toggle('hidden', !playingId);
    if (state.tab === 'settings') renderSettings();
  };

  wireEvents();
  checkIosInstallBanner();

  updater.init((manifest) => {
    const banner = document.getElementById('update-banner');
    if (banner) {
      document.getElementById('update-banner-title').textContent =
        `Borden Tempest v${manifest?.versionName || 'New'} Ready`;
      document.getElementById('update-banner-sub').textContent =
        manifest?.releaseNotes ? manifest.releaseNotes.slice(0, 88) + '…' : 'Tap Update to install instantly.';
      banner.classList.remove('hidden');
    }
    if (state.tab === 'settings') renderSettings();
  });

  // Auto-locate on first launch if no custom saved location yet, otherwise refresh active
  refreshAllData();

  // Foreground active storm polling
  setInterval(() => {
    if (!document.hidden) refreshAllData(true);
  }, (state.settings.autoRefreshMinutes || 3) * 60000);
});

function checkIosInstallBanner() {
  const el = document.getElementById('ios-install-banner');
  if (!el) return;
  if (!updater.isStandalone() && !state.settings.dismissedIosBanner) {
    el.classList.remove('hidden');
  }
}

function wireEvents() {
  // Tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Top bar buttons
  document.getElementById('btn-refresh')?.addEventListener('click', () => refreshAllData(false));
  document.getElementById('btn-gps')?.addEventListener('click', requestGpsLocation);
  document.getElementById('btn-siren-stop')?.addEventListener('click', () => audioEngine.stop());
  document.getElementById('location-picker-trigger')?.addEventListener('click', openLocationModal);

  // iOS banner dismiss & OTA update banner
  document.getElementById('btn-dismiss-ios-banner')?.addEventListener('click', () => {
    state.settings.dismissedIosBanner = true;
    saveSettings();
    document.getElementById('ios-install-banner')?.classList.add('hidden');
  });
  document.getElementById('btn-install-update')?.addEventListener('click', () => {
    showToast('Installing latest Borden Tempest update...');
    updater.applyUpdateNow();
  });

  // Radar product chips
  document.querySelectorAll('#radar-product-chips .radar-chip').forEach((chip) => {
    chip.addEventListener('click', () => selectRadarProduct(chip.dataset.product));
  });

  // Radar buttons
  document.getElementById('btn-radar-play')?.addEventListener('click', () => {
    const playing = radarMap.togglePlayback();
    document.getElementById('btn-radar-play').textContent = playing ? '⏸' : '▶';
  });
  document.getElementById('btn-radar-speed')?.addEventListener('click', () => {
    const sp = radarMap.toggleSpeed();
    document.getElementById('btn-radar-speed').textContent = `${sp}x`;
  });
  document.getElementById('radar-scrubber')?.addEventListener('input', (e) => {
    radarMap.stopPlayback();
    document.getElementById('btn-radar-play').textContent = '▶';
    radarMap.scrubTo(Number(e.target.value));
  });
  document.getElementById('btn-radar-recenter')?.addEventListener('click', () => {
    radarMap.flyTo(state.activeLocation.lat, state.activeLocation.lon, 8.2);
  });
  document.getElementById('btn-radar-site')?.addEventListener('click', openSiteModal);
  document.getElementById('btn-radar-layers')?.addEventListener('click', () => {
    document.getElementById('radar-inspect-sheet')?.classList.add('hidden');
    document.getElementById('radar-layers-sheet')?.classList.toggle('hidden');
  });
  document.getElementById('btn-close-layers')?.addEventListener('click', () => {
    document.getElementById('radar-layers-sheet')?.classList.add('hidden');
  });
  document.getElementById('btn-close-inspect')?.addEventListener('click', () => {
    document.getElementById('radar-inspect-sheet')?.classList.add('hidden');
  });

  // Radar layer toggles
  ['alerts', 'cells', 'spc', 'mcd', 'lsr'].forEach((key) => {
    document.getElementById(`layer-${key}`)?.addEventListener('change', (e) => {
      radarMap.setLayerVisibility(key, e.target.checked);
    });
  });

  // Opacity slider & basemap toggle
  const opSlider = document.getElementById('radar-opacity-slider');
  if (opSlider) {
    opSlider.value = Math.round(state.settings.radarOpacity * 100);
    document.getElementById('radar-opacity-val').textContent = `${opSlider.value}%`;
    opSlider.addEventListener('input', (e) => {
      const pct = Number(e.target.value);
      document.getElementById('radar-opacity-val').textContent = `${pct}%`;
      state.settings.radarOpacity = pct / 100;
      saveSettings();
      radarMap.setOpacity(state.settings.radarOpacity);
    });
  }
  document.querySelectorAll('.seg-btn[data-basemap]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.basemap === state.settings.basemap);
    btn.addEventListener('click', () => {
      const bm = btn.dataset.basemap;
      state.settings.basemap = bm;
      saveSettings();
      document.querySelectorAll('.seg-btn[data-basemap]').forEach((b) => b.classList.toggle('active', b.dataset.basemap === bm));
      radarMap.setBasemap(bm);
    });
  });

  // Location modal
  document.getElementById('btn-close-location-modal')?.addEventListener('click', closeLocationModal);
  document.getElementById('location-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'location-modal') closeLocationModal();
  });
  document.getElementById('btn-location-search')?.addEventListener('click', runLocationSearch);
  document.getElementById('location-search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runLocationSearch();
  });

  // Site modal
  document.getElementById('btn-close-site-modal')?.addEventListener('click', () => {
    document.getElementById('site-modal')?.classList.add('hidden');
  });
  document.getElementById('site-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'site-modal') document.getElementById('site-modal').classList.add('hidden');
  });
  document.getElementById('site-search-input')?.addEventListener('input', renderSiteList);

  // Alert popup modal
  document.getElementById('btn-alert-popup-dismiss')?.addEventListener('click', () => {
    audioEngine.stop();
    document.getElementById('alert-popup-modal')?.classList.add('hidden');
  });
  document.getElementById('btn-alert-popup-radar')?.addEventListener('click', () => {
    audioEngine.stop();
    document.getElementById('alert-popup-modal')?.classList.add('hidden');
    switchTab('radar');
  });
}

function switchTab(tabName) {
  state.tab = tabName;
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const active = b.dataset.tab === tabName;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-view').forEach((v) => {
    v.classList.toggle('active', v.id === `tab-${tabName}`);
  });

  if (tabName === 'radar') {
    ensureRadarReady();
  } else if (tabName === 'alerts') {
    renderAlerts();
  } else if (tabName === 'settings') {
    renderSettings();
  } else {
    renderDashboard();
  }
}

/* ==================== DATA SYNC ==================== */
async function refreshAllData(silent = false) {
  if (state.isLoading) return;
  state.isLoading = true;
  const refBtn = document.getElementById('btn-refresh');
  if (!silent) refBtn?.classList.add('spinning');

  const { lat, lon } = state.activeLocation;
  const nearest = findNearestNexradStation(lat, lon);
  if (!state.selectedRadarSite) {
    state.selectedRadarSite = nearest.id;
  }

  document.getElementById('header-location-name').textContent = state.activeLocation.name;
  document.getElementById('header-status-sub').textContent = 'Syncing NWS, Open-Meteo & NEXRAD...';

  try {
    const [nwsRes, omRes, iemRes] = await Promise.allSettled([
      fetchNwsPointBundle(lat, lon),
      fetchOpenMeteo(lat, lon),
      fetchIemStormIntel()
    ]);

    state.nwsBundle = nwsRes.status === 'fulfilled' ? nwsRes.value : null;
    state.openMeteo = omRes.status === 'fulfilled' ? omRes.value : null;
    state.iemIntel = iemRes.status === 'fulfilled' ? iemRes.value : null;

    if (state.nwsBundle?.cityLabel && state.activeLocation.id === 'gps_current') {
      state.activeLocation.name = `${state.nwsBundle.cityLabel} (GPS)`;
    }

    const alertsRes = await fetchNwsAlerts(lat, lon, state.nwsBundle?.stateCode).catch(() => ({
      localFeatures: [],
      regionalFeatures: []
    }));

    state.localAlerts = (alertsRes.localFeatures || []).map(classifyNwsAlert).sort((a, b) => b.rank - a.rank);
    state.regionalAlerts = (alertsRes.regionalFeatures || []).map(classifyNwsAlert).sort((a, b) => b.rank - a.rank);

    state.current = resolveCurrentConditions(state.nwsBundle, state.openMeteo);
    const mcdCount = state.iemIntel?.mcdGeoJson?.features?.length || 0;
    state.environment = analyzeEnvironment(state.openMeteo, state.current, mcdCount);
    state.winter = analyzeWinterSuite(state.openMeteo, state.current, state.settings.groundFreezeThresholdF);
    state.stormCells = analyzeStormCells(state.iemIntel?.stormCellsGeoJson, lat, lon, 120);
    state.lastUpdated = new Date();

    updateHeaderAndBadges();
    renderDashboard();
    renderAlerts();
    if (state.tab === 'settings') renderSettings();

    // Update Radar overlays if initialized
    radarMap.setOverlayData({
      alerts: state.regionalAlerts,
      stormCells: state.stormCells,
      lsrGeoJson: state.iemIntel?.lsrGeoJson,
      mcdGeoJson: state.iemIntel?.mcdGeoJson,
      spcDay1GeoJson: state.iemIntel?.spcDay1GeoJson
    });

    if (state.tab === 'radar') {
      loadRadarFramesForCurrentProduct();
    }

    checkForLiveCriticalTriggers();
    if (!silent) showToast('Weather, radar & storm intel updated');
  } catch (err) {
    document.getElementById('header-status-sub').textContent = 'Offline or partial feed — tap refresh';
    if (!silent) showToast(`Sync error: ${err.message || 'Check connection'}`);
  } finally {
    state.isLoading = false;
    refBtn?.classList.remove('spinning');
  }
}

function updateHeaderAndBadges() {
  document.getElementById('header-location-name').textContent = state.activeLocation.name;
  const clock = state.lastUpdated ? state.lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '--';
  const site = state.selectedRadarSite || findNearestNexradStation(state.activeLocation.lat, state.activeLocation.lon).id;
  document.getElementById('header-status-sub').textContent = `Updated ${clock} • Radar ${site} • v${APP_LOCAL_VERSION.versionName}`;

  const directCells = state.stormCells.filter((c) => c.intercept.verdict === 'DIRECT_INTERCEPT' || c.tvs);
  const totalCount = state.localAlerts.length + directCells.length +
    (state.winter?.winterAlerts?.length || 0) +
    (state.environment?.proactiveAlerts?.length || 0);

  const badge = document.getElementById('alerts-badge');
  if (badge) {
    badge.textContent = String(totalCount);
    badge.classList.toggle('hidden', totalCount === 0);
  }
}

function checkForLiveCriticalTriggers() {
  const topCritical = state.localAlerts.find((a) => a.tier === 'CRITICAL');
  if (topCritical && !state.notifiedAlertIds.has(topCritical.id)) {
    state.notifiedAlertIds.add(topCritical.id);
    triggerAlertPopup({
      badge: topCritical.isTornadoEmergency ? 'TORNADO EMERGENCY' : 'CRITICAL WARNING',
      title: topCritical.event,
      body: `${topCritical.headline}\n\n${topCritical.instruction || topCritical.areaDesc}`,
      soundId: state.settings.tornadoSoundId
    });
  }
}

function requestGpsLocation() {
  if (!navigator.geolocation) {
    showToast('GPS is unavailable on this browser.');
    return;
  }
  showToast('Requesting GPS location...');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const nearest = findNearestNexradStation(lat, lon);
      state.activeLocation = { id: 'gps_current', name: 'Current Location (GPS)', lat, lon };
      state.selectedRadarSite = nearest.id;
      radarMap.flyTo(lat, lon, 8.2);
      refreshAllData();
    },
    () => showToast('Location permission denied — tap the city name to search manually.'),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

/* ==================== RADAR ==================== */
async function ensureRadarReady() {
  const { lat, lon } = state.activeLocation;
  const nearest = findNearestNexradStation(lat, lon);
  if (!state.selectedRadarSite) state.selectedRadarSite = nearest.id;
  document.getElementById('radar-site-label').textContent = `Site: ${state.selectedRadarSite}`;

  document.querySelectorAll('#radar-product-chips .radar-chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.product === state.settings.radarProduct);
  });

  radarMap.init(lat, lon, state.settings.basemap, state.settings.radarOpacity);
  radarMap.resize();
  radarMap.setOverlayData({
    alerts: state.regionalAlerts,
    stormCells: state.stormCells,
    lsrGeoJson: state.iemIntel?.lsrGeoJson,
    mcdGeoJson: state.iemIntel?.mcdGeoJson,
    spcDay1GeoJson: state.iemIntel?.spcDay1GeoJson
  });
  await loadRadarFramesForCurrentProduct();
}

async function selectRadarProduct(productCode) {
  state.settings.radarProduct = productCode;
  saveSettings();
  document.querySelectorAll('#radar-product-chips .radar-chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.product === productCode);
  });
  await loadRadarFramesForCurrentProduct();
}

async function loadRadarFramesForCurrentProduct() {
  const prod = state.settings.radarProduct || 'CONUS_MOSAIC';
  const site = state.selectedRadarSite || findNearestNexradStation(state.activeLocation.lat, state.activeLocation.lon).id;
  document.getElementById('radar-site-label').textContent = `Site: ${site}`;
  document.getElementById('radar-frame-time').textContent = 'Loading radar scans...';
  const frames = await buildRadarFrames(prod, site);
  radarMap.setFrames(frames, prod);
  document.getElementById('btn-radar-play').textContent = '▶';
}

function openInspectSheet(type, item) {
  document.getElementById('radar-layers-sheet')?.classList.add('hidden');
  const sheet = document.getElementById('radar-inspect-sheet');
  const titleEl = document.getElementById('inspect-title');
  const bodyEl = document.getElementById('inspect-body');
  if (!sheet || !titleEl || !bodyEl) return;

  if (type === 'cell') {
    titleEl.textContent = `Storm Cell ${item.stormId} (${item.nexrad})`;
    bodyEl.innerHTML = `
      <div class="tag-row">
        <span class="badge-${item.tvs ? 'red' : item.meso ? 'magenta' : 'amber'}">${item.threatLevel.replace('_', ' ')}</span>
        ${item.tvs ? `<span class="badge-red">TVS: ${escapeHtml(item.tvs)}</span>` : ''}
        ${item.meso ? `<span class="badge-magenta">MESO: ${escapeHtml(item.meso)}</span>` : ''}
        ${item.maxHailIn > 0 ? `<span class="badge-amber">Hail ${item.maxHailIn}"</span>` : ''}
      </div>
      <div class="alert-meta">
        <strong>Position:</strong> ${item.intercept.distanceMi.toFixed(1)} mi ${item.intercept.compassFromUser} moving ${item.moveToCompass} @ ${item.speedMph} mph<br/>
        <strong>Intercept:</strong> ${escapeHtml(item.intercept.verdictLabel)}${item.intercept.etaMinutes ? ` • <strong>TOT ~${item.intercept.etaMinutes} min</strong>` : ''}<br/>
        <strong>Storm Top:</strong> ${item.topKft ? `${item.topKft} kft` : '--'} • <strong>Hail Prob:</strong> ${item.poh}% (Severe ${item.posh}%)
      </div>
    `;
  } else {
    titleEl.textContent = item.event;
    bodyEl.innerHTML = `
      <div class="tag-row">
        <span class="badge-${item.tier === 'CRITICAL' ? 'red' : item.tier === 'WINTER' ? 'blue' : 'amber'}">${item.tier}</span>
        ${item.tornadoDetection ? `<span class="badge-red">Tornado: ${escapeHtml(item.tornadoDetection)}</span>` : ''}
        ${item.maxWindGust ? `<span class="badge-amber">Wind: ${escapeHtml(item.maxWindGust)}</span>` : ''}
        ${item.maxHailSize ? `<span class="badge-amber">Hail: ${escapeHtml(item.maxHailSize)}"</span>` : ''}
      </div>
      <div class="alert-meta">
        <strong>${escapeHtml(item.headline)}</strong><br/><br/>
        ${escapeHtml((item.instruction || item.description || '').slice(0, 500))}
      </div>
    `;
  }
  sheet.classList.remove('hidden');
}

/* ==================== RENDER: DASHBOARD ==================== */
function renderDashboard() {
  const container = document.getElementById('dashboard-content');
  const strip = document.getElementById('dashboard-alert-strip');
  if (!container || !state.current) return;

  const c = state.current;
  const env = state.environment;
  const win = state.winter;

  // Top Alert Banner Strip
  const topAlert = state.localAlerts[0];
  const topThreatCell = state.stormCells.find((sc) => sc.intercept.verdict === 'DIRECT_INTERCEPT' || sc.tvs);

  if (topAlert) {
    strip.className = `alert-strip ${topAlert.tier === 'CRITICAL' ? 'critical' : topAlert.tier === 'WINTER' ? 'winter' : 'severe'}`;
    strip.innerHTML = `
      <div>
        <div style="font-size:11px;font-weight:800;letter-spacing:.06em;opacity:.9;">ACTIVE NWS ${escapeHtml(topAlert.tier)}</div>
        <div style="font-size:15px;font-weight:800;margin-top:2px;">${escapeHtml(topAlert.event)}</div>
        <div style="font-size:12px;opacity:.88;margin-top:2px;">${state.localAlerts.length} local alert${state.localAlerts.length > 1 ? 's' : ''} — tap to inspect</div>
      </div>
      <span style="font-size:18px;font-weight:800;">›</span>
    `;
    strip.onclick = () => switchTab('alerts');
  } else if (topThreatCell) {
    strip.className = 'alert-strip critical';
    strip.innerHTML = `
      <div>
        <div style="font-size:11px;font-weight:800;letter-spacing:.06em;">STORM CELL INTERCEPT</div>
        <div style="font-size:15px;font-weight:800;margin-top:2px;">Cell ${escapeHtml(topThreatCell.stormId)} • ${topThreatCell.intercept.etaMinutes ? `TOT ~${topThreatCell.intercept.etaMinutes} min` : topThreatCell.intercept.verdictLabel}</div>
        <div style="font-size:12px;opacity:.9;margin-top:2px;">${topThreatCell.intercept.distanceMi.toFixed(1)} mi ${topThreatCell.intercept.compassFromUser} moving ${topThreatCell.moveToCompass} @ ${topThreatCell.speedMph} mph</div>
      </div>
      <span style="font-size:18px;font-weight:800;">›</span>
    `;
    strip.onclick = () => {
      switchTab('radar');
      radarMap.flyTo(topThreatCell.lat, topThreatCell.lon, 9.2);
    };
  } else {
    strip.className = 'alert-strip hidden';
  }

  // Build Hourly Cards (prefer NWS hourly, fallback to Open-Meteo)
  const hourlyItems = buildHourlyItems();
  const dailyItems = (state.nwsBundle?.forecastPeriods || []).slice(0, 10);

  const pTrendSign = c.pressureTrend3h > 0 ? '+' : '';
  const nearestRadar = findNearestNexradStation(state.activeLocation.lat, state.activeLocation.lon);

  container.innerHTML = `
    <!-- HERO CURRENT CONDITIONS -->
    <div class="card hero-card">
      <div class="hero-top">
        <div>
          <div class="hero-temp">${c.tempF != null ? `${c.tempF}°` : '--'}</div>
          <div class="hero-cond">${c.icon} ${escapeHtml(c.conditionText)}</div>
          <div class="hero-feels">Feels like ${c.feelsLikeF ?? '--'}° • Dewpoint ${c.dewpointF ?? '--'}°F</div>
        </div>
        <div class="hero-right">
          <span class="badge-cyan">${c.confidence} Consensus</span>
          <span class="badge-muted">±${c.spreadF}°F spread</span>
          <span class="badge-muted">${nearestRadar.id} (${nearestRadar.distanceMi.toFixed(0)} mi)</span>
        </div>
      </div>

      <div class="metrics-grid">
        <div class="metric-box">
          <div class="metric-label">Wind</div>
          <div class="metric-value">${c.windCompass} ${c.windMph} mph</div>
          <div class="metric-sub">${c.gustMph ? `Gusts ${c.gustMph} mph` : 'Steady'}</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">Humidity</div>
          <div class="metric-value">${c.humidity ?? '--'}%</div>
          <div class="metric-sub">Td ${c.dewpointF ?? '--'}°F</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">Pressure</div>
          <div class="metric-value">${c.pressureInHg}"</div>
          <div class="metric-sub">${pTrendSign}${c.pressureTrend3h} hPa / 3h</div>
        </div>
      </div>

      <div class="consensus-meta">
        <span>${escapeHtml(c.sourceLabel)}</span>
        <span>Vis ${c.visibilityMi} mi</span>
      </div>
    </div>

    <!-- CONVECTIVE & SUPERCELL ENVIRONMENT -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">⚡ Convective &amp; Supercell Environment</div>
        <span class="badge-${env.level === 'high' ? 'red' : env.level === 'mod' ? 'amber' : 'green'}">${escapeHtml(env.regime)}</span>
      </div>
      <div class="regime-banner ${env.level}">
        ${escapeHtml(env.nocturnalRisk)}
      </div>
      <div class="metrics-grid">
        <div class="metric-box">
          <div class="metric-label">CAPE (12h Peak)</div>
          <div class="metric-value">${env.peakCape12h} J/kg</div>
          <div class="metric-sub">Now: ${env.capeNow} J/kg</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">0–1.5km Shear</div>
          <div class="metric-value">${env.lowLevelShearKt} kt</div>
          <div class="metric-sub">${env.veeringDeg >= 0 ? `+${env.veeringDeg}°` : `${env.veeringDeg}°`} veering</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">Storm Cells (120m)</div>
          <div class="metric-value">${state.stormCells.length}</div>
          <div class="metric-sub">${state.stormCells.filter((x) => x.tvs || x.meso).length} rotating</div>
        </div>
      </div>
    </div>

    <!-- FULL WINTER / GROUND TEMP / FOG SUITE -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">❄️ Winter, Ground Temp &amp; Fog Suite</div>
        <span class="badge-${win.hazardLevel === 'CRITICAL' ? 'red' : win.hazardLevel === 'CLEAR' ? 'green' : 'blue'}">${escapeHtml(win.statusLabel)}</span>
      </div>
      <div class="regime-banner ${win.hazardLevel === 'CRITICAL' ? 'high' : win.hazardLevel === 'CLEAR' ? 'low' : 'winter'}">
        <strong>Road / Bridge Surface:</strong> ${escapeHtml(win.roadBridgeRiskLabel)}
      </div>
      <div class="metrics-grid cols-2">
        <div class="metric-box">
          <div class="metric-label">Ground Temp (0cm / 6cm)</div>
          <div class="metric-value">${win.ground0cmF ?? '--'}°F / ${win.ground6cmF ?? '--'}°F</div>
          <div class="metric-sub">Freeze trigger ≤ ${state.settings.groundFreezeThresholdF}°F</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">Freezing Level / 24h Low</div>
          <div class="metric-value">${win.freezingLevelFt != null ? `${win.freezingLevelFt.toLocaleString()} ft` : '--'}</div>
          <div class="metric-sub">${win.hoursBelowFreezingNext24h}h ≤ 32°F • Low ${win.minTemp24h ?? '--'}°F</div>
        </div>
      </div>
    </div>

    <!-- HOURLY FORECAST -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">🕒 Next 18 Hours</div>
        <span class="badge-muted">NWS / Open-Meteo</span>
      </div>
      <div class="hourly-strip">
        ${hourlyItems.map((h) => `
          <div class="hour-pill">
            <div class="hour-time">${escapeHtml(h.time)}</div>
            <div class="hour-icon">${h.icon}</div>
            <div class="hour-temp">${h.temp}°</div>
            <div class="hour-pop">${h.pop > 0 ? `${h.pop}%` : '&nbsp;'}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- 7-DAY NWS FORECAST -->
    ${dailyItems.length ? `
      <div class="card">
        <div class="card-header">
          <div class="card-title">📅 NWS 7-Day Forecast</div>
          <span class="badge-muted">${escapeHtml(state.nwsBundle?.cwa || 'NWS')}</span>
        </div>
        ${dailyItems.map((p) => `
          <div class="daily-row">
            <div class="daily-name">${escapeHtml(p.name)}</div>
            <div class="daily-desc">${escapeHtml(p.shortForecast)}</div>
            <div class="daily-temp">${p.temperature}°${p.temperatureUnit || 'F'}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;
}

function buildHourlyItems() {
  const nwsHourly = state.nwsBundle?.hourlyPeriods || [];
  if (nwsHourly.length >= 6) {
    return nwsHourly.slice(0, 18).map((p, i) => {
      const d = new Date(p.startTime);
      const label = i === 0 ? 'Now' : d.toLocaleTimeString([], { hour: 'numeric' });
      const txt = (p.shortForecast || '').toLowerCase();
      let icon = p.isDaytime ? '🌤️' : '🌙';
      if (txt.includes('thunder')) icon = '⛈️';
      else if (txt.includes('snow') || txt.includes('sleet')) icon = '❄️';
      else if (txt.includes('rain') || txt.includes('shower')) icon = '🌧️';
      else if (txt.includes('fog')) icon = '🌫️';
      else if (txt.includes('cloud')) icon = '☁️';
      else if (txt.includes('sun') || txt.includes('clear')) icon = p.isDaytime ? '☀️' : '🌙';
      return {
        time: label,
        icon,
        temp: p.temperature,
        pop: p.probabilityOfPrecipitation?.value || 0
      };
    });
  }

  const om = state.openMeteo?.hourly;
  if (!om?.time?.length) return [];
  const now = Date.now();
  let start = om.time.findIndex((t) => new Date(t).getTime() >= now - 3600000);
  if (start < 0) start = 0;
  return om.time.slice(start, start + 18).map((t, i) => {
    const d = new Date(t);
    const [, icon] = wmoInfo(om.weather_code?.[start + i]);
    return {
      time: i === 0 ? 'Now' : d.toLocaleTimeString([], { hour: 'numeric' }),
      icon,
      temp: Math.round(om.temperature_2m?.[start + i] ?? 0),
      pop: Math.round(om.precipitation_probability?.[start + i] ?? 0)
    };
  });
}

/* ==================== RENDER: ALERTS ==================== */
function renderAlerts() {
  const el = document.getElementById('alerts-content');
  if (!el) return;

  const localAlerts = state.localAlerts || [];
  const convAlerts = state.environment?.proactiveAlerts || [];
  const winAlerts = state.winter?.winterAlerts || [];
  const cells = state.stormCells || [];
  const mcds = state.iemIntel?.mcdGeoJson?.features || [];

  const parts = [];

  // 1. Official NWS Local Alerts
  if (localAlerts.length) {
    parts.push(`<div class="section-mini-label">Active Local NWS Alerts (${localAlerts.length})</div>`);
    for (const a of localAlerts) {
      const cls = a.tier === 'CRITICAL' ? 'tier-critical' : a.tier === 'WINTER' ? 'tier-winter' : '';
      parts.push(`
        <div class="card alert-card ${cls}">
          <div class="card-header" style="margin-bottom:4px;">
            <span class="badge-${a.tier === 'CRITICAL' ? 'red' : a.tier === 'WINTER' ? 'blue' : 'amber'}">${a.isTornadoEmergency ? 'TORNADO EMERGENCY' : a.tier}</span>
            <span class="metric-sub">${a.expires ? `Exp ${new Date(a.expires).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span>
          </div>
          <div class="alert-title">${escapeHtml(a.event)}</div>
          <div class="alert-meta">${escapeHtml(a.headline)}</div>
          <div class="tag-row">
            ${a.tornadoDetection ? `<span class="badge-red">Tornado: ${escapeHtml(a.tornadoDetection)}</span>` : ''}
            ${a.maxWindGust ? `<span class="badge-amber">Wind: ${escapeHtml(a.maxWindGust)}</span>` : ''}
            ${a.maxHailSize ? `<span class="badge-amber">Hail: ${escapeHtml(a.maxHailSize)}"</span>` : ''}
          </div>
          ${a.instruction ? `<div class="alert-meta" style="margin-top:8px;color:var(--text-primary);">${escapeHtml(a.instruction.slice(0, 320))}</div>` : ''}
          <div class="card-action-row">
            <button class="btn-primary-sm" data-focus-alert="${escapeHtml(a.id)}">View on Radar</button>
          </div>
        </div>
      `);
    }
  }

  // 2. Proactive Convective & Winter Alerts
  if (convAlerts.length || winAlerts.length) {
    parts.push(`<div class="section-mini-label">Borden Tempest Proactive Intelligence</div>`);
    for (const ca of convAlerts) {
      parts.push(`
        <div class="card alert-card tier-convective">
          <span class="badge-cyan">CONVECTIVE ENVIRONMENT</span>
          <div class="alert-title">${escapeHtml(ca.title)}</div>
          <div class="alert-meta">${escapeHtml(ca.summary)}</div>
        </div>
      `);
    }
    for (const wa of winAlerts) {
      parts.push(`
        <div class="card alert-card tier-winter">
          <span class="badge-blue">WINTER / SURFACE HAZARD</span>
          <div class="alert-title">${escapeHtml(wa.title)}</div>
          <div class="alert-meta">${escapeHtml(wa.summary)}</div>
        </div>
      `);
    }
  }

  // 3. Tracked NEXRAD Storm Cells (Time-on-Target)
  if (cells.length) {
    parts.push(`<div class="section-mini-label">Tracked NEXRAD Storm Cells Within 120 mi (${cells.length})</div>`);
    for (const sc of cells.slice(0, 12)) {
      const cls = sc.tvs ? 'tier-critical' : sc.meso ? 'tier-supercell' : '';
      parts.push(`
        <div class="card alert-card ${cls}">
          <div class="card-header" style="margin-bottom:4px;">
            <span class="badge-${sc.tvs ? 'red' : sc.meso ? 'magenta' : 'amber'}">${sc.threatLevel.replace('_', ' ')} • ${escapeHtml(sc.stormId)}</span>
            <span class="metric-sub">${sc.intercept.distanceMi.toFixed(1)} mi ${sc.intercept.compassFromUser}</span>
          </div>
          <div class="alert-title">
            ${sc.intercept.etaMinutes ? `Time on Target: ~${sc.intercept.etaMinutes} min` : escapeHtml(sc.intercept.verdictLabel)}
          </div>
          <div class="alert-meta">
            Moving ${sc.moveToCompass} @ ${sc.speedMph} mph • ${escapeHtml(sc.intercept.verdictLabel)} • Radar ${escapeHtml(sc.nexrad)}
          </div>
          <div class="tag-row">
            ${sc.tvs ? `<span class="badge-red">TVS</span>` : ''}
            ${sc.meso ? `<span class="badge-magenta">MESO ${escapeHtml(sc.meso)}</span>` : ''}
            ${sc.maxHailIn > 0 ? `<span class="badge-amber">Hail ${sc.maxHailIn}"</span>` : ''}
            ${sc.topKft ? `<span class="badge-muted">Top ${sc.topKft} kft</span>` : ''}
          </div>
          <div class="card-action-row">
            <button class="btn-primary-sm" data-focus-cell="${escapeHtml(sc.id)}">Track on Radar</button>
          </div>
        </div>
      `);
    }
  }

  // 4. Active SPC Mesoscale Discussions (CONUS)
  if (mcds.length) {
    parts.push(`<div class="section-mini-label">Active SPC Mesoscale Discussions (${mcds.length})</div>`);
    for (const m of mcds.slice(0, 6)) {
      const mp = m.properties || {};
      parts.push(`
        <div class="card alert-card tier-supercell">
          <span class="badge-magenta">SPC MCD #${escapeHtml(mp.num || '')}</span>
          <div class="alert-title">${escapeHtml(mp.concerning || 'Mesoscale Discussion')}</div>
          <div class="alert-meta">${escapeHtml(mp.watch_confidence ? `Watch probability: ${mp.watch_confidence}` : 'Active SPC mesoscale analysis polygon shown on Radar.')}</div>
        </div>
      `);
    }
  }

  if (!parts.length) {
    parts.push(`
      <div class="card" style="text-align:center;padding:28px 18px;">
        <div style="font-size:34px;margin-bottom:8px;">🛡️</div>
        <div class="alert-title">All Quiet Across Your Area</div>
        <div class="alert-meta" style="margin-top:6px;">
          Active TVS/Mesocyclone detections, approaching storm Time-on-Target vectors, black ice / freezing fog alerts, NWS warnings, and SPC Mesoscale Discussions will appear here automatically.
        </div>
      </div>
    `);
  }

  el.innerHTML = parts.join('');

  el.querySelectorAll('[data-focus-alert]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = state.localAlerts.find((x) => x.id === btn.dataset.focusAlert);
      switchTab('radar');
      if (a?.geometry) {
        const ctr = geometryCentroid(a.geometry);
        if (ctr) radarMap.flyTo(ctr.lat, ctr.lon, 8.6);
      }
      if (a) openInspectSheet('alert', a);
    });
  });

  el.querySelectorAll('[data-focus-cell]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const c = state.stormCells.find((x) => x.id === btn.dataset.focusCell);
      switchTab('radar');
      if (c) {
        radarMap.flyTo(c.lat, c.lon, 9.2);
        openInspectSheet('cell', c);
      }
    });
  });
}

/* ==================== RENDER: SETTINGS & OTA UPDATER ==================== */
function renderSettings() {
  const el = document.getElementById('settings-content');
  if (!el) return;

  const s = state.settings;
  const upd = updater.remoteManifest;
  const hasUpd = updater.updateAvailable;

  el.innerHTML = `
    <!-- OTA AUTO-UPDATER -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">🔄 App Updates (OTA)</div>
        <span class="badge-${hasUpd ? 'cyan' : 'green'}">${hasUpd ? 'Update Ready' : `v${APP_LOCAL_VERSION.versionName} Current`}</span>
      </div>
      <div class="alert-meta" style="margin-bottom:10px;">
        <strong>Installed:</strong> Borden Tempest v${APP_LOCAL_VERSION.versionName} (Build ${APP_LOCAL_VERSION.versionCode}) • iOS / Web Companion<br/>
        <strong>Install Mode:</strong> ${updater.isStandalone() ? 'Installed Home Screen App ✓' : 'Safari Browser (Add to Home Screen for full-screen mode)'}
      </div>
      ${upd?.releaseNotes ? `<div class="alert-meta" style="margin-bottom:10px;padding:9px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid var(--border-subtle);"><strong>Latest Release Notes (v${escapeHtml(upd.versionName)}):</strong><br/>${escapeHtml(upd.releaseNotes)}</div>` : ''}
      <div style="display:flex;gap:8px;">
        <button id="btn-check-updates" class="btn-secondary-sm" style="flex:1;">Check for Updates</button>
        ${hasUpd ? `<button id="btn-apply-update-settings" class="btn-primary-sm" style="flex:1;">Install Update Now</button>` : ''}
      </div>
    </div>

    <!-- CUSTOM SIREN SELECTOR & SOUND TESTER -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">🚨 Tornado &amp; Severe Alert Sirens</div>
        <span class="badge-red">8 Custom WAVs</span>
      </div>
      <div class="alert-meta" style="margin-bottom:10px;">
        Tap any siren to preview on your iPhone. The selected Tornado siren plays during live critical warnings and tests while Borden Tempest is active.
      </div>
      <div class="siren-list">
        ${SIREN_CATALOG.map((item) => {
          const isSelected = s.tornadoSoundId === item.id;
          const isPlaying = state.activePlayingSoundId === item.id;
          return `
            <div class="siren-row ${isSelected ? 'selected' : ''}">
              <label class="siren-radio-wrap">
                <input type="radio" name="tornado-siren" value="${item.id}" ${isSelected ? 'checked' : ''} />
                <div>
                  <div class="siren-name">${escapeHtml(item.name)}</div>
                  <div class="siren-sub">${escapeHtml(item.sub)}</div>
                </div>
              </label>
              <button class="btn-${isPlaying ? 'danger' : 'secondary'}-sm" data-preview-siren="${item.id}">
                ${isPlaying ? '⏹ Stop' : '▶ Test'}
              </button>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <!-- ALERT PREFERENCES -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">⚙️ Monitoring &amp; Thresholds</div>
      </div>
      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-title">Convective / HSLC Environment Alerts</div>
          <div class="setting-desc">Alert when low-level shear, CAPE, pressure falls, or MCDs signal supercell potential.</div>
        </div>
        <input type="checkbox" id="set-convective" ${s.convectiveAlertsEnabled ? 'checked' : ''} />
      </div>
      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-title">Proactive Storm Time-on-Target (TOT)</div>
          <div class="setting-desc">Highlight radar cells tracking directly toward your location ahead of warnings.</div>
        </div>
        <input type="checkbox" id="set-tot" ${s.proactiveTotAlertsEnabled ? 'checked' : ''} />
      </div>
      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-title">Winter, Black Ice &amp; Freezing Fog Suite</div>
          <div class="setting-desc">Track 0cm/6cm soil temperatures, bridge icing risk, and freezing fog visibility.</div>
        </div>
        <input type="checkbox" id="set-winter" ${s.winterAlertsEnabled ? 'checked' : ''} />
      </div>
      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-title">Ground Freeze Trigger (${s.groundFreezeThresholdF}°F)</div>
          <div class="setting-desc">Alert when 0cm surface ground temperature drops to or below threshold.</div>
        </div>
        <input type="range" id="set-freeze-slider" min="28" max="36" value="${s.groundFreezeThresholdF}" style="width:96px;accent-color:var(--cyan);" />
      </div>
    </div>

    <!-- TEST ALERT SIMULATOR -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">🧪 Test Alert Simulator</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <button id="btn-test-tornado" class="btn-danger-sm">Test Tornado Siren</button>
        <button id="btn-test-tot" class="btn-primary-sm">Test Storm TOT</button>
        <button id="btn-test-convective" class="btn-secondary-sm">Test Convective</button>
        <button id="btn-test-winter" class="btn-secondary-sm">Test Black Ice</button>
      </div>
    </div>

    <!-- iPHONE HOME SCREEN GUIDE -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">📱 iPhone Home Screen Setup</div>
      </div>
      <div class="alert-meta">
        1. Open this link in <strong>Safari</strong> on iPhone.<br/>
        2. Tap the <strong>Share</strong> button at the bottom of Safari.<br/>
        3. Scroll down and tap <strong>Add to Home Screen</strong>.<br/>
        4. Open <strong>Borden Tempest</strong> from your Home Screen — free forever, never expires, and automatically receives OTA updates whenever new releases are published.
      </div>
    </div>
  `;

  // Wire Settings actions
  document.getElementById('btn-check-updates')?.addEventListener('click', async () => {
    showToast('Checking for Borden Tempest updates...');
    const res = await updater.checkForUpdates(false);
    if (res.status === 'UPDATE_AVAILABLE') {
      showToast(`Update v${res.manifest.versionName} available!`);
    } else if (res.status === 'UP_TO_DATE') {
      showToast(`You're on the latest version (v${APP_LOCAL_VERSION.versionName}).`);
    } else {
      showToast(`Update check failed: ${res.error}`);
    }
    renderSettings();
  });

  document.getElementById('btn-apply-update-settings')?.addEventListener('click', () => {
    updater.applyUpdateNow();
  });

  el.querySelectorAll('input[name="tornado-siren"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.settings.tornadoSoundId = e.target.value;
      saveSettings();
      renderSettings();
    });
  });

  el.querySelectorAll('[data-preview-siren]').forEach((btn) => {
    btn.addEventListener('click', () => {
      audioEngine.unlockForIOS();
      audioEngine.togglePreview(btn.dataset.previewSiren);
    });
  });

  document.getElementById('set-convective')?.addEventListener('change', (e) => {
    state.settings.convectiveAlertsEnabled = e.target.checked;
    saveSettings();
  });
  document.getElementById('set-tot')?.addEventListener('change', (e) => {
    state.settings.proactiveTotAlertsEnabled = e.target.checked;
    saveSettings();
  });
  document.getElementById('set-winter')?.addEventListener('change', (e) => {
    state.settings.winterAlertsEnabled = e.target.checked;
    saveSettings();
  });
  document.getElementById('set-freeze-slider')?.addEventListener('input', (e) => {
    state.settings.groundFreezeThresholdF = Number(e.target.value);
    saveSettings();
    renderSettings();
    if (state.openMeteo && state.current) {
      state.winter = analyzeWinterSuite(state.openMeteo, state.current, state.settings.groundFreezeThresholdF);
      renderDashboard();
    }
  });

  document.getElementById('btn-test-tornado')?.addEventListener('click', () => {
    triggerAlertPopup({
      badge: 'TEST CRITICAL WARNING',
      title: 'Tornado Warning (Test)',
      body: 'THIS IS A TEST ALERT from Borden Tempest.\n13.8 mi WSW moving ENE @ 52 mph • 70 mph Wind • 1.75" Hail • Tornado Possible.\nOpen Radar to inspect Velocity (N0G) & CC Debris (N0C).',
      soundId: state.settings.tornadoSoundId
    });
  });

  document.getElementById('btn-test-tot')?.addEventListener('click', () => {
    triggerAlertPopup({
      badge: 'TEST STORM PRE-WARNING',
      title: 'Approaching Supercell (TOT)',
      body: 'THIS IS A TEST PRE-WARNING from Borden Tempest.\nTime on Target: ~26 min • 21.8 mi SW moving NE @ 50 mph • Direct Intercept (CPA 1.2 mi).\nProactive radar-cell tracking alerts you ahead of official polygon arrival.',
      soundId: 'storm_tot_ping'
    });
  });

  document.getElementById('btn-test-convective')?.addEventListener('click', () => {
    triggerAlertPopup({
      badge: 'TEST CONVECTIVE ALERT',
      title: 'HSLC Supercell Environment',
      body: '0–1.5km Shear 34 kt (+42° veering) • CAPE 520 J/kg • Td 66°F • Pressure -3.6 hPa/3hr.\nDangerous low-CAPE, high-shear rotating storm potential.',
      soundId: 'convective_chime'
    });
  });

  document.getElementById('btn-test-winter')?.addEventListener('click', () => {
    triggerAlertPopup({
      badge: 'TEST WINTER HAZARD',
      title: 'Black Ice / Freezing Rain',
      body: 'Ground 30°F (6cm: 32°F) • Air 33°F • Vis 0.3 mi • Bridges icing rapidly.',
      soundId: 'winter_alert_chime'
    });
  });
}

function triggerAlertPopup({ badge, title, body, soundId }) {
  audioEngine.unlockForIOS();
  document.getElementById('alert-popup-badge').textContent = badge;
  document.getElementById('alert-popup-title').textContent = title;
  document.getElementById('alert-popup-body').textContent = body;
  document.getElementById('alert-popup-modal')?.classList.remove('hidden');
  audioEngine.play(soundId, false);
}

/* ==================== LOCATION & SITE MODALS ==================== */
function openLocationModal() {
  document.getElementById('location-search-input').value = '';
  document.getElementById('location-search-results').innerHTML = '';
  renderSavedLocations();
  document.getElementById('location-modal')?.classList.remove('hidden');
}

function closeLocationModal() {
  document.getElementById('location-modal')?.classList.add('hidden');
}

function renderSavedLocations() {
  const list = document.getElementById('saved-locations-list');
  if (!list) return;
  list.innerHTML = state.savedLocations.map((loc) => {
    const active = state.activeLocation.id === loc.id;
    return `
      <div class="loc-item ${active ? 'active' : ''}" data-select-loc="${escapeHtml(loc.id)}">
        <div>
          <div class="loc-item-name">${escapeHtml(loc.name)}</div>
          <div class="loc-item-sub">${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}</div>
        </div>
        ${state.savedLocations.length > 1 ? `<button class="icon-btn-sm" data-del-loc="${escapeHtml(loc.id)}" title="Remove">✕</button>` : ''}
      </div>
    `;
  }).join('');

  list.querySelectorAll('[data-select-loc]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-del-loc]')) return;
      const found = state.savedLocations.find((l) => l.id === row.dataset.selectLoc);
      if (found) {
        state.activeLocation = found;
        state.selectedRadarSite = findNearestNexradStation(found.lat, found.lon).id;
        closeLocationModal();
        radarMap.flyTo(found.lat, found.lon, 8.2);
        refreshAllData();
      }
    });
  });

  list.querySelectorAll('[data-del-loc]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.savedLocations = state.savedLocations.filter((l) => l.id !== btn.dataset.delLoc);
      saveLocations();
      if (state.activeLocation.id === btn.dataset.delLoc && state.savedLocations.length) {
        state.activeLocation = state.savedLocations[0];
        refreshAllData();
      }
      renderSavedLocations();
    });
  });
}

async function runLocationSearch() {
  const q = document.getElementById('location-search-input')?.value || '';
  const resEl = document.getElementById('location-search-results');
  if (!q.trim() || !resEl) return;
  resEl.innerHTML = `<div class="alert-meta">Searching...</div>`;
  try {
    const hits = await searchLocations(q);
    if (!hits.length) {
      resEl.innerHTML = `<div class="alert-meta">No matching locations found.</div>`;
      return;
    }
    resEl.innerHTML = hits.map((h, i) => `
      <div class="loc-item" data-pick-hit="${i}">
        <div>
          <div class="loc-item-name">${escapeHtml(h.name)}</div>
          <div class="loc-item-sub">${escapeHtml(h.sub)}</div>
        </div>
        <span class="badge-cyan">Add</span>
      </div>
    `).join('');

    resEl.querySelectorAll('[data-pick-hit]').forEach((row) => {
      row.addEventListener('click', () => {
        const hit = hits[Number(row.dataset.pickHit)];
        const newLoc = {
          id: `loc_${Date.now()}`,
          name: hit.name,
          lat: hit.lat,
          lon: hit.lon
        };
        state.savedLocations.unshift(newLoc);
        saveLocations();
        state.activeLocation = newLoc;
        state.selectedRadarSite = findNearestNexradStation(hit.lat, hit.lon).id;
        closeLocationModal();
        radarMap.flyTo(hit.lat, hit.lon, 8.2);
        refreshAllData();
      });
    });
  } catch {
    resEl.innerHTML = `<div class="alert-meta">Search failed — check connection.</div>`;
  }
}

function openSiteModal() {
  document.getElementById('site-search-input').value = '';
  renderSiteList();
  document.getElementById('site-modal')?.classList.remove('hidden');
}

function renderSiteList() {
  const list = document.getElementById('site-list');
  const q = (document.getElementById('site-search-input')?.value || '').trim().toLowerCase();
  if (!list) return;
  const sorted = getStationsSortedByDistance(state.activeLocation.lat, state.activeLocation.lon);
  const filtered = q
    ? sorted.filter((s) => s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.state.toLowerCase().includes(q))
    : sorted.slice(0, 30);

  list.innerHTML = filtered.map((st) => `
    <div class="loc-item ${st.id === state.selectedRadarSite ? 'active' : ''}" data-pick-site="${st.id}">
      <div>
        <div class="loc-item-name">${st.id} — ${escapeHtml(st.name)}, ${st.state}</div>
        <div class="loc-item-sub">${st.distanceMi.toFixed(0)} miles away</div>
      </div>
      ${st.id === state.selectedRadarSite ? '<span class="badge-cyan">Active</span>' : ''}
    </div>
  `).join('');

  list.querySelectorAll('[data-pick-site]').forEach((row) => {
    row.addEventListener('click', () => {
      state.selectedRadarSite = row.dataset.pickSite;
      document.getElementById('site-modal')?.classList.add('hidden');
      const st = sorted.find((x) => x.id === state.selectedRadarSite);
      if (st) radarMap.flyTo(st.lat, st.lon, 7.6);
      if (state.settings.radarProduct === 'CONUS_MOSAIC') {
        selectRadarProduct('N0B');
      } else {
        loadRadarFramesForCurrentProduct();
      }
      updateHeaderAndBadges();
    });
  });
}
