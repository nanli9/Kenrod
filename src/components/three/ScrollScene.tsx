'use client';

import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { CAD_URL, CAD_INDEX_URL } from '@/lib/modelRev';

// The machine, and the only geometry the hero downloads. The URLs and their
// cache-busting stamp live in src/lib/modelRev.ts, because the locale layout
// preloads the same bytes and the two must not be able to drift apart.
//
// It used to be one of three sources — nine 3DGS captures for the teardown
// (9.93 MB), this for the closing diagram, and a single-capture fallback — and the
// captures were 70% of the transfer, because float gaussian parameters have no
// structure and brotli finds only 7% in them against 46% here. They were also the
// wrong tool for the subject: a four-fold-symmetric machine of chrome, brushed
// aluminium and painted plate is exactly where CAD is the better DATA, and every
// weakness of a capture (specular metal, thin structure, perforation, occluded
// interior) bites at once. So the teardown moved onto these meshes, and the word's
// particles are now sampled off their surface rather than downloaded beside them.

// How many points are sampled off the machine's surface to make the wordmark.
// A desktop budget: alpha-blended overdraw plus a per-frame depth sort. This is no
// longer tied to anything in a file — the particles are generated, so the number
// is a free choice about how fine the lockup's grain should be.
const MAX_SPLATS_DESKTOP = 150000;
const MAX_SPLATS_MOBILE = 40000;

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

// Solid geometry gets its own, far larger budget, because it is not the pass any
// of the above was measured on. Everything in that block is about alpha-blended
// gaussians many layers deep; the CAD is opaque geometry with early-z, one draw
// call a shape — and wherever it owns the frame the splat mesh is not drawn at
// all (see splatsGone). Charging a fill-rate budget to a pass that is not
// fill-bound, in exchange for nothing, is what the desktop number was doing here.
//
// This used to be the CLOSING DIAGRAM's budget, keyed to the `diagram` flag, and
// that is the second half of the bug that left the teardown aliased. Edge quality
// has two levers — sample count and render scale — and both were keyed to a flag
// that does not come up until the last 9% of the page. Fixing only the sample
// count fixed only half of it: the walk still drew at the gaussian budget, which
// on a 1440x900 dpr-2 panel is 0.61x native linear, and no number of samples
// rescues an image the browser then upscales by 1.6x. It is keyed to `solid` now,
// the same threshold the multisampling uses and the same one that stops drawing
// the cloud, so the two levers cannot disagree about which pass they are sizing.
//
// It costs one buffer reallocation FEWER, not one more. The switch used to happen
// at the diagram; it now happens at SOLID_END and the diagram inherits it.
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
// Dropping MSAA instead would be cheaper still and is the wrong trade — it is the
// one that puts the stair-steps back.
//
// It sat at 3.4 Mpx on the strength of the middle rows: 0.81x native on THAT
// panel, giving up 4% of mean gradient magnitude over a detail crop (5.70 ->
// 5.48) for 33% of the frame back. Two things were wrong with reading it that
// way. The panel it was fitted to is the small one — a 1440x900 dpr-2 laptop is
// 5.2 Mpx native, but the 1728x1080 default on a current MacBook is 7.5 Mpx, so
// the same budget lands at 0.67x native there and worse on anything larger, which
// is upscaling by half again. And mean gradient magnitude is the wrong instrument
// for this: it averages over a crop, so it barely moves when a long near-straight
// silhouette breaks into steps — which is the thing you actually see, and the
// thing this machine is made of.
//
// So the ceiling is now roughly native for an ordinary hidpi laptop, and it is
// the GOVERNOR's job to take it back from a device that cannot hold it. That is
// the mechanism that already exists for exactly this, it acts in about a second,
// and its first rung lands at 3.8 Mpx — near enough the old value that a device
// which really did need 3.4 Mpx gets there on its own, with evidence, instead of
// every device being held there on one machine's behalf.
//
// Still a budget rather than "just use devicePixelRatio" for the 4K panel the
// note above was measured on, where native is 12.9 Mpx and no amount of early-z
// makes a million triangles free. Phones are unaffected — they already sit at
// their cap. And the governor rides on top: its rungs land this at 3.8 / 2.7 /
// 2.0 / 1.4 Mpx, and drop the sample count before either.
//
// Those are SQUARES of the rung, not the rung — GOV_DPR scales a device pixel
// ratio and the buffer is two-dimensional. The figures this note used to carry
// (2.9 / 2.4 / 2.0) were the linear ones and overstated every rung.
//
// Resolution is not only the aliasing lever here, which is why it is worth this
// much. The fragment shader's specular antialiasing widens roughness by the
// screen-space VARIANCE of the normal, and variance falls with the square of the
// render scale — so at the gaussian budget that term saturated its own clamp
// across most of the machine and every chrome bearing and brushed plate on the
// teardown was being drawn at plaster roughness. Same number, two defects.
const PIXEL_BUDGET_SOLID = 5_200_000;

// The solid pass may draw ABOVE the device's own pixel ratio and let the browser
// downsample it. That is supersampling, and on an ordinary desktop monitor it is
// the only edge lever left.
//
// `cap` used to be min(devicePixelRatio, 2) for every pass, which reads as "never
// draw pixels the display cannot show". That is right for the gaussian pass and
// wrong for this one, and it quietly made PIXEL_BUDGET_SOLID dead code on the
// commonest display there is. Every number in that block was fitted on hidpi
// laptops -- 1440x900 dpr 2, 1728x1080 dpr 2 -- where `fit` lands UNDER the cap
// and the budget is what binds. On a dpr-1 panel `fit` lands over it, so the cap
// bound instead and the budget never did anything: measured on a 2560x1330 dpr-1
// viewport, the drawing buffer came back 2560x1330, exactly 1.0x, against a
// budget of 5.2 Mpx. That is 1.53x of headroom the code was forbidden to spend,
// on the display class least able to hide a stair-step -- a 27" 1440p panel is
// ~109 ppi against ~220 for the laptops every one of these numbers was fitted on.
//
// Still bounded by the budget, exactly as before, so this cannot run away: it
// raises a CEILING and changes nothing where that ceiling was not the binding
// constraint. 1728x1080 dpr 2 still resolves to 1.67 and 1440x900 dpr 2 still
// resolves to 2.0 -- both unchanged. It moves only where devicePixelRatio was
// doing the binding: 2560x1330 dpr 1 goes 1.0 -> 1.24, 1920x1080 dpr 1 goes
// 1.0 -> 1.59. A 4K dpr-1 panel has `fit` at 0.79, so it stays at 1.0 and gains
// nothing it could not afford anyway.
//
// NOT applied to the gaussian pass. That one is fill-bound alpha blending several
// layers deep, and soft gaussians have no edges to alias -- supersampling them is
// all of the cost and none of the benefit, which is the same fact `antialias:
// false` on the context already turns on. Not on mobile either; it sits at its cap.
//
// And deliberately NOT paired with more MSAA samples. Sample count and render
// scale are two levers on one defect, and the note at PIXEL_BUDGET_SOLID is
// explicit that running both at full tilt is paying twice for one thing.
// MSAA_BY_LEVEL stays at 4, and the governor still spends it before this.
const SSAA_CAP_DESKTOP = 2;

