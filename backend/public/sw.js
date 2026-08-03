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
