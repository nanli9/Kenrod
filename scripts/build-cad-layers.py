# Export the eight subassemblies as web-sized PBR meshes for the hero's closing
# exploded diagram.
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b \
#     assets/cad/xuanyiji_master.blend \
#     -P scripts/build-cad-layers.py -- [--inspect] [--budget 60000] [--no-ao]
#
# Everything this needs is inside the repo: the CAD source is assets/cad (gitignored
# for its size, see assets/cad/README.md) and the layer assignment is vendored as
# scripts/cad_layers.py. Nothing reads a path outside this folder.
#
# WHY MESHES AND NOT THE 3DGS CAPTURES. The walk through the machine is photoreal
# on purpose — that is the whole point of capturing it as gaussians, and the
# size-ranked evaporation that reveals each layer is only possible with them. The
# closing shot is the opposite job: it is a DIAGRAM, and its job is to communicate
# structure. Eight photogrammetric captures stacked and viewed small read as soft
# coloured blobs, because that is what a capture trained on one part in isolation
# looks like from three metres away. CAD has crisp edges, exact proportions and the
# SolidWorks colours, which is what makes an exploded view legible.
#
# WHAT THIS FILE CARRIES, AND WHY EACH PIECE IS IN IT. The reference is
# 04_renders/_layer_raw/*.png and photo/exploded_overview.png — Cycles, 128
# samples, AgX. Four things matter, and the first version of this exporter threw
# away all four:
#
#   1. NORMALS. Every one of the 499 meshes carries a `custom_normal` corner
#      attribute — real surface normals that came across with the STEP conversion.
#      Deriving flat ones per fragment instead turns every cylinder, fillet and
#      motor housing into a visible polygon fan.
#   2. METALLIC AND ROUGHNESS. Twelve of the 101 materials are fully metallic
#      (chrome bearings at 0.06 roughness, brass 0.25, aluminium 0.3, steel 0.42),
#      and the roughness spread across the rest runs 0.03 to 0.95. Shade all of it
#      as flat diffuse and no metal in the machine reads as metal.
#   3. OCCLUSION. Baked here rather than in the renderer, because the layers are
#      separated in the diagram: occlusion between two parts of one subassembly is
#      real, occlusion between two layers three metres apart is not.
#   4. INSTANCING, which is what makes the geometry budget affordable at all. The
#      machine is four-fold symmetric and the assembly is full of repeated
#      bearings and rollers, so its 3,098,823 source triangles are only 1,075,119
#      unique — 2.88x over the whole model and 4.15x in the wall builder, whose 198
#      parts are 43 distinct shapes. Blender hands every copy its own mesh
#      datablock, so `obj.data` identity does NOT see this; the local vertex data
#      has to be hashed. Storing each shape once and drawing it with per-instance
#      matrices buys almost three times the on-screen detail for the same bytes.
#
# Writes, next to the splat cloud the walk streams:
#   public/models/cad-layers.bin        12 B/vertex, then per-group index blocks
#   public/models/cad-layers-index.bin  self-describing sidecar: material palette,
#                                       per-layer records, per-group records and
#                                       the instance matrices
#
# Colour, metalness and roughness reach the renderer through a palette indexed by
# one byte per vertex, so there are no textures and no material system.

import bpy
import sys
import os
import re
import json
import time
import struct
import hashlib
import importlib.util
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
INSPECT = '--inspect' in argv
NO_AO = '--no-ao' in argv


def flag(name, default):
    return argv[argv.index('--' + name) + 1] if '--' + name in argv else default


# Triangles STORED per layer. What reaches the screen is this times the layer's
# instancing factor, which runs from 1.0 (the electronics box, all distinct parts)
# to 4.15 (the wall builder), so the effective triangle count is roughly three
# times the budget. Index width is chosen per group — uint16 while a group fits in
# 65536 vertices — so this is a real budget rather than a number pinned by the file
# format.
BUDGET = int(flag('budget', '60000'))
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, 'public/models')
# Floor per shape, so a small bracket cannot collapse to nothing.
#
# This was 90, and at 90 it was the worst thing in the exporter. Layer 04 kept 148
# parts, so the floor alone claimed 13,320 triangles of a 20,000 budget — two
# thirds of it — and the big folded plates that carry the layer's silhouette were
# left to share what remained, at collapse ratios near 0.02. Collapse that hard on
# an open CAD shell drags boundary vertices together, and those plates came out
# visibly torn: notched edges, missing bites, loose shards floating beside them.
# The floor has to stay small enough that ALLOCATION decides where triangles go.
MIN_TRIS = int(flag('min-tris', '40'))
# ...but a part smaller than this in metres is dropped outright. The machine is
# 965 mm across and the diagram stands a few hundred px tall, so a 12 mm spring or
# grub screw lands on about one pixel. Dropped parts are counted and reported,
# because a silent cull in a geometry budget is how a diagram quietly loses the
# thing it was drawn to show.
MIN_SPAN_M = float(flag('min-span', '0.016'))

