/* Music Marbles — wall field.
 *
 * The open space is a single irregular, right-angled room. Every path segment
 * opens one axis-aligned bay: the bay reaches from the back of the bar at the
 * start of the segment to the back of the bar at its end, and also spans the
 * two bars sideways. The union of those bays is the room the marble bounces in.
 * Walls fill everything outside the union.
 *
 * Bars whose back is against the wall get a black wall post so there is no
 * blue seam. Bars in the middle of the room are allowed to float: no fake
 * black block is drawn behind them, because that block would not be a wall.
 *
 * Walls are visual only and never take part in the engine's collision or
 * timing.
 */
(function (global) {
    'use strict';

    const DEFAULTS = {
        cell: 48,
        gap: 2.5,
        margin: 0
    };

    const BAR_HALF_THICKNESS = 4;
    const BAR_HALF_LENGTH = 14;
    const POST_OVERLAP = 1;
    const POST_EXTRA = 15;

    function unique_points(path, start) {
        const points = [];
        const push = (p) => {
            if (!p) return;
            const x = Number(p.x);
            const y = Number(p.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            const last = points[points.length - 1];
            if (last && Math.abs(last.x - x) < 1e-6 && Math.abs(last.y - y) < 1e-6) return;
            points.push({x, y});
        };
        push(start);
        if (Array.isArray(path)) path.forEach(push);
        return points;
    }

    function bar_info(plank) {
        if (!plank || !plank.a || !plank.b) return null;
        const vertical = plank.vertical !== undefined
            ? plank.vertical
            : Math.abs(plank.a[0] - plank.b[0]) < 1e-6;
        const cx = (plank.a[0] + plank.b[0]) * 0.5;
        const cy = (plank.a[1] + plank.b[1]) * 0.5;
        const nx = vertical ? Math.sign(cx - plank.x) : 0;
        const ny = vertical ? 0 : Math.sign(cy - plank.y);
        return {
            vertical,
            cx,
            cy,
            nx,
            ny,
            far_x: cx + nx * BAR_HALF_THICKNESS,
            far_y: cy + ny * BAR_HALF_THICKNESS
        };
    }

    // One bay per path segment. It spans the segment, the bar behind its
    // start, and the bar behind its end; then the margin pushes the wall back
    // so the bar backs are not cut by the wall edge.
    function bay_rect(a, b, margin) {
        let minx = Infinity;
        let miny = Infinity;
        let maxx = -Infinity;
        let maxy = -Infinity;
        const add = (x, y) => {
            if (x < minx) minx = x;
            if (x > maxx) maxx = x;
            if (y < miny) miny = y;
            if (y > maxy) maxy = y;
        };

        add(a.x, a.y);
        if (b) add(b.x, b.y);

        for (const info of [a.info, b && b.info]) {
            if (!info) continue;
            add(info.far_x, info.far_y);
            add(info.cx - (info.vertical ? BAR_HALF_THICKNESS : BAR_HALF_LENGTH),
                info.cy - (info.vertical ? BAR_HALF_LENGTH : BAR_HALF_THICKNESS));
            add(info.cx + (info.vertical ? BAR_HALF_THICKNESS : BAR_HALF_LENGTH),
                info.cy + (info.vertical ? BAR_HALF_LENGTH : BAR_HALF_THICKNESS));
        }

        return {
            x1: minx - margin,
            y1: miny - margin,
            x2: maxx + margin,
            y2: maxy + margin
        };
    }

    function make_key(points, options, planks) {
        const first = points[0];
        const last = points[points.length - 1];
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            if (p.x < minx) minx = p.x;
            if (p.x > maxx) maxx = p.x;
            if (p.y < miny) miny = p.y;
            if (p.y > maxy) maxy = p.y;
        }
        let bar_sum = 0;
        if (Array.isArray(planks)) {
            for (let i = 0; i < planks.length; i++) {
                const p = planks[i];
                if (!p || !p.a || !p.b) continue;
                bar_sum += p.a[0] + p.a[1] * 3 + p.b[0] * 7 + p.b[1] * 11 +
                    (p.x || 0) * 13 + (p.y || 0) * 17 + (p.vertical ? 19 : 0);
            }
        }
        return [
            points.length,
            first.x, first.y, last.x, last.y,
            minx, miny, maxx, maxy,
            options.cell, options.gap, options.margin,
            Array.isArray(planks) ? planks.length : 0, bar_sum
        ].join('|');
    }

    let cached_key = '';
    let cached_field = null;

    class WallField {
        constructor(points, cell, gap, margin, planks) {
            this.points = points;
            this.cell = cell;
            this.gap = gap;
            this.margin = margin;
            this.planks = Array.isArray(planks) ? planks : [];
            this.room = new Path2D();
            this.posts = new Path2D();
            this.bays = [];
            this.surfaces = new WeakMap();
            this.build_geometry();
        }

        point_in_room(x, y) {
            for (let i = 0; i < this.bays.length; i++) {
                const bay = this.bays[i];
                if (x >= bay.x1 - 1e-6 && x <= bay.x2 + 1e-6 &&
                    y >= bay.y1 - 1e-6 && y <= bay.y2 + 1e-6) {
                    return true;
                }
            }
            return false;
        }

        build_geometry() {
            for (let i = 1; i < this.points.length; i++) {
                const a_bar = i - 2 >= 0 ? this.planks[i - 2] : null;
                const b_bar = i - 1 < this.planks.length ? this.planks[i - 1] : null;
                const a = {
                    x: this.points[i - 1].x,
                    y: this.points[i - 1].y,
                    info: bar_info(a_bar)
                };
                const b = {
                    x: this.points[i].x,
                    y: this.points[i].y,
                    info: bar_info(b_bar)
                };
                const bay = bay_rect(a, b, this.margin);
                this.bays.push(bay);
                this.room.rect(bay.x1, bay.y1, bay.x2 - bay.x1, bay.y2 - bay.y1);
            }

            // Only bars whose back is actually against the wall get a black
            // post. A bar floating in the middle of the room stays a bare bar;
            // a black block there would look like a wall but would not be one.
            const depth = this.margin + POST_EXTRA;
            for (let i = 0; i < this.planks.length; i++) {
                const info = bar_info(this.planks[i]);
                if (!info) continue;
                const probe_x = info.far_x + info.nx * 2;
                const probe_y = info.far_y + info.ny * 2;
                if (this.point_in_room(probe_x, probe_y)) continue;
                const inner_x = info.far_x - info.nx * POST_OVERLAP;
                const inner_y = info.far_y - info.ny * POST_OVERLAP;
                const outer_x = info.far_x + info.nx * depth;
                const outer_y = info.far_y + info.ny * depth;
                let x1, y1, x2, y2;
                if (info.vertical) {
                    x1 = Math.min(inner_x, outer_x);
                    x2 = Math.max(inner_x, outer_x);
                    y1 = info.cy - BAR_HALF_LENGTH;
                    y2 = info.cy + BAR_HALF_LENGTH;
                } else {
                    x1 = info.cx - BAR_HALF_LENGTH;
                    x2 = info.cx + BAR_HALF_LENGTH;
                    y1 = Math.min(inner_y, outer_y);
                    y2 = Math.max(inner_y, outer_y);
                }
                this.posts.rect(x1, y1, x2 - x1, y2 - y1);
            }
        }

        surface_for(view) {
            const dpr = view.dpr || 1;
            const width = Math.max(1, Math.round(view.width * dpr));
            const height = Math.max(1, Math.round(view.height * dpr));
            let surface = this.surfaces.get(view);
            if (!surface || surface.canvas.width !== width || surface.canvas.height !== height) {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                surface = {
                    canvas,
                    ctx: canvas.getContext('2d')
                };
                this.surfaces.set(view, surface);
            }
            return surface;
        }

        draw(view) {
            const scale = view.scale;
            if (!(scale > 0)) return;

            const dpr = view.dpr || 1;
            const w = view.width;
            const h = view.height;
            const ox = view.offset[0];
            const oy = view.offset[1];
            const surface = this.surface_for(view);
            const octx = surface.ctx;

            octx.setTransform(dpr, 0, 0, dpr, 0, 0);
            octx.clearRect(0, 0, w, h);

            // Fill every visible grid cell. The room is erased afterwards, so
            // the wall keeps blocky 48-unit cells while the opening itself is
            // made only of right angles.
            const world_x0 = (0 - ox) / scale;
            const world_x1 = (w - ox) / scale;
            const world_y0 = (0 - oy) / scale;
            const world_y1 = (h - oy) / scale;
            const cell = this.cell;
            const block = cell - this.gap;
            const inset = this.gap * 0.5;
            const block_px = block * scale;

            const ix0 = Math.floor(world_x0 / cell) - 1;
            const ix1 = Math.ceil(world_x1 / cell) + 1;
            const iy0 = Math.floor(world_y0 / cell) - 1;
            const iy1 = Math.ceil(world_y1 / cell) + 1;

            octx.fillStyle = '#000000';
            octx.beginPath();
            for (let iy = iy0; iy <= iy1; iy++) {
                const sy = (iy * cell + inset) * scale + oy;
                for (let ix = ix0; ix <= ix1; ix++) {
                    const sx = (ix * cell + inset) * scale + ox;
                    octx.rect(sx, sy, block_px, block_px);
                }
            }
            octx.fill();

            // Erase the union of all bays. This is the room.
            octx.save();
            octx.globalCompositeOperation = 'destination-out';
            octx.fillStyle = '#000000';
            octx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
            octx.fill(this.room);
            octx.restore();

            // Put the wall back behind every bar. The posts are inside the
            // room where a bay is wider than the path, so a bar in the middle
            // of the room still visibly grows out of a wall.
            octx.save();
            octx.fillStyle = '#000000';
            octx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
            octx.fill(this.posts);
            octx.restore();

            view.ctx.drawImage(surface.canvas, 0, 0, w, h);
        }
    }

    function build(path, start, options, planks) {
        const opts = Object.assign({}, DEFAULTS, options || {});
        const points = unique_points(path, start);
        if (points.length < 2) return null;

        const key = make_key(points, opts, planks);
        if (key === cached_key) return cached_field;

        const cell = Math.max(8, Number(opts.cell) || DEFAULTS.cell);
        const gap_raw = Number(opts.gap);
        const gap = Number.isFinite(gap_raw) ? Math.max(0, gap_raw) : DEFAULTS.gap;
        const margin_raw = Number(opts.margin);
        const margin = Number.isFinite(margin_raw) ? Math.max(0, margin_raw) : DEFAULTS.margin;

        const field = new WallField(points, cell, gap, margin, planks);
        cached_key = key;
        cached_field = field;
        return field;
    }

    global.WallKit = {
        DEFAULTS,
        WallField,
        build
    };
})(window);
