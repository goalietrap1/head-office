import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeCatalog, CATEGORIES, ASSIGNABLE } from './furniture.js';
import { SIZES, makeLayout, defaultWall } from './layouts.js';

const TOKEN = document.querySelector('meta[name="office-token"]').content;
const CLIENT_ID = crypto.randomUUID();

// Canvas textures (the wall logo, the studio plaque) draw with Kripa, so wait for it.
await Promise.race([
  Promise.all([document.fonts.load('700 120px Kripa'), document.fonts.load('600 60px Kripa')]),
  new Promise((r) => setTimeout(r, 2500)),
]);

// The floor plan: the room's size and every piece of furniture in it, kept by the server. The
// first time round there isn't one yet, so a short welcome asks how big and how furnished.
let layout = await fetch('/api/layout', { headers: { 'x-office-token': TOKEN } }).then((r) => r.json()).catch(() => null);
const firstRun = !Array.isArray(layout?.items);
if (firstRun) { const pick = await onboarding(); layout = makeLayout(pick.size, pick.furnished); }

const STATUS = {
  coding:     { label: 'Coding',      color: '#60A5FA', busy: true },
  terminal:   { label: 'In terminal', color: '#A3E635', busy: true },
  browsing:   { label: 'Browsing',    color: '#2DD4BF', busy: true },
  reading:    { label: 'Reading',     color: '#38BDF8', busy: true },
  thinking:   { label: 'Thinking',    color: '#A78BFA', busy: true },
  working:    { label: 'Working',     color: '#7DD3FC', busy: true },
  delegating: { label: 'Delegating',  color: '#F472B6', busy: true },
  needs_you:  { label: 'Needs you',   color: '#FB923C' },
  error:      { label: 'Error',       color: '#F87171' },
  done:       { label: 'Done',        color: '#34D399' },
  idle:       { label: 'Idle',        color: '#A1A1AA' },
  offline:    { label: 'Offline',     color: '#5B5970' },
};
const st = (s) => STATUS[s] || STATUS.working;

// ============================================================== renderer & scene

const host = document.getElementById('scene');
// No antialias on the canvas itself: the composer's multisampled target does that, and a second
// MSAA buffer on the screen would only cost memory and bandwidth.
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
const MAX_DPR = Math.min(devicePixelRatio, 2);
renderer.setPixelRatio(MAX_DPR);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
// The canvas is sized to the widest the stage can get (both sidebars folded) and centred in it, so
// opening or closing a sidebar only uncovers more of the room. Resizing a WebGL canvas clears it
// and reallocates the render targets, which flashed on every frame of the sidebar animation.
const view = document.createElement('div'); view.className = 'viewport'; host.appendChild(view);
view.appendChild(renderer.domElement);

const labels = new CSS2DRenderer();
labels.domElement.className = 'labels';
view.appendChild(labels.domElement);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 260);

// Drag to orbit round and tilt up and down, right-drag (or shift-drag, or WASD / arrow keys) to
// slide across the floor, scroll to zoom toward the cursor. The home view is a true 45° isometric.
const HOME_POLAR = 0.97, HOME_DIST = 60;
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.12;
controls.screenSpacePanning = false; // pan along the floor, not the screen
controls.zoomToCursor = true;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
controls.minZoom = 0.75; controls.maxZoom = 4.5;
controls.minPolarAngle = 0.4; controls.maxPolarAngle = 1.2;
controls.minAzimuthAngle = Math.PI / 4 - 0.85; controls.maxAzimuthAngle = Math.PI / 4 + 0.85;

// Multisampled render target: without it, post-processing throws away antialiasing.
const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
const composer = new EffectComposer(renderer, target);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.45, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());

let viewW = 0, viewH = 0;
function resize(force = false) {
  const app = host.closest('.app'), side = (id) => document.getElementById(id)?.offsetWidth || 0;
  const rail = parseFloat(getComputedStyle(app).getPropertyValue('--rail')) || 0;
  // side-by-side, the stage is widest with both sidebars down to their rails; stacked, it's all there is
  const beside = getComputedStyle(app).gridTemplateColumns.split(' ').length > 1;
  const w = Math.max(host.clientWidth, beside ? app.clientWidth - (side('dock') && rail) - (side('panel') && rail) : 0), h = host.clientHeight;
  if (!w || !h || (!force && w === viewW && h === viewH)) return;
  viewW = w; viewH = h; view.style.width = `${w}px`; view.style.height = `${h}px`;
  const aspect = w / h, half = (w < 700 ? 27 : 21.5) * SCALE;
  camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h); composer.setSize(w, h); labels.setSize(w, h);
}
new ResizeObserver(() => resize()).observe(host);

// ============================================================== the room footprint & walkable grid

// The back and left walls stay put; the floor runs out to the front and right, as far as the
// layout's size says. SCALE keeps a bigger office filling the same view.
const ROOM = { w: layout.w, d: layout.d }, SCALE = Math.max(ROOM.w / 52, ROOM.d / 36, 0.74);
const X0 = -18, Z0 = -12, X1 = X0 + ROOM.w, Z1 = Z0 + ROOM.d;
const RX = (X0 + X1) / 2, RZ = (Z0 + Z1) / 2; // room centre

const HOME = new THREE.Vector3(RX, 0.6, RZ - 0.5);
function homeView() {
  const h = Math.sin(HOME_POLAR) * HOME_DIST / Math.SQRT2;
  return { target: HOME.clone(), pos: HOME.clone().add(new THREE.Vector3(h, Math.cos(HOME_POLAR) * HOME_DIST, h)) };
}
{ const { target, pos } = homeView(); controls.target.copy(target); camera.position.copy(pos); }
// Keep the view over the floor: the target can roam the room, never out into the void.
const PAN_BOUNDS = { x0: X0 + 1, x1: X1 - 1, z0: Z0 + 1, z1: Z1 - 1 };
const clampShift = new THREE.Vector3();
function clampPan() {
  const t = controls.target;
  clampShift.set(THREE.MathUtils.clamp(t.x, PAN_BOUNDS.x0, PAN_BOUNDS.x1) - t.x, 0, THREE.MathUtils.clamp(t.z, PAN_BOUNDS.z0, PAN_BOUNDS.z1) - t.z);
  if (clampShift.lengthSq()) { t.add(clampShift); camera.position.add(clampShift); }
}
const CELL = 0.25, COLS = ROOM.w / CELL, ROWS = ROOM.d / CELL;
const blocked = new Uint8Array(COLS * ROWS);
const hard = new Uint8Array(COLS * ROWS); // furniture footprints without the bots' padding: where nothing can be set down
const base = new Uint8Array(COLS * ROWS); // the walls, which never move (see rebuildGrid)
const BOT_RADIUS = 0.45;
const DOOR = new THREE.Vector3(X0 + 3.5, 0, Z0 + 0.9);

const cellOf = (x, z) => [Math.max(0, Math.min(COLS - 1, Math.floor((x - X0) / CELL))), Math.max(0, Math.min(ROWS - 1, Math.floor((z - Z0) / CELL)))];
const centerOf = (i, j) => [X0 + (i + 0.5) * CELL, Z0 + (j + 0.5) * CELL];
const isBlocked = (i, j) => i < 0 || j < 0 || i >= COLS || j >= ROWS || blocked[j * COLS + i] === 1;

// Mark a furniture footprint (axis-aligned) as solid, grown by the bots' radius.
function solid(cx, cz, w, d, pad = BOT_RADIUS) {
  const [i0, j0] = cellOf(cx - w / 2 - pad, cz - d / 2 - pad), [i1, j1] = cellOf(cx + w / 2 + pad, cz + d / 2 + pad);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const [x, z] = centerOf(i, j), ax = Math.abs(x - cx), az = Math.abs(z - cz);
    if (ax <= w / 2 + pad && az <= d / 2 + pad) blocked[j * COLS + i] = 1;
    if (ax <= w / 2 && az <= d / 2) hard[j * COLS + i] = 1;
  }
}
// Walls on the back and left, open floor edges on the front and right: keep everyone inside.
for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
  const [x, z] = centerOf(i, j);
  if (x < X0 + 0.55 || z < Z0 + 0.55 || x > X1 - 0.5 || z > Z1 - 0.5) base[j * COLS + i] = 1;
}
blocked.set(base);

// Platforms are a low step: walkable, but bots ride up onto them (see placeItem).
const STEPS = []; // { x1, x2, z1, z2, h }
const onStep = (p, x, z) => x > p.x1 && x < p.x2 && z > p.z1 && z < p.z2;
const groundY = (x, z) => { let y = 0; for (const p of STEPS) if (p.h > y && onStep(p, x, z)) y = p.h; return y; };

// Floor reachable from the door. Built lazily once all furniture is placed, so a target in a
// sealed-off pocket (say, between the sofa and a beanbag) snaps to floor a bot can actually reach.
let reach = null;
function reachable() {
  if (reach) return reach;
  reach = new Uint8Array(COLS * ROWS);
  const [di, dj] = cellOf(DOOR.x, DOOR.z), queue = [dj * COLS + di]; reach[queue[0]] = 1;
  while (queue.length) {
    const n = queue.pop(), i = n % COLS, j = (n / COLS) | 0;
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const m = (j + b) * COLS + i + a;
      if (!isBlocked(i + a, j + b) && !reach[m]) { reach[m] = 1; queue.push(m); }
    }
  }
  return reach;
}
const isOpen = (i, j) => !isBlocked(i, j) && reachable()[j * COLS + i] === 1;

function nearestFree(i, j) {
  if (isOpen(i, j)) return [i, j];
  for (let r = 1; r < 16; r++) {
    let best = null, bestD = Infinity;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r || !isOpen(i + di, j + dj)) continue;
      const d = di * di + dj * dj; if (d < bestD) { bestD = d; best = [i + di, j + dj]; }
    }
    if (best) return best;
  }
  return [i, j];
}

// Checks a thin corridor (centre line plus both sides), so shortcuts never graze furniture.
function lineOfSight(ax, az, bx, bz) {
  const len = Math.hypot(bx - ax, bz - az) || 1, n = Math.ceil(len / (CELL * 0.4));
  const ox = (-(bz - az) / len) * 0.12, oz = ((bx - ax) / len) * 0.12;
  for (let k = 0; k <= n; k++) {
    const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n;
    if (isBlocked(...cellOf(x, z)) || isBlocked(...cellOf(x + ox, z + oz)) || isBlocked(...cellOf(x - ox, z - oz))) return false;
  }
  return true;
}

// A* over the grid (8 directions, no corner cutting), then string-pulled into a few straight legs.
function findPath(from, to) {
  const [si, sj] = nearestFree(...cellOf(from.x, from.z));
  const [gi0, gj0] = cellOf(to.x, to.z);
  const goalInside = !isOpen(gi0, gj0); // a seat sits inside its chair or sofa
  const [gi, gj] = nearestFree(gi0, gj0);
  const start = sj * COLS + si, goal = gj * COLS + gi;
  const g = new Float32Array(COLS * ROWS).fill(Infinity), came = new Int32Array(COLS * ROWS).fill(-1), closed = new Uint8Array(COLS * ROWS);
  const h = (n) => { const dx = Math.abs((n % COLS) - gi), dz = Math.abs(((n / COLS) | 0) - gj); return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz); };
  const heap = [[h(start), start]]; g[start] = 0;
  const push = (item) => { heap.push(item); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  while (heap.length) {
    const [, n] = pop();
    if (n === goal) break;
    if (closed[n]) continue; closed[n] = 1;
    const ci = n % COLS, cj = (n / COLS) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (isBlocked(ni, nj) || (di && dj && (isBlocked(ci + di, cj) || isBlocked(ci, cj + dj)))) continue;
      const m = nj * COLS + ni, cost = g[n] + (di && dj ? Math.SQRT2 : 1);
      if (cost < g[m]) { g[m] = cost; came[m] = n; push([cost + h(m), m]); }
    }
  }
  if (goal !== start && came[goal] === -1) return [to.clone()]; // unreachable: walk straight (should not happen)
  const cells = []; for (let n = goal; n !== -1; n = came[n]) cells.push(n); cells.reverse();
  const pts = cells.map((n) => centerOf(n % COLS, (n / COLS) | 0));
  const legs = [pts[0]];
  for (let k = 1; k < pts.length; k++) {
    const a = legs[legs.length - 1];
    if (!lineOfSight(a[0], a[1], pts[k][0], pts[k][1])) legs.push(pts[k - 1]);
  }
  legs.push(pts[pts.length - 1]);
  // Starting inside furniture (getting up from a chair or sofa)? Step out to open floor first.
  const path = legs.slice(isBlocked(...cellOf(from.x, from.z)) ? 0 : 1).map(([x, z]) => new THREE.Vector3(x, 0, z));
  if (goalInside || !path.length) path.push(to.clone()); // final little hop into the seat
  else path[path.length - 1].copy(to);
  return path;
}

// ============================================================== building blocks

const matCache = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.02, ...opts }));
  return matCache.get(key);
}
// Thin ink lines on furniture edges give the room a crisp, illustrated look.
const INK = new THREE.LineBasicMaterial({ color: '#1d1a2b', transparent: true, opacity: 0.28 });
function box(w, h, d, color, x = 0, y = 0, z = 0, { r = 0.05, parent = scene, cast = true, opts, ink = true } = {}) {
  const rr = Math.min(r, w / 2, h / 2, d / 2);
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, rr > 0.06 ? 3 : 2, rr), mat(color, opts)); // tiny bevels don't need the extra curve steps
  m.position.set(x, y + h / 2, z);
  m.castShadow = cast; m.receiveShadow = true;
  if (ink && rr <= 0.06 && Math.max(w, h, d) > 0.3 && Math.min(w, h, d) > 0.03) {
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w - rr * 0.6, h - rr * 0.6, d - rr * 0.6)), INK));
  }
  parent.add(m);
  return m;
}
function cyl(rt, rb, h, color, x = 0, y = 0, z = 0, { parent = scene, seg = 24, opts } = {}) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat(color, opts));
  m.position.set(x, y + h / 2, z); m.castShadow = true; m.receiveShadow = true;
  parent.add(m);
  return m;
}
function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

