/* Music Marbles — compact straight-line billiard engine (JS replacement for WASM)
 *
 * The original project fills a small world with planks around the marble. This
 * build does the same thing within the constraints of the fork:
 *
 *   - every bar is permanent, axis-aligned (mixed vertical/horizontal) and is
 *     struck exactly once;
 *   - the marble travels in straight lines at one constant speed for the whole
 *     song, and every bar is a specular reflection (one velocity component
 *     flips);
 *   - the bars are laid out along the marble's path, but the path is folded
 *     into a compact cluster instead of a long diagonal staircase. A
 *     depth-first search picks the left/right turn at every note so the path
 *     stays close to the start, never comes within a marble radius of a bar it
 *     is not hitting, and never puts two bars on top of each other;
 *   - the distance between consecutive bars is exactly speed * note-gap, so
 *     every note is hit on its timestamp without changing speed;
 *   - there are no walls. The playfield is the bounding box of the cluster,
 *     and the camera follows the marble.
 *
 * The 80 ms chord grouping lives in main.js and tools/verify_engine.js; this
 * module only sees the resulting note times.
 */
let API = (() => {
    'use strict';

    const MARBLE_RADIUS = 12;
    const PLANK_HALF_WIDTH = 4;          // visual thickness 8
    const STANDOFF = MARBLE_RADIUS + PLANK_HALF_WIDTH; // 16
    const PLANK_HALF_LEN = 14;           // visual length 28
    const BAR_GAP = 0.5;                 // minimum gap between two bar bodies

    const MS_PER_TICK = 15;
    const MAX_SUBSTEP = 1.5;             // world units per physics substep
    const MAX_SUBSTEP_MS = 2;            // and at most 2 ms per substep
    const SPEED = 400;                   // constant world units / second
    const FIELD_MARGIN = 200;
    const SEARCH_BUDGET = 200000;        // DFS nodes; the real layouts need ~2k

    // The player can prepend a silent 1-second acceleration. The marble starts
    // at rest at the origin, reaches SPEED after INTRO_MS, and has travelled
    // INTRO_DIST along the first (U+) segment by then. The engine itself starts
    // at that endpoint when the audio begins.
    const INTRO_MS = 1000;
    const INTRO_DIST = SPEED * (INTRO_MS / 1000) * 0.5;

    const DIRS = {
        U_PLUS: {sx: 1, sy: 1},
        U_MINUS: {sx: -1, sy: -1},
        V_PLUS: {sx: 1, sy: -1},
        V_MINUS: {sx: -1, sy: 1}
    };

    let note_times = [];
    let planks = [];
    let path = [];
    let field = {min_x: -100, max_x: 100, min_y: -100, max_y: 100};
    let start = {x: 0, y: 0, vx: 0, vy: 0};
    let play_state = null;
    let last_hit = -1;
    let intro_enabled = false;
    let stats = {
        notes: 0,
        planks: 0,
        misses: 0,
        wrong_hits: 0,
        vertical: 0,
        horizontal: 0,
        speed: SPEED
    };

    // ------------------------------------------------------------------ track
    function reset_tracks() {
        note_times = [];
    }

    function add_time_of_hit(track, time) {
        if (track === 0) note_times.push(time);
    }

    // ------------------------------------------------------------- geometry
    function dir_xy(axis, sign) {
        if (axis === 'u') return sign > 0 ? DIRS.U_PLUS : DIRS.U_MINUS;
        return sign > 0 ? DIRS.V_PLUS : DIRS.V_MINUS;
    }

    function seg_seg(ax, ay, bx, by, cx, cy, dx, dy) {
        const ux = bx - ax, uy = by - ay;
        const vx = dx - cx, vy = dy - cy;
        const wx = ax - cx, wy = ay - cy;
        const a = ux * ux + uy * uy;
        const b = ux * vx + uy * vy;
        const c = vx * vx + vy * vy;
        const d = ux * wx + uy * wy;
        const e = vx * wx + vy * wy;
        const D = a * c - b * b;
        let sc, tc;
        if (D < 1e-12) {
            sc = 0;
            tc = (b > c ? d / b : e / c);
        } else {
            sc = (b * e - c * d) / D;
            tc = (a * e - b * d) / D;
        }
        sc = Math.max(0, Math.min(1, sc));
        tc = Math.max(0, Math.min(1, tc));
        if (sc === 0) tc = Math.max(0, Math.min(1, e / c));
        else if (sc === 1) tc = Math.max(0, Math.min(1, (e + b) / c));
        if (tc === 0) sc = Math.max(0, Math.min(1, -d / a));
        else if (tc === 1) sc = Math.max(0, Math.min(1, (b - d) / a));
        const px = ax + ux * sc, py = ay + uy * sc;
        const qx = cx + vx * tc, qy = cy + vy * tc;
        return Math.hypot(px - qx, py - qy);
    }

    function point_seg(px, py, ax, ay, bx, by) {
        const abx = bx - ax, aby = by - ay;
        const den = abx * abx + aby * aby;
        let t = den > 0 ? ((px - ax) * abx + (py - ay) * aby) / den : 0;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
    }

    function rect_gap(a, b) {
        const dx = Math.max(b.minx - a.maxx, a.minx - b.maxx);
        const dy = Math.max(b.miny - a.maxy, a.miny - b.maxy);
        if (dx > 0 && dy > 0) return Math.hypot(dx, dy);
        return Math.max(dx, dy);
    }

    function make_bar(vx, vy, oldD, newD) {
        const vertical = oldD.sx !== newD.sx;
        const cx = vertical ? vx + oldD.sx * STANDOFF : vx;
        const cy = vertical ? vy : vy + oldD.sy * STANDOFF;
        const ax = cx - (vertical ? 0 : PLANK_HALF_LEN);
        const ay = cy - (vertical ? PLANK_HALF_LEN : 0);
        const bx = cx + (vertical ? 0 : PLANK_HALF_LEN);
        const by = cy + (vertical ? PLANK_HALF_LEN : 0);
        return {
            x: vx, y: vy,
            cx, cy, vertical,
            ax, ay, bx2: bx, by2: by,
            // visual bar body (8 x 22) for the bar-vs-bar overlap test
            minx: cx - (vertical ? PLANK_HALF_WIDTH : PLANK_HALF_LEN),
            maxx: cx + (vertical ? PLANK_HALF_WIDTH : PLANK_HALF_LEN),
            miny: cy - (vertical ? PLANK_HALF_LEN : PLANK_HALF_WIDTH),
            maxy: cy + (vertical ? PLANK_HALF_LEN : PLANK_HALF_WIDTH)
        };
    }

    function make_seg(x1, y1, x2, y2) {
        return {
            x1, y1, x2, y2,
            minx: Math.min(x1, x2), maxx: Math.max(x1, x2),
            miny: Math.min(y1, y2), maxy: Math.max(y1, y2)
        };
    }

    // Depth-first search over the left/right turn at each note. The path stays
    // compact because candidates are tried nearest-to-origin first (with a
    // one-step lookahead); the search backtracks out of tight corners.
    function build_compact() {
        const n = note_times.length;
        if (!n) return null;

        const steps = new Array(n);
        for (let i = 0; i < n; i++) {
            const t = note_times[i] / 1000;
            const prev = i ? note_times[i - 1] / 1000 : 0;
            steps[i] = SPEED * (t - prev);
        }
        // The first bar sits beyond the intro endpoint, so at audio time 0 the
        // marble is already at the intro endpoint with the first note's travel
        // still ahead of it.
        if (intro_enabled && steps.length) steps[0] += INTRO_DIST;

        const bars = [];
        const segs = [];
        const verts = [];
        let pos = {x: 0, y: 0};
        let cur_axis = 'u';
        let cur_sign = 1;
        let nodes = 0;
        let budget_hit = false;

        // Spatial hash for the incremental collision checks. The field is only
        // a few thousand units across; 96-unit cells keep each query small.
        const CELL = 96;
        const bar_grid = new Map();
        const seg_grid = new Map();
        const qbars = [];
        const qsegs = [];
        let qstamp = 0;

        function cell_keys(minx, miny, maxx, maxy) {
            const out = [];
            const x0 = Math.floor(minx / CELL), x1 = Math.floor(maxx / CELL);
            const y0 = Math.floor(miny / CELL), y1 = Math.floor(maxy / CELL);
            for (let x = x0; x <= x1; x++) {
                for (let y = y0; y <= y1; y++) out.push(x + ',' + y);
            }
            return out;
        }

        function grid_add(grid, obj, keys) {
            obj._cells = keys;
            for (let i = 0; i < keys.length; i++) {
                let a = grid.get(keys[i]);
                if (!a) { a = []; grid.set(keys[i], a); }
                a.push(obj);
            }
        }

        function grid_del(grid, obj) {
            const keys = obj._cells;
            if (!keys) return;
            for (let i = 0; i < keys.length; i++) {
                const a = grid.get(keys[i]);
                if (!a) continue;
                const j = a.indexOf(obj);
                if (j >= 0) a.splice(j, 1);
            }
        }

        function collect(grid, keys, out) {
            qstamp++;
            out.length = 0;
            for (let i = 0; i < keys.length; i++) {
                const a = grid.get(keys[i]);
                if (!a) continue;
                for (let j = 0; j < a.length; j++) {
                    const o = a[j];
                    if (o._q === qstamp) continue;
                    o._q = qstamp;
                    out.push(o);
                }
            }
            return out;
        }

        function valid(bar, vx, vy) {
            // bar body vs existing bar bodies
            collect(bar_grid, cell_keys(bar.minx - BAR_GAP, bar.miny - BAR_GAP,
                                        bar.maxx + BAR_GAP, bar.maxy + BAR_GAP), qbars);
            for (let j = 0; j < qbars.length; j++) {
                if (rect_gap(bar, qbars[j]) < BAR_GAP) return false;
            }

            // the new flight segment vs every reachable existing bar, except
            // the bar it is aimed at (which is not in the grid yet)
            const sminx = Math.min(pos.x, vx), smaxx = Math.max(pos.x, vx);
            const sminy = Math.min(pos.y, vy), smaxy = Math.max(pos.y, vy);
            collect(bar_grid, cell_keys(sminx - STANDOFF, sminy - STANDOFF,
                                        smaxx + STANDOFF, smaxy + STANDOFF), qbars);
            for (let j = 0; j < qbars.length; j++) {
                const b = qbars[j];
                if (seg_seg(pos.x, pos.y, vx, vy, b.ax, b.ay, b.bx2, b.by2) < STANDOFF - 1e-6) {
                    return false;
                }
            }

            // the new bar vs every reachable existing flight segment
            collect(seg_grid, cell_keys(bar.minx - STANDOFF, bar.miny - STANDOFF,
                                        bar.maxx + STANDOFF, bar.maxy + STANDOFF), qsegs);
            for (let j = 0; j < qsegs.length; j++) {
                const s = qsegs[j];
                if (seg_seg(bar.ax, bar.ay, bar.bx2, bar.by2, s.x1, s.y1, s.x2, s.y2) < STANDOFF - 1e-6) {
                    return false;
                }
            }

            // the marble starts at the origin; no bar may sit on it
            if (point_seg(0, 0, bar.ax, bar.ay, bar.bx2, bar.by2) < STANDOFF - 1e-6) return false;
            return true;
        }

        function rec(i) {
            if (i >= n) return true;
            if (++nodes > SEARCH_BUDGET) {
                budget_hit = true;
                return false;
            }

            const oldD = dir_xy(cur_axis, cur_sign);
            const vx = pos.x + oldD.sx / Math.SQRT2 * steps[i];
            const vy = pos.y + oldD.sy / Math.SQRT2 * steps[i];
            const out_axis = cur_axis === 'u' ? 'v' : 'u';

            const cands = [];
            for (let k = 0; k < 2; k++) {
                const sign = k === 0 ? 1 : -1;
                const nd = dir_xy(out_axis, sign);
                const bar = make_bar(vx, vy, oldD, nd);
                if (!valid(bar, vx, vy)) continue;

                let score;
                if (i + 1 < n) {
                    const lx = vx + nd.sx / Math.SQRT2 * steps[i + 1];
                    const ly = vy + nd.sy / Math.SQRT2 * steps[i + 1];
                    score = Math.hypot(lx, ly);
                } else {
                    score = Math.hypot(vx, vy);
                }
                cands.push({sign, bar, score});
            }
            cands.sort((a, b) => a.score - b.score);

            for (let k = 0; k < cands.length; k++) {
                const c = cands[k];
                const old_pos = pos;
                const old_axis = cur_axis;
                const old_sign = cur_sign;

                const seg = make_seg(pos.x, pos.y, vx, vy);
                bars.push(c.bar);
                segs.push(seg);
                verts.push({x: vx, y: vy});
                grid_add(bar_grid, c.bar, cell_keys(c.bar.minx, c.bar.miny, c.bar.maxx, c.bar.maxy));
                grid_add(seg_grid, seg, cell_keys(seg.minx, seg.miny, seg.maxx, seg.maxy));
                pos = {x: vx, y: vy};
                cur_axis = out_axis;
                cur_sign = c.sign;

                if (rec(i + 1)) return true;

                pos = old_pos;
                cur_axis = old_axis;
                cur_sign = old_sign;
                grid_del(seg_grid, segs.pop());
                grid_del(bar_grid, bars.pop());
                verts.pop();
                if (budget_hit) return false;
            }
            return false;
        }

        if (!rec(0)) return null;
        return {bars, verts};
    }

    // --------------------------------------------------------------- fallback
    // Kept as a safety net: the original monotone staircase. It is much more
    // spread out, but it is always valid.
    function build_staircase_fallback() {
        const n = note_times.length;
        const verts = [];
        let u = 0, v = 0;
        let t_prev = 0;
        const half_len = PLANK_HALF_LEN;
        const dir_at = (k) => {
            if (k % 2 === 1) return 'N';
            return k % 4 === 0 ? 'E' : 'W';
        };
        const dir_xy_stair = (dir) => {
            const d = {
                E: {du: 1, dv: 0},
                W: {du: -1, dv: 0},
                N: {du: 0, dv: 1},
                S: {du: 0, dv: -1}
            }[dir];
            return {x: d.du + d.dv, y: d.du - d.dv};
        };
        for (let i = 0; i < n; i++) {
            const t = note_times[i] / 1000;
            const dt = Math.max(1e-6, i === 0 ? t : t - t_prev);
            let len = Math.SQRT2 * SPEED * dt;
            if (intro_enabled && i === 0) len += Math.SQRT2 * INTRO_DIST;
            const d = {
                E: {du: 1, dv: 0},
                W: {du: -1, dv: 0},
                N: {du: 0, dv: 1},
                S: {du: 0, dv: -1}
            }[dir_at(i)];
            u += d.du * len;
            v += d.dv * len;
            const x = (u + v) * 0.5;
            const y = (u - v) * 0.5;
            const a = dir_xy_stair(dir_at(i));
            const b = dir_xy_stair(dir_at(i + 1));
            const vertical = a.x !== b.x;
            let ax, ay, bx, by;
            if (vertical) {
                const px = x + Math.sign(a.x) * STANDOFF;
                ax = bx = px;
                ay = y - half_len;
                by = y + half_len;
            } else {
                const py = y + Math.sign(a.y) * STANDOFF;
                ax = x - half_len;
                bx = x + half_len;
                ay = by = py;
            }
            verts.push({
                x, y,
                cx: (ax + bx) * 0.5, cy: (ay + by) * 0.5,
                vertical,
                ax, ay, bx2: bx, by2: by,
                minx: vertical ? ax - PLANK_HALF_WIDTH : Math.min(ax, bx),
                maxx: vertical ? ax + PLANK_HALF_WIDTH : Math.max(ax, bx),
                miny: vertical ? Math.min(ay, by) : ay - PLANK_HALF_WIDTH,
                maxy: vertical ? Math.max(ay, by) : ay + PLANK_HALF_WIDTH
            });
            t_prev = t;
        }
        return {bars: verts, verts};
    }

    function build_world() {
        const layout = build_compact() || build_staircase_fallback();
        planks = layout.bars;
        path = layout.verts.map(p => ({x: p.x, y: p.y, vertical: p.vertical}));

        let minx = 0, maxx = 0, miny = 0, maxy = 0;
        for (const p of planks) {
            minx = Math.min(minx, p.minx, p.x);
            maxx = Math.max(maxx, p.maxx, p.x);
            miny = Math.min(miny, p.miny, p.y);
            maxy = Math.max(maxy, p.maxy, p.y);
        }
        field = {
            min_x: minx - FIELD_MARGIN,
            max_x: maxx + FIELD_MARGIN,
            min_y: miny - FIELD_MARGIN,
            max_y: maxy + FIELD_MARGIN
        };

        const first = DIRS.U_PLUS;
        start = {
            x: 0,
            y: 0,
            vx: first.sx / Math.SQRT2 * SPEED,
            vy: first.sy / Math.SQRT2 * SPEED
        };
    }

    function set_intro_enabled(value) {
        intro_enabled = !!value;
    }

    function get_intro() {
        return {
            enabled: intro_enabled,
            ms: intro_enabled ? INTRO_MS : 0,
            distance: intro_enabled ? INTRO_DIST : 0,
            x: intro_enabled ? INTRO_DIST / Math.SQRT2 : 0,
            y: intro_enabled ? INTRO_DIST / Math.SQRT2 : 0,
            speed: SPEED,
            accel: SPEED / (INTRO_MS / 1000)
        };
    }

    function reset_playback() {
        play_state = null;
        last_hit = -1;
    }

    function begin_song() {
        const ox = intro_enabled ? INTRO_DIST / Math.SQRT2 : 0;
        const oy = intro_enabled ? INTRO_DIST / Math.SQRT2 : 0;
        play_state = {
            x: ox,
            y: oy,
            vx: SPEED / Math.SQRT2,
            vy: SPEED / Math.SQRT2,
            time: 0,
            hit_count: 0,
            last_hit_time: 0,
            finished: false
        };
        last_hit = -1;
    }

    function init_generator() {
        note_times.sort((a, b) => a - b);
        planks = [];
        path = [];
        play_state = null;
        last_hit = -1;
        stats = {
            notes: note_times.length,
            planks: 0,
            misses: 0,
            wrong_hits: 0,
            vertical: 0,
            horizontal: 0,
            speed: SPEED,
            intro: intro_enabled
        };
        if (!note_times.length) return;

        build_world();
        stats.planks = planks.length;
        for (const p of planks) {
            if (p.vertical) stats.vertical++;
            else stats.horizontal++;
        }
    }

    function generate_world_limited() {
        // Built synchronously in init_generator().
    }

    function get_generator_progress() {
        return 100;
    }

    // -------------------------------------------------------------- collision
    // Circle vs segment. Reflects when approaching; returns true only when the
    // velocity actually flipped.
    function collide(state, plank) {
        const ax = plank.ax, ay = plank.ay;
        const bx = plank.bx2, by = plank.by2;
        const abx = bx - ax, aby = by - ay;
        const apx = state.x - ax, apy = state.y - ay;

        const ab2 = abx * abx + aby * aby;
        const proj = apx * abx + apy * aby;

        let dist, nx, ny;
        if (proj <= 0) {
            dist = Math.hypot(apx, apy);
            if (dist === 0) { nx = 0; ny = 1; }
            else { nx = apx / dist; ny = apy / dist; }
        } else if (proj >= ab2) {
            const bpx = state.x - bx, bpy = state.y - by;
            dist = Math.hypot(bpx, bpy);
            if (dist === 0) { nx = 0; ny = 1; }
            else { nx = bpx / dist; ny = bpy / dist; }
        } else {
            const cross = apx * aby - apy * abx;
            dist = Math.abs(cross) / Math.sqrt(ab2);
            const len = Math.sqrt(ab2);
            nx = -aby / len;
            ny = abx / len;
            if (apx * nx + apy * ny < 0) { nx = -nx; ny = -ny; }
        }

        if (dist > STANDOFF) return false;

        const vn = state.vx * nx + state.vy * ny;
        const reflected = vn < 0;
        if (reflected) {
            state.vx -= 2 * vn * nx;
            state.vy -= 2 * vn * ny;
        }

        const depth = STANDOFF - dist;
        if (depth > 0) {
            state.x += nx * depth;
            state.y += ny * depth;
        }
        return reflected;
    }

    function on_hit(state, bar_index) {
        // The collision is detected on a discrete substep, a fraction of a
        // millisecond after the exact arrival. Snap position and clock to the
        // note's timestamp so error cannot accumulate over hundreds of bars.
        const note_time = note_times[bar_index];
        state.time = note_time;
        state.last_hit_time = note_time;

        const bar = planks[bar_index];
        state.x = bar.x;
        state.y = bar.y;

        state.hit_count++;
        if (state.hit_count >= planks.length) {
            state.finished = true;
            state.vx = 0;
            state.vy = 0;
        }
    }

    // One 15 ms tick. Constant speed, small substeps. Only the next bar needs
    // a collision test because the layout keeps the centreline clear of every
    // other bar.
    function step(state) {
        let last = -1;
        let remaining = MS_PER_TICK / 1000;

        while (remaining > 1e-12) {
            if (state.hit_count < planks.length) {
                const next = planks[state.hit_count];
                if (collide(state, next)) {
                    last = state.hit_count;
                    on_hit(state, state.hit_count);
                }
            }

            const sp = Math.max(Math.hypot(state.vx, state.vy), 1e-9);
            const dt = Math.min(remaining, MAX_SUBSTEP / sp, MAX_SUBSTEP_MS / 1000);
            state.x += state.vx * dt;
            state.y += state.vy * dt;
            state.time += dt * 1000;
            remaining -= dt;
        }

        return last;
    }

    function update_main_world() {
        if (!play_state) {
            begin_song();
            return;
        }
        if (play_state.finished) {
            last_hit = -1;
            return;
        }
        last_hit = step(play_state);
    }

    // ---------------------------------------------------------------- getters
    function num_marbles() { return play_state ? 1 : 0; }
    function get_marble_x() { return play_state ? play_state.x : start.x; }
    function get_marble_y() { return play_state ? play_state.y : start.y; }
    function get_marble_collision() { return play_state ? last_hit : -1; }
    function get_time() { return play_state ? play_state.time : 0; }
    function get_last_hit_time() { return play_state ? play_state.last_hit_time : 0; }

    function num_planks() { return planks.length; }
    function get_plank_a_x(i) { return planks[i].ax; }
    function get_plank_a_y(i) { return planks[i].ay; }
    function get_plank_b_x(i) { return planks[i].bx2; }
    function get_plank_b_y(i) { return planks[i].by2; }

    function get_planks() {
        const out = [];
        for (let i = 0; i < planks.length; i++) {
            const p = planks[i];
            out.push({
                a: [p.ax, p.ay],
                b: [p.bx2, p.by2],
                note: i,
                hit: -Infinity,
                visible_from: 0,
                visible_until: Infinity,
                vertical: p.vertical,
                x: p.x,
                y: p.y
            });
        }
        return out;
    }

    return {
        reset_tracks,
        add_time_of_hit,
        set_intro_enabled,
        get_intro,
        reset_playback,
        begin_song,
        init_generator,
        generate_world_limited,
        get_generator_progress,
        update_main_world,
        num_marbles,
        get_marble_x,
        get_marble_y,
        get_marble_collision,
        get_marbles: () => {
            const out = [];
            for (let i = 0; i < num_marbles(); i++) out.push([get_marble_x(i), get_marble_y(i)]);
            return out;
        },
        get_marble_collisions: () => [get_marble_collision(0)],
        num_planks,
        get_plank_a_x,
        get_plank_a_y,
        get_plank_b_x,
        get_plank_b_y,
        get_plank: (i) => [[get_plank_a_x(i), get_plank_a_y(i)], [get_plank_b_x(i), get_plank_b_y(i)]],
        get_planks,
        get_path: () => path.map(p => ({x: p.x, y: p.y, vertical: p.vertical})),
        get_start: () => ({x: start.x, y: start.y}),
        get_time,
        get_last_hit_time,
        get_state: () => play_state ? {
            x: play_state.x,
            y: play_state.y,
            vx: play_state.vx,
            vy: play_state.vy,
            time: play_state.time,
            hit_count: play_state.hit_count,
            last_hit_time: play_state.last_hit_time,
            finished: play_state.finished
        } : null,
        get_stats: () => Object.assign({}, stats),
        get_bounds: () => ({
            field: {min_x: field.min_x, max_x: field.max_x, min_y: field.min_y, max_y: field.max_y},
            radius: MARBLE_RADIUS,
            standoff: STANDOFF,
            speed: SPEED
        }),
        set_max_y: () => {},
        set_min_y: () => {}
    };
})();

if (typeof window !== 'undefined') window.API = API;
