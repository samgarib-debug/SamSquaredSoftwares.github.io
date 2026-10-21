// The 3D can used on websites.html. Built from simple shapes and a label
// drawn in code, so there are no model or image files to download.
import {
  CanvasTexture,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  LatheGeometry,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { drawLabel } from './label.js';

const TAU = Math.PI * 2;
const CAN_CENTER = 1.74; // the can is 3.48 tall; the scene orbits its middle

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

// Half-profile of a 330 ml can, bottom center to lid center, spun around Y.
function canProfile() {
  const pts = [
    [0.0, 0.17], [0.35, 0.155], [0.6, 0.11], [0.74, 0.05], [0.79, 0.012],
    [0.82, 0.0], [0.88, 0.015], [0.94, 0.06], [0.98, 0.16], [1.0, 0.3],
    [1.0, 3.02], [0.985, 3.12], [0.95, 3.24], [0.9, 3.33], [0.865, 3.39],
    [0.87, 3.43], [0.862, 3.465], [0.84, 3.478], [0.825, 3.452],
    [0.815, 3.4], [0.79, 3.386], [0.0, 3.386],
  ];
  return pts.map(([r, y]) => new Vector2(r, y));
}

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.18)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new CanvasTexture(c);
}

export function supportsWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (err) {
    return false;
  }
}

/**
 * Mounts a spinning, draggable can inside `host`.
 * @param {HTMLElement} host positioned element; the canvas fills it
 * @param {object} o options:
 *   flavors (array), index (start flavor), label (aria label),
 *   motion (false = still, renders on demand), autoRotate, bubbles,
 *   scrollLinked (spin and lift as the host scrolls away), shadow (opacity),
 *   hotspots: [{ el, pos: [x,y,z], normal: [x,y,z] }] in can coordinates,
 *   onReady(), onTurn(angle)
 */
