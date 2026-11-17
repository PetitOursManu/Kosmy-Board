/* Textes de l'interface (français / anglais). */

const STR = {
  fr: {
    title: "Kosmy Board — vos espaces admin",
    brand: "Kosmy Board, accueil",
    backToKosmy: "← Kosmy",
    langLabel: "Langue",
    account: "Compte",
    statusLine: (n, up) => (n ? `${n} instance${n > 1 ? "s" : ""} · ${up} joignable${up > 1 ? "s" : ""}` : "Aucune instance"),
    loading: "Chargement…",
    footNote: "Kosmy Board · le Board ne voit jamais les mots de passe de vos instances",
    skip: "Aller au contenu",

    /* Connexion */
    loginKicker: "(00) — Connexion",
    loginTitle: "Kosmy <em>Board</em>",
    loginText: "Les panneaux d'administration de vos instances auto-hébergées, au même endroit. Connectez-vous pour retrouver vos espaces.",
    email: "E-mail",
    password: "Mot de passe",
    signIn: "Se connecter →",
    signingIn: "Connexion…",
    setupKicker: "(00) — Première configuration",
    setupTitle: "Bienvenue sur <em>Kosmy Board</em>",
    setupText: "Aucun compte n'existe encore. Créez le compte administrateur : vous pourrez ensuite inviter d'autres personnes.",
    setupCode: "Code de configuration",
    setupCodeHint: "Affiché dans les journaux du serveur au démarrage (par exemple dans Coolify, onglet Logs).",
    name: "Votre nom",
    passwordHint: (n) => `${n} caractères au minimum.`,
    createAdmin: "Créer le compte →",
    inviteKicker: "(00) — Invitation",
    inviteTitle: "Rejoindre <em>Kosmy Board</em>",
    inviteText: "On vous a invité sur ce Board. Créez votre compte : vos espaces ne seront visibles que par vous.",
    inviteInvalid: "Ce lien d'invitation n'est plus valable. Demandez-en un nouveau à l'administrateur du Board.",
    createAccount: "Créer mon compte →",
    toLogin: "J'ai déjà un compte",

    /* Liste */
    listKicker: "(01) — Vos instances",
    listTitle: "Espaces <em>admin</em>",
    listText: "Le panneau d'administration de chacune de vos instances, à un clic. Chaque espace s'ouvre dans son propre onglet : votre navigateur garde la session de l'instance, le Board ne voit jamais vos mots de passe.",
    add: "Ajouter une instance",
    search: "Rechercher",
    searchPlaceholder: "Nom ou adresse…",
    all: "Tout",
    others: "Autres applis",
    themesLabel: "Filtrer par thème",
    results: (n) => `${n} résultat${n > 1 ? "s" : ""}`,
    noMatch: "Aucune instance ne correspond.",
    emptyTitle: "Aucune instance pour l'instant",
    emptyText: "Choisissez une appli, puis donnez l'adresse où vous l'hébergez.",
    open: "Ouvrir",
    edit: "Modifier",
    remove: "Supprimer",
    openLabel: (name, host) => `Ouvrir ${name} (${host}) dans un nouvel onglet`,
    neverOpened: "Jamais ouvert",
    openedAgo: (rel) => `Ouvert ${rel}`,
    justNow: "à l'instant",
    statusUp: "Joignable",
    statusDown: "Injoignable",
    statusUnknown: "Non vérifiable",
    statusChecking: "Vérification…",
    statusUnknownHint: "Le navigateur bloque les adresses http:// depuis une page en https://.",
    recheck: "Vérifier à nouveau",
    statusNote: "Le statut est vérifié depuis votre navigateur : c'est une simple indication, pas un contrôle d'accès.",
    sessionNote: "Le Board ne peut pas vous déconnecter d'une instance : la session appartient au site de l'instance, pas au Board. Pour vous déconnecter, faites-le dans sa page.",
    cleartext: "Non chiffré",
    otherApp: "Autre appli web",

    /* Suppression */
    removeTitle: (name) => `Supprimer ${name} ?`,
    removeText: "L'espace disparaît du Board. Rien n'est supprimé sur le serveur de l'instance, et la session de votre navigateur reste ouverte : déconnectez-vous dans sa page si besoin.",
    cancel: "Annuler",
    removed: (name) => `${name} a été retiré du Board.`,

    /* Ajout / modification */
    back: "← Retour",
    newKicker: "Nouvelle instance",
    editKicker: "Modifier l'instance",
    whichApp: "Quelle <em>appli</em> ?",
    whereIs: (name) => `Où se trouve <em>${name}</em> ?`,
    yourApp: "votre appli",
    otherTitle: "Autre <em>appli web</em>",
    otherText: "N'importe quel site avec une page d'administration",
    change: "Changer",
    fieldName: "Nom",
    fieldNamePlaceholder: "Mon appli",
    fieldNameHint: "Utile si vous avez plusieurs instances de la même appli.",
    fieldAddress: "Adresse de votre instance",
    fieldPath: "Page d'administration",
    pathHint: (name) => `Déjà renseignée pour ${name}. À changer seulement si votre instance est différente.`,
    preview: "Le Board ouvrira",
    cleartextWarning: "Adresse non chiffrée (http) hors de votre réseau local : sur Internet, votre mot de passe circulerait en clair. Préférez https://.",
    cleartextLocal: "Adresse non chiffrée (http) : à garder pour votre réseau local.",
    unreachable: "Le Board n'arrive pas à joindre cette adresse depuis votre navigateur. Vérifiez-la, ou enregistrez-la quand même si le serveur n'est accessible que depuis un autre réseau.",
    checking: "Vérification de l'adresse…",
    saveAnyway: "Enregistrer quand même",
    save: "Enregistrer",
    addSpace: "Ajouter l'instance →",
    added: (name) => `${name} a été ajouté.`,
    saved: "Modifications enregistrées.",
    removeSpace: "Supprimer l'instance",
    removeSpaceHint: "Rien n'est supprimé sur le serveur",
    notFound: "Cet espace n'existe plus.",
    editAside: "Le Board ne garde que l'adresse de l'instance et sa page d'administration. Vous vous connectez dans la page elle-même, dans son propre onglet : votre navigateur garde ensuite la session.",

    /* Compte */
    accountKicker: "(02) — Compte",
    accountTitle: "Votre <em>compte</em>",
    profile: "Profil",
    saveName: "Enregistrer le nom",
    nameSaved: "Nom enregistré.",
    changePassword: "Changer de mot de passe",
    currentPassword: "Mot de passe actuel",
    newPassword: "Nouveau mot de passe",
    passwordChanged: "Mot de passe changé. Vos autres appareils ont été déconnectés du Board.",
    backup: "Sauvegarde",
    backupText: "Exportez la liste de vos espaces en JSON (le format des espaces admin de Kosmy Mobile), et importez-la sur un autre Board. Aucun mot de passe n'y figure.",
    export: "Exporter (JSON)",
    import: "Importer un fichier",
    imported: (a, s, i) => `${a} espace${a > 1 ? "s" : ""} importé${a > 1 ? "s" : ""}` + (s ? ` · ${s} déjà présent${s > 1 ? "s" : ""}` : "") + (i ? ` · ${i} invalide${i > 1 ? "s" : ""}` : "") + ".",
    importBad: "Ce fichier n'est pas un export du Board ni une liste d'espaces Kosmy.",
    members: "Membres",
    membersText: "Chaque personne a son propre compte et ses propres espaces. Un lien d'invitation sert une seule fois et expire au bout de 7 jours.",
    you: "vous",
    roleAdmin: "Administrateur",
    roleMember: "Membre",
    spacesCount: (n) => `${n} espace${n > 1 ? "s" : ""}`,
    invite: "Créer un lien d'invitation",
    inviteAs: "Rôle",
    inviteLink: "Lien à transmettre (affiché une seule fois)",
    copy: "Copier",
    copied: "Lien copié.",
    pendingInvite: (d) => `Invitation en attente · expire ${d}`,
    revoke: "Révoquer",
    removeMember: "Retirer",
    removeMemberTitle: (name) => `Retirer ${name} du Board ?`,
    removeMemberText: "Son compte et ses espaces sont supprimés du Board. Rien n'est touché sur les instances.",
    signOut: "Se déconnecter du Board",
    signOutText: "Ferme votre session sur ce Board, sur cet appareil. Les sessions ouvertes dans les onglets de vos instances ne sont pas concernées.",

    /* Erreurs */
    errors: {
      empty: "Indiquez l'adresse de votre instance.",
      scheme: "Cette adresse ne commence ni par https:// ni par http://.",
      credentials: "Retirez l'identifiant de l'adresse : vous vous connecterez dans la page.",
      invalid: "L'adresse ne semble pas valide.",
      path: "La page d'administration n'est pas valide.",
      name: "Indiquez un nom.",
      email: "Cette adresse e-mail ne semble pas valide.",
      password_short: (e) => `Le mot de passe doit faire au moins ${e.min} caractères.`,
      password_long: "Ce mot de passe est trop long.",
      setup_code: "Ce code de configuration n'est pas le bon.",
      already_setup: "Le Board est déjà configuré. Connectez-vous.",
      login_failed: "E-mail ou mot de passe incorrect.",
      locked: (e) => `Trop de tentatives. Réessayez dans ${Math.ceil(e.wait / 60)} min.`,
      current_password: "Le mot de passe actuel n'est pas le bon.",
      invite_invalid: "Ce lien d'invitation n'est plus valable.",
      email_taken: "Un compte existe déjà avec cette adresse e-mail.",
      too_many: "Vous avez atteint le nombre maximal d'espaces.",
      import_format: "Ce fichier n'est pas un export du Board ni une liste d'espaces Kosmy.",
      auth: "Votre session a expiré. Reconnectez-vous.",
      network: "Le Board ne répond pas. Vérifiez votre connexion.",
      server: "Erreur du serveur. Réessayez dans un instant.",
      generic: "Quelque chose n'a pas fonctionné.",
    },
  },

  en: {
    title: "Kosmy Board — your admin spaces",
    brand: "Kosmy Board, home",
    backToKosmy: "← Kosmy",
    langLabel: "Language",
    account: "Account",
    statusLine: (n, up) => (n ? `${n} instance${n > 1 ? "s" : ""} · ${up} reachable` : "No instances"),
    loading: "Loading…",
    footNote: "Kosmy Board · the Board never sees your instances' passwords",
    skip: "Skip to content",

    loginKicker: "(00) — Sign in",
    loginTitle: "Kosmy <em>Board</em>",
    loginText: "The admin panels of your self-hosted instances, in one place. Sign in to find your spaces.",
    email: "Email",
    password: "Password",
    signIn: "Sign in →",
    signingIn: "Signing in…",
    setupKicker: "(00) — First setup",
    setupTitle: "Welcome to <em>Kosmy Board</em>",
    setupText: "No account exists yet. Create the administrator account: you can invite other people afterwards.",
    setupCode: "Setup code",
    setupCodeHint: "Shown in the server logs at startup (for example in Coolify, Logs tab).",
    name: "Your name",
    passwordHint: (n) => `At least ${n} characters.`,
    createAdmin: "Create the account →",
    inviteKicker: "(00) — Invitation",
    inviteTitle: "Join <em>Kosmy Board</em>",
    inviteText: "You've been invited to this Board. Create your account: your spaces will only be visible to you.",
    inviteInvalid: "This invitation link is no longer valid. Ask the Board's administrator for a new one.",
    createAccount: "Create my account →",
    toLogin: "I already have an account",

    listKicker: "(01) — Your instances",
    listTitle: "Admin <em>spaces</em>",
    listText: "The admin panel of each of your instances, one click away. Each space opens in its own tab: your browser keeps the instance's session, and the Board never sees your passwords.",
    add: "Add an instance",
    search: "Search",
    searchPlaceholder: "Name or address…",
    all: "All",
    others: "Other apps",
    themesLabel: "Filter by theme",
    results: (n) => `${n} result${n > 1 ? "s" : ""}`,
    noMatch: "No instance matches.",
    emptyTitle: "No instances yet",
    emptyText: "Pick an app, then enter the address where you host it.",
    open: "Open",
    edit: "Edit",
    remove: "Delete",
    openLabel: (name, host) => `Open ${name} (${host}) in a new tab`,
    neverOpened: "Never opened",
    openedAgo: (rel) => `Opened ${rel}`,
    justNow: "just now",
    statusUp: "Reachable",
    statusDown: "Unreachable",
    statusUnknown: "Can't check",
    statusChecking: "Checking…",
    statusUnknownHint: "Browsers block http:// addresses from an https:// page.",
    recheck: "Check again",
    statusNote: "Status is checked from your browser: it's a simple indication, not an access check.",
    sessionNote: "The Board can't sign you out of an instance: the session belongs to the instance's site, not to the Board. To sign out, do it on its page.",
    cleartext: "Unencrypted",
    otherApp: "Other web app",

    removeTitle: (name) => `Delete ${name}?`,
    removeText: "The space disappears from the Board. Nothing is deleted on the instance's server, and your browser's session stays open: sign out on its page if needed.",
    cancel: "Cancel",
    removed: (name) => `${name} was removed from the Board.`,

    back: "← Back",
    newKicker: "New instance",
    editKicker: "Edit instance",
    whichApp: "Which <em>app</em>?",
    whereIs: (name) => `Where is <em>${name}</em>?`,
    yourApp: "your app",
    otherTitle: "Other <em>web app</em>",
    otherText: "Any site with an admin page",
    change: "Change",
    fieldName: "Name",
    fieldNamePlaceholder: "My app",
    fieldNameHint: "Handy if you have several instances of the same app.",
    fieldAddress: "Your instance's address",
    fieldPath: "Admin page",
    pathHint: (name) => `Already filled in for ${name}. Only change it if your instance is different.`,
    preview: "The Board will open",
    cleartextWarning: "Unencrypted (http) address outside your local network: over the Internet, your password would travel in clear text. Prefer https://.",
    cleartextLocal: "Unencrypted (http) address: keep it for your local network.",
    unreachable: "The Board can't reach this address from your browser. Check it, or save it anyway if the server is only reachable from another network.",
    checking: "Checking the address…",
    saveAnyway: "Save anyway",
    save: "Save",
    addSpace: "Add the instance →",
    added: (name) => `${name} was added.`,
    saved: "Changes saved.",
    removeSpace: "Delete the instance",
    removeSpaceHint: "Nothing is deleted on the server",
    notFound: "This space no longer exists.",
    editAside: "The Board only keeps the instance's address and its admin page. You sign in on the page itself, in its own tab: your browser then keeps the session.",

    accountKicker: "(02) — Account",
    accountTitle: "Your <em>account</em>",
    profile: "Profile",
    saveName: "Save name",
    nameSaved: "Name saved.",
    changePassword: "Change password",
    currentPassword: "Current password",
    newPassword: "New password",
    passwordChanged: "Password changed. Your other devices were signed out of the Board.",
    backup: "Backup",
    backupText: "Export your list of spaces as JSON (the Kosmy Mobile admin spaces format), and import it into another Board. It contains no passwords.",
    export: "Export (JSON)",
    import: "Import a file",
    imported: (a, s, i) => `${a} space${a > 1 ? "s" : ""} imported` + (s ? ` · ${s} already there` : "") + (i ? ` · ${i} invalid` : "") + ".",
    importBad: "This file is neither a Board export nor a list of Kosmy spaces.",
    members: "Members",
    membersText: "Each person has their own account and their own spaces. An invitation link works once and expires after 7 days.",
    you: "you",
    roleAdmin: "Administrator",
    roleMember: "Member",
    spacesCount: (n) => `${n} space${n > 1 ? "s" : ""}`,
    invite: "Create an invitation link",
    inviteAs: "Role",
    inviteLink: "Link to share (shown only once)",
    copy: "Copy",
    copied: "Link copied.",
    pendingInvite: (d) => `Pending invitation · expires ${d}`,
    revoke: "Revoke",
    removeMember: "Remove",
    removeMemberTitle: (name) => `Remove ${name} from the Board?`,
    removeMemberText: "Their account and spaces are deleted from the Board. Nothing is touched on the instances.",
    signOut: "Sign out of the Board",
    signOutText: "Ends your session on this Board, on this device. Sessions open in your instances' tabs are not affected.",

    errors: {
      empty: "Enter your instance's address.",
      scheme: "This address starts with neither https:// nor http://.",
      credentials: "Remove the username from the address: you'll sign in on the page.",
      invalid: "This address doesn't look valid.",
      path: "The admin page isn't valid.",
      name: "Enter a name.",
      email: "This email address doesn't look valid.",
      password_short: (e) => `The password must be at least ${e.min} characters long.`,
      password_long: "This password is too long.",
      setup_code: "This setup code is wrong.",
      already_setup: "The Board is already set up. Sign in.",
      login_failed: "Wrong email or password.",
      locked: (e) => `Too many attempts. Try again in ${Math.ceil(e.wait / 60)} min.`,
      current_password: "The current password is wrong.",
      invite_invalid: "This invitation link is no longer valid.",
      email_taken: "An account already exists with this email address.",
      too_many: "You've reached the maximum number of spaces.",
      import_format: "This file is neither a Board export nor a list of Kosmy spaces.",
      auth: "Your session has expired. Please sign in again.",
      network: "The Board isn't responding. Check your connection.",
      server: "Server error. Try again in a moment.",
      generic: "Something went wrong.",
    },
  },
};

