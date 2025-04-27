// db.js - IndexedDB Helper (can be imported or included in worker)
const DB_NAME = 'SillyTavernUsageStatsDB';
const STORE_NAME = 'dailyStatsStore';
const DB_VERSION = 1;

let dbPromise = null;

function initDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error('IndexedDB error:', request.error);
            reject('IndexedDB error: ' + request.error);
        };

        request.onsuccess = (event) => {
            // console.log('IndexedDB initialized successfully.'); // Less console noise
            resolve(event.target.result);
        };

        request.onupgradeneeded = (event) => {
            console.log('Upgrading IndexedDB...');
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                // Key is the date string 'YYYY-MM-DD'
                // Store objects like: { date: 'YYYY-MM-DD', stats: { entityId1: {...}, ... } }
                db.createObjectStore(STORE_NAME, { keyPath: 'date' });
                console.log(`Object store "${STORE_NAME}" created.`);
            }
        };
    });
    return dbPromise;
}

async function getStats(dateString) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(dateString);

        request.onerror = (event) => {
            console.error('Error fetching stats:', request.error);
            reject('Error fetching stats: ' + request.error);
        };

        request.onsuccess = (event) => {
            resolve(request.result ? request.result.stats : null); // Return only the stats part or null
        };
    });
}

async function saveStats(dateString, statsData) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const dataToSave = { date: dateString, stats: statsData };
        const request = store.put(dataToSave); // put = insert or update

        request.onerror = (event) => {
            console.error('Error saving stats:', request.error);
            reject('Error saving stats: ' + request.error);
        };

        request.onsuccess = (event) => {
            // console.log('Stats saved successfully for date:', dateString); // Less console noise
            resolve(event.target.result);
        };
    });
}

// For non-module workers, these functions are global after importScripts or copy-paste.
// If using Module Workers: export { initDB, getStats, saveStats };
