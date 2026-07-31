'use client';

import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

// The machine as nine captures in one file: the assembled table, then each
// subassembly, all seated in a shared frame. The hero walks it a capture at a
// time as the page scrolls. Written by scripts/build-layers.mjs; the index says
// where each capture starts. Preferred source — the single-capture files below
// still work and still give the old radial blast if this one is missing.
// Cache-busting stamp on every model URL. These files are ~17 MB together and
// they change only when their build script is re-run, so next.config.ts serves
// them `immutable` for a year — which means a rebuilt binary at the same URL
// would never be picked up. BUMP THIS whenever any .bin under public/models is
// regenerated; it is the only thing that invalidates a returning visitor.
const MODEL_REV = '1';
const rev = (u: string) => `${u}?v=${MODEL_REV}`;

const LAYERS_URL = rev('/models/layers-splats.bin');
const LAYERS_INDEX_URL = rev('/models/layers-index.bin');

// The closing exploded diagram, as CAD rather than as captures. The walk through
// the machine is photoreal because that is what gaussians are for; the diagram is
// the opposite job — it exists to be READ, and eight photogrammetric captures
// stacked and viewed small are soft coloured blobs, because that is what a
// capture trained on one part in isolation looks like from three metres away.
// This is the same geometry the reference render was made from: crisp edges,
// exact proportions, the SolidWorks colours. Written by
// scripts/build-cad-layers.py; the sidecar carries the CAD explode offsets, so
// the diagram's layout comes out of the file rather than being guessed here.
// Optional — if either half is missing the hero simply ends on the walk.
const CAD_URL = rev('/models/cad-layers.bin');
const CAD_INDEX_URL = rev('/models/cad-layers-index.bin');

// Real gaussians from a 3DGS capture: 32 bytes/splat (pos, scale, rgba, quat).
// Written by scripts/model-to-points.mjs from a .ply.
const SPLAT_URL = rev('/models/mahjong-points-splats.bin');
// Fallback for the CAD STL, which has no gaussian params: plain Float32 xyz.
// Those get synthesised into small isotropic gaussians + a steel height gradient
// so both sources feed the same splat renderer.
const POINTS_URL = rev('/models/mahjong-points.bin');

// 150k splats is a desktop budget: alpha-blended overdraw plus a per-frame depth
// sort. Small screens get a prefix of the cloud (file order is not spatially
// sorted, so a prefix is an even subset).
const MAX_SPLATS_DESKTOP = 150000;
const MAX_SPLATS_MOBILE = 40000;
// Per capture, when the cloud is a sequence. Phones keep every capture but at a
// lower density — the whole sequence is ~325k splats and the float texture that
// backs it would be ~42 MB at full quality.
const PER_LAYER_MOBILE = 14000;

// ------------------------------------------------------------- render scale
// This pass is fill-rate bound and nothing else. Every gaussian is an
// alpha-blended quad, the frame is many of them deep, and the cost tracks the
// BACKING STORE — not the splat count, and not the CSS box.
//
// Which makes device pixel ratio the wrong thing to size the canvas by. A 4K
// laptop panel reports dpr 2.5 against a ~1485x745 CSS viewport, so clamping
// the ratio to 2 asks for 4.4 Mpx of gaussians — for a hero that occupies the
// same number of CSS pixels as it does on any other machine.
//
// Measured on one (4K at 2.5x, Chrome on an AMD Renoir iGPU), wheel-scrolling
// the hero end to end. It is a TAIL story, not a mean one: the median frame was
// 16.7 ms before and after, but at 4.4 Mpx the 90th percentile was 50 ms and the
// 99th was 167 ms, and 16.9% of frames missed vsync. At 1.9 Mpx: p90 33 ms,
// p99 100 ms, 13.0% missed. Same splats, same beats — the difference is the
// frames that arrive late enough to see.
//
// So size by a PIXEL BUDGET instead. Soft gaussians have no edges to alias,
// which is already why `antialias` is off on the context; that same fact is why
// letting the browser upscale a slightly smaller buffer costs nothing you can
// see while buying the frame back very nearly linearly.
//
// Never below 1, though. The budget is a CEILING for hidpi panels, not a
// downgrade for the ordinary dpr-1 desktop that was rendering 1920x1080 and
// coping fine. Going under 1 is the governor's call, and only once a device has
// produced evidence it needs it.
const PIXEL_BUDGET_DESKTOP = 1_900_000;
const PIXEL_BUDGET_MOBILE = 1_100_000;
const DPR_CAP_DESKTOP = 2;
const DPR_CAP_MOBILE = 1.75;

// The closing diagram gets its own, far larger budget, because it is not the
// pass any of the above was measured on. Everything in that block is about
// alpha-blended gaussians many layers deep; the CAD is opaque geometry with
// early-z, one draw call a shape — and by the time it owns the frame the splat
// mesh is not drawn at all (see splatsGone). Charging a fill-rate budget to a
// pass that is not fill-bound, in exchange for nothing, is what the desktop
// number was doing here.
//
// And it was not a small tax. On a 1440x900 CSS box at devicePixelRatio 2 the
// old budget resolves to 1.21, so the diagram rendered at 1742x1089 and the
// browser upscaled it onto 2880x1800 of real pixels — under half the display's
// resolution, on the one beat of the page made of hard silhouettes and
// perforated plate.
//
// The aliasing was only half of what that cost. The fragment shader's specular
// antialiasing widens roughness by the SCREEN-SPACE variance of the normal, and
// on geometry this dense that term saturates its own clamp across most of the
// model at low resolution — so every chrome bearing and brushed plate was being
// forced to roughness ~0.7 and drawn as matte plastic. Resolution is the lever
// for both: variance falls with the square of it.
//
// Sized against MSAA, which did not exist when this number was first chosen.
//
// It was 4.8 Mpx — near-native on a dpr-2 laptop — because at the time raising
// resolution was the ONLY lever against the aliasing. DiagramMsaa is a second
// lever on the same problem, and running both at full tilt is paying twice for
// one thing. Measured on an AMD Renoir iGPU at 1440x900 dpr 2, GPU time for a
// frame of the held diagram (EXT_disjoint_timer_query, median of ~70 frames):
//
//   4.8 Mpx  4x MSAA   5.4 ms     <- what both levers at full tilt cost
//   4.8 Mpx  no MSAA   1.8 ms        so multisampling alone is 3.6 ms of it
//   3.4 Mpx  4x MSAA   4.3 ms     <- here
//   2.6 Mpx  4x MSAA   3.5 ms
//   1.9 Mpx  4x MSAA   3.0 ms
//
// The multisample cost is per PIXEL — clear four samples, resolve four samples —
// so it scales with this number, and buying resolution buys it four times over.
// 3.4 Mpx is 0.81x native on that panel: against the 4.8 Mpx frame, mean gradient
// magnitude over a detail crop falls 4% (5.70 -> 5.48, i.e. that much softer) for
// 33% of the frame back. Dropping MSAA instead would be cheaper still and is the
// wrong trade — it is the one that puts the stair-steps back.
//
// Still a budget rather than "just use devicePixelRatio" for the 4K panel the
// note above was measured on, where native is 12.9 Mpx and no amount of early-z
// makes a million triangles free. Phones are unaffected — they already sit at
// their cap. And the governor rides on top: its rungs land this at 2.9 / 2.4 /
// 2.0 Mpx, and drop the sample count before either.
const PIXEL_BUDGET_DIAGRAM = 3_400_000;

function baseDpr(diagram = false) {
  if (typeof window === 'undefined') return 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const small = w < 820;
  const cap = Math.min(window.devicePixelRatio || 1, small ? DPR_CAP_MOBILE : DPR_CAP_DESKTOP);
  const budget = small
    ? PIXEL_BUDGET_MOBILE
    : diagram
      ? PIXEL_BUDGET_DIAGRAM
      : PIXEL_BUDGET_DESKTOP;
  const fit = Math.sqrt(budget / Math.max(1, w * h));
  return Math.min(cap, Math.max(1, fit));
}

// How tall the hero scrolls. Everything below is a SHARE of this, so the only
// way to give a beat more room in absolute terms is here.
const HERO_VH = 940;

// Scroll budget: what share of the scrolled page each beat gets. These must sum
// to 1, and every progress constant below is derived from them. Written this way
// because the timeline used to be four hand-tuned numbers in progress space that
// had to be kept consistent by arithmetic — and they had drifted into a
// distribution nobody would have chosen on purpose: the word's one-off morph
// into the table ate 30% of the page (122vh) while each of the nine captures
// got 22vh, less than a mouse-wheel flick per subassembly.
//
// At HERO_VH = 940 (840vh of actual scrolling) this is:
//   word    61vh   the lockup, held readable
//   morph   72vh   lockup -> assembled table (was 122vh; it is one transition,
//                  it does not deserve more room than four subassemblies)
//   table   54vh   the whole machine, before it comes apart
//   walk   468vh   the teardown: nine captures -> 52vh each, half hold, half
//                  removal
//   finale  65vh   the parts settle into the exploded diagram
//   hold   120vh   the diagram is finished and NOTHING animates
//
// The hold is the beat the inspection interaction lives in, and it is a beat
// rather than a scroll lock on purpose. The diagram used to be the last 65vh of
// the page and every one of those pixels was still landing parts — there was no
// moment where it sat still, which is exactly the moment a visitor needs in
// order to notice they can point at it. 120vh of scroll where the scene is a
// constant gives them that without taking the wheel away: scrolling still
// leaves the hero, it just passes through a room on the way out.
//
// The five original shares were scaled by 720/840 so every earlier beat keeps
// the SAME absolute height it was tuned at; only the page got longer.
const B_WORD = 0.073;
const B_MORPH = 0.086;
const B_TABLE = 0.064;
const B_WALK = 0.557;
const B_FINALE = 0.077;
const B_HOLD = 0.143;

// Scroll maps onto [ASSEMBLE_END, 1]: the assembly beat is an entrance animation,
// not a scroll beat — at rest the page shows the formed word, never raw scatter.
const ASSEMBLE_END = 0.18;
const SCROLL_SPAN = 1 - ASSEMBLE_END; // the part of progress that scroll drives
const INTRO_SECONDS = 2.4;
// Per-splat assembly delays go up to MAX_FORM_DELAY, so each splat's travel
// window is ASSEMBLE_END - MAX_FORM_DELAY — that way the *last* splat still
// seats exactly at ASSEMBLE_END. Dividing by ASSEMBLE_END instead left the
// word's right edge permanently ~10% short of home once the intro parked
// progress at ASSEMBLE_END.
const MAX_FORM_DELAY = 0.08;
const ASSEMBLE_WINDOW = ASSEMBLE_END - MAX_FORM_DELAY;

const MORPH_START = ASSEMBLE_END + SCROLL_SPAN * B_WORD;
// The morph beat is one splat's travel window plus the stagger tail behind it,
// so the budget buys window * (1 + stagger). The stagger has to be a FRACTION of
// the window, not the flat 0.08 it was: shortening the morph left a fixed 0.08
// tail covering most of it, and the word came apart in a mush instead of a
// ripple. Two things downstream need to know where that tail ends — the capture
// walk must not start inside it, and past it the depth sort can skip the whole
// three-stage lerp.
const MORPH_STAGGER = 0.28;
const MORPH_WINDOW = (SCROLL_SPAN * B_MORPH) / (1 + MORPH_STAGGER);
const MAX_MORPH_DELAY = MORPH_WINDOW * MORPH_STAGGER;
const MORPH_END = MORPH_START + MORPH_WINDOW;
// Single-capture fallback only (the .ply path has nothing to walk through, so it
// still ends on the radial blast). Placed where the walk would otherwise be.
const BLAST_START = MORPH_END + MAX_MORPH_DELAY + SCROLL_SPAN * (B_TABLE + B_WALK * 0.45);

// Model-hold framing. The capture is a table: everything worth showing — the
// playfield, the dealing well, the tiles — is on TOP, so the group pitches
// forward to put the camera ~45 degrees above it. A *negative* pitch here left
// the hero parked under the table looking at its underside and legs.
// Pitch, yaw and fit ride the morph ramp and the turn rides the hold, so all
// four are zero while the word is still readable — the text beat is untouched.
const MODEL_PITCH = 0.75; // rad (~43 deg) of look-down at the playfield
const MODEL_YAW = 0.4; // rad off-axis, so it reads 3/4 rather than flat-on
// Swept across the hold: a drift that shows the table has depth. This was a
// full Math.PI, which spun the capture right past its good side.
const MODEL_TURN = 0.55;
// Pitched 43 deg the table's silhouette is ~6.4 world units against a ~7-unit
// frustum at the zoom peak, and the near legs magnify past that. Fit it.
const MODEL_FIT = 0.88;
// Half the visible height at the model plane with the camera at rest (z = 10,
// fov 50). The rig dollies IN from here and never out, so sizing travel against
// this is the conservative case: a part that clears the frame at rest clears it
// everywhere. Several beats need it, and it used to be re-derived by hand in a
// comment each time.
const CAM_HALF_H = Math.tan((50 * Math.PI) / 360) * 10;

// Layer walk. Once the word has become the assembled table, the rest of the
// scroll steps through the captures: 00 (whole machine) -> 01 -> ... -> 08.
// Only one is ever on screen, so each renders at the capture's full quality.
// Starts after the LAST splat has finished morphing, plus the table beat: the
// morph and the walk used to overlap by a whole morph delay, so captures 01 and
// 02 began coming apart while the word was still assembling into the table.
// Separating them also buys the assembled machine a moment of being whole
// before it is taken apart, and lets the depth sort take its fast path across
// the entire walk (nothing is mid-morph there, so the lerp is dead weight).
const SEQ_START = MORPH_END + MAX_MORPH_DELAY + SCROLL_SPAN * B_TABLE;
// Where the teardown ends and the closing diagram begins. The walk used to run
// to p = 1, which is also why the last capture never got a beat of its own: the
// walk position only reached it at the very last pixel of the page.
const SEQ_END = SEQ_START + SCROLL_SPAN * B_WALK;
// Fraction of each capture's scroll spent handing over to the next; the rest is
// a hold where one capture sits alone and readable.
const SEQ_TRANSITION = 0.5;
// The active capture is scaled to roughly fill the frame — the subassemblies
// range from the whole 5-unit table down to a 1.1-unit control column, and at
// true relative size the small ones would be specks. Clamped, because scaling a
// small capture up too far just magnifies its own sparsity.
// Fitted on the larger half-extent, not the bbox diagonal: a diagonal
// under-scales anything narrow, which left the control column at a third of the
// frame while the table filled it.
const SEQ_FRAME_RADIUS = 2.3;
const SEQ_ZOOM_MIN = 0.85;
// Ceiling on that fit. This used to be 1.5, and the reason was that a bigger
// number meant the two small subassemblies (the control column, the electronics
// box) rescaled the group ~2.9x against their neighbours WHILE its splats were
// dispersing — far and away the most jarring thing in the walk. The fix then was
// to cap the zoom and accept that the small parts read small.
// FRAME_LAG removes the cause instead: the dolly now runs over a capture that is
// standing still, never over one in motion, so a larger swing costs nothing. The
// cap can go back to framing the part rather than protecting the handoff.
const SEQ_ZOOM_MAX = 2.2;
// Share of a capture's beat over which the framing drifts to the next one.
// Deliberately much wider than SEQ_TRANSITION: the splats hand over quickly,
// but a dolly wants to be slow, and nothing says the two have to agree. At 0.85
// the zoom change is spread over ~45vh of scroll instead of ~26vh.
const SEQ_FRAME_EASE = 0.85;
// Where that dolly starts, as a share of the beat. SEQ_TRANSITION (0.5) is where
// the removal begins, so this releases the camera at the same moment and lets it
// finish well into the next capture's hold. See the framing block in useFrame
// for why it must not run any earlier.
const FRAME_LAG = 0.55;

// ---------------------------------------------------------------- teardown
// How one capture becomes the next. The walk is NOT a sequence of swaps: it is
// one continuous CAD explode. Scrolling REMOVES the layer on screen, and the
// next capture is what was underneath it the whole time — which is literally
// true, because all nine captures are seated in one shared world frame.
//
// The two halves of a handoff are deliberately asymmetric, and that asymmetry is
// the entire fix. The old version was a symmetric particle swap: both captures
// in flight at once, both at half alpha, every gaussian in both inflated and
// smeared, escaping radially with a swirl and an arc. Nothing was ever at rest,
// the scatter was unbounded in screen terms (splats crossed the whole page), and
// every handoff had the same vortex shape regardless of what the parts were.
//
// The second version was better but still did not earn the pipeline. It moved a
// part rigidly and cross-blurred the next one in, and BOTH of those are things a
// mesh can do — a rigid translate is a rigid translate, and "blurry then sharp"
// is a depth-of-field pull or a two-pass blur. It also looked bad for the same
// reason: mid-handoff the frame held a solid opaque blob over a blurry mass, two
// unresolvable things at once, with no sharp anchor anywhere.
//
// What a mesh genuinely cannot do is the thing this capture format hands us for
// free: EVERY PRIMITIVE HAS A SIZE, AND THAT SIZE MEANS SOMETHING. A 3DGS
// optimiser spends large gaussians on flat, low-frequency area — painted panels,
// skirts, the featureless outer skin — and small ones on high-frequency detail:
// edges, seams, fastener heads, printed marks. So gaussian scale is a free
// per-primitive frequency channel, already in the file, needing no analysis.
//
// Key opacity to it and a part does not fade, it SKELETONISES. Its surfaces
// evaporate biggest-first while its detail persists, so the shell opens into a
// tracery of its own edges and the mechanism inside shows through the holes. No
// mesh has an equivalent: a triangle has no frequency, and "dissolve the flat
// regions of this surface but keep the detailed ones, in 3D, as geometry" is not
// expressible. Nor is it a texture effect — the surviving detail has to still be
// there in space, occluding and being occluded, not painted on.
//
// Now:
//   LEAVING  the part evaporates IN PLACE, biggest gaussians first, deflating as
//            it goes — so it stops occluding before it starts moving. What is
//            left is a sparse constellation of its own detail, and only that
//            rises out of frame, streaked along its travel.
//   ARRIVING the part does not move and never blurs. It is always at its true
//            covariance, in focus, from the first splat. What ramps is how many
//            of its gaussians EXIST: it densifies coarse-to-fine, the way the
//            capture was actually trained. A mesh cannot be 30% of itself.
//
// So mid-handoff the frame holds one sharp, readable object with a thinning veil
// of the previous one over it. Nothing is ever unresolvable, and the reveal is
// caused by the shell above it becoming porous rather than by a cross-fade.
//
// Baked into the splat texture (changing these needs a reload, not a uniform):
// How far a part travels to leave, measured in frame-heights of ITS OWN framing.
// Not in layer radii: each capture is zoomed to fill the frame (SEQ_ZOOM_*), so
// "three radii" clears the viewport for the whole 5-unit table and does not come
// close for the 1.2-unit control column magnified 1.5x.
const SEQ_EXIT_FRAMES = 1.0;
const SEQ_HEIGHT_BIAS = 0.85; // 0 = pure grain, 1 = a hard top-down order
// How much of the travel is already moving at t=0. A pure square (0 here) is
// what a part being released looks like, but it also means the part has covered
// only a quarter of its exit at the midpoint of the handoff — so it sits on top
// of the layer it is supposed to be revealing for most of the beat. Launching
// with real velocity and easing up from there keeps the "pulled by a jig" read
// and gets the part out of the way in time to see what is underneath.
const SEQ_LAUNCH = 0.4;
// Live uniforms — the evaporation:
// Share of the removal over which the shell has fully evaporated. Well before
// the end, because the lift of the leftover skeleton has to happen inside the
// same beat.
const SEQ_EVAP_END = 0.82;
// Spread of the per-splat evaporation. This is the knob that decides whether the
// part reads as skeletonising or as fading: at 0 every gaussian goes at once (a
// plain fade), at 1 the biggest is gone before the smallest has started.
// It also sets each individual splat's fade window, which is 1 minus this — and
// that coupling is the reason to keep it high. A wide window means most of the
// cloud sits at partial alpha simultaneously, which is mottle; a narrow one means
// each gaussian winks out cleanly and what you see is the ORDER, which is the
// effect. 0.85 fades a splat over 15% of the beat and spreads the sizes across
// the other 85%.
const SEQ_EVAP_STAGGER = 0.85;
// How much top-down ordering is mixed into the size ranking. Kept low on
// purpose — the size signature IS the effect, and blending much scan into it
// turns a frequency dissolve back into a wipe.
const SEQ_EVAP_SCAN = 0.28;
// How far a gaussian shrinks as it evaporates. Without this the big ones bloat
// into soft clouds on their way out and the shell fogs over instead of opening.
const SEQ_DEFLATE = 0.75;
// Where the leftover skeleton starts to rise, as a share of the removal. After
// the evaporation is well under way, so the part is already porous when it moves
// and never drags an opaque mass across the layer it is revealing.
const SEQ_LIFT_START = 0.42;
const SEQ_PEEL = 0.14; // share of the lift spent on the top-first peel
const SEQ_SMEAR = 1.5; // motion streak along the travel direction, in multiples
// The arrival:
const SEQ_REVEAL = 0.62; // share of the arrival spent on the densification
const SEQ_DENS_SCAN = 0.35; // its split: size rank vs top-down scan line
const SEQ_GRAIN = 0.25; // per-splat noise on both, so neither is a hard wipe
// Brand acid on the gaussians mid-evaporation. Kept low: three of these captures
// are largely green felt already, so a heavier acid mix does not read as a front
// sweeping the part, it just oversaturates what is already there.
const SEQ_TINT = 0.09;
// Floor on the density LOD at the deepest point of a handoff. Two captures are
// on screen there, so it is still the busiest frame in the beat — but far less so
// than it used to be, because nothing inflates any more: the leaving part is
// shrinking and thinning the whole way out. This floor is only ever reached by
// splats that HAVE the alpha headroom to pay it back (see the shader).
const SEQ_LOD_MIN = 0.42;
// Shapes the LOD across the handoff. Below 1 it drops early and stays low
// rather than dipping only at the midpoint — the fill peak is not at the
// midpoint but around 0.7, where gaussians are large and still bright.
const SEQ_LOD_CURVE = 0.6;

// ------------------------------------------------------------------ finale
// After the last capture the teardown resolves into the reference drawing: every
// subassembly descends from wherever the walk parked it onto its own seat on the
// explode axis, and the whole exploded machine is held as the closing shot.
//
// The seats come from the CAD. layers.json carries each layer's real explode
// offset (the cabinet lifts 3.43 m, the chassis 0.265 m) because the cabinet
// genuinely has to clear everything under it. Taken literally that stack is 17.7
// units tall against a 5-unit-wide table — a diagram no screen can hold — so the
// CAD's proportions are blended toward even spacing by stack index. That
// compresses it without flattening it, and guarantees no two layers land inside
// each other.
const FINALE_SPAN = 9.2; // world units from the bottom part to the top one
// 0 = the CAD's own proportions, 1 = even spacing. Biased toward EVEN, and tried
// the other way round first: the CAD's real offsets put almost all their spread
// into one gap — the cabinet has to clear everything beneath it, so it sits at
// 17.75 while the seven plates under it share the remaining 12 — and taking those
// proportions literally bunches the whole mechanism into the middle of the frame.
// Even spacing is what makes the seven inner layers readable; the CAD's share is
// what keeps the cabinet's clearance honest.
const FINALE_EVENNESS = 0.65;
// Exposure on the CAD diagram's light rig, in units where the blend's key light
// is 1. Ambient is the sky's share on top, and the occlusion strength is how much
// of the baked AO is actually spent — the bake is physically full-strength, and a
// diagram on a black page wants slightly less than that.
//
// All three were fitted, not picked, against the project's own Cycles render of
// this exact stack (photo/exploded_overview.png, which ships with an object mask)
// by matching the luminance distribution over the model pixels only. At these
// values the two land at mean 164 vs 159, quartiles 113/206 vs 122/204, and mean
// saturation 0.183 vs 0.189. The highlights stay a little softer than Cycles —
// p99 228 vs 242 — which is the specular-antialiasing pass spreading the tightest
// chrome highlights on purpose, and is the right trade on geometry this small.
const CAD_EXPOSURE = 7.0;
const CAD_AMBIENT = 0.28;
const CAD_AO = 0.85;
const FINALE_STAGGER = 0.55; // share of the beat spent on the bottom-up landing
const FINALE_PITCH = 0.34; // rad — flatter than the walk, so the stack separates
const FINALE_TURN = 0.45; // rad of extra yaw across the beat
// Share of the clear band the diagram fills. It can sit this high because the
// band below already holds the whole safety margin — doubling up just left the
// closing shot small in a mostly empty frame.
const FINALE_MARGIN = 0.95;
// The sticky canvas is not all usable. A fixed 7rem gradient (plus the nav) caps
// the top and a fixed 8rem one caps the bottom — see the vignette element — and
// anything under them is invisible whatever the frustum says. The walk never
// noticed because its captures are centred and no taller than the clear middle;
// an eleven-unit stack of parts absolutely does, and fitting it to the raw
// frustum is what put the outer cabinet behind the navigation. In px, because
// that is what the gradients are authored in.
const FINALE_BAND_TOP = 112;
const FINALE_BAND_BOTTOM = 128;
// The horizontal counterpart, and for the same reason: on md+ screens the caption
// column sits BESIDE the model, so the frustum's left edge is not the left edge of
// the usable frame either. Reserving only the top and bottom was enough while the
// caption cleared the geometry by luck of the widths — it does at 1280 and up,
// where a centred `max-w-7xl` pushes the text inward faster than the model grows.
// Between the md breakpoint and ~1200px it does not: measured, a 1000px viewport
// put the model's left edge at 342px against text running to 408px, so 66px of
// geometry sat under the pitch copy. CJK makes it worse than the English does,
// because it fills the column to its full width on every line instead of leaving
// a ragged edge.
//
// The reserved width is MEASURED FROM THE DOM (see captionRef) rather than
// recomputed from the Tailwind classes here — the column is
// `max-w-xs md:max-w-sm` inside a centred `max-w-7xl px-6 lg:px-8`, and
// reproducing that arithmetic in the frame loop would be a second source of truth
// that silently rots the first time the caption's classes change.
const CAPTION_GUTTER = 28; // px of air between the text and the nearest geometry
// How far above its seat each part starts its descent, in world units. It does
// not have to clear the frame, because the part fades in over the same window —
// a long travel from off-screen just makes the landing feel slow.
const FINALE_DROP = 5.5;
// Where the walk's last capture has finished dissolving out, as a share of the
// finale. The photoreal capture and the CAD occupy the same world frame (the
// captures were placed using the CAD's own subject centres), so this is a
// register-true cross-dissolve from the real thing to its drawing rather than a
// cut. Short, because the two look nothing alike and lingering reads as a ghost.
const FINALE_HANDOVER = 0.42;
// The diagram used to be drawn from the splats themselves, which meant the
// closing frame carried all eight captures at once — ~290k splats, by far the
// most expensive frame in the hero, and it needed a whole mip-style LOD (inflate
// the gaussians, thin the count, conserve the ink) just to be affordable. Drawing
// it from CAD instead deletes that problem rather than managing it: 128k
// triangles, one draw call a layer, and the walk's splat span never has to grow
// past the two captures it already holds.
//
// Where the landing finishes. Everything past this is the hold beat, and the
// distinction has to be explicit: `fe` used to be measured against the end of the
// PAGE, so adding a hold beat would silently have stretched a 65vh landing into a
// 185vh one instead of leaving the diagram alone at the end of it.
const FINALE_END = SEQ_END + SCROLL_SPAN * B_FINALE;

