# L'admin dans le Board : guide d'intégration

Une instance reliée au Board par la [connexion unique](integration.md) peut aussi s'administrer **depuis le Board**,
sans ouvrir l'appli : le bouton « Admin » affiche ses écrans d'administration dans le Board lui-même.

Le Board ne connaît pas les fonctions de chaque appli. C'est l'appli qui les **décrit** (sections, chiffres,
formulaires, tableaux, boutons) dans une petite API JSON ; le Board les affiche et renvoie les actions de la
personne à l'appli, qui les exécute avec ses propres règles. L'appli reste seule juge de qui peut faire quoi.

Protocole : **`kosmy.board-admin.v1`**. L'implémentation de référence est
[`examples/demo-app/server.js`](../examples/demo-app/server.js).

## Prérequis

- La connexion unique est réglée dans l'appli (émetteur, identifiant client) : l'admin dans le Board réutilise
  la vérification des jetons et le lien entre comptes (par `sub`) de la connexion unique.
- Le **serveur** du Board doit pouvoir joindre l'instance à l'adresse saisie dans le Board (c'est lui qui appelle
  l'appli, pas le navigateur). Sur un même serveur Coolify, l'adresse publique de l'instance convient.

## Points d'accès de l'appli

Tous sous l'adresse de l'instance saisie dans le Board (sans « / » final), par exemple `https://kanby.mondomaine.fr` :

| Méthode | Adresse | Rôle |
| --- | --- | --- |
| `GET` | `/api/kosmy-board/admin` | Le sommaire : l'appli et la liste de ses sections. |
| `GET` | `/api/kosmy-board/admin/{section}` | Le contenu d'une section. |
| `POST` | `/api/kosmy-board/admin/{section}` | Une action dans cette section (enregistrer un formulaire, supprimer une ligne…). |

`{section}` : `[a-z0-9-]{1,40}`. Réponses en `application/json; charset=utf-8`, avec `Cache-Control: no-store`.
Pas de CORS : seul le serveur du Board appelle ces adresses. Pas de redirection (le Board ne les suit pas).

La langue de la personne arrive dans `Accept-Language` (`fr` ou `en`) : tous les textes renvoyés sont dans cette langue.

## Authentification : le jeton du Board

Chaque requête porte `Authorization: Bearer <jeton>`. Le jeton est un JWT signé par le Board avec la **même clé
que ses ID tokens** (RS256, `jwks_uri` de la découverte OpenID Connect), valable 60 secondes, pour **une seule** requête.

En-tête : `{ "alg": "RS256", "kid": "…", "typ": "kb-admin+jwt" }`

| Revendication | Contenu |
| --- | --- |
| `iss` | L'émetteur du Board (celui réglé dans l'appli). |
| `aud` | L'identifiant client de l'instance. |
| `sub` | L'identifiant du compte Board de la personne (le même `sub` que dans l'ID token). |
| `iat`, `exp` | Émis à…, expire 60 secondes plus tard. |
| `jti` | Identifiant unique du jeton. |
| `htm` | La méthode HTTP de la requête (`GET` ou `POST`). |
| `htu` | L'adresse complète appelée, sans paramètres. |
| `name`, `email` | Pour l'affichage et le journal seulement : **jamais** pour retrouver un compte. |

L'appli vérifie, dans l'ordre :

