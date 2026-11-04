'use strict';

/* Incompetech instrumental catalog.
 *
 * The catalog is a single public JSON file from incompetech.com. It is fetched
 * once, filtered to instrumental tracks between 20 seconds and 6 minutes, and
 * cached in memory for 12 hours. Search runs locally, so the page needs no API
 * key, no account and no proxy.
 *
 * Audio is proxied through this server with a signed, short-lived token. The
 * upstream host and path are allowlisted, so the token cannot be used to make
 * the server fetch an arbitrary URL.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const {URL} = require('url');

const SOURCE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_SIZE = 10;
const MIN_DURATION = 20;
const MAX_DURATION = 360;
const MAX_AUDIO_BYTES = 80 * 1024 * 1024;
const TOKEN_TTL_MS = 30 * 60 * 1000;

const INCOMPETECH = {
    id: 'incompetech',
    name: 'Incompetech',
    homepage: 'https://incompetech.com/music/royalty-free/music.html',
    catalogUrl: 'https://incompetech.com/music/royalty-free/pieces.json',
    audioBase: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    catalogTtlMs: 12 * 60 * 60 * 1000,
    note: 'Kevin MacLeod 的器乐作品集，无需注册与代理。'
};
const INCOMPETECH_ARTIST = 'Kevin MacLeod';
const INCOMPETECH_VOCAL_RE = /\b(vocal|vocals|vocalist|singer|lyrics|spoken|rap)\b/i;
const INCOMPETECH_GENRES = new Map([
    ['2', 'African'], ['3', 'Blues'], ['4', 'Classical'], ['5', 'Contemporary'],
    ['6', 'Disco'], ['7', 'Electronica'], ['8', 'Funk'], ['9', 'Holiday'],
    ['10', 'Horror'], ['11', 'Jazz'], ['12', 'Latin'], ['13', 'Modern'],
    ['14', 'Musical'], ['15', 'Polka'], ['16', 'Pop'], ['18', 'Reggae'],
    ['19', 'Rock'], ['20', 'Silent Film Score'], ['21', 'Ska'], ['22', 'Soundtrack'],
    ['23', 'Stings'], ['24', 'Unclassifiable'], ['25', 'World'], ['26', 'Urban']
]);

const SOURCE_ALIASES = new Map([
    ['钢琴', 'piano'], ['钢琴曲', 'piano'], ['吉他', 'guitar'], ['鼓', 'drums'],
    ['小提琴', 'violin'], ['大提琴', 'cello'], ['长笛', 'flute'], ['笛子', 'flute'],
    ['管弦', 'orchestra'], ['弦乐', 'strings'], ['电子', 'electronic'], ['电子乐', 'electronic'],
    ['爵士', 'jazz'], ['摇滚', 'rock'], ['蓝调', 'blues'], ['放克', 'funk'],
    ['雷鬼', 'reggae'], ['拉丁', 'latin'], ['凯尔特', 'celtic'], ['中世纪', 'medieval'],
    ['圣诞', 'christmas'], ['恐怖', 'horror'], ['史诗', 'epic'], ['轻松', 'relaxing'],
    ['欢快', 'upbeat'], ['悲伤', 'sad'], ['浪漫', 'romantic'], ['神秘', 'mysterious'],
    ['环境', 'ambient'], ['氛围', 'ambient'], ['学习', 'study'], ['睡眠', 'sleep'],
    ['动作', 'action'], ['电影', 'cinematic'], ['影视', 'cinematic'], ['中国', 'chinese'],
    ['国风', 'chinese'], ['古筝', 'guzheng'], ['二胡', 'erhu'], ['琵琶', 'pipa'],
    ['日本', 'japanese'], ['印度', 'india'], ['非洲', 'african'], ['中东', 'middle east'],
    ['舞曲', 'dance'], ['纯音乐', 'instrumental'], ['快节奏', 'driving'], ['安静', 'calm'],
    ['舒缓', 'calm'], ['放松', 'relaxing']
]);

function clean_text(value, max) {
    return String(value == null ? '' : value)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function translate_query(query) {
    return String(query || '').split(/\s+/).filter(Boolean)
        .map((term) => SOURCE_ALIASES.get(term.toLowerCase()) || term)
        .join(' ');
}

function parse_length(value) {
    const parts = String(value || '').split(':').map((part) => parseInt(part, 10) || 0);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return 0;
}

function make_cache(ttlMs, maxEntries) {
    const map = new Map();
    return {
        get(key) {
            const item = map.get(key);
            if (!item) return null;
            if (item.expires <= Date.now()) {
                map.delete(key);
                return null;
            }
            return item.value;
        },
        set(key, value) {
            map.delete(key);
            map.set(key, {value, expires: Date.now() + ttlMs});
            while (map.size > maxEntries) {
                const oldest = map.keys().next().value;
                if (oldest === undefined) break;
                map.delete(oldest);
            }
        }
    };
}

function decode_body(buffer, encoding) {
    const value = String(encoding || '').toLowerCase();
    if (value === 'gzip') return zlib.gunzipSync(buffer);
    if (value === 'deflate') return zlib.inflateSync(buffer);
    if (value === 'br') return zlib.brotliDecompressSync(buffer);
    return buffer;
}

function read_limited(stream, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let done = false;
        const finish = (err, value) => {
            if (done) return;
            done = true;
            if (err) reject(err);
            else resolve(value);
        };
        stream.on('data', (chunk) => {
            total += chunk.length;
            if (total > limit) {
                stream.destroy();
                finish(new Error('上游响应过大'));
                return;
            }
            chunks.push(chunk);
        });
        stream.on('end', () => finish(null, Buffer.concat(chunks)));
        stream.on('error', (err) => finish(err));
    });
}

function open_request(url, options) {
    const opts = options || {};
    const maxRedirects = Number.isFinite(opts.maxRedirects) ? opts.maxRedirects : 4;
    return new Promise((resolve, reject) => {
        let redirects = 0;
        const go = (target) => {
            let parsed;
            try {
                parsed = target instanceof URL ? target : new URL(String(target));
            } catch (err) {
                reject(new Error('上游地址无效'));
                return;
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                reject(new Error('上游地址不支持'));
                return;
            }
            const mod = parsed.protocol === 'https:' ? https : http;
            const headers = {
                'User-Agent': SOURCE_UA,
                'Accept-Encoding': 'identity',
                ...(opts.headers || {})
            };
            const req = mod.request(parsed, {
                method: opts.method || 'GET',
                headers,
                agent: opts.agent,
                family: opts.family || 4
            }, (res) => {
                const status = Number(res.statusCode) || 0;
                if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
                    res.resume();
                    if (redirects >= maxRedirects) {
                        reject(new Error('上游重定向次数过多'));
                        return;
                    }
                    redirects++;
                    let next;
                    try {
                        next = new URL(res.headers.location, parsed);
                    } catch (err) {
                        reject(new Error('上游重定向地址无效'));
                        return;
                    }
                    if (opts.allowRedirect && !opts.allowRedirect(next)) {
                        reject(new Error('上游重定向被拒绝'));
                        return;
                    }
                    go(next);
                    return;
                }
                resolve({url: parsed, status, headers: res.headers, stream: res});
            });
            req.on('error', reject);
            req.setTimeout(opts.timeout || 30000, () => {
                req.destroy(new Error('上游请求超时'));
            });
            if (opts.body) req.write(opts.body);
            req.end();
        };
        go(url);
    });
}

async function request_json(url, options) {
    const opts = options || {};
    const res = await open_request(url, {
        ...opts,
        headers: {
            'Accept': 'application/json, text/plain, */*',
            ...(opts.headers || {})
        }
    });
    const body = decode_body(
        await read_limited(res.stream, opts.maxBytes || 8 * 1024 * 1024),
        res.headers['content-encoding']
    );
    if (res.status < 200 || res.status >= 300) {
        let detail = '';
        try {
            detail = body.toString('utf8').slice(0, 180);
        } catch (err) { /* 忽略 */ }
        throw new Error(`上游返回 ${res.status}${detail ? '：' + detail : ''}`);
    }
    try {
        return JSON.parse(body.toString('utf8'));
    } catch (err) {
        throw new Error('上游返回的不是 JSON');
    }
}

