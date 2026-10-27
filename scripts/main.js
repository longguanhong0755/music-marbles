/* MIT License
 * Copyright (c) 2020 Andrii Borziak
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ---------------------------------------------------------------------------
// Axis-aligned bars in a compact folded cluster. Bars are permanent: they are
// white from the start, and take a light pitch-mapped colour when struck that
// they keep for the rest of the song. Every bar is solid all the time; the
// engine folds the marble's path so it never passes through a bar and never
// re-hits one.
// ---------------------------------------------------------------------------
const PAD_THICKNESS = 8;
// Notes closer than this are grouped into one chord/bar, so the bar can have
// both a sane visual size and a unique hit.
const MERGE_WINDOW_MS = 80;

function note_hue(names) {
    if (!names || !names.length) return 200;
    const match = /^([A-Ga-g])(#|b)?/.exec(names[0]);
    if (!match) return 200;
    const base = {C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11}[match[1].toUpperCase()];
    let pc = base + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0);
    pc = ((pc % 12) + 12) % 12;
    return pc * 30 + 4;
}

function round_rect(ctx, x, y, w, h, r) {
    r = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

class Plank {
    constructor(data) {
        this.a = data.a;
        this.b = data.b;
        this.note = data.note;
        this.hit_time = data.hit;
        this.visual_len = 28;

        this.center_x = (this.a[0] + this.b[0]) * 0.5;
        this.center_y = (this.a[1] + this.b[1]) * 0.5;
        this.vertical = data.vertical !== undefined
            ? data.vertical
            : Math.abs(this.a[0] - this.b[0]) < 0.001;

        const entry = track[this.note];
        this.hue = note_hue(entry && entry.note_names);
        // White until struck; this is the colour used while the hit fades.
        this.color = `hsl(${this.hue} 64% 77%)`;
        this.glow = `hsl(${this.hue} 82% 80%)`;
    }

    flash(note_index, at) {
        const entry = track[note_index];
        this.hit_time = at;
        this.hue = note_hue(entry && entry.note_names);
        this.color = `hsl(${this.hue} 64% 77%)`;
        this.glow = `hsl(${this.hue} 82% 80%)`;
    }

    update() {}

    draw(now) {
        const sx = this.center_x + offset[0];
        const sy = this.center_y + offset[1];
        if (sx < -90 || sx > canvas.width + 90 || sy < -90 || sy > canvas.height + 90) return;

        // -Infinity marks a bar that has not been struck yet. Once hit, the
        // bar keeps its colour for the rest of the song (no fade back to white).
        const struck = Number.isFinite(this.hit_time);
        const age = struck ? now - this.hit_time : Infinity;
        const color_strength = struck ? 1 : 0;
        const flash = struck && age >= 0 && age < 180 ? 1 - age / 180 : 0;

        const len = this.visual_len;
        const thick = PAD_THICKNESS;
        const path = () => {
            if (this.vertical) {
                round_rect(ctx, sx - thick / 2, sy - len / 2, thick, len, thick / 2);
            } else {
                round_rect(ctx, sx - len / 2, sy - thick / 2, len, thick, thick / 2);
            }
        };

        ctx.save();

        // the bar itself is white, and stays in the world for the whole song
        ctx.globalAlpha = 0.78 + 0.08 * color_strength;
        ctx.fillStyle = '#ffffff';
        path();
        ctx.fill();

        // struck: light pitch colour, kept for the rest of the song
        if (color_strength > 0.004) {
            ctx.globalAlpha = Math.min(1, 0.97 * color_strength + 0.22 * flash);
            ctx.fillStyle = this.color;
            ctx.shadowColor = this.glow;
            ctx.shadowBlur = 10 + 20 * color_strength;
            path();
            ctx.fill();
        }

        ctx.restore();
    }
}

// ---------------------------------------------------------------------------
class Marble {
    constructor(position) {
        this.position = position;
        this.trace = [];
        this.collision = -1;
    }

    synchronize(position, collision) {
        this.trace.push(position);
        const max_trace = 110;
        while (this.trace.length > max_trace) this.trace.shift();
        this.position = position;
        this.collision = collision;
    }

    draw() {
        const trace_len = this.trace.length;
        const n = trace_len;

        // faint ribbon through the trail
        if (n > 1) {
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.strokeStyle = 'rgba(255,238,190,0.28)';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            for (let j = 0; j < n; j++) {
                const p = this.trace[j];
                if (j === 0) ctx.moveTo(p[0] + offset[0], p[1] + offset[1]);
                else ctx.lineTo(p[0] + offset[0], p[1] + offset[1]);
            }
            ctx.stroke();
            ctx.restore();
        }

        // dotted trail, small and bright near the marble
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let j = 0; j < n; j++) {
            const p = this.trace[n - j - 1];
            const k = 1 - j / n;
            const radius = 0.9 + 2.6 * k * k;
            ctx.globalAlpha = 0.06 + 0.48 * k * k;
            ctx.fillStyle = j < 18 ? '#fffbe6' : '#ffe9a8';
            ctx.beginPath();
            ctx.arc(p[0] + offset[0], p[1] + offset[1], radius, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();

        // the marble itself
        ctx.save();
        ctx.shadowColor = '#fff2b0';
        ctx.shadowBlur = 18;
        ctx.drawImage(
            MARBLE_IMAGE,
            this.position[0] - MARBLE_IMAGE_SIZE / 2 + offset[0],
            this.position[1] - MARBLE_IMAGE_SIZE / 2 + offset[1],
            MARBLE_IMAGE_SIZE,
            MARBLE_IMAGE_SIZE
        );
        ctx.restore();
    }
}

// ---------------------------------------------------------------------------
class Particle {
    constructor(position, velocity, time, color) {
        this.position = position;
        this.velocity = velocity;
        this.time_left = time;
        this.time_total = time;
        this.color = color || '#fff7c8';
    }

    update() {
        this.time_left -= MS_PER_TICK;
        this.position[0] += this.velocity[0];
        this.position[1] += this.velocity[1];
        this.velocity[1] += 0.16;
        this.velocity[0] *= 0.985;
        this.velocity[1] *= 0.985;
    }

    draw() {
        const a = Math.max(0, Math.sqrt(this.time_left / this.time_total));
        const r = 1.5 + 3.5 * (1 - this.time_left / this.time_total);
        ctx.save();
        ctx.globalAlpha = a * 0.9;
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = this.color;
        ctx.shadowColor = this.color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(this.position[0] + offset[0], this.position[1] + offset[1], r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

// ---------------------------------------------------------------------------
let track = [];
let planks = [];
let marbles = [];
let particles = [];
let ready = false;
let planks_loaded = false;
let main_loop_running = false;
let current_song = 0;

function load_track(midi_json) {
    API.reset_tracks();

    let track_id = 0;

    midi_json['tracks'].forEach(track => {
        track['notes'].sort((a, b) => a.time - b.time);
    });

    midi_json['tracks'].forEach((track, idx) => {
        if (track.notes.length > midi_json['tracks'][track_id].notes.length) {
            track_id = idx;
        }
    });

    let multiplier = midi_json['header']['multiplier'] || 1.0;
    let time_offset = 0.5 - midi_json['tracks'][track_id].notes[0].time * multiplier;
    let unmerged = midi_json['tracks'][track_id].notes.map(sound => {
        return {
            note_names: [sound.name],
            time: sound.time * multiplier + time_offset,
            duration: sound.duration * multiplier
        };
    });

    track = [];
    for (let i = 0; i < unmerged.length; i++) {
        if (i > 0 && unmerged[i - 1].time + 4 < unmerged[i].time) break;
        const note = unmerged[i];
        const note_ms = Math.round(note.time * 1000);
        const last = track[track.length - 1];
        if (last && note_ms - Math.round(last.time * 1000) < MERGE_WINDOW_MS) {
            // near-simultaneous notes share one bar/chord
            last.note_names.push(note.note_names[0]);
            last.duration = Math.max(last.duration, note.duration);
        } else {
            API.add_time_of_hit(0, note_ms);
            track.push(note);
        }
    }
}

function synchronize_planks() {
    if (planks_loaded) return;
    planks = API.get_planks().map((p) => new Plank(p));
    if (ready) {
        planks_loaded = true;
    }
}

function synchronize_marble() {
    const positions = API.get_marbles();
    const collisions = API.get_marble_collisions();
    for (let i = 0; i < positions.length; i++) {
        if (marbles[i]) {
            marbles[i].synchronize(positions[i], collisions[i]);
        } else {
            marbles[i] = new Marble(positions[i]);
        }
    }
}

function update_camera() {
    if (!marbles[0]) return;
    const p = marbles[0].position;

    // dead-zone camera: keep the marble inside a central window so the
    // zigzag is visible on screen instead of being pinned to one pixel
    const anchor_x = canvas.width * 0.5;
    const anchor_y = canvas.height * 0.42;
    const dead_x = canvas.width * 0.20;
    const dead_y = canvas.height * 0.15;

    const sx = p[0] + offset[0];
    const sy = p[1] + offset[1];

    let dx = 0, dy = 0;
    if (sx < anchor_x - dead_x) dx = (anchor_x - dead_x) - sx;
    else if (sx > anchor_x + dead_x) dx = (anchor_x + dead_x) - sx;
    if (sy < anchor_y - dead_y) dy = (anchor_y - dead_y) - sy;
    else if (sy > anchor_y + dead_y) dy = (anchor_y + dead_y) - sy;

    offset[0] += dx * 0.14;
    offset[1] += dy * 0.14;
}

function update_particles() {
    particles.forEach(p => p.update());
    particles = particles.filter(p => p.time_left > 0);
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    draw_stars();

    planks.forEach(p => p.draw(API.get_time()));

    marbles.forEach(m => m.draw());

    particles.forEach(p => p.draw());
}

function generate_particle(center, plank_index) {
    const plank = planks[plank_index];
    const color = plank ? plank.color : '#fff7c8';
    for (let j = 0; j < 8; j++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 3 + 0.6;
        const life = 240 + Math.random() * 380;
        particles.push(new Particle(
            [center[0] + (Math.random() - 0.5) * 6, center[1] + (Math.random() - 0.5) * 6],
            [Math.cos(angle) * speed, Math.sin(angle) * speed - 0.8],
            life,
            color
        ));
    }
}

function play_sounds() {
    for (let i = 0; i < marbles.length; i++) {
        const plank_index = marbles[i].collision;
        if (plank_index === -1) continue;

        const plank = planks[plank_index];
        const entry = track[plank_index];
        if (!plank || !entry) continue;

        plank.flash(plank_index, API.get_last_hit_time());
        PIANO.triggerAttackRelease(entry.note_names, entry.duration);
        generate_particle([plank.center_x, plank.center_y], plank_index);
    }
}

function resize_canvas() {
    const old_w = canvas.width || window.innerWidth;
    const old_h = canvas.height || window.innerHeight;
    let rx = 0.5, ry = 0.55;
    if (marbles[0]) {
        rx = (marbles[0].position[0] + offset[0]) / old_w;
        ry = (marbles[0].position[1] + offset[1]) / old_h;
    }

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    if (marbles[0]) {
        offset[0] = canvas.width * rx - marbles[0].position[0];
        offset[1] = canvas.height * ry - marbles[0].position[1];
    } else {
        offset[0] = canvas.width * 0.5 - API.get_marble_x(0);
        offset[1] = canvas.height * 0.55 - API.get_marble_y(0);
    }
    init_stars();
}

// ---------------------------------------------------------------------------
// background starfield
let stars = [];
function init_stars() {
    stars = [];
    const count = Math.min(320, Math.round(canvas.width * canvas.height / 7000));
    for (let i = 0; i < count; i++) {
        stars.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            r: Math.random() * 1.4 + 0.25,
            a: Math.random() * 0.45 + 0.08,
            p: 0.04 + Math.random() * 0.16
        });
    }
}

function draw_stars() {
    ctx.save();
    for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        let x = (s.x + offset[0] * s.p) % canvas.width;
        let y = (s.y + offset[1] * s.p) % canvas.height;
        if (x < 0) x += canvas.width;
        if (y < 0) y += canvas.height;
        ctx.globalAlpha = s.a;
        ctx.fillStyle = '#cfe3ff';
        ctx.beginPath();
        ctx.arc(x, y, s.r, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

// ---------------------------------------------------------------------------
let last_ts = 0;
let accumulator = 0;
function main_loop(ts) {
    if (!last_ts) last_ts = ts;
    let elapsed = Math.min(300, ts - last_ts);
    last_ts = ts;

    if (!ready) {
        API.generate_world_limited();
        const progress = API.get_generator_progress();
        document.getElementById('progress-bar').style.width = `${progress}%`;
        document.getElementById('progress-bar-text').textContent = `${progress}%`;
        synchronize_planks();
        if (!marbles.length) marbles.push(new Marble([API.get_marble_x(0), API.get_marble_y(0)]));
        update_camera();
        draw();
        if (progress >= 100) {
            ready = true;
            if (Tone.context && Tone.context.state !== 'running') Tone.context.resume();
        }
    } else {
        accumulator += elapsed;
        let steps = 0;
        while (accumulator >= MS_PER_TICK && steps < 20) {
            API.update_main_world();
            synchronize_marble();
            play_sounds();
            update_camera();
            update_particles();
            accumulator -= MS_PER_TICK;
            steps++;
        }
        // if a frame was extremely slow, don't try to replay all of it
        if (accumulator > MS_PER_TICK * 4) accumulator = MS_PER_TICK * 4;
        synchronize_planks();
        draw();
    }

    requestAnimationFrame(main_loop);
}

function run_all() {
    ready = false;
    planks_loaded = false;
    planks = [];
    marbles = [];
    particles = [];
    accumulator = 0;
    last_ts = 0;
    API.set_max_y(+canvas.height / 2 - 40);
    API.set_min_y(-canvas.height / 2 + 40);
    API.init_generator();
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('progress-bar-text').textContent = '0%';
    offset[0] = canvas.width * 0.5 - API.get_marble_x(0);
    offset[1] = canvas.height * 0.55 - API.get_marble_y(0);
    if (!main_loop_running) {
        main_loop_running = true;
        requestAnimationFrame(main_loop);
    }
}

window.addEventListener('load', () => {
    resize_canvas();

    const list = document.getElementById('music-list');
    music.forEach((m, i) => {
        const element = document.createElement('div');
        element.classList.add('music');
        element.innerText = m['header']['name'];
        element.onclick = () => {
            if (Tone.context && Tone.context.state !== 'running') Tone.context.resume();
            const ch = list.children;
            for (let j = 0; j < ch.length; j++) {
                ch[j].classList.remove('active');
            }
            element.classList.add('active');
            current_song = i;
            last_ts = 0;
            load_track(music[i]);
            run_all();
        };
        list.append(element);
    });
});

window.addEventListener('resize', resize_canvas);