// Furniture never moves, so its meshes are pulled out of the scene graph as world-space geometry
// and merged into one mesh per material, plus one set of ink lines. That turns ~1,600 draw calls
// a frame into a few dozen. Anything that animates is tagged userData.live and left alone.
function harvest(root, into = { meshes: new Map(), lines: [] }) {
  root.updateMatrixWorld(true);
  const found = [];
  const visit = (o) => { if (o.userData.live) return; if (o.isMesh || o.isLineSegments) found.push(o); o.children.forEach(visit); };
  root.children.forEach(visit);
  for (const o of found) {
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (o.isLineSegments) into.lines.push(g);
    else {
      if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]); // merging needs all-indexed
      const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}`;
      if (!into.meshes.has(key)) into.meshes.set(key, { material: o.material, cast: o.castShadow, receive: o.receiveShadow, geos: [] });
      into.meshes.get(key).geos.push(g);
    }
    o.removeFromParent(); o.geometry.dispose();
  }
  return into;
}
function build({ meshes, lines }, parent) {
  for (const { material, cast, receive, geos } of meshes.values()) {
    const merged = geos.length > 1 ? mergeGeometries(geos) : geos[0];
    for (const geo of merged ? [merged] : geos) { // mismatched attributes: fall back to one mesh each
      const m = new THREE.Mesh(geo, material); m.castShadow = cast; m.receiveShadow = receive; parent.add(m);
    }
  }
  if (lines.length) parent.add(new THREE.LineSegments(mergeGeometries(lines), INK));
}

// Things you can click or pick up (lamps, chairs, the ping-pong table...). Each gets an invisible
// box to hit, which is far cheaper to raycast than the merged furniture. See "things to fiddle with".
const toys = [];
const HIT_MAT = new THREE.MeshBasicMaterial();
function toy(x, y, z, w, h, d, props, parent = scene) {
  const hit = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), HIT_MAT);
  hit.position.set(x, y + h / 2, z); hit.visible = false; hit.userData.live = true; parent.add(hit);
  const t = { hit, at: -Infinity, ...props }; hit.userData.toy = t; toys.push(t);
  return t;
}
// ============================================================== the room

const slab = box(ROOM.w + 1.4, 0.7, ROOM.d + 1.4, '#262236', RX - 0.1, -0.72, RZ - 0.1, { r: 0.25, cast: false, ink: false });
slab.material = slab.material.clone();
const planks = canvasTexture(2048, 2048, (g, w, h) => {
  g.fillStyle = '#7a5838'; g.fillRect(0, 0, w, h);
  const rows = 34;
  for (let i = 0; i < rows; i++) {
    const y = (i * h) / rows, off = (i * 523) % w;
    for (let x = -off; x < w; x += 420) {
      const shade = 0.9 + ((i * 7 + x) % 13) / 70;
      g.fillStyle = `rgb(${190 * shade | 0},${142 * shade | 0},${98 * shade | 0})`;
      g.fillRect(x + 3, y + 3, 414, h / rows - 5);
    }
  }
});
planks.wrapS = planks.wrapT = THREE.RepeatWrapping; planks.repeat.set(ROOM.w / 16.4, ROOM.d / 16);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.w, ROOM.d), new THREE.MeshStandardMaterial({ map: planks, roughness: 0.55 }));
floor.rotation.x = -Math.PI / 2; floor.position.set(RX, 0, RZ); floor.receiveShadow = true; scene.add(floor);

// Walls: a dollhouse cutaway. The back and left walls stand full height; the front and right are
// cut down to a low parapet so you can see in. Every wall is the same thick shell with a dark
// skirting board, a panelled wainscot under a chair rail, plaster above and a crown moulding, and
// each cut end finishes in a square pier so the walls read as solid rather than paper-thin.
const WALL = '#e2dcec', PANEL = '#c3b8d8', RAIL = '#a99cc4', SKIRT = '#4a3f63', CAP = '#8d80aa', PIER = '#d2cae0';
const WALL_H = 6.2, WALL_T = 0.4, LOW_H = 0.95;
function wallRun(axis, at, from, to, h, inward) { // a straight wall along x or z, its room-side face at `at`
  const len = to - from, mid = (from + to) / 2;
  const put = (w, hh, d, color, y, off, o = {}) => axis === 'x'
    ? box(len + w, hh, d, color, mid, y, at + inward * off, o)
    : box(d, hh, len + w, color, at + inward * off, y, mid, o);
  put(0, h, WALL_T, WALL, 0, -WALL_T / 2, { r: 0.03 });                                      // the shell
  put(WALL_T + 0.12, 0.14, WALL_T + 0.14, CAP, h, -WALL_T / 2, { r: 0.03 });                 // top cap
  put(0, 0.22, 0.06, SKIRT, 0, 0.03, { r: 0.01, ink: false });                                // skirting board
  if (h < 2) return;
  put(0, 1.3, 0.08, PANEL, 0.22, 0.04, { r: 0.02 });                                         // wainscot
  put(0, 0.08, 0.16, RAIL, 1.5, 0.07, { r: 0.02 });                                          // chair rail
  put(0, 0.14, 0.18, RAIL, h - 0.3, 0.08, { r: 0.03 });                                      // crown moulding
  put(0, 0.05, 0.1, PIER, h - 0.42, 0.05, { r: 0.01, ink: false });
  // raised panels in the wainscot
  for (let p = from + 0.35; p + 1.3 < to; p += 1.6) {
    const c = p + 0.65;
    if (axis === 'x') box(1.3, 0.95, 0.04, '#cdc3e0', c, 0.4, at + inward * 0.1, { r: 0.015 });
    else box(0.04, 0.95, 1.3, '#cdc3e0', at + inward * 0.1, 0.4, c, { r: 0.015 });
  }
}
wallRun('x', Z0, X0 - WALL_T, X1, WALL_H, 1);   // back
wallRun('z', X0, Z0, Z1, WALL_H, 1);            // left
wallRun('x', Z1, X0 - WALL_T, X1, LOW_H, -1);   // front parapet
wallRun('z', X1, Z0, Z1 + WALL_T, LOW_H, -1);   // right parapet
// piers where each wall stops, plus a cornerstone at the inside corner
const MID = WALL_T / 2;
for (const [x, z, h] of [[X1 + MID, Z0 - MID, WALL_H + 0.3], [X0 - MID, Z1 + MID, WALL_H + 0.3], [X1 + MID, Z1 + MID, LOW_H + 0.35], [X0 - MID, Z0 - MID, WALL_H + 0.3]]) {
  box(0.75, h, 0.75, PIER, x, 0, z, { r: 0.05 });
  box(0.9, 0.12, 0.9, CAP, x, h, z, { r: 0.04 });
}
// What hangs on the walls comes with the layout (a furnished office brings its zone signs);
// anything it leaves out is worked out from the room's size.
const WD = { ...defaultWall(ROOM.w, ROOM.d), ...layout.wall };
// Colour-blocked feature walls mark out the zones along the back.
for (const [x1, x2, c] of WD.feature) box(x2 - x1, WALL_H - 1.9, 0.04, c, (x1 + x2) / 2, 1.58, Z0 + 0.02, { r: 0.01, ink: false });

// windows on the back wall (the sky behind them follows time of day), each with a plant on the sill
const skyMat = new THREE.MeshBasicMaterial({ color: '#9fd3ff' });
const stars = [];
const SHELL_SPOTS = []; // places to stand that come with the room: looking out of a window, at the whiteboard
WD.windows.forEach((wx, n) => {
  box(4.1, 3.3, 0.18, '#3b3552', wx, 1.6, Z0 + 0.05, { r: 0.04 });
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(3.7, 2.9), skyMat);
  glass.position.set(wx, 3.25, Z0 + 0.16); scene.add(glass);
  box(0.08, 2.9, 0.06, '#3b3552', wx, 1.8, Z0 + 0.18, { ink: false });
  box(3.7, 0.08, 0.06, '#3b3552', wx, 3.2, Z0 + 0.18, { ink: false });
  box(4.3, 0.1, 0.4, '#efeaf7', wx, 1.5, Z0 + 0.2, { r: 0.03 }); // sill
  const pts = new Float32Array(60 * 3);
  for (let i = 0; i < 60; i++) { pts[i * 3] = wx + (Math.random() - 0.5) * 3.5; pts[i * 3 + 1] = 1.9 + Math.random() * 2.7; pts[i * 3 + 2] = Z0 + 0.17; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const s = new THREE.Points(g, new THREE.PointsMaterial({ color: '#fff7e0', size: 0.06, transparent: true, opacity: 0 }));
  scene.add(s); stars.push(s);
  const px = wx + (n % 2 ? 1.3 : -1.5);
  cyl(0.14, 0.11, 0.22, '#e9e2f3', px, 1.6, Z0 + 0.22);
  const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 0), mat(n % 2 ? '#2f7a4c' : '#3f8f5a', { flatShading: true })); leaf.position.set(px, 2.0, Z0 + 0.22); leaf.castShadow = true; scene.add(leaf);
  SHELL_SPOTS.push([wx, 0, Z0 + 1.0, Math.PI]);
});

// a door, a clock, the logo
box(1.9, 3.9, 0.16, '#4a3a56', DOOR.x, 0, Z0 + 0.05, { r: 0.03 });
box(1.6, 3.6, 0.04, '#55436a', DOOR.x, 0.15, Z0 + 0.14, { r: 0.02 });
cyl(0.07, 0.07, 0.12, '#e9c46a', DOOR.x + 0.6, 1.8, Z0 + 0.2, { opts: { metalness: 0.7, roughness: 0.3 } }).rotation.x = Math.PI / 2;
box(0.9, 0.22, 0.1, '#6ee7b7', DOOR.x, 4.25, Z0 + 0.06, { opts: { emissive: '#6ee7b7', emissiveIntensity: 1.4 }, ink: false });
const clock = cyl(0.55, 0.55, 0.1, '#f4f1fa', WD.clock, 4.1, Z0 + 0.05, { seg: 40 }); clock.rotation.x = Math.PI / 2;
box(0.07, 0.36, 0.04, '#2a2638', WD.clock, 4.05, Z0 + 0.12, { r: 0.02, ink: false }); box(0.28, 0.06, 0.04, '#2a2638', WD.clock + 0.12, 4.08, Z0 + 0.12, { r: 0.02, ink: false });
// The Head Office logo, as in the header: three eyeless beans (blue, terracotta, yellow) on a
// shared baseline, then the wordmark. Mounted on a pale plate on the left wall.
const LOGO_W = 1400, LOGO_H = 300;
const logoTex = canvasTexture(LOGO_W, LOGO_H, (g, w, h) => {
  const k = 7.2; // header px -> canvas px (the header mark is 11px wide beans next to 19px text)
  const plate = 34;
  g.fillStyle = '#fbfaff'; g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, plate); g.fill();
  g.font = `700 ${19 * k}px Kripa, system-ui, sans-serif`; g.textBaseline = 'alphabetic';
  const text = 'Head Office', tw = g.measureText(text).width;
  const bw = 11 * k, gap = 2 * k, markW = bw * 3 + gap * 2, space = 10 * k;
  let x = (w - (markW + space + tw)) / 2;
  const base = h / 2 + 8 * k;
  // CSS: border-radius 50% 50% 42% 42% / 62% 62% 38% 38%
  const bean = (x, bh, color) => {
    const top = base - bh, mid = top + bh * 0.62, rb = bw * 0.42;
    g.fillStyle = color; g.beginPath();
    g.ellipse(x + bw / 2, mid, bw / 2, bh * 0.62, 0, Math.PI, Math.PI * 2);
    g.ellipse(x + bw - rb, mid, rb, bh * 0.38, 0, 0, Math.PI / 2);
    g.ellipse(x + rb, mid, rb, bh * 0.38, 0, Math.PI / 2, Math.PI);
    g.closePath(); g.fill();
  };
  [[11, '#5b8cff'], [16, '#d97757'], [12, '#f5c04a']].forEach(([bh, c], i) => bean(x + i * (bw + gap), bh * k, c));
  x += markW + space;
  g.fillStyle = '#1c1830'; g.fillText(text, x, base + 1.2 * k);
});
const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.9, 4.9 * LOGO_H / LOGO_W), new THREE.MeshStandardMaterial({ map: logoTex, transparent: true, roughness: 0.55, emissive: '#ffffff', emissiveMap: logoTex, emissiveIntensity: 0.12 }));
sign.position.set(X0 + 0.05, 4.6, WD.logoZ); sign.rotation.y = Math.PI / 2; scene.add(sign);
// a warm wash on the sign after dark (strength follows time of day)
const neonLight = new THREE.PointLight('#ffe6c4', 2, 7, 1.8); neonLight.position.set(X0 + 1.4, 5.6, WD.logoZ); scene.add(neonLight);

// whiteboard with a little plan sketched on it
const boardTex = canvasTexture(1024, 600, (g, w, h) => {
  g.fillStyle = '#fbfbfe'; g.fillRect(0, 0, w, h);
  g.lineWidth = 12; g.lineCap = 'round';
  [['#5b8cff', 80, 140, 420], ['#d97757', 80, 260, 600], ['#2dd4bf', 80, 380, 320]].forEach(([c, x, y, l]) => { g.strokeStyle = c; g.beginPath(); g.moveTo(x, y); g.lineTo(x + l, y); g.stroke(); });
  g.strokeStyle = '#f5c04a'; g.beginPath(); g.arc(800, 300, 120, 0, Math.PI * 1.6); g.stroke();
  g.font = '600 46px Kripa'; g.fillStyle = '#3b3552'; g.fillText('this week', 80, 80);
});
if (WD.whiteboardZ != null) {
  box(0.1, 2.3, 4, '#c9c3d6', X0 + 0.05, 1.7, WD.whiteboardZ, { r: 0.03 });
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 2.1), new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.4 }));
  board.position.set(X0 + 0.12, 2.85, WD.whiteboardZ); board.rotation.y = Math.PI / 2; scene.add(board);
  SHELL_SPOTS.push([X0 + 1.6, 0, WD.whiteboardZ, -Math.PI / 2]);
}

// framed prints on the left wall
for (const [z, c1, c2] of WD.prints) {
  box(0.08, 1.5, 1.2, '#2a2638', X0 + 0.04, 2.6, z, { r: 0.02 });
  const art = canvasTexture(240, 300, (g, w, h) => { g.fillStyle = '#f4f1fa'; g.fillRect(0, 0, w, h); g.fillStyle = c1; g.beginPath(); g.arc(w / 2, h * 0.42, 70, 0, Math.PI * 2); g.fill(); g.fillStyle = c2; g.fillRect(40, h * 0.62, w - 80, 46); });
  const p = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.3), new THREE.MeshStandardMaterial({ map: art, roughness: 0.6 }));
  p.position.set(X0 + 0.1, 3.35, z); p.rotation.y = Math.PI / 2; scene.add(p);
}

// framed usage meter on the back wall, under the Claude Studio sign: Grok Bot and Claude plan
// usage, redrawn on every update
box(2.7, 2.0, 0.08, '#2a2638', WD.board, 2.2, Z0 + 0.04, { r: 0.02 });
const usageTex = canvasTexture(1024, 768, () => {});
const usageBoard = new THREE.Mesh(new THREE.PlaneGeometry(2.45, 1.8), new THREE.MeshStandardMaterial({ map: usageTex, roughness: 0.6 }));
usageBoard.position.set(WD.board, 3.2, Z0 + 0.1); scene.add(usageBoard);
let usage = null;

const sinceText = (ts) => { const m = Math.max(0, (Date.now() - ts) / 60000 | 0); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${m / 60 | 0}h ago` : `${m / 1440 | 0}d ago`; };
const resetText = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return ts - Date.now() < 20 * 3600_000 ? `resets ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : `resets ${d.toLocaleDateString([], { weekday: 'short' })}`;
};

function drawUsage() {
  const c = usageTex.image, g = c.getContext('2d'), W = c.width;
  g.fillStyle = '#f4f1fa'; g.fillRect(0, 0, W, c.height);
  g.textBaseline = 'alphabetic';
  g.font = '700 58px Kripa, system-ui'; g.fillStyle = '#3b3552'; g.fillText('Plan usage', 56, 92);

  const meter = (y, m, color) => {
    g.font = '600 32px Kripa, system-ui'; g.fillStyle = '#6b6480'; g.textAlign = 'left'; g.fillText(m.label, 56, y);
    g.font = '700 44px Kripa, system-ui'; g.fillStyle = '#2a2638'; g.textAlign = 'right';
    g.fillText(m.percent == null ? '—' : `${Math.round(m.percent)}%`, W - 56, y + 2);
    g.textAlign = 'left';
    const bx = 56, by = y + 18, bw = W - 112, bh = 34;
    g.fillStyle = '#e2dcec'; g.beginPath(); g.roundRect(bx, by, bw, bh, bh / 2); g.fill();
    if (m.percent) {
      g.fillStyle = m.percent >= 85 ? '#e05d5d' : color;
      g.beginPath(); g.roundRect(bx, by, Math.max(bh, (bw * m.percent) / 100), bh, bh / 2); g.fill();
    }
    g.font = '500 26px Kripa, system-ui'; g.fillStyle = '#8a83a0';
    g.fillText(m.percent == null ? 'No reading for this window yet' : resetText(m.resetsAt), 56, by + bh + 34);
  };
  const section = (y, name, color, u) => {
    g.fillStyle = color; g.beginPath(); g.arc(70, y - 14, 14, 0, Math.PI * 2); g.fill();
    g.font = '700 42px Kripa, system-ui'; g.fillStyle = '#2a2638'; g.fillText(name, 98, y);
    g.font = '500 26px Kripa, system-ui'; g.fillStyle = '#8a83a0'; g.textAlign = 'right';
    g.fillText(u ? `${u.plan === name ? '' : `${u.plan} · `}${sinceText(u.at)}` : 'No usage data found', W - 56, y);
    g.textAlign = 'left';
    return u?.meters || [];
  };

  section(176, 'Grok Bot', '#4F8DFF', usage?.grok).forEach((m, i) => meter(232 + i * 142, m, '#4F8DFF'));
  section(420, 'Claude', '#D97757', usage?.claude).forEach((m, i) => meter(476 + i * 142, m, '#D97757'));
  usageTex.needsUpdate = true;
}
drawUsage();
setInterval(drawUsage, 60_000); // keeps "2h ago" and reset times current

// ============================================================== desks & themes

const DESK_COLOR = '#f2eef8';
function deskProps(theme, g, accent) {
  switch (theme) {
    case 'code':
      box(0.9, 0.55, 0.06, '#1f1d2b', -0.75, 1.27, -0.15, { parent: g }).rotation.y = 0.35;
      box(0.9, 0.04, 0.28, '#2a2638', 0, 1.0, 0.28, { parent: g, r: 0.015 });
      box(0.9, 0.012, 0.03, accent, 0, 1.045, 0.16, { parent: g, r: 0.005, opts: { emissive: accent, emissiveIntensity: 2 }, ink: false });
      break;
    case 'research': {
      for (let i = 0; i < 3; i++) box(0.5 - i * 0.05, 0.1, 0.36, spine[i + 1], 0.75, 1.0 + i * 0.1, 0.15, { parent: g, r: 0.02 }).rotation.y = i * 0.2;
      cyl(0.03, 0.06, 0.2, '#7b6f8f', -0.8, 1.0, 0.1, { parent: g });
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 14), mat('#4fb3d9')); s.position.set(-0.8, 1.36, 0.1); s.castShadow = true; g.add(s);
      break;
    }
    case 'design':
      box(0.62, 0.03, 0.44, '#2a2638', 0.65, 1.0, 0.2, { parent: g, r: 0.02 }).rotation.y = -0.2;
      cyl(0.09, 0.08, 0.24, '#f5c04a', -0.8, 1.0, 0.15, { parent: g });
      ['#e05d5d', '#5b8cff', '#2dd4bf'].forEach((c, i) => cyl(0.012, 0.012, 0.32, c, -0.82 + i * 0.03, 1.12, 0.15, { parent: g, seg: 6 }));
      box(0.5, 0.7, 0.04, '#fbfbfe', -0.95, 1.0, -0.3, { parent: g, r: 0.01 }).rotation.x = -0.15;
      break;
    case 'finance':
      box(0.28, 0.05, 0.36, '#3b3552', 0.7, 1.0, 0.2, { parent: g, r: 0.02 });
      for (let i = 0; i < 4; i++) cyl(0.09, 0.09, 0.035, '#e9c46a', -0.75, 1.0 + i * 0.037, 0.18, { parent: g, opts: { metalness: 0.6, roughness: 0.3 } });
      [0.12, 0.22, 0.17, 0.3].forEach((h, i) => box(0.07, h, 0.07, '#34d399', -0.35 + i * 0.1, 1.0, 0.32, { parent: g, r: 0.01, ink: false }));
      break;
    case 'social': {
      box(0.16, 0.3, 0.03, '#1f1d2b', 0.7, 1.02, 0.15, { parent: g, r: 0.02 }).rotation.x = -0.25;
      const heart = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.035, 8, 20), mat('#f472b6')); heart.position.set(-0.75, 1.12, 0.15); heart.castShadow = true; g.add(heart);
      break;
    }
    case 'writing':
      for (let i = 0; i < 5; i++) box(0.42, 0.012, 0.56, '#fbfbfe', 0.7, 1.0 + i * 0.014, 0.12, { parent: g, r: 0.004, ink: false }).rotation.y = i * 0.06;
      cyl(0.015, 0.015, 0.5, '#2a2638', 0.45, 1.08, 0.2, { parent: g, seg: 6 }).rotation.z = Math.PI / 2;
      break;
    case 'security': {
      const shield = cyl(0.2, 0.2, 0.05, '#3b3552', -0.75, 1.0, 0.1, { seg: 6 }); shield.rotation.x = -1.2; shield.position.y = 1.22; g.add(shield);
      box(0.2, 0.16, 0.1, '#e9c46a', 0.75, 1.0, 0.18, { parent: g, r: 0.03, opts: { metalness: 0.6, roughness: 0.3 } });
      const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.065, 0.018, 8, 16, Math.PI), mat('#9a92ad', { metalness: 0.7, roughness: 0.3 })); shackle.position.set(0.75, 1.16, 0.18); g.add(shackle);
      box(0.9, 0.04, 0.28, '#2a2638', 0, 1.0, 0.28, { parent: g, r: 0.015 });
      break;
    }
    case 'health': {
      const bar = cyl(0.02, 0.02, 0.5, '#9a92ad', 0.7, 1.08, 0.2, { parent: g, seg: 8 }); bar.rotation.z = Math.PI / 2;
      for (const dx of [-0.2, 0.2]) cyl(0.08, 0.08, 0.08, '#2a2638', 0.7 + dx, 1.08, 0.2, { parent: g }).rotation.z = Math.PI / 2;
      const apple = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), mat('#e05d5d', { roughness: 0.4 })); apple.position.set(-0.75, 1.1, 0.15); apple.castShadow = true; g.add(apple);
      cyl(0.06, 0.06, 0.3, '#7dd3fc', -0.45, 1.0, 0.25, { parent: g, opts: { transparent: true, opacity: 0.8 } });
      break;
    }
    case 'care': {
      cyl(0.08, 0.08, 0.16, '#fdf6e3', -0.75, 1.0, 0.15, { parent: g });
      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), new THREE.MeshBasicMaterial({ color: '#ffb547', toneMapped: false })); flame.scale.y = 1.8; flame.position.set(-0.75, 1.22, 0.15); g.add(flame);
      cyl(0.1, 0.08, 0.12, '#e8c4ae', 0.7, 1.0, 0.2, { parent: g });
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 0), mat('#3f8f5a', { flatShading: true })); leaf.position.set(-0.35, 1.18, 0.25); g.add(leaf);
      cyl(0.08, 0.07, 0.12, '#c8674a', -0.35, 1.0, 0.25, { parent: g });
      break;
    }
    case 'career': {
      box(0.5, 0.34, 0.14, '#7b5a43', -0.7, 1.0, 0.18, { parent: g, r: 0.04 });
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 8, 16, Math.PI), mat('#3b2f2a')); handle.position.set(-0.7, 1.34, 0.18); g.add(handle);
      for (let i = 0; i < 3; i++) box(0.42, 0.02, 0.32, ['#5b8cff', '#f5c04a', '#2dd4bf'][i], 0.72, 1.0 + i * 0.022, 0.18, { parent: g, r: 0.005, ink: false }).rotation.y = i * 0.12;
      break;
    }
    default: // ops
      cyl(0.13, 0.11, 0.2, '#5b8cff', -0.8, 1.0, 0.15, { parent: g });
      ['#fde68a', '#fbcfe8', '#bae6fd'].forEach((c, i) => box(0.16, 0.01, 0.16, c, 0.55 + i * 0.2, 1.0, 0.25, { parent: g, r: 0.004, ink: false }).rotation.y = i * 0.3);
  }
}

// A six-ray terracotta starburst (on the Claude Studio sign).
function makeSpark(len, color, glow) {
  const spark = new THREE.Group(); spark.userData.live = true; // it spins: never baked
  const m = mat(color, { emissive: color, emissiveIntensity: glow, roughness: 0.4 });
  for (let i = 0; i < 6; i++) {
    const ray = new THREE.Mesh(new THREE.CapsuleGeometry(len * 0.11, len * 0.75, 4, 8), m);
    ray.geometry.translate(0, len * 0.5, 0); ray.rotation.z = (i * Math.PI) / 3; ray.castShadow = true;
    spark.add(ray);
  }
  return spark;
}

const GLOW_TEX = canvasTexture(128, 128, (g, w, h) => {
  const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.45, 'rgba(255,255,255,0.4)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, w, h);
});
const desks = []; // { item, group, seat, screen, glow, theme, studio, boss, agentId }, one per desk in the layout

// Claude's curved monitor shows every open chat (see drawStudioScreen), on whichever command desk is in the room.
const STUDIO_TEX = canvasTexture(2048, 340, () => {});
STUDIO_TEX.wrapS = THREE.RepeatWrapping; STUDIO_TEX.repeat.x = -1; STUDIO_TEX.offset.x = 1; // seen from inside the curve
const BRASS = { metalness: 0.6, roughness: 0.35 };
const spine = ['#5b8cff', '#f5c04a', '#e05d5d', '#2dd4bf', '#a78bfa', '#f4f1fa', '#d97757'];

// The boss's nameplate, on the front of whichever boss's desk is in the room.
const BOSS_SIGN = canvasTexture(1024, 256, () => {});
let bossName = null;
function drawBossSign(name) {
  if (name === bossName) return;
  bossName = name;
  const g = BOSS_SIGN.image.getContext('2d'), w = 1024, h = 256;
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#1d2547'; g.beginPath(); g.roundRect(6, 6, w - 12, h - 12, 40); g.fill();
  g.strokeStyle = '#e9c46a'; g.lineWidth = 6; g.beginPath(); g.roundRect(24, 24, w - 48, h - 48, 28); g.stroke();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#e9c46a'; g.font = '600 44px Kripa, system-ui'; g.letterSpacing = '16px'; g.fillText('THE BOSS', w / 2 + 8, 84);
  g.fillStyle = '#fbf6e6'; g.font = '700 100px Kripa, system-ui'; g.letterSpacing = '0px'; g.fillText(name || 'Vacant', w / 2, 166);
  BOSS_SIGN.needsUpdate = true;
}
drawBossSign('');

// The zone signs a furnished layout hangs on the back wall: the Grok Bot pit's lightbox, the
// Claude Studio plaque (over the usage board) and the server room's sign.
const PIT_SIGN_W = 1600, PIT_SIGN_H = 300;
const pitSignTex = canvasTexture(PIT_SIGN_W, PIT_SIGN_H, (g, w, h) => {
  g.fillStyle = '#0a0a0c'; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 4; g.strokeRect(18, 18, w - 36, h - 36);
  const cx = 190, cy = h / 2, r = 86; // the ball, lit from the top left like the bots
  const ball = g.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
  ball.addColorStop(0, '#9cc0ff'); ball.addColorStop(0.55, '#4F8DFF'); ball.addColorStop(1, '#2a5fd0');
  g.fillStyle = ball; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff';
  for (const dx of [-26, 26]) { g.beginPath(); g.ellipse(cx + dx, cy - 14, 13, 24, 0, 0, Math.PI * 2); g.fill(); }
  g.font = '700 118px Kripa, system-ui'; g.textBaseline = 'middle'; g.letterSpacing = '22px';
  g.fillText('GROK BOT PIT', 330, cy + 6);
  g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(334, cy + 76, w - 400, 3);
});
const pitSignMat = new THREE.MeshStandardMaterial({ map: pitSignTex, roughness: 0.5, emissive: '#ffffff', emissiveMap: pitSignTex, emissiveIntensity: 0.2 });
const pitSignLight = new THREE.PointLight('#cfe0ff', 0, 6, 1.8); scene.add(pitSignLight); // always there, so adding a sign never recompiles every shader
const studioSign = canvasTexture(1024, 192, (g, w, h) => { g.font = '700 104px Kripa, system-ui'; g.fillStyle = '#7a3b22'; g.textBaseline = 'middle'; g.fillText('Claude Studio', 12, h / 2 + 4); });
const srvTex = canvasTexture(1024, 200, (g, w, h) => {
  g.fillStyle = '#2b3550'; g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 36); g.fill();
  g.fillStyle = '#34d399'; g.beginPath(); g.arc(90, h / 2, 22, 0, Math.PI * 2); g.fill();
  g.font = '700 92px Kripa, system-ui'; g.fillStyle = '#eef2fb'; g.textBaseline = 'middle'; g.letterSpacing = '10px'; g.fillText('SERVER ROOM', 150, h / 2 + 4);
});
const pitLight = new THREE.PointLight('#ffd6a0', 0, 14, 1.2); scene.add(pitLight); // the ceiling lights share one, over their middle (see placeLights)
const sparks = [];
let litPitSign = false;
for (const s of WD.signs) {
  if (s.kind === 'pit') {
    box(4.85, 1.0, 0.1, '#0a0a0c', s.x, 4.97, Z0 + 0.05, { r: 0.03 });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.6 * PIT_SIGN_H / PIT_SIGN_W), pitSignMat); m.position.set(s.x, 5.47, Z0 + 0.16); scene.add(m);
    if (!litPitSign) { litPitSign = true; pitSignLight.position.set(s.x, 5.2, Z0 + 1.3); }
  } else if (s.kind === 'studio') {
    const plaque = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.5), new THREE.MeshStandardMaterial({ map: studioSign, transparent: true }));
    plaque.position.set(s.x, 5.0, Z0 + 0.06); scene.add(plaque);
    const spark = makeSpark(0.22, '#d97757', 0.4); spark.position.set(s.x - 1.6, 5.25, Z0 + 0.09); scene.add(spark); sparks.push(spark);
  } else if (s.kind === 'server') {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.7), new THREE.MeshStandardMaterial({ map: srvTex, transparent: true, roughness: 0.5, emissive: '#ffffff', emissiveMap: srvTex, emissiveIntensity: 0.15 }));
    m.position.set(s.x, 4.4, Z0 + 0.07); scene.add(m);
  }
}

// Shared bits some pieces need: the rack LEDs (pulsed in animate), the meeting-room slides, the
// ops console's graph and the floor tiles.
const LEDS = ['#34d399', '#60a5fa', '#fbbf24', '#34d399', '#60a5fa', '#34d399'].map((c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1.5, roughness: 0.4 }));
const SLIDES = [
  canvasTexture(512, 300, (g, w, h) => {
    g.fillStyle = '#1f2a4a'; g.fillRect(0, 0, w, h);
    g.font = '700 40px Kripa, system-ui'; g.fillStyle = '#f4f1fa'; g.fillText('Q4 roadmap', 30, 62);
    [['#5b8cff', 150], ['#f5c04a', 230], ['#2dd4bf', 110], ['#d97757', 260]].forEach(([c, v], i) => { g.fillStyle = c; g.fillRect(50 + i * 110, h - 30 - v * 0.7, 70, v * 0.7); });
  }),
  canvasTexture(512, 300, (g, w, h) => {
    g.fillStyle = '#163a2e'; g.fillRect(0, 0, w, h);
    g.font = '700 40px Kripa, system-ui'; g.fillStyle = '#f4f1fa'; g.fillText('Ship it', 30, 62);
    g.strokeStyle = '#34d399'; g.lineWidth = 22; g.lineCap = g.lineJoin = 'round';
    g.beginPath(); g.moveTo(190, 170); g.lineTo(240, 220); g.lineTo(330, 120); g.stroke();
  }),
];
const GRAPH_TEX = canvasTexture(512, 300, (g, w, h) => {
  g.fillStyle = '#0f1424'; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 2; for (let y = 50; y < h; y += 50) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  for (const [c, k] of [['#34d399', 0.9], ['#60a5fa', 1.7]]) {
    g.strokeStyle = c; g.lineWidth = 6; g.beginPath();
    for (let x = 0; x <= w; x += 16) { const y = h * 0.55 + Math.sin(x / 40 * k) * 50 + Math.sin(x / 13) * 14; x ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
  }
});
const TILES = {};
function tilesTex(kind) {
  return (TILES[kind] ||= (() => {
    const t = canvasTexture(512, 512, (g, w, h) => {
      if (kind === 'checker') { for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { g.fillStyle = (i + j) % 2 ? '#2a2638' : '#ece7f4'; g.fillRect(i * w / 4, j * h / 4, w / 4, h / 4); } return; }
      if (kind === 'terrazzo') {
        g.fillStyle = '#e9e2dc'; g.fillRect(0, 0, w, h);
        for (let i = 0; i < 260; i++) { g.fillStyle = ['#d97757', '#5b8cff', '#f5c04a', '#9a92ad', '#2f7a4c'][i % 5]; g.beginPath(); g.arc((i * 197) % w, (i * 311) % h, 3 + (i % 4) * 2, 0, Math.PI * 2); g.fill(); }
        return;
      }
      g.fillStyle = '#ccd2e0'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#a9b1c6'; g.lineWidth = 5;
      for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo((i * w) / 4, 0); g.lineTo((i * w) / 4, h); g.moveTo(0, (i * h) / 4); g.lineTo(w, (i * h) / 4); g.stroke(); }
      g.fillStyle = '#b8c0d3'; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if ((i + j) % 3 === 0) g.fillRect(i * w / 4 + 22, j * h / 4 + 22, w / 4 - 44, h / 4 - 44); // vent tiles
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  })());
}

// ============================================================== furniture
// Everything standing on the floor comes from the shop (furniture.js) and is put where the layout
// says. Like the room, the parts of every piece that never move are merged into one shared layer
// (rebuilt on the next frame whenever a piece is added, moved, swapped or put away); chairs you can
// pick up keep their own few meshes so they can travel on their own.

let dry = false; // building a shop thumbnail or a placement ghost: no toys, nothing registered
const CATALOG = makeCatalog({
  THREE, mat, box, cyl, canvasTexture, GLOW_TEX, spine, BRASS, LEDS, STUDIO_TEX, BOSS_SIGN, SLIDES, GRAPH_TEX, BOARD_TEX: boardTex, deskProps,
  tiles: tilesTex, lerp: (a, b, t) => a + (b - a) * t, blip: (...a) => blip(...a),
  toy: (x, y, z, w, h, d, props, parent) => (dry ? props : toy(x, y, z, w, h, d, props, parent)),
  pool: (g, w, d, x, y, z) => { // the soft pool of screen light on a desk (see animate)
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: GLOW_TEX, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    p.rotation.x = -Math.PI / 2; p.position.set(x, y, z); p.userData.live = true; g.add(p); return p;
  },
});
const CAT_NAME = Object.fromEntries(CATEGORIES);
const defOf = (item) => CATALOG[item?.type];

const placed = new Map(); // uid -> { item, def, g, parts, toys, hit, solids, seats, spots, desk, light, step }
const furnLayer = new THREE.Group(); furnLayer.userData.live = true; scene.add(furnLayer);
let furnDirty = false;
const turn = (rot, x, z) => [x * Math.cos(rot) + z * Math.sin(rot), -x * Math.sin(rot) + z * Math.cos(rot)];
// A local rectangle, turned with its piece, as the world-space box around it: [x, z, w, d, pad].
function worldRect(item, [lx, lz, w, d, pad]) {
  const [cx, cz] = turn(item.rot, lx, lz), c = Math.abs(Math.cos(item.rot)), s = Math.abs(Math.sin(item.rot));
  return [item.x + cx, item.z + cz, w * c + d * s, w * s + d * c, pad];
}

function placeItem(item) {
  const def = defOf(item); if (!def) return null;
  const lift = def.cat === 'platform' || def.hanging ? 0 : groundY(item.x, item.z);
  const g = new THREE.Group(); g.position.set(item.x, lift, item.z); g.rotation.y = item.rot; scene.add(g);
  const t0 = toys.length;
  const out = def.build(g, item) || {};
  const rec = { item, def, g, lift, toys: toys.slice(t0), parts: null, size: out.size || [def.w, def.d] };
  if (def.movable) { // merged at the origin, then put back, so it can travel as one piece
    g.position.set(0, 0, 0); g.rotation.set(0, 0, 0);
    build(harvest(g), g);
    g.position.set(item.x, lift, item.z); g.rotation.y = item.rot;
  } else { rec.parts = harvest(g); furnDirty = true; }
  g.userData.live = true;
  const [hx, hz, hw, hd, hh, hy = 0] = def.hit && !out.size ? def.hit : [0, 0, rec.size[0], Math.max(rec.size[1], 0.4), Math.max(def.h, 0.05)];
  rec.hit = new THREE.Mesh(new THREE.BoxGeometry(hw, hh, hd), HIT_MAT);
  rec.hit.position.set(hx, hy + hh / 2, hz); rec.hit.visible = false; rec.hit.userData.live = true; rec.hit.userData.furn = rec; g.add(rec.hit);
  for (const t of rec.toys) t.rec = rec;
  rec.solids = (out.solids ?? [[0, 0, rec.size[0], rec.size[1]]]).map((s) => worldRect(item, s));
  const at = (x, z) => { const [a, b] = turn(item.rot, x, z); return [item.x + a, item.z + b]; };
  rec.seats = (out.seats || []).map(([x, y, z, f]) => { const [wx, wz] = at(x, z); return [wx, y + lift, wz, item.rot + f]; });
  rec.spots = (out.spots || []).map(([x, z, f]) => { const [wx, wz] = at(x, z); return [wx, lift, wz, item.rot + f]; });
  if (out.light) rec.light = { ...out.light, x: item.x, y: out.light.y + lift, z: item.z, toy: rec.toys.find((t) => t.kind === 'lamp') };
  if (out.step) { const [x, z, w, d] = worldRect(item, [0, 0, ...rec.size]); rec.step = { x1: x - w / 2, x2: x + w / 2, z1: z - d / 2, z2: z + d / 2, h: out.step }; STEPS.push(rec.step); }
  if (out.desk) {
    const o = out.desk, [sx, sz] = at(o.seat[0], o.seat[2]);
    rec.desk = {
      rec, item, group: g, theme: item.theme || 'ops', studio: !!o.studio, boss: !!o.boss, screen: o.screen || null, papers: o.papers,
      rot: item.rot, facing: item.rot + (o.facing ?? 0), agentId: null, seat: new THREE.Vector3(sx, o.seat[1] + lift, sz),
      glow: { color: new THREE.Color(o.studio ? '#d97757' : '#60a5fa'), intensity: 0, pool: o.pool },
    };
    desks.push(rec.desk);
  }
  placed.set(item.uid, rec);
  return rec;
}

function unplaceItem(item) {
  const rec = placed.get(item.uid); if (!rec) return null;
  placed.delete(item.uid);
  for (const t of rec.toys) toys.splice(toys.indexOf(t), 1);
  if (rec.step) STEPS.splice(STEPS.indexOf(rec.step), 1);
  const sitter = rec.desk?.agentId || null;
  if (rec.desk) { desks.splice(desks.indexOf(rec.desk), 1); const b = sitter && bots.get(sitter); if (b?.desk === rec.desk) b.desk = null; }
  rec.g.removeFromParent(); rec.g.traverse((o) => o.geometry?.dispose());
  if (rec.parts) furnDirty = true;
  return { rec, sitter };
}

// Swap a piece for a fresh build of itself (a new design, a desk re-dressed for a new job, a move).
// Whoever was working at it keeps working at it.
function rebuildItem(item) {
  const gone = unplaceItem(item), rec = placeItem(item);
  if (gone?.sitter && rec?.desk) { rec.desk.agentId = gone.sitter; const b = bots.get(gone.sitter); if (b) b.desk = rec.desk; }
  return rec;
}

function rebuildFurnLayer() {
  furnDirty = false;
  furnLayer.traverse((o) => { if (o !== furnLayer) o.geometry.dispose(); });
  furnLayer.clear();
  const all = { meshes: new Map(), lines: [] };
  for (const { parts } of placed.values()) {
    if (!parts) continue;
    for (const [k, v] of parts.meshes) { if (!all.meshes.has(k)) all.meshes.set(k, { ...v, geos: [] }); all.meshes.get(k).geos.push(...v.geos); }
    all.lines.push(...parts.lines);
  }
  build(all, furnLayer);
}

// Platforms lift whatever stands on them, so moving one re-seats everything it touches.
function relift(step) {
  if (!step) return;
  for (const rec of [...placed.values()]) if (rec.def.cat !== 'platform' && !rec.def.hanging && rec.item.x > step.x1 && rec.item.x < step.x2 && rec.item.z > step.z1 && rec.item.z < step.z2) rebuildItem(rec.item);
}

function rebuildGrid() {
  blocked.set(base); hard.fill(0);
  for (const rec of placed.values()) if (!rec.lifted) for (const [x, z, w, d, pad] of rec.solids) solid(x, z, w, d, pad ?? BOT_RADIUS);
  reach = null;
}

// Where idle bots can go: every seat that isn't a desk chair, and the standing spots in front of
// shelves, fridges, games and windows. Seats on something assigned to a bot are theirs alone.
let SPOTS = [], LOUNGE = [];
function rebuildSpots() {
  SPOTS = []; LOUNGE = [];
  for (const rec of placed.values()) {
    const owner = rec.item.owner || null;
    if (!rec.desk) for (const s of rec.seats) { const spot = Object.assign([...s], { owner }); SPOTS.push(spot); if (rec.def.cat === 'sofa' || rec.def.cat === 'beanbag') LOUNGE.push(spot); }
    for (const s of rec.spots) SPOTS.push(Object.assign([...s], { owner: null }));
  }
  SPOTS.push(...SHELL_SPOTS);
}
const ownedBy = (id) => { for (const rec of placed.values()) if (rec.item.owner === id) return rec; return null; };

// Floor lamps share three real lights (the brightest lamps get them), so the number of lights in
// the scene never changes and adding a lamp never recompiles every shader.
const lampLights = [0, 1, 2].map(() => { const l = new THREE.PointLight('#ffb27a', 0, 12, 1.4); scene.add(l); return l; });
function placeLights() {
  const lit = [...placed.values()].filter((r) => r.light).sort((a, b) => b.light.power - a.light.power);
  lampLights.forEach((l, i) => { const r = lit[i]; l.userData.rec = r || null; if (r) { l.position.set(r.light.x, r.light.y, r.light.z); l.color.set(r.light.color); } });
  const pend = toys.filter((t) => t.pendant);
  if (pend.length) pitLight.position.set(pend.reduce((s, t) => s + t.rec.item.x, 0) / pend.length, 3.2, pend.reduce((s, t) => s + t.rec.item.z, 0) / pend.length);
}

// After anything moves: re-solve the floor, re-list the seats, relight, and let everyone re-plan.
function layoutChanged({ save = true } = {}) {
  rebuildGrid(); rebuildSpots(); placeLights(); applyTod();
  for (const b of bots.values()) { b.loungeIdx = undefined; b.wander = null; if (!b.leaving) placeBot(b); }
  renderChips(); updateOfficeDesc();
  if (save) saveLayout();
}

let saveTimer = 0;
function saveLayout() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api('/api/layout', layout).catch(() => {}), 400);
}
const newUid = () => `u${crypto.randomUUID().slice(0, 8)}`;

// ============================================================== lighting & time of day

const hemi = new THREE.HemisphereLight('#dfe8ff', '#5a4a6a', 1.0); scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
sun.position.set(RX + 14 * SCALE, 30 * SCALE, RZ + 20 * SCALE); sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -36 * SCALE, right: 36 * SCALE, top: 30 * SCALE, bottom: -30 * SCALE, near: 1, far: 130 * SCALE });
sun.target.position.set(RX, 0, RZ); scene.add(sun.target);
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.02; sun.shadow.radius = 3;
scene.add(sun);

const TOD = {
  day:     { sky: '#a8d8ff', hemi: 1.15, sun: 2.4, sunColor: '#fff4e0', lamps: 0.25, stars: 0, exposure: 1.05, neon: 1.5 },
  evening: { sky: '#ff9f72', hemi: 0.7, sun: 1.5, sunColor: '#ffb27a', lamps: 1.0, stars: 0.25, exposure: 1.0, neon: 4 },
  night:   { sky: '#121638', hemi: 0.38, sun: 0.45, sunColor: '#9fb4ff', lamps: 1.6, stars: 0.9, exposure: 1.12, neon: 6 },
};
let todMode = 'auto';
function currentTod() {
  if (todMode !== 'auto') return todMode;
  const h = new Date().getHours();
  return h >= 7 && h < 17 ? 'day' : h >= 17 && h < 20 ? 'evening' : 'night';
}
function applyTod() {
  const t = TOD[currentTod()];
  skyMat.color.set(t.sky);
  hemi.intensity = t.hemi; sun.intensity = t.sun; sun.color.set(t.sunColor);
  const pend = toys.filter((p) => p.pendant); // the ceiling lights share one light
  pitLight.intensity = pend.length ? (5 * t.lamps * pend.filter((p) => p.on).length) / pend.length : 0;
  for (const l of lampLights) { const r = l.userData.rec; l.intensity = r && r.light.toy?.on !== false ? r.light.power * t.lamps : 0; }
  for (const l of toys) l.apply?.(t); // every lamp you can switch, on or off
  neonLight.intensity = t.neon; sign.material.emissiveIntensity = 0.1 + t.neon * 0.04;
  pitSignLight.intensity = litPitSign ? t.neon * 0.6 : 0; pitSignMat.emissiveIntensity = 0.2 + t.neon * 0.06;
  stars.forEach((s) => (s.material.opacity = t.stars));
  renderer.toneMappingExposure = t.exposure;
}
document.getElementById('tod').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  todMode = b.dataset.tod;
  for (const x of e.currentTarget.children) x.classList.toggle('on', x === b);
  applyTod();
});
applyTod(); setInterval(applyTod, 60_000);

// ============================================================== light / dark mode
// Independent of the office's time of day: this switches the page around the office
// (panel, labels, the floor slab) between light and dark. Remembered per browser.

const prefersLight = matchMedia('(prefers-color-scheme: light)');
let themeMode = document.documentElement.dataset.theme || 'auto';
const isLight = () => themeMode === 'light' || (themeMode === 'auto' && prefersLight.matches);
function applyTheme() {
  document.documentElement.dataset.theme = themeMode;
  const light = isLight();
  scene.background = new THREE.Color(light ? '#f1edf8' : '#14131c'); // post-processing makes the canvas opaque
  slab.material.color.set(light ? '#d8d1e6' : '#262236');
  INK.opacity = light ? 0.2 : 0.28;
  bloom.strength = light ? 0.2 : 0.32;
  for (const b of document.querySelectorAll('#theme button')) b.classList.toggle('on', b.dataset.theme === themeMode);
}
document.getElementById('theme').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  themeMode = b.dataset.theme;
  try { localStorage.setItem('office-theme', themeMode); } catch {}
  applyTheme();
});
prefersLight.addEventListener('change', applyTheme);
applyTheme();

// ============================================================== the bots
//
// Two families. Grok bots look like the Grok Bot icon: a glossy round ball with two tilted
// oval eyes glancing up and to the right, in the colour of their Grok avatar (Sentinel adds
// shades). Claude is a single terracotta bean at the Claude Studio desk.

function lathe(profile) {
  const pts = [];
  for (let i = 0; i <= 40; i++) { const t = -Math.PI / 2 + (i / 40) * Math.PI; pts.push(profile(t, Math.sin(t))); }
  return new THREE.LatheGeometry(pts, 56);
}
const BEAN = lathe((t, s) => new THREE.Vector2(Math.max(0.6 * Math.cos(t) * (1 - 0.08 * Math.max(0, s)), 1e-4), 0.55 + (s < 0 ? s * 0.55 : s * 0.6)));

const BALL_R = 0.62, BALL_SQUASH = 0.94;
const BALL = new THREE.SphereGeometry(BALL_R, 64, 40).scale(1, BALL_SQUASH, 1).translate(0, BALL_R * BALL_SQUASH, 0);
// Front surface depth of the ball at a given height and sideways offset, so eyes sit flush.
const ballZ = (y, x = 0) => { const dy = (y - BALL_R * BALL_SQUASH) / BALL_SQUASH; return Math.sqrt(Math.max(0, BALL_R * BALL_R - dy * dy - x * x)); };
const GROK_FORM = { geo: BALL, eyeY: 0.8, eyeZ: 0 };
const GROK_EYES = [[-0.16, 0], [0.16, 0]]; // [x, y], upright and level
const GROK_EYE = new THREE.CapsuleGeometry(0.056, 0.12, 6, 14).scale(1, 1, 0.55);
const GROK_EYE_MAT = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.25, emissive: '#ffffff', emissiveIntensity: 0.08 });
const GROK_EYE_DARK = new THREE.MeshStandardMaterial({ color: '#16141f', roughness: 0.2 }); // on very light bodies

const EYE_TALL = new THREE.CapsuleGeometry(0.055, 0.1, 4, 12);
const EYE_ROUND = new THREE.SphereGeometry(0.075, 20, 14);
const EYE_MAT = new THREE.MeshStandardMaterial({ color: '#141218', roughness: 0.2 });
const SHINE_MAT = new THREE.MeshBasicMaterial({ color: '#ffffff' });
const SHINE_GEO = new THREE.SphereGeometry(0.02, 8, 6);

// Only Sentinel (security) wears anything: its shades. Everyone else is just the ball.
const THEME_LOOK = { security: 'shades' };
const lookFor = (a) => a.look || THEME_LOOK[a.theme] || null;
const hashOf = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) >>> 0;

function addAccessory(look, body, eye, eyeXs = [[-0.17, 0], [0.17, 0]]) {
  const dark = mat('#2a2638', { roughness: 0.5 });
  const add = (geo, m, x, y, z, rx = 0, ry = 0, rz = 0) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); o.castShadow = true; body.add(o); return o; };
  const ez = eye.z, ey = eye.y;
  switch (look) {
    case 'glasses':
      for (const [x, z] of eyeXs) add(new THREE.TorusGeometry(0.1, 0.018, 8, 24), dark, x, ey + 0.01, z + 0.03, -0.25);
      add(new THREE.CylinderGeometry(0.012, 0.012, 0.08, 6), dark, (eyeXs[0][0] + eyeXs[1][0]) / 2, ey + 0.03, ez + 0.05, 0, 0, Math.PI / 2);
      break;
    case 'shades':
      for (const [x, z] of eyeXs) add(new RoundedBoxGeometry(0.22, 0.12, 0.04, 2, 0.02), mat('#111018', { roughness: 0.15, metalness: 0.3 }), x, ey, z + 0.04, -0.25, x * 0.6);
      add(new THREE.CylinderGeometry(0.012, 0.012, 0.06, 6), dark, (eyeXs[0][0] + eyeXs[1][0]) / 2, ey + 0.03, ez + 0.05, 0, 0, Math.PI / 2);
      break;
  }
}

const bots = new Map(); // agentId -> bot

function makeBot(agent) {
  const isClaude = agent.source === 'claude';
  const root = new THREE.Group();
  const body = new THREE.Group(); root.add(body);
  let base = new THREE.Color(agent.color || '#8a8fa3');
  if (isClaude) base = base.offsetHSL(((hashOf(agent.id) % 9) - 4) / 220, 0, ((hashOf(agent.id) % 5) - 2) / 60); // each session a slightly different shade
  const material = new THREE.MeshPhysicalMaterial({ color: base.clone(), roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.3, sheen: 0.4, sheenColor: new THREE.Color('#ffffff') });
  const form = isClaude ? { geo: BEAN, eyeY: 0.7, eyeZ: 0.55 } : GROK_FORM;
  const shell = new THREE.Mesh(form.geo, material); shell.castShadow = true; body.add(shell);

  const eyes = new THREE.Group(); body.add(eyes);
  const eyeY = form.eyeY;
  let eyeXs;
  if (isClaude) {
    eyes.position.set(0, eyeY, form.eyeZ);
    for (const ex of [-0.17, 0.17]) {
      const e = new THREE.Mesh(EYE_ROUND, EYE_MAT); e.position.x = ex; e.rotation.x = -0.25; eyes.add(e);
      const shine = new THREE.Mesh(SHINE_GEO, SHINE_MAT); shine.position.set(ex + 0.025, 0.04, 0.05); eyes.add(shine);
    }
    eyeXs = [[-0.17, form.eyeZ], [0.17, form.eyeZ]];
  } else {
    // two tilted white ovals, like the Grok Bot icon
    eyes.position.set(0, eyeY, 0);
    eyeXs = GROK_EYES.map(([x, y]) => {
      const z = ballZ(eyeY + y, x) - 0.012;
      const light = base.getHSL({}).l > 0.62;
      const e = new THREE.Mesh(GROK_EYE, light ? GROK_EYE_DARK : GROK_EYE_MAT);
      e.position.set(x, y, z); e.rotation.set(0, Math.asin(x / BALL_R), 0); // only turned to follow the curve, never tilted
      eyes.add(e);
      return [x, z];
    });
  }
  const eyeFront = Math.max(...eyeXs.map(([, z]) => z));

  if (isClaude) {
    const cheek = mat('#f0a58a', { roughness: 0.6 });
    for (const x of [-0.33, 0.33]) { const c = new THREE.Mesh(new THREE.CircleGeometry(0.06, 16), cheek); c.position.set(x, 0.6, 0.52); c.rotation.y = x * 1.1; body.add(c); }
  } else {
    const look = lookFor(agent);
    if (look) addAccessory(look, body, { y: eyeY, z: eyeFront }, eyeXs);
  }

  // floor rings: status (pulses when it needs you) and selection
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.72, 0.82, 56), new THREE.MeshBasicMaterial({ color: '#fb923c', transparent: true, opacity: 0, side: THREE.DoubleSide, toneMapped: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; root.add(ring);
  const sel = new THREE.Mesh(new THREE.RingGeometry(0.9, 0.96, 56), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, side: THREE.DoubleSide }));
  sel.rotation.x = -Math.PI / 2; sel.position.y = 0.025; root.add(sel);

  // CSS2DRenderer owns each label's transform, so styled/animated content lives one level down.
  const holder = (cls) => { const outer = document.createElement('div'); const inner = document.createElement('div'); inner.className = cls; outer.appendChild(inner); return [outer, inner]; };
  const [tagOuter, tagEl] = holder('tag');
  const tag = new CSS2DObject(tagOuter); tag.position.set(0, agent.id === 'claude:studio' ? 1.45 : 1.9, 0); root.add(tag); // Claude's sits low, clear of its monitor
  const [bubbleOuter, bubbleEl] = holder('bubble');
  const bubble = new CSS2DObject(bubbleOuter); bubble.position.set(0, 2.5, 0); bubble.visible = false; root.add(bubble);
  // what it's busy with, floating just above the name tag (see workIcon)
  const [workOuter, workEl] = holder('work');
  const work = new CSS2DObject(workOuter); work.position.copy(tag.position); work.visible = false; root.add(work);
  const [zOuter, zEl] = holder('zzz'); zEl.textContent = 'z z z';
  const zzz = new CSS2DObject(zOuter); zzz.position.set(0.5, 1.5, 0); zzz.visible = false; root.add(zzz);

  shell.userData.agentId = agent.id;
  scene.add(root);
  const bot = {
    id: agent.id, isClaude, root, body, shell, eyes, eyeY, ring, sel, tag, tagEl, bubble, bubbleEl, work, workEl, zzz, material, baseColor: base,
    agent, desk: null, goal: null, path: [], facing: 0,
    phase: Math.random() * 10, blinkAt: 2 + Math.random() * 4, hopUntil: 0,
  };
  root.position.copy(DOOR); // everyone arrives through the door
  bots.set(agent.id, bot);
  return bot;
}

function freeDesk(d) { d.agentId = null; d.glow.intensity = 0; d.screen?.material.emissive.set('#000'); }
function deskFor(bot) {
  const a = bot.agent, boss = a.source === 'grok' && !!a.primary, own = ownedBy(bot.id);
  // Something assigned to this bot wins: their desk, or a sofa or chair they work from (no desk then).
  if (own) {
    if (own.desk) return claimDesk(bot, own.desk);
    if (bot.desk?.agentId === bot.id) freeDesk(bot.desk);
    return (bot.desk = null);
  }
  if (bot.desk && bot.desk.agentId === bot.id && !!bot.desk.boss === boss && !bot.desk.item.owner && desks.includes(bot.desk)) return bot.desk;
  if (bot.desk?.agentId === bot.id) freeDesk(bot.desk); // promoted, or no longer the boss
  bot.desk = null;
  // The boss's desk is the primary bot's alone; everyone else shares the pit (or the studio).
  const pool = desks.filter((d) => !d.item.owner && (boss ? d.boss : !d.boss && (a.source === 'claude') === d.studio));
  const free = pool.find((d) => !d.agentId) || (boss ? pool[0] : null);
  return free ? claimDesk(bot, free) : null;
}
function claimDesk(bot, d) {
  if (bot.desk === d && d.agentId === bot.id) return d;
  if (bot.desk?.agentId === bot.id) freeDesk(bot.desk);
  if (d.agentId && d.agentId !== bot.id) { const was = bots.get(d.agentId); freeDesk(d); if (was) { was.desk = null; placeBot(was); } } // whoever sat here clears out
  // Pit desks are re-dressed with props for the agent's job.
  const a = bot.agent;
  if (!d.boss && !d.studio && a.source !== 'claude' && d.theme !== (a.theme || 'ops')) {
    d.item.theme = a.theme || 'ops'; d.item.accent = a.color;
    d = rebuildItem(d.item).desk;
  }
  d.agentId = bot.id;
  return (bot.desk = d);
}

function loungeSpot(bot) {
  if (bot.loungeIdx !== undefined && LOUNGE[bot.loungeIdx]) return LOUNGE[bot.loungeIdx];
  const taken = new Set([...bots.values()].filter((b) => b !== bot && b.loungeIdx !== undefined).map((b) => b.loungeIdx));
  const idx = LOUNGE.findIndex((s, i) => !taken.has(i) && (!s.owner || s.owner === bot.id));
  if (idx < 0) return null;
  bot.loungeIdx = idx; return LOUNGE[idx];
}

function goTo(bot, pos, facing) {
  bot.facing = facing;
  if (bot.goal && bot.goal.distanceTo(pos) < 0.05) return;
  bot.goal = pos.clone();
  bot.path = findPath(bot.root.position, pos);
}

// Bots that have been quiet for hours go and rest in the lounge.
const isRestful = (bot) => !bot.isClaude && bot.agent.status === 'idle' && Date.now() - (bot.agent.lastAt || bot.agent.since || 0) > 8 * 3600_000;
const isCalm = (bot) => ['idle', 'done'].includes(bot.agent.status);

function placeBot(bot) {
  const desk = deskFor(bot), own = ownedBy(bot.id), seat = own && !own.desk ? own.seats[0] : null;
  if (isRestful(bot)) {
    const spot = seat || loungeSpot(bot);
    if (spot) return goTo(bot, new THREE.Vector3(spot[0], spot[1], spot[2]), seat ? spot[3] : Math.PI / 4);
  }
  bot.loungeIdx = undefined;
  if (bot.wander && isCalm(bot)) return goTo(bot, bot.wander.pos, bot.wander.facing);
  bot.wander = null;
  if (seat) return goTo(bot, new THREE.Vector3(seat[0], seat[1], seat[2]), seat[3]); // their own sofa or armchair: they work from there
  // Claude works with its back to us, facing the curved monitor, and turns round when it needs you.
  if (desk?.studio) return goTo(bot, desk.seat, bot.agent.status === 'needs_you' ? desk.rot + Math.PI / 4 : desk.facing);
  if (desk) return goTo(bot, desk.seat, desk.rot + (isCalm(bot) ? bot.deskFacing ?? 0.45 : 0.45)); // turned toward the monitor, and toward us
  const [i, j] = nearestFree(...cellOf(RX - 6 + (hashOf(bot.id) % 120) / 10, RZ + ROOM.d * 0.2)); // no desk free: mingle out front
  const [x, z] = centerOf(i, j);
  goTo(bot, new THREE.Vector3(x, 0, z), Math.PI / 4);
}

// Idle bots don't just sit there: every minute or so one gets up, goes and sits on the sofa, plays
// ping-pong, gets a coffee or looks out of the window for a while, then wanders back to its desk.
// Some just lean back in their chair instead. Any new work sends them straight back to their desk.
function wanderTick() {
  const now = performance.now() / 1000;
  for (const bot of bots.values()) {
    if (bot.leaving || !isCalm(bot) || isRestful(bot)) { bot.nextMove = undefined; if (bot.wander) { bot.wander = null; placeBot(bot); } continue; }
    if (bot.nextMove === undefined) { bot.nextMove = now + 10 + Math.random() * 50; continue; } // staggered, so they don't all get up at once
    if (now < bot.nextMove || bot.path.length) continue;
    if (bot.wander) { bot.wander = null; bot.nextMove = now + 35 + Math.random() * 70; }
    else if (!bot.isClaude && Math.random() < 0.3) { bot.deskFacing = [0.45, 1.3, -0.5, 2.4][Math.random() * 4 | 0]; bot.nextMove = now + 20 + Math.random() * 40; }
    else {
      const taken = [...bots.values()].filter((b) => b !== bot && b.goal).map((b) => b.goal);
      const free = SPOTS.filter((s) => (!s.owner || s.owner === bot.id) && !taken.some((g) => Math.hypot(g.x - s[0], g.z - s[2]) < 0.7));
      const pick = free[Math.random() * free.length | 0];
      if (!pick) { bot.nextMove = now + 20; continue; }
      bot.wander = { pos: new THREE.Vector3(pick[0], pick[1], pick[2]), facing: pick[3] };
      bot.nextMove = now + 18 + Math.random() * 30;
    }
    placeBot(bot);
  }
}

// A Claude session that's resting (the server sets `away`) walks out the door and is
// only listed in the panel until it wakes up again.
function sendHome(bot) {
  if (bot.leaving) return;
  bot.leaving = true; bot.bubble.visible = false; bot.work.visible = false; bot.loungeIdx = undefined;
  if (bot.desk) { bot.desk.agentId = null; bot.desk.glow.intensity = 0; bot.desk.screen?.material.emissive.set('#000'); bot.desk = null; }
  goTo(bot, DOOR, Math.PI);
}

// The little animation over a busy agent's head: a thought cloud of bouncing dots while it
// thinks, a blinking prompt in the terminal, lines being typed while coding, and pulsing
// activity bars for everything else.
function workIcon(status) {
  if (status === 'thinking') return '<span class="w-dots"><i></i><i></i><i></i></span>';
  if (status === 'terminal') return '<span class="w-term">&gt;<b>_</b></span>';
  if (status === 'coding') return '<span class="w-code"><i></i><i></i><i></i></span>';
  return '<span class="w-bars"><i></i><i></i><i></i><i></i></span>';
}

const CROWN = '<svg class="crown" viewBox="0 0 16 12" aria-label="Boss"><path d="M1.5 3.5 5 7l3-5.5L11 7l3.5-3.5L13 10.5H3z"/></svg>';
function updateBot(agent) {
  if (agent.away) { const b = bots.get(agent.id); if (b) { b.agent = agent; sendHome(b); } return; }
  const bot = bots.get(agent.id) || makeBot(agent);
  bot.leaving = false;
  const prev = bot.agent.status;
  bot.agent = agent;
  const s = st(agent.status);
  const hot = agent.status === 'needs_you';
  // One Claude stands in for every open chat: its tag just counts them.
  const text = (agent.primary ? CROWN : '') + esc(agent.name) + (agent.id === STUDIO_ID && agent.live > 1 ? ` <span class="sub">×${agent.live}</span>` : '');
  bot.tagEl.innerHTML = `<i class="dot" style="background:${hot ? '#1a0e06' : s.color}"></i><span class="txt">${text}</span>`;
  bot.tagEl.classList.toggle('hot', hot);
  bot.tagEl.classList.toggle('quiet', ['idle', 'offline'].includes(agent.status));
  bot.tagEl.classList.toggle('selected', selectedId === agent.id);
  if (agent.pending) {
    const q = agent.pending.kind === 'question';
    bot.bubbleEl.classList.toggle('needs', !q);
    bot.bubbleEl.innerHTML = `<div class="bubble-head"><span class="bubble-ic">${q ? '?' : '!'}</span><small>${q ? 'Question' : 'Needs you'}</small></div><p>${esc(agent.pending.detail || agent.pending.title)}</p>`;
    bot.bubble.visible = true;
  } else bot.bubble.visible = false;
  bot.work.visible = !!s.busy && !bot.bubble.visible;
  if (bot.work.visible && bot.workKind !== agent.status) {
    bot.workKind = agent.status;
    bot.workEl.className = `work ${agent.status === 'thinking' ? 'thinking' : ''}`;
    bot.workEl.style.setProperty('--c', s.color);
    bot.workEl.innerHTML = workIcon(agent.status);
  }
  bot.zzz.visible = agent.status === 'offline';
  if (prev !== agent.status && (agent.status === 'done' || hot)) bot.hopUntil = clock3.elapsedTime + 1.2;
  placeBot(bot);
  const d = bot.desk;
  if (d) {
    const on = agent.status !== 'offline';
    if (d.screen) { d.screen.material.emissive.set(on ? s.color : '#000'); d.screen.material.emissiveIntensity = on ? 0.9 : 0; }
    d.glow.color.set(s.color); d.glow.intensity = s.busy ? 2.4 : agent.status === 'offline' ? 0 : 0.8;
  }
}

function removeBot(id) {
  const bot = bots.get(id); if (!bot) return;
  if (bot.desk) { bot.desk.agentId = null; bot.desk.glow.intensity = 0; bot.desk.screen?.material.emissive.set('#000'); }
  bot.root.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); });
  scene.remove(bot.root); bots.delete(id);
}

// Name tags crowd each other when many agents share a corner, so each tick they're placed in
// priority order and any tag that would overlap one already placed shrinks to just its dot.
// Hovering or selecting a bot always brings its full tag back.
let hoveredId = null, declutteredAt = 0;
const tagPos = new THREE.Vector3();
const TAG_RANK = { needs_you: 500, error: 400, done: 100, idle: 50, offline: 0 };
function declutter() {
  const W = viewW, H = viewH, placed = [];
  const items = [];
  for (const bot of bots.values()) {
    bot.tag.getWorldPosition(tagPos);
    const depth = tagPos.distanceTo(camera.position);
    tagPos.project(camera);
    const s = bot.agent.status;
    const score = (bot.id === selectedId ? 2000 : 0) + (bot.id === hoveredId ? 1000 : 0)
      + (TAG_RANK[s] ?? (STATUS[s]?.busy ? 200 : 50)) + (bot.tagFull ? 5 : 0) - depth; // a small bonus for already-open tags stops flicker
    items.push({ bot, x: (tagPos.x + 1) / 2 * W, y: (1 - tagPos.y) / 2 * H - 4, score });
    // bubbles are the loudest thing in the room: tags yield to them
    if (bot.bubble.visible) {
      const r = bot.bubbleEl.getBoundingClientRect(), o = view.getBoundingClientRect();
      if (r.width) placed.push([r.left - o.left, r.top - o.top, r.right - o.left, r.bottom - o.top]);
    }
  }
  items.sort((a, b) => b.score - a.score);
  for (const { bot, x, y, score } of items) {
    const txt = bot.tagEl.querySelector('.txt');
    const w = bot.tagEl.offsetWidth - (txt?.offsetWidth || 0) + (txt?.scrollWidth || 0), h = bot.tagEl.offsetHeight || 22;
    const r = [x - w / 2 - 3, y - h / 2 - 2, x + w / 2 + 3, y + h / 2 + 2];
    const forced = score >= 1000;
    const full = forced || !placed.some((p) => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1]);
    if (full) placed.push(r);
    bot.tagFull = full;
    bot.tagEl.classList.toggle('collapsed', !full);
  }
}

const clock3 = new THREE.Clock();
const tmp = new THREE.Vector3();
const grey = new THREE.Color('#6b6880');
const red = new THREE.Color('#f87171');
const black = new THREE.Color(0, 0, 0), tint = new THREE.Color(); // scratch colour: no per-frame allocations
const lerp = THREE.MathUtils.lerp;
const lerpAngle = (a, b, t) => a + (((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * t;

// If this machine can't keep up, render fewer pixels rather than drop frames: every ~1.5s of
// mostly-missed frames steps the pixel ratio down a notch, towards 1. It never steps back up.
let frameAt = 0, frames = -120, slowFrames = 0; // skip the first couple of seconds (shader compiles)
function governResolution(now) {
  const ms = now - frameAt; frameAt = now;
  if (ms > 250) return; // tab was hidden or the page paused
  if (++frames <= 0) return;
  if (ms > 24) slowFrames++;
  if (frames < 90) return;
  const slow = slowFrames / frames, pr = renderer.getPixelRatio();
  frames = slowFrames = 0;
  if (slow > 0.25 && pr > 1) { const next = Math.max(1, pr - 0.25); renderer.setPixelRatio(next); composer.setPixelRatio(next); resize(true); }
}

function animate() {
  const dt = Math.min(clock3.getDelta(), 0.05), t = clock3.elapsedTime;
  for (const bot of bots.values()) {
    const { root, body, eyes, agent } = bot, s = agent.status;
    const next = bot.path[0];
    if (next) {
      // walk the planned legs, hopping a little, riding up/down the studio step
      tmp.copy(next).sub(root.position); tmp.y = 0;
      const dist = tmp.length(), finalLeg = bot.path.length === 1;
      const step = Math.min(dist, dt * (isCalm(bot) ? 3.0 : 4.5)); // new work: hurry back to the desk
      if (dist > 1e-4) {
        root.position.addScaledVector(tmp.normalize(), step);
        root.rotation.y = lerpAngle(root.rotation.y, Math.atan2(tmp.x, tmp.z), 0.25);
      }
      const ground = groundY(root.position.x, root.position.z);
      root.position.y = lerp(root.position.y, finalLeg && dist < 0.8 ? next.y : ground, 0.25);
      body.position.y = Math.abs(Math.sin(t * 11 + bot.phase)) * 0.2;
      body.scale.set(1, 1, 1); body.rotation.z = 0;
      if (dist - step < 0.02) bot.path.shift();
    } else if (bot.leaving) {
      removeBot(bot.id); continue;
    } else {
      if (bot.goal) root.position.y = lerp(root.position.y, bot.goal.y, 0.2);
      root.rotation.y = lerpAngle(root.rotation.y, bot.facing, 0.1);
      let y = 0, sx = 1, sy = 1, rz = 0;
      if (STATUS[s]?.busy) { y = Math.abs(Math.sin(t * (s === 'thinking' ? 2.2 : 9) + bot.phase)) * (s === 'thinking' ? 0.05 : 0.035); sy = 1 - y * 0.6; sx = 1 + y * 0.4; if (s === 'thinking') rz = Math.sin(t * 1.4 + bot.phase) * 0.06; }
      else if (s === 'needs_you') { y = Math.max(0, Math.sin(t * 5)) * 0.35; }
      else { const b = Math.sin(t * 1.5 + bot.phase) * 0.015; sy = 1 + b; sx = 1 - b * 0.5; }
      if (t < bot.hopUntil) y = Math.max(y, Math.abs(Math.sin((bot.hopUntil - t) * 8)) * 0.4);
      body.position.y = y; body.scale.set(sx, sy, sx); body.rotation.z = rz;
    }
    body.position.x = s === 'error' ? Math.sin(t * 40) * 0.025 : 0;
    // eyes: blink, sleep, look up when thinking, happy squint when done
    let eyeScale = 1;
    if (t > bot.blinkAt) { eyeScale = 0.1; if (t > bot.blinkAt + 0.12) bot.blinkAt = t + 2.5 + Math.random() * 4; }
    if (s === 'offline') eyeScale = 0.12;
    if (s === 'done') eyeScale = Math.min(eyeScale, 0.45);
    // blink each eye along its own vertical axis (squashing the pair as a group looks sideways)
    for (const e of eyes.children) if (e.geometry !== SHINE_GEO) e.scale.y = lerp(e.scale.y, eyeScale, 0.4);
    eyes.position.y = lerp(eyes.position.y, bot.eyeY + (s === 'thinking' ? 0.08 : 0), 0.1);
    eyes.position.x = s === 'thinking' ? Math.sin(t * 0.9 + bot.phase) * 0.06 : lerp(eyes.position.x, 0, 0.1);
    // colour: offline is greyed, errors flush red
    const target = s === 'offline' ? tint.copy(bot.baseColor).lerp(grey, 0.55) : s === 'error' ? tint.copy(bot.baseColor).lerp(red, 0.35 + Math.sin(t * 6) * 0.15) : bot.baseColor;
    bot.material.color.lerp(target, 0.1);
    // seated at a lit monitor: pick up a little of the screen's colour (stands in for a point light)
    const lit = bot.desk && !bot.path.length && bot.goal?.equals(bot.desk.seat) ? bot.desk.glow : null;
    bot.material.emissive.lerp(lit ? tint.copy(lit.color).multiplyScalar(lit.intensity * 0.05) : black, 0.08);
    const ringColor = s === 'needs_you' ? '#fb923c' : s === 'error' ? '#f87171' : null;
    bot.ring.material.opacity = ringColor ? 0.45 + Math.sin(t * 5) * 0.3 : 0;
    if (ringColor) { bot.ring.material.color.set(ringColor); bot.ring.scale.setScalar(1 + Math.sin(t * 5) * 0.06); }
    const picked = selectedId === bot.id || (bot.id === STUDIO_ID && agents.get(selectedId)?.source === 'claude');
    bot.sel.material.opacity = lerp(bot.sel.material.opacity, picked ? 0.7 : 0, 0.15);
    bot.ring.visible = !!ringColor; bot.sel.visible = bot.sel.material.opacity > 0.01; // fully faded rings still cost a draw
  }
  for (const d of desks) {
    const pool = d.glow.pool.material, o = d.agentId ? d.glow.intensity * 0.09 : 0;
    pool.color.copy(d.glow.color); pool.opacity = lerp(pool.opacity, o, 0.1); d.glow.pool.visible = pool.opacity > 0.005;
  }
  stepFurn(dt, t);
  for (const s of sparks) s.rotation.z += dt * 0.3;
  LEDS.forEach((m, i) => (m.emissiveIntensity = 0.6 + Math.max(0, Math.sin(t * (1.3 + i * 0.9) + i * 2.1)) * 1.8));
  if (furnDirty) rebuildFurnLayer();
  stepCamera(dt);
  stepKeys(dt);
  controls.update();
  if (!closeUp) clampPan();
  composer.render(); labels.render(scene, camera);
  governResolution(performance.now());
  if (t - declutteredAt > 0.12) { declutteredAt = t; declutter(); }
  requestAnimationFrame(animate);
}

// ============================================================== close-up on the usage board
// Clicking the plan-usage board flies the camera square onto it, close enough to read.
// Any click, Esc or the hint button flies back to where you were.

const LIMITS = ['minPolarAngle', 'maxPolarAngle', 'minAzimuthAngle', 'maxAzimuthAngle', 'minZoom', 'maxZoom'];
const boardHint = document.createElement('button');
boardHint.className = 'board-hint'; boardHint.hidden = true; boardHint.textContent = '← Back to the office (Esc)';
host.appendChild(boardHint);
let closeUp = null, camTween = null;

function flyCamera(pos, target, zoom, done) {
  camTween = { t: 0, p0: camera.position.clone(), q0: controls.target.clone(), z0: camera.zoom, p1: pos, q1: target, z1: zoom, done };
}
function focusBoard() {
  if (closeUp) return;
  closeUp = { pos: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom, limits: Object.fromEntries(LIMITS.map((k) => [k, controls[k]])) };
  Object.assign(controls, { enabled: false, minPolarAngle: 0, maxPolarAngle: Math.PI, minAzimuthAngle: -Infinity, maxAzimuthAngle: Infinity, minZoom: 0.1, maxZoom: 100 });
  // Fill most of the gap between the sidebars (they float over the scene), and centre it there.
  const r = view.getBoundingClientRect(), stage = host.getBoundingClientRect();
  let L = Math.max(r.left, stage.left), R = Math.min(r.right, stage.right);
  for (const id of ['dock', 'panel']) {
    const b = document.getElementById(id)?.getBoundingClientRect();
    if (!b?.width) continue;
    if (b.left + b.width / 2 < r.left + r.width / 2) L = Math.max(L, b.right); else R = Math.min(R, b.left);
  }
  const free = Math.max(R - L, r.width * 0.4);
  const zoom = Math.min((camera.top * 2 * r.height * 0.72) / (1.8 * r.height), (camera.right * 2 * free * 0.88) / (2.45 * r.width));
  const perPx = (camera.right * 2) / zoom / r.width, c = usageBoard.position;
  const aim = c.clone().setX(c.x + (r.width / 2 - ((L + R) / 2 - r.left)) * perPx);
  flyCamera(aim.clone().setZ(c.z + 3), aim, zoom); // close in: the ortho near plane clips anything in between
  boardHint.style.left = `${(L + R) / 2 - stage.left}px`; boardHint.hidden = false; labels.domElement.hidden = true;
}
function leaveBoard() {
  if (!closeUp || camTween?.leaving) return;
  const { pos, target, zoom, limits } = closeUp;
  flyCamera(pos, target, zoom, () => { Object.assign(controls, limits, { enabled: true }); closeUp = null; labels.domElement.hidden = false; });
  camTween.leaving = true;
  boardHint.hidden = true;
}
boardHint.addEventListener('click', leaveBoard);

function stepCamera(dt) {
  if (!camTween) return;
  const tw = camTween;
  tw.t = Math.min(1, tw.t + dt / 0.9);
  const k = tw.t * tw.t * (3 - 2 * tw.t);
  camera.position.lerpVectors(tw.p0, tw.p1, k);
  controls.target.lerpVectors(tw.q0, tw.q1, k);
  camera.zoom = lerp(tw.z0, tw.z1, k); camera.updateProjectionMatrix();
  if (tw.t === 1) { camTween = null; tw.done?.(); }
}

// ============================================================== getting around
// WASD / arrow keys slide the view, + and - zoom, R (or the home button) flies back to the
// full isometric view. Picking someone in the team list glides over to them.

const held = new Set();
const PAN_KEYS = { w: [0, 1], arrowup: [0, 1], s: [0, -1], arrowdown: [0, -1], a: [-1, 0], arrowleft: [-1, 0], d: [1, 0], arrowright: [1, 0] };
const fwd = new THREE.Vector3(), side = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
function stepKeys(dt) {
  if (!held.size || closeUp || camTween) return;
  let mx = 0, mz = 0;
  for (const k of held) { mx += PAN_KEYS[k][0]; mz += PAN_KEYS[k][1]; }
  if (!mx && !mz) return;
  fwd.subVectors(controls.target, camera.position).setY(0).normalize();
  side.crossVectors(fwd, UP);
  const step = (16 / camera.zoom) * dt;
  const move = fwd.multiplyScalar(mz * step).addScaledVector(side, mx * step);
  controls.target.add(move); camera.position.add(move);
}
function zoomBy(f) {
  if (closeUp) return;
  const z = THREE.MathUtils.clamp(camera.zoom * f, controls.minZoom, controls.maxZoom);
  flyCamera(camera.position.clone(), controls.target.clone(), z);
}
function goHome() {
  if (closeUp) return leaveBoard();
  const { target, pos } = homeView();
  flyCamera(pos, target, 1);
}
// Slide (and zoom in a little, if zoomed right out) so a bot sits in the middle of the view.
function glideTo(p) {
  if (closeUp) return;
  const shift = new THREE.Vector3(p.x - controls.target.x, 0, p.z - controls.target.z);
  flyCamera(camera.position.clone().add(shift), controls.target.clone().add(shift), Math.max(camera.zoom, 1.7));
}
window.addEventListener('blur', () => held.clear());
document.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));

const nav = document.createElement('div');
nav.className = 'nav-ctl'; nav.setAttribute('role', 'group'); nav.setAttribute('aria-label', 'Camera');
nav.innerHTML = `
  <button data-nav="in" title="Zoom in (+)" aria-label="Zoom in"><svg viewBox="0 0 20 20"><path d="M10 5v10M5 10h10"/></svg></button>
  <button data-nav="out" title="Zoom out (−)" aria-label="Zoom out"><svg viewBox="0 0 20 20"><path d="M5 10h10"/></svg></button>
  <button data-nav="home" title="Reset view (R)" aria-label="Reset view"><svg viewBox="0 0 20 20"><path d="M3.5 9.5 10 4l6.5 5.5M5.5 8v7.5h9V8"/></svg></button>`;
nav.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  ({ in: () => zoomBy(1.4), out: () => zoomBy(1 / 1.4), home: goHome })[b.dataset.nav]();
});
document.querySelector('.bottombar').appendChild(nav);

// ============================================================== picking
// Click a bot to select it. Click any piece of furniture for its card (who it belongs to, swap it
// for another design, move it, turn it, put it away); lamps, games and the coffee machine also do
// their thing as you click. Press and hold a chair to carry it somewhere else.

const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (grab) return release(e);
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  if (closeUp) return leaveBoard();
  if (placing) return dropPlacing();
  const id = pick(e);
  if (id) { closePop(); return select(id); }
  const hit = pickThing(e);
  if (hit?.toy) poke(hit.toy);
  if (hit?.rec) return openPop(hit.rec, e);
  closePop();
  if (ray.intersectObject(usageBoard).length) return focusBoard();
  select(null);
});
// Mice can fire pointermove several times a frame; raycast at most once per frame.
let hoverEvent = null, hoverRec = null;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (grab) return hold(e);
  if (placing) return movePlacing(e);
  if (!hoverEvent) requestAnimationFrame(() => {
    if (grab || placing || !hoverEvent) return (hoverEvent = null);
    hoveredId = closeUp ? null : pick(hoverEvent) || null;
    const thing = closeUp || hoveredId ? null : pickThing(hoverEvent);
    hoverRec = thing?.rec || null;
    renderer.domElement.style.cursor = closeUp ? 'zoom-out' : hoveredId || thing ? (hoverRec?.def.movable ? 'grab' : 'pointer') : ray.intersectObject(usageBoard).length ? 'zoom-in' : 'grab';
    hoverEvent = null;
  });
  hoverEvent = e;
});
renderer.domElement.addEventListener('pointerleave', () => (hoveredId = hoverRec = null));
function aim(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}
function pick(e) {
  aim(e);
  return ray.intersectObjects([...bots.values()].map((b) => b.shell))[0]?.object.userData.agentId;
}
// The nearest thing under the pointer: a toy (a lamp, a game...) or a piece of furniture.
function pickThing(e) {
  aim(e);
  const o = ray.intersectObjects([...toys.map((t) => t.hit), ...[...placed.values()].map((r) => r.hit)])[0]?.object;
  if (!o) return null;
  const toy = o.userData.toy || null;
  return { toy, rec: toy?.rec || o.userData.furn || null };
}

// ============================================================== things to fiddle with

const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), floorHit = new THREE.Vector3();
let grab = null;

// A quiet little sound for each thing you touch (shares the alerts' audio context).
function blip(freq, len = 0.05, type = 'sine', vol = 0.03) {
  try {
    audio ||= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain(), now = audio.currentTime;
    o.type = type; o.frequency.setValueAtTime(freq, now);
    g.gain.setValueAtTime(vol, now); g.gain.exponentialRampToValueAtTime(0.0001, now + len);
    o.connect(g).connect(audio.destination); o.start(); o.stop(now + len);
  } catch {}
}

function poke(t) {
  if (t.kind === 'lamp') { t.on = !t.on; if (t.rec) t.rec.item.on = t.on; applyTod(); blip(t.on ? 1600 : 1100, 0.03, 'square', 0.02); return saveLayout(); }
  t.at = clock3.elapsedTime; t.poke?.();
  if (t.sound) blip(...t.sound);
}

// Pressing on a chair takes it from the camera: hold still for a moment, or start moving, and it lifts.
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || closeUp || grab || placing || pick(e)) return;
  const rec = pickThing(e)?.rec;
  if (!rec?.def.movable) return;
  controls.enabled = false; // runs before OrbitControls' own handler (capture), so it never starts orbiting
  try { renderer.domElement.setPointerCapture(e.pointerId); } catch {}
  grab = { rec, x: e.clientX, y: e.clientY, e, wheel: 0, lifted: false, timer: setTimeout(() => grab && !grab.lifted && lift(grab.e), 260) };
}, true);

function lift(e) {
  const { rec } = grab, it = rec.item;
  grab.lifted = true; clearTimeout(grab.timer); downAt = null; closePop();
  aim(e); ray.ray.intersectPlane(floorPlane, floorHit);
  grab.pos = new THREE.Vector3(it.x, 0, it.z); grab.rot = it.rot;
  grab.off = grab.pos.clone().sub(floorHit).setY(0);
  rec.lifted = true; rebuildGrid();
  for (const bot of bots.values()) { // whoever was sitting in it (or on the way) heads off elsewhere
    if (!bot.goal || !rec.seats.some((s) => Math.hypot(bot.goal.x - s[0], bot.goal.z - s[2]) < 0.3)) continue;
    bot.hopUntil = clock3.elapsedTime + 0.6; bot.wander = null; bot.nextMove = performance.now() / 1000 + 20;
    placeBot(bot);
  }
  renderer.domElement.style.cursor = 'grabbing';
  blip(520, 0.08, 'triangle', 0.03);
}
function hold(e) {
  grab.e = e;
  if (!grab.lifted) { if (Math.hypot(e.clientX - grab.x, e.clientY - grab.y) > 4) lift(e); else return; }
  aim(e);
  if (!ray.ray.intersectPlane(floorPlane, floorHit)) return;
  grab.pos.set(THREE.MathUtils.clamp(floorHit.x + grab.off.x, X0 + 0.9, X1 - 0.9), 0, THREE.MathUtils.clamp(floorHit.z + grab.off.z, Z0 + 0.9, Z1 - 0.9));
}
renderer.domElement.addEventListener('wheel', (e) => { // turn it while it's in your hand (or while placing something)
  if (!grab && !placing) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (placing) { placing.wheel = (placing.wheel || 0) + e.deltaY; if (Math.abs(placing.wheel) >= 60) { turnPlacing(Math.sign(placing.wheel)); placing.wheel = 0; } return; }
  if (!grab.lifted) lift(grab.e);
  grab.wheel += e.deltaY;
  while (Math.abs(grab.wheel) >= 40) { const s = Math.sign(grab.wheel); grab.rot += s * Math.PI / 12; grab.wheel -= s * 40; }
}, { capture: true, passive: false });
renderer.domElement.addEventListener('pointercancel', () => grab && release());

function release(e) {
  const { rec, lifted, timer } = grab;
  clearTimeout(timer); grab = null; controls.enabled = true;
  renderer.domElement.style.cursor = 'grab';
  if (!lifted) return e && openPop(rec, e); // just a click: its card
  rec.lifted = false;
  const it = rec.item, to = { ...it, x: rec.g.position.x, z: rec.g.position.z, rot: rec.g.rotation.y };
  rec.lifted = true; rebuildGrid(); const ok = canPlace(to); rec.lifted = false;
  if (ok) { Object.assign(it, { x: +to.x.toFixed(2), z: +to.z.toFixed(2), rot: +to.rot.toFixed(3) }); blip(140, 0.12, 'sine', 0.08); } // a soft thud
  else blip(200, 0.1, 'sawtooth', 0.02); // no room: it goes back
  rebuildItem(it); layoutChanged();
}

// While a chair is in the air it follows the pointer, with a little sway; the hovered chair grows a touch.
function stepFurn(dt, now) {
  const k = 1 - Math.exp(-dt * 16);
  if (grab?.lifted) {
    const g = grab.rec.g, p = g.position;
    p.x = lerp(p.x, grab.pos.x, k); p.z = lerp(p.z, grab.pos.z, k); p.y = lerp(p.y, groundY(p.x, p.z) + 0.35, k);
    g.rotation.y = lerpAngle(g.rotation.y, grab.rot, k); g.rotation.z = Math.sin(now * 9) * 0.04;
  }
  for (const rec of placed.values()) if (rec.def.movable && rec !== grab?.rec) rec.g.scale.setScalar(lerp(rec.g.scale.x, hoverRec === rec ? 1.05 : 1, k));
  for (const t of toys) if (t.step && now - t.at < t.dur + 0.1) t.step(Math.min(now - t.at, t.dur));
  // an outline round the piece whose card is open (or the one under the pointer)
  const show = popRec && placed.get(popRec.item.uid) === popRec ? popRec : hoverRec && !hoverRec.def.flat ? hoverRec : null;
  outline.visible = !!show && !placing && !grab;
  if (outline.visible) {
    show.hit.updateWorldMatrix(true, false);
    outline.matrix.copy(show.hit.matrixWorld).multiply(outlineScale.makeScale(show.hit.geometry.parameters.width, show.hit.geometry.parameters.height, show.hit.geometry.parameters.depth));
    outline.material.color.set(show === popRec ? '#ff8a4c' : '#ffffff'); outline.material.opacity = show === popRec ? 0.9 : 0.45;
  }
}
const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthTest: false, toneMapped: false }));
outline.matrixAutoUpdate = false; outline.renderOrder = 10; outline.visible = false; outline.userData.live = true; scene.add(outline);
const outlineScale = new THREE.Matrix4();

// ---------------------------------------------------------------- will it fit?
// What a design looks like on the floor (its solid parts and its size), from a dry build, cached.
const shapes = new Map();
function shapeOf(item) {
  const key = `${item.type}|${item.w || ''}|${item.d || ''}|${item.s || ''}`;
  if (!shapes.has(key)) {
    const def = defOf(item), g = new THREE.Group();
    dry = true; let out; try { out = def.build(g, { ...item, x: 0, z: 0, rot: 0 }) || {}; } finally { dry = false; }
    g.traverse((o) => o.geometry?.dispose());
    const size = out.size || [def.w, def.d];
    shapes.set(key, { size, solids: out.solids ?? [[0, 0, size[0], size[1]]] });
  }
  return shapes.get(key);
}
function hardIn(cx, cz, w, d) {
  const [i0, j0] = cellOf(cx - w / 2, cz - d / 2), [i1, j1] = cellOf(cx + w / 2, cz + d / 2);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (hard[j * COLS + i]) return true;
  return false;
}
// Inside the room, and (unless it's a rug, a platform or a ceiling light) not on top of anything.
// Callers take the piece being moved out of `hard` first.
function canPlace(item) {
  const def = defOf(item); if (!def) return false;
  const sh = shapeOf(item), [x, z, W, D] = worldRect(item, [0, 0, ...sh.size]);
  if (x - W / 2 < X0 - 0.05 || x + W / 2 > X1 + 0.05 || z - D / 2 < Z0 - 0.05 || z + D / 2 > Z1 + 0.05) return false;
  if (def.flat || def.hanging) return true;
  return sh.solids.every((s) => { const [sx, sz, w, d] = worldRect(item, s); return !hardIn(sx, sz, Math.max(0.05, w - 0.12), Math.max(0.05, d - 0.12)); });
}
function withoutRec(rec, fn) { rec.lifted = true; rebuildGrid(); try { return fn(); } finally { rec.lifted = false; rebuildGrid(); } }

// ---------------------------------------------------------------- placing: a ghost on the pointer
// Picking something in the shop (or Move on a card) puts a see-through copy of it on the pointer,
// green where it fits and red where it doesn't. Click to set it down; scroll or R to turn it; Esc to stop.
let placing = null;
function startPlacing(item, moving = null) {
  cancelPlacing(); closePop();
  const def = defOf(item), ghost = new THREE.Group();
  dry = true; try { def.build(ghost, item); } finally { dry = false; }
  ghost.traverse((o) => {
    if (o.isLineSegments) o.visible = false;
    if (!o.isMesh) return;
    o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = Math.min(o.material.opacity ?? 1, 0.62); o.material.depthWrite = false; o.castShadow = false;
  });
  const sh = shapeOf(item);
  const pad = new THREE.Mesh(def.round ? new THREE.CircleGeometry(sh.size[0] / 2, 48) : new THREE.PlaneGeometry(...sh.size), new THREE.MeshBasicMaterial({ color: '#34d399', transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false }));
  pad.rotation.x = -Math.PI / 2; pad.position.y = 0.04; ghost.add(pad);
  ghost.userData.live = true; ghost.visible = false; scene.add(ghost);
  placing = { item, def, ghost, pad, moving, ok: false };
  hint(`<b>${esc(def.name)}</b> · click the floor to put it down · scroll or <kbd>R</kbd> to turn · <kbd>Esc</kbd> to stop`);
  renderer.domElement.style.cursor = 'crosshair';
  shopEl.classList.add('mini'); // out of the way of the floor while you place
  if (moving) { ghost.visible = true; updatePlacing(); }
}
function movePlacing(e) {
  aim(e);
  if (!ray.ray.intersectPlane(floorPlane, floorHit)) return;
  const snap = placing.def.movable ? 0.05 : 0.25;
  placing.item.x = Math.round(floorHit.x / snap) * snap; placing.item.z = Math.round(floorHit.z / snap) * snap;
  placing.ghost.visible = true;
  updatePlacing();
}
function updatePlacing() {
  const { item, def, ghost, pad } = placing;
  ghost.position.set(item.x, def.cat === 'platform' || def.hanging ? 0 : groundY(item.x, item.z), item.z); ghost.rotation.y = item.rot;
  placing.ok = canPlace(item);
  pad.material.color.set(placing.ok ? '#34d399' : '#f87171');
}
function turnPlacing(dir = 1) {
  if (!placing) return;
  placing.item.rot = +(((placing.item.rot + dir * (placing.def.movable ? Math.PI / 4 : Math.PI / 2)) % (Math.PI * 2))).toFixed(4);
  blip(380, 0.04, 'triangle', 0.02); updatePlacing();
}
function endPlacing() {
  placing.ghost.removeFromParent();
  placing.ghost.traverse((o) => { if (o.isMesh) { o.material.dispose(); o.geometry.dispose(); } });
  placing = null; hint(null); renderer.domElement.style.cursor = 'grab'; shopEl.classList.remove('mini');
}
function dropPlacing() {
  if (!placing.ghost.visible) return;
  if (!placing.ok) return blip(200, 0.1, 'sawtooth', 0.02);
  const { item, def, moving } = placing;
  endPlacing();
  item.x = +item.x.toFixed(2); item.z = +item.z.toFixed(2);
  if (!moving) layout.items.push(item);
  if (def.movable) item.home = [item.x, item.z, item.rot];
  const rec = placeItem(item);
  relift(rec?.step);
  layoutChanged();
  blip(140, 0.12, 'sine', 0.08);
  if (!moving && shopEl.hidden === false) renderShop(); // the empty-office tip goes once there's something in it
}
function cancelPlacing() {
  if (!placing) return;
  const { item, moving } = placing;
  endPlacing();
  if (moving) { Object.assign(item, moving); const rec = placeItem(item); relift(rec?.step); layoutChanged({ save: false }); }
}

// ---------------------------------------------------------------- the furniture card
const popEl = document.createElement('div');
popEl.className = 'furn-pop'; popEl.hidden = true; popEl.setAttribute('role', 'dialog'); popEl.setAttribute('aria-label', 'Furniture');
host.appendChild(popEl);
let popRec = null, popAssign = false;
const SEATS_WORK = new Set(['desk', 'executive', 'command']);
function openPop(rec, e) {
  popRec = rec; popAssign = false;
  renderPop();
  const r = host.getBoundingClientRect();
  popEl.hidden = false;
  const w = popEl.offsetWidth, h = popEl.offsetHeight;
  popEl.style.left = `${THREE.MathUtils.clamp(e.clientX - r.left + 14, 12, r.width - w - 12)}px`;
  popEl.style.top = `${THREE.MathUtils.clamp(e.clientY - r.top - 20, 70, r.height - h - 70)}px`;
}
function closePop() { popRec = null; popEl.hidden = true; }
const botName = (id) => (id === STUDIO_ID ? 'Claude' : agents.get(id)?.name || bots.get(id)?.agent.name || 'someone who left');
function renderPop() {
  const { def, item } = popRec, [w, d] = popRec.size;
  const assignable = ASSIGNABLE.has(def.cat), owner = item.owner;
  const crew = [...bots.values()].filter((b) => !b.leaving).map((b) => b.agent).sort((a, b) => a.name.localeCompare(b.name));
  const sizeText = `${+w.toFixed(1)} × ${+d.toFixed(1)} m`;
  popEl.innerHTML = `
    <div class="fp-head"><div><b>${esc(def.name)}</b><span>${esc(CAT_NAME[def.cat])} · ${sizeText}</span></div><button class="close" data-pop="close" aria-label="Close"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" /></svg></button></div>
    ${assignable ? `<div class="fp-owner">${owner ? `<span class="mini-dot" style="--c:${esc(agents.get(owner)?.color || bots.get(owner)?.agent.color || '#a1a1aa')}"></span>Belongs to <b>${esc(botName(owner))}</b>` : `<span class="mini-dot"></span>Shared, anyone can use it`}</div>` : ''}
    ${popAssign ? `<div class="fp-assign">
        <div class="fp-k">${SEATS_WORK.has(def.cat) ? 'Who works here?' : 'Whose spot is this? They work from it and come back to it to unwind.'}</div>
        ${crew.length ? crew.map((a) => `<button data-assign="${esc(a.id)}" class="${owner === a.id ? 'on' : ''}"><span class="mini-dot" style="--c:${esc(a.color)}"></span>${esc(a.name)}<small>${esc(SOURCE[a.source] || a.source || '')}</small></button>`).join('') : '<p class="muted">No one is in the office right now.</p>'}
        ${owner ? '<button data-assign="">Nobody: make it shared</button>' : ''}
      </div>` : ''}
    <div class="fp-actions">
      ${assignable ? `<button data-pop="assign" class="${popAssign ? 'on' : ''}"><svg viewBox="0 0 20 20"><circle cx="10" cy="7" r="3"/><path d="M4 17c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5"/></svg>Assign</button>` : ''}
      <button data-pop="replace"><svg viewBox="0 0 20 20"><path d="M4 7h10l-3-3M16 13H6l3 3"/></svg>Replace</button>
      <button data-pop="move"><svg viewBox="0 0 20 20"><path d="M10 3v14M3 10h14M10 3l-2 2M10 3l2 2M10 17l-2-2M10 17l2-2M3 10l2-2M3 10l2 2M17 10l-2-2M17 10l-2 2"/></svg>Move</button>
      <button data-pop="rotate"><svg viewBox="0 0 20 20"><path d="M15.5 9A5.5 5.5 0 1 0 14 13.5M15.5 4.5V9H11"/></svg>Turn</button>
      <button data-pop="remove" class="danger"><svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2M6 6l.7 10h6.6L14 6"/></svg>Put away</button>
    </div>`;
}
popEl.addEventListener('pointerdown', (e) => e.stopPropagation());
popEl.addEventListener('click', (e) => {
  if (!popRec) return;
  const rec = popRec, it = rec.item;
  const as = e.target.closest('[data-assign]');
  if (as) return assign(it, as.dataset.assign || null);
  const b = e.target.closest('[data-pop]'); if (!b) return;
  const act = b.dataset.pop;
  if (act === 'close') return closePop();
  if (act === 'assign') { popAssign = !popAssign; return renderPop(); }
  if (act === 'replace') { closePop(); return openShop({ replace: it }); }
  if (act === 'move') { closePop(); const from = { x: it.x, z: it.z, rot: it.rot }, gone = unplaceItem(it); relift(gone?.rec.step); layoutChanged({ save: false }); return startPlacing(it, from); }
  if (act === 'rotate') {
    const to = { ...it, rot: +((it.rot + Math.PI / 2) % (Math.PI * 2)).toFixed(4) };
    if (!withoutRec(rec, () => canPlace(to))) return toast('No room to turn it here. Move it somewhere with more space first.');
    it.rot = to.rot; const next = rebuildItem(it); layoutChanged(); popRec = next; blip(380, 0.06, 'triangle', 0.02); return renderPop();
  }
  if (act === 'remove') {
    closePop();
    const gone = unplaceItem(it); layout.items.splice(layout.items.indexOf(it), 1);
    relift(gone?.rec.step); layoutChanged(); blip(260, 0.12, 'triangle', 0.03);
    toast(`${defOf(it).name} put away.`, { undo: () => { layout.items.push(it); const r = placeItem(it); relift(r?.step); layoutChanged(); } });
  }
});
// One place per bot: giving them this takes away whatever they had before.
function assign(item, id) {
  for (const it of layout.items) if (id && it.owner === id) delete it.owner;
  if (id) item.owner = id; else delete item.owner;
  layoutChanged(); blip(900, 0.05, 'sine', 0.03);
  popAssign = false; if (popRec) renderPop();
  if (id) toast(`${CAT_NAME[defOf(item).cat] === 'Desks' || SEATS_WORK.has(defOf(item).cat) ? 'Desk' : 'Spot'} assigned to ${botName(id)}.`);
}

// ---------------------------------------------------------------- the shop
const shopEl = document.getElementById('shop'), shopBtn = document.getElementById('shop-open');
let shopCat = 'desk', shopReplace = null;
function openShop({ replace = null } = {}) {
  shopReplace = replace; if (replace) shopCat = defOf(replace).cat;
  shopEl.hidden = false; shopBtn.setAttribute('aria-expanded', 'true');
  renderShop();
}
function closeShop() { shopEl.hidden = true; shopBtn.setAttribute('aria-expanded', 'false'); shopReplace = null; cancelPlacing(); }
shopBtn.addEventListener('click', () => (shopEl.hidden ? openShop() : closeShop()));
function renderShop() {
  const types = Object.values(CATALOG).filter((t) => t.cat === shopCat);
  const rep = shopReplace, repRec = rep && placed.get(rep.uid);
  let fits = null;
  if (repRec) fits = withoutRec(repRec, () => new Map(types.map((t) => [t.id, t.id === rep.type || canPlace(swapped(rep, t))])));
  document.getElementById('shop-title').textContent = rep ? `Replace ${defOf(rep).name}` : 'Shop';
  document.getElementById('shop-sub').textContent = rep ? `Pick another ${CAT_NAME[shopCat].toLowerCase().replace(/s$/, '').replace(/ & .*/, '')}. It keeps its spot${rep.owner ? ' and its owner' : ''}.`
    : !layout.items.length ? 'Your office is empty. Start with desks, so your agents have somewhere to work.' : 'Pick something, then click the floor to put it down.';
  const tabs = document.getElementById('shop-tabs');
  tabs.hidden = !!rep;
  if (!rep) tabs.innerHTML = CATEGORIES.map(([c, name]) => `<button role="tab" data-cat="${c}" aria-selected="${c === shopCat}">${esc(name)}</button>`).join('');
  document.getElementById('shop-grid').innerHTML = types.map((t) => {
    const cur = rep?.type === t.id, nofit = fits && !fits.get(t.id);
    return `<button class="card ${cur ? 'cur' : ''} ${nofit ? 'nofit' : ''}" data-type="${t.id}" ${nofit ? 'aria-disabled="true"' : ''}>
      <span class="thumb">${thumbs.has(t.id) ? `<img alt="" src="${thumbs.get(t.id)}">` : ''}</span>
      <b>${esc(t.name)}</b><span>${cur ? 'In your office' : nofit ? "Too big for this spot" : `${t.w} × ${t.d} m`}</span></button>`;
  }).join('');
  tabs.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  queueThumbs(types.map((t) => t.id));
}
const swapped = (item, t) => { const o = { ...item, type: t.id }; if (!t.resizable) { delete o.w; delete o.d; } return o; };
document.getElementById('shop-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (b) { shopCat = b.dataset.cat; renderShop(); } });
shopEl.querySelector('[data-shop-close]').addEventListener('click', closeShop);
document.getElementById('shop-grid').addEventListener('click', (e) => {
  const c = e.target.closest('[data-type]'); if (!c) return;
  const t = CATALOG[c.dataset.type];
  if (shopReplace) {
    const it = shopReplace;
    if (c.getAttribute('aria-disabled') === 'true') return blip(200, 0.1, 'sawtooth', 0.02);
    if (t.id === it.type) return closeShop();
    const old = placed.get(it.uid)?.step;
    it.type = t.id; if (!t.resizable) { delete it.w; delete it.d; }
    const rec = rebuildItem(it); relift(old); relift(rec?.step); layoutChanged();
    blip(700, 0.08, 'triangle', 0.03); closeShop();
    return toast(`Swapped in the ${t.name}.`);
  }
  startPlacing({ uid: newUid(), type: t.id, x: RX, z: RZ, rot: 0 });
});

// Shop pictures are real renders of each design, drawn once by a small offscreen renderer.
const thumbs = new Map();
let thumbR = null, thumbQueue = [], thumbTimer = 0;
function queueThumbs(ids) {
  thumbQueue = ids.filter((id) => !thumbs.has(id));
  if (!thumbTimer) thumbTimer = setTimeout(drawThumbs, 30);
}
function drawThumbs() {
  thumbTimer = 0;
  const id = thumbQueue.shift(); if (!id) return;
  try { thumbs.set(id, renderThumb(CATALOG[id])); } catch (err) { thumbs.set(id, ''); console.warn('thumbnail', id, err); }
  const img = document.querySelector(`#shop-grid [data-type="${CSS.escape(id)}"] .thumb`);
  if (img && thumbs.get(id)) img.innerHTML = `<img alt="" src="${thumbs.get(id)}">`;
  if (thumbQueue.length) thumbTimer = setTimeout(drawThumbs, 0);
}
function renderThumb(def) {
  if (!thumbR) {
    thumbR = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbR.setPixelRatio(1); thumbR.setSize(240, 176); thumbR.toneMapping = THREE.ACESFilmicToneMapping; thumbR.setClearColor(0x000000, 0);
  }
  const s = new THREE.Scene();
  s.add(new THREE.HemisphereLight('#ffffff', '#8a7fa6', 1.7));
  const dl = new THREE.DirectionalLight('#fff4e0', 2.4); dl.position.set(4, 9, 6); s.add(dl);
  const g = new THREE.Group(); s.add(g);
  dry = true; try { def.build(g, { uid: 'thumb', type: def.id, x: 0, z: 0, rot: 0, theme: 'ops' }); } finally { dry = false; }
  if (def.hanging) g.position.y = -2.6; // just the lamp, not the whole cord
  const bb = new THREE.Box3().setFromObject(g), c = bb.getCenter(new THREE.Vector3());
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  cam.position.copy(c).add(new THREE.Vector3(1, 0.85, 1).normalize().multiplyScalar(40)); cam.lookAt(c); cam.updateMatrixWorld();
  let L = Infinity, R = -Infinity, B = Infinity, T = -Infinity;
  for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) {
    const p = new THREE.Vector3(x, y, z).applyMatrix4(cam.matrixWorldInverse);
    L = Math.min(L, p.x); R = Math.max(R, p.x); B = Math.min(B, p.y); T = Math.max(T, p.y);
  }
  const aspect = 240 / 176, hw = Math.max((R - L) / 2, ((T - B) / 2) * aspect) * 1.12, mx = (L + R) / 2, my = (T + B) / 2;
  Object.assign(cam, { left: mx - hw, right: mx + hw, top: my + hw / aspect, bottom: my - hw / aspect }); cam.updateProjectionMatrix();
  thumbR.render(s, cam);
  const url = thumbR.domElement.toDataURL('image/png');
  g.traverse((o) => o.geometry?.dispose());
  return url;
}