function baseDpr(solid = false) {
  if (typeof window === 'undefined') return 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const small = w < 820;
  const dev = window.devicePixelRatio || 1;
  const cap = small
    ? Math.min(dev, DPR_CAP_MOBILE)
    : solid
      ? SSAA_CAP_DESKTOP
      : Math.min(dev, DPR_CAP_DESKTOP);
  const budget = small
    ? PIXEL_BUDGET_MOBILE
    : solid
      ? PIXEL_BUDGET_SOLID
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
// into the table ate 30% of the page (122vh) while each subassembly got 22vh,
// less than a mouse-wheel flick apiece.
//
// At HERO_VH = 940 (840vh of actual scrolling) this is:
//   word    61vh   the lockup, held readable
//   morph   72vh   lockup -> assembled table (was 122vh; it is one transition,
//                  it does not deserve more room than four subassemblies)
//   table   54vh   the whole machine, before it comes apart
//   walk   468vh   the teardown: eight layers -> 59vh each, half hold, half
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
// ripple. Where that tail ends is what the teardown starts after, and it is also
// where the last particle finishes handing the machine over to its own geometry
// (see SOLID_END).
const MORPH_STAGGER = 0.28;
const MORPH_WINDOW = (SCROLL_SPAN * B_MORPH) / (1 + MORPH_STAGGER);
const MAX_MORPH_DELAY = MORPH_WINDOW * MORPH_STAGGER;
const MORPH_END = MORPH_START + MORPH_WINDOW;

// Model-hold framing. The subject is a table: everything worth showing — the
// playfield, the dealing well, the tiles — is on TOP, so the group pitches
// forward to put the camera ~45 degrees above it. A *negative* pitch here left
// the hero parked under the table looking at its underside and legs.
// Pitch, yaw and fit ride the morph ramp and the turn rides the hold, so all
// four are zero while the word is still readable — the text beat is untouched.
const MODEL_PITCH = 0.75; // rad (~43 deg) of look-down at the playfield
const MODEL_YAW = 0.4; // rad off-axis, so it reads 3/4 rather than flat-on
// Swept across the hold: a drift that shows the table has depth. This was a
// full Math.PI, which spun the machine right past its good side.
const MODEL_TURN = 0.55;
// Half the visible height at the model plane with the camera at rest (z = 10,
// fov 50). The rig dollies IN from here and never out, so sizing travel against
// this is the conservative case: a part that clears the frame at rest clears it
// everywhere. Several beats need it, and it used to be re-derived by hand in a
// comment each time.
const CAM_HALF_H = Math.tan((50 * Math.PI) / 360) * 10;

// Layer walk. Once the word has become the assembled table, the rest of the
// scroll takes it apart a layer at a time: beat k removes layer k and holds
// everything below it seated, so what is on screen is always the real machine
// minus what has already come off.
// Starts after the LAST particle has finished morphing, plus the table beat: the
// morph and the walk used to overlap by a whole morph delay, so the first two
// layers began coming apart while the word was still assembling into the table.
// Separating them also buys the assembled machine a moment of being whole before
// it is taken apart.
const WALK_START = MORPH_END + MAX_MORPH_DELAY + SCROLL_SPAN * B_TABLE;
// The table beat itself, as a span, because two things ramp across it — the
// caption column's reservation and the walk's emphasis — and both want the model
// to have settled before the first caption arrives. Guarded because it is a
// denominator and B_TABLE is editable at the top of the file.
const TABLE_SPAN = Math.max(1e-6, WALK_START - MORPH_END);
// Where the teardown ends and the closing diagram begins. The walk used to run
// to p = 1, which is also why the last layer never got a beat of its own: the
// walk position only reached it at the very last pixel of the page.
const WALK_END = WALK_START + SCROLL_SPAN * B_WALK;
// Fraction of each layer's beat spent on its removal; the rest is a hold where
// the machine sits still and readable.
const WALK_TRANSITION = 0.5;
// Bounds on the fit — the walk's and the finale's, since both run the same
// two-constraint fit against the same clear band. Every beat is fitted to the band
// and the usable width live, so these only stop that fit running away at the
// extremes: the whole assembled table at one end, a 1.1-unit electronics box at
// the other, which at true relative size would be a speck.
//
// The floor was 0.85, from the era when the fit was a constant frame radius that
// under-measured the pitched table by 21%. Fitted honestly the assembled machine
// wants ~0.80, so 0.85 was a clamp that put the near legs back into the bottom
// gradient — the exact overflow the band fit exists to remove. In practice only
// the walk ever reaches down to it; the finale's stack is always the taller
// subject.
const FIT_ZOOM_MIN = 0.75;
// Ceiling on that fit. This used to be 1.5, and the reason was that a bigger
// number meant the two small subassemblies (the control column, the electronics
// box) rescaled the group ~2.9x against their neighbours WHILE they were coming
// apart — far and away the most jarring thing in the walk. The fix then was to cap
// the zoom and accept that the small parts read small.
// FRAME_LAG removes the cause instead: the dolly now runs over a machine that is
// standing still, never over one in motion, so a larger swing costs nothing. The
// cap can go back to framing the part rather than protecting the handoff.
const FIT_ZOOM_MAX = 2.2;
// Share of a beat over which the framing drifts to the next one. Deliberately
// much wider than WALK_TRANSITION: a layer comes off quickly, but a dolly wants to
// be slow, and nothing says the two have to agree. At 0.85 the zoom change is
// spread over ~50vh of scroll instead of ~29vh.
const WALK_FRAME_EASE = 0.85;
// Where that dolly starts, as a share of the beat. WALK_TRANSITION (0.5) is where
// the removal begins, so this releases the camera at the same moment and lets it
// finish well into the next layer's hold. See the framing block in useFrame
// for why it must not run any earlier.
const FRAME_LAG = 0.55;

// ---------------------------------------------------------------- the peel
// How much of the detail channel is dissolving at any one moment, and the
// per-fragment jitter mixed into it.
//
// The band is a trade with one obvious wrong answer on each side: WIDE means most
// of the layer sits at partial alpha at once, which is mottle; NARROW means each
// patch of surface clears cleanly and what you actually see is the ORDER it goes
// in — which is the effect. Kept small for that reason, and the grain is what
// keeps a narrow band from reading as a contour map on the plates whose triangles
// came out uniform.
const PEEL_BAND = 0.16;
const PEEL_GRAIN = 0.22;
// Where the surviving tracery starts to rise, as a share of the removal, and how
// far it goes in frame-heights. Deliberately late: the part has to be properly
// porous before it moves, or an opaque shell drags across the layer it is meant
// to be revealing — a removal that starts travelling while it is still solid
// covers the thing it is supposed to be uncovering for most of the beat.
const PEEL_LIFT_START = 0.55;
const PEEL_LIFT_FRAMES = 0.85;
// The walk's emphasis on the layer that is about to come off. Reuses the
// diagram's EXPOSURE channels, at a fraction of their strength: the hover's own
// acid rim is an interface pointing at something, whereas this is just the eye
// being told where the next move happens. The dim is deliberately light —
// pushing seven layers all the way to CAD_DIM_GAIN, which is what the pointer
// spends, turns the machine into a silhouette.
//
// The rim is deliberately NOT reused, which is why uHot and uAccent are separate
// uniforms. On the walk nothing has been selected and there is no pointer, so an
// acid outline around the next layer is a CAD-viewer selection highlight sitting
// on a product shot — precisely the reading this whole beat is trying to escape.
const WALK_HOT = 0.45;
const WALK_DIM = 0.3;
// How far the emphasis reaches from the front, in beats. Under 1 so a layer is
// never lit and pushed back at once, and wide enough that the handover between
// two neighbours takes most of a removal rather than snapping at the boundary.
const WALK_EMPH_REACH = 0.6;

// What uHot and uDim spend at full strength — the pointer's own amounts, which the
// walk borrows a fraction of through the two constants above. Named here rather
// than buried in CAD_FRAG because they are the same kind of decision as WALK_HOT
// and WALK_DIM and want to be read next to them.
//
// Both are EXPOSURE, which is the only place a highlight or a push-back can be
// applied without lying about the material — see the note where they are spent. A
// third of a stop up, and a shade over two stops down.
const CAD_HOT_GAIN = 1.22;
const CAD_DIM_GAIN = 0.2;
// The dim desaturates on top of that, because exposure alone was not separation
// enough on a layer that is mostly one saturated colour: AgX protects a primary on
// purpose, so the felt stayed the loudest thing on screen two stops down.
const CAD_DIM_DESAT = 0.72;
// Strength of the hover's fresnel rim, added in display space.
const CAD_RIM_GAIN = 0.85;
// Two BRDF limits that happen to share a number and mean different things, which
// is exactly why they are two names. The first is a floor on roughness; the second
// is a ceiling on how much the specular-antialiasing pass may add to it, in
// alpha-squared. See where each is spent in CAD_FRAG.
const CAD_ROUGH_MIN = 0.045;
const CAD_SPEC_AA_MAX = 0.045;

// ------------------------------------------------------------------ finale
// After the last layer the teardown resolves into the reference drawing: every
// subassembly descends from wherever the walk parked it onto its own seat on the
// explode axis, and the whole exploded machine is held as the closing shot.
//
// The seats come from the CAD. cad-layers-index.bin carries each layer's real
// explode offset (the cabinet lifts 3.43 m, the chassis 0.265 m) because the
// cabinet genuinely has to clear everything under it. Taken literally that stack is 17.7
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
// Share of the baked occlusion the DIRECT lights pay. Low here on purpose: the
// diagram pulls the layers 1.8 m apart, so most of what the bake records is
// self-shadowing inside a part that is no longer inside anything.
const CAD_AO_DIRECT = 0.35;

// The same four, for the WALK — and they are a genuinely different lighting
// condition, not a stylistic variant. Everything above was fitted against a
// Cycles render of the EXPLODED stack, seen at FINALE_PITCH (0.34 rad) with its
// layers metres apart in open air. The walk shows the same materials ASSEMBLED,
// close up, at MODEL_PITCH (0.75 rad), which fills the frame with up-facing
// surfaces — and all four LDIR entries have positive Y, so nearly every pixel is
// lit by nearly every light. Measured over model pixels the assembled table ran
// p25 184 / p50 189 / p75 197: a thirteen-code interquartile spread against the
// finale's ninety-three. Not a dark picture with the wrong mean, a picture with
// no range in it at all — the deck read as a flat plate of paint.
//
// So these open the RANGE rather than move the level, and in the order they
// matter. The direct AO share is the one that reopens the shadows: spending only
// a third of the bake on direct light switches off the one channel that can put a
// contact shadow under the rings, on the beat where direct light is the whole
// image. Ambient is a near-constant pedestal — at 0.28 it alone puts a 0.6-albedo
// grey at 172/255 before a single lamp is counted, which is a floor the frame can
// never get below. Exposure moves least, because it is not the problem: measured,
// lowering it makes the paints MORE saturated, since AgX's chroma rolloff only
// engages once a channel is up its curve. Saturation is fixed at the palette
// instead (see the paint grade in parseCadLayers).
//
// Guesses fitted by eye against the same statistic, not against a render: there
// is no Cycles frame of the assembled machine at this pitch to match to. Making
// one is the right next move, and until then the finale's numbers are the ones
// with authority — which is why the crossfade below is exact at fe = 1.
const WALK_EXPOSURE = 6.0;
const WALK_AMBIENT = 0.16;
// (uAo and uAoDirect below.)
//
// ---------------------------------------------------------------- the accent
// The site's one loud colour, in the three spaces this scene needs it in. Kept as
// one declaration because three spellings of one colour is three chances for it to
// drift apart, and it had: the same #c6ff00 was written as a hex string in the
// particle palette, as display floats in the hover rim and as linear floats in the
// paint grade.
//
// Which space a use wants is not a style choice. ACCENT_LINEAR is scene radiance,
// for anything that will be tone-mapped — the felt's albedo. ACCENT_SRGB is
// display-referred, for anything added AFTER the view transform: the hover rim is
// an interface pointing at something, not light, and pushing it through AgX would
// drag it toward white and land it as a wash instead of an edge.
const ACCENT_HEX = '#c6ff00';
const ACCENT_SRGB: readonly [number, number, number] = [0.776, 1.0, 0.0];
const ACCENT_LINEAR: readonly [number, number, number] = [0.5647, 1.0, 0.0];

// Full strength, unlike the diagram's 0.85. The bake is physically complete and
// the walk is the condition it actually describes: a machine with its layers
// stacked inside each other, where the occlusion between them is real.
const WALK_AO = 1.0;
const WALK_AO_DIRECT = 0.75;
const FINALE_STAGGER = 0.55; // share of the beat spent on the bottom-up landing
const FINALE_PITCH = 0.34; // rad — flatter than the walk, so the stack separates
const FINALE_TURN = 0.45; // rad of extra yaw across the beat
// -------------------------------------------------------------- the frame
// The clear band and the margin the subject is fitted into. Named for the frame
// rather than for a beat because BOTH the walk and the finale fit to them: they
// were the finale's alone, on the belief that the walk's subjects were centred and
// no taller than the clear middle, and they are not.
//
// Share of the clear band the subject fills. It can sit this high because the band
// itself already holds the whole safety margin — doubling up just left the closing
// shot small in a mostly empty frame.
const FIT_MARGIN = 0.95;
// The sticky canvas is not all usable. A fixed 7rem gradient (plus the nav) caps
// the top and a fixed 8rem one caps the bottom — see the vignette element — and
// anything under them is invisible whatever the frustum says. At MODEL_PITCH the
// assembled table projects 3.15 units of half-height, and fitting it to the raw
// frustum ran its near legs into the bottom gradient. In px, because that is what
// the gradients are authored in.
const BAND_TOP = 112;
const BAND_BOTTOM = 128;
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
// Where the closing diagram takes the frame over, as a share of the finale, and
// all this now decides is when the canvas switches to the diagram's much larger
// pixel budget. The particles it used to cross-dissolve against are long gone by
// here — they hand over to the mesh at SOLID_END, at the end of the MORPH — so
// this is a threshold on cost, not on the picture. It stays well clear of the one
// that switches back, because flipping it resizes the drawing buffer.
//
// The diagram used to be drawn from the gaussians themselves, which meant the
// closing frame carried all eight captures at once — ~290k splats, by far the most
// expensive frame in the hero, and it needed a whole mip-style LOD (inflate the
// gaussians, thin the count, conserve the ink) just to be affordable. Drawing it
// from CAD deletes that problem rather than managing it: one draw call a shape, on
// the one beat where the cloud is not drawn at all.
const FINALE_HANDOVER = 0.42;

// Share of the morph beat over which the particles hand the machine over to its
// own geometry. The word's dust flies to points sampled ON the CAD surface, so at
// the moment of handover the two are in register to within a particle's width and
// the swap reads as the dust SOLIDIFYING rather than as a cross-fade of two
// different objects. Runs to the end of the morph's stagger tail, so the mesh is
// fully up only once the last particle has landed.
const MORPH_SOLIDIFY = 0.45;
const SOLID_START = MORPH_START + (MORPH_END - MORPH_START) * (1 - MORPH_SOLIDIFY);
const SOLID_END = MORPH_END + MAX_MORPH_DELAY;

// Where the landing finishes. Everything past this is the hold beat, and the
// distinction has to be explicit: `fe` used to be measured against the end of the
// PAGE, so adding a hold beat would silently have stretched a 65vh landing into a
// 185vh one instead of leaving the diagram alone at the end of it.
const FINALE_END = WALK_END + SCROLL_SPAN * B_FINALE;

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
// What the wordmark must stay clear of, in CSS px off each edge of the viewport.
// The top is the fixed nav plus its own gradient; the bottom is the hero copy
// block, which is bottom-anchored (pb-16/pb-20) and runs eyebrow, subtitle, then
// the scroll cue and its rule. Authored in px because the overlays are, and
// generous at the bottom on purpose — the CJK lockup's secondary line is set
// larger than the latin one, so the case that collides first is the one whose copy
// is also tallest.
const LOCKUP_BAND_TOP = 96;
const LOCKUP_BAND_BOTTOM = 248;

// How fast an abandoned orbit unwinds, and how fast the orbit itself follows the
// pointer. Dampings per second, not per frame — see damp(). The isolation blend
// used to be one of these and is no longer; it is a spring, for the reasons at
// FOCUS_OMEGA below.
const FOCUS_RATE = 6;
const ORBIT_RATE = 9;
// How the FRAMING travels when the subject changes — the click that opens a part,
// and every step through the stack after it. A critically damped spring rather
// than the exponential the rest of the isolation runs on, and the difference is
// most of what was wrong with stepping between parts.
//
// The parts differ by 3x in radius and sit metres apart on the explode axis, so a
// step is a real camera move: rescale, and travel. Run on damp() that move began
// at its maximum speed on the frame the wheel fired and ended on a half-second
// creep — it lurched off the old part and oozed onto the new one. A spring leaves
// from rest and settles, and it carries velocity through a target change, so
// stepping twice quickly flows through the second part instead of stopping dead
// at the first and starting again.
const FOCUS_OMEGA = 9; // rad/s, critically damped: settles in ~0.65s
// ---------------------------------------------------------------- the swap
// Changing which part is isolated is a DISSOLVE, not a cross-fade.
//
// It was a cross-fade: the outgoing part's alpha ran 1 -> 0 while the incoming
// one ran 0 -> 1 on the same exponential, so the middle of every step was two
// half-transparent machines lying on top of each other, and neither of them was
// the thing you were trying to look at.
//
// The page already owns a better answer and spends 468vh establishing it — the
// teardown's per-fragment dissolve, which evaporates SURFACES while the detail
// channel holds, so a part opens into a tracery of its own edges on the way out.
// Driving the isolation through that same uniform needs no new shader, no new
// material, no new pass and no new state beyond one number per layer, and it means
// stepping through the stack is spoken in the same language as the teardown that
// got you to it.
const SWAP_S = 0.38; // seconds for one layer to evaporate, or to re-form
// How much of the outgoing part may still be standing when the incoming one starts
// forming. SEQUENCED rather than simultaneous — that is what stops it collapsing
// back into a cross-fade — but overlapped, because a gap between the two reads as
// a blink.
//
// The lead is short, and the number was arrived at by arithmetic rather than by
// taste, because it decides how EMPTY the middle of a step gets. The two dissolves
// travel the same range in opposite directions, so they cross at (1 + this) / 2 —
// and since the shader discards in proportion to the sweep, that crossing value is
// what fraction of each part has evaporated at the thinnest moment of the frame.
//
//   lead 0.55 (tried first): cross at 0.89 —  11% of each part left,  22% total
//   lead 0.25 (this):        cross at 0.70 —  30% of each part left,  60% total
//
// Traced at 0.55 and the frame really did go nearly empty for 60ms in the middle of
// every step, which is a blink, not a transition. At 0.25 the outgoing part still
// visibly leads — six frames of it alone before the new one draws a triangle, which
// is what says "this one is going" before "this one is coming" — and the crossing
// holds two thirds of a machine's worth of edges.
//
// Two dissolves at 70% is nothing like the cross-fade this replaced. A dissolve
// leaves opaque, correctly depth-sorted fragments and takes the rest away; an alpha
// at the same number leaves you looking through both parts at once.
const SWAP_HANDOFF = 0.75;
// The breath. A step is a camera changing subject, and a camera that changes
// subject widens, travels, and closes again — so the isolation framing relaxes
// this far back toward the whole-diagram fit while the swap is in flight and takes
// it back as the new part settles. Deliberately small: enough that the move reads
// as a move, not enough to show the rest of the stack, which is the thing the
// isolation exists to get out of the way.
const SWAP_PULL = 0.13;
// And it turns, slightly, the way you stepped. ~4.6 degrees out and back, under a
// tenth of what a drag of the same duration would do. It is the only part of the
// step that says WHICH DIRECTION you went — without it, forward and back are the
// same picture — and a few degrees of yaw against a lit metal part is also the
// cheapest parallax there is.
const SWAP_SWING = 0.08; // radians
// The envelope both of those ride. A spring chasing a square pulse: it rises while
// the swap is in flight and decays after it, so the widen-and-turn peaks near the
// middle of the move and is gone by the time the new part is solid. A spring
// rather than a sin() over an explicit clock because it is re-entrant for free —
// stepping again mid-swap extends the pulse and reverses the turn smoothly, where
// a clock would have to be reset and would snap.
const SWAP_OMEGA = 8;
// Ceiling on the focus zoom, as a MULTIPLE of the whole-diagram framing rather
// than an absolute scale. The layers differ by 3x in radius (the cabinet is the
// whole table, the electronics box is a third of it), so an absolute cap would
// either crop the big ones or leave the small ones tiny — and it would silently
// mean something different the first time FINALE_SPAN or the CAD bounds change.
//
// It is a BACKSTOP, not the framing. The real framing is the geometric term it is
// min()'d against — the layer's bounding sphere fitted into the clear band — and
// at 3 this backstop was overriding it on exactly the parts that most needed the
// magnification: measured against the current bounds, the electronics box wanted
// 3.7 and was held to 2.2, so opening the smallest subassembly in the machine
// filled a third of the frame it could have filled. The big layers were always
// bound by the geometric term and are unaffected. Raised until the geometry wins
// for every layer, which is what "fit the part to the frame" should have meant.
const FOCUS_GAIN_MAX = 5;
// How far the isolated part is allowed to overflow its own bounding sphere.
//
// The sphere is what makes the framing rotation-invariant — see ORBIT_PITCH_MAX —
// but it is a loose bound for everything in this machine, because every layer is a
// flat plate or a stack of discs and none of them come close to filling the sphere
// that contains them. Fitted strictly, the electronics box measured 361 px into a
// 560 px band: two thirds of the frame it had, on the beat whose entire purpose is
// looking closely at one part.
//
// So the sphere is allowed past the band by this much. What it costs is the strict
// guarantee, and what it buys back is that the guarantee was never doing any work:
// no layer's real geometry reaches its sphere in the first place, so overflowing
// the sphere by 40% still leaves the part itself comfortably inside the frame — at
// every yaw, which is the property that mattered. Keep it modest for the layer that
// comes closest to spherical (the centre column) rather than tuning it to the
// flattest one.
const FOCUS_FILL = 1.4;
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
// trackpad emits a stream of small ones for a single flick.
//
// The cooldown alone was NOT enough to stop that flick racing through the stack,
// and the way it failed is worth keeping written down. Deltas went on being
// banked into the accumulator while the cooldown was refusing to act on them, so
// a flick arrived at the far side of every cooldown already over the threshold
// and stepped again immediately. The cooldown was rate-limiting the steps and
// doing nothing at all about how many there would be: one flick walked 01 to 06.
//
// The fix is that HOW MUCH delta arrived cannot distinguish a deliberate second
// step from the tail of the first — a trackpad keeps emitting for up to a second
// after the fingers lift, and the tail is easily worth several thresholds. A GAP
// can: putting the fingers down again, or a fresh wheel notch, always shows up as
// a pause in the stream. So a quiet gap ends the gesture, and within one gesture
// the second and later steps cost several times the first.
const CYCLE_WHEEL = 90; // accumulated deltaY for the FIRST step of a gesture
// What every step after it costs while the stream never pauses. Deliberately
// steep: this is the number a momentum tail has to pay, and paying it once is
// about as much as the strongest flick can manage. A held two-finger drag still
// walks the stack, just at a rate a person can read.
const CYCLE_WHEEL_REPEAT = 520;
// Quiet that ends a gesture. Above the ~16 ms a trackpad streams at and above a
// deliberate wheel notch's own spacing, below the gap between two separate
// flicks.
const CYCLE_GESTURE_GAP_MS = 140;
const CYCLE_SWIPE = 60; // px of vertical drag for one step
// Long enough that the outgoing part is gone and the incoming one is well into
// forming before another step can be asked for. It is NOT the full length of a
// swap (SWAP_S plus its handoff lead, ~0.63s): the swap is re-entrant by
// construction, so a visitor who genuinely wants to move two parts should be able
// to, and holding the wheel hostage for two thirds of a second to enforce a
// transition they can already see reads as the page being stuck.
const CYCLE_COOLDOWN_MS = 420;
// The end of the finale on the axis the spring works in (`smooth` — progress with
// the intro's fixed share divided back out), which is what the camera dolly and
// anything else driven off the spring rather than off `p` has to stop at.
const DOLLY_END = (FINALE_END - ASSEMBLE_END) / SCROLL_SPAN;
// How much raw scroll the SKIP control fades over, ending exactly at DOLLY_END.
// Progress and raw scroll differ by a constant factor that the beat shares cancel,
// so a beat's share IS its width on the raw axis — this is the whole landing:
// full strength through the teardown it offers an escape from, and gone by the
// time the diagram is finished and the prompt to point at it arrives.
const SKIP_FADE = B_FINALE;
// Backstop on the leash bypass a SKIP opens. Not a duration the ride is expected
// to take — the bypass is held until the page actually ARRIVES, because a 940vh
// smooth scroll outlasts any timeout worth having on a slow device. This only
// closes a bypass whose ride the visitor interrupted, so it never arrives at all.
const SKIP_BYPASS_MS = 4000;
// Where the centred hero copy fades, on that same raw axis. It holds through the
// whole word beat, goes over the morph, and is gone the frame the first stage
// caption arrives — which is the point of deriving it rather than picking a
// slope. The two are different typographic systems on different justifications
// and they must never be on screen together.
const COPY_FADE_START = B_WORD;
const COPY_FADE_END = (MORPH_END - ASSEMBLE_END) / SCROLL_SPAN;

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
// Zero VELOCITY and zero ACCELERATION at both ends, where smoothstep only zeroes
// the velocity. Used where the eye is watching one thing travel the whole way and
// has time to notice the kick at the start — the isolation dissolve is the case,
// because a dissolve front is a spatial edge sweeping a surface and any jerk in it
// is legible as the edge itself changing speed.
function smootherstep(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// A subject's half-height ON SCREEN under a pitch: its own height foreshortened by
// the tilt, plus the share of its plan extent the tilt swings into vertical. Both
// beats that fit to the clear band need it and both used to write it out — the
// walk at MODEL_PITCH against its plan half-extent, the finale at FINALE_PITCH
// against its layer radius. It is the one measurement that has to be right or the
// fit is wrong: at MODEL_PITCH the assembled table is 1.98 units of true half
// height and 3.15 of projected, so taking max(plan, y) instead under-measures it
// by 21% and runs the near legs off the bottom of the frame.
function screenHalfH(yHalf: number, planHalf: number, cosP: number, sinP: number) {
  return yHalf * cosP + planHalf * sinP;
}

// Frame-rate-independent exponential approach. `lerp(x, target, 0.08)` per
// frame is not a speed, it is a speed per FRAME: the same code converges twice
// as fast on a 120Hz display as on a 60Hz one and crawls on a 30Hz one, so the
// hero's feel changed with whatever monitor it landed on. Rate is per second.
function damp(x: number, target: number, rate: number, dt: number, eps = 1e-4) {
  const v = target + (x - target) * Math.exp(-rate * dt);
  // ARRIVE, rather than approach forever. An exponential never reaches its
  // target: at rate 6 and a 60Hz frame it closes 9% of the remaining gap each
  // frame, so it is still moving in the twelfth decimal place minutes later.
  // Nothing can see that, but the idle-frame check downstream is exact — it
  // asks whether this frame's scene is the same as last frame's — and a value
  // that never stops changing means a diagram nobody is touching re-renders a
  // million triangles forever. Everything damped here is either radians or
  // world units where 1 unit is about 100 px, so the default is well under a
  // hundredth of a pixel.
  //
  // `eps` is there because one caller's units are not another's and the tail of an
  // exponential is long enough for the difference to be seconds — see the camera
  // rig, where the same 1e-4 was three seconds of settling for a tenth of a pixel
  // of travel. Raising it does not change how anything MOVES, only when it admits
  // it has stopped.
  return Math.abs(v - target) < eps ? target : v;
}

// The remaining error a spring is allowed to give up on. Everything sprung here is
// either a 0..1 blend or a world length, and at the isolated framing one world unit
// is a few hundred pixels — so this is a fifth of a pixel of travel STILL TO COME,
// which is the honest bound, because a critically damped spring's remaining error
// is also the furthest it can still move.
//
// It is twenty times damp()'s, and the difference is worth the line. An exponential
// approach at rate 6 is inside 1e-4 of its target in about 1.6s; a spring's tail is
// (1 + wt)e^-wt, which at w = 9 takes 1.5s to reach 1e-4 but only 0.94s to reach
// this — and every frame of that difference is a frame the idle check sees as
// motion and re-renders 250k triangles for. Measured on one step through the stack:
// the visible move is over in 0.64s and the old threshold went on drawing for 1.70s.
const SPRING_EPS = 2e-3;
type Spring = { x: number; v: number };
// Critically damped spring — the same semi-implicit integrator driveScroll uses,
// which is unconditionally stable and cannot overshoot. `s` carries the position
// and its velocity; the return is the new position.
//
// Where damp() is right for a value chasing something that moves every frame (the
// pointer, the hover), this is right for a value sent to a NEW REST STATE: damp's
// velocity is maximum on the frame the target changes and only ever decays, so it
// leaves at a jerk and arrives on an infinite creep. A spring starts from rest,
// accelerates into the move and decelerates out of it, and — the part that matters
// when a visitor steps twice quickly — it carries the velocity it already had
// through the new target instead of stopping dead and starting again.
function spring(s: Spring, target: number, w: number, dt: number) {
  const h = Math.min(dt, 0.05);
  s.v = (s.v - w * w * h * (s.x - target)) / (1 + 2 * w * h + w * w * h * h);
  s.x += h * s.v;
  // ARRIVE, for exactly the reason damp() does: the idle check downstream is an
  // exact comparison of this frame's scene against the last one, and a spring still
  // settling in the fourth decimal place re-renders a million triangles for nothing.
  // Both terms are required. From rest a critical spring cannot overshoot, so being
  // near the target would be enough — but a target CHANGED mid-flight leaves it
  // carrying velocity, and then near-the-target can be a crossing at speed rather
  // than an arrival. The velocity bound is the speed that would carry it one more
  // epsilon in a time constant.
  if (Math.abs(s.x - target) < SPRING_EPS && Math.abs(s.v) < SPRING_EPS * w) {
    s.x = target;
    s.v = 0;
  }
  return s.x;
}

// One critically damped spring drives the whole scene's scroll. Two independent
// lerps (the cloud at 0.08, the camera at 0.05) meant the camera's zoom always
// trailed the model it was framing — worse the faster you scrolled. A spring
// also beats an exponential here: it carries scroll velocity through, so a fast
// flick keeps moving into the settle instead of decelerating the moment your
// finger stops.
const SCROLL_OMEGA = 11; // rad/s

// ------------------------------------------------------------------- pacing
// The walk is eight layers over 468vh, so one layer's beat is ~59vh — well over
// half a viewport, and the half of THAT which holds the removal is ~29vh. A
// trackpad fling covers two or three beats before the finger has left the glass,
// and because the scene was a pure function of scroll position, "three beats in
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
//                one layer rather than queueing five.
//
// Neither alone is enough. The limit without the leash means the page runs away
// from the scene and the two disagree for the rest of the hero; the leash
// without the limit just replays the same too-fast handoff one beat at a time.
//
// Must match nLayer in cad-layers-index.bin, which is the authority: the walk
// block in useFrame divides the same span by cad.length, so this number decides
// only where the DETENTS are. That is not a detuning, it is a correctness
// requirement — it was 9 against 8 real layers, so the first three detents a
// visitor hit landed at 87%, 58% and 26% through a removal and parked the page
// on a half-dissolved cabinet hanging in the air, which is exactly the state
// 138826a exists to make unreachable. Every consumer below quantises to 1/this:
// paceLimit's phase, the leash's ceiling and floor, snapBeat's clamp, and the
// rest the scroll handler re-reads on every gesture. The walk useMemo warns in
// development if the file disagrees.
const WALK_LAYERS = 8;
// WALK_START and WALK_END again, on the axis the spring works in: `smooth`, which
// is progress with the intro's fixed share divided back out (see the `p` line in
// useFrame). The scene reads the pair above; everything that has to bound or snap
// SCROLL reads this pair, because that is the quantity the spring is chasing.
const WALK_S0 = (WALK_START - ASSEMBLE_END) / SCROLL_SPAN;
const WALK_S1 = (WALK_END - ASSEMBLE_END) / SCROLL_SPAN;
const WALK_BEAT = (WALK_S1 - WALK_S0) / WALK_LAYERS;
// Seconds the scene needs to cross each half of a beat at full tilt. Split,
// because the two halves are not the same thing to look at: the handoff is where
// the dissolve and the lift live and it gets the time, while the hold is a seated
// machine with the tail of the previous dolly still running over it and may be
// crossed faster — but not instantly, or that dolly snaps.
//
// These were 1.2 and 0.45, and the walk was reported as feeling HEAVY to scroll.
// It was, and by more than the constants admit. What a visitor actually experiences
// is not "1.65s per beat", it is the whole round trip from flicking to the page
// being willing to move again — the flick's own event stream, the leash holding
// scroll at one beat ahead of the scene, the scene crossing that beat at this
// limit, SNAP_DELAY_MS of quiet, the snap, and the spring settling onto the
// boundary. Measured end to end by watching for the idle skip to go quiet again
// (real GPU, eight consecutive flicks at the first walk holds): a median of
// 3833 ms per flick, so about 31 SECONDS of waiting to get through eight layers.
//
// More than halved: 0.78s a beat against 1.65s. The floor on the handoff is what
// the REMOVAL needs in order to read — the dissolve and the lift are the one thing
// on this beat worth watching — and 0.6s is comfortably above the 0.46s the stack
// swap dissolves in, which reads cleanly. The hold has no such floor; it is a still
// machine, and only the tail of the previous dolly crossing it stops this being
// zero.
//
// The felt wait is not this number and is what was actually checked: tracking the
// MODEL'S OWN world matrix after a flick, so the question is when the PICTURE
// stops rather than when the page stops drawing. Median over six flicks at the
// early walk holds, real GPU: 1999 ms before, 1317 ms here.
//
// 0.5/0.15 was tried and gave 1384 ms — no better, and inside the noise. That is
// worth writing down, because it says the limit has stopped being what binds. What
// is left is the flick's own event stream (~310 ms), SNAP_DELAY_MS, the scroll
// spring's own settle, and the dolly behind it; cutting this further just buys a
// less readable removal for nothing. See the camera rig for the piece of that
// chain which turned out to be worth two seconds.
const PACE_HANDOFF_S = 0.6;
const PACE_HOLD_S = 0.18;
const PACE_V_HANDOFF = (WALK_BEAT * WALK_TRANSITION) / PACE_HANDOFF_S;
const PACE_V_HOLD = (WALK_BEAT * (1 - WALK_TRANSITION)) / PACE_HOLD_S;
// The LANDING is a beat too, and treating it as one is the fix for the last thing
// you could scroll straight through. It was outside the walk, so the leash opened
// to the whole page and the speed limit went to PACE_FREE the instant the scene
// reached WALK_S1 — and one flick from the last teardown hold cleared the landing
// AND the 143vh hold beat behind it. Measured before this change: from the beat-08
// hold at 78.0% of the hero, one 1000px flick landed at 95.0%, so the closing
// diagram assembled and the belt view arrived somewhere inside a single gesture
// nobody was watching, and the next flick left the hero entirely.
//
// So the beat axis gets a ninth entry. It is not WALK_BEAT wide — the landing is
// its own share of the page — which is why beatOf and scrollOfBeat below are
// piecewise rather than one multiply.
const FINALE_BEAT = WALK_LAYERS + 1;
// Seconds to cross it at full tilt. Still the slowest beat on the page and
// deliberately so — eight layers flying back to their seats on a bottom-up stagger
// is the largest single move in the hero, and this is the beat the detent above
// exists to make sure anyone sees at all. But it has to stay in proportion to the
// walk that leads into it: at 1.4s against a beat that now crosses in 0.78s it was
// the one place the page went heavy again, right after it had stopped being.
const PACE_FINALE_S = 1.0;
const PACE_V_FINALE = (DOLLY_END - WALK_S1) / PACE_FINALE_S;
// Outside the walk and the landing: a sanity bound the spring never reaches (its
// own peak speed across a full-page error is ~1.4/s). The word and the morph are
// each one continuous beat where scrubbing fast is still legible, and the hold beat
// is a room the page walks you through on the way out rather than a beat at all.
const PACE_FREE = 4;
// Phase width of the ramp between the two limits, so the follow speed eases
// between them instead of stepping.
const PACE_RAMP = 0.08;
// How far scroll may lead (or trail) the scene inside the walk, in beats. One:
// a fling commits to the layer in front of you and no further.
const LEASH_BEATS = 1;
// Fraction of a beat you have to move before releasing commits to the next
// layer instead of returning to the one you were on. Small on purpose — one
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

// Position in beats, and back. Whole numbers are the readable stills: the eight
// layer holds, and then the landed diagram at FINALE_BEAT.
//
// Piecewise, because the ninth beat is a different width from the other eight —
// the walk is B_WALK split eight ways and the landing is B_FINALE whole. The two
// pieces meet at exactly b = WALK_LAYERS, and the pair are exact inverses on both
// sides of it. Deliberately NOT clamped at the top: past the landing this keeps
// counting in landing-widths, and the leash reads that as "well past the last
// detent" rather than having to special-case it twice.
function beatOf(s: number) {
  if (s <= WALK_S1) return (s - WALK_S0) / WALK_BEAT;
  return WALK_LAYERS + (s - WALK_S1) / Math.max(1e-9, DOLLY_END - WALK_S1);
}
function scrollOfBeat(b: number) {
  if (b <= WALK_LAYERS) return WALK_S0 + b * WALK_BEAT;
  return WALK_S1 + (b - WALK_LAYERS) * (DOLLY_END - WALK_S1);
}

// Speed limit at a point on the scroll axis, in progress per second.
function paceLimit(s: number) {
  if (s <= WALK_S0 || s >= DOLLY_END) return PACE_FREE;
  // The landing is one beat and is crossed at one speed — there is no hold half
  // and handoff half to it, the whole thing is the move. The step up from the
  // walk's handoff limit at this boundary is about 2x; it used to be 138x, which
  // is what PACE_FREE works out to here.
  if (s >= WALK_S1) return PACE_V_FINALE;
  // Phase inside the current layer's beat, sliced exactly the way the walk
  // block slices `raw`: the hold is the first (1 - WALK_TRANSITION), the handoff
  // is the rest and runs to the end of the beat.
  const u = (s - WALK_S0) / WALK_BEAT;
  const phase = u % 1;
  const rise = smoothstep(
    clamp01((phase - (1 - WALK_TRANSITION) + PACE_RAMP) / (2 * PACE_RAMP))
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
// page stops at the first hold instead of landing in the middle of the teardown
// with eight beats queued behind it.
//
// Both edges land on HOLDS, not on "one beat from wherever the scene happens to
// be". An unquantised window preserved whatever phase you came to rest at: stop
// once with the cabinet half evaporated and every flick after it left you half
// dissolved again, one layer further along, because the window carried the
// offset forward. Quantised, the window is the pair of readable stills either
// side of the scene, and the walk cannot drift off them.
function leashCeil(scene: number) {
  const b = beatOf(Math.max(scene, WALK_S0));
  // Once the landing has ARRIVED there is nothing left to hold anyone to. The hold
  // beat is 143vh of constant scene — a room the page walks you through so the
  // diagram gets a moment of sitting still before you point at it — and detenting
  // inside it would only make leaving the hero feel like being let out.
  if (b >= FINALE_BEAT - BEAT_EPS) return 1;
  // Never past the landing in one gesture, whichever beat you set off from. The
  // min() is what stops a flick that starts mid-landing from carrying on out of
  // the hero, which is the same failure one beat further along.
  return Math.min(
    1,
    scrollOfBeat(Math.min(FINALE_BEAT, Math.floor(b + BEAT_EPS) + LEASH_BEATS))
  );
}
function leashFloor(scene: number) {
  if (scene <= WALK_S0) return 0;
  // From inside the hold beat, back is the landing's own end — and since the scene
  // is identical everywhere in the hold beat, the first thing a backward gesture
  // can actually CHANGE is the layer hold below it. Clamping to FINALE_BEAT is what
  // makes that one step rather than one landing-width.
  const b = Math.min(beatOf(scene), FINALE_BEAT);
  return Math.max(0, scrollOfBeat(Math.ceil(b - BEAT_EPS) - LEASH_BEATS));
}

// Where a release should land, given where scroll got to and which hold it left.
// `from` is the hold the gesture started on; a move of SNAP_TRIGGER in either
// direction commits to the neighbouring one, anything less returns. One step per
// release, so this can never skip a layer however far the gesture went — the
// leash has already bounded that anyway.
function snapBeat(s: number, from: number | null) {
  const b = beatOf(s);
  const hold = (n: number) => Math.min(FINALE_BEAT, Math.max(0, n));
  // No origin worth stepping from — the walk was entered from the table beat
  // above it, or a jump the leash let through re-seated the scene. Land on the
  // nearest hold instead, so arriving at the assembled table does not immediately
  // step off it.
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

// How close the scroll spring has to get before it gives up and lands exactly.
//
// Stated where it can be checked: one walk beat is 0.0696 of this axis and moves
// the model about a frame height, so progress converts to screen at roughly
// 12,900 px per unit — which makes this a fifth of a pixel of travel still to come.
// A critically damped spring's remaining error is also the furthest it can still
// move, so that is the whole of what is being given up.
//
// It was 1e-6 — a hundredth of a pixel, which is nothing this page can spend.
//
// Honesty about why it was changed: it was changed on a WRONG diagnosis and kept
// on its own merits. The page draws for 1.7s after the picture has stopped, and
// this looked like the cause; raising it measured no improvement at all, because
// the actual culprit was the camera dolly damping at rate 3 (see CameraRig). The
// threshold is still indefensible at 1e-6 and is still the right value here, but it
// bought nothing on its own and should not be credited with anything.
//
// Same reasoning as SPRING_EPS, one axis up. damp() has its own at 1e-4.
const SCROLL_ARRIVE = 1.5e-5;

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
  if (Math.abs(d.p - target) < SCROLL_ARRIVE && Math.abs(d.v) < SCROLL_ARRIVE * 10) {
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

    ctx.fillStyle = ACCENT_HEX;
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

// The word's dust, sampled off the machine's surface. Isotropic on purpose: both
// ends of the morph are round — a text dot and a surface sample at the cloud's own
// mean spacing — so one radius describes each particle and there is no orientation
// to carry. A 3DGS capture needed a full ellipsoid here; nothing downloads one any
// more, and the shader's covariance is a scalar because of it.
type ModelSource = {
  count: number;
  pos: Float32Array; // xyz
  radius: Float32Array; // world units
  // rgb 0..1, DISPLAY-referred: shaded and sRGB-encoded at sample time, because
  // the splat shader writes what it is given straight to the drawing buffer.
  color: Float32Array;
  opacity: Float32Array;
};

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
  // nothing to vary between its shapes. Two VARIANTS of it, differing only in
  // whether the dissolve is compiled in, sharing one uniforms object — so
  // `material.uniforms` is still the single place the frame loop writes, whichever
  // is bound. See cadMaterials.
  material: THREE.RawShaderMaterial;
  peelMaterial: THREE.RawShaderMaterial;
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
  alpha: number; // 0..1 drawn-at-all gate, derived from `dis` below
  // How evaporated this layer is for the ISOLATION, 0 formed to 1 gone. Fed into
  // the same uPeel the teardown sweeps, and moved at a fixed rate rather than
  // damped so it lands exactly and in a bounded time. See the SWAP_* constants.
  dis: number;
};

// --------------------------------------------------- the shared shading numbers
// The light rig, the sky and the view transform, kept as NUMBERS rather than as
// GLSL text, because two different machines now evaluate them: the fragment
// shader below, and the CPU pass that shades the word's particles (see
// sampleCadSurface). Those two are REQUIRED to agree — the premise of the morph is
// that the dust and the mesh are the same picture of the same object, so a
// divergence between them is not a small colour error, it is the beat failing —
// and the only way to guarantee it is for the shader's own declarations to be
// built out of the same constants the JS reads. They are, a few lines down.
//
// The rig was read out of the blend and converted into render-world directions.
// Blender is z-up and the render world applies (x, y, z) -> (x, z, -y), so these
// are the normalised directions from the machine's centre toward each light after
// that swap. Intensities are relative irradiance, P / d^2, with the key at 1.
//
//   L_Key   area 1.5 m   210 W  at (-1.439, -1.689, 1.453)   front left, high
//   L_Fill  area 2.6 m    38 W  at ( 1.814, -1.126, 0.515)   front right, low
//   L_Rim   area 1.4 m    95 W  at ( 0.188,  1.876, 1.015)   behind, high
//
// The lights are DIRECTIONAL, not positional. Cycles rendered each layer at its
// true seat; the diagram pulls the layers 1.8 m apart along the explode axis, and
// point lights over that span would light the cabinet at the top visibly
// differently from the electronics box at the bottom. A diagram wants one
// consistent read.
//
// The blend's fourth rig (LIB_*, off in the material-library corner of the same
// scene) contributes about a fifth of the key from the far side; it is folded in
// as the last entry rather than dropped, because the reference renders do include
// it.
const LDIR: readonly (readonly [number, number, number])[] = [
  [-0.5617, 0.4995, 0.6592], // key
  [0.8387, 0.1595, 0.5205], // fill
  [0.091, 0.409, -0.908], // rim
  [0.4724, 0.6169, 0.6295], // the library rig, folded into one term
];
const LPOW: readonly number[] = [1.0, 0.253, 0.697, 0.197];
// Each light's angular half-size at the machine, which is what turns a point
// highlight into the broad soft gradient the reference shows on the aluminium
// legs. Specular only, so the particle pass never reads it.
const LRAD: readonly number[] = [0.146, 0.301, 0.169, 0.212];

// The blend's world is a Nishita sky at 0.13 strength with the sun 28 degrees up
// — a cool zenith over a warmer horizon, with nothing below because the studio
// floor is hidden for these renders. A three-stop gradient reproduces the part of
// that which a 60 px part can actually show.
const SKY_ZENITH: readonly [number, number, number] = [0.38, 0.47, 0.68];
const SKY_HORIZON: readonly [number, number, number] = [0.52, 0.52, 0.52];
const SKY_GROUND: readonly [number, number, number] = [0.07, 0.07, 0.08];
// Diffuse irradiance from that gradient is a cosine-weighted integral over the
// whole hemisphere, and this is the cheap stand-in for it: the gradient sampled in
// the normal's own direction, mixed with a flat zenith term. This is the mix, and
// it has to be one number because two machines evaluate it — CAD_FRAG for the mesh
// and sampleCadSurface for the particles — and they are required to agree.
const SKY_ZENITH_SHARE = 0.4;

// AgX, as Blender applies it. This is the single biggest reason the first pass
// looked wrong: the blend renders through AgX with the Medium High Contrast look,
// and encoding linear radiance with pow(1/2.2) instead is nothing like it. AgX
// rolls saturated channels toward white as they brighten, which is exactly what
// keeps the SolidWorks primaries from reading as neon. The previous shader faked
// that by desaturating everything by a flat 28%, which cost the metals their
// colour too — and is now handled properly, at the palette, before either of
// these ever sees a colour.
//
// Matrices are flattened in GLSL's own mat3 order, i.e. by COLUMN, so the JS
// evaluation and the emitted constructor read the same list the same way.
const AGX_IN: readonly number[] = [
  0.856627153315983, 0.137318972929847, 0.11189821299995,
  0.0951212405381588, 0.761241990602591, 0.0767994186031903,
  0.0482516061458583, 0.101439036467562, 0.811302368396859,
];
const AGX_OUT: readonly number[] = [
  1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
  -0.11060664309660323, 1.157823702216272, -0.11060664309660294,
  -0.016493938717834573, -0.016493938717834257, 1.2519364065950405,
];
const SRGB_TO_2020: readonly number[] = [
  0.6274, 0.0691, 0.0164,
  0.3293, 0.9195, 0.088,
  0.0433, 0.0113, 0.8956,
];
const REC2020_TO_SRGB: readonly number[] = [
  1.6605, -0.1246, -0.0182,
  -0.5876, 1.1329, -0.1006,
  -0.0728, -0.0083, 1.1187,
];
const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;
// The sigmoid AgX puts on the log-encoded value, descending from x^6 to x^0.
const AGX_CONTRAST: readonly number[] = [
  15.5, -40.14, 31.96, -6.868, 0.4298, 0.1191, -0.00232,
];
// The "Medium High Contrast" look, as a power and a touch of saturation on top of
// AgX base. Blender ships it as a curve; this is the two-parameter fit of it,
// matched against 04_renders/pbr_mechanism.png.
const AGX_LOOK_POW = 1.2;
const AGX_LOOK_SAT = 1.18;
const LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

// A JS number as a GLSL float literal. An integer-valued float still has to carry
// its point, and JS's exponent form (1e-7) is not valid GLSL at all. Used by both
// shaders — there was a second, weaker one of these (toFixed(5)) baking the splat
// shader's progress constants, which quietly held the vertex shader's morph curve
// to five decimals while the depth sort mirroring it ran at full precision.
function glf(n: number) {
  const s = Number.isInteger(n) ? n.toFixed(1) : String(n);
  return s.includes('e') || s.includes('E') ? n.toFixed(12) : s;
}
const glVec3 = (v: readonly number[]) => `vec3(${v.map(glf).join(', ')})`;
const glMat3 = (m: readonly number[]) =>
  `mat3(\n  ${[0, 3, 6].map((i) => m.slice(i, i + 3).map(glf).join(', ')).join(',\n  ')})`;

// The same transform on the CPU, for the particles. The matrices are column-major
// to match the GLSL constructors above — M * v is v.x * col0 + v.y * col1 +
// v.z * col2, i.e. m[0], m[3], m[6] is the first ROW — so each multiply below
// reads its coefficients with a stride of 3 and the two evaluations are the same
// expression rather than a transcription of one another.
//
// Scalar in, scalar out through a caller-owned triple, and the arithmetic is
// written out rather than expressed as vector ops. It reads worse and it is the
// right trade exactly once, here: this runs 150,000 times inside one idle
// callback, and the array-and-.map() form allocated seven short-lived triples a
// call — over a million of them — for 41.4 ms against 14.9 ms, measured on the
// real geometry. The two forms agree to 8e-15, i.e. 2e-12 of one 255 code, so
// this is the same numbers in the same order and not a second implementation.
//
// `out` may be the same array the inputs were read from; every input is consumed
// into locals first.
function agxJs(r: number, g: number, b: number, out: [number, number, number]) {
  let x = r * SRGB_TO_2020[0] + g * SRGB_TO_2020[3] + b * SRGB_TO_2020[6];
  let y = r * SRGB_TO_2020[1] + g * SRGB_TO_2020[4] + b * SRGB_TO_2020[7];
  let z = r * SRGB_TO_2020[2] + g * SRGB_TO_2020[5] + b * SRGB_TO_2020[8];
  let c0 = x * AGX_IN[0] + y * AGX_IN[3] + z * AGX_IN[6];
  let c1 = x * AGX_IN[1] + y * AGX_IN[4] + z * AGX_IN[7];
  let c2 = x * AGX_IN[2] + y * AGX_IN[5] + z * AGX_IN[8];

  const evScale = 1 / (AGX_MAX_EV - AGX_MIN_EV);
  c0 = clamp01((Math.log2(Math.max(c0, 1e-10)) - AGX_MIN_EV) * evScale);
  c1 = clamp01((Math.log2(Math.max(c1, 1e-10)) - AGX_MIN_EV) * evScale);
  c2 = clamp01((Math.log2(Math.max(c2, 1e-10)) - AGX_MIN_EV) * evScale);

  // Horner over the same descending coefficient list the shader emits.
  let a0 = 0;
  let a1 = 0;
  let a2 = 0;
  for (const k of AGX_CONTRAST) {
    a0 = a0 * c0 + k;
    a1 = a1 * c1 + k;
    a2 = a2 * c2 + k;
  }
  const luma = a0 * LUMA[0] + a1 * LUMA[1] + a2 * LUMA[2];
  a0 = clamp01(luma + AGX_LOOK_SAT * (Math.pow(Math.max(a0, 0), AGX_LOOK_POW) - luma));
  a1 = clamp01(luma + AGX_LOOK_SAT * (Math.pow(Math.max(a1, 0), AGX_LOOK_POW) - luma));
  a2 = clamp01(luma + AGX_LOOK_SAT * (Math.pow(Math.max(a2, 0), AGX_LOOK_POW) - luma));

  x = Math.pow(Math.max(a0 * AGX_OUT[0] + a1 * AGX_OUT[3] + a2 * AGX_OUT[6], 0), 2.2);
  y = Math.pow(Math.max(a0 * AGX_OUT[1] + a1 * AGX_OUT[4] + a2 * AGX_OUT[7], 0), 2.2);
  z = Math.pow(Math.max(a0 * AGX_OUT[2] + a1 * AGX_OUT[5] + a2 * AGX_OUT[8], 0), 2.2);

  out[0] = Math.max(x * REC2020_TO_SRGB[0] + y * REC2020_TO_SRGB[3] + z * REC2020_TO_SRGB[6], 0);
  out[1] = Math.max(x * REC2020_TO_SRGB[1] + y * REC2020_TO_SRGB[4] + z * REC2020_TO_SRGB[7], 0);
  out[2] = Math.max(x * REC2020_TO_SRGB[2] + y * REC2020_TO_SRGB[5] + z * REC2020_TO_SRGB[8], 0);
}

// AgX hands back LINEAR sRGB — the pow(2.2) at the end of it is undoing an
// encode, not applying one. Neither of this scene's materials gets three's
// output-colour-space chunk (both are RawShaderMaterial), so the OETF is applied
// explicitly on both paths.
function encodeSrgbJs(v: number) {
  return v < 0.0031308 ? v * 12.92 : Math.pow(Math.max(v, 0), 1 / 2.4) * 1.055 - 0.055;
}

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
in vec4 mra; // metallic, roughness, occlusion, detail (see the detail channel)
// Per-instance placement, local part space -> render world. Vertices are stored in
// the part's OWN space so one copy serves every instance; three fills this from the
// InstancedMesh. Every transform in the assembly was verified to be a similarity
// (rotation times one uniform scale) at export time, which is what makes carrying
// normals through mat3 of it legitimate.
in mat4 instanceMatrix;
out vec3 vWorld;
// The same point WITHOUT modelMatrix, i.e. in the assembly's own frame. The
// dissolve hashes its grain off this and not off vWorld: modelMatrix carries the
// drifting yaw, the pitch, the fit dolly and the layer's own lift, all of which
// move every frame, so a world-space hash re-rolls which fragments survive on
// every frame of the removal. See the grain in CAD_FRAG.
out vec3 vPart;
out vec3 vNrm;
out vec3 vColor;
out vec4 vMra;
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 world = m * vec4(position, 1.0);
  vWorld = world.xyz;
  vPart = (instanceMatrix * vec4(position, 1.0)).xyz;
  // The group only ever rotates and scales uniformly, so the rotation part carries
  // normals correctly once renormalised — no separate normal matrix, and lighting
  // stays in world space where the studio rig is defined.
  vNrm = mat3(m) * normal;
  vColor = color;
  vMra = mra;
  gl_Position = uViewProj * world;
}
`;

// Every number in here that is not a BRDF comes from the shared block above; see
// the note there for why the shader is built out of it rather than repeating it.
const CAD_FRAG = /* glsl */ `
precision highp float;
in vec3 vWorld;
in vec3 vPart;
in vec3 vNrm;
in vec3 vColor;
in vec4 vMra;
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
// How much of the baked occlusion the DIRECT terms pay, as opposed to the
// ambient, which always pays in full. A uniform rather than a constant because
// the walk and the finale want very different answers — see the WALK_* block.
uniform float uAoDirect;
// Inspection state for this layer. uHot is the hover lift, uDim is how far the
// layer has been pushed behind whichever one the pointer is on. Both are
// UNIFORMS PER LAYER, which is the whole reason this beat could be made
// interactive cheaply: the diagram already draws one material per layer, so
// lighting one subassembly and dropping the other seven is eight uniform writes
// a frame and not one extra draw call, shader variant or render target.
uniform float uHot;
uniform float uDim;
// The hover's acid rim, split off uHot so the walk can borrow the exposure half
// without borrowing the interface. Written from the pointer and from nothing
// else.
uniform float uAccent;
// The teardown's dissolve. uPeel sweeps 0 -> 1 across this layer's removal; the
// band is how much of the detail channel is in flight at once and the grain is
// the per-fragment jitter that stops the front reading as a contour line.
uniform float uPeel;
uniform float uPeelBand;
uniform float uPeelGrain;
out vec4 outColor;

const float PI = 3.14159265359;

const int NLIGHT = ${LDIR.length};
const vec3 LDIR[${LDIR.length}] = vec3[${LDIR.length}](
  ${LDIR.map(glVec3).join(',\n  ')}
);
const vec4 LPOW = vec4(${LPOW.map(glf).join(', ')});
const vec4 LRAD = vec4(${LRAD.map(glf).join(', ')});

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

vec3 sky(vec3 d) {
  float up = d.y;
  vec3 zenith = ${glVec3(SKY_ZENITH)};
  vec3 horizon = ${glVec3(SKY_HORIZON)};
  vec3 ground = ${glVec3(SKY_GROUND)};
  return up > 0.0
    ? mix(horizon, zenith, sqrt(up))
    : mix(horizon, ground, sqrt(-up));
}

const mat3 AGX_IN = ${glMat3(AGX_IN)};
const mat3 AGX_OUT = ${glMat3(AGX_OUT)};
const mat3 SRGB_TO_2020 = ${glMat3(SRGB_TO_2020)};
const mat3 REC2020_TO_SRGB = ${glMat3(REC2020_TO_SRGB)};

// Horner, descending from x^6, so the JS evaluation of the same coefficient list
// is the same expression rather than a transcription of it.
vec3 agxContrast(vec3 x) {
  vec3 acc = vec3(${glf(AGX_CONTRAST[0])});
  ${AGX_CONTRAST.slice(1)
    .map((k) => `acc = acc * x + vec3(${glf(k)});`)
    .join('\n  ')}
  return acc;
}

vec3 agx(vec3 c) {
  const float MIN_EV = ${glf(AGX_MIN_EV)};
  const float MAX_EV = ${glf(AGX_MAX_EV)};
  c = SRGB_TO_2020 * c;
  c = AGX_IN * c;
  c = clamp((log2(max(c, 1e-10)) - MIN_EV) / (MAX_EV - MIN_EV), 0.0, 1.0);
  c = agxContrast(c);
  float luma = dot(c, ${glVec3(LUMA)});
  c = luma + ${glf(AGX_LOOK_SAT)} * (pow(max(c, 0.0), vec3(${glf(AGX_LOOK_POW)})) - luma);
  c = AGX_OUT * clamp(c, 0.0, 1.0);
  c = REC2020_TO_SRGB * pow(max(c, 0.0), vec3(2.2));
  return max(c, 0.0);
}

// The OETF. Leaving it out is what the first attempt did, and the diagram came
// back looking correctly shaded but three stops underexposed.
vec3 encodeSrgb(vec3 c) {
  return mix(c * 12.92,
             pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) * 1.055 - 0.055,
             step(vec3(0.0031308), c));
}

void main() {
  // ------------------------------------------------------------- the dissolve
  // COMPILED OUT unless this is the peel variant of the program, and that is a
  // cost decision rather than a tidiness one. A fragment shader containing
  // discard cannot have its coverage known before it runs, so the hardware gives
  // up early depth WRITE on a desktop IMR and, on every tile-based GPU — all
  // iOS, all Apple Silicon, Mali, Adreno — opts the draw out of hidden surface
  // removal altogether. All eight layers share one program, so a discard that is
  // reachable on at most one layer at a time was disabling HSR for every layer
  // on 89% of the page: precisely defeating the reason the seated layers are
  // handed to the opaque pass at all (see the note beside depthWrite in the
  // per-layer loop). It is not a cheap shader to run four to eight times over
  // per pixel — four GGX lobes, two sky lookups, then AgX.
  //
  // So there are two programs from this one source, differing in this block, and
  // a layer is given the peel one only while it is actually dissolving. See
  // cadMaterial.
  //
  // First, and before any shading is done: a discarded fragment should not pay
  // for a PBR evaluation it is going to throw away, and on the removal frames a
  // large share of the layer is discarded.
  //
  // The layer does not fade — it SKELETONISES. vMra.w is the detail channel: 0 on
  // the big flat triangles the decimator left across panels and skirts, 1 on the
  // small ones it kept for edges, fillets, fastener heads and the perforations in
  // the storage tracks. Sweeping a threshold up that channel evaporates the
  // SURFACES while the DETAIL persists, so the shell opens into a tracery of its
  // own edges and the mechanism underneath shows through the holes rather than
  // being cross-faded on top of.
  //
  // The front sweeps the whole range the grained channel actually occupies, and
  // that range is wider than the channel: the grain pushes a fragment as far as
  // half its own amplitude either side of the raw value, and the band trails
  // behind the front. Fitted to that rather than to 0..1, so uPeel 0 clears
  // exactly nothing and uPeel 1 clears exactly everything. Sweeping only 0..1+band
  // meant a removal OPENED on a step: at the first frame past zero the front was
  // already inside the grain's own spread, so a flat fragment that happened to
  // hash high jumped straight to 0.73 alpha and a dither texture appeared on the
  // panels out of nothing, at the exact moment the eye goes looking for the
  // removal to begin.
  float peeled = 0.0;
#ifdef PEEL
  if (uPeel > 0.0) {
    // Per-fragment grain, hashed off the ASSEMBLY's own frame — the vertex after
    // its instance transform and nothing more. Not world position: the group is
    // yawed, pitched, dollied and lifted every frame, and this hash re-randomises
    // completely for arguments that far apart, so hashing world space made the
    // surviving fragments re-roll frame to frame. "These specific edges held while
    // the panel went" IS the effect, and it only exists if the survivors are the
    // same ones next frame. It is also why the stills of this beat read better
    // than the animation did.
    //
    // Per fragment rather than per vertex, so it stays noise: interpolated, the
    // hash would become a smooth gradient across each triangle and the panels
    // would peel along their own tessellation.
    float g = fract(sin(dot(vPart.xy + vPart.z, vec2(12.9898, 78.233))) * 43758.5453);
    float d = vMra.w + (g - 0.5) * uPeelGrain;
    float front = mix(-0.5 * uPeelGrain, 1.0 + 0.5 * uPeelGrain + uPeelBand, uPeel);
    peeled = 1.0 - smoothstep(front - uPeelBand, front, d);
    if (peeled >= 0.996) discard;
  }
#endif

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
  // Floor on roughness, so a perfect mirror still has a lobe with a finite width
  // for the specular antialiasing below to widen. Numerically equal to the cap on
  // that widening, and unrelated to it — one is a roughness, the other is in
  // alpha-squared.
  float rough = clamp(vMra.y, ${glf(CAD_ROUGH_MIN)}, 1.0);
  float ao = mix(1.0, vMra.z, uAo);

  // Geometric specular antialiasing, and it is NOT made redundant by the
  // multisampling that now covers this pass. MSAA anti-aliases coverage: it takes
  // more samples of the silhouette and shades each covered pixel once. A chrome
  // bearing at 0.06 roughness has a highlight far narrower than a pixel on
  // decimated geometry, and that highlight strobes in the SHADING of pixels the
  // silhouette never touches, which no amount of coverage sampling can see.
  // Widening roughness by the normal's screen-space variance spreads it to at
  // least a pixel. Two different aliases, two different fixes, both needed.
  vec3 dnx = dFdx(n);
  vec3 dny = dFdy(n);
  float variance = 0.5 * (dot(dnx, dnx) + dot(dny, dny));
  float a = rough * rough;
  // CAD_SPEC_AA_MAX is the ceiling on how much roughness this may ADD, in
  // alpha-squared. It was 0.25, which is not a widening but a demolition: it lets
  // alpha reach 0.5, i.e. roughness 0.71, and this machine is dense enough —
  // perforated tracks, rings of small rollers, gear teeth — that the variance term
  // saturates over most of the model at anything short of full display resolution.
  // Every metal in the diagram was therefore being drawn at plaster roughness,
  // which is exactly the "no specular anywhere" the closing shot had. The teardown
  // had it worse and for longer, because it was rendering at the gaussian budget
  // until PIXEL_BUDGET_SOLID was keyed to the geometry instead of to the beat.
  //
  // The shipped value is the usual working range for this approximation and still
  // covers what it is for: a chrome bearing at roughness 0.06 has alpha 0.0036, so
  // the floor it imposes is alpha 0.21 — a highlight a couple of pixels across
  // instead of a sub-pixel one that strobes as the diagram turns.
  a = min(1.0, sqrt(a * a + min(2.0 * variance, ${glf(CAD_SPEC_AA_MAX)})));

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
  // this is a machine whose interesting parts are all inside something, and how
  // much of it gets through is the single biggest lever on whether the frame has
  // any blacks in it at all.
  lit *= mix(1.0, ao, uAoDirect);

  // Ambient. Irradiance from the sky gradient, plus its specular half through
  // the split-sum approximation — the second is what puts the environment's own
  // gradient onto the metals, and without it every metallic part goes black
  // wherever the three lights do not reach it.
  // sky() at straight up is a constant; only sky(n) varies. Folding the zenith
  // term in as a literal saves a branch and three mixes per fragment.
  vec3 irr = sky(n) * ${glf(1 - SKY_ZENITH_SHARE)} + ${glVec3(SKY_ZENITH)} * ${glf(SKY_ZENITH_SHARE)};
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
  vec3 col = encodeSrgb(agx(lit * uExposure
    * mix(1.0, ${glf(CAD_HOT_GAIN)}, uHot)
    * mix(1.0, ${glf(CAD_DIM_GAIN)}, uDim)));

  // Dimming also desaturates. Exposure alone was not enough separation on the
  // layers that are mostly one saturated colour — the felt green turntable stayed
  // the loudest thing on screen even two stops down, because AgX is protecting
  // exactly that primary on purpose.
  float grey = dot(col, ${glVec3(LUMA)});
  col = mix(col, vec3(grey), uDim * ${glf(CAD_DIM_DESAT)});

  // The hover accent: a fresnel rim in the site's acid, added in DISPLAY space
  // after the tone map. Deliberately not fed through agx() as if it were light —
  // it is not light, it is the interface pointing at something, and pushing it
  // through the transform would drag it toward white and land it as a wash
  // instead of an edge. See ACCENT_SRGB for why it is spelled in this space.
  float rim = 1.0 - NoV;
  rim *= rim * rim;
  col += ${glVec3(ACCENT_SRGB)} * rim * uAccent * ${glf(CAD_RIM_GAIN)};

  // Premultiplied, and the dissolve multiplies the landing fade rather than
  // replacing it: a layer can be mid-removal and mid-isolation at once while the
  // walk is being scrubbed backwards, and the two opacities are independent.
  // Deliberately not named a: that is already the roughness alpha further up this
  // same scope, and GLSL redefinition is a hard compile error — which takes the
  // whole material down and draws NOTHING, silently, on every beat that uses it.
  // (No backticks in this file's shader comments, either. They are template
  // literals, so a backtick ends the string and the syntax error lands on a line
  // of GLSL that is perfectly fine.)
  float outA = uFade * (1.0 - peeled);
  outColor = vec4(col * outA, outA);
}
`;

// One layer's pair of materials. Same source, same uniforms OBJECT — three keeps
// the reference it is handed rather than cloning it, so the frame loop goes on
// writing the layer's rig, fade and peel to one place and neither variant can
// fall out of step with the other.
//
// They differ in the PEEL define, which three folds into the program cache key
// even for a RawShaderMaterial, so this is two linked programs across the whole
// diagram and not two per layer. See the dissolve block in CAD_FRAG for why the
// two exist; the split also lets each carry the blend state it always wanted
// rather than having the frame loop toggle three flags on one material every
// frame:
//
//   solid  depth-writing, and opaque the moment it stops fading. Never discards,
//          so early-z and tile-based HSR both work on the seated stack.
//   peel   always transparent, never depth-writing. A survivor at 0.25 alpha
//          writing depth kills whatever draws behind it, and during a peel what
//          draws behind it is the far side of the same shell: the tracery would
//          go solid-looking and hollow at once, which is precisely the structure
//          the beat is selling.
function cadMaterials() {
  const uniforms = {
    uFade: { value: 0 },
    uCamPos: { value: new THREE.Vector3(0, 0, 10) },
    uViewProj: { value: new THREE.Matrix4() },
    // Seeded at the walk's values, since that is the condition the machine is
    // first drawn in; the frame loop crossfades all four to the finale's fitted
    // set on `fe`.
    uExposure: { value: WALK_EXPOSURE },
    uAmbient: { value: WALK_AMBIENT },
    uAo: { value: WALK_AO },
    uAoDirect: { value: WALK_AO_DIRECT },
    uHot: { value: 0 },
    uDim: { value: 0 },
    uAccent: { value: 0 },
    uPeel: { value: 0 },
    uPeelBand: { value: PEEL_BAND },
    uPeelGrain: { value: PEEL_GRAIN },
  };
  const make = (peel: boolean) =>
    new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      defines: peel ? { PEEL: 1 } : {},
      uniforms,
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
      // Depth ON for BOTH variants, unlike the splats: this is solid geometry and
      // the parts overlap. Writing depth while a whole layer fades UNIFORMLY can
      // misorder a part against itself, which is invisible at uniform alpha and
      // far cheaper than sorting 128k triangles.
      //
      // It was `!peel`, and that is what made the landing a ghost. A dissolving
      // layer is not a uniformly transparent one — it is a mostly-opaque surface
      // with holes punched in it — so leaving depth unwritten did not buy correct
      // ordering, it removed ordering altogether. During the finale EVERY layer is
      // dissolving at once, so all eight blended in render order with nothing
      // occluding anything: the cabinet went see-through, the parts inside it
      // showed through its panels, and which surface won a pixel changed as the
      // camera drifted. That is the flicker.
      //
      // The cost of writing it is that a fragment caught mid-band occludes what is
      // behind it while still partly transparent. The band is a fraction of the
      // surface at any moment and the error is one layer deep; the alternative was
      // eight layers deep and moving.
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
  return { solid: make(false), peel: make(true) };
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

  // World surface area per palette entry, instance-weighted, accumulated as the
  // shapes are unpacked below. It costs nothing to collect — the detail channel's

  // One shape: dequantise and de-interleave once, on load.
  //
  // Normals and colours stay QUANTISED all the way to the GPU, and the note that
  // used to be here — that unpacking octahedral normals per vertex in the shader
  // would cost more than the bytes it saves — was answering a question nobody has
  // to ask. A normalised integer attribute is widened to float by the fixed
  // function vertex fetch, at no ALU cost and with no shader change: `in vec3
  // normal` reads exactly the same values whether it is fed 12 bytes of float or 6
  // bytes of SHORT. Only the 2-component octahedral form needs real instructions,
  // and this does not use it.
  //
  // The expansion it was defending was 3.3x: a 12-byte-per-vertex file became 40
  // bytes on the GPU (pos 12 + nrm 12 + col 12 + mra 4) across ~412k vertices. That
  // is the wrong trade twice over, because this pass is VERTEX bound — 1.1M
  // triangles over 5.2 Mpx is 4.7 pixels a triangle — so those bytes are re-fetched
  // for every one of ~1.5M vertex invocations on every drawn frame, not merely
  // parked in VRAM. 40 -> 22 bytes: pos u16x3, nrm i16x3, col u16x3, mra u8x4,
  // which is the file's own 12 plus the two widenings named below.
  //
  // The widths are not arbitrary. Colour is 16-bit because the palette's darkest
  // channel is 0.0020 in LINEAR light: 8-bit would quantise that to one step of
  // 1/255 and put a 98% error on it, which is the black gear centre turning grey.
  // 16-bit puts it at 0.38%. Normals are 16-bit because the specular
  // antialiasing keys off the screen-space variance of the normal and a chrome
  // bearing sits at roughness 0.06, where 8-bit's 0.45 degrees of angular error is
  // a visible wobble in the highlight. Neither is a guess; see the palette read.
  //
  // Positions stay quantised too, and the way that is done is the interesting
  // part. The obvious route is a per-shape offset and scale as UNIFORMS, which is
  // nasty here: materials are per LAYER and shared by every shape in it, so each
  // draw would have to rewrite them in onBeforeRender and set uniformsNeedUpdate,
  // and three re-uploads the material's WHOLE uniform block when that is set —
  // ~15 uniforms times 120 draws a frame, to save 6 bytes a vertex.
  //
  // Instead the offset and step ride the INSTANCE MATRIX, which is already there,
  // is already per shape, and costs 421 matrices once at load instead of anything
  // per frame. The one requirement is that the step be uniform across the three
  // axes, or the matrix stops being a similarity and skews every normal; see the
  // note on `qs`. CAD_VERT is not touched at all, which on a file whose shaders
  // are template literals is worth more than the six bytes.
  function buildGroup(gi: number): {
    geo: THREE.BufferGeometry;
    mats: Float32Array;
    planR: number;
    coarse: Float32Array;
    varea: Float32Array;
    mra: Uint8Array;
    iscale: number;
  } | null {
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
    // ONE step for all three axes, so the dequantisation is a similarity and can
    // ride the instance matrix. The file quantises each axis into the shape's own
    // bbox independently, which is tighter but makes the decode a NON-UNIFORM
    // scale — and a non-uniform scale in the instance matrix would skew every
    // normal the vertex shader carries through mat3 of it.
    //
    // Re-quantising to the largest axis costs almost nothing, because the step is
    // then the same ABSOLUTE size on every axis: qExtentMax / 65535. The widest
    // shape here is a few units across, so that is under 1e-4 world units against
    // a machine ~10.8 units wide drawn ~1400 px tall — roughly a hundredth of a
    // pixel. A thin plate loses relative precision on its thin axis and none that
    // can be seen, because what matters on screen is the absolute step.
    const qs = Math.max(sx, sy, sz) || 1;
    const rx = sx / qs;
    const ry = sy / qs;
    const rz = sz / qs;

    const u16 = new Uint16Array(ab, vbase * stride, nverts * 6);
    const i16 = new Int16Array(ab, vbase * stride, nverts * 6);
    const u8 = new Uint8Array(ab, vbase * stride, nverts * stride);
    const pos = new Uint16Array(nverts * 3);
    const nrm = new Int16Array(nverts * 3);
    const col = new Uint16Array(nverts * 3);
    // metallic, roughness, occlusion, DETAIL. The fourth channel is not in the
    // file — it is measured below from the decimated triangles themselves.
    const mra = new Uint8Array(nverts * 4);
    // Which palette entry each vertex came from, kept so the paint grade can
    // rewrite the colours once it knows which entry covers the most surface.
    for (let v = 0; v < nverts; v++) {
      const s = v * 6;
      const d = v * 3;
      const m = v * 4;
      // Left QUANTISED. The origin and the step are folded into the instance
      // matrix below, so the GPU gets 6 bytes here instead of 12 and CAD_VERT is
      // not touched at all.
      pos[d] = Math.round(u16[s] * rx);
      pos[d + 1] = Math.round(u16[s + 1] * ry);
      pos[d + 2] = Math.round(u16[s + 2] * rz);

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
      // Straight back out to 16-bit. -32768 is deliberately never produced: GL
      // reads a signed normalised attribute as max(v / 32767, -1), so 32767 is
      // the whole magnitude. Round, do NOT let the store do the conversion — a
      // typed array WRAPS on overflow rather than clamping, so a value a hair
      // over 32767 would land on -32768 and turn one vertex's normal inside out.
      // It cannot get there from here (|nx| <= len by construction, and two
      // roundings cannot add half a unit), but the margin is worth naming.
      const inv = 32767 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nrm[d] = Math.round(nx * inv);
      nrm[d + 1] = Math.round(ny * inv);
      nrm[d + 2] = Math.round(nz * inv);

      // Rounded for the same reason and one of its own: the implicit conversion
      // truncates toward zero, which would double the quantisation error for
      // nothing. Rounded, the worst palette entry moves by 0.0101 of one 8-bit
      // sRGB output code.
      const pi = u8[v * stride + 10];
      col[d] = Math.round(palCol[pi * 3] * 65535);
      col[d + 1] = Math.round(palCol[pi * 3 + 1] * 65535);
      col[d + 2] = Math.round(palCol[pi * 3 + 2] * 65535);
      mra[m] = Math.round(palMr[pi * 2] * 255);
      mra[m + 1] = Math.round(palMr[pi * 2 + 1] * 255);
      mra[m + 2] = u8[v * stride + 11];
    }

    const geo = new THREE.BufferGeometry();
    // NOT normalized, unlike the two below: these are raw lattice indices, 0..65535,
    // and the vertex fetch hands them to `in vec3 position` as the floats they are.
    // The instance matrix turns them back into world units.
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // normalized: the fetch widens SHORT to [-1,1] and USHORT to [0,1] for free,
    // so CAD_VERT reads the same vec3 it always did.
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    geo.setAttribute('mra', new THREE.BufferAttribute(mra, 4, true));
    const idx =
      iw === 2
        ? new Uint16Array(ab, vbytes + ibyte, nidx)
        : new Uint32Array(ab, vbytes + ibyte, nidx);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    // ------------------------------------------------------- the detail channel
    // What drives the teardown's dissolve, and the reason it did not have to be
    // exported: THE DECIMATOR HAS ALREADY DONE THE FREQUENCY ANALYSIS. Quadric
    // edge collapse removes triangles wherever removing them costs little — which
    // is precisely the flat, low-frequency area: panels, skirts, the outer skin —
    // and keeps them where the surface bends: edges, fillets, fastener heads, the
    // perforations in the storage tracks.
    //
    // So EVERY PRIMITIVE HAS A SIZE, AND THAT SIZE MEANS SOMETHING. Post-decimation
    // triangle size is a per-primitive frequency channel sitting in the geometry
    // for free, needing no analysis — in exactly the way a 3DGS optimiser's
    // gaussian scale was, which is what let the teardown move onto meshes without
    // losing its one native effect. That was the argument the gaussian pipeline was
    // chosen for in the first place, and it turns out not to have been an argument
    // about gaussians at all.
    //
    // Key opacity to it and a layer does not fade, it SKELETONISES: its surfaces
    // evaporate biggest-first while its detail persists, so the shell opens into a
    // tracery of its own edges and the mechanism inside shows through the holes.
    // The surviving detail is still THERE, in space, occluding and being occluded —
    // which is what makes it a reveal rather than a texture effect painted over one.
    //
    // Measured as sqrt(area) rather than area so it is a LENGTH: areas across this
    // assembly span four orders of magnitude and the percentile fit below behaves
    // far better on the square root of that. Accumulated per vertex over the
    // adjacent triangles, because the shader interpolates a vertex attribute and a
    // per-face value would have to be duplicated per corner.
    //
    // `varea` is the surface each vertex is answerable for — a third of every
    // triangle it belongs to — and it is what the layer fit downstream weights by.
    // A vertex is not a unit of anything the eye can see: the decimator leaves
    // hundreds of them around one fastener head and four across a whole panel, so
    // counting them ranks the machine by where the mesh is dense rather than by
    // where the SURFACE is, which is the opposite of what the dissolve reads.
    const coarse = new Float32Array(nverts);
    const adj = new Float32Array(nverts);
    const varea = new Float32Array(nverts);
    // Cumulative local triangle area, one entry per triangle. Nothing in the
    // teardown reads it — it is what the word's particles are sampled against, and
    // it is emitted HERE because this loop already has every triangle's area in
    // hand. sampleCadSurface used to walk all 406,422 triangles a second time to
    // rebuild exactly this, cache-cold, after a setCad and a React commit had
    // pushed the 7.3 MB of positions and indices back out of L2.
    const cdf = new Float32Array(Math.max(0, Math.floor(nidx / 3)));
    let cdfRun = 0;
    for (let t = 0; t + 2 < nidx; t += 3) {
      const a = idx[t];
      const b = idx[t + 1];
      const c = idx[t + 2];
      const ax = pos[a * 3];
      const ay = pos[a * 3 + 1];
      const az = pos[a * 3 + 2];
      const e1x = pos[b * 3] - ax;
      const e1y = pos[b * 3 + 1] - ay;
      const e1z = pos[b * 3 + 2] - az;
      const e2x = pos[c * 3] - ax;
      const e2y = pos[c * 3 + 1] - ay;
      const e2z = pos[c * 3 + 2] - az;
      const cxp = e1y * e2z - e1z * e2y;
      const cyp = e1z * e2x - e1x * e2z;
      const czp = e1x * e2y - e1y * e2x;
      // Not Math.hypot. V8 implements it with overflow-safe scaling, which is
      // 2.2x the cost of the three multiplies and a sqrt — measured, this loop
      // plus the octahedral decode above run 17.0 ms with hypot and 10.1 ms
      // without, over the shipped 120 shapes. Overflow is not reachable here:
      // these are world units between 1e-3 and 1e-1, on geometry the exporter has
      // already verified. Keep hypot anywhere the magnitudes are not known.
      const ar = 0.5 * Math.sqrt(cxp * cxp + cyp * cyp + czp * czp);
      cdfRun += ar;
      cdf[t / 3] = cdfRun;
      const len = Math.sqrt(ar);
      coarse[a] += len;
      coarse[b] += len;
      coarse[c] += len;
      adj[a]++;
      adj[b]++;
      adj[c]++;
      varea[a] += ar / 3;
      varea[b] += ar / 3;
      varea[c] += ar / 3;
    }
    for (let v = 0; v < nverts; v++) coarse[v] = adj[v] > 0 ? coarse[v] / adj[v] : 0;
    // Carried on the geometry rather than returned, because the consumer is a
    // separate pass that only has the geometry to key off. Dropped once it has
    // read it — see the end of sampleCadSurface.
    geo.userData.cdf = cdf;
    geo.userData.area = cdfRun;

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
      // Post-multiply by translate(quantOrigin) * scale(qs), which is what turns a
      // lattice index back into a world point: M' = M * T(q) * S(qs). Written out
      // rather than built with Matrix4 because it is three column scalings and one
      // transformed origin, and this runs 421 times on the load path.
      //
      // Everything downstream keeps working WITHOUT KNOWING, and that is the whole
      // reason this is done here rather than in the shader: the detail channel, the
      // per-vertex area weights, the shape's bounding sphere and the surface
      // sampler all express local quantities in these lattice units and every one
      // of them already multiplies by the instance scale, which now carries `qs`.
      const t0 = m[0] * qx + m[4] * qy + m[8] * qz + m[12];
      const t1 = m[1] * qx + m[5] * qy + m[9] * qz + m[13];
      const t2 = m[2] * qx + m[6] * qy + m[10] * qz + m[14];
      m[0] *= qs;
      m[1] *= qs;
      m[2] *= qs;
      m[4] *= qs;
      m[5] *= qs;
      m[6] *= qs;
      m[8] *= qs;
      m[9] *= qs;
      m[10] *= qs;
      m[12] = t0;
      m[13] = t1;
      m[14] = t2;
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
    // The shape's instance scale, which the detail fit below needs: vertices are
    // stored in the part's own local space, so two shapes can carry identical
    // local triangle sizes and still land on screen at very different ones. Every
    // transform here was verified to be a similarity at export time, so a single
    // scalar describes it exactly.
    let iscale = 0;
    for (let k = 0; k < ninst; k++) {
      const m = mats.subarray(k * 16, k * 16 + 16);
      const wx = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
      const wz = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
      const scale = Math.hypot(m[0], m[1], m[2]);
      iscale = Math.max(iscale, scale);
      planR = Math.max(planR, Math.hypot(wx, wz) + rad * scale);
    }
    // Area as it reaches the screen: this shape is drawn ninst times, and the
    // instance transform is a similarity, so area scales by its square.
    const isc = iscale || 1;
    const wArea = isc * isc * ninst;
    return { geo, mats, planR, coarse, varea, mra, iscale: isc };
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
    const { solid: material, peel: peelMaterial } = cadMaterials();
    const root = new THREE.Group();
    // After the particle cloud, which draws with depthTest off and would otherwise
    // paint the dust over the machine it is solidifying into.
    root.renderOrder = 1;
    root.visible = false;
    const meshes: THREE.InstancedMesh[] = [];
    const geometries: THREE.BufferGeometry[] = [];
    const parts: {
      coarse: Float32Array;
      varea: Float32Array;
      mra: Uint8Array;
      iscale: number;
      ninst: number;
    }[] = [];
    let planR = 0;
    for (let gi = r.gbase; gi < r.gbase + r.ngroups; gi++) {
      const built = buildGroup(gi);
      if (!built) return null;
      planR = Math.max(planR, built.planR);
      const ninst = built.mats.length / 16;
      parts.push({
        coarse: built.coarse,
        varea: built.varea,
        mra: built.mra,
        iscale: built.iscale,
        ninst,
      });
      const im = new THREE.InstancedMesh(built.geo, material, ninst);
      im.instanceMatrix = new THREE.InstancedBufferAttribute(built.mats, 16);
      im.instanceMatrix.needsUpdate = true;
      // Not culled — but not for the reason this used to give, and it is worth
      // recording why, because "just turn culling on" is the obvious first idea
      // anyone has when they see 122 draw calls with one part filling the screen.
      //
      // The old reason was that the vertex shader applies instanceMatrix itself,
      // so three's bounding volumes would describe the untransformed shape. That
      // is simply wrong about three: InstancedMesh.computeBoundingSphere() unions
      // the geometry's sphere under EVERY instance matrix, and the frustum test
      // puts that through matrixWorld, which carries the group's fit, yaw and the
      // layer's lift. Culling would agree with gl_Position exactly — that is
      // uViewProj * modelMatrix * instanceMatrix * position with no vertex
      // displacement anywhere, and uViewProj is copied from
      // projectionMatrix * matrixWorldInverse, the same product three builds its
      // own frustum from.
      //
      // The real reason is the machine's four-fold symmetry, and it is a fact
      // about the ASSET, not about three. Measured over the 120 shapes: 72 of them
      // carry exactly 4 instances, one per corner, and their union sphere has a
      // median radius of 1.98 against an assembly radius of 5.39 — parts whose own
      // geometry is 0.04 across become a third of the machine wide the moment the
      // four copies are unioned. Only the 36 single-instance shapes have a sphere
      // (0.31) tight enough to ever fall outside the frustum, so culling was turned
      // on, measured, and turned off again having changed nothing.
      //
      // And the case it was supposed to rescue does not need rescuing. Isolating a
      // part already culls at the LAYER, which is a coarser test than the frustum
      // and a far more effective one: every layer but the chosen one dissolves to
      // nothing, root.visible follows it, and the whole subtree stops being
      // walked. Measured on the focused belt view: 35 draw calls and 247k triangles
      // a frame against 122 and 1,097k unfocused. Frustum culling has nothing left
      // to find there, and what it could find elsewhere it cannot see, because the
      // volumes are a third of the machine wide.
      im.frustumCulled = false;
      im.renderOrder = 1;
      root.add(im);
      meshes.push(im);
      geometries.push(built.geo);
    }

    // Fit the detail channel ACROSS THE LAYER, not per shape. The dissolve is a
    // property of the subassembly coming off — its big flat plates have to go
    // before its small fittings do — and a per-shape fit would rank every part
    // against only itself, so a featureless bracket would evaporate at the same
    // moment as a bearing race and the order that carries the effect would be
    // gone. In world units, so a small part magnified by its instance transform
    // is ranked by the triangle size that actually reaches the screen.
    //
    // Percentiles of SURFACE AREA, not of vertex count, and that distinction is
    // the whole beat rather than a refinement. Fitting on the 5th and 95th
    // vertex left 40-82% of every layer's area (measured: L0 59%, L2 82%, L4 40%)
    // clamped flat at detail 0, because the decimator spends its vertices where
    // the surface bends and the panels — which are most of what you SEE — come out
    // of it as a handful of huge triangles carrying almost no vertices at all. So
    // the percentile that was meant to trim slivers was instead trimming the
    // panels, and everything it trimmed cleared at the same uPeel: the shell went
    // in one grain-dithered step in the first seventh of the removal instead of
    // opening in an order. Weighted by area the clamped share is 5-11% a layer,
    // which is a graded sweep and is what the effect claims to be.
    //
    // A handful of sliver triangles at either end still must not take the whole
    // range — that is what percentiles are for — and weighting by area is also
    // what makes them harmless, since a sliver's weight is its own area.
    //
    // Taken off a BINNED histogram rather than an exact sort, and the reason is
    // that only two numbers leave this block and they are used to normalise into
    // a BYTE. An exact weighted percentile has to sort every sample, and that was
    // by far the most expensive thing on the whole load path: it allocated
    // 432,431 {v, w} objects — ~20 MB of short-lived heap, handed to the GC at
    // the exact moment the page wants to upload 19 MB of buffers — and sorting
    // them was four fifths of the parse.
    //
    // Measured on the shipped binary, whole function, unpack and detail channel
    // and fit: 99.3 ms with the sort, 13.9 ms with a 4096-bin area-weighted
    // histogram over the same samples.
    //
    // And the two agree to within what a byte can carry. Comparing the shipped
    // detail channel vertex by vertex across all 432,454 of them: 3,022 differ
    // (0.7%), every one of them by exactly 1 code out of 255 — i.e. only where
    // the exact answer already sat on a rounding boundary. The comment above this
    // one is the finding that carried the beat; this is only how it is computed.
    const DETAIL_BINS = 4096;
    let lo = Infinity;
    let hi = -Infinity;
    let wTotal = 0;
    for (const pt of parts) {
      // Area reaching the screen, not area in the part's own space: a shape is
      // stored once and drawn ninst times, and its local units are scaled by the
      // instance transform (a similarity, so area scales by the square).
      const iw = pt.iscale * pt.iscale * pt.ninst;
      for (let v = 0; v < pt.coarse.length; v++) {
        const w = pt.varea[v] * iw;
        if (w <= 0) continue;
        const x = pt.coarse[v] * pt.iscale;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
        wTotal += w;
      }
    }
    let p05 = 0;
    let p95 = 0;
    if (wTotal > 0) {
      // The range is set by the true extremes, so one enormous sliver would widen
      // every bin. Measured on this geometry, slivers included, that costs the
      // hundredths of a code quoted above — it degrades resolution gracefully
      // rather than failing.
      const range = Math.max(1e-12, hi - lo);
      const inv = DETAIL_BINS / range;
      const bins = new Float64Array(DETAIL_BINS + 1);
      for (const pt of parts) {
        const iw = pt.iscale * pt.iscale * pt.ninst;
        for (let v = 0; v < pt.coarse.length; v++) {
          const w = pt.varea[v] * iw;
          if (w <= 0) continue;
          let b = ((pt.coarse[v] * pt.iscale - lo) * inv) | 0;
          if (b < 0) b = 0;
          else if (b > DETAIL_BINS) b = DETAIL_BINS;
          bins[b] += w;
        }
      }
      // Bin CENTRES, which is what keeps the error symmetric — taking the low
      // edge would bias both percentiles down by half a bin.
      p05 = lo;
      p95 = hi;
      let acc = 0;
      let got05 = false;
      for (let b = 0; b <= DETAIL_BINS; b++) {
        acc += bins[b];
        const centre = lo + (b + 0.5) / inv;
        if (!got05 && acc >= 0.05 * wTotal) {
          p05 = centre;
          got05 = true;
        }
        if (acc >= 0.95 * wTotal) {
          p95 = centre;
          break;
        }
      }
    }
    const span = Math.max(1e-9, p95 - p05);
    for (const pt of parts) {
      for (let v = 0; v < pt.coarse.length; v++) {
        // 1 = fine detail (small triangles, survives longest), 0 = coarse flat area
        // (big triangles, evaporates first).
        const w = (pt.coarse[v] * pt.iscale - p05) / span;
        pt.mra[v * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, 1 - w)));
      }
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
      peelMaterial,
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
      dis: 0,
    });
  }

  return out;
}

