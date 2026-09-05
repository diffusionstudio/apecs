/**
 * Screen-space fluid rendering: the particles are never a surface, they are a
 * depth buffer that gets smoothed until it behaves like one. Depth -> bilateral
 * blur -> normals from finite differences -> refract the scene behind it.
 *
 * The depth targets are r32float and read with `textureLoad`, not a sampler:
 * r32float is not filterable without an optional feature, and every read here
 * is at an exact texel anyway.
 */

/** Anything at or past this in the fluid depth target is "no fluid here". */
export const NO_FLUID = 1e8;

const COMMON = /* wgsl */ `
struct View {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  view: mat4x4f,
  invView: mat4x4f,
  proj: mat4x4f,
  eye: vec4f,
  res: vec4f,    // w, h, 1/w, 1/h
  lens: vec4f,   // tanHalfX, tanHalfY, near, far
  fluid: vec4f,  // particle radius, refract, absorb, fresnel
  ball: vec4f,   // xyz centre, w radius
  grid: vec4f,   // gx, gy, gz, blur radius
  light: vec4f,  // direction xyz, time
  tint: vec4f,   // in-scatter rgb, strength
  misc: vec4f,   // thickness scale, unused
};

const TRI = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));

/**
 * An overcast daylight dome: near-white at the horizon, cooler overhead. The
 * water is mostly a mirror of this, so it carries more of the final image than
 * anything the fragment shaders compute directly.
 */
fn skyOf(d: vec3f, lightDir: vec3f) -> vec3f {
  let up = clamp(d.y, 0.0, 1.0);
  let sky = mix(vec3f(1.30, 1.33, 1.38), vec3f(0.58, 0.74, 1.02), sqrt(up));
  let below = mix(vec3f(1.30, 1.33, 1.38), vec3f(0.95, 0.96, 0.98), clamp(-d.y * 3.0, 0.0, 1.0));
  let dome = select(below, sky, d.y > 0.0);
  let sun = pow(max(dot(d, lightDir), 0.0), 140.0);
  return dome + vec3f(1.0, 0.96, 0.90) * sun * 1.8;
}

/**
 * One set of grid lines, antialiased against the plane's screen-space
 * derivative and faded out as its spacing falls below a couple of pixels — the
 * only way a plane like this reaches the horizon without turning into moire.
 */
fn gridLines(p: vec2f, w: vec2f, step: f32) -> f32 {
  let d = abs(fract(p / step - 0.5) - 0.5) * step / w;
  let line = 1.0 - min(min(d.x, d.y), 1.0);
  return line * clamp(step / (max(w.x, w.y) * 4.0) - 0.35, 0.0, 1.0);
}

/** The ground plane: a 3D viewport grid, minor lines with a heavier octave. */
fn floorAt(p: vec2f) -> vec3f {
  let w = fwidth(p);
  var col = vec3f(1.16, 1.17, 1.19);
  col = mix(col, vec3f(0.30, 0.305, 0.315), gridLines(p, w, 4.0) * 0.5);
  col = mix(col, vec3f(0.055, 0.057, 0.062), gridLines(p, w, 20.0));
  return col;
}

/** Clip-space z/w for a world point, so a raymarched hit can occlude a raster one. */
fn depthOf(vp: mat4x4f, p: vec3f) -> f32 {
  let clip = vp * vec4f(p, 1.0);
  return clip.z / clip.w;
}
`;

/* ------------------------------------------------------------------- scene */

export const SCENE = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> view: View;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) ndc: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var out: VOut;
  let p = TRI[vi];
  out.pos = vec4f(p, 0.0, 1.0);
  out.ndc = p;
  return out;
}

struct FOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
};

