# Les utilisateurs gérés par le Board : guide d'intégration

Depuis le Board, un administrateur crée les comptes des personnes, choisit **à quelles instances** chacune a accès
et, pour chaque instance, **son rôle et ses restrictions** dans l'appli. Le Board crée alors (ou met à jour, ou désactive)
le compte de la personne dans l'appli : plus besoin d'ouvrir chaque appli pour gérer ses utilisateurs.

C'est l'appli qui décrit **ses** rôles et **ses** restrictions (quota, droits particuliers…) ; le Board les affiche,
retient le choix de l'administrateur et le transmet. L'appli reste seule juge : elle vérifie que la personne qui agit
est un administrateur de l'appli, et elle applique les valeurs avec ses propres règles.

Protocole : **`kosmy.board-users.v1`**. Il s'ajoute à l'[admin dans le Board](admin-api.md) (`kosmy.board-admin.v1`),
dont il reprend le jeton. L'implémentation de référence est [`examples/demo-app/server.js`](../examples/demo-app/server.js).

## Prérequis

- La [connexion unique](integration.md) est réglée dans l'appli : un compte géré par le Board se connecte **par le Board**.
- La vérification du jeton du Board de l'[admin dans le Board](admin-api.md#authentification--le-jeton-du-board) est en place :
  elle est reprise telle quelle.

## Points d'accès de l'appli

Sous l'adresse de l'instance saisie dans le Board (sans « / » final) :

| Méthode | Adresse | Rôle |
| --- | --- | --- |
| `GET` | `/api/kosmy-board/users` | Ce que l'appli propose (rôles, restrictions) et les comptes reliés au Board. |
| `PUT` | `/api/kosmy-board/users/{sub}` | Créer ou mettre à jour le compte de la personne `{sub}`, avec son rôle et ses restrictions. |
| `DELETE` | `/api/kosmy-board/users/{sub}` | Retirer l'accès : **désactiver** le compte de la personne `{sub}` (ses données restent). |

`{sub}` est l'identifiant du compte Board de la personne gérée (un UUID, `[A-Za-z0-9-]{1,64}`), le même `sub` que
dans l'ID token. Réponses en `application/json; charset=utf-8`, `Cache-Control: no-store`. Pas de CORS, pas de redirection.
La langue arrive dans `Accept-Language` (`fr` ou `en`), comme pour l'admin.

## Authentification

Exactement celle de l'[admin dans le Board](admin-api.md#authentification--le-jeton-du-board) : `Authorization: Bearer <jeton>`,
un JWT `typ: kb-admin+jwt` signé par le Board, valable 60 secondes pour **une seule** requête, avec `htm` (la méthode :
`GET`, `PUT` ou `DELETE`) et `htu` (l'adresse appelée, dont le chemin se termine par `/api/kosmy-board/users` ou
`/api/kosmy-board/users/{sub}`).

