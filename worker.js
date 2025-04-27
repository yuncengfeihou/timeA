// worker.js - Statistics Calculation and Tracking Logic

// --- OPTION 1: Use importScripts (Common for non-module workers) ---
try {
    importScripts('db.js'); // Assumes db.js is in the same directory
} catch (e) {
    console.error("Worker: Failed to import db.js. Make sure it's in the same directory.", e);
    // Define dummy functions to prevent errors later, or terminate worker?
    self.initDB = async () => { throw new Error("DB not loaded"); };
    self.getStats = async () => { throw new Error("DB not loaded"); };
    self.saveStats = async () => { throw new Error("DB not loaded"); };
}

// --- OPTION 2: Copy-paste db.js content here ---
// const DB_NAME = 'SillyTavernUsageStatsDB'; ... etc ...

// --- Worker State ---
let currentEntityId = null; // character avatar filename or group id
let currentEntityType = null; // 'character' or 'group'
let isTabVisible = true; // Assume visible initially
let isUserActive = true; // Assume active initially
let lastActivityTimestamp = Date.now();
let activeTimerIntervalId = null;
let saveDataIntervalId = null;
let dailyStats = {}; // In-memory stats for the current day { entityId: { name, type, onlineTimeSeconds, msgSent, msgReceived, tokensUsed } }
let currentDate = getTodayDateString();

const ACTIVITY_TIMEOUT_MS = 60 * 1000; // 1 minute of inactivity
const TIMER_INTERVAL_MS = 5 * 1000; // Check every 5 seconds
const SAVE_INTERVAL_MS = 30 * 1000; // Save every 30 seconds

// --- Helper Functions ---
function getTodayDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function ensureEntityStats(entityId, entityName, entityType) {
    if (!entityId) return null;
    if (!dailyStats[entityId]) {
        dailyStats[entityId] = {
            name: entityName || entityId, // Store name for convenience
            type: entityType || 'unknown',
            onlineTimeSeconds: 0,
            msgSent: 0,
            msgReceived: 0,
            tokensUsed: 0,
        };
        // console.log(`Worker: Initialized stats for ${entityType} ${entityName} (${entityId})`);
    }
    // Update name/type if it was missing or changed (important!)
    if (entityName && dailyStats[entityId].name !== entityName) dailyStats[entityId].name = entityName;
    if (entityType && dailyStats[entityId].type !== entityType) dailyStats[entityId].type = entityType;
    return dailyStats[entityId];
}

function checkDate() {
    const today = getTodayDateString();
    if (today !== currentDate) {
        console.log(`Worker: Date changed from ${currentDate} to ${today}. Resetting daily stats.`);
        saveCurrentStats(); // Save previous day's stats before clearing
        currentDate = today;
        dailyStats = {};
        loadInitialStats(); // Load stats for the new day (likely empty)
    }
}

// --- Core Logic ---
function updateUserActivity() {
    isUserActive = true;
    lastActivityTimestamp = Date.now();
    checkTimerState();

    // Set a timeout to mark as inactive
    setTimeout(() => {
        if (Date.now() - lastActivityTimestamp >= ACTIVITY_TIMEOUT_MS) {
            if (isUserActive) {
                // console.log("Worker: User inactive due to timeout.");
                isUserActive = false;
                checkTimerState();
            }
        }
    }, ACTIVITY_TIMEOUT_MS + 100);
}

function startTimer() {
    if (activeTimerIntervalId) return;

    checkDate();

    activeTimerIntervalId = setInterval(() => {
        checkDate();

        const shouldTrack = currentEntityId && isTabVisible && isUserActive;
        if (shouldTrack) {
            // Pass current name/type when ensuring stats, in case it changed
            const currentStats = ensureEntityStats(currentEntityId, null, currentEntityType); // Rely on ensureEntityStats to update if needed later
            if (currentStats) {
                currentStats.onlineTimeSeconds += TIMER_INTERVAL_MS / 1000;
            }
        }

        if (isUserActive && (Date.now() - lastActivityTimestamp >= ACTIVITY_TIMEOUT_MS)) {
            // console.log("Worker: User inactive detected in timer.");
            isUserActive = false;
            checkTimerState();
        }

    }, TIMER_INTERVAL_MS);
    // console.log("Worker: Tracking timer started.");
}

