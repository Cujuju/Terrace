# Building integration — 2026-09-23

The owner authorized production integration, a live Original/Low HUD selector, and five additional historical progression levels. The later request for new levels supersedes the earlier visual-variant choice.

## Runtime

All 23 building types, including the existing original Viking longhouse and temple, are installed in both quality variants. Only KTX2 runtime GLBs are referenced by the game. The old standalone timber-house file remains as historical source material but is no longer imported by the production plugin.

Settings → Buildings switches detailed geometry/2048 maps and simplified geometry/1024 maps without restarting the game or moving the camera. Assumption: Low is the initial default; the selected setting is saved locally. The panel includes live FPS from the existing HUD sampler. Keep the same scene and camera and allow loading/shader warmup to settle before comparing. This work does not claim a measured FPS difference.

All consumers prepare before either building set changes. A failed load retains the prior setting and disposes successful preparations. A world/plugin change during loading cancels the preparation. Old geometry, materials and textures are disposed after replacement; both variants temporarily coexist during a switch. Repeated instances share each building's resources. Both variants use identical per-building fitting scales, measured across both meshes; fit uses the existing surveyed-ground radius and does not rotate or recenter assets. The temple retains its authored footprint and origin, crown, ghost and beacon.

Assumption: BC7 or ASTC 4×4 transcode uses approximately 4 MiB per low building or 16 MiB per original building for three maps with mip chains. Across 23 loaded building types this is approximately 92 MiB / 368 MiB plus geometry, instance data and renderer overhead. Devices that fall back to RGBA8 need approximately four times that texture allocation. These are calculated allocations, not GPU telemetry.

## Eleven stages

1. Camp
2. Hut
3. Prehistoric granary
4. Roman granary
5. Viking longhouse
6. Timber house
7. Stone cottage
8. Watchtower
9. Medieval dovecote
10. Renaissance workshop
11. Industrial pump house

Assumption: this is an abstract game progression arranged by the assets' historical reading, not a claim that cultures or all buildings evolved along one universal sequence. Existing coastal fishing variations and the occasional late-stage Durand's substitution remain supported. Temple progression is independent.

Life retains its age/neighbour upgrade rules and advances through all eleven stages. Populous retains site quality and one-level-per-generation climbing, with its former six-step site-quality scale mapped over eleven stages. Population capacities retain the former 8-to-3 range across the expanded ladder.

Structures persistence advances to version 3. Versions 1 and 2 map their old model identities to the new indices: [0, 1, 5, 4, 6, 7]. Coordinates, age, population, generation and RNG state are retained. Newly saved version-3 indices are not remapped.

## Verification

- All 46 GLBs copied byte-for-byte from the verified census runtime packages. The copy script validates every embedded KTX2 against its standalone counterpart, runs KTX validation, checks UASTC RGB/no swizzle, complete 12/11 mip chains and correct colour spaces, and compares PNG/runtime geometry bytes and hierarchy. See integration-verification.json.
- Production client build passes and bundles all 46 runtime GLBs.
- Structures, temples and Populous plugin typechecks pass.
- Existing structure tests: 195 pass; two obsolete checks still require at most six levels. The owner was asked for the AGENTS.md-required permission to update/add tests; no tests have been edited pending that answer.
- Existing Populous tests: all 25 pass. The temples package has no test files.
- Existing GLB-loader/static-asset tests: all 9 pass.
- Manual execution confirmed that version-2 boards retain all six original model identities, Life visits every new stage, and Populous advances sequentially from 0 through 10 and stays capped.
- Workspace typecheck is blocked by pre-existing Buffer/Uint8Array type incompatibilities in untouched client tests/config and server persistence files. No changed production file is named in those errors.
- The game was not started or stopped. Live GPU/FPS and HUD interaction have not been verified in a running game.

## Saloon design selection

Six separate concepts were generated with the built-in image generator and saved with exact prompts in E:\Development\Projects\Terrace\.census\durands-redesign\. A–C explore architectural silhouettes; D–F add the stronger brothel identity requested by the owner. The exact generator backend version is not selectable or verified. The owner subsequently selected D, Crimson Cabaret, and requested that every image be retained. Both runtime Durand's variants now use the newly authored Crimson Cabaret. The six concepts, their prompts and the earlier Durand's concept remain archived. The replacement preserves the previous X/Z envelope and +Z entrance, and lowers the exaggerated old sign height from 2.060096 to approximately 1.270 world units.

The subsequent visual revision matches the central figure to the selected concept using a retained original generated sign painting, restores front-wing and entrance text and the tall side sign, adds projecting heart flags, and builds the ground-floor porch and awning forward of the upper gallery. The total footprint and variant alignment remain preserved. Near-frontal exported-model renders supplement the matched top-down and close-up views. The texture source image and exact generator prompt are retained with the build scripts.
