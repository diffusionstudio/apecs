/**
 * Ordered scene-graph traversal.
 *
 * A five-level hierarchy walked once per frame in **sibling order** — depth
 * first, children visited by ascending `ItemIndex` — updating every node's
 * Position by its Velocity. That is the update order a UI tree or a scene
 * graph actually needs; the question is what it costs.
 *
 * Three families are measured against each other:
 *
 *   objects   a classic node graph: `node.children` pre-sorted, walked by
 *             recursion or by an explicit stack. Pointer chasing.
 *   flat      the same order baked into typed arrays, either reached through
 *             an index array (gather) or with the data physically laid out in
 *             traversal order (sequential). The floor.
 *   apecs     unordered `chunks` and `each`, `Cascade` (depth order only),
 *             `sortBy` (side array), `orderBy` (storage permuted into key
 *             order) and the Tier-1 accessor walk over a cached order.
 *
 * Three things keep this honest. Creation order is a shuffle of the whole
 * tree, so no representation gets traversal order for free from its storage
 * layout. Every contender's visit sequence is verified against the reference
 * depth-first order before it is timed. And every hot loop is a method on an
 * instance, never a closure over per-scene arrays: V8 constant-folds the
 * captures of a *single* closure and stops the moment a second one exists,
 * which is worth 4x on the flat loops and would have made the floor a lie.
 *
 *   node scene-graph.mjs              the full table at ~4 700 nodes
 *   node scene-graph.mjs --branch 9   a different size
 *   node scene-graph.mjs --scale      the key contenders from 360 to 160 000
 *   node scene-graph.mjs --drift      what a changed order costs to restore
 */
import { execFileSync } from 'node:child_process';

import { measure } from 'mitata';

import { Cascade, Relation, Trait, World, f32 } from '../../dist/index.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(argv[at + 1]);
};

const DEPTH = 5; // levels, roots included
const DT = 1 / 60;

/** A deterministic PRNG, so every run builds the same tree and the same shuffle. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function shuffle(n, random) {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = i;
  }
  for (let i = n - 1; i > 0; i--) {
    const j = (random() * (i + 1)) | 0;
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

/** Per-node velocity, so a wrong order is a wrong result, not just a wrong shape. */
const vx = (node) => 1 + (node % 7) * 0.25;
const vy = (node) => 2 - (node % 5) * 0.25;

/**
 * The tree, plus the two orders that matter: `spawn`, the scrambled order
 * everything is created in, and `dfs`, the sibling-ordered walk.
 */
