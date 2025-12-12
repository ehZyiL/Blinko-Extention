import {showStatus, hideStatus} from './ui.js';
import {getCleanDomainUrl, normalizeBlinkoApiBaseUrl, normalizeAuthToken, uploadFile} from './api.js';

// 保存快捷记录内容
function saveQuickNote() {
    const input = document.getElementById('quickNoteInput');
    if (input && input.value.trim()) {
        chrome.storage.local.set({ 'quickNote': input.value });
    }
}

// 加载快捷记录内容
async function loadQuickNote() {
    try {
        // 加载文本内容
        const result = await chrome.storage.local.get(['quickNote', 'quickNoteAttachments']);
        if (result.quickNote) {
            document.getElementById('quickNoteInput').value = result.quickNote;
        }

        // 加载并显示附件
        if (result.quickNoteAttachments && result.quickNoteAttachments.length > 0) {
            // 为每个没有localUrl的附件创建本地URL
            const attachments = await Promise.all(result.quickNoteAttachments.map(async (attachment) => {
                if (!attachment.localUrl && attachment.originalUrl) {
                    try {
                        const response = await fetch(attachment.originalUrl);
                        const blob = await response.blob();
                        attachment.localUrl = URL.createObjectURL(blob);
                    } catch (error) {
                        console.error('创建本地URL失败:', error);
                    }
                }
                return attachment;
            }));

            // 更新存储中的附件信息
            await chrome.storage.local.set({ 'quickNoteAttachments': attachments });
            
            // 显示附件
            updateAttachmentList(attachments);
        }
    } catch (error) {
        console.error('加载快捷记录失败:', error);
    }
}

// 更新附件列表显示
async function updateAttachmentList(attachments) {
    const attachmentItems = document.getElementById('attachmentItems');
    const clearAttachmentsBtn = document.getElementById('clearAttachments');
    
    // 清空现有内容
    attachmentItems.innerHTML = '';
    
    // 如果有附件，显示清除按钮
    clearAttachmentsBtn.style.display = attachments.length > 0 ? 'block' : 'none';

    // 获取设置信息
    const result = await chrome.storage.sync.get('settings');
    const settings = result.settings;
    
    if (!settings || !settings.targetUrl) {
        console.error('未找到设置信息');
        return;
    }

    // 添加附件项
    attachments.forEach((attachment, index) => {
        const item = document.createElement('div');
        item.className = 'attachment-item';
        
        // 创建图片预览
        const img = document.createElement('img');
        
        // 优先使用本地图片URL，如果不存在则使用Blinko URL
        if (attachment.localUrl) {
            img.src = attachment.localUrl;
        } else if (attachment.path) {
            // 使用Blinko URL作为后备
            const cleanDomain = getCleanDomainUrl(settings.targetUrl);
            const path = attachment.path.startsWith('/') ? attachment.path : '/' + attachment.path;
            img.src = cleanDomain + path;
        }
        
        img.alt = attachment.name || '附件图片';
        img.onerror = () => {
            // 如果图片加载失败，显示文件名
            img.style.display = 'none';
            const textSpan = document.createElement('span');
            textSpan.textContent = attachment.name || '图片';
            textSpan.style.display = 'block';
            textSpan.style.padding = '8px';
            textSpan.style.textAlign = 'center';
            item.insertBefore(textSpan, img);
        };
        item.appendChild(img);
        
        // 创建删除按钮
        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-button';
        removeBtn.innerHTML = '×';
        removeBtn.title = '移除附件';
        removeBtn.onclick = () => removeAttachment(index);
        item.appendChild(removeBtn);
        
        attachmentItems.appendChild(item);
    });
}

// 清理图片缓存
function clearImageCache(attachments) {
    if (Array.isArray(attachments)) {
        attachments.forEach(attachment => {
            if (attachment.localUrl) {
                URL.revokeObjectURL(attachment.localUrl);
            }
        });
    }
}

// 清除所有附件
async function clearAttachments() {
    try {
        // 获取当前附件列表以清理缓存
        const result = await chrome.storage.local.get('quickNoteAttachments');
        if (result.quickNoteAttachments) {
            clearImageCache(result.quickNoteAttachments);
        }
        await chrome.storage.local.remove('quickNoteAttachments');
        updateAttachmentList([]);
    } catch (error) {
        console.error('清除附件失败:', error);
        showStatus('清除附件失败: ' + error.message, 'error');
    }
}

