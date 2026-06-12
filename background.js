importScripts('utils.js');

/* ── GESTION WEBSOCKETS (SYNC TEMPS RÉEL) ────────────────────────── */
let socket = null;
let reconnectDelay = 2000;
let pingInterval = null;
let isRestoringFromWS = false;

async function vpsRestoreBackground() {
    try {
        const syncData = await safeStorage(chrome.storage.sync.get.bind(chrome.storage.sync), ['cloudUserEmail', 'cloudUserPasswordHash', 'cloudUserCryptKey']);
        if (!syncData || !syncData.cloudUserEmail || !syncData.cloudUserPasswordHash) return false;

        const email = syncData.cloudUserEmail;
        const passwordHash = syncData.cloudUserPasswordHash;
        const cryptKey = syncData.cloudUserCryptKey;
        const API_BASE_URL = 'https://extension.blocker.youtube.crossplaymc.fr';

        const res = await fetch(`${API_BASE_URL}/api/backup?email=${encodeURIComponent(email)}&passwordHash=${encodeURIComponent(passwordHash)}`);
        const data = await res.json();
        if (data && data.success) {
            let restoredLists = {};
            let restoredStats = {};
            let restoredParams = {};

            if (data.lists && data.lists.payload) {
                if (data.lists.encrypted && cryptKey) {
                    try {
                        const decrypted = await decryptPayload(data.lists.payload, cryptKey);
                        restoredLists = JSON.parse(decrypted);
                    } catch(e) { logger("Failed to decrypt lists background:", e); return false; }
                } else {
                    restoredLists = data.lists.payload;
                }
            }

            if (data.stats && data.stats.payload) {
                if (data.stats.encrypted && cryptKey) {
                    try {
                        const decrypted = await decryptPayload(data.stats.payload, cryptKey);
                        restoredStats = JSON.parse(decrypted);
                    } catch(e) { logger("Failed to decrypt stats background:", e); return false; }
                } else {
                    restoredStats = data.stats.payload;
                }
            }

            if (data.params && data.params.payload) {
                if (data.params.encrypted && cryptKey) {
                    try {
                        const decrypted = await decryptPayload(data.params.payload, cryptKey);
                        restoredParams = JSON.parse(decrypted);
                    } catch(e) { logger("Failed to decrypt params background:", e); return false; }
                } else {
                    restoredParams = data.params.payload;
                }
            }

            const localCombined = {};
            Object.assign(localCombined, restoredLists);
            Object.assign(localCombined, restoredStats);

            await new Promise(r => chrome.storage.local.clear(() => r()));
            await new Promise(r => chrome.storage.local.set(localCombined, () => r()));

            const sessionKeys = ['cloudUserEmail', 'cloudUserName', 'cloudUserPasswordHash', 'cloudUserCryptKey'];
            const currentSession = {};
            for (const key of sessionKeys) {
                const val = syncData[key] || await safeStorage(chrome.storage.sync.get.bind(chrome.storage.sync), [key]).then(r => r?.[key]);
                if (val) currentSession[key] = val;
            }

            await new Promise(r => chrome.storage.sync.clear(() => r()));
            const finalParamsCombined = Object.assign({}, restoredParams, currentSession);
            await new Promise(r => chrome.storage.sync.set(finalParamsCombined, () => r()));

            logger("Restauration complète réussie en arrière-plan.");
            return true;
        }
    } catch(e) {
        logger("Erreur restauration automatique VPS arrière-plan:", e);
    }
    return false;
}

