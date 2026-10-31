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
    const audio_help = document.getElementById('audio-help');
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
    const export_preview_wrap = document.getElementById('export-preview-wrap');
    const export_preview = document.getElementById('export-preview');
    const export_download = document.getElementById('export-download');
    const export_foot = document.getElementById('export-foot');
    const toast_el = document.getElementById('toast');

    const page_query = new URLSearchParams(location.search);
    const query_id = page_query.get('id');
    const walls_query = page_query.get('walls');
    const path_id = location.pathname.includes('/watch/')
        ? location.pathname.split('/').filter(Boolean).pop()
        : '';
    const id = decodeURIComponent(query_id || path_id || '');
    let walls_enabled = walls_query !== '0';
    const STATIC_HOST = !!window.MUSIC_MARBLES_STATIC;
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
    // AAC is preferred for the downloaded file: QuickTime and Safari play
    // AAC-in-MP4 but often play Opus-in-MP4 as silent video. Chrome only
    // exposes AAC encoding on platforms with a system encoder, so Opus stays
    // as the fallback.
    const OFFLINE_AUDIO_AAC = {
        codec: 'mp4a.40.2',
        muxer_codec: 'aac',
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 160_000
    };
    const OFFLINE_AUDIO_OPUS = {
        codec: 'opus',
        muxer_codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 160_000
    };
    const OFFLINE_READY = typeof window.VideoEncoder === 'function'
        && typeof window.VideoFrame === 'function'
        && window.Mp4Muxer
        && typeof window.Mp4Muxer.Muxer === 'function';
    const OFFLINE_AUDIO_READY = typeof window.AudioEncoder === 'function'
        && typeof window.AudioData === 'function';

    let data = null;
    let track = [];
    let view = null;
    let scene = null;
    let audio_ctx = null;
    let audio_buffer = null;
    let output_gain = null;
    let output_analyser = null;
    let source = null;
    let fallback_audio = null;
    let fallback_timer = 0;
    let using_fallback = false;
    let intro_skipped = false;
    let audio_prompt_el = null;
    let audio_check_timer = 0;
    let mode = 'loading';
    let paused_from = null;
    let clock_origin = 0;
    let clock_offset = 0;
    let clock_running = false;
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
    let static_mode = STATIC_HOST;

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

    function elapsed_seconds() {
        if (mode === 'finished') return total_seconds();
        if (mode === 'paused') return Math.min(total_seconds(), Math.max(0, clock_offset));
        if (!clock_running) return 0;
        const elapsed = clock_offset + (performance.now() - clock_origin) / 1000;
        return Math.min(total_seconds(), Math.max(0, elapsed));
    }

    function start_clock(offset) {
        clock_offset = Math.max(0, offset || 0);
        clock_origin = performance.now();
        clock_running = true;
    }

    function pause_clock() {
        clock_offset = elapsed_seconds();
        clock_running = false;
    }

    function resume_clock() {
        clock_origin = performance.now();
        clock_running = true;
    }

    function stop_clock() {
        clock_running = false;
        clock_offset = 0;
    }

    function current_visual_seconds() {
        return elapsed_seconds();
    }

    function update_progress() {
        const elapsed = current_visual_seconds();
        const total = total_seconds();
        const shown_elapsed = intro_skipped ? Math.max(0, elapsed - INTRO_SECONDS) : elapsed;
        const shown_total = intro_skipped ? Math.max(0, total - INTRO_SECONDS) : total;
        const pct = shown_total > 0 ? Math.min(1, Math.max(0, shown_elapsed / shown_total)) : 0;
        progress_fill.style.width = `${pct * 100}%`;
        time_label.textContent = `${fmt(shown_elapsed)} / ${fmt(shown_total)}`;
    }

    function set_play_ui() {
        const is_playing = mode === 'playing' || mode === 'intro';
        toggle_icon.dataset.state = is_playing ? 'pause' : 'play';
        toggle_button.title = is_playing ? '暂停' : '播放';
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
        stop_audio_watchdog();
        dismiss_audio_prompt();
        stop_clock();
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

    async function load_static_track(track_id) {
        const manifest_url = new URL('builtins/manifest.json', document.baseURI).href;
        const manifest_resp = await fetch(manifest_url, {cache: 'no-store'});
        if (!manifest_resp.ok) throw new Error('静态清单不可用');
        const manifest = await manifest_resp.json();
        const item = (manifest.tracks || []).find((t) => t.id === track_id);
        if (!item) return null;

        const notes_url = new URL(String(item.notes || '').replace(/^\//, ''), document.baseURI).href;
        const audio_url = new URL(String(item.audio || '').replace(/^\//, ''), document.baseURI).href;
        const notes_resp = await fetch(notes_url, {cache: 'no-store'});
        if (!notes_resp.ok) throw new Error('音符读取失败');
        const notes = await notes_resp.json();

        return {
            id: track_id,
            title: item.title,
            subtitle: item.subtitle,
            duration: item.duration,
            audioUrl: audio_url,
            notes: notes.notes,
            settings: item.settings && typeof item.settings === 'object' ? item.settings : null,
            builtin: true,
            permanent: true,
            expiresAt: null
        };
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

    function scene_options() {
        return {walls: walls_enabled};
    }

    function make_view() {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const rect = stage.getBoundingClientRect();
        const width = Math.max(320, Math.round(rect.width || stage.clientWidth || window.innerWidth));
        const height = Math.max(240, Math.round(rect.height || stage.clientHeight || window.innerHeight));
        view = new SK.View(stage, width, height, dpr);
        view.set_scale(SK.fit_scale_for_track(view.width, view.height, 820));
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

    function stop_fallback_timer() {
        if (fallback_timer) {
            clearTimeout(fallback_timer);
            fallback_timer = 0;
        }
    }

    function stop_source() {
        stop_fallback_timer();
        if (fallback_audio) {
            fallback_audio.pause();
            using_fallback = false;
        }
        if (!source) return;
        source.onended = null;
        try { source.stop(); } catch (err) { /* 已经停止 */ }
        try { source.disconnect(); } catch (err) { /* 忽略 */ }
        source = null;
    }

    // When WebAudio stays suspended (strict autoplay policy, no output device,
    // iOS interruption) a plain <audio> element still goes through the media
    // pipeline and actually makes sound. It follows the same visual clock:
    // play muted through the 1 s intro, then restart at song time zero and
    // unmute. This is the safety net for "视频在动但没有声音".
    function play_element_from(elapsed) {
        if (!fallback_audio) return false;
        const t = Math.max(0, Number(elapsed) || 0);
        const song_offset = t - INTRO_SECONDS;
        const duration = Number(fallback_audio.duration) || (audio_buffer && audio_buffer.duration) || 0;
        if (duration && song_offset >= duration) return false;

        stop_source();
        using_fallback = true;
        fallback_audio.muted = true;
        try { fallback_audio.currentTime = 0; } catch (err) { /* 元数据还没到 */ }
        const started = fallback_audio.play();
        if (started && typeof started.catch === 'function') started.catch(() => {});

        if (t < INTRO_SECONDS) {
            fallback_timer = setTimeout(() => {
                fallback_timer = 0;
                if (!using_fallback || (mode !== 'intro' && mode !== 'playing')) return;
                try { fallback_audio.currentTime = 0; } catch (err) { /* 忽略 */ }
                fallback_audio.muted = muted;
                const again = fallback_audio.play();
                if (again && typeof again.catch === 'function') again.catch(() => {});
            }, Math.max(0, (INTRO_SECONDS - t) * 1000));
        } else {
            try { fallback_audio.currentTime = Math.max(0, song_offset); } catch (err) { /* 忽略 */ }
            fallback_audio.muted = muted;
        }
        return true;
    }

    function prime_fallback_audio() {
        if (!fallback_audio || using_fallback || !fallback_audio.paused) return;
        const was_muted = fallback_audio.muted;
        fallback_audio.muted = true;
        let started;
        try { started = fallback_audio.play(); } catch (err) { return; }
        if (started && typeof started.then === 'function') {
            started.then(() => {
                if (using_fallback) return;
                fallback_audio.pause();
                try { fallback_audio.currentTime = 0; } catch (err) { /* 忽略 */ }
                fallback_audio.muted = was_muted;
            }).catch(() => { fallback_audio.muted = was_muted; });
        }
    }

    function stop_audio_watchdog() {
        if (audio_check_timer) {
            clearTimeout(audio_check_timer);
            audio_check_timer = 0;
        }
    }

    function dismiss_audio_prompt() {
        if (audio_prompt_el) {
            audio_prompt_el.remove();
            audio_prompt_el = null;
        }
    }

    // Last-resort escape hatch. If WebAudio is running but delivering zeros,
    // or the media element was left paused/muted by an autoplay policy, give
    // the user a button that starts the native media path inside a fresh click.
    function show_audio_prompt() {
        if (audio_prompt_el || mode === 'paused' || mode === 'finished' || mode === 'expired') return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'audio-prompt';
        btn.textContent = '没有声音？点这里切换播放';
        btn.title = '如果仍无声，请检查系统音量、浏览器标签页是否静音；iPhone 请关闭静音键。';
        btn.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:100000;'
            + 'border:0;border-radius:999px;padding:13px 20px;background:#111;color:#fff;'
            + 'font:600 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
            + 'box-shadow:0 12px 34px rgba(0,0,0,.35);cursor:pointer;';
        btn.addEventListener('click', () => {
            dismiss_audio_prompt();
            if (audio_ctx && audio_ctx.state !== 'running') {
                try {
                    const resumed = audio_ctx.resume();
                    if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
                } catch (err) { /* 忽略 */ }
            }
            play_element_from(elapsed_seconds());
            start_audio_watchdog();
        });
        document.body.appendChild(btn);
        audio_prompt_el = btn;
        setTimeout(() => {
            if (audio_prompt_el === btn) dismiss_audio_prompt();
        }, 15000);
    }

    function start_audio_watchdog() {
        stop_audio_watchdog();
        audio_check_timer = setTimeout(() => {
            audio_check_timer = 0;
            if (mode !== 'intro' && mode !== 'playing') return;
            if (muted) return;
            if (using_fallback) {
                // The element is the last audio path. If the policy paused or
                // muted it, only a new click can recover.
                if (!fallback_audio || fallback_audio.paused || fallback_audio.muted) {
                    show_audio_prompt();
                }
                return;
            }
            if (!audio_ctx || audio_ctx.state !== 'running' || !output_analyser) {
                show_audio_prompt();
                return;
            }
            const buf = new Float32Array(output_analyser.fftSize);
            output_analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            if (Math.sqrt(sum / buf.length) < 0.001) {
                show_audio_prompt();
            }
        }, 2200);
    }

    // The watch timeline is driven by performance.now(), not by the audio
    // clock. Some browsers keep an AudioContext suspended (autoplay policy,
    // missing output device, iOS interruption), and previously that froze the
    // whole scene. Audio now follows the visual clock; if it cannot start, the
    // track still plays silently.
    function play_audio_from(elapsed) {
        if (!audio_ctx || !audio_buffer) return;
        const t = Math.max(0, Number(elapsed) || 0);
        const song_offset = t - INTRO_SECONDS;
        if (song_offset >= audio_buffer.duration) return;

        stop_source();
        source = audio_ctx.createBufferSource();
        source.buffer = audio_buffer;
        source.connect(output_gain);
        source.onended = () => {
            if (mode === 'playing') finish_run();
        };

        if (t < INTRO_SECONDS) {
            source.start(audio_ctx.currentTime + (INTRO_SECONDS - t));
        } else {
            source.start(audio_ctx.currentTime, Math.max(0, song_offset));
        }
    }

    // Some browsers (Firefox with a strict autoplay policy, iOS after an
    // interruption) leave resume() pending forever. Never await it without a
    // deadline, or export gets stuck on its first status line.
    function resume_audio_with_timeout(timeout_ms) {
        if (!audio_ctx) return Promise.resolve(false);
        if (audio_ctx.state === 'running') return Promise.resolve(true);
        let resumed;
        try { resumed = audio_ctx.resume(); } catch (err) { return Promise.resolve(false); }
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                resolve(audio_ctx.state === 'running');
            };
            setTimeout(finish, timeout_ms || 1500);
            if (resumed && typeof resumed.then === 'function') {
                resumed.then(finish, finish);
            } else {
                finish();
            }
        });
    }

    function sync_audio_to_visual() {
        if (!audio_ctx || !audio_buffer) {
            play_element_from(elapsed_seconds());
            return;
        }
        if (audio_ctx.state === 'running') {
            play_audio_from(elapsed_seconds());
            return;
        }
        // A previous attempt already gave up on WebAudio. Do not wait another
        // 1.5 s on every resume; keep using the element that is making sound.
        if (using_fallback) {
            play_element_from(elapsed_seconds());
            return;
        }
        // Short deadline: the fallback element needs to start during the 1 s
        // muted intro, otherwise it would join the song half a second late.
        resume_audio_with_timeout(400).then((ok) => {
            if (mode !== 'intro' && mode !== 'playing') return;
            if (ok && audio_ctx.state === 'running') {
                play_audio_from(elapsed_seconds());
            } else {
                play_element_from(elapsed_seconds());
            }
        });
    }

    function start_run() {
        if (mode === 'expired') return;
        if (!audio_buffer) {
            toast('音频还在加载。');
            return;
        }
        if (exporting) return;
        stop_audio_watchdog();
        dismiss_audio_prompt();
        stop_source();
        API.reset_playback();
        scene.reset();
        scene.draw();

        paused_from = null;
        const fallback_now = fallback_audio && (!audio_ctx || audio_ctx.state !== 'running');
        if (fallback_now) {
            // Safari will not reliably unmute a media element after the click
            // gesture has ended. Start it audibly inside the gesture and skip
            // the silent 1 s intro on this path, so picture and music still
            // begin together instead of risking a completely silent track.
            stop_source();
            using_fallback = true;
            intro_skipped = true;
            fallback_audio.muted = muted;
            fallback_audio.volume = 1;
            try { fallback_audio.currentTime = 0; } catch (err) { /* 元数据还没到 */ }
            const started = fallback_audio.play();
            if (started && typeof started.catch === 'function') {
                started.catch(() => show_audio_prompt());
            }
            API.begin_song();
            scene.synchronize_marble();
            scene.time = 0;
            // The intro normally eases the camera onto the marble. Without it,
            // snap once so the first skipped-intro frame is not off-centre.
            SK.update_camera(view, scene.marble.position, true);
            scene.draw();
            start_clock(INTRO_SECONDS);
            mode = 'playing';
        } else {
            intro_skipped = false;
            start_clock(0);
            mode = 'intro';
            sync_audio_to_visual();
        }
        update_progress();
        set_play_ui();
        start_audio_watchdog();
        if (!raf) raf = requestAnimationFrame(loop);
    }

    function finish_run() {
        if (mode === 'finished' || mode === 'expired') return;
        clock_running = false;
        clock_offset = total_seconds();
        mode = 'finished';
        stop_source();
        stop_audio_watchdog();
        dismiss_audio_prompt();
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
            resume_clock();
            mode = paused_from || 'playing';
            paused_from = null;
            if (audio_ctx && audio_ctx.state === 'running') {
                play_audio_from(elapsed_seconds());
            } else if (fallback_audio) {
                play_element_from(elapsed_seconds());
            } else {
                sync_audio_to_visual();
            }
            start_audio_watchdog();
            if (!raf) raf = requestAnimationFrame(loop);
            set_play_ui();
            return;
        }
        if (mode === 'intro' || mode === 'playing') {
            paused_from = mode;
            pause_clock();
            stop_audio_watchdog();
            dismiss_audio_prompt();
            stop_fallback_timer();
            if (fallback_audio) fallback_audio.pause();
            if (audio_ctx && audio_ctx.state === 'running') {
                const paused = audio_ctx.suspend();
                if (paused && typeof paused.catch === 'function') paused.catch(() => {});
            }
            mode = 'paused';
            set_play_ui();
        }
    }

    function restart_run() {
        if (exporting || mode === 'expired' || mode === 'loading') return;
        if (audio_ctx && mode === 'paused' && audio_ctx.state !== 'running') {
            const resumed = audio_ctx.resume();
            if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
        }
        start_run();
    }

    function toggle_mute() {
        if ((!audio_ctx && !fallback_audio) || mode === 'expired') return;
        muted = !muted;
        if (output_gain && audio_ctx) {
            output_gain.gain.setTargetAtTime(muted ? 0 : 1, audio_ctx.currentTime, 0.02);
        }
        if (fallback_audio && using_fallback) {
            // 开场 1 秒画面里不应该漏出歌曲开头。
            fallback_audio.muted = muted || elapsed_seconds() < INTRO_SECONDS;
        }
        sound_icon.classList.toggle('muted', muted);
        mute_button.title = muted ? '取消静音' : '静音';
    }

    function loop() {
        raf = 0;
        if (mode === 'expired') return;
        if (mode === 'intro') {
            const t = elapsed_seconds();
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
            const song_time = Math.max(0, elapsed_seconds() - INTRO_SECONDS);
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

    function unlock_audio() {
        if (!audio_ctx && !fallback_audio) return;
        if (audio_ctx && audio_ctx.state === 'running') {
            document.removeEventListener('pointerdown', unlock_audio, true);
            document.removeEventListener('keydown', unlock_audio, true);
            return;
        }
        if (audio_ctx) {
            try {
                const resumed = audio_ctx.resume();
                if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
            } catch (err) { /* 下一次手势再试 */ }
        }
        prime_fallback_audio();
    }

    async function load_audio() {
        audio_ctx = new (window.AudioContext || window.webkitAudioContext)();
        output_gain = audio_ctx.createGain();
        output_gain.gain.value = muted ? 0 : 1;
        output_analyser = audio_ctx.createAnalyser();
        output_analyser.fftSize = 1024;
        output_gain.connect(output_analyser);
        output_analyser.connect(audio_ctx.destination);
        // A suspended context can recover after the first tap/click. When it
        // does, join the run at the current visual position. If the fallback
        // element already took over, do not double-play.
        audio_ctx.addEventListener('statechange', () => {
            if (using_fallback) return;
            if (audio_ctx.state === 'running' && !source && (mode === 'intro' || mode === 'playing')) {
                play_audio_from(elapsed_seconds());
            }
        });
        document.addEventListener('pointerdown', unlock_audio, true);
        document.addEventListener('keydown', unlock_audio, true);

        const resp = await fetch(data.audioUrl, {cache: 'force-cache'});
        if (!resp.ok) throw new Error('音频读取失败');
        const arr = await resp.arrayBuffer();
        audio_buffer = await audio_ctx.decodeAudioData(arr);

        fallback_audio = new Audio(data.audioUrl);
        fallback_audio.preload = 'auto';
        fallback_audio.muted = true;
        fallback_audio.setAttribute('playsinline', '');
        fallback_audio.setAttribute('webkit-playsinline', '');
        // Safari and iOS are much happier with a media element that is in the
        // document. Keep it tiny and transparent, never display:none.
        fallback_audio.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;opacity:0.01;pointer-events:none;';
        document.body.appendChild(fallback_audio);
        fallback_audio.addEventListener('ended', () => {
            if (mode === 'playing') finish_run();
        });
        await new Promise((resolve) => {
            if (fallback_audio.readyState >= 1) {
                resolve();
                return;
            }
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                resolve();
            };
            fallback_audio.addEventListener('loadedmetadata', finish, {once: true});
            fallback_audio.addEventListener('error', finish, {once: true});
            setTimeout(finish, 4000);
        });
    }

    function set_export_status(text, error) {
        export_status.textContent = text || '';
        export_status.classList.toggle('error', !!error);
    }

    function set_export_progress(pct) {
        export_progress.classList.remove('hidden');
        export_progress_fill.style.width = `${Math.min(100, Math.max(0, pct * 100))}%`;
    }

    function set_export_preview(url) {
        if (!export_preview || !export_preview_wrap) return;
        if (!url) {
            export_preview.pause();
            export_preview.removeAttribute('src');
            export_preview.load();
            export_preview_wrap.classList.add('hidden');
            return;
        }
        export_preview.src = url;
        export_preview.load();
        export_preview_wrap.classList.remove('hidden');
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

    // Hardware H.264 at 1080p is several times faster than real time. Software
    // H.264 is often SLOWER than real time once canvas readback and muxing are
    // counted, which made "fast export" take minutes on long tracks. Prefer
    // hardware; report software separately so the caller can decide.
    async function pick_offline_codec(width, height, allow_software) {
        if (!OFFLINE_READY) return null;
        const base = {
            width,
            height,
            bitrate: OFFLINE_BITRATE,
            framerate: OFFLINE_FPS
        };
        for (const codec of OFFLINE_CODECS) {
            try {
                const support = await VideoEncoder.isConfigSupported({
                    ...base,
                    codec,
                    hardwareAcceleration: 'prefer-hardware'
                });
                if (support && support.supported) return {codec, hardware: true};
            } catch (err) { /* 尝试下一个编码器 */ }
        }
        if (!allow_software) return null;
        for (const codec of OFFLINE_CODECS) {
            try {
                const support = await VideoEncoder.isConfigSupported({...base, codec});
                if (support && support.supported) return {codec, hardware: false};
            } catch (err) { /* 尝试下一个编码器 */ }
        }
        return null;
    }

    // Static hosting has no server to mux the original track back in, so the
    // browser has to encode audio as well. Try AAC first for external players,
    // then Opus for browsers that only ship an Opus encoder.
    async function pick_offline_audio() {
        if (!OFFLINE_AUDIO_READY) return null;
        const probe = document.createElement('video');
        for (const config of [OFFLINE_AUDIO_AAC, OFFLINE_AUDIO_OPUS]) {
            try {
                if (config.muxer_codec === 'opus') {
                    const can_play = probe.canPlayType('video/mp4; codecs="avc1.640028,opus"');
                    if (!can_play) continue;
                }
                const {muxer_codec, ...encoder_config} = config;
                const support = await AudioEncoder.isConfigSupported(encoder_config);
                if (support && support.supported) return {...config};
            } catch (err) { /* 尝试下一种音频编码 */ }
        }
        return null;
    }

    async function encode_export_audio(muxer, config, duration) {
        if (!audio_buffer) throw new Error('音频还没有加载');
        const music = Math.max(0, Math.min(duration, audio_buffer.duration));
        const channels = config.numberOfChannels;
        const rate = config.sampleRate;
        const frames = Math.max(1, Math.ceil((INTRO_SECONDS + music) * rate));

        // Resample and prepend the same 1 s silent intro the scene uses, so
        // the muxed audio lines up with frame zero.
        const offline = new OfflineAudioContext(channels, frames, rate);
        const src = offline.createBufferSource();
        src.buffer = audio_buffer;
        src.connect(offline.destination);
        src.start(INTRO_SECONDS, 0, music);
        const rendered = await offline.startRendering();

        let failure = null;
        const encoder = new AudioEncoder({
            output: (chunk, meta) => {
                if (failure) return;
                try {
                    muxer.addAudioChunk(chunk, meta);
                } catch (err) {
                    failure = err;
                }
            },
            error: (err) => { failure = err; }
        });
        try {
            const {muxer_codec, ...encoder_config} = config;
            encoder.configure(encoder_config);
            const left = rendered.getChannelData(0);
            const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
            const block = 4800; // 100 ms
            for (let offset = 0; offset < rendered.length; offset += block) {
                if (failure) throw failure;
                const n = Math.min(block, rendered.length - offset);
                const planar = new Float32Array(n * channels);
                planar.set(left.subarray(offset, offset + n), 0);
                if (channels > 1) planar.set(right.subarray(offset, offset + n), n);
                const frame = new AudioData({
                    format: 'f32-planar',
                    sampleRate: rate,
                    numberOfFrames: n,
                    numberOfChannels: channels,
                    timestamp: Math.round(offset * 1_000_000 / rate),
                    data: planar
                });
                encoder.encode(frame);
                frame.close();
            }
            await encoder.flush();
            if (failure) throw failure;
        } finally {
            if (encoder.state !== 'closed') {
                try { encoder.close(); } catch (err) { /* 忽略 */ }
            }
        }
    }

    async function render_offline(ratio, dims, codec, audio_config, hardware) {
        const [w, h] = dims;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;

        prepare_engine();
        const eview = new SK.View(canvas, w, h, 1);
        eview.set_scale(SK.fit_scale_for_track(w, h, 820));
        const escene = new SK.Scene(track, eview, seed, scene_options());
        escene.reset();

        const duration = Math.max(1, Number(data.duration) || 1);
        const total = INTRO_SECONDS + duration + EXPORT_TAIL_SECONDS;
        const frames = Math.max(1, Math.ceil(total * OFFLINE_FPS));
        const target = new window.Mp4Muxer.ArrayBufferTarget();
        const muxer_options = {
            target,
            video: {codec: 'avc', width: w, height: h, frameRate: OFFLINE_FPS},
            fastStart: false
        };
        if (audio_config) {
            muxer_options.audio = {
                codec: audio_config.muxer_codec,
                sampleRate: audio_config.sampleRate,
                numberOfChannels: audio_config.numberOfChannels
            };
        }
        const muxer = new window.Mp4Muxer.Muxer(muxer_options);

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
            const encoder_config = {
                codec,
                width: w,
                height: h,
                bitrate: OFFLINE_BITRATE,
                framerate: OFFLINE_FPS
            };
            if (hardware) encoder_config.hardwareAcceleration = 'prefer-hardware';
            encoder.configure(encoder_config);
        } catch (err) {
            throw new Error(`视频编码器启动失败：${err.message || err}`);
        }

        if (audio_config) {
            await encode_export_audio(muxer, audio_config, duration);
            if (failure) throw failure;
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

                const stamp = {
                    timestamp: Math.round(i * 1_000_000 / OFFLINE_FPS),
                    duration: Math.round(1_000_000 / OFFLINE_FPS)
                };
                const frame = new VideoFrame(canvas, stamp);
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

        if (static_mode) {
            if (export_url && export_url.startsWith('blob:')) URL.revokeObjectURL(export_url);
            export_url = URL.createObjectURL(blob);
            export_name = `${data.title || 'music-marbles'}-${ratio}.${ext}`;
            export_download.textContent = `下载 ${ext.toLowerCase() === 'mp4' ? 'MP4' : 'WEBM'}`;
            set_export_preview(export_url);
            set_export_progress(1);
            set_export_status('演示版已在浏览器内生成，点击下方按钮下载。');
            export_download.classList.remove('hidden');
            return;
        }

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
        set_export_preview(export_url);
        set_export_progress(1);
        set_export_status('已生成，MP4 可在 10 分钟内下载。');
        export_download.classList.remove('hidden');
    }

    function choose_mime() {
        if (typeof MediaRecorder === 'undefined') return '';
        const candidates = static_mode
            ? [
                'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
                'video/mp4',
                'video/webm;codecs=vp9,opus',
                'video/webm;codecs=vp8,opus',
                'video/webm'
            ]
            : [
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
        set_export_preview('');
        ratio_grid.querySelectorAll('button').forEach((b) => b.disabled = true);
        stop_source();
        stop_audio_watchdog();
        dismiss_audio_prompt();
        stop_clock();
        mode = 'exporting';
        set_play_ui();
        set_export_status(`正在准备 ${ratio.replace('x', ':')}…`);
        set_export_progress(0);

        let export_canvas = null;
        let recorder = null;
        let export_source = null;
        try {
            const codec_info = await pick_offline_codec(dims[0], dims[1], true);
            const audio_config = static_mode && codec_info ? await pick_offline_audio() : null;
            // If the browser can only encode Opus but MediaRecorder can record
            // AAC, prefer the recorder. QuickTime and Safari play AAC but treat
            // Opus-in-MP4 as silent video. This is the compatibility path for
            // browsers without an AAC AudioEncoder.
            const prefer_recorder_audio = static_mode
                && !!audio_config
                && audio_config.muxer_codec === 'opus'
                && mime.indexOf('mp4a') >= 0;
            const offline_ready = !!codec_info && (!static_mode || !!audio_config) && !prefer_recorder_audio;
            if (offline_ready) {
                let blob = null;
                try {
                    set_export_status(`正在离线渲染 ${ratio.replace('x', ':')} · ${codec_info.hardware ? '硬件加速' : '软件编码'}…`);
                    set_export_progress(0);
                    blob = await render_offline(ratio, dims, codec_info.codec, audio_config, codec_info.hardware);
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
            if (audio_ctx.state !== 'running') {
                await resume_audio_with_timeout(1500);
            }
            if (audio_ctx.state !== 'running') {
                throw new Error('浏览器阻止了音频播放，请点击页面后重新导出。');
            }
            set_export_status(`正在实时录制 ${ratio.replace('x', ':')}${prefer_recorder_audio ? ' · AAC 音频兼容模式' : ''} · 请保持页面在前台…`);
            set_export_progress(0);

            const [w, h] = dims;
            export_canvas = document.createElement('canvas');
            export_canvas.width = w;
            export_canvas.height = h;
            // Keep the canvas on-screen (a 2 px dot under the modal). An
            // off-screen canvas is not composited in some browsers, so
            // captureStream produced audio-only recordings.
            export_canvas.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;z-index:29;pointer-events:none;';
            document.body.appendChild(export_canvas);

            prepare_engine();
            const eview = new SK.View(export_canvas, w, h, 1);
            eview.set_scale(SK.fit_scale_for_track(w, h, 820));
            const escene = new SK.Scene(track, eview, seed, scene_options());
            escene.reset();

            const dest = audio_ctx.createMediaStreamDestination();
            export_source = audio_ctx.createBufferSource();
            export_source.buffer = audio_buffer;
            const egain = audio_ctx.createGain();
            egain.gain.value = 1;
            export_source.connect(egain);
            egain.connect(dest);

            // Manual frame capture where supported: on-screen auto-capture can
            // be throttled to a few frames per second. Safari may not expose
            // requestFrame(), so fall back to normal 30 fps auto-capture there.
            const manual_capture = typeof CanvasCaptureMediaStreamTrack !== 'undefined'
                && typeof CanvasCaptureMediaStreamTrack.prototype.requestFrame === 'function';
            const video_stream = export_canvas.captureStream(manual_capture ? 0 : 30);
            const video_track = video_stream.getVideoTracks()[0];
            const force_frame = manual_capture
                ? () => { try { video_track.requestFrame(); } catch (err) { /* 忽略 */ } }
                : null;
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
            // isTypeSupported() is a hint; the recorder may fall back to a
            // different container. Name the file after what was actually made.
            const recorded_mime = recorder.mimeType || mime;
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
                            if (force_frame) force_frame();
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
                            if (force_frame) force_frame();
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

            const blob = new Blob(chunks, {type: recorded_mime.split(';')[0] || 'video/webm'});
            if (!blob.size) throw new Error('录制结果为空，请重试。');
            dest.stream.getTracks().forEach((tr) => tr.stop());
            await upload_export(blob, recorded_mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm', ratio, false);
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
                stop_clock();
                mode = 'idle';
                intro_skipped = false;
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
            pause_clock();
            stop_audio_watchdog();
            dismiss_audio_prompt();
            if (fallback_audio) fallback_audio.pause();
            if (audio_ctx && audio_ctx.state === 'running') {
                const paused = audio_ctx.suspend();
                if (paused && typeof paused.catch === 'function') paused.catch(() => {});
            }
            mode = 'paused';
            set_play_ui();
        }
        if (export_url && export_url.startsWith('blob:')) URL.revokeObjectURL(export_url);
        set_export_preview('');
        export_url = '';
        export_name = '';
        export_download.textContent = '下载 MP4';
        export_download.classList.add('hidden');
        export_status.textContent = '';
        export_status.classList.remove('error');
        export_progress.classList.add('hidden');
        export_progress_fill.style.width = '0%';
        modal.classList.remove('hidden');
    }

    function close_export_modal() {
        if (exporting) return;
        if (export_preview) export_preview.pause();
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
        if (export_foot && static_mode) {
            export_foot.textContent = 'MP4 / WebM · 1080p · 30 fps';
        }
        seed = hash_id(id || 'music-marbles');
        if (!id) {
            show_expired('这条链接里没有轨道编号。');
            return;
        }

        try {
            if (!STATIC_HOST) {
                const resp = await fetch(`/api/tracks/${encodeURIComponent(id)}`);
                if (resp.ok) data = await resp.json();
                else if (resp.status !== 404) throw new Error('请求失败');
            }

            if (!data && (STATIC_HOST || id.startsWith('builtin-'))) {
                if (!id.startsWith('builtin-')) {
                    show_error('静态演示只有内置曲目；上传与分享链接需要本地运行 Node 服务。');
                    return;
                }
                data = await load_static_track(id);
                static_mode = true;
            }

            if (!data) {
                show_expired('链接不存在，或内容已超过 10 分钟被删除。');
                return;
            }

            title_el.textContent = data.title || '音乐弹珠';
            document.title = `${data.title || '音乐弹珠'} — 音乐弹珠`;
            if (data.settings && typeof data.settings.walls === 'boolean') {
                walls_enabled = data.settings.walls;
            }
            if (walls_query === '1') walls_enabled = true;
            else if (walls_query === '0') walls_enabled = false;
            track = merge_notes(data.notes || []);
            if (!track.length) throw new Error('这条轨道没有音符');
            prepare_engine();
            await SK.load_images();
            make_view();
            scene = new SK.Scene(track, view, seed, scene_options());
            scene.reset();
            scene.draw();
            update_progress();

            if (static_mode) {
                track_status.textContent = '静态演示 · 内置曲目';
                const foot = document.querySelector('.watch-foot span:last-child');
                if (foot) foot.textContent = 'GitHub Pages 静态演示 · 内置曲目可播放与导出';
                const modal_copy = document.querySelector('.modal-copy');
                if (modal_copy) modal_copy.textContent = '选择画面比例。支持硬件编码时会在浏览器内离线渲染，明显快于实时录制；没有硬件编码时也能完整导出。导出保留音频。';
                const modal_foot = document.querySelector('.modal-foot');
                if (modal_foot) modal_foot.textContent = '演示版直接下载 · MP4 / WebM 取决于浏览器';
            }

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
    if (audio_help) {
        audio_help.addEventListener('click', () => {
            if (mode !== 'intro' && mode !== 'playing') {
                toast('先播放，再切换音频通道。');
                return;
            }
            dismiss_audio_prompt();
            if (audio_ctx && audio_ctx.state !== 'running') {
                try {
                    const resumed = audio_ctx.resume();
                    if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
                } catch (err) { /* 忽略 */ }
            }
            play_element_from(elapsed_seconds());
            toast('已切换到媒体通道；仍无声请检查系统音量和标签页静音。');
            start_audio_watchdog();
        });
    }
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
        stop_audio_watchdog();
        dismiss_audio_prompt();
        stop_source();
        if (audio_ctx) audio_ctx.close();
    });

    init();
})();
