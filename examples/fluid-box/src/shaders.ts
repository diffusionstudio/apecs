/**
 * Both passes share the box: the eye sits at z = camZ, the opening spans |x| < aspect, |y| < 1 at
 * z = 0, and the back wall is at z = -depth. `frame` is how much wider than the opening the
 * viewport is — the surplus is the marble surround.
 */
const COMMON = /* wgsl */ `
struct View {
  aspect: f32,
  frame: f32,
  camZ: f32,
  depth: f32,
  fluidZ: f32,
  slab: f32,
  time: f32,
  exposure: f32,
};

// Key light, pointing from the box toward the lamp. Kept close to the view direction: a light
// raking in from the side throws the mass's shadow clean off the back wall.
const LIGHT = vec3f(0.30, 0.40, 0.87);

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), s.x);
  let b = mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), s.x);
  return mix(a, b, s.y);
}

fn hsv(h: f32, s: f32, v: f32) -> vec3f {
  let k = fract(vec3f(h, h + 2.0 / 3.0, h + 1.0 / 3.0)) * 6.0;
  return v * mix(vec3f(1.0), clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0)), s);
}
`;

export const ROOM = /* wgsl */ `
${COMMON}
struct Room {
  view: View,
  glow: vec4f,
};
@group(0) @binding(0) var<uniform> u: Room;
@group(0) @binding(1) var cover: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) ndc: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  out.ndc = p[vi];
  return out;
}

fn plaster(p: vec2f) -> f32 {
  return vnoise(p * 17.0) * 0.5 + vnoise(p * 41.0) * 0.3 + vnoise(p * 97.0) * 0.2;
}

/**
 * Coverage of the fluid slab at a point in box coordinates. Outside the box it is zero, not the
 * clamped edge texel — reading the edge smears the mass's shadow into rays across every wall.
 */
fn occupancy(p: vec2f) -> f32 {
  let uv = vec2f(p.x / u.view.aspect * 0.5 + 0.5, 0.5 - p.y * 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 0.0;
  }
  return textureSampleLevel(cover, samp, uv, 0.0).r;
}

/** Five taps across a few texels: the mass is a volume, so its shadow has no sharp edge. */
fn softOccupancy(p: vec2f, r: f32) -> f32 {
  let o = occupancy(p) * 2.0
    + occupancy(p + vec2f(r, r))
    + occupancy(p + vec2f(-r, r))
    + occupancy(p + vec2f(r, -r))
    + occupancy(p + vec2f(-r, -r));
  return o / 6.0;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let a = u.view.aspect;
  let camZ = u.view.camZ;
  let depth = u.view.depth;
  // Where the eye ray crosses the plane of the opening.
  let p = vec2f(in.ndc.x * a, in.ndc.y) * u.view.frame;
  var color: vec3f;

  if (abs(p.x) >= a || abs(p.y) >= 1.0) {
    // Marble surround: a bright slab with a bevel that turns down into the opening.
    let d = max(abs(p.x) - a, abs(p.y) - 1.0);
    let grain = plaster(in.ndc * vec2f(a, 1.0));
    let bevel = smoothstep(0.0, 0.030, d);
    let base = (0.80 + 0.22 * grain) * mix(0.30, 1.12, bevel);
    let sheen = 0.12 * smoothstep(0.45, 0.0, length(in.ndc - vec2f(-0.55, 0.6)));
    color = vec3f(base + sheen);
  } else {
    // March the eye ray to whichever of the five inner faces it reaches first.
    let tx = select(1e9, a / abs(p.x), abs(p.x) > 1e-6);
    let ty = select(1e9, 1.0 / abs(p.y), abs(p.y) > 1e-6);
    let tz = (camZ + depth) / camZ;
    let t = min(tx, min(ty, tz));
    let hit = vec3f(p * t, -camZ * (t - 1.0));
    let deep = -hit.z / depth;

    var base: f32;
    var edge: f32;
    var facing: f32;
    // Each face gets texture coordinates in its own plane; one shared pair streaks the grain.
    var grain: vec2f;
    if (t == tz) {
      base = 0.74;
      edge = min(a - abs(hit.x), 1.0 - abs(hit.y));
      facing = 1.0;
      grain = hit.xy;
    } else if (t == tx) {
      base = select(0.62, 0.40, hit.x < 0.0);
      edge = min(1.0 - abs(hit.y), depth + hit.z);
      facing = 0.55;
      grain = vec2f(hit.z, hit.y);
    } else {
      // The ceiling faces away from everything; the floor takes the light almost square on.
      base = select(0.88, 0.06, hit.y > 0.0);
      edge = min(a - abs(hit.x), depth + hit.z);
      facing = select(0.9, 0.1, hit.y > 0.0);
      grain = vec2f(hit.x, hit.z);
    }
    base *= 0.55 + 0.45 * plaster(grain * 0.5);
    // Light falls off toward the back, and the inner corners hold ambient occlusion.
    base *= 1.0 - 0.38 * deep;
    base *= 0.40 + 0.60 * smoothstep(0.0, 0.28, edge);

    // Trace on toward the light; if the fluid slab stands in the way, the face is in shadow.
    let toSlab = (-u.view.fluidZ - hit.z) / LIGHT.z;
    var shade = 1.0;
    if (toSlab > 0.0) {
      shade = 1.0 - 0.82 * softOccupancy(hit.xy + LIGHT.xy * toSlab, 0.055) * facing;
    }
    // Bounce: the mass is the only coloured thing in the box, so the walls pick its colour up.
    // Sampled just inside the wall, since the wall plane itself sits on the texture's edge.
    let near = softOccupancy(hit.xy * 0.97, 0.09);
    // Weighted by how squarely the face meets the mass, or stray rods near the ceiling smear
    // into rays across it.
    let bounce = u.glow.rgb * u.glow.w * near * facing * (0.55 - 0.3 * deep);
    color = vec3f(base) * shade + bounce;
  }

  color *= 1.0 - 0.20 * smoothstep(0.75, 1.75, length(in.ndc));
  return vec4f(pow(clamp(color * u.view.exposure, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0);
}
`;

