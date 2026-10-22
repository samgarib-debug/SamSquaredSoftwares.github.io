/* Users & permissions page.
   Manages SAMePOS console operators in the samepos-fleet Supabase project.
   Every rule lives server-side: the fleet_* RPCs refuse anyone who is not an
   active super admin, and RLS hides everything else. This page only calls
   them, so hiding a button here is convenience, never security. */
(function () {
  var SUPABASE_URL = 'https://bewztjjiuwfvlanxdpjb.supabase.co';
  // Publishable key: designed to ship in browsers. RLS and the RPCs gate access.
  var SUPABASE_KEY = 'sb_publishable_bzXh_m9GxU19UprECDws2w_88yezk3c';
  var CONSOLE_URL = 'https://samepos-dashboard.pages.dev';

  var ROLES = [
    { id: 'super_admin', label: 'Super admin' },
    { id: 'support', label: 'Support' },
    { id: 'read_only', label: 'Read only' },
    { id: 'owner', label: 'Owner', venues: 'many' },
    { id: 'general_manager', label: 'General manager', venues: 'one' }
  ];

  // Mirrors the fleet RLS helpers (private.op_visible_nodes and friends).
  var PERMISSIONS = [
    { label: 'Manage users and invites', roles: ['super_admin'] },
    { label: 'Manage licences', roles: ['super_admin'] },
    { label: 'Send commands to venue machines', roles: ['super_admin'] },
    { label: 'See every client and venue', roles: ['super_admin', 'support', 'read_only'] },
    { label: 'See only their assigned venues', roles: ['owner', 'general_manager'] },
    { label: 'Acknowledge venue alerts', roles: ['super_admin', 'support', 'read_only', 'owner', 'general_manager'] }
  ];

  var db = null;
  var me = null;
  var operators = [];
  var invites = [];
  var removed = [];
  var nodes = [];
  var tenants = {};
  var lastInviteText = '';
  // True once samepos-fleet has fleet_remove_operator / fleet_restore_operator and
  // the sign-in trigger; fleet_operators() then also returns a 'removed' list.
  var hasRemove = false;
  var refreshSeq = 0;

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (text != null) node.textContent = text;
    return node;
  }

  function role(id) {
    for (var i = 0; i < ROLES.length; i++) if (ROLES[i].id === id) return ROLES[i];
    // 'admin' passes the table's CHECK but no RPC can assign it.
    return { id: id, label: id === 'admin' ? 'Admin (legacy)' : id, legacy: true };
  }

  function say(id, text, kind) {
    var m = $(id);
    m.textContent = text || '';
    m.className = 'users-msg' + (kind ? ' is-' + kind : '');
  }

  function errText(err) {
    if (!err) return 'Something went wrong.';
    var text = err.message || String(err);
    if (/failed to fetch|networkerror|load failed/i.test(text)) return 'Could not reach the server. Check your connection and try again.';
    return text;
  }

  function fmtAgo(iso) {
    if (!iso) return 'Never';
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 2) return 'Just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' h ago';
    var days = Math.round(hrs / 24);
    if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
    return fmtDate(iso);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function show(which) {
    ['sign-in', 'denied', 'app'].forEach(function (id) { $(id).hidden = id !== which; });
    $('boot-msg').hidden = true;
  }

  // ---------- Auth ----------

  function start() {
    if (!window.supabase || !window.supabase.createClient) {
      say('boot-msg', 'Could not load the sign-in library. Refresh the page to try again.', 'error');
      return;
    }
    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    db.auth.onAuthStateChange(function (event) {
      if (event === 'SIGNED_OUT') { me = null; show('sign-in'); }
    });
    db.auth.getSession().then(function (res) {
      var session = res.data && res.data.session;
      if (session) loadMe(session.user); else show('sign-in');
    }).catch(function () { show('sign-in'); });
  }

  function loadMe(user) {
    db.from('master_operator')
      .select('id, display_name, email, role, status, is_deleted')
      .eq('id', user.id)
      .maybeSingle()
      .then(function (res) {
        var row = res.data;
        if (res.error) return deny('Could not check your account: ' + errText(res.error));
        if (!row) return deny('This sign-in has no SAMePOS console account.');
        if (row.is_deleted || row.status !== 'active') return deny('Your account is suspended. Ask a super admin to reactivate it.');
        if (row.role !== 'super_admin') return deny('You are signed in as ' + role(row.role).label + '. Only super admins can manage users.');
        me = row;
        $('me-name').textContent = row.display_name || row.email;
        show('app');
        refresh();
      })
      .catch(function (err) { deny('Could not check your account: ' + errText(err)); });
  }

  function deny(text) {
    $('denied-msg').textContent = text;
    show('denied');
  }

  function initAuth() {
    var form = $('sign-in');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      say('si-msg', 'Signing in…');
      db.auth.signInWithPassword({ email: form.email.value.trim(), password: form.password.value })
        .then(function (res) {
          btn.disabled = false;
          if (res.error) return say('si-msg', errText(res.error), 'error');
          form.password.value = '';
          say('si-msg', '');
          loadMe(res.data.user);
        })
        .catch(function (err) {
          btn.disabled = false;
          say('si-msg', errText(err), 'error');
        });
    });
    document.querySelectorAll('[data-sign-out]').forEach(function (b) {
      b.addEventListener('click', function () { db.auth.signOut(); });
    });
  }

  // ---------- Data ----------

  // PostgREST caps each response (1000 rows by default), so page until a short page.
  function fetchAll(table, cols, filter) {
    var PAGE = 1000;
    var rows = [];
    function next(from) {
      var q = db.from(table).select(cols).order('name').order('id').range(from, from + PAGE - 1);
      if (filter) q = filter(q);
      return q.then(function (res) {
        if (res.error) return res;
        rows = rows.concat(res.data || []);
        return res.data && res.data.length === PAGE ? next(from + PAGE) : { data: rows, error: null };
      });
    }
    return next(0);
  }

  function refresh() {
    var seq = ++refreshSeq;
    say('app-msg', 'Loading…');
    return Promise.all([
      db.rpc('fleet_operators'),
      fetchAll('node', 'id, name, tenant_id', function (q) { return q.eq('is_retired', false); }),
      fetchAll('tenant', 'id, name')
    ]).then(function (r) {
      // A newer refresh has started; let it own the page.
      if (seq !== refreshSeq) return false;
      var ops = r[0], nd = r[1], tn = r[2];
      var err = ops.error || nd.error || tn.error || (ops.data && ops.data.error);
      if (err) { say('app-msg', 'Could not load users: ' + errText(err), 'error'); return false; }
      operators = ops.data.operators || [];
      invites = ops.data.invites || [];
      hasRemove = Array.isArray(ops.data.removed);
      removed = ops.data.removed || [];
      nodes = nd.data || [];
      tenants = {};
      (tn.data || []).forEach(function (t) { tenants[t.id] = t.name; });
      say('app-msg', '');
      render();
      return true;
    }).catch(function (err) {
      if (seq === refreshSeq) say('app-msg', 'Could not load users: ' + errText(err), 'error');
      return false;
    });
  }

  // Runs one RPC, reports its error verbatim (they are written for humans), reloads.
  function act(fn, params, okText) {
    say('app-msg', 'Saving…');
    return db.rpc(fn, params).then(function (res) {
      if (res.error) { say('app-msg', errText(res.error), 'error'); return false; }
      return refresh().then(function (loaded) {
        if (loaded) say('app-msg', okText, 'ok');
        return true;
      });
    }).catch(function (err) {
      say('app-msg', errText(err), 'error');
      return false;
    });
  }

  function nodeName(id) {
    for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return nodes[i].name;
    return 'Unknown venue';
  }

  // ---------- Render ----------

  function render() {
    renderOperators();
    renderInvites();
    renderRemoved();
    $('stat-active').textContent = operators.filter(function (o) { return o.status === 'active'; }).length;
    $('stat-suspended').textContent = operators.filter(function (o) { return o.status === 'suspended'; }).length;
    $('stat-invited').textContent = invites.length;
    $('stat-total').textContent = operators.length;
  }

  function renderOperators() {
    var q = $('u-search').value.trim().toLowerCase();
    var status = $('u-filter').value;
    var tbody = $('user-rows');
    tbody.textContent = '';

    var shown = operators.filter(function (o) {
      var text = ((o.display_name || '') + ' ' + (o.email || '')).toLowerCase();
      return (!q || text.indexOf(q) > -1) && (status === 'all' || o.status === status);
    });

    shown.forEach(function (o) {
      var self = me && o.id === me.id;
      var r = role(o.role);
      var tr = el('tr');

      var who = el('td');
      var name = el('span', { class: 'u-name' }, o.display_name || o.email);
      if (self) name.appendChild(el('span', { class: 'tag' }, 'You'));
      who.appendChild(name);
      who.appendChild(el('span', { class: 'u-email' }, o.email || ''));
      tr.appendChild(who);

      var st = el('td');
      st.appendChild(el('span', { class: 'pill pill-' + o.status }, o.status));
      tr.appendChild(st);

      var roleCell = el('td');
      var sel = el('select', { 'aria-label': 'Role for ' + (o.display_name || o.email) });
      roleOptions(sel, o.role);
      if (self) { sel.disabled = true; sel.title = 'You cannot change your own role'; }
      sel.addEventListener('change', function () { changeRole(o, sel); });
      roleCell.appendChild(sel);
      tr.appendChild(roleCell);

      var venues = el('td');
      if (r.venues) {
        var list = (o.venues || []).map(function (v) { return v.name; });
        venues.textContent = list.length ? list.join(', ') : 'None assigned';
        if (!list.length) venues.className = 'warn';
      } else {
        venues.textContent = 'All';
        venues.className = 'muted';
      }
      tr.appendChild(venues);

      if (hasRemove) {
        tr.appendChild(el('td', { title: 'Joined ' + fmtDate(o.created_at) }, fmtAgo(o.last_login_at)));
      } else {
        tr.appendChild(el('td', { class: 'muted', title: 'Sign-ins are not recorded yet. Joined ' + fmtDate(o.created_at) }, '—'));
      }

      var actions = el('td', { class: 'u-actions' });
      if (r.venues) {
        actions.appendChild(button('Venues', function () {
          openVenues(o, o.role, function () {});
        }));
      }
      if (!self) {
        var suspending = o.status === 'active';
        actions.appendChild(button(suspending ? 'Suspend' : 'Reactivate', function () {
          var effect = hasRemove
            ? 'They are signed out and cannot sign in until you reactivate them.'
            : 'They lose access to the console straight away.';
          if (suspending && !confirm('Suspend ' + (o.display_name || o.email) + '? ' + effect)) return;
          if (!suspending && !confirm('Reactivate ' + (o.display_name || o.email) + ' as ' + r.label + '? They can sign in again straight away.')) return;
          act('fleet_set_operator_status', { p_operator: o.id, p_status: suspending ? 'suspended' : 'active' },
            (o.display_name || o.email) + (suspending ? ' suspended.' : ' reactivated.'));
        }, suspending ? 'danger' : null));
        if (hasRemove) {
          actions.appendChild(button('Remove', function () {
            var who = o.display_name || o.email;
            if (!confirm('Remove ' + who + '? They are signed out, cannot sign in, and move to Removed users. You can restore them later.')) return;
            act('fleet_remove_operator', { p_operator: o.id }, who + ' removed.');
          }, 'danger'));
        }
      }
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });

    $('users-empty').hidden = shown.length > 0;
  }

  function renderInvites() {
    var tbody = $('invite-rows');
    tbody.textContent = '';
    invites.forEach(function (inv) {
      var tr = el('tr');
      tr.appendChild(el('td', null, inv.email));
      tr.appendChild(el('td', null, role(inv.role).label));
      var ids = inv.node_ids || [];
      tr.appendChild(el('td', null, ids.length ? ids.map(nodeName).join(', ') : 'All'));
      tr.appendChild(el('td', null, fmtDate(inv.expires_at)));
      var actions = el('td', { class: 'u-actions' });
      actions.appendChild(button('Revoke', function () {
        if (!confirm('Revoke the invite for ' + inv.email + '?')) return;
        act('fleet_revoke_invite', { p_id: inv.id }, 'Invite for ' + inv.email + ' revoked.');
      }, 'danger'));
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
    $('invites-empty').hidden = invites.length > 0;
  }

  function renderRemoved() {
    var tbody = $('removed-rows');
    tbody.textContent = '';
    removed.forEach(function (o) {
      var who = o.display_name || o.email;
      var tr = el('tr');
      var cell = el('td');
      cell.appendChild(el('span', { class: 'u-name' }, who));
      cell.appendChild(el('span', { class: 'u-email' }, o.email || ''));
      tr.appendChild(cell);
      tr.appendChild(el('td', null, role(o.role).label));
      tr.appendChild(el('td', null, fmtDate(o.removed_at)));
      var actions = el('td', { class: 'u-actions' });
      actions.appendChild(button('Restore', function () {
        act('fleet_restore_operator', { p_operator: o.id }, who + ' restored as Suspended. Reactivate them when ready.');
      }));
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
    $('removed-block').hidden = removed.length === 0;
  }

  function roleOptions(select, current) {
    select.textContent = '';
    var list = ROLES.slice();
    if (current && role(current).legacy) list.unshift(role(current));
    list.forEach(function (r) {
      var opt = el('option', { value: r.id }, r.label);
      if (r.legacy) opt.disabled = true;
      if (r.id === current) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function button(label, onClick, variant) {
    var b = el('button', { type: 'button', class: 'btn-sm' + (variant ? ' btn-sm-' + variant : '') }, label);
    b.addEventListener('click', onClick);
    return b;
  }

  // ---------- Role changes ----------

  function changeRole(o, sel) {
    var next = sel.value;
    var who = o.display_name || o.email;
    var revert = function () { sel.value = o.role; };

    if (role(next).venues) {
      // Venue-scoped roles see nothing without venues, so pick them first.
      openVenues(o, next, revert);
      return;
    }
    if (next === 'super_admin' && !confirm('Make ' + who + ' a super admin? They will be able to manage every user.')) return revert();
    if (role(o.role).venues && !confirm(who + ' will lose their venue links and see every client. Continue?')) return revert();
    sel.disabled = true;
    act('fleet_set_operator_role', { p_operator: o.id, p_role: next }, who + ' is now ' + role(next).label + '.')
      .then(function (ok) {
        if (!ok) revert();
        sel.disabled = false;
      });
  }

  // ---------- Venue picker ----------

  function buildPicker(container, mode, selected, name) {
    container.textContent = '';
    // A radio group keeps only the last checked box, so with several venues
    // preselected a GM save would silently drop the rest: make them choose.
    if (mode === 'one' && selected.length > 1) selected = [];
    if (!nodes.length) {
      container.appendChild(el('p', { class: 'auth-hint' }, 'No venues exist yet.'));
      return;
    }
    var groups = {};
    nodes.forEach(function (n) {
      var g = tenants[n.tenant_id] || 'Other';
      (groups[g] = groups[g] || []).push(n);
    });
    Object.keys(groups).sort().forEach(function (g) {
      container.appendChild(el('p', { class: 'venue-group' }, g));
      groups[g].forEach(function (n) {
        var id = name + '-' + n.id;
        var row = el('div', { class: 'venue-opt' });
        var input = el('input', { type: mode === 'one' ? 'radio' : 'checkbox', name: name, value: n.id, id: id });
        if (selected.indexOf(n.id) > -1) input.checked = true;
        row.appendChild(input);
        row.appendChild(el('label', { for: id }, n.name));
        container.appendChild(row);
      });
    });
  }

  function picked(container) {
    return Array.prototype.map.call(container.querySelectorAll('input:checked'), function (i) { return i.value; });
  }

  var dialogDone = null;

  function openVenues(o, targetRole, onCancel) {
    var r = role(targetRole);
    var who = o.display_name || o.email;
    var current = (o.venues || []).map(function (v) { return v.node_id; });
    $('vd-title').textContent = (targetRole === o.role ? 'Venues for ' : 'Make ' + r.label + ': ') + who;
    $('vd-hint').textContent = r.venues !== 'one'
      ? 'Pick every venue this owner should see.'
      : current.length > 1
        ? 'A general manager runs exactly one venue. Pick the one they keep.'
        : 'A general manager runs exactly one venue.';
    buildPicker($('vd-options'), r.venues, current, 'vd-venue');
    say('vd-msg', '');
    dialogDone = { o: o, role: targetRole, cancel: onCancel };
    $('venue-dialog').showModal();
  }

  function initDialog() {
    var dlg = $('venue-dialog');
    function close(cancelled) {
      // Once a save is in flight it cannot be called back, so cancel waits for it.
      if (cancelled && dialogDone && dialogDone.saving) return;
      if (cancelled && dialogDone && dialogDone.cancel) dialogDone.cancel();
      dialogDone = null;
      if (dlg.open) dlg.close();
    }
    $('vd-cancel').addEventListener('click', function () { close(true); });
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); close(true); });

    $('venue-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var job = dialogDone;
      if (!job) return;
      var ids = picked($('vd-options'));
      if (!ids.length) return say('vd-msg', 'Pick at least one venue.', 'error');
      var who = job.o.display_name || job.o.email;
      var btn = dlg.querySelector('button[type=submit]');
      var roleChanged = job.role !== job.o.role;
      var roleLanded = false;
      job.saving = true;
      btn.disabled = true;
      $('vd-cancel').disabled = true;
      say('vd-msg', 'Saving…');

      function settle() {
        job.saving = false;
        btn.disabled = false;
        $('vd-cancel').disabled = false;
      }

      // Role first: fleet_set_operator_venues only accepts owners and GMs.
      var step = roleChanged
        ? db.rpc('fleet_set_operator_role', { p_operator: job.o.id, p_role: job.role })
        : Promise.resolve({});
      step.then(function (res) {
        if (res.error) throw res.error;
        roleLanded = roleChanged;
        return db.rpc('fleet_set_operator_venues', { p_operator: job.o.id, p_node_ids: ids });
      }).then(function (res) {
        if (res.error) throw res.error;
        settle();
        close(false);
        return refresh().then(function (loaded) {
          if (loaded) say('app-msg', who + ' saved as ' + role(job.role).label + '.', 'ok');
        });
      }).catch(function (err) {
        if (!roleLanded) {
          settle();
          say('vd-msg', errText(err), 'error');
          return;
        }
        // The two calls are separate, so undo the role rather than leave them
        // venue-scoped with no venues.
        return db.rpc('fleet_set_operator_role', { p_operator: job.o.id, p_role: job.o.role })
          .then(function (undo) { if (undo.error) throw undo.error; })
          .then(function () {
            say('vd-msg', 'Venues were not saved, so ' + who + ' is back to ' + role(job.o.role).label + ': ' + errText(err), 'error');
          }, function (undoErr) {
            say('vd-msg', 'Venues were not saved and the role change could not be undone (' + errText(undoErr) +
              '). ' + who + ' is now ' + role(job.role).label + ' with no venues: try again or change their role.', 'error');
          })
          .then(function () {
            settle();
            refresh();
          });
      });
    });
  }

  // ---------- Invite ----------

  function syncInviteVenues() {
    var r = role($('u-role').value);
    $('u-venues').hidden = !r.venues;
    if (r.venues) {
      $('u-venues-legend').textContent = r.venues === 'one' ? 'Venue (pick one)' : 'Venues (pick at least one)';
      buildPicker($('u-venue-options'), r.venues, picked($('u-venue-options')), 'u-venue');
    }
  }

  function initInvite() {
    var form = $('add-user');
    roleOptions($('u-role'), 'read_only');
    $('u-role').addEventListener('change', syncInviteVenues);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('u-name').value.trim();
      var email = $('u-email').value.trim().toLowerCase();
      var r = role($('u-role').value);
      var ids = r.venues ? picked($('u-venue-options')) : [];
      $('invite-next').hidden = true;

      if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email)) return say('add-msg', 'Enter a full email address.', 'error');
      if (r.venues && !ids.length) return say('add-msg', 'Pick a venue for this role.', 'error');
      if (r.id === 'super_admin' && !confirm('Invite ' + email + ' as a super admin? They will be able to manage every user.')) return;

      var btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      say('add-msg', 'Creating invite…');
      db.rpc('fleet_invite_operator', {
        p_email: email,
        p_role: r.id,
        p_display_name: name || null,
        p_note: null,
        p_node_ids: r.venues ? ids : null
      }).then(function (res) {
        btn.disabled = false;
        if (res.error) return say('add-msg', errText(res.error), 'error');
        form.reset();
        roleOptions($('u-role'), 'read_only');
        syncInviteVenues();
        say('add-msg', 'Invite created for ' + email + '.', 'ok');
        lastInviteText = 'Hi' + (name ? ' ' + name : '') + ', you have been invited to the SAMePOS console as ' +
          r.label + '. Create your account at ' + CONSOLE_URL + ' using ' + email +
          ' within 14 days. Your access switches on as soon as you sign up.';
        $('invite-next-text').textContent = 'No email is sent. Send them this message:';
        $('invite-next').hidden = false;
        refresh();
      }).catch(function (err) {
        btn.disabled = false;
        say('add-msg', errText(err), 'error');
      });
    });

    $('copy-invite').addEventListener('click', function () {
      var done = function () { say('add-msg', 'Invite message copied.', 'ok'); };
      if (navigator.clipboard) {
        navigator.clipboard.writeText(lastInviteText).then(done, function () { window.prompt('Copy this message:', lastInviteText); });
      } else {
        window.prompt('Copy this message:', lastInviteText);
      }
    });
  }

  // ---------- Permissions table ----------

  function renderPermTable() {
    var table = $('perm-table');
    var head = el('tr');
    head.appendChild(el('th', { scope: 'col' }, 'Permission'));
    ROLES.forEach(function (r) { head.appendChild(el('th', { scope: 'col' }, r.label)); });
    var thead = el('thead');
    thead.appendChild(head);
    table.appendChild(thead);

    var tbody = el('tbody');
    PERMISSIONS.forEach(function (p) {
      var tr = el('tr');
      tr.appendChild(el('th', { scope: 'row' }, p.label));
      ROLES.forEach(function (r) {
        var yes = p.roles.indexOf(r.id) > -1;
        var td = el('td', { class: yes ? 'perm-yes' : 'perm-no' }, yes ? '✓' : '–');
        td.appendChild(el('span', { class: 'sr-only' }, yes ? ' allowed' : ' not allowed'));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }

  function init() {
    renderPermTable();
    initAuth();
    initInvite();
    initDialog();
    $('u-search').addEventListener('input', renderOperators);
    $('u-filter').addEventListener('change', renderOperators);
    $('refresh').addEventListener('click', refresh);
    start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
