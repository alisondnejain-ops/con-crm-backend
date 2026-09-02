// Envio de e-mail transacional via Resend (HTTP puro, sem SDK).
// Se as variáveis não estiverem configuradas, o e-mail NÃO é enviado: a função
// devolve { sent:false } e o link aparece no log para a ADM repassar na mão.
// Isso deixa o cadastro funcionando desde o primeiro dia, mesmo antes de contratar o provedor.

const API = "https://api.resend.com/emails";

export function mailConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

export async function sendMail({ to, subject, html }) {
  if (!mailConfigured()) {
    console.log(`[mail] não configurado — e-mail para ${to} não enviado. Assunto: ${subject}`);
    return { sent: false, reason: "não configurado" };
  }
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, html }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[mail] falha ao enviar para ${to}: ${res.status} ${body}`);
      return { sent: false, reason: `provedor respondeu ${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.error(`[mail] erro de rede ao enviar para ${to}:`, e.message);
    return { sent: false, reason: "erro de rede" };
  }
}

// E-mail de convite: o corretor clica e define a própria senha.
export function inviteEmail({ name, link, orgName }) {
  const first = (name || "").split(" ")[0] || "corretor(a)";
  return {
    subject: `${orgName}: confirme seu cadastro no ConHub`,
    html: `
<div style="font-family:Arial,Helvetica,sans-serif;background:#F4F6F5;padding:32px 16px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E6E9E7;border-radius:16px;overflow:hidden">
    <div style="background:#0A3D30;padding:24px">
      <div style="color:#fff;font-size:20px;font-weight:700">Con<span style="color:#0E8F6E">Hub</span></div>
      <div style="color:rgba(255,255,255,.6);font-size:11px;letter-spacing:.5px">${orgName.toUpperCase()}</div>
    </div>
    <div style="padding:28px">
      <p style="color:#14181F;font-size:16px;margin:0 0 12px">Oi, ${first}! 👋</p>
      <p style="color:#5A6472;font-size:14px;line-height:1.6;margin:0 0 20px">
        Seu cadastro no ConHub da ${orgName} foi criado. Falta só um passo:
        clique no botão abaixo para <b>criar sua senha</b> e ativar o acesso.
      </p>
      <a href="${link}" style="display:inline-block;background:#0E8F6E;color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:13px 26px;border-radius:12px">Criar minha senha</a>
      <p style="color:#8A93A0;font-size:12px;line-height:1.6;margin:22px 0 0">
        O link vale por 7 dias. Se não abrir no botão, copie e cole no navegador:<br>
        <span style="color:#0C6B52;word-break:break-all">${link}</span>
      </p>
      <p style="color:#8A93A0;font-size:12px;margin:18px 0 0">Se você não pediu esse cadastro, é só ignorar este e-mail.</p>
    </div>
  </div>
</div>`,
  };
}

/* E-mail de REDEFINIÇÃO de senha — o "esqueci minha senha".

   É um modelo próprio e não o de convite adaptado. O de convite diz "seu
   cadastro foi criado", e mandar isso para quem já usa o CRM há meses faz
   pensar em conta duplicada bem no momento em que a pessoa já está com
   dificuldade de entrar.

   E ele avisa que dá para IGNORAR. Este e-mail pode chegar sem ter sido
   pedido — basta alguém digitar o endereço errado na tela de login — e a
   frase é o que separa "alguém se enganou" de "invadiram minha conta". A senha
   atual continua valendo até o link ser usado, e isso está escrito. */
export function senhaEmail({ name, link, horas = 24 }) {
  const first = (name || "").split(" ")[0] || "você";
  return {
    subject: "ConHub: criar uma senha nova",
    html: `
<div style="font-family:Arial,Helvetica,sans-serif;background:#F4F6F5;padding:32px 16px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E6E9E7;border-radius:16px;overflow:hidden">
    <div style="background:#0A3D30;padding:24px">
      <div style="color:#fff;font-size:20px;font-weight:700">Con<span style="color:#0E8F6E">Hub</span></div>
      <div style="color:rgba(255,255,255,.6);font-size:11px;letter-spacing:.5px">ACESSO À SUA CONTA</div>
    </div>
    <div style="padding:28px">
      <p style="color:#14181F;font-size:16px;margin:0 0 12px">Oi, ${first}!</p>
      <p style="color:#5A6472;font-size:14px;line-height:1.6;margin:0 0 20px">
        Recebemos um pedido para criar uma <b>senha nova</b> no seu acesso ao ConHub.
        Clique no botão abaixo para escolher a senha.
      </p>
      <a href="${link}" style="display:inline-block;background:#0E8F6E;color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:13px 26px;border-radius:12px">Criar senha nova</a>
      <p style="color:#8A93A0;font-size:12px;line-height:1.6;margin:22px 0 0">
        O link vale por ${horas} horas. Se não abrir no botão, copie e cole no navegador:<br>
        <span style="color:#0C6B52;word-break:break-all">${link}</span>
      </p>
      <p style="color:#8A93A0;font-size:12px;line-height:1.6;margin:18px 0 0">
        <b>Não foi você?</b> Pode ignorar este e-mail — sua senha atual continua valendo
        e ninguém consegue entrar sem abrir este link.
      </p>
    </div>
  </div>
</div>`,
  };
}
