/**
 * Scooter riding: simple, readable physics on the flat world.
 * Speeds are real-world: a 110 cc step-through scooter tops out around 80 km/h, but colony lanes are ridden far
 * slower; we cap at 45 km/h (12.5 m/s) so riding feels like the colony, not a race track.
 */
import type { Pt } from "./types";

/** Anything that can move a circle around obstacles (the world collider, or open ground in tests). */
export interface Mover {
  move(x: number, y: number, dx: number, dy: number, r?: number): Pt;
}

export const SCOOTER = {
  maxSpeed: 12.5, // m/s (45 km/h)
  maxReverse: 1.5, // m/s, pushing it backwards
  accel: 2.6, // m/s² (0-40 km/h in ~4-5 s)
  brake: 7.0, // m/s²
  drag: 0.6, // m/s² coasting slowdown
  turnRate: 1.6, // rad/s at moderate speed
  radius: 0.6, // m, collision size
};

export interface ScooterState {
  x: number;
  y: number;
  heading: number; // radians, 0 = north, clockwise positive (same as look.yaw)
  speed: number; // m/s, negative = backwards
  distance: number; // total metres travelled (spins the wheels)
  lean: number; // radians, visual only
}

export function newScooter(x: number, y: number, heading: number): ScooterState {
  return { x, y, heading, speed: 0, distance: 0, lean: 0 };
}

/**
 * Advance the scooter by dt seconds. throttle -1..1 (negative = brake, then reverse), steer -1..1 (right +).
 * Returns true if it hit something this step.
 */
export function rideStep(
  s: ScooterState,
  dt: number,
  throttle: number,
  steer: number,
  collider: Mover,
): boolean {
  if (throttle > 0) s.speed = Math.min(SCOOTER.maxSpeed, s.speed + SCOOTER.accel * throttle * dt);
  else if (throttle < 0) {
    if (s.speed > 0) s.speed = Math.max(0, s.speed + SCOOTER.brake * throttle * dt);
    else s.speed = Math.max(-SCOOTER.maxReverse, s.speed + SCOOTER.accel * 0.5 * throttle * dt);
  } else {
    const d = SCOOTER.drag * dt;
    s.speed = Math.abs(s.speed) <= d ? 0 : s.speed - Math.sign(s.speed) * d;
  }
  // steering needs some speed, and gets gentler at high speed (like a real two-wheeler)
  const v = Math.abs(s.speed);
  const grip = Math.min(1, v / 2) * (1 - 0.45 * Math.min(1, v / SCOOTER.maxSpeed));
  s.heading += steer * SCOOTER.turnRate * grip * dt * Math.sign(s.speed || 1);
  s.lean += (-steer * 0.35 * Math.min(1, v / 6) - s.lean) * Math.min(1, dt * 6);

  const dx = Math.sin(s.heading) * s.speed * dt;
  const dy = Math.cos(s.heading) * s.speed * dt;
  const [nx, ny] = collider.move(s.x, s.y, dx, dy, SCOOTER.radius);
  const moved = Math.hypot(nx - s.x, ny - s.y);
  const wanted = Math.hypot(dx, dy);
  const hit = wanted > 1e-6 && moved < wanted * 0.5;
  // hitting a wall scrubs off most of the speed (no bouncing, no damage yet)
  if (hit) s.speed *= 0.2;
  s.distance += moved * Math.sign(s.speed || 1);
  s.x = nx;
  s.y = ny;
  return hit;
}
