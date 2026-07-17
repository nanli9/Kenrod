# Kenrod site — what's left to do

Quick status + the exact steps for the next work session. The scroll hero
(text → 3D model particles → tear-apart, anime.js style) is **done and working**.
Everything below is content/assets you still need to supply.

---

## 1. Product hero — swap the placeholder model for the real one  ⭐ main next step

The hero currently shows a **placeholder**: a point cloud sampled from the
incomplete CAD frame (`~/Desktop/model/source_models/XC-14-36kuang_simplified.stl`).
Two ways to upgrade it — **no app code changes**, just regenerate the `.bin`:

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
- Tune the animation beats — constants at the top of
  `src/components/three/ScrollScene.tsx`:
  `ASSEMBLE_END`, `MORPH_START`, `MORPH_END`, `BLAST_START`.
  Note: the assembly beat now plays **on load** (time-driven, `INTRO_SECONDS`);
  scroll drives the timeline from the formed word onward.
- Adjust the model's resting tilt: `grp.rotation.x` in `ScrollScene.tsx`.

---

## How the hero works (reference)
- Text is rasterized → particles; the 3D model is preprocessed **offline** into a
  tiny point cloud (`public/models/mahjong-points.bin`, ~164 KB) by
  `scripts/model-to-points.mjs`. No heavy STL/GLB is shipped to the browser.
- Timeline: assemble text → hold → morph into the model (rotating) → hold → explode.
- Run locally: `npm run dev` → http://localhost:3000 (scroll slowly).