// 移除单个附件
async function removeAttachment(index) {
    try {
        const result = await chrome.storage.local.get('quickNoteAttachments');
        let attachments = result.quickNoteAttachments || [];
        
        // 清理要移除的附件的图片缓存
        if (attachments[index] && attachments[index].localUrl) {
            URL.revokeObjectURL(attachments[index].localUrl);
        }
        
        // 移除指定索引的附件
        attachments.splice(index, 1);
        
        // 保存更新后的附件列表
        await chrome.storage.local.set({ 'quickNoteAttachments': attachments });
        
        // 更新显示
        updateAttachmentList(attachments);
    } catch (error) {
        console.error('移除附件失败:', error);
        showStatus('移除附件失败: ' + error.message, 'error');
    }
}

// 清除快捷记录内容
function clearQuickNote() {
    const input = document.getElementById('quickNoteInput');
    if (input) {
        input.value = '';
        // 获取当前附件列表以清理缓存
        chrome.storage.local.get(['quickNoteAttachments'], result => {
            if (result.quickNoteAttachments) {
                clearImageCache(result.quickNoteAttachments);
            }
            // 清除storage中的数据
            chrome.storage.local.remove(['quickNote', 'quickNoteAttachments']);
            // 更新附件列表显示
            updateAttachmentList([]);
        });
    }
}

// 发送快捷记录
async function sendQuickNote() {
    try {
        const input = document.getElementById('quickNoteInput');
        const content = input.value;
        if (!content.trim()) {
            showStatus('请输入笔记内容', 'error');
            return;
        }

        const result = await chrome.storage.sync.get('settings');
        const settings = result.settings;
        
        if (!settings) {
            throw new Error('未找到设置信息');
        }

        showStatus('正在发送...', 'loading');

        // 获取当前标签页信息
        let url = '';
        let title = '';
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                url = tab.url;
                title = tab.title;
            }
        } catch (error) {
            console.error('获取当前标签页信息失败:', error);
        }

        // 获取附件列表
        const attachmentsResult = await chrome.storage.local.get(['quickNoteAttachments']);
        const attachments = attachmentsResult.quickNoteAttachments || [];

        // 发送消息并等待saveSummaryResponse
        const responsePromise = new Promise((resolve) => {
            const listener = (message) => {
                if (message.action === 'saveSummaryResponse') {
                    chrome.runtime.onMessage.removeListener(listener);
                    resolve(message.response);
                }
            };
            chrome.runtime.onMessage.addListener(listener);
            
            // 发送请求
            chrome.runtime.sendMessage({
                action: 'saveSummary',
                type: 'quickNote',
                content: content.trim(),
                url: url,
                title: title,
                attachments: attachments
            });
        });

        // 等待响应
        const response = await responsePromise;

        if (response && response.success) {
            showStatus('发送成功', 'success');
            // 发送成功后清理图片缓存
            clearImageCache(attachments);
            // 清除内容和存储
            input.value = '';
            await chrome.storage.local.remove(['quickNote', 'quickNoteAttachments']);
            // 立即更新附件列表显示
            updateAttachmentList([]);
        } else {
            showStatus('发送失败: ' + (response?.error || '未知错误'), 'error');
        }
    } catch (error) {
        showStatus('发送失败: ' + error.message, 'error');
    }
}


// 国际化辅助函数
function i18n(key, substitutions) {
    return chrome.i18n.getMessage(key, substitutions) || key;
}

// 网页链接提取功能
async function getCurrentPageLink() {
    try {
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});

        if (!tab) {
            throw new Error(i18n('cannotGetPageInfo'));
        }

        const restrictedProtocols = ['chrome:', 'chrome-extension:', 'moz-extension:', 'edge:', 'about:'];
        if (restrictedProtocols.some(protocol => tab.url.toLowerCase().startsWith(protocol))) {
            throw new Error(i18n('restrictedPageError'));
        }

        const title = tab.title || i18n('defaultPage');
        const url = tab.url;
        const markdown = `[${title}](${url})`;

        return {title, url, markdown};
    } catch (error) {
        console.error('获取页面链接失败:', error);
        throw error;
    }
}

// 插入链接到光标位置
function insertLinkAtCursor(markdown) {
    const textArea = document.getElementById('quickNoteInput');
    if (!textArea) return;

    const start = textArea.selectionStart;
    const end = textArea.selectionEnd;
    const currentValue = textArea.value;

    const newValue = currentValue.substring(0, start) + markdown + currentValue.substring(end);
    textArea.value = newValue;

    const newCursorPosition = start + markdown.length;
    textArea.setSelectionRange(newCursorPosition, newCursorPosition);

    textArea.dispatchEvent(new Event('input', {bubbles: true}));
    textArea.focus();
}

