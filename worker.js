// worker.js - Statistics Calculation and Tracking Logic

// --- START: Include db.js content here if not using modules ---
// Or use: importScripts('db.js'); // If db.js is in the same directory
// (Copy-paste the content of db.js here for simplicity in this example)
const DB_NAME = 'SillyTavernUsageStatsDB';
const STORE_NAME = 'dailyStatsStore';
const DB_VERSION = 1;

let dbPromise = null;

function initDB() { /* ... db.js content ... */ }
async function getStats(dateString) { /* ... db.js content ... */ }
async function saveStats(dateString, statsData) { /* ... db.js content ... */ }
// --- END: Include db.js content ---


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
        console.log(`Worker: Initialized stats for ${entityType} ${entityName} (${entityId})`);
    }
     // Update name/type if it was missing or changed
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
    // console.log("Worker: User activity detected.");
    checkTimerState(); // Re-evaluate timer based on new activity

    // Set a timeout to mark as inactive
    setTimeout(() => {
        if (Date.now() - lastActivityTimestamp >= ACTIVITY_TIMEOUT_MS) {
            if (isUserActive) {
                 console.log("Worker: User inactive due to timeout.");
                 isUserActive = false;
                 checkTimerState(); // Stop timer if inactive
            }
        }
    }, ACTIVITY_TIMEOUT_MS + 100); // Check slightly after timeout
}

function startTimer() {
    if (activeTimerIntervalId) return; // Already running

    checkDate(); // Ensure we are tracking for the correct day

    activeTimerIntervalId = setInterval(() => {
        checkDate(); // Check date periodically

        const shouldTrack = currentEntityId && isTabVisible && isUserActive;
        if (shouldTrack) {
            const stats = ensureEntityStats(currentEntityId, null, currentEntityType); // Name might not be known here initially
            if (stats) {
                 stats.onlineTimeSeconds += TIMER_INTERVAL_MS / 1000;
                 // console.log(`Worker: Tracked ${TIMER_INTERVAL_MS / 1000}s for ${currentEntityId}. Total: ${stats.onlineTimeSeconds}`);
            }
        }

        // Also check for inactivity within the timer itself
        if (isUserActive && (Date.now() - lastActivityTimestamp >= ACTIVITY_TIMEOUT_MS)) {
             console.log("Worker: User inactive detected in timer.");
             isUserActive = false;
             checkTimerState(); // This will clear the interval
        }

    }, TIMER_INTERVAL_MS);
    console.log("Worker: Tracking timer started.");
}

function stopTimer() {
    if (activeTimerIntervalId) {
        clearInterval(activeTimerIntervalId);
        activeTimerIntervalId = null;
        console.log("Worker: Tracking timer stopped.");
        saveCurrentStats(); // Save stats when timer stops (e.g., chat change, inactive)
    }
}

function checkTimerState() {
    const shouldBeRunning = currentEntityId && isTabVisible && isUserActive;
    // console.log(`Worker: Check timer state - ShouldRun: ${shouldBeRunning}, CurrentID: ${currentEntityId}, Visible: ${isTabVisible}, Active: ${isUserActive}`);
    if (shouldBeRunning && !activeTimerIntervalId) {
        startTimer();
    } else if (!shouldBeRunning && activeTimerIntervalId) {
        stopTimer();
    }
}

async function saveCurrentStats() {
    try {
        // console.log("Worker: Attempting to save stats to IndexedDB for", currentDate);
        await saveStats(currentDate, dailyStats);
        // console.log("Worker: Stats saved successfully.");
    } catch (error) {
        console.error("Worker: Failed to save stats to IndexedDB:", error);
    }
}

function startSavingInterval() {
    if (saveDataIntervalId) return;
    saveDataIntervalId = setInterval(saveCurrentStats, SAVE_INTERVAL_MS);
    console.log("Worker: Periodic saving enabled.");
}

function stopSavingInterval() {
     if (saveDataIntervalId) {
        clearInterval(saveDataIntervalId);
        saveDataIntervalId = null;
        console.log("Worker: Periodic saving disabled.");
     }
}