// ------------------------------------------------------------- inspection
// The hold beat is interactive: hovering a subassembly lights it and drops the
// other seven back, and clicking one isolates it, flies it to the middle of the
// frame and hands it to the pointer to turn.
//
// Picking is a ray against eight BOXES, not against the geometry. The diagram is
// 1.07M distinct triangles across 120 instanced shapes and a per-triangle raycast
// of that on every pointer move is not affordable — but it is also not needed,
// because the whole point of an exploded diagram is that the parts are pulled
// apart until nothing overlaps anything. Eight disjoint boxes on one axis is an
// exact description of that, and a box is a SUPERSET of the disc inside it, so
// pointing at the empty corner beside the turntable still picks the turntable.
// That reads as forgiving rather than as a miss.
const INSPECT_AT = 0.98; // `fe` past which the diagram accepts a pointer
// How fast the isolation blend and the orbit follow. Both are dampings per
// second, not per frame — see damp().
const FOCUS_RATE = 6;
const ORBIT_RATE = 9;
// Ceiling on the focus zoom, as a MULTIPLE of the whole-diagram framing rather
// than an absolute scale. The layers differ by 3x in radius (the cabinet is the
// whole table, the electronics box is a third of it), so an absolute cap would
// either crop the big ones or leave the small ones tiny — and it would silently
// mean something different the first time FINALE_SPAN or the CAD bounds change.
const FOCUS_GAIN_MAX = 3;
// Radians per pixel of drag, and the pitch stop. Pitch is clamped because there
// is no floor and no sky in this scene: turned past about a third of a turn the
// part is lit from underneath by a rig that assumes it never would be.
const ORBIT_PER_PX = 0.006;
// A quarter turn each way, which is as far as pitch has anywhere to go: at the
// stops you are looking at the part from straight above and from straight
// underneath. Yaw is not clamped at all. Together that is every angle there is,
// and it is affordable because the isolated framing is fitted to a BOUNDING
// SPHERE — see fitR. A sphere is the only bound that is invariant under all of
// it, so nothing can be turned out of frame and, just as importantly, nothing
// rescales while it is being turned.
//
// The first version fitted the projected extents over a narrow pitch range
// instead. That framed each part slightly larger at rest, and it is the wrong
// trade twice over: it caps the drag at a token 26 degrees, and outside the
// range it was sized for the part grows and shrinks under the visitor's own
// hand, which reads as the page fighting them.
const ORBIT_PITCH_MAX = Math.PI / 2;
// A drag has to travel this far (CSS px) before the pointerup stops counting as a
// click. Below it a shaky hand still selects what it was pointing at.
const CLICK_SLOP = 5;
// ------------------------------------------------------------ cycling
// With a part open, scroll stops being page scroll and becomes the control that
// steps through the subassemblies, wrapping at both ends. Nothing about the page
// moves while a part is open — which is a real trap, and is why every other way
// out is kept live and named on screen: Escape, the caption's own control, a
// click on empty frame, and any rail entry.
//
// Wheel deltas are accumulated rather than acted on per event, because a
// trackpad emits a stream of small ones for a single flick; the cooldown is what
// stops that flick from racing through all eight.
const CYCLE_WHEEL = 90; // accumulated deltaY for one step
const CYCLE_SWIPE = 60; // px of vertical drag for one step
const CYCLE_COOLDOWN_MS = 340; // ~ the isolation cross-fade, so each part lands
// The end of the finale on the axis the spring works in (`smooth` — progress with
// the intro's fixed share divided back out), which is what the camera dolly and
// anything else driven off the spring rather than off `p` has to stop at.
const DOLLY_END = (FINALE_END - ASSEMBLE_END) / SCROLL_SPAN;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function clamp01(t: number) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
function easeOutCubic(t: number) {
  return 1 - (1 - t) * (1 - t) * (1 - t);
}
function easeInCubic(t: number) {
  return t * t * t;
}
function smoothstep(t: number) {
  return t * t * (3 - 2 * t);
}

// Frame-rate-independent exponential approach. `lerp(x, target, 0.08)` per
// frame is not a speed, it is a speed per FRAME: the same code converges twice
// as fast on a 120Hz display as on a 60Hz one and crawls on a 30Hz one, so the
// hero's feel changed with whatever monitor it landed on. Rate is per second.
function damp(x: number, target: number, rate: number, dt: number) {
  const v = target + (x - target) * Math.exp(-rate * dt);
  // ARRIVE, rather than approach forever. An exponential never reaches its
  // target: at rate 6 and a 60Hz frame it closes 9% of the remaining gap each
  // frame, so it is still moving in the twelfth decimal place minutes later.
  // Nothing can see that, but the idle-frame check downstream is exact — it
  // asks whether this frame's scene is the same as last frame's — and a value
  // that never stops changing means a diagram nobody is touching re-renders a
  // million triangles forever. Everything damped here is either radians or
  // world units where 1 unit is about 100 px, so this threshold is well under
  // a hundredth of a pixel.
  return Math.abs(v - target) < 1e-4 ? target : v;
}

// One critically damped spring drives the whole scene's scroll. Two independent
// lerps (the cloud at 0.08, the camera at 0.05) meant the camera's zoom always
// trailed the model it was framing — worse the faster you scrolled. A spring
// also beats an exponential here: it carries scroll velocity through, so a fast
// flick keeps moving into the settle instead of decelerating the moment your
// finger stops.
const SCROLL_OMEGA = 11; // rad/s

// ------------------------------------------------------------------- pacing
// The walk is nine captures over 468vh, so one capture's beat is ~52vh — half a
// viewport, and the half of THAT which holds the removal is ~26vh. A trackpad
// fling covers two or three beats before the finger has left the glass, and
// because the scene was a pure function of scroll position, "three beats in
// 200ms" meant three teardowns played in 200ms: a flicker, not an animation.
//
// The fix is two mechanisms, and they only work as a pair:
//
//   SPEED LIMIT  the spring may not carry the scene through the walk faster
//                than the removal reads. Bounds how fast the animation PLAYS.
//   LEASH        scroll itself may not get more than one beat ahead of where
//                the scene actually is. Bounds how far behind the scene can
//                FALL — which is what stops the speed limit from turning into
//                a ten-second lag, and what makes one fling advance exactly
//                one capture rather than queueing five.
//
// Neither alone is enough. The limit without the leash means the page runs away
// from the scene and the two disagree for the rest of the hero; the leash
// without the limit just replays the same too-fast handoff one beat at a time.
//
// Must match layers-index.bin (and assets/captures/layers.json). Both mechanisms
// are expressed in beats, and the walk block in useFrame divides the same span
// by the count it actually loaded, so a mismatch only detunes the pacing —
// it cannot desync the two.
const WALK_CAPTURES = 9;
// The walk, on the axis the spring works in: `smooth`, which is progress with
// the intro's fixed share divided back out (see the `p` line in useFrame).
const WALK_S0 = (SEQ_START - ASSEMBLE_END) / SCROLL_SPAN;
const WALK_S1 = (SEQ_END - ASSEMBLE_END) / SCROLL_SPAN;
const WALK_BEAT = (WALK_S1 - WALK_S0) / WALK_CAPTURES;
// Seconds the scene needs to cross each half of a beat at full tilt. Split,
// because the two halves are not the same thing to look at: the handoff is
// where the evaporation and the lift live and it gets the time, while the hold
// is a static capture with the tail of the previous dolly still running over it
// and may be crossed faster — but not instantly, or that dolly snaps. Together
// this is ~1.65s per capture.
const PACE_HANDOFF_S = 1.2;
const PACE_HOLD_S = 0.45;
const PACE_V_HANDOFF = (WALK_BEAT * SEQ_TRANSITION) / PACE_HANDOFF_S;
const PACE_V_HOLD = (WALK_BEAT * (1 - SEQ_TRANSITION)) / PACE_HOLD_S;
// Outside the walk: a sanity bound the spring never reaches (its own peak speed
// across a full-page error is ~1.4/s). The word, the morph and the finale are
// each one continuous beat where scrubbing fast is still legible, so they are
// deliberately not paced.
const PACE_FREE = 4;
// Phase width of the ramp between the two limits, so the follow speed eases
// between them instead of stepping.
const PACE_RAMP = 0.08;
// How far scroll may lead (or trail) the scene inside the walk, in beats. One:
// a fling commits to the capture in front of you and no further.
const LEASH_BEATS = 1;
// Fraction of a beat you have to move before releasing commits to the next
// capture instead of returning to the one you were on. Small on purpose — one
// wheel notch is about 0.2 of a beat, and "one scroll, one layer" is the whole
// point. Below it the walk treats the move as a nudge and puts you back.
const SNAP_TRIGGER = 0.15;
// Quiet time after the last scroll event before the walk snaps. Longer than a
// mouse wheel's notch-to-notch gap, so a slow wheel reads as one gesture.
const SNAP_DELAY_MS = 220;
// How close to a whole beat still counts as being ON that hold. Scroll
// positions are whole pixels and a beat is a few hundred of them, so a snapped
// rest lands a fraction of a beat off the exact boundary — and the leash asks
// an integer question about it. Too tight a tolerance and the answer is "still
// on the beat below", which pins the ceiling to the boundary the walk is
// already sitting on and deadlocks every forward gesture. ~1vh: far larger than
// any rounding, far smaller than SNAP_TRIGGER.
const BEAT_EPS = 0.02;

// The walk's position in beats, and back. Whole numbers are the capture holds:
// the only places inside the walk where the scene is a readable still.
function beatOf(s: number) {
  return (s - WALK_S0) / WALK_BEAT;
}
function scrollOfBeat(b: number) {
  return WALK_S0 + b * WALK_BEAT;
}

// Speed limit at a point on the scroll axis, in progress per second.
function paceLimit(s: number) {
  if (s <= WALK_S0 || s >= WALK_S1) return PACE_FREE;
  // Phase inside the current capture's beat, sliced exactly the way the walk
  // block slices `raw`: the hold is the first (1 - SEQ_TRANSITION), the handoff
  // is the rest and runs to the end of the beat.
  const u = (s - WALK_S0) / WALK_BEAT;
  const phase = u % 1;
  const rise = smoothstep(
    clamp01((phase - (1 - SEQ_TRANSITION) + PACE_RAMP) / (2 * PACE_RAMP))
  );
  // The handoff has no room to ramp down before the beat ends — its tail (the
  // leftover skeleton lifting out) is the last thing in it. So the release
  // lands just past the wrap, in the first sliver of the next hold. Not in the
  // first beat, which has no handoff behind it: there the ramp would only put a
  // hesitation on the assembled table the moment the walk opens.
  const fall = u < 1 ? 0 : 1 - smoothstep(clamp01(phase / PACE_RAMP));
  return lerp(PACE_V_HOLD, PACE_V_HANDOFF, Math.max(rise, fall));
}

// The leash, as a window on the scroll axis around where the scene has got to.
// Outside the walk it opens to the full page. A scene that has not reached the
// walk yet is gated at the walk's own start, so a fling from the top of the
// page stops at the first capture instead of landing in the middle of the
// teardown with eight beats queued behind it.
//
// Both edges land on HOLDS, not on "one beat from wherever the scene happens to
// be". An unquantised window preserved whatever phase you came to rest at: stop
// once with the cabinet half evaporated and every flick after it left you half
// evaporated again, one capture further along, because the window carried the
// offset forward. Quantised, the window is the pair of readable stills either
// side of the scene, and the walk cannot drift off them.
function leashCeil(scene: number) {
  if (scene >= WALK_S1) return 1;
  const b = beatOf(Math.max(scene, WALK_S0));
  return Math.min(1, scrollOfBeat(Math.floor(b + BEAT_EPS) + LEASH_BEATS));
}
function leashFloor(scene: number) {
  if (scene <= WALK_S0) return 0;
  const b = beatOf(Math.min(scene, WALK_S1));
  return Math.max(0, scrollOfBeat(Math.ceil(b - BEAT_EPS) - LEASH_BEATS));
}

// Where a release should land, given where scroll got to and which hold it left.
// `from` is the hold the gesture started on; a move of SNAP_TRIGGER in either
// direction commits to the neighbouring one, anything less returns. One step per
// release, so this can never skip a capture however far the gesture went — the
// leash has already bounded that anyway.
function snapBeat(s: number, from: number | null) {
  const b = beatOf(s);
  const hold = (n: number) => Math.min(WALK_CAPTURES, Math.max(0, n));
  // No origin worth stepping from — the walk was entered from the table beat
  // above it, or a jump the leash let through re-seated the scene. Land on the
  // nearest hold instead, so arriving at capture 00 does not immediately step
  // off it.
  if (from === null || Math.abs(b - from) > 1 + SNAP_TRIGGER) return hold(Math.round(b));
  const d = b - from;
  return hold(from + (d > SNAP_TRIGGER ? 1 : d < -SNAP_TRIGGER ? -1 : 0));
}

type Drive = {
  p: number;
  v: number;
  stamp: number;
  primed: boolean;
  paced: boolean;
  // Wall clock of the last frame that actually advanced the spring. The leash
  // reads it: the spring integrates PER FRAME (h capped at 50ms), so on a
  // device rendering at a few fps the scene creeps in real time, and a leash
  // that kept holding the page to it would be a trap rather than a detent.
  wall: number;
};

// Below this frame rate the leash lets go — see Drive.wall.
const PACE_MIN_FPS = 5;

// Solved implicitly — the denominator is (1 + omega*h)^2, so it cannot ring or
// blow up however long the frame was. Stamped by clock time because r3f runs
// useFrame subscribers in mount order; whichever consumer arrives first this
// frame advances it, the rest read the same value.
function driveScroll(d: Drive, target: number, dt: number, stamp: number) {
  if (stamp === d.stamp) return d.p;
  d.stamp = stamp;
  d.wall = performance.now();
  if (!d.primed) {
    // A reload part-way down the page must not animate up from zero. Same door
    // the leash uses to hand back a deliberate jump (End, an anchor) without
    // slow-walking the whole teardown to get there.
    d.primed = true;
    d.p = target;
    d.v = 0;
    return d.p;
  }
  const h = Math.min(dt, 0.05);
  const w = SCROLL_OMEGA;
  d.v = (d.v - w * w * h * (d.p - target)) / (1 + 2 * w * h + w * w * h * h);
  if (d.paced) {
    // Clamped on the scene's CURRENT position, not the target: the limit that
    // matters is the one where the animation is actually being drawn.
    const vmax = paceLimit(d.p);
    if (d.v > vmax) d.v = vmax;
    else if (d.v < -vmax) d.v = -vmax;
  }
  const next = d.p + h * d.v;
  // A capped step can no longer be trusted to land: with the spring's own
  // deceleration removed, the last frame of a settle would sail past the target
  // and the clamp would chase it back, forever. Arrive instead. Tested as a
  // sign change so it only fires on an actual crossing, never on a step that
  // starts on the far side and is already on its way back.
  if ((d.p - target) * (next - target) < 0) {
    d.p = target;
    d.v = 0;
  } else {
    d.p = next;
  }
  // And arrive when it merely creeps in, which is the case a sign change never
  // catches: the pacing clamp can strip the overshoot that would have crossed.
  // Progress is 0..1 over 940vh, so this is a twentieth of a pixel of scroll.
  if (Math.abs(d.p - target) < 1e-6 && Math.abs(d.v) < 1e-5) {
    d.p = target;
    d.v = 0;
  }
  return d.p;
}

// next/font registers its faces under mangled family names ('__Anton_abc123'),
// so a canvas asking for "Anton" silently falls back to Impact/system sans and
// the browser fake-bolds it into mush. Resolve the real family list by probing
// a computed style built from the CSS variables the fonts are exposed through.
function resolveFamilies(cssVars: string) {
  const fallback = '"Heiti SC", "PingFang SC", "Microsoft YaHei", Impact, sans-serif';
  if (typeof document === 'undefined') return fallback;
  const probe = document.createElement('span');
  probe.style.fontFamily = cssVars;
  document.body.appendChild(probe);
  const fam = getComputedStyle(probe).fontFamily;
  probe.remove();
  return fam ? `${fam}, ${fallback}` : fallback;
}

// Wordmark face: the ultra-condensed poster Anton (+ heavy hanzi fallback).
const WORDMARK_VARS = 'var(--font-anton), var(--font-hei)';
// Secondary-line face: Plex Mono + mid-weight hanzi, NOT Anton/black hanzi —
// at secondary size Anton's counters and the 900 face's inter-stroke gaps are
// hairline slivers the splat bloom seals shut (M/N/G and 制造 were mush).
// Open, lighter letterforms survive the grain, and the mono matches the
// site's label typography (eyebrow, nav, stats).
const SECONDARY_VARS = 'var(--font-mono), var(--font-hei-mid)';

// Sampling lattice pitch, px. buildSplatData spreads the splats stacked on one
// sampled pixel back across this cell, so the lattice never shows.
const SAMPLE_STEP = 4;

// Rasterize the brand lockup to an offscreen canvas and return its filled
// pixels as [x, y, r, g, b, step] runs (COORD_STRIDE). Layout mirrors the
// logo: the first word set huge, a rule broken by the acid four-dot tile, and
// the remaining words letter-spaced to justify across the wordmark's width.
// `step` is the sampling pitch the pixel came from — the small rule/tile/
// secondary band samples on a finer lattice than the wordmark, or the grain
// eats its glyphs (an "M" stroke there spans barely two coarse cells).
const COORD_STRIDE = 6;
const FINE_STEP = 2;

function sampleLockup(text: string) {
  const cw = 1200;
  const ch = 600;
  if (typeof document === 'undefined') return { coords: [] as number[], cw, ch };
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { coords: [], cw, ch };

  const words = text.trim().split(/\s+/);
  const primary = words[0] ?? '';
  const secondary = words.slice(1).join(' ');

  // Weights match what the faces register (Anton 400, Plex Mono 500, hanzi
  // 900 picked up by nearest-match) — asking for a weight a face doesn't own
  // makes the canvas synthesize a fake bold that clogs the counters.
  const families = resolveFamilies(WORDMARK_VARS);
  const familiesS = resolveFamilies(SECONDARY_VARS);
  const font = (s: number, fam = families, w = 400) => `${w} ${s}px ${fam}`;
  const track = (px: number) => {
    try {
      ctx.letterSpacing = `${Math.round(px)}px`;
    } catch {
      /* older engines: no tracking, layout still works */
    }
  };
  const capOf = (s: string, size: number, fam = families, w = 400) => {
    ctx.font = font(size, fam, w);
    const m = ctx.measureText(s);
    return m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent : size * 0.72;
  };

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // Fit the wordmark to the poster width, then keep the whole stack (wordmark +
  // rule row + secondary ≈ 1.66 cap heights) inside the canvas — a short brand
  // word would otherwise blow up vertically.
  track(2);
  ctx.font = font(100);
  const w100 = Math.max(1, ctx.measureText(primary).width);
  let sizeP = Math.max(40, (100 * (cw * 0.88)) / w100);
  const capRatio = capOf(primary, 100) / 100;
  const maxCap = secondary ? ch * 0.5 : ch * 0.6;
  if (sizeP * capRatio > maxCap) sizeP = maxCap / capRatio;
  sizeP = Math.floor(sizeP);

  ctx.font = font(sizeP);
  track(sizeP * 0.02);
  const mP = ctx.measureText(primary);
  const capP = mP.actualBoundingBoxAscent > 0 ? mP.actualBoundingBoxAscent : sizeP * 0.72;
  // ink width (bounding box, not advance width — advance includes the trailing
  // letter-spacing, which would push the justified secondary line off-centre)
  const inkW =
    mP.actualBoundingBoxLeft + mP.actualBoundingBoxRight > 0
      ? mP.actualBoundingBoxLeft + mP.actualBoundingBoxRight
      : mP.width;

  // Stack geometry below the wordmark baseline, proportions from the logo
  // (tile and secondary run a touch larger than the print mark — particle
  // grain eats thin strokes, so small elements need extra weight to read).
  // The rule row gets clear air on both sides: tight against the wordmark it
  // reads as underlining the D/O bottoms instead of dividing the lockup.
  const ruleY = capP * 0.24; // rule/tile centreline
  const baseS = capP * 0.74; // secondary baseline
  const stackH = secondary ? capP + baseS + capP * 0.05 : capP;
  const baseP = (ch - stackH) / 2 + capP;
  let fineY = ch; // top of the fine-sampled band; ch => no band

  ctx.fillStyle = '#ffffff';
  ctx.fillText(primary, cw / 2, baseP);

  if (secondary) {
    // Rule broken by the acid four-dot tile (the die from the brand mark).
    // Acid-deep rule so it reads quieter than the tile; the sampler keys the
    // particle colour off these drawn pixels.
    const side = capP * 0.3;
    const cy = baseP + ruleY;
    const gap = side * 0.55;
    fineY = Math.max(0, Math.floor(cy - side / 2) - 2);
    const ruleTh = Math.max(4, Math.round(capP * 0.024));
    const halfW = inkW / 2;
    ctx.fillStyle = '#9fce00';
    ctx.fillRect(cw / 2 - halfW, cy - ruleTh / 2, halfW - side / 2 - gap, ruleTh);
    ctx.fillRect(cw / 2 + side / 2 + gap, cy - ruleTh / 2, halfW - side / 2 - gap, ruleTh);

    ctx.fillStyle = '#c6ff00';
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(cw / 2 - side / 2, cy - side / 2, side, side, side * 0.26);
      ctx.fill();
    } else {
      ctx.fillRect(cw / 2 - side / 2, cy - side / 2, side, side);
    }
    ctx.globalCompositeOperation = 'destination-out';
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(cw / 2 + sx * side * 0.23, cy + sy * side * 0.23, side * 0.17, 0, Math.PI * 2);
        ctx.fill();
      }
    ctx.globalCompositeOperation = 'source-over';

    // Secondary line, justified to the wordmark by hand-spacing the glyphs —
    // canvas letter-spacing also pads after the last glyph, which skews the
    // centring. The gap clamp keeps a two-hanzi secondary from flying apart.
    const sizeS = Math.max(
      24,
      Math.floor((capP * 0.26 * 100) / capOf(secondary, 100, familiesS, 500))
    );
    ctx.font = font(sizeS, familiesS, 500);
    track(0);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    const chars = Array.from(secondary);
    const widths = chars.map((c) => ctx.measureText(c).width);
    const sum = widths.reduce((a, b) => a + b, 0);
    const gapC =
      chars.length > 1
        ? Math.min(Math.max((inkW - sum) / (chars.length - 1), sizeS * 0.05), sizeS * 1.4)
        : 0;
    let x = cw / 2 - (sum + gapC * (chars.length - 1)) / 2;
    chars.forEach((c, i) => {
      ctx.fillText(c, x, baseP + baseS);
      x += widths[i] + gapC;
    });
  }

  const img = ctx.getImageData(0, 0, cw, ch).data;
  const coords: number[] = [];
  const pushIf = (x: number, y: number, step: number) => {
    const i = (y * cw + x) * 4;
    if (img[i + 3] > 128) coords.push(x, y, img[i], img[i + 1], img[i + 2], step);
  };
  for (let y = 0; y < fineY; y += SAMPLE_STEP)
    for (let x = 0; x < cw; x += SAMPLE_STEP) pushIf(x, y, SAMPLE_STEP);
  // Fine band, thinned to ~55%: splats are allocated per coord, so a full 2px
  // lattice would pull 4x the wordmark's splat density into the band. ~55%
  // keeps the fill gapless (harder thinning leaves Poisson holes in the thin
  // strokes); the leftover ~2x density surplus is paid back in per-splat
  // alpha (see the fine-band alpha factor in buildSplatData) so the gaussian
  // tails don't dilate small strokes until their counters close — that was
  // the original "M is unreadable" bug.
  for (let y = fineY; y < ch; y += FINE_STEP)
    for (let x = 0; x < cw; x += FINE_STEP)
      if (Math.random() < 0.55) pushIf(x, y, FINE_STEP);
  return { coords, cw, ch };
}

// A model source, however it was loaded: real gaussians from a splat capture, or
// isotropic stand-ins synthesised from a bare point cloud.
type ModelSource = {
  count: number;
  pos: Float32Array; // xyz
  scale: Float32Array; // xyz, world units
  quat: Float32Array; // xyzw
  color: Float32Array; // rgb 0..1
  opacity: Float32Array;
  photoreal: boolean; // false => synthesised, use the steel gradient
  // One entry per capture in the sequence, in scroll order. Null for a single
  // capture, which has nothing to step through and keeps the radial blast.
  layers: LayerRange[] | null;
};

type LayerRange = {
  offset: number; // first splat index
  count: number;
  centreY: number; // world units, for framing the capture when it is active
  radius: number;
  zoom: number; // group scale that fits this capture to the frame
  // Vertical span, so the removal can stagger top-first in this capture's own
  // units — the control column peels like the whole table rather than twitching.
  minY: number;
  maxY: number;
  // How far this part travels to leave the frame, world units along the axis.
  // Derived from the capture's own framing, not its size: see SEQ_EXIT_FRAMES.
  exit: number;
  // The closing diagram. `seatY` is where this part parks on the explode axis
  // and `lag` is its share of the landing stagger, both derived from the CAD
  // offsets carried in the sidecar. stackIndex < 0 means "not a part of the
  // stack" — only the assembled table (00), which the diagram leaves out.
  stackIndex: number;
  explodeY: number;
  seatY: number;
  lag: number;
};

// Decode the 32-byte .splat layout written by the PLY path.
function parseSplats(ab: ArrayBuffer, limit: number): ModelSource {
  const total = Math.floor(ab.byteLength / 32);
  const count = Math.min(total, limit);
  const f32 = new Float32Array(ab);
  const u8 = new Uint8Array(ab);
  const pos = new Float32Array(count * 3);
  const scale = new Float32Array(count * 3);
  const quat = new Float32Array(count * 4);
  const color = new Float32Array(count * 3);
  const opacity = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const f = i * 8;
    const b = i * 32;
    pos[i * 3] = f32[f];
    pos[i * 3 + 1] = f32[f + 1];
    pos[i * 3 + 2] = f32[f + 2];
    scale[i * 3] = f32[f + 3];
    scale[i * 3 + 1] = f32[f + 4];
    scale[i * 3 + 2] = f32[f + 5];
    color[i * 3] = u8[b + 24] / 255;
    color[i * 3 + 1] = u8[b + 25] / 255;
    color[i * 3 + 2] = u8[b + 26] / 255;
    opacity[i] = u8[b + 27] / 255;
    // stored wxyz, shader wants xyzw
    quat[i * 4] = (u8[b + 29] - 128) / 128;
    quat[i * 4 + 1] = (u8[b + 30] - 128) / 128;
    quat[i * 4 + 2] = (u8[b + 31] - 128) / 128;
    quat[i * 4 + 3] = (u8[b + 28] - 128) / 128;
  }
  return { count, pos, scale, quat, color, opacity, photoreal: true, layers: null };
}

// The nine-capture sequence + its index. Two sidecar formats are accepted:
//   long   [u32 layerCount][per layer: u32 offset, u32 count, f32 dy, f32 stack]
//   short  [u32 layerCount][per layer: u32 offset, u32 count]
// The long form carries the CAD explode geometry the finale is built on; the
// short form is what build-layers.mjs wrote before that beat existed, and falls
// back to even spacing by walk order. Captures are concatenated at full quality,
// so nothing is thinned on desktop. `perLayer` caps each capture for small
// screens; a prefix of a capture is an even subset of it, because the capture's
// own order is not spatial.
function parseLayerCloud(
  ab: ArrayBuffer,
  indexAb: ArrayBuffer,
  perLayer: number
): ModelSource | null {
  const total = Math.floor(ab.byteLength / 32);
  const iv = new DataView(indexAb);
  const n = indexAb.byteLength >= 4 ? iv.getUint32(0, true) : 0;
  if (!n || indexAb.byteLength < 4 + n * 8) return null;
  const long = indexAb.byteLength >= 4 + n * 16;
  const stride = long ? 16 : 8;

  const src = new Float32Array(ab);
  const su8 = new Uint8Array(ab);
  const ranges: LayerRange[] = [];
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const o = 4 + i * stride;
    const off = iv.getUint32(o, true);
    const cnt = iv.getUint32(o + 4, true);
    if (off + cnt > total) return null;
    ranges.push({
      offset: off,
      count: Math.min(cnt, perLayer),
      centreY: 0,
      radius: 1,
      zoom: 1,
      minY: 0,
      maxY: 1,
      exit: 1,
      // Short sidecar: the walk order IS the stack order reversed (00 is the
      // whole table, then outermost part first), so the diagram can still be
      // laid out — just evenly, without the CAD's proportions.
      explodeY: long ? iv.getFloat32(o + 8, true) : 0,
      stackIndex: long ? iv.getFloat32(o + 12, true) : i === 0 ? -1 : n - 1 - i,
      seatY: 0,
      lag: 0,
    });
    kept += ranges[i].count;
  }

  const pos = new Float32Array(kept * 3);
  const scale = new Float32Array(kept * 3);
  const quat = new Float32Array(kept * 4);
  const color = new Float32Array(kept * 3);
  const opacity = new Float32Array(kept);

  let w = 0;
  for (const r of ranges) {
    const start = w;
    let loY = Infinity;
    let hiY = -Infinity;
    let loX = Infinity;
    let hiX = -Infinity;
    for (let j = 0; j < r.count; j++, w++) {
      const f = (r.offset + j) * 8;
      const b = (r.offset + j) * 32;
      const y = src[f + 1];
      pos[w * 3] = src[f];
      pos[w * 3 + 1] = y;
      pos[w * 3 + 2] = src[f + 2];
      scale[w * 3] = src[f + 3];
      scale[w * 3 + 1] = src[f + 4];
      scale[w * 3 + 2] = src[f + 5];
      color[w * 3] = su8[b + 24] / 255;
      color[w * 3 + 1] = su8[b + 25] / 255;
      color[w * 3 + 2] = su8[b + 26] / 255;
      opacity[w] = su8[b + 27] / 255;
      quat[w * 4] = (su8[b + 29] - 128) / 128;
      quat[w * 4 + 1] = (su8[b + 30] - 128) / 128;
      quat[w * 4 + 2] = (su8[b + 31] - 128) / 128;
      quat[w * 4 + 3] = (su8[b + 28] - 128) / 128;
      if (y < loY) loY = y;
      if (y > hiY) hiY = y;
      const x = src[f];
      if (x < loX) loX = x;
      if (x > hiX) hiX = x;
    }
    // Where this capture sits and how big it is, so the beat can frame it.
    r.offset = start;
    r.centreY = (loY + hiY) / 2;
    r.radius = Math.max(0.001, (hiX - loX) / 2, (hiY - loY) / 2);
    r.zoom = Math.min(SEQ_ZOOM_MAX, Math.max(SEQ_ZOOM_MIN, SEQ_FRAME_RADIUS / r.radius));
    r.minY = loY;
    r.maxY = hiY;
    // How far this part must travel to leave. Object-space, so it undoes the
    // framing zoom — a small capture is magnified, so it needs LESS world travel
    // to cross the same screen. Sized against the camera at rest (z = 10, fov
    // 50), the widest the frame ever gets during the walk, so the part always
    // clears it. No pitch term: travel is along the screen's vertical, not the
    // model's own, so it is never foreshortened. See uAxis.
    r.exit = (SEQ_EXIT_FRAMES * CAM_HALF_H) / r.zoom + r.radius;
  }

  // Seats for the closing diagram, from the CAD offsets the sidecar carries.
  const maxDy = Math.max(0, ...ranges.map((r) => r.explodeY));
  const maxStack = Math.max(0, ...ranges.map((r) => r.stackIndex));
  for (const r of ranges) {
    if (r.stackIndex < 0) continue; // the assembled table is not in the diagram
    const cad = maxDy > 0 ? r.explodeY / maxDy : 0;
    const even = maxStack > 0 ? r.stackIndex / maxStack : 0;
    const t = lerp(cad, even, FINALE_EVENNESS);
    r.seatY = t * FINALE_SPAN;
    // Landing order: the parts settle bottom-up, so the diagram builds the way
    // a hand would lay them out and the last thing to arrive is the outer shell.
    r.lag = t;
  }

  return { count: kept, pos, scale, quat, color, opacity, photoreal: true, layers: ranges };
}