// 获取并插入页面链接
async function handleGetPageLink() {
    try {
        showStatus(i18n('gettingPageLink'), 'loading');
        const linkInfo = await getCurrentPageLink();
        insertLinkAtCursor(linkInfo.markdown);
        showStatus(i18n('linkInserted'), 'success');
        // 2秒后自动隐藏成功提示
        setTimeout(hideStatus, 2000);
    } catch (error) {
        console.error('获取页面链接失败:', error);
        showStatus(i18n('getLinkFailed', [error.message]), 'error');
        // 3秒后自动隐藏错误提示
        setTimeout(hideStatus, 3000);
    }
}

// 标签管理功能
async function fetchBlinkoTags() {
    try {
        const result = await chrome.storage.sync.get('settings');
        const settings = result.settings;

        if (!settings || !settings.targetUrl) {
            throw new Error(i18n('blinkoServerNotConfigured'));
        }

        if (!settings.authKey) {
            throw new Error(i18n('authTokenNotFound'));
        }

        const normalizedBaseUrl = normalizeBlinkoApiBaseUrl(settings.targetUrl);
        const possibleEndpoints = [
            `${normalizedBaseUrl}/tags/list`,
            `${normalizedBaseUrl}/tag/list`,
            `${normalizedBaseUrl}/tags`,
            `${normalizedBaseUrl}/tag`
        ];

        let response = null;
        let lastError = null;

        for (const endpoint of possibleEndpoints) {
            try {
                response = await fetch(endpoint, {
                    method: 'GET',
                    headers: {
                        'Authorization': normalizeAuthToken(settings.authKey),
                        'Content-Type': 'application/json'
                    }
                });

                if (response.ok) {
                    break;
                } else {
                    const errorText = await response.text().catch(() => '');
                    lastError = `${endpoint}: ${response.status} ${response.statusText}${errorText ? ' - ' + errorText : ''}`;
                }
            } catch (error) {
                lastError = `${endpoint}: ${error.message}`;
            }
        }

        if (!response || !response.ok) {
            throw new Error(i18n('allTagEndpointsFailed', [lastError || 'unknown']));
        }

        const data = await response.json();

        if (!Array.isArray(data)) {
            if (data && typeof data === 'object') {
                const possibleArrayFields = ['data', 'tags', 'items', 'list', 'results'];
                for (const field of possibleArrayFields) {
                    if (Array.isArray(data[field])) {
                        return buildTagHierarchy(data[field]);
                    }
                }
            }
            throw new Error(i18n('apiResponseFormatError', [typeof data]));
        }

        return buildTagHierarchy(data);
    } catch (error) {
        console.error('获取Blinko标签失败:', error);
        throw error;
    }
}

// 构建标签层级结构
function buildTagHierarchy(tags) {
    if (!Array.isArray(tags)) return [];

    const tagMap = new Map();
    const rootTags = [];

    tags.forEach(tag => {
        tagMap.set(tag.id, {...tag, children: []});
    });

    tags.forEach(tag => {
        const tagNode = tagMap.get(tag.id);

        if (tag.parent && tagMap.has(tag.parent)) {
            const parentTag = tagMap.get(tag.parent);
            parentTag.children.push(tagNode);
        } else {
            rootTags.push(tagNode);
        }
    });

    const sortTags = (tagArray) => {
        tagArray.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
        tagArray.forEach(tag => {
            if (tag.children && tag.children.length > 0) {
                sortTags(tag.children);
            }
        });
    };

    sortTags(rootTags);
    return rootTags;
}

// Markdown格式化功能
function insertAtCursor(text) {
    const textArea = document.getElementById('quickNoteInput');
    if (!textArea) return;

    const start = textArea.selectionStart;
    const end = textArea.selectionEnd;
    const currentValue = textArea.value;

    const newValue = currentValue.substring(0, start) + text + currentValue.substring(end);
    textArea.value = newValue;

    const newCursorPosition = start + text.length;
    textArea.setSelectionRange(newCursorPosition, newCursorPosition);

    textArea.dispatchEvent(new Event('input', {bubbles: true}));
    textArea.focus();
}

function wrapSelectedText(prefix, suffix = '') {
    const textArea = document.getElementById('quickNoteInput');
    if (!textArea) return;

    const start = textArea.selectionStart;
    const end = textArea.selectionEnd;
    const selectedText = textArea.value.substring(start, end);

    if (selectedText) {
        const wrappedText = prefix + selectedText + suffix;
        const newValue = textArea.value.substring(0, start) + wrappedText + textArea.value.substring(end);
        textArea.value = newValue;

        const newStart = start + prefix.length;
        const newEnd = newStart + selectedText.length;
        textArea.setSelectionRange(newStart, newEnd);
    } else {
        const placeholder = prefix + suffix;
        insertAtCursor(placeholder);

        const newPosition = start + prefix.length;
        textArea.setSelectionRange(newPosition, newPosition);
    }

    textArea.dispatchEvent(new Event('input', {bubbles: true}));
    textArea.focus();
}

