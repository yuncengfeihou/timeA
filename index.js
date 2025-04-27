import { extension_settings, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from "../../../../script.js"; 
import { getContext } from "../../../extensions.js";

(function () {
    const extensionName = "timeA";
    const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

    // LocalStorage Keys
    const LS_SESSION_START = 'st_usageTracker_sessionStart';
    const LS_LAST_ACTIVE = 'st_usageTracker_lastActive';
    const LS_TRIGGERED_DURATIONS = 'st_usageTracker_triggeredDurations'; // Stores for the current session
    const LS_TRIGGERED_FIXED_TIMES_DATE = 'st_usageTracker_triggeredFixedTimesDate'; // YYYY-MM-DD
    const LS_TRIGGERED_FIXED_TIMES_LIST = 'st_usageTracker_triggeredFixedTimesList'; // Stores for today
    // 新增：角色统计相关的存储键
    const LS_CURRENT_ENTITY = 'st_usageTracker_currentEntity';
    const LS_ENTITY_START_TIME = 'st_usageTracker_entityStartTime';
    const LS_ENTITY_STATS_DATE = 'st_usageTracker_entityStatsDate';

    const defaultSettings = {
        enabled: true,
        notifyType: "toastr", // 'toastr', 'browser', 'both'
        enableDurationTracking: true,
        gracePeriodMinutes: 5, // Default 5 minutes
        durationThresholds: [ // In hours
            { value: 1, enabled: true },
            { value: 2, enabled: true },
        ],
        enableFixedTimeTracking: false,
        fixedTimeThresholds: [ // HH:MM format
            { value: "22:00", enabled: true },
        ],
        // 新增：角色使用统计设置
        enableCharStats: true,
        characterStats: {}, // 按日期存储统计数据: { '2023-05-20': { 'char123': {...}, 'group456': {...} } }
    };

    let settings = {};
    let intervalId = null;
    let sessionTriggeredDurations = []; // Holds duration thresholds (in hours) triggered in this session
    let todayTriggeredFixedTimes = []; // Holds fixed times (HH:MM) triggered today
    
    // 新增：角色统计相关变量
    let charStatsIntervalId = null;
    let currentEntityId = null;
    let entityStartTime = 0;
    let isWindowFocused = true;
    const CHAR_STATS_INTERVAL = 15000; // 15秒检查一次

    // --- Helper Functions ---
    function getTodayDateString() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function log(message) {
        console.log(`[${extensionName}] ${message}`);
    }
    
    // 新增：格式化时间函数，将毫秒转换为可读时间
    function formatDuration(milliseconds) {
        if (!milliseconds) return '0分钟';
        
        const totalMinutes = Math.floor(milliseconds / (1000 * 60));
        
        if (totalMinutes < 60) {
            return `${totalMinutes}分钟`;
        }
        
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        
        if (minutes === 0) {
            return `${hours}小时`;
        }
        
        return `${hours}小时${minutes}分钟`;
    }
    
    // 新增：计算文本中的tokens数量（简易估算）
    async function estimateTokens(text) {
        if (!text) return 0;
        
        try {
            // 优先使用SillyTavern的token计数功能
            const context = getContext();
            if (context && context.getTokenCountAsync) {
                return await context.getTokenCountAsync(text);
            }
            
            // 简易估算：英文约1个token/4字符，中文约1个token/1.5字符
            // 这只是非常粗略的估计，实际应根据模型而定
            const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
            const otherChars = text.length - chineseChars;
            return Math.ceil(chineseChars / 1.5 + otherChars / 4);
        } catch (error) {
            console.error(`[${extensionName}] Error estimating tokens:`, error);
            // 最简单的粗略估计
            return Math.ceil(text.length / 3);
        }
    }

    // --- Notification Logic ---
    async function requestNotificationPermission() {
        if (!('Notification' in window)) {
            toastr.error('此浏览器不支持桌面通知。');
            return 'denied';
        }

        if (Notification.permission === 'granted') {
            return 'granted';
        }

        if (Notification.permission !== 'denied') {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                toastr.success('浏览器通知权限已授予！');
            } else {
                toastr.warning('浏览器通知权限被拒绝。');
            }
            return permission;
        }
        return 'denied';
    }

    async function showNotification(message) {
        log(`触发提醒: ${message}`);
        if (!settings.enabled) return;

        const notifyType = settings.notifyType;

        if (notifyType === 'browser' || notifyType === 'both') {
            if ('Notification' in window) {
                if (Notification.permission === 'granted') {
                    new Notification('SillyTavern 使用提醒', { body: message, icon: '/img/ai4.png' });
                } else if (Notification.permission === 'default') {
                    log('请求通知权限...');
                    const permission = await requestNotificationPermission();
                    if (permission === 'granted') {
                         new Notification('SillyTavern 使用提醒', { body: message, icon: '/img/ai4.png' });
                    } else {
                        log('权限未授予，无法发送浏览器通知。');
                        if (notifyType === 'browser') { // Fallback if ONLY browser was selected
                           toastr.info(message, '使用时长提醒 (浏览器通知被阻止)');
                        }
                    }
                } else {
                     log('浏览器通知权限已被拒绝。');
                      if (notifyType === 'browser') { // Fallback if ONLY browser was selected
                         toastr.info(message, '使用时长提醒 (浏览器通知被阻止)');
                      }
                }
            } else {
                 log('浏览器不支持通知 API。');
                 if (notifyType === 'browser') { // Fallback if ONLY browser was selected
                    toastr.info(message, '使用时长提醒 (浏览器不支持通知)');
                 }
            }
        }

        if (notifyType === 'toastr' || notifyType === 'both') {
            // Always show toastr if it's selected or as a fallback if browser fails initially (permission denied/unsupported)
             if (notifyType === 'both' || (notifyType === 'toastr') || (notifyType === 'browser' && Notification.permission !== 'granted')) {
                toastr.info(message, '使用时长提醒');
             }
        }
    }

    // --- Tracking & Timer Logic ---
    function updateLastActive() {
        const now = Date.now();
        try {
            localStorage.setItem(LS_LAST_ACTIVE, now.toString());
            // log(`Last active timestamp updated: ${new Date(now).toLocaleTimeString()}`);
        } catch (error) {
            console.error(`[${extensionName}] Error saving to localStorage:`, error);
            toastr.error("无法保存追踪状态 (localStorage 错误)。");
        }
    }

    function checkTimers() {
        if (!settings.enabled) {
            if (intervalId) {
                clearInterval(intervalId);
                intervalId = null;
                log("追踪器已禁用，停止计时。");
            }
            return;
        }

        const now = Date.now();
        updateLastActive(); // Keep updating last active as long as the timer runs

        // 1. Check Continuous Duration
        if (settings.enableDurationTracking) {
            try {
                const sessionStartTime = parseInt(localStorage.getItem(LS_SESSION_START) || '0');
                if (sessionStartTime > 0) {
                    const elapsedMs = now - sessionStartTime;
                    const elapsedHours = elapsedMs / (1000 * 60 * 60);

                    settings.durationThresholds.forEach(threshold => {
                        if (threshold.enabled && elapsedHours >= threshold.value) {
                            if (!sessionTriggeredDurations.includes(threshold.value)) {
                                showNotification(`你已经连续使用 SillyTavern 达到 ${threshold.value} 小时！`);
                                sessionTriggeredDurations.push(threshold.value);
                                // Save triggered durations for this session
                                localStorage.setItem(`${LS_TRIGGERED_DURATIONS}_${sessionStartTime}`, JSON.stringify(sessionTriggeredDurations));
                            }
                        }
                    });
                }
            } catch (error) {
                 console.error(`[${extensionName}] Error checking duration thresholds:`, error);
            }
        }

        // 2. Check Fixed Time
        if (settings.enableFixedTimeTracking) {
             try {
                const todayStr = getTodayDateString();
                const lastTriggerDate = localStorage.getItem(LS_TRIGGERED_FIXED_TIMES_DATE);

                // Reset triggered list if the date changed
                if (lastTriggerDate !== todayStr) {
                    log(`日期已更改 (${lastTriggerDate} -> ${todayStr})，重置固定时间点提醒记录。`);
                    todayTriggeredFixedTimes = [];
                    localStorage.setItem(LS_TRIGGERED_FIXED_TIMES_DATE, todayStr);
                    localStorage.setItem(LS_TRIGGERED_FIXED_TIMES_LIST, JSON.stringify([]));
                }

                const nowTime = new Date();
                const currentHHMM = `${String(nowTime.getHours()).padStart(2, '0')}:${String(nowTime.getMinutes()).padStart(2, '0')}`;

                settings.fixedTimeThresholds.forEach(threshold => {
                    if (threshold.enabled && threshold.value === currentHHMM) {
                        if (!todayTriggeredFixedTimes.includes(threshold.value)) {
                            showNotification(`已到达预设提醒时间: ${threshold.value}`);
                            todayTriggeredFixedTimes.push(threshold.value);
                            localStorage.setItem(LS_TRIGGERED_FIXED_TIMES_LIST, JSON.stringify(todayTriggeredFixedTimes));
                        }
                    }
                });
             } catch (error) {
                 console.error(`[${extensionName}] Error checking fixed time thresholds:`, error);
             }
        }
    }

    function initializeTracking() {
        log("初始化追踪器...");
        if (intervalId) {
            clearInterval(intervalId); // Clear existing timer if any
        }

        if (!settings.enabled) {
            log("追踪器已禁用。");
            return;
        }

        try {
            const now = Date.now();
            const lastActiveTimestamp = parseInt(localStorage.getItem(LS_LAST_ACTIVE) || '0');
            let sessionStartTime = parseInt(localStorage.getItem(LS_SESSION_START) || '0');
            const gracePeriodMs = (settings.gracePeriodMinutes || 0) * 60 * 1000;

            const offlineDuration = lastActiveTimestamp > 0 ? now - lastActiveTimestamp : Infinity;

            if (sessionStartTime === 0 || offlineDuration >= gracePeriodMs) {
                // Start a new session
                log(`新会话开始 (离线: ${offlineDuration === Infinity ? 'N/A' : (offlineDuration / 1000).toFixed(1)}s, 宽限期: ${gracePeriodMs / 1000}s)`);
                sessionStartTime = now;
                localStorage.setItem(LS_SESSION_START, sessionStartTime.toString());
                sessionTriggeredDurations = []; // Reset triggers for new session
                // Clear old session's triggers (optional, good for cleanup)
                Object.keys(localStorage).forEach(key => {
                     if (key.startsWith(LS_TRIGGERED_DURATIONS + '_')) {
                         localStorage.removeItem(key);
                     }
                 });
                localStorage.setItem(`${LS_TRIGGERED_DURATIONS}_${sessionStartTime}`, JSON.stringify([])); // Initialize for new session
            } else {
                // Continue existing session
                log(`继续现有会话 (离线: ${(offlineDuration / 1000).toFixed(1)}s, 宽限期: ${gracePeriodMs / 1000}s)`);
                // Load triggers for the *current* session
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
                 todayTriggeredFixedTimes = []; // New day, reset
                 localStorage.setItem(LS_TRIGGERED_FIXED_TIMES_DATE, todayStr);
                 localStorage.setItem(LS_TRIGGERED_FIXED_TIMES_LIST, JSON.stringify([]));
            }

            updateLastActive(); // Set initial active time
            intervalId = setInterval(checkTimers, 15 * 1000); // Check every 15 seconds
            log(`追踪器已启动，会话开始于: ${new Date(sessionStartTime).toLocaleString()}`);
        } catch (error) {
             console.error(`[${extensionName}] Error initializing tracking:`, error);
             toastr.error("无法初始化使用时长追踪 (localStorage 错误)。");
        }
    }

    // --- 新增：角色使用统计功能 ---
    
    // 获取当前实体（角色或群组）ID
    function getCurrentEntityId() {
        try {
            const context = getContext();
            if (context) {
                return context.groupId || context.characterId;
            }
        } catch (error) {
            console.error(`[${extensionName}] Error getting current entity ID:`, error);
        }
        return null;
    }
    
    // 获取实体名称
    function getEntityName(entityId) {
        try {
            const context = getContext();
            if (!context) return `Entity-${entityId}`;
            
            // 检查是否为群组
            if (context.groups && context.groups.length > 0) {
                const group = context.groups.find(g => g.id === entityId);
                if (group) return group.name;
            }
            
            // 检查是否为角色
            if (context.characters && context.characters.length > 0) {
                const character = context.characters.find(c => c.avatar === entityId);
                if (character) return character.name;
            }
            
            // 如果是当前角色
            if (entityId === context.characterId) {
                return context.name2;
            }
        } catch (error) {
            console.error(`[${extensionName}] Error getting entity name:`, error);
        }
        
        return `Entity-${entityId}`;
    }
    
    // 获取实体类型
    function getEntityType(entityId) {
        try {
            const context = getContext();
            if (!context) return "未知";
            
            // 检查是否为群组
            if (context.groups && context.groups.length > 0) {
                const group = context.groups.find(g => g.id === entityId);
                if (group) return "群组";
            }
            
            return "角色";
        } catch (error) {
            console.error(`[${extensionName}] Error getting entity type:`, error);
        }
        
        return "未知";
    }
    
    // 初始化角色统计跟踪
    function initCharStatsTracking() {
        log("初始化角色使用统计...");
        
        if (charStatsIntervalId) {
            clearInterval(charStatsIntervalId);
            charStatsIntervalId = null;
        }
        
        if (!settings.enabled || !settings.enableCharStats) {
            log("角色使用统计已禁用。");
            return;
        }
        
        try {
            // 获取当前实体ID
            currentEntityId = getCurrentEntityId();
            if (!currentEntityId) {
                log("无法获取当前实体ID，角色使用统计暂不可用。");
                return;
            }
            
            // 从localStorage获取上次的实体ID和开始时间
            const storedEntityId = localStorage.getItem(LS_CURRENT_ENTITY);
            const storedStartTime = parseInt(localStorage.getItem(LS_ENTITY_START_TIME) || '0');
            
            // 如果切换了实体，保存上一个实体的时长
            if (storedEntityId && storedEntityId !== currentEntityId && storedStartTime > 0) {
                const now = Date.now();
                const duration = now - storedStartTime;
                if (duration > 0) {
                    log(`实体切换：从 ${storedEntityId} 到 ${currentEntityId}`);
                    updateEntityStats(storedEntityId, {
                        timeMs: duration,
                        msgInc: 0,
                        aiMsgInc: 0,
                        tokensInc: 0
                    });
                }
            }
            
            // 设置当前实体和开始时间
            entityStartTime = Date.now();
            localStorage.setItem(LS_CURRENT_ENTITY, currentEntityId);
            localStorage.setItem(LS_ENTITY_START_TIME, entityStartTime.toString());
            
            // 开始定时跟踪
            charStatsIntervalId = setInterval(trackEntityTime, CHAR_STATS_INTERVAL);
            log(`角色使用统计已启动，当前实体：${currentEntityId} (${getEntityName(currentEntityId)})`);
            
        } catch (error) {
            console.error(`[${extensionName}] Error initializing character stats tracking:`, error);
        }
    }
    
    // 跟踪实体使用时间
    function trackEntityTime() {
        if (!settings.enabled || !settings.enableCharStats || !currentEntityId || !isWindowFocused) {
            return;
        }
        
        try {
            const now = Date.now();
            const storedStartTime = parseInt(localStorage.getItem(LS_ENTITY_START_TIME) || '0');
            
            if (storedStartTime > 0) {
                const timeIncrement = CHAR_STATS_INTERVAL; // 使用固定的时间增量，简化计算
                updateEntityStats(currentEntityId, {
                    timeMs: timeIncrement,
                    msgInc: 0,
                    aiMsgInc: 0,
                    tokensInc: 0
                });
            }
            
        } catch (error) {
            console.error(`[${extensionName}] Error tracking entity time:`, error);
        }
    }
    
    // 处理窗口焦点变化
    function handleVisibilityChange() {
        const isVisible = !document.hidden;
        
        if (isVisible && !isWindowFocused) {
            // 窗口重新获得焦点
            isWindowFocused = true;
            log("窗口获得焦点");
            
            // 重启实体使用跟踪
            entityStartTime = Date.now();
            localStorage.setItem(LS_ENTITY_START_TIME, entityStartTime.toString());
            
            if (!charStatsIntervalId && settings.enabled && settings.enableCharStats) {
                charStatsIntervalId = setInterval(trackEntityTime, CHAR_STATS_INTERVAL);
            }
            
        } else if (!isVisible && isWindowFocused) {
            // 窗口失去焦点
            isWindowFocused = false;
            log("窗口失去焦点");
            
            // 保存当前实体的使用时间
            const storedEntityId = localStorage.getItem(LS_CURRENT_ENTITY);
            const storedStartTime = parseInt(localStorage.getItem(LS_ENTITY_START_TIME) || '0');
            
            if (storedEntityId && storedStartTime > 0) {
                const now = Date.now();
                const duration = now - storedStartTime;
                if (duration > 0) {
                    updateEntityStats(storedEntityId, {
                        timeMs: duration,
                        msgInc: 0,
                        aiMsgInc: 0,
                        tokensInc: 0
                    });
                }
            }
            
            // 清除计时器
            if (charStatsIntervalId) {
                clearInterval(charStatsIntervalId);
                charStatsIntervalId = null;
            }
        }
    }
    
    // 处理聊天变化事件
    function handleChatChanged() {
        try {
            // 保存旧实体的使用时间
            const storedEntityId = localStorage.getItem(LS_CURRENT_ENTITY);
            const storedStartTime = parseInt(localStorage.getItem(LS_ENTITY_START_TIME) || '0');
            
            if (storedEntityId && storedStartTime > 0) {
                const now = Date.now();
                const duration = now - storedStartTime;
                if (duration > 0) {
                    updateEntityStats(storedEntityId, {
                        timeMs: duration,
                        msgInc: 0,
                        aiMsgInc: 0,
                        tokensInc: 0
                    });
                }
            }
            
            // 更新当前实体
            currentEntityId = getCurrentEntityId();
            if (currentEntityId) {
                log(`聊天已切换到 ${currentEntityId} (${getEntityName(currentEntityId)})`);
                entityStartTime = Date.now();
                localStorage.setItem(LS_CURRENT_ENTITY, currentEntityId);
                localStorage.setItem(LS_ENTITY_START_TIME, entityStartTime.toString());
            }
            
        } catch (error) {
            console.error(`[${extensionName}] Error handling chat changed:`, error);
        }
    }
    
    // 处理消息发送事件
    async function handleMessageSent(event) {
        if (!settings.enabled || !settings.enableCharStats || !currentEntityId) {
            return;
        }
        
        try {
            const message = event.detail.message;
            if (!message || !message.mes) return;
            
            const tokens = await estimateTokens(message.mes);
            
            updateEntityStats(currentEntityId, {
                timeMs: 0,
                msgInc: 1,
                aiMsgInc: 0,
                tokensInc: tokens
            });
            
            log(`用户消息已发送 (${tokens} tokens)`);
            
        } catch (error) {
            console.error(`[${extensionName}] Error handling message sent:`, error);
        }
    }
    
    // 处理消息接收事件
    async function handleMessageReceived(event) {
        if (!settings.enabled || !settings.enableCharStats || !currentEntityId) {
            return;
        }
        
        try {
            const message = event.detail.message;
            if (!message || !message.mes) return;
            
            const tokens = await estimateTokens(message.mes);
            
            updateEntityStats(currentEntityId, {
                timeMs: 0,
                msgInc: 0,
                aiMsgInc: 1,
                tokensInc: tokens
            });
            
            log(`AI消息已接收 (${tokens} tokens)`);
            
        } catch (error) {
            console.error(`[${extensionName}] Error handling message received:`, error);
        }
    }
    
    // 更新实体统计
    function updateEntityStats(entityId, statsInc) {
        if (!entityId || !statsInc) return;
        
        try {
            const today = getTodayDateString();
            
            // 确保settings.characterStats有今天的数据
            settings.characterStats = settings.characterStats || {};
            settings.characterStats[today] = settings.characterStats[today] || {};
            
            // 确保今天有此实体的数据
            if (!settings.characterStats[today][entityId]) {
                settings.characterStats[today][entityId] = {
                    name: getEntityName(entityId),
                    type: getEntityType(entityId),
                    durationMs: 0,
                    userMessages: 0,
                    aiMessages: 0,
                    totalTokens: 0
                };
            }
            
            // 更新统计
            const stats = settings.characterStats[today][entityId];
            stats.durationMs += statsInc.timeMs || 0;
            stats.userMessages += statsInc.msgInc || 0;
            stats.aiMessages += statsInc.aiMsgInc || 0;
            stats.totalTokens += statsInc.tokensInc || 0;
            
            // 定期保存设置
            saveSettingsDebounced();
            
            // 如果UI已打开，更新表格
            if ($('#usageTracker_statsTable').is(':visible')) {
                const selectedDate = $('#usageTracker_statsDate').val();
                if (selectedDate === today) {
                    displayCharStats(today);
                }
            }
            
        } catch (error) {
            console.error(`[${extensionName}] Error updating entity stats:`, error);
        }
    }
    
    // 显示角色统计数据
    function displayCharStats(dateString) {
        const tableBody = $('#usageTracker_statsTable tbody');
        tableBody.empty();
        
        try {
            if (!dateString) {
                dateString = getTodayDateString();
            }
            
            const statsForDate = settings.characterStats?.[dateString] || {};
            const entities = Object.keys(statsForDate);
            
            if (entities.length === 0) {
                tableBody.append(`
                    <tr>
                        <td colspan="6" class="no-data">该日期没有使用记录</td>
                    </tr>
                `);
                return;
            }
            
            // 计算总计行
            let totalTime = 0;
            let totalUserMsgs = 0;
            let totalAiMsgs = 0;
            let totalTokens = 0;
            
            // 添加每个实体的行
            entities.forEach(entityId => {
                const stats = statsForDate[entityId];
                totalTime += stats.durationMs;
                totalUserMsgs += stats.userMessages;
                totalAiMsgs += stats.aiMessages;
                totalTokens += stats.totalTokens;
                
                tableBody.append(`
                    <tr>
                        <td>${stats.name || getEntityName(entityId)}</td>
                        <td>${stats.type || getEntityType(entityId)}</td>
                        <td>${formatDuration(stats.durationMs)}</td>
                        <td>${stats.userMessages}</td>
                        <td>${stats.aiMessages}</td>
                        <td>${stats.totalTokens.toLocaleString()}</td>
                    </tr>
                `);
            });
            
            // 添加总计行
            tableBody.append(`
                <tr class="stats-total-row">
                    <td><strong>总计</strong></td>
                    <td>-</td>
                    <td><strong>${formatDuration(totalTime)}</strong></td>
                    <td><strong>${totalUserMsgs}</strong></td>
                    <td><strong>${totalAiMsgs}</strong></td>
                    <td><strong>${totalTokens.toLocaleString()}</strong></td>
                </tr>
            `);
            
        } catch (error) {
            console.error(`[${extensionName}] Error displaying character stats:`, error);
            tableBody.append(`
                <tr>
                    <td colspan="6" class="no-data">加载统计数据时出错</td>
                </tr>
            `);
        }
    }

    // --- UI Rendering and Event Handling ---
    function renderDurationList() {
        const listElement = $('#usageTracker_durationThresholdsList');
        listElement.empty();
        settings.durationThresholds.forEach((threshold, index) => {
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
        settings.fixedTimeThresholds.forEach((threshold, index) => {
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

    function bindUIEvents() {
        // General
        $('#usageTracker_enabled').on('change', function() {
            settings.enabled = $(this).is(':checked');
            saveSettingsDebounced();
            initializeTracking(); // Re-initialize to start/stop timer
            
            // 同时控制角色统计
            if (settings.enabled && settings.enableCharStats) {
                initCharStatsTracking();
            } else if (charStatsIntervalId) {
                clearInterval(charStatsIntervalId);
                charStatsIntervalId = null;
            }
        });
        $('#usageTracker_notifyType').on('change', function() {
            settings.notifyType = $(this).val();
            saveSettingsDebounced();
            if (settings.notifyType === 'browser' || settings.notifyType === 'both') {
                 $('#usageTracker_requestNotifyPermission').show();
                 requestNotificationPermission(); // Request immediately if selected
            } else {
                 $('#usageTracker_requestNotifyPermission').hide();
            }
        });
         $('#usageTracker_requestNotifyPermission').on('click', requestNotificationPermission);

        // Duration Tracking
        $('#usageTracker_enableDurationTracking').on('change', function() {
            settings.enableDurationTracking = $(this).is(':checked');
            saveSettingsDebounced();
        });
        $('#usageTracker_gracePeriod').on('input', function() {
            const val = parseInt($(this).val());
            if (!isNaN(val) && val >= 0) {
                settings.gracePeriodMinutes = val;
                saveSettingsDebounced();
            }
        });
        $('#usageTracker_addDuration').on('click', function() {
            const input = $('#usageTracker_newDuration');
            const value = parseFloat(input.val());
            if (!isNaN(value) && value > 0) {
                // Avoid duplicates
                if (!settings.durationThresholds.some(t => t.value === value)) {
                    settings.durationThresholds.push({ value: value, enabled: true });
                    settings.durationThresholds.sort((a, b) => a.value - b.value); // Keep sorted
                    saveSettingsDebounced();
                    renderDurationList();
                    input.val(''); // Clear input
                } else {
                     toastr.warning(`阈值 ${value} 小时已存在。`);
                }
            } else {
                toastr.warning('请输入有效的持续时间（大于0的小时数）。');
            }
        });
        $('#usageTracker_durationThresholdsList').on('click', '.delete-duration', function() {
            const index = $(this).closest('.threshold-item').data('index');
            settings.durationThresholds.splice(index, 1);
            saveSettingsDebounced();
            renderDurationList();
        });
         $('#usageTracker_durationThresholdsList').on('change', '.duration-enable-checkbox', function() {
            const index = $(this).closest('.threshold-item').data('index');
            settings.durationThresholds[index].enabled = $(this).is(':checked');
            saveSettingsDebounced();
        });

        // Fixed Time Tracking
         $('#usageTracker_enableFixedTimeTracking').on('change', function() {
            settings.enableFixedTimeTracking = $(this).is(':checked');
            saveSettingsDebounced();
        });
        $('#usageTracker_addFixedTime').on('click', function() {
            const input = $('#usageTracker_newFixedTime');
            const value = input.val(); // HH:MM format
            if (value) {
                 // Avoid duplicates
                 if (!settings.fixedTimeThresholds.some(t => t.value === value)) {
                    settings.fixedTimeThresholds.push({ value: value, enabled: true });
                     settings.fixedTimeThresholds.sort((a, b) => a.value.localeCompare(b.value)); // Keep sorted
                    saveSettingsDebounced();
                    renderFixedTimeList();
                    // input.val(''); // Don't clear time input, user might want small adjustments
                 } else {
                      toastr.warning(`时间点 ${value} 已存在。`);
                 }
            } else {
                 toastr.warning('请选择一个有效的时间点。');
            }
        });
        $('#usageTracker_fixedTimesList').on('click', '.delete-fixedtime', function() {
            const index = $(this).closest('.threshold-item').data('index');
            settings.fixedTimeThresholds.splice(index, 1);
            saveSettingsDebounced();
            renderFixedTimeList();
        });
         $('#usageTracker_fixedTimesList').on('change', '.fixedtime-enable-checkbox', function() {
            const index = $(this).closest('.threshold-item').data('index');
            settings.fixedTimeThresholds[index].enabled = $(this).is(':checked');
            saveSettingsDebounced();
        });

        // 新增：角色统计相关UI事件
        $('#usageTracker_enableCharStats').on('change', function() {
            settings.enableCharStats = $(this).is(':checked');
            saveSettingsDebounced();
            
            if (settings.enableCharStats && settings.enabled) {
                initCharStatsTracking();
            } else if (charStatsIntervalId) {
                clearInterval(charStatsIntervalId);
                charStatsIntervalId = null;
            }
        });
        
        $('#usageTracker_refreshStats').on('click', function() {
            const selectedDate = $('#usageTracker_statsDate').val();
            displayCharStats(selectedDate);
        });

        // Activity listeners
        $(document).on('mousemove keydown click scroll', updateLastActive); // Consider throttling these
        $(window).on('beforeunload', updateLastActive);
        $(document).on('visibilitychange', () => {
             if (document.hidden) {
                 updateLastActive();
             } else {
                 // When tab becomes visible again, re-check state immediately
                 // This handles the case where the interval might have missed the exact moment
                 // the user came back within the grace period.
                 initializeTracking();
             }
             
             // 添加对角色统计的处理
             handleVisibilityChange();
         });
         
        // 新增：监听SillyTavern事件
        eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
        eventSource.on(event_types.MESSAGE_SENT, handleMessageSent);
        eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);
    }

    // --- Load Settings and Initialize ---
    async function loadSettings() {
        // Ensure the global settings object has the key for this extension
        extension_settings[extensionName] = extension_settings[extensionName] || {};

        // Merge defaults with saved settings
        settings = { ...defaultSettings, ...extension_settings[extensionName] };

        // Ensure arrays exist and have the correct structure
        settings.durationThresholds = (settings.durationThresholds || [])
            .map(t => (typeof t === 'number' ? { value: t, enabled: true } : t)) // Handle old format if necessary
            .filter(t => typeof t === 'object' && typeof t.value === 'number' && typeof t.enabled === 'boolean');
        settings.fixedTimeThresholds = (settings.fixedTimeThresholds || [])
             .map(t => (typeof t === 'string' ? { value: t, enabled: true } : t)) // Handle old format if necessary
             .filter(t => typeof t === 'object' && typeof t.value === 'string' && typeof t.enabled === 'boolean');
             
        // 新增：确保角色统计数据结构存在
        settings.characterStats = settings.characterStats || {};


        // Update the UI elements with loaded settings
        $('#usageTracker_enabled').prop('checked', settings.enabled);
        $('#usageTracker_notifyType').val(settings.notifyType);
        $('#usageTracker_requestNotifyPermission').toggle(settings.notifyType === 'browser' || settings.notifyType === 'both');
        $('#usageTracker_enableDurationTracking').prop('checked', settings.enableDurationTracking);
        $('#usageTracker_gracePeriod').val(settings.gracePeriodMinutes);
        $('#usageTracker_enableFixedTimeTracking').prop('checked', settings.enableFixedTimeTracking);
        
        // 新增：设置角色统计相关UI元素
        $('#usageTracker_enableCharStats').prop('checked', settings.enableCharStats);
        
        // 设置日期选择器默认为今天
        const today = getTodayDateString();
        const savedStatsDate = localStorage.getItem(LS_ENTITY_STATS_DATE) || today;
        $('#usageTracker_statsDate').val(savedStatsDate);
        
        // 显示统计数据
        displayCharStats(savedStatsDate);

        renderDurationList();
        renderFixedTimeList();
        log("设置已加载。")
    }

    // --- Plugin Entry Point ---
    jQuery(async () => {
        log("插件加载中...");
        try {
            const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
            $("#extensions_settings").append(settingsHtml);
            await loadSettings(); // Load settings first to have them available
            bindUIEvents();
            initializeTracking(); // Start the main logic
            initCharStatsTracking(); // 新增角色统计功能
            log("插件 UI 和事件已绑定。");
        } catch (error) {
             console.error(`[${extensionName}] Error loading settings.html or initializing:`, error);
             toastr.error("使用时长追踪插件加载失败。");
        }
    });

})();
