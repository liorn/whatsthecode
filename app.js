(function () {
  'use strict';

  const STORAGE_KEY = 'wtc.entries.v1';
  const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
  const SEARCH_DEBOUNCE_MS = 400;

  // ---------- State ----------
  let entries = loadEntries();
  let currentPos = null;    // { lat, lng, accuracy } or null
  let geoState = 'idle';    // 'idle' | 'loading' | 'ok' | 'denied' | 'error'
  let geoError = null;      // last GeolocationPositionError (or null)
  let formState = null;
  let homeState = null;     // { sorted: Entry[], index: number } for prev/next on home

  const $app = document.getElementById('app');

  // ---------- Storage ----------
  function loadEntries() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  function saveEntries() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }

  // ---------- Math ----------
  function haversine(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function formatDistance(m) {
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
  }

  // ---------- Geolocation ----------
  // Low-first strategy: request a fast coarse fix (WiFi/cell); if the provider
  // has nothing cached (TIMEOUT or POSITION_UNAVAILABLE) fall back to GPS-grade.
  // PERMISSION_DENIED is terminal — no retry.
  function requestPosition(opts) {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        const e = new Error('Geolocation not supported');
        e.code = 0;
        reject(e);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (p) =>
          resolve({
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            accuracy: p.coords.accuracy,
          }),
        (err) => reject(err),
        opts
      );
    });
  }
  // Low-first, with fallback to high accuracy. Throws on failure.
  async function getPosition() {
    try {
      return await requestPosition({
        enableHighAccuracy: false,
        timeout: 5000,
        maximumAge: 60000,
      });
    } catch (err) {
      if (err?.code === 1) throw err; // denied — don't retry
      return await requestPosition({
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 60000,
      });
    }
  }
  async function ensurePosition() {
    if (geoState === 'ok') return currentPos;
    if (geoState === 'loading') return null;
    geoState = 'loading';
    geoError = null;
    try {
      currentPos = await getPosition();
      geoState = 'ok';
      return currentPos;
    } catch (err) {
      geoState = err?.code === 1 ? 'denied' : 'error';
      geoError = err;
      return null;
    }
  }
  function geoErrorMessage() {
    const code = geoError?.code;
    if (code === 1) return 'Location access is off. Turn it on in your browser to see the nearest code automatically.';
    if (code === 2) return "Your device couldn't determine its location (no GPS/WiFi fix available).";
    if (code === 3) return 'Location request timed out. Move somewhere with better GPS/WiFi and try again.';
    return "Couldn't get your location right now.";
  }

  // ---------- Nominatim ----------
  let currentSearchAbort = null;
  async function searchAddress(query) {
    if (currentSearchAbort) currentSearchAbort.abort();
    currentSearchAbort = new AbortController();
    const url = `${NOMINATIM_BASE}/search?format=json&addressdetails=1&limit=5&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal: currentSearchAbort.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('Search failed');
    return res.json();
  }
  async function reverseGeocode({ lat, lng }) {
    const url = `${NOMINATIM_BASE}/reverse?format=json&lat=${lat}&lon=${lng}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Reverse geocode failed');
    return res.json();
  }

  // ---------- DOM helpers ----------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }
  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ---------- Home ----------
  async function renderHome() {
    if (entries.length === 0) {
      $app.innerHTML = `
        <div class="empty">
          <h2>No codes yet</h2>
          <p>Save your first entry code to see it here when you're nearby.</p>
          <p style="margin-top:20px">
            <a class="btn primary" href="#/add">+ Add a code</a>
          </p>
        </div>`;
      return;
    }

    $app.innerHTML = `
      <div class="loader">
        <div class="spinner" aria-hidden="true"></div>
        <div>Finding your location…</div>
      </div>`;

    const pos = await ensurePosition();
    if (location.hash !== '#/' && location.hash !== '' && location.hash !== '#') {
      return; // user navigated away
    }

    if (geoState !== 'ok' || !pos) {
      $app.innerHTML = `
        <div class="stack-lg">
          <div class="banner">${escapeHtml(geoErrorMessage())}</div>
          <button type="button" class="btn btn-block" id="retry-geo">Try again</button>
          ${listMarkup(null)}
        </div>`;
      document.getElementById('retry-geo').addEventListener('click', () => {
        geoState = 'idle';
        geoError = null;
        route();
      });
      attachListHandlers();
      return;
    }

    homeState = {
      sorted: entries
        .map((e) => ({ ...e, dist: haversine(pos, { lat: e.lat, lng: e.lng }) }))
        .sort((a, b) => a.dist - b.dist),
      index: 0,
    };
    renderHomeCard();
  }

  function renderHomeCard() {
    const { sorted, index } = homeState;
    const entry = sorted[index];
    const total = sorted.length;

    $app.innerHTML = `
      <div class="card nearest">
        <div class="name">${escapeHtml(entry.name)}</div>
        <div class="code" id="code-value" role="button" tabindex="0" aria-label="Tap to copy code">${escapeHtml(entry.code)}</div>
        <div class="address">${escapeHtml(entry.address)}</div>
        ${entry.comment ? `<div class="comment">${escapeHtml(entry.comment)}</div>` : ''}
        <div class="distance">${formatDistance(entry.dist)} away</div>
        <div class="copy-hint">Tap code to copy</div>
      </div>
      ${
        total > 1
          ? `
      <div class="pager">
        <button type="button" class="btn pager-btn" id="pager-prev" ${index === 0 ? 'disabled' : ''} aria-label="Closer entry">‹</button>
        <div class="pager-count">${index + 1} of ${total}</div>
        <button type="button" class="btn pager-btn" id="pager-next" ${index === total - 1 ? 'disabled' : ''} aria-label="Next nearest">›</button>
      </div>`
          : ''
      }`;

    const codeEl = document.getElementById('code-value');
    const doCopy = async () => {
      try {
        await navigator.clipboard.writeText(entry.code);
        toast('Copied');
      } catch {
        const range = document.createRange();
        range.selectNodeContents(codeEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        toast('Select & copy');
      }
    };
    codeEl.addEventListener('click', doCopy);
    codeEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        doCopy();
      }
    });

    if (total > 1) {
      document.getElementById('pager-prev').addEventListener('click', () => {
        if (homeState.index > 0) {
          homeState.index--;
          renderHomeCard();
        }
      });
      document.getElementById('pager-next').addEventListener('click', () => {
        if (homeState.index < homeState.sorted.length - 1) {
          homeState.index++;
          renderHomeCard();
        }
      });
    }
  }

  // ---------- List ----------
  function listMarkup(pos) {
    const withDist = entries.map((e) => ({
      ...e,
      dist: pos ? haversine(pos, { lat: e.lat, lng: e.lng }) : null,
    }));
    if (pos) withDist.sort((a, b) => a.dist - b.dist);
    else withDist.sort((a, b) => a.name.localeCompare(b.name));

    if (withDist.length === 0) {
      return `
        <div class="empty">
          <h2>No codes</h2>
          <p><a class="btn primary" href="#/add">+ Add a code</a></p>
        </div>`;
    }

    return `<div class="stack">
      ${withDist
        .map(
          (e) => `
        <div class="list-entry" data-id="${escapeHtml(e.id)}">
          <div class="body">
            <div class="name">${escapeHtml(e.name)}${
              e.dist != null
                ? ` <span class="muted" style="font-weight:400">· ${formatDistance(e.dist)}</span>`
                : ''
            }</div>
            <div class="addr" title="${escapeHtml(e.address)}">${escapeHtml(e.address)}</div>
            ${e.comment ? `<div class="comment" title="${escapeHtml(e.comment)}">${escapeHtml(e.comment)}</div>` : ''}
          </div>
          <div class="code-chip">${escapeHtml(e.code)}</div>
          <button class="menu-btn" data-action="edit" aria-label="Edit">✎</button>
          <button class="menu-btn" data-action="delete" aria-label="Delete">🗑</button>
        </div>`
        )
        .join('')}
    </div>`;
  }
  function attachListHandlers() {
    $app.querySelectorAll('.list-entry').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('[data-action="edit"]').addEventListener('click', () => {
        location.hash = `#/edit/${encodeURIComponent(id)}`;
      });
      row.querySelector('[data-action="delete"]').addEventListener('click', () => {
        const entry = entries.find((e) => e.id === id);
        if (!entry) return;
        if (confirm(`Delete code for "${entry.name}"?`)) {
          entries = entries.filter((e) => e.id !== id);
          saveEntries();
          route();
        }
      });
    });
  }
  async function renderList() {
    if (geoState === 'idle') {
      // Fire and forget — re-render when fix arrives (or denied), if still on list.
      ensurePosition().then(() => {
        if (location.hash === '#/list') route();
      });
    }
    const pos = geoState === 'ok' ? currentPos : null;
    $app.innerHTML = listMarkup(pos);
    attachListHandlers();
  }

  // ---------- Form ----------
  function renderForm(id) {
    const editing = id ? entries.find((e) => e.id === id) : null;
    formState = {
      id: editing?.id || null,
      name: editing?.name || '',
      code: editing?.code || '',
      comment: editing?.comment || '',
      address: editing?.address || '',
      lat: editing?.lat ?? null,
      lng: editing?.lng ?? null,
      suggestions: [],
      searchState: 'idle', // 'idle' | 'loading' | 'done' | 'error'
    };

    $app.innerHTML = `
      <form class="stack-lg" id="entry-form" novalidate>
        <div class="field">
          <label for="f-name">Name</label>
          <input id="f-name" type="text" autocomplete="off" placeholder="e.g. Mike" value="${escapeHtml(formState.name)}" />
        </div>

        <div class="field">
          <label for="f-code">Entry code</label>
          <input id="f-code" class="mono" type="text" inputmode="tel" autocomplete="off" placeholder="e.g. #9163" value="${escapeHtml(formState.code)}" />
        </div>

        <div class="field">
          <label for="f-comment">Comment <span class="muted" style="font-weight:400">(optional)</span></label>
          <input id="f-comment" type="text" autocomplete="off" placeholder="e.g. floor 3 apt 2" value="${escapeHtml(formState.comment)}" />
        </div>

        <div class="field">
          <label for="f-address">Address</label>
          <div id="address-host"></div>
          <div class="hint">Start typing and pick a match to pin the location.</div>
          <button type="button" id="use-location" class="btn ghost" style="margin-top:6px">📍 Use my current location</button>
        </div>

        <div class="form-actions">
          <a href="#/list" class="btn">Cancel</a>
          ${editing ? `<button type="button" class="btn danger" id="delete-btn">Delete</button>` : ''}
          <button type="submit" class="btn primary" id="save-btn">${editing ? 'Save' : 'Add code'}</button>
        </div>
      </form>`;

    renderAddressField();
    attachFormHandlers();
    updateSaveEnabled();
  }

  function renderAddressField() {
    const host = document.getElementById('address-host');
    if (!host) return;
    if (formState.lat != null && formState.lng != null) {
      host.innerHTML = `
        <div class="address-locked">
          <div style="flex:1; min-width:0">
            <div class="label">Pinned</div>
            <div>${escapeHtml(formState.address)}</div>
          </div>
          <button type="button" id="clear-address" aria-label="Clear address">✕</button>
        </div>`;
      document.getElementById('clear-address').addEventListener('click', () => {
        formState.address = '';
        formState.lat = null;
        formState.lng = null;
        formState.suggestions = [];
        formState.searchState = 'idle';
        renderAddressField();
        updateSaveEnabled();
        setTimeout(() => document.getElementById('f-address')?.focus(), 0);
      });
    } else {
      host.innerHTML = `
        <div class="autocomplete">
          <input id="f-address" type="text" autocomplete="off" placeholder="1 Ibn Gvirol, Tel Aviv" value="${escapeHtml(formState.address)}" />
        </div>`;
      const inp = document.getElementById('f-address');
      inp.addEventListener('input', onAddressInput);
      updateSuggestionsDOM();
    }
  }

  function renderSuggestions() {
    if (formState.searchState === 'loading') {
      return `<div class="suggestions"><div class="search-state">Searching…</div></div>`;
    }
    if (formState.searchState === 'error') {
      return `<div class="suggestions"><div class="search-state">Couldn't search — check your connection.</div></div>`;
    }
    if (formState.searchState === 'done' && formState.suggestions.length === 0) {
      return `<div class="suggestions"><div class="search-state">No matches. Try including the city.</div></div>`;
    }
    if (formState.suggestions.length > 0) {
      return `<div class="suggestions" role="listbox">
        ${formState.suggestions
          .map(
            (s, i) =>
              `<button type="button" data-sug="${i}">${escapeHtml(s.display_name)}</button>`
          )
          .join('')}
      </div>`;
    }
    return '';
  }
  function updateSuggestionsDOM() {
    const host = document.querySelector('.autocomplete');
    if (!host) return;
    host.querySelector('.suggestions')?.remove();
    const markup = renderSuggestions();
    if (markup) host.insertAdjacentHTML('beforeend', markup);
    host.querySelectorAll('.suggestions [data-sug]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = formState.suggestions[Number(btn.dataset.sug)];
        if (!s) return;
        formState.address = s.display_name;
        formState.lat = parseFloat(s.lat);
        formState.lng = parseFloat(s.lon);
        formState.suggestions = [];
        formState.searchState = 'idle';
        renderAddressField();
        updateSaveEnabled();
      });
    });
  }

  const onAddressInput = debounce(async (e) => {
    const q = e.target.value.trim();
    formState.address = e.target.value;
    if (q.length < 3) {
      formState.suggestions = [];
      formState.searchState = 'idle';
      updateSuggestionsDOM();
      return;
    }
    formState.searchState = 'loading';
    updateSuggestionsDOM();
    try {
      const results = await searchAddress(q);
      formState.suggestions = Array.isArray(results) ? results : [];
      formState.searchState = 'done';
      updateSuggestionsDOM();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      formState.suggestions = [];
      formState.searchState = 'error';
      updateSuggestionsDOM();
    }
  }, SEARCH_DEBOUNCE_MS);

  function attachFormHandlers() {
    document.getElementById('f-name').addEventListener('input', updateSaveEnabled);
    document.getElementById('f-code').addEventListener('input', updateSaveEnabled);

    document.getElementById('use-location').addEventListener('click', async () => {
      const btn = document.getElementById('use-location');
      btn.disabled = true;
      const origText = btn.textContent;
      btn.textContent = '📍 Getting location…';
      try {
        const pos = await getPosition();
        btn.textContent = '📍 Looking up address…';
        let addr = `Near ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`;
        try {
          const r = await reverseGeocode(pos);
          if (r?.display_name) addr = r.display_name;
        } catch {
          /* keep fallback */
        }
        formState.address = addr;
        formState.lat = pos.lat;
        formState.lng = pos.lng;
        renderAddressField();
        updateSaveEnabled();
      } catch (err) {
        toast(err?.code === 1 ? 'Location permission denied' : "Couldn't get location");
      } finally {
        btn.disabled = false;
        btn.textContent = origText;
      }
    });

    const delBtn = document.getElementById('delete-btn');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        if (!formState.id) return;
        const entry = entries.find((e) => e.id === formState.id);
        if (entry && confirm(`Delete code for "${entry.name}"?`)) {
          entries = entries.filter((e) => e.id !== formState.id);
          saveEntries();
          location.hash = '#/list';
        }
      });
    }

    document.getElementById('entry-form').addEventListener('submit', (e) => {
      e.preventDefault();
      saveForm();
    });
  }

  function updateSaveEnabled() {
    const btn = document.getElementById('save-btn');
    if (!btn) return;
    const name = document.getElementById('f-name')?.value.trim() ?? '';
    const code = document.getElementById('f-code')?.value.trim() ?? '';
    const hasAddr = formState.lat != null && formState.lng != null && !!formState.address;
    btn.disabled = !(name && code && hasAddr);
  }

  function saveForm() {
    const name = document.getElementById('f-name').value.trim();
    const code = document.getElementById('f-code').value.trim();
    const comment = document.getElementById('f-comment').value.trim();
    if (!name || !code || formState.lat == null || formState.lng == null) return;
    if (formState.id) {
      const idx = entries.findIndex((e) => e.id === formState.id);
      if (idx >= 0) {
        entries[idx] = {
          ...entries[idx],
          name,
          code,
          comment,
          address: formState.address,
          lat: formState.lat,
          lng: formState.lng,
        };
      }
    } else {
      const id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      entries.push({
        id,
        name,
        code,
        comment,
        address: formState.address,
        lat: formState.lat,
        lng: formState.lng,
        createdAt: Date.now(),
      });
    }
    saveEntries();
    toast('Saved');
    location.hash = '#/list';
  }

  // ---------- Router ----------
  function navKeyFor(hash) {
    if (hash.startsWith('#/add')) return '#/add';
    if (hash.startsWith('#/edit') || hash.startsWith('#/list')) return '#/list';
    return '#/';
  }
  function route() {
    const hash = location.hash || '#/';
    const key = navKeyFor(hash);
    document.querySelectorAll('.bottom-nav a').forEach((a) => {
      if (a.getAttribute('href') === key) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });

    if (hash === '#/' || hash === '' || hash === '#') return renderHome();
    if (hash === '#/list') return renderList();
    if (hash === '#/add') return renderForm(null);
    const m = hash.match(/^#\/edit\/(.+)$/);
    if (m) return renderForm(decodeURIComponent(m[1]));
    location.hash = '#/';
  }

  // ---------- Boot ----------
  window.addEventListener('hashchange', route);
  route();

  // Service worker disabled during development so edits aren't masked by the cache.
  // if ('serviceWorker' in navigator) {
  //   window.addEventListener('load', () => {
  //     navigator.serviceWorker.register('sw.js').catch(() => {});
  //   });
  // }
})();