// Markdown格式化函数

// 智能插入：如果光标不在行首，先换行再插入
function insertAtLineStart(text) {
    const textArea = document.getElementById('quickNoteInput');
    if (!textArea) return;

    const start = textArea.selectionStart;
    const currentValue = textArea.value;

    // 检查光标前是否需要换行
    let prefix = '';
    if (start > 0) {
        const charBefore = currentValue.charAt(start - 1);
        if (charBefore !== '\n') {
            prefix = '\n';
        }
    }

    const newText = prefix + text;
    const newValue = currentValue.substring(0, start) + newText + currentValue.substring(start);
    textArea.value = newValue;

    const newCursorPosition = start + newText.length;
    textArea.setSelectionRange(newCursorPosition, newCursorPosition);

    textArea.dispatchEvent(new Event('input', {bubbles: true}));
    textArea.focus();
}

function insertTodoItem() {
    insertAtLineStart('- [ ] ');
}

function insertUnorderedList() {
    insertAtLineStart('- ');
}

function insertOrderedList() {
    insertAtLineStart('1. ');
}

function insertCodeBlock() {
    const textArea = document.getElementById('quickNoteInput');
    const start = textArea.selectionStart;
    const currentValue = textArea.value;
    const selectedText = currentValue.substring(start, textArea.selectionEnd);

    // 检查是否需要在代码块前换行
    let prefix = '';
    if (start > 0 && currentValue.charAt(start - 1) !== '\n') {
        prefix = '\n';
    }

    if (selectedText) {
        const newValue = currentValue.substring(0, start) + prefix + '```\n' + selectedText + '\n```' + currentValue.substring(textArea.selectionEnd);
        textArea.value = newValue;
        const newPosition = start + prefix.length + 4;
        textArea.setSelectionRange(newPosition, newPosition + selectedText.length);
    } else {
        const newValue = currentValue.substring(0, start) + prefix + '```\n\n```' + currentValue.substring(start);
        textArea.value = newValue;
        const newPosition = start + prefix.length + 4;
        textArea.setSelectionRange(newPosition, newPosition);
    }

    textArea.dispatchEvent(new Event('input', {bubbles: true}));
    textArea.focus();
}

function insertQuote() {
    insertAtLineStart('> ');
}

function insertBold() {
    wrapSelectedText('**', '**');
}

function insertItalic() {
    wrapSelectedText('*', '*');
}

// 初始化快捷记录相关的事件监听器
function initializeQuickNoteListeners() {
    document.getElementById('quickNoteInput').addEventListener('input', saveQuickNote);
    document.getElementById('sendQuickNote').addEventListener('click', sendQuickNote);
    document.getElementById('clearQuickNote').addEventListener('click', clearQuickNote);
    document.getElementById('clearAttachments').addEventListener('click', clearAttachments);

    // 初始化附件上传功能
    initializeAttachmentUpload();

    // 初始化增强功能
    initializeEnhancedFeatures();
}

// 初始化附件上传功能
function initializeAttachmentUpload() {
    const addAttachmentBtn = document.getElementById('addAttachment');
    const attachmentInput = document.getElementById('attachmentInput');

    if (addAttachmentBtn && attachmentInput) {
        addAttachmentBtn.addEventListener('click', () => {
            attachmentInput.click();
        });

        attachmentInput.addEventListener('change', handleAttachmentUpload);
    }
}

// 处理附件上传
async function handleAttachmentUpload(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    try {
        showStatus(i18n('uploadingAttachment'), 'loading');

        // 获取设置
        const result = await chrome.storage.sync.get('settings');
        const settings = result.settings;

        if (!settings || !settings.targetUrl) {
            throw new Error(i18n('blinkoServerNotConfigured'));
        }

        // 获取当前附件列表
        const quickNoteResult = await chrome.storage.local.get(['quickNoteAttachments']);
        let attachments = quickNoteResult.quickNoteAttachments || [];

        // 上传每个文件
        for (const file of files) {
            const imageAttachment = await uploadFile(file, settings);

            // 创建本地URL用于预览
            const localUrl = URL.createObjectURL(file);

            attachments.push({
                ...imageAttachment,
                localUrl: localUrl,
                originalUrl: localUrl
            });
        }

        // 保存更新后的附件列表
        await chrome.storage.local.set({'quickNoteAttachments': attachments});

        // 更新显示
        updateAttachmentList(attachments);

        showStatus(i18n('attachmentUploaded'), 'success');
        setTimeout(hideStatus, 2000);
    } catch (error) {
        console.error('上传附件失败:', error);
        showStatus(i18n('attachmentUploadFailed', [error.message]), 'error');
        setTimeout(hideStatus, 3000);
    }

    // 清空input以便可以再次选择相同文件
    event.target.value = '';
}

