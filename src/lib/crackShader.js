import * as THREE from 'three'

/**
 * Procedural crack-and-amber shader for the underground fill plane.
 *
 * The plane sits behind the building at y < 0 and normally shows a
 * topsoil → deep-earth gradient. While the Crack cinematic plays we
 * raise `uProgress` from 0 → 1: voronoi-distance cracks spread down
 * from the surface line (uv.y = 0) and amber light bleeds through
 * them as if hidden rooms underneath the building were lit up.
 *
 * Goals from the design brief:
 *   - "Feel like there's more underground" — amber colour reads as
 *     light spilling out, NOT as fire / destruction.
 *   - Cracks originate at the floor line (top of the fill mesh) and
 *     propagate downward as the cinematic advances.
 *   - Two-pass amber palette: deep red-orange at the wide cracks,
 *     bright white-yellow inside the narrowest fissures, so the
 *     player reads warm rooms with strong key lights below.
 *
 * The pure-procedural voronoi here is from the IQ canonical sketch
 * (see references in the cinematic design notes). The growth gate
 * follows the "damage-revealed" pattern (smoothstep of fbm against
 * a progress threshold) recommended in our shader research pass.
 */

const VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FRAGMENT = `
precision highp float;

uniform float uProgress;
uniform float uTime;
uniform vec3  uTop;
uniform vec3  uDeep;

varying vec2 vUv;

vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)),
           dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

// Voronoi sweep — returns the F2-F1 edge distance AND the integer
// id of the cell the sample fell into. We need the cell id so the
// fragment can ask "is this cell a *room* that should fully break
// off?", and so per-cell delays / colours are uniform inside one
// cell rather than smoothly varying across it.
vec3 voronoiFull(vec2 p) {
  vec2 g = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  vec2 closest = vec2(0.0);
  vec2 closestId = g;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 b = vec2(float(i), float(j));
      vec2 r = b + hash22(g + b) * 0.9 - f;
      float d = dot(r, r);
      if (d < d1) { d1 = d; closest = r; closestId = g + b; }
    }
  }
  // Edge distance — perpendicular bisector to each neighbour site.
  float dE = 8.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 b = vec2(float(i), float(j));
      vec2 r = b + hash22(g + b) * 0.9 - f;
      vec2 d = r - closest;
      if (dot(d, d) > 0.0001) {
        dE = min(dE, dot(0.5 * (r + closest), normalize(d)));
      }
    }
  }
  return vec3(dE, closestId);
}

void main() {
  // PlaneGeometry UV: (0,1) is top-left, (0,0) is bottom-left. The
  // top of the mesh sits at the surface line and the bottom is the
  // deep earth, so flip y once into a "depth" coord (0 at surface,
  // 1 at deep) and reason about everything in that frame.
  float depth = 1.0 - vUv.y;

  // Dirt gradient — topsoil at the surface, deep earth below.
  vec3 dirt = mix(uTop, uDeep, smoothstep(0.0, 0.6, depth));

  // Cell density for the cracks. We only crack the top band so we
  // scale aggressively in y to get visible cells in that thin slice.
  // The horizontal coord is warped by a depth-driven fbm so each
  // crack visibly snakes sideways as it descends instead of falling
  // straight down — the cell-edge filaments curve along the warp.
  float snake = (fbm(vec2(vUv.x * 5.0, depth * 9.0)) - 0.5) * 4.0;
  // Smaller cells than before — each crack reads as a fine
  // capillary instead of a wide groove.
  vec2 cellUv = vec2(vUv.x * 72.0 + snake, depth * 140.0);
  cellUv += vec2(uTime * 0.012, 0.0);

  vec3 vor = voronoiFull(cellUv);
  float dEdge = vor.x;
  vec2 cellId = vor.yz;

  // Capillary cracks — visible as dark fissures on the surface
  // of the dirt, but they don't open into transparency on their
  // own. Their job is to scribble fracture detail.
  float crackLine = 1.0 - smoothstep(0.0, 0.018, dEdge);
  float crackEdge = 1.0 - smoothstep(0.0, 0.045, dEdge);

  float depthLimit = mix(0.02, 0.32, uProgress);
  float jitter = (fbm(vUv * 6.0) - 0.5) * 0.10;
  float depthGate = 1.0 - smoothstep(depthLimit - 0.06, depthLimit + jitter, depth);

  // Per-cell delay — uniform within a cell so the whole cell
  // "opens" together. Wider smoothstep window keeps the
  // propagation slow + visible.
  float cellDelay = hash21(cellId + 91.0) * 0.85;
  float lateralGate = smoothstep(cellDelay, cellDelay + 0.20, uProgress * 1.10);

  // A fraction of cells fully BREAK OFF when their gate opens —
  // the dirt becomes transparent across the whole cell, revealing
  // whatever real geometry the game placed behind the fill (the
  // demo's amber underground rooms). We inset from the cell edge
  // so a dark rim is left behind: the broken-concrete border of
  // the opening.
  float roomRoll = hash21(cellId + 17.0);
  float isRoom = step(0.78, roomRoll);                  // ~22 % of cells
  float breakBody = (1.0 - smoothstep(0.020, 0.055, dEdge))
                  * isRoom * lateralGate * depthGate;
  float breakRim = (smoothstep(0.020, 0.055, dEdge) - smoothstep(0.055, 0.080, dEdge))
                 * isRoom * lateralGate * depthGate;

  // Surface dirt colour — gradient + scribbled crack lines. These
  // cracks are visible *on* the dirt but don't punch through.
  vec3 col = dirt;
  vec3 crackColor = vec3(0.05, 0.025, 0.01);
  col = mix(col, crackColor, crackLine * depthGate * lateralGate * 0.85);
  col = mix(col, crackColor * 0.6, crackEdge * depthGate * lateralGate * 0.25);
  // Dark broken-edge rim around each break-off cell.
  col = mix(col, crackColor, clamp(breakRim, 0.0, 1.0));

  // Alpha: opaque dirt everywhere except inside break-off cells,
  // where the fragment punches through so whatever geometry sits
  // behind the fill (game-placed underground rooms) shows through.
  float alpha = 1.0 - breakBody;

  gl_FragColor = vec4(col, alpha);
}
`

export function createCrackMaterial({ topColor = '#4a3528', deepColor = '#15100a' } = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uProgress: { value: 0 },
      uTime:     { value: 0 },
      uTop:      { value: new THREE.Color(topColor) },
      uDeep:     { value: new THREE.Color(deepColor) },
    },
    transparent: true,
    depthWrite: false,
  })
}