// ---------------------------------------------------------------- hints & toasts
const hintEl = document.createElement('div'); hintEl.className = 'place-hint'; hintEl.hidden = true; host.appendChild(hintEl);
function hint(html) { hintEl.hidden = !html; if (html) hintEl.innerHTML = html; }
const toastEl = document.createElement('div'); toastEl.className = 'toast'; toastEl.hidden = true; host.appendChild(toastEl);
let toastTimer = 0, toastUndo = null;
function toast(text, { undo = null } = {}) {
  toastUndo = undo;
  toastEl.innerHTML = `<span>${esc(text)}</span>${undo ? '<button data-undo>Undo</button>' : ''}`;
  toastEl.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toastEl.hidden = true), undo ? 6000 : 3200);
}
toastEl.addEventListener('click', (e) => { if (e.target.closest('[data-undo]') && toastUndo) { toastUndo(); toastUndo = null; toastEl.hidden = true; } });

// "Tidy up" in settings: every lamp back on and every chair back where it belongs.
function tidyUp() {
  for (const t of toys) if (t.kind === 'lamp') { t.on = true; if (t.rec) t.rec.item.on = true; }
  for (const rec of [...placed.values()]) {
    const h = rec.item.home;
    if (rec.def.movable && h && (h[0] !== rec.item.x || h[1] !== rec.item.z || h[2] !== rec.item.rot)) { [rec.item.x, rec.item.z, rec.item.rot] = h; rebuildItem(rec.item); }
  }
  layoutChanged();
}
document.getElementById('tidy').addEventListener('click', tidyUp);