// 初始化增强功能
function initializeEnhancedFeatures() {
    // 创建增强工具栏
    createEnhancedToolbar();

    // 初始化键盘快捷键
    initializeKeyboardShortcuts();
}

// 创建增强工具栏
function createEnhancedToolbar() {
    const quickNoteInput = document.getElementById('quickNoteInput');
    if (!quickNoteInput) return;

    // 创建工具栏容器
    const toolbar = document.createElement('div');
    toolbar.className = 'enhanced-toolbar';
    toolbar.innerHTML = `
        <div class="toolbar-section link-tools">
            <button id="todoBtn" class="toolbar-btn" title="${i18n('insertTodoTooltip')}">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M14 1a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h12zM2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2H2z"/>
                    <path d="M10.97 4.97a.75.75 0 0 1 1.071 1.05l-3.992 4.99a.75.75 0 0 1-1.08.02L4.324 8.384a.75.75 0 1 1 1.06-1.06l2.094 2.093 3.473-4.425a.235.235 0 0 1 .02-.022z"/>
                </svg>
            </button>
            <button id="codeBtn" class="toolbar-btn" title="${i18n('insertCodeBlockTooltip')}">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M5.854 4.854a.5.5 0 1 0-.708-.708l-3.5 3.5a.5.5 0 0 0 0 .708l3.5 3.5a.5.5 0 0 0 .708-.708L2.707 8l3.147-3.146zm4.292 0a.5.5 0 0 1 .708-.708l3.5 3.5a.5.5 0 0 1 0 .708l-3.5 3.5a.5.5 0 0 1-.708-.708L13.293 8l-3.147-3.146z"/>
                </svg>
            </button>
            <button id="quoteBtn" class="toolbar-btn" title="${i18n('insertQuoteTooltip')}">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M12 12a1 1 0 0 0 1-1V8.558a1 1 0 0 0-1-1h-1.388c0-.351.021-.703.062-1.054.062-.372.166-.703.31-.992.145-.29.331-.517.559-.683.227-.186.516-.279.868-.279V3c-.579 0-1.085.124-1.52.372a3.322 3.322 0 0 0-1.085.992 4.92 4.92 0 0 0-.62 1.458A7.712 7.712 0 0 0 9 7.558V11a1 1 0 0 0 1 1h2Zm-6 0a1 1 0 0 0 1-1V8.558a1 1 0 0 0-1-1H4.612c0-.351.021-.703.062-1.054.062-.372.166-.703.31-.992.145-.29.331-.517.559-.683.227-.186.516-.279.868-.279V3c-.579 0-1.085.124-1.52.372a3.322 3.322 0 0 0-1.085.992 4.92 4.92 0 0 0-.62 1.458A7.712 7.712 0 0 0 3 7.558V11a1 1 0 0 0 1 1h2Z"/>
                </svg>
            </button>
            <button id="ulBtn" class="toolbar-btn" title="${i18n('insertUnorderedListTooltip')}">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path fill-rule="evenodd" d="M5 11.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm-3 1a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm0 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm0 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/>
                </svg>
            </button>
            <button id="olBtn" class="toolbar-btn" title="${i18n('insertOrderedListTooltip')}">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path fill-rule="evenodd" d="M5 11.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5z"/>
                    <path d="M1.713 11.865v-.474H2c.217 0 .363-.137.363-.317 0-.185-.158-.31-.361-.31-.223 0-.367.152-.373.31h-.59c.016-.467.373-.787.986-.787.588-.002.954.291.957.703a.595.595 0 0 1-.492.594v.033a.615.615 0 0 1 .569.631c.003.533-.502.8-1.051.8-.656 0-1-.37-1.008-.794h.582c.008.178.186.306.422.309.254 0 .424-.145.422-.35-.002-.195-.155-.348-.414-.348h-.3zm-.004-4.699h-.604v-.035c0-.408.295-.844.958-.844.583 0 .96.326.96.756 0 .389-.257.617-.476.848l-.537.572v.03h1.054V9H1.143v-.395l.957-.99c.138-.142.293-.304.293-.508 0-.18-.147-.32-.342-.32a.33.33 0 0 0-.342.338v.041zM2.564 5h-.635V2.924h-.031l-.598.42v-.567l.629-.443h.635V5z"/>
                </svg>
            </button>
            <button id="boldBtn" class="toolbar-btn" title="${i18n('boldFormatTooltip')}">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8.21 13c2.106 0 3.412-1.087 3.412-2.823 0-1.306-.984-2.283-2.324-2.386v-.055a2.176 2.176 0 0 0 1.852-2.14c0-1.51-1.162-2.46-3.014-2.46H3.843V13H8.21zM5.908 4.674h1.696c.963 0 1.517.451 1.517 1.244 0 .834-.629 1.32-1.73 1.32H5.908V4.673zm0 6.788V8.598h1.73c1.217 0 1.88.492 1.88 1.415 0 .943-.643 1.449-1.832 1.449H5.907z"/>
                </svg>
            </button>
            <button id="italicBtn" class="toolbar-btn" title="${i18n('italicFormatTooltip')}">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M7.991 11.674 9.53 4.455c.123-.595.246-.71 1.347-.807l.11-.52H7.211l-.11.52c1.06.096 1.128.212 1.005.807L6.57 11.674c-.123.595-.246.71-1.346.806l-.11.52h3.774l.11-.52c-1.06-.095-1.129-.211-1.006-.806z"/>
                </svg>
            </button>
            <button id="getLinkBtn" class="toolbar-btn" title="${i18n('insertPageLinkTooltip')}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
            </button>
            <button id="tagBtn" class="toolbar-btn" title="${i18n('tagSelectorTooltip')}">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M2 2a1 1 0 0 1 1-1h4.586a1 1 0 0 1 .707.293l7 7a1 1 0 0 1 0 1.414l-4.586 4.586a1 1 0 0 1-1.414 0l-7-7A1 1 0 0 1 2 6.586V2zm3.5 4a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/>
                </svg>
            </button>
        </div>
    `;

    // 创建标签面板
    const tagPanel = document.createElement('div');
    tagPanel.id = 'tagPanel';
    tagPanel.className = 'tag-panel';
    tagPanel.style.display = 'none';
    tagPanel.innerHTML = `
        <div class="tag-panel-header">
            <span class="tag-panel-title">${i18n('tagSelectorTitle')}</span>
            <div class="tag-panel-controls">
                <button id="expandAllTags" class="control-btn" title="${i18n('expandAllTooltip')}">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                        <path d="M2 3h8v1H2V3zm0 2h8v1H2V5zm0 2h8v1H2V7z"/>
                    </svg>
                </button>
                <button id="collapseAllTags" class="control-btn" title="${i18n('collapseAllTooltip')}">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                        <path d="M2 5h8v2H2V5z"/>
                    </svg>
                </button>
                <button id="closeTagPanel" class="control-btn close-btn" title="${i18n('closePanelTooltip')}">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                        <path d="M9.5 2.5L6 6l3.5 3.5-1 1L5 7l-3.5 3.5-1-1L4 6 0.5 2.5l1-1L5 5l3.5-3.5z"/>
                    </svg>
                </button>
            </div>
        </div>
        <div class="tag-panel-content">
            <div class="tag-loading">${i18n('loadingTags')}</div>
        </div>
    `;

    // 插入到快捷记录区域
    quickNoteInput.parentNode.insertBefore(toolbar, quickNoteInput.nextSibling);
    // 将标签面板插入到工具栏内部，使用绝对定位浮动显示
    toolbar.appendChild(tagPanel);

    // 绑定事件监听器
    bindToolbarEvents();

    // 添加样式
    addEnhancedStyles();
}

