/** Keyboard + mouse on desktop; on-screen joystick + drag-to-look on touch screens. */

export interface Input {
  forward: number; // -1..1
  strafe: number; // -1..1 (right positive)
  run: boolean;
  jump?: boolean; // true once per press of Space / the Jump button
}

export interface Look {
  yaw: number; // radians, 0 = facing north, positive = turning right (clockwise)
  pitch: number; // radians, positive = looking up
}

export function makeControls(canvas: HTMLCanvasElement, look: Look) {
  const keys = new Set<string>();
  const stick = { x: 0, y: 0 };
  const isTouch = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  if (isTouch) document.body.classList.add("touch");

  let jumpPressed = false;
  addEventListener("keydown", (e) => {
    keys.add(e.code);
    if (e.code === "Space") {
      e.preventDefault(); // don't scroll the page
      if (!e.repeat) jumpPressed = true; // one jump per press, holding Space doesn't bounce
    }
  });
  const jumpBtn = document.getElementById("btnJump");
  jumpBtn?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    jumpPressed = true;
  });
  addEventListener("keyup", (e) => keys.delete(e.code));
  addEventListener("blur", () => keys.clear());

  // Desktop: click the view once to capture the mouse (pointer lock); then moving the mouse turns your head.
  // Esc releases the mouse. If pointer lock is unavailable, dragging still works as a fallback.
  const MOUSE_SENSITIVITY = 0.0022; // radians per pixel of mouse movement
  const turn = (dx: number, dy: number, s: number) => {
    look.yaw += dx * s;
    look.pitch = Math.max(-1.2, Math.min(1.2, look.pitch - dy * s));
  };
  const locked = () => document.pointerLockElement === canvas;
  if (!isTouch) {
    canvas.addEventListener("click", () => {
      if (locked() || !canvas.requestPointerLock) return;
      // request() returns a promise in modern browsers; ignore refusals (fallback = drag)
      const r = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      r?.catch?.(() => {});
    });
    document.addEventListener("pointerlockchange", () => document.body.classList.toggle("locked", locked()));
    document.addEventListener("mousemove", (e) => {
      if (locked()) turn(e.movementX, e.movementY, MOUSE_SENSITIVITY);
    });
  }

  // drag to look (a finger on phones; mouse fallback when the pointer isn't captured)
  let lookPointer: number | null = null;
  let last: [number, number] = [0, 0];
  canvas.addEventListener("pointerdown", (e) => {
    if (locked()) return;
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
    const jump = jumpPressed;
    jumpPressed = false;
    return {
      forward: Math.max(-1, Math.min(1, forward)),
      strafe: Math.max(-1, Math.min(1, strafe)),
      run: keys.has("ShiftLeft") || keys.has("ShiftRight") || Math.hypot(stick.x, stick.y) > 0.95,
      jump,
    };
  };
  return { read, isTouch, turn: (dx: number, dy: number) => turn(dx, dy, MOUSE_SENSITIVITY), locked };
}