// ---------------------------------------------------------------- CAD diagram
type CadLayer = {
  // One InstancedMesh per distinct SHAPE in the layer, not one mesh per layer. The
  // machine is four-fold symmetric, so its 3.1M source triangles are only 1.07M
  // distinct ones — 4.15x over in the wall builder alone — and drawing each shape
  // instanced is what lets the perforated storage tracks keep their holes inside a
  // download this size. 120 shapes across the whole diagram, so 120 draw calls on
  // the one beat that draws them.
  meshes: THREE.InstancedMesh[];
  geometries: THREE.BufferGeometry[];
  // One material for the whole layer: uFade and uCamPos are per layer, so there is
  // nothing to vary between its shapes.
  material: THREE.RawShaderMaterial;
  // Built here rather than declared in JSX so the frame loop can move each layer by
  // touching the object directly, with no ref array to keep in step.
  root: THREE.Group;
  minY: number;
  maxY: number;
  centreY: number;
  radius: number;
  seatY: number; // where it parks on the explode axis
  lag: number; // its share of the bottom-up landing stagger
  // The layer's full box in its own space, which is what the pointer is tested
  // against. minY/maxY above are this box's Y and are kept separate because the
  // framing has always wanted them on their own.
  box: THREE.Box3;
  // The layer's reach from the explode axis, over every yaw. The framing of an
  // isolated part is fitted to this rather than to the box above — see the note
  // in buildGroup for why the box is the wrong bound for a stack of discs.
  planR: number;
  // Live interaction state, mutated by the frame loop. Kept on the layer rather
  // than in a parallel array so there is exactly one thing to keep in step, and
  // damped rather than set so hover does not pop.
  hot: number; // 0..1 highlight
  alpha: number; // 0..1 isolation opacity, independent of the landing fade
};

// Physically based CAD on a near-black page, shaded to match the project's own
// Cycles renders (04_renders/pbr_mechanism.png, photo/exploded_overview.png)
// rather than approximating them. Everything the Principled BSDF needs comes out
// of the blend: real split normals per corner, and base colour + metallic +
// roughness through a 77-entry palette indexed by one byte a vertex. Occlusion is
// baked per layer at build time.
//
// This replaced a two-directional-term lambert over flat derivative normals. That
// version had no way to draw metal — the machine is full of chrome bearings,
// brushed aluminium and blackened steel plate, and without a specular lobe every
// one of them read as grey plastic.
const CAD_VERT = /* glsl */ `
precision highp float;
uniform mat4 modelMatrix;
// Own view-projection, for the same reason as uCamPos in the fragment shader:
// three uploads viewMatrix and projectionMatrix only when the shader program or the
// camera OBJECT changes, not once a frame, and this scene's camera moves every
// frame. modelMatrix is safe — that one three sets per object per draw.
uniform mat4 uViewProj;
in vec3 position;
in vec3 normal;
in vec3 color;
in vec3 mra; // metallic, roughness, occlusion
// Per-instance placement, local part space -> render world. Vertices are stored in
// the part's OWN space so one copy serves every instance; three fills this from the
// InstancedMesh. Every transform in the assembly was verified to be a similarity
// (rotation times one uniform scale) at export time, which is what makes carrying
// normals through mat3 of it legitimate.
in mat4 instanceMatrix;
out vec3 vWorld;
out vec3 vNrm;
out vec3 vColor;
out vec3 vMra;
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 world = m * vec4(position, 1.0);
  vWorld = world.xyz;
  // The group only ever rotates and scales uniformly, so the rotation part carries
  // normals correctly once renormalised — no separate normal matrix, and lighting
  // stays in world space where the studio rig is defined.
  vNrm = mat3(m) * normal;
  vColor = color;
  vMra = mra;
  gl_Position = uViewProj * world;
}
`;

// The lighting rig, read out of the blend and converted into render-world
// directions. Blender is z-up and the render world applies (x, y, z) -> (x, z,
// -y), so these are the normalised directions from the machine's centre toward
// each light after that swap. Intensities are relative irradiance, P / d^2, with
// the key normalised to 1.
//
//   L_Key   area 1.5 m   210 W  at (-1.439, -1.689, 1.453)   front left, high
//   L_Fill  area 2.6 m    38 W  at ( 1.814, -1.126, 0.515)   front right, low
//   L_Rim   area 1.4 m    95 W  at ( 0.188,  1.876, 1.015)   behind, high
//
// The lights are DIRECTIONAL here, not positional. Cycles rendered each layer at
// its true seat; the diagram pulls the layers 1.8 m apart along the explode axis,
// and point lights over that span would light the cabinet at the top visibly
// differently from the electronics box at the bottom. A diagram wants one
// consistent read.
//
// `radius` is the light's angular half-size at the machine, which is what turns a
// point highlight into the broad soft gradient the reference shows on the
// aluminium legs. The blend's fourth rig (LIB_*, off in the material-library
// corner of the same scene) contributes about a fifth of the key from the far
// side; it is folded in as the last entry rather than dropped, because the
// reference renders do include it.
const CAD_FRAG = /* glsl */ `
precision highp float;
in vec3 vWorld;
in vec3 vNrm;
in vec3 vColor;
in vec3 vMra;
// Deliberately not three's built-in cameraPosition uniform. That one is uploaded
// only when the shader program changes or the camera object does — not once a
// frame — and this scene's camera moves every frame (pointer parallax plus a
// dolly, and lookAt on top). It would have been right on most frames and stale on
// the ones where the splat pass had faded out and stopped forcing a program
// switch.
uniform vec3 uCamPos;
uniform float uFade;
uniform float uExposure;
uniform float uAmbient;
uniform float uAo;
// Inspection state for this layer. uHot is the hover lift, uDim is how far the
// layer has been pushed behind whichever one the pointer is on. Both are
// UNIFORMS PER LAYER, which is the whole reason this beat could be made
// interactive cheaply: the diagram already draws one material per layer, so
// lighting one subassembly and dropping the other seven is eight uniform writes
// a frame and not one extra draw call, shader variant or render target.
uniform float uHot;
uniform float uDim;
out vec4 outColor;

const float PI = 3.14159265359;

const int NLIGHT = 4;
const vec3 LDIR[4] = vec3[4](
  vec3(-0.5617,  0.4995,  0.6592),  // key
  vec3( 0.8387,  0.1595,  0.5205),  // fill
  vec3( 0.0910,  0.4090, -0.9080),  // rim
  vec3( 0.4724,  0.6169,  0.6295)   // the library rig, folded into one term
);
const vec4 LPOW = vec4(1.0, 0.253, 0.697, 0.197);
const vec4 LRAD = vec4(0.146, 0.301, 0.169, 0.212);

float dGGX(float NoH, float a) {
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-8);
}

// Height-correlated Smith visibility, i.e. G / (4 NoL NoV) folded into one term.
float vSmith(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-6);
}

// Karis' analytic split-sum fit. Cheaper than a BRDF lookup texture and, on a
// diagram that is never more than a few hundred pixels tall, indistinguishable.
vec3 envBRDF(vec3 f0, float rough, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

// The blend's world is a Nishita sky at 0.13 strength with the sun 28 degrees up
// — a cool zenith over a warmer horizon, with nothing below because the studio
// floor is hidden for these renders. A three-stop gradient reproduces the part
// of that which a 60 px part can actually show.
vec3 sky(vec3 d) {
  float up = d.y;
  vec3 zenith = vec3(0.38, 0.47, 0.68);
  vec3 horizon = vec3(0.52, 0.52, 0.52);
  vec3 ground = vec3(0.07, 0.07, 0.08);
  return up > 0.0
    ? mix(horizon, zenith, sqrt(up))
    : mix(horizon, ground, sqrt(-up));
}

// AgX, as Blender applies it. This is the single biggest reason the first pass
// looked wrong: the blend renders through AgX with the Medium High Contrast look,
// and encoding linear radiance with pow(1/2.2) instead is nothing like it. AgX
// rolls saturated channels toward white as they brighten, which is exactly what
// keeps the pure-primary SolidWorks colours — the felt green in particular
// arrives as fully saturated green — from reading as neon. The previous shader
// faked that by desaturating everything by a flat 28%, which cost the metals
// their colour too.
const mat3 AGX_IN = mat3(
  0.856627153315983, 0.137318972929847, 0.11189821299995,
  0.0951212405381588, 0.761241990602591, 0.0767994186031903,
  0.0482516061458583, 0.101439036467562, 0.811302368396859);
const mat3 AGX_OUT = mat3(
  1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
  -0.11060664309660323, 1.157823702216272, -0.11060664309660294,
  -0.016493938717834573, -0.016493938717834257, 1.2519364065950405);
const mat3 SRGB_TO_2020 = mat3(
  0.6274, 0.0691, 0.0164,
  0.3293, 0.9195, 0.0880,
  0.0433, 0.0113, 0.8956);
const mat3 REC2020_TO_SRGB = mat3(
   1.6605, -0.1246, -0.0182,
  -0.5876,  1.1329, -0.1006,
  -0.0728, -0.0083,  1.1187);

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
       - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 agx(vec3 c) {
  const float MIN_EV = -12.47393;
  const float MAX_EV = 4.026069;
  c = SRGB_TO_2020 * c;
  c = AGX_IN * c;
  c = clamp((log2(max(c, 1e-10)) - MIN_EV) / (MAX_EV - MIN_EV), 0.0, 1.0);
  c = agxContrast(c);
  // The "Medium High Contrast" look, as a power and a touch of saturation on top
  // of AgX base. Blender ships it as a curve; this is the two-parameter fit of
  // it, matched against 04_renders/pbr_mechanism.png.
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = luma + 1.18 * (pow(max(c, 0.0), vec3(1.20)) - luma);
  c = AGX_OUT * clamp(c, 0.0, 1.0);
  c = REC2020_TO_SRGB * pow(max(c, 0.0), vec3(2.2));
  return max(c, 0.0);
}

// AgX hands back LINEAR sRGB — the pow(2.2) at the end of it is undoing an
// encode, not applying one. A RawShaderMaterial writes straight to the drawing
// buffer with none of three's output-colour-space chunk, so the OETF has to be
// here. Leaving it out is what the first attempt did, and the diagram came back
// looking correctly shaded but three stops underexposed.
vec3 encodeSrgb(vec3 c) {
  return mix(c * 12.92,
             pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) * 1.055 - 0.055,
             step(vec3(0.0031308), c));
}

void main() {
  // Winding is trustworthy: the exporter measures it against the CAD normals and
  // reports 99.8% agreement over 173k triangles, so front-facing really does
  // mean front-facing. Both sides still draw — a fifth of a percent of slivers
  // disagree and culling them would punch holes — but the normal is resolved by
  // facing rather than by pointing it at the camera, which would put a hard flip
  // line right along every silhouette.
  vec3 n = normalize(vNrm);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(uCamPos - vWorld);
  float NoV = max(dot(n, v), 1e-4);

  float metal = vMra.x;
  float rough = clamp(vMra.y, 0.045, 1.0);
  float ao = mix(1.0, vMra.z, uAo);

  // Geometric specular antialiasing. A chrome bearing at 0.06 roughness has a
  // highlight far narrower than a pixel on decimated geometry, so it strobes as
  // the diagram turns. Widening roughness by the normal's screen-space variance
  // spreads that highlight to at least a pixel, which is what the canvas cannot
  // do for us — MSAA is off, since soft gaussians cannot alias and the splat pass
  // is the one that has to stay cheap.
  vec3 dnx = dFdx(n);
  vec3 dny = dFdy(n);
  float variance = 0.5 * (dot(dnx, dnx) + dot(dny, dny));
  float a = rough * rough;
  // The ceiling on how much roughness this may ADD, in alpha-squared. It was
  // 0.25, which is not a widening but a demolition: it lets alpha reach 0.5,
  // i.e. roughness 0.71, and this machine is dense enough — perforated tracks,
  // rings of small rollers, gear teeth — that the variance term saturates over
  // most of the model at anything short of full display resolution. Every metal
  // in the diagram was therefore being drawn at plaster roughness, which is
  // exactly the "no specular anywhere" the closing shot had.
  //
  // 0.045 is the usual working range for this approximation and still covers
  // what it is for: a chrome bearing at roughness 0.06 has alpha 0.0036, so the
  // floor this imposes is alpha 0.21 — a highlight a couple of pixels across
  // instead of a sub-pixel one that strobes as the diagram turns.
  a = min(1.0, sqrt(a * a + min(2.0 * variance, 0.045)));

  vec3 albedo = vColor * (1.0 - metal);
  vec3 f0 = mix(vec3(0.04), vColor, metal);

  vec3 lit = vec3(0.0);
  for (int i = 0; i < NLIGHT; i++) {
    vec3 l = LDIR[i];
    float NoL = dot(n, l);
    if (NoL <= 0.0) continue;
    vec3 h = normalize(l + v);
    float NoH = max(dot(n, h), 0.0);
    float VoH = max(dot(v, h), 0.0);

    // Treat the area light as a sphere of the same angular size: widen the lobe
    // by its half-angle and renormalise, or the widening would also brighten.
    float ap = min(1.0, a + LRAD[i]);
    float norm = (a * a) / (ap * ap);

    float spec = dGGX(NoH, ap) * vSmith(NoV, NoL, ap) * norm;
    // Schlick's fifth power as a multiply chain. pow() is a log/exp pair on most
    // hardware; this is three multiplies, four times a fragment.
    float fc = 1.0 - VoH;
    float fc2 = fc * fc;
    vec3 fr = f0 + (1.0 - f0) * (fc2 * fc2 * fc);
    lit += LPOW[i] * NoL * (albedo / PI + spec * fr);
  }
  // Occlusion cuts the ambient in full and the direct terms only partly. Direct
  // light is not really occluded by a nearby surface in the way ambient is, but
  // this is a diagram of a machine whose interesting parts are all inside
  // something, and letting a little of it through is what makes the chassis and
  // the cabinet read as enclosures.
  lit *= mix(1.0, ao, 0.35);

  // Ambient. Irradiance from the sky gradient, plus its specular half through
  // the split-sum approximation — the second is what puts the environment's own
  // gradient onto the metals, and without it every metallic part goes black
  // wherever the three lights do not reach it.
  // sky() at straight up is a constant; only sky(n) varies. Folding the zenith
  // term in as a literal saves a branch and three mixes per fragment.
  vec3 irr = sky(n) * 0.6 + vec3(0.38, 0.47, 0.68) * 0.4;
  vec3 amb = albedo * irr;
  amb += sky(reflect(-v, n)) * envBRDF(f0, rough, NoV);
  lit += amb * uAmbient * ao;

  // Hover and dim are applied as EXPOSURE, before the tone map, because that is
  // the only place they can be applied without lying about the material. AgX
  // rolls bright saturated channels toward white, so a part lit a stop harder
  // gains highlight rather than gaining paint, and one dropped two stops loses
  // its specular before it loses its colour — which is how a real part behaves
  // when you move a light, and is why this reads as focus rather than as a
  // brightness slider.
  vec3 col = encodeSrgb(agx(lit * uExposure * mix(1.0, 1.22, uHot) * mix(1.0, 0.2, uDim)));

  // Dimming also desaturates. Exposure alone was not enough separation on the
  // layers that are mostly one saturated colour — the felt green turntable stayed
  // the loudest thing on screen even two stops down, because AgX is protecting
  // exactly that primary on purpose.
  float grey = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(grey), uDim * 0.72);

  // The hover accent: a fresnel rim in the site's acid, added in DISPLAY space
  // after the tone map. Deliberately not fed through agx() as if it were light —
  // it is not light, it is the interface pointing at something, and pushing it
  // through the transform would drag it toward white and land it as a wash
  // instead of an edge.
  float rim = 1.0 - NoV;
  rim *= rim * rim;
  col += vec3(0.776, 1.0, 0.0) * rim * uHot * 0.85;

  outColor = vec4(col * uFade, uFade);
}
`;

function cadMaterial() {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uFade: { value: 0 },
      uCamPos: { value: new THREE.Vector3(0, 0, 10) },
      uViewProj: { value: new THREE.Matrix4() },
      uExposure: { value: CAD_EXPOSURE },
      uAmbient: { value: CAD_AMBIENT },
      uAo: { value: CAD_AO },
      uHot: { value: 0 },
      uDim: { value: 0 },
    },
    vertexShader: CAD_VERT,
    fragmentShader: CAD_FRAG,
    // Premultiplied, matching the splat material, so both can fade over the same
    // black without a second blend mode in the scene.
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    // Depth ON, unlike the splats: this is solid geometry and the parts overlap.
    // Writing depth while fading can misorder a part against itself, which is
    // invisible on a fading solid and far cheaper than sorting 128k triangles.
    depthTest: true,
    depthWrite: true,
    // Backfaces culled, which halves the rasterisation of a million triangles.
    // This was DoubleSide, on the belief that decimated CAD shells could not be
    // trusted to be consistently wound. Measured, they nearly are — and the export
    // now corrects the rest: it flips the triangles whose winding disagrees with
    // their own CAD corner normals (203 of 406,422) and reverses any whole part
    // whose normals face inward (none do). 99.99% agreement afterwards; the
    // remainder are zero-area slivers with no meaningful geometric normal, which
    // cull harmlessly. gl_FrontFacing in the shader is therefore always true, so the
    // normal is used as it comes.
    side: THREE.FrontSide,
  });
}

// 'CAD4' u32 magic
// u32 layerCount, groupCount, instanceCount, vertexBlockBytes, vertexStride,
//     paletteCount
// palette:   per entry f32 r, g, b (LINEAR), u8 metallic, u8 roughness, u16 pad
// layers:    u32 groupBase, nGroups; f32 explode_dz, stackIndex,
//            f32 bboxMin xyz, bboxMax xyz                                  (40 B)
// groups:    u32 vbase, nverts, ibyte, nidx, indexBytes, ninst, instBase;
//            f32 quantOrigin xyz, quantExtent xyz                          (52 B)
// instances: f32[12], a 3x4 row-major affine, part-local -> render world   (48 B)
//
// then the vertex block (12 B/vertex: pos u16x3 quantised into the SHAPE's own
// bounding box, normal octahedral i16x2, material u8, occlusion u8) and the
// per-group index blocks.
//
// A group is one distinct SHAPE, drawn once per instance. The machine is four-fold
// symmetric and full of repeated bearings and rollers, so its 3.1M source triangles
// are only 1.07M distinct ones; storing shapes rather than parts is what buys the
// dense mechanism layers enough triangles to keep their perforations.
const CAD_MAGIC = 0x34444143; // 'CAD4' little-endian
const CAD_HEADER = 28;
const CAD_LAYER_REC = 40;
const CAD_GROUP_REC = 52;
const CAD_INST_REC = 48;

function parseCadLayers(ab: ArrayBuffer, indexAb: ArrayBuffer): CadLayer[] | null {
  if (indexAb.byteLength < CAD_HEADER) return null;
  const iv = new DataView(indexAb);
  if (iv.getUint32(0, true) !== CAD_MAGIC) return null;
  const nLayer = iv.getUint32(4, true);
  const nGroup = iv.getUint32(8, true);
  const nInst = iv.getUint32(12, true);
  const vbytes = iv.getUint32(16, true);
  const stride = iv.getUint32(20, true);
  const npal = iv.getUint32(24, true);
  const palBase = CAD_HEADER;
  const layerBase = palBase + npal * 16;
  const groupBase = layerBase + nLayer * CAD_LAYER_REC;
  const instBase = groupBase + nGroup * CAD_GROUP_REC;
  if (!nLayer || !nGroup || stride !== 12) return null;
  if (indexAb.byteLength < instBase + nInst * CAD_INST_REC) return null;

  // The palette: linear base colour, metalness and roughness per material. 72
  // entries, so it is far cheaper to send one index byte a vertex than five bytes
  // of material with every vertex.
  const palCol = new Float32Array(npal * 3);
  const palMr = new Float32Array(npal * 2);
  for (let p = 0; p < npal; p++) {
    const o = palBase + p * 16;
    palCol[p * 3] = iv.getFloat32(o, true);
    palCol[p * 3 + 1] = iv.getFloat32(o + 4, true);
    palCol[p * 3 + 2] = iv.getFloat32(o + 8, true);
    palMr[p * 2] = iv.getUint8(o + 12) / 255;
    palMr[p * 2 + 1] = iv.getUint8(o + 13) / 255;
  }

  // One shape: dequantise and de-interleave once, on load. The file's layout is the
  // compact one; the GPU gets float positions and normals, because unpacking
  // octahedral normals per vertex in the shader would cost more than the bytes it
  // saves in VRAM.
  function buildGroup(
    gi: number
  ): { geo: THREE.BufferGeometry; mats: Float32Array; planR: number } | null {
    const o = groupBase + gi * CAD_GROUP_REC;
    const vbase = iv.getUint32(o, true);
    const nverts = iv.getUint32(o + 4, true);
    const ibyte = iv.getUint32(o + 8, true);
    const nidx = iv.getUint32(o + 12, true);
    const iw = iv.getUint32(o + 16, true);
    const ninst = iv.getUint32(o + 20, true);
    const ibaseInst = iv.getUint32(o + 24, true);
    if ((vbase + nverts) * stride > vbytes) return null;
    if (iw !== 2 && iw !== 4) return null;
    if (vbytes + ibyte + nidx * iw > ab.byteLength) return null;
    if (ibaseInst + ninst > nInst) return null;

    const qx = iv.getFloat32(o + 28, true);
    const qy = iv.getFloat32(o + 32, true);
    const qz = iv.getFloat32(o + 36, true);
    const sx = iv.getFloat32(o + 40, true) / 65535;
    const sy = iv.getFloat32(o + 44, true) / 65535;
    const sz = iv.getFloat32(o + 48, true) / 65535;

    const u16 = new Uint16Array(ab, vbase * stride, nverts * 6);
    const i16 = new Int16Array(ab, vbase * stride, nverts * 6);
    const u8 = new Uint8Array(ab, vbase * stride, nverts * stride);
    const pos = new Float32Array(nverts * 3);
    const nrm = new Float32Array(nverts * 3);
    const col = new Float32Array(nverts * 3);
    const mra = new Uint8Array(nverts * 3);
    for (let v = 0; v < nverts; v++) {
      const s = v * 6;
      const d = v * 3;
      pos[d] = qx + u16[s] * sx;
      pos[d + 1] = qy + u16[s + 1] * sy;
      pos[d + 2] = qz + u16[s + 2] * sz;

      // Octahedral decode. The fold is the whole trick: the lower hemisphere is
      // stored mirrored into the corners of the square, so both hemispheres get the
      // full 16-bit range instead of one wasting half of it.
      let nx = i16[s + 3] / 32767;
      let ny = i16[s + 4] / 32767;
      const nz = 1 - Math.abs(nx) - Math.abs(ny);
      if (nz < 0) {
        const ax = nx;
        nx = (1 - Math.abs(ny)) * (ax >= 0 ? 1 : -1);
        ny = (1 - Math.abs(ax)) * (ny >= 0 ? 1 : -1);
      }
      const inv = 1 / Math.hypot(nx, ny, nz);
      nrm[d] = nx * inv;
      nrm[d + 1] = ny * inv;
      nrm[d + 2] = nz * inv;

      const pi = u8[v * stride + 10];
      col[d] = palCol[pi * 3];
      col[d + 1] = palCol[pi * 3 + 1];
      col[d + 2] = palCol[pi * 3 + 2];
      mra[d] = Math.round(palMr[pi * 2] * 255);
      mra[d + 1] = Math.round(palMr[pi * 2 + 1] * 255);
      mra[d + 2] = u8[v * stride + 11];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('mra', new THREE.BufferAttribute(mra, 3, true));
    geo.setIndex(
      new THREE.BufferAttribute(
        iw === 2
          ? new Uint16Array(ab, vbytes + ibyte, nidx)
          : new Uint32Array(ab, vbytes + ibyte, nidx),
        1
      )
    );

    // Instance matrices, stored 3x4 row-major and expanded to the column-major mat4
    // three wants.
    const mats = new Float32Array(ninst * 16);
    for (let k = 0; k < ninst; k++) {
      const mo = instBase + (ibaseInst + k) * CAD_INST_REC;
      const m = mats.subarray(k * 16, k * 16 + 16);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 4; c++) m[c * 4 + r] = iv.getFloat32(mo + (r * 4 + c) * 4, true);
      }
      m[15] = 1;
    }

    // How far this shape reaches from the explode axis, at any yaw. Needed
    // because the isolated framing has to be rotation-invariant (see fitHalfW),
    // and neither box that is already to hand is a usable bound for that: the
    // LAYER's box is square around a stack of DISCS, so its corner is 1.41x the
    // true radius, and the per-shape box corner is not much better on the curved
    // tracks and rings this machine is mostly made of. Fitted to either, an
    // isolated part came out a third smaller than the frame could hold.
    //
    // So: a bounding SPHERE per shape, which is one extra pass over vertices that
    // are already in cache from the dequantise above, and is measured once per
    // shape rather than once per instance — the four-fold symmetry means that is
    // a quarter of the work. Through a similarity (which every transform in this
    // assembly was verified to be) a sphere stays a sphere, so each instance
    // costs one transform and one scale.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let v = 0; v < nverts; v++) {
      cx += pos[v * 3];
      cy += pos[v * 3 + 1];
      cz += pos[v * 3 + 2];
    }
    const inv = nverts > 0 ? 1 / nverts : 0;
    cx *= inv;
    cy *= inv;
    cz *= inv;
    let r2 = 0;
    for (let v = 0; v < nverts; v++) {
      const dx = pos[v * 3] - cx;
      const dy = pos[v * 3 + 1] - cy;
      const dz = pos[v * 3 + 2] - cz;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    const rad = Math.sqrt(r2);

    let planR = 0;
    for (let k = 0; k < ninst; k++) {
      const m = mats.subarray(k * 16, k * 16 + 16);
      const wx = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
      const wz = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
      const scale = Math.hypot(m[0], m[1], m[2]);
      planR = Math.max(planR, Math.hypot(wx, wz) + rad * scale);
    }
    return { geo, mats, planR };
  }

  const layers: {
    gbase: number;
    ngroups: number;
    explodeY: number;
    stackIndex: number;
    lo: number[];
    hi: number[];
  }[] = [];
  for (let i = 0; i < nLayer; i++) {
    const o = layerBase + i * CAD_LAYER_REC;
    const gbase = iv.getUint32(o, true);
    const ngroups = iv.getUint32(o + 4, true);
    if (gbase + ngroups > nGroup) return null;
    layers.push({
      gbase,
      ngroups,
      explodeY: iv.getFloat32(o + 8, true),
      stackIndex: iv.getFloat32(o + 12, true),
      lo: [iv.getFloat32(o + 16, true), iv.getFloat32(o + 20, true), iv.getFloat32(o + 24, true)],
      hi: [iv.getFloat32(o + 28, true), iv.getFloat32(o + 32, true), iv.getFloat32(o + 36, true)],
    });
  }

  // Seats, exactly as the splat path derived them: the CAD's own proportions
  // blended toward even spacing by stack index, because taken literally the stack
  // is 17.7 units tall against a 5-unit-wide table.
  const maxDy = Math.max(0, ...layers.map((r) => r.explodeY));
  const maxStack = Math.max(0, ...layers.map((r) => r.stackIndex));

  const out: CadLayer[] = [];
  for (const r of layers) {
    const material = cadMaterial();
    const root = new THREE.Group();
    // After the splats, which draw with depthTest off and would otherwise paint the
    // dissolving capture over the drawing replacing it.
    root.renderOrder = 1;
    root.visible = false;
    const meshes: THREE.InstancedMesh[] = [];
    const geometries: THREE.BufferGeometry[] = [];
    let planR = 0;
    for (let gi = r.gbase; gi < r.gbase + r.ngroups; gi++) {
      const built = buildGroup(gi);
      if (!built) return null;
      planR = Math.max(planR, built.planR);
      const ninst = built.mats.length / 16;
      const im = new THREE.InstancedMesh(built.geo, material, ninst);
      im.instanceMatrix = new THREE.InstancedBufferAttribute(built.mats, 16);
      im.instanceMatrix.needsUpdate = true;
      // The vertex shader applies instanceMatrix itself, so three's own bounding
      // volumes would be computed from the untransformed shape. Nothing here is ever
      // off screen during the one beat that draws it.
      im.frustumCulled = false;
      im.renderOrder = 1;
      root.add(im);
      meshes.push(im);
      geometries.push(built.geo);
    }

    const t =
      r.stackIndex < 0
        ? 0
        : lerp(
            maxDy > 0 ? r.explodeY / maxDy : 0,
            maxStack > 0 ? r.stackIndex / maxStack : 0,
            FINALE_EVENNESS
          );
    // The layer's own extents come from the sidecar. They have to: the vertices are
    // in per-shape local space now, so measuring them here would mean transforming
    // every one of them by every instance matrix just to reproduce a number the
    // exporter already knew.
    out.push({
      meshes,
      geometries,
      material,
      root,
      minY: r.lo[1],
      maxY: r.hi[1],
      centreY: (r.lo[1] + r.hi[1]) / 2,
      radius: Math.max(0.001, (r.hi[0] - r.lo[0]) / 2, (r.hi[1] - r.lo[1]) / 2),
      seatY: t * FINALE_SPAN,
      lag: t,
      box: new THREE.Box3(
        new THREE.Vector3(r.lo[0], r.lo[1], r.lo[2]),
        new THREE.Vector3(r.hi[0], r.hi[1], r.hi[2])
      ),
      planR: Math.max(0.001, planR),
      hot: 0,
      alpha: 1,
    });
  }
  return out;
}