@fragment
fn fs(in: VOut) -> FOut {
  var out: FOut;
  let far = view.invViewProj * vec4f(in.ndc, 1.0, 1.0);
  let aim = far.xyz / far.w;
  let ro = view.eye.xyz;
  let rd = normalize(aim - ro);
  let lightDir = normalize(view.light.xyz);

  var color = skyOf(rd, lightDir);
  var depth = 1.0;
  var best = 1e30;

  // Floor. One tiled plane, all the way out; the sim domain is marked only by
  // a hairline on it, which is all that is left of the tank.
  //
  // The hit is computed for every pixel and only *used* where the ray meets
  // the plane, because floorAt takes derivatives and a derivative inside a
  // branch is a shader-creation error.
  let tFloor = select(-1.0, -ro.y / rd.y, rd.y < -1e-4);
  let hit = ro + rd * max(tFloor, 0.0);
  var floorCol = floorAt(hit.xz);

  if (tFloor > 0.0) {
    let g = view.grid.xyz;
    let border = min(min(abs(hit.x), abs(hit.x - g.x)), min(abs(hit.z), abs(hit.z - g.z)));
    floorCol = mix(floorCol, vec3f(0.012, 0.013, 0.015), 1.0 - smoothstep(0.0, 0.6, border));

    let toBall = hit - view.ball.xyz;
    let r2 = view.ball.w * view.ball.w;
    floorCol *= 1.0 - 0.35 * exp(-dot(toBall.xz, toBall.xz) / (r2 * 2.6));

    let haze = 1.0 - exp(-max(0.0, tFloor - 90.0) * 0.0032);
    color = mix(floorCol, skyOf(rd, lightDir), clamp(haze, 0.0, 1.0));
    depth = depthOf(view.viewProj, hit);
    best = tFloor;
  }

  // Ball.
  let oc = ro - view.ball.xyz;
  let b = dot(oc, rd);
  let c = dot(oc, oc) - view.ball.w * view.ball.w;
  let disc = b * b - c;
  if (disc > 0.0) {
    let t = -b - sqrt(disc);
    if (t > 0.0 && t < best) {
      let hit = ro + rd * t;
      let n = normalize(hit - view.ball.xyz);
      let diffuse = max(dot(n, lightDir), 0.0);
      let h = normalize(lightDir - rd);
      let spec = pow(max(dot(n, h), 0.0), 90.0);
      let rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
      let base = vec3f(0.95, 0.14, 0.055);
      color = base * (0.20 + 0.90 * diffuse) + vec3f(1.0) * spec * 0.9 + base * rim * 0.75;
      color += skyOf(reflect(rd, n), lightDir) * vec3f(0.06, 0.045, 0.04);
      depth = depthOf(view.viewProj, hit);
      best = t;
    }
  }

  out.color = vec4f(color, 1.0);
  out.depth = depth;
  return out;
}
`;

/* ------------------------------------------------ particles as sphere impostors */

const IMPOSTOR_VS = /* wgsl */ `
struct POut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) centre: vec3f,
  @location(2) extra: vec4f,
};

const QUAD = array<vec2f, 6>(
  vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
  vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
);
`;

export const FLUID = /* wgsl */ `
${COMMON}
${IMPOSTOR_VS}

struct Particle {
  pos: vec3f, pad0: f32,
  vel: vec3f, pad1: f32,
  c0: vec3f, pad2: f32,
  c1: vec3f, pad3: f32,
  c2: vec3f, pad4: f32,
};

@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> POut {
  var out: POut;
  let p = particles[ii];
  let centre = (view.view * vec4f(p.pos, 1.0)).xyz;
  let corner = QUAD[vi];
  let r = view.fluid.x;
  out.pos = view.proj * vec4f(centre + vec3f(corner * r, 0.0), 1.0);
  out.uv = corner;
  out.centre = centre;
  out.extra = vec4f(length(p.vel), r, 0.0, 0.0);
  return out;
}

struct DepthOut {
  @location(0) depth: f32,
  @builtin(frag_depth) frag: f32,
};

