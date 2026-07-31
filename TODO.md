# Kenrod site — what's left to do

Quick status + the exact steps for the next work session. The scroll hero
(text → 3D model particles → tear-apart, anime.js style) is **done and working**.
Everything below is content/assets you still need to supply.

---

## 1. Product hero — DONE ✅ (superseded, kept for the reasoning below)

The hero no longer shows a placeholder. It streams nine real 3DGS captures of the
machine and closes on an exploded CAD diagram; every input now lives inside this
repo (`assets/captures/`, `assets/cad/`) and nothing reads a path outside it. See
`assets/captures/README.md` and `assets/cad/README.md` for the current pipeline.

The rest of this section describes the two options that were weighed at the time —
option A (photoreal splat) is what shipped. Kept because the constraints it lists
about `.ply` export and cropping still apply to any re-capture.

### Option A — photoreal 3D Gaussian Splat (recommended, "particles from the real product")
1. Record a phone video orbiting the **real S300 table** (2–3 passes at different
   heights, even lighting, avoid motion blur).
2. Process it into a splat: **Luma AI / Polycam / KIRI Engine / Postshot**.
3. Crop to just the table (remove the room), then **export `.ply`**
   (raw `.ply` — NOT `.splat`/`.ksplat`; those drop the per-point colour I need).
4. Run:
   ```bash
   node scripts/model-to-points.mjs capture.ply public/models/mahjong-points.bin 20000 --up y
   ```
   - Loads sideways? try `--up z` or `--up -y`, and/or `--yaw 90`.
   - Grainy / floaters? raise `--min-alpha 0.4`.
   - This also writes `public/models/mahjong-points-colors.bin` → the hero
     automatically uses the real product colours.
5. **Send Claude the `.ply`** to confirm orientation/cleanup (parser is verified
   on a synthetic file but not yet on a real capture).

### Option B — the complete CAD model (when it's finished)
```bash
node scripts/model-to-points.mjs <complete-model.stl> public/models/mahjong-points.bin 14000
```
Must be a **binary STL**. (Grey model, no photoreal colour — uses a brand gradient.)

---

## 2. Products section — copy still placeholder
In `messages/en.json` and `messages/zh.json`:
- Replace `Sample Product A/B/C` names + descriptions with real products.

Photos are **done**: the six `Weixin Image_*.jpg` files were renamed to
`product-1.jpg` … `product-6.jpg` and the cards use 1 / 5 / 3 (the ones without
big baked-in poster text — 2 and 4 carry large marketing captions). Swap the
paths in `PRODUCT_IMAGES` (`src/components/HomeClient.tsx`) if you prefer others.

## 2b. About stats — PLACEHOLDER NUMBERS ⚠️
The stats band in the About section (`about.stat1..4` in both message files)
ships made-up figures ("10+ years", "6 series", "100% QC", "48h response").
**Replace with real company numbers before launch.**

---

## 3. Real links & contact info — everything is `#` / placeholder
In `src/components/HomeClient.tsx`:
- **Store buttons** (`ProductsSection`): Shopify + Amazon URLs (currently `href="#"`).
- **Social icons** (`ContactSection`): WeChat, Instagram, LinkedIn, Facebook (all `href="#"`).

In `messages/en.json` + `messages/zh.json`:
- `contact.email_address` (now `info@kenrod.com`)
- `contact.address` and `footer.address` (now "Factory Address Placeholder")

---

## 4. Optional polish
- ~~Add a "loading…" state on the hero while the model `.bin` fetches.~~ Done.
- Tune the animation beats — the scroll budget at the top of
  `src/components/three/ScrollScene.tsx`: `B_WORD`, `B_MORPH`, `B_TABLE`,
  `B_WALK`, `B_FINALE`, `B_HOLD`. They are SHARES and must sum to 1; `HERO_VH`
  sets how much page they are shares of. Every other progress constant is
  derived from them.
  Note: the assembly beat plays **on load** (time-driven, `INTRO_SECONDS`);
  scroll drives the timeline from the formed word onward.
- Adjust the model's resting tilt: `grp.rotation.x` in `ScrollScene.tsx`.
- **Mobile: the caption overlaps the model.** On phones the caption is
  bottom-anchored over a canvas that is centred on the full viewport, so the body
  copy sits on top of the geometry for the whole walk and the diagram. Predates
  the inspection work and needs a layout decision (reserve the caption's height
  the way the desktop reserves its column, or put a scrim behind the text).

