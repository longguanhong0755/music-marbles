#!/usr/bin/env node
/*
 * Verifies the compact folded-path engine (scripts/engine.js) against every
 * bundled track without a browser:
 *   - near-simultaneous notes are grouped into chords (80 ms), one bar per hit
 *   - the depth-first fold keeps the cluster compact and visits every bar once
 *   - no two bars overlap, every bar is inside the song-sized playfield
 *   - the centreline keeps collision clearance from every non-target bar
 *   - the marble travels at one constant speed for the whole song
 *   - every chord/note is hit on its timestamp
 *
 * Usage: node tools/verify_engine.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

const ctx = {console, performance};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'scripts/engine.js'), 'utf8') + '; this.API = API;', ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'music/music.js'), 'utf8') + '; this.music = music;', ctx);

const API = ctx.API;
const MUSIC = ctx.music;
const TICK = 15;
const MERGE_WINDOW_MS = 80;
const HALF_THICK = 4;
const HALF_LEN = 14; // visual half-length (bar is 28 x 8)

function buildTrack(midi) {
    let id = 0;
    midi.tracks.forEach((t, i) => {
        if (t.notes.length > midi.tracks[id].notes.length) id = i;
    });
    const mult = midi.header.multiplier || 1;
    const notes = [...midi.tracks[id].notes].sort((a, b) => a.time - b.time);
    const offset = 0.5 - notes[0].time * mult;
    const unmerged = notes.map(n => ({time: n.time * mult + offset}));
    const times = [];
    for (let i = 0; i < unmerged.length; i++) {
        if (i > 0 && unmerged[i - 1].time + 4 < unmerged[i].time) break;
        const t = Math.round(unmerged[i].time * 1000);
        if (times.length && t - times[times.length - 1] < MERGE_WINDOW_MS) continue;
        times.push(t);
    }
    return times;
}

function segDist(p1, p2, q1, q2) {
    const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
    const d2x = q2[0] - q1[0], d2y = q2[1] - q1[1];
    const rx = p1[0] - q1[0], ry = p1[1] - q1[1];
    const a = d1x * d1x + d1y * d1y;
    const e = d2x * d2x + d2y * d2y;
    const f = d2x * rx + d2y * ry;
    const EPS = 1e-9;
    let s = 0, t = 0;

    if (a <= EPS && e <= EPS) {
        s = t = 0;
    } else if (a <= EPS) {
        s = 0;
        t = Math.max(0, Math.min(1, f / e));
    } else {
        const c = d1x * rx + d1y * ry;
        if (e <= EPS) {
            t = 0;
            s = Math.max(0, Math.min(1, -c / a));
        } else {
            const b = d1x * d2x + d1y * d2y;
            const denom = a * e - b * b;
            if (Math.abs(denom) > EPS) s = Math.max(0, Math.min(1, (b * f - c * e) / denom));
            else s = 0;
            t = (b * s + f) / e;
            if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
            else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
        }
    }

    const cx1 = p1[0] + d1x * s, cy1 = p1[1] + d1y * s;
    const cx2 = q1[0] + d2x * t, cy2 = q1[1] + d2y * t;
    return Math.hypot(cx1 - cx2, cy1 - cy2);
}

function barRect(p) {
    const cx = p.vertical ? p.a[0] : (p.a[0] + p.b[0]) * 0.5;
    const cy = p.vertical ? (p.a[1] + p.b[1]) * 0.5 : p.a[1];
    const hx = p.vertical ? HALF_THICK : HALF_LEN;
    const hy = p.vertical ? HALF_LEN : HALF_THICK;
    return {minx: cx - hx, maxx: cx + hx, miny: cy - hy, maxy: cy + hy};
}

function rectOverlap(a, b) {
    return a.minx < b.maxx - 1e-9 && a.maxx > b.minx + 1e-9 &&
           a.miny < b.maxy - 1e-9 && a.maxy > b.miny + 1e-9;
}

let failed = 0;

for (let song = 0; song < MUSIC.length; song++) {
    const times = buildTrack(MUSIC[song]);

    API.reset_tracks();
    for (const t of times) API.add_time_of_hit(0, t);
    API.init_generator();

    const bounds = API.get_bounds();
    const field = bounds.field;
    const start = API.get_start();
    const generated = API.get_stats();
    const bars = API.get_planks();
    const verts = API.get_path();
    const B = bars.length;

    // --- geometry checks ---------------------------------------------------
    let outOfField = 0;
    if (start.x < field.min_x || start.x > field.max_x ||
        start.y < field.min_y || start.y > field.max_y) outOfField++;
    for (const p of bars) {
        for (const q of [p.a, p.b]) {
            if (q[0] < field.min_x - 1e-6 || q[0] > field.max_x + 1e-6 ||
                q[1] < field.min_y - 1e-6 || q[1] > field.max_y + 1e-6) outOfField++;
        }
    }

    let overlaps = 0;
    const rects = bars.map(barRect);
    for (let i = 0; i < B; i++) {
        for (let j = i + 1; j < B; j++) {
            if (rectOverlap(rects[i], rects[j])) overlaps++;
        }
    }

    // Centreline: start -> bar0 -> bar1 ... The bars at both ends of a side
    // are excluded; every other bar must be farther than STANDOFF.
    let clipping = 0;
    let minClear = Infinity;
    for (let i = -1; i < B - 1; i++) {
        const p1 = i < 0 ? [start.x, start.y] : [verts[i].x, verts[i].y];
        const p2 = [verts[i + 1].x, verts[i + 1].y];
        for (let j = 0; j < B; j++) {
            if (j === i || j === i + 1) continue;
            const d = segDist(p1, p2, bars[j].a, bars[j].b);
            minClear = Math.min(minClear, d);
            if (d < bounds.standoff - 1e-6) clipping++;
        }
    }

    // --- playback ----------------------------------------------------------
    const triggers = [];
    const end = times[times.length - 1] + 5000;
    let outOfFieldBall = 0;
    let minSpeed = Infinity, maxSpeed = -Infinity;
    for (let elapsed = 0; elapsed < end; elapsed += TICK) {
        API.update_main_world();
        const x = API.get_marble_x(0);
        const y = API.get_marble_y(0);
        if (x < field.min_x - 1e-6 || x > field.max_x + 1e-6 ||
            y < field.min_y - 1e-6 || y > field.max_y + 1e-6) outOfFieldBall++;

        const s = API.get_state();
        if (s && !s.finished) {
            const speed = Math.hypot(s.vx, s.vy);
            minSpeed = Math.min(minSpeed, speed);
            maxSpeed = Math.max(maxSpeed, speed);
        }

        const hit = API.get_marble_collision(0);
        if (hit !== -1) {
            triggers.push({bar: hit, time: API.get_last_hit_time(), tick: API.get_time()});
        }
    }

    let correct = 0, early = 0, late = 0, wrong = 0, maxErr = 0;
    const seen = new Set();
    for (let k = 0; k < triggers.length; k++) {
        const tr = triggers[k];
        if (tr.bar === k && !seen.has(tr.bar)) {
            const err = tr.time - times[k];
            if (err < -TICK) early++;
            else if (err > TICK) late++;
            maxErr = Math.max(maxErr, Math.abs(err));
            correct++;
            seen.add(tr.bar);
        } else {
            wrong++;
        }
    }

    const missed = times.length - correct;
    const speedOk = Math.abs(minSpeed - bounds.speed) < 1e-6 &&
                    Math.abs(maxSpeed - bounds.speed) < 1e-6;
    const ok = generated.misses === 0 && correct === times.length && wrong === 0 && early === 0 && late === 0 &&
        generated.vertical > 0 && generated.horizontal > 0 &&
        outOfField === 0 && overlaps === 0 && clipping === 0 && outOfFieldBall === 0 && speedOk;
    if (!ok) failed++;

    console.log(
        `${ok ? 'PASS' : 'FAIL'}  [${song}] ${MUSIC[song].header.name.padEnd(32)} ` +
        `notes=${String(times.length).padStart(3)} bars=${String(B).padStart(3)} ` +
        `hits=${String(correct).padStart(3)} missed=${missed} wrong=${wrong} ` +
        `early=${early} late=${late} maxErr=${maxErr.toFixed(1)}ms V=${generated.vertical} H=${generated.horizontal} ` +
        `speed=${minSpeed.toFixed(2)}..${maxSpeed.toFixed(2)} ` +
        `overlaps=${overlaps} clip=${clipping} minClear=${minClear.toFixed(1)} ` +
        `outField=${outOfField + outOfFieldBall} field=${Math.round(field.max_x - field.min_x)}x${Math.round(field.max_y - field.min_y)}`
    );
}

// --- 1 s acceleration intro ------------------------------------------------
{
    const intro_times = buildTrack(MUSIC[0]).slice(0, 24);
    API.set_intro_enabled(true);
    API.reset_tracks();
    for (const t of intro_times) API.add_time_of_hit(0, t);
    API.init_generator();
    const info = API.get_intro();
    API.begin_song();
    const start_x = API.get_marble_x(0);
    const start_y = API.get_marble_y(0);
    let first = null;
    let last = -1;
    for (let i = 0; i < 200; i++) {
        API.update_main_world();
        const hit = API.get_marble_collision(0);
        if (hit !== -1 && hit !== last) {
            if (!first) first = {bar: hit, time: API.get_last_hit_time()};
            last = hit;
        }
        if (first && API.get_time() > intro_times[0] + 100) break;
    }
    const expect = 200 / Math.SQRT2;
    const intro_ok = info.enabled === true &&
        Math.abs(info.distance - 200) < 1e-9 &&
        Math.abs(start_x - expect) < 1e-6 &&
        Math.abs(start_y - expect) < 1e-6 &&
        first && first.bar === 0 && Math.abs(first.time - intro_times[0]) <= TICK;
    if (!intro_ok) failed++;
    console.log(
        `${intro_ok ? 'PASS' : 'FAIL'}  intro  distance=${info.distance} ` +
        `start=${start_x.toFixed(2)},${start_y.toFixed(2)} ` +
        `firstHit=${first ? first.time : 'none'}ms expected=${intro_times[0]}ms`
    );
    API.set_intro_enabled(false);
    API.reset_playback();
}

if (failed) {
    console.error(`\n${failed} track(s) failed`);
    process.exit(1);
}
console.log('\nall tracks passed');
