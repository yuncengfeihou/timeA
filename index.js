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

// Utility to escape HTML
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return unsafe;
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#39;");
 }

(function () {
    // --- Plugin Setup ---
    const pluginName = "timeA"; // Unified name
    const timerSettingsKey = "usage-tracker2"; // Keep original key for timer settings compatibility
    const extensionFolderPath = `scripts/extensions/third-party/${pluginName}`; // Adjust if folder name differs
    const pluginLogPrefix = `[${pluginName}]`;

    function log(message) {
        console.log(`${pluginLogPrefix} ${message}`);
    }

    // --- Timer Feature State & Config ---
    const LS_SESSION_START = 'st_usageTracker_sessionStart';
    const LS_LAST_ACTIVE = 'st_usageTracker_lastActive';
    const LS_TRIGGERED_DURATIONS = 'st_usageTracker_triggeredDurations';
    const LS_TRIGGERED_FIXED_TIMES_DATE = 'st_usageTracker_triggeredFixedTimesDate';
    const LS_TRIGGERED_FIXED_TIMES_LIST = 'st_usageTracker_triggeredFixedTimesList';

    const defaultTimerSettings = {
        enabled: true,
        notifyType: "toastr",
        enableDurationTracking: true,
        gracePeriodMinutes: 5,
        durationThresholds: [{ value: 1, enabled: true }, { value: 2, enabled: true }],
        enableFixedTimeTracking: false,
        fixedTimeThresholds: [{ value: "22:00", enabled: true }],
    };

    let timerSettings = {}; // Holds settings for the timer feature
    let timerIntervalId = null; // Interval ID for the timer feature check
    let sessionTriggeredDurations = [];
    let todayTriggeredFixedTimes = [];

    // --- Stats Feature State & Config ---
    let statsWorker = null;

    // --- Helper Functions ---
    function getTodayDateString() { // Used by both features maybe
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function getTodayDateStringForPicker() { // Specifically for the date picker input
        return getTodayDateString();
    }

    function formatTime(totalSeconds) { // For Stats Table
        if (isNaN(totalSeconds) || totalSeconds < 0) return '00:00:00';
        totalSeconds = Math.floor(totalSeconds);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

     // Get entity name using context (for stats table rendering)
     function getEntityNameFromContext(entityId, entityType) {
        const context = getContext();
        if (!context) return entityId; // Fallback

        try {
            if (entityType === 'character') {
                 // Character ID in context is index, but we store avatar filename
                 const character = context.characters?.find(char => char.avatar === entityId);
                 return character ? character.name : (entityId || '未知角色');
            } else if (entityType === 'group') {
                 const group = context.groups?.find(grp => grp.id === entityId);
                 return group ? group.name : (entityId || '未知群组');
            }
        } catch (error) {
             console.error("Error getting entity name from context:", error);
        }
        return entityId; // Fallback
    }

    // =============================================
    // == TIMER FEATURE LOGIC (Adapted from Original) ==
    // =============================================

    async function requestNotificationPermission() {
        // ... (Keep original function content) ...
        if (!('Notification' in window)) {
            toastr.error('此浏览器不支持桌面通知。');
            return 'denied';
        }
        if (Notification.permission === 'granted') return 'granted';
        if (Notification.permission !== 'denied') {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') toastr.success('浏览器通知权限已授予！');
            else toastr.warning('浏览器通知权限被拒绝。');
            return permission;
        }
        return 'denied';
    }

    async function showNotification(message) {
        // ... (Keep original function content, check timerSettings.enabled) ...
        log(`触发提醒: ${message}`);
        if (!timerSettings.enabled) return;

        const notifyType = timerSettings.notifyType;
        const title = 'SillyTavern 使用提醒';
        const icon = '/img/ai4.png'; // Adjust if icon path changed

        if (notifyType === 'browser' || notifyType === 'both') {
            if ('Notification' in window) {
                if (Notification.permission === 'granted') {
                    new Notification(title, { body: message, icon: icon });
                } else if (Notification.permission === 'default') {
                    log('请求通知权限...');
                    const permission = await requestNotificationPermission();
                    if (permission === 'granted') {
                         new Notification(title, { body: message, icon: icon });
                    } else {
                        log('权限未授予，无法发送浏览器通知。');
                        if (notifyType === 'browser') {
                           toastr.info(message, '使用时长提醒 (浏览器通知被阻止)');
                        }
                    }
                } else {
                     log('浏览器通知权限已被拒绝。');
                      if (notifyType === 'browser') {
                         toastr.info(message, '使用时长提醒 (浏览器通知被阻止)');
                      }
                }
            } else {
                 log('浏览器不支持通知 API。');
                 if (notifyType === 'browser') {
                    toastr.info(message, '使用时长提醒 (浏览器不支持通知)');
                 }
            }
        }
        // Show toastr if selected, or as fallback if browser failed
        if (notifyType === 'toastr' || notifyType === 'both' || (notifyType === 'browser' && Notification.permission !== 'granted')) {
             toastr.info(message, '使用时长提醒');
        }
    }

    function updateLastActiveTimestampForTimer() {
        // This specifically updates the LocalStorage timestamp for the *timer's* grace period logic
        try {
            localStorage.setItem(LS_LAST_ACTIVE, Date.now().toString());
        } catch (error) {
            console.error(`${pluginLogPrefix} Error saving timer's last active timestamp:`, error);
            // toastr.error("无法保存追踪状态 (localStorage 错误)。"); // Maybe too noisy
        }
    }

    function checkTimerReminders() {
        // Renamed from checkTimers to avoid conflict if needed, checks reminder conditions
        if (!timerSettings.enabled) {
            if (timerIntervalId) {
                clearInterval(timerIntervalId);
                timerIntervalId = null;
                log("提醒功能已禁用，停止计时。");
            }
            return;
        }

        const now = Date.now();
        updateLastActiveTimestampForTimer(); // Keep updating timer's activity

        // 1. Check Continuous Duration (Uses localStorage times)
        if (timerSettings.enableDurationTracking) {
            try {
                const sessionStartTime = parseInt(localStorage.getItem(LS_SESSION_START) || '0');
                if (sessionStartTime > 0) {
                    const elapsedMs = now - sessionStartTime;
                    const elapsedHours = elapsedMs / (1000 * 60 * 60);

                    (timerSettings.durationThresholds || []).forEach(threshold => {
                        if (threshold.enabled && elapsedHours >= threshold.value) {
                            if (!sessionTriggeredDurations.includes(threshold.value)) {
                                showNotification(`你已经连续使用 SillyTavern 达到 ${threshold.value} 小时！`);
                                sessionTriggeredDurations.push(threshold.value);
                                try {
                                    localStorage.setItem(`${LS_TRIGGERED_DURATIONS}_${sessionStartTime}`, JSON.stringify(sessionTriggeredDurations));
                                } catch (lsError) { console.error("LocalStorage error saving triggered durations:", lsError); }
                            }
                        }
                    });
                }
            } catch (error) {
                 console.error(`${pluginLogPrefix} Error checking duration thresholds:`, error);
            }
        }

        // 2. Check Fixed Time (Uses system time and localStorage state)
        if (timerSettings.enableFixedTimeTracking) {
             try {
                const todayStr = getTodayDateString();
                const lastTriggerDate = localStorage.getItem(LS_TRIGGERED_FIXED_TIMES_DATE);

                if (lastTriggerDate !== todayStr) {
                    log(`日期已更改 (${lastTriggerDate} -> ${todayStr})，重置固定时间点提醒记录。`);
                    todayTriggeredFixedTimes = [];
                    try {
                        localStorage.setItem(LS_TRIGGERED_FIXED_TIMES_DATE, todayStr);
                        localStorage.setItem(LS_TRIGGERED_FIXED_TIMES_LIST, JSON.stringify([]));
                    } catch (lsError) { console.error("LocalStorage error resetting fixed time triggers:", lsError); }
                }

                const nowTime = new Date();
                const currentHHMM = `${String(nowTime.getHours()).padStart(2, '0')}:${String(nowTime.getMinutes()).padStart(2, '0')}`;

                (timerSettings.fixedTimeThresholds || []).forEach(threshold => {
                    if (threshold.enabled && threshold.value === currentHHMM) {
                        if (!todayTriggeredFixedTimes.includes(threshold.value)) {
                            showNotification(`已到达预设提醒时间: ${threshold.value}`);
                            todayTriggeredFixedTimes.push(threshold.value);
                            try {
                                localStorage.setItem(LS_TRIGGERED_FIXED_TIMES_LIST, JSON.stringify(todayTriggeredFixedTimes));
                             } catch (lsError) { console.error("LocalStorage error saving triggered fixed times:", lsError); }
                        }
                    }
                });
             } catch (error) {
                 console.error(`${pluginLogPrefix} Error checking fixed time thresholds:`, error);
             }
        }
    }

    function initializeTimerTracking() {
        // Renamed from initializeTracking
        log("初始化提醒功能追踪器...");
        if (timerIntervalId) {
            clearInterval(timerIntervalId); // Clear existing timer
        }

        if (!timerSettings.enabled) {
            log("提醒功能已禁用。");
            return;
        }

        try {
            const now = Date.now();
            const lastActiveTimestamp = parseInt(localStorage.getItem(LS_LAST_ACTIVE) || '0');
            let sessionStartTime = parseInt(localStorage.getItem(LS_SESSION_START) || '0');
            const gracePeriodMs = (timerSettings.gracePeriodMinutes || 0) * 60 * 1000;

            const offlineDuration = lastActiveTimestamp > 0 ? now - lastActiveTimestamp : Infinity;

            if (sessionStartTime === 0 || offlineDuration >= gracePeriodMs) {
                log(`新提醒会话开始 (离线: ${offlineDuration === Infinity ? 'N/A' : (offlineDuration / 1000).toFixed(1)}s, 宽限期: ${gracePeriodMs / 1000}s)`);
                sessionStartTime = now;
                localStorage.setItem(LS_SESSION_START, sessionStartTime.toString());
                sessionTriggeredDurations = []; // Reset triggers
                // Clear old session's triggers
                Object.keys(localStorage).forEach(key => {
                     if (key.startsWith(LS_TRIGGERED_DURATIONS + '_') && key !== `${LS_TRIGGERED_DURATIONS}_${sessionStartTime}`) {
                         localStorage.removeItem(key);
                     }
                 });
                localStorage.setItem(`${LS_TRIGGERED_DURATIONS}_${sessionStartTime}`, JSON.stringify([]));
            } else {
                log(`继续现有提醒会话 (离线: ${(offlineDuration / 1000).toFixed(1)}s, 宽限期: ${gracePeriodMs / 1000}s)`);
                const triggeredData = localStorage.getItem(`${LS_TRIGGERED_DURATIONS}_${sessionStartTime}`);
                sessionTriggeredDurations = triggeredData ? JSON.parse(triggeredData) : [];
            }

            // Load today's fixed time triggers
            const todayStr = getTodayDateString();
            const lastTriggerDate = localStorage.getItem(LS_TRIGGERED_FIXED_TIMES_DATE);
            if (lastTriggerDate === todayStr) {
                const triggeredListData = localStorage.getItem(LS_TRIGGERED_FIXED_TIMES_LIST);
                todayTriggeredFixedTimes = triggeredListData ? JSON.parse(triggeredListData) : [];
            } else {
                 todayTriggeredFixedTimes = [];
                 localStorage.setItem(LS_TRIGGERED_FIXED_TIMES_DATE, todayStr);
                 localStorage.setItem(LS_TRIGGERED_FIXED_TIMES_LIST, JSON.stringify([]));
            }

            updateLastActiveTimestampForTimer(); // Set initial active time for timer
            timerIntervalId = setInterval(checkTimerReminders, 15 * 1000); // Check every 15 seconds
            log(`提醒功能追踪器已启动，会话开始于: ${new Date(sessionStartTime).toLocaleString()}`);

        } catch (error) {
             console.error(`${pluginLogPrefix} Error initializing timer tracking:`, error);
             toastr.error("无法初始化使用时长提醒 (localStorage 错误)。");
        }
    }

    function renderDurationList() {
        const listElement = $('#usageTracker_durationThresholdsList');
        listElement.empty();
        (timerSettings.durationThresholds || []).forEach((threshold, index) => {
            const item = $(`
                <div class="threshold-item" data-index="${index}">
                    <span>${threshold.value} 小时</span>
                    <div>
                        <input type="checkbox" class="duration-enable-checkbox" ${threshold.enabled ? 'checked' : ''}>
                        <button class="menu_button delete-duration" title="删除此阈值"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </div>
            `);
            listElement.append(item);
        });
    }

    function renderFixedTimeList() {
        const listElement = $('#usageTracker_fixedTimesList');
        listElement.empty();
        (timerSettings.fixedTimeThresholds || []).forEach((threshold, index) => {
             const item = $(`
                <div class="threshold-item" data-index="${index}">
                    <span>${threshold.value}</span>
                     <div>
                        <input type="checkbox" class="fixedtime-enable-checkbox" ${threshold.enabled ? 'checked' : ''}>
                        <button class="menu_button delete-fixedtime" title="删除此时间点"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </div>
            `);
            listElement.append(item);
        });
    }

    async function loadTimerSettings() {
        // Ensure the global settings object has the key for the timer part
        extension_settings[timerSettingsKey] = extension_settings[timerSettingsKey] || {};

        // Merge defaults with saved settings
        timerSettings = { ...defaultTimerSettings, ...extension_settings[timerSettingsKey] };

        // Data validation and migration (ensure arrays and object structure)
        timerSettings.durationThresholds = (timerSettings.durationThresholds || [])
            .map(t => (typeof t === 'number' ? { value: t, enabled: true } : t))
            .filter(t => typeof t === 'object' && typeof t.value === 'number' && typeof t.enabled === 'boolean');
        timerSettings.fixedTimeThresholds = (timerSettings.fixedTimeThresholds || [])
             .map(t => (typeof t === 'string' ? { value: t, enabled: true } : t))
             .filter(t => typeof t === 'object' && typeof t.value === 'string' && typeof t.enabled === 'boolean');

        // Update the UI elements for the timer settings
        $('#usageTracker_enabled').prop('checked', timerSettings.enabled);
        $('#usageTracker_notifyType').val(timerSettings.notifyType);
        $('#usageTracker_requestNotifyPermission').toggle(timerSettings.notifyType === 'browser' || timerSettings.notifyType === 'both');
        $('#usageTracker_enableDurationTracking').prop('checked', timerSettings.enableDurationTracking);
        $('#usageTracker_gracePeriod').val(timerSettings.gracePeriodMinutes);
        $('#usageTracker_enableFixedTimeTracking').prop('checked', timerSettings.enableFixedTimeTracking);

        renderDurationList();
        renderFixedTimeList();
        log("提醒功能设置已加载。");
    }

    function saveTimerSettings() {
         extension_settings[timerSettingsKey] = { ...timerSettings }; // Save a copy
         saveSettingsDebounced(); // Use SillyTavern's debounced save
         log("提醒功能设置已触发保存。");
    }

    // =============================================
    // == STATS FEATURE LOGIC (Worker Based) =======
    // =============================================

    function initStatsWorker() {
        if (statsWorker) {
            log("统计 Worker 已初始化。");
            return;
        }
        try {
            const workerPath = `${extensionFolderPath}/worker.js`; // Path relative to extension root
            log(`尝试初始化 Worker: ${workerPath}`);
            statsWorker = new Worker(workerPath);

            statsWorker.onmessage = (event) => {
                const { type, date, stats } = event.data;
                if (type === 'statsUpdated') {
                    log(`主线程: 收到日期 ${date} 的统计更新`);
                    const selectedDate = $('#usage-stats-date-picker').val();
                     if (selectedDate === date) {
                        renderStatsTable(stats);
                     }
                }
            };

            statsWorker.onerror = (error) => {
                console.error(`${pluginLogPrefix} Worker 错误:`, error.message, error);
                toastr.error("每日统计 Worker 发生错误。请检查控制台。");
                statsWorker = null;
            };

            // Send initial state
            statsWorker.postMessage({
                type: 'init',
                payload: { isTabVisible: !document.hidden }
            });
            log("统计 Worker 初始化成功。");

        } catch (error) {
            console.error(`${pluginLogPrefix} 初始化统计 Worker 失败:`, error);
            toastr.error("无法初始化每日统计 Worker。");
            statsWorker = null;
        }
    }

    function sendMessageToStatsWorker(type, payload) {
        if (!statsWorker) return;
        try {
             statsWorker.postMessage({ type, payload });
        } catch (error) {
             console.error(`${pluginLogPrefix} 发送消息到 Worker 失败:`, error);
             toastr.error("与统计 Worker 通信失败。");
        }
    }

    function renderStatsTable(statsData) {
        const tableBody = $('#usage-stats-table-body');
        if (!tableBody.length) return;

        tableBody.empty();

        if (!statsData || Object.keys(statsData).length === 0) {
            tableBody.append('<tr><td colspan="6">此日期无统计数据。</td></tr>');
            return;
        }

        // Sort by name for consistent display
        const sortedKeys = Object.keys(statsData).sort((a, b) => {
            // Use name from stats data itself, as context might not be available when rendering past dates
            const nameA = statsData[a]?.name || a;
            const nameB = statsData[b]?.name || b;
            // Attempt to get current name if available, otherwise use stored name
            const currentNameA = getEntityNameFromContext(a, statsData[a]?.type) || nameA;
            const currentNameB = getEntityNameFromContext(b, statsData[b]?.type) || nameB;
            return currentNameA.localeCompare(currentNameB);
        });

        sortedKeys.forEach(entityId => {
            const data = statsData[entityId];
            if (!data) return; // Skip if data is unexpectedly missing

            const currentName = getEntityNameFromContext(entityId, data.type) || data.name || entityId;
            const typeDisplay = data.type === 'character' ? '角色' : data.type === 'group' ? '群组' : '未知';

            const row = `
                <tr>
                    <td>${escapeHtml(currentName)}</td>
                    <td>${escapeHtml(typeDisplay)}</td>
                    <td>${formatTime(data.onlineTimeSeconds || 0)}</td>
                    <td>${data.msgSent || 0}</td>
                    <td>${data.msgReceived || 0}</td>
                    <td>${data.tokensUsed || 0}</td>
                </tr>
            `;
            tableBody.append(row);
        });
         log("统计表格已渲染。");
    }

    // =============================================
    // == EVENT HANDLERS (Combined & Specific) =====
    // =============================================

    function handleChatChanged() {
        log("Chat changed event triggered.");
        // 1. Handle Timer Logic (Session Start/Resume)
        //    InitializeTimerTracking already handles the logic based on localStorage grace period.
        //    We might need to call it or a part of it if needed.
        //    For simplicity, let's assume the timer's activity update handles this.
        //    Maybe force an activity update for the timer?
        updateLastActiveTimestampForTimer(); // Ensure timer knows activity happened

        // 2. Handle Stats Worker Update
        if (!statsWorker) return;
        const context = getContext();
        let entityId = null;
        let entityType = null;
        let entityName = null;

        if (context.groupId) {
            entityId = context.groupId;
            entityType = 'group';
            entityName = getEntityNameFromContext(entityId, entityType);
        } else if (context.characterId !== undefined && context.characters[context.characterId]) {
            entityId = context.characters[context.characterId].avatar;
            entityType = 'character';
            entityName = context.characters[context.characterId].name;
        }

        log(`通知 Worker 聊天变更: ID=${entityId}, Type=${entityType}, Name=${entityName}`);
        sendMessageToStatsWorker('chatChanged', { entityId, entityType, entityName });
    }

    async function handleMessage(message, isSent) {
        if (!message) return;
        // 1. Update Timer Last Active Time
        updateLastActiveTimestampForTimer();

        // 2. Update Stats Worker
        if (!statsWorker) return;
        const context = getContext();
        let entityId = null;
        let entityType = null;
        let entityName = null;

         if (context.groupId) {
            entityId = context.groupId;
            entityType = 'group';
            entityName = getEntityNameFromContext(entityId, entityType);
        } else if (context.characterId !== undefined && context.characters[context.characterId]) {
            entityId = context.characters[context.characterId].avatar;
            entityType = 'character';
            entityName = context.characters[context.characterId].name;
        }

        if (!entityId) return; // Ignore if no context

        const messageEventType = isSent ? 'messageSent' : 'messageReceived';
        sendMessageToStatsWorker(messageEventType, { entityId, entityName, entityType });

        try {
            const tokenCount = await getTokenCountAsync(message.mes || '');
            sendMessageToStatsWorker('tokenCount', { entityId, entityName, entityType, count: tokenCount });
        } catch (error) {
            console.error(`${pluginLogPrefix} 计算 Token 失败:`, error);
        }
    }

    function handleVisibilityChange() {
        const isVisible = !document.hidden;
        log(`页面可见性变更: ${isVisible ? '可见' : '隐藏'}`);

        // 1. Update Timer Last Active (important for grace period on becoming hidden)
        updateLastActiveTimestampForTimer();
        if (isVisible) {
             // When becoming visible, re-initialize timer logic to check session status
             initializeTimerTracking();
        }

        // 2. Update Stats Worker
        sendMessageToStatsWorker('visibilityChanged', { isVisible });
    }

    // Throttle user activity updates to avoid flooding
    const handleUserActivityThrottled = throttle(() => {
        // 1. Update Timer Last Active
        updateLastActiveTimestampForTimer();
        // 2. Update Stats Worker
        sendMessageToStatsWorker('userActivity', {});
    }, 5000); // Check activity every 5 seconds max for worker

    function handleStatsRefreshClick() {
         log("统计刷新按钮点击。");
         const selectedDate = $('#usage-stats-date-picker').val();
         if (selectedDate && statsWorker) {
             $('#usage-stats-table-body').empty().append('<tr><td colspan="6">正在刷新数据...</td></tr>');
             sendMessageToStatsWorker('requestStats', { date: selectedDate });
         } else if (!statsWorker) {
              toastr.error("统计 Worker 未运行，无法刷新。");
         }
    }

    function handleStatsDateChange() {
        log("统计日期选择变更。");
        handleStatsRefreshClick(); // Refresh data for the newly selected date
    }

    // =============================================
    // == UI BINDING & INITIALIZATION =============
    // =============================================

    function bindTimerUIEvents() {
        const container = $('.usage-tracker-settings'); // Target the timer settings container

        // General Timer Settings
        container.on('change', '#usageTracker_enabled', function() {
            timerSettings.enabled = $(this).is(':checked');
            saveTimerSettings();
            initializeTimerTracking(); // Re-initialize to start/stop timer
        });
        container.on('change', '#usageTracker_notifyType', function() {
            timerSettings.notifyType = $(this).val();
            saveTimerSettings();
             $('#usageTracker_requestNotifyPermission').toggle(timerSettings.notifyType === 'browser' || timerSettings.notifyType === 'both');
            if (timerSettings.notifyType === 'browser' || timerSettings.notifyType === 'both') {
                 requestNotificationPermission();
            }
        });
        container.on('click', '#usageTracker_requestNotifyPermission', requestNotificationPermission);

        // Duration Tracking Settings
        container.on('change', '#usageTracker_enableDurationTracking', function() {
            timerSettings.enableDurationTracking = $(this).is(':checked');
            saveTimerSettings();
        });
        container.on('input', '#usageTracker_gracePeriod', function() {
            const val = parseInt($(this).val());
            if (!isNaN(val) && val >= 0) {
                timerSettings.gracePeriodMinutes = val;
                saveTimerSettings();
            }
        });
        container.on('click', '#usageTracker_addDuration', function() {
            const input = $('#usageTracker_newDuration');
            const value = parseFloat(input.val());
            if (!isNaN(value) && value > 0) {
                timerSettings.durationThresholds = timerSettings.durationThresholds || [];
                if (!timerSettings.durationThresholds.some(t => t.value === value)) {
                    timerSettings.durationThresholds.push({ value: value, enabled: true });
                    timerSettings.durationThresholds.sort((a, b) => a.value - b.value);
                    saveTimerSettings();
                    renderDurationList();
                    input.val('');
                } else { toastr.warning(`阈值 ${value} 小时已存在。`); }
            } else { toastr.warning('请输入有效的持续时间（大于0的小时数）。'); }
        });
        $('#usageTracker_durationThresholdsList').on('click', '.delete-duration', function() {
            const index = $(this).closest('.threshold-item').data('index');
            timerSettings.durationThresholds.splice(index, 1);
            saveTimerSettings();
            renderDurationList();
        });
         $('#usageTracker_durationThresholdsList').on('change', '.duration-enable-checkbox', function() {
            const index = $(this).closest('.threshold-item').data('index');
            timerSettings.durationThresholds[index].enabled = $(this).is(':checked');
            saveTimerSettings();
        });

        // Fixed Time Tracking Settings
        container.on('change', '#usageTracker_enableFixedTimeTracking', function() {
            timerSettings.enableFixedTimeTracking = $(this).is(':checked');
            saveTimerSettings();
        });
        container.on('click', '#usageTracker_addFixedTime', function() {
            const input = $('#usageTracker_newFixedTime');
            const value = input.val();
            if (value) {
                timerSettings.fixedTimeThresholds = timerSettings.fixedTimeThresholds || [];
                 if (!timerSettings.fixedTimeThresholds.some(t => t.value === value)) {
                    timerSettings.fixedTimeThresholds.push({ value: value, enabled: true });
                     timerSettings.fixedTimeThresholds.sort((a, b) => a.value.localeCompare(b.value));
                    saveTimerSettings();
                    renderFixedTimeList();
                 } else { toastr.warning(`时间点 ${value} 已存在。`); }
            } else { toastr.warning('请选择一个有效的时间点。'); }
        });
        $('#usageTracker_fixedTimesList').on('click', '.delete-fixedtime', function() {
            const index = $(this).closest('.threshold-item').data('index');
            timerSettings.fixedTimeThresholds.splice(index, 1);
            saveTimerSettings();
            renderFixedTimeList();
        });
         $('#usageTracker_fixedTimesList').on('change', '.fixedtime-enable-checkbox', function() {
            const index = $(this).closest('.threshold-item').data('index');
            timerSettings.fixedTimeThresholds[index].enabled = $(this).is(':checked');
            saveTimerSettings();
        });

        // Drawer toggle
        container.on('click', '.inline-drawer-toggle', function() {
            const content = $(this).next('.inline-drawer-content');
            const icon = $(this).find('.inline-drawer-icon');
            content.slideToggle(200); // Animate the toggle
            icon.toggleClass('down up');
        });

         log("提醒功能 UI 事件已绑定。");
    }

    function bindStatsUIEvents() {
        const container = $('.usage-stats-container'); // Target the stats container
        if (!container.length) return;
        container.on('click', '#usage-stats-refresh-button', handleStatsRefreshClick);
        container.on('change', '#usage-stats-date-picker', handleStatsDateChange);
        log("统计功能 UI 事件已绑定。");
    }

    function bindGlobalEvents() {
        // User Activity Listeners (bound to document) - Trigger BOTH timer update and worker message
        $(document).on('mousemove keydown scroll', handleUserActivityThrottled);

        // Visibility Listener - Triggers BOTH timer update and worker message
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // SillyTavern Event Listeners - Trigger BOTH timer update and worker message
        eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
        eventSource.on(event_types.MESSAGE_SENT, (message) => handleMessage(message, true));
        // Note: MESSAGE_RECEIVED arguments can vary. Check SillyTavern source if issues arise.
        // Usually it's (messageId, messageObject) or just (messageObject). Let's assume second arg is reliable.
        eventSource.on(event_types.MESSAGE_RECEIVED, (_, message) => handleMessage(message, false));

         // Attempt to save stats via worker when the window is about to close
         $(window).on('beforeunload', () => {
             if (statsWorker) {
                 log("页面即将卸载，尝试强制保存统计数据。");
                 sendMessageToStatsWorker('forceSave', {});
                 // Cannot guarantee completion here.
             }
             // Also update timer's last active timestamp one last time
             updateLastActiveTimestampForTimer();
         });
         log("全局事件监听器已绑定。");
    }


    // --- Plugin Entry Point ---
    jQuery(async () => {
        log("插件加载中 (v1.1.0 集成版)...");
        try {
            // 1. Load HTML Templates
            const timerHtmlPromise = renderExtensionTemplateAsync(`third-party/${pluginName}`, 'settings');
            const statsHtmlPromise = renderExtensionTemplateAsync(`third-party/${pluginName}`, 'stats_table');

            const [timerHtml, statsHtml] = await Promise.all([timerHtmlPromise, statsHtmlPromise]);

            // 2. Append HTML to Settings Page
            // Create a main container for this combined plugin
            const pluginContainer = $(`<div id="${pluginName}-container"></div>`);
            pluginContainer.append(timerHtml); // Add timer settings UI
            pluginContainer.append(statsHtml); // Add stats table UI
            $("#extensions_settings").append(pluginContainer);
            log("UI HTML 已加载并添加到页面。");

            // 3. Load Timer Settings
            await loadTimerSettings(); // Load settings for the timer feature

            // 4. Initialize Stats Worker
            initStatsWorker();

            // 5. Bind UI Events for both parts
            bindTimerUIEvents();
            bindStatsUIEvents();

            // 6. Initialize Timer Tracking Logic
            initializeTimerTracking();

            // 7. Bind Global Event Listeners
            bindGlobalEvents();

            // 8. Initial Stats Load Request
             $('#usage-stats-date-picker').val(getTodayDateStringForPicker()); // Set date picker to today
             if (statsWorker) {
                // Wait slightly for worker init before requesting
                setTimeout(() => {
                     log("请求初始统计数据...");
                     handleStatsRefreshClick(); // Use the refresh handler to load initial data
                }, 500);
            } else {
                 $('#usage-stats-table-body').empty().append('<tr><td colspan="6">Worker 初始化失败，无法加载数据。</td></tr>');
            }

            log("插件初始化完成。");

        } catch (error) {
            console.error(`${pluginLogPrefix} 初始化失败:`, error);
            toastr.error(`${pluginName} 插件加载失败。`);
            // Optionally clean up any partially added UI?
             $(`#${pluginName}-container`).remove();
        }
    });

})();
