# Captures

Source 3DGS captures. Nothing here is served — these are build inputs for
`scripts/model-to-points.mjs`, which writes the compact cloud the hero streams
(`public/models/mahjong-points-splats.bin`).

## `splat_clean.ply`

The automatic mahjong table, captured in Nerfstudio 1.1.5 and cropped by
`clean_splat.py`. Binary little-endian, 37,020 gaussians, **z-up** (the header's
`comment Vertical Axis: z`, confirmed by eyeballing the projection — see the
`--up` warning in the script header).

Regenerate the hero cloud after re-exporting the capture:

```sh
node scripts/model-to-points.mjs assets/captures/splat_clean.ply public/models/mahjong-points.bin 150000 --up z
```

35,382 of the 37,020 gaussians clear the default `--min-alpha 0.25`, giving a
1.08 MB cloud. That is under both hero budgets (150k desktop / 40k mobile), so
every splat renders; a denser hold needs a denser capture, not a bigger count
argument.
