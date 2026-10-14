export function projectHostname(website) {
  const value = String(website || '').trim();
  if (!value) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
    return ['http:', 'https:'].includes(url.protocol) ? url.hostname : '';
  } catch { return ''; }
}
