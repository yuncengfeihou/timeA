// index.js - Main Thread Logic for Usage Stats Plugin

// Import SillyTavern core functions - Adjust paths as needed!
import {
    saveSettingsDebounced, // We might not use this if IndexedDB is fully separate
    eventSource,
    event_types,
} from '../../../../script.js'; // Adjust path based on your SillyTavern structure

import {
    extension_settings,
    getContext,
    loadExtensionSettings,
    renderExtensionTemplateAsync
} from '../../../extensions.js';

import {
    getTokenCountAsync, // Crucial for token counting
} from '../../../tokenizers.js';

// We might not need Popups for this specific feature, but good to have if needed later
// import { Popup, POPUP_TYPE, callGenericPopup } from '../../../popup.js';

// Throttle function (simple implementation)
function throttle(func, limit) {
    let inThrottle;
    return function() {
        const args = arguments;
        const context = this;
        if (!inThrottle) {
            func.apply(context, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    }
}


(function () {
    const extensionName = "timeA"; // Match folder name if different
    const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`; // Adjust if needed
    let worker = null;
    let charactersCache = []; // Cache for character names
    let groupsCache = []; // Cache for group names

    // --- Helper Functions ---
    function log(message) {
        console.log(`[${extensionName}] ${message}`);
    }

    function getTodayDateStringForPicker() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // Format seconds into HH:MM:SS
    function formatTime(totalSeconds) {
        if (isNaN(totalSeconds) || totalSeconds < 0) {
            return '00:00:00';
        }
        totalSeconds = Math.floor(totalSeconds);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    // Get name from cache or context
    function getEntityName(entityId, entityType) {
        const context = getContext(); // Get fresh context
        if (!context) return entityId; // Fallback to ID if context unavailable

        if (entityType === 'character') {
            const character = context.characters?.find(char => char.avatar === entityId);
            return character ? character.name : (entityId || 'Unknown Character');
        } else if (entityType === 'group') {
            const group = context.groups?.find(grp => grp.id === entityId);
            return group ? group.name : (entityId || 'Unknown Group');
        }
        return entityId; // Fallback
    }


    // --- Worker Communication ---
    function initWorker() {
        if (worker) {
            log("Worker already initialized.");
            return;
        }
        try {
            // Adjust worker path if needed. Assumes worker.js is in the same folder as index.js
            worker = new Worker(`${extensionFolderPath}/worker.js`); // Use relative path from extension root

            worker.onmessage = (event) => {
                const { type, date, stats } = event.data;
                // log(`Main: Received message from worker: ${type}`);

                if (type === 'statsUpdated') {
                    log(`Main: Received updated stats for date: ${date}`);
                    // Only update the table if the displayed date matches
                    const selectedDate = $('#usage-stats-date-picker').val();
                     if (selectedDate === date) {
                        renderStatsTable(stats);
                     }
                }
            };

            worker.onerror = (error) => {
                console.error(`[${extensionName}] Worker error:`, error.message, error);
                toastr.error("每日统计 Worker 发生错误。请检查控制台。");
                worker = null; // Prevent further interaction
            };

            // Send initial state to worker
            worker.postMessage({
                type: 'init',
                payload: { isTabVisible: !document.hidden }
            });
            log("Worker initialized and initial state sent.");

        } catch (error) {
            console.error(`[${extensionName}] Failed to initialize worker:`, error);
            toastr.error("无法初始化每日统计 Worker。");
            worker = null;
        }
    }

    function sendMessageToWorker(type, payload) {
        if (!worker) {
            // log("Worker not available, message ignored:", type);
            return;
        }
        try {
             worker.postMessage({ type, payload });
        } catch (error) {
             console.error(`[${extensionName}] Error sending message to worker:`, error);
             // Maybe try to re-init worker? Or just notify user.
             toastr.error("与统计 Worker 通信失败。");
        }
    }

    // --- UI Rendering ---
    function renderStatsTable(statsData) {
        const tableBody = $('#usage-stats-table-body');
        if (!tableBody.length) return; // Exit if table not found

        tableBody.empty(); // Clear previous content

        if (!statsData || Object.keys(statsData).length === 0) {
            tableBody.append('<tr><td colspan="6">此日期无统计数据。</td></tr>');
            return;
        }

        // Get fresh context for names
        const context = getContext();
        charactersCache = context?.characters || [];
        groupsCache = context?.groups || [];

        // Sort by name for consistent display
        const sortedKeys = Object.keys(statsData).sort((a, b) => {
            const nameA = statsData[a].name || a;
            const nameB = statsData[b].name || b;
            return nameA.localeCompare(nameB);
        });


        sortedKeys.forEach(entityId => {
            const data = statsData[entityId];
            // Attempt to get the most current name, fallback to stored name, then ID
            const currentName = getEntityName(entityId, data.type) || data.name || entityId;

            const row = `
                <tr>
                    <td>${escapeHtml(currentName)}</td>
                    <td>${escapeHtml(data.type === 'character' ? '角色' : data.type === 'group' ? '群组' : '未知')}</td>
                    <td>${formatTime(data.onlineTimeSeconds || 0)}</td>
                    <td>${data.msgSent || 0}</td>
                    <td>${data.msgReceived || 0}</td>
                    <td>${data.tokensUsed || 0}</td>
                </tr>
            `;
            tableBody.append(row);
        });
         log("Stats table rendered.");
    }

    // --- Event Handlers ---
    function handleChatChanged() {
        if (!worker) return;
        const context = getContext();
        let entityId = null;
        let entityType = null;
        let entityName = null;

        if (context.groupId) {
            entityId = context.groupId;
            entityType = 'group';
            const group = context.groups?.find(g => g.id === entityId);
            entityName = group ? group.name : 'Unknown Group';
        } else if (context.characterId !== undefined && context.characters[context.characterId]) {
            // Use avatar filename as the unique ID for characters
            entityId = context.characters[context.characterId].avatar;
            entityType = 'character';
            entityName = context.characters[context.characterId].name;
        } else {
            // No specific chat selected (e.g., neutral chat, settings page)
            log("Chat changed to no specific entity.");
        }

        log(`Chat changed. ID: ${entityId}, Type: ${entityType}, Name: ${entityName}`);
        sendMessageToWorker('chatChanged', { entityId, entityType, entityName });
    }

    async function handleMessage(message, isSent) {
        if (!worker || !message) return;
        const context = getContext();
        let entityId = null;
        let entityType = null;
         let entityName = null; // Get name to pass to worker

        // Determine context (group or character) based on current state
         if (context.groupId) {
            entityId = context.groupId;
            entityType = 'group';
            const group = context.groups?.find(g => g.id === entityId);
            entityName = group ? group.name : 'Unknown Group';
        } else if (context.characterId !== undefined && context.characters[context.characterId]) {
            entityId = context.characters[context.characterId].avatar;
            entityType = 'character';
            entityName = context.characters[context.characterId].name;
        }

        if (!entityId) {
            // log("Message event ignored, no active chat entity.");
            return; // Ignore messages not tied to a specific character/group
        }

        // Send message event (sent/received)
        const messageEventType = isSent ? 'messageSent' : 'messageReceived';
        sendMessageToWorker(messageEventType, { entityId, entityName, entityType }); // Pass name/type

        // Calculate tokens (async) and send separately
        try {
            const tokenCount = await getTokenCountAsync(message.mes || '');
            sendMessageToWorker('tokenCount', { entityId, entityName, entityType, count: tokenCount }); // Pass name/type
        } catch (error) {
            console.error(`[${extensionName}] Error calculating token count:`, error);
        }
    }

    function handleVisibilityChange() {
         if (!worker) return;
         const isVisible = !document.hidden;
         log(`Visibility changed: ${isVisible ? 'Visible' : 'Hidden'}`);
         sendMessageToWorker('visibilityChanged', { isVisible });
    }

    // Throttle user activity updates to avoid flooding the worker
    const handleUserActivityThrottled = throttle(() => {
         // log("User activity detected (throttled)");
         sendMessageToWorker('userActivity', {});
    }, 5000); // Send activity update at most every 5 seconds

    function handleRefreshClick() {
         log("Refresh button clicked.");
         const selectedDate = $('#usage-stats-date-picker').val();
         if (selectedDate && worker) {
             $('#usage-stats-table-body').empty().append('<tr><td colspan="6">正在刷新数据...</td></tr>');
             sendMessageToWorker('requestStats', { date: selectedDate });
         } else if (!worker) {
              toastr.error("统计 Worker 未运行，无法刷新。");
         }
    }

     function handleDateChange() {
        log("Date picker changed.");
        handleRefreshClick(); // Refresh data for the newly selected date
    }

    // --- Setup ---
    function bindUIEvents() {
        // Make sure the elements exist before binding
        const container = $('.usage-stats-container');
        if (!container.length) {
            log("UI container not found, skipping UI event binding.");
            return;
        }
        container.on('click', '#usage-stats-refresh-button', handleRefreshClick);
        container.on('change', '#usage-stats-date-picker', handleDateChange);

        // User Activity Listeners (bound to document)
        $(document).on('mousemove keydown scroll', handleUserActivityThrottled);

        // Visibility Listener
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // SillyTavern Event Listeners
        eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
        eventSource.on(event_types.MESSAGE_SENT, (message) => handleMessage(message, true));
        eventSource.on(event_types.MESSAGE_RECEIVED, (_, message) => handleMessage(message, false)); // API gives null for first arg sometimes

         // Attempt to save stats when the window is about to close
         // Note: beforeunload is limited in what it can do reliably, especially async operations.
         // Worker's periodic saving is more reliable. This is just a fallback attempt.
         $(window).on('beforeunload', () => {
             if (worker) {
                 log("beforeunload triggered, attempting force save.");
                 // Note: This postMessage might not complete before the page unloads.
                 sendMessageToWorker('forceSave', {});
                 // Cannot guarantee save completion here.
             }
         });

        log("UI and Global events bound.");
    }

    // Utility to escape HTML to prevent XSS if names contain special chars
    function escapeHtml(unsafe) {
        if (typeof unsafe !== 'string') return unsafe;
        return unsafe
             .replace(/&/g, "&")
             .replace(/</g, "<")
             .replace(/>/g, ">")
             .replace(/"/g, '"')
             .replace(/'/g, "'");
     }

    // --- Plugin Entry Point ---
    jQuery(async () => {
        log("插件加载中...");
        try {
            const settingsHtml = await $.get(`${extensionFolderPath}/stats_table.html`);
            $("#extensions_settings").append(settingsHtml); // Append to the main settings area
             log("UI HTML loaded and appended.");

            // Set date picker to today initially
            $('#usage-stats-date-picker').val(getTodayDateStringForPicker());


            initWorker(); // Initialize the Web Worker
            bindUIEvents();

             // Initial data load for today
            if (worker) {
                // Wait a brief moment for the worker to potentially load initial data
                setTimeout(() => {
                     const todayDate = getTodayDateStringForPicker();
                     sendMessageToWorker('requestStats', { date: todayDate });
                }, 500); // Small delay to allow worker init/load
            } else {
                 $('#usage-stats-table-body').empty().append('<tr><td colspan="6">Worker 初始化失败，无法加载数据。</td></tr>');
            }


            log("插件 UI 和事件已绑定。");

        } catch (error) {
            console.error(`[${extensionName}] Error loading HTML or initializing:`, error);
            toastr.error("每日使用统计插件加载失败。");
        }
    });

})();
