// Live GitHub star count for the nav button.
// Falls back to plain "GITHUB" (no star) if the API is unavailable or rate-limited.
(async () => {
  const el = document.getElementById('gh-stars');
  if (!el) return;

  const KEY = 'fascicle-stars';
  const TTL = 36e5; // 1 hour
  const render = (n) => { el.textContent = `GITHUB ★ ${n.toLocaleString()}`; };

  try {
    const cached = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (cached && Date.now() - cached.t < TTL) { render(cached.n); return; }
  } catch { /* ignore malformed cache */ }

  try {
    const res = await fetch('https://api.github.com/repos/robmclarty/fascicle');
    if (!res.ok) return; // leave "GITHUB" as-is on error
    const n = (await res.json()).stargazers_count;
    if (typeof n !== 'number') return;
    try { localStorage.setItem(KEY, JSON.stringify({ n, t: Date.now() })); } catch { /* ignore */ }
    render(n);
  } catch { /* keep static fallback */ }
})();
