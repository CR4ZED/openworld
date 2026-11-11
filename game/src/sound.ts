/** Sounds made in code with Web Audio (no audio files). Browsers only allow sound after a tap or key press. */

let ctx: AudioContext | null = null;
let honks = 0;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null; // no audio available: the game works silently
  }
}

/** A short two-tone scooter horn ("peep-peep" style, two square-wave tones slightly apart). */
export function honk() {
  honks++;
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const gain = a.createGain();
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.12, t + 0.01);
  gain.gain.setValueAtTime(0.12, t + 0.32);
  gain.gain.linearRampToValueAtTime(0, t + 0.36);
  gain.connect(a.destination);
  for (const f of [415, 494]) {
    const o = a.createOscillator();
    o.type = "square";
    o.frequency.value = f;
    o.connect(gain);
    o.start(t);
    o.stop(t + 0.37);
  }
}

export const honkCount = () => honks;
