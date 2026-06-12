const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const SAVE_DIR = path.join(__dirname, 'sauvegarde');
const COMPTE_DIR = path.join(SAVE_DIR, 'compte');
const LISTE_DIR = path.join(SAVE_DIR, 'liste');
const PARAM_DIR = path.join(SAVE_DIR, 'parametre');
const STAT_DIR = path.join(SAVE_DIR, 'stat');
const PUBLIC_DIR = path.join(SAVE_DIR, 'public');
const PUBLIC_STATS_DIR = path.join(SAVE_DIR, 'public_stats');
const PUBLIC_PARAM_DIR = path.join(SAVE_DIR, 'public_param');

// S'assurer que les répertoires de stockage existent
[COMPTE_DIR, LISTE_DIR, PARAM_DIR, STAT_DIR, PUBLIC_DIR, PUBLIC_STATS_DIR, PUBLIC_PARAM_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Helper: Sécurisation des noms de fichiers pour éviter la traversée de répertoires
const getSafeFilename = (email) => {
    if (!email) return null;
    return email.toLowerCase().trim().replace(/[^a-z0-9]/g, '_') + '.json';
};

// Helper: Authentification utilisateur (définie en haut pour hissage propre)
function verifyUser(email, passwordHash) {
    if (!email || !passwordHash) return false;
    const filename = getSafeFilename(email);
    const filepath = path.join(COMPTE_DIR, filename);
    if (!fs.existsSync(filepath)) return false;
    try {
        const userData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        return userData.passwordHash === passwordHash;
    } catch(e) {
        return false;
    }
}

// 1. Enregistrement (POST /api/register)
app.post('/api/register', (req, res) => {
    const { email, name, passwordHash } = req.body;
    if (!email || !name || !passwordHash) {
        return res.status(400).json({ success: false, error: 'Champs requis manquants.' });
    }
    const filename = getSafeFilename(email);
    const filepath = path.join(COMPTE_DIR, filename);
    if (fs.existsSync(filepath)) {
        return res.status(400).json({ success: false, error: 'Ce compte existe déjà.' });
    }
    const userData = { email: email.toLowerCase().trim(), name, passwordHash, created_at: Date.now() };
    fs.writeFileSync(filepath, JSON.stringify(userData, null, 2));
    res.json({ success: true, message: 'Compte créé avec succès.' });
});

// 2. Connexion (POST /api/login)
app.post('/api/login', (req, res) => {
    const { email, passwordHash } = req.body;
    if (!email || !passwordHash) {
        return res.status(400).json({ success: false, error: 'Champs requis manquants.' });
    }
    const filename = getSafeFilename(email);
    const filepath = path.join(COMPTE_DIR, filename);
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ success: false, error: 'Compte introuvable.' });
    }
    try {
        const userData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        if (userData.passwordHash === passwordHash) {
            return res.json({ success: true, name: userData.name });
        } else {
            return res.status(401).json({ success: false, error: 'Mot de passe incorrect.' });
        }
    } catch(e) {
        return res.status(500).json({ success: false, error: 'Erreur de lecture du compte.' });
    }
});

// 3. Sauvegarder un backup (POST /api/backup)
app.post('/api/backup', (req, res) => {
    const { email, passwordHash, lists, stats, params } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, error: 'E-mail requis.' });
    }
    if (!verifyUser(email, passwordHash)) {
        return res.status(401).json({ success: false, error: 'Authentification échouée.' });
    }
    const filename = getSafeFilename(email);

    // Sauvegarde des listes
    if (lists && lists.payload) {
        fs.writeFileSync(path.join(LISTE_DIR, filename), JSON.stringify(lists, null, 2));
    }
    // Sauvegarde des stats
    if (stats && stats.payload) {
        fs.writeFileSync(path.join(STAT_DIR, filename), JSON.stringify(stats, null, 2));
    }
    // Sauvegarde des paramètres
    if (params && params.payload) {
        fs.writeFileSync(path.join(PARAM_DIR, filename), JSON.stringify(params, null, 2));
    }

    res.json({ success: true, message: 'Sauvegardes synchronisées sur le disque du VPS.' });
});

