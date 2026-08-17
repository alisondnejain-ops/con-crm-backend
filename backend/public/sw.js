/* Service worker do ConHub.

   Existe por UM motivo: receber a notificação push quando o CRM está fechado.
   O navegador só entrega push para um service worker — não há como fazer sem.

   DE PROPÓSITO ele NÃO guarda nada em cache. Um service worker que serve
   arquivo salvo é a forma mais fácil de o corretor continuar vendo a versão
   velha do sistema depois de uma publicação — foi exatamente a dor que fez a
   gente sair do Netlify em 29/07. Aqui a rede sempre manda. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { corpo: e.data && e.data.text() }; }
  const titulo = d.titulo || "ConHub";
  e.waitUntil(self.registration.showNotification(titulo, {
    body: d.corpo || "",
    icon: "/icone-192.png",
    badge: "/icone-192.png",
    // Agrupa por lead: dez mensagens do mesmo cliente viram um aviso que se
    // atualiza, em vez de dez avisos empilhados no celular do corretor.
    tag: d.leadId ? "lead-" + d.leadId : "conhub",
    renotify: true,
    data: { leadId: d.leadId || null },
  }));
});

/* A INSCRIÇÃO PUSH SE RENOVA SOZINHA — e sem isto ela simplesmente morre.

   O navegador troca a inscrição de tempos em tempos (chave expirada, limpeza
   do sistema, atualização do próprio navegador). Quando isso acontece ele
   avisa AQUI, e só aqui: a página pode nem estar aberta. Se ninguém se
   reinscrever, o endereço antigo passa a devolver 410, o servidor apaga a
   inscrição, e o corretor descobre dias depois que parou de receber aviso de
   lead — sem ter desligado nada.

   A chave vem da inscrição antiga quando o navegador a manda junto; quando
   não manda, buscamos no servidor. */
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    try {
      const antiga = e.oldSubscription || null;
      let chave = antiga && antiga.options && antiga.options.applicationServerKey;
      if (!chave) {
        const r = await fetch("/push/chave");
        const d = await r.json();
        if (!d || !d.chave) return;
        chave = Uint8Array.from(atob(d.chave.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      }
      const nova = e.newSubscription
        || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chave });

      /* A troca vai SEM login: o service worker não tem o token da pessoa.
         Quem prova ser o dono é o próprio endereço antigo — só o navegador
         daquele aparelho o conhece, e o servidor só aceita trocar uma
         inscrição que já existe. */
      await fetch("/push/trocar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ antigo: antiga && antiga.endpoint, nova: nova.toJSON() }),
      });
    } catch (_) { /* aviso é aviso: nunca derruba o service worker */ }
  })());
});

// Clicar no aviso abre o CRM — e, se já estiver aberto numa aba, foca nela em
// vez de abrir outra.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const destino = e.notification.data && e.notification.data.leadId
    ? "/?lead=" + e.notification.data.leadId : "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((janelas) => {
    for (const j of janelas) if ("focus" in j) return j.focus();
    return self.clients.openWindow(destino);
  }));
});
