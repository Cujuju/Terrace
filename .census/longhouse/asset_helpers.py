"""PNG and uniform-density atlas helpers for the original longhouse asset."""
import pathlib
import struct
import zlib
import numpy as np

ATLAS_SIZE = 2048
ISLAND_GAP = 12

def write_png(path, pixels, srgb=False):
    pixels = np.clip(np.round(pixels * 255), 0, 255).astype(np.uint8)
    height, width, channels = pixels.shape
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    output = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2 if channels == 3 else 6, 0, 0, 0))
    if srgb:
        output += chunk(b'sRGB', b'\x00')
    scanlines = b''.join(b'\x00' + row.tobytes() for row in pixels)
    output += chunk(b'IDAT', zlib.compress(scanlines, 9)) + chunk(b'IEND', b'')
    pathlib.Path(path).write_bytes(output)

def pack_rectangles(dimensions):
    dimensions = np.asarray(dimensions)
    def attempt(density):
        skyline = np.zeros(ATLAS_SIZE, dtype=int)
        placed = {}
        sizes = np.ceil(dimensions * density).astype(int) + ISLAND_GAP
        order = sorted(range(len(sizes)), key=lambda i: -int(np.prod(sizes[i])))
        for i in order:
            best = None
            for rotated in (False, True):
                width, height = sizes[i][::-1] if rotated else sizes[i]
                if max(width, height) > ATLAS_SIZE:
                    continue
                heights = np.lib.stride_tricks.sliding_window_view(skyline, int(width)).max(axis=1)
                x = int(np.argmin(heights))
                y = int(heights[x])
                score = y + height
                if score <= ATLAS_SIZE and (best is None or score < best[0]):
                    best = (score, x, y, int(width), int(height), rotated)
            if best is None:
                return None
            _, x, y, width, height, rotated = best
            skyline[x:x + width] = y + height
            placed[i] = (x, y, width, height, rotated)
        return placed
    low, high = 0.0, ATLAS_SIZE / max(dimensions.max(), 1e-8)
    placements = None
    for _ in range(15):
        middle = (low + high) / 2
        trial = attempt(middle)
        if trial is None:
            high = middle
        else:
            low, placements = middle, trial
    if placements is None or low <= 0:
        raise ValueError('The atlas cannot fit the requested island padding.')
    return low, placements

def project_polygon(points, normal, grain_axis=None):
    points = np.asarray(points, dtype=float)
    normal = np.asarray(normal, dtype=float).copy()
    normal /= np.linalg.norm(normal)
    candidates = np.roll(points, -1, axis=0) - points
    if grain_axis is not None:
        candidates = np.vstack((grain_axis, candidates))
    best = None
    for axis in candidates:
        axis = axis - normal * np.dot(axis, normal)
        if np.linalg.norm(axis) < 1e-6:
            continue
        axis /= np.linalg.norm(axis)
        across = np.cross(normal, axis)
        projected = np.column_stack((points @ axis, points @ across))
        dimensions = np.ptp(projected, axis=0)
        score = np.prod(dimensions)
        if best is None or score < best[0] - 1e-8:
            best = (score, axis, across, projected, dimensions)
    if best is None:
        raise ValueError('Degenerate polygon cannot be unwrapped.')
    _, axis, across, projected, dimensions = best
    return dict(t=axis, v=across, xy=projected, lo=projected.min(axis=0), dim=dimensions, n=normal)


