/* 音乐弹珠 — 观看 / 分享页。 */
(function () {
    'use strict';

    const API = window.API;
    const SK = window.SceneKit;
    const stage = document.getElementById('stage');
    const title_el = document.getElementById('track-title');
    const track_status = document.getElementById('track-status');
    const overlay = document.getElementById('play-overlay');
    const play_button = document.getElementById('play-button');
    const play_label = play_button.querySelector('.play-label');
    const play_sub = play_button.querySelector('.play-sub');
    const expired_overlay = document.getElementById('expired-overlay');
    const expired_message = document.getElementById('expired-message');
    const toggle_button = document.getElementById('toggle-button');
    const toggle_icon = document.getElementById('toggle-icon');
    const restart_button = document.getElementById('restart-button');
    const mute_button = document.getElementById('mute-button');
    const sound_icon = document.getElementById('sound-icon');
    const share_button = document.getElementById('share-button');
    const download_button = document.getElementById('download-button');
    const time_label = document.getElementById('time-label');
    const progress_fill = document.getElementById('progress-fill');
    const expiry_label = document.getElementById('expiry-label');
    const expiry_value = document.getElementById('expiry-value');
    const extend_button = document.getElementById('extend-button');
    const modal = document.getElementById('export-modal');
    const close_export = document.getElementById('close-export');
    const ratio_grid = document.getElementById('ratio-grid');
    const export_status = document.getElementById('export-status');
    const export_progress = document.getElementById('export-progress');
    const export_progress_fill = document.getElementById('export-progress-fill');
    const export_download = document.getElementById('export-download');
    const toast_el = document.getElementById('toast');

    const id = decodeURIComponent((location.pathname.split('/').filter(Boolean).pop() || ''));
    const MERGE_WINDOW_MS = 80;
    const INTRO_SECONDS = 1.0;
    const DIMS = {
        '9x16': [1080, 1920],
        '16x9': [1920, 1080],
        '1x1': [1080, 1080],
        '4x5': [1080, 1350]
    };
    const EXPORT_TAIL_SECONDS = 0.55;
    const OFFLINE_FPS = 30;
    const OFFLINE_BITRATE = 6_000_000;
    const OFFLINE_CODECS = ['avc1.640028', 'avc1.4D4028', 'avc1.42E028', 'avc1.42002A'];
    const OFFLINE_READY = typeof window.VideoEncoder === 'function'
        && typeof window.VideoFrame === 'function'
        && window.Mp4Muxer
        && typeof window.Mp4Muxer.Muxer === 'function';

    let data = null;
    let track = [];
    let view = null;
    let scene = null;
    let audio_ctx = null;
    let audio_buffer = null;
    let output_gain = null;
    let source = null;
    let mode = 'loading';
    let paused_from = null;
    let intro_start_ctx = 0;
    let audio_start_ctx = 0;
    let raf = 0;
    let exporting = false;
    let muted = false;
    let export_url = '';
    let export_name = '';
    let toast_timer = 0;
    let expiry_timer = 0;
    let expires_at = 0;
    let extend_busy = false;
    let seed = 1;

    play_button.disabled = true;
    download_button.disabled = true;
    extend_button.disabled = true;

    function hash_id(str) {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    function fmt(sec) {
        sec = Math.max(0, Math.floor(sec));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function fmt_countdown(ms) {
        const total = Math.max(0, Math.ceil(ms / 1000));
        const m = Math.floor(total / 60);
        const s = total % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function total_seconds() {
        return (data && data.duration ? data.duration : 0) + INTRO_SECONDS;
    }

    function current_visual_seconds() {
        if (!audio_ctx) return 0;
        if (mode === 'intro') return Math.min(INTRO_SECONDS, Math.max(0, audio_ctx.currentTime - intro_start_ctx));
        if (mode === 'playing') return Math.min(total_seconds(), INTRO_SECONDS + Math.max(0, audio_ctx.currentTime - audio_start_ctx));
        if (mode === 'finished') return total_seconds();
        if (mode === 'paused') {
            if (paused_from === 'intro') return Math.min(INTRO_SECONDS, Math.max(0, audio_ctx.currentTime - intro_start_ctx));
            return Math.min(total_seconds(), INTRO_SECONDS + Math.max(0, audio_ctx.currentTime - audio_start_ctx));
        }
        return 0;
    }

    function update_progress() {
        const elapsed = current_visual_seconds();
        const total = total_seconds();
        const pct = total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 0;
        progress_fill.style.width = `${pct * 100}%`;
        time_label.textContent = `${fmt(elapsed)} / ${fmt(total)}`;
    }

    function set_play_ui() {
        const is_playing = mode === 'playing' || mode === 'intro';
        toggle_icon.className = is_playing ? 'pause-icon' : 'play-icon-small';
        const show_overlay = mode === 'idle' || mode === 'paused' || mode === 'finished' || mode === 'loading';
        overlay.classList.toggle('hidden', !show_overlay);
        play_button.disabled = mode === 'loading';
        if (mode === 'finished') {
            play_label.textContent = '重播';
            play_sub.textContent = '从加速段重新开始';
        } else if (mode === 'paused') {
            play_label.textContent = '继续';
            play_sub.textContent = paused_from === 'intro' ? '从加速段继续' : '从当前时间继续';
        } else if (mode === 'idle') {
            play_label.textContent = '播放';
            play_sub.textContent = '1 秒加速后，音乐开始';
        } else if (mode === 'loading') {
            play_label.textContent = '正在加载…';
            play_sub.textContent = '准备音频与轨道';
        }
    }

    function toast(text) {
        toast_el.textContent = text;
        toast_el.classList.add('show');
        clearTimeout(toast_timer);
        toast_timer = setTimeout(() => toast_el.classList.remove('show'), 2200);
    }

    function show_error(text) {
        title_el.textContent = '无法加载这条轨道';
        overlay.classList.remove('hidden');
        play_label.textContent = '加载失败';
        play_sub.textContent = text || '请稍后重试。';
        play_button.disabled = true;
        expired_overlay.classList.add('hidden');
    }

    function show_expired(message) {
        stop_source();
        if (audio_ctx && audio_ctx.state === 'running') audio_ctx.suspend().catch(() => {});
        mode = 'expired';
        clearInterval(expiry_timer);
        expiry_timer = 0;
        document.body.classList.add('is-expired');
        track_status.textContent = '链接已过期';
        overlay.classList.add('hidden');
        expired_message.textContent = message || '链接不存在，或内容已超过 10 分钟被删除。';
        expired_overlay.classList.remove('hidden');
        expiry_label.textContent = '链接状态';
        expiry_value.textContent = '已过期';
        expiry_value.classList.add('low');
        extend_button.disabled = true;
        extend_button.classList.add('hidden');
        download_button.disabled = true;
        play_button.disabled = true;
        update_progress();
    }

    function merge_notes(raw) {
        const sorted = raw.map((n) => ({
            note_names: (n.note_names || []).slice(0, 4),
            time: Number(n.time),
            duration: Math.max(0.05, Number(n.duration) || 0.1)
        })).filter((n) => Number.isFinite(n.time) && n.time >= 0).sort((a, b) => a.time - b.time);

        const out = [];
        for (const n of sorted) {
            const ms = Math.round(n.time * 1000);
            const last = out[out.length - 1];
            if (last && ms - Math.round(last.time * 1000) < MERGE_WINDOW_MS) {
                for (const name of n.note_names) {
                    if (!last.note_names.includes(name)) last.note_names.push(name);
                }
                last.duration = Math.max(last.duration, n.duration);
            } else {
                out.push(n);
            }
        }
        return out;
    }

    function prepare_engine() {
        API.set_intro_enabled(true);
        API.reset_tracks();
        for (const n of track) API.add_time_of_hit(0, Math.round(n.time * 1000));
        API.init_generator();
        if (API.get_planks().length !== track.length) {
            throw new Error(`轨道数量不匹配（${API.get_planks().length} 根横杆 / ${track.length} 个音符）`);
        }
    }

    function make_view() {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const rect = stage.getBoundingClientRect();
        const width = Math.max(320, Math.round(rect.width || stage.clientWidth || window.innerWidth));
        const height = Math.max(240, Math.round(rect.height || stage.clientHeight || window.innerHeight));
        view = new SK.View(stage, width, height, dpr);
        view.set_scale(SK.fit_scale(view.width, view.height, 820));
    }

    function resize() {
        if (!scene) {
            make_view();
            return;
        }
        const old_w = Math.max(1, view.width);
        const old_h = Math.max(1, view.height);
        const p = scene.marble.position;
        const rx = (p[0] * view.scale + view.offset[0]) / old_w;
        const ry = (p[1] * view.scale + view.offset[1]) / old_h;

        make_view();
        view.offset[0] = view.width * rx - p[0] * view.scale;
        view.offset[1] = view.height * ry - p[1] * view.scale;
        scene.view = view;
        SK.init_stars(view, seed);
        scene.draw();
    }

    function stop_source() {
        if (!source) return;
        source.onended = null;
        try { source.stop(); } catch (err) { /* 已经停止 */ }
        try { source.disconnect(); } catch (err) { /* 忽略 */ }
        source = null;
    }

    function start_run() {
        if (mode === 'expired') return;
        if (!audio_buffer) {
            toast('音频还在加载。');
            return;
        }
        if (exporting) return;
        stop_source();
        audio_ctx.resume();
        API.reset_playback();
        scene.reset();
        scene.draw();

        source = audio_ctx.createBufferSource();
        source.buffer = audio_buffer;
        source.connect(output_gain);
        source.onended = () => {
            if (mode === 'playing') finish_run();
        };

        intro_start_ctx = audio_ctx.currentTime;
        audio_start_ctx = intro_start_ctx + INTRO_SECONDS;
        source.start(audio_start_ctx);
        mode = 'intro';
        paused_from = null;
        update_progress();
        set_play_ui();
        if (!raf) raf = requestAnimationFrame(loop);
    }

    function finish_run() {
        if (mode === 'finished' || mode === 'expired') return;
        mode = 'finished';
        stop_source();
        update_progress();
        set_play_ui();
        scene.time = API.get_time();
        scene.draw();
    }

    function toggle_pause() {
        if (exporting || mode === 'expired' || mode === 'loading') return;
        if (mode === 'idle' || mode === 'finished') {
            start_run();
            return;
        }
        if (mode === 'paused') {
            audio_ctx.resume();
            mode = paused_from || 'playing';
            paused_from = null;
            if (!raf) raf = requestAnimationFrame(loop);
            set_play_ui();
            return;
        }
        if (mode === 'intro' || mode === 'playing') {
            paused_from = mode;
            audio_ctx.suspend();
            mode = 'paused';
            set_play_ui();
        }
    }

    function restart_run() {
        if (exporting || mode === 'expired' || mode === 'loading') return;
        if (audio_ctx && mode === 'paused') audio_ctx.resume();
        start_run();
    }

    function toggle_mute() {
        if (!audio_ctx || mode === 'expired') return;
        muted = !muted;
        if (output_gain) output_gain.gain.setTargetAtTime(muted ? 0 : 1, audio_ctx.currentTime, 0.02);
        sound_icon.classList.toggle('muted', muted);
    }

    function loop() {
        raf = 0;
        if (mode === 'expired') return;
        if (mode === 'intro') {
            const t = audio_ctx.currentTime - intro_start_ctx;
            if (t < INTRO_SECONDS) {
                scene.set_intro_progress(Math.max(0, t), API.get_intro());
                scene.draw();
                update_progress();
            } else {
                API.begin_song();
                scene.synchronize_marble();
                scene.time = 0;
                mode = 'playing';
                set_play_ui();
            }
        }

        if (mode === 'playing') {
            const song_time = audio_ctx.currentTime - audio_start_ctx;
            if (song_time >= 0) {
                let steps = 0;
                // 后台标签页会节流 rAF。这里按音频时钟补足 tick，
                // 避免弹珠落后于声音。
                while (API.get_time() < song_time * 1000 - 0.5 && steps < 300) {
                    API.update_main_world();
                    scene.synchronize_marble();
                    scene.process_hits();
                    scene.update_particles();
                    SK.update_camera(view, scene.marble.position);
                    steps++;
                }
            }
            scene.time = API.get_time();
            scene.draw();
            update_progress();

            if (song_time >= (data.duration || 0)) {
                finish_run();
            }
        } else if (mode === 'paused' || mode === 'finished' || mode === 'idle') {
            scene.draw();
        }

        if (mode !== 'finished' && mode !== 'paused' && mode !== 'idle') {
            raf = requestAnimationFrame(loop);
        } else {
            raf = 0;
        }
    }

    async function load_audio() {
        audio_ctx = new (window.AudioContext || window.webkitAudioContext)();
        output_gain = audio_ctx.createGain();
        output_gain.gain.value = muted ? 0 : 1;
        output_gain.connect(audio_ctx.destination);

        const resp = await fetch(data.audioUrl, {cache: 'force-cache'});
        if (!resp.ok) throw new Error('音频读取失败');
        const arr = await resp.arrayBuffer();
        audio_buffer = await audio_ctx.decodeAudioData(arr);
    }

    function set_export_status(text, error) {
        export_status.textContent = text || '';
        export_status.classList.toggle('error', !!error);
    }

    function set_export_progress(pct) {
        export_progress.classList.remove('hidden');
        export_progress_fill.style.width = `${Math.min(100, Math.max(0, pct * 100))}%`;
    }

    function yield_control() {
        if (window.scheduler && typeof window.scheduler.yield === 'function') {
            return window.scheduler.yield();
        }
        return new Promise((resolve) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => {
                channel.port1.close();
                resolve();
            };
            channel.port2.postMessage(0);
        });
    }

    async function pick_offline_codec(width, height) {
        if (!OFFLINE_READY) return '';
        for (const codec of OFFLINE_CODECS) {
            try {
                const support = await VideoEncoder.isConfigSupported({
                    codec,
                    width,
                    height,
                    bitrate: OFFLINE_BITRATE,
                    framerate: OFFLINE_FPS,
                    hardwareAcceleration: 'prefer-hardware'
                });
                if (support && support.supported) return codec;
            } catch (err) { /* 尝试下一个编码器 */ }
        }
        return '';
    }

    async function render_offline(ratio, dims, codec) {
        const [w, h] = dims;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;

        const eview = new SK.View(canvas, w, h, 1);
        eview.set_scale(Math.min(w, h) / 820);
        prepare_engine();
        const escene = new SK.Scene(track, eview, seed);
        escene.reset();

        const duration = Math.max(1, Number(data.duration) || 1);
        const total = INTRO_SECONDS + duration + EXPORT_TAIL_SECONDS;
        const frames = Math.max(1, Math.ceil(total * OFFLINE_FPS));
        const target = new window.Mp4Muxer.ArrayBufferTarget();
        const muxer = new window.Mp4Muxer.Muxer({
            target,
            video: {codec: 'avc', width: w, height: h, frameRate: OFFLINE_FPS},
            fastStart: false
        });

        let failure = null;
        const encoder = new VideoEncoder({
            output: (chunk, meta) => {
                if (failure) return;
                try {
                    muxer.addVideoChunk(chunk, meta);
                } catch (err) {
                    failure = err;
                }
            },
            error: (err) => { failure = err; }
        });
        try {
            encoder.configure({
                codec,
                width: w,
                height: h,
                bitrate: OFFLINE_BITRATE,
                framerate: OFFLINE_FPS,
                hardwareAcceleration: 'prefer-hardware'
            });
        } catch (err) {
            throw new Error(`视频编码器启动失败：${err.message || err}`);
        }

        const eint = API.get_intro();
        let began = false;
        try {
            for (let i = 0; i < frames; i++) {
                if (failure) throw failure;
                const t = i / OFFLINE_FPS;
                if (t < INTRO_SECONDS) {
                    escene.set_intro_progress(Math.max(0, t), eint);
                    escene.draw();
                } else {
                    if (!began) {
                        API.begin_song();
                        escene.synchronize_marble();
                        escene.time = 0;
                        began = true;
                    }
                    const song_time = t - INTRO_SECONDS;
                    let steps = 0;
                    while (API.get_time() < song_time * 1000 - 0.5 && steps < 300) {
                        API.update_main_world();
                        escene.synchronize_marble();
                        escene.process_hits();
                        escene.update_particles();
                        SK.update_camera(eview, escene.marble.position);
                        steps++;
                    }
                    escene.time = API.get_time();
                    escene.draw();
                }

                const frame = new VideoFrame(canvas, {
                    timestamp: Math.round(i * 1_000_000 / OFFLINE_FPS),
                    duration: Math.round(1_000_000 / OFFLINE_FPS)
                });
                encoder.encode(frame, {keyFrame: i % (OFFLINE_FPS * 2) === 0});
                frame.close();

                if (i % 6 === 0 || i === frames - 1) {
                    set_export_progress(0.02 + 0.96 * ((i + 1) / frames));
                    await yield_control();
                }
                // 软件编码器可能先缓冲一批帧，不能只等 encodeQueueSize 降下来。
                // 每 4 秒强制 flush 一次，既能回收编码队列，也避免长视频堆积内存。
                if (i > 0 && i % (OFFLINE_FPS * 4) === 0) {
                    await encoder.flush();
                    if (failure) throw failure;
                }
            }
            await encoder.flush();
            if (failure) throw failure;
        } finally {
            if (encoder.state !== 'closed') {
                try { encoder.close(); } catch (err) { /* 忽略 */ }
            }
        }

        muxer.finalize();
        return new Blob([target.buffer], {type: 'video/mp4'});
    }

    async function upload_export(blob, ext, ratio, offline) {
        if (!blob || !blob.size) throw new Error('导出结果为空，请重试。');
        set_export_status(offline ? '正在封装音频与 MP4…' : '正在上传并转换为 MP4…');
        set_export_progress(0.99);

        const fd = new FormData();
        fd.append('video', blob, `export.${ext}`);
        fd.append('ratio', ratio);
        fd.append('name', data.title || 'music-marbles');
        if (offline) {
            fd.append('offline', '1');
            fd.append('trackId', id);
        }

        const resp = await fetch('/api/video', {method: 'POST', body: fd});
        const result = await resp.json().catch(() => ({}));
        if (!resp.ok || !result.url) throw new Error(result.error || '转换失败');

        export_url = result.url;
        export_name = result.download || `${data.title || 'music-marbles'}-${ratio}.mp4`;
        set_export_progress(1);
        set_export_status('已生成，MP4 可在 10 分钟内下载。');
        export_download.classList.remove('hidden');
    }

    function choose_mime() {
        if (typeof MediaRecorder === 'undefined') return '';
        const candidates = [
            'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
            'video/mp4',
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm'
        ];
        for (const mime of candidates) {
            try {
                if (MediaRecorder.isTypeSupported(mime)) return mime;
            } catch (err) { /* 忽略 */ }
        }
        return '';
    }

    async function export_ratio(ratio) {
        if (exporting || !audio_buffer || mode === 'expired') return;
        const dims = DIMS[ratio];
        if (!dims) return;

        const can_record = typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
        const mime = can_record ? choose_mime() : '';

        exporting = true;
        export_url = '';
        export_name = '';
        export_download.classList.add('hidden');
        ratio_grid.querySelectorAll('button').forEach((b) => b.disabled = true);
        stop_source();
        if (mode === 'paused') await audio_ctx.resume();
        mode = 'exporting';
        set_play_ui();
        set_export_status(`正在准备 ${ratio.replace('x', ':')}…`);
        set_export_progress(0);

        let export_canvas = null;
        let recorder = null;
        let export_source = null;
        try {
            const codec = await pick_offline_codec(dims[0], dims[1]);
            if (codec) {
                let blob = null;
                try {
                    set_export_status(`正在离线渲染 ${ratio.replace('x', ':')} · 速度优先…`);
                    set_export_progress(0);
                    blob = await render_offline(ratio, dims, codec);
                } catch (err) {
                    console.warn('离线导出失败，回退到实时录制：', err);
                    set_export_status('离线渲染不可用，正在实时录制…');
                    set_export_progress(0);
                }
                if (blob) {
                    await upload_export(blob, 'mp4', ratio, true);
                    return;
                }
            }

            if (!can_record) throw new Error('这个浏览器无法录制画布视频，请换 Chrome 或 Safari。');
            if (!mime) throw new Error('浏览器里没有可用的视频编码器。');
            set_export_status(`正在实时录制 ${ratio.replace('x', ':')} · 请保持页面在前台…`);
            set_export_progress(0);

            const [w, h] = dims;
            export_canvas = document.createElement('canvas');
            export_canvas.width = w;
            export_canvas.height = h;
            export_canvas.style.cssText = `position:fixed;left:-10000px;top:0;width:${w}px;height:${h}px;`;
            document.body.appendChild(export_canvas);

            const eview = new SK.View(export_canvas, w, h, 1);
            eview.set_scale(Math.min(w, h) / 820);

            prepare_engine();
            const escene = new SK.Scene(track, eview, seed);
            escene.reset();

            const dest = audio_ctx.createMediaStreamDestination();
            export_source = audio_ctx.createBufferSource();
            export_source.buffer = audio_buffer;
            const egain = audio_ctx.createGain();
            egain.gain.value = 1;
            export_source.connect(egain);
            egain.connect(dest);

            const video_stream = export_canvas.captureStream(30);
            const stream = new MediaStream([
                ...video_stream.getVideoTracks(),
                ...dest.stream.getAudioTracks()
            ]);

            const chunks = [];
            recorder = new MediaRecorder(stream, {
                mimeType: mime,
                videoBitsPerSecond: 6_000_000,
                audioBitsPerSecond: 128_000
            });
            recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
            const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

            const eint = API.get_intro();
            const start_ctx = audio_ctx.currentTime;
            const audio_at = start_ctx + INTRO_SECONDS;
            let began = false;
            const duration = data.duration || 1;

            recorder.start(400);
            export_source.start(audio_at);

            await new Promise((resolve, reject) => {
                function frame() {
                    try {
                        const t = audio_ctx.currentTime - start_ctx;
                        if (t < INTRO_SECONDS) {
                            escene.set_intro_progress(Math.max(0, t), eint);
                            escene.draw();
                            set_export_progress((t / (INTRO_SECONDS + duration)) * 0.98);
                        } else {
                            if (!began) {
                                API.begin_song();
                                escene.synchronize_marble();
                                escene.time = 0;
                                began = true;
                            }
                            const song_time = audio_ctx.currentTime - audio_at;
                            let steps = 0;
                            while (API.get_time() < song_time * 1000 - 0.5 && steps < 300) {
                                API.update_main_world();
                                escene.synchronize_marble();
                                escene.process_hits();
                                escene.update_particles();
                                SK.update_camera(eview, escene.marble.position);
                                steps++;
                            }
                            escene.time = API.get_time();
                            escene.draw();
                            set_export_progress(Math.min(0.98, (INTRO_SECONDS + Math.max(0, song_time)) / (INTRO_SECONDS + duration)));
                            if (song_time >= duration + 0.55) {
                                resolve();
                                return;
                            }
                        }
                        requestAnimationFrame(frame);
                    } catch (err) {
                        reject(err);
                    }
                }
                requestAnimationFrame(frame);
            });

            try { export_source.stop(); } catch (err) { /* 忽略 */ }
            try { export_source.disconnect(); } catch (err) { /* 忽略 */ }
            if (recorder.state !== 'inactive') recorder.stop();
            await stopped;
            video_stream.getTracks().forEach((tr) => tr.stop());

            const blob = new Blob(chunks, {type: mime.split(';')[0] || 'video/webm'});
            if (!blob.size) throw new Error('录制结果为空，请重试。');
            dest.stream.getTracks().forEach((tr) => tr.stop());
            await upload_export(blob, mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm', ratio, false);
        } catch (err) {
            console.error(err);
            set_export_status(err.message || '导出失败', true);
        } finally {
            if (recorder && recorder.state !== 'inactive') {
                try { recorder.stop(); } catch (err) { /* 忽略 */ }
            }
            if (export_source) {
                try { export_source.stop(); } catch (err) { /* 忽略 */ }
                try { export_source.disconnect(); } catch (err) { /* 忽略 */ }
            }
            if (export_canvas && export_canvas.parentNode) export_canvas.parentNode.removeChild(export_canvas);
            ratio_grid.querySelectorAll('button').forEach((b) => b.disabled = false);
            exporting = false;
            if (mode !== 'expired') {
                mode = 'idle';
                scene.reset();
                scene.draw();
                update_progress();
                set_play_ui();
            }
        }
    }

    function open_export() {
        if (!data || mode === 'expired') return;
        if (mode === 'intro' || mode === 'playing') {
            paused_from = mode;
            audio_ctx.suspend();
            mode = 'paused';
            set_play_ui();
        }
        export_url = '';
        export_name = '';
        export_download.classList.add('hidden');
        export_status.textContent = '';
        export_status.classList.remove('error');
        export_progress.classList.add('hidden');
        export_progress_fill.style.width = '0%';
        modal.classList.remove('hidden');
    }

    function close_export_modal() {
        if (exporting) return;
        modal.classList.add('hidden');
    }

    function update_expiry() {
        if (!data || data.permanent) return;
        if (!expires_at) {
            expiry_label.textContent = '链接状态';
            expiry_value.textContent = '10 分钟内有效';
            return;
        }
        const remain = expires_at - Date.now();
        if (remain <= 0) {
            expiry_value.textContent = '00:00';
            show_expired('内容已超过 10 分钟，已自动删除。');
            return;
        }
        expiry_label.textContent = '链接剩余';
        expiry_value.textContent = fmt_countdown(remain);
        expiry_value.classList.toggle('low', remain <= 60_000);
    }

    function start_expiry_clock() {
        if (!data || data.permanent) return;
        clearInterval(expiry_timer);
        update_expiry();
        expiry_timer = setInterval(update_expiry, 1000);
    }

    async function extend_content() {
        if (!data || data.permanent || extend_busy) return;
        if (mode === 'expired') {
            toast('链接已过期，无法延长。');
            return;
        }
        extend_busy = true;
        extend_button.disabled = true;
        extend_button.textContent = '延长中…';
        try {
            const resp = await fetch(`/api/tracks/${encodeURIComponent(id)}/extend`, {method: 'POST'});
            if (!resp.ok) {
                show_expired('链接已过期，无法延长。');
                return;
            }
            const result = await resp.json();
            const ttl = Number(result.ttlSeconds);
            expires_at = Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : 10 * 60 * 1000);
            data.expiresAt = Number(result.expiresAt) || expires_at;
            expiry_value.classList.remove('low');
            update_expiry();
            toast('已延长 10 分钟。');
        } catch (err) {
            console.error(err);
            toast('延长失败，请稍后重试。');
            update_expiry();
        } finally {
            extend_busy = false;
            if (mode !== 'expired') extend_button.disabled = false;
            extend_button.textContent = '延长 10 分钟';
        }
    }

    async function init() {
        seed = hash_id(id || 'music-marbles');
        if (!id) {
            show_expired('这条链接里没有轨道编号。');
            return;
        }

        try {
            const resp = await fetch(`/api/tracks/${encodeURIComponent(id)}`);
            if (resp.status === 404) {
                show_expired('链接不存在，或内容已超过 10 分钟被删除。');
                return;
            }
            if (!resp.ok) throw new Error('请求失败');
            data = await resp.json();
            title_el.textContent = data.title || '音乐弹珠';
            document.title = `${data.title || '音乐弹珠'} — 音乐弹珠`;
            track = merge_notes(data.notes || []);
            if (!track.length) throw new Error('这条轨道没有音符');
            prepare_engine();
            await SK.load_images();
            make_view();
            scene = new SK.Scene(track, view, seed);
            scene.reset();
            scene.draw();
            update_progress();

            if (data.permanent) {
                expiry_label.textContent = '内置曲目';
                expiry_value.textContent = '永久保留';
                extend_button.classList.add('hidden');
            } else {
                const remaining = Number(data.remainingSeconds);
                if (Number.isFinite(remaining) && remaining >= 0) {
                    expires_at = Date.now() + remaining * 1000;
                } else {
                    expires_at = Number(data.expiresAt) || 0;
                }
                extend_button.disabled = false;
                start_expiry_clock();
                if (mode === 'expired') return;
            }

            await load_audio();
            if (mode === 'expired') return;
            download_button.disabled = false;
            mode = 'idle';
            set_play_ui();
        } catch (err) {
            console.error(err);
            if (mode !== 'expired') {
                show_error('轨道加载失败，请稍后重试。');
            }
        }
    }

    play_button.addEventListener('click', () => {
        if (mode === 'finished' || mode === 'idle' || mode === 'paused') {
            if (mode === 'paused') toggle_pause();
            else start_run();
        }
    });
    toggle_button.addEventListener('click', toggle_pause);
    restart_button.addEventListener('click', restart_run);
    mute_button.addEventListener('click', toggle_mute);
    extend_button.addEventListener('click', extend_content);
    share_button.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(location.href);
            toast('链接已复制。');
        } catch (err) {
            prompt('复制这条链接', location.href);
        }
    });
    download_button.addEventListener('click', open_export);
    close_export.addEventListener('click', close_export_modal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) close_export_modal();
    });
    ratio_grid.addEventListener('click', (e) => {
        const button = e.target.closest('.ratio-card');
        if (!button || button.disabled) return;
        export_ratio(button.dataset.ratio);
    });
    export_download.addEventListener('click', () => {
        if (!export_url) return;
        const a = document.createElement('a');
        a.href = export_url;
        a.download = export_name || 'music-marbles.mp4';
        document.body.appendChild(a);
        a.click();
        a.remove();
    });
    window.addEventListener('resize', resize);
    window.addEventListener('beforeunload', () => {
        clearInterval(expiry_timer);
        stop_source();
        if (audio_ctx) audio_ctx.close();
    });

    init();
})();
