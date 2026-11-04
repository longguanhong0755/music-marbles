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
    const TRACE_SIZE = 110;
    const BACKGROUND_DARK = 'dark';
    const BACKGROUND_LIGHT = 'light';

    function normalize_background(value) {
        const key = String(value == null ? '' : value).trim().toLowerCase();
        return key === BACKGROUND_LIGHT || key === 'white'
            ? BACKGROUND_LIGHT
            : BACKGROUND_DARK;
    }

    const images = {
        marble: new Image()
    };
    images.marble.src = new URL('images/marble.png', document.baseURI).href;

    function load_images() {
        const wait = (img) => new Promise((resolve) => {
            if (img.complete) return resolve();
            img.addEventListener('load', resolve, {once: true});
            img.addEventListener('error', resolve, {once: true});
        });
        return Promise.all([wait(images.marble)]).then(() => images);
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

    function make_canvas(width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width));
        canvas.height = Math.max(1, Math.round(height));
        return canvas;
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
            this.plank_cache = null;
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

    // Bounds of everything the camera can see: the generated run, the intro
    // origin (0, 0), and the thickness of the wall-mounted bars. The engine
    // alone does not expose the bar extents, so a small margin stands in for
    // the plank half-length plus the marble radius.
    function track_bounds() {
        if (!global.API) return null;
        const path = global.API.get_path ? global.API.get_path() : [];
        if (!path || !path.length) return null;
        let min_x = Infinity, max_x = -Infinity;
        let min_y = Infinity, max_y = -Infinity;
        const add = (x, y) => {
            if (x < min_x) min_x = x;
            if (x > max_x) max_x = x;
            if (y < min_y) min_y = y;
            if (y > max_y) max_y = y;
        };
        for (let i = 0; i < path.length; i++) add(path[i].x, path[i].y);
        add(0, 0);
        const margin = 48;
        return {
            min_x: min_x - margin,
            max_x: max_x + margin,
            min_y: min_y - margin,
            max_y: max_y + margin,
            width: max_x - min_x + margin * 2,
            height: max_y - min_y + margin * 2
        };
    }

    // fit_scale() is tuned for the watch page and never zooms in past 1.6.
    // Short tracks (three or four notes) leave most of an export frame black
    // at that scale, so exports may upscale until the whole run fits.
    function fit_scale_for_track(width, height, target, max_scale) {
        const base = fit_scale(width, height, target);
        const bounds = track_bounds();
        if (!bounds || bounds.width < 1 || bounds.height < 1) return base;
        const pad = Math.min(width, height) * 0.08;
        const fit = Math.min(
            Math.max(1, width - pad * 2) / bounds.width,
            Math.max(1, height - pad * 2) / bounds.height
        );
        return Math.max(base, Math.min(fit, max_scale || 2.2));
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

    function draw_background(view, wall_field, background) {
        const ctx = view.ctx;
        const w = view.width;
        const h = view.height;
        const theme = normalize_background(background);

        // The light theme is intentionally a flat pure-white field: no stars,
        // no vignette, no gradient. Walls still use the same black room mask.
        if (theme === BACKGROUND_LIGHT) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            if (wall_field) wall_field.draw(view);
            return;
        }

        const g = ctx.createRadialGradient(w * 0.5, h * 0.38, 0, w * 0.5, h * 0.38, Math.max(w, h) * 0.72);
        g.addColorStop(0, '#101a30');
        g.addColorStop(0.52, '#080d18');
        g.addColorStop(1, '#03050b');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        draw_stars(view);

        // Walls sit over the stars but under the vignette so the whole field
        // still feels like one dark room.
        if (wall_field) wall_field.draw(view);

        const v = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.25, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
        v.addColorStop(0, 'rgba(0,0,0,0)');
        v.addColorStop(1, 'rgba(0,0,0,0.38)');
        ctx.fillStyle = v;
        ctx.fillRect(0, 0, w, h);
    }

    const PLANK_VISUAL_LEN = 28;

    function get_plank_sprites(view, background) {
        const theme = normalize_background(background);
        const key = `${Number(view.scale).toFixed(6)}:${theme}`;
        if (view.plank_cache && view.plank_cache.key === key) return view.plank_cache;

        const scale = view.scale;
        const thick = PAD_THICKNESS * scale;
        const len = PLANK_VISUAL_LEN * scale;
        const radius = thick * 0.5;
        // The glow used to force a 30 px shadow into every sprite. Sprites only
        // need the bar itself now, so the padding stays small.
        const pad = Math.ceil(4 * scale + 2);
        const vw = Math.ceil(thick + pad * 2);
        const vh = Math.ceil(len + pad * 2);
        const hw = vh;
        const hh = vw;
        const base_color = theme === BACKGROUND_LIGHT ? '#e8e9ec' : '#ffffff';
        const hit_lightness = theme === BACKGROUND_LIGHT ? 46 : 72;

        function base_sprite(vertical) {
            const w = vertical ? vw : hw;
            const h = vertical ? vh : hh;
            const canvas = make_canvas(w, h);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = base_color;
            if (vertical) round_rect(ctx, pad, pad, thick, len, radius);
            else round_rect(ctx, pad, pad, len, thick, radius);
            ctx.fill();
            // On a white background the idle bar needs a dark hairline or it
            // disappears into the room. The same bar stays visible when it is
            // mounted on a black wall.
            if (theme === BACKGROUND_LIGHT) {
                ctx.lineWidth = Math.max(1, 1.2 * scale);
                ctx.strokeStyle = '#171a21';
                ctx.stroke();
            }
            return canvas;
        }

        const cache = {
            key,
            theme,
            vw, vh, hw, hh,
            base_v: base_sprite(true),
            base_h: base_sprite(false),
            struck: new Map(),
            struck_for(vertical, hue) {
                const k = `${vertical ? 'v' : 'h'}:${hue}`;
                let canvas = this.struck.get(k);
                if (canvas) return canvas;
                const w = vertical ? vw : hw;
                const h = vertical ? vh : hh;
                canvas = make_canvas(w, h);
                const ctx = canvas.getContext('2d');
                // A clean, flat color fill. No white underlay, no flash, no
                // shadow: the collision itself is the only change.
                ctx.fillStyle = `hsl(${hue} 62% ${hit_lightness}%)`;
                if (vertical) round_rect(ctx, pad, pad, thick, len, radius);
                else round_rect(ctx, pad, pad, len, thick, radius);
                ctx.fill();
                this.struck.set(k, canvas);
                return canvas;
            }
        };
        view.plank_cache = cache;
        return cache;
    }

    class Plank {
        constructor(data, track) {
            this.a = data.a;
            this.b = data.b;
            this.note = data.note;
            this.hit_time = data.hit;
            this.visual_len = PLANK_VISUAL_LEN;
            this.center_x = (this.a[0] + this.b[0]) * 0.5;
            this.center_y = (this.a[1] + this.b[1]) * 0.5;
            this.vertical = data.vertical !== undefined
                ? data.vertical
                : Math.abs(this.a[0] - this.b[0]) < 0.001;

            const entry = track[this.note];
            this.hue = note_hue(entry && entry.note_names);
            this.color = `hsl(${this.hue} 62% 72%)`;
        }

        flash(note_index, at, track) {
            const entry = track[note_index];
            this.hit_time = at;
            this.hue = note_hue(entry && entry.note_names);
            this.color = `hsl(${this.hue} 62% 72%)`;
        }

        draw(view, now, background) {
            const ctx = view.ctx;
            const [sx, sy] = view.screen(this.center_x, this.center_y);
            const pad = 90 * view.scale;
            if (sx < -pad || sx > view.width + pad || sy < -pad || sy > view.height + pad) return;

            const struck = Number.isFinite(this.hit_time);
            const sprites = get_plank_sprites(view, background);
            const w = this.vertical ? sprites.vw : sprites.hw;
            const h = this.vertical ? sprites.vh : sprites.hh;
            const x = sx - w * 0.5;
            const y = sy - h * 0.5;

            if (!struck) {
                ctx.globalAlpha = sprites.theme === BACKGROUND_LIGHT ? 1 : 0.78;
                ctx.drawImage(this.vertical ? sprites.base_v : sprites.base_h, x, y, w, h);
            } else {
                ctx.globalAlpha = 1;
                ctx.drawImage(sprites.struck_for(this.vertical, this.hue), x, y, w, h);
            }
            ctx.globalAlpha = 1;
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

        draw(view, background) {
            const ctx = view.ctx;
            const scale = view.scale;
            const n = this.trace.length;
            const theme = normalize_background(background);
            const light = theme === BACKGROUND_LIGHT;

            if (n > 1) {
                ctx.save();
                if (light) {
                    ctx.strokeStyle = 'rgba(24,27,34,0.16)';
                    ctx.lineWidth = Math.max(0.8, 1.4 * scale);
                } else {
                    ctx.globalCompositeOperation = 'lighter';
                    ctx.strokeStyle = 'rgba(255,238,190,0.28)';
                    ctx.lineWidth = Math.max(0.8, 1.4 * scale);
                }
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
            if (!light) ctx.globalCompositeOperation = 'lighter';
            for (let j = 0; j < n; j++) {
                const p = view.screen(this.trace[n - j - 1][0], this.trace[n - j - 1][1]);
                const k = 1 - j / n;
                const radius = (0.9 + 2.6 * k * k) * scale;
                ctx.globalAlpha = (light ? 0.05 : 0.06) + (light ? 0.20 : 0.48) * k * k;
                ctx.fillStyle = light ? '#1d2330' : (j < 18 ? '#fffbe6' : '#ffe9a8');
                ctx.beginPath();
                ctx.arc(p[0], p[1], radius, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();

            const size = MARBLE_IMAGE_SIZE * scale;
            const p = view.screen(this.position[0], this.position[1]);
            ctx.save();
            if (light) {
                // The marble asset is nearly white. A dark disc behind it keeps
                // it visible on a pure-white background.
                ctx.fillStyle = 'rgba(18,21,28,0.92)';
                ctx.beginPath();
                ctx.arc(p[0], p[1], size * 0.355, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.shadowColor = '#fff2b0';
                ctx.shadowBlur = 18 * scale;
            }
            ctx.drawImage(images.marble, p[0] - size / 2, p[1] - size / 2, size, size);
            ctx.restore();
        }
    }

    class Scene {
        constructor(track, view, seed, options) {
            this.track = track;
            this.view = view;
            this.planks = API.get_planks().map((p) => new Plank(p, track));
            this.marble = new Marble([API.get_marble_x(0), API.get_marble_y(0)]);
            this.time = 0;
            this.background = normalize_background(options && options.background);
            this.wall_field = null;
            this.walls_enabled = !options || options.walls !== false;
            this.wall_options = options && options.wall_options ? options.wall_options : null;
            this.rebuild_walls();
            init_stars(view, seed || 1);
            this.reset_camera();
        }

        rebuild_walls() {
            if (!this.walls_enabled || !global.WallKit) {
                this.wall_field = null;
                return;
            }
            this.wall_field = global.WallKit.build(
                API.get_path(),
                API.get_start(),
                this.wall_options || undefined,
                API.get_planks()
            );
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
            this.time = 0;
            init_stars(this.view, this.view.seed || 1);
            this.reset_camera();
        }

        set_intro_progress(t, intro) {
            const s = Math.min(intro.distance, 0.5 * intro.accel * t * t);
            const dx = Number.isFinite(intro.dir_x) ? intro.dir_x : 1;
            const dy = Number.isFinite(intro.dir_y) ? intro.dir_y : 1;
            const x = dx * s / Math.SQRT2;
            const y = dy * s / Math.SQRT2;
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
            // The hit only recolors the bar. No flash, glow, ring or burst.
            plank.flash(index, API.get_last_hit_time(), this.track);
            return true;
        }

        draw() {
            const view = this.view;
            const timings = this.draw_timings || (this.draw_timings = {
                background_ms: 0,
                planks_ms: 0,
                marble_ms: 0
            });
            let t0 = performance.now();
            draw_background(view, this.wall_field, this.background);
            timings.background_ms += performance.now() - t0;

            t0 = performance.now();
            for (let i = 0; i < this.planks.length; i++) {
                this.planks[i].draw(view, this.time, this.background);
            }
            timings.planks_ms += performance.now() - t0;

            t0 = performance.now();
            this.marble.draw(view, this.background);
            timings.marble_ms += performance.now() - t0;
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
        BACKGROUND_DARK,
        BACKGROUND_LIGHT,
        View,
        Scene,
        Plank,
        Marble,
        load_images,
        note_hue,
        fit_scale,
        fit_scale_for_track,
        track_bounds,
        init_stars,
        draw_background,
        update_camera,
        normalize_background,
        mulberry32
    };
})(window);
