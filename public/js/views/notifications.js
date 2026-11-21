/* Notifications envoyées par les applis reliées (Soundy…) : la liste, ouvrir, marquer lu, supprimer. */
import { api } from "../api.js";
import { setUnread, state, titleHtml } from "../app.js";
import { errorText, relTime, t } from "../i18n.js";
import { $, $$, busy, confirmBox, esc, logoTile, toast } from "../ui.js";

/**
 * Lien d'une notification : une page de l'instance. Si l'espace a la connexion unique, on passe par son adresse
 * de lancement (comme « Ouvrir ») pour arriver connecté sur cette page.
 */
function linkOf(n) {
  if (!n.url) return null;
  const space = state.spaces?.find((s) => s.id === n.app.spaceId);
  if (!space?.sso?.loginUri || !state.config.issuer) return n.url;
  const u = new URL(space.sso.loginUri);
  u.searchParams.set("iss", state.config.issuer);
  u.searchParams.set("target_link_uri", n.url);
  return u.href;
}

function itemHtml(n) {
  const app = n.app.appId ? state.catalog?.appById[n.app.appId] : undefined;
  const link = linkOf(n);
  return `
    <li class="notif${n.read ? "" : " unread"}" data-id="${n.id}">
      ${logoTile(app, n.app.name, "sm")}
      <div class="notif-main">
        <p class="mono notif-meta">${n.read ? "" : `<span class="notif-dot" role="img" aria-label="${esc(t("notifUnread"))}"></span>`}${esc(n.app.name)} · <time datetime="${new Date(n.createdAt).toISOString()}">${esc(relTime(n.createdAt))}</time></p>
        <p class="notif-title">${esc(n.title)}</p>
        ${n.body ? `<p class="notif-body">${esc(n.body)}</p>` : ""}
      </div>
      <div class="notif-actions">
        ${link ? `<a class="text-btn mono" href="${esc(link)}" target="_blank" rel="noopener noreferrer" data-open>${esc(t("notifOpen"))} ↗</a>` : ""}
        ${n.read ? "" : `<button class="text-btn mono" type="button" data-read>${esc(t("notifMarkRead"))}</button>`}
        <button class="text-btn mono danger" type="button" data-remove aria-label="${esc(t("notifRemove"))}">✕</button>
      </div>
    </li>`;
}

export async function renderNotifications(main) {
  let data;
  try {
    data = await api.get("api/notifications");
  } catch (e) {
    main.innerHTML = `<section class="page"><p class="error" role="alert">${esc(errorText(e.code, e.extra))}</p></section>`;
    return;
  }
  setUnread(data.unread);
  const list = data.notifications;

  main.innerHTML = `
    <section class="page">
      <div class="page-head">
        <div>
          <p class="mono kicker fade">${esc(t("notifKicker"))}</p>
          <h1 class="serif page-title">${titleHtml(t("notifTitle"))}</h1>
        </div>
        <div class="head-side fade" style="--d:.35s">
          <p class="lead">${esc(t("notifLead"))}</p>
          ${list.length ? `<div class="inline-actions" style="margin-top:20px">
            ${data.unread ? `<button class="btn ghost" type="button" id="notif-all-read">${esc(t("notifAllRead"))}</button>` : ""}
            <button class="btn ghost" type="button" id="notif-clear">${esc(t("notifClear"))}</button>
          </div>` : ""}
        </div>
      </div>
      <div class="fade" style="--d:.45s">
        ${list.length
          ? `<ul class="notifs">${list.map(itemHtml).join("")}</ul>`
          : `<div class="notif-empty"><p class="serif">${esc(t("notifEmpty"))}</p><p class="hint">${esc(t("notifEmptyHint"))}</p></div>`}
      </div>
    </section>`;

  const rerender = () => renderNotifications(main);
  const fail = (e) => toast(errorText(e.code, e.extra), "error");

  $("#notif-all-read", main)?.addEventListener("click", async (e) => {
    const done = busy(e.currentTarget, t("loading"));
    try {
      await api.post("api/notifications/read", {});
      rerender();
    } catch (ex) {
      done();
      fail(ex);
    }
  });

  $("#notif-clear", main)?.addEventListener("click", async () => {
    const ok = await confirmBox({ title: t("notifClearTitle"), text: t("notifClearText"), ok: t("notifClear"), danger: true });
    if (!ok) return;
    try {
      await api.del("api/notifications");
      rerender();
    } catch (ex) {
      fail(ex);
    }
  });

  $$(".notif", main).forEach((li) => {
    const id = Number(li.dataset.id);
    const markRead = () => api.post("api/notifications/read", { ids: [id] }).then((r) => setUnread(r.unread));
    // Ouvrir la page de l'appli la marque comme lue, sans quitter la liste.
    $("[data-open]", li)?.addEventListener("click", () => {
      if (!li.classList.contains("unread")) return;
      markRead().then(rerender).catch(() => {});
    });
    $("[data-read]", li)?.addEventListener("click", () => markRead().then(rerender).catch(fail));
    $("[data-remove]", li).addEventListener("click", async () => {
      try {
        await api.del(`api/notifications/${id}`);
        rerender();
      } catch (ex) {
        fail(ex);
      }
    });
  });
}
