/* Pages rendues par le serveur (connexion unique) : même style que l'interface, sans script. */
import { esc } from "./util.js";

const T = {
  fr: {
    error: "Connexion <em>impossible</em>",
    errorText: "La demande de connexion n'a pas pu aboutir.",
    denied: "Accès <em>refusé</em>",
    deniedText: (app) => `Votre compte Kosmy Board n'a pas d'espace relié à ${app}. Ajoutez cette instance dans votre Board et activez sa connexion unique, ou demandez à la personne qui gère le Board.`,
    deniedBack: (app) => `Revenir à ${app} →`,
    toBoard: "Ouvrir le Board",
    logout: "Se déconnecter <em>de l'appli</em>",
    logoutText: (app) => `${app} demande la fin de votre connexion par Kosmy Board. Votre session sur le Board, elle, reste ouverte.`,
    logoutYes: "Se déconnecter →",
    logoutNo: "Annuler",
    loggedOut: "Vous êtes <em>déconnecté</em>",
    loggedOutText: (app) => `La connexion à ${app} par Kosmy Board est terminée.`,
    details: "Détail technique",
  },
  en: {
    error: "Sign-in <em>failed</em>",
    errorText: "The sign-in request could not be completed.",
    denied: "Access <em>denied</em>",
    deniedText: (app) => `Your Kosmy Board account has no space linked to ${app}. Add this instance to your Board and turn on its single sign-on, or ask whoever runs the Board.`,
    deniedBack: (app) => `Back to ${app} →`,
    toBoard: "Open the Board",
    logout: "Sign out <em>of the app</em>",
    logoutText: (app) => `${app} asks to end your Kosmy Board sign-in. Your Board session stays open.`,
    logoutYes: "Sign out →",
    logoutNo: "Cancel",
    loggedOut: "You're <em>signed out</em>",
    loggedOutText: (app) => `Your Kosmy Board sign-in to ${app} has ended.`,
    details: "Technical detail",
  },
};

/** Langue de la page : celle du compte, sinon celle du navigateur. */
export function pageLang(req, user) {
  if (user?.lang === "fr" || user?.lang === "en") return user.lang;
  return /^fr\b/i.test(String(req.headers["accept-language"] || "fr")) ? "fr" : "en";
}
export const tr = (lang) => T[lang] ?? T.fr;

export function page({ lang, kicker, title, body }) {
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex">
  <title>Kosmy Board</title>
  <link rel="icon" href="/assets/kosmy-logo.webp" type="image/webp">
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&family=Inter+Tight:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="top">
    <div class="top-start">
      <a class="brand" href="/" aria-label="Kosmy Board">
        <span class="mark"><img src="/assets/kosmy-logo.webp" alt="" width="34" height="34"></span>
        <span class="serif"><span class="wm">Kosmy </span><em>Board</em></span>
      </a>
    </div>
  </header>
  <main id="main">
    <section class="page oidc-page">
      <p class="mono kicker fade">${esc(kicker)}</p>
      <h1 class="serif page-title fade">${title}</h1>
      <div class="fade" style="--d:.2s">${body}</div>
    </section>
  </main>
</body>
</html>`;
}