class Scene {
  constructor(branch, roots) {
    const random = rng(0x9e3779b9);
    this.branch = branch;
    this.parent = [];
    this.item = [];
    this.children = [];

    let level = [];
    for (let r = 0; r < roots; r++) {
      level.push(this.#add(-1));
    }
    this.roots = level.slice();
    for (let d = 1; d < DEPTH; d++) {
      const next = [];
      for (const p of level) {
        for (let b = 0; b < branch; b++) {
          next.push(this.#add(p));
        }
      }
      level = next;
    }

    // Sibling order is a shuffle, never creation order: an ordered walk that
    // happened to be the identity would measure nothing.
    const assign = (siblings) => {
      const order = shuffle(siblings.length, random);
      for (let i = 0; i < siblings.length; i++) {
        this.item[siblings[i]] = order[i];
      }
      for (const node of siblings) {
        if (this.children[node].length > 0) {
          assign(this.children[node]);
        }
      }
    };
    assign(this.roots);

    this.n = this.parent.length;
    for (let i = 0; i < this.n; i++) {
      this.children[i].sort((a, b) => this.item[a] - this.item[b]);
    }
    this.roots.sort((a, b) => this.item[a] - this.item[b]);

    this.spawn = shuffle(this.n, random);
    this.dfs = new Uint32Array(this.n); // walk position -> node
    this.rank = new Uint32Array(this.n); // node -> walk position
    this.stack = new Int32Array(this.n + 1);
    this.renumber();
  }

  #add(p) {
    const node = this.parent.length;
    this.parent.push(p);
    this.item.push(0);
    this.children.push([]);
    if (p !== -1) {
      this.children[p].push(node);
    }
    return node;
  }

  /**
   * Swaps the `ItemIndex` of two children under each of `parents` — the model
   * change every representation then has to answer for.
   */
  reshuffle(parents, random) {
    const swaps = [];
    for (const parent of parents) {
      const kids = this.children[parent];
      if (kids.length < 2) {
        continue;
      }
      const a = kids[(random() * kids.length) | 0];
      const b = kids[(random() * kids.length) | 0];
      if (a === b) {
        continue;
      }
      const t = this.item[a];
      this.item[a] = this.item[b];
      this.item[b] = t;
      kids.sort((x, y) => this.item[x] - this.item[y]);
      swaps.push(a, b);
    }
    return swaps;
  }

  /** Depth-first pre-order, children by `ItemIndex`: the reference order. */
  renumber() {
    const { children, dfs, rank, roots, stack } = this;
    let top = 0;
    for (let i = roots.length - 1; i >= 0; i--) {
      stack[top++] = roots[i];
    }
    let at = 0;
    while (top > 0) {
      const node = stack[--top];
      dfs[at] = node;
      rank[node] = at++;
      const kids = children[node];
      for (let i = kids.length - 1; i >= 0; i--) {
        stack[top++] = kids[i];
      }
    }
  }
}

// ---------------------------------------------------------------- contenders
//
// Every `walk(out)` updates Position by Velocity for every node in sibling
// order. Passing an array collects the node ids it visited, which is how the
// order is verified; the timed call passes `undefined`.

class GraphNode {
  constructor(id, item) {
    this.id = id;
    this.x = id;
    this.y = id;
    this.vx = vx(id);
    this.vy = vy(id);
    this.item = item;
    this.children = [];
  }
}

/** A classic node graph: objects, child arrays, pointer chasing. */
class Graph {
  constructor(s) {
    // Allocated in the scrambled order, so sibling pointers run all over the heap.
    const nodes = new Array(s.n);
    for (let i = 0; i < s.n; i++) {
      const id = s.spawn[i];
      nodes[id] = new GraphNode(id, s.item[id]);
    }
    for (let id = 0; id < s.n; id++) {
      const p = s.parent[id];
      if (p !== -1) {
        nodes[p].children.push(nodes[id]);
      }
    }
    for (let id = 0; id < s.n; id++) {
      nodes[id].children.sort((a, b) => a.item - b.item);
    }
    this.nodes = nodes;
    this.roots = s.roots.map((r) => nodes[r]);
    this.stack = new Array(s.n);
  }

  /** The object graph's answer to a changed order: re-sort the lists that moved. */
  applyOrder(s, swaps) {
    const nodes = this.nodes;
    for (let i = 0; i < swaps.length; i++) {
      const node = swaps[i];
      nodes[node].item = s.item[node];
    }
    for (let i = 0; i < swaps.length; i += 2) {
      const p = s.parent[swaps[i]];
      const list = p === -1 ? this.roots : nodes[p].children;
      list.sort((a, b) => a.item - b.item);
    }
  }

  /** A full re-sort, for putting the graph back in step after mixed drift. */
  resync(s) {
    const nodes = this.nodes;
    for (let id = 0; id < s.n; id++) {
      nodes[id].item = s.item[id];
    }
    for (let id = 0; id < s.n; id++) {
      nodes[id].children.sort((a, b) => a.item - b.item);
    }
    this.roots.sort((a, b) => a.item - b.item);
  }

  recursive(out) {
    const roots = this.roots;
    for (let i = 0; i < roots.length; i++) {
      descend(roots[i], out);
    }
  }

  iterative(out) {
    const stack = this.stack;
    const roots = this.roots;
    let top = 0;
    for (let i = roots.length - 1; i >= 0; i--) {
      stack[top++] = roots[i];
    }
    while (top > 0) {
      const node = stack[--top];
      node.x += node.vx * DT;
      node.y += node.vy * DT;
      if (out !== undefined) {
        out.push(node.id);
      }
      const kids = node.children;
      for (let i = kids.length - 1; i >= 0; i--) {
        stack[top++] = kids[i];
      }
    }
  }

