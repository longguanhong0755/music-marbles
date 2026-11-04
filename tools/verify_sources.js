#!/usr/bin/env node
/*
 * Offline checks for the Incompetech catalog layer:
 *   - Chinese query translation
 *   - catalog normalization (instrumental-only, 20-360 seconds, safe filenames)
 *   - local search ranking and multi-term matching
 *   - audio URL allowlist (SSRF boundary)
 *   - signed tokens: valid, tampered, expired, wrong kind/provider
 *
 * No network requests are made. Run with `npm test`.
 */
'use strict';

const assert = require('assert');
const {
    create_source_service,
    translate_query,
    parse_length,
    normalize_catalog,
    search_catalog,
    incompetech_audio_allowed,
    INCOMPETECH
} = require('../server/sources');

let passed = 0;
const failures = [];
function test(name, fn) {
    try {
        fn();
        passed++;
    } catch (err) {
        failures.push({name, error: err});
    }
}

const AUDIO = 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Piano%20Piece.mp3';
const RAW = {
    filename: 'Piano Piece.mp3',
    title: 'Piano Piece',
    length: '5:07',
    genre: '4',
    instruments: 'Piano',
    feel: 'Calm',
    description: 'A quiet piano piece.',
    bpm: '72',
    isrc: 'USABC1234567',
    uploaded: '2024-01-01'
};

test('translate_query maps Chinese instrument and mood terms', () => {
    assert.strictEqual(translate_query('钢琴 古筝 国风'), 'piano guzheng chinese');
    assert.strictEqual(translate_query('史诗 电影'), 'epic cinematic');
});

test('parse_length handles mm:ss and hh:mm:ss', () => {
    assert.strictEqual(parse_length('5:07'), 307);
    assert.strictEqual(parse_length('1:02:03'), 3723);
    assert.strictEqual(parse_length(''), 0);
});

test('normalize_catalog keeps a valid instrumental track', () => {
    const items = normalize_catalog([RAW]);
    assert.strictEqual(items.length, 1);
    const item = items[0];
    assert.strictEqual(item.title, 'Piano Piece');
    assert.strictEqual(item.duration, 307);
    assert.strictEqual(item.artist, 'Kevin MacLeod');
    assert.strictEqual(item.genre, 'Classical');
    assert.strictEqual(item.filename, 'Piano Piece.mp3');
});

test('normalize_catalog rejects vocals, short/long tracks and unsafe filenames', () => {
    const catalog = normalize_catalog([
        RAW,
        {...RAW, filename: 'Vocal.mp3', title: 'Vocal Song', instruments: 'Piano, Vocals'},
        {...RAW, filename: 'Short.mp3', length: '0:10'},
        {...RAW, filename: 'Long.mp3', length: '7:00'},
        {...RAW, filename: '../evil.mp3'},
        {...RAW, filename: '', title: ''},
        null
    ]);
    assert.deepStrictEqual(catalog.map((item) => item.filename), ['Piano Piece.mp3']);
});

test('normalize_catalog rejects an empty catalog', () => {
    assert.throws(() => normalize_catalog([]), /格式不正确/);
    assert.throws(() => normalize_catalog(null), /格式不正确/);
});

test('search_catalog matches all terms and ranks title matches first', () => {
    const items = normalize_catalog([
        RAW,
        {...RAW, filename: 'Calm Piano.mp3', title: 'Calm Piano', feel: 'Calm', uploaded: '2023-01-01', description: ''},
        {...RAW, filename: 'Guitar Study.mp3', title: 'Guitar Study', instruments: 'Guitar', description: ''},
        {...RAW, filename: 'Quiet Strings.mp3', title: 'Quiet Strings', instruments: 'Strings', feel: 'Calm', description: ''}
    ]);
    const piano = search_catalog(items, ['piano']);
    assert.deepStrictEqual(piano.map((item) => item.title), ['Piano Piece', 'Calm Piano']);
    const calmPiano = search_catalog(items, ['calm', 'piano']);
    assert.deepStrictEqual(calmPiano.map((item) => item.title), ['Calm Piano', 'Piano Piece']);
    assert.strictEqual(search_catalog(items, ['nothing']).length, 0);
    assert.strictEqual(search_catalog(items, []).length, 4);
});

test('Incompetech audio allowlist is host and path scoped', () => {
    assert.strictEqual(incompetech_audio_allowed(AUDIO), true);
    assert.strictEqual(incompetech_audio_allowed('https://www.incompetech.com/music/royalty-free/mp3-royaltyfree/test.mp3'), true);
    assert.strictEqual(incompetech_audio_allowed('https://incompetech.com/other/test.mp3'), false);
    assert.strictEqual(incompetech_audio_allowed('https://evil.example/music/royalty-free/mp3-royaltyfree/test.mp3'), false);
    assert.strictEqual(incompetech_audio_allowed('http://incompetech.com/music/royalty-free/mp3-royaltyfree/test.mp3'), false);
});

test('source tokens reject tampering, expiry, kind and provider confusion', () => {
    const service = create_source_service();
    const now = Date.now();
    const audioToken = service.makeToken({
        p: INCOMPETECH.id,
        k: 'audio',
        u: AUDIO,
        t: 'Piano Piece',
        a: 'Kevin MacLeod',
        l: 'CC BY 4.0',
        s: INCOMPETECH.homepage,
        e: now + 60000
    });
    assert(service.readToken(audioToken, 'audio'));
    assert.strictEqual(service.readToken(audioToken + 'x', 'audio'), null);
    assert.strictEqual(service.readToken(audioToken, 'cover'), null);

    const expired = service.makeToken({
        p: INCOMPETECH.id, k: 'audio', u: AUDIO, e: now - 1
    });
    assert.strictEqual(service.readToken(expired, 'audio'), null);

    const wrongProvider = service.makeToken({
        p: 'openverse', k: 'audio', u: AUDIO, e: now + 60000
    });
    assert.strictEqual(service.readToken(wrongProvider, 'audio'), null);

    const badUrl = service.makeToken({
        p: INCOMPETECH.id, k: 'audio', u: 'https://evil.example/x.mp3', e: now + 60000
    });
    assert.strictEqual(service.readToken(badUrl, 'audio'), null);
});

if (failures.length) {
    for (const failure of failures) {
        console.error(`FAIL ${failure.name}`);
        console.error(failure.error && failure.error.stack ? failure.error.stack : failure.error);
    }
    console.error(`\nsource checks: ${passed} passed, ${failures.length} failed`);
    process.exit(1);
}

console.log(`source checks: ${passed} passed`);
