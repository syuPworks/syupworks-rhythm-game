// syuP音ゲー — Google Analytics 4 (public site only).
// Loaded after game.js. It only watches which screen is shown (body[data-screen]) and reads texts already on screen;
// it never calls into the game, so music sync, notes, judgement and saves are untouched.
// Sent: page_view (on load), song_select (song select screen opened), play_start, song_clear.
// No personal data: no player name, no save contents — song title, difficulty, play mode and clear type only.
// Off everywhere except https://syupworks.github.io (local / LAN dev servers, file:, previews send nothing).
// Consent: the site has no consent banner, so in regions that need opt-in consent for analytics cookies
// (EEA, UK, Switzerland) nothing is measured at all — gtag.js is not even loaded. The region is taken from the
// browser time zone; an unknown / UTC time zone also counts as "needs consent". As a second layer, Consent Mode
// defaults every storage to denied for those regions (Google decides by IP), and ad storage is denied everywhere.
// Global Privacy Control / Do Not Track also switch measurement off.
(() => {
  'use strict';
  const MEASUREMENT_ID = 'G-LC3NZYL9ZX';
  if (location.protocol !== 'https:' || location.hostname !== 'syupworks.github.io') return;
  if (window.__syupAnalytics) return;   // never install twice

  const CONSENT_REGIONS = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
    'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'CH'];
  const needsConsent = () => {
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
    if (!tz || /^(Etc\/|UTC$|UCT$|GMT|Universal$|Zulu$|Greenwich$)/.test(tz)) return true;   // unknown → be safe
    return /^(Europe|Arctic)\//.test(tz)   // all of Europe (also non-EEA countries: stricter than needed)
      || /^(Asia\/(Nicosia|Famagusta)|Atlantic\/(Reykjavik|Canary|Madeira|Azores|Faroe|Faeroe|Jan_Mayen)|Africa\/Ceuta|Indian\/(Reunion|Mayotte)|America\/(Guadeloupe|Martinique|Cayenne|Marigot|St_Barthelemy))$/.test(tz)
      || /^(GB|GB-Eire|Eire|Iceland|Portugal|Poland|CET|EET|WET|MET)$/.test(tz);
  };
  const optedOut = () => navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1';
  if (needsConsent() || optedOut()) return;
  window.__syupAnalytics = true;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;
  // consent defaults must come before config / gtag.js; the region-specific one wins for those regions
  gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied', region: CONSENT_REGIONS });
  gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'granted' });
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
