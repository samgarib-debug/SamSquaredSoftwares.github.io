/* /book: demo booking form.
   Builds the day and time choices (the next 14 days, Monday to Friday, no South
   African public holidays, 09:00 to 17:00 SAST), checks the form, and sends it.

   Two parts. The backend object below is the only code that knows where slots
   come from and where a booking goes: today the rules in this file and the lead
   Worker at /api/lead, which checks the slot again with the same rules
   (workers/leads/src/booking.js: keep the holiday lists in step). The form code
   under it only calls backend.days(), backend.times() and backend.request().

   Interim flow: a person confirms each slot by WhatsApp or email within one
   business day. Later the SAMePOS Table Booking module replaces the backend
   object, with live availability and instant confirmation (outcome
   'confirmed'), and the form stays as it is. */
(function () {
  'use strict';

  var WHATSAPP = '27645147001';
  var EMAIL = 'info@sam-squared.com';
  var DAYS_AHEAD = 14;
  var DAY_MS = 86400000;
  var SAST_MS = 2 * 3600000; // SAST is UTC+2 all year
  var OPEN = 9 * 60;
  var CLOSE = 17 * 60;
  var TYPES = {
    online: { label: 'Online demo', minutes: 30 },
    onsite: { label: 'On-site call-out', minutes: 60 }
  };
  // Public Holidays Act 36 of 1994, plus days the President declares later
  // (add each new one here and in workers/leads/src/booking.js).
  var FIXED = ['01-01', '03-21', '04-27', '05-01', '06-16', '08-09', '09-24', '12-16', '12-25', '12-26'];
  var DECLARED = ['2026-11-04']; // local government elections
  var DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var PHONE_RE = /^\+?[\d\s().-]+$/;

  // ---------- Dates. A Date at UTC midnight stands for a SAST calendar day. ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function fromIso(s) { return new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))); }

  function easter(year) {
    var a = year % 19, b = Math.floor(year / 100), c = year % 100;
    var d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    var g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    var i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
    var m = Math.floor((a + 11 * h + 22 * l) / 451);
    return Date.UTC(year, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
  }

  var holidayCache = {};
  function holidays(year) {
    if (holidayCache[year]) return holidayCache[year];
    var days = {};
    FIXED.forEach(function (md) { days[year + '-' + md] = true; });
    var sunday = easter(year);
    days[iso(new Date(sunday - 2 * DAY_MS))] = true; // Good Friday
    days[iso(new Date(sunday + DAY_MS))] = true; // Family Day
    Object.keys(days).forEach(function (day) {
      var d = fromIso(day);
      if (d.getUTCDay() === 0) days[iso(new Date(d.getTime() + DAY_MS))] = true;
    });
    DECLARED.forEach(function (day) { if (day.indexOf(year + '-') === 0) days[day] = true; });
    holidayCache[year] = days;
    return days;
  }

  function openDays() {
    var now = new Date(Date.now() + SAST_MS);
    var today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    var out = [];
    for (var i = 1; i <= DAYS_AHEAD; i++) {
      var d = new Date(today + i * DAY_MS);
      var weekday = d.getUTCDay();
      if (weekday === 0 || weekday === 6 || holidays(d.getUTCFullYear())[iso(d)]) continue;
      out.push(d);
    }
    return out;
  }

  function times(type) {
    var step = TYPES[type].minutes, out = [];
    for (var m = OPEN; m + step <= CLOSE; m += step) out.push(pad(Math.floor(m / 60)) + ':' + pad(m % 60));
    return out;
  }

  function longDay(day) {
    var d = fromIso(day);
    return DAY_LONG[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTH_LONG[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  // ---------- Backend ----------
  // request() resolves to { outcome, error, field } where outcome is:
  //   'confirmed'  the slot is booked (not used yet: needs the booking engine)
  //   'requested'  stored; a person confirms it within one business day
  //   'received'   details stored but the slot may not have been (older Worker)
  //   'invalid'    refused a field: error and field say which
  //   'busy'       rate limited
  //   'failed'     unreachable or broken
  function leadWorker(endpoint) {
    return {
      days: openDays,
      times: times,
      request: function (data) {
        var controller = window.AbortController ? new AbortController() : null;
        var timer = controller ? setTimeout(function () { controller.abort(); }, 15000) : 0;
        return fetch(endpoint, { method: 'POST', body: data, credentials: 'same-origin', signal: controller ? controller.signal : undefined })
          .then(function (res) {
            return res.text().then(function (text) {
              var body = null;
              try { body = text ? JSON.parse(text) : null; } catch (err) { body = null; }
              // 201 with the booking: stored. 204: an older Worker that keeps
              // the contact fields but drops the slot.
              if (res.status === 201 && body && body.booking) return { outcome: 'requested' };
              if (res.status === 204) return { outcome: 'received' };
              if (res.status === 400 && body && body.error) return { outcome: 'invalid', error: body.error, field: body.field };
              if (res.status === 429) return { outcome: 'busy' };
              return { outcome: 'failed' };
            });
          })
          .catch(function () { return { outcome: 'failed' }; })
          .then(function (result) {
            clearTimeout(timer);
            return result;
          });
      }
    };
  }

  // ---------- Page ----------
  var form = document.getElementById('book');
  if (!form) return;
  var backend = leadWorker(form.getAttribute('data-endpoint'));
  var dayList = document.getElementById('day-list');
  var slotList = document.getElementById('slot-list');
  var addressField = document.getElementById('address-field');
  var address = document.getElementById('b-address');
  var interest = document.getElementById('b-interest');
  var summary = document.getElementById('book-summary');
  var alertBox = document.getElementById('book-alert');
  var send = document.getElementById('book-send');
  var done = document.getElementById('book-done');
  var sending = false;

  function checked(name) {
    var el = form.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : '';
  }
  function value(id) { return document.getElementById(id).value.trim(); }

  function current() {
    var type = checked('type') || 'online';
    var slot = checked('slot');
    return {
      type: type,
      kind: TYPES[type],
      day: checked('day'),
      time: slot ? slot.slice(11, 16) : '',
      slot: slot,
      name: value('b-name'),
      venue: value('b-venue'),
      phone: value('b-phone'),
      address: type === 'onsite' ? value('b-address') : ''
    };
  }

  function what(b) { return b.kind.label + ' (' + b.kind.minutes + ' min)'; }
  function when(b) { return longDay(b.day) + ' at ' + b.time + ' SAST'; }

  function radio(name, val, html, isChecked) {
    var label = document.createElement('label');
    label.className = 'chip';
    var input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = val;
    if (isChecked) input.checked = true;
    var span = document.createElement('span');
    span.innerHTML = html; // built from fixed strings only, never from what a visitor typed
    label.appendChild(input);
    label.appendChild(span);
    return label;
  }

  function renderDays() {
    var keep = checked('day');
    dayList.textContent = '';
    backend.days().forEach(function (d) {
      var day = iso(d);
      dayList.appendChild(radio('day', day,
        '<b>' + DAY_SHORT[d.getUTCDay()] + '</b>' + d.getUTCDate() + ' ' + MONTH_SHORT[d.getUTCMonth()], day === keep));
    });
  }

  function renderSlots() {
    var b = current();
    var keep = b.time;
    slotList.textContent = '';
    if (!b.day) {
      var empty = document.createElement('p');
      empty.className = 'book-empty';
      empty.textContent = 'Pick a day first.';
      slotList.appendChild(empty);
      return;
    }
    backend.times(b.type).forEach(function (t) {
      slotList.appendChild(radio('slot', b.day + 'T' + t + '+02:00', t, t === keep));
    });
  }

  function update() {
    var b = current();
    var onsite = b.type === 'onsite';
    addressField.hidden = !onsite;
    address.disabled = !onsite;
    address.required = onsite;
    interest.value = what(b);
    document.getElementById('slot-hint').textContent = 'South African time (SAST). ' +
      (onsite ? 'Call-outs run 60 minutes, on the hour.' : 'Online demos run 30 minutes.');
    if (b.slot) summary.textContent = what(b) + ' on ' + when(b) + '.';
    else if (b.day) summary.textContent = what(b) + ' on ' + longDay(b.day) + '. Now pick a time.';
    else summary.textContent = what(b) + '. Pick a day and a time.';
  }

  // ---------- Errors ----------
  var FIELD_IDS = { type: null, day: null, slot: null, name: 'b-name', venue: 'b-venue', phone: 'b-phone', email: 'b-email', address: 'b-address' };

  function target(key) {
    if (FIELD_IDS[key]) return document.getElementById(FIELD_IDS[key]);
    return form.querySelector('input[name="' + key + '"]:checked') || form.querySelector('input[name="' + key + '"]');
  }

  function clearErrors() {
    alertBox.hidden = true;
    alertBox.textContent = '';
    Object.keys(FIELD_IDS).forEach(function (key) {
      var err = document.getElementById('err-' + key);
      if (err) { err.hidden = true; err.textContent = ''; }
      if (FIELD_IDS[key]) document.getElementById(FIELD_IDS[key]).removeAttribute('aria-invalid');
    });
  }

  function clearError(key) {
    var err = document.getElementById('err-' + key);
    if (err) { err.hidden = true; err.textContent = ''; }
    if (FIELD_IDS[key]) document.getElementById(FIELD_IDS[key]).removeAttribute('aria-invalid');
  }

  function validate() {
    var b = current();
    var email = value('b-email');
    var digits = b.phone.replace(/\D/g, '').length;
    var errors = [];
    if (!b.day) errors.push(['day', 'Pick a day.']);
    else if (!b.slot) errors.push(['slot', 'Pick a time.']);
    if (!b.name) errors.push(['name', 'Enter your name.']);
    if (!b.venue) errors.push(['venue', 'Enter your venue or business name.']);
    if (!b.phone) errors.push(['phone', 'Enter a phone number so we can confirm on WhatsApp.']);
    else if (!PHONE_RE.test(b.phone) || digits < 9 || digits > 15) errors.push(['phone', 'Enter a phone number with 9 to 15 digits.']);
    if (!email) errors.push(['email', 'Enter your email address.']);
    else if (!EMAIL_RE.test(email)) errors.push(['email', 'Enter an email address like you@yourvenue.co.za.']);
    if (b.type === 'onsite' && !b.address) errors.push(['address', 'Enter the address we should come to.']);
    return errors;
  }

  function showErrors(errors) {
    var intro = document.createElement('p');
    intro.innerHTML = '<b>Please check your booking.</b>';
    var list = document.createElement('ul');
    errors.forEach(function (e) {
      var key = e[0], msg = e[1];
      var err = document.getElementById('err-' + key);
      if (err) { err.textContent = msg; err.hidden = false; }
      if (FIELD_IDS[key]) document.getElementById(FIELD_IDS[key]).setAttribute('aria-invalid', 'true');
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#' + (FIELD_IDS[key] || 'err-' + key);
      a.textContent = msg;
      a.addEventListener('click', function (ev) {
        var el = target(key);
        if (!el) return;
        ev.preventDefault();
        el.focus();
      });
      li.appendChild(a);
      list.appendChild(li);
    });
    alertBox.textContent = '';
    alertBox.appendChild(intro);
    alertBox.appendChild(list);
    alertBox.hidden = false;
    alertBox.focus();
  }

  // ---------- Messages people can send themselves ----------
  function message(b) {
    var text = 'Hi Sam Squared! I\'m ' + (b.name || '[your name]') + ' from ' + (b.venue || '[your venue]') + '. ';
    if (b.slot) text += 'I\'d like to book an ' + (b.type === 'online' ? 'online demo (30 min)' : 'on-site call-out (60 min)') + ' on ' + when(b) + '.';
    else text += 'I\'d like to book a demo.';
    if (b.type === 'onsite' && b.address) text += ' Address: ' + b.address.replace(/\s*\n\s*/g, ', ') + '.';
    if (b.phone) text += ' My number is ' + b.phone + '.';
    return text;
  }
  function whatsappLink(b) { return 'https://wa.me/' + WHATSAPP + '?text=' + encodeURIComponent(message(b)); }
  function mailLink(b) {
    return 'mailto:' + EMAIL + '?subject=' + encodeURIComponent('Demo booking' + (b.slot ? ': ' + when(b) : '')) +
      '&body=' + encodeURIComponent(message(b));
  }

  var CHAT_ICON = '<svg class="icon-chat" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
    '<path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /></svg>';

  function showFailure(reason) {
    var b = current();
    alertBox.textContent = '';
    var p = document.createElement('p');
    p.innerHTML = '<b>We couldn\'t send your booking.</b> ';
    p.appendChild(document.createTextNode(reason || 'Check your connection and try again, or send it to us directly. It is typed out for you.'));
    var actions = document.createElement('div');
    actions.className = 'book-actions';
    var wa = document.createElement('a');
    wa.className = 'btn btn-primary btn-icon';
    wa.href = whatsappLink(b);
    wa.target = '_blank';
    wa.rel = 'noopener';
    wa.innerHTML = CHAT_ICON + 'Send this on WhatsApp';
    var mail = document.createElement('a');
    mail.className = 'btn btn-ghost';
    mail.href = mailLink(b);
    mail.textContent = 'Email it to us';
    actions.appendChild(wa);
    actions.appendChild(mail);
    alertBox.appendChild(p);
    alertBox.appendChild(actions);
    alertBox.hidden = false;
    alertBox.focus();
  }

  var DONE = {
    confirmed: ['Thanks, {first}. You\'re booked.',
      'We\'ve booked your slot. Want to add anything? Send us a WhatsApp.'],
    requested: ['Thanks, {first}. We\'ve got your request.',
      'Sam Squared will confirm your slot on WhatsApp or email within one business day. Want it sooner? Send it to us on WhatsApp now.'],
    received: ['Almost done. Please send us your slot.',
      'We have your details, but the slot may not have reached us. Send it on WhatsApp and we\'ll confirm it within one business day.']
  };

  function showDone(outcome) {
    var b = current();
    var copy = DONE[outcome];
    document.getElementById('done-title').textContent = copy[0].replace('{first}', b.name.split(/\s+/)[0]);
    document.getElementById('done-slot').textContent = what(b) + ', ' + when(b);
    document.getElementById('done-text').textContent = copy[1];
    document.getElementById('done-wa').href = whatsappLink(b);
    form.hidden = true;
    done.hidden = false;
    var title = document.getElementById('done-title');
    title.focus();
    if (title.scrollIntoView) title.scrollIntoView({ block: 'center' });
  }

  var SERVER_MESSAGES = {
    invalid_slot: ['slot', 'That time can\'t be booked any more. Pick another time.'],
    invalid_email: ['email', 'Enter an email address like you@yourvenue.co.za.'],
    invalid_phone: ['phone', 'Enter a phone number with 9 to 15 digits.'],
    field_too_long: null,
    missing_field: null
  };

  function serverError(result) {
    var known = SERVER_MESSAGES[result.error];
    var key = result.field in FIELD_IDS ? result.field : null;
    if (result.error === 'invalid_slot') { renderDays(); renderSlots(); update(); }
    if (known) return showErrors([known]);
    if (key && result.error === 'missing_field') return showErrors([[key, 'This is needed for your booking.']]);
    if (key && result.error === 'field_too_long') return showErrors([[key, 'That is too long. Please shorten it.']]);
    showFailure();
  }

  function setBusy(busy) {
    sending = busy;
    send.disabled = busy;
    send.textContent = busy ? 'Sending...' : 'Request this slot';
  }

  function submit() {
    setBusy(true);
    var data = new FormData(form);
    data.delete('day');
    backend.request(data).then(function (result) {
      setBusy(false);
      if (DONE[result.outcome]) return showDone(result.outcome);
      if (result.outcome === 'invalid') return serverError(result);
      if (result.outcome === 'busy') return showFailure('Too many tries in a minute. Wait a moment and try again, or send it to us directly.');
      showFailure();
    });
  }

  // ---------- Wire up ----------
  form.addEventListener('change', function (e) {
    var name = e.target.name;
    if (name === 'type') { clearError('address'); renderSlots(); }
    if (name === 'day') { clearError('day'); renderSlots(); }
    if (name === 'slot') clearError('slot');
    update();
  });
  form.addEventListener('input', function (e) {
    var key = e.target.id ? e.target.id.replace(/^b-/, '') : '';
    if (key in FIELD_IDS) clearError(key);
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (sending) return;
    clearErrors();
    var errors = validate();
    if (errors.length) return showErrors(errors);
    submit();
  });
  document.getElementById('book-again').addEventListener('click', function () {
    done.hidden = true;
    form.hidden = false;
    clearErrors();
    var picked = form.querySelector('input[name="slot"]:checked');
    if (picked) picked.checked = false;
    renderDays();
    renderSlots();
    update();
    var first = form.querySelector('input[name="day"]:checked') || form.querySelector('input[name="day"]');
    if (first) first.focus();
  });

  renderDays();
  renderSlots();
  update();
  form.hidden = false;
})();
