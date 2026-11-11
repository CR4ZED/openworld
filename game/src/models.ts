/**
 * Low-poly models built in code: the player character and a generic step-through scooter (no real brand).
 * Sizes are real-world (metres). Each rigid part is one merged mesh with vertex colours, all sharing one
 * material. The character is one skinned mesh (1 draw call); the scooter is 3.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { cycleLength } from "./player";

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

export interface GaitPose {
  speed: number; // ground speed m/s
  phase: number; // gait phase (radians), from player.ts
  t: number; // running time (s), for idle breathing
  seated: boolean; // sitting on the scooter
  airborne: boolean; // in a jump
}

export interface Character {
  root: THREE.Group;
  animate(g: GaitPose): void;
  /** Joints by name (tests read foot positions and limb angles). */
  bones: Record<string, THREE.Bone>;
}

const LEG = 0.87; // hip to ankle (m)
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * A young man from the colony: half-sleeve shirt, dark trousers, chappals. About 1.72 m tall.
 * One skinned mesh with a skeleton (hips, spine, head, shoulders, elbows, hips, knees, ankles): one draw call.
 * The group's origin is between the feet; it faces -z (three.js forward).
 */
export function makeCharacter(): Character {
  const root = new THREE.Group();
  root.name = "player";
  const SKIN = "#8d5a3b";
  const SHIRT = "#3f7cac";
  const TROUSERS = "#2e3440";
  const HAIR = "#1b1b1b";
  const SOLE = "#4a3426";

  // joints in model space (standing, arms down); each bone is placed relative to its parent
  const list: THREE.Bone[] = [];
  const bones: Record<string, THREE.Bone> = {};
  const world: Record<string, THREE.Vector3> = {};
  const bone = (name: string, parent: string | null, x: number, y: number, z = 0) => {
    const b = new THREE.Bone();
    b.name = name;
    world[name] = new THREE.Vector3(x, y, z);
    if (parent) {
      b.position.copy(world[name]).sub(world[parent]!);
      bones[parent]!.add(b);
    } else b.position.copy(world[name]);
    bones[name] = b;
    list.push(b);
  };
  bone("pelvis", null, 0, 0.92);
  bone("spine", "pelvis", 0, 0.98);
  bone("head", "spine", 0, 1.47);
  for (const [side, sx] of [
    ["L", -1],
    ["R", 1],
  ] as const) {
    bone(`upperArm${side}`, "spine", sx * 0.235, 1.42);
    bone(`forearm${side}`, `upperArm${side}`, sx * 0.235, 1.12);
    bone(`thigh${side}`, "pelvis", sx * 0.1, 0.92);
    bone(`shin${side}`, `thigh${side}`, sx * 0.1, 0.47);
    bone(`foot${side}`, `shin${side}`, sx * 0.1, 0.05);
  }

  // body pieces in model space, each moving rigidly with one bone
  const pieces: THREE.BufferGeometry[] = [];
  const add = (boneName: string, g: THREE.BufferGeometry) => {
    const n = g.getAttribute("position").count;
    const idx = new Uint16Array(n * 4);
    const wts = new Float32Array(n * 4);
    const bi = list.indexOf(bones[boneName]!);
    for (let i = 0; i < n; i++) {
      idx[i * 4] = bi;
      wts[i * 4] = 1;
    }
    g.setAttribute("skinIndex", new THREE.BufferAttribute(idx, 4));
    g.setAttribute("skinWeight", new THREE.BufferAttribute(wts, 4));
    pieces.push(g);
  };
  add("pelvis", box(0.34, 0.16, 0.21, TROUSERS, 0, 0.93, 0)); // hips
  add("spine", box(0.37, 0.48, 0.21, SHIRT, 0, 1.22, 0)); // shirt
  add("spine", box(0.2, 0.05, 0.12, SHIRT, 0, 1.47, 0)); // collar
  add("head", box(0.08, 0.07, 0.09, SKIN, 0, 1.5, 0)); // neck
  add("head", box(0.19, 0.23, 0.21, SKIN, 0, 1.61, 0)); // head
  add("head", box(0.2, 0.06, 0.22, HAIR, 0, 1.73, 0.01)); // hair
  add("head", box(0.04, 0.03, 0.02, SKIN, 0, 1.6, -0.115)); // nose
  for (const [side, sx] of [
    ["L", -1],
    ["R", 1],
  ] as const) {
    const x = sx * 0.235;
    add(`upperArm${side}`, box(0.12, 0.17, 0.12, SHIRT, x, 1.345, 0)); // half sleeve
    add(`upperArm${side}`, box(0.085, 0.15, 0.085, SKIN, x, 1.19, 0)); // upper arm below the sleeve
    add(`forearm${side}`, box(0.08, 0.25, 0.08, SKIN, x, 0.995, 0)); // forearm
    add(`forearm${side}`, box(0.075, 0.1, 0.05, SKIN, x, 0.82, -0.005)); // hand
    add(`thigh${side}`, box(0.15, 0.47, 0.16, TROUSERS, sx * 0.1, 0.69, 0)); // thigh
    add(`shin${side}`, box(0.13, 0.43, 0.13, TROUSERS, sx * 0.1, 0.265, 0)); // shin
    add(`foot${side}`, box(0.09, 0.05, 0.2, SKIN, sx * 0.1, 0.045, -0.05)); // foot
    add(`foot${side}`, box(0.11, 0.02, 0.26, SOLE, sx * 0.1, 0.01, -0.05)); // chappal
  }
  const mesh = new THREE.SkinnedMesh(mergeGeometries(pieces, false)!, MODEL_MATERIAL);
  mesh.name = "player-body";
  mesh.castShadow = true;
  mesh.frustumCulled = false; // posed limbs move outside the standing bounds
  mesh.add(bones.pelvis!);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(list));
  root.add(mesh);

  const b = bones as Record<string, THREE.Bone> & {
    pelvis: THREE.Bone;
    spine: THREE.Bone;
    head: THREE.Bone;
  };
  const pelvisY = world.pelvis!.y;

  const reset = () => {
    for (const bn of list) bn.rotation.set(0, 0, 0);
    b.pelvis.position.set(0, pelvisY, 0);
  };

  return {
    root,
    bones,
    animate({ speed, phase, t, seated, airborne }) {
      reset();
      if (seated) {
        // sitting on the seat: thighs forward, shins down to the floorboard, leaning to the handlebar
        b.pelvis.position.y = 0.85;
        b.spine.rotation.x = -0.3;
        b.head.rotation.x = 0.25;
        for (const s of ["L", "R"]) {
          bones[`thigh${s}`]!.rotation.x = 1.5;
          bones[`shin${s}`]!.rotation.x = -1.35;
          bones[`foot${s}`]!.rotation.x = -0.15;
          bones[`upperArm${s}`]!.rotation.x = 1.3;
          bones[`forearm${s}`]!.rotation.x = 0.15;
        }
        return;
      }
      const w = clamp01(speed / 1.0); // how much of a gait (0 standing .. 1 moving)
      const run = clamp01((speed - 2.2) / 1.8); // walk -> run blend
      // thigh swing chosen so the stance foot stays planted: ground speed of the foot = 0 at mid-stance
      const A = Math.min(0.85, cycleLength(speed) / (2 * Math.PI * LEG)) * w;
      const legs: [string, number][] = [
        ["L", phase],
        ["R", phase + Math.PI],
      ];
      for (const [s, ph] of legs) {
        const thigh = A * Math.sin(ph);
        // the knee folds in early swing (foot lifts clear), stays nearly straight while carrying weight
        const knee = -(0.06 + 0.25 * run + (0.85 + 0.75 * run) * Math.max(0, Math.cos(ph + 0.5))) * w;
        bones[`thigh${s}`]!.rotation.x = thigh;
        bones[`shin${s}`]!.rotation.x = knee;
        bones[`foot${s}`]!.rotation.x = -(thigh + knee) * 0.85; // sole roughly level with the ground
      }
      // arms swing opposite the legs, elbows bend more when running
      const armSwing = (0.55 + 0.6 * run) * A;
      bones.upperArmL!.rotation.x = -armSwing * Math.sin(phase);
      bones.upperArmR!.rotation.x = armSwing * Math.sin(phase);
      bones.upperArmL!.rotation.z = -0.07;
      bones.upperArmR!.rotation.z = 0.07;
      const elbow = 0.18 + (0.2 + 1.1 * run) * w;
      bones.forearmL!.rotation.x = elbow;
      bones.forearmR!.rotation.x = elbow;
      // hips twist with the stride, shoulders twist back, head keeps looking ahead; lean in when running
      const twist = 0.1 * Math.sin(phase) * w;
      b.pelvis.rotation.y = twist;
      b.spine.rotation.y = -twist * 1.8;
      b.head.rotation.y = twist * 0.8;
      b.pelvis.rotation.z = 0.035 * Math.cos(phase) * w * (1 - run);
      b.spine.rotation.x = -(0.04 + 0.2 * run) * w + 0.012 * Math.sin(t * 1.7) * (1 - w);
      // up-and-down: walkers are highest over the standing leg, runners lowest (they spring off it)
      const bob = Math.cos(2 * phase) * (0.018 * (1 - run) - 0.035 * run) * w;
      b.pelvis.position.y = pelvisY - (0.015 + 0.04 * run) * w + bob;
      if (airborne) {
        for (const s of ["L", "R"]) {
          bones[`thigh${s}`]!.rotation.x += 0.35;
          bones[`shin${s}`]!.rotation.x -= 0.6;
          bones[`upperArm${s}`]!.rotation.x += 0.4;
        }
      }
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
