# Issue 506: live visual follow-up

Reviewed implementation `eb590ba6` on 2026-09-22. **That review was not a clean visual pass.** The subsequent ibex correction and its validation are recorded below.

The full Terrace client connected over Colyseus to an isolated server and world on ports 15066/15067. The production WebGPU terrain renderer, mover parsers/interpolators, placement adapters and animated models were active. Close browser screenshots were inspected for raw ascent, descent and ascent falls, binomial ascent and descent falls, a mid-climb smoothing switch, and elongated eels at headings 0, 45 and 90 degrees near a submerged ledge.

The inspected pilgrim frames progress up/down the cliff, enter the fall animation, and finish on drawn support. The swimmer frames show clearance at the submerged ledge in raw and binomial modes. These observations support the coordinate and endpoint corrections; discrete captures do not establish frame-perfect animation or pacing across every transition.

## Remaining visual defect

The ibex's head/neck visibly penetrates the cliff during the climb. At some animation phases only the horn tips remain visible above the occluded head. This reproduces after switching the fixture to `walkerProfileOf('ibex')`, in both raw and binomial modes, with existing scene lights brightened for inspection. The raw capture at elapsed 2.4 seconds has server position `(223.59625, 218.5)`, `climbHeight: 61`, and face leg on a height-33/161 boundary at x=224.

The production ibex traversal uses its own climb speed but leaves body inset at the shared default measured from the pilgrim. The animated ibex head extends forward beyond that inset. This is a candidate explanation, not a completed diagnosis: baseline rendering has not been compared, so this review does not attribute the clipping to `eb590ba6`. Fixing continuous root placement alone does not establish clearance of the whole animated body. #364 and the overall visual sign-off remain open.

## Reproduction and evidence

- Temporary server preload: `C:/Users/<user>/.t3/worktrees/Terrace/issue-506-impl-20260922/.terrace-tmp/live-visual.mjs`.
- Grouped evidence, 23 inspected captures: `C:/Users/<user>/.t3/worktrees/Terrace/issue-506-impl-20260922/.terrace-tmp/issue-506-live-visual.html`.
- The local control endpoint on port 15068 selects/reset scenarios and pauses their simulation; shared `beginClimb`/`advanceClimb` and `climbWireOf` generate networked motion. The first runs synchronized all three movers with the pilgrim speed; later captures use production ibex/yeti traversal settings, changing only fall probability for repeatability.
- This is controlled live rendering, not autonomous gameplay: the preload supplies terrain and scenario actors instead of running their AI. Fallen actors remain at the terminal pose for inspection rather than being removed. Eel paths are prescribed while testing heading-dependent clearance. No client placement values were substituted.
- HUD visibility, camera collision/orbit updates and existing light intensities were overridden only for close inspection. Captures label the lighting change. An Artifact publishing tool is unavailable; screenshots are grouped in the local standalone evidence file as a fallback.
- The earlier unit, type, geometry and timing checks are unchanged. This follow-up does not claim exhaustive network, terrain-edit, species or performance coverage.
- Console review found individual wildlife, monsters, daynight and pilgrims frame-budget overruns (1.1-1.3 ms against 1 ms, each scheduling two skipped frames). Restart-related reconnect failures also appeared while switching the isolated server fixture. This session therefore does not establish a clean frame-pacing result.
- Owned browser page and isolated client/server/control endpoints were shut down after capture. No existing game world or unrelated process was modified.

## Ibex correction after visual review

The ibex now supplies its scaled animated forward reach to the shared client riser alignment helper. Its authored bound is 0.432 world units at medium size, covering the muzzle plus climb lean and the rearward reach during a fall; the previous default was the much smaller pilgrim body depth. Regression coverage builds the actual ibex geometry and checks its animated climb/fall bounds, then checks all three sizes and eight grid directions against a cliff. Diagonal reach uses a normalized direction so the bound remains a distance rather than expanding with the diagonal length.

An explicitly supplied body reach is enforced as an outward contact constraint instead of easing through solid terrain. Inward movement and the existing arrival interpolation still release the offset. This can cause an immediate lateral correction on entering contact. Terrain queries per probe, authoritative positions, server movement, and the other species' default clearance are unchanged. This corrects active face-leg/fall clearance; it does not implement whole-body collision for ordinary walking/standing, or change the artificial terminal poses retained by this fixture.

The same raw reproduction at elapsed 2.4 seconds (`climbHeight: 61`) now shows the full ibex head and horns outside the cliff. The matching binomial pose, raw descent, raw ascent fall, binomial descent fall, and binomial upper-ledge arrival were inspected in the networked game client. The upper arrival releases the offset onto drawn support. The captures establish the inspected poses, not exhaustive animation/pacing or all terrain shapes.

Before/after capture collection: `C:/Users/<user>/.t3/worktrees/Terrace/issue-506-impl-20260922/.terrace-tmp/issue-506-ibex-fix.html`. Artifact publishing remains unavailable, so this is a grouped local fallback.

Validation: 925 tests passed across client (790, one skipped), wildlife (59), pilgrims (23), and monsters (53). Workspace typechecking and ESLint on the four changed TypeScript files passed. The targeted wildlife and drawn-ground suites passed again after adding diagonal coverage. The previous broader issue limits, including full gameplay review and #504 integration, remain separate.
