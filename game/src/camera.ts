/**
 * Camera placement. Third person (default): behind and above the player, orbiting with the look direction,
 * pulled in so it never ends up inside a building. First person: at eye height.
 */
import * as THREE from "three";
import type { Look } from "./controls";

export type View = "third" | "first";

export interface Follow {
  /** Distance behind the target and height above the ground (m). */
  distance: number;
  height: number;
}
export const ON_FOOT: Follow = { distance: 3.4, height: 1.9 };
export const ON_SCOOTER: Follow = { distance: 4.6, height: 2.2 };
const EYE_HEIGHT = 1.6;

/**
 * Put the camera for a target at (x, y) data coordinates, z metres above ground.
 * `blocked(x, y)` says whether a 2D point is inside a building; the camera stops short of it.
 */
export function placeCamera(
  camera: THREE.PerspectiveCamera,
  view: View,
  look: Look,
  x: number,
  y: number,
  z: number,
  follow: Follow,
  blocked: (x: number, y: number, r?: number) => boolean,
) {
  const dir = new THREE.Vector3(
    Math.sin(look.yaw) * Math.cos(look.pitch),
    Math.sin(look.pitch),
    -Math.cos(look.yaw) * Math.cos(look.pitch),
  );
  if (view === "first") {
    camera.position.set(x, EYE_HEIGHT + z, -y);
    camera.lookAt(camera.position.clone().add(dir));
    return;
  }
  const target = new THREE.Vector3(x, 1.5 + z, -y);
  // orbit: looking up lowers the camera, looking down raises it
  const back = follow.distance * Math.cos(look.pitch * 0.8);
  const up = follow.height - 1.5 - follow.distance * Math.sin(look.pitch * 0.8);
  let d = 1;
  // walk out from the target; stop before the first point that is inside a building
  for (let t = 0.1; t <= 1.0001; t += 0.05) {
    const px = x - Math.sin(look.yaw) * back * t;
    const py = y - Math.cos(look.yaw) * back * t;
    if (blocked(px, py, 0.2)) {
      d = Math.max(0.15, t - 0.1);
      break;
    }
  }
  camera.position.set(
    x - Math.sin(look.yaw) * back * d,
    Math.max(0.4, target.y + up * d),
    -(y - Math.cos(look.yaw) * back * d),
  );
  camera.lookAt(target.clone().add(dir.multiplyScalar(2)));
}