export function mountCan(host, o) {
  const opts = Object.assign(
    { index: 0, motion: true, autoRotate: true, bubbles: true, scrollLinked: false, shadow: 0.45, hotspots: [], label: '3D can' },
    o
  );
  const flavors = opts.flavors;
  const small = Math.min(window.innerWidth, window.innerHeight) < 640;

  const canvas = document.createElement('canvas');
  canvas.className = 'w3-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', opts.label);
  canvas.tabIndex = 0;
  host.appendChild(canvas);

  // failIfMajorPerformanceCaveat: no software WebGL; the page keeps its stills.
  const renderer = new WebGLRenderer({
    canvas, antialias: true, alpha: true, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true,
  });
  // Phones: 1.5x is sharp at can size and draws about a quarter fewer pixels than 1.75x.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envTarget.texture;
  pmrem.dispose();

  const camera = new PerspectiveCamera(26, 1, 0.1, 80);

  const key = new DirectionalLight(0xffffff, 1.5);
  key.position.set(4, 7, 6);
  const rim = new DirectionalLight(new Color(flavors[opts.index].rim), 3.2);
  rim.position.set(-5, 3, -4);
  const fill = new DirectionalLight(0xffffff, 0.35);
  fill.position.set(-3, -2, 5);
  scene.add(key, rim, fill);

  // ---------- the can ----------
  const holder = new Group(); // float, tilt, scroll lift
  const can = new Group(); // spin
  const shape = new Group(); // geometry in can coordinates (bottom at y = 0)
  shape.position.y = -CAN_CENTER;
  can.add(shape);
  holder.add(can);
  scene.add(holder);

  const metal = new MeshStandardMaterial({ color: 0xcfd5dd, metalness: 1, roughness: 0.24 });
  const bodyGeo = new LatheGeometry(canProfile(), small ? 64 : 96);
  shape.add(new Mesh(bodyGeo, metal));

  const LabelMaterial = small ? MeshStandardMaterial : MeshPhysicalMaterial;
  const labelMat = new LabelMaterial(
    small
      ? { metalness: 0.2, roughness: 0.32 }
      : { metalness: 0.2, roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.12 }
  );
  const labelGeo = new CylinderGeometry(1.006, 1.006, 2.62, small ? 96 : 128, 1, true);
  const label = new Mesh(labelGeo, labelMat);
  label.position.y = 0.37 + 1.31;
  label.rotation.y = Math.PI; // texture center (u = 0.5) faces the camera
  shape.add(label);

  // ring pull: tab, rivet and the score line of the opening
  const ringGeo = new TorusGeometry(0.16, 0.034, 10, 36);
  ringGeo.scale(1, 1.35, 1);
  const ring = new Mesh(ringGeo, metal);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(0, 3.405, -0.2);
  const plateGeo = new CylinderGeometry(0.15, 0.15, 0.03, 24);
  const plate = new Mesh(plateGeo, metal);
  plate.scale.set(1, 1, 1.6);
  plate.position.set(0, 3.395, 0.06);
  const scoreGeo = new TorusGeometry(0.2, 0.012, 6, 32);
  scoreGeo.scale(1.25, 1, 1);
  const score = new Mesh(scoreGeo, metal);
  score.rotation.x = -Math.PI / 2;
  score.position.set(0, 3.388, 0.42);
  shape.add(ring, plate, score);

  // soft contact shadow
  const shadowTex = shadowTexture();
  const shadowMat = new MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false, opacity: opts.shadow });
  const shadowGeo = new PlaneGeometry(3.6, 3.6);
  const shadow = new Mesh(shadowGeo, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -CAN_CENTER - 0.25;
  scene.add(shadow);

  // bubbles
  const bubbleCount = opts.bubbles ? (small ? 16 : 30) : 0;
  const bubbleGeo = new SphereGeometry(1, 14, 10);
  const bubbleMat = new MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.3, envMapIntensity: 1.8 });
  const bubbles = new InstancedMesh(bubbleGeo, bubbleMat, Math.max(bubbleCount, 1));
  bubbles.count = bubbleCount;
  bubbles.instanceMatrix.setUsage(DynamicDrawUsage);
  bubbles.frustumCulled = false;
  const seeds = [];
  for (let i = 0; i < bubbleCount; i++) {
    seeds.push({
      a: Math.random() * TAU,
      r: 1.35 + Math.random() * 1.25,
      y: -2.5 + Math.random() * 5,
      s: 0.03 + Math.random() * 0.085,
      v: 0.22 + Math.random() * 0.4,
      w: Math.random() * TAU,
    });
  }
  scene.add(bubbles);
  const dummy = new Object3D();

  function placeBubbles(t, dt) {
    for (let i = 0; i < bubbleCount; i++) {
      const b = seeds[i];
      b.y += b.v * dt;
      if (b.y > 2.6) b.y = -2.6;
      const a = b.a + Math.sin(t * 0.6 + b.w) * 0.25;
      dummy.position.set(Math.cos(a) * b.r, b.y, Math.sin(a) * b.r * 0.55 - 0.3);
      dummy.scale.setScalar(b.s * (b.y > 2.2 ? (2.6 - b.y) / 0.4 : 1));
      dummy.updateMatrix();
      bubbles.setMatrixAt(i, dummy.matrix);
    }
    bubbles.instanceMatrix.needsUpdate = true;
  }
  placeBubbles(0, 0);

  // ---------- labels ----------
  const textures = [];
  // Phones show the label at most about 500 device pixels across, so 1024 is
  // enough and cuts drawing time and GPU memory by more than half.
  const texWidth = small ? 1024 : 2048;
  function textureFor(i) {
    if (!textures[i]) {
      const t = new CanvasTexture(drawLabel(flavors[i], texWidth));
      t.colorSpace = SRGBColorSpace;
      t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      textures[i] = t;
    }
    return textures[i];
  }
  let current = opts.index;
  function applyFlavor(i) {
    labelMat.map = textureFor(i);
    labelMat.needsUpdate = true;
    rim.color.set(flavors[i].rim);
    current = i;
  }
  applyFlavor(current);

  // ---------- size ----------
  let width = 0;
  let height = 0;
  function resize() {
    width = host.clientWidth;
    height = host.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const t = Math.tan(MathUtils.degToRad(camera.fov / 2));
    const dist = Math.max(2.55 / t, 1.75 / (t * camera.aspect));
    camera.position.set(0, dist * 0.2, dist);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    wake();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  // ---------- interaction ----------
  const s = {
    rot: opts.startRot != null ? opts.startRot : -0.45,
    vel: 0,
    tilt: 0,
    tiltDrag: 0,
    yawHover: 0,
    hoverX: 0,
    hoverY: 0,
    dragging: false,
    px: 0,
    py: 0,
    held: false,
  };
  let spin = null;
  let pop = 0;

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    s.dragging = true;
    s.px = e.clientX;
    s.py = e.clientY;
    s.vel = 0;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    host.classList.add('is-dragging');
    host.dispatchEvent(new CustomEvent('w3:drag'));
    wake();
  }
  function onMove(e) {
    if (s.dragging) {
      const dx = e.clientX - s.px;
      const dy = e.clientY - s.py;
      s.px = e.clientX;
      s.py = e.clientY;
      s.rot += dx * 0.012;
      s.vel = s.vel * 0.5 + dx * 0.012 * 30;
      s.tiltDrag = clamp(s.tiltDrag + dy * 0.004, -0.45, 0.45);
    } else if (e.pointerType === 'mouse') {
      const r = canvas.getBoundingClientRect();
      s.hoverX = clamp(((e.clientX - r.left) / r.width - 0.5) * 2, -1, 1);
      s.hoverY = clamp(((e.clientY - r.top) / r.height - 0.5) * 2, -1, 1);
    }
    wake();
  }
  function onUp(e) {
    if (!s.dragging) return;
    s.dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    host.classList.remove('is-dragging');
    wake();
  }
  function onLeave() {
    s.hoverX = 0;
    s.hoverY = 0;
    wake();
  }
  function onKey(e) {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (step) {
      s.vel += step * 2.6;
      e.preventDefault();
      wake();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      s.tiltDrag = clamp(s.tiltDrag + (e.key === 'ArrowUp' ? -0.12 : 0.12), -0.45, 0.45);
      e.preventDefault();
      wake();
    }
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('keydown', onKey);

  // ---------- loop ----------
  let raf = 0;
  let idleTimer = 0;
  let last = 0;
  let lastDraw = 0;
  let visible = false;
  let running = false;
  let settle = 0;
  let readyFired = false;
  const v = new Vector3();
  const n = new Vector3();
  const toCam = new Vector3();

  // Idle frames (only the float and bubbles moving) wait on a timer, so the
  // page wakes about 30 times a second instead of on every display refresh.
  function stopIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = 0;
  }

  function scheduleIdle(ms) {
    stopIdle();
    idleTimer = setTimeout(function () {
      idleTimer = 0;
      if (running && !raf) raf = requestAnimationFrame(frame);
    }, Math.max(0, ms));
  }

  function wake() {
    settle = 45;
    stopIdle();
    if (running && !raf) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  function frame(now) {
    raf = 0;
    // When nobody is touching the can, only the gentle float and bubbles
    // move, and 30 frames a second looks the same at half the work.
    const active = s.dragging || spin || s.vel !== 0 || settle > 0;
    if (!active && readyFired && now - lastDraw < 32) {
      if (running) scheduleIdle(32 - (now - lastDraw));
      return;
    }
    lastDraw = now;
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
    last = now;
    const t = now / 1000;
    const motion = opts.motion;

    // spin and drift
    if (!s.dragging) {
      s.rot += s.vel * dt;
      s.vel *= Math.exp(-3.2 * dt);
      if (Math.abs(s.vel) < 0.002) s.vel = 0;
      if (motion && opts.autoRotate && !s.held && Math.abs(s.vel) < 0.4) s.rot += 0.32 * dt;
      s.tiltDrag *= Math.exp(-1.6 * dt);
    }
    const tiltGoal = s.tiltDrag + (s.dragging ? 0 : s.hoverY * 0.12);
    s.tilt += (tiltGoal - s.tilt) * (1 - Math.exp(-7 * dt));
    s.yawHover += ((s.dragging ? 0 : s.hoverX * 0.3) - s.yawHover) * (1 - Math.exp(-5 * dt));

    let spinOffset = 0;
    if (spin) {
      const p = clamp((now - spin.start) / spin.dur, 0, 1);
      spinOffset = easeInOut(p) * TAU;
      pop = Math.sin(p * Math.PI) * 0.07;
      if (!spin.swapped && p >= 0.5) {
        applyFlavor(spin.next);
        spin.swapped = true;
      }
      if (p >= 1) {
        spin = null;
        spinOffset = 0;
        pop = 0;
      }
    }

    let scrollTurn = 0;
    let lift = 0;
    if (opts.scrollLinked && motion) {
      const r = host.getBoundingClientRect();
      const p = clamp(-r.top / Math.max(r.height, 1), 0, 1);
      scrollTurn = p * Math.PI * 1.1;
      lift = p * 0.8;
    }

    holder.position.y = (motion ? Math.sin(t * 1.15) * 0.08 : 0) + lift;
    holder.rotation.z = motion ? Math.sin(t * 0.8) * 0.035 : 0;
    holder.rotation.x = s.tilt;
    can.rotation.y = s.rot + spinOffset + s.yawHover + scrollTurn;
    can.scale.setScalar(1 + pop);
    shadow.material.opacity = opts.shadow * (1 - (holder.position.y - lift) * 1.5);

    if (bubbleCount && motion) placeBubbles(t, dt);

    renderer.render(scene, camera);

    if (opts.hotspots.length) {
      shape.updateMatrixWorld(true);
      for (const h of opts.hotspots) {
        v.fromArray(h.pos).applyMatrix4(shape.matrixWorld);
        n.fromArray(h.normal).transformDirection(shape.matrixWorld);
        toCam.copy(camera.position).sub(v).normalize();
        const facing = n.dot(toCam);
        v.project(camera);
        const x = (v.x * 0.5 + 0.5) * width;
        const y = (-v.y * 0.5 + 0.5) * height;
        h.el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
        h.el.classList.toggle('is-away', facing < 0.25);
      }
    }

    if (!readyFired) {
      readyFired = true;
      host.classList.add('is-live');
      if (opts.onReady) opts.onReady();
      // make the other labels now, so switching never stutters
      const idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 200); };
      idle(function () {
        flavors.forEach(function (f, i) { renderer.initTexture(textureFor(i)); });
      });
    }

    if (settle > 0) settle -= 1;
    const busy = motion || s.dragging || spin || s.vel !== 0 || settle > 0 ||
      Math.abs(s.tilt - tiltGoal) > 0.001 || Math.abs(s.yawHover) > 0.001;
    if (running && busy) {
      const stillActive = s.dragging || spin || s.vel !== 0 || settle > 0;
      if (stillActive) raf = requestAnimationFrame(frame);
      else scheduleIdle(32);
    }
  }

  function update() {
    const should = visible && !document.hidden;
    if (should === running) return;
    running = should;
    if (running) wake();
    else {
      stopIdle();
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    }
  }
  const io = new IntersectionObserver(function (entries) {
    visible = entries[entries.length - 1].isIntersecting;
    update();
  }, { rootMargin: '120px' });
  io.observe(host);
  document.addEventListener('visibilitychange', update);

  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    host.classList.remove('is-live');
    running = false;
    stopIdle();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  });

  resize();

  return {
    canvas,
    get index() { return current; },
    setFlavor(i, animate) {
      const target = ((i % flavors.length) + flavors.length) % flavors.length;
      if (spin) spin.next = target;
      else if (target === current) return;
      else if (animate === false || !opts.motion) applyFlavor(target);
      else spin = { start: performance.now(), dur: 900, swapped: false, next: target };
      wake();
    },
    hold(on) {
      s.held = !!on;
      wake();
    },
    destroy() {
      stopIdle();
      if (raf) cancelAnimationFrame(raf);
      running = false;
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', update);
      [bodyGeo, labelGeo, ringGeo, plateGeo, scoreGeo, shadowGeo, bubbleGeo].forEach((g) => g.dispose());
      [metal, labelMat, shadowMat, bubbleMat].forEach((m) => m.dispose());
      textures.forEach((t) => t && t.dispose());
      shadowTex.dispose();
      envTarget.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
