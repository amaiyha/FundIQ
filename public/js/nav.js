// public/js/nav.js - Shared Navigation & Logout Handler
document.addEventListener("DOMContentLoaded", () => {
    // Intercept logout navigation to securely invalidate server session
    const navLinks = document.querySelectorAll('.nav-links a');
    navLinks.forEach(link => {
        if (link.textContent.trim().toLowerCase().includes("logout")) {
            link.addEventListener("click", async (e) => {
                e.preventDefault();
                try {
                    await fetch("/api/auth/logout", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" }
                    });
                } catch (err) {
                    console.error("Logout request error:", err);
                }

                // Clear client-side display caches
                localStorage.removeItem("fundiqName");
                localStorage.removeItem("fundiqUsername");
                localStorage.removeItem("fundiqWallet");
                localStorage.removeItem("fundiqPayments_v1");

                window.location.href = "index.html?loggedout=1";
            });
        }
    });
});

