/* ══════════════════════════════════════════════════════════════════════════
   YouTube Blocker Pro — content.js v4.0
══════════════════════════════════════════════════════════════════════════ */

const _ALLOWED_PATHS = ['/', '/watch', '/shorts', '/results', '/feed', '/live', '/channel', '/@', '/playlist', '/trending'];
function isRelevantPage() {
    const p = location.pathname;
    return _ALLOWED_PATHS.some(a => p === a || p.startsWith(a));
}
// Initialisation unique — un seul point d'entrée
if (isRelevantPage()) { initContentScript(); }

/* ── Wrappers storage ────────────────────────────────────────────────── */
function safeGet(keys) {
    return new Promise(resolve => {
        try {
            chrome.storage.local.get(keys, r => {
                if (chrome.runtime.lastError) { logger("storage get err:", chrome.runtime.lastError); resolve({}); }
                else resolve(r || {});
            });
        } catch(e) { logger("storage exception:", e); resolve({}); }
    });
}
function getProfilePrefix() {
    const prof = settings.activeProfile || 'default';
    return prof === 'default' ? '' : `${prof}_`;
}
function safeSet(obj) {
    try {
        const prefix = getProfilePrefix();
        const prefixedObj = {};
        for (const [k, v] of Object.entries(obj)) {
            if (k === 'blockedVideos' || k === 'blockedChannels' || k === 'watchStats' || k === 'blockHistory') {
                prefixedObj[`${prefix}${k}`] = v;
            } else {
                prefixedObj[k] = v;
            }
        }
        chrome.storage.local.set(prefixedObj, () => {
            if (chrome.runtime.lastError) {
                logger("storage set error:", chrome.runtime.lastError.message);
            }
        });
    }
    catch(e) { logger("storage set err:", e); }
}
function safeSyncGet(keys) {
    return new Promise(resolve => {
        try {
            chrome.storage.sync.get(keys, r => {
                if (chrome.runtime.lastError) { logger("storage sync get err:", chrome.runtime.lastError); resolve({}); }
                else resolve(r || {});
            });
        } catch(e) { logger("storage sync exception:", e); resolve({}); }
    });
}

/* ── État global ─────────────────────────────────────────────────────── */
let settings = {
    autoBlockThreshold: 75, hardHideBlocked: true,
    minDuration: 0, maxDuration: 0,
    hideChannelLogo: false, hideChannelName: false,
    hideCreateBtn: false, hideAccountBtn: false, hideSubCount: false,
    hideSidebarSubs: false, hideSidebarYou: false, hideSidebarExplore: false,
    hideSidebarMore: false, hideSidebarFooter: false, hideSearchShelves: false
};
let ytData = {
    blockedVideos: [], blockedChannels: [],
    watchStats: { totalTimeWatched:0, timeSaved:0, totalVideos:0, totalBlockedCount:0, channels:{}, dailyDated:{} }
};

// Sets pour lookups O(1) au lieu de O(n) sur les tableaux
let _blockedSet    = new Set(); // IDs vidéos bloquées
let _blockedChSet  = new Set(); // noms de chaînes bloquées

function rebuildBlockedSet() {
    _blockedSet   = new Set(ytData.blockedVideos.map(v => decompressVideo(v).id));
    _blockedChSet = new Set(ytData.blockedChannels.map(c => c.toLowerCase()));
}
function isBlocked(id) { return _blockedSet.has(id); }
function isChannelBlocked(ch) { return ch && _blockedChSet.has(ch.toLowerCase()); }

/* ── Cache des nœuds DOM fréquemment accédés ─────────────────────────── */
// Le channel name sur la page /watch ne change qu'à la navigation
let _cachedChannelName = null;
let _cachedChannelNameVid = null; // on invalide quand la vidéo change
let _cachedVideoEl = null;        // référence à l'élément <video>

function getCachedChannelName(vid) {
    if (_cachedChannelName !== null && _cachedChannelName !== 'Inconnu' && _cachedChannelNameVid === vid) return _cachedChannelName;
    const name = document.querySelector('#upload-info .yt-formatted-string, ytd-video-owner-renderer #channel-name a, ytd-watch-metadata #owner-name a')?.innerText.trim();
    if (name) {
        _cachedChannelName = name;
        _cachedChannelNameVid = vid;
        return name;
    }
    return 'Inconnu';
}

/* ── Variables d'état de lecture ─────────────────────────────────────── */
let autoBlockedId = null, countedId = null, lastTime = 0, lastSave = 0, logoFoundFor = null;
let currentCategory = null, currentGame = null, lastDetectedVid = null;
let skippedBeforeEndId = null;
let activeVideoDuration = 0, activeVideoMaxTime = 0;

function recordVideoRetention() {
    if (lastDetectedVid && activeVideoDuration > 0 && activeVideoMaxTime > 0) {
        const pct = Math.min(100, Math.round((activeVideoMaxTime / activeVideoDuration) * 100));
        if (pct > 0) {
            const ws = ytData.watchStats;
            ws.retentionTotalPct = (ws.retentionTotalPct || 0) + pct;
            ws.retentionCount = (ws.retentionCount || 0) + 1;
            
            // Si regardé à moins de 85%, c'est compté comme une interruption (30)
            if (pct < 85) {
                ws.interruptionsCount = (ws.interruptionsCount || 0) + 1;
                logger("Vidéo interrompue prématurément:", pct, "%");
            } else {
                logger("Vidéo visionnée avec succès:", pct, "%");
            }
            safeSet({watchStats: ws});
        }
    }
    activeVideoMaxTime = 0;
    activeVideoDuration = 0;
}

window.addEventListener('beforeunload', () => {
    recordVideoRetention();
});

/* ── Durée texte "M:SS" ou "H:MM:SS" → secondes ── */
function parseDuration(txt) {
    if (!txt) return null;
    const p = txt.trim().split(':').map(Number);
    if (p.some(isNaN)) return null;
    if (p.length === 2) return p[0]*60 + p[1];
    if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
    return null;
}

function getVideoCategory() {
    return document.querySelector('meta[itemprop="genre"]')?.getAttribute('content') || null;
}

function getGamingTitle() {
    const el = document.querySelector('ytd-rich-metadata-renderer[page-type="PRIMARY_CAG_MAIN"] #title, #game-title, ytd-game-details-renderer #title, a[href*="/game/"]');
    return el ? el.textContent.trim() : null;
}

/* ── applyDynamicFilters : applique inline seulement sur la racine passée ── */
function applyDynamicFilters(root) {
    try {
        const scope = root || document;
        const doViews = !!settings.hideViewCount;
        const doDate  = !!settings.hidePublishDate;
        const doLogo  = !!settings.hideChannelLogo;
        const doName  = !!settings.hideChannelName;

        if (doLogo) {
            scope.querySelectorAll('#avatar-link, #avatar-section, ytd-channel-avatar-skeleton-renderer, .yt-user-avatar, #channel-thumbnail, #channel-avatar, .ytd-channel-name + yt-img-shadow, yt-avatar-shape, ytd-video-owner-renderer #avatar, yt-lockup-view-model yt-avatar-shape, .yt-lockup-metadata-view-model-wiz__avatar, .yt-lockup-metadata-view-model__avatar').forEach(el => {
                el.style.setProperty('display', 'none', 'important');
            });
        }
        if (doName) {
            scope.querySelectorAll('#byline-container, #channel-name, ytd-channel-name, .ytd-channel-name, #owner-name, ytd-video-owner-renderer #channel-name, yt-lockup-metadata-view-model a[href*="/@"], yt-lockup-metadata-view-model a[href*="/channel/"], .yt-lockup-metadata-view-model-wiz__title, .yt-lockup-metadata-view-model__title').forEach(el => {
                el.style.setProperty('display', 'none', 'important');
            });
        }
        if (doViews || doDate) {
            scope.querySelectorAll('#metadata-line span, #metadata-line yt-formatted-string, .inline-metadata-item, yt-inline-metadata-view-model span, yt-inline-metadata-view-model yt-formatted-string, #metadata span, #info-container span, yt-content-metadata-view-model span, .yt-content-metadata-view-model-wiz__metadata-text, .yt-content-metadata-view-model__metadata-text').forEach(el => {
                const txt = el.textContent.toLowerCase().trim();
                if (!txt) return;
                const isViews = /\d/.test(txt) && (
                    txt.includes('vue') || txt.includes('view') ||
                    txt.includes('fois') || txt.includes('spectateurs') ||
                    txt.includes('watching')
                );
                const isDate = (
                    txt.includes('il y a') || txt.includes('ago') ||
                    txt.includes('mois') || txt.includes('an ') || txt.includes('ans') ||
                    txt.includes('jour') || txt.includes('day') || txt.includes('week') ||
                    txt.includes('month') || txt.includes('heure') || txt.includes('hour') ||
                    txt.includes('minute') || txt.includes('hier') || txt.includes('yesterday') ||
                    txt.includes('diffusé') || txt.includes('streamed')
                );
                if (doViews && isViews) el.style.setProperty('display', 'none', 'important');
                if (doDate  && isDate)  el.style.setProperty('display', 'none', 'important');
            });
        }
    } catch(e) {
        logger("Error in dynamic filters:", e);
    }
}

function setHighestQuality() {
    try {
        localStorage.setItem('yt-player-quality', JSON.stringify({ creation: Date.now(), data: "highres" }));
    } catch(e) {}
}

// Local API Event publisher (53)
function dispatchAPIEvent(action, detail) {
    try {
        const ev = new CustomEvent('ytbp-api-event', {
            detail: { action, detail, timestamp: Date.now() }
        });
        window.dispatchEvent(ev);
    } catch(e) {}
}

// Draggable generic helper
async function setupDraggable(el, handleId, storageKeyPrefix) {
    const r = await safeGet([`${storageKeyPrefix}X`, `${storageKeyPrefix}Y`]);
    if (r[`${storageKeyPrefix}X`] && r[`${storageKeyPrefix}Y`]) {
        el.style.left = r[`${storageKeyPrefix}X`];
        el.style.top = r[`${storageKeyPrefix}Y`];
        el.style.right = 'auto';
    }
    const handle = handleId ? (document.getElementById(handleId) || el) : el;
    handle.style.cursor = 'move';
    el.style.pointerEvents = 'auto';
    
    let isDragging = false;
    let startX, startY, startLeft, startTop;
    handle.addEventListener('mousedown', e => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = el.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        e.preventDefault();
        e.stopPropagation();
    });
    document.addEventListener('mousemove', e => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        el.style.left = `${startLeft + dx}px`;
        el.style.top = `${startTop + dy}px`;
        el.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        const saveObj = {};
        saveObj[`${storageKeyPrefix}X`] = el.style.left;
        saveObj[`${storageKeyPrefix}Y`] = el.style.top;
        chrome.storage.local.set(saveObj, () => {
            if (chrome.runtime.lastError) {
                logger("coords save failed:", chrome.runtime.lastError.message);
            }
        });
    });
}

// Draggable floating timer helper using the generic setupDraggable
async function setupDraggableTimer(td) {
    await setupDraggable(td, null, 'timer');
}