// A bare point cloud (STL path) has no gaussians — give every point the same
// small isotropic one so it still renders through the splat pipeline.
function synthesiseSplats(ab: ArrayBuffer, limit: number): ModelSource {
  const all = new Float32Array(ab);
  const count = Math.min(Math.floor(all.length / 3), limit);
  const pos = all.subarray(0, count * 3);
  const scale = new Float32Array(count * 3).fill(0.01);
  const quat = new Float32Array(count * 4);
  const color = new Float32Array(count * 3);
  const opacity = new Float32Array(count).fill(0.9);
  for (let i = 0; i < count; i++) quat[i * 4 + 3] = 1; // identity
  return { count, pos, scale, quat, color, opacity, photoreal: false, layers: null };
}

const TEX_W = 2048;
const TEXELS_PER_SPLAT = 8;

type SplatData = {
  count: number;
  texture: THREE.DataTexture;
  // CPU copies of the animated centres — the depth sort needs to know where each
  // splat currently is, and the morph itself runs on the GPU.
  scatterA: Float32Array;
  textHome: Float32Array;
  modelHome: Float32Array;
  // Single-capture fallback: the radial blast target. In sequence mode the same
  // three texture slots carry the arrival instead — (convergence rank, grain,
  // unused) — because a capture in a sequence never blasts anywhere.
  scatterB: Float32Array;
  delayForm: Float32Array;
  delayMorph: Float32Array;
  delayBlast: Float32Array;
  // Teardown (sequence mode only): where this splat sits in its layer's
  // top-first order, and how far the layer carries it when it is removed. The
  // depth sort has to reproduce the shader's travel exactly or the two captures
  // interleave in the wrong order right where they overlap most.
  phase: Float32Array;
  exit: Float32Array;
  // The captures to walk through, when the cloud is a sequence rather than one
  // model. Null keeps the old single-capture behaviour, radial blast and all.
  layers: LayerRange[] | null;
};

