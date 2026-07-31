# CAD source

`xuanyiji_master.blend` — the XuanYiJi automatic mahjong table as converted from
SolidWorks STEP, 499 mesh objects across 101 materials, ~233 MB.

**Gitignored for its size, not because it lives elsewhere.** It belongs in this
folder: nothing in this project reads a path outside the repo. It is needed only to
regenerate `public/models/cad-layers*.bin`, never to build or serve the site — those
binaries are committed.

## What the exporter takes from it

`scripts/build-cad-layers.py` reads three things, all of which have to be present:

- **Geometry**, with the `custom_normal` corner attribute every object carries.
  Those are real CAD surface normals from the STEP conversion; without them the
  diagram is drawn from flat per-triangle normals and every cylinder and fillet
  becomes a visible polygon fan.
- **Principled BSDF base colour, metallic and roughness** per material. Twelve
  materials are fully metallic — chrome bearings at 0.06 roughness, brass 0.25,
  aluminium 0.30, blackened steel 0.42 — and none of the metal in the machine reads
  as metal without them.
- **Object transforms**, which are all similarities (rotation times one uniform
  scale). The exporter asserts this and falls back to baking a part on its own if
  one ever is not, because the renderer applies instance matrices to normals as a
  plain `mat3`.

The layer assignment is *not* read from here — it is vendored as
`scripts/cad_layers.py` so the build needs nothing but the blend itself.

## Rendering reference

The shading target is this project's own Cycles output: Cycles at 128 samples, AgX
view transform with the Medium High Contrast look, three area lights (`L_Key` 210 W,
`L_Fill` 38 W, `L_Rim` 95 W) over a Nishita sky at strength 0.13, floor hidden. The
renderer reproduces that rig analytically; see `CAD_FRAG` in
`src/components/three/ScrollScene.tsx`.

## Regenerating

    /Applications/Blender.app/Contents/MacOS/Blender -b assets/cad/xuanyiji_master.blend \
      -P scripts/build-cad-layers.py -- [--budget 60000] [--no-ao] [--inspect]

Takes about 40 s including the occlusion bake. `--no-ao` skips the bake for quick
iteration; `--inspect` reports per-layer triangle counts without writing anything.
