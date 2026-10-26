import path from 'node:path';

function globMatch(pattern, value) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') { source += '.*'; i++; }
      else source += '[^/]*';
    } else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + source + '$').test(value);
}

export function matchesFilter(pattern, rel) {
  const clean = pattern.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!clean) return false;
  if (globMatch(clean, rel)) return true;
  if (clean.includes('/')) return false;
  return globMatch(clean, path.posix.basename(rel)) || rel.startsWith(clean + '/');
}
