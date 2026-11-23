# L'Assistant et le serveur MCP

L'**Assistant** est un agent IA qui gère vos instances depuis le Board. Vous lui demandez en quelques mots
(« quelles instances ont une alerte ? », « ferme les inscriptions partout », « invite lea@… sur Kanby »),
il lit l'admin des applis et agit pour vous. Les mêmes outils sont proposés à **Claude** (claude.ai, Claude Desktop,
Claude Code) et à tout client MCP, par le **serveur MCP du Board**.

Il s'appuie sur l'[admin dans le Board](admin-api.md) : chaque appli décrit ses sections, formulaires, tableaux
et actions, et l'Assistant s'en sert sans rien connaître de l'appli à l'avance. Une appli qui suit le protocole
`kosmy.board-admin.v1` est prise en charge d'office.

## Ce qu'il sait faire

| Domaine | Outils |
| --- | --- |
| Vue d'ensemble | `list_spaces`, `check_status` (instances joignables, testé depuis le serveur), `fleet_overview` (version, rôle, alertes et chiffres de chaque instance) |
| Admin des instances | `get_admin_summary`, `get_admin_section`, `run_admin_action` (formulaire, action de ligne, bouton) |
| Gestion du Board (administrateurs du Board) | `add_space`, `update_space`, `delete_space`, `get_sso`, `enable_sso`, `disable_sso`, `rotate_sso_secret`, `list_members`, `invite_member`, `create_member`, `remove_member` |
| Utilisateurs et accès (administrateurs du Board) | `get_user_access`, `get_app_roles`, `set_user_access`, `revoke_user_access` (à confirmer) — voir [users-api.md](users-api.md) |
| Bilans | `get_report_settings`, `set_report_settings` |

## Garde-fous

- **Il agit avec votre identité.** Il ne voit que vos espaces. Chaque appli reçoit le même jeton signé que pour le bouton
  « Admin » et revérifie vos droits : l'Assistant ne peut rien que vous ne puissiez faire vous-même.
- **Actions dangereuses : votre confirmation.** Une action que l'appli marque `danger` ou `confirm`, et du côté du Board
  supprimer un espace, couper une connexion unique, régénérer un secret ou supprimer un membre, ne partent pas tout de suite.
  - Dans le Board, une carte « À confirmer » apparaît dans la conversation. Seul votre clic sur **Valider** exécute l'action,
    avec les paramètres affichés, dans les 15 minutes.
  - Par MCP, ces actions passent par des outils marqués destructifs (`run_dangerous_admin_action`, `delete_space`…) :
    c'est votre client (Claude Desktop, Claude Code…) qui vous demande l'accord.
- **Pas d'action inventée.** Avant d'agir, l'Assistant relit la section : l'action doit y exister, et une action de ligne
  doit être proposée pour cette ligne. Un formulaire part avec toutes ses valeurs actuelles, sauf celles à changer.
