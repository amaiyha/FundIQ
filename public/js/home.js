const userName = localStorage.getItem("fundiqName");

if (userName) {
    document.getElementById("userName").textContent = userName;
}