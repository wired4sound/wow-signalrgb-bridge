/* WoW Lighting Bridge settings page. Plain JS, served by src/server.js. */
(function () {
  'use strict';

  var P = window.WowPatterns;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  var data = { effects: {}, patterns: {}, params: {}, rules: null, settings: null, srgbEffects: [], state: null };
  var cards = {};          // effect id -> { el, def, canvas, ctx, state, timer }
  var rulesDirty = false;
  var settingsDirty = false;
  var stopped = false;

  // ---------- helpers ----------

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'X-Bridge': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || r.statusText);
        return j;
      });
    });
  }

  var toastTimer;
  function toast(msg, isErr) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, isErr ? 5000 : 2500);
  }

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  function ago(ms) {
    if (ms === null || ms === undefined) return 'never';
    if (ms < 1500) return 'just now';
    if (ms < 60000) return Math.round(ms / 1000) + 's ago';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm ago';
    return Math.round(ms / 3600000) + 'h ago';
  }

  function fmtParam(key, v) {
    if (key === 'speedMs') return v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + ' s' : v + ' ms';
    if (key === 'floor' || key === 'brightness' || key === 'width') return v + '%';
    return String(v);
  }

  function setPill(id, cls, text, title) {
    var p = $('#' + id);
    p.className = 'pill ' + cls;
    p.lastElementChild.textContent = text;
    p.title = title || text;
  }

  // ---------- tabs ----------

  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.dataset.tab); });
  });
  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === name)); });
    document.querySelectorAll('.panel').forEach(function (p) { p.hidden = p.id !== 'tab-' + name; });
    try { localStorage.setItem('tab', name); } catch (e) { /* storage unavailable */ }
  }
  try { var saved = localStorage.getItem('tab'); if (saved && $('#tab-' + saved)) showTab(saved); } catch (e) { /* ignore */ }

  // ---------- effects ----------

  function usedBy(name) {
    if (!data.rules) return [];
    return data.rules.rules.filter(function (r) { return r.effect === name && r.enabled !== false; }).map(function (r) { return r.name; });
  }

  function buildCard(id) {
    var def = JSON.parse(JSON.stringify(data.effects[id]));
    var node = $('#effect-card').content.firstElementChild.cloneNode(true);
    var c = { id: id, el: node, def: def, canvas: $('canvas', node), state: {}, timer: null };
    c.ctx = c.canvas.getContext('2d');
    $('h3', node).textContent = def.name;

    var sel = $('.pattern', node);
    Object.keys(data.patterns).forEach(function (k) {
      if (data.patterns[k].live && !def.source) return; // live patterns need a value source
      sel.appendChild(el('option', { value: k, text: data.patterns[k].label }));
    });
    sel.value = def.pattern;
    sel.addEventListener('change', function () {
      c.def.pattern = sel.value;
      c.state = {};
      renderControls(c);
      scheduleSave(c);
    });

    $('.preview-btn', node).addEventListener('click', function () { previewEffect(c); });
    $('.reset-btn', node).addEventListener('click', function () {
      api('POST', '/api/effects/' + id + '/reset').then(function (d) {
        c.def = d; data.effects[id] = d; c.state = {};
        sel.value = d.pattern;
        renderControls(c);
        status(c, 'Reset to default', 'good');
      }).catch(function (e) { status(c, e.message, 'err'); });
    });

    renderControls(c);
    cards[id] = c;
    return node;
  }

  function renderControls(c) {
    var info = data.patterns[c.def.pattern];
    var colors = $('.colors', c.el);
    colors.textContent = '';
    while (c.def.colors.length < info.colors) c.def.colors.push(c.def.colors[c.def.colors.length - 1] || '#ffffff');
    for (var i = 0; i < info.colors; i++) {
      (function (i) {
        var input = el('input', { type: 'color', value: c.def.colors[i], 'aria-label': 'Color ' + (i + 1) });
        input.addEventListener('input', function () { c.def.colors[i] = input.value; scheduleSave(c); });
        colors.appendChild(el('label', { class: 'swatch' }, [input, el('span', { text: colorLabel(c.def.pattern, i) })]));
      })(i);
    }

    var params = $('.params', c.el);
    params.textContent = '';
    info.params.forEach(function (key) {
      var spec = data.params[key];
      if (c.def[key] === undefined) c.def[key] = spec.def;
      var out = el('output', { text: fmtParam(key, c.def[key]) });
      var input = el('input', { type: 'range', min: spec.min, max: spec.max, step: spec.step, value: c.def[key], 'aria-label': spec.label });
      input.addEventListener('input', function () {
        c.def[key] = Number(input.value);
        out.textContent = fmtParam(key, c.def[key]);
        scheduleSave(c);
      });
      params.appendChild(el('div', { class: 'row' }, [el('span', { text: spec.label }), out, input]));
    });
    updateUsed(c);
  }

  function colorLabel(pattern, i) {
    var names = {
      flash: ['On', 'Off'], sweep: ['Band', 'Background'], sparkle: ['Base', 'Sparkle', 'Sparkle'],
      mix: ['Color 1', 'Color 2'], wave: ['Color 1', 'Color 2', 'Color 3'], gauge: ['Fill', 'Empty'], gaugeFade: ['Full', 'Empty'],
    };
    return (names[pattern] && names[pattern][i]) || (i === 0 ? 'Color' : 'Color ' + (i + 1));
  }

  function updateUsed(c) {
    var used = usedBy(c.def.name);
    $('.used', c.el).textContent = used.length ? 'Used by: ' + used.join(', ') : 'Not used by any rule';
  }

  function status(c, msg, cls) {
    var s = $('.save-status', c.el);
    s.textContent = msg;
    s.className = 'status save-status ' + (cls || '');
  }

  function scheduleSave(c) {
    status(c, 'Saving…');
    clearTimeout(c.timer);
    c.timer = setTimeout(function () {
      api('PUT', '/api/effects/' + c.id, c.def).then(function (d) {
        data.effects[c.id] = d;
        status(c, 'Saved', 'good');
      }).catch(function (e) { status(c, e.message, 'err'); });
    }, 350);
  }

  function previewEffect(c) {
    var btn = $('.preview-btn', c.el);
    clearTimeout(c.timer);
    // Save first so the lights show exactly what's on screen.
    api('PUT', '/api/effects/' + c.id, c.def)
      .then(function () { return api('POST', '/api/preview', { effect: c.def.name, ms: 5000 }); })
      .then(function () {
        var left = 5;
        btn.disabled = true;
        btn.textContent = 'On your lights… ' + left;
        var iv = setInterval(function () {
          left--;
          if (left <= 0) { clearInterval(iv); btn.disabled = false; btn.textContent = 'Preview on lights'; }
          else btn.textContent = 'On your lights… ' + left;
        }, 1000);
      })
      .catch(function (e) { toast(e.message, true); });
  }

  // One animation loop for every preview canvas.
  var t0 = performance.now();
  function animate(now) {
    Object.keys(cards).forEach(function (id) {
      var c = cards[id];
      if (!c.el.isConnected) return;
      try { P.render(c.ctx, c.canvas.width, c.canvas.height, now - t0, c.def, c.state); } catch (e) { /* keep animating others */ }
    });
    requestAnimationFrame(animate);
  }

  function renderEffects() {
    var grid = $('#effects');
    grid.textContent = '';
    cards = {};
    Object.keys(data.effects).forEach(function (id) { grid.appendChild(buildCard(id)); });
  }

  // ---------- rules ----------

  var WHERE = [
    ['all', 'Everywhere'], ['pc', 'PC only'], ['ceiling', 'Ceiling only'],
    ['radiator', 'Liquid cooling fans'], ['rear', 'Back fan (left)'], ['back', 'Right fans'], ['bottom', 'Bottom fans'], ['strip', 'Side strip'],
  ];

  var EVENT_TEXT = {
    PLAYER_DIED: 'You die (until you release or revive)',
    PLAYER_GHOST: 'You release your spirit (until you revive)',
    PLAYER_ALIVE: 'You come back to life',
    PLAYER_LOW_HEALTH_START: 'Your health drops below the threshold',
    PLAYER_LOW_MANA_START: 'Your mana drops below the threshold',
    MANA_AVAILABLE: 'Always, while you have a mana bar (shows it live)',
    PLAYER_COMBAT_START: 'You enter combat',
    ENCOUNTER_START: 'A boss fight starts',
    ENCOUNTER_WIN: 'A boss dies',
    ENCOUNTER_WIPE: 'Your group wipes on a boss',
    SPELL_AURA_APPLIED: 'You gain an aura',
  };

  function describe(r) {
    var ev = [].concat(r.event);
    if (r.critical && ev.some(function (e) { return /DAMAGE/.test(e); })) return 'You land a critical hit';
    if (r.spellName && ev[0] === 'SPELL_AURA_APPLIED') return 'You gain ' + [].concat(r.spellName).join(', ');
    return ev.map(function (e) { return EVENT_TEXT[e] || e; }).join(' or ');
  }

  function effectOptions(current) {
    var sel = el('select');
    var wow = el('optgroup', { label: 'Bridge effects' });
    var names = {};
    Object.keys(data.effects).forEach(function (id) {
      var n = data.effects[id].name;
      names[n.toLowerCase()] = true;
      wow.appendChild(el('option', { value: n, text: n }));
    });
    sel.appendChild(wow);
    var other = el('optgroup', { label: 'Other SignalRGB effects' });
    data.srgbEffects.forEach(function (n) {
      if (!names[n.toLowerCase()]) { names[n.toLowerCase()] = true; other.appendChild(el('option', { value: n, text: n })); }
    });
    if (current && !names[current.toLowerCase()]) other.appendChild(el('option', { value: current, text: current + ' (not found)' }));
    if (other.children.length) sel.appendChild(other);
    sel.value = current;
    return sel;
  }

  function renderRules() {
    var body = $('#rules');
    body.textContent = '';
    data.rules.rules.forEach(function (r) {
      var on = el('input', { type: 'checkbox', 'aria-label': 'Enable ' + r.name });
      on.checked = r.enabled !== false;
      var tr = el('tr', { class: on.checked ? '' : 'off' });
      on.addEventListener('change', function () {
        if (on.checked) delete r.enabled; else r.enabled = false;
        tr.className = on.checked ? '' : 'off';
        markRules();
      });

      var sel = effectOptions(r.effect);
      sel.addEventListener('change', function () { r.effect = sel.value; markRules(); });

      var where = el('select', { 'aria-label': 'Where' });
      var cur = r.zones ? [].concat(r.zones) : ['all'];
      var curKey = cur.join(',');
      WHERE.forEach(function (w) { where.appendChild(el('option', { value: w[0], text: w[1] })); });
      if (!WHERE.some(function (w) { return w[0] === curKey; })) where.appendChild(el('option', { value: curKey, text: 'Custom: ' + curKey }));
      where.value = curKey;
      where.addEventListener('change', function () { r.zones = where.value.split(','); markRules(); });

      var prio = el('input', { type: 'number', min: 0, max: 999, value: r.priority === undefined ? 50 : r.priority, 'aria-label': 'Priority' });
      prio.addEventListener('input', function () { r.priority = Number(prio.value); markRules(); });

      var lasts = el('div', { class: 'lasts' });
      var secs = el('input', { type: 'number', min: 0.1, step: 0.1, value: r.durationMs ? r.durationMs / 1000 : '', placeholder: r.clearOn ? 'no limit' : '3', 'aria-label': 'Seconds' });
      secs.addEventListener('input', function () {
        var v = Number(secs.value);
        if (secs.value === '' || !(v > 0)) delete r.durationMs; else r.durationMs = Math.round(v * 1000);
        markRules();
      });
      if (r.clearOn) {
        lasts.appendChild(el('span', { text: 'until it ends, max' }));
        lasts.appendChild(secs);
        lasts.appendChild(el('span', { text: 's' }));
      } else {
        lasts.appendChild(secs);
        lasts.appendChild(el('span', { text: 's' }));
      }

      tr.appendChild(el('td', null, [on]));
      tr.appendChild(el('td', { class: 'name', text: r.name }));
      tr.appendChild(el('td', { class: 'when', text: describe(r) }));
      tr.appendChild(el('td', null, [sel]));
      tr.appendChild(el('td', null, [where]));
      tr.appendChild(el('td', null, [prio]));
      tr.appendChild(el('td', null, [lasts]));
      body.appendChild(tr);
    });
    $('#rules-json').value = JSON.stringify(data.rules, null, 2);
  }

  function markRules() {
    rulesDirty = true;
    $('#rules-save').disabled = false;
    $('#rules-status').textContent = 'Unsaved changes';
    $('#rules-status').className = 'status';
  }

  function saveRules(json, statusEl) {
    return api('PUT', '/api/rules', json).then(function (d) {
      data.rules = d;
      rulesDirty = false;
      $('#rules-save').disabled = true;
      renderRules();
      Object.keys(cards).forEach(function (id) { updateUsed(cards[id]); });
      statusEl.textContent = 'Saved';
      statusEl.className = 'status good';
    }).catch(function (e) {
      statusEl.textContent = e.message;
      statusEl.className = 'status err';
    });
  }

  $('#rules-save').addEventListener('click', function () { saveRules(data.rules, $('#rules-status')); });
  $('#rules-raw-toggle').addEventListener('click', function () {
    var raw = $('#rules-raw');
    raw.hidden = !raw.hidden;
    $('#rules-raw-toggle').textContent = raw.hidden ? 'Edit as JSON' : 'Hide JSON';
  });
  $('#rules-json-save').addEventListener('click', function () {
    var json;
    try { json = JSON.parse($('#rules-json').value); } catch (e) {
      $('#rules-json-status').textContent = 'Not valid JSON: ' + e.message;
      $('#rules-json-status').className = 'status err';
      return;
    }
    saveRules(json, $('#rules-json-status'));
  });

  // ---------- settings ----------

  var form = $('#settings');
  var AMB_FIELDS = ['ambGain', 'ambSaturation', 'ambFloor', 'ambSmoothMs'];
  function ambLabel(k) {
    var v = Number(form[k].value);
    $('#' + k + '-val').textContent = k === 'ambFloor' ? Math.round(v * 100) + '%' : k === 'ambSmoothMs' ? v + ' ms' : v.toFixed(1) + 'x';
  }

  function renderSettings() {
    var s = data.settings;
    form.lowHealthThreshold.value = Math.round(s.lowHealthThreshold * 100);
    $('#thr-val').textContent = Math.round(s.lowHealthThreshold * 100) + '%';
    form.lowManaThreshold.value = Math.round(s.lowManaThreshold * 100);
    $('#mthr-val').textContent = Math.round(s.lowManaThreshold * 100) + '%';
    form.beaconEnabled.checked = s.beaconEnabled;
    form.zonesEnabled.checked = s.zonesEnabled;
    form.ceilingEnabled.checked = s.ceilingEnabled;
    form.ceilingColor.value = s.ceilingColor;
    AMB_FIELDS.forEach(function (k) { form[k].value = s[k]; ambLabel(k); });
    form.minApplyIntervalMs.value = s.minApplyIntervalMs;
    form.logsDir.value = s.logsDir || '';
    form.playerName.value = s.playerName || '';
    var sel = form.baseline;
    sel.textContent = '';
    sel.appendChild(el('option', { value: '', text: 'Follow SignalRGB (whatever you last picked)' }));
    var list = data.srgbEffects.slice();
    if (s.baseline && list.indexOf(s.baseline) < 0) list.push(s.baseline);
    list.forEach(function (n) { sel.appendChild(el('option', { value: n, text: n })); });
    sel.value = s.baseline || '';
    settingsDirty = false;
    $('button[type=submit]', form).disabled = true;
  }

  form.addEventListener('input', function (e) {
    if (e.target.name === 'lowHealthThreshold') $('#thr-val').textContent = e.target.value + '%';
    if (e.target.name === 'lowManaThreshold') $('#mthr-val').textContent = e.target.value + '%';
    if (AMB_FIELDS.indexOf(e.target.name) >= 0) ambLabel(e.target.name);
    settingsDirty = true;
    $('button[type=submit]', form).disabled = false;
    $('#settings-status').textContent = 'Unsaved changes';
    $('#settings-status').className = 'status';
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var patch = {
      lowHealthThreshold: Number(form.lowHealthThreshold.value) / 100,
      lowManaThreshold: Number(form.lowManaThreshold.value) / 100,
      beaconEnabled: form.beaconEnabled.checked,
      zonesEnabled: form.zonesEnabled.checked,
      ceilingEnabled: form.ceilingEnabled.checked,
      ceilingColor: form.ceilingColor.value,
      ambGain: Number(form.ambGain.value),
      ambSaturation: Number(form.ambSaturation.value),
      ambFloor: Number(form.ambFloor.value),
      ambSmoothMs: Number(form.ambSmoothMs.value),
      baseline: form.baseline.value || null,
      minApplyIntervalMs: Number(form.minApplyIntervalMs.value),
      logsDir: form.logsDir.value.trim(),
      playerName: form.playerName.value.trim(),
    };
    api('PUT', '/api/settings', patch).then(function (s) {
      data.settings = s;
      renderSettings();
      $('#settings-status').textContent = 'Saved';
      $('#settings-status').className = 'status good';
    }).catch(function (err) {
      $('#settings-status').textContent = err.message;
      $('#settings-status').className = 'status err';
    });
  });

  $('#install').addEventListener('click', function () {
    var btn = $('#install');
    btn.disabled = true;
    $('#maint-status').textContent = 'Installing…';
    $('#maint-status').className = 'status';
    api('POST', '/api/effects/install').then(function (r) {
      $('#maint-status').textContent = r.restarted
        ? 'Restarted SignalRGB. It now lists: ' + r.missing.join(', ')
        : 'All effects are installed and SignalRGB already lists them.';
      $('#maint-status').className = 'status good';
      return loadSrgbEffects();
    }).catch(function (e) {
      $('#maint-status').textContent = e.message;
      $('#maint-status').className = 'status err';
    }).then(function () { btn.disabled = false; });
  });

  $('#shutdown').addEventListener('click', function () {
    if (!confirm('Stop the bridge? Your normal effect will be restored.')) return;
    api('POST', '/api/shutdown').then(function () {
      stopped = true;
      toast('Bridge stopped. Run start-bridge.cmd to start it again.');
      setPill('pill-srgb', 'bad', 'bridge stopped');
    }).catch(function (e) { toast(e.message, true); });
  });

  // ---------- live state ----------

  function beaconText(b) {
    if (!b.enabled) return ['warn', 'off (using combat log)'];
    if (b.healthy) return ['ok', 'live'];
    var why = {
      'no window': 'waiting for WoW',
      'no marker': 'strip not visible: in a loading screen, or SignalBeacon not loaded?',
      minimized: 'WoW is minimized',
      'no bar': 'strip partly hidden',
      'reader restarting': 'reader restarting',
      'not started': 'starting',
    }[b.why] || b.why || 'lost';
    return ['warn', why];
  }

  function renderState(s) {
    data.state = s;
    var c = s.controller;
    $('#showing').textContent = c.showing || 'unknown';
    var stack = $('#stack');
    stack.textContent = '';
    if (!c.entries.length) stack.appendChild(el('span', { class: 'tag', text: 'Normal effect: ' + (c.baseline || '?') }));
    c.entries.forEach(function (e, i) {
      stack.appendChild(el('span', { class: 'tag' + (i === 0 ? ' top' : ''), text: e.key + ' · ' + e.effect }));
    });

    // Zones: what each part of the room is showing right now.
    var zbox = $('#zones');
    var zs = s.zones;
    zbox.hidden = !(zs && zs.enabled && zs.active);
    if (!zbox.hidden) {
      zbox.textContent = '';
      var ambAvg = zs.ambience && zs.ambience.length ? zs.ambience : ['#000000'];
      zs.list.forEach(function (z) {
        var design = z.effect && Object.keys(data.effects).map(function (k) { return data.effects[k]; })
          .filter(function (d) { return d.name === z.effect; })[0];
        var swatch = design ? design.colors[0] : (z.name === 'ceiling' ? ambAvg[0] : ambAvg[1] || ambAvg[0]);
        var dot = el('i');
        dot.style.background = z.room ? (data.settings ? data.settings.ceilingColor : '#000')
          : z.name === 'ceiling' && !design ? 'linear-gradient(90deg,' + ambAvg.join(',') + ')' : swatch;
        zbox.appendChild(el('div', { class: 'zone', title: z.label }, [
          dot, el('b', { text: z.label.replace(' (Hue cans)', '') }),
          el('span', { text: z.room ? 'room light' : z.key ? z.key : 'game world' }),
        ]));
      });
    }

    var srgb = s.signalrgb || {};
    if (s.dryRun) setPill('pill-srgb', 'warn', 'dry run');
    else if (srgb.ok === false) setPill('pill-srgb', 'bad', 'not reachable', srgb.error);
    else if (srgb.ok) setPill('pill-srgb', 'ok', srgb.current || 'connected');
    else setPill('pill-srgb', '', 'checking…');

    var bt = beaconText(s.beacon);
    setPill('pill-beacon', bt[0], bt[1]);

    var lg = s.log;
    if (lg.error) setPill('pill-log', 'bad', lg.error);
    else if (!lg.file) setPill('pill-log', 'warn', 'no log file yet');
    else if (lg.msSinceLine === null) setPill('pill-log', 'ok', 'waiting for new lines (type /combatlog in game)', lg.dir + '\\' + lg.file);
    else setPill('pill-log', lg.msSinceLine < 120000 ? 'ok' : 'warn', 'last line ' + ago(lg.msSinceLine), lg.dir + '\\' + lg.file);

    $('#sub').textContent = (lg.player ? lg.player.replace(/-+$/, '') : 'Character not seen yet') + (s.dryRun ? ' · dry run' : '');

    // player card
    var hpBox = $('.hp');
    var hp = null, src = '';
    if (s.beacon.healthy && s.beacon.reading) { hp = s.beacon.reading.hp; src = ''; }
    else if (lg.tracker.hp !== null && lg.tracker.hp !== undefined) { hp = lg.tracker.hp; src = ' (combat log)'; }
    hpBox.classList.toggle('off', hp === null);
    $('#hp-fill').style.width = hp === null ? '0' : (hp * 100).toFixed(1) + '%';
    $('#hp-text').textContent = hp === null ? 'no data' : Math.round(hp * 100) + '%' + src;
    if (data.settings) $('#hp-mark').style.left = (data.settings.lowHealthThreshold * 100) + '%';

    var r = s.beacon.healthy ? s.beacon.reading : null;
    var mana = r && r.hasMana && typeof r.mana === 'number' ? r.mana : null;
    $('#mp').classList.toggle('off', mana === null);
    $('#mp-fill').style.width = mana === null ? '0' : (mana * 100).toFixed(1) + '%';
    $('#mp-text').textContent = mana === null
      ? (r && r.layout < 3 ? 'mana: /reload to load SignalBeacon 0.3' : r && !r.hasMana ? 'no mana bar' : 'mana: no data')
      : 'Mana ' + Math.round(mana * 100) + '%';
    if (data.settings) $('#mp-mark').style.left = (data.settings.lowManaThreshold * 100) + '%';

    var st = s.beacon.healthy ? s.beacon.state : { dead: lg.tracker.dead, lowHealth: lg.tracker.lowHealth };
    var chips = $('#chips');
    chips.textContent = '';
    [['Dead', st.dead && !st.ghost, true], ['Ghost', st.ghost, true], ['Low health', st.lowHealth, true], ['Low mana', st.lowMana, true],
      ['In combat', st.combat], ['Boss fight', st.encounter]].forEach(function (x) {
      if (x[1] === undefined) return;
      chips.appendChild(el('span', { class: 'chip' + (x[1] ? ' on' : '') + (x[1] && x[2] ? ' bad' : ''), text: x[0] }));
    });

    // cards
    Object.keys(cards).forEach(function (id) {
      var card = cards[id];
      var name = card.def.name;
      card.el.classList.toggle('showing-now', c.showing === name);
      // Gauge previews show your real mana when there is one, a demo sweep otherwise.
      if (card.def.source === 'mana') card.state.level = mana === null ? undefined : mana;
      var ping = s.pings[name];
      var badge = $('.running', card.el);
      if (ping && ping.msAgo < 7000) {
        badge.hidden = false;
        badge.className = 'running' + (ping.error ? ' err' : '');
        badge.textContent = ping.error ? 'error in SignalRGB' : ping.current === false ? 'updating…' : 'running in SignalRGB';
        badge.title = ping.error || 'SignalRGB reported this effect drawing on your devices ' + ago(ping.msAgo);
      } else {
        badge.hidden = true;
      }
    });

    // activity (newest first)
    var list = $('#activity');
    var items = s.activity.slice().reverse();
    var sig = items.length ? items[0].t + items[0].msg : '';
    if (list.dataset.sig !== sig) {
      list.dataset.sig = sig;
      list.textContent = '';
      items.forEach(function (a) {
        list.appendChild(el('li', { class: a.level }, [
          el('time', { text: new Date(a.t).toLocaleTimeString([], { hour12: false }) }),
          el('span', { class: a.level, text: a.msg }),
        ]));
      });
    }
  }

  function poll() {
    if (stopped) return;
    api('GET', '/api/state').then(renderState).catch(function () {
      setPill('pill-srgb', 'bad', 'bridge not running');
      setPill('pill-beacon', 'bad', 'bridge not running');
      setPill('pill-log', 'bad', 'bridge not running');
    }).then(function () { setTimeout(poll, 500); });
  }

  function loadSrgbEffects() {
    return api('GET', '/api/signalrgb/effects').then(function (list) {
      data.srgbEffects = list.slice().sort(function (a, b) { return a.localeCompare(b); });
    }).catch(function () { data.srgbEffects = []; }).then(function () {
      if (data.rules && !rulesDirty) renderRules();
      if (data.settings && !settingsDirty) renderSettings();
    });
  }

  window.addEventListener('beforeunload', function (e) {
    if (rulesDirty || settingsDirty) { e.preventDefault(); e.returnValue = ''; }
  });

  Promise.all([
    api('GET', '/api/effects'),
    api('GET', '/api/rules'),
    api('GET', '/api/settings'),
  ]).then(function (r) {
    data.effects = r[0].effects;
    data.patterns = r[0].patterns;
    data.params = r[0].params;
    data.rules = r[1];
    data.settings = r[2];
    renderEffects();
    renderRules();
    renderSettings();
    requestAnimationFrame(animate);
    poll();
    return loadSrgbEffects();
  }).catch(function (e) {
    toast('Could not load settings: ' + e.message, true);
    poll();
  });
})();
