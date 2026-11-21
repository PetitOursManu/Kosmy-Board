# Kosmy Board

Les panneaux d'administration de vos instances auto-hébergées (Kanby, Crafty, Lumy, Dashy…), au même endroit.
C'est l'équivalent web de l'onglet « Admin » de [Kosmy Mobile](https://github.com/PetitOursManu/Kosmy-Mobile),
avec la même identité visuelle que le site Kosmy.

- **Comptes** : chaque personne a son compte et sa propre liste d'espaces, retrouvée sur tous ses appareils.
  Le premier compte (administrateur) est créé au premier lancement ; les suivants arrivent par lien d'invitation.
- **Espaces** : une appli du catalogue Kosmy (le chemin de sa page d'admin est pré-rempli) ou n'importe quelle autre appli web.
- **Statut** : « joignable » ou « injoignable », vérifié depuis votre navigateur. C'est une indication, pas un contrôle d'accès.
- **Connexion unique** : le Board est un fournisseur d'identité OpenID Connect. Une appli reliée
  propose « Se connecter avec Kosmy Board », et « Ouvrir » vous y connecte directement.
- **Admin dans le Board** : une fois reliée, une instance s'administre depuis le Board lui-même
  (comptes, réglages, maintenance…), sans ouvrir l'appli.
- **Double authentification** (TOTP, avec codes de secours) pour les comptes du Board.
- **Synchronisation avec Kosmy Mobile** : on se connecte une fois dans l'onglet Admin de l'appli, et les espaces sont les mêmes partout.
- **Export / import** en JSON, au format des espaces admin de Kosmy Mobile.
- Français / anglais, ordinateur et mobile, animations réduites si le système le demande.

## Comment s'ouvre un espace

Le Board n'affiche pas les pages d'admin dans une iframe : la plupart des applis l'interdisent
(`frame-ancestors`, `X-Frame-Options`), et les navigateurs bloquent les cookies tiers.

- **Ouvrir** ouvre la page d'admin dans un onglet qui porte le nom de l'espace. Si cet onglet est déjà ouvert, le Board le ramène
  au premier plan au lieu d'en créer un nouveau. Le lien entre l'onglet et le Board est coupé aussitôt (`opener = null`).
  Une instance qui envoie `Cross-Origin-Opener-Policy` (Dashy, via helmet) s'ouvre dans un nouvel onglet à chaque fois.
- On se connecte dans la page de l'instance, comme d'habitude : le navigateur garde la session de chaque instance.
- **Le Board ne voit et ne stocke jamais les mots de passe de vos instances.** Il ne garde que l'adresse et la page d'admin.
- Le Board ne peut pas vous déconnecter d'une instance (il ne peut pas effacer les cookies d'un autre site) :
  supprimer un espace ne ferme pas sa session. Déconnectez-vous dans la page de l'instance.

## Connexion unique

Avec la connexion unique, il suffit d'être connecté au Board : plus de mot de passe à saisir dans chaque appli.

1. Dans le Board : **Modifier** l'espace → **Connexion unique** → activer. Le Board crée un client OpenID Connect
   pour l'instance et affiche les réglages à coller dans l'appli (émetteur, identifiant et secret client).
2. Dans l'appli : coller ces réglages dans sa page d'administration.
3. **Ouvrir**, dans le Board, vous connecte directement à l'appli.

- Le Board ne connaît toujours pas les mots de passe des instances : c'est l'appli qui fait confiance au Board.
- Seules les personnes qui ont l'espace dans leur Board peuvent se connecter à l'instance par le Board.
  Plusieurs personnes peuvent partager la même instance : elles rejoignent le même client.
- Se déconnecter du Board coupe les nouvelles connexions aux applis (les sessions déjà ouvertes dans les applis restent ouvertes).
- L'appli doit savoir se connecter avec OpenID Connect. Pour les applis Kosmy, voir le
  [guide d'intégration](docs/integration.md) ; l'[appli de démonstration](examples/demo-app/server.js) en est l'implémentation de référence.

## Admin dans le Board

Pour une instance reliée par la connexion unique, **Admin** affiche son administration dans le Board :
les sections que l'appli propose (vue d'ensemble, comptes, réglages, maintenance…), ses formulaires, ses listes et ses actions.

- C'est l'appli qui décrit ses écrans et qui décide : le Board les affiche et lui transmet vos actions.
  Elle vérifie à chaque fois que votre compte Kosmy Board est relié à un compte **administrateur** de l'appli.
- Le serveur du Board appelle l'appli avec un jeton signé, valable 60 secondes pour une seule requête :
  toujours aucun mot de passe, ni cookie de l'instance, ne passe par le Board.
