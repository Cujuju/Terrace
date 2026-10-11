var SmoothLab = (function(exports) {
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	var CELL_WORLD_SIZE = 1 / 4;
	function cellsAcross(worldUnits) {
		return worldUnits * 4;
	}
	function cellsOverArea(squareWorldUnits) {
		return squareWorldUnits * 4 * 4;
	}
	var MAX_HEIGHT = 1024;
	MAX_HEIGHT / 64;
	var SEA_COLUMN_DEPTH = MAX_HEIGHT;
	MAX_HEIGHT / 2;
	SEA_COLUMN_DEPTH / 16;
	var MIN_HEIGHT = -1536;
	var SMOOTH_PASS_LIMIT = Math.floor(640) * 4;
	16 / (MAX_HEIGHT / 16);
	var BAND_ALIGNED_SPANS = [
		MAX_HEIGHT,
		576,
		64
	];
	for (const span of BAND_ALIGNED_SPANS) if (span % 16 !== 0) throw new Error(`TERRACE_BAND_COUNT 64 makes BAND_HEIGHT 16, which does not divide ${span}`);
	//#endregion
	//#region shared/src/bands.ts
	var DRAWN_GROUND_BAND_BIAS = 8;
	/** Lowest raw height that draws as band k. Band 0 starts at the shore. */
	function bandFloorHeight(band) {
		return band * 16 + 1;
	}
	/** Canonical write level: the band's midpoint. */
	function bandLevelHeight(band) {
		return bandFloorHeight(band) + DRAWN_GROUND_BAND_BIAS;
	}
	function drawnBandOfSample(height) {
		return Math.floor((height - 1) / 16);
	}
	/** Drawn-equality: height draws as band k. Equivalent to `drawnBandOfSample(height) === band`. */
	function isHeightInBand(height, band) {
		return height >= bandFloorHeight(band) && height < bandFloorHeight(band + 1);
	}
	/**
	* One press crosses at least one drawn band: step from `height` to the
	* canonical level of the neighbouring drawn band. Callers clamp to
	* [MIN_HEIGHT, MAX_HEIGHT].
	*/
	function stepTowardBand(height, raising) {
		return bandLevelHeight(drawnBandOfSample(height) + (raising ? 1 : -1));
	}
	//#endregion
	//#region shared/src/grid.ts
	function createHeightmap(size) {
		if (!Number.isInteger(size) || size <= 0) throw new RangeError(`world size must be a positive integer, got ${size}`);
		return {
			size,
			cells: new Int16Array(size * size),
			columnSpans: /* @__PURE__ */ new Map()
		};
	}
	function inBounds(map, x, y) {
		return x >= 0 && y >= 0 && x < map.size && y < map.size;
	}
	function cellIndex(map, x, y) {
		return y * map.size + x;
	}
	function cellX(size, i) {
		return i % size;
	}
	function cellY(size, i) {
		return (i - i % size) / size;
	}
	function bandOf(h) {
		return Math.floor(h / 16);
	}
	function forEachLineCell(x0, y0, x1, y1, visit) {
		const dx = Math.abs(x1 - x0);
		const dy = -Math.abs(y1 - y0);
		const sx = x0 < x1 ? 1 : -1;
		const sy = y0 < y1 ? 1 : -1;
		let err = dx + dy;
		let x = x0;
		let y = y0;
		for (;;) {
			visit(x, y);
			if (x === x1 && y === y1) return;
			const e2 = 2 * err;
			if (e2 >= dy) {
				err += dy;
				x += sx;
			}
			if (e2 <= dx) {
				err += dx;
				y += sy;
			}
		}
	}
	//#endregion
	//#region shared/src/columns/span.ts
	var BEDROCK_FLOOR = MIN_HEIGHT;
	/** The band every column floors in: the drawn band of the lowest height the world holds. */
	var BEDROCK_BAND = drawnBandOfSample(BEDROCK_FLOOR);
	/** A column carved to nothing keeps its bedrock band and no more. */
	var BEDROCK_FLOOR_SPAN = {
		floorBand: BEDROCK_BAND,
		ceiling: BEDROCK_FLOOR
	};
	/** Topmost band a span draws. The ground's own rounding rule, applied to the ceiling. */
	function spanCapBand(span) {
		return drawnBandOfSample(span.ceiling);
	}
	/**
	* Highest ceiling a span under `upper` may hold. Band `floorBand - 1` carries
	* `upper`'s underside, so a span below must cap beneath that band.
	*/
	function highestCeilingUnderSpan(upper) {
		return bandFloorHeight(upper.floorBand - 1) - 1;
	}
	function isSpanDrawn(span) {
		return span.floorBand <= spanCapBand(span);
	}
	/** The raw range a ceiling may sit in. The writer, the parser and the repair all ask here. */
	function isCeilingInRange(ceiling) {
		return ceiling >= BEDROCK_FLOOR && ceiling <= 1024;
	}
	function spanCoversBand(span, band) {
		return span.floorBand <= band && band <= spanCapBand(span);
	}
	/** At least one whole band of air separates them, which is what seeing under `upper` needs. */
	function isGapDrawn(lower, upper) {
		return upper.floorBand > spanCapBand(lower) + 1;
	}
	bandLevelHeight(BEDROCK_BAND - 1);
	/**
	* Repairs a column into one `setColumn` accepts. Refuses what repair cannot
	* mean: an out-of-range ceiling, or spans that do not ascend.
	*/
	function canonicaliseColumn(spans) {
		const out = [];
		for (let k = 0; k < spans.length; k++) {
			const span = spans[k];
			if (!isCeilingInRange(span.ceiling)) throw new RangeError(`span ${k} caps at ${span.ceiling}, outside [${BEDROCK_FLOOR}, ${MAX_HEIGHT}]`);
			const below = k === 0 ? void 0 : spans[k - 1];
			if (below !== void 0 && span.floorBand <= below.floorBand) throw new RangeError(`span ${k} floors in band ${span.floorBand}, not above span ${k - 1}'s band ${below.floorBand} — a column is repaired in place, never sorted`);
			if (!isSpanDrawn(span)) continue;
			const last = out.length === 0 ? void 0 : out[out.length - 1];
			if (last !== void 0 && !isGapDrawn(last, span)) {
				out[out.length - 1] = {
					floorBand: last.floorBand,
					ceiling: last.ceiling > span.ceiling ? last.ceiling : span.ceiling
				};
				continue;
			}
			out.push(span);
		}
		if (out.length === 0) return [BEDROCK_FLOOR_SPAN];
		const lowest = out[0];
		if (lowest.floorBand !== BEDROCK_BAND) {
			if (isGapDrawn(BEDROCK_FLOOR_SPAN, lowest)) out.unshift(BEDROCK_FLOOR_SPAN);
			else out[0] = {
				floorBand: BEDROCK_BAND,
				ceiling: lowest.ceiling
			};
		}
		return out;
	}
	//#endregion
	//#region shared/src/columns/store.ts
	function spanCount(map, x, y) {
		const packed = map.columnSpans.get(cellIndex(map, x, y));
		return packed === void 0 ? 1 : packed.length / 2;
	}
	function spanAt(map, x, y, k) {
		const i = cellIndex(map, x, y);
		const packed = map.columnSpans.get(i);
		if (packed === void 0) {
			if (k !== 0) throw new RangeError(`cell (${x}, ${y}) has 1 span, asked for span ${k}`);
			return {
				floorBand: BEDROCK_BAND,
				ceiling: map.cells[i]
			};
		}
		if (!Number.isInteger(k) || k < 0 || k >= packed.length / 2) throw new RangeError(`cell (${x}, ${y}) has ${packed.length / 2} spans, asked for span ${k}`);
		return {
			floorBand: packed[k * 2],
			ceiling: packed[k * 2 + 1]
		};
	}
	function setColumn(map, x, y, spans) {
		if (spans.length === 0) throw new RangeError(`cell (${x}, ${y}) needs at least one solid span`);
		for (let k = 0; k < spans.length; k++) {
			const span = spans[k];
			const { floorBand, ceiling } = span;
			if (!Number.isInteger(floorBand) || !Number.isInteger(ceiling)) throw new RangeError(`cell (${x}, ${y}) span ${k} [band ${floorBand}, ${ceiling}] is not integral`);
			if (floorBand < BEDROCK_BAND) throw new RangeError(`cell (${x}, ${y}) span ${k} floors in band ${floorBand}, below bedrock band ${BEDROCK_BAND}`);
			if (!isCeilingInRange(ceiling)) throw new RangeError(`cell (${x}, ${y}) span ${k} caps at ${ceiling}, outside [${MIN_HEIGHT}, ${MAX_HEIGHT}]`);
			if (!isSpanDrawn(span)) throw new RangeError(`cell (${x}, ${y}) span ${k} [band ${floorBand}, ${ceiling}] caps in band ${spanCapBand(span)}, below its own floor — it draws nothing`);
			if (k > 0 && !isGapDrawn(spans[k - 1], span)) throw new RangeError(`cell (${x}, ${y}) span ${k} floors in band ${floorBand}, which does not clear span ${k - 1} capping in band ${spanCapBand(spans[k - 1])} — spans must ascend with a band of air between them`);
		}
		if (spans[0].floorBand !== BEDROCK_BAND) throw new RangeError(`cell (${x}, ${y}) has its bottom span floored in band ${spans[0].floorBand}; a column floors in band ${BEDROCK_BAND} (a column standing on nothing needs the gap below it to be a span)`);
		const i = cellIndex(map, x, y);
		map.cells[i] = spans[spans.length - 1].ceiling;
		if (spans.length === 1) {
			map.columnSpans.delete(i);
			return;
		}
		const packed = new Int16Array(spans.length * 2);
		for (let k = 0; k < spans.length; k++) {
			packed[k * 2] = spans[k].floorBand;
			packed[k * 2 + 1] = spans[k].ceiling;
		}
		map.columnSpans.set(i, packed);
	}
	function anyColumnLayered(map, x0, y0, width, height) {
		if (map.columnSpans.size === 0) return false;
		for (let y = y0; y < y0 + height; y++) for (let x = x0; x < x0 + width; x++) if (map.columnSpans.has(cellIndex(map, x, y))) return true;
		return false;
	}
	function readSpans(map, x, y) {
		const count = spanCount(map, x, y);
		const spans = [];
		for (let k = 0; k < count; k++) spans.push(spanAt(map, x, y, k));
		return spans;
	}
	function moveSpanCeiling(map, x, y, k, newCeiling) {
		const spans = readSpans(map, x, y);
		if (!Number.isInteger(k) || k < 0 || k >= spans.length) throw new RangeError(`cell (${x}, ${y}) has ${spans.length} span(s), asked to move span ${k}`);
		spans[k] = {
			floorBand: spans[k].floorBand,
			ceiling: newCeiling
		};
		setColumn(map, x, y, canonicaliseColumn(spans));
	}
	/** Clear the slabs `loBand .. hiBand` from a column, keeping what lies outside them. */
	function carveBands(map, x, y, loBand, hiBand) {
		if (loBand > hiBand) return;
		const spans = readSpans(map, x, y);
		const cut = [];
		for (let k = 0; k < spans.length; k++) {
			const span = spans[k];
			const capBand = spanCapBand(span);
			if (hiBand < span.floorBand || loBand > capBand) {
				cut.push(span);
				continue;
			}
			if (span.floorBand < loBand) cut.push({
				floorBand: span.floorBand,
				ceiling: bandLevelHeight(loBand - 1)
			});
			if (hiBand < capBand) cut.push({
				floorBand: hiBand + 1,
				ceiling: span.ceiling
			});
		}
		setColumn(map, x, y, canonicaliseColumn(cut));
	}
	//#endregion
	//#region shared/src/columns/bandQueries.ts
	function spanIndexCoveringBand(map, x, y, band) {
		const count = spanCount(map, x, y);
		for (let k = 0; k < count; k++) if (spanCoversBand(spanAt(map, x, y, k), band)) return k;
		return null;
	}
	function columnCoversBand(map, x, y, band) {
		return spanIndexCoveringBand(map, x, y, band) !== null;
	}
	/** True when the column already holds every band of `[floorBand, band]`. */
	function columnHoldsRun(map, x, y, floorBand, band) {
		const k = spanIndexCoveringBand(map, x, y, band);
		return k !== null && spanAt(map, x, y, k).floorBand <= floorBand;
	}
	/**
	* Welds `slab` in, absorbing every span it meets. One ordered pass, so the
	* result ascends without sorting — which `canonicaliseColumn` demands.
	*/
	function weldSlab(spans, slab) {
		const out = [];
		let pending = slab;
		for (const span of spans) {
			if (pending === null || isGapDrawn(span, pending)) {
				out.push(span);
				continue;
			}
			if (isGapDrawn(pending, span)) {
				out.push(pending);
				pending = null;
				out.push(span);
				continue;
			}
			pending = {
				floorBand: span.floorBand < pending.floorBand ? span.floorBand : pending.floorBand,
				ceiling: span.ceiling > pending.ceiling ? span.ceiling : pending.ceiling
			};
		}
		if (pending !== null) out.push(pending);
		return out;
	}
	/**
	* Writes the run's slab into one cell, returning whether it changed. Nothing
	* inspects what is overhead; only an already-solid run refuses.
	*/
	function fillBandRun(map, x, y, floorBand, band, ceiling) {
		if (columnHoldsRun(map, x, y, floorBand, band)) return false;
		const slab = {
			floorBand,
			ceiling
		};
		if (!isSpanDrawn(slab)) return false;
		setColumn(map, x, y, canonicaliseColumn(weldSlab(readSpans(map, x, y), slab)));
		return true;
	}
	function highestCeilingBelow(map, x, y, threshold) {
		let best = null;
		const count = spanCount(map, x, y);
		for (let k = 0; k < count; k++) {
			const { ceiling } = spanAt(map, x, y, k);
			if (ceiling < threshold) best = ceiling;
		}
		return best;
	}
	function canSpreadBandToSpan(map, cx, cy, band) {
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (dx === 0 && dy === 0) continue;
			const nx = cx + dx;
			const ny = cy + dy;
			if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
			if (columnCoversBand(map, nx, ny, band)) return true;
		}
		return false;
	}
	function canCarveBandAt(map, cx, cy, band) {
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (dx === 0 && dy === 0) continue;
			const nx = cx + dx;
			const ny = cy + dy;
			if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
			if (!columnCoversBand(map, nx, ny, band)) return true;
		}
		return false;
	}
	//#endregion
	//#region shared/src/sculpt/diff.ts
	function diffOf(map, changed) {
		const indices = Array.from(changed).sort((a, b) => a - b);
		const diff = [];
		for (const i of indices) {
			const x = cellX(map.size, i);
			const y = cellY(map.size, i);
			const packed = map.columnSpans.get(i);
			const h = map.cells[i];
			diff.push(packed === void 0 ? {
				x,
				y,
				h
			} : {
				x,
				y,
				h,
				spans: Array.from(packed)
			});
		}
		return diff;
	}
	//#endregion
	//#region shared/src/sculpt/grasp.ts
	function clampHeight(h) {
		return h > 1024 ? MAX_HEIGHT : h < BEDROCK_FLOOR ? BEDROCK_FLOOR : h;
	}
	function canSpreadBandTo(map, cx, cy, band) {
		return canSpreadBandToSpan(map, cx, cy, band);
	}
	function graspedSpanIndex(map, i, spanBand) {
		const x = cellX(map.size, i);
		const y = cellY(map.size, i);
		if (spanBand === null) return spanCount(map, x, y) - 1;
		return spanIndexCoveringBand(map, x, y, spanBand);
	}
	function layerSpanIndex(map, i, spanBand) {
		const x = cellX(map.size, i);
		const y = cellY(map.size, i);
		const top = spanCount(map, x, y) - 1;
		if (spanBand === null) return top;
		const k = spanIndexCoveringBand(map, x, y, spanBand);
		if (k !== null) return k;
		return bandFloorHeight(spanBand) > spanAt(map, x, y, top).ceiling ? top : null;
	}
	function graspedCeiling(map, i, k) {
		return spanAt(map, cellX(map.size, i), cellY(map.size, i), k).ceiling;
	}
	function writeGraspedCeiling(map, i, k, ceiling) {
		moveSpanCeiling(map, cellX(map.size, i), cellY(map.size, i), k, ceiling);
	}
	//#endregion
	//#region shared/src/sculpt/footprint.ts
	function forEachFootprintOffset(radius, visit) {
		if (radius === 1) {
			visit(0, 0, 0);
			return;
		}
		for (let dy = -(radius - 1); dy <= radius - 1; dy++) for (let dx = -(radius - 1); dx <= radius - 1; dx++) {
			if (!isFootprintOffset(radius, dx, dy)) continue;
			visit(dx, dy, Math.floor(Math.sqrt(dx * dx + dy * dy)));
		}
	}
	/** Only the centre offset is inside a one-cell brush. */
	var SINGLE_CELL_RADIUS_SQUARED = 1;
	/** The one disc threshold: `dx² + dy²` below it is inside a brush of `radius`. */
	function footprintRadiusSquared(radius) {
		return radius === 1 ? SINGLE_CELL_RADIUS_SQUARED : radius * (radius - 1);
	}
	function isFootprintOffset(radius, dx, dy) {
		return dx * dx + dy * dy < footprintRadiusSquared(radius);
	}
	function forEachFootprintCell(map, cx, cy, radius, visit) {
		forEachFootprintOffset(radius, (dx, dy, dist) => {
			const x = cx + dx;
			const y = cy + dy;
			if (!inBounds(map, x, y)) return;
			visit(cellIndex(map, x, y), dist);
		});
	}
	/**
	* One stroke's step for one cell: an anchored press lands on the canonical
	* level of the drawn band it crosses into, never short of it; a free press
	* moves `amount`.
	*/
	function pressDelta(amount, from, anchored) {
		if (!anchored) return amount;
		const raising = amount > 0;
		const magnitude = amount < 0 ? -amount : amount;
		const level = stepTowardBand(from, raising);
		const crossing = raising ? level - from : from - level;
		const step = crossing > magnitude ? crossing : magnitude;
		return raising ? step : -step;
	}
	function brushDelta(amount, radius, dist, profile) {
		if (profile === "hard") return amount;
		const span = radius - 1;
		if (span === 0) return amount;
		const weight = 1 * span + 4 * (span - dist);
		return Math.trunc(amount * weight / (5 * span));
	}
	function spreadableFootprintCells(map, cx, cy, radius, band) {
		const spreadable = /* @__PURE__ */ new Set();
		forEachFootprintCell(map, cx, cy, radius, (i) => {
			if (canSpreadBandTo(map, cellX(map.size, i), cellY(map.size, i), band)) spreadable.add(i);
		});
		return spreadable;
	}
	function assertBrushRadius(radius) {
		if (!Number.isInteger(radius) || radius < 1 || radius > 16) throw new RangeError(`brush radius ${radius} outside [1, 16]`);
	}
	function assertBrushArgs(map, cx, cy, radius, amount) {
		if (!inBounds(map, cx, cy)) throw new RangeError(`brush center (${cx},${cy}) out of bounds`);
		assertBrushRadius(radius);
		if (!Number.isInteger(amount)) throw new RangeError(`brush amount must be an integer, got ${amount}`);
	}
	function anchoredTargetHeight(map, cx, cy, raising, targetBand = null, spanBand = null) {
		if (targetBand !== null) return clampHeight(bandLevelHeight(targetBand));
		const centre = cellIndex(map, cx, cy);
		const k = graspedSpanIndex(map, centre, spanBand);
		return clampHeight(stepTowardBand(k === null ? map.cells[centre] : graspedCeiling(map, centre, k), raising));
	}
	bandOf(MIN_HEIGHT);
	bandOf(MAX_HEIGHT);
	var FULL_HEIGHT_SPAN = MAX_HEIGHT - MIN_HEIGHT;
	var LIBRARY_SCULPT_TOOL = "settle";
	/** Bedrock is a column's floor, not material, so the lowest slab a stroke can open sits above it. */
	var LOWEST_CARVEABLE_BAND = BEDROCK_BAND + 1;
	/** The one depth predicate: the wire validator and applyCarve both ask it. */
	function isValidCarveDepth(depthBands) {
		return Number.isInteger(depthBands) && depthBands >= 1 && depthBands <= 10;
	}
	var SMOOTH_KERNELS = [
		"cross",
		"gauss",
		"median"
	];
	var SMOOTH_KERNEL_DEFAULT = "cross";
	var LIBRARY_DEFAULT_SCULPT_OPTIONS = {
		tool: LIBRARY_SCULPT_TOOL,
		depthBands: 1,
		profile: "soft",
		spill: "free",
		anchor: "free",
		targetBand: null,
		runFloorBand: null,
		dragAlt: false,
		spanBand: null,
		sweepFrom: null,
		smoothLambda: 50,
		smoothFeather: 0,
		smoothRim: 0,
		smoothBilateral: false,
		smoothFullSteps: false,
		smoothCooldown: false,
		smoothUnbiased: false,
		smoothKernel: SMOOTH_KERNEL_DEFAULT
	};
	//#endregion
	//#region shared/src/sculpt/stamp.ts
	function applyBrush(map, cx, cy, radius, amount, changed, profile = LIBRARY_DEFAULT_SCULPT_OPTIONS.profile, anchor = LIBRARY_DEFAULT_SCULPT_OPTIONS.anchor, targetBand = LIBRARY_DEFAULT_SCULPT_OPTIONS.targetBand, spanBand = LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand) {
		assertBrushArgs(map, cx, cy, radius, amount);
		let spreadable = null;
		if (anchor === "band") {
			if (targetBand === null || !canSpreadBandTo(map, cx, cy, targetBand)) return;
			spreadable = spreadableFootprintCells(map, cx, cy, radius, targetBand);
		}
		const raising = amount > 0;
		const anchored = anchor !== "free" && amount !== 0;
		const target = anchored ? anchoredTargetHeight(map, cx, cy, raising, targetBand, spanBand) : 0;
		forEachFootprintCell(map, cx, cy, radius, (i, dist) => {
			if (spreadable !== null && !spreadable.has(i)) return;
			const k = graspedSpanIndex(map, i, spanBand);
			if (k === null) return;
			const before = graspedCeiling(map, i, k);
			if (anchored && (raising ? before >= target : before <= target)) return;
			const delta = brushDelta(pressDelta(amount, before, anchored), radius, dist, profile);
			if (delta === 0) return;
			let moved = before + delta;
			if (anchored) moved = raising ? moved > target ? target : moved : moved < target ? target : moved;
			const h = clampHeight(moved);
			if (h !== before) {
				writeGraspedCeiling(map, i, k, h);
				changed.add(i);
			}
		});
	}
	function applyLevelFillBrush(map, cx, cy, radius, amount, changed, anchor = LIBRARY_DEFAULT_SCULPT_OPTIONS.anchor, targetBand = LIBRARY_DEFAULT_SCULPT_OPTIONS.targetBand, spanBand = LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand) {
		assertBrushArgs(map, cx, cy, radius, amount);
		if (amount === 0) return;
		let spreadable = null;
		if (anchor === "band") {
			if (targetBand === null || !canSpreadBandTo(map, cx, cy, targetBand)) return;
			spreadable = spreadableFootprintCells(map, cx, cy, radius, targetBand);
		}
		const raising = amount > 0;
		if (anchor !== "free") {
			fillTowardTarget(map, cx, cy, radius, amount, changed, raising, anchoredTargetHeight(map, cx, cy, raising, targetBand, spanBand), true, spanBand, spreadable);
			return;
		}
		let extremeBand = 0;
		{
			let surveyed = false;
			forEachFootprintCell(map, cx, cy, radius, (i) => {
				const k = graspedSpanIndex(map, i, spanBand);
				if (k === null) return;
				const band = drawnBandOfSample(graspedCeiling(map, i, k));
				if (!surveyed) {
					extremeBand = band;
					surveyed = true;
					return;
				}
				if (raising ? band < extremeBand : band > extremeBand) extremeBand = band;
			});
			if (!surveyed) return;
		}
		fillTowardTarget(map, cx, cy, radius, amount, changed, raising, clampHeight(bandLevelHeight(extremeBand + (raising ? 1 : -1))), false, spanBand);
	}
	function sculptSweepRadius(radius, profile, tool, anchor) {
		return profile === "soft" && tool === "stamp" && anchor === "clicked" ? radius + softApronReachCells(radius) : radius;
	}
	function softApronReachCells(radius) {
		const reach = 2 * radius;
		return reach < 15 ? reach : 15;
	}
	/** Math.clz32 counts a 32-bit word's leading zeros, so this reads floor(log2 d) + 1. */
	var INT32_BITS = 32;
	/** The sheet drops a band per cell at the pinch, then doubles its tread: 1, 2, 4, 8 cells. */
	function softApronBandDrop(distPastCore) {
		if (distPastCore < 1) return 0;
		const band = INT32_BITS - Math.clz32(distPastCore);
		return band < 4 ? band : 4;
	}
	/** The apron only exists under a soft clicked stamp, which is an anchored stroke. */
	var APRON_IS_ANCHORED = true;
	function applySoftApron(map, cx, cy, radius, amount, coreTarget, spanBand, changed) {
		if (amount === 0) return;
		const raising = amount > 0;
		const reach = softApronReachCells(radius);
		const coreBand = drawnBandOfSample(coreTarget);
		forEachFootprintCell(map, cx, cy, sculptSweepRadius(radius, "soft", "stamp", "clicked"), (i) => {
			const x = cellX(map.size, i);
			const y = cellY(map.size, i);
			const dx = x - cx;
			const dy = y - cy;
			if (isFootprintOffset(radius, dx, dy)) return;
			let dist = reach;
			for (let d = 1; d < reach; d++) if (isFootprintOffset(radius + d, dx, dy)) {
				dist = d;
				break;
			}
			const target = clampHeight(bandLevelHeight(coreBand + (raising ? -softApronBandDrop(dist) : softApronBandDrop(dist))));
			const k = graspedSpanIndex(map, i, spanBand);
			if (k === null) return;
			const before = graspedCeiling(map, i, k);
			if (raising ? before >= target : before <= target) return;
			const moved = before + pressDelta(amount, before, APRON_IS_ANCHORED);
			const h = clampHeight(raising ? moved > target ? target : moved : moved < target ? target : moved);
			if (h !== before) {
				writeGraspedCeiling(map, i, k, h);
				changed.add(i);
			}
		});
	}
	function fillTowardTarget(map, cx, cy, radius, amount, changed, raising, targetHeight, anchored, spanBand = LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand, spreadable = null) {
		forEachFootprintCell(map, cx, cy, radius, (i) => {
			if (spreadable !== null && !spreadable.has(i)) return;
			const k = graspedSpanIndex(map, i, spanBand);
			if (k === null) return;
			const h = graspedCeiling(map, i, k);
			if (raising ? h >= targetHeight : h <= targetHeight) return;
			const moved = h + pressDelta(amount, h, anchored);
			const clamped = clampHeight(raising ? moved > targetHeight ? targetHeight : moved : moved < targetHeight ? targetHeight : moved);
			if (clamped !== h) {
				writeGraspedCeiling(map, i, k, clamped);
				changed.add(i);
			}
		});
	}
	var SOFT_DRAG_LOBE_CELLS = 4;
	var SOFT_DRAG_LOBE_SHARE = .65;
	function hashCell(x, y) {
		let h = Math.imul(x, 668265261) ^ Math.imul(y, 374761393);
		h = Math.imul(h ^ h >>> 15, 2246822507);
		h = Math.imul(h ^ h >>> 13, 3266489909);
		h ^= h >>> 16;
		return (h >>> 0) / 4294967296;
	}
	function cellNoise(x, y) {
		return SOFT_DRAG_LOBE_SHARE * hashCell(Math.floor(x / SOFT_DRAG_LOBE_CELLS), Math.floor(y / SOFT_DRAG_LOBE_CELLS)) + .35 * hashCell(x, y);
	}
	function admitRimEnclaves(map, targetBand, refused, inDisc, disc) {
		const alreadyAtBand = (x, y) => {
			const k = spanIndexCoveringBand(map, x, y, targetBand);
			return k !== null && isHeightInBand(spanAt(map, x, y, k).ceiling, targetBand);
		};
		const passable = (x, y) => inBounds(map, x, y) && refused.has(cellIndex(map, x, y)) && !alreadyAtBand(x, y);
		const reached = /* @__PURE__ */ new Set();
		const stack = [];
		const seed = (x, y) => {
			if (!passable(x, y)) return;
			const i = cellIndex(map, x, y);
			if (reached.has(i)) return;
			reached.add(i);
			stack.push(i);
		};
		const outside = (x, y) => {
			if (!inBounds(map, x, y)) return true;
			const i = cellIndex(map, x, y);
			return !inDisc.has(i) && !refused.has(i);
		};
		for (const i of refused) {
			const x = cellX(map.size, i);
			const y = cellY(map.size, i);
			if (outside(x - 1, y) || outside(x + 1, y) || outside(x, y - 1) || outside(x, y + 1)) seed(x, y);
		}
		while (stack.length > 0) {
			const i = stack.pop();
			const x = cellX(map.size, i);
			const y = cellY(map.size, i);
			seed(x - 1, y);
			seed(x + 1, y);
			seed(x, y - 1);
			seed(x, y + 1);
		}
		for (const i of refused) if (!reached.has(i)) disc.push(i);
	}
	//#endregion
	//#region shared/src/sculpt/drag.ts
	/**
	* A drag settles each cell once; the repeat only lets a settled cell's
	* neighbours cascade. One act per cell bounds the sweep however
	* canonicalisation rewrites the column.
	*/
	function settleEachCellOnce(cells, act) {
		const settled = /* @__PURE__ */ new Set();
		for (let quiet = false; !quiet;) {
			quiet = true;
			for (const i of cells) {
				if (settled.has(i)) continue;
				if (!act(i)) continue;
				settled.add(i);
				quiet = false;
			}
		}
	}
	function retreatHeightAt(map, cx, cy, band) {
		const floor = bandFloorHeight(band);
		let best = null;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (dx === 0 && dy === 0) continue;
			const nx = cx + dx;
			const ny = cy + dy;
			if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
			const h = highestCeilingBelow(map, nx, ny, floor);
			if (h === null) continue;
			if (best === null || h > best) best = h;
		}
		return best;
	}
	function applyDragRegion(map, cx, cy, radius, raising, targetBand, runFloorBand, profile, sweepFrom, changed, dragAlt = false) {
		const targetHeight = clampHeight(bandLevelHeight(targetBand));
		const ragged = profile === "soft";
		const disc = [];
		const inDisc = /* @__PURE__ */ new Set();
		const refused = /* @__PURE__ */ new Set();
		const sweepDisc = (sx, sy) => {
			forEachFootprintOffset(radius, (dx, dy, dist) => {
				const x = sx + dx;
				const y = sy + dy;
				if (!inBounds(map, x, y)) return;
				const i = cellIndex(map, x, y);
				if (inDisc.has(i)) return;
				if (ragged && dist >= radius * (.45 + .55 * cellNoise(x, y))) {
					refused.add(i);
					return;
				}
				refused.delete(i);
				inDisc.add(i);
				disc.push(i);
			});
		};
		if (sweepFrom === null) sweepDisc(cx, cy);
		else forEachLineCell(sweepFrom.x, sweepFrom.y, cx, cy, sweepDisc);
		if (refused.size > 0) admitRimEnclaves(map, targetBand, refused, inDisc, disc);
		if (!raising) {
			if (dragAlt) {
				if (targetBand <= BEDROCK_BAND) return;
				settleEachCellOnce(disc, (i) => {
					const x = cellX(map.size, i);
					const y = cellY(map.size, i);
					if (spanIndexCoveringBand(map, x, y, targetBand) === null) return false;
					if (retreatHeightAt(map, x, y, targetBand) === null) return false;
					carveBands(map, x, y, targetBand, targetBand);
					changed.add(i);
					return true;
				});
				return;
			}
			settleEachCellOnce(disc, (i) => {
				const x = cellX(map.size, i);
				const y = cellY(map.size, i);
				const k = spanIndexCoveringBand(map, x, y, targetBand);
				if (k === null) return false;
				const span = spanAt(map, x, y, k);
				if (span.ceiling < bandFloorHeight(targetBand)) return false;
				const ground = retreatHeightAt(map, x, y, targetBand);
				if (ground === null) return false;
				const exposed = clampHeight(Math.max(ground, bandLevelHeight(targetBand - 1)));
				if (exposed >= span.ceiling) return false;
				if (k > 0 && !isSpanDrawn({
					floorBand: span.floorBand,
					ceiling: exposed
				})) return false;
				moveSpanCeiling(map, x, y, k, exposed);
				changed.add(i);
				return true;
			});
			return;
		}
		const floor = dragAlt ? targetBand : runFloorBand;
		for (const i of disc) if (fillBandRun(map, cellX(map.size, i), cellY(map.size, i), floor, targetBand, targetHeight)) changed.add(i);
	}
	//#endregion
	//#region shared/src/sculpt/carve.ts
	/**
	* Cells a carve would actually cut. The preview and the applier both read this,
	* so the outline can never promise a cut the stroke will not make.
	*/
	function carveAdmittedCells(map, cx, cy, radius, spanBand, depthBands) {
		const admitted = [];
		if (!isValidCarveDepth(depthBands)) return admitted;
		const lowestOpenedBand = spanBand;
		const highestOpenedBand = spanBand + depthBands - 1;
		if (lowestOpenedBand < LOWEST_CARVEABLE_BAND) return admitted;
		forEachFootprintCell(map, cx, cy, radius, (i) => {
			const x = cellX(map.size, i);
			const y = cellY(map.size, i);
			let overlaps = false;
			const count = spanCount(map, x, y);
			for (let k = 0; k < count; k++) {
				const span = spanAt(map, x, y, k);
				if (span.floorBand <= highestOpenedBand && lowestOpenedBand <= spanCapBand(span)) {
					overlaps = true;
					break;
				}
			}
			if (!overlaps) return;
			for (let band = lowestOpenedBand; band <= highestOpenedBand; band++) if (!canCarveBandAt(map, x, y, band)) return;
			admitted.push(i);
		});
		return admitted;
	}
	function applyCarve(map, cx, cy, radius, spanBand, depthBands, changed) {
		for (const i of carveAdmittedCells(map, cx, cy, radius, spanBand, depthBands)) {
			carveBands(map, cellX(map.size, i), cellY(map.size, i), spanBand, spanBand + depthBands - 1);
			changed.add(i);
		}
	}
	//#endregion
	//#region shared/src/sculpt/layerView.ts
	function buildLayerView(map, spanBand, firstRow, lastRow, previous) {
		const base = firstRow * map.size;
		const end = (lastRow + 1) * map.size;
		const heights = map.cells.slice(base, end);
		const excluded = new Uint8Array(end - base);
		const spanCaps = /* @__PURE__ */ new Map();
		for (const i of map.columnSpans.keys()) {
			if (i < base || i >= end) continue;
			const x = cellX(map.size, i);
			const y = cellY(map.size, i);
			const k = layerSpanIndex(map, i, spanBand);
			if (k === null) {
				excluded[i - base] = 1;
				continue;
			}
			const span = spanAt(map, x, y, k);
			heights[i - base] = span.ceiling;
			const isTop = k === spanCount(map, x, y) - 1;
			spanCaps.set(i, {
				lo: bandLevelHeight(span.floorBand),
				hi: isTop ? MAX_HEIGHT : highestCeilingUnderSpan(spanAt(map, x, y, k + 1))
			});
		}
		if (previous !== null) heights.set(previous.heights, previous.base - base);
		return {
			heights,
			excluded,
			spanCaps,
			base,
			firstRow,
			lastRow
		};
	}
	function commitLayerView(map, view, spanBand, changed) {
		for (const i of changed) {
			const v = i - view.base;
			if (v < 0 || v >= view.heights.length) throw new RangeError(`layer view does not cover changed cell ${i}`);
			if (view.excluded[v] === 1) continue;
			if (!map.columnSpans.has(i)) {
				map.cells[i] = view.heights[v];
				continue;
			}
			const k = layerSpanIndex(map, i, spanBand);
			if (k === null) continue;
			moveSpanCeiling(map, cellX(map.size, i), cellY(map.size, i), k, view.heights[v]);
		}
	}
	//#endregion
	//#region shared/src/sculpt/relax.ts
	var medianScratch = [];
	function movePair(cells, base, hiIdx, loIdx, e, boundsOf, spanCaps) {
		const hi = hiIdx - base;
		const lo = loIdx - base;
		let drop = e >> 1;
		let rise = drop;
		if (boundsOf !== null || spanCaps !== null) {
			const hiBand = boundsOf === null ? null : boundsOf(hiIdx);
			const loBand = boundsOf === null ? null : boundsOf(loIdx);
			let dropCap = hiBand === null ? drop : Math.min(drop, cells[hi] - hiBand.lo);
			let riseCap = loBand === null ? rise : Math.min(rise, loBand.hi - cells[lo]);
			const hiSpan = spanCaps === null ? void 0 : spanCaps.get(hiIdx);
			const loSpan = spanCaps === null ? void 0 : spanCaps.get(loIdx);
			if (hiSpan !== void 0) dropCap = Math.min(dropCap, cells[hi] - hiSpan.lo);
			if (loSpan !== void 0) riseCap = Math.min(riseCap, loSpan.hi - cells[lo]);
			if (dropCap < drop || riseCap < rise) {
				const t = Math.min(dropCap, riseCap);
				if (t <= 0) return false;
				drop = t;
				rise = t;
			}
			if (drop === 0 && rise === 0) return false;
		}
		cells[hi] -= drop;
		cells[lo] += rise;
		return true;
	}
	function relaxPair(cells, base, i, j, changed, boundsOf, layer) {
		if (layer !== null && (layer.excluded[i - base] === 1 || layer.excluded[j - base] === 1)) return false;
		const spanCaps = layer === null ? null : layer.spanCaps;
		const beforeI = cells[i - base];
		const beforeJ = cells[j - base];
		const d = beforeI - beforeJ;
		let moved = false;
		if (d > 5) moved = movePair(cells, base, i, j, d - 4, boundsOf, spanCaps);
		else if (d < -5) moved = movePair(cells, base, j, i, -d - 4, boundsOf, spanCaps);
		if (moved) {
			if (cells[i - base] !== beforeI) changed.add(i);
			if (cells[j - base] !== beforeJ) changed.add(j);
		}
		return moved;
	}
	function brushDist(cx, cy, x, y) {
		const dx = x - cx;
		const dy = y - cy;
		return Math.floor(Math.sqrt(dx * dx + dy * dy));
	}
	function divHalfEven(num, den) {
		const q = Math.trunc(num / den);
		const twice = (num - q * den) * 2;
		if (twice > den) return q + 1;
		if (twice < -den) return q - 1;
		if (twice === den || twice === -den) {
			if ((q & 1) !== 0) return q + (num >= 0 ? 1 : -1);
		}
		return q;
	}
	function falloffStrength(pct, falloff, x, y) {
		const dist = brushDist(falloff.cx, falloff.cy, x, y);
		const widthCells = Math.trunc(falloff.feather * falloff.reach / 100);
		const featherStart = Math.max(falloff.reach - widthCells, 0);
		if (dist <= featherStart) return pct;
		if (dist >= falloff.reach) return 0;
		return Math.trunc(pct * (falloff.reach - dist) / (falloff.reach - featherStart));
	}
	function rimBand(h, lo, hi, dist, reach, rimPct) {
		const widthCells = Math.trunc(rimPct * reach / 100);
		const taperStart = Math.max(reach - widthCells, 0);
		if (dist <= taperStart) return {
			lo,
			hi
		};
		const allow = Math.trunc(16 * (reach - dist) / (reach - taperStart));
		return {
			lo: Math.max(lo, h - allow),
			hi: Math.min(hi, h + allow)
		};
	}
	function laplacianCell(cells, viewBase, size, x, y, pct, changed, boundsOf, spanCaps, falloff = null, kernel = "cross", bilateral = false, fullSteps = false, unbiased = false) {
		const i = y * size + x;
		const k = i - viewBase;
		const here = cells[k];
		const votes = (h) => !bilateral || Math.abs(h - here) <= 16;
		let avg;
		if (kernel === "gauss") {
			let num = 4 * here;
			let den = 4;
			if (x > 0 && votes(cells[k - 1])) {
				num += 2 * cells[k - 1];
				den += 2;
			}
			if (x < size - 1 && votes(cells[k + 1])) {
				num += 2 * cells[k + 1];
				den += 2;
			}
			if (y > 0 && votes(cells[k - size])) {
				num += 2 * cells[k - size];
				den += 2;
			}
			if (y < size - 1 && votes(cells[k + size])) {
				num += 2 * cells[k + size];
				den += 2;
			}
			if (x > 0 && y > 0 && votes(cells[k - size - 1])) {
				num += cells[k - size - 1];
				den += 1;
			}
			if (x < size - 1 && y > 0 && votes(cells[k - size + 1])) {
				num += cells[k - size + 1];
				den += 1;
			}
			if (x > 0 && y < size - 1 && votes(cells[k + size - 1])) {
				num += cells[k + size - 1];
				den += 1;
			}
			if (x < size - 1 && y < size - 1 && votes(cells[k + size + 1])) {
				num += cells[k + size + 1];
				den += 1;
			}
			if (den === 4) return false;
			avg = unbiased ? divHalfEven(num, den) : Math.trunc(num / den);
		} else if (kernel === "median") {
			medianScratch.length = 0;
			medianScratch.push(here);
			if (x > 0 && votes(cells[k - 1])) medianScratch.push(cells[k - 1]);
			if (x < size - 1 && votes(cells[k + 1])) medianScratch.push(cells[k + 1]);
			if (y > 0 && votes(cells[k - size])) medianScratch.push(cells[k - size]);
			if (y < size - 1 && votes(cells[k + size])) medianScratch.push(cells[k + size]);
			if (x > 0 && y > 0 && votes(cells[k - size - 1])) medianScratch.push(cells[k - size - 1]);
			if (x < size - 1 && y > 0 && votes(cells[k - size + 1])) medianScratch.push(cells[k - size + 1]);
			if (x > 0 && y < size - 1 && votes(cells[k + size - 1])) medianScratch.push(cells[k + size - 1]);
			if (x < size - 1 && y < size - 1 && votes(cells[k + size + 1])) medianScratch.push(cells[k + size + 1]);
			medianScratch.sort((a, b) => a - b);
			avg = medianScratch[medianScratch.length - 1 >> 1];
		} else {
			let sum = 0;
			let count = 0;
			if (x > 0 && votes(cells[k - 1])) {
				sum += cells[k - 1];
				count++;
			}
			if (x < size - 1 && votes(cells[k + 1])) {
				sum += cells[k + 1];
				count++;
			}
			if (y > 0 && votes(cells[k - size])) {
				sum += cells[k - size];
				count++;
			}
			if (y < size - 1 && votes(cells[k + size])) {
				sum += cells[k + size];
				count++;
			}
			if (count === 0) return false;
			avg = unbiased ? divHalfEven(sum, count) : Math.trunc(sum / count);
		}
		if (avg === here) return false;
		const eff = falloff === null ? pct : falloffStrength(pct, falloff, x, y);
		if (eff <= 0) return false;
		let step = Math.trunc((avg - here) * eff / 100);
		if (step === 0 && !fullSteps) step = avg > here ? 1 : -1;
		let next = here + step;
		const band = boundsOf === null ? null : boundsOf(i);
		if (band !== null) {
			if (next < band.lo) next = band.lo;
			if (next > band.hi) next = band.hi;
		}
		const cap = spanCaps === null ? void 0 : spanCaps.get(i);
		if (cap !== void 0) {
			if (next < cap.lo) next = cap.lo;
			if (next > cap.hi) next = cap.hi;
		}
		if (next === here) return false;
		cells[k] = next;
		changed.add(i);
		return true;
	}
	function laplacianPass(cells, viewBase, size, minX, minY, maxX, maxY, pct, changed, boundsOf, layer, falloff = null, kernel = "cross", bilateral = false, fullSteps = false, unbiased = false) {
		let moved = false;
		for (let parity = 0; parity < 2; parity++) for (let y = minY; y <= maxY; y++) {
			const startX = minX + ((minX + y + parity & 1) === 0 ? 0 : 1);
			for (let x = startX; x <= maxX; x += 2) if (laplacianCell(cells, viewBase, size, x, y, pct, changed, boundsOf, layer === null ? null : layer.spanCaps, falloff, kernel, bilateral, fullSteps, unbiased)) moved = true;
		}
		return moved;
	}
	function smooth(map, changed, bboxSeed, spillFree, anchorBounds, spanBand = null, reachCells = null, laplacePct = null, falloff = null, kernel = "cross", bilateral = false, fullSteps = false, cooldown = false, unbiased = false) {
		const seed = bboxSeed ?? changed;
		if (seed.size === 0) return 0;
		const { size } = map;
		let layer = null;
		let cells = map.cells;
		let viewBase = 0;
		const rebuildLayerView = (previous) => {
			const slack = previous === null ? 8 : Math.max(8, previous.lastRow - previous.firstRow + 1);
			let first = minY;
			let last = maxY;
			if (previous === null) for (const i of changed) {
				const y = cellY(size, i);
				if (y < first) first = y;
				if (y > last) last = y;
			}
			else {
				if (previous.firstRow < first) first = previous.firstRow;
				if (previous.lastRow > last) last = previous.lastRow;
			}
			first = Math.max(0, first - slack);
			last = Math.min(size - 1, last + slack);
			layer = buildLayerView(map, spanBand, first, last, previous);
			cells = layer.heights;
			viewBase = layer.base;
		};
		const growLayerView = () => {
			if (layer === null) return;
			if (minY < layer.firstRow || maxY > layer.lastRow) rebuildLayerView(layer);
		};
		const adoptLayerView = (x0, y0, width, height) => {
			if (layer !== null) return;
			if (spanBand === null && !anyColumnLayered(map, x0, y0, width, height)) return;
			rebuildLayerView(null);
		};
		let boundsOf = null;
		if (spillFree !== void 0 || anchorBounds !== void 0) {
			const captured = /* @__PURE__ */ new Map();
			boundsOf = (index) => {
				const anchored = anchorBounds?.get(index);
				if (anchored !== void 0) return anchored;
				if (spillFree === void 0 || spillFree.has(index)) return null;
				let band = captured.get(index);
				if (band === void 0) {
					const h = cells[index - viewBase];
					const sampled = drawnBandOfSample(h);
					const lo = bandFloorHeight(sampled);
					const hi = bandFloorHeight(sampled + 1) - 1;
					if (falloff === null || falloff.rim <= 0) band = {
						lo,
						hi
					};
					else band = rimBand(h, lo, hi, brushDist(falloff.cx, falloff.cy, cellX(size, index), cellY(size, index)), falloff.reach, falloff.rim);
					captured.set(index, band);
				}
				return band;
			};
		}
		let minX = size, minY = size, maxX = -1, maxY = -1;
		for (const i of seed) {
			const x = cellX(size, i);
			const y = cellY(size, i);
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
		adoptLayerView(minX, minY, maxX - minX + 1, maxY - minY + 1);
		const reachMinX = reachCells === null ? 0 : Math.max(0, minX - reachCells);
		const reachMinY = reachCells === null ? 0 : Math.max(0, minY - reachCells);
		const reachMaxX = reachCells === null ? size - 1 : Math.min(size - 1, maxX + reachCells);
		const reachMaxY = reachCells === null ? size - 1 : Math.min(size - 1, maxY + reachCells);
		let adjustingPasses = 0;
		const passLimit = laplacePct === null ? SMOOTH_PASS_LIMIT : 3;
		for (let pass = 0; pass < passLimit; pass++) {
			const heldMinX = minX, heldMinY = minY, heldMaxX = maxX, heldMaxY = maxY;
			if (minX > reachMinX) minX--;
			if (minY > reachMinY) minY--;
			if (maxX < reachMaxX) maxX++;
			if (maxY < reachMaxY) maxY++;
			growLayerView();
			if (minY < heldMinY) adoptLayerView(minX, minY, maxX - minX + 1, 1);
			if (maxY > heldMaxY) adoptLayerView(minX, maxY, maxX - minX + 1, 1);
			if (minX < heldMinX) adoptLayerView(minX, heldMinY, 1, heldMaxY - heldMinY + 1);
			if (maxX > heldMaxX) adoptLayerView(maxX, heldMinY, 1, heldMaxY - heldMinY + 1);
			let changedThisPass = false;
			if (laplacePct === null) for (let y = minY; y <= maxY; y++) {
				const row = y * size;
				for (let x = minX; x <= maxX; x++) {
					const i = row + x;
					if (x < maxX && relaxPair(cells, viewBase, i, i + 1, changed, boundsOf, layer)) changedThisPass = true;
					if (y < maxY && relaxPair(cells, viewBase, i, i + size, changed, boundsOf, layer)) changedThisPass = true;
				}
			}
			else changedThisPass = laplacianPass(cells, viewBase, size, minX, minY, maxX, maxY, laplacePct, changed, boundsOf, layer, falloff, kernel, bilateral, fullSteps || cooldown && pass > 0, unbiased);
			if (!changedThisPass) break;
			adjustingPasses++;
		}
		if (layer !== null) commitLayerView(map, layer, spanBand, changed);
		return adjustingPasses;
	}
	//#endregion
	//#region shared/src/sculpt/reach.ts
	/** How far past its footprint one player smooth may cascade. */
	function smoothCascadeReachCells(radius) {
		return radius + 2;
	}
	//#endregion
	//#region shared/src/heightmap.ts
	function applySculpt(map, cx, cy, radius, amount, options) {
		const tool = options?.tool ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.tool;
		const profile = options?.profile ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.profile;
		const spill = options?.spill ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.spill;
		const anchor = options?.anchor ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.anchor;
		const targetBand = options?.targetBand ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.targetBand;
		const spanBand = options?.spanBand ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand;
		const depthBands = options?.depthBands ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.depthBands;
		const sweepFrom = options?.sweepFrom ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.sweepFrom;
		const smoothLambda = Math.min(100, Math.max(1, options?.smoothLambda ?? 50));
		const smoothFeather = Math.min(100, Math.max(0, options?.smoothFeather ?? 0));
		const smoothRim = Math.min(100, Math.max(0, options?.smoothRim ?? 0));
		const smoothKernel = SMOOTH_KERNELS.includes(options?.smoothKernel ?? "cross") ? options?.smoothKernel ?? "cross" : SMOOTH_KERNEL_DEFAULT;
		const smoothBilateral = options?.smoothBilateral ?? false;
		const smoothFullSteps = options?.smoothFullSteps ?? false;
		const smoothCooldown = options?.smoothCooldown ?? false;
		const smoothUnbiased = options?.smoothUnbiased ?? false;
		if (spanBand !== null && spanIndexCoveringBand(map, cx, cy, spanBand) === null) return [];
		if (tool === "carve") {
			const carveChanged = /* @__PURE__ */ new Set();
			if (spanBand !== null && amount < 0) applyCarve(map, cx, cy, radius, spanBand, depthBands, carveChanged);
			return diffOf(map, carveChanged);
		}
		if (tool === "drag") {
			const dragChanged = /* @__PURE__ */ new Set();
			if (targetBand !== null && amount !== 0) {
				const runFloorBand = options?.runFloorBand ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.runFloorBand ?? targetBand;
				const dragAlt = options?.dragAlt ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.dragAlt;
				applyDragRegion(map, cx, cy, radius, amount > 0, targetBand, runFloorBand > targetBand ? targetBand : runFloorBand, profile, sweepFrom, dragChanged, dragAlt);
			}
			return diffOf(map, dragChanged);
		}
		if (anchor === "band" && (targetBand === null || !canSpreadBandTo(map, cx, cy, targetBand))) return [];
		const strokeAmount = anchor === "band" && amount !== 0 ? amount > 0 ? FULL_HEIGHT_SPAN : -FULL_HEIGHT_SPAN : amount;
		const changed = /* @__PURE__ */ new Set();
		const relaxes = tool === "smooth" || tool === "settle";
		const deposits = tool === "stamp" || tool === "settle";
		const anchoredSmooth = relaxes && anchor !== "free" && amount !== 0;
		const meltRaising = tool === "smooth" ? amount < 0 : amount > 0;
		const anchorTarget = anchoredSmooth ? anchoredTargetHeight(map, cx, cy, meltRaising, targetBand, spanBand) : 0;
		const softCore = profile === "soft" && anchor === "clicked" && tool === "stamp";
		const skirtCoreTarget = softCore ? anchoredTargetHeight(map, cx, cy, strokeAmount > 0, targetBand, spanBand) : 0;
		if (deposits) {
			if (profile === "hard" || softCore) applyLevelFillBrush(map, cx, cy, radius, strokeAmount, changed, anchor, targetBand, spanBand);
			else applyBrush(map, cx, cy, radius, strokeAmount, changed, profile, anchor, targetBand, spanBand);
		}
		if (softCore) applySoftApron(map, cx, cy, radius, strokeAmount, skirtCoreTarget, spanBand, changed);
		if (relaxes) {
			let footprint;
			if (changed.size === 0 || spill === "banded" || anchoredSmooth) {
				const cells = /* @__PURE__ */ new Set();
				forEachFootprintCell(map, cx, cy, radius, (i) => cells.add(i));
				footprint = cells;
			}
			let anchorBounds;
			if (anchoredSmooth) {
				const raising = meltRaising;
				const clickedIndex = cellIndex(map, cx, cy);
				const pinCenter = changed.size > 0;
				anchorBounds = /* @__PURE__ */ new Map();
				for (const i of footprint) {
					const k = layerSpanIndex(map, i, spanBand);
					if (k === null) continue;
					const h = graspedCeiling(map, i, k);
					if (raising ? h > anchorTarget : h < anchorTarget) anchorBounds.set(i, {
						lo: h,
						hi: h
					});
					else if (!pinCenter) anchorBounds.set(i, raising ? {
						lo: Math.max(MIN_HEIGHT, h - 16),
						hi: Math.min(anchorTarget, h + 16)
					} : {
						lo: Math.max(anchorTarget, h - 16),
						hi: Math.min(MAX_HEIGHT, h + 16)
					});
					else anchorBounds.set(i, raising ? {
						lo: i === clickedIndex ? h : MIN_HEIGHT,
						hi: anchorTarget
					} : {
						lo: anchorTarget,
						hi: i === clickedIndex ? h : MAX_HEIGHT
					});
				}
			}
			smooth(map, changed, changed.size === 0 ? footprint : void 0, spill === "banded" ? footprint : void 0, anchorBounds, spanBand, tool === "smooth" ? smoothCascadeReachCells(radius) : null, anchoredSmooth ? smoothLambda : null, anchoredSmooth && (smoothFeather > 0 || smoothRim > 0) ? {
				cx,
				cy,
				reach: smoothCascadeReachCells(radius),
				feather: smoothFeather,
				rim: smoothRim
			} : null, smoothKernel, smoothBilateral, smoothFullSteps, smoothCooldown, smoothUnbiased);
		}
		return diffOf(map, changed);
	}
	new Uint8Array(new Uint16Array([1]).buffer)[0];
	4 * (CELL_WORLD_SIZE * MAX_HEIGHT / 16);
	//#endregion
	//#region shared/src/drawnGround.ts
	var DRAWN_GROUND_COORD_DENOM = 1024;
	DRAWN_GROUND_COORD_DENOM * (1 / 2);
	var WEIGHT_TOTAL = DRAWN_GROUND_COORD_DENOM * DRAWN_GROUND_COORD_DENOM;
	16 * WEIGHT_TOTAL;
	1 * WEIGHT_TOTAL;
	1 / DRAWN_GROUND_COORD_DENOM / 4;
	var ISOLINE_SOLVE_DENOM = 65536;
	ISOLINE_SOLVE_DENOM / DRAWN_GROUND_COORD_DENOM;
	ISOLINE_SOLVE_DENOM * ISOLINE_SOLVE_DENOM;
	//#endregion
	//#region shared/src/climb.ts
	var WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND = .5;
	var CLIMB_SPEED_FRACTION_OF_WALK = 1 / 2;
	var BAND_WORLD_UNITS = 16 * (16 / MAX_HEIGHT);
	var CLIMB_SECONDS_PER_BAND = BAND_WORLD_UNITS / (WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND * CLIMB_SPEED_FRACTION_OF_WALK);
	16 / CLIMB_SECONDS_PER_BAND;
	cellsAcross(.1009375);
	CLIMB_SECONDS_PER_BAND / 4;
	16 / (BAND_WORLD_UNITS / (WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND * 3));
	Object.freeze({
		climbHeight: null,
		falling: false
	});
	cellsAcross(.01);
	Object.freeze({ stance: null });
	10 / (CELL_WORLD_SIZE / WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND);
	cellsOverArea(4096);
	Math.PI * 2;
	Math.PI / 4;
	cellsAcross(2);
	//#endregion
	//#region scratch-lab-driver.ts
	function gauss2(x, y, cx, cy, amp, s) {
		const dx = x - cx;
		const dy = y - cy;
		return amp * Math.exp(-(dx * dx + dy * dy) / (2 * s * s));
	}
	/** Deterministic speckle: no RNG, same field every load. */
	function hashNoise(x, y, amp) {
		let h = x * 73856093 ^ y * 19349663;
		h = (h ^ h >>> 13) >>> 0;
		return h % (2 * amp + 1) - amp;
	}
	function makeFixture(kind, N) {
		const C = (N - 1) / 2;
		const out = new Int16Array(N * N);
		for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
			let h;
			if (kind === "spike") h = 64 + gauss2(x, y, C, C, 140, N / 7) + (x === Math.round(C) && y === Math.round(C) ? 110 : 0);
			else if (kind === "mound") h = 64 + gauss2(x, y, C, C, 190, N / 6.4);
			else if (kind === "pit") h = 220 - gauss2(x, y, C, C, 150, N / 7);
			else if (kind === "wall") h = x < C ? 200 : 60;
			else if (kind === "noisyTerraces") h = 64 + Math.floor(gauss2(x, y, C, C, 190, N / 6.4) / 16) * 16 + hashNoise(x, y, 3);
			else h = 64 + Math.floor(gauss2(x, y, C, C, 190, N / 6.4) / 16) * 16;
			out[y * N + x] = Math.round(h);
		}
		return out;
	}
	function runSmooth(cells, N, o) {
		const map = createHeightmap(N);
		map.cells.set(cells);
		const cx = N >> 1;
		const cy = N >> 1;
		let touched = 0;
		for (let p = 0; p < o.presses; p++) {
			const diff = applySculpt(map, cx, cy, o.radius, o.dir * 16, {
				tool: "smooth",
				anchor: "clicked",
				spill: "banded",
				smoothLambda: o.lambda,
				smoothFeather: o.feather,
				smoothRim: o.rim,
				smoothKernel: o.kernel,
				smoothBilateral: o.bilateral,
				smoothFullSteps: o.fullSteps,
				smoothCooldown: o.cooldown,
				smoothUnbiased: o.unbiased
			});
			touched += diff.length;
		}
		return {
			cells: Int16Array.from(map.cells),
			touched
		};
	}
	//#endregion
	exports.makeFixture = makeFixture;
	exports.runSmooth = runSmooth;
	return exports;
})({});