@fragment
fn depthFs(in: POut) -> DepthOut {
  let d2 = dot(in.uv, in.uv);
  if (d2 > 1.0) { discard; }
  let r = in.extra.y;
  let surface = in.centre + vec3f(in.uv * r, sqrt(1.0 - d2) * r);
  var out: DepthOut;
  out.depth = -surface.z;
  let clip = view.proj * vec4f(surface, 1.0);
  out.frag = clip.z / clip.w;
  return out;
}

/**
 * Additive: how much water the eye ray crossed, and how fast it was moving.
 *
 * A ray crosses every particle whose centre is within the impostor radius, not
 * just the ones on the line, so the raw sum of chords overcounts by an order of
 * magnitude. misc.x is 1 / (rho * sphere volume) — the factor that turns the sum
 * back into a path length in cells, which is what the absorption downstream is
 * calibrated against.
 */
@fragment
fn thicknessFs(in: POut) -> @location(0) vec2f {
  let d2 = dot(in.uv, in.uv);
  if (d2 > 1.0) { discard; }
  let slab = sqrt(1.0 - d2) * in.extra.y * 2.0 * view.misc.x;
  return vec2f(slab, slab * in.extra.x);
}
`;

/* -------------------------------------------------------------------- blur */

export const BLUR = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var src: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var out: VOut;
  out.pos = vec4f(TRI[vi], 0.0, 1.0);
  return out;
}

/** Which axis this pipeline blurs along; WebGPU has no push constants. */
override AXIS_X: f32 = 1.0;

@fragment
fn fs(in: VOut) -> @location(0) f32 {
  let uv = vec2i(in.pos.xy);
  let centre = textureLoad(src, uv, 0).r;
  if (centre >= ${NO_FLUID}) { return centre; }

  // The kernel is a fixed multiple of the particle's *projected* size, so the
  // surface smooths by the same amount whether the camera is near or far.
  let projected = view.fluid.x / max(centre, 1.0) / view.lens.y * (view.res.y * 0.5);
  let radius = i32(clamp(projected * view.grid.w * 5.0, 1.0, 30.0));
  let step = vec2i(i32(AXIS_X), 1 - i32(AXIS_X));
  let sigma = max(1.0, f32(radius) * 0.5);
  // In world units: neighbouring particles on one surface differ by about a
  // rest spacing, so anything below that rejects the whole neighbourhood and
  // leaves the sphere facets the blur exists to remove.
  let depthSigma = 4.0;

  var sum = centre;
  var weight = 1.0;
  for (var i = 1; i <= radius; i++) {
    let fi = f32(i);
    let spatial = exp(-fi * fi / (2.0 * sigma * sigma));
    for (var s = -1; s <= 1; s += 2) {
      let sample = textureLoad(src, uv + step * (i * s), 0).r;
      if (sample >= ${NO_FLUID}) { continue; }
      let dd = (sample - centre) / depthSigma;
      let w = spatial * exp(-dd * dd);
      sum += sample * w;
      weight += w;
    }
  }
  return sum / weight;
}
`;

/* --------------------------------------------------------------- composite */

export const COMPOSITE = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_2d<f32>;
@group(0) @binding(3) var thickTex: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) ndc: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var out: VOut;
  let p = TRI[vi];
  out.pos = vec4f(p, 0.0, 1.0);
  out.ndc = p;
  return out;
}

/** View-space position of the fluid surface under a pixel. */
fn viewPosAt(px: vec2i, depth: f32) -> vec3f {
  let uv = (vec2f(px) + 0.5) * view.res.zw;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return vec3f(ndc.x * view.lens.x * depth, ndc.y * view.lens.y * depth, -depth);
}

/** The smaller of the two one-sided differences, so silhouettes stay sharp. */
fn minDiff(centre: vec3f, a: vec3f, b: vec3f) -> vec3f {
  let da = a - centre;
  let db = centre - b;
  return select(db, da, abs(da.z) < abs(db.z));
}

/**
 * The one place linear light meets the 8-bit swap chain. The S-curve is applied
 * after the transfer function, not before: a bright environment compresses into
 * the top of the Reinhard shoulder and comes out flat without it.
 */
