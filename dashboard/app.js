// Token Launch Radar — dashboard logic. Reads window.RADAR (data.js), no network.
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) { document.getElementById('snapshot-line').textContent = 'No data loaded.'; return; }

  var rows = D.rows, live = D.live;
  var watchSlugs = {};
  rows.forEach(function (r) { watchSlugs[r.slug] = !!r.watchlist; });

  var $ = function (id) { return document.getElementById(id); };
  var fmtMoney = function (n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toLocaleString('en-US');
  };
  var fmtPct = function (n) {
    if (n === null || n === undefined) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  };
  var fmtAge = function (n) {
    if (n === null || n === undefined) return '—';
    if (n >= 365) return (n / 365).toFixed(1) + 'y';
    return n + 'd';
  };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // ---- header ----
  var totalImplied = rows.reduce(function (n, r) { return n + r.implied_value_usd; }, 0);
  var top = rows[0];
  $('snapshot-line').textContent =
    'Snapshot ' + D.as_of + ' · DefiLlama protocols · watchlist floor ' + fmtMoney(D.floor_usd) +
    ' · model ' + D.model_version;
  $('chips').innerHTML =
    '<span class="chip">Watchlist <b>' + D.watchlist_size + '</b></span>' +
    '<span class="chip">Board <b>' + D.board_size + ' rows</b></span>' +
    '<span class="chip">Total implied <b>' + fmtMoney(totalImplied) + '</b></span>' +
    '<span class="chip">Top <b>' + esc(top ? top.name : '—') + '</b></span>';

  // ---- filter options ----
  var cats = [], chains = [];
  rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
    (r.chains || []).forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort(); chains.sort();
  cats.forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c;
    $('f-cat').appendChild(o);
  });
  chains.forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c;
    $('f-chain').appendChild(o);
  });

  // ---- tabs ----
  function showTab(which) {
    $('tab-board').classList.toggle('active', which === 'board');
    $('tab-live').classList.toggle('active', which === 'live');
    $('tab-board').setAttribute('aria-selected', which === 'board');
    $('tab-live').setAttribute('aria-selected', which === 'live');
    $('view-board').hidden = which !== 'board';
    $('view-live').hidden = which !== 'live';
    if (which === 'live') renderLive();
  }
  $('tab-board').addEventListener('click', function () { showTab('board'); });
  $('tab-live').addEventListener('click', function () { showTab('live'); });

  // ---- sorting + filtering ----
  var sortKey = 'rank', sortDir = 1;
  var sortVal = function (r, k) {
    if (k === 'name') return r.name.toLowerCase();
    if (k === 'change_7d' || k === 'age_days') return r[k] === null ? -Infinity : r[k];
    return r[k];
  };
  function filtered() {
    var q = $('q').value.trim().toLowerCase();
    var cat = $('f-cat').value, chain = $('f-chain').value;
    var minTvl = +$('f-tvl').value, growth = $('f-growth').value;
    var onlyWatch = $('f-watch').checked;
    var out = rows.filter(function (r) {
      if (onlyWatch && !watchSlugs[r.slug]) return false;
      if (r.tvl_usd < minTvl) return false;
      if (cat && r.category !== cat) return false;
      if (chain && (r.chains || []).indexOf(chain) < 0) return false;
      if (growth === 'gainers' && !(r.change_7d > 0)) return false;
      if (growth === 'losers' && !(r.change_7d < 0)) return false;
      if (q) {
        var hay = (r.name + ' ' + (r.category || '') + ' ' + (r.chains || []).join(' ')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    out.sort(function (a, b) {
      var va = sortVal(a, sortKey), vb = sortVal(b, sortKey);
      if (va < vb) return -sortDir;
      if (va > vb) return sortDir;
      return a.rank - b.rank;
    });
    return out;
  }
  function why(r) {
    var bits = [];
    if (r.change_7d !== null && r.change_7d > 10) bits.push('growing fast +' + r.change_7d.toFixed(0) + '% in 7d');
    else if (r.change_7d !== null && r.change_7d < -10) bits.push('TVL down ' + r.change_7d.toFixed(0) + '% in 7d');
    if (r.comp_source === 'category') bits.push('priced off ' + r.comp_count + ' live ' + (r.category || '') + ' comps');
    else bits.push('priced off the global median');
    if ((r.chains || []).length >= 3) bits.push('on ' + r.chains.length + ' chains');
    if (r.age_days !== null && r.age_days > 730) bits.push('mature, ' + fmtAge(r.age_days));
    return bits.join(' · ') || '—';
  }
  function render() {
    var list = filtered();
    $('count').innerHTML = 'Showing <b>' + list.length + '</b> of ' + rows.length + ' ranked protocols.';
    var html = '';
    if (!list.length) {
      html = '<tr><td colspan="7" class="empty">No protocols match these filters.</td></tr>';
    }
    list.forEach(function (r) {
      var chg = r.change_7d === null ? '<span>—</span>'
        : '<span class="' + (r.change_7d >= 0 ? 'up' : 'down') + '">' + fmtPct(r.change_7d) + '</span>';
      html += '<tr data-slug="' + esc(r.slug) + '"' + (r.rank <= 3 ? ' class="top3"' : '') + '>' +
        '<td><span class="rank">' + r.rank + '</span></td>' +
        '<td><div class="pname">' + esc(r.name) + '</div>' +
        '<div class="psub">' + esc(r.category || 'Uncategorised') + ' · ' + esc((r.chains || []).slice(0, 3).join(', ')) + '</div>' +
        (watchSlugs[r.slug] ? '<span class="pill watch">Watchlist</span>' : '') + '</td>' +
        '<td class="num">' + fmtMoney(r.tvl_usd) + '</td>' +
        '<td class="num">' + chg + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num"><b>' + fmtMoney(r.implied_value_usd) + '</b></td>' +
        '<td class="why">' + esc(why(r)) + '</td></tr>';
    });
    $('rows').innerHTML = html;
  }
  document.querySelectorAll('#board th.sortable').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-sort');
      if (sortKey === k) { sortDir = -sortDir; }
      else { sortKey = k; sortDir = k === 'rank' ? 1 : -1; }
      document.querySelectorAll('#board th.sortable').forEach(function (t) {
        t.classList.remove('sorted-desc', 'sorted-asc');
      });
      th.classList.add(sortDir === 1 ? 'sorted-asc' : 'sorted-desc');
      render();
    });
  });
  ['q', 'f-cat', 'f-chain', 'f-tvl', 'f-growth', 'f-watch'].forEach(function (id) {
    $(id).addEventListener(id === 'q' ? 'input' : 'change', render);
  });

  // ---- live tab ----
  var liveRendered = false;
  function renderLive() {
    if (liveRendered) return;
    liveRendered = true;
    $('live-rows').innerHTML = live.map(function (p) {
      var ratio = (p.mcap_usd && p.tvl_usd) ? (p.mcap_usd / p.tvl_usd).toFixed(2) + '×' : '—';
      return '<tr><td><div class="pname">' + esc(p.name) + '</div>' +
        '<div class="psub">' + esc(p.category || 'Uncategorised') + ' · ' + esc((p.chains || []).slice(0, 3).join(', ')) + '</div></td>' +
        '<td class="num">' + fmtMoney(p.tvl_usd) + '</td>' +
        '<td class="num"><b>' + fmtMoney(p.mcap_usd) + '</b></td>' +
        '<td class="num">' + ratio + '</td>' +
        '<td class="num">' + fmtPct(p.change_7d) + '</td></tr>';
    }).join('');
  }

  // ---- detail drawer ----
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });
  function openDetail(slug) {
    var r = bySlug[slug];
    if (!r) return;
    var compLabel = r.comp_source === 'category'
      ? 'median of ' + r.comp_count + ' live ' + (r.category || '') + ' protocols'
      : (r.comp_count === 0
        ? 'global median across all live protocols (no live ' + (r.category || '') + ' comparables, so the global median is used)'
        : 'global median across all live protocols (only ' + r.comp_count + ' live ' + (r.category || '') + ' comparable' + (r.comp_count === 1 ? '' : 's') + ' — too few, so the global median is used)');
    var steps = (r.farm_steps || []).map(function (s, i) {
      return '<li><b>Step ' + (i + 1) + '.</b> ' + esc(s) + '</li>';
    }).join('');
    $('drawer-body').innerHTML =
      '<p class="eyebrow">Rank #' + r.rank + ' · ' + esc(r.category || 'Uncategorised') + '</p>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="dsub">' + esc((r.chains || []).join(', ')) + ' · TVL ' + fmtMoney(r.tvl_usd) +
      ' · 7d ' + fmtPct(r.change_7d) + ' · age ' + fmtAge(r.age_days) +
      (watchSlugs[r.slug] ? ' · <span class="pill watch">Watchlist</span>' : '') + '</p>' +
      '<div class="kv">' +
      '<div><span>Implied value</span><b>' + fmtMoney(r.implied_value_usd) + '</b></div>' +
      '<div><span>TVL</span><b>' + fmtMoney(r.tvl_usd) + '</b></div>' +
      '<div><span>Comp multiple</span><b>' + r.comp_multiple.toFixed(2) + '×</b></div>' +
      '<div><span>Chains</span><b>' + (r.chains || []).length + '</b></div>' +
      '</div>' +
      '<h3>How the number is built</h3>' +
      '<div class="math">' +
      '<div class="line"><span>TVL</span><span>' + fmtMoney(r.tvl_usd) + '</span></div>' +
      '<div class="line"><span>× comp multiple (' + esc(compLabel) + ')</span><span>' + r.comp_multiple.toFixed(4) + '×</span></div>' +
      '<div class="line"><span>× growth (7d ' + fmtPct(r.change_7d) + ')</span><span>' + r.growth_multiplier.toFixed(4) + '×</span></div>' +
      '<div class="line"><span>× maturity (' + fmtAge(r.age_days) + ')</span><span>' + r.maturity_multiplier.toFixed(4) + '×</span></div>' +
      '<div class="line"><span>× breadth (' + (r.chains || []).length + ' chain' + ((r.chains || []).length === 1 ? '' : 's') + ')</span><span>' + r.breadth_multiplier.toFixed(4) + '×</span></div>' +
      '<div class="line total"><span>= Implied value</span><span>' + fmtMoney(r.implied_value_usd) + '</span></div>' +
      '</div>' +
      '<h3>Farm plan — 6 steps</h3><ol>' + steps + '</ol>' +
      '<div class="note">This protocol records no token. The implied value is what a token would be worth if the protocol&rsquo;s record stayed as it is — it does not predict whether or when a token is issued, and it is this entry&rsquo;s claim, not make.fun&rsquo;s.</div>';
    $('drawer').hidden = false;
    $('backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeDetail() {
    $('drawer').hidden = true;
    $('backdrop').hidden = true;
    document.body.style.overflow = '';
  }
  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.getAttribute('data-slug'));
  });
  $('drawer-close').addEventListener('click', closeDetail);
  $('backdrop').addEventListener('click', closeDetail);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeDetail();
  });

  // Expose the detail opener for screenshots: ?detail=<slug> or #detail=<slug>.
  var m = (location.search + location.hash).match(/detail=([A-Za-z0-9._-]+)/);
  render();
  if (m) openDetail(m[1]);
})();