- **Aucun secret chez le fournisseur d'IA.**
  - Le modèle ne peut pas remplir un champ `password`.
  - Une valeur à montrer une fois (mot de passe temporaire, lien d'invitation, secret client) ne repart jamais vers le modèle.
    Dans le Board, elle s'affiche avec « Copier ». Par MCP, le client reçoit un lien du Board, valable 15 minutes, lisible une fois
    par vous, connecté au Board.
- **Les textes des applis sont des données** : le modèle a pour consigne de ne jamais les suivre comme des instructions.
  La confirmation des actions dangereuses limite les dégâts d'un texte piégé.
- **Journal** : tout ce que l'Assistant modifie (chat, MCP ou bilan), réussi ou non, est dans *Assistant → Réglages → Journal*.
  Un administrateur du Board voit le journal de tout le Board (`GET /api/assistant/audit?all=1`).

## Choisir le fournisseur d'IA

Un administrateur du Board règle le fournisseur dans *Assistant → Réglages*. Il vaut pour tout le Board.
Toute API compatible OpenAI (`/chat/completions`) qui sait **appeler des outils** convient :

- OpenRouter (par défaut), OpenAI, Anthropic (son point d'accès compatible OpenAI), Google Gemini ;
- Mistral, DeepSeek, xAI, Groq, Together, Fireworks, Cerebras ;
- un modèle local : Ollama ou LM Studio, que le serveur du Board doit pouvoir joindre ;
- toute autre adresse compatible OpenAI.

« Charger les modèles » lit la liste du fournisseur (pour OpenRouter, seulement les modèles qui savent appeler des outils).
« Tester » vérifie que le modèle répond **et** appelle un outil.

La clé est gardée chiffrée (AES-256-GCM) dans la base. La clé de chiffrement est dans `DATA_DIR/secret.key`, hors de la base :
sauvegardez-la avec le volume. Si elle est perdue, ressaisissez la clé du fournisseur.

### Variables d'environnement

Elles l'emportent sur les réglages de l'interface (les champs sont alors grisés). Avec `AI_API_KEY`, la clé n'est jamais enregistrée.

| Variable | Par défaut | Rôle |
| --- | --- | --- |
| `AI_PROVIDER` | `openrouter` | `openrouter`, `openai`, `anthropic`, `gemini`, `mistral`, `deepseek`, `xai`, `groq`, `together`, `fireworks`, `cerebras`, `ollama`, `lmstudio` ou `custom`. |
| `AI_BASE_URL` | celle du fournisseur | Adresse de l'API (obligatoire avec `custom`). |
| `AI_MODEL` | — | Identifiant du modèle, tel que le fournisseur l'écrit (« Charger les modèles » dans les réglages les liste). |
| `AI_API_KEY` | — | Clé du fournisseur. |
| `AI_MAX_STEPS` | `25` | Tours d'outils au plus pour une réponse. |
| `AI_HOURLY_LIMIT` | `60` | Messages par personne et par heure. |
| `AI_MAX_TOKENS` | `4096` | Jetons de sortie par tour. |
| `MCP_HOURLY_LIMIT` | `600` | Appels d'outils MCP par personne et par heure. |
| `TZ` | celui du serveur | Fuseau horaire des bilans (par exemple `Europe/Paris`). |

## Bilans planifiés

Dans *Assistant → Réglages → Bilans*, chaque personne choisit : jamais, chaque jour ou chaque semaine, et l'heure (celle du serveur).
L'Assistant fait alors le tour de ses instances **en lecture seule** et lui envoie un résumé en notification, dans la cloche
du Board et sur Kosmy Mobile. Le bilan complet est gardé comme conversation : on peut l'ouvrir et poser des questions.
« Faire un bilan maintenant » le lance tout de suite. Un bilan manqué (serveur arrêté) est fait dans les 3 heures qui suivent.

## Serveur MCP

Adresse : `{PUBLIC_URL}/mcp` (transport « Streamable HTTP », réponses JSON, sans session).

### claude.ai et Claude Desktop

1. Ajoutez un **connecteur personnalisé** avec l'adresse `https://board.mondomaine.fr/mcp`.
2. Claude ouvre la page du Board : connectez-vous si besoin, puis **Autoriser**.
3. Les autorisations sont dans *Compte → Accès MCP*, où l'on peut les retirer (leurs jetons cessent aussitôt de valoir).

Le Board doit être joignable depuis Internet pour claude.ai (c'est son serveur qui appelle le Board).

Le Board joue le rôle de serveur d'autorisation OAuth 2.1 :
- inscription dynamique des clients (RFC 7591), avec des identifiants `mcp-…` ;
- PKCE obligatoire ;
- jetons d'accès JWT valables 1 heure, émis pour la seule ressource `/mcp` (RFC 8707) ;
- jetons de rafraîchissement valables 30 jours ;
- métadonnées `/.well-known/oauth-protected-resource` (RFC 9728) et `/.well-known/oauth-authorization-server` (RFC 8414).

Un client MCP n'est pas une instance reliée : il ne sert pas à se connecter aux applis, seulement à appeler `/mcp`.

### Claude Code et autres clients

*Compte → Accès MCP → Créer un jeton*, puis :

```bash
claude mcp add --transport http kosmy-board https://board.mondomaine.fr/mcp --header "Authorization: Bearer kbm_…"
```

Le jeton n'est montré qu'une fois et seul son haché est gardé. Il ne vaut que pour `/mcp`, et on peut le retirer à tout moment.
Claude Code sait aussi utiliser OAuth : sans `--header`, il ouvre la page d'autorisation du Board.

## API de l'interface

Toutes sous `/api/assistant`, avec la session du Board (ou le jeton d'appareil de Kosmy Mobile).

| Méthode | Adresse | Rôle |
| --- | --- | --- |
| `GET` | `/api/assistant` | État (réglé ou non), conversations, réglage des bilans. |
| `POST` | `/api/assistant/messages` | `{ text, conversation?, lang }` : réponse en flux (`text/event-stream`). Événements : `conversation`, `text`, `tool_start`, `tool_end`, `pending`, `reveal`, `usage`, `error`, `done`. |
| `GET`, `DELETE` | `/api/assistant/conversations/{id}` | Une conversation, avec ses actions en attente. |
| `POST` | `/api/assistant/pending/{id}` | `{ approve }` : valide ou refuse une action en attente (en flux, l'Assistant reprend ensuite). |
| `PUT` | `/api/assistant/report` | `{ frequency, hour, weekday }`. |
| `POST` | `/api/assistant/report/run` | Un bilan tout de suite. |
| `GET` | `/api/assistant/audit` | Le journal. |
| `GET`, `PUT` | `/api/assistant/settings` | Le fournisseur (administrateurs). |
| `POST` | `/api/assistant/models`, `/api/assistant/test` | Liste des modèles, test (administrateurs). |
| `GET` | `/api/mcp` | Adresse MCP, jetons et autorisations. `POST /api/mcp/tokens`, `DELETE /api/mcp/tokens/{id}`, `DELETE /api/mcp/grants/{id}`. |