// ============================================================== data

const agents = new Map();
let feed = [];
let selectedId = null;

const api = (route, body) => fetch(route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': TOKEN }, body: JSON.stringify(body) });
const reportVisibility = () => api('/api/presence', { client: CLIENT_ID, visible: document.visibilityState === 'visible' }).catch(() => {});
document.addEventListener('visibilitychange', reportVisibility);

function connect() {
  const conn = document.getElementById('conn');
  const es = new EventSource(`/api/stream?client=${CLIENT_ID}&visible=${document.visibilityState === 'visible' ? 1 : 0}`);
  es.addEventListener('open', () => { conn.classList.add('live'); conn.lastChild.textContent = 'Live'; });
  es.addEventListener('error', () => { conn.classList.remove('live'); conn.lastChild.textContent = 'Reconnecting'; });
  es.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    for (const id of [...agents.keys()]) { agents.delete(id); removeBot(id); }
    data.agents.forEach(upsert);
    refreshStudio();
    for (const bot of bots.values()) if (bot.goal) { bot.root.position.copy(bot.goal); bot.path = []; } // already in place on load
    feed = data.feed.reverse();
    usage = data.usage; drawUsage();
    renderAll();
  });
  es.addEventListener('usage', (e) => { usage = JSON.parse(e.data); drawUsage(); });
  es.addEventListener('agent', (e) => { upsert(JSON.parse(e.data)); renderAll(); });
  es.addEventListener('remove', (e) => { const { id } = JSON.parse(e.data); agents.delete(id); removeBot(id); if (id.startsWith('claude:')) refreshStudio(); if (selectedId === id) selectedId = null; renderAll(); });
  es.addEventListener('feed', (e) => { feed.unshift(JSON.parse(e.data)); feed = feed.slice(0, 80); renderFeed(); });
}