// Build the whole system: each splat knows its fly-in origin, its seat in the
// text, its place on the model, and where it goes when the model tears apart.
// All of it is packed into a float texture and morphed in the vertex shader —
// at 150k splats a per-frame CPU lerp would not hold 60fps.
function buildSplatData(text: string, src: ModelSource): SplatData {
  // Poster type is shouted: uppercase the latin, CJK passes through unchanged.
  const { coords, cw, ch } = sampleLockup(text.toUpperCase());
  const textCount = Math.max(1, coords.length / COORD_STRIDE);
  const count = src.count;

  const layers = src.layers;
  // Which capture each splat belongs to, and where it sits inside that capture.
  // The text beat needs the second one: a splat's seat in the word has to be
  // spread across the whole lockup relative to *its own capture*, because only
  // one capture is drawn at a time. Keyed on the global index instead and each
  // capture would render one ninth of the word.
  const layerOf = new Float32Array(count);
  const localIdx = new Float32Array(count);
  const localOf = new Float32Array(count);
  if (layers) {
    layers.forEach((r, li) => {
      for (let j = 0; j < r.count; j++) {
        layerOf[r.offset + j] = li;
        localIdx[r.offset + j] = j;
        localOf[r.offset + j] = r.count;
      }
    });
  } else {
    for (let k = 0; k < count; k++) {
      localIdx[k] = k;
      localOf[k] = count;
    }
  }
  const scatterA = new Float32Array(count * 3);
  const textHome = new Float32Array(count * 3);
  const modelHome = new Float32Array(count * 3);
  const scatterB = new Float32Array(count * 3);
  const delayForm = new Float32Array(count);
  const delayMorph = new Float32Array(count);
  const delayBlast = new Float32Array(count);
  const phase = new Float32Array(count);
  const exit = new Float32Array(count);

  // Coarse-to-fine order for the arrival, one ranking per capture: 0 is the
  // biggest gaussian in its layer, 1 the smallest. A 3DGS optimiser starts with
  // a few large blobs and densifies into fine ones, so resolving in this order
  // is what makes an arriving layer read as being TRAINED into place rather than
  // faded in — the one thing in the whole hero that only a gaussian cloud can do.
  //
  // Ranked by histogram rather than by sorting. A comparison sort of 325k splats
  // runs on the main thread inside the same blocking build as the 40 MB texture;
  // a 512-bin cumulative histogram is O(n), and the rank only has to be a
  // percentile. Binned on log size because 3DGS scales are heavy-tailed — linear
  // bins put ~99% of every capture in the first one.
  const rank = new Float32Array(count);
  if (layers) {
    const BINS = 512;
    const hist = new Uint32Array(BINS);
    const cum = new Float32Array(BINS);
    const key = new Float32Array(Math.max(1, ...layers.map((r) => r.count)));
    for (const r of layers) {
      hist.fill(0);
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = 0; j < r.count; j++) {
        const s3 = (r.offset + j) * 3;
        const a = Math.log(
          Math.max(1e-6, src.scale[s3], src.scale[s3 + 1], src.scale[s3 + 2])
        );
        key[j] = a;
        if (a < lo) lo = a;
        if (a > hi) hi = a;
      }
      const sc = hi > lo ? (BINS - 1) / (hi - lo) : 0;
      for (let j = 0; j < r.count; j++) hist[((key[j] - lo) * sc) | 0]++;
      // Cumulated from the TOP bin down, so the biggest gaussians get rank ~0.
      let acc = 0;
      for (let b = BINS - 1; b >= 0; b--) {
        cum[b] = acc / Math.max(1, r.count);
        acc += hist[b];
      }
      for (let j = 0; j < r.count; j++) rank[r.offset + j] = cum[((key[j] - lo) * sc) | 0];
    }
  }

  // Fit the poster to the viewport: the camera rests at z=10 with fov 50, so
  // the visible width at the word's plane (z=0) is 2*tan(25°)*10*aspect ≈
  // 9.33*aspect world units. Desktop keeps the full 9-unit poster; narrow
  // screens shrink the lockup so the wordmark is never cropped mid-glyph.
  const aspect =
    typeof window !== 'undefined'
      ? window.innerWidth / Math.max(1, window.innerHeight)
      : 16 / 9;
  const worldW = Math.min(9, 9.33 * aspect * 0.92);
  const worldH = (worldW * ch) / cw; // keep text aspect

  // model vertical range, for the fallback gradient
  let minY = Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < count; k++) {
    const y = src.pos[k * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // Strict monochrome particles with a rare acid strike — poster ink, not confetti.
  const cSmoke = new THREE.Color('#f5f5f3');
  const cGray = new THREE.Color('#8a8a86');
  const cAcid = new THREE.Color('#c6ff00');
  const cCharcoal = new THREE.Color('#2a2a28');
  const tmp = new THREE.Color();

  // Splats are dealt to coords in a shuffled order: the quality governor trims
  // by instanceCount (first n splat indices), and a monotone index→coord map
  // would erase the lockup bottom-up on weak devices — the secondary line
  // first. Shuffled, a trim just thins the grain evenly everywhere.
  const coordOf = new Uint32Array(textCount);
  for (let i = 0; i < textCount; i++) coordOf[i] = i;
  for (let i = textCount - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = coordOf[i];
    coordOf[i] = coordOf[j];
    coordOf[j] = t;
  }

  const texH = Math.ceil((count * TEXELS_PER_SPLAT) / TEX_W);
  const data = new Float32Array(TEX_W * texH * 4);

  for (let k = 0; k < count; k++) {
    const i3 = k * 3;

    // text home: spread the splats evenly across the rasterised text pixels.
    // ~10+ splats share each sampled pixel, so scatter them across the sampling
    // cell — without the jitter they stack into one fat dot per lattice point
    // and the word reads as chunky mush instead of fine grain.
    const o6 =
      coordOf[Math.floor((localIdx[k] * textCount) / localOf[k]) % textCount] * COORD_STRIDE;
    const tx = coords[o6] ?? cw / 2;
    const ty = coords[o6 + 1] ?? ch / 2;
    // jitter across the cell of the lattice this pixel was sampled on — the
    // fine band gets proportionally tighter scatter, which is what keeps its
    // small glyph edges sharp
    const step = coords[o6 + 5] ?? SAMPLE_STEP;
    const cell = (worldW * step) / cw;
    textHome[i3] = (tx / cw - 0.5) * worldW + (Math.random() - 0.5) * cell;
    textHome[i3 + 1] = -(ty / ch - 0.5) * worldH + (Math.random() - 0.5) * cell;
    // thin slab: a deep z-jitter blurs the word's edges — and the fine band's
    // small glyphs can afford even less of it
    textHome[i3 + 2] = (Math.random() - 0.5) * (step < SAMPLE_STEP ? 0.08 : 0.18);

    modelHome[i3] = src.pos[i3];
    modelHome[i3 + 1] = src.pos[i3 + 1];
    modelHome[i3 + 2] = src.pos[i3 + 2];

    // fly-in origin: point on a surrounding sphere, kept in front of the camera
    // (z <= ~4 vs camera z=10) — splats that spawn at the near plane project to
    // screen-filling blobs and read as static noise.
    const rA = 7 + Math.random() * 8;
    const thA = Math.random() * Math.PI * 2;
    const phA = Math.acos(2 * Math.random() - 1);
    scatterA[i3] = Math.sin(phA) * Math.cos(thA) * rA;
    scatterA[i3 + 1] = Math.sin(phA) * Math.sin(thA) * rA * 0.75;
    scatterA[i3 + 2] = Math.cos(phA) * rA * 0.65 - 6;

    const mx = modelHome[i3];
    const my = modelHome[i3 + 1];
    // In sequence mode this splat never goes anywhere but straight up, so the
    // three slots that held a scatter target carry the arrival instead: the
    // convergence rank, a per-splat grain, and one spare. A single capture has
    // no sequence to walk, so it keeps the radial throw it always had.
    const rg = layers ? layers[layerOf[k]] : null;
    if (rg) {
      scatterB[i3] = rank[k];
      scatterB[i3 + 1] = Math.random();
      scatterB[i3 + 2] = 0;
      // Axial removal distance. Near-identical across the layer — the part is
      // rigid, and it is the ONE place a few percent of per-splat variation is
      // worth spending, because a perfectly uniform translation is the tell that
      // gives away a mesh.
      exit[k] = rg.exit * (0.96 + Math.random() * 0.08);
      // Top-first order, used twice: it peels the removal (the lid unsticks
      // before the base) and it is the scan line the layer underneath resolves
      // along. Grained with noise so neither reads as a straight wipe.
      const h = (my - rg.minY) / Math.max(1e-4, rg.maxY - rg.minY);
      phase[k] = clamp01(lerp(Math.random(), 1 - h, SEQ_HEIGHT_BIAS));
    } else {
      const ang = Math.atan2(my, mx) + (Math.random() - 0.5) * 0.8;
      const dist = 7 + Math.random() * 12;
      scatterB[i3] = mx + Math.cos(ang) * dist;
      scatterB[i3 + 1] = my + Math.sin(ang) * dist + (Math.random() - 0.3) * 3;
      scatterB[i3 + 2] = modelHome[i3 + 2] + (Math.random() - 0.5) * 14;
    }

    // staggers: assemble left->right, morph ripples randomly. In sequence mode
    // the blast delay slot carries the capture index instead — see above.
    const nx = textHome[i3] / worldW + 0.5;
    delayForm[k] = Math.min(MAX_FORM_DELAY, Math.max(0, nx * 0.07 + Math.random() * 0.02));
    delayMorph[k] = Math.random() * MAX_MORPH_DELAY;
    delayBlast[k] = layers ? layerOf[k] : Math.random() * 0.12;

    // text colour: the rule/tile pixels keep their drawn acid colour; white ink
    // gets the grain mix — smoke body, a little gray shadow, rare acid strikes.
    // Gray/acid kept sparse (mottling reads as dirt, not texture), and the fine
    // band gets none of the acid and even less gray: at small glyph sizes any
    // off-colour speck reads as a damaged letter.
    let tr: number;
    let tg: number;
    let tb: number;
    if ((coords[o6 + 4] ?? 255) < 128) {
      tr = coords[o6 + 2] / 255;
      tg = coords[o6 + 3] / 255;
      tb = coords[o6 + 4] / 255;
    } else {
      const rc = Math.random();
      const tc =
        step < SAMPLE_STEP
          ? rc < 0.96
            ? cSmoke
            : cGray
          : rc < 0.93
            ? cSmoke
            : rc < 0.98
              ? cGray
              : cAcid;
      tr = tc.r;
      tg = tc.g;
      tb = tc.b;
    }

    // model colour: photoreal from the capture (graded high-contrast B&W in the
    // shader), else a charcoal->smoke height gradient for the bare CAD cloud
    let mr: number;
    let mg: number;
    let mb: number;
    if (src.photoreal) {
      mr = src.color[i3];
      mg = src.color[i3 + 1];
      mb = src.color[i3 + 2];
    } else if (maxY > minY) {
      tmp.copy(cCharcoal).lerp(cSmoke, (modelHome[i3 + 1] - minY) / (maxY - minY));
      if (Math.random() < 0.04) tmp.copy(cAcid);
      mr = tmp.r;
      mg = tmp.g;
      mb = tmp.b;
    } else {
      mr = tr;
      mg = tg;
      mb = tb;
    }

    // pack 8 RGBA texels per splat (see the fetch() calls in the vertex shader)
    const o = k * TEXELS_PER_SPLAT * 4;
    data[o] = scatterA[i3];
    data[o + 1] = scatterA[i3 + 1];
    data[o + 2] = scatterA[i3 + 2];
    data[o + 3] = delayForm[k];
    data[o + 4] = textHome[i3];
    data[o + 5] = textHome[i3 + 1];
    data[o + 6] = textHome[i3 + 2];
    data[o + 7] = delayMorph[k];
    data[o + 8] = modelHome[i3];
    data[o + 9] = modelHome[i3 + 1];
    data[o + 10] = modelHome[i3 + 2];
    data[o + 11] = delayBlast[k];
    data[o + 12] = scatterB[i3];
    data[o + 13] = scatterB[i3 + 1];
    data[o + 14] = scatterB[i3 + 2];
    data[o + 15] = src.opacity[k];
    data[o + 16] = tr;
    data[o + 17] = tg;
    data[o + 18] = tb;
    // per-splat text alpha: the fine band runs ~2x the wordmark's splat
    // density, so its splats render at ~half alpha — equal ink coverage from
    // twice the positions is what keeps small glyph edges sharp
    data[o + 19] = step < SAMPLE_STEP ? 0.55 : 1;
    data[o + 20] = mr;
    data[o + 21] = mg;
    data[o + 22] = mb;
    data[o + 23] = exit[k]; // axial removal distance (sequence only; 0 otherwise)
    data[o + 24] = src.scale[i3];
    data[o + 25] = src.scale[i3 + 1];
    data[o + 26] = src.scale[i3 + 2];
    data[o + 27] = phase[k]; // top-first order (sequence only; 0 otherwise)
    data[o + 28] = src.quat[k * 4];
    data[o + 29] = src.quat[k * 4 + 1];
    data[o + 30] = src.quat[k * 4 + 2];
    data[o + 31] = src.quat[k * 4 + 3];
  }

  const texture = new THREE.DataTexture(data, TEX_W, texH, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;

  return {
    count,
    texture,
    scatterA,
    textHome,
    modelHome,
    scatterB,
    delayForm,
    delayMorph,
    delayBlast,
    phase,
    exit,
    layers,
  };
}

const f = (n: number) => n.toFixed(5);

// Gaussian splatting proper: project each 3D gaussian's covariance into a 2D
// screen-space ellipse, draw it as an instanced quad with exp() falloff, and
// alpha-blend the lot back-to-front. The morph rides along by lerping the
// centre/colour and blooming the scale from an isotropic text dot into the
// captured anisotropic gaussian.
const SPLAT_VERT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

in vec3 position;   // quad corner, xy in [-2,2]
in float iIndex;    // which splat this instance draws (depth-sorted each frame)

uniform sampler2D uData;
uniform int uTexW;
uniform float uProgress;
uniform vec2 uFocal;
uniform vec2 uViewport;
uniform float uTextDot;
uniform float uTextAlpha;
uniform float uMaxAxis; // screen-px cap on the projected ellipse — bounds worst-case fill
uniform float uGrade; // 1 => photoreal capture: grade it into the site's monochrome
// How much the tear-apart beat dims. A radial blast ends on a noise field and
// wants to dissolve away; a sequence never blasts at all, so this goes to 0.
uniform float uBlastFade;
// Walking the capture sequence: uSequence gates it, uLayer is the (fractional)
// position in the walk. t2.w carries the splat's capture index in this mode.
uniform float uSequence;
uniform float uLayer;
// Teardown shape — see the SEQ_* block for what each one buys.
uniform float uEvapEnd;
uniform float uEvapStagger;
uniform float uEvapScan;
uniform float uDeflate;
uniform float uLiftStart;
uniform float uPeel;
uniform float uSmear;
uniform float uReveal;
uniform float uDensScan;
uniform float uGrain;
uniform float uTint;
// Hand-over to the closing diagram. The captures do not draw it — CAD does — so
// all this beat asks of the splats is that the walk's last one dissolves out
// while its drawing dissolves in, in the same place.
uniform float uSplatOut;
// The direction a part travels when it is removed, in object space: whatever
// currently points straight up the SCREEN. It has to be screen-relative and
// cannot be the machine's own axis, however much the CAD explode says otherwise.
// The group is pitched 43 degrees to look down at the playfield, so the object's
// +Y points up AND two thirds of the way toward the camera — a part sent along
// it does not leave the frame, it flies through the lens, filling the screen
// with a blurred close-up of its own underside. Every exploded-view drawing ever
// made separates parts up the page for the same reason.
uniform vec3 uAxis;
// Share of splats drawn. Slides down through a handoff (where the image is a
// smear) and back to 1 on a hold; alpha is paid back by the same factor, so
// the ink is unchanged and only the fill-rate moves.
uniform float uDensity;
uniform vec2 uMouse;  // cursor on the z=0 plane, world units
uniform float uTime;
uniform float uRepel;

out vec4 vColor;
out vec2 vQuad;

vec4 fetch(int i, int t) {
  int k = i * ${TEXELS_PER_SPLAT} + t;
  return texelFetch(uData, ivec2(k % uTexW, k / uTexW), 0);
}

float clamp01(float t) { return clamp(t, 0.0, 1.0); }
float easeOutCubic(float t) { float u = 1.0 - t; return 1.0 - u * u * u; }
float easeInCubic(float t) { return t * t * t; }
float smoothstep01(float t) { return t * t * (3.0 - 2.0 * t); }

// Near-total desaturation + contrast punch: silver-gelatin print, not sepia.
vec3 gradeMono(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 d = mix(c, vec3(l), 0.88);
  d = (d - 0.5) * 1.22 + 0.54;
  return clamp(d, 0.0, 1.0);
}

// Integer hash — a stable per-splat draw in [0,1) for the density LOD. sin()
// hashing breaks down here: iIndex runs to ~325k, and sin(iIndex * 12.9898)
// loses every bit that mattered to float32 rounding long before that.
float hash11(uint n) {
  n = (n ^ 61u) ^ (n >> 16);
  n *= 9u;
  n = n ^ (n >> 4);
  n *= 0x27d4eb2du;
  n = n ^ (n >> 15);
  return float(n & 0xffffffu) / 16777216.0;
}

mat3 quatToMat(vec4 q) {
  float x = q.x, y = q.y, z = q.z, w = q.w;
  return mat3(
    1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z),       2.0 * (x * z - w * y),
    2.0 * (x * y - w * z),       1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
    2.0 * (x * z + w * y),       2.0 * (y * z - w * x),       1.0 - 2.0 * (x * x + y * y)
  );
}

void main() {
  int i = int(iIndex);

  vec4 t0 = fetch(i, 0); // scatterA.xyz, delayForm
  vec4 t1 = fetch(i, 1); // textHome.xyz, delayMorph
  vec4 t2 = fetch(i, 2); // modelHome.xyz, delayBlast (== capture index in sequence mode)
  vec4 t3 = fetch(i, 3); // blast target — (rank, grain, -) in sequence mode; opacity
  vec4 t4 = fetch(i, 4); // textColor
  vec4 t5 = fetch(i, 5); // modelColor, axial removal distance
  vec4 t6 = fetch(i, 6); // scale, top-first order
  vec4 t7 = fetch(i, 7); // quat xyzw

  float a = easeOutCubic(clamp01((uProgress - t0.w) / ${f(ASSEMBLE_WINDOW)}));
  float m = smoothstep01(clamp01((uProgress - ${f(MORPH_START)} - t1.w) / ${f(MORPH_END - MORPH_START)}));

  // ---- teardown ------------------------------------------------------------
  // d places this splat's capture against the walk: > 0 it has been taken off,
  // < 0 it is still buried under the one on screen, 0 it IS the one on screen.
  // The two sides are asymmetric on purpose — see the SEQ_* block. One of them
  // travels and the other never moves, so something is always at rest.
  float d = (uLayer - t2.w) * uSequence;
  float dep = max(d, 0.0);  // removal  (0 seated, 1 gone)
  float arr = max(-d, 0.0); // burial   (1 buried, 0 resolved)

  // REMOVAL, part one: EVAPORATION, keyed on this gaussian's own size.
  // t3.x is the coarse-to-fine rank — 0 is the biggest gaussian in this capture,
  // 1 the smallest — and in a 3DGS capture that ranks flat painted area against
  // fine detail. Ordering the fade by it dissolves the part's SURFACES while its
  // EDGES persist, so the shell opens into a tracery of its own seams and
  // fasteners and the mechanism inside shows through. This is the whole argument
  // for capturing the machine as gaussians: the primitive carries a frequency,
  // and no mesh primitive does.
  // uSequence zeroes the trigger for the single-capture fallback, where t3 holds
  // a blast target and these numbers are world coordinates, not fractions.
  float etrig = mix(mix(t3.x, t6.w, uEvapScan), t3.y, uGrain) * uSequence;
  float eu = clamp01(dep / uEvapEnd);
  float evap = clamp01((eu - etrig * uEvapStagger) / (1.0 - uEvapStagger));
  float outA = 1.0 - evap;
  // Deflate as it goes. A gaussian that fades without shrinking bloats into a
  // soft cloud on the way out and the shell fogs over instead of opening; this
  // keeps every surviving splat tight, so what is left reads as detail rather
  // than as haze.
  float shrink = 1.0 - uDeflate * evap;

  // REMOVAL, part two: the LIFT, along one axis, up and out of frame (see uAxis).
  // Deliberately late — by the time it starts the part is already porous, so it
  // never drags an opaque mass across the layer it is revealing. A small
  // top-first peel (t6.w) breaks the travel up. Written as a plain quadratic
  // rather than pow(): the depth sort runs this per splat per frame on the CPU,
  // where two multiplies are free and pow() is not.
  float liftU = clamp01((dep - uLiftStart) / (1.0 - uLiftStart));
  float peel = clamp01((liftU - t6.w * uPeel) / (1.0 - uPeel));
  float go = peel * (${f(SEQ_LAUNCH)} + ${f(1 - SEQ_LAUNCH)} * peel);

  // ARRIVAL — no travel, and no blur either. Every splat is at its true
  // covariance from the moment it appears, so the layer underneath is sharp and
  // readable the whole way in. What ramps is how many of its gaussians EXIST:
  // biggest first, then finer, which is the order the capture was densified in
  // during training. A mesh cannot be a third of itself; a cloud can.
  float rev = 1.0 - arr;
  float atrig = mix(mix(t3.x, t6.w, uDensScan), t3.y, uGrain) * uSequence;
  float born = clamp01((rev - atrig * uReveal) / (1.0 - uReveal));
  // x3 so a splat snaps to full opacity over the first third of its own window:
  // it pops into existence rather than ghosting in, which is what keeps the
  // arriving layer looking solid instead of translucent.
  float inA = smoothstep01(clamp01(born * 3.0));

  // Weight of this splat: the removal evaporates it, the arrival densifies it in,
  // and the hand-over takes the last one out. Unlike the crossfade this replaces,
  // the two sides do NOT have to sum to 1 — the leaving part exits the frame
  // instead of dissolving inside it, so nothing double-exposes at centre screen
  // and the arriving layer's curve is free.
  float lf = outA * inA * (1.0 - uSplatOut);

  // Nothing inflates any more. The leaving part shrinks (which is what lets the
  // shell open rather than fog) and the arriving part is never anything but its
  // true size, so peak fill through a handoff is now BELOW a held capture instead
  // of several times above it.
  float bloom = shrink;
  // The leftover skeleton streaks along the one direction it is moving in.
  float smear = 1.0 + uSmear * peel;
  float stretch = sqrt(1.0 + (smear - 1.0) * (smear - 1.0));

  // The ink solver below must see only the area changes that are SAMPLING
  // decisions, never the ones that are the effect itself. The motion streak is a
  // sampling decision: spreading a splat's light along its travel is what motion
  // blur is, and it conserves. The DEFLATE is not. It is the evaporation, and a
  // surface that is shrinking away is supposed to lose ink.
  //
  // Compensating it was measurably wrong, not just conceptually: at the deflate
  // floor a splat covers ~0.16 of its seated area, so ink conservation handed it
  // 6x the alpha and the dissolving shell came back as a field of hot mottled
  // blobs — brighter mid-evaporation than it had been solid.
  float area = stretch;

  // Density LOD, applied where there is alpha headroom to pay it back — and
  // ONLY there. Thinning uniformly and compensating everyone by 1/uDensity is
  // the obvious version and it is wrong: a splat still near its seat is already
  // near full opacity, so asking it for alpha > 1 just clamps in the blend, the
  // ink is lost, and the machine dims through the middle of every handoff
  // (measured at 22% down, with two thirds of splats saturating). Solving for
  // the alpha each splat actually needs and never thinning past it costs
  // nothing and holds brightness to ~0.05%. It also takes the fill off exactly
  // where it is expensive: the splats with headroom are the dispersed ones,
  // which are the ones covering the most screen.
  float need = t3.w * lf / area; // alpha this splat wants at full density
  float dens = max(uDensity, need);
  if (dens < 1.0 && hash11(uint(i)) > dens) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  // Ink is conserved exactly: drawn with probability dens at alpha need/dens
  // over area, the expected contribution is need*area — what it would have been
  // seated, scaled by its weight. So thinning never changes what the frame looks
  // like, only what it costs, whether it is a handoff or the wide diagram shot.
  float energy = 1.0 / (area * dens);

  vec3 base = mix(t0.xyz, t1.xyz, a);
  vec3 formed = mix(base, t2.xyz, m);
  // Single-capture fallback only: that cloud has no sequence to walk, so it
  // still ends on the radial blast it always did. uSequence kills it outright —
  // in sequence mode t3.xyz carries convergence data, not a position.
  float blast =
    easeInCubic(clamp01((uProgress - ${f(BLAST_START)} - t2.w) / ${f(1 - BLAST_START)}))
    * (1.0 - uSequence);
  vec3 center = mix(formed, t3.xyz, blast);
  // The one motion in the whole walk: straight up and out while the layer is
  // being removed. One axis, one direction, bounded by the frame — which is why
  // nothing scatters across the page any more. t5.w is 0 outside sequence mode.
  center += uAxis * (t5.w * go * uSequence);

  // Cursor repulsion + idle simmer, text phase only (the photoreal model must
  // not smear). GPU-only offsets are small enough not to upset the CPU depth
  // sort. This is the animejs.com "poke the letters" interaction — a gentle
  // bulge, not a crater (the word is only ~1.5 units tall).
  float live = (1.0 - m) * (1.0 - blast) * a;
  vec2 dm = center.xy - uMouse;
  float dl = length(dm);
  center.xy += (dm / max(dl, 0.2)) * exp(-dl * dl * 3.0) * uRepel * live;
  center.x += sin(uTime * 1.1 + iIndex * 0.37) * 0.014 * live;
  center.y += cos(uTime * 1.4 + iIndex * 0.53) * 0.014 * live;

  // In-flight splats stay faint dust and brighten as they seat into the word;
  // the explosion dissolves to black instead of ending on a noise field.
  float dust = mix(0.05, 1.0, a);
  float fade = 1.0 - uBlastFade * blast;

  vec3 modelCol = mix(t5.rgb, gradeMono(t5.rgb), uGrade);
  // Acid on the gaussians that are mid-evaporation. Because the order is by size
  // with a top-down bias, the ones caught in the act form a front sweeping down
  // the part — the shell is visibly being taken apart along a line rather than
  // uniformly. It also covers the colour step between two captures that came out
  // of two separate trainings.
  modelCol = mix(modelCol, vec3(0.776, 1.0, 0.0), uTint * evap * (1.0 - evap) * 4.0);
  // t4.w: per-splat text alpha factor — the finely-sampled lockup band packs
  // ~2x the splat density and pays it back here so strokes don't bloom fat
  vColor = vec4(
    mix(t4.rgb, modelCol, m),
    mix(uTextAlpha * t4.w * dust, t3.w, m) * fade * lf * mix(1.0, energy, uSequence)
  );

  // Below one 8-bit step this splat cannot tint a pixel, but a de-converged
  // gaussian is at its LARGEST exactly when it is faintest — so the tail of
  // every handoff is where the invisible fill would otherwise pile up.
  if (vColor.a < 0.005) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  // text particles are isotropic dots that bloom into the real gaussian
  vec3 scale = mix(vec3(uTextDot), t6.xyz, m) * bloom;

  vec4 cam = modelViewMatrix * vec4(center, 1.0);
  vec4 clip = projectionMatrix * cam;

  float lim = 1.3 * clip.w;
  if (clip.w <= 0.0 || abs(clip.x) > lim || abs(clip.y) > lim) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // offscreen
    return;
  }

  mat3 R = quatToMat(normalize(t7));
  mat3 S = mat3(scale.x, 0.0, 0.0, 0.0, scale.y, 0.0, 0.0, 0.0, scale.z);
  mat3 Mx = R * S;
  mat3 sigma = Mx * transpose(Mx); // 3D covariance = R S S^T R^T

  // Motion smear as a rank-1 term on that covariance: the gaussian stretches
  // along the direction it is travelling, so a part being removed reads as
  // streaks pulling up off the machine rather than dots sliding. This is the
  // whole argument for splatting the removal instead of cross-fading it — the
  // shape of each primitive carries the motion, and a sprite has no shape to
  // give. The direction is uAxis, because that is now the only direction
  // anything travels; the length is tied to the splat's own size, so it is
  // always a streak and never a smudge across the frame.
  if (smear > 1.0) {
    float ax = max(max(scale.x, scale.y), scale.z) * (smear - 1.0);
    sigma += (ax * ax) * outerProduct(uAxis, uAxis);
  }

  // Jacobian of the perspective projection at cam (column-major constructor).
  // Its overall sign cancels in T*sigma*T^T, so cam.z < 0 is fine.
  mat3 J = mat3(
    uFocal.x / cam.z, 0.0, 0.0,
    0.0, uFocal.y / cam.z, 0.0,
    -(uFocal.x * cam.x) / (cam.z * cam.z), -(uFocal.y * cam.y) / (cam.z * cam.z), 0.0
  );
  mat3 T = J * mat3(modelViewMatrix);
  mat3 cov = T * sigma * transpose(T);

  // dilate so sub-pixel gaussians stay visible instead of aliasing away
  cov[0][0] += 0.3;
  cov[1][1] += 0.3;

  float mid = 0.5 * (cov[0][0] + cov[1][1]);
  float rad = length(vec2(0.5 * (cov[0][0] - cov[1][1]), cov[0][1]));
  float l1 = mid + rad;
  float l2 = max(mid - rad, 0.1);
  if (l1 < 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  vec2 dv = normalize(vec2(cov[0][1], l1 - cov[0][0]) + vec2(1e-6, 0.0));
  vec2 majorAxis = min(sqrt(2.0 * l1), uMaxAxis) * dv;
  vec2 minorAxis = min(sqrt(2.0 * l2), uMaxAxis) * vec2(dv.y, -dv.x);

  vQuad = position.xy;
  // axes are in pixels; NDC spans 2 across the viewport, hence the 2.0
  gl_Position = vec4(
    clip.xy / clip.w
      + position.x * majorAxis * 2.0 / uViewport
      + position.y * minorAxis * 2.0 / uViewport,
    clip.z / clip.w,
    1.0
  );
}
`;

const SPLAT_FRAG = /* glsl */ `
precision highp float;

in vec4 vColor;
in vec2 vQuad;
out vec4 outColor;

void main() {
  float A = -dot(vQuad, vQuad);
  if (A < -4.0) discard;         // outside ~2 sigma
  float B = exp(A) * vColor.a;
  outColor = vec4(vColor.rgb * B, B); // premultiplied
}
`;

// Counting-sort resolution. Every frame pays a full prefix-sum over this,
// whatever the splat count — at 65536 that pass alone cost more than sorting a
// held capture's ~45k splats. 16384 levels of depth is far past what alpha
// blending can show: the splats that land in one bucket are within a fraction
// of a millimetre of each other.
const SORT_BUCKETS = 16384;

// Counting sort on view-space depth. Back-to-front == ascending z, since three's
// camera looks down -Z. O(n) — a comparison sort of 150k would blow the frame.
function depthSort(
  data: SplatData,
  p: number,
  mv: THREE.Matrix4,
  order: Float32Array,
  depths: Float32Array,
  buckets: Uint16Array,
  counts: Uint32Array,
  start: number, // first splat of the live span. In sequence mode this is the
  end: number, //   active capture (plus its handoff neighbour, which is
  stride: number, //  adjacent in the file); otherwise the whole cloud.
  layerPos: number, // the walk position, mirroring the shader's uLayer
  axis: THREE.Vector3 // the shader's uAxis: screen-up, in object space
): number {
  const e = mv.elements;
  let dmin = Infinity;
  let dmax = -Infinity;
  const { scatterA, textHome, modelHome, scatterB } = data;

  // Past the last splat's morph, every splat sits on its capture and only the
  // handoff moves it — so the three-stage lerp and its three easing curves can
  // go. That is the entire sequence beat, which is most of the page, and it
  // cuts the per-splat sort cost by roughly three quarters.
  const seated = data.layers !== null && p >= SEQ_START;

  // Thinning is a stride, not a shorter span: a prefix would drop the whole
  // second half of a handoff, and inside one capture it would carve away a
  // chunk rather than thinning it evenly.
  let n = 0;
  for (let k = start; k < end; k += stride, n++) {
    const i3 = k * 3;
    let x: number;
    let y: number;
    let z: number;

    if (seated) {
      // Same arithmetic as the vertex shader's teardown block — if these two
      // drift, the captures interleave wrongly exactly where they overlap most.
      // Far cheaper than the version it replaces: nothing moves off the axis, so
      // x and z are simply the splat's seat, and a layer that is arriving (or
      // just sitting there) does not move at all.
      const sd = layerPos - (data.delayBlast[k] | 0);
      let axial = 0;
      if (sd > SEQ_LIFT_START) {
        // The lift only — evaporation and deflation move nothing, so the sort
        // does not care about them. Mirrors the shader's REMOVAL part two.
        const liftU = clamp01((sd - SEQ_LIFT_START) / (1 - SEQ_LIFT_START));
        const peel = clamp01((liftU - data.phase[k] * SEQ_PEEL) / (1 - SEQ_PEEL));
        axial = data.exit[k] * peel * (SEQ_LAUNCH + (1 - SEQ_LAUNCH) * peel);
      }
      x = modelHome[i3] + axis.x * axial;
      y = modelHome[i3 + 1] + axis.y * axial;
      z = modelHome[i3 + 2] + axis.z * axial;
    } else {
      const a = easeOutCubic(clamp01((p - data.delayForm[k]) / ASSEMBLE_WINDOW));
      const m = smoothstep(
        clamp01((p - MORPH_START - data.delayMorph[k]) / (MORPH_END - MORPH_START))
      );
      const b = data.layers
        ? 0 // pre-walk: the sequence has not started dispersing anything yet
        : easeInCubic(clamp01((p - BLAST_START - data.delayBlast[k]) / (1 - BLAST_START)));

      x = lerp(lerp(lerp(scatterA[i3], textHome[i3], a), modelHome[i3], m), scatterB[i3], b);
      y = lerp(lerp(lerp(scatterA[i3 + 1], textHome[i3 + 1], a), modelHome[i3 + 1], m), scatterB[i3 + 1], b);
      z = lerp(lerp(lerp(scatterA[i3 + 2], textHome[i3 + 2], a), modelHome[i3 + 2], m), scatterB[i3 + 2], b);
    }

    // view-space z only — the sort key. Keyed by position in the span, not by
    // splat index, so the scratch stays compact whatever the span is.
    const d = e[2] * x + e[6] * y + e[10] * z + e[14];
    depths[n] = d;
    if (d < dmin) dmin = d;
    if (d > dmax) dmax = d;
  }

  counts.fill(0);
  const scale = dmax > dmin ? (SORT_BUCKETS - 1) / (dmax - dmin) : 0;
  for (let j = 0; j < n; j++) {
    const bkt = ((depths[j] - dmin) * scale) | 0;
    buckets[j] = bkt;
    counts[bkt]++;
  }
  let sum = 0;
  for (let i = 0; i < SORT_BUCKETS; i++) {
    const c = counts[i];
    counts[i] = sum;
    sum += c;
  }
  for (let j = 0; j < n; j++) order[counts[buckets[j]]++] = start + j * stride;
  return n;
}

function SplatCloud({
  text,
  progressRef,
  reserveRef,
  reserveRightRef,
  drive,
  idle,
  onReady,
  onLayer,
  onQuality,
  selectRef,
  hoverRef,
  onHover,
  onSelect,
  onInspectable,
  onDiagram,
}: {
  text: string;
  progressRef: React.RefObject<number>;
  // Pixels of the left edge the caption column claims, or 0 when it is not beside
  // the model. Measured in the DOM; see CAPTION_GUTTER.
  reserveRef: React.RefObject<number>;
  // Its mirror on the right: pixels the subassembly rail claims off the right
  // edge. Only bites while a part is isolated — see the corridor calculation.
  reserveRightRef: React.RefObject<number>;
  drive: React.RefObject<Drive>;
  // Whether the closing diagram is a still picture this frame, and the hash that
  // decides it. Written here, read by DiagramMsaa — see the Idle type.
  idle: React.RefObject<Idle>;
  onReady?: () => void;
  // Inspection, in the same shape as the pacing above: the SCENE finds what the
  // pointer is on (it owns the boxes and the matrices), the HOST owns what is
  // selected (the layer rail has to be able to select too, and a keyboard has to
  // be able to reach it). So selection travels down as a ref — read every frame,
  // never a re-render — and travels up as a callback.
  selectRef: React.RefObject<number>;
  // Hover driven from OUTSIDE the canvas — the layer rail. Used only when the
  // ray hits nothing, which is exactly the case where the pointer is off the
  // canvas and on the rail, so the two can never fight over the same frame.
  hoverRef: React.RefObject<number>;
  onHover?: (i: number) => void;
  onSelect?: (i: number) => void;
  // Whether the diagram is currently accepting a pointer at all, so the host can
  // show the prompt and the rail only when they mean something.
  onInspectable?: (v: boolean) => void;
  // Whether the CAD diagram owns the frame, so the host can hand it the render
  // scale the splat budget was holding back. See PIXEL_BUDGET_DIAGRAM.
  onDiagram?: (v: boolean) => void;
  // Which capture is on screen, reported only when it changes. The caption is
  // driven from this rather than recomputed from scroll: the scene runs on the
  // spring-smoothed progress, so deriving the index a second time from raw
  // scroll would drift the text off the model it is labelling.
  onLayer?: (i: number) => void;
  // The governor's chosen rung, reported out so ScrollScene can put it on the
  // <Canvas dpr> prop. See the GOV_DPR block for why the render scale cannot be
  // set from inside the frame loop.
  onQuality?: (level: number) => void;
}) {
  const layerSeen = useRef(-1);
  const axisRef = useRef(new THREE.Vector3(0, 1, 0));
  const invRef = useRef(new THREE.Quaternion());
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const intro = useRef(0); // time-driven assembly, plays once after the data lands
  const reducedMotion = useRef(false);
  const [src, setSrc] = useState<ModelSource | null>(null);
  // The closing diagram's geometry. Independent of the splat cloud and optional:
  // if it does not load the hero simply ends on the walk.
  const [cad, setCad] = useState<CadLayer[] | null>(null);
  const { size, camera, gl, scene } = useThree();

  // Getting the diagram onto the GPU BEFORE the beat that needs it.
  //
  // Measured wheel-scrolling through the handover on an AMD Renoir iGPU: three
  // 67 ms frames and two 50 ms ones, 4.2% of frames missing vsync, and in the
  // same window 721 bufferData calls totalling 19.3 MB plus a linkProgram. That
  // is the entire CAD dataset — 120 shapes x (position, normal, colour, mra,
  // index, instance matrices) — uploading on the single frame it is first drawn,
  // with the shader compiling beside it. Everything downstream of that frame was
  // already cheap; the stall was the arrival itself.
  //
  // So the buffers are uploaded ahead of time, by drawing each shape into a 1x1
  // render target — the only way to make WebGL commit a buffer without also
  // rasterising it.
  //
  // Paced by BYTES rather than by shapes, because the shapes are nothing like
  // the same size: the cabinet is four of them and the wall builder is 37, so a
  // shape a frame spends 120 frames and still lands most of the megabytes in a
  // handful of them. A flat budget finishes the whole 19 MB in about half a
  // second of walking, which is what it takes to still be ahead of a visitor who
  // arrives in a hurry.
  const WARM_BYTES = 600_000;
  const warm = useRef({ shape: 0, rt: null as THREE.WebGLRenderTarget | null, done: false });
  useEffect(
    () => () => {
      warm.current.rt?.dispose();
      warm.current.rt = null;
    },
    []
  );
  // The program is the other half and does not need a draw at all: compile()
  // walks the scene with traverse(), not traverseVisible(), so it reaches the
  // diagram while it is still hidden, and compileAsync hands the link to
  // KHR_parallel_shader_compile where the driver has it.
  useEffect(() => {
    if (!cad) return;
    try {
      if (typeof gl.compileAsync === 'function') void gl.compileAsync(scene, camera);
      else gl.compile(scene, camera);
    } catch {
      // A warm-up that cannot run is not a failure — it costs the frame it was
      // meant to save and nothing else.
    }
  }, [cad, gl, scene, camera]);

  // Inspection state. All of it lives in refs: this runs in the frame loop and
  // none of it may cost a React render, for the same reason the scroll overlays
  // are written straight to the DOM — a re-render here re-renders <Canvas>, which
  // re-reconciles the whole scene tree.
  const inspect = useRef({
    hot: -1, // layer the pointer is over, -1 for none
    focus: 0, // 0..1 isolation blend, damped toward "is something selected"
    live: false, // is the diagram accepting a pointer at this scroll position
    diagram: false, // is the CAD the only thing drawing, i.e. can it have the pixels
    yaw: 0, // user orbit, applied on top of the scripted rotation
    pitch: 0,
    yawTo: 0,
    pitchTo: 0,
    dragging: false,
    // The layer the framing is currently fitted to. Held through the return
    // flight: the moment a part is deselected `sel` is -1, and reading the
    // framing off that would snap the fit back to the whole stack in one frame
    // while the isolation blend was still easing out of it.
    lastSel: -1,
    // Damped framing for the isolated part: its radius, its own centre height and
    // its seat. See the block that drives them for why they are not read live.
    fitR: 0,
    cenY: 0,
    seat: 0,
    // Where the current press started, so pointerup can tell a click from a drag.
    downX: 0,
    downY: 0,
    lastX: 0,
    lastY: 0,
    moved: 0,
    // Where the pointer is, in NDC, tracked here rather than read from r3f's
    // state.pointer. Two reasons, both of which broke touch: state.pointer is
    // only armed once a pointermove has been seen (see pointerLive — it exists so
    // an untouched mouse does not dent the wordmark), and a TAP need not produce
    // one at all, so the first tap on a phone picked nothing. And a tap's down
    // and up can both land inside a single frame, so a click that reads whatever
    // the last frame resolved is reading a value from before the tap happened.
    // Owning the coordinate makes the click pick at its own position.
    nx: 0,
    ny: 0,
    armed: false,
    wantClick: false,
    over: false,
  });
  const rayRef = useRef(new THREE.Raycaster());
  const ndcRef = useRef(new THREE.Vector2());
  const localRay = useRef(new THREE.Ray());
  const pickMat = useRef(new THREE.Matrix4());
  const pickPt = useRef(new THREE.Vector3());
  const gov = useRef<Governor>({
    ema: 16.7,
    seeded: false,
    bad: 0,
    good: 0,
    cooldown: 0,
    level: 0,
    floor: GOV_MAX_LEVEL,
    probe: 0,
    probeFrom: 0,
    sortEvery: 1,
    frame: 0,
  });
  // The level-0 ellipse cap, kept so the governor's rungs can scale it with the
  // render scale they set. Filled in when the material is built.
  const maxAxis0 = useRef(0);

  useEffect(() => {
    reducedMotion.current =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // r3f's pointer defaults to (0,0) — screen centre — which would dent the
  // middle of the word before the user ever touches the mouse. Only hand the
  // cursor to the shader once it has actually moved.
  const pointerLive = useRef(false);
  useEffect(() => {
    const arm = () => {
      pointerLive.current = true;
    };
    window.addEventListener('pointermove', arm, { once: true, passive: true });
    return () => window.removeEventListener('pointermove', arm);
  }, []);

  // Pointer input for the inspection beat, bound to the canvas itself rather than
  // routed through r3f's event system. r3f raycasts every object that carries a
  // handler, which for this scene would mean the million-triangle diagram or a set
  // of proxy objects living in the scene graph; the picking here is eight box
  // tests against data the frame loop already holds, so the events only have to
  // say WHERE and WHEN, and the loop answers WHAT.
  useEffect(() => {
    const el = gl.domElement;
    const s = inspect.current;

    const track = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      s.nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      s.ny = -(((e.clientY - r.top) / r.height) * 2 - 1);
      s.armed = true;
      s.over = true;
    };

    const down = (e: PointerEvent) => {
      track(e);
      if (!s.live) return;
      s.dragging = true;
      s.downX = s.lastX = e.clientX;
      s.downY = s.lastY = e.clientY;
      s.moved = 0;
    };

    const move = (e: PointerEvent) => {
      track(e);
      if (!s.dragging) return;
      const dx = e.clientX - s.lastX;
      const dy = e.clientY - s.lastY;
      s.lastX = e.clientX;
      s.lastY = e.clientY;
      s.moved = Math.max(s.moved, Math.hypot(e.clientX - s.downX, e.clientY - s.downY));
      // Turning is offered only once a part is isolated. Before that a drag across
      // the diagram would spin a stack the visitor has not chosen anything in yet,
      // and the scripted yaw is still what frames it.
      if ((selectRef.current ?? -1) < 0) return;

      // Touch gets the horizontal axis and the PAGE keeps the vertical one. A
      // finger is the same gesture for "turn this" and "scroll on", so the axis
      // has to arbitrate: dominant-vertical is released to the page (the canvas
      // is set to touch-action: pan-y while focused, so the browser scrolls it
      // natively), dominant-horizontal is ours. Pitch is mouse-only for the same
      // reason — there is no spare axis for it.
      const touch = e.pointerType !== 'mouse';
      if (touch && Math.abs(e.clientY - s.downY) >= Math.abs(e.clientX - s.downX)) return;
      s.yawTo += dx * ORBIT_PER_PX;
      if (!touch) {
        s.pitchTo = Math.max(
          -ORBIT_PITCH_MAX,
          Math.min(ORBIT_PITCH_MAX, s.pitchTo + dy * ORBIT_PER_PX)
        );
      }
      if (touch && e.cancelable) e.preventDefault();
    };

    // On window, not on the canvas: a drag that ends off the edge still has to
    // release. The click itself is qualified separately — it has to have started
    // and ended on the canvas without travelling.
    const up = (e: PointerEvent) => {
      if (!s.dragging) return;
      s.dragging = false;
      // A finger has no hover: leaving it "over" would keep the layer it last
      // touched lit for the rest of the page.
      if (e.pointerType !== 'mouse') s.over = false;
      if (!s.live || s.moved > CLICK_SLOP || e.target !== el) return;
      track(e);
      // Deferred to the next frame rather than acting on whatever the last one
      // resolved, so the pick happens at the coordinate this click released at
      // and against transforms that are current. Selecting -1 for "nothing under
      // it" is what makes clicking the empty frame the way back out of an
      // isolated part, alongside Escape and the caption's own control.
      s.wantClick = true;
    };

    const leave = () => {
      s.over = false;
    };
    const enter = () => {
      s.over = true;
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (selectRef.current ?? -1) >= 0) onSelect?.(-1);
    };

    el.addEventListener('pointerdown', down);
    // Not passive: the touch branch above cancels the horizontal drag it claims.
    el.addEventListener('pointermove', move, { passive: false });
    el.addEventListener('pointerleave', leave);
    el.addEventListener('pointerenter', enter);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('pointerenter', enter);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
      el.style.touchAction = '';
    };
  }, [gl, onSelect, selectRef]);

  useEffect(() => {
    let cancelled = false;
    const small = typeof window !== 'undefined' && window.innerWidth < 820;
    const limit = small ? MAX_SPLATS_MOBILE : MAX_SPLATS_DESKTOP;
    // Sequence budgets are per capture, not per file: only one capture is on
    // screen, so a phone can hold every one of them at a workable density
    // instead of thinning all nine into the old whole-cloud cap.
    const perLayer = small ? PER_LAYER_MOBILE : Infinity;

    (async () => {
      // The word is rasterised in the display faces — request them explicitly
      // (fonts.ready alone only covers faces already used in the DOM), using
      // the resolved next/font family names and the actual glyphs so the
      // subset hanzi face downloads before the first sample.
      try {
        const families = resolveFamilies(WORDMARK_VARS);
        const familiesS = resolveFamilies(SECONDARY_VARS);
        await Promise.allSettled([
          document.fonts.load(`400 200px ${families}`, text.toUpperCase()),
          document.fonts.load(`900 200px ${families}`, text.toUpperCase()),
          document.fonts.load(`500 200px ${familiesS}`, text.toUpperCase()),
          document.fonts.ready,
        ]);
      } catch {
        /* older browsers: sample whatever is available */
      }
      // The capture sequence first, so the hero can walk the machine apart. Both
      // halves must land — without the index there is no way to tell the
      // captures apart, so fall through rather than render nine on top of each
      // other. Every capture keeps its full quality; only one is drawn at a time,
      // so the per-frame cost is one capture however many are in the file.
      try {
        const [rc, ri] = await Promise.all([fetch(LAYERS_URL), fetch(LAYERS_INDEX_URL)]);
        if (rc.ok && ri.ok) {
          const [ab, idx] = await Promise.all([rc.arrayBuffer(), ri.arrayBuffer()]);
          const model = parseLayerCloud(ab, idx, perLayer);
          if (model && !cancelled) {
            setSrc(model);
            return;
          }
        }
      } catch {
        /* fall through to the single capture */
      }
      // real gaussians first; fall back to the bare point cloud (STL path)
      try {
        const r = await fetch(SPLAT_URL);
        if (r.ok) {
          const ab = await r.arrayBuffer();
          if (!cancelled) setSrc(parseSplats(ab, limit));
          return;
        }
      } catch {
        /* fall through */
      }
      try {
        const r = await fetch(POINTS_URL);
        if (r.ok) {
          const ab = await r.arrayBuffer();
          if (!cancelled) setSrc(synthesiseSplats(ab, limit));
        }
      } catch {
        /* nothing to render */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // The diagram, fetched AFTER the cloud instead of alongside it.
  //
  // This used to be a bare `[]` effect that fired on mount, so the browser pulled
  // both files at once and they split the connection. That was defensible while
  // the diagram was 3 MB against the cloud's 10; instancing then bought it 2.7x
  // the geometry and it became 7.3 MB against 9.9 — nearly half of a 17 MB first
  // paint, spent on a beat that does not appear until the last 9% of an 820vh
  // page. Racing it only delays the beat the visitor actually sees first.
  //
  // So: wait for `src`, then wait for the main thread to go idle. Gating on `src`
  // is also the correct dependency rather than a convenient one — the diagram is
  // handed to the walk, and if the cloud never loads there is no walk to hand it
  // to and nothing should be downloaded at all.
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      (async () => {
        try {
          const [rc, ri] = await Promise.all([fetch(CAD_URL), fetch(CAD_INDEX_URL)]);
          if (!rc.ok || !ri.ok) return;
          const [ab, idx] = await Promise.all([rc.arrayBuffer(), ri.arrayBuffer()]);
          const parsed = parseCadLayers(ab, idx);
          if (parsed && !cancelled) setCad(parsed);
        } catch {
          /* no diagram; the walk still ends cleanly */
        }
      })();
    };
    // The idle window is a nicety, not the mechanism — the ordering above is what
    // matters. It carries a timeout because the intro assembly is running about
    // now and a busy main thread must not starve the fetch outright. Even the
    // timeout path leaves the 468vh walk plus the table beat as lead time.
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    if (w.requestIdleCallback) {
      const h = w.requestIdleCallback(run, { timeout: 1500 });
      return () => {
        cancelled = true;
        w.cancelIdleCallback?.(h);
      };
    }
    const t = window.setTimeout(run, 200); // Safari < 16.4
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [src]);

  useEffect(() => {
    if (!cad) return;
    return () => {
      for (const c of cad) {
        for (const g of c.geometries) g.dispose();
        c.material.dispose();
      }
    };
  }, [cad]);

  const data = useMemo(() => (src ? buildSplatData(text, src) : null), [text, src]);

  // Geometry of the closing diagram, measured once from the seated layers: how
  // tall the exploded stack is, where its centre sits, and how deep it is (which
  // costs vertical room once the group is pitched). The beat fits the camera to
  // this rather than to a hand-tuned scale, so changing FINALE_SPAN or the CAD
  // offsets reframes the shot instead of cropping it.
  const finale = useMemo(() => {
    if (!cad || cad.length < 2) return null;
    let lo = Infinity;
    let hi = -Infinity;
    let radius = 0;
    const cp = Math.cos(FINALE_PITCH);
    const sp = Math.sin(FINALE_PITCH);
    // One radius per layer, for when that layer is isolated and the framing has
    // to fit it instead of the stack.
    const per: { fitR: number }[] = [];
    for (const r of cad) {
      // Framing radius for the ISOLATED state: a bounding SPHERE about the
      // layer's own centre, which is the one bound a freely rotated part cannot
      // escape. Fit to it and the part is framed identically at every angle — it
      // can never be turned out of frame, and it never rescales while it is being
      // turned. Both matter more than the few percent of size a tighter,
      // orientation-dependent bound would buy at rest.
      //
      // planR is the reach from the explode axis and hy is half the height about
      // the box centre, so a sphere of hypot(planR, hy) centred there contains
      // the layer.
      const hy = (r.box.max.y - r.box.min.y) / 2;
      const fitR = Math.hypot(r.planR, hy);
      // Measured up the SCREEN, which is the axis the seats are laid out on. A
      // part contributes its own height foreshortened by the tilt plus the share
      // of its width the tilt swings into vertical — a flat disc like the
      // turntable is almost all of the second term.
      const half = ((r.maxY - r.minY) / 2) * cp + r.radius * sp;
      const mid = r.centreY * cp + r.seatY;
      per.push({ fitR: Math.max(0.001, fitR) });
      lo = Math.min(lo, mid - half);
      hi = Math.max(hi, mid + half);
      radius = Math.max(radius, r.radius);
    }
    if (!isFinite(lo)) return null;
    return {
      centreY: (lo + hi) / 2,
      halfH: Math.max(0.001, (hi - lo) / 2),
      radius: Math.max(0.001, radius),
      per,
    };
  }, [cad]);

  useEffect(() => {
    if (data) onReady?.();
  }, [data, onReady]);

  const geometry = useMemo(() => {
    if (!data) return null;
    const g = new THREE.InstancedBufferGeometry();
    // ±1.7 sigma, not ±2: the gaussian is at 0.3% by the corners, and the
    // smaller quad rasterises ~28% fewer fragments — pure fill-rate savings.
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-1.7, -1.7, 0, 1.7, -1.7, 0, 1.7, 1.7, 0, -1.7, 1.7, 0]),
        3
      )
    );
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const order = new Float32Array(data.count);
    for (let i = 0; i < data.count; i++) order[i] = i;
    const attr = new THREE.InstancedBufferAttribute(order, 1);
    attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iIndex', attr);
    g.instanceCount = data.count;
    return g;
  }, [data]);

  const material = useMemo(() => {
    if (!data || !src) return null;
    maxAxis0.current =
      typeof window !== 'undefined' && window.innerWidth < 820 ? 120 : 220;
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uData: { value: data.texture },
        uTexW: { value: TEX_W },
        uProgress: { value: 0 },
        uFocal: { value: new THREE.Vector2(1000, 1000) },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uTextDot: { value: 0.005 },
        uTextAlpha: { value: 0.82 },
        uMaxAxis: { value: maxAxis0.current },
        // 0 => the capture renders in its true 3DGS colours; flip to
        // src.photoreal ? 1 : 0 to re-engage the silver-gelatin mono grade
        uGrade: { value: 0 },
        // A sequence never blasts — the captures replace each other in place.
        uBlastFade: { value: data.layers ? 0 : 0.9 },
        uSequence: { value: data.layers ? 1 : 0 },
        uLayer: { value: 0 },
        uEvapEnd: { value: SEQ_EVAP_END },
        uEvapStagger: { value: SEQ_EVAP_STAGGER },
        uEvapScan: { value: SEQ_EVAP_SCAN },
        uDeflate: { value: SEQ_DEFLATE },
        uLiftStart: { value: SEQ_LIFT_START },
        uPeel: { value: SEQ_PEEL },
        uSmear: { value: SEQ_SMEAR },
        uReveal: { value: SEQ_REVEAL },
        uDensScan: { value: SEQ_DENS_SCAN },
        uGrain: { value: SEQ_GRAIN },
        uTint: { value: SEQ_TINT },
        uSplatOut: { value: 0 },
        uAxis: { value: new THREE.Vector3(0, 1, 0) },
        uDensity: { value: 1 },
        uMouse: { value: new THREE.Vector2(99, 99) },
        uTime: { value: 0 },
        uRepel: { value: 0.38 },
      },
      vertexShader: SPLAT_VERT,
      fragmentShader: SPLAT_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // The quad is spanned by (majorAxis, minorAxis); minorAxis is majorAxis
      // rotated -90 degrees, so that basis always has a negative determinant and
      // the triangles come out back-facing. three.js culls those by default
      // (side: FrontSide) — raw-WebGL splat renderers only get away with the same
      // math because CULL_FACE is off there. Without this, nothing rasterises.
      side: THREE.DoubleSide,
      // premultiplied alpha, since the fragment already multiplies through
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
  }, [data, src]);

  // Scratch for the sort. Sized inside useFrame rather than in an effect: passive
  // effects can be deferred past the next frame, and a zero-length scratch would
  // silently corrupt the sort into writing garbage indices.
  const sortRef = useRef({
    depths: new Float32Array(0),
    buckets: new Uint16Array(0),
    counts: new Uint32Array(SORT_BUCKETS),
    lastP: -1,
    camKey: -1,
    drawn: 0, // instances the last sort actually wrote
    mv: new THREE.Matrix4(),
  });

  useEffect(() => {
    return () => {
      geometry?.dispose();
      material?.dispose();
      data?.texture.dispose();
    };
  }, [geometry, material, data]);

  useFrame((state, delta) => {
    const grp = groupRef.current;
    const mesh = meshRef.current;
    if (!grp || !mesh || !data || !material) return;

    // Entrance: advance the assembly beat on the clock (capped delta — a
    // backgrounded tab must not fast-forward it), then let scroll drive the rest
    // of the timeline. Reduced motion skips straight to the formed word.
    intro.current = reducedMotion.current
      ? 1
      : Math.min(1, intro.current + Math.min(delta, 0.05) / INTRO_SECONDS);
    const smooth = driveScroll(
      drive.current,
      progressRef.current,
      delta,
      state.clock.elapsedTime
    );
    const p = ASSEMBLE_END * easeOutCubic(intro.current) + smooth * (1 - ASSEMBLE_END);

    material.uniforms.uProgress.value = p;
    const cam = camera as THREE.PerspectiveCamera;
    const fy = size.height / (2 * Math.tan(((cam.fov * Math.PI) / 180) / 2));
    material.uniforms.uFocal.value.set(fy, fy);
    material.uniforms.uViewport.value.set(size.width, size.height);

    // Cursor on the z=0 plane (where the word sits) + clock for the simmer.
    // Reduced motion (or an untouched pointer) parks the cursor far away.
    material.uniforms.uTime.value += Math.min(delta, 0.05);
    if (reducedMotion.current || !pointerLive.current) {
      material.uniforms.uMouse.value.set(99, 99);
    } else {
      const halfH = Math.tan((cam.fov * Math.PI) / 360) * cam.position.z;
      material.uniforms.uMouse.value.set(
        state.pointer.x * halfH * (size.width / size.height),
        state.pointer.y * halfH
      );
    }

    // Scroll-driven 3D rotation (deterministic + reversible): no rotation while
    // the word is readable, then the capture swings up into a 3/4 view from
    // above through the morph and drifts as it holds and explodes. Must be a
    // pure function of progress — an accumulator left the word mirrored after
    // scrolling back up.
    const rf = smoothstep(clamp01((p - MORPH_START) / (MORPH_END - MORPH_START)));
    // Both of these are measured against FINALE_END, not against the end of the
    // page. Everything past FINALE_END is the hold beat, and the hold beat's
    // contract is that the scene is a CONSTANT there — a drifting yaw would not
    // only break that, it would make the thing you are trying to point at move
    // while you point at it.
    const spinModel = clamp01((p - MORPH_END) / (FINALE_END - MORPH_END));
    // How far into the closing diagram we are. Drives the framing, the tilt and
    // the wide-shot LOD; the per-layer landing is staggered off it below.
    const fe = data.layers ? smoothstep(clamp01((p - SEQ_END) / (FINALE_END - SEQ_END))) : 0;

    // ------------------------------------------------------------ inspection
    const ins = inspect.current;
    const dtc = Math.min(delta, 0.1);
    // The diagram accepts a pointer once it has finished assembling itself, and
    // stops the moment scrolling back up starts taking it apart again. Purely a
    // function of scroll, like everything else here, so there is no state to get
    // stuck: scrolling away releases the selection on the way past.
    const pickable = !!cad && fe >= INSPECT_AT && intro.current >= 1;
    if (pickable !== ins.live) {
      ins.live = pickable;
      onInspectable?.(pickable);
      if (!pickable && (selectRef.current ?? -1) >= 0) onSelect?.(-1);
    }
    // The render scale the diagram gets is a different number from the one the
    // splats get, and switching it reallocates the drawing buffer — so the two
    // thresholds are deliberately far apart. On at the handover, where the splat
    // mesh stops being drawn at all; off only once the walk is properly back.
    // Scrubbing across a single threshold would otherwise resize the canvas on
    // every frame of the scrub.
    //
    // Between the two thresholds the splats are drawn at the diagram's render
    // scale, which leaves uMaxAxis — a cap in BACKING-STORE pixels, so it rides
    // the governor's rung but not this — clamping each gaussian's extent a little
    // tighter than it was calibrated for. It is deliberately left alone: that
    // window is the tail of the cross-dissolve, where uSplatOut has already taken
    // the whole cloud most of the way to zero alpha.
    if (cad) {
      const owns = ins.diagram ? fe > 0.15 : fe >= FINALE_HANDOVER;
      if (owns !== ins.diagram) {
        ins.diagram = owns;
        onDiagram?.(owns);
      }
    }
    if (!pickable && ins.hot >= 0) {
      ins.hot = -1;
      onHover?.(-1);
    }

    const sel = pickable ? (selectRef.current ?? -1) : -1;
    // Reduced motion gets the same states, reached by a cut rather than a flight.
    // A part sailing across the frame and scaling up is precisely the kind of
    // large unprompted movement the preference is asking us not to make.
    const focRate = reducedMotion.current ? 60 : FOCUS_RATE;
    ins.focus = damp(ins.focus, sel >= 0 ? 1 : 0, focRate, dtc);
    const foc = ins.focus;
    // Orbit decays back to the scripted framing as the isolation lets go, so
    // returning to the diagram and picking a second part starts it square rather
    // than wherever the last one was left.
    if (sel < 0) {
      ins.yawTo *= Math.exp(-FOCUS_RATE * dtc);
      ins.pitchTo *= Math.exp(-FOCUS_RATE * dtc);
    }
    ins.yaw = damp(ins.yaw, ins.yawTo, ORBIT_RATE, dtc);
    ins.pitch = damp(ins.pitch, ins.pitchTo, ORBIT_RATE, dtc);
    if (sel >= 0) ins.lastSel = sel;
    else if (foc < 0.002) ins.lastSel = -1;
    // The subject the framing is fitted to while the isolation is up. Null both
    // before anything is picked and after the return flight has landed, which is
    // exactly when the stack's own framing is the right one.
    const focGeo =
      finale && ins.lastSel >= 0 && foc > 0.002 ? (finale.per[ins.lastSel] ?? null) : null;
    const focLayer = focGeo && cad ? (cad[ins.lastSel] ?? null) : null;
    // The framing of the isolated part, damped rather than read straight off the
    // selection — because scrolling now steps from one part to the next without
    // ever closing, and the parts differ by 3x in size and sit metres apart on
    // the explode axis. Taken live, every step would cut the scale and the
    // centring in one frame; damped, the frame travels to the next part while it
    // fades up, which is what makes the walk through the stack read as one move.
    //
    // Radius and seat are damped; the PITCH they are combined with below is not.
    // The fit must not move while the visitor turns a part, but the centring must
    // — tipping a part a quarter turn otherwise slides it off the middle of the
    // frame by its own half-height.
    if (focGeo && focLayer) {
      if (ins.fitR <= 0) {
        ins.fitR = focGeo.fitR;
        ins.cenY = focLayer.centreY;
        ins.seat = focLayer.seatY;
      } else {
        ins.fitR = damp(ins.fitR, focGeo.fitR, focRate, dtc);
        ins.cenY = damp(ins.cenY, focLayer.centreY, focRate, dtc);
        ins.seat = damp(ins.seat, focLayer.seatY, focRate, dtc);
      }
    } else if (foc < 0.002) {
      ins.fitR = 0;
    }

    // The walk looks down at the playfield from 43 degrees, which is right for a
    // table and wrong for a column of parts — it foreshortens the very gaps the
    // diagram exists to show. So the finale eases the camera back down to a
    // near-side-on read, and keeps turning.
    grp.rotation.x = lerp(MODEL_PITCH * rf, FINALE_PITCH, fe) + ins.pitch * foc;
    grp.rotation.y = MODEL_YAW * rf + spinModel * MODEL_TURN + fe * FINALE_TURN + ins.yaw * foc;

    // Screen-up, expressed in the group's own space — the direction a part
    // travels when it is removed, and the one the explode seats are stacked on.
    // Derived from the live rotation rather than baked, so it stays vertical
    // through the pitch ramp and the drifting yaw. Reused scratch: this runs
    // every frame and is handed straight to both the shader and the sort.
    const axis = axisRef.current;
    axis.set(0, 1, 0).applyQuaternion(invRef.current.copy(grp.quaternion).invert());
    material.uniforms.uAxis.value.copy(axis);

    // Walk the capture sequence: 00 (the assembled machine, which is what the
    // word became) and then each subassembly as it is taken off. `pos` is
    // fractional — its integer part is the capture on screen and the remainder
    // is how far through its removal the walk has got. Live span is the two
    // captures either side of it, which are adjacent in the file, so it stays
    // one contiguous range.
    const seq = data.layers;
    let spanStart = 0;
    let spanEnd = data.count;
    let fit = 1 - (1 - MODEL_FIT) * rf;
    let layerPos = 0;
    if (seq) {
      // Nine equal beats, not eight. Mapping the walk onto 0..n-1 gave the LAST
      // capture no beat at all — the walk position only reached it on the final
      // pixel of the page — so the electronics box was a caption nobody could
      // read over a model nobody saw. Scaled by n and clamped, every capture
      // including the last gets a hold of its own, and the walk now ends at
      // SEQ_END with the diagram beat after it rather than running off the page.
      const rawU = clamp01((p - SEQ_START) / (SEQ_END - SEQ_START)) * seq.length;
      const raw = Math.min(seq.length - 1, rawU);
      const base = Math.min(seq.length - 1, Math.floor(raw));
      // Hold, then hand over: the capture sits still for most of its scroll and
      // only comes apart at the end. This is what buys a readable beat per
      // subassembly without shortening the removal.
      const pos =
        base + smoothstep(clamp01((raw - base - (1 - SEQ_TRANSITION)) / SEQ_TRANSITION));
      // Framing runs on its own curve, and — the part that matters — a LATER one.
      // The dolly has to be slow, but it also must not run while the part is
      // leaving: the next capture is usually smaller, so reframing for it means
      // zooming IN, and zooming in on the thing currently being lifted out
      // cancels the lift. The part grows in frame as fast as it climbs and the
      // beat reads as a push-in rather than a removal. Shifted by FRAME_LAG the
      // dolly starts as the part releases and finishes half way into the next
      // capture's hold, so the removal happens at a steady scale and the reframe
      // happens over a model that is standing still.
      const fr = rawU - FRAME_LAG;
      const fb = Math.max(0, Math.min(seq.length - 1, Math.floor(fr)));
      const framePos = fb + smoothstep(clamp01((fr - fb) / SEQ_FRAME_EASE));
      const i0 = Math.min(seq.length - 1, Math.floor(framePos));
      const i1 = Math.min(seq.length - 1, i0 + 1);
      const t = framePos - i0;
      layerPos = pos;
      material.uniforms.uLayer.value = pos;

      // Switch the caption at the midpoint of the handoff, where the outgoing
      // part is halfway out of frame and the incoming one is halfway resolved.
      // Fires ~10 times over the whole page, so a setState from inside the frame
      // loop costs nothing. The diagram gets a caption of its own, claimed once
      // the parts are visibly on their way down.
      //
      // -1 before the walk begins. The captions name captures, and until
      // SEQ_START the page is showing the wordmark and then the assembled table
      // — so "00 / ENTIRE TABLE" was sitting over the logo from the first pixel
      // of the page, which is what the -1 initial state was always meant to
      // prevent. `pos` is pinned at 0 through those beats, so rounding it
      // reported capture 0 immediately and the caption never had a chance to
      // stay hidden.
      const shown = p < SEQ_START ? -1 : fe > 0.25 ? seq.length : Math.round(pos);
      if (shown !== layerSeen.current) {
        layerSeen.current = shown;
        onLayer?.(shown);
      }
      // Density LOD. `pos` sits on a whole number for most of each capture's
      // scroll and only travels during the handoff, so this is 1 on every hold
      // and bottoms out where both captures are on screen with every gaussian
      // in both inflated — the one frame in the beat that cannot afford them.
      // It is a FLOOR, not a fixed rate: the shader raises it per splat to
      // whatever that splat's alpha headroom allows, so what moves is the fill
      // rate, not the picture.
      // Keyed on the handoff, NOT on `t` above: `t` now runs on the framing
      // curve, which is still mid-drift while the splats are long since seated.
      material.uniforms.uDensity.value = lerp(
        1,
        SEQ_LOD_MIN,
        Math.pow(Math.sin((pos - Math.floor(pos)) * Math.PI), SEQ_LOD_CURVE)
      );
      // Hand the closing shot over to the CAD. The last capture dissolves out in
      // place while its drawing dissolves in, so this is a register-true swap
      // rather than a cut — the captures were placed using the CAD's own subject
      // centres, so the two occupy the same world frame to about 1%.
      material.uniforms.uSplatOut.value = cad
        ? smoothstep(clamp01(fe / FINALE_HANDOVER))
        : 0;

      // Draw only the captures with any weight — those within one of `pos`. The
      // epsilon keeps a held capture from dragging its neighbours along at zero
      // alpha, which would be up to 80k splats of pure waste every frame.
      const lo = Math.max(0, Math.ceil(pos - 1 + 1e-6));
      const hi = Math.min(seq.length - 1, Math.floor(pos + 1 - 1e-6));
      spanStart = seq[lo].offset;
      spanEnd = seq[hi].offset + seq[hi].count;

      // Frame whichever capture is on screen: the subassemblies run from the
      // whole 5-unit table down to a 1.1-unit control column, so hold them to a
      // similar size and keep each one's own centre on the camera's axis. Ramped
      // in on the morph — while the word is still readable it must be untouched,
      // at its own scale and centred, exactly as before.
      const zoom = lerp(seq[i0].zoom, seq[i1].zoom, t);
      fit = lerp(1, zoom, rf);
      let finCentre = 0;
      // Hoisted out of the finale branch below: the caption is on screen for the
      // whole walk, not just the last beat, so the horizontal reservation needs
      // these too.
      const halfVAll =
        Math.tan(((cam.fov * Math.PI) / 180) / 2) * Math.abs(cam.position.z);
      const perPxAll = (2 * halfVAll) / Math.max(1, size.height);
      // The clear vertical band, hoisted for the same reason: the centring below
      // now runs after the caption clamp, so it has to read the band the fit was
      // taken from rather than recompute it.
      let bandTop = halfVAll;
      let bandBottom = -halfVAll;
      if (finale && fe > 0) {
        // Pull back to the whole drawing. Fitted to the live frustum rather than
        // to a constant: the stack is ~11 units tall against a ~9-unit frame, and
        // on a phone it is the WIDTH that runs out first. finale.halfH is already
        // measured up the screen, so the vertical term needs no further tilt
        // correction.
        const halfV = halfVAll;
        // World units per screen pixel, so the gradient bands can be taken off
        // the top and bottom of the frustum. They are not symmetric, so this
        // moves the usable centre as well as shrinking the usable height.
        const perPx = perPxAll;
        const top = halfV - FINALE_BAND_TOP * perPx;
        const bottom = -halfV + FINALE_BAND_BOTTOM * perPx;
        bandTop = top;
        bandBottom = bottom;
        const clearHalf = Math.max(0.5, (top - bottom) / 2);
        const halfW = halfV * (size.width / size.height);
        const diagram = Math.min(
          SEQ_ZOOM_MAX,
          FINALE_MARGIN * Math.min(clearHalf / finale.halfH, halfW / finale.radius)
        );
        // Isolating a layer refits the frame to that layer, through the same two
        // constraints — it is the identical calculation with one part's extents
        // instead of the whole stack's, which is what keeps the band clearance and
        // the phone-width case honest in the focused state for free.
        let target = diagram;
        if (focGeo) {
          const close = Math.min(
            diagram * FOCUS_GAIN_MAX,
            (FINALE_MARGIN * Math.min(clearHalf, halfW)) / ins.fitR
          );
          target = lerp(diagram, close, foc);
        }
        fit = lerp(fit, target, fe);
      }

      // Reserve the caption column: the horizontal counterpart of the bands above.
      //
      // The MINIMUM correction, not a re-centring. Centring the subject in the
      // clear region was the first version and it over-corrects badly on wide
      // screens: past 1280 a centred `max-w-7xl` leaves dead space to the LEFT of
      // the caption, that dead space gets reserved along with the text, and the
      // model ends up shoved into the right third with a hole beside it. Pushing
      // only as far as it takes to clear the copy means the whole correction
      // collapses to zero the moment the model already clears — so every width
      // that was fine stays pixel-identical, and only the band that collides moves.
      let shiftX = 0;
      const reservePx = reserveRef.current ?? 0;
      if (reservePx > 0) {
        // The column only matters once there is a caption in it. Captions appear
        // at SEQ_START, so ramp across the table beat that precedes it: the model
        // is already seated when the text arrives, instead of sliding out from
        // under copy the reader has started on.
        const res = smoothstep(
          clamp01((p - MORPH_END) / Math.max(1e-6, SEQ_START - MORPH_END))
        );
        if (res > 0) {
          const claim = (reservePx + CAPTION_GUTTER) * perPxAll;
          const halfW = halfVAll * (size.width / Math.max(1, size.height));
          // The subject's half-extent in its OWN space — a capture's `radius` is
          // the max of its half-extents, so a tall narrow part reads as wider than
          // it is, which errs the safe way.
          const walkRad = lerp(seq[i0].radius, seq[i1].radius, t);
          const radObj = finale ? lerp(walkRad, finale.radius, fe) : walkRad;
          // Object-space radius is NOT the on-screen half-width: the group carries
          // a real yaw (see grp.rotation.y — MODEL_YAW, the drifting spin, and
          // FINALE_TURN all feed it), and a box rotated off-axis projects wider
          // than its own half-extent, up to sqrt(2)x at 45 degrees. Ignoring that
          // left a 2px overlap at 1000px even with the gutter: the push was
          // computed against a subject narrower than the one being drawn. This
          // machine is square in plan (0.965 x 0.965 m), so hx ~= hz and the
          // projected half-width is rad * (|cos yaw| + |sin yaw|).
          const yaw = grp.rotation.y;
          // The isolated part is the one case where the yaw correction is not an
          // approximation but an over-estimate: fitHalfW is already the plan
          // radius, which no yaw can exceed. Blended in with the isolation so the
          // walk and the assembled diagram keep the behaviour they were tuned at.
          const spread = Math.abs(Math.cos(yaw)) + Math.abs(Math.sin(yaw));
          const rad = focGeo ? lerp(radObj * spread, ins.fitR, foc * fe) : radObj * spread;
          if (rad > 1e-6) {
            // The corridor between the two columns of text: the caption on the
            // left, and — once a part is isolated and big enough to reach it —
            // the subassembly rail on the right. The rail's claim is scaled by
            // the isolation because the assembled diagram never gets near it, and
            // reserving width for a rail the model already clears would only
            // shrink the closing shot for nothing.
            const claimR = (reserveRightRef.current ?? 0) * perPxAll * foc * fe;
            // Only if the subject cannot fit the clear width even pushed hard
            // right does it have to shrink. This is what keeps the diagram as
            // large as the frame allows instead of shrinking it on principle.
            const availHalf = Math.max(0.5, halfW - (claim + claimR) / 2);
            fit = lerp(fit, Math.min(fit, (availHalf * FINALE_MARGIN) / rad), res);
            // Left edge sits at shiftX - rad*fit and must clear -halfW + claim;
            // the right edge at shiftX + rad*fit must clear halfW - claimR. Push
            // only as far as the first demands, and never past what the second
            // allows — the fit clamp above is what guarantees those two can both
            // be satisfied.
            const need = claim - halfW + rad * fit;
            const room = halfW - claimR - rad * fit;
            shiftX = Math.min(Math.max(0, need), Math.max(0, room)) * res;
          }
        }
      }

      // Centre the stack on the clear band, not on the viewport. Taken after the
      // caption clamp, because it scales with whatever fit that clamp settled on —
      // computing it from the pre-clamp fit slid the stack off the band by exactly
      // the amount the clamp had just removed.
      if (finale && fe > 0) {
        // Which subject gets centred on the clear band: the whole stack, or the
        // isolated layer flying up (or down) from its seat to take its place.
        // This IS the flight — the part never moves in the world, the frame moves
        // to it, so it stays registered against the seat it was picked from and
        // the return lands it back exactly where it was.
        const cen = focLayer
          ? lerp(finale.centreY, ins.cenY * Math.cos(grp.rotation.x) + ins.seat, foc)
          : finale.centreY;
        finCentre = (cen * fit - (bandTop + bandBottom) / 2) * fe;
      }

      // Two centrings, blended. The walk centres each capture on its own axial
      // middle, which is an object-space offset and so has to be rotated with the
      // group. The diagram is stacked up the screen instead, so its centring is
      // already a world-space shift and must NOT be rotated — running it through
      // the pitch is what would slide the stack off the top of the frame.
      const cy = lerp(seq[i0].centreY, seq[i1].centreY, t) * fit * rf * (1 - fe);
      grp.position.set(
        // The pitch is about X, so a world +x shift stays horizontal on screen and
        // needs none of the cos/sin correction the vertical centring does.
        shiftX,
        -cy * Math.cos(grp.rotation.x) - finCentre,
        -cy * Math.sin(grp.rotation.x)
      );
    }
    // The closing diagram. The parts are children of the same group as the splat
    // cloud, so they inherit the framing, the tilt and the centring for free and
    // land registered against the capture they replace. Each descends onto its
    // seat along uAxis — the same axis the teardown lifted things out on — and the
    // stagger runs bottom-up, so the drawing assembles the way a hand would lay
    // the parts out: chassis first, outer shell last.
    if (cad) {
      for (let ci = 0; ci < cad.length; ci++) {
        const c = cad[ci];
        const land = smoothstep(clamp01((fe - c.lag * FINALE_STAGGER) / (1 - FINALE_STAGGER)));
        // Isolation rides on top of the landing fade as a second opacity, and the
        // two multiply. Every layer is fully out of the way at sel >= 0 except the
        // chosen one — not ghosted at 6% for context, which was the first
        // instinct: a ghost keeps all eight layers in the TRANSPARENT pass, and
        // the note below on early-z is the reason that costs more than it is
        // worth on the most expensive beat of the page. The rail on the right is
        // where the context went instead.
        c.alpha = damp(c.alpha, sel < 0 || sel === ci ? 1 : 0, focRate, dtc);
        // Hover is per layer and damped, so crossing a boundary is a swap rather
        // than a flicker, and a pointer skimming across the stack does not strobe.
        c.hot = damp(c.hot, ins.hot === ci && sel < 0 ? 1 : 0, ORBIT_RATE, dtc);
        c.material.uniforms.uHot.value = c.hot;
        // Everything that is not the thing being pointed at goes back. Keyed on
        // whether ANY layer is hot rather than on this one being cold, so with the
        // pointer off the diagram all eight sit at full strength.
        c.material.uniforms.uDim.value =
          sel >= 0 ? 0 : ins.hot >= 0 && ins.hot !== ci ? 1 - c.hot : 0;

        const fin = land * c.alpha;
        c.root.visible = fin > 0.002;
        if (!c.root.visible) continue;
        // Blend only while this layer is actually fading. Once it is seated, hand it
        // to the OPAQUE pass: three sorts opaque objects front-to-back, so early-z
        // throws away the hidden layers before shading them, whereas the transparent
        // pass sorts back-to-front and shades every one of the eight stacked layers
        // in full. Same pixels, a fraction of the fragment work — and at fin == 1
        // there is no alpha left to blend anyway. No needsUpdate: neither flag feeds
        // a shader define, so this costs nothing but a render-list bucket change.
        const solid = fin >= 0.999;
        if (c.material.transparent === solid) {
          c.material.transparent = !solid;
          c.material.blending = solid ? THREE.NoBlending : THREE.CustomBlending;
        }
        // `land`, not `fin`: the drop is the LANDING, and folding the isolation
        // opacity into it would send every unselected layer back up into the air
        // on its way out instead of simply fading where it sits.
        c.root.position.copy(axis).multiplyScalar(c.seatY + (1 - land) * FINALE_DROP);
        c.material.uniforms.uFade.value = fin;
        // The specular half of the shading needs the eye, and the camera drifts with
        // the pointer every frame. See uCamPos in the fragment shader for why three's
        // own cameraPosition — and viewMatrix, hence uViewProj — are not good enough
        // here: three refreshes them on a program or camera-object change, not once a
        // frame.
        c.material.uniforms.uCamPos.value.copy(camera.position);
        c.material.uniforms.uViewProj.value
          .copy(camera.projectionMatrix)
          .multiply(camera.matrixWorldInverse);
      }
    }

    grp.scale.setScalar(fit);

    // ------------------------------------------------------------- picking
    // Last, because it has to read the transforms this frame just finished
    // writing. One frame of lag between the pointer and the highlight is well
    // under the damping that follows it and cannot be seen.
    if (cad) {
      let hit = -1;
      if (pickable && ins.armed && (ins.over || ins.wantClick) && !ins.dragging) {
        grp.updateMatrixWorld();
        const ray = rayRef.current;
        ndcRef.current.set(ins.nx, ins.ny);
        ray.setFromCamera(ndcRef.current, camera);
        let best = Infinity;
        for (let ci = 0; ci < cad.length; ci++) {
          const c = cad[ci];
          // A layer that has been faded out by the isolation is not pointable —
          // otherwise clicking the empty frame beside an isolated part would
          // silently select whatever invisible layer's box happens to be there.
          if (!c.root.visible || c.alpha < 0.5) continue;
          // Test in the LAYER'S OWN space. Transforming the box to world instead
          // would mean re-fitting an axis-aligned box around a rotated one, and at
          // this pitch and yaw that inflates the flat layers by half their height
          // — enough for two neighbours in the stack to start claiming each
          // other's pixels. The ray is three floats; the box is exact.
          const inv = pickMat.current.copy(c.root.matrixWorld).invert();
          const lr = localRay.current.copy(ray.ray).applyMatrix4(inv);
          if (!lr.intersectBox(c.box, pickPt.current)) continue;
          // Ranked by true world distance, so the near face of the near layer
          // wins. The local hit point cannot be compared directly across layers:
          // the group carries a scale, so local distance is in different units per
          // frame and would rank a far layer first the moment `fit` moved.
          const d = pickPt.current.applyMatrix4(c.root.matrixWorld).distanceTo(camera.position);
          if (d < best) {
            best = d;
            hit = ci;
          }
        }
      }
      // The rail outranks the ray, and is written into the same `hot` the model
      // uses — so hovering the rail lights the geometry and hovering the geometry
      // lights the rail, from one value.
      //
      // Outranks rather than falls through because the rail only names a layer
      // when it is explicitly pointed at or keyboard-focused, while the ray goes
      // on reporting whatever the mouse happens to be resting on. Tabbing into
      // the rail with the cursor abandoned over the diagram is the case: the
      // deliberate act has to win over the idle one. Moving the pointer from the
      // canvas to the rail is not a conflict at all — the canvas's pointerleave
      // clears `over` and stops the ray before the rail's enter fires.
      if (pickable) {
        const rail = hoverRef.current ?? -1;
        if (rail >= 0) hit = rail;
      }
      if (hit !== ins.hot) {
        ins.hot = hit;
        onHover?.(hit);
      }
      // The click, resolved against the pick this frame just made.
      if (ins.wantClick) {
        ins.wantClick = false;
        if (pickable) onSelect?.(hit);
      }
      // With a part open the canvas owns BOTH touch axes: horizontal turns it,
      // vertical steps through the stack (handled on the host, which owns the
      // selection). Off the rest of the time, so the hero scrolls under a finger
      // exactly as it always has on the 800-odd vh that are not this beat.
      const wantPan = sel >= 0 ? 'none' : '';
      if (gl.domElement.style.touchAction !== wantPan) {
        gl.domElement.style.touchAction = wantPan;
      }
    }

    // Re-sort only when the ordering can actually have changed: the splats moved
    // (progress) or the camera did. Idle frames reuse the last order. Degraded
    // devices sort every other frame — one frame of stale order is invisible at
    // these alphas.
    const st = sortRef.current;
    const g = gov.current;
    g.frame++;
    if (st.buckets.length !== data.count) {
      st.buckets = new Uint16Array(data.count);
      st.depths = new Float32Array(data.count);
      st.lastP = -1;
    }
    // Thin by a stride over the live span. The governor's lever has to be a
    // FRACTION, not an absolute count: in sequence mode the span is one capture
    // (~45k) while the cloud is all nine (~325k), so a budget scaled off the
    // whole cloud would always exceed the span and never thin anything.
    const live = spanEnd - spanStart;
    const stride = Math.max(1, Math.round(1 / GOV_COUNT[g.level]));
    const camKey = camera.position.x + camera.position.y * 7.1 + camera.position.z * 13.3;

    // Once the diagram has taken over, stop paying for the splats entirely.
    //
    // uSplatOut reaches 1 at FINALE_HANDOVER — 42% into the finale — after which
    // every gaussian is multiplied by zero. It was still costing a full frame's
    // work: ~45k alpha-blended instanced quads rasterised and shaded to write
    // nothing, plus the 45k counting sort re-run on every frame the camera moved,
    // which is every frame, because the pointer parallax never settles. That was
    // running underneath a million-triangle CAD diagram, which is why the finale
    // was the slowest beat on the page.
    const splatsGone = material.uniforms.uSplatOut.value >= 0.999;
    mesh.visible = !splatsGone;
    if (splatsGone) st.lastP = -1; // resort on the way back up

    if (
      !splatsGone &&
      (Math.abs(p - st.lastP) > 0.0005 || Math.abs(camKey - st.camKey) > 0.02) &&
      g.frame % g.sortEvery === 0
    ) {
      grp.updateMatrixWorld();
      camera.updateMatrixWorld();
      st.mv.copy(camera.matrixWorld).invert().multiply(mesh.matrixWorld);

      const attr = mesh.geometry.getAttribute('iIndex') as THREE.InstancedBufferAttribute;
      st.drawn = depthSort(
        data,
        p,
        st.mv,
        attr.array as Float32Array,
        st.depths,
        st.buckets,
        st.counts,
        spanStart,
        spanEnd,
        stride,
        layerPos,
        axis
      );
      attr.needsUpdate = true;
      st.lastP = p;
      st.camKey = camKey;
    }
    // Set after the sort, so the draw count always matches what was just written
    // — on a skipped-sort frame it holds the previous span's count.
    (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = st.drawn;

    // Quality governor: EMA over the real frame cadence, act with hysteresis.
    // Skipped until the intro has played so load spikes don't trigger it, and
    // skipped again over frames the diagram declined to draw — those are fast
    // because they did nothing, and feeding them to the EMA would walk the
    // governor up a rung the device cannot hold the moment the pointer moves.
    if (intro.current >= 1 && idle.current.drew) {
      const ms = Math.min(delta * 1000, 100);
      // Seeded from the first governed frame rather than eased up from a 16.7 ms
      // guess. At 30 fps that warm-up was ~25 frames of the EMA climbing toward
      // evidence the very first sample already carried.
      if (g.seeded) g.ema += (ms - g.ema) * 0.08;
      else {
        g.ema = ms;
        g.seeded = true;
      }
      const dt = Math.min(delta, 0.1);
      if (g.cooldown > 0) g.cooldown -= dt;

      // Settle a demotion at a level, whether it is a new one or a rejected one
      // being handed back. Everything a rung owns is set here and nowhere else.
      const apply = () => {
        g.sortEvery = g.level >= 2 ? 2 : 1;
        // The ellipse cap is in BACKING-STORE pixels, so it has to ride the
        // render scale or the rungs change the picture as well as the cost: at
        // 0.6x scale a gaussian projects to 0.6x the pixels, and a fixed cap
        // would clip 0.6x as much of it. Scaled, every rung draws the same
        // image at a different resolution — which is the whole contract here.
        material.uniforms.uMaxAxis.value = maxAxis0.current * GOV_DPR[g.level];
        onQuality?.(g.level);
        st.lastP = -1; // force a fresh sort at the new count
      };

      // Read the probe exactly once, as its cooldown runs out.
      if (g.probe > 0 && g.cooldown <= 0) {
        if ((g.probe - g.ema) / g.probe < GOV_MIN_GAIN) {
          g.floor = g.probeFrom; // this rung, and everything under it, is not the problem
          g.level = g.probeFrom;
          apply();
        }
        g.probe = 0;
        g.bad = 0;
        g.good = 0;
      }

      let move = 0;
      if (g.ema > GOV_SLOW_MS) {
        g.good = 0;
        g.bad += dt;
        if (g.bad > GOV_DEGRADE_S && g.cooldown <= 0 && g.level < g.floor) {
          move = g.ema > GOV_LEAP_MS ? 2 : 1;
        }
      } else if (g.ema < GOV_FAST_MS) {
        g.bad = 0;
        g.good += dt;
        if (g.good > GOV_RECOVER_S && g.cooldown <= 0 && g.level > 0) move = -1;
      } else {
        g.bad = 0;
        g.good = 0;
      }
      if (move !== 0) {
        const from = g.level;
        g.level = Math.max(0, Math.min(g.floor, g.level + move));
        g.bad = 0;
        g.good = 0;
        g.cooldown = move > 0 ? GOV_COOL_DOWN_S : GOV_COOL_UP_S;
        if (move > 0) {
          g.probe = g.ema;
          g.probeFrom = from;
        }
        apply();
      }
    }

    // ------------------------------------------------------------- warm-up
    // One shape a frame onto the GPU, while the diagram is still nowhere near
    // the screen. See the note on `warm` for what this is buying back.
    const wm = warm.current;
    if (cad && !wm.done) {
      if (fe > 0) {
        // Too late to be worth anything — the visitor got here first. Stand
        // down and let the remaining shapes upload as they are drawn, which is
        // exactly what happened before any of this existed.
        wm.done = true;
        wm.rt?.dispose();
        wm.rt = null;
      } else if (intro.current >= 1) {
        if (!wm.rt) {
          wm.rt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, stencilBuffer: false });
        }
        const wasSplat = mesh.visible;
        mesh.visible = false;
        let spent = 0;
        // At least one a frame however big it is, so a single fat shape can
        // never stall the queue behind it.
        while (!wm.done && (spent === 0 || spent < WARM_BYTES)) {
          let li = 0;
          let si = wm.shape;
          while (li < cad.length && si >= cad[li].meshes.length) {
            si -= cad[li].meshes.length;
            li++;
          }
          if (li >= cad.length) {
            wm.done = true;
            break;
          }
          const c = cad[li];
          const im = c.meshes[si];
          const g = c.geometries[si];
          spent += (im.instanceMatrix.array as Float32Array).byteLength;
          if (g.index) spent += (g.index.array as ArrayBufferView).byteLength;
          for (const key in g.attributes) {
            spent += (g.attributes[key].array as ArrayBufferView).byteLength;
          }
          // Visibility rather than a scene of its own: reparenting the mesh
          // would move it out from under the group whose matrix it is drawn
          // with, and this way the draw goes through the identical program,
          // attribute layout and instance buffer it will use for real.
          const wasRoot = c.root.visible;
          c.root.visible = true;
          for (let k = 0; k < c.meshes.length; k++) c.meshes[k].visible = k === si;
          gl.setRenderTarget(wm.rt);
          gl.render(scene, camera);
          gl.setRenderTarget(null);
          for (let k = 0; k < c.meshes.length; k++) c.meshes[k].visible = true;
          c.root.visible = wasRoot;
          wm.shape++;
        }
        mesh.visible = wasSplat;
        if (wm.done) {
          wm.rt.dispose();
          wm.rt = null;
        }
      }
    }

    // ---------------------------------------------------------------- idle
    // Everything that can move a pixel on the diagram beat, summed, so
    // DiagramMsaa can tell this frame from the last one. The camera is added
    // there rather than here — CameraRig has not run yet.
    //
    // Gated on the splats being GONE rather than on `fe`: uTime advances every
    // frame and is not in this sum, so while the cloud is still drawn its
    // simmer would be skipped over. By the time this can be true it is
    // multiplied out to nothing and the mesh is not drawn at all.
    const canIdle = !!cad && splatsGone && intro.current >= 1 && wm.done;
    let sig = p * 7919 + progressRef.current * 6271 + fit * 4271;
    sig +=
      grp.rotation.x * 1367 +
      grp.rotation.y * 1289 +
      grp.position.x * 1051 +
      grp.position.y * 1093 +
      grp.position.z * 1129 +
      size.width * 3 +
      size.height * 5;
    if (cad) {
      for (let ci = 0; ci < cad.length; ci++) {
        const c = cad[ci];
        const u = c.material.uniforms;
        sig +=
          (ci + 1) *
          ((c.root.visible ? 1 : 0) * 31 +
            u.uFade.value * 337 +
            u.uHot.value * 547 +
            u.uDim.value * 641 +
            c.root.position.y * 769 +
            c.root.position.x * 811 +
            c.root.position.z * 857);
      }
    }
    idle.current.can = canIdle;
    idle.current.sig = sig;
  });

  return (
    <group ref={groupRef}>
      {geometry && material && (
        <mesh ref={meshRef} geometry={geometry} material={material} frustumCulled={false} />
      )}
      {cad?.map((c, i) => (
        <primitive key={i} object={c.root} />
      ))}
    </group>
  );
}

// Adaptive quality governor. The splat cloud is fill-rate-bound on weak GPUs
// (Safari's WebGL runs this at a fraction of Chrome's throughput; phones have
// a fraction of desktop fill). Rather than sniffing browsers, watch the real
// frame cadence and walk a quality ladder: first render scale (dpr), then
// splat density. Every animation beat stays identical — degradation is only
// resolution and grain density. Recovers (with hysteresis) up to the initial
// tier when the device turns out to have headroom.
//
// The RUNGS are multipliers on the base render scale, and they are applied by
// ScrollScene owning the <Canvas dpr> prop rather than by calling r3f's
// setDpr() from in here. That is not a style preference. <Canvas> re-runs
// `configure({ dpr, ... })` on EVERY render of its own element, and configure
// does `if (state.viewport.dpr !== calculateDpr(dpr)) setDpr(dpr)` — so with a
// `[min, max]` range prop, any re-render of the host component snaps the render
// scale back to the top of the range. This component's host re-rendered on
// every scroll tick, so the governor's decisions were reverted within a frame or
// two of being made — while the governor, which tracks its own rung, went on
// believing it had made them. Observed on a 4K panel: parked at one scroll
// position for 24 s at a steady 30 fps, the backing store never changed once,
// and under scroll it flickered between two rungs and settled back at the top.
// Either way the ladder was decorative. A plain number prop, owned in React
// state, agrees with configure's check and therefore sticks.
const GOV_DPR = [1, 0.85, 0.72, 0.72, 0.6];
// Density is applied as a stride (draw every Nth splat of the live span), so
// these quantise to 1/round(1/x) — keep them at reciprocals of whole numbers or
// a rung silently does nothing. 0.7 used to round to a stride of 1, i.e. no
// thinning at all on the second-worst tier.
const GOV_COUNT = [1, 1, 1, 0.5, 1 / 3];
const GOV_MAX_LEVEL = GOV_DPR.length - 1;
const GOV_SLOW_MS = 26; // sustained above this (≈ <40fps) => degrade
const GOV_FAST_MS = 12.5; // sustained below this => try recovering
// Hysteresis in SECONDS, not in frames. Frame counts are the wrong unit for a
// governor that only ever engages on slow devices: 45 bad frames plus a
// 120-frame cooldown is 2.7 s at 60 fps and 8.2 s at 20 fps, so the worse the
// device, the slower the fix arrived. Held in seconds, a struggling device
// reaches a rung it can actually draw in about a second per step.
const GOV_DEGRADE_S = 0.7;
const GOV_RECOVER_S = 6;
const GOV_COOL_DOWN_S = 1.2;
const GOV_COOL_UP_S = 5;
// How far over budget counts as "not one rung short". A device at twice the
// frame budget will not be rescued by an 0.85x render scale, and stepping one
// rung at a time with a cooldown between each just spends the cooldowns.
const GOV_LEAP_MS = GOV_SLOW_MS * 2;
// Every demotion is also a PROBE: the cooldown that follows it is spent
// measuring whether the rung actually bought a shorter frame, and if it did not,
// the rung is handed back and the ladder stops there.
//
// Because a render-scale ladder can only fix a frame that is limited by the
// render scale, and sometimes nothing is. Reproduced on a 4K surface where the
// limit was the browser compositing a viewport-sized canvas across 7.5 Mpx of
// device pixels — a cost paid per frame whatever is inside the canvas: dropping
// the backing store from 4.74 Mpx to 0.68 Mpx, seven times less to draw, left
// the frame at exactly 33.3 ms. Without this check the governor reads "still
// slow" as "not far enough down", walks to the bottom rung and parks there: the
// hero ends up soft AND still at 30 fps, which is strictly worse than where it
// started. 12% is comfortably inside a real rung's win
// (0.85x scale ≈ 28% fewer pixels) and comfortably outside vsync quantisation
// noise, which lands on 16.7 / 33.3 / 50 and moves in halves, not tenths.
const GOV_MIN_GAIN = 0.12;

type Governor = {
  ema: number;
  seeded: boolean;
  bad: number; // seconds of sustained slow
  good: number; // seconds of sustained fast
  cooldown: number; // seconds
  level: number;
  // Lowest rung worth taking, learned. Starts permissive; a demotion that fails
  // its probe pulls it up to the last level that was actually paying for itself.
  floor: number;
  probe: number; // ema when the demotion under test was made; 0 = not probing
  probeFrom: number; // level to fall back to if it fails
  sortEvery: number;
  frame: number;
};
function CameraRig({
  progressRef,
  drive,
}: {
  progressRef: React.RefObject<number>;
  drive: React.RefObject<Drive>;
}) {
  const { camera } = useThree();

  useFrame((state, delta) => {
    // The same spring the cloud reads, not a second one at a different rate —
    // the zoom now tracks the model it is framing instead of trailing it.
    const smooth = driveScroll(
      drive.current,
      progressRef.current,
      delta,
      state.clock.elapsedTime
    );
    // 0 -> 1 -> 0 across everything up to the end of the finale, then parked.
    // Measured against DOLLY_END rather than against the page so the hold beat
    // gets a camera that is genuinely still: on the raw page position this dolly
    // was still pulling back from z 8.9 to 10 across the whole hold, which would
    // have rescaled the very part the visitor had stopped to look at. The curve
    // over the beats that precede it is unchanged — DOLLY_END is where the page
    // used to end.
    const zoom = Math.sin(clamp01(smooth / DOLLY_END) * Math.PI);
    const targetZ = 10 - zoom * 2.5;
    const dt = Math.min(delta, 0.05);

    camera.position.x = damp(camera.position.x, state.pointer.x * 0.8, 3, dt);
    camera.position.y = damp(camera.position.y, state.pointer.y * 0.5, 3, dt);
    camera.position.z = damp(camera.position.z, targetZ, 3, dt);
    camera.lookAt(0, 0, 0);
  });

  return null;
}

// ------------------------------------------------------- multisampling
// The closing diagram, and only the closing diagram, is drawn into a
// multisampled buffer and blitted down.
//
// It cannot be done with the canvas's own `antialias` flag, which is why this
// exists at all: that flag is fixed when the context is created, and turning it
// on would apply MSAA to the SPLAT pass as well — hundreds of thousands of
// alpha-blended quads, several deep, where every covered sample is a separate
// blend. That pass is fill-rate bound already (see the pixel-budget block) and
// is what 468vh of the page is made of. The diagram is the opposite: opaque
// geometry, one draw call a shape, drawn on the one beat where the splats are
// not drawn at all. So the multisampling goes where the edges are and nowhere
// else.
//
// Resolution alone did not finish the job. A million triangles of CAD is mostly
// silhouette — perforated tracks, ring gears, the lip of every disc — and those
// are exactly the edges supersampling helps least per pixel spent.
const BLIT_VERT = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// A straight texel copy, deliberately with no colour management of any kind.
// Every material in this scene is a RawShaderMaterial that writes its own final
// encoded sRGB — see the note on encodeSrgb — so the buffer already holds
// display values, and anything three would helpfully convert here would be a
// second encode of an already-encoded image.
const BLIT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = texture(uMap, vUv);
}
`;

// Sample counts by governor rung. Multisampling is the first thing to go on a
// device that is struggling, before the render scale the rungs already own —
// it is pure image quality with no effect on the animation, and a device that
// cannot hold the frame rate at 4x can usually hold it at 2x.
//
// Rung 1 used to keep all four samples, which did not match that intent and was
// leaving the largest single lever untouched on the first demotion: measured,
// multisampling is about two thirds of a frame of the held diagram, more than
// the render scale that rung 1 already drops. Halving it there is worth around
// a millisecond and is the cheapest millisecond on the ladder.
const MSAA_BY_LEVEL = [4, 2, 2, 0, 0];

// The hold beat is a still picture that costs a million triangles and a
// multisample resolve to produce, sixty times a second, for as long as somebody
// leaves it on screen. Nothing on that beat animates by design — that is the
// beat's whole contract — so once the scroll spring, the pointer parallax and
// every damped interaction state have arrived, this frame is the last one's
// exact twin and drawing it again buys nothing.
//
// So: SplatCloud sums everything that can change the picture into `sig`, and
// DiagramMsaa declines to render when it is unchanged. Not drawing leaves the
// canvas out of the compositor's dirty set, so the previous frame stays on
// screen — the same mechanism r3f's own `frameloop="demand"` runs on.
//
// It is an EXACT comparison, which is why damp() and the scroll spring were
// both given an arrival threshold: an exponential that only ever approaches its
// target would keep this beat rendering forever over motion in the twelfth
// decimal place.
type Idle = {
  // Whether the diagram is the only thing on screen, i.e. whether the frame
  // really is a pure function of what `sig` covers. False everywhere else on the
  // page, where the splat cloud simmers on a clock and nothing may be skipped.
  can: boolean;
  sig: number;
  // Written by DiagramMsaa, read by the governor on the frame after: a skipped
  // frame is fast because it did nothing, and a governor that counted it as
  // evidence would climb a rung it cannot hold the moment the pointer moves.
  drew: boolean;
};

function DiagramMsaa({
  active,
  samples,
  idle,
}: {
  active: boolean;
  samples: number;
  idle: React.RefObject<Idle>;
}) {
  const { gl, scene, camera } = useThree();
  const dbs = useRef(new THREE.Vector2());
  const rt = useRef<THREE.WebGLRenderTarget | null>(null);
  const lastSig = useRef(Number.NaN);

  // The fullscreen triangle, not a quad: one primitive, no seam down the
  // diagonal, and the parts of it outside the viewport cost nothing.
  const kit = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
    );
    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uMap: { value: null as THREE.Texture | null } },
      vertexShader: BLIT_VERT,
      fragmentShader: BLIT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const s = new THREE.Scene();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    s.add(mesh);
    return { geometry, material, scene: s, camera: new THREE.OrthographicCamera() };
  }, []);

  const drop = useCallback(() => {
    rt.current?.dispose();
    rt.current = null;
  }, []);

  // The blit is two lines of GLSL, but it is still a program that has to be
  // linked, and left alone it links on the one frame the diagram arrives —
  // beside everything else arriving on that frame. Traced during a scroll
  // through the handover it was the last linkProgram left there.
  useEffect(() => {
    try {
      gl.compile(kit.scene, kit.camera);
    } catch {
      // Same as the geometry warm-up: worth a frame if it works, nothing if not.
    }
  }, [gl, kit]);

  // A sample count is baked into the renderbuffer, so a rung change has to build
  // a new one rather than resize the old.
  useEffect(() => drop(), [samples, drop]);

  // Insurance for the idle check. Skipping a frame relies on the compositor
  // still holding the last one, which is true while the page is simply sitting
  // there and is not worth betting on across a backgrounded tab, a bfcache
  // restore or a lost context. None of those change the scene, so none of them
  // would change the hash — force the next frame to draw instead.
  useEffect(() => {
    const wake = () => {
      lastSig.current = Number.NaN;
    };
    const el = gl.domElement;
    for (const e of ['visibilitychange', 'pageshow', 'focus', 'resize'] as const) {
      window.addEventListener(e, wake);
    }
    el.addEventListener('webglcontextrestored', wake);
    return () => {
      for (const e of ['visibilitychange', 'pageshow', 'focus', 'resize'] as const) {
        window.removeEventListener(e, wake);
      }
      el.removeEventListener('webglcontextrestored', wake);
    };
  }, [gl]);
  useEffect(() => {
    return () => {
      drop();
      kit.geometry.dispose();
      kit.material.dispose();
    };
  }, [kit, drop]);

  // Priority 1: this takes rendering over from r3f entirely, so the pass-through
  // branch below is not an optimisation, it is the only thing drawing the other
  // 90% of the page.
  useFrame(() => {
    const s = gl.getDrawingBufferSize(dbs.current);
    const w = Math.max(1, Math.floor(s.x));
    const h = Math.max(1, Math.floor(s.y));

    // Is this frame the previous one over again? The camera is folded in here
    // rather than upstream because CameraRig subscribes after SplatCloud, so its
    // parallax is not yet written when `sig` is summed — and priority 1 means
    // this callback runs after every one of them.
    const st = idle.current;
    if (st.can) {
      const sig =
        st.sig +
        camera.position.x * 911 +
        camera.position.y * 977 +
        camera.position.z * 1013 +
        w * 7 +
        h * 11 +
        samples * 13;
      if (sig === lastSig.current) {
        st.drew = false;
        return;
      }
      lastSig.current = sig;
    } else {
      lastSig.current = Number.NaN;
    }
    st.drew = true;

    if (!active || samples < 2) {
      if (rt.current) drop();
      gl.setRenderTarget(null);
      gl.render(scene, camera);
      return;
    }

    let t = rt.current;
    if (!t) {
      t = new THREE.WebGLRenderTarget(w, h, {
        samples,
        depthBuffer: true,
        stencilBuffer: false,
      });
      t.texture.colorSpace = THREE.NoColorSpace;
      t.texture.generateMipmaps = false;
      t.texture.minFilter = THREE.LinearFilter;
      t.texture.magFilter = THREE.LinearFilter;
      rt.current = t;
    } else if (t.width !== w || t.height !== h) {
      // Follows the DRAWING BUFFER, not the CSS box: the render scale moves under
      // this beat (the diagram claims a budget of its own) and the governor moves
      // it again, neither of which changes the element's size.
      t.setSize(w, h);
    }

    gl.setRenderTarget(t);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    kit.material.uniforms.uMap.value = t.texture;
    gl.render(kit.scene, kit.camera);
  }, 1);

  return null;
}

