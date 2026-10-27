/* Basic Pitch runs in a worker so the landing page stays responsive. */
import {BasicPitch, outputToNotesPoly, noteFramesToTime} from '@spotify/basic-pitch';
import * as tf from '@tensorflow/tfjs';

let model = null;
let model_url = '';

async function get_model(url) {
    if (model && model_url === url) return model;
    await tf.setBackend('cpu');
    await tf.ready();
    model_url = url;
    model = new BasicPitch(url);
    return model;
}

self.onmessage = async (event) => {
    const msg = event.data || {};
    if (msg.type !== 'transcribe') return;
    try {
        const bp = await get_model(msg.modelUrl);
        const frames = [];
        const onsets = [];
        const contours = [];
        await bp.evaluateModel(
            msg.audio,
            (f, o, c) => {
                for (const row of f) frames.push(row);
                for (const row of o) onsets.push(row);
                for (const row of c) contours.push(row);
            },
            (progress) => self.postMessage({type: 'progress', value: progress})
        );
        const notes = noteFramesToTime(outputToNotesPoly(
            frames, onsets,
            msg.onsetThreshold ?? 0.25,
            msg.frameThreshold ?? 0.25,
            msg.minNoteLength ?? 5
        ));
        self.postMessage({
            type: 'done',
            notes: notes.map((n) => ({
                startTimeSeconds: n.startTimeSeconds,
                durationSeconds: n.durationSeconds,
                pitchMidi: n.pitchMidi,
                amplitude: n.amplitude
            }))
        });
    } catch (err) {
        self.postMessage({type: 'error', message: err && err.message ? err.message : String(err)});
    }
};