// 绑定工具栏事件
function bindToolbarEvents() {
    // 获取链接按钮
    document.getElementById('getLinkBtn')?.addEventListener('click', handleGetPageLink);

    // 标签按钮
    document.getElementById('tagBtn')?.addEventListener('click', toggleTagPanel);

    // 关闭标签面板按钮
    document.getElementById('closeTagPanel')?.addEventListener('click', hideTagPanel);

    // 展开/折叠标签按钮
    document.getElementById('expandAllTags')?.addEventListener('click', expandAllTags);
    document.getElementById('collapseAllTags')?.addEventListener('click', collapseAllTags);

    // Markdown格式按钮
    document.getElementById('todoBtn')?.addEventListener('click', insertTodoItem);
    document.getElementById('codeBtn')?.addEventListener('click', insertCodeBlock);
    document.getElementById('quoteBtn')?.addEventListener('click', insertQuote);
    document.getElementById('ulBtn')?.addEventListener('click', insertUnorderedList);
    document.getElementById('olBtn')?.addEventListener('click', insertOrderedList);
    document.getElementById('boldBtn')?.addEventListener('click', insertBold);
    document.getElementById('italicBtn')?.addEventListener('click', insertItalic);

    // 点击面板外部关闭面板
    document.addEventListener('click', (event) => {
        const tagPanel = document.getElementById('tagPanel');
        const tagBtn = document.getElementById('tagBtn');
        if (tagPanel && tagPanel.style.display !== 'none' &&
            !tagPanel.contains(event.target) &&
            !tagBtn.contains(event.target)) {
            hideTagPanel();
        }
    });
}