// 4. Récupérer un backup (GET /api/backup)
app.get('/api/backup', (req, res) => {
    const email = req.query.email;
    const passwordHash = req.query.passwordHash;
    if (!email) {
        return res.status(400).json({ success: false, error: 'E-mail requis.' });
    }
    if (!verifyUser(email, passwordHash)) {
        return res.status(401).json({ success: false, error: 'Authentification échouée.' });
    }
    const filename = getSafeFilename(email);

    const listsPath = path.join(LISTE_DIR, filename);
    const statsPath = path.join(STAT_DIR, filename);
    const paramsPath = path.join(PARAM_DIR, filename);

    const responseData = { success: true };

    if (fs.existsSync(listsPath)) {
        responseData.lists = JSON.parse(fs.readFileSync(listsPath, 'utf8'));
    }
    if (fs.existsSync(statsPath)) {
        responseData.stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    }
    if (fs.existsSync(paramsPath)) {
        responseData.params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
    }

    if (!responseData.lists && !responseData.stats && !responseData.params) {
        return res.status(404).json({ success: false, error: 'Aucune sauvegarde trouvée.' });
    }

    res.json(responseData);
});

// 5. Supprimer un backup (DELETE /api/backup)
app.delete('/api/backup', (req, res) => {
    const email = req.query.email;
    const passwordHash = req.query.passwordHash;
    if (!email) {
        return res.status(400).json({ success: false, error: 'E-mail requis.' });
    }
    if (!verifyUser(email, passwordHash)) {
        return res.status(401).json({ success: false, error: 'Authentification échouée.' });
    }
    const filename = getSafeFilename(email);

    const filepaths = [
        path.join(COMPTE_DIR, filename),
        path.join(LISTE_DIR, filename),
        path.join(PARAM_DIR, filename),
        path.join(STAT_DIR, filename),
        path.join(PUBLIC_DIR, filename), // Supprime aussi la liste publique s'il y en a une
        path.join(PUBLIC_STATS_DIR, filename), // Supprime aussi les statistiques partagées
        path.join(PUBLIC_PARAM_DIR, filename) // Supprime aussi les réglages partagés
    ];

    filepaths.forEach(fp => {
        if (fs.existsSync(fp)) {
            fs.unlinkSync(fp);
        }
    });

    res.json({ success: true, message: 'Toutes les données associées ont été purgées du VPS.' });
});

// 6. Publier sa liste à la communauté (POST /api/community/publish)
app.post('/api/community/publish', (req, res) => {
    const { email, passwordHash, name, description, blockedVideos, blockedChannels, hoursSaved } = req.body;
    if (!verifyUser(email, passwordHash)) {
        return res.status(401).json({ success: false, error: 'Authentification échouée.' });
    }

    const filename = getSafeFilename(email);
    const filepath = path.join(PUBLIC_DIR, filename);

    let likes = [];
    let dislikes = [];

    // Conserver les votes existants si la liste est republiée/mise à jour
    if (fs.existsSync(filepath)) {
        try {
            const oldData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
            likes = oldData.likes || [];
            dislikes = oldData.dislikes || [];
        } catch(e) {}
    }

    const publicData = {
        email: email.toLowerCase().trim(),
        creatorName: name || email.split('@')[0],
        description: description || '',
        blockedVideos: blockedVideos || [],
        blockedChannels: blockedChannels || [],
        videoCount: (blockedVideos || []).length + (blockedChannels || []).length,
        hoursSaved: hoursSaved || 0,
        likes,
        dislikes,
        updated_at: Date.now()
    };

    try {
        fs.writeFileSync(filepath, JSON.stringify(publicData, null, 2));
        res.json({ success: true, message: 'Liste publiée avec succès dans le hub communautaire.' });
    } catch(e) {
        console.error("Erreur de publication (écriture) :", e);
        res.status(500).json({ success: false, error: 'Erreur d\'écriture sur le serveur : ' + e.message });
    }
});

