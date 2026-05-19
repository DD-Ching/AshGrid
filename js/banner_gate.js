// js/banner_gate.js — Phase 131b
// =========================================================================
// Hostname-gate for Adsterra banner inventory. CrazyGames basic-launch
// policy prohibits third-party banner ads on their portal; the same build
// runs on self-hosted (ashgrid.io / dev.ashgrid.pages.dev) where Adsterra
// is allowed, so we detect host at parse time and skip ad-script injection
// when running on crazygames.com (or with ?crazyGames=1 for QA).
//
// Classic-script. MUST load synchronously in <head> before the first inline
// ad-slot script in <body>.
//
// Declares globally:
//   window.__onCrazyGames           boolean — true on CG portal / ?crazyGames=1
//   window.__loadAdsterra(key, height, width)
//                                   inserts an Adsterra iframe banner at the
//                                   current parser cursor via document.write
//                                   (synchronous, preserves atOptions ordering)
//   window.__loadAdsterraNative(host, key)
//                                   inserts an Adsterra native (effectivecpm
//                                   network) async invoke.js at the cursor
//
// Visual chrome of the ad-slot containers is ALSO hidden on CG via the
// .on-crazygames class added to <html> below — see matching CSS rule in
// index.html <style> block.

(function() {
  'use strict';

  var onCG = /crazygames\.com$/.test(location.hostname)
          || /[?&]crazyGames=1\b/.test(location.search);
  window.__onCrazyGames = onCG;

  // <html> (documentElement) is available immediately during parsing; <body>
  // isn't yet. The CSS rule keys off this class so the gradient-background
  // placeholder boxes don't render on CG either.
  if (onCG) {
    document.documentElement.classList.add('on-crazygames');
  }

  // Adsterra iframe banner (highperformanceformat.com). document.write keeps
  // invoke.js synchronous so it reads window.atOptions before the next slot
  // overwrites it — same execution order as the literal <script src> tags
  // this helper replaces.
  window.__loadAdsterra = function(key, height, width) {
    if (onCG) return;
    window.atOptions = {
      key: key, format: 'iframe',
      height: height, width: width, params: {}
    };
    document.write(
      '<script src="https://www.highperformanceformat.com/' + key +
      '/invoke.js"><\/script>'
    );
  };

  // Adsterra native banner (effectivecpmnetwork.com). Used by the 970×250
  // death-overlay slot. invoke.js is async by design and renders into a
  // sibling <div id="container-<key>"> placed alongside this call site.
  window.__loadAdsterraNative = function(host, key) {
    if (onCG) return;
    document.write(
      '<script async="async" data-cfasync="false" src="https://' +
      host + '/' + key + '/invoke.js"><\/script>'
    );
  };
})();