// Sparse ambient dust for depth — barely-there ice motes, not confetti.
function BackgroundParticles({
  progressRef,
  idle,
}: {
  progressRef: React.RefObject<number>;
  idle: React.RefObject<Idle>;
}) {
  const pointsRef = useRef<THREE.Points>(null);

  const positions = useMemo(() => {
    const arr = new Float32Array(160 * 3);
    for (let i = 0; i < 160; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 16;
      arr[i * 3 + 1] = (Math.random() - 0.5) * 16;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 16 - 4;
    }
    return arr;
  }, []);

  useFrame((_state, delta) => {
    if (pointsRef.current) {
      // Held still on the diagram beat, along with everything else there. Not an
      // optimisation in itself — 160 motes are free — but the idle check above
      // is exact, and a drift nothing else matches would either keep the beat
      // rendering forever or, if left to accumulate through skipped frames,
      // snap the dust sideways the moment something else woke the frame up.
      if (!idle.current.can) {
        // per second, not per frame — the motes used to drift at double speed on
        // a 120Hz display
        pointsRef.current.rotation.y += 0.024 * Math.min(delta, 0.05);
      }
      const mat = pointsRef.current.material as THREE.PointsMaterial;
      mat.opacity = lerp(0.07, 0.2, progressRef.current);
    }
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.02} color="#8a8a86" transparent opacity={0.07} sizeAttenuation />
    </points>
  );
}