  /** The one people actually write: the child list is re-sorted on every visit. */
  resorting(out) {
    const stack = this.stack;
    let top = 0;
    const seed = this.roots.slice().sort((a, b) => b.item - a.item);
    for (let i = 0; i < seed.length; i++) {
      stack[top++] = seed[i];
    }
    while (top > 0) {
      const node = stack[--top];
      node.x += node.vx * DT;
      node.y += node.vy * DT;
      if (out !== undefined) {
        out.push(node.id);
      }
      const kids = node.children.slice().sort((a, b) => b.item - a.item);
      for (let i = 0; i < kids.length; i++) {
        stack[top++] = kids[i];
      }
    }
  }
}

function descend(node, out) {
  node.x += node.vx * DT;
  node.y += node.vy * DT;
  if (out !== undefined) {
    out.push(node.id);
  }
  const kids = node.children;
  for (let i = 0; i < kids.length; i++) {
    descend(kids[i], out);
  }
}

const PAGE = 4096; // what a column page holds, so the paged walk matches apecs

/** One page of the hand-written paged layout — an archetype's chunk, by hand. */
class Page {
  constructor(rows) {
    this.n = rows;
    this.x = new Float32Array(PAGE);
    this.y = new Float32Array(PAGE);
    this.vx = new Float32Array(PAGE);
    this.vy = new Float32Array(PAGE);
    this.id = new Uint32Array(PAGE);
  }
}

/** Typed arrays: the same order, reached three different ways. */
class Flat {
  constructor(s) {
    const n = s.n;
    this.scene = s;
    // Storage row `r` holds node `s.spawn[r]` — the scrambled layout.
    this.row = new Uint32Array(n);
    for (let r = 0; r < n; r++) {
      this.row[s.spawn[r]] = r;
    }
    this.gx = new Float32Array(n);
    this.gy = new Float32Array(n);
    this.gvx = new Float32Array(n);
    this.gvy = new Float32Array(n);
    for (let id = 0; id < n; id++) {
      const r = this.row[id];
      this.gx[r] = id;
      this.gy[r] = id;
      this.gvx[r] = vx(id);
      this.gvy[r] = vy(id);
    }
    // The cached walk: traversal position -> storage row.
    this.gather = new Uint32Array(n);
    // The same data again, physically laid out in traversal order.
    this.sx = new Float32Array(n);
    this.sy = new Float32Array(n);
    this.svx = new Float32Array(n);
    this.svy = new Float32Array(n);
    // The same data once more, cut into pages: the shape a chunk walk has, so
    // `chunks()` is measured against a hand-written walk of the same shape.
    this.pages = [];
    for (let at = 0; at < n; at += PAGE) {
      this.pages.push(new Page(Math.min(PAGE, n - at)));
    }
    this.relayout();
  }

  /** What a changed order costs this layout: the index pass and the permute. */
  relayout() {
    const s = this.scene;
    const { row, gather, sx, sy, svx, svy } = this;
    for (let i = 0; i < s.n; i++) {
      const id = s.dfs[i];
      gather[i] = row[id];
      sx[i] = id;
      sy[i] = id;
      svx[i] = vx(id);
      svy[i] = vy(id);
    }
    const pages = this.pages;
    for (let i = 0; i < s.n; i++) {
      const page = pages[(i / PAGE) | 0];
      const at = i % PAGE;
      const id = s.dfs[i];
      page.x[at] = id;
      page.y[at] = id;
      page.vx[at] = vx(id);
      page.vy[at] = vy(id);
      page.id[at] = id;
    }
  }

  /** The same walk one page at a time — what a chunk loop can actually reach. */
  paged(out) {
    const pages = this.pages;
    for (let k = 0; k < pages.length; k++) {
      const { x, y, vx: pvx, vy: pvy, id, n } = pages[k];
      for (let i = 0; i < n; i++) {
        x[i] += pvx[i] * DT;
        y[i] += pvy[i] * DT;
        if (out !== undefined) {
          out.push(id[i]);
        }
      }
    }
  }

  gathered(out) {
    const { gx, gy, gvx, gvy, gather } = this;
    for (let i = 0, n = gather.length; i < n; i++) {
      const r = gather[i];
      gx[r] += gvx[r] * DT;
      gy[r] += gvy[r] * DT;
      if (out !== undefined) {
        out.push(this.scene.spawn[r]);
      }
    }
  }

