# Se connecter avec Kosmy Board : guide d'intégration

Ce guide décrit comment une appli auto-hébergée (Kanby, Crafty, Lumy, Dashy… ou n'importe quelle autre)
accepte la connexion par Kosmy Board. Kosmy Board est un fournisseur d'identité **OpenID Connect** standard :
toute bibliothèque OpenID Connect sérieuse fait l'affaire, et une appli qui sait déjà se connecter avec un
fournisseur « générique » (Authentik, Keycloak…) n'a besoin d'aucun code en plus.

L'implémentation de référence est [`examples/demo-app/server.js`](../examples/demo-app/server.js) : un seul fichier, sans framework.

## Ce que l'administrateur de l'appli fait

1. Dans le Board, il ajoute l'instance, puis ouvre **Modifier → Connexion unique** et active la connexion unique.
2. Le Board affiche les réglages à coller dans l'appli : **émetteur**, **identifiant client**, **secret client**
   (montré une seule fois). Pour une appli du catalogue Kosmy, l'adresse de retour et l'adresse de lancement
   sont déjà remplies selon la convention ci-dessous.
3. Il colle ces trois valeurs dans la page d'administration de l'appli. C'est tout.

Ensuite, chaque personne qui a l'instance dans son Board peut s'y connecter : le bouton « Ouvrir » du Board
la connecte directement, sans mot de passe propre à l'appli.

## Convention des applis Kosmy

| Rôle | Adresse |
| --- | --- |
| Lancement (*initiate login URI*) | `{adresse de l'instance}/auth/kosmy-board/login` |
| Retour (*redirect URI*) | `{adresse de l'instance}/auth/kosmy-board/callback` |

L'« adresse de l'instance » est celle saisie dans le Board, sans « / » final (par exemple `https://kanby.mondomaine.fr`).

## Réglages à proposer dans l'appli

- **Émetteur** (*issuer*), par exemple `https://board.mondomaine.fr/oidc`.
  La découverte est à `{émetteur}/.well-known/openid-configuration`.
- **Identifiant client** et **secret client**.
- Facultatif : « Connexion par Kosmy Board seulement » (masquer le formulaire de mot de passe),
  et la création automatique d'un compte à la première connexion (désactivée par défaut, voir plus bas).

Ne jamais afficher le secret une fois enregistré ; permettre de le remplacer.

## Le parcours

### 1. Lancement : `GET /auth/kosmy-board/login`

Appelé par le bouton « Se connecter avec Kosmy Board » de la page de connexion de l'appli, ou directement par
le Board (« Ouvrir » : *connexion initiée par un tiers*, OpenID Connect Core § 4) avec deux paramètres :

- `iss` : l'émetteur. **Refuser** s'il diffère de l'émetteur réglé dans l'appli.
- `target_link_uri` : la page où arriver ensuite (la page d'admin). **N'accepter qu'une adresse de l'appli elle-même**
  (même origine), sinon aller à la page d'accueil de l'admin : c'est une redirection ouverte sinon.

L'appli prépare alors une demande d'autorisation :

- `state` (aléatoire, au moins 128 bits), `nonce` (idem), et **PKCE** : `code_verifier` aléatoire,
  `code_challenge = BASE64URL(SHA-256(code_verifier))`, `code_challenge_method=S256`.
- Les garder côté serveur (session ou cookie signé, `HttpOnly`, quelques minutes), avec la page cible.
- Rediriger vers `authorization_endpoint` avec :
  `response_type=code`, `client_id`, `redirect_uri` (exactement celle réglée dans le Board),
  `scope=openid profile email`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`.

### 2. Le Board

- Si la personne n'est pas connectée au Board, elle s'y connecte (avec sa double authentification si elle l'a activée),
  puis revient automatiquement.
- Le Board vérifie qu'elle a, dans son Board, un espace relié à ce client. Sinon : page « Accès refusé »,
  puis retour à l'appli avec `error=access_denied`.
- Il n'y a pas d'écran de consentement : relier l'espace vaut accord.

### 3. Retour : `GET /auth/kosmy-board/callback`

- Vérifier `state` (et le consommer : une seule fois). Si `error` est présent, afficher un message et s'arrêter.
- Si `iss` est présent (le Board l'envoie toujours, RFC 9207), vérifier qu'il égale l'émetteur.
- Échanger le code sur `token_endpoint` (POST `application/x-www-form-urlencoded`) :
  `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`, avec l'authentification du client
  **`client_secret_basic`** (en-tête `Authorization: Basic …`, identifiant et secret encodés en URL puis en base64)
  — ou `client_secret_post` si c'est ce qui a été choisi dans le Board.
- Vérifier l'**ID token** (JWT signé **RS256**, clés sur `jwks_uri`) : signature, `iss`, `aud` = identifiant client,
  `exp`, et `nonce`.
- Ouvrir la session de l'appli comme pour une connexion par mot de passe, puis rediriger vers la page cible.

Le code d'autorisation est valable 60 secondes et ne sert qu'une fois.

## Identité reçue

| Revendication | Contenu |
| --- | --- |
| `sub` | Identifiant stable et unique du compte Kosmy Board (UUID). |
| `name` | Nom affiché. |
| `preferred_username` | E-mail du compte Board. |
| `email` | E-mail du compte Board. |
| `email_verified` | Toujours `false` : le Board ne vérifie pas les adresses e-mail. |
| `locale` | `fr` ou `en`, si la personne l'a choisi. |

Ces informations sont dans l'ID token et sur `userinfo_endpoint`.

### Relier les comptes : par `sub`, jamais par l'e-mail

L'e-mail n'est pas vérifié : s'en servir pour retrouver un compte existant permettrait à quelqu'un de prendre
le compte d'un autre. Deux façons sûres de relier un compte de l'appli à un compte du Board :

1. **Relier depuis l'appli** (recommandé) : connecté avec son mot de passe, l'utilisateur clique sur
   « Relier à Kosmy Board » dans ses réglages ; l'appli lance le parcours ci-dessus et enregistre le `sub` reçu sur son compte.
   Ensuite, une connexion par le Board avec ce `sub` ouvre ce compte.
2. **Création automatique** (option, désactivée par défaut) : un `sub` inconnu crée un nouveau compte.
   À réserver aux applis où tout le monde peut avoir un compte ; les droits d'administration ne s'attribuent jamais automatiquement.

Un `sub` inconnu, sans création automatique : message « Ce compte Kosmy Board n'est relié à aucun compte de l'appli »,
avec un lien vers la connexion par mot de passe.

## Déconnexion

- Se déconnecter de l'appli ferme la session de l'appli seulement : la session du Board reste ouverte,
  et « Ouvrir » reconnecte d'un clic. C'est le comportement attendu.
- Facultatif : déconnexion initiée par l'appli (*RP-initiated logout*) vers `end_session_endpoint`, avec
  `post_logout_redirect_uri` égale à l'adresse de l'instance. Elle met fin à la connexion par le Board pour
  cette appli, sans fermer la session du Board.

## Sécurité, en résumé

- Toujours `state`, `nonce` et PKCE (S256), même avec un secret.
- Vérifier `iss` au lancement et au retour, et l'ID token entièrement (signature, `iss`, `aud`, `exp`, `nonce`).
- `target_link_uri` : même origine que l'appli uniquement.
- Le secret client ne quitte jamais le serveur de l'appli, et ne s'affiche jamais après enregistrement.
- En production, tout en https. Le Board n'accepte des adresses `http://` que sur le réseau local.

## Points d'accès du Board

Tous découverts automatiquement par `{émetteur}/.well-known/openid-configuration` :
`authorization_endpoint`, `token_endpoint`, `userinfo_endpoint`, `jwks_uri`, `end_session_endpoint`, `revocation_endpoint`.
Le Board redirige aussi `/.well-known/openid-configuration` (à la racine du domaine) vers la découverte.
