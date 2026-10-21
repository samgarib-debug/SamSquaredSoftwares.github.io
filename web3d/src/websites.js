// websites.html: scroll reveals, tilting package cards, the Fizzbok demo shop,
// and the 3D cans. The page first shows still images of the cans (renders of
// the same scene). The 3D code (three.js) loads only after the visitor first
// interacts, or a few seconds after the page has loaded, when a 3D area is
// close to the screen, on devices with hardware WebGL that are not saving data.
// Without it, the stills stay, so the page always works.
import { FLAVORS, PACKS } from './flavors.js';

const root = document.documentElement;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const saveData = !!(navigator.connection && navigator.connection.saveData);
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
const rand = (n) => 'R' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

root.classList.add('w3-js');

// ---------- scroll reveals ----------
// Anything that has scrolled into view, or that is already above it (after a
// jump link, say), is shown. So nothing stays hidden behind a fast jump.
let pending = $$('.w3-reveal');
if (reduceMotion) {
  pending.forEach((el) => el.classList.add('is-in'));
  pending = [];
}
let sweepQueued = false;
function sweep() {
  sweepQueued = false;
  const line = window.innerHeight * 0.92;
  pending = pending.filter((el) => {
    if (el.getBoundingClientRect().top < line) {
      el.classList.add('is-in');
      return false;
    }
    return true;
  });
  if (!pending.length) {
    window.removeEventListener('scroll', queueSweep);
    window.removeEventListener('resize', queueSweep);
  }
}
function queueSweep() {
  if (!sweepQueued) {
    sweepQueued = true;
    requestAnimationFrame(sweep);
  }
}
if (pending.length) {
  window.addEventListener('scroll', queueSweep, { passive: true });
  window.addEventListener('resize', queueSweep);
  sweep();
}

// ---------- tilting cards ----------
if (finePointer && !reduceMotion) {
  $$('[data-tilt]').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      card.style.setProperty('--ry', (x * 9).toFixed(2) + 'deg');
      card.style.setProperty('--rx', (-y * 7).toFixed(2) + 'deg');
      card.style.setProperty('--gx', ((x + 0.5) * 100).toFixed(1) + '%');
      card.style.setProperty('--gy', ((y + 0.5) * 100).toFixed(1) + '%');
      card.classList.add('is-tilting');
    });
    card.addEventListener('pointerleave', () => {
      card.style.removeProperty('--ry');
      card.style.removeProperty('--rx');
      card.classList.remove('is-tilting');
    });
  });
}

// ---------- toast ----------
const toast = $('#w3-toast');
let toastTimer = 0;
function say(text) {
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-on'), 3200);
}

// ---------- colors ----------
function paint(el, f) {
  if (!el) return;
  el.style.setProperty('--fz-top', f.top);
  el.style.setProperty('--fz-bottom', f.bottom);
  el.style.setProperty('--fz-glow', f.glow);
  el.style.setProperty('--fz-tint', f.tint);
  el.style.setProperty('--fz-tint-deep', f.tintDeep);
  el.dataset.flavor = f.id;
}

// ---------- hero ----------
const heroStage = $('[data-stage="hero"]');
const heroPoster = heroStage && $('.w3-poster', heroStage);
let heroIndex = 0;
let heroCan = null;
let heroTimer = 0;
let heroTouched = 0;

function setHero(i, animate) {
  heroIndex = (i + FLAVORS.length) % FLAVORS.length;
  const f = FLAVORS[heroIndex];
  paint(heroStage, f);
  $$('[data-hero-pick]').forEach((b) => {
    b.setAttribute('aria-pressed', Number(b.dataset.heroPick) === heroIndex ? 'true' : 'false');
  });
  if (heroCan) heroCan.setFlavor(heroIndex, animate);
  else if (heroPoster) heroPoster.src = posterSrc(f);
}
function startHeroCycle() {
  if (reduceMotion || heroTimer) return;
  heroTimer = setInterval(() => {
    if (Date.now() - heroTouched < 8000 || document.hidden) return;
    setHero(heroIndex + 1, true);
  }, 6500);
}