const privateViews = new Map();
function refreshPrivate(a) {
  if (!a?.private) return;
  const prev = privateViews.get(a.id);
  if (prev && prev.updatedAt === a.updatedAt) return;
  privateViews.set(a.id, { updatedAt: a.updatedAt, detail: prev?.detail || null });
  fetch(`/api/private/${encodeURIComponent(a.id)}`, { headers: { 'x-office-token': TOKEN } })
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => {
      if (!body?.detail) return;
      privateViews.set(a.id, { updatedAt: a.updatedAt, detail: body.detail });
      if (selectedId === a.id) renderDetail();
    })
    .catch(() => {});
}

function upsert(a) {
  const prev = agents.get(a.id);
  agents.set(a.id, a);
  if (a.private) refreshPrivate(a);
  if (a.source === 'claude') refreshStudio(); else updateBot(a);
  if (a.status === 'needs_you' && prev && prev.status !== 'needs_you') notify(a);
}

// ============================================================== Claude Studio
// Claude Code sessions don't each get a body. One Claude sits at the command desk; the chats that
// are on the floor (the server's `away` flag, capped at claude.maxOnFloor) are panels on its
// monitor, and the rest are the paper stack in its inbox tray.

const STUDIO_ID = 'claude:studio';
const claudeSessions = () => [...agents.values()].filter((a) => a.source === 'claude');
let screenOrder = []; // keeps each chat's panel in the same place while it's open

