#!/usr/bin/env node
/* Music Marbles — tiny local server.
 *
 *   GET  /                         landing page
 *   GET  /watch/:id                player page
 *   GET  /api/builtins             bundled demo tracks
 *   GET  /api/tracks/:id           track metadata + notes
 *   POST /api/tracks               audio + notes -> share id
 *   GET  /media/:id/audio          transcoded audio
 *   POST /api/tracks/:id/video     recorded WebM/MP4 -> MP4
 *   GET  /media/:id/video-<r>.mp4  exported video
 */
'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {spawn} = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const TRACKS = path.join(DATA, 'tracks');
const EXPORTS = path.join(DATA, 'exports');
const TMP = path.join(DATA, 'tmp');
const BUILTINS = path.join(ROOT, 'builtins');
const PORT = Number(process.env.PORT || 8080);
const CONTENT_TTL_MS = Math.max(60_000, Number(process.env.CONTENT_TTL_MS) || 10 * 60 * 1000);
const EXPORT_TAIL_SECONDS = 0.55;

for (const dir of [DATA, TRACKS, EXPORTS, TMP]) fs.mkdirSync(dir, {recursive: true});

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit: '2mb'}));
app.use(express.urlencoded({extended: false, limit: '2mb'}));

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const BUILTIN_RE = /^builtin-[a-z0-9-]+$/;
const RATIOS = new Set(['9x16', '16x9', '1x1', '4x5']);

const audioUpload = multer({
    dest: TMP,
    limits: {fileSize: 80 * 1024 * 1024, files: 1},
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const ok = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.webm', '.mp4']
            .includes(ext);
        cb(ok ? null : new Error('不支持这种音频格式'), ok);
    }
});

const videoUpload = multer({
    dest: TMP,
    limits: {fileSize: 1024 * 1024 * 1024, files: 1},
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const ok = ['.webm', '.mp4', '.mov', '.mkv'].includes(ext) || !ext;
        cb(ok ? null : new Error('不支持这种视频格式'), ok);
    }
});

function make_id() {
    return crypto.randomBytes(7).toString('base64url').replace(/[-_]/g, '').slice(0, 10);
}

function safe_id(id) {
    return ID_RE.test(id);
}

function public_base(req) {
    return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

function run(cmd, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, Object.assign({stdio: ['ignore', 'pipe', 'pipe']}, options));
        let out = '', err = '';
        child.stdout.on('data', (d) => out += d);
        child.stderr.on('data', (d) => err += d);
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve({out, err});
            else reject(new Error(`${cmd} exited ${code}: ${err.slice(-1200)}`));
        });
    });
}

function parse_time(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string' && value) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
    return 0;
}

function expires_at(meta) {
    const explicit = parse_time(meta && meta.expiresAt);
    if (explicit) return explicit;
    const created = Date.parse((meta && meta.createdAt) || '');
    if (Number.isFinite(created)) return created + CONTENT_TTL_MS;
    return 0;
}

async function read_meta(dir) {
    return JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
}

async function write_meta(dir, meta) {
    await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

async function dir_expired(dir) {
    try {
        const meta = await read_meta(dir);
        const at = expires_at(meta);
        return !!at && Date.now() >= at;
    } catch (err) {
        const stat = await fsp.stat(dir).catch(() => null);
        return !!stat && Date.now() - stat.mtimeMs >= CONTENT_TTL_MS;
    }
}

async function track_available(id) {
    const dir = path.join(TRACKS, id);
    try {
        const meta = await read_meta(dir);
        const at = expires_at(meta);
        if (at && Date.now() >= at) {
            await fsp.rm(dir, {recursive: true, force: true}).catch(() => {});
            return false;
        }
        return true;
    } catch (err) {
        return false;
    }
}

async function export_available(id) {
    const dir = path.join(EXPORTS, id);
    try {
        const meta = await read_meta(dir);
        const at = expires_at(meta);
        if (at && Date.now() >= at) {
            await fsp.rm(dir, {recursive: true, force: true}).catch(() => {});
            return false;
        }
        return true;
    } catch (err) {
        return false;
    }
}

async function sweep_expired() {
    for (const root of [TRACKS, EXPORTS]) {
        const entries = await fsp.readdir(root, {withFileTypes: true}).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(root, entry.name);
            if (await dir_expired(dir)) {
                await fsp.rm(dir, {recursive: true, force: true}).catch(() => {});
            }
        }
    }
    const temps = await fsp.readdir(TMP, {withFileTypes: true}).catch(() => []);
    for (const entry of temps) {
        if (!entry.isFile()) continue;
        const file = path.join(TMP, entry.name);
        const stat = await fsp.stat(file).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs >= CONTENT_TTL_MS) {
            await fsp.unlink(file).catch(() => {});
        }
    }
}