// Auto Dimmer Lights Out theater mode (44)
let _dimTimer = null;
function setupAutoDimmer() {
    const resetDimmer = () => {
        document.documentElement.classList.remove('ytbp-dimmed');
        clearTimeout(_dimTimer);
        if (location.pathname.startsWith('/watch')) {
            const vp = document.querySelector('video');
            const isPlaying = vp && !vp.paused && !vp.ended;
            if (isPlaying) {
                _dimTimer = setTimeout(() => {
                    document.documentElement.classList.add('ytbp-dimmed');
                }, 3000);
            }
        }
    };
    document.addEventListener('mousemove', resetDimmer);
    document.addEventListener('mousedown', resetDimmer);
    document.addEventListener('keydown', resetDimmer);
}

// Advanced Keyboard Shortcuts (42)
document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    
    // Alt+V : Bloquer la vidéo courante
    if (e.altKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        const vid = new URLSearchParams(location.search).get('v');
        if (vid) {
            registerBlock(vid, "Raccourci Alt+V");
            toast("🚫 Vidéo bloquée (Alt+V) !");
            applyBlocks();
        }
    }
    // Alt+C : Bloquer la chaîne courante
    else if (e.altKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        const vid = new URLSearchParams(location.search).get('v');
        const ch = getCachedChannelName(vid);
        if (ch && ch !== 'Inconnu' && !_blockedChSet.has(ch.toLowerCase())) {
            ytData.blockedChannels.push(ch);
            _blockedChSet.add(ch.toLowerCase());
            if (!ytData.blockHistory) ytData.blockHistory = [];
            ytData.blockHistory.push({
                timestamp: Date.now(),
                title: ch,
                type: 'channel',
                value: ch,
                reason: 'Raccourci Alt+C'
            });
            if (ytData.blockHistory.length > 150) ytData.blockHistory.shift();
            safeSet({blockedChannels:ytData.blockedChannels, blockHistory:ytData.blockHistory});
            toast(`🚫 Chaîne "${ch}" bloquée (Alt+C) !`);
            applyBlocks();
        }
    }
    // Alt+Z : Basculer le Mode Zen
    else if (e.altKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        const on = !settings.hideChannelLogo;
        chrome.storage.sync.set({
            hideChannelLogo: on,
            hideChannelName: on,
            hideViewCount: on,
            hidePublishDate: on
        }, () => {
            if (chrome.runtime.lastError) {
                logger("Zen mode toggle save failed:", chrome.runtime.lastError.message);
            }
        });
        toast(on ? "✨ Mode Zen Activé" : "✨ Mode Zen Désactivé");
    }
    
    // Touches / & * (UI Lecteur)
    if (!settings.hidePlayerUiKeys) return;
    if (e.key === '/') {
        document.documentElement.classList.add('ytbp-hide-ui');
        toast("🎬 Mode cinéma — UI masquée [Touche * pour afficher]", 2500);
    } else if (e.key === '*') {
        document.documentElement.classList.remove('ytbp-hide-ui');
        toast("🎬 UI réaffichée", 1500);
    }
});

const NEWS  = ["bfmtv","cnews","lci","franceinfo","le figaro","mediapart","euronews"];
const CARDS = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-shelf-renderer ytd-video-renderer',
].join(',');
const SHORTS_SHELF = [
    'ytd-reel-shelf-renderer',
    'ytd-rich-shelf-renderer[is-shorts]',
    '[title="Shorts"]',
    'ytd-guide-entry-renderer[title="Shorts"]',
    'a[title="Shorts"]',
    '#endpoint[title="Shorts"]',
].join(',');
const SHORTS_ITEM = [
    'ytd-reel-item-renderer',
    'ytd-shorts',
    'ytm-shorts-lockup-view-model',
].join(',');

let _card = null, _cardTimer = null;
let _lastPerfWrite = 0; // throttle pour filterPerformance
let _ctxPending = new WeakSet();

function setupMenuListener() {
    document.addEventListener('mousedown', e => {
        const btn = e.target.closest('ytd-menu-renderer, yt-icon-button.ytd-menu-renderer');
        if (!btn) return;
        const c = btn.closest(CARDS);
        if (!c) return;
        _card = c;
        clearTimeout(_cardTimer);
        _cardTimer = setTimeout(() => { _card = null; }, 5000);
        
        injectCtxMenu();
    }, true);
}

let pomodoroState = { pomodoroActive: false, pomodoroMode: 'idle', pomodoroPaused: false };

function isFocusHourActive() {
    if (!settings.focusHoursEnabled) return false;
    const now = new Date();
    const day = now.getDay();
    const days = settings.focusHoursDays || [];
    if (!days.includes(day)) return false;

    const hh = now.getHours().toString().padStart(2, '0');
    const mm = now.getMinutes().toString().padStart(2, '0');
    const timeStr = `${hh}:${mm}`;

    const ranges = settings.focusHoursRanges || [];
    return ranges.some(r => timeStr >= r.start && timeStr <= r.end);
}

