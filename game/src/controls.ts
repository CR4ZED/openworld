/** Keyboard + mouse on desktop; on-screen joystick + drag-to-look on touch screens. */

export interface Input {
  forward: number; // -1..1
  strafe: number; // -1..1 (right positive)
  run: boolean;
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

  addEventListener("keydown", (e) => keys.add(e.code));
  addEventListener("keyup", (e) => keys.delete(e.code));
  addEventListener("blur", () => keys.clear());

  // drag to look (mouse or a finger on the canvas)
  let lookPointer: number | null = null;
  let last: [number, number] = [0, 0];
  canvas.addEventListener("pointerdown", (e) => {
    lookPointer = e.pointerId;
    last = [e.clientX, e.clientY];
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerId !== lookPointer) return;
    const s = isTouch ? 0.006 : 0.004;
    look.yaw += (e.clientX - last[0]) * s;
    look.pitch = Math.max(-1.2, Math.min(1.2, look.pitch - (e.clientY - last[1]) * s));
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
    return {
      forward: Math.max(-1, Math.min(1, forward)),
      strafe: Math.max(-1, Math.min(1, strafe)),
      run: keys.has("ShiftLeft") || keys.has("ShiftRight") || Math.hypot(stick.x, stick.y) > 0.95,
    };
  };
  return { read, isTouch };
}