async function loadInitialStats() {
    try {
        console.log("Worker: Loading initial stats for date:", currentDate);
        const loadedStats = await getStats(currentDate);
        if (loadedStats) {
            dailyStats = loadedStats;
            console.log("Worker: Loaded stats from IndexedDB:", dailyStats);
        } else {
            dailyStats = {};
            console.log("Worker: No stats found for today in IndexedDB. Starting fresh.");
        }
        // After loading, potentially send to main thread if requested at init
        postMessage({ type: 'statsUpdated', date: currentDate, stats: dailyStats });
    } catch (error) {
        console.error("Worker: Failed to load initial stats:", error);
        dailyStats = {}; // Ensure it's an empty object on error
    }
}

// --- Message Handling ---
self.onmessage = async (event) => {
    const { type, payload } = event.data;
    // console.log("Worker received message:", type, payload);

    switch (type) {
        case 'init':
            isTabVisible = payload.isTabVisible;
            await loadInitialStats();
            startSavingInterval();
            checkTimerState(); // Initial check
            break;

        case 'chatChanged':
            stopTimer(); // Stops timer and saves stats for the previous entity
            currentEntityId = payload.entityId;
            currentEntityType = payload.entityType;
            // Ensure stats object exists for the new entity, passing name/type
            ensureEntityStats(currentEntityId, payload.entityName, payload.entityType);
            isUserActive = true; // Assume active on chat change
            lastActivityTimestamp = Date.now();
            checkTimerState(); // Start timer if conditions met
            break;

        case 'visibilityChanged':
            isTabVisible = payload.isVisible;
            if (!isTabVisible) {
                 // If tab becomes hidden, force user inactive state until next activity
                 isUserActive = false;
                 console.log("Worker: Tab hidden, marking inactive.");
            } else {
                 // If tab becomes visible, check activity status again
                 updateUserActivity(); // Trigger an activity check
            }
            checkTimerState();
            if (!isTabVisible) {
                saveCurrentStats(); // Save immediately when tab is hidden
            }
            break;

        case 'userActivity':
            updateUserActivity();
            break;

        case 'messageSent': {
            checkDate();
            const stats = ensureEntityStats(payload.entityId, payload.entityName, payload.entityType);
            if (stats) {
                stats.msgSent += 1;
                // console.log(`Worker: Message sent recorded for ${payload.entityId}`);
            }
            break;
        }
        case 'messageReceived': {
             checkDate();
            const stats = ensureEntityStats(payload.entityId, payload.entityName, payload.entityType);
            if (stats) {
                stats.msgReceived += 1;
                // console.log(`Worker: Message received recorded for ${payload.entityId}`);
            }
            break;
        }
        case 'tokenCount': {
             checkDate();
            const stats = ensureEntityStats(payload.entityId, payload.entityName, payload.entityType);
            if (stats) {
                stats.tokensUsed += payload.count;
                 // console.log(`Worker: Tokens (${payload.count}) recorded for ${payload.entityId}. Total: ${stats.tokensUsed}`);
            }
            break;
        }
        case 'requestStats':
            checkDate();
            // Optionally reload from DB before sending? Or just send in-memory version?
            // Sending in-memory is faster, assuming it's reasonably up-to-date.
            // For manual refresh, maybe reload from DB first for absolute certainty.
            try {
                const reloadedStats = await getStats(payload.date); // Get specified date's stats
                postMessage({ type: 'statsUpdated', date: payload.date, stats: reloadedStats || {} });
            } catch (error) {
                 console.error("Worker: Error reloading stats for request:", error);
                 postMessage({ type: 'statsUpdated', date: payload.date, stats: (payload.date === currentDate ? dailyStats : {}) }); // Send in-memory or empty
            }

            break;

        case 'forceSave': // Could be triggered by main thread on beforeunload
            await saveCurrentStats();
            break;

        default:
            console.warn('Worker received unknown message type:', type);
    }
};

// Initial setup when worker starts
console.log("Worker started.");
// initDB(); // DB init is now lazy within the functions