function updatePomodoroWidget(state) {
    pomodoroState = state;
    
    let widget = document.getElementById('ytbp-pomodoro-widget');
    if (!state || state.pomodoroMode === 'idle' || (!state.pomodoroActive && !state.pomodoroPaused)) {
        if (widget) widget.remove();
        return;
    }

    if (!widget) {
        widget = document.createElement('div');
        widget.id = 'ytbp-pomodoro-widget';
        widget.innerHTML = `
            <div id="ytbp-pomo-drag">⠿</div>
            <div id="ytbp-pomo-status">💼 Concentration</div>
            <div id="ytbp-pomo-time">25:00</div>
            <div class="ytbp-pomo-controls">
                <button id="ytbp-pomo-btn-pause" title="Mettre en pause">⏸️</button>
                <button id="ytbp-pomo-btn-skip" title="Passer la session">⏭️</button>
            </div>
        `;
        document.body.appendChild(widget);
        setupDraggable(widget, 'ytbp-pomo-drag', 'pomoWidget');

        document.getElementById('ytbp-pomo-btn-pause').onclick = () => {
            if (pomodoroState.pomodoroActive) {
                chrome.runtime.sendMessage({ action: 'pomodoro_pause' });
            } else {
                chrome.runtime.sendMessage({ action: 'pomodoro_resume' });
            }
        };

        document.getElementById('ytbp-pomo-btn-skip').onclick = () => {
            chrome.runtime.sendMessage({
                action: 'pomodoro_start',
                mode: pomodoroState.pomodoroMode === 'work' ? 'break' : 'work',
                duration: pomodoroState.pomodoroMode === 'work' ? 300000 : 1500000
            });
        };
    }

    const statusEl = document.getElementById('ytbp-pomo-status');
    const timeEl = document.getElementById('ytbp-pomo-time');
    const pauseBtn = document.getElementById('ytbp-pomo-btn-pause');

    if (state.pomodoroMode === 'work') {
        statusEl.innerHTML = '💼 Concentration';
        widget.className = 'pomo-mode-work';
    } else {
        statusEl.innerHTML = '☕ Pause';
        widget.className = 'pomo-mode-break';
    }

    pauseBtn.textContent = state.pomodoroActive ? '⏸️' : '▶️';

    if (window.pomoInterval) clearInterval(window.pomoInterval);
    
    const updateTime = () => {
        let secondsLeft = 0;
        if (state.pomodoroPaused) {
            secondsLeft = Math.ceil(state.pomodoroPausedTimeLeft / 1000);
        } else {
            secondsLeft = Math.max(0, Math.ceil((state.pomodoroStartTime + state.pomodoroDuration - Date.now()) / 1000));
        }
        
        if (secondsLeft <= 0) {
            timeEl.textContent = '00:00';
            clearInterval(window.pomoInterval);
            return;
        }

        const mins = Math.floor(secondsLeft / 60);
        const secs = secondsLeft % 60;
        timeEl.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    updateTime();
    if (state.pomodoroActive && !state.pomodoroPaused) {
        window.pomoInterval = setInterval(updateTime, 500);
    }
}

async function initContentScript() {
    try {
        const s = await safeSyncGet(null);
        settings = { ...settings, ...s };
        if (s.hardHideBlocked === undefined) settings.hardHideBlocked = true;

        const prefix = getProfilePrefix();
        const r = await safeGet([`${prefix}blockedVideos`, `${prefix}blockedChannels`, `${prefix}watchStats`, `${prefix}blockHistory`]);
        ytData.blockedVideos   = r[`${prefix}blockedVideos`]   || [];
        ytData.blockedChannels = r[`${prefix}blockedChannels`] || [];
        ytData.watchStats      = r[`${prefix}watchStats`]      || ytData.watchStats;
        ytData.blockHistory    = r[`${prefix}blockHistory`]    || [];
        if (!ytData.watchStats.dailyDated) ytData.watchStats.dailyDated = {};
        // Anti-Traduction (82) — Géré par background.js via declarativeNetRequest (zéro rechargement).
        // Le background injecte Accept-Language: en dans les headers HTTP réseau selon la setting antiAutoTranslate.

        rebuildBlockedSet();
        invalidateBlockCache();
        setupMenuListener();
        setupAutoDimmer();
        
        const pState = await safeGet(['pomodoroActive', 'pomodoroMode', 'pomodoroStartTime', 'pomodoroDuration', 'pomodoroPaused', 'pomodoroPausedTimeLeft']);
        if (pState && pState.pomodoroMode) {
            updatePomodoroWidget(pState);
        }

        applyPageMods(); applyBlocks(); startObserver(); startPeriodicCheck();
        
        // Custom Logo (37) — interval clearable pour éviter les fuites mémoire
        startCustomLogo();

        // Resize : debounce 300ms pour éviter applyPageMods sur chaque pixel
let _resizeDebounce = null;
window.addEventListener('resize', () => {
    const f = document.getElementById('ytbp-iframe-dash');
    if (f && f.style.display === 'block') f.style.maxHeight = (window.innerHeight-70)+'px';
    clearTimeout(_resizeDebounce);
    _resizeDebounce = setTimeout(applyPageMods, 300);
});
        logger("YTBP v3.9.1 Initialisé en profil:", settings.activeProfile || 'default');
    } catch(e) { logger("init err", e); }
}

/* ── storage.onChanged : filtré par namespace pour éviter les boucles ── */
chrome.storage.onChanged.addListener(async (changes, ns) => {
    try {
        if (ns === 'sync') {
            const oldProfile = settings.activeProfile || 'default';
            const s = await safeSyncGet(null);
            settings = { ...settings, ...s };
            const newProfile = settings.activeProfile || 'default';
            
            if (oldProfile !== newProfile) {
                const prefix = getProfilePrefix();
                const r = await safeGet([`${prefix}blockedVideos`, `${prefix}blockedChannels`, `${prefix}watchStats`, `${prefix}blockHistory`]);
                ytData.blockedVideos   = r[`${prefix}blockedVideos`]   || [];
                ytData.blockedChannels = r[`${prefix}blockedChannels`] || [];
                ytData.watchStats      = r[`${prefix}watchStats`]      || { totalTimeWatched:0, timeSaved:0, totalVideos:0, totalBlockedCount:0, channels:{}, dailyDated:{} };
                ytData.blockHistory    = r[`${prefix}blockHistory`]    || [];
                if (!ytData.watchStats.dailyDated) ytData.watchStats.dailyDated = {};
                rebuildBlockedSet();
                invalidateBlockCache();
            }
            
            _settingsDirty = true;
            applyPageMods();
            applyBlocks();
            startCustomLogo(); // redémarre si customLogoUrl a changé
        }
        
        const prefix = getProfilePrefix();
        const bvidKey = `${prefix}blockedVideos`;
        const bchKey = `${prefix}blockedChannels`;
        const bHistKey = `${prefix}blockHistory`;
        if (ns === 'local') {
            const pomoChanged = ['pomodoroActive', 'pomodoroMode', 'pomodoroStartTime', 'pomodoroDuration', 'pomodoroPaused', 'pomodoroPausedTimeLeft'].some(k => changes[k]);
            if (pomoChanged) {
                const pState = await safeGet(['pomodoroActive', 'pomodoroMode', 'pomodoroStartTime', 'pomodoroDuration', 'pomodoroPaused', 'pomodoroPausedTimeLeft']);
                updatePomodoroWidget(pState);
                applyBlocks();
            }
            
            if (changes[bvidKey] || changes[bchKey] || changes[bHistKey]) {
                const keys = [];
                if (changes[bvidKey]) keys.push(bvidKey);
                if (changes[bchKey])  keys.push(bchKey);
                if (changes[bHistKey]) keys.push(bHistKey);
                const r = await safeGet(keys);
                if (changes[bvidKey]) ytData.blockedVideos   = r[bvidKey] || [];
                if (changes[bchKey])  ytData.blockedChannels = r[bchKey] || [];
                if (changes[bHistKey]) ytData.blockHistory    = r[bHistKey] || [];
                rebuildBlockedSet();
                invalidateBlockCache();
                applyBlocks();
            }
        }
    } catch(e) {}
});

chrome.runtime.onMessage.addListener(async (req) => {
    if (req.action === 'shortcut_block') {
        const v = new URLSearchParams(location.search).get('v');
        if (v) { registerBlock(v, "Raccourci Clavier"); toast("🚫 Bloqué via raccourci !"); }
    } else if (req.action === 'force_block_reload') {
        logger("WebSocket reload command received.");
        const prefix = getProfilePrefix();
        const r = await safeGet([`${prefix}blockedVideos`, `${prefix}blockedChannels`, `${prefix}watchStats`, `${prefix}blockHistory`]);
        ytData.blockedVideos   = r[`${prefix}blockedVideos`]   || [];
        ytData.blockedChannels = r[`${prefix}blockedChannels`] || [];
        ytData.watchStats      = r[`${prefix}watchStats`]      || ytData.watchStats;
        ytData.blockHistory    = r[`${prefix}blockHistory`]    || [];
        rebuildBlockedSet();
        invalidateBlockCache();
        applyBlocks();
    } else if (req.action === 'pomodoro_update') {
        updatePomodoroWidget(req.state);
        applyBlocks();
    }
});

window.addEventListener('message', e => {
    if (e.data === 'close-ytbp-iframe') hideIframe();
});

// Bouton Panique (Alt+P) (65)
document.addEventListener('keydown', e => {
    if (e.altKey && e.code === 'KeyP' && settings.enablePanicButton) {
        e.preventDefault();
        const v = document.querySelector('video');
        if (v) v.pause();
        window.location.href = 'https://www.google.com';
    }
});

// Volume à la molette (13)
document.addEventListener('wheel', e => {
    if (settings.enableWheelVolume) {
        const player = document.querySelector('#movie_player');
        if (player && player.contains(e.target)) {
            e.preventDefault();
            const v = document.querySelector('video');
            if (v) {
                let vol = v.volume;
                vol += (e.deltaY < 0 ? 0.05 : -0.05);
                v.volume = Math.max(0, Math.min(1, vol));
                // Afficher le niveau de volume YouTube (optionnel)
                toast(`Volume : ${Math.round(v.volume * 100)}%`, 1000);
            }
        }
    }
}, {passive: false});

document.addEventListener('mousedown', e => {
    const f = document.getElementById('ytbp-iframe-dash');
    if (!f || f.style.display !== 'block') return;
    const btn = document.getElementById('ytbp-toolbar-btn');
    if (!f.contains(e.target) && (!btn || !btn.contains(e.target))) hideIframe();
}, true);

function applySidebarModifications() {
    try {
        document.querySelectorAll('ytd-guide-section-renderer').forEach(section => {
            const root = section.shadowRoot || section;
            const headerEl = root.querySelector('h3, #title, #header, #header-text, .title, .header-text') || 
                             section.querySelector('h3, #title, #header, #header-text, .title, .header-text');
            const headerText = headerEl?.textContent?.trim()?.toLowerCase() || '';
            
            const isSubsSection = headerText.includes('abonnement') || headerText.includes('subscription');
            const isYouSection = headerText.includes('vous') || headerText.includes('you') || 
                                 section.querySelector('a[href*="/feed/history"], a[href*="/feed/you"], a[href*="/feed/library"]') ||
                                 root.querySelector('a[href*="/feed/history"], a[href*="/feed/you"], a[href*="/feed/library"]');
            const isExploreSection = headerText.includes('explorer') || headerText.includes('explore');
            const isMoreSection = headerText.includes('plus de youtube') || headerText.includes('more from youtube') || 
                                  headerText.includes('autres contenus youtube') || 
                                  section.querySelector('a[href*="/premium"]') ||
                                  root.querySelector('a[href*="/premium"]');

            if (isSubsSection) {
                section.classList.toggle('ytbp-guide-hide-subs', !!settings.hideSidebarSubs);
            }
            if (isYouSection) {
                section.classList.toggle('ytbp-guide-hide-you', !!settings.hideSidebarYou);
            }
            if (isExploreSection) {
                section.classList.toggle('ytbp-guide-hide-explore', !!settings.hideSidebarExplore);
            }
            if (isMoreSection) {
                section.classList.toggle('ytbp-guide-hide-more', !!settings.hideSidebarMore);
            }
        });
    } catch(e) { logger("Error in applySidebarModifications:", e); }
}

function toast(msg, dur=3000) {
    let t = document.getElementById('ytbp-content-toast');
    if (!t) { t = document.createElement('div'); t.id='ytbp-content-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('ytbp-tv');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('ytbp-tv'), dur);
}

function applyPageMods() {
    const h = document.documentElement;
    h.classList.toggle('ytbp-gray',       !!settings.grayscale);
    h.classList.toggle('ytbp-nometric',   !!settings.hideMetrics);
    h.classList.toggle('ytbp-noside',     !!settings.hideSidebar);
    h.classList.toggle('ytbp-nosidebarsubs', !!settings.hideSidebarSubs);
    h.classList.toggle('ytbp-nosidebaryou',   !!settings.hideSidebarYou);
    h.classList.toggle('ytbp-nosidebarexplore',!!settings.hideSidebarExplore);
    h.classList.toggle('ytbp-nosidebarmore',  !!settings.hideSidebarMore);
    h.classList.toggle('ytbp-nosidebarfooter',!!settings.hideSidebarFooter);
    h.classList.toggle('ytbp-nomini',     !!settings.blockMiniplayer);
    h.classList.toggle('ytbp-noviews',    !!settings.hideViewCount);
    h.classList.toggle('ytbp-nodur',      !!settings.hideDuration);
    h.classList.toggle('ytbp-nodate',     !!settings.hidePublishDate);
    h.classList.toggle('ytbp-nochlogo',   !!settings.hideChannelLogo);
    h.classList.toggle('ytbp-nochname',   !!settings.hideChannelName);
    h.classList.toggle('ytbp-nocreate',   !!settings.hideCreateBtn);
    h.classList.toggle('ytbp-noaccount',  !!settings.hideAccountBtn);
    h.classList.toggle('ytbp-nosubcount', !!settings.hideSubCount);
    h.classList.toggle('ytbp-nonotif',    !!settings.hideNotifications);
    h.classList.toggle('ytbp-nosearch',   !!settings.hideSearch);
    h.classList.toggle('ytbp-nohomechips',!!settings.hideHomeChips);
    h.classList.toggle('ytbp-nosearchshelves', !!settings.hideSearchShelves);
    h.classList.toggle('ytbp-nodesclinks',!!settings.hideDescLinks);
    h.classList.toggle('ytbp-nodescright',!!settings.hideDescCopyright);
    h.classList.toggle('ytbp-nodesctr',   !!settings.hideDescTranscription);
    h.classList.toggle('ytbp-nodescall',
        !!(settings.hideDescLinks && settings.hideDescCopyright && settings.hideDescTranscription) ||
        !!settings.hideDescAll);
    h.classList.toggle('ytbp-nosuggchips', !!settings.hideSuggChips);
    h.classList.toggle('ytbp-nosuggthumbs',!!settings.hideSuggThumbs);
    h.classList.toggle('ytbp-nosuggpanel', !!settings.hideSuggPanel);
    h.classList.toggle('ytbp-nolives',     !!settings.blockLives);
    h.classList.toggle('ytbp-notrendingshop', !!settings.hideTrendingShop);
    h.classList.toggle('ytbp-nobadges',      !!settings.hideBadges);
    h.classList.toggle('ytbp-blurthumbs',    !!settings.blurThumbnails);
    h.classList.toggle('ytbp-nosubbtn',      !!settings.hideSubscribeBtn);
    h.classList.toggle('ytbp-onlypinned',    !!settings.onlyPinnedComment);
    h.setAttribute('data-ytbp-playerkeys', settings.hidePlayerUiKeys ? 'true' : 'false');
    if (settings.forcedTheme) h.setAttribute('data-ytbp-theme', settings.forcedTheme);
    else                      h.removeAttribute('data-ytbp-theme');
    h.setAttribute('data-ytbp-highest-quality', settings.autoHighestQuality ? 'true' : 'false');
    
    // Adaptation petit écran (67)
    if (settings.responsiveBlocks && window.innerWidth < 800) {
        h.classList.add('ytbp-responsive-disabled');
    } else {
        h.classList.remove('ytbp-responsive-disabled');
    }

    applyMetaFilters(null);
    applySidebarModifications();

    // Timer flottant
    let td = document.getElementById('ytbp-floating-timer');
    if (settings.showTimer && location.pathname === '/watch') {
        if (!td) {
            td = document.createElement('div');
            td.id='ytbp-floating-timer';
            document.body.appendChild(td);
            setupDraggableTimer(td);
        }
    } else if (td) td.remove();
}

function forceAutoplay() {
    if (!settings.disableAutoplay) return;
    document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]')?.click();
}

function forceTheaterMode() {
    if (!settings.autoTheaterMode) return;
    const watchFlexy = document.querySelector('ytd-watch-flexy');
    if (watchFlexy && !watchFlexy.hasAttribute('theater')) {
        const btn = document.querySelector('.ytp-size-button');
        if (btn && btn.getAttribute('title') && btn.getAttribute('title').toLowerCase().includes('cinema')) {
            btn.click();
        } else if (btn) {
            // Parfois le titre est différent selon la langue, cliquons quand même si pas en theater
            btn.click();
        }
    }
}

function registerBlock(videoId, reason = "Seuil atteint") {
    if (_blockedSet.has(videoId)) return;
    const vp  = _cachedVideoEl || document.querySelector('video.html5-main-video') || document.querySelector('video');
    const dur = vp && isFinite(vp.duration) ? Math.floor(vp.duration) : 0;
    const title = document.title.replace(/^\(\d+\)\s/,'').replace(' - YouTube','').trim();
    ytData.blockedVideos.push(compressVideo({id:videoId,title,durationSec:dur,timestamp:Date.now()}));
    _blockedSet.add(videoId);
    ytData.watchStats.totalBlockedCount = (ytData.watchStats.totalBlockedCount||0)+1;
    ytData.watchStats.timeSaved         = (ytData.watchStats.timeSaved||0)+dur;
    
    if (!ytData.blockHistory) ytData.blockHistory = [];
    ytData.blockHistory.push({
        timestamp: Date.now(),
        title: title || `Vidéo ${videoId}`,
        type: 'video',
        value: videoId,
        reason: reason
    });
    if (ytData.blockHistory.length > 150) ytData.blockHistory.shift();

    safeSet({blockedVideos:ytData.blockedVideos, watchStats:ytData.watchStats, blockHistory:ytData.blockHistory});
}

function goToNextVideo() {
    const nb = document.querySelector('.ytp-next-button');
    if (nb) {
        const nextUrl = nb.getAttribute('href') || nb.href;
        nb.click();
        if (nextUrl) {
            const currentUrl = location.href;
            setTimeout(() => {
                if (location.href === currentUrl) location.href = nextUrl;
            }, 500);
        }
    } else {
        const firstRec = document.querySelector('ytd-compact-video-renderer a#thumbnail, ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer a');
        location.href = (firstRec && firstRec.href) ? firstRec.href : '/';
    }
}

function checkAutoSkipGuard() {
    try {
        const now = Date.now();
        const skips = JSON.parse(sessionStorage.getItem('ytbp_skips') || '[]');
        const recentSkips = skips.filter(t => now - t < 10000);
        if (recentSkips.length >= 3) {
            logger("Auto-skip guard: Loop detected, skipping suspended.");
            toast("⚠️ Boucle de rechargement détectée. Saut automatique suspendu.", 5000);
            return false;
        }
        recentSkips.push(now);
        sessionStorage.setItem('ytbp_skips', JSON.stringify(recentSkips));
        return true;
    } catch(e) {
        return true;
    }
}

function autoSkip(reason) {
    if (!checkAutoSkipGuard()) return;
    document.querySelector('video')?.pause();
    toast(reason === "Saut de fin de vidéo." ? "⏭️ Fin de vidéo — passage à la suivante…" : "🚫 Vidéo bloquée — suivante dans 1s…", 2500);
    setTimeout(goToNextVideo, 1000);
}

const MOTIVATIONAL_QUOTES = [
    { text: "Le secret pour avancer, c'est de commencer.", author: "Mark Twain" },
    { text: "La discipline est le pont entre les objectifs et l'accomplissement.", author: "Jim Rohn" },
    { text: "Ce que vous faites aujourd'hui peut améliorer tous vos lendemains.", author: "Ralph Marston" },
    { text: "La motivation vous fait démarrer. L'habitude vous fait continuer.", author: "Jim Ryun" },
    { text: "Le succès n'est pas la clé du bonheur. Le bonheur est la clé du succès.", author: "Albert Schweitzer" },
    { text: "N'attendez pas. Le temps ne sera jamais 'juste comme il faut'.", author: "Napoleon Hill" },
    { text: "Faites de chaque jour votre chef-d'œuvre.", author: "John Wooden" },
    { text: "La seule façon de faire du bon travail est d'aimer ce que vous faites.", author: "Steve Jobs" },
    { text: "Rien n'est impossible, seule la paresse donne cette impression.", author: "Anonyme" },
    { text: "La patience est amère, mais son fruit est doux.", author: "Jean-Jacques Rousseau" },
    { text: "Chaque pas vous rapproche de votre objectif.", author: "Anonyme" },
    { text: "Ne perdez pas votre temps en spéculations inutiles. Agissez !", author: "Anonyme" },
    { text: "La persévérance bat le talent quand le talent ne persévère pas.", author: "Anonyme" }
];

function showOverlay(reason) {
    let ov = document.getElementById('ytbp-overlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'ytbp-overlay';
        document.body.appendChild(ov);
    }
    
    if (settings.useMotivationDashboard) {
        ov.className = 'ytbp-motivation-dashboard';
        const randQuote = MOTIVATIONAL_QUOTES[Math.floor(Math.random() * MOTIVATIONAL_QUOTES.length)];
        
        const stats = ytData.watchStats || {};
        const hoursSaved = Math.round((stats.timeSaved || 0) / 3600);
        const clicksAvoided = stats.clicksAvoided || 0;
        
        ov.innerHTML = `
            <div class="ytbp-dash-card">
                <div class="ytbp-dash-logo">🛡️ YT Blocker Pro</div>
                <h1 class="ytbp-dash-title">🚫 Temps de se Concentrer !</h1>
                <p class="ytbp-dash-reason">${reason}</p>
                
                <div class="ytbp-quote-card">
                    <p class="ytbp-quote-text">"${randQuote.text}"</p>
                    <p class="ytbp-quote-author">— ${randQuote.author}</p>
                </div>
                
                <div class="ytbp-stats-grid">
                    <div class="ytbp-stat-box">
                        <span class="ytbp-stat-val">${hoursSaved}h</span>
                        <span class="ytbp-stat-lbl">Économisées</span>
                    </div>
                    <div class="ytbp-stat-box">
                        <span class="ytbp-stat-val">${clicksAvoided}</span>
                        <span class="ytbp-stat-lbl">Clics évités</span>
                    </div>
                </div>

                <div id="ytbp-dash-pomo-status" class="ytbp-dash-pomo" style="display:none;">
                    <div class="ytbp-dash-pomo-lbl">⏱️ Minuteur Pomodoro</div>
                    <div id="ytbp-dash-pomo-time" class="ytbp-dash-pomo-time">25:00</div>
                </div>
                
                <div class="ytbp-dash-links">
                    <button class="ytbp-dash-btn btn-home" id="ytbp-home-btn">🏠 Accueil YouTube</button>
                    ${settings.activeRedirectionUrl ? `<button class="ytbp-dash-btn btn-work" id="ytbp-work-link-btn">💼 Aller au travail</button>` : ''}
                </div>
            </div>
        `;
        
        if (settings.activeRedirectionUrl) {
            document.getElementById('ytbp-work-link-btn').onclick = () => {
                location.href = settings.activeRedirectionUrl;
            };
        }
    } else {
        ov.className = 'ytbp-classic-overlay';
        ov.innerHTML = `
            <div class="ytbp-ov-icon">🚫</div>
            <p id="ytbp-ov-reason">${reason}</p>
            <div class="ytbp-ov-btns">
                <button id="ytbp-skip-btn">⏭️ Vidéo suivante</button>
                <button id="ytbp-home-btn">🏠 Accueil</button>
            </div>
        `;
        const skipBtn = document.getElementById('ytbp-skip-btn');
        if (skipBtn) {
            skipBtn.onclick = () => {
                const nb = document.querySelector('.ytp-next-button');
                nb && !nb.disabled ? nb.click() : history.back();
            };
        }
    }
    
    document.getElementById('ytbp-home-btn').onclick = () => {
        location.href = '/';
    };
    
    ov.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    const dashPomo = document.getElementById('ytbp-dash-pomo-status');
    const dashPomoTime = document.getElementById('ytbp-dash-pomo-time');
    if (dashPomo && pomodoroState && pomodoroState.pomodoroMode !== 'idle') {
        dashPomo.style.display = 'block';
        if (window.dashPomoInterval) clearInterval(window.dashPomoInterval);
        const updateDashTime = () => {
            let secondsLeft = 0;
            if (pomodoroState.pomodoroPaused) {
                secondsLeft = Math.ceil(pomodoroState.pomodoroPausedTimeLeft / 1000);
            } else {
                secondsLeft = Math.max(0, Math.ceil((pomodoroState.pomodoroStartTime + pomodoroState.pomodoroDuration - Date.now()) / 1000));
            }
            const mins = Math.floor(secondsLeft / 60);
            const secs = secondsLeft % 60;
            dashPomoTime.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        };
        updateDashTime();
        window.dashPomoInterval = setInterval(updateDashTime, 500);
    } else if (dashPomo) {
        dashPomo.style.display = 'none';
    }
}

function hideOverlay() {
    const ov = document.getElementById('ytbp-overlay');
    if (ov) { ov.style.display='none'; document.body.style.overflow=''; }
}

/* ── blockEls : lookup O(1) grâce aux Sets ───────────────────────────── */
function blockEls(els) {
    const t0 = performance.now();
    const ws = ytData.watchStats || {};
    const minDurSec = settings.minDuration > 0 ? settings.minDuration * 60 : 0;
    const maxDurSec = settings.maxDuration > 0 ? settings.maxDuration * 60 : 0;
    let avoidedChanged = false;

    els.forEach(el => {
        // Évite le re-traitement si déjà marqué et rien n'a changé
        if (el.dataset.ytbpChecked === '1' && !el.dataset.ytbpDirty) return;
        el.dataset.ytbpChecked = '1';
        delete el.dataset.ytbpDirty;

        const tEl = el.querySelector('#video-title, .yt-lockup-metadata-view-model-wiz__title, a[href*="/watch"]');
        const cEl = el.querySelector([
            'ytd-channel-name a',
            '#channel-name a',
            '.ytd-channel-name a',
            '#byline-container a',
            'a[href*="/@"]',
            'a[href*="/channel/"]',
            'a[href*="/user/"]',
            '.yt-simple-endpoint.yt-formatted-string'
        ].join(','));
        
        let vid = null;
        const videoLinkEl = el.querySelector('a[href*="v="], a[href*="/watch?v="], a[href*="/shorts/"], a[href*="/live/"]');
        if (videoLinkEl) {
            const href = videoLinkEl.getAttribute('href') || '';
            if (href.includes('v=')) {
                try { vid = new URLSearchParams(href.split('?')[1]).get('v'); } catch(_) {}
            } else if (href.includes('/shorts/')) {
                vid = href.split('/shorts/')[1]?.split('?')[0] || null;
            } else if (href.includes('/live/')) {
                vid = href.split('/live/')[1]?.split('?')[0] || null;
            }
        }
        
        const ch = cEl?.innerText.trim() || cEl?.textContent.trim() || '';

        // Injection du bouton de blocage rapide au survol (43)
        if (vid) {
            let qb = el.querySelector('.ytbp-quick-block-btn');
            if (!qb) {
                const thumb = el.querySelector('ytd-thumbnail, #thumbnail, .yt-core-image');
                if (thumb) {
                    if (window.getComputedStyle(thumb).position === 'static') {
                        thumb.style.position = 'relative';
                    }
                    qb = document.createElement('button');
                    qb.className = 'ytbp-quick-block-btn';
                    qb.innerHTML = '×';
                    qb.title = 'Bloquer rapidement cette vidéo';
                    qb.onclick = e => {
                        e.preventDefault();
                        e.stopPropagation();
                        registerBlock(vid, "Clic rapide miniature");
                        toast("🚫 Vidéo bloquée rapidement !");
                        applyBlocks();
                    };
                    thumb.appendChild(qb);
                }
            }
        }

        // Filtre durée (inclut badge-shape pour YouTube récent)
        let durSecs = null;
        const durOverlay = el.querySelector('ytd-thumbnail-overlay-time-status-renderer:not([overlay-style="LIVE"]):not([overlay-style="SHORTS"]), badge-shape, .yt-thumbnail-badge-view-model__badge-label');
        if (durOverlay) {
            const txt = durOverlay.textContent?.trim() || '';
            if (!txt.toLowerCase().includes('live') && !txt.toLowerCase().includes('direct') && !txt.toLowerCase().includes('shor')) {
                durSecs = parseDuration(txt);
            }
        }
        const durationBlocked = durSecs !== null && (
            (minDurSec > 0 && durSecs < minDurSec) ||
            (maxDurSec > 0 && durSecs > maxDurSec)
        );

        // Filtre Vues (29) — recherche dans toutes les balises méta du conteneur
        let viewsCount = -1;
        if (settings.minViews > 0 || settings.maxViews > 0) {
            const metaSpans = el.querySelectorAll('#metadata-line span, .inline-metadata-item, #metadata span');
            for (const span of metaSpans) {
                const txt = span.textContent.toLowerCase().trim();
                if (/\d/.test(txt) && (
                    txt.includes('vue') || txt.includes('view') ||
                    txt.includes('fois') || txt.includes('spectateurs') ||
                    txt.includes('watching') || txt.includes('affichage')
                )) {
                    let numStr = txt.replace(/[^0-9,.]/g, '').replace(',', '.');
                    let multiplier = 1;
                    if (txt.includes('k')) multiplier = 1000;
                    else if (txt.includes('m')) multiplier = 1000000;
                    else if (txt.includes('b') || txt.includes('md')) multiplier = 1000000000;
                    let parsed = parseFloat(numStr);
                    if (!isNaN(parsed)) {
                        viewsCount = parsed * multiplier;
                        break;
                    }
                }
            }
        }
        const viewsBlocked = viewsCount >= 0 && (
            (settings.minViews > 0 && viewsCount < settings.minViews) ||
            (settings.maxViews > 0 && viewsCount > settings.maxViews)
        );

        const vl = videoLinkEl ? videoLinkEl.getAttribute('href') || '' : '';
        // Filtres Spécifiques
        const isMix = el.querySelector('ytd-radio-renderer, a[href*="start_radio="]') !== null;
        const isMovie = el.querySelector('ytd-badge-supported-renderer .badge-style-type-ypc') !== null || (vl && vl.includes('/movies'));
        const isPremiere = el.querySelector('[aria-label*="Premiere"], [aria-label*="Première"], [overlay-style="UPCOMING"]') !== null;
        
        // Langue stricte (80) — évite de bloquer les emojis en utilisant les classes de scripts Unicode
        let langBlocked = false;
        if (settings.strictLanguage) {
            const titleTxt = tEl ? tEl.textContent : '';
            const nonLatinRegex = /[\p{sc=Cyrillic}\p{sc=Arabic}\p{sc=Hebrew}\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Thai}\p{sc=Devanagari}]/u;
            if (nonLatinRegex.test(titleTxt)) {
                langBlocked = true;
            }
        }

        const isNews = ch && NEWS.some(n => ch.toLowerCase().includes(n));

        // Mettre en évidence les chaînes favorites (38)
        const favChannels = (settings.favoriteChannels || '').split(',').map(s => s.trim().toLowerCase()).filter(s => s);
        if (favChannels.length > 0 && ch && favChannels.includes(ch.toLowerCase())) {
            el.classList.add('ytbp-favorite-channel');
        } else {
            el.classList.remove('ytbp-favorite-channel');
        }

        // Lookups O(1) — plus de .includes() sur tableau
        const shouldBlock = settings.activeProfile !== 'guest' && (
                            (vid && isBlocked(vid)) ||
                            isChannelBlocked(ch) ||
                            (settings.blockNews && isNews) ||
                            (settings.blockMixes && isMix) ||
                            (settings.blockMovies && isMovie) ||
                            (settings.blockPremieres && isPremiere) ||
                            viewsBlocked ||
                            langBlocked ||
                            durationBlocked
                        );

        if (shouldBlock) {
            // Incrémente le compteur de clics évités (26)
            if (el.dataset.ytbpAvoided !== '1' && settings.hardHideBlocked !== false) {
                el.dataset.ytbpAvoided = '1';
                ws.clicksAvoided = (parseInt(ws.clicksAvoided)||0) + 1;
                avoidedChanged = true;
            }

            if (settings.hardHideBlocked !== false) {
                el.classList.add('ytbp-hidden');
                el.classList.remove('ytbp-blurred');
            } else {
                el.classList.remove('ytbp-hidden');
                el.classList.add('ytbp-blurred');
            }
        } else {
            el.classList.remove('ytbp-hidden', 'ytbp-blurred');
        }
    });

    if (avoidedChanged) {
        safeSet({watchStats: ws});
    }

    const t1 = performance.now();
    if (els.length > 0) {
        // Throttle : 1 écriture/30s max pour éviter de saturer storage.onChanged
        const now = Date.now();
        if (now - (_lastPerfWrite||0) > 30000) {
            _lastPerfWrite = now;
            chrome.storage.local.set({ filterPerformance: { lastTimeMs: (t1-t0).toFixed(2), totalElements: els.length, timestamp: now } }, () => {
                if (chrome.runtime.lastError) {
                    logger("perf stats save failed:", chrome.runtime.lastError.message);
                }
            });
        }
    }
}

