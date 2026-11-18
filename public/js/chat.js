/**
 * FundIQ - Penny Virtual Assistant (public/js/chat.js)
 * Polished, accessible, responsive client-side AI chat integration.
 */

(function () {
    "use strict";

    // Detect if user is on the login page (unauthenticated guest mode)
    const isLoginPage =
        window.location.pathname.endsWith("index.html") ||
        window.location.pathname.endsWith("register.html") ||
        window.location.pathname === "/" ||
        document.body.classList.contains("login-page");

    // Authoritative user display name synced from /api/auth/me
    let storedName = null;

    window.addEventListener("fundiq:user-loaded", (e) => {
        if (isLoginPage) {
            storedName = null;
        } else if (e.detail && (e.detail.fullName || e.detail.username)) {
            storedName = (e.detail.fullName && e.detail.fullName.trim())
                ? e.detail.fullName.trim()
                : e.detail.username;
        } else {
            storedName = null;
        }
        if (conversationHistory.length === 0) {
            renderWelcomeCard();
        }
    });

    if (!isLoginPage) {
        fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                if (data && data.authenticated && data.user) {
                    storedName = (data.user.fullName && data.user.fullName.trim())
                        ? data.user.fullName.trim()
                        : data.user.username;
                } else {
                    storedName = null;
                }
                if (conversationHistory.length === 0) {
                    renderWelcomeCard();
                }
            })
            .catch(() => {});
    }

    // Chat state
    let isOpen = false;
    let isGenerating = false;
    let conversationHistory = [];
    let lastUserMessage = "";

    // Suggested prompts
    const DEFAULT_PROMPTS = [
        "How does FDIC deposit insurance protect my savings?",
        "What does the CFPB recommend for budgeting & bills?",
        "How does FundIQ's AI Money Sorter allocate deposits?",
        "What are SEC and IRS tips for saving & taxes?"
    ];

    /**
     * Escape HTML to prevent injection in message bubbles
     */
    function escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Markdown-to-HTML parser supporting bold, italic, bullet points, and clickable trusted source links [Title](https://...)
     */
    function formatMessageText(text) {
        if (!text) return "";
        let formatted = escapeHtml(text);

        // Clickable markdown links: [label](https://...)
        formatted = formatted.replace(
            /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
            '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#5B21B6; font-weight:700; text-decoration:underline;">$1</a>'
        );

        // Bold **text**
        formatted = formatted.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

        // Italic *text*
        formatted = formatted.replace(/(^|\s)\*([^*]+)\*(?=\s|$|\.)/g, "$1<em>$2</em>");

        // Simple bullet points (- item or * item)
        formatted = formatted.replace(/(?:^|\n)[-*]\s+(.*)/g, "<br>• $1");

        // Preserve line breaks
        formatted = formatted.replace(/\n/g, "<br>");

        return formatted;
    }

    /**
     * Build and inject DOM elements
     */
    function initChatWidget() {
        // Prevent duplicate injection
        if (document.getElementById("fiqChatLauncher")) return;

        // 1. Floating Launcher Button
        const launcher = document.createElement("button");
        launcher.id = "fiqChatLauncher";
        launcher.className = "fiq-chat-launcher";
        launcher.setAttribute("type", "button");
        launcher.setAttribute("aria-label", "Open Penny, FundIQ Assistant");
        launcher.setAttribute("aria-haspopup", "dialog");
        launcher.setAttribute("aria-expanded", "false");
        launcher.innerHTML = `
            <span class="fiq-launcher-icon" aria-hidden="true">✦</span>
            <span class="fiq-launcher-label">Ask Penny</span>
            <span class="fiq-launcher-badge" aria-hidden="true">1</span>
        `;

        // 2. Chat Panel Container
        const chatWindow = document.createElement("aside");
        chatWindow.id = "fiqChatWindow";
        chatWindow.className = "fiq-chat-window";
        chatWindow.setAttribute("role", "dialog");
        chatWindow.setAttribute("aria-labelledby", "fiqHeaderTitle");
        chatWindow.setAttribute("aria-hidden", "true");

        // Header
        const header = document.createElement("div");
        header.className = "fiq-chat-header";
        header.innerHTML = `
            <div class="fiq-header-info">
                <div class="fiq-header-avatar" aria-hidden="true">✦</div>
                <div>
                    <h2 id="fiqHeaderTitle" class="fiq-header-title">Penny</h2>
                    <p class="fiq-header-sub">
                        <span class="fiq-status-dot" aria-hidden="true"></span>
                        FundIQ AI Assistant
                    </p>
                </div>
            </div>
            <div class="fiq-header-actions">
                <button type="button" id="fiqClearBtn" class="fiq-icon-btn" title="Clear conversation" aria-label="Clear conversation">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </button>
                <button type="button" id="fiqCloseBtn" class="fiq-icon-btn" title="Close chat" aria-label="Close chat">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
        `;

        // Message List Area
        const messagesContainer = document.createElement("div");
        messagesContainer.id = "fiqChatMessages";
        messagesContainer.className = "fiq-chat-messages";
        messagesContainer.setAttribute("aria-live", "polite");

        // Footer Input Area
        const footer = document.createElement("div");
        footer.className = "fiq-chat-footer";
        footer.innerHTML = `
            <form id="fiqChatForm" class="fiq-chat-form">
                <div class="fiq-input-wrapper">
                    <textarea
                        id="fiqChatInput"
                        class="fiq-chat-input"
                        placeholder="Ask Penny anything about FundIQ..."
                        rows="1"
                        maxlength="1000"
                        aria-label="Message Penny"
                    ></textarea>
                </div>
                <button type="submit" id="fiqChatSend" class="fiq-chat-send" aria-label="Send message" disabled>
                    <svg class="fiq-send-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path>
                    </svg>
                </button>
            </form>
            <div class="fiq-footer-meta">
                <span>FundIQ • Educational Assistant</span>
                <span id="fiqCharCount">0/1000</span>
            </div>
        `;

        chatWindow.appendChild(header);
        chatWindow.appendChild(messagesContainer);
        chatWindow.appendChild(footer);

        document.body.appendChild(launcher);
        document.body.appendChild(chatWindow);

        // Render initial welcome message
        renderWelcomeCard();

        // Bind event listeners
        bindEvents();
    }

    /**
     * Render the initial welcome card and suggested prompt pills
     */
    function renderWelcomeCard() {
        const messagesContainer = document.getElementById("fiqChatMessages");
        if (!messagesContainer) return;

        messagesContainer.innerHTML = "";

        const welcomeCard = document.createElement("div");
        welcomeCard.className = "fiq-welcome-card";

        const greetingName = storedName ? `Hello, ${escapeHtml(storedName)}! ` : "Hello! ";

        welcomeCard.innerHTML = `
            <h3>${greetingName}👋 I'm Penny.</h3>
            <p>
                I'm your FundIQ financial organization assistant. I can explain how the
                <strong>Money Sorter</strong> works, how your <strong>Wallet</strong> organizes
                your money into Bills, Spending, and Savings, and share tips for simple budgeting.
            </p>
            <div class="fiq-welcome-disclaimer">
                ${isLoginPage
                    ? "🔒 <strong>Guest Mode:</strong> You're on the login page. I can answer questions about FundIQ without accessing personal account details."
                    : "ℹ️ <strong>Prototype Note:</strong> FundIQ provides educational organization suggestions, not professional financial advice."
                }
            </div>
        `;

        const promptsContainer = document.createElement("div");
        promptsContainer.className = "fiq-suggested-prompts";
        promptsContainer.innerHTML = `
            <div class="fiq-suggested-label">Suggested Questions</div>
            <div class="fiq-prompt-chips" id="fiqPromptChips"></div>
        `;

        messagesContainer.appendChild(welcomeCard);
        messagesContainer.appendChild(promptsContainer);

        const chipsArea = promptsContainer.querySelector("#fiqPromptChips");
        DEFAULT_PROMPTS.forEach(promptText => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "fiq-prompt-chip";
            chip.textContent = promptText;
            chip.addEventListener("click", () => {
                sendMessage(promptText);
            });
            chipsArea.appendChild(chip);
        });

        scrollToBottom();
    }

    /**
     * Bind all DOM and keyboard events
     */
    function bindEvents() {
        const launcher = document.getElementById("fiqChatLauncher");
        const chatWindow = document.getElementById("fiqChatWindow");
        const closeBtn = document.getElementById("fiqCloseBtn");
        const clearBtn = document.getElementById("fiqClearBtn");
        const form = document.getElementById("fiqChatForm");
        const input = document.getElementById("fiqChatInput");
        const sendBtn = document.getElementById("fiqChatSend");
        const charCount = document.getElementById("fiqCharCount");

        // Toggle open/close
        launcher.addEventListener("click", () => {
            toggleChat(!isOpen);
        });

        closeBtn.addEventListener("click", () => {
            toggleChat(false);
        });

        clearBtn.addEventListener("click", () => {
            if (conversationHistory.length > 0) {
                if (confirm("Start a new conversation with Penny?")) {
                    conversationHistory = [];
                    lastUserMessage = "";
                    renderWelcomeCard();
                }
            } else {
                renderWelcomeCard();
            }
        });

        // Close on Escape key
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && isOpen) {
                toggleChat(false);
                launcher.focus();
            }
        });

        // Auto-resize textarea & manage send button state
        input.addEventListener("input", () => {
            const val = input.value;
            charCount.textContent = `${val.length}/1000`;
            sendBtn.disabled = isGenerating || val.trim().length === 0;

            input.style.height = "auto";
            input.style.height = Math.min(input.scrollHeight, 100) + "px";
        });

        // Enter key to send (Shift+Enter for newline)
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!sendBtn.disabled) {
                    form.dispatchEvent(new Event("submit", { cancelable: true }));
                }
            }
        });

        // Form submit
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            const text = input.value.trim();
            if (!text || isGenerating) return;

            input.value = "";
            input.style.height = "auto";
            charCount.textContent = "0/1000";
            sendBtn.disabled = true;

            sendMessage(text);
        });
    }

    /**
     * Open or close the chat window
     */
    function toggleChat(open) {
        isOpen = open;
        const launcher = document.getElementById("fiqChatLauncher");
        const chatWindow = document.getElementById("fiqChatWindow");
        const input = document.getElementById("fiqChatInput");

        if (isOpen) {
            chatWindow.classList.add("fiq-open");
            chatWindow.setAttribute("aria-hidden", "false");
            launcher.setAttribute("aria-expanded", "true");
            launcher.querySelector(".fiq-launcher-label").textContent = "Close";
            launcher.querySelector(".fiq-launcher-icon").textContent = "✕";
            setTimeout(() => {
                input.focus();
                scrollToBottom();
            }, 100);
        } else {
            chatWindow.classList.remove("fiq-open");
            chatWindow.setAttribute("aria-hidden", "true");
            launcher.setAttribute("aria-expanded", "false");
            launcher.querySelector(".fiq-launcher-label").textContent = "Ask Penny";
            launcher.querySelector(".fiq-launcher-icon").textContent = "✦";
        }
    }

    /**
     * Send user message to server API
     */
    async function sendMessage(text) {
        if (!text || isGenerating) return;
        lastUserMessage = text;

        // Render user message bubble
        appendMessage("user", text);
        conversationHistory.push({ role: "user", content: text });

        // Show typing indicator
        setGenerating(true);
        const typingEl = appendTypingIndicator();

        try {
            const response = await fetch("/api/chat", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    message: text,
                    history: conversationHistory.slice(-6),
                    isGuest: isLoginPage
                })
            });

            const data = await response.json();
            removeTypingIndicator(typingEl);

            if (!response.ok || !data.success) {
                const errMsg = data.error || "Penny couldn't reach the server. Please try again.";
                appendError(errMsg);
                return;
            }

            const replyText = data.reply || "I didn't quite catch that. Could you please rephrase?";
            const isDemo = data.mode === "demo";

            // Append assistant message with typewriter effect
            appendAssistantMessage(replyText, isDemo);
            conversationHistory.push({ role: "assistant", content: replyText });

        } catch (err) {
            console.error("Chat communication error:", err);
            removeTypingIndicator(typingEl);
            appendError("Network connection issue. Please make sure your server is running and try again.");
        } finally {
            setGenerating(false);
        }
    }

    /**
     * Append message bubble to chat window
     */
    function appendMessage(role, text) {
        const messagesContainer = document.getElementById("fiqChatMessages");
        if (!messagesContainer) return;

        const row = document.createElement("div");
        row.className = `fiq-message-row fiq-${role}`;

        const bubble = document.createElement("div");
        bubble.className = "fiq-message-bubble";
        bubble.innerHTML = formatMessageText(text);

        const meta = document.createElement("div");
        meta.className = "fiq-message-meta";
        meta.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

        row.appendChild(bubble);
        row.appendChild(meta);
        messagesContainer.appendChild(row);

        scrollToBottom();
        return row;
    }

    /**
     * Append assistant message with smooth typewriter animation
     */
    function appendAssistantMessage(fullText, isDemo) {
        const messagesContainer = document.getElementById("fiqChatMessages");
        if (!messagesContainer) return;

        const row = document.createElement("div");
        row.className = "fiq-message-row fiq-assistant";

        const bubble = document.createElement("div");
        bubble.className = "fiq-message-bubble";

        const meta = document.createElement("div");
        meta.className = "fiq-message-meta";
        const timeStr = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

        meta.innerHTML = `
            <span>${timeStr}</span>
            <span class="fiq-mode-tag ${isDemo ? 'fiq-demo' : ''}">
                ${isDemo ? 'Demo Mode' : 'AI'}
            </span>
        `;

        row.appendChild(bubble);
        row.appendChild(meta);
        messagesContainer.appendChild(row);

        // Typewriter streaming effect
        let index = 0;
        const speed = 12; // ms per character
        const step = 2;   // characters per interval for smooth brisk feel

        function streamText() {
            if (index < fullText.length) {
                index += step;
                bubble.innerHTML = formatMessageText(fullText.slice(0, index));
                scrollToBottom();
                setTimeout(streamText, speed);
            } else {
                bubble.innerHTML = formatMessageText(fullText);
                scrollToBottom();
            }
        }

        streamText();
    }

    /**
     * Append and remove typing indicators
     */
    function appendTypingIndicator() {
        const messagesContainer = document.getElementById("fiqChatMessages");
        if (!messagesContainer) return null;

        const row = document.createElement("div");
        row.className = "fiq-message-row fiq-assistant fiq-typing-row";

        const indicator = document.createElement("div");
        indicator.className = "fiq-typing-bubble";
        indicator.setAttribute("aria-label", "Penny is typing");
        indicator.innerHTML = `
            <span class="fiq-typing-dot"></span>
            <span class="fiq-typing-dot"></span>
            <span class="fiq-typing-dot"></span>
        `;

        row.appendChild(indicator);
        messagesContainer.appendChild(row);
        scrollToBottom();
        return row;
    }

    function removeTypingIndicator(el) {
        if (el && el.parentNode) {
            el.parentNode.removeChild(el);
        }
    }

    /**
     * Display error card with retry button
     */
    function appendError(errorMessage) {
        const messagesContainer = document.getElementById("fiqChatMessages");
        if (!messagesContainer) return;

        const errorCard = document.createElement("div");
        errorCard.className = "fiq-error-card";
        errorCard.innerHTML = `
            <div><strong>Unable to complete request:</strong> ${escapeHtml(errorMessage)}</div>
            <button type="button" class="fiq-error-retry-btn">Retry</button>
        `;

        errorCard.querySelector(".fiq-error-retry-btn").addEventListener("click", () => {
            errorCard.remove();
            if (lastUserMessage) {
                sendMessage(lastUserMessage);
            }
        });

        messagesContainer.appendChild(errorCard);
        scrollToBottom();
    }

    /**
     * Set generating state
     */
    function setGenerating(generating) {
        isGenerating = generating;
        const input = document.getElementById("fiqChatInput");
        const sendBtn = document.getElementById("fiqChatSend");

        if (sendBtn) {
            sendBtn.disabled = generating || (input ? input.value.trim().length === 0 : true);
        }
    }

    /**
     * Keep chat pinned to bottom
     */
    function scrollToBottom() {
        const messagesContainer = document.getElementById("fiqChatMessages");
        if (messagesContainer) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initChatWidget);
    } else {
        initChatWidget();
    }
})();

