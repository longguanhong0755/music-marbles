#!/usr/bin/env python3
"""Render a built-in score to a stereo WAV with a simple piano-ish synth.

Usage: python3 tools/synth_builtin.py builtins/<slug>/score.json out.wav
"""
import json
import math
import sys
import wave

import numpy as np

SR = 44100


def midi_hz(m):
    return 440.0 * 2.0 ** ((m - 69.0) / 12.0)


def main():
    score_path, wav_path = sys.argv[1], sys.argv[2]
    with open(score_path) as f:
        score = json.load(f)

    notes = score["midi"]
    end = max(n["time"] + n["duration"] for n in notes) + 1.2
    total = int(math.ceil(end * SR))
    left = np.zeros(total, dtype=np.float64)
    right = np.zeros(total, dtype=np.float64)

    for note in notes:
        freq = midi_hz(note["midi"])
        dur = max(0.05, note["duration"])
        tail = 0.45
        length = int(math.ceil((dur + tail) * SR))
        if length <= 0:
            continue
        start = int(round(note["time"] * SR))
        if start >= total:
            continue
        length = min(length, total - start)

        t = np.arange(length, dtype=np.float64) / SR
        vel = max(0.08, min(1.0, float(note.get("velocity", 0.7))))

        # attack + exponential decay, then a short release after the key-up
        attack = 0.006
        decay = 0.55 + 1.1 * (1.0 - (note["midi"] - 21.0) / 87.0)
        env = (1.0 - np.exp(-t / attack)) * np.exp(-t / max(0.18, decay))
        if dur < length / SR:
            rel = np.ones(length, dtype=np.float64)
            idx = int(round(dur * SR))
            if idx < length:
                rel[idx:] = np.exp(-(t[idx:] - dur) / 0.13)
            env *= rel
        env *= vel

        # a few harmonics, slightly stretched, plus a detuned fundamental
        wave_data = np.zeros(length, dtype=np.float64)
        for h, amp in enumerate((1.0, 0.52, 0.28, 0.14, 0.07, 0.035), start=1):
            f = freq * h * (1.0 + 0.00035 * h * h)
            if f >= SR * 0.45:
                break
            wave_data += amp * np.sin(2.0 * math.pi * f * t + (h * 0.73) % 6.283)
        wave_data += 0.18 * np.sin(2.0 * math.pi * freq * 1.0032 * t + 1.1)
        wave_data *= env

        pan = max(-0.55, min(0.55, (note["midi"] - 62.0) / 55.0))
        gl = math.sqrt(0.5 * (1.0 - pan))
        gr = math.sqrt(0.5 * (1.0 + pan))
        left[start:start + length] += wave_data * gl
        right[start:start + length] += wave_data * gr

    peak = max(float(np.max(np.abs(left))), float(np.max(np.abs(right))), 1e-9)
    gain = 0.88 / peak
    left *= gain
    right *= gain

    fade_in = min(total, int(0.01 * SR))
    if fade_in:
        ramp = np.linspace(0.0, 1.0, fade_in)
        left[:fade_in] *= ramp
        right[:fade_in] *= ramp
    fade_out = min(total, int(0.35 * SR))
    if fade_out:
        ramp = np.linspace(1.0, 0.0, fade_out)
        left[-fade_out:] *= ramp
        right[-fade_out:] *= ramp

    pcm = np.empty((total, 2), dtype=np.int16)
    pcm[:, 0] = np.clip(left * 32767.0, -32768, 32767).astype(np.int16)
    pcm[:, 1] = np.clip(right * 32767.0, -32768, 32767).astype(np.int16)

    with wave.open(wav_path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())

    print(f"  {len(notes)} notes, {total / SR:.1f}s, peak {peak:.3f}")


if __name__ == "__main__":
    main()