setInterval(() => sweep_expired().catch(() => {}), 10_000).unref();
sweep_expired().catch(() => {});

async function transcode_audio(input, output, {offset, duration, padStart}) {
    const filters = [
        `atrim=start=${Math.max(0, offset).toFixed(3)}:duration=${Math.max(0.1, duration).toFixed(3)}`,
        'asetpts=PTS-STARTPTS'
    ];
    if (padStart > 0.001) {
        filters.push(`adelay=${Math.round(padStart * 1000)}:all=1`);
    }
    await run('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', input,
        '-af', filters.join(','),
        '-ac', '2', '-ar', '44100', '-b:a', '192k',
        '-t', Math.max(0.1, duration).toFixed(3),
        output
    ]);
}

async function transcode_video(input, output) {
    const encoder = await pick_h264_encoder();
    const common = [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', input,
        '-pix_fmt', 'yuv420p',
        '-r', '30'
    ];
    const tail = ['-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output];
    const software = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-threads', '0'];
    let args;
    if (encoder === 'h264_videotoolbox') {
        args = [...common, '-c:v', 'h264_videotoolbox', '-b:v', '6M', ...tail];
    } else if (encoder === 'h264_nvenc') {
        args = [...common, '-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '6M', ...tail];
    } else if (encoder === 'h264_qsv') {
        args = [...common, '-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', '6M', ...tail];
    } else {
        args = [...common, ...software, ...tail];
    }
    try {
        await run('ffmpeg', args);
    } catch (err) {
        if (encoder === 'libx264') throw err;
        // Hardware encoders can be listed but unusable in a container or VM.
        await run('ffmpeg', [...common, ...software, ...tail]);
    }
}

let cached_encoder = '';
async function pick_h264_encoder() {
    if (cached_encoder) return cached_encoder;
    try {
        const {out} = await run('ffmpeg', ['-hide_banner', '-encoders']);
        for (const name of ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'libx264']) {
            if (new RegExp(`\\b${name}\\b`).test(out)) {
                cached_encoder = name;
                break;
            }
        }
    } catch (err) {
        // Fall through to libx264; the transcode itself will report the real error.
    }
    if (!cached_encoder) cached_encoder = 'libx264';
    return cached_encoder;
}

async function resolve_track_audio(id) {
    if (BUILTIN_RE.test(id)) {
        const manifest = JSON.parse(await fsp.readFile(path.join(BUILTINS, 'manifest.json'), 'utf8'));
        const item = (manifest.tracks || []).find((track) => track.id === id);
        if (!item) return null;
        const rel = String(item.audio || '').replace(/^\/builtins\//, '');
        if (!rel || rel.includes('..')) return null;
        return {
            file: path.join(BUILTINS, rel),
            duration: Number(item.duration) || 0,
            title: item.title || 'music-marbles'
        };
    }
    if (!safe_id(id)) return null;
    if (!(await track_available(id))) return null;
    const dir = path.join(TRACKS, id);
    const meta = await read_meta(dir);
    return {
        file: path.join(dir, 'audio.mp3'),
        duration: Number(meta.duration) || 0,
        title: meta.title || 'music-marbles'
    };
}

async function media_codecs(input) {
    try {
        const {out} = await run('ffprobe', [
            '-v', 'error',
            '-show_entries', 'stream=codec_type,codec_name',
            '-of', 'json',
            input
        ]);
        const parsed = JSON.parse(out);
        const streams = (parsed && parsed.streams) || [];
        const video = (streams.find((s) => s.codec_type === 'video') || {}).codec_name || '';
        const audio = (streams.find((s) => s.codec_type === 'audio') || {}).codec_name || '';
        return {video, audio};
    } catch (err) {
        return {video: '', audio: ''};
    }
}

async function mux_offline_video(input, audio, output) {
    if (!audio) throw new Error('原曲已过期，无法封装音频');
    const codecs = await media_codecs(input);
    if (codecs.video !== 'h264') throw new Error('离线视频不是 H.264 编码');
    const total = (1 + Math.max(0, Number(audio.duration) || 0) + EXPORT_TAIL_SECONDS).toFixed(3);
    await run('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', input,
        '-i', audio.file,
        '-filter_complex', '[1:a]adelay=1000:all=1,apad[a]',
        '-map', '0:v:0',
        '-map', '[a]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '160k',
        '-t', total,
        '-movflags', '+faststart',
        output
    ]);
}

async function remux_video(input, output) {
    await run('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', input,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-c', 'copy',
        '-movflags', '+faststart',
        output
    ]);
}

