// syuP音ゲー — Google Analytics 4 (public site only).
// Loaded after game.js. It only watches which screen is shown (body[data-screen]) and reads texts already on screen;
// it never calls into the game, so music sync, notes, judgement and saves are untouched.
// Sent: page_view (on load), song_select (song select screen opened), play_start, song_clear.
// No personal data: no player name, no save contents — song title, difficulty, play mode and clear type only.
// Off everywhere except https://syupworks.github.io (local / LAN dev servers, file:, previews send nothing).
// Consent: opt-in for every visitor, no region guessing. Until "許可する" is pressed in the title screen notice,
// gtag.js is not loaded and nothing is sent (Consent Mode, basic implementation). The choice is kept in localStorage
// (its own key, not the save) and can be changed any time; withdrawing sets the GA opt-out flag and removes GA cookies.
(() => {
  'use strict';
  const MEASUREMENT_ID = 'G-LC3NZYL9ZX', KEY = 'syupworks-analytics-consent';
  if (location.protocol !== 'https:' || location.hostname !== 'syupworks.github.io') return;
  if (window.__syupAnalytics) return;   // never install twice
  window.__syupAnalytics = true;

  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = v => { try { localStorage.setItem(KEY, v); } catch {} };
  let granted = false, loaded = false;
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }

  function start() {
    granted = true; window[`ga-disable-${MEASUREMENT_ID}`] = false;
    if (loaded) { gtag('consent', 'update', { analytics_storage: 'granted' }); return; }
    loaded = true; window.gtag = window.gtag || gtag;
    // Consent Mode v2 signals: everything denied by default, analytics granted by this visitor, ads never
    gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' });
    gtag('consent', 'update', { analytics_storage: 'granted' });
    const tag = document.createElement('script');
    tag.async = true; tag.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
    document.head.appendChild(tag);
    gtag('js', new Date());
    gtag('config', MEASUREMENT_ID, { allow_google_signals: false, allow_ad_personalization_signals: false });
  }
  function stop() {
    granted = false; window[`ga-disable-${MEASUREMENT_ID}`] = true;
    if (loaded) gtag('consent', 'update', { analytics_storage: 'denied' });
    for (const c of document.cookie.split(';')) {
      const name = c.split('=')[0].trim();
      if (/^_ga(_|$)/.test(name)) for (const d of ['', `;domain=${location.hostname}`, `;domain=.${location.hostname}`]) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/${d}`;
    }
  }

  // notice UI: undecided → [許可する][許可しない]; decided → current state + [変更]
  const note = document.querySelector('.privacy-note');
  const ask = note?.querySelector('.privacy-ask'), state = note?.querySelector('.privacy-state'), label = note?.querySelector('.privacy-state-label');
  const show = choice => {
    if (!note) return;
    ask.hidden = !!choice; state.hidden = !choice;
    label.textContent = choice === 'granted' ? '解析：許可中' : '解析：オフ';
  };
  note?.addEventListener('click', e => {
    const b = e.target.closest('button[data-consent]');
    if (!b) return;
    const v = b.dataset.consent;
    if (v === 'change') { show(null); return; }
    write(v); show(v);
    v === 'granted' ? start() : stop();
  });
  const saved = read();
  show(saved === 'granted' || saved === 'denied' ? saved : null);
  if (saved === 'granted') start();

  const send = (name, params) => { if (!granted) return; try { gtag('event', name, params); } catch {} };
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