Le `sub` **du jeton** est la personne qui agit (un administrateur du Board), **pas** la personne gérée (celle de l'adresse).
L'appli vérifie, comme pour l'admin, que ce `sub` est relié à un compte **administrateur de l'appli** : sinon `403`
(`not_linked` ou `forbidden`). Le Board ne donne aucun droit : il dit seulement qui agit, et pour qui.

Erreurs : le même format `{ "error": "<code>", "message": "<texte lisible>" }` et les mêmes statuts que l'admin.
Un `404` sur `GET /api/kosmy-board/users` (ou une réponse sans `protocol`) veut dire « l'appli ne propose pas la gestion
des utilisateurs par le Board » : le Board le dit, et l'accès se donne alors sans compte créé dans l'appli.

## Ce que l'appli propose : `GET /api/kosmy-board/users`

```json
{
  "protocol": "kosmy.board-users.v1",
  "roles": [
    { "value": "admin", "label": "Administrateur", "description": "Gère l'instance.", "admin": true },
    { "value": "member", "label": "Membre", "description": "Utilise l'appli." }
  ],
  "defaultRole": "member",
  "fields": [
    { "name": "maxBoards", "label": "Tableaux au plus", "type": "number", "value": 10, "min": 0, "max": 1000,
      "help": "0 : aucun tableau." },
    { "name": "canInvite", "label": "Peut inviter des personnes", "type": "checkbox", "value": false }
  ],
  "users": [
    { "sub": "5b6e…", "role": "member", "values": { "maxBoards": 10, "canInvite": false }, "active": true, "account": "alice" }
  ]
}
```

- `protocol` : obligatoire.
- `roles` : 1 à 10 rôles, dans l'ordre d'affichage. `value` `[a-z0-9_-]{1,40}`, `label` 60 caractères, `description` 200.
  `admin: true` : ce rôle donne les droits d'administration de l'appli (le Board montre alors le bouton « Admin » à la personne).
- `defaultRole` : le rôle proposé d'office (sinon le dernier de la liste).
- `fields` : **les restrictions propres à l'appli**, 0 à 30 champs, au format des [champs de l'admin](admin-api.md#les-champs)
  (`text`, `textarea`, `email`, `url`, `number`, `select`, `checkbox` ; **jamais** `password`). `value` est la valeur par défaut.
  Un champ peut avoir `roles: ["member"]` : il ne concerne alors que ces rôles (le Board ne l'affiche, et ne l'envoie, que pour eux).
- `users` : les comptes de l'appli **reliés à un compte du Board** (500 au plus) : `sub`, `role` (une `value` de `roles`,
  ou `null` si le compte n'a aucun de ces rôles), `values`, `active` (le compte peut se connecter), `account` (facultatif :
  l'identifiant du compte dans l'appli, pour l'affichage). Le Board s'en sert pour montrer l'état réel de chaque accès.

## Créer ou mettre à jour : `PUT /api/kosmy-board/users/{sub}`

```json
{
  "name": "Alice Martin",
  "email": "alice@exemple.fr",
  "locale": "fr",
  "role": "member",
  "values": { "maxBoards": 10, "canInvite": false }
}
```

L'appli, dans l'ordre :

1. **Vérifie** le jeton et les droits de la personne qui agit (voir plus haut), puis les valeurs : `role` doit être une `value`
   de ses rôles, chaque `values` doit respecter son champ (un champ absent garde sa valeur actuelle, ou prend sa valeur par défaut).
   Une valeur refusée : `422` avec un `message`.
2. **Retrouve le compte** relié à `{sub}` (le même lien que la connexion unique).
3. Aucun compte relié : elle **en crée un**, relié à `{sub}`, **sans mot de passe** (on s'y connecte par le Board), avec
   `name`, `email` et `locale`. Si un compte **non relié** porte déjà cette adresse e-mail, elle peut le **relier** à `{sub}`
   au lieu d'en créer un autre (la personne qui agit est un administrateur de l'appli : elle pourrait déjà tout faire de ce compte).
   Si cette adresse appartient à un compte **déjà relié à un autre `sub`** : `409` avec un `message`.
4. **Applique** le rôle et les restrictions, met à jour le nom et l'e-mail affichés, et **réactive** le compte s'il était désactivé.

Réponse `200` :

```json
{ "ok": true, "status": "created", "account": "alice", "message": "Compte créé." }
```

- `status` : `created` (nouveau compte), `linked` (compte existant relié par son e-mail), `updated` (compte déjà relié).
- `account` (facultatif) : l'identifiant du compte dans l'appli. `message` (facultatif) : montré à l'administrateur.

Le Board envoie un `PUT` quand l'administrateur donne l'accès, change le rôle ou les restrictions, quand le nom ou l'e-mail
de la personne change dans le Board, et sur « Resynchroniser ». Il doit donc être **idempotent** : le même `PUT` deux fois
laisse le compte dans le même état.

## Retirer l'accès : `DELETE /api/kosmy-board/users/{sub}`

L'appli **désactive** le compte relié à `{sub}` : il ne peut plus se connecter (ni par le Board, ni autrement), ses sessions
ouvertes sont fermées, ses données restent. Un `PUT` plus tard le réactive. Réponse `200` `{ "ok": true }`.
Aucun compte relié à `{sub}` : `200` `{ "ok": true }` aussi (il n'y a rien à retirer).

## Ne pas se couper l'accès

Comme pour l'admin, l'appli refuse (`409`, avec un `message`) :

- un `PUT` où `{sub}` est la personne qui agit **et** qui lui retirerait les droits d'administration ;
- un `DELETE` où `{sub}` est la personne qui agit ;
- tout ce qui laisserait l'appli **sans aucun administrateur**.

## À la connexion : la revendication `kosmy_board_access`

Quand l'accès d'une personne est géré par le Board, l'ID token (et `userinfo`) remis à l'appli contient aussi :

```json
"kosmy_board_access": { "role": "member", "values": { "maxBoards": 10, "canInvite": false } }
```

C'est le même contenu que le dernier `PUT`. À la connexion par le Board, l'appli qui la reçoit applique ces valeurs
(comme un `PUT`), et **crée le compte** s'il n'existe pas encore : la personne a reçu l'accès d'un administrateur du Board,
même si l'appli n'était pas joignable à ce moment-là. Sans cette revendication, rien ne change (création automatique
selon le réglage de l'appli, voir l'[intégration](integration.md#relier-les-comptes--par-sub-jamais-par-le-mail)).

Le Board ne laisse se connecter à une instance que les personnes qui y ont accès : un compte désactivé par le Board ne peut
de toute façon plus y entrer par la connexion unique.

## Limites

Le Board coupe ou écarte ce qui dépasse : 10 rôles, 30 champs, 500 comptes reliés ; mêmes limites de textes et de champs
que l'admin. Réponse 2 Mo au plus ; 15 secondes pour un `GET`, 30 secondes pour un `PUT` ou un `DELETE`.

## Sécurité, en résumé

- Le jeton : signature, `typ`, `iss`, `aud`, `exp`, `htm`, `htu`, `jti` à usage unique. Puis le `sub` du jeton → compte relié → droits d'admin.
- Le `sub` de l'adresse n'est que la personne gérée : il ne donne aucun droit.
- Un compte créé par le Board n'a pas de mot de passe ; les droits d'administration ne viennent que d'un rôle `admin` choisi par un administrateur.
- Lier un compte existant par son e-mail n'est permis **que** dans un `PUT` (fait par un administrateur de l'appli), jamais à la connexion.
- Ne jamais renvoyer de secret dans `GET /api/kosmy-board/users`.
