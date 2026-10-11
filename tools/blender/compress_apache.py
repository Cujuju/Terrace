"""Compress Apache GLBs to embedded KTX2/UASTC textures with full mip chains.

Run with Python and one or more absolute GLB paths to update them in place.
Requires the repository's glTF Transform CLI, Node, and KTX-Software on PATH.
"""

from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile


def compress_glb(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    cli = Path(__file__).resolve().parents[2] / 'node_modules/@gltf-transform/cli/bin/cli.js'
    node = shutil.which('node')
    if not node or not cli.is_file() or not shutil.which('toktx'):
        raise RuntimeError('Apache KTX2 export requires Node, pnpm install, and KTX-Software (toktx) on PATH')
    output.parent.mkdir(parents=True, exist_ok=True)
    # A failed encoder must not replace a working asset or leave half a GLB.
    with tempfile.NamedTemporaryFile(dir=output.parent, prefix='.apache-ktx2-',
                                     suffix='.glb', delete=False) as stream:
        temporary = Path(stream.name)
    try:
        subprocess.run([
            node, str(cli), 'uastc', str(source), str(temporary),
            '--level', '4', '--zstd', '18', '--mipmaps', 'true', '--jobs', '3',
        ], check=True)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    print(f'KTX2 asset: {output} ({output.stat().st_size:,} bytes)')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit('Usage: python compress_apache.py <absolute.glb> [<absolute.glb> ...]')
    for path in sys.argv[1:]:
        compress_glb(path, path)