// The word's particles, sampled off the machine's own surface.
//
// The lockup's dust has to land somewhere, and where it lands is what the morph
// resolves into. Taking those points from the CAD means the particle cloud and the
// shaded mesh describe the same object to within a particle's width, so the
// handover at the end of the morph is a SOLIDIFICATION rather than a cross-fade
// between two different descriptions of the machine. It also costs nothing to
// download: these points are derived from geometry that is already on the wire for
// the teardown, which is how the hero lost ~10 MB without losing a beat.
//
// AREA-WEIGHTED, and that is the whole trick. Sampling per triangle instead would
// crowd points onto the decimator's small detail triangles and leave the big flat
// panels bare — precisely inverting the density the eye expects, and precisely
// inverting the detail channel the teardown reads off the same triangles.
//
// And the points are SHADED here, not merely coloured. The palette is linear scene
// radiance; the splat shader writes what it is given straight to the drawing
// buffer with no tone map and no encode, because the format it was written for —
// .splat u8 colour — was already display-referred and this one is not. Handing it
// raw albedo crushes the darks and clips the lights: a mid grey lands at 55 where
// the encode alone would put it at 128, and the metals go to near-black holes. So
// across the handover the viewer watched a flat high-contrast albedo cloud
// dissolve into a soft AgX render — two different pictures of the same object,
// which is the exact cross-fade the whole "solidification in register" premise
// exists to avoid. Lighting each point through the same rig and the same view
// transform the mesh uses is what makes the two one picture.
function sampleCadSurface(cad: CadLayer[], limit: number): ModelSource | null {
  type Piece = {
    pos: Uint16Array;
    col: Uint16Array;
    nrm: Int16Array;
    mra: Uint8Array;
    idx: ArrayLike<number>;
    cdf: Float32Array; // cumulative LOCAL triangle area, one entry per triangle
    m: THREE.Matrix4;
    // The instance's rotation with the group's own handover orientation already
    // folded in, so a sampled normal reaches the rig in one multiply.
    nm: THREE.Matrix3;
    area: number; // this instance's world area
  };
  // The rig is defined in RENDER-WORLD space, which includes the group's live
  // rotation — and these colours are baked once at load. So they are evaluated at
  // the orientation the group holds at the HANDOVER: the morph ramp has finished,
  // so the pitch and yaw are at rest and the drift has barely started. That is the
  // one moment the cloud and the mesh have to be indistinguishable; before it the
  // cloud is still becoming the machine and there is nothing to compare it to.
  const handoff = new THREE.Matrix3().setFromMatrix4(
    new THREE.Matrix4()
      .makeRotationX(MODEL_PITCH)
      .multiply(new THREE.Matrix4().makeRotationY(MODEL_YAW))
  );
  // The CDF is per distinct SHAPE and shared by its instances — the machine is
  // four-fold symmetric and full of repeated bearings, so one per shape is
  // roughly a quarter of the work one per instance would be. It is not built
  // here: parseCadLayers already walked every triangle to measure the detail
  // channel and left the running area on the geometry. See buildGroup.
  const geos: THREE.BufferGeometry[] = [];
  const pieces: Piece[] = [];
  let world = 0;

  for (const layer of cad) {
    for (const im of layer.meshes) {
      const geo = im.geometry;
      const posAttr = geo.getAttribute('position');
      const colAttr = geo.getAttribute('color');
      const nrmAttr = geo.getAttribute('normal');
      const mraAttr = geo.getAttribute('mra');
      const index = geo.getIndex();
      if (!posAttr || !colAttr || !nrmAttr || !mraAttr || !index) continue;
      const pos = posAttr.array as Uint16Array;
      // Quantised on the way to the GPU, so this pass has to undo the same two
      // scalings the vertex fetch would have done for it. The normal's cancels —
      // it is normalised three lines after it is read — so only the colour needs
      // a divide. See the widths note in buildGroup.
      const col = colAttr.array as Uint16Array;
      const nrm = nrmAttr.array as Int16Array;
      const mra = mraAttr.array as Uint8Array;
      const idx = index.array as ArrayLike<number>;

      const cdf = geo.userData.cdf as Float32Array | undefined;
      const total = geo.userData.area as number | undefined;
      if (!cdf || !total || total <= 0) continue;
      geos.push(geo);

      const mats = im.instanceMatrix.array as Float32Array;
      for (let k = 0; k < im.count; k++) {
        const m = new THREE.Matrix4().fromArray(mats, k * 16);
        // Every transform in this assembly was verified to be a similarity at
        // export time, so one scalar describes it and area scales by its square.
        const s = Math.hypot(mats[k * 16], mats[k * 16 + 1], mats[k * 16 + 2]);
        const area = total * s * s;
        if (area <= 0) continue;
        world += area;
        const nm = new THREE.Matrix3().setFromMatrix4(m).premultiply(handoff);
        pieces.push({ pos, col, nrm, mra, idx, cdf, m, nm, area });
      }
    }
  }
  if (!pieces.length || world <= 0) return null;

  // Deterministic, so the lockup is made of the same grains on every load. A brand
  // mark that reshuffles its own dust between reloads is a brand mark that looks
  // slightly different every time anyone sees it.
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const count = Math.max(1, Math.min(limit, 200000));
  const outPos = new Float32Array(count * 3);
  const outCol = new Float32Array(count * 3);
  const outRadius = new Float32Array(count);
  const outOpacity = new Float32Array(count);
  // Mean spacing at this density. The particle is sized just past it so the cloud
  // reads as a surface rather than as a starfield of separated dots.
  const dot = Math.sqrt(world / count) * 0.62;

  const v = new THREE.Vector3();
  const nv = new THREE.Vector3();
  // Scratch for one particle's linear radiance, then its shaded result in place.
  // Allocated once: at 150,000 particles a fresh triple per particle is 150,000
  // short-lived arrays for no reason, on the pass that already has the tightest
  // loop in the file.
  const lin: [number, number, number] = [0, 0, 0];
  // The sky's diffuse irradiance for a normal, exactly as CAD_FRAG folds it: the
  // gradient in the normal's direction, plus a constant zenith share.
  const irrOf = (y: number, ch: number) => {
    const to = y > 0 ? SKY_ZENITH[ch] : SKY_GROUND[ch];
    return lerp(
      lerp(SKY_HORIZON[ch], to, Math.sqrt(Math.abs(y))),
      SKY_ZENITH[ch],
      SKY_ZENITH_SHARE
    );
  };
  let w = 0;
  for (let pi = 0; pi < pieces.length && w < count; pi++) {
    const piece = pieces[pi];
    // Proportional allocation, with the remainder carried by the last piece so
    // rounding cannot leave the tail of the buffer unwritten.
    const want =
      pi === pieces.length - 1
        ? count - w
        : Math.min(count - w, Math.round((piece.area / world) * count));
    const ntri = piece.cdf.length;
    const total = piece.cdf[ntri - 1];
    for (let j = 0; j < want; j++, w++) {
      // Pick a triangle in proportion to its area, by binary search on the CDF.
      const target = rnd() * total;
      let lo = 0;
      let hi = ntri - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (piece.cdf[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      const a = piece.idx[lo * 3];
      const b = piece.idx[lo * 3 + 1];
      const c = piece.idx[lo * 3 + 2];
      // Uniform over the triangle: the fold is what makes it uniform rather than
      // biased toward the first corner.
      let u = rnd();
      let vv = rnd();
      if (u + vv > 1) {
        u = 1 - u;
        vv = 1 - vv;
      }
      const wgt = 1 - u - vv;
      v.set(
        pos3(piece.pos, a, 0) * wgt + pos3(piece.pos, b, 0) * u + pos3(piece.pos, c, 0) * vv,
        pos3(piece.pos, a, 1) * wgt + pos3(piece.pos, b, 1) * u + pos3(piece.pos, c, 1) * vv,
        pos3(piece.pos, a, 2) * wgt + pos3(piece.pos, b, 2) * u + pos3(piece.pos, c, 2) * vv
      ).applyMatrix4(piece.m);
      outPos[w * 3] = v.x;
      outPos[w * 3 + 1] = v.y;
      outPos[w * 3 + 2] = v.z;

      // Shade it, off the same three attributes the mesh reads at this point.
      nv.set(
        pos3(piece.nrm, a, 0) * wgt + pos3(piece.nrm, b, 0) * u + pos3(piece.nrm, c, 0) * vv,
        pos3(piece.nrm, a, 1) * wgt + pos3(piece.nrm, b, 1) * u + pos3(piece.nrm, c, 1) * vv,
        pos3(piece.nrm, a, 2) * wgt + pos3(piece.nrm, b, 2) * u + pos3(piece.nrm, c, 2) * vv
      )
        .applyMatrix3(piece.nm)
        .normalize();
      // Baked occlusion, the third byte of mra. The fourth is the detail channel
      // and the first two are metallic and roughness, which this pass does not
      // read — see below.
      const occ =
        (piece.mra[a * 4 + 2] * wgt + piece.mra[b * 4 + 2] * u + piece.mra[c * 4 + 2] * vv) / 255;
      const ao = 1 + (occ - 1) * WALK_AO;
      const direct = 1 + (ao - 1) * WALK_AO_DIRECT;
      const ambK = WALK_AMBIENT * ao;
      // DIFFUSE ONLY, and everything treated as a dielectric of its own palette
      // colour. At the handover the machine is a few hundred pixels of ~8px
      // splats, where a specular lobe is not resolvable and a mirror is just a
      // patch of whatever it is reflecting; lighting a metal's base colour
      // diffusely lands it at about the grey the shaded mesh puts there, whereas
      // multiplying albedo by (1 - metallic) as the BRDF does would make every
      // metal a black hole in the cloud.
      //
      // The lamp sum is outside the channel loop because it does not depend on
      // the channel: the rig is white, so the four dot products and the
      // accumulate are one number that all three channels multiply their own
      // albedo by. Inside, it was 1.8M dot products where 600k do.
      let d = 0;
      for (let li = 0; li < LDIR.length; li++) {
        const NoL = nv.x * LDIR[li][0] + nv.y * LDIR[li][1] + nv.z * LDIR[li][2];
        if (NoL > 0) d += (LPOW[li] * NoL) / Math.PI;
      }
      d *= direct;
      for (let ch = 0; ch < 3; ch++) {
        const alb =
          (pos3(piece.col, a, ch) * wgt +
            pos3(piece.col, b, ch) * u +
            pos3(piece.col, c, ch) * vv) /
          65535;
        lin[ch] = alb * (d + irrOf(nv.y, ch) * ambK) * WALK_EXPOSURE;
      }
      agxJs(lin[0], lin[1], lin[2], lin);
      outCol[w * 3] = encodeSrgbJs(lin[0]);
      outCol[w * 3 + 1] = encodeSrgbJs(lin[1]);
      outCol[w * 3 + 2] = encodeSrgbJs(lin[2]);
      outRadius[w] = dot;
      outOpacity[w] = 1;
    }
  }

  // Nothing reads the area CDFs after this: the teardown keys off the detail
  // channel, and the particles are sampled exactly once. 1.6 MB across the 120
  // shapes, dropped rather than held for the life of the page.
  for (const geo of geos) {
    delete geo.userData.cdf;
    delete geo.userData.area;
  }

  return { count: w, pos: outPos, radius: outRadius, color: outCol, opacity: outOpacity };
}

function pos3(a: Float32Array | Int16Array | Uint16Array, i: number, ch: number) {
  return a[i * 3 + ch];
}

const TEX_W = 2048;
// Five RGBA texels a particle: two travel origins, its seat on the machine, and
// its two colours. It was EIGHT while the cloud was a 3DGS capture. The three that
// went described things this cloud does not have — a quaternion and an
// anisotropic scale, for an ellipsoid that is now a sphere; a radial blast target,
// an axial exit distance and a top-first peel order, for a teardown that now
// happens on the meshes. At the desktop particle count that is 19.2 MB of float
// texture down to 12.0 MB, and the same share off the build loop that fills it.
const TEXELS_PER_SPLAT = 5;

type SplatData = {
  count: number;
  texture: THREE.DataTexture;
  // CPU copies of the animated centres — the depth sort needs to know where each
  // particle currently is, and the morph itself runs on the GPU.
  scatterA: Float32Array;
  textHome: Float32Array;
  modelHome: Float32Array;
  delayForm: Float32Array;
  delayMorph: Float32Array;
};

function buildSplatData(text: string, src: ModelSource): SplatData {
  // Poster type is shouted: uppercase the latin, CJK passes through unchanged.
  const { coords, cw, ch } = sampleLockup(text.toUpperCase());
  const textCount = Math.max(1, coords.length / COORD_STRIDE);
  const count = src.count;

  const scatterA = new Float32Array(count * 3);
  const textHome = new Float32Array(count * 3);
  const modelHome = new Float32Array(count * 3);
  const delayForm = new Float32Array(count);
  const delayMorph = new Float32Array(count);

  // Fit the poster to the viewport: the camera rests at z=10 with fov 50, so
  // the visible width at the word's plane (z=0) is 2*tan(25°)*10*aspect ≈
  // 9.33*aspect world units. Desktop keeps the full 9-unit poster; narrow
  // screens shrink the lockup so the wordmark is never cropped mid-glyph.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1600;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
  const aspect = vw / Math.max(1, vh);
  let worldW = Math.min(9, 9.33 * aspect * 0.92);
  let worldH = (worldW * ch) / cw; // keep text aspect

  // ...and then fit it to the clear BAND, not to the whole frame.
  //
  // The lockup used to be centred on y = 0, which is the middle of the viewport
  // and not the middle of the space it actually has. Two DOM overlays sit in that
  // frame and neither is optional: the fixed nav across the top, and the hero copy
  // block bottom-anchored under it — eyebrow, subtitle and the scroll cue. Centred,
  // the wordmark's last line landed exactly on the eyebrow: "AUTOMATIC MAHJONG
  // TABLES" was drawn through the baseline of MANUFACTURING, and the CJK lockup was
  // worse because its secondary line is set larger.
  //
  // Same fix the finale already uses for the same reason (see BAND_TOP): reserve
  // the bands, fit to what is left, and centre on THAT. In px, because that is what
  // the overlays are authored in, and applied to worldH as well as worldW so a
  // short viewport shrinks the poster instead of running it under the copy.
  const perPx = (2 * CAM_HALF_H) / Math.max(1, vh);
  const bandTop = CAM_HALF_H - LOCKUP_BAND_TOP * perPx;
  const bandBottom = -CAM_HALF_H + LOCKUP_BAND_BOTTOM * perPx;
  const bandH = Math.max(0.5, bandTop - bandBottom);
  const bandMid = (bandTop + bandBottom) / 2;
  if (worldH > bandH) {
    const k = bandH / worldH;
    worldW *= k;
    worldH *= k;
  }

  // Strict monochrome particles with a rare acid strike — poster ink, not confetti.
  const cSmoke = new THREE.Color('#f5f5f3');
  const cGray = new THREE.Color('#8a8a86');
  const cAcid = new THREE.Color(ACCENT_HEX);

  // Particles are dealt to coords in a shuffled order: the quality governor trims
  // by instanceCount (first n particle indices), and a monotone index→coord map
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

    // text home: spread the particles evenly across the rasterised text pixels.
    // ~10+ of them share each sampled pixel, so scatter them across the sampling
    // cell — without the jitter they stack into one fat dot per lattice point
    // and the word reads as chunky mush instead of fine grain.
    const o6 = coordOf[Math.floor((k * textCount) / count) % textCount] * COORD_STRIDE;
    const tx = coords[o6] ?? cw / 2;
    const ty = coords[o6 + 1] ?? ch / 2;
    // jitter across the cell of the lattice this pixel was sampled on — the
    // fine band gets proportionally tighter scatter, which is what keeps its
    // small glyph edges sharp
    const step = coords[o6 + 5] ?? SAMPLE_STEP;
    const cell = (worldW * step) / cw;
    textHome[i3] = (tx / cw - 0.5) * worldW + (Math.random() - 0.5) * cell;
    textHome[i3 + 1] = -(ty / ch - 0.5) * worldH + bandMid + (Math.random() - 0.5) * cell;
    // thin slab: a deep z-jitter blurs the word's edges — and the fine band's
    // small glyphs can afford even less of it
    textHome[i3 + 2] = (Math.random() - 0.5) * (step < SAMPLE_STEP ? 0.08 : 0.18);

    modelHome[i3] = src.pos[i3];
    modelHome[i3 + 1] = src.pos[i3 + 1];
    modelHome[i3 + 2] = src.pos[i3 + 2];

    // fly-in origin: point on a surrounding sphere, kept in front of the camera
    // (z <= ~4 vs camera z=10) — particles that spawn at the near plane project to
    // screen-filling blobs and read as static noise.
    const rA = 7 + Math.random() * 8;
    const thA = Math.random() * Math.PI * 2;
    const phA = Math.acos(2 * Math.random() - 1);
    scatterA[i3] = Math.sin(phA) * Math.cos(thA) * rA;
    scatterA[i3 + 1] = Math.sin(phA) * Math.sin(thA) * rA * 0.75;
    scatterA[i3 + 2] = Math.cos(phA) * rA * 0.65 - 6;

    // staggers: assemble left->right, morph ripples randomly.
    const nx = textHome[i3] / worldW + 0.5;
    delayForm[k] = Math.min(MAX_FORM_DELAY, Math.max(0, nx * 0.07 + Math.random() * 0.02));
    delayMorph[k] = Math.random() * MAX_MORPH_DELAY;

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

    // pack 5 RGBA texels per particle (see the fetch() calls in the vertex shader)
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
    data[o + 11] = src.opacity[k];
    data[o + 12] = tr;
    data[o + 13] = tg;
    data[o + 14] = tb;
    // per-particle text alpha: the fine band runs ~2x the wordmark's particle
    // density, so its particles render at ~half alpha — equal ink coverage from
    // twice the positions is what keeps small glyph edges sharp
    data[o + 15] = step < SAMPLE_STEP ? 0.55 : 1;
    // model colour: already shaded and encoded by sampleCadSurface, so it goes to
    // the shader as display values and nothing further is done to it
    data[o + 16] = src.color[i3];
    data[o + 17] = src.color[i3 + 1];
    data[o + 18] = src.color[i3 + 2];
    data[o + 19] = src.radius[k];
  }

  const texture = new THREE.DataTexture(data, TEX_W, texH, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;

  return { count, texture, scatterA, textHome, modelHome, delayForm, delayMorph };
}

// The particle cloud, and the whole of what it now does: scatter, assemble into
// the wordmark, fly to points on the machine's surface, hand over to the mesh.
// Nothing else — the teardown moved onto the CAD, so the evaporation, the
// densification, the radial blast, the acid tint, the motion smear and the
// density LOD that used to live in here are all gone with the captures they were
// written for.
//
// Still splatting proper, because the projection is what makes the dust read as a
// surface rather than as a starfield: each particle is a 3D gaussian whose
// covariance is projected into a screen-space ellipse, drawn as an instanced quad
// with exp() falloff and alpha-blended back to front. The morph rides along by
// lerping the centre and the colour and blooming the scale from a text dot into
// the particle's own.
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
// The hand-over. The particles fly to points sampled ON the machine's surface, so
// at the end of the morph the cloud and the mesh are the same picture of the same
// object to within a particle's width; this is the cloud's half of the swap, and
// the mesh's uFade is the other half, driven off the same ramp.
uniform float uSplatOut;
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
float smoothstep01(float t) { return t * t * (3.0 - 2.0 * t); }

void main() {
  int i = int(iIndex);

  vec4 t0 = fetch(i, 0); // scatterA.xyz, delayForm
  vec4 t1 = fetch(i, 1); // textHome.xyz, delayMorph
  vec4 t2 = fetch(i, 2); // modelHome.xyz, opacity
  vec4 t3 = fetch(i, 3); // textColor.rgb, per-splat text alpha
  vec4 t4 = fetch(i, 4); // modelColor.rgb, radius

  // The two travels, in order: scatter -> wordmark, then wordmark -> the point
  // this particle was sampled at on the machine's surface. Both are per-splat
  // delayed, which is what makes the word ripple rather than snap.
  float a = easeOutCubic(clamp01((uProgress - t0.w) / ${glf(ASSEMBLE_WINDOW)}));
  float m = smoothstep01(clamp01((uProgress - ${glf(MORPH_START)} - t1.w) / ${glf(MORPH_WINDOW)}));

  // Leaving. The mesh takes the machine over at the end of the morph, so the last
  // thing the cloud does is get out of its way — one ramp, no travel: the two are
  // already in the same place.
  float lf = 1.0 - uSplatOut;

  vec3 center = mix(mix(t0.xyz, t1.xyz, a), t2.xyz, m);

  // Cursor repulsion + idle simmer, text phase only (the machine must not smear).
  // GPU-only offsets are small enough not to upset the CPU depth sort. This is the
  // animejs.com "poke the letters" interaction — a gentle bulge, not a crater (the
  // word is only ~1.5 units tall).
  float live = (1.0 - m) * a;
  vec2 dm = center.xy - uMouse;
  float dl = length(dm);
  center.xy += (dm / max(dl, 0.2)) * exp(-dl * dl * 3.0) * uRepel * live;
  center.x += sin(uTime * 1.1 + iIndex * 0.37) * 0.014 * live;
  center.y += cos(uTime * 1.4 + iIndex * 0.53) * 0.014 * live;

  // In-flight particles stay faint dust and brighten as they seat into the word.
  float dust = mix(0.05, 1.0, a);

  // t4.rgb reaches here already shaded, tone-mapped and sRGB-encoded — see
  // sampleCadSurface — so nothing further is done to it. The whole premise of the
  // handover is that this is the SAME picture the mesh draws, and any grade
  // applied on one side of it and not the other is the cross-fade it exists to
  // avoid.
  // t3.w: per-splat text alpha factor — the finely-sampled lockup band packs
  // ~2x the splat density and pays it back here so strokes don't bloom fat
  vColor = vec4(
    mix(t3.rgb, t4.rgb, m),
    mix(uTextAlpha * t3.w * dust, t2.w, m) * lf
  );

  // Below one 8-bit step this particle cannot tint a pixel, and the tail of the
  // handover is a whole cloud sitting under that threshold at once. Rejecting
  // here, before the projection, is what stops it being rasterised for nothing.
  if (vColor.a < 0.005) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  // Both ends of the morph are ISOTROPIC — a text dot, and a point sampled off the
  // machine's surface at the cloud's mean spacing — so one radius describes the
  // whole cloud's covariance and the rotation that used to orient a captured
  // gaussian's ellipsoid is gone with the captures. sigma = s^2 I, which is what
  // collapses the projection below to a scalar times T T^T.
  float s = mix(uTextDot, t4.w, m);

  vec4 cam = modelViewMatrix * vec4(center, 1.0);
  vec4 clip = projectionMatrix * cam;

  float lim = 1.3 * clip.w;
  if (clip.w <= 0.0 || abs(clip.x) > lim || abs(clip.y) > lim) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // offscreen
    return;
  }

  // Jacobian of the perspective projection at cam (column-major constructor).
  // Its overall sign cancels in T*sigma*T^T, so cam.z < 0 is fine.
  mat3 J = mat3(
    uFocal.x / cam.z, 0.0, 0.0,
    0.0, uFocal.y / cam.z, 0.0,
    -(uFocal.x * cam.x) / (cam.z * cam.z), -(uFocal.y * cam.y) / (cam.z * cam.z), 0.0
  );
  mat3 T = J * mat3(modelViewMatrix);
  mat3 cov = (s * s) * (T * transpose(T));

  // dilate so sub-pixel particles stay visible instead of aliasing away
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
// whatever the particle count — at 65536 that pass alone cost more than sorting
// the ~45k particles it was measured against. 16384 levels of depth is far past
// what alpha blending can show: the particles that land in one bucket are within
// a fraction of a millimetre of each other.
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
  stride: number
): number {
  const e = mv.elements;
  let dmin = Infinity;
  let dmax = -Infinity;
  const { count, scatterA, textHome, modelHome, delayForm, delayMorph } = data;

  // Thinning is a stride, not a shorter span: a prefix would carve a chunk out of
  // the cloud rather than thinning it evenly, and the cloud is one set — the
  // wordmark's particles, sampled on the machine's own surface — so the whole of
  // it is always in play.
  let n = 0;
  for (let k = 0; k < count; k += stride, n++) {
    const i3 = k * 3;
    // The same two lerps the vertex shader runs, on the same two easing curves.
    // If these drift the cloud composites in the wrong order exactly where it
    // overlaps itself most, which is the middle of the morph.
    const a = easeOutCubic(clamp01((p - delayForm[k]) / ASSEMBLE_WINDOW));
    const m = smoothstep(clamp01((p - MORPH_START - delayMorph[k]) / MORPH_WINDOW));
    const x = lerp(lerp(scatterA[i3], textHome[i3], a), modelHome[i3], m);
    const y = lerp(lerp(scatterA[i3 + 1], textHome[i3 + 1], a), modelHome[i3 + 1], m);
    const z = lerp(lerp(scatterA[i3 + 2], textHome[i3 + 2], a), modelHome[i3 + 2], m);

    // view-space z only — the sort key. Keyed by position in the strided walk,
    // not by particle index, so the scratch stays compact at every stride.
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
  for (let j = 0; j < n; j++) order[counts[buckets[j]]++] = j * stride;
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
  onFailed,
  onLayer,
  onQuality,
  selectRef,
  hoverRef,
  onHover,
  onSelect,
  onInspectable,
  onSolid,
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
  // The geometry did not arrive and is not going to. Distinct from "not ready
  // yet", because the two want opposite things on screen: one is a shimmer, the
  // other is the hero copy the shimmer is standing in front of.
  onFailed?: () => void;
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
  // Whether the frame is solid geometry with no particle pass over it, which
  // is what decides multisampling. See the note beside ins.solid.
  onSolid?: (v: boolean) => void;
  // Which stage is on screen, reported only when it changes. The caption is
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
  // The camera's view-projection, built once a frame and copied into all eight
  // layer materials — see the note where it is filled.
  const viewProjRef = useRef(new THREE.Matrix4());
  // Per-beat framing scale, rebuilt every frame — see the walk block in useFrame.
  const zoomsRef = useRef(new Float64Array(0));
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
  // The programs are the other half and do not need a draw at all: compile()
  // walks the scene with traverse(), not traverseVisible(), so it reaches the
  // diagram while it is still hidden, and compileAsync hands the link to
  // KHR_parallel_shader_compile where the driver has it.
  //
  // BOTH variants, which needs the swap below: compile() only sees the material
  // each mesh is actually carrying, and the meshes carry the solid one until the
  // first layer starts dissolving 210vh down the page. Left to itself the peel
  // program would link on that frame — in the middle of the beat the whole hero
  // is built around, which is the one place a link stall must not land. The
  // traverse inside compileAsync is synchronous (only the link CHECK is
  // deferred), so restoring the materials on the next line is safe.
  useEffect(() => {
    if (!cad) return;
    const link = () => {
      if (typeof gl.compileAsync === 'function') void gl.compileAsync(scene, camera).catch(() => {});
      else gl.compile(scene, camera);
    };
    try {
      for (const c of cad) for (const im of c.meshes) im.material = c.peelMaterial;
      link();
      for (const c of cad) for (const im of c.meshes) im.material = c.material;
      link();
    } catch {
      // A warm-up that cannot run is not a failure — it costs the frame it was
      // meant to save and nothing else. Put the materials back regardless: a
      // layer left on the peel variant would draw with depthWrite off.
      for (const c of cad) for (const im of c.meshes) im.material = c.material;
    }
  }, [cad, gl, scene, camera]);

  // Inspection state. All of it lives in refs: this runs in the frame loop and
  // none of it may cost a React render, for the same reason the scroll overlays
  // are written straight to the DOM — a re-render here re-renders <Canvas>, which
  // re-reconciles the whole scene tree.
  const inspect = useRef({
    hot: -1, // layer the pointer is over, -1 for none
    // 0..1 isolation blend, sprung toward "is something selected". A spring for
    // the same reason the framing below is one: this is the OPEN and CLOSE flight,
    // and on an exponential it left the diagram at full speed and crept into the
    // part. Critically damped, so it cannot overshoot past either end.
    focus: { x: 0, v: 0 } as Spring,
    live: false, // is the diagram accepting a pointer at this scroll position
    diagram: false, // is the CAD the only thing drawing, i.e. can it have the pixels
    // Whether the frame is SOLID GEOMETRY and nothing else. Separate from
    // `diagram` on purpose: that one is about the closing beat's pixel budget and
    // deliberately switches late, while this is about anti-aliasing and has to be
    // true for every frame that draws a triangle — which is now most of the page.
    solid: false,
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
    // The framing of the isolated part: its radius, its own centre height and its
    // seat, each a critically damped SPRING rather than a bare number. See the
    // block that drives them for why they are not read live off the selection, and
    // FOCUS_OMEGA for why they are springs and not exponentials.
    fitR: { x: 0, v: 0 } as Spring,
    cenY: { x: 0, v: 0 } as Spring,
    seat: { x: 0, v: 0 } as Spring,
    // The swap envelope: -1..1, signed by the direction of the last step and
    // springing toward zero whenever nothing is in flight. Drives the small widen
    // and the small turn that make a step read as a camera move. See SWAP_OMEGA.
    swirl: { x: 0, v: 0 } as Spring,
    swapDir: 1,
    // Whether the isolation is stepping between parts, as opposed to opening onto
    // one or closing off it. Only a step gets the envelope above.
    swapping: false,
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
  // Throw away everything the governor has learned and let it climb again. A
  // probe measured on one pass is not evidence about another, and a device that
  // concluded "resolution is not my problem" on the cheap pass would otherwise
  // carry that verdict — and its pinned floor — into the expensive one. Called on
  // the page's two real changes of pass, so at most twice a visit.
  const reprobe = useCallback(() => {
    const gv = gov.current;
    gv.floor = GOV_MAX_LEVEL;
    gv.probe = 0;
    gv.bad = 0;
    gv.good = 0;
  }, []);

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

  // One asset, and everything is derived from it.
  //
  // This effect used to fetch 9.9 MB of gaussian captures and the diagram was
  // loaded afterwards, on an idle callback, precisely because the two together
  // were 17 MB. There is now nothing to race: the CAD is the only geometry the
  // hero has, the word's particles are sampled off it, and the whole hero is
  // 7.27 MB — 3.94 on the wire, since the route that serves it now sets a
  // Content-Encoding (see src/app/hero-model/[file]/route.ts; it was going over
  // uncompressed, which is 46% of the transfer for nothing).
  useEffect(() => {
    let cancelled = false;
    // Stops a 7 MB transfer when the visitor leaves the page rather than letting
    // it run to completion against a flag that only suppresses the setState.
    const ac = new AbortController();

    (async () => {
      // THE FETCH GOES FIRST, and the fonts are awaited after it. Nothing about
      // the request needs a font — they are consumed by sampleLockup, three steps
      // downstream, after the parse and after the idle callback — and both hanzi
      // faces are declared `preload: false`, so asking for them costs a Google
      // Fonts CSS round-trip plus a unicode-range subset fetch. Awaiting that in
      // front of the largest asset on the site put a full RTT of dead air on the
      // one thing the hero cannot start without.
      const wire = Promise.all([
        fetch(CAD_URL, { signal: ac.signal }),
        fetch(CAD_INDEX_URL, { signal: ac.signal }),
      ]);
      // Nothing may throw between here and the await below, or `wire` is an
      // unhandled rejection.
      wire.catch(() => {});

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

      // Both halves must land: the vertex block is meaningless without the sidecar
      // that says which bytes are which shape, so there is no partial success to
      // fall back to.
      try {
        const [rc, ri] = await wire;
        if (!rc.ok || !ri.ok) throw new Error(`models: ${rc.status}/${ri.status}`);
        const [ab, idx] = await Promise.all([rc.arrayBuffer(), ri.arrayBuffer()]);
        const parsed = parseCadLayers(ab, idx);
        if (!parsed) throw new Error('models: parse failed');
        if (!cancelled) setCad(parsed);
      } catch {
        // Say so, rather than leaving the page on a shimmer forever. `ready` is
        // what un-hides the hero copy, and it is driven off the sampled data — so
        // a dropped transfer used to leave 940vh of near-black with a pulsing
        // rule and the word LOADING on a manufacturer's homepage: no company
        // name, no tagline, nothing. There is no retry here on purpose; a second
        // 7 MB attempt on a connection that just dropped one is more likely to
        // hold the page hostage twice than to succeed. See `failed`.
        if (!cancelled) onFailed?.();
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, []);

  // The particles, derived from the geometry rather than fetched beside it. Runs
  // once the diagram lands, off the main thread's next idle slot: sampling ~150k
  // points across 400k triangles is a few milliseconds, but those few milliseconds
  // would otherwise land on the same frame that uploads the CAD buffers.
  useEffect(() => {
    if (!cad) return;
    let cancelled = false;
    const small = typeof window !== 'undefined' && window.innerWidth < 820;
    const limit = small ? MAX_SPLATS_MOBILE : MAX_SPLATS_DESKTOP;
    const run = () => {
      if (cancelled) return;
      const sampled = sampleCadSurface(cad, limit);
      if (sampled && !cancelled) setSrc(sampled);
    };
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    };
    // Safari below 16.4 has no requestIdleCallback.
    if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(run, { timeout: 400 });
    else setTimeout(run, 0);
    return () => {
      cancelled = true;
    };
  }, [cad]);

  useEffect(() => {
    if (!cad) return;
    return () => {
      for (const c of cad) {
        for (const g of c.geometries) g.dispose();
        c.material.dispose();
        c.peelMaterial.dispose();
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
      // Measured up the SCREEN, which is the axis the seats are laid out on — a
      // flat disc like the turntable is almost entirely the plan term.
      const half = screenHalfH((r.maxY - r.minY) / 2, r.radius, cp, sp);
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

  // The teardown, measured off the same geometry that draws it.
  //
  // Beat k frames layers k..n-1 SEATED — the machine with its first k layers
  // already taken off. That is the whole difference between this walk and the one
  // it replaces: nine captures each trained on a part in isolation could only ever
  // be shown one after another, a catalogue of subassemblies, and the reveal had to
  // be implied. Here the layer that comes off was genuinely on top of the one
  // underneath, in the same world frame, so removing it reveals what was actually
  // there.
  //
  // What each beat needs from the geometry is TWO half-extents, not one radius,
  // because the frame's two constraints are not the same measurement. Horizontally
  // the subject is bounded by its plan half-extent. Vertically it is bounded by how
  // tall it stands ON SCREEN — see screenHalfH, which is where that measurement and
  // the reason it is not max(planHalf, yHalf) both live.
  const walk = useMemo(() => {
    if (!cad || cad.length < 2) return null;
    if (process.env.NODE_ENV !== 'production' && cad.length !== WALK_LAYERS) {
      // The pacing constants quantise the walk's detents to 1/WALK_LAYERS while
      // this maps scroll onto cad.length. Disagreeing does not desync the scene —
      // it parks every rest half way through a removal.
      console.warn(
        `ScrollScene: cad-layers-index.bin carries ${cad.length} layers but WALK_LAYERS is ${WALK_LAYERS}; the walk will rest mid-removal.`
      );
    }
    const n = cad.length;
    const cp = Math.cos(MODEL_PITCH);
    const sp = Math.sin(MODEL_PITCH);
    const out: {
      centreY: number;
      radius: number;
      planHalf: number;
      halfScreen: number;
    }[] = [];
    for (let k = 0; k < n; k++) {
      let loY = Infinity;
      let hiY = -Infinity;
      let loX = Infinity;
      let hiX = -Infinity;
      for (let i = k; i < n; i++) {
        const b = cad[i].box;
        loY = Math.min(loY, b.min.y);
        hiY = Math.max(hiY, b.max.y);
        // Plan extent, taken over both horizontal axes: the machine is square in
        // plan, and the yaw drift means whichever of the two is wider can be the
        // one facing the camera on any given frame.
        loX = Math.min(loX, b.min.x, b.min.z);
        hiX = Math.max(hiX, b.max.x, b.max.z);
      }
      const planHalf = Math.max(0.001, (hiX - loX) / 2);
      const yHalf = Math.max(0.001, (hiY - loY) / 2);
      out.push({
        centreY: (loY + hiY) / 2,
        // The larger of the two, which is what the caption's horizontal
        // reservation wants: it errs wide, and the finale's own `radius` is
        // measured the same way, so the two blend against each other honestly.
        radius: Math.max(planHalf, yHalf),
        planHalf,
        // Up the screen, the same way the finale measures its stack.
        halfScreen: screenHalfH(yHalf, planHalf, cp, sp),
      });
    }
    return out;
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
        uSplatOut: { value: 0 },
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
    // the word is readable, then the machine swings up into a 3/4 view from
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
    const fe = cad ? smoothstep(clamp01((p - WALK_END) / (FINALE_END - WALK_END))) : 0;
    // The handover from the word's dust to the machine's own geometry. One ramp
    // drives both sides of it: the mesh fades up on `appear` and the particles
    // fade out on the same number, so the two can never both be missing.
    const appear = cad
      ? smoothstep(clamp01((p - SOLID_START) / (SOLID_END - SOLID_START)))
      : 0;
    material.uniforms.uSplatOut.value = appear;
    // The table beat, as a ramp: 0 the moment the machine finishes assembling
    // itself out of the word, 1 by the time the first layer is due to come off.
    // TWO things ride it and they used to compute it separately, three lines
    // apart — the caption column's horizontal reservation (the copy arrives at the
    // walk, so the model has to have finished moving aside before it does) and the
    // walk's own emphasis (the assembled machine gets one beat of being nothing but
    // itself before anything is pointed at).
    const tableIn = smoothstep(clamp01((p - MORPH_END) / TABLE_SPAN));

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
    // particle cloud gets, and switching it reallocates the drawing buffer — so
    // the two thresholds are deliberately far apart, and both sit deep inside the
    // finale, where the cloud has not been drawn for most of a page. Scrubbing
    // across a single threshold would otherwise resize the canvas on every frame
    // of the scrub.
    // Multisampling, on the other hand, follows the GEOMETRY and not the beat.
    //
    // It used to be gated on `diagram` above, which is why the walk aliased: 468vh
    // of perforated tracks, ring gears and the lip of every disc, drawn with no
    // anti-aliasing of any kind, because the flag it was keyed to does not come up
    // until the last 9% of the page. That gating made sense when everything before
    // the diagram was soft gaussians — soft gaussians genuinely cannot alias, and
    // multisampling hundreds of thousands of alpha-blended quads is the one thing
    // the canvas flag must never be allowed to do. It survived the move to meshes
    // unexamined, and the reason it was there went with the captures.
    //
    // So: on for every frame where the machine is drawn and the particles are not.
    // The threshold is exactly `splatsGone` — the same number that stops drawing
    // the cloud — so the multisampled pass and the alpha-blended pass can never
    // overlap by construction, which is the whole of the original argument. The
    // hysteresis band is wide because switching reallocates the renderbuffer.
    if (cad) {
      const solid = ins.solid ? appear > 0.9 : appear >= 0.999;
      if (solid !== ins.solid) {
        ins.solid = solid;
        onSolid?.(solid);
        // THIS is the page's real change of pass, and it is where the reprobe
        // belongs: the render scale jumps to the solid budget and multisampling
        // arrives with it, on the same frame, both keyed to this flag. Everything
        // measured over the cloud was measured on a fill-bound alpha pass that is
        // about to stop being drawn at all.
        reprobe();
      }
      const owns = ins.diagram ? fe > 0.15 : fe >= FINALE_HANDOVER;
      if (owns !== ins.diagram) {
        ins.diagram = owns;
        // Kept, but for a different reason than it was written for. The diagram
        // no longer changes the render scale or the sample count — it inherits
        // both from `solid` — but it does put every layer on screen at once,
        // pulled apart, where the walk holds at most a few. Same pixels, more
        // geometry through them.
        reprobe();
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
    const focOmega = reducedMotion.current ? 60 : FOCUS_OMEGA;
    const foc = spring(ins.focus, sel >= 0 ? 1 : 0, focOmega, dtc);
    // Orbit decays back to the scripted framing as the isolation lets go, so
    // returning to the diagram and picking a second part starts it square rather
    // than wherever the last one was left.
    if (sel < 0) {
      ins.yawTo *= Math.exp(-FOCUS_RATE * dtc);
      ins.pitchTo *= Math.exp(-FOCUS_RATE * dtc);
    }
    ins.yaw = damp(ins.yaw, ins.yawTo, ORBIT_RATE, dtc);
    ins.pitch = damp(ins.pitch, ins.pitchTo, ORBIT_RATE, dtc);
    // Which way the stack was just stepped, latched before lastSel is overwritten.
    // Signed SHORTEST path around the ring, so wrapping 08 -> 01 turns the way it
    // looks like it turns rather than winding seven parts backwards — and so a rail
    // click, which can jump any distance, still says something true about direction.
    if (sel >= 0 && ins.lastSel >= 0 && sel !== ins.lastSel && cad) {
      const n = cad.length;
      ins.swapDir = ((sel - ins.lastSel + n / 2 + 2 * n) % n) - n / 2 >= 0 ? 1 : -1;
      // Only a SUBJECT CHANGE with the isolation already up is a swap. Opening from
      // the assembled diagram clears seven layers too, but that is a push-in and
      // must not get the widen — a camera that pulls back on its way into a part is
      // a counter-move — nor the turn, whose direction would be whatever the last
      // step happened to leave behind.
      ins.swapping = true;
    }
    if (sel >= 0) ins.lastSel = sel;
    else if (foc < 0.002) ins.lastSel = -1;
    // The subject the framing is fitted to while the isolation is up. Null both
    // before anything is picked and after the return flight has landed, which is
    // exactly when the stack's own framing is the right one.
    const focGeo =
      finale && ins.lastSel >= 0 && foc > 0.002 ? (finale.per[ins.lastSel] ?? null) : null;
    const focLayer = focGeo && cad ? (cad[ins.lastSel] ?? null) : null;
    // The framing of the isolated part, sprung rather than read straight off the
    // selection — because scrolling steps from one part to the next without ever
    // closing, and the parts differ by 3x in size and sit metres apart on the
    // explode axis. Taken live, every step would cut the scale and the centring in
    // one frame; sprung, the frame TRAVELS to the next part while it forms, which
    // is what makes stepping through the stack read as one move.
    //
    // Radius and seat move; the PITCH they are combined with below does not. The
    // fit must not move while the visitor turns a part, but the centring must —
    // tipping a part a quarter turn otherwise slides it off the middle of the frame
    // by its own half-height.
    if (focGeo && focLayer) {
      if (ins.fitR.x <= 0) {
        // First open of the visit: seat the springs rather than fly them in from
        // zero, which would start the isolation at infinite magnification.
        ins.fitR.x = focGeo.fitR;
        ins.cenY.x = focLayer.centreY;
        ins.seat.x = focLayer.seatY;
        ins.fitR.v = 0;
        ins.cenY.v = 0;
        ins.seat.v = 0;
      } else {
        spring(ins.fitR, focGeo.fitR, focOmega, dtc);
        spring(ins.cenY, focLayer.centreY, focOmega, dtc);
        spring(ins.seat, focLayer.seatY, focOmega, dtc);
      }
    } else if (foc < 0.002) {
      ins.fitR.x = 0;
      ins.fitR.v = 0;
    }

    // How much of a layer that should NOT be on screen still is, taken from last
    // frame's dissolves. One number over eight layers, and it does two jobs: it
    // gates when the incoming part may start forming (SWAP_HANDOFF) and it is the
    // pulse the swap envelope chases. One frame stale, which nothing can see.
    //
    // Defined against what is UNWANTED rather than against what is arriving, which
    // is what makes closing work: at sel < 0 every layer is wanted, so this is zero
    // and all eight re-form at once instead of waiting on each other forever.
    let held = 0;
    if (cad && sel >= 0) {
      for (let ci = 0; ci < cad.length; ci++) {
        if (ci !== sel) held = Math.max(held, 1 - cad[ci].dis);
      }
    }
    if (held <= 0.02) ins.swapping = false;
    // The envelope, signed by the direction of the step. Zeroed under reduced
    // motion: a frame that widens and turns on its own is exactly the unprompted
    // camera movement the preference is asking us not to make, and the states
    // either side of the step are unaffected.
    const swirl = spring(
      ins.swirl,
      reducedMotion.current || !ins.swapping ? 0 : ins.swapDir,
      SWAP_OMEGA,
      dtc
    );
    // The isolation as the FRAMING sees it — relaxed a little back toward the whole
    // diagram while a swap is in flight. The orbit keeps the unbreathed `foc`: the
    // widen is the camera's, and running the visitor's own yaw and pitch through it
    // would unwind a turn they made and hand it back, which reads as the page
    // taking the part out of their hands.
    const focFrame = foc * (1 - SWAP_PULL * Math.abs(swirl));

    // The walk looks down at the playfield from 43 degrees, which is right for a
    // table and wrong for a column of parts — it foreshortens the very gaps the
    // diagram exists to show. So the finale eases the camera back down to a
    // near-side-on read, and keeps turning.
    grp.rotation.x = lerp(MODEL_PITCH * rf, FINALE_PITCH, fe) + ins.pitch * foc;
    grp.rotation.y =
      MODEL_YAW * rf +
      spinModel * MODEL_TURN +
      fe * FINALE_TURN +
      ins.yaw * foc +
      SWAP_SWING * swirl;
    // The pitch, resolved once. Everything that has to project an OBJECT-space
    // height onto the screen goes through this pair, and it was three separate
    // trig calls on the same angle: object +y lands cos(pitch) up the screen and
    // sin(pitch) toward the camera.
    const cosPitch = Math.cos(grp.rotation.x);
    const sinPitch = Math.sin(grp.rotation.x);

    // Screen-up, expressed in the group's own space — the direction a part
    // travels when it is removed, and the one the explode seats are stacked on. It
    // has to be screen-relative and cannot be the machine's own +Y, however much
    // the CAD explode says otherwise: the group is pitched 43 degrees to look down
    // at the playfield, so object +Y points up AND two thirds of the way toward the
    // camera, and a part sent along it does not leave the frame — it flies through
    // the lens, filling the screen with a blurred close-up of its own underside.
    // Every exploded-view drawing ever made separates parts up the page for the
    // same reason.
    //
    // Derived from the live rotation rather than baked, so it stays vertical
    // through the pitch ramp and the drifting yaw. Reused scratch: this runs every
    // frame and both the removal travel and the landing flight read it.
    const axis = axisRef.current;
    axis.set(0, 1, 0).applyQuaternion(invRef.current.copy(grp.quaternion).invert());

    // Walk the teardown. `pos` is fractional: its integer part is the layer
    // currently on TOP — the one this beat takes off — and the remainder is how
    // far through its removal the walk has got. Every layer below it is on screen
    // the whole time; see the `walk` useMemo for why that is the whole point.

    // The usable frame, measured once for everything below it. It is NOT the
    // frustum: a fixed 7rem gradient (plus the nav) caps the top and a fixed 8rem
    // one caps the bottom — see the vignette element — and anything under them is
    // invisible whatever the projection says. The finale always knew this; the walk
    // did not, which is how the assembled table's near legs ended up dissolving
    // into the bottom gradient instead of standing inside the frame.
    const halfVAll = Math.tan(((cam.fov * Math.PI) / 180) / 2) * Math.abs(cam.position.z);
    const perPxAll = (2 * halfVAll) / Math.max(1, size.height);
    const bandTop = halfVAll - BAND_TOP * perPxAll;
    const bandBottom = -halfVAll + BAND_BOTTOM * perPxAll;
    const clearHalf = Math.max(0.5, (bandTop - bandBottom) / 2);
    const halfWAll = halfVAll * (size.width / Math.max(1, size.height));

    // The scale each beat is held at: the same two-constraint fit the finale uses
    // on the stack, against that beat's own projected half-height and plan
    // half-extent. Recomputed every frame rather than measured once with the
    // geometry, because the camera dollies through the walk and the band is in
    // PIXELS — so each beat is framed against the frame it is actually drawn in.
    // Into reused scratch, since both the dolly and the removal travel read it and
    // this loop runs sixty times a second.
    let zooms: Float64Array | null = null;
    if (walk) {
      if (zoomsRef.current.length !== walk.length) zoomsRef.current = new Float64Array(walk.length);
      zooms = zoomsRef.current;
      for (let k = 0; k < walk.length; k++) {
        zooms[k] = Math.min(
          FIT_ZOOM_MAX,
          Math.max(
            FIT_ZOOM_MIN,
            FIT_MARGIN * Math.min(clearHalf / walk[k].halfScreen, halfWAll / walk[k].planHalf)
          )
        );
      }
    }

    let fit = 1;
    let layerPos = 0;
    if (walk && zooms) {
      // One beat per layer, and the last layer keeps its beat WITHOUT being
      // removed: the electronics box is the innermost thing in the machine and
      // the payoff of the whole teardown, so the walk ends holding it rather than
      // dissolving it into an empty frame half a beat before the diagram arrives.
      // (The capture walk needed the opposite fix — mapping onto 0..n-1 gave its
      // last capture no beat at all.)
      const rawU = clamp01((p - WALK_START) / (WALK_END - WALK_START)) * walk.length;
      const raw = Math.min(walk.length - 1, rawU);
      const base = Math.min(walk.length - 1, Math.floor(raw));
      // Hold, then hand over: the machine sits still for most of each beat's
      // scroll and only comes apart at the end. This is what buys a readable beat
      // per subassembly without shortening the removal.
      const pos =
        base + smoothstep(clamp01((raw - base - (1 - WALK_TRANSITION)) / WALK_TRANSITION));
      // Framing runs on its own curve, and — the part that matters — a LATER one.
      // The dolly has to be slow, but it also must not run while the part is
      // leaving: what is left after a removal is smaller, so reframing for it means
      // zooming IN, and zooming in on the thing currently being lifted out
      // cancels the lift. The part grows in frame as fast as it climbs and the
      // beat reads as a push-in rather than a removal. Shifted by FRAME_LAG the
      // dolly starts as the part releases and finishes half way into the next
      // layer's hold, so the removal happens at a steady scale and the reframe
      // happens over a model that is standing still.
      const fr = rawU - FRAME_LAG;
      const fb = Math.max(0, Math.min(walk.length - 1, Math.floor(fr)));
      const framePos = fb + smoothstep(clamp01((fr - fb) / WALK_FRAME_EASE));
      const i0 = Math.min(walk.length - 1, Math.floor(framePos));
      const i1 = Math.min(walk.length - 1, i0 + 1);
      const t = framePos - i0;
      layerPos = pos;

      // Switch the caption at the midpoint of the handoff, where the outgoing
      // part is halfway out of frame and the incoming one is halfway resolved.
      // Fires ~10 times over the whole page, so a setState from inside the frame
      // loop costs nothing. The diagram gets a caption of its own, claimed once
      // the parts are visibly on their way down.
      //
      // -1 while the wordmark is still the subject. Past the morph the assembled
      // machine has its own caption (stage 0) for the whole of B_TABLE, which the
      // capture walk never managed to give it: `pos` is pinned at 0 through those
      // beats, so a caption derived from `pos` alone claimed the first subassembly
      // over the logo from the first pixel of the page.
      //
      // Stage indices, not layer indices — the two are offset by one, because
      // stage 0 is the assembled table and the CAD carries only the eight
      // subassemblies. So beat k names the layer it is about to take off, k + 1.
      const shown =
        p < MORPH_END
          ? -1
          : fe > 0.25
            ? walk.length + 1
            : p < WALK_START
              ? 0
              : Math.min(walk.length, 1 + Math.round(pos));
      if (shown !== layerSeen.current) {
        layerSeen.current = shown;
        onLayer?.(shown);
      }

      // Frame what is still on the machine: the walk starts on the whole 5-unit
      // table and ends on a 1.1-unit box, so hold each state to the clear band and
      // keep its own centre on the camera's axis. Ramped in on the morph — while
      // the word is still readable it must be untouched, at its own scale and
      // centred, exactly as before.
      const zoom = lerp(zooms[i0], zooms[i1], t);
      fit = lerp(1, zoom, rf);
      let finCentre = 0;
      if (finale && fe > 0) {
        // Pull back to the whole drawing, through the identical two constraints:
        // the stack is ~11 units tall against a ~9-unit frame, and on a phone it is
        // the WIDTH that runs out first. finale.halfH is already measured up the
        // screen, so the vertical term needs no further tilt correction.
        const diagram = Math.min(
          FIT_ZOOM_MAX,
          FIT_MARGIN * Math.min(clearHalf / finale.halfH, halfWAll / finale.radius)
        );
        // Isolating a layer refits the frame to that layer, through the same two
        // constraints — it is the identical calculation with one part's extents
        // instead of the whole stack's, which is what keeps the band clearance and
        // the phone-width case honest in the focused state for free.
        let target = diagram;
        if (focGeo) {
          const close = Math.min(
            diagram * FOCUS_GAIN_MAX,
            (FOCUS_FILL * FIT_MARGIN * Math.min(clearHalf, halfWAll)) / ins.fitR.x
          );
          target = lerp(diagram, close, focFrame);
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
        // The column only matters once there is a caption in it. Captions appear at
        // the start of the walk, so this rides the table beat that precedes it (see
        // tableIn): the model is already seated when the text arrives, instead of
        // sliding out from under copy the reader has started on.
        const res = tableIn;
        if (res > 0) {
          const claim = (reservePx + CAPTION_GUTTER) * perPxAll;
          // The subject's half-extent in its OWN space — a beat's `radius` is
          // the max of its half-extents, so a tall narrow part reads as wider than
          // it is, which errs the safe way.
          const walkRad = lerp(walk[i0].radius, walk[i1].radius, t);
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
          const rad = focGeo ? lerp(radObj * spread, ins.fitR.x, focFrame * fe) : radObj * spread;
          if (rad > 1e-6) {
            // The corridor between the two columns of text: the caption on the
            // left, and — once a part is isolated and big enough to reach it —
            // the subassembly rail on the right. The rail's claim is scaled by
            // the isolation because the assembled diagram never gets near it, and
            // reserving width for a rail the model already clears would only
            // shrink the closing shot for nothing.
            const claimR = (reserveRightRef.current ?? 0) * perPxAll * focFrame * fe;
            // Only if the subject cannot fit the clear width even pushed hard
            // right does it have to shrink. This is what keeps the diagram as
            // large as the frame allows instead of shrinking it on principle.
            const availHalf = Math.max(0.5, halfWAll - (claim + claimR) / 2);
            fit = lerp(fit, Math.min(fit, (availHalf * FIT_MARGIN) / rad), res);
            // Left edge sits at shiftX - rad*fit and must clear -halfW + claim;
            // the right edge at shiftX + rad*fit must clear halfW - claimR. Push
            // only as far as the first demands, and never past what the second
            // allows — the fit clamp above is what guarantees those two can both
            // be satisfied.
            const need = claim - halfWAll + rad * fit;
            const room = halfWAll - claimR - rad * fit;
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
          ? lerp(finale.centreY, ins.cenY.x * cosPitch + ins.seat.x, focFrame)
          : finale.centreY;
        finCentre = (cen * fit - (bandTop + bandBottom) / 2) * fe;
      }

      // Two centrings, blended. The walk centres each beat's subject on its own axial
      // middle, which is an object-space offset and so has to be rotated with the
      // group. The diagram is stacked up the screen instead, so its centring is
      // already a world-space shift and must NOT be rotated — running it through
      // the pitch is what would slide the stack off the top of the frame.
      const cy = lerp(walk[i0].centreY, walk[i1].centreY, t) * fit * rf * (1 - fe);
      grp.position.set(
        // The pitch is about X, so a world +x shift stays horizontal on screen and
        // needs none of the cos/sin correction the vertical centring does.
        shiftX,
        -cy * cosPitch - finCentre,
        -cy * sinPitch
      );
    }
    // The machine itself: the layer walk, then the closing diagram. The parts are
    // children of the same group as the particle cloud, so they inherit the
    // framing, the tilt and the centring for free and land registered against the
    // dust they solidify out of. Each descends onto its seat along `axis` — the
    // same one the teardown lifted it out on — and the stagger runs bottom-up, so
    // the drawing assembles the way a hand would lay the parts out: chassis first,
    // outer shell last.
    if (cad) {
      // How hard the walk is pointing at anything at all. Rides the table beat in,
      // so the assembled machine gets one beat of being nothing but itself, and is
      // taken back out by `fe` so the diagram is handed over clean for the pointer.
      // WHICH layer it points at is a per-layer distance below.
      const deckEmph = tableIn * (1 - fe);
      // The light rig and the eye, resolved ONCE. Nothing in either varies by
      // layer: the diagram is deliberately lit by directional lights so that the
      // cabinet at the top of the stack and the electronics box at the bottom read
      // the same, and there is one camera. Per layer this was four lerps and a
      // 4x4 matrix multiply eight times over, for eight identical answers.
      //
      // The rig crosses from the assembled close-up to the diagram it was actually
      // fitted for, on the same ramp that pulls the camera back. The endpoints are
      // literal, so at fe = 1 the finale is bit-for-bit the shot the fit was
      // measured against; everything before it is the walk's own condition. See the
      // WALK_* block for why the two differ.
      const rigExposure = lerp(WALK_EXPOSURE, CAD_EXPOSURE, fe);
      const rigAmbient = lerp(WALK_AMBIENT, CAD_AMBIENT, fe);
      const rigAo = lerp(WALK_AO, CAD_AO, fe);
      const rigAoDirect = lerp(WALK_AO_DIRECT, CAD_AO_DIRECT, fe);
      // The specular half of the shading needs the eye, and the camera drifts with
      // the pointer every frame. See uCamPos in the fragment shader for why three's
      // own cameraPosition — and viewMatrix, hence uViewProj — are not good enough
      // here: three refreshes them on a program or camera-object change, not once a
      // frame.
      const viewProj = viewProjRef.current
        .copy(camera.projectionMatrix)
        .multiply(camera.matrixWorldInverse);
      for (let ci = 0; ci < cad.length; ci++) {
        const c = cad[ci];
        // How far through its own removal this layer is. Beat ci takes off layer
        // ci, so the walk position minus the index is exactly its progress —
        // 0 while it is still buried under the beats above it, 1 once it is gone.
        // The LAST layer never comes off; see the note where `pos` is derived.
        const rem =
          walk && ci < walk.length - 1 ? clamp01(layerPos - ci) : 0;
        // Travel to leave, in frame-heights of the framing THIS layer is removed
        // under — not in layer radii. Each beat is fitted to the clear band, so a
        // fixed world distance clears the viewport for the 5-unit cabinet and does
        // not come close for the stack left at the end of the walk. Sized against
        // the camera at rest, the widest the frame ever gets, so it always clears.
        const exit =
          walk && zooms && ci < walk.length
            ? (PEEL_LIFT_FRAMES * CAM_HALF_H) / zooms[ci] + c.radius
            : 0;
        // Late, and eased in: the part has to be properly porous before it moves,
        // or an opaque shell drags across the very layer it is uncovering. The
        // clamp is load-bearing, not decorative — before PEEL_LIFT_START the
        // argument is negative and a cubic keeps the sign, so an unclamped ease
        // would push the layer DOWN into the machine for the first half of its own
        // beat. Same ease(clamp01(...)) shape as every other ramp in this loop.
        const lift =
          easeInCubic(clamp01((rem - PEEL_LIFT_START) / (1 - PEEL_LIFT_START))) * exit;
        const land = smoothstep(clamp01((fe - c.lag * FINALE_STAGGER) / (1 - FINALE_STAGGER)));
        // The isolation, as a DISSOLVE. Every layer is fully out of the way at
        // sel >= 0 except the chosen one — not ghosted at 6% for context, which was
        // the first instinct: a ghost keeps all eight layers in the TRANSPARENT
        // pass, and the note below on early-z is why that costs more than it is
        // worth on the most expensive beat of the page. The rail on the right is
        // where the context went instead.
        //
        // A fixed RATE, not a damping, for two reasons that both matter here. It
        // lands exactly and in a bounded time, so a step is over when it looks over
        // rather than trailing an exponential nobody can see but the idle check
        // can; and a rate is the only thing that can be SEQUENCED, which is what
        // stops the swap being a cross-fade. See the SWAP_* constants.
        const wanted = sel < 0 || sel === ci;
        const rate = reducedMotion.current ? 1 : dtc / SWAP_S;
        // Reduced motion cuts, and the handoff lead has to be cut with it — `held`
        // is read one frame stale, so at this rate the outgoing part still measures
        // as fully present on the frame it disappears, the gate holds the incoming
        // one back, and the step costs a BLANK FRAME. Traced: exactly one, every
        // time. A lead of 1 is no lead, which is what a cut means.
        const lead = reducedMotion.current ? 1 : SWAP_HANDOFF;
        if (!wanted) c.dis = Math.min(1, c.dis + rate);
        // The incoming part waits until the outgoing one is mostly gone. Gated on
        // the whole frame rather than on one named predecessor, so stepping again
        // mid-swap — or clicking a third part from the rail — simply means there is
        // more to clear, and the arriving part waits for all of it.
        else if (held <= lead) c.dis = Math.max(0, c.dis - rate);
        // Drawn at all, and pointable at all. A hard function of the dissolve
        // rather than a fade of its own: at dis == 1 the shader has discarded every
        // fragment, so nothing about this step is observable, and it keeps `fin`
        // free to mean the LANDING and nothing else.
        c.alpha = c.dis >= 1 ? 0 : 1;
        // Hover is per layer and damped, so crossing a boundary is a swap rather
        // than a flicker, and a pointer skimming across the stack does not strobe.
        c.hot = damp(c.hot, ins.hot === ci && sel < 0 ? 1 : 0, ORBIT_RATE, dtc);
        // Where this layer sits relative to the front of the walk, in beats.
        // Positive means still buried under it, zero means it is the one coming
        // off, negative means it has already gone.
        //
        // A DISTANCE, not a floor() of the walk position. Keyed on the integer beat
        // the emphasis stepped at every boundary: layer k+1 went from fully dimmed
        // to fully lit in one frame while the six under it all released their dim
        // in the same frame, so the entire visible machine changed grade seven
        // times across the walk, each time landing exactly on the start of a hold —
        // the one moment the beat is asking to be read as a still.
        const dd = ci - layerPos;
        // Peaks on this layer's own hold and releases over the first 40% of its
        // removal, which is what the emphasis is for: it says "this one next", and
        // once the layer is visibly leaving that has been said.
        const hotW = Math.max(0, 1 - Math.abs(dd) / WALK_EMPH_REACH);
        // Complementary, and deliberately non-overlapping: a layer is never both
        // lit and pushed back. Full for anything a beat or more down, released as
        // the front arrives at it.
        const dimW = clamp01((dd - WALK_EMPH_REACH) / (1 - WALK_EMPH_REACH));
        // Two regimes share these channels. During the walk the layer about to
        // come off is lit and the ones still buried under it go back a little, so
        // the eye is told where the next move happens; during the hold beat the
        // pointer owns them. They cannot both be live, so the larger wins rather
        // than needing a blend: the walk's term is already scaled to zero by `fe`
        // before the diagram is pointable.
        c.material.uniforms.uHot.value = Math.max(c.hot, deckEmph * hotW * WALK_HOT);
        // The acid rim is the POINTER's channel alone — see uAccent in the shader.
        c.material.uniforms.uAccent.value = c.hot;
        // Everything that is not the thing being pointed at goes back. Keyed on
        // whether ANY layer is hot rather than on this one being cold, so with the
        // pointer off the diagram all eight sit at full strength.
        const insDim = sel >= 0 ? 0 : ins.hot >= 0 && ins.hot !== ci ? 1 - c.hot : 0;
        c.material.uniforms.uDim.value = Math.max(insDim, deckEmph * dimW * WALK_DIM);

        // `appear` is real transparency and travels as uniform alpha; the two
        // dissolves are spent per fragment against the detail channel, so they stay
        // out of `fin` and go down uPeel instead.
        const fin = appear * c.alpha;
        // The teardown's removal and the isolation's swap are the same effect on
        // the same channel and can never both be live — the walk's term is scaled
        // out by `land` before the diagram is pointable — so the larger wins rather
        // than needing a blend. Smootherstep on the swap alone: the walk's is
        // already shaped by the beat curve that produced `rem`.
        const peel = Math.max(rem * (1 - land), smootherstep(c.dis));
        // A fully evaporated layer is not merely invisible, it is not drawn: at
        // the end of the walk that is six of the eight, and skipping them takes
        // their vertex work and their discarded fragments off the frame entirely.
        c.root.visible = fin > 0.002 && peel < 0.999;
        if (!c.root.visible) continue;
        // Which of the two programs this layer draws with. A pure function of
        // scroll like everything else here, computed fresh every frame rather
        // than latched on an edge, so scrubbing backwards through a beat boundary
        // cannot leave a layer on the wrong one. It changes on the two frames a
        // beat where the dissolve starts and ends — four to thirty-seven
        // assignments, twice — and buys early-z and tile-based HSR back for every
        // seated layer for the rest of the page. See the dissolve block in
        // CAD_FRAG.
        const want = peel > 0 ? c.peelMaterial : c.material;
        if (c.meshes[0].material !== want) {
          for (const im of c.meshes) im.material = want;
        }
        // Blend only while this layer is actually fading. Once it is seated, hand it
        // to the OPAQUE pass: three sorts opaque objects front-to-back, so early-z
        // throws away the hidden layers before shading them, whereas the transparent
        // pass sorts back-to-front and shades every one of the eight stacked layers
        // in full. Same pixels, a fraction of the fragment work — and at fin == 1
        // there is no alpha left to blend anyway. No needsUpdate: neither flag feeds
        // a shader define, so this costs nothing but a render-list bucket change.
        //
        // Only ever asked of the solid variant: the peel one is transparent by
        // construction, because a dissolving layer always has fragments at partial
        // alpha in it.
        const solid = fin >= 0.999 && peel <= 0;
        if (c.material.transparent === solid) {
          c.material.transparent = !solid;
          c.material.blending = solid ? THREE.NoBlending : THREE.CustomBlending;
        }
        // From wherever the walk left it to its seat on the explode axis. A layer
        // the walk lifted out of frame flies back down; the one it never removed
        // (the electronics box, whose seat IS the datum at zero) does not move at
        // all, which is exactly right — the diagram is built on it.
        //
        // `land`, not `fin`: the flight is the LANDING, and folding the isolation
        // opacity into it would send every unselected layer back into the air on
        // its way out instead of simply fading where it sits.
        c.root.position.copy(axis).multiplyScalar(lerp(lift, c.seatY, land));
        c.material.uniforms.uFade.value = fin;
        // Unwinds against the landing, so each part re-forms from its own tracery
        // as it flies to its seat rather than popping back whole. Staggered for
        // free: `land` already is.
        c.material.uniforms.uPeel.value = peel;
        // One material per layer, so the shared rig has to be written into each of
        // them — but it is the same eight numbers and the same matrix every time.
        c.material.uniforms.uExposure.value = rigExposure;
        c.material.uniforms.uAmbient.value = rigAmbient;
        c.material.uniforms.uAo.value = rigAo;
        c.material.uniforms.uAoDirect.value = rigAoDirect;
        c.material.uniforms.uCamPos.value.copy(camera.position);
        c.material.uniforms.uViewProj.value.copy(viewProj);
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
          // A layer the isolation has taken away is not pointable — otherwise
          // clicking the empty frame beside an isolated part would silently select
          // whatever invisible layer's box happens to be there. Tested on the
          // dissolve rather than on `alpha`, which now only says "drawn at all":
          // half way through a swap the outgoing part is still being rasterised as
          // tracery, and a click landing then must not re-open the part the visitor
          // has just stepped off.
          if (!c.root.visible || c.dis > 0.5) continue;
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
    // Thin by a stride, not by a count. The cloud is one set — the word's
    // particles, which are points sampled on the machine's own surface — so there
    // is no live span to scale against and the whole of it is always in play.
    const stride = Math.max(1, Math.round(1 / GOV_COUNT[g.level]));
    const camKey = camera.position.x + camera.position.y * 7.1 + camera.position.z * 13.3;

    // Once the mesh has taken the machine over, stop paying for the cloud
    // entirely.
    //
    // uSplatOut reaches 1 at SOLID_END — the end of the morph — after which every
    // particle is multiplied by zero. It was still costing a full frame's work:
    // alpha-blended instanced quads rasterised and shaded to write nothing, plus
    // the counting sort re-run on every frame the camera moved, which is every
    // frame, because the pointer parallax never settles. That was running
    // underneath a million-triangle CAD diagram, which is why the finale was the
    // slowest beat on the page.
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
        stride
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
    // Shapes onto the GPU by the byte, while the machine is still nowhere near
    // the screen. See the note on `warm` for what this is buying back.
    //
    // BOTH GATES MOVED WHEN THE TEARDOWN CAME OFF THE GAUSSIANS, because both
    // were written for a page where the CAD was one closing beat. The stand-down
    // was `fe > 0`, i.e. 763vh — but the meshes are now first drawn at SOLID_START,
    // 105vh, so the guard could no longer fire before the geometry was needed and
    // was dead. And the start was `intro.current >= 1`: 2.4 s of wall clock, on a
    // page whose pacing leash lets a fling from the top reach 275vh. A visitor who
    // moved the wheel in those 2.4 s therefore arrived at the assembled table with
    // zero bytes uploaded and took the whole 19 MB on one frame — the exact stall
    // this block exists to prevent, relocated onto the morph handover, which is
    // already the most expensive frame of the page.
    //
    // So: start as soon as there is anything to draw, and stand down when the
    // machine actually appears rather than when the diagram does.
    const wm = warm.current;
    if (cad && !wm.done) {
      if (appear > 0) {
        // On screen. Everything visible has uploaded on its own by now, and any
        // remaining 1x1 renders would be stacked on top of a full frame instead of
        // an empty one. Stand down and let the rest upload as they are drawn,
        // which is exactly what happened before any of this existed.
        wm.done = true;
        wm.rt?.dispose();
        wm.rt = null;
      } else if (g.frame > 1) {
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
          // Not `g` — that is the governor, three lines of scope up, and the
          // shadow was one careless edit away from a very confusing bug.
          const geo = c.geometries[si];
          spent += (im.instanceMatrix.array as Float32Array).byteLength;
          if (geo.index) spent += (geo.index.array as ArrayBufferView).byteLength;
          for (const key in geo.attributes) {
            spent += (geo.attributes[key].array as ArrayBufferView).byteLength;
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
          // And once more with the dissolve variant, on the first shape only.
          // compileAsync has already linked it (see the compile effect), but a
          // link is not a draw, and some drivers do their last specialisation
          // when a program is first actually used. Every shape shares one
          // attribute layout, so one draw covers all 120 — and it happens here,
          // 100vh before the first removal, rather than on the frame the cabinet
          // starts coming apart.
          if (wm.shape === 0) {
            im.material = c.peelMaterial;
            gl.render(scene, camera);
            im.material = c.material;
          }
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
    // Gated on the CLOUD being gone rather than on `fe`: uTime advances every
    // frame and is not in this sum, so while the cloud is still drawn its simmer
    // would be skipped over. By the time this can be true it is
    // multiplied out to nothing and the mesh is not drawn at all.
    //
    // Worth saying plainly, because the threshold moved a long way and nothing
    // recorded it: `splatsGone` used to sit deep in the finale, when the cloud was
    // nine gaussian captures. It now fires at SOLID_END — 149vh of 940 — so this
    // skip covers the ENTIRE WALK, not just the closing beat, and parking at any
    // hold in the teardown costs nothing at all. That is the largest single saving
    // on the page. It is sound because everything not in the hash below (uAccent,
    // uExposure, uAmbient, uAo, uAoDirect) is a pure function of `p`, which is, and
    // because driveScroll and spring() both ARRIVE rather than approaching forever.
    //
    // uPeel used to be on that list, on the same "pure function of p" grounds, and
    // it is IS in the hash now because that stopped being true: the isolation swap
    // sweeps it on a clock of its own. The framing moves during most of a swap and
    // would have covered it by accident, but only most — a swap whose camera has
    // already arrived while the new part is still forming would have frozen the
    // dissolve half way, on the one beat a visitor is looking straight at it.
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
            u.uPeel.value * 419 +
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

// Adaptive quality governor. The particle cloud is fill-rate-bound on weak GPUs
// (Safari's WebGL runs this at a fraction of Chrome's throughput; phones have a
// fraction of desktop fill). Rather than sniffing browsers, watch the real frame
// cadence and walk a quality ladder: first render scale (dpr), then particle
// density. Every animation beat stays identical — degradation is only resolution
// and grain density. Recovers (with hysteresis) up to the initial
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
// Rungs 2 and 3 used to share a render scale of 0.72, on the understanding that
// what separated them was the particle density below. That stopped being true
// when the teardown moved onto the CAD: GOV_COUNT is read in exactly one place,
// the sort stride, and that sits inside `if (!splatsGone)` — so from SOLID_END,
// 149vh of a 940vh hero, the density lever moves nothing that is drawn. Rung 3
// was then a literal no-op over 84% of the page, and the consequence was worse
// than a wasted step: every demotion is a probe, so a device that walked 2 -> 3
// measured no gain, concluded resolution was not its problem, and pinned
// `floor` at 2 — permanently, for the rest of the page, including the finale
// where rungs 3 and 4 genuinely would have helped. The only escape was
// GOV_LEAP_MS, so a device sitting at 30-40 fps, which is exactly the population
// this ladder exists for, dead-ended.
//
// So every rung now moves the one lever that is live on every beat. Each step is
// 26-30% fewer pixels: comfortably clear of GOV_MIN_GAIN and of vsync
// quantisation, which is what a probe needs in order to mean anything.
const GOV_DPR = [1, 0.85, 0.72, 0.62, 0.52];
// Density is applied as a stride (draw every Nth particle of the cloud), so these
// quantise to 1/round(1/x) — keep them at reciprocals of whole numbers or a rung
// silently does nothing. 0.7 used to round to a stride of 1, i.e. no thinning at
// all on the second-worst tier. It only bites over the word and the morph, which
// is the only stretch of the page where the cloud is drawn at all.
const GOV_COUNT = [1, 1, 1, 0.5, 1 / 3];
const GOV_MAX_LEVEL = GOV_DPR.length - 1;
// Sustained above this => degrade. It was 26 ms, which is 38 fps, and that left a
// band where the governor watched a device judder and did nothing: anything
// between 38 and 80 fps sat at full quality for ever, because the recovery
// threshold below is the other edge. A machine holding a steady 45 fps is the
// exact case this ladder exists for — it is fast enough never to trip a 38 fps
// floor and slow enough that every third vsync is missed on a 60 Hz panel and two
// in three on a 120 Hz one, which reads as judder rather than as slowness.
//
// 20 ms is ~50 fps, and the margin above the 16.7 ms vsync floor is deliberate:
// a device that is comfortably holding 60 fps measures 16.7 ms because that is
// what vsync hands it, not because it is struggling, and it must not be demoted
// for that. Anything sustained above 20 ms genuinely is not keeping up.
const GOV_SLOW_MS = 20;
// Sustained below this => try recovering. Left at 12.5 ms on purpose even though
// it is under the 60 Hz vsync floor and therefore unreachable on such a panel:
// the probe is what recovers those devices. Every demotion records the EMA it was
// made at and hands the rung straight back if the gain did not clear
// GOV_MIN_GAIN, so a 60 Hz device that demotes for no benefit is returned within
// a cooldown, and only a 120 Hz one can climb on this number alone.
const GOV_FAST_MS = 12.5;
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

    // The rig is what kept the page RENDERING long after it had stopped MOVING,
    // and the fix is the threshold rather than the rate.
    //
    // Camera z is not only the camera: halfVAll is derived from it, which sets the
    // clear band, which sets every beat's fit, which is the GROUP'S SCALE. So a
    // dolly still creeping is a model still resizing, and the exact idle check
    // downstream sees that and re-renders 1.07M triangles for it. Measured on the
    // real GPU by watching the model's own world matrix after a flick: the picture
    // stopped at 1.3s and the page drew until 3.2s. Rate 3 against damp()'s default
    // 1e-4 is 3.07s to arrive — that number exactly.
    //
    // Rate 6 was the obvious fix and is NOT taken. It works, and it costs more than
    // it saves: scrubbing the hero end to end, late frames went from 0.3% to 10.2%
    // and p95 from 18.7ms to 23.0ms. Ten percent of frames missed during continuous
    // scrolling is precisely the symptom this whole exercise is about, and trading
    // it for invisible settling would be trading the complaint for the cure.
    //
    // So the motion is left exactly as it was and only the arrival moves. One world
    // unit of camera z at z ~= 10 changes the projected scale by about a tenth of
    // its own value in pixels, so 1e-3 is a tenth of a pixel of travel still to
    // come — invisible, and 2.3s to reach instead of 3.07s.
    const EPS = 1e-3;
    // X and Y are the POINTER parallax and are deliberately soft — a camera that
    // snaps to the cursor reads as a cursor, not as a camera.
    camera.position.x = damp(camera.position.x, state.pointer.x * 0.8, 3, dt, EPS);
    camera.position.y = damp(camera.position.y, state.pointer.y * 0.5, 3, dt, EPS);
    camera.position.z = damp(camera.position.z, targetZ, 3, dt, EPS);
    camera.lookAt(0, 0, 0);
  });

  return null;
}

// ------------------------------------------------------- multisampling
// Every frame that draws the machine — which is now most of the page — goes
// through a multisampled buffer and is blitted down.
//
// It cannot be done with the canvas's own `antialias` flag, which is why this
// exists at all: that flag is fixed when the context is created, and turning it
// on would apply MSAA to the PARTICLE pass as well — a hundred and fifty thousand
// alpha-blended quads, several deep, where every covered sample is a separate
// blend. So the gate is `ins.solid`, which is exactly the threshold that stops
// drawing the cloud: the multisampled pass and the alpha-blended pass can never
// overlap, by construction rather than by tuning.
//
// That was reasoning, and it has now been measured, because the offscreen path is
// not cheap and it was worth knowing whether it was buying anything. Built with
// `antialias: true` on the context and this whole path removed, on an Apple M4 at
// 1440x900 dpr 2 (GPU time, median of ~420 frames):
//
//   beat        offscreen 4x    canvas antialias
//   word             3.06 ms          7.18 ms     cloud only
//   morph            9.72 ms         35.35 ms     cloud and mesh together
//   belt/hold        8.50 ms          5.65 ms     mesh only
//
// So the trade is real in both directions and much sharper than the prose above
// suggests. On the solid beats the canvas flag is BETTER — it saves the whole
// offscreen path and its own multisampling costs 0.6 ms, because the resolve
// happens in tile memory. On the morph it is a catastrophe: three and a half times
// the frame, twenty-five milliseconds, from multisampling a cloud whose quads have
// no silhouette worth sampling in the first place. The alpha-blended pass is
// exactly what this argument said it was.
//
// Which leaves the offscreen target as the only way to have it on one and not the
// other, and it is kept for that reason and no other.
//
// This used to be gated on the closing diagram alone, and that is why the walk
// aliased. The reasoning behind that gate was sound while everything before the
// diagram was gaussians — soft gaussians genuinely cannot alias — but the walk is
// now 468vh of perforated tracks, ring gears and the lip of every disc, which is
// the most alias-prone content on the page and had no anti-aliasing at all.
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
// Rung 3 keeps two samples where it used to drop to none. That zero was set when
// multisampling covered ONE BEAT — the held diagram, a still picture — so losing it
// cost a still frame some edge quality and bought back two thirds of a frame. It
// now covers roughly 80% of the page, all of it moving and all of it hard-edged
// CAD, and a mid-ladder rung that turns anti-aliasing off entirely is a visible
// cliff rather than a graceful degradation. The floor still drops it.
//
// THE LAST RUNG IS NOT THE SAME KIND OF STEP AS THE OTHERS, and the numbers say so
// far more loudly than the shape of this array does. Zero does not mean "two fewer
// samples" — it takes the branch in DiagramMsaa that skips the offscreen target
// altogether and renders straight to the canvas, so it drops the whole second
// framebuffer, its depth attachment and its resolve. Measured on an Apple M4,
// Chrome, 1440x900 dpr 2 (the pixel budget's own cap, 5.15 Mpx), GPU time for the
// held diagram by EXT_disjoint_timer_query, median of ~420 frames.
//
// The sample count can be forced from outside by hooking
// renderbufferStorageMultisample, so these three are one run and directly
// comparable:
//
//   render target, 4x     8.00 ms
//   render target, 2x     7.22 ms      <- one rung of this array:  -0.78
//   render target, 1x     6.77 ms
//
// Losing the target needs this array set to zeroes and a build, so it is a
// separate run with its own control, and run-to-run spread here is about 6%:
//
//   render target, 4x     8.50 ms
//   no render target      5.04 ms      <- the last rung:           -3.46
//
// So all the sample steps together are worth about a millisecond and the trapdoor
// at the end is worth three and a half. Anyone tuning this array should know that
// before reading it as a smooth ramp.
//
// It also differs by a factor of five between GPU classes, which is why the AMD
// Renoir table at PIXEL_BUDGET_SOLID and this one disagree and why both are kept.
// There, multisampling was two thirds of the frame; here the entire offscreen path
// is 41% and the samples themselves are 9%. Renoir is immediate-mode and
// bandwidth-poor, so four samples really are four times the traffic; the M4 is a
// tiler and keeps them in tile memory, where the cost that remains is the extra
// full-size attachments and the resolve rather than the sampling. A ladder that
// drops multisampling first is right for the first machine and close to a no-op on
// the second — which is an argument for the governor measuring rather than for
// picking a different fixed order, and it already does.
const MSAA_BY_LEVEL = [4, 2, 2, 2, 0];

// What has to be roughly constant is SAMPLES PER CSS PIXEL, not the MSAA count,
// and the array above is a governor ladder rather than a statement about the
// display. Left alone it hands every device 4x regardless of how much the render
// scale already bought, which is the "paying twice for one thing" the note at
// PIXEL_BUDGET_SOLID warns about -- and it warns about it while the code does it.
//
// A CSS pixel is an angular unit, near enough constant across devices by design,
// so scale^2 * samples is a fair perceptual currency. Priced that way the spread
// was never defensible:
//
//   2560x1330 dpr 1   scale 1.24   4x   ->  6.1     the 27" 1440p desktop
//   1728x1080 dpr 2   scale 1.67   4x   -> 11.1
//   1440x900  dpr 2   scale 2.00   4x   -> 16.0
//   390x844   dpr 3   scale 1.75   4x   -> 12.2     a phone
//
// The panel that can least afford a stair-step was getting the FEWEST samples,
// and a phone -- densest display, smallest screen, weakest GPU, and the one place
// a dropped frame is most likely -- was getting twice the desktop's.
//
// So: top up to a target instead of always spending the maximum. The multisample
// cost is per pixel and the render scale already multiplies it, so this is where
// the saving is largest on exactly the devices that need it most.
const AA_TARGET_SAMPLES = 7;

// Small screens never take 4x. The density argument already lands them on 2, and
// this makes it a floor rather than an accident of the arithmetic: a phone is the
// densest display and the weakest GPU on the list, and the offscreen target that
// multisampling requires is itself the single most expensive item on the ladder
// (measured: 3.46 ms on an M4, against about 1 ms for every sample step combined).
const MSAA_SMALL_CAP = 2;

// Never below 2 here. Zero is not "fewer samples" -- it takes the branch in
// DiagramMsaa that drops the offscreen target altogether, and that is the
// governor's trapdoor to spend on evidence, not a resolution to guess at.
function msaaCeiling() {
  if (typeof window === 'undefined') return MSAA_BY_LEVEL[0];
  const scale = baseDpr(true);
  const want = AA_TARGET_SAMPLES / Math.max(1e-6, scale * scale);
  const ceil = want >= 3 ? 4 : 2;
  return window.innerWidth < 820 ? Math.min(ceil, MSAA_SMALL_CAP) : ceil;
}

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
      // Advanced only over frames that were actually DRAWN, which is not the same
      // question as whether the frame is skippable and used to be conflated with
      // it. This read `!idle.current.can`, on the understanding that `can` meant
      // "the diagram beat" — and it did, while `splatsGone` sat deep in the
      // finale. It now fires at SOLID_END, 149vh, so the dust stopped moving for
      // the remaining 791vh of the page, including the whole teardown, where
      // frames are being drawn one after another and freezing the motes buys
      // nothing at all.
      //
      // `drew` is the honest version of the same guard. It is last frame's value
      // (DiagramMsaa writes it at priority 1), which is exactly right: a skipped
      // frame contributes nothing, so the accumulate-through-skipped-frames snap
      // this was protecting against still cannot happen, and on the hold beat the
      // motes advance once and then stop with everything else.
      //
      // Deliberately NOT folded into `sig`. A mote rotation that changes the hash
      // it is gated by is a loop: every drawn frame would move the dust, every
      // move would change the hash, and the hold beat would render a million
      // triangles forever.
      if (idle.current.drew) {
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
  onFailed,
  onLayer,
  onQuality,
  selectRef,
  hoverRef,
  onHover,
  onSelect,
  onInspectable,
  onSolid,
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
  onFailed?: () => void;
  onLayer?: (i: number) => void;
  onQuality?: (level: number) => void;
  selectRef: React.RefObject<number>;
  hoverRef: React.RefObject<number>;
  onHover?: (i: number) => void;
  onSelect?: (i: number) => void;
  onInspectable?: (v: boolean) => void;
  // Whether the frame is solid geometry with no particle pass over it, which
  // is what decides multisampling. See the note beside ins.solid.
  onSolid?: (v: boolean) => void;
  // Multisampling: whether the frame is solid geometry at all, and how many
  // samples the governor's current rung allows. See DiagramMsaa.
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
        onFailed={onFailed}
        onLayer={onLayer}
        onQuality={onQuality}
        selectRef={selectRef}
        hoverRef={hoverRef}
        onHover={onHover}
        onSelect={onSelect}
        onInspectable={onInspectable}
        onSolid={onSolid}
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
    skip: string;
    loading: string;
  };
  stages: { title: string; text: string }[];
  // Copy for the hold beat: the prompt that says the diagram can be pointed at,
  // the way back out of an open part, and the rail's accessible name.
  inspect: { hint: string; close: string; rail: string; cycle: string };
}) {
  // The captions are indexed by the beat the scene reports, so there has to be one
  // for the assembled table, one per layer and one for the diagram. The layer count
  // is checked against the file where cad lands (see the walk useMemo); this is the
  // other half of the same invariant, and the pair of them is what stops the rail
  // showing eight entries beside a caption that claims seven.
  if (process.env.NODE_ENV !== 'production' && stages.length !== WALK_LAYERS + 2) {
    console.warn(
      `ScrollScene: ${stages.length} stage captions for ${WALK_LAYERS} layers; expected ${WALK_LAYERS + 2}.`
    );
  }
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
  // The geometry is not coming. Everything the hero says in words is static text
  // with no dependency on it, so on this path the copy is shown at full strength
  // and the shimmer is dropped — the alternative, and what shipped, was 940vh of
  // near-black with LOADING MODEL on it forever.
  const [failed, setFailed] = useState(false);
  const [inView, setInView] = useState(true);
  // Render scale, owned here because <Canvas> reasserts its `dpr` prop on every
  // render — see the GOV_DPR block. `quality` is the governor's rung; the base
  // is the pixel budget, re-measured on resize so dragging the window to another
  // monitor re-fits it.
  const [quality, setQuality] = useState(0);
  // Whether the frame is solid geometry with no particle pass over it. BOTH edge
  // quality levers hang off this one flag — the sample count and the pixel budget
  // — because they are sizing the same pass and must not be able to disagree
  // about which one it is. Keying them to `diagram` instead, which does not come
  // up until the last 9% of the page, is what left the entire 468vh walk aliased.
  // See ins.solid.
  const [solid, setSolid] = useState(false);
  const [dprBase, setDprBase] = useState(() => baseDpr());
  const [msaaCap, setMsaaCap] = useState(() => msaaCeiling());
  const handleQuality = useCallback((level: number) => setQuality(level), []);
  const handleSolid = useCallback((v: boolean) => setSolid(v), []);
  useEffect(() => {
    const fit = () => {
      setDprBase(baseDpr(solid));
      // Keyed to the SOLID scale whichever pass is live, so the ceiling does not
      // flap as `solid` toggles -- it is a property of the display, not the beat.
      setMsaaCap(msaaCeiling());
    };
    fit();
    window.addEventListener('resize', fit, { passive: true });
    return () => window.removeEventListener('resize', fit);
  }, [solid]);
  // Same fact the frameloop is gated on, readable from the scroll handler. It
  // matters there: out of view the canvas stops and the spring FREEZES, so a
  // leash that trusted a stale `drive.p` would pin the visitor inside a hero
  // that is no longer animating.
  const inViewRef = useRef(true);
  // -1 until the walk starts: the captions label stages, so there is nothing
  // to say while the page is still showing the word.
  const [layer, setLayer] = useState(-1);
  const handleReady = useCallback(() => setReady(true), []);
  const handleFailed = useCallback(() => setFailed(true), []);
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

  // Gesture state for the stack control. A ref and not effect-local bindings —
  // see the note inside the effect, which is where it was costing a step every
  // time the effect re-subscribed.
  const cycState = useRef({ acc: 0, last: 0, lastEvent: 0, spent: false, sx: 0, sy: 0 });

  // While a part is open the wheel drives the stack, not the page. Bound on
  // window and non-passive so it can cancel the scroll wherever the pointer
  // happens to be — the caption and the rail sit over the canvas, and a wheel
  // event lands on whichever of them is under the cursor.
  useEffect(() => {
    if (opened < 0) return;
    // ALL of this lives in a ref, and that is the whole fix for the stack racing
    // away under one flick.
    //
    // It used to be `let` bindings in this effect body, and `opened` is a
    // dependency of the effect — so every successful step tore the effect down
    // and built it again, which reset the accumulator, the gesture state AND
    // `last`. Resetting `last` is the one that did the damage: it is the cooldown's
    // own clock, so after the first step `now - last` was `now - 0`, the 340 ms
    // cooldown never applied again, and the rest of the flick stepped at whatever
    // rate the deltas arrived. Measured before the fix: one synthetic trackpad
    // flick walked four subassemblies. That is the "01 suddenly to 06".
    //
    // A ref survives the re-subscribe, so the cooldown and the gesture both mean
    // what they say.
    const st = cycState.current;

    const fire = (dir: number) => {
      const now = performance.now();
      if (now - st.last < CYCLE_COOLDOWN_MS) return false;
      st.last = now;
      st.acc = 0;
      cycle(dir);
      return true;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = performance.now();
      // A pause ends the gesture: the accumulator starts clean and the next step
      // is cheap again. Everything else is still the same flick.
      if (now - st.lastEvent > CYCLE_GESTURE_GAP_MS) {
        st.acc = 0;
        st.spent = false;
      }
      st.lastEvent = now;
      st.acc += e.deltaY;
      const need = st.spent ? CYCLE_WHEEL_REPEAT : CYCLE_WHEEL;
      if (Math.abs(st.acc) < need) return;
      // Spend it whether or not the cooldown lets this one through, and mark the
      // gesture spent either way. Banking the overflow against a refusal is the
      // second half of what let one flick walk the stack: the charge simply sat
      // there and discharged the instant the cooldown lifted.
      const dir = Math.sign(st.acc);
      st.acc = 0;
      st.spent = true;
      fire(dir);
    };
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      st.sx = t.clientX;
      st.sy = t.clientY;
      st.acc = 0;
      // A finger down is unambiguously a new gesture — there is no momentum tail
      // to confuse it with, which is why touch never needed the gap test.
      st.spent = false;
    };
    // Vertical only. A horizontal drag is the orbit's, and the canvas's own
    // pointer handler releases the vertical axis for exactly this.
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - st.sx;
      const dy = t.clientY - st.sy;
      if (Math.abs(dy) <= Math.abs(dx)) return;
      if (e.cancelable) e.preventDefault();
      // Up-swipe reads as "further down the stack", the same direction a wheel
      // down goes.
      if (Math.abs(dy) >= CYCLE_SWIPE && fire(dy < 0 ? 1 : -1)) st.sy = t.clientY;
    };
    // Deliberately NOT Home/End/Space: those stay with the page, so a keyboard
    // is never without a way out that is not Escape.
    //
    // Through `fire` rather than straight to `cycle`, so the arrows pay the same
    // cooldown the wheel does. A held ArrowDown autorepeats at about thirty a
    // second once the OS delay has passed, and called directly that spun the stack
    // exactly the way one trackpad flick used to — the fix for one is the fix for
    // the other. The refused repeats simply do nothing, which is what a key held
    // down against a transition should do.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault();
        fire(1);
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        fire(-1);
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
  const skipRef = useRef<HTMLButtonElement>(null);
  const paintProgress = useCallback((p: number) => {
    if (heroFadeRef.current) {
      // It used to be a flat 1 - p * 4.5, which reached zero at raw 0.222 — 77vh
      // past the arrival of the stage captions at 0.140. So the centred lockup copy
      // was still at 37% over "00 / 09 ENTIRE TABLE", and you could read PRECISION
      // ENGINEERING, EXCEPTIONAL QUALITY and SCROLL TO EXPLORE straight through the
      // table's legs. The slope predated the captions existing and only cleared the
      // table beat at all by coincidence.
      heroFadeRef.current.style.opacity = String(
        1 - smoothstep(clamp01((p - COPY_FADE_START) / (COPY_FADE_END - COPY_FADE_START)))
      );
    }
    // The skip control lets go once the diagram is assembled. It is an escape from
    // the TEARDOWN, and by then the teardown is over and the beat it would sit on
    // is the one asking to be pointed at — two competing prompts in the same corner
    // of the same frame. Fades over the finale rather than at a threshold so it
    // does not blink out mid-scroll, and stops taking the pointer once it is gone.
    //
    // Keyed on DOLLY_END, which is the finale's own end expressed on this axis —
    // `p` here is raw scroll, not scene progress, and the two 0.8-something
    // literals that used to be here were a guess at the conversion that landed the
    // button 38% visible on the beat it was written to stay out of.
    const s = skipRef.current;
    if (s) {
      const vis = clamp01((DOLLY_END - p) / SKIP_FADE);
      s.style.opacity = String(vis);
      const gone = vis < 0.05;
      s.style.pointerEvents = gone ? 'none' : 'auto';
      // Opacity alone leaves it in the tab order and readable to a screen reader,
      // so the visitor on the finished diagram can still land on a control that is
      // not on screen and be thrown back up the page by it.
      s.style.visibility = gone ? 'hidden' : 'visible';
    }
    if (railFillRef.current) railFillRef.current.style.height = `${p * 100}%`;
    const out = readoutRef.current;
    if (out) {
      const digits = String(Math.round(p * 100)).padStart(3, '0');
      if (out.textContent !== digits) out.textContent = digits;
    }
  }, []);

  // Where a SKIP is heading, while it is in flight. Null the rest of the time.
  const bypassRef = useRef<{ y: number; at: number } | null>(null);

  // Past the teardown in one move, for a visitor who came here to find a phone
  // number rather than to watch a machine come apart. The hero is 940vh; without
  // this, "skip it" means eight beats of scrolling or hunting for the nav.
  //
  // It has to say so EXPLICITLY, which is the part that was wrong. The leash reads
  // "deliberate" as "no gesture opened the chain", and `mark` is bound to
  // touchstart — so on a phone the tap that presses this button opens a chain, the
  // browser's smooth scroll then emits the same stream of ordinary scroll events a
  // fling does, and the leash clamps the lot to one beat further on. Tapping SKIP
  // advanced exactly one layer, and from the lockup it deposited the visitor INTO
  // the teardown at walk beat 1. The same fires on a mouse whenever the click lands
  // within GESTURE_MS of a wheel event; a quiet page and a mouse is the one case
  // that worked, which is presumably how it was tested.
  //
  // So the target is recorded and the leash stands down for the whole ride — see
  // the bypass in the scroll handler.
  const skipTeardown = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    let top = 0;
    let n: HTMLElement | null = el;
    while (n) {
      top += n.offsetTop;
      n = n.offsetParent as HTMLElement | null;
    }
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // Lands on the section AFTER the hero, not at the end of the hero — stopping on
    // the finished diagram is not skipping, it is arriving somewhere else in the
    // same beat.
    const to = top + el.offsetHeight;
    bypassRef.current = { y: to, at: performance.now() };
    // A 940vh smooth scroll is a long ride; under the preference it is also exactly
    // the kind of large unprompted movement being asked for less of. Cut instead.
    window.scrollTo({ top: to, behavior: reduced ? 'instant' : 'smooth' });
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

    // Which layer hold the walk last came to rest on, or null if it does not
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
      // The landing is a beat and gets a detent like every other one, so a release
      // part way through it finishes the landing rather than parking on a diagram
      // with half its layers still in the air.
      //
      // Past the landing, only a gesture that set off from BELOW it is pulled back.
      // The leash cannot do this part on its own: it is a pure function of where
      // the SCENE is, so it opens the moment the landing arrives, and the tail of
      // the very gesture that got you there runs on through the opening. Measured:
      // one flick off the beat-08 hold came to rest at 90.8%, five points past the
      // belt view it had just been leashed to. The snap is what closes that.
      //
      // And it must close it only in that direction. The hold beat is the way OUT
      // of the hero, so snapping a gesture that started there would make it a trap:
      // every attempt to leave answered by a jump back to the diagram.
      const leaving = rest === null || rest >= FINALE_BEAT;
      if (cur <= WALK_S0 || (cur >= DOLLY_END && leaving)) {
        rest = null;
        return;
      }
      // Clamped by the leash as well: releasing must not put scroll somewhere a
      // gesture could not have taken it, or a wheel turned faster than the
      // scene can walk would snap its way past layers the leash just refused.
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
      const y = window.scrollY;
      // A SKIP in flight. The leash has to stand down for the WHOLE ride, not just
      // for its first frame: a smooth scroll emits ordinary scroll events all the
      // way down, and if a chain was open when the button was pressed nothing
      // downstream would ever close it. Held until the page arrives rather than for
      // a fixed time — see SKIP_BYPASS_MS.
      const bypass = bypassRef.current;
      if (bypass && (Math.abs(y - bypass.y) < 2 || now - bypass.at > SKIP_BYPASS_MS)) {
        bypassRef.current = null;
      }
      // A gap this long ends the chain; the next event starts a new one, which
      // is gesture-driven only if a gesture just marked it.
      if (now - lastScrollAt > GESTURE_MS) {
        chainLive = now - gestureAt < GESTURE_MS;
        // Re-read the hold to step from at the top of every gesture, from where
        // the scene actually is. Carrying it over from the last snap instead
        // went stale the moment that snap declined to run — off view, under
        // PACE_MIN_FPS, under reduced motion — and a stale origin makes the
        // next release step the WRONG WAY: a nudge back off layer 4 that
        // thought it started at 3 reads as +0.7 and commits forward.
        const b = beatOf(d.p);
        rest =
          d.primed && b >= -BEAT_EPS && b <= FINALE_BEAT + BEAT_EPS
            ? Math.min(FINALE_BEAT, Math.max(0, Math.round(b)))
            : null;
      }
      lastScrollAt = now;
      if (bypass) {
        // Forget the gesture that opened the chain as well, so the momentum events
        // behind it cannot re-open one the moment the bypass closes.
        chainLive = false;
        gestureAt = -1e9;
      }

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

  // What the caption is naming. During the walk it is the layer on screen;
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
          onFailed={handleFailed}
          onLayer={handleLayer}
          onQuality={handleQuality}
          selectRef={selectRef}
          hoverRef={hoverRef}
          onHover={handleHover}
          onSelect={handleSelect}
          onInspectable={handleInspectable}
          onSolid={handleSolid}
          msaa={solid ? Math.min(MSAA_BY_LEVEL[quality], msaaCap) : 0}
        />
      </Canvas>
    ),
    [
      inView,
      dprBase,
      quality,
      // `solid` and not `diagram`, which is what the body actually reads and had
      // drifted out of sync with it. This list is the ONLY thing that gets the
      // sample count onto the canvas — the whole point of the memo is that this
      // subtree does not re-render for anything else — so a missing dependency
      // here is not a stale-closure smell, it is anti-aliasing that arrives
      // whenever some unrelated state happens to change next, or never. It
      // survived the last fix because `dprBase` moved on the governor's rungs and
      // dragged the memo along with it.
      solid,
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

        {/* Loading shimmer while the model binary streams in. Dropped once the
            fetch has definitively failed — a pulse that never resolves reads as a
            broken page, and the copy underneath is the thing worth showing. */}
        {!ready && !failed && (
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
          {/* Held back until the model is ready so it does not arrive over an
              empty frame — but shown on the failure path too, where there is
              never going to be a model and this copy is the only thing the page
              has left to say. */}
          <div
            className={ready || failed ? 'animate-fade-up [animation-delay:600ms]' : 'opacity-0'}
          >
            <p className="font-mono text-[11px] md:text-xs tracking-[0.4em] uppercase text-acid text-center mb-4">
              {hero.eyebrow}
            </p>
            <p className="font-mono text-xs md:text-sm uppercase tracking-[0.25em] text-smoke/80 text-center px-6">
              {hero.subtitle}
            </p>
          </div>
          <div
            className={`mt-10 flex flex-col items-center gap-3 ${
              ready || failed ? 'animate-fade-up [animation-delay:1200ms]' : 'opacity-0'
            }`}
          >
            <span className="font-mono text-[10px] tracking-[0.35em] uppercase text-mute">
              {hero.scrollHint}
            </span>
            <span className="block h-10 w-px bg-gradient-to-b from-acid/80 to-transparent animate-scroll-line" />
          </div>
        </div>

        {/* Skip the teardown. Outside the hero-copy overlay above, which fades out
            within the first fifth of the page — this has to stay reachable for the
            whole walk, which is the part being offered an escape from. Bottom
            right: the caption owns the left, the rail owns the middle right, and
            the inspect prompt owns the bottom left. */}
        <button
          ref={skipRef}
          type="button"
          onClick={skipTeardown}
          className="group absolute bottom-8 right-6 z-20 flex items-center gap-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-mute transition-colors hover:text-acid focus-visible:text-acid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-acid/60 md:bottom-10 md:right-8"
        >
          {hero.skip}
          <span aria-hidden className="transition-transform group-hover:translate-y-0.5">
            ↓
          </span>
        </button>

        {/* Stage caption — names the subassembly currently on screen, and the
            drawing once the teardown resolves into it. Sits on the left, clear
            of the model, and swaps at the midpoint of each removal: the outgoing
            part is halfway out of frame and the incoming one is still resolving,
            so the label never changes over a settled layer. */}
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