function studioAgent() {
  const all = claudeSessions(), live = all.filter((a) => !a.away);
  const need = live.filter((a) => a.status === 'needs_you');
  const busy = live.filter((a) => STATUS[a.status]?.busy).sort((a, b) => b.updatedAt - a.updatedAt);
  const status = need.length ? 'needs_you' : live.some((a) => a.status === 'error') ? 'error' : busy[0]?.status || (live.some((a) => a.status === 'done') ? 'done' : 'idle');
  const pending = need.length === 1 ? need[0].pending || { kind: 'approval', title: 'Needs you', detail: need[0].activity }
    : need.length ? { kind: 'approval', title: 'Needs you', detail: `${need.length} chats need you` } : null;
  const activity = need.length ? pending.detail : busy.length > 1 ? `Working on ${busy.length} chats` : busy[0]?.activity || (live.length ? 'Waiting for your next prompt' : 'No chats open');
  const latest = Math.max(0, ...all.map((a) => a.updatedAt || 0));
  return { id: STUDIO_ID, source: 'claude', name: 'Claude', role: `${live.length} on screen`, color: '#D97757', status, pending, activity, live: live.length, resting: all.length - live.length, since: latest, updatedAt: latest, lastAt: latest, log: [] };
}

function refreshStudio() {
  const sa = studioAgent();
  updateBot(sa);
  const live = new Set(claudeSessions().filter((a) => !a.away).map((a) => a.id));
  screenOrder = screenOrder.filter((id) => live.has(id));
  for (const id of live) if (!screenOrder.includes(id)) screenOrder.push(id);
  const d = desks.find((x) => x.studio);
  if (d) {
    d.glow.color.set(st(sa.status).color); d.glow.intensity = sa.live ? 2.4 : 0.6;
  }
  drawStudioScreen();
}

