/* Music Marbles — landing page: audio import, transcription, share link. */
(function () {
    'use strict';

    const file_input = document.getElementById('file-input');
    const dropzone = document.getElementById('dropzone');
    const drop_title = document.getElementById('drop-title');
    const drop_sub = document.getElementById('drop-sub');
    const title_input = document.getElementById('title-input');
    const walls_toggle = document.getElementById('walls-toggle');
    const generate_button = document.getElementById('generate-button');
    const generate_label = document.getElementById('generate-label');
    const stage = document.getElementById('stage');
    const stage_label = document.getElementById('stage-label');
    const stage_pct = document.getElementById('stage-pct');
    const stage_fill = document.getElementById('stage-fill');
    const stage_hint = document.getElementById('stage-hint');
    const error_box = document.getElementById('error-box');
    const result = document.getElementById('result');
    const result_title = document.getElementById('result-title');
    const result_link = document.getElementById('result-link');
    const result_expiry = document.getElementById('result-expiry');
    const copy_link = document.getElementById('copy-link');
    const open_link = document.getElementById('open-link');
    const start_over = document.getElementById('start-over');
    const source_tabs = document.getElementById('source-tabs');
    const source_tab_upload = document.getElementById('source-tab-upload');
    const source_tab_online = document.getElementById('source-tab-online');
    const source_tab_builtin = document.getElementById('source-tab-builtin');
    const upload_view = document.getElementById('upload-view');
    const online_view = document.getElementById('online-view');
    const builtin_view = document.getElementById('builtin-view');
    const browse_online = document.getElementById('browse-online');
    const browse_builtin = document.getElementById('browse-builtin');
    const builtin_list = document.getElementById('builtin-list');
    const builtin_copy = document.getElementById('builtin-copy');
    const song_form = document.getElementById('song-search');
    const song_query = document.getElementById('song-query');
    const song_search_button = document.getElementById('song-search-button');
    const online_copy = document.getElementById('online-copy');
    const song_list = document.getElementById('song-list');
    const song_more = document.getElementById('song-more');
    const selection_row = document.getElementById('selection-row');
    const selection_kind = document.getElementById('selection-kind');
    const selection_title = document.getElementById('selection-title');
    const selection_meta = document.getElementById('selection-meta');
    const selection_clear = document.getElementById('selection-clear');
    const toast_el = document.getElementById('toast');

    const SAMPLE_RATE = 22050;
    const MAX_SECONDS = 360;
    const MAX_BARS = 1000;
    const MERGE_MS = 80;
    const STATIC_MODE = !!window.MUSIC_MARBLES_STATIC;
    const ONLINE_COPY_IDLE = '搜索 Incompetech 纯音乐库：Kevin MacLeod 的器乐作品，无需注册与代理，支持中文乐器或情绪关键词。';
    const SOURCE_PROVIDER = {
        id: 'incompetech',
        name: 'Incompetech',
        homepage: 'https://incompetech.com/music/royalty-free/music.html',
        license: 'CC BY 4.0'
    };

    let selected_file = null;
    let selected_builtin = null;
    let selected_source = null;
    let builtins = [];
    let source_results = [];
    let source_query = '';
    let source_page = 0;
    let source_searching = false;
    let source_provider = {...SOURCE_PROVIDER};
    let busy = false;
    let static_demo = STATIC_MODE;
    let preview_audio = null;
    let preview_button = null;
    let toast_timer = 0;
    let walls_on = true;
    let source_mode = 'upload';
    let auto_title = '';

    function set_walls(value) {
        walls_on = !!value;
        walls_toggle.setAttribute('aria-checked', walls_on ? 'true' : 'false');
        walls_toggle.setAttribute('aria-label', walls_on ? '关闭墙壁' : '开启墙壁');
    }

    function asset_url(path) {
        return new URL(String(path || '').replace(/^\//, ''), document.baseURI).href;
    }

    function random_seed() {
        try {
            const buf = new Uint32Array(1);
            crypto.getRandomValues(buf);
            if (buf[0]) return buf[0];
        } catch (err) { /* 回退到 Math.random */ }
        return (Math.floor(Math.random() * 0xFFFFFFFF) >>> 0) || 1;
    }

    function normalize_track(track) {
        return {
            ...track,
            sourceId: track.sourceId || 'builtin',
            source: track.source || '内置曲库',
            license: track.license || '公版作品',
            sourceUrl: track.sourceUrl || '',
            audio: asset_url(track.audio),
            notes: asset_url(track.notes)
        };
    }

    function toast(text) {
        toast_el.textContent = text;
        toast_el.classList.add('show');
        clearTimeout(toast_timer);
        toast_timer = setTimeout(() => toast_el.classList.remove('show'), 2200);
    }

    function set_stage(label, pct, hint) {
        stage.classList.remove('hidden');
        stage_label.textContent = label;
        stage_pct.textContent = `${Math.round(pct)}%`;
        stage_fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
        if (hint) stage_hint.textContent = hint;
    }

    function show_error(message) {
        error_box.textContent = message;
        error_box.classList.remove('hidden');
        stage.classList.add('hidden');
    }

    function clear_error() {
        error_box.classList.add('hidden');
        error_box.textContent = '';
    }

    function set_busy(value) {
        busy = value;
        generate_button.disabled = value;
        update_generate_label();
        file_input.disabled = value;
        title_input.disabled = value;
        walls_toggle.disabled = value;
        selection_clear.disabled = value;
        if (source_tabs) {
            source_tabs.querySelectorAll('.source-tab').forEach((tab) => {
                tab.disabled = value;
            });
        }
        builtin_list.querySelectorAll('.builtin-card').forEach((card) => {
            card.style.pointerEvents = value ? 'none' : '';
            card.style.opacity = value ? '0.55' : '';
        });
        if (song_list) {
            song_list.querySelectorAll('.song-card').forEach((card) => {
                card.style.pointerEvents = value ? 'none' : '';
                card.style.opacity = value ? '0.55' : '';
            });
        }
        if (song_query) song_query.disabled = value;
        if (song_search_button && !source_searching) song_search_button.disabled = value;
        if (song_more && !source_searching) song_more.disabled = value;
        if (browse_online) browse_online.disabled = value;
        if (browse_builtin) browse_builtin.disabled = value;
    }

    function duration_label(seconds) {
        const total = Math.max(0, Math.round(Number(seconds) || 0));
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    }

    function clock_time(ms) {
        try {
            return new Date(ms).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
        } catch (err) {
            return '';
        }
    }

    function file_label(file) {
        const mb = file.size / (1024 * 1024);
        return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
    }

    function reset_dropzone() {
        file_input.value = '';
        drop_title.textContent = '拖入音频，或点击选择';
        drop_sub.textContent = '最长 6 分钟 · 单文件 80 MB';
    }

    function show_selection(kind, title, meta) {
        selection_kind.textContent = kind;
        selection_title.textContent = title;
        selection_meta.textContent = meta;
        selection_row.classList.remove('hidden');
    }

    function hide_selection() {
        selection_row.classList.add('hidden');
    }

    function set_auto_title(value) {
        const next = String(value || '').slice(0, 80);
        if (!title_input.value.trim() || title_input.value === auto_title) {
            title_input.value = next;
            auto_title = next;
        }
    }

    function clear_auto_title() {
        if (auto_title && title_input.value === auto_title) title_input.value = '';
        auto_title = '';
    }

    function set_file(file) {
        if (!file) return;
        if (static_demo) {
            toast('静态演示只支持内置曲目；上传与网络曲库请本地运行 npm start。');
            return;
        }
        const name = file.name || 'audio';
        const ext = name.split('.').pop().toLowerCase();
        if (!['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac'].includes(ext)) {
            toast('请选择 MP3、WAV、M4A、OGG 或 FLAC 文件。');
            return;
        }
        if (file.size > 80 * 1024 * 1024) {
            toast('文件超过 80 MB。');
            return;
        }
        clear_selection(false);
        selected_file = file;
        drop_title.textContent = '文件已就绪';
        drop_sub.textContent = `${file_label(file)} · 点击可更换`;
        show_selection('音频', name, `${file_label(file)} · ${ext.toUpperCase()}`);
        set_auto_title(name.replace(/\.[^.]+$/, ''));
        update_generate_label();
        clear_error();
        result.classList.add('hidden');
    }

    function clear_selection(reset_title) {
        selected_file = null;
        selected_builtin = null;
        selected_source = null;
        reset_dropzone();
        set_selected_card(null);
        set_selected_source_card(null);
        hide_selection();
        if (reset_title !== false) clear_auto_title();
        update_generate_label();
        clear_error();
    }

    function set_selected_card(id) {
        builtin_list.querySelectorAll('.builtin-card').forEach((card) => {
            card.classList.toggle('selected', card.dataset.id === id);
            const label = card.querySelector('.builtin-select');
            if (label) label.textContent = card.dataset.id === id ? '已选' : '使用';
        });
    }

    function select_builtin(track) {
        clear_selection(false);
        selected_builtin = track;
        set_selected_card(track.id);
        show_selection(
            '内置曲目',
            track.title,
            [track.subtitle, duration_label(track.duration), track.license].filter(Boolean).join(' · ')
        );
        set_auto_title(track.title);
        update_generate_label();
        clear_error();
        result.classList.add('hidden');
    }

    function set_selected_source_card(token) {
        if (!song_list) return;
        song_list.querySelectorAll('.song-card').forEach((card) => {
            const active = !!token && card.dataset.token === token;
            card.classList.toggle('selected', active);
            const label = card.querySelector('.song-select');
            if (label) label.textContent = active ? '已选' : '使用';
        });
    }

    function update_generate_label() {
        generate_label.textContent = busy
            ? '处理中…'
            : (selected_source ? '下载并生成' : '生成分享链接');
    }

    function select_source(track) {
        clear_selection(false);
        selected_source = track;
        set_selected_source_card(track.token);
        show_selection(
            '网络曲目',
            track.title,
            [track.artist, duration_label(track.duration), track.license].filter(Boolean).join(' · ')
        );
        set_auto_title(track.title);
        update_generate_label();
        clear_error();
        result.classList.add('hidden');
    }

    function set_mode(mode) {
        if (static_demo) mode = 'builtin';
        if (!['upload', 'online', 'builtin'].includes(mode)) mode = 'upload';
        source_mode = mode;
        const tabs = [
            ['upload', source_tab_upload, upload_view],
            ['online', source_tab_online, online_view],
            ['builtin', source_tab_builtin, builtin_view]
        ];
        for (const [id, tab, view] of tabs) {
            if (!tab || !view) continue;
            const active = id === mode;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            view.classList.toggle('hidden', !active);
        }
        if (mode === 'online' && !source_results.length && !source_searching && !busy) {
            search_source(true);
        }
    }

    function apply_static_ui() {
        if (!static_demo) return;
        if (source_tabs) source_tabs.classList.add('hidden');
        set_mode('builtin');
    }

    function render_builtins(tracks) {
        builtins = (tracks || []).map(normalize_track);
        builtin_list.innerHTML = '';
        if (builtin_copy) {
            if (!builtins.length) {
                builtin_copy.textContent = '没有可用的内置曲目。';
            } else {
                const base = `${builtins.length} 首公版作品；点一首即可生成链接。内置曲目永久保留。`;
                builtin_copy.textContent = static_demo
                    ? `GitHub Pages 静态演示。${base}上传、纯音乐曲库与 10 分钟链接需本地运行 Node 服务。`
                    : base;
            }
        }
        if (!builtins.length) {
            builtin_list.innerHTML = '<p class="builtin-copy">没有可用的内置曲目。</p>';
            return;
        }
        for (const track of builtins) {
            const card = document.createElement('div');
            card.className = 'builtin-card';
            card.dataset.id = track.id;
            card.title = track.sourceUrl ? `${track.source} · ${track.sourceUrl}` : track.source;
            card.innerHTML = `
                <button class="preview-button" type="button" aria-label="试听 ${escape_html(track.title)}">
                    <svg class="icon icon-play" aria-hidden="true"><use href="#i-play"></use></svg>
                    <svg class="icon icon-pause" aria-hidden="true"><use href="#i-pause"></use></svg>
                </button>
                <div class="builtin-info">
                    <strong>${escape_html(track.title)}</strong>
                    <small>${escape_html(track.subtitle)} · ${duration_label(track.duration)} · ${track.bars} 根</small>
                    <em class="builtin-source">${escape_html(track.source)} · ${escape_html(track.license)}</em>
                </div>
                <span class="builtin-select">使用</span>
            `;
            card.addEventListener('click', (e) => {
                if (e.target.closest('.preview-button')) return;
                if (busy) return;
                select_builtin(track);
            });
            const preview = card.querySelector('.preview-button');
            preview.addEventListener('click', (e) => {
                e.stopPropagation();
                toggle_preview(track, preview);
            });
            builtin_list.appendChild(card);
        }
        if (selected_builtin) set_selected_card(selected_builtin.id);
    }

    function render_source_results(tracks, append) {
        if (!song_list) return;
        if (!append) {
            source_results = [];
            song_list.innerHTML = '';
        }
        const list = Array.isArray(tracks) ? tracks : [];
        source_results = source_results.concat(list);
        if (!append && !list.length) {
            const empty = document.createElement('p');
            empty.className = 'song-empty';
            empty.textContent = '没有找到结果。换个曲名、乐器或情绪再试。';
            song_list.appendChild(empty);
            return;
        }
        for (const raw of list) {
            const track = {
                ...raw,
                audio: `/api/source/audio?token=${encodeURIComponent(raw.token)}`
            };
            const meta = [raw.artist, duration_label(raw.duration), raw.license]
                .filter(Boolean)
                .join(' · ');
            const card = document.createElement('div');
            card.className = 'song-card';
            card.dataset.token = raw.token;
            card.title = raw.attribution ? `${raw.attribution} · ${raw.license}` : `${raw.title} · ${raw.artist}`;
            card.innerHTML = `
                <div class="song-info">
                    <strong>${escape_html(raw.title)}</strong>
                    <small>${escape_html(meta)}</small>
                </div>
                <button class="preview-button" type="button" aria-label="试听 ${escape_html(raw.title)}">
                    <svg class="icon icon-play" aria-hidden="true"><use href="#i-play"></use></svg>
                    <svg class="icon icon-pause" aria-hidden="true"><use href="#i-pause"></use></svg>
                </button>
                <span class="song-select">使用</span>
            `;
            card.addEventListener('click', (e) => {
                if (e.target.closest('.preview-button')) return;
                if (busy) return;
                select_source(track);
            });
            const preview = card.querySelector('.preview-button');
            preview.addEventListener('click', (e) => {
                e.stopPropagation();
                toggle_preview(track, preview);
            });
            song_list.appendChild(card);
        }
        if (selected_source) set_selected_source_card(selected_source.token);
    }

    async function search_source(reset) {
        if (busy || source_searching) return;
        const query = reset ? song_query.value.trim() : source_query;
        if (reset) {
            source_results = [];
            source_page = 0;
            if (song_list) song_list.innerHTML = '';
            song_more.classList.add('hidden');
        }
        const next_page = source_page + 1;
        source_searching = true;
        song_search_button.disabled = true;
        song_more.disabled = true;
        song_search_button.textContent = query ? '搜索中…' : '读取中…';
        online_copy.textContent = query
            ? `正在纯音乐曲库搜索「${query}」…`
            : '正在读取纯音乐曲库…';
        try {
            const params = new URLSearchParams({
                q: query,
                page: String(next_page)
            });
            const resp = await fetch(`/api/source/search?${params.toString()}`, {cache: 'no-store'});
            let data = null;
            try {
                data = await resp.json();
            } catch (err) { /* 非 JSON 响应 */ }
            if (!resp.ok) throw new Error((data && data.error) || '搜索失败');
            if (data && data.provider) {
                source_provider = {
                    id: data.provider.id || source_provider.id,
                    name: data.provider.name || source_provider.name,
                    homepage: data.provider.homepage || source_provider.homepage,
                    license: data.provider.license || source_provider.license
                };
            }
            const tracks = data && Array.isArray(data.tracks) ? data.tracks : [];
            const total = data && Number.isFinite(Number(data.total))
                ? Number(data.total)
                : source_results.length + tracks.length;
            source_query = query;
            source_page = next_page;
            render_source_results(tracks, !reset);
            if (!source_results.length) {
                online_copy.textContent = query
                    ? `没有找到「${query}」，换个关键词或乐器试试。`
                    : '曲库暂时没有可用的曲目。';
            } else {
                const translated = data && data.translatedQuery
                    && query && data.translatedQuery.toLowerCase() !== query.toLowerCase()
                    ? `（英文关键词：${data.translatedQuery}）`
                    : '';
                const summary = query
                    ? `${source_provider.name} 找到 ${total} 首纯音乐${translated}`
                    : `${source_provider.name} 曲库共 ${total} 首纯音乐`;
                online_copy.textContent = `${summary}，已显示 ${source_results.length} 首。点「使用」选中，生成时自动下载。`;
            }
            song_more.classList.toggle('hidden', !(data && data.hasMore));
        } catch (err) {
            online_copy.textContent = '搜索失败：' + err.message;
            if (!source_results.length) song_more.classList.add('hidden');
        } finally {
            source_searching = false;
            song_search_button.disabled = busy;
            song_more.disabled = busy;
            song_search_button.textContent = '搜索';
        }
    }

    function set_preview_state(button, playing) {
        if (!button) return;
        button.classList.toggle('playing', !!playing);
        const card = button.closest('.builtin-card, .song-card');
        const title = card ? card.querySelector('.builtin-info strong, .song-info strong') : null;
        button.setAttribute('aria-label', `${playing ? '暂停试听' : '试听'}${title ? ' ' + title.textContent : ''}`);
    }

    function toggle_preview(track, button) {
        if (preview_audio && !preview_audio.paused) {
            const was_this = preview_button === button;
            preview_audio.pause();
            preview_audio.currentTime = 0;
            preview_audio = null;
            if (preview_button) set_preview_state(preview_button, false);
            preview_button = null;
            if (was_this) return;
        }
        const audio = new Audio(track.audio);
        audio.preload = 'auto';
        audio.volume = 0.75;
        preview_audio = audio;
        preview_button = button;
        set_preview_state(button, true);
        audio.addEventListener('ended', () => {
            if (preview_audio === audio) {
                preview_audio = null;
                preview_button = null;
                set_preview_state(button, false);
            }
        }, {once: true});
        audio.play().catch(() => toast('试听无法开始，请再点一次。'));
    }

    function escape_html(str) {
        return String(str).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    async function decode_file(file) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        try {
            const arr = await file.arrayBuffer();
            const buffer = await ctx.decodeAudioData(arr);
            return buffer;
        } finally {
            ctx.close().catch(() => {});
        }
    }

    async function resample_buffer(buffer) {
        const duration = Math.min(buffer.duration, MAX_SECONDS);
        const frames = Math.max(1, Math.ceil(duration * SAMPLE_RATE));
        let rendered;
        try {
            const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
            const source = offline.createBufferSource();
            source.buffer = buffer;
            source.connect(offline.destination);
            source.start(0);
            rendered = await offline.startRendering();
            return rendered.getChannelData(0).slice();
        } catch (err) {
            // Safari builds have historically rejected unusual OfflineAudioContext
            // rates. Render at 44.1 kHz and take every other sample.
            const offline = new OfflineAudioContext(1, frames * 2, 44100);
            const source = offline.createBufferSource();
            source.buffer = buffer;
            source.connect(offline.destination);
            source.start(0);
            rendered = await offline.startRendering();
            const src = rendered.getChannelData(0);
            const out = new Float32Array(frames);
            for (let i = 0; i < frames; i++) out[i] = (src[i * 2] + src[i * 2 + 1]) * 0.5;
            return out;
        }
    }

    function analyze_audio(audio, on_progress) {
        return new Promise((resolve, reject) => {
            let worker;
            try {
                worker = new Worker(new URL('scripts/onset-worker.js', document.baseURI).href);
            } catch (err) {
                reject(new Error('音符识别线程无法启动。'));
                return;
            }
            const timer = setTimeout(() => {
                worker.terminate();
                reject(new Error('音符识别超时，请换一个更短的文件。'));
            }, 120000);

            worker.onmessage = (event) => {
                const msg = event.data || {};
                if (msg.type === 'progress') {
                    on_progress(Math.max(0, Math.min(1, msg.value || 0)));
                } else if (msg.type === 'done') {
                    clearTimeout(timer);
                    worker.terminate();
                    resolve(msg.notes || []);
                } else if (msg.type === 'error') {
                    clearTimeout(timer);
                    worker.terminate();
                    reject(new Error(msg.message || '音符识别失败。'));
                }
            };
            worker.onerror = (event) => {
                clearTimeout(timer);
                worker.terminate();
                reject(new Error(event.message || '音符识别线程异常退出。'));
            };
            worker.postMessage({
                type: 'analyze',
                audio,
                sampleRate: SAMPLE_RATE
            }, [audio.buffer]);
        });
    }

    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    function midi_name(midi) {
        const m = Math.round(midi);
        return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
    }

    function merge_notes(notes, window_ms) {
        const sorted = notes.slice().sort((a, b) => a.time - b.time);
        const out = [];
        for (const note of sorted) {
            const ms = Math.round(note.time * 1000);
            const last = out[out.length - 1];
            if (last && ms - Math.round(last.time * 1000) < window_ms) {
                for (const name of note.note_names) {
                    if (!last.note_names.includes(name) && last.note_names.length < 4) {
                        last.note_names.push(name);
                    }
                }
                last.duration = Math.max(last.duration, note.duration);
            } else {
                out.push({
                    note_names: note.note_names.slice(0, 4),
                    time: note.time,
                    duration: note.duration
                });
            }
        }
        return out;
    }

    function build_visual_notes(raw, buffer_duration) {
        const clean = (raw || []).filter((n) => {
            const pitch = Number(n.pitchMidi);
            const start = Number(n.startTimeSeconds);
            const dur = Number(n.durationSeconds);
            const amp = Number(n.amplitude);
            return Number.isFinite(pitch) && pitch >= 21 && pitch <= 108 &&
                Number.isFinite(start) && start >= 0 &&
                Number.isFinite(dur) && dur >= 0.05 &&
                (!Number.isFinite(amp) || amp >= 0.1);
        }).sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

        if (!clean.length) throw new Error('没有识别到音符。换一段更清晰的录音试试。');

        const first = clean[0].startTimeSeconds;
        const audioOffset = Math.max(0, first - 0.15);
        const padStart = Math.max(0, 0.15 - (first - audioOffset));

        let notes = clean.map((n) => {
            const names = Array.isArray(n.note_names) && n.note_names.length
                ? n.note_names.slice(0, 4).map(String)
                : [midi_name(n.pitchMidi)];
            return {
                note_names: names,
                time: Math.max(0, n.startTimeSeconds - audioOffset + padStart),
                duration: Math.max(0.05, Math.min(10, n.durationSeconds)),
                midi: Math.round(n.pitchMidi),
                amplitude: Number(n.amplitude) || 0.5
            };
        }).filter((n) => n.time <= MAX_SECONDS + padStart);

        let merged = merge_notes(notes, MERGE_MS);
        for (const window of [110, 140, 180, 240]) {
            if (merged.length <= MAX_BARS) break;
            merged = merge_notes(notes, window);
        }
        if (merged.length > MAX_BARS) {
            // Keep the musically strongest bars when a dense mix produces too
            // many onsets; the chronological order is restored afterwards.
            const kept = notes.slice().sort((a, b) => b.amplitude - a.amplitude).slice(0, MAX_BARS);
            merged = merge_notes(kept, 100).sort((a, b) => a.time - b.time).slice(0, MAX_BARS);
        }
        if (merged.length < 2) throw new Error('只识别到一个音符。换一段更长或更清晰的音频试试。');

        const last_end = merged.reduce((max, n) => Math.max(max, n.time + n.duration), 0);
        const available = Math.max(0.1, buffer_duration - audioOffset);
        const duration = Math.max(1, Math.min(MAX_SECONDS, last_end + 0.75, padStart + available));
        const final_notes = merged.filter((n) => n.time < duration - 0.02);

        return {
            notes: final_notes,
            audioOffset,
            padStart,
            duration
        };
    }

    function show_result(url, title, expiresAt, permanent) {
        result_title.textContent = title || '这条轨道可以打开了';
        result_link.value = url;
        open_link.href = url;
        if (permanent) {
            result_expiry.textContent = '内置曲目永久保留。';
        } else if (Number.isFinite(Number(expiresAt)) && Number(expiresAt) > 0) {
            const at = clock_time(Number(expiresAt));
            result_expiry.textContent = at
                ? `链接保留至 ${at}。打开后可手动延长 10 分钟。`
                : '链接保留 10 分钟。打开后可手动延长。';
        } else {
            result_expiry.textContent = '链接保留 10 分钟。打开后可手动延长。';
        }
        result.classList.remove('hidden');
        result.scrollIntoView({behavior: 'smooth', block: 'nearest'});
    }

    async function analyze_and_upload(file, fallback_title, origin) {
        set_stage('解码音频', 4, '正在浏览器内读取文件。');
        let buffer;
        try {
            buffer = await decode_file(file);
        } catch (err) {
            set_busy(false);
            show_error('这个音频无法解码，请换 MP3、WAV、M4A、OGG 或 FLAC。');
            return;
        }

        set_stage('重采样音频', 9, '单声道 · 22.05 kHz。');
        let audio;
        try {
            audio = await resample_buffer(buffer);
        } catch (err) {
            set_busy(false);
            show_error('音频重采样失败：' + err.message);
            return;
        }

        let raw = [];
        try {
            set_stage('识别音符', 12, '在后台线程里寻找起音与音高，请保持页面打开。');
            raw = await analyze_audio(audio, (p) => {
                set_stage('识别音符', 12 + p * 58, '正在扫描频谱中的音符起点。');
            });
        } catch (err) {
            set_busy(false);
            show_error('音符识别失败：' + err.message);
            return;
        }

        set_stage('构建轨道', 72, '合并和弦并折叠路径。');
        let built;
        try {
            built = build_visual_notes(raw, buffer.duration);
        } catch (err) {
            set_busy(false);
            show_error(err.message);
            return;
        }

        set_stage('上传音频', 82, '服务器会裁剪音频并生成 MP3。');
        const title = title_input.value.trim() || fallback_title || '未命名轨道';
        const fd = new FormData();
        fd.append('audio', file, file.name || 'audio.mp3');
        fd.append('title', title);
        fd.append('notes', JSON.stringify(built.notes));
        fd.append('duration', built.duration.toFixed(3));
        fd.append('audioOffset', built.audioOffset.toFixed(3));
        fd.append('padStart', built.padStart.toFixed(3));
        fd.append('walls', walls_on ? '1' : '0');
        fd.append('seed', String(random_seed()));
        if (origin && origin.source) fd.append('source', origin.source);
        if (origin && origin.sourceUrl) fd.append('sourceUrl', origin.sourceUrl);

        try {
            set_stage('上传音频', 90, '一次短请求，音频保存在这台服务器上。');
            const resp = await fetch('/api/tracks', {method: 'POST', body: fd});
            const data = await resp.json();
            if (!resp.ok || !data.watchUrl) throw new Error(data.error || '上传失败');
            set_stage('完成', 100, '链接已生成。');
            set_busy(false);
            show_result(data.watchUrl, title, data.expiresAt, false);
        } catch (err) {
            set_busy(false);
            show_error('上传失败：' + err.message);
        }
    }

    async function generate_from_file() {
        const file = selected_file;
        if (!file) return;
        if (static_demo) {
            show_error('GitHub Pages 是静态演示，上传与分享链接需要本地运行 Node 服务。');
            return;
        }
        set_busy(true);
        clear_error();
        result.classList.add('hidden');
        await analyze_and_upload(file, file.name.replace(/\.[^.]+$/, '') || '未命名轨道');
    }

    async function generate_from_source() {
        const track = selected_source;
        if (!track) return;
        if (static_demo) {
            show_error('网络曲库需要本地运行完整服务；GitHub Pages 静态演示只能使用内置曲目。');
            return;
        }
        set_busy(true);
        clear_error();
        result.classList.add('hidden');
        set_stage('下载音频', 3, `正在从网络曲库获取「${track.title}」。`);
        let file;
        try {
            const resp = await fetch(track.audio, {cache: 'no-store'});
            if (!resp.ok) {
                let message = '下载失败';
                try {
                    const data = await resp.json();
                    if (data && data.error) message = data.error;
                } catch (err) { /* 非 JSON 响应 */ }
                throw new Error(message);
            }
            const blob = await resp.blob();
            if (!blob.size || blob.size < 1024) throw new Error('音频内容为空');
            file = new File([blob], safe_filename(track.title) + '.mp3', {
                type: blob.type || 'audio/mpeg'
            });
        } catch (err) {
            set_busy(false);
            show_error('下载失败：' + err.message + '。可以重新搜索后再试。');
            return;
        }
        set_stage('下载音频', 8, '已获取音频，开始识别音符。');
        await analyze_and_upload(file, track.title, {
            source: `${source_provider.name} · ${track.artist} · ${track.license || source_provider.license}`,
            sourceUrl: track.sourceUrl || source_provider.homepage
        });
    }

    function safe_filename(value) {
        return String(value || '')
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 60) || 'track';
    }

    function generate_from_builtin() {
        const track = selected_builtin;
        if (!track) return;
        const url = new URL(`watch.html?id=${encodeURIComponent(track.id)}`, document.baseURI);
        url.searchParams.set('walls', walls_on ? '1' : '0');
        url.searchParams.set('seed', random_seed().toString(36));
        show_result(url.href, track.title, null, true);
        toast('内置曲目的链接已生成。');
    }

    function on_generate() {
        if (busy) return;
        clear_error();
        if (selected_source) {
            generate_from_source();
        } else if (selected_builtin) {
            generate_from_builtin();
        } else if (selected_file) {
            generate_from_file();
        } else {
            show_error('请先上传音频，或从网络曲库 / 内置曲目选一首。');
        }
    }

    function reset_all() {
        if (preview_audio) {
            preview_audio.pause();
            preview_audio = null;
        }
        if (preview_button) {
            set_preview_state(preview_button, false);
            preview_button = null;
        }
        clear_selection();
        source_results = [];
        source_query = '';
        source_page = 0;
        if (song_list) song_list.innerHTML = '';
        if (song_query) song_query.value = '';
        if (song_more) song_more.classList.add('hidden');
        if (online_copy) online_copy.textContent = ONLINE_COPY_IDLE;
        source_provider = {...SOURCE_PROVIDER};
        title_input.value = '';
        auto_title = '';
        set_walls(true);
        set_mode('upload');
        result.classList.add('hidden');
        stage.classList.add('hidden');
        clear_error();
        update_generate_label();
        window.scrollTo({top: 0, behavior: 'smooth'});
    }

    file_input.addEventListener('change', () => {
        if (file_input.files && file_input.files[0]) set_file(file_input.files[0]);
    });
    selection_clear.addEventListener('click', () => {
        if (busy) return;
        clear_selection();
    });
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('drag');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('drag');
        if (busy) return;
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) set_file(file);
    });
    generate_button.addEventListener('click', on_generate);
    walls_toggle.addEventListener('click', () => {
        if (!busy) set_walls(!walls_on);
    });
    copy_link.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(result_link.value);
            toast('链接已复制。');
        } catch (err) {
            result_link.select();
            document.execCommand('copy');
            toast('链接已复制。');
        }
    });
    start_over.addEventListener('click', reset_all);
    if (source_tabs) {
        source_tabs.addEventListener('click', (e) => {
            const button = e.target.closest('.source-tab');
            if (!button || button.disabled || busy) return;
            set_mode(button.dataset.mode || 'upload');
        });
    }
    if (browse_online) browse_online.addEventListener('click', () => {
        if (!busy) set_mode('online');
    });
    if (browse_builtin) browse_builtin.addEventListener('click', () => {
        if (!busy) set_mode('builtin');
    });
    if (song_form) {
        song_form.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!busy) search_source(true);
        });
    }
    if (song_more) {
        song_more.addEventListener('click', () => {
            if (!busy) search_source(false);
        });
    }

    function mark_static_demo() {
        static_demo = true;
        apply_static_ui();
    }

    async function load_builtins() {
        let api_status = 0;
        if (!STATIC_MODE) {
            let resp = null;
            try {
                resp = await fetch('/api/builtins', {cache: 'no-store'});
                api_status = resp.status;
                if (!resp.ok) throw new Error('API 不可用');
                const data = await resp.json();
                if (!data || !Array.isArray(data.tracks)) throw new Error('API 数据无效');
                render_builtins(data.tracks || []);
                return;
            } catch (err) {
                // 网络失败记为 0，静态托管返回 HTML 时记为 -1；二者都按静态演示处理。
                if (!resp) api_status = 0;
                else if (resp.ok) api_status = -1;
            }
        }

        try {
            const resp = await fetch(new URL('builtins/manifest.json', document.baseURI).href, {cache: 'no-store'});
            if (!resp.ok) throw new Error('静态清单不可用');
            const data = await resp.json();
            if (STATIC_MODE || api_status === 404 || api_status === 0 || api_status === -1) mark_static_demo();
            render_builtins(data.tracks || []);
        } catch (err) {
            if (builtin_copy) builtin_copy.textContent = '内置曲目暂不可用。';
            builtin_list.innerHTML = '<p class="builtin-copy">内置曲目暂不可用。</p>';
        }
    }

    set_walls(true);
    set_mode('upload');
    load_builtins();
})();