function incompetech_audio_allowed(value) {
    try {
        const url = new URL(String(value));
        return url.protocol === 'https:' &&
            /^(?:www\.)?incompetech\.com$/i.test(url.hostname) &&
            url.pathname.startsWith('/music/royalty-free/mp3-royaltyfree/');
    } catch (err) {
        return false;
    }
}

function normalize_catalog(payload) {
    if (!Array.isArray(payload) || !payload.length) {
        throw new Error('Incompetech 返回格式不正确');
    }
    const items = [];
    for (const raw of payload) {
        if (!raw || typeof raw !== 'object') continue;
        const filename = clean_text(raw.filename, 200);
        const title = clean_text(raw.title, 120);
        if (!filename || !title || /[\/\\]/.test(filename)) continue;
        const duration = parse_length(raw.length);
        if (!duration || duration < MIN_DURATION || duration > MAX_DURATION) continue;
        const genre = INCOMPETECH_GENRES.get(String(raw.genre)) || '';
        const instruments = clean_text(raw.instruments, 160);
        const feel = clean_text(raw.feel, 120);
        const description = clean_text(raw.description, 400);
        if (INCOMPETECH_VOCAL_RE.test(`${title} ${instruments} ${feel} ${description}`)) continue;
        items.push({
            id: clean_text(raw.isrc || filename, 60),
            title,
            filename,
            artist: INCOMPETECH_ARTIST,
            duration,
            genre,
            instruments,
            feel,
            bpm: clean_text(raw.bpm, 12),
            description,
            uploaded: clean_text(raw.uploaded, 20),
            search: `${title} ${instruments} ${feel} ${genre} ${description} ${INCOMPETECH_ARTIST} instrumental`
                .toLowerCase()
        });
    }
    if (!items.length) throw new Error('Incompetech 曲库中没有可用曲目');
    return items;
}