function stopTimer() {
    if (activeTimerIntervalId) {
        clearInterval(activeTimerIntervalId);
        activeTimerIntervalId = null;
        // console.log("Worker: Tracking timer stopped.");
        saveCurrentStats(); // Save stats when timer stops
    }
}

function checkTimerState() {
    const shouldBeRunning = currentEntityId && isTabVisible && isUserActive;
    if (shouldBeRunning && !activeTimerIntervalId) {
        startTimer();
    } else if (!shouldBeRunning && activeTimerIntervalId) {
        stopTimer();
    }
}

async function saveCurrentStats() {
    try {
        // Use the globally available saveStats function (from db.js)
        await saveStats(currentDate, dailyStats);
    } catch (error) {
        console.error("Worker: Failed to save stats to IndexedDB:", error);
    }
}

function startSavingInterval() {
    if (saveDataIntervalId) return;
    saveDataIntervalId = setInterval(saveCurrentStats, SAVE_INTERVAL_MS);
    // console.log("Worker: Periodic saving enabled.");
}

function stopSavingInterval() {
     if (saveDataIntervalId) {
        clearInterval(saveDataIntervalId);
        saveDataIntervalId = null;
        // console.log("Worker: Periodic saving disabled.");
     }
}

async function loadInitialStats() {
    try {
        // console.log("Worker: Loading initial stats for date:", currentDate);
        // Use the globally available getStats function (from db.js)
        const loadedStats = await getStats(currentDate);
        if (loadedStats) {
            dailyStats = loadedStats;
            // console.log("Worker: Loaded stats from IndexedDB:", dailyStats);
        } else {
            dailyStats = {};
            // console.log("Worker: No stats found for today in IndexedDB. Starting fresh.");
        }
        postMessage({ type: 'statsUpdated', date: currentDate, stats: dailyStats });
    } catch (error) {
        console.error("Worker: Failed to load initial stats:", error);
        dailyStats = {};
    }
}

// --- Message Handling ---
self.onmessage = async (event) => {
    const { type, payload } = event.data;

    switch (type) {
        case 'init':
            isTabVisible = payload.isTabVisible;
            await loadInitialStats(); // Load before starting intervals
            startSavingInterval();
            checkTimerState();
            break;

        case 'chatChanged':
            stopTimer();
            currentEntityId = payload.entityId;
            currentEntityType = payload.entityType;
            // Ensure stats object exists for the new entity, providing name/type
            ensureEntityStats(currentEntityId, payload.entityName, payload.entityType);
            isUserActive = true; // Assume active on chat change
            lastActivityTimestamp = Date.now();
            checkTimerState();
            break;

        case 'visibilityChanged':
            isTabVisible = payload.isVisible;
            if (!isTabVisible) {
                 isUserActive = false; // Force inactive on hide
            } else {
                 updateUserActivity(); // Check activity on visible
            }
            checkTimerState();
            if (!isTabVisible) {
                saveCurrentStats(); // Save immediately when tab is hidden
            }
            break;

        case 'userActivity':
            updateUserActivity();
            break;

        case 'messageSent':
        case 'messageReceived':
        case 'tokenCount': {
            checkDate();
            // Ensure stats object exists, updating name/type if provided
            const stats = ensureEntityStats(payload.entityId, payload.entityName, payload.entityType);
            if (stats) {
                 if (type === 'messageSent') stats.msgSent += 1;
                 else if (type === 'messageReceived') stats.msgReceived += 1;
                 else if (type === 'tokenCount') stats.tokensUsed += payload.count;
            }
            break;
        }

        case 'requestStats':
            checkDate();
            try {
                // Use the globally available getStats function (from db.js)
                const reloadedStats = await getStats(payload.date);
                postMessage({ type: 'statsUpdated', date: payload.date, stats: reloadedStats || {} });
            } catch (error) {
                 console.error("Worker: Error reloading stats for request:", error);
                 postMessage({ type: 'statsUpdated', date: payload.date, stats: (payload.date === currentDate ? dailyStats : {}) });
            }
            break;

        case 'forceSave':
            await saveCurrentStats();
            break;

        default:
            console.warn('Worker received unknown message type:', type);
    }
};

// Initial setup when worker starts
// console.log("Worker started."); // Less console noise
