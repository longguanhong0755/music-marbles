/* Music Marbles — landing page: audio import, transcription, share link. */
(function () {
    'use strict';

    const file_input = document.getElementById('file-input');
    const dropzone = document.getElementById('dropzone');
    const drop_title = document.getElementById('drop-title');
    const drop_sub = document.getElementById('drop-sub');
    const file_row = document.getElementById('file-row');
    const file_name = document.getElementById('file-name');
    const file_size = document.getElementById('file-size');
    const clear_file = document.getElementById('clear-file');
    const title_input = document.getElementById('title-input');
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
    const builtin_list = document.getElementById('builtin-list');
    const toast_el = document.getElementById('toast');

    const SAMPLE_RATE = 22050;
    const MAX_SECONDS = 360;
    const MAX_BARS = 1000;
    const MERGE_MS = 80;
    const STATIC_MODE = !!window.MUSIC_MARBLES_STATIC;

    let selected_file = null;
    let selected_builtin = null;
    let builtins = [];
    let busy = false;
    let static_demo = STATIC_MODE;
    let preview_audio = null;
    let preview_button = null;
    let toast_timer = 0;

    function asset_url(path) {
        return new URL(String(path || '').replace(/^\//, ''), document.baseURI).href;
    }

    function normalize_track(track) {
        return {
            ...track,
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
        generate_label.textContent = value ? '处理中…' : '生成分享链接';
        file_input.disabled = value;
        clear_file.disabled = value;
        title_input.disabled = value;
        builtin_list.querySelectorAll('.builtin-card').forEach((card) => {
            card.style.pointerEvents = value ? 'none' : '';
            card.style.opacity = value ? '0.55' : '';
        });
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

    function set_file(file) {
        if (!file) return;
        if (static_demo) {
            toast('静态演示只支持内置曲目；上传请本地运行 npm start。');
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
        selected_file = file;
        selected_builtin = null;
        set_selected_card(null);
        file_name.textContent = name;
        file_size.textContent = file_label(file);
        file_row.classList.remove('hidden');
        drop_title.textContent = '文件已就绪';
        drop_sub.textContent = '点击生成，或更换文件';
        if (!title_input.value.trim()) {
            title_input.value = name.replace(/\.[^.]+$/, '').slice(0, 80);
        }
        clear_error();
        result.classList.add('hidden');
    }

    function clear_selected_file() {
        selected_file = null;
        file_input.value = '';
        file_row.classList.add('hidden');
        drop_title.textContent = '拖入音频，或点击选择';
        drop_sub.textContent = '最长 6 分钟 · 单文件 80 MB';
    }

    function set_selected_card(id) {
        builtin_list.querySelectorAll('.builtin-card').forEach((card) => {
            card.classList.toggle('selected', card.dataset.id === id);
            const label = card.querySelector('.builtin-select');
            if (label) label.textContent = card.dataset.id === id ? '已选' : '使用';
        });
    }

    function select_builtin(track, card) {
        selected_builtin = track;
        selected_file = null;
        clear_selected_file();
        set_selected_card(track.id);
        if (!title_input.value.trim()) title_input.placeholder = track.title;
        clear_error();
        result.classList.add('hidden');
    }

    function render_builtins(tracks) {
        builtins = (tracks || []).map(normalize_track);
        builtin_list.innerHTML = '';
        if (!builtins.length) {
            builtin_list.innerHTML = '<p class="builtin-copy">没有可用的内置曲目。</p>';
            return;
        }
        for (const track of builtins) {
            const card = document.createElement('div');
            card.className = 'builtin-card';
            card.dataset.id = track.id;
            card.innerHTML = `
                <button class="preview-button" type="button" aria-label="试听 ${escape_html(track.title)}">▶</button>
                <div class="builtin-info">
                    <strong>${escape_html(track.title)}</strong>
                    <small>${escape_html(track.subtitle)} · ${duration_label(track.duration)} · ${track.bars} 根</small>
                </div>
                <span class="builtin-select">使用</span>
            `;
            card.addEventListener('click', (e) => {
                if (e.target.closest('.preview-button')) return;
                if (busy) return;
                select_builtin(track, card);
            });
            const preview = card.querySelector('.preview-button');
            preview.addEventListener('click', (e) => {
                e.stopPropagation();
                toggle_preview(track, preview);
            });
            builtin_list.appendChild(card);
        }
    }

    function toggle_preview(track, button) {
        if (preview_audio && !preview_audio.paused) {
            const was_this = preview_button === button;
            preview_audio.pause();
            preview_audio.currentTime = 0;
            preview_audio = null;
            if (preview_button) {
                preview_button.textContent = '▶';
                preview_button.classList.remove('playing');
            }
            preview_button = null;
            if (was_this) return;
        }
        const audio = new Audio(track.audio);
        audio.preload = 'auto';
        audio.volume = 0.75;
        preview_audio = audio;
        preview_button = button;
        button.textContent = '❚❚';
        button.classList.add('playing');
        audio.addEventListener('ended', () => {
            if (preview_audio === audio) {
                preview_audio = null;
                preview_button = null;
                button.textContent = '▶';
                button.classList.remove('playing');
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
        const title = title_input.value.trim() || file.name.replace(/\.[^.]+$/, '') || '未命名轨道';
        const fd = new FormData();
        fd.append('audio', file, file.name || 'audio.mp3');
        fd.append('title', title);
        fd.append('notes', JSON.stringify(built.notes));
        fd.append('duration', built.duration.toFixed(3));
        fd.append('audioOffset', built.audioOffset.toFixed(3));
        fd.append('padStart', built.padStart.toFixed(3));

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

    function generate_from_builtin() {
        const track = selected_builtin;
        if (!track) return;
        const url = new URL(`watch.html?id=${encodeURIComponent(track.id)}`, document.baseURI).href;
        show_result(url, track.title, null, true);
        toast('内置曲目的链接已生成。');
    }

    function on_generate() {
        if (busy) return;
        clear_error();
        if (selected_builtin) {
            generate_from_builtin();
        } else if (selected_file) {
            generate_from_file();
        } else {
            show_error('请先选择音频文件，或点一首内置曲目。');
        }
    }

    function reset_all() {
        if (preview_audio) {
            preview_audio.pause();
            preview_audio = null;
        }
        if (preview_button) {
            preview_button.textContent = '▶';
            preview_button.classList.remove('playing');
            preview_button = null;
        }
        clear_selected_file();
        selected_builtin = null;
        set_selected_card(null);
        title_input.value = '';
        title_input.placeholder = '为这条轨道命名';
        result.classList.add('hidden');
        stage.classList.add('hidden');
        clear_error();
        generate_label.textContent = '生成分享链接';
        window.scrollTo({top: 0, behavior: 'smooth'});
    }

    file_input.addEventListener('change', () => {
        if (file_input.files && file_input.files[0]) set_file(file_input.files[0]);
    });
    clear_file.addEventListener('click', (e) => {
        e.preventDefault();
        if (!busy) file_input.click();
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

    function mark_static_demo() {
        static_demo = true;
        drop_sub.textContent = '静态演示只支持内置曲目 · 上传需本地运行';
        const copy = document.querySelector('.builtin-copy');
        if (copy) {
            copy.textContent = 'GitHub Pages 静态演示。三首公版作品可直接播放与导出；上传与 10 分钟链接需本地运行 Node 服务。';
        }
    }

    async function load_builtins() {
        let api_status = 0;
        if (!STATIC_MODE) {
            try {
                const resp = await fetch('/api/builtins', {cache: 'no-store'});
                api_status = resp.status;
                if (!resp.ok) throw new Error('API 不可用');
                const data = await resp.json();
                render_builtins(data.tracks || []);
                return;
            } catch (err) {
                // 静态托管没有后端，继续读同目录下的清单。
            }
        }

        try {
            const resp = await fetch(new URL('builtins/manifest.json', document.baseURI).href, {cache: 'no-store'});
            if (!resp.ok) throw new Error('静态清单不可用');
            const data = await resp.json();
            if (STATIC_MODE || api_status === 404 || api_status === 0) mark_static_demo();
            render_builtins(data.tracks || []);
        } catch (err) {
            builtin_list.innerHTML = '<p class="builtin-copy">内置曲目暂不可用。</p>';
        }
    }

    load_builtins();
})();