export {
    saveQuickNote,
    loadQuickNote,
    clearQuickNote,
    sendQuickNote,
    initializeQuickNoteListeners,
    updateAttachmentList,
    clearImageCache,
    // 增强功能导出
    getCurrentPageLink,
    insertLinkAtCursor,
    handleGetPageLink,
    fetchBlinkoTags,
    insertTag,
    insertTodoItem,
    insertCodeBlock,
    insertQuote,
    insertBold,
    insertItalic
};
// 标签面板相关功能
let isTagPanelOpen = false;

async function toggleTagPanel() {
    if (isTagPanelOpen) {
        hideTagPanel();
    } else {
        await showTagPanel();
    }
}

async function showTagPanel() {
    try {
        isTagPanelOpen = true;
        const tagPanel = document.getElementById('tagPanel');

        // 显示面板
        tagPanel.style.display = 'block';

        // 加载标签
        await loadTags();

    } catch (error) {
        console.error('显示标签面板失败:', error);
        showStatus('加载标签失败: ' + error.message, 'error');
        isTagPanelOpen = false;
    }
}

function hideTagPanel() {
    if (!isTagPanelOpen) return;

    isTagPanelOpen = false;
    const tagPanel = document.getElementById('tagPanel');
    if (tagPanel) {
        tagPanel.style.display = 'none';
    }
}

async function loadTags() {
    const contentElement = document.querySelector('.tag-panel-content');
    if (!contentElement) return;

    try {
        // 显示加载状态
        contentElement.innerHTML = `<div class="tag-loading">${i18n('loadingTags')}</div>`;

        // 获取标签
        const tags = await fetchBlinkoTags();

        // 渲染标签树
        const tagTree = renderTagTree(tags);
        contentElement.innerHTML = '';
        contentElement.appendChild(tagTree);

    } catch (error) {
        console.error('加载标签失败:', error);

        let userMessage = error.message;
        if (error.message.includes('认证') || error.message.includes('token') || error.message.includes('authKey') || error.message.includes('auth')) {
            userMessage = i18n('authFailedCheckKey');
        } else if (error.message.includes('端点') || error.message.includes('endpoint') || error.message.includes('connect')) {
            userMessage = i18n('cannotConnectTagService');
        }

        contentElement.innerHTML = `
            <div class="tag-error">
                <div class="error-message">${i18n('loadTagsFailed')}</div>
                <div class="error-detail">${userMessage}</div>
                <div class="error-actions">
                    <button class="retry-btn" onclick="loadTags()">${i18n('retryButton')}</button>
                </div>
            </div>
        `;
    }
}

// 渲染标签树
function renderTagTree(tags) {
    const container = document.createElement('div');
    container.className = 'tag-tree';

    if (!tags || tags.length === 0) {
        const emptyMessage = document.createElement('div');
        emptyMessage.className = 'tag-empty-message';
        emptyMessage.textContent = i18n('noTagsAvailable');
        container.appendChild(emptyMessage);
        return container;
    }

    const renderTagNode = (tag, level = 0, parentPath = '') => {
        const tagElement = document.createElement('div');
        tagElement.className = 'tag-item';
        tagElement.dataset.tagId = tag.id;

        // 构建完整的标签路径
        const fullPath = parentPath ? `${parentPath}/${tag.name}` : tag.name;

        // 创建标签行容器
        const tagRow = document.createElement('div');
        tagRow.className = 'tag-row';
        tagRow.style.paddingLeft = `${level * 20}px`;

        // 添加展开/折叠按钮（仅当有子标签时）
        if (tag.children && tag.children.length > 0) {
            const expandBtn = document.createElement('button');
            expandBtn.className = 'tag-expand-btn';
            expandBtn.innerHTML = '▶'; // 默认折叠状态
            expandBtn.setAttribute('aria-label', '展开/折叠');

            // 展开/折叠事件
            expandBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleTagExpansion(tagElement, expandBtn);
            });

            tagRow.appendChild(expandBtn);
        } else {
            // 没有子标签时添加占位符保持对齐
            const spacer = document.createElement('span');
            spacer.className = 'tag-spacer';
            tagRow.appendChild(spacer);
        }

        // 创建标签内容区域
        const tagContent = document.createElement('div');
        tagContent.className = 'tag-content';

        // 添加标签图标
        if (tag.icon) {
            const icon = document.createElement('span');
            icon.className = 'tag-icon';
            icon.textContent = tag.icon;
            tagContent.appendChild(icon);
        }

        // 添加标签名称
        const name = document.createElement('span');
        name.className = 'tag-name';
        name.textContent = tag.name;
        tagContent.appendChild(name);

        // 添加标签点击事件 - 使用完整路径
        tagContent.addEventListener('click', (e) => {
            e.stopPropagation();
            insertTag(fullPath);
            hideTagPanel();
        });

        tagRow.appendChild(tagContent);
        tagElement.appendChild(tagRow);

        // 创建子标签容器
        if (tag.children && tag.children.length > 0) {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'tag-children';
            childrenContainer.style.display = 'none'; // 默认折叠

            // 递归渲染子标签，传递当前完整路径
            tag.children.forEach(childTag => {
                const childElement = renderTagNode(childTag, level + 1, fullPath);
                childrenContainer.appendChild(childElement);
            });

            tagElement.appendChild(childrenContainer);
        }

        return tagElement;
    };

    tags.forEach(tag => {
        const tagElement = renderTagNode(tag);
        container.appendChild(tagElement);
    });

    return container;
}

