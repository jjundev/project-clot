// Recognize login pages only from their route or an actual password login form.
export function isLoginHtml(html) {
  const loginForm = /<form\b[^>]*\baction\s*=\s*["'][^"']*\/auth\/login(?:[?/#][^"']*)?["'][^>]*>[\s\S]*?<input\b[^>]*\btype\s*=\s*["']password["']/i;
  if (loginForm.test(html)) return true;
  const script = html.match(/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/);
  if (!script) return false;
  try {
    const page = JSON.parse(script[1])?.page;
    return typeof page === 'string' && /^\/auth\/login(?:\/|$)/.test(page);
  } catch {
    return false;
  }
}
