/**
 * Moving on foot: paces, smooth starting/stopping, turning the body, jumping, and the gait phase that drives
 * the walk animation. Real human numbers (owner 2026-11-11: the old 1.4 m/s stroll felt far too slow).
 */
import type { Input } from "./controls";
import type { Mover } from "./scooter";

export const PACE = {
  walk: 1.6, // m/s, a brisk walk
  jog: 3.5, // m/s, an easy jog: the default, like most open-world games
  sprint: 6.0, // m/s, running hard (Shift)
};
const ACCEL = 10; // m/s²: reach a jog in about a third of a second
const DECEL = 14; // m/s²: stop within a quarter of a second, no sliding on ice
const TURN = 10; // how fast the body turns towards where you go (per second)
const GRAVITY = 9.81; // m/s²
export const JUMP_SPEED = 3.0; // m/s upwards: about 0.46 m high, a normal standing jump

/**
 * Length of one full gait cycle (two steps) in metres at a given speed. Longer strides when faster, as people do:
 * about 1.8 steps/s walking, 2.5 jogging, 3 sprinting.
 */
export const cycleLength = (speed: number) => 1.0 + 0.5 * Math.min(speed, 6);

export interface Walker {
  x: number;
  y: number;
  z: number; // height above the ground (jumping)
  vz: number; // vertical speed
  vx: number; // ground velocity (m/s, data coords)
  vy: number;
  facing: number; // where the body points (radians, 0 = north, clockwise)
  speed: number; // actual ground speed this step (m/s): 0 when pushing against a wall
  phase: number; // gait phase (radians), advances with distance travelled
}

export function newWalker(x: number, y: number, facing: number): Walker {
  return { x, y, z: 0, vz: 0, vx: 0, vy: 0, facing, speed: 0, phase: 0 };
}

/** The pace asked for: Shift sprints, walk mode (C) or a light push on the joystick walks, otherwise jog. */
export function paceFor(input: Input, walkMode: boolean) {
  const push = Math.min(1, Math.hypot(input.forward, input.strafe));
  if (push < 0.05) return 0;
  if (input.run) return PACE.sprint;
  if (walkMode) return PACE.walk;
  return push < 0.65 ? PACE.walk * Math.max(0.4, push / 0.65) : PACE.jog;
}

/** Advance the walker by dt seconds. `yaw` = camera direction (movement is relative to it). Returns true on a jump. */
export function walkStep(p: Walker, yaw: number, dt: number, input: Input, walkMode: boolean, mover: Mover) {
  if (!(dt > 0)) return false; // the very first frame can have no time step (0/0 would poison the speed)
  const fx = Math.sin(yaw),
    fy = Math.cos(yaw); // forward in data coords (x east, y north)
  const rx = Math.cos(yaw),
    ry = -Math.sin(yaw); // right
  let dx = fx * input.forward + rx * input.strafe;
  let dy = fy * input.forward + ry * input.strafe;
  const m = Math.hypot(dx, dy);
  if (m > 1e-6) {
    dx /= m;
    dy /= m;
  }
  const pace = paceFor(input, walkMode);
  // ease the velocity towards the wanted one (people don't start or stop instantly, but nearly)
  const tx = dx * pace,
    ty = dy * pace;
  const ex = tx - p.vx,
    ey = ty - p.vy;
  const e = Math.hypot(ex, ey);
  const maxChange = (pace > Math.hypot(p.vx, p.vy) ? ACCEL : DECEL) * dt;
  if (e <= maxChange) {
    p.vx = tx;
    p.vy = ty;
  } else {
    p.vx += (ex / e) * maxChange;
    p.vy += (ey / e) * maxChange;
  }
  const [nx, ny] = mover.move(p.x, p.y, p.vx * dt, p.vy * dt);
  const mx = nx - p.x,
    my = ny - p.y;
  p.x = nx;
  p.y = ny;
  const moved = Math.hypot(mx, my);
  p.speed = moved / dt;
  // blocked by a wall: velocity becomes what really happened (so legs stop instead of running on the spot)
  p.vx = mx / dt;
  p.vy = my / dt;
  // the gait cycle follows the ground covered, so feet stay planted instead of sliding
  if (p.z <= 0) p.phase = (p.phase + (moved / cycleLength(p.speed)) * 2 * Math.PI) % (2 * Math.PI);
  // the body turns smoothly towards where you go
  if (moved > 1e-4 && m > 0.05) {
    const want = Math.atan2(mx, my);
    const diff = Math.atan2(Math.sin(want - p.facing), Math.cos(want - p.facing));
    p.facing += diff * Math.min(1, dt * TURN);
  }
  // jumping: only from the ground (no double jumps); gravity brings you back down
  let jumped = false;
  const grounded = p.z <= 0;
  if (input.jump && grounded) {
    p.vz = JUMP_SPEED;
    jumped = true;
  }
  if (!grounded || p.vz > 0) {
    p.vz -= GRAVITY * dt;
    p.z = Math.max(0, p.z + p.vz * dt);
    if (p.z === 0) p.vz = 0;
  }
  return jumped;
}
