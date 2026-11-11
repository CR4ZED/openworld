/** Keyboard + mouse on desktop; on-screen joystick + drag-to-look on touch screens. */

export interface Input {
  forward: number; // -1..1
  strafe: number; // -1..1 (right positive)
  run: boolean;
  jump?: boolean; // true once per press of Space / the Jump button
  use?: boolean; // true once per press of E / the Ride button: get on or off the scooter
  horn?: boolean; // true once per press of H / the Horn button
  view?: boolean; // true once per press of V: switch third person / first person
  walk?: boolean; // true once per press of C: switch walking / jogging
}

export interface Look {
  yaw: number; // radians, 0 = facing north, positive = turning right (clockwise)
  pitch: number; // radians, positive = looking up
}

export interface ControlHooks {
  /** The player pressed Esc (or the browser released the mouse): open the pause menu. */
  onEscape(): void;
  /** True while a menu or title screen is open: no capturing the mouse, no looking around. */
  paused(): boolean;
}

export function makeControls(canvas: HTMLCanvasElement, look: Look, hooks: ControlHooks) {
  const keys = new Set<string>();
  const stick = { x: 0, y: 0 };
  const isTouch = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  if (isTouch) document.body.classList.add("touch");

  // one-shot actions: set on press, cleared when read (holding a key doesn't repeat the action)
  const pressed = { jump: false, use: false, horn: false, view: false, walk: false };
  const KEY_ACTIONS: Record<string, keyof typeof pressed> = {
    Space: "jump",
    KeyE: "use",
    KeyH: "horn",
    KeyV: "view",
    KeyC: "walk",
  };
  addEventListener("keydown", (e) => {
    if (e.code === "Escape") {
      // with the mouse captured, the browser itself releases it on Esc (handled in pointerlockchange)
      if (!locked()) hooks.onEscape();
      return;
    }
    if (hooks.paused()) return;
    // during play Space/Enter never "press" whatever page button last had focus (e.g. ☰ Menu)
    if (e.code === "Space" || e.code === "Enter") e.preventDefault();
    // the first key press captures the mouse, so looking around never needs a click (owner 2026-11-11)
    if (!isTouch && !locked()) lock();
    keys.add(e.code);
    const action = KEY_ACTIONS[e.code];
    if (!action) return;
    if (e.code === "Space") e.preventDefault(); // don't scroll the page
    if (!e.repeat) pressed[action] = true;
  });
  const BUTTON_ACTIONS: [string, keyof typeof pressed][] = [
    ["btnJump", "jump"],
    ["btnRide", "use"],
    ["btnHorn", "horn"],
  ];
  for (const [id, action] of BUTTON_ACTIONS) {
    document.getElementById(id)?.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      pressed[action] = true;
    });
  }
  addEventListener("keyup", (e) => keys.delete(e.code));
  addEventListener("blur", () => keys.clear());

  // Desktop (owner 2026-11-11: "having to click and then move around is a turn off"): moving the mouse over the
  // view turns your head straight away. Browsers only let a page capture the mouse (pointer lock: no cursor, no
  // screen edge) after a click or key press, so the first key press or click captures it. Esc frees the mouse and
  // opens the pause menu.
  const MOUSE_SENSITIVITY = 0.0022; // radians per pixel of mouse movement
  const turn = (dx: number, dy: number, s: number) => {
    look.yaw += dx * s;
    look.pitch = Math.max(-1.2, Math.min(1.2, look.pitch - dy * s));
  };
  const locked = () => document.pointerLockElement === canvas;
  let wasLocked = false;
  let autoLock = true; // tests turn this off: headless test browsers misbehave while the mouse is captured
  let releasing = false; // we let go of the mouse ourselves (no pause menu for that)
  const lock = () => {
    if (isTouch || locked() || hooks.paused() || !autoLock || !canvas.requestPointerLock) return;
    try {
      // returns a promise in modern browsers; a refusal (e.g. right after Esc) just leaves hover-look working
      const r = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      r?.catch?.(() => {});
    } catch {
      // not allowed right now
    }
  };
  const unlock = () => {
    if (!locked()) return;
    releasing = true;
    document.exitPointerLock();
  };
  if (!isTouch) {
    canvas.addEventListener("click", lock);
    document.addEventListener("pointerlockchange", () => {
      const now = locked();
      document.body.classList.toggle("locked", now);
      // Esc while captured: the browser frees the mouse; that means "pause"
      if (wasLocked && !now && !releasing) hooks.onEscape();
      if (!now) releasing = false;
      wasLocked = now;
    });
    document.addEventListener("mousemove", (e) => {
      if (hooks.paused()) return;
      if (locked()) turn(e.movementX, e.movementY, MOUSE_SENSITIVITY);
      // not captured yet: the mouse moving over the view still turns it
      else if (e.target === canvas && e.buttons === 0) turn(e.movementX, e.movementY, MOUSE_SENSITIVITY);
    });
  }

  // drag to look (a finger on phones; mouse fallback when the pointer isn't captured)
  let lookPointer: number | null = null;
  let last: [number, number] = [0, 0];
  canvas.addEventListener("pointerdown", (e) => {
    if (locked() || e.pointerType === "mouse") return; // mice look by moving (above); fingers drag
    lookPointer = e.pointerId;
    last = [e.clientX, e.clientY];
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerId !== lookPointer) return;
    if (locked()) return;
    turn(e.clientX - last[0], e.clientY - last[1], isTouch ? 0.006 : 0.004);
    last = [e.clientX, e.clientY];
  });
  const endLook = (e: PointerEvent) => {
    if (e.pointerId === lookPointer) lookPointer = null;
  };
  canvas.addEventListener("pointerup", endLook);
  canvas.addEventListener("pointercancel", endLook);

  // joystick
  const pad = document.getElementById("joystick")!;
  const knob = document.getElementById("stick")!;
  let padPointer: number | null = null;
  const setStick = (e: PointerEvent) => {
    const r = pad.getBoundingClientRect();
    let x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const m = Math.hypot(x, y);
    if (m > 1) {
      x /= m;
      y /= m;
    }
    stick.x = x;
    stick.y = y;
    knob.style.transform = `translate(${x * 35}px, ${y * 35}px)`;
  };
  pad.addEventListener("pointerdown", (e) => {
    padPointer = e.pointerId;
    pad.setPointerCapture(e.pointerId);
    setStick(e);
  });
  pad.addEventListener("pointermove", (e) => e.pointerId === padPointer && setStick(e));
  const endPad = (e: PointerEvent) => {
    if (e.pointerId !== padPointer) return;
    padPointer = null;
    stick.x = stick.y = 0;
    knob.style.transform = "";
  };
  pad.addEventListener("pointerup", endPad);
  pad.addEventListener("pointercancel", endPad);

  const read = (): Input => {
    const k = (c: string) => (keys.has(c) ? 1 : 0);
    const forward = k("KeyW") + k("ArrowUp") - k("KeyS") - k("ArrowDown") - stick.y;
    const strafe = k("KeyD") + k("ArrowRight") - k("KeyA") - k("ArrowLeft") + stick.x;
    const once = { ...pressed };
    pressed.jump = pressed.use = pressed.horn = pressed.view = pressed.walk = false;
    return {
      forward: Math.max(-1, Math.min(1, forward)),
      strafe: Math.max(-1, Math.min(1, strafe)),
      // Shift sprints; on phones the joystick walks when pushed lightly and jogs when pushed fully
      run: keys.has("ShiftLeft") || keys.has("ShiftRight"),
      ...once,
    };
  };
  return {
    read,
    isTouch,
    turn: (dx: number, dy: number) => turn(dx, dy, MOUSE_SENSITIVITY),
    locked,
    lock,
    unlock,
    setAutoLock: (on: boolean) => {
      autoLock = on;
    },
    /** Forget held keys (e.g. when the menu opens, so you don't keep walking afterwards). */
    clear: () => keys.clear(),
  };
}
