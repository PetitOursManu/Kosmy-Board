# Kosmy Board

Les panneaux d'administration de vos instances auto-hébergées (Kanby, Crafty, Lumy, Dashy…), au même endroit.
C'est l'équivalent web de l'onglet « Admin » de [Kosmy Mobile](https://github.com/PetitOursManu/Kosmy-Mobile),
avec la même identité visuelle que le site Kosmy.

- **Comptes** : chaque personne a son compte et sa propre liste d'espaces, retrouvée sur tous ses appareils.
  Le premier compte (administrateur) est créé au premier lancement ; les suivants arrivent par lien d'invitation.
- **Espaces** : une appli du catalogue Kosmy (le chemin de sa page d'admin est pré-rempli) ou n'importe quelle autre appli web.
- **Statut** : « joignable » ou « injoignable », vérifié depuis votre navigateur. C'est une indication, pas un contrôle d'accès.
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

> Prochaine étape : la connexion unique. Le Board deviendra fournisseur d'identité OpenID Connect,
> et chaque appli pourra proposer « Se connecter avec Kosmy Board ». Il suffira alors d'être connecté au Board.

## Installer avec Docker

Aucune dépendance npm : Node 24 et son module SQLite intégré suffisent.

```bash
docker build -t kosmy-board .
docker run -d --name kosmy-board -p 8767:8767 -v kosmy-board-data:/data \
  -e PUBLIC_URL=https://board.mondomaine.fr -e TRUST_PROXY=1 kosmy-board
docker logs kosmy-board   # affiche le code de première configuration
```

Ouvrez le Board, saisissez le code affiché dans les journaux, puis créez le compte administrateur.

### Coolify

1. Nouvelle ressource → dépôt GitHub `PetitOursManu/Kosmy-Board` → type de build **Dockerfile**.
2. Port exposé : `8767`. Domaine : celui du Board (en https).
3. Variables : `PUBLIC_URL` (l'adresse du Board), `TRUST_PROXY=1`, et `KOSMY_URL` si besoin.
4. Stockage persistant : un volume monté sur `/data` (sinon les comptes disparaissent à chaque déploiement).
5. Déployez, puis ouvrez l'onglet **Logs** pour lire le code de première configuration.

### Réglages

| Variable | Par défaut | Rôle |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:8767` | Adresse publique du Board (liens d'invitation, cookies sécurisés en https). |
| `KOSMY_URL` | `http://localhost:8766` | Lien « ← Kosmy » de l'en-tête. |
| `TRUST_PROXY` | non | `1` derrière un reverse proxy (Coolify, Traefik, Caddy, Nginx). |
| `DATA_DIR` | `./data` (`/data` dans l'image) | Dossier de la base SQLite. |
| `PORT` | `8767` | Port d'écoute. |
| `SESSION_DAYS` | `30` | Durée d'une session du Board. |
| `CATALOG_URL` | catalogue de Kosmy Mobile sur GitHub | Catalogue des applis (une copie de secours est embarquée). |

Voir aussi [`.env.example`](.env.example).

## Développement

```bash
npm run dev    # http://localhost:8767, rechargé à chaque modification du serveur
npm test       # tests de l'API et du nettoyage des adresses
```

- `server/` : serveur HTTP sans dépendance (`node:http`, `node:sqlite`, `node:crypto`).
- `public/` : l'interface, en HTML, CSS et JavaScript (modules ES), sans étape de build.
- `public/js/normalize.js` est partagé par l'interface et le serveur.
- `public/js/catalog-fallback.json` et `public/assets/logos/` : copie de secours du catalogue de Kosmy Mobile.

## Sécurité

- Mots de passe du Board hachés avec scrypt ; jetons de session et d'invitation stockés hachés.
- Cookies `HttpOnly`, `SameSite=Lax`, `Secure` en https ; requêtes d'un autre site refusées (`Origin`, `Sec-Fetch-Site`).
- Connexion bloquée 15 minutes après 5 échecs sur un compte (30 par adresse IP).
- CSP stricte, pas d'iframe, pas de script tiers, `Referrer-Policy: no-referrer`.

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
