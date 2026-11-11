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

/**
 * A whole-body pose for actions (falling, getting up, lifting the scooter, getting on and off).
 * Angles in radians, relative to the parent bone; positive x swings a limb forwards. pelvisPitch tips the whole
 * body backwards (1.57 = lying on the back). Heights in metres above the character's origin (the ground).
 */
export interface Pose {
  pelvisY: number;
  pelvisPitch: number;
  spine: number;
  head: number;
  thighL: number;
  thighR: number;
  shinL: number;
  shinR: number;
  footL: number;
  footR: number;
  armL: number;
  armR: number;
  armOut: number; // arms away from the sides
  foreL: number;
  foreR: number;
}

const pose = (p: Partial<Pose>): Pose => ({
  pelvisY: 0.92,
  pelvisPitch: 0,
  spine: 0,
  head: 0,
  thighL: 0,
  thighR: 0,
  shinL: 0,
  shinR: 0,
  footL: 0,
  footR: 0,
  armL: 0,
  armR: 0,
  armOut: 0.07,
  foreL: 0.15,
  foreR: 0.15,
  ...p,
});

/** Key poses. Heights were checked so knees, hands and feet touch the ground instead of sinking into it. */
export const POSES = {
  stand: pose({}),
  seated: pose({
    pelvisY: 0.85,
    spine: -0.3,
    head: 0.25,
    thighL: 1.5,
    thighR: 1.5,
    shinL: -1.35,
    shinR: -1.35,
    footL: -0.15,
    footR: -0.15,
    armL: 1.3,
    armR: 1.3,
    foreL: 0.15,
    foreR: 0.15,
  }),
  // flying off backwards: arms thrown up, legs folding
  flail: pose({
    pelvisY: 0.9,
    pelvisPitch: 0.8,
    spine: 0.2,
    head: -0.35,
    thighL: 0.9,
    thighR: 0.6,
    shinL: -1.0,
    shinR: -0.7,
    armL: 2.4,
    armR: 2.1,
    armOut: 0.9,
    foreL: 0.5,
    foreR: 0.4,
  }),
  // on the back, one knee up, head lifted a little, arms out
  lie: pose({
    pelvisY: 0.13,
    pelvisPitch: 1.5,
    spine: 0.05,
    head: -0.25,
    thighL: 0.5,
    shinL: -1.1,
    footL: 0.4,
    thighR: 0.05,
    shinR: -0.1,
    armL: 0.05,
    armR: 0.05,
    armOut: 0.5,
    foreL: 0.3,
    foreR: 0.2,
  }),
  // sitting on the ground, legs forward, hands behind on the ground
  sitUp: pose({
    pelvisY: 0.13,
    pelvisPitch: 0.15,
    spine: -0.05,
    head: -0.1,
    thighL: 1.45,
    thighR: 1.45,
    shinL: -0.1,
    shinR: -0.1,
    footL: -0.3,
    footR: -0.3,
    armL: -0.6,
    armR: -0.6,
    armOut: 0.25,
    foreL: 0,
    foreR: 0,
  }),
  // drawing the knees up while sitting, feet sliding along the ground towards the hips
  kneesUp1: pose({
    pelvisY: 0.15,
    pelvisPitch: 0.05,
    spine: -0.2,
    thighL: 1.8,
    thighR: 1.8,
    shinL: -0.75,
    shinR: -0.75,
    armL: -0.3,
    armR: -0.3,
    armOut: 0.2,
  }),
  kneesUp2: pose({
    pelvisY: 0.18,
    spine: -0.35,
    thighL: 2.05,
    thighR: 2.05,
    shinL: -1.4,
    shinR: -1.4,
    armL: 0.2,
    armR: 0.2,
  }),
  // feet tucked in front of the hips, leaning forward
  tuck: pose({
    pelvisY: 0.2,
    spine: -0.6,
    head: 0.3,
    thighL: 2.1,
    thighR: 2.1,
    shinL: -2.5,
    shinR: -2.5,
    footL: 0.4,
    footR: 0.4,
    armL: 0.9,
    armR: 0.9,
  }),
  // rolling forward over the feet, hands to the ground
  rollForward: pose({
    pelvisY: 0.45,
    spine: -0.7,
    head: 0.4,
    thighL: 1.2,
    thighR: 1.2,
    shinL: -2.6,
    shinR: -2.6,
    footL: 0.9,
    footR: 0.9,
    armL: 0.9,
    armR: 0.9,
    foreL: 0.2,
    foreR: 0.2,
  }),
  // one knee down (right), left foot planted, hand on the left knee
  kneel: pose({
    pelvisY: 0.56,
    spine: -0.35,
    head: 0.2,
    thighL: 1.35,
    shinL: -1.4,
    footL: 0.05,
    thighR: -0.15,
    shinR: -1.45,
    footR: 0.6,
    armL: 0.9,
    foreL: 0.6,
    armR: -0.1,
    foreR: 0.3,
  }),
  // pushing up out of a crouch
  push: pose({
    pelvisY: 0.72,
    spine: -0.55,
    head: 0.35,
    thighL: 0.95,
    thighR: 0.95,
    shinL: -1.35,
    shinR: -1.35,
    footL: 0.4,
    footR: 0.4,
    armL: 0.6,
    armR: 0.6,
    foreL: 0.4,
    foreR: 0.4,
  }),
  // bending at hips and knees to grab a scooter lying on the ground
  bend: pose({
    pelvisY: 0.78,
    spine: -1.0,
    head: 0.6,
    thighL: 0.75,
    thighR: 0.75,
    shinL: -1.1,
    shinR: -1.1,
    footL: 0.35,
    footR: 0.35,
    armL: 1.0,
    armR: 1.0,
    armOut: 0.15,
    foreL: 0.1,
    foreR: 0.1,
  }),
  liftMid: pose({
    pelvisY: 0.86,
    spine: -0.5,
    head: 0.3,
    thighL: 0.4,
    thighR: 0.4,
    shinL: -0.6,
    shinR: -0.6,
    footL: 0.2,
    footR: 0.2,
    armL: 0.9,
    armR: 0.9,
    foreL: 0.5,
    foreR: 0.5,
  }),
  // standing beside the scooter, hands on the handlebar
  hold: pose({ armL: 0.7, armR: 0.7, foreL: 0.45, foreR: 0.45 }),
  // swinging the right leg over the seat
  mountMid: pose({
    pelvisY: 0.93,
    spine: -0.2,
    thighL: 0.1,
    thighR: 1.3,
    shinR: -1.3,
    armL: 1.2,
    armR: 1.2,
    foreL: 0.2,
    foreR: 0.2,
  }),
};

