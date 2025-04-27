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
            console.log('IndexedDB initialized successfully.');
            resolve(event.target.result);
        };

        request.onupgradeneeded = (event) => {
            console.log('Upgrading IndexedDB...');
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                // Key is the date string 'YYYY-MM-DD'
                db.createObjectStore(STORE_NAME, { keyPath: 'date' });
                console.log(`Object store "${STORE_NAME}" created.`);
            }
            // Add indexes here if needed in the future
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
            // request.result will be the object { date: 'YYYY-MM-DD', stats: {...} } or undefined
            resolve(request.result ? request.result.stats : null);
        };
    });
}

async function saveStats(dateString, statsData) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        // Data structure to store: { date: 'YYYY-MM-DD', stats: { entityId1: {...}, entityId2: {...} } }
        const dataToSave = { date: dateString, stats: statsData };
        const request = store.put(dataToSave); // put = insert or update

        request.onerror = (event) => {
            console.error('Error saving stats:', request.error);
            reject('Error saving stats: ' + request.error);
        };

        request.onsuccess = (event) => {
            // console.log('Stats saved successfully for date:', dateString);
            resolve(event.target.result);
        };
    });
}

// Export functions if using modules, otherwise they are globally available
// after importScripts in the worker, or copy-paste the content.
// export { initDB, getStats, saveStats }; // For module usage