const KEY = "kosmy-board-lang";
export let lang = "fr";

/** Le choix déjà fait sur ce navigateur, sinon celui du compte, sinon la langue préférée du navigateur. */
export function initialLang(accountLang) {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "fr" || saved === "en") return saved;
  } catch { /* stockage indisponible : on suit le navigateur */ }
  if (accountLang === "fr" || accountLang === "en") return accountLang;
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language || "fr"];
  return String(prefs[0]).toLowerCase().startsWith("fr") ? "fr" : "en";
}

export function setLang(next, remember = false) {
  lang = next;
  document.documentElement.lang = lang;
  if (remember) {
    try { localStorage.setItem(KEY, lang); } catch { /* choix non mémorisé */ }
  }
}

/** t("clé", ...arguments) : texte ou fonction de texte. */
export function t(key, ...args) {
  const v = STR[lang][key] ?? STR.fr[key];
  return typeof v === "function" ? v(...args) : v ?? key;
}

/** Message d'erreur pour un code renvoyé par l'API ou par normalizeBase. */
export function errorText(code, extra = {}) {
  const v = STR[lang].errors[code] ?? STR[lang].errors.generic;
  return typeof v === "function" ? v(extra) : v;
}

/** « il y a 2 heures », « hier »… */
export function relTime(ts) {
  const diff = (ts - Date.now()) / 1000;
  if (Math.abs(diff) < 45) return t("justNow");
  const fmt = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const steps = [[60, "second"], [60, "minute"], [24, "hour"], [7, "day"], [4.35, "week"], [12, "month"], [Infinity, "year"]];
  let v = diff;
  for (const [size, unit] of steps) {
    if (Math.abs(v) < size) return fmt.format(Math.round(v), unit);
    v /= size;
  }
  return "";
}
