/**
 * FundIQ - Interactive Calendar, Recurring Payments & Wallet Integration
 * public/js/calendar.js
 *
 * Implements single source of truth for Payments, Monthly Calendar view,
 * Recurring occurrences (weekly, biweekly, monthly, yearly with month-end math),
 * Idempotent Wallet balance deductions, and reversible actions.
 */

(function () {
    "use strict";

    const STORAGE_KEY = "fundiqPayments_v1";
    const WALLET_KEY = "fundiqWallet";

    // Application state in memory
    let currentYear = new Date().getFullYear();
    let currentMonth = new Date().getMonth(); // 0-indexed (0 = Jan, 11 = Dec)
    let selectedDateStr = formatDateStr(new Date()); // YYYY-MM-DD
    let activeFilter = "all"; // all, bills, spending, savings, unpaid, completed

    // Payment data structure
    let paymentData = {
        templates: [],
        completions: {}, // occurrenceId -> { isCompleted: true, completedAt: '...', deductedAmount: 0, deductedCategory: 'bills' }
        overrides: {}    // occurrenceId -> { isCancelled: boolean, title, amount, dueDate, category }
    };

    /**
     * Format a Date object to YYYY-MM-DD local string
     */
    function formatDateStr(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }

    /**
     * Parse YYYY-MM-DD safely into a local Date without timezone offset shift
     */
    function parseDateStr(str) {
        if (!str || typeof str !== "string") return new Date();
        const parts = str.split("-").map(Number);
        return new Date(parts[0], parts[1] - 1, parts[2]);
    }

    /**
     * Format currency display ($X.XX)
     */
    function formatCurrency(amount) {
        return new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD"
        }).format(amount || 0);
    }

    /**
     * Load wallet data safely from localStorage
     */
    function getWalletData() {
        try {
            const raw = localStorage.getItem(WALLET_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                return {
                    bills: Number(parsed.bills) || 0,
                    spending: Number(parsed.spending) || 0,
                    savings: Number(parsed.savings) || 0
                };
            }
        } catch (e) {
            console.error("FundIQ: Failed to read wallet storage:", e);
        }
        return { bills: 0, spending: 0, savings: 0 };
    }

    /**
     * Save wallet data to localStorage
     */
    function saveWalletData(wallet) {
        try {
            localStorage.setItem(WALLET_KEY, JSON.stringify(wallet));
        } catch (e) {
            console.error("FundIQ: Failed to save wallet storage:", e);
        }
    }

    /**
     * Load payments from localStorage with versioning & safe fallback
     */
    function loadPaymentData() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                paymentData = {
                    templates: Array.isArray(parsed.templates) ? parsed.templates : [],
                    completions: parsed.completions && typeof parsed.completions === "object" ? parsed.completions : {},
                    overrides: parsed.overrides && typeof parsed.overrides === "object" ? parsed.overrides : {}
                };
                return;
            }
        } catch (e) {
            console.error("FundIQ: Failed to read payments storage, initializing empty:", e);
        }

        // Initialize with helpful demo templates if completely empty
        const todayStr = formatDateStr(new Date());
        const [y, m, d] = todayStr.split("-").map(Number);
        const rentDate = `${y}-${String(m).padStart(2, "0")}-01`;
        const phoneDate = `${y}-${String(m).padStart(2, "0")}-15`;

        paymentData = {
            templates: [
                {
                    id: "tpl_rent",
                    title: "Apartment Rent",
                    amount: 600.00,
                    category: "bills",
                    startDate: rentDate,
                    recurrence: "monthly",
                    notes: "Monthly housing payment"
                },
                {
                    id: "tpl_phone",
                    title: "Cell Phone Plan",
                    amount: 65.00,
                    category: "bills",
                    startDate: phoneDate,
                    recurrence: "monthly",
                    notes: "Unlimited mobile service"
                },
                {
                    id: "tpl_groceries",
                    title: "Weekly Groceries",
                    amount: 80.00,
                    category: "spending",
                    startDate: todayStr,
                    recurrence: "weekly",
                    notes: "Supermarket restocking"
                }
            ],
            completions: {},
            overrides: {}
        };
        savePaymentData();
    }

    /**
     * Save payments to localStorage and sync with server if authenticated
     */
    function savePaymentData(skipServer = false) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(paymentData));
        } catch (e) {
            console.error("FundIQ: Failed to save payment storage:", e);
        }

        if (!skipServer) {
            fetch("/api/payments", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(paymentData)
            }).catch(() => {});
        }
    }

    /**
     * Sync payments and wallet from authenticated server endpoints
     */
    async function syncPaymentsFromServer() {
        try {
            const [wRes, pRes] = await Promise.all([
                fetch("/api/wallet"),
                fetch("/api/payments")
            ]);

            if (wRes.ok) {
                const wData = await wRes.json();
                if (wData.success && wData.wallet) {
                    saveWalletData(wData.wallet);
                }
            }

            if (pRes.ok) {
                const pData = await pRes.json();
                if (pData.success && pData.payments && Array.isArray(pData.payments.templates)) {
                    if (pData.payments.templates.length > 0 || Object.keys(pData.payments.completions || {}).length > 0) {
                        paymentData = {
                            templates: pData.payments.templates,
                            completions: pData.payments.completions || {},
                            overrides: pData.payments.overrides || {}
                        };
                        savePaymentData(true);
                    }
                }
            }

            renderAll();
        } catch (e) {
            console.log("Server sync offline or unauthenticated:", e.message);
        }
    }

    /**
     * Monthly date math helper handling month-end edge cases (e.g. Jan 31 -> Feb 28)
     */
    function getMonthlyDate(origYear, origMonth, origDay, monthOffset) {
        const totalMonths = origMonth + monthOffset;
        const targetYear = origYear + Math.floor(totalMonths / 12);
        const targetMonth = ((totalMonths % 12) + 12) % 12;

        // Find days in target month
        const daysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
        const targetDay = Math.min(origDay, daysInTargetMonth);

        return new Date(targetYear, targetMonth, targetDay);
    }

    /**
     * Yearly date math helper handling leap years (e.g. Feb 29 -> Feb 28 in non-leap year)
     */
    function getYearlyDate(origYear, origMonth, origDay, yearOffset) {
        const targetYear = origYear + yearOffset;
        const daysInTargetMonth = new Date(targetYear, origMonth + 1, 0).getDate();
        const targetDay = Math.min(origDay, daysInTargetMonth);
        return new Date(targetYear, origMonth, targetDay);
    }

    /**
     * Generate all scheduled occurrences within a given date range
     */
    function generateOccurrences(rangeStartDate, rangeEndDate) {
        const occurrences = [];
        const rangeStartStr = formatDateStr(rangeStartDate);
        const rangeEndStr = formatDateStr(rangeEndDate);

        paymentData.templates.forEach((tpl) => {
            const startD = parseDateStr(tpl.startDate);
            const origYear = startD.getFullYear();
            const origMonth = startD.getMonth();
            const origDay = startD.getDate();

            if (tpl.recurrence === "none") {
                const occDateStr = tpl.startDate;
                if (occDateStr >= rangeStartStr && occDateStr <= rangeEndStr) {
                    addOccurrence(tpl, occDateStr);
                }
            } else if (tpl.recurrence === "weekly") {
                let cur = new Date(origYear, origMonth, origDay);
                // Step forward to range
                while (cur <= rangeEndDate) {
                    const occDateStr = formatDateStr(cur);
                    if (occDateStr >= rangeStartStr) {
                        addOccurrence(tpl, occDateStr);
                    }
                    cur.setDate(cur.getDate() + 7);
                }
            } else if (tpl.recurrence === "biweekly") {
                let cur = new Date(origYear, origMonth, origDay);
                while (cur <= rangeEndDate) {
                    const occDateStr = formatDateStr(cur);
                    if (occDateStr >= rangeStartStr) {
                        addOccurrence(tpl, occDateStr);
                    }
                    cur.setDate(cur.getDate() + 14);
                }
            } else if (tpl.recurrence === "monthly") {
                let mOffset = 0;
                while (true) {
                    const cur = getMonthlyDate(origYear, origMonth, origDay, mOffset);
                    if (cur > rangeEndDate) break;
                    const occDateStr = formatDateStr(cur);
                    if (occDateStr >= rangeStartStr && occDateStr >= tpl.startDate) {
                        addOccurrence(tpl, occDateStr);
                    }
                    mOffset++;
                    if (mOffset > 120) break; // safety guard
                }
            } else if (tpl.recurrence === "yearly") {
                let yOffset = 0;
                while (true) {
                    const cur = getYearlyDate(origYear, origMonth, origDay, yOffset);
                    if (cur > rangeEndDate) break;
                    const occDateStr = formatDateStr(cur);
                    if (occDateStr >= rangeStartStr && occDateStr >= tpl.startDate) {
                        addOccurrence(tpl, occDateStr);
                    }
                    yOffset++;
                    if (yOffset > 30) break; // safety guard
                }
            }
        });

        function addOccurrence(tpl, occDateStr) {
            const occId = `${tpl.id}_${occDateStr}`;

            // Check if this occurrence was overridden or cancelled
            const override = paymentData.overrides[occId];
            if (override && override.isCancelled) {
                return;
            }

            const title = override && override.title ? override.title : tpl.title;
            const amount = override && override.amount !== undefined ? override.amount : tpl.amount;
            const category = override && override.category ? override.category : tpl.category;
            const dueDate = override && override.dueDate ? override.dueDate : occDateStr;

            const completion = paymentData.completions[occId];
            const isCompleted = Boolean(completion && completion.isCompleted);

            occurrences.push({
                occurrenceId: occId,
                templateId: tpl.id,
                title: title,
                amount: Number(amount),
                category: category,
                dueDate: dueDate,
                recurrence: tpl.recurrence,
                isCompleted: isCompleted,
                completedAt: completion ? completion.completedAt : null,
                deductedAmount: completion ? completion.deductedAmount : null,
                deductedCategory: completion ? completion.deductedCategory : null
            });
        }

        // Sort chronologically earliest first
        occurrences.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
        return occurrences;
    }

    /**
     * Render the Live Wallet Balance Overview Bar
     */
    function renderWalletBar() {
        const wallet = getWalletData();
        const total = wallet.bills + wallet.spending + wallet.savings;

        const totalEl = document.getElementById("calWalletTotal");
        const billsEl = document.getElementById("calWalletBills");
        const spendingEl = document.getElementById("calWalletSpending");
        const savingsEl = document.getElementById("calWalletSavings");

        if (totalEl) totalEl.textContent = formatCurrency(total);
        if (billsEl) billsEl.textContent = formatCurrency(wallet.bills);
        if (spendingEl) spendingEl.textContent = formatCurrency(wallet.spending);
        if (savingsEl) savingsEl.textContent = formatCurrency(wallet.savings);
    }

    /**
     * Render the Monthly Calendar Grid
     */
    function renderCalendar() {
        const monthTitle = document.getElementById("calMonthTitle");
        const grid = document.getElementById("calendarGrid");
        if (!monthTitle || !grid) return;

        const monthNames = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ];
        monthTitle.textContent = `${monthNames[currentMonth]} ${currentYear}`;

        grid.innerHTML = "";

        // First day of month & days in month
        const firstDayOfMonth = new Date(currentYear, currentMonth, 1).getDay(); // 0 = Sun
        const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
        const daysInPrevMonth = new Date(currentYear, currentMonth, 0).getDate();

        // Calculate occurrences for this visible month (including leading/trailing padding)
        const viewStart = new Date(currentYear, currentMonth - 1, 20);
        const viewEnd = new Date(currentYear, currentMonth + 1, 15);
        const occurrences = generateOccurrences(viewStart, viewEnd);

        // Group occurrences by dueDate
        const occByDate = {};
        occurrences.forEach((occ) => {
            if (!occByDate[occ.dueDate]) occByDate[occ.dueDate] = [];
            occByDate[occ.dueDate].push(occ);
        });

        const todayStr = formatDateStr(new Date());

        // 1. Trailing days from previous month
        for (let i = firstDayOfMonth - 1; i >= 0; i--) {
            const dayNum = daysInPrevMonth - i;
            const prevMonthDate = new Date(currentYear, currentMonth - 1, dayNum);
            const dateStr = formatDateStr(prevMonthDate);
            grid.appendChild(createDayCell(dateStr, dayNum, true, occByDate[dateStr]));
        }

        // 2. Days of current month
        for (let d = 1; d <= daysInMonth; d++) {
            const date = new Date(currentYear, currentMonth, d);
            const dateStr = formatDateStr(date);
            grid.appendChild(createDayCell(dateStr, d, false, occByDate[dateStr]));
        }

        // 3. Leading days for next month to complete grid (42 cells = 6 weeks)
        const totalCells = grid.children.length;
        const remainingCells = 42 - totalCells;
        for (let d = 1; d <= remainingCells; d++) {
            const nextMonthDate = new Date(currentYear, currentMonth + 1, d);
            const dateStr = formatDateStr(nextMonthDate);
            grid.appendChild(createDayCell(dateStr, d, true, occByDate[dateStr]));
        }

        function createDayCell(dateStr, dayNum, isOtherMonth, dayOccurrences) {
            const cell = document.createElement("button");
            cell.type = "button";
            cell.className = "cal-day-cell";
            if (isOtherMonth) cell.classList.add("other-month");
            if (dateStr === todayStr) cell.classList.add("is-today");
            if (dateStr === selectedDateStr) cell.classList.add("is-selected");

            cell.setAttribute("aria-label", `${dateStr}, ${dayOccurrences ? dayOccurrences.length : 0} payments`);

            const numSpan = document.createElement("span");
            numSpan.className = "cal-day-num";
            numSpan.textContent = dayNum;
            cell.appendChild(numSpan);

            // Add indicators if payments exist
            if (dayOccurrences && dayOccurrences.length > 0) {
                const dotsContainer = document.createElement("div");
                dotsContainer.className = "cal-payment-dots";

                const maxDots = Math.min(dayOccurrences.length, 3);
                for (let i = 0; i < maxDots; i++) {
                    const dot = document.createElement("span");
                    dot.className = `cal-dot ${dayOccurrences[i].isCompleted ? "paid" : dayOccurrences[i].category}`;
                    dotsContainer.appendChild(dot);
                }

                if (dayOccurrences.length > 3) {
                    const countBadge = document.createElement("span");
                    countBadge.className = "cal-count-badge";
                    countBadge.textContent = `+${dayOccurrences.length - 3}`;
                    dotsContainer.appendChild(countBadge);
                }

                cell.appendChild(dotsContainer);
            }

            cell.addEventListener("click", () => {
                selectedDateStr = dateStr;
                renderCalendar();
                renderSelectedDateDetail();
            });

            return cell;
        }
    }

    /**
     * Render the Selected Date Detail Sub-panel
     */
    function renderSelectedDateDetail() {
        const container = document.getElementById("selectedDateDetail");
        if (!container) return;

        const selDate = parseDateStr(selectedDateStr);
        const formatted = selDate.toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric"
        });

        // Get occurrences for this exact date
        const viewStart = parseDateStr(selectedDateStr);
        const viewEnd = parseDateStr(selectedDateStr);
        const occurrences = generateOccurrences(viewStart, viewEnd);

        let listHtml = "";
        if (occurrences.length === 0) {
            listHtml = `<p style="font-size: 13px; color: #94a3b8; margin: 6px 0;">No payments scheduled for this date.</p>`;
        } else {
            listHtml = `<div class="date-payments-list">`;
            occurrences.forEach((occ) => {
                const statusBadge = occ.isCompleted
                    ? `<span class="badge-tag completed">Paid ✓</span>`
                    : `<span class="badge-tag ${occ.category}">${occ.category}</span>`;

                listHtml += `
                    <div class="date-payment-item">
                        <div>
                            <strong>${escapeHtml(occ.title)}</strong> — ${formatCurrency(occ.amount)}
                            <div style="font-size: 11px; color: #64748b; margin-top: 2px;">
                                ${statusBadge} • ${occ.recurrence}
                            </div>
                        </div>
                        <div>
                            ${occ.isCompleted
                                ? `<button type="button" class="btn-undo" onclick="FundIQCalendar.undoPayment('${occ.occurrenceId}')">Undo</button>`
                                : `<button type="button" class="btn-complete" onclick="FundIQCalendar.completePayment('${occ.occurrenceId}')">Mark Paid</button>`
                            }
                        </div>
                    </div>
                `;
            });
            listHtml += `</div>`;
        }

        container.innerHTML = `
            <div class="selected-date-header">
                <h3>Schedule for ${formatted}</h3>
                <button type="button" class="cal-quick-add-btn" onclick="FundIQCalendar.openAddModal('${selectedDateStr}')">+ Add for this Day</button>
            </div>
            ${listHtml}
        `;
    }

    /**
     * Render the Upcoming Payments List
     */
    function renderUpcomingPayments() {
        const listEl = document.getElementById("upcomingPaymentsList");
        if (!listEl) return;

        // Generate upcoming occurrences for the next 90 days (and past 7 days)
        const today = new Date();
        const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7);
        const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 90);
        let occurrences = generateOccurrences(start, end);

        // Apply active filter
        if (activeFilter === "bills") {
            occurrences = occurrences.filter((o) => o.category === "bills");
        } else if (activeFilter === "spending") {
            occurrences = occurrences.filter((o) => o.category === "spending");
        } else if (activeFilter === "savings") {
            occurrences = occurrences.filter((o) => o.category === "savings");
        } else if (activeFilter === "unpaid") {
            occurrences = occurrences.filter((o) => !o.isCompleted);
        } else if (activeFilter === "completed") {
            occurrences = occurrences.filter((o) => o.isCompleted);
        }

        if (occurrences.length === 0) {
            listEl.innerHTML = `
                <div class="payments-empty-state">
                    <div class="empty-icon">📅</div>
                    <h3>No upcoming payments</h3>
                    <p>You don't have any payments scheduled in this view.</p>
                    <button type="button" class="add-payment-btn" onclick="FundIQCalendar.openAddModal()">
                        + Add a Payment
                    </button>
                </div>
            `;
            return;
        }

        const todayStr = formatDateStr(new Date());

        listEl.innerHTML = "";
        occurrences.forEach((occ) => {
            const card = document.createElement("div");
            card.className = `payment-card-item ${occ.isCompleted ? "is-completed" : ""}`;

            const d = parseDateStr(occ.dueDate);
            const monthStr = d.toLocaleDateString("en-US", { month: "short" });
            const dayNum = d.getDate();

            // Status or overdue tag
            let statusTag = "";
            if (occ.isCompleted) {
                statusTag = `<span class="badge-tag completed">Paid ✓</span>`;
            } else if (occ.dueDate < todayStr) {
                statusTag = `<span class="badge-tag overdue">Overdue</span>`;
            } else if (occ.dueDate === todayStr) {
                statusTag = `<span class="badge-tag overdue">Due Today</span>`;
            }

            const recurrenceLabel = occ.recurrence === "none" ? "One-time" : `${occ.recurrence} 🔁`;

            card.innerHTML = `
                <div class="payment-info-group">
                    <div class="payment-date-badge">
                        <span class="p-month">${monthStr}</span>
                        <span class="p-day">${dayNum}</span>
                    </div>
                    <div class="payment-details">
                        <div class="payment-title-row">
                            <h4 class="payment-title">${escapeHtml(occ.title)}</h4>
                            <span class="badge-tag ${occ.category}">${occ.category}</span>
                            <span class="badge-tag recurrence">${recurrenceLabel}</span>
                            ${statusTag}
                        </div>
                        <div class="payment-sub-row">
                            <span class="payment-amount">${formatCurrency(occ.amount)}</span>
                            <span>Due: ${occ.dueDate}</span>
                        </div>
                    </div>
                </div>
                <div class="payment-actions-group">
                    ${occ.isCompleted
                        ? `<button type="button" class="btn-undo" title="Reverse payment deduction" onclick="FundIQCalendar.undoPayment('${occ.occurrenceId}')">Undo</button>`
                        : `<button type="button" class="btn-complete" title="Complete and deduct from wallet" onclick="FundIQCalendar.completePayment('${occ.occurrenceId}')">✓ Complete</button>`
                    }
                    <button type="button" class="btn-icon-action" title="Edit payment" onclick="FundIQCalendar.openEditModal('${occ.occurrenceId}')">✏️</button>
                    <button type="button" class="btn-icon-action delete" title="Delete payment" onclick="FundIQCalendar.promptDelete('${occ.occurrenceId}')">🗑️</button>
                </div>
            `;

            listEl.appendChild(card);
        });
    }

    /**
     * Complete an unpaid payment occurrence with Idempotent Wallet deduction
     */
    async function completePayment(occurrenceId) {
        // 1. Prevent duplicate deduction if already completed
        if (paymentData.completions[occurrenceId] && paymentData.completions[occurrenceId].isCompleted) {
            showNotification("This payment occurrence has already been completed.", "info");
            return;
        }

        // Find occurrence details
        const today = new Date();
        const start = new Date(today.getFullYear() - 2, 0, 1);
        const end = new Date(today.getFullYear() + 2, 11, 31);
        const occurrences = generateOccurrences(start, end);
        const occ = occurrences.find((o) => o.occurrenceId === occurrenceId);

        if (!occ) {
            showNotification("Payment occurrence not found.", "error");
            return;
        }

        // 2. Try server-side authenticated deduction first
        try {
            const res = await fetch("/api/payments/complete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    occurrenceId: occ.occurrenceId,
                    amount: occ.amount,
                    category: occ.category
                })
            });

            if (res.status === 400) {
                const errData = await res.json();
                if (errData.reason === "INSUFFICIENT_FUNDS") {
                    showInsufficientFundsModal(occ, errData.available !== undefined ? errData.available : 0);
                    return;
                }
                if (errData.reason === "ALREADY_COMPLETED") {
                    showNotification("This payment occurrence has already been completed.", "info");
                    return;
                }
            }

            if (res.ok) {
                const sData = await res.json();
                if (sData.success) {
                    saveWalletData(sData.wallet);
                    paymentData = sData.payments;
                    savePaymentData(true);
                    renderAll();
                    showNotification(
                        `Payment completed! Deducted ${formatCurrency(occ.amount)} from your ${occ.category.toUpperCase()} wallet.`,
                        "success"
                    );
                    return;
                }
            }
        } catch (serverErr) {
            console.log("Server complete endpoint unreachable, falling back to local deduction:", serverErr.message);
        }

        // 3. Fallback: Verify sufficient funds in local wallet
        const wallet = getWalletData();
        const currentBal = wallet[occ.category] || 0;

        if (currentBal < occ.amount) {
            // Insufficient funds alert
            showInsufficientFundsModal(occ, currentBal);
            return;
        }

        // 4. Deduct amount from intended category
        wallet[occ.category] = Math.round((currentBal - occ.amount) * 100) / 100;

        // 5. Record completion with stable metadata
        paymentData.completions[occurrenceId] = {
            isCompleted: true,
            completedAt: new Date().toISOString(),
            deductedAmount: occ.amount,
            deductedCategory: occ.category
        };

        // 6. Persist both wallet and payments
        saveWalletData(wallet);
        savePaymentData();

        // 7. Refresh UI & display confirmation
        renderAll();
        showNotification(
            `Payment completed! Deducted ${formatCurrency(occ.amount)} from your ${occ.category.toUpperCase()} wallet.`,
            "success"
        );
    }

    /**
     * Reversible Undo action restoring exact deducted funds
     */
    async function undoPayment(occurrenceId) {
        const completion = paymentData.completions[occurrenceId];
        if (!completion || !completion.isCompleted) {
            showNotification("Payment is not in a completed state.", "info");
            return;
        }

        // Try server-side authenticated undo
        try {
            const res = await fetch("/api/payments/undo", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ occurrenceId })
            });

            if (res.ok) {
                const sData = await res.json();
                if (sData.success) {
                    saveWalletData(sData.wallet);
                    paymentData = sData.payments;
                    savePaymentData(true);
                    renderAll();
                    showNotification(
                        `Reversed payment! Restored ${formatCurrency(sData.refundedAmount || completion.deductedAmount)} to your ${(sData.refundedCategory || completion.deductedCategory).toUpperCase()} wallet.`,
                        "info"
                    );
                    return;
                }
            }
        } catch (serverErr) {
            console.log("Server undo unreachable, falling back to local undo:", serverErr.message);
        }

        const wallet = getWalletData();
        const refundAmount = Number(completion.deductedAmount) || 0;
        const refundCat = completion.deductedCategory || "bills";

        // Restore funds exactly once
        wallet[refundCat] = Math.round(((wallet[refundCat] || 0) + refundAmount) * 100) / 100;

        // Remove completion record
        delete paymentData.completions[occurrenceId];

        // Save & refresh
        saveWalletData(wallet);
        savePaymentData();
        renderAll();

        showNotification(
            `Reversed payment! Restored ${formatCurrency(refundAmount)} to your ${refundCat.toUpperCase()} wallet.`,
            "info"
        );
    }

    /**
     * Show Insufficient Funds warning modal
     */
    function showInsufficientFundsModal(occ, available) {
        const backdrop = document.getElementById("fiqAlertModalBackdrop");
        const titleEl = document.getElementById("fiqAlertTitle");
        const bodyEl = document.getElementById("fiqAlertBody");
        const footerEl = document.getElementById("fiqAlertFooter");

        if (!backdrop || !titleEl || !bodyEl || !footerEl) {
            alert(`Insufficient funds in ${occ.category.toUpperCase()}! Available: ${formatCurrency(available)}, needed: ${formatCurrency(occ.amount)}.`);
            return;
        }

        titleEl.textContent = "⚠️ Insufficient Funds";
        bodyEl.innerHTML = `
            <p>You do not have enough funds in your <strong>${occ.category.toUpperCase()}</strong> balance to complete this payment.</p>
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin: 12px 0; font-size: 13.5px;">
                <div>Payment: <strong>${escapeHtml(occ.title)}</strong></div>
                <div>Amount Required: <strong style="color: #dc2626;">${formatCurrency(occ.amount)}</strong></div>
                <div>Available Balance: <strong style="color: #16a34a;">${formatCurrency(available)}</strong></div>
                <div style="margin-top: 6px; color: #dc2626; font-weight: 600;">Deficit: ${formatCurrency(occ.amount - available)}</div>
            </div>
            <p style="font-size: 13px; color: #64748b;">To prevent creating an accidental negative balance, this payment remains incomplete. Please add money to your wallet or organize funds first.</p>
        `;

        footerEl.innerHTML = `
            <button type="button" class="btn-secondary" onclick="FundIQCalendar.closeAlertModal()">Close</button>
            <a href="wallet.html" class="btn-primary" style="text-decoration: none; display: inline-block;">Go to Wallet</a>
        `;

        backdrop.classList.add("is-visible");
    }

    /**
     * Open Payment Creation Modal
     */
    function openAddModal(initialDate) {
        const backdrop = document.getElementById("fiqPaymentModalBackdrop");
        const form = document.getElementById("fiqPaymentForm");
        const titleEl = document.getElementById("fiqPaymentModalTitle");

        if (!backdrop || !form) return;

        form.reset();
        document.getElementById("paymentId").value = "";
        document.getElementById("paymentOccurrenceId").value = "";
        titleEl.textContent = "Add Scheduled Payment";

        const dateInput = document.getElementById("paymentDueDate");
        dateInput.value = initialDate || selectedDateStr || formatDateStr(new Date());

        // Hide recurrence scope selector for new payments
        const scopeGroup = document.getElementById("recurrenceScopeGroup");
        if (scopeGroup) scopeGroup.style.display = "none";

        backdrop.classList.add("is-visible");
        document.getElementById("paymentTitle").focus();
    }

    /**
     * Open Payment Edit Modal
     */
    function openEditModal(occurrenceId) {
        const today = new Date();
        const start = new Date(today.getFullYear() - 2, 0, 1);
        const end = new Date(today.getFullYear() + 2, 11, 31);
        const occurrences = generateOccurrences(start, end);
        const occ = occurrences.find((o) => o.occurrenceId === occurrenceId);

        if (!occ) {
            showNotification("Payment occurrence not found.", "error");
            return;
        }

        const backdrop = document.getElementById("fiqPaymentModalBackdrop");
        const form = document.getElementById("fiqPaymentForm");
        const titleEl = document.getElementById("fiqPaymentModalTitle");

        if (!backdrop || !form) return;

        form.reset();
        document.getElementById("paymentId").value = occ.templateId;
        document.getElementById("paymentOccurrenceId").value = occ.occurrenceId;
        titleEl.textContent = "Edit Scheduled Payment";

        document.getElementById("paymentTitle").value = occ.title;
        document.getElementById("paymentAmount").value = occ.amount;
        document.getElementById("paymentDueDate").value = occ.dueDate;
        document.getElementById("paymentCategory").value = occ.category;
        document.getElementById("paymentRecurrence").value = occ.recurrence;

        // Show scope options if recurring
        const scopeGroup = document.getElementById("recurrenceScopeGroup");
        if (scopeGroup) {
            if (occ.recurrence !== "none") {
                scopeGroup.style.display = "block";
                document.getElementById("scopeOccurrence").checked = true;
            } else {
                scopeGroup.style.display = "none";
            }
        }

        // Warning if editing already completed occurrence
        const completedNotice = document.getElementById("completedEditWarning");
        if (completedNotice) {
            completedNotice.style.display = occ.isCompleted ? "block" : "none";
        }

        backdrop.classList.add("is-visible");
        document.getElementById("paymentTitle").focus();
    }

    /**
     * Handle Form Submission (Add or Edit)
     */
    function handleFormSubmit(e) {
        e.preventDefault();

        const templateId = document.getElementById("paymentId").value;
        const occurrenceId = document.getElementById("paymentOccurrenceId").value;
        const title = document.getElementById("paymentTitle").value.trim();
        const amount = Number(document.getElementById("paymentAmount").value);
        const dueDate = document.getElementById("paymentDueDate").value;
        const category = document.getElementById("paymentCategory").value;
        const recurrence = document.getElementById("paymentRecurrence").value;

        // Validation
        if (!title) {
            showNotification("Please enter a payment title.", "error");
            return;
        }
        if (isNaN(amount) || amount <= 0) {
            showNotification("Please enter a valid amount greater than $0.00.", "error");
            return;
        }
        if (!dueDate) {
            showNotification("Please select a due date.", "error");
            return;
        }

        if (!templateId) {
            // NEW PAYMENT
            const newId = `tpl_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            paymentData.templates.push({
                id: newId,
                title: title,
                amount: Math.round(amount * 100) / 100,
                category: category,
                startDate: dueDate,
                recurrence: recurrence,
                notes: ""
            });

            savePaymentData();
            closePaymentModal();
            renderAll();
            showNotification(`Added payment "${title}" to your schedule.`, "success");

        } else {
            // EDIT PAYMENT
            const tplIndex = paymentData.templates.findIndex((t) => t.id === templateId);
            if (tplIndex === -1) {
                showNotification("Original payment series not found.", "error");
                return;
            }

            const tpl = paymentData.templates[tplIndex];
            const isRecurring = tpl.recurrence !== "none";

            // Determine scope if recurring
            let scope = "series";
            if (isRecurring) {
                const scopeRadio = document.querySelector('input[name="editScope"]:checked');
                scope = scopeRadio ? scopeRadio.value : "occurrence";
            }

            if (scope === "occurrence") {
                // Override this single occurrence
                paymentData.overrides[occurrenceId] = {
                    title: title,
                    amount: Math.round(amount * 100) / 100,
                    dueDate: dueDate,
                    category: category,
                    isCancelled: false
                };
                showNotification(`Updated this occurrence of "${title}".`, "success");
            } else {
                // Update entire template series
                tpl.title = title;
                tpl.amount = Math.round(amount * 100) / 100;
                tpl.dueDate = dueDate;
                tpl.category = category;
                tpl.recurrence = recurrence;
                showNotification(`Updated payment series "${title}".`, "success");
            }

            savePaymentData();
            closePaymentModal();
            renderAll();
        }
    }

    /**
     * Delete payment with clear confirmation before destructive actions
     */
    function promptDelete(occurrenceId) {
        const today = new Date();
        const start = new Date(today.getFullYear() - 2, 0, 1);
        const end = new Date(today.getFullYear() + 2, 11, 31);
        const occurrences = generateOccurrences(start, end);
        const occ = occurrences.find((o) => o.occurrenceId === occurrenceId);

        if (!occ) {
            showNotification("Payment occurrence not found.", "error");
            return;
        }

        const backdrop = document.getElementById("fiqAlertModalBackdrop");
        const titleEl = document.getElementById("fiqAlertTitle");
        const bodyEl = document.getElementById("fiqAlertBody");
        const footerEl = document.getElementById("fiqAlertFooter");

        if (!backdrop || !titleEl || !bodyEl || !footerEl) {
            if (confirm(`Are you sure you want to delete "${occ.title}"?`)) {
                executeDelete(occ, "series");
            }
            return;
        }

        const isRecurring = occ.recurrence !== "none";

        titleEl.textContent = "Confirm Deletion";
        bodyEl.innerHTML = `
            <p>Are you sure you want to delete <strong>${escapeHtml(occ.title)}</strong>?</p>
            ${occ.isCompleted ? `<p style="color: #dc2626; font-size: 13px;">⚠️ Note: This payment was already marked completed and deducted from your wallet. Deleting it will remove it from the schedule without reversing the wallet deduction.</p>` : ""}
            ${isRecurring ? `
                <div style="margin-top: 14px;">
                    <label style="font-weight: 700; font-size: 13px; display: block; margin-bottom: 6px;">Delete Scope:</label>
                    <label style="display: block; font-size: 13px; margin-bottom: 6px;">
                        <input type="radio" name="deleteScope" value="occurrence" checked> Delete this occurrence only (${occ.dueDate})
                    </label>
                    <label style="display: block; font-size: 13px;">
                        <input type="radio" name="deleteScope" value="series"> Delete entire recurring series
                    </label>
                </div>
            ` : ""}
        `;

        footerEl.innerHTML = `
            <button type="button" class="btn-secondary" onclick="FundIQCalendar.closeAlertModal()">Cancel</button>
            <button type="button" class="btn-danger" id="confirmDeleteBtn">Delete</button>
        `;

        document.getElementById("confirmDeleteBtn").addEventListener("click", () => {
            const scopeRadio = document.querySelector('input[name="deleteScope"]:checked');
            const scope = scopeRadio ? scopeRadio.value : "series";
            executeDelete(occ, scope);
            closeAlertModal();
        });

        backdrop.classList.add("is-visible");
    }

    function executeDelete(occ, scope) {
        if (scope === "occurrence") {
            paymentData.overrides[occ.occurrenceId] = { isCancelled: true };
            showNotification(`Cancelled occurrence of "${occ.title}" for ${occ.dueDate}.`, "info");
        } else {
            paymentData.templates = paymentData.templates.filter((t) => t.id !== occ.templateId);
            showNotification(`Deleted payment series "${occ.title}".`, "info");
        }
        savePaymentData();
        renderAll();
    }

    /**
     * Modal Close Helpers
     */
    function closePaymentModal() {
        const backdrop = document.getElementById("fiqPaymentModalBackdrop");
        if (backdrop) backdrop.classList.remove("is-visible");
    }

    function closeAlertModal() {
        const backdrop = document.getElementById("fiqAlertModalBackdrop");
        if (backdrop) backdrop.classList.remove("is-visible");
    }

    /**
     * Toast notification banner
     */
    function showNotification(message, type = "info") {
        // Remove existing notification
        const existing = document.querySelector(".fiq-notification");
        if (existing) existing.remove();

        const notif = document.createElement("div");
        notif.className = `fiq-notification ${type}`;
        notif.innerHTML = `
            <span>${type === "success" ? "✓" : type === "error" ? "⚠️" : "ℹ️"}</span>
            <div>${escapeHtml(message)}</div>
        `;

        document.body.appendChild(notif);
        setTimeout(() => {
            notif.remove();
        }, 4000);
    }

    /**
     * Escape HTML string helper
     */
    function escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text || "";
        return div.innerHTML;
    }

    /**
     * Render all components in sync
     */
    function renderAll() {
        renderWalletBar();
        renderCalendar();
        renderSelectedDateDetail();
        renderUpcomingPayments();
    }

    /**
     * Bind DOM buttons and navigation
     */
    function bindCalendarEvents() {
        // Prev Month
        const prevBtn = document.getElementById("calPrevMonth");
        if (prevBtn) {
            prevBtn.addEventListener("click", () => {
                currentMonth--;
                if (currentMonth < 0) {
                    currentMonth = 11;
                    currentYear--;
                }
                renderCalendar();
            });
        }

        // Next Month
        const nextBtn = document.getElementById("calNextMonth");
        if (nextBtn) {
            nextBtn.addEventListener("click", () => {
                currentMonth++;
                if (currentMonth > 11) {
                    currentMonth = 0;
                    currentYear++;
                }
                renderCalendar();
            });
        }

        // Today Button
        const todayBtn = document.getElementById("calTodayBtn");
        if (todayBtn) {
            todayBtn.addEventListener("click", () => {
                const now = new Date();
                currentYear = now.getFullYear();
                currentMonth = now.getMonth();
                selectedDateStr = formatDateStr(now);
                renderCalendar();
                renderSelectedDateDetail();
            });
        }

        // Add Payment Button
        const addBtn = document.getElementById("upcomingAddPaymentBtn");
        if (addBtn) {
            addBtn.addEventListener("click", () => openAddModal());
        }

        // Filter chips
        const filterChips = document.querySelectorAll(".filter-chip");
        filterChips.forEach((chip) => {
            chip.addEventListener("click", () => {
                filterChips.forEach((c) => c.classList.remove("active"));
                chip.classList.add("active");
                activeFilter = chip.getAttribute("data-filter") || "all";
                renderUpcomingPayments();
            });
        });

        // Modal Form Submit
        const form = document.getElementById("fiqPaymentForm");
        if (form) {
            form.addEventListener("submit", handleFormSubmit);
        }

        // Modal Cancel / Close Buttons
        const modalClose = document.getElementById("paymentModalClose");
        if (modalClose) modalClose.addEventListener("click", closePaymentModal);

        const modalCancel = document.getElementById("paymentModalCancel");
        if (modalCancel) modalCancel.addEventListener("click", closePaymentModal);

        // Close on escape key
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                closePaymentModal();
                closeAlertModal();
            }
        });
    }

    // Initialize when DOM is ready
    function init() {
        loadPaymentData();
        bindCalendarEvents();
        renderAll();
        syncPaymentsFromServer();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    // Public API for event handlers
    window.FundIQCalendar = {
        completePayment,
        undoPayment,
        openAddModal,
        openEditModal,
        promptDelete,
        closeAlertModal,
        closePaymentModal
    };
})();