fn present(c: vec3f) -> vec4f {
  let mapped = clamp(c / (c + vec3f(0.6)), vec3f(0.0), vec3f(1.0));
  let s = pow(mapped, vec3f(1.0 / 2.2));
  return vec4f(mix(s, s * s * (3.0 - 2.0 * s), 0.42), 1.0);
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let px = vec2i(in.pos.xy);
  let uv = (vec2f(px) + 0.5) * view.res.zw;
  let scene = textureSampleLevel(sceneTex, samp, uv, 0.0).rgb;

  let far4 = view.invViewProj * vec4f(in.ndc, 1.0, 1.0);
  let ro = view.eye.xyz;
  let rd = normalize(far4.xyz / far4.w - ro);
  let lightDir = normalize(view.light.xyz);

  let depth = textureLoad(depthTex, px, 0).r;
  if (depth >= ${NO_FLUID}) {
    return present(scene);
  }

  // A two-pixel stencil, not one: at one pixel the residual noise the blur
  // leaves behind is the same size as the slope being measured, and the
  // surface breaks into facets.
  let centre = viewPosAt(px, depth);
  let sx = vec2i(2, 0);
  let sy = vec2i(0, 2);
  let right = viewPosAt(px + sx, textureLoad(depthTex, px + sx, 0).r);
  let left = viewPosAt(px - sx, textureLoad(depthTex, px - sx, 0).r);
  let down = viewPosAt(px + sy, textureLoad(depthTex, px + sy, 0).r);
  let up = viewPosAt(px - sy, textureLoad(depthTex, px - sy, 0).r);
  let dx = minDiff(centre, right, left);
  let dy = minDiff(centre, down, up);
  let nView = normalize(cross(dy, dx));
  let n = normalize((view.invView * vec4f(nView, 0.0)).xyz);

  let thick = textureLoad(thickTex, px, 0).rg;
  let slab = thick.x;
  // The blur widens the silhouette past where any water actually is, and that
  // fringe reads as a glow around the whole body. Crop it to where there is a
  // measurable path length rather than trying to shade it plausibly.
  if (slab < 0.2) {
    return present(scene);
  }
  // Mean speed through the slab, not summed speed: a lone fast particle in
  // front of still water must not paint a white dot.
  let speed = select(0.0, thick.y / slab, slab > 0.2);
  let churn = clamp((speed - 2.6) * 0.22, 0.0, 1.0);

  // Refraction. The offset grows with thickness so a thin sheet barely bends
  // the tiles and a deep body displaces them a long way.
  let bend = view.fluid.y * clamp(slab * 0.35, 0.0, 4.0) * 0.012;
  let behind = clamp(uv + n.xy * bend * vec2f(1.0, -1.0), vec2f(0.0), vec2f(1.0));
  let refracted = textureSampleLevel(sceneTex, samp, behind, 0.0).rgb;

  // Beer-Lambert, per channel: red dies within a few units, blue survives.
  // This, not a tint, is what makes shallow water clear and deep water blue.
  let transmit = exp(-view.fluid.z * slab * vec3f(2.3, 0.72, 0.13));
  var color = refracted * transmit + view.tint.xyz * (1.0 - transmit) * view.tint.w;

  color = mix(color, vec3f(0.88, 0.92, 0.97), churn * clamp(1.0 - slab * 0.10, 0.0, 1.0) * 0.7);

  let f = view.fluid.w * pow(1.0 - max(dot(n, -rd), 0.0), 5.0) + 0.02;
  color = mix(color, skyOf(reflect(rd, n), lightDir), clamp(f, 0.0, 0.92));

  let h = normalize(lightDir - rd);
  let ndh = max(dot(n, h), 0.0);
  color += vec3f(1.0, 0.98, 0.94) * (pow(ndh, 400.0) * 3.0 + pow(ndh, 20.0) * 0.22);

  return present(color);
}
`;