async function process_video(input, output, {offline, audio, ext}) {
    if (offline) {
        await mux_offline_video(input, audio, output);
        return;
    }
    const codecs = await media_codecs(input);
    if (!codecs.video) {
        throw new Error('录制的视频没有画面，请重新导出。');
    }
    if (
        ['.mp4', '.mov'].includes(String(ext || '').toLowerCase())
        && codecs.video === 'h264'
        && (!codecs.audio || codecs.audio === 'aac')
    ) {
        try {
            await remux_video(input, output);
            return;
        } catch (err) {
            console.warn('MP4 直接封装失败，改走转码：', err.message);
        }
    }
    await transcode_video(input, output);
}

function clean_name(raw) {
    return String(raw || 'music-marbles')
        .replace(/[^\p{L}\p{N}\-_ ]+/gu, '')
        .trim()
        .slice(0, 60) || 'music-marbles';
}

function sanitize_notes(raw) {
    if (!Array.isArray(raw)) throw new Error('音符数据格式不正确');
    if (raw.length < 1 || raw.length > 2400) throw new Error('音符数量超出范围');
    return raw.map((note) => {
        if (!note || typeof note !== 'object') throw new Error('音符数据格式不正确');
        const time = Number(note.time);
        const duration = Number(note.duration);
        if (!Number.isFinite(time) || time < 0 || time > 36000) throw new Error('音符时间不正确');
        if (!Number.isFinite(duration) || duration < 0 || duration > 60) throw new Error('音符长度不正确');
        let names = Array.isArray(note.note_names) ? note.note_names : [];
        names = names.filter((n) => typeof n === 'string' && /^[A-Ga-g](#|b)?-?\d+$/.test(n)).slice(0, 4);
        if (!names.length) names = ['C4'];
        return {note_names: names, time: Math.round(time * 1000) / 1000, duration: Math.round(duration * 1000) / 1000};
    }).sort((a, b) => a.time - b.time);
}

app.get('/api/health', (req, res) => res.json({ok: true}));

app.get('/api/builtins', async (req, res) => {
    try {
        const manifest = JSON.parse(await fsp.readFile(path.join(BUILTINS, 'manifest.json'), 'utf8'));
        res.json(manifest);
    } catch (err) {
        res.status(500).json({error: '内置曲目不可用'});
    }
});

app.get('/api/tracks/:id', async (req, res) => {
    const id = req.params.id;
    try {
        if (BUILTIN_RE.test(id)) {
            const manifest = JSON.parse(await fsp.readFile(path.join(BUILTINS, 'manifest.json'), 'utf8'));
            const item = manifest.tracks.find((t) => t.id === id);
            if (!item) return res.status(404).json({error: '未找到'});
            const data = JSON.parse(await fsp.readFile(path.join(BUILTINS, item.notes.replace(/^\/builtins\//, '')), 'utf8'));
            return res.json({
                id,
                title: item.title,
                subtitle: item.subtitle,
                duration: item.duration,
                audioUrl: item.audio,
                notes: data.notes,
                builtin: true,
                permanent: true,
                expiresAt: null
            });
        }

        if (!safe_id(id)) return res.status(404).json({error: '未找到'});
        if (!(await track_available(id))) return res.status(404).json({error: '未找到'});
        const dir = path.join(TRACKS, id);
        const [meta, notes] = await Promise.all([
            read_meta(dir),
            fsp.readFile(path.join(dir, 'notes.json'), 'utf8')
        ]);
        const at = expires_at(meta);
        res.json({
            id,
            title: meta.title,
            duration: meta.duration,
            settings: meta.settings && typeof meta.settings === 'object'
                ? {walls: meta.settings.walls !== false}
                : {walls: true},
            audioUrl: `/media/${id}/audio`,
            notes: JSON.parse(notes),
            builtin: false,
            permanent: false,
            expiresAt: at,
            remainingSeconds: Math.max(0, Math.floor((at - Date.now()) / 1000))
        });
    } catch (err) {
        res.status(404).json({error: '未找到'});
    }
});

app.post('/api/tracks', audioUpload.single('audio'), async (req, res, next) => {
    if (!req.file) return res.status(400).json({error: '请选择音频文件'});
    const temp = req.file.path;
    try {
        let notes;
        try {
            notes = sanitize_notes(JSON.parse(req.body.notes || '[]'));
        } catch (err) {
            return res.status(400).json({error: '音符数据无效：' + err.message});
        }

        const title = String(req.body.title || 'Untitled').trim().slice(0, 80) || 'Untitled';
        const duration = Math.max(1, Math.min(600, Number(req.body.duration) || (notes[notes.length - 1].time + 2)));
        const audioOffset = Math.max(0, Math.min(36000, Number(req.body.audioOffset) || 0));
        const padStart = Math.max(0, Math.min(1, Number(req.body.padStart) || 0));
        const walls = String(req.body.walls || '1') !== '0';
        const settings = {walls};

        const id = make_id();
        const dir = path.join(TRACKS, id);
        await fsp.mkdir(dir, {recursive: true});
        const audioPath = path.join(dir, 'audio.mp3');
        const now = Date.now();
        const expiresAt = new Date(now + CONTENT_TTL_MS).toISOString();

        await transcode_audio(temp, audioPath, {offset: audioOffset, duration, padStart});

        await fsp.writeFile(path.join(dir, 'notes.json'), JSON.stringify(notes));
        await write_meta(dir, {
            id,
            title,
            duration,
            audioOffset,
            padStart,
            settings,
            notes: notes.length,
            originalName: req.file.originalname || '',
            createdAt: new Date(now).toISOString(),
            expiresAt
        });

        const base = public_base(req);
        const watch_url = new URL(`${base}/watch.html`);
        watch_url.searchParams.set('id', id);
        watch_url.searchParams.set('walls', walls ? '1' : '0');
        res.json({
            id,
            title,
            duration,
            settings,
            watchUrl: watch_url.href,
            audioUrl: `/media/${id}/audio`,
            expiresAt: now + CONTENT_TTL_MS,
            ttlSeconds: CONTENT_TTL_MS / 1000
        });
    } catch (err) {
        next(err);
    } finally {
        fsp.unlink(temp).catch(() => {});
    }
});

app.post('/api/tracks/:id/extend', async (req, res, next) => {
    const id = req.params.id;
    if (!safe_id(id)) return res.status(404).json({error: '未找到'});
    try {
        if (!(await track_available(id))) return res.status(404).json({error: '已过期'});
        const dir = path.join(TRACKS, id);
        const meta = await read_meta(dir);
        const now = Date.now();
        meta.expiresAt = new Date(now + CONTENT_TTL_MS).toISOString();
        await write_meta(dir, meta);
        res.json({
            expiresAt: now + CONTENT_TTL_MS,
            ttlSeconds: CONTENT_TTL_MS / 1000
        });
    } catch (err) {
        next(err);
    }
});

app.get('/media/:id/audio', async (req, res) => {
    const id = req.params.id;
    if (!safe_id(id)) return res.status(404).end();
    if (!(await track_available(id))) return res.status(404).end();
    res.sendFile(path.join(TRACKS, id, 'audio.mp3'), (err) => {
        if (err && !res.headersSent) res.status(404).end();
    });
});

app.post('/api/tracks/:id/video', videoUpload.single('video'), async (req, res, next) => {
    const id = req.params.id;
    if (!safe_id(id)) return res.status(404).json({error: '未找到'});
    const ratio = String(req.body.ratio || '');
    if (!RATIOS.has(ratio)) return res.status(400).json({error: '画面比例不正确'});
    if (!req.file) return res.status(400).json({error: '缺少视频数据'});
    const temp = req.file.path;
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    const offline = String(req.body.offline || '') === '1';
    try {
        if (!(await track_available(id))) return res.status(404).json({error: '已过期'});
        const dir = path.join(TRACKS, id);
        const meta = await read_meta(dir);
        const audio = offline ? await resolve_track_audio(id) : null;
        if (offline && !audio) return res.status(409).json({error: '原曲已过期，无法封装音频'});
        const output = path.join(dir, `video-${ratio}.mp4`);
        await process_video(temp, output, {offline, audio, ext});
        res.json({
            url: `/media/${id}/video-${ratio}.mp4`,
            download: `${clean_name(meta.title)}-${ratio}.mp4`,
            expiresAt: expires_at(meta)
        });
    } catch (err) {
        next(err);
    } finally {
        fsp.unlink(temp).catch(() => {});
    }
});

app.get('/media/:id/video-:ratio.mp4', async (req, res) => {
    const id = req.params.id;
    const ratio = req.params.ratio;
    if (!safe_id(id) || !RATIOS.has(ratio)) return res.status(404).end();
    if (!(await track_available(id))) return res.status(404).end();
    res.sendFile(path.join(TRACKS, id, `video-${ratio}.mp4`), (err) => {
        if (err && !res.headersSent) res.status(404).end();
    });
});

// Video exports work for both uploaded tracks and bundled demo tracks. They
// are keyed independently so a built-in link does not need a copied track row.
app.post('/api/video', videoUpload.single('video'), async (req, res, next) => {
    const ratio = String(req.body.ratio || '');
    if (!RATIOS.has(ratio)) return res.status(400).json({error: '画面比例不正确'});
    if (!req.file) return res.status(400).json({error: '缺少视频数据'});
    const temp = req.file.path;
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    const offline = String(req.body.offline || '') === '1';
    const track_id = String(req.body.trackId || '');
    try {
        let audio = null;
        if (offline) {
            if (!track_id || (!BUILTIN_RE.test(track_id) && !safe_id(track_id))) {
                return res.status(400).json({error: '缺少原曲信息'});
            }
            audio = await resolve_track_audio(track_id);
            if (!audio) return res.status(409).json({error: '原曲已过期，无法封装音频'});
        }

        const id = make_id();
        const dir = path.join(EXPORTS, id);
        await fsp.mkdir(dir, {recursive: true});
        const output = path.join(dir, `video-${ratio}.mp4`);
        await process_video(temp, output, {offline, audio, ext});
        const now = Date.now();
        await write_meta(dir, {
            id,
            ratio,
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(now + CONTENT_TTL_MS).toISOString()
        });
        const clean = clean_name(req.body.name || (audio && audio.title) || 'music-marbles');
        res.json({
            url: `/media/exports/${id}/video-${ratio}.mp4`,
            download: `${clean}-${ratio}.mp4`,
            expiresAt: now + CONTENT_TTL_MS,
            ttlSeconds: CONTENT_TTL_MS / 1000
        });
    } catch (err) {
        next(err);
    } finally {
        fsp.unlink(temp).catch(() => {});
    }
});

app.get('/media/exports/:id/video-:ratio.mp4', async (req, res) => {
    const id = req.params.id;
    const ratio = req.params.ratio;
    if (!safe_id(id) || !RATIOS.has(ratio)) return res.status(404).end();
    if (!(await export_available(id))) return res.status(404).end();
    res.sendFile(path.join(EXPORTS, id, `video-${ratio}.mp4`), (err) => {
        if (err && !res.headersSent) res.status(404).end();
    });
});

// Code and styles change during deployment; let browsers revalidate so a
// normal reload picks up new icons and playback fixes without a hard refresh.
app.use('/styles', express.static(path.join(ROOT, 'styles'), {maxAge: 0, etag: true, lastModified: true}));
app.use('/scripts', express.static(path.join(ROOT, 'scripts'), {maxAge: 0, etag: true, lastModified: true}));
app.use('/images', express.static(path.join(ROOT, 'images'), {maxAge: '1d'}));
app.use('/vendor', express.static(path.join(ROOT, 'vendor'), {maxAge: '1d'}));
app.use('/builtins', express.static(BUILTINS, {maxAge: '1h'}));

app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/watch.html', (req, res) => res.sendFile(path.join(ROOT, 'watch.html')));
app.get('/watch/:id', (req, res) => {
    res.redirect(302, `/watch.html?id=${encodeURIComponent(req.params.id)}`);
});

app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({error: '文件过大。'});
    }
    if (err instanceof multer.MulterError) {
        return res.status(400).json({error: '上传失败，请检查文件。'});
    }
    const message = err && err.message ? err.message : '服务器出错';
    res.status(500).json({error: message});
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Music Marbles on http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces())) {
        for (const item of list || []) {
            if (item.family === 'IPv4' && !item.internal) {
                console.log(`  LAN: http://${item.address}:${PORT}`);
            }
        }
    }
});
server.requestTimeout = 0;
server.timeout = 0;