# Occlusion. The radius is in metres of the real machine: contact darkening between
# stacked plates and inside the cabinet reads at a few centimetres, and a radius
# much larger than that starts shading whole parts by how enclosed they are, which
# on a small layer just looks like dirt.
AO_RADIUS_M = float(flag('ao-radius', '0.045'))
AO_RAYS = int(flag('ao-rays', '48'))

# The shared render world, straight out of assets/captures/layers.json — the same
# frame scripts/build-layers.mjs places every capture into, so the meshes land
# exactly where the gaussians did and the two can cross-fade in place.
#   reorient (--up z): (x, y, z) -> (x, z, -y)
#   render:            (reorient(v) - reorient(frame_centre)) * 5 / frame_size
FRAME_CENTRE = (0.0, 0.0, -0.173427)
FRAME_SIZE = 0.965026
TARGET_SIZE = 5.0


def reorient(x, y, z):
    return (x, z, -y)


WORLD = TARGET_SIZE / FRAME_SIZE
FC = reorient(*FRAME_CENTRE)
# reorient as a matrix. It is a rotation (determinant +1), so it applies to normals
# unchanged.
REORIENT = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])
# Blender world (z-up metres) -> render world, as one 4x4. Instance matrices are
# composed through this, so a group's vertices stay in the part's own local space
# and the transform does all the work.
RENDER_M = np.eye(4)
RENDER_M[:3, :3] = REORIENT * WORLD
RENDER_M[:3, 3] = -np.array(FC) * WORLD

# The CAD explode offsets, from the copy of the layout that lives IN this repo —
# the same file build-layers.mjs reads.
with open(os.path.join(REPO, 'assets/captures/layers.json'), encoding='utf-8') as f:
    SPEC = {L['key']: L for L in json.load(f)['layers']}

# The layer assignment: 140 base names, each listed exactly once, asserted on
# import. VENDORED into this repo as scripts/cad_layers.py rather than read out of
# the Blender project, so the build has no dependency outside this folder. It is
# pure data with no bpy import. Any base name in the blend that is missing from it
# is reported as a warning below rather than silently dropped, so drift is visible.
spec = importlib.util.spec_from_file_location(
    'cad_layers', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cad_layers.py'))
xyj = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xyj)
LAYERS = xyj.LAYERS
BASE2KEY = xyj.BASE2KEY

SUFFIX = re.compile(r'\.\d{3}$')


def base_name(n):
    return SUFFIX.sub('', n)


# ------------------------------------------------------------------- palette
# One entry per material actually used, carrying what a Principled BSDF needs to be
# reproduced: linear base colour, metallic, roughness. 101 materials in the blend,
# so a byte an entry indexes them all with room to spare — which is why this is a
# palette and not five more bytes on every vertex.
DEFAULT_MAT = ((0.72, 0.73, 0.75), 0.0, 0.45)
palette = []
palette_ix = {}


def principled(mat):
    if mat is None:
        return DEFAULT_MAT
    node = None
    if mat.use_nodes and mat.node_tree:
        for n in mat.node_tree.nodes:
            if n.type == 'BSDF_PRINCIPLED':
                node = n
                break
    if node is None:
        c = mat.diffuse_color
        return ((c[0], c[1], c[2]), float(mat.metallic), float(mat.roughness))
    c = node.inputs['Base Color'].default_value
    return (
        (c[0], c[1], c[2]),
        float(node.inputs['Metallic'].default_value),
        float(node.inputs['Roughness'].default_value),
    )


def palette_id(mat):
    name = mat.name if mat is not None else '__default__'
    if name not in palette_ix:
        if len(palette) >= 256:
            raise SystemExit('material palette overflowed one byte')
        palette_ix[name] = len(palette)
        palette.append(principled(mat))
    return palette_ix[name]


# ------------------------------------------------------------------- gather
buckets = {L['key']: [] for L in LAYERS}
unassigned = []
for obj in bpy.data.objects:
    if obj.type != 'MESH':
        continue
    key = BASE2KEY.get(base_name(obj.name))
    if key is None:
        unassigned.append(obj.name)
    else:
        buckets[key].append(obj)

if unassigned:
    print(f'WARNING: {len(unassigned)} mesh objects match no layer, e.g. {unassigned[:6]}')


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def world_bbox(obj):
    pts = np.array([obj.matrix_world @ v.to_4d() for v in
                    [Vector(c) for c in obj.bound_box]])[:, :3]
    return pts.min(axis=0), pts.max(axis=0)


def span_m(obj):
    """Largest world-space bounding-box edge, in metres."""
    mn, mx = world_bbox(obj)
    return float(np.max(mx - mn))


if INSPECT:
    print('\nlayer                    objs  shapes    source tris     unique  factor')
    for L in LAYERS:
        objs = buckets[L['key']]
        t = sum(tri_count(o) for o in objs)
        print(f"{L['key']:<24} {len(objs):>4}   {t:>12,}")
    total = sum(sum(tri_count(o) for o in buckets[L['key']]) for L in LAYERS)
    print(f"\ntotal source {total:,} tris across {sum(len(buckets[k]) for k in buckets)} objects")
    sys.exit(0)


