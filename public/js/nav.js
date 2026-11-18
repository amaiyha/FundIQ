// public/js/nav.js - Shared Sidebar Navigation, User Profile & Logout Handler
document.addEventListener("DOMContentLoaded", async () => {
    function getInitials(name) {
        if (!name || typeof name !== "string") return "FI";
        const parts = name.trim().split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        }
        return name.trim().slice(0, 2).toUpperCase() || "FI";
    }

    function clearClientUserCache() {
        localStorage.removeItem("fundiqUserId");
        localStorage.removeItem("fundiqName");
        localStorage.removeItem("fundiqUsername");
        localStorage.removeItem("fundiqEmail");
        localStorage.removeItem("fundiqWallet");
        localStorage.removeItem("fundiqPayments_v1");
        localStorage.removeItem("fundiqSubCategories_v1");
    }

    function applyUserProfile(fullName, username, email) {
        const cleanFull = fullName && String(fullName).trim() ? String(fullName).trim() : "";
        const cleanUser = username && String(username).trim() ? String(username).trim() : "";
        const displayName = cleanFull || cleanUser || "Guest";
        const displayEmail = email && String(email).trim()
            ? String(email).trim()
            : (cleanUser ? `${cleanUser}@fundiq.app` : "Not signed in");
        const initials = getInitials(displayName);

        document.querySelectorAll(".js-user-name").forEach((el) => {
            el.textContent = displayName;
        });
        document.querySelectorAll(".js-user-email").forEach((el) => {
            el.textContent = displayEmail;
        });
        document.querySelectorAll(".js-user-initials").forEach((el) => {
            el.textContent = initials;
        });

        const homeNameEl = document.getElementById("userName");
        if (homeNameEl) {
            homeNameEl.textContent = displayName;
        }
    }

    // Authoritative sync with authenticated session on server
    try {
        const res = await fetch("/api/auth/me", {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store"
        });
        if (res.ok) {
            const data = await res.json();
            if (data.authenticated && data.user) {
                const prevUserId = localStorage.getItem("fundiqUserId");
                if (prevUserId && prevUserId !== String(data.user.id)) {
                    // User switched accounts; clear stale cached wallet/payment items
                    localStorage.removeItem("fundiqWallet");
                    localStorage.removeItem("fundiqPayments_v1");
                    localStorage.removeItem("fundiqSubCategories_v1");
                }

                const resolvedName = (data.user.fullName && data.user.fullName.trim())
                    ? data.user.fullName.trim()
                    : data.user.username;

                localStorage.setItem("fundiqUserId", String(data.user.id));
                localStorage.setItem("fundiqName", resolvedName);
                localStorage.setItem("fundiqUsername", data.user.username);
                if (data.user.email) {
                    localStorage.setItem("fundiqEmail", data.user.email);
                } else {
                    localStorage.removeItem("fundiqEmail");
                }

                applyUserProfile(data.user.fullName, data.user.username, data.user.email);

                window.dispatchEvent(new CustomEvent("fundiq:user-loaded", {
                    detail: data.user
                }));

                // Populate sidebar Weekly Insight card only when the user has real weekly report activity
                fetch("/api/insights/weekly", { credentials: "same-origin", cache: "no-store" })
                    .then((r) => (r.ok ? r.json() : null))
                    .then((wData) => {
                        const rep = wData && wData.success ? wData.latestReport : null;
                        const hasActivity =
                            rep &&
                            ((Number(rep.totalSpent) || 0) > 0 ||
                                (Number(rep.prevWeekSpent) || 0) > 0 ||
                                (Number(rep.totalDeposited) || 0) > 0);

                        document.querySelectorAll(".sidebar-insight-card").forEach((cardEl) => {
                            const textEl = cardEl.querySelector(".insight-text");
                            if (hasActivity && textEl) {
                                const pct = Number(rep.spendingChangePct) || 0;
                                const dirText =
                                    pct < 0
                                        ? `You spent ${Math.abs(pct)}% less this week ($${rep.totalSpent.toFixed(0)} vs. $${rep.prevWeekSpent.toFixed(0)}).`
                                        : pct > 0
                                        ? `Spending is up ${pct}% this week ($${rep.totalSpent.toFixed(0)} total).`
                                        : `You spent $${rep.totalSpent.toFixed(0)} this week ($${rep.totalDeposited.toFixed(0)} deposited).`;
                                textEl.textContent = dirText;
                                cardEl.style.display = "";
                            } else {
                                if (textEl) textEl.textContent = "";
                                cardEl.style.display = "none";
                            }
                        });
                    })
                    .catch(() => {});
            } else {
                // Not authenticated on server -> never display a previous user's cached name
                clearClientUserCache();
                applyUserProfile("Guest", "", "Not signed in");
                window.dispatchEvent(new CustomEvent("fundiq:user-loaded", {
                    detail: null
                }));
            }
        }
    } catch (e) {
        // Offline fallback if server cannot be reached
        const cachedName = localStorage.getItem("fundiqName");
        const cachedUsername = localStorage.getItem("fundiqUsername");
        const cachedEmail = localStorage.getItem("fundiqEmail");
        if (cachedName || cachedUsername) {
            applyUserProfile(cachedName, cachedUsername, cachedEmail);
        } else {
            applyUserProfile("Guest", "", "Offline mode");
        }
    }

    // Intercept logout navigation to securely invalidate server session
    const navLinks = document.querySelectorAll(".nav-links a, .js-logout-link");
    navLinks.forEach((link) => {
        const text = link.textContent.trim().toLowerCase();
        if (text.includes("logout") || text.includes("log out") || link.classList.contains("js-logout-link")) {
            link.addEventListener("click", async (e) => {
                e.preventDefault();
                try {
                    await fetch("/api/auth/logout", {
                        method: "POST",
                        credentials: "same-origin",
                        headers: { "Content-Type": "application/json" }
                    });
                } catch (err) {
                    console.error("Logout request error:", err);
                }

                // Clear all client-side user caches
                clearClientUserCache();

                window.location.href = "index.html?loggedout=1";
            });
        }
    });
});