// 7. Obtenir toutes les listes de la communauté (GET /api/community/lists)
app.get('/api/community/lists', (req, res) => {
    try {
        const files = fs.readdirSync(PUBLIC_DIR);
        const publicLists = [];
        files.forEach(file => {
            if (file.endsWith('.json')) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'));
                    publicLists.push(data);
                } catch(e) {}
            }
        });
        res.json({ success: true, lists: publicLists });
    } catch(e) {
        console.error("Erreur de lecture des listes :", e);
        res.status(500).json({ success: false, error: 'Erreur lors de la lecture des listes : ' + e.message });
    }
});

// 8. Voter pour une liste (POST /api/community/vote)
app.post('/api/community/vote', (req, res) => {
    const { email, passwordHash, targetEmail, voteType } = req.body;
    if (!verifyUser(email, passwordHash)) {
        return res.status(401).json({ success: false, error: 'Authentification échouée.' });
    }
    if (!targetEmail || !['like', 'dislike'].includes(voteType)) {
        return res.status(400).json({ success: false, error: 'Paramètres invalides.' });
    }

    const filename = getSafeFilename(targetEmail);
    const filepath = path.join(PUBLIC_DIR, filename);

    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ success: false, error: 'Liste cible introuvable.' });
    }

    try {
        const targetData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        const voter = email.toLowerCase().trim();

        let likes = targetData.likes || [];
        let dislikes = targetData.dislikes || [];

        if (voteType === 'like') {
            if (likes.includes(voter)) {
                likes = likes.filter(v => v !== voter); // Retirer le like
            } else {
                likes.push(voter);
                dislikes = dislikes.filter(v => v !== voter); // Retirer des dislikes si présent
            }
        } else if (voteType === 'dislike') {
            if (dislikes.includes(voter)) {
                dislikes = dislikes.filter(v => v !== voter); // Retirer le dislike
            } else {
                dislikes.push(voter);
                likes = likes.filter(v => v !== voter); // Retirer des likes si présent
            }
        }

        targetData.likes = likes;
        targetData.dislikes = dislikes;

        fs.writeFileSync(filepath, JSON.stringify(targetData, null, 2));
        res.json({
            success: true,
            likesCount: likes.length,
            dislikesCount: dislikes.length,
            likes,
            dislikes
        });
    } catch(e) {
        console.error("Erreur de traitement du vote :", e);
        res.status(500).json({ success: false, error: 'Erreur lors du traitement du vote : ' + e.message });
    }
});

// 9. Publier ses statistiques à la communauté (POST /api/community/publish-stats)
app.post('/api/community/publish-stats', (req, res) => {
    const { email, passwordHash, name, description, statsPayload } = req.body;
    if (!verifyUser(email, passwordHash)) {
        return res.status(401).json({ success: false, error: 'Authentification échouée.' });
    }

    const filename = getSafeFilename(email);
    const filepath = path.join(PUBLIC_STATS_DIR, filename);

    let likes = [];
    let dislikes = [];

    if (fs.existsSync(filepath)) {
        try {
            const oldData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
            likes = oldData.likes || [];
            dislikes = oldData.dislikes || [];
        } catch(e) {}
    }

    const publicStatsData = {
        email: email.toLowerCase().trim(),
        creatorName: name || email.split('@')[0],
        description: description || '',
        statsPayload: statsPayload || {},
        likes,
        dislikes,
        updated_at: Date.now()
    };

    try {
        fs.writeFileSync(filepath, JSON.stringify(publicStatsData, null, 2));
        res.json({ success: true, message: 'Statistiques partagées avec succès dans le hub.' });
    } catch(e) {
        console.error("Erreur de publication des stats (écriture) :", e);
        res.status(500).json({ success: false, error: 'Erreur d\'écriture sur le serveur : ' + e.message });
    }
});

