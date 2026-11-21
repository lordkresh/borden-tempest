# Borden Tempest — iOS Companion Web App (PWA)

A **100% free, non-expiring, auto-updating** iPhone companion version of **Borden Tempest**, built to run directly from **GitHub Pages** with zero build steps, zero server costs, and no \$99/year Apple Developer fee.

## Features
- **Multi-Station NWS + Open-Meteo Accuracy Consensus** (blends nearby ASOS/AWOS stations, NWS NDFD hourly/7-day forecasts, and Open-Meteo hyperlocal data)
- **Interactive MapLibre GL NEXRAD Radar** (`OpenFreeMap Dark` & `Daylight` basemaps):
  - **CONUS High-Res Composite Reflectivity** (10-frame animated playback loop)
  - **Single-Site NEXRAD RIDGE Products:** `N0B` Super-Res Reflectivity, `N0G` Super-Res Velocity, `N0C` Correlation Coefficient (ρhv / Tornado Debris), `N0X` Differential Reflectivity (ZDR), `EET` Enhanced Echo Tops
  - **Live Overlays:** NWS Warning Polygons, NEXRAD Storm Cells + Threat Cones + Time-on-Target (TOT) Intercept Lines, SPC Day 1 Outlooks, SPC Mesoscale Discussions (MCD), and 6-hour Local Storm Reports (LSR)
- **Convective & Supercell Environment Analyzer:** CAPE, 0–1.5km bulk shear & veering, 3-hr pressure fall, HSLC detection, and nocturnal readiness
- **Full Winter, Ground Temp & Fog Suite:** 0cm/6cm ground temperatures, bridge/road icing risk, freezing level in feet, hours below freezing, Black Ice, Freezing Fog & Dense Fog detection
- **All 8 Custom Sirens & Chimes** directly from Borden Tempest Android (`tornado_siren_wail`, `tornado_siren_eas`, `noaa_eas_tone`, `supercell_alert_alarm`, `svr_tstorm_alarm`, `storm_tot_ping`, `convective_chime`, `winter_alert_chime`) + built-in Test Alert Simulator
- **Built-in OTA Auto-Updater:** Checks `version.json` + Service Worker updates on startup and via **Settings → Check for Updates**

---

## Publish to GitHub Pages (Takes ~2 Minutes, Free Forever)

1. Go to [github.com/new](https://github.com/new) (signed into `lordkresh`).
2. Create a new **Public** repository named **`borden-tempest`** (leave "Add a README" unchecked).
3. Click **uploading an existing file** on the empty repo page, drag-and-drop **all files and folders inside `borden-tempest-ios`** (`index.html`, `manifest.webmanifest`, `sw.js`, `version.json`, `css/`, `js/`, `assets/`), and click **Commit changes**.
4. Open the repo's **Settings → Pages**:
   - Under **Source**, choose **Deploy from a branch**
   - Branch: **`main`**, Folder: **`/ (root)`** → click **Save**
5. After ~30–60 seconds, your live iPhone link will be:
   **`https://lordkresh.github.io/borden-tempest/`**

## Install on iPhone (Free, Never Expires)
1. Text the link `https://lordkresh.github.io/borden-tempest/` to the iPhone.
2. Open it in **Safari** → tap the **Share** button → tap **Add to Home Screen**.
3. Open **Borden Tempest** from the iPhone Home Screen!

## How to Push Updates Later
Whenever you update any files in the `borden-tempest` repo:
1. Bump `versionCode` (e.g., `2` → `3`) and `versionName` (e.g., `"1.1.0"` → `"1.2.0"`) in **`version.json`** and **`js/updater.js`**, and update `CACHE_NAME` in **`sw.js`**.
2. Upload/commit the changed files to GitHub.
3. The iPhone will automatically detect the update on launch (or in **Settings → Check for Updates**) and show a one-tap **Update** banner!