/* ── Invalide le cache de blockEls quand les listes changent ─────────── */
function invalidateBlockCache() {
    document.querySelectorAll('[data-ytbp-checked]').forEach(el => {
        el.dataset.ytbpDirty = '1';
    });
}

function applyMetaFilters(nodes) {
    const doViews = !!settings.hideViewCount;
    const doDur   = !!settings.hideDuration;
    const doDate  = !!settings.hidePublishDate;
    if (!doViews && !doDur && !doDate) return;

    if (doDur) {
        (nodes || document).querySelectorAll(
            'ytd-thumbnail-overlay-time-status-renderer, .ytd-thumbnail-overlay-time-status-renderer, ytd-thumbnail-overlay-bottom-panel-renderer, badge-shape'
        ).forEach(el => el.classList.add('ytbp-hide-duration'));
    } else {
        document.querySelectorAll('.ytbp-hide-duration').forEach(el => el.classList.remove('ytbp-hide-duration'));
    }

    const META_SEL = [
        '#metadata-line',
        'ytd-video-meta-block #metadata',
        'ytd-compact-video-renderer #metadata-line',
        'ytd-grid-video-renderer #metadata-line',
        'ytd-rich-grid-media #metadata-line',
    ].join(',');
    (nodes || document).querySelectorAll(META_SEL).forEach(meta => {
        const spans = meta.querySelectorAll('span.inline-metadata-item, span[class*="metadata"]');
        spans.forEach((span, i) => {
            const txt = span.textContent.toLowerCase().trim();
            const isViews = /\d/.test(txt) && (
                txt.includes('vue') || txt.includes('view') ||
                txt.includes('affichage') || /\d[km]?\s*(vue|view|fois)/.test(txt)
            );
            const isDate = (
                txt.includes('il y a') || txt.includes('ago') ||
                txt.includes('mois') || txt.includes('an ') || txt.includes('ans') ||
                txt.includes('jour') || txt.includes('day') || txt.includes('week') ||
                txt.includes('month') || txt.includes('heure') || txt.includes('hour') ||
                txt.includes('minute') || txt.includes('hier') || txt.includes('yesterday')
            );
            const isFirst = i === 0;
            const isLast  = i === spans.length - 1;
            span.classList.toggle('ytbp-hide-views', doViews && (isViews || isFirst));
            span.classList.toggle('ytbp-hide-date',  doDate  && (isDate  || (isLast && !isFirst)));
        });
    });
}

