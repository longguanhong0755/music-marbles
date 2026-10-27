/* Fast onset + pitch worker.
 *
 * This is deliberately not a full transcription model. It finds the moments
 * where the spectrum changes (note attacks), estimates the strongest pitches
 * in those frames, and returns one visual bar per attack. It runs in a worker
 * so a six-minute upload does not freeze the landing page.
 */
'use strict';

const N = 2048;
const HOP = 512;
const MIN_INTERVAL_FRAMES = 4;

function make_window() {
    const w = new Float32Array(N);
    for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    return w;
}

const WINDOW = make_window();

function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const angle = -2 * Math.PI / len;
        const wr0 = Math.cos(angle);
        const wi0 = Math.sin(angle);
        const half = len >> 1;
        for (let i = 0; i < n; i += len) {
            let wr = 1, wi = 0;
            for (let j = 0; j < half; j++) {
                const ur = re[i + j], ui = im[i + j];
                const vr = re[i + j + half] * wr - im[i + j + half] * wi;
                const vi = re[i + j + half] * wi + im[i + j + half] * wr;
                re[i + j] = ur + vr;
                im[i + j] = ui + vi;
                re[i + j + half] = ur - vr;
                im[i + j + half] = ui - vi;
                const nwr = wr * wr0 - wi * wi0;
                wi = wr * wi0 + wi * wr0;
                wr = nwr;
            }
        }
    }
}

