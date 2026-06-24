import os
import random
import subprocess

def addSounds(audioFile, count, soundsDir):
    sounds = [
        os.path.join(soundsDir, f) for f in os.listdir(soundsDir)
        if f.lower().endswith(('.mp3', '.wav', '.ogg', '.flac', '.m4a'))
    ]
    if not sounds:
        return

    count = max(1, int(count))
    selected = [random.choice(sounds) for _ in range(count)]

    inputs = [audioFile] + selected
    n = len(inputs)
    input_labels = "".join(f"[{i}:a]" for i in range(n))
    filter_complex = f"{input_labels}amix=inputs={n}:duration=first:normalize=0[aout]"

    tmp = audioFile + ".sfx_tmp.wav"
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    for inp in inputs:
        cmd += ["-i", inp]
    cmd += ["-filter_complex", filter_complex, "-map", "[aout]", tmp]

    subprocess.run(cmd, check=True)
    os.replace(tmp, audioFile)