function applyBlocks() {
    try {
        const isPomoWork = pomodoroState && pomodoroState.pomodoroMode === 'work' && (pomodoroState.pomodoroActive || pomodoroState.pomodoroPaused);
        const isFocusActive = isFocusHourActive();
        const isFocusHard = isFocusActive && settings.focusHoursMode === 'hard';
        const isFocusWarn = isFocusActive && settings.focusHoursMode === 'warn';

        const url = new URL(location.href);
        let isFavoriteChannel = false;
        if (url.pathname === '/watch' || url.pathname.startsWith('/live/')) {
            const vid = url.searchParams.get('v') || (url.pathname.startsWith('/live/') ? url.pathname.split('/')[2] : null);
            const ch = getCachedChannelName(vid);
            const favChannels = (settings.favoriteChannels || '').split(',').map(s => s.trim().toLowerCase()).filter(s => s);
            if (ch && ch !== 'Inconnu' && favChannels.includes(ch.toLowerCase())) {
                isFavoriteChannel = true;
            }
        }

        // Handle Focus Warn Mode (Blur + Warning banner)
        let warnBanner = document.getElementById('ytbp-focus-warn-banner');
        if (isFocusWarn && !isFavoriteChannel) {
            document.documentElement.classList.add('ytbp-focus-blurred');
            if (!warnBanner) {
                warnBanner = document.createElement('div');
                warnBanner.id = 'ytbp-focus-warn-banner';
                warnBanner.innerHTML = `
                    <span>⚠️ Période de Concentration Active (Focus Hours) ! Restez concentré sur vos objectifs.</span>
                    <button id="ytbp-focus-warn-bypass">Continuer quand même</button>
                `;
                document.body.appendChild(warnBanner);
                document.getElementById('ytbp-focus-warn-bypass').onclick = () => {
                    document.documentElement.classList.remove('ytbp-focus-blurred');
                    warnBanner.style.display = 'none';
                    sessionStorage.setItem('ytbp_focus_bypass', '1');
                };
            }
            if (sessionStorage.getItem('ytbp_focus_bypass') === '1') {
                document.documentElement.classList.remove('ytbp-focus-blurred');
                warnBanner.style.display = 'none';
            } else {
                warnBanner.style.display = 'flex';
            }
        } else {
            document.documentElement.classList.remove('ytbp-focus-blurred');
            if (warnBanner) warnBanner.style.display = 'none';
        }

        // Handle strict blocking (Pomodoro Work or Focus Hours Hard)
        // Guard: ne redirige qu'une seule fois par session pour éviter les boucles de rechargement
        if ((isPomoWork || isFocusHard) && !isFavoriteChannel) {
            if (settings.activeRedirectionEnabled && settings.activeRedirectionUrl) {
                const alreadyRedirected = sessionStorage.getItem('ytbp_redir_done') === '1';
                if (!alreadyRedirected) {
                    sessionStorage.setItem('ytbp_redir_done', '1');
                    window.location.href = settings.activeRedirectionUrl;
                    return;
                }
            }
            let blockReason = isPomoWork ? "Session de travail Pomodoro en cours." : "Période de concentration stricte (Focus Hours).";
            showOverlay(blockReason);
            return;
        }
        // Si blocage levé, on remet le flag à zéro
        sessionStorage.removeItem('ytbp_redir_done');

        document.querySelectorAll(SHORTS_SHELF).forEach(el => el.classList.toggle('ytbp-hidden', !!settings.blockShorts));
        document.querySelectorAll(SHORTS_ITEM).forEach(el  => el.classList.toggle('ytbp-hidden', !!settings.blockShorts));
        document.querySelectorAll('ytd-comments#comments').forEach(el => el.classList.toggle('ytbp-hidden', !!settings.hideComments));
        const INFO_PANELS = 'ytd-clarification-renderer, ytd-info-panel-container-renderer, #clarify-box';
        document.querySelectorAll(INFO_PANELS).forEach(el => el.classList.toggle('ytbp-hidden', !!settings.hideInfoPanels));
        
        document.querySelectorAll('ytd-rich-section-renderer, ytd-shelf-renderer').forEach(shelf => {
            const title = shelf.querySelector('#title')?.innerText?.toLowerCase() || '';
            const isNews = title.includes('alerte info') || title.includes('actualité') || title.includes('breaking news') || title.includes('top news');
            if (isNews) shelf.classList.toggle('ytbp-hidden', !!settings.hideInfoPanels);
        });
        const LIVE_SEL = 'ytd-rich-item-renderer:has(.badge-style-type-live-now-alternate), ytd-grid-video-renderer:has(.badge-style-type-live-now-alternate), ytd-video-renderer:has(.badge-style-type-live-now-alternate), ytd-compact-video-renderer:has(.badge-style-type-live-now-alternate)';
        document.querySelectorAll(LIVE_SEL).forEach(el => el.classList.toggle('ytbp-hidden', !!settings.blockLives));

        // Posts Communauté
        const COMMUNITY_POSTS = 'ytd-post-renderer, ytd-shared-post-renderer, ytd-backstage-post-thread-renderer';
        document.querySelectorAll(COMMUNITY_POSTS).forEach(el => {
            const shelf = el.closest('ytd-rich-section-renderer, ytd-item-section-renderer');
            if (shelf) shelf.classList.toggle('ytbp-hidden', !!settings.hideCommunityPosts);
            el.classList.toggle('ytbp-hidden', !!settings.hideCommunityPosts);
        });

        blockEls(document.querySelectorAll(CARDS));

        if (settings.blockShorts && url.pathname.startsWith('/shorts/')) return showOverlay("Les Shorts sont désactivés.");
        if (url.pathname === '/watch' || url.pathname.startsWith('/live/')) {
            const vid = url.searchParams.get('v') || (url.pathname.startsWith('/live/') ? url.pathname.split('/')[2] : null);
            const ch  = getCachedChannelName(vid);
            const isNews = ch && ch !== 'Inconnu' && NEWS.some(n => ch.toLowerCase().includes(n));
            if (vid !== autoBlockedId) {
                if      (isBlocked(vid) || (ch && ch !== 'Inconnu' && isChannelBlocked(ch))) autoSkip("Cette vidéo est dans ta liste de blocage.");
                else if (settings.blockNews && isNews)           autoSkip(`La chaîne "${ch}" est bloquée.`);
                else    hideOverlay();
            } else hideOverlay();
        } else hideOverlay();
    } catch(e) { logger("applyBlocks err", e); }
}