# ------------------------------------------------------------------- instancing
def geometry_key(obj):
    """Identity of a part's SHAPE, independent of where it sits.

    Blender gave every copy of every part its own mesh datablock, so `obj.data`
    identity sees no duplicates at all — 198 of 198 in the wall builder. Hashing
    the local vertex positions and per-face material assignment finds the 43 shapes
    that are actually there. Rounded to a micrometre, which is far below any
    tolerance the CAD was built to and well above float noise.
    """
    me = obj.data
    nv = len(me.vertices)
    co = np.empty(nv * 3)
    me.vertices.foreach_get('co', co)
    npoly = len(me.polygons)
    mi = np.empty(npoly, dtype=np.int32)
    me.polygons.foreach_get('material_index', mi)
    mats = tuple(s.material.name if s.material else '' for s in obj.material_slots)
    h = hashlib.blake2b(digest_size=16)
    h.update(np.round(co, 6).tobytes())
    h.update(mi.tobytes())
    h.update(repr(mats).encode())
    return h.hexdigest()


def similarity(m3):
    """Is this 3x3 a rotation times a single uniform scale?

    Instance matrices are applied to normals in the shader as plain mat3 times
    normal, which is only correct for a similarity — anything with a non-uniform
    scale on it would be lit as though it were unscaled. Parts that fail this are
    not grouped; they are baked on their own with an identity instance, so
    correctness never depends on the assembly being tidy.
    """
    # Singular-value spread, which is scale-free. Comparing m3.T @ m3 against
    # I * s2 with np.allclose does NOT work here: the off-diagonal reference is
    # zero, so rtol contributes nothing and everything rides on atol — and these
    # matrices carry the render world's 5.18x scale, which puts float rounding in
    # the off-diagonals at ~1e-6. That rejected 44 of layer 04's 148 parts as
    # non-uniform when in fact every transform in the assembly is a similarity.
    sv = np.linalg.svd(m3, compute_uv=False)
    return bool(sv.min() > 1e-9 and sv.max() / sv.min() < 1.001)


def group_parts(objs):
    """Bucket parts into shapes, each with its list of instance matrices."""
    groups = {}
    order = []
    loners = []
    for o in objs:
        m = RENDER_M @ np.array(o.matrix_world).reshape(4, 4)
        if not similarity(m[:3, :3]):
            loners.append((o, m))
            continue
        # Mirrored copies reverse triangle winding, so they cannot share a vertex
        # buffer with un-mirrored ones — the renderer culls nothing but does resolve
        # its normal by facing. Split them into their own shape.
        k = (geometry_key(o), np.linalg.det(m[:3, :3]) < 0)
        if k not in groups:
            groups[k] = {'rep': o, 'inst': []}
            order.append(k)
        groups[k]['inst'].append(m)
    out = [groups[k] for k in order]
    for o, m in loners:
        out.append({'rep': o, 'inst': [m], 'loner': True})
    return out


# How much of the frame a shape covers, which is the only thing that says how many
# triangles it deserves. The diagram is seen with the group pitched FINALE_PITCH
# (0.34 rad), so a horizontal face is foreshortened to sin(19.5 deg) = 0.33 of its
# area while vertical faces show at cos(19.5 deg) = 0.94 — the sides of a tall part
# matter MORE than its footprint. Averaged over yaw, since the diagram turns.
VIEW_SIN = 0.334
VIEW_COS = 0.943


def projected_area(mn, mx):
    ex, ey, ez = np.maximum(mx - mn, 1e-6)
    return VIEW_SIN * ex * ey + VIEW_COS * ez * (ex + ey) * 0.5


def allocate(groups, budget):
    """Split a triangle budget across shapes by the screen area they cover.

    A uniform collapse ratio — which is what BUDGET/total_source gives you — spends
    triangles in proportion to how finely each part happened to be tessellated
    upstream. That is close to the opposite of what a picture needs: an intricate
    30,000-triangle roller cage buried inside the mechanism gets thirty times the
    budget of the folded plate whose outline is the only thing readable at this
    size.

    Weighted by INSTANCE COUNT as well as area, because a shape drawn four times
    covers four times the screen for one copy of the bytes — which is exactly why
    the perforated storage track can afford to keep its holes.

    Water-filling: hand back whatever a shape cannot use because it has fewer
    source triangles than its share, redistribute among the rest, repeat.
    """
    n = len(groups)
    if n == 0:
        return []
    src = np.array([float(tri_count(g['rep'])) for g in groups])
    area = np.array([
        projected_area(*world_bbox(g['rep'])) * len(g['inst']) for g in groups
    ])
    floor = np.minimum(src, float(MIN_TRIS))
    pool = max(0.0, budget - float(floor.sum()))
    extra = np.zeros(n)
    room = src - floor
    free = room > 0.5
    for _ in range(24):
        if pool <= 1.0 or not free.any():
            break
        w = area * free
        tot = w.sum()
        if tot <= 0:
            break
        give = np.minimum(pool * w / tot, room - extra)
        extra += give
        moved = float(give.sum())
        pool -= moved
        free = (room - extra) > 0.5
        if moved <= 1.0:
            break
    return list(np.minimum(src, np.ceil(floor + extra)).astype(np.int64))


