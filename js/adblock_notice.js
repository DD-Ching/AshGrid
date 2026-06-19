// ============ ANTI-ADBLOCK NOTICE (Phase 123) ==============================
// Polite, dismissable bottom-of-screen toast when we detect that ads aren't
// reaching the player. Industry data: ~30-40% of users asked nicely will
// whitelist a site they want to use. The other 60-70% dismiss the notice
// or ignore it — we don't try to be more aggressive than that (no modal,
// no game-blocking, no anti-anti-adblock arms race).
//
// Tries to differentiate two failure modes so the message can be useful:
//
//   1. BROWSER AD BLOCKER (uBlock Origin / AdBlock / Brave shields):
//      → bait element with ad-related class names gets hidden by CSS
//      → bait fetch with /ads/ in path gets refused
//      → message: "please whitelist ashgrid.io"
//
//   2. NETWORK FILTER (school / corp Fortinet doing TLS interception):
//      → bait passes (browser still trusts itself), but Adsterra domains
//        get cert errors from the firewall's middleman
//      → message: "your network blocks ads — try mobile data or VPN"
//
// One dismissal suppresses the notice for 7 days (localStorage). Detection
// runs on window.load + a 5 s settle so we don't false-positive while
// Adsterra's invoke.js is still in flight.
//
// Classic-script. No global exports — IIFE only. Reads getLang() if
// available for zh/en localisation; falls back to English.