// Each chat's panel shows what kind of thing it's doing, not what it's about: scrolling code,
// a terminal, a web page, thinking dots, a check when it's done, a flashing "!" when it needs you.
const CODE_INK = ['#60A5FA', '#A78BFA', '#F472B6', '#34D399', '#e2e8f0', '#FBBF24'];
function drawStudioScreen() {
  const c = STUDIO_TEX.image, g = c.getContext('2d'), W = c.width, H = c.height, t = performance.now() / 1000;
  g.fillStyle = '#14121e'; g.fillRect(0, 0, W, H);
  const list = screenOrder.map((id) => agents.get(id)).filter(Boolean);
  if (!list.length) { // nothing running: one idle tab with a slowly turning spark
    drawPanel(g, 20, 20, W - 40, H - 40, { id: 'idle', status: 'idle' }, t, 0, true);
  } else {
    const n = list.length, m = 20, gap = 16, tw = (W - m * 2 - gap * (n - 1)) / n;
    list.forEach((a, i) => drawPanel(g, m + i * (tw + gap), m, tw, H - m * 2, a, t, hashOf(a.id)));
  }
  STUDIO_TEX.needsUpdate = true;
}

function drawPanel(g, x, y, w, h, a, t, seed, resting = false) {
  const s = st(a.status), col = s.color, k = a.status;
  g.save(); g.beginPath(); g.roundRect(x, y, w, h, 14); g.clip();
  g.fillStyle = k === 'needs_you' ? `rgba(251,146,60,${0.18 + Math.max(0, Math.sin(t * 5)) * 0.25})` : '#2a2640'; g.fillRect(x, y, w, h);
  g.globalAlpha = ['idle', 'offline'].includes(k) ? 0.6 : 1;
  g.fillStyle = col; g.fillRect(x, y, w, 30);
  g.fillStyle = 'rgba(0,0,0,0.3)'; for (let d = 0; d < 3; d++) { g.beginPath(); g.arc(x + 18 + d * 16, y + 15, 5, 0, Math.PI * 2); g.fill(); }
  g.font = '700 19px Kripa, system-ui'; g.fillStyle = '#16141f'; g.textAlign = 'right'; g.fillText(s.label, x + w - 14, y + 22); g.textAlign = 'left';
  const cx = x + 18, cy = y + 48, cw = w - 36, ch = h - 60, mx = x + w / 2, my = cy + ch / 2;
  const bar = (bx, by, bw, c, bh = 12) => { g.fillStyle = c; g.beginPath(); g.roundRect(bx, by, Math.max(bh, bw), bh, bh / 2); g.fill(); };
  const rnd = (i) => ((Math.sin(seed * 0.001 + i * 12.9898) * 43758.5453) % 1 + 1) % 1; // stable per chat and line
  if (k === 'coding' || k === 'terminal' || k === 'reading') {
    const lh = 24, scroll = k === 'reading' ? 0 : t * (k === 'terminal' ? 10 : 16), first = Math.floor(scroll / lh);
    for (let L = 0; L < Math.ceil(ch / lh) + 1; L++) {
      const i = first + L, ly = cy + L * lh - (scroll % lh);
      if (k === 'terminal') { bar(cx, ly, 12, '#A3E635'); bar(cx + 22, ly, rnd(i) * cw * 0.7, 'rgba(226,232,240,0.55)'); }
      else if (k === 'reading') bar(cx, ly, cw * (0.55 + rnd(i) * 0.45), i === Math.floor(t * 1.5) % 7 ? col : 'rgba(226,232,240,0.35)');
      else { const ind = Math.floor(rnd(i) * 3) * 26, w1 = 30 + rnd(i + 0.5) * cw * 0.3; bar(cx + ind, ly, w1, CODE_INK[Math.floor(rnd(i + 0.2) * 6)]); bar(cx + ind + w1 + 10, ly, rnd(i + 0.7) * cw * 0.35, 'rgba(226,232,240,0.4)'); }
    }
    if (k === 'terminal' && Math.sin(t * 6) > 0) { g.fillStyle = '#A3E635'; g.fillRect(cx, cy + ch - 18, 12, 18); }
  } else if (k === 'browsing') {
    bar(cx, cy, cw, 'rgba(226,232,240,0.18)', 20);
    g.fillStyle = col; g.globalAlpha = 0.5; g.fillRect(cx, cy + 32, cw * 0.45, ch - 40); g.globalAlpha = 1;
    for (let i = 0; i < 6; i++) bar(cx + cw * 0.5, cy + 36 + i * 26, cw * (0.25 + rnd(i) * 0.25), 'rgba(226,232,240,0.4)');
    g.fillStyle = '#fff'; g.beginPath(); g.arc(cx + cw * 0.2 + Math.sin(t * 1.3) * cw * 0.15, cy + 70 + Math.cos(t * 0.9) * 40, 6, 0, Math.PI * 2); g.fill();
  } else if (STATUS[k]?.busy) { // thinking, working, delegating
    for (let d = 0; d < 3; d++) { g.fillStyle = col; g.globalAlpha = 0.35 + 0.65 * Math.max(0, Math.sin(t * 4 - d * 0.7)); g.beginPath(); g.arc(mx - 34 + d * 34, my, 11, 0, Math.PI * 2); g.fill(); }
  } else {
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 12; g.lineCap = 'round'; g.lineJoin = 'round'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const r = Math.min(46, ch / 2 - 8);
    if (k === 'needs_you') { g.beginPath(); g.arc(mx, my, r, 0, Math.PI * 2); g.fill(); g.fillStyle = '#1a0e06'; g.font = `700 ${r * 1.5 | 0}px Kripa, system-ui`; g.fillText('!', mx, my + 3); }
    else if (k === 'done') { g.beginPath(); g.moveTo(mx - r * 0.7, my); g.lineTo(mx - r * 0.15, my + r * 0.55); g.lineTo(mx + r * 0.8, my - r * 0.5); g.stroke(); }
    else if (k === 'error') { g.beginPath(); g.moveTo(mx - r * 0.5, my - r * 0.5); g.lineTo(mx + r * 0.5, my + r * 0.5); g.moveTo(mx + r * 0.5, my - r * 0.5); g.lineTo(mx - r * 0.5, my + r * 0.5); g.stroke(); }
    else if (resting) {
      g.save(); g.translate(mx - 130, my); g.rotate(t * 0.3); g.strokeStyle = '#d97757'; g.lineWidth = 14; g.globalAlpha = 0.8;
      for (let i = 0; i < 6; i++) { g.rotate(Math.PI / 3); g.beginPath(); g.moveTo(0, 10); g.lineTo(0, 52); g.stroke(); }
      g.restore();
      g.globalAlpha = 0.75; g.textAlign = 'left'; g.font = '600 34px Kripa, system-ui'; g.fillText('All caught up', mx - 50, my + 2);
    } else { g.globalAlpha = 0.6; g.font = '600 26px Kripa, system-ui'; g.fillText('waiting', mx, my); }
  }
  g.restore();
}

// Clicking Claude lists the chats on its monitor. Resting ones stay hidden until they wake up.
function renderStudioDetail(el) {
  const sa = studioAgent(), all = claudeSessions();
  el.hidden = false;
  const row = (a) => `<button class="row ${a.status === 'needs_you' ? 'hot' : ''} ${a.away ? 'away' : ''}" data-id="${esc(a.id)}">${mini(a)}<div><span class="name">${esc(a.role || a.name)}</span><span class="role">updated ${ago(a.updatedAt)}</span></div>${a.away ? '' : pill(a.status)}<div class="act">${esc(a.pending?.detail || a.activity)}</div></button>`;
  const live = all.filter((a) => !a.away).sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  el.innerHTML = `
    <button class="back" data-back title="Back to activity (Esc)">← Activity</button>
    <div class="detail-top">${mini(sa)}<div><h3>Claude</h3><div class="meta">${sa.live ? `${sa.live} on screen` : 'All quiet'}</div></div>${pill(sa.status)}</div>
    <div class="k">Right now</div><div class="now">${esc(sa.activity)}</div>
    ${live.length ? `<div class="k">On the monitor</div><div class="chats">${live.map(row).join('')}</div>` : ''}`;
}

// ============================================================== panel

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (ts) => { const s = Math.max(0, (Date.now() - ts) / 1000 | 0); return s < 60 ? `${s}s ago` : s < 3600 ? `${s / 60 | 0}m ago` : `${s / 3600 | 0}h ago`; };
const clockTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const pill = (s) => `<span class="pill ${s === 'needs_you' ? 'alarm' : ''}" style="--c:${st(s).color}"><i class="dot"></i>${st(s).label}</span>`;
const mini = (a) => `<span class="mini ${a.status === 'offline' ? 'off' : ''} ${a.source === 'claude' ? 'claude' : 'grok'}" data-shape="${esc(a.shape || 'blob')}" style="--c:${a.color}"></span>`;
const SOURCE = { grok: 'Grok Bot', claude: 'Claude Code', demo: 'Demo', roster: 'Office', ledger: 'Ledger' };
const reportsWho = (a) => a?.reportsTo ? (a.reportsToName || a.reportsTo) : '';
const ORDER = { needs_you: 0, error: 1 };
const rank = (a) => ORDER[a.status] ?? (STATUS[a.status]?.busy ? 2 : 3);
const sortAgents = (list) => list.sort((a, b) => !!b.primary - !!a.primary || rank(a) - rank(b) || a.name.localeCompare(b.name)); // the boss heads its group

// A burst of agent events (one per tool call) used to rebuild the whole panel each time; now
// they coalesce into one rebuild. A timer rather than rAF so the tab title still updates when hidden.
let renderQueued = false;
function renderAll() { if (!renderQueued) { renderQueued = true; setTimeout(renderNow, 40); } }
function renderNow() { renderQueued = false; drawBossSign([...agents.values()].find((a) => a.primary && a.source === 'grok')?.name || ''); renderChips(); renderTeam(); renderDetail(); renderFeed(); updateTitle(); bots.forEach((b) => b.tagEl.classList.toggle('selected', b.id === selectedId)); }

function renderChips() {
  const all = [...agents.values()].filter((a) => !a.away);
  const n = (f) => all.filter(f).length;
  const working = n((a) => STATUS[a.status]?.busy), need = n((a) => a.status === 'needs_you'), idle = n((a) => ['idle', 'done'].includes(a.status)), off = n((a) => a.status === 'offline');
  const free = desks.filter((d) => !d.studio && !d.boss && !d.agentId && !d.item.owner).length;
  document.getElementById('chips').innerHTML =
    `<span class="chip"><b>${working}</b>working</span>` +
    `<span class="chip ${need ? 'hot' : ''}"><b>${need}</b>${need ? 'needs you' : 'need you'}</span>` +
    `<span class="chip"><b>${idle}</b>idle</span>` +
    (off ? `<span class="chip"><b>${off}</b>offline</span>` : '') +
    `<span class="chip"><b>${free}</b>free desks</span>`;
}