  sequential(out) {
    const { sx, sy, svx, svy } = this;
    for (let i = 0, n = sx.length; i < n; i++) {
      sx[i] += svx[i] * DT;
      sy[i] += svy[i] * DT;
      if (out !== undefined) {
        out.push(this.scene.dfs[i]);
      }
    }
  }
}

const Position = new Trait({ x: f32(0), y: f32(0) });
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const Order = new Trait({ value: 0 });
const ItemIndex = new Trait({ value: 0 });
const ChildOf = new Relation(undefined, { exclusive: true });

class Ecs {
  constructor(s) {
    const world = new World();
    const sceneRoot = world.spawn();
    const handles = new Array(s.n);
    const nodeOf = new Map();

    // Two passes: spawn in the scrambled order, then parent. A child may be
    // created before its parent, exactly as in a streamed scene.
    for (let i = 0; i < s.n; i++) {
      const id = s.spawn[i];
      const e = world.spawn(
        Position({ x: id, y: id }),
        Velocity({ x: vx(id), y: vy(id) }),
        Order({ value: s.rank[id] }),
        ItemIndex({ value: s.item[id] }),
      );
      handles[id] = e;
      nodeOf.set(e, id);
    }
    for (let i = 0; i < s.n; i++) {
      const id = s.spawn[i];
      world.add(handles[id], ChildOf(s.parent[id] === -1 ? sceneRoot : handles[s.parent[id]]));
    }

    this.scene = s;
    this.world = world;
    this.handles = handles;
    this.nodeOf = nodeOf;
    this.plain = world.query(Position, Velocity);
    this.cascade = world.query(Position, Velocity, Cascade(ChildOf));
    this.sorted = this.plain.sortBy(Order.value);
    this.ordered = this.plain.orderBy(Order.value);
    this.ax = world.accessor(Position.x);
    this.ay = world.accessor(Position.y);
    this.avx = world.accessor(Velocity.x);
    this.avy = world.accessor(Velocity.y);

    // Settled through `entities()`, not `each`: a second callback shape at a
    // query's `each` site makes that call polymorphic and doubles its per-row
    // cost, which would show up as the order being expensive when it is not.
    world.step();
    this.ordered.entities();
    this.walk = this.sorted.entities();
    this.written = Uint32Array.from(s.rank); // `Order` as storage last saw it
  }

  chunks(out) {
    const { nodeOf } = this;
    for (const chunk of this.plain.chunks()) {
      const { x, y } = chunk.get(Position);
      const { x: cvx, y: cvy } = chunk.get(Velocity);
      for (let i = 0, n = chunk.length; i < n; i++) {
        x[i] += cvx[i] * DT;
        y[i] += cvy[i] * DT;
        if (out !== undefined) {
          out.push(nodeOf.get(chunk.entity(i)));
        }
      }
    }
  }

  each(out) {
    const { nodeOf } = this;
    this.plain.each((p, v, e) => {
      p.x += v.x * DT;
      p.y += v.y * DT;
      if (out !== undefined) {
        out.push(nodeOf.get(e));
      }
    });
  }

  cascadeEach(out) {
    const { nodeOf } = this;
    this.cascade.each((p, v, e) => {
      p.x += v.x * DT;
      p.y += v.y * DT;
      if (out !== undefined) {
        out.push(nodeOf.get(e));
      }
    });
  }

  sortedEach(out) {
    const { nodeOf } = this;
    this.sorted.each((p, v, e) => {
      p.x += v.x * DT;
      p.y += v.y * DT;
      if (out !== undefined) {
        out.push(nodeOf.get(e));
      }
    });
  }

  orderedEach(out) {
    const { nodeOf } = this;
    this.ordered.each((p, v, e) => {
      p.x += v.x * DT;
      p.y += v.y * DT;
      if (out !== undefined) {
        out.push(nodeOf.get(e));
      }
    });
  }

  /** Pages arrive last-first and rows run high to low: that walk is key order. */
  orderedChunks(out) {
    const { nodeOf } = this;
    for (const chunk of this.ordered.chunks()) {
      const { x, y } = chunk.get(Position);
      const { x: cvx, y: cvy } = chunk.get(Velocity);
      for (let i = chunk.length - 1; i >= 0; i--) {
        x[i] += cvx[i] * DT;
        y[i] += cvy[i] * DT;
        if (out !== undefined) {
          out.push(nodeOf.get(chunk.entity(i)));
        }
      }
    }
  }

  accessors(out) {
    const { ax, ay, avx, avy, walk, nodeOf } = this;
    for (let i = 0, n = walk.length; i < n; i++) {
      const e = walk[i];
      ax.set(e, ax.get(e) + avx.get(e) * DT);
      ay.set(e, ay.get(e) + avy.get(e) * DT);
      if (out !== undefined) {
        out.push(nodeOf.get(e));
      }
    }
  }