type Key = [number, Pose]; // [seconds, pose]
/** Timelines (seconds). The game moves the character's root (flight, walking to the scooter) alongside. */
export const CLIPS: Record<string, Key[]> = {
  thrown: [
    [0, POSES.seated],
    [0.3, POSES.flail],
    [0.6, POSES.lie],
  ],
  // lie -> sit up -> draw the knees in -> tuck -> roll forward -> one knee -> push up -> stand
  getUp: [
    [0, POSES.lie],
    [0.45, POSES.sitUp],
    [0.6, POSES.kneesUp1],
    [0.75, POSES.kneesUp2],
    [0.9, POSES.tuck],
    [1.15, POSES.rollForward],
    [1.45, POSES.kneel],
    [1.75, POSES.push],
    [2.15, POSES.stand],
  ],
  lift: [
    [0, POSES.stand],
    [0.45, POSES.bend],
    [0.6, POSES.bend],
    [0.95, POSES.liftMid],
    [1.3, POSES.hold],
  ],
  mount: [
    [0, POSES.hold],
    [0.25, POSES.mountMid],
    [0.5, POSES.seated],
  ],
  dismount: [
    [0, POSES.seated],
    [0.25, POSES.mountMid],
    [0.5, POSES.stand],
  ],
};
export const clipLength = (name: string) => CLIPS[name]!.at(-1)![0];

const ease = (x: number) => x * x * (3 - 2 * x);
/** The pose of a clip at time t: neighbouring key poses blended smoothly (no snapping). */
export function clipPose(name: string, t: number): Pose {
  const keys = CLIPS[name]!;
  if (t <= keys[0]![0]) return keys[0]![1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, p1] = keys[i]!;
    const [t0, p0] = keys[i - 1]!;
    if (t <= t1) {
      const k = ease((t - t0) / (t1 - t0 || 1));
      const out = { ...p0 };
      for (const f of Object.keys(p0) as (keyof Pose)[]) out[f] = p0[f] + (p1[f] - p0[f]) * k;
      return out;
    }
  }
  return keys.at(-1)![1];
}

export interface Character {
  root: THREE.Group;
  animate(g: GaitPose): void;
  /** Show an action pose instead of walking (t = running time, for breathing). */
  applyPose(p: Pose, t: number): void;
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
    applyPose(p, t) {
      reset();
      const breathe = 0.015 * Math.sin(t * 2.2); // a little chest movement so held poses aren't frozen
      b.pelvis.position.y = p.pelvisY;
      b.pelvis.rotation.x = p.pelvisPitch;
      b.spine.rotation.x = p.spine + breathe;
      b.head.rotation.x = p.head;
      bones.thighL!.rotation.x = p.thighL;
      bones.thighR!.rotation.x = p.thighR;
      bones.shinL!.rotation.x = p.shinL;
      bones.shinR!.rotation.x = p.shinR;
      bones.footL!.rotation.x = p.footL;
      bones.footR!.rotation.x = p.footR;
      bones.upperArmL!.rotation.x = p.armL;
      bones.upperArmR!.rotation.x = p.armR;
      bones.upperArmL!.rotation.z = -p.armOut;
      bones.upperArmR!.rotation.z = p.armOut;
      bones.forearmL!.rotation.x = p.foreL;
      bones.forearmR!.rotation.x = p.foreR;
    },
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