function injectToolbar() {
    if (document.getElementById('ytbp-toolbar-btn')) return;
    const end = document.querySelector('#end.ytd-masthead');
    if (!end) return;
    const wrap = document.createElement('div'); wrap.id = 'ytbp-toolbar-btn';
    const btn  = document.createElement('button');
    btn.textContent = '🛡️ Blocker'; btn.title = 'Ouvrir YouTube Blocker Pro (Alt+B pour bloquer)';
    btn.onclick = () => toggleIframe(); wrap.appendChild(btn); end.prepend(wrap);
}

function getOrCreateIframe() {
    let f = document.getElementById('ytbp-iframe-dash');
    if (!f) {
        try {
            f = document.createElement('iframe');
            f.id  = 'ytbp-iframe-dash';
            f.src = chrome.runtime.getURL('popup.html?inpage=true');
            document.body.appendChild(f);
        } catch(e) {
            if (e.message.includes('Extension context invalidated')) {
                alert("YouTube Blocker Pro a été mis à jour.\\nVeuillez actualiser la page (F5) pour utiliser l'extension.");
                return null;
            }
            throw e;
        }
    }
    return f;
}

function toggleIframe() {
    const f = getOrCreateIframe();
    if (!f) return;
    f.style.maxHeight = (window.innerHeight - 70) + 'px';
    f.style.display   = (f.style.display === 'block') ? 'none' : 'block';
}

function hideIframe() {
    const f = document.getElementById('ytbp-iframe-dash');
    if (f) f.style.display = 'none';
}

window.addEventListener('resize', () => {
    const f = document.getElementById('ytbp-iframe-dash');
    if (f && f.style.display === 'block') f.style.maxHeight = (window.innerHeight - 70) + 'px';
});

function injectVideoButtons() {
    if (!location.pathname.startsWith('/watch') && !location.pathname.startsWith('/live/')) return;
    if (document.getElementById('ytbp-video-btns')) return;
    const target = document.querySelector('ytd-watch-metadata #top-level-buttons-computed')
                || document.querySelector('#top-level-buttons-computed');
    if (!target) return;
    const wrap = document.createElement('div'); wrap.id = 'ytbp-video-btns';
    const mk = (label, icon, cb) => {
        const b = document.createElement('button'); b.className = 'ytbp-vbtn';
        b.innerHTML = `<span class="ytbp-vbtn-icon">${icon}</span><span class="ytbp-vbtn-label">${label}</span>`;
        b.onclick = cb; return b;
    };
    const b1 = mk('Bloquer la vidéo','🚫', () => {
        const vid = new URLSearchParams(location.search).get('v');
        if (vid) { registerBlock(vid, "Bouton Lecteur"); b1.querySelector('.ytbp-vbtn-label').textContent='Bloquée ✓'; b1.disabled=true; toast("🚫 Vidéo bloquée !"); }
    });
    const b2 = mk('Bloquer la chaîne','📺', () => {
        const vid = new URLSearchParams(location.search).get('v');
        const ch = getCachedChannelName(vid);
        if (ch && !_blockedChSet.has(ch)) {
            ytData.blockedChannels.push(ch);
            _blockedChSet.add(ch);
            if (!ytData.blockHistory) ytData.blockHistory = [];
            ytData.blockHistory.push({
                timestamp: Date.now(),
                title: ch,
                type: 'channel',
                value: ch,
                reason: 'Bouton Lecteur'
            });
            if (ytData.blockHistory.length > 150) ytData.blockHistory.shift();
            safeSet({blockedChannels:ytData.blockedChannels, blockHistory:ytData.blockHistory});
            b2.querySelector('.ytbp-vbtn-label').textContent='Chaîne bloquée ✓'; b2.disabled=true;
            toast(`🚫 "${ch}" bloquée !`);
        }
    });
    wrap.appendChild(b1); wrap.appendChild(b2); target.prepend(wrap);
}

function injectCtxMenu() {
    if (!_card) return;
    const card = _card;
    const tEl = card.querySelector('#video-title, .yt-lockup-metadata-view-model-wiz__title, a[href*="/watch"]');
    const cEl = card.querySelector([
        'ytd-channel-name a',
        '#channel-name a',
        '.ytd-channel-name a',
        '#byline-container a',
        'a[href*="/@"]',
        'a[href*="/channel/"]',
        'a[href*="/user/"]',
        '.yt-simple-endpoint.yt-formatted-string'
    ].join(','));
    let vid = null;
    const videoLinkEl = card.querySelector('a[href*="v="], a[href*="/watch?v="], a[href*="/shorts/"], a[href*="/live/"]');
    if (videoLinkEl) {
        const href = videoLinkEl.getAttribute('href') || '';
        if (href.includes('v=')) {
            try { vid = new URLSearchParams(href.split('?')[1]).get('v'); } catch(_) {}
        } else if (href.includes('/shorts/')) {
            vid = href.split('/shorts/')[1]?.split('?')[0] || null;
        } else if (href.includes('/live/')) {
            vid = href.split('/live/')[1]?.split('?')[0] || null;
        }
    }
    const ch = cEl?.innerText.trim() || cEl?.textContent.trim() || '';
    if (!vid && !ch) return;
    
    const cardId = (vid || 'none') + '-' + (ch || 'none');
    
    let tries = 0;
    const inject = () => {
        if (_card !== card) return; // Le menu a changé de carte
        
        const popup = document.querySelector('ytd-popup-container ytd-menu-popup-renderer, tp-yt-iron-dropdown ytd-menu-popup-renderer');
        if (!popup) { if (++tries < 30) setTimeout(inject, 50); return; }
        
        const lb = popup.querySelector('tp-yt-paper-listbox, yt-list-view');
        // Attendre que YouTube remplisse le menu (souvent > 0 éléments)
        if (!lb || lb.children.length === 0) { if (++tries < 30) setTimeout(inject, 50); return; }
        
        // Si déjà injecté et toujours présent, on arrête
        if (popup.dataset.ytbpDone === cardId && lb.querySelector('.ytbp-ctx-item')) return;
        
        // Nettoyage au cas où (si menu recyclé)
        lb.querySelectorAll('.ytbp-ctx-sep, .ytbp-ctx-item').forEach(e => e.remove());
        popup.dataset.ytbpDone = cardId;
        
        const sep = document.createElement('div'); sep.className = 'ytbp-ctx-sep'; lb.appendChild(sep);
        if (vid) {
            const it = document.createElement('div'); it.className = 'ytbp-ctx-item';
            it.innerHTML = `<span class="ytbp-ctx-icon">🚫</span><span>Bloquer cette vidéo</span>`;
            it.onclick = e => { e.stopPropagation(); registerBlock(vid, "Menu Contextuel YT"); toast("🚫 Vidéo bloquée !"); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); _card=null; };
            lb.appendChild(it);
        }
        if (ch) {
            const it = document.createElement('div'); it.className = 'ytbp-ctx-item';
            it.innerHTML = `<span class="ytbp-ctx-icon">📺</span><span>Bloquer cette chaîne</span>`;
            it.onclick = e => {
                e.stopPropagation();
                if(!_blockedChSet.has(ch)){
                    ytData.blockedChannels.push(ch);
                    _blockedChSet.add(ch);
                    if (!ytData.blockHistory) ytData.blockHistory = [];
                    ytData.blockHistory.push({
                        timestamp: Date.now(),
                        title: ch,
                        type: 'channel',
                        value: ch,
                        reason: 'Menu Contextuel YT'
                    });
                    if (ytData.blockHistory.length > 150) ytData.blockHistory.shift();
                    safeSet({blockedChannels:ytData.blockedChannels, blockHistory:ytData.blockHistory});
                }
                toast(`🚫 "${ch}" bloquée !`);
                document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
                _card=null;
            };
            lb.appendChild(it);
        }
    };
    inject();
}

