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
    this.unlocked = false;
    this.onStateChange = null;
  }

  unlockForIOS() {
    if (this.unlocked) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      }
      this.unlocked = true;
    } catch {
      // ignore
    }
  }

  stop() {
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
      } catch {
        // ignore
      }
      this.currentAudio = null;
    }
    this.currentId = null;
    if (this.onStateChange) this.onStateChange(null);
  }

  async play(soundId, loop = false) {
    const item = SIREN_CATALOG.find((s) => s.id === soundId) || SIREN_CATALOG[0];
    this.stop();

    const audio = new Audio(item.file);
    audio.loop = loop;
    audio.preload = 'auto';
    audio.playsInline = true;
    this.currentAudio = audio;
    this.currentId = item.id;

    audio.addEventListener('ended', () => {
      if (!loop && this.currentAudio === audio) {
        this.currentAudio = null;
        this.currentId = null;
        if (this.onStateChange) this.onStateChange(null);
      }
    });

    if (this.onStateChange) this.onStateChange(item.id);

    try {
      await audio.play();
      return true;
    } catch {
      this.currentAudio = null;
      this.currentId = null;
      if (this.onStateChange) this.onStateChange(null);
      return false;
    }
  }

  togglePreview(soundId) {
    if (this.currentId === soundId) {
      this.stop();
      return false;
    }
    this.play(soundId, false);
    return true;
  }
}

export const audioEngine = new TempestAudioEngine();