function note_name(midi) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const m = Math.round(midi);
    return names[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

function hz_to_midi(hz) {
    return 69 + 12 * Math.log2(hz / 440);
}

function fill_frame(audio, pos, re, im) {
    for (let i = 0; i < N; i++) {
        const v = pos + i < audio.length ? audio[pos + i] : 0;
        re[i] = v * WINDOW[i];
        im[i] = 0;
    }
}

function magnitude(re, im, out) {
    for (let k = 0; k < N / 2; k++) out[k] = Math.hypot(re[k], im[k]);
}

function pick_pitches(mag, sample_rate, max_count) {
    const bin_hz = sample_rate / N;
    const lo = Math.max(4, Math.floor(65 / bin_hz));
    const hi = Math.min(N / 2 - 2, Math.ceil(2200 / bin_hz));
    let max = 0;
    for (let k = lo; k <= hi; k++) if (mag[k] > max) max = mag[k];
    if (max <= 0) return [];

    const peaks = [];
    for (let k = lo; k <= hi; k++) {
        if (mag[k] < mag[k - 1] || mag[k] < mag[k + 1]) continue;
        if (mag[k] < max * 0.12) continue;
        const a = mag[k - 1] || 1e-9;
        const b = mag[k];
        const c = mag[k + 1] || 1e-9;
        const denom = a - 2 * b + c;
        const delta = Math.abs(denom) > 1e-9 ? 0.5 * (a - c) / denom : 0;
        const freq = (k + Math.max(-0.5, Math.min(0.5, delta))) * bin_hz;
        if (freq < 65 || freq > 2200) continue;
        peaks.push({freq, mag: b});
    }
    peaks.sort((a, b) => b.mag - a.mag);

    const picked = [];
    for (const peak of peaks) {
        const midi = hz_to_midi(peak.freq);
        if (midi < 21 || midi > 108) continue;
        let harmonic = false;
        for (const p of picked) {
            const semis = Math.abs(12 * Math.log2(peak.freq / p.freq));
            if (semis < 2.2) { harmonic = true; break; }
        }
        if (harmonic) continue;
        if (peak.mag < max * 0.18) continue;
        picked.push(peak);
        if (picked.length >= max_count) break;
    }
    // Prefer the lowest note as the colour anchor, but keep the chord names.
    picked.sort((a, b) => a.freq - b.freq);
    return picked;
}

function analyze(audio, sample_rate) {
    const frames = Math.max(2, Math.floor((audio.length - N) / HOP) + 1);
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    const mag = new Float32Array(N / 2);
    const prev = new Float32Array(N / 2);
    const flux = new Float32Array(frames);
    const rms = new Float32Array(frames);

    for (let f = 0; f < frames; f++) {
        const pos = f * HOP;
        let energy = 0;
        for (let i = 0; i < N; i++) {
            const v = pos + i < audio.length ? audio[pos + i] : 0;
            energy += v * v;
        }
        rms[f] = Math.sqrt(energy / N);
        fill_frame(audio, pos, re, im);
        fft(re, im);
        magnitude(re, im, mag);

        let sum = 0;
        for (let k = 1; k < N / 2; k++) {
            const v = Math.log1p(mag[k] * 3);
            const d = v - prev[k];
            if (d > 0) sum += d;
            prev[k] = v;
        }
        flux[f] = sum;
        if (f % 80 === 0) self.postMessage({type: 'progress', value: f / frames});
    }

    let max_flux = 0;
    for (let i = 0; i < frames; i++) max_flux = Math.max(max_flux, flux[i]);
    if (max_flux <= 0) return [];

    const score = new Float32Array(frames);
    let max_rms_d = 0;
    for (let i = 1; i < frames; i++) max_rms_d = Math.max(max_rms_d, Math.max(0, rms[i] - rms[i - 1]));
    for (let i = 1; i < frames; i++) {
        const f = flux[i] / max_flux;
        const r = max_rms_d > 0 ? Math.max(0, rms[i] - rms[i - 1]) / max_rms_d : 0;
        score[i] = 0.78 * f + 0.22 * r;
    }

    const onsets = [];
    let last = -MIN_INTERVAL_FRAMES;
    for (let i = 1; i < frames - 1; i++) {
        const local = [];
        for (let j = Math.max(0, i - 10); j <= Math.min(frames - 1, i + 10); j++) local.push(score[j]);
        const mean = local.reduce((a, b) => a + b, 0) / local.length;
        const variance = local.reduce((a, b) => a + (b - mean) * (b - mean), 0) / local.length;
        const threshold = mean + 0.9 * Math.sqrt(variance) + 0.012;
        if (score[i] < threshold) continue;
        if (score[i] < score[i - 1] || score[i] < score[i + 1]) continue;
        if (i - last < MIN_INTERVAL_FRAMES) continue;
        onsets.push({frame: i, strength: score[i]});
        last = i;
    }

    if (!onsets.length) {
        // A quiet or very legato track may never clear the adaptive gate.
        for (let i = 1; i < frames - 1; i++) {
            if (score[i] < score[i - 1] || score[i] < score[i + 1]) continue;
            if (score[i] < 0.015) continue;
            if (i - last < MIN_INTERVAL_FRAMES) continue;
            onsets.push({frame: i, strength: score[i]});
            last = i;
        }
    }

    const notes = [];
    for (let n = 0; n < onsets.length; n++) {
        const frame = onsets[n].frame;
        fill_frame(audio, frame * HOP, re, im);
        fft(re, im);
        magnitude(re, im, mag);
        const picked = pick_pitches(mag, sample_rate, 3);
        if (!picked.length) continue;
        const time = (frame * HOP + N * 0.5) / sample_rate;
        const next = n + 1 < onsets.length
            ? (onsets[n + 1].frame * HOP + N * 0.5) / sample_rate
            : time + 0.4;
        const duration = Math.max(0.08, Math.min(1.5, next - time));
        notes.push({
            startTimeSeconds: time,
            durationSeconds: duration,
            pitchMidi: hz_to_midi(picked[0].freq),
            note_names: picked.map((p) => note_name(hz_to_midi(p.freq))),
            amplitude: Math.min(1, 0.25 + onsets[n].strength * 2.2)
        });
    }
    return notes;
}

self.onmessage = (event) => {
    const msg = event.data || {};
    if (msg.type !== 'analyze') return;
    try {
        const audio = msg.audio;
        const sampleRate = msg.sampleRate || 22050;
        const result = analyze(audio, sampleRate);
        self.postMessage({type: 'done', notes: result});
    } catch (err) {
        self.postMessage({type: 'error', message: err && err.message ? err.message : String(err)});
    }
};
