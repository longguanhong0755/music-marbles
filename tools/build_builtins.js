#!/usr/bin/env node
/*
 * Builds the bundled demo tracks from MIDI data:
 *
 *   builtins/<slug>/notes.json  visual notes (merged chords, seconds)
 *   builtins/<slug>/score.json  every note, for tools/synth_builtin.py
 *   builtins/manifest.json      titles, sources, durations, URLs
 *
 * Sources:
 *   - music/music.js: the original MusicMarbles MIDI library (public-domain
 *     compositions, original project: https://github.com/AndrewB330/MusicMarbles)
 *
 * Usage: node tools/build_builtins.js [slug ...]
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

const SOURCE_ORIGINAL = {
    sourceId: 'musicmarbles',
    source: '原项目曲库',
    license: '公版作品',
    sourceUrl: 'https://github.com/AndrewB330/MusicMarbles'
};

const TRACKS = [
    {
        song: 0, slug: 'mozart-rondo', title: '土耳其进行曲', subtitle: '莫扎特',
        cap: 75, ...SOURCE_ORIGINAL
    },
    {
        song: 1, slug: 'mountain-king', title: '山魔王的宫殿', subtitle: '格里格',
        cap: 75, ...SOURCE_ORIGINAL
    },
    {
        song: 4, slug: 'entertainer', title: '演艺人', subtitle: '斯科特·乔普林',
        cap: 75, ...SOURCE_ORIGINAL
    },
    {
        song: 5, slug: 'sugar-plum', title: '糖梅仙子之舞', subtitle: '柴可夫斯基',
        cap: 75, ...SOURCE_ORIGINAL
    }
];

const MERGE_WINDOW_MS = 80;

function load_song(spec) {
    return MUSIC[spec.song];
}

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

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const selected = requested.length
    ? TRACKS.filter((spec) => requested.includes(spec.slug))
    : TRACKS;
if (!selected.length) {
    console.error('No matching track slugs. Available: ' + TRACKS.map((t) => t.slug).join(', '));
    process.exit(1);
}

fs.mkdirSync(outDir, {recursive: true});

// Keep metadata for tracks that were not rebuilt in this invocation.
let previous = [];
try {
    previous = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')).tracks || [];
} catch (err) { /* first run */ }
const manifestById = new Map(previous.map((item) => [item.id, item]));

for (const spec of selected) {
    const built = build_song(load_song(spec), spec.cap);
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
    manifestById.set('builtin-' + spec.slug, {
        id: 'builtin-' + spec.slug,
        title: spec.title,
        subtitle: spec.subtitle,
        sourceId: spec.sourceId,
        source: spec.source,
        license: spec.license,
        sourceUrl: spec.sourceUrl,
        duration: built.duration,
        notes: `/builtins/${spec.slug}/notes.json`,
        audio: `/builtins/${spec.slug}/audio.mp3`,
        bytes: stat.size,
        bars: built.visual_notes.length
    });
    console.log(`${spec.slug}: ${built.visual_notes.length} bars, ${built.duration.toFixed(1)}s, ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
}

const manifest = TRACKS
    .map((spec) => manifestById.get('builtin-' + spec.slug))
    .filter(Boolean);

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({tracks: manifest}, null, 2));
console.log('wrote', path.join(outDir, 'manifest.json'));
