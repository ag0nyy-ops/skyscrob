import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { md5Hex } from '../src/lastfm/md5';
import { apiSig, signatureBase } from '../src/lastfm/sign';

describe('md5Hex', () => {
  it('matches RFC 1321 test vectors', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5Hex('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe(
      '57edf4a22be3c955ac49da2e2107b67a',
    );
  });

  it('hashes UTF-8 (artist names are not ASCII) and every padding boundary', () => {
    for (const s of [
      'Sigur Rós',
      'Beyoncé',
      '宇多田ヒカル',
      '🎵',
      'x'.repeat(55),
      'x'.repeat(56),
      'x'.repeat(64),
      'x'.repeat(1000),
    ]) {
      expect(md5Hex(s)).toBe(createHash('md5').update(s, 'utf8').digest('hex'));
    }
  });
});

describe('Last.fm api_sig', () => {
  it('builds the base string exactly like the auth spec example', () => {
    // https://www.last.fm/api/webauth: api_keyxxxxxxxxmethodauth.getSessiontokenyyyyyy + secret
    const params = { api_key: 'xxxxxxxx', method: 'auth.getSession', token: 'yyyyyy' };
    expect(signatureBase(params, 'ilovecher')).toBe(
      'api_keyxxxxxxxxmethodauth.getSessiontokenyyyyyyilovecher',
    );
    expect(apiSig(params, 'ilovecher')).toBe(
      md5Hex('api_keyxxxxxxxxmethodauth.getSessiontokenyyyyyyilovecher'),
    );
  });

  it('sorts params and excludes format and callback', () => {
    const params = {
      track: 'T',
      format: 'json',
      artist: 'A',
      callback: 'cb',
      api_key: 'k',
      method: 'track.scrobble',
    };
    expect(signatureBase(params, 's')).toBe('api_keykartistAmethodtrack.scrobbletrackTs');
  });

  it('sorts indexed batch params as plain strings (artist[10] before artist[1]... as Last.fm does)', () => {
    const p: Record<string, string> = {};
    for (const i of [0, 1, 10, 2]) p[`artist[${i}]`] = `a${i}`;
    expect(signatureBase(p, '')).toBe('artist[0]a0artist[10]a10artist[1]a1artist[2]a2');
  });
});
