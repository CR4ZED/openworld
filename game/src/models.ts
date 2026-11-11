/**
 * Low-poly models built in code: the player character and a generic step-through scooter (no real brand).
 * Sizes are real-world (metres). Each rigid part is one merged mesh with vertex colours, all sharing one
 * material, so the character costs 5 draw calls and the scooter 3.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const MODEL_MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true });

/** A box geometry of one colour, moved to (x, y, z). */
function box(w: number, h: number, d: number, color: string, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y, z);
  return paint(g, color);
}

function paint(g: THREE.BufferGeometry, color: string) {
  const c = new THREE.Color(color);
  const n = g.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(col, i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

/** One mesh from several coloured pieces. */
function part(name: string, pieces: THREE.BufferGeometry[]) {
  const m = new THREE.Mesh(mergeGeometries(pieces, false)!, MODEL_MATERIAL);
  m.name = name;
  m.castShadow = true;
  return m;
}

export interface Character {
  root: THREE.Group;
  /** Animate limbs: speed in m/s (0 = standing), t = running time in seconds. `seated` = sitting on the scooter. */
  animate(speed: number, t: number, seated: boolean): void;
}

/**
 * A young man from the colony: half-sleeve shirt, dark trousers, chappals. About 1.70 m tall.
 * The group's origin is between the feet; it faces -z (three.js forward).
 */
export function makeCharacter(): Character {
  const root = new THREE.Group();
  root.name = "player";
  const SKIN = "#8d5a3b";
  const SHIRT = "#3f7cac";
  const TROUSERS = "#2e3440";

  const hips = new THREE.Group();
  hips.position.y = 0.92;
  root.add(hips);
  hips.add(
    part("player-body", [
      box(0.38, 0.55, 0.22, SHIRT, 0, 0.3, 0), // torso
      box(0.2, 0.24, 0.22, SKIN, 0, 0.72, 0), // head
      box(0.21, 0.07, 0.23, "#1b1b1b", 0, 0.86, 0.005), // hair
      box(0.08, 0.06, 0.1, SKIN, 0, 0.6, 0), // neck
    ]),
  );

  // a limb hangs from a pivot (hip or shoulder); upper and lower part in different colours
  const limb = (name: string, x: number, y: number, upper: string, lower: string, len: number, w: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const pieces = [
      box(w, len * 0.55, w, upper, 0, -len * 0.275, 0),
      box(w * 0.9, len * 0.45, w * 0.9, lower, 0, -len * 0.775, 0),
    ];
    if (name.startsWith("leg")) pieces.push(box(0.13, 0.03, 0.26, "#4a3426", 0, -len, -0.04)); // chappal
    pivot.add(part(`player-${name}`, pieces));
    return pivot;
  };
  const legL = limb("legL", -0.1, 0, TROUSERS, TROUSERS, 0.9, 0.14);
  const legR = limb("legR", 0.1, 0, TROUSERS, TROUSERS, 0.9, 0.14);
  const armL = limb("armL", -0.24, 0.55, SHIRT, SKIN, 0.62, 0.1);
  const armR = limb("armR", 0.24, 0.55, SHIRT, SKIN, 0.62, 0.1);
  hips.add(legL, legR, armL, armR);

  return {
    root,
    animate(speed, t, seated) {
      if (seated) {
        // sitting on the seat (0.79 m): thighs forward, hands forward on the handlebar
        hips.position.y = 0.8;
        legL.rotation.x = legR.rotation.x = 0.7; // feet forward on the floorboard
        armL.rotation.x = armR.rotation.x = 1.2; // hands on the handlebar
        return;
      }
      const phase = t * (4 + speed * 1.6);
      const swing = Math.min(1, speed / 4) * 0.6 * Math.sin(phase);
      legL.rotation.x = swing;
      legR.rotation.x = -swing;
      armL.rotation.x = -swing * 0.8;
      armR.rotation.x = swing * 0.8;
      hips.position.y = 0.92 + Math.abs(Math.sin(phase)) * 0.03 * Math.min(1, speed);
    },
  };
}

export interface ScooterModel {
  root: THREE.Group;
  /** Where the rider sits: put the character's root in here while riding. */
  seat: THREE.Group;
  /** Spin wheels by distance travelled (m) and lean into a turn (radians). */
  pose(distance: number, lean: number): void;
}

/** A generic step-through scooter, about 1.8 m long. Origin on the ground under its centre; faces -z. */
export function makeScooter(color = "#b3262e"): ScooterModel {
  const root = new THREE.Group();
  root.name = "scooter";
  const lean = new THREE.Group();
  root.add(lean);
  const R = 0.25; // wheel radius (10-inch class wheel with tyre)
  lean.add(
    part("scooter-body", [
      box(0.32, 0.36, 0.7, color, 0, 0.52, 0.32), // rear body under the seat
      box(0.3, 0.1, 0.62, "#1d1d1f", 0, 0.75, 0.28), // seat
      box(0.24, 0.08, 0.5, "#2a2a2c", 0, 0.32, -0.12), // floorboard
      box(0.3, 0.7, 0.16, color, 0, 0.62, -0.46), // front leg shield
      box(0.08, 0.5, 0.08, "#2a2a2c", 0, 0.85, -0.55), // steering column
      box(0.6, 0.05, 0.05, "#2a2a2c", 0, 1.08, -0.55), // handlebar
      box(0.16, 0.12, 0.08, "#f4f1d0", 0, 0.98, -0.62), // headlight
      box(0.2, 0.08, 0.04, "#c0392b", 0, 0.62, 0.68), // tail light
    ]),
  );
  const wheel = (name: string, z: number) => {
    const tyre = new THREE.CylinderGeometry(R, R, 0.11, 14).toNonIndexed();
    tyre.rotateZ(Math.PI / 2);
    paint(tyre, "#151515");
    // a light stripe across the hub so the spin is visible
    const hub = new THREE.Group();
    hub.position.set(0, R, z);
    hub.add(part(name, [tyre, box(0.115, 0.03, R * 1.6, "#9a9a9a")]));
    return hub;
  };
  const front = wheel("scooter-front-wheel", -0.62);
  const rear = wheel("scooter-rear-wheel", 0.6);
  lean.add(front, rear);
  const seat = new THREE.Group();
  seat.position.set(0, 0, 0.15); // hips over the front half of the seat, hands reach the handlebar
  lean.add(seat);
  return {
    root,
    seat,
    pose(distance, leanAngle) {
      front.rotation.x = rear.rotation.x = -distance / R;
      lean.rotation.z = leanAngle;
    },
  };
}
