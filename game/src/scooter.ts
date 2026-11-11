/**
 * Scooter riding on the flat world, tuned to a real 110 cc step-through scooter (the most common two-wheeler
 * in Andhra towns). Reference: Autocar India road test of the Honda Activa 110 (2025): top speed 85 km/h,
 * 0-40 km/h 3.64 s, 0-60 km/h 8.13 s, 0-80 km/h 18.12 s, 60-0 km/h in 18.43 m.
 * Owner 2026-11-11: the earlier 45 km/h cap was not true to life.
 * Our model: drive acceleration 3.7 m/s² falling linearly to zero at 86 km/h (fitted: 0-40 4.1 s, 0-60 7.8 s,
 * 0-80 18.1 s); brakes 7.5 m/s² (60-0 in 18.4 m).
 */
import type { Pt } from "./types";

/** Anything that can move a circle around obstacles (the world collider, or test ground). */
export interface Mover {
  move(x: number, y: number, dx: number, dy: number, r?: number): Pt;
  /** Unit vector pointing away from the nearest wall within r metres, or null in the open. */
  normal?(x: number, y: number, r: number): Pt | null;
}

export const SCOOTER = {
  maxSpeed: 85 / 3.6, // m/s, the speedometer never shows more
  driveTop: 86 / 3.6, // m/s, where the engine's push fades to nothing
  drive: 3.7, // m/s² from standstill
  maxReverse: 1.5, // m/s, pushing it backwards with your feet
  brake: 7.5, // m/s²
  rolling: 0.35, // m/s² coasting: engine braking + tyres
  air: 0.0012, // per metre: air drag (v² term), only when coasting
  turnRate: 1.6, // rad/s at moderate speed
  radius: 0.6, // m, collision size
  bounce: 0.3, // how much of the speed into a wall comes back out
  crashSpeed: 20 / 3.6, // m/s straight into a wall: above this the rider comes off and the scooter falls
  fallenSlide: 6, // m/s² a scooter on its side scrapes to a stop
};

export interface ScooterState {
  x: number;
  y: number;
  heading: number; // radians, 0 = north, clockwise positive (same as look.yaw)
  speed: number; // m/s along the heading, negative = backwards
  distance: number; // total metres travelled (spins the wheels)
  lean: number; // radians, visual: into turns, or lying on its side when fallen
  wobble: number; // radians, visual shake after a knock (decays)
  fallen: boolean; // knocked over: needs picking up (E)
  slideX: number; // m/s, sliding velocity while fallen
  slideY: number;
}

export interface Impact {
  hit: boolean; // touched a wall this step
  impact: number; // m/s of speed straight into the wall
  crashed: boolean; // hard enough to knock the rider off
  normal: Pt | null; // which way the wall faces (rider is thrown that way)
}

export function newScooter(x: number, y: number, heading: number): ScooterState {
  return { x, y, heading, speed: 0, distance: 0, lean: 0, wobble: 0, fallen: false, slideX: 0, slideY: 0 };
}

/** Engine push at a given speed (m/s²): strong when slow, fading to nothing at the top. */
export const driveAt = (v: number) => SCOOTER.drive * Math.max(0, 1 - v / SCOOTER.driveTop);

/**
 * Advance the scooter by dt seconds. throttle -1..1 (negative = brake, then push backwards), steer -1..1 (right +).
 * A fallen scooter ignores the controls and slides to a stop.
 */
