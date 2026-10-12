// syuP音ゲー — Google Analytics 4 (public site only).
// Loaded after game.js. It only watches which screen is shown (body[data-screen]) and reads texts already on screen;
// it never calls into the game, so music sync, notes, judgement and saves are untouched.
// Sent: page_view (on load), song_select (song select screen opened), play_start, song_clear.
// No personal data: no player name, no save contents — song title, difficulty, play mode and clear type only.
// Off everywhere except https://syupworks.github.io (local / LAN dev servers, file:, previews send nothing).
(() => {
  'use strict';
  const MEASUREMENT_ID = 'G-LC3NZYL9ZX';
  if (location.protocol !== 'https:' || location.hostname !== 'syupworks.github.io') return;
  if (window.__syupAnalytics) return;   // never install twice
  window.__syupAnalytics = true;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;
  const tag = document.createElement('script');
  tag.async = true; tag.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(tag);
  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID, { allow_google_signals: false, allow_ad_personalization_signals: false });

  const send = (name, params) => { try { gtag('event', name, params); } catch {} };
  const text = sel => (document.querySelector(sel)?.textContent || '').trim();
  const playMode = () => {
    const auto = document.querySelector('#autoplay-toggle')?.getAttribute('aria-pressed') === 'true';
    const syup = document.querySelector('#syup-badge') && !document.querySelector('#syup-badge').hidden;
    return syup ? (auto ? 'syup_auto' : 'syup') : auto ? 'auto' : 'normal';
  };
  const CLEAR = { 'CLEAR': 'clear', 'FULL COMBO': 'full_combo', 'ALL PERFECT': 'all_perfect' };

  let screen = document.body.dataset.screen, current = null;
  new MutationObserver(records => {
    // one batch can hold several screen changes: the value after each record is the next record's old value
    for (let i = 0; i < records.length; i++) {
      const next = i + 1 < records.length ? records[i + 1].oldValue : document.body.dataset.screen;
      try {
        // game.js sets data-screen="play" once per started run (retries included), so every write is one play
        if (next === 'play') {
          current = { song_title: text('#work-title').slice(0, 100), difficulty: document.querySelector('#hud-difficulty')?.dataset.diff || '', play_mode: playMode() };
          send('play_start', current);
        } else if (next !== screen && next === 'select') send('song_select', {});
        else if (next !== screen && next === 'result' && current) {
          const clear = CLEAR[text('#result-kind')];
          // AUTO PLAY / syuP MODE runs are not records in the game, so they are not counted as clears either
          if (clear && current.play_mode === 'normal') send('song_clear', { song_title: current.song_title, difficulty: current.difficulty, clear_type: clear });
          current = null;
        }
      } catch {}
      screen = next;
    }
  }).observe(document.body, { attributes: true, attributeOldValue: true, attributeFilter: ['data-screen'] });
})();