// 切换标签展开/折叠状态
function toggleTagExpansion(tagElement, expandBtn) {
    const childrenContainer = tagElement.querySelector('.tag-children');
    if (!childrenContainer) return;

    const isExpanded = childrenContainer.style.display !== 'none';

    if (isExpanded) {
        // 折叠
        childrenContainer.style.display = 'none';
        expandBtn.innerHTML = '▶';
        expandBtn.classList.remove('expanded');
        tagElement.classList.remove('expanded');
    } else {
        // 展开
        childrenContainer.style.display = 'block';
        expandBtn.innerHTML = '▼';
        expandBtn.classList.add('expanded');
        tagElement.classList.add('expanded');
    }
}

// 展开所有标签
function expandAllTags() {
    const tagTree = document.querySelector('.tag-tree');
    if (!tagTree) return;

    const expandBtns = tagTree.querySelectorAll('.tag-expand-btn');
    expandBtns.forEach(btn => {
        const tagElement = btn.closest('.tag-item');
        const childrenContainer = tagElement.querySelector('.tag-children');
        if (childrenContainer && childrenContainer.style.display === 'none') {
            toggleTagExpansion(tagElement, btn);
        }
    });
}

// 折叠所有标签
function collapseAllTags() {
    const tagTree = document.querySelector('.tag-tree');
    if (!tagTree) return;

    const expandBtns = tagTree.querySelectorAll('.tag-expand-btn');
    expandBtns.forEach(btn => {
        const tagElement = btn.closest('.tag-item');
        const childrenContainer = tagElement.querySelector('.tag-children');
        if (childrenContainer && childrenContainer.style.display !== 'none') {
            toggleTagExpansion(tagElement, btn);
        }
    });
}

// 插入标签
function insertTag(tagName) {
    const textArea = document.getElementById('quickNoteInput');
    if (!textArea || !tagName) return;

    const start = textArea.selectionStart;
    const currentValue = textArea.value;

    // 格式化标签（添加#前缀如果没有的话）
    const formattedTag = tagName.startsWith('#') ? tagName : `#${tagName}`;

    // 检查光标前是否需要换行（只有在行首或空内容时不换行）
    let prefix = '';
    if (start > 0) {
        const charBefore = currentValue.charAt(start - 1);
        if (charBefore !== '\n') {
            prefix = '\n';
        }
    }

    // 在光标位置插入标签
    const insertText = prefix + formattedTag + ' ';
    const newValue = currentValue.substring(0, start) + insertText + currentValue.substring(start);
    textArea.value = newValue;

    // 设置光标位置到插入内容的末尾
    const newCursorPosition = start + insertText.length;
    textArea.setSelectionRange(newCursorPosition, newCursorPosition);

    // 触发input事件以保存内容
    textArea.dispatchEvent(new Event('input', {bubbles: true}));

    // 聚焦到文本区域
    textArea.focus();
}

// 键盘快捷键功能
function initializeKeyboardShortcuts() {
    document.addEventListener('keydown', handleKeyDown);
}

function handleKeyDown(event) {
    // 检测快捷键组合
    const isCtrlOrCmd = event.ctrlKey || event.metaKey;

    if (isCtrlOrCmd && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        handleGetPageLink();
    } else if (isCtrlOrCmd && event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        toggleTagPanel();
    } else if (isCtrlOrCmd && event.key === 'Enter') {
        event.preventDefault();
        const sendButton = document.getElementById('sendQuickNote');
        if (sendButton) sendButton.click();
    } else if (event.key === 'Escape') {
        if (isTagPanelOpen) {
            event.preventDefault();
            hideTagPanel();
        }
    }
}

// 增强功能样式已移至 css/popup.css
function addEnhancedStyles() {
    // 样式已在 popup.css 中定义，此函数保留以保持兼容性
}