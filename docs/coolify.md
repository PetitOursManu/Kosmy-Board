# Installer Kosmy Board sur Coolify

Ce guide installe Kosmy Board sur un serveur [Coolify](https://coolify.io) (v4), en https, avec ses données
conservées d'un déploiement à l'autre. Comptez une dizaine de minutes.

Il vaut pour votre propre serveur comme pour celui de n'importe qui : le Board ne dépend d'aucun service extérieur.

## Avant de commencer

- Un serveur relié à Coolify, avec les ports 80 et 443 ouverts (Coolify s'occupe du certificat https).
- Un nom de domaine pour le Board, par exemple `board.mondomaine.fr`, avec un enregistrement DNS **A**
  (et **AAAA** si vous avez l'IPv6) qui pointe vers l'adresse IP du serveur.
- Choisissez ce domaine une bonne fois : il devient l'**émetteur** de la connexion unique (`https://board.mondomaine.fr/oidc`).
  En changer plus tard oblige à relier de nouveau toutes les applis.

## 1. Créer la ressource

1. Dans Coolify : **Projects** → votre projet → environnement (par exemple *production*) → **+ New** (nouvelle ressource).
2. Choisissez **Public Repository** et collez `https://github.com/PetitOursManu/Kosmy-Board`.
   - Pour déployer votre propre copie (un fork, ou un dépôt privé), choisissez plutôt **Private Repository (with GitHub App)** :
     Coolify pourra alors redéployer tout seul à chaque `git push`.
3. Branche : `main`.
4. **Build Pack** : **Dockerfile**. Le Dockerfile est à la racine du dépôt, rien d'autre à régler.
5. Validez.

## 2. Réglages généraux

Dans l'onglet **Configuration** → **General** de la ressource :

| Champ | Valeur |
| --- | --- |
| **Domains** | `https://board.mondomaine.fr` (avec `https://` : Coolify demande alors le certificat Let's Encrypt) |
| **Ports Exposes** | `8767` |
| **Ports Mappings** | vide : c'est le proxy de Coolify qui reçoit le trafic |

Enregistrez (**Save**).

## 3. Variables d'environnement

Onglet **Environment Variables**, ajoutez :

| Variable | Valeur | |
| --- | --- | --- |
| `PUBLIC_URL` | `https://board.mondomaine.fr` | Exactement le domaine ci-dessus, sans `/` final. |
| `TRUST_PROXY` | `1` | Indispensable derrière Coolify : sans lui, les adresses de la connexion unique seraient annoncées en `http`, et toutes les connexions sembleraient venir de la même IP. |
| `KOSMY_URL` | `https://kosmy.mondomaine.fr` | Facultatif : où mène le lien « ← Kosmy » de l'en-tête. |

Les autres réglages (`SESSION_DAYS`, `CATALOG_URL`…) sont facultatifs : voir le tableau du [README](../README.md#réglages).
Ce sont des variables d'exécution : inutile de les rendre disponibles à la construction de l'image.

## 4. Stockage persistant (à ne pas oublier)

Les comptes, les espaces et les clés de signature de la connexion unique sont dans une base SQLite, dans `/data`.
Sans stockage persistant, **tout disparaît à chaque déploiement**.

Onglet **Persistent Storage** (ou **Storages**) → **+ Add** → **Volume Mount** :

| Champ | Valeur |
| --- | --- |
| **Name** | `kosmy-board-data` (ou ce que vous voulez) |
| **Destination Path** | `/data` |

Préférez un **volume** à un dossier du serveur (*Directory Mount*). Le Board ne tourne pas en root (utilisateur `node`, UID 1000) :
un volume neuf reprend automatiquement les bons droits, alors qu'un dossier du serveur appartient à root et le Board ne pourrait
pas y écrire. Si vous tenez à un dossier, donnez-le d'abord à l'UID 1000 : `sudo chown -R 1000:1000 /chemin/du/dossier`.

## 5. Déployer et créer le compte administrateur

1. **Deploy**. La construction prend une à deux minutes.
2. Ouvrez l'onglet **Logs** de la ressource (les journaux de l'appli, pas ceux du déploiement). Vous y trouverez :

   ```
   Kosmy Board : https://board.mondomaine.fr (port 8767, données dans /data)

     Aucun compte pour l'instant. Code de première configuration :
     ABCD-EFGH-IJKL
   ```

3. Ouvrez `https://board.mondomaine.fr`, saisissez ce code, puis créez le compte administrateur.

Le code ne sert qu'une fois et n'existe que tant qu'aucun compte n'a été créé. À chaque redémarrage sans compte, un nouveau code
remplace l'ancien : prenez toujours le dernier des journaux.

Ensuite :
- **Compte** → activez la **double authentification** : ce compte ouvre toutes vos applis.
- **Compte** → **Membres** → **Créer un lien d'invitation** pour ajouter d'autres personnes (le lien est valable 7 jours, à usage unique).

## 6. Relier les applis

Pour chaque appli auto-hébergée qui sait se connecter avec Kosmy Board :

1. Ajoutez son espace dans le Board, puis **Modifier** → **Connexion unique** → activer.
2. Collez l'**émetteur**, l'**identifiant client** et le **secret client** (affiché une seule fois) dans la page d'administration de l'appli.
3. **Ouvrir**, dans le Board, vous connecte directement à l'appli.

Les applis doivent être en https (le Board n'accepte des adresses `http://` que sur le réseau local).
Le serveur de l'appli doit pouvoir joindre `https://board.mondomaine.fr` : c'est lui qui échange le code de connexion.
Voir le [guide d'intégration](integration.md) pour le détail.

## Mettre à jour

**Redeploy** dans Coolify (ou automatiquement à chaque `git push` avec la GitHub App). Les données restent dans le volume.
Les migrations de la base se font seules au démarrage.

## Sauvegarder

Le volume contient tout : comptes, espaces, clients de la connexion unique et clés de signature. Pour en faire une copie
depuis le serveur (arrêtez le Board dans Coolify le temps de la copie, pour une base cohérente) :

```bash
docker volume ls | grep kosmy-board-data      # nom exact du volume, préfixé par Coolify
docker run --rm -v NOM_DU_VOLUME:/data -v "$PWD":/sauvegarde alpine \
  tar czf /sauvegarde/kosmy-board-$(date +%F).tgz -C /data .
```

Pour restaurer, décompressez l'archive dans le volume (Board arrêté), puis redémarrez-le.

## En cas de problème

| Ce que vous voyez | La cause probable |
| --- | --- |
| *502 Bad Gateway* / *no available server* | **Ports Exposes** n'est pas `8767`, ou le Board n'a pas encore démarré (voir **Logs**). |
| Pas de certificat https | Le DNS ne pointe pas encore vers le serveur, ou le domaine a été saisi sans `https://`. |
| Les comptes disparaissent après un déploiement | Pas de stockage persistant sur `/data` (étape 4). |
| `EACCES` ou `SQLITE_CANTOPEN` dans les journaux | Dossier du serveur appartenant à root : utilisez un volume, ou `chown -R 1000:1000`. |
| Une appli refuse la connexion : émetteur différent, adresses en `http` | `TRUST_PROXY=1` manque, ou `PUBLIC_URL` ne correspond pas exactement au domaine. |
| Impossible de rester connecté au Board | `PUBLIC_URL` est en `https://` mais vous ouvrez le Board en `http://` (ou l'inverse). |
| Le code de première configuration est refusé | Le Board a redémarré depuis : prenez le dernier code des journaux. |

Le Board répond sur `/healthz` : Coolify s'en sert, à travers le `HEALTHCHECK` de l'image, pour savoir s'il est prêt.