// ---------- demo shop ----------
const shop = $('#w3-shop');
const viewer = shop && $('[data-stage="demo"]', shop);
const viewerPoster = viewer && $('.w3-poster', viewer);
const state = { flavor: 0, pack: 1, qty: 1, cart: 0 };
let demoCan = null;

function posterSrc(f) {
  return '/assets/web3d/can-' + f.id + '.webp';
}

function renderShop() {
  if (!shop) return;
  const f = FLAVORS[state.flavor];
  paint(shop, f);
  $('#w3-name').textContent = f.name;
  $('#w3-notes').replaceChildren(...f.notes.map((n) => {
    const li = document.createElement('li');
    li.textContent = n;
    return li;
  }));
  $$('[data-pick]', shop).forEach((b) => {
    const on = Number(b.dataset.pick) === state.flavor;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.classList.toggle('is-on', on);
  });
  $('#w3-qty').textContent = String(state.qty);
  $('#w3-total').textContent = rand(PACKS[state.pack] * state.qty);
  $('#w3-count').textContent = String(state.cart);
  if (!demoCan && viewerPoster) viewerPoster.src = posterSrc(f);
}

function pick(i, from) {
  if (i === state.flavor) return;
  state.flavor = i;
  closeSpots();
  renderShop();
  if (demoCan) demoCan.setFlavor(i, true);
  if (from === 'range' && viewer && window.innerWidth < 900) {
    viewer.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  }
}

if (shop) {
  $$('[data-pick]', shop).forEach((b) => {
    b.addEventListener('click', () => pick(Number(b.dataset.pick), b.closest('.w3-range') ? 'range' : 'swatch'));
  });
  $$('input[name="pack"]', shop).forEach((r) => {
    r.addEventListener('change', () => {
      state.pack = Number(r.value);
      renderShop();
    });
  });
  $('#w3-less').addEventListener('click', () => {
    state.qty = Math.max(1, state.qty - 1);
    renderShop();
  });
  $('#w3-more').addEventListener('click', () => {
    state.qty = Math.min(24, state.qty + 1);
    renderShop();
  });
  $('#w3-add').addEventListener('click', () => {
    state.cart += state.qty;
    renderShop();
    const cart = $('#w3-cart');
    cart.classList.remove('is-bump');
    void cart.offsetWidth; // restart the bump animation
    cart.classList.add('is-bump');
    const f = FLAVORS[state.flavor];
    const what = state.pack === 1 ? 'can' + (state.qty > 1 ? 's' : '') : (state.pack + '-pack' + (state.qty > 1 ? 's' : ''));
    say('Added ' + state.qty + ' ' + f.name + ' ' + what + ' to the demo cart.');
  });
  $('#w3-wa').addEventListener('click', () => {
    say('Demo only. On your site, this opens WhatsApp with the order already typed out.');
  });
  renderShop();
}

// ---------- hotspots ----------
const spots = viewer ? $$('.w3-spot', viewer) : [];
function closeSpots(except) {
  spots.forEach((wrap) => {
    if (wrap === except) return;
    const btn = $('button', wrap);
    btn.setAttribute('aria-expanded', 'false');
    $('.w3-spot-card', wrap).hidden = true;
    wrap.classList.remove('is-open');
  });
  if (demoCan) demoCan.hold(!!except);
}
spots.forEach((wrap) => {
  const btn = $('button', wrap);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = btn.getAttribute('aria-expanded') !== 'true';
    closeSpots(open ? wrap : null);
    if (open) {
      // open the card toward the middle of the viewer, so it never runs off the edge
      const r = wrap.getBoundingClientRect();
      const vr = viewer.getBoundingClientRect();
      wrap.classList.toggle('is-flip', r.left - vr.left > vr.width / 2);
    }
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    $('.w3-spot-card', wrap).hidden = !open;
    wrap.classList.toggle('is-open', open);
    if (demoCan) demoCan.hold(open);
  });
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.w3-spot')) closeSpots();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSpots();
});

