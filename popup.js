document.addEventListener('DOMContentLoaded', async () => {
    // 1b. NOUVEAU: Gestionnaire du rapport d'impression PDF (évite le blocage Blob dans les onglets de MV3)
    const urlParams = new URLSearchParams(location.search);
    if (urlParams.get('report') === 'true') {
        chrome.storage.local.get(['tempReportHtml'], res => {
            if (res && res.tempReportHtml) {
                document.open();
                document.write(res.tempReportHtml);
                document.close();
            }
        });
        return; // Stoppe le chargement de l'interface popup standard
    }

    if (urlParams.get('download') === 'true') {
        chrome.storage.local.get(['tempDownloadData'], res => {
            if (res && res.tempDownloadData) {
                const { content, filename, mime } = res.tempDownloadData;
                try {
                    const blob = new Blob([content], { type: mime });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => {
                        URL.revokeObjectURL(url);
                        window.close();
                    }, 500);
                } catch(e) {
                    console.error("Download helper failed:", e);
                    window.close();
                }
            } else {
                window.close();
            }
        });
        return; // Stoppe le chargement de l'interface popup standard
    }

    // Nettoyer immédiatement les clés de sauvegarde obsolètes de chrome.storage.sync pour libérer le quota
    chrome.storage.sync.get(null, res => {
        if (chrome.runtime.lastError) return;
        const keysToRemove = Object.keys(res).filter(k => k.startsWith('backup_'));
        if (keysToRemove.length > 0) {
            chrome.storage.sync.remove(keysToRemove, () => {
                console.log("🛡️ [YTBP] Quota sync libéré : suppression des anciennes sauvegardes.");
            });
        }
    });

    /* ── Mode iframe (#35 : hauteur dynamique) ─────────────────────── */
    if (new URLSearchParams(location.search).get('inpage') === 'true') {
        const cb = document.getElementById('closeIframeBtn');
        cb.style.display = 'flex';
        cb.addEventListener('click', () => window.parent.postMessage('close-ytbp-iframe', '*'));
    }

    /* ── #73 : wrapper storage ─────────────────────────────────────── */
    const sg = keys => new Promise(r => { try { chrome.storage.sync.get(keys,res=>r(chrome.runtime.lastError?{}:res)); } catch(e){r({});} });
    function getProfilePrefix() {
        const prof = sync.activeProfile || 'default';
        return prof === 'default' ? '' : `${prof}_`;
    }
    const lg = keys => new Promise(r => {
        try {
            const prefix = getProfilePrefix();
            const wasArray = Array.isArray(keys);
            const queryKeys = (wasArray ? keys : [keys]).map(k => {
                if (k === 'blockedVideos' || k === 'blockedChannels' || k === 'watchStats' || k === 'blockHistory' || k === 'rollingBackups') {
                    return `${prefix}${k}`;
                }
                return k;
            });
            chrome.storage.local.get(queryKeys, res => {
                if (chrome.runtime.lastError) { r({}); return; }
                const out = {};
                for (const k of (wasArray ? keys : [keys])) {
                    const mappedKey = (k === 'blockedVideos' || k === 'blockedChannels' || k === 'watchStats' || k === 'blockHistory' || k === 'rollingBackups') ? `${prefix}${k}` : k;
                    out[k] = res[mappedKey];
                }
                r(wasArray ? out : out[keys]);
            });
        } catch(e) { r({}); }
    });
    const ls = obj => new Promise(r => {
        try {
            const prefix = getProfilePrefix();
            const prefixedObj = {};
            for (const [k, v] of Object.entries(obj)) {
                if (k === 'blockedVideos' || k === 'blockedChannels' || k === 'watchStats' || k === 'blockHistory' || k === 'rollingBackups') {
                    prefixedObj[`${prefix}${k}`] = v;
                } else {
                    prefixedObj[k] = v;
                }
            }
            chrome.storage.local.set(prefixedObj, () => {
                if (chrome.runtime.lastError) {
                    console.warn("Local storage write failed:", chrome.runtime.lastError.message);
                }
                r();
            });
        } catch(e) { r(); }
    });
    const ss = obj  => new Promise(r => {
        try {
            chrome.storage.sync.set(obj, () => {
                if (chrome.runtime.lastError) {
                    console.warn("Sync storage write failed:", chrome.runtime.lastError.message);
                }
                r();
            });
        } catch(e) { r(); }
    });

    const sync = await sg(null);
    let curPage = 1, curType = null, curPeriod = 'week';
    const PER_PAGE = 10;
    
    // NOUVEAU: hardHideBlocked ajouté à la liste des toggles
    const TOGGLES = ['hardHideBlocked','blockShorts','blockLives','hideComments','grayscale','hideMetrics',
                     'hideViewCount','hideDuration','hidePublishDate','hideSidebar',
                     'hideSidebarSubs','hideSidebarYou','hideSidebarExplore','hideSidebarMore','hideSidebarFooter',
                     'disableAutoplay','blockMiniplayer','showTimer','usePagination',
                     'hideChannelLogo','hideChannelName','hideCreateBtn','hideAccountBtn','hideSubCount',
                     'hideNotifications','hideSearch','hideHomeChips','hideSearchShelves',
                     'hideDescAll','hideDescLinks','hideDescCopyright','hideDescTranscription',
                     'hideSuggChips','hideSuggThumbs','hideSuggPanel',
                     'autoHighestQuality','hidePlayerUiKeys','skipBeforeEndEnabled',
                     'hideInfoPanels','hideTrendingShop','hideBadges','hideCommunityPosts',
                     'blockMixes','blockMovies','blurThumbnails','onlyPinnedComment','enableWheelVolume',
                     'autoTheaterMode','blockPremieres','hideSubscribeBtn','enablePanicButton',
                     'responsiveBlocks','strictLanguage','antiAutoTranslate','enableUninstallProtection'];

    /* ── BOUTONS CLOUD GOOGLE ────────────────────────────── */
    const btnSync = document.getElementById('btnForceCloudSync');
    const btnRecover = document.getElementById('btnRecoverCloud');
    const openCloudTab = () => {
        show('cloud', 'forward');
        document.getElementById('tabCloudAccount').click();
    };
    if (btnSync) btnSync.addEventListener('click', openCloudTab);
    if (btnRecover) btnRecover.addEventListener('click', openCloudTab);

    /* ── VUES + transitions ───────────────────────────────────────── */
    const V = {
        main:      document.getElementById('view-main'),
        list:      document.getElementById('view-list'),
        stats:     document.getElementById('view-stats'),
        chanStats: document.getElementById('view-channel-stats'),
        cloud:     document.getElementById('view-cloud'),
    };
    let prevView = 'main';
    /* FIX ANIMATION : annulation du timer précédent pour éviter les conflits */
    let _slideOutTimer = null, _slideInTimer = null;
    function show(key, dir = 'forward') {
        const prevKey = Object.entries(V).find(([,v])=>v.classList.contains('active-view'))?.[0];
        const prevEl  = prevKey ? V[prevKey] : null;
        if (prevKey === key) return;

        /* Annuler les timers en cours avant de relancer */
        if (_slideOutTimer) { clearTimeout(_slideOutTimer); _slideOutTimer = null; }
        if (_slideInTimer)  { clearTimeout(_slideInTimer);  _slideInTimer  = null; }

        /* Nettoyer toutes les classes d'animation en cours */
        Object.values(V).forEach(v => {
            v.classList.remove('slide-in-fwd','slide-in-bck','slide-out-fwd','slide-out-bck');
        });

        /* Sortie de l'ancienne vue : position absolute pendant l'anim pour éviter le double-height */
        if (prevEl) {
            prevEl.classList.add(dir === 'forward' ? 'slide-out-bck' : 'slide-out-fwd');
            _slideOutTimer = setTimeout(() => {
                prevEl.classList.remove('active-view','slide-out-fwd','slide-out-bck');
                _slideOutTimer = null;
            }, 220); /* légèrement > durée CSS (.19s–.2s) pour éviter le race condition */
        }

        /* Entrée de la nouvelle vue */
        V[key].classList.add('active-view', dir === 'forward' ? 'slide-in-fwd' : 'slide-in-bck');
        _slideInTimer = setTimeout(() => {
            V[key].classList.remove('slide-in-fwd','slide-in-bck');
            _slideInTimer = null;
        }, 220);
    }

    /* ── TOAST & MODAL ────────────────────────────────────────────── */
    function toast(msg, type='info', dur=3000) {
        const c=document.getElementById('toast-container');
        const t=document.createElement('div'); t.className=`toast toast-${type}`; t.textContent=msg;
        c.appendChild(t);
        requestAnimationFrame(()=>requestAnimationFrame(()=>t.classList.add('toast-show')));
        setTimeout(()=>{t.classList.remove('toast-show');setTimeout(()=>t.remove(),300);},dur);
    }

    function confirm(msg, onOk) {
        document.getElementById('modalMessage').innerText = msg;
        document.getElementById('customModal').style.display = 'flex';
        document.getElementById('modalBtnYes').onclick = () => { document.getElementById('customModal').style.display='none'; onOk(); };
        document.getElementById('modalBtnNo').onclick  = () => { document.getElementById('customModal').style.display='none'; };
    }

    /* ── BADGES & INIT ────────────────────────────────────────────── */
    function refreshBadges() {
        lg(['blockedVideos','blockedChannels']).then(r => {
            document.getElementById('badge-videos').textContent   = (r.blockedVideos   ||[]).length;
            document.getElementById('badge-channels').textContent = (r.blockedChannels ||[]).length;
            updateActiveFilterBar();
        });
    }
    chrome.storage.onChanged.addListener(() => refreshBadges());
    refreshBadges();

    document.getElementById('btnGoToVideos').onclick       = () => { show('list','forward');    renderList('videos'); };
    document.getElementById('btnGoToChannels').onclick     = () => { show('list','forward');    renderList('channels'); };
    document.getElementById('btnGoToHistory').onclick      = () => { show('list','forward');    renderList('history'); };
    document.getElementById('btnGoToStats').onclick        = () => { show('stats','forward');   renderStats(); };
    document.getElementById('btnGoToChannelStats').onclick = () => { show('chanStats','forward'); renderChanStats(); };
    document.getElementById('btnGoToCloud').onclick        = () => { show('cloud','forward');   initCloudView(); };
    document.querySelectorAll('.btnBack').forEach(b => b.addEventListener('click', () => show('main','back')));

    document.addEventListener('keydown', e => {
        if (e.altKey) {
            if (e.key==='s'||e.key==='S') { show('stats','forward'); renderStats(); }
            if (e.key==='v'||e.key==='V') { show('list','forward');  renderList('videos'); }
            if (e.key==='c'||e.key==='C') { show('list','forward');  renderList('channels'); }
            if (e.key==='h'||e.key==='H') show('main','back');
        }
        if (e.key==='Escape') show('main','back');
    });

    const themes = ['auto','dark','oled','light','cyberpunk','forest','sunset'];
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme || 'auto');
        document.body.setAttribute('data-theme', theme || 'auto');
        const themeEmojis = {
            auto: '💻',
            dark: '🌙',
            light: '☀️',
            oled: '🖤',
            cyberpunk: '👾',
            forest: '🌲',
            sunset: '🌇'
        };
        const toggleBtn = document.getElementById('btnThemeToggle');
        if (toggleBtn) {
            toggleBtn.textContent = themeEmojis[theme] || '💻';
        }
        const selTheme = document.getElementById('selForcedTheme');
        if (selTheme && selTheme.value !== theme) {
            selTheme.value = theme || 'auto';
        }
    }
    let themeIdx = themes.indexOf(sync.forcedTheme || 'auto');
    if (themeIdx<0) themeIdx=0;
    applyTheme(themes[themeIdx]);
    document.getElementById('btnThemeToggle').addEventListener('click', async () => {
        themeIdx = (themeIdx+1) % themes.length;
        const t = themes[themeIdx];
        await ss({forcedTheme: t});
        applyTheme(t);
    });

    // Profile Switcher (59)
    const selProfile = document.getElementById('selProfile');
    if (selProfile) {
        selProfile.value = sync.activeProfile || 'default';
        selProfile.addEventListener('change', async e => {
            await ss({ activeProfile: e.target.value });
            location.reload();
        });
    }

    // Google Drive Sync Simulator (51)
    const showSpinner = (text, onComplete) => {
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100vw';
        overlay.style.height = '100vh';
        overlay.style.backgroundColor = 'rgba(0,0,0,0.7)';
        overlay.style.backdropFilter = 'blur(4px)';
        overlay.style.zIndex = '99999';
        overlay.style.display = 'flex';
        overlay.style.flexDirection = 'column';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.color = '#fff';
        overlay.style.fontFamily = 'Inter, sans-serif';
        overlay.style.fontSize = '14px';
        overlay.style.animation = 'fadeIn 0.2s ease-out';
        
        overlay.innerHTML = `
            <div class="cloud-spinner" style="
                width: 40px;
                height: 40px;
                border: 3px solid rgba(255, 255, 255, 0.1);
                border-radius: 50%;
                border-top-color: #9d00ff;
                animation: spin 0.8s linear infinite;
                margin-bottom: 16px;
            "></div>
            <div style="font-weight: 600; text-align: center;">${text}</div>
            <style>
                @keyframes spin { to { transform: rotate(360deg); } }
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
            </style>
        `;
        document.body.appendChild(overlay);
        setTimeout(() => {
            overlay.remove();
            onComplete();
        }, 1500);
    };

    const btnCloudBackup = document.getElementById('btnCloudBackup');
    if (btnCloudBackup) btnCloudBackup.addEventListener('click', openCloudTab);

    const btnCloudRestore = document.getElementById('btnCloudRestore');
    if (btnCloudRestore) btnCloudRestore.addEventListener('click', openCloudTab);

    // Daily Rolling Backups UI integration (50)
    async function populateRollingBackups() {
        const r = await lg(['rollingBackups']);
        const backups = r.rollingBackups || [];
        const sel = document.getElementById('selRollingBackup');
        if (!sel) return;
        sel.innerHTML = '';
        if (backups.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'Aucune sauvegarde';
            sel.appendChild(opt);
            return;
        }
        backups.reverse().forEach((b, index) => {
            const opt = document.createElement('option');
            opt.value = backups.length - 1 - index; // original index
            const dateStr = new Date(b.timestamp).toLocaleDateString('fr-FR', {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit'
            });
            opt.textContent = `📅 ${dateStr} (${(b.blockedVideos || []).length} v., ${(b.blockedChannels || []).length} ch.)`;
            sel.appendChild(opt);
        });
    }
    populateRollingBackups();

    const btnRestoreRolling = document.getElementById('btnRestoreRolling');
    if (btnRestoreRolling) {
        btnRestoreRolling.addEventListener('click', async () => {
            const sel = document.getElementById('selRollingBackup');
            if (!sel || sel.value === '') {
                toast('⚠️ Aucune sauvegarde sélectionnée', 'info');
                return;
            }
            const idx = parseInt(sel.value, 10);
            confirm('Restaurer cette sauvegarde ? Vos données actuelles seront remplacées.', async () => {
                const r = await lg(['rollingBackups']);
                const backups = r.rollingBackups || [];
                const target = backups[idx];
                if (target) {
                    await ls({
                        blockedVideos: target.blockedVideos || [],
                        blockedChannels: target.blockedChannels || [],
                        watchStats: target.watchStats || null
                    });
                    toast('✅ Sauvegarde restaurée !', 'success');
                    setTimeout(() => location.reload(), 1000);
                } else {
                    toast('❌ Erreur : sauvegarde introuvable.', 'error');
                }
            });
        });
    }

    TOGGLES.forEach(id => {
        const el = document.getElementById(id); if (!el) return;
        // hardHideBlocked est activé par défaut si non défini
        if (id === 'hardHideBlocked' && sync[id] === undefined) {
            el.checked = true;
        } else {
            el.checked = sync[id] || false;
        }
        el.addEventListener('change', async e => {
            await ss({[id]: e.target.checked});
            updateActiveFilterBar();
            refreshZenButtons();
            /* Si tous les filtres description sont actifs → supprimer entièrement */
            checkDescAll();
        });
    });

    // Synchronisation bidirectionnelle du Mode Zen Premium
    function refreshZenButtons() {
        sg(['hideChannelLogo', 'hideChannelName', 'hideViewCount', 'hidePublishDate']).then(s => {
            document.querySelectorAll('.zen-btn').forEach(btn => {
                const key = btn.getAttribute('data-key');
                if (s[key]) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
        });
    }

    document.querySelectorAll('.zen-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const key = btn.getAttribute('data-key');
            const s = await sg([key]);
            const newVal = !s[key];
            
            // Met à jour la valeur dans le stockage
            await ss({ [key]: newVal });
            
            // Met à jour la case à cocher correspondante dans la grille
            const chk = document.getElementById(key);
            if (chk) chk.checked = newVal;
            
            refreshZenButtons();
            updateActiveFilterBar();
        });
    });

    // Initialisation du statut des boutons Zen
    refreshZenButtons();

    function updateActiveFilterBar() {
        sg(null).then(s => {
            const active = TOGGLES.filter(k => s[k] || (k === 'hardHideBlocked' && s[k] !== false));
            const bar    = document.getElementById('activeFiltersBar');
            const cnt    = document.getElementById('activeFiltersCount');
            if (active.length > 0 && bar) {
                bar.style.display = 'flex';
                cnt.textContent   = `${active.length} filtre${active.length>1?'s':''} actif${active.length>1?'s':''}`;
                document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('quick-btn-active'));
            } else if (bar) {
                bar.style.display = 'none';
            }
        });
    }

    /* Quand tous les filtres description sont actifs → cacher toute la description en permanence */
    async function checkDescAll() {
        const s = await sg(['hideDescLinks','hideDescCopyright','hideDescTranscription']);
        const allOn = !!(s.hideDescLinks && s.hideDescCopyright && s.hideDescTranscription);
        await ss({ hideDescAll: allOn });
        const hint = document.getElementById('descAllHint');
        if (hint) hint.textContent = allOn ? '⚠️ Tous actifs → description masquée en permanence' : '';
    }
    checkDescAll();
    updateActiveFilterBar();
    
    const clearBtn = document.getElementById('btnClearFilters');
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            const off = Object.fromEntries(TOGGLES.map(k=>[k,false]));
            await ss(off);
            TOGGLES.forEach(id => { const el=document.getElementById(id); if(el) el.checked=false; });
            updateActiveFilterBar();
            toast('✅ Tous les filtres désactivés','info');
        });
    }

    const descCb = document.getElementById('showDescriptions');
    if (descCb) {
        descCb.checked = sync.showDescriptions || false;
        function applyDesc(on) {
            document.querySelectorAll('.toggle-desc').forEach(d=>d.remove());
            if (!on) return;
            document.querySelectorAll('.toggle-row[data-desc]').forEach(row => {
                const d=document.createElement('p'); d.className='toggle-desc'; d.textContent=row.dataset.desc;
                row.after(d);
            });
        }
        applyDesc(descCb.checked);
        descCb.addEventListener('change', e => { ss({showDescriptions:e.target.checked}); applyDesc(e.target.checked); });
    }

    const filterSearch = document.getElementById('filterSearch');
    if (filterSearch) {
        filterSearch.addEventListener('input', e => {
            const term = e.target.value.toLowerCase();
            document.querySelectorAll('#togglesGrid .toggle-row').forEach(row => {
                const label = row.querySelector('.trow-label')?.textContent.toLowerCase() || '';
                const desc  = (row.dataset.desc || '').toLowerCase();
                row.style.display = (!term || label.includes(term) || desc.includes(term)) ? '' : 'none';
            });
        });
    }

    (function setupDragDrop() {
        const grid = document.getElementById('togglesGrid');
        if (!grid) return;
        let dragSrc = null;
        grid.addEventListener('dragstart', e => {
            dragSrc = e.target.closest('.toggle-row');
            if (!dragSrc) return;
            dragSrc.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        grid.addEventListener('dragover', e => {
            e.preventDefault();
            const target = e.target.closest('.toggle-row, .toggle-section-sep');
            if (!target || target === dragSrc) return;
            const rect = target.getBoundingClientRect();
            const after = e.clientY > rect.top + rect.height/2;
            grid.insertBefore(dragSrc, after ? target.nextSibling : target);
        });
        grid.addEventListener('dragend', () => {
            if (dragSrc) dragSrc.classList.remove('dragging');
            dragSrc = null;
            const order = [...grid.children].map(c => {
                if (c.classList.contains('toggle-row')) return `row:${c.dataset.key}`;
                if (c.classList.contains('toggle-section-sep')) return `sep:${c.textContent.trim()}`;
                return null;
            }).filter(Boolean);
            ss({filterOrder: order});
        });
    })();
    
    if (sync.filterOrder?.length) {
        const grid = document.getElementById('togglesGrid');
        if (grid) {
            const childrenMap = new Map();
            [...grid.children].forEach(c => {
                const id = c.classList.contains('toggle-row') ? `row:${c.dataset.key}` :
                           c.classList.contains('toggle-section-sep') ? `sep:${c.textContent.trim()}` : null;
                if (id) childrenMap.set(id, c);
            });
            
            const isNewFormat = sync.filterOrder.every(x => x.startsWith('row:') || x.startsWith('sep:'));
            if (isNewFormat) {
                sync.filterOrder.forEach(id => {
                    const node = childrenMap.get(id);
                    if (node) {
                        grid.appendChild(node);
                        childrenMap.delete(id);
                    }
                });
                childrenMap.forEach(node => grid.appendChild(node));
            } else {
                // Rétablir le layout par défaut catégorisé si format obsolète détecté
                ss({filterOrder: null});
            }
        }
    }

    const threshEl = document.getElementById('threshold');
    if (threshEl) threshEl.value = sync.autoBlockThreshold || 75;
    const saveThreshBtn = document.getElementById('saveThreshold');
    if (saveThreshBtn) {
        saveThreshBtn.addEventListener('click', async () => {
            const v = parseInt(document.getElementById('threshold').value,10);
            if (v>0&&v<=100) {
                await ss({autoBlockThreshold:v});
                const b=document.getElementById('saveThreshold'); b.textContent='✓'; b.classList.add('btn-success');
                setTimeout(()=>{b.textContent='Sauvegarder';b.classList.remove('btn-success');},1500);
            } else toast('⚠️ Valeur invalide (1–100)','error');
        });
    }

    /* ── Filtre durée ─────────────────────────────────────────────────── */
    const minDurEl = document.getElementById('minDuration');
    const maxDurEl = document.getElementById('maxDuration');
    if (minDurEl) minDurEl.value = sync.minDuration || 0;
    if (maxDurEl) maxDurEl.value = sync.maxDuration || 0;
    const saveDurBtn = document.getElementById('saveDuration');
    if (saveDurBtn) {
        saveDurBtn.addEventListener('click', async () => {
            const mn = parseInt(minDurEl?.value||'0',10);
            const mx = parseInt(maxDurEl?.value||'0',10);
            if (mx>0 && mn>0 && mx<=mn) { toast('⚠️ Max doit être > Min','error'); return; }
            await ss({minDuration:mn>=0?mn:0, maxDuration:mx>=0?mx:0});
            saveDurBtn.textContent='✓'; saveDurBtn.classList.add('btn-success');
            setTimeout(()=>{saveDurBtn.textContent='Sauvegarder';saveDurBtn.classList.remove('btn-success');},1500);
            toast('✅ Filtre durée mis à jour','success');
        });
    }

    /* ── Filtre vues ──────────────────────────────────────────────────── */
    const minViewsEl = document.getElementById('minViews');
    const maxViewsEl = document.getElementById('maxViews');
    if (minViewsEl) minViewsEl.value = sync.minViews || 0;
    if (maxViewsEl) maxViewsEl.value = sync.maxViews || 0;
    const saveViewsBtn = document.getElementById('saveViewsFilter');
    if (saveViewsBtn) {
        saveViewsBtn.addEventListener('click', async () => {
            const mn = parseInt(minViewsEl?.value||'0',10);
            const mx = parseInt(maxViewsEl?.value||'0',10);
            if (mx>0 && mn>0 && mx<=mn) { toast('⚠️ Max doit être > Min','error'); return; }
            await ss({minViews:mn>=0?mn:0, maxViews:mx>=0?mx:0});
            saveViewsBtn.textContent='✓'; saveViewsBtn.classList.add('btn-success');
            setTimeout(()=>{saveViewsBtn.textContent='Sauvegarder';saveViewsBtn.classList.remove('btn-success');},1500);
            toast('✅ Filtre vues mis à jour','success');
        });
    }

    /* ── Personnalisation (Logo & Favoris) ─────────────────────────────── */
    const customLogoEl = document.getElementById('customLogoUrl');
    const favChannelsEl = document.getElementById('favoriteChannels');
    if (customLogoEl) customLogoEl.value = sync.customLogoUrl || '';
    if (favChannelsEl) favChannelsEl.value = sync.favoriteChannels || '';
    const saveCustomUIBtn = document.getElementById('saveCustomUI');
    if (saveCustomUIBtn) {
        saveCustomUIBtn.addEventListener('click', async () => {
            const logo = customLogoEl?.value?.trim() || '';
            const favs = favChannelsEl?.value?.trim() || '';
            await ss({customLogoUrl: logo, favoriteChannels: favs});
            saveCustomUIBtn.textContent='✓'; saveCustomUIBtn.classList.add('btn-success');
            setTimeout(()=>{saveCustomUIBtn.textContent='Sauvegarder l\'UI';saveCustomUIBtn.classList.remove('btn-success');},1500);
            toast('✅ Personnalisation mise à jour','success');
        });
    }

    /* ── Fin de vidéo anticipée ────────────────────────────────────────── */
    const skipBeforeEndEl = document.getElementById('skipBeforeEnd');
    if (skipBeforeEndEl) skipBeforeEndEl.value = sync.skipBeforeEnd || 10;
    const saveSkipBtn = document.getElementById('saveSkipBeforeEnd');
    if (saveSkipBtn) {
        saveSkipBtn.addEventListener('click', async () => {
            const v = parseInt(skipBeforeEndEl.value, 10);
            if (v >= 0) {
                await ss({ skipBeforeEnd: v });
                saveSkipBtn.textContent = '✓'; saveSkipBtn.classList.add('btn-success');
                setTimeout(() => { saveSkipBtn.textContent = 'Sauvegarder'; saveSkipBtn.classList.remove('btn-success'); }, 1500);
                toast('✅ Délai de saut anticipé mis à jour', 'success');
            } else toast('⚠️ Valeur invalide', 'error');
        });
    }

    document.getElementById('clearData').addEventListener('click', () => {
        confirm('⚠️ Voulez-vous vraiment TOUT effacer ? Action irréversible.', async () => {
            await ls({blockedVideos:[],blockedChannels:[],watchStats:null,blockHistory:[]});
            refreshBadges(); toast('✅ Données effacées','success');
            setTimeout(()=>location.reload(),800);
        });
    });

    const btnMigrate = document.getElementById('btnMigrateOld');
    if (btnMigrate) {
        btnMigrate.addEventListener('click', async () => {
            const r = await lg(['blockedVideos']);
            const vids = r.blockedVideos||[];
            if (!vids.some(v=>typeof v==='object')) { toast('✅ Données déjà optimisées !','success'); return; }
            confirm("Compresser l'ancien format ?", async () => {
                await ls({blockedVideos:vids.map(v=>typeof v==='object'?compressVideo(v):v)});
                toast('✅ Migration réussie !','success'); setTimeout(()=>location.reload(),800);
            });
        });
    }

    const importFile = document.getElementById('importFile');
    if (importFile) {
        importFile.addEventListener('change', async e => {
            const f=e.target.files[0]; if(!f)return;
            const text = await f.text();
            try {
                const d=JSON.parse(text);
                if(!d.blockedVideos&&!d.blockedChannels){toast('❌ Fichier invalide','error');return;}
                confirm(`Fusionner ? (${(d.blockedVideos||[]).length} vidéos, ${(d.blockedChannels||[]).length} chaînes)`, async ()=>{
                    const res=await lg(['blockedVideos','blockedChannels']);
                    let curr=res.blockedVideos||[],added=0;
                    (d.blockedVideos||[]).forEach(v=>{const c=compressVideo(v);if(!curr.some(cv=>decompressVideo(cv).id===decompressVideo(c).id)){curr.push(c);added++;}});
                    const ch=[...new Set([...(res.blockedChannels||[]),...(d.blockedChannels||[])])];
                    await ls({blockedVideos:curr,blockedChannels:ch});
                    refreshBadges(); toast(`✅ ${added} vidéo(s) importée(s)`,'success');
                });
            } catch(_){toast('❌ Erreur de lecture','error');}
            e.target.value='';
        });
    }

    const bindImportSettings = (el) => {
        if (!el) return;
        el.addEventListener('change', async e => {
            const f=e.target.files[0]; if(!f)return;
            const text = await f.text();
            try {
                const d=JSON.parse(text);
                if (d.blockShorts === undefined && d.autoBlockThreshold === undefined) {
                    toast('❌ Fichier de réglages invalide','error');
                    return;
                }
                confirm('Importer ces réglages ? Cela remplacera votre configuration actuelle.', async () => {
                    await ss(d);
                    toast('⚙️ Réglages importés !','success');
                    setTimeout(()=>location.reload(),800);
                });
            } catch(_){toast('❌ Erreur de lecture','error');}
            e.target.value='';
        });
    };
    bindImportSettings(document.getElementById('importSettingsFile'));
    bindImportSettings(document.getElementById('importSettingsFile2'));

    const importStatsFile = document.getElementById('importStatsFile');
    if (importStatsFile) {
        importStatsFile.addEventListener('change', async e => {
            const f=e.target.files[0]; if(!f)return;
            const text=await f.text();
            try {
                const d=JSON.parse(text);
                const inc=d.watchStats||(d.dailyDated?d:null);
                if(!inc){toast('❌ Fichier stats invalide','error');return;}
                confirm('Fusionner ces statistiques ?', async ()=>{
                    const res=await lg(['watchStats']); const ex=res.watchStats||{};
                    const mD={...(ex.dailyDated||{})};
                    Object.entries(inc.dailyDated||{}).forEach(([dt,s])=>{mD[dt]=(mD[dt]||0)+s;});
                    const mC={...(ex.channels||{})};
                    Object.entries(inc.channels||{}).forEach(([n,d])=>{
                        const i=typeof d==='number'?{views:d,time:0,logo:''}:d;
                        if(!mC[n])mC[n]={...i};
                        else{mC[n].views=(mC[n].views||0)+(i.views||0);mC[n].time=(mC[n].time||0)+(i.time||0);if(!mC[n].logo&&i.logo)mC[n].logo=i.logo;}
                    });
                    await ls({watchStats:{...ex,totalTimeWatched:(ex.totalTimeWatched||0)+(inc.totalTimeWatched||0),timeSaved:(ex.timeSaved||0)+(inc.timeSaved||0),totalVideos:(ex.totalVideos||0)+(inc.totalVideos||0),totalBlockedCount:(ex.totalBlockedCount||0)+(inc.totalBlockedCount||0),dailyDated:mD,channels:mC}});
                    toast('✅ Stats fusionnées !','success'); renderStats();
                });
            } catch(_){toast('❌ Erreur de lecture','error');}
            e.target.value='';
        });
    }

    const searchList = document.getElementById('searchList');
    if (searchList) {
        searchList.addEventListener('input', e=>{
            const t=e.target.value.toLowerCase();
            document.querySelectorAll('#list-container .list-item,.channel-item').forEach(el=>el.classList.toggle('ytbp-hidden',!el.innerText.toLowerCase().includes(t)));
        });
    }
    const searchChanStats = document.getElementById('searchChannelStats');
    if (searchChanStats) {
        searchChanStats.addEventListener('input', e=>{
            const t=e.target.value.toLowerCase();
            document.querySelectorAll('#all-channels-stats .chan-item').forEach(el=>el.classList.toggle('ytbp-hidden',!el.innerText.toLowerCase().includes(t)));
        });
    }

    document.querySelectorAll('.period-tab').forEach(tab=>{
        tab.addEventListener('click',()=>{
            document.querySelectorAll('.period-tab').forEach(t=>t.classList.remove('active'));
            tab.classList.add('active'); curPeriod=tab.dataset.period; renderStats();
        });
    });

    function filterDaily(daily, period) {
        const cutoff=new Date();
        if(period==='week') cutoff.setDate(cutoff.getDate()-6);
        if(period==='month')cutoff.setDate(cutoff.getDate()-29);
        const out={};
        Object.entries(daily||{}).forEach(([d,s])=>{if(period==='all'||new Date(d)>=cutoff)out[d]=s;});
        return out;
    }

    function chartData(daily, period) {
        if(period==='all'){
            const m={};
            Object.entries(daily||{}).forEach(([d,s])=>{const k=d.slice(0,7);m[k]=(m[k]||0)+s;});
            return Object.entries(m).sort().map(([k,s])=>({label:new Date(k+'-01').toLocaleDateString('fr-FR',{month:'short',year:'2-digit'}),secs:s}));
        }
        const n=period==='week'?7:30; const days=[];
        for(let i=n-1;i>=0;i--){
            const d=new Date(); d.setDate(d.getDate()-i);
            const key=d.toISOString().slice(0,10);
            const showLabel = n<=7 ? true : (i % 5 === 0 || i === n-1);
            const label = showLabel ? (n<=7 ? d.toLocaleDateString('fr-FR',{weekday:'short'}) : d.toLocaleDateString('fr-FR',{day:'numeric',month:'short'})) : '';
            days.push({label, secs:(daily||{})[key]||0});
        }
        return days;
    }

    function computeComparison(daily, period) {
        if (period === 'all') return null;
        const n = period === 'week' ? 7 : 30;
        const cur=new Date(), cutCur=new Date(), cutPrev=new Date(), cutPrevEnd=new Date();
        cutCur.setDate(cur.getDate()-n+1);    cutCur.setHours(0,0,0,0);
        cutPrev.setDate(cur.getDate()-n*2+1); cutPrev.setHours(0,0,0,0);
        cutPrevEnd.setDate(cur.getDate()-n);  cutPrevEnd.setHours(23,59,59,999);
        let sumCur=0, sumPrev=0;
        Object.entries(daily||{}).forEach(([d,s])=>{
            const dt=new Date(d);
            if(dt>=cutCur)sumCur+=s;
            else if(dt>=cutPrev&&dt<=cutPrevEnd)sumPrev+=s;
        });
        const diff=sumCur-sumPrev;
        const pct=sumPrev>0?Math.round(Math.abs(diff)/sumPrev*100):null;
        return {cur:sumCur,prev:sumPrev,diff,pct};
    }

    const CATEGORIES = {
        '🎮 Gaming':      ['game','gaming','jeu','minecraft','fortnite','gta','roblox','pokemon','zelda','league','valorant','cs:go','pubg'],
        '😂 Humour':      ['drôle','humour','prank','blague','comedy','funny','sketch','mdr','lol'],
        '🎵 Musique':     ['music','chanson','album','rap','clip','concert','playlist','remix','cover'],
        '📚 Éducatif':    ['tuto','tutorial','cours','learn','apprendre','formation','explication','science','histoire','math'],
        '🗞️ Actualités':  ['news','actu','politique','économie','société','monde','france','info'],
        '🍕 Food/Vlog':   ['vlog','food','cuisine','recette','restaurant','travel','voyage','mukbang'],
        '💪 Sport/Fit':   ['sport','foot','basket','fitness','musculation','running','workout','football'],
        '🎬 Divertissement':['film','série','cinema','movie','trailer','reaction','top','ranking'],
    };

    const CAT_MAP = {
        'Gaming': '🎮 Jeux vidéo',
        'Music': '🎵 Musique',
        'Entertainment': '🎬 Divertissement',
        'Education': '📚 Éducatif',
        'Comedy': '😂 Humour',
        'News & Politics': '🗞️ Actualités',
        'Sports': '💪 Sport',
        'Howto & Style': '🍕 Mode & Style',
        'People & Blogs': '🍕 Vlogs & Blogs',
        'Science & Technology': '🔬 Sciences & Tech',
        'Film & Animation': '🎥 Cinéma & Anim.',
        'Autre': '📁 Autre'
    };
    function categorizeChannels(channels) {
        const result = {};
        Object.entries(channels||{}).forEach(([name,data])=>{
            const t=(data.time||0), n=name.toLowerCase();
            if(!t)return;
            let found=false;
            for(const [cat,kws] of Object.entries(CATEGORIES)){
                if(kws.some(k=>n.includes(k))){result[cat]=(result[cat]||0)+t;found=true;break;}
            }
            if(!found)result['🎬 Divertissement']=(result['🎬 Divertissement']||0)+t;
        });
        return Object.entries(result).sort((a,b)=>b[1]-a[1]).slice(0,6);
    }

    async function renderStats() {
        show('stats','forward');
        const res=await lg(['watchStats']); const stats=res.watchStats||{},daily=stats.dailyDated||{};
        const filtered=filterDaily(daily,curPeriod);
        const total=Object.values(filtered).reduce((a,b)=>a+b,0);
        document.getElementById('statTimeWatched').textContent=formatTime(curPeriod==='all'?(stats.totalTimeWatched||0):total);
        document.getElementById('statTimeSaved').textContent=formatTime(stats.timeSaved||0);
        document.getElementById('statVidsWatched').textContent=stats.totalVideos||0;
        document.getElementById('statVidsBlocked').textContent=stats.totalBlockedCount||0;

        const chart = document.getElementById('activityChart');
        chart.innerHTML = '';
        const days = chartData(daily, curPeriod);
        const max = Math.max(...days.map(d => d.secs), 1);
        
        const chartWidth = 340;
        const chartHeight = 70;
        const points = days.map((d, i) => {
            const x = i * (chartWidth / Math.max(days.length - 1, 1));
            const y = chartHeight - (d.secs / max) * chartHeight + 10;
            return { x, y, label: d.label, secs: d.secs };
        });

        let lineD = "";
        let areaD = "";
        if (points.length > 0) {
            lineD = `M ${points[0].x} ${points[0].y}`;
            areaD = `M ${points[0].x} ${chartHeight + 15} L ${points[0].x} ${points[0].y}`;
            for (let i = 1; i < points.length; i++) {
                lineD += ` L ${points[i].x} ${points[i].y}`;
                areaD += ` L ${points[i].x} ${points[i].y}`;
            }
            areaD += ` L ${points[points.length - 1].x} ${chartHeight + 15} Z`;
        }

        const circleMarkup = points.map(p => `
            <g class="chart-point-group">
                <circle cx="${p.x}" cy="${p.y}" r="4" fill="var(--accent2)" stroke="var(--bg-main)" stroke-width="2" style="transition: all 0.2s var(--ease);"></circle>
                <title>${p.label || '—'} : ${formatTime(p.secs)}</title>
            </g>
        `).join('');

        const labelMarkup = points.map(p => p.label ? `
            <text x="${p.x}" y="${chartHeight + 28}" fill="var(--txt-muted)" font-size="7.5" font-weight="600" text-anchor="middle" font-family="'Outfit', sans-serif">${p.label}</text>
        ` : '').join('');

        chart.innerHTML = `
            <svg viewBox="0 0 ${chartWidth} 100" style="width: 100%; height: 100%; overflow: visible;">
                <defs>
                    <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.45"></stop>
                        <stop offset="100%" stop-color="var(--accent2)" stop-opacity="0"></stop>
                    </linearGradient>
                </defs>
                <line x1="0" y1="10" x2="${chartWidth}" y2="10" stroke="rgba(255,255,255,0.04)" stroke-dasharray="2,2"></line>
                <line x1="0" y1="45" x2="${chartWidth}" y2="45" stroke="rgba(255,255,255,0.04)" stroke-dasharray="2,2"></line>
                <line x1="0" y1="${chartHeight + 15}" x2="${chartWidth}" y2="${chartHeight + 15}" stroke="rgba(255,255,255,0.08)"></line>
                <path d="${areaD}" fill="url(#chartGrad)"></path>
                <path d="${lineD}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
                ${labelMarkup}
                ${circleMarkup}
            </svg>
        `;

        const cmp=computeComparison(daily,curPeriod);
        const cmpEl=document.getElementById('statsComparison');
        if(cmp&&curPeriod!=='all'){
            const arrow=cmp.diff<=0?'↓':'↑';
            const cls=cmp.diff<=0?'cmp-better':'cmp-worse';
            const label=curPeriod==='week'?'vs semaine préc.':'vs mois préc.';
            cmpEl.innerHTML=`<span class="${cls}">${arrow} ${cmp.pct!==null?cmp.pct+'%':'N/A'} ${label}</span><span class="cmp-detail">${formatTime(cmp.cur)} vs ${formatTime(cmp.prev)}</span>`;
            cmpEl.style.display='flex';
        } else cmpEl.style.display='none';

        const trackedCategories = stats.categories || {};
        const trackedGames = stats.games || {};
        const catEl = document.getElementById('categoryStats');
        const gameEl = document.getElementById('gameStats');

        let catsToRender = [];
        if (Object.keys(trackedCategories).length > 0) {
            catsToRender = Object.entries(trackedCategories)
                .map(([name, data]) => {
                    const frenchName = CAT_MAP[name] || `📁 ${name}`;
                    return [frenchName, data.time || 0];
                })
                .sort((a, b) => b[1] - a[1]);
        } else {
            catsToRender = categorizeChannels(stats.channels || {});
        }

        if (catsToRender.length > 0) {
            const maxCat = catsToRender[0][1];
            catEl.innerHTML = `<div class="section-title" style="margin-bottom:8px">📂 Par catégorie</div>` +
                catsToRender.map(([n, t]) => `<div class="cat-row"><span class="cat-name">${n}</span><div class="cat-bar-wrap"><div class="cat-bar" style="width:${maxCat > 0 ? Math.round((t / maxCat) * 100) : 0}%"></div></div><span class="cat-time">${formatTime(t)}</span></div>`).join('');
            catEl.style.display = 'block';
        } else {
            catEl.style.display = 'none';
        }

        // Jeux vidéo les plus regardés
        const gamesToRender = Object.entries(trackedGames)
            .map(([name, data]) => [name, data.time || 0])
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);

        if (gamesToRender.length > 0) {
            const maxGame = gamesToRender[0][1];
            gameEl.innerHTML = `<div class="section-title" style="margin-bottom:8px">🎮 Jeux vidéo les plus regardés</div>` +
                gamesToRender.map(([n, t]) => `<div class="cat-row"><span class="cat-name">🕹️ ${n}</span><div class="cat-bar-wrap"><div class="cat-bar" style="background: linear-gradient(135deg, #10b981 0%, #14b8a6 100%); width:${maxGame > 0 ? Math.round((t / maxGame) * 100) : 0}%"></div></div><span class="cat-time">${formatTime(t)}</span></div>`).join('');
            gameEl.style.display = 'block';
        } else {
            gameEl.style.display = 'none';
        }

        /* ── Nouvelles métriques ──────────────────────────────────────── */
        const filteredEntries = Object.entries(filtered);
        const activeDays = filteredEntries.filter(([,s])=>s>0).length;
        const avgDay = activeDays>0 ? Math.round(filteredEntries.reduce((a,[,s])=>a+s,0)/activeDays) : 0;
        const bestEntry = filteredEntries.sort((a,b)=>b[1]-a[1])[0];
        const bestDay = bestEntry && bestEntry[1]>0 ? formatTime(bestEntry[1]) : '—';
        const bestDayDate = bestEntry ? new Date(bestEntry[0]).toLocaleDateString('fr-FR',{day:'numeric',month:'short'}) : '';

        const avgEl = document.getElementById('statAvgDay');
        const bestEl = document.getElementById('statBestDay');
        const activeDaysEl = document.getElementById('statActiveDays');
        if(avgEl) avgEl.textContent = avgDay>0 ? formatTime(avgDay) : '—';
        if(bestEl) bestEl.innerHTML = bestDay !== '—' ? `${bestDay}<br><span style="font-size:9px;opacity:.7">${bestDayDate}</span>` : '—';
        if(activeDaysEl) activeDaysEl.textContent = activeDays>0 ? activeDays : '—';

        /* Score de discipline (ratio temps sauvé / temps total, 0–100) */
        const totalW = stats.totalTimeWatched||0;
        const totalS = stats.timeSaved||0;
        const scoreWrap = document.getElementById('statScoreWrap');
        const scoreBar  = document.getElementById('statScoreBar');
        const scoreVal  = document.getElementById('statScoreVal');
        if (scoreWrap && totalW+totalS > 0) {
            const score = Math.round((totalS/(totalW+totalS))*100);
            const color = score>=70?'#10b981':score>=40?'#f59e0b':'#ef4444';
            const emoji = score>=70?'🟢':score>=40?'🟡':'🔴';
            if(scoreBar){ scoreBar.style.width=score+'%'; scoreBar.style.background=color; }
            if(scoreVal) scoreVal.textContent = `${emoji} ${score}% (${totalS>totalW?'🏆 tu économises plus que tu regardes !':'continue !'})`;
            scoreWrap.style.display='block';
        } else if(scoreWrap) scoreWrap.style.display='none';
    }

    /* ── Téléchargement sécurisé via onglet d'extension temporaire ── */
    const dl = (content, name, mime = 'application/octet-stream') => {
        try {
            chrome.storage.local.set({
                tempDownloadData: { content, filename: name, mime }
            }, () => {
                chrome.tabs.create({
                    url: chrome.runtime.getURL('popup.html?download=true'),
                    active: false
                });
            });
        } catch(e) {
            console.error("Save to storage for download failed:", e);
        }
    };
    const nowStr=()=>new Date().toISOString().slice(0,10);

    async function exportStatsCSV(){
        const r=await lg(['watchStats']); const d=(r.watchStats||{}).dailyDated||{};
        if(!Object.keys(d).length){toast('⚠️ Aucune donnée','info');return;}
        let csv='Date,Secondes,Temps\n';
        Object.entries(d).sort().forEach(([dt,s])=>{csv+=`${dt},${s},${formatTime(s)}\n`;});
        dl(csv,`ytbp_stats_${nowStr()}.csv`,'text/csv;charset=utf-8'); toast('📄 CSV exporté !','success');
    }
    async function exportStatsJSON(){
        const r=await lg(['watchStats']);
        dl(JSON.stringify(r.watchStats||{},null,2),`ytbp_stats_${nowStr()}.json`,'application/json');
        toast('💾 JSON exporté !','success');
    }
    async function exportListJSON(){
        const r=await lg(['blockedVideos','blockedChannels']);
        dl(JSON.stringify({blockedVideos:r.blockedVideos||[],blockedChannels:r.blockedChannels||[]},null,2),`ytbp_listes_${nowStr()}.json`,'application/json');
        toast('💾 Listes exportées !','success');
    }
    async function exportSettingsJSON(){
        const r=await sg(null);
        dl(JSON.stringify(r,null,2),`ytbp_reglages_${nowStr()}.json`,'application/json');
        toast('⚙️ Réglages exportés !','success');
    }

    async function exportPDF(){
        const r=await lg(['watchStats','blockedVideos','blockedChannels']);
        const stats=r.watchStats||{}, bvCount=(r.blockedVideos||[]).length, bcCount=(r.blockedChannels||[]).length;
        const today=new Date().toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'});
        const daily=stats.dailyDated||{};
        
        const trackedCategories = stats.categories || {};
        const trackedGames = stats.games || {};
        
        let catsToRender = [];
        if (Object.keys(trackedCategories).length > 0) {
            catsToRender = Object.entries(trackedCategories)
                .map(([name, data]) => {
                    const frenchName = CAT_MAP[name] || name;
                    return [frenchName, data.time || 0];
                })
                .sort((a, b) => b[1] - a[1]);
        } else {
            catsToRender = categorizeChannels(stats.channels || {});
        }

        const gamesToRender = Object.entries(trackedGames)
            .map(([name, data]) => [name, data.time || 0])
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);

        const topCh=Object.entries(stats.channels||{}).sort((a,b)=>(b[1].time||0)-(a[1].time||0)).slice(0,5);
        /* ── Sécurité : évite Math.max() sur tableau vide (crash) ── */
        const dailyVals=Object.values(daily); const maxDaily=dailyVals.length?Math.max(...dailyVals):1;
        const chartRows=Object.entries(daily).sort().slice(-30).map(([d,s])=>`<tr><td>${d}</td><td>${formatTime(s)}</td><td style="width:200px"><div style="height:10px;background:#9d00ff;width:${Math.round((s/maxDaily)*100)}%;border-radius:3px"></div></td></tr>`).join('');
        const html=`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Rapport YTBP — ${today}</title>
        <style>body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;color:#111;font-size:14px;} h1{color:#9d00ff;font-size:24px;} h2{color:#555;font-size:16px;border-bottom:2px solid #9d00ff;padding-bottom:6px;margin-top:30px;} .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0;} .box{padding:14px;border-radius:8px;background:#f5f5f5;text-align:center;} .box-val{font-size:22px;font-weight:bold;color:#9d00ff;} .box-lbl{font-size:11px;color:#777;margin-top:4px;} table{width:100%;border-collapse:collapse;} td,th{padding:6px 8px;text-align:left;border-bottom:1px solid #eee;} .cat{display:flex;align-items:center;gap:10px;margin:6px 0;} .cat-bar-w{flex:1;height:8px;background:#eee;border-radius:4px;} .cat-bar-f{height:100%;background:#9d00ff;border-radius:4px;} footer{margin-top:40px;font-size:11px;color:#aaa;text-align:center;} @media print{body{margin:20px;}}</style>
        <script>window.onload=()=>{window.print();}\x3c/script></head><body>
        <h1>🛡️ YouTube Blocker Pro — Rapport du ${today}</h1>
        <div class="grid">
            <div class="box"><div class="box-val">${formatTime(stats.totalTimeWatched||0)}</div><div class="box-lbl">Temps regardé</div></div>
            <div class="box"><div class="box-val">${formatTime(stats.timeSaved||0)}</div><div class="box-lbl">Temps sauvé</div></div>
            <div class="box"><div class="box-val">${bvCount}</div><div class="box-lbl">Vidéos bloquées</div></div>
            <div class="box"><div class="box-val">${bcCount}</div><div class="box-lbl">Chaînes bloquées</div></div>
        </div>
        <h2>📊 Activité des 30 derniers jours</h2>
        <table>${chartRows}</table>
        ${catsToRender.length?`<h2>📂 Par catégorie</h2>${catsToRender.map(([n,t])=>`<div class="cat"><span style="width:160px">${n}</span><div class="cat-bar-w"><div class="cat-bar-f" style="width:${Math.round((t/catsToRender[0][1])*100)}%"></div></div><span style="width:80px;text-align:right">${formatTime(t)}</span></div>`).join('')}`:''}
        ${gamesToRender.length?`<h2>🎮 Jeux vidéo les plus regardés</h2>${gamesToRender.map(([n,t])=>`<div class="cat"><span style="width:160px">🕹️ ${n}</span><div class="cat-bar-w"><div class="cat-bar-f" style="background:#10b981; width:${Math.round((t/gamesToRender[0][1])*100)}%"></div></div><span style="width:80px;text-align:right">${formatTime(t)}</span></div>`).join('')}`:''}
        ${topCh.length?`<h2>📺 Top 5 chaînes</h2><table><tr><th>Chaîne</th><th>Vues</th><th>Temps</th></tr>${topCh.map(([n,d])=>`<tr><td>${n}</td><td>${d.views||0}</td><td>${formatTime(d.time||0)}</td></tr>`).join('')}</table>`:''}
        <footer>Généré par YouTube Blocker Pro le ${today}</footer>
        </body></html>`;
        // Écriture du rapport dans le stockage local et ouverture sécurisée dans un onglet d'extension (pour éviter le blocage Blob de MV3)
        chrome.storage.local.set({ tempReportHtml: html }, () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?report=true') });
        });
        toast('📑 Rapport généré ! Imprimez-le en faisant Ctrl+P.','success',4000);
    }

    async function generateMonthlyReport(){
        const r=await lg(['watchStats']);
        const stats=r.watchStats||{},daily=stats.dailyDated||{};
        const now=new Date();
        const curM=now.toISOString().slice(0,7);
        const prevDate=new Date(now); prevDate.setMonth(prevDate.getMonth()-1);
        const prevM=prevDate.toISOString().slice(0,7);
        let curSecs=0,prevSecs=0;
        Object.entries(daily).forEach(([d,s])=>{
            if(d.startsWith(curM))curSecs+=s;
            else if(d.startsWith(prevM))prevSecs+=s;
        });
        const diff=curSecs-prevSecs, pct=prevSecs>0?Math.abs(Math.round(diff/prevSecs*100)):null;
        const topCh=Object.entries(stats.channels||{}).sort((a,b)=>(b[1].time||0)-(a[1].time||0)).slice(0,3).map(([n])=>n);
        const cats=categorizeChannels(stats.channels||{});
        const topCat=cats[0]?cats[0][0]:'N/A';
        const monthName=now.toLocaleDateString('fr-FR',{month:'long',year:'numeric'});
        let narrative=`📅 **Rapport de ${monthName}**\n\n`;
        narrative+=`⏱️ Tu as regardé YouTube **${formatTime(curSecs)}** ce mois-ci`;
        if(pct!==null)narrative+=` (${diff<0?'−'+pct+'% 🎉':'+'+ pct+'% 📈'} vs le mois dernier)`;
        narrative+=`.\n\n💾 Temps total économisé depuis le début : **${formatTime(stats.timeSaved||0)}**.\n\n`;
        if(topCh.length)narrative+=`📺 Tes 3 chaînes les plus regardées : **${topCh.join(', ')}**.\n\n`;
        narrative+=`📂 Catégorie dominante : **${topCat}**.\n\n`;
        narrative+=`🚫 Vidéos bloquées au total : **${stats.totalBlockedCount||0}**.`;
        document.getElementById('modalMessage').innerText=narrative;
        document.getElementById('customModal').style.display='flex';
        document.getElementById('modalBtnNo').style.display='none';
        document.getElementById('modalBtnYes').textContent='Fermer';
        document.getElementById('modalBtnYes').onclick=()=>{document.getElementById('customModal').style.display='none';document.getElementById('modalBtnNo').style.display='';document.getElementById('modalBtnYes').textContent='Confirmer';};
    }

    const btnExpCSV = document.getElementById('btnExportCSV'); if (btnExpCSV) btnExpCSV.onclick = exportStatsCSV;
    const btnExpJSON = document.getElementById('btnExportStatsJSON'); if (btnExpJSON) btnExpJSON.onclick = exportStatsJSON;
    const btnExpList = document.getElementById('btnExportJSON'); if (btnExpList) btnExpList.onclick = exportListJSON;
    const btnExpSettings = document.getElementById('btnExportSettings'); if (btnExpSettings) btnExpSettings.onclick = exportSettingsJSON;
    const btnExpSettings2 = document.getElementById('btnExportSettings2'); if (btnExpSettings2) btnExpSettings2.onclick = exportSettingsJSON;
    const btnExpCSVStats = document.getElementById('btnExportStatsCSV'); if (btnExpCSVStats) btnExpCSVStats.onclick = exportStatsCSV;
    const btnExpJSONView = document.getElementById('btnExportStatsJSONView'); if (btnExpJSONView) btnExpJSONView.onclick = exportStatsJSON;
    const btnExpPDF = document.getElementById('btnExportPDF'); if (btnExpPDF) btnExpPDF.onclick = exportPDF;
    const btnExpPDFStats = document.getElementById('btnExportPDFStats'); if (btnExpPDFStats) btnExpPDFStats.onclick = exportPDF;
    const btnMonthRep = document.getElementById('btnMonthlyReport'); if (btnMonthRep) btnMonthRep.onclick = generateMonthlyReport;
    const btnMonthRepBackup = document.getElementById('btnMonthlyReportBackup'); if (btnMonthRepBackup) btnMonthRepBackup.onclick = generateMonthlyReport;

    async function renderChanStats() {
        show('chanStats','forward');
        document.getElementById('searchChannelStats').value='';
        const r=await lg(['watchStats']); const chs=(r.watchStats||{}).channels||{};
        const arr=Object.entries(chs).map(([n,d])=>typeof d==='number'?{name:n,views:d,time:0,logo:''}:{name:n,views:d.views||0,time:d.time||0,logo:d.logo||''}).sort((a,b)=>b.time!==a.time?b.time-a.time:b.views-a.views);
        const fb='https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y';
        const card=(c,rank)=>`<div class="chan-item">${rank?`<div class="chan-rank">#${rank}</div>`:''}<img src="${c.logo||fb}" onerror="this.src='${fb}'" alt="" loading="lazy"><div class="chan-info"><div class="chan-name" title="${c.name}">${c.name}</div><div class="chan-meta">👁️ ${c.views} vue(s) &nbsp;⏱️ ${formatTime(c.time)}</div></div></div>`;
        const top=document.getElementById('top-15-channels'),all=document.getElementById('all-channels-stats');
        if(!arr.length){top.innerHTML='<p class="empty-msg">Aucune chaîne.</p>';all.innerHTML='';return;}
        top.innerHTML=arr.slice(0,15).map((c,i)=>card(c,i+1)).join('');
        all.innerHTML=arr.map(c=>card(c,0)).join('');
        applyLazyLoad(document.querySelectorAll('#top-15-channels img, #all-channels-stats img'));
    }

    function applyLazyLoad(imgs) {
        if (!('IntersectionObserver' in window)) return;
        const obs = new IntersectionObserver((entries,ob) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img=entry.target;
                    if (img.dataset.src) { img.src=img.dataset.src; delete img.dataset.src; }
                    ob.unobserve(img);
                }
            });
        }, {rootMargin:'100px'});
        imgs.forEach(img => {
            if (img.src && !img.src.includes('data:')) { const s=img.src; img.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'; img.dataset.src=s; obs.observe(img); }
        });
    }

    async function renderList(type, page=1) {
        curType=type; show('list','forward');
        document.getElementById('searchList').value='';
        
        let full = [];
        let key = '';
        if (type === 'history') {
            document.getElementById('list-title').innerText = '📜 Historique de Blocage';
            const r = await lg(['blockHistory']);
            full = r.blockHistory || [];
        } else {
            key = type === 'videos' ? 'blockedVideos' : 'blockedChannels';
            const r = await lg([key]);
            full = r[key] || [];
            document.getElementById('list-title').innerText = type==='videos'?'🚫 Vidéos bloquées':'🚫 Chaînes bloquées';
        }
        
        const lc=document.getElementById('list-container'); lc.innerHTML='';
        if(!full.length){
            lc.innerHTML=`<p class="empty-msg">Aucun élément dans ${type==='videos'?'les vidéos bloquées':type==='channels'?'les chaînes bloquées':'l\'historique'}.</p>`;
            return;
        }
        const s=await sg('usePagination');

        /* Fetch watchStats UNE FOIS avant le forEach — await illégal dans forEach callback */
        const channelData = type === 'channels'
            ? ((await lg(['watchStats'])).watchStats?.channels || {})
            : {};

        let display=[...full].reverse();
        if(s.usePagination){
            const total=Math.ceil(display.length/PER_PAGE); page=Math.min(Math.max(1,page),total); curPage=page;
            display=display.slice((page-1)*PER_PAGE,page*PER_PAGE);
            const ctrl=document.createElement('div'); ctrl.className='pagination';
            ctrl.innerHTML=`<button id="pp" ${page===1?'disabled':''}>◀</button><span>${page}/${total}</span><button id="pn" ${page>=total?'disabled':''}>▶</button>`;
            lc.appendChild(ctrl);
            if(page>1)    ctrl.querySelector('#pp').onclick=()=>renderList(type,page-1);
            if(page<total)ctrl.querySelector('#pn').onclick=()=>renderList(type,page+1);
        }
        const imgs=[];
        display.forEach(item=>{
            const el=document.createElement('div'); el.className=type==='videos'?'list-item':type==='channels'?'channel-item':'list-item history-item';
            if (type === 'history') {
                const dateStr = item.timestamp ? new Date(item.timestamp).toLocaleString('fr-FR') : '';
                const typeIcon = item.type === 'video' ? '🎬' : '📺';
                el.innerHTML = `
                    <div class="item-info" style="margin-left: 8px; flex: 1;">
                        <div class="item-title" title="${item.title}" style="font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px;">${typeIcon} ${item.title}</div>
                        <div class="item-meta" style="margin-top: 4px; font-size: 10px; display: flex; align-items: center; gap: 8px;">
                            <span class="history-reason" style="background: rgba(157, 0, 255, 0.1); color: #9d00ff; padding: 1px 5px; border-radius: 4px; font-weight: 600;">${item.reason || 'N/A'}</span>
                            <span style="opacity: 0.6;">${dateStr}</span>
                        </div>
                    </div>
                    <button class="btn-unblock" data-time="${item.timestamp}">✕</button>
                `;
                el.querySelector('.btn-unblock').addEventListener('click', function() {
                    const time = parseInt(this.getAttribute('data-time'), 10);
                    confirm('Retirer cette entrée de l\'historique ?', async () => {
                        const nd = full.filter(v => v.timestamp !== time);
                        await ls({ blockHistory: nd });
                        toast('✅ Entrée retirée de l\'historique', 'success');
                        renderList('history', curPage);
                    });
                });
            } else if(type==='videos'){
                const v=decompressVideo(item);
                const date=v.timestamp?new Date(v.timestamp).toLocaleDateString('fr-FR'):'';
                el.innerHTML=`<img src="https://i.ytimg.com/vi/${v.id}/mqdefault.jpg" loading="lazy" alt=""><div class="item-info"><div class="item-title" title="${v.title}">${v.title}</div><div class="item-meta">⏱️ ${v.duration}${date?' · '+date:''}</div></div><button class="btn-unblock" data-id="${v.id}">✕</button>`;
                imgs.push(el.querySelector('img'));
                el.querySelector('.btn-unblock').addEventListener('click',function(){
                    const id=this.getAttribute('data-id');
                    confirm('Débloquer ce contenu ?',async ()=>{
                        const nd=full.filter(v=>decompressVideo(v).id!==id);
                        await ls({blockedVideos:nd}); refreshBadges(); toast('✅ Vidéo débloquée','success'); renderList(type,curPage);
                    });
                });
            } else {
                /* Logo depuis channelData (fetchée avant le forEach) */
                const chData = channelData[item];
                const logoHtml = chData?.logo
                    ? `<img src="${chData.logo}" class="chan-list-logo" alt="" loading="lazy">`
                    : `<div class="chan-list-logo-placeholder">${(item[0]||'?').toUpperCase()}</div>`;
                el.innerHTML=`${logoHtml}<div class="ch-name" title="${item}">${item}</div><button class="btn-unblock" data-name="${item}">✕</button>`;
                el.querySelector('.btn-unblock').addEventListener('click',function(){
                    const name=this.getAttribute('data-name');
                    confirm('Débloquer ce contenu ?',async ()=>{
                        const nd=full.filter(v=>v!==name);
                        await ls({blockedChannels:nd}); refreshBadges(); toast('✅ Chaîne débloquée','success'); renderList(type,curPage);
                    });
                });
            }
            const ctrl=lc.querySelector('.pagination'); ctrl?lc.insertBefore(el,ctrl):lc.appendChild(el);
        });
        if(imgs.length) applyLazyLoad(imgs);
    }

    // Advanced Stats Tab Switcher & Renderer (21-30)
    const tabBasic = document.getElementById('tabStatsBasic');
    const tabAdvanced = document.getElementById('tabStatsAdvanced');
    const containerBasic = document.getElementById('stats-container-basic');
    const containerAdvanced = document.getElementById('stats-container-advanced');

    if (tabBasic && tabAdvanced) {
        tabBasic.addEventListener('click', () => {
            tabBasic.classList.add('active');
            tabBasic.style.borderBottom = '2px solid #9d00ff';
            tabBasic.style.color = 'var(--text-main)';
            
            tabAdvanced.classList.remove('active');
            tabAdvanced.style.borderBottom = 'none';
            tabAdvanced.style.color = 'var(--text-muted)';
            
            containerBasic.style.display = 'block';
            containerAdvanced.style.display = 'none';
        });

        tabAdvanced.addEventListener('click', () => {
            tabAdvanced.classList.add('active');
            tabAdvanced.style.borderBottom = '2px solid #9d00ff';
            tabAdvanced.style.color = 'var(--text-main)';
            
            tabBasic.classList.remove('active');
            tabBasic.style.borderBottom = 'none';
            tabBasic.style.color = 'var(--text-muted)';
            
            containerBasic.style.display = 'none';
            containerAdvanced.style.display = 'block';
            renderAdvancedStats();
        });
    }

    async function renderAdvancedStats() {
        const res = await lg(['watchStats']);
        const stats = res.watchStats || {};
        const ws = stats;
        
        // 22. Carbon Footprint
        const totalW = ws.totalTimeWatched || 0;
        const mins = Math.floor(totalW / 60);
        const co2 = Math.round(mins * 3.2);
        const carbonEl = document.getElementById('statCarbonFootprint');
        if (carbonEl) carbonEl.textContent = `${co2} g CO2`;

        // 24. Hourly Rate and Attention Cost
        const hourlyRateSetting = await sg(['hourlyRate']);
        const rate = parseFloat(hourlyRateSetting.hourlyRate || 15);
        const inputRate = document.getElementById('inputHourlyRate');
        if (inputRate) {
            inputRate.value = rate;
            if (!inputRate.dataset.listenerWired) {
                inputRate.dataset.listenerWired = '1';
                inputRate.addEventListener('change', async e => {
                    let newRate = parseFloat(e.target.value);
                    if (isNaN(newRate) || newRate < 0) newRate = 15;
                    await ss({ hourlyRate: newRate });
                    const costVal = ((totalW / 3600) * newRate).toFixed(2);
                    const costEl = document.getElementById('statAttentionCost');
                    if (costEl) costEl.textContent = `${costVal} €`;
                });
            }
        }
        const costVal = ((totalW / 3600) * rate).toFixed(2);
        const costEl = document.getElementById('statAttentionCost');
        if (costEl) costEl.textContent = `${costVal} €`;

        // 25. Rebound Rate (Suggested clicks / Total search + suggested)
        const clicksSearch = parseInt(ws.clicksSearch) || 0;
        const clicksSugg = parseInt(ws.clicksSugg) || 0;
        const totalClicks = clicksSearch + clicksSugg;
        const reboundRate = totalClicks > 0 ? Math.round((clicksSugg / totalClicks) * 100) : 0;
        const reboundRateEl = document.getElementById('statReboundRate');
        if (reboundRateEl) reboundRateEl.textContent = `${reboundRate} %`;
        const reboundDetailEl = document.getElementById('statReboundDetail');
        if (reboundDetailEl) reboundDetailEl.textContent = `${clicksSearch} recherche${clicksSearch > 1 ? 's' : ''} / ${clicksSugg} sugg.`;

        // 26. Average Retention
        const retentionTotalPct = parseInt(ws.retentionTotalPct) || 0;
        const retentionCount = parseInt(ws.retentionCount) || 0;
        const avgRetention = retentionCount > 0 ? Math.round(retentionTotalPct / retentionCount) : 0;
        const avgRetentionEl = document.getElementById('statAvgRetention');
        if (avgRetentionEl) avgRetentionEl.textContent = `${avgRetention} %`;
        const retentionDetailEl = document.getElementById('statRetentionDetail');
        if (retentionDetailEl) retentionDetailEl.textContent = `${retentionCount} vidéo${retentionCount > 1 ? 's' : ''} suivie${retentionCount > 1 ? 's' : ''}`;

        // 30. Interruptions
        const interruptions = parseInt(ws.interruptionsCount) || 0;
        const interruptionsEl = document.getElementById('statInterruptions');
        if (interruptionsEl) interruptionsEl.textContent = interruptions;

        // 29. Category Diversity Index (Simpson's Diversity Index)
        const categories = ws.categories || {};
        const catArray = Object.values(categories).map(c => c.time || 0).filter(t => t > 0);
        const totalCatTime = catArray.reduce((a, b) => a + b, 0);
        let diversity = 0;
        if (totalCatTime > 0 && catArray.length > 1) {
            let simpsonSum = 0;
            catArray.forEach(t => {
                const p = t / totalCatTime;
                simpsonSum += p * p;
            });
            diversity = Math.round((1 - simpsonSum) * 100);
        }
        const diversityIndexEl = document.getElementById('statDiversityIndex');
        if (diversityIndexEl) diversityIndexEl.textContent = `${diversity} %`;
        const divLvl = document.getElementById('statDiversityLevel');
        if (divLvl) {
            if (diversity >= 70) divLvl.textContent = '🟢 Diversifié (Sain)';
            else if (diversity >= 40) divLvl.textContent = '🟡 Modéré';
            else divLvl.textContent = '🔴 Bulle algorithmique';
        }

        // 23. Productivity Correlation
        let prodTime = 0, unprodTime = 0;
        Object.entries(ws.dailyProductive || {}).forEach(([, s]) => prodTime += s);
        Object.entries(ws.dailyUnproductive || {}).forEach(([, s]) => unprodTime += s);
        const totalProdTime = prodTime + unprodTime;
        const prodRatio = totalProdTime > 0 ? Math.round((prodTime / totalProdTime) * 100) : 0;
        const prodRatioEl = document.getElementById('statProductivityRatio');
        if (prodRatioEl) prodRatioEl.textContent = `${prodRatio}% Productif`;
        const prodBarEl = document.getElementById('statProductiveBar');
        if (prodBarEl) prodBarEl.style.width = `${prodRatio}%`;

        // 28. Playback Speeds repartition
        const speedStats = ws.speedStats || { "1": 0, "1.25": 0, "1.5": 0, "2": 0 };
        const totalSpeedTime = Object.values(speedStats).reduce((a, b) => a + b, 0) || 1;
        const speedBarsEl = document.getElementById('speedRepartitionBars');
        if (speedBarsEl) {
            speedBarsEl.innerHTML = '';
            Object.entries(speedStats).sort((a,b) => parseFloat(a[0]) - parseFloat(b[0])).forEach(([speed, time]) => {
                const pct = Math.round((time / totalSpeedTime) * 100);
                const row = document.createElement('div');
                row.className = 'cat-row';
                row.innerHTML = `
                    <span class="cat-name" style="width: 45px; font-size: 10px;">⚡ ${speed}x</span>
                    <div class="cat-bar-wrap" style="height: 6px;">
                        <div class="cat-bar" style="background: linear-gradient(135deg, #10b981 0%, #14b8a6 100%); width: ${pct}%; height: 100%; border-radius: 3px;"></div>
                    </div>
                    <span class="cat-time" style="width: 70px; text-align: right; font-size: 10px;">${pct}% (${formatTime(time)})</span>
                `;
                speedBarsEl.appendChild(row);
            });
        }

        // 21. Heatmap rendering (7x24 grid)
        const heatmap = ws.heatmap || {};
        const maxVal = Math.max(...Object.values(heatmap), 1);
        const heatmapGrid = document.getElementById('heatmapGrid');
        if (heatmapGrid) {
            heatmapGrid.innerHTML = '';
            const dayLabels = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
            const orderedDays = [1, 2, 3, 4, 5, 6, 0];
            orderedDays.forEach(day => {
                const row = document.createElement('div');
                row.style.display = 'grid';
                row.style.gridTemplateColumns = 'repeat(25, 1fr)';
                row.style.gap = '2px';
                row.style.alignItems = 'center';
                
                const lbl = document.createElement('span');
                lbl.style.fontSize = '8px';
                lbl.style.fontWeight = '700';
                lbl.style.opacity = '0.7';
                lbl.style.textAlign = 'center';
                lbl.textContent = dayLabels[day];
                row.appendChild(lbl);
                
                for (let hour = 0; hour < 24; hour++) {
                    const block = document.createElement('div');
                    const val = heatmap[`${day}_${hour}`] || 0;
                    const alpha = val > 0 ? Math.min(1.0, 0.15 + (val / maxVal) * 0.85) : 0.05;
                    block.style.background = val > 0 ? `rgba(157, 0, 255, ${alpha})` : 'rgba(255, 255, 255, 0.04)';
                    block.style.aspectRatio = '1/1';
                    block.style.borderRadius = '2px';
                    block.title = `${dayLabels[day]} à ${hour}h : ${formatTime(val)}`;
                    row.appendChild(block);
                }
                heatmapGrid.appendChild(row);
            });
        }

        // Top 10 Creators Rendering (27)
        const topTenEl = document.getElementById('topTenChannels');
        if (topTenEl) {
            topTenEl.innerHTML = '';
            const channels = ws.channels || {};
            const arr = Object.entries(channels)
                .map(([name, data]) => typeof data === 'number' ? { name, time: 0 } : { name, time: data.time || 0 })
                .filter(c => c.time > 0)
                .sort((a, b) => b.time - a.time)
                .slice(0, 10);
            
            if (arr.length > 0) {
                const maxTime = arr[0].time;
                topTenEl.innerHTML = `<div class="section-title" style="margin-bottom:8px">📺 Top 10 Créateurs les plus chronophages</div>` +
                    arr.map((c, i) => `
                        <div class="cat-row">
                            <span class="cat-name" style="font-size: 10px;">${i+1}. ${c.name}</span>
                            <div class="cat-bar-wrap" style="height: 6px;">
                                <div class="cat-bar" style="background: linear-gradient(135deg, #ef4444 0%, #f59e0b 100%); width: ${maxTime > 0 ? Math.round((c.time / maxTime) * 100) : 0}%"></div>
                            </div>
                            <span class="cat-time" style="font-size: 10px;">${formatTime(c.time)}</span>
                        </div>
                    `).join('');
            } else {
                topTenEl.innerHTML = `<div class="section-title" style="margin-bottom:8px">📺 Top 10 Créateurs</div><p class="empty-msg" style="font-size:10px">Aucun historique de visionnage disponible.</p>`;
            }
        }

        // Badges (41)
        const badgesContainer = document.getElementById('badgesContainer');
        if (badgesContainer) {
            badgesContainer.innerHTML = '';
            const totalSaved = stats.timeSaved || 0;
            const badges = [];
            if (totalSaved >= 3600) badges.push({icon:'🥉', name:'Novice (1h+)'});
            if (totalSaved >= 3600*10) badges.push({icon:'🥈', name:'Adepte (10h+)'});
            if (totalSaved >= 3600*24) badges.push({icon:'🥇', name:'Expert (24h+)'});
            if (totalSaved >= 3600*24*7) badges.push({icon:'💎', name:'Maître du Temps (1 sem+)'});
            if (stats.totalBlockedCount >= 100) badges.push({icon:'🛡️', name:'Bouclier (100+)'});
            if (stats.totalBlockedCount >= 1000) badges.push({icon:'⚔️', name:'Guerrier (1000+)'});
            
            if (badges.length > 0) {
                badgesContainer.innerHTML = badges.map(b => `<div style="background: rgba(255,255,255,0.1); padding: 4px 8px; border-radius: 12px; font-size: 11px; display: flex; align-items: center; gap: 4px;"><span>${b.icon}</span> ${b.name}</div>`).join('');
            } else {
                badgesContainer.innerHTML = '<span style="font-size: 11px; opacity: 0.6; width: 100%; text-align: center;">Aucun badge pour le moment. Continue à bloquer des vidéos !</span>';
            }
        }

        // Keywords (49)
        const topKeywordsContainer = document.getElementById('topKeywordsContainer');
        if (topKeywordsContainer) {
            const kws = stats.keywords || {};
            const kwArr = Object.entries(kws).sort((a,b)=>b[1]-a[1]).slice(0, 8);
            if (kwArr.length > 0) {
                topKeywordsContainer.innerHTML = kwArr.map(([kw, count]) => `<div style="background: rgba(16, 185, 129, 0.2); border: 1px solid rgba(16, 185, 129, 0.4); padding: 3px 6px; border-radius: 4px; font-size: 10px;">${kw} <span style="opacity:0.7">(${count})</span></div>`).join('');
            } else {
                topKeywordsContainer.innerHTML = '<span style="font-size: 11px; opacity: 0.6; width: 100%; text-align: center;">Pas encore de mots-clés détectés.</span>';
            }
        }
    }

    /* ══ CLOUD & COMMUNITY INTEGRATION LOGIC ════════════════════════════════ */
    const API_BASE_URL = 'https://extension.blocker.youtube.crossplaymc.fr';

    async function sha256(message) {
        const msgBuffer = new TextEncoder().encode(message);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    const safeStorageGetLocal = () => new Promise(r => {
        try {
            chrome.storage.local.get(null, res => r(chrome.runtime.lastError ? {} : res));
        } catch(e) { r({}); }
    });

    const safeStorageGetSync = () => new Promise(r => {
        try {
            chrome.storage.sync.get(null, res => r(chrome.runtime.lastError ? {} : res));
        } catch(e) { r({}); }
    });

    async function vpsRegister(email, name, password) {
        const passwordHash = await sha256(password);
        try {
            const res = await fetch(`${API_BASE_URL}/api/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, name, passwordHash })
            });
            return await res.json();
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    async function vpsLogin(email, password) {
        const passwordHash = await sha256(password);
        try {
            const res = await fetch(`${API_BASE_URL}/api/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, passwordHash })
            });
            return await res.json();
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    async function vpsBackup(email, passwordHash) {
        try {
            const localData = await safeStorageGetLocal();
            const listsPayload = {};
            const statsPayload = {};
            for (const [k, v] of Object.entries(localData)) {
                if (k.includes('watchStats')) {
                    statsPayload[k] = v;
                } else if (!k.includes('rollingBackups')) {
                    listsPayload[k] = v;
                }
            }
            const syncData = await safeStorageGetSync();
            const cryptKey = syncData.cloudUserCryptKey;

            const sessionKeys = ['cloudUserEmail', 'cloudUserName', 'cloudUserPasswordHash', 'cloudUserCryptKey'];
            const paramsPayload = {};
            for (const [k, v] of Object.entries(syncData)) {
                if (!sessionKeys.includes(k)) {
                    paramsPayload[k] = v;
                }
            }

            let finalLists, finalStats, finalParams;
            if (cryptKey) {
                finalLists = { payload: await encryptPayload(JSON.stringify(listsPayload), cryptKey), encrypted: true };
                finalStats = { payload: await encryptPayload(JSON.stringify(statsPayload), cryptKey), encrypted: true };
                finalParams = { payload: await encryptPayload(JSON.stringify(paramsPayload), cryptKey), encrypted: true };
            } else {
                finalLists = { payload: listsPayload };
                finalStats = { payload: statsPayload };
                finalParams = { payload: paramsPayload };
            }

            const payload = {
                email,
                passwordHash,
                lists: finalLists,
                stats: finalStats,
                params: finalParams
            };

            const res = await fetch(`${API_BASE_URL}/api/backup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            return await res.json();
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    async function vpsRestore(email, passwordHash) {
        try {
            const res = await fetch(`${API_BASE_URL}/api/backup?email=${encodeURIComponent(email)}&passwordHash=${encodeURIComponent(passwordHash)}`);
            const data = await res.json();
            if (data.success) {
                const syncData = await safeStorageGetSync();
                const cryptKey = syncData.cloudUserCryptKey;

                let restoredLists = {};
                let restoredStats = {};
                let restoredParams = {};

                if (data.lists && data.lists.payload) {
                    if (data.lists.encrypted && cryptKey) {
                        try {
                            const decrypted = await decryptPayload(data.lists.payload, cryptKey);
                            restoredLists = JSON.parse(decrypted);
                        } catch(e) {
                            console.error("Failed to decrypt lists backup:", e);
                            return { success: false, error: "Erreur de déchiffrement des listes." };
                        }
                    } else {
                        restoredLists = data.lists.payload;
                    }
                }

                if (data.stats && data.stats.payload) {
                    if (data.stats.encrypted && cryptKey) {
                        try {
                            const decrypted = await decryptPayload(data.stats.payload, cryptKey);
                            restoredStats = JSON.parse(decrypted);
                        } catch(e) {
                            console.error("Failed to decrypt stats backup:", e);
                            return { success: false, error: "Erreur de déchiffrement des statistiques." };
                        }
                    } else {
                        restoredStats = data.stats.payload;
                    }
                }

                if (data.params && data.params.payload) {
                    if (data.params.encrypted && cryptKey) {
                        try {
                            const decrypted = await decryptPayload(data.params.payload, cryptKey);
                            restoredParams = JSON.parse(decrypted);
                        } catch(e) {
                            console.error("Failed to decrypt params backup:", e);
                            return { success: false, error: "Erreur de déchiffrement des réglages." };
                        }
                    } else {
                        restoredParams = data.params.payload;
                    }
                }

                const localCombined = {};
                Object.assign(localCombined, restoredLists);
                Object.assign(localCombined, restoredStats);
                
                await new Promise(r => chrome.storage.local.clear(() => {
                    if (chrome.runtime.lastError) {
                        console.warn("Storage local clear failed:", chrome.runtime.lastError.message);
                    }
                    r();
                }));
                await new Promise(r => chrome.storage.local.set(localCombined, () => {
                    if (chrome.runtime.lastError) {
                        console.warn("Storage local set failed during restore:", chrome.runtime.lastError.message);
                    }
                    r();
                }));

                const sessionKeys = ['cloudUserEmail', 'cloudUserName', 'cloudUserPasswordHash', 'cloudUserCryptKey'];
                const currentSession = {};
                for (const key of sessionKeys) {
                    const val = await new Promise(res => chrome.storage.sync.get(key, r => {
                        if (chrome.runtime.lastError) { res(null); return; }
                        res(r[key]);
                    }));
                    if (val) currentSession[key] = val;
                }

                await new Promise(r => chrome.storage.sync.clear(() => {
                    if (chrome.runtime.lastError) {
                        console.warn("Storage sync clear failed:", chrome.runtime.lastError.message);
                    }
                    r();
                }));

                const finalParamsCombined = Object.assign({}, restoredParams, currentSession);
                await new Promise(r => chrome.storage.sync.set(finalParamsCombined, () => {
                    if (chrome.runtime.lastError) {
                        console.warn("Storage sync set failed during restore:", chrome.runtime.lastError.message);
                    }
                    r();
                }));

                return { success: true };
            } else {
                return { success: false, error: data.error || 'Erreur inconnue' };
            }
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    async function vpsDeleteAccount(email, passwordHash) {
        try {
            const res = await fetch(`${API_BASE_URL}/api/backup?email=${encodeURIComponent(email)}&passwordHash=${encodeURIComponent(passwordHash)}`, {
                method: 'DELETE'
            });
            return await res.json();
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    async function vpsPublishList(email, passwordHash, name, description) {
        try {
            const prefix = getProfilePrefix();
            const localData = await lg(['blockedVideos', 'blockedChannels', 'watchStats']);
            const blockedVideos = localData.blockedVideos || [];
            const blockedChannels = localData.blockedChannels || [];
            const stats = localData.watchStats || {};
            const hoursSaved = parseFloat(((stats.timeSaved || 0) / 3600).toFixed(1));

            const payload = {
                email,
                passwordHash,
                name,
                description,
                blockedVideos,
                blockedChannels,
                hoursSaved
            };

            const res = await fetch(`${API_BASE_URL}/api/community/publish`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            return await res.json();
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    async function vpsGetCommunityLists() {
        try {
            const res = await fetch(`${API_BASE_URL}/api/community/lists`);
            return await res.json();
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    async function vpsVoteList(email, passwordHash, targetEmail, voteType) {
        try {
            const res = await fetch(`${API_BASE_URL}/api/community/vote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, passwordHash, targetEmail, voteType })
            });
            return await res.json();
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    async function vpsPublishStats(email, passwordHash, name, description) {
        try {
            const prefix = getProfilePrefix();
            const localData = await lg(['watchStats']);
            const watchStats = localData.watchStats || {};

            const payload = {
                email,
                passwordHash,
                name,
                description,
                statsPayload: watchStats
            };

            const res = await fetch(`${API_BASE_URL}/api/community/publish-stats`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            return await res.json();
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    async function vpsGetCommunityStats() {
        try {
            const res = await fetch(`${API_BASE_URL}/api/community/stats`);
            return await res.json();
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    async function vpsVoteStats(email, passwordHash, targetEmail, voteType) {
        try {
            const res = await fetch(`${API_BASE_URL}/api/community/vote-stats`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, passwordHash, targetEmail, voteType })
            });
            return await res.json();
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    async function vpsPublishParams(email, passwordHash, name, description) {
        try {
            const syncData = await safeStorageGetSync();
            const paramsPayload = {};
            const sessionKeys = ['cloudUserEmail', 'cloudUserName', 'cloudUserPasswordHash'];
            for (const [k, v] of Object.entries(syncData)) {
                if (!sessionKeys.includes(k)) {
                    paramsPayload[k] = v;
                }
            }
            const payload = {
                email,
                passwordHash,
                name,
                description,
                paramsPayload
            };
            const res = await fetch(`${API_BASE_URL}/api/community/publish-params`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            return await res.json();
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    async function vpsGetCommunityParams() {
        try {
            const res = await fetch(`${API_BASE_URL}/api/community/params`);
            return await res.json();
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    async function vpsVoteParams(email, passwordHash, targetEmail, voteType) {
        try {
            const res = await fetch(`${API_BASE_URL}/api/community/vote-params`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, passwordHash, targetEmail, voteType })
            });
            return await res.json();
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    function updatePublishBoxesVisibility() {
        const isListsTab = document.getElementById('subTabCommLists').classList.contains('active');
        const isStatsTab = document.getElementById('subTabCommStats').classList.contains('active');
        const isParamsTab = document.getElementById('subTabCommParams').classList.contains('active');
        const publishListBox = document.getElementById('comm-publish-list-box');
        const publishStatsBox = document.getElementById('comm-publish-stats-box');
        const publishParamsBox = document.getElementById('comm-publish-params-box');
        
        if (publishListBox) {
            publishListBox.style.display = isListsTab ? 'block' : 'none';
        }
        if (publishStatsBox) {
            publishStatsBox.style.display = isStatsTab ? 'block' : 'none';
        }
        if (publishParamsBox) {
            publishParamsBox.style.display = isParamsTab ? 'block' : 'none';
        }
    }

    function applyVoteBounce(btn) {
        btn.style.transform = 'scale(0.85)';
        btn.style.transition = 'transform 0.15s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
        setTimeout(() => {
            btn.style.transform = '';
        }, 150);
    }

    async function initCloudView() {
        const user = await sg(['cloudUserEmail', 'cloudUserName', 'cloudUserPasswordHash']);
        
        const form = document.getElementById('cloud-auth-form');
        const dashboard = document.getElementById('cloud-logged-in');
        const publishCard = document.getElementById('collapsible-publish-card');

        if (user && user.cloudUserEmail && user.cloudUserPasswordHash) {
            form.style.display = 'none';
            dashboard.style.display = 'block';
            if (publishCard) {
                publishCard.style.display = 'block';
                updatePublishBoxesVisibility();
            }

            document.getElementById('lbl-cloud-username').textContent = user.cloudUserName || user.cloudUserEmail.split('@')[0];
            document.getElementById('lbl-cloud-email').textContent = user.cloudUserEmail;
        } else {
            form.style.display = 'block';
            dashboard.style.display = 'none';
            if (publishCard) {
                publishCard.style.display = 'none';
                const publishCardBody = document.getElementById('publish-card-body');
                const publishCardArrow = document.getElementById('publish-card-arrow');
                if (publishCardBody) {
                    publishCardBody.style.maxHeight = '0px';
                    publishCardBody.style.opacity = '0';
                    publishCardBody.style.padding = '0 14px';
                }
                if (publishCardArrow) {
                    publishCardArrow.style.transform = 'rotate(0deg)';
                }
            }
        }

        if (document.getElementById('tabCloudAccount').classList.contains('active')) {
            document.getElementById('panel-cloud-account').style.display = 'block';
            document.getElementById('panel-cloud-community').style.display = 'none';
        } else {
            document.getElementById('panel-cloud-account').style.display = 'none';
            document.getElementById('panel-cloud-community').style.display = 'block';
            loadCommunityData();
        }
    }

    async function loadCommunityData() {
        const user = await sg(['cloudUserEmail', 'cloudUserPasswordHash']);
        const currentUserEmail = (user.cloudUserEmail || '').toLowerCase().trim();

        if (document.getElementById('subTabCommLists').classList.contains('active')) {
            document.getElementById('comm-lists-section').style.display = 'block';
            document.getElementById('comm-stats-section').style.display = 'none';
            document.getElementById('comm-params-section').style.display = 'none';

            const container = document.getElementById('community-lists-container');
            container.innerHTML = '<p class="section-desc" style="text-align: center; margin-top: 20px;">Chargement des listes...</p>';

            const data = await vpsGetCommunityLists();
            if (data && data.success && data.lists) {
                if (data.lists.length === 0) {
                    container.innerHTML = '<p class="section-desc" style="text-align: center; margin-top: 20px;">Aucune liste publiée pour le moment.</p>';
                    return;
                }
                
                data.lists.sort((a, b) => (b.likes || []).length - (a.likes || []).length);

                container.innerHTML = data.lists.map(list => {
                    const likesCount = (list.likes || []).length;
                    const dislikesCount = (list.dislikes || []).length;
                    const hasLiked = (list.likes || []).includes(currentUserEmail);
                    const hasDisliked = (list.dislikes || []).includes(currentUserEmail);
                    const initial = (list.creatorName || '?').charAt(0).toUpperCase();

                    return `
                        <div class="community-card">
                            <div class="community-card-header">
                                <div class="community-user-info">
                                    <div class="community-avatar">${initial}</div>
                                    <span class="community-card-creator">${list.creatorName}</span>
                                </div>
                                <span class="community-card-date">${new Date(list.updated_at).toLocaleDateString('fr-FR')}</span>
                            </div>
                            <div class="community-card-desc">${list.description || 'Aucune description'}</div>
                            <div class="community-card-stats">
                                <div class="metric-pill">🚫 <span>${list.blockedVideos ? list.blockedVideos.length : 0} vids</span></div>
                                <div class="metric-pill">📺 <span>${list.blockedChannels ? list.blockedChannels.length : 0} chans</span></div>
                                <div class="metric-pill pill-highlight">⏳ <span>${list.hoursSaved || 0}h sauvées</span></div>
                            </div>
                            <div class="community-card-actions">
                                <div class="vote-buttons">
                                    <button class="btn-vote btn-vote-like ${hasLiked ? 'voted-like' : ''}" data-email="${list.email}">👍 <span>${likesCount}</span></button>
                                    <button class="btn-vote btn-vote-dislike ${hasDisliked ? 'voted-dislike' : ''}" data-email="${list.email}">👎 <span>${dislikesCount}</span></button>
                                </div>
                                <button class="btn-import-list" data-email="${list.email}">📥 Importer</button>
                            </div>
                        </div>
                    `;
                }).join('');

                container.querySelectorAll('.btn-vote-like').forEach(btn => {
                    btn.onclick = async () => {
                        if (!user.cloudUserEmail) { toast('⚠️ Connectez-vous pour voter', 'error'); return; }
                        applyVoteBounce(btn);
                        const res = await vpsVoteList(user.cloudUserEmail, user.cloudUserPasswordHash, btn.dataset.email, 'like');
                        if (res && res.success) {
                            loadCommunityData();
                        } else {
                            toast(`❌ Vote échoué: ${res.error || 'erreur'}`, 'error');
                        }
                    };
                });
                container.querySelectorAll('.btn-vote-dislike').forEach(btn => {
                    btn.onclick = async () => {
                        if (!user.cloudUserEmail) { toast('⚠️ Connectez-vous pour voter', 'error'); return; }
                        applyVoteBounce(btn);
                        const res = await vpsVoteList(user.cloudUserEmail, user.cloudUserPasswordHash, btn.dataset.email, 'dislike');
                        if (res && res.success) {
                            loadCommunityData();
                        } else {
                            toast(`❌ Vote échoué: ${res.error || 'erreur'}`, 'error');
                        }
                    };
                });
                container.querySelectorAll('.btn-import-list').forEach(btn => {
                    btn.onclick = () => {
                        const targetList = data.lists.find(l => l.email === btn.dataset.email);
                        if (targetList) {
                            confirm(`Importer la liste de ${targetList.creatorName} (${(targetList.blockedVideos || []).length} vidéos, ${(targetList.blockedChannels || []).length} chaînes) ?`, async () => {
                                const prefix = getProfilePrefix();
                                const currentLocal = await lg(['blockedVideos', 'blockedChannels', 'blockHistory']);
                                const currentVids = currentLocal.blockedVideos || [];
                                const currentChans = currentLocal.blockedChannels || [];
                                const currentHistory = currentLocal.blockHistory || [];

                                let addedVids = 0;
                                (targetList.blockedVideos || []).forEach(vStr => {
                                    const decomp = decompressVideo(vStr);
                                    if (!currentVids.some(cv => decompressVideo(cv).id === decomp.id)) {
                                        currentVids.push(vStr);
                                        addedVids++;
                                    }
                                });

                                let addedChans = 0;
                                (targetList.blockedChannels || []).forEach(cName => {
                                    if (!currentChans.includes(cName)) {
                                        currentChans.push(cName);
                                        addedChans++;
                                    }
                                });

                                if (addedVids > 0 || addedChans > 0) {
                                    currentHistory.push({
                                        timestamp: Date.now(),
                                        title: `Importation communauté (${targetList.creatorName})`,
                                        type: 'import',
                                        value: `${addedVids} vids, ${addedChans} chans`,
                                        reason: `Hub Communautaire`
                                    });
                                    if (currentHistory.length > 150) currentHistory.shift();

                                    await ls({
                                        blockedVideos: currentVids,
                                        blockedChannels: currentChans,
                                        blockHistory: currentHistory
                                    });
                                    toast(`✅ Importation réussie ! (+${addedVids} vidéos, +${addedChans} chaînes)`, 'success');
                                    refreshBadges();
                                } else {
                                    toast('ℹ️ Tous les éléments sont déjà présents dans votre liste', 'info');
                                }
                            });
                        }
                    };
                });
            } else {
                container.innerHTML = `<p class="section-desc" style="text-align: center; margin-top: 20px; color: var(--red);">❌ Erreur de chargement: ${data.error || 'serveur injoignable'}</p>`;
            }
        } else if (document.getElementById('subTabCommStats').classList.contains('active')) {
            document.getElementById('comm-lists-section').style.display = 'none';
            document.getElementById('comm-stats-section').style.display = 'block';
            document.getElementById('comm-params-section').style.display = 'none';

            const container = document.getElementById('community-stats-container');
            container.innerHTML = '<p class="section-desc" style="text-align: center; margin-top: 20px;">Chargement des statistiques...</p>';

            const data = await vpsGetCommunityStats();
            if (data && data.success && data.stats) {
                if (data.stats.length === 0) {
                    container.innerHTML = '<p class="section-desc" style="text-align: center; margin-top: 20px;">Aucune statistique partagée pour le moment.</p>';
                    return;
                }

                data.stats.sort((a, b) => (b.likes || []).length - (a.likes || []).length);

                container.innerHTML = data.stats.map(stat => {
                    const likesCount = (stat.likes || []).length;
                    const dislikesCount = (stat.dislikes || []).length;
                    const hasLiked = (stat.likes || []).includes(currentUserEmail);
                    const hasDisliked = (stat.dislikes || []).includes(currentUserEmail);
                    const initial = (stat.creatorName || '?').charAt(0).toUpperCase();

                    const payload = stat.statsPayload || {};
                    const hoursWatched = formatTime(payload.totalTimeWatched || 0);
                    const hoursSaved = formatTime(payload.timeSaved || 0);
                    const vidsWatched = payload.totalVideos || 0;
                    const vidsAvoided = payload.totalBlockedCount || 0;

                    const totalW = payload.totalTimeWatched || 0;
                    const totalS = payload.timeSaved || 0;
                    const disciplineScore = totalW + totalS > 0 ? Math.round((totalS / (totalW + totalS)) * 100) : 0;
                    const scoreColor = disciplineScore >= 70 ? '#10b981' : disciplineScore >= 40 ? '#f59e0b' : '#ef4444';

                    return `
                        <div class="community-card">
                            <div class="community-card-header">
                                <div class="community-user-info">
                                    <div class="community-avatar">${initial}</div>
                                    <span class="community-card-creator">${stat.creatorName}</span>
                                </div>
                                <span class="community-card-date">${new Date(stat.updated_at).toLocaleDateString('fr-FR')}</span>
                            </div>
                            <div class="community-card-desc">${stat.description || 'Aucune description'}</div>
                            
                            <div class="community-stats-grid" style="grid-template-columns: repeat(2, 1fr); display: grid; gap: 8px; width: 100%;">
                                <div class="metric-pill" style="flex-direction: column; align-items: flex-start; padding: 6px 8px; height: auto; border-radius: 8px; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.04); display: flex; gap: 1px;">
                                    <span style="font-size: 8px; opacity: 0.6; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Temps regardé</span>
                                    <div style="font-size: 12px; font-weight: 800; color: var(--txt-main); margin-top: 1px; display: flex; align-items: center; gap: 4px;">📺 ${hoursWatched}</div>
                                </div>
                                <div class="metric-pill pill-highlight" style="flex-direction: column; align-items: flex-start; padding: 6px 8px; height: auto; border-radius: 8px; background: rgba(245, 158, 11, 0.05); border: 1px solid rgba(245, 158, 11, 0.15); display: flex; gap: 1px;">
                                    <span style="font-size: 8px; opacity: 0.7; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #f59e0b;">Temps sauvé</span>
                                    <div style="font-size: 12px; font-weight: 800; color: #f59e0b; margin-top: 1px; display: flex; align-items: center; gap: 4px;">🏆 ${hoursSaved}</div>
                                </div>
                                <div class="metric-pill" style="flex-direction: column; align-items: flex-start; padding: 6px 8px; height: auto; border-radius: 8px; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.04); display: flex; gap: 1px;">
                                    <span style="font-size: 8px; opacity: 0.6; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Vidéos vues</span>
                                    <div style="font-size: 12px; font-weight: 800; color: var(--txt-main); margin-top: 1px; display: flex; align-items: center; gap: 4px;">👀 ${vidsWatched}</div>
                                </div>
                                <div class="metric-pill" style="flex-direction: column; align-items: flex-start; padding: 6px 8px; height: auto; border-radius: 8px; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.04); display: flex; gap: 1px;">
                                    <span style="font-size: 8px; opacity: 0.6; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Vidéos évitées</span>
                                    <div style="font-size: 12px; font-weight: 800; color: var(--txt-main); margin-top: 1px; display: flex; align-items: center; gap: 4px;">🛡️ ${vidsAvoided}</div>
                                </div>
                            </div>
                            
                            <div style="margin-top: 4px; padding: 6px 8px; background: rgba(255, 255, 255, 0.01); border: 1px solid rgba(255, 255, 255, 0.03); border-radius: 8px; display: flex; flex-direction: column; gap: 4px;">
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <span style="font-size: 8px; opacity: 0.6; font-weight: 600; letter-spacing: 0.5px;">SCORE DE DISCIPLINE</span>
                                    <span style="font-size: 9px; font-weight: 800; color: ${scoreColor}">${disciplineScore}%</span>
                                </div>
                                <div style="height: 5px; width: 100%; background: rgba(255,255,255,0.05); border-radius: 3px; overflow: hidden;">
                                    <div style="height: 100%; width: ${disciplineScore}%; background: ${scoreColor}; border-radius: 3px;"></div>
                                </div>
                            </div>

                            <div class="community-card-actions">
                                <div class="vote-buttons">
                                    <button class="btn-vote btn-vote-like-stats ${hasLiked ? 'voted-like' : ''}" data-email="${stat.email}">👍 <span>${likesCount}</span></button>
                                    <button class="btn-vote btn-vote-dislike-stats ${hasDisliked ? 'voted-dislike' : ''}" data-email="${stat.email}">👎 <span>${dislikesCount}</span></button>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');

                container.querySelectorAll('.btn-vote-like-stats').forEach(btn => {
                    btn.onclick = async () => {
                        if (!user.cloudUserEmail) { toast('⚠️ Connectez-vous pour voter', 'error'); return; }
                        applyVoteBounce(btn);
                        const res = await vpsVoteStats(user.cloudUserEmail, user.cloudUserPasswordHash, btn.dataset.email, 'like');
                        if (res && res.success) {
                            loadCommunityData();
                        } else {
                            toast(`❌ Vote échoué: ${res.error || 'erreur'}`, 'error');
                        }
                    };
                });
                container.querySelectorAll('.btn-vote-dislike-stats').forEach(btn => {
                    btn.onclick = async () => {
                        if (!user.cloudUserEmail) { toast('⚠️ Connectez-vous pour voter', 'error'); return; }
                        applyVoteBounce(btn);
                        const res = await vpsVoteStats(user.cloudUserEmail, user.cloudUserPasswordHash, btn.dataset.email, 'dislike');
                        if (res && res.success) {
                            loadCommunityData();
                        } else {
                            toast(`❌ Vote échoué: ${res.error || 'erreur'}`, 'error');
                        }
                    };
                });
            } else {
                container.innerHTML = `<p class="section-desc" style="text-align: center; margin-top: 20px; color: var(--red);">❌ Erreur de chargement: ${data.error || 'serveur injoignable'}</p>`;
            }
        } else {
            document.getElementById('comm-lists-section').style.display = 'none';
            document.getElementById('comm-stats-section').style.display = 'none';
            document.getElementById('comm-params-section').style.display = 'block';

            const container = document.getElementById('community-params-container');
            container.innerHTML = '<p class="section-desc" style="text-align: center; margin-top: 20px;">Chargement des réglages...</p>';

            const data = await vpsGetCommunityParams();
            if (data && data.success && data.params) {
                if (data.params.length === 0) {
                    container.innerHTML = '<p class="section-desc" style="text-align: center; margin-top: 20px;">Aucun réglage partagé pour le moment.</p>';
                    return;
                }

                data.params.sort((a, b) => (b.likes || []).length - (a.likes || []).length);

                container.innerHTML = data.params.map(param => {
                    const likesCount = (param.likes || []).length;
                    const dislikesCount = (param.dislikes || []).length;
                    const hasLiked = (param.likes || []).includes(currentUserEmail);
                    const hasDisliked = (param.dislikes || []).includes(currentUserEmail);
                    const initial = (param.creatorName || '?').charAt(0).toUpperCase();

                    const payload = param.paramsPayload || {};
                    const activeBadges = [];
                    if (payload.enableExtension !== false) activeBadges.push('Extension active');
                    if (payload.hideDescription) activeBadges.push('Description masquée');
                    if (payload.hideSidebarVideos) activeBadges.push('Lecteur épuré');
                    if (payload.hideComments) activeBadges.push('Commentaires masqués');
                    if (payload.hideHomeFeed) activeBadges.push('Accueil masqué');
                    if (payload.hideNotifications) activeBadges.push('Notifs bloquées');
                    if (payload.hideChannelLogo) activeBadges.push('Logos masqués');
                    if (payload.hideSubscribersCount) activeBadges.push('Abonnés masqués');
                    if (payload.hideSecondThumbnail) activeBadges.push('Miniatures 2 évitées');

                    const badgeHtml = activeBadges.map(b => `<span class="badge" style="font-size: 9px; padding: 2px 6px; border-radius: 4px; background: rgba(139, 92, 246, 0.15); color: #a78bfa; border: 1px solid rgba(139, 92, 246, 0.3);">${b}</span>`).join(' ');

                    return `
                        <div class="community-card">
                            <div class="community-card-header">
                                <div class="community-user-info">
                                    <div class="community-avatar">${initial}</div>
                                    <span class="community-card-creator">${param.creatorName}</span>
                                </div>
                                <span class="community-card-date">${new Date(param.updated_at).toLocaleDateString('fr-FR')}</span>
                            </div>
                            <div class="community-card-desc">${param.description || 'Aucune description'}</div>
                            
                            <div class="community-card-badges" style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;">
                                ${badgeHtml || '<span style="font-size: 10px; color: var(--txt-muted);">Configuration par défaut</span>'}
                            </div>

                            <div class="community-card-actions" style="margin-top: 8px;">
                                <div class="vote-buttons">
                                    <button class="btn-vote btn-vote-like-params ${hasLiked ? 'voted-like' : ''}" data-email="${param.email}">👍 <span>${likesCount}</span></button>
                                    <button class="btn-vote btn-vote-dislike-params ${hasDisliked ? 'voted-dislike' : ''}" data-email="${param.email}">👎 <span>${dislikesCount}</span></button>
                                </div>
                                <button class="btn-import-params" data-email="${param.email}">📥 Importer</button>
                            </div>
                        </div>
                    `;
                }).join('');

                container.querySelectorAll('.btn-vote-like-params').forEach(btn => {
                    btn.onclick = async () => {
                        if (!user.cloudUserEmail) { toast('⚠️ Connectez-vous pour voter', 'error'); return; }
                        applyVoteBounce(btn);
                        const res = await vpsVoteParams(user.cloudUserEmail, user.cloudUserPasswordHash, btn.dataset.email, 'like');
                        if (res && res.success) {
                            loadCommunityData();
                        } else {
                            toast(`❌ Vote échoué: ${res.error || 'erreur'}`, 'error');
                        }
                    };
                });
                container.querySelectorAll('.btn-vote-dislike-params').forEach(btn => {
                    btn.onclick = async () => {
                        if (!user.cloudUserEmail) { toast('⚠️ Connectez-vous pour voter', 'error'); return; }
                        applyVoteBounce(btn);
                        const res = await vpsVoteParams(user.cloudUserEmail, user.cloudUserPasswordHash, btn.dataset.email, 'dislike');
                        if (res && res.success) {
                            loadCommunityData();
                        } else {
                            toast(`❌ Vote échoué: ${res.error || 'erreur'}`, 'error');
                        }
                    };
                });
                container.querySelectorAll('.btn-import-params').forEach(btn => {
                    btn.onclick = () => {
                        const targetParam = data.params.find(p => p.email === btn.dataset.email);
                        if (targetParam) {
                            confirm(`Importer les réglages de ${targetParam.creatorName} ?`, async () => {
                                const payload = targetParam.paramsPayload || {};
                                const sessionKeys = ['cloudUserEmail', 'cloudUserName', 'cloudUserPasswordHash'];
                                const sanitizedPayload = {};
                                for (const [k, v] of Object.entries(payload)) {
                                    if (!sessionKeys.includes(k)) {
                                        sanitizedPayload[k] = v;
                                    }
                                }

                                await ss(sanitizedPayload);
                                toast('✅ Réglages importés avec succès ! Rechargement...', 'success');
                                setTimeout(() => location.reload(), 1500);
                            });
                        }
                    };
                });
            } else {
                container.innerHTML = `<p class="section-desc" style="text-align: center; margin-top: 20px; color: var(--red);">❌ Erreur de chargement: ${data.error || 'serveur injoignable'}</p>`;
            }
        }
    }

    // Event bindings for VPS auth and tabs
    document.querySelectorAll('input[name="auth-mode"]').forEach(radio => {
        radio.onchange = () => {
            const nameGroup = document.getElementById('group-cloud-name');
            const submitBtn = document.getElementById('btnCloudAuthSubmit');
            if (radio.value === 'register') {
                nameGroup.style.display = 'block';
                submitBtn.textContent = 'Créer un compte';
            } else {
                nameGroup.style.display = 'none';
                submitBtn.textContent = 'Se connecter';
            }
        };
    });

    document.getElementById('btnCloudAuthSubmit').onclick = async () => {
        const mode = document.querySelector('input[name="auth-mode"]:checked').value;
        const email = document.getElementById('cloud-email').value.trim();
        const password = document.getElementById('cloud-password').value;
        const name = document.getElementById('cloud-name').value.trim();

        if (!email || !password) {
            toast('⚠️ Veuillez remplir tous les champs requis', 'error');
            return;
        }
        if (mode === 'register' && !name) {
            toast('⚠️ Veuillez renseigner un pseudo', 'error');
            return;
        }

        const btn = document.getElementById('btnCloudAuthSubmit');
        btn.disabled = true;
        btn.textContent = 'Patientez...';

        if (mode === 'register') {
            const res = await vpsRegister(email, name, password);
            if (res && res.success) {
                toast('🎉 Compte créé avec succès ! Connexion automatique...', 'success');
                const loginRes = await vpsLogin(email, password);
                if (loginRes && loginRes.success) {
                    const passwordHash = await sha256(password);
                    const cryptKey = await sha256(password + ":crypt");
                    await ss({
                        cloudUserEmail: email.toLowerCase().trim(),
                        cloudUserName: loginRes.name || name,
                        cloudUserPasswordHash: passwordHash,
                        cloudUserCryptKey: cryptKey
                    });
                    initCloudView();
                } else {
                    toast('❌ Connexion automatique échouée, veuillez vous connecter.', 'error');
                    document.querySelector('input[name="auth-mode"][value="login"]').click();
                    document.querySelector('input[name="auth-mode"][value="login"]').dispatchEvent(new Event('change'));
                }
            } else {
                toast(`❌ Erreur: ${res.error || 'Erreur inconnue'}`, 'error');
            }
        } else {
            const res = await vpsLogin(email, password);
            if (res && res.success) {
                const passwordHash = await sha256(password);
                const cryptKey = await sha256(password + ":crypt");
                await ss({
                    cloudUserEmail: email.toLowerCase().trim(),
                    cloudUserName: res.name || email.split('@')[0],
                    cloudUserPasswordHash: passwordHash,
                    cloudUserCryptKey: cryptKey
                });
                toast('👋 Connexion réussie !', 'success');
                initCloudView();
            } else {
                toast(`❌ Connexion échouée: ${res.error || 'Vérifiez vos identifiants'}`, 'error');
            }
        }
        btn.disabled = false;
        btn.textContent = mode === 'register' ? 'Créer un compte' : 'Se connecter';
    };

    document.getElementById('btnVPSLogout').onclick = async () => {
        confirm('Voulez-vous vous déconnecter de votre compte Cloud VPS ?', async () => {
            await ss({
                cloudUserEmail: null,
                cloudUserName: null,
                cloudUserPasswordHash: null,
                cloudUserCryptKey: null
            });
            toast('🔌 Déconnecté avec succès', 'info');
            initCloudView();
        });
    };

    document.getElementById('btnVPSDeleteAccount').onclick = async () => {
        const user = await sg(['cloudUserEmail', 'cloudUserPasswordHash']);
        if (!user || !user.cloudUserEmail) return;
        confirm('⚠️ Action irréversible. Voulez-vous supprimer votre compte et purger TOUTES vos données du VPS ?', async () => {
            const res = await vpsDeleteAccount(user.cloudUserEmail, user.cloudUserPasswordHash);
            if (res && res.success) {
                await ss({
                    cloudUserEmail: null,
                    cloudUserName: null,
                    cloudUserPasswordHash: null,
                    cloudUserCryptKey: null
                });
                toast('🗑️ Compte et données supprimés du VPS', 'success');
                initCloudView();
            } else {
                toast(`❌ Erreur: ${res.error || 'impossible de supprimer le compte'}`, 'error');
            }
        });
    };

    document.getElementById('btnVPSBackup').onclick = async () => {
        const user = await sg(['cloudUserEmail', 'cloudUserPasswordHash']);
        if (!user || !user.cloudUserEmail) return;
        const btn = document.getElementById('btnVPSBackup');
        btn.textContent = '⏳ Envoi...';
        btn.disabled = true;
        const res = await vpsBackup(user.cloudUserEmail, user.cloudUserPasswordHash);
        if (res && res.success) {
            toast('☁️ Données sauvegardées sur le VPS !', 'success');
        } else {
            toast(`❌ Erreur: ${res.error || 'sauvegarde échouée'}`, 'error');
        }
        btn.textContent = '☁️ Sauvegarder';
        btn.disabled = false;
    };

    document.getElementById('btnVPSRestore').onclick = async () => {
        const user = await sg(['cloudUserEmail', 'cloudUserPasswordHash']);
        if (!user || !user.cloudUserEmail) return;
        confirm('⚠️ Attention ! Restaurer écrasera TOUTES vos données actuelles. Confirmer ?', async () => {
            const btn = document.getElementById('btnVPSRestore');
            btn.textContent = '⏳ Restauration...';
            btn.disabled = true;
            const res = await vpsRestore(user.cloudUserEmail, user.cloudUserPasswordHash);
            if (res && res.success) {
                toast('✅ Restauration complète réussie ! Rechargement...', 'success');
                setTimeout(() => location.reload(), 1500);
            } else {
                toast(`❌ Erreur: ${res.error || 'aucune sauvegarde trouvée'}`, 'error');
                btn.textContent = '📥 Restaurer';
                btn.disabled = false;
            }
        });
    };

    document.getElementById('btnCommPublishList').onclick = async () => {
        const user = await sg(['cloudUserEmail', 'cloudUserPasswordHash', 'cloudUserName']);
        if (!user || !user.cloudUserEmail) return;
        const desc = document.getElementById('comm-list-desc').value.trim();
        if (!desc) {
            toast('⚠️ Veuillez entrer une description', 'error');
            return;
        }
        const btn = document.getElementById('btnCommPublishList');
        btn.textContent = '⏳ Publication...';
        btn.disabled = true;
        const res = await vpsPublishList(user.cloudUserEmail, user.cloudUserPasswordHash, user.cloudUserName, desc);
        if (res && res.success) {
            toast('🎉 Liste publiée dans le hub !', 'success');
            document.getElementById('comm-list-desc').value = '';
            loadCommunityData();
        } else {
            toast(`❌ Erreur: ${res.error || 'publication échouée'}`, 'error');
        }
        btn.textContent = 'Publier la liste';
        btn.disabled = false;
    };

    document.getElementById('btnCommPublishStats').onclick = async () => {
        const user = await sg(['cloudUserEmail', 'cloudUserPasswordHash', 'cloudUserName']);
        if (!user || !user.cloudUserEmail) return;
        const desc = document.getElementById('comm-stats-desc').value.trim();
        if (!desc) {
            toast('⚠️ Veuillez entrer une description', 'error');
            return;
        }
        const btn = document.getElementById('btnCommPublishStats');
        btn.textContent = '⏳ Partage...';
        btn.disabled = true;
        const res = await vpsPublishStats(user.cloudUserEmail, user.cloudUserPasswordHash, user.cloudUserName, desc);
        if (res && res.success) {
            toast('🎉 Statistiques partagées avec succès !', 'success');
            document.getElementById('comm-stats-desc').value = '';
            loadCommunityData();
        } else {
            toast(`❌ Erreur: ${res.error || 'partage échoué'}`, 'error');
        }
        btn.textContent = 'Partager mes stats';
        btn.disabled = false;
    };

    document.getElementById('btnCommPublishParams').onclick = async () => {
        const user = await sg(['cloudUserEmail', 'cloudUserPasswordHash', 'cloudUserName']);
        if (!user || !user.cloudUserEmail) return;
        const desc = document.getElementById('comm-params-desc').value.trim();
        if (!desc) {
            toast('⚠️ Veuillez entrer une description', 'error');
            return;
        }
        const btn = document.getElementById('btnCommPublishParams');
        btn.textContent = '⏳ Partage...';
        btn.disabled = true;
        const res = await vpsPublishParams(user.cloudUserEmail, user.cloudUserPasswordHash, user.cloudUserName, desc);
        if (res && res.success) {
            toast('🎉 Réglages partagés avec succès !', 'success');
            document.getElementById('comm-params-desc').value = '';
            loadCommunityData();
        } else {
            toast(`❌ Erreur: ${res.error || 'partage échoué'}`, 'error');
        }
        btn.textContent = 'Partager mes réglages';
        btn.disabled = false;
    };

    document.getElementById('tabCloudAccount').onclick = () => {
        document.getElementById('tabCloudAccount').classList.add('active');
        document.getElementById('tabCloudCommunity').classList.remove('active');
        document.getElementById('tabCloudAccount').style.borderBottom = '2px solid var(--accent)';
        document.getElementById('tabCloudCommunity').style.borderBottom = 'none';
        initCloudView();
    };

    document.getElementById('tabCloudCommunity').onclick = () => {
        document.getElementById('tabCloudCommunity').classList.add('active');
        document.getElementById('tabCloudAccount').classList.remove('active');
        document.getElementById('tabCloudCommunity').style.borderBottom = '2px solid var(--accent)';
        document.getElementById('tabCloudAccount').style.borderBottom = 'none';
        initCloudView();
    };

    // Collapsible accordion publish card logic
    const publishCardHeader = document.getElementById('publish-card-header');
    const publishCardBody = document.getElementById('publish-card-body');
    const publishCardArrow = document.getElementById('publish-card-arrow');

    if (publishCardHeader && publishCardBody && publishCardArrow) {
        publishCardHeader.onclick = () => {
            const isOpen = publishCardBody.style.maxHeight && publishCardBody.style.maxHeight !== '0px';
            if (isOpen) {
                // Collapse
                publishCardBody.style.maxHeight = '0px';
                publishCardBody.style.opacity = '0';
                publishCardBody.style.padding = '0 14px';
                publishCardArrow.style.transform = 'rotate(0deg)';
            } else {
                // Expand
                updatePublishBoxesVisibility();
                publishCardBody.style.maxHeight = publishCardBody.scrollHeight + 'px';
                publishCardBody.style.opacity = '1';
                publishCardBody.style.padding = '0 14px 10px 14px';
                publishCardArrow.style.transform = 'rotate(180deg)';
            }
        };
    }

    document.getElementById('subTabCommLists').onclick = () => {
        document.getElementById('subTabCommLists').classList.add('active');
        document.getElementById('subTabCommStats').classList.remove('active');
        document.getElementById('subTabCommParams').classList.remove('active');
        
        // Update segmented control style
        document.getElementById('subTabCommLists').style.color = 'var(--txt-main)';
        document.getElementById('subTabCommLists').style.fontWeight = '700';
        document.getElementById('subTabCommStats').style.color = 'var(--txt-muted)';
        document.getElementById('subTabCommStats').style.fontWeight = '600';
        document.getElementById('subTabCommParams').style.color = 'var(--txt-muted)';
        document.getElementById('subTabCommParams').style.fontWeight = '600';
        document.getElementById('segmented-glider').style.transform = 'translateX(0)';

        // Adjust accordion height if open
        if (publishCardBody && publishCardBody.style.maxHeight && publishCardBody.style.maxHeight !== '0px') {
            updatePublishBoxesVisibility();
            publishCardBody.style.maxHeight = publishCardBody.scrollHeight + 'px';
        }
        
        loadCommunityData();
    };

    document.getElementById('subTabCommStats').onclick = () => {
        document.getElementById('subTabCommStats').classList.add('active');
        document.getElementById('subTabCommLists').classList.remove('active');
        document.getElementById('subTabCommParams').classList.remove('active');

        // Update segmented control style
        document.getElementById('subTabCommStats').style.color = 'var(--txt-main)';
        document.getElementById('subTabCommStats').style.fontWeight = '700';
        document.getElementById('subTabCommLists').style.color = 'var(--txt-muted)';
        document.getElementById('subTabCommLists').style.fontWeight = '600';
        document.getElementById('subTabCommParams').style.color = 'var(--txt-muted)';
        document.getElementById('subTabCommParams').style.fontWeight = '600';
        document.getElementById('segmented-glider').style.transform = 'translateX(100%)';

        // Adjust accordion height if open
        if (publishCardBody && publishCardBody.style.maxHeight && publishCardBody.style.maxHeight !== '0px') {
            updatePublishBoxesVisibility();
            publishCardBody.style.maxHeight = publishCardBody.scrollHeight + 'px';
        }

        loadCommunityData();
    };

    document.getElementById('subTabCommParams').onclick = () => {
        document.getElementById('subTabCommParams').classList.add('active');
        document.getElementById('subTabCommLists').classList.remove('active');
        document.getElementById('subTabCommStats').classList.remove('active');

        // Update segmented control style
        document.getElementById('subTabCommParams').style.color = 'var(--txt-main)';
        document.getElementById('subTabCommParams').style.fontWeight = '700';
        document.getElementById('subTabCommLists').style.color = 'var(--txt-muted)';
        document.getElementById('subTabCommLists').style.fontWeight = '600';
        document.getElementById('subTabCommStats').style.color = 'var(--txt-muted)';
        document.getElementById('subTabCommStats').style.fontWeight = '600';
        document.getElementById('segmented-glider').style.transform = 'translateX(200%)';

        // Adjust accordion height if open
        if (publishCardBody && publishCardBody.style.maxHeight && publishCardBody.style.maxHeight !== '0px') {
            updatePublishBoxesVisibility();
            publishCardBody.style.maxHeight = publishCardBody.scrollHeight + 'px';
        }

        loadCommunityData();
    };

    // Conditions d'utilisation Modals
    const termsModal = document.getElementById('termsModal');
    const showTerms = () => { if (termsModal) termsModal.style.display = 'flex'; };
    const closeTerms = () => { if (termsModal) termsModal.style.display = 'none'; };
    
    const linkTerms = document.getElementById('linkCloudTerms');
    const linkTerms2 = document.getElementById('linkCloudTerms2');
    const closeTermsBtn = document.getElementById('termsModalCloseBtn');
    
    if (linkTerms) linkTerms.onclick = showTerms;
    if (linkTerms2) linkTerms2.onclick = showTerms;
    if (closeTermsBtn) closeTermsBtn.onclick = closeTerms;

    /* ──────────────────────────────────────────────────────────
       ⏱️ MINUTEUR POMODORO (v4.1)
       ────────────────────────────────────────────────────────── */
    let pomoTimerInterval = null;
    const pomoTimerDisplay = document.getElementById('pomo-timer-display');
    const pomoModeDisplay = document.getElementById('pomo-mode-display');
    const pomoProgressRing = document.getElementById('pomo-progress-ring');
    const pomoBtnPlay = document.getElementById('pomo-btn-play');
    const pomoBtnSkip = document.getElementById('pomo-btn-skip');
    const pomoBtnReset = document.getElementById('pomo-btn-reset');
    const pomoPresetBtns = document.querySelectorAll('.pomo-preset-btn');

    function updatePomodoroUI() {
        chrome.storage.local.get([
            'pomodoroActive', 'pomodoroMode', 'pomodoroStartTime', 
            'pomodoroDuration', 'pomodoroPaused', 'pomodoroPausedTimeLeft'
        ], (res) => {
            if (chrome.runtime.lastError) return;

            const active = res.pomodoroActive || false;
            const paused = res.pomodoroPaused || false;
            const mode = res.pomodoroMode || 'idle';
            const startTime = res.pomodoroStartTime || 0;
            const totalDuration = res.pomodoroDuration || 0;
            const pausedTimeLeft = res.pomodoroPausedTimeLeft || 0;

            let modeText = 'Prêt';
            let ringColor = 'var(--accent)';

            if (mode === 'work') {
                modeText = '💼 Travail';
                ringColor = 'var(--accent)';
            } else if (mode === 'break') {
                modeText = '☕ Pause';
                ringColor = '#10b981';
            }

            if (pomoModeDisplay) pomoModeDisplay.textContent = modeText;
            if (pomoProgressRing) pomoProgressRing.style.stroke = ringColor;

            let timeLeft = 0;
            if (active && !paused) {
                const elapsed = Date.now() - startTime;
                timeLeft = Math.max(0, totalDuration - elapsed);
                if (pomoBtnPlay) pomoBtnPlay.textContent = '⏸️ Pause';
            } else if (paused) {
                timeLeft = pausedTimeLeft;
                if (pomoBtnPlay) pomoBtnPlay.textContent = '▶️ Reprendre';
            } else {
                timeLeft = 0;
                if (pomoBtnPlay) pomoBtnPlay.textContent = '▶️ Démarrer';
            }

            if (mode === 'idle') {
                timeLeft = 25 * 60 * 1000;
            }

            const mins = Math.floor(timeLeft / 60000);
            const secs = Math.floor((timeLeft % 60000) / 1000);
            if (pomoTimerDisplay) {
                pomoTimerDisplay.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
            }

            if (pomoProgressRing) {
                const circ = 326.7;
                let ratio = 0;
                if (mode !== 'idle' && totalDuration > 0) {
                    ratio = timeLeft / totalDuration;
                } else {
                    ratio = 1;
                }
                const offset = circ * (1 - ratio);
                pomoProgressRing.style.strokeDashoffset = offset;
            }
        });
    }

    if (pomoBtnPlay) {
        pomoBtnPlay.addEventListener('click', () => {
            chrome.storage.local.get(['pomodoroActive', 'pomodoroPaused', 'pomodoroMode'], (res) => {
                const active = res.pomodoroActive || false;
                const paused = res.pomodoroPaused || false;
                const mode = res.pomodoroMode || 'idle';

                if (active && !paused) {
                    chrome.runtime.sendMessage({ action: 'pomodoro_pause' }, (resp) => {
                        updatePomodoroUI();
                    });
                } else if (paused) {
                    chrome.runtime.sendMessage({ action: 'pomodoro_resume' }, (resp) => {
                        updatePomodoroUI();
                    });
                } else {
                    chrome.runtime.sendMessage({ 
                        action: 'pomodoro_start', 
                        mode: 'work', 
                        duration: 25 * 60 * 1000 
                    }, (resp) => {
                        updatePomodoroUI();
                    });
                }
            });
        });
    }

    if (pomoBtnSkip) {
        pomoBtnSkip.addEventListener('click', () => {
            chrome.storage.local.get(['pomodoroMode'], (res) => {
                const mode = res.pomodoroMode || 'idle';
                let nextMode = 'work';
                let nextDur = 25 * 60 * 1000;

                if (mode === 'work') {
                    nextMode = 'break';
                    nextDur = 5 * 60 * 1000;
                }

                chrome.runtime.sendMessage({
                    action: 'pomodoro_start',
                    mode: nextMode,
                    duration: nextDur
                }, (resp) => {
                    updatePomodoroUI();
                    toast('⏭️ Session suivante démarrée', 'info');
                });
            });
        });
    }

    if (pomoBtnReset) {
        pomoBtnReset.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'pomodoro_reset' }, (resp) => {
                updatePomodoroUI();
                toast('🔄 Minuteur réinitialisé', 'info');
            });
        });
    }

    pomoPresetBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const mins = parseInt(btn.getAttribute('data-mins')) || 25;
            const type = btn.getAttribute('data-type') || 'work';
            chrome.runtime.sendMessage({
                action: 'pomodoro_start',
                mode: type,
                duration: mins * 60 * 1000
            }, (resp) => {
                updatePomodoroUI();
                const typeLabel = type === 'work' ? 'Focus' : 'Pause';
                toast(`🎯 Session ${typeLabel} (${mins}m) démarrée`, 'success');
            });
        });
    });

    pomoTimerInterval = setInterval(updatePomodoroUI, 1000);
    updatePomodoroUI();

    chrome.storage.onChanged.addListener((changes) => {
        if (changes.pomodoroActive || changes.pomodoroMode || changes.pomodoroPaused) {
            updatePomodoroUI();
        }
    });

    /* ──────────────────────────────────────────────────────────
       📅 PLANIFICATION FOCUS (FOCUS HOURS)
       ────────────────────────────────────────────────────────── */
    let focusRanges = sync.focusHoursRanges || [];
    const focusHoursEnabled = document.getElementById('focusHoursEnabled');
    const focusHoursConfigArea = document.getElementById('focus-hours-config-area');
    const focusRangesList = document.getElementById('focus-ranges-list');
    const btnAddFocusRange = document.getElementById('btn-add-focus-range');
    const focusHoursModeSelect = document.getElementById('focusHoursMode');
    const btnSaveFocusHours = document.getElementById('saveFocusHours');

    if (focusHoursEnabled) {
        focusHoursEnabled.checked = sync.focusHoursEnabled || false;
        if (focusHoursConfigArea) {
            focusHoursConfigArea.style.display = focusHoursEnabled.checked ? 'block' : 'none';
        }
        focusHoursEnabled.addEventListener('change', (e) => {
            if (focusHoursConfigArea) {
                focusHoursConfigArea.style.display = e.target.checked ? 'block' : 'none';
            }
        });
    }

    const savedDays = sync.focusHoursDays || [];
    document.querySelectorAll('.focus-day-chk').forEach(chk => {
        chk.checked = savedDays.includes(parseInt(chk.value));
    });

    if (focusHoursModeSelect) {
        focusHoursModeSelect.value = sync.focusHoursMode || 'hard';
    }

    function renderFocusRanges() {
        if (!focusRangesList) return;
        focusRangesList.innerHTML = '';
        if (focusRanges.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.style.fontSize = '11px';
            emptyMsg.style.color = 'var(--txt-muted)';
            emptyMsg.style.textAlign = 'center';
            emptyMsg.style.padding = '6px 0';
            emptyMsg.textContent = 'Aucun créneau configuré.';
            focusRangesList.appendChild(emptyMsg);
            return;
        }
        
        focusRanges.forEach((range, idx) => {
            const div = document.createElement('div');
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            div.style.justifyContent = 'space-between';
            div.style.background = 'rgba(255,255,255,0.03)';
            div.style.padding = '6px 10px';
            div.style.borderRadius = '8px';
            div.style.border = '1px solid var(--border)';
            div.style.marginBottom = '6px';

            const textSpan = document.createElement('span');
            textSpan.style.fontSize = '11px';
            textSpan.style.fontWeight = '600';
            textSpan.textContent = `⏰ ${range.start} - ${range.end}`;

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn-ghost';
            deleteBtn.style.padding = '0 6px';
            deleteBtn.style.height = '20px';
            deleteBtn.style.fontSize = '10px';
            deleteBtn.style.color = 'var(--accent)';
            deleteBtn.style.cursor = 'pointer';
            deleteBtn.textContent = '❌';
            deleteBtn.addEventListener('click', () => {
                focusRanges.splice(idx, 1);
                renderFocusRanges();
            });

            div.appendChild(textSpan);
            const spacer = document.createElement('div');
            spacer.style.flex = '1';
            div.appendChild(spacer);
            div.appendChild(deleteBtn);
            
            focusRangesList.appendChild(div);
        });
    }

    renderFocusRanges();

    if (btnAddFocusRange) {
        btnAddFocusRange.addEventListener('click', () => {
            const startVal = document.getElementById('focus-range-start').value;
            const endVal = document.getElementById('focus-range-end').value;
            if (!startVal || !endVal) {
                toast('❌ Veuillez renseigner le début et la fin.', 'error');
                return;
            }
            if (startVal >= endVal) {
                toast('❌ L\'heure de début doit être avant l\'heure de fin.', 'error');
                return;
            }
            if (focusRanges.some(r => r.start === startVal && r.end === endVal)) {
                toast('❌ Ce créneau existe déjà.', 'error');
                return;
            }
            focusRanges.push({ start: startVal, end: endVal });
            renderFocusRanges();
            toast('✅ Créneau ajouté', 'success');
        });
    }

    if (btnSaveFocusHours) {
        btnSaveFocusHours.addEventListener('click', async () => {
            const enabled = focusHoursEnabled ? focusHoursEnabled.checked : false;
            const days = Array.from(document.querySelectorAll('.focus-day-chk:checked')).map(chk => parseInt(chk.value));
            const mode = focusHoursModeSelect ? focusHoursModeSelect.value : 'hard';

            await ss({
                focusHoursEnabled: enabled,
                focusHoursDays: days,
                focusHoursRanges: focusRanges,
                focusHoursMode: mode
            });
            toast('📅 Planification sauvegardée !', 'success');
        });
    }

    /* ──────────────────────────────────────────────────────────
       🎨 PERSONNALISATION & REDIRECTION (v4.1)
       ────────────────────────────────────────────────────────── */
    const selForcedTheme = document.getElementById('selForcedTheme');
    const customLogoText = document.getElementById('customLogoText');
    const customLogoUrl = document.getElementById('customLogoUrl');
    const useMotivationDashboard = document.getElementById('useMotivationDashboard');
    const activeRedirectionEnabled = document.getElementById('activeRedirectionEnabled');
    const redirectionUrlGroup = document.getElementById('redirection-url-group');
    const activeRedirectionUrl = document.getElementById('activeRedirectionUrl');
    const favoriteChannels = document.getElementById('favoriteChannels');
    const btnSaveCustomUI = document.getElementById('saveCustomUI');

    if (selForcedTheme) {
        selForcedTheme.value = sync.forcedTheme || 'auto';
    }
    if (customLogoText) {
        customLogoText.value = sync.customLogoText || '';
    }
    if (customLogoUrl) {
        customLogoUrl.value = sync.customLogoUrl || '';
    }
    if (useMotivationDashboard) {
        useMotivationDashboard.checked = sync.useMotivationDashboard || false;
    }
    if (activeRedirectionEnabled) {
        activeRedirectionEnabled.checked = sync.activeRedirectionEnabled || false;
        if (redirectionUrlGroup) {
            redirectionUrlGroup.style.display = activeRedirectionEnabled.checked ? 'block' : 'none';
        }
        activeRedirectionEnabled.addEventListener('change', (e) => {
            if (redirectionUrlGroup) {
                redirectionUrlGroup.style.display = e.target.checked ? 'block' : 'none';
            }
        });
    }
    if (activeRedirectionUrl) {
        activeRedirectionUrl.value = sync.activeRedirectionUrl || '';
    }
    if (favoriteChannels) {
        favoriteChannels.value = sync.favoriteChannels || '';
    }

    if (selForcedTheme) {
        selForcedTheme.addEventListener('change', async (e) => {
            const themeVal = e.target.value;
            await ss({ forcedTheme: themeVal });
            applyTheme(themeVal);
            const newIdx = themes.indexOf(themeVal);
            if (newIdx >= 0) themeIdx = newIdx;
        });
    }

    if (btnSaveCustomUI) {
        btnSaveCustomUI.addEventListener('click', async () => {
            const theme = selForcedTheme ? selForcedTheme.value : 'auto';
            const logoText = customLogoText ? customLogoText.value.trim() : '';
            const logoUrl = customLogoUrl ? customLogoUrl.value.trim() : '';
            const motivation = useMotivationDashboard ? useMotivationDashboard.checked : false;
            const redirEnabled = activeRedirectionEnabled ? activeRedirectionEnabled.checked : false;
            const redirUrl = activeRedirectionUrl ? activeRedirectionUrl.value.trim() : '';
            const favChannels = favoriteChannels ? favoriteChannels.value.trim() : '';

            await ss({
                forcedTheme: theme,
                customLogoText: logoText,
                customLogoUrl: logoUrl,
                useMotivationDashboard: motivation,
                activeRedirectionEnabled: redirEnabled,
                activeRedirectionUrl: redirUrl,
                favoriteChannels: favChannels
            });

            applyTheme(theme);
            toast('🎨 Réglages UI enregistrés !', 'success');
        });
    }

    window.initCloudView = initCloudView;
    window.loadCommunityData = loadCommunityData;
});