- **Le serveur du Board doit pouvoir joindre l'instance** à l'adresse saisie dans le Board
  (c'est lui qui l'appelle, pas votre navigateur). Les instances peuvent être sur un autre domaine que le Board.
- Ce que le Board ne sait pas afficher (envoi de fichiers, glisser-déposer, éditeurs riches) reste dans l'appli :
  **Ouvrir l'admin de l'appli ↗** ouvre son admin dans un onglet, comme avant.
- Une appli qui ne propose pas encore l'admin dans le Board : le Board le dit, et propose de l'ouvrir dans un onglet.

Applis Kosmy compatibles : Calendy, ClearDoc, Crafty, Dashy, Kanby, Lumy, Mocky et Soundy (version web), avec la connexion unique réglée.
Dans Soundy, chaque personne relie d’abord son compte Emby dans les Réglages (« Relier à Kosmy Board »).
Pour une autre appli : le [guide de l'admin dans le Board](docs/admin-api.md) décrit le protocole, et l'[appli de démonstration](examples/demo-app/server.js) l'implémente.

## Notifications

Une appli reliée par la connexion unique peut vous envoyer des notifications (Soundy : une nouvelle demande de musique).
Elles arrivent dans la **cloche** de l'en-tête du Board et, avec Kosmy Mobile, sur votre téléphone.

- Seules les personnes qui ont l'instance reliée dans leur Board peuvent en recevoir ; l'appli choisit parmi elles
  (Soundy ne prévient que les comptes reliés à un administrateur de Soundy).
- Le Board garde les 200 dernières de chaque personne. **Tout marquer comme lu** et **Tout supprimer** sur la page Notifications.
- Pour une autre appli : le [guide des notifications](docs/notifications.md).

## Kosmy Mobile

Dans Kosmy Mobile, onglet **Admin** → **Kosmy Board** → **Se connecter** : l'adresse du Board, l'e-mail et le mot de passe
(et le code de double authentification s'il est activé). Le téléphone reste connecté ensuite.

- À la première connexion, les espaces déjà présents sur le téléphone rejoignent le compte (les doublons sont ignorés),
  puis le téléphone reprend la liste du Board.
- Ensuite, ajouter, modifier ou supprimer un espace dans l'appli le fait aussi sur le Board, et l'appli se met à jour
  en revenant au premier plan ou en tirant la liste vers le bas.
- Le téléphone reçoit un jeton d'appareil (aucun cookie), valable `DEVICE_DAYS` jours et prolongé à chaque utilisation.
  Seul son haché est conservé. **Compte → Appareils connectés** liste les téléphones et permet d'en déconnecter un ;
  changer de mot de passe les déconnecte tous.
- Les sessions ouvertes dans les pages d'admin restent propres à chaque appareil : le Board ne les voit jamais.

API utilisée par l'appli : `POST /api/device/login` (`email`, `password`, `device`) renvoie `{ token, user }` ou
`{ twoFactor, ticket }`, puis `POST /api/device/login/2fa` (`ticket`, `code`). Les autres routes `/api` acceptent
ensuite `Authorization: Bearer <token>` ; `POST /api/logout` révoque le jeton.

## Installer avec Docker

Trois dépendances npm, à versions figées : `oidc-provider` (certifié OpenID), `jose` et `qrcode`.
SQLite est le module intégré à Node 24.

```bash
docker build -t kosmy-board .
docker run -d --name kosmy-board -p 8767:8767 -v kosmy-board-data:/data \
  -e PUBLIC_URL=https://board.mondomaine.fr -e TRUST_PROXY=1 kosmy-board
docker logs kosmy-board   # affiche le code de première configuration
```

Ouvrez le Board, saisissez le code affiché dans les journaux, puis créez le compte administrateur.

### Coolify

Le guide pas à pas, avec la sauvegarde et les problèmes courants : **[Installer Kosmy Board sur Coolify](docs/coolify.md)**. En bref :

1. Nouvelle ressource → **Public Repository** `https://github.com/PetitOursManu/Kosmy-Board` → Build Pack **Dockerfile**.
2. **Ports Exposes** : `8767`. **Domains** : `https://board.mondomaine.fr`.
3. Variables : `PUBLIC_URL` (exactement ce domaine), `TRUST_PROXY=1`, et `KOSMY_URL` si besoin.
4. **Persistent Storage** : un volume monté sur `/data` (sinon les comptes disparaissent à chaque déploiement).
5. **Deploy**, puis l'onglet **Logs** donne le code de première configuration.

### Réglages

| Variable | Par défaut | Rôle |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:8767` | Adresse publique du Board (liens d'invitation, cookies sécurisés en https). L'émetteur OpenID Connect est `{PUBLIC_URL}/oidc` : ne plus la changer une fois des applis reliées. |
| `KOSMY_URL` | `http://localhost:8766` | Lien « ← Kosmy » de l'en-tête. |
| `TRUST_PROXY` | non | `1` derrière un reverse proxy (Coolify, Traefik, Caddy, Nginx). Indispensable pour la connexion unique : sans lui, les adresses OpenID annoncées seraient en http. |
| `DATA_DIR` | `./data` (`/data` dans l'image) | Dossier de la base SQLite. |
| `PORT` | `8767` | Port d'écoute. |
| `SESSION_DAYS` | `30` | Durée d'une session du Board. |
| `DEVICE_DAYS` | `365` | Durée de la connexion de Kosmy Mobile, prolongée à chaque utilisation. |
| `CATALOG_URL` | catalogue de Kosmy Mobile sur GitHub | Catalogue des applis (une copie de secours est embarquée). |

Voir aussi [`.env.example`](.env.example).

## Développement

```bash
npm install
npm run dev                          # http://localhost:8767, rechargé à chaque modification du serveur
node examples/demo-app/server.js     # appli de démonstration sur http://localhost:8768
npm test                             # API, connexion unique de bout en bout, double authentification
```

Pour essayer la connexion unique en local : ajoutez l'espace `http://localhost:8768` (page `/admin`) dans le Board,
activez sa connexion unique avec l'adresse de retour `http://localhost:8768/auth/kosmy-board/callback`
et l'adresse de lancement `http://localhost:8768/auth/kosmy-board/login`, puis collez les réglages
dans `http://localhost:8768/settings`. Connectez-vous une fois à la démo par le Board (le premier compte relié
y est administrateur) : **Admin** affiche alors son administration dans le Board.

- `server/` : serveur HTTP (`node:http`, `node:sqlite`, `node:crypto`) ; `server/oidc.js` pour la connexion unique,
  `server/admin.js` pour l'admin dans le Board.
- `public/` : l'interface, en HTML, CSS et JavaScript (modules ES), sans étape de build.
- `public/js/normalize.js` est partagé par l'interface et le serveur.
- `public/js/catalog-fallback.json` et `public/assets/logos/` : copie de secours du catalogue de Kosmy Mobile.

## Sécurité

- Mots de passe du Board hachés avec scrypt ; jetons de session et d'invitation stockés hachés.
- Cookies `HttpOnly`, `SameSite=Lax`, `Secure` en https ; requêtes d'un autre site refusées (`Origin`, `Sec-Fetch-Site`).
- Kosmy Mobile : jeton d'appareil dans `Authorization` (stocké haché), jamais dans un cookie ; une requête qui porte cet en-tête
  ignore les cookies, et un jeton d'appareil ne vaut pas cookie (ni l'inverse).
- Connexion bloquée 15 minutes après 5 échecs sur un compte (30 par adresse IP).
- Double authentification TOTP (RFC 6238) ; codes de secours à usage unique, stockés hachés ; un code accepté ne repasse pas.
- Connexion unique : code d'autorisation, PKCE, ID token signé RS256 ; clés et secrets des cookies créés au premier
  lancement et gardés dans la base. Les secrets des clients sont montrés une seule fois.
- Admin dans le Board : jeton JWT RS256 (`typ: kb-admin+jwt`, distinct des ID tokens) lié à la méthode et à l'adresse
  appelées, 60 secondes, usage unique ; seulement pour un espace relié de la personne. L'appli revérifie les droits.
  Les réponses de l'appli sont réduites à un format strict et affichées en texte brut ; redirections non suivies, 2 Mo et 15 s au plus.
- CSP stricte, pas d'iframe, pas de script tiers, `Referrer-Policy: no-referrer`.

Sauvegardez le dossier `/data` : il contient les comptes, les espaces et les clés de signature OpenID Connect.

## Format d'export

```json
{
  "format": "kosmy.admin.v1",
  "exportedAt": "2026-11-17T18:00:00.000Z",
  "spaces": [
    { "id": "mwl3u1mw2f2a9", "appId": "kanby", "name": "Kanby", "base": "https://kanby.mondomaine.fr", "path": "/admin", "addedAt": 1794944875208 }
  ]
}
```

L'import accepte ce fichier, ou directement un tableau d'espaces (`AdminSpace` de Kosmy Mobile). Les doublons (même adresse) sont ignorés.

## Licence

MIT