export function rideStep(s: ScooterState, dt: number, throttle: number, steer: number, mover: Mover): Impact {
  const none: Impact = { hit: false, impact: 0, crashed: false, normal: null };
  if (!(dt > 0)) return none;
  s.wobble *= Math.exp(-dt * 4);
  if (s.fallen) {
    const v = Math.hypot(s.slideX, s.slideY);
    const nv = Math.max(0, v - SCOOTER.fallenSlide * dt);
    if (v > 1e-6) {
      s.slideX *= nv / v;
      s.slideY *= nv / v;
      const [fx, fy] = mover.move(s.x, s.y, s.slideX * dt, s.slideY * dt, SCOOTER.radius);
      s.x = fx;
      s.y = fy;
    }
    s.speed = 0;
    s.lean += ((s.lean < 0 ? -1 : 1) * 1.38 - s.lean) * Math.min(1, dt * 8); // tips onto its side
    return none;
  }
  const v0 = Math.abs(s.speed);
  if (throttle > 0)
    s.speed = Math.min(SCOOTER.maxSpeed, s.speed + driveAt(Math.max(0, s.speed)) * throttle * dt);
  else if (throttle < 0) {
    if (s.speed > 0) s.speed = Math.max(0, s.speed + SCOOTER.brake * throttle * dt);
    else s.speed = Math.max(-SCOOTER.maxReverse, s.speed + 1.3 * throttle * dt);
  } else {
    const d = (SCOOTER.rolling + SCOOTER.air * s.speed * s.speed) * dt;
    s.speed = Math.abs(s.speed) <= d ? 0 : s.speed - Math.sign(s.speed) * d;
  }
  // steering needs some speed, and gets gentler at high speed (like a real two-wheeler)
  const v = Math.abs(s.speed);
  const grip = Math.min(1, v / 2) * (1 - 0.45 * Math.min(1, v / SCOOTER.maxSpeed));
  s.heading += steer * SCOOTER.turnRate * grip * dt * Math.sign(s.speed || 1);
  s.lean += (-steer * 0.35 * Math.min(1, v / 6) - s.lean) * Math.min(1, dt * 6);

  const dx = Math.sin(s.heading) * s.speed * dt;
  const dy = Math.cos(s.heading) * s.speed * dt;
  const [nx, ny] = mover.move(s.x, s.y, dx, dy, SCOOTER.radius);
  const mx = nx - s.x,
    my = ny - s.y;
  s.distance += Math.hypot(mx, my) * Math.sign(s.speed || 1);
  s.x = nx;
  s.y = ny;
  const wanted = Math.hypot(dx, dy);
  if (wanted < 1e-6 || Math.hypot(mx - dx, my - dy) < wanted * 0.02) return none;

  // ---- we hit something: bounce off the part of the motion into the wall, scrape along the rest ----
  const n = mover.normal?.(s.x, s.y, SCOOTER.radius + 0.35) ?? ([-dx / wanted, -dy / wanted] as Pt);
  let vx = Math.sin(s.heading) * s.speed,
    vy = Math.cos(s.heading) * s.speed;
  const into = vx * n[0] + vy * n[1]; // negative = moving into the wall
  if (into >= 0) return none;
  const impact = -into;
  const tx = vx - into * n[0],
    ty = vy - into * n[1]; // the part of the motion along the wall
  const keep = 1 - Math.min(0.5, impact * 0.06); // scraping the wall costs some of it
  vx = tx * keep - SCOOTER.bounce * into * n[0];
  vy = ty * keep - SCOOTER.bounce * into * n[1];
  s.wobble = Math.min(0.45, 0.05 + impact * 0.04);
  if (impact > SCOOTER.crashSpeed) {
    // knocked over: the scooter falls to one side and slides; the rider comes off (handled by the game)
    s.fallen = true;
    s.slideX = vx;
    s.slideY = vy;
    s.speed = 0;
    const side = tx * Math.cos(s.heading) - ty * Math.sin(s.heading); // + = sliding to its right
    s.lean = side >= 0 ? -0.3 : 0.3;
    return { hit: true, impact, crashed: true, normal: n };
  }
  // glancing off: the scooter yaws to follow the wall and keeps going; head-on bump: it rolls back a little
  const along = vx * Math.sin(s.heading) + vy * Math.cos(s.heading);
  const sp = Math.hypot(vx, vy);
  if (Math.hypot(tx, ty) > impact * 0.6 && along > 0) {
    const want = Math.atan2(vx, vy);
    s.heading += Math.atan2(Math.sin(want - s.heading), Math.cos(want - s.heading)) * 0.7;
    s.speed = sp;
  } else s.speed = -Math.min(sp, v0);
  return { hit: true, impact, crashed: false, normal: n };
}

/** Pick a fallen scooter back up. */
export function liftScooter(s: ScooterState) {
  s.fallen = false;
  s.lean = 0;
  s.speed = s.slideX = s.slideY = 0;
}
