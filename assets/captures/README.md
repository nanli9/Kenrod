# Captures

Source 3DGS captures. Nothing here is served — these are build inputs. The
converters write the compact clouds the site streams into `public/models/`.

## `cleanply/` — nine layer captures

The automatic mahjong table, trained one layer at a time: the whole machine plus
the eight subassemblies of the explode sequence. All Nerfstudio 1.1.5, cropped by
`clean_splat.py`, binary little-endian, **z-up**, 29k–46k gaussians each.

| file | subject |
|---|---|
| `00_entire_table_clean.ply` | the assembled machine |
| `01_exterior_cabinet_clean.ply` | rail, skirt and pedestal |
| `02_center_column_clean.ply` | lift column and control dome |
| `03_deck_cover_clean.ply` | PET deck with the tile slots |
| `04_wall_builder_clean.ply` | wall builder and lift |
| `05_shuffle_feed_clean.ply` | shuffle drum, pickup wheels, feed |
| `06_turntable_clean.ply` | felted disc on its rollers |
| `07_chassis_frame_clean.ply` | folded steel structural deck |
| `08_power_electronics_clean.ply` | transformer and main board |

**These are gitignored** (~80 MB) — for their size, not because they live
elsewhere. They belong in this folder and nothing in this project reads a path
outside the repo; they are needed only to regenerate `public/models/*-splats.bin`,
never to build or serve the site, and those binaries are committed. Originally
produced by the upstream Blender project's `tools/build_layer_datasets.sh`.

## `layers.json` — the shared spec

Tracked, and the thing that makes the layers usable together. It merges two
sources, copied in once so the build needs no path outside this repo:

- **layout** — each layer's EN/CN title, pitch copy, `order`, `stack_index` and
  `explode_dz` (metres), from the upstream project's `sprites_web.json`.
- **frames** — each layer's true `center` and `bounding_radius` in Blender world
  metres, from its `cameras.json`.

`scripts/build-cad-layers.py` reads the same file for the explode offsets, so the
CAD diagram and the splat walk cannot drift apart on where a layer sits.

The frames matter because **each layer was trained on a camera sphere fitted to
that layer alone** (`tools/layer_sphere.py` centres and sizes the sphere on the
layer's own bbox). So every capture comes out of Nerfstudio centred at the origin
at roughly the same size — converting them one at a time with the default
self-fitting `normalise()` gives nine concentric clouds, not a machine. The
`--place`/`--frame` flags on `model-to-points.mjs` map each layer onto its real
seat inside one shared world instead.

## Building

```sh
# the hero's single model cloud
node scripts/model-to-points.mjs assets/captures/cleanply/00_entire_table_clean.ply \
  public/models/mahjong-points.bin 150000 --up z

# all nine explode layers, in one shared frame, + manifest.json
node scripts/build-layers.mjs
```

Layers land in `public/models/layers/` (also gitignored): ~9.9 MB, 325k splats
total, plus a `manifest.json` carrying the titles, stack order and `explode_dy`
(the metre offsets converted into world units, ready to add to y).

The same run also writes what the hero actually streams — one file, not nine:

- `public/models/layers-splats.bin` — all nine captures concatenated in order,
  **325k splats at full capture quality**, 9.93 MB
- `public/models/layers-index.bin` — 76 B index,
  `[u32 layerCount][per layer: u32 offset, u32 count]`

Nothing is thinned, and the captures are **concatenated, not interleaved**. Both
follow from how the hero uses them: it walks the sequence a capture at a time, so
only one is ever on screen and the per-frame draw is a single capture's worth
(45,522 splats at the largest) however many are in the file. Subsampling would
only degrade the thing the beat exists to show. Keeping each capture contiguous
also means the two alive during a crossfade are one adjacent span, which is what
the renderer sorts and draws.

Small screens take a prefix of each capture instead (`PER_LAYER_MOBILE`), which
thins each one evenly because a capture's own splat order is not spatial.

Verified: every layer seats within **0.04 world units** of the position its CAD
bounding box predicts, on a model 5 units across. The exception is
`06_turntable`, which sits ~0.35 high because the capture is missing the disc's
underside that the CAD bbox includes — its top face, the part you see, is right.

## Where the rest of the pipeline lives

Everything this project needs is inside this folder:

| input | path | tracked? |
|---|---|---|
| 3DGS captures | `assets/captures/cleanply/` | no, ~80 MB |
| CAD source | `assets/cad/xuanyiji_master.blend` | no, ~233 MB |
| layer layout + frames | `assets/captures/layers.json` | yes |
| layer part assignment | `scripts/cad_layers.py` | yes |
| what the site serves | `public/models/` | **yes**, ~18 MB |

The two large source inputs are gitignored for size. Neither is needed to build or
serve the site — only to regenerate what is in `public/models/`, which is committed.