# ------------------------------------------------------------------- duplicates
# Coincident duplicates in the source assembly, and why they have to go.
#
# The deck cover is modelled TWICE at each of the four player positions: once as
# `2025-09-16.sldasm-Part-1` (28,386 triangles, six materials) and once as
# `FQS-2617-轨道盖板1-1-PET` (9,184 triangles, one green PET). Both occupy the same
# 25.5 mm slab. Two differently triangulated copies of one surface do not resolve
# against each other in a depth buffer at any precision — their interpolated depths
# cross back and forth inside every pixel — so the plate rendered as a dense
# stipple of one part's colour over the other's. Tightening the near plane from 0.1
# to 0.5 changed the speckle count by one pixel in 44,000, which is what confirmed
# it. Cycles does not show it because a ray-triangle hit picks a winner
# deterministically.
#
# Matching boxes exactly is not enough: the PET cover is a millimetre larger in each
# direction than the assembly part it shadows, while sharing the same top plane. The
# criterion is occupancy — near-total overlap between two parts of near-equal size.
# Both halves matter: overlap alone would drop a motor sitting inside its housing,
# and requiring the volumes to be within a third of each other keeps that apart.
DEDUPE_OVERLAP = 0.85
DEDUPE_SIZE_RATIO = 0.66
DEDUPE_MIN_EXT_M = 0.001


def _vol(mn, mx):
    return float(np.prod(np.maximum(mx - mn, DEDUPE_MIN_EXT_M)))


def drop_coincident(objs):
    """Keep the OUTERMOST of each set of parts that occupy the same space.

    Largest box wins, and that is the point — a part enclosed by a near-identical
    one cannot be seen, so dropping it is free, whereas dropping the enclosing one
    changes the picture. Tried "keep the most detailed" first and it was wrong in
    exactly the case that mattered: the PET cover is a millimetre larger than the
    track assembly inside it and carries a third of the triangles, so triangle
    count kept the assembly and the deck came back pale grey where every reference
    render shows it green. Outermost also fixes a consistency trap for free — three
    of the four player positions carry both parts and the fourth carries only the
    cover, so any rule keeping the assembly would leave one rail of four a
    different colour.
    """
    boxes = [world_bbox(o) for o in objs]
    vols = [_vol(*b) for b in boxes]
    order = sorted(range(len(objs)), key=lambda i: -vols[i])
    dead = set()
    keep, dropped = [], []
    for ai in order:
        if ai in dead:
            continue
        keep.append(objs[ai])
        for bi in order:
            if bi == ai or bi in dead:
                continue
            lo = np.maximum(boxes[ai][0], boxes[bi][0])
            hi = np.minimum(boxes[ai][1], boxes[bi][1])
            if np.any(hi < lo):
                continue
            ov = _vol(lo, hi)
            small = min(vols[ai], vols[bi])
            if (ov >= DEDUPE_OVERLAP * small
                    and small / max(vols[ai], vols[bi]) >= DEDUPE_SIZE_RATIO):
                dead.add(bi)
                dropped.append(objs[bi])
    return keep, dropped


# ------------------------------------------------------------------- occlusion
def fibonacci_sphere(k):
    """A deterministic near-uniform direction set. Deterministic matters: the build
    has to produce the same bytes twice, and stochastic AO on 50-vertex parts would
    otherwise shimmer between rebuilds."""
    i = np.arange(k) + 0.5
    phi = np.arccos(1.0 - 2.0 * i / k)
    theta = np.pi * (1.0 + 5.0 ** 0.5) * i
    return np.stack(
        [np.cos(theta) * np.sin(phi), np.sin(theta) * np.sin(phi), np.cos(phi)], axis=1
    )


AO_DIRS = fibonacci_sphere(AO_RAYS)
AO_DIRS_V = [Vector(d) for d in AO_DIRS.tolist()]


def bake_ao(bvh, V, N, radius):
    """Cosine-weighted occlusion per vertex, cast against the whole assembled layer.

    One global direction set is shared by every vertex and each one uses the half of
    it in its own hemisphere, weighted by cosine — that avoids building a tangent
    frame per vertex in Python, which is where a straightforward implementation
    spends all its time.
    """
    w = np.clip(N @ AO_DIRS.T, 0.0, None)
    total = np.maximum(w.sum(axis=1), 1e-6)
    origins = [Vector(o) for o in (V + N * (radius * 0.02)).tolist()]
    occ = np.zeros(len(V))
    for di in range(len(AO_DIRS_V)):
        d = AO_DIRS_V[di]
        col = w[:, di]
        for vi in np.nonzero(col)[0]:
            hit = bvh.ray_cast(origins[vi], d, radius)
            if hit[0] is not None:
                occ[vi] += col[vi] * (1.0 - hit[3] / radius)
    return np.clip(1.0 - occ / total, 0.0, 1.0)