function todayISO() { return new Date().toISOString().slice(0,10); }

/* ── setupVideoListener : timeupdate optimisé ────────────────────────── */
function setupVideoListener() {
    const vp = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!vp || vp.dataset.ytbpObs === '1') return;
    vp.dataset.ytbpObs = '1';
    _cachedVideoEl = vp; // cache la référence globale

    // Throttle interne : on ne traite qu'une fois par seconde MAX
    let _lastTuSecond = -1;

    vp.addEventListener('timeupdate', () => {
        if (!vp.duration || isNaN(vp.duration)) return;
        const sec = Math.floor(vp.currentTime);
        // Sauter les appels redondants au même entier de seconde
        if (sec === _lastTuSecond) return;
        _lastTuSecond = sec;

        const vid   = new URLSearchParams(location.search).get('v');
        const today = todayISO();
        const ws    = ytData.watchStats;

        // Channel name : mis en cache par vidéo, pas re-queryé à chaque tick
        const ch = getCachedChannelName(vid);

        if (!ws.channels) ws.channels = {};
        if (!ws.channels[ch] || typeof ws.channels[ch] === 'number') {
            ws.channels[ch] = { views: typeof ws.channels[ch] === 'number' ? ws.channels[ch] : 0, time: 0, logo: '' };
        }

        // Logo : cherché une seule fois par vidéo
        if (vid && logoFoundFor !== vid) {
            const l = document.querySelector('ytd-video-owner-renderer img')?.src || '';
            if (l && l.includes('yt3') && !ws.channels[ch].logo) {
                ws.channels[ch].logo = l;
                logoFoundFor = vid;
                safeSet({watchStats: ws});
            }
        }

        // Détection nouvelle vidéo
        if (vid && vid !== lastDetectedVid) {
            recordVideoRetention();
            
            // Suivi du taux de rebond (25)
            const ref = document.referrer || '';
            const searchParams = new URLSearchParams(location.search);
            const isFromSearch = searchParams.has('search_query') || ref.includes('/results');
            const isFromSugg = searchParams.has('pp') || ref.includes('/watch') || searchParams.has('sqi') || searchParams.has('rco');
            
            if (isFromSearch) {
                ws.clicksSearch = (parseInt(ws.clicksSearch) || 0) + 1;
            } else if (isFromSugg) {
                ws.clicksSugg = (parseInt(ws.clicksSugg) || 0) + 1;
            }

            lastDetectedVid      = vid;
            skippedBeforeEndId   = null;
            currentCategory      = null;
            currentGame          = null;
            _cachedChannelName   = null; // invalide le cache channel
            setTimeout(() => {
                currentCategory = getVideoCategory();
                currentGame = currentCategory === 'Gaming' ? getGamingTitle() : null;
                
                // Mots-clés (49)
                const metaKws = document.querySelector('meta[name="keywords"]')?.content || '';
                if (metaKws) {
                    const kws = metaKws.split(',').map(s=>s.trim().toLowerCase()).filter(s=>s);
                    if (!ws.keywords) ws.keywords = {};
                    kws.slice(0, 5).forEach(kw => { // on prend les 5 premiers pour pas saturer le stockage
                        ws.keywords[kw] = (ws.keywords[kw] || 0) + 1;
                    });
                    safeSet({watchStats: ws});
                }
                logger("Catégorie détectée:", currentCategory, "Jeu:", currentGame);
                // La qualité maximale est gérée par inject.js (MAIN world)
            }, 3000);
        }

        // Timer flottant
        if (settings.showTimer && vid) {
            const td = document.getElementById('ytbp-floating-timer');
            if (td) {
                const r = Math.max(0, ((settings.autoBlockThreshold||75)/100) * vp.duration - sec);
                td.innerText = `⏱️ ${Math.floor(r/60)}:${Math.floor(r%60).toString().padStart(2,'0')}`;
            }
        }

        // Comptage de vue (une fois, après 5s)
        if (vp.currentTime > 5 && vid && vid !== countedId && vid !== autoBlockedId) {
            countedId = vid;
            ws.totalVideos = (parseInt(ws.totalVideos)||0) + 1;
            ws.channels[ch].views++;
            
            // Suivi des Shorts (25)
            if (location.pathname.startsWith('/shorts/')) {
                ws.shortsViews = (parseInt(ws.shortsViews)||0) + 1;
            }

            if (!ws.categories) ws.categories = {};
            const cat = currentCategory || "Autre";
            if (!ws.categories[cat]) ws.categories[cat] = { views: 0, time: 0 };
            ws.categories[cat].views++;
            if (cat === 'Gaming' && currentGame) {
                if (!ws.games) ws.games = {};
                if (!ws.games[currentGame]) ws.games[currentGame] = { views: 0, time: 0 };
                ws.games[currentGame].views++;
            }
            safeSet({watchStats: ws});
            dispatchAPIEvent('video_viewed', { videoId: vid, channel: ch });
        }

        // Suivi du temps de visionnage
        if (!vp.paused) {
            // Suivi de la rétention (26)
            activeVideoMaxTime = Math.max(activeVideoMaxTime, vp.currentTime);
            activeVideoDuration = vp.duration;

            const d = sec - lastTime;
            if (d > 0 && d <= 3) {
                ws.totalTimeWatched = (parseInt(ws.totalTimeWatched)||0) + d;
                ws.channels[ch].time += d;
                
                // Suivi des Shorts (25)
                if (location.pathname.startsWith('/shorts/')) {
                    ws.shortsTime = (parseInt(ws.shortsTime)||0) + d;
                }

                if (!ws.categories) ws.categories = {};
                const cat = currentCategory || "Autre";
                if (!ws.categories[cat]) ws.categories[cat] = { views: 0, time: 0 };
                ws.categories[cat].time += d;
                if (cat === 'Gaming' && currentGame) {
                    if (!ws.games) ws.games = {};
                    if (!ws.games[currentGame]) ws.games[currentGame] = { views: 0, time: 0 };
                    ws.games[currentGame].time += d;
                }
                if (!ws.dailyDated) ws.dailyDated = {};
                ws.dailyDated[today] = (ws.dailyDated[today]||0) + d;

                // Heatmap (21)
                if (!ws.heatmap) ws.heatmap = {};
                const now = new Date();
                const day = now.getDay(); // 0-6 (0 is Sunday, 1 is Monday...)
                const hour = now.getHours(); // 0-23
                const key_heatmap = `${day}_${hour}`;
                ws.heatmap[key_heatmap] = (ws.heatmap[key_heatmap] || 0) + d;

                // Playback speed tracking (28)
                if (!ws.speedStats) ws.speedStats = { "1": 0, "1.25": 0, "1.5": 0, "2": 0 };
                const pr = vp.playbackRate || 1;
                let speedKey = "1";
                if (pr >= 2.0) speedKey = "2";
                else if (pr >= 1.5) speedKey = "1.5";
                else if (pr >= 1.25) speedKey = "1.25";
                else if (pr < 1.0) speedKey = "0.75";
                else speedKey = "1";
                ws.speedStats[speedKey] = (ws.speedStats[speedKey] || 0) + d;

                // Daily productivity correlation (23)
                if (!ws.dailyProductive) ws.dailyProductive = {};
                if (!ws.dailyUnproductive) ws.dailyUnproductive = {};
                const isProd = (cat === 'Education' || cat === 'Science & Technology');
                const isUnprod = (cat === 'Gaming' || cat === 'Entertainment' || cat === 'Comedy');
                if (isProd) {
                    ws.dailyProductive[today] = (ws.dailyProductive[today] || 0) + d;
                } else if (isUnprod) {
                    ws.dailyUnproductive[today] = (ws.dailyUnproductive[today] || 0) + d;
                }

                // Rappels de Paliers (28)
                if (window._lastResetDate !== today) {
                    window._lastResetDate = today;
                    window._palier15Shown = false;
                    window._palier30Shown = false;
                    window._palier60Shown = false;
                }
                const todayMins = Math.floor(ws.dailyDated[today] / 60);
                if (todayMins >= 60 && !window._palier60Shown) {
                    window._palier60Shown = true;
                    toast("⏳ Focus : Vous avez cumulé 60 minutes sur YouTube aujourd'hui.");
                } else if (todayMins >= 30 && !window._palier30Shown) {
                    window._palier30Shown = true;
                    toast("⏳ Focus : Vous avez cumulé 30 minutes sur YouTube aujourd'hui.");
                } else if (todayMins >= 15 && !window._palier15Shown) {
                    window._palier15Shown = true;
                    toast("⏳ Focus : Vous avez cumulé 15 minutes sur YouTube aujourd'hui.");
                }

                // Sauvegarde au max toutes les 12s
                if (Date.now() - lastSave > 12000) {
                    safeSet({watchStats: ws});
                    lastSave = Date.now();
                    dispatchAPIEvent('watch_stats_update', { dailyTimeWatched: ws.dailyDated[today] || 0, totalTimeWatched: ws.totalTimeWatched || 0 });
                }
            }
            lastTime = sec;
        }

        // Auto-blocage par seuil de pourcentage
        if (vid && !isBlocked(vid) && (vp.currentTime/vp.duration)*100 >= (settings.autoBlockThreshold||75)) {
            autoBlockedId = vid;
            registerBlock(vid, "Seuil de visionnage dépassé");
            toast("⏱️ Limite atteinte — vidéo auto-bloquée !");
        }

        // Saut avant la fin
        const skipSecs = parseInt(settings.skipBeforeEnd) || 0;
        if (settings.skipBeforeEndEnabled && skipSecs > 0 && vid && vid !== skippedBeforeEndId) {
            const timeLeft = vp.duration - vp.currentTime;
            if (timeLeft > 0 && timeLeft <= skipSecs) {
                skippedBeforeEndId = vid;
                autoSkip("Saut de fin de vidéo.");
            }
        }
    });

    vp.addEventListener('seeked', () => { lastTime = Math.floor(vp.currentTime); });
}

