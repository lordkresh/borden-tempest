export const SIREN_CATALOG = [
  {
    id: 'tornado_siren_wail',
    name: 'Tornado Siren Wail',
    sub: 'Classic outdoor mechanical civil defense wail',
    file: './assets/audio/tornado_siren_wail.wav',
    category: 'tornado'
  },
  {
    id: 'tornado_siren_eas',
    name: 'EAS Dual-Tone + Tornado Siren',
    sub: 'NOAA EAS attention tone + tornado wail',
    file: './assets/audio/tornado_siren_eas.wav',
    category: 'tornado'
  },
  {
    id: 'noaa_eas_tone',
    name: 'NOAA Weather Radio EAS Tone',
    sub: '1050 Hz / Dual-tone broadcast attention signal',
    file: './assets/audio/noaa_eas_tone.wav',
    category: 'tornado'
  },
  {
    id: 'supercell_alert_alarm',
    name: 'Rotating Supercell Alarm',
    sub: 'Urgent high-priority mesocyclone/TVS alarm',
    file: './assets/audio/supercell_alert_alarm.wav',
    category: 'supercell'
  },
  {
    id: 'svr_tstorm_alarm',
    name: 'Severe Thunderstorm Alarm',
    sub: 'Severe wind & hail warning pulse',
    file: './assets/audio/svr_tstorm_alarm.wav',
    category: 'severe'
  },
  {
    id: 'storm_tot_ping',
    name: 'Storm Time-on-Target (TOT) Ping',
    sub: 'Proactive approaching storm intercept chime',
    file: './assets/audio/storm_tot_ping.wav',
    category: 'tot'
  },
  {
    id: 'convective_chime',
    name: 'Convective Environment Chime',
    sub: 'Elevated CAPE / Shear / HSLC notification tone',
    file: './assets/audio/convective_chime.wav',
    category: 'convective'
  },
  {
    id: 'winter_alert_chime',
    name: 'Winter / Black Ice Chime',
    sub: 'Freezing rain, black ice & freezing fog alert',
    file: './assets/audio/winter_alert_chime.wav',
    category: 'winter'
  }
];

class TempestAudioEngine {
  constructor() {
    this.currentAudio = null;
    this.currentId = null;
    this.audioCtx = null;
    this.unlocked = false;
    this.onStateChange = null;
  }

  unlockForIOS() {
    if (typeof window === 'undefined') return;
    // On iOS Safari standalone PWAs, backgrounding can transition an already-unlocked AudioContext
    // to 'interrupted' or 'suspended'. Only early-return when the context is actively running.
    if (this.unlocked && (!this.audioCtx || this.audioCtx.state === 'running')) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        if (!this.audioCtx || this.audioCtx.state === 'closed') {
          this.audioCtx = new AudioCtx();
        }
        const ctx = this.audioCtx;
        if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
          this.unlocked = false;
          ctx.resume()
            .then(() => {
              if (this.audioCtx && this.audioCtx.state === 'running') {
                this.unlocked = true;
              }
            })
            .catch(() => {});
        }
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        if (ctx.state === 'running') {
          this.unlocked = true;
        }
      } else {
        this.unlocked = true;
      }
    } catch {
      // ignore restricted audio contexts
    }
  }

  stop() {
    const active = this.currentAudio;
    this.currentAudio = null;
    this.currentId = null;
    if (active) {
      try {
        active.pause();
        active.currentTime = 0;
      } catch {
        // ignore
      }
    }
    if (this.onStateChange) this.onStateChange(null);
  }

  async play(soundId, loop = false) {
    const item = SIREN_CATALOG.find((s) => s.id === soundId) || SIREN_CATALOG[0];
    this.stop();

    if (typeof Audio === 'undefined') {
      return false;
    }

    let audio;
    try {
      audio = new Audio(item.file);
    } catch {
      return false;
    }

    audio.loop = Boolean(loop);
    audio.preload = 'auto';
    audio.playsInline = true;
    this.currentAudio = audio;
    this.currentId = item.id;

    const cleanupIfCurrent = () => {
      if (this.currentAudio === audio) {
        this.currentAudio = null;
        this.currentId = null;
        if (this.onStateChange) this.onStateChange(null);
      }
    };

    audio.addEventListener('ended', () => {
      if (!loop) cleanupIfCurrent();
    });
    audio.addEventListener('error', cleanupIfCurrent);

    if (this.onStateChange) this.onStateChange(item.id);

    try {
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.then === 'function') {
        await playPromise;
      }
      return this.currentAudio === audio;
    } catch {
      // Only clear state if this exact audio instance is still active (avoids clobbering a newer play())
      cleanupIfCurrent();
      return false;
    }
  }

  togglePreview(soundId) {
    if (this.currentId === soundId) {
      this.stop();
      return false;
    }
    void this.play(soundId, false).catch(() => false);
    return true;
  }
}

export const audioEngine = new TempestAudioEngine();