1. **Signature** avec les clés de `jwks_uri` (déjà mises en cache pour la connexion unique), algorithme `RS256` seulement.
2. `typ` = `kb-admin+jwt` dans l'en-tête : un ID token (ou un autre JWT du Board) ne doit **jamais** être accepté ici.
3. `iss` = l'émetteur réglé, `aud` = l'identifiant client réglé, `exp` non dépassé (30 secondes de tolérance d'horloge).
4. `htm` = la méthode de la requête, et le chemin de `htu` se termine par le chemin demandé
   (`/api/kosmy-board/admin` ou `/api/kosmy-board/admin/{section}`). Un jeton ne sert donc qu'à la requête pour laquelle il a été fait.
5. `jti` jamais vu (garder les `jti` reçus en mémoire jusqu'à leur expiration) : un jeton ne sert qu'une fois.
6. `sub` relié à un compte de l'appli (le même lien que pour la connexion unique), et ce compte a les **droits
   d'administration dans l'appli**. Le Board ne donne aucun droit : il dit seulement qui est la personne.

Avec [jose](https://github.com/panva/jose) :

```js
const { payload } = await jwtVerify(token, jwks, {
  issuer: settings.issuer,
  audience: settings.clientId,
  typ: "kb-admin+jwt",
  algorithms: ["RS256"],
  clockTolerance: 30,
  maxTokenAge: "2 minutes",
});
if (payload.htm !== req.method) throw new Error("htm");
if (!new URL(payload.htu).pathname.endsWith(pathDemandé)) throw new Error("htu");
```

### Erreurs

Toujours en JSON : `{ "error": "<code>", "message": "<texte lisible, facultatif>" }`. Le Board affiche `message` tel quel (texte brut).

| Statut | `error` | Quand |
| --- | --- | --- |
| `401` | `invalid_token` | Jeton absent, mal signé, expiré, déjà utilisé, mauvais `typ`/`iss`/`aud`/`htm`/`htu`, ou connexion unique non réglée. |
| `403` | `not_linked` | Le `sub` n'est relié à aucun compte de l'appli. |
| `403` | `forbidden` | Le compte relié n'a pas les droits d'administration. |
| `404` | `not_found` | Section, ligne ou action inconnue. |
| `400`, `409`, `422` | au choix | Saisie refusée, conflit… avec un `message` à montrer. |

## Le sommaire : `GET /api/kosmy-board/admin`

```json
{
  "protocol": "kosmy.board-admin.v1",
  "app": { "name": "Kanby", "version": "1.4.0" },
  "user": { "name": "Emanuel", "role": "Administrateur" },
  "sections": [
    { "id": "overview", "title": "Vue d'ensemble" },
    { "id": "users", "title": "Utilisateurs" },
    { "id": "settings", "title": "Réglages" }
  ]
}
```

- `protocol` est obligatoire : sans lui, le Board considère que l'appli ne propose pas l'admin dans le Board.
- `user` (facultatif) : le compte de l'appli tel que l'appli le voit, affiché en haut de l'admin.
- 1 à 20 sections. La première est affichée à l'ouverture.

## Une section : `GET /api/kosmy-board/admin/{section}`

```json
{
  "id": "users",
  "title": "Utilisateurs",
  "description": "Les comptes de cette instance.",
  "blocks": [ … ]
}
```

Une section est une suite de **blocs** (30 au plus), affichés dans l'ordre. Six types :

### `notice` : un message

```json
{ "type": "notice", "tone": "warning", "title": "Sauvegarde", "text": "Aucune sauvegarde depuis 12 jours." }
```

`tone` : `info` (par défaut), `success`, `warning` ou `danger`.

### `stats` : des chiffres

```json
{ "type": "stats", "title": "En bref", "items": [
  { "label": "Utilisateurs", "value": 12 },
  { "label": "Espace disque", "value": "1,2 Go", "hint": "sur 20 Go" }
] }
```

### `fields` : des informations en lecture seule

```json
{ "type": "fields", "title": "Instance", "items": [
  { "label": "Version", "value": "1.4.0" },
  { "label": "Base de données", "value": "PostgreSQL 16" }
] }
```

### `form` : un formulaire

```json
{ "type": "form", "id": "general", "title": "Général", "description": "…",
  "action": "save-general", "submit": "Enregistrer",
  "fields": [
    { "name": "siteName", "label": "Nom du site", "type": "text", "value": "Mon Kanby", "required": true, "maxLength": 80 },
    { "name": "signup", "label": "Inscriptions ouvertes", "type": "checkbox", "value": false, "help": "…" },
    { "name": "lang", "label": "Langue par défaut", "type": "select", "value": "fr",
      "options": [{ "value": "fr", "label": "Français" }, { "value": "en", "label": "English" }] },
    { "name": "smtpPassword", "label": "Mot de passe SMTP", "type": "password", "placeholder": "Inchangé" }
  ] }
```

Envoie `{ "action": "save-general", "values": { … } }` (voir plus bas).

### `table` : une liste, avec des actions par ligne

```json
{ "type": "table", "id": "users", "title": "Comptes",
  "columns": [ { "key": "name", "label": "Nom" }, { "key": "role", "label": "Rôle" }, { "key": "last", "label": "Dernière connexion" } ],
  "rows": [
    { "id": "u_42", "cells": { "name": "Alice", "role": { "text": "Admin", "tone": "success" }, "last": "il y a 2 jours" },
      "actions": ["make-member", "delete"] }
  ],
  "rowActions": [
    { "id": "make-admin", "label": "Rendre admin" },
    { "id": "make-member", "label": "Retirer les droits admin" },
    { "id": "delete", "label": "Supprimer", "danger": true, "confirm": "Supprimer ce compte et ses données ?" }
  ],
  "actions": [
    { "id": "invite", "label": "Inviter", "fields": [ { "name": "email", "label": "E-mail", "type": "email", "required": true } ] }
  ],
  "empty": "Aucun compte."
}
```

- `rowActions` décrit les actions possibles ; chaque ligne liste dans `actions` celles qui la concernent
  (sans `actions`, une ligne n'en a aucune). `actions` (au niveau du tableau) : boutons au-dessus de la liste.
- 500 lignes et 12 colonnes au plus. Au-delà de 10 lignes, le Board ajoute une recherche.
- Une cellule est un texte, un nombre, un booléen, `null`, ou `{ "text", "tone", "href" }` :
  `tone` affiche une pastille (`success`, `warning`, `danger`, `muted`), et `href`, une adresse **de l'instance
  elle-même** (même origine), un lien qui s'ouvre dans un nouvel onglet.

### `actions` : des boutons

```json
{ "type": "actions", "title": "Maintenance", "items": [
  { "id": "clear-cache", "label": "Vider le cache", "description": "Les aperçus seront recalculés." },
  { "id": "reset-demo", "label": "Réinitialiser", "danger": true, "confirm": "Toutes les données seront effacées." }
] }
```

### Les actions

Une action (`rowActions`, `actions`, ou bloc `actions`) :

| Champ | Rôle |
| --- | --- |
| `id` | Identifiant, renvoyé à l'appli (`[A-Za-z0-9_.:-]{1,64}`). |
| `label` | Texte du bouton. |
| `description` | Facultatif, sous le bouton (bloc `actions`). |
| `danger` | Bouton rouge. |
| `confirm` | Le Board demande confirmation avec ce texte avant d'envoyer. |
| `fields` | Le Board ouvre un petit formulaire (mêmes champs que `form`) avant d'envoyer. |

### Les champs

`name`, `label`, `type` et, selon le type, `value`, `required`, `placeholder`, `help`, `readOnly`,
`min`/`max`/`step` (`number`), `maxLength` (textes), `options` (`select`, 200 au plus).

Types : `text`, `textarea`, `email`, `url`, `number`, `password`, `select`, `checkbox`.
Un champ `password` n'a jamais de `value` : vide à l'envoi, il veut dire « ne pas changer ».

## Une action : `POST /api/kosmy-board/admin/{section}`

```json
{ "action": "delete", "row": "u_42", "values": { … } }
```

- `action` : l'`id` de l'action, ou l'`action` du formulaire.
- `row` : l'`id` de la ligne, pour une action de ligne.
- `values` : les valeurs du formulaire (texte, nombre, ou booléen pour `checkbox`). Absent s'il n'y a pas de champs.

**L'appli revérifie tout** : droits, existence de la ligne, valeurs (le Board ne fait que transmettre). Réponse :

```json
{ "ok": true, "message": "Compte supprimé.", "section": { … }, "reveal": { "label": "Lien d'invitation", "value": "https://…" } }
```

- `message` (facultatif) : affiché brièvement.
- `section` (facultatif, conseillé) : la section à jour, affichée aussitôt. Sans elle, le Board la redemande.
- `reveal` (facultatif) : une valeur à montrer une seule fois avec un bouton « Copier » (mot de passe temporaire,
  lien d'invitation…). Le Board ne la garde pas.

## Sécurité, en résumé

- Le jeton : signature, `typ`, `iss`, `aud`, `exp`, `htm`, `htu`, `jti` à usage unique. Puis `sub` → compte relié → droits d'admin.
- Le Board n'est qu'un intermédiaire : chaque action est revérifiée par l'appli comme si elle venait de son propre admin,
  et passe par le même code (mêmes règles, même journal).
- Ne jamais renvoyer de secret existant (mot de passe, clé d'API, secret client) dans une section : seulement un `reveal`
  au moment où il est créé.
- Le Board affiche tout en texte brut : pas de HTML dans les textes.
- Le Board ne suit pas les redirections et limite les réponses à 2 Mo et 15 secondes.