// The team sidebar on the left: one card per agent, grouped by where it runs. Resting Claude
// sessions aren't listed; they reappear the moment you send them something.
function renderTeam() {
  const el = document.getElementById('team');
  const all = [...agents.values()].filter((a) => !a.away);
  document.getElementById('dock-count').textContent = all.length ? `${all.length} in the office` : '';
  if (!all.length) { el.innerHTML = `<div class="empty">No agents yet. Open the Grok Bot app or start a Claude Code session and they'll walk in.</div>`; return; }
  const groups = [['Office', all.filter((a) => a.source === 'roster' || a.source === 'ledger')], ['Grok Bots', all.filter((a) => a.source === 'grok')], ['Claude', all.filter((a) => a.source === 'claude')], ['Demo', all.filter((a) => a.source === 'demo')], ['Other', all.filter((a) => !['grok', 'claude', 'demo', 'roster', 'ledger'].includes(a.source))]];
  // Status shows as the ring round the avatar (spinning while busy, pulsing when it needs you) plus one quiet word.
  const row = (a) => {
    const s = a.away ? 'offline' : a.status, busy = STATUS[s]?.busy;
    return `
      <button class="row ${a.id === selectedId ? 'sel' : ''} ${s === 'needs_you' ? 'hot' : ''} ${a.away ? 'away' : ''}" data-id="${esc(a.id)}" style="--s:${st(s).color}">
        <span class="ava ${busy ? 'busy' : esc(s)}">${mini(a)}</span>
        <div><span class="name">${esc(a.name)}${a.primary ? '<span class="boss">Boss</span>' : ''}${a.unread ? `<span class="unread">${a.unread}</span>` : ''}</span><span class="role">${esc(a.role)}${a.reportsTo ? ` · reports to ${esc(reportsWho(a))}` : ''}</span></div>
        <span class="state ${busy || s === 'needs_you' || s === 'error' ? '' : 'quiet'} ${s === 'needs_you' ? 'alarm' : ''}">${a.away ? 'Resting' : st(s).label}</span>
      </button>`;
  };
  const scroll = el.scrollTop;
  el.innerHTML = groups.filter(([, l]) => l.length).map(([label, list]) => `<div class="group-label">${label} · ${list.length}</div>` + sortAgents(list).map(row).join('')).join('');
  el.scrollTop = scroll; // rebuilding the list shouldn't throw you back to the top
}

const teamEl = document.getElementById('team');
teamEl.addEventListener('click', (e) => {
  const r = e.target.closest('.row'); if (!r) return;
  select(r.dataset.id === selectedId ? null : r.dataset.id);
  const a = agents.get(selectedId), bot = bots.get(a?.source === 'claude' ? STUDIO_ID : selectedId);
  if (bot && !bot.leaving) glideTo(bot.root.position);
});
document.addEventListener('keydown', (e) => {
  if (settingsDlg.open || document.getElementById('welcome').open || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea')) return;
  if (placing) { if (e.key === 'Escape') return cancelPlacing(); if (e.key.toLowerCase() === 'r') return turnPlacing(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape' && !popEl.hidden) return closePop();
  if (e.key === 'Escape' && !shopEl.hidden) return closeShop();
  if (e.key === '[') return setSide('left');
  if (e.key === ']') return setSide('right');
  if (e.key === 'Escape' && closeUp) return leaveBoard();
  if (e.key === 'Escape' && selectedId) select(null);
  const k = e.key.toLowerCase();
  if (k in PAN_KEYS) { e.preventDefault(); held.add(k); return; }
  if (k === 'r') return goHome();
  if (k === '+' || k === '=') return zoomBy(1.4);
  if (k === '-' || k === '_') return zoomBy(1 / 1.4);
});

// ============================================================== sidebars
// Either sidebar folds away from its button in the top bar (or [ and ]); the choice sticks across reloads.

const SIDES = { left: { el: 'dock', btn: 'left-toggle', name: 'team', key: '[' }, right: { el: 'panel', btn: 'right-toggle', name: 'activity', key: ']' } };
const stacked = matchMedia('(max-width: 900px)');
function setSide(side, open = document.documentElement.dataset[side] === 'off') {
  const s = SIDES[side], root = document.documentElement;
  root.dataset[side] = open ? 'on' : 'off';
  try { localStorage.setItem(`office-${side}`, root.dataset[side]); } catch {}
  const btn = document.getElementById(s.btn);
  btn.setAttribute('aria-expanded', open);
  btn.title = `${open ? 'Hide' : 'Show'} ${s.name} ( ${s.key} )`;
  // Everything but the toggle goes inert while folded, so the rail's button still opens it. Stacked on a phone, both always show.
  for (const c of document.getElementById(s.el).children) if (c !== btn) c.inert = !open && !stacked.matches;
}
for (const side in SIDES) {
  document.getElementById(SIDES[side].btn).addEventListener('click', () => setSide(side));
  setSide(side, document.documentElement.dataset[side] !== 'off');
}
stacked.addEventListener('change', () => { for (const side in SIDES) setSide(side, document.documentElement.dataset[side] !== 'off'); });

// Selecting from the office or a notification brings that agent's card into view in the team list.
function select(id) {
  selectedId = id || null; renderAll();
  if (!selectedId) return;
  setSide('right', true); // the details live in the right sidebar, so bring it back if it was tucked away
  // Stacked on a phone, the details sit below the team list, so jump down to them instead.
  if (matchMedia('(max-width: 900px)').matches) setTimeout(() => document.getElementById('panel').scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  else setTimeout(() => teamEl.querySelector(`.row[data-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
}

function privateBlock(detail) {
  if (!detail) return 'Private feed is loading for this office.';
  const tasks = Array.isArray(detail.tasks) ? detail.tasks : (detail.task ? [detail.task] : []);
  const lines = [];
  if (typeof detail.activity === 'string' && detail.activity) lines.push(`<div class="now">${esc(detail.activity)}</div>`);
  for (const t of tasks) {
    if (!t?.title) continue;
    lines.push(`<div class="task">${esc(t.title)}${t.status ? ` · ${esc(t.status)}` : ''}${t.owner ? ` · owner ${esc(t.owner)}` : ''}</div>`);
  }
  if (detail.pending?.detail) lines.push(`<div class="now">${esc(detail.pending.detail)}</div>`);
  return lines.join('') || 'No private task is recorded.';
}

function renderDetail() {
  // The right sidebar shows the activity feed, or the selected agent's details and history in its place.
  const el = document.getElementById('detail');
  const studio = selectedId === STUDIO_ID, a = agents.get(selectedId);
  document.getElementById('activity').hidden = !!a || studio;
  document.getElementById('panel-title').textContent = a || studio ? 'Agent' : 'Activity';
  if (studio) return renderStudioDetail(el);
  if (!a) { el.hidden = true; return; }
  el.hidden = false;
  const p = a.pending;
  el.innerHTML = `
    ${a.source === 'claude' ? `<button class="back" data-id="${STUDIO_ID}">← All Claude chats</button>` : '<button class="back" data-back title="Back to activity (Esc)">← Activity</button>'}
    <div class="detail-top">${mini(a)}<div><h3>${esc(a.name)}</h3><div class="meta">${esc(a.role)} · updated ${ago(a.updatedAt)}</div></div>${pill(a.status)}</div>
    <div class="facts">
      <div><span>Runs in</span><b>${esc(SOURCE[a.source] || a.source || '—')}</b></div>
      <div><span>${esc(st(a.status).label)} for</span><b>${ago(a.since).replace(' ago', '')}</b></div>
      <div><span>Last active</span><b>${a.activeAt ? ago(a.activeAt) : '—'}</b></div>
      <div><span>Events</span><b>${a.log.length}</b></div>
    </div>
    ${a.reportsTo ? `<div class="k">Reports to</div><div class="now">${esc(reportsWho(a))}</div>` : ''}
    ${Array.isArray(a.tasks) && a.tasks.length ? `<div class="k">Tasks</div>${a.tasks.map((t) => `<div class="task">${esc(t.title)}${t.status ? ` · ${esc(t.status)}` : ''}${t.owner ? ` · owner ${esc(t.owner)}` : ''}</div>`).join('')}` : (a.task?.title ? `<div class="k">Task</div><div class="task">${esc(a.task.title)}${a.task.owner ? ` · owner ${esc(a.task.owner)}` : ''}${a.task.status ? ` · ${esc(a.task.status)}` : ''}</div>` : '')}
    ${a.private ? `<div class="k">Private</div><div class="now">${privateBlock(privateViews.get(a.id)?.detail)}</div>` : ''}
    <div class="k">Right now</div><div class="now">${esc(a.activity)} <span class="muted">· for ${ago(a.since).replace(' ago', '')}</span></div>
    ${p ? `<div class="ask"><b>${esc(p.title)}</b><p>${esc(p.detail)}</p></div>
      ${p.canResolve ? `<div class="actions"><button class="btn primary" data-decide="allow">Approve</button><button class="btn" data-decide="deny">Decline</button><button class="btn ghost" data-dismiss title="Clear this without answering">Dismiss</button></div><div class="hint">${esc(a.name)} is waiting on this. Your answer goes straight back to it.</div>`
        : a.source === 'grok' ? `${p.options?.length ? `<div class="opts">${p.options.map((o) => `<span>${esc(o)}</span>`).join('')}</div>` : ''}<div class="actions"><a class="btn primary" href="grokbot://">Open Grok Bot</a><button class="btn ghost" data-dismiss title="Clear this without answering">Dismiss</button></div><div class="hint">Reply to ${esc(a.name)} in the Grok Bot app. The office updates as soon as you do.</div>`
        : `<div class="actions"><button class="btn ghost" data-dismiss title="Clear this without answering">Dismiss</button></div><div class="hint">${a.source === 'claude' ? 'Answer this in the Claude Code terminal, or dismiss it if it needs nothing from you.' : 'Answer it where the agent runs, or dismiss it if it needs nothing from you.'}</div>`}` : ''}
    ${a.cwd ? `<div class="k">Folder</div><div class="now" style="font-size:12px">${esc(a.cwd)}</div>` : ''}
    <div class="k">History</div>
    <ol class="timeline">${[...a.log].reverse().map((l) => `<li><time>${clockTime(l.ts)}</time><i class="dot" style="background:${st(l.status).color}"></i><span>${esc(l.text)}</span></li>`).join('') || '<li><span></span><span></span><span class="muted">Nothing yet</span></li>'}</ol>`;
}
document.getElementById('detail').addEventListener('click', async (e) => {
  if (e.target.closest('[data-back]')) return select(null);
  const r = e.target.closest('[data-id]');
  if (r) return select(r.dataset.id);
  const a = agents.get(selectedId);
  if (!a?.pending) return;
  const d = e.target.closest('[data-dismiss]');
  if (d) { d.disabled = true; return api('/api/dismiss', { agentId: a.id }).catch(() => {}); }
  const b = e.target.closest('[data-decide]');
  if (!b) return;
  b.disabled = true;
  await api('/api/decision', { id: a.pending.id, decision: b.dataset.decide }).catch(() => {});
});

function renderFeed() {
  document.getElementById('feed').innerHTML = feed.slice(0, 40).map((f) => `<li ${agents.has(f.agentId) ? `data-id="${esc(f.agentId)}" class="link"` : ''}><time>${clockTime(f.ts)}</time><i class="dot" style="background:${st(f.status).color}"></i><span><b>${esc(f.name)}</b> ${esc(f.text || st(f.status).label)}</span></li>`).join('') || '<li class="empty" style="display:block">Quiet so far.</li>';
}

document.getElementById('feed').addEventListener('click', (e) => { const r = e.target.closest('[data-id]'); if (r) select(r.dataset.id); });

function updateTitle() {
  const n = [...agents.values()].filter((a) => a.status === 'needs_you').length;
  document.title = n ? `(${n}) Head Office` : 'Head Office';
}

document.getElementById('legend').innerHTML = ['coding', 'browsing', 'terminal', 'thinking', 'needs_you', 'error', 'done', 'idle'].map((s) => `<span><i class="dot" style="background:${st(s).color}"></i>${st(s).label}</span>`).join('');

// ============================================================== alerts

let alertsOn = false;
const alertsBtn = document.getElementById('alerts');
alertsBtn.addEventListener('click', async () => {
  if (!alertsOn && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  alertsOn = !alertsOn;
  alertsBtn.setAttribute('aria-checked', alertsOn);
});

// ============================================================== settings
// Lighting, appearance and alerts live in one dialog off the top bar.

const settingsDlg = document.getElementById('settings');
document.getElementById('settings-open').addEventListener('click', () => { closePop(); cancelPlacing(); updateOfficeDesc(); settingsDlg.showModal(); });
settingsDlg.addEventListener('click', (e) => {
  const r = settingsDlg.getBoundingClientRect(); // a click on the backdrop lands on the dialog itself, outside its box
  const outside = e.target === settingsDlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
  if (outside || e.target.closest('[data-close]')) settingsDlg.close();
});
let audio;
function notify(a) {
  if (!alertsOn) return;
  try {
    audio ||= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.setValueAtTime(880, audio.currentTime); o.frequency.setValueAtTime(1320, audio.currentTime + 0.12);
    g.gain.setValueAtTime(0.08, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.4);
    o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.4);
  } catch {}
  if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(`${a.name} needs you`, { body: a.pending?.detail || a.activity, tag: a.id });
    n.onclick = () => { window.focus(); select(a.id); };
  }
}

// ============================================================== welcome: pick an office
// The first time the office opens there's no floor plan yet, so it asks two things: how big, and
// whether to move into a furnished office or start from an empty room and fill it from the shop.
// Settings → "Start over" asks again (and replaces the office you have).

function onboarding({ redo = false } = {}) {
  const dlg = document.getElementById('welcome');
  let size = layout?.size || 'standard', furnished = true, step = 1;
  const plan = (s, max = 128) => { // a little floor plan, drawn to scale against the biggest office
    const k = max / SIZES.large.w, w = s.w * k, h = s.d * k;
    return `<svg viewBox="0 0 ${max} ${SIZES.large.d * k}" aria-hidden="true"><rect x="${(max - w) / 2}" y="${(SIZES.large.d * k - h) / 2}" width="${w}" height="${h}" rx="3"/><path d="M${(max - w) / 2} ${(SIZES.large.d * k - h) / 2 + 3}v${h - 6}M${(max - w) / 2 + 3} ${(SIZES.large.d * k - h) / 2}h${w - 6}" class="wall"/></svg>`;
  };
  const render = () => {
    dlg.innerHTML = `<form method="dialog" class="welcome-body">
      <div class="welcome-step">Step ${step} of 2</div>
      ${step === 1 ? `
        <h2>${redo ? 'Start a new office' : 'Welcome to Head Office'}</h2>
        <p>Where your agents will work. First, how much room do they get?</p>
        <div class="choices sizes">${Object.entries(SIZES).map(([id, s]) => `
          <button type="button" class="choice ${size === id ? 'on' : ''}" data-size="${id}">
            ${plan(s)}<b>${s.name}</b><span class="dims">${s.w} × ${s.d} m · ${s.w * s.d} m²</span><span>${s.blurb}. About ${s.desks} desks when furnished.</span>
          </button>`).join('')}</div>`
      : `
        <h2>How do you want to move in?</h2>
        <p>${SIZES[size].name}, ${SIZES[size].w} × ${SIZES[size].d} m. You can swap, move or add anything later from the shop.</p>
        <div class="choices starts">
          <button type="button" class="choice ${furnished ? 'on' : ''}" data-furnished="1">
            <svg viewBox="0 0 120 70" aria-hidden="true"><rect x="4" y="4" width="112" height="62" rx="4"/><rect x="14" y="14" width="16" height="9" rx="2" class="f"/><rect x="36" y="14" width="16" height="9" rx="2" class="f"/><rect x="14" y="32" width="16" height="9" rx="2" class="f"/><rect x="36" y="32" width="16" height="9" rx="2" class="f"/><rect x="70" y="12" width="36" height="14" rx="7" class="c"/><rect x="72" y="44" width="30" height="10" rx="5" class="s"/><circle cx="64" cy="52" r="5" class="p"/></svg>
            <b>Move-in ready</b><span>Desks, a lounge, a kitchen, the boss's office and Claude's studio, all set up.</span>
          </button>
          <button type="button" class="choice ${furnished ? '' : 'on'}" data-furnished="0">
            <svg viewBox="0 0 120 70" aria-hidden="true"><rect x="4" y="4" width="112" height="62" rx="4"/><path d="M52 35h16M60 27v16" class="plus"/></svg>
            <b>Start from scratch</b><span>An empty room. Furnish it from the shop and arrange it your way.</span>
          </button>
        </div>
        ${redo ? '<p class="warn">This replaces your current office and everything in it.</p>' : ''}`}
      <div class="welcome-foot">
        ${step === 2 ? '<button type="button" class="btn ghost" data-back>Back</button>' : redo ? '<button type="button" class="btn ghost" data-cancel>Cancel</button>' : '<span></span>'}
        <button type="button" class="btn primary" data-next>${step === 1 ? 'Continue' : redo ? 'Replace my office' : 'Open the office'}</button>
      </div></form>`;
  };
  return new Promise((resolve) => {
    render();
    dlg.oncancel = (e) => { e.preventDefault(); if (redo) { dlg.close(); resolve(null); } };
    dlg.onclick = (e) => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.size) { size = t.dataset.size; return render(); }
      if (t.dataset.furnished) { furnished = t.dataset.furnished === '1'; return render(); }
      if ('back' in t.dataset) { step = 1; return render(); }
      if ('cancel' in t.dataset) { dlg.close(); return resolve(null); }
      if ('next' in t.dataset) { if (step === 1) { step = 2; return render(); } dlg.close(); resolve({ size, furnished }); }
    };
    dlg.showModal();
  });
}

function updateOfficeDesc() {
  const s = SIZES[layout.size] || { name: 'Office', w: layout.w, d: layout.d };
  const n = layout.items.length, nd = desks.filter((d) => !d.studio && !d.boss).length;
  document.getElementById('office-desc').textContent = `${s.name}, ${layout.w} × ${layout.d} m. ${n} piece${n === 1 ? '' : 's'} of furniture, ${nd} desk${nd === 1 ? '' : 's'}.`;
}
document.getElementById('redesign').addEventListener('click', async () => {
  settingsDlg.close();
  const pick = await onboarding({ redo: true });
  if (!pick) return;
  clearTimeout(saveTimer);
  await api('/api/layout', makeLayout(pick.size, pick.furnished)).catch(() => {});
  location.reload();
});

// ============================================================== go

build(harvest(scene), scene); // the room itself, before the furniture (its own layer) and bots (animated) move in
for (const it of layout.items) if (defOf(it)?.movable) it.home ||= [it.x, it.z, it.rot]; // where "Tidy up" puts chairs back
for (const it of [...layout.items].sort((a, b) => (defOf(b)?.cat === 'platform') - (defOf(a)?.cat === 'platform'))) placeItem(it); // platforms first: they lift what stands on them
rebuildFurnLayer();
layoutChanged({ save: firstRun });
controls.addEventListener('start', closePop); // the card is pinned to the screen, so it goes when the view moves
if (!layout.items.length) openShop(); // an empty room: straight to the shop
resize(true);
connect();
setInterval(renderDetail, 5000);
setInterval(wanderTick, 1000);
setInterval(drawStudioScreen, 200);
animate();

// Debug handle for checking walkable cells from the console: __office.blocked, __office.findPath
window.__office = { focusBoard, leaveBoard, camera, blocked, cellOf, isBlocked, findPath, bots, desks, get LOUNGE() { return LOUNGE; }, get SPOTS() { return SPOTS; }, DOOR, renderer, scene, composer, controls, toys, placed, layout, CATALOG, canPlace, startPlacing, openShop };