def smooth_on_positions(ao, pos_group, tris, n_groups, rounds=1):
    """One Laplacian pass over vertices welded by POSITION ONLY.

    The vertex buffer is welded on the normal as well, so a hard edge is three or
    four coincident vertices. Smoothing those independently gives each a different
    result from the same 48 rays and the seam shows as a bright line along every
    corner. Collapsing to position first makes the pass continuous across hard
    edges, which is also what occlusion physically is.
    """
    g_sum = np.zeros(n_groups)
    g_cnt = np.zeros(n_groups)
    np.add.at(g_sum, pos_group, ao)
    np.add.at(g_cnt, pos_group, 1.0)
    g = g_sum / np.maximum(g_cnt, 1.0)
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]], axis=0)
    a = pos_group[e[:, 0]]
    b = pos_group[e[:, 1]]
    for _ in range(rounds):
        acc = np.zeros(n_groups)
        cnt = np.zeros(n_groups)
        np.add.at(acc, a, g[b])
        np.add.at(cnt, a, 1.0)
        np.add.at(acc, b, g[a])
        np.add.at(cnt, b, 1.0)
        nb = np.where(cnt > 0, acc / np.maximum(cnt, 1.0), g)
        g = 0.5 * g + 0.5 * nb
    return g[pos_group]