function Scene({
  progressRef,
  reserveRef,
  reserveRightRef,
  drive,
  text,
  onReady,
  onLayer,
  onQuality,
  selectRef,
  hoverRef,
  onHover,
  onSelect,
  onInspectable,
  onDiagram,
  msaa,
}: {
  progressRef: React.RefObject<number>;
  reserveRef: React.RefObject<number>;
  reserveRightRef: React.RefObject<number>;
  // Owned by ScrollScene, not created here: scroll reaches the scene through a
  // ref (so scrolling re-renders nothing), but the leash has to read the spring
  // back out from the DOM side to know how far ahead the page is allowed to be.
  drive: React.RefObject<Drive>;
  text: string;
  onReady?: () => void;
  onLayer?: (i: number) => void;
  onQuality?: (level: number) => void;
  selectRef: React.RefObject<number>;
  hoverRef: React.RefObject<number>;
  onHover?: (i: number) => void;
  onSelect?: (i: number) => void;
  onInspectable?: (v: boolean) => void;
  onDiagram?: (v: boolean) => void;
  // Multisampling for the closing diagram: whether it owns the frame, and how
  // many samples the governor's current rung allows. See DiagramMsaa.
  msaa: number;
}) {
  // Shared between the three frame loops below, never rendered into React. See
  // the Idle type.
  const idle = useRef<Idle>({ can: false, sig: Number.NaN, drew: true });
  return (
    <>
      <DiagramMsaa active={msaa >= 2} samples={msaa} idle={idle} />
      <SplatCloud
        idle={idle}
        text={text}
        progressRef={progressRef}
        reserveRef={reserveRef}
        reserveRightRef={reserveRightRef}
        drive={drive}
        onReady={onReady}
        onLayer={onLayer}
        onQuality={onQuality}
        selectRef={selectRef}
        hoverRef={hoverRef}
        onHover={onHover}
        onSelect={onSelect}
        onInspectable={onInspectable}
        onDiagram={onDiagram}
      />
      <BackgroundParticles progressRef={progressRef} idle={idle} />
      <CameraRig progressRef={progressRef} drive={drive} />
    </>
  );
}