/* ── Custom Logo clearable ──────────────────────────────────────────── */
let _customLogoInterval = null;
function startCustomLogo() {
    if (_customLogoInterval) { clearInterval(_customLogoInterval); _customLogoInterval = null; }
    if (!settings.customLogoUrl && !settings.customLogoText) {
        document.querySelectorAll('#logo-icon svg, yt-icon#logo-icon svg, ytd-topbar-logo-renderer svg').forEach(svg => {
            svg.style.display = '';
        });
        document.querySelectorAll('#ytbp-custom-logo, #ytbp-custom-logo-text').forEach(el => el.remove());
        return;
    }
    const applyLogo = () => {
        document.querySelectorAll('#logo-icon svg, yt-icon#logo-icon svg, ytd-topbar-logo-renderer svg').forEach(svg => {
            svg.style.display = 'none';
            
            if (settings.customLogoText) {
                svg.parentElement.querySelector('#ytbp-custom-logo')?.remove();
                let txtSpan = svg.parentElement.querySelector('#ytbp-custom-logo-text');
                if (!txtSpan) {
                    txtSpan = document.createElement('span');
                    txtSpan.id = 'ytbp-custom-logo-text';
                    txtSpan.className = 'ytbp-logo-text-glow';
                    svg.parentElement.appendChild(txtSpan);
                }
                if (txtSpan.innerText !== settings.customLogoText) {
                    txtSpan.innerText = settings.customLogoText;
                }
            } else if (settings.customLogoUrl) {
                svg.parentElement.querySelector('#ytbp-custom-logo-text')?.remove();
                let img = svg.parentElement.querySelector('#ytbp-custom-logo');
                if (!img) {
                    img = document.createElement('img');
                    img.id = 'ytbp-custom-logo';
                    svg.parentElement.appendChild(img);
                }
                if (img.src !== settings.customLogoUrl) img.src = settings.customLogoUrl;
            }
        });
    };
    applyLogo();
    _customLogoInterval = setInterval(applyLogo, 3000);
}

/* ── Interval de surveillance ────────────────────────────────────────── */
let curUrl       = location.href;
let _settingsDirty = false;
let _periodicTick  = 0;

/* ── Navigation SPA YouTube : événement natif (immédiat) + polling fallback ── */
window.addEventListener('yt-navigate-start', () => {
    // Nettoyage anticipé à la navigation
    logoFoundFor       = null;
    _cachedChannelName = null;
    _cachedVideoEl     = null;
    _card = null;
    document.getElementById('ytbp-video-btns')?.remove();
    // Reset du guard de redirection : chaque nouvelle page doit être évaluée indépendamment
    sessionStorage.removeItem('ytbp_redir_done');
    sessionStorage.removeItem('ytbp_focus_bypass');
});

window.addEventListener('yt-navigate-finish', () => {
    // Réponse immédiate sans attendre le prochain tick du polling
    if (location.href === curUrl) return; // déjà traité
    curUrl = location.href;
    const nv = new URL(location.href).searchParams.get('v') ||
               (location.href.includes('/live/') ? new URL(location.href).pathname.split('/')[2] : null);
    if (nv !== autoBlockedId)      autoBlockedId      = null;
    if (nv !== skippedBeforeEndId) skippedBeforeEndId = null;
    applyBlocks();
    _settingsDirty = true;
    applyPageMods();
    applyDynamicFilters(null);
    injectToolbar();
    setTimeout(() => { injectVideoButtons(); forceAutoplay(); forceTheaterMode(); }, 600);
    startCustomLogo();
});

function startPeriodicCheck() {
    // 2000ms : détecte la navigation SPA sans surcharger le CPU
    setInterval(() => {
        try {
            _periodicTick++;

            // 1. Navigation SPA
            if (location.href !== curUrl) {
                curUrl = location.href;
                const nv = new URL(location.href).searchParams.get('v') ||
                           (location.href.includes('/live/') ? new URL(location.href).pathname.split('/')[2] : null);
                if (nv !== autoBlockedId)      autoBlockedId      = null;
                if (nv !== skippedBeforeEndId) skippedBeforeEndId = null;
                logoFoundFor       = null;
                _cachedChannelName = null; // invalide le cache channel
                _cachedVideoEl     = null; // invalide le cache vidéo
                _card = null;
                document.getElementById('ytbp-video-btns')?.remove();
                applyBlocks();
                _settingsDirty = true;
            }

            // 1b. Vérification périodique du blocage de la page de lecture courante (rattrapage chargement asynchrone)
            if (location.pathname === '/watch' || location.pathname.startsWith('/live/')) {
                const url = new URL(location.href);
                const vid = url.searchParams.get('v') || (url.pathname.startsWith('/live/') ? url.pathname.split('/')[2] : null);
                if (vid && vid !== autoBlockedId) {
                    const ch = getCachedChannelName(vid);
                    const isNews = ch && ch !== 'Inconnu' && NEWS.some(n => ch.toLowerCase().includes(n));
                    if (isBlocked(vid) || (ch && ch !== 'Inconnu' && isChannelBlocked(ch))) {
                        autoSkip("Cette vidéo est dans ta liste de blocage.");
                    } else if (settings.blockNews && isNews) {
                        autoSkip(`La chaîne "${ch}" est bloquée.`);
                    }
                }
            }

            // 2. Toolbar (guard interne)
            injectToolbar();

            // 3. applyPageMods seulement si settings ont changé, ou périodiquement pour la barre latérale
            if (_settingsDirty) {
                applyPageMods();
                if (settings.hideChannelLogo || settings.hideChannelName || settings.hideViewCount || settings.hidePublishDate) {
                    applyDynamicFilters(null);
                }
                _settingsDirty = false;
            } else if (settings.hideSidebarSubs || settings.hideSidebarYou || settings.hideSidebarExplore || settings.hideSidebarMore) {
                applySidebarModifications();
            }

            // 4. Autoplay et Theater : 1 fois toutes les 6s (~3 ticks à 2000ms)
            if (_periodicTick % 3 === 0) {
                forceAutoplay();
                forceTheaterMode();
            }

            // 5. Video listener : si pas encore attaché
            if (!_cachedVideoEl || _cachedVideoEl.dataset.ytbpObs !== '1') {
                setupVideoListener();
            }

            // 6. Boutons vidéo (guard interne)
            injectVideoButtons();

        } catch(e) { logger("Error in periodic check:", e); }
    }, 2000);
}

/* ── MutationObserver : throttlé par debounce pour absorber les bursts ── */
function startObserver() {
    let _pendingNodes = [];
    let _debounceTimer = null;
    let _dynFilterNeeded = false;

    function processPending() {
        _debounceTimer = null;
        if (!_pendingNodes.length) return;
        const rawNodes = _pendingNodes;
        _pendingNodes = [];
        const nodes = [];
        for (const n of rawNodes) {
            if (n.isConnected && !rawNodes.some(parent => parent !== n && parent.contains(n))) {
                nodes.push(n);
            }
        }

        try {
            for (const node of nodes) {
                // Cartes vidéo → blocage immédiat
                if (node.matches?.(CARDS)) {
                    blockEls([node]);
                } else {
                    const c = node.querySelectorAll?.(CARDS);
                    if (c?.length) blockEls(Array.from(c));
                }

                // Shorts
                if (node.matches?.(SHORTS_SHELF) || node.matches?.(SHORTS_ITEM)) {
                    node.classList.toggle('ytbp-hidden', !!settings.blockShorts);
                } else {
                    node.querySelectorAll?.(SHORTS_SHELF).forEach(el => el.classList.toggle('ytbp-hidden', !!settings.blockShorts));
                    node.querySelectorAll?.(SHORTS_ITEM).forEach(el  => el.classList.toggle('ytbp-hidden', !!settings.blockShorts));
                }

                // Commentaires
                if (node.matches?.('ytd-comments#comments')) {
                    node.classList.toggle('ytbp-hidden', !!settings.hideComments);
                } else {
                    node.querySelectorAll?.('ytd-comments#comments').forEach(el => el.classList.toggle('ytbp-hidden', !!settings.hideComments));
                }

                // Posts Communauté
                const COMMUNITY_POSTS = 'ytd-post-renderer, ytd-shared-post-renderer, ytd-backstage-post-thread-renderer';
                if (node.matches?.(COMMUNITY_POSTS)) {
                    const shelf = node.closest?.('ytd-rich-section-renderer, ytd-item-section-renderer');
                    if (shelf) shelf.classList.toggle('ytbp-hidden', !!settings.hideCommunityPosts);
                    node.classList.toggle('ytbp-hidden', !!settings.hideCommunityPosts);
                } else {
                    node.querySelectorAll?.(COMMUNITY_POSTS).forEach(el => {
                        const shelf = el.closest('ytd-rich-section-renderer, ytd-item-section-renderer');
                        if (shelf) shelf.classList.toggle('ytbp-hidden', !!settings.hideCommunityPosts);
                        el.classList.toggle('ytbp-hidden', !!settings.hideCommunityPosts);
                    });
                }

                // Panneaux d'info
                const INFO_PANELS = 'ytd-clarification-renderer, ytd-info-panel-container-renderer, #clarify-box';
                if (node.matches?.(INFO_PANELS)) {
                    node.classList.toggle('ytbp-hidden', !!settings.hideInfoPanels);
                } else {
                    node.querySelectorAll?.(INFO_PANELS).forEach(el => el.classList.toggle('ytbp-hidden', !!settings.hideInfoPanels));
                }

                // Actualités (Alerte info) sur l'accueil
                if (node.matches?.('ytd-rich-section-renderer, ytd-shelf-renderer')) {
                    const title = node.querySelector('#title')?.innerText?.toLowerCase() || '';
                    if (title.includes('alerte info') || title.includes('actualité') || title.includes('breaking news') || title.includes('top news')) {
                        node.classList.toggle('ytbp-hidden', !!settings.hideInfoPanels);
                    }
                } else {
                    node.querySelectorAll?.('ytd-rich-section-renderer, ytd-shelf-renderer').forEach(shelf => {
                        const title = shelf.querySelector('#title')?.innerText?.toLowerCase() || '';
                        if (title.includes('alerte info') || title.includes('actualité') || title.includes('breaking news') || title.includes('top news')) {
                            shelf.classList.toggle('ytbp-hidden', !!settings.hideInfoPanels);
                        }
                    });
                }

                // Filtres meta : seulement si actif
                if (settings.hideViewCount || settings.hideDuration || settings.hidePublishDate) {
                    applyMetaFilters(node);
                }
                
                // applyDynamicFilters sur le nœud parent
                if (settings.hideChannelLogo || settings.hideChannelName) {
                    applyDynamicFilters(node.parentElement || node);
                }

                // Menu contextuel
                if (node.matches?.('ytd-menu-popup-renderer')) injectCtxMenu();
                else node.querySelectorAll?.('ytd-menu-popup-renderer').forEach(() => injectCtxMenu());
            }
            if (settings.hideSidebarSubs || settings.hideSidebarYou || settings.hideSidebarExplore || settings.hideSidebarMore) {
                applySidebarModifications();
            }
        } catch(e) { logger("Error in MutationObserver:", e); }
    }

    new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                const tag = node.tagName;
                // Ignorer les iframes sandboxées, scripts, styles, et SVG
                // Ces nœuds sont massivement ajoutés par YouTube Ads/Analytics
                // et ne contiennent jamais de cartes vidéo à traiter
                if (tag === 'IFRAME' || tag === 'SCRIPT' || tag === 'STYLE' ||
                    tag === 'LINK'   || tag === 'META'   || tag === 'SVG') continue;
                _pendingNodes.push(node);
            }
        }
        // Debounce : absorbe les bursts de mutations (ex. chargement infini)
        if (_pendingNodes.length && !_debounceTimer) {
            _debounceTimer = setTimeout(processPending, 100);
        }
    }).observe(document.body, { childList: true, subtree: true });
}