  /** The dirty path: the tree moved, so `Order` is rewritten and storage resorts. */
  reorder(sparse) {
    const { world, handles, scene, written } = this;
    for (let id = 0; id < scene.n; id++) {
      const rank = scene.rank[id];
      if (sparse && written[id] === rank) {
        continue;
      }
      written[id] = rank;
      world.set(handles[id], Order.value, rank);
    }
    world.step();
    this.orderedChunks(undefined);
  }
}

function contendersOf(s) {
  const graph = new Graph(s);
  const flat = new Flat(s);
  const ecs = new Ecs(s);
  return {
    graph,
    flat,
    ecs,
    list: [
      ['objects', 'recursive walk, children pre-sorted', (o) => graph.recursive(o), true],
      ['objects', 'explicit stack, children pre-sorted', (o) => graph.iterative(o), true],
      ['objects', 'explicit stack, re-sorting each visit', (o) => graph.resorting(o), true],
      ['flat', 'order array -> row (gather)', (o) => flat.gathered(o), true],
      ['flat', 'data laid out in walk order (sequential)', (o) => flat.sequential(o), true],
      ['flat', 'the same, cut into pages of 4096 (by hand)', (o) => flat.paged(o), true],
      ['apecs', 'chunks() — unordered, for reference', (o) => ecs.chunks(o), false],
      ['apecs', 'each() — unordered, for reference', (o) => ecs.each(o), false],
      ['apecs', 'Cascade(ChildOf).each() — depth order only', (o) => ecs.cascadeEach(o), false],
      ['apecs', 'sortBy(Order).each()', (o) => ecs.sortedEach(o), true],
      ['apecs', 'orderBy(Order).each()', (o) => ecs.orderedEach(o), true],
      ['apecs', 'orderBy(Order).chunks()', (o) => ecs.orderedChunks(o), true],
      ['apecs', 'Tier 1 accessors over cached order', (o) => ecs.accessors(o), true],
    ],
  };
}

// ------------------------------------------------------------------ measure

async function time(fn, warmup = 20) {
  for (let i = 0; i < warmup; i++) {
    fn();
  }
  return (await measure(fn, { min_cpu_time: 400e6 })).avg;
}

/** Every ordered contender must reproduce the reference walk exactly. */
function check(built, s) {
  for (const [family, label, fn, isOrdered] of built.list) {
    const visited = [];
    fn(visited);
    if (visited.length !== s.n) {
      throw new Error(`${family} ${label}: visited ${visited.length} of ${s.n}`);
    }
    if (!isOrdered) {
      continue;
    }
    for (let i = 0; i < s.n; i++) {
      if (visited[i] !== s.dfs[i]) {
        throw new Error(
          `${family} ${label}: position ${i} is node ${visited[i]}, expected ${s.dfs[i]}`,
        );
      }
    }
  }
}

async function full() {
  const s = new Scene(arg('branch', 6), arg('roots', 3));
  const built = contendersOf(s);
  check(built, s);
  const { sorted, ordered, cascade } = built.ecs;
  console.log(
    `\n${s.n} nodes, ${DEPTH} levels, branching ${s.branch}, ${s.roots.length} roots — ` +
      'Position += Velocity for every node, in sibling order, once per frame.',
  );
  console.log('order verified for every sibling-ordered contender.');
  console.log(
    `views on a settled frame: sortBy ${sorted.isDirty}, orderBy ${ordered.isDirty}, ` +
      `Cascade ${cascade.isDirty} — nothing is re-sorting inside the loop.\n`,
  );

  const rows = [];
  let floor = Infinity;
  for (const [family, label, fn] of built.list) {
    const avg = await time(() => fn(undefined));
    floor = Math.min(floor, avg);
    rows.push({ family, label, avg });
  }

  let group = '';
  console.log(
    `  ${'contender'.padEnd(44)} ${'ms/frame'.padStart(9)} ${'ns/node'.padStart(8)} ${'×floor'.padStart(7)}`,
  );
  for (const r of rows) {
    if (r.family !== group) {
      group = r.family;
      console.log(`  ${group}`);
    }
    console.log(
      `    ${r.label.padEnd(42)} ${(r.avg / 1e6).toFixed(4).padStart(9)} ` +
        `${(r.avg / s.n).toFixed(1).padStart(8)} ${(r.avg / floor).toFixed(2).padStart(7)}`,
    );
  }
  console.log();
  built.ecs.world.destroy();
}

/** One size, one line of JSON — the child half of `--scale`. */
async function json() {
  const s = new Scene(arg('branch', 6), arg('roots', 3));
  const built = contendersOf(s);
  check(built, s);
  const out = {};
  for (const [, label, fn] of built.list) {
    out[label] = (await time(() => fn(undefined))) / s.n;
  }
  console.log(JSON.stringify({ n: s.n, out }));
  built.ecs.world.destroy();
}

/**
 * The same contenders across five scene sizes. Each size runs in its own
 * process: measured in one, the later sizes inherit the earlier ones' heap and
 * the absolute figures drift by 2x, which would read as a scaling effect.
 */
function scale() {
  const picks = [
    'data laid out in walk order (sequential)',
    'the same, cut into pages of 4096 (by hand)',
    'order array -> row (gather)',
    'recursive walk, children pre-sorted',
    'chunks() — unordered, for reference',
    'orderBy(Order).chunks()',
    'orderBy(Order).each()',
    'sortBy(Order).each()',
    'Tier 1 accessors over cached order',
  ];
  const counts = [];
  const table = new Map(picks.map((p) => [p, []]));
  for (const branch of [3, 4, 6, 9, 12, 15]) {
    const line = execFileSync(process.execPath, [process.argv[1], '--json', '--branch', branch], {
      encoding: 'utf8',
    });
    const { n, out } = JSON.parse(line);
    counts.push(n);
    for (const label of picks) {
      table.get(label).push(out[label]);
    }
  }
  console.log('\nns per node, by scene size — one process per size\n');
  console.log(`  ${'contender'.padEnd(42)}${counts.map((n) => String(n).padStart(9)).join('')}`);
  for (const [label, values] of table) {
    console.log(`  ${label.padEnd(42)}${values.map((v) => v.toFixed(1).padStart(9)).join('')}`);
  }
  console.log();
}

/** What it costs when the order itself changes — the price of a baked layout. */
async function drift() {
  const s = new Scene(arg('branch', 6), arg('roots', 3));
  const built = contendersOf(s);
  check(built, s);
  const { flat, ecs, graph } = built;
  const steady = await time(() => ecs.orderedChunks(undefined));
  const steadyFlat = await time(() => flat.sequential(undefined));

  // 1% of parents swap two children each frame: the order is genuinely stale,
  // and every contender that baked it has to earn it back.
  const random = rng(0x243f6a88);
  const parents = [];
  for (let i = 0, churn = Math.max(1, Math.round(s.n / 100)); i < churn; i++) {
    parents.push((random() * s.n) | 0);
  }

  const rows = [
    ['walk only, order unchanged (orderBy chunks)', steady],
    ['walk only, order unchanged (flat sequential)', steadyFlat],
    [
      'objects: re-sort the lists that moved, then walk',
      await time(() => {
        graph.applyOrder(s, s.reshuffle(parents, random));
        graph.recursive(undefined);
      }),
    ],
    [
      'renumber the tree only (JS pre-order pass)',
      await time(() => {
        s.reshuffle(parents, random);
        s.renumber();
      }),
    ],
    [
      'flat: renumber + rebuild the layout + walk',
      await time(() => {
        s.reshuffle(parents, random);
        s.renumber();
        flat.relayout();
        flat.sequential(undefined);
      }),
    ],
    [
      'apecs: renumber + rewrite every Order + resort + walk',
      await time(() => {
        s.reshuffle(parents, random);
        s.renumber();
        ecs.reorder(false);
      }),
    ],
    [
      'apecs: renumber + rewrite only moved Order + resort + walk',
      await time(() => {
        s.reshuffle(parents, random);
        s.renumber();
        ecs.reorder(true);
      }),
    ],
  ];

  // Everything above ran hundreds of reshuffles; the order must still hold.
  graph.resync(s);
  flat.relayout();
  ecs.reorder(true);
  ecs.walk = ecs.sorted.entities(); // the Tier-1 contender's cached order moved too
  check(built, s);

  console.log(`\n${s.n} nodes — the cost of an order that moved (1% of parents reshuffled)\n`);
  for (const [label, ns] of rows) {
    console.log(
      `  ${label.padEnd(60)} ${(ns / 1e6).toFixed(4).padStart(9)} ms ` +
        `${(ns / steady).toFixed(1).padStart(7)}x a clean frame`,
    );
  }
  console.log();
  ecs.world.destroy();
}

if (flag('json')) {
  await json();
} else if (flag('scale')) {
  scale();
} else if (flag('drift')) {
  await drift();
} else {
  await full();
}
