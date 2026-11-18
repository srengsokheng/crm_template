// The offline page: reload when the connection is back (or when "Try again" is pressed).
document.getElementById('retry').addEventListener('click', function () { window.location.reload(); });
window.addEventListener('online', function () { window.location.reload(); });
