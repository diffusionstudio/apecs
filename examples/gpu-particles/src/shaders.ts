/** WGSL for the four passes: trail fade, particles, pick, composite. */

export const PARTICLE = /* wgsl */ `
struct Uniforms {
  aspect: f32,
  halfW: f32,
  halfH: f32,
  time: f32,
  radiusPx: f32,
  palette: f32,
  gain: f32,
  first: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
  @location(2) @interpolate(flat) id: u32,
};

fn hash(n: u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x) / 4294967295.0;
}

fn palette(speed: f32, seed: f32, life: f32) -> vec3f {
  if (u.palette < 0.5) {
    // Cold: each particle sits somewhere between teal and violet; speed heats it toward white.
    let t = 1.0 - exp(-speed * 0.7);
    let tint = mix(vec3f(0.05, 0.55, 1.0), vec3f(0.85, 0.25, 1.0), smoothstep(0.15, 0.85, seed));
    let slow = mix(vec3f(0.03, 0.08, 0.5), tint, smoothstep(0.0, 0.5, t));
    return mix(slow, vec3f(1.0, 0.97, 0.9), smoothstep(0.55, 1.0, t)) * (0.6 + 0.6 * t);
  }
  // Embers: ruby -> orange -> straw, dimming as life burns down.
  let t = clamp(life, 0.0, 1.0);
  let base = mix(vec3f(0.55, 0.04, 0.02), vec3f(1.0, 0.42, 0.06), smoothstep(0.0, 0.6, t));
  let bright = mix(base, vec3f(1.0, 0.92, 0.55), smoothstep(0.6, 1.0, t) * (0.5 + seed * 0.5));
  return bright * (0.25 + 0.75 * t);
}

fn emit(corner: vec2f, ii: u32, x: f32, y: f32, vx: f32, vy: f32, life: f32) -> VSOut {
  let center = vec2f(x / u.aspect, y);
  let r = u.radiusPx;
  var out: VSOut;
  out.pos = vec4f(center + corner * vec2f(r / u.halfW, r / u.halfH), 0.0, 1.0);
  out.uv = corner;
  out.color = palette(length(vec2f(vx, vy)), hash(ii), life) * u.gain;
  out.id = ii;
  return out;
}

/** One triangle per particle, sized to enclose the unit disc; the fragment stage clips it. */
@vertex
fn vs(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
  @location(0) x: f32,
  @location(1) y: f32,
  @location(2) vx: f32,
  @location(3) vy: f32,
  @location(4) life: f32,
) -> VSOut {
  var corners = array<vec2f, 3>(vec2f(0.0, 2.0), vec2f(-1.7320508, -1.0), vec2f(1.7320508, -1.0));
  return emit(corners[vi], ii, x, y, vx, vy, life);
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let d2 = dot(in.uv, in.uv);
  let a = exp(-d2 * 3.2) * step(d2, 1.0);
  return vec4f(in.color * a, a);
}

@fragment
fn fs_pick(in: VSOut) -> @location(0) u32 {
  if (dot(in.uv, in.uv) > 1.0) {
    discard;
  }
  return in.id + 1u;
}
`;

export const SCREEN = /* wgsl */ `
struct Screen {
  exposure: f32,
  fade: f32,
  time: f32,
  selOn: f32,
  selX: f32,
  selY: f32,
  halfW: f32,
  halfH: f32,
};
@group(0) @binding(0) var<uniform> s: Screen;
@group(0) @binding(1) var hdr: texture_2d<f32>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  // One oversized triangle covers the viewport.
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  out.uv = p[vi];
  return out;
}

/** Multiplies the trail buffer by a constant: the previous frame decays, nothing is cleared. */
@fragment
fn fs_fade() -> @location(0) vec4f {
  return vec4f(0.0, 0.0, 0.0, 1.0);
}

fn tonemap(c: vec3f) -> vec3f {
  // A soft shoulder that keeps dense cores white without clipping hue.
  let x = c * s.exposure;
  return 1.0 - exp(-x * (1.0 + 0.15 * x));
}

@fragment
fn fs_composite(in: VSOut) -> @location(0) vec4f {
  let px = vec2i(i32(in.pos.x), i32(in.pos.y));
  let light = textureLoad(hdr, px, 0).rgb;

  let r = length(in.uv * vec2f(1.0, s.halfH / s.halfW));
  let vignette = 1.0 - smoothstep(0.55, 1.55, r) * 0.7;
  let ground = vec3f(0.012, 0.014, 0.03) * vignette;

  var color = ground + tonemap(light);

  if (s.selOn > 0.5) {
    let d = distance(vec2f(in.pos.x, in.pos.y), vec2f(s.selX, s.selY));
    let ring = smoothstep(2.2, 0.8, abs(d - 15.0));
    let pulse = 0.75 + 0.25 * sin(s.time * 6.0);
    color = mix(color, vec3f(1.0), ring * pulse);
  }

  return vec4f(pow(clamp(color, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0);
}
`;