async function initWebSocket() {
    const syncData = await safeStorage(chrome.storage.sync.get.bind(chrome.storage.sync), ['cloudUserEmail', 'cloudUserPasswordHash']);
    if (!syncData || !syncData.cloudUserEmail || !syncData.cloudUserPasswordHash) {
        closeWebSocket();
        return;
    }

    if (socket) {
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
            return;
        }
        closeWebSocket();
    }

    const wsUrl = 'wss://extension.blocker.youtube.crossplaymc.fr/';
    logger("Connexion WebSocket à", wsUrl);

    try {
        socket = new WebSocket(wsUrl);

        socket.onopen = () => {
            logger("WebSocket connecté, envoi authentification...");
            reconnectDelay = 2000;
            socket.send(JSON.stringify({
                type: 'auth',
                email: syncData.cloudUserEmail,
                passwordHash: syncData.cloudUserPasswordHash
            }));

            if (pingInterval) clearInterval(pingInterval);
            pingInterval = setInterval(() => {
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'ping' }));
                }
            }, 30000);
        };

        socket.onmessage = async (event) => {
            try {
                const data = JSON.parse(event.data);
                logger("WebSocket reçu:", data.type);
                if (data.type === 'auth_success') {
                    logger("WebSocket authentifié avec succès.");
                } else if (data.type === 'reload_request') {
                    logger("Demande de rechargement reçue via WebSocket...");
                    isRestoringFromWS = true;
                    const recovered = await vpsRestoreBackground();
                    isRestoringFromWS = false;
                    if (recovered) {
                        chrome.tabs.query({ url: "*://*.youtube.com/*" }, (tabs) => {
                            tabs.forEach(tab => {
                                chrome.tabs.sendMessage(tab.id, { action: "force_block_reload" }).catch(() => {});
                            });
                        });
                        chrome.notifications.create({
                            type: 'basic', iconUrl: 'icon.png',
                            title: '⚡ Synchronisation Temps Réel',
                            message: 'Vos filtres et réglages ont été synchronisés avec vos autres appareils.'
                        });
                    }
                }
            } catch (e) {
                logger("Erreur parsing message WS:", e);
            }
        };

        socket.onerror = (err) => {
            logger("Erreur WebSocket:", err);
        };

        socket.onclose = () => {
            logger("WebSocket déconnecté.");
            closeWebSocket();
            setTimeout(initWebSocket, reconnectDelay);
            reconnectDelay = Math.min(60000, reconnectDelay * 2);
        };
    } catch(e) {
        logger("Erreur initialisation WebSocket:", e);
        setTimeout(initWebSocket, reconnectDelay);
        reconnectDelay = Math.min(60000, reconnectDelay * 2);
    }
}

function closeWebSocket() {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (socket) {
        try { socket.close(); } catch(_) {}
        socket = null;
    }
}

function notifyWSSyncUpdate() {
    if (socket && socket.readyState === WebSocket.OPEN && !isRestoringFromWS) {
        socket.send(JSON.stringify({ type: 'sync_update' }));
        logger("Notification de modification envoyée aux autres clients WebSocket.");
    }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync') {
        if (changes.cloudUserEmail || changes.cloudUserPasswordHash) {
            initWebSocket();
        }
    }
});

/* ── Wrapper sécurisé pour tous les appels storage ─────────────── */
function safeStorage(op, ...args) {
    return new Promise(resolve => {
        try {
            op(...args, result => {
                if (chrome.runtime.lastError) {
                    logger("Storage error:", chrome.runtime.lastError.message);
                    resolve(null);
                } else resolve(result || {});
            });
        } catch(e) { logger("Storage exception:", e); resolve(null); }
    });
}

function getNext21h() {
    const now = new Date();
    const next = new Date();
    next.setHours(21, 0, 0, 0);
    if (now >= next) next.setDate(next.getDate() + 1);
    return next.getTime();
}

