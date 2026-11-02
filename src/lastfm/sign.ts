import { md5Hex } from './md5';

/**
 * Last.fm api_sig: sort params by name, concatenate name+value (UTF-8), append the shared
 * secret, md5. `format` and `callback` are excluded, per https://www.last.fm/api/authspec.
 */
export function signatureBase(params: Record<string, string>, secret: string): string {
  const names = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort();
  return names.map((k) => k + params[k]).join('') + secret;
}

export function apiSig(params: Record<string, string>, secret: string): string {
  return md5Hex(signatureBase(params, secret));
}
