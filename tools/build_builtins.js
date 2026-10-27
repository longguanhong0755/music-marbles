#!/usr/bin/env node
/*
 * Builds the bundled demo tracks from the MIDI data in music/music.js.
 *
 *   builtins/<slug>/notes.json  visual notes (merged chords, seconds)
 *   builtins/<slug>/score.json  every note, for tools/synth_builtin.py
 *   builtins/manifest.json      titles, durations, URLs
 *
 * Usage: node tools/build_builtins.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {execFileSync} = require('child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'builtins');

const ctx = {console};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'music/music.js'), 'utf8') + '; this.music = music;', ctx);
const MUSIC = ctx.music;

const TRACKS = [
    {song: 0, slug: 'mozart-rondo', title: 'Rondo Alla Turca', subtitle: 'Mozart', cap: 75},
    {song: 1, slug: 'mountain-king', title: 'In the Hall of the Mountain King', subtitle: 'Grieg', cap: 75},
    {song: 4, slug: 'entertainer', title: 'The Entertainer', subtitle: 'Scott Joplin', cap: 75}
];

const MERGE_WINDOW_MS = 80;

function build_song(midi, cap) {
    let track_id = 0;
    midi.tracks.forEach((track, idx) => {
        if (track.notes.length > midi.tracks[track_id].notes.length) track_id = idx;
    });

    const multiplier = midi.header.multiplier || 1.0;
    const source = [...midi.tracks[track_id].notes].sort((a, b) => a.time - b.time);
    const offset = 0.5 - source[0].time * multiplier;

    const audio_notes = [];
    const visual_notes = [];

    for (let i = 0; i < source.length; i++) {
        const note = source[i];
        const time = note.time * multiplier + offset;
        if (time >= cap) break;
        if (i > 0) {
            const prev = source[i - 1].time * multiplier + offset;
            if (prev + 4 < time) break;
        }

        const duration = Math.max(0.05, note.duration * multiplier);
        audio_notes.push({
            midi: note.midi,
            name: note.name,
            velocity: note.velocity,
            time,
            duration
        });

        const ms = Math.round(time * 1000);
        const last = visual_notes[visual_notes.length - 1];
        if (last && ms - Math.round(last.time * 1000) < MERGE_WINDOW_MS) {
            if (!last.note_names.includes(note.name)) last.note_names.push(note.name);
            last.duration = Math.max(last.duration, duration);
            last.midi = Math.min(last.midi, note.midi);
        } else {
            visual_notes.push({
                note_names: [note.name],
                time,
                duration,
                midi: note.midi
            });
        }
    }

    const end = audio_notes.reduce((m, n) => Math.max(m, n.time + n.duration), 0);
    return {audio_notes, visual_notes, duration: Math.min(cap + 3, end + 1.2)};
}

function write_wav(slug) {
    const score = path.join(outDir, slug, 'score.json');
    const wav = path.join(outDir, slug, 'audio.wav');
    execFileSync('python3', [path.join(__dirname, 'synth_builtin.py'), score, wav], {stdio: 'inherit'});
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', wav,
        '-codec:a', 'libmp3lame', '-b:a', '192k', path.join(outDir, slug, 'audio.mp3')], {stdio: 'inherit'});
    fs.unlinkSync(wav);
}

fs.mkdirSync(outDir, {recursive: true});
const manifest = [];

for (const spec of TRACKS) {
    const built = build_song(MUSIC[spec.song], spec.cap);
    const dir = path.join(outDir, spec.slug);
    fs.mkdirSync(dir, {recursive: true});

    fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({
        title: spec.title,
        subtitle: spec.subtitle,
        duration: built.duration,
        notes: built.visual_notes.map(n => ({
            note_names: n.note_names,
            time: n.time,
            duration: n.duration
        }))
    }, null, 2));

    fs.writeFileSync(path.join(dir, 'score.json'), JSON.stringify({
        title: spec.title,
        subtitle: spec.subtitle,
        midi: built.audio_notes,
        visual: built.visual_notes
    }, null, 2));

    write_wav(spec.slug);

    const stat = fs.statSync(path.join(dir, 'audio.mp3'));
    manifest.push({
        id: 'builtin-' + spec.slug,
        title: spec.title,
        subtitle: spec.subtitle,
        duration: built.duration,
        notes: `/builtins/${spec.slug}/notes.json`,
        audio: `/builtins/${spec.slug}/audio.mp3`,
        bytes: stat.size,
        bars: built.visual_notes.length
    });
    console.log(`${spec.slug}: ${built.visual_notes.length} bars, ${built.duration.toFixed(1)}s, ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
}

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({tracks: manifest}, null, 2));
console.log('wrote', path.join(outDir, 'manifest.json'));