export const RODS = /* wgsl */ `
${COMMON}
struct Rods {
  view: View,
  size: vec4f,
  look: vec4f,
};
@group(0) @binding(0) var<uniform> u: Rods;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
  @location(2) spec: vec3f,
};

fn hash(n: u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x) / 4294967295.0;
}

@vertex
fn vs(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
  @location(0) x: f32,
  @location(1) y: f32,
  @location(2) hx: f32,
  @location(3) hy: f32,
  @location(4) hue: f32,
  @location(5) gx: f32,
  @location(6) gy: f32,
  @location(7) rho: f32,
) -> VSOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
  );
  let c = corners[vi];
  let seed = hash(ii);
  let seed2 = hash(ii * 7919u + 13u);
  let z = hash(ii * 2654435761u + 7u);

  // The solver is one slice; spreading it over the slab and shearing each layer by its own slow
  // noise is what turns a sheet of rods back into a volume.
  let zw = u.view.fluidZ + (z - 0.5) * u.view.slab;
  let persp = u.view.camZ / (u.view.camZ + zw);
  let q = vec2f(x, y);
  let n1 = vnoise(q * 2.7 + vec2f(z * 19.3, z * 13.1) + u.view.time * 0.06);
  let n2 = vnoise(q * 2.7 + vec2f(z * 19.3 + 53.0, z * 13.1 + 17.0) - u.view.time * 0.05);
  let p = q + (vec2f(n1, n2) - 0.5) * u.look.w;

  let ndc = vec2f(p.x / u.view.aspect, p.y) * persp / u.view.frame;
  let heading = vec2f(hx, hy);
  let m = length(heading);
  let dir = select(vec2f(1.0, 0.0), heading / m, m > 1e-4);
  let perp = vec2f(-dir.y, dir.x);
  let half = vec2f(u.size.x * (0.42 + 1.35 * m), u.size.y) * persp;
  let offset = (dir * (c.x * half.x) + perp * (c.y * half.y)) / vec2f(u.size.z, u.size.w);

  var out: VSOut;
  out.pos = vec4f(ndc + offset, 0.04 + z * 0.92, 1.0);
  out.uv = c;

  // Kajiya-Kay: a rod is a fibre, so its shading depends on the angle to its axis, not a normal.
  // Neighbouring rods comb the same way, which is what draws the streaks.
  let T = normalize(vec3f(dir, (seed - 0.5) * 0.85));
  let TL = dot(T, LIGHT);
  let TV = T.z;
  let sinTL = sqrt(max(0.0, 1.0 - TL * TL));
  let sinTV = sqrt(max(0.0, 1.0 - TV * TV));
  let fibre = sinTL * sinTL;
  let gloss = pow(max(0.0, sinTL * sinTV - TL * TV), 34.0) * (0.35 + 0.9 * seed2);

  // The macro form: the density gradient is the outward normal of the mass itself.
  let g = vec2f(gx, gy);
  let N = normalize(vec3f(g * 2.6, 0.9));
  let form = max(dot(N, LIGHT), 0.0);
  // Buried rods barely see the light; the shell of the mass takes nearly all of it.
  let shell = smoothstep(1.20, 0.40, rho);
  let ao = 0.045 + 0.955 * shell * shell;
  // Depth inside the slab, which is what opens the black gaps between the front tufts.
  let dim = 1.0 - 0.62 * z;

  let base = hsv(fract(hue + (seed2 - 0.5) * 0.045), u.look.x, 1.0);
  let key = 0.10 + 1.9 * form * (0.22 + 1.0 * fibre);
  out.color = base * key * ao * dim * u.look.y;
  out.spec = gloss * mix(base, vec3f(1.0), 0.75) * ao * dim * u.look.y * 3.2;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let ay = abs(in.uv.y);
  // A rounded prism: the crown catches the highlight, the flanks fall away.
  // A hard falloff across the rod, so neighbours stay separate chips instead of washing together.
  let bevel = 0.30 + 0.82 * (1.0 - ay * ay * ay);
  let crown = smoothstep(0.6, 0.0, ay);
  let cap = 1.0 - 0.45 * smoothstep(0.72, 1.0, abs(in.uv.x));
  let color = (in.color * bevel + in.spec * crown) * cap * u.view.exposure;
  return vec4f(pow(clamp(color, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0);
}
`;