# ------------------------------------------------------------------- extract
def extract(obj, want):
    """Decimate to `want` triangles and return LOCAL positions, normals, materials.

    Local, not world: the instance matrix does the placing, so one copy of the
    vertex data serves every instance. That also means the quantisation grid is the
    part's own bounding box rather than the layer's, which is finer.
    """
    n_tris = tri_count(obj)
    pre = mod = None
    if want < n_tris:
        # Planar dissolve first, at a tight angle limit. On a CAD tessellation it
        # only reclaims about 7% — the upstream tessellator already emits planar
        # faces near-minimally — but what it removes is free, because dissolving
        # coplanar triangles cannot move the silhouette, whereas every collapse can.
        pre = obj.modifiers.new('__web_planar', 'DECIMATE')
        pre.decimate_type = 'DISSOLVE'
        pre.angle_limit = 0.5 * np.pi / 180.0
        mod = obj.modifiers.new('__web_decimate', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = max(1e-4, want / n_tris)
    try:
        # The depsgraph must be re-fetched AFTER the modifiers are added. Hoisting
        # it out silently exported the undecimated mesh — every layer came back at
        # its exact source triangle count.
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        ev = obj.evaluated_get(dg)
        me = ev.to_mesh()
        me.calc_loop_triangles()
        nv, nl, ntri = len(me.vertices), len(me.loops), len(me.loop_triangles)
        if nv == 0 or ntri == 0:
            ev.to_mesh_clear()
            return None
        co = np.empty(nv * 3)
        me.vertices.foreach_get('co', co)
        co = co.reshape(nv, 3)
        # The whole point of carrying normals: the split normals the CAD came with.
        # `corner_normals` is per LOOP, not per vertex, which is what keeps a
        # chamfer sharp and the cylinder beside it smooth.
        ln = np.empty(nl * 3)
        me.corner_normals.foreach_get('vector', ln)
        ln = ln.reshape(nl, 3)
        tv = np.empty(ntri * 3, dtype=np.int32)
        me.loop_triangles.foreach_get('vertices', tv)
        tv = tv.reshape(ntri, 3)
        tl = np.empty(ntri * 3, dtype=np.int32)
        me.loop_triangles.foreach_get('loops', tl)
        tl = tl.reshape(ntri, 3)
        tm = np.empty(ntri, dtype=np.int32)
        me.loop_triangles.foreach_get('material_index', tm)
        slots = obj.material_slots
        ids = (np.array([palette_id(s.material) for s in slots], dtype=np.int32)
               if len(slots) else np.array([palette_id(None)], dtype=np.int32))
        tm = np.clip(tm, 0, len(ids) - 1)
        P = co[tv].reshape(-1, 3)
        N = ln[tl].reshape(-1, 3)
        M = np.repeat(ids[tm], 3).astype(np.int64)
        ev.to_mesh_clear()
        return fix_winding(P, N, M)
    finally:
        if mod is not None:
            obj.modifiers.remove(mod)
        if pre is not None:
            obj.modifiers.remove(pre)


# Winding, made trustworthy so the renderer can cull backfaces.
#
# The diagram draws about a million triangles. Drawing it DoubleSide rasterises
# every one of them twice, and the only reason the shader did that was a comment
# claiming decimated CAD shells could not be trusted to be consistently wound.
# Measured, they very nearly are — 99.94% agreement between each triangle's
# geometric normal and its own CAD corner normals — so the fix is to correct the
# remaining fraction here rather than pay double forever.
#
# Two separate things have to be true before culling is safe, and only the first is
# about consistency:
#   1. Each triangle's winding agrees with its corner normals. Flip the ones that
#      disagree; these are overwhelmingly the slivers decimation leaves behind.
#   2. The normals point OUT. A shell wound consistently INWARD is perfectly
#      self-consistent and would survive step 1 untouched, then vanish under
#      backface culling and show as a hole. The divergence-theorem signed volume
#      catches it: positive for outward normals, negative for inward.
WIND_STATS = [0, 0, 0]  # triangles flipped, parts reversed, triangles seen


def _reverse(P, N, M, idx):
    for arr in (P, N, M):
        v = arr.reshape(-1, 3, arr.shape[1]) if arr.ndim > 1 else arr.reshape(-1, 3, 1)
        v[idx] = v[idx][:, ::-1]


def fix_winding(P, N, M):
    ntri = len(P) // 3
    WIND_STATS[2] += ntri

    # Step one: make every triangle's winding agree with its own corner normals.
    tri = P.reshape(-1, 3, 3)
    geo = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    avg = N.reshape(-1, 3, 3).mean(axis=1)
    bad = np.sum(geo * avg, axis=1) < 0.0
    if bad.any():
        _reverse(P, N, M, np.nonzero(bad)[0])
        WIND_STATS[0] += int(bad.sum())

    # Step two: check the normals point OUT, now that winding follows them. A shell
    # wound consistently inward is self-consistent and survives step one untouched,
    # then disappears under backface culling. The divergence-theorem volume is
    # positive only for outward normals; if it is negative, reverse the whole part,
    # normals included, so the two stay in agreement.
    tri = P.reshape(-1, 3, 3)
    geo = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    vol = float(np.einsum('ij,ij->i', tri[:, 0], geo).sum() / 6.0)
    if vol < 0.0:
        _reverse(P, N, M, np.arange(ntri))
        N *= -1.0
        WIND_STATS[1] += 1
    return P, N, M


def weld(P, N, M):
    """Weld on position, normal AND material, returning the vertex pick and indices.

    The normal is in the key, and it has to be: welding on position alone collapses
    a cube corner to one vertex, and carrying real normals means that corner is
    three vertices again, one per face — which is the entire reason a chamfer looks
    like a chamfer.
    """
    qp = np.round(P * 1e6).astype(np.int64)
    qn = np.round(N * 32767.0).astype(np.int64)
    key = np.concatenate([qp, qn, M[:, None]], axis=1)
    _, first, inverse = np.unique(key, axis=0, return_index=True, return_inverse=True)
    order = np.argsort(first)
    remap = np.empty(len(first), dtype=np.int64)
    remap[order] = np.arange(len(first))
    return first[order], remap[inverse.reshape(-1)]


def oct_encode(NR):
    """Octahedral normals, 16 bits a component: under a hundredth of a degree of
    error, in 4 bytes instead of 6 or 12. The fold puts the lower hemisphere in the
    corners of the square so both get the full range."""
    an = np.abs(NR).sum(axis=1, keepdims=True)
    pn = NR / np.maximum(an, 1e-12)
    ox = pn[:, 0].copy()
    oy = pn[:, 1].copy()
    neg = pn[:, 2] <= 0.0
    ox[neg] = (1.0 - np.abs(pn[neg, 1])) * np.where(pn[neg, 0] >= 0.0, 1.0, -1.0)
    oy[neg] = (1.0 - np.abs(pn[neg, 0])) * np.where(pn[neg, 1] >= 0.0, 1.0, -1.0)
    return np.clip(np.round(np.stack([ox, oy], axis=1) * 32767.0),
                   -32767, 32767).astype(np.int16)


# ------------------------------------------------------------------- export
verts_all, idx_all = [], []
layer_recs, group_recs, inst_all = [], [], []
vbase = 0
ibase = 0
t_start = time.time()
tot_stored = 0
tot_effective = 0
wind_ok = 0
wind_total = 0

for L in LAYERS:
    all_objs = buckets[L['key']]
    objs = [o for o in all_objs if span_m(o) >= MIN_SPAN_M]
    culled = len(all_objs) - len(objs)
    objs, dupes = drop_coincident(objs)
    if dupes:
        print(f"  {L['key']}: dropped {len(dupes)} coincident duplicate(s), "
              f"{sum(tri_count(o) for o in dupes):,} tris: "
              + ', '.join(sorted({o.name[:38] for o in dupes})))

    groups = group_parts(objs)
    loners = sum(1 for g in groups if g.get('loner'))
    targets = allocate(groups, BUDGET)
    src_tris = sum(tri_count(o) for o in objs)
    uniq_tris = sum(tri_count(g['rep']) for g in groups)

    # Pass one: geometry per shape, welded, still in local space.
    built = []
    for g, want in zip(groups, targets):
        got = extract(g['rep'], int(want))
        if got is None:
            continue
        P, N, M = got
        nl = np.linalg.norm(N, axis=1, keepdims=True)
        N = N / np.maximum(nl, 1e-12)
        pick, idx = weld(P, N, M)
        built.append({'inst': g['inst'], 'P': P[pick], 'N': N[pick], 'M': M[pick],
                      'idx': idx, 'name': g['rep'].name})

    if not built:
        print(f"SKIP {L['key']} — no geometry")
        continue

    # Pass two: one BVH over the whole layer as ASSEMBLED, so occlusion sees the
    # parts around each shape, then bake each shape through its FIRST instance.
    # Under the four-fold symmetry the other three sit in mirror-image
    # neighbourhoods, so one bake serves them all.
    lay_lo = np.array([np.inf] * 3)
    lay_hi = np.array([-np.inf] * 3)
    bvh = None
    if not NO_AO:
        wv, wf, base = [], [], 0
        for b in built:
            for m in b['inst']:
                w = b['P'] @ m[:3, :3].T + m[:3, 3]
                wv.append(w)
                wf.append(b['idx'].reshape(-1, 3) + base)
                base += len(w)
        WV = np.concatenate(wv)
        WF = np.concatenate(wf)
        bvh = BVHTree.FromPolygons([Vector(v) for v in WV.tolist()],
                                   [tuple(t) for t in WF.tolist()], all_triangles=True)
        t0 = time.time()

    gbase = len(group_recs)
    for b in built:
        m = b['inst'][0]
        m3 = m[:3, :3]
        # World-space copy of this shape at its first instance, for AO and for the
        # winding check. Vertices themselves stay local.
        W = b['P'] @ m3.T + m[:3, 3]
        NW = b['N'] @ m3.T
        NW = NW / np.maximum(np.linalg.norm(NW, axis=1, keepdims=True), 1e-12)
        for mm in b['inst']:
            pts = b['P'] @ mm[:3, :3].T + mm[:3, 3]
            lay_lo = np.minimum(lay_lo, pts.min(axis=0))
            lay_hi = np.maximum(lay_hi, pts.max(axis=0))

        tris = b['idx'].reshape(-1, 3).astype(np.int32)
        # Does winding agree with the normals? Measured, not assumed: the previous
        # shader carried a comment asserting the pessimistic answer and nobody had
        # checked.
        tri = W[tris]
        geo = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        geo = geo / np.maximum(np.linalg.norm(geo, axis=1, keepdims=True), 1e-12)
        wind_ok += int(np.sum(np.sum(geo * NW[tris].mean(axis=1), axis=1) > 0.0))
        wind_total += len(geo)

        n_verts = len(b['P'])
        if NO_AO:
            ao = np.ones(n_verts)
        else:
            qpos = np.round(b['P'] * 1e6).astype(np.int64)
            _, pos_group = np.unique(qpos, axis=0, return_inverse=True)
            pos_group = pos_group.reshape(-1)
            ao = bake_ao(bvh, W, NW, AO_RADIUS_M * WORLD)
            ao = smooth_on_positions(ao, pos_group, tris, int(pos_group.max()) + 1)

        # Quantise positions into this SHAPE's own local bounding box. 16 bits over
        # a half-metre part is 8 micrometres, orders of magnitude below anything the
        # diagram can show, and halving the position from 12 bytes to 6 is what pays
        # for the normals.
        lo = b['P'].min(axis=0)
        ext = np.maximum(b['P'].max(axis=0) - lo, 1e-9)
        q = np.clip(np.round((b['P'] - lo) / ext * 65535.0), 0, 65535).astype(np.uint16)
        oct16 = oct_encode(b['N'])

        # 12 B/vertex: pos u16x3, normal oct i16x2, material u8, ao u8.
        vb = np.empty((n_verts, 12), dtype=np.uint8)
        vb[:, 0:6] = q.view(np.uint8).reshape(n_verts, 6)
        vb[:, 6:10] = oct16.view(np.uint8).reshape(n_verts, 4)
        vb[:, 10] = b['M'].astype(np.uint8)
        vb[:, 11] = np.clip(np.round(ao * 255.0), 0, 255).astype(np.uint8)
        verts_all.append(vb.tobytes())

        iw = 2 if n_verts <= 65536 else 4
        # Pad so a uint32 block starts 4-byte aligned; the renderer takes a typed
        # array view straight over these bytes and a misaligned offset throws.
        while ibase % 4:
            idx_all.append(b'\0')
            ibase += 1
        ib = b['idx'].astype(np.uint16 if iw == 2 else np.uint32).tobytes()
        idx_all.append(ib)

        group_recs.append(dict(vbase=vbase, nverts=n_verts, ibyte=ibase,
                               nidx=len(b['idx']), iw=iw, ninst=len(b['inst']),
                               lo=lo, ext=ext, ibase_inst=len(inst_all)))
        for mm in b['inst']:
            inst_all.append(mm)
        vbase += n_verts
        ibase += len(ib)
        tot_stored += len(b['idx']) // 3
        tot_effective += (len(b['idx']) // 3) * len(b['inst'])

    if not NO_AO:
        print(f"  ao {L['key']:<22} {len(built):>3} shapes, {time.time() - t0:>5.1f}s")

    sp = SPEC.get(L['key'], {})
    stored = sum(group_recs[i]['nidx'] // 3 for i in range(gbase, len(group_recs)))
    eff = sum(group_recs[i]['nidx'] // 3 * group_recs[i]['ninst']
              for i in range(gbase, len(group_recs)))
    layer_recs.append(dict(key=L['key'], gbase=gbase, ngroups=len(group_recs) - gbase,
                           lo=lay_lo, hi=lay_hi,
                           explode_dz=float(sp.get('explode_dz', 0.0)),
                           stack_index=float(sp.get('stack_index', -1)),
                           stored=stored, eff=eff))
    print(f"{L['key']:<22} {len(objs):>3}/{len(all_objs):<3} parts ({culled:>2} culled) "
          f"{len(built):>3} shapes{'' if not loners else f' +{loners}L'}  "
          f"src {src_tris:>8,} uniq {uniq_tris:>8,} -> stored {stored:>7,} "
          f"drawn {eff:>8,} ({eff / max(1, stored):.2f}x)")

os.makedirs(OUT, exist_ok=True)
blob = b''.join(verts_all) + b''.join(idx_all)
vbytes = sum(len(b) for b in verts_all)
with open(os.path.join(OUT, 'cad-layers.bin'), 'wb') as f:
    f.write(blob)

# Sidecar, self-describing so the renderer needs no JSON fetch. The magic word
# carries the version: anything that is not CAD4 is refused rather than guessed at.
#   'CAD4' u32
#   u32 layerCount, groupCount, instanceCount, vertexBlockBytes, vertexStride,
#       paletteCount
#   palette:  per entry f32 r, g, b (LINEAR), u8 metallic, u8 roughness, u16 pad
#   layers:   u32 groupBase, nGroups; f32 explode_dz, stackIndex,
#             f32 bboxMin xyz, bboxMax xyz                              (40 B)
#   groups:   u32 vbase, nverts, ibyte, nidx, indexBytes, ninst, instBase;
#             f32 quantOrigin xyz, quantExtent xyz                      (52 B)
#   instances: f32[12] each, a 3x4 row-major affine local -> render world (48 B)
side = bytearray(b'CAD4')
side += struct.pack('<6I', len(layer_recs), len(group_recs), len(inst_all),
                    vbytes, 12, len(palette))
for rgb, metal, rough in palette:
    side += struct.pack('<3f2BH', rgb[0], rgb[1], rgb[2],
                        int(round(min(1.0, max(0.0, metal)) * 255)),
                        int(round(min(1.0, max(0.0, rough)) * 255)), 0)
for e in layer_recs:
    side += struct.pack('<2I8f', e['gbase'], e['ngroups'],
                        e['explode_dz'], e['stack_index'],
                        e['lo'][0], e['lo'][1], e['lo'][2],
                        e['hi'][0], e['hi'][1], e['hi'][2])
for g in group_recs:
    side += struct.pack('<7I6f', g['vbase'], g['nverts'], g['ibyte'], g['nidx'],
                        g['iw'], g['ninst'], g['ibase_inst'],
                        g['lo'][0], g['lo'][1], g['lo'][2],
                        g['ext'][0], g['ext'][1], g['ext'][2])
for m in inst_all:
    side += struct.pack('<12f', *[float(v) for v in m[:3, :4].reshape(-1)])
with open(os.path.join(OUT, 'cad-layers-index.bin'), 'wb') as f:
    f.write(bytes(side))

print(f"\ncad -> public/models/cad-layers.bin  {len(blob) / 1048576:.2f} MB "
      f"in {time.time() - t_start:.0f}s")
print(f"  {len(layer_recs)} layers, {len(group_recs)} shapes, {len(inst_all)} instances, "
      f"{len(palette)} materials")
print(f"  stored {tot_stored:,} tris -> {tot_effective:,} drawn "
      f"({tot_effective / max(1, tot_stored):.2f}x from instancing)")
print(f"  vertex block {vbytes / 1048576:.2f} MB, index block "
      f"{(len(blob) - vbytes) / 1048576:.2f} MB, sidecar {len(side) / 1024:.1f} KB")
print(f"  winding agrees with normals on {100.0 * wind_ok / max(1, wind_total):.2f}% "
      f"of {wind_total:,} stored triangles after correction "
      f"({WIND_STATS[0]:,} triangles re-wound, {WIND_STATS[1]} parts reversed)")
metals = sum(1 for _, m, _ in palette if m > 0.5)
print(f"  palette: {metals} metallic of {len(palette)}, roughness "
      f"{min(r for _, _, r in palette):.2f}-{max(r for _, _, r in palette):.2f}")