// ---------- 3D ----------
const stages = [heroStage, viewer].filter(Boolean);

function hotspotsFor(el) {
  return $$('.w3-spot', el).map((wrap) => ({
    el: wrap,
    pos: wrap.dataset.pos.split(',').map(Number),
    normal: wrap.dataset.normal.split(',').map(Number),
  }));
}

let scene3d = null; // promise of the 3D module, loaded once

// True when the browser can draw WebGL on a real GPU. Software WebGL (no GPU,
// blocked drivers, test machines) runs the scene on the main thread and makes
// the whole page stutter, so those devices keep the still images. Checked
// before the large scene code (three.js) is downloaded.
function fastWebGL() {
  try {
    const c = document.createElement('canvas');
    const attrs = { failIfMajorPerformanceCaveat: true };
    const gl = c.getContext('webgl2', attrs) || c.getContext('webgl', attrs);
    if (!gl) return false;
    // Headless and some locked-down browsers still hand out a software context,
    // so also read the renderer name.
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext(); // free the test context right away
    return !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch (err) {
    return false;
  }
}

function load3D() {
  if (!scene3d) {
    scene3d = (fastWebGL() ? import('./scene.js') : Promise.resolve(null))
      .then((mod) => (mod && mod.supportsWebGL() ? mod : null))
      .catch(() => null); // offline or blocked: the still images stay
  }
  return scene3d;
}

function mountStage(el, mod) {
  try {
    if (el === heroStage) {
      heroCan = mod.mountCan(heroStage, {
        flavors: FLAVORS,
        index: heroIndex,
        motion: !reduceMotion,
        scrollLinked: true,
        shadow: 0,
        label: 'A 3D drinks can you can spin. Drag it, or use the arrow keys.',
        startRot: -0.5,
      });
      heroStage.addEventListener('w3:drag', () => { heroTouched = Date.now(); });
      startHeroCycle();
    } else if (el === viewer) {
      demoCan = mod.mountCan(viewer, {
        flavors: FLAVORS,
        index: state.flavor,
        motion: !reduceMotion,
        autoRotate: true,
        shadow: 0.42,
        hotspots: hotspotsFor(viewer),
        label: 'A 3D Fizzbok can. Drag to spin it, or use the arrow keys.',
        startRot: -0.35,
      });
      viewer.addEventListener('w3:drag', () => closeSpots());
    }
    root.classList.add('w3-has-3d');
  } catch (err) {
    el.classList.remove('is-live'); // keep the still image
  }
}

// 3D waits until the page has painted and settled: the visitor's first touch,
// scroll, key or mouse move, or 4 seconds after load. The stills look the same,
// so nobody sees a gap, and the first screen never waits for three.js.
// Then each 3D area starts when it comes close to the screen.
function after3DGate(start) {
  const events = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll', 'mousemove'];
  const opts = { passive: true, capture: true };
  let timer = 0;
  let opened = false;
  function open() {
    if (opened) return;
    opened = true;
    events.forEach((ev) => window.removeEventListener(ev, open, opts));
    clearTimeout(timer);
    // let the event that opened the gate finish painting first
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1));
    idle(start, { timeout: 600 });
  }
  events.forEach((ev) => window.addEventListener(ev, open, opts));
  const later = () => { timer = setTimeout(open, 4000); };
  if (document.readyState === 'complete') later();
  else window.addEventListener('load', later, { once: true });
}

if (stages.length && !saveData && 'IntersectionObserver' in window) {
  after3DGate(() => {
    const near = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        near.unobserve(e.target);
        load3D().then((mod) => { if (mod) mountStage(e.target, mod); });
      });
    }, { rootMargin: '400px 0px' });
    stages.forEach((el) => near.observe(el));
  });
}

// Hero colors start in sync even before 3D loads.
if (heroStage) {
  setHero(0, false);
  $$('[data-hero-pick]').forEach((b) => {
    b.addEventListener('click', () => {
      heroTouched = Date.now();
      setHero(Number(b.dataset.heroPick), true);
    });
  });
}
