import { memo, useEffect, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import '../styles/weather-effects.css';

const drops = Array.from({ length: 16 }, (_, index) => ({
  left: `${(index * 47 + 7) % 100}%`,
  animationDelay: `${-(index * .37)}s`,
  animationDuration: `${1.1 + (index % 5) * .15}s`,
}));

export const WeatherEffects = memo(function WeatherEffects({ active }: { active: boolean }) {
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [audioUnavailable, setAudioUnavailable] = useState(false);
  const [lightning, setLightning] = useState(false);

  useEffect(() => {
    if (!active) return;
    setLightning(false);
    let context: AudioContext | undefined;
    let noise: AudioBuffer | undefined;
    let rain: AudioBufferSourceNode | undefined;
    let stopped = false;
    let flashTimer = 0;

    // Generate quiet ambience locally; no downloads or streaming audio.
    if (soundEnabled) {
      try {
        context = new AudioContext();
        noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
        const samples = noise.getChannelData(0);
        for (let index = 0; index < samples.length; index++) samples[index] = Math.random() * 2 - 1;
        rain = context.createBufferSource();
        rain.buffer = noise;
        rain.loop = true;
        const filter = context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 1400;
        const volume = context.createGain();
        volume.gain.value = .025;
        rain.connect(filter).connect(volume).connect(context.destination);
        rain.start();
        void context.resume().then(() => {
          if (!stopped && context?.state !== 'running') setSoundEnabled(false);
        }).catch(() => { if (!stopped) setSoundEnabled(false); });
      } catch {
        setAudioUnavailable(true);
        setSoundEnabled(false);
      }
    }

    const thunder = () => {
      setLightning(true);
      flashTimer = window.setTimeout(() => setLightning(false), 700);
      if (!context || !noise || context.state !== 'running') return;
      const rumble = context.createBufferSource();
      rumble.buffer = noise;
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 180;
      const volume = context.createGain();
      const start = context.currentTime + .25;
      volume.gain.setValueAtTime(0, start);
      volume.gain.linearRampToValueAtTime(.12, start + .25);
      volume.gain.exponentialRampToValueAtTime(.001, start + 1.9);
      rumble.connect(filter).connect(volume).connect(context.destination);
      rumble.onended = () => { rumble.disconnect(); filter.disconnect(); volume.disconnect(); };
      rumble.start(start);
    };
    const firstThunder = window.setTimeout(thunder, 3000);
    const thunderTimer = window.setInterval(thunder, 23000);
    return () => {
      stopped = true;
      window.clearTimeout(firstThunder);
      window.clearTimeout(flashTimer);
      window.clearInterval(thunderTimer);
      rain?.stop();
      if (context && context.state !== 'closed') void context.close().catch(() => undefined);
    };
  }, [active, soundEnabled]);

  if (!active) return null;
  return <div className="weather-effects">
    <div className="rain-layer" aria-hidden="true">
      {drops.map((style, index) => <i key={index} style={style} />)}
    </div>
    <div className={`weather-lightning ${lightning ? 'is-visible' : ''}`} aria-hidden="true" />
    <button type="button" className="weather-audio" aria-pressed={soundEnabled}
      aria-label={soundEnabled ? 'Tắt âm thanh mưa và sấm' : 'Bật âm thanh mưa và sấm'}
      disabled={audioUnavailable} onClick={() => setSoundEnabled(value => !value)}>
      {soundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
      {audioUnavailable ? 'Không hỗ trợ âm thanh' : soundEnabled ? 'Âm thanh bật' : 'Bật âm thanh'}
    </button>
  </div>;
});