/* ── SYSTÈME GOOGLE CLOUD SYNC ──────────────────────────────────── */
async function syncToCloud() {
    const syncData = await safeStorage(chrome.storage.sync.get.bind(chrome.storage.sync), ['cloudUserEmail', 'cloudUserPasswordHash', 'cloudUserCryptKey']);
    if (syncData && syncData.cloudUserEmail && syncData.cloudUserPasswordHash) {
        try {
            const API_BASE_URL = 'https://extension.blocker.youtube.crossplaymc.fr';
            const localData = await safeStorage(chrome.storage.local.get.bind(chrome.storage.local), null);
            
            const listsPayload = {};
            const statsPayload = {};
            for (const [k, v] of Object.entries(localData || {})) {
                if (k.includes('watchStats')) {
                    statsPayload[k] = v;
                } else if (!k.includes('rollingBackups')) {
                    listsPayload[k] = v;
                }
            }

            const allSyncData = await safeStorage(chrome.storage.sync.get.bind(chrome.storage.sync), null);

            const sessionKeys = ['cloudUserEmail', 'cloudUserPasswordHash', 'cloudUserUserName', 'cloudUserCryptKey'];
            const paramsPayload = {};
            if (allSyncData) {
                for (const [key, val] of Object.entries(allSyncData)) {
                    if (!key.startsWith('backup_') && !sessionKeys.includes(key)) {
                        paramsPayload[key] = val;
                    }
                }
            }

            const cryptKey = syncData.cloudUserCryptKey;
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
                email: syncData.cloudUserEmail,
                passwordHash: syncData.cloudUserPasswordHash,
                lists: finalLists,
                stats: finalStats,
                params: finalParams
            };

            const res = await fetch(`${API_BASE_URL}/api/backup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const resData = await res.json();
            if (resData && resData.success) {
                logger("Sauvegarde automatique VPS réussie.");
                notifyWSSyncUpdate();
                return true;
            }
        } catch(e) {
            logger("Erreur sauvegarde automatique VPS:", e);
        }
    }
    return false;
}

async function recoverFromCloud() {
    const metaData = await safeStorage(chrome.storage.sync.get.bind(chrome.storage.sync), ['backup_meta']);
    if (!metaData || !metaData.backup_meta) return false;
    
    const keys = [];
    for (let i = 0; i < metaData.backup_meta.chunks; i++) keys.push('backup_' + i);
    const chunks = await safeStorage(chrome.storage.sync.get.bind(chrome.storage.sync), keys);
    
    let str = '';
    for (let i = 0; i < metaData.backup_meta.chunks; i++) str += chunks['backup_' + i] || '';
    
    if (str) {
        try {
            const data = JSON.parse(str);
            await safeStorage(chrome.storage.local.set.bind(chrome.storage.local), data);
            logger("Listes restaurées avec succès depuis le Cloud !");
            return true;
        } catch(e) { logger("Erreur récupération Cloud", e); }
    }
    return false;
}

async function getProfilePrefix() {
    const s = await safeStorage(chrome.storage.sync.get.bind(chrome.storage.sync), ['activeProfile']);
    const prof = (s && s.activeProfile) || 'default';
    return prof === 'default' ? '' : `${prof}_`;
}

async function createDailyRollingBackup() {
    const prefix = await getProfilePrefix();
    const keys = [`${prefix}blockedVideos`, `${prefix}blockedChannels`, `${prefix}watchStats`];
    const localData = await safeStorage(chrome.storage.local.get.bind(chrome.storage.local), keys);
    if (!localData) return;
    
    const snapshot = {
        timestamp: Date.now(),
        blockedVideos: localData[`${prefix}blockedVideos`] || [],
        blockedChannels: localData[`${prefix}blockedChannels`] || [],
        watchStats: localData[`${prefix}watchStats`] || null
    };
    
    const backupKey = `${prefix}rollingBackups`;
    const oldBackupsResult = await safeStorage(chrome.storage.local.get.bind(chrome.storage.local), [backupKey]);
    let backups = (oldBackupsResult && oldBackupsResult[backupKey]) || [];
    
    backups.push(snapshot);
    if (backups.length > 7) backups.shift();
    
    const saveObj = {};
    saveObj[backupKey] = backups;
    await safeStorage(chrome.storage.local.set.bind(chrome.storage.local), saveObj);
    logger("Sauvegarde tournante quotidienne créée.");
}

/* ── ANTI-TRADUCTION via declarativeNetRequest (zéro rechargement) ── */
const ANTI_TRANS_RULE_ID = 1001;

async function applyAntiTranslateRule() {
    try {
        const s = await safeStorage(chrome.storage.sync.get.bind(chrome.storage.sync), ['antiAutoTranslate']);
        const enabled = s && s.antiAutoTranslate;

        // Supprimer l'ancienne règle
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [ANTI_TRANS_RULE_ID]
        });

        if (enabled) {
            await chrome.declarativeNetRequest.updateDynamicRules({
                addRules: [{
                    id: ANTI_TRANS_RULE_ID,
                    priority: 1,
                    action: {
                        type: 'modifyHeaders',
                        requestHeaders: [
                            { header: 'Accept-Language', operation: 'set', value: 'en,en-US;q=0.9' }
                        ]
                    },
                    condition: {
                        urlFilter: '||youtube.com/*',
                        resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'other']
                    }
                }]
            });
            logger('Anti-translate DNR rule activée.');
        } else {
            logger('Anti-translate DNR rule désactivée.');
        }
    } catch(e) {
        logger('Erreur applyAntiTranslateRule:', e);
    }
}

chrome.runtime.onStartup.addListener(checkAndRecover);
chrome.runtime.onStartup.addListener(applyAntiTranslateRule);

// Mettre à jour la règle DNR si le setting antiAutoTranslate change
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.antiAutoTranslate !== undefined) {
        applyAntiTranslateRule();
    }
});


chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.url && changeInfo.url.startsWith("chrome://extensions")) {
        const syncData = await safeStorage(chrome.storage.sync.get.bind(chrome.storage.sync), ['enableUninstallProtection']);
        if (syncData && syncData.enableUninstallProtection) {
            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icon.png',
                title: '🛡️ Protection Désinstallation',
                message: 'Tu vas vraiment supprimer l\'extension ? Pense à ton temps libre et à tes objectifs de concentration avant de cliquer sur Supprimer !'
            });
        }
    }
});

chrome.runtime.onInstalled.addListener(() => {
    checkAndRecover();
    applyAntiTranslateRule(); // initialise la règle DNR anti-traduction
    // Alarmes : Sauvegarde PC et Cloud Automatique 5 min
    chrome.alarms.create("weeklyBackup",  { periodInMinutes: 10080 });
    chrome.alarms.create("fiveMinCloudSync", { periodInMinutes: 5 });
    chrome.alarms.create("weeklyReport",  { periodInMinutes: 10080 });
    chrome.alarms.create("monthlyReport", { periodInMinutes: 43200 });
    chrome.alarms.create("dailySummary",  { when: getNext21h(), periodInMinutes: 1440 });
    chrome.alarms.create("dailyRollingBackup", { periodInMinutes: 1440 });
    setTimeout(createDailyRollingBackup, 2000);

    // Supprimer l'ancienne alarme hebdomadaire cloud
    chrome.alarms.clear("weeklyCloudSync");

    // Nettoyage immédiat des anciennes sauvegardes locales Google Cloud Sync pour libérer l'espace chrome.storage.sync
    chrome.storage.sync.get(null, res => {
        if (chrome.runtime.lastError) return;
        const keysToRemove = Object.keys(res).filter(k => k.startsWith('backup_'));
        if (keysToRemove.length > 0) {
            chrome.storage.sync.remove(keysToRemove, () => {
                logger("Freeing storage sync: removed obsolete Google Cloud backup chunks.");
            });
        }
    });

    chrome.contextMenus.create({
        id: "blockVideoYTBP",
        title: "🛡️ Bloquer ce lien YouTube",
        contexts: ["link"],
        targetUrlPatterns: ["*://*.youtube.com/watch*"]
    });
});

function broadcastToTabs(msg) {
    chrome.tabs.query({ url: "*://*.youtube.com/*" }, (tabs) => {
        tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
        });
    });
}

/* ── ECOUTEURS DE MESSAGES (Pour le Popup & Content) ─────────────── */
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === 'pomodoro_start') {
        const { mode, duration } = req;
        const startTime = Date.now();
        chrome.alarms.clear("pomodoroTimer", () => {
            chrome.alarms.create("pomodoroTimer", { when: startTime + duration });
            const state = {
                pomodoroActive: true,
                pomodoroMode: mode,
                pomodoroStartTime: startTime,
                pomodoroDuration: duration,
                pomodoroPaused: false,
                pomodoroPausedTimeLeft: 0
            };
            chrome.storage.local.set(state, () => {
                broadcastToTabs({ action: "pomodoro_update", state });
                sendResponse({ success: true, state });
            });
        });
        return true;
    }
    if (req.action === 'pomodoro_pause') {
        chrome.storage.local.get(['pomodoroStartTime', 'pomodoroDuration', 'pomodoroMode'], (res) => {
            chrome.alarms.clear("pomodoroTimer", () => {
                const elapsed = Date.now() - (res.pomodoroStartTime || Date.now());
                const timeLeft = Math.max(0, (res.pomodoroDuration || 0) - elapsed);
                const state = {
                    pomodoroActive: false,
                    pomodoroMode: res.pomodoroMode || 'work',
                    pomodoroStartTime: res.pomodoroStartTime || Date.now(),
                    pomodoroDuration: res.pomodoroDuration || 0,
                    pomodoroPaused: true,
                    pomodoroPausedTimeLeft: timeLeft
                };
                chrome.storage.local.set(state, () => {
                    broadcastToTabs({ action: "pomodoro_update", state });
                    sendResponse({ success: true, state });
                });
            });
        });
        return true;
    }
    if (req.action === 'pomodoro_resume') {
        chrome.storage.local.get(['pomodoroPausedTimeLeft', 'pomodoroMode'], (res) => {
            const timeLeft = res.pomodoroPausedTimeLeft || 0;
            const startTime = Date.now();
            chrome.alarms.clear("pomodoroTimer", () => {
                chrome.alarms.create("pomodoroTimer", { when: startTime + timeLeft });
                const state = {
                    pomodoroActive: true,
                    pomodoroMode: res.pomodoroMode || 'work',
                    pomodoroStartTime: startTime,
                    pomodoroDuration: timeLeft,
                    pomodoroPaused: false,
                    pomodoroPausedTimeLeft: 0
                };
                chrome.storage.local.set(state, () => {
                    broadcastToTabs({ action: "pomodoro_update", state });
                    sendResponse({ success: true, state });
                });
            });
        });
        return true;
    }
    if (req.action === 'pomodoro_reset') {
        chrome.alarms.clear("pomodoroTimer", () => {
            const state = {
                pomodoroActive: false,
                pomodoroMode: 'idle',
                pomodoroStartTime: 0,
                pomodoroDuration: 0,
                pomodoroPaused: false,
                pomodoroPausedTimeLeft: 0
            };
            chrome.storage.local.set(state, () => {
                broadcastToTabs({ action: "pomodoro_update", state });
                sendResponse({ success: true, state });
            });
        });
        return true;
    }
    if (req.action === 'force_cloud_sync') {
        syncToCloud().then(res => sendResponse({success: res}));
        return true;
    }
    if (req.action === 'force_cloud_recover') {
        recoverFromCloud().then(res => sendResponse({success: res}));
        return true;
    }
    if (req.action === 'trigger_download') {
        try {
            const base64 = btoa(unescape(encodeURIComponent(req.content)));
            chrome.downloads.download({
                url: "data:" + (req.mime || "application/octet-stream") + ";base64," + base64,
                filename: req.filename,
                saveAs: true
            }, () => {
                if (chrome.runtime.lastError) {
                    logger("Download failed:", chrome.runtime.lastError.message);
                }
            });
            sendResponse({success: true});
        } catch(e) {
            logger("Download exception:", e);
            sendResponse({success: false, error: e.message});
        }
        return true;
    }
});

chrome.contextMenus.onClicked.addListener(async (info) => {
    if (info.menuItemId === "blockVideoYTBP" && info.linkUrl) {
        try {
            const videoId = new URL(info.linkUrl).searchParams.get('v');
            if (videoId) {
                const prefix = await getProfilePrefix();
                const keys = [`${prefix}blockedVideos`, `${prefix}blockHistory`, `${prefix}watchStats`];
                chrome.storage.local.get(keys, async res => {
                    const list = res[`${prefix}blockedVideos`] || [];
                    let history = res[`${prefix}blockHistory`] || [];
                    let stats = res[`${prefix}watchStats`] || { totalTimeWatched:0, timeSaved:0, totalVideos:0, totalBlockedCount:0, channels:{}, dailyDated:{} };
                    
                    if (!list.some(v => decompressVideo(v).id === videoId)) {
                        list.push(`${videoId}|Bloquée via clic-droit|0|${Date.now()}`);
                        
                        history.push({
                            timestamp: Date.now(),
                            title: `Vidéo ${videoId}`,
                            type: 'video',
                            value: videoId,
                            reason: 'Menu Clic-Droit'
                        });
                        if (history.length > 150) history.shift();
                        
                        stats.totalBlockedCount = (stats.totalBlockedCount || 0) + 1;
                        
                        const saveObj = {};
                        saveObj[`${prefix}blockedVideos`] = list;
                        saveObj[`${prefix}blockHistory`] = history;
                        saveObj[`${prefix}watchStats`] = stats;
                        await safeStorage(chrome.storage.local.set.bind(chrome.storage.local), saveObj);
                        logger("Vidéo bloquée via menu:", videoId);
                    }
                });
            }
        } catch(e) { logger("Erreur menu contextuel", e); }
    }
});

chrome.commands.onCommand.addListener(cmd => {
    if (cmd === "block_current_video") {
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            if (tabs.length) chrome.tabs.sendMessage(tabs[0].id, { action: "shortcut_block" });
        });
    }
});

chrome.alarms.onAlarm.addListener(async alarm => {
    if (alarm.name === "pomodoroTimer") {
        const res = await safeStorage(chrome.storage.local.get.bind(chrome.storage.local), ['pomodoroMode', 'pomodoroDuration']);
        const currentMode = (res && res.pomodoroMode) || 'work';
        let nextMode = 'work';
        let nextDuration = 1500000; // 25 mins
        let nextTitle = '';
        let nextMsg = '';

        if (currentMode === 'work') {
            nextMode = 'break';
            nextDuration = 300000; // 5 mins break
            nextTitle = '☕ Pause Méritée !';
            nextMsg = 'Félicitations pour votre session de travail. Prenez une pause de 5 minutes !';
        } else {
            nextMode = 'work';
            nextDuration = 1500000; // 25 mins work
            nextTitle = '💼 Retour au Travail !';
            nextMsg = 'La pause est terminée. C\'est l\'heure de se concentrer !';
        }

        const newState = {
            pomodoroActive: true,
            pomodoroMode: nextMode,
            pomodoroStartTime: Date.now(),
            pomodoroDuration: nextDuration,
            pomodoroPaused: false,
            pomodoroPausedTimeLeft: 0
        };

        chrome.alarms.create("pomodoroTimer", { when: Date.now() + nextDuration });
        await safeStorage(chrome.storage.local.set.bind(chrome.storage.local), newState);

        chrome.notifications.create({
            type: 'basic', iconUrl: 'icon.png',
            title: nextTitle,
            message: nextMsg,
            requireInteraction: true
        });

        broadcastToTabs({ action: "pomodoro_update", state: newState });
        return;
    }
    if (alarm.name === "dailyRollingBackup") {
        await createDailyRollingBackup();
    }
    /* ── Backup PC hebdomadaire ─────────────────────────────────────── */
    if (alarm.name === "weeklyBackup") {
        const data = await safeStorage(chrome.storage.local.get.bind(chrome.storage.local), null);
        if (!data) return;
        try {
            const base64 = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
            chrome.downloads.download({
                url: "data:application/json;base64," + base64,
                filename: `YouTubeBlocker_AutoBackup_${new Date().toISOString().slice(0,10)}.json`,
                saveAs: false
            });
            chrome.notifications.create({
                type: 'basic', iconUrl: 'icon.png',
                title: '💾 Sauvegarde PC',
                message: 'Ton backup hebdomadaire a été téléchargé.'
            });
        } catch(e) { logger("Erreur backup PC", e); }
    }

    /* ── Sync Cloud automatique 5 min ───────────────────────────────── */
    if (alarm.name === "fiveMinCloudSync") {
        await syncToCloud();
    }

    /* ── Rapports ───────────────────────────────────────────────────── */
    if (alarm.name === "weeklyReport") {
        const prefix = await getProfilePrefix();
        const res = await safeStorage(chrome.storage.local.get.bind(chrome.storage.local), [`${prefix}watchStats`]);
        if (!res) return;
        const stats = res[`${prefix}watchStats`] || {};
        const h = Math.floor((stats.timeSaved || 0) / 3600);
        if (h > 0) {
            chrome.notifications.create({ type:'basic', iconUrl:'icon.png',
                title: '🏆 Bilan Hebdomadaire',
                message: `Super ! Tu as économisé ~${h}h de visionnage cette semaine.`
            });
        }
    }

    if (alarm.name === "dailySummary") {
        const prefix = await getProfilePrefix();
        const res = await safeStorage(chrome.storage.local.get.bind(chrome.storage.local), [`${prefix}watchStats`]);
        if (!res) return;
        const stats = res[`${prefix}watchStats`] || {};
        const today = new Date().toISOString().slice(0,10);
        const todaySecs = (stats.dailyDated || {})[today] || 0;
        const saved = stats.timeSaved || 0;
        const blocked = stats.totalBlockedCount || 0;
        if (todaySecs > 0 || blocked > 0) {
            chrome.notifications.create({
                type: 'basic', iconUrl: 'icon.png',
                title: '📊 Résumé du jour',
                message: `Aujourd'hui : ${Math.round(todaySecs/60)} min regardées · ${blocked} vidéos évitées au total · ${Math.round(saved/3600)}h économisées depuis le début.`
            });
        }
    }

    if (alarm.name === "monthlyReport") {
        const prefix = await getProfilePrefix();
        const res = await safeStorage(chrome.storage.local.get.bind(chrome.storage.local), [`${prefix}watchStats`]);
        if (!res) return;
        const stats = res[`${prefix}watchStats`] || {};
        const channels = stats.channels || {};
        const topCh = Object.entries(channels)
            .sort((a,b) => (b[1].time||0) - (a[1].time||0))
            .slice(0,3).map(([n])=>n).join(', ');
        const totalH = Math.round((stats.totalTimeWatched||0)/3600);
        const savedH = Math.round((stats.timeSaved||0)/3600);
        chrome.notifications.create({
            type: 'basic', iconUrl: 'icon.png',
            title: '📅 Rapport Mensuel',
            message: `Ce mois : ${totalH}h regardées, ${savedH}h économisées. Top chaînes : ${topCh || 'N/A'}. Ouvre le popup pour le rapport complet.`
        });
    }
});

// Nettoyer immédiatement les clés de sauvegarde obsolètes de chrome.storage.sync au démarrage du Service Worker
chrome.storage.sync.get(null, res => {
    if (chrome.runtime.lastError) return;
    const keysToRemove = Object.keys(res).filter(k => k.startsWith('backup_'));
    if (keysToRemove.length > 0) {
        chrome.storage.sync.remove(keysToRemove, () => {
            logger("Startup cleanup: removed obsolete Google Cloud backup chunks to free sync quota.");
        });
    }
});

// Initialiser la connexion WebSocket au démarrage
initWebSocket();