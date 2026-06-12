/* ══════════════════════════════════════════════════════════════════════════
   YouTube Blocker Pro — inject.js (MAIN world)
   Accès natif à l'API lecteur YouTube. Optimisé : pas de spam console,
   qualité forcée une seule fois par navigation avec vérification préalable.
══════════════════════════════════════════════════════════════════════════ */

(function() {
    const _dbg = () => { try { return localStorage.getItem('ytbpDebug') === '1'; } catch(_){ return false; } };

    const isAutoQualityEnabled = () =>
        document.documentElement.getAttribute('data-ytbp-highest-quality') === 'true';

    // Qualité déjà forcée pour la navigation courante ?
    let _qualityForcedForUrl = '';

    function setHighestQuality(player) {
        if (!isAutoQualityEnabled()) return;

        // localStorage — une seule fois par URL
        try {
            localStorage.setItem('yt-player-quality', JSON.stringify({ creation: Date.now(), data: 'highres' }));
        } catch(_) {}

        if (!player) player = document.querySelector('.html5-video-player');
        if (!player) return;

        try {
            if (typeof player.getAvailableQualityLevels !== 'function') return;
            const qualities = player.getAvailableQualityLevels();
            if (!qualities || !qualities.length) return;
            const highest = qualities[0];

            // Ne rien faire si on est déjà à la meilleure qualité
            const current = typeof player.getPlaybackQuality === 'function' ? player.getPlaybackQuality() : null;
            if (current === highest) { _qualityForcedForUrl = location.href; return; }

            if (typeof player.setPlaybackQualityRange === 'function') player.setPlaybackQualityRange(highest, highest);
            if (typeof player.setPlaybackQuality     === 'function') player.setPlaybackQuality(highest);
            _qualityForcedForUrl = location.href;
            if (_dbg()) console.log('🛡️ [YTBP] Qualité maximale forcée (MAIN) :', highest);
        } catch(e) {
            if (_dbg()) console.error('🛡️ [YTBP] Erreur qualité :', e);
        }
    }

    // Navigation YouTube — deux tentatives suffisent (ABR initial + confirmation)
    window.addEventListener('yt-navigate-finish', () => {
        if (_dbg()) console.log('🛡️ [YTBP] Navigation terminée (MAIN)');
        _qualityForcedForUrl = ''; // reset pour la nouvelle page
        setTimeout(() => {
            const p = document.querySelector('.html5-video-player');
            if (!p) return;
            setHighestQuality(p);
            // Une seule confirmation à 1.5s pour contrer l'ABR — pas besoin de 4 timers
            setTimeout(() => setHighestQuality(p), 1500);
        }, 400);
    });

    // Qualité rétablie si YouTube la change en cours de lecture (ABR adaptatif)
    document.addEventListener('play', e => {
        if (!e.target || e.target.tagName !== 'VIDEO') return;
        // Évite de re-forcer si on vient juste de le faire pour cette URL
        if (_qualityForcedForUrl === location.href) return;
        const p = document.querySelector('.html5-video-player');
        if (p) setHighestQuality(p);
    }, true);
})();
