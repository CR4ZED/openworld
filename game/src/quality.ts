/**
 * Graphics quality. High: sun shadows, full pixel ratio (up to 2). Low: no shadows, pixel ratio 1.
 * Budget phones start on Low so the game stays smooth; the player can switch any time.
 */
export type Quality = "high" | "low";

const KEY = "openworld.quality";

export function defaultQuality(isTouch: boolean): Quality {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "high" || saved === "low") return saved;
  } catch {
    /* storage unavailable */
  }
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  // phones with few cores or little memory are budget devices
  return isTouch && (cores <= 4 || memory <= 4) ? "low" : "high";
}

export function saveQuality(q: Quality) {
  try {
    localStorage.setItem(KEY, q);
  } catch {
    /* storage unavailable: setting lasts for this visit */
  }
}
