/* Music Marbles — shared scene renderer.
 *
 * Everything here draws into an explicit View instead of the old globals, so
 * the same scene can be rendered to the page canvas or to an export canvas at
 * an arbitrary aspect ratio.
 */
(function (global) {
    'use strict';

    const PAD_THICKNESS = 8;
    const MARBLE_IMAGE_SIZE = 44;
    const PARTICLE_IMAGE_SIZE = 16;
    const TRACE_SIZE = 110;

    const images = {
        marble: new Image(),
        particle: new Image()
    };
    images.marble.src = new URL('images/marble.png', document.baseURI).href;
    images.particle.src = new URL('images/particle.png', document.baseURI).href;

    function load_images() {
        const wait = (img) => new Promise((resolve) => {
            if (img.complete) return resolve();
            img.addEventListener('load', resolve, {once: true});
            img.addEventListener('error', resolve, {once: true});
        });
        return Promise.all([wait(images.marble), wait(images.particle)]).then(() => images);
    }

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

    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a |= 0;
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    class View {
        constructor(canvas, width, height, dpr) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.dpr = dpr || 1;
            this.width = width;
            this.height = height;
            this.canvas.width = Math.max(1, Math.round(width * this.dpr));
            this.canvas.height = Math.max(1, Math.round(height * this.dpr));
            this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
            this.ctx.imageSmoothingEnabled = true;
            this.scale = 1;
            this.offset = [width * 0.5, height * 0.42];
            this.stars = [];
            this.seed = 1;
        }

        set_scale(scale) {
            this.scale = scale;
        }

        screen(x, y) {
            return [x * this.scale + this.offset[0], y * this.scale + this.offset[1]];
        }
    }

    function fit_scale(width, height, target) {
        const short = Math.min(width, height);
        return Math.max(0.5, Math.min(1.6, short / (target || 820)));
    }

    function init_stars(view, seed) {
        view.seed = seed >>> 0;
        const rand = mulberry32(view.seed || 1);
        const count = Math.min(360, Math.max(80, Math.round(view.width * view.height / 7000)));
        view.stars = [];
        for (let i = 0; i < count; i++) {
            view.stars.push({
                x: rand() * view.width,
                y: rand() * view.height,
                r: rand() * 1.4 + 0.25,
                a: rand() * 0.45 + 0.08,
                p: 0.04 + rand() * 0.16
            });
        }
    }

    function draw_stars(view) {
        const ctx = view.ctx;
        ctx.save();
        for (let i = 0; i < view.stars.length; i++) {
            const s = view.stars[i];
            let x = (s.x + view.offset[0] * s.p) % view.width;
            let y = (s.y + view.offset[1] * s.p) % view.height;
            if (x < 0) x += view.width;
            if (y < 0) y += view.height;
            ctx.globalAlpha = s.a;
            ctx.fillStyle = '#cfe3ff';
            ctx.beginPath();
            ctx.arc(x, y, s.r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function draw_background(view) {
        const ctx = view.ctx;
        const w = view.width, h = view.height;
        const g = ctx.createRadialGradient(w * 0.5, h * 0.38, 0, w * 0.5, h * 0.38, Math.max(w, h) * 0.72);
        g.addColorStop(0, '#101a30');
        g.addColorStop(0.52, '#080d18');
        g.addColorStop(1, '#03050b');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        draw_stars(view);

        // a soft vignette keeps the edges from competing with the run
        const v = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.25, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
        v.addColorStop(0, 'rgba(0,0,0,0)');
        v.addColorStop(1, 'rgba(0,0,0,0.38)');
        ctx.fillStyle = v;
        ctx.fillRect(0, 0, w, h);
    }

    class Plank {
        constructor(data, track) {
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
            this.color = `hsl(${this.hue} 64% 77%)`;
            this.glow = `hsl(${this.hue} 82% 80%)`;
        }

        flash(note_index, at, track) {
            const entry = track[note_index];
            this.hit_time = at;
            this.hue = note_hue(entry && entry.note_names);
            this.color = `hsl(${this.hue} 64% 77%)`;
            this.glow = `hsl(${this.hue} 82% 80%)`;
        }

        draw(view, now) {
            const ctx = view.ctx;
            const [sx, sy] = view.screen(this.center_x, this.center_y);
            const pad = 90 * view.scale;
            if (sx < -pad || sx > view.width + pad || sy < -pad || sy > view.height + pad) return;

            const struck = Number.isFinite(this.hit_time);
            const age = struck ? now - this.hit_time : Infinity;
            const flash = struck && age >= 0 && age < 180 ? 1 - age / 180 : 0;

            const len = this.visual_len * view.scale;
            const thick = PAD_THICKNESS * view.scale;
            const radius = thick * 0.5;
            const path = () => {
                if (this.vertical) {
                    round_rect(ctx, sx - thick / 2, sy - len / 2, thick, len, radius);
                } else {
                    round_rect(ctx, sx - len / 2, sy - thick / 2, len, thick, radius);
                }
            };

            ctx.save();
            ctx.globalAlpha = struck ? 0.88 : 0.78;
            ctx.fillStyle = '#ffffff';
            path();
            ctx.fill();

            if (struck) {
                ctx.globalAlpha = Math.min(1, 0.97 + 0.22 * flash);
                ctx.fillStyle = this.color;
                ctx.shadowColor = this.glow;
                ctx.shadowBlur = (10 + 20) * view.scale;
                path();
                ctx.fill();
            }
            ctx.restore();
        }
    }

    class Marble {
        constructor(position) {
            this.position = position ? position.slice() : [0, 0];
            this.trace = [this.position.slice()];
            this.collision = -1;
        }

        synchronize(position, collision) {
            if (!position) return;
            const last = this.trace[this.trace.length - 1];
            if (!last || Math.hypot(position[0] - last[0], position[1] - last[1]) > 0.25) {
                this.trace.push([position[0], position[1]]);
                while (this.trace.length > TRACE_SIZE) this.trace.shift();
            }
            this.position = [position[0], position[1]];
            this.collision = collision;
        }

        draw(view) {
            const ctx = view.ctx;
            const scale = view.scale;
            const n = this.trace.length;

            if (n > 1) {
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                ctx.strokeStyle = 'rgba(255,238,190,0.28)';
                ctx.lineWidth = Math.max(0.8, 1.4 * scale);
                ctx.beginPath();
                for (let j = 0; j < n; j++) {
                    const p = view.screen(this.trace[j][0], this.trace[j][1]);
                    if (j === 0) ctx.moveTo(p[0], p[1]);
                    else ctx.lineTo(p[0], p[1]);
                }
                ctx.stroke();
                ctx.restore();
            }

            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            for (let j = 0; j < n; j++) {
                const p = view.screen(this.trace[n - j - 1][0], this.trace[n - j - 1][1]);
                const k = 1 - j / n;
                const radius = (0.9 + 2.6 * k * k) * scale;
                ctx.globalAlpha = 0.06 + 0.48 * k * k;
                ctx.fillStyle = j < 18 ? '#fffbe6' : '#ffe9a8';
                ctx.beginPath();
                ctx.arc(p[0], p[1], radius, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();

            ctx.save();
            ctx.shadowColor = '#fff2b0';
            ctx.shadowBlur = 18 * scale;
            const size = MARBLE_IMAGE_SIZE * scale;
            const p = view.screen(this.position[0], this.position[1]);
            ctx.drawImage(images.marble, p[0] - size / 2, p[1] - size / 2, size, size);
            ctx.restore();
        }
    }

    class Particle {
        constructor(position, velocity, time, color) {
            this.position = position;
            this.velocity = velocity;
            this.time_left = time;
            this.time_total = time;
            this.color = color || '#fff7c8';
        }

        update() {
            this.time_left -= 15;
            this.position[0] += this.velocity[0];
            this.position[1] += this.velocity[1];
            this.velocity[1] += 0.16;
            this.velocity[0] *= 0.985;
            this.velocity[1] *= 0.985;
        }

        draw(view) {
            const ctx = view.ctx;
            const a = Math.max(0, Math.sqrt(this.time_left / this.time_total));
            const r = (1.5 + 3.5 * (1 - this.time_left / this.time_total)) * view.scale;
            const p = view.screen(this.position[0], this.position[1]);
            ctx.save();
            ctx.globalAlpha = a * 0.9;
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = this.color;
            ctx.shadowColor = this.color;
            ctx.shadowBlur = 10 * view.scale;
            ctx.beginPath();
            ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }

    class Scene {
        constructor(track, view, seed) {
            this.track = track;
            this.view = view;
            this.rand = mulberry32(seed || 1);
            this.planks = API.get_planks().map((p) => new Plank(p, track));
            this.marble = new Marble([API.get_marble_x(0), API.get_marble_y(0)]);
            this.particles = [];
            this.time = 0;
            init_stars(view, seed || 1);
            this.reset_camera();
        }

        reset_camera() {
            const p = this.marble.position;
            this.view.offset[0] = this.view.width * 0.5 - p[0] * this.view.scale;
            this.view.offset[1] = this.view.height * 0.42 - p[1] * this.view.scale;
        }

        reset() {
            API.reset_playback();
            this.planks = API.get_planks().map((p) => new Plank(p, this.track));
            this.marble = new Marble([API.get_marble_x(0), API.get_marble_y(0)]);
            this.particles = [];
            this.time = 0;
            init_stars(this.view, this.view.seed || 1);
            this.reset_camera();
        }

        set_intro_progress(t, intro) {
            const s = Math.min(intro.distance, 0.5 * intro.accel * t * t);
            const x = s / Math.SQRT2;
            const y = s / Math.SQRT2;
            this.marble.synchronize([x, y], -1);
            this.time = t * 1000;
            update_camera(this.view, this.marble.position);
        }

        synchronize_marble() {
            const positions = API.get_marbles();
            const collisions = API.get_marble_collisions();
            if (positions.length) this.marble.synchronize(positions[0], collisions[0]);
            this.time = API.get_time();
        }

        process_hits() {
            const index = API.get_marble_collision(0);
            if (index === undefined || index < 0) return false;
            const plank = this.planks[index];
            if (!plank) return false;
            plank.flash(index, API.get_last_hit_time(), this.track);
            this.spawn_particles(plank.center_x, plank.center_y, plank.color);
            return true;
        }

        spawn_particles(x, y, color) {
            for (let j = 0; j < 8; j++) {
                const angle = this.rand() * Math.PI * 2;
                const speed = this.rand() * 3 + 0.6;
                const life = 240 + this.rand() * 380;
                this.particles.push(new Particle(
                    [x + (this.rand() - 0.5) * 6, y + (this.rand() - 0.5) * 6],
                    [Math.cos(angle) * speed, Math.sin(angle) * speed - 0.8],
                    life,
                    color
                ));
            }
        }

        update_particles() {
            this.particles.forEach((p) => p.update());
            this.particles = this.particles.filter((p) => p.time_left > 0);
        }

        draw() {
            const view = this.view;
            draw_background(view);
            for (let i = 0; i < this.planks.length; i++) this.planks[i].draw(view, this.time);
            this.marble.draw(view);
            for (let i = 0; i < this.particles.length; i++) this.particles[i].draw(view);
        }
    }

    function update_camera(view, position, immediate) {
        if (!position) return;
        const anchor_x = view.width * 0.5;
        const anchor_y = view.height * 0.42;
        const dead_x = view.width * 0.20;
        const dead_y = view.height * 0.15;

        const sx = position[0] * view.scale + view.offset[0];
        const sy = position[1] * view.scale + view.offset[1];

        let dx = 0, dy = 0;
        if (sx < anchor_x - dead_x) dx = (anchor_x - dead_x) - sx;
        else if (sx > anchor_x + dead_x) dx = (anchor_x + dead_x) - sx;
        if (sy < anchor_y - dead_y) dy = (anchor_y - dead_y) - sy;
        else if (sy > anchor_y + dead_y) dy = (anchor_y + dead_y) - sy;

        if (immediate) {
            view.offset[0] += dx;
            view.offset[1] += dy;
        } else {
            view.offset[0] += dx * 0.14;
            view.offset[1] += dy * 0.14;
        }
    }

    global.SceneKit = {
        PAD_THICKNESS,
        MARBLE_IMAGE_SIZE,
        PARTICLE_IMAGE_SIZE,
        View,
        Scene,
        Plank,
        Marble,
        Particle,
        load_images,
        note_hue,
        fit_scale,
        init_stars,
        draw_background,
        update_camera,
        mulberry32
    };
})(window);