(function() {
  'use strict';

  const SUPPRESS_KEY  = 'ag.adblockNoticeSuppressUntil';
  const SUPPRESS_DAYS = 7;
  const DETECT_DELAY  = 5000;        // wait for Adsterra invoke.js to settle
  const ELEMENT_PROBE_DELAY = 200;   // wait for adblock CSS to hide the bait

  function _isSuppressed() {
    try {
      const until = parseInt(localStorage.getItem(SUPPRESS_KEY), 10) || 0;
      return Date.now() < until;
    } catch (e) { return false; }
  }
  function _suppressForWeek() {
    try {
      const until = Date.now() + SUPPRESS_DAYS * 24 * 60 * 60 * 1000;
      localStorage.setItem(SUPPRESS_KEY, String(until));
    } catch (e) {}
  }

  // ─── Probe 1: bait element ─────────────────────────────────────────
  // Most reliable signal. Adblock filter lists (EasyList, EasyPrivacy)
  // CSS-hide any element matching common ad class names. We insert a
  // tiny invisible div with several of those names; if adblock is on,
  // it'll be display:none or zero-sized.
  function _probeBaitElement() {
    return new Promise((resolve) => {
      const bait = document.createElement('div');
      bait.className = 'adsbox ad-banner ads ad-placement advertisement banner_ad';
      bait.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;';
      document.body.appendChild(bait);
      setTimeout(() => {
        const cs = getComputedStyle(bait);
        const hidden = bait.offsetHeight === 0
                    || bait.offsetWidth  === 0
                    || cs.display    === 'none'
                    || cs.visibility === 'hidden';
        bait.remove();
        resolve(hidden);
      }, ELEMENT_PROBE_DELAY);
    });
  }

  // ─── Probe 2: did Adsterra invoke.js inject an iframe? ─────────────
  // Final ground truth. If Adsterra successfully ran, an iframe with its
  // domain in the src will be in the DOM. If we see ZERO of those after
  // the settle window, ads aren't reaching the player — regardless of
  // why (adblock, cert, network, no-fill).
  function _probeAdsterraLoaded() {
    return new Promise((resolve) => {
      setTimeout(() => {
        const iframes = document.querySelectorAll(
          'iframe[src*="highperformanceformat"], iframe[src*="effectivecpmnetwork"]'
        );
        resolve(iframes.length > 0);
      }, DETECT_DELAY);
    });
  }

  // ─── Combine + classify ───────────────────────────────────────────
  // result.blocked  = ads aren't reaching the player
  // result.reason   = 'adblock' (browser extension) or 'network' (firewall)
  async function _detect() {
    const [elementHidden, adsLoaded] = await Promise.all([
      _probeBaitElement(),
      _probeAdsterraLoaded(),
    ]);
    if (adsLoaded) return { blocked: false };
    // No ads in DOM. Why?
    if (elementHidden) {
      // CSS hid our bait → browser-level adblock confirmed (a RELIABLE signal).
      return { blocked: true, reason: 'adblock' };
    }
    // Bait survived but no ad iframe loaded. This is AMBIGUOUS and was the source of
    // FALSE "your network blocks ads" notices: it ALSO fires when our own COEP headers
    // block the third-party ad scripts (see the ERR_BLOCKED_BY_RESPONSE...Coep console
    // errors), when the ad network no-fills, or when it's just slow — none of which is
    // the user's network. The owner reported this false positive at home with no
    // firewall, so we no longer guess "network": only genuine browser adblock (bait
    // hidden, above) ever surfaces a notice.
    return { blocked: false };
  }

  // ─── UI ─────────────────────────────────────────────────────────────
  function _showNotice(reason) {
    if (document.getElementById('adblockNotice')) return;   // already up

    const notice = document.createElement('div');
    notice.id = 'adblockNotice';
    notice.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:18px',
      'transform:translateX(-50%)',
      'z-index:1500',
      'background:rgba(20,16,14,0.95)',
      'border:1px solid rgba(200,38,28,0.65)',
      'color:#E8E4D8',
      'padding:14px 50px 14px 18px',
      'font:12px/1.5 "Helvetica Neue",sans-serif',
      'letter-spacing:0.5px',
      'max-width:460px',
      'box-shadow:0 6px 24px rgba(0,0,0,0.5)',
      'pointer-events:auto',
    ].join(';');

    const isZh = (typeof getLang === 'function' && getLang() === 'zh');
    let body;
    if (reason === 'adblock') {
      body = isZh
        ? '<b style="color:#FFD24A;">⚠ 廣告被攔截</b><br>AshGrid 是免費遊戲,靠廣告營運。<br>請將 <code style="color:#FFD24A;">ashgrid.io</code> 加入廣告攔截器白名單,謝謝!'
        : '<b style="color:#FFD24A;">⚠ Ads blocked</b><br>AshGrid is free thanks to ads.<br>Please whitelist <code style="color:#FFD24A;">ashgrid.io</code> in your ad blocker — thank you!';
    } else {
      body = isZh
        ? '<b style="color:#FFD24A;">⚠ 網路阻擋廣告</b><br>你的網路(校園 / 公司 / 防火牆)<br>正在攔截廣告 — 試試手機網路或 VPN。'
        : '<b style="color:#FFD24A;">⚠ Network blocks ads</b><br>Your network (school/work firewall)<br>is filtering ads — try mobile data or VPN.';
    }
    notice.innerHTML = body;

    // Close button
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', isZh ? '關閉' : 'Close');
    close.style.cssText = [
      'position:absolute', 'top:4px', 'right:6px',
      'background:transparent', 'border:none', 'color:#888',
      'font:20px sans-serif', 'cursor:pointer', 'padding:2px 10px',
      'line-height:1',
    ].join(';');
    close.addEventListener('mouseover', () => close.style.color = '#E8E4D8');
    close.addEventListener('mouseout',  () => close.style.color = '#888');
    close.addEventListener('click', () => {
      notice.remove();
      _suppressForWeek();
      try { console.log('[adblock_notice] dismissed by user, suppressed 7d'); } catch (e) {}
    });
    notice.appendChild(close);

    document.body.appendChild(notice);
    try { console.log('[adblock_notice] shown — reason:', reason); } catch (e) {}
  }

  // ─── Init ──────────────────────────────────────────────────────────
  function _init() {
    if (_isSuppressed()) {
      try { console.log('[adblock_notice] suppressed (recent dismissal)'); } catch (e) {}
      return;
    }
    _detect().then((result) => {
      if (result.blocked) _showNotice(result.reason);
    }).catch((e) => {
      try { console.warn('[adblock_notice] detect failed', e); } catch (_) {}
    });
  }

  if (document.readyState === 'complete') {
    _init();
  } else {
    window.addEventListener('load', _init, { once: true });
  }
})();