export default function ScrollScene({
  hero,
  stages,
  inspect,
}: {
  hero: {
    title: string;
    eyebrow: string;
    subtitle: string;
    scrollHint: string;
    loading: string;
  };
  stages: { title: string; text: string }[];
  // Copy for the hold beat: the prompt that says the diagram can be pointed at,
  // the way back out of an open part, and the rail's accessible name.
  inspect: { hint: string; close: string; rail: string; cycle: string };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Two readings of the same scroll: the ref is exact and free (the canvas
  // reads it inside its own frame loop), the state is quantised and only exists
  // to move the DOM overlays.
  const progressRef = useRef(0);
  // The scene's spring, hoisted out of <Scene> so the scroll handler can leash
  // the page to it. See the pacing block up top.
  const drive = useRef<Drive>({
    p: 0,
    v: 0,
    stamp: -1,
    primed: false,
    paced: true,
    wall: 0,
  });
  const [mounted, setMounted] = useState(false);
  const [ready, setReady] = useState(false);
  const [inView, setInView] = useState(true);
  // Render scale, owned here because <Canvas> reasserts its `dpr` prop on every
  // render — see the GOV_DPR block. `quality` is the governor's rung; the base
  // is the pixel budget, re-measured on resize so dragging the window to another
  // monitor re-fits it.
  const [quality, setQuality] = useState(0);
  // Whether the closing diagram owns the frame. It gets a much larger pixel
  // budget than the rest of the hero, so this is an input to the render scale
  // rather than only a piece of presentation state — see PIXEL_BUDGET_DIAGRAM.
  const [diagram, setDiagram] = useState(false);
  const [dprBase, setDprBase] = useState(() => baseDpr());
  const handleQuality = useCallback((level: number) => setQuality(level), []);
  const handleDiagram = useCallback((v: boolean) => setDiagram(v), []);
  useEffect(() => {
    const fit = () => setDprBase(baseDpr(diagram));
    fit();
    window.addEventListener('resize', fit, { passive: true });
    return () => window.removeEventListener('resize', fit);
  }, [diagram]);
  // Same fact the frameloop is gated on, readable from the scroll handler. It
  // matters there: out of view the canvas stops and the spring FREEZES, so a
  // leash that trusted a stale `drive.p` would pin the visitor inside a hero
  // that is no longer animating.
  const inViewRef = useRef(true);
  // -1 until the walk starts: the captions label captures, so there is nothing
  // to say while the page is still showing the word.
  const [layer, setLayer] = useState(-1);
  const handleReady = useCallback(() => setReady(true), []);
  const handleLayer = useCallback((i: number) => setLayer(i), []);

  // ------------------------------------------------------------- inspection
  // Three pieces of state, all of them rare: which layer the pointer is on, which
  // one is open, and whether the diagram is taking a pointer at all. The scene
  // reads the selection through a ref (it is in the frame loop and must not be
  // re-rendered into) and the two are kept in step by handleSelect writing both.
  const [hovered, setHovered] = useState(-1);
  const [opened, setOpened] = useState(-1);
  const [inspectable, setInspectable] = useState(false);
  const selectRef = useRef(-1);
  const hoverRef = useRef(-1);
  const handleHover = useCallback((i: number) => setHovered(i), []);
  const handleSelect = useCallback((i: number) => {
    selectRef.current = i;
    setOpened(i);
  }, []);
  const handleInspectable = useCallback((v: boolean) => setInspectable(v), []);

  // The subassemblies, which are the stages minus the assembled table at the
  // front and the diagram itself at the back. Both the rail and the cycling are
  // indexed against this.
  const parts = useMemo(() => stages.slice(1, -1), [stages]);
  const cycle = useCallback(
    (dir: number) => {
      setOpened((prev) => {
        if (prev < 0 || parts.length < 1) return prev;
        const next = (prev + dir + parts.length) % parts.length;
        selectRef.current = next;
        return next;
      });
    },
    [parts.length]
  );

  // While a part is open the wheel drives the stack, not the page. Bound on
  // window and non-passive so it can cancel the scroll wherever the pointer
  // happens to be — the caption and the rail sit over the canvas, and a wheel
  // event lands on whichever of them is under the cursor.
  useEffect(() => {
    if (opened < 0) return;
    let acc = 0;
    let last = 0;
    let sx = 0;
    let sy = 0;

    const fire = (dir: number) => {
      const now = performance.now();
      if (now - last < CYCLE_COOLDOWN_MS) return false;
      last = now;
      acc = 0;
      cycle(dir);
      return true;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) >= CYCLE_WHEEL) fire(Math.sign(acc));
    };
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      sx = t.clientX;
      sy = t.clientY;
      acc = 0;
    };
    // Vertical only. A horizontal drag is the orbit's, and the canvas's own
    // pointer handler releases the vertical axis for exactly this.
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (Math.abs(dy) <= Math.abs(dx)) return;
      if (e.cancelable) e.preventDefault();
      // Up-swipe reads as "further down the stack", the same direction a wheel
      // down goes.
      if (Math.abs(dy) >= CYCLE_SWIPE && fire(dy < 0 ? 1 : -1)) sy = t.clientY;
    };
    // Deliberately NOT Home/End/Space: those stay with the page, so a keyboard
    // is never without a way out that is not Escape.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault();
        cycle(1);
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        cycle(-1);
      }
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onKey);
    };
  }, [opened, cycle]);

  // The custom cursor swells over anything interactive, and the diagram is now
  // one of those things — but it is a canvas, so there is no element for
  // Cursor.tsx's `closest('a, button')` to find. A class on the root is the
  // cheapest channel between the two, and it costs one write per hover change.
  useEffect(() => {
    const on = hovered >= 0 || opened >= 0;
    document.documentElement.classList.toggle('cursor-hot', on);
    return () => document.documentElement.classList.remove('cursor-hot');
  }, [hovered, opened]);

  // The three overlays that track scroll continuously — the hero copy's fade,
  // the rail fill, the percentage readout — written straight to the DOM instead
  // of through state.
  //
  // They used to be a quantised `progress` state, which is a re-render of this
  // component every 0.4% of the page: ~250 of them across the hero, each one
  // re-rendering <Canvas>, and <Canvas> re-runs r3f's async configure() and
  // re-reconciles the whole scene tree every time it renders. All of that landed
  // in the frames the canvas was trying to draw, during scroll, which is exactly
  // when there is nothing to spare. None of these three needs React: between
  // them they are one opacity, one height and three digits.
  const heroFadeRef = useRef<HTMLDivElement>(null);
  const railFillRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const paintProgress = useCallback((p: number) => {
    if (heroFadeRef.current) {
      heroFadeRef.current.style.opacity = String(clamp01(1 - p * 4.5));
    }
    if (railFillRef.current) railFillRef.current.style.height = `${p * 100}%`;
    const out = readoutRef.current;
    if (out) {
      const digits = String(Math.round(p * 100)).padStart(3, '0');
      if (out.textContent !== digits) out.textContent = digits;
    }
  }, []);

  // How many pixels off the left edge the caption claims, handed to the scene so
  // it can keep the model out of them. 0 means "no reservation": below the md
  // breakpoint the caption is bottom-anchored under the model rather than beside
  // it, so there is no column to avoid and shifting the model would only shrink
  // it for nothing.
  const captionRef = useRef<HTMLDivElement>(null);
  const reserveRef = useRef(0);
  // Its mirror on the right, and measured for the same reason: the rail's width
  // is set by the longest subassembly name in whichever language is loaded
  // ("Center Column & Control Dome" against "中心升降柱 / 玻璃控制盘"), so it is
  // not a number this file can know.
  const railRef = useRef<HTMLElement>(null);
  const reserveRightRef = useRef(0);
  useEffect(() => {
    const measure = () => {
      const el = captionRef.current;
      // Matches the `md:items-center` switch in the caption's own classes. Read
      // from matchMedia rather than a hardcoded 768 so the two cannot drift.
      const beside = window.matchMedia('(min-width: 768px)').matches;
      reserveRef.current = el && beside ? el.getBoundingClientRect().right : 0;
      // The rail's INDEX column, not the whole rail. The names fold away the
      // moment a part is opened, which is the only state where the model is big
      // enough to reach the right edge at all — so reserving the width they
      // occupy the rest of the time would shrink the isolated part to clear text
      // that is no longer there. Measured off the index rather than off the nav
      // because the nav's own width is mid-transition exactly when this matters.
      const idx = railRef.current?.querySelector('[data-rail-index]');
      reserveRightRef.current =
        idx && beside
          ? Math.max(0, window.innerWidth - idx.getBoundingClientRect().left + CAPTION_GUTTER)
          : 0;
    };
    measure();
    window.addEventListener('resize', measure, { passive: true });
    return () => window.removeEventListener('resize', measure);
  }, [mounted]);

  useEffect(() => {
    setMounted(true);
  }, []);

  // The splat cloud is the most expensive thing on the page — stop its render
  // loop entirely once the hero scrolls out of view, instead of burning GPU
  // behind the DOM sections forever. Generous margin so it resumes (and
  // re-sorts) before the canvas is back on screen.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([e]) => {
        inViewRef.current = e.isIntersecting;
        setInView(e.isIntersecting);
      },
      { rootMargin: '30% 0px 30% 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [mounted]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Measured once instead of per event. getBoundingClientRect() inside a
    // scroll handler forces a style + layout flush, and on a 500vh page with a
    // sticky child that flush landed in the same frame the canvas was trying to
    // draw — the single biggest source of scroll hitching here. offsetTop /
    // offsetHeight read layout that is already computed.
    const metrics = { top: 0, span: 1 };
    const measure = () => {
      let top = 0;
      for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) {
        top += n.offsetTop;
      }
      metrics.top = top;
      metrics.span = Math.max(1, el.offsetHeight - window.innerHeight);
    };

    // The leash only answers to a live gesture: a wheel, a finger, or a paging
    // key. Everything else that moves the page — an in-page anchor, the End
    // key, dragging the scrollbar thumb, the browser restoring a position — is
    // an explicit "put me THERE", and holding those back would turn an 820vh
    // hero into a trap you can only leave at walking pace. Tracked as a chain
    // rather than a single event so trackpad and touch MOMENTUM, which arrives
    // as bare scroll events after the gesture is over, still counts as one; a
    // smooth anchor scroll produces the same stream of events but no gesture
    // opens its chain, so it passes straight through.
    const PAGING_KEYS = new Set([
      'ArrowDown',
      'ArrowUp',
      'PageDown',
      'PageUp',
      ' ',
      'Spacebar',
    ]);
    const GESTURE_MS = 250; // how long a mark stays live / the gap that ends a chain
    let gestureAt = -1e9;
    let lastScrollAt = -1e9;
    let chainLive = false;
    const mark = () => {
      gestureAt = performance.now();
    };
    const onKey = (e: KeyboardEvent) => {
      if (PAGING_KEYS.has(e.key)) mark();
    };

    // Which capture hold the walk last came to rest on, or null if it does not
    // know (before the walk, or after a jump the leash let through).
    let rest: number | null = null;
    let snapAt = 0;

    // Inside the walk the readable states are the holds, and the walk is not
    // allowed to rest anywhere else. The leash bounds how FAR a gesture goes;
    // this decides where letting go LANDS — so a scroll that stalls half way
    // through a removal finishes it rather than leaving the cabinet frozen at
    // 40% evaporated, which is the state nothing in the scene is designed to be
    // looked at in.
    const applySnap = () => {
      snapAt = 0;
      const d = drive.current;
      const live = inViewRef.current && performance.now() - d.wall < 1000 / PACE_MIN_FPS;
      if (!d.paced || !d.primed || !live) return;
      const cur = clamp01((window.scrollY - metrics.top) / metrics.span);
      if (cur <= WALK_S0 || cur >= WALK_S1) {
        rest = null;
        return;
      }
      // Clamped by the leash as well: releasing must not put scroll somewhere a
      // gesture could not have taken it, or a wheel turned faster than the
      // scene can walk would snap its way past captures the leash just refused.
      const want = Math.min(
        Math.max(scrollOfBeat(snapBeat(cur, rest)), leashFloor(d.p)),
        leashCeil(d.p)
      );
      // Recorded so a second snap inside the same gesture chain — the write
      // below emits a scroll event, which can re-arm this within GESTURE_MS —
      // sees the hold it just committed to and steps nowhere, instead of
      // reading its own move as another gesture and walking off down the page.
      rest = Math.round(beatOf(want));
      const y = Math.round(metrics.top + want * metrics.span);
      if (Math.abs(y - window.scrollY) < 1) return;
      window.scrollTo({ top: y, behavior: 'instant' });
      progressRef.current = want;
      paintProgress(want);
    };
    const scheduleSnap = () => {
      if (snapAt) clearTimeout(snapAt);
      snapAt = window.setTimeout(applySnap, SNAP_DELAY_MS);
    };

    let raf = 0;
    const read = () => {
      raf = 0;
      const now = performance.now();
      const d = drive.current;
      // A gap this long ends the chain; the next event starts a new one, which
      // is gesture-driven only if a gesture just marked it.
      if (now - lastScrollAt > GESTURE_MS) {
        chainLive = now - gestureAt < GESTURE_MS;
        // Re-read the hold to step from at the top of every gesture, from where
        // the scene actually is. Carrying it over from the last snap instead
        // went stale the moment that snap declined to run — off view, under
        // PACE_MIN_FPS, under reduced motion — and a stale origin makes the
        // next release step the WRONG WAY: a nudge back off capture 4 that
        // thought it started at 3 reads as +0.7 and commits forward.
        const b = beatOf(d.p);
        rest =
          d.primed && b >= -BEAT_EPS && b <= WALK_CAPTURES + BEAT_EPS
            ? Math.min(WALK_CAPTURES, Math.max(0, Math.round(b)))
            : null;
      }
      lastScrollAt = now;

      const y = window.scrollY;
      let p = clamp01((y - metrics.top) / metrics.span);

      const held = Math.min(Math.max(p, leashFloor(d.p)), leashCeil(d.p));
      if (held !== p) {
        // Scroll is outside the window. Either hold it, or give up on holding
        // it and re-seat the scene where the page already is — never neither,
        // because a gap the leash declined to police this frame is a gap it
        // would YANK the page back to close on the next one. Off-view, below
        // PACE_MIN_FPS, or under reduced motion it always gives up.
        const live = inViewRef.current && now - d.wall < 1000 / PACE_MIN_FPS;
        if (d.paced && d.primed && live && chainLive) {
          // The hero is sticky and fills the viewport, so clamping scrollY
          // inside it moves almost no pixels — what the visitor feels is a
          // detent, not a snap-back. Writing the correction back (rather than
          // just clamping what the scene reads) is what keeps the scroll
          // position, the readout and the captions all agreeing.
          p = held;
          const want = Math.round(metrics.top + held * metrics.span);
          if (Math.abs(want - y) >= 1) {
            // 'instant' is not the default here: globals.css sets
            // scroll-behavior: smooth, which would animate every correction and
            // leave the leash chasing its own easing.
            window.scrollTo({ top: want, behavior: 'instant' });
          }
        } else {
          // An anchor, the End key, the scrollbar thumb, a reload part-way down
          // — a deliberate "put me THERE". Honour it, rather than slow-walking
          // the whole teardown to arrive. The hold the walk thought it was on
          // no longer means anything after a jump like that.
          d.primed = false;
          rest = null;
        }
      }
      scheduleSnap();

      progressRef.current = p;
      // Straight to the DOM — no state, no reconcile, no <Canvas> reconfigure.
      // This already runs at most once per painted frame (see onScroll), so it
      // needs no quantising of its own either.
      paintProgress(p);
    };
    // Scroll events can outpace the display; coalescing to one read per frame
    // means the work happens once per painted frame at most.
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    const onResize = () => {
      measure();
      read();
    };

    measure();
    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    window.addEventListener('wheel', mark, { passive: true });
    window.addEventListener('touchstart', mark, { passive: true });
    window.addEventListener('touchmove', mark, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (snapAt) clearTimeout(snapAt);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('wheel', mark);
      window.removeEventListener('touchstart', mark);
      window.removeEventListener('touchmove', mark);
      window.removeEventListener('keydown', onKey);
    };
  }, [mounted, paintProgress]);

  // Reduced motion turns the pacing off wholesale. A leash and a speed limit
  // are both MORE motion from the visitor's point of view — the page moving
  // when they did not move it, and the scene still moving after they stopped —
  // which is the opposite of what the preference asks for.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      drive.current.paced = !mq.matches;
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // What the caption is naming. During the walk it is the capture on screen;
  // during the hold beat it is whatever the visitor is pointing at, and an open
  // part outranks a hovered one so the panel does not flicker to a neighbour
  // while you reach for the close button.
  //
  // Layer indices are offset by one against stage indices, and always were: the
  // CAD carries the eight SUBASSEMBLIES (01_exterior_cabinet .. 08_power) while
  // the stages start with 00, the assembled table, which is not a layer.
  const active = opened >= 0 ? opened : hovered;
  const currentStage =
    inspectable && active >= 0
      ? Math.min(active + 1, stages.length - 1)
      : layer >= 0
        ? Math.min(layer, stages.length - 1)
        : -1;

  // The canvas subtree, held across every render this component makes for a
  // reason that has nothing to do with micro-optimisation: <Canvas> re-runs r3f's
  // configure() and re-reconciles the entire scene tree on every render of its
  // own element, and inspection adds three new pieces of state that change while
  // a pointer is moving. Without this, hovering across the diagram would
  // re-reconcile the scene several times a second — see the GOV_DPR note for
  // what that class of re-render already cost the governor. Every dependency
  // here is either a primitive or a stable useCallback/ref.
  const canvas = useMemo(
    () => (
      <Canvas
        // near/far deliberately tight. r3f defaults to 0.1/1000, and depth
        // resolution at the model's distance scales with the near plane — the
        // CAD diagram is full of CAD-flush faces (a felt sheet laid exactly on
        // the deck it covers) and every spare bit of depth buys some of them
        // back. The camera never leaves z = 7.5..10 and nothing in the scene is
        // more than a few units from the origin, so this range has room to
        // spare.
        camera={{ position: [0, 0, 10], fov: 50, near: 0.5, far: 50 }}
        frameloop={inView ? 'always' : 'never'}
        // A single number, never a [min, max] range: a range is resolved
        // against window.devicePixelRatio on every <Canvas> render, which
        // silently reverted the governor. See the GOV_DPR block.
        dpr={dprBase * GOV_DPR[quality]}
        gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => gl.setClearColor('#050505', 1)}
      >
        <Scene
          progressRef={progressRef}
          drive={drive}
          text={hero.title}
          reserveRef={reserveRef}
          reserveRightRef={reserveRightRef}
          onReady={handleReady}
          onLayer={handleLayer}
          onQuality={handleQuality}
          selectRef={selectRef}
          hoverRef={hoverRef}
          onHover={handleHover}
          onSelect={handleSelect}
          onInspectable={handleInspectable}
          onDiagram={handleDiagram}
          msaa={diagram ? MSAA_BY_LEVEL[quality] : 0}
        />
      </Canvas>
    ),
    [
      inView,
      dprBase,
      quality,
      diagram,
      hero.title,
      handleReady,
      handleLayer,
      handleQuality,
      handleHover,
      handleSelect,
      handleInspectable,
    ]
  );

  // Both heights come from the one constant: if the placeholder and the mounted
  // container ever disagree, the page jumps the moment hydration lands.
  if (!mounted) {
    return <div className="bg-void" style={{ height: `${HERO_VH}vh` }} />;
  }

  return (
    <div
      ref={containerRef}
      className="relative bg-void"
      style={{ height: `${HERO_VH}vh` }}
    >
      {/* Sticky canvas. antialias off (soft gaussians can't alias, MSAA is pure
          fill-rate cost), opaque canvas in the page background colour (saves
          the compositor a full-screen blend), phones start at a lower render
          scale — the governor inside handles the rest. */}
      <div className="sticky top-0 h-screen w-full overflow-hidden">
        {canvas}

        {/* Vignette + edge fades in ONE element (stacked backgrounds): every div
            layered over the canvas is another full-screen blend the compositor
            pays on every canvas frame — WebKit in particular chokes on it */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: [
              'linear-gradient(to bottom, rgba(5,5,5,0.9), transparent 7rem)',
              'linear-gradient(to top, rgba(5,5,5,1), transparent 8rem)',
              'radial-gradient(120% 90% at 50% 42%, transparent 42%, rgba(3, 3, 3, 0.8) 100%)',
            ].join(', '),
          }}
        />

        {/* Accessible heading — the particle word is not readable to screen readers */}
        <h1 className="sr-only">{hero.title}</h1>

        {/* Loading shimmer while the splat binary streams in */}
        {!ready && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-5">
              <div className="h-px w-32 bg-white/10 overflow-hidden">
                <div className="h-full w-full bg-acid/90 animate-pulse-soft" />
              </div>
              <p className="font-mono text-[11px] tracking-[0.35em] uppercase text-mute animate-pulse-soft">
                {hero.loading}
              </p>
            </div>
          </div>
        )}

        {/* Hero overlay — eyebrow + subtitle + scroll cue, fade as you scroll */}
        <div
          ref={heroFadeRef}
          className="absolute inset-0 flex flex-col items-center justify-end pb-16 md:pb-20 pointer-events-none"
        >
          <div className={ready ? 'animate-fade-up [animation-delay:600ms]' : 'opacity-0'}>
            <p className="font-mono text-[11px] md:text-xs tracking-[0.4em] uppercase text-acid text-center mb-4">
              {hero.eyebrow}
            </p>
            <p className="font-mono text-xs md:text-sm uppercase tracking-[0.25em] text-smoke/80 text-center px-6">
              {hero.subtitle}
            </p>
          </div>
          <div
            className={`mt-10 flex flex-col items-center gap-3 ${
              ready ? 'animate-fade-up [animation-delay:1200ms]' : 'opacity-0'
            }`}
          >
            <span className="font-mono text-[10px] tracking-[0.35em] uppercase text-mute">
              {hero.scrollHint}
            </span>
            <span className="block h-10 w-px bg-gradient-to-b from-acid/80 to-transparent animate-scroll-line" />
          </div>
        </div>

        {/* Capture caption — names the subassembly currently on screen, and the
            drawing once the teardown resolves into it. Sits on the left, clear
            of the model, and swaps at the midpoint of each removal: the outgoing
            part is halfway out of frame and the incoming one is still resolving,
            so the label never changes over a settled capture. */}
        <div
          // Vertically centred beside the model on wide screens; on a phone the
          // model fills the middle, so the caption drops to the lower third
          // rather than sitting on top of it.
          className="absolute inset-0 flex items-end pb-24 md:items-center md:pb-0 pointer-events-none"
          style={{
            opacity: currentStage >= 0 ? 1 : 0,
            transition: 'opacity 0.6s',
          }}
        >
          <div className="max-w-7xl mx-auto px-6 lg:px-8 w-full">
            {/* Fixed height: the captions are absolutely stacked so they can
                cross-fade, and without a reserved box the container collapses. */}
            <div ref={captionRef} className="relative max-w-xs md:max-w-sm h-64">
              {stages.map((stage, i) => (
                <div
                  key={i}
                  aria-hidden={currentStage !== i}
                  className={`absolute inset-x-0 top-0 transition-all duration-700 ease-out ${
                    currentStage === i
                      ? 'opacity-100 translate-y-0'
                      : currentStage > i
                        ? 'opacity-0 -translate-y-6'
                        : 'opacity-0 translate-y-6'
                  }`}
                >
                  <p className="font-mono text-[11px] tracking-[0.35em] text-acid mb-4">
                    {String(i).padStart(2, '0')} / {String(stages.length - 1).padStart(2, '0')}
                  </p>
                  <h3 className="font-display text-2xl md:text-4xl uppercase text-smoke tracking-wide mb-4 text-balance">
                    {stage.title}
                  </h3>
                  <p className="text-mute text-sm md:text-base leading-relaxed border-l border-white/15 pl-5">
                    {stage.text}
                  </p>
                </div>
              ))}

              {/* The hold beat's prompt, and the way back out of an open part.
                  Inside the measured box, so the model's left-edge reservation
                  already covers it and no part can end up under this line. */}
              <div
                className="absolute inset-x-0 bottom-0 transition-opacity duration-500"
                style={{ opacity: inspectable ? 1 : 0 }}
                aria-hidden={!inspectable}
              >
                {opened >= 0 ? (
                  <>
                    <button
                      type="button"
                      onClick={() => handleSelect(-1)}
                      tabIndex={inspectable ? 0 : -1}
                      className="pointer-events-auto font-mono text-[10px] tracking-[0.3em] uppercase text-acid hover:text-smoke transition-colors"
                    >
                      ← {inspect.close}
                    </button>
                    {/* Named, not left to be discovered: with a part open the
                        wheel no longer moves the page, and the way back out has
                        to be on screen rather than guessed at. */}
                    <p className="mt-3 font-mono text-[10px] tracking-[0.3em] uppercase text-mute">
                      {inspect.cycle}
                    </p>
                  </>
                ) : (
                  <p className="font-mono text-[10px] tracking-[0.3em] uppercase text-mute">
                    {inspect.hint}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right rail, two states in one place: the scroll readout for the whole
            page, and — once the diagram is assembled and taking a pointer — the
            stack as a list, top to bottom in the order the parts appear on
            screen. The list is not decoration: a canvas has nothing for a
            keyboard to reach, so it is the only way into the diagram that does
            not require a pointer, and it doubles as the signal that there is
            something here to point AT. Both children share one grid cell so the
            container is sized by the taller and neither moves as they cross-fade. */}
        <div className="absolute right-6 lg:right-8 top-1/2 -translate-y-1/2 hidden md:grid">
          <div
            className="[grid-area:1/1] justify-self-end flex flex-col items-center gap-3 transition-opacity duration-500"
            style={{ opacity: inspectable ? 0 : 1 }}
            aria-hidden={inspectable}
          >
            <span ref={readoutRef} className="font-mono text-[10px] text-mute tabular-nums">
              000
            </span>
            <div className="relative h-44 w-px bg-white/10 overflow-hidden">
              <div
                ref={railFillRef}
                className="absolute top-0 left-0 w-full bg-acid shadow-[0_0_12px_rgba(198,255,0,0.9)]"
                style={{ height: '0%' }}
              />
            </div>
            <span className="font-mono text-[10px] text-mute tabular-nums">100</span>
          </div>

          <nav
            ref={railRef}
            aria-label={inspect.rail}
            className={`[grid-area:1/1] justify-self-end flex flex-col items-end gap-px transition-opacity duration-500 ${
              inspectable ? 'pointer-events-auto' : 'pointer-events-none'
            }`}
            style={{ opacity: inspectable ? 1 : 0 }}
            aria-hidden={!inspectable}
          >
            {parts.map((stage, i) => {
              const on = active === i;
              return (
                <button
                  key={i}
                  type="button"
                  tabIndex={inspectable ? 0 : -1}
                  aria-pressed={opened === i}
                  // Hover is written to a ref, not to state: the scene reads it in
                  // its own frame loop and reports the result back through the same
                  // channel the ray uses, so the rail and the geometry light each
                  // other from ONE value instead of two that can disagree.
                  onPointerEnter={() => {
                    hoverRef.current = i;
                  }}
                  onPointerLeave={() => {
                    hoverRef.current = -1;
                  }}
                  onFocus={() => {
                    hoverRef.current = i;
                  }}
                  onBlur={() => {
                    hoverRef.current = -1;
                  }}
                  onClick={() => handleSelect(opened === i ? -1 : i)}
                  className="group flex items-center gap-2.5 py-1"
                >
                  {/* Titles first, ticks pinned to the right edge — so the index
                      column stays put while the names fold away. They fold while
                      a part is open because eight labels are 320px of a 1440px
                      frame, and the model has to live in what the caption on the
                      left has not already claimed. Seven of those labels are also
                      redundant at that moment: the caption is naming the eighth.
                      max-width rather than display, so it animates and so the
                      button stops covering the geometry it uncovers. */}
                  <span
                    className={`font-mono text-[10px] uppercase tracking-[0.18em] text-right whitespace-nowrap overflow-hidden transition-all duration-500 ${
                      opened >= 0 ? 'max-w-0 opacity-0' : 'max-w-[15rem] opacity-100'
                    } ${on ? 'text-smoke' : 'text-mute/60 group-hover:text-mute'}`}
                  >
                    {stage.title}
                  </span>
                  <span
                    data-rail-index
                    className={`font-mono text-[9px] tabular-nums transition-colors ${
                      on ? 'text-acid' : 'text-mute/60'
                    }`}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span
                    className={`h-px transition-all duration-300 ${
                      on ? 'w-6 bg-acid shadow-[0_0_10px_rgba(198,255,0,0.9)]' : 'w-2.5 bg-white/20'
                    }`}
                  />
                </button>
              );
            })}
          </nav>
        </div>
      </div>
    </div>
  );
}
