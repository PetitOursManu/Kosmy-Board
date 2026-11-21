# Notifications : guide d'intégration

Une appli reliée au Board par la [connexion unique](integration.md) peut envoyer des notifications
(« Nouvelle demande », « Sauvegarde terminée »…). Le Board les garde pour chaque personne concernée ; on les lit :

- dans le Board : la **cloche** de l'en-tête (avec le nombre de non lues) et la page **Notifications** ;
- dans **Kosmy Mobile** : une notification Android, même appli fermée (le téléphone interroge le Board en arrière-plan).

L'appli n'a rien de plus à régler : elle utilise l'identifiant et le secret client de sa connexion unique.

## Envoyer une notification

L'adresse est dans la découverte OpenID Connect (`{émetteur}/.well-known/openid-configuration`) :

```json
{ "kosmy_notifications_endpoint": "https://board.mondomaine.fr/api/apps/notifications" }
```

```http
POST /api/apps/notifications
Authorization: Basic base64(urlencode(client_id) ":" urlencode(client_secret))
Content-Type: application/json

{
  "title": "🎵 Nouvelle demande Soundy",
  "body": "Léa demande l'album « Abbey Road »",
  "url": "/#/requests",
  "to": ["0b5c…", "7f21…"]
}
```

| Champ | | |
| --- | --- | --- |
| `title` | obligatoire | 120 caractères au plus. |
| `body` | facultatif | 1000 caractères au plus ; les retours à la ligne sont gardés. |
| `url` | facultatif | Une page **de l'instance** (absolue ou relative à son adresse). Le Board l'ouvre en passant par la connexion unique, pour arriver connecté. Une autre origine est refusée (`400 url`). |
| `to` | facultatif | Les comptes à prévenir : leurs `sub` (ceux de l'ID token). Sans `to`, toutes les personnes qui ont l'instance reliée dans leur Board. |

L'authentification est toujours `client_secret_basic`, même si la connexion unique utilise `client_secret_post`.

### Destinataires

Seules les personnes qui ont, dans leur Board, un espace relié à ce client peuvent recevoir la notification ;
`to` ne fait que réduire cette liste (un `sub` inconnu est ignoré). Une notification réservée aux administrateurs
de l'appli (une nouvelle demande, par exemple) doit donc donner `to` : l'appli sait quels comptes du Board sont
reliés à ses administrateurs.

### Réponses

| Statut | Corps | |
| --- | --- | --- |
| 200 | `{ "delivered": 2 }` | Nombre de personnes prévenues (0 si personne n'est concerné). |
| 400 | `{ "error": "title" \| "url" \| "to" \| "bad_json" }` | |
| 401 | `{ "error": "client_auth" }` | Identifiant ou secret client faux. Après plusieurs échecs, l'adresse IP est bloquée un moment (`429 locked`). |
| 429 | `{ "error": "rate_limited", "wait": 42 }` | Plus de 30 envois en une minute pour ce client. |

Le Board garde les 200 dernières notifications de chaque personne.

## Lire les notifications (Board et Kosmy Mobile)

Avec la session du Board, ou `Authorization: Bearer <jeton d'appareil>` :

- `GET /api/notifications` : `{ notifications: [...], unread }`, les plus récentes d'abord (50 au plus).
  `?after=<id>` ne renvoie que celles plus récentes que cet identifiant (c'est ce que fait Kosmy Mobile).
  Chaque notification : `{ id, title, body, url, createdAt, read, app: { name, appId, spaceId } }`.
- `POST /api/notifications/read` : `{ ids: [...] }`, ou `{}` pour tout marquer comme lu. Renvoie la liste à jour.
- `DELETE /api/notifications/<id>`, ou `DELETE /api/notifications` pour tout supprimer.
