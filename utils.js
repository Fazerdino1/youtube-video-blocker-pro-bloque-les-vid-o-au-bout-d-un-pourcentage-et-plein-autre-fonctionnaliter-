/* global chrome */
const _DEBUG = () => {
    try { return localStorage.getItem('ytbpDebug') === '1'; } catch(_) { return false; }
};
const logger = (...args) => { if (_DEBUG()) console.log('🛡️ [YTBP]', ...args); };

const compressVideo = (v) => {
    if (typeof v === 'string' && v.includes('|')) return v;
    const safeTitle = (v.title || "Inconnu").replace(/\|/g, '-');
    return `${v.id}|${safeTitle}|${v.durationSec || 0}|${v.timestamp || Date.now()}`;
};

const decompressVideo = (str) => {
    if (typeof str === 'object' && str !== null) return { ...str, duration: formatTimeFromSecs(str.durationSec || 0) };
    if (typeof str !== 'string' || !str.includes('|')) return { id: str, title: "Inconnu", durationSec: 0, timestamp: 0, duration: "--:--" };
    const [id, title, dur, ts] = str.split('|');
    return { id, title, durationSec: parseInt(dur), timestamp: parseInt(ts), duration: formatTimeFromSecs(parseInt(dur)) };
};

const formatTimeFromSecs = (sec) => {
    if (!sec || isNaN(sec)) return "0:00";
    return `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2, '0')}`;
};

const formatTime = (sec) => {
    if (!sec || isNaN(sec)) return "0h 0m";
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
};

const getCurrentDay = () => new Date().toLocaleDateString('fr-FR', { weekday: 'short' });

async function getCryptoKey(hashHex) {
    if (!hashHex) throw new Error("No crypt key provided");
    const rawKey = new Uint8Array(hashHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    return await crypto.subtle.importKey(
        "raw",
        rawKey,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"]
    );
}

async function encryptPayload(plaintext, cryptKeyHex) {
    try {
        const key = await getCryptoKey(cryptKeyHex);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(plaintext);
        const ciphertext = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            key,
            encoded
        );
        const combined = new Uint8Array(iv.length + ciphertext.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(ciphertext), iv.length);
        
        let binary = '';
        const len = combined.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(combined[i]);
        }
        return btoa(binary);
    } catch(e) {
        logger("Encryption error:", e);
        throw e;
    }
}

async function decryptPayload(base64Ciphertext, cryptKeyHex) {
    try {
        const key = await getCryptoKey(cryptKeyHex);
        const binaryString = atob(base64Ciphertext);
        const len = binaryString.length;
        const combined = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            combined[i] = binaryString.charCodeAt(i);
        }
        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            key,
            ciphertext
        );
        return new TextDecoder().decode(decrypted);
    } catch(e) {
        logger("Decryption error:", e);
        throw e;
    }
}

Object.assign(globalThis, { compressVideo, decompressVideo, formatTimeFromSecs, formatTime, getCurrentDay, logger, encryptPayload, decryptPayload });