---

## How the hero works (reference)
- Text is rasterized → particles; the 3D model is preprocessed **offline** into a
  tiny point cloud (`public/models/mahjong-points.bin`, ~164 KB) by
  `scripts/model-to-points.mjs`. No heavy STL/GLB is shipped to the browser.
- Timeline: assemble text → hold → morph into the machine → walk the nine
  captures apart → settle into the exploded CAD diagram → **hold it, interactive**.
- The hold beat (`B_HOLD`, ~120vh) is where nothing animates and the diagram
  takes a pointer: hovering a subassembly lights it and drops the other seven,
  clicking one isolates it and hands it to the pointer to turn freely, and the
  rail on the right does the same thing for a keyboard.
- **With a part open, scroll no longer moves the page** — the wheel, a vertical
  swipe and the arrow keys step through the stack and wrap. The ways out are
  Escape, the caption's own control, a click on empty frame, and any rail entry;
  `CYCLE_*` at the top of the file tunes the thresholds. If this ever feels like
  a trap in testing, that block is the one to relax.
- Picking is a ray against the eight layer BOXES, not the geometry — the explode
  guarantees they do not overlap, so it is exact and costs nothing. The isolated
  framing fits a bounding SPHERE, which is what makes free rotation possible
  without the part rescaling as it is turned.
- The diagram is drawn into a multisampled render target and blitted down
  (`DiagramMsaa`), and gets a pixel budget of its own — neither applies to the
  rest of the hero, because the splat pass is fill-rate bound and this one is not.
  Both step down with the quality governor (`MSAA_BY_LEVEL`, `GOV_DPR`).
- Run locally: `npm run dev` → http://localhost:3000 (scroll slowly).

## What the diagram beat costs, and the three things holding it down

Measured with `EXT_disjoint_timer_query_webgl2` in headless Chrome on the real
GPU (AMD Renoir iGPU), 1440x900 at devicePixelRatio 2. GPU milliseconds per
frame, median: word/morph 1.5, walk 2.0, **diagram 4.4**. It is the most
expensive beat on the page by roughly 2x and always will be — 1.1M triangles
across 122 draw calls, against 71k for the wordmark.

Three levers, all of them in `ScrollScene.tsx`, and all three matter:

1. **`PIXEL_BUDGET_DIAGRAM`** — was 4.8 Mpx and is now 3.4. Multisampling costs
   per pixel, so resolution buys it four times over; the two levers were both
   pointed at the same aliasing and the resolution half was the expensive one.
   5.4 ms -> 4.4 ms for 4% more softness. The table of what each combination
   costs is in the comment above the constant.
2. **Warm-up (`warm`, and the `compileAsync` beside it)** — the CAD is 19.3 MB of
   vertex buffers across 720 of them, and left alone every one uploaded on the
   single frame the diagram is first drawn, with the shader linking beside it.
   Traced through the handover that was three 67 ms frames and 4.2% of frames
   missing vsync; it is now 0.9% and nothing above 50 ms. The buffers go up
   during the walk, ~600 KB a frame, by drawing each shape into a 1x1 render
   target. **If the diagram ever grows, this is the thing to keep an eye on** —
   `WARM_BYTES` is the pacing.
3. **The idle check (`Idle`, and the arrival thresholds in `damp` /
   `driveScroll`)** — the hold beat is a still picture by design, so once the
   spring, the pointer parallax and every damped interaction state have arrived,
   DiagramMsaa stops drawing. Measured 0 draw calls per frame with the pointer
   parked, and the picture survives being left alone because the compositor
   keeps the last frame. **The comparison is exact**, which is why `damp` and the
   scroll spring snap to their targets rather than approaching forever — anything
   that keeps changing in the twelfth decimal place puts the beat back to 60 fps
   of identical million-triangle frames. Add per-frame motion to this beat and it
   has to go into the `sig` sum or it will not be drawn.

Re-measure with `EXT_disjoint_timer_query_webgl2` (available in Chrome by
default; launch with `--disable-gpu-vsync --disable-frame-rate-limit` or every
number is 16.7 ms), wrapping rAF(N) to rAF(N+1).
