from pathlib import Path
import subprocess,sys
subprocess.run([sys.executable,str(Path(__file__).parent.parent/'building-kit'/'run_delivery.py'),'twin-hut-yard'],check=True)