// 10. Obtenir toutes les statistiques partagées (GET /api/community/stats)
app.get('/api/community/stats', (req, res) => {
    try {
        const files = fs.readdirSync(PUBLIC_STATS_DIR);
        const publicStats = [];
        files.forEach(file => {
            if (file.endsWith('.json')) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(PUBLIC_STATS_DIR, file), 'utf8'));
                    publicStats.push(data);
                } catch(e) {}
            }
        });
        res.json({ success: true, stats: publicStats });
    } catch(e) {
        console.error("Erreur de lecture des stats publiques :", e);
        res.status(500).json({ success: false, error: 'Erreur lors de la lecture des statistiques : ' + e.message });
    }
});

// 11. Voter pour des statistiques (POST /api/community/vote-stats)
app.post('/api/community/vote-stats', (req, res) => {
    const { email, passwordHash, targetEmail, voteType } = req.body;
    if (!verifyUser(email, passwordHash)) {
        return res.status(401).json({ success: false, error: 'Authentification échouée.' });
    }
    if (!targetEmail || !['like', 'dislike'].includes(voteType)) {
        return res.status(400).json({ success: false, error: 'Paramètres invalides.' });
    }

    const filename = getSafeFilename(targetEmail);
    const filepath = path.join(PUBLIC_STATS_DIR, filename);

    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ success: false, error: 'Statistiques cibles introuvables.' });
    }

    try {
        const targetData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        const voter = email.toLowerCase().trim();

        let likes = targetData.likes || [];
        let dislikes = targetData.dislikes || [];

        if (voteType === 'like') {
            if (likes.includes(voter)) {
                likes = likes.filter(v => v !== voter);
            } else {
                likes.push(voter);
                dislikes = dislikes.filter(v => v !== voter);
            }
        } else if (voteType === 'dislike') {
            if (dislikes.includes(voter)) {
                dislikes = dislikes.filter(v => v !== voter);
            } else {
                dislikes.push(voter);
                likes = likes.filter(v => v !== voter);
            }
        }

        targetData.likes = likes;
        targetData.dislikes = dislikes;

        fs.writeFileSync(filepath, JSON.stringify(targetData, null, 2));
        res.json({
            success: true,
            likesCount: likes.length,
            dislikesCount: dislikes.length,
            likes,
            dislikes
        });
    } catch(e) {
        console.error("Erreur de traitement du vote de stats :", e);
        res.status(500).json({ success: false, error: 'Erreur lors du traitement du vote : ' + e.message });
    }
});

// 12. Publier ses réglages/paramètres à la communauté (POST /api/community/publish-params)
app.post('/api/community/publish-params', (req, res) => {
    const { email, passwordHash, name, description, paramsPayload } = req.body;
    if (!verifyUser(email, passwordHash)) {
        return res.status(401).json({ success: false, error: 'Authentification échouée.' });
    }

    const filename = getSafeFilename(email);
    const filepath = path.join(PUBLIC_PARAM_DIR, filename);

    let likes = [];
    let dislikes = [];

    if (fs.existsSync(filepath)) {
        try {
            const oldData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
            likes = oldData.likes || [];
            dislikes = oldData.dislikes || [];
        } catch(e) {}
    }

    const publicParamsData = {
        email: email.toLowerCase().trim(),
        creatorName: name || email.split('@')[0],
        description: description || '',
        paramsPayload: paramsPayload || {},
        likes,
        dislikes,
        updated_at: Date.now()
    };

    try {
        fs.writeFileSync(filepath, JSON.stringify(publicParamsData, null, 2));
        res.json({ success: true, message: 'Réglages partagés avec succès dans le hub.' });
    } catch(e) {
        console.error("Erreur de publication des réglages (écriture) :", e);
        res.status(500).json({ success: false, error: 'Erreur d\'écriture sur le serveur : ' + e.message });
    }
});

