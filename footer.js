// Auto-insert themed footer across all pages
document.addEventListener("DOMContentLoaded", () => {
  const footerHTML = `
    <footer style="
      background:#1a1d24;
      color:#9aa4b2;
      padding:25px 16px;
      text-align:center;
      font-size:0.88rem;
      border-top:1px solid #2d3340;
      margin-top:40px;
    ">
      <p style="margin:0 0 10px 0;">
        Disclaimer: 1079Magic is an independent, fan‑made tool for KingShot players.
        Not affiliated with or endorsed by the game’s developers or publisher.
      </p>

      <p style="margin:0 0 10px 0;">
        <a href="/disclaimer.html" style="color:#3b82f6;">Full Disclaimer</a> ·
        <a href="/privacy.html" style="color:#3b82f6;">Privacy & GDPR</a>
      </p>

      <p style="margin:0;">
        © 2026 1079Magic — Created by Egon Hadžisejdić
      </p>
    </footer>
  `;

  document.body.insertAdjacentHTML("beforeend", footerHTML);
});