function search_catalog(items, terms) {
    if (!terms.length) return items;
    const matched = [];
    for (const item of items) {
        let score = 0;
        let ok = true;
        for (const term of terms) {
            if (!item.search.includes(term)) {
                ok = false;
                break;
            }
            if (item.title.toLowerCase().includes(term)) score += 4;
            else if (item.instruments.toLowerCase().includes(term)
                || item.feel.toLowerCase().includes(term)
                || item.genre.toLowerCase().includes(term)) score += 2;
            else score += 1;
        }
        if (ok) matched.push({item, score});
    }
    matched.sort((a, b) => b.score - a.score
        || (b.item.uploaded || '').localeCompare(a.item.uploaded || '')
        || a.item.title.localeCompare(b.item.title));
    return matched.map((entry) => entry.item);
}

function create_source_service() {
    const sourceSecret = crypto.randomBytes(32);
    const catalogCache = make_cache(INCOMPETECH.catalogTtlMs, 2);
    const agent = new https.Agent({
        keepAlive: true,
        maxSockets: 4,
        maxFreeSockets: 2,
        maxVersion: 'TLSv1.2'
    });
    let catalogLoading = null;
    let warmPromise = null;

    async function load_catalog() {
        const cached = catalogCache.get('catalog');
        if (cached) return cached;
        if (catalogLoading) return catalogLoading;
        catalogLoading = (async () => {
            const payload = await request_json(INCOMPETECH.catalogUrl, {
                agent,
                headers: {
                    'Referer': INCOMPETECH.homepage,
                    'Accept': 'application/json, text/plain, */*'
                },
                timeout: 25000
            });
            const items = normalize_catalog(payload);
            catalogCache.set('catalog', items);
            return items;
        })().finally(() => {
            catalogLoading = null;
        });
        return catalogLoading;
    }

    async function search_incompetech({query, page}) {
        const items = await load_catalog();
        const translated = translate_query(query);
        const terms = translated.split(/\s+/).filter(Boolean);
        const matches = search_catalog(items, terms);
        const offset = (page - 1) * PAGE_SIZE;
        const slice = matches.slice(offset, offset + PAGE_SIZE);
        return {
            tracks: slice.map((item) => ({
                id: item.id,
                title: item.title,
                artist: item.artist,
                duration: item.duration,
                genre: item.genre,
                tags: [item.instruments, item.feel].filter(Boolean),
                license: INCOMPETECH.license,
                licenseUrl: INCOMPETECH.licenseUrl,
                attribution: `"${item.title}" ${INCOMPETECH_ARTIST} (incompetech.com)`,
                sourceUrl: INCOMPETECH.homepage,
                audioUrl: INCOMPETECH.audioBase + encodeURIComponent(item.filename)
            })),
            total: matches.length,
            hasMore: offset + slice.length < matches.length,
            translatedQuery: translated
        };
    }

    function provider_info() {
        return {
            id: INCOMPETECH.id,
            name: INCOMPETECH.name,
            homepage: INCOMPETECH.homepage,
            license: INCOMPETECH.license,
            licenseUrl: INCOMPETECH.licenseUrl,
            note: INCOMPETECH.note
        };
    }

    function make_token(payload) {
        const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
        const sig = crypto.createHmac('sha256', sourceSecret).update(body).digest('base64url');
        return `${body}.${sig}`;
    }

    function read_token(token, kind) {
        if (typeof token !== 'string' || token.length < 8 || token.length > 4096) return null;
        const dot = token.lastIndexOf('.');
        if (dot <= 0) return null;
        const body = token.slice(0, dot);
        const given = Buffer.from(token.slice(dot + 1), 'utf8');
        const expected = Buffer.from(
            crypto.createHmac('sha256', sourceSecret).update(body).digest('base64url'),
            'utf8'
        );
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
        let payload = null;
        try {
            payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        } catch (err) {
            return null;
        }
        if (!payload || typeof payload !== 'object') return null;
        if (payload.k !== kind) return null;
        if (!Number.isFinite(payload.e) || payload.e < Date.now()) return null;
        if (payload.p !== INCOMPETECH.id) return null;
        if (typeof payload.u !== 'string' || !incompetech_audio_allowed(payload.u)) return null;
        return payload;
    }

    async function search(request) {
        const input = request || {};
        const query = clean_text(input.query, 80);
        const page = Math.max(1, Math.min(1000, Math.floor(Number(input.page) || 1)));
        const result = await search_incompetech({query, page});
        const now = Date.now();
        const tracks = result.tracks.map((track) => ({
            id: track.id,
            title: track.title,
            artist: track.artist,
            duration: track.duration,
            genre: track.genre,
            tags: track.tags,
            license: track.license,
            licenseUrl: track.licenseUrl,
            attribution: track.attribution,
            sourceUrl: track.sourceUrl,
            token: make_token({
                p: INCOMPETECH.id,
                k: 'audio',
                u: track.audioUrl,
                t: track.title,
                a: track.artist,
                l: track.license,
                s: track.sourceUrl,
                e: now + TOKEN_TTL_MS
            }),
            expiresAt: now + TOKEN_TTL_MS
        }));

        return {
            provider: provider_info(),
            query,
            translatedQuery: result.translatedQuery,
            page,
            pageSize: PAGE_SIZE,
            total: result.total,
            hasMore: result.hasMore,
            tracks
        };
    }

    async function fetch_audio(payload, rangeHeader) {
        const headers = {
            'Accept': 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
            'Referer': INCOMPETECH.homepage
        };
        if (rangeHeader) headers.Range = String(rangeHeader).slice(0, 200);
        return open_request(payload.u, {
            headers,
            agent,
            timeout: 120000,
            maxRedirects: 3,
            allowRedirect: (next) => incompetech_audio_allowed(next.href)
        });
    }

    async function warmup() {
        if (warmPromise) return warmPromise;
        warmPromise = load_catalog().catch((err) => {
            console.warn('[source] Incompetech 曲库预加载失败：', err.message);
        });
        return warmPromise;
    }

    return {
        provider: provider_info,
        search,
        makeToken: make_token,
        readToken: read_token,
        fetchAudio: fetch_audio,
        warmup,
        maxAudioBytes: MAX_AUDIO_BYTES
    };
}

module.exports = {
    create_source_service,
    translate_query,
    parse_length,
    normalize_catalog,
    search_catalog,
    incompetech_audio_allowed,
    SOURCE_ALIASES,
    PAGE_SIZE,
    MIN_DURATION,
    MAX_DURATION,
    INCOMPETECH
};