// 13. Obtenir tous les réglages partagés (GET /api/community/params)
app.get('/api/community/params', (req, res) => {
    try {
        const files = fs.readdirSync(PUBLIC_PARAM_DIR);
        const publicParams = [];
        files.forEach(file => {
            if (file.endsWith('.json')) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(PUBLIC_PARAM_DIR, file), 'utf8'));
                    publicParams.push(data);
                } catch(e) {}
            }
        });
        res.json({ success: true, params: publicParams });
    } catch(e) {
        console.error("Erreur de lecture des réglages publics :", e);
        res.status(500).json({ success: false, error: 'Erreur lors de la lecture des réglages : ' + e.message });
    }
});

// 14. Voter pour des réglages (POST /api/community/vote-params)
app.post('/api/community/vote-params', (req, res) => {
    const { email, passwordHash, targetEmail, voteType } = req.body;
    if (!verifyUser(email, passwordHash)) {
        return res.status(401).json({ success: false, error: 'Authentification échouée.' });
    }
    if (!targetEmail || !['like', 'dislike'].includes(voteType)) {
        return res.status(400).json({ success: false, error: 'Paramètres invalides.' });
    }

    const filename = getSafeFilename(targetEmail);
    const filepath = path.join(PUBLIC_PARAM_DIR, filename);

    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ success: false, error: 'Réglages cibles introuvables.' });
    }

    try {
        const targetData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        const voter = email.toLowerCase().trim();

        let likes = targetData.likes || [];
        let dislikes = targetData.dislikes || [];

        if (voteType === 'like') {
            if (likes.includes(voter)) {
                likes = likes.filter(v => v !== voter);
            } else {
                likes.push(voter);
                dislikes = dislikes.filter(v => v !== voter);
            }
        } else if (voteType === 'dislike') {
            if (dislikes.includes(voter)) {
                dislikes = dislikes.filter(v => v !== voter);
            } else {
                dislikes.push(voter);
                likes = likes.filter(v => v !== voter);
            }
        }

        targetData.likes = likes;
        targetData.dislikes = dislikes;

        fs.writeFileSync(filepath, JSON.stringify(targetData, null, 2));
        res.json({
            success: true,
            likesCount: likes.length,
            dislikesCount: dislikes.length,
            likes,
            dislikes
        });
    } catch(e) {
        console.error("Erreur de traitement du vote de réglages :", e);
        res.status(500).json({ success: false, error: 'Erreur lors du traitement du vote : ' + e.message });
    }
});

// Stockage des connexions actives par e-mail
const activeConnections = new Map();

wss.on('connection', (ws) => {
    let userEmail = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'auth') {
                const { email, passwordHash } = data;
                if (verifyUser(email, passwordHash)) {
                    userEmail = email.toLowerCase().trim();
                    if (!activeConnections.has(userEmail)) {
                        activeConnections.set(userEmail, new Set());
                    }
                    activeConnections.get(userEmail).add(ws);
                    ws.send(JSON.stringify({ type: 'auth_success' }));
                } else {
                    ws.send(JSON.stringify({ type: 'auth_error', error: 'Authentification échouée.' }));
                    ws.close();
                }
            } else if (data.type === 'sync_update') {
                if (!userEmail) return;
                const sockets = activeConnections.get(userEmail);
                if (sockets) {
                    const reloadMsg = JSON.stringify({ type: 'reload_request', source: data.source || '' });
                    sockets.forEach((s) => {
                        if (s !== ws && s.readyState === WebSocket.OPEN) {
                            s.send(reloadMsg);
                        }
                    });
                }
            }
        } catch (e) {
            console.error('Erreur traitement message WebSocket:', e);
        }
    });

    ws.on('close', () => {
        if (userEmail && activeConnections.has(userEmail)) {
            const sockets = activeConnections.get(userEmail);
            sockets.delete(ws);
            if (sockets.size === 0) {
                activeConnections.delete(userEmail);
            }
        }
    });
});

// Gérer l'upgrade HTTP vers WebSocket
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

server.listen(PORT, () => {
    console.log(`Serveur VPS actif sur le port ${PORT}`);
});
