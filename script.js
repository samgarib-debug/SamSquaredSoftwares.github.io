/* SAM² site interactions.
   Navigation and footer markup now lives statically in each page; this file
   only wires up behaviour and keeps ARIA state in sync. */
(function () {
  // HubSpot (analytics, live chat, cookie banner) is several third-party
  // scripts. Loaded in the <head> it slowed the first paint on phones by
  // seconds. Pages opt in with data-hubspot="<portal id>" on this script's
  // tag; HubSpot then loads on the visitor's first interaction, or 12 seconds
  // after the page has loaded, whichever comes first, and only once.
  var me = document.currentScript;
  var hsPortal = me && me.getAttribute('data-hubspot');
  if (hsPortal && /^\d+$/.test(hsPortal)) {
    var hsEvents = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll', 'mousemove'];
    var hsOpts = { passive: true, capture: true };
    var hsTimer = 0;
    var loadHubSpot = function () {
      hsEvents.forEach(function (ev) { window.removeEventListener(ev, loadHubSpot, hsOpts); });
      clearTimeout(hsTimer);
      if (document.getElementById('hs-script-loader')) return;
      var s = document.createElement('script');
      s.id = 'hs-script-loader';
      s.async = true;
      s.defer = true;
      s.src = 'https://js-eu1.hs-scripts.com/' + hsPortal + '.js';
      document.body.appendChild(s);
    };
    hsEvents.forEach(function (ev) { window.addEventListener(ev, loadHubSpot, hsOpts); });
    var hsLater = function () { hsTimer = setTimeout(loadHubSpot, 12000); };
    if (document.readyState === 'complete') hsLater();
    else window.addEventListener('load', hsLater, { once: true });
  }

  function setExpanded(btn, open) {
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function closeAllDropdowns() {
    document.querySelectorAll('.nav-item.open').forEach(function (item) {
      item.classList.remove('open');
      setExpanded(item.querySelector('.nav-item-toggle'), false);
    });
  }

  function init() {
    // Mobile menu
    var toggle = document.querySelector('.nav-toggle');
    var links = document.querySelector('.nav-links');
    if (toggle && links) {
      toggle.addEventListener('click', function () {
        setExpanded(toggle, links.classList.toggle('open'));
      });
    }

    // Dropdowns: click to toggle (CSS handles hover and focus-within)
    document.querySelectorAll('.nav-item-toggle').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var item = btn.closest('.nav-item');
        var wasOpen = item.classList.contains('open');
        closeAllDropdowns();
        if (!wasOpen) {
          item.classList.add('open');
          setExpanded(btn, true);
        }
      });
    });

    // Close dropdowns when clicking outside
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.nav-item')) closeAllDropdowns();
    });

    // Escape closes the open dropdown and returns focus to its trigger
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      var openItem = document.querySelector('.nav-item.open');
      if (openItem) {
        var btn = openItem.querySelector('.nav-item-toggle');
        closeAllDropdowns();
        if (btn) btn.focus();
        return;
      }
      if (links && links.classList.contains('open')) {
        links.classList.remove('open');
        setExpanded(toggle, false);
        if (toggle) toggle.focus();
      }
    });

    // Contact form: FormSubmit still handles the email. Also send a copy to our
    // own endpoint so every lead is stored. A beacon survives the page
    // navigating away and never blocks or delays the real submission.
    var leadForm = document.querySelector('form[data-lead-endpoint]');
    if (leadForm && navigator.sendBeacon && window.FormData) {
      leadForm.addEventListener('submit', function () {
        try {
          navigator.sendBeacon(leadForm.getAttribute('data-lead-endpoint'), new FormData(leadForm));
        } catch (err) {
          // Storage is a bonus; the email path must always go through.
        }
      });
    }

    // Website packages link here as /contact.html?package=landing (or five,
    // nine). Preselect that package and switch the copy from demo to quote.
    var interest = document.getElementById('interest');
    var pkg = null;
    try {
      pkg = new URLSearchParams(window.location.search).get('package');
    } catch (err) {
      pkg = null;
    }
    if (interest && pkg) {
      for (var i = 0; i < interest.options.length; i++) {
        if (interest.options[i].getAttribute('data-package') !== pkg) continue;
        interest.selectedIndex = i;
        var heading = document.querySelector('.page-head h1');
        var intro = document.querySelector('.page-head p');
        var submit = document.querySelector('form.contact [type="submit"]');
        if (heading) heading.textContent = 'Get your website quote';
        if (intro) intro.textContent = 'Tell us about your business and we\'ll come back with a plan and a quote.';
        if (submit) submit.textContent = 'Request a quote';
        break;
      }
    }

    // Keep the footer copyright year current
    var year = document.getElementById('year');
    if (year) year.textContent = new Date().getFullYear();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
